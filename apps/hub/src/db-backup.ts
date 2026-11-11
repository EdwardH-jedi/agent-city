// `bun run db:backup` — write a consistent, dated copy of the hub DB while the hub keeps running.
//   <data dir>/backups/<DB file name>-YYYYMMDD-HHMMSS.db   (UTC; data dir = the directory holding the DB;
//   the full file name is kept: `agentcity.db` → `agentcity.db-20261111-010203.db`)
// Mechanism: `VACUUM INTO` (a transactional snapshot — committed rows only, safe next to the hub's
// WAL writer; never `cp` the live file) into a fresh path inside a private 0700 staging dir that this
// run creates with mkdtemp inside the backup dir (SQLite refuses an existing target, even an empty
// one, so there is no pre-created temp file). The copy is checked (`PRAGMA integrity_check`, same
// `user_version` as the source) and only then hard-linked to its final name, which is never
// overwritten; the staging dir is removed afterwards, also on failure. Nothing this run did not
// create is ever deleted, except `--keep` pruning of exact `<DB file name>-YYYYMMDD-HHMMSS.db` files.
// The source is never opened read/write: when the hub is stopped and the WAL index (`-shm`) is gone,
// the DB and its `-wal` are copied into the staging dir and the snapshot is taken from that copy.
// Options: --db <path> | DB_PATH | ./data/agentcity.db · --dir <name> (subdirectory of the data dir,
// default `backups`) · --keep N (1..365: afterwards keep only the N newest backups of this DB).
// Output names only data-dir-relative paths, passed through `redact` — never DB contents, absolute
// paths or a raw token-shaped DB name.
import { Database } from "bun:sqlite";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	rmSync,
	type Stats,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { redact } from "@agent-city/schema/core";

export const DEFAULT_DIR = "backups";
export const KEEP_MAX = 365;
/** Prefix of the private per-run staging dir inside the backup dir (never matches a backup name). */
export const STAGING_PREFIX = ".staging-";

export class BackupError extends Error {}

export interface BackupOptions {
	dbPath: string;
	/** Subdirectory name under the data dir (no separators, no `..`). */
	dir?: string;
	/** Keep only the N newest backups of this DB after a successful backup. */
	keep?: number;
	now?: Date;
	/** Test hook (not reachable from the CLI): checks the staged copy; default `verifyCopy`. */
	verify?: (copyPath: string, expectedVersion: number) => void;
}

export interface BackupResult {
	/** Data-dir-relative path of the new backup, e.g. `backups/agentcity.db-20261111-010203.db`. */
	file: string;
	bytes: number;
	/** File names (inside the backup dir) deleted by `--keep`. */
	pruned: string[];
	/** Short per-file prune failures (already redacted); they never fail the backup. */
	pruneErrors: string[];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `agentcity.db`, 2026-11-11T01:02:03.999Z → `agentcity.db-20261111-010203.db` (UTC). */
export function backupName(dbPath: string, now: Date): string {
	const d = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
	const t = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
	return `${basename(dbPath)}-${d}-${t}.db`;
}

/** Exactly `<DB file name>-YYYYMMDD-HHMMSS.db` — the only names `--keep` ever counts or deletes. */
export function backupPattern(dbPath: string): RegExp {
	const name = basename(dbPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${name}-\\d{8}-\\d{6}\\.db$`);
}

/**
 * Bun trims surrounding whitespace when it opens a DB, so `agentcity.db ` would silently back up
 * `agentcity.db`. Refuse any such path, and any control character, before touching the disk.
 */
export function validateSourcePath(dbPath: string): void {
	const name = basename(dbPath);
	if (
		/^\s|\s$/u.test(dbPath) ||
		/^\s|\s$/u.test(name) ||
		/\p{Cc}/u.test(dbPath)
	)
		throw new BackupError(
			"the DB file name has leading/trailing whitespace or a control character; refusing, nothing written",
		);
}

export function validateDir(dir: string): string {
	if (
		!/^[A-Za-z0-9._-]{1,64}$/.test(dir) ||
		dir === "." ||
		dir === ".." ||
		dir.includes("..")
	)
		throw new BackupError(
			"--dir must be a plain subdirectory name under the data dir (no separators, no '..')",
		);
	return dir;
}

export function validateKeep(raw: string | number): number {
	const s = String(raw);
	const n = Number(s);
	if (!/^\d{1,3}$/.test(s) || n < 1 || n > KEEP_MAX)
		throw new BackupError(`--keep must be an integer from 1 to ${KEEP_MAX}`);
	return n;
}

export interface CliArgs {
	db?: string;
	dir: string;
	keep?: number;
}

export function parseArgs(argv: readonly string[]): CliArgs {
	const out: CliArgs = { dir: DEFAULT_DIR };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (flag !== "--db" && flag !== "--dir" && flag !== "--keep")
			throw new BackupError(
				"usage: db:backup [--db <path>] [--dir <name>] [--keep N]",
			);
		if (value === undefined || value.startsWith("--"))
			throw new BackupError(`${flag} needs a value`);
		if (flag === "--db") out.db = value;
		else if (flag === "--dir") out.dir = validateDir(value);
		else out.keep = validateKeep(value);
		i++;
	}
	return out;
}

const inside = (root: string, p: string): boolean => {
	const rel = relative(root, p);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

const errCode = (err: unknown): string =>
	(err as NodeJS.ErrnoException)?.code ?? "error";

const exists = (p: string): boolean => {
	try {
		lstatSync(p);
		return true;
	} catch (err) {
		if (errCode(err) === "ENOENT") return false;
		throw err;
	}
};

/**
 * Resolve (creating 0700 if absent) the backup dir, prove its real path is inside the data dir and
 * owned by this user, then make it 0700. A dir owned by someone else is refused, never chmod'ed.
 */
function resolveBackupDir(dataDir: string, dir: string): string {
	const wanted = join(dataDir, dir);
	if (!exists(wanted)) mkdirSync(wanted, { mode: 0o700 });
	let real: string;
	try {
		real = realpathSync(wanted);
	} catch {
		throw new BackupError(
			`${dir}/ does not resolve (dangling link?); refusing`,
		);
	}
	if (!inside(dataDir, real))
		throw new BackupError(`${dir}/ resolves outside the data dir; refusing`);
	const st = statSync(real);
	if (!st.isDirectory())
		throw new BackupError(`${dir} is not a directory; refusing`);
	if (typeof process.getuid === "function" && st.uid !== process.getuid())
		throw new BackupError(`${dir}/ is not owned by this user; refusing`);
	if ((st.mode & 0o777) !== 0o700) chmodSync(real, 0o700);
	return real;
}

/** SQLite header bytes 18/19 are 2 for a WAL-mode database. */
function isWalDb(path: string): boolean {
	const fd = openSync(path, "r");
	try {
		const head = Buffer.alloc(20);
		return (
			readSync(fd, head, 0, 20, 0) === 20 && head[18] === 2 && head[19] === 2
		);
	} finally {
		closeSync(fd);
	}
}

/** Byte copy into a new file created exclusively with mode 0600 (never replaces anything). */
function copyPrivate(from: string, to: string): void {
	const src = openSync(from, "r");
	try {
		const dst = openSync(to, "wx", 0o600);
		try {
			const buf = Buffer.allocUnsafe(1 << 20);
			for (;;) {
				const n = readSync(src, buf, 0, buf.length, null);
				if (n === 0) break;
				let off = 0;
				while (off < n) off += writeSync(dst, buf, off, n - off);
			}
		} finally {
			closeSync(dst);
		}
	} finally {
		closeSync(src);
	}
}

/**
 * The connection the snapshot is taken from; the source is never opened read/write.
 * - Normal case (hub running, or its WAL index present): a read-only connection on the source.
 * - WAL DB whose `-shm` is gone (hub stopped on a platform that removes sidecars): a read-only open
 *   would create `-shm` beside the source and a read/write one would checkpoint into it, so the DB
 *   and its `-wal` are byte-copied into the private staging dir and that copy is opened instead
 *   (SQLite recovers the WAL there).
 */
function openSnapshotSource(srcReal: string, staging: string): Database {
	if (isWalDb(srcReal) && !exists(`${srcReal}-shm`)) {
		const copy = join(staging, "source.db");
		copyPrivate(srcReal, copy);
		if (exists(`${srcReal}-wal`)) copyPrivate(`${srcReal}-wal`, `${copy}-wal`);
		return new Database(copy, { readwrite: true, create: false });
	}
	return new Database(srcReal, { readonly: true });
}

export function verifyCopy(path: string, expectedVersion: number): void {
	const copy = new Database(path, { readonly: true });
	try {
		const rows = copy
			.query<{ integrity_check: string }, []>("PRAGMA integrity_check")
			.all();
		if (rows.length !== 1 || rows[0]?.integrity_check !== "ok")
			throw new BackupError("integrity_check failed on the copy; removed it");
		const v = copy
			.query<{ user_version: number }, []>("PRAGMA user_version")
			.get()?.user_version;
		if (v !== expectedVersion)
			throw new BackupError(
				`copy user_version ${v} != source ${expectedVersion}; removed it`,
			);
	} finally {
		copy.close();
	}
}

interface FileId {
	real: string;
	dev: number;
	ino: number;
}

function prune(
	backupDir: string,
	dbPath: string,
	justWritten: string,
	keep: number,
	source: FileId,
): Pick<BackupResult, "pruned" | "pruneErrors"> {
	const pattern = backupPattern(dbPath);
	const pruned: string[] = [];
	const pruneErrors: string[] = [];
	let names: string[];
	let written: Stats;
	try {
		names = readdirSync(backupDir);
		written = lstatSync(join(backupDir, justWritten));
	} catch (err) {
		return { pruned, pruneErrors: [`list: ${errCode(err)}`] };
	}
	const others = names
		.filter((n) => n !== justWritten && pattern.test(n))
		.filter((n) => {
			const p = join(backupDir, n);
			try {
				const st = lstatSync(p); // never follow or delete links / dirs
				if (!st.isFile()) return false;
				// never the live DB (a DB_PATH symlink or hard link into the backup dir) or the new copy
				if (st.dev === source.dev && st.ino === source.ino) return false;
				if (st.dev === written.dev && st.ino === written.ino) return false;
				return realpathSync(p) !== source.real;
			} catch {
				return false;
			}
		})
		.sort(); // names sort chronologically
	// the file just written always stays and counts as one of the N
	for (const n of others.slice(0, Math.max(0, others.length - (keep - 1)))) {
		try {
			const p = join(backupDir, n);
			const st = lstatSync(p);
			if (!st.isFile() || (st.dev === source.dev && st.ino === source.ino))
				continue;
			unlinkSync(p);
			pruned.push(n);
		} catch (err) {
			pruneErrors.push(redact(`${n}: ${errCode(err)}`));
		}
	}
	return { pruned, pruneErrors };
}

export function backupDb(opts: BackupOptions): BackupResult {
	const { dbPath, now = new Date(), verify = verifyCopy } = opts;
	const dir = validateDir(opts.dir ?? DEFAULT_DIR);
	const keep = opts.keep === undefined ? undefined : validateKeep(opts.keep);
	if (dbPath === ":memory:")
		throw new BackupError("db:backup needs a file path");
	validateSourcePath(dbPath);

	// The DB name is never echoed raw (it can be token-shaped): errors say `<db>`.
	let srcStat: Stats | undefined;
	try {
		srcStat = statSync(dbPath);
	} catch {}
	if (!srcStat?.isFile())
		throw new BackupError("no database file at <db>; nothing written");
	const source: FileId = {
		real: realpathSync(dbPath),
		dev: srcStat.dev,
		ino: srcStat.ino,
	};
	validateSourcePath(source.real); // a clean-named symlink to `x.db ` would be trimmed too

	const dataDir = realpathSync(dirname(dbPath));
	const backupDir = resolveBackupDir(dataDir, dir);
	const name = backupName(dbPath, now);
	const dest = join(backupDir, name);
	const rel = `${dir}/${name}`;
	const shown = redact(rel);
	if (exists(dest))
		throw new BackupError(`${shown} already exists; not overwriting`);

	// Everything this run creates (staging dir, source copies, the snapshot) starts owner-only.
	const umask = process.umask(0o077);
	let staging: string | undefined;
	try {
		staging = mkdtempSync(join(backupDir, STAGING_PREFIX)); // exclusive, 0700
		const out = join(staging, "backup.db");
		const src = openSnapshotSource(source.real, staging);
		let version: number;
		try {
			src.run("PRAGMA busy_timeout = 5000");
			version =
				src.query<{ user_version: number }, []>("PRAGMA user_version").get()
					?.user_version ?? 0;
			src.run("VACUUM INTO ?", [out]);
		} finally {
			src.close();
		}
		chmodSync(out, 0o600);
		// "r+", not "r": on Windows fsync (FlushFileBuffers) needs a write-capable handle and fails
		// with EPERM on a read-only one. The file is our own private copy; nothing is written to it.
		const fd = openSync(out, "r+");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		verify(out, version);
		linkSync(out, dest); // EEXIST instead of silently replacing a backup
	} catch (err) {
		if (err instanceof BackupError) throw err;
		if (errCode(err) === "EEXIST")
			throw new BackupError(`${shown} already exists; not overwriting`);
		throw new BackupError(`backup failed (${errCode(err)}); nothing written`);
	} finally {
		process.umask(umask);
		if (staging !== undefined)
			try {
				rmSync(staging, { recursive: true, force: true }); // created by this run only
			} catch {}
	}

	const bytes = statSync(dest).size;
	const pr =
		keep === undefined
			? { pruned: [], pruneErrors: [] }
			: prune(backupDir, dbPath, name, keep, source);
	return { file: rel, bytes, ...pr };
}

if (import.meta.main) {
	try {
		const args = parseArgs(process.argv.slice(2));
		const dbPath = args.db || process.env.DB_PATH || "./data/agentcity.db";
		const r = backupDb({ dbPath, dir: args.dir, keep: args.keep });
		console.log(
			`[db:backup] wrote ${redact(r.file)} (${r.bytes} bytes)` +
				(args.keep === undefined
					? ""
					: `; kept ${args.keep}, pruned ${r.pruned.length}`),
		);
		for (const e of r.pruneErrors)
			console.error(`[db:backup] prune failed: ${redact(e)}`);
	} catch (err) {
		// only our own short messages; fs / sqlite errors can embed absolute paths
		console.error(
			`[db:backup] ${err instanceof BackupError ? redact(err.message) : `failed (${errCode(err)})`}`,
		);
		process.exit(1);
	}
}
