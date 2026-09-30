// Managed-run orchestrator: one worker, one task at a time.
//
//   queued → (validate approval + repo, allocate worktree) → executing
//   executing / repairing → implement → candidate commit → verifying
//   verifying → trusted verification commands → evidence manifest → reviewing | repairing | stop
//   reviewing → reviewer verdict, validated against the exact candidate → human_ready | repairing | stop
//
// Durability rules:
//   - All state lives in SQLite. Each step re-reads the task and continues from its state, so a
//     restart resumes where the rows say, not where memory said.
//   - Every write is fenced (store.withFence). A worker that lost its lease writes nothing.
//   - Launch intent (`proc_phase`) is persisted BEFORE an implementer/reviewer is invoked. After a
//     crash, an attempt with a launched model stage is never re-run automatically: it becomes
//     `unknown` and the task `interrupted` (reconcile()).
//   - Cancel is a persisted intent; the task is `cancelled` only once the child group is gone.
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	EvidenceManifest,
	type FailureKind,
	type Finding,
	type ManagedRun,
	type ManagedTask,
	outcomeStateFor,
	REVIEW_CONTRACT,
	ReviewOutput,
	redact,
	verificationPassed,
} from "@agent-city/schema";
import type {
	AdapterContext,
	AdapterSet,
	ProviderMeta,
} from "./adapters/types.ts";
import { findRepo, type ManagedConfig, sha256Hex } from "./config.ts";
import {
	buildManifest,
	readArtifact,
	redactLog,
	runVerification,
	type VerificationRun,
	writeArtifact,
} from "./evidence.ts";
import {
	addWorktree,
	captureCandidate,
	changedFiles,
	diffText,
	GitError,
	mutationSince,
	outOfScope,
	resolveCommit,
	treeOf,
	validateRepo,
} from "./git.ts";
import { runProcess, terminateRecorded } from "./proc.ts";
import { approvalHashFor, gitCtx, liveConfigured } from "./service.ts";
import {
	claimNext,
	expiredLeases,
	getRun,
	getTask,
	insertReview,
	insertRun,
	listArtifacts,
	listRuns,
	patchRun,
	releaseForRetry,
	renewLease,
	repairsUsed,
	StaleLeaseError,
	seize,
	setTaskState,
	withFence,
} from "./store.ts";

export interface OrchestratorDeps {
	db: Database;
	config: ManagedConfig;
	adapters: AdapterSet;
	workerId?: string;
	now?: () => Date;
	/** Lease renewal + cancel polling interval. Default: a third of the lease TTL. */
	heartbeatMs?: number;
	onChange?: (taskId: string) => void;
}

/** One claimed task as seen by the worker that holds it. */
interface Claim {
	id: string;
	fence: number;
	signal: AbortSignal;
	/** Children whose process group could not be confirmed gone. */
	unconfirmed: number[];
}

const PROC_CLEARED = {
	proc_phase: null,
	proc_started_at: null,
	child_pid: null,
	child_started: null,
} as const;

const metaPatch = (m: ProviderMeta) => ({
	session_ref: m.session_ref,
	model_resolved: m.model_resolved,
	usage: m.usage,
});

export class Orchestrator {
	readonly workerId: string;
	private current: AbortController | null = null;
	private running: Promise<void> | null = null;

	constructor(private readonly d: OrchestratorDeps) {
		this.workerId = d.workerId ?? `worker-${randomUUID()}`;
	}

	private now(): string {
		return (this.d.now?.() ?? new Date()).toISOString();
	}

	private leaseUntil(): string {
		const base = this.d.now?.() ?? new Date();
		return new Date(
			base.getTime() + this.d.config.limits.lease_ttl_ms,
		).toISOString();
	}

	private get git() {
		return gitCtx(this.d.config);
	}

	private changed(id: string): void {
		try {
			this.d.onChange?.(id);
		} catch {
			// a broadcast failure is not a task failure
		}
	}

	/** Reconcile dead leases, then claim and drive at most one task. true = a task was worked on. */
	async tick(): Promise<boolean> {
		await this.reconcile();
		const task = claimNext(this.d.db, this.workerId, this.leaseUntil());
		if (!task) return false;
		this.changed(task.id);
		this.running = this.runTask(task);
		try {
			await this.running;
		} finally {
			this.running = null;
		}
		return true;
	}

	/** Stop working: abort the current child (if any) and wait. State is left for reconciliation. */
	async shutdown(): Promise<void> {
		this.current?.abort();
		await this.running?.catch(() => {});
	}

	// ── reconciliation ─────────────────────────────────────────────────────────

	/**
	 * Tasks whose lease expired belong to a worker that is gone. Stop whatever it left running (only
	 * if the recorded pid still is that process), then either release the task for a bounded retry
	 * (nothing model-backed was launched) or mark it interrupted. Never relaunches a model stage.
	 */
	async reconcile(): Promise<void> {
		const { db, config } = this.d;
		for (const stale of expiredLeases(db, this.now())) {
			// Fence first: from here the old worker (if it is somehow still alive) can write nothing.
			const seized = seize(db, stale, this.workerId, this.leaseUntil());
			if (!seized) continue;
			const run = seized.current_run_id
				? getRun(db, seized.current_run_id)
				: null;
			const term =
				run?.child_pid != null
					? await terminateRecorded(
							{ pid: run.child_pid, started: run.child_started },
							config.limits.kill_grace_ms,
						)
					: "gone";
			const launched =
				run?.proc_phase === "implement" || run?.proc_phase === "review";
			const at = this.now();
			try {
				withFence(db, seized.id, seized.fence_token, (task) => {
					const endRun = (state: "cancelled" | "unknown", detail: string) => {
						if (run && run.state === "running")
							patchRun(db, run.id, {
								state,
								failure_kind:
									state === "cancelled" ? "cancelled" : "interrupted",
								failure_detail: detail,
								ended_at: at,
								...(term === "unconfirmed" ? {} : PROC_CLEARED),
							});
					};
					const stop = (detail: string) => {
						endRun("unknown", detail);
						const queued = task.state === "queued";
						setTaskState(db, task, {
							to: queued ? "blocked" : "interrupted",
							failure_kind: queued ? "workspace_error" : "interrupted",
							state_detail: detail,
							release: true,
						});
					};
					if (task.cancel_requested_at && term !== "unconfirmed") {
						endRun("cancelled", "cancelled while no worker held the task");
						setTaskState(db, task, {
							to: "cancelled",
							failure_kind: "cancelled",
							state_detail: "cancelled; no owned process is running",
							release: true,
						});
					} else if (term === "unconfirmed")
						stop(
							`the hub stopped and process ${run?.child_pid} could not be confirmed terminated`,
						);
					else if (launched)
						stop(
							`the hub stopped while the ${run?.proc_phase} stage of attempt ${run?.attempt_no} was running; its result is unknown and it is not re-run automatically`,
						);
					else if (task.infra_retries >= config.limits.max_infra_retries)
						stop(
							`gave up after ${task.infra_retries} automatic retries of the ${task.state} step`,
						);
					else {
						// No model stage was launched: safe to resume this step. Bounded by infra_retries.
						if (run) patchRun(db, run.id, PROC_CLEARED);
						releaseForRetry(db, task);
					}
				});
			} catch (err) {
				if (!(err instanceof StaleLeaseError)) throw err;
			}
			this.changed(stale.id);
		}
	}

	// ── one claimed task ───────────────────────────────────────────────────────

	async runTask(claimed: ManagedTask): Promise<void> {
		const { db } = this.d;
		const ac = new AbortController();
		this.current = ac;
		const claim: Claim = {
			id: claimed.id,
			fence: claimed.fence_token,
			signal: ac.signal,
			unconfirmed: [],
		};
		const beat = setInterval(
			() => {
				try {
					if (!renewLease(db, claim.id, claim.fence, this.leaseUntil()))
						ac.abort();
					else if (getTask(db, claim.id)?.cancel_requested_at) ac.abort();
				} catch {
					ac.abort();
				}
			},
			this.d.heartbeatMs ??
				Math.max(50, Math.floor(this.d.config.limits.lease_ttl_ms / 3)),
		);
		try {
			for (;;) {
				const t = getTask(db, claim.id);
				if (
					!t ||
					t.fence_token !== claim.fence ||
					t.lease_owner !== this.workerId
				)
					return;
				if (t.cancel_requested_at) {
					this.finishCancel(t, claim);
					return;
				}
				// lease lost or shutdown: write nothing, reconciliation decides
				if (ac.signal.aborted) return;
				try {
					if (t.state === "queued") await this.start(t, claim);
					else if (t.state === "executing" || t.state === "repairing")
						await this.implement(t, claim);
					else if (t.state === "verifying") await this.verify(t, claim);
					else if (t.state === "reviewing") await this.review(t, claim);
					else return;
				} catch (err) {
					if (!(err instanceof GitError)) throw err;
					this.fail(
						t,
						claim,
						t.current_run_id,
						"workspace_error",
						`${err.message}${err.detail ? `: ${redact(err.detail)}` : ""}`,
					);
				}
			}
		} catch (err) {
			if (err instanceof StaleLeaseError) return;
			// Unexpected: record it (message only) unless the lease is gone too.
			try {
				const t = getTask(db, claim.id);
				if (t)
					this.fail(
						t,
						claim,
						t.current_run_id,
						"internal_error",
						redact((err as Error).message ?? "unknown error"),
					);
			} catch {
				// lease lost — nothing to write
			}
		} finally {
			clearInterval(beat);
			this.current = null;
		}
	}

	private currentRun(t: ManagedTask): ManagedRun {
		const run = t.current_run_id ? getRun(this.d.db, t.current_run_id) : null;
		if (!run) throw new Error(`task ${t.id} has no current run`);
		return run;
	}

	/** The adapter's view of the process boundary: owned, recorded, bounded, abortable. */
	private ctx(claim: Claim, run: ManagedRun): AdapterContext {
		const { db, config } = this.d;
		const scratchDir = join(config.artifacts_root, "_scratch", run.id);
		mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
		const record = (patch: Parameters<typeof patchRun>[2]) =>
			withFence(db, claim.id, claim.fence, () => patchRun(db, run.id, patch));
		return {
			signal: claim.signal,
			scratchDir,
			maxLogBytes: config.limits.max_log_bytes,
			run: async (o) => {
				const r = await runProcess({
					...o,
					maxOutputBytes: o.maxOutputBytes ?? config.limits.max_log_bytes,
					killGraceMs: config.limits.kill_grace_ms,
					signal: claim.signal,
					// Throws when the lease is gone → runProcess kills the child it just started.
					onSpawn: (id) =>
						record({ child_pid: id.pid, child_started: id.started }),
				});
				if (r.pid !== null) {
					if (!r.terminationConfirmed) claim.unconfirmed.push(r.pid);
					else
						try {
							record({ child_pid: null, child_started: null });
						} catch (err) {
							if (!(err instanceof StaleLeaseError)) throw err;
						}
				}
				return r;
			},
		};
	}

	/** Attempt over, not passed: run → failed, task → blocked (tool could not run) or failed. */
	private fail(
		t: ManagedTask,
		claim: Claim,
		runId: string | null,
		kind: FailureKind,
		detail: string,
		alsoWrite?: () => void,
	): void {
		const { db } = this.d;
		withFence(db, t.id, claim.fence, (fresh) => {
			alsoWrite?.();
			if (runId)
				patchRun(db, runId, {
					state: "failed",
					failure_kind: kind,
					failure_detail: detail.slice(0, 1000),
					ended_at: this.now(),
					...PROC_CLEARED,
				});
			setTaskState(db, fresh, {
				to: outcomeStateFor(kind),
				failure_kind: kind,
				state_detail: detail,
				release: true,
			});
		});
		this.changed(t.id);
	}

	private finishCancel(t: ManagedTask, claim: Claim): void {
		const { db } = this.d;
		const unconfirmed = claim.unconfirmed.length > 0;
		withFence(db, t.id, claim.fence, (fresh) => {
			const run = fresh.current_run_id
				? getRun(db, fresh.current_run_id)
				: null;
			const detail = unconfirmed
				? `cancel requested, but process ${claim.unconfirmed.join(", ")} could not be confirmed terminated`
				: "cancelled; owned processes confirmed terminated";
			if (run && run.state === "running")
				patchRun(db, run.id, {
					state: unconfirmed ? "unknown" : "cancelled",
					failure_kind: unconfirmed ? "interrupted" : "cancelled",
					failure_detail: detail,
					ended_at: this.now(),
					...(unconfirmed ? {} : PROC_CLEARED),
				});
			setTaskState(db, fresh, {
				to:
					unconfirmed && fresh.state !== "queued" ? "interrupted" : "cancelled",
				failure_kind:
					unconfirmed && fresh.state !== "queued" ? "interrupted" : "cancelled",
				state_detail: detail,
				release: true,
			});
		});
		this.changed(t.id);
	}

	// ── queued → executing ─────────────────────────────────────────────────────

	private async start(t: ManagedTask, claim: Claim): Promise<void> {
		const { db, config, adapters } = this.d;
		const repo = findRepo(config, t.repo_id);
		if (!repo)
			return this.fail(
				t,
				claim,
				null,
				"repo_invalid",
				"repository is no longer in the managed allowlist",
			);
		if (t.approval_hash !== approvalHashFor(t, config))
			return this.fail(
				t,
				claim,
				null,
				"approval_void",
				"the task or the managed policy changed after Run was approved; run it again to re-approve",
			);
		if (t.execution_mode === "live" && !liveConfigured(config))
			return this.fail(
				t,
				claim,
				null,
				"provider_unavailable",
				"live execution is disabled in the managed config",
			);
		const implementer = adapters.implementer(t.execution_mode);
		if (!implementer || !adapters.reviewer(t.execution_mode))
			return this.fail(
				t,
				claim,
				null,
				"provider_unavailable",
				`no ${t.execution_mode} implementer/reviewer adapter is configured`,
			);

		let repoPath: string;
		try {
			repoPath = await validateRepo(this.git, repo.path, [
				config.workspace_root,
				config.artifacts_root,
			]);
			await resolveCommit(this.git, repoPath, t.base_sha);
		} catch (err) {
			if (!(err instanceof GitError)) throw err;
			return this.fail(t, claim, null, "repo_invalid", err.message);
		}

		const prior = listRuns(db, t.id);
		const slot = `a${prior.length + 1}-${randomUUID().slice(0, 8)}`;
		const branch = `agentcity/${t.id}/${slot}`;
		const workspace = await addWorktree(
			this.git,
			repoPath,
			config.workspace_root,
			join(config.workspace_root, t.id, slot),
			branch,
			t.base_sha,
		);
		withFence(db, t.id, claim.fence, (fresh) => {
			const run = insertRun(db, {
				task: fresh,
				kind: prior.length === 0 ? "initial" : "rerun",
				parent_run_id: null,
				repair_input: null,
				workspace_path: workspace,
				branch,
				parent_sha: fresh.base_sha,
				provider: implementer.provider,
				mode: implementer.mode,
				model_requested: implementer.model_requested,
				now: this.now(),
			});
			setTaskState(db, fresh, { to: "executing", current_run_id: run.id });
		});
		this.changed(t.id);
	}

	// ── implement ──────────────────────────────────────────────────────────────

	private async implement(t: ManagedTask, claim: Claim): Promise<void> {
		const { db, config, adapters } = this.d;
		const run = this.currentRun(t);
		const adapter = adapters.implementer(t.execution_mode);
		if (!adapter || !run.workspace_path || !run.parent_sha)
			return this.fail(
				t,
				claim,
				run.id,
				"provider_unavailable",
				"no implementer adapter or workspace for this attempt",
			);
		const worktree = run.workspace_path;

		// One writer per worktree: it must be exactly where this attempt starts from.
		const dirty = await mutationSince(this.git, worktree, run.parent_sha);
		if (dirty)
			return this.fail(
				t,
				claim,
				run.id,
				"candidate_mutated",
				`workspace is not at the attempt's starting commit (${dirty})`,
			);

		const ctx = this.ctx(claim, run);
		const pre = await adapter.preflight(ctx);
		if (claim.signal.aborted) return;
		if (!pre.ok)
			return this.fail(
				t,
				claim,
				run.id,
				pre.kind ?? "provider_unavailable",
				pre.detail,
			);

		// Launch intent first: after a crash this attempt is never re-run automatically.
		withFence(db, t.id, claim.fence, () =>
			patchRun(db, run.id, {
				proc_phase: "implement",
				proc_started_at: this.now(),
			}),
		);
		const parent = run.parent_run_id ? getRun(db, run.parent_run_id) : null;
		const res = await adapter.implement(
			{
				task: t,
				run,
				worktree,
				resumeSession:
					run.kind === "repair" ? (parent?.session_ref ?? null) : null,
			},
			ctx,
		);
		if (claim.signal.aborted) return;

		const log = (candidate: string | null) =>
			writeArtifact(db, config.artifacts_root, {
				task_id: t.id,
				run_id: run.id,
				kind: "implementation_log",
				name: "implementation.log",
				content: redactLog(res.log),
				truncated: res.logTruncated,
				candidate_sha: candidate,
				now: this.now(),
			});
		const record = (candidate: string | null) => () => {
			log(candidate);
			patchRun(db, run.id, { ...metaPatch(res), candidate_sha: candidate });
		};

		if (!res.ok)
			return this.fail(t, claim, run.id, res.kind, res.detail, record(null));
		if (res.output.status === "blocked")
			return this.fail(
				t,
				claim,
				run.id,
				"provider_error",
				`implementer reported it was blocked: ${redact(res.output.summary)}`,
				record(null),
			);

		const candidate = await captureCandidate(
			this.git,
			worktree,
			`agent-city candidate: ${t.id} attempt ${run.attempt_no}`,
		);
		if (candidate === run.parent_sha)
			return this.fail(
				t,
				claim,
				run.id,
				"no_changes",
				"the implementer finished without changing the workspace",
				record(null),
			);
		const stray = outOfScope(
			await changedFiles(this.git, worktree, t.base_sha, candidate),
			t.approved_scope,
		);
		if (stray.length > 0)
			return this.fail(
				t,
				claim,
				run.id,
				"scope_violation",
				`changed paths outside the approved scope: ${stray.slice(0, 5).join(", ")}${stray.length > 5 ? ` (+${stray.length - 5} more)` : ""}`,
				record(candidate),
			);

		withFence(db, t.id, claim.fence, (fresh) => {
			record(candidate)();
			patchRun(db, run.id, { phase: "verify", ...PROC_CLEARED });
			setTaskState(db, fresh, { to: "verifying" });
		});
		this.changed(t.id);
	}

	// ── verify ─────────────────────────────────────────────────────────────────

	private async verify(t: ManagedTask, claim: Claim): Promise<void> {
		const { db, config } = this.d;
		const run = this.currentRun(t);
		const repo = findRepo(config, t.repo_id);
		const candidate = run.candidate_sha;
		if (!repo || !run.workspace_path || !candidate || !run.parent_sha)
			return this.fail(
				t,
				claim,
				run.id,
				"repo_invalid",
				"no repository config or candidate for this attempt",
			);
		const worktree = run.workspace_path;

		const before = await mutationSince(this.git, worktree, candidate);
		if (before)
			return this.fail(
				t,
				claim,
				run.id,
				"candidate_mutated",
				`the workspace changed after the candidate was captured (${before})`,
			);
		if (repo.verification.length === 0)
			return this.fail(
				t,
				claim,
				run.id,
				"verification_missing",
				`no verification commands are configured for ${repo.id}; a candidate cannot become human-ready without verification`,
			);

		withFence(db, t.id, claim.fence, () =>
			patchRun(db, run.id, {
				proc_phase: "verify",
				proc_started_at: this.now(),
			}),
		);
		const ctx = this.ctx(claim, run);
		const runs: VerificationRun[] = [];
		for (const cmd of repo.verification) {
			if (claim.signal.aborted) return;
			runs.push(await runVerification(cmd, worktree, ctx.run));
		}
		if (claim.signal.aborted) return;

		const after = await mutationSince(this.git, worktree, candidate);
		const diff = await diffText(
			this.git,
			worktree,
			t.base_sha,
			candidate,
			config.limits.max_diff_bytes,
		);
		const diffStored = redactLog(diff.text);
		const files = await changedFiles(this.git, worktree, t.base_sha, candidate);
		const results = runs.map((r) => r.result);
		const { json, hash } = buildManifest({
			task_id: t.id,
			run_id: run.id,
			attempt_no: run.attempt_no,
			base_sha: t.base_sha,
			parent_sha: run.parent_sha,
			candidate_sha: candidate,
			candidate_tree: await treeOf(this.git, worktree, candidate),
			changed_files: files,
			diff_sha256: sha256Hex(diffStored),
			diff_truncated: diff.truncated,
			verification: results,
		});

		const store = () => {
			const base = {
				task_id: t.id,
				run_id: run.id,
				candidate_sha: candidate,
				now: this.now(),
			};
			writeArtifact(db, config.artifacts_root, {
				...base,
				kind: "diff",
				name: "diff.patch",
				content: diffStored,
				truncated: diff.truncated,
			});
			writeArtifact(db, config.artifacts_root, {
				...base,
				kind: "changed_files",
				name: "changed-files.json",
				content: JSON.stringify(files, null, 2),
			});
			runs.forEach((r, i) => {
				writeArtifact(db, config.artifacts_root, {
					...base,
					kind: "verification_log",
					name: `verify-${i + 1}-${r.result.name}.log`,
					content: r.log,
					truncated: r.result.log_truncated,
					meta: { ...r.result },
				});
			});
			writeArtifact(db, config.artifacts_root, {
				...base,
				kind: "manifest",
				name: "manifest.json",
				content: json,
			});
			patchRun(db, run.id, { manifest_hash: hash });
		};

		if (after)
			return this.fail(
				t,
				claim,
				run.id,
				"candidate_mutated",
				`verification changed the workspace (${after}); the evidence no longer describes the candidate`,
				store,
			);
		const incomplete = results.filter((r) => !r.completed);
		if (incomplete.length > 0)
			return this.fail(
				t,
				claim,
				run.id,
				"verification_unavailable",
				`verification did not run to completion: ${incomplete.map((r) => `${r.name}${r.timed_out ? " (timed out)" : ""}`).join(", ")}`,
				store,
			);

		if (!verificationPassed(results)) {
			const failed = runs.filter((r) => r.result.exit_code !== 0);
			const findings: Finding[] = failed.map((r) => ({
				severity: "major",
				title: `Verification "${r.result.name}" failed (exit ${r.result.exit_code})`,
				detail: r.log.slice(-1500),
				file: null,
				line: null,
				actionable: true,
			}));
			if (this.repairsLeft(t))
				return this.startRepair(t, claim, run, findings, store);
			return this.fail(
				t,
				claim,
				run.id,
				"verification_failed",
				`verification failed: ${failed.map((r) => r.result.name).join(", ")} (repair limit ${t.repair_limit} reached)`,
				store,
			);
		}

		withFence(db, t.id, claim.fence, (fresh) => {
			store();
			patchRun(db, run.id, { phase: "review", ...PROC_CLEARED });
			setTaskState(db, fresh, { to: "reviewing" });
		});
		this.changed(t.id);
	}

	private repairsLeft(t: ManagedTask): boolean {
		return repairsUsed(this.d.db, t.id) < t.repair_limit;
	}

	/** Close this attempt as rejected and open a repair attempt on the same workspace. */
	private startRepair(
		t: ManagedTask,
		claim: Claim,
		run: ManagedRun,
		findings: Finding[],
		alsoWrite: () => void,
	): void {
		const { db, adapters } = this.d;
		const implementer = adapters.implementer(t.execution_mode);
		withFence(db, t.id, claim.fence, (fresh) => {
			alsoWrite();
			patchRun(db, run.id, {
				state: "finished",
				phase: "done",
				outcome: "rejected",
				ended_at: this.now(),
				...PROC_CLEARED,
			});
			const next = insertRun(db, {
				task: fresh,
				kind: "repair",
				parent_run_id: run.id,
				repair_input: findings,
				workspace_path: run.workspace_path,
				branch: run.branch,
				parent_sha: run.candidate_sha,
				provider: implementer?.provider ?? run.provider,
				mode: run.mode,
				model_requested: implementer?.model_requested ?? run.model_requested,
				now: this.now(),
			});
			setTaskState(db, fresh, { to: "repairing", current_run_id: next.id });
		});
		this.changed(t.id);
	}

	// ── review ─────────────────────────────────────────────────────────────────

	private async review(t: ManagedTask, claim: Claim): Promise<void> {
		const { db, config, adapters } = this.d;
		const run = this.currentRun(t);
		const candidate = run.candidate_sha;
		const manifestHash = run.manifest_hash;
		const reviewer = adapters.reviewer(t.execution_mode);
		if (!reviewer || !run.workspace_path || !candidate || !manifestHash)
			return this.fail(
				t,
				claim,
				run.id,
				"provider_unavailable",
				"no reviewer adapter or evidence for this attempt",
			);
		const worktree = run.workspace_path;

		// The evidence on disk must still be the evidence that was hashed.
		const stored = listArtifacts(db, t.id).filter((a) => a.run_id === run.id);
		const manifestArt = stored.find((a) => a.name === "manifest.json");
		const diffArt = stored.find((a) => a.name === "diff.patch");
		const manifestText = manifestArt
			? readArtifact(config.artifacts_root, manifestArt, 8_000_000).text
			: "";
		const manifest = EvidenceManifest.safeParse(
			manifestText ? JSON.parse(manifestText) : null,
		);
		if (
			!manifest.success ||
			!diffArt ||
			sha256Hex(manifestText) !== manifestHash ||
			manifest.data.candidate_sha !== candidate ||
			!verificationPassed(manifest.data.verification)
		)
			return this.fail(
				t,
				claim,
				run.id,
				"candidate_mutated",
				"the stored evidence does not match the candidate that was verified",
			);
		const before = await mutationSince(this.git, worktree, candidate);
		if (before)
			return this.fail(
				t,
				claim,
				run.id,
				"candidate_mutated",
				`the workspace changed after verification (${before})`,
			);

		const ctx = this.ctx(claim, run);
		const pre = await reviewer.preflight(ctx);
		if (claim.signal.aborted) return;
		if (!pre.ok)
			return this.fail(
				t,
				claim,
				run.id,
				pre.kind ?? "provider_unavailable",
				pre.detail,
			);

		withFence(db, t.id, claim.fence, () =>
			patchRun(db, run.id, {
				proc_phase: "review",
				proc_started_at: this.now(),
			}),
		);
		const res = await reviewer.review(
			{
				task: t,
				run,
				worktree,
				candidate_sha: candidate,
				manifest_hash: manifestHash,
				manifest: manifest.data,
				diff: readArtifact(
					config.artifacts_root,
					diffArt,
					config.limits.max_diff_bytes,
				).text,
			},
			ctx,
		);
		if (claim.signal.aborted) return;
		const after = await mutationSince(this.git, worktree, candidate);

		const parsed = res.ok ? ReviewOutput.safeParse(res.raw) : null;
		const output = parsed?.success ? parsed.data : null;
		const findings: Finding[] = (output?.findings ?? []).map((f) => ({
			...f,
			title: redact(f.title),
			detail: redact(f.detail),
			file: f.file === null ? null : redact(f.file),
		}));

		// A verdict counts only if it has the contract's shape AND names this exact candidate and
		// evidence AND the reviewer left the workspace alone.
		let invalid: string | null = null;
		if (!res.ok) invalid = `reviewer did not produce a verdict: ${res.detail}`;
		else if (!parsed?.success)
			invalid = `review output does not match ${REVIEW_CONTRACT}: ${parsed?.error.issues
				.slice(0, 3)
				.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
				.join("; ")}`;
		else if (output?.audited_sha !== candidate)
			invalid = "the review names a different commit than the candidate";
		else if (output.manifest_hash !== manifestHash)
			invalid = "the review names a different evidence manifest";
		else if (
			output.verdict === "approve" &&
			findings.some((f) => f.severity === "blocker" || f.severity === "major")
		)
			invalid = "an approval cannot carry blocker/major findings";
		if (after) invalid = `the reviewer changed the workspace (${after})`;

		const record = () => {
			const base = {
				task_id: t.id,
				run_id: run.id,
				candidate_sha: candidate,
				now: this.now(),
			};
			writeArtifact(db, config.artifacts_root, {
				...base,
				kind: "review_log",
				name: "review.log",
				content: redactLog(res.log),
				truncated: res.logTruncated,
			});
			if (res.ok)
				writeArtifact(db, config.artifacts_root, {
					...base,
					kind: "review_output",
					name: "review-output.json",
					content: redactLog(
						(JSON.stringify(res.raw, null, 2) ?? "null").slice(
							0,
							config.limits.max_log_bytes,
						),
					),
				});
			insertReview(db, {
				task_id: t.id,
				run_id: run.id,
				provider: reviewer.provider,
				mode: reviewer.mode,
				model_requested: reviewer.model_requested,
				model_resolved: res.model_resolved,
				session_ref: res.session_ref,
				candidate_sha: candidate,
				manifest_hash: manifestHash,
				verdict: output?.verdict ?? null,
				valid: invalid === null,
				invalidated_reason: invalid,
				findings,
				summary: output ? redact(output.summary) : null,
				usage: res.usage,
				created_at: this.now(),
			});
		};

		if (after)
			return this.fail(
				t,
				claim,
				run.id,
				"candidate_mutated",
				invalid ?? "",
				record,
			);
		if (!res.ok)
			return this.fail(t, claim, run.id, res.kind, res.detail, record);
		if (invalid !== null || !output)
			return this.fail(
				t,
				claim,
				run.id,
				"review_invalid",
				invalid ?? "invalid review",
				record,
			);

		if (output.verdict === "approve") {
			withFence(db, t.id, claim.fence, (fresh) => {
				record();
				patchRun(db, run.id, {
					state: "finished",
					phase: "done",
					outcome: "approved",
					ended_at: this.now(),
					...PROC_CLEARED,
				});
				setTaskState(db, fresh, {
					to: "human_ready",
					result_run_id: run.id,
					state_detail:
						fresh.execution_mode === "simulated"
							? "simulated result: fake adapters, no model implemented or reviewed this"
							: "verified and reviewed; waiting for a person",
					release: true,
				});
			});
			this.changed(t.id);
			return;
		}

		const actionable = findings.filter((f) => f.actionable);
		if (actionable.length === 0)
			return this.fail(
				t,
				claim,
				run.id,
				"review_rejected",
				"the reviewer rejected the candidate without actionable findings",
				record,
			);
		if (this.repairsLeft(t))
			return this.startRepair(t, claim, run, actionable, record);
		return this.fail(
			t,
			claim,
			run.id,
			t.repair_limit === 0 ? "review_rejected" : "repair_limit_exhausted",
			`the reviewer rejected the candidate and the repair limit (${t.repair_limit}) is used up`,
			record,
		);
	}
}
