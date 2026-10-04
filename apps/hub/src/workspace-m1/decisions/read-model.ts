// Workspace read model (role 04): GET /snapshot, GET /tasks/:id, the WorkspaceTaskView every
// mutation returns, and the artifact read. Every response is validated with its contract schema
// before it leaves (fail closed: a body that does not validate is never sent — ResponseContractError
// → 500 without data). Client views never carry challenge columns, create-command internals, host
// paths, pids or provider output; observed session telemetry is never read.
//
// v1.2 (CONTRACT_V1_2.md §B/§C):
//   - `acceptance_validity` (the CURRENT validity of an accepted result, separate from the historical
//     decision) on every task view and snapshot list item: the stored row.
//   - task detail of an accepted task re-checks when the stored check is older than 5 s (throttled per
//     decision, one check in flight): bundle + source artifacts synchronously (an invalid verdict is
//     visible in THIS response), the candidate commit (git) in the background — its verdict lands in
//     the row for the next read. `taskDetailChecked` awaits the full check instead.
//   - artifacts of a result request with a durable bundle are served only from the verified bundle.
//
// API v1.2 (multi-repository milestone, docs/workspace-m1/MULTIREPO_MILESTONE.md): each snapshot list item
// carries the task's engine view and newest approval request; the snapshot carries the global execution
// queue (the engine's own claim order — `claimOrder`, the same function `claimNext` uses) and the
// observed-only repositories (telemetry `repos` rows / session repo ids outside the allowlist; read-only).

import type { ManagedTask } from "@agent-city/schema";
import {
	type AcceptanceValidityRow,
	type AcceptanceValidityView,
	type ApprovalRequestRow,
	type ApprovalRequestView,
	ArtifactId,
	type ArtifactListItem,
	ArtifactTextResponse,
	type CommandOutcome,
	type DecisionView,
	deriveWorkspacePhase,
	type EngineView,
	type ExecutionBridge,
	type ExecutionQueue,
	type ManagedDecisionRow,
	type ObservedRepo,
	type QueueEntry,
	RepoId,
	type RepoTaskCount,
	type RequestSummary,
	type RunSummary,
	type WorkspaceRepo,
	WorkspaceSnapshot,
	WorkspaceTaskDetail,
	WorkspaceTaskId,
	type WorkspaceTaskRow,
	type WorkspaceTaskSummary,
	WorkspaceTaskView,
} from "@agent-city/schema/workspace-m1";
import type { z } from "zod";
import type { ManagedConfig } from "../../managed/config.ts";
import {
	claimOrder,
	getArtifact,
	listArtifacts,
	listRuns,
} from "../../managed/store.ts";
import {
	ArtifactNotFound,
	type ArtifactReaderDeps,
	readArtifactFromBundle,
	readArtifactText,
} from "../evidence/reader.ts";
import {
	type AcceptanceCheckDeps,
	checkAcceptance,
	checkAcceptedEvidence,
	recordAcceptanceVerdict,
	subjectOf,
} from "../evidence/validity.ts";
import type { PersistentWorkspaceStore } from "../persistence/index.ts";
import { fail, ok, ResponseContractError } from "./outcome.ts";

const MAX_TASKS = 500;
const MAX_REQUESTS = 500;
const MAX_RUNS = 50;
const MAX_ARTIFACTS = 500;
const MAX_OBSERVED = 200;

export interface ReadModelDeps {
	store: PersistentWorkspaceStore;
	config: ManagedConfig;
	bridge: Pick<ExecutionBridge, "engineView">;
	/** 06 artifact reader deps (same db/config; share the sealer's RetainedEvidenceStore). */
	reader?: ArtifactReaderDeps;
	/** Clock for validity `checked_at` (default: the system clock). */
	clock?: { now(): Date };
	/** Re-check an accepted result on a detail read when its last check is older (default 5000 ms). */
	recheck_after_ms?: number;
}

/** The client view of a validity row (no rev / request id / task id). */
export function validityView(v: AcceptanceValidityRow): AcceptanceValidityView {
	return {
		decision_id: v.decision_id,
		status: v.status,
		reason: v.reason,
		detail: v.detail,
		checked_at: v.checked_at,
		first_invalid_at: v.first_invalid_at,
		evidence_bundle_digest: v.evidence_bundle_digest,
	};
}

function validated<S extends z.ZodType>(
	schema: S,
	value: unknown,
	what: string,
): z.infer<S> {
	const r = schema.safeParse(value);
	if (!r.success) throw new ResponseContractError(what);
	return r.data as z.infer<S>;
}

export function taskSummary(row: WorkspaceTaskRow): WorkspaceTaskSummary {
	const { idempotency_key: _k, request_hash: _h, ...summary } = row;
	return summary;
}

export function requestView(row: ApprovalRequestRow): ApprovalRequestView {
	const {
		challenge_status: _s,
		challenge_hash: _h,
		challenge_operator_id: _o,
		challenge_session_generation: _g,
		challenge_boot_id: _b,
		challenge_request_rev: _r,
		challenge_issued_at: _i,
		challenge_expires_at: _e,
		// server-only (v1.2): the durable bundle is surfaced through acceptance_validity instead
		evidence_bundle_digest: _d,
		...view
	} = row;
	return view;
}

export function decisionView(row: ManagedDecisionRow): DecisionView {
	return {
		id: row.id,
		approval_request_id: row.approval_request_id,
		kind: row.kind,
		action: row.action,
		operator_id: row.operator_id,
		payload_hash: row.payload_hash,
		binding_hash: row.binding_hash,
		reason: row.reason,
		result_envelope_hash: row.result_envelope_hash,
		decided_at: row.decided_at,
	};
}

export interface WorkspaceReadModel {
	/** The view returned by every task mutation; null when the task does not exist. */
	taskView(id: string): WorkspaceTaskView | null;
	snapshot(now: Date): CommandOutcome<WorkspaceSnapshot>;
	/** Detail (re-checks an accepted result's validity when due; see the header). */
	taskDetail(id: string): CommandOutcome<WorkspaceTaskDetail>;
	/** Detail after AWAITING a due full re-check (bundle + sources + candidate). */
	taskDetailChecked(id: string): Promise<CommandOutcome<WorkspaceTaskDetail>>;
	artifact(
		task_id: string,
		artifact_id: string,
	): Promise<CommandOutcome<ArtifactTextResponse>>;
	/** Managed tasks (executions) of a workspace task, oldest first. */
	managedTasksOf(task_id: string): string[];
}

export function createWorkspaceReadModel(
	deps: ReadModelDeps,
): WorkspaceReadModel {
	const { store, config, bridge } = deps;
	const db = store.db;
	const clockNow = () => (deps.clock ? deps.clock.now() : new Date());
	const recheckAfter = Math.max(0, deps.recheck_after_ms ?? 5_000);
	const checkDeps: AcceptanceCheckDeps = {
		db,
		config,
		...(deps.reader?.gitFor ? { gitFor: deps.reader.gitFor } : {}),
	};

	/** The current validity of a task's accepted result (null when nothing is accepted). */
	const acceptanceOf = (
		row: WorkspaceTaskRow,
	): AcceptanceValidityView | null => {
		if (row.stage !== "accepted" || !row.accepted_decision_id) return null;
		const v = store.getAcceptanceValidity(row.accepted_decision_id);
		if (v) return validityView(v);
		// no row (written around the decision service): never presented as verified
		const d = store.getDecision(row.accepted_decision_id);
		return {
			decision_id: row.accepted_decision_id,
			status: "unknown",
			reason: "verification_unavailable",
			detail: "no current-validity record exists for this acceptance",
			checked_at: d?.decided_at ?? row.updated_at,
			first_invalid_at: null,
			evidence_bundle_digest: d?.evidence_bundle_digest ?? null,
		};
	};

	// read-triggered re-checks: per decision, at most one per window and one in flight (memory only)
	const lastStarted = new Map<string, number>();
	const inFlight = new Map<string, Promise<void>>();
	const monotonic = () => performance.now();

	/** The validity row of an accepted task when it is due for a re-check, else null. */
	const dueRow = (row: WorkspaceTaskRow): AcceptanceValidityRow | null => {
		if (row.stage !== "accepted" || !row.accepted_decision_id) return null;
		const v = store.getAcceptanceValidity(row.accepted_decision_id);
		if (!v || v.status === "invalid" || v.status === "unverifiable")
			return null;
		const age = clockNow().getTime() - Date.parse(v.checked_at);
		// a check stamped in the future (clock skew) is treated as due
		if (age >= 0 && age <= recheckAfter) return null;
		if (inFlight.has(v.decision_id)) return null;
		const last = lastStarted.get(v.decision_id);
		if (last !== undefined && monotonic() - last < recheckAfter) return null;
		return v;
	};

	const startFullCheck = (v: AcceptanceValidityRow): Promise<void> => {
		const running = inFlight.get(v.decision_id);
		if (running) return running;
		const subject = subjectOf(store, v);
		if (!subject) return Promise.resolve();
		if (lastStarted.size > 10_000) lastStarted.clear();
		lastStarted.set(v.decision_id, monotonic());
		const p = checkAcceptance(checkDeps, subject)
			.then((verdict) => {
				recordAcceptanceVerdict(
					store,
					v.decision_id,
					verdict,
					clockNow().toISOString(),
				);
			})
			.catch(() => {
				// the next read or sweep retries; a failed check never marks anything verified
			})
			.finally(() => {
				inFlight.delete(v.decision_id);
			});
		inFlight.set(v.decision_id, p);
		return p;
	};

	/** Detail read: synchronous evidence re-check (visible now) + background candidate check. */
	const refreshOnRead = (row: WorkspaceTaskRow): void => {
		try {
			const v = dueRow(row);
			if (!v) return;
			const subject = subjectOf(store, v);
			if (!subject) return;
			const ev = checkAcceptedEvidence(checkDeps, subject);
			if (ev.status === "invalid") {
				lastStarted.set(v.decision_id, monotonic());
				recordAcceptanceVerdict(
					store,
					v.decision_id,
					ev,
					clockNow().toISOString(),
				);
				return;
			}
			void startFullCheck(v);
		} catch {
			// a read never fails because a re-check could not run; the stored row is served
		}
	};

	const engineOf = (row: WorkspaceTaskRow): EngineView | null =>
		row.current_managed_task_id
			? bridge.engineView(row.current_managed_task_id)
			: null;

	const managedTasksOf = (task_id: string): string[] => {
		const ids: string[] = [];
		const runRequests = store
			.listApprovalRequests({ workspace_task_id: task_id, kind: "run" })
			.slice()
			.reverse(); // oldest first
		for (const r of runRequests)
			if (!ids.includes(r.managed_task_id)) ids.push(r.managed_task_id);
		return ids;
	};

	const viewOf = (row: WorkspaceTaskRow): WorkspaceTaskView => {
		const engine = engineOf(row);
		const proposal = row.current_proposal_id
			? store.getProposal(row.current_proposal_id)
			: null;
		return validated(
			WorkspaceTaskView,
			{
				task: taskSummary(row),
				phase: deriveWorkspacePhase(row.stage, engine?.state ?? null),
				engine,
				current_proposal: proposal,
				approval_requests: store
					.listApprovalRequests({ workspace_task_id: row.id })
					.slice(0, MAX_REQUESTS)
					.map(requestView),
				decisions: store
					.listDecisions(row.id)
					.slice(0, MAX_REQUESTS)
					.map(decisionView),
				acceptance_validity: acceptanceOf(row),
			},
			"task view",
		);
	};

	const taskView = (id: string): WorkspaceTaskView | null => {
		if (!WorkspaceTaskId.safeParse(id).success) return null;
		const row = store.getTask(id);
		return row ? viewOf(row) : null;
	};

	const repos = (): WorkspaceRepo[] =>
		config.repos.map((r) => ({
			repo_id: r.id,
			base_ref: r.base_ref,
			required_checks: r.verification.map((v) => v.name),
		}));

	/** The newest approval request (any status) of every task, one query. */
	const latestRequests = (): Map<string, RequestSummary> => {
		const rows = db
			.query<RequestSummary & { workspace_task_id: string }, []>(
				`SELECT id, workspace_task_id, kind, status, invalidation_reason, created_at, closed_at
				 FROM (SELECT *, row_number() OVER (
				         PARTITION BY workspace_task_id ORDER BY created_at DESC, rowid DESC) AS rn
				       FROM managed_approval_requests)
				 WHERE rn = 1`,
			)
			.all();
		return new Map(
			rows.map(({ workspace_task_id, ...summary }) => [
				workspace_task_id,
				summary,
			]),
		);
	};

	/** The engine's single slot and its waiting line, in the order the worker claims (one definition). */
	const executionQueue = (): ExecutionQueue => {
		const order = claimOrder(db, MAX_REQUESTS);
		const entry = (t: ManagedTask): QueueEntry => ({
			managed_task_id: t.id,
			workspace_task_id: store.findTaskByManagedTask(t.id)?.id ?? null,
			repo_id: t.repo_id,
			state: t.state,
			run_requested_at: t.run_requested_at,
		});
		// the slot: the leased execution, else an ACTIVE (executing / verifying / reviewing / repairing)
		// one that resumes first. A merely queued execution is never reported as holding it — not when
		// nothing is leased, and not while an open quarantine pauses every claim.
		const resumable = [...order.resumable];
		const active = order.leased[0] ?? resumable.shift() ?? null;
		const waiting = [...resumable, ...order.queued];
		return {
			active: active ? entry(active) : null,
			queued: waiting.slice(0, MAX_REQUESTS).map(entry),
			claims_paused_by_quarantine: order.quarantined,
		};
	};

	/**
	 * P2 F-01: complete totals per allowlisted repository over every recorded task (not the bounded task
	 * window), read in the same synchronous snapshot as the window, so the two always agree.
	 */
	const repoTaskCounts = (): RepoTaskCount[] => {
		const tasks = new Map(
			db
				.query<{ repo_id: string; n: number }, []>(
					"SELECT repo_id, count(*) AS n FROM workspace_tasks GROUP BY repo_id",
				)
				.all()
				.map((r) => [r.repo_id, r.n]),
		);
		return config.repos.map((r) => ({
			repo_id: r.id,
			tasks: tasks.get(r.id) ?? 0,
		}));
	};

	/**
	 * Repositories the hub has only observed (GitHub sync / local checkout scan rows, or session telemetry
	 * naming a repo with no row), minus the allowlist (case-insensitive). Read-only display data: nothing
	 * here makes a repository execution-eligible — only the trusted managed config does.
	 */
	const observedRepos = (): ObservedRepo[] => {
		const allowed = new Set(config.repos.map((r) => r.id.toLowerCase()));
		const out = new Map<string, ObservedRepo>();
		const add = (id: string, source: ObservedRepo["source"]) => {
			const key = id.toLowerCase();
			if (allowed.has(key) || out.has(key)) return;
			if (!RepoId.safeParse(id).success) return;
			out.set(key, { repo_id: id, source });
		};
		for (const r of db
			.query<{ id: string; is_local_only: number }, []>(
				"SELECT id, is_local_only FROM repos ORDER BY is_local_only, id",
			)
			.all())
			add(r.id, r.is_local_only === 1 ? "local_checkout" : "github");
		for (const r of db
			.query<{ repo_id: string }, []>(
				"SELECT DISTINCT repo_id FROM sessions WHERE repo_id IS NOT NULL ORDER BY repo_id",
			)
			.all())
			add(r.repo_id, "telemetry");
		return [...out.values()]
			.sort((a, b) =>
				a.repo_id < b.repo_id ? -1 : a.repo_id > b.repo_id ? 1 : 0,
			)
			.slice(0, MAX_OBSERVED);
	};

	const taskDetail = (id: string): CommandOutcome<WorkspaceTaskDetail> => {
		if (!WorkspaceTaskId.safeParse(id).success) return fail("not_found");
		const row = store.getTask(id);
		if (!row) return fail("not_found");
		refreshOnRead(row);
		const view = viewOf(row);
		const managed = managedTasksOf(id);
		const runs: RunSummary[] = [];
		const artifacts: ArtifactListItem[] = [];
		for (const mt of managed) {
			for (const r of listRuns(db, mt))
				runs.push({
					run_id: r.id,
					managed_task_id: r.task_id,
					attempt_no: r.attempt_no,
					kind: r.kind,
					state: r.state,
					phase: r.phase,
					outcome: r.outcome,
					candidate_sha: r.candidate_sha,
					manifest_hash: r.manifest_hash,
					failure_kind: r.failure_kind,
					started_at: r.started_at,
					ended_at: r.ended_at,
				});
			for (const a of listArtifacts(db, mt))
				artifacts.push({
					artifact_id: a.id,
					run_id: a.run_id,
					name: a.name,
					kind: a.kind,
					byte_len: a.byte_len,
					truncated: a.truncated,
					created_at: a.created_at,
				});
		}
		return ok(
			200,
			validated(
				WorkspaceTaskDetail,
				{
					...view,
					runs: runs.slice(-MAX_RUNS),
					artifacts: artifacts.slice(-MAX_ARTIFACTS),
				},
				"task detail",
			),
		);
	};

	return {
		taskView,
		managedTasksOf,

		snapshot(now) {
			const latest = latestRequests();
			const pending = store
				.listApprovalRequests({ status: "pending" })
				.slice()
				.reverse() // listApprovalRequests is newest first; the HQ inbox is oldest first
				.slice(0, MAX_REQUESTS)
				.map(requestView);
			const queue = executionQueue();
			// P2 F-01: the window always holds every task the emitted inbox and queue name (inbox first),
			// so a request's task / repository never depends on how recently the task was updated
			const pinned = [
				...pending.map((r) => r.workspace_task_id),
				queue.active?.workspace_task_id,
				...queue.queued.map((q) => q.workspace_task_id),
			].filter((id): id is string => typeof id === "string");
			const tasks = store.listTasks(MAX_TASKS, pinned).map((row) => {
				const engine = engineOf(row);
				return {
					task: taskSummary(row),
					phase: deriveWorkspacePhase(row.stage, engine?.state ?? null),
					// the stored row (no re-check here: a list-only viewer sees a change only once a sweep
					// batch — at most 20, oldest check first — reaches it; CONTRACT_V1_2.md §C)
					acceptance_validity: acceptanceOf(row),
					engine,
					latest_request: latest.get(row.id) ?? null,
				};
			});
			return ok(
				200,
				validated(
					WorkspaceSnapshot,
					{
						provenance: {
							data_source: "hub",
							execution_mode: "simulated",
							live_integration_verified: false,
						},
						repos: repos(),
						observed_repos: observedRepos(),
						tasks,
						repo_task_counts: repoTaskCounts(),
						pending_requests: pending,
						execution_queue: queue,
						generated_at: now.toISOString(),
					},
					"snapshot",
				),
			);
		},

		taskDetail,

		async taskDetailChecked(id) {
			if (WorkspaceTaskId.safeParse(id).success) {
				const row = store.getTask(id);
				const v = row ? dueRow(row) : null;
				if (v) await startFullCheck(v);
				else if (row?.accepted_decision_id) {
					const running = inFlight.get(row.accepted_decision_id);
					if (running) await running;
				}
			}
			return taskDetail(id);
		},

		async artifact(task_id, artifact_id) {
			if (
				!WorkspaceTaskId.safeParse(task_id).success ||
				!ArtifactId.safeParse(artifact_id).success ||
				!deps.reader
			)
				return fail("not_found");
			const row = store.getTask(task_id);
			if (!row) return fail("not_found");
			// the artifact must belong to one of THIS workspace task's executions
			let owner: string | null = null;
			let runId: string | null = null;
			for (const mt of managedTasksOf(task_id)) {
				const a = getArtifact(db, mt, artifact_id);
				if (a) {
					owner = mt;
					runId = a.run_id;
					break;
				}
			}
			if (!owner || !runId) return fail("not_found");
			const rr = store.findResultRequestForRun(runId);
			const sealed =
				rr &&
				rr.workspace_task_id === task_id &&
				rr.result_envelope &&
				rr.result_envelope_hash
					? {
							envelope: rr.result_envelope,
							envelope_hash: rr.result_envelope_hash,
						}
					: null;
			try {
				// v1.2 §B: a result with a durable bundle (pending / accepted / declined) is served only
				// from the verified bundle — history included; the mutable store never substitutes bytes
				const digest = rr?.evidence_bundle_digest ?? null;
				if (sealed && rr && rr.status !== "invalidated" && digest) {
					const record = store.getEvidenceBundle(digest);
					const res = readArtifactFromBundle(deps.reader, {
						managed_task_id: owner,
						artifact_id,
						envelope: sealed.envelope,
						envelope_hash: sealed.envelope_hash,
						digest,
						...(record ? { byte_len: record.byte_len } : {}),
					});
					return ok(200, validated(ArtifactTextResponse, res, "artifact"));
				}
				// An invalidated result is history whose current bytes failed (or were never) verified:
				// never serve a sealed copy as current evidence — re-verify from disk (R-F5), and the
				// fresh read must still reproduce the sealed envelope item exactly.
				const res = await readArtifactText(deps.reader, {
					managed_task_id: owner,
					artifact_id,
					bound: sealed,
					...(rr?.status === "invalidated" ? { use_retained: false } : {}),
				});
				return ok(200, validated(ArtifactTextResponse, res, "artifact"));
			} catch (err) {
				if (err instanceof ArtifactNotFound) return fail("not_found");
				throw err;
			}
		},
	};
}
