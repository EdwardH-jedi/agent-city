// ADV-AUTH, ADV-ORIGIN, ADV-CSRF, ADV-INPUT — direct HTTP attacks on the real hub (startHub,
// workspace mode). Every refused mutation is checked against a DB dump (NE: no durable effect).
// The "before" dump is a settled one (`settledDump`): ADV-AUTH-08 legitimately approves a Gate 1 on
// the shared hub, and the background engine/bridge keep advancing that execution afterwards; comparing
// against a dump taken mid-run flaked (engine progress, not an effect of the refused request). The
// after-dump is still the full, unfiltered dump.
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { randomBytes } from "node:crypto";
import {
	assertIsolation,
	BASE,
	type Client,
	count,
	cred,
	dump,
	FakeClock,
	http,
	issueChallenge,
	key,
	liveServers,
	mark,
	ORIGIN,
	openGate1,
	type RealHub,
	realHub,
	requestRow,
	settledDump,
	signIn,
	teardown,
	teardownSince,
	draft as wsDraft,
} from "./harness.ts";

assertIsolation();

let H: RealHub;
let op: Client;
let taskId: string;
let req: { id: string; kind: string; binding_hash: string; rev: number };

let shared = 0;
beforeAll(async () => {
	H = realHub({ auth: { max_sessions_per_principal: 16 } });
	shared = mark(); // hubs created by a single test are stopped after that test
	op = await H.signIn();
	const g = await openGate1(op, H.fx);
	taskId = g.taskId;
	req = g.req;
});
afterEach(() => teardownSince(shared));
afterAll(async () => {
	await teardown();
	expect(liveServers).toBe(0);
});

const fakeId = (p: string) =>
	`${p}-${crypto.randomUUID().replace(/^(.{14})./, "$14")}`;

/** Every mutation route with real ids (bodies are well-formed). */
const mutations = () =>
	[
		[
			"POST",
			"/tasks",
			{ idempotency_key: key(), repo_id: H.fx.repoId, draft: wsDraft() },
		],
		["PUT", `/tasks/${taskId}/draft`, { expected_rev: 1, draft: wsDraft() }],
		["POST", `/tasks/${taskId}/proposals`, { expected_rev: 1 }],
		[
			"POST",
			`/tasks/${taskId}/rerun`,
			{ expected_rev: 1, proposal_id: fakeId("wsp") },
		],
		["POST", `/tasks/${taskId}/cancel`, { expected_rev: 1 }],
		[
			"POST",
			`/approval-requests/${req.id}/challenge`,
			{ kind: "run", binding_hash: req.binding_hash, expected_request_rev: 1 },
		],
		[
			"POST",
			`/approval-requests/${req.id}/decisions`,
			{
				idempotency_key: key(),
				kind: "run",
				action: "approve",
				expected_request_rev: 1,
				binding_hash: req.binding_hash,
				confirmation_text: "Edward",
				reason: null,
				challenge: randomBytes(32).toString("base64url"),
			},
		],
	] as [string, string, unknown][];

describe("ADV-AUTH authentication and scope", () => {
	test("ADV-AUTH-01 every mutation without a session → 401, no durable effect", async () => {
		const before = await settledDump(H.db);
		for (const [m, p, b] of mutations()) {
			const r = await http(H.base, m, `${BASE}${p}`, b, {
				csrf: op.csrf,
				cookie: null,
			});
			expect([m, p, r.status, r.body?.error]).toEqual([
				m,
				p,
				401,
				"unauthenticated",
			]);
		}
		const del = await http(H.base, "DELETE", `${BASE}/session`, undefined, {
			cookie: null,
		});
		expect(del.status).toBe(401);
		expect(dump(H.db)).toBe(before);
	}, 30_000); // settledDump may wait for earlier approved work to finish

	test("ADV-AUTH-02 every read without a session → 401 with no task data", async () => {
		const art = fakeId("art");
		for (const p of [
			"/session",
			"/snapshot",
			`/tasks/${taskId}`,
			`/tasks/${taskId}/artifacts/${art}`,
		]) {
			const r = await http(H.base, "GET", `${BASE}${p}`, undefined, {
				cookie: null,
			});
			expect([p, r.status]).toEqual([p, 401]);
			expect(r.text).not.toContain(taskId);
			expect(r.text).not.toContain(req.id);
		}
	});

	test("ADV-AUTH-03 forged well-formed session cookie → 401 on read and mutation", async () => {
		const forged = `agentcity_ws_session=${randomBytes(32).toString("base64url")}`;
		const before = await settledDump(H.db);
		expect(
			(
				await http(H.base, "GET", `${BASE}/snapshot`, undefined, {
					cookie: forged,
				})
			).status,
		).toBe(401);
		const [m, p, b] = mutations()[0] as [string, string, unknown];
		expect(
			(
				await http(H.base, m, `${BASE}${p}`, b, {
					cookie: forged,
					csrf: op.csrf,
				})
			).status,
		).toBe(401);
		expect(dump(H.db)).toBe(before);
	}, 30_000); // settledDump may wait for earlier approved work to finish

	test("ADV-AUTH-04 a session from a previous boot is dead after restart", async () => {
		const A = realHub();
		const c = await A.signIn();
		expect((await c.get("/snapshot")).status).toBe(200);
		await A.stop();
		const B = realHub({
			reuse: A.fx,
			credentials: { operator: A.credential, readOnly: A.readOnlyCredential },
		});
		const old = await http(B.base, "GET", `${BASE}/snapshot`, undefined, {
			cookie: c.cookie,
		});
		expect(old.status).toBe(401);
		// the same per-run credential may sign in again (R-U4)
		expect((await (await B.signIn()).get("/snapshot")).status).toBe(200);
	});

	test("ADV-AUTH-05 expired (absolute / idle) and logged-out sessions → 401", async () => {
		const clock = new FakeClock();
		const C = realHub({
			clock,
			auth: { session_ttl_ms: 60_000, idle_timeout_ms: 30_000 },
		});
		const a = await C.signIn();
		clock.advance(30_001); // idle
		expect((await a.get("/snapshot")).status).toBe(401);
		const b = await C.signIn();
		for (let i = 0; i < 3; i++) {
			clock.advance(20_000); // keep alive by activity, but pass the absolute TTL
			await b.get("/snapshot");
		}
		expect((await b.get("/snapshot")).status).toBe(401);
		const d = await C.signIn();
		const out = await d.req("DELETE", "/session");
		expect(out.status).toBe(204);
		expect((await d.get("/snapshot")).status).toBe(401);
	});

	test("ADV-AUTH-06 bearer tokens (incl. the operator credential itself) are not operator authentication", async () => {
		for (const token of [cred(), H.credential]) {
			const r = await http(H.base, "GET", `${BASE}/snapshot`, undefined, {
				cookie: null,
				headers: { authorization: `Bearer ${token}` },
			});
			expect(r.status).toBe(401);
		}
	});

	test("ADV-AUTH-07 read-only principal reads but every mutation → 403 forbidden_scope, no effect", async () => {
		const v = await H.signIn("viewer");
		expect((await v.get("/snapshot")).status).toBe(200);
		expect((await v.get(`/tasks/${taskId}`)).status).toBe(200);
		const before = await settledDump(H.db);
		for (const [m, p, b] of mutations()) {
			const r = await v.req(m, p, b);
			expect([m, p, r.status, r.body?.error]).toEqual([
				m,
				p,
				403,
				"forbidden_scope",
			]);
		}
		expect(dump(H.db)).toBe(before);
	}, 30_000); // settledDump may wait for earlier approved work to finish

	test("ADV-AUTH-08 challenge minted for the operator, decision sent by the read-only session → 403; challenge stays usable", async () => {
		const g = await openGate1(op, H.fx);
		const ch = await issueChallenge(op, g.req);
		const v = await H.signIn("viewer");
		const body = {
			idempotency_key: key(),
			kind: "run",
			action: "approve",
			expected_request_rev: ch.request_rev,
			binding_hash: g.req.binding_hash,
			confirmation_text: "Edward",
			reason: null,
			challenge: ch.challenge,
		};
		const r = await v.post(`/approval-requests/${g.req.id}/decisions`, body);
		expect(r.status).toBe(403);
		expect(requestRow(H.db, g.req.id).challenge_status).toBe("issued");
		const ok = await op.post(`/approval-requests/${g.req.id}/decisions`, body);
		expect(ok.status).toBe(201);
	});

	test("ADV-AUTH-09 wrong credential → 401, no Set-Cookie, nothing echoed", async () => {
		const wrong = cred();
		const r = await http(H.base, "POST", `${BASE}/session`, {
			credential: wrong,
		});
		expect(r.status).toBe(401);
		expect(r.headers.get("set-cookie")).toBeNull();
		expect(r.text).not.toContain(wrong);
		// sign-in also needs the exact Origin
		const noOrigin = await http(
			H.base,
			"POST",
			`${BASE}/session`,
			{ credential: H.credential },
			{ origin: null },
		);
		expect(noOrigin.status).toBe(403);
		expect(noOrigin.headers.get("set-cookie")).toBeNull();
	});

	test("ADV-AUTH-10 cookie attributes; session value never in a JSON body", async () => {
		const r = await http(H.base, "POST", `${BASE}/session`, {
			credential: H.credential,
		});
		const sc = r.headers.get("set-cookie") ?? "";
		expect(sc).toContain("HttpOnly");
		expect(sc).toContain("SameSite=Strict");
		expect(sc).toContain("Path=/api/workspace");
		expect(sc.toLowerCase()).not.toContain("domain=");
		expect(sc).not.toContain("Secure"); // plain-http loopback origin (R-N7)
		const value = (sc.split(";")[0] ?? "").split("=")[1] ?? "";
		expect(value.length).toBeGreaterThan(20);
		expect(r.text).not.toContain(value);
		expect(r.text).not.toContain(H.credential);
		const view = await http(H.base, "GET", `${BASE}/session`, undefined, {
			cookie: sc.split(";")[0],
		});
		expect(view.status).toBe(200);
		expect(view.text).not.toContain(value);
		expect(view.headers.get("cache-control")).toContain("no-store");
	});

	test("ADV-AUTH-11 session fixation: a chosen cookie value is never adopted", async () => {
		const chosen = `agentcity_ws_session=${randomBytes(32).toString("base64url")}`;
		const r = await http(
			H.base,
			"POST",
			`${BASE}/session`,
			{ credential: H.credential },
			{ cookie: chosen },
		);
		expect(r.status).toBe(200);
		const issued = (r.headers.get("set-cookie") ?? "").split(";")[0];
		expect(issued).not.toBe(chosen);
		expect(
			(
				await http(H.base, "GET", `${BASE}/snapshot`, undefined, {
					cookie: chosen,
				})
			).status,
		).toBe(401);
	});

	test("ADV-AUTH-12 no existence oracle before authentication", async () => {
		const a = await http(H.base, "GET", `${BASE}/tasks/${taskId}`, undefined, {
			cookie: null,
		});
		const b = await http(
			H.base,
			"GET",
			`${BASE}/tasks/${fakeId("wst")}`,
			undefined,
			{ cookie: null },
		);
		expect([a.status, b.status]).toEqual([401, 401]);
		expect(a.text).toBe(b.text);
	});

	test("ADV-AUTH-13 session value in the query string is ignored", async () => {
		const value = op.cookie.split("=")[1];
		const r = await http(
			H.base,
			"GET",
			`${BASE}/snapshot?session=${value}&agentcity_ws_session=${value}`,
			undefined,
			{ cookie: null },
		);
		expect(r.status).toBe(401);
	});
});

describe("ADV-ORIGIN exact Origin (mutations: POST /tasks with a valid cookie + CSRF)", () => {
	const variants: [string, string | null][] = [
		["ADV-ORIGIN-01 absent", null],
		["ADV-ORIGIN-02 null", "null"],
		["ADV-ORIGIN-03 localhost alias", "http://localhost:5999"],
		["ADV-ORIGIN-03 [::1] alias", "http://[::1]:5999"],
		["ADV-ORIGIN-04 other loopback port", "http://127.0.0.1:6000"],
		["ADV-ORIGIN-05 https scheme", "https://127.0.0.1:5999"],
		["ADV-ORIGIN-06 trailing slash", `${ORIGIN}/`],
		["ADV-ORIGIN-06 path", `${ORIGIN}/x`],
		["ADV-ORIGIN-06 userinfo", "http://u@127.0.0.1:5999"],
		["ADV-ORIGIN-07 upper-case scheme", "HTTP://127.0.0.1:5999"],
		["ADV-ORIGIN-07 upper-case host", "http://LOCALHOST:5999"],
		["ADV-ORIGIN-08 comma list", `${ORIGIN}, http://evil.test`],
		["ADV-ORIGIN-04 foreign site", "http://evil.test"],
	];
	for (const [name, origin] of variants)
		test(`${name} → 403 forbidden_origin, no effect`, async () => {
			const before = count(H.db, "SELECT count(*) AS n FROM workspace_tasks");
			const r = await op.post(
				"/tasks",
				{ idempotency_key: key(), repo_id: H.fx.repoId, draft: wsDraft() },
				{ origin },
			);
			expect(r.status).toBe(403);
			expect(r.body?.error).toBe("forbidden_origin");
			expect(count(H.db, "SELECT count(*) AS n FROM workspace_tasks")).toBe(
				before,
			);
		});

	test("ADV-ORIGIN-04 cross-port page also cannot issue a challenge or decide", async () => {
		const evil = "http://127.0.0.1:6123";
		const before = await settledDump(H.db);
		const ch = await op.post(
			`/approval-requests/${req.id}/challenge`,
			{
				kind: "run",
				binding_hash: req.binding_hash,
				expected_request_rev: req.rev,
			},
			{ origin: evil },
		);
		expect(ch.status).toBe(403);
		expect(dump(H.db)).toBe(before);
	}, 30_000); // settledDump may wait for earlier approved work to finish

	test("ADV-ORIGIN-09 extra allowed origin is exact-match only", async () => {
		const extra = "http://127.0.0.1:6001";
		const X = realHub({ auth: { extra_allowed_origins: [extra] } });
		const c = await signIn(X.base, X.credential, extra);
		const mk = (origin: string) =>
			c.post(
				"/tasks",
				{ idempotency_key: key(), repo_id: X.fx.repoId, draft: wsDraft() },
				{ origin },
			);
		expect((await mk(extra)).status).toBe(201);
		expect((await mk(`${extra}/`)).status).toBe(403);
		expect((await mk("HTTP://127.0.0.1:6001")).status).toBe(403);
		expect((await mk("http://127.0.0.1:6002")).status).toBe(403);
	});

	test("ADV-ORIGIN-10 credentialed GET with a foreign Origin → 403; no credentialed CORS headers", async () => {
		const r = await op.get("/snapshot", { origin: "http://127.0.0.1:6123" });
		expect(r.status).toBe(403);
		expect(r.headers.get("access-control-allow-origin")).toBeNull();
		expect(r.headers.get("access-control-allow-credentials")).toBeNull();
		// GET without Origin is allowed (same-origin browser GET), unless Sec-Fetch-Site says cross (R-U1)
		expect((await op.get("/snapshot", { origin: null })).status).toBe(200);
		expect(
			(
				await op.get("/snapshot", {
					origin: null,
					headers: { "sec-fetch-site": "same-site" },
				})
			).status,
		).toBe(403);
		expect(
			(
				await op.get("/snapshot", {
					origin: null,
					headers: { "sec-fetch-site": "cross-site" },
				})
			).status,
		).toBe(403);
	});

	test("ADV-ORIGIN-11 OPTIONS preflight from a foreign origin gets no CORS grant", async () => {
		for (const path of [
			"/snapshot",
			`/approval-requests/${req.id}/decisions`,
		]) {
			const r = await http(H.base, "OPTIONS", `${BASE}${path}`, undefined, {
				origin: "http://127.0.0.1:6123",
				cookie: op.cookie,
				headers: {
					"access-control-request-method": "POST",
					"access-control-request-headers": "x-agentcity-csrf, content-type",
				},
			});
			expect(r.headers.get("access-control-allow-origin")).toBeNull();
			expect(r.headers.get("access-control-allow-headers") ?? "").not.toContain(
				"x-agentcity-csrf",
			);
			expect(r.headers.get("access-control-allow-credentials")).toBeNull();
			expect(r.status).toBeGreaterThanOrEqual(400);
		}
	});

	test("ADV-ORIGIN-12 foreign Host header (DNS rebinding) → 403 before the workspace guard", async () => {
		const r = await H.hub.server.fetch(
			new Request(`${H.base}${BASE}/snapshot`, {
				headers: { host: "rebind.evil.test", cookie: op.cookie },
			}),
		);
		expect(r.status).toBe(403);
		expect(await r.text()).not.toContain(taskId);
	});
});

describe("ADV-CSRF request forgery", () => {
	const create = (o: Parameters<Client["post"]>[2]) =>
		op.post(
			"/tasks",
			{ idempotency_key: key(), repo_id: H.fx.repoId, draft: wsDraft() },
			o,
		);

	test("ADV-CSRF-01/02 missing or random CSRF → 403 csrf_invalid, no effect", async () => {
		const before = await settledDump(H.db);
		for (const csrf of [null, randomBytes(32).toString("base64url"), ""]) {
			const r = await create({ csrf });
			expect(r.status).toBe(403);
			expect(r.body?.error).toBe("csrf_invalid");
		}
		expect(dump(H.db)).toBe(before);
	}, 30_000); // settledDump may wait for earlier approved work to finish

	test("ADV-CSRF-03 another session's CSRF token with this session's cookie → 403", async () => {
		const other = await H.signIn();
		const r = await create({ csrf: other.csrf });
		expect(r.status).toBe(403);
	});

	test("ADV-CSRF-04 CSRF from before logout is dead for the next session", async () => {
		const a = await H.signIn();
		await a.req("DELETE", "/session");
		const b = await H.signIn();
		const r = await b.post(
			"/tasks",
			{ idempotency_key: key(), repo_id: H.fx.repoId, draft: wsDraft() },
			{ csrf: a.csrf },
		);
		expect(r.status).toBe(403);
	});

	test("ADV-CSRF-05 CSRF token in the query or body instead of the header → 403", async () => {
		const q = await http(
			H.base,
			"POST",
			`${BASE}/tasks?x-agentcity-csrf=${op.csrf}&csrf=${op.csrf}`,
			{
				idempotency_key: key(),
				repo_id: H.fx.repoId,
				draft: wsDraft(),
				csrf_token: op.csrf,
			},
			{ cookie: op.cookie, csrf: null },
		);
		expect(q.status).toBe(403);
	});

	test("ADV-CSRF-06 simple-request content types → 415, no effect", async () => {
		const before = await settledDump(H.db);
		const body = JSON.stringify({
			idempotency_key: key(),
			repo_id: H.fx.repoId,
			draft: wsDraft(),
		});
		for (const ct of [
			"text/plain",
			"application/x-www-form-urlencoded",
			"multipart/form-data; boundary=x",
			"application/json-patch+json",
			"text/json",
		]) {
			const r = await op.post("/tasks", undefined, {
				raw: body,
				contentType: ct,
			});
			expect([ct, r.status]).toEqual([ct, 415]);
		}
		expect(dump(H.db)).toBe(before);
	}, 30_000); // settledDump may wait for earlier approved work to finish

	test("ADV-CSRF-07 challenge issuance via GET is not a route; nothing written", async () => {
		const before = requestRow(H.db, req.id);
		const r = await op.get(`/approval-requests/${req.id}/challenge`);
		expect(r.status).toBe(404);
		const after = requestRow(H.db, req.id);
		expect(after.challenge_status).toBe(before.challenge_status);
		expect(after.rev).toBe(before.rev);
	});
});

describe("ADV-INPUT body / method / path confusion", () => {
	test("ADV-INPUT-01 unknown fields on every mutation → 400, unknown key and value never echoed", async () => {
		const marker = `zz_unknown_${randomBytes(4).toString("hex")}`;
		const before = await settledDump(H.db);
		for (const [m, p, b] of mutations()) {
			const r = await op.req(m, p, {
				...(b as object),
				[marker]: `${marker}-value`,
			});
			expect([m, p, r.status]).toEqual([m, p, 400]);
			expect(r.text).not.toContain(marker);
		}
		expect(dump(H.db)).toBe(before);
	}, 30_000); // settledDump may wait for earlier approved work to finish

	test("ADV-INPUT-02 oversized / malformed / BOM / deeply nested bodies → 4xx, hub stays up", async () => {
		const big = await op.post("/tasks", undefined, {
			raw: JSON.stringify({ pad: "x".repeat(70 * 1024) }),
		});
		expect(big.status).toBe(413);
		const bad = await op.post("/tasks", undefined, { raw: "{not json" });
		expect(bad.status).toBe(400);
		const bom = await op.post("/tasks", undefined, {
			raw: `﻿${JSON.stringify({ idempotency_key: key(), repo_id: H.fx.repoId, draft: wsDraft() })}`,
		});
		// Fetch "UTF-8 decode" strips a leading BOM before JSON.parse: same as the plain body
		expect([201, 400]).toContain(bom.status);
		const deep = await op.post("/tasks", undefined, {
			raw: `${"[".repeat(10_000)}${"]".repeat(10_000)}`,
		});
		expect([400, 413]).toContain(deep.status);
		expect((await op.get("/snapshot")).status).toBe(200);
	});

	test("ADV-INPUT-03 __proto__ / constructor keys → 400, no prototype pollution", async () => {
		const r = await op.post("/tasks", undefined, {
			raw: `{"idempotency_key":"${key()}","repo_id":"${H.fx.repoId}","draft":${JSON.stringify(wsDraft())},"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}}}`,
		});
		expect(r.status).toBe(400);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(({} as Record<string, unknown>).polluted2).toBeUndefined();
	});

	test("ADV-INPUT-04 malformed ids → 404 (authenticated), never data", async () => {
		for (const id of [
			"..%2F..%2Fsnapshot",
			"wst-..%2Fx",
			`wst-${"0".repeat(300)}`,
			"task-00000000-0000-0000-0000-000000000000",
			taskId.toUpperCase(),
			`${taskId}%00`,
		]) {
			const r = await op.get(`/tasks/${id}`);
			expect([id, r.status]).toEqual([id, 404]);
		}
	});

	test("ADV-INPUT-05 HEAD / OPTIONS / PUT / PATCH / DELETE / method override", async () => {
		const head = await http(H.base, "HEAD", `${BASE}/snapshot`, undefined, {
			cookie: null,
		});
		expect(head.status).toBe(401);
		const before = await settledDump(H.db);
		for (const m of ["PUT", "PATCH", "DELETE"]) {
			const r = await op.req(m, "/snapshot", {});
			expect([m, r.status]).toEqual([m, 404]);
		}
		const del = await op.req("DELETE", `/tasks/${taskId}`, {});
		expect(del.status).toBe(404);
		const patch = await op.req("PATCH", `/tasks/${taskId}/draft`, {
			expected_rev: 1,
			draft: wsDraft(),
		});
		expect(patch.status).toBe(404);
		const override = await op.post(
			`/tasks/${taskId}/cancel`,
			{ expected_rev: 999 },
			{ headers: { "x-http-method-override": "DELETE" } },
		);
		expect(override.status).toBe(409); // handled as the POST it is (stale rev), not as DELETE
		expect(dump(H.db)).toBe(before);
	}, 30_000); // settledDump may wait for earlier approved work to finish

	test("ADV-INPUT-06 path confusion never reaches an unauthenticated handler", async () => {
		for (const p of [
			`${BASE}/snapshot/`,
			`/${BASE}/snapshot`,
			`${BASE.replace("workspace", "Workspace")}/snapshot`,
			`${BASE}/%2e%2e/managed/tasks`,
			`${BASE}/tasks/${taskId}/`,
			`${BASE}//snapshot`,
		]) {
			const r = await http(H.base, "GET", p, undefined, { cookie: null });
			expect([p, r.status === 200]).toEqual([p, false]);
			expect(r.text).not.toContain(taskId);
		}
	});

	test("ADV-INPUT-07 repo id variants: malformed → 400, unknown → 422, never a reservation", async () => {
		const mk = (repo_id: string) =>
			op.post("/tasks", {
				idempotency_key: key(),
				repo_id,
				draft: wsDraft(),
			});
		for (const bad of ["local/fixture/", "local/./fixture", "local/../fixture"])
			expect([bad, (await mk(bad)).status]).toEqual([bad, 400]);
		const managedBefore = count(
			H.db,
			"SELECT count(*) AS n FROM managed_tasks",
		);
		for (const unknown of ["LOCAL/fixture", "local/other", "someone/fixture"]) {
			const r = await mk(unknown);
			if (r.status === 201) {
				// allowlist enforced at publish
				const p = await op.post(`/tasks/${r.body.task.id}/proposals`, {
					expected_rev: r.body.task.rev,
				});
				expect([unknown, p.status, p.body?.error]).toEqual([
					unknown,
					422,
					"repo_not_allowed",
				]);
			} else
				expect([unknown, r.status, r.body?.error]).toEqual([
					unknown,
					422,
					"repo_not_allowed",
				]);
		}
		expect(count(H.db, "SELECT count(*) AS n FROM managed_tasks")).toBe(
			managedBefore,
		);
	});

	test("ADV-INPUT-08 unsafe scope paths are rejected at the draft", async () => {
		for (const allowed of [["../x"], ["/etc"], ["a//b"], [""], ["src/../.."]]) {
			const r = await op.post("/tasks", {
				idempotency_key: key(),
				repo_id: H.fx.repoId,
				draft: wsDraft({ scope: { allowed, protected: [] } }),
			});
			expect([allowed, r.status]).toEqual([allowed, 400]);
		}
	});
});
