import { describe, expect, test } from "bun:test";
import { STALE_AFTER_MS } from "@agent-city/schema";
import { openDb } from "./db.ts";
import { sweepStale } from "./store.ts";

const NOW = new Date("2026-01-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function seed() {
	const db = openDb(":memory:");
	db.run("INSERT INTO machines (id) VALUES ('cockpit')");
	const add = db.query(
		`INSERT INTO sessions (id, provider, machine_id, status, started_at, last_event_at)
		 VALUES ($id, 'claude', 'cockpit', $status, $ts, $ts)`,
	);
	const rows: [string, string, string][] = [
		["active-old", "active", ago(STALE_AFTER_MS)],
		["idle-old", "idle", ago(STALE_AFTER_MS * 3)],
		["waiting-old", "waiting", ago(STALE_AFTER_MS * 10)],
		["ended-old", "ended", ago(STALE_AFTER_MS * 10)],
		["active-fresh", "active", ago(STALE_AFTER_MS - 1000)],
	];
	for (const [id, status, ts] of rows) add.run({ id, status, ts });
	return db;
}

const statuses = (db: ReturnType<typeof openDb>) =>
	Object.fromEntries(
		db
			.query<{ id: string; status: string }, []>(
				"SELECT id, status FROM sessions",
			)
			.all()
			.map((r) => [r.id, r.status]),
	);

describe("sweepStale", () => {
	test("active/idle ≥15 min → stale; waiting, ended, fresh untouched", () => {
		const db = seed();
		const changed = sweepStale(db, NOW);
		expect(changed.map((s) => s.id).sort()).toEqual(["active-old", "idle-old"]);
		expect(changed.every((s) => s.status === "stale")).toBe(true);
		expect(statuses(db)).toEqual({
			"active-old": "stale",
			"idle-old": "stale",
			"waiting-old": "waiting",
			"ended-old": "ended",
			"active-fresh": "active",
		});
	});

	test("second sweep is a no-op", () => {
		const db = seed();
		sweepStale(db, NOW);
		expect(sweepStale(db, NOW)).toEqual([]);
	});
});
