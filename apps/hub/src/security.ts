// Loopback hardening against DNS rebinding and cross-site use of the hub from a browser.
//   Host   — every HTTP request (incl. /healthz, /ws): hostname must be 127.0.0.1, localhost, [::1]
//            or HUB_HOST; any port (the Vite proxy forwards Host 127.0.0.1:5173). Else 403.
//   Origin — /ws upgrades: absent (non-browser client) is fine; otherwise it must be
//            http(s)://127.0.0.1:*, http(s)://localhost:* or an explicitly allowed origin (e.g. a
//            Vite dev origin on another host). Else 403 before the upgrade.
//   CORS   — Access-Control-Allow-Origin only echoes allowlisted origins; never `*`, never
//            credentials.
import type { MiddlewareHandler } from "hono";

export interface SecurityConfig {
	/** HUB_HOST (bind address); also accepted as a Host hostname. */
	hubHost: string;
	/** Exact extra origins, e.g. a Vite dev server not on 127.0.0.1/localhost. */
	extraOrigins?: readonly string[];
}

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
const LOOPBACK_ORIGIN_HOSTS = new Set(["127.0.0.1", "localhost"]);

const normalizeHost = (h: string) => {
	const lower = h.trim().toLowerCase();
	// bare IPv6 (HUB_HOST=::1) → bracketed, as it appears in a Host header
	return lower.includes(":") && !lower.startsWith("[") ? `[${lower}]` : lower;
};

/** Hostname part of a Host header (`name[:port]`, `[v6][:port]`); null when malformed. */
export function hostnameOf(hostHeader: string): string | null {
	const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(
		hostHeader.trim(),
	);
	return m?.[1] ? m[1].toLowerCase() : null;
}

export function isAllowedHost(
	hostHeader: string | null | undefined,
	cfg: SecurityConfig,
): boolean {
	if (!hostHeader) return false;
	const name = hostnameOf(hostHeader);
	if (!name) return false;
	return LOOPBACK_HOSTS.includes(name) || name === normalizeHost(cfg.hubHost);
}

export function isAllowedOrigin(origin: string, cfg: SecurityConfig): boolean {
	if (cfg.extraOrigins?.includes(origin)) return true;
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false; // includes the opaque "null" origin
	}
	return (
		(url.protocol === "http:" || url.protocol === "https:") &&
		LOOPBACK_ORIGIN_HOSTS.has(url.hostname) &&
		url.origin === origin // no path / userinfo smuggling
	);
}

/** Request's Host: the header, or the URL authority when a test harness omits the header. */
const hostOf = (req: Request) =>
	req.headers.get("host") ?? new URL(req.url).host;

export function hostGuard(cfg: SecurityConfig): MiddlewareHandler {
	return async (c, next) => {
		if (!isAllowedHost(hostOf(c.req.raw), cfg)) {
			return c.json({ error: "forbidden host" }, 403);
		}
		await next();
	};
}

/** Paths that never get CORS: the workspace UI is same-origin (Vite proxy), its guard checks Origin. */
const NO_CORS_PREFIX = "/api/workspace";

export function corsGuard(cfg: SecurityConfig): MiddlewareHandler {
	return async (c, next) => {
		const path = c.req.path;
		// No allow-origin echo and no preflight answer for the workspace API (M1): a cross-port page
		// on loopback must not get credentialed CORS; a preflight then reaches the workspace guard.
		if (path === NO_CORS_PREFIX || path.startsWith(`${NO_CORS_PREFIX}/`))
			return next();
		const origin = c.req.header("origin");
		const allowed = origin !== undefined && isAllowedOrigin(origin, cfg);
		if (c.req.method === "OPTIONS" && origin !== undefined) {
			if (!allowed) return c.body(null, 403);
			return c.body(null, 204, {
				"access-control-allow-origin": origin,
				"access-control-allow-methods": "GET, POST",
				"access-control-allow-headers": "authorization, content-type",
				"access-control-max-age": "600",
				vary: "Origin",
			});
		}
		await next();
		c.header("vary", "Origin", { append: true });
		if (allowed) c.header("access-control-allow-origin", origin);
	};
}

/** Gate for /ws before upgrading: null = OK, else the 403 to return. */
export function checkWsRequest(
	req: Request,
	cfg: SecurityConfig,
): Response | null {
	if (!isAllowedHost(hostOf(req), cfg)) {
		return Response.json({ error: "forbidden host" }, { status: 403 });
	}
	const origin = req.headers.get("origin");
	if (origin !== null && !isAllowedOrigin(origin, cfg)) {
		return Response.json({ error: "forbidden origin" }, { status: 403 });
	}
	return null;
}
