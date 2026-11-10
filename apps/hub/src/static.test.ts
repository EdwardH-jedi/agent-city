// Built web UI served by the hub on its own port (apps/hub/src/static.ts). Uses a throwaway dist
// under TMPDIR with a sibling package.json as the "outside" file traversal must never reach.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import {
	createApp,
	DEFAULT_HUB_HOST,
	hubHostFromEnv,
	startHub,
} from "./index.ts";
import {
	acceptsHtml,
	DEFAULT_WEB_DIST,
	isReservedPath,
	REPO_ROOT,
	resolveWebDist,
	staticSegments,
} from "./static.ts";

const HOST = "127.0.0.1:4317";
const OUTSIDE_MARKER = "outside-dist-marker";
const INDEX_HTML =
	'<!doctype html><title>city</title><script type="module" src="/assets/index-abc123.js"></script>';
const ASSET_JS = "console.log('city');";
const SOURCE_MAP =
	'{"version":3,"sources":["src/secret-source.ts"],"mappings":""}';
/** Disguised hub route prefixes: each must 404 like the plain hub, never return index.html. */
const DISGUISED_RESERVED = [
	"//api/nope",
	"/%2Fhealthz",
	"/%2fhealthz/x",
	"/%2e/api/x",
	"/api%2Fnope",
	"/./ingest/x",
	"///ws/x",
	"/%2F%2Fapi",
	"/Api%2Fx",
];

let root: string;
let dist: string;

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "ac-web-")));
	dist = join(root, "dist");
	mkdirSync(join(dist, "assets"), { recursive: true });
	mkdirSync(join(dist, "sub"));
	writeFileSync(join(root, "package.json"), `{"name":"${OUTSIDE_MARKER}"}`);
	writeFileSync(join(dist, "index.html"), INDEX_HTML);
	writeFileSync(join(dist, "assets", "index-abc123.js"), ASSET_JS);
	writeFileSync(join(dist, "assets", "index-abc123.css"), "body{}");
	writeFileSync(join(dist, "robots.txt"), "User-agent: *");
	writeFileSync(join(dist, "assets", "app.js.map"), SOURCE_MAP);
	writeFileSync(join(dist, "assets", "app.js.map.json"), SOURCE_MAP);
	writeFileSync(join(dist, "app.css.MAP"), SOURCE_MAP);
	symlinkSync(
		join(dist, "assets", "app.js.map"),
		join(dist, "assets", "alias.js"),
	);
	writeFileSync(join(dist, ".secret"), OUTSIDE_MARKER);
	symlinkSync(join(root, "package.json"), join(dist, "escape.json"));
	symlinkSync(join(root, "package.json"), join(dist, "assets", "escape.js"));
	symlinkSync(root, join(dist, "rootlink"));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

const appWith = (webDist: string | null) =>
	createApp({
		db: openDb(":memory:"),
		ingestToken: undefined,
		publish: () => {},
		webDist,
	});

const get = (
	app: ReturnType<typeof createApp>,
	path: string,
	headers: Record<string, string> = {},
	method = "GET",
) =>
	app.request(path, {
		method,
		headers: { host: HOST, accept: "text/html", ...headers },
	});

describe("web UI from the hub: serving", () => {
	test("/ and /index.html → index.html, text/html, no-store, nosniff", async () => {
		const app = appWith(dist);
		for (const path of ["/", "/index.html"]) {
			const res = await get(app, path);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
			expect(res.headers.get("cache-control")).toBe("no-store");
			expect(res.headers.get("x-content-type-options")).toBe("nosniff");
			expect(await res.text()).toBe(INDEX_HTML);
		}
	});

	test("hashed assets → JS/CSS types, immutable cache", async () => {
		const app = appWith(dist);
		const js = await get(app, "/assets/index-abc123.js", { accept: "*/*" });
		expect(js.status).toBe(200);
		expect(js.headers.get("content-type")).toBe(
			"text/javascript; charset=utf-8",
		);
		expect(js.headers.get("cache-control")).toBe(
			"public, max-age=31536000, immutable",
		);
		expect(js.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await js.text()).toBe(ASSET_JS);

		const css = await get(app, "/assets/index-abc123.css", { accept: "*/*" });
		expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");

		const txt = await get(app, "/robots.txt", { accept: "*/*" });
		expect(txt.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(txt.headers.get("cache-control")).toBe("no-cache");
	});

	test("HEAD gets headers without a body; POST is not served", async () => {
		const app = appWith(dist);
		const head = await get(app, "/assets/index-abc123.js", {}, "HEAD");
		expect(head.status).toBe(200);
		expect(head.headers.get("content-type")).toBe(
			"text/javascript; charset=utf-8",
		);
		expect(await head.text()).toBe("");
		expect((await get(app, "/index.html", {}, "POST")).status).toBe(404);
		expect((await get(app, "/", {}, "PUT")).status).toBe(404);
	});

	test("SPA fallback: page-like paths that accept HTML → index.html", async () => {
		const app = appWith(dist);
		for (const path of ["/city", "/repos/owner/name", "/sub", "/sub/"]) {
			const res = await get(app, path);
			expect(res.status).toBe(200);
			expect(res.headers.get("cache-control")).toBe("no-store");
			expect(await res.text()).toBe(INDEX_HTML);
		}
	});

	test("no fallback for non-HTML clients, missing assets or file-like paths", async () => {
		const app = appWith(dist);
		expect(
			(await get(app, "/city", { accept: "application/json" })).status,
		).toBe(404);
		for (const path of ["/assets/missing.js", "/assets", "/favicon.ico"]) {
			const res = await get(app, path);
			expect(res.status).toBe(404);
			expect(await res.text()).not.toContain("<title>");
		}
	});

	test("Accept q-values: text/html at q=0 is refused, q>0 still falls back", async () => {
		const app = appWith(dist);
		for (const accept of [
			"application/json, text/html;q=0",
			"text/html;q=0",
			"text/html; q=0.000",
			"TEXT/HTML;Q=0",
			"text/html;level=1;q=0",
			"text/html, text/html;q=0",
			"text/html;q=bogus",
			"*/*;q=0",
			"*/*",
			"text/*",
		]) {
			const res = await get(app, "/city", { accept });
			expect(res.status).toBe(404);
			expect(await res.text()).not.toContain("<title>");
		}
		for (const accept of [
			"text/html",
			"text/html;q=0.5",
			"application/json;q=1, text/html;q=0.001",
			"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"text/html, */*;q=0",
		]) {
			const res = await get(app, "/city", { accept });
			expect(res.status).toBe(200);
			expect(await res.text()).toBe(INDEX_HTML);
		}
		expect(acceptsHtml(undefined)).toBe(false);
		expect(acceptsHtml("")).toBe(false);
	});

	test("source maps are never served, even when present in dist", async () => {
		const app = appWith(dist);
		for (const path of [
			"/assets/app.js.map",
			"/assets/app.js.MAP",
			"/assets/app.js.map.json",
			"/app.css.MAP",
			"/assets/app.js%2Emap",
			"/assets/alias.js",
		]) {
			for (const accept of ["*/*", "text/html", "application/json"]) {
				const res = await get(app, path, { accept });
				expect(res.status).toBe(404);
				const body = await res.text();
				expect(body).not.toContain("secret-source");
				expect(body).not.toContain("<title>");
			}
		}
		// ordinary assets next to them are still served
		expect(
			(await get(app, "/assets/index-abc123.js", { accept: "*/*" })).status,
		).toBe(200);
	});

	test("disguised hub prefixes (//api, %2F, %2e, any case) 404 like the plain hub", async () => {
		const app = appWith(dist);
		const plain = appWith(null);
		for (const path of DISGUISED_RESERVED) {
			const res = await get(app, path, { accept: "text/html" });
			const before = await get(plain, path, { accept: "text/html" });
			expect(res.status).toBe(404);
			expect(before.status).toBe(404);
			const body = await res.text();
			expect(body).toBe(await before.text());
			expect(body).not.toContain("<title>");
		}
		// an ordinary page route still falls back
		const city = await get(app, "/city", { accept: "text/html" });
		expect(city.status).toBe(200);
		expect(city.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(await city.text()).toBe(INDEX_HTML);
	});

	test("disguised hub prefixes on raw request lines never get index.html", async () => {
		const hub = startHub({
			db: openDb(":memory:"),
			ingestToken: undefined,
			hostname: "127.0.0.1",
			port: 0,
			webDist: dist,
		});
		try {
			for (const target of DISGUISED_RESERVED) {
				const raw = await rawGet(hub.server.port ?? 0, target, "text/html");
				expect(raw).toStartWith("HTTP/1.1 404");
				expect(raw).not.toContain("<title>");
			}
			const city = await rawGet(hub.server.port ?? 0, "/city", "text/html");
			expect(city).toStartWith("HTTP/1.1 200");
			expect(city).toContain("<title>city</title>");
		} finally {
			hub.stop();
		}
	});

	test("hub route misses never fall back to index.html; hub routes unchanged", async () => {
		const app = appWith(dist);
		const plain = appWith(null);
		for (const path of [
			"/api/nope",
			"/api",
			"/ingest/nope",
			"/ws/x",
			"/healthz/x",
			"/API/nope",
		]) {
			const res = await get(app, path);
			const before = await get(plain, path);
			expect(res.status).toBe(404);
			expect(res.status).toBe(before.status);
			expect(res.headers.get("content-type")).toBe(
				before.headers.get("content-type"),
			);
			const body = await res.text();
			expect(body).toBe(await before.text());
			expect(body).not.toContain("<title>");
		}
		const repos = await get(app, "/api/repos");
		expect(repos.status).toBe(200);
		expect(repos.headers.get("content-type")).toContain("application/json");
		expect((await get(app, "/healthz")).status).toBe(200);
		// ingest auth unchanged (disabled here → 503, not index.html)
		const ingest = await get(app, "/ingest", {}, "POST");
		expect(ingest.status).toBe(
			(await get(plain, "/ingest", {}, "POST")).status,
		);
	});
});

describe("web UI from the hub: path safety", () => {
	test.each([
		"/../package.json",
		"/%2e%2e/package.json",
		"/%2e%2e%2fpackage.json",
		"/assets/..%2f..%2fpackage.json",
		"/assets/%2e%2e/%2e%2e/package.json",
		"/..%5cpackage.json",
		"/index.html%00.js",
		"/%E0%A4%A",
		"/.secret",
		"/escape.json",
		"/assets/escape.js",
		"/rootlink/package.json",
	])("%p → 404, nothing outside dist leaks", async (path) => {
		const res = await get(appWith(dist), path, { accept: "*/*" });
		expect(res.status).toBe(404);
		expect(await res.text()).not.toContain(OUTSIDE_MARKER);
	});

	test("raw request lines with traversal never reach outside dist", async () => {
		const hub = startHub({
			db: openDb(":memory:"),
			ingestToken: undefined,
			hostname: "127.0.0.1",
			port: 0,
			webDist: dist,
		});
		try {
			for (const target of [
				"/../package.json",
				"/%2e%2e/package.json",
				"/%2e%2e%2fpackage.json",
				"/assets/../../package.json",
			]) {
				const raw = await rawGet(hub.server.port ?? 0, target);
				expect(raw).toStartWith("HTTP/1.1 ");
				expect(raw).not.toContain(OUTSIDE_MARKER);
			}
		} finally {
			hub.stop();
		}
	});

	test("staticSegments refuses dot segments, NUL, backslash, bad encoding, hub prefixes", () => {
		for (const p of [
			"/..",
			"/../package.json",
			"/%2e%2e/package.json",
			"/%2E%2E/package.json",
			"/a/..%2f..%2fpackage.json",
			"/a/%2e/b",
			"/.env",
			"/a%00b",
			"/a\\b",
			"/a%5cb",
			"/%zz",
			"/%E0%A4%A",
			"/api/x",
			"/%61pi/x",
			"/ingest",
			"/ws",
			"/healthz",
			"//api/nope",
			"/%2Fhealthz",
			"/%2e/api/x",
			"/api%2Fnope",
			"/./ingest/x",
			"/a/../api",
			"/API/x",
			"/assets/app.js.map",
			"/assets/app.js.map.json",
			"/x.MAP",
		])
			expect(staticSegments(p)).toBeNull();
		for (const p of DISGUISED_RESERVED) expect(isReservedPath(p)).toBe(true);
		for (const p of [
			"/",
			"/city",
			"/apiary",
			"/assets/api",
			"/sub/ws",
			"/%61piary",
		])
			expect(isReservedPath(p)).toBe(false);
		expect(staticSegments("/mapper")).toEqual(["mapper"]);
		expect(staticSegments("/assets/sitemap.xml")).toEqual([
			"assets",
			"sitemap.xml",
		]);
		expect(staticSegments("/")).toEqual([]);
		expect(staticSegments("/assets/index-abc123.js")).toEqual([
			"assets",
			"index-abc123.js",
		]);
		expect(staticSegments("/apiary")).toEqual(["apiary"]);
		expect(staticSegments("/a%20b")).toEqual(["a b"]);
	});
});

describe("web UI from the hub: Host / Origin", () => {
	test.each([
		"evil.example",
		"127.0.0.1.evil.example",
		"localhost.evil.example:4317",
	])("forged Host %p → same 403 on static paths as on /api", async (host) => {
		const app = appWith(dist);
		const api = await get(app, "/api/repos", { host });
		expect(api.status).toBe(403);
		const apiBody = await api.text();
		for (const path of [
			"/",
			"/index.html",
			"/assets/index-abc123.js",
			"/city",
		]) {
			const res = await get(app, path, { host });
			expect(res.status).toBe(403);
			expect(await res.text()).toBe(apiBody);
		}
	});

	test("foreign Origin: preflight 403 and no CORS grant, exactly as on /api", async () => {
		const app = appWith(dist);
		for (const origin of [
			"https://evil.example",
			"http://localhost.evil.example",
			"null",
		]) {
			for (const path of ["/api/repos", "/", "/assets/index-abc123.js"]) {
				const pre = await get(app, path, { origin }, "OPTIONS");
				expect(pre.status).toBe(403);
				expect(pre.headers.get("access-control-allow-origin")).toBeNull();
				const res = await get(app, path, { origin });
				expect(res.headers.get("access-control-allow-origin")).toBeNull();
				expect(res.headers.get("vary")).toContain("Origin");
			}
			const api = await get(app, "/api/repos", { origin });
			const page = await get(app, "/", { origin });
			expect(page.status).toBe(api.status);
		}
		// a loopback origin is granted on both, as before
		const ok = await get(app, "/", { origin: "http://127.0.0.1:5173" });
		expect(ok.headers.get("access-control-allow-origin")).toBe(
			"http://127.0.0.1:5173",
		);
	});
});

describe("web UI from the hub: disabled", () => {
	test("no dist → static paths 404, API unchanged", async () => {
		const app = appWith(null);
		for (const path of ["/", "/index.html", "/assets/index-abc123.js", "/city"])
			expect((await get(app, path)).status).toBe(404);
		expect((await get(app, "/api/repos")).status).toBe(200);
		expect((await get(app, "/healthz")).status).toBe(200);
		expect(
			(await get(app, "/api/repos", { host: "evil.example" })).status,
		).toBe(403);
	});

	test("resolveWebDist: missing dir or missing index.html → disabled, one log line", () => {
		const empty = join(root, "empty-dist");
		mkdirSync(empty, { recursive: true });
		for (const dir of [join(root, "nope"), empty]) {
			const r = resolveWebDist(dir);
			expect(r.dir).toBeNull();
			expect(r.logLine).toContain("not served");
			expect(r.logLine).not.toContain("\n");
			expect(r.logLine).not.toContain(root);
		}
		const ok = resolveWebDist(dist);
		expect(ok.dir).toBe(realpathSync(dist));
		expect(ok.logLine).toContain("AGENTCITY_WEB_DIST");
		expect(ok.logLine).not.toContain(root);
	});

	test("blank override → the repo's apps/web/dist, independent of cwd", () => {
		expect(DEFAULT_WEB_DIST).toBe(join(REPO_ROOT, "apps", "web", "dist"));
		for (const v of [undefined, "", "   "]) {
			const r = resolveWebDist(v);
			expect(r.logLine).toContain("apps/web/dist");
			expect(r.logLine).not.toContain(REPO_ROOT);
		}
	});
});

describe("bind address", () => {
	test("default bind stays 127.0.0.1; serving the UI does not widen it", () => {
		expect(DEFAULT_HUB_HOST).toBe("127.0.0.1");
		expect(hubHostFromEnv({})).toBe("127.0.0.1");
		expect(hubHostFromEnv({ HUB_HOST: "" })).toBe("127.0.0.1");
		expect(hubHostFromEnv({ AGENTCITY_WEB_DIST: dist })).toBe("127.0.0.1");
		const hub = startHub({
			db: openDb(":memory:"),
			ingestToken: undefined,
			hostname: hubHostFromEnv({}),
			port: 0,
			webDist: dist,
		});
		try {
			expect(hub.server.hostname).toBe("127.0.0.1");
		} finally {
			hub.stop();
		}
	});
});

/** Send a request line verbatim (no client-side URL normalisation) and return the raw response. */
async function rawGet(
	port: number,
	target: string,
	accept = "*/*",
): Promise<string> {
	let out = "";
	const { promise, resolve } = Promise.withResolvers<string>();
	const socket = await Bun.connect({
		hostname: "127.0.0.1",
		port,
		socket: {
			data(_s, chunk) {
				out += chunk.toString();
			},
			close() {
				resolve(out);
			},
			error() {
				resolve(out);
			},
		},
	});
	socket.write(
		`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: ${accept}\r\nConnection: close\r\n\r\n`,
	);
	const timer = setTimeout(() => {
		socket.end();
		resolve(out);
	}, 2000);
	const res = await promise;
	clearTimeout(timer);
	return res;
}
