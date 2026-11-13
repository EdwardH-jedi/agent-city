// Token usage collector tests (18 §5 U1). Every transcript here is synthesized; fake secrets are
// assembled at runtime so scripts/check-secrets.ts stays clean.
import { describe, expect, test } from "bun:test";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageReport } from "@agent-city/schema";
import { USAGE_MAX_ROWS, usageDay } from "@agent-city/schema/core";
import type { CollectorConfig } from "./config.ts";
import {
	emptyUsageState,
	type ScanDeps,
	scanUsage,
	type UsageState,
	usageRows,
} from "./usage-scan.ts";
import {
	chunkRows,
	createUsagePoll,
	loadUsageState,
	markAll,
	saveUsageState,
	sendUsage,
} from "./usage-tail.ts";

const FAKE_GH = `ghp_${"k".repeat(36)}`;
const FAKE_ANT = `sk-ant-api03-${"Q".repeat(40)}`;
const SECRET_CWD = `/Users/someone/secret-${"z".repeat(8)}`;
const NOW = Date.parse("2026-11-13T09:00:00Z"); // 20:00 in Sydney (AEDT)

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `agentcity-usage-${p}-`));
const deps: ScanDeps = {
	git: (cwd) =>
		cwd.includes("widget")
			? { toplevel: cwd, repo_id: "acme/widget", branch: "main" }
			: null,
};
const jl = (...recs: unknown[]) =>
	`${recs.map((r) => JSON.stringify(r)).join("\n")}\n`;

interface Msg {
	id: string;
	ts?: string;
	model?: string;
	session?: string;
	cwd?: string;
	usage?: Record<string, unknown>;
	text?: string;
}
/** One Claude API message as Claude Code writes it: one line per content block, same usage. */
function claudeMsg(m: Msg, blocks = 2): string {
	const usage = m.usage ?? {
		input_tokens: 10,
		output_tokens: 20,
		cache_read_input_tokens: 300,
		cache_creation_input_tokens: 40,
	};
	const lines: unknown[] = [];
	for (let i = 0; i < blocks; i++)
		lines.push({
			type: "assistant",
			timestamp: m.ts ?? "2026-11-13T08:00:00.000Z",
			sessionId: m.session ?? "11111111-aaaa-bbbb-cccc-000000000001",
			cwd: m.cwd ?? "/work/widget",
			message: {
				id: m.id,
				model: m.model ?? "claude-opus-5-5",
				role: "assistant",
				content: [{ type: "text", text: m.text ?? `block ${i}` }],
				usage,
			},
		});
	return jl(...lines);
}

function codexHead(id: string, opts: { parent?: string; cwd?: string } = {}) {
	return jl(
		{
			timestamp: "2026-11-13T07:00:00.000Z",
			type: "session_meta",
			payload: {
				id,
				session_id: opts.parent ?? id,
				cwd: opts.cwd ?? "/work/widget",
				base_instructions: `be careful with ${FAKE_GH}`,
			},
		},
		{
			timestamp: "2026-11-13T07:00:01.000Z",
			type: "turn_context",
			payload: { model: "gpt-6-astra", cwd: opts.cwd ?? "/work/widget" },
		},
	);
}
const codexUsage = (
	ts: string,
	input: number,
	cached: number,
	output: number,
) =>
	jl({
		timestamp: ts,
		type: "token_usage_record",
		payload: {
			thread_id: "t",
			usage: {
				input_tokens: input,
				cached_input_tokens: cached,
				cache_write_input_tokens: 0,
				output_tokens: output,
				reasoning_output_tokens: 0,
				total_tokens: input + output,
			},
		},
	});
const codexLimits = (ts: string, pct: number) =>
	jl({
		timestamp: ts,
		type: "event_msg",
		payload: {
			type: "token_count",
			info: { total_token_usage: { input_tokens: 1 } },
			rate_limits: {
				limit_id: "codex",
				primary: {
					used_percent: pct,
					window_minutes: 10080,
					resets_at: 1794984819,
				},
				secondary: null,
				credits: { has_credits: false, balance: "12.34" },
				plan_type: "prolite",
			},
		},
	});

function scan(
	claude: string | null,
	codex: string | null,
	state: UsageState,
	extra: { perFileMax?: number; totalMax?: number } = {},
) {
	return scanUsage({
		claudeRoot: claude,
		codexRoot: codex,
		state,
		now: NOW,
		deps,
		...extra,
	});
}

describe("usageDay (Australia/Sydney)", () => {
	test("midnight and daylight saving boundaries", () => {
		expect(usageDay("2026-11-13T12:59:59Z")).toBe("2026-11-13"); // 23:59:59 AEDT
		expect(usageDay("2026-11-13T13:00:00Z")).toBe("2026-11-14"); // 00:00 AEDT
		// AEST (UTC+10) in winter
		expect(usageDay("2026-07-01T13:59:59Z")).toBe("2026-07-01");
		expect(usageDay("2026-07-01T14:00:00Z")).toBe("2026-07-02");
		// DST ends 2026-04-05 03:00 AEDT → 02:00 AEST
		expect(usageDay("2026-04-04T13:00:00Z")).toBe("2026-04-05");
		expect(usageDay("2026-04-05T13:59:00Z")).toBe("2026-04-05");
		expect(usageDay("2026-04-05T14:00:00Z")).toBe("2026-04-06");
		expect(usageDay("not a time")).toBeNull();
	});
});

describe("Claude transcripts", () => {
	test("a message split over content blocks counts once; advisor calls go to their own model", () => {
		const root = tmp("claude");
		const dir = join(root, "-work-widget");
		mkdirSync(dir, { recursive: true });
		const advisorUsage = {
			input_tokens: 4,
			output_tokens: 6,
			cache_read_input_tokens: 100,
			cache_creation_input_tokens: 0,
			iterations: [
				{ type: "message", input_tokens: 2, output_tokens: 3 },
				{
					type: "advisor_message",
					model: "claude-fable-5-2",
					input_tokens: 1000,
					output_tokens: 50,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
				{ type: "message", input_tokens: 2, output_tokens: 3 },
			],
		};
		writeFileSync(
			join(dir, "11111111-aaaa-bbbb-cccc-000000000001.jsonl"),
			jl({ type: "user", message: { content: "hi" } }) +
				claudeMsg({ id: "msg_1" }, 3) +
				claudeMsg({ id: "msg_2", usage: advisorUsage }) +
				claudeMsg({
					id: "msg_3",
					model: "<synthetic>",
					usage: { input_tokens: 0, output_tokens: 0 },
				}),
		);
		const state = emptyUsageState();
		scan(root, null, state);
		const rows = usageRows(state, state.dirty);
		expect(rows.find((r) => r.model === "claude-opus-5-5")).toMatchObject({
			session_id: "claude:11111111-aaaa-bbbb-cccc-000000000001",
			day: "2026-11-13",
			tool: "claude",
			project: "acme/widget",
			input_tokens: 14,
			output_tokens: 26,
			cache_read_tokens: 400,
			cache_write_tokens: 40,
			messages: 2,
		});
		expect(rows.find((r) => r.model === "claude-fable-5-2")).toMatchObject({
			input_tokens: 1000,
			output_tokens: 50,
			messages: 1,
		});
		expect(rows).toHaveLength(2); // the synthetic zero message adds nothing
	});

	test("subagent transcripts add into the parent session; a pruned subagent file does not lower it", () => {
		const root = tmp("claude-sub");
		const sid = "22222222-aaaa-bbbb-cccc-000000000002";
		const dir = join(root, "-work-widget");
		mkdirSync(join(dir, sid, "subagents"), { recursive: true });
		writeFileSync(
			join(dir, `${sid}.jsonl`),
			claudeMsg({ id: "m1", session: sid }),
		);
		const sub = join(dir, sid, "subagents", "agent-abc.jsonl");
		writeFileSync(
			sub,
			claudeMsg({ id: "m2", session: sid, model: "claude-sonnet-5-5" }) +
				claudeMsg({ id: "m3", session: sid, model: "claude-sonnet-5-5" }),
		);
		const state = emptyUsageState();
		scan(root, null, state);
		const before = usageRows(state, [`claude:${sid}`]);
		expect(before.map((r) => [r.model, r.messages]).sort()).toEqual([
			["claude-opus-5-5", 1],
			["claude-sonnet-5-5", 2],
		]);
		rmSync(sub);
		appendFileSync(
			join(dir, `${sid}.jsonl`),
			claudeMsg({ id: "m4", session: sid }),
		);
		scan(root, null, state);
		const after = usageRows(state, [`claude:${sid}`]);
		expect(after.find((r) => r.model === "claude-sonnet-5-5")?.messages).toBe(
			2,
		);
		expect(after.find((r) => r.model === "claude-opus-5-5")?.messages).toBe(2);
	});

	test("days follow each message's own time in Sydney", () => {
		const root = tmp("claude-day");
		mkdirSync(join(root, "p"), { recursive: true });
		writeFileSync(
			join(root, "p", "s.jsonl"),
			claudeMsg({ id: "a", session: "s", ts: "2026-11-13T12:59:00Z" }) +
				claudeMsg({ id: "b", session: "s", ts: "2026-11-13T13:01:00Z" }),
		);
		const state = emptyUsageState();
		scanUsage({
			claudeRoot: root,
			codexRoot: null,
			state,
			now: Date.parse("2026-11-13T14:00:00Z"),
			deps,
		});
		expect(
			usageRows(state, state.dirty)
				.map((r) => r.day)
				.sort(),
		).toEqual(["2026-11-13", "2026-11-14"]);
	});
});

describe("Codex rollouts", () => {
	test("cached input moves to cache_read; model from turn_context; subagent thread joins its parent", () => {
		const root = tmp("codex");
		const day = join(root, "2026", "11", "13");
		mkdirSync(day, { recursive: true });
		writeFileSync(
			join(day, "rollout-a.jsonl"),
			codexHead("parent-1") +
				codexUsage("2026-11-13T07:01:00Z", 27354, 13056, 241) +
				codexLimits("2026-11-13T07:01:01Z", 48),
		);
		writeFileSync(
			join(day, "rollout-b.jsonl"),
			codexHead("child-1", { parent: "parent-1" }) +
				codexUsage("2026-11-13T07:02:00Z", 1000, 400, 10),
		);
		const state = emptyUsageState();
		scan(null, root, state);
		expect(usageRows(state, state.dirty)).toEqual([
			{
				session_id: "codex:parent-1",
				day: "2026-11-13",
				model: "gpt-6-astra",
				tool: "codex",
				project: "acme/widget",
				input_tokens: 27354 - 13056 + 600,
				output_tokens: 251,
				cache_read_tokens: 13056 + 400,
				cache_write_tokens: 0,
				messages: 2,
			},
		]);
		expect(Object.values(state.limits)).toEqual([
			{
				tool: "codex",
				limit_id: "codex",
				window_minutes: 10080,
				used_percent: 48,
				resets_at: new Date(1794984819 * 1000).toISOString(),
				plan_type: "prolite",
				observed_at: "2026-11-13T07:01:01.000Z",
			},
		]);
	});

	test("the turn's model survives a restart (state reloaded, turn_context behind the offset)", () => {
		const root = tmp("codex-restart");
		const home = tmp("home");
		mkdirSync(join(root, "d"), { recursive: true });
		const f = join(root, "d", "rollout-r.jsonl");
		writeFileSync(
			f,
			codexHead("r-1") + codexUsage("2026-11-13T07:01:00Z", 100, 0, 1),
		);
		const statePath = join(home, "usage-offsets.json");
		const s1 = emptyUsageState();
		scan(null, root, s1);
		saveUsageState(statePath, s1);
		appendFileSync(f, codexUsage("2026-11-13T07:05:00Z", 100, 0, 1));
		const s2 = loadUsageState(statePath);
		scan(null, root, s2);
		expect(usageRows(s2, ["codex:r-1"])).toMatchObject([
			{ model: "gpt-6-astra", input_tokens: 200, messages: 2 },
		]);
	});
});

describe("bounded reads", () => {
	test("small budgets reach the same totals as one big read, splitting messages across reads", () => {
		const root = tmp("claude-big");
		mkdirSync(join(root, "p"), { recursive: true });
		let body = "";
		for (let i = 0; i < 300; i++)
			body += claudeMsg(
				{ id: `m${i}`, session: "big", text: "x".repeat(200 + (i % 7) * 50) },
				1 + (i % 3),
			);
		writeFileSync(join(root, "p", "big.jsonl"), body);
		const once = emptyUsageState();
		scan(root, null, once);
		const step = emptyUsageState();
		let scans = 0;
		for (;;) {
			scans++;
			const r = scan(root, null, step, { perFileMax: 1000, totalMax: 1000 });
			expect(r.bytes).toBeLessThanOrEqual(1000);
			if (!r.backlog) break;
			if (scans > 10_000) throw new Error("no progress");
		}
		expect(scans).toBeGreaterThan(50);
		expect(usageRows(step, ["claude:big"])).toEqual(
			usageRows(once, ["claude:big"]),
		);
		expect(usageRows(once, ["claude:big"])[0]?.messages).toBe(300);
	});

	test("a line longer than one read is skipped whole, never parsed as a fragment", () => {
		const root = tmp("claude-giant");
		mkdirSync(join(root, "p"), { recursive: true });
		const giant = claudeMsg(
			{ id: "g", session: "g", text: "y".repeat(5000) },
			1,
		);
		writeFileSync(
			join(root, "p", "g.jsonl"),
			giant + claudeMsg({ id: "after", session: "g" }, 1),
		);
		const state = emptyUsageState();
		for (let i = 0; i < 20; i++)
			if (!scan(root, null, state, { perFileMax: 1024 }).backlog) break;
		expect(usageRows(state, ["claude:g"])).toMatchObject([{ messages: 1 }]);
	});

	test("a rescan with nothing new marks nothing and changes no totals", () => {
		const root = tmp("claude-idem");
		mkdirSync(join(root, "p"), { recursive: true });
		writeFileSync(
			join(root, "p", "i.jsonl"),
			claudeMsg({ id: "1", session: "i" }),
		);
		const state = emptyUsageState();
		scan(root, null, state);
		const rows = usageRows(state, ["claude:i"]);
		state.dirty = [];
		scan(root, null, state);
		expect(state.dirty).toEqual([]);
		expect(usageRows(state, ["claude:i"])).toEqual(rows);
	});
});

describe("nothing but numbers and identifiers leaves", () => {
	test("secrets in text, cwd, model, ids and Codex credits never reach the POST body", async () => {
		const claudeRoot = tmp("claude-secret");
		const codexRoot = tmp("codex-secret");
		mkdirSync(join(claudeRoot, "p"), { recursive: true });
		mkdirSync(join(codexRoot, "d"), { recursive: true });
		const sid = "33333333-aaaa-bbbb-cccc-000000000003";
		writeFileSync(
			join(claudeRoot, "p", "x.jsonl"),
			claudeMsg({
				id: "s1",
				session: sid,
				cwd: SECRET_CWD,
				text: `token ${FAKE_GH} and ${FAKE_ANT}`,
			}) +
				claudeMsg({ id: "s2", session: sid, model: FAKE_ANT }) +
				claudeMsg({ id: "s3", session: sid, model: "claude opus <script>" }),
		);
		writeFileSync(
			join(claudeRoot, "p", "y.jsonl"),
			claudeMsg({ id: "s4", session: `a/${FAKE_GH}` }),
		);
		writeFileSync(
			join(codexRoot, "d", "rollout-s.jsonl"),
			codexHead(`codex-${FAKE_GH}`, { cwd: SECRET_CWD }) +
				codexUsage("2026-11-13T07:01:00Z", 10, 0, 1) +
				codexLimits("2026-11-13T07:01:02Z", 12.5),
		);
		const state = emptyUsageState();
		scan(claudeRoot, codexRoot, state);
		const bodies: string[] = [];
		const fakeFetch = (async (_url: string, init: RequestInit) => {
			bodies.push(String(init.body));
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		const out = await sendUsage(
			{ hubUrl: "http://hub.test", ingestToken: "t", machine: "cockpit" },
			state,
			fakeFetch,
		);
		expect(out.failed).toBeNull();
		const all = bodies.join("\n");
		for (const bad of [
			FAKE_GH,
			FAKE_ANT,
			"secret-",
			"/Users/",
			"/work/",
			"token ",
			"block",
			"12.34",
			"<script>",
			"base_instructions",
		])
			expect(all).not.toContain(bad);
		for (const b of bodies)
			expect(UsageReport.safeParse(JSON.parse(b)).success).toBe(true);
		const report = UsageReport.parse(JSON.parse(bodies[0] as string));
		expect(report.rows.map((r) => `${r.model}×${r.messages}`).sort()).toEqual([
			"claude-opus-5-5×1",
			"claude-opus-5-5×1",
			"gpt-6-astra×1",
			"unknown×2",
		]);
		expect(
			report.rows.filter((r) => r.session_id.includes("redacted-")),
		).toHaveLength(2);
		expect(report.limits).toHaveLength(1);
		// the offsets file keeps the paths of the logs it reads, never a line's text
		const home = tmp("home-secret");
		saveUsageState(join(home, "s.json"), state);
		const saved = readFileSync(join(home, "s.json"), "utf8");
		for (const bad of [FAKE_GH, FAKE_ANT, "token ", "12.34"])
			expect(saved).not.toContain(bad);
	});
});

describe("sending", () => {
	const cfg = {
		hubUrl: "http://hub.test",
		ingestToken: "t",
		machine: "cockpit",
	};
	function stateWith(sessions: number, rowsEach: number): UsageState {
		const s = emptyUsageState();
		for (let i = 0; i < sessions; i++) {
			const totals: Record<string, [number, number, number, number, number]> =
				{};
			for (let d = 0; d < rowsEach; d++)
				totals[`2026-11-13|m${d}`] = [1, 1, 1, 1, 1];
			s.files[`/f${i}`] = {
				tool: "claude",
				ino: i,
				offset: 1,
				session: `claude:s${i}`,
				project: null,
				model: null,
				last_id: null,
				totals,
				mtime: 0,
			};
		}
		markAll(s);
		return s;
	}

	test("a failed POST keeps the rows marked; the next success clears them; limits go once", async () => {
		const s = stateWith(3, 2);
		s.limits["codex|codex|10080"] = {
			tool: "codex",
			limit_id: "codex",
			window_minutes: 10080,
			used_percent: 5,
			resets_at: null,
			plan_type: null,
			observed_at: "2026-11-13T07:00:00.000Z",
		};
		s.limits_dirty = true;
		const down = (async () =>
			new Response("", { status: 404 })) as unknown as typeof fetch;
		expect((await sendUsage(cfg, s, down)).failed).toBe(404);
		expect(s.dirty).toHaveLength(3);
		expect(s.limits_dirty).toBe(true);
		const bodies: unknown[] = [];
		const ok = (async (_u: string, init: RequestInit) => {
			bodies.push(JSON.parse(String(init.body)));
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		expect(await sendUsage(cfg, s, ok)).toEqual({
			posted: 1,
			rows: 6,
			failed: null,
		});
		expect(s.dirty).toEqual([]);
		expect(s.limits_dirty).toBe(false);
		expect((bodies[0] as { limits: unknown[] }).limits).toHaveLength(1);
		const net = (async () => {
			throw new Error("down");
		}) as unknown as typeof fetch;
		markAll(s);
		expect((await sendUsage(cfg, s, net)).failed).toBe(0);
	});

	test(`chunks stay within ${USAGE_MAX_ROWS} rows and every session is cleared exactly when sent`, () => {
		const s = stateWith(40, 30); // 1,200 rows
		const chunks = chunkRows(s, s.dirty);
		expect(chunks.every((c) => c.rows.length <= USAGE_MAX_ROWS)).toBe(true);
		expect(chunks.reduce((n, c) => n + c.rows.length, 0)).toBe(1200);
		expect(chunks.flatMap((c) => c.sessions).sort()).toEqual(
			[...s.dirty].sort(),
		);
	});

	test("an unknown machine never sends", async () => {
		const s = stateWith(1, 1);
		let called = false;
		const f = (async () => {
			called = true;
			return new Response("{}");
		}) as unknown as typeof fetch;
		expect((await sendUsage({ ...cfg, machine: "laptop" }, s, f)).failed).toBe(
			-1,
		);
		expect(called).toBe(false);
	});

	test("the poller scans, saves and sends; a restart re-sends the same totals", async () => {
		const claudeRoot = tmp("poll-claude");
		const home = tmp("poll-home");
		mkdirSync(join(claudeRoot, "p"), { recursive: true });
		writeFileSync(
			join(claudeRoot, "p", "q.jsonl"),
			claudeMsg({ id: "1", session: "q" }),
		);
		const conf = {
			hubUrl: "http://hub.test",
			ingestToken: "t",
			machine: "cockpit",
			home,
			codex: { sessionsDir: join(home, "none") },
			usage: { enabled: true, claudeProjectsDir: claudeRoot },
		} as unknown as CollectorConfig;
		const sent: { rows: unknown[] }[] = [];
		const fetchImpl = (async (_u: string, init: RequestInit) => {
			sent.push(JSON.parse(String(init.body)));
			return new Response("{}");
		}) as unknown as typeof fetch;
		const logs: string[] = [];
		const poll = createUsagePoll({
			cfg: conf,
			deps,
			fetchImpl,
			now: () => NOW,
			log: (l) => logs.push(l),
		});
		expect(await poll()).toBe(60_000);
		expect(await poll()).toBe(60_000);
		expect(sent).toHaveLength(1); // nothing new → nothing sent
		const again = createUsagePoll({
			cfg: conf,
			deps,
			fetchImpl,
			now: () => NOW,
			log: () => {},
		});
		await again();
		expect(sent).toHaveLength(2);
		expect(sent[1]?.rows).toEqual(sent[0]?.rows);
		expect(logs.join("\n")).not.toContain(claudeRoot);
	});
});
