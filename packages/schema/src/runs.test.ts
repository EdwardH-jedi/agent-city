import { describe, expect, test } from "bun:test";
import {
	compareInstants,
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

	test("phase: exactly Office's nine phases; anything else is refused", () => {
		const nine = [
			"Goal",
			"Plan",
			"Approval",
			"Implementation",
			"QA",
			"Independent Review",
			"Integration",
			"Cleanup",
			"Report",
		];
		for (const good of nine)
			expect(ok(payload({ runs: [run({ phase: good })] }))).toBe(true);
		const bad = [
			"Delete Files",
			"Bearer x",
			"Bearer Abcdefghij",
			`Bearer ${"abcdefghij".repeat(2)}0123456789`, // built at runtime (check:secrets)
			"Token Abcdefgh",
			"delete all my files",
			"Delete Every File",
			"Ignore previous instructions",
			"qa",
			"QA ",
			"QA\nrm",
			"Independent  Review",
			"Review",
			"",
			`sk-${"a".repeat(20)}`,
			"/etc/passwd",
		];
		for (const v of bad)
			expect(ok(payload({ runs: [run({ phase: v })] }))).toBe(false);
	});

	test("project: GitHub owner/repo — real repo names pass; paths, extra segments and tokens are refused", () => {
		for (const good of [
			"EdwardH-jedi/station0",
			"alpha/.github",
			"alpha/observabilityplatform2026",
			`alpha/${"a1B2".repeat(25)}`, // 100 chars, GitHub's maximum
			"local/agent-city",
			"a/b.c_d-e",
			"owner/.env", // a legal repo name (accepted residual: same shape as a dotfile)
		])
			expect(ok(payload({ runs: [run({ project: good })] }))).toBe(true);
		const bad = [
			".ssh/id_rsa",
			"~/x",
			"~/id_rsa",
			"a/b/c",
			"owner/..",
			"owner/.",
			"owner/name.git",
			"a\\b",
			"./x",
			"../x",
			"C:/x",
			"C:\\x",
			"/Users/x",
			"owner/name/extra",
			"owner name/x",
			"owner/",
			`alpha/${"a".repeat(101)}`,
			`owner/ghp_${"a".repeat(30)}`,
			`owner/github_pat_${"a".repeat(30)}`,
			`owner/sk-${"a".repeat(20)}`,
			`owner/AKIA${"A".repeat(16)}`,
			`owner/xoxb-${"1".repeat(12)}`,
		];
		for (const v of bad)
			expect(ok(payload({ runs: [run({ project: v })] }))).toBe(false);
	});

	test("a two-run report where one project is alpha/.github is accepted in full", () => {
		const r = RunsPayload.safeParse(
			payload({
				runs: [
					run({ run_id: "station0-rule-engine-tests-1" }),
					run({
						run_id: "nwc-m1",
						project: "alpha/.github",
						workflow_id: "ao-w2-m1",
					}),
				],
			}),
		);
		expect(r.success).toBe(true);
		expect(r.data?.runs.map((x) => x.project)).toEqual([
			"EdwardH-jedi/station0",
			"alpha/.github",
		]);
	});

	test("ordinary Office ids pass the opaque-run check", () => {
		const slug = "station0-rule-engine-tests-abcde"; // 32-char hyphenated slug
		expect(slug.length).toBe(32);
		const ev = run().events[0];
		for (const id of [
			"station0-rule-engine-tests-1",
			"station0-validation-notes",
			"nwc-m1",
			"ao-w2-m1",
			slug,
		]) {
			expect(ok(payload({ runs: [run({ run_id: id })] })), id).toBe(true);
			expect(ok(payload({ runs: [run({ workflow_id: id })] })), id).toBe(true);
			expect(
				ok(payload({ runs: [run({ events: [{ ...ev, test_run_key: id }] })] })),
				id,
			).toBe(true);
		}
	});

	test("reason / status / alert: UPPER_SNAKE codes; an opaque token without a known prefix is refused", () => {
		const mixed = "aZ9".repeat(10); // random-looking, no vendor prefix: redact() alone keeps it
		const hexKey = "deadbeef".repeat(5);
		const upperKey = "ABCD1234".repeat(3);
		for (const field of ["reason", "status", "alert"]) {
			for (const v of [
				mixed,
				hexKey,
				upperKey,
				`AKIA${"A".repeat(16)}`,
				"lowercase_reason",
				"_LEADING",
				"HAS SPACE",
				".ENV",
			])
				expect(ok(payload({ runs: [run({ [field]: v })] }))).toBe(false);
		}
		expect(
			ok(
				payload({ runs: [run({ reason: "MISSION_RECONCILIATION_REQUIRED" })] }),
			),
		).toBe(true);
	});

	test("ids and event codes: no leading dot/tilde/dash, no `..`, no drive letter, nothing opaque", () => {
		const ev = run().events[0];
		const bad = [
			".env",
			"~x",
			"-rf",
			"a..b",
			"C:x",
			"aZ9".repeat(10),
			"deadbeef".repeat(5),
		];
		for (const v of bad) {
			expect(ok(payload({ runs: [run({ run_id: v })] }))).toBe(false);
			expect(ok(payload({ runs: [run({ workflow_id: v })] }))).toBe(false);
			expect(ok(payload({ runs: [run({ completed: [v] })] }))).toBe(false);
			for (const key of [
				"transition",
				"task_id",
				"outcome",
				"reason",
				"review_verdict",
				"model",
				"test_run_key",
			])
				expect(
					ok(payload({ runs: [run({ events: [{ ...ev, [key]: v }] })] })),
					`${key}`,
				).toBe(false);
		}
		// real Office shapes stay valid
		expect(
			ok(
				payload({
					runs: [
						run({
							events: [
								{
									...ev,
									model: "claude-sonnet-5-5",
									outcome: "PASS",
									review_verdict: "APPROVE",
								},
							],
						}),
					],
				}),
			),
		).toBe(true);
	});

	test("an error names the field, never the rejected value", () => {
		const secret = "aZ9".repeat(10);
		const r = RunsPayload.safeParse(
			payload({
				runs: [
					run({
						phase: `Bearer ${secret}`,
						project: `.ssh/${secret}`,
						reason: secret,
					}),
				],
			}),
		);
		expect(r.success).toBe(false);
		expect(JSON.stringify(r.error?.issues)).not.toContain(secret);
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
	test("waiting_owner: READY with one of the owner reasons", () => {
		for (const reason of [
			"GOAL_RECORDED",
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
	test("unverified: a finished run (passed / partial) with unchecked evidence never reads as passed", () => {
		expect(s({ status: "PASS", evidence_verified: false })).toBe("unverified");
		expect(s({ status: "PASS", alert: "EVIDENCE_UNVERIFIED" })).toBe(
			"unverified",
		);
		expect(s({ status: "PARTIAL", evidence_verified: false })).toBe(
			"unverified",
		);
		expect(
			s({
				status: "PARTIAL",
				alert: "EVIDENCE_UNVERIFIED",
				evidence_verified: false,
			}),
		).toBe("unverified");
	});
	test("a run in progress keeps its own state when evidence_verified is false (e.g. no signed event yet)", () => {
		expect(s({ status: "RUNNING", evidence_verified: false })).toBe("running");
		expect(
			s({
				status: "READY",
				reason: "AWAITING_PLAN_APPROVAL",
				evidence_verified: false,
			}),
		).toBe("waiting_owner");
		expect(
			s({
				status: "READY",
				reason: "DISPATCH_STOPPED",
				evidence_verified: false,
			}),
		).toBe("paused");
		expect(
			s({
				status: "HOLD",
				reason: "MODEL_CHAIN_EXHAUSTED",
				evidence_verified: false,
			}),
		).toBe("hold");
	});
	test("the EVIDENCE_UNVERIFIED alert (an evidence read error) still wins for every run: it hides a dead-runner alert", () => {
		for (const over of [
			{ status: "RUNNING" },
			{ status: "READY", reason: "DISPATCH_STOPPED" },
			{ status: "READY", reason: "AWAITING_PLAN_APPROVAL" },
			{ status: "HOLD", reason: "MODEL_CHAIN_EXHAUSTED" },
		]) {
			expect(s({ ...over, alert: "EVIDENCE_UNVERIFIED" })).toBe("unverified");
			expect(
				s({ ...over, alert: "EVIDENCE_UNVERIFIED", evidence_verified: false }),
			).toBe("unverified");
		}
	});
	test("an alert other than the evidence one still decides, and is never turned into passed", () => {
		expect(s({ alert: "STALE_OR_IDLE", evidence_verified: false })).toBe(
			"no_progress_suspected",
		);
		expect(
			s({
				status: "PASS",
				alert: "MISSION_RECONCILIATION_REQUIRED",
				evidence_verified: false,
			}),
		).toBe("needs_reconcile");
		expect(
			s({ status: "PASS", alert: "A_NEW_ALERT", evidence_verified: false }),
		).toBe("unknown");
	});
	test("paused: READY with DISPATCH_STOPPED (loop stopped without a failure, tasks left)", () => {
		expect(s({ status: "READY", reason: "DISPATCH_STOPPED" })).toBe("paused");
	});
	test("DISPATCH_STOPPED after a failed loop is HOLD in Office and stays hold, never paused", () => {
		expect(s({ status: "HOLD", reason: "DISPATCH_STOPPED" })).toBe("hold");
		expect(
			s({
				status: "HOLD",
				reason: "DISPATCH_STOPPED",
				alert: "DISPATCH_STOPPED",
			}),
		).toBe("hold");
	});
	test("DISPATCH_STOPPED is paused only as READY; other statuses and alerts are not guessed", () => {
		expect(s({ status: "RUNNING", reason: "DISPATCH_STOPPED" })).toBe(
			"running",
		);
		expect(s({ status: "PASS", reason: "DISPATCH_STOPPED" })).toBe("passed");
		expect(
			s({ status: "READY", reason: "DISPATCH_STOPPED", alert: "A_NEW_ALERT" }),
		).toBe("unknown");
		expect(
			s({
				status: "READY",
				reason: "DISPATCH_STOPPED",
				alert: "MISSION_RECONCILIATION_REQUIRED",
			}),
		).toBe("needs_reconcile");
	});
	test("a combination the table does not list is `unknown`, never a guess", () => {
		expect(s({ status: "READY", reason: "SOMETHING_NEW" })).toBe("unknown");
		expect(s({ status: "READY", reason: null })).toBe("unknown");
		expect(s({ status: "READY", reason: "goal_recorded" })).toBe("unknown");
		expect(s({ status: "READY", reason: "dispatch_stopped" })).toBe("unknown");
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

	test("needs_owner covers waiting_owner, hold, needs_reconcile and unverified (a finished run)", () => {
		const need = (o: Record<string, unknown>) =>
			runStateAt({ ...base, ...o }, iso, "online", at(0)).needs_owner;
		expect(need({ status: "READY", reason: "AWAITING_PLAN_APPROVAL" })).toBe(
			true,
		);
		expect(need({ status: "READY", reason: "GOAL_RECORDED" })).toBe(true);
		expect(need({ status: "HOLD" })).toBe(true);
		expect(need({ alert: "FAILED_PROCESS_RECONCILE" })).toBe(true);
		expect(need({ status: "PASS", evidence_verified: false })).toBe(true);
		expect(need({ status: "PARTIAL", alert: "EVIDENCE_UNVERIFIED" })).toBe(
			true,
		);
		expect(need({})).toBe(false);
		// in progress: unchecked evidence alone does not page the owner
		expect(need({ evidence_verified: false })).toBe(false);
		expect(need({ status: "READY", reason: "DISPATCH_STOPPED" })).toBe(false);
		expect(
			need({
				status: "READY",
				reason: "DISPATCH_STOPPED",
				evidence_verified: false,
			}),
		).toBe(false);
		expect(
			need({
				status: "READY",
				reason: "AWAITING_PLAN_APPROVAL",
				evidence_verified: false,
			}),
		).toBe(true);
		expect(need({ alert: "STALE_OR_IDLE" })).toBe(false);
		expect(need({ status: "PASS" })).toBe(false);
	});

	test("paused display: shown as paused, not needing the owner, and goes stale like any unfinished run", () => {
		const paused = { ...base, status: "READY", reason: "DISPATCH_STOPPED" };
		const fresh = runStateAt(paused, iso, "online", at(1_000));
		expect(fresh).toEqual({
			display: "paused",
			last_display: "paused",
			needs_owner: false,
		});
		const old = runStateAt(paused, iso, "online", at(90_000));
		expect(old.display).toBe("snapshot_stale");
		expect(old.last_display).toBe("paused");
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

describe("compareInstants — exact order of observed_at", () => {
	test("same instant at different precision or offset is equal", () => {
		expect(
			compareInstants("2026-01-01T00:00:00.1Z", "2026-01-01T00:00:00.100Z"),
		).toBe(0);
		expect(
			compareInstants("2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000Z"),
		).toBe(0);
		expect(
			compareInstants(
				"2026-01-01T10:00:00.5+10:00",
				"2026-01-01T00:00:00.500Z",
			),
		).toBe(0);
	});

	test("two instants inside one millisecond keep their order (Date.parse would call them equal)", () => {
		const older = "2026-01-01T00:00:00.0004Z";
		const newer = "2026-01-01T00:00:00.00041Z";
		expect(Date.parse(older)).toBe(Date.parse(newer));
		expect(compareInstants(older, newer)).toBeLessThan(0);
		expect(compareInstants(newer, older)).toBeGreaterThan(0);
	});

	test("offsets are applied before comparing", () => {
		// 09:00+10:00 is 23:00Z the day before
		expect(
			compareInstants("2026-01-01T09:00:00+10:00", "2026-01-01T00:00:00Z"),
		).toBeLessThan(0);
		expect(
			compareInstants(
				"2026-01-01T00:00:01Z",
				"2026-01-01T09:00:00.999999+09:00",
			),
		).toBeGreaterThan(0);
	});

	test("an invalid value is never newer than a valid one", () => {
		expect(compareInstants("garbage", "2026-01-01T00:00:00Z")).toBeLessThan(0);
		expect(compareInstants("2026-01-01T00:00:00Z", "garbage")).toBeGreaterThan(
			0,
		);
	});
});
