// All SQL for managed tasks. Synchronous bun:sqlite; every multi-statement change is one IMMEDIATE
// transaction. Worker writes go through withFence(): the task's fence_token must still be the one
// the worker was given at claim time, otherwise StaleLeaseError — a worker that lost its lease can
// never write late, and a result can be accepted at most once per attempt.
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
	ACTIVE_TASK_STATES,
	canTransition,
	type ExecutionMode,
	type FailureKind,
	type Finding,
	isActiveTaskState,
	isTerminalTaskState,
	MANAGED_CONTRACT,
	type ManagedArtifact,
	type ManagedProvider,
	type ManagedReview,
	type ManagedRun,
	type ManagedTask,
	RUNNABLE_TASK_STATES,
	type RunKind,
	type TaskState,
	type TaskSubmission,
} from "@agent-city/schema";

export class StaleLeaseError extends Error {
	constructor(taskId: string) {
		super(`lease lost for ${taskId}`);
		this.name = "StaleLeaseError";
	}
}

export class IdempotencyConflictError extends Error {
	constructor() {
		super("idempotency_key was already used with a different request");
		this.name = "IdempotencyConflictError";
	}
}

export const newId = (prefix: "task" | "run" | "art" | "rev" | "qua") =>
	`${prefix}-${randomUUID()}`;

type Row = Record<string, unknown>;
const json = <T>(v: unknown, fallback: T): T =>
	typeof v === "string" ? (JSON.parse(v) as T) : fallback;

function toTask(r: Row): ManagedTask {
	return {
		...(r as unknown as ManagedTask),
		acceptance_criteria: json<string[]>(r.acceptance_criteria, []),
		approved_scope: json<string[]>(r.approved_scope, []),
	};
}

function toRun(r: Row): ManagedRun {
	return {
		...(r as unknown as ManagedRun),
		repair_input: json<Finding[] | null>(r.repair_input, null),
		usage: json<Record<string, unknown> | null>(r.usage, null),
	};
}

function toArtifact(r: Row): ManagedArtifact {
	return {
		...(r as unknown as ManagedArtifact),
		truncated: r.truncated === 1,
		meta: json<Record<string, unknown>>(r.meta, {}),
	};
}

function toReview(r: Row): ManagedReview {
	return {
		...(r as unknown as ManagedReview),
		valid: r.valid === 1,
		findings: json<Finding[]>(r.findings, []),
		usage: json<Record<string, unknown> | null>(r.usage, null),
	};
}

const tx = <T>(db: Database, fn: () => T): T => db.transaction(fn).immediate();

const taskRow = (db: Database, id: string) =>
	db.query<Row, [string]>("SELECT * FROM managed_tasks WHERE id = ?").get(id);

/** Column patch → `SET a = $a, …` (keys come from code, never from a request). */
function update(db: Database, table: string, id: string, patch: Row): void {
	const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
	if (keys.length === 0) return;
	const params: Record<string, unknown> = { id };
	for (const k of keys) {
		const v = patch[k];
		params[k] =
			v !== null && typeof v === "object"
				? JSON.stringify(v)
				: typeof v === "boolean"
					? Number(v)
					: (v ?? null);
	}
	const bump =
		table === "managed_tasks"
			? ", rev = rev + 1, updated_at = $updated_at_auto"
			: "";
	if (bump) params.updated_at_auto = new Date().toISOString();
	db.query(
		`UPDATE ${table} SET ${keys.map((k) => `${k} = $${k}`).join(", ")}${bump} WHERE id = $id`,
	).run(params as Record<string, string | number | null>);
}

// ── reads ───────────────────────────────────────────────────────────────────

export function getTask(db: Database, id: string): ManagedTask | null {
	const r = taskRow(db, id);
	return r ? toTask(r) : null;
}

export function listTasks(db: Database, limit = 100): ManagedTask[] {
	return db
		.query<Row, [number]>(
			"SELECT * FROM managed_tasks ORDER BY created_at DESC, id DESC LIMIT ?",
		)
		.all(limit)
		.map(toTask);
}

export function getRun(db: Database, id: string): ManagedRun | null {
	const r = db
		.query<Row, [string]>("SELECT * FROM managed_runs WHERE id = ?")
		.get(id);
	return r ? toRun(r) : null;
}

export function listRuns(db: Database, taskId: string): ManagedRun[] {
	return db
		.query<Row, [string]>(
			"SELECT * FROM managed_runs WHERE task_id = ? ORDER BY attempt_no",
		)
		.all(taskId)
		.map(toRun);
}

export function listArtifacts(db: Database, taskId: string): ManagedArtifact[] {
	return db
		.query<Row, [string]>(
			"SELECT * FROM managed_artifacts WHERE task_id = ? ORDER BY created_at, name",
		)
		.all(taskId)
		.map(toArtifact);
}

export function getArtifact(
	db: Database,
	taskId: string,
	artifactId: string,
): ManagedArtifact | null {
	const r = db
		.query<Row, [string, string]>(
			"SELECT * FROM managed_artifacts WHERE id = ? AND task_id = ?",
		)
		.get(artifactId, taskId);
	return r ? toArtifact(r) : null;
}

export function listReviews(db: Database, taskId: string): ManagedReview[] {
	return db
		.query<Row, [string]>(
			"SELECT * FROM managed_reviews WHERE task_id = ? ORDER BY created_at, id",
		)
		.all(taskId)
		.map(toReview);
}

// ── submission / run / cancel (API side, no lease) ──────────────────────────

export interface NewTask {
	/**
	 * Pre-minted id (`task-<uuid>`). The workspace path needs the managed task id before the insert,
	 * because the request hash it stores (the execution binding) covers that id. Absent → minted here.
	 */
	id?: string;
	submission: TaskSubmission;
	request_hash: string;
	base_ref: string;
	base_sha: string;
	now: string;
}

/**
 * Idempotent on `idempotency_key`: the same key with the same request returns the existing task
 * (`created: false`); the same key with a different request is a conflict.
 */
const MANAGED_TASK_ID = /^task-[0-9a-f-]{36}$/;

export function createTask(
	db: Database,
	t: NewTask,
): { task: ManagedTask; created: boolean } {
	return tx(db, () => {
		const prev = db
			.query<Row, [string]>(
				"SELECT * FROM managed_tasks WHERE idempotency_key = ?",
			)
			.get(t.submission.idempotency_key);
		if (prev) {
			if (prev.request_hash !== t.request_hash)
				throw new IdempotencyConflictError();
			return { task: toTask(prev), created: false };
		}
		if (t.id !== undefined && !MANAGED_TASK_ID.test(t.id))
			throw new Error("invalid managed task id");
		const id = t.id ?? newId("task");
		const s = t.submission;
		db.query(
			`INSERT INTO managed_tasks (id, contract_version, idempotency_key, request_hash, repo_id, title,
			   objective, acceptance_criteria, approved_scope, execution_mode, simulation_scenario,
			   repair_limit, base_ref, base_sha, state, created_at, updated_at)
			 VALUES ($id, $contract, $key, $hash, $repo, $title, $objective, $criteria, $scope, $mode,
			   $scenario, $repair_limit, $base_ref, $base_sha, 'draft', $now, $now)`,
		).run({
			id,
			contract: MANAGED_CONTRACT,
			key: s.idempotency_key,
			hash: t.request_hash,
			repo: s.repo_id,
			title: s.title,
			objective: s.objective,
			criteria: JSON.stringify(s.acceptance_criteria),
			scope: JSON.stringify(s.approved_scope),
			mode: s.execution_mode,
			scenario: s.simulation_scenario ?? null,
			repair_limit: s.repair_limit,
			base_ref: t.base_ref,
			base_sha: t.base_sha,
			now: t.now,
		});
		return { task: toTask(taskRow(db, id) as Row), created: true };
	});
}

/**
 * The human Run action: draft / interrupted / blocked → queued, binding the approval. Idempotent —
 * a task that is already queued, active or finished is returned unchanged (`queued: false`).
 */
export function requestRun(
	db: Database,
	id: string,
	approvalHash: string,
	now: string,
): { task: ManagedTask; queued: boolean; quarantined?: boolean } | null {
	return tx(db, () => {
		const r = taskRow(db, id);
		if (!r) return null;
		const task = toTask(r);
		if (openQuarantineFor(db, id).length > 0)
			return { task, queued: false, quarantined: true };
		if (!RUNNABLE_TASK_STATES.includes(task.state))
			return { task, queued: false };
		update(db, "managed_tasks", id, {
			state: "queued",
			failure_kind: null,
			state_detail: null,
			approval_hash: approvalHash,
			run_requested_at: now,
			cancel_requested_at: null,
			lease_owner: null,
			lease_until: null,
			infra_retries: 0,
			fence_token: task.fence_token + 1,
		});
		return { task: toTask(taskRow(db, id) as Row), queued: true };
	});
}

/**
 * Persist the cancel intent. A task no worker owns is cancelled right here; an owned one becomes
 * `cancelled` only after its worker (or reconciliation) confirmed the child process is gone.
 */
export function requestCancel(
	db: Database,
	id: string,
	now: string,
): ManagedTask | null {
	return tx(db, () => {
		const r = taskRow(db, id);
		if (!r) return null;
		const task = toTask(r);
		if (isTerminalTaskState(task.state)) return task;
		// An unresolved child keeps the task out of `cancelled` until its termination is proven.
		const quarantined = openQuarantineFor(db, id).length > 0;
		if (
			quarantined ||
			isActiveTaskState(task.state) ||
			task.lease_owner !== null
		) {
			if (task.cancel_requested_at === null)
				update(db, "managed_tasks", id, { cancel_requested_at: now });
		} else {
			update(db, "managed_tasks", id, {
				state: "cancelled",
				failure_kind: "cancelled",
				state_detail: "cancelled before any work started",
				cancel_requested_at: task.cancel_requested_at ?? now,
				fence_token: task.fence_token + 1,
			});
		}
		return toTask(taskRow(db, id) as Row);
	});
}

// ── worker side ─────────────────────────────────────────────────────────────

const ACTIVE_SQL = ACTIVE_TASK_STATES.map((s) => `'${s}'`).join(", ");

/** The engine's single slot and what waits for it, in claim order (see `claimOrder`). */
export interface ClaimOrder {
	/** Tasks holding a lease (the single slot; normally at most one). */
	leased: ManagedTask[];
	/** Active tasks without a lease (released by reconciliation): claimed first, oldest update first. */
	resumable: ManagedTask[];
	/** Queued tasks without a lease: claimed after every resumable one, oldest run request first. */
	queued: ManagedTask[];
	/** An open quarantine: nothing is claimed in any repository until it is released. */
	quarantined: boolean;
}

/**
 * The ONE definition of the engine's claim order, used by `claimNext` (inside its transaction) and by the
 * workspace read model's global execution queue, so the queue the operator sees is the order the worker
 * claims in. `limit` bounds each list.
 */
export function claimOrder(db: Database, limit = 500): ClaimOrder {
	const rows = (sql: string) =>
		db
			.query<Row, [number]>(sql)
			.all(limit)
			.map((r) => toTask(r));
	return {
		leased: rows(
			"SELECT * FROM managed_tasks WHERE lease_owner IS NOT NULL ORDER BY updated_at, id LIMIT ?",
		),
		resumable: rows(
			`SELECT * FROM managed_tasks WHERE state IN (${ACTIVE_SQL}) AND lease_owner IS NULL ORDER BY updated_at, id LIMIT ?`,
		),
		queued: rows(
			"SELECT * FROM managed_tasks WHERE state = 'queued' AND lease_owner IS NULL ORDER BY run_requested_at, created_at, id LIMIT ?",
		),
		// An execution whose child could not be proven gone is still "running" as far as the
		// single-worker policy is concerned.
		quarantined: listQuarantine(db, { open: true }).length > 0,
	};
}

/**
 * Claim at most one task for `worker`. One managed task at a time: nothing is claimed while another
 * task is leased or a quarantine is open. A task released by reconciliation (active, no lease)
 * resumes first. Every claim moves the fence token.
 */
export function claimNext(
	db: Database,
	worker: string,
	leaseUntil: string,
): ManagedTask | null {
	return tx(db, () => {
		const order = claimOrder(db, 1);
		if (order.leased.length > 0 || order.quarantined) return null;
		const next = order.resumable[0] ?? order.queued[0];
		if (!next) return null;
		update(db, "managed_tasks", next.id, {
			lease_owner: worker,
			lease_until: leaseUntil,
			fence_token: next.fence_token + 1,
		});
		return toTask(taskRow(db, next.id) as Row);
	});
}

/** Run `fn` only while `fence` is still current; otherwise StaleLeaseError and nothing is written. */
export function withFence<T>(
	db: Database,
	taskId: string,
	fence: number,
	fn: (task: ManagedTask) => T,
): T {
	return tx(db, () => {
		const r = taskRow(db, taskId);
		if (!r || r.fence_token !== fence) throw new StaleLeaseError(taskId);
		return fn(toTask(r));
	});
}

export function renewLease(
	db: Database,
	taskId: string,
	fence: number,
	leaseUntil: string,
): boolean {
	try {
		withFence(db, taskId, fence, () =>
			update(db, "managed_tasks", taskId, { lease_until: leaseUntil }),
		);
		return true;
	} catch (err) {
		if (err instanceof StaleLeaseError) return false;
		throw err;
	}
}

export interface StatePatch {
	to: TaskState;
	failure_kind?: FailureKind | null;
	state_detail?: string | null;
	current_run_id?: string;
	result_run_id?: string;
	/** Leaving the worker's hands (terminal / interrupted / blocked) → the lease is dropped. */
	release?: boolean;
}

/** Inside withFence / a reconcile transaction: validated task state change. */
export function setTaskState(
	db: Database,
	task: ManagedTask,
	p: StatePatch,
): void {
	if (task.state !== p.to && !canTransition(task.state, p.to))
		throw new Error(`illegal task transition ${task.state} → ${p.to}`);
	const patch: Row = {
		state: p.to,
		failure_kind: p.failure_kind ?? null,
		state_detail: p.state_detail?.slice(0, 1000) ?? null,
	};
	if (p.current_run_id !== undefined) patch.current_run_id = p.current_run_id;
	if (p.result_run_id !== undefined) patch.result_run_id = p.result_run_id;
	if (p.release) {
		patch.lease_owner = null;
		patch.lease_until = null;
	}
	update(db, "managed_tasks", task.id, patch);
}

export interface NewRun {
	task: ManagedTask;
	kind: RunKind;
	parent_run_id: string | null;
	repair_input: Finding[] | null;
	workspace_path: string | null;
	branch: string | null;
	parent_sha: string | null;
	provider: ManagedProvider;
	mode: ExecutionMode;
	model_requested: string | null;
	now: string;
}

/** Inside a transaction: next attempt number for the task, state `running`, phase `implement`. */
export function insertRun(db: Database, r: NewRun): ManagedRun {
	const id = newId("run");
	const last = db
		.query<{ n: number | null }, [string]>(
			"SELECT max(attempt_no) AS n FROM managed_runs WHERE task_id = ?",
		)
		.get(r.task.id);
	db.query(
		`INSERT INTO managed_runs (id, task_id, attempt_no, kind, parent_run_id, state, phase, repair_input,
		   workspace_path, branch, base_sha, parent_sha, provider, mode, model_requested, started_at)
		 VALUES ($id, $task, $attempt, $kind, $parent, 'running', 'implement', $repair, $ws, $branch,
		   $base, $parent_sha, $provider, $mode, $model, $now)`,
	).run({
		id,
		task: r.task.id,
		attempt: (last?.n ?? 0) + 1,
		kind: r.kind,
		parent: r.parent_run_id,
		repair: r.repair_input ? JSON.stringify(r.repair_input) : null,
		ws: r.workspace_path,
		branch: r.branch,
		base: r.task.base_sha,
		parent_sha: r.parent_sha,
		provider: r.provider,
		mode: r.mode,
		model: r.model_requested,
		now: r.now,
	});
	return getRun(db, id) as ManagedRun;
}

export type RunPatch = Partial<
	Omit<ManagedRun, "id" | "task_id" | "attempt_no" | "kind" | "base_sha">
>;

export function patchRun(db: Database, runId: string, patch: RunPatch): void {
	update(db, "managed_runs", runId, patch as Row);
}

/** Rows written by this helper never name a path outside the artifacts root (see evidence.ts). */
export function insertArtifact(
	db: Database,
	a: Omit<ManagedArtifact, "id">,
): ManagedArtifact {
	const id = newId("art");
	db.query(
		`INSERT INTO managed_artifacts (id, task_id, run_id, kind, name, rel_path, sha256, byte_len,
		   truncated, candidate_sha, meta, created_at)
		 VALUES ($id, $task, $run, $kind, $name, $rel, $sha, $len, $trunc, $cand, $meta, $now)
		 ON CONFLICT(run_id, name) DO UPDATE SET
		   rel_path = excluded.rel_path, sha256 = excluded.sha256, byte_len = excluded.byte_len,
		   truncated = excluded.truncated, candidate_sha = excluded.candidate_sha,
		   meta = excluded.meta, created_at = excluded.created_at`,
	).run({
		id,
		task: a.task_id,
		run: a.run_id,
		kind: a.kind,
		name: a.name,
		rel: a.rel_path,
		sha: a.sha256,
		len: a.byte_len,
		trunc: Number(a.truncated),
		cand: a.candidate_sha,
		meta: JSON.stringify(a.meta),
		now: a.created_at,
	});
	return { ...a, id };
}

export function insertReview(
	db: Database,
	r: Omit<ManagedReview, "id">,
): ManagedReview {
	const id = newId("rev");
	db.query(
		`INSERT INTO managed_reviews (id, task_id, run_id, provider, mode, model_requested, model_resolved,
		   session_ref, candidate_sha, manifest_hash, verdict, valid, invalidated_reason, findings,
		   summary, usage, created_at)
		 VALUES ($id, $task, $run, $provider, $mode, $mreq, $mres, $session, $cand, $manifest, $verdict,
		   $valid, $reason, $findings, $summary, $usage, $now)`,
	).run({
		id,
		task: r.task_id,
		run: r.run_id,
		provider: r.provider,
		mode: r.mode,
		mreq: r.model_requested,
		mres: r.model_resolved,
		session: r.session_ref,
		cand: r.candidate_sha,
		manifest: r.manifest_hash,
		verdict: r.verdict,
		valid: Number(r.valid),
		reason: r.invalidated_reason,
		findings: JSON.stringify(r.findings),
		summary: r.summary,
		usage: r.usage ? JSON.stringify(r.usage) : null,
		now: r.created_at,
	});
	return { ...r, id };
}

/** Repairs already used in the current lineage (since the last initial / rerun attempt). */
export function repairsUsed(db: Database, taskId: string): number {
	let n = 0;
	for (const r of listRuns(db, taskId)) n = r.kind === "repair" ? n + 1 : 0;
	return n;
}

// ── reconciliation ──────────────────────────────────────────────────────────

/** Leased tasks whose lease ran out: their worker is gone (crash / restart). */
export function expiredLeases(db: Database, now: string): ManagedTask[] {
	return db
		.query<Row, [string]>(
			"SELECT * FROM managed_tasks WHERE lease_owner IS NOT NULL AND lease_until < ? ORDER BY updated_at",
		)
		.all(now)
		.map(toTask);
}

/**
 * Take a task away from a worker whose lease expired: move the fence and lease it to `worker`, but
 * only if nobody touched the task since `task` was read (else null — re-read next tick). From this
 * point the old worker can write nothing, so its leftovers can be stopped and judged safely.
 */
export function seize(
	db: Database,
	task: ManagedTask,
	worker: string,
	leaseUntil: string,
): ManagedTask | null {
	return tx(db, () => {
		const r = taskRow(db, task.id);
		if (!r || r.fence_token !== task.fence_token || r.rev !== task.rev)
			return null;
		update(db, "managed_tasks", task.id, {
			fence_token: task.fence_token + 1,
			lease_owner: worker,
			lease_until: leaseUntil,
		});
		return toTask(taskRow(db, task.id) as Row);
	});
}

/** Inside withFence: give the task back without changing its state (bounded retry). */
export function releaseForRetry(db: Database, task: ManagedTask): void {
	update(db, "managed_tasks", task.id, {
		lease_owner: null,
		lease_until: null,
		infra_retries: task.infra_retries + 1,
	});
}

// ── quarantine (unresolved child processes) ─────────────────────────────────

export interface Quarantine {
	id: string;
	task_id: string;
	run_id: string | null;
	pid: number;
	started: string | null;
	reason: string;
	created_at: string;
	last_checked_at: string | null;
	last_check: string | null;
	released_at: string | null;
	release_evidence: string | null;
}

export function listQuarantine(
	db: Database,
	o: { open?: boolean; taskId?: string },
): Quarantine[] {
	const where: string[] = [];
	const params: string[] = [];
	if (o.open) where.push("released_at IS NULL");
	if (o.taskId) {
		where.push("task_id = ?");
		params.push(o.taskId);
	}
	return db
		.query<Quarantine, string[]>(
			`SELECT * FROM managed_quarantine${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`,
		)
		.all(...params);
}

export const openQuarantineFor = (db: Database, taskId: string) =>
	listQuarantine(db, { open: true, taskId });

/**
 * Record a child whose termination could not be confirmed. Not fenced on purpose: safety data is
 * written even by a worker that lost its lease. Idempotent per open (task, pid).
 */
export function openQuarantine(
	db: Database,
	q: {
		task_id: string;
		run_id: string | null;
		pid: number;
		started: string | null;
		reason: string;
		now: string;
	},
): void {
	tx(db, () => {
		const existing = db
			.query<{ id: string }, [string, number]>(
				"SELECT id FROM managed_quarantine WHERE task_id = ? AND pid = ? AND released_at IS NULL",
			)
			.get(q.task_id, q.pid);
		if (existing) return;
		db.query(
			`INSERT INTO managed_quarantine (id, task_id, run_id, pid, started, reason, created_at)
			 VALUES ($id, $task, $run, $pid, $started, $reason, $now)`,
		).run({
			id: newId("qua"),
			task: q.task_id,
			run: q.run_id,
			pid: q.pid,
			started: q.started,
			reason: q.reason.slice(0, 500),
			now: q.now,
		});
	});
}

export function noteQuarantineCheck(
	db: Database,
	id: string,
	check: string,
	now: string,
): void {
	db.query(
		"UPDATE managed_quarantine SET last_check = ?, last_checked_at = ? WHERE id = ? AND released_at IS NULL",
	).run(check.slice(0, 500), now, id);
}

/**
 * Release on objective evidence (see proc.resolveRecorded). If that was the task's last open
 * quarantine and a cancel is pending, the cancel completes now; the run's child pid is cleared.
 */
export function releaseQuarantine(
	db: Database,
	q: Quarantine,
	evidence: string,
	now: string,
): void {
	tx(db, () => {
		db.query(
			"UPDATE managed_quarantine SET released_at = ?, release_evidence = ?, last_check = ?, last_checked_at = ? WHERE id = ? AND released_at IS NULL",
		).run(now, evidence.slice(0, 500), evidence.slice(0, 500), now, q.id);
		if (q.run_id) {
			const run = getRun(db, q.run_id);
			if (run?.child_pid === q.pid)
				update(db, "managed_runs", q.run_id, {
					child_pid: null,
					child_started: null,
					proc_phase: null,
					proc_started_at: null,
				});
		}
		if (openQuarantineFor(db, q.task_id).length > 0) return;
		const task = getTask(db, q.task_id);
		if (
			task?.cancel_requested_at &&
			task.lease_owner === null &&
			canTransition(task.state, "cancelled")
		)
			update(db, "managed_tasks", task.id, {
				state: "cancelled",
				failure_kind: "cancelled",
				state_detail: `cancelled; ${evidence}`.slice(0, 1000),
				fence_token: task.fence_token + 1,
			});
	});
}
