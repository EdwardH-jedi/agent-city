// Visible copy and display derivations for the workspace / HQ (role 07). Pure; no React.
// Copy rules (MATRIX §7, SHARED spec): English; status never by colour alone; never imply that
// acceptance changes a repository (no merge/push/deploy vocabulary — copy.test.ts audits every
// string here); fixture data is labelled as UI fixture, simulated execution as Simulated.
import type {
	AcceptanceValidityReason,
	AcceptanceValidityStatus,
	AcceptanceValidityView,
	ApprovalKind,
	ApprovalRequestView,
	ApprovalStatus,
	CheckOutcome,
	CriterionStatus,
	DecisionAction,
	EngineView,
	EvidenceStatus,
	ExecutionQueue,
	InvalidationReason,
	ObservedRepo,
	WorkspaceErrorBody,
	WorkspacePhase,
	WorkspaceStage,
	WorkspaceTaskDetail,
	WorkspaceTaskSummary,
	WorkspaceTaskView,
} from "@agent-city/schema/workspace-m1";

type TaskState = EngineView["state"];
type FailureKind = NonNullable<EngineView["failure_kind"]>;
export type Tone = "neutral" | "info" | "waiting" | "ok" | "bad" | "closed";

export const PHASE_LABEL: Readonly<Record<WorkspacePhase, string>> = {
	planning: "Planning",
	awaiting_run_approval: "Awaiting execution approval",
	queued: "Queued",
	implementing: "Implementing",
	verifying: "Verifying",
	reviewing: "Reviewing",
	repairing: "Repairing",
	finalizing: "Finalizing",
	awaiting_acceptance: "Awaiting acceptance",
	accepted: "Accepted",
	changes_requested: "Changes requested",
	rejected: "Rejected",
	blocked: "Blocked",
	failed: "Failed",
	interrupted: "Interrupted",
	cancel_requested: "Cancellation requested",
	cancelled: "Cancelled",
};

export const PHASE_TONE: Readonly<Record<WorkspacePhase, Tone>> = {
	planning: "neutral",
	awaiting_run_approval: "waiting",
	queued: "info",
	implementing: "info",
	verifying: "info",
	reviewing: "info",
	repairing: "info",
	finalizing: "info",
	awaiting_acceptance: "waiting",
	accepted: "closed",
	changes_requested: "neutral",
	rejected: "closed",
	blocked: "bad",
	failed: "bad",
	interrupted: "bad",
	cancel_requested: "waiting",
	cancelled: "neutral",
};

export const ENGINE_STATE_LABEL: Readonly<Record<TaskState, string>> = {
	draft: "Reserved, not approved to run",
	queued: "Queued",
	executing: "Executing",
	verifying: "Verifying",
	reviewing: "Reviewing",
	repairing: "Repairing",
	human_ready: "Awaiting human acceptance (engine human_ready)",
	failed: "Failed",
	blocked: "Blocked",
	cancelled: "Cancelled",
	interrupted: "Interrupted",
};

/**
 * Engine state as shown next to the workspace acceptance status. `human_ready` keeps its engine
 * meaning (awaiting human acceptance); after Gate 2 the label says acceptance is recorded
 * separately and the engine state is unchanged.
 */
export function engineLabel(
	state: TaskState,
	acceptance: ApprovalStatus | "none",
): string {
	if (state !== "human_ready") return ENGINE_STATE_LABEL[state];
	switch (acceptance) {
		case "accepted":
			return "human_ready (unchanged; acceptance recorded separately)";
		case "invalidated":
			return "human_ready (this result can no longer be accepted)";
		case "rejected":
			return "human_ready (result rejected; nothing accepted)";
		case "changes_requested":
			return "human_ready (changes requested; nothing accepted)";
		default:
			return ENGINE_STATE_LABEL.human_ready;
	}
}

export const GATE_NAME: Readonly<Record<ApprovalKind, string>> = {
	run: "Execution approval",
	result: "Result acceptance",
};

/** `data-gate` attribute values (MATRIX §7). */
export const GATE_ATTR: Readonly<Record<ApprovalKind, "execution" | "result">> =
	{ run: "execution", result: "result" };

export const GATE_HISTORY_NAME: Readonly<Record<ApprovalKind, string>> = {
	run: "execution",
	result: "result",
};

export const SIGNATURE_LABEL: Readonly<Record<ApprovalKind, string>> = {
	run: "Type Edward to approve execution",
	result: "Type Edward to accept this result",
};

export const GRANT_BUTTON: Readonly<Record<ApprovalKind, string>> = {
	run: "Approve execution",
	result: "Accept result",
};

export const ACTION_LABEL: Readonly<Record<DecisionAction, string>> = {
	approve: "approve",
	accept: "accept",
	request_changes: "request changes",
	reject: "reject",
};

export const APPROVAL_STATUS_LABEL: Readonly<Record<ApprovalStatus, string>> = {
	pending: "Pending",
	approved: "Approved",
	accepted: "Accepted",
	changes_requested: "Changes requested",
	rejected: "Rejected",
	invalidated: "Invalidated",
};

export const INVALIDATION_LABEL: Readonly<Record<InvalidationReason, string>> =
	{
		proposal_superseded: "a newer proposal version replaced it",
		withdrawn: "it was withdrawn by cancelling",
		policy_changed: "the repository policy changed",
		repo_unavailable: "the repository or its base commit is unavailable",
		execution_ended: "the execution ended before a decision",
		task_cancelled: "cancellation won over the finished result",
		evidence_unavailable: "required evidence could not be verified",
		integrity_failed: "the result no longer verifies",
		candidate_mutated: "the candidate changed after review",
	};

// ── obsolete v1 execution grants (hub follow-up; apps/hub decisions/decision-service.ts) ──
// A Gate-1 request of a pre-v1.2 proposal can never be approved: the hub refuses every challenge /
// decision on it with 409 `stale_binding` + one issue carrying OBSOLETE_V1_GRANT_DETAIL, invalidates
// it (`evidence_unavailable` — the only Gate-1 use of that reason) and returns the task to draft.
// The UI recognizes that record; it never reads as an evidence problem.

/** The hub's fixed reason (error issue + request `invalidation_detail`); recognized, never invented. */
export const OBSOLETE_V1_GRANT_DETAIL =
	"obsolete v1 proposal without criterion coverage; publish a new version and request a fresh execution approval";

export const OBSOLETE_GRANT_LABEL =
	"Obsolete v1 proposal — publish a new version and request a fresh execution approval";

export const OBSOLETE_GRANT_NOTE =
	"Obsolete v1 proposal — publish a new version and request a fresh execution approval. This execution approval request belongs to a proposal without criterion coverage, so it can no longer be approved and nothing was queued under it.";

export const OBSOLETE_GRANT_PENDING_NOTE =
	"Obsolete v1 proposal — publish a new version and request a fresh execution approval. The hub refuses every decision on this request and retires it; approving it is not possible.";

/** A Gate-1 request the hub retired under the obsolete-v1 policy. */
export function isObsoleteGrant(
	r: Pick<
		ApprovalRequestView,
		"kind" | "status" | "invalidation_reason" | "invalidation_detail"
	>,
): boolean {
	return (
		r.kind === "run" &&
		r.status === "invalidated" &&
		(r.invalidation_detail === OBSOLETE_V1_GRANT_DETAIL ||
			r.invalidation_reason === "evidence_unavailable")
	);
}

/** Why a request lost its authority (an obsolete Gate-1 grant names its own reason). */
export function invalidationLabel(
	r: Pick<
		ApprovalRequestView,
		"kind" | "status" | "invalidation_reason" | "invalidation_detail"
	>,
): string | null {
	if (isObsoleteGrant(r))
		return "obsolete v1 proposal — publish a new version and request a fresh execution approval";
	return r.invalidation_reason
		? INVALIDATION_LABEL[r.invalidation_reason]
		: null;
}

/**
 * The hub's own fixed reason in a `stale_binding` error (its first issue, e.g. the obsolete-v1 grant
 * refusal on `proposal_id`), or null. Only stale_binding: other codes keep their own copy.
 */
export function hubStaleReason(
	e: Pick<WorkspaceErrorBody, "error" | "issues">,
): string | null {
	if (e.error !== "stale_binding") return null;
	const first = e.issues?.[0];
	return first && first.message.trim().length > 0 ? first.message.trim() : null;
}

/** Copy of a hub error body: the server's fixed reason when it gave one, else the code's copy. */
export function errorCopyOf(
	e: Pick<WorkspaceErrorBody, "error" | "message" | "issues">,
): string {
	const reason = hubStaleReason(e);
	if (reason === null) return errorCopy(e.error, e.message);
	if (reason === OBSOLETE_V1_GRANT_DETAIL) return `${OBSOLETE_GRANT_LABEL}.`;
	const s = reason.charAt(0).toUpperCase() + reason.slice(1);
	return /[.!?]$/.test(s) ? s : `${s}.`;
}

/**
 * Concise version label of the proposal a request binds ("Proposal v2"), when the view can know it:
 * the current proposal, or its direct predecessor. Older versions are named by id only.
 */
export function proposalVersionLabel(
	d: Pick<WorkspaceTaskView, "current_proposal">,
	proposalId: string,
): string {
	const p = d.current_proposal;
	if (p?.id === proposalId) return `Proposal v${p.version}`;
	if (p && p.version > 1 && p.predecessor_proposal_id === proposalId)
		return `Proposal v${p.version - 1}`;
	return `Earlier proposal …${proposalId.slice(-8)}`;
}

export const EVIDENCE_LABEL: Readonly<
	Record<EvidenceStatus | "pending", string>
> = {
	verified: "Verified",
	truncated: "Truncated capture",
	withheld: "Withheld (not safely disclosable)",
	missing: "Missing",
	corrupt: "Corrupt (does not match its record)",
	stale: "Stale (bound to another candidate)",
	unknown: "Unknown",
	pending: "No result yet",
};

const FAILURE_LABEL: Partial<Record<FailureKind, string>> = {
	verification_failed: "A required verification check failed.",
	repair_limit_exhausted: "The pre-approved repair allowance is used up.",
	review_rejected: "The reviewer rejected the candidate.",
	review_invalid: "The review could not be counted.",
	scope_violation: "The change touched files outside the approved scope.",
	no_changes: "The implementer changed nothing.",
	candidate_mutated: "The candidate changed outside the pipeline.",
	evidence_invalid: "Stored evidence no longer matches its record.",
	provider_unavailable: "A simulated provider could not run.",
	interrupted: "The hub stopped during the attempt.",
	cancelled: "The execution was cancelled.",
	timeout: "The attempt ran out of time.",
	approval_void: "The approval no longer matched the task or policy.",
};

export const failureLabel = (k: FailureKind | null): string | null =>
	k === null ? null : (FAILURE_LABEL[k] ?? k.replaceAll("_", " "));

/** The next safe thing to do in this stage. Never an override of a safety check. */
export function nextAction(
	stage: WorkspaceStage,
	phase: WorkspacePhase,
): string {
	switch (stage) {
		case "draft":
			return "Complete the draft, save it, then submit it for execution approval.";
		case "awaiting_run_approval":
			return "Open the request in Headquarters to approve, request changes or reject.";
		case "queued":
		case "running":
			return "Wait for the stages to finish, or cancel the execution.";
		case "cancel_requested":
			return "Wait until termination is confirmed. Nothing is cancelled before that.";
		case "awaiting_acceptance":
			return "Inspect the evidence, then decide on the result in Headquarters.";
		case "accepted":
			return "This task is closed. Start a new task for further work.";
		case "rejected":
			return "This task is closed. Start a new task for further work.";
		case "changes_requested":
			return "Edit the draft and submit a new proposal version; it needs a new execution approval.";
		case "execution_ended":
			return phase === "interrupted"
				? "Inspect the last confirmed state. A new run needs a new execution approval."
				: "Inspect the evidence. Edit the draft or request a new run; both need a new execution approval.";
		case "cancelled":
			return "Edit the draft or request a new run; both need a new execution approval.";
	}
}

/** OQ-9: accepted and rejected tasks read as closed. */
export const isClosed = (stage: WorkspaceStage): boolean =>
	stage === "accepted" || stage === "rejected";

export const ACCEPTANCE_SCOPE_NOTE =
	"Acceptance records your decision on this exact result; it does not change any repository.";

export const SIMULATION_NOTE =
	"Simulated execution: fake providers and synthetic checks. Not evidence of live readiness.";

export const FIXTURE_NOTE =
	"UI fixture: synthetic data in this browser only. Nothing here is a hub record.";

/** Gate-2 status for `#acceptance-status` (latest result request of the task). */
export function acceptanceStatus(
	d: Pick<WorkspaceTaskDetail, "approval_requests">,
): ApprovalStatus | "none" {
	const r = d.approval_requests.find((x) => x.kind === "result");
	return r ? r.status : "none";
}

/**
 * `#cancellation-status`: present only once cancellation has been requested. "confirmed" needs
 * termination proof: the workspace stage `cancelled`, or the engine itself reporting `cancelled`
 * after the intent (the engine sets it only once the process is gone; the workspace stage follows
 * when the hub reconciles). Never "confirmed" from the intent alone.
 */
export function cancellationStatus(
	task: Pick<WorkspaceTaskSummary, "stage" | "cancel_requested_at">,
	engine: Pick<EngineView, "state" | "cancel_requested_at"> | null,
): "requested" | "confirmed" | null {
	const intent =
		task.cancel_requested_at !== null ||
		(engine?.cancel_requested_at ?? null) !== null;
	if (!intent) return null;
	if (task.stage === "cancelled" || engine?.state === "cancelled")
		return "confirmed";
	if (task.stage === "cancel_requested") return "requested";
	return null;
}

const ACTIVE_ENGINE: readonly TaskState[] = [
	"executing",
	"verifying",
	"reviewing",
	"repairing",
];

/**
 * The engine can be ahead of the stored workspace stage until the hub reconciles it. Say so
 * plainly instead of inventing a stage (e.g. engine `human_ready` without a result request:
 * acceptance is NOT available yet).
 */
export function engineAheadNote(
	d: Pick<WorkspaceTaskDetail, "task" | "engine" | "approval_requests">,
): string | null {
	const e = d.engine;
	if (!e) return null;
	const stage = d.task.stage;
	const executing =
		stage === "queued" || stage === "running" || stage === "cancel_requested";
	if (!executing) return null;
	if (e.state === "human_ready") {
		const opened = d.approval_requests.some(
			(r) => r.kind === "result" && r.run_id === e.result_run_id,
		);
		if (!opened)
			return "The engine finished this attempt (human_ready). Its result is not open for acceptance yet, so no acceptance is possible; the hub opens the result request after sealing the evidence.";
		return null;
	}
	if (stage === "queued" && ACTIVE_ENGINE.includes(e.state))
		return "The engine is working on this execution; the workspace stage is updated when the hub reconciles it.";
	if (
		e.state === "failed" ||
		e.state === "blocked" ||
		e.state === "interrupted"
	)
		return `The engine ended this execution (${e.state}); the workspace stage is updated when the hub reconciles it.`;
	if (e.state === "cancelled" && stage === "cancel_requested")
		return "The engine confirmed termination; the workspace stage is updated when the hub reconciles it.";
	return null;
}

/**
 * `#evidence-status`: the current result envelope's status, or `pending` without a result. Once
 * revalidation invalidated the result, the sealed statuses are history: an `integrity_failed`
 * invalidation reads as the neutral `unknown` ("Integrity check failed — evidence changed or
 * missing"; lead ruling on 09 L-1), `candidate_mutated` as `stale`. Per-artifact status then comes
 * from the hub's fresh read of each artifact (R-F5), shown in the viewer.
 */
export function evidenceStatus(
	d: Pick<WorkspaceTaskDetail, "approval_requests" | "acceptance_validity">,
): EvidenceStatus | "pending" {
	const r = d.approval_requests.find((x) => x.kind === "result");
	if (!r?.result_envelope) return "pending";
	const revoked = resultRevocation(r);
	if (revoked === "integrity") return "unknown";
	if (revoked === "candidate") return "stale";
	// v1.2: an accepted result's sealed statuses are history unless the hub says it is valid NOW
	if (acceptedHistory(d) !== null) return "unknown";
	return r.result_envelope.evidence_status;
}

export const INTEGRITY_FAILED_LABEL =
	"Integrity check failed — evidence changed or missing";

/** The label of `#evidence-status` (neutral wording for an integrity invalidation). */
export function evidenceStatusLabel(
	d: Pick<WorkspaceTaskDetail, "approval_requests" | "acceptance_validity">,
): string {
	const r = d.approval_requests.find((x) => x.kind === "result");
	if (r && resultRevocation(r) === "integrity") return INTEGRITY_FAILED_LABEL;
	const history = acceptedHistory(d);
	if (history !== null) return ACCEPTED_HISTORY_EVIDENCE_LABEL[history];
	return EVIDENCE_LABEL[evidenceStatus(d)];
}

// ── current acceptance validity (contract delta v1.2, CONTRACT_V1_2.md §C) ──
// The historical acceptance (`#acceptance-status` = accepted) never changes. Its CURRENT validity is
// whatever the hub reports; the UI never infers it and never shows "verified" unless the hub says
// `valid`. Sticky `invalid` / `unverifiable` are enforced by the hub, not here.

export const VALIDITY_REASON_LABEL: Readonly<
	Record<AcceptanceValidityReason, string>
> = {
	bundle_missing: "the sealed copy of the accepted evidence is missing",
	bundle_corrupt: "the sealed copy of the accepted evidence is corrupt",
	bundle_binding_mismatch:
		"the sealed evidence copy does not belong to this result",
	source_evidence_changed: "a stored evidence file changed after acceptance",
	source_evidence_missing: "a stored evidence file is missing",
	candidate_unavailable: "the accepted candidate commit is no longer available",
	candidate_mismatch:
		"the candidate commit no longer matches the accepted tree",
	verification_unavailable: "the check could not run",
	legacy_no_durable_evidence:
		"it was accepted before durable evidence was kept",
};

/** Why the current validity is not `valid`: a hub status, or the hub reported nothing. */
export type AcceptedHistory =
	| Exclude<AcceptanceValidityStatus, "valid">
	| "not_reported";

export const ACCEPTED_HISTORY_EVIDENCE_LABEL: Readonly<
	Record<AcceptedHistory, string>
> = {
	invalid: "No longer valid — sealed statuses kept as history",
	unknown: "Verification unavailable — sealed statuses kept as history",
	unverifiable: "Legacy acceptance — sealed statuses kept as history",
	not_reported: "Verification unavailable — sealed statuses kept as history",
};

export const VALIDITY_NOT_REPORTED =
	"Verification unavailable: the hub reported no current check of this acceptance. It is not shown as verified.";

export const ACCEPTED_ORIGINAL_NOTE =
	"Accepted original, kept as history: this is the content that was accepted, served from the sealed copy. It is not current verification.";

/** The task's accepted result request (the one decided with accept), if any. */
export function acceptedResultRequest(
	d: Pick<WorkspaceTaskDetail, "approval_requests">,
): ApprovalRequestView | null {
	return (
		d.approval_requests.find(
			(r) => r.kind === "result" && r.status === "accepted",
		) ?? null
	);
}

/**
 * Non-null when the task has an accepted result whose current validity is NOT `valid` (hub status
 * `invalid` / `unknown` / `unverifiable`, or no validity reported at all): its sealed statuses and
 * the bytes served for it are history, never current verification.
 */
export function acceptedHistory(
	d: Pick<WorkspaceTaskDetail, "approval_requests" | "acceptance_validity">,
): AcceptedHistory | null {
	if (!acceptedResultRequest(d)) return null;
	const v = d.acceptance_validity ?? null;
	if (!v) return "not_reported";
	return v.status === "valid" ? null : v.status;
}

// ── criterion coverage (contract delta v1.2, CONTRACT_V1_2.md §A) ───────────
// Rendered per criterion from the hub's sealed `criterion_coverage`; never inferred from an
// overall count of green checks. A legacy (v1) proposal or result has no coverage at all.

export const CRITERION_STATUS_LABEL: Readonly<Record<CriterionStatus, string>> =
	{
		satisfied: "Satisfied",
		unsatisfied: "Not satisfied — a mapped check failed",
		unresolved: "Unresolved — no passing check with log evidence",
	};

export const CHECK_OUTCOME_LABEL: Readonly<Record<CheckOutcome, string>> = {
	passed: "passed",
	failed: "failed",
	incomplete: "incomplete",
	missing: "missing (no result)",
};

/** What `satisfied` means (and does not mean) under the simulated M1 contract. */
export const COVERAGE_SATISFIED_NOTE =
	"Satisfied = the mapped checks passed with sealed evidence under the simulated contract. It is not proof that the requirement is met, and no real provider verified it.";

/** `#evidence-status` of an accepted result whose `valid` reading is stale (UI freshness policy). */
export const ACCEPTED_STALE_EVIDENCE_LABEL =
	"Valid at the last check — may be out of date";

export const LEGACY_COVERAGE_NOTE =
	"No criterion coverage — a new proposal and approval are required.";

export const LEGACY_PROPOSAL_NOTE =
	"Legacy proposal: its criteria have no ids and no check mapping. No criterion coverage — a new proposal and approval are required.";

export const NO_RESULT_COVERAGE_NOTE =
	"No result was sealed for this execution, so no criterion is covered.";

export const PENDING_RESULT_COVERAGE_NOTE =
	"Criterion coverage is computed from the sealed result once this execution finishes.";

export const UNMAPPED_HINT =
	"Every criterion needs at least one trusted check before it can be submitted.";

/** Worst criterion status of a coverage list (for one attribute; never a green count). */
export function worstCriterionStatus(
	statuses: readonly CriterionStatus[],
): CriterionStatus {
	if (statuses.includes("unsatisfied")) return "unsatisfied";
	if (statuses.includes("unresolved") || statuses.length === 0)
		return "unresolved";
	return "satisfied";
}

// ── validity freshness (UI policy only; NOTES.md "Validity freshness") ─────
// The hub re-checks periodically (CONTRACT_V1_2.md §C: no fixed deadline). The UI shows how old the
// last check is and, past a documented threshold or when the connection is offline / stale, says the
// reading may be out of date. This never changes the hub's status (`data-status`) or the historical
// decision; it only stops a stale `valid` from reading as a green "verified".

/** A last check older than this reads "may be out of date" (two default sweep intervals). */
export const VALIDITY_STALE_AFTER_MS = 60_000;
/** No confirmed hub read for this long (five missed 2 s polls) = a stale connection. */
export const CONNECTION_STALE_AFTER_MS = 10_000;

/** Presentation only: no recent confirmed read is not an unqualified online connection. */
export function connectionIsStale(
	conn: { status: string; lastConfirmedAt: string | null },
	now = Date.now(),
): boolean {
	const confirmed = conn.lastConfirmedAt
		? Date.parse(conn.lastConfirmedAt)
		: Number.NaN;
	return (
		conn.status !== "online" ||
		!Number.isFinite(confirmed) ||
		now - confirmed > CONNECTION_STALE_AFTER_MS
	);
}

export interface ValidityFreshness {
	stale: boolean;
	cause: "fresh" | "old_check" | "connection";
	/** now − checked_at, floored at 0 (a check stamped in the future reads as just now). */
	ageMs: number;
	/** `[data-testid=validity-freshness]` text. */
	line: string;
}

/** Human age: seconds below 2 min, minutes below 2 h, else hours. */
export function ageText(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 120) return `${s} s`;
	const m = Math.floor(s / 60);
	if (m < 120) return `${m} min`;
	return `${Math.floor(m / 60)} h`;
}

export function validityFreshness(
	checkedAt: string,
	now: number,
	conn: { status: string; lastConfirmedAt: string | null },
): ValidityFreshness {
	const t = Date.parse(checkedAt);
	const ageMs = Number.isFinite(t)
		? Math.max(0, now - t)
		: Number.POSITIVE_INFINITY;
	const connStale = connectionIsStale(conn, now);
	const oldCheck = !(ageMs <= VALIDITY_STALE_AFTER_MS);
	const age = Number.isFinite(ageMs)
		? `Last check ${ageText(ageMs)} ago (${clockTime(checkedAt)})`
		: "Last check time unknown";
	if (!connStale && !oldCheck)
		return { stale: false, cause: "fresh", ageMs, line: `${age}.` };
	return {
		stale: true,
		cause: connStale ? "connection" : "old_check",
		ageMs,
		line: connStale
			? `${age} — may be out of date: the connection to the hub is offline or stale.`
			: `${age} — may be out of date.`,
	};
}

/** One-line form for history lists (Decision history). */
export function validityShortLabel(
	v: AcceptanceValidityView | null | undefined,
	freshness?: ValidityFreshness | null,
): string {
	if (!v) return "verification unavailable (not reported by the hub)";
	switch (v.status) {
		case "valid":
			if (freshness?.stale)
				return `last check (${clockTime(v.checked_at)}) found it valid — may be out of date`;
			return `current evidence verified (checked ${clockTime(v.checked_at)})`;
		case "invalid":
			return `no longer valid: ${v.reason ? VALIDITY_REASON_LABEL[v.reason] : "its evidence no longer verifies"}`;
		case "unknown":
			return "verification unavailable";
		case "unverifiable":
			return "legacy acceptance — no durable evidence";
	}
}

export interface ValidityDisplay {
	/** `data-status`: the hub's status; `unknown` when the hub reported nothing. */
	status: AcceptanceValidityStatus;
	/** `data-reason`: the hub's reason code, `not_reported`, or null when valid. */
	reason: AcceptanceValidityReason | "not_reported" | null;
	tone: Tone;
	/** role=alert — only for `invalid` (a visible, announced warning). */
	alert: boolean;
	text: string;
	/** Secondary line (detail / timing), never content. */
	note: string | null;
	/** `data-freshness`: UI freshness of the hub's reading (null when none was given / nothing reported). */
	freshness: "fresh" | "stale" | null;
}

/**
 * Display of the current validity of an accepted result (CONTRACT_V1_2.md §C wording). `acceptedAt`
 * = decided_at of the accept decision (history). Pure: renders exactly the hub's view.
 */
export function acceptanceValidityDisplay(
	v: AcceptanceValidityView | null | undefined,
	acceptedAt: string | null,
	fresh?: ValidityFreshness | null,
): ValidityDisplay {
	if (!v)
		return {
			status: "unknown",
			reason: "not_reported",
			tone: "waiting",
			alert: false,
			text: VALIDITY_NOT_REPORTED,
			note: null,
			freshness: null,
		};
	const freshness = fresh ? (fresh.stale ? "stale" : "fresh") : null;
	const detail = v.detail
		? `Detail: ${v.detail}${/[.!?]$/.test(v.detail.trim()) ? "" : "."}`
		: null;
	switch (v.status) {
		case "valid":
			// a stale reading is never a green "verified" (the hub's status stays `valid`)
			if (fresh?.stale)
				return {
					status: "valid",
					reason: null,
					tone: "neutral",
					alert: false,
					text: `Not confirmed as current: the last check (${clockTime(v.checked_at)}) found the accepted evidence valid, but that reading may be out of date.`,
					note: null,
					freshness,
				};
			return {
				status: "valid",
				reason: null,
				tone: "ok",
				alert: false,
				text: `Current evidence verified (checked ${clockTime(v.checked_at)}).`,
				note: null,
				freshness,
			};
		case "invalid": {
			const why = v.reason
				? VALIDITY_REASON_LABEL[v.reason]
				: "its evidence no longer verifies";
			const when = acceptedAt ? dateTime(acceptedAt) : "an earlier date";
			return {
				status: "invalid",
				reason: v.reason,
				tone: "bad",
				alert: true,
				text: `Accepted on ${when}, but this result is no longer valid: ${why}.`,
				note: [
					detail,
					v.first_invalid_at
						? `First found invalid ${dateTime(v.first_invalid_at)}; last checked ${clockTime(v.checked_at)}.`
						: `Last checked ${clockTime(v.checked_at)}.`,
					"The acceptance stays in the history; it cannot be restored. Start a new task for further work.",
				]
					.filter(Boolean)
					.join(" "),
				freshness,
			};
		}
		case "unknown":
			return {
				status: "unknown",
				reason: v.reason,
				tone: "waiting",
				alert: false,
				text: `Verification unavailable: the current evidence could not be checked (last attempt ${clockTime(v.checked_at)}). It is not shown as verified.`,
				note: detail,
				freshness,
			};
		case "unverifiable":
			return {
				status: "unverifiable",
				reason: v.reason,
				tone: "neutral",
				alert: false,
				text: "Legacy acceptance — no durable evidence. Its current validity cannot be verified.",
				note: detail,
				freshness,
			};
	}
}

/** A result request invalidated because its subject changed after sealing (sealed statuses = history). */
export function resultRevocation(
	r: Pick<ApprovalRequestView, "kind" | "status" | "invalidation_reason">,
): "integrity" | "candidate" | null {
	if (r.kind !== "result" || r.status !== "invalidated") return null;
	if (r.invalidation_reason === "integrity_failed") return "integrity";
	if (r.invalidation_reason === "candidate_mutated") return "candidate";
	return null;
}

export const inboxItemName = (
	r: Pick<ApprovalRequestView, "kind">,
	title: string,
): string => `${GATE_NAME[r.kind]} · ${title || "Untitled task"}`;

export function requestStatusLine(
	r: Pick<
		ApprovalRequestView,
		"status" | "invalidation_reason" | "kind" | "invalidation_detail"
	>,
): string {
	const why = r.status === "invalidated" ? invalidationLabel(r) : null;
	if (why) return `Invalidated: ${why}.`;
	return APPROVAL_STATUS_LABEL[r.status];
}

// ── multiple repositories (API v1.2) ─────────────────────────────────────────

/** Where the hub learned of an observed-only repository. */
export const OBSERVED_SOURCE_LABEL: Readonly<
	Record<ObservedRepo["source"], string>
> = {
	github: "GitHub metadata",
	local_checkout: "local checkout",
	telemetry: "session telemetry",
};

export const OBSERVED_GROUP_NOTE =
	"Seen by the hub but not on the managed allowlist: these repositories cannot be assigned work, approved or run.";

export const OBSERVED_REPO_NOTE =
	"Observed only — not on the allowlist. No work can be assigned, approved or run in this repository.";

export const UNKNOWN_REPO_NOTE =
	"This repository is not on the allowlist and not known to this hub.";

export const QUARANTINE_PAUSE_NOTE =
	"claims paused: a process is quarantined (any repository)";

export interface QueueLine {
	/** slot = holds the single engine slot; queued = waiting (position known); unknown = queued, position not in the record. */
	kind: "slot" | "queued" | "unknown";
	text: string;
}

/**
 * The global queue line of one execution (`[data-testid=queue-status]`, briefing): exactly what the
 * hub's execution queue records — the engine runs ONE execution at a time across every repository.
 * null when the execution is neither in the queue nor queued (nothing to say).
 */
export function queueLine(
	queue: ExecutionQueue | null | undefined,
	managedTaskId: string,
	engineState: TaskState,
	ownRepo: string,
	titleOf: (workspaceTaskId: string | null) => string | null,
): QueueLine | null {
	const paused = queue?.claims_paused_by_quarantine ?? false;
	if (queue?.active?.managed_task_id === managedTaskId)
		return {
			kind: "slot",
			text: "Holds the engine slot: the only execution running across all repositories.",
		};
	const idx =
		queue?.queued.findIndex((q) => q.managed_task_id === managedTaskId) ?? -1;
	if (queue && idx >= 0) {
		const parts = [`Queued · position ${idx + 1} of ${queue.queued.length}`];
		const a = queue.active;
		if (a) {
			const title =
				titleOf(a.workspace_task_id) ??
				"an execution not linked to a workspace task";
			parts.push(
				`waiting behind ${a.repo_id} · ${title}${a.repo_id !== ownRepo ? " (another repository)" : ""}`,
			);
		} else if (idx === 0) parts.push("next to be claimed");
		else
			parts.push(
				`waiting behind ${idx} earlier execution${idx === 1 ? "" : "s"}`,
			);
		if (paused) parts.push(QUARANTINE_PAUSE_NOTE);
		return { kind: "queued", text: parts.join(" · ") };
	}
	if (engineState === "queued")
		return {
			kind: "unknown",
			text: paused
				? `Queued · ${QUARANTINE_PAUSE_NOTE}`
				: "Queued · queue position unknown",
		};
	return null;
}

/** UTC clock time for "last confirmed" and history lines (deterministic, no locale). */
export function clockTime(iso: string | null): string {
	if (!iso) return "never";
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return "unknown time";
	return `${new Date(t).toISOString().slice(11, 19)} UTC`;
}

export function dateTime(iso: string): string {
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return iso;
	return `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export const shortHash = (h: string | null, n = 12): string =>
	h ? h.slice(0, n) : "—";

/** Decision outcome copy for the "Decision status" region. */
export function committedMessage(
	kind: ApprovalKind,
	action: DecisionAction,
): string {
	if (kind === "run")
		return action === "approve"
			? "Execution approved. The execution is queued."
			: action === "reject"
				? "Execution rejected. Nothing will run; the task is closed."
				: "Changes requested. Edit the draft and submit a new version.";
	return action === "accept"
		? `Result accepted. ${ACCEPTANCE_SCOPE_NOTE}`
		: action === "reject"
			? "Result rejected. No repair or new execution follows; the task is closed."
			: "Changes requested on the result. Edit the draft and submit a new version.";
}

export const OUTCOME_UNKNOWN =
	"Decision outcome unknown. The connection failed before the answer arrived. Check the outcome before deciding again.";

const ERROR_COPY: Partial<Record<string, string>> = {
	stale_binding: "The request changed since it was loaded.",
	invalid_state: "This request is no longer open for a decision.",
	challenge_invalid:
		"The approval window is no longer valid (expired, replaced or used).",
	confirmation_mismatch: "The signature did not match exactly.",
	idempotency_conflict: "This retry key was already used for another decision.",
	integrity_failed: "The result no longer verifies, so it cannot be accepted.",
	evidence_unavailable:
		"Required evidence is unavailable, so it cannot be accepted.",
	forbidden_scope: "This session may read but not decide.",
	csrf_invalid: "The session check failed. Sign in again.",
	forbidden_origin: "This page's origin is not allowed to decide.",
	live_disabled: "Live execution is disabled in this milestone.",
	repo_not_allowed: "This repository is not on the allowlist.",
	not_found: "It no longer exists.",
	invalid_request: "The request was not valid.",
	disabled: "The workspace is not enabled on this hub.",
	unauthenticated: "Your session ended.",
};

export const errorCopy = (code: string, fallback: string): string =>
	ERROR_COPY[code] ?? fallback;

/** Every visible static string of this module (audited by copy.test.ts). */
export function allStaticCopy(): string[] {
	const out: string[] = [
		OBSOLETE_GRANT_LABEL,
		OBSOLETE_GRANT_NOTE,
		OBSOLETE_GRANT_PENDING_NOTE,
		COVERAGE_SATISFIED_NOTE,
		ACCEPTED_STALE_EVIDENCE_LABEL,
		LEGACY_COVERAGE_NOTE,
		LEGACY_PROPOSAL_NOTE,
		NO_RESULT_COVERAGE_NOTE,
		PENDING_RESULT_COVERAGE_NOTE,
		UNMAPPED_HINT,
		INTEGRITY_FAILED_LABEL,
		VALIDITY_NOT_REPORTED,
		ACCEPTED_ORIGINAL_NOTE,
		ACCEPTANCE_SCOPE_NOTE,
		SIMULATION_NOTE,
		FIXTURE_NOTE,
		OUTCOME_UNKNOWN,
		OBSERVED_GROUP_NOTE,
		OBSERVED_REPO_NOTE,
		UNKNOWN_REPO_NOTE,
		QUARANTINE_PAUSE_NOTE,
	];
	const tables = [
		PHASE_LABEL,
		ENGINE_STATE_LABEL,
		GATE_NAME,
		SIGNATURE_LABEL,
		GRANT_BUTTON,
		ACTION_LABEL,
		APPROVAL_STATUS_LABEL,
		INVALIDATION_LABEL,
		EVIDENCE_LABEL,
		FAILURE_LABEL,
		ERROR_COPY,
		VALIDITY_REASON_LABEL,
		ACCEPTED_HISTORY_EVIDENCE_LABEL,
		CRITERION_STATUS_LABEL,
		CHECK_OUTCOME_LABEL,
		OBSERVED_SOURCE_LABEL,
	] as Record<string, string | undefined>[];
	for (const table of tables)
		for (const v of Object.values(table)) if (v) out.push(v);
	const stages: WorkspaceStage[] = [
		"draft",
		"awaiting_run_approval",
		"queued",
		"running",
		"cancel_requested",
		"awaiting_acceptance",
		"accepted",
		"rejected",
		"changes_requested",
		"execution_ended",
		"cancelled",
	];
	for (const s of stages) {
		out.push(nextAction(s, "failed"), nextAction(s, "interrupted"));
	}
	const at = "2026-10-02T00:00:00.000Z";
	out.push(acceptanceValidityDisplay(null, at).text, validityShortLabel(null));
	const atMs = Date.parse(at);
	const freshnessSamples = [
		validityFreshness(at, atMs + 1_000, {
			status: "online",
			lastConfirmedAt: at,
		}),
		validityFreshness(at, atMs + 5 * 60_000, {
			status: "online",
			lastConfirmedAt: new Date(atMs + 5 * 60_000).toISOString(),
		}),
		validityFreshness(at, atMs + 1_000, {
			status: "offline",
			lastConfirmedAt: at,
		}),
	];
	for (const f of freshnessSamples) out.push(f.line);
	const obsolete = {
		kind: "run",
		status: "invalidated",
		invalidation_reason: "evidence_unavailable",
		invalidation_detail: OBSOLETE_V1_GRANT_DETAIL,
	} as const;
	out.push(
		requestStatusLine(obsolete),
		errorCopyOf({
			error: "stale_binding",
			message: "x",
			issues: [{ path: "proposal_id", message: OBSOLETE_V1_GRANT_DETAIL }],
		}),
	);
	for (const status of ["valid", "invalid", "unknown", "unverifiable"] as const)
		for (const reason of [
			...(Object.keys(VALIDITY_REASON_LABEL) as AcceptanceValidityReason[]),
			null,
		]) {
			const d = acceptanceValidityDisplay(
				{
					decision_id: "wsd-00000000-0000-4000-8000-000000000001",
					status,
					reason: status === "valid" ? null : reason,
					detail: null,
					checked_at: at,
					first_invalid_at: status === "invalid" ? at : null,
					evidence_bundle_digest: null,
				},
				at,
			);
			out.push(d.text);
			if (d.note) out.push(d.note);
			const stale = acceptanceValidityDisplay(
				{
					decision_id: "wsd-00000000-0000-4000-8000-000000000001",
					status,
					reason: status === "valid" ? null : reason,
					detail: null,
					checked_at: at,
					first_invalid_at: status === "invalid" ? at : null,
					evidence_bundle_digest: null,
				},
				at,
				freshnessSamples[1],
			);
			out.push(stale.text);
			out.push(
				validityShortLabel({
					decision_id: "wsd-00000000-0000-4000-8000-000000000001",
					status,
					reason: status === "valid" ? null : reason,
					detail: null,
					checked_at: at,
					first_invalid_at: status === "invalid" ? at : null,
					evidence_bundle_digest: null,
				}),
			);
		}
	out.push(
		validityShortLabel(
			{
				decision_id: "wsd-00000000-0000-4000-8000-000000000001",
				status: "valid",
				reason: null,
				detail: null,
				checked_at: at,
				first_invalid_at: null,
				evidence_bundle_digest: null,
			},
			freshnessSamples[1],
		),
	);
	for (const kind of ["run", "result"] as const)
		for (const a of ["approve", "accept", "request_changes", "reject"] as const)
			out.push(committedMessage(kind, a));
	for (const a of [
		"accepted",
		"invalidated",
		"rejected",
		"changes_requested",
	] as const)
		out.push(engineLabel("human_ready", a));
	for (const state of [
		"human_ready",
		"executing",
		"failed",
		"cancelled",
	] as const)
		for (const stage of ["queued", "running", "cancel_requested"] as const) {
			const note = engineAheadNote({
				task: { stage } as WorkspaceTaskSummary,
				engine: { state, result_run_id: null } as EngineView,
				approval_requests: [],
			});
			if (note) out.push(note);
		}
	return out;
}
