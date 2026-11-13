// The finish show's decisions (17 §3): which buildings fly a flag today, when confetti bursts, when the
// chime sounds. Only reads what visits.ts and incidents.ts already decided.
import { describe, expect, test } from "bun:test";
import { PASSED_TEXT } from "./copy.ts";
import {
	BURST_MS,
	burstsAt,
	type ChimeMemory,
	finishedToday,
	planChime,
	stepBursts,
} from "./done.ts";
import { runIn, T0 } from "./fixtures.ts";
import { parseSoundPrefs } from "./sound.ts";
import { localMidnight } from "./today.ts";
import { currentRuns } from "./types.ts";
import { buildVisits, emptyWatch, stepWatch, type Visit } from "./visits.ts";

const at = (ms: number) => new Date(ms).toISOString();
const passed = (project: string, progress: number) =>
	runIn("passed", {
		project,
		run_id: `${project}-1`,
		workflow_id: `${project}-flow`,
		status: "PASSED",
		phase: "Report",
		last_progress_at: at(progress),
	});

describe("flags: the buildings that finished today", () => {
	test("a run whose 전부 끝남 line is from today; yesterday's and other states do not count", () => {
		const mid = localMidnight(T0);
		const runs = [
			passed("o/today", mid + 60_000),
			passed("o/midnight", mid),
			passed("o/yesterday", mid - 1),
			runIn("running", { project: "o/running", run_id: "r", workflow_id: "r" }),
			runIn("partial", { project: "o/partial", run_id: "p", workflow_id: "p" }),
		];
		expect(finishedToday(runs, T0)).toEqual(["o/midnight", "o/today"]);
	});
	test("midnight takes them down: the same runs a day later have none", () => {
		const runs = [passed("o/today", T0 - 60_000)];
		expect(finishedToday(runs, T0)).toEqual(["o/today"]);
		expect(finishedToday(runs, localMidnight(T0) + 86_400_000 + 1)).toEqual([]);
	});
	test("the current run decides: a newer run of the same workflow that is running takes the flag down", () => {
		const old = passed("o/a", T0 - 3_600_000);
		const next = runIn("running", {
			project: "o/a",
			run_id: "o/a-2",
			workflow_id: "o/a-flow",
			last_progress_at: at(T0 - 60_000),
		});
		expect(finishedToday([old], T0)).toEqual(["o/a"]);
		expect(finishedToday([old, next], T0)).toEqual([]);
	});
});

/** Walk the watch over ticks the way the board does; returns the visits each tick. */
function ticks(states: { runs: ReturnType<typeof runIn>[]; now: number }[]) {
	let watch = emptyWatch();
	return states.map(({ runs, now }) => {
		const cur = currentRuns(runs);
		watch = stepWatch(watch, cur, now);
		return buildVisits(cur, new Map(), watch, now);
	});
}

describe("bursts: a new finish only", () => {
	const running = runIn("running", { project: "o/a" });
	const done = runIn("passed", { project: "o/a", status: "PASSED" });
	test("a run already finished when the screen opens never bursts (visits.ts only remembers it)", () => {
		const [first, second] = ticks([
			{ runs: [done], now: T0 },
			{ runs: [done], now: T0 + 1_000 },
		]);
		expect(burstsAt(first ?? [], T0, false)).toEqual([]);
		expect(burstsAt(second ?? [], T0 + 1_000, false)).toEqual([]);
	});
	test("a run seen to finish bursts once, for BURST_MS", () => {
		const v = ticks([
			{ runs: [running], now: T0 },
			{ runs: [done], now: T0 + 1_000 },
		])[1] as Visit[];
		expect(v.some((x) => x.text === PASSED_TEXT)).toBe(true);
		expect(burstsAt(v, T0 + 1_000, false)).toEqual([
			{ project_id: "o/a", at: at(T0 + 1_000) },
		]);
		expect(burstsAt(v, T0 + 1_000 + BURST_MS - 1, false)).toHaveLength(1);
		expect(burstsAt(v, T0 + 1_000 + BURST_MS, false)).toEqual([]);
	});
	test("reports cut: no burst", () => {
		const v = ticks([
			{ runs: [running], now: T0 },
			{ runs: [done], now: T0 + 1_000 },
		])[1] as Visit[];
		expect(burstsAt(v, T0 + 2_000, true)).toEqual([]);
	});
	test("once begun a burst flies its 20 s even when a newer report of the project takes the door", () => {
		const v = ticks([
			{ runs: [running], now: T0 },
			{ runs: [done], now: T0 + 1_000 },
		])[1] as Visit[];
		let mem = stepBursts([], v, T0 + 1_000);
		expect(mem).toHaveLength(1);
		mem = stepBursts(mem, [], T0 + 6_000); // the finish is no longer at the door
		expect(mem).toEqual([{ project_id: "o/a", at: at(T0 + 1_000) }]);
		expect(stepBursts(mem, [], T0 + 1_000 + BURST_MS)).toEqual([]);
		// the same finish seen again is not a second burst
		expect(stepBursts(mem, v, T0 + 7_000)).toHaveLength(1);
	});
	test("a task passing (T2 통과) is not a finish", () => {
		const t2: Visit = {
			id: "cockpit:x",
			kind: "report",
			project_id: "o/a",
			carry: null,
			text: "T2 통과했습니다. 다음으로 넘어갑니다.",
			code: null,
			since: at(T0),
			until: at(T0 + 300_000),
			closing: false,
			starts: at(T0),
		};
		expect(burstsAt([t2], T0 + 1_000, false)).toEqual([]);
	});
});

describe("the chime", () => {
	const finish = (id: string, since: number): Visit => ({
		id,
		kind: "report",
		project_id: id,
		carry: null,
		text: PASSED_TEXT,
		code: null,
		since: at(since),
		until: at(since + 300_000),
		closing: false,
		starts: at(since),
	});
	// noon local: not inside the default quiet hours (23–8)
	const noon = new Date(T0);
	noon.setHours(12, 0, 0, 0);
	const ctx = (over: Partial<Parameters<typeof planChime>[2]> = {}) => ({
		prefs: parseSoundPrefs(""),
		date: noon,
		cockpit: "online" as const,
		conn: "open" as const,
		settled: true,
		...over,
	});
	const t = noon.getTime();
	test("the first look only remembers (a finish already at the door makes no chime)", () => {
		const r = planChime(null, [finish("a", t)], ctx());
		expect(r.chime).toBe(false);
		expect(planChime(r.memory, [finish("a", t)], ctx()).chime).toBe(false);
	});
	test("a new finish chimes once; the next tick with the same finish does not", () => {
		const r1 = planChime({}, [finish("a", t)], ctx());
		expect(r1.chime).toBe(true);
		expect(planChime(r1.memory, [finish("a", t)], ctx()).chime).toBe(false);
	});
	test("a finish hidden at the door for a while and shown again does not chime again", () => {
		const r1 = planChime({}, [finish("a", t)], ctx());
		expect(r1.chime).toBe(true);
		const later = (ms: number) => {
			const d = new Date(noon);
			d.setTime(t + ms);
			return ctx({ date: d });
		};
		const hidden = planChime(r1.memory, [], later(30_000));
		expect(
			planChime(hidden.memory, [finish("a", t)], later(60_000)).chime,
		).toBe(false);
		// forgotten only after the report's stay is long over
		expect(
			Object.keys(planChime(hidden.memory, [], later(3_600_000)).memory),
		).toEqual([]);
	});
	test("two new finishes on one tick: one chime", () => {
		const r = planChime({}, [finish("a", t), finish("b", t)], ctx());
		expect(r.chime).toBe(true); // a boolean: at most one cue per tick
		expect(Object.keys(r.memory)).toHaveLength(2);
	});
	test("silent ticks spend it: quiet hours, sound=off, the Mac not reporting, reconnecting, the settle window", () => {
		const late = new Date(noon);
		late.setHours(23, 30, 0, 0);
		const silent: ReturnType<typeof ctx>[] = [
			ctx({ date: late }),
			ctx({ prefs: parseSoundPrefs("?sound=off") }),
			ctx({ cockpit: "stale" as never }),
			ctx({ conn: "reconnecting" as never }),
			ctx({ settled: false }),
		];
		for (const c of silent) {
			const r = planChime({}, [finish("a", t)], c);
			expect(r.chime).toBe(false);
			// not replayed once it may sound again
			expect(planChime(r.memory, [finish("a", t)], ctx()).chime).toBe(false);
		}
	});
	test("a closing report (on its way back) or another report is not a finish", () => {
		const closing = { ...finish("a", t), closing: true };
		const other = { ...finish("b", t), text: "Codex 리뷰에 들어갑니다." };
		const mem: ChimeMemory = {};
		expect(planChime(mem, [closing, other], ctx()).chime).toBe(false);
	});
});
