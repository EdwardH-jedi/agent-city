import { describe, expect, test } from "bun:test";
import { ev, iso, runIn, T0 } from "./fixtures.ts";
import { toVillageModel } from "./model.ts";
import { currentRuns, runKey } from "./types.ts";
import {
	buildVisits,
	emptyWatch,
	REPORT_LEAVE_MS,
	REPORT_STAY_MS,
	signVisits,
	stepWatch,
} from "./visits.ts";

const none = new Map();
const waiting = (over = {}) =>
	runIn("waiting_owner", { reason: "AWAITING_PLAN_APPROVAL", ...over });

describe("결재 (sign) visits", () => {
	test("a run that needs the owner makes one sign carrying the folder, id machine:run", () => {
		const v = signVisits(currentRuns([waiting()]));
		expect(v).toHaveLength(1);
		expect(v[0]).toMatchObject({
			id: "cockpit:demo-flow-1",
			kind: "sign",
			carry: "folder",
			text: "계획 승인 부탁드립니다.",
			code: "AWAITING_PLAN_APPROVAL",
			until: null,
		});
		const hold = signVisits(
			currentRuns([
				runIn("hold", { status: "HOLD", reason: "BUDGET_EXHAUSTED" }),
			]),
		);
		expect(hold[0]?.carry).toBe("binder");
	});

	test("a sign never ends because time passed", () => {
		const cur = currentRuns([waiting({ last_progress_at: iso(-1000) })]);
		for (const later of [0, 3_600_000, 30 * 24 * 3_600_000]) {
			const v = buildVisits(cur, none, emptyWatch(), T0 + later);
			expect(v.map((x) => x.kind)).toEqual(["sign"]);
			expect(v[0]?.closing).toBe(false);
		}
	});

	test("it ends when the run's display changes", () => {
		const before = buildVisits(
			currentRuns([waiting()]),
			none,
			emptyWatch(),
			T0,
		);
		expect(before).toHaveLength(1);
		const after = buildVisits(
			currentRuns([runIn("running", { reason: null })]),
			none,
			emptyWatch(),
			T0,
		);
		expect(after.filter((v) => v.kind === "sign")).toHaveLength(0);
	});

	test("it survives the Mac going quiet: classified by what was last reported, not snapshot_stale", () => {
		const stale = waiting({ display: "snapshot_stale" });
		expect(signVisits(currentRuns([stale]))).toHaveLength(1);
	});

	test("an older run of the same workflow makes no visit", () => {
		const cur = currentRuns([
			waiting({
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
		expect(
			buildVisits(cur, none, emptyWatch(), T0).filter((v) => v.kind === "sign"),
		).toEqual([]);
	});

	test("an old `unverified` run is not a sign; it becomes a 확인 필요 line instead", () => {
		const r = runIn("unverified", {
			status: "PARTIAL",
			reason: "PRESERVED_ON_HOLD",
			evidence_verified: false,
		});
		const m = toVillageModel({
			runs: [r],
			machines: [],
			districts: {},
			eventsByRun: none,
			now: T0,
			conn: "open",
		});
		expect(m.visits).toEqual([]);
		expect(m.incidents).toHaveLength(1);
		expect(m.incidents[0]).toMatchObject({
			text: "확인이 필요합니다",
			code: "PRESERVED_ON_HOLD",
		});
	});

	test("signs sit in arrival order (oldest first)", () => {
		const cur = currentRuns([
			waiting({
				run_id: "b-1",
				workflow_id: "b",
				last_progress_at: iso(-60_000),
			}),
			waiting({
				run_id: "a-1",
				workflow_id: "a",
				last_progress_at: iso(-600_000),
			}),
		]);
		expect(signVisits(cur).map((v) => v.id)).toEqual([
			"cockpit:a-1",
			"cockpit:b-1",
		]);
	});
});

describe("보고 (report) visits", () => {
	const r = runIn("running");
	const key = runKey(r);
	const events = (at: number, extra = {}) =>
		new Map([[key, [ev({ occurred_at: iso(at), ...extra })]]]);

	test("a fresh task.completed is a report that says what already happened", () => {
		const v = buildVisits(currentRuns([r]), events(-30_000), emptyWatch(), T0);
		expect(v).toHaveLength(1);
		expect(v[0]).toMatchObject({
			kind: "report",
			carry: null,
			text: "T1 통과했습니다. 다음으로 넘어갑니다.",
			closing: false,
		});
	});

	test("it ends 5 minutes after the event: 진행하겠습니다 for 5 s, then it is gone", () => {
		const at = -30_000;
		const cur = currentRuns([r]);
		const atNow = (n: number) =>
			buildVisits(cur, events(at), emptyWatch(), T0 + n);
		expect(atNow(REPORT_STAY_MS + at - 1)[0]?.closing).toBe(false);
		const closing = atNow(REPORT_STAY_MS + at)[0];
		expect(closing?.closing).toBe(true);
		expect(closing?.text).toBe("진행하겠습니다.");
		expect(closing?.until).toBe(iso(at + REPORT_STAY_MS));
		expect(atNow(REPORT_STAY_MS + at + REPORT_LEAVE_MS - 1)).toHaveLength(1);
		expect(atNow(REPORT_STAY_MS + at + REPORT_LEAVE_MS)).toHaveLength(0);
	});

	test("opening the screen makes no visit for an event older than 5 minutes", () => {
		const v = buildVisits(
			currentRuns([r]),
			events(-(REPORT_STAY_MS + REPORT_LEAVE_MS + 1)),
			emptyWatch(),
			T0,
		);
		expect(v).toEqual([]);
	});

	test("the same id comes back the same: asking again does not restart the walk", () => {
		const cur = currentRuns([r]);
		const a = buildVisits(cur, events(-30_000), emptyWatch(), T0)[0];
		const b = buildVisits(cur, events(-30_000), emptyWatch(), T0 + 10_000)[0];
		expect(b?.id).toBe(a?.id);
		expect(b?.since).toBe(a?.since);
	});

	test("a newer report of the same project replaces the older one", () => {
		const a = runIn("running", { run_id: "a-1", workflow_id: "a" });
		const b = runIn("running", { run_id: "b-1", workflow_id: "b" });
		const map = new Map([
			[runKey(a), [ev({ occurred_at: iso(-200_000) })]],
			[runKey(b), [ev({ occurred_at: iso(-20_000), task_id: "T9" })]],
		]);
		const v = buildVisits(currentRuns([a, b]), map, emptyWatch(), T0);
		expect(v).toHaveLength(1);
		expect(v[0]?.id).toBe("cockpit:b-1");
	});

	test("a run that has a sign makes no report; transitions outside the table make none", () => {
		const w = waiting();
		const v = buildVisits(
			currentRuns([w]),
			new Map([[runKey(w), [ev({ occurred_at: iso(-1000) })]]]),
			emptyWatch(),
			T0,
		);
		expect(v.map((x) => x.kind)).toEqual(["sign"]);
		for (const t of [
			"task.started",
			"session.correlated",
			"review.recorded",
			"task.blocked",
			"workflow.started",
		]) {
			expect(
				buildVisits(
					currentRuns([r]),
					events(-1000, { transition: t }),
					emptyWatch(),
					T0,
				),
			).toEqual([]);
		}
	});

	test("task.failed is a report only when a later task.started shows another attempt", () => {
		const failed = ev({
			sequence: 4,
			transition: "task.failed",
			occurred_at: iso(-30_000),
		});
		const blocked = ev({
			sequence: 5,
			transition: "task.blocked",
			occurred_at: iso(-29_000),
		});
		const started = ev({
			sequence: 5,
			transition: "task.started",
			occurred_at: iso(-20_000),
		});
		const cur = currentRuns([r]);
		const out = (list: ReturnType<typeof ev>[]) =>
			buildVisits(cur, new Map([[key, list]]), emptyWatch(), T0);
		expect(out([blocked, failed])).toEqual([]);
		expect(out([started, failed])[0]?.text).toBe(
			"한 번 실패해서 다시 시도합니다.",
		);
	});

	test("task.escalated names both models", () => {
		const v = buildVisits(
			currentRuns([r]),
			events(-1000, {
				transition: "task.escalated",
				from_model: "sonnet",
				to_model: "opus",
			}),
			emptyWatch(),
			T0,
		);
		expect(v[0]?.text).toBe("sonnet로 풀리지 않아 opus로 올렸습니다.");
	});
});

describe("changes only this screen can see (stepWatch)", () => {
	test("first sight remembers; it never replays old news", () => {
		const w = stepWatch(emptyWatch(), currentRuns([runIn("passed")]), T0);
		expect(w.observed).toEqual([]);
	});

	test("entering Independent Review while open is a report from the moment it was seen", () => {
		const w0 = stepWatch(
			emptyWatch(),
			currentRuns([runIn("running", { phase: "QA" })]),
			T0,
		);
		const w1 = stepWatch(
			w0,
			currentRuns([runIn("running", { phase: "Independent Review" })]),
			T0 + 10_000,
		);
		const v = buildVisits(
			currentRuns([runIn("running", { phase: "Independent Review" })]),
			none,
			w1,
			T0 + 12_000,
		);
		expect(v).toHaveLength(1);
		expect(v[0]?.text).toBe("Codex 리뷰에 들어갑니다.");
		expect(v[0]?.since).toBe(iso(10_000));
		// and it is over 5 minutes later
		const gone = buildVisits(
			currentRuns([runIn("running", { phase: "Independent Review" })]),
			none,
			w1,
			T0 + 10_000 + REPORT_STAY_MS + REPORT_LEAVE_MS,
		);
		expect(gone).toEqual([]);
	});

	test("display turning passed / partial is reported, once", () => {
		const w0 = stepWatch(emptyWatch(), currentRuns([runIn("running")]), T0);
		const done = currentRuns([runIn("passed")]);
		const w1 = stepWatch(w0, done, T0 + 5_000);
		expect(buildVisits(done, none, w1, T0 + 6_000)[0]?.text).toBe(
			"전부 끝났습니다.",
		);
		const w2 = stepWatch(w1, done, T0 + 10_000);
		expect(w2.observed).toHaveLength(1); // not added again on the next tick
		const part = currentRuns([runIn("partial")]);
		const w3 = stepWatch(w0, part, T0 + 5_000);
		expect(buildVisits(part, none, w3, T0 + 6_000)[0]?.text).toBe(
			"일부만 끝내고 닫았습니다.",
		);
	});

	test("a run that was already passed when first seen makes no visit later", () => {
		const done = currentRuns([runIn("passed")]);
		let w = stepWatch(emptyWatch(), done, T0);
		w = stepWatch(w, done, T0 + 60_000);
		expect(buildVisits(done, none, w, T0 + 60_000)).toEqual([]);
	});
});
