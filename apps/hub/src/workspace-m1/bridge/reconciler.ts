// Engine → workspace reconciliation (M1 L6, INTERFACE §6 engine/rec rows). One serialized job queue
// fed by `notify(managed_task_id)` (orchestrator `onChange`, bridge port calls) and `sweep()`
// (startup + periodic). Every job re-derives its decision from durable rows inside ONE
// `store.transaction` (consistent snapshot; no false violations from a commit landing between two
// reads); only sealing runs outside a transaction, and its outcome is re-checked inside the commit
// transaction. Nothing here starts work: the only managed writes are `requestCancel` (intent, never
// authority) and 02's `releaseReserved` of a draft reservation. Restart-safe: a crash between steps
// leaves rows from which the next sweep derives the same outcome (UNIQUE result request per run).
//
// Obsolete v1 execution grants (decisions/decision-service.ts header): the policy sweep invalidates a
// pending Gate 1 of a non-v1.2 proposal first (same reason / detail / stage detail as the decision
// path) and releases its reservation; an approved v1 execution still queued or active gets its cancel
// intent recorded (requestCancel — intent only; the workspace shows `cancelled` only once the engine
// confirms termination) while `authorize` refuses every further stage. A v1 execution that already
// reached human_ready is sealed as before (recorded invalidated, LEGACY_PROPOSAL_DETAIL).
import type { Database } from "bun:sqlite";
import type { ManagedTask, TaskState } from "@agent-city/schema";
import {
	type ApprovalRequestRow,
	canTransitionWorkspace,
	type EvidenceBundleRow,
	type EvidenceSealer,
	type ExecutionBridge,
	engineStageEffect,
	type InvalidationReason,
	type SealedResult,
	type SealInput,
	stageAfterSealing,
	type WorkspaceStage,
	type WorkspaceTaskRow,
	type WorkspaceTrigger,
} from "@agent-city/schema/workspace-m1";
import {
	hashesEqual,
	newWorkspaceId,
	sealResultApprovalBinding,
} from "@agent-city/schema/workspace-m1/hash";
import {
	findRepo,
	type ManagedConfig,
	policyHash,
	type RepoConfig,
} from "../../managed/config.ts";
import { GitError, resolveCommit, validateRepo } from "../../managed/git.ts";
import { gitCtx } from "../../managed/service.ts";
import {
	getTask,
	listTasks,
	openQuarantineFor,
	requestCancel,
} from "../../managed/store.ts";
import {
	isObsoleteExecutionProposal,
	OBSOLETE_V1_GRANT_DETAIL,
	OBSOLETE_V1_GRANT_REASON,
	OBSOLETE_V1_GRANT_STAGE_DETAIL,
} from "../decisions/decision-service.ts";
import { scrubDetail, TRANSIENT_SEAL_ERRORS } from "../decisions/index.ts";
import {
	BundleError,
	DURABLE_SEAL_FAILED_DETAIL,
	LEGACY_PROPOSAL_DETAIL,
	LEGACY_RESULT_DETAIL,
	type PublishFaults,
	publishSealedEvidence,
} from "../evidence/bundle.ts";
import type { GitRunner } from "../evidence/context-loader.ts";
import { SealError } from "../evidence/run-evidence.ts";
import {
	checkAcceptance,
	recordAcceptanceVerdict,
	subjectOf,
} from "../evidence/validity.ts";
import {
	type PersistentWorkspaceStore,
	type PersistentWorkspaceTx,
	WorkspaceConflictError,
	WorkspaceTxError,
} from "../persistence/index.ts";
import { AUTHORIZED_STAGES, evaluateAuthorization } from "./authorize.ts";

// ── alarms ──────────────────────────────────────────────────────────────────

export type AlarmKind =
	/** A workspace/engine pairing the workspace never authorized (§6 violation rule). */
	| "violation"
	/** A queued/active managed task with no workspace Gate-1 request (legacy / DB-seeded). */
	| "ungoverned_execution"
	/** Sealing at human_ready failed (transient: retried; permanent: execution_ended). */
	| "seal_failed"
	/** A reconcile job threw; it is retried by the next notify / sweep. */
	| "reconcile_error"
	/** The policy/base sweep could not judge or invalidate a pending Gate-1 request. */
	| "policy_sweep_error"
	/** v1.2 §C: an accepted result is no longer backed by what was accepted (validity → invalid). */
	| "acceptance_invalid"
	/** v1.2 §C: an accepted-result re-check could not be run or recorded (retried next sweep). */
	| "acceptance_check_error";

export interface BridgeAlarm {
	kind: AlarmKind;
	managed_task_id: string | null;
	workspace_task_id: string | null;
	/** Fixed text + enum values only (scrubbed); never row content, paths or hashes. */
	detail: string;
	at: string;
}

/** Test-only boundaries (awaited). Never set in production. */
export interface BridgeHooks {
	/** After sealing (outside any transaction), before the Gate-2 commit transaction. */
	beforeSealCommit?(managed_task_id: string): Promise<void> | void;
	/** After judging a pending Gate-1 request stale, before its invalidation transaction. */
	beforeInvalidate?(approval_request_id: string): Promise<void> | void;
	/** Fault points inside the durable-bundle publication (v1.2 §B). */
	publishFaults?: PublishFaults;
}

/** Result of the trusted base check of a pending Gate-1 request (async git, outside any tx). */
export type BaseCheck =
	| "ok"
	/** The trusted base ref now resolves to another commit than the proposal's base_sha. */
	| "moved"
	/** The proposal's base_sha is no longer a commit of the repository. */
	| "unresolvable"
	/** The configured path is not a usable git checkout. */
	| "repo_unavailable"
	/** Could not tell (unexpected failure): no write. */
	| "error";

export interface ReconcilerDeps {
	db: Database;
	store: PersistentWorkspaceStore;
	/** MUST be the orchestrator's frozen config object (policy_hash source). */
	config: ManagedConfig;
	sealer: EvidenceSealer;
	/** The port's releaseReserved (02 managed write; runs inside our transaction). */
	releaseReserved: ExecutionBridge["releaseReserved"];
	now: () => Date;
	alarm: (a: BridgeAlarm) => void;
	/** Managed task ids found in violation; `authorize` denies them (shared set). */
	flagged: Set<string>;
	checkBase?: (repo: RepoConfig, base_sha: string) => Promise<BaseCheck>;
	/** Transient seal failures tolerated per execution before it is ended (default 3). */
	maxTransientSealFailures?: number;
	/** Read-only git runner for the accepted-result candidate check (default: hardened runner). */
	gitFor?: (cwd: string) => GitRunner;
	/** Accepted results re-checked per sweep, oldest check first (default 20). */
	maxAcceptedChecksPerSweep?: number;
	hooks?: BridgeHooks;
}

export interface SweepReport {
	/** Reconcile jobs queued for workspace executions. */
	tasks: number;
	/** Pending Gate-1 requests invalidated by this sweep. */
	invalidated: number;
	/** Legacy pending Gate-2 requests (no durable evidence bundle) invalidated by this sweep. */
	legacy_invalidated: number;
	/** Accepted results whose current validity was re-checked by this sweep. */
	accepted_checked: number;
	/** Of those, how many became invalid in this sweep. */
	accepted_invalid: number;
}

export interface Reconciler {
	notify(managed_task_id: string): void;
	sweep(): Promise<SweepReport>;
	/** Resolves when the queue is empty (tests, shutdown). */
	idle(): Promise<void>;
	/** Stop accepting work; resolves after the running job. Dropped jobs are re-derived by the next sweep. */
	stop(): Promise<void>;
}

// ── fixed texts ─────────────────────────────────────────────────────────────

const WORK_STATES: readonly TaskState[] = [
	"queued",
	"executing",
	"verifying",
	"reviewing",
	"repairing",
];

const MAX_STEPS = 8;

function stageDetail(
	trigger: WorkspaceTrigger,
	m: ManagedTask,
	/** The execution's proposal is an obsolete v1 proposal: a rerun is refused, guide to a new version. */
	obsolete = false,
): string {
	switch (trigger) {
		case "engine_started":
			return "the engine started the approved execution";
		case "engine_ended":
			return `the execution ended (${m.state}${m.failure_kind ? `: ${m.failure_kind}` : ""}); ${obsolete ? OBSOLETE_V1_GRANT_DETAIL : "a rerun needs a new Gate-1 approval"}`;
		case "engine_cancelled":
			return obsolete
				? `cancelled; the engine confirmed termination; ${OBSOLETE_V1_GRANT_DETAIL}`
				: "cancelled; the engine confirmed termination";
		case "cancel_won":
			return "cancelled: the cancel request won over the finished result; nothing is offered for acceptance";
		default:
			return trigger;
	}
}

class CasMiss extends Error {
	constructor() {
		super("CAS miss");
		this.name = "CasMiss";
	}
}

type Step =
	| { kind: "done" }
	| { kind: "again" }
	| { kind: "seal"; plan: SealPlan };

interface SealPlan {
	workspace_task_id: string;
	managed_task_id: string;
	run_id: string;
	input: SealInput;
}

const DONE: Step = { kind: "done" };
const AGAIN: Step = { kind: "again" };

export function defaultCheckBase(config: ManagedConfig) {
	return async (repo: RepoConfig, base_sha: string): Promise<BaseCheck> => {
		const git = gitCtx(config);
		const classify = (err: unknown, gitFailure: BaseCheck): BaseCheck =>
			err instanceof GitError ? gitFailure : "error";
		let path: string;
		try {
			path = await validateRepo(git, repo.path, [
				config.workspace_root,
				config.artifacts_root,
			]);
		} catch (err) {
			return classify(err, "repo_unavailable");
		}
		try {
			await resolveCommit(git, path, base_sha);
		} catch (err) {
			return classify(err, "unresolvable");
		}
		try {
			const head = await resolveCommit(git, path, repo.base_ref);
			return head === base_sha ? "ok" : "moved";
		} catch (err) {
			return classify(err, "repo_unavailable");
		}
	};
}

// ── the reconciler ──────────────────────────────────────────────────────────

export function createReconciler(deps: ReconcilerDeps): Reconciler {
	const { db, store, config, sealer } = deps;
	const checkBase = deps.checkBase ?? defaultCheckBase(config);
	const maxTransient = deps.maxTransientSealFailures ?? 3;
	const nowIso = () => deps.now().toISOString();

	const jobs = new Map<string, () => Promise<void>>();
	const transient = new Map<string, number>();
	const raised = new Set<string>();
	let draining: Promise<void> | null = null;
	let stopped = false;
	let sweepSeq = 0;
	const waiters = new Set<() => void>();

	const raise = (
		kind: AlarmKind,
		managed_task_id: string | null,
		workspace_task_id: string | null,
		detail: string,
	) => {
		// one alarm per distinct condition per process (sweeps repeat; the condition is durable)
		const key = `${kind}|${managed_task_id}|${workspace_task_id}|${detail}`;
		if (raised.has(key)) return;
		if (raised.size > 10_000) raised.clear();
		raised.add(key);
		try {
			deps.alarm({
				kind,
				managed_task_id,
				workspace_task_id,
				detail: scrubDetail(detail),
				at: nowIso(),
			});
		} catch {
			// an alarm sink failure must not stop reconciliation
		}
	};

	const errorText = (err: unknown) =>
		scrubDetail(
			err instanceof Error ? `${err.name}: ${err.message}` : "unknown error",
		).slice(0, 300);

	// ── queue ────────────────────────────────────────────────────────────────

	const schedule = () => {
		if (draining || stopped || jobs.size === 0) return;
		// Deferred: notify() may be called inside a caller's transaction (04's decision / cancel tx,
		// orchestrator callbacks); the first job runs only after that synchronous stack is done.
		draining = new Promise<void>((r) => queueMicrotask(r))
			.then(drain)
			.finally(() => {
				draining = null;
				schedule();
			});
	};

	const drain = async () => {
		while (!stopped) {
			const next = jobs.entries().next();
			if (next.done) return;
			const [key, run] = next.value;
			jobs.delete(key);
			try {
				await run();
			} catch (err) {
				if (err instanceof WorkspaceTxError) {
					// a transaction was open on the handle: retry this job shortly
					setTimeout(() => enqueue(key, run), 25);
					continue;
				}
				raise("reconcile_error", key, null, errorText(err));
			}
		}
	};

	const enqueue = (key: string, run: () => Promise<void>) => {
		if (stopped) return;
		jobs.set(key, run);
		schedule();
	};

	const notify = (managed_task_id: string) => {
		try {
			if (typeof managed_task_id !== "string" || managed_task_id.length === 0)
				return;
			enqueue(`task:${managed_task_id}`, () => reconcileTask(managed_task_id));
		} catch {
			// never throw into the orchestrator / the caller's transaction
		}
	};

	// ── one execution ────────────────────────────────────────────────────────

	async function reconcileTask(id: string): Promise<void> {
		for (let step = 0; step < MAX_STEPS; step++) {
			let s: Step;
			try {
				s = store.transaction((tx) => evaluate(tx, id));
			} catch (err) {
				if (err instanceof CasMiss) continue; // a concurrent writer: re-derive
				throw err;
			}
			if (s.kind === "done") return;
			if (s.kind === "seal" && !(await sealAndCommit(s.plan))) return;
		}
		raise(
			"reconcile_error",
			id,
			null,
			"reconciliation did not settle within its step bound",
		);
	}

	function move(
		tx: PersistentWorkspaceTx,
		ws: WorkspaceTaskRow,
		to: WorkspaceStage,
		trigger: WorkspaceTrigger,
		detail: string,
	): Step {
		if (!canTransitionWorkspace(ws.stage, to, trigger, "reconciler"))
			throw new Error(`no ${trigger} transition ${ws.stage} → ${to}`);
		const r = tx.updateTask(
			ws.id,
			ws.rev,
			{ stage: to, stage_detail: detail.slice(0, 1000) },
			nowIso(),
		);
		if (!r) throw new CasMiss();
		return AGAIN;
	}

	function evaluate(tx: PersistentWorkspaceTx, id: string): Step {
		const managed = getTask(db, id);
		if (!managed) return DONE;
		const ws = tx.findTaskByManagedTask(id);
		if (!ws) {
			// not the current execution of any workspace task: it must not be doing work
			if (WORK_STATES.includes(managed.state)) {
				const req = tx.findRunRequestForManagedTask(id);
				deps.flagged.add(id);
				if (req)
					raise(
						"violation",
						id,
						req.workspace_task_id,
						`a superseded execution is ${managed.state}`,
					);
				else
					raise(
						"ungoverned_execution",
						id,
						null,
						`an execution without a workspace Gate-1 request is ${managed.state}`,
					);
			}
			return DONE;
		}

		const effect = engineStageEffect(ws.stage, {
			state: managed.state,
			cancel_requested: managed.cancel_requested_at !== null,
			quarantined: openQuarantineFor(db, id).length > 0,
		});

		let obsolete = false;
		if (AUTHORIZED_STAGES.includes(ws.stage)) {
			// structural check (policy excluded: a policy change of queued work is the engine's
			// approval_void, not a violation)
			const auth = evaluateAuthorization(tx, config, managed, {
				policy: false,
			});
			if (auth.ok)
				obsolete = isObsoleteExecutionProposal(auth.proposal.snapshot);
			if (!auth.ok) {
				deps.flagged.add(id);
				raise(
					"violation",
					id,
					ws.id,
					`the ${ws.stage} execution is not covered by its Gate-1 decision (${auth.cls})`,
				);
				// never offer an unauthorized result: the execution ended without one
				if (effect.kind === "seal_result")
					return move(
						tx,
						ws,
						"execution_ended",
						"result_unavailable",
						"the execution is not covered by its Gate-1 decision; nothing is offered for acceptance",
					);
			} else if (effect.kind === "seal_result") {
				const run_id = managed.result_run_id;
				if (!run_id)
					return move(
						tx,
						ws,
						"execution_ended",
						"result_unavailable",
						"the engine reported human_ready without a result attempt; nothing is offered for acceptance",
					);
				if (tx.findResultRequestForRun(run_id)) {
					raise(
						"violation",
						id,
						ws.id,
						"a result request exists but the workspace stage did not move",
					);
					return DONE;
				}
				return {
					kind: "seal",
					plan: {
						workspace_task_id: ws.id,
						managed_task_id: id,
						run_id,
						input: {
							workspace_task_id: ws.id,
							proposal: auth.proposal.snapshot,
							proposal_hash: auth.proposal.proposal_hash,
							execution_binding: auth.request.execution_binding,
							execution_binding_hash: auth.request.execution_binding_hash,
							run_decision_id: auth.decision.id,
							managed_task_id: id,
							run_id,
						},
					},
				};
			} else if (
				obsolete &&
				WORK_STATES.includes(managed.state) &&
				managed.cancel_requested_at === null
			) {
				// an approved v1 grant still queued / active: `authorize` refuses every further stage;
				// record the cancel intent so an active stage is stopped through the engine's own cancel
				// path (queued + unleased → cancelled now; leased / active → the engine confirms
				// termination or quarantines — the workspace never claims more than the engine confirms)
				requestCancel(db, id, nowIso());
				return AGAIN;
			}
		}

		switch (effect.kind) {
			case "none":
			case "seal_result":
				return DONE;
			case "transition":
				return move(
					tx,
					ws,
					effect.to,
					effect.trigger,
					stageDetail(effect.trigger, managed, obsolete),
				);
			case "reissue_cancel": {
				// interrupted with no open quarantine: nothing of ours runs → the cancel completes
				const after = requestCancel(db, id, nowIso());
				return after?.state === "cancelled" ? AGAIN : DONE;
			}
			case "violation": {
				deps.flagged.add(id);
				raise("violation", id, ws.id, effect.detail);
				// A reservation that left draft without a decision is a bypass. Stop it (intent only;
				// queued-unleased / blocked → cancelled now, active → the engine's cancel path), so
				// 04's withdraw / supersede (releaseReserved: draft | cancelled) keep working.
				if (ws.stage === "awaiting_run_approval")
					requestCancel(db, id, nowIso());
				return DONE;
			}
		}
	}

	// ── human_ready → Gate 2 (OQ-7, OQ-8) ──────────────────────────────────────

	async function sealAndCommit(plan: SealPlan): Promise<boolean> {
		const id = plan.managed_task_id;
		let sealed: SealedResult | null = null;
		let sealError: string | null = null;
		try {
			sealed = await sealer.seal(plan.input);
		} catch (err) {
			sealError = err instanceof SealError ? err.code : "internal";
		}
		if (
			sealError !== null &&
			(sealError === "internal" || TRANSIENT_SEAL_ERRORS.has(sealError))
		) {
			const n = (transient.get(id) ?? 0) + 1;
			transient.set(id, n);
			if (n < maxTransient) {
				raise(
					"seal_failed",
					id,
					plan.workspace_task_id,
					`sealing failed (${sealError}, attempt ${n} of ${maxTransient}); retried by the next sweep`,
				);
				return false;
			}
			raise(
				"seal_failed",
				id,
				plan.workspace_task_id,
				`sealing failed ${n} times (${sealError}); the execution ends without a result`,
			);
		} else if (sealError !== null)
			raise(
				"seal_failed",
				id,
				plan.workspace_task_id,
				`the result could not be sealed (${sealError})`,
			);
		// v1.2 §B: an eligible result is offered only once its durable bundle (the sealer's exact
		// verified buffers) is published — BEFORE the result request row exists. A failure is
		// transient (bounded by the same counter), then the result is recorded
		// invalidated(evidence_unavailable): no acceptance is possible without durable evidence.
		let bundle: EvidenceBundleRow | null = null;
		let durableFailed = false;
		if (sealed?.eligibility.eligible) {
			try {
				bundle = publishSealedEvidence(
					config.artifacts_root,
					sealed,
					nowIso(),
					deps.hooks?.publishFaults,
				);
			} catch (err) {
				const code = err instanceof BundleError ? err.code : "internal";
				const n = (transient.get(id) ?? 0) + 1;
				transient.set(id, n);
				if (n < maxTransient) {
					raise(
						"seal_failed",
						id,
						plan.workspace_task_id,
						`${DURABLE_SEAL_FAILED_DETAIL} (${code}, attempt ${n} of ${maxTransient}); retried by the next sweep`,
					);
					return false;
				}
				raise(
					"seal_failed",
					id,
					plan.workspace_task_id,
					`${DURABLE_SEAL_FAILED_DETAIL} ${n} times (${code}); nothing is offered for acceptance`,
				);
				durableFailed = true;
			}
		}
		transient.delete(id);
		await deps.hooks?.beforeSealCommit?.(id);
		try {
			return store.transaction((tx) =>
				commitSeal(
					tx,
					plan,
					sealed,
					sealError,
					bundle,
					durableFailed,
					nowIso(),
				),
			);
		} catch (err) {
			if (
				err instanceof WorkspaceConflictError &&
				err.constraint === "result_request_per_run"
			)
				return false; // another reconciler committed it: done
			if (err instanceof CasMiss) return true;
			throw err;
		}
	}

	function commitSeal(
		tx: PersistentWorkspaceTx,
		plan: SealPlan,
		sealed: SealedResult | null,
		sealError: string | null,
		bundle: EvidenceBundleRow | null,
		durableFailed: boolean,
		at: string,
	): boolean {
		const ws = tx.getTask(plan.workspace_task_id);
		if (!ws || ws.current_managed_task_id !== plan.managed_task_id)
			return false;
		const managed = getTask(db, plan.managed_task_id);
		if (
			managed?.state !== "human_ready" ||
			managed.result_run_id !== plan.run_id
		)
			return true; // fenced: the engine row is not what was sealed → re-derive
		if (tx.findResultRequestForRun(plan.run_id)) return false; // idempotent
		// offered for acceptance only if eligible AND its durable bundle exists (v1.2 §B)
		const offerable =
			(sealed?.eligibility.eligible ?? false) &&
			bundle !== null &&
			bundle.result_envelope_hash === sealed?.envelope_hash;
		const next = stageAfterSealing(ws.stage, offerable);
		if (!next) return false;
		if (next.trigger !== "cancel_won") {
			const auth = evaluateAuthorization(tx, config, managed, {
				policy: false,
			});
			if (!auth.ok || auth.decision.id !== plan.input.run_decision_id)
				return true; // re-derive (violation path)
		}
		let detail: string;
		if (sealed) {
			const status =
				next.trigger === "result_ready"
					? { status: "pending" as const, reason: null }
					: next.trigger === "cancel_won"
						? {
								status: "invalidated" as const,
								reason: "task_cancelled" as const,
							}
						: {
								status: "invalidated" as const,
								reason: "evidence_unavailable" as const,
							};
			const sealFailed =
				durableFailed &&
				sealed.eligibility.eligible &&
				next.trigger !== "cancel_won";
			detail =
				next.trigger === "result_ready"
					? "verified and reviewed (simulated); awaiting acceptance"
					: next.trigger === "cancel_won"
						? stageDetail("cancel_won", managed)
						: sealFailed
							? `${DURABLE_SEAL_FAILED_DETAIL}; nothing is offered for acceptance`
							: sealed.eligibility.reasons.includes("criteria_unmapped")
								? // v1.2 §A: a legacy v1 proposal has no criterion coverage
									`${LEGACY_PROPOSAL_DETAIL}; nothing is offered for acceptance`
								: `the result is not eligible for acceptance (evidence ${sealed.eligibility.evidence_status}; ${sealed.eligibility.reasons.join(", ") || "ineligible"}); nothing is offered for acceptance`;
			const digest =
				next.trigger === "result_ready" && bundle ? bundle.digest : null;
			// the bundle row and the request naming it commit together (FK + 009 trigger)
			if (digest && bundle) tx.insertEvidenceBundle(bundle);
			tx.insertApprovalRequest(
				resultRequestRow(
					plan,
					sealed,
					status.status,
					status.reason,
					sealFailed ? DURABLE_SEAL_FAILED_DETAIL : detail,
					at,
					digest,
				),
			);
		} else
			detail =
				next.trigger === "cancel_won"
					? stageDetail("cancel_won", managed)
					: `the result could not be sealed (${sealError ?? "unknown"}); nothing is offered for acceptance`;
		move(tx, ws, next.to, next.trigger, detail);
		return false;
	}

	function resultRequestRow(
		plan: SealPlan,
		sealed: SealedResult,
		status: "pending" | "invalidated",
		reason: InvalidationReason | null,
		detail: string,
		at: string,
		digest: string | null,
	): ApprovalRequestRow {
		const id = newWorkspaceId("wsa");
		const binding = sealResultApprovalBinding({
			approval_request_id: id,
			workspace_task_id: plan.workspace_task_id,
			managed_task_id: plan.managed_task_id,
			run_id: plan.run_id,
			result_envelope_hash: sealed.envelope_hash,
		});
		return {
			id,
			workspace_task_id: plan.workspace_task_id,
			kind: "result",
			proposal_id: plan.input.proposal.proposal_id,
			proposal_hash: plan.input.proposal_hash,
			managed_task_id: plan.managed_task_id,
			execution_binding: plan.input.execution_binding,
			execution_binding_hash: plan.input.execution_binding_hash,
			run_id: plan.run_id,
			// the store re-seals this and requires H = result_envelope_hash: the stored column is the
			// sealer's canonical text verbatim (sha256 equality ⇒ byte equality)
			result_envelope: sealed.envelope,
			result_envelope_hash: sealed.envelope_hash,
			binding: binding.value,
			binding_hash: binding.hash,
			status,
			invalidation_reason: status === "invalidated" ? reason : null,
			invalidation_detail:
				status === "invalidated" ? detail.slice(0, 1000) : null,
			created_at: at,
			updated_at: at,
			closed_at: status === "pending" ? null : at,
			rev: 1,
			challenge_status: "none",
			challenge_hash: null,
			challenge_operator_id: null,
			challenge_session_generation: null,
			challenge_boot_id: null,
			challenge_request_rev: null,
			challenge_issued_at: null,
			challenge_expires_at: null,
			...(digest ? { evidence_bundle_digest: digest } : {}),
		};
	}

	// ── pending Gate 1 vs current policy / repo / base (§6 run_request_invalidated) ──

	interface PendingVerdict {
		reason: InvalidationReason;
		detail: string;
		/** Workspace stage_detail (default: "Gate 1 was invalidated (<reason>): <detail>; …"). */
		stage_detail?: string;
	}

	async function judgePending(
		req: ApprovalRequestRow,
	): Promise<PendingVerdict | null> {
		const proposal = store.getProposal(req.proposal_id);
		if (!proposal) return null;
		// an obsolete v1 grant first (no git needed): never approvable, whatever the repo state
		if (isObsoleteExecutionProposal(proposal.snapshot))
			return {
				reason: OBSOLETE_V1_GRANT_REASON,
				detail: OBSOLETE_V1_GRANT_DETAIL,
				stage_detail: OBSOLETE_V1_GRANT_STAGE_DETAIL,
			};
		const repoId = proposal.snapshot.repo_id;
		const repo = findRepo(config, repoId);
		if (!repo)
			return {
				reason: "repo_unavailable",
				detail: "the repository left the managed allowlist",
			};
		if (
			!hashesEqual(
				policyHash(config, repoId),
				req.execution_binding.policy_hash,
			)
		)
			return {
				reason: "policy_changed",
				detail: "the managed policy for this repository changed",
			};
		switch (await checkBase(repo, req.execution_binding.base_sha)) {
			case "ok":
			case "error":
				return null;
			case "moved":
				return {
					reason: "repo_unavailable",
					detail:
						"the base branch moved; the proposal's base commit is no longer the repository base",
				};
			case "unresolvable":
				return {
					reason: "repo_unavailable",
					detail: "the proposal's base commit is no longer resolvable",
				};
			case "repo_unavailable":
				return {
					reason: "repo_unavailable",
					detail: "the repository is not a usable git checkout",
				};
		}
	}

	function invalidatePending(
		tx: PersistentWorkspaceTx,
		requestId: string,
		verdict: PendingVerdict,
		at: string,
	): boolean {
		const r = tx.getApprovalRequest(requestId);
		if (r?.kind !== "run" || r.status !== "pending") return false;
		const t = tx.getTask(r.workspace_task_id);
		if (
			t?.stage !== "awaiting_run_approval" ||
			t.current_managed_task_id !== r.managed_task_id
		) {
			raise(
				"violation",
				r.managed_task_id,
				r.workspace_task_id,
				"a pending Gate-1 request is not its task's current request",
			);
			return false;
		}
		const m = getTask(db, r.managed_task_id);
		// a reservation outside draft/cancelled is the violation path (evaluate), not ours
		if (m?.state !== "draft" && m?.state !== "cancelled") return false;
		const closed = tx.updateApprovalRequest(
			r.id,
			r.rev,
			{
				status: "invalidated",
				invalidation_reason: verdict.reason,
				invalidation_detail: verdict.detail,
				closed_at: at,
			},
			at,
		);
		if (!closed) throw new CasMiss();
		deps.releaseReserved(tx, {
			managed_task_id: r.managed_task_id,
			reason: verdict.reason,
			now: at,
		});
		move(
			tx,
			t,
			"draft",
			"run_request_invalidated",
			verdict.stage_detail ??
				`Gate 1 was invalidated (${verdict.reason}): ${verdict.detail}; edit the draft and publish a new version`,
		);
		return true;
	}

	async function policySweep(): Promise<number> {
		let invalidated = 0;
		for (const req of store.listApprovalRequests({
			kind: "run",
			status: "pending",
		})) {
			try {
				const verdict = await judgePending(req);
				if (!verdict) continue;
				await deps.hooks?.beforeInvalidate?.(req.id);
				if (
					store.transaction((tx) =>
						invalidatePending(tx, req.id, verdict, nowIso()),
					)
				)
					invalidated++;
			} catch (err) {
				if (err instanceof CasMiss) continue; // changed meanwhile: the next sweep re-judges
				raise(
					"policy_sweep_error",
					req.managed_task_id,
					req.workspace_task_id,
					errorText(err),
				);
			}
		}
		return invalidated;
	}

	// ── legacy pending Gate 2 without durable evidence (v1.2 §B) ───────────────

	function invalidateLegacyResult(
		tx: PersistentWorkspaceTx,
		requestId: string,
		at: string,
	): boolean {
		const r = tx.getApprovalRequest(requestId);
		if (
			r?.kind !== "result" ||
			r.status !== "pending" ||
			(r.evidence_bundle_digest ?? null) !== null
		)
			return false;
		const closed = tx.updateApprovalRequest(
			r.id,
			r.rev,
			{
				status: "invalidated",
				invalidation_reason: "evidence_unavailable",
				invalidation_detail: LEGACY_RESULT_DETAIL,
				closed_at: at,
			},
			at,
		);
		if (!closed) throw new CasMiss();
		const t = tx.getTask(r.workspace_task_id);
		if (
			t?.stage === "awaiting_acceptance" &&
			t.current_managed_task_id === r.managed_task_id
		)
			move(
				tx,
				t,
				"execution_ended",
				"result_invalidated",
				LEGACY_RESULT_DETAIL,
			);
		return true;
	}

	function legacySweep(): number {
		let n = 0;
		for (const req of store.listApprovalRequests({
			kind: "result",
			status: "pending",
		})) {
			if ((req.evidence_bundle_digest ?? null) !== null) continue;
			try {
				if (
					store.transaction((tx) =>
						invalidateLegacyResult(tx, req.id, nowIso()),
					)
				) {
					n++;
					raise(
						"seal_failed",
						req.managed_task_id,
						req.workspace_task_id,
						`a pending result had no durable evidence bundle and was invalidated (${LEGACY_RESULT_DETAIL})`,
					);
				}
			} catch (err) {
				if (err instanceof CasMiss) continue; // changed meanwhile: the next sweep re-judges
				raise(
					"reconcile_error",
					req.managed_task_id,
					req.workspace_task_id,
					errorText(err),
				);
			}
		}
		return n;
	}

	// ── accepted results: current validity (v1.2 §C) ──────────────────────────

	const checkDeps = {
		db,
		config,
		...(deps.gitFor ? { gitFor: deps.gitFor } : {}),
	};
	const maxAcceptedChecks = Math.max(1, deps.maxAcceptedChecksPerSweep ?? 20);

	async function acceptedSweep(): Promise<{
		checked: number;
		invalid: number;
	}> {
		let checked = 0;
		let invalid = 0;
		// oldest check first; sticky rows (invalid / unverifiable) are never re-checked
		const rows = store.listAcceptanceValidity({
			statuses: ["valid", "unknown"],
			limit: maxAcceptedChecks,
		});
		for (const row of rows) {
			if (stopped) break;
			try {
				const subject = subjectOf(store, row);
				if (!subject) continue;
				const verdict = await checkAcceptance(checkDeps, subject);
				const after = recordAcceptanceVerdict(
					store,
					row.decision_id,
					verdict,
					nowIso(),
				);
				checked++;
				if (after?.status === "invalid") {
					invalid++;
					const mt = subject.request.result_envelope?.managed_task_id ?? null;
					raise(
						"acceptance_invalid",
						mt,
						row.workspace_task_id,
						`an accepted result is no longer valid (${after.reason ?? "invalid"}); the acceptance stays in history`,
					);
				}
			} catch (err) {
				raise(
					"acceptance_check_error",
					null,
					row.workspace_task_id,
					errorText(err),
				);
			}
		}
		return { checked, invalid };
	}

	// ── sweep ────────────────────────────────────────────────────────────────

	const SWEPT_STAGES: readonly WorkspaceStage[] = [
		"awaiting_run_approval",
		"queued",
		"running",
		"cancel_requested",
	];

	async function sweep(): Promise<SweepReport> {
		if (stopped)
			return {
				tasks: 0,
				invalidated: 0,
				legacy_invalidated: 0,
				accepted_checked: 0,
				accepted_invalid: 0,
			};
		const ids = new Set<string>();
		for (const t of store.listTasks(5000))
			if (SWEPT_STAGES.includes(t.stage) && t.current_managed_task_id)
				ids.add(t.current_managed_task_id);
		// executions doing work that no workspace task holds as current (superseded / ungoverned)
		for (const m of listTasks(db, 5000))
			if (WORK_STATES.includes(m.state)) ids.add(m.id);
		for (const id of ids) notify(id);
		let invalidated = 0;
		let legacy = 0;
		let accepted = { checked: 0, invalid: 0 };
		await new Promise<void>((resolve) => {
			const done = () => {
				waiters.delete(done);
				resolve();
			};
			waiters.add(done); // stop() releases it if the job is dropped
			// unique key: a concurrent sweep must not replace (and orphan) this sweep's job
			enqueue(`policy:${++sweepSeq}`, async () => {
				try {
					invalidated = await policySweep();
				} finally {
					// independent of the Gate-1 policy pass: one failing part never skips the others
					try {
						legacy = legacySweep();
					} catch (err) {
						raise("reconcile_error", null, null, errorText(err));
					}
					try {
						accepted = await acceptedSweep();
					} catch (err) {
						raise("acceptance_check_error", null, null, errorText(err));
					}
					done();
				}
			});
			if (stopped) done();
		});
		await idle();
		return {
			tasks: ids.size,
			invalidated,
			legacy_invalidated: legacy,
			accepted_checked: accepted.checked,
			accepted_invalid: accepted.invalid,
		};
	}

	async function idle(): Promise<void> {
		while (draining) await draining;
	}

	return {
		notify,
		sweep,
		idle,
		async stop() {
			stopped = true;
			jobs.clear();
			for (const w of [...waiters]) w();
			await idle();
		},
	};
}
