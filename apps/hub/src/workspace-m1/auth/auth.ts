// Workspace auth (role 03): one guard for the whole `/api/workspace` sub-app + the session routes +
// the ChallengePort. Frozen order (INTERFACE.md §7, OQ-1), applied to every request under the mount:
//
//   1 body limit (413) → 2 session cookie (401) → 3 exact Origin (403 forbidden_origin)
//   → 4 CSRF header on mutations (403 csrf_invalid) → 5 scope (403 forbidden_scope)
//   → 6 JSON content-type on bodies (415) → route (JSON + live precedence + strict parse, …)
//
// Sign-in (`POST <base>/session`) has no session yet: 1 → 3 (Origin required) → 6 → credential.
// Reads (GET/HEAD) need `workspace:read`; GET without Origin is allowed (R-A10) unless the browser
// says it is not same-origin (`Sec-Fetch-Site`, additive tightening); a present non-exact Origin is
// 403. Every other method is a mutation: exact Origin required (R-A3), CSRF, `workspace:decide`
// (except `DELETE <base>/session`, which needs only `workspace:read`).
//
// A VerifiedAuthContext is minted per mutation request after 1–6 passed, frozen, and remembered in a
// per-instance WeakMap; the ChallengePort accepts only contexts minted by the same instance whose
// session is still live. Request bodies never contribute identity or scope. Nothing is logged.
import { timingSafeEqual } from "node:crypto";
import {
	CSRF_HEADER,
	type OperatorPrincipal,
	type OperatorScope,
	SessionView,
	SignInRequest,
	type VerifiedAuthContext,
} from "@agent-city/schema/workspace-m1";
import type { Context, Env, Hono, MiddlewareHandler } from "hono";
import { WorkspaceChallenges } from "./challenges.ts";
import {
	digestSecret,
	type PrincipalKey,
	type ResolvedAuthConfig,
	resolveWorkspaceAuthConfig,
	SIGN_IN_BODY_LIMIT_BYTES,
	type WorkspaceAuthOptions,
} from "./config.ts";
import {
	authError,
	type CookieScope,
	clearedSessionCookie,
	enforceBodyLimit,
	hardenResponse,
	isJsonContentType,
	jsonResponse,
	readSessionCookie,
	SECURITY_HEADERS,
	SESSION_COOKIE,
	sessionCookie,
} from "./http.ts";
import { type SessionRecord, SessionStore } from "./sessions.ts";

type RequestAuth =
	| { kind: "sign_in" }
	| {
			kind: "session";
			session: SessionRecord;
			verified: VerifiedAuthContext | null;
	  };

/** Public, non-secret view of the effective settings (for the harness and diagnostics). */
export interface WorkspaceAuthSettings {
	readonly allowed_origins: readonly string[];
	readonly secure_cookie: boolean;
	readonly cookie_name: string;
	readonly cookie_path: string;
	readonly base_path: string;
	readonly session_ttl_ms: number;
	readonly idle_timeout_ms: number;
	readonly challenge_ttl_ms: number;
	readonly max_sessions_per_principal: number;
	readonly max_body_bytes: number;
}

export interface WorkspaceAuth {
	readonly enabled: boolean;
	/** Fixed reason when disabled (safe to log; never contains a credential). */
	readonly disabled_reason: string | null;
	/** This hub process's boot id (null when disabled). Never sent to the browser. */
	readonly boot_id: string | null;
	readonly settings: WorkspaceAuthSettings | null;
	/** The guard. Register it on the workspace sub-app BEFORE any route (see `install`). */
	readonly middleware: MiddlewareHandler;
	readonly challenges: WorkspaceChallenges;
	/** Register the guard and `GET/POST/DELETE /session` on the workspace sub-app (mounted at base_path). */
	install<E extends Env>(app: Hono<E>): void;
	/** The verified mutation context of this request (null for reads and unauthenticated requests). */
	verified(c: Context): VerifiedAuthContext | null;
	/** The session principal of this request (reads and mutations; null if not authenticated). */
	principal(c: Context): OperatorPrincipal | null;
	/** Server-side revocation of every session (harness / operator action). */
	revokeAllSessions(): void;
}

const isRead = (method: string) => method === "GET" || method === "HEAD";

export function createWorkspaceAuth(
	options: WorkspaceAuthOptions,
): WorkspaceAuth {
	const resolved = resolveWorkspaceAuthConfig(options);
	if (!resolved.ok) return disabledAuth(resolved.reason);
	return enabledAuth(resolved.config);
}

function disabledAuth(reason: string): WorkspaceAuth {
	const sessions = new SessionStore({
		session_ttl_ms: 1,
		idle_timeout_ms: 1,
		max_sessions_per_principal: 1,
	});
	const middleware: MiddlewareHandler = async () => authError("disabled");
	return Object.freeze({
		enabled: false,
		disabled_reason: reason,
		boot_id: null,
		settings: null,
		middleware,
		challenges: new WorkspaceChallenges({
			sessions,
			sessionOf: () => undefined,
			ttl_ms: 1,
		}),
		install<E extends Env>(app: Hono<E>) {
			app.use("*", middleware);
		},
		verified: () => null,
		principal: () => null,
		revokeAllSessions: () => undefined,
	});
}

function enabledAuth(cfg: ResolvedAuthConfig): WorkspaceAuth {
	const sessions = new SessionStore({
		session_ttl_ms: cfg.session_ttl_ms,
		idle_timeout_ms: cfg.idle_timeout_ms,
		max_sessions_per_principal: cfg.max_sessions_per_principal,
	});
	const state = new WeakMap<Context, RequestAuth>();
	const minted = new WeakMap<VerifiedAuthContext, SessionRecord>();
	const sessionPath = `${cfg.base_path}/session`;
	const cookieScope: CookieScope = {
		path: cfg.base_path,
		secure: cfg.secure_cookie,
	};

	const mint = (session: SessionRecord): VerifiedAuthContext => {
		const ctx: VerifiedAuthContext = Object.freeze({
			principal: session.principal,
			origin_verified: true as const,
			csrf_verified: true as const,
		});
		minted.set(ctx, session);
		return ctx;
	};

	/** Constant-time over every configured principal (no early exit). */
	const principalFor = (credential: string): PrincipalKey | null => {
		const given = digestSecret(credential);
		let found: PrincipalKey | null = null;
		for (const p of cfg.principals)
			if (timingSafeEqual(given, p.credential_digest) && found === null)
				found = p.key;
		return found;
	};

	const viewOf = (s: SessionRecord): SessionView =>
		SessionView.parse({
			operator_id: s.principal.operator_id,
			scopes: [...s.principal.scopes],
			csrf_token: s.csrf_token,
			expires_at: new Date(sessions.expiresAtMs(s)).toISOString(),
		});

	const middleware: MiddlewareHandler = async (c, next) => {
		const method = c.req.method;
		const path = c.req.path;
		const signIn = method === "POST" && path === sessionPath;
		const read = isRead(method);

		// 1 body limit
		const body = await enforceBodyLimit(
			c,
			signIn ? SIGN_IN_BODY_LIMIT_BYTES : cfg.max_body_bytes,
		);
		if (!body.ok) return authError(body.code);
		const headers = c.req.raw.headers;
		const origin = headers.get("origin");
		const now_ms = cfg.clock.now().getTime();

		if (signIn) {
			if (origin === null || !cfg.allowed_origins.has(origin))
				return authError("forbidden_origin");
			if (!isJsonContentType(headers.get("content-type")))
				return authError("unsupported_media_type");
			state.set(c, { kind: "sign_in" });
			await next();
			hardenResponse(c);
			return;
		}

		// 2 session
		const cookie = readSessionCookie(headers.get("cookie"));
		if (cookie.kind !== "one") return authError("unauthenticated");
		const session = sessions.lookup(cookie.value, now_ms);
		if (session === null) return authError("unauthenticated");

		// 3 exact Origin
		if (origin !== null) {
			if (!cfg.allowed_origins.has(origin))
				return authError("forbidden_origin");
		} else {
			if (!read) return authError("forbidden_origin");
			const site = headers.get("sec-fetch-site");
			if (site !== null && site !== "same-origin" && site !== "none")
				return authError("forbidden_origin");
		}

		// 4 CSRF
		if (!read) {
			const presented = headers.get(CSRF_HEADER);
			if (presented === null || !sessions.csrfMatches(session, presented))
				return authError("csrf_invalid");
		}

		// 5 scope
		const needed: OperatorScope =
			read || (method === "DELETE" && path === sessionPath)
				? "workspace:read"
				: "workspace:decide";
		if (!session.principal.scopes.includes(needed))
			return authError("forbidden_scope");

		// 6 JSON bodies
		const carriesBody =
			method === "POST" ||
			method === "PUT" ||
			method === "PATCH" ||
			body.bytes > 0;
		if (!read && carriesBody && !isJsonContentType(headers.get("content-type")))
			return authError("unsupported_media_type");

		sessions.touch(session, now_ms);
		state.set(c, {
			kind: "session",
			session,
			verified: read ? null : mint(session),
		});
		await next();
		hardenResponse(c);
	};

	const signInHandler = async (c: Context): Promise<Response> => {
		if (state.get(c)?.kind !== "sign_in") return authError("unauthenticated");
		let raw: unknown;
		try {
			raw = await c.req.json();
		} catch {
			return authError("invalid_request");
		}
		const parsed = SignInRequest.safeParse(raw);
		if (!parsed.success) return authError("invalid_request");
		const key = principalFor(parsed.data.credential);
		if (key === null) return authError("unauthenticated");
		const principal = cfg.principals.find((p) => p.key === key);
		if (!principal) return authError("unauthenticated");
		const presented = readSessionCookie(c.req.raw.headers.get("cookie"));
		const { cookie_value, record } = sessions.create(
			key,
			principal.scopes,
			presented.kind === "one" ? presented.value : null,
			cfg.clock.now().getTime(),
		);
		return jsonResponse(200, viewOf(record), {
			"set-cookie": sessionCookie(
				cookie_value,
				cfg.session_ttl_ms,
				cookieScope,
			),
		});
	};

	const sessionViewHandler = (c: Context): Response => {
		const st = state.get(c);
		if (st?.kind !== "session") return authError("unauthenticated");
		return jsonResponse(200, viewOf(st.session));
	};

	const signOutHandler = (c: Context): Response => {
		const st = state.get(c);
		if (st?.kind !== "session" || st.verified === null)
			return authError("unauthenticated");
		sessions.revoke(st.session);
		return new Response(null, {
			status: 204,
			headers: {
				...SECURITY_HEADERS,
				"set-cookie": clearedSessionCookie(cookieScope),
			},
		});
	};

	const challenges = new WorkspaceChallenges({
		sessions,
		sessionOf: (auth) => minted.get(auth),
		ttl_ms: cfg.challenge_ttl_ms,
	});

	return Object.freeze({
		enabled: true,
		disabled_reason: null,
		boot_id: sessions.boot_id,
		settings: Object.freeze({
			allowed_origins: Object.freeze([...cfg.allowed_origins]),
			secure_cookie: cfg.secure_cookie,
			cookie_name: SESSION_COOKIE,
			cookie_path: cfg.base_path,
			base_path: cfg.base_path,
			session_ttl_ms: cfg.session_ttl_ms,
			idle_timeout_ms: cfg.idle_timeout_ms,
			challenge_ttl_ms: cfg.challenge_ttl_ms,
			max_sessions_per_principal: cfg.max_sessions_per_principal,
			max_body_bytes: cfg.max_body_bytes,
		}),
		middleware,
		challenges,
		install<E extends Env>(app: Hono<E>) {
			app.use("*", middleware);
			app.post("/session", signInHandler);
			app.get("/session", sessionViewHandler);
			app.delete("/session", signOutHandler);
		},
		verified(c: Context) {
			const st = state.get(c);
			return st?.kind === "session" ? st.verified : null;
		},
		principal(c: Context) {
			const st = state.get(c);
			return st?.kind === "session" ? st.session.principal : null;
		},
		revokeAllSessions: () => sessions.revokeAll(),
	});
}
