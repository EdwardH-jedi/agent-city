// Workspace HTTP API — contract delta v1.1 (lead, additive). The route table and the response
// wrappers that the web transport, the hub routes and both QA suites share. Nothing here is hashed;
// the frozen v1 structures and vectors are unchanged. Web-safe: zod + pure TS only.
import { z } from "zod";
import {
	ArtifactKind,
	FailureKind,
	RunKind,
	RunPhase,
	RunState,
} from "../managed.ts";
import { ArtifactId, RunId } from "./ids.ts";
import { Hash, RepoId, Sha, UtcTs } from "./primitives.ts";
import { EvidenceStatus } from "./result.ts";
import {
	AcceptanceValidityView,
	ApprovalRequestView,
	WorkspaceTaskSummary,
	WorkspaceTaskView,
} from "./rows.ts";
import { WorkspacePhase } from "./state.ts";

export const WORKSPACE_API_CONTRACT = "agentcity.workspace-api/v1.1";
export const WORKSPACE_API_BASE = "/api/workspace";

/**
 * Every route, relative to WORKSPACE_API_BASE. All need a valid operator session except
 * `POST /session` (sign-in). Mutations also need the exact Origin and the CSRF header.
 *
 *   GET    /session                         → SessionView                       (workspace:read)
 *   POST   /session          SignInRequest  → SessionView + Set-Cookie           (no session)
 *   DELETE /session                         → 204                                (workspace:read)
 *   GET    /snapshot                        → WorkspaceSnapshot                  (workspace:read)
 *   POST   /tasks            CreateWorkspaceTaskRequest → WorkspaceTaskView, 201 | 200 replay
 *   GET    /tasks/:id                       → WorkspaceTaskDetail               (workspace:read)
 *   PUT    /tasks/:id/draft  SaveDraftRequest        → WorkspaceTaskView
 *   POST   /tasks/:id/proposals PublishProposalRequest → WorkspaceTaskView, 201 (opens Gate 1)
 *   POST   /tasks/:id/rerun  RequestRerunRequest     → WorkspaceTaskView, 201 (new execution + Gate 1)
 *   POST   /tasks/:id/cancel CancelRequest           → WorkspaceTaskView
 *   GET    /tasks/:id/artifacts/:artifact_id → ArtifactTextResponse            (workspace:read)
 *   POST   /approval-requests/:id/challenge ChallengeIssueRequest → ChallengeIssueResponse
 *   POST   /approval-requests/:id/decisions DecisionRequest      → DecisionResponse
 *
 * Errors: WorkspaceErrorBody with WORKSPACE_ERROR_STATUS. Responses carry `cache-control: no-store`.
 */
export const WORKSPACE_ROUTES = {
	session: "/session",
	snapshot: "/snapshot",
	tasks: "/tasks",
	task: "/tasks/:id",
	draft: "/tasks/:id/draft",
	proposals: "/tasks/:id/proposals",
	rerun: "/tasks/:id/rerun",
	cancel: "/tasks/:id/cancel",
	artifact: "/tasks/:id/artifacts/:artifact_id",
	challenge: "/approval-requests/:id/challenge",
	decisions: "/approval-requests/:id/decisions",
} as const;

/** Exchange of the ephemeral test-operator credential for a session cookie. Never in a URL. */
export const SignInRequest = z.strictObject({
	credential: z.string().min(16).max(512),
});
export type SignInRequest = z.infer<typeof SignInRequest>;

/** Three independent provenance labels (SOL §D). M1 hub data is always simulated, never live-verified. */
export const Provenance = z.strictObject({
	data_source: z.enum(["hub", "fixture"]),
	execution_mode: z.literal("simulated"),
	live_integration_verified: z.literal(false),
});
export type Provenance = z.infer<typeof Provenance>;

/** A repository the workspace may assign work to (the managed allowlist; one fixture repo in M1). */
export const WorkspaceRepo = z.strictObject({
	repo_id: RepoId,
	base_ref: z.string().min(1).max(200),
	/** Names of the trusted verification checks the engine will run (config order). */
	required_checks: z.array(z.string().min(1).max(100)).max(20),
});
export type WorkspaceRepo = z.infer<typeof WorkspaceRepo>;

export const WorkspaceTaskListItem = z.strictObject({
	task: WorkspaceTaskSummary,
	phase: WorkspacePhase,
	/** v1.2: stored current validity of the accepted result (CONTRACT_V1_2.md §C). */
	acceptance_validity: AcceptanceValidityView.nullable(),
});
export type WorkspaceTaskListItem = z.infer<typeof WorkspaceTaskListItem>;

export const WorkspaceSnapshot = z.strictObject({
	provenance: Provenance,
	repos: z.array(WorkspaceRepo).max(50),
	tasks: z.array(WorkspaceTaskListItem).max(500),
	/** Every approval request with status `pending` (the HQ inbox), oldest first. */
	pending_requests: z.array(ApprovalRequestView).max(500),
	generated_at: UtcTs,
});
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshot>;

/** One attempt of the task's managed executions. Never carries host paths, pids or provider output. */
export const RunSummary = z.strictObject({
	run_id: RunId,
	managed_task_id: z.string().min(1).max(64),
	attempt_no: z.number().int().positive(),
	kind: RunKind,
	state: RunState,
	phase: RunPhase,
	outcome: z.enum(["approved", "rejected"]).nullable(),
	candidate_sha: Sha.nullable(),
	manifest_hash: Hash.nullable(),
	failure_kind: FailureKind.nullable(),
	started_at: UtcTs,
	ended_at: UtcTs.nullable(),
});
export type RunSummary = z.infer<typeof RunSummary>;

export const ArtifactListItem = z.strictObject({
	artifact_id: ArtifactId,
	run_id: RunId,
	name: z.string().min(1).max(200),
	kind: ArtifactKind,
	byte_len: z.number().int().nonnegative(),
	truncated: z.boolean(),
	created_at: UtcTs,
});
export type ArtifactListItem = z.infer<typeof ArtifactListItem>;

export const WorkspaceTaskDetail = z.strictObject({
	...WorkspaceTaskView.shape,
	runs: z.array(RunSummary).max(50),
	artifacts: z.array(ArtifactListItem).max(500),
});
export type WorkspaceTaskDetail = z.infer<typeof WorkspaceTaskDetail>;

/**
 * Artifact content for display as inert text. `text` is null unless `status` is `verified` or
 * `truncated` — the server never returns content it could not verify or could not safely disclose.
 * `withheld_reasons` are fixed reason codes only, never content.
 */
export const ArtifactTextResponse = z.strictObject({
	artifact_id: ArtifactId,
	run_id: RunId,
	name: z.string().min(1).max(200),
	kind: ArtifactKind,
	status: EvidenceStatus,
	text: z.string().nullable(),
	truncated: z.boolean(),
	withheld_reasons: z.array(z.string().regex(/^[a-z0-9_]{1,64}$/)).max(50),
});
export type ArtifactTextResponse = z.infer<typeof ArtifactTextResponse>;
