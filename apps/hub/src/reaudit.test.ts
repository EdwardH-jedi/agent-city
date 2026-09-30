// Re-audit regressions N01, N02, N04, N05, N07 (hub side; N03 = collector golden test, N06 =
// collector pollOnce tests). The re-audit report itself was never produced, so each case is built
// from the finding's description. Synthetic values only; token-shaped ids assembled at runtime.
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type IngestEvent,
	isSafeRawId,
	namespaceIds,
	safeRawId,
	sessionId,
	subagentId,
} from "@agent-city/schema";
import { gitInfo } from "../../collector/src/git-info.ts";
import { openDb } from "./db.ts";
import type { GithubClient } from "./github/client.ts";
import { parseDistricts } from "./github/districts.ts";
import { probeCheckout, scanLocal } from "./github/local.ts";
import { type ConfiguredSummary, syncGithub } from "./github/sync.ts";
import { createApp, scheduleGithubSync } from "./index.ts";
import { createBroadcaster } from "./routes/ws.ts";
import { ingestEvents, listReposByDistrict, sweepStale } from "./store.ts";

const T = (s: number) => `2026-09-29T00:00:${String(s).padStart(2, "0")}.000Z`;
const ev = (
	id: string,
	type: string,
	s: number,
	extra: Partial<IngestEvent> = {},
): IngestEvent => ({
	id,
	ts: T(s),
	machine_id: "cockpit",
	session_id: "claude:a",
	agent_id: null,
	provider: "claude",
	type,
	tool: null,
	summary: null,
	repo_id: null,
	payload_redacted: {},
	...extra,
});
const rows = (db: Database, sql: string) => db.query(sql).all();
const row = (db: Database, sql: string) => db.query(sql).get();

// ── N04 ────────────────────────────────────────────────────────────────────

describe("N04 raw ids: reserved chars / unsafe → hashed, then namespaced", () => {
	test.each([
		["slash", "a/sub:x"],
		["colon", "a:b"],
		["space", "a b"],
		["control", "a\u0001b"],
		["newline", "a\nb"],
		["over-128", "x".repeat(129)],
		["token-shaped", `ghp_${"Q".repeat(36)}`],
	])("%s → redacted-<hash>, deterministic", (_n, raw) => {
		expect(isSafeRawId(raw)).toBe(false);
		const id = safeRawId(raw);
		expect(id).toMatch(/^redacted-[0-9a-f]{16}$/);
		expect(safeRawId(raw)).toBe(id);
		expect(sessionId("claude", raw)).toBe(`claude:${id}`);
	});

	test("128 chars of the allowed charset stay verbatim (length is a hash trigger, not a cut)", () => {
		const raw = `A.b_-${"9".repeat(123)}`;
		expect(raw).toHaveLength(128);
		expect(sessionId("codex", raw)).toBe(`codex:${raw}`);
		expect(safeRawId(`${raw}9`)).not.toBe(safeRawId(`${raw}8`));
	});

	test("raw session `a/sub:x` can never collide with session `a`'s subagent `sub:x`", () => {
		const odd = sessionId("claude", "a/sub:x");
		const a = sessionId("claude", "a");
		const sub = subagentId(a, "x");
		expect(new Set([odd, a, sub]).size).toBe(3);
		expect(sub).toBe("claude:a/sub:x");
		expect(odd).not.toBe(sub);

		const db = openDb(":memory:");
		ingestEvents(db, [
			ev("e1", "PreToolUse", 1, { session_id: "a/sub:x" }),
			ev("e2", "PreToolUse", 2, { session_id: "a", agent_id: "sub:x" }),
		]);
		const ids = rows(db, "SELECT id, session_id FROM agents ORDER BY id") as {
			id: string;
			session_id: string;
		}[];
		expect(ids).toContainEqual({ id: odd, session_id: odd });
		expect(ids).toContainEqual({
			id: "claude:a/sub:x",
			session_id: "claude:a",
		});
		expect(new Set(ids.map((r) => r.id)).size).toBe(ids.length);
	});

	test("hub rejects an agent id belonging to another session → main agent", () => {
		const out = namespaceIds({
			provider: "claude" as const,
			session_id: "claude:a",
			agent_id: "claude:b/sub:y",
			parent_agent_id: "claude:b",
		});
		expect(out.agent_id).toBe("claude:a");
		expect(out.parent_agent_id).toBe("claude:a");

		const db = openDb(":memory:");
		ingestEvents(db, [
			ev("e1", "PreToolUse", 1, {
				session_id: "claude:b",
				agent_id: "claude:b/sub:y",
			}),
			ev("e2", "PreToolUse", 2, {
				session_id: "claude:a",
				agent_id: "claude:b/sub:y",
			}),
		]);
		expect(row(db, "SELECT agent_id FROM events WHERE id = 'e2'")).toEqual({
			agent_id: "claude:a",
		});
		expect(
			row(db, "SELECT session_id FROM agents WHERE id = 'claude:b/sub:y'"),
		).toEqual({ session_id: "claude:b" });
	});

	test("unknown agent shapes and unsafe subagent parts never become new agent rows", () => {
		expect(
			namespaceIds({
				provider: "claude" as const,
				session_id: "a",
				agent_id: "weird/thing",
			}).agent_id,
		).toBe("claude:a");
		expect(
			namespaceIds({
				provider: "claude" as const,
				session_id: "a",
				agent_id: "claude:a/sub:x/y",
			}).agent_id,
		).toBe("claude:a");
		expect(subagentId("claude:a", "tu with space")).toMatch(
			/^claude:a\/sub:redacted-[0-9a-f]{16}$/,
		);
	});
});

// ── N01 ────────────────────────────────────────────────────────────────────

describe("N01 same timestamp: the later arrival wins (session and agents alike)", () => {
	test("End(t) then Start(t) → active, main agent reopened", () => {
		const db = openDb(":memory:");
		ingestEvents(db, [ev("start0", "SessionStart", 1)]);
		ingestEvents(db, [ev("end", "SessionEnd", 5)]);
		ingestEvents(db, [ev("start", "SessionStart", 5)]);
		expect(row(db, "SELECT status, ended_at FROM sessions")).toEqual({
			status: "active",
			ended_at: null,
		});
		expect(
			row(db, "SELECT ended_at FROM agents WHERE id = 'claude:a'"),
		).toEqual({
			ended_at: null,
		});
	});

	test("Start(t) then End(t) → ended, agents ended", () => {
		const db = openDb(":memory:");
		ingestEvents(db, [ev("start", "SessionStart", 5)]);
		ingestEvents(db, [ev("end", "SessionEnd", 5)]);
		expect(row(db, "SELECT status, ended_at FROM sessions")).toEqual({
			status: "ended",
			ended_at: T(5),
		});
		expect(
			row(db, "SELECT count(*) AS n FROM agents WHERE ended_at IS NULL"),
		).toEqual({ n: 0 });
	});

	test("same order inside one batch behaves the same", () => {
		const db = openDb(":memory:");
		ingestEvents(db, [
			ev("end", "SessionEnd", 5),
			ev("start", "SessionStart", 5),
		]);
		expect(row(db, "SELECT status FROM sessions")).toEqual({
			status: "active",
		});
		expect(
			row(db, "SELECT ended_at FROM agents WHERE id = 'claude:a'"),
		).toEqual({
			ended_at: null,
		});
	});
});

// ── N02 ────────────────────────────────────────────────────────────────────

const emptyGithub: GithubClient = {
	rate: {
		graphql: { remaining: 5000, limit: 5000, resetAt: null },
		core: { remaining: 5000, limit: 5000, resetAt: null },
	},
	async graphql<T>() {
		return {
			viewer: {
				login: "octo-example",
				repositories: {
					totalCount: 0,
					pageInfo: { hasNextPage: false, endCursor: null },
					nodes: [],
				},
			},
		} as T;
	},
	async getDerived() {
		return { value: null, status: 404 };
	},
};

describe("N02 `.git` suffix: stripped only from remote URLs; local ids keep the folder name", () => {
	test("a `foo.git` checkout gets one id through collector, sync and hub → live 1", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "agentcity-n02-")));
		const dir = join(root, "foo.git");
		mkdirSync(dir);
		Bun.spawnSync(["git", "-c", "init.defaultBranch=main", "init", "-q"], {
			cwd: dir,
		});

		expect(gitInfo(dir)?.repo_id).toBe("local/foo.git"); // collector
		const probed = await probeCheckout(dir);
		expect(probed.slug).toBeNull();

		const db = openDb(":memory:");
		const summary = await syncGithub({
			db,
			client: emptyGithub,
			districts: parseDistricts("uncategorized: []\n"),
			local: { machineId: "cockpit", roots: [root], scan: scanLocal },
		});
		expect(summary.local?.localOnly.map((l) => l.id)).toEqual([
			"local/foo.git",
		]); // sync

		ingestEvents(db, [
			ev("n02", "PreToolUse", 1, { repo_id: gitInfo(dir)?.repo_id ?? null }),
		]); // hub
		expect(row(db, "SELECT repo_id FROM sessions")).toEqual({
			repo_id: "local/foo.git",
		});
		const repos = listReposByDistrict(db).uncategorized ?? [];
		expect(repos.map((r) => [r.id, r.active_sessions])).toEqual([
			["local/foo.git", 1],
		]);
	});

	test("ingest never strips `.git`; a remote URL still does", async () => {
		const db = openDb(":memory:");
		ingestEvents(db, [ev("x", "PreToolUse", 1, { repo_id: "local/bar.git" })]);
		expect(row(db, "SELECT repo_id FROM events")).toEqual({
			repo_id: "local/bar.git",
		});
		const { parseGithubRemote } = await import("@agent-city/schema");
		expect(parseGithubRemote("git@github.com:octo-example/bar.git")).toBe(
			"octo-example/bar",
		);
	});
});

// ── N05 ────────────────────────────────────────────────────────────────────

describe("N05 sessions.rev is bumped on every write and exposed to clients", () => {
	const rev = (db: Database) =>
		(row(db, "SELECT rev FROM sessions") as { rev: number }).rev;

	test("insert 1 → update 2 → stale sweep 3 → repo remap 4", () => {
		const db = openDb(":memory:");
		const r1 = ingestEvents(db, [
			ev("1", "PreToolUse", 1, { repo_id: "Octo/Alpha" }),
		]);
		expect(r1.sessions[0]?.rev).toBe(1);
		ingestEvents(db, [ev("2", "PreToolUse", 2)]);
		expect(rev(db)).toBe(2);
		const swept = sweepStale(db, new Date(Date.parse(T(2)) + 16 * 60_000));
		expect(swept[0]).toMatchObject({ status: "stale", rev: 3 }); // published row carries rev
		db.run(
			"INSERT INTO repos (id, district, is_local_only) VALUES ('octo/alpha', 'uncategorized', 0)",
		);
		ingestEvents(db, [
			ev("3", "PreToolUse", 3, {
				session_id: "claude:b",
				repo_id: "OCTO/ALPHA",
			}),
		]);
		expect(
			row(db, "SELECT rev, repo_id FROM sessions WHERE id = 'claude:a'"),
		).toEqual({ rev: 4, repo_id: "octo/alpha" });
	});

	test("/api/sessions and the ws `session` message both carry rev", async () => {
		const db = openDb(":memory:");
		const published: { kind: string; data: unknown }[] = [];
		const app = createApp({
			db,
			ingestToken: "t",
			publish: (kind, data) => published.push({ kind, data }),
		});
		await app.request("/ingest", {
			method: "POST",
			headers: {
				authorization: "Bearer t",
				"content-type": "application/json",
			},
			body: JSON.stringify(ev("w1", "PreToolUse", 1)),
		});
		const snap = (await (await app.request("/api/sessions")).json()) as {
			sessions: { rev: number }[];
		};
		expect(snap.sessions[0]?.rev).toBe(1);
		expect(published.find((p) => p.kind === "session")?.data).toMatchObject({
			rev: 1,
		});
	});
});

// ── N07 ────────────────────────────────────────────────────────────────────

describe("N07 repo remap → {kind:'invalidate', scope:['sessions','events']}", () => {
	test("wire shape: top-level scope, no data", () => {
		const sent: string[] = [];
		const b = createBroadcaster();
		b.attach({ publish: (_t, m) => sent.push(m) as unknown as number });
		b.publish("invalidate", { scope: ["sessions", "events"] });
		expect(JSON.parse(sent[0] ?? "{}")).toEqual({
			kind: "invalidate",
			scope: ["sessions", "events"],
		});
	});

	test("ingest-time remap publishes invalidate", async () => {
		const db = openDb(":memory:");
		const published: { kind: string; data: unknown }[] = [];
		const app = createApp({
			db,
			ingestToken: "t",
			publish: (kind, data) => published.push({ kind, data }),
		});
		const post = (e: IngestEvent) =>
			app.request("/ingest", {
				method: "POST",
				headers: {
					authorization: "Bearer t",
					"content-type": "application/json",
				},
				body: JSON.stringify(e),
			});
		await post(ev("r1", "PreToolUse", 1, { repo_id: "Octo/Alpha" }));
		expect(published.some((p) => p.kind === "invalidate")).toBe(false);
		db.run(
			"INSERT INTO repos (id, district, is_local_only) VALUES ('octo/alpha', 'uncategorized', 0)",
		);
		await post(
			ev("r2", "PreToolUse", 2, {
				session_id: "claude:b",
				repo_id: "OCTO/alpha",
			}),
		);
		expect(published.filter((p) => p.kind === "invalidate")).toEqual([
			{ kind: "invalidate", data: { scope: ["sessions", "events"] } },
		]);
	});

	test("hub sync scheduler publishes invalidate when sync remapped references", async () => {
		const db = openDb(":memory:");
		const published: { kind: string; data: unknown }[] = [];
		const fakeSync = async () =>
			({
				total: 0,
				changedRepoIds: [],
				remappedRefs: 3,
				rate: emptyGithub.rate,
				aborted: null,
			}) as unknown as ConfiguredSummary;
		const stop = scheduleGithubSync(
			db,
			(kind, data) => published.push({ kind, data }),
			60,
			fakeSync,
		);
		await Bun.sleep(20);
		stop();
		expect(published).toContainEqual({
			kind: "invalidate",
			data: { scope: ["sessions", "events"] },
		});
	});
});
