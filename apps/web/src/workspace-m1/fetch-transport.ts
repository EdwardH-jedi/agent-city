// Real hub transport (role 07) for `/api/workspace` (contract v1.1). Skeleton for the isolated
// test hub: the cookie session is HttpOnly (the browser sends it; JS never sees it), the CSRF
// value from SessionView is kept only in this closure (never in storage, DOM or URL) and sent as
// `x-agentcity-csrf` on every mutation. Every answer is parsed with the contract schema; error
// bodies must be WorkspaceErrorBody whose code matches the HTTP status, else `invalid_response`.
import {
	ApprovalRequestId,
	ArtifactId,
	ArtifactTextResponse,
	ChallengeIssueResponse,
	CSRF_HEADER,
	DecisionResponse,
	SessionView,
	WORKSPACE_API_BASE,
	WORKSPACE_ERROR_STATUS,
	WORKSPACE_ROUTES,
	WorkspaceErrorBody,
	WorkspaceSnapshot,
	WorkspaceTaskDetail,
	WorkspaceTaskId,
	WorkspaceTaskView,
} from "@agent-city/schema/workspace-m1";
import type { TransportResult, WorkspaceTransport } from "./transport.ts";

interface Parser<T> {
	safeParse(
		v: unknown,
	):
		| { success: true; data: T }
		| { success: false; error: { issues: { message: string }[] } };
}

export interface FetchTransportOptions {
	fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
	/** Default WORKSPACE_API_BASE (same origin; the Vite proxy forwards it to the hub). */
	base?: string;
	timeoutMs?: number;
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

const localInvalid = (message: string): TransportResult<never> => ({
	ok: false,
	kind: "http",
	status: 400,
	error: { error: "invalid_request", message },
});

export function createFetchTransport(
	opts: FetchTransportOptions = {},
): WorkspaceTransport {
	const doFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
	const base = opts.base ?? WORKSPACE_API_BASE;
	const timeoutMs = opts.timeoutMs ?? 15_000;
	let csrf: string | null = null;
	/**
	 * Session generation the CSRF value belongs to. Bumped on sign-in, at the START of sign-out and on
	 * a 401 of the current generation. Every call remembers the generation it started in; an answer
	 * of an older generation (a late 401 after sign-out → sign-in) never touches the current session.
	 */
	let gen = 0;

	const pathFor = (
		route: keyof typeof WORKSPACE_ROUTES,
		params: Record<string, string> = {},
	): string =>
		WORKSPACE_ROUTES[route].replace(/:([a-z_]+)/g, (_m, k: string) =>
			encodeURIComponent(params[k] ?? ""),
		);

	async function call<T>(
		method: Method,
		path: string,
		schema: Parser<T> | null,
		body?: string,
	): Promise<TransportResult<T>> {
		const startGen = gen;
		const headers: Record<string, string> = { accept: "application/json" };
		if (body !== undefined) headers["content-type"] = "application/json";
		if (method !== "GET" && csrf) headers[CSRF_HEADER] = csrf;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let status = 0;
		let ok = false;
		let text: string;
		try {
			const res = await doFetch(base + path, {
				method,
				headers,
				body,
				credentials: "same-origin",
				cache: "no-store",
				redirect: "error",
				signal: controller.signal,
			});
			status = res.status;
			ok = res.ok;
			text = await res.text();
		} catch {
			return { ok: false, kind: "network", message: "No answer from the hub." };
		} finally {
			clearTimeout(timer);
		}
		let json: unknown;
		try {
			json = text.length > 0 ? JSON.parse(text) : null;
		} catch {
			json = undefined;
		}
		if (ok) {
			if (schema === null) return { ok: true, status, data: null as T };
			const parsed = schema.safeParse(json);
			return parsed.success
				? { ok: true, status, data: parsed.data }
				: {
						ok: false,
						kind: "invalid_response",
						status,
						message: "The hub answer does not match the contract.",
					};
		}
		const err = WorkspaceErrorBody.safeParse(json);
		if (err.success && WORKSPACE_ERROR_STATUS[err.data.error] === status) {
			if (err.data.error === "unauthenticated" && startGen === gen) {
				csrf = null;
				gen += 1;
			}
			return { ok: false, kind: "http", status, error: err.data };
		}
		return {
			ok: false,
			kind: "invalid_response",
			status,
			message: `Unexpected hub answer (HTTP ${status}).`,
		};
	}

	const json = (v: unknown) => JSON.stringify(v);
	/** GET /session confirms the current session only if nothing changed while it was in flight. */
	const confirmSession = async () => {
		const startGen = gen;
		const r = await call("GET", pathFor("session"), SessionView);
		if (r.ok && startGen === gen) csrf = r.data.csrf_token;
		return r;
	};
	const task = (id: string) => WorkspaceTaskId.safeParse(id).success;
	const request = (id: string) => ApprovalRequestId.safeParse(id).success;

	return {
		source: "hub",
		getSession: confirmSession,
		signIn: async (b) => {
			const r = await call("POST", pathFor("session"), SessionView, json(b));
			if (r.ok) {
				// a new session (new cookie): everything still in flight is stale
				csrf = r.data.csrf_token;
				gen += 1;
			}
			return r;
		},
		signOut: () => {
			// headers (with the current CSRF) are built synchronously inside call(); then the old
			// generation ends at once, before its answers can arrive
			const r = call<null>("DELETE", pathFor("session"), null);
			csrf = null;
			gen += 1;
			return r;
		},
		getSnapshot: () => call("GET", pathFor("snapshot"), WorkspaceSnapshot),
		createTask: (b) =>
			call("POST", pathFor("tasks"), WorkspaceTaskView, json(b)),
		getTask: async (id) =>
			task(id)
				? call("GET", pathFor("task", { id }), WorkspaceTaskDetail)
				: localInvalid("Invalid task id."),
		saveDraft: async (id, b) =>
			task(id)
				? call("PUT", pathFor("draft", { id }), WorkspaceTaskView, json(b))
				: localInvalid("Invalid task id."),
		publishProposal: async (id, b) =>
			task(id)
				? call("POST", pathFor("proposals", { id }), WorkspaceTaskView, json(b))
				: localInvalid("Invalid task id."),
		requestRerun: async (id, b) =>
			task(id)
				? call("POST", pathFor("rerun", { id }), WorkspaceTaskView, json(b))
				: localInvalid("Invalid task id."),
		cancel: async (id, b) =>
			task(id)
				? call("POST", pathFor("cancel", { id }), WorkspaceTaskView, json(b))
				: localInvalid("Invalid task id."),
		getArtifact: async (id, artifactId) =>
			task(id) && ArtifactId.safeParse(artifactId).success
				? call(
						"GET",
						pathFor("artifact", { id, artifact_id: artifactId }),
						ArtifactTextResponse,
					)
				: localInvalid("Invalid artifact id."),
		issueChallenge: async (id, b) =>
			request(id)
				? call(
						"POST",
						pathFor("challenge", { id }),
						ChallengeIssueResponse,
						json(b),
					)
				: localInvalid("Invalid approval request id."),
		decide: async (id, serialized) =>
			request(id)
				? call(
						"POST",
						pathFor("decisions", { id }),
						DecisionResponse,
						serialized,
					)
				: localInvalid("Invalid approval request id."),
	};
}
