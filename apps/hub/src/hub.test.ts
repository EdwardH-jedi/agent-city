import { describe, expect, test } from "bun:test";
import { openDb } from "./db.ts";
import { app } from "./index.ts";

describe("hub", () => {
	test("GET /healthz → 200", async () => {
		const res = await app.request("/healthz");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true });
	});

	test("stub routes → 501", async () => {
		expect((await app.request("/api/repos")).status).toBe(501);
		expect(
			(await app.request("/ingest/events", { method: "POST" })).status,
		).toBe(501);
	});

	test("migrations create the 6 base tables", () => {
		const db = openDb(":memory:");
		const tables = db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all()
			.map((r) => r.name);
		expect(tables).toEqual([
			"agents",
			"events",
			"machines",
			"repo_paths",
			"repos",
			"sessions",
		]);
	});

	test("migrations reach 003: agents.ended_at exists", () => {
		const db = openDb(":memory:");
		expect(
			db.query<{ user_version: number }, []>("PRAGMA user_version").get()
				?.user_version,
		).toBe(3);
		const cols = db
			.query<{ name: string }, []>(
				"SELECT name FROM pragma_table_info('agents')",
			)
			.all()
			.map((r) => r.name);
		expect(cols).toContain("ended_at");
	});
});
