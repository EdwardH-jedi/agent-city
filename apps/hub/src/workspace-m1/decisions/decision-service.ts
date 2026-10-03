// DecisionService (ports.ts, role 04): approval challenges and the two human gates.
//
// Normative order (INTERFACE.md §7, OQ-1). The HTTP guard (role 03) already did body limit →
// session → exact Origin → CSRF → scope → JSON content-type. Here:
//
//   live precedence → strict parse → receipt lookup (operator_id, idempotency_key)
//     found:  same payload_hash → stored receipt, `replayed: true`, stored status, NO effects
//             different payload → 409 idempotency_conflict
//     absent: confirmation exactly `Edward` (approve/accept) → 422 confirmation_mismatch
//             → cheap pre-checks (outside any transaction; status / kind / binding / rev / stage)
//             → Gate 2 only: revalidateForGate2 (06) OUTSIDE any transaction
//                  transient seal failure / ineligible-but-unchanged → 409 evidence_unavailable (no write, R-E5)
//                  integrity failure → invalidate the request in its OWN small transaction → 409 integrity_failed
//             → Gate 2 accept only (v1.2 §A/§B), also OUTSIDE any transaction:
//                  no durable bundle digest (legacy) → invalidate → 409 evidence_unavailable
//                  stored envelope not eligible under resultEligibilityV1_2(envelope, stored
//                  proposal) — e.g. a legacy v1 proposal (criteria_unmapped) → invalidate → 409
//                  evidence_unavailable (independent of the sealer's own verdict below)
//                  verifyBundle: transient I/O → 409 evidence_unavailable (no write);
//                  any other failure → invalidate naming the bundle → 409 integrity_failed
//                  (the bundle is never republished: it is the sealer's bytes from Gate-2 opening)
//             → ONE `BEGIN IMMEDIATE`:
//                  re-check receipt (a concurrent duplicate may have committed)
//                  re-load request + task + engine; every check returns an error BEFORE any write
//                  verifyAndConsume (03) — the first write to the request row (r → r+1)
//                  ── point of no return: every failure from here THROWS (rollback, R-A2) ──
//                  insertDecision (+ receipt; accept: + evidence_bundle_digest, = the verified one)
//                  → accept: current-validity row `valid` (v1.2 §C) → close request (r+1 → r+2) → move stage
//                  → Gate 1 approve: enqueueApproved(now = decided_at) | Gate 1 changes/reject: releaseReserved
//                  → Gate 2: nothing (engine stays human_ready; nothing merged)
//                  → assert the effects equal the precomputed receipt
//             → 201 {receipt, replayed: false}
//
// A failed attempt leaves no durable trace (no receipt, challenge unconsumed) — except the Gate-2
// integrity invalidation, which records what revalidation found (lead ruling), and the obsolete v1
// execution grant below.
//
// Obsolete v1 execution grants (follow-up to CONTRACT_V1_2.md §A). A Gate-1 (run) request whose
// stored proposal is not v1.2 has no criterion coverage, so its result can never be accepted
// (criteria_unmapped). Such a grant is never challenged, never decided and never executed:
//   challenge issuance / any decision attempt (after receipt replay, before subjectProblem) on a
//   PENDING one → the request is invalidated (OBSOLETE_V1_GRANT_REASON, OBSOLETE_V1_GRANT_DETAIL),
//   its unlaunched reservation released (releaseReserved) and the task moved back to draft
//   (run_request_invalidated) — the same rows the bridge sweep writes — then 409 `stale_binding` with
//   one fixed issue {path: "proposal_id", message: OBSOLETE_V1_GRANT_DETAIL}. `stale_binding` because
//   an invalidated request already answers `stale_binding` (subjectProblem): every later attempt on
//   it (retry, replayed body, new process) gets this same refusal, issue included, whoever
//   invalidated it (sweep or attempt). No decision, no receipt, no challenge, no queue effect.
//   Inside the decision transaction the same check runs again before the challenge is consumed.
// Already approved / queued v1 executions are denied at the stage-authorization boundary
// (bridge/authorize.ts, checked before every stage) and the reconciler records their cancel intent.
// Historical rows (proposals, decisions, receipts, validity) are never rewritten; a stored receipt
// still replays verbatim.

import type { TaskState } from "@agent-city/schema";
import {
	type AnyProposalSnapshot,
	ApprovalRequestId,
	type ApprovalRequestRow,
	approvalStatusFor,
	CHALLENGE_TTL_MS,
	ChallengeIssueRequest,
	ChallengeIssueResponse,
	type CommandOutcome,
	canTransitionApproval,
	canTransitionWorkspace,
	confirmationMatches,
	DECISION_CONTRACT,
	DECISION_STAGE,
	type DecisionAction,
	DecisionReceiptBody,
	DecisionRequest,
	DecisionResponse,
	type DecisionService,
	decisionPayloadFrom,
	type InvalidationReason,
	isProposalV1_2,
	type ManagedDecisionRow,
	type ManagedProposalRow,
	requestsNonSimulatedMode,
	resultEligibilityV1_2,
	stageAfterDecision,
	type VerifiedAuthContext,
	type WorkspaceErrorCode,
	type WorkspaceTaskRow,
} from "@agent-city/schema/workspace-m1";
import {
	decisionPayloadHash,
	hashesEqual,
	newWorkspaceId,
	sealExecutionBinding,
} from "@agent-city/schema/workspace-m1/hash";
import { findRepo } from "../../managed/config.ts";
import { getTask } from "../../managed/store.ts";
import {
	LEGACY_PROPOSAL_DETAIL,
	LEGACY_RESULT_DETAIL,
	verifyBundle,
} from "../evidence/bundle.ts";
import { revalidateForGate2 } from "../evidence/sealer.ts";
import type { PersistentWorkspaceTx } from "../persistence/index.ts";
import type { WorkspaceServiceDeps } from "./deps.ts";
import {
	DecisionAbort,
	fail,
	issuesOf,
	mapKnownError,
	ok,
	ResponseContractError,
} from "./outcome.ts";

/** Seal failures that say "cannot verify right now", not "the evidence changed" (R-E5). */
export const TRANSIENT_SEAL_ERRORS: ReadonlySet<string> = new Set([
	"timeout",
	"repo_unavailable",
	"candidate_unavailable",
	// the sealer was wired without workspace reads: a hub fault, never the evidence's
	"revalidation_unavailable",
]);

// ── obsolete v1 execution grants (see the header) ───────────────────────────

/**
 * Recorded reason (existing closed set, 008 CHECK). The same reason the result of a legacy v1
 * proposal is invalidated with at Gate 2 (criteria_unmapped): the evidence acceptance requires —
 * per-criterion coverage — can never exist for this proposal. Not `policy_changed`: that names a
 * change of the repository's managed policy hash, which did not happen.
 */
export const OBSOLETE_V1_GRANT_REASON: InvalidationReason =
	"evidence_unavailable";
/** Fixed, UI-readable text: request invalidation_detail, error issue, authorize denial. */
export const OBSOLETE_V1_GRANT_DETAIL =
	"obsolete v1 proposal without criterion coverage; publish a new version and request a fresh execution approval";
/** Workspace stage_detail after the pending grant is invalidated (sweep and decision path alike). */
export const OBSOLETE_V1_GRANT_STAGE_DETAIL = `Gate 1 was invalidated: ${OBSOLETE_V1_GRANT_DETAIL}`;
/** The one fixed issue of the 409 `stale_binding` refusal. */
export const OBSOLETE_V1_GRANT_ISSUES = [
	{ path: "proposal_id", message: OBSOLETE_V1_GRANT_DETAIL },
] as const;

/** A proposal that can no longer be approved or executed (anything but v1.2: no criterion coverage). */
export const isObsoleteExecutionProposal = (s: AnyProposalSnapshot): boolean =>
	!isProposalV1_2(s);

/** A PENDING Gate-1 request whose stored proposal is obsolete. A failing read throws (fail closed). */
export function isObsoletePendingGrant(
	reads: { getProposal(id: string): ManagedProposalRow | null },
	row: ApprovalRequestRow,
): boolean {
	if (row.kind !== "run" || row.status !== "pending") return false;
	const proposal = reads.getProposal(row.proposal_id);
	return proposal !== null && isObsoleteExecutionProposal(proposal.snapshot);
}

/** A Gate-1 request this policy already invalidated (its stored reason + detail; no proposal read). */
export const isObsoleteInvalidatedGrant = (row: ApprovalRequestRow): boolean =>
	row.kind === "run" &&
	row.status === "invalidated" &&
	row.invalidation_reason === OBSOLETE_V1_GRANT_REASON &&
	row.invalidation_detail === OBSOLETE_V1_GRANT_DETAIL;

export const hasDecideScope = (auth: VerifiedAuthContext): boolean =>
	auth?.origin_verified === true &&
	auth.csrf_verified === true &&
	auth.principal.scopes.includes("workspace:decide");

/** Status / kind / binding / rev / stage of a request against a decision or challenge body. */
function subjectProblem(
	row: ApprovalRequestRow,
	task: WorkspaceTaskRow | null,
	body: { kind: string; binding_hash: string; expected_request_rev: number },
): WorkspaceErrorCode | null {
	// a superseded / withdrawn / invalidated subject is a stale binding even if the client's
	// binding_hash still equals the row's (ADV-CHAL-04, ADV-INVAL-01)
	if (row.status === "invalidated") return "stale_binding";
	if (row.status !== "pending") return "invalid_state";
	if (body.kind !== row.kind) return "stale_binding";
	if (!task || task.stage !== DECISION_STAGE[row.kind]) return "invalid_state";
	if (task.current_managed_task_id !== row.managed_task_id)
		return "stale_binding";
	if (row.kind === "run" && task.current_proposal_id !== row.proposal_id)
		return "stale_binding";
	if (body.binding_hash !== row.binding_hash) return "stale_binding";
	if (body.expected_request_rev !== row.rev) return "stale_binding";
	return null;
}

export interface DecisionServiceImpl extends DecisionService {
	/** Exposed for the router; same semantics as the port. */
	readonly deps: WorkspaceServiceDeps;
}

export function createDecisionService(
	deps: WorkspaceServiceDeps,
): DecisionServiceImpl {
	const { store, bridge, challenges, config } = deps;
	/**
	 * The authoritative "now". Called inside the transaction callback — which runs only after
	 * BEGIN IMMEDIATE holds the write lock — so time spent waiting for the lock, in Gate-2
	 * revalidation or anywhere before the transaction can never make an expired session or
	 * challenge look live at the commit boundary (review finding: request-start time was used).
	 */
	const authoritativeNow = (): Date =>
		deps.clock ? deps.clock.now() : new Date();

	const replayOrConflict = (
		prior: ManagedDecisionRow,
		payload_hash: string | null,
	): CommandOutcome<DecisionResponse> => {
		if (payload_hash === null || !hashesEqual(prior.payload_hash, payload_hash))
			return fail("idempotency_conflict");
		const parsed = DecisionResponse.safeParse({
			receipt: prior.response_body,
			replayed: true,
		});
		if (!parsed.success) throw new ResponseContractError("stored receipt");
		return ok(prior.response_status, parsed.data);
	};

	/** Gate 1 engine pre-checks (inside the tx, before the challenge is consumed). */
	const runEngineProblem = (
		row: ApprovalRequestRow,
		task: WorkspaceTaskRow,
		action: DecisionAction,
	): WorkspaceErrorCode | null => {
		const engine = bridge.engineView(row.managed_task_id);
		if (!engine) return "invalid_state";
		if (action !== "approve")
			return engine.state === "draft" || engine.state === "cancelled"
				? null
				: "invalid_state";
		if (engine.state !== "draft" || engine.quarantined) return "invalid_state";
		if (!findRepo(config, task.repo_id)) return "repo_not_allowed";
		// the execution binding must recompute under the CURRENT trusted policy (§6 gate1_approve)
		const recomputed = sealExecutionBinding({
			proposal_id: row.proposal_id,
			proposal_hash: row.proposal_hash,
			managed_task_id: row.managed_task_id,
			base_sha: row.execution_binding.base_sha,
			policy_hash: bridge.currentPolicyHash(task.repo_id),
		}).hash;
		if (!hashesEqual(recomputed, row.execution_binding_hash))
			return "stale_binding";
		return null;
	};

	/** Gate 2 engine pre-checks: still human_ready on this attempt, no cancel, no quarantine. */
	const resultEngineProblem = (
		row: ApprovalRequestRow,
		task: WorkspaceTaskRow,
	): WorkspaceErrorCode | null => {
		if (task.cancel_requested_at !== null) return "invalid_state";
		const engine = bridge.engineView(row.managed_task_id);
		if (
			engine?.state !== "human_ready" ||
			engine.result_run_id !== row.run_id ||
			engine.cancel_requested_at !== null ||
			engine.quarantined
		)
			return "invalid_state";
		return null;
	};

	/** Record a Gate-2 integrity failure: request → invalidated, task → execution_ended (§6). */
	const invalidateResult = (
		row: ApprovalRequestRow,
		why: {
			reason: "integrity_failed" | "candidate_mutated" | "evidence_unavailable";
			detail: string;
			stage_detail?: string;
		},
		now: Date,
	): void => {
		const at = now.toISOString();
		store.transaction((tx) => {
			const cur = tx.getApprovalRequest(row.id);
			if (
				cur?.status !== "pending" ||
				!hashesEqual(cur.binding_hash, row.binding_hash)
			)
				return;
			const closed = tx.updateApprovalRequest(
				cur.id,
				cur.rev,
				{
					status: "invalidated",
					invalidation_reason: why.reason,
					invalidation_detail: why.detail.slice(0, 1000),
					closed_at: at,
				},
				at,
			);
			if (!closed) throw new Error("CAS miss while invalidating the result");
			const task = tx.getTask(cur.workspace_task_id);
			if (
				task &&
				task.stage === "awaiting_acceptance" &&
				task.current_managed_task_id === cur.managed_task_id
			) {
				const moved = tx.updateTask(
					task.id,
					task.rev,
					{
						stage: "execution_ended",
						stage_detail:
							why.stage_detail ??
							"the result failed revalidation and can no longer be accepted",
					},
					at,
				);
				if (!moved) throw new Error("CAS miss while ending the execution");
			}
		});
	};

	/**
	 * Obsolete v1 grant met on a challenge / decision attempt: request → invalidated, unlaunched
	 * reservation released, task → draft (`run_request_invalidated`, the reconciler-class transition,
	 * like invalidateResult's) — the rows bridge/reconciler.ts `invalidatePending` writes for the same
	 * verdict. Writes nothing unless the request is still its task's current pending Gate 1 with a
	 * draft / cancelled reservation (anything else is the reconciler's violation path; the caller still
	 * refuses). Runs inside the caller's transaction.
	 */
	const invalidateObsoleteGrant = (
		tx: PersistentWorkspaceTx,
		approval_request_id: string,
		at: string,
	): boolean => {
		const r = tx.getApprovalRequest(approval_request_id);
		if (r?.kind !== "run" || r.status !== "pending") return false;
		const t = tx.getTask(r.workspace_task_id);
		if (
			t?.stage !== "awaiting_run_approval" ||
			t.current_managed_task_id !== r.managed_task_id ||
			!canTransitionWorkspace(
				t.stage,
				"draft",
				"run_request_invalidated",
				"reconciler",
			)
		)
			return false;
		const engine = bridge.engineView(r.managed_task_id);
		if (engine?.state !== "draft" && engine?.state !== "cancelled")
			return false;
		const closed = tx.updateApprovalRequest(
			r.id,
			r.rev,
			{
				status: "invalidated",
				invalidation_reason: OBSOLETE_V1_GRANT_REASON,
				invalidation_detail: OBSOLETE_V1_GRANT_DETAIL,
				closed_at: at,
			},
			at,
		);
		if (!closed)
			throw new Error("CAS miss while invalidating an obsolete grant");
		bridge.releaseReserved(tx, {
			managed_task_id: r.managed_task_id,
			reason: OBSOLETE_V1_GRANT_REASON,
			now: at,
		});
		const moved = tx.updateTask(
			t.id,
			t.rev,
			{ stage: "draft", stage_detail: OBSOLETE_V1_GRANT_STAGE_DETAIL },
			at,
		);
		if (!moved) throw new Error("CAS miss while returning the task to draft");
		return true;
	};

	const obsoleteRefusal = () => fail("stale_binding", OBSOLETE_V1_GRANT_ISSUES);

	const decideInTx = (
		tx: PersistentWorkspaceTx,
		auth: VerifiedAuthContext,
		id: string,
		req: DecisionRequest,
		payload: ReturnType<typeof decisionPayloadFrom>,
		payload_hash: string,
		sealed_envelope_hash: string | null,
		verified_bundle_digest: string | null,
		now: Date,
	): CommandOutcome<DecisionResponse> => {
		const op = auth.principal.operator_id;
		const again = tx.findReceipt(op, req.idempotency_key);
		if (again) return replayOrConflict(again, payload_hash);

		const row = tx.getApprovalRequest(id);
		if (!row) return fail("not_found");
		const task = tx.getTask(row.workspace_task_id);
		const problem = subjectProblem(row, task, req);
		if (problem) return fail(problem);
		if (!task) return fail("invalid_state");
		if (row.kind === "run") {
			// obsolete v1 grant (re-checked under the write lock, before the challenge is consumed;
			// the pre-check outside this transaction already invalidated it — no write here)
			if (isObsoletePendingGrant(tx, row)) return obsoleteRefusal();
			const p = runEngineProblem(row, task, req.action);
			if (p) return fail(p);
		} else {
			if (
				sealed_envelope_hash === null ||
				row.result_envelope_hash === null ||
				!hashesEqual(sealed_envelope_hash, row.result_envelope_hash)
			)
				return fail("integrity_failed");
			if (req.action === "accept") {
				// v1.2 §B: the acceptance names the durable bundle verified outside this transaction,
				// and it must be the (immutable) bundle this request was opened with
				const digest = row.evidence_bundle_digest ?? null;
				if (digest === null) return fail("evidence_unavailable");
				if (
					verified_bundle_digest === null ||
					!hashesEqual(digest, verified_bundle_digest)
				)
					return fail("integrity_failed");
			}
			const p = resultEngineProblem(row, task);
			if (p) return fail(p);
		}

		const verdict = challenges.verifyAndConsume(
			tx,
			row,
			req.challenge,
			auth,
			now,
		);
		if (!verdict.ok) return fail("challenge_invalid");

		// ── point of no return: from here every failure THROWS so the consume rolls back ──
		const consumed = tx.getApprovalRequest(id);
		if (
			!consumed ||
			consumed.rev !== row.rev + 1 ||
			consumed.challenge_status !== "consumed" ||
			consumed.status !== "pending"
		)
			throw new Error("challenge consumption did not move the request once");
		deps.hooks?.inDecisionTx?.("after_consume", id);

		const decided_at = now.toISOString();
		const decision_id = newWorkspaceId("wsd");
		const status = approvalStatusFor(req.action);
		const { to, trigger } = stageAfterDecision(row.kind, req.action);
		if (
			!canTransitionApproval(row.kind, "pending", status) ||
			!canTransitionWorkspace(task.stage, to, trigger, "operator")
		)
			throw new DecisionAbort("invalid_state", "transition not in the table");
		const engineAfter: TaskState =
			row.kind === "run"
				? req.action === "approve"
					? "queued"
					: "cancelled"
				: "human_ready";
		const accept = row.kind === "result" && req.action === "accept";
		const bundleDigest = accept ? verified_bundle_digest : null;
		if (accept && bundleDigest === null)
			throw new Error("an acceptance without a verified evidence bundle");

		const receipt = DecisionReceiptBody.parse({
			contract: DECISION_CONTRACT,
			decision_id,
			approval_request_id: row.id,
			workspace_task_id: task.id,
			kind: row.kind,
			action: req.action,
			operator_id: op,
			decided_at,
			payload_hash,
			binding_hash: row.binding_hash,
			approval_request: { status, rev: consumed.rev + 1 },
			workspace_task: { stage: to, rev: task.rev + 1 },
			effects: {
				managed_task_id: row.managed_task_id,
				managed_task_state: engineAfter,
				result_envelope_hash:
					row.kind === "result" ? row.result_envelope_hash : null,
				...(bundleDigest ? { evidence_bundle_digest: bundleDigest } : {}),
			},
		});

		tx.insertDecision({
			id: decision_id,
			approval_request_id: row.id,
			workspace_task_id: task.id,
			kind: row.kind,
			action: req.action,
			operator_id: op,
			idempotency_key: req.idempotency_key,
			payload_hash,
			binding_hash: row.binding_hash,
			request_rev: req.expected_request_rev,
			confirmation_text: payload.confirmation_text,
			reason: payload.reason,
			boot_id: auth.principal.boot_id,
			session_generation: auth.principal.session_generation,
			managed_task_id: row.managed_task_id,
			result_envelope_hash:
				row.kind === "result" ? row.result_envelope_hash : null,
			decided_at,
			response_status: 201,
			response_body: receipt,
			...(bundleDigest ? { evidence_bundle_digest: bundleDigest } : {}),
		});
		if (accept && bundleDigest) {
			// v1.2 §C: the CURRENT validity of this acceptance starts verified at the decision time
			tx.insertAcceptanceValidity({
				decision_id,
				result_request_id: row.id,
				workspace_task_id: task.id,
				evidence_bundle_digest: bundleDigest,
				status: "valid",
				reason: null,
				detail: null,
				checked_at: decided_at,
				first_invalid_at: null,
				rev: 1,
			});
		}
		deps.hooks?.inDecisionTx?.("after_insert_decision", id);

		const closed = tx.updateApprovalRequest(
			row.id,
			consumed.rev,
			{ status, closed_at: decided_at },
			decided_at,
		);
		if (!closed) throw new Error("CAS miss while closing the request");
		deps.hooks?.inDecisionTx?.("after_close_request", id);

		const moved = tx.updateTask(
			task.id,
			task.rev,
			accept
				? { stage: to, stage_detail: null, accepted_decision_id: decision_id }
				: { stage: to, stage_detail: null },
			decided_at,
		);
		if (!moved) throw new Error("CAS miss while moving the workspace stage");

		if (row.kind === "run") {
			if (req.action === "approve") {
				const res = bridge.enqueueApproved(tx, {
					managed_task_id: row.managed_task_id,
					decision_id,
					execution_binding_hash: row.execution_binding_hash,
					now: decided_at,
				});
				if (!res.queued)
					throw new DecisionAbort(
						res.reason === "binding_mismatch"
							? "stale_binding"
							: res.reason === "repo_not_allowed"
								? "repo_not_allowed"
								: "invalid_state",
						`enqueue refused: ${res.reason}`,
					);
				// the queue linkage is stamped with the decision time (05 detects any re-queue by it)
				const queued = getTask(store.db, row.managed_task_id);
				if (queued?.run_requested_at !== decided_at)
					throw new Error("queue linkage not stamped with decided_at");
			} else {
				bridge.releaseReserved(tx, {
					managed_task_id: row.managed_task_id,
					reason: req.action === "reject" ? "rejected" : "changes_requested",
					now: decided_at,
				});
			}
		}
		deps.hooks?.inDecisionTx?.("after_effects", id);

		const engine = bridge.engineView(row.managed_task_id);
		if (
			!engine ||
			(accept &&
				tx.getAcceptanceValidity(decision_id)?.evidence_bundle_digest !==
					bundleDigest) ||
			engine.state !== receipt.effects.managed_task_state ||
			closed.rev !== receipt.approval_request.rev ||
			closed.status !== receipt.approval_request.status ||
			moved.rev !== receipt.workspace_task.rev ||
			moved.stage !== receipt.workspace_task.stage
		)
			throw new Error("effects differ from the precomputed receipt");
		const response = DecisionResponse.safeParse({ receipt, replayed: false });
		if (!response.success) throw new ResponseContractError("receipt");
		return ok(201, response.data);
	};

	async function decide(
		auth: VerifiedAuthContext,
		approval_request_id: string,
		body: unknown,
		_requestStart: Date, // request-entry time: never used for authority (see authoritativeNow)
	): Promise<CommandOutcome<DecisionResponse>> {
		try {
			if (!ApprovalRequestId.safeParse(approval_request_id).success)
				return fail("not_found");
			if (!hasDecideScope(auth)) return fail("forbidden_scope");
			if (requestsNonSimulatedMode(body)) return fail("live_disabled");
			const parsed = DecisionRequest.safeParse(body);
			if (!parsed.success)
				return fail("invalid_request", issuesOf(parsed.error));
			const req = parsed.data;
			const op = auth.principal.operator_id;

			const confirmed = confirmationMatches(req);
			let payload: ReturnType<typeof decisionPayloadFrom> | null = null;
			if (confirmed) {
				try {
					payload = decisionPayloadFrom(req, approval_request_id);
				} catch {
					return fail("invalid_request");
				}
			}
			const payload_hash = payload ? decisionPayloadHash(payload) : null;

			const prior = store.findReceipt(op, req.idempotency_key);
			// a mismatched confirmation is necessarily a different payload than any stored one
			if (prior) return replayOrConflict(prior, payload_hash);
			if (!payload || payload_hash === null)
				return fail("confirmation_mismatch");

			// cheap pre-checks outside any transaction (re-done inside it)
			const row = store.getApprovalRequest(approval_request_id);
			if (!row) return fail("not_found");
			if (isObsoletePendingGrant(store, row)) {
				// before subjectProblem: even a stale client learns the real reason; the clock is read
				// inside the transaction (after the write lock), like every other authority write
				store.transaction((tx) =>
					invalidateObsoleteGrant(tx, row.id, authoritativeNow().toISOString()),
				);
				return obsoleteRefusal();
			}
			// every later attempt on it: the same refusal (subjectProblem would say stale_binding too)
			if (isObsoleteInvalidatedGrant(row)) return obsoleteRefusal();
			const problem = subjectProblem(
				row,
				store.getTask(row.workspace_task_id),
				req,
			);
			if (problem) return fail(problem);

			let sealed_envelope_hash: string | null = null;
			let verified_bundle_digest: string | null = null;
			if (row.kind === "result") {
				if (
					req.action === "accept" &&
					(row.evidence_bundle_digest ?? null) === null
				) {
					// v1.2 §B: a result opened before durable evidence existed can never be accepted
					invalidateResult(
						row,
						{
							reason: "evidence_unavailable",
							detail: LEGACY_RESULT_DETAIL,
							stage_detail: LEGACY_RESULT_DETAIL,
						},
						authoritativeNow(),
					);
					return fail("evidence_unavailable");
				}
				if (req.action === "accept") {
					// v1.2 §A: the stored envelope under the v1.2 rule against the stored proposal it names
					// (coverage ids = proposal ids, coverage = derivation from the plan, all satisfied)
					const proposal = store.getProposal(row.proposal_id);
					const verdict =
						proposal &&
						row.result_envelope &&
						hashesEqual(proposal.proposal_hash, row.proposal_hash)
							? resultEligibilityV1_2(row.result_envelope, proposal.snapshot)
							: null;
					if (verdict && !verdict.eligible) {
						const legacy = verdict.reasons.includes("criteria_unmapped");
						invalidateResult(
							row,
							{
								reason: "evidence_unavailable",
								detail: legacy
									? LEGACY_PROPOSAL_DETAIL
									: `the result is not eligible for acceptance (${verdict.reasons.join(", ")})`,
								stage_detail: legacy
									? LEGACY_PROPOSAL_DETAIL
									: "the result is not eligible for acceptance; nothing can be accepted",
							},
							authoritativeNow(),
						);
						return fail("evidence_unavailable");
					}
					// verdict null (row/hash problem): the re-seal below refuses it as an integrity failure
				}
				let check: Awaited<ReturnType<typeof revalidateForGate2>>;
				try {
					check = await revalidateForGate2(deps.sealer, row);
				} catch {
					return fail("evidence_unavailable");
				}
				if (!check.ok) {
					if (
						check.code === "evidence_unavailable" ||
						(check.seal_error !== null &&
							TRANSIENT_SEAL_ERRORS.has(check.seal_error))
					)
						return fail("evidence_unavailable");
					invalidateResult(
						row,
						{
							reason:
								check.seal_error === "candidate_mutated"
									? "candidate_mutated"
									: "integrity_failed",
							detail: `Gate-2 revalidation failed (${check.seal_error ?? "envelope_mismatch"})`,
						},
						authoritativeNow(),
					);
					return fail("integrity_failed");
				}
				sealed_envelope_hash = check.sealed.envelope_hash;
				if (req.action === "accept") {
					// the durable bundle published at Gate-2 opening (never republished from a re-read)
					const digest = row.evidence_bundle_digest as string;
					const record = store.getEvidenceBundle(digest);
					const v =
						record && row.result_envelope && row.result_envelope_hash
							? verifyBundle(config.artifacts_root, {
									digest,
									result_envelope_hash: row.result_envelope_hash,
									envelope: row.result_envelope,
									byte_len: record.byte_len,
								})
							: ({
									ok: false,
									code: "bundle_missing",
									transient: false,
								} as const);
					if (!v.ok) {
						if (v.transient) return fail("evidence_unavailable");
						invalidateResult(
							row,
							{
								reason: "integrity_failed",
								detail: `Gate-2 revalidation failed (durable evidence bundle: ${v.code})`,
								stage_detail:
									"the durable evidence of the result failed verification; it can no longer be accepted",
							},
							authoritativeNow(),
						);
						return fail("integrity_failed");
					}
					verified_bundle_digest = v.digest;
				}
			}

			await deps.hooks?.beforeTransaction?.(row.kind, row.id);
			const p = payload;
			const h = payload_hash;
			// `now` (request entry) is NOT used for authority: the clock is read inside the callback,
			// after the write lock is acquired, and that single value drives session/challenge
			// verification, decided_at and the queue stamp.
			return store.transaction((tx) =>
				decideInTx(
					tx,
					auth,
					approval_request_id,
					req,
					p,
					h,
					sealed_envelope_hash,
					verified_bundle_digest,
					authoritativeNow(),
				),
			);
		} catch (err) {
			const known = mapKnownError(err);
			if (known) return known;
			throw err;
		}
	}

	function issueChallenge(
		auth: VerifiedAuthContext,
		approval_request_id: string,
		body: unknown,
		_requestStart: Date, // request-entry time: never used for authority (see authoritativeNow)
	): CommandOutcome<ChallengeIssueResponse> {
		try {
			if (!ApprovalRequestId.safeParse(approval_request_id).success)
				return fail("not_found");
			if (!hasDecideScope(auth)) return fail("forbidden_scope");
			if (requestsNonSimulatedMode(body)) return fail("live_disabled");
			const parsed = ChallengeIssueRequest.safeParse(body);
			if (!parsed.success)
				return fail("invalid_request", issuesOf(parsed.error));
			const b = parsed.data;
			return store.transaction((tx): CommandOutcome<ChallengeIssueResponse> => {
				const at = authoritativeNow(); // read under the write lock, like decide()
				const row = tx.getApprovalRequest(approval_request_id);
				if (!row) return fail("not_found");
				if (isObsoletePendingGrant(tx, row)) {
					// no challenge for an obsolete v1 grant: invalidate it (committed with this
					// transaction — the refusal is a normal return) and refuse
					invalidateObsoleteGrant(tx, row.id, at.toISOString());
					return obsoleteRefusal();
				}
				if (isObsoleteInvalidatedGrant(row)) return obsoleteRefusal();
				const problem = subjectProblem(
					row,
					tx.getTask(row.workspace_task_id),
					b,
				);
				if (problem) return fail(problem);
				const issued = challenges.issue(tx, row, auth, at);
				const res = ChallengeIssueResponse.safeParse(issued);
				if (
					!res.success ||
					res.data.approval_request_id !== row.id ||
					Date.parse(res.data.expires_at) - at.getTime() > CHALLENGE_TTL_MS
				)
					throw new ResponseContractError("challenge");
				return ok(201, res.data);
			});
		} catch (err) {
			const known = mapKnownError(err);
			if (known) return known;
			throw err;
		}
	}

	return { deps, issueChallenge, decide };
}
