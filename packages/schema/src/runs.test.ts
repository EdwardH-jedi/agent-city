import { describe, expect, test } from "bun:test";
import {
	RUN_SNAPSHOT_STALE_MS,
	RunsPayload,
	reportedRunState,
	runStateAt,
} from "./index.ts";

const iso = "2026-01-01T00:00:00.000Z";

const run = (over: Record<string, unknown> = {}) => ({
	run_id: "station0-notes-2",
	project: "EdwardH-jedi/station0",
	workflow_id: "station0-validation-notes",
	phase: "Independent Review", // Office phase names contain a space
	status: "RUNNING",
	reason: "CODEX_REVIEW_RUNNING",
	alert: null,
	last_progress_at: iso,
	idle_seconds: 48,
	completed: ["T1"],
	tokens_today: 18125,
	usage_unknown: false,
	evidence_verified: true,
	last_event_sequence: 7,
	events: [
		{
			sequence: 7,
			transition: "task.started",
			occurred_at: iso,
			task_id: "T1",
			attempt: 1,
			model: "sonnet",
			commit: "a".repeat(40),
			test_run_key: "run-0123456789abcdef",
		},
	],
	...over,
});

const payload = (over: Record<string, unknown> = {}) => ({
	schema: 1,
	source: "agent-office",
	machine_id: "cockpit",
	observed_at: iso,
	ledger_revision: 42,
	runs: [run()],
	...over,
});

const ok = (p: unknown) => RunsPayload.safeParse(p).success;

describe("RunsPayload", () => {
	test("accepts the documented shape with real Office values", () => {
		expect(ok(payload())).toBe(true);
		expect(ok(payload({ runs: [] }))).toBe(true);
		expect(
			ok(
				payload({ runs: [run({ project: null, last_event_sequence: null })] }),
			),
		).toBe(true);
	});

	test("is strict at every level: unknown keys are refused", () => {
		expect(ok(payload({ goal: "ship it" }))).toBe(false);
		expect(ok(payload({ runs: [run({ goal: "ship it" })] }))).toBe(false);
		expect(ok(payload({ runs: [run({ evidence_path: "x" })] }))).toBe(false);
		const ev = run().events[0];
		expect(
			ok(payload({ runs: [run({ events: [{ ...ev, session_key: "k" }] })] })),
		).toBe(false);
		// camelCase from the spec example is not accepted: City fields are snake_case
		expect(
			ok(
				payload({
					runs: [
						run({ events: [{ sequence: 1, transition: "t", taskId: "T1" }] }),
					],
				}),
			),
		).toBe(false);
	});

	test("no field can carry a path: absolute-path shaped values are refused", () => {
		for (const bad of [
			"/Users/someone/project",
			"C:\\dev\\agent-city",
			"a/b/c",
			"~/x",
		]) {
			expect(ok(payload({ runs: [run({ run_id: bad })] }))).toBe(false);
			expect(ok(payload({ runs: [run({ reason: bad })] }))).toBe(false);
			expect(ok(payload({ runs: [run({ workflow_id: bad })] }))).toBe(false);
		}
		expect(
			ok(payload({ runs: [run({ project: "/Users/someone/project" })] })),
		).toBe(false);
		expect(
			ok(payload({ runs: [run({ project: "Users/someone/project" })] })),
		).toBe(false);
	});

	test("a token-shaped value is refused (fixtures build the fake key at runtime)", () => {
		const fake = `sk-ant-${"a".repeat(40)}`;
		expect(ok(payload({ runs: [run({ reason: fake })] }))).toBe(false);
		expect(ok(payload({ runs: [run({ run_id: fake })] }))).toBe(false);
	});

	test("free text is refused: spaces only exist in the phase name", () => {
		expect(ok(payload({ runs: [run({ reason: "has space" })] }))).toBe(false);
		expect(ok(payload({ runs: [run({ phase: "QA; rm" })] }))).toBe(false);
		expect(ok(payload({ runs: [run({ phase: "Report" })] }))).toBe(true);
	});

	test("source, schema and machine_id", () => {
		expect(ok(payload({ source: "someone-else" }))).toBe(false);
		expect(ok(payload({ schema: 2 }))).toBe(false);
		expect(ok(payload({ machine_id: "laptop" }))).toBe(false);
		// a valid but non-cockpit machine is shape-valid; the route (not the schema) answers 403
		expect(ok(payload({ machine_id: "forge" }))).toBe(true);
	});

	test("bounds: runs per payload, events per run, completed list", () => {
		expect(ok(payload({ runs: Array.from({ length: 51 }, () => run()) }))).toBe(
			false,
		);
		const ev = (n: number) => ({ sequence: n, transition: "task.started" });
		expect(
			ok(
				payload({
					runs: [run({ events: Array.from({ length: 201 }, (_, i) => ev(i)) })],
				}),
			),
		).toBe(false);
		expect(
			ok(
				payload({
					runs: [run({ completed: Array.from({ length: 51 }, () => "T1") })],
				}),
			),
		).toBe(false);
	});
});

describe("reportedRunState — the 02 §6 table, row by row", () => {
	const s = (over: Record<string, unknown>) =>
		reportedRunState({
			status: "RUNNING",
			reason: "RECORDER_CHECK_RUNNING",
			alert: null,
			evidence_verified: true,
			...over,
		} as Parameters<typeof reportedRunState>[0]);

	test("running: RUNNING with no alert", () => {
		expect(s({})).toBe("running");
	});
	test("no_progress_suspected: alert STALE_OR_IDLE (an alert, not a failure)", () => {
		expect(s({ alert: "STALE_OR_IDLE" })).toBe("no_progress_suspected");
	});
	test("needs_reconcile: either reconciliation alert", () => {
		expect(s({ alert: "FAILED_PROCESS_RECONCILE" })).toBe("needs_reconcile");
		expect(s({ alert: "MISSION_RECONCILIATION_REQUIRED" })).toBe(
			"needs_reconcile",
		);
	});
	test("waiting_owner: READY with one of the four owner reasons", () => {
		for (const reason of [
			"AWAITING_PLAN_APPROVAL",
			"AWAITING_OWNER_INTEGRATION",
			"DRAFT_REQUIRES_OWNER_COMMIT",
			"PLAN_APPROVED",
		]) {
			expect(s({ status: "READY", reason })).toBe("waiting_owner");
		}
	});
	test("hold: any HOLD, whatever the reason", () => {
		expect(s({ status: "HOLD", reason: "RUNNING_AGENTS_OR_OPEN_FILES" })).toBe(
			"hold",
		);
		expect(s({ status: "HOLD", reason: "MODEL_CHAIN_EXHAUSTED" })).toBe("hold");
	});
	test("hold also when Office reports the hold reason as the alert (watchdog: alert = run.reason)", () => {
		expect(
			s({
				status: "HOLD",
				reason: "RUNNING_AGENTS_OR_OPEN_FILES",
				alert: "RUNNING_AGENTS_OR_OPEN_FILES",
			}),
		).toBe("hold");
		// but a non-HOLD run with an alert the table does not know stays unknown
		expect(
			s({ status: "RUNNING", alert: "RUNNING_AGENTS_OR_OPEN_FILES" }),
		).toBe("unknown");
	});
	test("passed and partial", () => {
		expect(s({ status: "PASS", reason: "WORKTREE_RETAINED" })).toBe("passed");
		expect(s({ status: "PARTIAL", reason: "PRESERVED_ON_HOLD" })).toBe(
			"partial",
		);
	});
	test("unverified wins over everything, so unchecked evidence never reads as passed", () => {
		expect(s({ status: "PASS", evidence_verified: false })).toBe("unverified");
		expect(s({ status: "PASS", alert: "EVIDENCE_UNVERIFIED" })).toBe(
			"unverified",
		);
		expect(s({ alert: "STALE_OR_IDLE", evidence_verified: false })).toBe(
			"unverified",
		);
	});
	test("a combination the table does not list is `unknown`, never a guess", () => {
		expect(s({ status: "READY", reason: "SOMETHING_NEW" })).toBe("unknown");
		expect(s({ status: "READY", reason: null })).toBe("unknown");
		expect(s({ status: "WEIRD" })).toBe("unknown");
		expect(s({ alert: "A_NEW_ALERT" })).toBe("unknown");
	});
});

describe("runStateAt — what City itself adds", () => {
	const base = {
		status: "RUNNING",
		reason: null,
		alert: null,
		evidence_verified: true,
	};
	const at = (ms: number) => new Date(Date.parse(iso) + ms);

	test("fresh report shows as reported", () => {
		expect(runStateAt(base, iso, "online", at(1_000))).toEqual({
			display: "running",
			last_display: "running",
			needs_owner: false,
		});
	});

	test("89 s old is still fresh, 90 s is snapshot_stale (three missed 30 s sends)", () => {
		expect(RUN_SNAPSHOT_STALE_MS).toBe(90_000);
		expect(runStateAt(base, iso, "online", at(89_000)).display).toBe("running");
		const stale = runStateAt(base, iso, "online", at(90_000));
		expect(stale.display).toBe("snapshot_stale");
		expect(stale.last_display).toBe("running"); // "last report: running (N min ago)"
	});

	test("an offline cockpit makes even a fresh-looking running report snapshot_stale", () => {
		expect(runStateAt(base, iso, "offline", at(1_000)).display).toBe(
			"snapshot_stale",
		);
		expect(runStateAt(base, iso, "stale", at(1_000)).display).toBe("running");
		expect(runStateAt(base, iso, "unobserved", at(1_000)).display).toBe(
			"running",
		);
	});

	test("a finished run stays as reported when stale or offline", () => {
		const pass = { ...base, status: "PASS" };
		expect(runStateAt(pass, iso, "offline", at(3_600_000)).display).toBe(
			"passed",
		);
		const part = { ...base, status: "PARTIAL" };
		expect(runStateAt(part, iso, "online", at(3_600_000)).display).toBe(
			"partial",
		);
	});

	test("needs_owner covers waiting_owner, hold, needs_reconcile and unverified", () => {
		const need = (o: Record<string, unknown>) =>
			runStateAt({ ...base, ...o }, iso, "online", at(0)).needs_owner;
		expect(need({ status: "READY", reason: "AWAITING_PLAN_APPROVAL" })).toBe(
			true,
		);
		expect(need({ status: "HOLD" })).toBe(true);
		expect(need({ alert: "FAILED_PROCESS_RECONCILE" })).toBe(true);
		expect(need({ evidence_verified: false })).toBe(true);
		expect(need({})).toBe(false);
		expect(need({ alert: "STALE_OR_IDLE" })).toBe(false);
		expect(need({ status: "PASS" })).toBe(false);
	});

	test("a stale needs-owner run is still listed as needing the owner (last known)", () => {
		const st = runStateAt(
			{ ...base, status: "HOLD" },
			iso,
			"online",
			at(600_000),
		);
		expect(st.display).toBe("snapshot_stale");
		expect(st.needs_owner).toBe(true);
	});

	test("an unparseable receive time is treated as stale, not fresh", () => {
		expect(runStateAt(base, "garbage", "online", at(0)).display).toBe(
			"snapshot_stale",
		);
	});
});
