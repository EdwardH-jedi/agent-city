// Test-only support for the decisions tests (imported by *.test.ts in this directory only; never by
// production code). Disposable storage + fake providers only: the lead-owned managed testkit's
// `makeFixture` (throwaway git repo `local/fixture`, live disabled), role 03's auth with a fake clock
// and runtime-generated synthetic credentials, role 02's store, role 06's sealer, and the existing
// Orchestrator with counting wrappers around the fake adapters. No literal secret anywhere.
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { ExecutionMode } from "@agent-city/schema";
import {
	type ApprovalRequestRow,
	buildProposalSnapshot,
	type ChallengePort,
	CSRF_HEADER,
	DECISION_CONTRACT,
	DecisionReceiptBody,
	type DecisionRequest,
	decisionPayloadFrom,
	type EvidenceSealer,
	type ExecutionBridge,
	type ManagedProposalRow,
	PROPOSAL_CONTRACT,
	ProposalDraft,
	type VerifiedAuthContext,
	WORKSPACE_API_BASE,
	type WorkspaceDraft,
	type WorkspaceTaskView,
} from "@agent-city/schema/workspace-m1";
import {
	decisionPayloadHash,
	newWorkspaceId,
	sealAnyProposal,
	sealResultApprovalBinding,
	sealRunApprovalBinding,
} from "@agent-city/schema/workspace-m1/hash";
import { Hono } from "hono";
import { openDb } from "../../db.ts";
import type {
	AdapterSet,
	ImplementationAdapter,
	ReviewAdapter,
} from "../../managed/adapters/types.ts";
import type { ManagedConfig } from "../../managed/config.ts";
import { Orchestrator } from "../../managed/orchestrator.ts";
import { getTask } from "../../managed/store.ts";
import {
	type Fixture,
	type FixtureOptions,
	makeFixture,
} from "../../managed/testkit.ts";
import { createAdapters } from "../../managed/worker.ts";
import { SESSION_COOKIE } from "../auth/http.ts";
import { createWorkspaceAuth, type WorkspaceAuth } from "../auth/index.ts";
import { FakeClock, newCredential, ORIGIN } from "../auth/test-support.ts";
import { publishSealedEvidence } from "../evidence/bundle.ts";
import { RetainedEvidenceStore } from "../evidence/retained.ts";
import { createEvidenceSealer } from "../evidence/sealer.ts";
import type { PersistentWorkspaceStore as Store } from "../persistence/index.ts";
import {
	createWorkspaceStore,
	type PersistentWorkspaceStore,
} from "../persistence/index.ts";
import { defaultResolveBase } from "./commands.ts";
import type { DecisionHooks } from "./deps.ts";
import {
	createWorkspaceRouter,
	createWorkspaceServices,
	type WorkspaceServices,
} from "./router.ts";

export { ORIGIN };
export const BASE = WORKSPACE_API_BASE;

export interface Calls {
	preflight: number;
	implement: number;
	review: number;
}

/** The fake adapters, with every preflight / implement / review invocation counted. */
export function countingAdapters(config: ManagedConfig): {
	adapters: AdapterSet;
	calls: Calls;
} {
	const base = createAdapters(config);
	const calls: Calls = { preflight: 0, implement: 0, review: 0 };
	return {
		calls,
		adapters: {
			implementer(mode: ExecutionMode): ImplementationAdapter | null {
				const a = base.implementer(mode);
				if (!a) return null;
				return {
					provider: a.provider,
					mode: a.mode,
					model_requested: a.model_requested,
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
			reviewer(mode: ExecutionMode): ReviewAdapter | null {
				const a = base.reviewer(mode);
				if (!a) return null;
				return {
					provider: a.provider,
					mode: a.mode,
					model_requested: a.model_requested,
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

export const draft = (over: Partial<WorkspaceDraft> = {}): WorkspaceDraft =>
	withCoverage({
		title: "Add a simulated change",
		objective: "Exercise the managed pipeline on the fixture repository.",
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

let keySeq = 0;
export const key = (tag = "k") =>
	`${tag}-${Date.now().toString(36)}-${++keySeq}`;

export interface Session {
	cookie: string;
	csrf: string;
}

export interface EnvOptions {
	fixture?: FixtureOptions;
	hooks?: DecisionHooks;
	/** Replace the sealer (e.g. a stub that throws a transient SealError). */
	sealer?: (real: EvidenceSealer) => EvidenceSealer;
	/** Config the decision service sees (default: the fixture's) — e.g. a changed policy. */
	config?: (fx: Fixture) => ManagedConfig;
	/** Reuse an existing fixture (restart: same files, new handle / new auth boot). */
	reuse?: { fx: Fixture; db: Database };
	/** Auth lifetimes for expiry tests (clamped by the auth module). */
	auth?: {
		session_ttl_ms?: number;
		idle_timeout_ms?: number;
		challenge_ttl_ms?: number;
	};
}

export interface Env {
	fx: Fixture;
	db: Database;
	config: ManagedConfig;
	clock: FakeClock;
	auth: WorkspaceAuth;
	operatorCredential: string;
	readOnlyCredential: string;
	store: PersistentWorkspaceStore;
	services: WorkspaceServices;
	sealer: EvidenceSealer;
	retained: RetainedEvidenceStore;
	/** Hub-like app: `/api/workspace` = auth.install + probe + createWorkspaceRouter (lead composition). */
	app: Hono;
	now(): Date;
	/** Advance the fake clock by 1 s (or `ms`) and return the new time. */
	tick(ms?: number): Date;
	login(credential?: string): Promise<Session>;
	/** A VerifiedAuthContext minted by THIS auth instance for `s` (through a guarded probe route). */
	ctx(s?: Session): Promise<VerifiedAuthContext>;
	headers(
		s: Session,
		over?: Record<string, string | undefined>,
	): Record<string, string>;
	request(
		method: string,
		path: string,
		s: Session | null,
		body?: unknown,
		over?: Record<string, string | undefined>,
	): Promise<Response>;
}

export function makeEnv(o: EnvOptions = {}): Env {
	const fx = o.reuse?.fx ?? makeFixture(o.fixture);
	const db = o.reuse?.db ?? fx.db;
	const config = o.config ? o.config(fx) : fx.config;
	const clock = new FakeClock(Date.parse("2026-10-02T08:00:00.000Z"));
	const operatorCredential = newCredential();
	const readOnlyCredential = newCredential();
	const auth = createWorkspaceAuth({
		operator_credential: operatorCredential,
		read_only_credential: readOnlyCredential,
		allowed_origin: ORIGIN,
		clock,
		...o.auth,
	});
	const store = createWorkspaceStore(db);
	const retained = new RetainedEvidenceStore();
	const realSealer = createEvidenceSealer({
		db,
		config: fx.config,
		reads: store,
		retained,
	});
	const sealer = o.sealer ? o.sealer(realSealer) : realSealer;
	const reader = { db, config: fx.config, retained };
	const services = createWorkspaceServices({
		store,
		config,
		sealer,
		reader,
		challenges: auth.challenges,
		clock, // the auth clock: the service reads it inside its transactions
		...(o.hooks ? { hooks: o.hooks } : {}),
	});

	let captured: VerifiedAuthContext | null = null;
	const ws = new Hono();
	auth.install(ws);
	ws.post("/__probe", (c) => {
		captured = auth.verified(c);
		return c.json({ ok: true });
	});
	ws.route(
		"/",
		createWorkspaceRouter({
			auth,
			store,
			config,
			sealer,
			reader,
			bridge: services.bridge,
			clock,
			...(o.hooks ? { hooks: o.hooks } : {}),
		}),
	);
	const app = new Hono();
	app.route(BASE, ws);
	app.get("/api/repos", (c) => c.json({ repos: [] }));

	const headers = (
		s: Session,
		over: Record<string, string | undefined> = {},
	): Record<string, string> => {
		const all: Record<string, string | undefined> = {
			cookie: s.cookie,
			origin: ORIGIN,
			[CSRF_HEADER]: s.csrf,
			"content-type": "application/json",
			...over,
		};
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(all)) if (v !== undefined) out[k] = v;
		return out;
	};

	const login = async (credential = operatorCredential): Promise<Session> => {
		const res = await app.request(`${BASE}/session`, {
			method: "POST",
			headers: { origin: ORIGIN, "content-type": "application/json" },
			body: JSON.stringify({ credential }),
		});
		if (res.status !== 200) throw new Error(`sign-in failed: ${res.status}`);
		const set = res.headers.get("set-cookie") ?? "";
		const value = new RegExp(`^${SESSION_COOKIE}=([^;]*)`).exec(set)?.[1] ?? "";
		const body = (await res.json()) as { csrf_token: string };
		return { cookie: `${SESSION_COOKIE}=${value}`, csrf: body.csrf_token };
	};

	let defaultSession: Session | null = null;
	const ctx = async (s?: Session): Promise<VerifiedAuthContext> => {
		if (!s && !defaultSession) defaultSession = await login();
		const session = s ?? defaultSession;
		if (!session) throw new Error("no session");
		captured = null;
		const res = await app.request(`${BASE}/__probe`, {
			method: "POST",
			headers: headers(session),
			body: "{}",
		});
		if (res.status !== 200 || !captured)
			throw new Error(`probe failed: ${res.status}`);
		return captured;
	};

	const request = async (
		method: string,
		path: string,
		s: Session | null,
		body?: unknown,
		over: Record<string, string | undefined> = {},
	): Promise<Response> =>
		app.request(`${BASE}${path}`, {
			method,
			headers: s
				? headers(
						s,
						body === undefined ? { "content-type": undefined, ...over } : over,
					)
				: Object.fromEntries(
						Object.entries({
							origin: ORIGIN,
							"content-type":
								body === undefined ? undefined : "application/json",
							...over,
						}).filter((e): e is [string, string] => e[1] !== undefined),
					),
			...(body === undefined
				? {}
				: { body: typeof body === "string" ? body : JSON.stringify(body) }),
		});

	return {
		fx,
		db,
		config,
		clock,
		auth,
		operatorCredential,
		readOnlyCredential,
		store,
		services,
		sealer,
		retained,
		app,
		now: () => clock.now(),
		tick(ms = 1000) {
			clock.advance(ms);
			return clock.now();
		},
		login,
		ctx,
		headers,
		request,
	};
}

/** A second "hub process" on the same database file: new handle, new auth boot, new store. */
export function restartEnv(prev: Env, o: Omit<EnvOptions, "reuse"> = {}): Env {
	try {
		prev.db.close();
	} catch {
		// already closed
	}
	const db = openDb(prev.fx.dbPath);
	return makeEnv({ ...o, reuse: { fx: prev.fx, db } });
}

// ── flows (service level) ───────────────────────────────────────────────────

export function expectOk<T>(
	o:
		| { ok: true; status: number; body: T }
		| { ok: false; status: number; body: unknown },
	what = "command",
): T {
	if (!o.ok)
		throw new Error(`${what} failed: ${o.status} ${JSON.stringify(o.body)}`);
	return o.body;
}

export async function createTask(
	env: Env,
	v: VerifiedAuthContext,
	d: WorkspaceDraft = draft(),
): Promise<WorkspaceTaskView> {
	return expectOk(
		env.services.commands.createTask(
			v,
			{ idempotency_key: key("create"), repo_id: env.fx.repoId, draft: d },
			env.tick(),
		),
		"create",
	);
}

export async function publish(
	env: Env,
	v: VerifiedAuthContext,
	taskId: string,
): Promise<{
	view: WorkspaceTaskView;
	request: WorkspaceTaskView["approval_requests"][number];
}> {
	const task = env.store.getTask(taskId);
	if (!task) throw new Error("no task");
	const view = expectOk(
		await env.services.commands.publishProposal(
			v,
			taskId,
			{ expected_rev: task.rev },
			env.tick(),
		),
		"publish",
	);
	const request = view.approval_requests.find((r) => r.status === "pending");
	if (!request) throw new Error("no pending request after publish");
	return { view, request };
}

export function challenge(
	env: Env,
	v: VerifiedAuthContext,
	requestId: string,
): {
	challenge: string;
	request_rev: number;
	binding_hash: string;
	kind: "run" | "result";
} {
	const row = env.store.getApprovalRequest(requestId);
	if (!row) throw new Error("no request");
	const out = expectOk(
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
	return out;
}

export function decisionBody(
	ch: {
		challenge: string;
		request_rev: number;
		binding_hash: string;
		kind: "run" | "result";
	},
	over: Partial<DecisionRequest> & { action?: DecisionRequest["action"] } = {},
): DecisionRequest {
	const action = over.action ?? (ch.kind === "run" ? "approve" : "accept");
	const grants = action === "approve" || action === "accept";
	return {
		idempotency_key: key("decide"),
		kind: ch.kind,
		action,
		expected_request_rev: ch.request_rev,
		binding_hash: ch.binding_hash,
		confirmation_text: grants ? "Edward" : null,
		reason: grants ? null : "Please narrow the scope.",
		challenge: ch.challenge,
		...over,
	};
}

/** create → publish → challenge → approve. Returns ids for the queued execution. */
export async function approvedTask(
	env: Env,
	v: VerifiedAuthContext,
	d = draft(),
) {
	const created = await createTask(env, v, d);
	const { request } = await publish(env, v, created.task.id);
	const ch = challenge(env, v, request.id);
	const res = await env.services.decisions.decide(
		v,
		request.id,
		decisionBody(ch),
		env.tick(),
	);
	const out = expectOk(res, "approve");
	return {
		taskId: created.task.id,
		runRequestId: request.id,
		managedTaskId: request.managed_task_id,
		decisionId: out.receipt.decision_id,
		receipt: out.receipt,
	};
}

/** Drain the existing Orchestrator (fake adapters, counted) until no work is left. */
export async function runEngine(env: Env, calls?: { adapters: AdapterSet }) {
	const adapters = calls?.adapters ?? createAdapters(env.fx.config);
	const orch = new Orchestrator({
		db: env.db,
		config: env.fx.config,
		adapters,
		heartbeatMs: 50,
	});
	while (await orch.tick()) {
		// drain
	}
}

/**
 * Emulate the bridge (role 05) at engine human_ready: seal with 06's sealer, publish the durable
 * evidence bundle from the sealer's own buffers (v1.2 §B, BEFORE the request row exists), then in ONE
 * transaction insert the bundle row + the pending Gate-2 request naming it + move the stage.
 * `o.bundle: false` emulates a legacy (pre-009) request without durable evidence.
 */
export async function openGate2(
	env: Env,
	ids: {
		taskId: string;
		runRequestId: string;
		managedTaskId: string;
		decisionId: string;
	},
	o: {
		bundle?: boolean;
		/** Insert the request pending even if the sealer judged it ineligible (guard tests only). */
		allowIneligible?: boolean;
	} = {},
): Promise<ApprovalRequestRow> {
	const managed = getTask(env.db, ids.managedTaskId);
	if (managed?.state !== "human_ready" || !managed.result_run_id)
		throw new Error(`engine not human_ready: ${managed?.state}`);
	const runReq = env.store.getApprovalRequest(ids.runRequestId);
	if (!runReq) throw new Error("no run request");
	const proposal = env.store.getProposal(
		runReq.proposal_id,
	) as ManagedProposalRow;
	const sealed = await env.sealer.seal({
		workspace_task_id: ids.taskId,
		proposal: proposal.snapshot,
		proposal_hash: proposal.proposal_hash,
		execution_binding: runReq.execution_binding,
		execution_binding_hash: runReq.execution_binding_hash,
		run_decision_id: ids.decisionId,
		managed_task_id: ids.managedTaskId,
		run_id: managed.result_run_id,
	});
	if (!sealed.eligibility.eligible && !o.allowIneligible)
		throw new Error(
			`fixture result not eligible: ${JSON.stringify(sealed.problems)} ${JSON.stringify(sealed.eligibility.reasons)}`,
		);
	const at = env.tick().toISOString();
	const bundle =
		o.bundle === false
			? null
			: publishSealedEvidence(env.fx.config.artifacts_root, sealed, at);
	const id = `wsa-${crypto.randomUUID()}`;
	const binding = sealResultApprovalBinding({
		approval_request_id: id,
		workspace_task_id: ids.taskId,
		managed_task_id: ids.managedTaskId,
		run_id: managed.result_run_id,
		result_envelope_hash: sealed.envelope_hash,
	});
	const row: ApprovalRequestRow = {
		id,
		workspace_task_id: ids.taskId,
		kind: "result",
		proposal_id: runReq.proposal_id,
		proposal_hash: runReq.proposal_hash,
		managed_task_id: ids.managedTaskId,
		execution_binding: runReq.execution_binding,
		execution_binding_hash: runReq.execution_binding_hash,
		run_id: managed.result_run_id,
		result_envelope: sealed.envelope,
		result_envelope_hash: sealed.envelope_hash,
		binding: binding.value,
		binding_hash: binding.hash,
		status: "pending",
		invalidation_reason: null,
		invalidation_detail: null,
		created_at: at,
		updated_at: at,
		closed_at: null,
		rev: 1,
		challenge_status: "none",
		challenge_hash: null,
		challenge_operator_id: null,
		challenge_session_generation: null,
		challenge_boot_id: null,
		challenge_request_rev: null,
		challenge_issued_at: null,
		challenge_expires_at: null,
		...(bundle ? { evidence_bundle_digest: bundle.digest } : {}),
	};
	env.store.transaction((tx) => {
		if (bundle) tx.insertEvidenceBundle(bundle);
		tx.insertApprovalRequest(row);
		const task = tx.getTask(ids.taskId);
		if (!task) throw new Error("no task");
		const moved = tx.updateTask(
			task.id,
			task.rev,
			{ stage: "awaiting_acceptance" },
			at,
		);
		if (!moved) throw new Error("CAS miss");
	});
	const stored = env.store.getApprovalRequest(id);
	if (!stored) throw new Error("result request vanished");
	return stored;
}

/** Path of an artifact file of the result run (for tamper tests). */
export function artifactPath(
	env: Env,
	managedTaskId: string,
	name: string,
): string {
	const managed = getTask(env.db, managedTaskId);
	const row = env.db
		.query<{ rel_path: string }, [string, string, string]>(
			"SELECT rel_path FROM managed_artifacts WHERE task_id = ? AND run_id = ? AND name = ?",
		)
		.get(managedTaskId, managed?.result_run_id ?? "", name);
	if (!row) throw new Error(`no artifact ${name}`);
	return join(env.fx.config.artifacts_root, row.rel_path);
}

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

/** Path of a result request's durable evidence bundle file (v1.2 §B; tamper tests). */
export function bundlePath(env: Env, digest: string): string {
	return join(env.fx.config.artifacts_root, "_sealed", `${digest}.bundle`);
}

export const count = (db: Database, sql: string, ...args: string[]): number =>
	db.query<{ n: number }, string[]>(sql).get(...args)?.n ?? 0;

/**
 * A LEGACY (pre-v1.2) publish: the task's stored draft frozen as a v1 proposal (no criterion ids, no
 * coverage plan) + a reserved execution + a pending Gate-1 request, written exactly the way the
 * publish command wrote it before v1.2. Test-only: the hub itself only publishes v1.2 now.
 */
export async function publishLegacyV1(
	env: {
		store: Store;
		config: ManagedConfig;
		services: { bridge: ExecutionBridge };
		tick(ms?: number): Date;
	},
	taskId: string,
): Promise<{
	runRequestId: string;
	managedTaskId: string;
	proposalId: string;
}> {
	const pre = env.store.getTask(taskId);
	const repo = env.config.repos.find((r) => r.id === pre?.repo_id);
	if (!pre || !repo) throw new Error("no task / repo");
	const base_sha = await defaultResolveBase(env.config)(repo);
	const at = env.tick().toISOString();
	return env.store.transaction((tx) => {
		const task = tx.getTask(taskId);
		if (!task) throw new Error("no task");
		const proposal_id = newWorkspaceId("wsp");
		const built = buildProposalSnapshot({
			proposal_id,
			workspace_task_id: task.id,
			version: 1,
			predecessor_proposal_id: null,
			repo_id: task.repo_id,
			base_ref: repo.base_ref,
			base_sha,
			required_checks: repo.verification.map((v) => v.name),
			draft: ProposalDraft.parse(task.draft),
		});
		if (!built.ok) throw new Error(JSON.stringify(built.issues));
		const sealed = sealAnyProposal(built.snapshot);
		tx.insertProposal({
			id: proposal_id,
			workspace_task_id: task.id,
			version: 1,
			predecessor_proposal_id: null,
			contract_version: PROPOSAL_CONTRACT,
			snapshot: sealed.value,
			proposal_hash: sealed.hash,
			created_by: task.created_by,
			created_at: at,
		});
		const request_id = newWorkspaceId("wsa");
		const reserved = env.services.bridge.reserve(tx, {
			proposal: sealed.value,
			proposal_hash: sealed.hash,
			approval_request_id: request_id,
			now: at,
		});
		const binding = sealRunApprovalBinding({
			approval_request_id: request_id,
			workspace_task_id: task.id,
			proposal_id,
			proposal_hash: sealed.hash,
			execution_binding_hash: reserved.execution_binding_hash,
		});
		tx.insertApprovalRequest({
			id: request_id,
			workspace_task_id: task.id,
			kind: "run",
			proposal_id,
			proposal_hash: sealed.hash,
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
			challenge_status: "none",
			challenge_hash: null,
			challenge_operator_id: null,
			challenge_session_generation: null,
			challenge_boot_id: null,
			challenge_request_rev: null,
			challenge_issued_at: null,
			challenge_expires_at: null,
		});
		const moved = tx.updateTask(
			task.id,
			task.rev,
			{
				stage: "awaiting_run_approval",
				current_proposal_id: proposal_id,
				current_managed_task_id: reserved.managed_task_id,
			},
			at,
		);
		if (!moved) throw new Error("CAS miss");
		return {
			runRequestId: request_id,
			managedTaskId: reserved.managed_task_id,
			proposalId: proposal_id,
		};
	});
}

/**
 * A LEGACY Gate-1 approval of a v1 request, committed exactly the way the decision service did it
 * BEFORE obsolete v1 grants were refused (its decideInTx, step by step, in one transaction): a real
 * challenge issued + consumed through the auth module's ChallengePort → decision row + receipt →
 * request `approved` → task `queued` → `enqueueApproved` stamped with `decided_at` (so `authorize`
 * sees an unaltered queue linkage). Test-only: emulates a database that already held an approved /
 * queued v1 execution when the policy arrived. Returns the exact request body, so the stored receipt
 * can be replayed through the real decision service.
 */
export function approveLegacyV1Raw(
	env: {
		store: Store;
		services: { bridge: ExecutionBridge };
		auth: { challenges: ChallengePort };
		tick(ms?: number): Date;
	},
	v: VerifiedAuthContext,
	runRequestId: string,
): { decisionId: string; body: DecisionRequest; receipt: DecisionReceiptBody } {
	const now = env.tick();
	const decided_at = now.toISOString();
	return env.store.transaction((tx) => {
		const row = tx.getApprovalRequest(runRequestId);
		if (row?.kind !== "run" || row.status !== "pending")
			throw new Error("no pending run request");
		const task = tx.getTask(row.workspace_task_id);
		if (task?.stage !== "awaiting_run_approval")
			throw new Error("not at Gate 1");
		const issued = env.auth.challenges.issue(tx, row, v, now);
		const body: DecisionRequest = {
			idempotency_key: key("legacy-approve"),
			kind: "run",
			action: "approve",
			expected_request_rev: issued.request_rev,
			binding_hash: row.binding_hash,
			confirmation_text: "Edward",
			reason: null,
			challenge: issued.challenge,
		};
		const challenged = tx.getApprovalRequest(
			runRequestId,
		) as ApprovalRequestRow;
		if (
			!env.auth.challenges.verifyAndConsume(
				tx,
				challenged,
				body.challenge,
				v,
				now,
			).ok
		)
			throw new Error("legacy challenge did not verify");
		const consumed = tx.getApprovalRequest(runRequestId) as ApprovalRequestRow;
		const payload = decisionPayloadFrom(body, row.id);
		const payload_hash = decisionPayloadHash(payload);
		const decision_id = newWorkspaceId("wsd");
		const receipt = DecisionReceiptBody.parse({
			contract: DECISION_CONTRACT,
			decision_id,
			approval_request_id: row.id,
			workspace_task_id: task.id,
			kind: "run",
			action: "approve",
			operator_id: v.principal.operator_id,
			decided_at,
			payload_hash,
			binding_hash: row.binding_hash,
			approval_request: { status: "approved", rev: consumed.rev + 1 },
			workspace_task: { stage: "queued", rev: task.rev + 1 },
			effects: {
				managed_task_id: row.managed_task_id,
				managed_task_state: "queued",
				result_envelope_hash: null,
			},
		});
		tx.insertDecision({
			id: decision_id,
			approval_request_id: row.id,
			workspace_task_id: task.id,
			kind: "run",
			action: "approve",
			operator_id: v.principal.operator_id,
			idempotency_key: body.idempotency_key,
			payload_hash,
			binding_hash: row.binding_hash,
			request_rev: body.expected_request_rev,
			confirmation_text: payload.confirmation_text,
			reason: payload.reason,
			boot_id: v.principal.boot_id,
			session_generation: v.principal.session_generation,
			managed_task_id: row.managed_task_id,
			result_envelope_hash: null,
			decided_at,
			response_status: 201,
			response_body: receipt,
		});
		const closed = tx.updateApprovalRequest(
			row.id,
			consumed.rev,
			{ status: "approved", closed_at: decided_at },
			decided_at,
		);
		if (!closed) throw new Error("CAS miss closing the legacy request");
		const moved = tx.updateTask(
			task.id,
			task.rev,
			{ stage: "queued", stage_detail: null },
			decided_at,
		);
		if (!moved) throw new Error("CAS miss queueing the legacy task");
		const res = env.services.bridge.enqueueApproved(tx, {
			managed_task_id: row.managed_task_id,
			decision_id,
			execution_binding_hash: row.execution_binding_hash,
			now: decided_at,
		});
		if (!res.queued) throw new Error(`legacy enqueue refused: ${res.reason}`);
		return { decisionId: decision_id, body, receipt };
	});
}
