import { describe, expect, test } from "bun:test";
import { ev, iso, machine, run, runIn, T0 } from "./fixtures.ts";
import { toVillageModel } from "./model.ts";
import { currentRuns } from "./types.ts";

const base = {
	machines: [machine("online")],
	districts: {},
	eventsByRun: new Map(),
	now: T0,
	conn: "open" as const,
};
const model = (runs: ReturnType<typeof run>[], over = {}) =>
	toVillageModel({ ...base, runs, ...over });

describe("border: red > yellow > none (§3)", () => {
	const RED = [
		["hold", { status: "HOLD", reason: "MODEL_CHAIN_EXHAUSTED" }],
		["needs_reconcile", { alert: "FAILED_PROCESS_RECONCILE" }],
		["partial (closed 1 h ago)", { last_progress_at: iso(-3_600_000) }],
	] as const;
	const stateOf = (name: string) =>
		name.startsWith("partial")
			? "partial"
			: (name as "hold" | "needs_reconcile");

	for (const [name, over] of RED) {
		test(`${name} alone → red`, () => {
			const m = model([runIn(stateOf(name), over)]);
			expect(m.status.border).toBe("red");
		});
		test(`${name} + waiting_owner → still red`, () => {
			const m = model([
				runIn(stateOf(name), { ...over, workflow_id: "a", run_id: "a-1" }),
				runIn("waiting_owner", {
					workflow_id: "b",
					run_id: "b-1",
					reason: "AWAITING_PLAN_APPROVAL",
				}),
			]);
			expect(m.status.border).toBe("red");
		});
	}

	test("waiting_owner alone → yellow", () => {
		expect(
			model([runIn("waiting_owner", { reason: "AWAITING_PLAN_APPROVAL" })])
				.status.border,
		).toBe("yellow");
	});
	test("running / passed / unverified / unknown → none", () => {
		for (const s of [
			"running",
			"passed",
			"unverified",
			"unknown",
			"no_progress_suspected",
		] as const) {
			expect(model([runIn(s)]).status.border).toBe("none");
		}
		expect(model([]).status.border).toBe("none");
	});
	test("a partial closed more than 24 h ago is not red", () => {
		const m = model([
			runIn("partial", { last_progress_at: iso(-25 * 3_600_000) }),
		]);
		expect(m.status.border).toBe("none");
	});
	test("an older run of the same workflow cannot turn the border on", () => {
		const m = model([
			runIn("hold", {
				run_id: "w-1",
				workflow_id: "w",
				last_progress_at: iso(-7_200_000),
			}),
			runIn("passed", {
				run_id: "w-2",
				workflow_id: "w",
				last_progress_at: iso(-60_000),
			}),
		]);
		expect(m.status.border).toBe("none");
	});
	test("the cockpit going quiet leaves the border as it was and dims instead", () => {
		for (const s of ["stale", "offline", "unobserved"] as const) {
			const m = model(
				[
					runIn("waiting_owner", {
						display: "snapshot_stale",
						reason: "AWAITING_PLAN_APPROVAL",
					}),
				],
				{
					machines: [machine(s)],
				},
			);
			expect(m.status.border).toBe("yellow");
			expect(m.status.dim).toBe(true);
			expect(m.owner.present).toBe(false);
		}
		expect(model([runIn("passed")]).status.dim).toBe(false);
	});
});

describe("status sentence", () => {
	test("전부 정상 / 결재 N건 / 멈춤 N건", () => {
		expect(model([runIn("passed")]).status.sentence).toBe("전부 정상");
		expect(
			model([runIn("waiting_owner", { reason: "AWAITING_PLAN_APPROVAL" })])
				.status.sentence,
		).toBe("결재 1건");
		expect(
			model([
				runIn("hold", {
					run_id: "h-1",
					workflow_id: "h",
					status: "HOLD",
					reason: "BUDGET_EXHAUSTED",
				}),
				runIn("needs_reconcile", {
					run_id: "r-1",
					workflow_id: "r",
					alert: "EVENT_LOG_TORN",
				}),
			]).status.sentence,
		).toBe("멈춤 2건");
	});
	test("Mac 보고 끊김 (N분 전) when the cockpit stops beating", () => {
		const m = model([runIn("passed")], {
			machines: [machine("offline", "cockpit", 12 * 60_000)],
		});
		expect(m.status.sentence).toBe("Mac 보고 끊김 (12분 전)");
	});
});

describe("현재 run rule (§3)", () => {
	test("the run with the latest last_progress_at wins; reported_at and sequence are not the key", () => {
		const cur = currentRuns([
			run({
				run_id: "n-1",
				workflow_id: "n",
				project: null,
				last_progress_at: iso(-120_000),
				last_event_sequence: 99,
			}),
			run({
				run_id: "n-3",
				workflow_id: "n",
				project: null,
				last_progress_at: iso(-60_000),
				last_event_sequence: 4,
			}),
			run({
				run_id: "n-2",
				workflow_id: "n",
				project: null,
				last_progress_at: iso(-90_000),
				last_event_sequence: null,
			}),
		]);
		expect(cur.map((c) => c.run.run_id)).toEqual(["n-3"]);
	});
	test("a tie goes to the higher sequence, then to the higher run id (…-3 after …-2)", () => {
		const t = iso(-60_000);
		const tie = currentRuns([
			run({
				run_id: "n-1",
				workflow_id: "n",
				last_progress_at: t,
				last_event_sequence: 5,
			}),
			run({
				run_id: "n-2",
				workflow_id: "n",
				last_progress_at: t,
				last_event_sequence: null,
			}),
		]);
		expect(tie[0]?.run.run_id).toBe("n-1");
		const ids = currentRuns([
			run({
				run_id: "n-2",
				workflow_id: "n",
				last_progress_at: t,
				last_event_sequence: null,
			}),
			run({
				run_id: "n-10",
				workflow_id: "n",
				last_progress_at: t,
				last_event_sequence: null,
			}),
		]);
		expect(ids[0]?.run.run_id).toBe("n-10");
	});
	test("a run without last_progress_at is the oldest", () => {
		const cur = currentRuns([
			run({ run_id: "n-9", workflow_id: "n", last_progress_at: null }),
			run({ run_id: "n-1", workflow_id: "n", last_progress_at: iso(-1000) }),
		]);
		expect(cur[0]?.run.run_id).toBe("n-1");
	});
	test("runs of different workflows or projects are each current; project null is one building", () => {
		const m = model([
			runIn("passed", { run_id: "a-1", workflow_id: "a", project: null }),
			runIn("passed", { run_id: "b-1", workflow_id: "b", project: null }),
			runIn("passed", {
				run_id: "c-1",
				workflow_id: "a",
				project: "acme/widgets",
			}),
		]);
		expect(m.projects.map((p) => p.label).sort()).toEqual(
			["widgets", "미지정"].sort(),
		);
		expect(m.now).toHaveLength(0);
	});
	test("a snapshot_stale run still counts by what it last reported", () => {
		const m = model([runIn("running", { display: "snapshot_stale" })], {
			machines: [machine("offline")],
		});
		expect(m.now).toHaveLength(1);
		expect(m.now[0]?.stale).toBe(true);
		expect(m.now[0]?.display).toBe("running");
	});
});

describe("지금 진행 / 오늘 완료", () => {
	test("only running and no_progress_suspected current runs, with their phase index and tokens", () => {
		const m = model([
			runIn("running", {
				run_id: "a-1",
				workflow_id: "a",
				phase: "QA",
				tokens_today: 42,
			}),
			runIn("passed", { run_id: "b-1", workflow_id: "b" }),
			runIn("waiting_owner", {
				run_id: "c-1",
				workflow_id: "c",
				reason: "AWAITING_PLAN_APPROVAL",
			}),
		]);
		expect(m.now).toHaveLength(1);
		expect(m.now[0]).toMatchObject({
			workflow_id: "a",
			phase_index: 4,
			tokens_today: 42,
			stale: false,
		});
		expect(m.today.running).toBe(1);
	});
	test("오늘 완료 counts today's task.completed events only", () => {
		const r = runIn("running");
		const key = `${r.machine_id}:${r.run_id}`;
		const m = model([r], {
			eventsByRun: new Map([
				[
					key,
					[
						ev({ sequence: 3, occurred_at: iso(-60_000) }),
						ev({ sequence: 2, occurred_at: iso(-1_000) }),
						ev({ sequence: 1, occurred_at: iso(-3 * 24 * 3_600_000) }),
						ev({
							sequence: 4,
							transition: "task.started",
							occurred_at: iso(-1_000),
						}),
					],
				],
			]),
		});
		expect(m.today.completed).toBe(2);
	});
});

describe("projects", () => {
	test("monitors: one per running run, by phase; waiting/stopped counted", () => {
		const m = model([
			runIn("running", {
				run_id: "a-1",
				workflow_id: "a",
				phase: "Implementation",
			}),
			runIn("running", {
				run_id: "b-1",
				workflow_id: "b",
				phase: "Independent Review",
			}),
			runIn("waiting_owner", {
				run_id: "c-1",
				workflow_id: "c",
				reason: "AWAITING_PLAN_APPROVAL",
			}),
		]);
		const p = m.projects.find((x) => x.id === "acme/widgets");
		expect(p).toMatchObject({
			running: 2,
			waiting: 1,
			stopped: 0,
			quiet: false,
		});
		expect(p?.monitors.sort()).toEqual(["code", "review"]);
	});
	test("repos: active within 7 days (or a live session) get a building, the rest fold into quiet", () => {
		const repo = (id: string, pushed: string | null, live = 0) =>
			({ id, pushed_at: pushed, active_sessions: live }) as never;
		const m = model([], {
			districts: {
				d: [
					repo("o/recent", iso(-24 * 3_600_000)),
					repo("o/old", iso(-30 * 24 * 3_600_000)),
					repo("o/live", iso(-30 * 24 * 3_600_000), 1),
					repo("o/never", null),
				],
			},
		});
		const quiet = m.projects
			.filter((p) => p.quiet)
			.map((p) => p.id)
			.sort();
		expect(quiet).toEqual(["o/never", "o/old"]);
		expect(
			m.projects
				.filter((p) => !p.quiet)
				.map((p) => p.id)
				.sort(),
		).toEqual(["o/live", "o/recent"]);
	});
	test("a run's project matches its repo case-insensitively", () => {
		const m = model([runIn("running", { project: "Acme/Widgets" })], {
			districts: {
				d: [
					{ id: "acme/widgets", pushed_at: null, active_sessions: 0 } as never,
				],
			},
		});
		expect(m.projects).toHaveLength(1);
	});
});

describe("connection", () => {
	test("only an open socket is open", () => {
		expect(model([], { conn: "open" }).conn).toBe("open");
		expect(model([], { conn: "reconnecting" }).conn).toBe("reconnecting");
		expect(model([], { conn: "connecting" }).conn).toBe("reconnecting");
	});
});
