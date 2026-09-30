// Managed task state machine. Pure — the hub's managed store applies canTransition() on every state
// write. Deliberately separate from status.ts: an observed session going idle/ended says nothing
// about whether a managed task's work passed verification or review.
import type { FailureKind, TaskState } from "./managed.ts";

/** States in which a worker owns the task (and may own a child process). */
export const ACTIVE_TASK_STATES: readonly TaskState[] = [
	"executing",
	"verifying",
	"reviewing",
	"repairing",
];

/** Nothing moves out of these. */
export const TERMINAL_TASK_STATES: readonly TaskState[] = [
	"human_ready",
	"failed",
	"cancelled",
];

const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
	draft: ["queued", "cancelled"],
	queued: ["executing", "blocked", "failed", "cancelled"],
	executing: ["verifying", "failed", "blocked", "cancelled", "interrupted"],
	repairing: ["verifying", "failed", "blocked", "cancelled", "interrupted"],
	verifying: [
		"reviewing",
		"repairing",
		"failed",
		"blocked",
		"cancelled",
		"interrupted",
	],
	reviewing: [
		"human_ready",
		"repairing",
		"failed",
		"blocked",
		"cancelled",
		"interrupted",
	],
	// A person may explicitly run these again (a fresh attempt in a fresh worktree).
	interrupted: ["queued", "cancelled"],
	blocked: ["queued", "cancelled"],
	human_ready: [],
	failed: [],
	cancelled: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
	return TRANSITIONS[from].includes(to);
}

export const isActiveTaskState = (s: TaskState): boolean =>
	ACTIVE_TASK_STATES.includes(s);

export const isTerminalTaskState = (s: TaskState): boolean =>
	TERMINAL_TASK_STATES.includes(s);

/** States from which the Run action queues the task. */
export const RUNNABLE_TASK_STATES: readonly TaskState[] = [
	"draft",
	"interrupted",
	"blocked",
];

/**
 * Failure kinds that say "the tool could not run", never "the code is bad" (ARCHITECTURE #8).
 * They end in `blocked` (a person can fix the environment and run again), not `failed`.
 */
const BLOCKER_KINDS: ReadonlySet<FailureKind> = new Set<FailureKind>([
	"provider_unavailable",
	"provider_auth",
	"provider_quota",
	"provider_model",
	"verification_unavailable",
	"verification_missing",
	"approval_void",
	"repo_invalid",
	"workspace_error",
]);

export function outcomeStateFor(kind: FailureKind): "blocked" | "failed" {
	return BLOCKER_KINDS.has(kind) ? "blocked" : "failed";
}
