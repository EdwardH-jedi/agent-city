// 009_accepted_evidence_validity: additive on a GENUINE 008 database (legacy rows unchanged, 008's
// immutability triggers intact, honest backfill), its own triggers (append-only bundles, immutable
// request digest, decision digest = request digest, sticky / rev+1 / no-delete validity), and the
// store API on top. Synthetic data only (no git, no network).
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createManagedBridge } from "../decisions/engine.ts";
import { createWorkspaceReadModel } from "../decisions/read-model.ts";
import { WorkspaceConflictError, WorkspaceRowError } from "./errors.ts";
import {
	ensureWorkspaceSchema,
	WORKSPACE_MIGRATION_FILE,
} from "./migration.ts";
import { createWorkspaceStore } from "./store.ts";
import {
	approvedExecution,
	clock,
	fixtureConfig,
	gate2Accept,
	openDb007,
	openWorkspace,
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
			"SELECT sql FROM sqlite_master ORDER BY type, name",
		)
		.all()
		.map((r) => r.sql)
		.join("\n");
const digestOf = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

function fresh(): Workspace {
	const dir = tempDir();
	dirs.push(dir);
	const ws = openWorkspace(join(dir, "hub.db"));
	dbs.push(ws.db);
	return ws;
}

/** A genuine 008 database (001–008 applied, user_version 8) holding the rows of `source`. */
function genuine008From(source: Database, path: string): Database {
	const db = openDb007(path);
	dbs.push(db);
	const sql8 = readFileSync(WORKSPACE_MIGRATION_FILE, "utf8");
	db.transaction(() => {
		db.run(sql8);
		db.run("PRAGMA user_version = 8");
	}).immediate();
	const reference = openDb007(":memory:");
	dbs.push(reference);
	reference.run(sql8);
	// copy the rows exactly as an 008 hub wrote them: the 008 triggers are lifted for the copy only
	// and re-created from their own stored SQL (byte-identical schema afterwards, checked below)
	const triggers = db
		.query<{ name: string; sql: string }, []>(
			"SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
		)
		.all();
	for (const t of triggers) db.run(`DROP TRIGGER ${t.name}`);
	const srcPath = source.filename;
	db.run(`ATTACH DATABASE '${srcPath.replace(/'/g, "''")}' AS src`);
	for (const table of [
		"managed_tasks",
		"managed_runs",
		"workspace_tasks",
		"managed_proposals",
		"managed_approval_requests",
		"managed_decisions",
	]) {
		const cols = db
			.query<{ name: string }, []>(`PRAGMA main.table_info(${table})`)
			.all()
			.map((c) => c.name)
			.join(", ");
		db.run(
			`INSERT INTO main.${table} (${cols}) SELECT ${cols} FROM src.${table} ORDER BY rowid`,
		);
	}
	db.run("DETACH DATABASE src");
	for (const t of triggers) db.run(t.sql);
	expect(schemaSql(db)).toBe(schemaSql(reference));
	expect(userVersion(db)).toBe(8);
	return db;
}

describe("009 on a genuine 008 database", () => {
	test("additive: legacy rows read unchanged, 008 triggers still hold, one honest `unverifiable` row per Gate-2 accept", () => {
		const src = fresh();
		const now = clock();
		// accepted before 009 existed (and published before 010: a v1 proposal)
		const legacy = gate2Accept(src, now, { digest: null, legacy: true });
		const gate1Only = approvedExecution(src, now, { legacy: true });
		const dir = tempDir();
		dirs.push(dir);
		const db = genuine008From(src.db, join(dir, "hub008.db"));
		expect(
			db
				.query<{ n: number }, []>("SELECT count(*) AS n FROM managed_decisions")
				.get()?.n,
		).toBe(3); // two Gate-1 approves + one Gate-2 accept

		expect(ensureWorkspaceSchema(db)).toBe(true);
		expect(userVersion(db)).toBe(10);

		// legacy rows read exactly as before (absent digest = pre-009 shape)
		const store = createWorkspaceStore(db);
		for (const id of [
			legacy.result_request_id,
			legacy.runRequest.id,
			gate1Only.runRequest.id,
		])
			expect(store.getApprovalRequest(id)).toEqual(
				src.store.getApprovalRequest(id),
			);
		expect(store.getDecision(legacy.accept_decision_id)).toEqual(
			src.store.getDecision(legacy.accept_decision_id),
		);
		expect(
			store.getApprovalRequest(legacy.result_request_id),
		).not.toHaveProperty("evidence_bundle_digest");

		// backfill: exactly one row, for the accept decision only
		const rows = store.listAcceptanceValidity();
		expect(rows).toHaveLength(1);
		const [row] = rows;
		expect(row).toMatchObject({
			decision_id: legacy.accept_decision_id,
			result_request_id: legacy.result_request_id,
			workspace_task_id: legacy.task.id,
			evidence_bundle_digest: null,
			status: "unverifiable",
			reason: "legacy_no_durable_evidence",
			first_invalid_at: null,
			rev: 1,
		});
		expect(Number.isNaN(Date.parse(row?.checked_at ?? ""))).toBe(false);

		// 008's immutability survives the ADD COLUMNs
		expect(() =>
			db.run(
				"UPDATE managed_approval_requests SET invalidation_detail = 'x' WHERE id = ?",
				[legacy.result_request_id],
			),
		).toThrow(/closed request never changes/);
		expect(() =>
			db.run(
				"UPDATE managed_approval_requests SET evidence_bundle_digest = ? WHERE id = ?",
				[digestOf(1), legacy.result_request_id],
			),
		).toThrow();
		expect(() =>
			db.run(
				"UPDATE managed_decisions SET evidence_bundle_digest = ? WHERE id = ?",
				[digestOf(1), legacy.accept_decision_id],
			),
		).toThrow(/append-only/);
		expect(() =>
			db.run(
				"UPDATE workspace_tasks SET stage_detail = 'x', rev = rev + 1 WHERE id = ?",
				[legacy.task.id],
			),
		).toThrow(/terminal/);
		// the legacy acceptance can never be upgraded to `valid` (sticky, no invented proof)
		expect(() =>
			db.run(
				"UPDATE managed_acceptance_validity SET status = 'unknown', reason = 'verification_unavailable', rev = rev + 1 WHERE decision_id = ?",
				[legacy.accept_decision_id],
			),
		).toThrow(/sticky/);
		expect(() =>
			db.run("DELETE FROM managed_acceptance_validity WHERE decision_id = ?", [
				legacy.accept_decision_id,
			]),
		).toThrow(/never deleted/);

		// what the operator sees: the historical acceptance + "legacy acceptance — no durable evidence"
		const config = fixtureConfig();
		const reads = createWorkspaceReadModel({
			store,
			config,
			bridge: createManagedBridge({ db, config }),
		});
		const view = reads.taskView(legacy.task.id);
		expect(view?.task.stage).toBe("accepted");
		expect(view?.acceptance_validity).toMatchObject({
			decision_id: legacy.accept_decision_id,
			status: "unverifiable",
			reason: "legacy_no_durable_evidence",
			evidence_bundle_digest: null,
		});
		const detail = reads.taskDetail(legacy.task.id);
		expect(detail.ok && detail.body.acceptance_validity?.status).toBe(
			"unverifiable",
		);
		// …and nothing re-checks it (sweeps select valid / unknown only)
		expect(
			store.listAcceptanceValidity({ statuses: ["valid", "unknown"] }),
		).toEqual([]);
	});
});

describe("009 triggers", () => {
	test("bundles are append-only and bound to an attempt of their managed task", () => {
		const ws = fresh();
		const a = gate2Accept(ws, clock(), { digest: digestOf(1) });
		expect(ws.store.getEvidenceBundle(digestOf(1))?.run_id).toBe(a.run_id);
		expect(() =>
			ws.db.run(
				"UPDATE managed_evidence_bundles SET byte_len = 1 WHERE digest = ?",
				[digestOf(1)],
			),
		).toThrow(/append-only/);
		expect(() =>
			ws.db.run("DELETE FROM managed_evidence_bundles WHERE digest = ?", [
				digestOf(1),
			]),
		).toThrow(/append-only/);
		const other = approvedExecution(ws, clock(100));
		expect(() =>
			ws.store.transaction((tx) =>
				tx.insertEvidenceBundle({
					digest: digestOf(2),
					result_envelope_hash: digestOf(3),
					managed_task_id: other.managed_task_id,
					run_id: a.run_id, // an attempt of ANOTHER managed task
					rel_path: `_sealed/${digestOf(2)}.bundle`,
					byte_len: 10,
					item_count: 1,
					created_at: "2026-10-02T08:00:00.000Z",
				}),
			),
		).toThrow(/attempt of managed_task_id/);
	});

	test("a request's digest must name a bundle of this envelope and attempt, and never changes", () => {
		const ws = fresh();
		const now = clock();
		const a = gate2Accept(ws, now, { digest: digestOf(4) });
		expect(
			ws.store.getApprovalRequest(a.result_request_id)?.evidence_bundle_digest,
		).toBe(digestOf(4));
		// a bundle sealing ANOTHER envelope cannot back a request
		expect(() => gate2Accept(ws, now, { digest: digestOf(4) })).toThrow();
		// immutable even while the request is still pending (008 freezes it once closed)
		const p = gate2Accept(ws, now, { digest: digestOf(12), pending: true });
		expect(ws.store.getApprovalRequest(p.result_request_id)?.status).toBe(
			"pending",
		);
		for (const next of [null, digestOf(4)])
			expect(() =>
				ws.db.run(
					"UPDATE managed_approval_requests SET evidence_bundle_digest = ?, rev = rev + 1 WHERE id = ?",
					[next, p.result_request_id],
				),
			).toThrow(/evidence_bundle_digest is immutable/);
		// a run request never carries one (row contract + trigger)
		expect(() =>
			ws.db.run(
				"UPDATE managed_approval_requests SET evidence_bundle_digest = ?, rev = rev + 1 WHERE id = ?",
				[digestOf(12), p.runRequest.id],
			),
		).toThrow();
	});

	test("decisions: only a Gate-2 accept carries a digest, and exactly its request's", () => {
		const ws = fresh();
		const now = clock();
		expect(() =>
			gate2Accept(ws, now, { digest: digestOf(5), decision_digest: null }),
		).toThrow(/exactly its request/);
		const ws2 = fresh();
		expect(() =>
			gate2Accept(ws2, clock(), { digest: null, decision_digest: digestOf(6) }),
		).toThrow();
		// the receipt must describe the digest the row carries (store cross-check)
		const ws3 = fresh();
		const ok = gate2Accept(ws3, clock(), { digest: digestOf(7) });
		expect(
			ws3.store.getDecision(ok.accept_decision_id)?.response_body.effects
				.evidence_bundle_digest,
		).toBe(digestOf(7));
	});

	test("validity: inserted valid / unverifiable only, for its accept decision; rev +1; identity immutable; invalid is sticky; never deleted", () => {
		const ws = fresh();
		const a = gate2Accept(ws, clock(), {
			digest: digestOf(8),
			validity: false,
		});
		const base = {
			decision_id: a.accept_decision_id,
			result_request_id: a.result_request_id,
			workspace_task_id: a.task.id,
			evidence_bundle_digest: digestOf(8),
			status: "valid" as const,
			reason: null,
			detail: null,
			checked_at: "2026-10-02T08:00:00.000Z",
			first_invalid_at: null,
			rev: 1,
		};
		const insert = (row: Record<string, unknown>) =>
			ws.store.transaction((tx) =>
				tx.insertAcceptanceValidity(row as typeof base),
			);
		expect(() =>
			insert({
				...base,
				status: "invalid",
				reason: "bundle_missing",
				first_invalid_at: base.checked_at,
			}),
		).toThrow(/starts at rev 1, valid/);
		expect(() => insert({ ...base, decision_id: a.decision_id })).toThrow(); // the Gate-1 decision
		expect(() =>
			insert({ ...base, evidence_bundle_digest: digestOf(9) }),
		).toThrow();
		insert(base);
		expect(() => insert(base)).toThrow(WorkspaceConflictError);

		const upd = (rev: number, patch: Record<string, unknown>) =>
			ws.store.transaction((tx) =>
				tx.updateAcceptanceValidity(a.accept_decision_id, rev, {
					status: "valid",
					reason: null,
					detail: null,
					checked_at: "2026-10-02T08:00:01.000Z",
					first_invalid_at: null,
					...patch,
				} as never),
			);
		expect(upd(7, {})).toBeNull(); // CAS miss
		expect(
			upd(1, {
				status: "unknown",
				reason: "verification_unavailable",
				detail: "git",
			})?.rev,
		).toBe(2);
		expect(upd(2, {})?.status).toBe("valid"); // unknown is not sticky
		expect(() =>
			ws.db.run(
				"UPDATE managed_acceptance_validity SET rev = rev + 2 WHERE decision_id = ?",
				[a.accept_decision_id],
			),
		).toThrow(/exactly 1/);
		expect(() =>
			ws.db.run(
				"UPDATE managed_acceptance_validity SET workspace_task_id = ?, rev = rev + 1 WHERE decision_id = ?",
				[a.task.id.replace(/.$/, "0"), a.accept_decision_id],
			),
		).toThrow();
		const inv = upd(3, {
			status: "invalid",
			reason: "source_evidence_changed",
			detail: "diff.patch",
			first_invalid_at: "2026-10-02T08:00:01.000Z",
		});
		expect(inv?.status).toBe("invalid");
		expect(() => upd(4, {})).toThrow(WorkspaceRowError); // sticky (store)
		expect(() =>
			ws.db.run(
				"UPDATE managed_acceptance_validity SET status = 'valid', reason = NULL, first_invalid_at = NULL, rev = rev + 1 WHERE decision_id = ?",
				[a.accept_decision_id],
			),
		).toThrow(/sticky/); // sticky (trigger, any writer)
		expect(() =>
			ws.db.run(
				"DELETE FROM managed_acceptance_validity WHERE decision_id = ?",
				[a.accept_decision_id],
			),
		).toThrow(/never deleted/);
	});

	test("store: identical bundle rows are one row; a different row under the same digest conflicts; oldest check first", () => {
		const ws = fresh();
		const now = clock();
		const a = gate2Accept(ws, now, { digest: digestOf(10) });
		const row = ws.store.getEvidenceBundle(digestOf(10));
		if (!row) throw new Error("no bundle row");
		ws.store.transaction((tx) => tx.insertEvidenceBundle(row)); // no-op
		expect(() =>
			ws.store.transaction((tx) =>
				tx.insertEvidenceBundle({ ...row, byte_len: row.byte_len + 1 }),
			),
		).toThrow(WorkspaceConflictError);
		const b = gate2Accept(ws, now, { digest: digestOf(11) });
		const ids = ws.store.listAcceptanceValidity().map((r) => r.decision_id);
		expect(ids).toEqual([a.accept_decision_id, b.accept_decision_id]);
		ws.store.transaction((tx) =>
			tx.updateAcceptanceValidity(a.accept_decision_id, 1, {
				status: "valid",
				reason: null,
				detail: null,
				checked_at: "2099-01-01T00:00:00.000Z",
				first_invalid_at: null,
			}),
		);
		expect(
			ws.store.listAcceptanceValidity({ limit: 1 }).map((r) => r.decision_id),
		).toEqual([b.accept_decision_id]);
		expect(ws.store.listAcceptanceValidity({ statuses: ["invalid"] })).toEqual(
			[],
		);
	});
});
