// CEO document visits (pure scheduler; no three, no DOM, no callbacks).
//
// Rules (CAMPUS_MILESTONE, Worker B):
// - one visit per pending request, keyed by its stable `request_id`;
// - re-polling with the same ids returns the SAME book (no restart, no second figure);
// - a request that leaves the pending list (decided, invalidated, superseded, removed) ends its
//   visit at once;
// - progress is anchored to the request's `created_at`, clamped to [0, MAX_HEAD_START_MS] at first
//   sight, so a remount mid-walk resumes instead of replaying and clock skew cannot park a figure;
// - reduced motion → every visit is already arrived;
// - arrival is a pose, nothing else: this module has no way to emit anything.
import type { CampusPendingRequest } from "./presentation.ts";

export const MAX_HEAD_START_MS = 60_000;
/** Walking speed between buildings (prototype: 7.2; slower reads calmer in a small pane). */
export const WALK_SPEED = 4.2;
export const MIN_WALK_MS = 7_000;
export const MAX_WALK_MS = 20_000;

export interface Visit {
	readonly request_id: string;
	readonly kind: CampusPendingRequest["kind"];
	readonly repo_id: string;
	/** Lobby seat at Headquarters; the lowest free seat when the visit began, never reassigned. */
	readonly seat: number;
	/** Scheduler clock (ms) when the request was first seen. */
	readonly seen_at: number;
	/** How far into the walk the visit already was when first seen. */
	readonly head_start_ms: number;
}

export interface VisitBook {
	/** Ordered by seat. */
	readonly visits: readonly Visit[];
}

export const EMPTY_BOOK: VisitBook = Object.freeze({
	visits: Object.freeze([]),
});

export type PendingLike = Pick<
	CampusPendingRequest,
	"request_id" | "kind" | "repo_id" | "created_at"
>;

function headStart(createdAt: string, now: number): number {
	const t = Date.parse(createdAt);
	if (!Number.isFinite(t)) return 0;
	return Math.min(MAX_HEAD_START_MS, Math.max(0, now - t));
}

/** Pending list → visits. Returns `book` itself when nothing changed. */
export function reconcileVisits(
	book: VisitBook,
	pending: readonly PendingLike[],
	now: number,
): VisitBook {
	const wanted = new Map<string, PendingLike>();
	for (const p of pending)
		if (!wanted.has(p.request_id)) wanted.set(p.request_id, p);

	let changed = false;
	const kept: Visit[] = [];
	for (const v of book.visits) {
		const p = wanted.get(v.request_id);
		if (!p) {
			changed = true; // ended: decided, invalidated, superseded or removed
			continue;
		}
		if (p.kind !== v.kind || p.repo_id !== v.repo_id) {
			changed = true;
			kept.push({ ...v, kind: p.kind, repo_id: p.repo_id });
		} else kept.push(v);
		wanted.delete(v.request_id);
	}
	if (wanted.size === 0 && !changed) return book;

	const fresh = [...wanted.values()].sort((a, b) =>
		a.created_at === b.created_at
			? a.request_id < b.request_id
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
			request_id: p.request_id,
			kind: p.kind,
			repo_id: p.repo_id,
			seat: next,
			seen_at: now,
			head_start_ms: headStart(p.created_at, now),
		};
	});
	const visits = [...kept, ...added].sort((a, b) => a.seat - b.seat);
	return Object.freeze({ visits: Object.freeze(visits) });
}

export function walkDurationMs(routeLength: number): number {
	const ms = (routeLength / WALK_SPEED) * 1000;
	return Math.min(MAX_WALK_MS, Math.max(MIN_WALK_MS, ms));
}

/** 0 = leaving the office, 1 = arrived at Headquarters. */
export function visitProgress(
	v: Visit,
	now: number,
	walkMs: number,
	reducedMotion: boolean,
): number {
	if (reducedMotion || walkMs <= 0) return 1;
	const t = (v.head_start_ms + Math.max(0, now - v.seen_at)) / walkMs;
	if (t >= 1) return 1;
	return t <= 0 ? 0 : t;
}

export function anyWalking(
	book: VisitBook,
	now: number,
	walkMsOf: (v: Visit) => number,
	reducedMotion: boolean,
): boolean {
	if (reducedMotion) return false;
	return book.visits.some((v) => visitProgress(v, now, walkMsOf(v), false) < 1);
}
