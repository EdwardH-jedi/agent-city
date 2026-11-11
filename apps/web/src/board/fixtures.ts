// Test fixtures for the board. Fake data only; no real repo or machine names beyond the role ids.
import type {
	MachineView,
	RunEventView,
	RunView,
	Session,
} from "@agent-city/schema";
import { type ModelInput, toVillageModel, type VillageModel } from "./model.ts";
import { parseSessionWait, recentSessions } from "./sessions.ts";
import {
	type Cue,
	isAudible,
	parseSoundPrefs,
	planSounds,
	quietEndHour,
	type SoundMemory,
} from "./sound.ts";
import { currentRuns } from "./types.ts";
import { emptyWatch, stepWatch, type Watch } from "./visits.ts";

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

/** A Claude Code session as GET /api/sessions returns it. Fake ids, no real folder. */
export const session = (over: Partial<Session> = {}): Session => ({
	id: "claude:fake-session-1",
	provider: "claude",
	machine_id: "cockpit",
	repo_id: "acme/widgets",
	cwd: "/home/someone/acme/widgets",
	branch: "feat/secret-branch-name",
	model: null,
	status: "active",
	started_at: iso(-600_000),
	last_event_at: iso(-10_000),
	ended_at: null,
	rev: 1,
	...over,
});

/**
 * The board's per-tick pipeline on a fake clock, as Board.tsx runs it: step the watch, build the
 * model, plan the sounds. `step(now, input)` returns the model and the cues of that tick.
 */
export function screen(search = "") {
	const prefs = parseSoundPrefs(search);
	const sessionWaitMs = parseSessionWait(search);
	let watch: Watch = emptyWatch();
	let memory: SoundMemory | null = null;
	return {
		step(
			now: number,
			input: Omit<ModelInput, "now" | "conn" | "watch"> & {
				conn?: ModelInput["conn"];
			},
		): { model: VillageModel; cues: Cue[] } {
			watch = stepWatch(
				watch,
				currentRuns(input.runs),
				now,
				recentSessions(input.sessions ?? [], now),
				input.machines,
			);
			const model = toVillageModel({
				conn: "open",
				sessionWaitMs,
				...input,
				now,
				watch,
			});
			const cockpit =
				model.machines.find((m) => m.id === "cockpit")?.status ?? "unobserved";
			const audible = isAudible({
				prefs,
				date: new Date(now),
				cockpit,
				conn: model.conn,
			});
			const plan = planSounds(
				memory,
				model.marks,
				now,
				audible,
				quietEndHour(prefs),
			);
			memory = plan.memory;
			return { model, cues: plan.cues };
		},
	};
}
