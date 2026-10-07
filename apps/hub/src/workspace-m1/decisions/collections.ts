// Review repair APP-P2-01 / APP-P2-02 (docs/workspace-m1/REPAIR_READ_CONTRACT_2026-10-05.md): complete stored
// facts per allowlisted repository and bounded, keyset-paged read collections. Read-only: nothing here reads
// artifacts, revalidates evidence, issues challenges or grants any approval / execution authority.
//
// Paging: both collections order by an immutable key (`created_at` + the row's unique id), so a cursor needs
// no snapshot: rows never move, new rows land at one end, and each id appears at most once in a scan. A page is
// a current read (rows show their state at that read); membership of a filtered view may change between
// pages, which the response metadata discloses (`total`, `as_of`; for the inbox also `membership_generation`).
// A cursor names its collection, scope and page size; it carries no authority and is refused (400) for any
// other scope.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { TaskState } from "@agent-city/schema";
import {
	type AcceptanceValidityStatus,
	ApprovalRequestId,
	deriveWorkspacePhase,
	emptyCategories,
	type PageMeta,
	type RepoSummary,
	repositoryCategory,
	UtcTs,
	WorkspacePhase,
	type WorkspaceStage,
	WorkspaceTaskId,
} from "@agent-city/schema/workspace-m1";
import { z } from "zod";

/** Phases counted as work in progress (queued, running, cancel requested). */
const ACTIVE_PHASES: ReadonlySet<WorkspacePhase> = new Set([
	"queued",
	"implementing",
	"verifying",
	"reviewing",
	"repairing",
	"finalizing",
	"cancel_requested",
]);

/**
 * A task needs attention when its execution ended without an acceptable result (failed / blocked /
 * interrupted), when an accepted result's stored validity is invalid, unknown or missing, or when its current
 * execution has an open quarantine — unless a decision is pending on it (that is its category instead).
 * Mirrors `repositoryCategory` exactly (one category per task).
 */
export const ATTENTION_SQL = `(t.stage NOT IN ('awaiting_run_approval','awaiting_acceptance') AND (
 t.stage = 'execution_ended'
 OR (t.stage = 'accepted' AND (v.status IS NULL OR v.status IN ('invalid','unknown')))
 OR EXISTS (SELECT 1 FROM managed_quarantine q WHERE q.task_id = t.current_managed_task_id AND q.released_at IS NULL)))`;

export const TASK_JOIN = `workspace_tasks t
 LEFT JOIN managed_tasks m ON m.id = t.current_managed_task_id
 LEFT JOIN managed_acceptance_validity v ON v.decision_id = t.accepted_decision_id`;

/**
 * One complete aggregate per allowlisted repository over EVERY stored task of it (grouped SQL; no task rows
 * or artifacts are loaded). Counts are unique workspace tasks. Validity counts are the STORED current-validity
 * facts of accepted results (periodic checks), not a fresh verification of every artifact.
 */
export function repositorySummaries(
	db: Database,
	repos: readonly string[],
	as_of: string,
): RepoSummary[] {
	const result: RepoSummary[] = repos.map((repo_id) => ({
		repo_id,
		tasks: 0,
		complete: true,
		as_of,
		phases: Object.fromEntries(
			WorkspacePhase.options.map((p) => [p, 0]),
		) as RepoSummary["phases"],
		categories: emptyCategories(),
		active_tasks: 0,
		pending_requests: 0,
		acceptance: {
			valid: 0,
			invalid: 0,
			unknown: 0,
			unverifiable: 0,
			oldest_checked_at: null,
			latest_checked_at: null,
		},
	}));
	const byRepo = new Map(result.map((r) => [r.repo_id, r]));
	const scope = JSON.stringify(repos);
	const groups = db
		.query<
			{
				repo_id: string;
				stage: WorkspaceStage;
				state: TaskState | null;
				validity: AcceptanceValidityStatus | null;
				quarantined: number;
				n: number;
				oldest: string | null;
				latest: string | null;
			},
			[string]
		>(
			`SELECT t.repo_id, t.stage, m.state, v.status AS validity,
			   EXISTS (SELECT 1 FROM managed_quarantine q WHERE q.task_id = m.id AND q.released_at IS NULL) AS quarantined,
			   count(*) AS n, min(v.checked_at) AS oldest, max(v.checked_at) AS latest
			 FROM ${TASK_JOIN}
			 WHERE t.repo_id IN (SELECT value FROM json_each(?))
			 GROUP BY t.repo_id, t.stage, m.state, v.status, quarantined`,
		)
		.all(scope);
	for (const g of groups) {
		const r = byRepo.get(g.repo_id);
		if (!r) continue;
		const phase = deriveWorkspacePhase(g.stage, g.state);
		r.tasks += g.n;
		r.phases[phase] += g.n;
		r.categories[repositoryCategory(phase, g.validity, g.quarantined === 1)] +=
			g.n;
		if (ACTIVE_PHASES.has(phase)) r.active_tasks += g.n;
		if (g.stage === "accepted") {
			r.acceptance[g.validity ?? "unknown"] += g.n;
			const a = r.acceptance;
			if (g.oldest && (!a.oldest_checked_at || g.oldest < a.oldest_checked_at))
				a.oldest_checked_at = g.oldest;
			if (g.latest && (!a.latest_checked_at || g.latest > a.latest_checked_at))
				a.latest_checked_at = g.latest;
		}
	}
	for (const g of db
		.query<{ repo_id: string; n: number }, [string]>(
			`SELECT t.repo_id, count(*) AS n
			 FROM managed_approval_requests a JOIN workspace_tasks t ON t.id = a.workspace_task_id
			 WHERE a.status = 'pending' AND t.repo_id IN (SELECT value FROM json_each(?))
			 GROUP BY t.repo_id`,
		)
		.all(scope)) {
		const r = byRepo.get(g.repo_id);
		if (r) r.pending_requests = g.n;
	}
	return result;
}

/**
 * T0-FINAL-P2-01: the pending-membership generation of one inbox scope (its repositories and gate), read in the
 * caller's transaction. `entered` counts the scope's requests that were ever pending: pending now, or updated at
 * least once — 008 lets only a pending request change and bumps `rev` on every update, so a request created
 * already closed stays at rev 1 and is never counted. Requests are never deleted, never reopen and keep their
 * kind and task (whose repository is immutable), so the entered and the closed sets only grow: an equal value
 * means the identical pending set, and any opening or closing changes it, also at an unchanged total.
 * Equality only; it carries no authority.
 */
export function inboxMembershipGeneration(
	db: Database,
	repos: readonly string[],
	kind: "run" | "result" | null,
): string {
	const counts = db
		.query<{ entered: number; pending: number | null }, string[]>(
			`SELECT count(*) AS entered, sum(a.status = 'pending') AS pending
			 FROM managed_approval_requests a JOIN workspace_tasks t ON t.id = a.workspace_task_id
			 WHERE t.repo_id IN (SELECT value FROM json_each(?))${kind ? " AND a.kind = ?" : ""}
			   AND (a.status = 'pending' OR a.rev > 1)`,
		)
		.get(JSON.stringify(repos), ...(kind ? [kind] : []));
	const scope = createHash("sha256")
		.update(JSON.stringify([[...repos].sort(), kind]))
		.digest("hex")
		.slice(0, 16);
	return `v1:${scope}:${counts?.entered ?? 0}:${counts?.pending ?? 0}`;
}

// ── keyset cursors ────────────────────────────────────────────────────────────

const HistoryCursor = z.strictObject({
	v: z.literal(1),
	feed: z.literal("history"),
	repo: z.string().min(1).max(200),
	filter: z.enum(["all", "attention"]),
	limit: z.number().int().positive(),
	at: UtcTs,
	id: WorkspaceTaskId,
});
const InboxCursor = z.strictObject({
	v: z.literal(1),
	feed: z.literal("inbox"),
	repo: z.string().min(1).max(200).nullable(),
	filter: z.enum(["all", "run", "result"]),
	limit: z.number().int().positive(),
	at: UtcTs,
	id: ApprovalRequestId,
});
export type HistoryCursor = z.infer<typeof HistoryCursor>;
export type InboxCursor = z.infer<typeof InboxCursor>;
type AnyCursor = HistoryCursor | InboxCursor;
type Scope<C extends AnyCursor> = Pick<
	C,
	"v" | "feed" | "repo" | "filter" | "limit"
>;

/** The cursor of `raw` for exactly `scope`, null for "first page", or "invalid" (→ 400). */
export function readCursor<C extends AnyCursor>(
	raw: string | undefined,
	scope: Scope<C>,
): C | null | "invalid" {
	if (raw === undefined) return null;
	if (raw.length === 0 || raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw))
		return "invalid";
	let json: unknown;
	try {
		json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
	} catch {
		return "invalid";
	}
	const parsed = (
		scope.feed === "history" ? HistoryCursor : InboxCursor
	).safeParse(json);
	if (!parsed.success) return "invalid";
	const c = parsed.data as C;
	if (
		c.feed !== scope.feed ||
		c.repo !== scope.repo ||
		c.filter !== scope.filter ||
		c.limit !== scope.limit
	)
		return "invalid";
	return c;
}

export const encodeCursor = (c: AnyCursor): string =>
	Buffer.from(JSON.stringify(c)).toString("base64url");

/** Page metadata: `total` = every row matching the query now; `complete` = this page holds all of them. */
export function pageMeta(
	total: number,
	returned: number,
	has_more: boolean,
	next: AnyCursor | null,
	as_of: string,
	first_page: boolean,
): PageMeta {
	return {
		total,
		returned,
		complete: first_page && !has_more && returned === total,
		has_more,
		next_cursor: has_more && next ? encodeCursor(next) : null,
		as_of,
	};
}
