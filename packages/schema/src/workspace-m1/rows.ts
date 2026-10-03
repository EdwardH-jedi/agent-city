// Row DTOs of migration 008_workspace_approvals.sql (role 02 writes the SQL) — snake_case, 1:1 with
// the columns; JSON columns are parsed objects here, INTEGER 0/1 columns are booleans. Columns that
// hold a HASHED structure (proposal snapshot, execution binding, approval binding, result envelope)
// store its canonical encoding verbatim, so sha256(column text) === the stored hash.
//
// Plus the client-facing views (no challenge columns, no idempotency internals) and the
// non-decision command bodies. Web-safe.
import { z } from "zod";
import { FailureKind, TaskState } from "../managed.ts";
import { ApprovalBinding, ApprovalKind, ExecutionBinding } from "./binding.ts";
import {
	ChallengeStatus,
	DecisionAction,
	DecisionReceiptBody,
	OperatorId,
} from "./decision.ts";
import {
	ApprovalRequestId,
	BootId,
	DecisionId,
	IdempotencyKey,
	ManagedTaskId,
	ProposalId,
	RunId,
	WorkspaceTaskId,
} from "./ids.ts";
import { Hash, HashedTs, RepoId, Rev, UtcTs } from "./primitives.ts";
import {
	AnyProposalSnapshot,
	ProposalContractVersion,
	WORKSPACE_TASK_CONTRACT,
	WorkspaceDraft,
} from "./proposal.ts";
import { AnyResultEnvelope } from "./result.ts";
import {
	ApprovalStatus,
	InvalidationReason,
	WorkspacePhase,
	WorkspaceStage,
} from "./state.ts";

const Detail = z.string().max(1000);

/** Stages that always point at a current proposal + managed task. */
const EXECUTION_STAGES: readonly WorkspaceStage[] = [
	"awaiting_run_approval",
	"queued",
	"running",
	"cancel_requested",
	"awaiting_acceptance",
	"accepted",
];

// ── workspace_tasks ────────────────────────────────────────────────────────

const WorkspaceTaskSummaryFields = {
	id: WorkspaceTaskId,
	contract_version: z.literal(WORKSPACE_TASK_CONTRACT),
	repo_id: RepoId,
	created_by: OperatorId,
	/** Mutable working copy (JSON). Saving it bumps rev and never touches authority. */
	draft: WorkspaceDraft,
	stage: WorkspaceStage,
	stage_detail: Detail.nullable(),
	/** Latest published proposal version (null until the first publish). */
	current_proposal_id: ProposalId.nullable(),
	/** Managed task of the current / latest execution (reserved at Gate-1 open). */
	current_managed_task_id: ManagedTaskId.nullable(),
	/** Set exactly when stage = accepted. */
	accepted_decision_id: DecisionId.nullable(),
	/** Workspace-level cancel intent (mirrors the managed task's cancel request). */
	cancel_requested_at: UtcTs.nullable(),
	created_at: UtcTs,
	updated_at: UtcTs,
	rev: Rev,
} as const;

type TaskLike = {
	stage: WorkspaceStage;
	accepted_decision_id: string | null;
	current_proposal_id: string | null;
	current_managed_task_id: string | null;
	cancel_requested_at: string | null;
};

const taskInvariants = (r: TaskLike, ctx: z.RefinementCtx): void => {
	const issue = (path: string, message: string) =>
		ctx.addIssue({ code: "custom", path: [path], message });
	if ((r.stage === "accepted") !== (r.accepted_decision_id !== null))
		issue("accepted_decision_id", "set exactly when stage = accepted");
	if (
		EXECUTION_STAGES.includes(r.stage) &&
		(r.current_proposal_id === null || r.current_managed_task_id === null)
	)
		issue("stage", "this stage needs a current proposal and managed task");
	if (r.stage === "cancel_requested" && r.cancel_requested_at === null)
		issue("cancel_requested_at", "required while cancel is pending");
};

export const WorkspaceTaskRow = z
	.strictObject({
		...WorkspaceTaskSummaryFields,
		/** Create-command retry key; UNIQUE(created_by, idempotency_key). */
		idempotency_key: IdempotencyKey,
		/** H({repo_id, draft}) of the create command (same key + different body → 409). */
		request_hash: Hash,
	})
	.superRefine(taskInvariants);
export type WorkspaceTaskRow = z.infer<typeof WorkspaceTaskRow>;

// ── managed_proposals (immutable; no rev, no updated_at) ───────────────────

export const ManagedProposalRow = z
	.strictObject({
		id: ProposalId,
		workspace_task_id: WorkspaceTaskId,
		/** UNIQUE(workspace_task_id, version); monotonic from 1. */
		version: z.number().int().min(1).max(100_000),
		predecessor_proposal_id: ProposalId.nullable(),
		/** v1 (legacy rows) | v1.2 (every new proposal; migration 010) — equals `snapshot.contract`. */
		contract_version: ProposalContractVersion,
		/** Canonical JSON text in the column (v1 | v1.2 by `contract`). */
		snapshot: AnyProposalSnapshot,
		proposal_hash: Hash,
		created_by: OperatorId,
		created_at: UtcTs,
	})
	.superRefine((r, ctx) => {
		const s = r.snapshot;
		if (
			s.proposal_id !== r.id ||
			s.workspace_task_id !== r.workspace_task_id ||
			s.version !== r.version ||
			s.predecessor_proposal_id !== r.predecessor_proposal_id
		)
			ctx.addIssue({
				code: "custom",
				path: ["snapshot"],
				message: "snapshot identity differs from the row",
			});
		if (r.contract_version !== s.contract)
			ctx.addIssue({
				code: "custom",
				path: ["contract_version"],
				message: "contract_version differs from the snapshot contract",
			});
	});
export type ManagedProposalRow = z.infer<typeof ManagedProposalRow>;

// ── managed_approval_requests ──────────────────────────────────────────────

const ApprovalRequestFields = {
	id: ApprovalRequestId,
	workspace_task_id: WorkspaceTaskId,
	kind: ApprovalKind,
	proposal_id: ProposalId,
	proposal_hash: Hash,
	/** REFERENCES managed_tasks(id). UNIQUE WHERE kind = 'run' (one Gate 1 per managed task). */
	managed_task_id: ManagedTaskId,
	/** Canonical JSON (both kinds; a result request copies its execution's binding). */
	execution_binding: ExecutionBinding,
	execution_binding_hash: Hash,
	/** Result requests only. UNIQUE WHERE kind = 'result' (one Gate 2 per attempt, ever). */
	run_id: RunId.nullable(),
	/** Result requests only; canonical JSON (v1 legacy | v1.2 with criterion_coverage). */
	result_envelope: AnyResultEnvelope.nullable(),
	result_envelope_hash: Hash.nullable(),
	/** Canonical JSON. */
	binding: ApprovalBinding,
	/** UNIQUE. */
	binding_hash: Hash,
	status: ApprovalStatus,
	invalidation_reason: InvalidationReason.nullable(),
	invalidation_detail: Detail.nullable(),
	created_at: UtcTs,
	updated_at: UtcTs,
	/** Set when status leaves pending. */
	closed_at: UtcTs.nullable(),
	rev: Rev,
} as const;

/** Server-only columns: never serialized to a client (ApprovalRequestView omits them). */
const ChallengeFields = {
	challenge_status: ChallengeStatus,
	/** H(ChallengeBinding) — the token itself is never stored. */
	challenge_hash: Hash.nullable(),
	challenge_operator_id: OperatorId.nullable(),
	challenge_session_generation: z
		.number()
		.int()
		.positive()
		.max(Number.MAX_SAFE_INTEGER)
		.nullable(),
	challenge_boot_id: BootId.nullable(),
	/** The request rev the challenge was issued at (after its own bump). */
	challenge_request_rev: Rev.nullable(),
	challenge_issued_at: HashedTs.nullable(),
	challenge_expires_at: HashedTs.nullable(),
} as const;

type ApprovalLike = {
	id: string;
	kind: ApprovalKind;
	run_id: string | null;
	result_envelope: unknown;
	result_envelope_hash: string | null;
	binding: ApprovalBinding;
	execution_binding: ExecutionBinding;
	managed_task_id: string;
	proposal_id: string;
	proposal_hash: string;
	status: ApprovalStatus;
	invalidation_reason: string | null;
	closed_at: string | null;
};

const approvalProblems = (r: ApprovalLike): string[] => {
	const out: string[] = [];
	const resultFields = [r.run_id, r.result_envelope, r.result_envelope_hash];
	const wanted = r.kind === "result";
	if (resultFields.some((f) => (f !== null) !== wanted))
		out.push("run_id / result_envelope(_hash) are set exactly for kind=result");
	if (r.binding.kind !== r.kind) out.push("binding kind differs from the row");
	if (r.binding.approval_request_id !== r.id)
		out.push("binding names another approval request");
	if (
		r.execution_binding.managed_task_id !== r.managed_task_id ||
		r.execution_binding.proposal_id !== r.proposal_id ||
		r.execution_binding.proposal_hash !== r.proposal_hash
	)
		out.push("execution binding differs from the row");
	if ((r.status === "invalidated") !== (r.invalidation_reason !== null))
		out.push("invalidation_reason is set exactly when invalidated");
	if ((r.status === "pending") !== (r.closed_at === null))
		out.push("closed_at is null exactly while pending");
	if (r.kind === "run" && r.status === "accepted")
		out.push("a run request is approved, never accepted");
	if (r.kind === "result" && r.status === "approved")
		out.push("a result request is accepted, never approved");
	return out;
};

export const ApprovalRequestRow = z
	.strictObject({
		...ApprovalRequestFields,
		...ChallengeFields,
		/**
		 * 009 (v1.2 §B): the durable evidence bundle published BEFORE this result request was
		 * inserted; immutable. Absent / null for run requests, for result requests recorded already
		 * invalidated, and for legacy (pre-009) rows. Server-only (not in ApprovalRequestView).
		 */
		evidence_bundle_digest: Hash.nullable().optional(),
	})
	.superRefine((r, ctx) => {
		for (const message of approvalProblems(r))
			ctx.addIssue({ code: "custom", message });
		if (
			r.evidence_bundle_digest !== null &&
			r.evidence_bundle_digest !== undefined &&
			r.kind !== "result"
		)
			ctx.addIssue({
				code: "custom",
				path: ["evidence_bundle_digest"],
				message: "only a result request carries an evidence bundle",
			});
		const issued = r.challenge_status !== "none";
		const fields = [
			r.challenge_hash,
			r.challenge_operator_id,
			r.challenge_session_generation,
			r.challenge_boot_id,
			r.challenge_request_rev,
			r.challenge_issued_at,
			r.challenge_expires_at,
		];
		if (fields.some((f) => (f === null) === issued))
			ctx.addIssue({
				code: "custom",
				message:
					"challenge columns are all set exactly when a challenge exists",
			});
	});
export type ApprovalRequestRow = z.infer<typeof ApprovalRequestRow>;

// ── managed_decisions (append-only) ────────────────────────────────────────

export const ManagedDecisionRow = z.strictObject({
	id: DecisionId,
	/** UNIQUE: a request is decided at most once. */
	approval_request_id: ApprovalRequestId,
	workspace_task_id: WorkspaceTaskId,
	kind: ApprovalKind,
	action: DecisionAction,
	operator_id: OperatorId,
	/** UNIQUE(operator_id, idempotency_key). */
	idempotency_key: IdempotencyKey,
	payload_hash: Hash,
	binding_hash: Hash,
	/** The request rev the decision was made against (= DecisionPayload.expected_request_rev). */
	request_rev: Rev,
	confirmation_text: z.literal("Edward").nullable(),
	/** Stored (redacted) reason. */
	reason: z.string().min(1).max(8192).nullable(),
	boot_id: BootId,
	session_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	managed_task_id: ManagedTaskId,
	result_envelope_hash: Hash.nullable(),
	decided_at: UtcTs,
	response_status: z.number().int().min(200).max(299),
	/** JSON; returned verbatim on replay. */
	response_body: DecisionReceiptBody,
	/**
	 * 009 (v1.2 §B): a Gate-2 accept carries exactly its request's evidence bundle digest (DB
	 * trigger); every other decision carries none. Absent / null on legacy rows.
	 */
	evidence_bundle_digest: Hash.nullable().optional(),
});
export type ManagedDecisionRow = z.infer<typeof ManagedDecisionRow>;

// ── managed_evidence_bundles (009, append-only) ────────────────────────────

/** Contract tag of the bundle file header (CONTRACT_V1_2.md §B). */
export const EVIDENCE_BUNDLE_CONTRACT = "agentcity.evidence-bundle/v1";

export const EvidenceBundleRow = z
	.strictObject({
		/** sha256 of the whole bundle file = its content address. */
		digest: Hash,
		result_envelope_hash: Hash,
		managed_task_id: ManagedTaskId,
		run_id: RunId,
		/** Always `_sealed/<digest>.bundle`, relative to the artifacts root. */
		rel_path: z.string().regex(/^_sealed\/[0-9a-f]{64}\.bundle$/),
		byte_len: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		item_count: z.number().int().min(0).max(64),
		created_at: UtcTs,
	})
	.superRefine((r, ctx) => {
		if (r.rel_path !== `_sealed/${r.digest}.bundle`)
			ctx.addIssue({
				code: "custom",
				path: ["rel_path"],
				message: "rel_path is _sealed/<digest>.bundle",
			});
	});
export type EvidenceBundleRow = z.infer<typeof EvidenceBundleRow>;

// ── views (client-facing) ──────────────────────────────────────────────────

export const ApprovalRequestView = z
	.strictObject(ApprovalRequestFields)
	.superRefine((r, ctx) => {
		for (const message of approvalProblems(r))
			ctx.addIssue({ code: "custom", message });
	});
export type ApprovalRequestView = z.infer<typeof ApprovalRequestView>;

export const DecisionView = z.strictObject({
	id: DecisionId,
	approval_request_id: ApprovalRequestId,
	kind: ApprovalKind,
	action: DecisionAction,
	operator_id: OperatorId,
	payload_hash: Hash,
	binding_hash: Hash,
	reason: z.string().nullable(),
	result_envelope_hash: Hash.nullable(),
	decided_at: UtcTs,
});
export type DecisionView = z.infer<typeof DecisionView>;

/** What the workspace needs to know about its managed task (derived, read at request time). */
export const EngineView = z.strictObject({
	managed_task_id: ManagedTaskId,
	state: TaskState,
	failure_kind: FailureKind.nullable(),
	state_detail: z.string().nullable(),
	cancel_requested_at: UtcTs.nullable(),
	current_run_id: RunId.nullable(),
	result_run_id: RunId.nullable(),
	/** attempt_no of current_run_id (null before the first attempt). */
	attempt_no: z.number().int().positive().nullable(),
	/** An open managed_quarantine row exists: blocks acceptance, rerun and cancel→cancelled. */
	quarantined: z.boolean(),
	rev: Rev,
});
export type EngineView = z.infer<typeof EngineView>;

/** The task row without its create-command internals (idempotency_key, request_hash). */
export const WorkspaceTaskSummary = z
	.strictObject(WorkspaceTaskSummaryFields)
	.superRefine(taskInvariants);
export type WorkspaceTaskSummary = z.infer<typeof WorkspaceTaskSummary>;

// ── current acceptance validity (contract delta v1.2, docs/workspace-m1/CONTRACT_V1_2.md §C) ──
// The historical decision never changes; this is the CURRENT validity of an accepted result.
// `invalid` and `unverifiable` are sticky server-side (a later check never restores `valid`).

export const AcceptanceValidityStatus = z.enum([
	"valid",
	"invalid",
	"unknown",
	"unverifiable",
]);
export type AcceptanceValidityStatus = z.infer<typeof AcceptanceValidityStatus>;

export const AcceptanceValidityReason = z.enum([
	"bundle_missing",
	"bundle_corrupt",
	"bundle_binding_mismatch",
	"source_evidence_changed",
	"source_evidence_missing",
	"candidate_unavailable",
	"candidate_mismatch",
	"verification_unavailable",
	"legacy_no_durable_evidence",
]);
export type AcceptanceValidityReason = z.infer<typeof AcceptanceValidityReason>;

export const AcceptanceValidityView = z
	.strictObject({
		decision_id: DecisionId,
		status: AcceptanceValidityStatus,
		/** null only when `valid`. */
		reason: AcceptanceValidityReason.nullable(),
		/** Fixed, content-free explanation (component names, never artifact bytes). */
		detail: z.string().max(500).nullable(),
		checked_at: UtcTs,
		first_invalid_at: UtcTs.nullable(),
		/** null for legacy acceptances (no durable bundle). */
		evidence_bundle_digest: Hash.nullable(),
	})
	.superRefine((v, ctx) => {
		if ((v.status === "valid") !== (v.reason === null))
			ctx.addIssue({
				code: "custom",
				message: "reason is null exactly when status is valid",
			});
		if ((v.status === "invalid") !== (v.first_invalid_at !== null))
			ctx.addIssue({
				code: "custom",
				message: "first_invalid_at is set exactly when status is invalid",
			});
	});
export type AcceptanceValidityView = z.infer<typeof AcceptanceValidityView>;

/** Reasons that make a current acceptance `invalid` (sticky). */
export const ACCEPTANCE_INVALID_REASONS: readonly AcceptanceValidityReason[] = [
	"bundle_missing",
	"bundle_corrupt",
	"bundle_binding_mismatch",
	"source_evidence_changed",
	"source_evidence_missing",
	"candidate_unavailable",
	"candidate_mismatch",
];

/** managed_acceptance_validity (009): one row per Gate-2 accept decision. */
export const AcceptanceValidityRow = z
	.strictObject({
		decision_id: DecisionId,
		/** UNIQUE: the accepted result request. */
		result_request_id: ApprovalRequestId,
		workspace_task_id: WorkspaceTaskId,
		/** null exactly for a legacy (`unverifiable`) acceptance. */
		evidence_bundle_digest: Hash.nullable(),
		status: AcceptanceValidityStatus,
		reason: AcceptanceValidityReason.nullable(),
		detail: z.string().max(500).nullable(),
		checked_at: UtcTs,
		first_invalid_at: UtcTs.nullable(),
		rev: Rev,
	})
	.superRefine((r, ctx) => {
		const issue = (message: string) =>
			ctx.addIssue({ code: "custom", message });
		if ((r.status === "valid") !== (r.reason === null))
			issue("reason is null exactly when status is valid");
		if ((r.status === "invalid") !== (r.first_invalid_at !== null))
			issue("first_invalid_at is set exactly when status is invalid");
		if (
			(r.status === "unverifiable") !==
			(r.reason === "legacy_no_durable_evidence")
		)
			issue(
				"legacy_no_durable_evidence is the reason exactly when unverifiable",
			);
		if (r.status === "unknown" && r.reason !== "verification_unavailable")
			issue("unknown means verification_unavailable");
		if (
			r.status === "invalid" &&
			(r.reason === null || !ACCEPTANCE_INVALID_REASONS.includes(r.reason))
		)
			issue("invalid needs an invalidating reason");
		if ((r.status === "unverifiable") !== (r.evidence_bundle_digest === null))
			issue("only a legacy (unverifiable) acceptance has no evidence bundle");
	});
export type AcceptanceValidityRow = z.infer<typeof AcceptanceValidityRow>;

export const WorkspaceTaskView = z.strictObject({
	task: WorkspaceTaskSummary,
	phase: WorkspacePhase,
	engine: EngineView.nullable(),
	current_proposal: ManagedProposalRow.nullable(),
	/** Every request of the task, newest first (history included). */
	approval_requests: z.array(ApprovalRequestView).max(500),
	decisions: z.array(DecisionView).max(500),
	/** v1.2: current validity of the task's accepted result (null when nothing is accepted). */
	acceptance_validity: AcceptanceValidityView.nullable(),
});
export type WorkspaceTaskView = z.infer<typeof WorkspaceTaskView>;

// ── command bodies (non-decision) ──────────────────────────────────────────
// Creation is idempotent by key; every other mutation is CAS on the task's `rev` (at most once; a
// lost response is resolved by re-reading the task). Decisions have durable receipts (decision.ts).

export const CreateWorkspaceTaskRequest = z.strictObject({
	idempotency_key: IdempotencyKey,
	repo_id: RepoId,
	draft: WorkspaceDraft,
});
export type CreateWorkspaceTaskRequest = z.infer<
	typeof CreateWorkspaceTaskRequest
>;

export const SaveDraftRequest = z.strictObject({
	expected_rev: Rev,
	draft: WorkspaceDraft,
});
export type SaveDraftRequest = z.infer<typeof SaveDraftRequest>;

/** Publish the STORED draft (as of expected_rev) as the next proposal version and open Gate 1. */
export const PublishProposalRequest = z.strictObject({ expected_rev: Rev });
export type PublishProposalRequest = z.infer<typeof PublishProposalRequest>;

/** New execution (new managed task + new Gate 1) of the task's current proposal. */
export const RequestRerunRequest = z.strictObject({
	expected_rev: Rev,
	proposal_id: ProposalId,
});
export type RequestRerunRequest = z.infer<typeof RequestRerunRequest>;

export const CancelRequest = z.strictObject({ expected_rev: Rev });
export type CancelRequest = z.infer<typeof CancelRequest>;
