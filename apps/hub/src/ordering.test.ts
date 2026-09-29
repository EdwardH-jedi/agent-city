// Batch C (audit F08–F10, F13): event ordering, id namespace, repo id canonicalization — driven
// through ingestEvents, with the same scenarios the audit probes used.
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { IngestEvent } from "@agent-city/schema";
import { openDb } from "./db.ts";
import { ingestEvents, listReposByDistrict, remapRepoIds } from "./store.ts";

const T = (s: number) => `2026-09-29T00:00:${String(s).padStart(2, "0")}.000Z`;
const ev = (
	id: string,
	type: string,
	s: number,
	over: Partial<IngestEvent> = {},
): IngestEvent => ({
	id,
	ts: T(s),
	machine_id: "cockpit",
	session_id: "claude:shared",
	agent_id: null,
	provider: "claude",
	type,
	tool: null,
	summary: null,
	repo_id: null,
	payload_redacted: {},
	...over,
});

type Row = Record<string, unknown>;
const one = (db: Database, sql: string): Row =>
	db.query<Row, []>(sql).get() ?? {};
const all = (db: Database, sql: string): Row[] => db.query<Row, []>(sql).all();

describe("F08 late metadata", () => {
	test("an older event only fills NULL fields; the newest values stay", () => {
		const db = openDb(":memory:");
		ingestEvents(db, [
			ev("new", "UserPromptSubmit", 3, {
				cwd: "/new",
				branch: "new",
				model: "new",
				repo_id: "o/new",
			}),
			ev("old", "Stop", 1, {
				cwd: "/old",
				branch: "old",
				model: "old",
				repo_id: "o/old",
			}),
		]);
		expect(
			one(
				db,
				"SELECT status, cwd, branch, model, repo_id, last_event_at FROM sessions",
			),
		).toEqual({
			status: "active",
			cwd: "/new",
			branch: "new",
			model: "new",
			repo_id: "o/new",
			last_event_at: T(3),
		});
	});

	test("late event fills a gap the newer event left NULL", () => {
		const db = openDb(":memory:");
		ingestEvents(db, [
			ev("new", "PreToolUse", 3, { cwd: "/new" }),
			ev("old", "SessionStart", 1, { cwd: "/old", model: "m-old" }),
		]);
		expect(one(db, "SELECT cwd, model FROM sessions")).toEqual({
			cwd: "/new",
			model: "m-old",
		});
	});

	test("a newer event overrides non-null metadata", () => {
		const db = openDb(":memory:");
		ingestEvents(db, [
			ev("a", "SessionStart", 1, { model: "m1", branch: "b1" }),
		]);
		ingestEvents(db, [ev("b", "PreToolUse", 2, { model: "m2" })]);
		expect(one(db, "SELECT model, branch FROM sessions")).toEqual({
			model: "m2",
			branch: "b1", // newer event had no branch → kept
		});
	});
});

describe("F09 agent end ordering + resume", () => {
	const mainEnded = (db: Database) =>
		one(db, "SELECT ended_at FROM agents WHERE id = 'claude:shared'").ended_at;

	test("resume after SessionEnd reopens the main agent (subagents stay ended)", () => {
		const db = openDb(":memory:");
		ingestEvents(db, [
			ev("pre", "PreToolUse", 1, {
				tool: "Task",
				agent_id: "claude:shared/sub:t1",
				agent_kind: "subagent",
			}),
			ev("end", "SessionEnd", 2),
		]);
		expect(mainEnded(db)).toBe(T(2));
		ingestEvents(db, [ev("resume", "SessionStart", 3)]);
		expect(one(db, "SELECT status, ended_at FROM sessions")).toEqual({
			status: "active",
			ended_at: null,
		});
		expect(mainEnded(db)).toBeNull();
		expect(
			one(db, "SELECT ended_at FROM agents WHERE kind = 'subagent'").ended_at,
		).toBe(T(2));
	});

	test("resume in the same batch (audit probe order)", () => {
		const db = openDb(":memory:");
		ingestEvents(db, [
			ev("end", "SessionEnd", 1),
			ev("resume", "SessionStart", 3),
		]);
		expect(one(db, "SELECT status, ended_at FROM sessions")).toEqual({
			status: "active",
			ended_at: null,
		});
		expect(mainEnded(db)).toBeNull();
	});

	test("a late SessionEnd (older than the session's last event) ends nothing", () => {
		const db = openDb(":memory:");
		ingestEvents(db, [
			ev("active", "SessionStart", 3),
			ev("sub", "PreToolUse", 4, {
				tool: "Task",
				agent_id: "claude:shared/sub:t2",
				agent_kind: "subagent",
			}),
			ev("late-end", "SessionEnd", 1),
		]);
		expect(one(db, "SELECT status, ended_at FROM sessions")).toEqual({
			status: "active",
			ended_at: null,
		});
		expect(all(db, "SELECT ended_at FROM agents")).toEqual([
			{ ended_at: null },
			{ ended_at: null },
		]);
	});

	test("an older non-end event after SessionEnd does not reopen the main agent", () => {
		const db = openDb(":memory:");
		ingestEvents(db, [ev("end", "SessionEnd", 5), ev("late", "PreToolUse", 2)]);
		expect(one(db, "SELECT status FROM sessions")).toEqual({ status: "ended" });
		expect(mainEnded(db)).toBe(T(5));
	});
});

describe("F10 id namespace at the hub", () => {
	test("same raw session id from two providers → two sessions, two main agents", () => {
		const db = openDb(":memory:");
		ingestEvents(db, [
			ev("cc:one", "Stop", 1, { session_id: "one" }),
			ev("codex:one", "UserPromptSubmit", 2, {
				session_id: "one",
				provider: "codex",
			}),
		]);
		expect(
			all(db, "SELECT id, provider, status FROM sessions ORDER BY id"),
		).toEqual([
			{ id: "claude:one", provider: "claude", status: "idle" },
			{ id: "codex:one", provider: "codex", status: "active" },
		]);
		expect(all(db, "SELECT id FROM agents ORDER BY id")).toEqual([
			{ id: "claude:one" },
			{ id: "codex:one" },
		]);
	});

	test("legacy `sub:<id>` from two sessions → two distinct subagents", () => {
		const db = openDb(":memory:");
		ingestEvents(db, [
			ev("first", "PreToolUse", 1, {
				session_id: "a",
				agent_id: "sub:reused",
				agent_kind: "subagent",
				tool: "Agent",
			}),
			ev("second", "PreToolUse", 2, {
				session_id: "b",
				agent_id: "sub:reused",
				agent_kind: "subagent",
				tool: "Agent",
			}),
		]);
		expect(
			all(
				db,
				"SELECT id, session_id, parent_agent_id FROM agents WHERE kind = 'subagent' ORDER BY id",
			),
		).toEqual([
			{
				id: "claude:a/sub:reused",
				session_id: "claude:a",
				parent_agent_id: "claude:a",
			},
			{
				id: "claude:b/sub:reused",
				session_id: "claude:b",
				parent_agent_id: "claude:b",
			},
		]);
		expect(
			one(db, "SELECT session_id, agent_id FROM events WHERE id = 'second'"),
		).toEqual({ session_id: "claude:b", agent_id: "claude:b/sub:reused" });
	});

	test("a parent from another session is not accepted (falls back to main)", () => {
		const db = openDb(":memory:");
		ingestEvents(db, [ev("x", "PreToolUse", 1, { session_id: "claude:x" })]);
		ingestEvents(db, [
			ev("y", "PreToolUse", 2, {
				session_id: "claude:y",
				agent_id: "claude:y/sub:t",
				parent_agent_id: "claude:x",
			}),
		]);
		expect(
			one(db, "SELECT parent_agent_id FROM agents WHERE id = 'claude:y/sub:t'"),
		).toEqual({ parent_agent_id: "claude:y" });
	});

	test("an event spooled by a pre-F10 collector lands in the namespaced rows", () => {
		const db = openDb(":memory:");
		ingestEvents(db, [
			ev("cc:old:PreToolUse:t1", "PreToolUse", 1, {
				session_id: "old",
				agent_id: "sub:t1",
				parent_agent_id: "old",
				agent_kind: "subagent",
				tool: "Task",
			}),
			// the same event again from a new collector (same event id) → deduped
			ev("cc:old:PreToolUse:t1", "PreToolUse", 1, {
				session_id: "claude:old",
				agent_id: "claude:old/sub:t1",
			}),
		]);
		expect(all(db, "SELECT id FROM sessions")).toEqual([{ id: "claude:old" }]);
		expect(
			all(db, "SELECT id, parent_agent_id FROM agents ORDER BY id"),
		).toEqual([
			{ id: "claude:old", parent_agent_id: null },
			{ id: "claude:old/sub:t1", parent_agent_id: "claude:old" },
		]);
		expect(one(db, "SELECT count(*) AS n FROM events")).toEqual({ n: 1 });
	});
});

describe("F13 repo id canonicalization", () => {
	test("ingest before the canonical row → sync remap re-points sessions + events", () => {
		const db = openDb(":memory:");
		ingestEvents(db, [
			ev("pre-sync", "UserPromptSubmit", 1, {
				session_id: "case-s",
				repo_id: "OCTO-EXAMPLE/ALPHA",
			}),
		]);
		db.run(
			"INSERT INTO repos (id, district, is_local_only) VALUES ('octo-example/alpha', 'uncategorized', 0)",
		);
		expect(remapRepoIds(db)).toBe(2); // 1 session + 1 event
		expect(one(db, "SELECT repo_id FROM sessions")).toEqual({
			repo_id: "octo-example/alpha",
		});
		expect(one(db, "SELECT repo_id FROM events")).toEqual({
			repo_id: "octo-example/alpha",
		});
		expect(listReposByDistrict(db).uncategorized?.[0]?.active_sessions).toBe(1);
		expect(remapRepoIds(db)).toBe(0); // idempotent
	});

	test("ingest resolves to the repos row, then to the casing sessions already use", () => {
		const db = openDb(":memory:");
		ingestEvents(db, [
			ev("a", "PreToolUse", 1, { session_id: "s1", repo_id: "Octo/Beta.git" }),
		]);
		ingestEvents(db, [
			ev("b", "PreToolUse", 2, { session_id: "s2", repo_id: "octo/beta" }),
		]);
		expect(all(db, "SELECT DISTINCT repo_id FROM events")).toEqual([
			{ repo_id: "Octo/Beta" },
		]);
		db.run(
			"INSERT INTO repos (id, district, is_local_only) VALUES ('octo/BETA', 'uncategorized', 0)",
		);
		ingestEvents(db, [
			ev("c", "PreToolUse", 3, { session_id: "s3", repo_id: "OCTO/beta" }),
		]);
		expect(one(db, "SELECT repo_id FROM events WHERE id = 'c'")).toEqual({
			repo_id: "octo/BETA",
		});
		remapRepoIds(db);
		expect(all(db, "SELECT DISTINCT repo_id FROM sessions")).toEqual([
			{ repo_id: "octo/BETA" },
		]);
	});

	test("a local-only case twin is folded into the GitHub row", () => {
		const db = openDb(":memory:");
		db.run("INSERT INTO machines (id) VALUES ('cockpit')");
		db.run(
			`INSERT INTO repos (id, district, is_local_only) VALUES
			 ('Octo/Gamma', 'uncategorized', 1), ('octo/gamma', 'uncategorized', 0)`,
		);
		db.run(
			"INSERT INTO repo_paths (machine_id, path, repo_id) VALUES ('cockpit', '/w/gamma', 'Octo/Gamma')",
		);
		remapRepoIds(db);
		expect(all(db, "SELECT id FROM repos")).toEqual([{ id: "octo/gamma" }]);
		expect(one(db, "SELECT repo_id FROM repo_paths")).toEqual({
			repo_id: "octo/gamma",
		});
	});
});
