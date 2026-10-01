// Pure labelling rules for managed tasks (unit-tested in managed-view.test.ts). No React, no DOM.
// The point of this file: a simulated result, a live result whose integration was never verified,
// a failed attempt and a genuinely human-ready result must never look alike.
import {
	type FailureKind,
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

/** Acceptance criteria: one per line. Commas are part of a criterion, never a separator. */
export const splitLines = (text: string): string[] =>
	text
		.split(/\r?\n/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

/** What the create form sends (without the idempotency key). */
export interface Submission {
	repo_id: string;
	title: string;
	objective: string;
	acceptance_criteria: string[];
	approved_scope: string[];
	execution_mode: "simulated" | "live";
	simulation_scenario?: string;
	repair_limit: number;
}

/** Same request, field by field — decides whether a retry may reuse an uncertain key. */
export function sameSubmission(a: Submission, b: Submission): boolean {
	const list = (x: string[], y: string[]) =>
		x.length === y.length && x.every((v, i) => v === y[i]);
	return (
		a.repo_id === b.repo_id &&
		a.title === b.title &&
		a.objective === b.objective &&
		list(a.acceptance_criteria, b.acceptance_criteria) &&
		list(a.approved_scope, b.approved_scope) &&
		a.execution_mode === b.execution_mode &&
		(a.simulation_scenario ?? null) === (b.simulation_scenario ?? null) &&
		a.repair_limit === b.repair_limit
	);
}

/** Does `incoming` describe a later (or the same) version of the task than `current`? */
export const newerTask = (
	incoming: Pick<ManagedTask, "rev">,
	current: Pick<ManagedTask, "rev">,
): boolean => incoming.rev >= current.rev;

export interface Diagnosis {
	/** Where the attempt stopped (stage of the newest run), or null when nothing ran. */
	stage: string | null;
	/** Why it is not moving / what ended it. */
	reason: string | null;
	/** The last state the hub committed, and when. */
	lastTransition: string;
	workspace: "intact" | "changed" | "not checked";
	evidence: "intact" | "invalid" | "not checked";
	/** The next safe thing a person can do. Never an override of a safety check. */
	nextAction: string;
}

const NEXT_FOR_KIND: Partial<Record<FailureKind, string>> = {
	provider_auth:
		"Sign in to the provider yourself (subscription login), check the auth settings in MANAGED_CONFIG, then Run again.",
	provider_quota: "Wait for your plan's limit to reset, then Run again.",
	provider_model:
		"Pick a model your login can use in MANAGED_CONFIG, then Run again.",
	provider_unavailable:
		"Fix the provider executable / required controls reported in the detail (see managed:preflight), then Run again.",
	approval_void:
		"The task or the managed policy changed after approval: review the change, then Run again to re-approve.",
	verification_missing:
		"Configure verification commands for this repository in MANAGED_CONFIG, restart the hub, then Run again.",
	verification_unavailable:
		"Make the verification commands runnable (missing tool, timeout), then Run again.",
	repo_invalid: "Fix the repository entry in MANAGED_CONFIG, then Run again.",
	workspace_error:
		"Check the repository and workspace root on disk, then Run again.",
	evidence_invalid:
		"Stored evidence was changed after it was recorded: treat this attempt as untrusted and create a new task or Run again.",
	candidate_mutated:
		"Something changed the workspace outside the pipeline: inspect it; create a new task or Run again for a fresh attempt.",
	scope_violation:
		"The change touched files outside the approved scope: adjust the task (scope or objective) and create a new task.",
	no_changes:
		"The implementer changed nothing: refine the objective and create a new task.",
	verification_failed:
		"Inspect the verification log; refine the task and create a new one.",
	review_rejected:
		"Read the review findings; refine the task and create a new one.",
	repair_limit_exhausted:
		"Read the last review findings; refine the task and create a new one (repairs are used up).",
	review_invalid:
		"The reviewer's output did not count; check the review log, then create a new task.",
	provider_output_invalid:
		"The implementer's output was not valid; check its log, then create a new task.",
	provider_error:
		"Check the provider log for the error, then create a new task.",
	timeout:
		"Raise the provider timeout in MANAGED_CONFIG if appropriate, then create a new task.",
	interrupted:
		"The hub stopped mid-stage: inspect the preserved workspace; Run again for a fresh attempt.",
	internal_error: "Check the hub log for the error message, then Run again.",
};

/** Read-only diagnosis of one task (no controls, no overrides). */
export function diagnose(
	task: Pick<
		ManagedTask,
		"state" | "failure_kind" | "state_detail" | "updated_at" | "execution_mode"
	>,
	runs: readonly Pick<ManagedRun, "phase" | "attempt_no" | "state">[],
	integrity: Integrity | null,
	evidenceIntact: boolean | null,
	quarantined: boolean,
): Diagnosis {
	const last = runs.at(-1);
	const workspace = integrity
		? integrity.intact
			? "intact"
			: "changed"
		: "not checked";
	const evidence =
		evidenceIntact === null
			? "not checked"
			: evidenceIntact
				? "intact"
				: "invalid";
	let nextAction: string;
	if (quarantined)
		nextAction =
			"A child process could not be proven terminated: stop it yourself. The quarantine releases on its own once the process is gone; nothing else can run until then.";
	else if (evidence === "invalid")
		nextAction = NEXT_FOR_KIND.evidence_invalid ?? "";
	else if (task.state === "human_ready")
		nextAction =
			workspace === "changed"
				? "The workspace changed after review: inspect it; the reviewed candidate is no longer what is on disk."
				: task.execution_mode === "simulated"
					? "Simulated result: nothing to merge. Use it to check the pipeline, not the work."
					: "Inspect the diff, evidence and review; merge or discard the branch yourself.";
	else if (task.state === "draft")
		nextAction = "Approve & run when the task is right.";
	else if (task.state === "cancelled")
		nextAction = "Nothing to do; create a new task if needed.";
	else if (isActiveTaskState(task.state) || task.state === "queued")
		nextAction = "Wait, or Cancel. The UI updates on its own.";
	else
		nextAction =
			(task.failure_kind && NEXT_FOR_KIND[task.failure_kind]) ||
			"Inspect the detail and logs.";
	return {
		stage: last
			? `attempt ${last.attempt_no}: ${last.phase} (${last.state})`
			: null,
		reason: task.failure_kind
			? `${task.failure_kind}: ${task.state_detail ?? "no detail recorded"}`
			: (task.state_detail ?? null),
		lastTransition: `${task.state} at ${task.updated_at}`,
		workspace,
		evidence,
		nextAction,
	};
}
