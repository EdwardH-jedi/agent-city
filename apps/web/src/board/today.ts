// The top band's clock and today's summary (17 §2). Pure: the board passes the sessions and runs useHub
// already holds (nothing more is fetched) and the time; this module only counts and formats.
//
// - Clock: this device's local time, 24 h, no seconds (`10:47`), and the date beside it (`11월 13일 금`).
//   It is redrawn only when the minute changes (`minuteKey`, `msToNextMinute`).
// - `세션 N`: sessions whose last activity is after local midnight.
// - `토큰 203k`: the sum of `tokens_today` over the runs reported today. Only what Office signed in its
//   run reports: not the whole usage. `+` when any of them says usage_unknown; no figure at all → no cell.
// - A band too narrow for one line hides the date, then the tokens, then the sessions (`TOP_FOLD`).

import type { RunView, Session } from "@agent-city/schema";

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

export interface TokensToday {
	total: number;
	/** A run reported today says its usage is unknown: the figure is a floor (`203k+`). */
	floor: boolean;
}

/**
 * The sum of `tokens_today` over the runs reported today (a run last reported yesterday carries
 * yesterday's figure). Null when none of them has a figure: the cell is not drawn.
 */
export function tokensToday(
	runs: readonly Pick<
		RunView,
		"tokens_today" | "usage_unknown" | "reported_at"
	>[],
	now: number,
): TokensToday | null {
	const t = localMidnight(now);
	let total = 0;
	let any = false;
	let floor = false;
	for (const r of runs) {
		if (!after(r.reported_at, t)) continue;
		if (r.usage_unknown) floor = true;
		if (typeof r.tokens_today === "number" && Number.isFinite(r.tokens_today)) {
			total += Math.max(0, r.tokens_today);
			any = true;
		}
	}
	return any ? { total, floor } : null;
}

/** `950`, `12k`, `203k`, `1.2M`, `34M` (+ when a floor). */
export function tokensText(t: TokensToday): string {
	const n = t.total;
	let s: string;
	if (n < 1000) s = String(Math.round(n));
	else if (n < 999_500) s = `${Math.round(n / 1000)}k`;
	else if (n < 9_950_000)
		s = `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	else s = `${Math.round(n / 1_000_000)}M`;
	return t.floor ? `${s}+` : s;
}

/** What a narrow band hides, in order (17 §2): the date first, then the tokens, then the sessions. */
export const TOP_FOLD = ["date", "tokens", "sessions"] as const;
export type TopPart = (typeof TOP_FOLD)[number];

/** The parts hidden at fold level `n` (0 = none, 3 = all three). */
export function hiddenAt(n: number): ReadonlySet<TopPart> {
	const k = Math.max(0, Math.min(TOP_FOLD.length, Math.floor(n || 0)));
	return new Set(TOP_FOLD.slice(0, k));
}
