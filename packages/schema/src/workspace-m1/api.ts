// Workspace HTTP API — contract delta v1.1 (lead, additive), extended by the additive API delta v1.2
// (multi-repository milestone: per-task engine/latest-request summaries, the global execution queue and
// observed-only repositories in the snapshot; docs/workspace-m1/MULTIREPO_MILESTONE.md). The route table
// and the response wrappers that the web transport, the hub routes and the QA suites share. Nothing here
// is hashed; the frozen v1 structures and vectors are unchanged. Web-safe: zod + pure TS only.
import { z } from "zod";
import {
	ArtifactKind,
	FailureKind,
	RunKind,
	RunPhase,
	RunState,
	TaskState,
} from "../managed.ts";
import { ApprovalKind } from "./binding.ts";
import {
	ApprovalRequestId,
	ArtifactId,
	ManagedTaskId,
	RunId,
	WorkspaceTaskId,
} from "./ids.ts";
import { Hash, RepoId, Sha, UtcTs } from "./primitives.ts";
import { EvidenceStatus } from "./result.ts";
import {
	AcceptanceValidityView,
	ApprovalRequestView,
	EngineView,
	WorkspaceTaskSummary,
	WorkspaceTaskView,
} from "./rows.ts";
import { ApprovalStatus, InvalidationReason, WorkspacePhase } from "./state.ts";

/** v1.2 = API delta for multiple repositories (not the proposal/result contract v1.2). */
export const WORKSPACE_API_CONTRACT = "agentcity.workspace-api/v1.2";
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
	history: "/task-history",
	inbox: "/inbox",
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

/** A repository the workspace may assign work to (the managed allowlist — the only execution-eligible repositories). */
export const WorkspaceRepo = z.strictObject({
	repo_id: RepoId,
	base_ref: z.string().min(1).max(200),
	/** Names of the trusted verification checks the engine will run (config order). */
	required_checks: z.array(z.string().min(1).max(100)).max(20),
});
export type WorkspaceRepo = z.infer<typeof WorkspaceRepo>;

/**
 * API v1.2: a repository the hub has only OBSERVED (telemetry / GitHub metadata / a local checkout scan) and
 * that is NOT on the managed allowlist. Read-only: it can never be assigned work, approved or executed —
 * `POST /tasks` answers 422 `repo_not_allowed` for it like for any other id outside the allowlist.
 */
export const ObservedRepo = z.strictObject({
	repo_id: RepoId,
	/** Where the hub learned of it: GitHub sync, a local checkout without a GitHub origin, or session telemetry only. */
	source: z.enum(["github", "local_checkout", "telemetry"]),
});
export type ObservedRepo = z.infer<typeof ObservedRepo>;

/** API v1.2: the newest approval request of a task (any status) — enough for list-level labels. */
export const RequestSummary = z.strictObject({
	id: ApprovalRequestId,
	kind: ApprovalKind,
	status: ApprovalStatus,
	invalidation_reason: InvalidationReason.nullable(),
	created_at: UtcTs,
	/** When the request was decided or invalidated (null while pending). */
	closed_at: UtcTs.nullable(),
});
export type RequestSummary = z.infer<typeof RequestSummary>;

export const WorkspaceTaskListItem = z.strictObject({
	task: WorkspaceTaskSummary,
	phase: WorkspacePhase,
	/** v1.2: stored current validity of the accepted result (CONTRACT_V1_2.md §C). */
	acceptance_validity: AcceptanceValidityView.nullable(),
	/** API v1.2: the task's current execution as the engine records it (same value as the task detail's). */
	engine: EngineView.nullable(),
	/** API v1.2: the task's newest approval request, any status (null before the first publish). */
	latest_request: RequestSummary.nullable(),
});
export type WorkspaceTaskListItem = z.infer<typeof WorkspaceTaskListItem>;

/** API v1.2: one execution in the engine's single global slot or waiting for it. */
export const QueueEntry = z.strictObject({
	managed_task_id: ManagedTaskId,
	/** null: an engine row not linked to any workspace task (legacy / pre-workspace data). */
	workspace_task_id: WorkspaceTaskId.nullable(),
	repo_id: RepoId,
	state: TaskState,
	run_requested_at: UtcTs.nullable(),
});
export type QueueEntry = z.infer<typeof QueueEntry>;

/**
 * API v1.2: the engine runs ONE managed execution at a time across every repository. `active` holds the slot
 * (leased, or an active execution that resumes first); `queued` lists the executions that will be claimed
 * next, in claim order (the same selection the engine uses). While an unconfirmed process is quarantined the
 * engine claims nothing, in any repository.
 */
export const ExecutionQueue = z.strictObject({
	active: QueueEntry.nullable(),
	queued: z.array(QueueEntry).max(500),
	claims_paused_by_quarantine: z.boolean(),
	/** Complete execution count (not unique workspace-task count), including the active slot. */
	total_executions: z.number().int().nonnegative().optional(),
	queued_complete: z.boolean().optional(),
});
export type ExecutionQueue = z.infer<typeof ExecutionQueue>;

/**
 * API v1.2 corrective addition (P2 F-01, docs/workspace-m1/CORRECTIVE_P2_2026-10-04.md): complete totals of
 * one allowlisted repository, counted over EVERY recorded task — not limited by the snapshot's bounded
 * `tasks` window — so a client can tell a repository with no tasks from one whose tasks are not in the window.
 */
export const RepoTaskCount = z.strictObject({
	repo_id: RepoId,
	/** Every workspace task recorded for this repository. */
	tasks: z.number().int().nonnegative(),
});
export type RepoTaskCount = z.infer<typeof RepoTaskCount>;

const Count = z.number().int().nonnegative();
export const RepositoryCategories = z.strictObject({
	running: Count,
	queued: Count,
	cancelRequested: Count,
	needsApproval: Count,
	needsAcceptance: Count,
	attention: Count,
	cancelled: Count,
	accepted: Count,
	rejected: Count,
	drafts: Count,
});
export type RepositoryCategories = z.infer<typeof RepositoryCategories>;
export const RepoSummary = z.strictObject({
	repo_id: RepoId,
	tasks: Count,
	complete: z.literal(true),
	as_of: UtcTs,
	phases: z.record(WorkspacePhase, Count),
	categories: RepositoryCategories,
	active_tasks: Count,
	pending_requests: Count,
	acceptance: z.strictObject({
		valid: Count,
		invalid: Count,
		unknown: Count,
		unverifiable: Count,
		oldest_checked_at: UtcTs.nullable(),
		latest_checked_at: UtcTs.nullable(),
	}),
});
export type RepoSummary = z.infer<typeof RepoSummary>;
/**
 * Page size of the snapshot's first inbox page (`pending_requests` / `pending_page`). Its continuation cursor is
 * bound to this size, so a client continuing it uses the same limit (review repair APP-P2-02).
 */
export const SNAPSHOT_INBOX_LIMIT = 500;
export const PageMeta = z.strictObject({
	total: Count,
	returned: Count,
	complete: z.boolean(),
	has_more: z.boolean(),
	next_cursor: z.string().max(2048).nullable(),
	as_of: UtcTs,
});
export type PageMeta = z.infer<typeof PageMeta>;
/**
 * T0-FINAL-P2-01 (REPAIR_READ_CONTRACT_2026-10-05.md, "Inbox membership generation"): the hub's generation
 * of the pending membership of exactly one inbox scope (its repositories and gate), read with the page. Equal
 * values name the same pending set; any request opening or closing in the scope changes it, also when the total
 * stays equal. Opaque: compare for equality only; it grants nothing. Absent (a source that does not compute
 * it) = unknown.
 */
export const InboxMembershipGeneration = z
	.string()
	.regex(/^v1:[0-9a-f]{16}:\d{1,15}:\d{1,15}$/);
export const InboxPageMeta = z.strictObject({
	...PageMeta.shape,
	membership_generation: InboxMembershipGeneration.optional(),
});
export type InboxPageMeta = z.infer<typeof InboxPageMeta>;
export const TaskHistoryPage = z.strictObject({
	repo_id: RepoId,
	filter: z.enum(["all", "attention"]),
	items: z.array(WorkspaceTaskListItem).max(100),
	page: PageMeta,
});
export type TaskHistoryPage = z.infer<typeof TaskHistoryPage>;
export const PendingInboxPage = z.strictObject({
	repo_id: RepoId.nullable(),
	kind: z.enum(["run", "result"]).nullable(),
	items: z.array(ApprovalRequestView).max(500),
	page: InboxPageMeta,
});
export type PendingInboxPage = z.infer<typeof PendingInboxPage>;

export const WorkspaceSnapshot = z.strictObject({
	provenance: Provenance,
	repos: z.array(WorkspaceRepo).max(50),
	/** API v1.2: observed-only repositories (never execution-eligible), sorted by id. */
	observed_repos: z.array(ObservedRepo).max(200),
	/**
	 * A bounded window, newest update first: every task named by `pending_requests` or `execution_queue`
	 * (in that priority), then the most recently updated tasks, at most 500 in all. Absence from this list
	 * never means a task does not exist — `repo_task_counts` holds the complete totals.
	 */
	tasks: z.array(WorkspaceTaskListItem).max(500),
	/** API v1.2 corrective (P2 F-01): complete per-repository totals, one entry per allowlisted repository. */
	repo_task_counts: z.array(RepoTaskCount).max(50),
	/** Complete stored facts, independent of the bounded display window. Missing = unknown. */
	repo_summaries: z.array(RepoSummary).max(50).optional(),
	/** Bounded oldest pending requests; `pending_page` describes truncation and continuation. */
	pending_requests: z.array(ApprovalRequestView).max(500),
	pending_page: InboxPageMeta.optional(),
	/** API v1.2: the global execution queue (one active execution across all repositories). */
	execution_queue: ExecutionQueue,
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
