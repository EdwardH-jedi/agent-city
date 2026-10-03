// Workspace HTTP routes (contract v1.1 WORKSPACE_ROUTES) except `/session`, which role 03's
// `auth.install(ws)` adds. The lead composes:
//
//   const ws = new Hono();
//   auth.install(ws);                                   // guard FIRST (body limit → session →
//   ws.route("/", createWorkspaceRouter({ auth, … }));  // Origin → CSRF → scope → content-type)
//   app.route(WORKSPACE_API_BASE, ws);
//
// Handlers trust only `auth.verified(c)` / `auth.principal(c)` (minted by 03); a missing context
// is a wiring fault → 500 without data. Ids are pattern-checked (→ 404), bodies are bounded and
// parsed here (malformed → 400), every response is contract-validated before it is sent and
// carries `cache-control: no-store`. Unexpected failures → 500 with a fixed body; nothing logged.
import {
	type ChallengePort,
	type CommandOutcome,
	type EvidenceSealer,
	type ExecutionBridge,
	type OperatorPrincipal,
	type VerifiedAuthContext,
	WORKSPACE_ROUTES,
} from "@agent-city/schema/workspace-m1";
import type { Context } from "hono";
import { Hono } from "hono";
import type { ManagedConfig, RepoConfig } from "../../managed/config.ts";
import type { ArtifactReaderDeps } from "../evidence/reader.ts";
import type { PersistentWorkspaceStore } from "../persistence/index.ts";
import { createWorkspaceCommands, type WorkspaceCommands } from "./commands.ts";
import {
	createDecisionService,
	type DecisionServiceImpl,
} from "./decision-service.ts";
import type { DecisionHooks, WorkspaceServiceDeps } from "./deps.ts";
import { createManagedBridge } from "./engine.ts";
import { fail, mapKnownError } from "./outcome.ts";
import {
	createWorkspaceReadModel,
	type WorkspaceReadModel,
} from "./read-model.ts";

/** What the router needs from role 03's WorkspaceAuth (structural; `createWorkspaceAuth` fits). */
export interface WorkspaceAuthPort {
	verified(c: Context): VerifiedAuthContext | null;
	principal(c: Context): OperatorPrincipal | null;
	readonly challenges: ChallengePort;
}

export interface WorkspaceApiDeps {
	auth: WorkspaceAuthPort;
	/** 02 store on the hub's single Database handle. */
	store: PersistentWorkspaceStore;
	/** The orchestrator's frozen managed config snapshot. */
	config: ManagedConfig;
	/** 06 sealer built with `reads: store` (Gate-2 revalidation). */
	sealer: EvidenceSealer;
	/** 06 reader deps for the artifact route (share the sealer's RetainedEvidenceStore). */
	reader?: ArtifactReaderDeps;
	/** 05 bridge; default `createManagedBridge({ db: store.db, config })`. */
	bridge?: ExecutionBridge;
	/** MUST be the same clock as `createWorkspaceAuth({ clock })` (session liveness + challenge TTL). */
	clock?: { now(): Date };
	/** Defence-in-depth body cap (the auth guard enforces its own limit first). Default 64 KiB. */
	max_body_bytes?: number;
	resolveBase?: (repo: RepoConfig) => Promise<string>;
	hooks?: DecisionHooks;
}

export interface WorkspaceServices {
	decisions: DecisionServiceImpl;
	commands: WorkspaceCommands;
	reads: WorkspaceReadModel;
	bridge: ExecutionBridge;
}

/** Build the three services from the module deps (also used directly by tests and the bridge). */
export function createWorkspaceServices(
	deps: Omit<WorkspaceApiDeps, "auth" | "max_body_bytes"> & {
		challenges: ChallengePort;
	},
): WorkspaceServices {
	const bridge =
		deps.bridge ??
		createManagedBridge({ db: deps.store.db, config: deps.config });
	const svc: WorkspaceServiceDeps = {
		store: deps.store,
		config: deps.config,
		bridge,
		challenges: deps.challenges,
		sealer: deps.sealer,
		...(deps.resolveBase ? { resolveBase: deps.resolveBase } : {}),
		...(deps.hooks ? { hooks: deps.hooks } : {}),
		...(deps.clock ? { clock: deps.clock } : {}),
	};
	const reads = createWorkspaceReadModel({
		store: deps.store,
		config: deps.config,
		bridge,
		...(deps.reader ? { reader: deps.reader } : {}),
		...(deps.clock ? { clock: deps.clock } : {}),
	});
	return {
		decisions: createDecisionService(svc),
		commands: createWorkspaceCommands(svc, reads),
		reads,
		bridge,
	};
}

const HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
} as const;

const json = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), { status, headers: HEADERS });

const send = <T>(o: CommandOutcome<T>): Response => json(o.status, o.body);

const internal = (): Response => json(500, { error: "internal error" }); // the frozen error set has no 5xx code

const errorResponse = (code: Parameters<typeof fail>[0]): Response =>
	send(fail(code));

export function createWorkspaceRouter(deps: WorkspaceApiDeps): Hono {
	const services = createWorkspaceServices({
		...deps,
		challenges: deps.auth.challenges,
	});
	const { decisions, commands, reads } = services;
	const now = () => (deps.clock ? deps.clock.now() : new Date());
	const maxBody = deps.max_body_bytes ?? 64 * 1024;
	const r = new Hono();

	/** Bounded JSON body (the guard already enforced its limit and the content-type). */
	async function readBody(
		c: Context,
	): Promise<{ ok: true; value: unknown } | { ok: false; res: Response }> {
		let text: string;
		try {
			text = await c.req.text();
		} catch {
			return { ok: false, res: errorResponse("invalid_request") };
		}
		if (Buffer.byteLength(text, "utf8") > maxBody)
			return { ok: false, res: errorResponse("payload_too_large") };
		try {
			return { ok: true, value: JSON.parse(text) as unknown };
		} catch {
			return { ok: false, res: errorResponse("invalid_request") };
		}
	}

	const safely =
		(fn: (c: Context) => Promise<Response> | Response) =>
		async (c: Context): Promise<Response> => {
			try {
				return await fn(c);
			} catch (err) {
				const known = mapKnownError(err);
				return known ? send(known) : internal();
			}
		};

	const read = (
		fn: (c: Context, p: OperatorPrincipal) => Promise<Response> | Response,
	) =>
		safely((c) => {
			const p = deps.auth.principal(c);
			if (!p) return internal(); // guard not installed in front of this router
			return fn(c, p);
		});

	const mutate = (
		fn: (
			c: Context,
			v: VerifiedAuthContext,
			body: unknown,
		) => Promise<Response> | Response,
	) =>
		safely(async (c) => {
			const v = deps.auth.verified(c);
			if (!v) return internal(); // never built from a request: wiring fault
			const body = await readBody(c);
			if (!body.ok) return body.res;
			return fn(c, v, body.value);
		});

	r.get(
		WORKSPACE_ROUTES.snapshot,
		read(() => send(reads.snapshot(now()))),
	);
	r.post(
		WORKSPACE_ROUTES.tasks,
		mutate((_c, v, body) => send(commands.createTask(v, body, now()))),
	);
	r.get(
		WORKSPACE_ROUTES.task,
		// awaits the full current-validity check of an accepted result (bundle, sources, candidate)
		// when the last check is older than the re-check window, so a detail read never shows a
		// stale `valid` after a detectable change
		read(async (c) =>
			send(await reads.taskDetailChecked(c.req.param("id") ?? "")),
		),
	);
	r.put(
		WORKSPACE_ROUTES.draft,
		mutate((c, v, body) =>
			send(commands.saveDraft(v, c.req.param("id") ?? "", body, now())),
		),
	);
	r.post(
		WORKSPACE_ROUTES.proposals,
		mutate(async (c, v, body) =>
			send(
				await commands.publishProposal(v, c.req.param("id") ?? "", body, now()),
			),
		),
	);
	r.post(
		WORKSPACE_ROUTES.rerun,
		mutate((c, v, body) =>
			send(commands.requestRerun(v, c.req.param("id") ?? "", body, now())),
		),
	);
	r.post(
		WORKSPACE_ROUTES.cancel,
		mutate((c, v, body) =>
			send(commands.cancel(v, c.req.param("id") ?? "", body, now())),
		),
	);
	r.get(
		WORKSPACE_ROUTES.artifact,
		read(async (c) =>
			send(
				await reads.artifact(
					c.req.param("id") ?? "",
					c.req.param("artifact_id") ?? "",
				),
			),
		),
	);
	r.post(
		WORKSPACE_ROUTES.challenge,
		mutate((c, v, body) =>
			send(decisions.issueChallenge(v, c.req.param("id") ?? "", body, now())),
		),
	);
	r.post(
		WORKSPACE_ROUTES.decisions,
		mutate(async (c, v, body) =>
			send(await decisions.decide(v, c.req.param("id") ?? "", body, now())),
		),
	);
	// anything else under the mount (wrong method, unknown path) — after the guard has run
	r.all("*", () => errorResponse("not_found"));
	return r;
}
