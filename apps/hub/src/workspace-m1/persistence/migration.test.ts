import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS_DIR } from "@agent-city/schema/migrations";
import { openDb } from "../../db.ts";
import {
	EVIDENCE_VALIDITY_MIGRATION_FILE,
	ensureWorkspaceSchema,
	PROPOSAL_V1_2_MIGRATION_FILE,
	WORKSPACE_MIGRATION_FILE,
	WORKSPACE_SCHEMA_VERSION,
} from "./migration.ts";
import {
	BUNDLE_COLUMNS,
	DECISION_COLUMNS,
	PROPOSAL_COLUMNS,
	REQUEST_COLUMNS,
	TASK_COLUMNS,
	VALIDITY_COLUMNS,
} from "./store.ts";
import {
	clock,
	count,
	createTask,
	openDb007,
	openWorkspace,
	publishProposal,
	removeDir,
	tempDir,
} from "./testkit.ts";

const NEW_TABLES = [
	"managed_acceptance_validity", // 009
	"managed_approval_requests",
	"managed_decisions",
	"managed_evidence_bundles", // 009
	"managed_proposals",
	"workspace_tasks",
];

const userVersion = (db: Database) =>
	db.query<{ user_version: number }, []>("PRAGMA user_version").get()
		?.user_version;

const objects = (db: Database, type: string) =>
	db
		.query<{ name: string }, [string]>(
			"SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all(type)
		.map((r) => r.name);

const schemaSql = (db: Database) =>
	db
		.query<{ sql: string | null }, []>(
			"SELECT sql FROM sqlite_master ORDER BY type, name",
		)
		.all()
		.map((r) => r.sql)
		.join("\n");

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) removeDir(d);
});

describe("workspace migrations (008_workspace_approvals + 009_accepted_evidence_validity + 010_proposal_contract_v1_2)", () => {
	test("applies on top of 001–007, sets user_version 10, adds exactly the four workflow tables + the two 009 tables", () => {
		const db = openDb007(":memory:");
		expect(userVersion(db)).toBe(7);
		const before = objects(db, "table");
		expect(ensureWorkspaceSchema(db)).toBe(true);
		expect(userVersion(db)).toBe(WORKSPACE_SCHEMA_VERSION);
		const added = objects(db, "table").filter((t) => !before.includes(t));
		expect(added).toEqual(NEW_TABLES);
		// no auth / session / challenge storage table (challenges live on request rows)
		expect(
			objects(db, "table").filter((t) =>
				/auth|session|challenge|nonce/i.test(t),
			),
		).toEqual(["sessions"]); // the pre-existing observed-telemetry table (001), not auth
		db.close();
	});

	test("columns match the rows.ts DTOs 1:1 and in order", () => {
		const db = openDb007(":memory:");
		ensureWorkspaceSchema(db);
		const cols = (t: string) =>
			db
				.query<{ name: string }, []>(`PRAGMA table_info(${t})`)
				.all()
				.map((r) => r.name);
		expect(cols("workspace_tasks")).toEqual([...TASK_COLUMNS]);
		expect(cols("managed_proposals")).toEqual([...PROPOSAL_COLUMNS]);
		expect(cols("managed_approval_requests")).toEqual([...REQUEST_COLUMNS]);
		expect(cols("managed_decisions")).toEqual([...DECISION_COLUMNS]);
		expect(cols("managed_evidence_bundles")).toEqual([...BUNDLE_COLUMNS]);
		expect(cols("managed_acceptance_validity")).toEqual([...VALIDITY_COLUMNS]);
		// 009 only APPENDS a column to the two 008 tables
		expect(REQUEST_COLUMNS.at(-1)).toBe("evidence_bundle_digest");
		expect(DECISION_COLUMNS.at(-1)).toBe("evidence_bundle_digest");
		db.close();
	});

	test("schema inventory: unique/partial indexes and immutability triggers", () => {
		const db = openDb007(":memory:");
		ensureWorkspaceSchema(db);
		const indexes = objects(db, "index");
		for (const name of [
			"idx_approval_run_per_managed_task",
			"idx_approval_result_per_run",
			"idx_approval_one_pending",
			"idx_workspace_tasks_managed",
		])
			expect(indexes).toContain(name);
		const partial = db
			.query<{ name: string; sql: string }, []>(
				"SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql LIKE '%WHERE%'",
			)
			.all();
		expect(partial.map((p) => p.name).sort()).toEqual([
			"idx_approval_one_pending",
			"idx_approval_result_per_run",
			"idx_approval_run_per_managed_task",
		]);
		expect(objects(db, "trigger")).toEqual([
			"managed_acceptance_validity_insert", // 009
			"managed_acceptance_validity_no_delete", // 009
			"managed_acceptance_validity_update", // 009
			"managed_approval_requests_bundle_immutable", // 009
			"managed_approval_requests_bundle_insert", // 009
			"managed_approval_requests_links",
			"managed_approval_requests_no_delete",
			"managed_approval_requests_update_rules",
			"managed_decisions_bundle", // 009
			"managed_decisions_match_request",
			"managed_decisions_no_delete",
			"managed_decisions_no_update",
			"managed_evidence_bundles_links", // 009
			"managed_evidence_bundles_no_delete", // 009
			"managed_evidence_bundles_no_update", // 009
			"managed_proposals_lineage",
			"managed_proposals_no_delete",
			"managed_proposals_no_update",
			"workspace_tasks_insert_shape",
			"workspace_tasks_no_delete",
			"workspace_tasks_update_rules",
		]);
		db.close();
	});

	test("foreign keys: no ON DELETE CASCADE anywhere, FK graph acyclic (up-pointers are trigger-validated)", () => {
		const db = openDb007(":memory:");
		ensureWorkspaceSchema(db);
		const fks = NEW_TABLES.flatMap((t) =>
			db
				.query<
					{ table: string; from: string; on_delete: string; on_update: string },
					[]
				>(`PRAGMA foreign_key_list(${t})`)
				.all()
				.map((f) => ({ child: t, ...f })),
		);
		expect(fks.every((f) => f.on_delete === "NO ACTION")).toBe(true);
		expect(fks.every((f) => f.on_update === "NO ACTION")).toBe(true);
		const edges = fks.map((f) => `${f.child}.${f.from} -> ${f.table}`).sort();
		expect(edges).toEqual([
			"managed_acceptance_validity.decision_id -> managed_decisions",
			"managed_acceptance_validity.evidence_bundle_digest -> managed_evidence_bundles",
			"managed_acceptance_validity.result_request_id -> managed_approval_requests",
			"managed_acceptance_validity.workspace_task_id -> workspace_tasks",
			"managed_approval_requests.evidence_bundle_digest -> managed_evidence_bundles",
			"managed_approval_requests.managed_task_id -> managed_tasks",
			"managed_approval_requests.proposal_id -> managed_proposals",
			"managed_approval_requests.run_id -> managed_runs",
			"managed_approval_requests.workspace_task_id -> workspace_tasks",
			"managed_decisions.approval_request_id -> managed_approval_requests",
			"managed_decisions.evidence_bundle_digest -> managed_evidence_bundles",
			"managed_decisions.managed_task_id -> managed_tasks",
			"managed_decisions.workspace_task_id -> workspace_tasks",
			"managed_evidence_bundles.managed_task_id -> managed_tasks",
			"managed_evidence_bundles.run_id -> managed_runs",
			"managed_proposals.predecessor_proposal_id -> managed_proposals",
			"managed_proposals.workspace_task_id -> workspace_tasks",
			"workspace_tasks.current_managed_task_id -> managed_tasks",
		]);
		for (const file of [
			WORKSPACE_MIGRATION_FILE,
			EVIDENCE_VALIDITY_MIGRATION_FILE,
			PROPOSAL_V1_2_MIGRATION_FILE,
		]) {
			const sql = readFileSync(file, "utf8")
				.split("\n")
				.filter((l) => !l.trimStart().startsWith("--"))
				.join("\n");
			expect(sql).not.toMatch(/CASCADE/i);
		}
		db.close();
	});

	test("re-entry is a no-op and leaves the schema byte-identical", () => {
		const db = openDb007(":memory:");
		expect(ensureWorkspaceSchema(db)).toBe(true);
		const once = schemaSql(db);
		expect(ensureWorkspaceSchema(db)).toBe(false);
		expect(ensureWorkspaceSchema(db)).toBe(false);
		expect(schemaSql(db)).toBe(once);
		expect(userVersion(db)).toBe(10);
		db.close();
	});

	test("reopen: openDb skips everything at version 10, data survives, helper is a no-op", () => {
		const dir = tempDir();
		dirs.push(dir);
		const path = join(dir, "hub.db");
		const now = clock();
		const ws = openWorkspace(path);
		const task = createTask(ws.store, now());
		publishProposal(ws, task.id, now());
		const schema = schemaSql(ws.db);
		ws.db.close();

		const db = openDb(path); // db.ts migrate(): every registered file is ≤ 10 → nothing runs
		expect(userVersion(db)).toBe(10);
		expect(ensureWorkspaceSchema(db)).toBe(false);
		expect(schemaSql(db)).toBe(schema);
		expect(count(db, "SELECT count(*) AS n FROM workspace_tasks")).toBe(1);
		expect(
			count(db, "SELECT count(*) AS n FROM managed_approval_requests"),
		).toBe(1);
		db.close();
	});

	test("after registration (db.ts migrate semantics) the helper is a no-op and the schema is identical", () => {
		const viaHelper = openDb007(":memory:");
		ensureWorkspaceSchema(viaHelper);
		const viaMigrate = openDb007(":memory:");
		for (const [file, version] of [
			[WORKSPACE_MIGRATION_FILE, 8],
			[EVIDENCE_VALIDITY_MIGRATION_FILE, 9],
			[PROPOSAL_V1_2_MIGRATION_FILE, 10],
		] as const) {
			const sql = readFileSync(file, "utf8");
			viaMigrate.transaction(() => {
				viaMigrate.run(sql);
				viaMigrate.run(`PRAGMA user_version = ${version}`);
			})();
		}
		expect(ensureWorkspaceSchema(viaMigrate)).toBe(false);
		expect(schemaSql(viaMigrate)).toBe(schemaSql(viaHelper));
		// the real openDb applies the registered 008 itself: same schema, helper is a no-op
		const viaOpenDb = openDb(":memory:");
		expect(userVersion(viaOpenDb)).toBe(10);
		expect(ensureWorkspaceSchema(viaOpenDb)).toBe(false);
		expect(schemaSql(viaOpenDb)).toBe(schemaSql(viaHelper));
		viaHelper.close();
		viaMigrate.close();
		viaOpenDb.close();
	});

	test("once registered, the copy in packages/schema/migrations is byte-identical to this file", () => {
		const registered = join(MIGRATIONS_DIR, "008_workspace_approvals.sql");
		if (!existsSync(registered)) return; // not registered yet (INTEGRATION.md L1)
		expect(readFileSync(registered, "utf8")).toBe(
			readFileSync(WORKSPACE_MIGRATION_FILE, "utf8"),
		);
	});

	test("a failing migration rolls back completely (version stays 7, no partial tables)", () => {
		const db = openDb007(":memory:");
		db.run("CREATE TABLE managed_decisions (x TEXT)"); // collides with the 4th CREATE TABLE
		expect(() => ensureWorkspaceSchema(db)).toThrow();
		expect(userVersion(db)).toBe(7);
		const tables = objects(db, "table");
		expect(tables).not.toContain("workspace_tasks");
		expect(tables).not.toContain("managed_proposals");
		expect(objects(db, "trigger")).toEqual([]);
		expect(db.inTransaction).toBe(false);
		db.close();
	});

	test("refuses to build on a database that is not at 007", () => {
		const db = new Database(":memory:", { strict: true });
		expect(() => ensureWorkspaceSchema(db)).toThrow(/expected user_version 7/);
		expect(userVersion(db)).toBe(0);
		expect(objects(db, "table")).toEqual([]);
		db.close();
	});
});
