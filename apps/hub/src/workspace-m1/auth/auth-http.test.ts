// HTTP-level tests of the workspace auth guard + session routes (role 03). Negative-heavy: every
// rejection also proves the route handler never ran. Credentials, cookies, CSRF values and forged
// tokens are generated at runtime (nothing token-shaped is written in this file).
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
	CSRF_HEADER,
	OPERATOR_ID,
	SessionView,
} from "@agent-city/schema/workspace-m1";
import { Hono } from "hono";
import { createWorkspaceAuth } from "./auth.ts";
import { SESSION_COOKIE } from "./http.ts";
import {
	BASE,
	captureConsole,
	type Harness,
	harness,
	mutationHeaders,
	newCredential,
	ORIGIN,
	runRequestRow,
	type Session,
	signIn,
} from "./test-support.ts";

const token43 = () => randomBytes(32).toString("base64url");
const TASK = "wst-11111111-1111-4111-8111-111111111111";
const REQ = "wsa-33333333-3333-4333-8333-333333333331";
const ART = "art-77777777-7777-4777-8777-777777777771";

/** Every WORKSPACE_ROUTES entry except sign-in, with its stub key (null = auth-owned route). */
const ROUTES: [method: string, path: string, key: string | null][] = [
	["GET", "/session", null],
	["DELETE", "/session", null],
	["GET", "/snapshot", "snapshot"],
	["POST", "/tasks", "tasks"],
	["GET", `/tasks/${TASK}`, "task"],
	["PUT", `/tasks/${TASK}/draft`, "draft"],
	["POST", `/tasks/${TASK}/proposals`, "proposals"],
	["POST", `/tasks/${TASK}/rerun`, "rerun"],
	["POST", `/tasks/${TASK}/cancel`, "cancel"],
	["GET", `/tasks/${TASK}/artifacts/${ART}`, "artifact"],
	["POST", `/approval-requests/${REQ}/challenge`, "challenge"],
	["POST", `/approval-requests/${REQ}/decisions`, "decisions"],
];
const MUTATIONS = ROUTES.filter(
	([m, p]) => m !== "GET" && !(m === "DELETE" && p === "/session"),
);

const call = (
	h: Harness,
	method: string,
	path: string,
	headers: Record<string, string> = {},
	body?: string,
) =>
	h.app.request(`${BASE}${path}`, {
		method,
		headers,
		body: method === "GET" || method === "HEAD" ? undefined : (body ?? "{}"),
	});

const errorOf = async (res: Response) =>
	((await res.json()) as { error?: string }).error;

const totalHits = (h: Harness) =>
	[...h.hits.values()].reduce((a, b) => a + b, 0);

const postTasks = (
	h: Harness,
	s: Session,
	over: Record<string, string | undefined> = {},
	body = "{}",
) => call(h, "POST", "/tasks", mutationHeaders(s, over), body);

const getSnapshot = (h: Harness, headers: Record<string, string>) =>
	call(h, "GET", "/snapshot", headers);

// ── sign-in ─────────────────────────────────────────────────────────────────

describe("sign-in (POST /session)", () => {
	test("valid credential → SessionView + hardened cookie; no secret material in the body", async () => {
		const h = harness();
		const s = await signIn(h);
		const view = SessionView.parse(s.body);
		expect(view.operator_id).toBe(OPERATOR_ID);
		expect(view.scopes).toEqual(["workspace:read", "workspace:decide"]);
		expect(Object.keys(s.body).sort()).toEqual([
			"csrf_token",
			"expires_at",
			"operator_id",
			"scopes",
		]);
		const parts = s.setCookie.split("; ");
		expect(parts[0]).toMatch(
			new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}$`),
		);
		expect(parts).toContain("HttpOnly");
		expect(parts).toContain("SameSite=Strict");
		expect(parts).toContain(`Path=${BASE}`);
		expect(parts).toContain("Max-Age=28800");
		expect(parts.some((p) => /^domain=/i.test(p))).toBe(false);
		expect(parts).not.toContain("Secure"); // http loopback origin (R-N7)
		const value = s.cookie.split("=")[1] ?? "";
		const text = JSON.stringify(s.body);
		expect(text).not.toContain(value);
		expect(text).not.toContain(h.operatorCredential);
		expect(text).not.toContain(h.auth.boot_id ?? "boot-");
	});

	test("Secure is set iff the configured origin is https", async () => {
		const https = "https://127.0.0.1:8443";
		const h = harness({ allowed_origin: https });
		const res = await h.app.request(`${BASE}/session`, {
			method: "POST",
			headers: { origin: https, "content-type": "application/json" },
			body: JSON.stringify({ credential: h.operatorCredential }),
		});
		expect(res.status).toBe(200);
		expect((res.headers.get("set-cookie") ?? "").split("; ")).toContain(
			"Secure",
		);
	});

	test("wrong / altered credentials → 401 or 400, never a cookie, never echoed", async () => {
		const h = harness();
		const c = h.operatorCredential;
		for (const credential of [
			newCredential(),
			`${c} `,
			` ${c}`,
			c.toUpperCase() === c ? c.toLowerCase() : c.toUpperCase(),
			c.slice(0, -1),
			`${c}x`,
		]) {
			const res = await h.app.request(`${BASE}/session`, {
				method: "POST",
				headers: { origin: ORIGIN, "content-type": "application/json" },
				body: JSON.stringify({ credential }),
			});
			expect(res.status).toBe(401);
			expect(res.headers.get("set-cookie")).toBeNull();
			const text = await res.text();
			expect(text).not.toContain(credential.trim());
			expect(JSON.parse(text)).toEqual({
				error: "unauthenticated",
				message: "sign-in required",
			});
		}
	});

	test("read-only credential → workspace:read only (same frozen operator id)", async () => {
		const h = harness();
		const s = await signIn(h, h.readOnlyCredential);
		expect(s.body.scopes).toEqual(["workspace:read"]);
		expect(s.body.operator_id).toBe(OPERATOR_ID);
	});

	test("sign-in needs the exact Origin and JSON even with the right credential", async () => {
		const h = harness();
		const body = JSON.stringify({ credential: h.operatorCredential });
		const cases: [Record<string, string>, number, string][] = [
			[{ "content-type": "application/json" }, 403, "forbidden_origin"],
			[
				{ origin: "http://127.0.0.1:5174", "content-type": "application/json" },
				403,
				"forbidden_origin",
			],
			[
				{ origin: "null", "content-type": "application/json" },
				403,
				"forbidden_origin",
			],
			[
				{ origin: ORIGIN, "content-type": "text/plain" },
				415,
				"unsupported_media_type",
			],
			[{ origin: ORIGIN }, 415, "unsupported_media_type"],
		];
		for (const [headers, status, error] of cases) {
			const res = await h.app.request(`${BASE}/session`, {
				method: "POST",
				headers,
				body,
			});
			expect(res.status).toBe(status);
			expect(await errorOf(res)).toBe(error);
			expect(res.headers.get("set-cookie")).toBeNull();
		}
	});

	test("forged identity fields, malformed JSON and oversize bodies get no session", async () => {
		const h = harness();
		const headers = { origin: ORIGIN, "content-type": "application/json" };
		const forged = await h.app.request(`${BASE}/session`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				credential: h.operatorCredential,
				operator_id: OPERATOR_ID,
				scopes: ["workspace:read", "workspace:decide"],
			}),
		});
		expect(forged.status).toBe(400);
		expect(forged.headers.get("set-cookie")).toBeNull();
		const malformed = await h.app.request(`${BASE}/session`, {
			method: "POST",
			headers,
			body: "{credential:",
		});
		expect(malformed.status).toBe(400);
		const big = await h.app.request(`${BASE}/session`, {
			method: "POST",
			headers,
			body: JSON.stringify({ credential: "x".repeat(5000) }),
		});
		expect(big.status).toBe(413);
		const inQuery = await h.app.request(
			`${BASE}/session?credential=${encodeURIComponent(h.operatorCredential)}`,
			{ method: "POST", headers, body: "{}" },
		);
		expect(inQuery.status).toBe(400);
		expect(inQuery.headers.get("set-cookie")).toBeNull();
	});

	test("a trailing-slash or case variant of the sign-in path is not sign-in (401)", async () => {
		const h = harness();
		for (const path of [`${BASE}/session/`, `${BASE}/Session`]) {
			const res = await h.app.request(path, {
				method: "POST",
				headers: { origin: ORIGIN, "content-type": "application/json" },
				body: JSON.stringify({ credential: h.operatorCredential }),
			});
			expect(res.status).toBe(401);
			expect(res.headers.get("set-cookie")).toBeNull();
		}
	});

	test("the per-run credential is reusable for re-login (by design, not single-use)", async () => {
		const h = harness();
		const a = await signIn(h);
		const b = await signIn(h);
		expect(a.cookie).not.toBe(b.cookie);
		expect(a.csrf).not.toBe(b.csrf);
	});
});

// ── session lifecycle ───────────────────────────────────────────────────────

describe("session lifecycle", () => {
	test("GET /session returns the same CSRF token; reads need no CSRF", async () => {
		const h = harness();
		const s = await signIn(h);
		const res = await call(h, "GET", "/session", { cookie: s.cookie });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { csrf_token: string }).csrf_token).toBe(
			s.csrf,
		);
	});

	test("rotation: signing in with a cookie kills it; the new cookie works", async () => {
		const h = harness();
		const a = await signIn(h);
		const b = await signIn(h, h.operatorCredential, { cookie: a.cookie });
		expect(b.cookie).not.toBe(a.cookie);
		expect((await getSnapshot(h, { cookie: a.cookie })).status).toBe(401);
		expect((await getSnapshot(h, { cookie: b.cookie })).status).toBe(200);
		// A's CSRF does not work with B's cookie
		expect((await postTasks(h, b, { [CSRF_HEADER]: a.csrf })).status).toBe(403);
	});

	test("fixation: a chosen cookie value never becomes valid", async () => {
		const h = harness();
		const chosen = `${SESSION_COOKIE}=${token43()}`;
		const s = await signIn(h, h.operatorCredential, { cookie: chosen });
		expect(s.cookie).not.toBe(chosen);
		expect((await getSnapshot(h, { cookie: chosen })).status).toBe(401);
		expect((await getSnapshot(h, { cookie: s.cookie })).status).toBe(200);
	});

	test("default: concurrent sessions up to the cap, oldest evicted beyond it", async () => {
		const h = harness();
		const s = [];
		for (let i = 0; i < 4; i++) {
			s.push(await signIn(h));
			h.clock.advance(1);
		}
		for (const x of s)
			expect((await getSnapshot(h, { cookie: x.cookie })).status).toBe(200);
		const fifth = await signIn(h);
		expect((await getSnapshot(h, { cookie: s[0]?.cookie ?? "" })).status).toBe(
			401,
		);
		expect((await getSnapshot(h, { cookie: fifth.cookie })).status).toBe(200);
	});

	test("max_sessions_per_principal: 1 → a new sign-in revokes the previous session", async () => {
		const h = harness({ max_sessions_per_principal: 1 });
		const a = await signIn(h);
		const b = await signIn(h);
		expect((await getSnapshot(h, { cookie: a.cookie })).status).toBe(401);
		expect((await getSnapshot(h, { cookie: b.cookie })).status).toBe(200);
		// the read-only principal's cap is separate
		const r = await signIn(h, h.readOnlyCredential);
		expect((await getSnapshot(h, { cookie: b.cookie })).status).toBe(200);
		expect((await getSnapshot(h, { cookie: r.cookie })).status).toBe(200);
	});

	test("absolute lifetime: dead at created + ttl even with constant activity", async () => {
		const h = harness({ session_ttl_ms: 60_000, idle_timeout_ms: 60_000 });
		const s = await signIn(h);
		for (let i = 0; i < 5; i++) {
			h.clock.advance(11_999);
			expect((await getSnapshot(h, { cookie: s.cookie })).status).toBe(200);
		}
		h.clock.advance(5); // 60_000 total
		expect((await getSnapshot(h, { cookie: s.cookie })).status).toBe(401);
	});

	test("idle timeout: activity refreshes it; idle ≥ timeout kills the session", async () => {
		const h = harness({ session_ttl_ms: 600_000, idle_timeout_ms: 10_000 });
		const s = await signIn(h);
		h.clock.advance(9_999);
		expect((await getSnapshot(h, { cookie: s.cookie })).status).toBe(200);
		h.clock.advance(9_999);
		expect((await getSnapshot(h, { cookie: s.cookie })).status).toBe(200);
		h.clock.advance(10_000);
		expect((await getSnapshot(h, { cookie: s.cookie })).status).toBe(401);
	});

	test("a rejected request does not refresh the idle clock", async () => {
		const h = harness({ session_ttl_ms: 600_000, idle_timeout_ms: 10_000 });
		const s = await signIn(h);
		h.clock.advance(9_000);
		expect((await postTasks(h, s, { [CSRF_HEADER]: token43() })).status).toBe(
			403,
		);
		expect(
			(
				await getSnapshot(h, {
					cookie: s.cookie,
					origin: "http://localhost:5173",
				})
			).status,
		).toBe(403);
		h.clock.advance(1_000);
		expect((await getSnapshot(h, { cookie: s.cookie })).status).toBe(401);
	});

	test("SessionView.expires_at is the earlier of absolute and idle expiry", async () => {
		const h = harness({ session_ttl_ms: 600_000, idle_timeout_ms: 10_000 });
		const s = await signIn(h);
		expect(s.body.expires_at).toBe(
			new Date(h.clock.now().getTime() + 10_000).toISOString(),
		);
	});

	test("sign-out: 204 + cleared cookie; cookie and CSRF are dead afterwards", async () => {
		const h = harness();
		const s = await signIn(h);
		const res = await call(
			h,
			"DELETE",
			"/session",
			mutationHeaders(s, { "content-type": undefined }),
			"",
		);
		expect(res.status).toBe(204);
		const cleared = res.headers.get("set-cookie") ?? "";
		expect(cleared.startsWith(`${SESSION_COOKIE}=;`)).toBe(true);
		expect(cleared).toContain("Max-Age=0");
		expect(cleared).toContain(`Path=${BASE}`);
		expect((await getSnapshot(h, { cookie: s.cookie })).status).toBe(401);
		const again = await signIn(h);
		expect((await postTasks(h, again, { [CSRF_HEADER]: s.csrf })).status).toBe(
			403,
		);
	});

	test("sign-out needs exact Origin + CSRF; a refused sign-out leaves the session alive", async () => {
		const h = harness();
		const s = await signIn(h);
		for (const over of [
			{ [CSRF_HEADER]: undefined },
			{ origin: undefined },
			{ origin: "http://127.0.0.1:9999" },
		]) {
			const res = await call(
				h,
				"DELETE",
				"/session",
				mutationHeaders(s, { ...over, "content-type": undefined }),
				"",
			);
			expect(res.status).toBe(403);
		}
		expect((await getSnapshot(h, { cookie: s.cookie })).status).toBe(200);
	});

	test("the read-only principal can sign out (DELETE /session needs workspace:read)", async () => {
		const h = harness();
		const r = await signIn(h, h.readOnlyCredential);
		const res = await call(
			h,
			"DELETE",
			"/session",
			mutationHeaders(r, { "content-type": undefined }),
			"",
		);
		expect(res.status).toBe(204);
		expect((await getSnapshot(h, { cookie: r.cookie })).status).toBe(401);
	});

	test("restart (new auth instance = new boot): old cookie and old CSRF are dead", async () => {
		const first = harness();
		const s = await signIn(first);
		const second = harness(
			{},
			{
				clock: first.clock,
				tx: first.tx,
				operatorCredential: first.operatorCredential,
			},
		);
		expect(second.auth.boot_id).not.toBe(first.auth.boot_id);
		expect((await getSnapshot(second, { cookie: s.cookie })).status).toBe(401);
		expect((await postTasks(second, s)).status).toBe(401);
		const fresh = await signIn(second);
		expect(
			(await postTasks(second, fresh, { [CSRF_HEADER]: s.csrf })).status,
		).toBe(403);
		expect((await postTasks(second, fresh)).status).toBe(200);
	});

	test("revokeAllSessions → every cookie is 401", async () => {
		const h = harness();
		const a = await signIn(h);
		const r = await signIn(h, h.readOnlyCredential);
		h.auth.revokeAllSessions();
		expect((await getSnapshot(h, { cookie: a.cookie })).status).toBe(401);
		expect((await getSnapshot(h, { cookie: r.cookie })).status).toBe(401);
	});
});

// ── 401 without a valid session ─────────────────────────────────────────────

describe("unauthenticated requests get 401 and no data", () => {
	const UNAUTH = { error: "unauthenticated", message: "sign-in required" };

	test("every workspace route, with or without the other protections, no cookie → 401", async () => {
		const h = harness();
		const variants: Record<string, string>[] = [
			{},
			{
				origin: ORIGIN,
				"content-type": "application/json",
				[CSRF_HEADER]: token43(),
			},
			{
				origin: ORIGIN,
				"content-type": "application/json",
				authorization: `Bearer ${newCredential()}`,
			},
			{ origin: "http://evil.test", "content-type": "text/plain" },
		];
		for (const [method, path] of ROUTES)
			for (const headers of variants) {
				const res = await call(h, method, path, headers);
				expect(res.status).toBe(401);
				expect(await res.json()).toEqual(UNAUTH);
				expect(res.headers.get("cache-control")).toBe("no-store");
			}
		expect(totalHits(h)).toBe(0);
	});

	test("the legacy bearer tokens and the credential itself are not session auth", async () => {
		const h = harness();
		for (const authorization of [
			`Bearer ${h.operatorCredential}`,
			`Basic ${h.operatorCredential}`,
		])
			expect((await getSnapshot(h, { authorization })).status).toBe(401);
		expect(
			(
				await getSnapshot(h, {
					cookie: `${SESSION_COOKIE}=${h.operatorCredential}`,
				})
			).status,
		).toBe(401);
		expect(totalHits(h)).toBe(0);
	});

	test("forged, malformed, duplicated, renamed or query-string cookies → 401", async () => {
		const h = harness();
		const s = await signIn(h);
		const value = s.cookie.split("=")[1] ?? "";
		const cookies = [
			`${SESSION_COOKIE}=${token43()}`,
			`${SESSION_COOKIE}=${value.slice(0, 42)}`,
			`${SESSION_COOKIE}=${value}A`,
			`${SESSION_COOKIE}="${value}"`,
			`${SESSION_COOKIE}=${value.slice(0, 42)}.`,
			`${s.cookie}; ${SESSION_COOKIE}=${token43()}`,
			`${SESSION_COOKIE}=${token43()}; ${s.cookie}`,
			`${s.cookie}; ${s.cookie}`,
			`${SESSION_COOKIE.toUpperCase()}=${value}`,
			`x${SESSION_COOKIE}=${value}`,
			`${SESSION_COOKIE}=`,
		];
		for (const cookie of cookies) {
			expect((await getSnapshot(h, { cookie })).status).toBe(401);
			expect((await postTasks(h, s, { cookie })).status).toBe(401);
		}
		for (const q of [
			`?${SESSION_COOKIE}=${value}`,
			`?session=${value}`,
			`?token=${value}`,
		]) {
			const res = await h.app.request(`${BASE}/snapshot${q}`);
			expect(res.status).toBe(401);
		}
		expect(totalHits(h)).toBe(0);
		expect((await getSnapshot(h, { cookie: s.cookie })).status).toBe(200);
	});

	test("HEAD and OPTIONS without a session → 401; unknown paths: 401 unauthenticated, 404 authenticated", async () => {
		const h = harness();
		expect(
			(await h.app.request(`${BASE}/snapshot`, { method: "HEAD" })).status,
		).toBe(401);
		expect(
			(
				await h.app.request(`${BASE}/snapshot`, {
					method: "OPTIONS",
					headers: { origin: ORIGIN },
				})
			).status,
		).toBe(401);
		expect((await h.app.request(`${BASE}/no-such-route`)).status).toBe(401);
		expect(
			(await h.app.request(`${BASE}/tasks/${TASK}/../../session`)).status,
		).toBe(401);
		const s = await signIn(h);
		expect((await getSnapshot(h, { cookie: s.cookie })).status).toBe(200);
		expect(
			(
				await h.app.request(`${BASE}/no-such-route`, {
					headers: { cookie: s.cookie },
				})
			).status,
		).toBe(404);
		expect((await h.app.request("/api/repos")).status).toBe(200); // unrelated API untouched
	});

	test("an unauthenticated crafted live request is 401 before any route sees the body", async () => {
		const h = harness();
		const res = await call(
			h,
			"POST",
			"/tasks",
			{ origin: ORIGIN, "content-type": "application/json" },
			JSON.stringify({ execution_mode: "live", confirmation_text: "Edward" }),
		);
		expect(res.status).toBe(401);
		expect(totalHits(h)).toBe(0);
	});

	test("routes registered after install() are guarded; a route registered before it is NOT (mount order matters)", async () => {
		const credential = newCredential();
		const auth = createWorkspaceAuth({
			operator_credential: credential,
			allowed_origin: ORIGIN,
		});
		const ws = new Hono();
		ws.get("/early", (c) => c.json({ leaked: true })); // wrong: before install
		auth.install(ws);
		ws.get("/late", (c) => c.json({ ok: true }));
		const app = new Hono().route(BASE, ws);
		expect((await app.request(`${BASE}/late`)).status).toBe(401);
		expect((await app.request(`${BASE}/early`)).status).toBe(200); // documented trap for the lead
	});
});

// ── exact Origin ────────────────────────────────────────────────────────────

describe("exact Origin", () => {
	const ALIASES = [
		"null",
		"",
		"http://localhost:5173",
		"http://[::1]:5173",
		"http://127.0.0.1:5174",
		"http://127.0.0.1",
		"https://127.0.0.1:5173",
		`${ORIGIN}/`,
		`${ORIGIN}/x`,
		"http://u@127.0.0.1:5173",
		"http://u:p@127.0.0.1:5173",
		"HTTP://127.0.0.1:5173",
		"http://LOCALHOST:5173",
		"http://127.0.0.1:05173",
		"http://127.0.0.1.:5173",
		"http://2130706433:5173",
		`${ORIGIN}, http://evil.test`,
		`http://evil.test, ${ORIGIN}`,
		`${ORIGIN}.evil.test`,
		`http://evil.test/${ORIGIN}`,
		"*",
	];

	test("mutations: absent or any non-exact Origin → 403 forbidden_origin, route not reached", async () => {
		const h = harness();
		const s = await signIn(h);
		expect(await errorOf(await postTasks(h, s, { origin: undefined }))).toBe(
			"forbidden_origin",
		);
		for (const origin of ALIASES) {
			const res = await postTasks(h, s, { origin });
			expect(res.status).toBe(403);
			expect(await errorOf(res)).toBe("forbidden_origin");
		}
		const dup = new Headers(mutationHeaders(s));
		dup.append("origin", "http://127.0.0.1:5174");
		expect(
			(
				await h.app.request(`${BASE}/tasks`, {
					method: "POST",
					headers: dup,
					body: "{}",
				})
			).status,
		).toBe(403);
		expect(totalHits(h)).toBe(0);
		expect((await postTasks(h, s)).status).toBe(200);
	});

	test("every mutation route enforces it (incl. challenge, decisions, cancel)", async () => {
		const h = harness();
		const s = await signIn(h);
		for (const [method, path] of [
			...MUTATIONS,
			["DELETE", "/session", null] as const,
		]) {
			for (const origin of [undefined, "http://127.0.0.1:5174", "null"]) {
				const res = await call(h, method, path, mutationHeaders(s, { origin }));
				expect(res.status).toBe(403);
			}
		}
		expect(totalHits(h)).toBe(0);
	});

	test("whitespace around the header value is not part of it (RFC 9110 OWS; Fetch strips it)", async () => {
		const h = harness();
		const s = await signIn(h);
		const headers = new Headers(mutationHeaders(s));
		headers.set("origin", `  ${ORIGIN}\t`);
		expect(headers.get("origin")).toBe(ORIGIN); // same origin, not a bypass
		expect(
			(
				await h.app.request(`${BASE}/tasks`, {
					method: "POST",
					headers,
					body: "{}",
				})
			).status,
		).toBe(200);
	});

	test("reads: no Origin allowed (R-A10), present non-exact Origin → 403, exact → 200", async () => {
		const h = harness();
		const s = await signIn(h);
		expect((await getSnapshot(h, { cookie: s.cookie })).status).toBe(200);
		expect(
			(await getSnapshot(h, { cookie: s.cookie, origin: ORIGIN })).status,
		).toBe(200);
		for (const origin of ALIASES)
			expect((await getSnapshot(h, { cookie: s.cookie, origin })).status).toBe(
				403,
			);
	});

	test("reads without Origin but flagged cross-origin by Sec-Fetch-Site → 403", async () => {
		const h = harness();
		const s = await signIn(h);
		for (const site of ["same-site", "cross-site", "bogus"])
			expect(
				(await getSnapshot(h, { cookie: s.cookie, "sec-fetch-site": site }))
					.status,
			).toBe(403);
		for (const site of ["same-origin", "none"])
			expect(
				(await getSnapshot(h, { cookie: s.cookie, "sec-fetch-site": site }))
					.status,
			).toBe(200);
	});

	test("extra allowed origins match exactly; same-site Sec-Fetch-Site with an exact Origin is fine", async () => {
		const extra = "http://127.0.0.1:4173";
		const h = harness({ extra_allowed_origins: [extra] });
		const s = await signIn(h);
		expect(
			(await postTasks(h, s, { origin: extra, "sec-fetch-site": "same-site" }))
				.status,
		).toBe(200);
		for (const origin of [
			`${extra}/`,
			"HTTP://127.0.0.1:4173",
			"http://localhost:4173",
		])
			expect((await postTasks(h, s, { origin })).status).toBe(403);
	});
});

// ── CSRF ────────────────────────────────────────────────────────────────────

describe("CSRF header", () => {
	test("absent / random / empty / other-session / read-only / altered → 403 csrf_invalid on every mutation", async () => {
		const h = harness();
		const s = await signIn(h);
		const other = await signIn(h);
		const viewer = await signIn(h, h.readOnlyCredential);
		const bad: (string | undefined)[] = [
			undefined,
			token43(),
			"",
			other.csrf,
			viewer.csrf,
			s.csrf.toUpperCase() === s.csrf
				? s.csrf.toLowerCase()
				: s.csrf.toUpperCase(),
			s.csrf.slice(1),
			`${s.csrf}=`,
		];
		for (const [method, path] of [
			...MUTATIONS,
			["DELETE", "/session", null] as const,
		])
			for (const csrf of bad) {
				const res = await call(
					h,
					method,
					path,
					mutationHeaders(s, { [CSRF_HEADER]: csrf }),
				);
				expect(res.status).toBe(403);
				expect(await errorOf(res)).toBe("csrf_invalid");
			}
		expect(totalHits(h)).toBe(0);
	});

	test("a CSRF value in the body, query or another header is ignored", async () => {
		const h = harness();
		const s = await signIn(h);
		const headers = mutationHeaders(s, {
			[CSRF_HEADER]: undefined,
			"x-csrf-token": s.csrf,
		});
		const res = await h.app.request(
			`${BASE}/tasks?${CSRF_HEADER}=${s.csrf}&csrf_token=${s.csrf}`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({ csrf_token: s.csrf, [CSRF_HEADER]: s.csrf }),
			},
		);
		expect(res.status).toBe(403);
		expect(totalHits(h)).toBe(0);
	});
});

// ── scope ───────────────────────────────────────────────────────────────────

describe("scope", () => {
	test("read-only principal: reads 200, every decide mutation 403 forbidden_scope", async () => {
		const h = harness();
		const r = await signIn(h, h.readOnlyCredential);
		for (const [method, path] of ROUTES.filter(([m]) => m === "GET")) {
			const res = await call(h, method, path, { cookie: r.cookie });
			expect(res.status).toBe(200);
		}
		const before = totalHits(h);
		for (const [method, path] of MUTATIONS) {
			const res = await call(h, method, path, mutationHeaders(r));
			expect(res.status).toBe(403);
			expect(await errorOf(res)).toBe("forbidden_scope");
		}
		expect(totalHits(h)).toBe(before);
	});

	test("forged identity/scope fields in a body never change the principal", async () => {
		const h = harness();
		const r = await signIn(h, h.readOnlyCredential);
		const forged = JSON.stringify({
			operator_id: OPERATOR_ID,
			scopes: ["workspace:read", "workspace:decide"],
			session_generation: 1,
			boot_id: "boot-99999999-9999-4999-8999-999999999999",
			origin_verified: true,
			csrf_verified: true,
		});
		expect((await postTasks(h, r, {}, forged)).status).toBe(403);
		const s = await signIn(h);
		const res = await postTasks(
			h,
			s,
			{},
			JSON.stringify({
				operator_id: "operator:mallory",
				scopes: ["workspace:read"],
			}),
		);
		expect(res.status).toBe(200);
		const out = (await res.json()) as {
			principal: { scopes: string[]; operator_id: string };
		};
		expect(out.principal.scopes).toEqual([
			"workspace:read",
			"workspace:decide",
		]);
		expect(out.principal.operator_id).toBe(OPERATOR_ID);
	});

	test("VerifiedAuthContext only on mutations, frozen, without session or credential material", async () => {
		const h = harness();
		const s = await signIn(h);
		await getSnapshot(h, { cookie: s.cookie });
		expect(h.seen.verified).toBeNull();
		expect(h.seen.principal).not.toBeNull();
		await postTasks(h, s);
		const v = h.seen.verified;
		expect(v?.origin_verified).toBe(true);
		expect(v?.csrf_verified).toBe(true);
		expect(Object.isFrozen(v)).toBe(true);
		expect(Object.isFrozen(v?.principal)).toBe(true);
		const text = JSON.stringify(v);
		for (const secret of [
			h.operatorCredential,
			s.csrf,
			s.cookie.split("=")[1] ?? "x",
		])
			expect(text).not.toContain(secret);
	});

	test("the typed name is not authentication (exact-name checking is role 04's)", async () => {
		const h = harness();
		const res = await call(
			h,
			"POST",
			`/approval-requests/${REQ}/decisions`,
			{ origin: ORIGIN, "content-type": "application/json" },
			JSON.stringify({ confirmation_text: "Edward" }),
		);
		expect(res.status).toBe(401);
	});
});

// ── order + content type + body limit ───────────────────────────────────────

describe("frozen order: body limit → session → Origin → CSRF → scope → content-type", () => {
	test("each failing layer is reported before the later ones", async () => {
		const h = harness();
		const s = await signIn(h);
		const r = await signIn(h, h.readOnlyCredential);
		const allBad = {
			origin: "http://evil.test",
			[CSRF_HEADER]: undefined,
			"content-type": "text/plain",
		};
		expect(
			await errorOf(await postTasks(h, s, { ...allBad, cookie: undefined })),
		).toBe("unauthenticated");
		expect(await errorOf(await postTasks(h, s, allBad))).toBe(
			"forbidden_origin",
		);
		expect(
			await errorOf(await postTasks(h, s, { ...allBad, origin: ORIGIN })),
		).toBe("csrf_invalid");
		expect(
			await errorOf(await postTasks(h, r, { "content-type": "text/plain" })),
		).toBe("forbidden_scope");
		expect(
			await errorOf(await postTasks(h, s, { "content-type": "text/plain" })),
		).toBe("unsupported_media_type");
		const big = "x".repeat(64 * 1024 + 1);
		const res = await call(h, "POST", "/tasks", {}, big);
		expect(res.status).toBe(413);
		expect(await errorOf(res)).toBe("payload_too_large");
		expect(totalHits(h)).toBe(0);
	});

	test("simple-request content types and JSON look-alikes → 415", async () => {
		const h = harness();
		const s = await signIn(h);
		for (const ct of [
			undefined,
			"text/plain",
			"application/x-www-form-urlencoded",
			"multipart/form-data; boundary=x",
			"application/json-seq",
			"application/jsonx",
			"application/merge-patch+json",
			"application/json; charset=latin1",
			"text/json",
		]) {
			const res = await postTasks(h, s, { "content-type": ct });
			expect(res.status).toBe(415);
		}
		for (const ct of [
			"application/json",
			"Application/JSON",
			"application/json; charset=utf-8",
			"application/json;charset=UTF-8",
		])
			expect((await postTasks(h, s, { "content-type": ct })).status).toBe(200);
		// a DELETE that carries bytes must be JSON too
		const del = await call(
			h,
			"DELETE",
			"/session",
			mutationHeaders(s, { "content-type": "text/plain" }),
			"x",
		);
		expect(del.status).toBe(415);
	});

	test("body limit is configurable and enforced on the real byte count", async () => {
		const h = harness({ max_body_bytes: 2048 });
		const s = await signIn(h);
		const ok = JSON.stringify({ pad: "x".repeat(1900) });
		expect((await postTasks(h, s, {}, ok)).status).toBe(200);
		const tooBig = JSON.stringify({ pad: "x".repeat(2100) });
		expect((await postTasks(h, s, {}, tooBig)).status).toBe(413);
		const stream = new ReadableStream<Uint8Array>({
			start(ctrl) {
				for (let i = 0; i < 5; i++)
					ctrl.enqueue(new TextEncoder().encode("x".repeat(1000)));
				ctrl.close();
			},
		});
		const res = await h.app.request(`${BASE}/tasks`, {
			method: "POST",
			headers: mutationHeaders(s),
			body: stream,
			duplex: "half",
		} as RequestInit);
		expect(res.status).toBe(413);
		expect((await postTasks(h, s, { "content-length": "12abc" })).status).toBe(
			400,
		);
	});
});

// ── disabled ────────────────────────────────────────────────────────────────

describe("disabled unless correctly configured (503, no default login)", () => {
	const cred = newCredential();
	const cases: [string, Parameters<typeof createWorkspaceAuth>[0]][] = [
		["no credential", { allowed_origin: ORIGIN }],
		["empty credential", { operator_credential: "", allowed_origin: ORIGIN }],
		[
			"31 chars",
			{ operator_credential: cred.slice(0, 31), allowed_origin: ORIGIN },
		],
		[
			"whitespace",
			{
				operator_credential: `${cred.slice(0, 20)} ${cred.slice(20)}`,
				allowed_origin: ORIGIN,
			},
		],
		["non-ASCII", { operator_credential: `${cred}é`, allowed_origin: ORIGIN }],
		["no origin", { operator_credential: cred }],
		[
			"trailing slash",
			{ operator_credential: cred, allowed_origin: `${ORIGIN}/` },
		],
		[
			"no scheme",
			{ operator_credential: cred, allowed_origin: "127.0.0.1:5173" },
		],
		[
			"ftp",
			{ operator_credential: cred, allowed_origin: "ftp://127.0.0.1:21" },
		],
		[
			"userinfo",
			{ operator_credential: cred, allowed_origin: "http://u@127.0.0.1:5173" },
		],
		["null", { operator_credential: cred, allowed_origin: "null" }],
		[
			"bad extra",
			{
				operator_credential: cred,
				allowed_origin: ORIGIN,
				extra_allowed_origins: ["*"],
			},
		],
		[
			"same read-only credential",
			{
				operator_credential: cred,
				read_only_credential: cred,
				allowed_origin: ORIGIN,
			},
		],
		[
			"bad base path",
			{
				operator_credential: cred,
				allowed_origin: ORIGIN,
				base_path: "/api/workspace/",
			},
		],
	];
	for (const [name, opts] of cases)
		test(name, async () => {
			const auth = createWorkspaceAuth(opts);
			expect(auth.enabled).toBe(false);
			expect(auth.disabled_reason ?? "").not.toContain(cred.slice(0, 16));
			const ws = new Hono();
			auth.install(ws);
			ws.get("/snapshot", (c) => c.json({ data: true }));
			const app = new Hono().route(BASE, ws);
			const signInRes = await app.request(`${BASE}/session`, {
				method: "POST",
				headers: { origin: ORIGIN, "content-type": "application/json" },
				body: JSON.stringify({ credential: cred }),
			});
			expect(signInRes.status).toBe(503);
			expect(signInRes.headers.get("set-cookie")).toBeNull();
			expect(await signInRes.json()).toEqual({
				error: "disabled",
				message: "workspace API is disabled",
			});
			expect((await app.request(`${BASE}/snapshot`)).status).toBe(503);
		});
});

// ── challenge routes over HTTP + leakage ────────────────────────────────────

describe("challenge issuance and use through the guard", () => {
	test("issue → decide → replay; each needs the full guard; viewer never reaches the port", async () => {
		const h = harness();
		const row = runRequestRow();
		h.tx.put(row);
		const s = await signIn(h);
		const v = await signIn(h, h.readOnlyCredential);
		const issuePath = `/approval-requests/${row.id}/challenge`;
		const decidePath = `/approval-requests/${row.id}/decisions`;
		const issueBody = JSON.stringify({
			kind: "run",
			binding_hash: row.binding_hash,
			expected_request_rev: row.rev,
		});
		expect(
			(await call(h, "POST", issuePath, mutationHeaders(v), issueBody)).status,
		).toBe(403);
		expect((await call(h, "GET", issuePath, { cookie: s.cookie })).status).toBe(
			404,
		); // no GET issuance
		expect(h.tx.writes).toBe(0);
		const issued = await call(
			h,
			"POST",
			issuePath,
			mutationHeaders(s),
			issueBody,
		);
		expect(issued.status).toBe(201);
		const { challenge, request_rev } = (await issued.json()) as {
			challenge: string;
			request_rev: number;
		};
		expect(request_rev).toBe(row.rev + 1);
		const decideBody = JSON.stringify({ challenge });
		for (const over of [
			{ cookie: undefined },
			{ origin: undefined },
			{ [CSRF_HEADER]: undefined },
		])
			expect(
				(
					await call(
						h,
						"POST",
						decidePath,
						mutationHeaders(s, over),
						decideBody,
					)
				).status,
			).toBeOneOf([401, 403]);
		expect(
			(await call(h, "POST", decidePath, mutationHeaders(v), decideBody))
				.status,
		).toBe(403);
		expect(h.tx.getApprovalRequest(row.id)?.challenge_status).toBe("issued");
		const ok = await call(
			h,
			"POST",
			decidePath,
			mutationHeaders(s),
			decideBody,
		);
		expect(ok.status).toBe(201);
		const replay = await call(
			h,
			"POST",
			decidePath,
			mutationHeaders(s),
			decideBody,
		);
		expect(replay.status).toBe(409);
		expect(await errorOf(replay)).toBe("challenge_invalid");
	});

	test("no console output at all; secrets appear only where they belong", async () => {
		const h = harness();
		const row = runRequestRow();
		h.tx.put(row);
		const bodies: string[] = [];
		const keep = async (res: Response) => {
			const headerText = [...res.headers.entries()]
				.filter(([k]) => k !== "set-cookie")
				.map(([k, v]) => `${k}: ${v}`)
				.join("\n");
			bodies.push(headerText, await res.clone().text());
			return res;
		};
		const { lines, result } = await captureConsole(async () => {
			await keep(
				await h.app.request(`${BASE}/session`, {
					method: "POST",
					headers: { origin: ORIGIN, "content-type": "application/json" },
					body: JSON.stringify({ credential: newCredential() }),
				}),
			);
			await keep(
				await h.app.request(`${BASE}/session`, {
					method: "POST",
					headers: {
						origin: "http://evil.test",
						"content-type": "application/json",
					},
					body: JSON.stringify({ credential: h.operatorCredential }),
				}),
			);
			const s = await signIn(h);
			await keep(await getSnapshot(h, { cookie: s.cookie }));
			await keep(await postTasks(h, s, { [CSRF_HEADER]: token43() }));
			const issued = await keep(
				await call(
					h,
					"POST",
					`/approval-requests/${row.id}/challenge`,
					mutationHeaders(s),
					"{}",
				),
			);
			const { challenge } = (await issued.json()) as { challenge: string };
			bodies.pop(); // the issuance response is the one place the challenge is returned
			await keep(
				await call(
					h,
					"POST",
					`/approval-requests/${row.id}/decisions`,
					mutationHeaders(s),
					JSON.stringify({ challenge: token43() }),
				),
			);
			await keep(
				await call(
					h,
					"POST",
					`/approval-requests/${row.id}/decisions`,
					mutationHeaders(s),
					JSON.stringify({ challenge }),
				),
			);
			await keep(
				await call(
					h,
					"DELETE",
					"/session",
					mutationHeaders(s, { "content-type": undefined }),
					"",
				),
			);
			await keep(await call(h, "GET", "/session", { cookie: s.cookie }));
			return { s, challenge };
		});
		expect(lines).toEqual([]);
		const all = bodies.join("\n");
		const cookieValue = result.s.cookie.split("=")[1] ?? "x";
		for (const secret of [
			h.operatorCredential,
			h.readOnlyCredential,
			cookieValue,
			result.challenge,
		])
			expect(all).not.toContain(secret);
		expect(JSON.stringify(h.tx.getApprovalRequest(row.id))).not.toContain(
			result.challenge,
		);
	});

	test("hardening headers on successes and errors", async () => {
		const h = harness();
		const s = await signIn(h);
		for (const res of [
			await getSnapshot(h, { cookie: s.cookie }),
			await getSnapshot(h, {}),
			await postTasks(h, s, { origin: undefined }),
		]) {
			expect(res.headers.get("cache-control")).toBe("no-store");
			expect(res.headers.get("x-content-type-options")).toBe("nosniff");
			expect(res.headers.get("cross-origin-resource-policy")).toBe(
				"same-origin",
			);
		}
	});
});
