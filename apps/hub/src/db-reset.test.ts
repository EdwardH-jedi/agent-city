// db:reset only ever runs against temp paths here — never ./data/agentcity.db.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { backupStamp, resetDb } from "./db-reset.ts";

const NOW = new Date("2026-09-30T04:30:00.123Z");
const tmp = () => mkdtempSync(join(tmpdir(), "agentcity-dbreset-"));
const userVersion = (path: string) => {
	const db = new Database(path, { readonly: true });
	try {
		return db.query<{ user_version: number }, []>("PRAGMA user_version").get()
			?.user_version;
	} finally {
		db.close();
	}
};

describe("db:reset", () => {
	test("stamp is compact UTC", () => {
		expect(backupStamp(NOW)).toBe("20260930T043000Z");
	});

	test("moves the (stopped) db aside and creates an empty migrated db", () => {
		const dir = tmp();
		const path = join(dir, "agentcity.db");
		const db = openDb(path);
		db.run("INSERT INTO machines (id) VALUES ('cockpit')");
		db.run(
			"INSERT INTO sessions (id, provider, machine_id, status, started_at, last_event_at) VALUES ('s', 'claude', 'cockpit', 'active', 'x', 'x')",
		);
		db.close(); // the hub is stopped first

		const r = resetDb(path, NOW);
		const backup = `${path}.bak.20260930T043000Z`;
		expect(r.backup).toBe(backup);
		expect(r.moved).toContain(backup);
		const old = new Database(backup, { readonly: true });
		expect(
			old.query<{ n: number }, []>("SELECT count(*) AS n FROM sessions").get(),
		).toEqual({ n: 1 });
		old.close();

		const fresh = openDb(path);
		expect(
			fresh
				.query<{ n: number }, []>("SELECT count(*) AS n FROM sessions")
				.get(),
		).toEqual({ n: 0 });
		fresh.close();
		expect(userVersion(path)).toBeGreaterThanOrEqual(4);
	});

	test("-wal / -shm move with the same suffix (SQLite pairs them by name)", () => {
		const dir = tmp();
		const path = join(dir, "agentcity.db");
		openDb(path).close();
		writeFileSync(`${path}-wal`, "WAL-MARKER");
		writeFileSync(`${path}-shm`, "SHM-MARKER");
		const r = resetDb(path, NOW);
		const backup = `${path}.bak.20260930T043000Z`;
		expect(r.moved).toEqual([backup, `${backup}-wal`, `${backup}-shm`]);
		expect(readFileSync(`${backup}-wal`, "utf8")).toBe("WAL-MARKER");
		expect(readFileSync(`${backup}-shm`, "utf8")).toBe("SHM-MARKER");
		// the stale sidecars are gone from the new db's name
		expect(
			existsSync(`${path}-wal`) &&
				readFileSync(`${path}-wal`, "utf8") === "WAL-MARKER",
		).toBe(false);
	});

	test("never overwrites an earlier backup; no DB → just creates one", () => {
		const dir = tmp();
		const path = join(dir, "agentcity.db");
		expect(resetDb(path, NOW)).toEqual({ backup: null, moved: [] });
		expect(existsSync(path)).toBe(true);
		resetDb(path, NOW);
		resetDb(path, NOW);
		const backups = readdirSync(dir)
			.filter((f) => /\.bak\.[^-]+(-\d+)?$/.test(f))
			.sort();
		expect(backups).toEqual([
			"agentcity.db.bak.20260930T043000Z",
			"agentcity.db.bak.20260930T043000Z-2",
		]);
	});

	test(":memory: is refused", () => {
		expect(() => resetDb(":memory:")).toThrow(/file path/);
	});
});
