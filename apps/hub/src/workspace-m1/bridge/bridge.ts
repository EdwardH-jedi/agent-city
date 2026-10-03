// The workspace pipeline bridge (role 05): one object the lead wires into the hub.
//
//   port       — the frozen ExecutionBridge (04's decisions/commands use it). reserve / enqueue /
//                release are 04's `createManagedBridge` over 02's managed writes (reused, not
//                re-implemented); enqueue and cancel additionally notify the reconciler (deferred).
//   authorize  — OrchestratorDeps.authorize: only an approved, still-valid Gate-1 execution of a
//                v1.2 proposal runs (an obsolete v1 grant is denied before every stage).
//   notify     — OrchestratorDeps.onChange: queue a reconcile, return immediately, never throw.
//   sweep      — startup + periodic: re-derive every workspace execution and pending Gate 1
//                (pending v1 grants are invalidated, queued / active v1 executions get a cancel
//                intent), invalidate legacy pending Gate-2 requests without durable evidence, and
//                re-check the current validity of accepted results (at most 20 per sweep, oldest
//                check first — N eligible results need about ceil(N/20) sweeps; see
//                CONTRACT_V1_2.md §C "Detection timing").
//
// No second orchestrator: the existing engine executes; the bridge only observes it, maps its
// states onto workspace stages, seals human_ready results into Gate-2 requests and fails closed.
import type { Database } from "bun:sqlite";
import type { ManagedTask } from "@agent-city/schema";
import { redact } from "@agent-city/schema";
import type {
	EvidenceSealer,
	ExecutionBridge,
} from "@agent-city/schema/workspace-m1";
import type { ManagedConfig, RepoConfig } from "../../managed/config.ts";
import { createManagedBridge } from "../decisions/index.ts";
import type { GitRunner } from "../evidence/context-loader.ts";
import type {
	ManagedWriteHooks,
	PersistentWorkspaceStore,
} from "../persistence/index.ts";
import { createAuthorizer } from "./authorize.ts";
import {
	type BaseCheck,
	type BridgeAlarm,
	type BridgeHooks,
	createReconciler,
	type SweepReport,
} from "./reconciler.ts";

export interface WorkspaceBridgeDeps {
	/** The hub's single Database handle (the store's, the orchestrator's, the sealer's). */
	db: Database;
	/** 02 store created on `db`. */
	store: PersistentWorkspaceStore;
	/** The SAME frozen config object passed to `new Orchestrator({config})` and 04/06. */
	config: ManagedConfig;
	/** 06 sealer (`createEvidenceSealer({db, config, reads: store, retained})`). */
	sealer: EvidenceSealer;
	/** Clock for workspace timestamps (default system clock). */
	now?: () => Date;
	/** Called (deferred, never inside a transaction) after a Gate-1 enqueue: wire `worker.poke()`. */
	onQueued?: (managed_task_id: string) => void;
	/** Alarm sink. Default: one redacted console.error line per distinct condition. */
	alarm?: (a: BridgeAlarm) => void;
	/** Trusted base check for pending Gate-1 requests (default: validateRepo + resolveCommit). */
	checkBase?: (repo: RepoConfig, base_sha: string) => Promise<BaseCheck>;
	/** Transient seal failures tolerated per execution (default 3). */
	maxTransientSealFailures?: number;
	/** Read-only git runner for the accepted-result candidate check (default: hardened runner on config). */
	gitFor?: (cwd: string) => GitRunner;
	/** Accepted results re-checked per sweep, oldest check first (default 20; v1.2 §C). */
	maxAcceptedChecksPerSweep?: number;
	/** Test-only. */
	hooks?: BridgeHooks;
	/** Test-only failure injection inside enqueue (02's points). */
	managedHooks?: ManagedWriteHooks;
}

export interface WorkspaceBridge {
	/** Frozen ExecutionBridge port for 04 (`createWorkspaceRouter({ bridge: bridge.port })`). */
	readonly port: ExecutionBridge;
	/** `OrchestratorDeps.authorize`. Synchronous, read-only, never opens a transaction. */
	authorize(task: ManagedTask): string | null;
	/** `OrchestratorDeps.onChange`. Returns immediately; never throws. */
	notify(managed_task_id: string): void;
	/** Re-derive executions + pending Gate 1, legacy Gate 2, accepted validity; resolves when done. */
	sweep(): Promise<SweepReport>;
	/** Startup sweep now, then every `intervalMs` (default 30 s). Idempotent. */
	start(o?: { intervalMs?: number }): void;
	/** Stop the timer and the queue (after the running job). */
	stop(): Promise<void>;
	/** Resolves when no reconcile job is queued or running (tests). */
	idle(): Promise<void>;
	/** Alarms raised by this process (newest last, bounded). */
	alarms(): readonly BridgeAlarm[];
	/** Managed task ids currently denied because of a detected violation. */
	flagged(): readonly string[];
}

const ALARM_RING = 200;

const defer = (fn: () => void) =>
	setTimeout(() => {
		try {
			fn();
		} catch {
			// a wake-up failure is not a decision failure
		}
	}, 0);

export function createWorkspaceBridge(
	deps: WorkspaceBridgeDeps,
): WorkspaceBridge {
	const now = deps.now ?? (() => new Date());
	const flagged = new Set<string>();
	const ring: BridgeAlarm[] = [];
	const sink =
		deps.alarm ??
		((a: BridgeAlarm) =>
			console.error(
				`[workspace-bridge] ${a.kind}${a.managed_task_id ? ` ${a.managed_task_id}` : ""}: ${redact(a.detail)}`,
			));
	const managed = createManagedBridge({
		db: deps.db,
		config: deps.config,
		...(deps.managedHooks ? { hooks: deps.managedHooks } : {}),
	});
	const reconciler = createReconciler({
		db: deps.db,
		store: deps.store,
		config: deps.config,
		sealer: deps.sealer,
		releaseReserved: managed.releaseReserved,
		now,
		flagged,
		alarm(a) {
			ring.push(a);
			if (ring.length > ALARM_RING) ring.shift();
			sink(a);
		},
		...(deps.checkBase ? { checkBase: deps.checkBase } : {}),
		...(deps.maxTransientSealFailures !== undefined
			? { maxTransientSealFailures: deps.maxTransientSealFailures }
			: {}),
		...(deps.gitFor ? { gitFor: deps.gitFor } : {}),
		...(deps.maxAcceptedChecksPerSweep !== undefined
			? { maxAcceptedChecksPerSweep: deps.maxAcceptedChecksPerSweep }
			: {}),
		...(deps.hooks ? { hooks: deps.hooks } : {}),
	});
	const authorize = createAuthorizer({
		reads: deps.store,
		config: deps.config,
		flagged,
	});

	const port: ExecutionBridge = {
		reserve: (tx, input) => managed.reserve(tx, input),
		enqueueApproved(tx, input) {
			const r = managed.enqueueApproved(tx, input);
			if (r.queued) {
				// both deferred: this runs inside 04's decision transaction
				reconciler.notify(input.managed_task_id);
				if (deps.onQueued) {
					const cb = deps.onQueued;
					defer(() => cb(input.managed_task_id));
				}
			}
			return r;
		},
		releaseReserved: (tx, input) => managed.releaseReserved(tx, input),
		requestCancel(managed_task_id, at) {
			const view = managed.requestCancel(managed_task_id, at);
			reconciler.notify(managed_task_id);
			return view;
		},
		engineView: (managed_task_id) => managed.engineView(managed_task_id),
		currentPolicyHash: (repo_id) => managed.currentPolicyHash(repo_id),
	};

	let timer: ReturnType<typeof setInterval> | null = null;
	const runSweep = () => {
		reconciler.sweep().catch(() => {
			// reconcile errors are alarms; the next sweep retries
		});
	};

	return {
		port,
		authorize,
		notify: reconciler.notify,
		sweep: () => reconciler.sweep(),
		start(o = {}) {
			if (timer) return;
			runSweep();
			timer = setInterval(runSweep, Math.max(1_000, o.intervalMs ?? 30_000));
			(timer as { unref?: () => void }).unref?.();
		},
		async stop() {
			if (timer) clearInterval(timer);
			timer = null;
			await reconciler.stop();
		},
		idle: () => reconciler.idle(),
		alarms: () => [...ring],
		flagged: () => [...flagged],
	};
}
