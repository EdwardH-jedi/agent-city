// Lead visits to the HQ (pure scheduler; no three, no DOM, no callbacks). Ported from the campus
// branch and extended with the walk back (design doc §5, §10 V2.1):
// - one visit per visitor id; asking again with the same ids returns the SAME book (no restart);
// - progress is anchored to the visit's `created_at`, clamped to [0, MAX_HEAD_START_MS] at first
//   sight, so a reload mid-walk resumes and an old visit is already arrived;
// - a visit that leaves the list is not dropped: its lead walks back from where it stands and the
//   visit is gone only once home (`settleVisits` prunes it);
// - while the scene is still (reports stopped) an ending visit is dropped at once, so frozen figures
//   never pile up;
// - reduced motion → arrival and return are immediate;
// - arrival and return are poses, nothing else: this module emits nothing.
import type { CampusVisitor, Carry } from "./presentation.ts";

export const MAX_HEAD_START_MS = 60_000;
/** Walking speed between buildings (prototype: 7.2; slower reads calmer in a small pane). */
export const WALK_SPEED = 4.2;
export const MIN_WALK_MS = 7_000;
export const MAX_WALK_MS = 20_000;

export interface Visit {
	readonly visit_id: string;
	readonly carry: Carry | null;
	readonly repo_id: string;
	/** Lobby seat at the HQ; the lowest free seat when the visit began, never reassigned. */
	readonly seat: number;
	/** Scene clock (ms) when the visit was first seen. */
	readonly seen_at: number;
	/** How far into the walk the visit already was when first seen. */
	readonly head_start_ms: number;
	/** Scene clock when the visit ended and the lead turned back; null while it lasts. */
	readonly left_at: number | null;
	/** Walk progress (0..1) at the moment it turned back. */
	readonly left_from: number;
}

export interface VisitBook {
	/** Ordered by seat. */
	readonly visits: readonly Visit[];
}

export const EMPTY_BOOK: VisitBook = Object.freeze({
	visits: Object.freeze([]),
});

export type VisitorLike = Pick<
	CampusVisitor,
	"visit_id" | "carry" | "repo_id" | "created_at"
>;

/** Walk length of one visit (from its building to its seat), in ms. */
export type WalkMsOf = (v: Pick<Visit, "repo_id" | "seat">) => number;

function headStart(createdAt: string, now: number): number {
	const t = Date.parse(createdAt);
	if (!Number.isFinite(t)) return 0;
	return Math.min(MAX_HEAD_START_MS, Math.max(0, now - t));
}

export function walkDurationMs(routeLength: number): number {
	const ms = (routeLength / WALK_SPEED) * 1000;
	return Math.min(MAX_WALK_MS, Math.max(MIN_WALK_MS, ms));
}

/** 0 = at its own building, 1 = arrived at the HQ. Walking back runs from `left_from` down to 0. */
export function visitProgress(
	v: Visit,
	now: number,
	walkMs: number,
	reducedMotion: boolean,
): number {
	if (v.left_at !== null) {
		if (reducedMotion || walkMs <= 0) return 0;
		const back = Math.max(0, now - v.left_at) / walkMs;
		return Math.max(0, v.left_from - back);
	}
	if (reducedMotion || walkMs <= 0) return 1;
	const t = (v.head_start_ms + Math.max(0, now - v.seen_at)) / walkMs;
	if (t >= 1) return 1;
	return t <= 0 ? 0 : t;
}

/** The lead is home again: the visit can be forgotten. */
export function visitDone(
	v: Visit,
	now: number,
	walkMs: number,
	reducedMotion: boolean,
): boolean {
	return (
		v.left_at !== null && visitProgress(v, now, walkMs, reducedMotion) <= 0
	);
}

/** Visitors → visits. Returns `book` itself when nothing changed. */
export function reconcileVisits(
	book: VisitBook,
	visitors: readonly VisitorLike[],
	now: number,
	walkMsOf: WalkMsOf,
	reducedMotion = false,
	/**
	 * Reports are stopped and the scene clock stands: a visit that ends now cannot walk back, so it is
	 * forgotten at once instead of standing frozen (nothing piles up during a long outage).
	 */
	still = false,
): VisitBook {
	const wanted = new Map<string, VisitorLike>();
	for (const p of visitors)
		if (!wanted.has(p.visit_id)) wanted.set(p.visit_id, p);

	let changed = false;
	const kept: Visit[] = [];
	for (const v of book.visits) {
		const p = wanted.get(v.visit_id);
		if (!p) {
			if (still) {
				changed = true; // dropped: no frozen figure is left behind
				continue;
			}
			if (v.left_at === null) {
				// ended (resolved, or the report's 5 minutes are over): turn back from where it stands
				changed = true;
				kept.push({
					...v,
					left_at: now,
					left_from: visitProgress(v, now, walkMsOf(v), reducedMotion),
				});
			} else kept.push(v);
			continue;
		}
		wanted.delete(v.visit_id);
		if (v.left_at !== null) {
			// came back while walking home: walk to the HQ again from where it is
			changed = true;
			const at = visitProgress(v, now, walkMsOf(v), reducedMotion);
			kept.push({
				...v,
				carry: p.carry,
				seen_at: now,
				head_start_ms: at * walkMsOf(v),
				left_at: null,
				left_from: 0,
			});
			continue;
		}
		if (p.carry !== v.carry || p.repo_id !== v.repo_id) {
			changed = true;
			kept.push({ ...v, carry: p.carry, repo_id: p.repo_id });
		} else kept.push(v);
	}
	if (wanted.size === 0 && !changed) return book;

	const fresh = [...wanted.values()].sort((a, b) =>
		a.created_at === b.created_at
			? a.visit_id < b.visit_id
				? -1
				: 1
			: a.created_at < b.created_at
				? -1
				: 1,
	);
	const taken = new Set(kept.map((v) => v.seat));
	let next = 0;
	const added: Visit[] = fresh.map((p) => {
		while (taken.has(next)) next += 1;
		taken.add(next);
		return {
			visit_id: p.visit_id,
			carry: p.carry,
			repo_id: p.repo_id,
			seat: next,
			seen_at: now,
			head_start_ms: headStart(p.created_at, now),
			left_at: null,
			left_from: 0,
		};
	});
	const visits = [...kept, ...added].sort((a, b) => a.seat - b.seat);
	return Object.freeze({ visits: Object.freeze(visits) });
}

/** Forget the visits whose lead is home. Returns `book` itself when none is. */
export function settleVisits(
	book: VisitBook,
	now: number,
	walkMsOf: WalkMsOf,
	reducedMotion = false,
): VisitBook {
	const left = book.visits.filter(
		(v) => !visitDone(v, now, walkMsOf(v), reducedMotion),
	);
	return left.length === book.visits.length
		? book
		: Object.freeze({ visits: Object.freeze(left) });
}

/**
 * The scene's clock: wall time minus every stretch spent still. While reports are stopped the
 * clock stands, so every walking lead stops where it is and resumes from there (no jump).
 */
export interface SceneClock {
	readonly paused_ms: number;
	readonly still_since: number | null;
}

export const START_CLOCK: SceneClock = Object.freeze({
	paused_ms: 0,
	still_since: null,
});

export function sceneNow(c: SceneClock, wall: number): number {
	return (c.still_since ?? wall) - c.paused_ms;
}

export function setStill(
	c: SceneClock,
	still: boolean,
	wall: number,
): SceneClock {
	if (still && c.still_since === null) return { ...c, still_since: wall };
	if (!still && c.still_since !== null)
		return {
			paused_ms: c.paused_ms + Math.max(0, wall - c.still_since),
			still_since: null,
		};
	return c;
}
