// GitHub → repos table sync. READ-ONLY: REST GET + GraphQL `query` only; nothing on GitHub is
// ever created/modified/deleted. Token: GITHUB_TOKEN → `gh auth token` (only the source is logged).
//
// Order is chosen so an abort (rate limit / error) leaves consistent rows:
//   1. list all repos (metadata, no history)          → upsert
//   2. commits_30d via history, only repos pushed ≤ 90d → update
//   3. CI via REST actions/runs (ETag), same repos      → update
//   4. local checkouts under REPO_ROOTS                  → repo_paths / local-only repos
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import {
	type CiStatus,
	localRepoId,
	MachineRole,
	redact,
	repoKey,
} from "@agent-city/schema";
import { openDb } from "../db.ts";
import { remapRepoIds } from "../store.ts";
import {
	createGithubClient,
	type EtagStore,
	type GithubClient,
	RATE_FIELDS,
	RateLimitLow,
	type RateState,
	resolveGithubToken,
	type TokenSource,
} from "./client.ts";
import { type Districts, loadDistricts } from "./districts.ts";
import { expandRoots, type LocalScan, scanLocal } from "./local.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
export const ACTIVE_WINDOW_DAYS = 90; // history + CI only for repos pushed within this window
const HISTORY_BATCH = 50;
const CI_CONCURRENCY = 6;
const AFFILIATIONS = "[OWNER, COLLABORATOR, ORGANIZATION_MEMBER]";

const LIST_QUERY = `query($cursor: String) {
  ${RATE_FIELDS}
  viewer {
    login
    repositories(first: 100, after: $cursor, affiliations: ${AFFILIATIONS}, ownerAffiliations: ${AFFILIATIONS}, orderBy: {field: PUSHED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id nameWithOwner isPrivate isArchived isFork pushedAt
        primaryLanguage { name }
        defaultBranchRef { name }
        pullRequests(states: OPEN) { totalCount }
        issues(states: OPEN) { totalCount }
      }
    }
  }
}`;

const HISTORY_QUERY = `query($ids: [ID!]!, $since: GitTimestamp!) {
  ${RATE_FIELDS}
  nodes(ids: $ids) {
    ... on Repository {
      id
      defaultBranchRef { target { ... on Commit { history(since: $since) { totalCount } } } }
    }
  }
}`;

interface GhRepo {
	id: string;
	nameWithOwner: string;
	isPrivate: boolean;
	isArchived: boolean;
	isFork: boolean;
	pushedAt: string | null;
	primaryLanguage: { name: string } | null;
	defaultBranchRef: { name: string } | null;
	pullRequests: { totalCount: number };
	issues: { totalCount: number };
}

interface ListPage {
	viewer: {
		login: string;
		repositories: {
			totalCount: number;
			pageInfo: { hasNextPage: boolean; endCursor: string | null };
			nodes: GhRepo[];
		};
	};
}

interface HistoryPage {
	nodes: ({
		id: string;
		defaultBranchRef: {
			target: { history?: { totalCount: number } } | null;
		} | null;
	} | null)[];
}

export interface CiInfo {
	ci_status: CiStatus;
	ci_updated_at: string | null;
}

/** Latest workflow run → badge. Anything not clearly success/failure/in-flight is `none`. */
export function mapCiRun(run: {
	status?: string | null;
	conclusion?: string | null;
}): CiStatus {
	if (run.status && run.status !== "completed") return "running";
	switch (run.conclusion) {
		case "success":
			return "success";
		case "failure":
		case "timed_out":
		case "startup_failure":
			return "failure";
		default:
			return "none";
	}
}

export function deriveCi(json: unknown): CiInfo {
	const run = (
		json as {
			workflow_runs?: {
				status?: string;
				conclusion?: string | null;
				updated_at?: string;
			}[];
		}
	)?.workflow_runs?.[0];
	if (!run) return { ci_status: "none", ci_updated_at: null };
	return { ci_status: mapCiRun(run), ci_updated_at: run.updated_at ?? null };
}

export function dbEtagStore(db: Database): EtagStore {
	const get = db.query<{ etag: string; body: string }, { url: string }>(
		"SELECT etag, body FROM github_etags WHERE url = $url",
	);
	const put = db.query(
		`INSERT INTO github_etags (url, etag, body, fetched_at) VALUES ($url, $etag, $body, $at)
		 ON CONFLICT(url) DO UPDATE SET etag = excluded.etag, body = excluded.body, fetched_at = excluded.fetched_at`,
	);
	return {
		get: (url) => get.get({ url }),
		put: (url, etag, body) =>
			put.run({ url, etag, body, at: new Date().toISOString() }),
	};
}

export interface LocalSummary {
	scanned: number;
	mapped: number; // → a GitHub repo of this account
	localOnly: { id: string; path: string; reason: string }[];
	worktrees: number;
	errors: number;
	/** Roots missing or not fully scanned — their existing mappings were kept as-is (F07). */
	incompleteRoots: string[];
}

export interface SyncSummary {
	login: string | null;
	total: number;
	private: number;
	archived: number;
	forks: number;
	activeWindow: number; // repos pushed ≤ 90d (history + CI scope)
	ci: Record<CiStatus, number>;
	ciCached: number; // 304s
	ciUnavailable: { status: number; count: number }[]; // 403/404/… (no Actions access, disabled)
	local: LocalSummary | null;
	rate: Record<"graphql" | "core", RateState>;
	aborted: string | null;
	changedRepoIds: string[];
	/** Session / event / repo_path rows re-pointed to a canonical repo id (F13). */
	remappedRefs: number;
	warnings: string[];
}

export interface LocalOptions {
	machineId: string;
	roots: readonly string[];
	/** Injectable for tests. */
	scan?: (roots: readonly string[]) => Promise<LocalScan>;
}

export interface SyncOptions {
	db: Database;
	client: GithubClient;
	districts: Districts;
	now?: Date;
	/** Local checkout mapping; null/undefined to skip. */
	local?: LocalOptions | null;
}

function snapshot(db: Database): Map<string, string> {
	const rows = db
		.query<Record<string, unknown> & { id: string }, []>("SELECT * FROM repos")
		.all();
	return new Map(
		rows.map(({ synced_at: _, ...r }) => [r.id, JSON.stringify(r)]),
	);
}

export async function syncGithub(opts: SyncOptions): Promise<SyncSummary> {
	const { db, client, districts } = opts;
	const now = opts.now ?? new Date();
	const nowIso = now.toISOString();
	const windowStart = now.getTime() - ACTIVE_WINDOW_DAYS * DAY_MS;
	const since30 = new Date(now.getTime() - 30 * DAY_MS).toISOString();
	const before = snapshot(db);

	const summary: SyncSummary = {
		login: null,
		total: 0,
		private: 0,
		archived: 0,
		forks: 0,
		activeWindow: 0,
		ci: { success: 0, failure: 0, running: 0, none: 0 },
		ciCached: 0,
		ciUnavailable: [],
		local: null,
		rate: client.rate,
		aborted: null,
		changedRepoIds: [],
		remappedRefs: 0,
		warnings: [...districts.warnings],
	};

	const upsertRepo = db.query(
		`INSERT INTO repos (id, is_private, is_archived, is_fork, language, pushed_at, commits_30d, open_prs, open_issues, district, is_local_only, synced_at)
		 VALUES ($id, $is_private, $is_archived, $is_fork, $language, $pushed_at, $commits_30d, $open_prs, $open_issues, $district, 0, $now)
		 ON CONFLICT(id) DO UPDATE SET
		   is_private = excluded.is_private, is_archived = excluded.is_archived, is_fork = excluded.is_fork,
		   language = excluded.language, pushed_at = excluded.pushed_at,
		   commits_30d = coalesce(excluded.commits_30d, commits_30d),
		   open_prs = excluded.open_prs, open_issues = excluded.open_issues,
		   district = excluded.district, is_local_only = 0, synced_at = excluded.synced_at`,
	);
	const setCommits = db.query(
		"UPDATE repos SET commits_30d = $n WHERE id = $id",
	);
	const setCi = db.query(
		"UPDATE repos SET ci_status = $ci_status, ci_updated_at = $ci_updated_at WHERE id = $id",
	);

	const inWindow = (r: GhRepo) =>
		!!r.defaultBranchRef &&
		!!r.pushedAt &&
		Date.parse(r.pushedAt) >= windowStart;
	const repos: GhRepo[] = [];

	try {
		// 1. list
		let cursor: string | null = null;
		do {
			const page: ListPage = await client.graphql<ListPage>(LIST_QUERY, {
				cursor,
			});
			summary.login = page.viewer.login;
			const conn = page.viewer.repositories;
			db.transaction(() => {
				for (const r of conn.nodes) {
					repos.push(r);
					upsertRepo.run({
						id: r.nameWithOwner,
						is_private: r.isPrivate ? 1 : 0,
						is_archived: r.isArchived ? 1 : 0,
						is_fork: r.isFork ? 1 : 0,
						language: r.primaryLanguage?.name ?? null,
						pushed_at: r.pushedAt,
						// outside the window there were no pushes in 30d → 0; inside, step 2 fills it
						commits_30d: inWindow(r) ? null : 0,
						open_prs: r.pullRequests.totalCount,
						open_issues: r.issues.totalCount,
						district: districts.districtOf(r.nameWithOwner),
						now: nowIso,
					});
				}
			})();
			cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
		} while (cursor);

		const active = repos.filter(inWindow);
		summary.activeWindow = active.length;

		// 2. commits_30d
		const byNode = new Map(active.map((r) => [r.id, r.nameWithOwner]));
		for (let i = 0; i < active.length; i += HISTORY_BATCH) {
			const ids = active.slice(i, i + HISTORY_BATCH).map((r) => r.id);
			const page = await client.graphql<HistoryPage>(HISTORY_QUERY, {
				ids,
				since: since30,
			});
			db.transaction(() => {
				for (const n of page.nodes) {
					const id = n && byNode.get(n.id);
					const count = n?.defaultBranchRef?.target?.history?.totalCount;
					if (id && typeof count === "number") setCommits.run({ id, n: count });
				}
			})();
		}

		// 3. CI — outside the window the badge is meaningless → none
		db.transaction(() => {
			for (const r of repos) {
				if (!inWindow(r))
					setCi.run({
						id: r.nameWithOwner,
						ci_status: "none",
						ci_updated_at: null,
					});
			}
		})();
		const unavailable = new Map<number, number>();
		for (let i = 0; i < active.length; i += CI_CONCURRENCY) {
			const chunk = active.slice(i, i + CI_CONCURRENCY);
			const results = await Promise.all(
				chunk.map((r) =>
					client.getDerived(
						`/repos/${r.nameWithOwner}/actions/runs?per_page=1`,
						deriveCi,
					),
				),
			);
			db.transaction(() => {
				chunk.forEach((r, j) => {
					const res = results[j];
					if (!res) return;
					let ci: CiInfo;
					if (res.value === null) {
						unavailable.set(res.status, (unavailable.get(res.status) ?? 0) + 1);
						ci = { ci_status: "none", ci_updated_at: null };
					} else {
						if (res.cached) summary.ciCached++;
						ci = res.value;
					}
					setCi.run({ id: r.nameWithOwner, ...ci });
				});
			})();
		}
		summary.ciUnavailable = [...unavailable].map(([status, count]) => ({
			status,
			count,
		}));
	} catch (err) {
		// printed and logged → redacted even though client errors already are
		summary.aborted = redact(
			err instanceof RateLimitLow
				? `rate-limit (${err.bucket}): ${err.message}`
				: `error: ${(err as Error).message}`,
		);
	}

	summary.total = repos.length;
	summary.private = repos.filter((r) => r.isPrivate).length;
	summary.archived = repos.filter((r) => r.isArchived).length;
	summary.forks = repos.filter((r) => r.isFork).length;
	const ciOf = db.query<{ ci_status: CiStatus }, { id: string }>(
		"SELECT ci_status FROM repos WHERE id = $id",
	);
	for (const r of repos) {
		const row = ciOf.get({ id: r.nameWithOwner });
		if (row) summary.ci[row.ci_status]++;
	}

	// 4. local checkouts (matched against every GitHub repo known to the DB)
	if (opts.local) {
		try {
			summary.local = await mapLocal(db, opts.local, districts, nowIso);
		} catch (err) {
			summary.warnings.push(`local scan failed: ${(err as Error).message}`);
		}
	}

	// F13: sessions / events recorded under another casing before these rows existed → canonical id.
	try {
		summary.remappedRefs = remapRepoIds(db);
	} catch (err) {
		summary.warnings.push(`repo id remap failed: ${(err as Error).message}`);
	}

	const after = snapshot(db);
	summary.changedRepoIds = [...after]
		.filter(([id, json]) => before.get(id) !== json)
		.map(([id]) => id);
	return summary;
}

async function mapLocal(
	db: Database,
	local: LocalOptions,
	districts: Districts,
	nowIso: string,
): Promise<LocalSummary> {
	const scan = await (local.scan ?? scanLocal)(local.roots);
	const checkouts = scan.checkouts;
	const known = new Map(
		db
			.query<{ id: string }, []>("SELECT id FROM repos WHERE is_local_only = 0")
			.all()
			.map((r) => [repoKey(r.id), r.id]),
	);

	const result: LocalSummary = {
		scanned: checkouts.length,
		mapped: 0,
		localOnly: [],
		worktrees: 0,
		errors: 0,
		incompleteRoots: scan.roots.filter((r) => !r.complete).map((r) => r.path),
	};

	const upsertMachine = db.query(
		`INSERT INTO machines (id, role) VALUES ($id, $role)
		 ON CONFLICT(id) DO UPDATE SET role = coalesce(excluded.role, role)`,
	);
	const upsertPath = db.query(
		`INSERT INTO repo_paths (machine_id, path, repo_id, is_worktree) VALUES ($m, $path, $repo, $wt)
		 ON CONFLICT(machine_id, path) DO UPDATE SET repo_id = excluded.repo_id, is_worktree = excluded.is_worktree`,
	);
	// Never flips a GitHub repo to local-only (WHERE on the update branch).
	const upsertLocalRepo = db.query(
		`INSERT INTO repos (id, district, is_local_only, synced_at) VALUES ($id, $district, 1, $now)
		 ON CONFLICT(id) DO UPDATE SET district = excluded.district, synced_at = excluded.synced_at
		 WHERE is_local_only = 1`,
	);

	db.transaction(() => {
		upsertMachine.run({
			id: local.machineId,
			role: MachineRole.safeParse(local.machineId).success
				? local.machineId
				: null,
		});
		const seen: string[] = [];
		for (const c of checkouts) {
			if (c.error) {
				result.errors++;
				continue;
			}
			if (c.isWorktree) result.worktrees++;
			let repoId = c.slug ? known.get(repoKey(c.slug)) : undefined;
			if (repoId) {
				result.mapped++;
			} else {
				repoId = c.slug ?? localRepoId(c.path);
				result.localOnly.push({
					id: repoId,
					path: c.path,
					reason: c.slug
						? "origin not in this account's GitHub repos"
						: c.hasOrigin
							? "origin is not github.com"
							: "no origin remote",
				});
				upsertLocalRepo.run({
					id: repoId,
					district: districts.districtOf(repoId),
					now: nowIso,
				});
			}
			upsertPath.run({
				m: local.machineId,
				path: c.path,
				repo: repoId,
				wt: c.isWorktree ? 1 : 0,
			});
			seen.push(c.path);
		}
		// Forget checkouts that disappeared — but only under roots scanned completely (F07). Mappings
		// under a missing root, a root with unreadable dirs or probe errors, or outside every root stay.
		const complete = scan.roots.filter((r) => r.complete).map((r) => r.path);
		const under = (p: string) =>
			complete.some((r) => p === r || p.startsWith(`${r}/`));
		const seenSet = new Set(seen);
		const del = db.query(
			"DELETE FROM repo_paths WHERE machine_id = $m AND path = $path",
		);
		for (const { path } of db
			.query<{ path: string }, { m: string }>(
				"SELECT path FROM repo_paths WHERE machine_id = $m",
			)
			.all({ m: local.machineId })) {
			if (!seenSet.has(path) && under(path))
				del.run({ m: local.machineId, path });
		}
		db.run(
			"DELETE FROM repos WHERE is_local_only = 1 AND id NOT IN (SELECT repo_id FROM repo_paths)",
		);
	})();
	return result;
}

export type ConfiguredSummary = SyncSummary & { tokenSource: TokenSource };

/** Everything from env: token, DB etag cache, districts.yaml, REPO_ROOTS. Used by CLI and hub. */
export async function runConfiguredSync(
	db: Database,
	env: Record<string, string | undefined> = process.env,
): Promise<ConfiguredSummary> {
	const { token, source } = await resolveGithubToken(env);
	const client = createGithubClient({
		token,
		etags: dbEtagStore(db),
		minRemaining: Number(env.GITHUB_RATE_MIN || 200),
	});
	// Every configured root is scanned; a missing / partially readable root keeps its old mappings.
	const roots = expandRoots(env.REPO_ROOTS);
	const summary = await syncGithub({
		db,
		client,
		districts: loadDistricts(),
		local:
			roots.length > 0
				? { machineId: env.AGENTCITY_MACHINE || "cockpit", roots }
				: null,
	});
	for (const r of roots.filter((r) => !existsSync(r))) {
		summary.warnings.push(`REPO_ROOTS entry does not exist: ${r}`);
	}
	if (summary.local?.incompleteRoots.length) {
		summary.warnings.push(
			`incomplete local scan, mappings kept for: ${summary.local.incompleteRoots.join(", ")}`,
		);
	}
	return { ...summary, tokenSource: source };
}

export function formatSummary(s: ConfiguredSummary): string {
	const rate = (b: RateState) =>
		b.remaining === null
			? "n/a"
			: `${b.remaining}/${b.limit} (reset ${b.resetAt})`;
	const unavailable = s.ciUnavailable
		.map((u) => ` · HTTP ${u.status}×${u.count}`)
		.join("");
	const lines = [
		`token source      : ${s.tokenSource}`,
		`viewer            : ${s.login ?? "?"}`,
		`repos             : ${s.total} total · ${s.private} private · ${s.archived} archived · ${s.forks} forks`,
		`pushed ≤ ${ACTIVE_WINDOW_DAYS}d       : ${s.activeWindow} (history + CI scope)`,
		`CI                : success ${s.ci.success} · failure ${s.ci.failure} · running ${s.ci.running} · none ${s.ci.none}  [304 cached ${s.ciCached}${unavailable}]`,
	];
	if (s.local) {
		lines.push(
			`local checkouts   : ${s.local.scanned} scanned · ${s.local.mapped} mapped · ${s.local.localOnly.length} local-only · ${s.local.worktrees} worktrees · ${s.local.errors} errors`,
		);
		for (const l of s.local.localOnly)
			lines.push(`  local-only      : ${l.id}  (${l.reason})  ${l.path}`);
	} else {
		lines.push("local checkouts   : skipped (REPO_ROOTS empty or missing)");
	}
	lines.push(
		`rate limit        : graphql ${rate(s.rate.graphql)} · core ${rate(s.rate.core)}`,
		`changed rows      : ${s.changedRepoIds.length}`,
	);
	if (s.remappedRefs)
		lines.push(`repo id remap     : ${s.remappedRefs} references`);
	if (s.aborted) lines.push(`ABORTED           : ${s.aborted}`);
	for (const w of s.warnings) lines.push(`warning           : ${w}`);
	return lines.join("\n");
}

if (import.meta.main) {
	const dbPath = process.env.DB_PATH || "./data/agentcity.db";
	try {
		const summary = await runConfiguredSync(openDb(dbPath));
		console.log(formatSummary(summary));
		process.exit(summary.aborted ? 2 : 0);
	} catch (err) {
		console.error(`[sync:github] ${redact((err as Error).message)}`);
		process.exit(1);
	}
}
