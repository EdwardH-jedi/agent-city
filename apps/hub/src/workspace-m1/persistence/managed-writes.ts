// The three managed-task writes of the workspace path (lead ruling: implemented by 02, wrapped later
// by 05 behind ExecutionBridge.reserve / enqueueApproved / releaseReserved). They only call the
// existing managed store functions (createTask, requestRun, requestCancel) — no direct SQL on any
// managed_* table — and they refuse to run outside an open workspace transaction on the same
// Database handle, so the managed store's own `db.transaction(fn).immediate()` nests as a SAVEPOINT
// and everything commits or rolls back together with the workspace rows.
import type { Database } from "bun:sqlite";
import { type ManagedTask, TaskSubmission } from "@agent-city/schema";
import {
	type AnyProposalSnapshot,
	type EnqueueResult,
	type InvalidationReason,
	managedTaskFieldsFor,
	type ReservedExecution,
	type WorkspaceTx,
} from "@agent-city/schema/workspace-m1";
import {
	canonicalEncode,
	hashesEqual,
	sealAnyProposal,
	sealExecutionBinding,
} from "@agent-city/schema/workspace-m1/hash";
import {
	findRepo,
	type ManagedConfig,
	policyHash,
} from "../../managed/config.ts";
import { approvalHashFor } from "../../managed/service.ts";
import {
	createTask,
	getTask,
	IdempotencyConflictError,
	newId,
	openQuarantineFor,
	requestCancel,
	requestRun,
} from "../../managed/store.ts";
import { openTxOn } from "./store.ts";

export interface ManagedWriteDeps {
	/** The hub's single Database handle — the same one the WorkspaceStore was created on. */
	db: Database;
	/** The orchestrator's frozen config snapshot (source of policy_hash and approval_hash). */
	config: ManagedConfig;
	/** Deterministic failure-injection points for tests. Never set in production. */
	hooks?: ManagedWriteHooks;
}

export interface ManagedWriteHooks {
	/** Called inside enqueueApproved, immediately before and after the existing requestRun. */
	enqueue?: (
		point: "before_request_run" | "after_request_run",
		managed_task_id: string,
	) => void;
}

export type ManagedWriteErrorCode =
	| "proposal_hash_mismatch"
	| "proposal_not_stored"
	| "repo_not_allowed"
	| "submission_altered"
	| "idempotency_conflict"
	| "reserve_failed"
	| "decision_mismatch"
	| "not_found"
	| "not_reserved"
	| "not_draft"
	| "cancel_not_confirmed";

/** A managed write that must not happen. Thrown inside the transaction → everything rolls back. */
export class ManagedWriteError extends Error {
	constructor(
		readonly code: ManagedWriteErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ManagedWriteError";
	}
}

/** policyHash(config, repo_id) of the frozen config (ExecutionBridge.currentPolicyHash). */
export const currentPolicyHash = (config: ManagedConfig, repo_id: string) =>
	policyHash(config, repo_id);

/** The managed_tasks content columns approvalHashFor() covers — must equal the snapshot's. */
function taskContent(t: ManagedTask) {
	return {
		repo_id: t.repo_id,
		title: t.title,
		objective: t.objective,
		acceptance_criteria: t.acceptance_criteria,
		approved_scope: t.approved_scope,
		execution_mode: t.execution_mode,
		simulation_scenario: t.simulation_scenario,
		repair_limit: t.repair_limit,
		base_ref: t.base_ref,
		base_sha: t.base_sha,
	};
}

/**
 * ExecutionBridge.reserve: insert the managed task in state `draft` for one proposal version
 * (Gate-1 open). idempotency_key = approval_request_id, request_hash = execution_binding_hash
 * (OQ-14), fields = managedTaskFieldsFor(snapshot), id pre-minted so the binding can cover it.
 * Call AFTER insertProposal and BEFORE insertApprovalRequest (the request's FK needs the task).
 */
export function reserveManagedTask(
	deps: ManagedWriteDeps,
	tx: WorkspaceTx,
	input: {
		/** v1 | v1.2 (managedTaskFieldsFor maps both; v1.2 criterion texts byte-identical). */
		proposal: AnyProposalSnapshot;
		proposal_hash: string;
		approval_request_id: string;
		now: string;
		/** Pre-minted `task-<uuid>`; minted here when absent. */
		managed_task_id?: string;
	},
): ReservedExecution & { execution_binding_canonical: string } {
	const wtx = openTxOn(tx, deps.db);
	let sealed: ReturnType<typeof sealAnyProposal>;
	try {
		sealed = sealAnyProposal(input.proposal);
	} catch {
		throw new ManagedWriteError(
			"proposal_hash_mismatch",
			"the proposal cannot be sealed",
		);
	}
	if (!hashesEqual(sealed.hash, input.proposal_hash))
		throw new ManagedWriteError(
			"proposal_hash_mismatch",
			"the proposal does not hash to proposal_hash",
		);
	const stored = wtx.getProposal(input.proposal.proposal_id);
	if (!stored || !hashesEqual(stored.proposal_hash, input.proposal_hash))
		throw new ManagedWriteError(
			"proposal_not_stored",
			"reserve needs the immutable proposal row inserted first",
		);
	const p = sealed.value;
	if (!findRepo(deps.config, p.repo_id))
		throw new ManagedWriteError(
			"repo_not_allowed",
			"repository is not in the managed allowlist",
		);

	const managed_task_id = input.managed_task_id ?? newId("task");
	const execution = sealExecutionBinding({
		proposal_id: p.proposal_id,
		proposal_hash: sealed.hash,
		managed_task_id,
		base_sha: p.base_sha,
		policy_hash: policyHash(deps.config, p.repo_id),
	});

	const fields = managedTaskFieldsFor(p);
	const submissionInput = {
		idempotency_key: input.approval_request_id,
		repo_id: fields.repo_id,
		title: fields.title,
		objective: fields.objective,
		acceptance_criteria: fields.acceptance_criteria,
		approved_scope: fields.approved_scope,
		execution_mode: fields.execution_mode,
		simulation_scenario: fields.simulation_scenario,
		repair_limit: fields.repair_limit,
	};
	// TaskSubmission trims and defaults; any change would desync approvalHashFor(task) from the
	// snapshot, so the parse must be the identity here.
	const parsed = TaskSubmission.safeParse(submissionInput);
	if (
		!parsed.success ||
		canonicalEncode(parsed.data) !== canonicalEncode(submissionInput)
	)
		throw new ManagedWriteError(
			"submission_altered",
			"the snapshot does not map 1:1 onto a managed task submission",
		);

	let task: ManagedTask;
	try {
		const res = createTask(deps.db, {
			id: managed_task_id,
			submission: parsed.data,
			request_hash: execution.hash,
			base_ref: fields.base_ref,
			base_sha: fields.base_sha,
			now: input.now,
		});
		task = res.task;
	} catch (err) {
		if (err instanceof IdempotencyConflictError)
			throw new ManagedWriteError(
				"idempotency_conflict",
				"this approval request already reserved a different execution",
			);
		throw err;
	}
	if (
		task.id !== managed_task_id ||
		task.state !== "draft" ||
		canonicalEncode(taskContent(task)) !== canonicalEncode(fields)
	)
		throw new ManagedWriteError(
			"reserve_failed",
			"the reserved managed task does not match the proposal",
		);
	return {
		managed_task_id,
		execution_binding: execution.value,
		execution_binding_hash: execution.hash,
		execution_binding_canonical: execution.canonical,
	};
}

/**
 * ExecutionBridge.enqueueApproved: draft → queued with exactly requestRun's writes, only after
 * re-deriving that this managed task is the reserved execution of the approved proposal under the
 * CURRENT policy. Call AFTER insertDecision (the Gate-1 `approve` must exist in this transaction).
 * Only `draft` is accepted — requestRun alone would also re-queue blocked / interrupted tasks.
 */
export function enqueueApprovedTask(
	deps: ManagedWriteDeps,
	tx: WorkspaceTx,
	input: {
		managed_task_id: string;
		decision_id: string;
		execution_binding_hash: string;
		now: string;
	},
): EnqueueResult {
	const wtx = openTxOn(tx, deps.db);
	const id = input.managed_task_id;
	const task = getTask(deps.db, id);
	if (task?.state !== "draft") return { queued: false, reason: "not_draft" };
	if (!findRepo(deps.config, task.repo_id))
		return { queued: false, reason: "repo_not_allowed" };

	const request = wtx.findRunRequestForManagedTask(id);
	const decision = wtx.getDecision(input.decision_id);
	if (
		!request ||
		(request.status !== "pending" && request.status !== "approved") ||
		!decision ||
		decision.approval_request_id !== request.id ||
		decision.kind !== "run" ||
		decision.action !== "approve" ||
		decision.managed_task_id !== id
	)
		throw new ManagedWriteError(
			"decision_mismatch",
			"no Gate-1 approve decision of this managed task's run request in this transaction",
		);

	const proposal = wtx.getProposal(request.proposal_id);
	const recomputed = sealExecutionBinding({
		proposal_id: request.proposal_id,
		proposal_hash: request.proposal_hash,
		managed_task_id: task.id,
		base_sha: task.base_sha,
		policy_hash: policyHash(deps.config, task.repo_id),
	}).hash;
	if (
		!proposal ||
		!hashesEqual(proposal.proposal_hash, request.proposal_hash) ||
		task.idempotency_key !== request.id ||
		!hashesEqual(task.request_hash, input.execution_binding_hash) ||
		!hashesEqual(
			request.execution_binding_hash,
			input.execution_binding_hash,
		) ||
		!hashesEqual(recomputed, input.execution_binding_hash) ||
		canonicalEncode(taskContent(task)) !==
			canonicalEncode(managedTaskFieldsFor(proposal.snapshot))
	)
		return { queued: false, reason: "binding_mismatch" };
	if (openQuarantineFor(deps.db, id).length > 0)
		return { queued: false, reason: "quarantined" };

	deps.hooks?.enqueue?.("before_request_run", id);
	const res = requestRun(
		deps.db,
		id,
		approvalHashFor(task, deps.config),
		input.now,
	);
	deps.hooks?.enqueue?.("after_request_run", id);
	if (!res) return { queued: false, reason: "not_draft" };
	if (res.quarantined) return { queued: false, reason: "quarantined" };
	if (!res.queued || res.task.state !== "queued")
		return { queued: false, reason: "not_draft" };
	return { queued: true };
}

/**
 * ExecutionBridge.releaseReserved: the reserved `draft` managed task → cancelled through the
 * existing requestCancel (Gate-1 changes/reject, supersede, withdraw, invalidation). Idempotent for
 * an already-cancelled task; anything else (queued, running, finished) is a violation and throws.
 * The reason is recorded on the approval request / decision, not on the managed task.
 */
export function releaseReservedTask(
	deps: ManagedWriteDeps,
	tx: WorkspaceTx,
	input: {
		managed_task_id: string;
		reason: InvalidationReason | "changes_requested" | "rejected";
		now: string;
	},
): void {
	const wtx = openTxOn(tx, deps.db);
	const id = input.managed_task_id;
	const task = getTask(deps.db, id);
	if (!task) throw new ManagedWriteError("not_found", "no such managed task");
	if (!wtx.findRunRequestForManagedTask(id))
		throw new ManagedWriteError(
			"not_reserved",
			"the managed task is not a workspace reservation",
		);
	if (task.state === "cancelled") return;
	if (task.state !== "draft")
		throw new ManagedWriteError(
			"not_draft",
			`the reserved managed task is ${task.state}, not draft`,
		);
	const after = requestCancel(deps.db, id, input.now);
	if (after?.state !== "cancelled")
		throw new ManagedWriteError(
			"cancel_not_confirmed",
			"the reserved managed task did not reach cancelled",
		);
}
