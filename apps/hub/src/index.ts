import type { Database } from "bun:sqlite";
import { redact } from "@agent-city/schema";
import { Hono } from "hono";
import { openDb } from "./db.ts";
import { runConfiguredSync } from "./github/sync.ts";
import { createApi } from "./routes/api.ts";
import { createIngest } from "./routes/ingest.ts";
import { createRunsIngest } from "./routes/runs.ts";
import {
	createBroadcaster,
	createWebsocket,
	type Publish,
} from "./routes/ws.ts";
import {
	checkWsRequest,
	corsGuard,
	hostGuard,
	type SecurityConfig,
} from "./security.ts";
import { resolveWebDist, webStatic } from "./static.ts";
import { listReposByDistrict, sweepStale, usageSummary } from "./store.ts";

export const STALE_SWEEP_MS = 60_000;
/** Default bind: loopback only. Serving the web UI does not change it. */
export const DEFAULT_HUB_HOST = "127.0.0.1";

/** Bind address from the environment: HUB_HOST, else loopback. */
export const hubHostFromEnv = (env: Record<string, string | undefined>) =>
	env.HUB_HOST || DEFAULT_HUB_HOST;

export interface AppDeps {
	db: Database;
	ingestToken: string | undefined;
	publish: Publish;
	/** Clock for heartbeat receive time and machine liveness; tests inject one. */
	now?: () => Date;
	/**
	 * OFFICE_PROJECTION_TOKEN for POST /ingest/runs (the cockpit's run reports). Unset → 503. It must
	 * differ from `ingestToken`; if both are the same value the run route stays disabled.
	 */
	officeToken?: string;
	/** Host/Origin allowlists; defaults to a 127.0.0.1-bound hub. */
	security?: SecurityConfig;
	/** Real path of the built web UI (see resolveWebDist). Unset → no static serving, as before. */
	webDist?: string | null;
}

export function createApp(deps: AppDeps): Hono {
	const app = new Hono();
	const security = deps.security ?? { hubHost: DEFAULT_HUB_HOST };
	const spoolDrops = new Map<string, number>();
	// The collector token must never also open the run route: forge/spine collectors could forge run state.
	const officeToken =
		deps.officeToken && deps.officeToken !== deps.ingestToken
			? deps.officeToken
			: undefined;

	// First: reject foreign Host headers (DNS rebinding) on every route, /healthz included.
	app.use("*", hostGuard(security));
	app.use("*", corsGuard(security));

	app.get("/healthz", (c) =>
		c.json({
			ok: true,
			machine: process.env.AGENTCITY_MACHINE ?? null,
			ingest: deps.ingestToken ? "enabled" : "disabled",
			run_projection: officeToken ? "enabled" : "disabled",
			// events each machine's collector spool discarded (size / age / rejected caps), cumulative
			spool_dropped: Object.fromEntries(spoolDrops),
			time: new Date().toISOString(),
		}),
	);
	app.route("/ingest", createIngest({ ...deps, spoolDrops }));
	app.route(
		"/ingest/runs",
		createRunsIngest({
			db: deps.db,
			officeToken,
			publish: deps.publish,
			now: deps.now,
		}),
	);
	app.route("/api", createApi(deps.db, deps.now));
	// Last, so every hub route wins and the Host/CORS guards above apply to static files too.
	if (deps.webDist) app.get("*", webStatic(deps.webDist));

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
	/** OFFICE_PROJECTION_TOKEN (see AppDeps.officeToken). */
	officeToken?: string;
	hostname: string;
	port: number;
	staleSweepMs?: number;
	/** Extra exact origins allowed for CORS and /ws (HUB_ALLOWED_ORIGINS). */
	extraOrigins?: readonly string[];
	/** Built web UI dir served on the same port (see AppDeps.webDist). */
	webDist?: string | null;
}

/** Serve HTTP + /ws and run the stale sweep (once now, then every `staleSweepMs`). */
export function startHub(opts: HubOptions) {
	const broadcaster = createBroadcaster();
	const security: SecurityConfig = {
		hubHost: opts.hostname,
		extraOrigins: opts.extraOrigins ?? [],
	};
	const app = createApp({
		db: opts.db,
		ingestToken: opts.ingestToken,
		officeToken: opts.officeToken,
		publish: broadcaster.publish,
		security,
		webDist: opts.webDist,
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
		// each new socket gets the current 7-day usage summary (same body as GET /api/usage)
		websocket: createWebsocket(() =>
			JSON.stringify({
				kind: "usage",
				data: usageSummary(opts.db, new Date()),
			}),
		),
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
		stop() {
			clearInterval(timer);
			server.stop(true);
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
	const hostname = hubHostFromEnv(process.env);
	const port = Number(process.env.HUB_PORT || 4317);
	const dbPath = process.env.DB_PATH || "./data/agentcity.db";
	const ingestToken = process.env.INGEST_TOKEN || undefined;
	const officeToken = process.env.OFFICE_PROJECTION_TOKEN || undefined;
	const syncMin = Number(process.env.GITHUB_SYNC_INTERVAL_MIN || 0);
	const extraOrigins = (process.env.HUB_ALLOWED_ORIGINS ?? "")
		.split(",")
		.map((o) => o.trim())
		.filter(Boolean);

	const web = resolveWebDist(process.env.AGENTCITY_WEB_DIST);

	const db = openDb(dbPath);
	const { server, publish } = startHub({
		db,
		ingestToken,
		officeToken,
		hostname,
		port,
		extraOrigins,
		webDist: web.dir,
	});
	console.log(
		`[hub] listening on http://${server.hostname}:${server.port} (db: ${dbPath})`,
	);
	console.log(web.logLine);
	if (!ingestToken) {
		console.warn("[hub] INGEST_TOKEN is not set — /ingest is disabled (503)");
	}
	if (!officeToken) {
		console.warn(
			"[hub] OFFICE_PROJECTION_TOKEN is not set — /ingest/runs is disabled (503)",
		);
	} else if (officeToken === ingestToken) {
		console.warn(
			"[hub] OFFICE_PROJECTION_TOKEN equals INGEST_TOKEN — /ingest/runs stays disabled (use a different value)",
		);
	}
	if (syncMin > 0) {
		scheduleGithubSync(db, publish, syncMin);
		console.log(`[hub] GitHub sync every ${syncMin} min`);
	} else {
		console.log("[hub] GitHub sync disabled (GITHUB_SYNC_INTERVAL_MIN=0)");
	}
}
