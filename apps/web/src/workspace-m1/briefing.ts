// CEO status briefing (multi-repository milestone): a deterministic summary of ONE repository's
// recorded state, derived purely from the workspace snapshot the store already holds — the same one
// cache that drives the task list and the Headquarters inbox, so the briefing can never disagree with
// them — plus the connection state. No model, no transport call, no invented data: every claim names a
// recorded state and the recorded timestamp it rests on (what the record does not say reads as not
// recorded), and every claim carries the route its control navigates to (a task or an HQ document —
// never a command). Pure; no React, no DOM.
import type {
	ExecutionQueue,
	WorkspacePhase,
	WorkspaceSnapshot,
	WorkspaceTaskListItem,
} from "@agent-city/schema/workspace-m1";
import {
	clockTime,
	connectionIsStale,
	dateTime,
	failureLabel,
	INBOX_UNATTRIBUTED_NOTE,
	INVALIDATION_LABEL,
	nextAction,
	OBSERVED_REPO_NOTE,
	PHASE_LABEL,
	QUARANTINE_PAUSE_NOTE,
	queueLine,
	SNAPSHOT_STALE_AFTER_MS,
	TASK_WINDOW_UNKNOWN_NOTE,
	taskWindowNote,
	UNKNOWN_REPO_NOTE,
	validityFreshness,
	validityShortLabel,
} from "./labels.ts";
import type { Route } from "./route.ts";

export type BriefingState =
	| "loading"
	| "empty"
	| "idle"
	| "active"
	| "attention"
	| "observed";

export type BriefingFreshness = "current" | "stale" | "offline";

export type BriefingItemKind =
	| "needs_approval"
	| "needs_acceptance"
	| "validity_invalid"
	| "integrity_invalid"
	| "quarantined"
	| "blocked"
	| "interrupted"
	| "failed"
	| "cancelled"
	| "running"
	| "queued"
	| "cancel_requested"
	| "accepted"
	| "rejected"
	| "draft"
	| "changes_requested";

export type BriefingSectionId =
	| "decisions"
	| "attention"
	| "now"
	| "finished"
	| "drafts";

export interface BriefingItem {
	kind: BriefingItemKind;
	taskId: string;
	requestId: string | null;
	title: string;
	/** The claim: a recorded state, stated exactly. */
	text: string;
	/** The recorded timestamp the claim rests on, or null when the record has none. */
	at: string | null;
	/** "<what the time is> <date>" or "time not recorded". */
	when: string;
	/** Where the claim's control navigates (task detail or HQ document). */
	target: Route;
	linkLabel: string;
}

export interface BriefingSection {
	id: BriefingSectionId;
	heading: string;
	items: BriefingItem[];
}

export interface RepoBriefing {
	repoId: string;
	state: BriefingState;
	freshness: BriefingFreshness;
	freshnessLine: string;
	summary: string;
	/** The next available human action (null when there is none to offer, e.g. observed repositories). */
	next: { text: string; label: string | null; target: Route | null } | null;
	/** Facts about the whole engine that affect this repository (e.g. a global quarantine pause). */
	notes: string[];
	sections: BriefingSection[];
	/** Accepted / rejected results older than the most recent ones listed. */
	olderFinished: number;
	/**
	 * P2 F-01: how much of the repository the snapshot's bounded task window holds — `shown` of `recorded`
	 * (the hub's complete count; null when not reported). `complete` = every recorded task is shown. Null
	 * when not applicable (loading, observed-only or unknown repository).
	 */
	window: { shown: number; recorded: number | null; complete: boolean } | null;
	counts: {
		running: number;
		queued: number;
		cancelRequested: number;
		needsApproval: number;
		needsAcceptance: number;
		attention: number;
		cancelled: number;
		accepted: number;
		rejected: number;
		drafts: number;
	};
}

export interface BriefingInput {
	snapshot: WorkspaceSnapshot | null;
	repoId: string;
	/** General connection liveness (offline / stale connection). */
	conn: { status: string; lastConfirmedAt: string | null };
	/**
	 * P2 F-02: when the snapshot's repository facts were last confirmed by a snapshot read, and whether the
	 * latest snapshot read failed since (the store's `snapshotSync`). Missing = never confirmed (stale).
	 */
	sync: { confirmedAt: string | null; failedAt: string | null } | undefined;
	now: number;
}

/** How many finished (accepted / rejected) results the briefing lists, newest first. */
export const BRIEFING_FINISHED_LIMIT = 5;

/** The snapshot's list caps (`pending_requests`, `execution_queue.queued`; api.ts): a full list may be cut. */
const SNAPSHOT_LIST_MAX = 500;

export const SECTION_HEADING: Readonly<Record<BriefingSectionId, string>> = {
	decisions: "Needs Edward's decision",
	attention: "Stopped, blocked or invalid",
	now: "Running or queued",
	finished: "Recently finished",
	drafts: "Drafts and requested changes",
};

const INTEGRITY_REASONS = new Set([
	"integrity_failed",
	"candidate_mutated",
	"evidence_unavailable",
]);

const IN_FLIGHT: ReadonlySet<WorkspacePhase> = new Set([
	"queued",
	"implementing",
	"verifying",
	"reviewing",
	"repairing",
	"finalizing",
]);

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

const when = (label: string, at: string | null): string =>
	at ? `${label} ${dateTime(at)}` : "time not recorded";

const titleOf = (item: WorkspaceTaskListItem): string =>
	item.task.draft.title || "Untitled task";

const taskRoute = (item: WorkspaceTaskListItem): Route => ({
	view: "projects",
	repoId: item.task.repo_id,
	taskId: item.task.id,
	requestId: null,
});

/**
 * P2 F-02: the briefing's facts are the snapshot's, so their age is the last successful SNAPSHOT read —
 * never a task detail read or the connection's liveness (an answered detail of one task does not
 * refresh another repository's facts). Current only while the connection is fresh, the latest snapshot
 * read succeeded and it is at most SNAPSHOT_STALE_AFTER_MS old; "last confirmed" is always that read.
 */
function freshnessOf(
	input: BriefingInput,
	fixture: boolean,
): { freshness: BriefingFreshness; line: string } {
	const { conn, now } = input;
	const confirmedAt = input.sync?.confirmedAt ?? null;
	const at = clockTime(confirmedAt);
	const confirmed = confirmedAt ? Date.parse(confirmedAt) : Number.NaN;
	if (conn.status === "offline")
		return {
			freshness: "offline",
			line: `Offline · last confirmed ${at} · this briefing may be out of date.`,
		};
	if (connectionIsStale(conn, now))
		return {
			freshness: "stale",
			line: `Connection stale · last confirmed ${at} · this briefing may be out of date.`,
		};
	if (input.sync?.failedAt)
		return {
			freshness: "stale",
			line: `Repository record not refreshed — the latest read failed · last confirmed ${at} · this briefing may be out of date.`,
		};
	if (!Number.isFinite(confirmed) || now - confirmed > SNAPSHOT_STALE_AFTER_MS)
		return {
			freshness: "stale",
			line: `Repository record stale · last confirmed ${at} · this briefing may be out of date.`,
		};
	return {
		freshness: "current",
		line: `From the ${fixture ? "UI fixture" : "hub"} record confirmed at ${at}.`,
	};
}

/** One task → at most one claim, in the most important place it belongs (decisions first). */
function classify(
	item: WorkspaceTaskListItem,
	snap: WorkspaceSnapshot,
	input: BriefingInput,
): { section: BriefingSectionId; item: BriefingItem } {
	const t = item.task;
	const title = titleOf(item);
	const base = { taskId: t.id, title };
	const engine = item.engine ?? null;
	const latest = item.latest_request ?? null;
	const pending = snap.pending_requests
		.filter((r) => r.workspace_task_id === t.id)
		.sort((a, b) =>
			a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
		)[0];
	const toTask = { target: taskRoute(item), linkLabel: "Open task" };

	// 1 — Edward's decisions (pending Gate 1 / Gate 2)
	if (pending) {
		const target: Route = {
			view: "hq",
			repoId: null,
			taskId: t.id,
			requestId: pending.id,
		};
		return pending.kind === "run"
			? {
					section: "decisions",
					item: {
						...base,
						kind: "needs_approval",
						requestId: pending.id,
						text: "Execution approval requested — nothing runs until Edward approves it.",
						at: pending.created_at,
						when: when("waiting since", pending.created_at),
						target,
						linkLabel: "Open execution approval",
					},
				}
			: {
					section: "decisions",
					item: {
						...base,
						kind: "needs_acceptance",
						requestId: pending.id,
						text: "Result ready (engine human_ready) — NOT accepted yet.",
						at: pending.created_at,
						when: when("waiting since", pending.created_at),
						target,
						linkLabel: "Open result acceptance",
					},
				};
	}
	// the stage says a gate is open but the inbox list does not carry it (list cap / lag): still Edward's
	if (item.phase === "awaiting_run_approval") {
		const id =
			latest?.kind === "run" && latest.status === "pending" ? latest.id : null;
		return {
			section: "decisions",
			item: {
				...base,
				kind: "needs_approval",
				requestId: id,
				text: "Execution approval requested — nothing runs until Edward approves it.",
				at: id ? (latest?.created_at ?? null) : null,
				when: when("waiting since", id ? (latest?.created_at ?? null) : null),
				...(id
					? {
							target: {
								view: "hq",
								repoId: null,
								taskId: t.id,
								requestId: id,
							} satisfies Route,
							linkLabel: "Open execution approval",
						}
					: toTask),
			},
		};
	}
	if (item.phase === "awaiting_acceptance")
		return {
			section: "decisions",
			item: {
				...base,
				kind: "needs_acceptance",
				requestId: null,
				text: "Result ready (engine human_ready) — NOT accepted yet.",
				at: null,
				when: when("", null),
				...toTask,
			},
		};

	// 2 — stopped, blocked or invalid
	const v = item.acceptance_validity;
	if (v?.status === "invalid")
		return {
			section: "attention",
			item: {
				...base,
				kind: "validity_invalid",
				requestId: null,
				text: `Accepted — ${validityShortLabel(v)}.`,
				at: v.first_invalid_at ?? v.checked_at,
				when: v.first_invalid_at
					? when("first found invalid", v.first_invalid_at)
					: when("checked", v.checked_at),
				...toTask,
			},
		};
	if (
		latest?.kind === "result" &&
		latest.status === "invalidated" &&
		latest.invalidation_reason !== null &&
		INTEGRITY_REASONS.has(latest.invalidation_reason) &&
		t.stage === "execution_ended"
	)
		return {
			section: "attention",
			item: {
				...base,
				kind: "integrity_invalid",
				requestId: latest.id,
				text: `Result invalidated before acceptance: ${INVALIDATION_LABEL[latest.invalidation_reason]}. Nothing was accepted.`,
				at: latest.closed_at,
				when: when("invalidated", latest.closed_at),
				...toTask,
			},
		};
	if (engine?.quarantined)
		return {
			section: "attention",
			item: {
				...base,
				kind: "quarantined",
				requestId: null,
				text: `${PHASE_LABEL[item.phase]} — a process of this execution is not proven terminated; the engine claims nothing in any repository until it is.`,
				at: t.updated_at,
				when: when("last task update", t.updated_at),
				...toTask,
			},
		};
	if (
		item.phase === "blocked" ||
		item.phase === "interrupted" ||
		item.phase === "failed"
	) {
		const why = failureLabel(engine?.failure_kind ?? null);
		return {
			section: "attention",
			item: {
				...base,
				kind: item.phase,
				requestId: null,
				text: `${PHASE_LABEL[item.phase]}${why ? ` — ${why}` : "."}`,
				at: t.updated_at,
				when: when("last task update", t.updated_at),
				...toTask,
			},
		};
	}
	if (item.phase === "cancelled") {
		// say which cancellation the record shows: a withdrawn Gate 1, or an execution the engine
		// confirmed cancelled; anything else is stated without guessing
		const withdrawn =
			latest?.kind === "run" &&
			latest.status === "invalidated" &&
			latest.invalidation_reason === "withdrawn";
		const confirmed = engine?.state === "cancelled";
		const text = withdrawn
			? "Cancelled — the execution approval request was withdrawn; nothing ran."
			: confirmed
				? "Cancelled — the engine confirmed the execution's termination."
				: "Cancelled.";
		const at = withdrawn ? (latest?.closed_at ?? null) : t.updated_at;
		return {
			section: "attention",
			item: {
				...base,
				kind: "cancelled",
				requestId: null,
				text,
				at,
				when: withdrawn ? when("withdrawn", at) : when("last task update", at),
				...toTask,
			},
		};
	}

	// 3 — running or queued (the engine runs one execution at a time across all repositories)
	if (item.phase === "cancel_requested") {
		const at = engine?.cancel_requested_at ?? t.cancel_requested_at;
		return {
			section: "now",
			item: {
				...base,
				kind: "cancel_requested",
				requestId: null,
				text: "Cancellation requested — not cancelled until the engine confirms termination.",
				at,
				when: when("requested", at),
				...toTask,
			},
		};
	}
	if (IN_FLIGHT.has(item.phase)) {
		const queue = snap.execution_queue as ExecutionQueue | undefined;
		const entry =
			engine &&
			[queue?.active, ...(queue?.queued ?? [])].find(
				(q) => q?.managed_task_id === engine.managed_task_id,
			);
		const line = engine
			? queueLine(
					queue,
					engine.managed_task_id,
					engine.state,
					t.repo_id,
					(id) => {
						const other = snap.tasks.find((x) => x.task.id === id);
						return other ? titleOf(other) : null;
					},
				)
			: null;
		const running = line?.kind === "slot" || item.phase !== "queued";
		const attempt = engine?.attempt_no ? ` (attempt ${engine.attempt_no})` : "";
		const at = entry?.run_requested_at ?? null;
		return {
			section: "now",
			item: {
				...base,
				kind: running ? "running" : "queued",
				requestId: null,
				text: running
					? `${PHASE_LABEL[item.phase]}${attempt}${line?.kind === "slot" ? " · holds the engine slot" : ""}.`
					: `${line?.text ?? "Queued · queue position unknown"}.`,
				at,
				when: when("approved to run", at),
				...toTask,
			},
		};
	}

	// 4 — finished
	if (item.phase === "accepted") {
		const at =
			latest?.kind === "result" && latest.status === "accepted"
				? latest.closed_at
				: null;
		const fresh = v
			? validityFreshness(v.checked_at, input.now, input.conn)
			: null;
		return {
			section: "finished",
			item: {
				...base,
				kind: "accepted",
				requestId: null,
				text: `Accepted by Edward — current validity: ${validityShortLabel(v, fresh)}.`,
				at,
				when: when("accepted", at),
				...toTask,
			},
		};
	}
	if (item.phase === "rejected") {
		const at = latest?.status === "rejected" ? latest.closed_at : null;
		return {
			section: "finished",
			item: {
				...base,
				kind: "rejected",
				requestId: null,
				text: "Rejected — closed; nothing was accepted.",
				at,
				when: when("rejected", at),
				...toTask,
			},
		};
	}

	// 5 — drafts and requested changes
	if (item.phase === "changes_requested") {
		const at =
			latest?.status === "changes_requested" ? latest.closed_at : t.updated_at;
		return {
			section: "drafts",
			item: {
				...base,
				kind: "changes_requested",
				requestId: null,
				text: "Changes requested — edit the draft and submit a new proposal version.",
				at,
				when: when(
					latest?.status === "changes_requested"
						? "requested"
						: "last task update",
					at,
				),
				...toTask,
			},
		};
	}
	return {
		section: "drafts",
		item: {
			...base,
			kind: "draft",
			requestId: null,
			text: "Draft — not submitted for execution approval.",
			at: t.updated_at,
			when: when("last saved", t.updated_at),
			...toTask,
		},
	};
}

const newestFirst = (a: BriefingItem, b: BriefingItem) =>
	(b.at ?? "") < (a.at ?? "") ? -1 : (b.at ?? "") > (a.at ?? "") ? 1 : 0;
const oldestFirst = (a: BriefingItem, b: BriefingItem) => newestFirst(b, a);

/** The briefing of the selected repository. */
export function repoBriefing(input: BriefingInput): RepoBriefing {
	const snap = input.snapshot;
	const fixture = snap?.provenance.data_source === "fixture";
	const { freshness, line } = freshnessOf(input, fixture);
	// the validity labels inside the briefing age with the same snapshot facts, not the connection
	const facts: BriefingInput = {
		...input,
		conn: {
			status: freshness === "current" ? input.conn.status : "stale",
			lastConfirmedAt: input.sync?.confirmedAt ?? null,
		},
	};
	const counts: RepoBriefing["counts"] = {
		running: 0,
		queued: 0,
		cancelRequested: 0,
		needsApproval: 0,
		needsAcceptance: 0,
		attention: 0,
		cancelled: 0,
		accepted: 0,
		rejected: 0,
		drafts: 0,
	};
	const empty = (
		state: BriefingState,
		summary: string,
		next: RepoBriefing["next"],
		taskWindow: RepoBriefing["window"] = null,
	): RepoBriefing => ({
		repoId: input.repoId,
		state,
		freshness,
		freshnessLine: line,
		summary,
		next,
		notes: [],
		sections: [],
		olderFinished: 0,
		counts,
		window: taskWindow,
	});
	if (!snap) return empty("loading", "Loading the workspace record…", null);
	const allowlisted = snap.repos.some((r) => r.repo_id === input.repoId);
	if (!allowlisted) {
		const observed = (snap.observed_repos ?? []).some(
			(r) => r.repo_id === input.repoId,
		);
		return observed
			? empty("observed", OBSERVED_REPO_NOTE, null)
			: empty("empty", UNKNOWN_REPO_NOTE, null);
	}
	const mine = snap.tasks.filter((t) => t.task.repo_id === input.repoId);
	const queue = snap.execution_queue;
	// P2 F-01: `tasks` is a bounded window. Only the hub's complete count may say this repository has no
	// tasks; when some of its tasks are not shown, a pending request or queued execution the window could
	// not attribute (or a list at its cap) may be this repository's, so nothing claims "nothing waiting".
	const recorded =
		snap.repo_task_counts?.find((c) => c.repo_id === input.repoId)?.tasks ??
		null;
	const allShown = recorded !== null && mine.length >= recorded;
	const taskWindow = { shown: mine.length, recorded, complete: allShown };
	const listed = new Set(snap.tasks.map((t) => t.task.id));
	const queued = [queue?.active, ...(queue?.queued ?? [])];
	const attributed =
		snap.pending_requests.length < SNAPSHOT_LIST_MAX &&
		(queue?.queued.length ?? 0) < SNAPSHOT_LIST_MAX &&
		snap.pending_requests.every((r) => listed.has(r.workspace_task_id)) &&
		queued.every(
			(q) => !q?.workspace_task_id || listed.has(q.workspace_task_id),
		);
	const maybeHidden = !allShown && !attributed;
	const windowNote = allShown
		? ""
		: recorded === null
			? TASK_WINDOW_UNKNOWN_NOTE
			: taskWindowNote(mine.length, recorded);
	if (mine.length === 0 && recorded === 0)
		return empty(
			"empty",
			"No tasks are recorded for this repository yet.",
			{
				text: "Assign work to start the first task.",
				label: null,
				target: null,
			},
			taskWindow,
		);

	const buckets: Record<BriefingSectionId, BriefingItem[]> = {
		decisions: [],
		attention: [],
		now: [],
		finished: [],
		drafts: [],
	};
	const stageOf = new Map(mine.map((m) => [m.task.id, m]));
	for (const m of mine) {
		const c = classify(m, snap, facts);
		buckets[c.section].push(c.item);
		switch (c.item.kind) {
			case "running":
				counts.running++;
				break;
			case "queued":
				counts.queued++;
				break;
			case "cancel_requested":
				counts.cancelRequested++;
				break;
			case "needs_approval":
				counts.needsApproval++;
				break;
			case "needs_acceptance":
				counts.needsAcceptance++;
				break;
			case "cancelled":
				counts.cancelled++;
				break;
			case "accepted":
				counts.accepted++;
				break;
			case "rejected":
				counts.rejected++;
				break;
			case "draft":
			case "changes_requested":
				counts.drafts++;
				break;
			default:
				counts.attention++;
		}
	}
	buckets.decisions.sort(oldestFirst);
	buckets.attention.sort(newestFirst);
	buckets.drafts.sort(newestFirst);
	buckets.finished.sort(newestFirst);
	// running first, then the queue in claim order (the queue line carries the position)
	const order = [
		queue?.active?.workspace_task_id,
		...(queue?.queued ?? []).map((q) => q.workspace_task_id),
	];
	const rank = (i: BriefingItem) => {
		const k = order.indexOf(i.taskId);
		return k < 0 ? order.length : k;
	};
	buckets.now.sort((a, b) => rank(a) - rank(b));
	const olderFinished = Math.max(
		0,
		buckets.finished.length - BRIEFING_FINISHED_LIMIT,
	);
	buckets.finished = buckets.finished.slice(0, BRIEFING_FINISHED_LIMIT);

	const sections: BriefingSection[] = (
		["decisions", "attention", "now", "finished", "drafts"] as const
	)
		.filter((id) => buckets[id].length > 0)
		.map((id) => ({ id, heading: SECTION_HEADING[id], items: buckets[id] }));

	const parts: string[] = [];
	const inFlight = counts.running + counts.queued + counts.cancelRequested;
	if (counts.running) parts.push(`${counts.running} running`);
	if (counts.queued) parts.push(`${counts.queued} queued`);
	if (counts.cancelRequested)
		parts.push(`${counts.cancelRequested} cancellation requested`);
	if (counts.needsApproval)
		parts.push(`${counts.needsApproval} awaiting execution approval`);
	if (counts.needsAcceptance)
		parts.push(
			`${plural(counts.needsAcceptance, "result")} ready, not accepted`,
		);
	if (counts.attention)
		parts.push(`${counts.attention} stopped, blocked or invalid`);
	if (counts.cancelled) parts.push(`${counts.cancelled} cancelled`);
	if (counts.accepted) parts.push(`${counts.accepted} accepted`);
	if (counts.rejected) parts.push(`${counts.rejected} rejected`);
	if (counts.drafts) parts.push(`${plural(counts.drafts, "draft")} open`);
	const decisions = counts.needsApproval + counts.needsAcceptance;
	const quiet =
		decisions === 0 && inFlight === 0 && counts.attention === 0 && !maybeHidden;
	// every recorded kind adds a part, so `parts` is empty only when none of this repository's tasks is shown
	const summary = [
		quiet ? "Nothing is running or waiting for Edward." : "",
		parts.length > 0 ? `${parts.join(" · ")}.` : "",
		windowNote,
	]
		.filter(Boolean)
		.join(" ");

	const state: BriefingState =
		decisions > 0 || counts.attention > 0 || maybeHidden
			? "attention"
			: inFlight > 0
				? "active"
				: "idle";

	const firstOf = (id: BriefingSectionId, skip?: BriefingItemKind) =>
		buckets[id].find((i) => i.kind !== skip);
	const nextFor = (i: BriefingItem, prefix = ""): RepoBriefing["next"] => {
		const m = stageOf.get(i.taskId);
		return {
			text: `${prefix}${m ? nextAction(m.task.stage, m.phase) : ""}`,
			label: `${i.linkLabel} · ${i.title}`,
			target: i.target,
		};
	};
	const pick =
		firstOf("decisions") ??
		firstOf("attention", "cancelled") ??
		firstOf("drafts") ??
		null;
	let next: RepoBriefing["next"];
	if (pick) next = nextFor(pick);
	else if (maybeHidden)
		next = {
			text: "Open Headquarters to see every pending decision.",
			label: "Open Headquarters",
			target: { view: "hq", repoId: null, taskId: null, requestId: null },
		};
	else if (buckets.now[0])
		next = nextFor(buckets.now[0], "Nothing needs Edward now. ");
	else if (firstOf("attention"))
		next = nextFor(firstOf("attention") as BriefingItem);
	else
		next = {
			text: "Nothing needs Edward now. Assign work to start a new task.",
			label: null,
			target: null,
		};

	const notes: string[] = [];
	if (maybeHidden) notes.push(INBOX_UNATTRIBUTED_NOTE);
	if (queue?.claims_paused_by_quarantine)
		notes.push(
			`The engine is not claiming work: ${QUARANTINE_PAUSE_NOTE.replace(/^claims paused: /, "")}.`,
		);
	const active = queue?.active;
	if (active && active.repo_id !== input.repoId && counts.queued > 0)
		notes.push(
			`The single engine slot is held by ${active.repo_id}; this repository's queued work waits for it.`,
		);

	return {
		repoId: input.repoId,
		state,
		freshness,
		freshnessLine: line,
		summary,
		next,
		notes,
		sections,
		olderFinished,
		counts,
		window: taskWindow,
	};
}
