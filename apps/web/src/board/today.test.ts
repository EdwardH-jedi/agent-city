import { describe, expect, test } from "bun:test";
import {
	clockText,
	dateText,
	hiddenAt,
	localMidnight,
	minuteKey,
	msToNextMinute,
	sessionsToday,
	TOP_FOLD,
	tokensText,
	tokensToday,
} from "./today.ts";

// local wall-clock times (the screen shows the device's local time; these are TZ-independent)
const at = (h: number, m: number, s = 0, ms = 0, day = 13) =>
	new Date(2026, 10, day, h, m, s, ms).getTime();
const iso = (t: number) => new Date(t).toISOString();

describe("clock (17 §2)", () => {
	test("24-hour, no seconds, zero-padded", () => {
		expect(clockText(at(10, 47, 59))).toBe("10:47");
		expect(clockText(at(0, 5))).toBe("00:05");
		expect(clockText(at(23, 59, 59, 999))).toBe("23:59");
	});
	test("the date: month, day and the weekday in one letter", () => {
		expect(dateText(at(10, 47))).toBe("11월 13일 금");
		expect(dateText(at(10, 47, 0, 0, 15))).toBe("11월 15일 일");
	});
	test("redrawn only when the minute changes: the key is equal within a minute and differs across it", () => {
		expect(minuteKey(at(10, 47, 0))).toBe(minuteKey(at(10, 47, 59, 999)));
		expect(minuteKey(at(10, 47, 59, 999))).not.toBe(minuteKey(at(10, 48)));
		// the same minute on another day is another key
		expect(minuteKey(at(10, 47))).not.toBe(minuteKey(at(10, 47, 0, 0, 14)));
	});
	test("the timer waits for the next :00", () => {
		expect(msToNextMinute(at(10, 47, 0))).toBe(60_000);
		expect(msToNextMinute(at(10, 47, 30))).toBe(30_000);
		expect(msToNextMinute(at(10, 47, 59, 999))).toBe(1);
		// never past, never more than a minute, whatever the zone does (the DST fall-back hour included)
		for (let t = at(0, 0); t < at(0, 0) + 3 * 3_600_000; t += 7_919) {
			const d = msToNextMinute(t);
			expect(d >= 1 && d <= 60_000).toBe(true);
			expect(new Date(t + d).getSeconds()).toBe(0);
		}
		expect(msToNextMinute(at(23, 59, 30))).toBe(30_000); // across midnight
		const t = at(10, 47, 12, 345);
		expect(minuteKey(t + msToNextMinute(t))).not.toBe(minuteKey(t));
		expect(minuteKey(t + msToNextMinute(t) - 1)).toBe(minuteKey(t));
	});
});

describe("세션 N: sessions active today (17 §2)", () => {
	test("counts last activity at or after local midnight; yesterday's do not count", () => {
		const now = at(10, 47);
		const s = (t: number) => ({ last_event_at: iso(t) });
		expect(
			sessionsToday(
				[
					s(at(10, 40)),
					s(at(0, 0)), // midnight itself is today
					s(localMidnight(now) - 1), // 23:59:59.999 yesterday
					s(at(22, 0, 0, 0, 12)),
				],
				now,
			),
		).toBe(2);
	});
	test("just after midnight only the new day's count", () => {
		const now = at(0, 1);
		expect(
			sessionsToday(
				[
					{ last_event_at: iso(at(23, 58, 0, 0, 12)) },
					{ last_event_at: iso(at(0, 0, 30)) },
				],
				now,
			),
		).toBe(1);
	});
	test("junk timestamps do not count", () => {
		expect(sessionsToday([{ last_event_at: "nope" }], at(10, 0))).toBe(0);
		expect(sessionsToday([], at(10, 0))).toBe(0);
	});
});

describe("토큰: the runs' tokens_today (17 §2)", () => {
	const now = at(10, 47);
	const run = (
		tokens: number | null,
		unknown = false,
		reported = at(10, 40),
	) => ({
		tokens_today: tokens,
		usage_unknown: unknown,
		reported_at: iso(reported),
	});
	test("sums the runs reported today", () => {
		expect(tokensToday([run(120_000), run(83_000)], now)).toEqual({
			total: 203_000,
			floor: false,
		});
		expect(tokensText({ total: 203_000, floor: false })).toBe("203k");
	});
	test("usage_unknown on any run: a floor, `203k+`", () => {
		const t = tokensToday([run(120_000), run(83_000), run(null, true)], now);
		expect(t).toEqual({ total: 203_000, floor: true });
		expect(t && tokensText(t)).toBe("203k+");
	});
	test("no figure at all: no cell (null), even with usage_unknown", () => {
		expect(tokensToday([], now)).toBeNull();
		expect(tokensToday([run(null), run(null, true)], now)).toBeNull();
	});
	test("a run last reported before midnight carries yesterday's figure: left out", () => {
		expect(
			tokensToday([run(50_000, false, at(23, 0, 0, 0, 12)), run(7_000)], now),
		).toEqual({ total: 7_000, floor: false });
		expect(
			tokensToday([run(50_000, true, at(23, 0, 0, 0, 12))], now),
		).toBeNull();
	});
	test("figures: k under a million, M above", () => {
		const f = (n: number) => tokensText({ total: n, floor: false });
		expect(f(0)).toBe("0");
		expect(f(950)).toBe("950");
		expect(f(12_400)).toBe("12k");
		expect(f(999_400)).toBe("999k");
		expect(f(999_600)).toBe("1M");
		expect(f(1_240_000)).toBe("1.2M");
		expect(f(34_000_000)).toBe("34M");
	});
});

describe("a narrow band folds (17 §2)", () => {
	test("hides the date, then the tokens, then the sessions", () => {
		expect(TOP_FOLD).toEqual(["date", "tokens", "sessions"]);
		expect([...hiddenAt(0)]).toEqual([]);
		expect([...hiddenAt(1)]).toEqual(["date"]);
		expect([...hiddenAt(2)]).toEqual(["date", "tokens"]);
		expect([...hiddenAt(3)]).toEqual(["date", "tokens", "sessions"]);
		expect([...hiddenAt(9)]).toEqual(["date", "tokens", "sessions"]);
		expect([...hiddenAt(-1)]).toEqual([]);
	});
});
