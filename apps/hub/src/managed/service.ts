// Managed-task operations behind the API: submit, run (approve), cancel, read. Validation and
// allowlisting happen here; the routes stay thin. Nothing in this file starts a provider process —
// that is the worker's job once a task is queued.
import type { Database } from "bun:sqlite";
import {
	MANAGED_CONTRACT,
	type ManagedArtifact,
	type ManagedReview,
	type ManagedRun,
	type ManagedTask,
	redact,
	TaskSubmission,
} from "@agent-city/schema";
import {
	canonicalJson,
	findRepo,
	type ManagedConfig,
	policyHash,
	sha256Hex,
} from "./config.ts";
import { ArtifactAccessError, readArtifact } from "./evidence.ts";
import {
	type GitCtx,
	GitError,
	mutationSince,
	resolveCommit,
	validateRepo,
} from "./git.ts";
import {
	createTask,
	getArtifact,
	getTask,
	IdempotencyConflictError,
	listArtifacts,
	listReviews,
	listRuns,
	listTasks,
	requestCancel,
	requestRun,
} from "./store.ts";

export class ServiceError extends Error {
	constructor(
		readonly status: 400 | 404 | 409 | 422,
		readonly code: string,
		message: string,
		readonly issues?: { path: string; message: string }[],
	) {
		super(message);
		this.name = "ServiceError";
	}
}

export interface ManagedDeps {
	db: Database;
	config: ManagedConfig;
	now?: () => Date;
	/** Called after a task row changed (the hub broadcasts the id on /ws). */
	onChange?: (taskId: string) => void;
}

export const gitCtx = (config: ManagedConfig): GitCtx => ({
	git: config.git_executable,
	killGraceMs: config.limits.kill_grace_ms,
});

const nowIso = (d: ManagedDeps) => (d.now?.() ?? new Date()).toISOString();

/** Live execution needs the master switch and both provider blocks. */
export const liveConfigured = (config: ManagedConfig): boolean =>
	config.live.enabled && !!config.live.claude && !!config.live.codex;

/**
 * Approval binding (ARCHITECTURE #5): what was approved = this task content on this base commit
 * under this policy. Re-computed at claim time; any difference voids the approval.
 */
export function approvalHashFor(
	task: ManagedTask,
	config: ManagedConfig,
): string {
	return sha256Hex(
		canonicalJson({
			contract: MANAGED_CONTRACT,
			repo_id: task.repo_id,
			title: task.title,
			objective: task.objective,
			acceptance_criteria: task.acceptance_criteria,
			approved_scope: task.approved_scope,
			execution_mode: task.execution_mode,
			simulation_scenario: task.simulation_scenario,
			repair_limit: task.repair_limit,
			base_sha: task.base_sha,
			policy: policyHash(config, task.repo_id),
		}),
	);
}

/**
 * Create a draft task. The body is validated, the repo must be in the allowlist, the base ref is
 * resolved to a commit now, and user-authored text is redacted before it is stored. Idempotent on
 * `idempotency_key`.
 */
export async function submitTask(
	deps: ManagedDeps,
	body: unknown,
): Promise<{ task: ManagedTask; created: boolean }> {
	const parsed = TaskSubmission.safeParse(body);
	if (!parsed.success)
		throw new ServiceError(
			400,
			"invalid_task",
			"invalid task",
			parsed.error.issues
				.slice(0, 20)
				.map((i) => ({ path: i.path.join("."), message: i.message })),
		);
	const s = parsed.data;
	const repo = findRepo(deps.config, s.repo_id);
	if (!repo)
		throw new ServiceError(
			422,
			"repo_not_allowed",
			"repository is not in the managed allowlist",
		);
	if (s.execution_mode === "live" && !liveConfigured(deps.config))
		throw new ServiceError(
			409,
			"live_disabled",
			"live execution is disabled in the managed config",
		);

	const submission: TaskSubmission = {
		...s,
		title: redact(s.title),
		objective: redact(s.objective),
		acceptance_criteria: s.acceptance_criteria.map((c) => redact(c)),
		simulation_scenario:
			s.execution_mode === "simulated"
				? (s.simulation_scenario ?? "approve")
				: undefined,
	};

	let baseSha: string;
	try {
		const git = gitCtx(deps.config);
		const path = await validateRepo(git, repo.path, [
			deps.config.workspace_root,
			deps.config.artifacts_root,
		]);
		baseSha = await resolveCommit(git, path, repo.base_ref);
	} catch (err) {
		if (err instanceof GitError)
			throw new ServiceError(422, "repo_invalid", err.message);
		throw err;
	}

	try {
		const res = createTask(deps.db, {
			submission,
			request_hash: sha256Hex(canonicalJson(submission)),
			base_ref: repo.base_ref,
			base_sha: baseSha,
			now: nowIso(deps),
		});
		if (res.created) deps.onChange?.(res.task.id);
		return res;
	} catch (err) {
		if (err instanceof IdempotencyConflictError)
			throw new ServiceError(409, "idempotency_conflict", err.message);
		throw err;
	}
}

/** The explicit human Run action. Repeating it never queues the task twice. */
export function runTask(
	deps: ManagedDeps,
	id: string,
): { task: ManagedTask; queued: boolean } {
	const task = getTask(deps.db, id);
	if (!task) throw new ServiceError(404, "not_found", "no such task");
	if (task.execution_mode === "live" && !liveConfigured(deps.config))
		throw new ServiceError(
			409,
			"live_disabled",
			"live execution is disabled in the managed config",
		);
	const res = requestRun(
		deps.db,
		id,
		approvalHashFor(task, deps.config),
		nowIso(deps),
	);
	if (!res) throw new ServiceError(404, "not_found", "no such task");
	if (res.queued) deps.onChange?.(id);
	return res;
}

/** Persist the cancel intent (idempotent). The worker confirms process termination. */
export function cancelTask(deps: ManagedDeps, id: string): ManagedTask {
	const task = requestCancel(deps.db, id, nowIso(deps));
	if (!task) throw new ServiceError(404, "not_found", "no such task");
	deps.onChange?.(id);
	return task;
}

export interface ResultIntegrity {
	/** The reviewed candidate is still exactly what the workspace holds. */
	intact: boolean;
	reason: string | null;
}

export interface TaskDetail {
	task: ManagedTask;
	runs: ManagedRun[];
	reviews: ManagedReview[];
	artifacts: ManagedArtifact[];
	/** Only for human_ready tasks: checked against the workspace at read time. */
	integrity: ResultIntegrity | null;
}

export async function taskDetail(
	deps: ManagedDeps,
	id: string,
): Promise<TaskDetail> {
	const task = getTask(deps.db, id);
	if (!task) throw new ServiceError(404, "not_found", "no such task");
	const runs = listRuns(deps.db, id);
	let integrity: ResultIntegrity | null = null;
	if (task.state === "human_ready") {
		const run = runs.find((r) => r.id === task.result_run_id);
		if (!run?.workspace_path || !run.candidate_sha) {
			integrity = { intact: false, reason: "result run has no candidate" };
		} else {
			try {
				const reason = await mutationSince(
					gitCtx(deps.config),
					run.workspace_path,
					run.candidate_sha,
				);
				integrity = { intact: reason === null, reason };
			} catch {
				integrity = { intact: false, reason: "workspace is not readable" };
			}
		}
	}
	return {
		task,
		runs,
		reviews: listReviews(deps.db, id),
		artifacts: listArtifacts(deps.db, id),
		integrity,
	};
}

export const allTasks = (deps: ManagedDeps) => listTasks(deps.db);

export const ARTIFACT_VIEW_MAX_BYTES = 1_048_576;

/** Artifact content by (task id, artifact id) — never by path. */
export function readTaskArtifact(
	deps: ManagedDeps,
	taskId: string,
	artifactId: string,
): { artifact: ManagedArtifact; text: string; truncated: boolean } {
	const artifact = getArtifact(deps.db, taskId, artifactId);
	if (!artifact) throw new ServiceError(404, "not_found", "no such artifact");
	try {
		const { text, truncated } = readArtifact(
			deps.config.artifacts_root,
			artifact,
			ARTIFACT_VIEW_MAX_BYTES,
		);
		return { artifact, text, truncated: truncated || artifact.truncated };
	} catch (err) {
		if (err instanceof ArtifactAccessError)
			throw new ServiceError(404, "not_found", "artifact is not available");
		throw err;
	}
}

/** What the UI may know about the config: ids and names, no host paths, no executables. */
export function publicConfig(config: ManagedConfig) {
	return {
		repos: config.repos.map((r) => ({
			id: r.id,
			base_ref: r.base_ref,
			verification: r.verification.map((v) => v.name),
		})),
		live: {
			enabled: liveConfigured(config),
			implementer: config.live.claude ? "claude" : null,
			reviewer: config.live.codex ? "codex" : null,
		},
	};
}
