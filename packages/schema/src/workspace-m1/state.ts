// Workspace state machine (web-safe, pure; like managed-status.ts). The workspace task stores a
// coarse `stage` written with CAS on `rev`; the fine engine detail (executing / verifying /
// reviewing / repairing, quarantine, cancel pending) is DERIVED from the linked managed task and
// never copied. Observed session telemetry is a separate, read-only world: nothing here reads it.
import { z } from "zod";
import type { TaskState } from "../managed.ts";
import type { ApprovalKind } from "./binding.ts";
import type { DecisionAction } from "./decision.ts";

// ── stored workspace stage ─────────────────────────────────────────────────

export const WorkspaceStage = z.enum([
	/** Editing; no live approval request. */
	"draft",
	/** Gate 1 pending: an immutable proposal + a reserved (draft) managed task await Edward. */
	"awaiting_run_approval",
	/** Gate 1 approved: the managed task is queued (not yet started). */
	"queued",
	/** The managed task is active (detail derived: executing / verifying / reviewing / repairing). */
	"running",
	/** Cancel intent persisted; NOT cancelled until the engine confirms termination. */
	"cancel_requested",
	/** Engine `human_ready` + a pending result request (Gate 2). Not accepted. */
	"awaiting_acceptance",
	/** Gate 2 accepted (terminal). Engine stays `human_ready`; nothing is merged. */
	"accepted",
	/** Rejected at either gate (terminal). */
	"rejected",
	/** Changes requested at either gate: edit the draft → new proposal version → new Gate 1. */
	"changes_requested",
	/** The execution ended without an acceptable result (engine blocked / failed / interrupted, or the result could not be sealed or was invalidated). */
	"execution_ended",
	/** The execution was cancelled (termination confirmed) or the Gate-1 request was withdrawn. */
	"cancelled",
]);
export type WorkspaceStage = z.infer<typeof WorkspaceStage>;

export const TERMINAL_WORKSPACE_STAGES: readonly WorkspaceStage[] = [
	"accepted",
	"rejected",
];

/** Stages from which the operator may publish a new proposal version (opens a new Gate 1). */
export const PUBLISHABLE_STAGES: readonly WorkspaceStage[] = [
	"draft",
	"changes_requested",
	"execution_ended",
	"cancelled",
	"awaiting_run_approval",
];

/** Stages from which the operator may request a new execution of the CURRENT proposal. */
export const RERUNNABLE_STAGES: readonly WorkspaceStage[] = [
	"draft",
	"execution_ended",
	"cancelled",
];

/** Stages in which the operator may cancel (withdraw a pending Gate 1, or stop the execution). */
export const CANCELLABLE_STAGES: readonly WorkspaceStage[] = [
	"awaiting_run_approval",
	"queued",
	"running",
	"cancel_requested",
];

/** The draft may be saved in every non-terminal stage; saving never changes authority. */
export const isDraftEditable = (s: WorkspaceStage): boolean =>
	!TERMINAL_WORKSPACE_STAGES.includes(s);

export const isTerminalWorkspaceStage = (s: WorkspaceStage): boolean =>
	TERMINAL_WORKSPACE_STAGES.includes(s);

export type WorkspaceActor = "operator" | "engine" | "reconciler";

export const WorkspaceTrigger = z.enum([
	"publish_proposal",
	"request_rerun",
	"gate1_approve",
	"gate1_request_changes",
	"gate1_reject",
	"run_request_invalidated",
	"cancel",
	"engine_started",
	"engine_ended",
	"engine_cancelled",
	"result_ready",
	"result_unavailable",
	"cancel_won",
	"gate2_accept",
	"gate2_request_changes",
	"gate2_reject",
	"result_invalidated",
]);
export type WorkspaceTrigger = z.infer<typeof WorkspaceTrigger>;

export interface WorkspaceTransition {
	from: WorkspaceStage;
	to: WorkspaceStage;
	trigger: WorkspaceTrigger;
	actors: readonly WorkspaceActor[];
}

const OP: readonly WorkspaceActor[] = ["operator"];
const ENG: readonly WorkspaceActor[] = ["engine", "reconciler"];
const REC: readonly WorkspaceActor[] = ["reconciler"];

const t = (
	from: WorkspaceStage,
	to: WorkspaceStage,
	trigger: WorkspaceTrigger,
	actors: readonly WorkspaceActor[],
): WorkspaceTransition => ({ from, to, trigger, actors });

/**
 * Every legal stage change. Preconditions and atomic effects per row: INTERFACE.md §6.
 * `engine` = the bridge observing its managed task; `reconciler` = boot/restart reconciliation and
 * invalidation sweeps (it may also apply every engine observation).
 */
export const WORKSPACE_TRANSITIONS: readonly WorkspaceTransition[] = [
	// open Gate 1
	t("draft", "awaiting_run_approval", "publish_proposal", OP),
	t("changes_requested", "awaiting_run_approval", "publish_proposal", OP),
	t("execution_ended", "awaiting_run_approval", "publish_proposal", OP),
	t("cancelled", "awaiting_run_approval", "publish_proposal", OP),
	t("awaiting_run_approval", "awaiting_run_approval", "publish_proposal", OP),
	t("draft", "awaiting_run_approval", "request_rerun", OP),
	t("execution_ended", "awaiting_run_approval", "request_rerun", OP),
	t("cancelled", "awaiting_run_approval", "request_rerun", OP),
	// Gate 1
	t("awaiting_run_approval", "queued", "gate1_approve", OP),
	t("awaiting_run_approval", "changes_requested", "gate1_request_changes", OP),
	t("awaiting_run_approval", "rejected", "gate1_reject", OP),
	t("awaiting_run_approval", "draft", "run_request_invalidated", REC),
	t("awaiting_run_approval", "cancelled", "cancel", OP),
	// execution
	t("queued", "running", "engine_started", ENG),
	t("queued", "cancelled", "cancel", OP),
	t("queued", "cancel_requested", "cancel", OP),
	t("queued", "execution_ended", "engine_ended", ENG),
	t("queued", "cancelled", "engine_cancelled", ENG),
	t("queued", "awaiting_acceptance", "result_ready", ENG),
	t("queued", "execution_ended", "result_unavailable", ENG),
	t("running", "cancel_requested", "cancel", OP),
	t("running", "execution_ended", "engine_ended", ENG),
	t("running", "cancelled", "engine_cancelled", ENG),
	t("running", "awaiting_acceptance", "result_ready", ENG),
	t("running", "execution_ended", "result_unavailable", ENG),
	t("cancel_requested", "cancelled", "engine_cancelled", ENG),
	t("cancel_requested", "cancelled", "cancel_won", ENG),
	t("cancel_requested", "execution_ended", "engine_ended", ENG),
	// Gate 2
	t("awaiting_acceptance", "accepted", "gate2_accept", OP),
	t("awaiting_acceptance", "changes_requested", "gate2_request_changes", OP),
	t("awaiting_acceptance", "rejected", "gate2_reject", OP),
	t("awaiting_acceptance", "execution_ended", "result_invalidated", REC),
];

export function findWorkspaceTransition(
	from: WorkspaceStage,
	to: WorkspaceStage,
	trigger: WorkspaceTrigger,
	actor: WorkspaceActor,
): WorkspaceTransition | null {
	return (
		WORKSPACE_TRANSITIONS.find(
			(x) =>
				x.from === from &&
				x.to === to &&
				x.trigger === trigger &&
				x.actors.includes(actor),
		) ?? null
	);
}

export const canTransitionWorkspace = (
	from: WorkspaceStage,
	to: WorkspaceStage,
	trigger: WorkspaceTrigger,
	actor: WorkspaceActor,
): boolean => findWorkspaceTransition(from, to, trigger, actor) !== null;

// ── approval requests ──────────────────────────────────────────────────────

export const ApprovalStatus = z.enum([
	"pending",
	"approved",
	"accepted",
	"changes_requested",
	"rejected",
	"invalidated",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

/** Why a request lost its authority. Closed set; the free-text detail is separate. */
export const InvalidationReason = z.enum([
	/** A newer proposal version was published for the task. */
	"proposal_superseded",
	/** The operator cancelled while Gate 1 was pending. */
	"withdrawn",
	/** policy_hash / config of the repo changed before the decision. */
	"policy_changed",
	/** The repo left the allowlist or the base commit is no longer resolvable. */
	"repo_unavailable",
	/** The execution ended before a decision (Gate 2 subject gone). */
	"execution_ended",
	/** Cancel intent won over a finished result. */
	"task_cancelled",
	/** Required evidence could not be verified when sealing (request created already closed). */
	"evidence_unavailable",
	/** Re-sealing at decision time did not reproduce the bound envelope hash. */
	"integrity_failed",
	/** The candidate workspace no longer matches the candidate commit. */
	"candidate_mutated",
]);
export type InvalidationReason = z.infer<typeof InvalidationReason>;

const DECIDED: Readonly<Record<ApprovalKind, readonly ApprovalStatus[]>> = {
	run: ["approved", "changes_requested", "rejected", "invalidated"],
	result: ["accepted", "changes_requested", "rejected", "invalidated"],
};

/** Only `pending` moves, exactly once. Every other status is final (no stale request regains authority). */
export const canTransitionApproval = (
	kind: ApprovalKind,
	from: ApprovalStatus,
	to: ApprovalStatus,
): boolean => from === "pending" && DECIDED[kind].includes(to);

export function approvalStatusFor(action: DecisionAction): ApprovalStatus {
	switch (action) {
		case "approve":
			return "approved";
		case "accept":
			return "accepted";
		case "request_changes":
			return "changes_requested";
		case "reject":
			return "rejected";
	}
}

/** Workspace stage + trigger a decision produces (from awaiting_run_approval / awaiting_acceptance). */
export function stageAfterDecision(
	kind: ApprovalKind,
	action: DecisionAction,
): { to: WorkspaceStage; trigger: WorkspaceTrigger } {
	if (kind === "run")
		switch (action) {
			case "approve":
				return { to: "queued", trigger: "gate1_approve" };
			case "request_changes":
				return { to: "changes_requested", trigger: "gate1_request_changes" };
			default:
				return { to: "rejected", trigger: "gate1_reject" };
		}
	switch (action) {
		case "accept":
			return { to: "accepted", trigger: "gate2_accept" };
		case "request_changes":
			return { to: "changes_requested", trigger: "gate2_request_changes" };
		default:
			return { to: "rejected", trigger: "gate2_reject" };
	}
}

/** The stage a request of `kind` can be decided in. */
export const DECISION_STAGE: Readonly<Record<ApprovalKind, WorkspaceStage>> = {
	run: "awaiting_run_approval",
	result: "awaiting_acceptance",
};

// ── engine observations (bridge) ───────────────────────────────────────────

export interface EngineObservation {
	state: TaskState;
	/** managed_tasks.cancel_requested_at is set. */
	cancel_requested: boolean;
	/** An open managed_quarantine row exists for the task. */
	quarantined: boolean;
}

export type EngineEffect =
	| { kind: "none" }
	| { kind: "transition"; to: WorkspaceStage; trigger: WorkspaceTrigger }
	/** Engine reached human_ready: seal the result envelope, then apply stageAfterSealing. */
	| { kind: "seal_result" }
	/** Cancel pending, engine interrupted with no open quarantine: call requestCancel again. */
	| { kind: "reissue_cancel" }
	/** The reserved/queued managed task is in a state the workspace never authorized. */
	| { kind: "violation"; detail: string };

const ACTIVE: readonly TaskState[] = [
	"executing",
	"verifying",
	"reviewing",
	"repairing",
];
const ENDED: readonly TaskState[] = ["blocked", "failed", "interrupted"];

/**
 * What an observed managed-task state means for the workspace stage. Pure; the bridge applies the
 * result with CAS. Stages not listed react to nothing (awaiting_acceptance stays even though the
 * engine is human_ready; terminal stages never move).
 */
export function engineStageEffect(
	stage: WorkspaceStage,
	o: EngineObservation,
): EngineEffect {
	const none = { kind: "none" } as const;
	const go = (to: WorkspaceStage, trigger: WorkspaceTrigger): EngineEffect => ({
		kind: "transition",
		to,
		trigger,
	});
	switch (stage) {
		case "awaiting_run_approval":
			return o.state === "draft" || o.state === "cancelled"
				? none
				: {
						kind: "violation",
						detail: `reserved managed task is ${o.state} without a Gate-1 approval`,
					};
		case "queued":
		case "running":
			if (ACTIVE.includes(o.state))
				return stage === "queued" ? go("running", "engine_started") : none;
			if (ENDED.includes(o.state)) return go("execution_ended", "engine_ended");
			if (o.state === "cancelled") return go("cancelled", "engine_cancelled");
			if (o.state === "human_ready") return { kind: "seal_result" };
			if (o.state === "draft")
				return {
					kind: "violation",
					detail: "approved managed task is back in draft",
				};
			return none; // queued
		case "cancel_requested":
			if (o.state === "cancelled") return go("cancelled", "engine_cancelled");
			if (o.state === "human_ready") return go("cancelled", "cancel_won");
			if (o.state === "failed" || o.state === "blocked")
				return go("execution_ended", "engine_ended");
			if (o.state === "interrupted")
				return o.quarantined ? none : { kind: "reissue_cancel" };
			return none; // queued / active: termination not yet confirmed
		default:
			return none;
	}
}

/** After sealing (seal_result): eligible → Gate 2 opens; else the execution ended without a result. */
export function stageAfterSealing(
	stage: WorkspaceStage,
	eligible: boolean,
): { to: WorkspaceStage; trigger: WorkspaceTrigger } | null {
	if (stage === "cancel_requested")
		return { to: "cancelled", trigger: "cancel_won" };
	if (stage !== "queued" && stage !== "running") return null;
	return eligible
		? { to: "awaiting_acceptance", trigger: "result_ready" }
		: { to: "execution_ended", trigger: "result_unavailable" };
}

// ── derived phase (display) ────────────────────────────────────────────────

export const WorkspacePhase = z.enum([
	"planning",
	"awaiting_run_approval",
	"queued",
	"implementing",
	"verifying",
	"reviewing",
	"repairing",
	"finalizing",
	"awaiting_acceptance",
	"accepted",
	"changes_requested",
	"rejected",
	"blocked",
	"failed",
	"interrupted",
	"cancel_requested",
	"cancelled",
]);
export type WorkspacePhase = z.infer<typeof WorkspacePhase>;

/** UI phase label. `engine` = linked managed task state, or null when there is none. */
export function deriveWorkspacePhase(
	stage: WorkspaceStage,
	engine: TaskState | null,
): WorkspacePhase {
	switch (stage) {
		case "draft":
			return "planning";
		case "running":
			switch (engine) {
				case "executing":
					return "implementing";
				case "verifying":
				case "reviewing":
				case "repairing":
					return engine;
				case "human_ready":
					return "finalizing";
				default:
					return "queued";
			}
		case "execution_ended":
			return engine === "blocked" || engine === "interrupted"
				? engine
				: "failed";
		default:
			return stage;
	}
}
