// Decision D3: a 결재 visit, its knock and the border colour start only once the state has lasted 60 s,
// so the owner running goal → plan → approve on the Mac is not knocked at every step. Reports are not
// held back. Fake clock throughout.
import { describe, expect, test } from "bun:test";
import { ev, iso, machine, run, runIn, screen, T0 } from "./fixtures.ts";
import { toVillageModel } from "./model.ts";

const machines = [machine("online")];
const base = { machines, districts: {}, eventsByRun: new Map() };
const S = 1_000;
/** The fixture clock is 05:00 in the test time zone (UTC), inside the default quiet hours. */
const LOUD = "?quiet=off";

/** The same run, in a state that began at T0 + `atMs`. */
const waitingAt = (atMs: number, reason = "AWAITING_PLAN_APPROVAL") =>
	runIn("waiting_owner", {
		reason,
		status: "READY",
		last_progress_at: iso(atMs),
	});
const holdAt = (atMs: number) =>
	runIn("hold", {
		status: "HOLD",
		reason: "MODEL_CHAIN_EXHAUSTED",
		alert: "MODEL_CHAIN_EXHAUSTED",
		last_progress_at: iso(atMs),
	});
const running = () => run({ last_progress_at: iso(-30 * S) });

describe("D3 · 60 s before a 결재 visit, knock or border", () => {
	test("under 60 s: no visit, no border, no knock, the sentence stays 전부 정상", () => {
		const s = screen(LOUD);
		s.step(T0, { ...base, runs: [running()] });
		// the run turns to waiting_owner at T0 + 10 s
		for (const t of [10, 11, 30, 69]) {
			const { model, cues } = s.step(T0 + 10 * S + (t - 10) * S, {
				...base,
				runs: [waitingAt(10 * S)],
			});
			expect(model.visits).toEqual([]);
			expect(model.status.border).toBe("none");
			expect(model.status.sentence).toBe("전부 정상");
			expect(model.marks.waiting).toEqual([]);
			expect(model.village.shown[0]?.waiting).toBe(0); // no flag yet
			expect(cues).toEqual([]);
		}
	});

	test("at 60 s: the visit, the yellow border and one knock start together", () => {
		const s = screen(LOUD);
		s.step(T0, { ...base, runs: [running()] });
		s.step(T0 + 10 * S, { ...base, runs: [waitingAt(10 * S)] });
		s.step(T0 + 69 * S, { ...base, runs: [waitingAt(10 * S)] });
		const { model, cues } = s.step(T0 + 70 * S, {
			...base,
			runs: [waitingAt(10 * S)],
		});
		expect(model.visits.map((v) => v.kind)).toEqual(["sign"]);
		expect(model.visits[0]?.since).toBe(iso(10 * S));
		expect(model.status.border).toBe("yellow");
		expect(model.status.sentence).toBe("결재 1건");
		expect(cues).toEqual(["knock"]);
		// and not again on the next tick
		expect(
			s.step(T0 + 71 * S, { ...base, runs: [waitingAt(10 * S)] }).cues,
		).toEqual([]);
	});

	test("resolved within 60 s: nothing at all happens", () => {
		const s = screen(LOUD);
		const seen: string[] = [];
		s.step(T0, { ...base, runs: [running()] });
		for (let t = 10; t <= 50; t += 1) {
			const r = s.step(T0 + t * S, { ...base, runs: [waitingAt(10 * S)] });
			seen.push(...r.cues, r.model.status.border, `${r.model.visits.length}`);
		}
		for (let t = 51; t <= 200; t += 1) {
			const r = s.step(T0 + t * S, {
				...base,
				runs: [run({ last_progress_at: iso(51 * S) })],
			});
			seen.push(...r.cues, r.model.status.border, `${r.model.visits.length}`);
		}
		expect(new Set(seen)).toEqual(new Set(["none", "0"]));
	});

	test("goal → plan → approve in quick steps: a new code restarts the 60 s, so no step knocks", () => {
		const s = screen(LOUD);
		s.step(T0, { ...base, runs: [running()] });
		const steps: [number, string][] = [
			[10, "GOAL_RECORDED"],
			[40, "AWAITING_PLAN_APPROVAL"],
			[80, "PLAN_APPROVED"],
		];
		const cues: string[] = [];
		for (let t = 10; t < 120; t++) {
			const [at, reason] = [...steps].reverse().find(([a]) => a <= t) ?? [
				10,
				"GOAL_RECORDED",
			];
			const r = s.step(T0 + t * S, {
				...base,
				runs: [waitingAt(at * S, reason)],
			});
			cues.push(...r.cues);
			expect(r.model.visits).toEqual([]);
		}
		expect(cues).toEqual([]);
		// the last one has lasted 60 s at 140 s
		const r = s.step(T0 + 140 * S, {
			...base,
			runs: [waitingAt(80 * S, "PLAN_APPROVED")],
		});
		expect(r.model.visits).toHaveLength(1);
		expect(r.cues).toEqual(["knock"]);
	});

	test("a code change seen while the screen is open counts from when it was seen, even if Office's time is older", () => {
		const s = screen(LOUD);
		s.step(T0, { ...base, runs: [running()] });
		// reported late: the state began at T0 - 5 min by Office's clock
		const r1 = s.step(T0 + S, { ...base, runs: [waitingAt(-300 * S)] });
		expect(r1.model.visits).toEqual([]);
		const r2 = s.step(T0 + 61 * S, { ...base, runs: [waitingAt(-300 * S)] });
		expect(r2.model.visits).toHaveLength(1);
	});

	test("without last_progress_at the 60 s count from first sight (reported_at moves every report)", () => {
		const s = screen(LOUD);
		const r = (reportedMs: number) =>
			runIn("waiting_owner", {
				reason: "AWAITING_PLAN_APPROVAL",
				last_progress_at: null,
				reported_at: iso(reportedMs),
			});
		expect(s.step(T0, { ...base, runs: [r(0)] }).model.visits).toEqual([]);
		expect(
			s.step(T0 + 30 * S, { ...base, runs: [r(30 * S)] }).model.visits,
		).toEqual([]);
		const at60 = s.step(T0 + 60 * S, { ...base, runs: [r(60 * S)] });
		expect(at60.model.visits).toHaveLength(1);
		expect(at60.model.visits[0]?.since).toBe(iso(0));
	});

	test("a screen opened on a run that has waited for an hour shows it at once (Office's time)", () => {
		const s = screen(LOUD);
		const r = s.step(T0, { ...base, runs: [waitingAt(-3_600 * S)] });
		expect(r.model.visits).toHaveLength(1);
		expect(r.model.status.border).toBe("yellow");
		expect(r.cues).toEqual([]); // the first look never sounds
	});

	test("멈춤 too: no red border or low tone before 60 s; both at 60 s", () => {
		const s = screen(LOUD);
		s.step(T0, { ...base, runs: [running()] });
		s.step(T0 + 10 * S, { ...base, runs: [holdAt(10 * S)] });
		const before = s.step(T0 + 69 * S, { ...base, runs: [holdAt(10 * S)] });
		expect(before.model.status.border).toBe("none");
		expect(before.model.visits).toEqual([]);
		expect(before.cues).toEqual([]);
		const at = s.step(T0 + 70 * S, { ...base, runs: [holdAt(10 * S)] });
		expect(at.model.status.border).toBe("red");
		expect(at.model.visits[0]?.carry).toBe("binder");
		expect(at.cues).toEqual(["low"]);
	});

	test("reports are not held back: a task finished 10 s ago is at the door now", () => {
		const r = run({ last_progress_at: iso(-10 * S) });
		const m = toVillageModel({
			...base,
			runs: [r],
			eventsByRun: new Map([
				["cockpit:demo-flow-1", [ev({ occurred_at: iso(-10 * S) })]],
			]),
			now: T0,
			conn: "open",
		});
		expect(m.door?.kind).toBe("report");
	});
});
