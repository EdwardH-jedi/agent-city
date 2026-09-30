import type { Database } from "bun:sqlite";
import { redact } from "@agent-city/schema";
import { Hono } from "hono";
import { openDb } from "./db.ts";
import { runConfiguredSync } from "./github/sync.ts";
import { loadManagedConfig, type ManagedConfig } from "./managed/config.ts";
import { Orchestrator } from "./managed/orchestrator.ts";
import type { ManagedDeps } from "./managed/service.ts";
import { createAdapters, startWorker } from "./managed/worker.ts";
import { createApi } from "./routes/api.ts";
import { createIngest } from "./routes/ingest.ts";
import { createManagedApi, managedDisabled } from "./routes/managed.ts";
import { createBroadcaster, type Publish, websocket } from "./routes/ws.ts";
import {
	checkWsRequest,
	corsGuard,
	hostGuard,
	type SecurityConfig,
} from "./security.ts";
import { listReposByDistrict, sweepStale } from "./store.ts";

export const STALE_SWEEP_MS = 60_000;

export interface AppDeps {
	db: Database;
	ingestToken: string | undefined;
	publish: Publish;
	/** Host/Origin allowlists; defaults to a 127.0.0.1-bound hub. */
	security?: SecurityConfig;
	/** Managed runs. Absent → /api/managed answers 503 and nothing can be started. */
	managed?: {
		deps: ManagedDeps;
		token: string | undefined;
		poke?: () => void;
	};
}

export function createApp(deps: AppDeps): Hono {
	const app = new Hono();
	const security = deps.security ?? { hubHost: "127.0.0.1" };
	const spoolDrops = new Map<string, number>();

	// First: reject foreign Host headers (DNS rebinding) on every route, /healthz included.
	app.use("*", hostGuard(security));
	app.use("*", corsGuard(security));

	app.get("/healthz", (c) =>
		c.json({
			ok: true,
			machine: process.env.AGENTCITY_MACHINE ?? null,
			ingest: deps.ingestToken ? "enabled" : "disabled",
			// events each machine's collector spool discarded (size / age / rejected caps), cumulative
			spool_dropped: Object.fromEntries(spoolDrops),
			time: new Date().toISOString(),
		}),
	);
	app.route("/ingest", createIngest({ ...deps, spoolDrops }));
	app.route(
		"/api/managed",
		deps.managed
			? createManagedApi({ ...deps.managed, security })
			: managedDisabled("MANAGED_CONFIG is not set"),
	);
	app.route("/api", createApi(deps.db));

	app.onError((err, c) => {
		// Message only — never the request body.
		console.error(`[hub] ${c.req.method} ${c.req.path} failed: ${err.message}`);
		return c.json({ error: "internal error" }, 500);
	});
	return app;
}

export interface HubOptions {
	db: Database;
	ingestToken: string | undefined;
	hostname: string;
	port: number;
	staleSweepMs?: number;
	/** Extra exact origins allowed for CORS and /ws (HUB_ALLOWED_ORIGINS). */
	extraOrigins?: readonly string[];
	/** Managed runs: trusted config + API token. Absent → no worker, /api/managed is 503. */
	managed?: { config: ManagedConfig; token: string | undefined };
	managedIdleMs?: number;
}

/** Serve HTTP + /ws and run the stale sweep (once now, then every `staleSweepMs`). */
export function startHub(opts: HubOptions) {
	const broadcaster = createBroadcaster();
	const security: SecurityConfig = {
		hubHost: opts.hostname,
		extraOrigins: opts.extraOrigins ?? [],
	};
	// One in-hub worker for managed tasks. Only task ids are broadcast; content stays behind the token.
	const managedDeps: ManagedDeps | null = opts.managed
		? {
				db: opts.db,
				config: opts.managed.config,
				onChange: (taskId) =>
					broadcaster.publish("managed", { task_id: taskId }),
			}
		: null;
	const worker = managedDeps
		? startWorker(
				new Orchestrator({
					db: opts.db,
					config: managedDeps.config,
					adapters: createAdapters(managedDeps.config),
					onChange: managedDeps.onChange,
				}),
				opts.managedIdleMs,
			)
		: null;
	const app = createApp({
		db: opts.db,
		ingestToken: opts.ingestToken,
		publish: broadcaster.publish,
		security,
		managed: managedDeps
			? {
					deps: managedDeps,
					token: opts.managed?.token,
					poke: () => worker?.poke(),
				}
			: undefined,
	});

	const server = Bun.serve({
		hostname: opts.hostname,
		port: opts.port,
		fetch(req, srv) {
			if (new URL(req.url).pathname === "/ws") {
				// Host + Origin checked before the upgrade; a refused client never gets a socket.
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

	const sweep = () => {
		try {
			for (const s of sweepStale(opts.db, new Date())) {
				broadcaster.publish("session", s);
			}
		} catch (err) {
			console.error(`[hub] stale sweep failed: ${(err as Error).message}`);
		}
	};
	sweep();
	const timer = setInterval(sweep, opts.staleSweepMs ?? STALE_SWEEP_MS);

	return {
		server,
		publish: broadcaster.publish,
		/** Without a managed worker this stops synchronously; with one, after its child is stopped. */
		stop(): Promise<void> {
			clearInterval(timer);
			if (!worker) {
				server.stop(true);
				return Promise.resolve();
			}
			return worker.stop().then(() => {
				server.stop(true);
			});
		},
	};
}

/**
 * GitHub sync inside the hub: once at startup, then every `intervalMin`. A cycle is skipped while
 * the previous one still runs; changed repo rows are broadcast as `repo`. Logs counts only.
 */
export function scheduleGithubSync(
	db: Database,
	publish: Publish,
	intervalMin: number,
	runSync: (
		db: Database,
	) => ReturnType<typeof runConfiguredSync> = runConfiguredSync,
): () => void {
	let running = false;
	const run = async () => {
		if (running) return;
		running = true;
		try {
			const s = await runSync(db);
			const changed = new Set(s.changedRepoIds);
			for (const list of Object.values(listReposByDistrict(db))) {
				for (const repo of list)
					if (changed.has(repo.id)) publish("repo", repo);
			}
			// sync re-pointed sessions/events to canonical repo ids → clients re-fetch (N07)
			if (s.remappedRefs > 0)
				publish("invalidate", { scope: ["sessions", "events"] });
			console.log(
				`[github] ${s.total} repos, ${changed.size} changed, rate graphql ${s.rate.graphql.remaining ?? "?"} core ${s.rate.core.remaining ?? "?"}${s.aborted ? ` — aborted: ${s.aborted}` : ""}`,
			);
		} catch (err) {
			console.error(`[github] sync failed: ${redact((err as Error).message)}`);
		} finally {
			running = false;
		}
	};
	void run();
	const timer = setInterval(run, intervalMin * 60_000);
	return () => clearInterval(timer);
}

if (import.meta.main) {
	const hostname = process.env.HUB_HOST || "127.0.0.1";
	const port = Number(process.env.HUB_PORT || 4317);
	const dbPath = process.env.DB_PATH || "./data/agentcity.db";
	const ingestToken = process.env.INGEST_TOKEN || undefined;
	const syncMin = Number(process.env.GITHUB_SYNC_INTERVAL_MIN || 0);
	const extraOrigins = (process.env.HUB_ALLOWED_ORIGINS ?? "")
		.split(",")
		.map((o) => o.trim())
		.filter(Boolean);

	// Managed runs are off unless a trusted config file is named. Its contents are never logged.
	const managedPath = process.env.MANAGED_CONFIG || undefined;
	const managedToken = process.env.MANAGED_TOKEN || undefined;
	let managed: HubOptions["managed"];
	if (managedPath) {
		try {
			managed = { config: loadManagedConfig(managedPath), token: managedToken };
		} catch (err) {
			console.error(
				`[managed] config not loaded — managed runs disabled: ${redact((err as Error).message)}`,
			);
		}
	}

	const db = openDb(dbPath);
	const { server, publish } = startHub({
		db,
		ingestToken,
		hostname,
		port,
		extraOrigins,
		managed,
	});
	console.log(
		`[hub] listening on http://${server.hostname}:${server.port} (db: ${dbPath})`,
	);
	if (!ingestToken) {
		console.warn("[hub] INGEST_TOKEN is not set — /ingest is disabled (503)");
	}
	if (!managed) {
		console.log(
			managedPath
				? "[managed] disabled (the config could not be loaded, see above)"
				: "[managed] disabled (MANAGED_CONFIG is not set)",
		);
	} else {
		console.log(
			`[managed] ${managed.config.repos.length} allowed repo(s), live execution ${managed.config.live.enabled ? "ENABLED" : "off (simulated only)"}`,
		);
		if (!managedToken)
			console.warn(
				"[managed] MANAGED_TOKEN is not set — /api/managed is disabled (503)",
			);
	}
	if (syncMin > 0) {
		scheduleGithubSync(db, publish, syncMin);
		console.log(`[hub] GitHub sync every ${syncMin} min`);
	} else {
		console.log("[hub] GitHub sync disabled (GITHUB_SYNC_INTERVAL_MIN=0)");
	}
}
