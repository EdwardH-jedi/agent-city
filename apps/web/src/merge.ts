// Pure merge rules for the live view (unit-tested in merge.test.ts). No React, no DOM.
import {
	type Event,
	type MachineView,
	machineStatus,
	type RunView,
	runStateAt,
	type Session,
	type SessionStatus,
} from "@agent-city/schema";

export const EVENT_LIMIT = 200;

/** Newest first, unique by id, capped. */
export function mergeEvents(
	a: readonly Event[],
	b: readonly Event[],
	limit = EVENT_LIMIT,
): Event[] {
	const byId = new Map<string, Event>();
	for (const e of [...a, ...b]) byId.set(e.id, e);
	return [...byId.values()]
		.sort((x, y) => (x.ts < y.ts ? 1 : x.ts > y.ts ? -1 : 0))
		.slice(0, limit);
}

/**
 * Upsert by id, ordered by the row version `rev` (re-audit N05): the hub bumps it on every write
 * (ingest, stale sweep, repo remap), so a higher rev is strictly newer. Equal rev → keep what we
 * have (same version). Timestamps are not compared — a snapshot that raced a live update can't win
 * with an older version, whatever order the two arrive in.
 */
export function mergeSessions(
	current: readonly Session[],
	incoming: readonly Session[],
): Session[] {
	const byId = new Map(current.map((s) => [s.id, s]));
	for (const s of incoming) {
		const prev = byId.get(s.id);
		if (!prev || (s.rev ?? 0) > (prev.rev ?? 0)) byId.set(s.id, s);
	}
	return [...byId.values()];
}

export type Scope = "sessions" | "events" | "repos";
const SCOPES: readonly Scope[] = ["sessions", "events", "repos"];

export type HubMessage =
	| { kind: "event"; data: Event }
	| { kind: "session"; data: Session }
	| { kind: "repo"; data: unknown }
	| { kind: "machine"; data: MachineView }
	| { kind: "run"; data: RunView }
	| { kind: "invalidate"; scope: Scope[] };

/** Parse one /ws frame; unknown or malformed frames → null. */
export function parseHubMessage(raw: string): HubMessage | null {
	let m: { kind?: unknown; data?: unknown; scope?: unknown };
	try {
		m = JSON.parse(raw);
	} catch {
		return null;
	}
	if (m?.kind === "invalidate") {
		const scope = Array.isArray(m.scope)
			? SCOPES.filter((s) => (m.scope as unknown[]).includes(s))
			: [];
		return { kind: "invalidate", scope };
	}
	if (
		m?.kind === "event" ||
		m?.kind === "session" ||
		m?.kind === "repo" ||
		m?.kind === "machine" ||
		m?.kind === "run"
	)
		return m as HubMessage;
	return null;
}

const MACHINE_ORDER = ["cockpit", "forge", "spine"] as const;

/**
 * Upsert machines by id. A snapshot or message carrying an older heartbeat never replaces a newer one
 * (a snapshot that raced a live beat can't win), and the result is always cockpit, forge, spine.
 */
export function mergeMachines(
	current: readonly MachineView[],
	incoming: readonly MachineView[],
): MachineView[] {
	const byId = new Map(current.map((m) => [m.id, m]));
	for (const m of incoming) {
		const prev = byId.get(m.id);
		if (!prev || (m.heartbeat_at ?? "") >= (prev.heartbeat_at ?? ""))
			byId.set(m.id, m);
	}
	return MACHINE_ORDER.flatMap((id) => {
		const m = byId.get(id);
		return m ? [m] : [];
	});
}

/**
 * Re-derive every machine's state from this screen's clock. The hub's `status` is only a snapshot of
 * the moment it answered; a machine that stops beating must turn stale, then offline, with no message.
 */
export function machinesAt(
	machines: readonly MachineView[],
	now: number,
): MachineView[] {
	const at = new Date(now);
	return machines.map((m) => ({
		...m,
		status: machineStatus(m.heartbeat_at, at),
	}));
}

const runKey = (r: Pick<RunView, "machine_id" | "run_id">) =>
	`${r.machine_id}/${r.run_id}`;

/** Position of a report in the cockpit's ledger, then the hub receive time as the final tie-break. */
const newerRun = (a: RunView, b: RunView): boolean =>
	a.ledger_revision !== b.ledger_revision
		? a.ledger_revision > b.ledger_revision
		: (a.last_event_sequence ?? -1) !== (b.last_event_sequence ?? -1)
			? (a.last_event_sequence ?? -1) > (b.last_event_sequence ?? -1)
			: a.reported_at >= b.reported_at;

/**
 * Upsert reported runs by (machine, run). The same order the hub uses: a snapshot that raced a live
 * message, or a replay of an older report, never replaces a newer one.
 */
export function mergeRuns(
	current: readonly RunView[],
	incoming: readonly RunView[],
): RunView[] {
	const byKey = new Map(current.map((r) => [runKey(r), r]));
	for (const r of incoming) {
		const prev = byKey.get(runKey(r));
		if (!prev || newerRun(r, prev)) byKey.set(runKey(r), r);
	}
	return [...byKey.values()];
}

/**
 * Re-derive each run's display from this screen's clock and the cockpit's current machine state, so a
 * report that stops arriving turns `snapshot_stale` ("last report: running (N min ago)") with no
 * message, and a run on an offline cockpit never looks alive.
 */
export function runsAt(
	runs: readonly RunView[],
	machines: readonly MachineView[],
	now: number,
): RunView[] {
	const at = new Date(now);
	const status = new Map(machines.map((m) => [m.id, m.status]));
	return runs.map((r) => ({
		...r,
		...runStateAt(
			r,
			r.reported_at,
			status.get(r.machine_id) ?? "unobserved",
			at,
		),
	}));
}

const LIVE: ReadonlySet<SessionStatus> = new Set(["active", "waiting", "idle"]);

/** Live (active / waiting / idle) sessions per repo id. */
export function liveCountByRepo(
	sessions: readonly Session[],
): Map<string, number> {
	const m = new Map<string, number>();
	for (const s of sessions)
		if (s.repo_id && LIVE.has(s.status))
			m.set(s.repo_id, (m.get(s.repo_id) ?? 0) + 1);
	return m;
}
