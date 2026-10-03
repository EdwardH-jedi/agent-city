// Test-only helpers for the auth module (imported by *.test.ts in this directory only): fake clock,
// runtime-generated synthetic credentials, an in-memory WorkspaceTx fake that enforces the port's CAS
// contract and re-validates every row with the frozen ApprovalRequestRow schema, a run-request row
// built through the real binding builders, and a guarded workspace app with counting stub routes.
// No literal credential/token values live here; everything secret-shaped is generated at runtime.
import { randomBytes } from "node:crypto";
import {
	type ApprovalRequestPatch,
	type ApprovalRequestRow,
	ApprovalRequestRow as ApprovalRequestRowSchema,
	CSRF_HEADER,
	type ManagedDecisionRow,
	type VerifiedAuthContext,
	WORKSPACE_API_BASE,
	type WorkspaceTx,
} from "@agent-city/schema/workspace-m1";
import {
	newWorkspaceId,
	sealExecutionBinding,
	sealRunApprovalBinding,
	sha256Hex,
} from "@agent-city/schema/workspace-m1/hash";
import { Hono } from "hono";
import { createWorkspaceAuth, type WorkspaceAuth } from "./auth.ts";
import type { Clock, WorkspaceAuthOptions } from "./config.ts";
import { SESSION_COOKIE } from "./http.ts";

export const T0 = Date.parse("2026-10-02T00:00:00.000Z");

export class FakeClock implements Clock {
	#ms: number;
	constructor(ms = T0) {
		this.#ms = ms;
	}
	now(): Date {
		return new Date(this.#ms);
	}
	advance(ms: number): void {
		this.#ms += ms;
	}
}

/** 48 random base64url chars — a fresh synthetic credential per call (never a real one). */
export const newCredential = (): string =>
	randomBytes(36).toString("base64url");

export const ORIGIN = "http://127.0.0.1:5173";

// ── fake WorkspaceTx (approval-request rows only) ───────────────────────────

export class FakeTx implements WorkspaceTx {
	readonly rows = new Map<string, ApprovalRequestRow>();
	writes = 0;

	put(row: ApprovalRequestRow): void {
		this.rows.set(row.id, ApprovalRequestRowSchema.parse(row));
	}
	getApprovalRequest(id: string): ApprovalRequestRow | null {
		const r = this.rows.get(id);
		return r ? structuredClone(r) : null;
	}
	updateApprovalRequest(
		id: string,
		expected_rev: number,
		patch: ApprovalRequestPatch,
		now: string,
	): ApprovalRequestRow | null {
		const cur = this.rows.get(id);
		if (!cur || cur.rev !== expected_rev) return null;
		const next = ApprovalRequestRowSchema.parse({
			...cur,
			...patch,
			rev: cur.rev + 1,
			updated_at: now,
		});
		this.rows.set(id, next);
		this.writes += 1;
		return structuredClone(next);
	}
	// unused by the auth module — present to satisfy the port type
	getTask(): null {
		return null;
	}
	getProposal(): null {
		return null;
	}
	listApprovalRequests(): ApprovalRequestRow[] {
		return [...this.rows.values()];
	}
	getDecision(): null {
		return null;
	}
	findReceipt(): ManagedDecisionRow | null {
		return null;
	}
	insertTask(): void {
		throw new Error("not used");
	}
	updateTask(): null {
		throw new Error("not used");
	}
	insertProposal(): void {
		throw new Error("not used");
	}
	insertApprovalRequest(): void {
		throw new Error("not used");
	}
	insertDecision(): void {
		throw new Error("not used");
	}
}

const hex = (seed: string) => sha256Hex(seed);

/** A pending Gate-1 request built through the real builders (validated by the frozen row schema). */
export function runRequestRow(seed = "a"): ApprovalRequestRow {
	const id = newWorkspaceId("wsa");
	const workspace_task_id = newWorkspaceId("wst");
	const proposal_id = newWorkspaceId("wsp");
	const managed_task_id = `task-${crypto.randomUUID()}`;
	const proposal_hash = hex(`proposal-${seed}`);
	const execution = sealExecutionBinding({
		proposal_id,
		proposal_hash,
		managed_task_id,
		base_sha: hex(`base-${seed}`).slice(0, 40),
		policy_hash: hex(`policy-${seed}`),
	});
	const binding = sealRunApprovalBinding({
		approval_request_id: id,
		workspace_task_id,
		proposal_id,
		proposal_hash,
		execution_binding_hash: execution.hash,
	});
	const created = new Date(T0).toISOString();
	return ApprovalRequestRowSchema.parse({
		id,
		workspace_task_id,
		kind: "run",
		proposal_id,
		proposal_hash,
		managed_task_id,
		execution_binding: execution.value,
		execution_binding_hash: execution.hash,
		run_id: null,
		result_envelope: null,
		result_envelope_hash: null,
		binding: binding.value,
		binding_hash: binding.hash,
		status: "pending",
		invalidation_reason: null,
		invalidation_detail: null,
		created_at: created,
		updated_at: created,
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
}

// ── guarded app ─────────────────────────────────────────────────────────────

export const BASE = WORKSPACE_API_BASE;

export interface Harness {
	app: Hono;
	auth: WorkspaceAuth;
	clock: FakeClock;
	tx: FakeTx;
	operatorCredential: string;
	readOnlyCredential: string;
	/** handler invocations per route key (proves a rejected request never reached a route). */
	hits: Map<string, number>;
	/** last VerifiedAuthContext / principal seen by a stub route. */
	seen: { verified: VerifiedAuthContext | null; principal: unknown };
}

/**
 * Builds a hub-like app: the workspace sub-app gets `auth.install` FIRST, then stub routes for every
 * WORKSPACE_ROUTES entry, then is mounted at /api/workspace next to an unrelated /api route.
 * The challenge/decision stubs call the real ChallengePort inside a FakeTx "transaction".
 */
export function harness(
	over: Partial<WorkspaceAuthOptions> = {},
	shared?: { clock?: FakeClock; tx?: FakeTx; operatorCredential?: string },
): Harness {
	const clock = shared?.clock ?? new FakeClock();
	const tx = shared?.tx ?? new FakeTx();
	const operatorCredential = shared?.operatorCredential ?? newCredential();
	const readOnlyCredential = newCredential();
	const auth = createWorkspaceAuth({
		operator_credential: operatorCredential,
		read_only_credential: readOnlyCredential,
		allowed_origin: ORIGIN,
		clock,
		...over,
	});
	const hits = new Map<string, number>();
	const seen: Harness["seen"] = { verified: null, principal: null };
	const hit = (key: string) => hits.set(key, (hits.get(key) ?? 0) + 1);
	const ws = new Hono();
	auth.install(ws);
	const stub = (key: string) => (c: import("hono").Context) => {
		hit(key);
		seen.verified = auth.verified(c);
		seen.principal = auth.principal(c);
		return c.json({ route: key, data: "workspace-data-marker" });
	};
	ws.get("/snapshot", stub("snapshot"));
	ws.post("/tasks", async (c) => {
		hit("tasks");
		seen.verified = auth.verified(c);
		seen.principal = auth.principal(c);
		const body = await c.req.json();
		return c.json({
			route: "tasks",
			principal: seen.principal,
			body_keys: Object.keys(body),
		});
	});
	ws.get("/tasks/:id", stub("task"));
	ws.put("/tasks/:id/draft", stub("draft"));
	ws.post("/tasks/:id/proposals", stub("proposals"));
	ws.post("/tasks/:id/rerun", stub("rerun"));
	ws.post("/tasks/:id/cancel", stub("cancel"));
	ws.get("/tasks/:id/artifacts/:artifact_id", stub("artifact"));
	ws.post("/approval-requests/:id/challenge", async (c) => {
		hit("challenge");
		const verified = auth.verified(c);
		if (!verified) return c.json({ error: "no auth" }, 500);
		const row = tx.getApprovalRequest(c.req.param("id"));
		if (!row) return c.json({ error: "not_found" }, 404);
		try {
			return c.json(auth.challenges.issue(tx, row, verified, clock.now()), 201);
		} catch (err) {
			return c.json(
				{ error: (err as { code?: string }).code ?? "internal" },
				409,
			);
		}
	});
	ws.post("/approval-requests/:id/decisions", async (c) => {
		hit("decisions");
		const verified = auth.verified(c);
		if (!verified) return c.json({ error: "no auth" }, 500);
		const body = (await c.req.json()) as { challenge?: unknown };
		const row = tx.getApprovalRequest(c.req.param("id"));
		if (!row) return c.json({ error: "not_found" }, 404);
		const res = auth.challenges.verifyAndConsume(
			tx,
			row,
			body.challenge as string,
			verified,
			clock.now(),
		);
		return res.ok
			? c.json({ ok: true, rev: res.request.rev }, 201)
			: c.json({ error: res.code }, 409);
	});
	const app = new Hono();
	app.route(BASE, ws);
	app.get("/api/repos", (c) => c.json({ repos: [] }));
	return {
		app,
		auth,
		clock,
		tx,
		operatorCredential,
		readOnlyCredential,
		hits,
		seen,
	};
}

export interface Session {
	cookie: string;
	csrf: string;
	setCookie: string;
	body: Record<string, unknown>;
}

/** Sign in through the real route (exact Origin + JSON). Throws if it does not succeed. */
export async function signIn(
	h: Harness,
	credential = h.operatorCredential,
	extraHeaders: Record<string, string> = {},
): Promise<Session> {
	const res = await h.app.request(`${BASE}/session`, {
		method: "POST",
		headers: {
			origin: ORIGIN,
			"content-type": "application/json",
			...extraHeaders,
		},
		body: JSON.stringify({ credential }),
	});
	if (res.status !== 200) throw new Error(`sign-in failed: ${res.status}`);
	const setCookie = res.headers.get("set-cookie") ?? "";
	const value =
		new RegExp(`^${SESSION_COOKIE}=([^;]*)`).exec(setCookie)?.[1] ?? "";
	const body = (await res.json()) as Record<string, unknown>;
	return {
		cookie: `${SESSION_COOKIE}=${value}`,
		csrf: String(body.csrf_token),
		setCookie,
		body,
	};
}

/** Fully valid mutation headers for a session; `over` replaces or (undefined) removes one. */
export function mutationHeaders(
	s: Session,
	over: Record<string, string | undefined> = {},
): Record<string, string> {
	const base: Record<string, string | undefined> = {
		cookie: s.cookie,
		origin: ORIGIN,
		[CSRF_HEADER]: s.csrf,
		"content-type": "application/json",
		...over,
	};
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
	return out;
}

/** Capture every console.* call while `fn` runs. */
export async function captureConsole<T>(
	fn: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
	const lines: string[] = [];
	const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
	const saved = methods.map((m) => console[m]);
	for (const m of methods)
		console[m] = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};
	try {
		return { result: await fn(), lines };
	} finally {
		methods.forEach((m, i) => {
			console[m] = saved[i] as (typeof console)[typeof m];
		});
	}
}
