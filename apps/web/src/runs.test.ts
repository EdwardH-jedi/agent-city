import { describe, expect, test } from "bun:test";
import type { MachineView, RunView } from "@agent-city/schema";
import { mergeRuns, parseHubMessage, runsAt } from "./merge.ts";

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const iso = (ms: number) => new Date(T0 + ms).toISOString();

const view = (over: Partial<RunView> = {}): RunView => ({
	machine_id: "cockpit",
	run_id: "station0-notes-2",
	project: "EdwardH-jedi/station0",
	workflow_id: "station0-validation-notes",
	phase: "QA",
	status: "RUNNING",
	reason: "RECORDER_CHECK_RUNNING",
	alert: null,
	last_progress_at: iso(0),
	idle_seconds: 5,
	completed: [],
	tokens_today: 100,
	usage_unknown: false,
	evidence_verified: true,
	last_event_sequence: 7,
	ledger_revision: 42,
	reported_at: iso(0),
	display: "running",
	last_display: "running",
	needs_owner: false,
	...over,
});

const machine = (
	status: MachineView["status"],
	id: MachineView["id"] = "cockpit",
): MachineView => ({
	id,
	hostname: null,
	heartbeat_at: status === "unobserved" ? null : iso(0),
	interval_s: 30,
	status,
});

describe("mergeRuns", () => {
	test("upserts by (machine, run)", () => {
		const out = mergeRuns(
			[view()],
			[
				view({ run_id: "other" }),
				view({ phase: "Report", ledger_revision: 43 }),
			],
		);
		expect(out).toHaveLength(2);
		expect(out.find((r) => r.run_id === "station0-notes-2")?.phase).toBe(
			"Report",
		);
	});

	test("a snapshot older than a live message never replaces it", () => {
		const live = view({ ledger_revision: 50, phase: "Integration" });
		const snapshot = view({ ledger_revision: 49, phase: "QA" });
		expect(mergeRuns([live], [snapshot])[0]?.phase).toBe("Integration");
	});

	test("same revision: the higher last_event_sequence wins, then the later receive time", () => {
		const a = view({ last_event_sequence: 8, phase: "A" });
		const b = view({ last_event_sequence: 7, phase: "B" });
		expect(mergeRuns([a], [b])[0]?.phase).toBe("A");
		const c = view({ reported_at: iso(5_000), phase: "C" });
		expect(mergeRuns([view({ phase: "D" })], [c])[0]?.phase).toBe("C");
	});

	test("runs of different machines do not collide", () => {
		const out = mergeRuns([view()], [view({ machine_id: "forge" })]);
		expect(out).toHaveLength(2);
	});
});

describe("runsAt — this screen's clock and the cockpit's current state decide", () => {
	test("a fresh report from an online cockpit shows as reported", () => {
		const [r] = runsAt([view()], [machine("online")], T0 + 5_000);
		expect(r?.display).toBe("running");
	});

	test("running turns snapshot_stale at 90 s with no new message", () => {
		const out = (ms: number) =>
			runsAt([view()], [machine("online")], T0 + ms)[0];
		expect(out(89_000)?.display).toBe("running");
		expect(out(90_000)?.display).toBe("snapshot_stale");
		expect(out(90_000)?.last_display).toBe("running");
	});

	test("an offline cockpit makes a running report snapshot_stale at once", () => {
		const [r] = runsAt([view()], [machine("offline")], T0 + 1_000);
		expect(r?.display).toBe("snapshot_stale");
	});

	test("a cockpit never heard from does not hide a fresh report", () => {
		const [r] = runsAt([view()], [machine("unobserved")], T0 + 1_000);
		expect(r?.display).toBe("running");
	});

	test("a passed run stays passed, and a hold stays on the owner's list when stale", () => {
		const pass = view({
			status: "PASS",
			display: "passed",
			last_display: "passed",
		});
		expect(
			runsAt([pass], [machine("offline")], T0 + 3_600_000)[0]?.display,
		).toBe("passed");
		const hold = view({ status: "HOLD", reason: "MODEL_CHAIN_EXHAUSTED" });
		const [h] = runsAt([hold], [machine("online")], T0 + 3_600_000);
		expect(h?.display).toBe("snapshot_stale");
		expect(h?.needs_owner).toBe(true);
	});

	test("does not mutate its input", () => {
		const input = [view()];
		runsAt(input, [machine("offline")], T0 + 1_000);
		expect(input[0]?.display).toBe("running");
	});
});

describe("parseHubMessage", () => {
	test("accepts a run frame", () => {
		const msg = parseHubMessage(JSON.stringify({ kind: "run", data: view() }));
		expect(msg?.kind).toBe("run");
	});
});
