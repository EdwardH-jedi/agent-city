// HTTP primitives of the workspace auth layer (role 03): fixed error bodies, response hardening
// headers, strict cookie parsing/serialization, exact JSON content-type and the body limit.
// Nothing here echoes request data; error messages are fixed strings.
import {
	WORKSPACE_ERROR_STATUS,
	type WorkspaceErrorBody,
} from "@agent-city/schema/workspace-m1";
import type { Context } from "hono";

/** Opaque session cookie. Not `__Host-`: that prefix requires `Path=/` (we scope to the API base). */
export const SESSION_COOKIE = "agentcity_ws_session";
const COOKIE_VALUE_RE = /^[A-Za-z0-9_-]{43}$/;

export type AuthErrorCode =
	| "unauthenticated"
	| "forbidden_origin"
	| "csrf_invalid"
	| "forbidden_scope"
	| "invalid_request"
	| "payload_too_large"
	| "unsupported_media_type"
	| "disabled";

const MESSAGES: Readonly<Record<AuthErrorCode, string>> = {
	unauthenticated: "sign-in required",
	forbidden_origin: "request origin is not allowed",
	csrf_invalid: "missing or invalid CSRF token",
	forbidden_scope: "this session may not perform this operation",
	invalid_request: "invalid request",
	payload_too_large: "request body too large",
	unsupported_media_type: "content-type must be application/json",
	disabled: "workspace API is disabled",
};

/** Set on every workspace response, errors included. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
	// another loopback port is same-site but cross-origin: no-cors embedding must not read data
	"cross-origin-resource-policy": "same-origin",
};

export function jsonResponse(
	status: number,
	body: unknown,
	extra?: Record<string, string>,
): Response {
	const headers = new Headers({
		...SECURITY_HEADERS,
		"content-type": "application/json; charset=utf-8",
	});
	for (const [k, v] of Object.entries(extra ?? {})) headers.set(k, v);
	return new Response(JSON.stringify(body), { status, headers });
}

export function authError(code: AuthErrorCode): Response {
	const body: WorkspaceErrorBody = { error: code, message: MESSAGES[code] };
	return jsonResponse(WORKSPACE_ERROR_STATUS[code], body);
}

/** Add the hardening headers to whatever the downstream handler produced. */
export function hardenResponse(c: Context): void {
	try {
		for (const [k, v] of Object.entries(SECURITY_HEADERS))
			c.res.headers.set(k, v);
	} catch {
		// immutable headers (e.g. a proxied Response): copy once, then set
		c.res = new Response(c.res.body, c.res);
		for (const [k, v] of Object.entries(SECURITY_HEADERS))
			c.res.headers.set(k, v);
	}
}

export type CookieLookup =
	| { kind: "absent" }
	| { kind: "invalid" }
	| { kind: "one"; value: string };

/**
 * The session cookie from a Cookie header. Fails closed on ambiguity: two cookies with our name
 * (e.g. one tossed from another loopback port with a narrower Path) or a malformed value → invalid.
 * Names are case-sensitive. Only the Cookie header is read — never the query string or a body.
 */
export function readSessionCookie(header: string | null): CookieLookup {
	if (header === null || header === "") return { kind: "absent" };
	const values: string[] = [];
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		if (part.slice(0, eq).trim() === SESSION_COOKIE)
			values.push(part.slice(eq + 1).trim());
	}
	if (values.length === 0) return { kind: "absent" };
	if (values.length > 1) return { kind: "invalid" };
	const value = values[0] ?? "";
	return COOKIE_VALUE_RE.test(value)
		? { kind: "one", value }
		: { kind: "invalid" };
}

export interface CookieScope {
	path: string;
	secure: boolean;
}

/** HttpOnly; SameSite=Strict; scoped Path; no Domain; Secure iff the UI origin is https (R-N7). */
export function sessionCookie(
	value: string,
	maxAgeMs: number,
	scope: CookieScope,
): string {
	const maxAge = Math.max(1, Math.floor(maxAgeMs / 1000));
	return `${SESSION_COOKIE}=${value}; Path=${scope.path}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${scope.secure ? "; Secure" : ""}`;
}

export function clearedSessionCookie(scope: CookieScope): string {
	return `${SESSION_COOKIE}=; Path=${scope.path}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict${scope.secure ? "; Secure" : ""}`;
}

/** Exactly `application/json`, optionally with `charset=utf-8`; nothing else (no `+json`, `-seq`). */
export function isJsonContentType(value: string | null): boolean {
	if (value === null) return false;
	const [type, ...params] = value.split(";");
	if ((type ?? "").trim().toLowerCase() !== "application/json") return false;
	return params.every((p) => {
		const norm = p.replace(/\s+/g, "").toLowerCase();
		return norm === "" || norm === "charset=utf-8";
	});
}

export type BodyCheck =
	| { ok: true; bytes: number }
	| { ok: false; code: "payload_too_large" | "invalid_request" };

/**
 * Body limit — the first step of the frozen order. A declared Content-Length above the limit fails
 * without reading; otherwise the body is read with a running cap (a lying or absent length cannot
 * exceed it) and re-attached as a buffered body for the route. GET/HEAD bodies are not read.
 */
export async function enforceBodyLimit(
	c: Context,
	maxBytes: number,
): Promise<BodyCheck> {
	const raw = c.req.raw;
	const declared = raw.headers.get("content-length");
	if (declared !== null) {
		if (!/^\d{1,16}$/.test(declared))
			return { ok: false, code: "invalid_request" };
		if (Number(declared) > maxBytes)
			return { ok: false, code: "payload_too_large" };
	}
	if (raw.body === null || raw.method === "GET" || raw.method === "HEAD")
		return { ok: true, bytes: 0 };
	const reader = raw.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel().catch(() => undefined);
			return { ok: false, code: "payload_too_large" };
		}
		chunks.push(value);
	}
	const body = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		body.set(chunk, at);
		at += chunk.byteLength;
	}
	c.req.raw = new Request(raw, { body });
	return { ok: true, bytes: size };
}
