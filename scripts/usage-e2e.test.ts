// Token usage end to end, in one process (18 §5 U2): synthetic Claude + Codex logs → the collector's
// poller → the hub's real POST /ingest/usage (in-memory DB) → GET /api/usage. Checks the three things
// the contract promises: only numbers and ids arrive, re-sending never changes a sum, and a collector
// that lost its offsets reaches the same sums. Fake secrets are assembled at runtime.
import { describe, expect, test } from "bun:test";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CollectorConfig } from "../apps/collector/src/config.ts";
import { createUsagePoll } from "../apps/collector/src/usage-tail.ts";
import { openDb } from "../apps/hub/src/db.ts";
import { createApp } from "../apps/hub/src/index.ts";
import { UsageSummary } from "../packages/schema/src/index.ts";

const TOKEN = "e2e-ingest-token";
const FAKE_GH = `ghp_${"e".repeat(36)}`;
const FAKE_ANT = `sk-ant-api03-${"E".repeat(40)}`;
const NOW = Date.parse("2026-11-13T09:00:00Z");
const SID = "44444444-aaaa-bbbb-cccc-000000000004";
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `agentcity-e2e-${p}-`));
const jl = (...r: unknown[]) =>
	`${r.map((x) => JSON.stringify(x)).join("\n")}\n`;

const claude = (id: string, n: number, ts = "2026-11-13T08:00:00Z") =>
	jl(
		...Array.from({ length: 3 }, () => ({
			type: "assistant",
			timestamp: ts,
			sessionId: "44444444-aaaa-bbbb-cccc-000000000004",
			cwd: `/Users/someone/${FAKE_GH}/widget`,
			message: {
				id,
				model: "claude-opus-5-5",
				content: [{ type: "text", text: `export TOKEN=${FAKE_ANT}` }],
				usage: {
					input_tokens: n,
					output_tokens: n,
					cache_read_input_tokens: n,
					cache_creation_input_tokens: n,
				},
			},
		})),
	);

const codexLog = () =>
	jl(
		{
			timestamp: "2026-11-13T07:00:00Z",
			type: "session_meta",
			payload: { id: "c-1", session_id: "c-1", cwd: "/nowhere" },
		},
		{
			timestamp: "2026-11-13T07:00:01Z",
			type: "turn_context",
			payload: { model: "gpt-6-astra" },
		},
		{
			timestamp: "2026-11-13T07:00:02Z",
			type: "token_usage_record",
			payload: {
				usage: {
					input_tokens: 1000,
					cached_input_tokens: 600,
					cache_write_input_tokens: 0,
					output_tokens: 7,
				},
			},
		},
		{
			timestamp: "2026-11-13T07:00:03Z",
			type: "event_msg",
			payload: {
				type: "token_count",
				rate_limits: {
					limit_id: "codex",
					primary: {
						used_percent: 41,
						window_minutes: 10080,
						resets_at: 1794984819,
					},
					credits: { balance: FAKE_GH },
					plan_type: "prolite",
				},
			},
		},
	);

describe("collector → hub → /api/usage", () => {
	test("sums arrive once, grow with new lines, survive a collector restart, and carry no text", async () => {
		const db = openDb(":memory:");
		const pushed: unknown[] = [];
		const app = createApp({
			db,
			ingestToken: TOKEN,
			publish: (kind, data) => {
				if (kind === "usage") pushed.push(data);
			},
			now: () => new Date(NOW),
		});
		const bodies: string[] = [];
		const fetchImpl = (async (url: string, init: RequestInit) => {
			bodies.push(String(init.body));
			return app.request(new URL(url).pathname, init);
		}) as unknown as typeof fetch;

		const claudeRoot = tmp("claude");
		const codexRoot = tmp("codex");
		const home = tmp("home");
		mkdirSync(join(claudeRoot, "p", SID, "subagents"), { recursive: true });
		mkdirSync(join(codexRoot, "2026", "11", "13"), { recursive: true });
		const main = join(
			claudeRoot,
			"p",
			"44444444-aaaa-bbbb-cccc-000000000004.jsonl",
		);
		writeFileSync(main, claude("m1", 100) + claude("m2", 10));
		writeFileSync(
			join(claudeRoot, "p", SID, "subagents", "agent-1.jsonl"),
			claude("m3", 1),
		);
		writeFileSync(
			join(codexRoot, "2026", "11", "13", "rollout-x.jsonl"),
			codexLog(),
		);
		const cfg = {
			hubUrl: "http://hub.test",
			ingestToken: TOKEN,
			machine: "cockpit",
			home,
			codex: { sessionsDir: codexRoot },
			usage: { enabled: true, claudeProjectsDir: claudeRoot },
		} as unknown as CollectorConfig;
		const deps = {
			git: (cwd: string) =>
				cwd.endsWith("/widget")
					? { toplevel: cwd, repo_id: "acme/widget", branch: "main" }
					: null,
		};
		const read = async () =>
			UsageSummary.parse(await (await app.request("/api/usage")).json());
		const totals = (s: UsageSummary) =>
			s.rows.map((r) => [
				r.tool,
				r.project,
				r.model,
				r.input_tokens,
				r.output_tokens,
				r.cache_read_tokens,
				r.cache_write_tokens,
				r.messages,
				r.sessions,
			]);
		const poller = (c: CollectorConfig) =>
			createUsagePoll({
				cfg: c,
				deps,
				fetchImpl,
				now: () => NOW,
				log: () => {},
			});

		const poll = poller(cfg);
		await poll();
		let s = await read();
		expect(totals(s)).toEqual([
			["claude", "acme/widget", "claude-opus-5-5", 111, 111, 111, 111, 3, 1],
			["codex", null, "gpt-6-astra", 400, 7, 600, 0, 1, 1],
		]);
		expect(s.limits.map((l) => [l.window_minutes, l.used_percent])).toEqual([
			[10080, 41],
		]);
		expect(pushed).toHaveLength(1);

		// nothing new → nothing sent, nothing pushed
		await poll();
		expect(bodies).toHaveLength(1);

		// new lines grow the sum
		appendFileSync(main, claude("m4", 5));
		await poll();
		s = await read();
		expect(totals(s)[0]).toEqual([
			"claude",
			"acme/widget",
			"claude-opus-5-5",
			116,
			116,
			116,
			116,
			4,
			1,
		]);

		// a restarted collector re-sends everything: the hub's sums stay exactly the same
		const before = await read();
		const pushes = pushed.length;
		await poller(cfg)();
		expect(bodies.length).toBeGreaterThan(2);
		expect(await read()).toEqual(before);
		expect(pushed).toHaveLength(pushes); // equal totals → no push

		// a collector that lost its offsets file reads everything again: still the same sums
		await poller({ ...cfg, home: tmp("home2") } as CollectorConfig)();
		expect(await read()).toEqual(before);

		const wire = bodies.join("\n") + JSON.stringify(await read());
		for (const bad of [
			FAKE_GH,
			FAKE_ANT,
			"TOKEN=",
			"/Users/",
			"/nowhere",
			"someone",
		])
			expect(wire).not.toContain(bad);
		const stored = JSON.stringify([
			...db.query("SELECT * FROM usage").all(),
			...db.query("SELECT * FROM usage_limits").all(),
		]);
		for (const bad of [FAKE_GH, FAKE_ANT, "/Users/", "someone"])
			expect(stored).not.toContain(bad);
	});
});

describe("backfill → all-time total (18 §5.6 U4)", () => {
	test("old logs reach the total once; restarts and a lost offsets file leave it unchanged", async () => {
		const db = openDb(":memory:");
		const app = createApp({
			db,
			ingestToken: TOKEN,
			publish: () => {},
			now: () => new Date(NOW),
		});
		const bodies: string[] = [];
		const fetchImpl = (async (url: string, init: RequestInit) => {
			bodies.push(String(init.body));
			return app.request(new URL(url).pathname, init);
		}) as unknown as typeof fetch;
		const claudeRoot = tmp("bf-claude");
		const codexRoot = tmp("bf-codex");
		mkdirSync(join(claudeRoot, "p"), { recursive: true });
		mkdirSync(join(codexRoot, "2026", "09", "20"), { recursive: true });
		const old = join(claudeRoot, "p", `${SID}.jsonl`);
		writeFileSync(
			old,
			claude("o1", 1000, "2026-09-25T01:00:00Z") +
				claude("o2", 100, "2026-10-02T01:00:00Z"),
		);
		const rollout = join(codexRoot, "2026", "09", "20", "rollout-old.jsonl");
		writeFileSync(
			rollout,
			codexLog().replaceAll("2026-11-13T07:", "2026-09-20T07:"),
		);
		const t = Date.parse("2026-10-02T02:00:00Z") / 1000;
		utimesSync(old, t, t);
		utimesSync(rollout, t, t);
		// a later resume of that session into a new file, replaying o1 and adding one message today
		const resumed = join(
			claudeRoot,
			"p",
			"55555555-aaaa-bbbb-cccc-000000000005.jsonl",
		);
		const rerun = () =>
			writeFileSync(
				resumed,
				claude("o1", 1000, "2026-09-25T01:00:00Z").replaceAll(
					SID,
					"55555555-aaaa-bbbb-cccc-000000000005",
				) +
					claude("n1", 3).replaceAll(
						SID,
						"55555555-aaaa-bbbb-cccc-000000000005",
					),
			);
		const cfg = (home: string) =>
			({
				hubUrl: "http://hub.test",
				ingestToken: TOKEN,
				machine: "cockpit",
				home,
				codex: { sessionsDir: codexRoot },
				usage: { enabled: true, claudeProjectsDir: claudeRoot },
			}) as unknown as CollectorConfig;
		const poller = (home: string) =>
			createUsagePoll({
				cfg: cfg(home),
				deps: { git: () => null },
				fetchImpl,
				now: () => NOW,
				log: () => {},
			});
		const read = async () =>
			UsageSummary.parse(await (await app.request("/api/usage")).json());

		const home = tmp("bf-home");
		const poll = poller(home);
		await poll();
		let s = await read();
		expect(s.rows).toEqual([]); // nothing in the last 7 days
		expect(s.total).toEqual({
			since: "2026-09-20",
			tools: [
				{
					tool: "claude",
					input_tokens: 1100,
					output_tokens: 1100,
					cache_read_tokens: 1100,
					cache_write_tokens: 1100,
					messages: 2,
				},
				{
					tool: "codex",
					input_tokens: 400,
					output_tokens: 7,
					cache_read_tokens: 600,
					cache_write_tokens: 0,
					messages: 1,
				},
			],
		});
		await poll(); // done: the old files are forgotten and not read again
		rerun(); // the resume happens live: its replay of o1 is not counted again
		await poll();
		s = await read();
		expect(s.total?.tools[0]?.messages).toBe(3);
		await poller(home)(); // restart
		await poller(tmp("bf-home2"))(); // offsets lost → a second backfill (oldest-born first)
		expect((await read()).total).toEqual(s.total);
		const wire = bodies.join("\n");
		for (const bad of [FAKE_GH, FAKE_ANT, "TOKEN=", "/Users/", "someone"])
			expect(wire).not.toContain(bad);
	});
});
