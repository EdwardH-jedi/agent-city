import { visibleSessions } from "../../board/session-panel.ts";
import { tailsWithSubagents } from "../../board/tail-memory.ts";
import type { CampusCrew } from "../../campus/presentation.ts";
import { familyOf, tagOf } from "../crew.ts";
import { hash32 } from "../lots.ts";
import type { InteriorTheme, Slot } from "./themes/types.ts";
import type { InteriorSource } from "./types.ts";

export interface Occupant extends CampusCrew {
	status: "active" | "waiting";
	slot: number;
	at: Slot;
}

/** Same visibility and subagent functions as SESSIONS; caps apply before stable seat assignment. */
export function occupants(
	source: InteriorSource,
	repo: string,
	theme: InteriorTheme,
	previous: readonly Occupant[] = [],
): Occupant[] {
	if (!source.model.village.shown.some((r) => r.id === repo)) return [];
	const visible = visibleSessions(
		source.sessions,
		source.model.waitingSessions,
		source.now,
	)
		.filter(
			(v) =>
				v.session.repo_id === repo &&
				(v.status === "active" || v.status === "waiting"),
		)
		.sort(
			(a, b) =>
				b.session.last_event_at.localeCompare(a.session.last_event_at) ||
				a.session.id.localeCompare(b.session.id),
		);
	const subs = tailsWithSubagents(new Map(), source.events);
	const out: Occupant[] = [];
	for (const status of ["active", "waiting"] as const) {
		const slots = status === "active" ? theme.slots : theme.waitSlots;
		const picked = visible
			.filter((v) => v.status === status)
			.slice(0, Math.min(slots.length, status === "active" ? 4 : 2));
		const used = new Set<number>();
		const seats = new Map<string, number>();
		for (const v of picked) {
			const old = previous.find(
				(p) => p.id === v.session.id && p.status === status,
			);
			if (old && old.slot < slots.length && !used.has(old.slot)) {
				seats.set(old.id, old.slot);
				used.add(old.slot);
			}
		}
		for (const v of [...picked].sort((a, b) =>
			a.session.id.localeCompare(b.session.id),
		)) {
			const s = v.session;
			let seat = seats.get(s.id);
			if (seat === undefined) {
				seat = hash32(s.id) % slots.length;
				while (used.has(seat)) seat = (seat + 1) % slots.length;
				used.add(seat);
			}
			const at = slots[seat];
			if (!at) continue;
			const old = previous.find((p) => p.id === s.id);
			// A1: first seen at work is anchored to session start, not its continually changing last event.
			const since =
				old?.status === status
					? old.since
					: old
						? s.last_event_at
						: s.started_at;
			const family = familyOf(s.provider, s.model);
			out.push({
				id: s.id,
				repo_id: repo,
				status,
				slot: seat,
				at,
				place: status === "active" ? "work" : "door",
				since,
				started_at: s.started_at,
				provider: s.provider,
				family,
				tag: tagOf(s.provider, family),
				companions:
					status === "active" ? Math.min(2, subs.get(s.id)?.subagents ?? 0) : 0,
			});
		}
	}
	return out;
}
