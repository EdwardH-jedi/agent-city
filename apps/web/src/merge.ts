// Pure merge rules for the live view (unit-tested in merge.test.ts). No React, no DOM.
import type { Event, Session } from "@agent-city/schema";

export const EVENT_LIMIT = 200;

const time = (ts: string) => {
	const t = Date.parse(ts);
	return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
};

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
 * Upsert by id, ordered by `last_event_at` (F12): an incoming copy wins when it is at least as
 * recent. On a tie the incoming (server) copy wins — the stale sweep changes `status` without
 * moving `last_event_at`. An older snapshot never overwrites a newer live update.
 */
export function mergeSessions(
	current: readonly Session[],
	incoming: readonly Session[],
): Session[] {
	const byId = new Map(current.map((s) => [s.id, s]));
	for (const s of incoming) {
		const prev = byId.get(s.id);
		if (!prev || time(s.last_event_at) >= time(prev.last_event_at))
			byId.set(s.id, s);
	}
	return [...byId.values()];
}
