// POST /ingest/usage and GET /api/usage (18 §5 U2). Fake secrets are assembled at runtime.
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
	USAGE_MAX_ROWS,
	type UsageRow,
	type UsageSummary,
	UsageSummary as UsageSummarySchema,
} from "@agent-city/schema";
import { openDb } from "./db.ts";
import { createApp } from "./index.ts";
import type { BroadcastKind } from "./routes/ws.ts";

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

	test("rows far outside the hub's day window are ignored; the Sydney day rolls at local midnight", async () => {
		const res = await post(
			ctx,
			report([
				row({ session_id: "claude:old", day: "2026-09-01" }),
				row({ session_id: "claude:future", day: "2026-11-20" }),
				row({ session_id: "claude:ok", day: "2026-11-14" }),
			]),
		);
		expect(await res.json()).toMatchObject({ accepted: 1, ignored: 2 });
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
