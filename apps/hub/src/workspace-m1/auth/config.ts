// Workspace auth configuration (role 03). Validated once when the hub builds the workspace API; any
// problem disables the whole workspace API (503 `disabled`) — there is no default login and no
// fallback credential. Raw credentials never leave this file: they are reduced to sha256 digests
// here and only the digests are kept.
import { createHash } from "node:crypto";
import {
	CHALLENGE_TTL_MS,
	type OperatorScope,
	WORKSPACE_API_BASE,
} from "@agent-city/schema/workspace-m1";

/** Session lifetime ceiling (R-N3). */
export const SESSION_TTL_MAX_MS = 12 * 60 * 60 * 1000;
export const SESSION_TTL_DEFAULT_MS = 8 * 60 * 60 * 1000;
export const IDLE_TIMEOUT_DEFAULT_MS = 30 * 60 * 1000;
/** Challenge lifetime ceiling = the frozen contract value (300 s, R-N3). */
export const CHALLENGE_TTL_MAX_MS = CHALLENGE_TTL_MS;
/** Floor for every configurable lifetime (tests drive time with a fake clock). */
export const TTL_MIN_MS = 1_000;
export const MAX_SESSIONS_PER_PRINCIPAL_DEFAULT = 4;
export const MAX_SESSIONS_PER_PRINCIPAL_MAX = 16;
export const BODY_LIMIT_DEFAULT_BYTES = 64 * 1024;
export const BODY_LIMIT_MAX_BYTES = 1024 * 1024;
export const BODY_LIMIT_MIN_BYTES = 1024;
/** Sign-in bodies are tiny: `{"credential": "<≤512 chars>"}`. */
export const SIGN_IN_BODY_LIMIT_BYTES = 4 * 1024;
/** Visible ASCII only (no whitespace, so nothing can be trimmed or normalized away). */
const CREDENTIAL_RE = /^[\x21-\x7e]{32,512}$/;
const BASE_PATH_RE = /^(?:\/[a-z0-9][a-z0-9_-]*)+$/;

export interface Clock {
	now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** What the launcher (hub option) passes. Every field is optional; absent credential → disabled. */
export interface WorkspaceAuthOptions {
	/**
	 * Ephemeral test-operator credential (≥ 32 visible ASCII chars), generated per run by the
	 * launcher. Grants `workspace:read` + `workspace:decide`. Never logged, echoed or stored.
	 */
	operator_credential?: string | undefined;
	/**
	 * Tests only (R-A5): a second principal with `workspace:read` only. Production wiring must leave
	 * it unset. The frozen contract fixes `operator_id` to `operator:edward`, so this principal is
	 * distinguished by scope (and credential), not by id.
	 */
	read_only_credential?: string | undefined;
	/** Exact UI origin in `URL.origin` form, e.g. `http://127.0.0.1:5173` (scheme + host + port). */
	allowed_origin?: string | undefined;
	/** Further exact origins (each in `URL.origin` form). Default none. */
	extra_allowed_origins?: readonly string[] | undefined;
	/** Absolute session lifetime; clamped to [1 s, 12 h]. Default 8 h. */
	session_ttl_ms?: number | undefined;
	/** Idle timeout; clamped to [1 s, session_ttl]. Default 30 min. */
	idle_timeout_ms?: number | undefined;
	/** Challenge lifetime; clamped to [1 s, 300 s]. Default 300 s. */
	challenge_ttl_ms?: number | undefined;
	/** Concurrent sessions per principal (oldest evicted); clamped to [1, 16]. Default 4. */
	max_sessions_per_principal?: number | undefined;
	/** Body limit for every workspace request but sign-in; clamped to [1 KiB, 1 MiB]. Default 64 KiB. */
	max_body_bytes?: number | undefined;
	/** Mount point of the workspace sub-app (also the cookie Path). Default `/api/workspace`. */
	base_path?: string | undefined;
	clock?: Clock | undefined;
}

export type PrincipalKey = "operator" | "read_only";

export interface PrincipalConfig {
	readonly key: PrincipalKey;
	readonly scopes: readonly OperatorScope[];
	/** sha256 of the credential; the raw value is not retained. */
	readonly credential_digest: Buffer;
}

export interface ResolvedAuthConfig {
	readonly principals: readonly PrincipalConfig[];
	readonly allowed_origins: ReadonlySet<string>;
	/** `Secure` cookie attribute iff the primary allowed origin is https (R-N7). */
	readonly secure_cookie: boolean;
	readonly session_ttl_ms: number;
	readonly idle_timeout_ms: number;
	readonly challenge_ttl_ms: number;
	readonly max_sessions_per_principal: number;
	readonly max_body_bytes: number;
	readonly base_path: string;
	readonly clock: Clock;
}

export type ConfigResult =
	| { ok: true; config: ResolvedAuthConfig }
	| { ok: false; reason: string };

export const digestSecret = (s: string): Buffer =>
	createHash("sha256").update(s, "utf8").digest();

/** `v` if it is exactly an http(s) origin in serialized form, else null (no path/userinfo/case/slash). */
export function exactOrigin(v: unknown): string | null {
	if (typeof v !== "string" || v.length === 0 || v.length > 255) return null;
	let url: URL;
	try {
		url = new URL(v);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	return url.origin === v ? v : null;
}

export function clampMs(
	v: number | undefined,
	fallback: number,
	min: number,
	max: number,
): number {
	if (v === undefined || !Number.isFinite(v)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(v)));
}

/** Validate the launcher options. Reasons are fixed strings and never contain a credential. */
export function resolveWorkspaceAuthConfig(
	o: WorkspaceAuthOptions,
): ConfigResult {
	if (o.operator_credential === undefined || o.operator_credential === "")
		return { ok: false, reason: "workspace operator credential is not set" };
	if (!CREDENTIAL_RE.test(o.operator_credential))
		return {
			ok: false,
			reason:
				"workspace operator credential must be 32-512 visible ASCII characters",
		};
	const principals: PrincipalConfig[] = [
		{
			key: "operator",
			scopes: Object.freeze([
				"workspace:read",
				"workspace:decide",
			] as const satisfies readonly OperatorScope[]),
			credential_digest: digestSecret(o.operator_credential),
		},
	];
	if (o.read_only_credential !== undefined) {
		if (!CREDENTIAL_RE.test(o.read_only_credential))
			return {
				ok: false,
				reason: "read-only credential must be 32-512 visible ASCII characters",
			};
		if (o.read_only_credential === o.operator_credential)
			return {
				ok: false,
				reason: "read-only credential must differ from the operator credential",
			};
		principals.push({
			key: "read_only",
			scopes: Object.freeze([
				"workspace:read",
			] as const satisfies readonly OperatorScope[]),
			credential_digest: digestSecret(o.read_only_credential),
		});
	}
	const primary = exactOrigin(o.allowed_origin);
	if (primary === null)
		return {
			ok: false,
			reason:
				"workspace allowed origin must be an exact http(s) origin (scheme://host[:port])",
		};
	const origins = new Set<string>([primary]);
	for (const extra of o.extra_allowed_origins ?? []) {
		const exact = exactOrigin(extra);
		if (exact === null)
			return {
				ok: false,
				reason: "every extra allowed origin must be an exact http(s) origin",
			};
		origins.add(exact);
	}
	const base_path = o.base_path ?? WORKSPACE_API_BASE;
	if (!BASE_PATH_RE.test(base_path))
		return { ok: false, reason: "workspace base path is malformed" };
	const session_ttl_ms = clampMs(
		o.session_ttl_ms,
		SESSION_TTL_DEFAULT_MS,
		TTL_MIN_MS,
		SESSION_TTL_MAX_MS,
	);
	return {
		ok: true,
		config: Object.freeze({
			principals: Object.freeze(principals),
			allowed_origins: origins,
			secure_cookie: primary.startsWith("https:"),
			session_ttl_ms,
			idle_timeout_ms: clampMs(
				o.idle_timeout_ms,
				Math.min(IDLE_TIMEOUT_DEFAULT_MS, session_ttl_ms),
				TTL_MIN_MS,
				session_ttl_ms,
			),
			challenge_ttl_ms: clampMs(
				o.challenge_ttl_ms,
				CHALLENGE_TTL_MAX_MS,
				TTL_MIN_MS,
				CHALLENGE_TTL_MAX_MS,
			),
			max_sessions_per_principal: clampMs(
				o.max_sessions_per_principal,
				MAX_SESSIONS_PER_PRINCIPAL_DEFAULT,
				1,
				MAX_SESSIONS_PER_PRINCIPAL_MAX,
			),
			max_body_bytes: clampMs(
				o.max_body_bytes,
				BODY_LIMIT_DEFAULT_BYTES,
				BODY_LIMIT_MIN_BYTES,
				BODY_LIMIT_MAX_BYTES,
			),
			base_path,
			clock: o.clock ?? systemClock,
		}),
	};
}
