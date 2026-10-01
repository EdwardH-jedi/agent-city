import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { IngestBatch, MAX_INGEST_BATCH } from "@agent-city/schema";
import { openDb } from "./db.ts";
import { createApp, startHub } from "./index.ts";
import type { BroadcastKind } from "./routes/ws.ts";

const TOKEN = "test-ingest-token";
const t = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString();

let seq = 0;
const ev = (over: Record<string, unknown> = {}) => ({
	id: `e${++seq}`,
	ts: t(0),
	machine_id: "cockpit",
	session_id: "s1",
	provider: "claude",
	type: "PreToolUse",
	...over,
});

interface Ctx {
	db: Database;
	app: ReturnType<typeof createApp>;
	published: { kind: BroadcastKind; data: unknown }[];
}

/** `null` → ingest disabled (undefined would trigger the default). */
function setup(token: string | null = TOKEN): Ctx {
	const db = openDb(":memory:");
	const published: Ctx["published"] = [];
	const app = createApp({
		db,
		ingestToken: token ?? undefined,
		publish: (kind, data) => published.push({ kind, data }),
	});
	return { db, app, published };
}

function post(
	ctx: Ctx,
	body: unknown,
	auth: string | null = `Bearer ${TOKEN}`,
): Promise<Response> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (auth !== null) headers.authorization = auth;
	return Promise.resolve(
		ctx.app.request("/ingest", {
			method: "POST",
			headers,
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
	);
}

// Test events carry raw session ids (like a pre-F10 collector); the hub namespaces them.
const session = (db: Database, id = "claude:s1") =>
	db
		.query<Record<string, unknown>, [string]>(
			"SELECT * FROM sessions WHERE id = ?",
		)
		.get(id);
const count = (db: Database, table: string) =>
	db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n;

let ctx: Ctx;
beforeEach(() => {
	ctx = setup();
});

describe("basics", () => {
	test("GET /healthz → 200", async () => {
		const res = await ctx.app.request("/healthz");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, ingest: "enabled" });
	});

	test("migrations: 12 tables, user_version 7, agents.ended_at, sessions.rev", () => {
		const tables = ctx.db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all()
			.map((r) => r.name);
		expect(tables).toEqual([
			"agents",
			"events",
			"github_etags",
			"machines",
			"managed_artifacts",
			"managed_quarantine",
			"managed_reviews",
			"managed_runs",
			"managed_tasks",
			"repo_paths",
			"repos",
			"sessions",
		]);
		expect(
			ctx.db.query<{ user_version: number }, []>("PRAGMA user_version").get()
				?.user_version,
		).toBe(7);
		expect(
			ctx.db
				.query<{ name: string }, []>(
					"SELECT name FROM pragma_table_info('sessions')",
				)
				.all()
				.map((r) => r.name),
		).toContain("rev");
		const cols = ctx.db
			.query<{ name: string }, []>(
				"SELECT name FROM pragma_table_info('agents')",
			)
			.all()
			.map((r) => r.name);
		expect(cols).toContain("ended_at");
	});
});

describe("POST /ingest — auth", () => {
	test("INGEST_TOKEN unset → 503", async () => {
		const res = await post(setup(null), ev());
		expect(res.status).toBe(503);
	});

	test.each([
		["missing header", null],
		["wrong token", "Bearer not-the-token"],
		["wrong scheme", `Basic ${TOKEN}`],
		["empty bearer", "Bearer "],
	])("%s → 401, nothing stored", async (_name, auth) => {
		const res = await post(ctx, ev(), auth);
		expect(res.status).toBe(401);
		expect(count(ctx.db, "events")).toBe(0);
	});
});

describe("POST /ingest — validation", () => {
	test("invalid JSON → 400", async () => {
		expect((await post(ctx, "{nope")).status).toBe(400);
	});

	test("schema violation → 400 with path, body not echoed", async () => {
		const res = await post(ctx, {
			...ev(),
			session_id: undefined,
			summary: "MARKER-ECHO-CHECK",
		});
		expect(res.status).toBe(400);
		const text = await res.text();
		expect(text).toContain("session_id");
		expect(text).not.toContain("MARKER-ECHO-CHECK");
	});

	test.each([
		["empty batch", []],
		["bad provider", ev({ provider: "gpt" })],
		["bad ts", ev({ ts: "yesterday" })],
		["one bad item poisons the batch", [ev(), ev({ id: "" })]],
	])("%s → 400, nothing stored", async (_name, body) => {
		expect((await post(ctx, body)).status).toBe(400);
		expect(count(ctx.db, "events")).toBe(0);
	});
});

describe("POST /ingest — storage", () => {
	test("single event creates machine, session, main agent", async () => {
		const res = await post(ctx, ev({ repo_id: "o/r", cwd: "/x", model: "m1" }));
		expect(await res.json()).toEqual({ accepted: 1, duplicates: 0 });
		expect(session(ctx.db)).toMatchObject({
			status: "active",
			repo_id: "o/r",
			cwd: "/x",
			model: "m1",
			machine_id: "cockpit",
		});
		expect(ctx.db.query("SELECT id, role FROM machines").all()).toEqual([
			{ id: "cockpit", role: "cockpit" },
		]);
		expect(
			ctx.db.query("SELECT id, kind, parent_agent_id FROM agents").all(),
		).toEqual([{ id: "claude:s1", kind: "main", parent_agent_id: null }]);
	});

	test("unknown machine id → role null", async () => {
		await post(ctx, ev({ machine_id: "laptop-2" }));
		expect(ctx.db.query("SELECT role FROM machines").get()).toEqual({
			role: null,
		});
	});

	test("duplicate across requests is idempotent (no side effects, no broadcast)", async () => {
		const e = ev({ type: "Stop", ts: t(5) });
		await post(ctx, e);
		const before = session(ctx.db);
		const published = ctx.published.length;

		const res = await post(ctx, { ...e, type: "Notification" });
		expect(await res.json()).toEqual({ accepted: 0, duplicates: 1 });
		expect(count(ctx.db, "events")).toBe(1);
		expect(session(ctx.db)).toEqual(before);
		expect(ctx.published.length).toBe(published);
	});

	test("duplicate within one batch", async () => {
		const e = ev();
		const res = await post(ctx, [e, e, ev()]);
		expect(await res.json()).toEqual({ accepted: 2, duplicates: 1 });
		expect(count(ctx.db, "events")).toBe(2);
	});

	test("timestamps with offsets are stored as UTC Z", async () => {
		await post(ctx, ev({ ts: "2026-01-01T09:00:00+09:00" }));
		expect(ctx.db.query("SELECT ts FROM events").get()).toEqual({
			ts: "2026-01-01T00:00:00.000Z",
		});
	});

	test("hub re-redacts payload and summary (defense in depth)", async () => {
		const fake = `ghp_${"z".repeat(36)}`;
		await post(
			ctx,
			ev({
				summary: `GITHUB_TOKEN=${fake}`,
				payload_redacted: { note: `use ${fake}`, api_key: "plain" },
			}),
		);
		const row = ctx.db
			.query<{ summary: string; payload_redacted: string }, []>(
				"SELECT summary, payload_redacted FROM events",
			)
			.get();
		expect(row?.summary).not.toContain(fake);
		expect(row?.payload_redacted).not.toContain(fake);
		expect(JSON.parse(row?.payload_redacted ?? "{}").api_key).toBe(
			"[REDACTED]",
		);
	});

	test("F15: 500 events per batch accepted; 501 → 413, nothing stored", async () => {
		const batch = (n: number, tag: string) =>
			Array.from({ length: n }, (_, i) => ev({ id: `${tag}-${i}` }));
		const ok = await post(ctx, batch(MAX_INGEST_BATCH, "ok"));
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ accepted: 500, duplicates: 0 });

		const big = await post(ctx, batch(MAX_INGEST_BATCH + 1, "big"));
		expect(big.status).toBe(413);
		expect(await big.json()).toEqual({ error: "batch too large", max: 500 });
		expect(count(ctx.db, "events")).toBe(500);
		// the schema carries the same cap
		expect(IngestBatch.safeParse(batch(501, "zod")).success).toBe(false);
		expect(IngestBatch.safeParse(batch(500, "zod")).success).toBe(true);
	});

	test("broadcasts event + session after commit", async () => {
		await post(ctx, ev());
		expect(ctx.published.map((p) => p.kind)).toEqual(["event", "session"]);
	});
});

describe("state transitions end-to-end", () => {
	const statusAfter = async (over: Record<string, unknown>) => {
		const res = await post(ctx, ev(over));
		expect(res.status).toBe(200);
		return session(ctx.db)?.status;
	};

	test("full lifecycle incl. subagent, out-of-order, resume", async () => {
		expect(await statusAfter({ type: "SessionStart", ts: t(0) })).toBe(
			"active",
		);
		expect(await statusAfter({ type: "UserPromptSubmit", ts: t(1) })).toBe(
			"active",
		);
		expect(await statusAfter({ type: "Notification", ts: t(2) })).toBe(
			"waiting",
		);
		expect(await statusAfter({ type: "PreToolUse", ts: t(3) })).toBe("active");

		// subagent: created under main, SubagentStop ends only that agent
		await statusAfter({
			type: "PreToolUse",
			ts: t(4),
			agent_id: "sub:1",
			parent_agent_id: "s1",
			agent_label: "Explore",
		});
		expect(
			await statusAfter({
				type: "PostToolUse",
				tool: "Task",
				ts: t(5),
				agent_id: "sub:1",
			}),
		).toBe("active");
		const agents = ctx.db
			.query<
				{
					id: string;
					kind: string;
					parent_agent_id: string | null;
					ended_at: string | null;
				},
				[]
			>("SELECT id, kind, parent_agent_id, ended_at FROM agents ORDER BY id")
			.all();
		expect(agents).toEqual([
			{ id: "claude:s1", kind: "main", parent_agent_id: null, ended_at: null },
			{
				id: "claude:s1/sub:1",
				kind: "subagent",
				parent_agent_id: "claude:s1",
				ended_at: t(5),
			},
		]);

		expect(await statusAfter({ type: "Stop", ts: t(6) })).toBe("idle");

		// late (older) event must not regress status or last_event_at
		expect(await statusAfter({ type: "PreToolUse", ts: t(4) })).toBe("idle");
		expect(session(ctx.db)?.last_event_at).toBe(t(6));

		expect(await statusAfter({ type: "SessionEnd", ts: t(7) })).toBe("ended");
		expect(session(ctx.db)?.ended_at).toBe(t(7));
		expect(
			ctx.db
				.query<{ n: number }, []>(
					"SELECT count(*) AS n FROM agents WHERE ended_at IS NULL",
				)
				.get()?.n,
		).toBe(0);

		// resume after end
		expect(await statusAfter({ type: "SessionStart", ts: t(8) })).toBe(
			"active",
		);
		expect(session(ctx.db)?.ended_at).toBeNull();
		expect(session(ctx.db)?.started_at).toBe(t(0));
	});

	test("unknown parent_agent_id falls back to the main agent", async () => {
		await post(ctx, ev({ agent_id: "sub:9", parent_agent_id: "ghost" }));
		expect(
			ctx.db
				.query(
					"SELECT parent_agent_id FROM agents WHERE id = 'claude:s1/sub:9'",
				)
				.get(),
		).toEqual({ parent_agent_id: "claude:s1" });
	});
});

describe("read API", () => {
	beforeEach(async () => {
		await post(ctx, [
			ev({ session_id: "a", type: "PreToolUse", ts: t(1), repo_id: "o/one" }),
			ev({ session_id: "w", type: "Notification", ts: t(0), repo_id: "o/one" }),
			ev({
				session_id: "x",
				type: "SessionEnd",
				ts: t(3),
				repo_id: "o/two",
				provider: "codex",
			}),
		]);
		ctx.db.run(
			`INSERT INTO repos (id, district, is_private, pushed_at) VALUES
			 ('o/one', 'games', 1, '2026-01-02T00:00:00.000Z'),
			 ('o/two', 'games', 0, '2026-01-01T00:00:00.000Z'),
			 ('o/three', 'infra', 0, NULL)`,
		);
	});

	test("GET /api/sessions: waiting pinned first, then newest", async () => {
		const body = (await (await ctx.app.request("/api/sessions")).json()) as {
			sessions: { id: string }[];
		};
		expect(body.sessions.map((s) => s.id)).toEqual([
			"claude:w",
			"codex:x",
			"claude:a",
		]);
	});

	test("GET /api/sessions?status=waiting,active filters; unknown → 400", async () => {
		const body = (await (
			await ctx.app.request("/api/sessions?status=waiting,active")
		).json()) as { sessions: { id: string }[] };
		expect(body.sessions.map((s) => s.id)).toEqual(["claude:w", "claude:a"]);
		expect((await ctx.app.request("/api/sessions?status=busy")).status).toBe(
			400,
		);
	});

	test("GET /api/events: newest first, repo / provider / since / limit", async () => {
		const get = async (qs: string) =>
			(
				(await (await ctx.app.request(`/api/events${qs}`)).json()) as {
					events: { session_id: string; payload_redacted: unknown }[];
				}
			).events.map((e) => e.session_id);

		const [a, w, x] = ["claude:a", "claude:w", "codex:x"];
		expect(await get("")).toEqual([x, a, w]);
		expect(await get("?repo=o/one")).toEqual([a, w]);
		expect(await get("?provider=codex")).toEqual([x]);
		expect(await get(`?since=${encodeURIComponent(t(1))}`)).toEqual([x]);
		expect(await get("?limit=1")).toEqual([x]);
		for (const bad of [
			"?since=nope",
			"?limit=0",
			"?limit=abc",
			"?provider=gpt",
		]) {
			expect((await ctx.app.request(`/api/events${bad}`)).status).toBe(400);
		}
	});

	test("GET /api/repos: grouped by district, booleans, live session counts", async () => {
		const body = (await (await ctx.app.request("/api/repos")).json()) as {
			districts: Record<
				string,
				{ id: string; is_private: boolean; active_sessions: number }[]
			>;
		};
		expect(Object.keys(body.districts).sort()).toEqual(["games", "infra"]);
		expect(
			body.districts.games?.map((r) => [r.id, r.is_private, r.active_sessions]),
		).toEqual([
			["o/one", true, 2], // a (active) + w (waiting)
			["o/two", false, 0], // x ended
		]);
	});
});

describe("WebSocket /ws", () => {
	test("client receives {kind, data} for event and session", async () => {
		const hub = startHub({
			db: openDb(":memory:"),
			ingestToken: TOKEN,
			hostname: "127.0.0.1",
			port: 0,
		});
		try {
			const base = `127.0.0.1:${hub.server.port}`;
			const ws = new WebSocket(`ws://${base}/ws`);
			const got: { kind: string; data: { id: string } }[] = [];
			const twoMessages = new Promise<void>((resolve) => {
				ws.onmessage = (m) => {
					got.push(JSON.parse(String(m.data)));
					if (got.length === 2) resolve();
				};
			});
			await new Promise((r) => {
				ws.onopen = r;
			});

			const res = await fetch(`http://${base}/ingest`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${TOKEN}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(ev({ id: "ws-1", session_id: "ws-s" })),
			});
			expect(res.status).toBe(200);
			await twoMessages;
			ws.close();

			expect(got.map((g) => [g.kind, g.data.id])).toEqual([
				["event", "ws-1"],
				["session", "claude:ws-s"],
			]);
			expect((await fetch(`http://${base}/ws`)).status).toBe(426);
		} finally {
			hub.stop();
		}
	});
});

describe("security: Host / Origin / CORS", () => {
	const get = (path: string, headers: Record<string, string>) =>
		ctx.app.request(path, { headers });

	test.each([
		"evil.example",
		"evil.example:4317",
		"127.0.0.1.evil.example",
		"localhost.evil.example:4317",
		"[::2]:4317",
		"bad host",
		"",
	])("forged Host %p → 403 on /api/repos and /healthz", async (host) => {
		expect((await get("/api/repos", { host })).status).toBe(403);
		expect((await get("/healthz", { host })).status).toBe(403);
	});

	test.each([
		"127.0.0.1",
		"127.0.0.1:4317",
		"localhost",
		"localhost:5173", // Vite proxy forwards the dev server's Host
		"LOCALHOST:4317",
		"[::1]",
		"[::1]:4317",
	])("loopback Host %p → 200", async (host) => {
		expect((await get("/api/repos", { host })).status).toBe(200);
	});

	test("HUB_HOST is accepted with and without port", async () => {
		const db = openDb(":memory:");
		const app = createApp({
			db,
			ingestToken: TOKEN,
			publish: () => {},
			security: { hubHost: "hub.lan" },
		});
		for (const host of ["hub.lan", "hub.lan:4317", "127.0.0.1:4317"]) {
			expect(
				(await app.request("/healthz", { headers: { host } })).status,
			).toBe(200);
		}
		expect(
			(await app.request("/healthz", { headers: { host: "other.lan" } }))
				.status,
		).toBe(403);
	});

	test("CORS reflects allowlisted origins only; never *, never credentials", async () => {
		const ok = await get("/api/sessions", {
			host: "127.0.0.1:4317",
			origin: "http://127.0.0.1:5173",
		});
		expect(ok.headers.get("access-control-allow-origin")).toBe(
			"http://127.0.0.1:5173",
		);
		expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
		expect(ok.headers.get("vary")).toContain("Origin");

		for (const origin of [
			"https://evil.example",
			"null",
			"http://localhost.evil.example",
		]) {
			const res = await get("/api/sessions", {
				host: "127.0.0.1:4317",
				origin,
			});
			expect(res.headers.get("access-control-allow-origin")).toBeNull();
		}

		const pre = await ctx.app.request("/ingest", {
			method: "OPTIONS",
			headers: { host: "localhost:4317", origin: "http://localhost:5173" },
		});
		expect(pre.status).toBe(204);
		expect(pre.headers.get("access-control-allow-origin")).toBe(
			"http://localhost:5173",
		);
		expect(pre.headers.get("access-control-allow-credentials")).toBeNull();

		const evilPre = await ctx.app.request("/ingest", {
			method: "OPTIONS",
			headers: { host: "localhost:4317", origin: "https://evil.example" },
		});
		expect(evilPre.status).toBe(403);
		expect(evilPre.headers.get("access-control-allow-origin")).toBeNull();
	});
});

describe("security: /ws Origin", () => {
	/** Resolves "open" or "refused" (error/close before open). */
	const tryWs = (url: string, headers?: Record<string, string>) =>
		new Promise<"open" | "refused">((resolve) => {
			const ws = new WebSocket(url, headers ? { headers } : undefined);
			ws.onopen = () => {
				ws.close();
				resolve("open");
			};
			ws.onerror = () => resolve("refused");
			ws.onclose = () => resolve("refused");
		});

	test("evil Origin → 403, no socket; loopback Origin and no Origin → connected", async () => {
		const hub = startHub({
			db: openDb(":memory:"),
			ingestToken: TOKEN,
			hostname: "127.0.0.1",
			port: 0,
		});
		try {
			const base = `127.0.0.1:${hub.server.port}`;
			expect(
				await tryWs(`ws://${base}/ws`, { Origin: "https://evil.example" }),
			).toBe("refused");
			expect(
				await tryWs(`ws://${base}/ws`, { Origin: "http://127.0.0.1:5173" }),
			).toBe("open");
			expect(
				await tryWs(`ws://${base}/ws`, { Origin: "http://localhost:5173" }),
			).toBe("open");
			expect(await tryWs(`ws://${base}/ws`)).toBe("open");

			const denied = await fetch(`http://${base}/ws`, {
				headers: {
					origin: "https://evil.example",
					connection: "Upgrade",
					upgrade: "websocket",
					"sec-websocket-version": "13",
					"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
				},
			});
			expect(denied.status).toBe(403);
		} finally {
			hub.stop();
		}
	});
});

describe("audit F02 / F05 (hub side)", () => {
	test("F02: token in cwd / branch / model / tool never reaches the DB (hub re-sanitizes)", async () => {
		const gh = `ghp_${"Q".repeat(36)}`;
		await post(
			ctx,
			ev({
				type: "Stop",
				cwd: `/tmp/${gh}`,
				branch: gh,
				model: gh,
				tool: gh,
				summary: `x ${gh}`,
			}),
		);
		const dump = JSON.stringify([
			ctx.db.query("SELECT * FROM sessions").all(),
			ctx.db.query("SELECT * FROM events").all(),
		]);
		expect(dump).not.toContain(gh);
	});

	test("F02: an id carrying a secret is stored as a deterministic hash (retries still dedupe)", async () => {
		const gh = `ghp_${"R".repeat(36)}`;
		const e = ev({ id: `evt-${gh}`, session_id: `s-${gh}` });
		await post(ctx, e);
		const res = await post(ctx, e);
		expect(await res.json()).toEqual({ accepted: 0, duplicates: 1 });
		const dump = JSON.stringify(
			ctx.db.query("SELECT id, session_id FROM events").all(),
		);
		expect(dump).not.toContain(gh);
		expect(dump).toContain("redacted-");
	});

	test("F05: authenticated collectors report their drop counter → /healthz", async () => {
		await ctx.app.request("/ingest", {
			method: "POST",
			headers: {
				authorization: `Bearer ${TOKEN}`,
				"content-type": "application/json",
				"x-agentcity-machine": "forge",
				"x-agentcity-spool-dropped": "42",
			},
			body: JSON.stringify(ev()),
		});
		// unauthenticated / malformed headers are ignored
		await ctx.app.request("/ingest", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-agentcity-machine": "evil",
				"x-agentcity-spool-dropped": "999",
			},
			body: JSON.stringify(ev()),
		});
		await ctx.app.request("/ingest", {
			method: "POST",
			headers: {
				authorization: `Bearer ${TOKEN}`,
				"content-type": "application/json",
				"x-agentcity-machine": "bad machine!",
				"x-agentcity-spool-dropped": "-1",
			},
			body: JSON.stringify(ev()),
		});
		const health = (await (await ctx.app.request("/healthz")).json()) as {
			spool_dropped: Record<string, number>;
		};
		expect(health.spool_dropped).toEqual({ forge: 42 });
	});
});
