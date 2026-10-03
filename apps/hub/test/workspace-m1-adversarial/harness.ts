// biome-ignore-all lint/suspicious/noExplicitAny: adversarial tests inspect raw, untyped HTTP bodies and SQLite rows on purpose
// Role 08 (independent adversarial QA) — shared harness for the *.adv.test.ts files in this
// directory. Two hub flavours, both on a disposable fixture repo + temp file-backed SQLite, bound to
// 127.0.0.1 port 0 (asserted ≠ 4317):
//   - realHub(): the lead's production composition, `startHub({... workspace})` (black box).
//   - composedHub(): the SAME production modules composed exactly like startHub/createWorkspaceHub,
//     plus test-only seams (04 DecisionHooks, orchestrator hooks, counted/custom adapters, process
//     ops, manual worker) for white-box fault injection.
// Credentials are generated per hub with randomBytes and never printed. No provider CLI, network,
// .env or real DB is ever touched.
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
	ChallengeIssueResponse,
	CSRF_HEADER,
	SessionView,
	WORKSPACE_API_BASE,
	type WorkspaceDraft,
} from "@agent-city/schema/workspace-m1";
import { Hono } from "hono";
import { openDb } from "../../src/db.ts";
import { createApp, startHub } from "../../src/index.ts";
import type {
	AdapterSet,
	ReviewInput,
} from "../../src/managed/adapters/types.ts";
import type { ManagedConfig } from "../../src/managed/config.ts";
import {
	Orchestrator,
	type OrchestratorHooks,
} from "../../src/managed/orchestrator.ts";
import type { ProcessOps } from "../../src/managed/proc.ts";
import {
	type Fixture,
	type FixtureOptions,
	makeFixture,
	stubCalls,
} from "../../src/managed/testkit.ts";
import { createAdapters, startWorker } from "../../src/managed/worker.ts";
import { createBroadcaster, websocket } from "../../src/routes/ws.ts";
import { checkWsRequest, type SecurityConfig } from "../../src/security.ts";
import { simulatedOnly } from "../../src/workspace-hub.ts";
import {
	createWorkspaceAuth,
	type WorkspaceAuth,
	type WorkspaceAuthOptions,
} from "../../src/workspace-m1/auth/index.ts";
import {
	createWorkspaceBridge,
	type WorkspaceBridge,
} from "../../src/workspace-m1/bridge/index.ts";
import {
	createWorkspaceRouter,
	type DecisionHooks,
} from "../../src/workspace-m1/decisions/index.ts";
import { RetainedEvidenceStore } from "../../src/workspace-m1/evidence/retained.ts";
import {
	createEvidenceSealer,
	defaultGitFor,
} from "../../src/workspace-m1/evidence/sealer.ts";
import {
	createWorkspaceStore,
	type PersistentWorkspaceStore,
} from "../../src/workspace-m1/persistence/index.ts";

export const ORIGIN = "http://127.0.0.1:5999"; // the (fake) exact workspace UI origin
export const BASE = WORKSPACE_API_BASE;

/** Fake clock shared by auth (sessions, challenges) and the workspace (timestamps). */
export class FakeClock {
	private t: number;
	constructor(start = Date.now()) {
		this.t = start;
	}
	now(): Date {
		return new Date(this.t);
	}
	advance(ms: number): void {
		this.t += ms;
	}
}

export const cred = () => `adv-${randomBytes(24).toString("hex")}`; // synthetic, this run only
let seq = 0;
export const key = (tag = "k") =>
	`${tag}-${Date.now().toString(36)}-${(++seq).toString(36)}-${randomBytes(3).toString("hex")}`;

// ── preconditions (asserted by every file) ──────────────────────────────────

export function assertIsolation(): void {
	if (Bun.which("claude") !== null || Bun.which("codex") !== null)
		throw new Error("provider CLI resolvable on PATH — refusing to run");
	for (const k of Object.keys(process.env))
		if (
			/(_API_KEY|_AUTH_TOKEN)$/.test(k) ||
			/^(ANTHROPIC|OPENAI|CODEX)_/.test(k)
		)
			throw new Error(`provider credential variable present: ${k}`);
}

// ── teardown registry ───────────────────────────────────────────────────────

const cleanups: (() => Promise<void> | void)[] = [];
/** Position in the cleanup list (hubs created later are stopped by teardownSince). */
export const mark = () => cleanups.length;
export async function teardownSince(m: number): Promise<void> {
	for (const c of cleanups.splice(m).reverse()) {
		try {
			await c();
		} catch {
			// best effort
		}
	}
}
/** Live in-process hub servers (asserted 0 after each file's teardown). */
export let liveServers = 0;
export async function teardown(): Promise<void> {
	for (const c of cleanups.splice(0).reverse()) {
		try {
			await c();
		} catch {
			// best effort
		}
	}
}

// ── HTTP client ─────────────────────────────────────────────────────────────

export interface Res {
	status: number;
	body: any;
	text: string;
	headers: Headers;
}

export interface ReqOpts {
	headers?: Record<string, string>;
	/** null = omit the Origin header; default ORIGIN */
	origin?: string | null;
	/** null = omit the cookie */
	cookie?: string | null;
	/** null = omit the CSRF header; default the session's */
	csrf?: string | null;
	raw?: string;
	contentType?: string | null;
}

export async function http(
	base: string,
	method: string,
	path: string,
	body?: unknown,
	o: ReqOpts & { session?: { cookie: string; csrf: string } | null } = {},
): Promise<Res> {
	const headers: Record<string, string> = {};
	const origin = o.origin === undefined ? ORIGIN : o.origin;
	if (origin !== null) headers.origin = origin;
	const cookie = o.cookie === undefined ? o.session?.cookie : o.cookie;
	if (cookie) headers.cookie = cookie;
	const mutation = method !== "GET" && method !== "HEAD";
	const csrf = o.csrf === undefined ? o.session?.csrf : o.csrf;
	if (mutation && csrf) headers[CSRF_HEADER] = csrf;
	const hasBody = body !== undefined || o.raw !== undefined;
	if (hasBody && o.contentType !== null)
		headers["content-type"] = o.contentType ?? "application/json";
	Object.assign(headers, o.headers ?? {});
	const r = await fetch(`${base}${path}`, {
		method,
		headers,
		body: hasBody ? (o.raw ?? JSON.stringify(body)) : undefined,
		redirect: "manual",
	});
	const text = method === "HEAD" ? "" : await r.text();
	let parsed: unknown = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = text;
	}
	return { status: r.status, body: parsed, text, headers: r.headers };
}

export class Client {
	constructor(
		readonly base: string,
		readonly cookie: string,
		readonly csrf: string,
		readonly sessionView: SessionView,
	) {}
	req(method: string, path: string, body?: unknown, o: ReqOpts = {}) {
		return http(this.base, method, `${BASE}${path}`, body, {
			...o,
			session: { cookie: this.cookie, csrf: this.csrf },
		});
	}
	get(path: string, o: ReqOpts = {}) {
		return this.req("GET", path, undefined, o);
	}
	post(path: string, body: unknown, o: ReqOpts = {}) {
		return this.req("POST", path, body, o);
	}
}

export async function signIn(
	base: string,
	credential: string,
	origin = ORIGIN,
): Promise<Client> {
	const r = await http(
		base,
		"POST",
		`${BASE}/session`,
		{ credential },
		{ origin },
	);
	if (r.status !== 200) throw new Error(`sign-in failed: ${r.status}`);
	const setCookie = r.headers.get("set-cookie") ?? "";
	const cookie = setCookie.split(";")[0] ?? "";
	const view = SessionView.parse(r.body);
	return new Client(base, cookie, view.csrf_token, view);
}

// ── hubs ────────────────────────────────────────────────────────────────────

export interface HubCommon {
	fx: Fixture;
	db: Database;
	base: string;
	port: number;
	credential: string;
	readOnlyCredential: string;
	stop(): Promise<void>;
	signIn(kind?: "operator" | "viewer"): Promise<Client>;
	/** Provider stub spawns (live-stub fixtures only; 0 = no actual provider executable ran). */
	providerSpawns(): number;
}

export interface RealHubOptions {
	fixture?: FixtureOptions;
	reuse?: Fixture;
	clock?: FakeClock;
	auth?: Partial<WorkspaceAuthOptions>;
	credentials?: { operator: string; readOnly: string };
	idleMs?: number;
	/** Test-only engine boundaries (startHub `managedHooks`, e.g. a `Barrier`). Absent = none. */
	hooks?: OrchestratorHooks;
}

export type RealHub = HubCommon & {
	hub: ReturnType<typeof startHub>;
	clock?: FakeClock;
};

function fixtureFor(o: { fixture?: FixtureOptions; reuse?: Fixture }): {
	fx: Fixture;
	db: Database;
} {
	if (o.reuse) return { fx: o.reuse, db: openDb(o.reuse.dbPath) };
	const fx = makeFixture({ dbFile: true, ...o.fixture });
	cleanups.push(() => fx.cleanup());
	return { fx, db: fx.db };
}

const spawnsOf = (fx: Fixture) =>
	existsSync(`${fx.dir}/bin`)
		? stubCalls(fx, "claude").length + stubCalls(fx, "codex").length
		: 0;

/** The production composition: startHub with workspace mode on. */
export function realHub(o: RealHubOptions = {}): RealHub {
	const { fx, db } = fixtureFor(o);
	const credential = o.credentials?.operator ?? cred();
	const readOnlyCredential = o.credentials?.readOnly ?? cred();
	const hub = startHub({
		db,
		ingestToken: undefined,
		hostname: "127.0.0.1",
		port: 0,
		managed: { config: fx.config, token: undefined },
		managedIdleMs: o.idleMs ?? 30,
		...(o.hooks ? { managedHooks: o.hooks } : {}),
		workspace: {
			operator_credential: credential,
			read_only_credential: readOnlyCredential,
			allowed_origin: ORIGIN,
			...(o.clock ? { clock: o.clock } : {}),
			...o.auth,
		},
	});
	const port = hub.server.port as number;
	if (port === 4317) throw new Error("refusing port 4317");
	liveServers++;
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		releaseHooks(o.hooks); // a held engine boundary would block the worker's stop
		await hub.stop();
		liveServers--;
		if (db !== fx.db)
			try {
				db.close();
			} catch {
				// closed
			}
	};
	cleanups.push(stop);
	const base = `http://127.0.0.1:${port}`;
	return {
		fx,
		db,
		base,
		port,
		credential,
		readOnlyCredential,
		hub,
		...(o.clock ? { clock: o.clock } : {}),
		stop,
		signIn: (kind = "operator") =>
			signIn(base, kind === "viewer" ? readOnlyCredential : credential),
		providerSpawns: () => spawnsOf(fx),
	};
}

// ── composed hub (white-box seams) ──────────────────────────────────────────

export interface Calls {
	preflight: number;
	implement: number;
	review: number;
	lookups: { simulated: number; live: number };
	reviewInputs: ReviewInput[];
}

export function countedAdapters(inner: AdapterSet): {
	adapters: AdapterSet;
	calls: Calls;
} {
	const calls: Calls = {
		preflight: 0,
		implement: 0,
		review: 0,
		lookups: { simulated: 0, live: 0 },
		reviewInputs: [],
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
						calls.reviewInputs.push(input);
						return a.review(input, ctx);
					},
				};
			},
		},
	};
}

export interface ComposedOptions extends RealHubOptions {
	decisionHooks?: DecisionHooks;
	orchestratorHooks?: OrchestratorHooks;
	/** Replace/wrap the base adapters BEFORE counting. */
	adapters?: (base: AdapterSet) => AdapterSet;
	processOps?: ProcessOps;
	heartbeatMs?: number;
	/** manual: no worker loop; drive with `drain()`. */
	manual?: boolean;
	/** Trusted-config change applied before simulatedOnly (policy-change attacks). */
	config?: (c: ManagedConfig) => ManagedConfig;
}

export type ComposedHub = HubCommon & {
	auth: WorkspaceAuth;
	store: PersistentWorkspaceStore;
	bridge: WorkspaceBridge;
	orch: Orchestrator;
	calls: Calls;
	alarms: { kind: string; detail: string }[];
	clock?: FakeClock;
	drain(): Promise<void>;
};

export function composedHub(o: ComposedOptions = {}): ComposedHub {
	const { fx, db } = fixtureFor(o);
	// as startHub does in workspace mode (optionally a changed trusted config, e.g. after a restart)
	const config = simulatedOnly(o.config ? o.config(fx.config) : fx.config);
	const credential = o.credentials?.operator ?? cred();
	const readOnlyCredential = o.credentials?.readOnly ?? cred();
	const clock = o.clock;
	const auth = createWorkspaceAuth({
		operator_credential: credential,
		read_only_credential: readOnlyCredential,
		allowed_origin: ORIGIN,
		base_path: WORKSPACE_API_BASE,
		...(clock ? { clock } : {}),
		...o.auth,
	});
	const store = createWorkspaceStore(db);
	const retained = new RetainedEvidenceStore();
	const gitFor = defaultGitFor(config);
	const sealer = createEvidenceSealer({
		db,
		config,
		reads: store,
		retained,
		gitFor,
	});
	let worker: ReturnType<typeof startWorker> | null = null;
	const alarms: { kind: string; detail: string }[] = [];
	const bridge = createWorkspaceBridge({
		db,
		store,
		config,
		sealer,
		...(clock ? { now: () => clock.now() } : {}),
		onQueued: () => worker?.poke(),
		alarm: (a) => alarms.push({ kind: a.kind, detail: a.detail }),
	});
	const api = new Hono();
	auth.install(api);
	api.route(
		"/",
		createWorkspaceRouter({
			auth,
			store,
			config,
			sealer,
			reader: { db, config, retained, gitFor },
			bridge: bridge.port,
			...(clock ? { clock } : {}),
			...(o.decisionHooks ? { hooks: o.decisionHooks } : {}),
		}),
	);
	const base0 = createAdapters(config);
	const { adapters, calls } = countedAdapters(
		o.adapters ? o.adapters(base0) : base0,
	);
	const orch = new Orchestrator({
		db,
		config,
		adapters,
		authorize: bridge.authorize,
		onChange: bridge.notify,
		...(o.orchestratorHooks ? { hooks: o.orchestratorHooks } : {}),
		...(o.processOps ? { processOps: o.processOps } : {}),
		...(o.heartbeatMs ? { heartbeatMs: o.heartbeatMs } : {}),
	});
	worker = o.manual ? null : startWorker(orch, o.idleMs ?? 30);
	bridge.start();
	const broadcaster = createBroadcaster();
	const security: SecurityConfig = { hubHost: "127.0.0.1", extraOrigins: [] };
	const app = createApp({
		db,
		ingestToken: undefined,
		publish: broadcaster.publish,
		security,
		workspace: { api, auth, store, sealer, retained, bridge },
	});
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req, srv) {
			if (new URL(req.url).pathname === "/ws") {
				const denied = checkWsRequest(req, security);
				if (denied) return denied;
				return srv.upgrade(req, { data: undefined })
					? undefined
					: new Response("expected a WebSocket upgrade", { status: 426 });
			}
			return app.fetch(req);
		},
		websocket,
	});
	broadcaster.attach(server);
	const port = server.port as number;
	if (port === 4317) throw new Error("refusing port 4317");
	liveServers++;
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		releaseHooks(o.orchestratorHooks);
		await bridge.stop();
		if (worker) await worker.stop();
		else await orch.shutdown();
		server.stop(true);
		liveServers--;
		if (db !== fx.db)
			try {
				db.close();
			} catch {
				// closed
			}
	};
	cleanups.push(stop);
	const base = `http://127.0.0.1:${port}`;
	return {
		fx,
		db,
		base,
		port,
		credential,
		readOnlyCredential,
		auth,
		store,
		bridge,
		orch,
		calls,
		alarms,
		...(clock ? { clock } : {}),
		stop,
		signIn: (kind = "operator") =>
			signIn(base, kind === "viewer" ? readOnlyCredential : credential),
		providerSpawns: () => spawnsOf(fx),
		async drain() {
			for (let i = 0; i < 50; i++) {
				if (!(await orch.tick())) break;
			}
			await bridge.idle();
		},
	};
}

// ── workspace flows ─────────────────────────────────────────────────────────

export const draft = (over: Partial<WorkspaceDraft> = {}): WorkspaceDraft =>
	withCoverage({
		title: "Adversarial fixture task",
		objective: "Exercise the workspace approval gates under attack.",
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

export async function createTask(
	c: Client,
	fx: Fixture,
	over: Partial<WorkspaceDraft> = {},
	/** Multi-repository tests: one of `fx.repos[].id` (default: the primary fixture repository). */
	repoId: string = fx.repoId,
): Promise<{ id: string; rev: number }> {
	const r = await c.post("/tasks", {
		idempotency_key: key("task"),
		repo_id: repoId,
		draft: draft(over),
	});
	if (r.status !== 201) throw new Error(`create task ${r.status} ${r.text}`);
	return { id: r.body.task.id, rev: r.body.task.rev };
}

export async function taskView(c: Client, id: string) {
	const r = await c.get(`/tasks/${id}`);
	if (r.status !== 200) throw new Error(`task view ${r.status} ${r.text}`);
	return r.body;
}

/** Create + publish; returns the task id and the pending run request (Gate 1). */
export async function openGate1(
	c: Client,
	fx: Fixture,
	over: Partial<WorkspaceDraft> = {},
	repoId: string = fx.repoId,
) {
	const t = await createTask(c, fx, over, repoId);
	const p = await c.post(`/tasks/${t.id}/proposals`, { expected_rev: t.rev });
	if (p.status !== 201) throw new Error(`publish ${p.status} ${p.text}`);
	const view = await taskView(c, t.id);
	const req = pendingOf(view, "run");
	if (!req) throw new Error("no pending run request");
	return { taskId: t.id, req, view };
}

export function pendingOf(view: any, kind: "run" | "result") {
	return (view.approval_requests as any[]).find(
		(r) => r.kind === kind && r.status === "pending",
	);
}

export async function issueChallenge(c: Client, req: any) {
	const r = await c.post(`/approval-requests/${req.id}/challenge`, {
		kind: req.kind,
		binding_hash: req.binding_hash,
		expected_request_rev: req.rev,
	});
	if (r.status !== 200 && r.status !== 201)
		throw new Error(`challenge ${r.status} ${r.text}`);
	return ChallengeIssueResponse.parse(r.body);
}

export function decisionBody(
	req: any,
	ch: { challenge: string; request_rev: number },
	action: "approve" | "accept" | "reject" | "request_changes",
	over: Record<string, unknown> = {},
) {
	const confirm = action === "approve" || action === "accept";
	return {
		idempotency_key: key("dec"),
		kind: req.kind,
		action,
		expected_request_rev: ch.request_rev,
		binding_hash: req.binding_hash,
		confirmation_text: confirm ? "Edward" : null,
		reason: confirm ? null : "Adversarial QA reason",
		challenge: ch.challenge,
		...over,
	};
}

export const decide = (c: Client, req: any, body: unknown, o: ReqOpts = {}) =>
	c.post(`/approval-requests/${req.id}/decisions`, body, o);

export async function approveGate1(
	c: Client,
	fx: Fixture,
	over: Partial<WorkspaceDraft> = {},
	repoId: string = fx.repoId,
) {
	const g = await openGate1(c, fx, over, repoId);
	const ch = await issueChallenge(c, g.req);
	const body = decisionBody(g.req, ch, "approve");
	const res = await decide(c, g.req, body);
	if (res.status !== 201) throw new Error(`approve ${res.status} ${res.text}`);
	return {
		...g,
		ch,
		body,
		res,
		managedTaskId: g.req.managed_task_id as string,
	};
}

export async function waitFor<T>(
	fn: () =>
		| Promise<T | null | undefined | false>
		| T
		| null
		| undefined
		| false,
	ms = 20_000,
	step = 25,
): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = await fn();
		if (v) return v as T;
		if (Date.now() > end) throw new Error("waitFor timed out");
		await Bun.sleep(step);
	}
}

export async function waitGate2(c: Client, taskId: string, ms = 30_000) {
	return waitFor(async () => {
		const v = await taskView(c, taskId);
		return pendingOf(v, "result") ?? null;
	}, ms);
}

export async function waitStage(
	c: Client,
	taskId: string,
	stages: string[],
	ms = 30_000,
) {
	return waitFor(async () => {
		const v = await taskView(c, taskId);
		return stages.includes(v.task.stage) ? v : null;
	}, ms);
}

/** Full Gate 1 → engine → pending Gate 2. */
export async function toGate2(
	c: Client,
	fx: Fixture,
	over: Partial<WorkspaceDraft> = {},
	repoId: string = fx.repoId,
) {
	const g1 = await approveGate1(c, fx, over, repoId);
	const g2 = await waitGate2(c, g1.taskId);
	return { ...g1, g2 };
}

// ── durable-state helpers ───────────────────────────────────────────────────

export const count = (db: Database, sql: string, ...params: any[]): number =>
	(db.query(sql).get(...params) as { n: number } | null)?.n ?? 0;

export const rows = (db: Database, sql: string, ...params: any[]): any[] =>
	db.query(sql).all(...params) as any[];

const DUMP_TABLES = [
	"workspace_tasks",
	"managed_proposals",
	"managed_approval_requests",
	"managed_decisions",
	"managed_tasks",
	"managed_runs",
	"managed_reviews",
];

/** Deterministic dump of workflow + engine tables (NE assertions). */
export function dump(db: Database): string {
	return DUMP_TABLES.map(
		(t) =>
			`${t}:${JSON.stringify(db.query(`SELECT * FROM ${t} ORDER BY id`).all())}`,
	).join("\n");
}

/** Gate-1 effect summary for one managed task (OL assertions). */
export function linkage(db: Database, managedTaskId: string) {
	const t = db
		.query(
			"SELECT state, run_requested_at, fence_token, approval_hash FROM managed_tasks WHERE id = ?",
		)
		.get(managedTaskId) as any;
	return {
		state: t?.state,
		run_requested_at: t?.run_requested_at,
		fence_token: t?.fence_token,
		approval_hash: t?.approval_hash,
		decisions: count(
			db,
			"SELECT count(*) AS n FROM managed_decisions WHERE managed_task_id = ?",
			managedTaskId,
		),
		runs: count(
			db,
			"SELECT count(*) AS n FROM managed_runs WHERE task_id = ?",
			managedTaskId,
		),
	};
}

export const requestRow = (db: Database, id: string) =>
	db
		.query("SELECT * FROM managed_approval_requests WHERE id = ?")
		.get(id) as any;

/** Runtime canaries (never written to a tracked file). */
export const canary = {
	github: () =>
		`gh${"p_"}${randomBytes(48)
			.toString("base64")
			.replace(/[^A-Za-z0-9]/g, "")
			.slice(0, 36)}`,
	plain: (tag = "CANARY") =>
		`${tag}${randomBytes(12).toString("hex")}zq${randomBytes(6).toString("hex")}`,
};

// ── custom simulated implementer (content-specific diffs) ───────────────────

/**
 * Replace the fake implementer's edit with `files` (repo-relative path → content, null = delete),
 * plus the fixture's verify.status=pass so the trusted check passes. Everything else stays fake:
 * provider `fake`, mode `simulated`, no model, no process.
 */
export function writingImplementer(
	base: AdapterSet,
	files: (attempt: number) => Record<string, string | null>,
): AdapterSet {
	return {
		reviewer: (m) => base.reviewer(m),
		implementer(mode) {
			const a = base.implementer(mode);
			if (!a) return null;
			return {
				...a,
				async implement(input) {
					const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
					const { dirname, join } = await import("node:path");
					const put = (rel: string, content: string | null) => {
						const abs = join(input.worktree, rel);
						if (content === null) rmSync(abs, { force: true });
						else {
							mkdirSync(dirname(abs), { recursive: true });
							writeFileSync(abs, content);
						}
					};
					for (const [rel, content] of Object.entries(
						files(input.run.attempt_no),
					))
						put(rel, content);
					put("agentcity-sim/verify.status", "pass\n");
					return {
						session_ref: `adv-${input.run.id}`,
						model_resolved: null,
						usage: null,
						log: "adversarial simulated implementer",
						logTruncated: false,
						ok: true as const,
						output: {
							contract: "agentcity.implementation/v1" as const,
							status: "completed" as const,
							summary: "Adversarial simulated change. No model was called.",
						},
					};
				},
			};
		},
	};
}

/** Commit files into the fixture repo's base branch (before publishing). */
export async function commitToFixture(
	fx: Fixture,
	files: Record<string, string>,
): Promise<void> {
	const { fixtureGit } = await import("../../src/managed/testkit.ts");
	const { mkdirSync, writeFileSync } = await import("node:fs");
	const { dirname, join } = await import("node:path");
	for (const [rel, content] of Object.entries(files)) {
		mkdirSync(dirname(join(fx.repoPath, rel)), { recursive: true });
		writeFileSync(join(fx.repoPath, rel), content);
	}
	fixtureGit(fx.repoPath, "add", "-A");
	fixtureGit(
		fx.repoPath,
		"commit",
		"--quiet",
		"--allow-empty",
		"-m",
		"adversarial base",
	);
}

export const artifactRows = (db: Database, managedTaskId: string) =>
	rows(
		db,
		"SELECT id, run_id, name, kind, rel_path, sha256, byte_len FROM managed_artifacts WHERE task_id = ? ORDER BY created_at, id",
		managedTaskId,
	);

// ── multi-repository support (QA, multi-repository milestone) ───────────────
// Every repository here is a disposable fixture (synthetic ids only); observed-only rows go into the
// telemetry `repos` table exactly like a GitHub sync would write them (never allowlisted).

/** Fixture options with extra allowlisted repositories `local/adv-<label>-<nonce>` (primary first). */
export function multiRepoFixture(
	labels: string[],
	over: Omit<FixtureOptions, "extraRepos" | "dbFile"> = {},
): FixtureOptions {
	const nonce = randomBytes(3).toString("hex");
	return {
		repoId: `local/adv-alpha-${nonce}`,
		...over,
		extraRepos: labels.map((label) => ({
			id: `local/adv-${label}-${nonce}`,
			label,
		})),
	};
}

/** Insert an observed-only repository row (telemetry / GitHub sync shape). Returns its id. */
export function observeRepo(
	db: Database,
	label: string,
	o: { localOnly?: boolean } = {},
): string {
	const id = `observed-example/${label}-${randomBytes(3).toString("hex")}`;
	db.query(
		"INSERT INTO repos (id, district, is_local_only, synced_at) VALUES (?, 'uncategorized', ?, ?)",
	).run(id, o.localOnly ? 1 : 0, new Date().toISOString());
	return id;
}

/** The fixture repository with `id` (throws when it is not one of this fixture's repositories). */
export function repoOf(fx: Fixture, id: string) {
	const r = fx.repos.find((x) => x.id === id);
	if (!r) throw new Error(`not a fixture repository: ${id}`);
	return r;
}

/** True when `sha` names an object in the git repository at `path` (read-only `cat-file -e`). */
export function gitHas(fx: Fixture, path: string, sha: string): boolean {
	const r = Bun.spawnSync(
		[fx.config.git_executable, "-C", path, "cat-file", "-e", `${sha}^{commit}`],
		{ stdout: "ignore", stderr: "ignore", env: { PATH: "/usr/bin:/bin" } },
	);
	return r.exitCode === 0;
}

type HookPoint = Parameters<NonNullable<OrchestratorHooks["at"]>>[0];

/**
 * A releasable engine boundary for `OrchestratorHooks.at`: while armed for a point, every managed
 * task that reaches it waits (the claim's heartbeat keeps its lease) until released. Arrival order is
 * recorded, so a test can compare the engine's real claim order with what the snapshot promised.
 * Hubs created with a Barrier release it before stopping (a held claim would block the worker stop).
 */
export class Barrier implements OrchestratorHooks {
	/** Managed task ids in the order they reached each point (whether held or not). */
	readonly arrivals: { point: HookPoint; taskId: string }[] = [];
	private readonly armed = new Set<HookPoint>();
	private readonly waiting = new Map<string, () => void>();

	arm(point: HookPoint): this {
		this.armed.add(point);
		return this;
	}
	disarm(point: HookPoint): void {
		this.armed.delete(point);
	}
	at(point: HookPoint, taskId: string): Promise<void> | void {
		this.arrivals.push({ point, taskId });
		if (!this.armed.has(point)) return;
		return new Promise<void>((resolve) => {
			this.waiting.set(`${point}:${taskId}`, resolve);
		});
	}
	/** Is `taskId` currently held at `point`? */
	holding(point: HookPoint, taskId: string): boolean {
		return this.waiting.has(`${point}:${taskId}`);
	}
	/** Let one held task continue (it stays armed for others). */
	release(point: HookPoint, taskId: string): void {
		const k = `${point}:${taskId}`;
		this.waiting.get(k)?.();
		this.waiting.delete(k);
	}
	/** Disarm everything and let every held task continue. */
	releaseAll(): void {
		this.armed.clear();
		for (const r of this.waiting.values()) r();
		this.waiting.clear();
	}
}

function releaseHooks(h: OrchestratorHooks | undefined): void {
	const r = h as { releaseAll?: () => void } | undefined;
	if (typeof r?.releaseAll === "function") r.releaseAll();
}

const ENGINE_ACTIVE = "'executing', 'verifying', 'reviewing', 'repairing'";

/**
 * Is the engine (or the bridge behind it) still moving anything? Busy while a task holds a lease,
 * is in an active engine state, is queued and claimable (no open quarantine), or while a workspace
 * task still reads `queued` / `running` although its execution already ended (the bridge has not
 * reconciled yet).
 */
export function engineBusy(db: Database): boolean {
	const quarantined =
		count(
			db,
			"SELECT count(*) AS n FROM managed_quarantine WHERE released_at IS NULL",
		) > 0;
	const busy = count(
		db,
		`SELECT count(*) AS n FROM managed_tasks WHERE lease_owner IS NOT NULL OR state IN (${ENGINE_ACTIVE})${quarantined ? "" : " OR state = 'queued'"}`,
	);
	const unreconciled = count(
		db,
		`SELECT count(*) AS n FROM workspace_tasks w JOIN managed_tasks m ON m.id = w.current_managed_task_id
		 WHERE w.stage IN ('queued', 'running') AND m.state NOT IN ('queued', ${ENGINE_ACTIVE})`,
	);
	return busy + unreconciled > 0;
}

/**
 * A dump taken only once nothing moves on its own: the engine and the bridge are idle (`engineBusy`)
 * and the whole dump stays byte-identical for `stableMs`. NE assertions compare a refused request's
 * after-dump with THIS, so background progress of earlier, legitimately approved work can never be
 * mistaken for (or hide) an effect of the request under test.
 */
export async function settledDump(
	db: Database,
	ms = 30_000,
	stableMs = 300,
): Promise<string> {
	const end = Date.now() + ms;
	let last = "";
	let since = 0;
	for (;;) {
		const now = Date.now();
		if (now > end) throw new Error("settledDump: the engine never went idle");
		if (engineBusy(db)) {
			last = "";
		} else {
			const d = dump(db);
			if (d !== last) {
				last = d;
				since = now;
			} else if (now - since >= stableMs) return d;
		}
		await Bun.sleep(25);
	}
}

/** GET /snapshot (200 asserted by the caller through the returned status). */
export const snapshotOf = (c: Client) => c.get("/snapshot");
