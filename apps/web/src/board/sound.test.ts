import { describe, expect, test } from "bun:test";
import {
	isAudible,
	isQuiet,
	parseSoundPrefs,
	planSounds,
	REMIND_MS,
	SETTLE_MS,
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

describe("the sequence the board produces (no sound on load or reconnect)", () => {
	const T = 50_000_000;
	const full = { waiting: ["a"], stopped: ["b"], passed: ["c", "d"] };
	test("empty while the snapshot is loading, then everything arrives: silent", () => {
		let r = planSounds(null, none, T, false); // not loaded yet
		r = planSounds(r.memory, none, T + 1000, false);
		// the screen is now connected and loaded; the data lands in the same tick
		const landed = planSounds(r.memory, full, T + 2000, true);
		expect(landed.cues).toEqual([]);
		// the window runs from the last silent tick (T+1000): later arrivals inside it are absorbed too
		const more = planSounds(
			landed.memory,
			{ ...full, passed: ["c", "d", "e"] },
			T + 1000 + SETTLE_MS - 1,
			true,
		);
		expect(more.cues).toEqual([]);
	});
	test("after settling, a genuinely new 결재 knocks", () => {
		const r0 = planSounds(null, none, T, false);
		const r1 = planSounds(r0.memory, full, T + 1000, true);
		const later = T + 1000 + SETTLE_MS + 1;
		const r2 = planSounds(r1.memory, full, later, true);
		expect(r2.cues).toEqual([]);
		const r3 = planSounds(
			r2.memory,
			{ ...full, waiting: ["a", "z"] },
			later + 1000,
			true,
		);
		expect(r3.cues).toEqual(["knock"]);
	});
	test("a reconnect (conn open before the snapshot lands) does not sound what was missed", () => {
		const live = planSounds(
			mem({ settleUntil: 0, lastKnockAt: T }),
			none,
			T,
			true,
		);
		const down = planSounds(live.memory, none, T + 10_000, false);
		const open = planSounds(
			down.memory,
			{ ...none, stopped: ["x"], passed: ["y"] },
			T + 11_000,
			true,
		);
		expect(open.cues).toEqual([]);
	});
});
