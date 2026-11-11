// 07 §7 + 08 §3 Q4: while the cockpit is not reporting, the whole village stands still — run visits,
// session visits, the knock and the border colour. Nothing new starts, nothing that was there leaves
// because time passed, nothing sounds. When the Mac is back, a 60 s count that had not finished starts
// again from zero. Fake clock; machine liveness is derived from the heartbeat as the hub does.
import { describe, expect, test } from "bun:test";
import { machineStatus } from "@agent-city/schema";
import { run, runIn, screen, session, T0 } from "./fixtures.ts";

const S = 1_000;
/** The fixture clock is 05:00 in the test time zone (UTC), inside the default quiet hours. */
const LOUD = "?quiet=off";
const at = (sec: number) => new Date(T0 + sec * S).toISOString();

/** The cockpit beats every 5 s while `beating(t)`; otherwise its last beat stands. */
function cockpitAt(sec: number, lastBeat: (sec: number) => number) {
	const beat = at(lastBeat(sec));
	return [
		{
			id: "cockpit" as const,
			hostname: null,
			heartbeat_at: beat,
			interval_s: 30,
			status: machineStatus(beat, new Date(T0 + sec * S)),
		},
	];
}

/** Beats until `stop` s, silent until `back` s, beating again after. */
const gap = (stop: number, back: number) => (sec: number) =>
	sec < stop ? sec - (sec % 5) : sec < back ? stop : sec - (sec % 5);

const waitingSince = (sec: number) =>
	runIn("waiting_owner", {
		reason: "AWAITING_PLAN_APPROVAL",
		status: "READY",
		last_progress_at: at(sec),
	});
const holdSince = (sec: number) =>
	runIn("hold", {
		status: "HOLD",
		reason: "MODEL_CHAIN_EXHAUSTED",
		alert: "MODEL_CHAIN_EXHAUSTED",
		last_progress_at: at(sec),
	});
const running = () => run({ last_progress_at: at(-30) });

interface Tick {
	sec: number;
	visits: string[];
	border: string;
	dim: boolean;
	cues: string[];
}

/** Tick once a second from 0 to `end` s, like Board.tsx. */
function drive(
	beat: (sec: number) => number,
	end: number,
	data: (sec: number) => {
		runs?: ReturnType<typeof run>[];
		sessions?: ReturnType<typeof session>[];
	},
): Tick[] {
	const s = screen(LOUD);
	const out: Tick[] = [];
	for (let sec = 0; sec <= end; sec++) {
		const d = data(sec);
		const r = s.step(T0 + sec * S, {
			runs: d.runs ?? [],
			sessions: d.sessions ?? [],
			machines: cockpitAt(sec, beat),
			districts: {},
			eventsByRun: new Map(),
		});
		out.push({
			sec,
			visits: r.model.visits.map((v) => v.id),
			border: r.model.status.border,
			dim: r.model.status.dim,
			cues: r.cues,
		});
	}
	return out;
}

const between = (ticks: Tick[], from: number, to: number) =>
	ticks.filter((t) => t.sec >= from && t.sec < to);
const cuesOf = (ticks: Tick[]) =>
	ticks.flatMap((t) => t.cues.map((c) => `${t.sec}:${c}`));

// the cockpit's last beat is at 50 s; it stops counting as online at 140 s; it beats again at 1000 s
const BEAT = gap(51, 1000);
const HELD = 140;
const BACK = 1000;

describe("07 §7 / Q4: cockpit not reporting → the village stands still", () => {
	test("a run whose 60 s had not finished: no visit, border or knock while quiet; 60 s after the Mac is back", () => {
		const ticks = drive(BEAT, 1100, (sec) => ({
			runs: [sec < 100 ? running() : waitingSince(100)],
		}));
		for (const t of between(ticks, 0, BACK + 60)) {
			expect({ sec: t.sec, visits: t.visits, border: t.border }).toEqual({
				sec: t.sec,
				visits: [],
				border: "none",
			});
		}
		expect(between(ticks, HELD + 1, BACK).every((t) => t.dim)).toBe(true);
		const back = ticks.find((t) => t.sec === BACK + 60);
		expect(back?.visits).toEqual(["cockpit:demo-flow-1"]);
		expect(back?.border).toBe("yellow");
		expect(cuesOf(ticks)).toEqual([`${BACK + 60}:knock`]);
	});

	test("a visit that was there stays (border too), silently; no knock again when the Mac is back", () => {
		const ticks = drive(BEAT, 1100, () => ({ runs: [waitingSince(-120)] }));
		for (const t of between(ticks, 0, 1100)) {
			expect(t.visits).toEqual(["cockpit:demo-flow-1"]);
			expect(t.border).toBe("yellow");
		}
		// the first look never sounds, and nothing new happened since
		expect(cuesOf(ticks)).toEqual([]);
	});

	test("a run that turns to 결재 while the Mac is quiet (the exporter still reports): nothing until 60 s after it is back", () => {
		const ticks = drive(BEAT, 1100, (sec) => ({
			runs: [sec < 300 ? running() : waitingSince(300)],
		}));
		expect(
			between(ticks, 0, BACK + 60).every((t) => t.visits.length === 0),
		).toBe(true);
		expect(ticks.find((t) => t.sec === BACK + 60)?.visits).toHaveLength(1);
		expect(cuesOf(ticks)).toEqual([`${BACK + 60}:knock`]);
	});

	test("멈춤 too: no red border or low tone while quiet; both 60 s after the Mac is back", () => {
		const ticks = drive(BEAT, 1100, (sec) => ({
			runs: [sec < 100 ? running() : holdSince(100)],
		}));
		expect(between(ticks, 0, BACK + 60).every((t) => t.border === "none")).toBe(
			true,
		);
		expect(ticks.find((t) => t.sec === BACK + 60)?.border).toBe("red");
		expect(cuesOf(ticks)).toEqual([`${BACK + 60}:low`]);
	});

	test("a session waiting since just before the quiet: no visit while quiet; 60 s after the Mac is back, one knock", () => {
		const ticks = drive(BEAT, 1100, (sec) => ({
			sessions: [
				sec < 100
					? session({ status: "active", last_event_at: at(sec) })
					: session({ status: "waiting", last_event_at: at(100) }),
			],
		}));
		expect(
			between(ticks, 0, BACK + 60).every((t) => t.visits.length === 0),
		).toBe(true);
		expect(ticks.find((t) => t.sec === BACK + 60)?.visits).toEqual([
			"session:claude:fake-session-1",
		]);
		expect(cuesOf(ticks)).toEqual([`${BACK + 60}:knock`]);
	});

	test("a session visit that was there stays while quiet, even past its 30 minutes", () => {
		// quiet from 140 s for an hour: the 30 min (from 0 s) would have run out at 1800 s
		const ticks = drive(gap(51, 4000), 3900, () => ({
			sessions: [session({ status: "waiting", last_event_at: at(0) })],
		}));
		for (const t of between(ticks, 60, 3900))
			expect(t.visits).toEqual(["session:claude:fake-session-1"]);
		expect(cuesOf(ticks)).toEqual(["60:knock"]);
	});

	test("the stale boundary: a count that reaches 60 s exactly when the cockpit turns stale does not mature", () => {
		// last beat 0 s → stale from 90 s; a session waiting since 30 s would reach 60 s at 90 s
		const ticks = drive(
			(sec) => (sec < 1000 ? 0 : sec - (sec % 5)),
			1100,
			(sec) => ({
				sessions: [
					sec < 30
						? session({ status: "active", last_event_at: at(sec) })
						: session({ status: "waiting", last_event_at: at(30) }),
				],
			}),
		);
		expect(between(ticks, 0, 1060).every((t) => t.visits.length === 0)).toBe(
			true,
		);
		expect(cuesOf(ticks)).toEqual(["1060:knock"]);
	});

	test("a quiet spell that falls between two ticks still restarts the count", () => {
		// ticks every 10 s; the cockpit's beats jump from 0 s to 100 s (stale 90–100 s, between ticks)
		const s = screen(LOUD);
		const tick = (sec: number, beat: number) =>
			s.step(T0 + sec * S, {
				runs: [sec < 40 ? running() : waitingSince(40)],
				machines: [
					{
						id: "cockpit" as const,
						hostname: null,
						heartbeat_at: at(beat),
						interval_s: 30,
						status: machineStatus(at(beat), new Date(T0 + sec * S)),
					},
				],
				districts: {},
				eventsByRun: new Map(),
			}).model.visits.length;
		expect([tick(0, 0), tick(40, 0), tick(80, 0)]).toEqual([0, 0, 0]);
		// back at 100 s: the count that began at 40 s starts again → no visit at 100 s, one at 160 s
		expect(tick(100, 100)).toBe(0);
		expect(tick(150, 150)).toBe(0);
		expect(tick(160, 160)).toBe(1);
	});

	test("opened while the Mac is quiet: a 결재 that had lasted 60 s before it went quiet is there", () => {
		const s = screen(LOUD);
		const r = s.step(T0 + 700 * S, {
			runs: [waitingSince(-120)],
			machines: cockpitAt(700, () => 0),
			districts: {},
			eventsByRun: new Map(),
		});
		expect(r.model.visits.map((v) => v.id)).toEqual(["cockpit:demo-flow-1"]);
		expect(r.model.status.border).toBe("yellow");
	});

	test("matured between the last online tick and the first quiet one: it keeps its visit", () => {
		// ticks at 0, 88, 91: the 결재 since 29 s reaches 60 s at 89 s; stale from 90 s (last beat 0 s)
		const s = screen(LOUD);
		const step = (sec: number) =>
			s.step(T0 + sec * S, {
				runs: [waitingSince(29)],
				machines: cockpitAt(sec, () => 0),
				districts: {},
				eventsByRun: new Map(),
			}).model.visits.length;
		expect([step(0), step(88), step(91), step(500)]).toEqual([0, 0, 1, 1]);
	});

	test("a new code for the same 결재 while the Mac is quiet keeps the visit and the border", () => {
		const s = screen(LOUD);
		const step = (sec: number, reason: string) =>
			s.step(T0 + sec * S, {
				runs: [waitingSince(-120)].map((r) => ({ ...r, reason })),
				machines: cockpitAt(sec, gap(51, 2000)),
				districts: {},
				eventsByRun: new Map(),
			}).model;
		expect(step(0, "AWAITING_PLAN_APPROVAL").visits).toHaveLength(1);
		const quietNew = step(300, "PLAN_APPROVED");
		expect(quietNew.visits).toHaveLength(1);
		expect(quietNew.status.border).toBe("yellow");
	});

	test("the 3D lead sets off when the restarted count is done, not when the wait began", async () => {
		const { toCampusModel } = await import("../campus/presentation.ts");
		const s = screen(LOUD);
		let last: ReturnType<typeof s.step> | null = null;
		for (let sec = 0; sec <= 1060; sec++)
			last = s.step(T0 + sec * S, {
				runs: [sec < 100 ? running() : waitingSince(100)],
				machines: cockpitAt(sec, BEAT),
				districts: {},
				eventsByRun: new Map(),
			});
		const v = last?.model.visits[0];
		expect(v?.since).toBe(at(100));
		expect(v?.starts).toBe(at(BACK + 60));
		expect(last && toCampusModel(last.model).visitors[0]?.created_at).toBe(
			at(BACK + 60),
		);
	});
});
