// Workspace command service (role 04): create task, save draft, publish proposal, rerun, cancel.
//
// Create is key-idempotent (UNIQUE(created_by, idempotency_key), same key + same request_hash →
// the existing task, 200; different → 409). Every other command is CAS on the task's `rev` (OQ-6:
// at most once; a lost response is resolved by re-reading). Live precedence runs before strict
// parsing on every body (422 live_disabled). Async git (base resolution) happens BEFORE any
// transaction; each command is then one `BEGIN IMMEDIATE` following 02's write order:
//
//   publish  (v1.2, CONTRACT_V1_2.md §A: criterion ids + the trusted criterion → check coverage plan,
//            fail closed — 400 invalid_request + issues on an unmapped criterion, a dangling key, an
//            untrusted check or a duplicate criterion / id) insertProposal v(N+1) → supersede the
//            pending run request (invalidated
//            proposal_superseded) + release its reserved managed task → reserve a new managed task
//            (draft) → insert the run request (pending) → task pointers + stage
//   rerun    reserve a new managed task for the SAME current proposal → run request → pointers
//            (a legacy v1 proposal is refused: its result could never be accepted — publish a v1.2)
//   cancel   awaiting_run_approval: request withdrawn + reservation released → cancelled
//            queued: requestCancel → cancelled (not leased) | cancel_requested (leased)
//            running: requestCancel (intent only) → cancel_requested
//            awaiting_acceptance: 409 invalid_state (R-A1 / OQ-8 — nothing is running; use Reject)
//
// Nothing here queues work: a reserved managed task stays `draft` until a Gate-1 approve.

import {
	type AnyProposalSnapshot,
	type ApprovalRequestRow,
	CANCELLABLE_STAGES,
	CancelRequest,
	type CommandOutcome,
	CreateWorkspaceTaskRequest,
	isProposalV1_2,
	isTerminalWorkspaceStage,
	PROPOSAL_CONTRACT_V1_2,
	ProposalDraft,
	PUBLISHABLE_STAGES,
	PublishProposalRequest,
	RERUNNABLE_STAGES,
	RequestRerunRequest,
	redactDraft,
	requestsNonSimulatedMode,
	SaveDraftRequest,
	type VerifiedAuthContext,
	WORKSPACE_TASK_CONTRACT,
	WorkspaceDraft,
	WorkspaceTaskId,
	type WorkspaceTaskRow,
	type WorkspaceTaskView,
} from "@agent-city/schema/workspace-m1";
import {
	buildProposalSnapshotV1_2,
	canonicalEncode,
	createTaskRequestHash,
	hashesEqual,
	newWorkspaceId,
	sealProposal,
	sealRunApprovalBinding,
} from "@agent-city/schema/workspace-m1/hash";
import { findRepo, type RepoConfig } from "../../managed/config.ts";
import { GitError, resolveCommit, validateRepo } from "../../managed/git.ts";
import { gitCtx } from "../../managed/service.ts";
import { openQuarantineFor } from "../../managed/store.ts";
import type { PersistentWorkspaceTx } from "../persistence/index.ts";
import { hasDecideScope } from "./decision-service.ts";
import type { WorkspaceServiceDeps } from "./deps.ts";
import {
	fail,
	issuesOf,
	mapKnownError,
	ok,
	ResponseContractError,
} from "./outcome.ts";
import type { WorkspaceReadModel } from "./read-model.ts";

type View = CommandOutcome<WorkspaceTaskView>;

const NO_CHALLENGE = {
	challenge_status: "none",
	challenge_hash: null,
	challenge_operator_id: null,
	challenge_session_generation: null,
	challenge_boot_id: null,
	challenge_request_rev: null,
	challenge_issued_at: null,
	challenge_expires_at: null,
} as const;

export interface WorkspaceCommands {
	createTask(auth: VerifiedAuthContext, body: unknown, now: Date): View;
	saveDraft(
		auth: VerifiedAuthContext,
		task_id: string,
		body: unknown,
		now: Date,
	): View;
	publishProposal(
		auth: VerifiedAuthContext,
		task_id: string,
		body: unknown,
		now: Date,
	): Promise<View>;
	requestRerun(
		auth: VerifiedAuthContext,
		task_id: string,
		body: unknown,
		now: Date,
	): View;
	cancel(
		auth: VerifiedAuthContext,
		task_id: string,
		body: unknown,
		now: Date,
	): View;
}

/**
 * The stored form of a draft (CLAUDE.md rule 3; F-01): every user-authored text field passes the
 * shared `redact()` BEFORE it is stored or served — title, objective, each criterion. Scope paths are
 * pattern-restricted and kept; whitespace is kept (drafts are working copies; publish trims). Redaction
 * can lengthen text, so the result is re-validated and fails with issues — never truncated. `redact`
 * is idempotent on inputs ≤ INPUT_MAX (every draft field is shorter), so publishing the stored draft
 * freezes exactly the text the operator was shown.
 */
export function storedDraft(
	d: WorkspaceDraft,
):
	| { ok: true; draft: WorkspaceDraft }
	| { ok: false; issues: ReturnType<typeof issuesOf> } {
	// every user-authored string, incl. the v1.2 criterion→check mapping keys (redacted exactly like
	// the criteria so keys still match), is redacted before storage (CLAUDE.md rule 3)
	const parsed = WorkspaceDraft.safeParse(redactDraft(d));
	return parsed.success
		? { ok: true, draft: parsed.data }
		: { ok: false, issues: issuesOf(parsed.error) };
}

/** Default base resolution: exactly managed submitTask's (validateRepo + resolveCommit). */
export function defaultResolveBase(config: WorkspaceServiceDeps["config"]) {
	return async (repo: RepoConfig): Promise<string> => {
		const git = gitCtx(config);
		const path = await validateRepo(git, repo.path, [
			config.workspace_root,
			config.artifacts_root,
		]);
		return resolveCommit(git, path, repo.base_ref);
	};
}

export function createWorkspaceCommands(
	deps: WorkspaceServiceDeps,
	reads: WorkspaceReadModel,
): WorkspaceCommands {
	const { store, bridge, config } = deps;
	const resolveBase = deps.resolveBase ?? defaultResolveBase(config);

	/** The committed task's view (read after the transaction; validated). */
	const respond = (status: number, id: string): View => {
		const view = reads.taskView(id);
		if (!view) throw new ResponseContractError("task vanished");
		return ok(status, view);
	};

	/** Common front of every command: scope, live precedence, strict parse, id form. */
	function front<T>(
		auth: VerifiedAuthContext,
		body: unknown,
		schema: {
			safeParse(
				v: unknown,
			):
				| { success: true; data: T }
				| { success: false; error: import("zod").ZodError };
		},
		task_id?: string,
	): { ok: true; data: T } | { ok: false; out: ReturnType<typeof fail> } {
		if (task_id !== undefined && !WorkspaceTaskId.safeParse(task_id).success)
			return { ok: false, out: fail("not_found") };
		if (!hasDecideScope(auth))
			return { ok: false, out: fail("forbidden_scope") };
		if (requestsNonSimulatedMode(body))
			return { ok: false, out: fail("live_disabled") };
		const parsed = schema.safeParse(body);
		if (!parsed.success)
			return {
				ok: false,
				out: fail("invalid_request", issuesOf(parsed.error)),
			};
		return { ok: true, data: parsed.data };
	}

	const guarded = <T>(fn: () => T): T | ReturnType<typeof fail> => {
		try {
			return fn();
		} catch (err) {
			const known = mapKnownError(err);
			if (known) return known;
			throw err;
		}
	};

	/** Insert one run request (Gate 1) for a reserved execution of `proposal`. */
	function openGate1(
		tx: PersistentWorkspaceTx,
		task: WorkspaceTaskRow,
		proposal: AnyProposalSnapshot,
		proposal_hash: string,
		at: string,
	): ApprovalRequestRow {
		const request_id = newWorkspaceId("wsa");
		const reserved = bridge.reserve(tx, {
			proposal,
			proposal_hash,
			approval_request_id: request_id,
			now: at,
		});
		const binding = sealRunApprovalBinding({
			approval_request_id: request_id,
			workspace_task_id: task.id,
			proposal_id: proposal.proposal_id,
			proposal_hash,
			execution_binding_hash: reserved.execution_binding_hash,
		});
		const row: ApprovalRequestRow = {
			id: request_id,
			workspace_task_id: task.id,
			kind: "run",
			proposal_id: proposal.proposal_id,
			proposal_hash,
			managed_task_id: reserved.managed_task_id,
			execution_binding: reserved.execution_binding,
			execution_binding_hash: reserved.execution_binding_hash,
			run_id: null,
			result_envelope: null,
			result_envelope_hash: null,
			binding: binding.value,
			binding_hash: binding.hash,
			status: "pending",
			invalidation_reason: null,
			invalidation_detail: null,
			created_at: at,
			updated_at: at,
			closed_at: null,
			rev: 1,
			...NO_CHALLENGE,
		};
		tx.insertApprovalRequest(row);
		return row;
	}

	return {
		createTask(auth, body, now) {
			return guarded((): View => {
				const f = front(auth, body, CreateWorkspaceTaskRequest);
				if (!f.ok) return f.out;
				const b = f.data;
				if (!findRepo(config, b.repo_id)) return fail("repo_not_allowed");
				const safe = storedDraft(b.draft);
				if (!safe.ok) return fail("invalid_request", safe.issues);
				const op = auth.principal.operator_id;
				// over the STORED (redacted) draft: the same raw body always replays; bodies that
				// differ only inside a masked secret are the same request (as for decision reasons, OQ-3)
				const request_hash = createTaskRequestHash({
					repo_id: b.repo_id,
					draft: safe.draft,
				});
				const at = now.toISOString();
				const row: WorkspaceTaskRow = {
					id: newWorkspaceId("wst"),
					contract_version: WORKSPACE_TASK_CONTRACT,
					repo_id: b.repo_id,
					created_by: op,
					idempotency_key: b.idempotency_key,
					request_hash,
					draft: safe.draft,
					stage: "draft",
					stage_detail: null,
					current_proposal_id: null,
					current_managed_task_id: null,
					accepted_decision_id: null,
					cancel_requested_at: null,
					created_at: at,
					updated_at: at,
					rev: 1,
				};
				const stored = store.transaction((tx) => {
					const prior = tx.findTaskByIdempotencyKey(op, b.idempotency_key);
					if (prior) return prior;
					tx.insertTask(row);
					return row;
				});
				if (stored.id !== row.id)
					return hashesEqual(stored.request_hash, request_hash)
						? respond(200, stored.id)
						: fail("idempotency_conflict");
				return respond(201, row.id);
			});
		},

		saveDraft(auth, task_id, body, now) {
			return guarded((): View => {
				const f = front(auth, body, SaveDraftRequest, task_id);
				if (!f.ok) return f.out;
				const b = f.data;
				const safe = storedDraft(b.draft);
				if (!safe.ok) return fail("invalid_request", safe.issues);
				const at = now.toISOString();
				const out = store.transaction((tx) => {
					const task = tx.getTask(task_id);
					if (!task) return fail("not_found");
					if (isTerminalWorkspaceStage(task.stage))
						return fail("invalid_state");
					if (task.rev !== b.expected_rev) return fail("stale_binding");
					const moved = tx.updateTask(
						task_id,
						task.rev,
						{ draft: safe.draft },
						at,
					);
					return moved ? null : fail("stale_binding");
				});
				return out ?? respond(200, task_id);
			});
		},

		async publishProposal(auth, task_id, body, now) {
			try {
				const f = front(auth, body, PublishProposalRequest, task_id);
				if (!f.ok) return f.out;
				const { expected_rev } = f.data;
				// pre-checks + async base resolution outside any transaction
				const pre = store.getTask(task_id);
				if (!pre) return fail("not_found");
				if (isTerminalWorkspaceStage(pre.stage)) return fail("invalid_state");
				if (!PUBLISHABLE_STAGES.includes(pre.stage))
					return fail("invalid_state");
				if (pre.rev !== expected_rev) return fail("stale_binding");
				const draft = ProposalDraft.safeParse(pre.draft);
				if (!draft.success)
					return fail("invalid_request", issuesOf(draft.error));
				const repo = findRepo(config, pre.repo_id);
				if (!repo) return fail("repo_not_allowed");
				const required_checks = repo.verification.map((v) => v.name);
				if (required_checks.length === 0) return fail("repo_not_allowed");
				let base_sha: string;
				try {
					base_sha = await resolveBase(repo);
				} catch (err) {
					if (err instanceof GitError) return fail("repo_not_allowed");
					throw err;
				}
				const at = now.toISOString();
				const out = store.transaction((tx): View | null => {
					const task = tx.getTask(task_id);
					if (!task) return fail("not_found");
					if (!PUBLISHABLE_STAGES.includes(task.stage))
						return fail("invalid_state");
					if (task.rev !== expected_rev) return fail("stale_binding");
					// same rev ⇒ same stored draft as pre-checked, but re-derive from the in-tx row
					if (canonicalEncode(task.draft) !== canonicalEncode(pre.draft))
						return fail("stale_binding");
					const prev = task.current_proposal_id
						? tx.getProposal(task.current_proposal_id)
						: null;
					const proposal_id = newWorkspaceId("wsp");
					// v1.2 only: criterion ids + coverage plan from the STORED draft and the repo's
					// trusted checks; any unmapped / dangling / untrusted / duplicate entry → 400
					const built = buildProposalSnapshotV1_2({
						proposal_id,
						workspace_task_id: task.id,
						version: prev ? prev.version + 1 : 1,
						predecessor_proposal_id: prev?.id ?? null,
						repo_id: task.repo_id,
						base_ref: repo.base_ref,
						base_sha,
						required_checks,
						draft: draft.data,
					});
					if (!built.ok) return fail("invalid_request", built.issues);
					const sealed = sealProposal(built.snapshot);
					tx.insertProposal({
						id: proposal_id,
						workspace_task_id: task.id,
						version: sealed.value.version,
						predecessor_proposal_id: sealed.value.predecessor_proposal_id,
						contract_version: PROPOSAL_CONTRACT_V1_2,
						snapshot: sealed.value,
						proposal_hash: sealed.hash,
						created_by: auth.principal.operator_id,
						created_at: at,
					});
					// supersede: the old pending Gate 1 loses its authority (its challenge dies with it)
					for (const old of tx.listApprovalRequests({
						workspace_task_id: task.id,
						status: "pending",
					})) {
						if (old.kind !== "run") return fail("invalid_state");
						const closed = tx.updateApprovalRequest(
							old.id,
							old.rev,
							{
								status: "invalidated",
								invalidation_reason: "proposal_superseded",
								invalidation_detail: `superseded by proposal version ${sealed.value.version}`,
								closed_at: at,
							},
							at,
						);
						if (!closed) throw new Error("CAS miss on the superseded request");
						bridge.releaseReserved(tx, {
							managed_task_id: old.managed_task_id,
							reason: "proposal_superseded",
							now: at,
						});
					}
					const request = openGate1(tx, task, sealed.value, sealed.hash, at);
					const moved = tx.updateTask(
						task.id,
						task.rev,
						{
							stage: "awaiting_run_approval",
							stage_detail: null,
							current_proposal_id: proposal_id,
							current_managed_task_id: request.managed_task_id,
							cancel_requested_at: null,
						},
						at,
					);
					if (!moved) throw new Error("CAS miss on the workspace task");
					return null;
				});
				return out ?? respond(201, task_id);
			} catch (err) {
				const known = mapKnownError(err);
				if (known) return known;
				throw err;
			}
		},

		requestRerun(auth, task_id, body, now) {
			return guarded((): View => {
				const f = front(auth, body, RequestRerunRequest, task_id);
				if (!f.ok) return f.out;
				const b = f.data;
				const at = now.toISOString();
				const out = store.transaction((tx): View | null => {
					const task = tx.getTask(task_id);
					if (!task) return fail("not_found");
					if (!RERUNNABLE_STAGES.includes(task.stage))
						return fail("invalid_state");
					if (task.rev !== b.expected_rev) return fail("stale_binding");
					if (
						task.current_proposal_id === null ||
						b.proposal_id !== task.current_proposal_id
					)
						return fail("stale_binding");
					if (!findRepo(config, task.repo_id)) return fail("repo_not_allowed");
					if (
						task.current_managed_task_id !== null &&
						openQuarantineFor(store.db, task.current_managed_task_id).length > 0
					)
						return fail("invalid_state");
					if (
						tx.listApprovalRequests({
							workspace_task_id: task.id,
							status: "pending",
						}).length > 0
					)
						return fail("invalid_state");
					const proposal = tx.getProposal(task.current_proposal_id);
					if (!proposal) return fail("invalid_state");
					// v1.2 §A: a legacy v1 proposal has no criterion coverage — its result is never
					// acceptable (criteria_unmapped), so it is not executed again
					if (!isProposalV1_2(proposal.snapshot))
						return fail("invalid_request", [
							{
								path: "proposal_id",
								message:
									"a legacy proposal without criterion coverage cannot run again; publish a new version",
							},
						]);
					const request = openGate1(
						tx,
						task,
						proposal.snapshot,
						proposal.proposal_hash,
						at,
					);
					const moved = tx.updateTask(
						task.id,
						task.rev,
						{
							stage: "awaiting_run_approval",
							stage_detail: null,
							current_managed_task_id: request.managed_task_id,
							cancel_requested_at: null,
						},
						at,
					);
					if (!moved) throw new Error("CAS miss on the workspace task");
					return null;
				});
				return out ?? respond(201, task_id);
			});
		},

		cancel(auth, task_id, body, now) {
			return guarded((): View => {
				const f = front(auth, body, CancelRequest, task_id);
				if (!f.ok) return f.out;
				const { expected_rev } = f.data;
				const at = now.toISOString();
				const out = store.transaction((tx): View | null => {
					const task = tx.getTask(task_id);
					if (!task) return fail("not_found");
					if (task.rev !== expected_rev) return fail("stale_binding");
					// R-A1 / OQ-8: the engine is human_ready, nothing runs; the operator uses Reject
					if (task.stage === "awaiting_acceptance")
						return fail("invalid_state");
					if (!CANCELLABLE_STAGES.includes(task.stage))
						return fail("invalid_state");
					const mt = task.current_managed_task_id;
					if (mt === null) return fail("invalid_state");

					if (task.stage === "cancel_requested") return null; // intent already recorded

					if (task.stage === "awaiting_run_approval") {
						const pending = tx
							.listApprovalRequests({
								workspace_task_id: task.id,
								kind: "run",
								status: "pending",
							})
							.find((r) => r.managed_task_id === mt);
						if (!pending) return fail("invalid_state");
						const closed = tx.updateApprovalRequest(
							pending.id,
							pending.rev,
							{
								status: "invalidated",
								invalidation_reason: "withdrawn",
								invalidation_detail: "withdrawn by the operator",
								closed_at: at,
							},
							at,
						);
						if (!closed) throw new Error("CAS miss on the withdrawn request");
						bridge.releaseReserved(tx, {
							managed_task_id: mt,
							reason: "withdrawn",
							now: at,
						});
						const moved = tx.updateTask(
							task.id,
							task.rev,
							{
								stage: "cancelled",
								stage_detail: "Gate 1 was withdrawn before any work started",
								cancel_requested_at: at,
							},
							at,
						);
						if (!moved) throw new Error("CAS miss on the workspace task");
						return null;
					}

					// queued / running: persist the intent on the managed task
					const before = bridge.engineView(mt);
					if (!before) return fail("invalid_state");
					// bridge lag: the execution already finished — nothing to cancel (R-A1)
					if (
						before.state === "human_ready" ||
						before.state === "failed" ||
						before.state === "cancelled"
					)
						return fail("invalid_state");
					const after = bridge.requestCancel(mt, at);
					const to =
						task.stage === "queued" && after.state === "cancelled"
							? "cancelled"
							: "cancel_requested";
					const moved = tx.updateTask(
						task.id,
						task.rev,
						{
							stage: to,
							stage_detail:
								to === "cancelled"
									? "cancelled before any work started"
									: "cancellation requested; waiting for the engine to confirm termination",
							cancel_requested_at: at,
						},
						at,
					);
					if (!moved) throw new Error("CAS miss on the workspace task");
					return null;
				});
				return out ?? respond(200, task_id);
			});
		},
	};
}
