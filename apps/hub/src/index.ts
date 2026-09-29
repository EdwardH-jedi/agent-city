import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { openDb } from "./db.ts";
import { runConfiguredSync } from "./github/sync.ts";
import { createApi } from "./routes/api.ts";
import { createIngest } from "./routes/ingest.ts";
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
}

export function createApp(deps: AppDeps): Hono {
	const app = new Hono();
	const security = deps.security ?? { hubHost: "127.0.0.1" };

	// First: reject foreign Host headers (DNS rebinding) on every route, /healthz included.
	app.use("*", hostGuard(security));
	app.use("*", corsGuard(security));

	app.get("/healthz", (c) =>
		c.json({
			ok: true,
			machine: process.env.AGENTCITY_MACHINE ?? null,
			ingest: deps.ingestToken ? "enabled" : "disabled",
			time: new Date().toISOString(),
		}),
	);
	app.route("/ingest", createIngest(deps));
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
		publish: broadcaster.publish,
		security,
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
): () => void {
	let running = false;
	const run = async () => {
		if (running) return;
		running = true;
		try {
			const s = await runConfiguredSync(db);
			const changed = new Set(s.changedRepoIds);
			for (const list of Object.values(listReposByDistrict(db))) {
				for (const repo of list)
					if (changed.has(repo.id)) publish("repo", repo);
			}
			console.log(
				`[github] ${s.total} repos, ${changed.size} changed, rate graphql ${s.rate.graphql.remaining ?? "?"} core ${s.rate.core.remaining ?? "?"}${s.aborted ? ` — aborted: ${s.aborted}` : ""}`,
			);
		} catch (err) {
			console.error(`[github] sync failed: ${(err as Error).message}`);
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

	const db = openDb(dbPath);
	const { server, publish } = startHub({
		db,
		ingestToken,
		hostname,
		port,
		extraOrigins,
	});
	console.log(
		`[hub] listening on http://${server.hostname}:${server.port} (db: ${dbPath})`,
	);
	if (!ingestToken) {
		console.warn("[hub] INGEST_TOKEN is not set — /ingest is disabled (503)");
	}
	if (syncMin > 0) {
		scheduleGithubSync(db, publish, syncMin);
		console.log(`[hub] GitHub sync every ${syncMin} min`);
	} else {
		console.log("[hub] GitHub sync disabled (GITHUB_SYNC_INTERVAL_MIN=0)");
	}
}
