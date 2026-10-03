// Port signatures between the M1 roles (types only; web-safe — no Bun/Node types). Implemented by
// 02 persistence, 03 auth, 04 decisions, 05 bridge, 06 evidence. Synchronous where the call runs
// inside a bun:sqlite transaction; Promise only where file / git I/O happens (never inside a tx).
import type { ApprovalKind, ExecutionBinding } from "./binding.ts";
import type {
	ChallengeIssueResponse,
	DecisionResponse,
	OperatorPrincipal,
	WorkspaceErrorBody,
} from "./decision.ts";
import type {
	ApprovalRequestId,
	DecisionId,
	IdempotencyKey,
	ManagedTaskId,
	ProposalId,
	RunId,
	WorkspaceTaskId,
} from "./ids.ts";
import type { Hash } from "./primitives.ts";
import type { AnyProposalSnapshot } from "./proposal.ts";
import type { AnyResultEnvelope, ResultEligibility } from "./result.ts";
import type {
	ApprovalRequestRow,
	EngineView,
	ManagedDecisionRow,
	ManagedProposalRow,
	WorkspaceTaskRow,
} from "./rows.ts";
import type { ApprovalStatus, InvalidationReason } from "./state.ts";

// ── 02 persistence ─────────────────────────────────────────────────────────

export interface WorkspaceReads {
	getTask(id: WorkspaceTaskId): WorkspaceTaskRow | null;
	getProposal(id: ProposalId): ManagedProposalRow | null;
	getApprovalRequest(id: ApprovalRequestId): ApprovalRequestRow | null;
	listApprovalRequests(filter: {
		workspace_task_id?: WorkspaceTaskId;
		status?: ApprovalStatus;
		kind?: ApprovalKind;
	}): ApprovalRequestRow[];
	getDecision(id: DecisionId): ManagedDecisionRow | null;
	/** Durable receipt lookup — scope (operator_id, idempotency_key). */
	findReceipt(
		operator_id: string,
		idempotency_key: IdempotencyKey,
	): ManagedDecisionRow | null;
}

export type WorkspaceTaskPatch = Partial<
	Pick<
		WorkspaceTaskRow,
		| "draft"
		| "stage"
		| "stage_detail"
		| "current_proposal_id"
		| "current_managed_task_id"
		| "accepted_decision_id"
		| "cancel_requested_at"
	>
>;

export type ApprovalRequestPatch = Partial<
	Pick<
		ApprovalRequestRow,
		| "status"
		| "invalidation_reason"
		| "invalidation_detail"
		| "closed_at"
		| "challenge_status"
		| "challenge_hash"
		| "challenge_operator_id"
		| "challenge_session_generation"
		| "challenge_boot_id"
		| "challenge_request_rev"
		| "challenge_issued_at"
		| "challenge_expires_at"
	>
>;

/**
 * Operations valid only inside WorkspaceStore.transaction (one BEGIN IMMEDIATE on the hub's single
 * Database handle; managed-store calls made by 05 inside the callback join it). Holding this object
 * is the proof of being inside the transaction — never keep it after the callback returns.
 */
export interface WorkspaceTx extends WorkspaceReads {
	insertTask(row: WorkspaceTaskRow): void;
	/** CAS: applies only if rev === expected_rev; bumps rev + updated_at. null = CAS miss. */
	updateTask(
		id: WorkspaceTaskId,
		expected_rev: number,
		patch: WorkspaceTaskPatch,
		now: string,
	): WorkspaceTaskRow | null;
	/** Throws on UNIQUE(workspace_task_id, version). Rows are never updated. */
	insertProposal(row: ManagedProposalRow): void;
	insertApprovalRequest(row: ApprovalRequestRow): void;
	/** CAS on rev; bumps rev + updated_at (challenge issuance included). null = CAS miss. */
	updateApprovalRequest(
		id: ApprovalRequestId,
		expected_rev: number,
		patch: ApprovalRequestPatch,
		now: string,
	): ApprovalRequestRow | null;
	/** Append-only. Throws on UNIQUE(operator_id, idempotency_key) or UNIQUE(approval_request_id). */
	insertDecision(row: ManagedDecisionRow): void;
}

export interface WorkspaceStore extends WorkspaceReads {
	/** Synchronous; a throw rolls everything back (workspace rows AND managed rows). */
	transaction<T>(fn: (tx: WorkspaceTx) => T): T;
}

// ── 03 auth ────────────────────────────────────────────────────────────────

/**
 * Minted only by the auth module after session cookie + scope + exact Origin + CSRF all passed for
 * THIS request. Never constructed from a request body.
 */
export interface VerifiedAuthContext {
	readonly principal: OperatorPrincipal;
	readonly origin_verified: true;
	readonly csrf_verified: true;
}

export interface ChallengePort {
	/**
	 * In-tx. Request must be pending with matching kind / binding_hash / rev. Supersedes any earlier
	 * challenge, stores H(ChallengeBinding) + fields, bumps the request rev, returns the token ONCE.
	 */
	issue(
		tx: WorkspaceTx,
		request: ApprovalRequestRow,
		auth: VerifiedAuthContext,
		now: Date,
	): ChallengeIssueResponse;
	/**
	 * In-tx, inside the decision transaction. Recompute H(ChallengeBinding) from the presented
	 * token + current row + auth, compare in constant time, check expiry and status `issued`; on
	 * success set challenge_status = consumed (the decision's request update bumps rev).
	 */
	verifyAndConsume(
		tx: WorkspaceTx,
		request: ApprovalRequestRow,
		presented: string,
		auth: VerifiedAuthContext,
		now: Date,
	): { ok: true } | { ok: false; code: "challenge_invalid" };
}

// ── 04 decisions ───────────────────────────────────────────────────────────

export type CommandOutcome<T> =
	| { ok: true; status: number; body: T }
	| { ok: false; status: number; body: WorkspaceErrorBody };

export interface DecisionService {
	issueChallenge(
		auth: VerifiedAuthContext,
		approval_request_id: ApprovalRequestId,
		body: unknown,
		now: Date,
	): CommandOutcome<ChallengeIssueResponse>;
	/** Gate 2 revalidates evidence (async I/O) BEFORE its short transaction. */
	decide(
		auth: VerifiedAuthContext,
		approval_request_id: ApprovalRequestId,
		body: unknown,
		now: Date,
	): Promise<CommandOutcome<DecisionResponse>>;
}

// ── 05 bridge ──────────────────────────────────────────────────────────────

export interface ReservedExecution {
	managed_task_id: ManagedTaskId;
	execution_binding: ExecutionBinding;
	execution_binding_hash: Hash;
}

export type EnqueueResult =
	| { queued: true }
	| {
			queued: false;
			reason:
				| "not_draft"
				| "binding_mismatch"
				| "quarantined"
				| "repo_not_allowed";
	  };

export interface ExecutionBridge {
	/**
	 * In-tx (Gate-1 open). Insert the managed task in state `draft` from managedTaskFieldsFor(snapshot)
	 * with idempotency_key = approval_request_id and request_hash = execution_binding_hash, and
	 * return its execution binding (policy_hash = current policyHash(config, repo_id)).
	 */
	reserve(
		tx: WorkspaceTx,
		input: {
			/** v1.2 for every new proposal; a legacy v1 snapshot stays readable (rerun refuses it). */
			proposal: AnyProposalSnapshot;
			proposal_hash: Hash;
			approval_request_id: ApprovalRequestId;
			now: string;
		},
	): ReservedExecution;
	/**
	 * In-tx (Gate-1 approve). Recompute the execution binding hash from the current rows + policy;
	 * if it matches, draft → queued with exactly requestRun's writes (approval_hash =
	 * approvalHashFor(task, config), run_requested_at, cancel/lease cleared, infra_retries 0,
	 * fence_token + 1). Never queues anything else.
	 */
	enqueueApproved(
		tx: WorkspaceTx,
		input: {
			managed_task_id: ManagedTaskId;
			decision_id: DecisionId;
			execution_binding_hash: Hash;
			now: string;
		},
	): EnqueueResult;
	/** In-tx. Reserved `draft` managed task → cancelled (Gate-1 changes/reject, supersede, withdraw, invalidation). */
	releaseReserved(
		tx: WorkspaceTx,
		input: {
			managed_task_id: ManagedTaskId;
			reason: InvalidationReason | "changes_requested" | "rejected";
			now: string;
		},
	): void;
	/** Persist cancel intent on the managed task (store.requestCancel); never claims termination. */
	requestCancel(managed_task_id: ManagedTaskId, now: string): EngineView;
	engineView(managed_task_id: ManagedTaskId): EngineView | null;
	/** policyHash(config, repo_id) of the orchestrator's frozen config snapshot. */
	currentPolicyHash(repo_id: string): Hash;
}

// ── 06 evidence ────────────────────────────────────────────────────────────

export interface SealInput {
	workspace_task_id: WorkspaceTaskId;
	/** v1 | v1.2: a v1.2 proposal seals a v1.2 envelope (criterion coverage); v1 → ineligible. */
	proposal: AnyProposalSnapshot;
	proposal_hash: Hash;
	execution_binding: ExecutionBinding;
	execution_binding_hash: Hash;
	/** The Gate-1 decision of this execution. */
	run_decision_id: DecisionId;
	managed_task_id: ManagedTaskId;
	/** managed_tasks.result_run_id. */
	run_id: RunId;
}

export interface SealedResult {
	/** v1.2 (with criterion_coverage) for a v1.2 proposal; v1 only for a legacy v1 proposal. */
	envelope: AnyResultEnvelope;
	/** H(envelope) = sha256(canonical). */
	envelope_hash: Hash;
	canonical: string;
	eligibility: ResultEligibility;
	/** Display-only diagnostics (bounded, no raw content); never hashed. */
	problems: readonly string[];
}

export interface EvidenceSealer {
	/** One verified read of every artifact (no-follow, non-blocking, regular files only) + git candidate/tree checks. No DB writes. */
	seal(input: SealInput): Promise<SealedResult>;
	/**
	 * Gate 2, before the decision transaction: re-seal from fresh verified reads. The caller accepts
	 * only if envelope_hash === request.result_envelope_hash and eligibility.eligible
	 * (`resultEligibilityV1_2(envelope, proposal)` — v1.2 criterion coverage); otherwise
	 * 409 integrity_failed / evidence_unavailable and the request is invalidated.
	 */
	revalidate(request: ApprovalRequestRow): Promise<SealedResult>;
}
