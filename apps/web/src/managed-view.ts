// Pure labelling rules for managed tasks (unit-tested in managed-view.test.ts). No React, no DOM.
// The point of this file: a simulated result, a live result whose integration was never verified,
// a failed attempt and a genuinely human-ready result must never look alike.
import {
	isActiveTaskState,
	isTerminalTaskState,
	type ManagedRun,
	type ManagedTask,
	RUNNABLE_TASK_STATES,
} from "@agent-city/schema";

export type Tone = "sim" | "ok" | "info" | "warn" | "bad" | "muted";
export interface Badge {
	text: string;
	tone: Tone;
}

export interface Integrity {
	intact: boolean;
	reason: string | null;
}

/** How the task was (or will be) executed — always shown next to the state. */
export function modeBadge(
	task: Pick<ManagedTask, "execution_mode">,
	liveIntegrationVerified: boolean,
): Badge {
	if (task.execution_mode === "simulated")
		return { text: "SIMULATED — no model", tone: "sim" };
	return liveIntegrationVerified
		? { text: "LIVE", tone: "info" }
		: { text: "LIVE — integration not live-verified", tone: "warn" };
}

export function stateBadge(
	task: Pick<ManagedTask, "state" | "execution_mode">,
	integrity: Integrity | null = null,
): Badge {
	switch (task.state) {
		case "human_ready":
			if (integrity && !integrity.intact)
				return { text: "stale — workspace changed after review", tone: "bad" };
			return task.execution_mode === "simulated"
				? { text: "simulated human-ready", tone: "sim" }
				: { text: "human-ready", tone: "ok" };
		case "failed":
			return { text: "failed", tone: "bad" };
		case "blocked":
			return { text: "blocked", tone: "warn" };
		case "interrupted":
			return { text: "interrupted — needs attention", tone: "warn" };
		case "cancelled":
			return { text: "cancelled", tone: "muted" };
		case "draft":
			return { text: "draft — not approved to run", tone: "muted" };
		case "queued":
			return { text: "queued", tone: "info" };
		default:
			return { text: task.state, tone: "info" };
	}
}

export const canRun = (task: Pick<ManagedTask, "state">): boolean =>
	RUNNABLE_TASK_STATES.includes(task.state);

/** Cancel is offered until the task is finished; a pending cancel is shown, not re-offered. */
export const canCancel = (
	task: Pick<ManagedTask, "state" | "cancel_requested_at">,
): boolean =>
	!isTerminalTaskState(task.state) && task.cancel_requested_at === null;

export const isActive = (task: Pick<ManagedTask, "state">): boolean =>
	task.state === "queued" || isActiveTaskState(task.state);

export function runLabel(task: Pick<ManagedTask, "state">): string {
	return task.state === "draft" ? "Approve & run" : "Run again (new attempt)";
}

/** Why the task is not moving, in one line; null when there is nothing to explain. */
export function blockingReason(
	task: Pick<
		ManagedTask,
		"state" | "failure_kind" | "state_detail" | "cancel_requested_at"
	>,
): string | null {
	if (isActiveTaskState(task.state) && task.cancel_requested_at)
		return "cancel requested — waiting for the process to be confirmed terminated";
	if (!task.failure_kind) return null;
	return `${task.failure_kind}: ${task.state_detail ?? "no detail recorded"}`;
}

/** Resolved model as reported by the provider, or an explicit "unknown" — never the request. */
export function modelLabel(
	run: Pick<ManagedRun, "model_requested" | "model_resolved">,
): string {
	const resolved = run.model_resolved ?? "unknown";
	return run.model_requested
		? `requested ${run.model_requested} → resolved ${resolved}`
		: `resolved ${resolved}`;
}

export const shortSha = (sha: string | null): string =>
	sha ? sha.slice(0, 10) : "—";

/** One per line / comma separated → trimmed, non-empty entries. */
export const splitList = (text: string): string[] =>
	text
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
