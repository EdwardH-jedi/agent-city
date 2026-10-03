// Typed persistence errors. Messages carry table/constraint names and ids only — never row content,
// payloads or hashes of secrets.

/** Which uniqueness rule an insert hit (INTERFACE.md §4). */
export type WorkspaceConstraint =
	| "primary_key"
	| "workspace_task_idempotency" // workspace_tasks UNIQUE(created_by, idempotency_key)
	| "workspace_task_managed_task" // workspace_tasks UNIQUE(current_managed_task_id)
	| "proposal_version" // managed_proposals UNIQUE(workspace_task_id, version)
	| "proposal_hash" // managed_proposals UNIQUE(proposal_hash)
	| "binding_hash" // managed_approval_requests UNIQUE(binding_hash)
	| "run_request_per_managed_task" // UNIQUE(managed_task_id) WHERE kind = 'run'
	| "result_request_per_run" // UNIQUE(run_id) WHERE kind = 'result'
	| "one_pending_request" // UNIQUE(workspace_task_id, kind) WHERE status = 'pending'
	| "decision_idempotency" // managed_decisions UNIQUE(operator_id, idempotency_key)
	| "decision_per_request" // managed_decisions UNIQUE(approval_request_id)
	| "acceptance_validity_per_request"; // managed_acceptance_validity UNIQUE(result_request_id) (009)

/** An insert collided with a UNIQUE rule. Nothing was written (the earlier row is untouched). */
export class WorkspaceConflictError extends Error {
	constructor(
		readonly table: string,
		readonly constraint: WorkspaceConstraint,
	) {
		super(`${table}: unique conflict (${constraint})`);
		this.name = "WorkspaceConflictError";
	}
}

/** A row about to be written does not satisfy its rows.ts contract / hash binding. Nothing written. */
export class WorkspaceRowError extends Error {
	constructor(
		readonly table: string,
		readonly issues: readonly string[],
	) {
		super(`${table}: invalid row — ${issues.slice(0, 5).join("; ")}`);
		this.name = "WorkspaceRowError";
	}
}

/**
 * A stored row failed verification on read: its canonical column no longer hashes to its stored
 * hash, or it no longer parses as its rows.ts DTO. Fail closed (callers answer integrity_failed).
 */
export class WorkspaceIntegrityError extends Error {
	constructor(
		readonly table: string,
		readonly id: string,
		readonly problem: string,
	) {
		super(`${table} ${id}: stored row failed verification (${problem})`);
		this.name = "WorkspaceIntegrityError";
	}
}

/** Transaction misuse: nested/async callback, or a WorkspaceTx used after its callback returned. */
export class WorkspaceTxError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkspaceTxError";
	}
}
