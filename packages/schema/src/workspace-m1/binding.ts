// Execution binding and approval bindings (web-safe). Hash graph (no structure contains its own
// hash; receipts are never hashed into their subjects):
//
//   proposal_hash          = H(ProposalSnapshot)
//   execution_binding_hash = H(ExecutionBinding{…, proposal_hash, managed_task_id, base_sha, policy_hash})
//   run binding_hash       = H(RunApprovalBinding{…, proposal_hash, execution_binding_hash})
//   review_hash            = H(ReviewRecord)
//   result_envelope_hash   = H(ResultEnvelope{…, proposal_hash, execution_binding_hash, run_decision_id, review_hash, …})
//   result binding_hash    = H(ResultApprovalBinding{…, result_envelope_hash})
//   payload_hash           = H(DecisionPayload{…, binding_hash})          (challenge excluded)
//   challenge_hash         = H(ChallengeBinding{token, …, binding_hash})  (stored on the request row)
import { z } from "zod";
import {
	ApprovalRequestId,
	ManagedTaskId,
	ProposalId,
	RunId,
	WorkspaceTaskId,
} from "./ids.ts";
import { Hash, Sha } from "./primitives.ts";
import { APPROVAL_CONTRACT, EXECUTION_BINDING_CONTRACT } from "./proposal.ts";

export const ApprovalKind = z.enum(["run", "result"]);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

/**
 * What one reserved managed task will execute under: this exact proposal, on this base, under this
 * trusted policy. `policy_hash` is opaque here — the hub supplies `policyHash(config, repo_id)`.
 */
export const ExecutionBinding = z.strictObject({
	contract: z.literal(EXECUTION_BINDING_CONTRACT),
	proposal_id: ProposalId,
	proposal_hash: Hash,
	managed_task_id: ManagedTaskId,
	base_sha: Sha,
	policy_hash: Hash,
});
export type ExecutionBinding = z.infer<typeof ExecutionBinding>;

/** Gate 1 subject. */
export const RunApprovalBinding = z.strictObject({
	contract: z.literal(APPROVAL_CONTRACT),
	kind: z.literal("run"),
	approval_request_id: ApprovalRequestId,
	workspace_task_id: WorkspaceTaskId,
	proposal_id: ProposalId,
	proposal_hash: Hash,
	execution_binding_hash: Hash,
});
export type RunApprovalBinding = z.infer<typeof RunApprovalBinding>;

/** Gate 2 subject. */
export const ResultApprovalBinding = z.strictObject({
	contract: z.literal(APPROVAL_CONTRACT),
	kind: z.literal("result"),
	approval_request_id: ApprovalRequestId,
	workspace_task_id: WorkspaceTaskId,
	managed_task_id: ManagedTaskId,
	run_id: RunId,
	result_envelope_hash: Hash,
});
export type ResultApprovalBinding = z.infer<typeof ResultApprovalBinding>;

export const ApprovalBinding = z.discriminatedUnion("kind", [
	RunApprovalBinding,
	ResultApprovalBinding,
]);
export type ApprovalBinding = z.infer<typeof ApprovalBinding>;
