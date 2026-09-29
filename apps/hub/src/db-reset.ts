// `bun run db:reset` — move the hub DB aside and create an empty, fully migrated one.
// Why: the session / agent id namespace changed (audit F10) and no migration rewrites old ids, so an
// existing DB would keep raw-id sessions next to namespaced ones. Nothing is deleted:
//   <db>  → <db>.bak.<UTC stamp>   (plus -wal / -shm with the same suffix, so the backup opens as-is)
// Stop the hub first — a running hub keeps writing to the moved file.
// Path: --db <path> | DB_PATH | ./data/agentcity.db
import { existsSync, renameSync } from "node:fs";
import { openDb } from "./db.ts";

const SIDECARS = ["", "-wal", "-shm"] as const;

/** 2026-09-30T04:30:00.123Z → 20260930T043000Z */
export function backupStamp(now: Date): string {
	return now
		.toISOString()
		.replace(/\.\d+Z$/, "Z")
		.replace(/[-:]/g, "");
}

export interface ResetResult {
	/** Backup base path, or null when there was no DB to move. */
	backup: string | null;
	moved: string[];
}

export function resetDb(path: string, now: Date = new Date()): ResetResult {
	if (path === ":memory:") throw new Error("db:reset needs a file path");
	let backup = `${path}.bak.${backupStamp(now)}`;
	// never overwrite an earlier backup (two resets within one second)
	for (let n = 2; SIDECARS.some((s) => existsSync(backup + s)); n++)
		backup = `${path}.bak.${backupStamp(now)}-${n}`;
	const moved: string[] = [];
	for (const s of SIDECARS) {
		if (!existsSync(path + s)) continue;
		renameSync(path + s, backup + s);
		moved.push(backup + s);
	}
	openDb(path).close();
	return { backup: moved.length ? backup : null, moved };
}

if (import.meta.main) {
	const i = process.argv.indexOf("--db");
	const path =
		(i > 0 ? process.argv[i + 1] : undefined) ||
		process.env.DB_PATH ||
		"./data/agentcity.db";
	try {
		const r = resetDb(path);
		console.log(
			r.backup
				? `[db:reset] moved ${r.moved.length} file(s) → ${r.backup}; created empty ${path}`
				: `[db:reset] no DB at ${path}; created empty ${path}`,
		);
	} catch (err) {
		console.error(`[db:reset] ${(err as Error).message}`);
		process.exit(1);
	}
}
