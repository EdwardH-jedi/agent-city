// 010_proposal_contract_v1_2: managed_proposals rebuilt so it can hold ProposalSnapshot v1.2 (the 008
// CHECK allowed only v1). On a GENUINE 009 database holding legacy v1 rows: every row is copied
// verbatim, every reference survives (deferred FK check at COMMIT), the immutability triggers are
// re-created byte-identically, the schema equals a fresh one; legacy rows stay readable next to new
// v1.2 rows; the column must name the snapshot's own contract. Synthetic data only.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	isProposalV1_2,
	PROPOSAL_CONTRACT,
	PROPOSAL_CONTRACT_V1_2,
} from "@agent-city/schema/workspace-m1";
import { openDb } from "../../db.ts";
import {
	EVIDENCE_VALIDITY_MIGRATION_FILE,
	ensureWorkspaceSchema,
	WORKSPACE_MIGRATION_FILE,
} from "./migration.ts";
import { createWorkspaceStore } from "./store.ts";
import {
	approvedExecution,
	clock,
	createTask,
	fixtureConfig,
	gate2Accept,
	openDb007,
	publishProposal,
	removeDir,
	tempDir,
	type Workspace,
} from "./testkit.ts";

const dirs: string[] = [];
const dbs: Database[] = [];
afterEach(() => {
	for (const d of dbs.splice(0))
		try {
			d.close();
		} catch {
			// closed
		}
	for (const d of dirs.splice(0)) removeDir(d);
});

const userVersion = (db: Database) =>
	db
		.query<{ v: number }, []>(
			"SELECT user_version AS v FROM pragma_user_version",
		)
		.get()?.v;
const schemaSql = (db: Database) =>
	db
		.query<{ sql: string | null }, []>(
			"SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
		)
		.all()
		.map((r) => r.sql)
		.join("\n");
const triggerSql = (db: Database, table: string) =>
	db
		.query<{ name: string; sql: string }, [string]>(
			"SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name",
		)
		.all(table);
const rows = (db: Database, table: string) =>
	JSON.stringify(db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());

/** A genuine 009 database (001–009, user_version 9) with a workspace store on it. */
function genuine009(): Workspace {
	const dir = tempDir();
	dirs.push(dir);
	const db = openDb007(join(dir, "hub009.db"));
	dbs.push(db);
	for (const [file, version] of [
		[WORKSPACE_MIGRATION_FILE, 8],
		[EVIDENCE_VALIDITY_MIGRATION_FILE, 9],
	] as const) {
		const sql = readFileSync(file, "utf8");
		db.transaction(() => {
			db.run(sql);
			db.run(`PRAGMA user_version = ${version}`);
		}).immediate();
	}
	db.run("PRAGMA foreign_keys = ON");
	return {
		db,
		store: createWorkspaceStore(db),
		deps: { db, config: fixtureConfig() },
	};
}

describe("010 on a genuine 009 database", () => {
	test("legacy v1 rows copied verbatim, references intact, triggers identical, schema = fresh; then v1.2 rows fit", () => {
		const ws = genuine009();
		const now = clock();
		const accepted = gate2Accept(ws, now, { digest: null, legacy: true });
		const second = createTask(ws.store, now());
		const v1 = publishProposal(ws, second.id, now(), { legacy: true });
		const v2 = publishProposal(ws, second.id, now(), { legacy: true }); // a successor (predecessor FK)
		// a v1.2 snapshot cannot be stored before 010 (the 008 CHECK)
		const third = createTask(ws.store, now());
		expect(() => publishProposal(ws, third.id, now())).toThrow();
		const before = {
			proposals: rows(ws.db, "managed_proposals"),
			requests: rows(ws.db, "managed_approval_requests"),
			decisions: rows(ws.db, "managed_decisions"),
			triggers: triggerSql(ws.db, "managed_proposals"),
			reads: [accepted.proposal_id, v1.proposal_id, v2.proposal_id].map((id) =>
				ws.store.getProposal(id),
			),
		};
		expect(userVersion(ws.db)).toBe(9);

		expect(ensureWorkspaceSchema(ws.db)).toBe(true);
		expect(userVersion(ws.db)).toBe(10);
		expect(rows(ws.db, "managed_proposals")).toBe(before.proposals);
		expect(rows(ws.db, "managed_approval_requests")).toBe(before.requests);
		expect(rows(ws.db, "managed_decisions")).toBe(before.decisions);
		expect(triggerSql(ws.db, "managed_proposals")).toEqual(before.triggers);
		expect(ws.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
		const fresh = openDb(":memory:");
		dbs.push(fresh);
		expect(schemaSql(ws.db)).toBe(schemaSql(fresh));
		expect(
			[accepted.proposal_id, v1.proposal_id, v2.proposal_id].map((id) =>
				ws.store.getProposal(id),
			),
		).toEqual(before.reads);
		expect(
			before.reads.every((r) => r?.contract_version === PROPOSAL_CONTRACT),
		).toBe(true);

		// immutability / lineage / references still enforced on the rebuilt table
		expect(() =>
			ws.db.run("UPDATE managed_proposals SET created_by = 'x' WHERE id = ?", [
				v1.proposal_id,
			]),
		).toThrow(/immutable/);
		expect(() =>
			ws.db.run("DELETE FROM managed_proposals WHERE id = ?", [v1.proposal_id]),
		).toThrow(/immutable/);

		// v1.2 now fits, next to the legacy rows
		const v3 = publishProposal(ws, second.id, now());
		const row = ws.store.getProposal(v3.proposal_id);
		expect(row?.contract_version).toBe(PROPOSAL_CONTRACT_V1_2);
		expect(row && isProposalV1_2(row.snapshot)).toBe(true);
		expect(row?.version).toBe(3);
		expect(row?.predecessor_proposal_id).toBe(v2.proposal_id);
	});

	test("the column must be the snapshot's own contract, and only v1 | v1.2", () => {
		const dir = tempDir();
		dirs.push(dir);
		const db = openDb(join(dir, "hub.db"));
		dbs.push(db);
		const ws: Workspace = {
			db,
			store: createWorkspaceStore(db),
			deps: { db, config: fixtureConfig() },
		};
		const now = clock();
		const ex = approvedExecution(ws, now);
		const raw = db
			.query<Record<string, unknown>, [string]>(
				"SELECT * FROM managed_proposals WHERE id = ?",
			)
			.get(ex.proposal_id) as Record<string, unknown>;
		const insert = (over: Record<string, unknown>) =>
			db
				.query(
					"INSERT INTO managed_proposals (id, workspace_task_id, version, predecessor_proposal_id, contract_version, snapshot, proposal_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					...([
						"id",
						"workspace_task_id",
						"version",
						"predecessor_proposal_id",
						"contract_version",
						"snapshot",
						"proposal_hash",
						"created_by",
						"created_at",
					].map((k) => (k in over ? over[k] : raw[k])) as (
						| string
						| number
						| null
					)[]),
				);
		const base = {
			id: "wsp-99999999-9999-4999-8999-999999999999",
			version: 2,
			predecessor_proposal_id: ex.proposal_id,
			proposal_hash: "ab".repeat(32),
		};
		// a v1.2 snapshot labelled v1
		expect(() =>
			insert({ ...base, contract_version: PROPOSAL_CONTRACT }),
		).toThrow(/CHECK constraint failed/);
		// an unknown contract
		expect(() =>
			insert({ ...base, contract_version: "agentcity.proposal/v9" }),
		).toThrow(/CHECK constraint failed/);
	});
});
