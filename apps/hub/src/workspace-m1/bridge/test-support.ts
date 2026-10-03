// Test-only support for the bridge tests (imported by *.test.ts in this directory only; never by
// production code). Disposable storage + fake providers only: the lead-owned managed testkit's
// `makeFixture` (throwaway git repo `local/fixture`), role 03's auth with a fake clock and
// runtime-generated synthetic credentials, role 02's store, role 06's sealer, role 04's services
// wired to THIS bridge's port, and the existing Orchestrator with `authorize` + `onChange` wired to
// the bridge exactly as the lead will. No literal secret anywhere.
import type { Database } from "bun:sqlite";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Finding,
	type ManagedTask,
	REVIEW_CONTRACT,
} from "@agent-city/schema";
import {
	CSRF_HEADER,
	type DecisionRequest,
	type EvidenceSealer,
	type VerifiedAuthContext,
	WORKSPACE_API_BASE,
	type WorkspaceDraft,
} from "@agent-city/schema/workspace-m1";
import { Hono } from "hono";
import { openDb } from "../../db.ts";
import {
	type AdapterSet,
	EMPTY_META,
	type ReviewAdapter,
	type ReviewInput,
} from "../../managed/adapters/types.ts";
import type { ManagedConfig } from "../../managed/config.ts";
import {
	Orchestrator,
	type OrchestratorHooks,
} from "../../managed/orchestrator.ts";
import type { ProcessOps } from "../../managed/proc.ts";
import { getTask, listRuns } from "../../managed/store.ts";
import {
	type Fixture,
	type FixtureOptions,
	makeFixture,
	stubCalls,
} from "../../managed/testkit.ts";
import { createAdapters } from "../../managed/worker.ts";
import {
	createWorkspaceAuth,
	SESSION_COOKIE,
	type WorkspaceAuth,
} from "../auth/index.ts";
import { FakeClock, newCredential, ORIGIN } from "../auth/test-support.ts";
import {
	createWorkspaceServices,
	type DecisionHooks,
	type WorkspaceServices,
} from "../decisions/index.ts";
import { RetainedEvidenceStore } from "../evidence/retained.ts";
import { createEvidenceSealer } from "../evidence/sealer.ts";
import {
	createWorkspaceStore,
	type PersistentWorkspaceStore,
} from "../persistence/index.ts";
import {
	createWorkspaceBridge,
	type WorkspaceBridge,
	type WorkspaceBridgeDeps,
} from "./bridge.ts";
import type { BridgeAlarm } from "./reconciler.ts";

export const BASE = WORKSPACE_API_BASE;

/** setInterval saturates above 2^31-1 ms (it would fire every 1 ms) — stay below. */
export const HOLD_HEARTBEAT_MS = 1_000_000_000;

// ── instrumentation ─────────────────────────────────────────────────────────

export interface Calls {
	preflight: number;
	implement: number;
	review: number;
	/** Adapter objects requested per mode (requesting one launches nothing). */
	lookups: { simulated: number; live: number };
}

/**
 * Wrap an AdapterSet (fake AND live adapters, whatever the config builds) so every preflight /
 * implement / review invocation is counted. A live adapter call would also leave a line in the
 * stub executable's call log (`stubCalls`), which the tests assert is empty.
 */
export function counted(inner: AdapterSet): {
	adapters: AdapterSet;
	calls: Calls;
} {
	const calls: Calls = {
		preflight: 0,
		implement: 0,
		review: 0,
		lookups: { simulated: 0, live: 0 },
	};
	return {
		calls,
		adapters: {
			implementer(mode) {
				calls.lookups[mode]++;
				const a = inner.implementer(mode);
				if (!a) return null;
				return {
					...a,
					preflight: (ctx) => {
						calls.preflight++;
						return a.preflight(ctx);
					},
					implement: (input, ctx) => {
						calls.implement++;
						return a.implement(input, ctx);
					},
				};
			},
			reviewer(mode) {
				calls.lookups[mode]++;
				const a = inner.reviewer(mode);
				if (!a) return null;
				return {
					...a,
					preflight: (ctx) => {
						calls.preflight++;
						return a.preflight(ctx);
					},
					review: (input, ctx) => {
						calls.review++;
						return a.review(input, ctx);
					},
				};
			},
		},
	};
}

/** Lines in the stub `claude` / `codex` call logs (each = one spawn of a provider executable). */
export const providerSpawns = (fx: Fixture) =>
	stubCalls(fx, "claude").length + stubCalls(fx, "codex").length;

/**
 * A scripted simulated reviewer: `script(input)` returns "approve" or the findings of a rejection
 * (valid contract shape, bound to the exact candidate + manifest). Everything else stays fake.
 */
export function scriptedReviewer(
	base: AdapterSet,
	script: (input: ReviewInput) => "approve" | Finding[],
): AdapterSet {
	return {
		implementer: (mode) => base.implementer(mode),
		reviewer(mode): ReviewAdapter | null {
			const a = base.reviewer(mode);
			if (!a) return null;
			return {
				...a,
				async review(input) {
					const verdict = script(input);
					const approve = verdict === "approve";
					return {
						...EMPTY_META,
						session_ref: `scripted-${input.run.id}`,
						log: `scripted reviewer attempt=${input.run.attempt_no}`,
						ok: true,
						raw: {
							contract: REVIEW_CONTRACT,
							audited_sha: input.candidate_sha,
							manifest_hash: input.manifest_hash,
							verdict: approve ? "approve" : "reject",
							findings: approve ? [] : verdict,
							tests_executed: false,
							summary: approve ? "Scripted approval." : "Scripted rejection.",
						},
					};
				},
			};
		},
	};
}

// ── environment ─────────────────────────────────────────────────────────────

export interface BridgeEnvOptions {
	fixture?: FixtureOptions;
	/** Reuse files + DB handle (restart: pass a NEW handle on the same file). */
	reuse?: { fx: Fixture; db: Database };
	bridge?: Partial<
		Omit<WorkspaceBridgeDeps, "db" | "store" | "config" | "sealer">
	>;
	sealer?: (real: EvidenceSealer) => EvidenceSealer;
	/** Replace the (counted) adapters, e.g. a scripted reviewer. */
	adapters?: (base: AdapterSet) => AdapterSet;
	/** Config the bridge + decisions see (default: the fixture's). */
	config?: (fx: Fixture) => ManagedConfig;
	decisionHooks?: DecisionHooks;
}

export interface EngineOptions {
	hooks?: OrchestratorHooks;
	heartbeatMs?: number;
	now?: () => Date;
	processOps?: ProcessOps;
	workerId?: string;
	adapters?: AdapterSet;
	/** Default true: wire authorize to the bridge (false = the engine without workspace authz). */
	authorize?: boolean;
	/** Default true: wire onChange → bridge.notify (false = the bridge learns only via sweep). */
	onChange?: boolean;
	/** An extra denial checked after the bridge's (e.g. a revocation while a stage runs). */
	alsoDeny?: (t: ManagedTask) => string | null;
}

export interface BridgeEnv {
	fx: Fixture;
	db: Database;
	config: ManagedConfig;
	clock: FakeClock;
	auth: WorkspaceAuth;
	store: PersistentWorkspaceStore;
	sealer: EvidenceSealer;
	retained: RetainedEvidenceStore;
	bridge: WorkspaceBridge;
	services: WorkspaceServices;
	adapters: AdapterSet;
	calls: Calls;
	alarms: BridgeAlarm[];
	now(): Date;
	tick(ms?: number): Date;
	ctx(): Promise<VerifiedAuthContext>;
	/** The existing Orchestrator, wired like the hub: authorize + onChange → bridge. */
	engine(o?: EngineOptions): Orchestrator;
	/** Tick an orchestrator until no work is left, then wait for the bridge queue. */
	drain(orch?: Orchestrator): Promise<void>;
}

export function makeBridgeEnv(o: BridgeEnvOptions = {}): BridgeEnv {
	const fx = o.reuse?.fx ?? makeFixture(o.fixture);
	const db = o.reuse?.db ?? fx.db;
	const config = o.config ? o.config(fx) : fx.config;
	const clock = new FakeClock(Date.parse("2026-10-02T08:00:00.000Z"));
	const operatorCredential = newCredential();
	const auth = createWorkspaceAuth({
		operator_credential: operatorCredential,
		read_only_credential: newCredential(),
		allowed_origin: ORIGIN,
		clock,
	});
	const store = createWorkspaceStore(db);
	const retained = new RetainedEvidenceStore();
	const realSealer = createEvidenceSealer({
		db,
		config,
		reads: store,
		retained,
	});
	const sealer = o.sealer ? o.sealer(realSealer) : realSealer;
	const alarms: BridgeAlarm[] = [];
	const bridge = createWorkspaceBridge({
		db,
		store,
		config,
		sealer,
		now: () => clock.now(),
		alarm: (a) => alarms.push(a),
		...o.bridge,
	});
	const services = createWorkspaceServices({
		store,
		config,
		sealer,
		reader: { db, config, retained },
		challenges: auth.challenges,
		clock, // the auth clock: the service reads it inside its transactions
		bridge: bridge.port,
		...(o.decisionHooks ? { hooks: o.decisionHooks } : {}),
	});
	const base = counted(createAdapters(fx.config));
	const adapters = o.adapters ? o.adapters(base.adapters) : base.adapters;

	// a VerifiedAuthContext minted by THIS auth instance (through its guard), as 04 does
	let captured: VerifiedAuthContext | null = null;
	const ws = new Hono();
	auth.install(ws);
	ws.post("/__probe", (c) => {
		captured = auth.verified(c);
		return c.json({ ok: true });
	});
	const app = new Hono();
	app.route(BASE, ws);
	let ctxCache: VerifiedAuthContext | null = null;
	const ctx = async (): Promise<VerifiedAuthContext> => {
		if (ctxCache) return ctxCache;
		const res = await app.request(`${BASE}/session`, {
			method: "POST",
			headers: { origin: ORIGIN, "content-type": "application/json" },
			body: JSON.stringify({ credential: operatorCredential }),
		});
		if (res.status !== 200) throw new Error(`sign-in failed: ${res.status}`);
		const cookie = new RegExp(`^${SESSION_COOKIE}=([^;]*)`).exec(
			res.headers.get("set-cookie") ?? "",
		)?.[1];
		const { csrf_token } = (await res.json()) as { csrf_token: string };
		captured = null;
		const probe = await app.request(`${BASE}/__probe`, {
			method: "POST",
			headers: {
				cookie: `${SESSION_COOKIE}=${cookie ?? ""}`,
				origin: ORIGIN,
				[CSRF_HEADER]: csrf_token,
				"content-type": "application/json",
			},
			body: "{}",
		});
		if (probe.status !== 200 || !captured)
			throw new Error(`probe failed: ${probe.status}`);
		ctxCache = captured;
		return captured;
	};

	const engine = (e: EngineOptions = {}) =>
		new Orchestrator({
			db,
			config: fx.config,
			adapters: e.adapters ?? adapters,
			heartbeatMs: e.heartbeatMs ?? 50,
			...(e.onChange === false
				? {}
				: { onChange: (id: string) => bridge.notify(id) }),
			...(e.authorize === false
				? {}
				: {
						authorize: (t: ManagedTask) =>
							bridge.authorize(t) ?? e.alsoDeny?.(t) ?? null,
					}),
			...(e.hooks ? { hooks: e.hooks } : {}),
			...(e.now ? { now: e.now } : {}),
			...(e.processOps ? { processOps: e.processOps } : {}),
			...(e.workerId ? { workerId: e.workerId } : {}),
		});

	return {
		fx,
		db,
		config,
		clock,
		auth,
		store,
		sealer,
		retained,
		bridge,
		services,
		adapters,
		calls: base.calls,
		alarms,
		now: () => clock.now(),
		tick(ms = 1000) {
			clock.advance(ms);
			return clock.now();
		},
		ctx,
		engine,
		async drain(orch) {
			const o2 = orch ?? engine();
			while (await o2.tick()) {
				// drain
			}
			await bridge.idle();
		},
	};
}

/** A second "hub process" on the same database file: new handle, auth boot, store, bridge. */
export function restartBridgeEnv(
	prev: BridgeEnv,
	o: Omit<BridgeEnvOptions, "reuse"> = {},
): BridgeEnv {
	return makeBridgeEnv({
		...o,
		reuse: { fx: prev.fx, db: openDb(prev.fx.dbPath) },
	});
}

// ── flows (service level, through 04 with this bridge's port) ────────────────

export const draft = (over: Partial<WorkspaceDraft> = {}): WorkspaceDraft =>
	withCoverage({
		title: "Bridge a simulated change",
		objective: "Exercise the managed pipeline through the workspace bridge.",
		criteria: ["The fixture check passes"],
		scope: { allowed: ["."], protected: [] },
		execution_mode: "simulated",
		simulation_scenario: "approve",
		repair_policy: { max_repairs: 0 },
		...over,
	});

/**
 * v1.2 (explicit, never inferred): unless the caller passes `criterion_checks`, every criterion is
 * mapped to the fixture repo's one trusted check `fixture-check` (first occurrence of a text).
 */
export function withCoverage(d: WorkspaceDraft): WorkspaceDraft {
	if (d.criterion_checks !== undefined) return d;
	const texts = [...new Set(d.criteria)];
	return {
		...d,
		criterion_checks: texts.map((criterion) => ({
			criterion,
			checks: ["fixture-check"],
		})),
	};
}

let seq = 0;
export const key = (tag = "k") => `${tag}-${Date.now().toString(36)}-${++seq}`;

function must<T>(
	o:
		| { ok: true; status: number; body: T }
		| { ok: false; status: number; body: unknown },
	what: string,
): T {
	if (!o.ok)
		throw new Error(`${what} failed: ${o.status} ${JSON.stringify(o.body)}`);
	return o.body;
}

export interface Ids {
	taskId: string;
	runRequestId: string;
	managedTaskId: string;
	decisionId: string;
}

export function createTask(
	env: BridgeEnv,
	v: VerifiedAuthContext,
	d: WorkspaceDraft = draft(),
): string {
	return must(
		env.services.commands.createTask(
			v,
			{ idempotency_key: key("create"), repo_id: env.fx.repoId, draft: d },
			env.tick(),
		),
		"create",
	).task.id;
}

/** Publish the task's draft → pending Gate-1 request (+ reserved managed task). */
export async function publish(
	env: BridgeEnv,
	v: VerifiedAuthContext,
	taskId: string,
): Promise<{ runRequestId: string; managedTaskId: string }> {
	const task = env.store.getTask(taskId);
	if (!task) throw new Error("no task");
	const view = must(
		await env.services.commands.publishProposal(
			v,
			taskId,
			{ expected_rev: task.rev },
			env.tick(),
		),
		"publish",
	);
	const req = view.approval_requests.find((r) => r.status === "pending");
	if (!req) throw new Error("no pending request after publish");
	return { runRequestId: req.id, managedTaskId: req.managed_task_id };
}

export function decisionFor(
	env: BridgeEnv,
	v: VerifiedAuthContext,
	requestId: string,
	over: Partial<DecisionRequest> = {},
): DecisionRequest {
	const row = env.store.getApprovalRequest(requestId);
	if (!row) throw new Error("no request");
	const ch = must(
		env.services.decisions.issueChallenge(
			v,
			requestId,
			{
				kind: row.kind,
				binding_hash: row.binding_hash,
				expected_request_rev: row.rev,
			},
			env.tick(),
		),
		"challenge",
	);
	const action = over.action ?? (row.kind === "run" ? "approve" : "accept");
	const grants = action === "approve" || action === "accept";
	return {
		idempotency_key: key("decide"),
		kind: row.kind,
		action,
		expected_request_rev: ch.request_rev,
		binding_hash: ch.binding_hash,
		confirmation_text: grants ? "Edward" : null,
		reason: grants ? null : "Please narrow the scope.",
		challenge: ch.challenge,
		...over,
	};
}

export async function decide(
	env: BridgeEnv,
	v: VerifiedAuthContext,
	requestId: string,
	over: Partial<DecisionRequest> = {},
) {
	return env.services.decisions.decide(
		v,
		requestId,
		decisionFor(env, v, requestId, over),
		env.tick(),
	);
}

/** create → publish → challenge → approve (Gate 1). The managed task is queued afterwards. */
export async function approved(
	env: BridgeEnv,
	v: VerifiedAuthContext,
	d: WorkspaceDraft = draft(),
): Promise<Ids> {
	const taskId = createTask(env, v, d);
	const { runRequestId, managedTaskId } = await publish(env, v, taskId);
	const out = must(await decide(env, v, runRequestId), "approve");
	return {
		taskId,
		runRequestId,
		managedTaskId,
		decisionId: out.receipt.decision_id,
	};
}

export function cancel(env: BridgeEnv, v: VerifiedAuthContext, taskId: string) {
	const task = env.store.getTask(taskId);
	if (!task) throw new Error("no task");
	return env.services.commands.cancel(
		v,
		taskId,
		{ expected_rev: task.rev },
		env.tick(),
	);
}

// ── reads / waits ───────────────────────────────────────────────────────────

export const stageOf = (env: BridgeEnv, taskId: string) =>
	env.store.getTask(taskId)?.stage;

export const engineOf = (env: BridgeEnv, managedTaskId: string) =>
	getTask(env.db, managedTaskId);

export const runsOf = (env: BridgeEnv, managedTaskId: string) =>
	listRuns(env.db, managedTaskId);

export const resultRequests = (env: BridgeEnv, taskId: string) =>
	env.store.listApprovalRequests({
		workspace_task_id: taskId,
		kind: "result",
	});

/** Poll until `pred()` holds (real time; the engine's children are real processes). */
export async function waitFor(
	pred: () => boolean,
	what: string,
	timeoutMs = 15_000,
): Promise<void> {
	const until = Date.now() + timeoutMs;
	while (!pred()) {
		if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(20);
	}
}

/** Path of an artifact file of a run (tamper tests). */
export function artifactFile(
	env: BridgeEnv,
	runId: string,
	name: string,
): string {
	const row = env.db
		.query<{ rel_path: string }, [string, string]>(
			"SELECT rel_path FROM managed_artifacts WHERE run_id = ? AND name = ?",
		)
		.get(runId, name);
	if (!row) throw new Error(`no artifact ${name}`);
	return join(env.fx.config.artifacts_root, row.rel_path);
}

export const tamper = (path: string) => appendFileSync(path, "tampered\n");

/** Every row of the workflow + engine tables, in insert order — byte-comparable snapshots. */
export function dump(db: Database): string {
	const tables = [
		"workspace_tasks",
		"managed_proposals",
		"managed_approval_requests",
		"managed_decisions",
		"managed_tasks",
		"managed_runs",
		"managed_quarantine",
	];
	return JSON.stringify(
		Object.fromEntries(
			tables.map((t) => [
				t,
				db.query(`SELECT * FROM ${t} ORDER BY rowid`).all(),
			]),
		),
	);
}

/** Cleanup registry for afterEach (closes every handle, removes each fixture dir once). */
export function tracker() {
	const envs: BridgeEnv[] = [];
	return {
		track(e: BridgeEnv): BridgeEnv {
			envs.push(e);
			return e;
		},
		async cleanup() {
			const dirs = new Set<string>();
			for (const e of envs.splice(0)) {
				await e.bridge.stop().catch(() => {});
				try {
					e.db.close();
				} catch {
					// already closed
				}
				if (!dirs.has(e.fx.dir)) {
					dirs.add(e.fx.dir);
					e.fx.cleanup();
				}
			}
		},
	};
}
