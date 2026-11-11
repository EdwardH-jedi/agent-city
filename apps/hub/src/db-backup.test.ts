// db:backup only ever runs against temp paths here — never ./data/agentcity.db.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import {
	backupDb,
	backupName,
	backupPattern,
	parseArgs,
	verifyCopy,
} from "./db-backup.ts";
import { listSessions } from "./store.ts";

const NOW = new Date("2026-11-11T01:02:03.999Z");
const at = (iso: string) => new Date(iso);
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "acbk-")));

// Windows has no POSIX permission bits (access is NTFS ACLs inherited from the data dir), so the
// 0700/0600 assertions only make sense elsewhere; everything else in those tests still runs there.
const WIN = process.platform === "win32";
// File symlinks need a privilege on Windows (Developer Mode / admin); directory junctions do not.
const CAN_FILE_SYMLINK = (() => {
	const d = mkdtempSync(join(tmpdir(), "acbk-probe-"));
	try {
		writeFileSync(join(d, "t"), "");
		symlinkSync(join(d, "t"), join(d, "l"));
		return true;
	} catch {
		return false;
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
})();

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
const sha = (p: string) =>
	createHash("sha256").update(readFileSync(p)).digest("hex");
const mode = (p: string) => statSync(p).mode & 0o777;
const SCRIPT = join(import.meta.dir, "db-backup.ts");
/** Run the CLI in `cwd` (no repo .env there); stdout + stderr together. */
function cli(cwd: string, ...args: string[]) {
	const p = Bun.spawnSync(["bun", SCRIPT, ...args], {
		cwd,
		env: { PATH: process.env.PATH ?? "" },
	});
	return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

describe("db:backup", () => {
	test("injectable clock gives deterministic UTC names", () => {
		expect(backupName("/x/agentcity.db", NOW)).toBe(
			"agentcity.db-20261111-010203.db",
		);
		expect(backupName("hub.sqlite", at("2026-01-02T03:04:05Z"))).toBe(
			"hub.sqlite-20260102-030405.db",
		);
		const re = backupPattern("agentcity.db");
		expect(re.test("agentcity.db-20261111-010203.db")).toBe(true);
		expect(re.test("agentcity.db-20261111-010203.db.tmp")).toBe(false);
		expect(re.test("xagentcity.db-20261111-010203.db")).toBe(false);
		expect(re.test("agentcityXdb-20261111-010203.db")).toBe(false);
		expect(re.test("agentcity-20261111-010203.db")).toBe(false); // old naming: never pruned
		expect(
			backupPattern("agentcity.sqlite").test("agentcity.db-20261111-010203.db"),
		).toBe(false);
	});

	test("round-trips a DB with rows while the hub holds it open; restore copy opens in the store", () => {
		const { dataDir, dbPath, hub } = seeded();
		const r = backupDb({ dbPath, now: NOW });
		expect(r.file).toBe("backups/agentcity.db-20261111-010203.db");
		expect(r.pruned).toEqual([]);
		const bdir = join(dataDir, "backups");
		if (!WIN) expect(statSync(bdir).mode & 0o777).toBe(0o700);
		expect(backups(bdir)).toEqual(["agentcity.db-20261111-010203.db"]); // no staging dir, no sidecars
		const file = join(dataDir, r.file);
		if (!WIN) expect(statSync(file).mode & 0o777).toBe(0o600);

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
		// "junction" is ignored on POSIX; on Windows it is the link kind that needs no privilege
		symlinkSync(outside, join(dataDir, "backups"), "junction");
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
		symlinkSync(join(outside, "gone"), join(d2.dataDir, "backups"), "junction");
		expect(() => backupDb({ dbPath: d2.dbPath, now: NOW })).toThrow(/refusing/);
		expect(existsSync(join(outside, "gone"))).toBe(false);
	});

	test("refuses to overwrite an existing backup", () => {
		const { dataDir, dbPath, hub } = seeded();
		hub.close();
		const bdir = join(dataDir, "backups");
		mkdirSync(bdir);
		const dest = join(bdir, "agentcity.db-20261111-010203.db");
		writeFileSync(dest, "EARLIER");
		expect(() => backupDb({ dbPath, now: NOW })).toThrow(/already exists/);
		expect(readFileSync(dest, "utf8")).toBe("EARLIER");
		expect(backups(bdir)).toEqual(["agentcity.db-20261111-010203.db"]);
	});

	test("--keep 2 prunes the oldest; decoys, old-style names and leftover .tmp untouched and uncounted", () => {
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
		writeFileSync(join(bdir, "agentcity.db-manual.db"), "x");
		writeFileSync(join(bdir, "agentcity.db-20200101-000000.db.tmp"), "half");
		writeFileSync(join(bdir, "agentcity-20200101-000000.db"), "old naming");

		const r = backupDb({ dbPath, keep: 2, now: at("2026-11-11T00:00:00Z") });
		hub.close();
		expect(r.pruned).toEqual([
			"agentcity.db-20261108-000000.db",
			"agentcity.db-20261109-000000.db",
		]);
		expect(r.pruneErrors).toEqual([]);
		expect(backups(bdir)).toEqual([
			"agentcity-20200101-000000.db",
			"agentcity.db-20200101-000000.db.tmp",
			"agentcity.db-20261110-000000.db",
			"agentcity.db-20261111-000000.db",
			"agentcity.db-manual.db",
			"notes.txt",
			"other-20200101-000000.db",
		]);
	});

	test("--keep never deletes the file just written, even when the clock makes it the oldest", () => {
		const { dataDir, dbPath, hub } = seeded();
		backupDb({ dbPath, now: at("2026-11-10T00:00:00Z") });
		const r = backupDb({ dbPath, keep: 1, now: at("2026-11-01T00:00:00Z") });
		hub.close();
		expect(r.pruned).toEqual(["agentcity.db-20261110-000000.db"]);
		expect(backups(join(dataDir, "backups"))).toEqual([
			"agentcity.db-20261101-000000.db",
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
			/^\[db:backup\] wrote backups\/agentcity\.db-\d{8}-\d{6}\.db \(\d+ bytes\); kept 3, pruned 0\n$/,
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

	test("never deletes a pre-existing .tmp; stages privately, tightens an existing backups/ to 0700", () => {
		const { dataDir, dbPath, hub } = seeded();
		const bdir = join(dataDir, "backups");
		mkdirSync(bdir);
		chmodSync(bdir, 0o755);
		const theirs = join(bdir, "agentcity.db-20261111-010203.db.tmp");
		writeFileSync(theirs, "not ours");
		const seen: number[] = [];
		const r = backupDb({
			dbPath,
			now: NOW,
			verify: (p, v) => {
				seen.push(mode(p), mode(join(p, "..")));
				verifyCopy(p, v);
			},
		});
		hub.close();
		expect(seen).toHaveLength(2); // the verify hook ran on the staged copy and its dir
		if (!WIN) expect(seen).toEqual([0o600, 0o700]); // staged copy and its dir, mid-run
		if (!WIN) expect(mode(bdir)).toBe(0o700);
		expect(readFileSync(theirs, "utf8")).toBe("not ours");
		expect(backups(bdir)).toEqual([
			"agentcity.db-20261111-010203.db",
			"agentcity.db-20261111-010203.db.tmp",
		]); // staging dir removed
		if (!WIN) expect(mode(join(dataDir, r.file))).toBe(0o600);
	});

	test("--keep never touches backups of a differently named source", () => {
		const { dataDir, dbPath, hub } = seeded();
		for (const t of ["2026-11-08T00:00:00Z", "2026-11-09T00:00:00Z"])
			backupDb({ dbPath, now: at(t) });
		hub.close();
		const other = openDb(join(dataDir, "agentcity.sqlite"));
		const r = backupDb({
			dbPath: join(dataDir, "agentcity.sqlite"),
			keep: 1,
			now: NOW,
		});
		other.close();
		expect(r.pruned).toEqual([]);
		expect(backups(join(dataDir, "backups"))).toEqual([
			"agentcity.db-20261108-000000.db",
			"agentcity.db-20261109-000000.db",
			"agentcity.sqlite-20261111-010203.db",
		]);
	});

	// DB_PATH is a link to a file inside backups/ whose name matches the --keep pattern: it is the
	// live DB and must survive pruning. Hard links work everywhere; file symlinks need a privilege on
	// Windows (CAN_FILE_SYMLINK probes for it), so that variant is skipped only where it cannot be made.
	for (const kind of ["symlink", "hard link"] as const)
		test.skipIf(kind === "symlink" && !CAN_FILE_SYMLINK)(
			`--keep never deletes the live DB when DB_PATH is a ${kind} to a matching file in backups/`,
			() => {
				const dataDir = tmp();
				const bdir = join(dataDir, "backups");
				mkdirSync(bdir, { mode: 0o700 });
				const live = join(bdir, "agentcity.db-20261101-000000.db");
				const db = openDb(live);
				db.run("INSERT INTO machines (id) VALUES ('cockpit')");
				const dbPath = join(dataDir, "agentcity.db");
				if (kind === "symlink") symlinkSync(live, dbPath);
				else linkSync(live, dbPath);
				const r = backupDb({ dbPath, keep: 1, now: NOW });
				db.close();
				expect(r.pruned).toEqual([]);
				expect(existsSync(live)).toBe(true);
				const check = new Database(live, { readonly: true });
				expect(count(check, "machines")).toBe(1);
				check.close();
			},
		);

	test("refuses a DB name with surrounding whitespace or control characters; nothing written", () => {
		const { dataDir, dbPath, hub } = seeded();
		hub.close();
		// Bun would open agentcity.db. (Windows strips trailing spaces from names, so the copy is meaningless there.)
		if (!WIN) copyFileSync(dbPath, join(dataDir, "agentcity.db "));
		for (const name of [
			"agentcity.db ",
			" agentcity.db",
			"agentcity.db\t",
			"agentcity.db\n",
			`agent${String.fromCharCode(1)}city.db`,
		])
			expect(() => backupDb({ dbPath: join(dataDir, name), now: NOW })).toThrow(
				/whitespace or a control character/,
			);
		const bad = cli(dataDir, "--db", join(dataDir, "agentcity.db "));
		expect(bad.code).not.toBe(0);
		expect(existsSync(join(dataDir, "backups"))).toBe(false);
	});

	// POSIX only: Windows cannot have a file whose name ends in a space, so there is nothing for a
	// clean-named link to point at (and file symlinks need a privilege there anyway).
	test.skipIf(WIN)(
		"refuses a clean-named symlink whose target has a whitespace name; nothing written",
		() => {
			const { dataDir, dbPath, hub } = seeded();
			hub.close();
			copyFileSync(dbPath, join(dataDir, "agentcity.db "));
			symlinkSync(join(dataDir, "agentcity.db "), join(dataDir, "clean.db"));
			expect(() =>
				backupDb({ dbPath: join(dataDir, "clean.db"), now: NOW }),
			).toThrow(/whitespace or a control character/);
			expect(existsSync(join(dataDir, "backups"))).toBe(false);
		},
	);

	test("a token-shaped DB name never appears in output or error messages", () => {
		const dataDir = tmp();
		const tok = `ghp_${"Z".repeat(36)}`; // built at runtime
		const dbPath = join(dataDir, `${tok}.db`);
		openDb(dbPath).close();
		const ok = cli(dataDir, "--db", dbPath, "--keep", "2");
		expect(ok.code).toBe(0);
		expect(ok.out).toMatch(/^\[db:backup\] wrote backups\/\[REDACTED\]/);
		const missing = cli(dataDir, "--db", join(dataDir, `${tok}-gone.db`));
		expect(missing.code).not.toBe(0);
		expect(missing.out).toContain("<db>");
		backupDb({ dbPath, now: NOW });
		let msg = "";
		try {
			backupDb({ dbPath, now: NOW });
		} catch (err) {
			msg = (err as Error).message;
		}
		expect(msg).toMatch(/already exists/);
		for (const out of [ok.out, missing.out, msg]) {
			expect(out).not.toContain(tok);
			expect(out).not.toContain(dataDir);
		}
	});

	test("stopped hub, WAL DB with -wal but no -shm: source and sidecars stay byte-identical", () => {
		const { dbPath, hub } = seeded();
		hub.run("PRAGMA wal_autocheckpoint = 0");
		hub.run("INSERT INTO machines (id) VALUES ('spine')"); // only in the WAL
		const dataDir = tmp(); // a stopped-hub copy: .db + -wal, no -shm
		const src = join(dataDir, "agentcity.db");
		copyFileSync(dbPath, src);
		copyFileSync(`${dbPath}-wal`, `${src}-wal`);
		hub.close();
		expect(statSync(`${src}-wal`).size).toBeGreaterThan(0);
		const before = [sha(src), sha(`${src}-wal`)];
		const r = backupDb({ dbPath: src, now: NOW });
		expect([sha(src), sha(`${src}-wal`)]).toEqual(before);
		expect(existsSync(`${src}-shm`)).toBe(false);
		expect(backups(dataDir)).toEqual([
			"agentcity.db",
			"agentcity.db-wal",
			"backups",
		]);
		expect(backups(join(dataDir, "backups"))).toEqual([
			"agentcity.db-20261111-010203.db",
		]);
		const copy = new Database(join(dataDir, r.file), { readonly: true });
		expect(count(copy, "machines")).toBe(3); // WAL rows recovered from the private copy
		copy.close();
	});

	test("verify failure: copy removed, nothing published, error raised", () => {
		const { dataDir, dbPath, hub } = seeded();
		hub.close();
		expect(() =>
			backupDb({
				dbPath,
				now: NOW,
				verify: (p, v) => {
					const c = new Database(p);
					c.run("PRAGMA user_version = 999"); // a copy that no longer matches the source
					c.close();
					verifyCopy(p, v);
				},
			}),
		).toThrow(/user_version 999 != source/);
		expect(backups(join(dataDir, "backups"))).toEqual([]);
	});
});
