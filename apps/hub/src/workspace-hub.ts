// Workspace M1 composition (docs/workspace-m1/INTEGRATION.md L2/L3/L5). One Database handle, one
// frozen simulated-only managed config, one auth instance (boot), one retained-evidence store —
// shared by the persistence store, decisions, evidence sealer/reader and the execution bridge.
// Mounted at /api/workspace by createApp. Workspace mode replaces the token-based legacy managed
// API (410) and never runs live providers, whatever the trusted config says.
import type { Database } from "bun:sqlite";
import { WORKSPACE_API_BASE } from "@agent-city/schema/workspace-m1";
import { Hono } from "hono";
import type { ManagedConfig } from "./managed/config.ts";
import {
	createWorkspaceAuth,
	type WorkspaceAuth,
	type WorkspaceAuthOptions,
} from "./workspace-m1/auth/index.ts";
import {
	createWorkspaceBridge,
	type WorkspaceBridge,
} from "./workspace-m1/bridge/index.ts";
import { createWorkspaceRouter } from "./workspace-m1/decisions/index.ts";
import { RetainedEvidenceStore } from "./workspace-m1/evidence/retained.ts";
import {
	createEvidenceSealer,
	defaultGitFor,
	type EvidenceSealerImpl,
} from "./workspace-m1/evidence/sealer.ts";
import {
	createWorkspaceStore,
	type PersistentWorkspaceStore,
} from "./workspace-m1/persistence/index.ts";

export type WorkspaceHubOptions = WorkspaceAuthOptions;

/** Workspace mode needs both the ephemeral operator credential and the exact UI origin. */
export const workspaceConfigured = (o: WorkspaceHubOptions | undefined) =>
	!!o?.operator_credential && !!o?.allowed_origin;

/** M1 is simulated-only: live execution is off in workspace mode regardless of the trusted config. */
export function simulatedOnly(config: ManagedConfig): ManagedConfig {
	return { ...config, live: { enabled: false } };
}

export interface WorkspaceHub {
	/** Sub-app for WORKSPACE_API_BASE: auth guard + session routes first, then the workspace routes. */
	api: Hono;
	auth: WorkspaceAuth;
	store: PersistentWorkspaceStore;
	sealer: EvidenceSealerImpl;
	retained: RetainedEvidenceStore;
	/**
	 * 05 bridge: `authorize` → OrchestratorDeps.authorize (required), `notify` → onChange,
	 * `start`/`stop` around the worker. Its `port` is what the router uses for enqueue/cancel.
	 */
	bridge: WorkspaceBridge;
}

/** `config` must be the exact (simulated-only) snapshot the orchestrator executes. */
export function createWorkspaceHub(o: {
	db: Database;
	config: ManagedConfig;
	options: WorkspaceHubOptions;
	/** Wake the worker after a Gate-1 enqueue (called deferred, never inside a transaction). */
	onQueued?: () => void;
}): WorkspaceHub {
	const { db, config } = o;
	const auth = createWorkspaceAuth({
		...o.options,
		base_path: WORKSPACE_API_BASE,
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
	const clock = o.options.clock;
	const bridge = createWorkspaceBridge({
		db,
		store,
		config,
		sealer,
		...(clock ? { now: () => clock.now() } : {}),
		onQueued: () => o.onQueued?.(),
	});
	const api = new Hono();
	auth.install(api); // first: a route registered before the guard would be unguarded
	api.route(
		"/",
		createWorkspaceRouter({
			auth,
			store,
			config,
			sealer,
			reader: { db, config, retained, gitFor },
			bridge: bridge.port,
			// the SAME clock as the auth instance (session liveness + challenge expiry)
			clock: o.options.clock,
		}),
	);
	return { api, auth, store, sealer, retained, bridge };
}

/** `/api/workspace` when workspace mode is not configured. */
export function workspaceDisabled(reason: string): Hono {
	const api = new Hono();
	api.all("*", (c) =>
		c.json({ error: "disabled", message: reason }, 503, {
			"cache-control": "no-store",
		}),
	);
	return api;
}

/** Legacy `/api/managed` in workspace mode (R-A6): the engine is reachable only through Gate 1. */
export function legacyManagedGone(): Hono {
	const api = new Hono();
	api.all("*", (c) =>
		c.json(
			{
				error: "gone",
				reason: "managed runs are governed by the workspace (/api/workspace)",
			},
			410,
			{ "cache-control": "no-store" },
		),
	);
	return api;
}
