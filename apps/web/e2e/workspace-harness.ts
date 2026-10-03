// Isolated workspace M1 environment (lead-owned) for the real-hub UI phase (07) and the independent
// browser suite (09). Launch contract — the same isolation as browser-gate.ts:
//   - one disposable fixture repo (unique repo id) + temp SQLite FILE under mkdtemp; never data/ or .env
//   - the real hub IN THIS PROCESS in workspace mode on a free 127.0.0.1 port (never 4317), simulated
//     only, with per-run synthetic credentials returned to the caller (never logged)
//   - Vite programmatically: configFile false, empty envDir, cacheDir under TMPDIR (never
//     apps/web/node_modules/.vite), proxy → only this run's hub; the hub's allowed origin is exactly
//     this Vite origin (picked before the hub starts)
//   - restartHub(): stop the hub, reopen the same DB file, start a new hub (new boot) on the same port
//   - multi-repository milestone: optional extra disposable allowlisted fixture repos (each its own git
//     repository with a distinct id, path and base commit), observed-only repos written to the telemetry
//     `repos` table exactly like a GitHub sync would (never allowlisted, never executable), and test-only
//     engine hooks (e.g. a barrier that holds termination confirmation)
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";
import { openDb } from "../../hub/src/db.ts";
import { startHub } from "../../hub/src/index.ts";
import type { OrchestratorHooks } from "../../hub/src/managed/orchestrator.ts";
import {
	type Fixture,
	type FixtureOptions,
	type FixtureRepo,
	makeFixture,
} from "../../hub/src/managed/testkit.ts";
import type { WorkspaceHubOptions } from "../../hub/src/workspace-hub.ts";

const WEB_ROOT = resolve(import.meta.dir, "..");

export function freePort(): number {
	const s = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response(),
	});
	const port = s.port as number;
	s.stop(true);
	return port;
}

export interface WorkspaceEnvOptions {
	/** Extra fixture options (verification commands, limits…). Live stubs are never enabled here. */
	fixture?: Omit<
		FixtureOptions,
		"dbFile" | "repoId" | "liveStubs" | "extraRepos"
	>;
	/**
	 * Labels of further allowlisted fixture repositories (`[a-z0-9-]`), each → `local/m1-<label>-<nonce>`.
	 * The primary stays `local/m1-fixture-<nonce>` (`repoId`).
	 */
	extraRepos?: string[];
	/**
	 * Labels of observed-only repositories (`[a-z0-9-]`), each → `observed-example/<label>-<nonce>`, inserted
	 * into the telemetry `repos` table like a GitHub sync row. Never on the managed allowlist.
	 */
	observedRepos?: string[];
	/** Test-only engine boundaries passed to the hub's orchestrator (kept across restartHub()). */
	managedHooks?: OrchestratorHooks;
	/** Test-only auth knobs (clamped by the auth module). */
	auth?: Pick<
		WorkspaceHubOptions,
		| "session_ttl_ms"
		| "idle_timeout_ms"
		| "challenge_ttl_ms"
		| "max_sessions_per_principal"
		| "clock"
	>;
	/** Also configure the read-only test principal (R-A5). */
	readOnly?: boolean;
	/** Worker idle poll (ms). Default 50. */
	managedIdleMs?: number;
}

export interface WorkspaceEnv {
	fx: Fixture;
	repoId: string;
	/** Every allowlisted fixture repository, primary first (`repos[0].id === repoId`). */
	repos: FixtureRepo[];
	/** Observed-only repository ids (telemetry rows; not executable). */
	observedRepoIds: string[];
	hubUrl: string;
	/** The UI origin — also the hub's exact allowed origin. Browse here. */
	uiUrl: string;
	/** Synthetic, this run only. Never print it. */
	credential: string;
	readOnlyCredential: string | null;
	hub(): ReturnType<typeof startHub>;
	/** Stop the hub, reopen the same DB file and start a new hub (new boot) on the same port. */
	restartHub(): Promise<void>;
	stop(): Promise<void>;
}

export async function startWorkspaceEnv(
	o: WorkspaceEnvOptions = {},
): Promise<WorkspaceEnv> {
	const nonce = randomBytes(4).toString("hex");
	const repoId = `local/m1-fixture-${nonce}`;
	const label = (l: string) => {
		if (!/^[a-z0-9-]{1,30}$/.test(l)) throw new Error(`bad repo label ${l}`);
		return l;
	};
	const fx = makeFixture({
		...o.fixture,
		dbFile: true,
		repoId,
		extraRepos: (o.extraRepos ?? []).map((l) => ({
			id: `local/m1-${label(l)}-${nonce}`,
			label: l,
		})),
	});
	const observedRepoIds = (o.observedRepos ?? []).map(
		(l) => `observed-example/${label(l)}-${nonce}`,
	);
	for (const id of observedRepoIds)
		fx.db
			.query(
				"INSERT INTO repos (id, district, is_local_only, synced_at) VALUES (?, 'uncategorized', 0, ?)",
			)
			.run(id, new Date().toISOString());
	const credential = `op-${randomBytes(24).toString("hex")}`;
	const readOnlyCredential = o.readOnly
		? `ro-${randomBytes(24).toString("hex")}`
		: null;
	const hubPort = freePort();
	const vitePort = freePort();
	if (hubPort === 4317 || vitePort === 4317)
		throw new Error("refusing the default hub port");
	const hubUrl = `http://127.0.0.1:${hubPort}`;
	const uiUrl = `http://127.0.0.1:${vitePort}`;

	let db = fx.db;
	const launch = () =>
		startHub({
			db,
			ingestToken: undefined,
			hostname: "127.0.0.1",
			port: hubPort,
			managed: { config: fx.config, token: undefined },
			managedIdleMs: o.managedIdleMs ?? 50,
			...(o.managedHooks ? { managedHooks: o.managedHooks } : {}),
			workspace: {
				...o.auth,
				operator_credential: credential,
				read_only_credential: readOnlyCredential ?? undefined,
				allowed_origin: uiUrl,
			},
		});
	let hub = launch();

	const scratch = mkdtempSync(join(tmpdir(), "agentcity-m1-env-"));
	const envDir = join(scratch, "empty-env");
	mkdirSync(envDir);
	let vite: ViteDevServer | null = null;
	try {
		vite = await createServer({
			configFile: false,
			root: WEB_ROOT,
			envDir,
			cacheDir: join(scratch, "vite-cache"),
			mode: "development",
			logLevel: "error",
			clearScreen: false,
			plugins: [react()],
			define: {
				__AGENTCITY_WORKSPACE_UI__: "true",
				__AGENTCITY_WORKSPACE_FIXTURE__: "false",
			},
			server: {
				host: "127.0.0.1",
				port: vitePort,
				strictPort: true,
				proxy: {
					"/healthz": hubUrl,
					"/api": hubUrl,
					"/ws": { target: hubUrl, ws: true },
				},
			},
		});
		await vite.listen();
	} catch (err) {
		await hub.stop();
		fx.cleanup();
		rmSync(scratch, { recursive: true, force: true });
		throw err;
	}

	// identity through the proxy: an anonymous call reaches THIS hub's workspace guard (401, not 503)
	const probe = await fetch(`${uiUrl}/api/workspace/snapshot`);
	if (probe.status !== 401)
		throw new Error(
			`proxy does not reach this run's workspace hub (${probe.status})`,
		);

	return {
		fx,
		repoId,
		repos: fx.repos,
		observedRepoIds,
		hubUrl,
		uiUrl,
		credential,
		readOnlyCredential,
		hub: () => hub,
		async restartHub() {
			await hub.stop();
			db.close();
			db = openDb(fx.dbPath);
			hub = launch();
		},
		async stop() {
			await vite?.close();
			await hub.stop();
			try {
				db.close();
			} catch {
				// already closed
			}
			fx.cleanup();
			rmSync(scratch, { recursive: true, force: true });
		},
	};
}
