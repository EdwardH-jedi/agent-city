// Applies the workspace migrations with the same semantics as apps/hub/src/db.ts `migrate()` (each
// whole file + `PRAGMA user_version = N` in its own immediate transaction, the version re-read
// inside it): 008_workspace_approvals.sql (this directory's byte-identical copy of the registered
// file), 009_accepted_evidence_validity.sql and 010_proposal_contract_v1_2.sql (both registered in
// packages/schema/migrations). Tests use
// this on a genuine 007 database; once both files are registered openDb() has already applied them
// and this is a no-op.
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS_DIR } from "@agent-city/schema/migrations";

/** The schema version the workspace store needs (008 tables + 009 evidence/validity + 010 v1.2 proposals). */
export const WORKSPACE_SCHEMA_VERSION = 10;
/** The last registered migration 008 builds on (006 managed tasks, 007 quarantine). */
const REQUIRED_BASE_VERSION = 7;

export const WORKSPACE_MIGRATION_FILE = join(
	import.meta.dir,
	"008_workspace_approvals.sql",
);
export const EVIDENCE_VALIDITY_MIGRATION_FILE = join(
	MIGRATIONS_DIR,
	"009_accepted_evidence_validity.sql",
);
export const PROPOSAL_V1_2_MIGRATION_FILE = join(
	MIGRATIONS_DIR,
	"010_proposal_contract_v1_2.sql",
);

const STEPS: readonly { version: number; file: string }[] = [
	{ version: 8, file: WORKSPACE_MIGRATION_FILE },
	{ version: 9, file: EVIDENCE_VALIDITY_MIGRATION_FILE },
	{ version: 10, file: PROPOSAL_V1_2_MIGRATION_FILE },
];

const userVersion = (db: Database): number =>
	db.query<{ user_version: number }, []>("PRAGMA user_version").get()
		?.user_version ?? 0;

/**
 * Ensure the workspace tables exist (008, 009, then 010). Returns true if this call applied anything.
 * Every pending step runs inside ONE immediate transaction that re-reads the version first, so
 * handles racing on one file apply each step exactly once (one handle applies, the others no-op) and
 * a failing step rolls the whole call back. Throws (nothing applied) if the database is below 007 —
 * run openDb() first.
 */
export function ensureWorkspaceSchema(db: Database): boolean {
	if (userVersion(db) >= WORKSPACE_SCHEMA_VERSION) return false;
	const pending = STEPS.map((step) => ({
		...step,
		sql: readFileSync(step.file, "utf8"),
	}));
	return db
		.transaction(() => {
			let current = userVersion(db);
			if (current >= WORKSPACE_SCHEMA_VERSION) return false;
			if (current < REQUIRED_BASE_VERSION)
				throw new Error(
					`workspace schema: expected user_version ${REQUIRED_BASE_VERSION} before 008, found ${current}`,
				);
			for (const step of pending) {
				if (current >= step.version) continue;
				if (current !== step.version - 1)
					throw new Error(
						`workspace schema: expected user_version ${step.version - 1} before ${String(step.version).padStart(3, "0")}, found ${current}`,
					);
				db.run(step.sql);
				db.run(`PRAGMA user_version = ${step.version}`);
				current = step.version;
			}
			return true;
		})
		.immediate();
}
