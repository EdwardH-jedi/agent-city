// `bun run db:backup` — write a consistent, dated copy of the hub DB while the hub keeps running.
//   <data dir>/backups/<basename>-YYYYMMDD-HHMMSS.db   (UTC; data dir = the directory holding the DB)
// Mechanism: a read-only connection runs `VACUUM INTO` (a transactional snapshot — committed rows
// only, safe next to the hub's WAL writer; never `cp` the live file). The copy is written to
// `<dest>.tmp`, checked (`PRAGMA integrity_check`, same `user_version` as the source) and only then
// published under its final name, which is never overwritten.
// Options: --db <path> | DB_PATH | ./data/agentcity.db · --dir <name> (subdirectory of the data dir,
// default `backups`) · --keep N (1..365: afterwards keep only the N newest backups of this DB).
// Output names only data-dir-relative paths — never DB contents or absolute paths.
import { Database } from "bun:sqlite";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	realpathSync,
	statSync,
	unlinkSync,
} from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	parse,
	relative,
} from "node:path";

export const DEFAULT_DIR = "backups";
export const KEEP_MAX = 365;

export class BackupError extends Error {}

export interface BackupOptions {
	dbPath: string;
	/** Subdirectory name under the data dir (no separators, no `..`). */
	dir?: string;
	/** Keep only the N newest backups of this DB after a successful backup. */
	keep?: number;
	now?: Date;
}

export interface BackupResult {
	/** Data-dir-relative path of the new backup, e.g. `backups/agentcity-20261111-010203.db`. */
	file: string;
	bytes: number;
	/** File names (inside the backup dir) deleted by `--keep`. */
	pruned: string[];
	/** Short per-file prune failures; they never fail the backup. */
	pruneErrors: string[];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** DB file name without its extension: `agentcity.db` → `agentcity`. */
export const backupBase = (dbPath: string): string =>
	parse(basename(dbPath)).name;

/** `agentcity.db`, 2026-11-11T01:02:03.999Z → `agentcity-20261111-010203.db` (UTC). */
export function backupName(dbPath: string, now: Date): string {
	const d = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
	const t = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
	return `${backupBase(dbPath)}-${d}-${t}.db`;
}

/** Exactly `<base>-YYYYMMDD-HHMMSS.db` — the only names `--keep` ever counts or deletes. */
export function backupPattern(dbPath: string): RegExp {
	const base = backupBase(dbPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${base}-\\d{8}-\\d{6}\\.db$`);
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

const removeIfPresent = (p: string): void => {
	try {
		unlinkSync(p);
	} catch (err) {
		if (errCode(err) !== "ENOENT") throw err;
	}
};

const exists = (p: string): boolean => {
	try {
		lstatSync(p);
		return true;
	} catch (err) {
		if (errCode(err) === "ENOENT") return false;
		throw err;
	}
};

/** Resolve (creating 0700 if absent) the backup dir and prove its real path is inside the data dir. */
function resolveBackupDir(dataDir: string, dir: string): string {
	const wanted = join(dataDir, dir);
	if (!exists(wanted)) {
		mkdirSync(wanted, { mode: 0o700 });
		chmodSync(wanted, 0o700); // mkdir's mode is masked by umask
	}
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
	if (!statSync(real).isDirectory())
		throw new BackupError(`${dir} is not a directory; refusing`);
	return real;
}

/**
 * Read-only when possible. A WAL DB whose `-shm` is absent (hub stopped on a platform that removes
 * sidecars) cannot be opened read-only, so fall back to an existing-file-only read/write handle;
 * it runs nothing but PRAGMA reads and `VACUUM INTO` (`query_only` would block VACUUM INTO).
 * Neither mode creates a missing DB.
 */
function openSource(dbPath: string): Database {
	const ro = new Database(dbPath, { readonly: true });
	try {
		ro.query("PRAGMA schema_version").get(); // the open itself is lazy; this touches the file
		return ro;
	} catch (err) {
		ro.close();
		if (errCode(err) !== "SQLITE_CANTOPEN") throw err;
		return new Database(dbPath, { readwrite: true, create: false });
	}
}

function verifyCopy(path: string, expectedVersion: number): void {
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

function prune(
	backupDir: string,
	dbPath: string,
	justWritten: string,
	keep: number,
): Pick<BackupResult, "pruned" | "pruneErrors"> {
	const pattern = backupPattern(dbPath);
	const pruned: string[] = [];
	const pruneErrors: string[] = [];
	let names: string[];
	try {
		names = readdirSync(backupDir);
	} catch (err) {
		return { pruned, pruneErrors: [`list: ${errCode(err)}`] };
	}
	const others = names
		.filter((n) => n !== justWritten && pattern.test(n))
		.filter((n) => {
			try {
				return lstatSync(join(backupDir, n)).isFile(); // never follow or delete links / dirs
			} catch {
				return false;
			}
		})
		.sort(); // names sort chronologically
	// the file just written always stays and counts as one of the N
	for (const n of others.slice(0, Math.max(0, others.length - (keep - 1)))) {
		try {
			unlinkSync(join(backupDir, n));
			pruned.push(n);
		} catch (err) {
			pruneErrors.push(`${n}: ${errCode(err)}`);
		}
	}
	return { pruned, pruneErrors };
}

export function backupDb(opts: BackupOptions): BackupResult {
	const { dbPath, now = new Date() } = opts;
	const dir = validateDir(opts.dir ?? DEFAULT_DIR);
	const keep = opts.keep === undefined ? undefined : validateKeep(opts.keep);
	if (dbPath === ":memory:")
		throw new BackupError("db:backup needs a file path");

	let srcStat: ReturnType<typeof statSync> | undefined;
	try {
		srcStat = statSync(dbPath);
	} catch {}
	if (!srcStat?.isFile())
		throw new BackupError(
			`no database file at ${basename(dbPath)}; nothing written`,
		);

	const dataDir = realpathSync(dirname(dbPath));
	const backupDir = resolveBackupDir(dataDir, dir);
	const name = backupName(dbPath, now);
	const dest = join(backupDir, name);
	const rel = `${dir}/${name}`;
	if (exists(dest))
		throw new BackupError(`${rel} already exists; not overwriting`);
	const tmp = `${dest}.tmp`;
	removeIfPresent(tmp); // leftover of an interrupted run — VACUUM INTO needs a fresh file

	try {
		const src = openSource(dbPath);
		let version: number;
		try {
			src.run("PRAGMA busy_timeout = 5000");
			version =
				src.query<{ user_version: number }, []>("PRAGMA user_version").get()
					?.user_version ?? 0;
			src.run("VACUUM INTO ?", [tmp]);
		} finally {
			src.close();
		}
		chmodSync(tmp, 0o600);
		const fd = openSync(tmp, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		verifyCopy(tmp, version);
		linkSync(tmp, dest); // EEXIST instead of silently replacing a backup
	} catch (err) {
		if (err instanceof BackupError) throw err;
		if (errCode(err) === "EEXIST")
			throw new BackupError(`${rel} already exists; not overwriting`);
		throw new BackupError(`backup failed (${errCode(err)}); nothing written`);
	} finally {
		removeIfPresent(tmp);
	}

	const bytes = statSync(dest).size;
	const pr =
		keep === undefined
			? { pruned: [], pruneErrors: [] }
			: prune(backupDir, dbPath, name, keep);
	return { file: rel, bytes, ...pr };
}

if (import.meta.main) {
	try {
		const args = parseArgs(process.argv.slice(2));
		const dbPath = args.db || process.env.DB_PATH || "./data/agentcity.db";
		const r = backupDb({ dbPath, dir: args.dir, keep: args.keep });
		console.log(
			`[db:backup] wrote ${r.file} (${r.bytes} bytes)` +
				(args.keep === undefined
					? ""
					: `; kept ${args.keep}, pruned ${r.pruned.length}`),
		);
		for (const e of r.pruneErrors)
			console.error(`[db:backup] prune failed: ${e}`);
	} catch (err) {
		// only our own short messages; fs / sqlite errors can embed absolute paths
		console.error(
			`[db:backup] ${err instanceof BackupError ? err.message : `failed (${errCode(err)})`}`,
		);
		process.exit(1);
	}
}
