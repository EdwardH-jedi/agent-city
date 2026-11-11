// Test fixtures for the board. Fake data only; no real repo or machine names beyond the role ids.
import type { MachineView, RunEventView, RunView } from "@agent-city/schema";

export const T0 = Date.UTC(2026, 10, 11, 5, 0, 0);
export const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

export const run = (over: Partial<RunView> = {}): RunView => ({
	machine_id: "cockpit",
	run_id: "demo-flow-1",
	project: "acme/widgets",
	workflow_id: "demo-flow",
	phase: "Implementation",
	status: "RUNNING",
	reason: null,
	alert: null,
	last_progress_at: iso(-60_000),
	idle_seconds: 5,
	completed: [],
	tokens_today: 1000,
	usage_unknown: false,
	evidence_verified: true,
	last_event_sequence: 3,
	ledger_revision: 1,
	observed_at: iso(-10_000),
	reported_at: iso(-10_000),
	display: "running",
	last_display: "running",
	needs_owner: false,
	...over,
});

/** A run in a given reported state (display and last_display both set). */
export const runIn = (
	state: RunView["last_display"],
	over: Partial<RunView> = {},
): RunView =>
	run({
		display: state,
		last_display: state,
		needs_owner: [
			"waiting_owner",
			"hold",
			"needs_reconcile",
			"unverified",
		].includes(state),
		...over,
	});

export const machine = (
	status: MachineView["status"],
	id: MachineView["id"] = "cockpit",
	beatAgoMs = 5_000,
): MachineView => ({
	id,
	hostname: null,
	heartbeat_at: status === "unobserved" ? null : iso(-beatAgoMs),
	interval_s: 30,
	status,
});

export const ev = (over: Partial<RunEventView> = {}): RunEventView => ({
	sequence: 1,
	transition: "task.completed",
	occurred_at: iso(-30_000),
	task_id: "T1",
	attempt: 1,
	outcome: "passed",
	reason: null,
	review_verdict: null,
	commit: null,
	base_commit: null,
	diff_digest: null,
	tree_digest: null,
	test_run_key: null,
	model: null,
	from_model: null,
	to_model: null,
	...over,
});
