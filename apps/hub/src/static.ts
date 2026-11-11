// Serves the built web UI (apps/web/dist) from the hub on its own port, so one process is enough.
// Mounted inside createApp after every hub route, so hostGuard/corsGuard run first, exactly as for
// /api. Only regular files whose real path stays inside the dist dir are served; GET/HEAD only;
// no directory listing; source maps are never served. Hub route prefixes (/api, /ingest, /ws,
// /healthz) never fall back to index.html — their misses keep the hub's plain 404, also when the
// prefix is disguised (`//api`, `/%2Fhealthz`, `/%2e/api`, `/api%2Fnope`, any case).
import { realpathSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { Handler } from "hono";

/** Repo root (apps/hub/src → ../../..), so the default dist does not depend on the cwd. */
export const REPO_ROOT = resolve(import.meta.dir, "../../..");
export const DEFAULT_WEB_DIST = join(REPO_ROOT, "apps", "web", "dist");

/** Hub route prefixes: a miss under these is a 404, never index.html. */
export const RESERVED_PREFIXES = ["/api", "/ingest", "/ws", "/healthz"];
const RESERVED_SEGMENTS = new Set(RESERVED_PREFIXES.map((p) => p.slice(1)));

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".txt": "text/plain; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".wasm": "application/wasm",
};

export const contentTypeFor = (file: string) =>
	CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";

/** First path segment after collapsing repeated slashes and skipping `.`/`..` segments. */
const firstSegment = (path: string) =>
	path.split(/[/\\]+/).find((s) => s !== "" && s !== "." && s !== "..") ?? "";

/**
 * True when the path is, or is below, a hub route prefix — checked on the raw path and on the
 * path percent-decoded once (so `%2F` counts as `/` and `%2e` as `.`), after collapsing repeated
 * slashes and dot segments, case-insensitively. Over-matching only ever yields a 404.
 */
export const isReservedPath = (rawPathname: string) => {
	const candidates = [rawPathname];
	try {
		candidates.push(decodeURIComponent(rawPathname));
	} catch {
		// bad encoding: staticSegments refuses it anyway
	}
	return candidates.some((p) =>
		RESERVED_SEGMENTS.has(firstSegment(p).toLowerCase()),
	);
};

/** Source maps (`*.map`, `*.map.*`) are never served, even when present in dist. */
export const isSourceMap = (name: string) => /\.map(\.|$)/i.test(name);

/**
 * URL pathname (raw, still percent-encoded) → path segments inside dist, or null when the path
 * must be refused: bad percent-encoding, NUL, backslash, `.`/`..` or any dot-segment (dotfiles),
 * a hub route prefix (see isReservedPath) or a source map. Pure; the caller still checks the real
 * path on disk.
 */
export function staticSegments(rawPathname: string): string[] | null {
	if (isReservedPath(rawPathname)) return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(rawPathname);
	} catch {
		return null;
	}
	if (!decoded.startsWith("/")) return null;
	if (decoded.includes("\0") || decoded.includes("\\")) return null;
	const segments = decoded.split("/").filter((s) => s !== "");
	if (segments.some((s) => s.startsWith("."))) return null;
	if (segments.some(isSourceMap)) return null;
	return segments;
}

/** Real path of `candidate` if it is a regular file inside `root` (already a real path). */
async function fileInside(
	root: string,
	candidate: string,
): Promise<string | null> {
	try {
		const real = await realpath(candidate);
		if (!real.startsWith(root + sep)) return null;
		return (await stat(real)).isFile() ? real : null;
	} catch {
		return null;
	}
}

/**
 * True only when the client lists `text/html` explicitly with q > 0. `text/html` is the most
 * specific range, so `text/*` / `*\/*` (whatever their q) never override it. No Accept header, a
 * bare `*\/*` or `*\/*;q=0` → false (no SPA fallback), as before; `text/html;q=0`, a malformed q,
 * or any listed `text/html` at q=0 → refused.
 */
export function acceptsHtml(accept: string | undefined): boolean {
	if (accept === undefined) return false;
	let html: number | undefined;
	for (const part of accept.split(",")) {
		const [range = "", ...params] = part.split(";").map((x) => x.trim());
		if (range.toLowerCase() !== "text/html") continue;
		let weight = 1;
		for (const param of params) {
			const [k = "", v = ""] = param.split("=").map((x) => x.trim());
			if (k.toLowerCase() !== "q") continue;
			weight = /^(0(\.\d{0,3})?|1(\.0{0,3})?)$/.test(v) ? Number(v) : 0;
		}
		html = Math.min(html ?? 1, weight);
	}
	return html !== undefined && html > 0;
}

export interface WebDist {
	/** Real path of a dist dir that holds index.html; null → static serving disabled. */
	dir: string | null;
	/** The single startup log line (repo-relative or as configured; never a resolved home path). */
	logLine: string;
}

/**
 * Default `apps/web/dist` under the repo; `AGENTCITY_WEB_DIST` (absolute, or relative to the repo
 * root) overrides it when non-blank. Missing dir or index.html → disabled.
 */
export function resolveWebDist(override: string | undefined): WebDist {
	const raw = override?.trim() ?? "";
	const configured = raw ? resolve(REPO_ROOT, raw) : DEFAULT_WEB_DIST;
	const label = raw
		? "AGENTCITY_WEB_DIST"
		: relative(REPO_ROOT, DEFAULT_WEB_DIST).split(sep).join("/");
	try {
		const dir = realpathSync(configured);
		if (
			statSync(dir).isDirectory() &&
			statSync(join(dir, "index.html")).isFile()
		) {
			return {
				dir,
				logLine: `[hub] web UI: serving ${label} on the hub port`,
			};
		}
	} catch {
		// fall through: disabled
	}
	return {
		dir: null,
		logLine: `[hub] web UI: not served (no index.html in ${label}; build it with bun --filter '@agent-city/web' build)`,
	};
}

/** GET/HEAD catch-all for the built web UI; `distDir` must be a real path. */
export function webStatic(distDir: string): Handler {
	const root = distDir;
	const assetsDir = join(root, "assets") + sep;

	const send = (file: string, index: boolean) => {
		const cache = index
			? "no-store"
			: file.startsWith(assetsDir)
				? "public, max-age=31536000, immutable"
				: "no-cache";
		return new Response(Bun.file(file), {
			status: 200,
			headers: {
				"content-type": contentTypeFor(file),
				"cache-control": cache,
				"x-content-type-options": "nosniff",
			},
		});
	};

	return async (c) => {
		const pathname = new URL(c.req.url).pathname;
		// Hub route misses (/api/nope, /ingest/…): untouched plain 404, as without a dist.
		if (isReservedPath(pathname)) return c.notFound();
		c.header("x-content-type-options", "nosniff");
		const segments = staticSegments(pathname);
		if (segments === null) return c.notFound();

		const index = await fileInside(root, join(root, "index.html"));
		if (segments.length === 0) return index ? send(index, true) : c.notFound();

		const file = await fileInside(root, join(root, ...segments));
		// a symlink alias inside dist must not expose a source map either
		if (file && isSourceMap(basename(file))) return c.notFound();
		if (file) return send(file, file === index);

		// SPA fallback: page-like paths only (no extension, not under /assets), for HTML clients.
		const last = segments[segments.length - 1] ?? "";
		const assetLike = segments[0] === "assets" || last.includes(".");
		if (!assetLike && index && acceptsHtml(c.req.header("accept"))) {
			return send(index, true);
		}
		return c.notFound();
	};
}
