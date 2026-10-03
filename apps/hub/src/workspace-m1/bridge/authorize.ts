// Workspace authorization of one managed task (M1 L3/L5): the check the orchestrator runs with the
// approval binding before EVERY stage (`OrchestratorDeps.authorize`). In workspace mode a managed
// task may proceed only if it is the reserved execution of an approved Gate-1 request whose single
// `approve` decision queued exactly this row, and every binding still recomputes from durable rows.
//
// Synchronous and read-only: plain reads on the hub's Database handle, never `store.transaction()`
// (it runs inside orchestrator flows — 02 rule 6). Every failure is a denial with a fixed reason
// (enum values only; no row content, paths or hashes), and a thrown read (e.g. 02's
// WorkspaceIntegrityError on a tampered hashed column) is a denial too.
//
// Obsolete v1 grants: an approved, queued execution of a proposal that is not v1.2 (no criterion
// coverage — its result can never be accepted) is denied with class `obsolete` under the CURRENT
// policy check (`policy: true`, the orchestrator before every stage), so no further stage launches.
// Like a policy-hash change it is the engine's `approval_void`, not a bridge violation: the
// reconciler's structural pass (`policy: false`) does not flag it (it records the cancel intent).
import type { ManagedTask } from "@agent-city/schema";
import {
	type ApprovalRequestRow,
	type ManagedDecisionRow,
	type ManagedProposalRow,
	managedTaskFieldsFor,
	type WorkspaceStage,
	type WorkspaceTaskRow,
} from "@agent-city/schema/workspace-m1";
import {
	canonicalEncode,
	hashesEqual,
	sealExecutionBinding,
	sealRunApprovalBinding,
} from "@agent-city/schema/workspace-m1/hash";
import {
	findRepo,
	type ManagedConfig,
	policyHash,
} from "../../managed/config.ts";
import {
	isObsoleteExecutionProposal,
	OBSOLETE_V1_GRANT_DETAIL,
} from "../decisions/decision-service.ts";
import type { WorkspaceReadsExt } from "../persistence/index.ts";

/** Workspace stages in which the current execution may run a stage. */
export const AUTHORIZED_STAGES: readonly WorkspaceStage[] = [
	"queued",
	"running",
	"cancel_requested",
];

export type DenialClass =
	/** execution_mode is not `simulated` (L5). */
	| "mode"
	/** No workspace Gate-1 request names this managed task (legacy / DB-seeded row). */
	| "ungoverned"
	/** The Gate-1 request is not `approved`. */
	| "not_approved"
	/** Not exactly one matching `approve` decision. */
	| "decision"
	/** The row was (re-)queued by something other than its Gate-1 decision. */
	| "requeued"
	/** The workspace task's current execution is another managed task, or its stage forbids work. */
	| "not_current"
	/** Managed task content / identity differs from the approved proposal. */
	| "content"
	/** A stored binding no longer recomputes from its rows. */
	| "binding"
	/** The repository left the allowlist. */
	| "repo"
	/** The execution binding no longer recomputes under the current frozen policy. */
	| "policy"
	/** The approved proposal is an obsolete v1 proposal (no criterion coverage; current policy). */
	| "obsolete"
	/** A read failed (integrity error, malformed row). */
	| "error";

export interface Authorized {
	ok: true;
	request: ApprovalRequestRow;
	decision: ManagedDecisionRow;
	task: WorkspaceTaskRow;
	proposal: ManagedProposalRow;
}

export interface Denied {
	ok: false;
	cls: DenialClass;
	reason: string;
}

const deny = (cls: DenialClass, reason: string): Denied => ({
	ok: false,
	cls,
	reason,
});

/** The managed_tasks columns approvalHashFor() covers (same shape as managedTaskFieldsFor). */
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

export interface EvaluateOptions {
	/**
	 * Apply the CURRENT policy (orchestrator: yes): recompute the execution binding under the current
	 * frozen policy and refuse an obsolete v1 proposal. The reconciler's structural check passes
	 * false: a policy change of queued work is the engine's `approval_void`, not a bridge violation.
	 */
	policy: boolean;
	/** Workspace stages that permit work (default AUTHORIZED_STAGES). */
	stages?: readonly WorkspaceStage[];
}

/**
 * Derive whether `task` (the managed row as the orchestrator just read it) is covered by its
 * workspace Gate-1 decision. Pure function of durable rows + the frozen config.
 */
export function evaluateAuthorization(
	reads: WorkspaceReadsExt,
	config: ManagedConfig,
	task: ManagedTask,
	o: EvaluateOptions,
): Authorized | Denied {
	try {
		if (task.execution_mode !== "simulated")
			return deny("mode", "only simulated execution is allowed in M1");
		const request = reads.findRunRequestForManagedTask(task.id);
		if (!request)
			return deny(
				"ungoverned",
				"no workspace Gate-1 request governs this execution",
			);
		if (request.kind !== "run" || request.managed_task_id !== task.id)
			return deny("binding", "the Gate-1 request names another execution");
		if (request.status !== "approved")
			return deny("not_approved", `the Gate-1 request is ${request.status}`);

		const decisions = reads
			.listDecisions(request.workspace_task_id)
			.filter((d) => d.approval_request_id === request.id);
		const decision = decisions[0];
		if (decisions.length !== 1 || !decision)
			return deny(
				"decision",
				"the Gate-1 request has no single recorded decision",
			);
		if (
			decision.kind !== "run" ||
			decision.action !== "approve" ||
			decision.managed_task_id !== task.id ||
			decision.workspace_task_id !== request.workspace_task_id ||
			!hashesEqual(decision.binding_hash, request.binding_hash)
		)
			return deny(
				"decision",
				"the recorded Gate-1 decision does not approve this execution",
			);
		// enqueueApproved writes run_requested_at = decided_at; any later re-queue changes it.
		if (
			task.run_requested_at === null ||
			task.run_requested_at !== decision.decided_at
		)
			return deny(
				"requeued",
				"the execution was queued by something other than its Gate-1 decision",
			);

		const ws = reads.getTask(request.workspace_task_id);
		if (!ws || ws.current_managed_task_id !== task.id)
			return deny(
				"not_current",
				"this is not the current execution of its workspace task",
			);
		const stages = o.stages ?? AUTHORIZED_STAGES;
		if (!stages.includes(ws.stage))
			return deny("not_current", `the workspace task is ${ws.stage}`);

		const proposal = reads.getProposal(request.proposal_id);
		if (
			!proposal ||
			proposal.workspace_task_id !== ws.id ||
			ws.current_proposal_id !== proposal.id ||
			!hashesEqual(proposal.proposal_hash, request.proposal_hash)
		)
			return deny(
				"binding",
				"the approved proposal is not the task's current version",
			);
		if (proposal.snapshot.execution_mode !== "simulated")
			return deny("mode", "only simulated execution is allowed in M1");
		if (
			task.idempotency_key !== request.id ||
			!hashesEqual(task.request_hash, request.execution_binding_hash) ||
			canonicalEncode(taskContent(task)) !==
				canonicalEncode(managedTaskFieldsFor(proposal.snapshot))
		)
			return deny(
				"content",
				"the managed task differs from the approved proposal",
			);

		const binding = request.execution_binding;
		if (
			binding.proposal_id !== proposal.id ||
			!hashesEqual(binding.proposal_hash, request.proposal_hash) ||
			binding.managed_task_id !== task.id ||
			binding.base_sha !== task.base_sha ||
			!hashesEqual(
				sealExecutionBinding(binding).hash,
				request.execution_binding_hash,
			) ||
			!hashesEqual(
				sealRunApprovalBinding({
					approval_request_id: request.id,
					workspace_task_id: request.workspace_task_id,
					proposal_id: request.proposal_id,
					proposal_hash: request.proposal_hash,
					execution_binding_hash: request.execution_binding_hash,
				}).hash,
				request.binding_hash,
			)
		)
			return deny("binding", "a stored Gate-1 binding no longer recomputes");

		if (!findRepo(config, task.repo_id))
			return deny("repo", "the repository is not in the managed allowlist");
		if (o.policy) {
			// current policy (v1.2 §A follow-up): a v1 grant is no longer executable
			if (isObsoleteExecutionProposal(proposal.snapshot))
				return deny("obsolete", OBSOLETE_V1_GRANT_DETAIL);
			const current = sealExecutionBinding({
				proposal_id: request.proposal_id,
				proposal_hash: request.proposal_hash,
				managed_task_id: task.id,
				base_sha: task.base_sha,
				policy_hash: policyHash(config, task.repo_id),
			}).hash;
			if (!hashesEqual(current, request.execution_binding_hash))
				return deny(
					"policy",
					"the managed policy changed after the Gate-1 approval",
				);
		}
		return { ok: true, request, decision, task: ws, proposal };
	} catch {
		return deny("error", "the workspace authorization check failed");
	}
}

/**
 * `OrchestratorDeps.authorize` for workspace mode: null = may proceed, else a fixed reason.
 * `flagged` = managed task ids the reconciler found in violation (fail closed until restart; the
 * restart sweep re-derives them from durable rows).
 */
export function createAuthorizer(deps: {
	reads: WorkspaceReadsExt;
	/** MUST be the same frozen config object the Orchestrator was constructed with. */
	config: ManagedConfig;
	flagged?: ReadonlySet<string>;
}): (task: ManagedTask) => string | null {
	return (task) => {
		try {
			if (deps.flagged?.has(task.id))
				return "a workspace violation was detected for this execution";
			const r = evaluateAuthorization(deps.reads, deps.config, task, {
				policy: true,
			});
			return r.ok ? null : r.reason;
		} catch {
			return "the workspace authorization check failed";
		}
	};
}
