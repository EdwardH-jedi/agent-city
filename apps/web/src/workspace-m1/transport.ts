// Workspace transport contract (role 07). One method per route of WORKSPACE_ROUTES (contract
// v1.1, packages/schema/src/workspace-m1/api.ts), typed with the frozen DTOs. Two
// implementations: `fetch-transport.ts` (the real hub, cookie session + CSRF header) and
// `fixture-transport.ts` (deterministic in-memory UI fixture). The UI never knows which one it
// talks to except through `source` (rendered as provenance, never as authority).
import type {
	ArtifactTextResponse,
	CancelRequest,
	ChallengeIssueRequest,
	ChallengeIssueResponse,
	CreateWorkspaceTaskRequest,
	DecisionResponse,
	PublishProposalRequest,
	RequestRerunRequest,
	SaveDraftRequest,
	SessionView,
	SignInRequest,
	WorkspaceErrorBody,
	WorkspaceErrorCode,
	WorkspaceSnapshot,
	WorkspaceTaskDetail,
	WorkspaceTaskView,
} from "@agent-city/schema/workspace-m1";

/**
 * Outcome of one call.
 * - `http`: the server answered with a contract error body (WorkspaceErrorBody whose code matches
 *   the HTTP status). By the frozen order (INTERFACE.md §7) such an answer had NO effect.
 * - `network`: no response at all (offline, reset, timeout, aborted). For a mutation the outcome is
 *   UNKNOWN — it may or may not have been committed.
 * - `invalid_response`: a response arrived but did not parse with the contract schema (including
 *   any 5xx without a contract body). For a mutation the outcome is also UNKNOWN.
 */
export type TransportFailure =
	| { ok: false; kind: "http"; status: number; error: WorkspaceErrorBody }
	| { ok: false; kind: "network"; message: string }
	| { ok: false; kind: "invalid_response"; status: number; message: string };

export type TransportResult<T> =
	| { ok: true; status: number; data: T }
	| TransportFailure;

export interface WorkspaceTransport {
	/** Where the data comes from: rendered as provenance (`UI fixture` / `Hub record`). */
	readonly source: "hub" | "fixture";
	/** GET /session */
	getSession(): Promise<TransportResult<SessionView>>;
	/** POST /session (the credential is sent once in the body, never in a URL). */
	signIn(body: SignInRequest): Promise<TransportResult<SessionView>>;
	/** DELETE /session */
	signOut(): Promise<TransportResult<null>>;
	/** GET /snapshot */
	getSnapshot(): Promise<TransportResult<WorkspaceSnapshot>>;
	/** POST /tasks (key-idempotent: 201 created | 200 replay) */
	createTask(
		body: CreateWorkspaceTaskRequest,
	): Promise<TransportResult<WorkspaceTaskView>>;
	/** GET /tasks/:id */
	getTask(taskId: string): Promise<TransportResult<WorkspaceTaskDetail>>;
	/** PUT /tasks/:id/draft (CAS on rev) */
	saveDraft(
		taskId: string,
		body: SaveDraftRequest,
	): Promise<TransportResult<WorkspaceTaskView>>;
	/** POST /tasks/:id/proposals (CAS on rev; opens Gate 1) */
	publishProposal(
		taskId: string,
		body: PublishProposalRequest,
	): Promise<TransportResult<WorkspaceTaskView>>;
	/** POST /tasks/:id/rerun (CAS on rev; new execution + new Gate 1) */
	requestRerun(
		taskId: string,
		body: RequestRerunRequest,
	): Promise<TransportResult<WorkspaceTaskView>>;
	/** POST /tasks/:id/cancel (CAS on rev) */
	cancel(
		taskId: string,
		body: CancelRequest,
	): Promise<TransportResult<WorkspaceTaskView>>;
	/** GET /tasks/:id/artifacts/:artifact_id */
	getArtifact(
		taskId: string,
		artifactId: string,
	): Promise<TransportResult<ArtifactTextResponse>>;
	/** POST /approval-requests/:id/challenge (bumps the request rev) */
	issueChallenge(
		requestId: string,
		body: ChallengeIssueRequest,
	): Promise<TransportResult<ChallengeIssueResponse>>;
	/**
	 * POST /approval-requests/:id/decisions. Takes the SERIALIZED DecisionRequest so a retry after
	 * an unknown outcome resends exactly the same bytes (same key, rev, challenge).
	 */
	decide(
		requestId: string,
		serializedBody: string,
	): Promise<TransportResult<DecisionResponse>>;
}

/** A mutation whose outcome cannot be known from this answer (it may have been committed). */
export const isOutcomeUnknown = (r: TransportResult<unknown>): boolean =>
	!r.ok && r.kind !== "http";

export const errorCode = (
	r: TransportResult<unknown>,
): WorkspaceErrorCode | null =>
	!r.ok && r.kind === "http" ? r.error.error : null;

export const isUnauthenticated = (r: TransportResult<unknown>): boolean =>
	errorCode(r) === "unauthenticated";
