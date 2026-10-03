// /api/managed: authorization, browser-request protection, input validation, artifact access, and
// the end-to-end flow through a real hub (HTTP + in-hub worker + /ws) on a disposable fixture repo.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDb } from "../db.ts";
import { createApp, startHub } from "../index.ts";
import { type Fixture, type FixtureOptions, makeFixture } from "./testkit.ts";

const TOKEN = "test-managed-token";
const INGEST = "test-ingest-token";

let fixtures: Fixture[] = [];
let stops: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const s of stops) await s();
	stops = [];
	for (const f of fixtures) f.cleanup();
	fixtures = [];
});

let seq = 0;
const body = (fx: Fixture, over: Record<string, unknown> = {}) => ({
	idempotency_key: `api-key-${++seq}-${Date.now()}`,
	repo_id: fx.repoId,
	title: "API task",
	objective: "Drive the pipeline through the HTTP API.",
	acceptance_criteria: ["The fixture check passes"],
	approved_scope: ["."],
	execution_mode: "simulated",
	simulation_scenario: "approve",
	...over,
});

/** In-process app (no worker): for auth / validation / artifact-access checks. */
function app(opts: FixtureOptions & { token?: string | null } = {}) {
	const fx = makeFixture(opts);
	fixtures.push(fx);
	const a = createApp({
		db: fx.db,
		ingestToken: INGEST,
		publish: () => {},
		managed: {
			deps: { db: fx.db, config: fx.config },
			token: opts.token === null ? undefined : (opts.token ?? TOKEN),
		},
	});
	const call = (
		path: string,
		init: {
			method?: string;
			json?: unknown;
			raw?: string;
			headers?: Record<string, string>;
			auth?: string | null;
		} = {},
	) => {
		const headers: Record<string, string> = { ...init.headers };
		if (init.auth !== null)
			headers.authorization = init.auth ?? `Bearer ${TOKEN}`;
		if (init.json !== undefined || init.raw !== undefined)
			headers["content-type"] ??= "application/json";
		return Promise.resolve(
			a.request(`/api/managed${path}`, {
				method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
				headers,
				body:
					init.raw ??
					(init.json !== undefined ? JSON.stringify(init.json) : undefined),
			}),
		);
	};
	return { fx, a, call };
}

describe("authorization and browser-request protection", () => {
	test("hub without a managed config: 503 for everything, telemetry unaffected", async () => {
		const db = openDb(":memory:");
		const a = createApp({ db, ingestToken: INGEST, publish: () => {} });
		for (const [method, path] of [
			["GET", "/api/managed/tasks"],
			["POST", "/api/managed/tasks"],
			["POST", "/api/managed/tasks/task-x/run"],
		] as const)
			expect((await a.request(path, { method })).status).toBe(503);
		expect((await a.request("/api/sessions")).status).toBe(200);
		expect((await a.request("/healthz")).status).toBe(200);
		db.close();
	});

	test("no MANAGED_TOKEN configured → 503 even with a config", async () => {
		const { call } = app({ token: null });
		expect((await call("/tasks")).status).toBe(503);
		expect((await call("/tasks", { json: {} })).status).toBe(503);
	});

	test("missing / wrong bearer → 401 on reads and writes; the ingest token is not accepted", async () => {
		const { fx, call } = app();
		for (const auth of [
			null,
			"Bearer wrong",
			`Bearer ${INGEST}`,
			`Basic ${TOKEN}`,
			TOKEN,
		]) {
			expect((await call("/tasks", { auth })).status).toBe(401);
			expect((await call("/config", { auth })).status).toBe(401);
			expect((await call("/tasks", { json: body(fx), auth })).status).toBe(401);
		}
		expect((await call("/tasks")).status).toBe(200);
	});

	test("loopback alone is not enough: a foreign Origin or a non-JSON body cannot start anything", async () => {
		const { fx, a, call } = app();
		expect(
			(
				await call("/tasks", {
					json: body(fx),
					headers: { origin: "https://evil.example" },
				})
			).status,
		).toBe(403);
		// a cross-site <form> can only send these content types
		for (const ct of [
			"text/plain",
			"application/x-www-form-urlencoded",
			"multipart/form-data",
		])
			expect(
				(
					await call("/tasks", {
						method: "POST",
						raw: JSON.stringify(body(fx)),
						headers: { "content-type": ct },
					})
				).status,
			).toBe(415);
		// the preflight a browser sends before a cross-origin bearer request is refused
		const preflight = await a.request("/api/managed/tasks", {
			method: "OPTIONS",
			headers: {
				origin: "https://evil.example",
				"access-control-request-method": "POST",
				"access-control-request-headers": "authorization, content-type",
			},
		});
		expect(preflight.status).toBe(403);
		// forged Host (DNS rebinding) is refused before anything else
		expect(
			(await call("/tasks", { headers: { host: "evil.example" } })).status,
		).toBe(403);
		// same-origin dev UI is fine
		expect(
			(
				await call("/tasks", {
					json: body(fx),
					headers: { origin: "http://127.0.0.1:5173" },
				})
			).status,
		).toBe(201);
		expect(
			((await (await call("/tasks")).json()) as { tasks: unknown[] }).tasks,
		).toHaveLength(1);
	});
});

describe("task submission over HTTP", () => {
	test("create is idempotent; validation errors carry field paths and never echo the body", async () => {
		const { fx, call } = app();
		const b = body(fx);
		const first = await call("/tasks", { json: b });
		expect(first.status).toBe(201);
		const created = (await first.json()) as {
			task: { id: string; state: string };
			created: boolean;
		};
		expect(created.task.state).toBe("draft");

		const repeat = await call("/tasks", { json: b });
		expect(repeat.status).toBe(200);
		expect(((await repeat.json()) as typeof created).task.id).toBe(
			created.task.id,
		);

		expect(
			(await call("/tasks", { json: { ...b, title: "changed" } })).status,
		).toBe(409);

		const bad = await call("/tasks", {
			json: body(fx, {
				objective: "",
				approved_scope: ["../../etc"],
				command: "rm -rf /",
			}),
		});
		expect(bad.status).toBe(400);
		const err = (await bad.json()) as {
			error: string;
			issues: { path: string }[];
		};
		expect(err.error).toBe("invalid_task");
		expect(err.issues.map((i) => i.path).sort()).toEqual([
			"",
			"approved_scope.0",
			"objective",
		]);
		expect(JSON.stringify(err)).not.toContain("rm -rf");

		expect(
			(await call("/tasks", { json: body(fx, { repo_id: "someone/else" }) }))
				.status,
		).toBe(422);
		expect(
			(
				await call("/tasks", {
					json: body(fx, {
						execution_mode: "live",
						simulation_scenario: undefined,
					}),
				})
			).status,
		).toBe(409);
		expect(
			(await call("/tasks", { method: "POST", raw: "{not json" })).status,
		).toBe(400);
		expect(
			(
				await call("/tasks", {
					json: body(fx, { objective: "x".repeat(70_000) }),
				})
			).status,
		).toBe(413);
	});

	test("run / cancel: unknown and malformed ids are 404; cancel of a draft is immediate", async () => {
		const { fx, call } = app();
		expect(
			(
				await call("/tasks/task-00000000-0000-0000-0000-000000000000/run", {
					json: {},
				})
			).status,
		).toBe(404);
		expect((await call("/tasks/..%2F..%2Fetc/run", { json: {} })).status).toBe(
			404,
		);
		expect((await call("/tasks/not-an-id")).status).toBe(404);
		const { task } = (await (
			await call("/tasks", { json: body(fx) })
		).json()) as { task: { id: string } };
		const cancelled = (await (
			await call(`/tasks/${task.id}/cancel`, { json: {} })
		).json()) as {
			task: { state: string };
		};
		expect(cancelled.task.state).toBe("cancelled");
		const rerun = (await (
			await call(`/tasks/${task.id}/run`, { json: {} })
		).json()) as { queued: boolean };
		expect(rerun.queued).toBe(false);
	});

	test("the config endpoint exposes ids and names only — no host paths, no executables", async () => {
		const { fx, call } = app({ liveStubs: {} });
		const text = await (await call("/config")).text();
		const cfg = JSON.parse(text) as Record<string, unknown>;
		expect(cfg).toMatchObject({
			contract: "agentcity.managed/v1",
			repos: [
				{ id: fx.repoId, base_ref: "main", verification: ["fixture-check"] },
			],
			live: { enabled: true, implementer: "claude", reviewer: "codex" },
			repair_limit: { default: 1, max: 3 },
			live_integration_verified: false,
		});
		expect(text).not.toContain(fx.dir);
		expect(text).not.toContain("/bin/");
	});
});

// ── end to end through a real hub ────────────────────────────────────────────

async function hub(fx: Fixture) {
	const h = startHub({
		db: fx.db,
		ingestToken: INGEST,
		hostname: "127.0.0.1",
		port: 0,
		managed: { config: fx.config, token: TOKEN },
		managedIdleMs: 50,
	});
	stops.push(() => h.stop());
	const base = `http://127.0.0.1:${h.server.port}`;
	const api = async <T>(path: string, json?: unknown): Promise<T> => {
		const res = await fetch(`${base}/api/managed${path}`, {
			method: json === undefined ? "GET" : "POST",
			headers: {
				authorization: `Bearer ${TOKEN}`,
				...(json === undefined ? {} : { "content-type": "application/json" }),
			},
			body: json === undefined ? undefined : JSON.stringify(json),
		});
		return (await res.json()) as T;
	};
	const settled = async (id: string) => {
		const deadline = Date.now() + 15_000;
		for (;;) {
			const d = await api<Detail>(`/tasks/${id}`);
			if (
				![
					"draft",
					"queued",
					"executing",
					"verifying",
					"reviewing",
					"repairing",
				].includes(d.task.state)
			)
				return d;
			if (Date.now() > deadline)
				throw new Error(`task stuck in ${d.task.state}`);
			await Bun.sleep(40);
		}
	};
	return { h, base, api, settled };
}

interface Detail {
	task: {
		id: string;
		state: string;
		execution_mode: string;
		failure_kind: string | null;
	};
	runs: { id: string; outcome: string | null; candidate_sha: string | null }[];
	reviews: { valid: boolean; verdict: string | null }[];
	artifacts: { id: string; name: string; kind: string; rel_path: string }[];
	integrity: { intact: boolean } | null;
}

describe("end to end through the hub (HTTP + worker + /ws)", () => {
	test("create → run → human_ready; /ws carries no managed frames or ids; state survives a hub restart", async () => {
		const fx = makeFixture({ dbFile: true });
		fixtures.push(fx);
		const first = await hub(fx);

		const frames: string[] = [];
		const ws = new WebSocket(`${first.base.replace("http", "ws")}/ws`);
		ws.onmessage = (m) => frames.push(String(m.data));
		await new Promise((r) => {
			ws.onopen = r;
		});

		const { task } = await first.api<{ task: { id: string } }>(
			"/tasks",
			body(fx, { simulation_scenario: "reject_then_approve" }),
		);
		// double-click on Run: exactly one of them queues
		const [r1, r2] = await Promise.all([
			first.api<{ queued: boolean }>(`/tasks/${task.id}/run`, {}),
			first.api<{ queued: boolean }>(`/tasks/${task.id}/run`, {}),
		]);
		expect([r1.queued, r2.queued].sort()).toEqual([false, true]);

		const d = await first.settled(task.id);
		expect(d.task).toMatchObject({
			state: "human_ready",
			execution_mode: "simulated",
		});
		expect(d.runs.map((r) => r.outcome)).toEqual(["rejected", "approved"]);
		expect(d.reviews.map((r) => [r.verdict, r.valid])).toEqual([
			["reject", true],
			["approve", true],
		]);
		expect(d.integrity).toEqual({ intact: true, reason: null } as never);

		// artifact text comes back as JSON, by id
		const diff = d.artifacts.find(
			(a) =>
				a.name === "diff.patch" && a.rel_path.includes(d.runs[1]?.id ?? "-"),
		);
		const art = await first.api<{ text: string; truncated: boolean }>(
			`/tasks/${task.id}/artifacts/${diff?.id}`,
		);
		expect(art.text).toContain("agentcity-sim/verify.status");
		expect(art.truncated).toBe(false);

		// /ws (unauthenticated): no managed frame, no managed id, no managed content (M1 L4)
		await Bun.sleep(50);
		ws.close();
		const kinds = frames.map((f) => (JSON.parse(f) as { kind: string }).kind);
		expect(kinds).not.toContain("managed");
		expect(frames.join("\n")).not.toContain(task.id);
		expect(frames.join("\n")).not.toContain("Drive the pipeline");

		// restart: a new hub process on the same DB shows the same task, and does not run it again
		await stops.pop()?.();
		fx.db.close();
		const reopened = { ...fx, db: openDb(fx.dbPath) };
		fixtures[fixtures.length - 1] = reopened;
		const second = await hub(reopened);
		const after = await second.api<Detail>(`/tasks/${task.id}`);
		expect(after.task.state).toBe("human_ready");
		expect(after.runs).toHaveLength(2);
		await Bun.sleep(150);
		expect((await second.api<Detail>(`/tasks/${task.id}`)).runs).toHaveLength(
			2,
		);
		expect(
			(await second.api<{ tasks: unknown[] }>("/tasks")).tasks,
		).toHaveLength(1);
	});

	test("cancel through the API stops a running child and ends in cancelled", async () => {
		const fx = makeFixture();
		fixtures.push(fx);
		const { api, settled } = await hub(fx);
		const { task } = await api<{ task: { id: string } }>(
			"/tasks",
			body(fx, { simulation_scenario: "impl_hangs" }),
		);
		await api(`/tasks/${task.id}/run`, {});
		const deadline = Date.now() + 10_000;
		while (
			(await api<Detail>(`/tasks/${task.id}`)).task.state !== "executing"
		) {
			if (Date.now() > deadline) throw new Error("never started");
			await Bun.sleep(30);
		}
		await Bun.sleep(100); // let the child start
		await api(`/tasks/${task.id}/cancel`, {});
		await api(`/tasks/${task.id}/cancel`, {}); // double click
		const d = await settled(task.id);
		expect(d.task).toMatchObject({
			state: "cancelled",
			failure_kind: "cancelled",
		});
	});

	test("telemetry ingest and redaction behave as before while managed runs are enabled", async () => {
		const fx = makeFixture();
		fixtures.push(fx);
		const { base } = await hub(fx);
		const fake = `ghp_${"Zz09".repeat(9)}`; // assembled at runtime, not a real token
		const res = await fetch(`${base}/ingest`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${INGEST}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				id: "telemetry-1",
				ts: new Date().toISOString(),
				machine_id: "cockpit",
				session_id: "observed-1",
				provider: "claude",
				type: "PreToolUse",
				summary: `curl -H x ${fake}`,
			}),
		});
		expect(res.status).toBe(200);
		const sessions = (await (await fetch(`${base}/api/sessions`)).json()) as {
			sessions: { id: string; status: string }[];
		};
		expect(sessions.sessions).toEqual([
			expect.objectContaining({ id: "claude:observed-1", status: "active" }),
		]);
		const events = await (await fetch(`${base}/api/events`)).text();
		expect(events).not.toContain(fake);
		expect(events).toContain("[REDACTED]");
		// an observed session is not a managed task, and vice versa
		const tasks = (await (
			await fetch(`${base}/api/managed/tasks`, {
				headers: { authorization: `Bearer ${TOKEN}` },
			})
		).json()) as { tasks: unknown[] };
		expect(tasks.tasks).toHaveLength(0);
	});
});

describe("artifact access", () => {
	async function ready() {
		const fx = makeFixture();
		fixtures.push(fx);
		const h = await hub(fx);
		const { task } = await h.api<{ task: { id: string } }>("/tasks", body(fx));
		await h.api(`/tasks/${task.id}/run`, {});
		const d = await h.settled(task.id);
		const status = async (path: string) =>
			(
				await fetch(`${h.base}/api/managed${path}`, {
					headers: { authorization: `Bearer ${TOKEN}` },
				})
			).status;
		return { fx, d, status, ...h };
	}

	test("only by (task id, artifact id): no path parameter, no traversal, no cross-task reads", async () => {
		const { fx, d, status, api, base } = await ready();
		const art = d.artifacts[0];
		if (!art) throw new Error("no artifact");
		expect(await status(`/tasks/${d.task.id}/artifacts/${art.id}`)).toBe(200);
		for (const bad of [
			"..%2F..%2F..%2Fetc%2Fpasswd",
			"%2Fetc%2Fpasswd",
			art.rel_path.replaceAll("/", "%2F"),
			"art-00000000-0000-0000-0000-000000000000",
			`${art.id}%00`,
		])
			expect(await status(`/tasks/${d.task.id}/artifacts/${bad}`)).toBe(404);
		expect(
			await status(
				`/tasks/${d.task.id}/artifacts/${art.id}/../../../../etc/passwd`,
			),
		).toBe(404);

		// an artifact of another task is not reachable through this task's id
		const other = await api<{ task: { id: string } }>("/tasks", body(fx));
		expect(await status(`/tasks/${other.task.id}/artifacts/${art.id}`)).toBe(
			404,
		);
		// without the token: nothing
		expect(
			(
				await fetch(
					`${base}/api/managed/tasks/${d.task.id}/artifacts/${art.id}`,
				)
			).status,
		).toBe(401);
	});

	test("a tampered row or a planted symlink cannot turn the route into a host-file reader", async () => {
		const { fx, d, status, base } = await ready();
		const [a, b] = d.artifacts;
		if (!a || !b) throw new Error("need two artifacts");
		const secret = join(fx.dir, "outside-secret.txt");
		writeFileSync(secret, "HOST-FILE-CONTENT");

		// row pointing outside the artifacts root
		fx.db.run("UPDATE managed_artifacts SET rel_path = ? WHERE id = ?", [
			"../outside-secret.txt",
			a.id,
		]);
		expect(await status(`/tasks/${d.task.id}/artifacts/${a.id}`)).toBe(404);
		fx.db.run("UPDATE managed_artifacts SET rel_path = ? WHERE id = ?", [
			secret,
			a.id,
		]);
		expect(await status(`/tasks/${d.task.id}/artifacts/${a.id}`)).toBe(404);

		// the artifact file replaced by a symlink to a host file
		const abs = join(fx.config.artifacts_root, b.rel_path);
		rmSync(abs);
		symlinkSync(secret, abs);
		// refused as an integrity failure (v0.1.1): the content is never served
		expect(await status(`/tasks/${d.task.id}/artifacts/${b.id}`)).toBe(409);
		const refused = await fetch(
			`${base}/api/managed/tasks/${d.task.id}/artifacts/${b.id}`,
			{ headers: { authorization: `Bearer ${TOKEN}` } },
		);
		const refusedBody = await refused.text();
		expect(refusedBody).toContain("artifact_integrity");
		expect(refusedBody).not.toContain("HOST-FILE-CONTENT");

		// a symlinked directory inside the root pointing outside
		const viaDir = join(fx.config.artifacts_root, "linked");
		symlinkSync(fx.dir, viaDir);
		mkdirSync(dirname(abs), { recursive: true });
		fx.db.run("UPDATE managed_artifacts SET rel_path = ? WHERE id = ?", [
			"linked/outside-secret.txt",
			a.id,
		]);
		expect(await status(`/tasks/${d.task.id}/artifacts/${a.id}`)).toBe(404);
	});
});
