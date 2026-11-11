import { describe, expect, test } from "bun:test";
import {
	isAudible,
	isQuiet,
	parseSoundPrefs,
	planSounds,
	REMIND_MS,
	type SoundMemory,
} from "./sound.ts";

const at = (h: number, m = 0) => new Date(2026, 10, 11, h, m);
const none = { waiting: [], stopped: [], passed: [] };
const mem = (over: Partial<SoundMemory> = {}): SoundMemory => ({
	...none,
	lastKnockAt: 0,
	...over,
});

describe("quiet hours", () => {
	const prefs = parseSoundPrefs("");
	test("default 23:00–08:00 wraps midnight", () => {
		expect(prefs.quiet).toEqual({ from: 23, to: 8 });
		for (const [h, m] of [
			[23, 0],
			[23, 59],
			[0, 0],
			[3, 30],
			[7, 59],
		] as const) {
			expect(isQuiet(prefs, at(h, m))).toBe(true);
		}
		for (const [h, m] of [
			[8, 0],
			[12, 0],
			[22, 59],
		] as const) {
			expect(isQuiet(prefs, at(h, m))).toBe(false);
		}
	});
	test("?quiet= changes the hours, ?quiet=off removes them, junk keeps the default", () => {
		expect(isQuiet(parseSoundPrefs("?quiet=9-17"), at(10))).toBe(true);
		expect(isQuiet(parseSoundPrefs("?quiet=9-17"), at(18))).toBe(false);
		expect(isQuiet(parseSoundPrefs("?quiet=off"), at(3))).toBe(false);
		expect(parseSoundPrefs("?quiet=abc").quiet).toEqual({ from: 23, to: 8 });
		expect(parseSoundPrefs("?quiet=5-5").quiet).toEqual({ from: 23, to: 8 });
	});
	test("?sound=off mutes everything", () => {
		const off = parseSoundPrefs("?sound=off");
		expect(
			isAudible({ prefs: off, date: at(12), cockpit: "online", conn: "open" }),
		).toBe(false);
	});
});

describe("when sound may play", () => {
	const prefs = parseSoundPrefs("");
	const ok = {
		prefs,
		date: at(12),
		cockpit: "online" as const,
		conn: "open" as const,
	};
	test("online, connected, daytime → audible", () => {
		expect(isAudible(ok)).toBe(true);
	});
	test("cockpit offline (or stale, or unobserved) → silent", () => {
		for (const cockpit of ["offline", "stale", "unobserved"] as const) {
			expect(isAudible({ ...ok, cockpit })).toBe(false);
		}
	});
	test("screen not connected to the hub → silent", () => {
		expect(isAudible({ ...ok, conn: "reconnecting" })).toBe(false);
	});
	test("quiet hours → silent", () => {
		expect(isAudible({ ...ok, date: at(2) })).toBe(false);
	});
});

describe("planSounds", () => {
	const T = 10_000_000;
	test("the first look plays nothing, whatever is already open", () => {
		const r = planSounds(
			null,
			{ ...none, waiting: ["a"], stopped: ["b"], passed: ["c"] },
			T,
			true,
		);
		expect(r.cues).toEqual([]);
		expect(r.memory.waiting).toEqual(["a"]);
	});
	test("a new 결재 knocks once; a new stop sounds low; a new finish is soft", () => {
		const prev = mem({ lastKnockAt: T });
		expect(
			planSounds(prev, { ...none, waiting: ["a", "b"] }, T + 1000, true).cues,
		).toEqual(["knock"]);
		expect(
			planSounds(prev, { ...none, stopped: ["a"] }, T + 1000, true).cues,
		).toEqual(["low"]);
		expect(
			planSounds(prev, { ...none, passed: ["a"] }, T + 1000, true).cues,
		).toEqual(["soft"]);
	});
	test("nothing new → nothing played", () => {
		const prev = mem({ waiting: ["a"], lastKnockAt: T });
		expect(
			planSounds(prev, { ...none, waiting: ["a"] }, T + 1000, true).cues,
		).toEqual([]);
	});
	test("a 결재 still open knocks once more every 30 minutes", () => {
		const prev = mem({ waiting: ["a"], lastKnockAt: T });
		const marks = { ...none, waiting: ["a"] };
		expect(planSounds(prev, marks, T + REMIND_MS - 1, true).cues).toEqual([]);
		const r = planSounds(prev, marks, T + REMIND_MS, true);
		expect(r.cues).toEqual(["knock"]);
		expect(r.memory.lastKnockAt).toBe(T + REMIND_MS);
	});
	test("while silent nothing plays, and what happened meanwhile is never played in a pile afterwards", () => {
		const prev = mem({ lastKnockAt: 0 });
		const during = planSounds(
			prev,
			{ ...none, waiting: ["a"], stopped: ["b"] },
			T,
			false,
		);
		expect(during.cues).toEqual([]);
		// back to audible: those two are already known, so no pile of sounds
		const after = planSounds(
			during.memory,
			{ ...none, waiting: ["a"], stopped: ["b"] },
			T + 5000,
			true,
		);
		expect(after.cues).toEqual([]);
	});
	test("silence also restarts the 30-minute reminder clock", () => {
		const during = planSounds(
			mem({ waiting: ["a"], lastKnockAt: 0 }),
			{ ...none, waiting: ["a"] },
			T,
			false,
		);
		expect(during.memory.lastKnockAt).toBe(T);
	});
});
