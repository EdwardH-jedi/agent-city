// /api/managed — managed tasks. Unlike the read-only telemetry API, these routes can start
// processes, so loopback binding + the Host guard are not treated as authentication:
//   - every route needs `Authorization: Bearer $MANAGED_TOKEN` (unset → 503, nothing is served)
//   - mutations also need `content-type: application/json` and, when the browser sends an Origin,
//     an allowed one. A cross-site page cannot set the bearer header (CORS preflight fails) and a
//     cross-site form cannot send JSON, so there is no ambient-credential path.
//   - inputs are validated by zod (strict objects); ids are pattern-checked; artifacts are addressed
//     by id only, never by path.
import {
	DEFAULT_REPAIR_LIMIT,
	LIVE_INTEGRATION_VERIFIED,
	MANAGED_CONTRACT,
	MAX_REPAIR_LIMIT,
	SimulationScenario,
} from "@agent-city/schema";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
	allTasks,
	cancelTask,
	type ManagedDeps,
	publicConfig,
	readTaskArtifact,
	runTask,
	ServiceError,
	submitTask,
	taskDetail,
} from "../managed/service.ts";
import { isAllowedOrigin, type SecurityConfig } from "../security.ts";
import { tokenMatches } from "./ingest.ts";

const MAX_BODY_BYTES = 64 * 1024;
const TASK_ID = /^task-[0-9a-f-]{36}$/;
const ARTIFACT_ID = /^art-[0-9a-f-]{36}$/;

export interface ManagedApiOptions {
	deps: ManagedDeps;
	/** Unset / empty → the whole managed API answers 503. */
	token: string | undefined;
	security: SecurityConfig;
	/** Wake the worker after a Run / Cancel. */
	poke?: () => void;
}

/** Shown when the hub was started without MANAGED_CONFIG / MANAGED_TOKEN. */
export function managedDisabled(reason: string): Hono {
	const api = new Hono();
	api.all("*", (c) => c.json({ error: "managed runs disabled", reason }, 503));
	return api;
}

export function createManagedApi(o: ManagedApiOptions): Hono {
	const api = new Hono();
	const { deps } = o;

	api.use("*", async (c, next) => {
		if (!o.token)
			return c.json(
				{ error: "managed runs disabled", reason: "MANAGED_TOKEN is not set" },
				503,
			);
		const m = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "");
		if (!m?.[1] || !tokenMatches(m[1].trim(), o.token))
			return c.json({ error: "unauthorized" }, 401);
		if (c.req.method !== "GET") {
			const origin = c.req.header("origin");
			if (origin !== undefined && !isAllowedOrigin(origin, o.security))
				return c.json({ error: "forbidden origin" }, 403);
			if (!/^application\/json\b/i.test(c.req.header("content-type") ?? ""))
				return c.json({ error: "content-type must be application/json" }, 415);
		}
		c.header("cache-control", "no-store");
		c.header("x-content-type-options", "nosniff");
		await next();
	});

	const fail = (c: Context, err: unknown) => {
		if (err instanceof ServiceError)
			return c.json(
				{ error: err.code, message: err.message, issues: err.issues },
				err.status,
			);
		throw err;
	};
	const limit = bodyLimit({
		maxSize: MAX_BODY_BYTES,
		onError: (c) => c.json({ error: "payload too large" }, 413),
	});
	const notFound = (c: Context) => c.json({ error: "not_found" }, 404);

	api.get("/config", (c) =>
		c.json({
			contract: MANAGED_CONTRACT,
			...publicConfig(deps.config),
			repair_limit: { default: DEFAULT_REPAIR_LIMIT, max: MAX_REPAIR_LIMIT },
			scenarios: SimulationScenario.options,
			// false until a documented live smoke run has been made; the UI labels live results with it
			live_integration_verified: LIVE_INTEGRATION_VERIFIED,
		}),
	);

	api.get("/tasks", (c) => c.json({ tasks: allTasks(deps) }));

	api.post("/tasks", limit, async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid JSON" }, 400);
		}
		try {
			const { task, created } = await submitTask(deps, body);
			return c.json({ task, created }, created ? 201 : 200);
		} catch (err) {
			return fail(c, err);
		}
	});

	api.get("/tasks/:id", async (c) => {
		const id = c.req.param("id");
		if (!TASK_ID.test(id)) return notFound(c);
		try {
			return c.json(await taskDetail(deps, id));
		} catch (err) {
			return fail(c, err);
		}
	});

	api.post("/tasks/:id/run", limit, (c) => {
		const id = c.req.param("id");
		if (!TASK_ID.test(id)) return notFound(c);
		try {
			const res = runTask(deps, id);
			if (res.queued) o.poke?.();
			return c.json(res);
		} catch (err) {
			return fail(c, err);
		}
	});

	api.post("/tasks/:id/cancel", limit, (c) => {
		const id = c.req.param("id");
		if (!TASK_ID.test(id)) return notFound(c);
		try {
			const task = cancelTask(deps, id);
			o.poke?.();
			return c.json({ task });
		} catch (err) {
			return fail(c, err);
		}
	});

	// Artifact text as JSON (the UI renders it as text). Addressed by ids — there is no path
	// parameter, and the stored path is re-validated against the artifacts root on every read.
	api.get("/tasks/:id/artifacts/:artifactId", (c) => {
		const id = c.req.param("id");
		const artifactId = c.req.param("artifactId");
		if (!TASK_ID.test(id) || !ARTIFACT_ID.test(artifactId)) return notFound(c);
		try {
			const { artifact, text, truncated } = readTaskArtifact(
				deps,
				id,
				artifactId,
			);
			return c.json({ artifact, text, truncated });
		} catch (err) {
			return fail(c, err);
		}
	});

	return api;
}
