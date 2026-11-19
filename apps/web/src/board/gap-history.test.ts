// N12: a screen opened (or reloaded) after the Mac was quiet counts the 60 s rule (D3) the way a screen that
// stayed open through the quiet spell did. The hub's completed gaps (`recent_gaps`) stand in for the ticks the
// new screen did not see. Differential: every check compares a fresh screen against one that watched the gap.
// Fake clock; machines are derived from the heartbeat as the hub and Board.tsx do.
import { describe, expect, test } from "bun:test";
import { type MachineView, machineStatus } from "@agent-city/schema";
import { machinesAt } from "../merge.ts";
import { runIn, screen, session, T0 } from "./fixtures.ts";

const S = 1_000;
const LOUD = "?quiet=off";
const at = (sec: number) => new Date(T0 + sec * S).toISOString();

/** Beats every 5 s until `stop`, silent until `back`, beating again from `back`. */
const beats = (stop: number, back: number) => (sec: number) =>
	sec < stop ? sec - (sec % 5) : sec < back ? stop - 1 : sec - (sec % 5);

interface MachineSpec {
	id: MachineView["id"];
	stop: number;
	back: number;
}

/** What the hub says about one machine at `sec`: its last beat and, once back, the completed gap. */
function machineAt(m: MachineSpec, sec: number, history: boolean): MachineView {
	const last = beats(m.stop, m.back)(sec);
	const done = sec >= m.back;
	return {
		id: m.id,
		hostname: null,
		heartbeat_at: at(last),
		interval_s: 5,
		status: machineStatus(at(last), new Date(T0 + sec * S)),
		...(history
			? {
					recent_gaps: done
						? [
								{
									from_at: at(m.stop - 1),
									until_at: at(m.back),
									boot_changed: false,
								},
							]
						: [],
				}
			: {}),
	};
}

interface Tick {
	sec: number;
	visits: string[];
	starts: string[];
	cues: string[];
}

interface Scenario {
	machines: MachineSpec[];
	data: (sec: number) => {
		runs?: ReturnType<typeof runIn>[];
		sessions?: ReturnType<typeof session>[];
	};
	/** false: an older hub that sends no recent_gaps. */
	history?: boolean;
}

/** A screen opened at `open` s, ticking once a second to `end` s, like Board.tsx. */
function drive(sc: Scenario, open: number, end: number): Tick[] {
	const s = screen(LOUD);
	const out: Tick[] = [];
	for (let sec = open; sec <= end; sec++) {
		const d = sc.data(sec);
		const now = T0 + sec * S;
		const r = s.step(now, {
			runs: d.runs ?? [],
			sessions: d.sessions ?? [],
			machines: machinesAt(
				sc.machines.map((m) => machineAt(m, sec, sc.history !== false)),
				now,
			),
			districts: {},
			eventsByRun: new Map(),
		});
		out.push({
			sec,
			visits: r.model.visits.map((v) => v.id),
			starts: r.model.visits.map((v) => v.starts),
			cues: r.cues,
		});
	}
	return out;
}

const from = (ticks: Tick[], sec: number) => ticks.filter((t) => t.sec >= sec);
const visitsOf = (ticks: Tick[]) =>
	ticks.map((t) => ({ sec: t.sec, visits: t.visits, starts: t.starts }));
const cuesOf = (ticks: Tick[]) =>
	ticks.flatMap((t) => t.cues.map((c) => `${t.sec}:${c}`));

// the cockpit's last beat is at 50 s; it stops counting as online at 140 s; it beats again at 1000 s
const COCKPIT: MachineSpec = { id: "cockpit", stop: 51, back: 1000 };
const R = 1000;

const waitingSince = (sec: number) =>
	runIn("waiting_owner", {
		reason: "AWAITING_PLAN_APPROVAL",
		status: "READY",
		last_progress_at: at(sec),
	});
const waitingSession = (sec: number, machine_id = "cockpit") =>
	session({ status: "waiting", last_event_at: at(sec), machine_id });

describe("N12: a screen opened after the Mac came back counts like one that watched", () => {
	const approval: Scenario = {
		machines: [COCKPIT],
		data: () => ({ runs: [waitingSince(100)] }),
	};

	test("결재 waiting since before the quiet, reload at R+30: no visit until R+60, then one, one knock", () => {
		const watched = drive(approval, 0, R + 120);
		const reloaded = drive(approval, R + 30, R + 120);
		expect(visitsOf(reloaded)).toEqual(visitsOf(from(watched, R + 30)));
		expect(reloaded.find((t) => t.sec === R + 59)?.visits).toEqual([]);
		expect(reloaded.find((t) => t.sec === R + 60)?.visits).toEqual([
			"cockpit:demo-flow-1",
		]);
		expect(reloaded.find((t) => t.sec === R + 60)?.starts).toEqual([
			at(R + 60),
		]);
		expect(cuesOf(reloaded)).toEqual([`${R + 60}:knock`]);
		expect(cuesOf(from(watched, R + 30))).toEqual([`${R + 60}:knock`]);
	});

	test("reload right at the return, or at R+59: the count still ends at R+60, never at the reload + 60", () => {
		const watched = visitsOf(drive(approval, 0, R + 130));
		for (const open of [R, R + 1, R + 59, R + 60]) {
			const reloaded = visitsOf(drive(approval, open, R + 130));
			expect(reloaded).toEqual(watched.filter((t) => t.sec >= open));
		}
	});

	test("a session waiting since before the quiet: same as the watched screen (the D4 path)", () => {
		const sc: Scenario = {
			machines: [COCKPIT],
			data: () => ({ sessions: [waitingSession(100)] }),
		};
		const watched = drive(sc, 0, R + 120);
		const reloaded = drive(sc, R + 30, R + 120);
		expect(visitsOf(reloaded)).toEqual(visitsOf(from(watched, R + 30)));
		expect(reloaded.find((t) => t.sec === R + 60)?.visits).toEqual([
			"session:claude:fake-session-1",
		]);
		expect(cuesOf(reloaded)).toEqual([`${R + 60}:knock`]);
	});

	test("a wait that began after the return keeps its own start", () => {
		const sc: Scenario = {
			machines: [COCKPIT],
			data: (sec) => ({ runs: sec >= R + 10 ? [waitingSince(R + 10)] : [] }),
		};
		const watched = drive(sc, 0, R + 120);
		const reloaded = drive(sc, R + 30, R + 120);
		expect(visitsOf(reloaded)).toEqual(visitsOf(from(watched, R + 30)));
		expect(reloaded.find((t) => t.sec === R + 69)?.visits).toEqual([]);
		expect(reloaded.find((t) => t.sec === R + 70)?.visits).toEqual([
			"cockpit:demo-flow-1",
		]);
	});

	test("a 결재 that had lasted 60 s before the Mac went quiet is there at once, as it was on the watched screen", () => {
		const sc: Scenario = {
			machines: [COCKPIT],
			data: () => ({ runs: [waitingSince(-120)] }),
		};
		const watched = drive(sc, 0, R + 90);
		const reloaded = drive(sc, R + 30, R + 90);
		expect(visitsOf(reloaded)).toEqual(visitsOf(from(watched, R + 30)));
		expect(reloaded[0]?.visits).toEqual(["cockpit:demo-flow-1"]);
		expect(cuesOf(reloaded)).toEqual([]);
	});

	test("overlapping cockpit and forge gaps are not counted twice: the count restarts at the later return", () => {
		const FORGE: MachineSpec = { id: "forge", stop: 401, back: R + 20 };
		const sc: Scenario = {
			machines: [COCKPIT, FORGE],
			data: () => ({ sessions: [waitingSession(100, "forge")] }),
		};
		const watched = drive(sc, 0, R + 140);
		// the screen that stayed open too: when the cockpit came back while forge was still quiet, its clock
		// jumped to forge's quiet point; that quiet time no longer matures the count (before N12 it did, at R)
		expect(
			watched.filter((t) => t.sec < R + 80).every((t) => t.visits.length === 0),
		).toBe(true);
		const reloaded = drive(sc, R + 40, R + 140);
		expect(visitsOf(reloaded)).toEqual(visitsOf(from(watched, R + 40)));
		expect(reloaded.find((t) => t.sec === R + 79)?.visits).toEqual([]);
		expect(reloaded.find((t) => t.sec === R + 80)?.visits).toEqual([
			"session:claude:fake-session-1",
		]);
	});

	test("a short forge gap inside a longer cockpit gap does not mature the count on cockpit-quiet time", () => {
		// cockpit quiet from 140 s to R; forge quiet from 390 s (last beat 300) to 400 s, inside it
		const FORGE: MachineSpec = { id: "forge", stop: 301, back: 400 };
		const sc: Scenario = {
			machines: [COCKPIT, FORGE],
			data: () => ({ sessions: [waitingSession(100, "forge")] }),
		};
		const watched = drive(sc, 0, R + 120);
		const reloaded = drive(sc, R + 30, R + 120);
		expect(visitsOf(reloaded)).toEqual(visitsOf(from(watched, R + 30)));
		expect(reloaded.find((t) => t.sec === R + 59)?.visits).toEqual([]);
		expect(reloaded.find((t) => t.sec === R + 60)?.visits).toEqual([
			"session:claude:fake-session-1",
		]);
	});

	test("ticking on, the same snapshot again, a reconnect: one visit, one walk start, one knock", () => {
		const reloaded = drive(approval, R + 30, R + 600);
		const shown = reloaded.filter((t) => t.visits.length > 0);
		expect(new Set(shown.map((t) => t.starts.join())).size).toBe(1);
		expect(shown[0]?.sec).toBe(R + 60);
		expect(cuesOf(reloaded)).toEqual([`${R + 60}:knock`]);
	});
});

describe("N12: without usable history the screen keeps its old behaviour", () => {
	test("an older hub (no recent_gaps): a reload counts from the wait's start, as before N12", () => {
		const sc: Scenario = {
			machines: [COCKPIT],
			data: () => ({ runs: [waitingSince(100)] }),
			history: false,
		};
		const reloaded = drive(sc, R + 30, R + 40);
		expect(reloaded[0]?.visits).toEqual(["cockpit:demo-flow-1"]);
	});

	test("a gap that ended more than 24 h ago is outside the window: the wait is simply old", () => {
		const sc: Scenario = {
			machines: [COCKPIT],
			data: () => ({ runs: [waitingSince(100)] }),
		};
		const DAY = 24 * 3600;
		const reloaded = drive(sc, R + DAY + 1, R + DAY + 5);
		expect(reloaded[0]?.visits).toEqual(["cockpit:demo-flow-1"]);
		const inside = drive(sc, R + DAY - 30, R + DAY - 25);
		expect(inside[0]?.visits).toEqual(["cockpit:demo-flow-1"]);
	});
});
