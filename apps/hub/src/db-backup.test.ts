// db:backup only ever runs against temp paths here — never ./data/agentcity.db.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { backupDb, backupName, backupPattern, parseArgs } from "./db-backup.ts";
import { listSessions } from "./store.ts";

const NOW = new Date("2026-11-11T01:02:03.999Z");
const at = (iso: string) => new Date(iso);
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "acbk-")));

const count = (db: Database, table: string) =>
	db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n;
const pragma = (db: Database, name: string) =>
	Object.values(db.query(`PRAGMA ${name}`).get() as object)[0];

/** A data dir with a migrated hub DB holding a few rows; the returned connection plays the hub. */
function seeded() {
	const dataDir = tmp();
	const dbPath = join(dataDir, "agentcity.db");
	const hub = openDb(dbPath);
	hub.run("INSERT INTO machines (id) VALUES ('cockpit'), ('forge')");
	for (const id of ["s1", "s2", "s3"])
		hub.run(
			"INSERT INTO sessions (id, provider, machine_id, status, started_at, last_event_at) VALUES (?, 'claude', 'cockpit', 'active', '2026-11-11T00:00:00.000Z', '2026-11-11T00:00:00.000Z')",
			[id],
		);
	return { dataDir, dbPath, hub };
}

const backups = (dir: string) => readdirSync(dir).sort();

describe("db:backup", () => {
	test("injectable clock gives deterministic UTC names", () => {
		expect(backupName("/x/agentcity.db", NOW)).toBe(
			"agentcity-20261111-010203.db",
		);
		expect(backupName("hub.sqlite", at("2026-01-02T03:04:05Z"))).toBe(
			"hub-20260102-030405.db",
		);
		const re = backupPattern("agentcity.db");
		expect(re.test("agentcity-20261111-010203.db")).toBe(true);
		expect(re.test("agentcity-20261111-010203.db.tmp")).toBe(false);
		expect(re.test("xagentcity-20261111-010203.db")).toBe(false);
	});

	test("round-trips a DB with rows while the hub holds it open; restore copy opens in the store", () => {
		const { dataDir, dbPath, hub } = seeded();
		const r = backupDb({ dbPath, now: NOW });
		expect(r.file).toBe("backups/agentcity-20261111-010203.db");
		expect(r.pruned).toEqual([]);
		const bdir = join(dataDir, "backups");
		expect(statSync(bdir).mode & 0o777).toBe(0o700);
		expect(backups(bdir)).toEqual(["agentcity-20261111-010203.db"]); // no .tmp, no sidecars
		const file = join(dataDir, r.file);
		expect(statSync(file).mode & 0o777).toBe(0o600);

		const copy = new Database(file, { readonly: true });
		expect(count(copy, "sessions")).toBe(3);
		expect(count(copy, "machines")).toBe(2);
		expect(pragma(copy, "user_version")).toBe(pragma(hub, "user_version"));
		expect(pragma(copy, "integrity_check")).toBe("ok");
		copy.close();
		hub.close();

		// restore = copy the backup over a (stopped) DB path; the hub opens and reads it
		const restored = join(tmp(), "restored.db");
		copyFileSync(file, restored);
		const db = openDb(restored);
		expect(
			listSessions(db, [])
				.map((s) => s.id)
				.sort(),
		).toEqual(["s1", "s2", "s3"]);
		db.close();
	});

	test("open write transaction + pending WAL: succeeds, contains committed rows only", () => {
		const { dataDir, dbPath, hub } = seeded();
		hub.run("PRAGMA wal_autocheckpoint = 0"); // keep the next commit only in the WAL
		hub.run("INSERT INTO machines (id) VALUES ('spine')");
		expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
		hub.run("BEGIN IMMEDIATE");
		hub.run("INSERT INTO machines (id) VALUES ('uncommitted')");

		const r = backupDb({ dbPath, now: NOW });
		hub.run("ROLLBACK");
		hub.close();

		const copy = new Database(join(dataDir, r.file), { readonly: true });
		expect(
			copy
				.query<{ id: string }, []>("SELECT id FROM machines ORDER BY id")
				.all()
				.map((m) => m.id),
		).toEqual(["cockpit", "forge", "spine"]);
		copy.close();
	});

	test("works when the hub is stopped and no -wal / -shm exist", () => {
		const { dataDir, dbPath, hub } = seeded();
		hub.close();
		for (const s of ["-wal", "-shm"])
			if (existsSync(dbPath + s)) unlinkSync(dbPath + s);
		const r = backupDb({ dbPath, now: NOW });
		const copy = new Database(join(dataDir, r.file), { readonly: true });
		expect(count(copy, "sessions")).toBe(3);
		copy.close();
	});

	test("refuses a destination outside the data dir; nothing written", () => {
		const { dataDir, dbPath, hub } = seeded();
		hub.close();
		const outside = tmp();
		symlinkSync(outside, join(dataDir, "backups"));
		expect(() => backupDb({ dbPath, now: NOW })).toThrow(
			/outside the data dir/,
		);
		expect(readdirSync(outside)).toEqual([]);

		for (const dir of ["../x", outside, "a/b", "..", "."])
			expect(() => backupDb({ dbPath, dir, now: NOW })).toThrow(/--dir/);
		expect(() => parseArgs(["--dir", "../x"])).toThrow(/--dir/);
		expect(() => parseArgs(["--dir", "/abs/path"])).toThrow(/--dir/);
		expect(existsSync(join(dataDir, "..", "x"))).toBe(false);

		// a dangling backups link is refused too
		const d2 = seeded();
		d2.hub.close();
		symlinkSync(join(outside, "gone"), join(d2.dataDir, "backups"));
		expect(() => backupDb({ dbPath: d2.dbPath, now: NOW })).toThrow(/refusing/);
		expect(existsSync(join(outside, "gone"))).toBe(false);
	});

	test("refuses to overwrite an existing backup", () => {
		const { dataDir, dbPath, hub } = seeded();
		hub.close();
		const bdir = join(dataDir, "backups");
		mkdirSync(bdir);
		const dest = join(bdir, "agentcity-20261111-010203.db");
		writeFileSync(dest, "EARLIER");
		expect(() => backupDb({ dbPath, now: NOW })).toThrow(/already exists/);
		expect(readFileSync(dest, "utf8")).toBe("EARLIER");
		expect(backups(bdir)).toEqual(["agentcity-20261111-010203.db"]);
	});

	test("--keep 2 prunes the oldest; decoys and leftover .tmp untouched and uncounted", () => {
		const { dataDir, dbPath, hub } = seeded();
		const bdir = join(dataDir, "backups");
		for (const t of [
			"2026-11-08T00:00:00Z",
			"2026-11-09T00:00:00Z",
			"2026-11-10T00:00:00Z",
		])
			backupDb({ dbPath, now: at(t) });
		writeFileSync(join(bdir, "notes.txt"), "keep me");
		writeFileSync(join(bdir, "other-20200101-000000.db"), "x");
		writeFileSync(join(bdir, "agentcity-manual.db"), "x");
		writeFileSync(join(bdir, "agentcity-20200101-000000.db.tmp"), "half");

		const r = backupDb({ dbPath, keep: 2, now: at("2026-11-11T00:00:00Z") });
		hub.close();
		expect(r.pruned).toEqual([
			"agentcity-20261108-000000.db",
			"agentcity-20261109-000000.db",
		]);
		expect(r.pruneErrors).toEqual([]);
		expect(backups(bdir)).toEqual([
			"agentcity-20200101-000000.db.tmp",
			"agentcity-20261110-000000.db",
			"agentcity-20261111-000000.db",
			"agentcity-manual.db",
			"notes.txt",
			"other-20200101-000000.db",
		]);
	});

	test("--keep never deletes the file just written, even when the clock makes it the oldest", () => {
		const { dataDir, dbPath, hub } = seeded();
		backupDb({ dbPath, now: at("2026-11-10T00:00:00Z") });
		const r = backupDb({ dbPath, keep: 1, now: at("2026-11-01T00:00:00Z") });
		hub.close();
		expect(r.pruned).toEqual(["agentcity-20261110-000000.db"]);
		expect(backups(join(dataDir, "backups"))).toEqual([
			"agentcity-20261101-000000.db",
		]);
	});

	test("--keep and args are validated", () => {
		expect(parseArgs(["--keep", "2", "--dir", "snap", "--db", "x.db"])).toEqual(
			{ keep: 2, dir: "snap", db: "x.db" },
		);
		for (const k of ["0", "366", "-1", "1.5", "abc", ""])
			expect(() => parseArgs(["--keep", k])).toThrow(/--keep/);
		expect(() => parseArgs(["--keep"])).toThrow(/needs a value/);
		expect(() => parseArgs(["--force"])).toThrow(/usage/);
	});

	test("missing source DB: clear error, no file or directory created", () => {
		const dataDir = tmp();
		const dbPath = join(dataDir, "agentcity.db");
		expect(() => backupDb({ dbPath, now: NOW })).toThrow(/no database file/);
		expect(readdirSync(dataDir)).toEqual([]);
		expect(() => backupDb({ dbPath: ":memory:" })).toThrow(/file path/);
	});

	test("CLI: exits non-zero on refusal and never prints absolute paths", () => {
		const { dataDir, dbPath, hub } = seeded();
		hub.close();
		const script = join(import.meta.dir, "db-backup.ts");
		const run = (...args: string[]) => {
			const p = Bun.spawnSync(["bun", script, "--db", dbPath, ...args], {
				cwd: dataDir, // no repo .env here
				env: { PATH: process.env.PATH ?? "" },
			});
			return {
				code: p.exitCode,
				out: p.stdout.toString() + p.stderr.toString(),
			};
		};
		const ok = run("--keep", "3");
		expect(ok.code).toBe(0);
		expect(ok.out).toMatch(
			/^\[db:backup\] wrote backups\/agentcity-\d{8}-\d{6}\.db \(\d+ bytes\); kept 3, pruned 0\n$/,
		);
		const bad = run("--dir", "../x");
		expect(bad.code).not.toBe(0);
		const missing = Bun.spawnSync(
			["bun", script, "--db", join(dataDir, "nope.db")],
			{ cwd: dataDir, env: { PATH: process.env.PATH ?? "" } },
		);
		expect(missing.exitCode).not.toBe(0);
		for (const out of [
			ok.out,
			bad.out,
			missing.stderr.toString() + missing.stdout.toString(),
		])
			expect(out).not.toContain(dataDir);
		expect(existsSync(join(dataDir, "nope.db"))).toBe(false);
	});
});
