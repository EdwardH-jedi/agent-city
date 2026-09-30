// Pure merge rules for the live view (unit-tested in merge.test.ts). No React, no DOM.
import type { Event, Session, SessionStatus } from "@agent-city/schema";

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
	if (m?.kind === "event" || m?.kind === "session" || m?.kind === "repo")
		return m as HubMessage;
	return null;
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
