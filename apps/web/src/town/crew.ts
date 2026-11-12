// The town's crew (design doc 16 A1): the sessions the SESSIONS panel shows, drawn as people. Pure, no
// engine, no three (TownView imports it into the first chunk): the looks and spots are the stage's
// (crew-place.ts, crew-sprites.ts). Nothing new is fetched — the sessions and events are what useHub holds.
//
// - who: exactly the panel's visible sessions (session-panel.ts visibleSessions), before the panel's
//   height folding
//     active                               → `work`, in front of its building
//     waiting, HQ visit not over (or in its first 60 s, before the visit starts) → `door`, at its building's door
//     waiting whose HQ visit is over (30 min, `?session_wait=`; or older than 7 days) → `cafe`
//     idle / stale within 6 h              → `cafe`
//     ended, or resting past 6 h           → not drawn
//   A session with no building in the town (no repo, or a project folded out of the eight lots) is drawn
//   only when it rests (the cafe is nobody's building); working or waiting it stays in the panel only —
//   standing at the cafe would say it rests.
// - caps: CREW_PER_BUILDING at a building (door first, then the newest started active), CREW_AT_CAFE at
//   the cafe (newest first), CREW_MAX in all (the oldest resting go first, then the oldest active);
//   companions (running subagents, the panel's own count) beside an active one, COMPANIONS_PER each and
//   COMPANIONS_MAX in all
// - since: when it took its place, from the data alone (so a reload lands it where it was): the last
//   event for `work`, `door` and an `idle` rest; last event + 15 min for a `stale` one (the moment the
//   screen's clock turns it stale); wait start + the session wait for an old wait
import { type Session, STALE_AFTER_MS } from "@agent-city/schema";
import type { VillageModel } from "../board/model.ts";
import { visibleSessions } from "../board/session-panel.ts";
import { SESSION_WAIT_DEFAULT_MIN } from "../board/sessions.ts";
import type { TailEvent } from "../board/tail.ts";
import { tailsWithSubagents } from "../board/tail-memory.ts";
import type { CampusCrew, CrewPlace } from "../campus/presentation.ts";

export const CREW_PER_BUILDING = 3;
export const CREW_AT_CAFE = 6;
export const CREW_MAX = 16;
export const COMPANIONS_PER = 2;
export const COMPANIONS_MAX = 8;

/** Claude model families the town has a look and a tag for. */
const CLAUDE_FAMILIES = new Set(["opus", "sonnet", "haiku", "fable"]);

/** `claude-opus-5-5` / `claude-3-5-sonnet-…` → `opus` / `sonnet`; Codex → `codex`; anything else → null. */
export function familyOf(
	provider: string,
	model: string | null,
): string | null {
	if (provider === "codex") return "codex";
	// the family word anywhere (`claude-opus-5-5`, and older ids like `claude-3-5-sonnet-20241022`)
	const m = /(?:^|[-_ ])(opus|sonnet|haiku|fable)(?:$|[-_ ])/.exec(
		(model ?? "").toLowerCase().slice(0, 128),
	);
	const f = m?.[1] ?? "";
	return CLAUDE_FAMILIES.has(f) ? f : null;
}

/** The name tag: the family in capitals (`OPUS`, `CODEX`); a Claude session of an unknown model: `CLAUDE`. */
export function tagOf(provider: string, family: string | null): string | null {
	if (family) return family.toUpperCase();
	if (provider === "claude") return "CLAUDE";
	return null;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export interface CrewInput {
	sessions: readonly Session[];
	events: readonly TailEvent[];
	model: Pick<VillageModel, "waitingSessions" | "village">;
	now: number;
	/** The session wait (ms), as the board parsed it (`?session_wait=`); default 30 min. */
	sessionWaitMs?: number;
}

interface Draft extends CampusCrew {
	order: string;
	subagents: number;
}

export function townCrew(input: CrewInput): CampusCrew[] {
	const { now } = input;
	const waitMs = input.sessionWaitMs ?? SESSION_WAIT_DEFAULT_MIN * 60_000;
	const buildings = new Set(input.model.village.shown.map((p) => p.id));
	// the panel's own subagent count (tail.ts runningSubagents per session), without its tail memory
	const subs = tailsWithSubagents(new Map(), input.events);
	const drafts: Draft[] = [];
	for (const v of visibleSessions(
		input.sessions,
		input.model.waitingSessions,
		now,
	)) {
		const s = v.session;
		const last = Date.parse(s.last_event_at);
		let place: CrewPlace;
		let since: number;
		if (v.status === "active") {
			place = "work";
			since = last;
		} else if (v.status === "waiting" && !v.waited_since) {
			place = "door";
			since = last;
		} else {
			place = "cafe";
			if (v.status === "waiting") {
				// an old wait: it left the HQ when its session wait ran out
				const began = Date.parse(v.waited_since ?? s.last_event_at);
				since = began + waitMs;
			} else if (v.status === "stale") since = last + STALE_AFTER_MS;
			else since = last;
		}
		const building =
			s.repo_id !== null && buildings.has(s.repo_id) ? s.repo_id : null;
		if (place !== "cafe" && building === null) continue;
		if (!Number.isFinite(since)) since = now;
		const family = familyOf(s.provider, s.model);
		drafts.push({
			id: s.id,
			repo_id: building,
			place,
			since: iso(Math.min(now, since)),
			provider: s.provider,
			family,
			tag: tagOf(s.provider, family),
			companions: 0,
			started_at: s.started_at,
			// a stable order: a working session's events must not swap who is drawn at its building
			order: place === "work" ? s.started_at : s.last_event_at,
			subagents: v.status === "active" ? (subs.get(s.id)?.subagents ?? 0) : 0,
		});
	}

	// rank: door, then work, then cafe; newest first (a working one by when it started, so its events
	// never swap who is drawn; the others by their last event, which does not move while they wait or
	// rest); the id breaks ties
	const rank = (d: Draft) =>
		d.place === "door" ? 0 : d.place === "work" ? 1 : 2;
	drafts.sort(
		(a, b) =>
			rank(a) - rank(b) ||
			b.order.localeCompare(a.order) ||
			a.id.localeCompare(b.id),
	);
	const perBuilding = new Map<string, number>();
	let atCafe = 0;
	const kept: Draft[] = [];
	for (const d of drafts) {
		if (d.place === "cafe") {
			if (atCafe >= CREW_AT_CAFE) continue;
			atCafe++;
		} else {
			const key = d.repo_id ?? "";
			const n = perBuilding.get(key) ?? 0;
			if (n >= CREW_PER_BUILDING) continue;
			perBuilding.set(key, n + 1);
		}
		kept.push(d);
	}
	// over CREW_MAX: the list is ranked door → work → cafe, newest first, so the tail is the oldest
	// resting, then the oldest active
	kept.length = Math.min(kept.length, CREW_MAX);

	let companions = 0;
	for (const d of kept) {
		if (d.place !== "work") continue;
		const n = Math.min(
			COMPANIONS_PER,
			d.subagents,
			COMPANIONS_MAX - companions,
		);
		d.companions = Math.max(0, n);
		companions += d.companions;
	}
	return kept.map(({ order: _o, subagents: _s, ...c }) => c);
}
