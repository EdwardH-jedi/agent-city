import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MIGRATIONS_DIR } from "@agent-city/schema/migrations";

/** Open (creating if needed) the hub database, enable WAL, and apply pending migrations. */
export function openDb(path: string): Database {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

	const db = new Database(path, { create: true, strict: true });
	// busy_timeout first: switching to WAL takes a lock, and a second handle opening the same file
	// at that moment must wait instead of failing with "database is locked".
	db.run("PRAGMA busy_timeout = 5000");
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");

	migrate(db);
	return db;
}

/** Apply `NNN_*.sql` files whose number is greater than PRAGMA user_version, each in its own transaction. */
export function migrate(db: Database): void {
	const row = db
		.query<{ user_version: number }, []>("PRAGMA user_version")
		.get();
	const current = row?.user_version ?? 0;

	const files = readdirSync(MIGRATIONS_DIR)
		.filter((f) => /^\d+_.*\.sql$/.test(f))
		.sort();

	for (const file of files) {
		const version = Number.parseInt(file, 10);
		if (version <= current) continue;

		const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
		db.transaction(() => {
			// re-read inside the (immediate) transaction: another handle may have applied it meanwhile
			const now =
				db.query<{ user_version: number }, []>("PRAGMA user_version").get()
					?.user_version ?? 0;
			if (version <= now) return;
			db.run(sql);
			db.run(`PRAGMA user_version = ${version}`);
		}).immediate();
	}
}
