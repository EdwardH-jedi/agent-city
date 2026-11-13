// The top band's clock and today's summary (17 §2). Pure: the board passes the sessions and runs useHub
// already holds (nothing more is fetched) and the time; this module only counts and formats.
//
// - Clock: this device's local time, 24 h, no seconds (`10:47`), and the date beside it (`11월 13일 금`).
//   It is redrawn only when the minute changes (`minuteKey`, `msToNextMinute`).
// - `세션 N`: sessions whose last activity is after local midnight.
// - `토큰 3.9M`: today's whole token usage (board/usage.ts, 18 §5 U3); no usage today → no cell.
// - A band too narrow for one line hides the date, then the tokens, then the sessions (`TOP_FOLD`).

import type { Session } from "@agent-city/schema";

const DAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

const two = (n: number): string => String(n).padStart(2, "0");

/** `10:47`: local, 24-hour, no seconds. */
export function clockText(now: number): string {
	const d = new Date(now);
	return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** `11월 13일 금`: local. */
export function dateText(now: number): string {
	const d = new Date(now);
	return `${d.getMonth() + 1}월 ${d.getDate()}일 ${DAYS[d.getDay()]}`;
}

/** Changes exactly when the local minute does (the clock redraws only then). */
export function minuteKey(now: number): string {
	const d = new Date(now);
	return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${clockText(now)}`;
}

/**
 * Milliseconds until the next minute begins (1..60 000). Every zone offset in use is whole minutes, so the
 * local minute turns when epoch ms does; this stays right in the repeated hour when daylight saving ends
 * (a local-calendar `minute + 1` resolves to the first pass there and would be an hour in the past).
 */
export function msToNextMinute(now: number): number {
	const r = ((now % 60_000) + 60_000) % 60_000;
	return 60_000 - r;
}

/** Local midnight of the day `now` falls in (ms). */
export function localMidnight(now: number): number {
	const d = new Date(now);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const after = (iso: string | null | undefined, t: number): boolean => {
	if (!iso) return false;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) && ms >= t;
};

/** `세션 N`: sessions whose last activity is today (local midnight or later). */
export function sessionsToday(
	sessions: readonly Pick<Session, "last_event_at">[],
	now: number,
): number {
	const t = localMidnight(now);
	return sessions.filter((s) => after(s.last_event_at, t)).length;
}

/** What a narrow band hides, in order (17 §2): the date first, then the tokens, then the sessions. */
export const TOP_FOLD = ["date", "tokens", "sessions"] as const;
export type TopPart = (typeof TOP_FOLD)[number];

/** The parts hidden at fold level `n` (0 = none, 3 = all three). */
export function hiddenAt(n: number): ReadonlySet<TopPart> {
	const k = Math.max(0, Math.min(TOP_FOLD.length, Math.floor(n || 0)));
	return new Set(TOP_FOLD.slice(0, k));
}
