// Public surface of the workspace persistence module (role 02). testkit.ts, crash-child.ts and
// concurrency-worker.ts are test-only and deliberately not exported.
export {
	WorkspaceConflictError,
	type WorkspaceConstraint,
	WorkspaceIntegrityError,
	WorkspaceRowError,
	WorkspaceTxError,
} from "./errors.ts";
export {
	currentPolicyHash,
	enqueueApprovedTask,
	type ManagedWriteDeps,
	ManagedWriteError,
	type ManagedWriteErrorCode,
	type ManagedWriteHooks,
	releaseReservedTask,
	reserveManagedTask,
} from "./managed-writes.ts";
export {
	EVIDENCE_VALIDITY_MIGRATION_FILE,
	ensureWorkspaceSchema,
	PROPOSAL_V1_2_MIGRATION_FILE,
	WORKSPACE_MIGRATION_FILE,
	WORKSPACE_SCHEMA_VERSION,
} from "./migration.ts";
export {
	type AcceptanceValidityPatch,
	type ApprovalRequestFilter,
	createWorkspaceStore,
	type EvidenceValidityReads,
	type EvidenceValidityTx,
	openTxOn,
	type PersistentWorkspaceStore,
	type PersistentWorkspaceTx,
	type WorkspaceReadsExt,
} from "./store.ts";
