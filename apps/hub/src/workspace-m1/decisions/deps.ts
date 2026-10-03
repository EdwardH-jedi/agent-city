// Dependencies of the workspace decision / command / read services (role 04). Every port is the
// frozen v1 contract type (ports.ts) or an accepted module (02 store, 03 challenges, 06 sealer).
import type {
	ApprovalKind,
	ChallengePort,
	EvidenceSealer,
	ExecutionBridge,
} from "@agent-city/schema/workspace-m1";
import type { ManagedConfig, RepoConfig } from "../../managed/config.ts";
import type { PersistentWorkspaceStore } from "../persistence/index.ts";

/** Points inside the decision transaction where a test hook may throw (→ full rollback). */
export type DecisionTxPoint =
	| "after_consume"
	| "after_insert_decision"
	| "after_close_request"
	| "after_effects";

/** Deterministic test boundaries. Never set in production. */
export interface DecisionHooks {
	/** Awaited right before the decision's BEGIN IMMEDIATE (after any Gate-2 revalidation). */
	beforeTransaction?(
		kind: ApprovalKind,
		approval_request_id: string,
	): Promise<void> | void;
	/** Called synchronously inside the decision transaction; a throw rolls everything back. */
	inDecisionTx?(point: DecisionTxPoint, approval_request_id: string): void;
}

export interface WorkspaceServiceDeps {
	/** 02 store on the hub's single Database handle. */
	store: PersistentWorkspaceStore;
	/** The orchestrator's frozen managed config snapshot (allowlist, base refs, checks, policy). */
	config: ManagedConfig;
	/** 05 ExecutionBridge (default: createManagedBridge over 02's managed writes, same handle). */
	bridge: ExecutionBridge;
	/** 03 ChallengePort (`auth.challenges`). */
	challenges: ChallengePort;
	/** 06 sealer (Gate-2 revalidation). Needs `reads` = the workspace store. */
	sealer: EvidenceSealer;
	/**
	 * Resolve the trusted base ref of an allowlisted repo to a commit (async git, never inside a
	 * transaction). Default: validateRepo + resolveCommit, exactly as managed submitTask does.
	 */
	resolveBase?: (repo: RepoConfig) => Promise<string>;
	hooks?: DecisionHooks;
	/**
	 * Authoritative clock — the SAME clock as `createWorkspaceAuth({ clock })`. Read afresh INSIDE the
	 * decision / challenge transaction (after the write lock is held), never taken from the request's
	 * start: session liveness, challenge expiry, `decided_at` and the queue stamp all use that read.
	 * Default: the system clock.
	 */
	clock?: { now(): Date };
}
