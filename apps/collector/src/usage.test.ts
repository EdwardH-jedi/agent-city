// Token usage collector tests (18 §5 U1). Every transcript here is synthesized; fake secrets are
// assembled at runtime so scripts/check-secrets.ts stays clean.
import { describe, expect, test } from "bun:test";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageReport } from "@agent-city/schema";
import { USAGE_MAX_ROWS, usageDay } from "@agent-city/schema/core";
import type { CollectorConfig } from "./config.ts";
import {
	claudeSessionFromPath,
	emptyUsageState,
	FILE_KEYS_MAX,
	KEEP_DAYS,
	type ScanDeps,
	scanUsage,
	USAGE_BACKFILL_VERSION,
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
			join(claudeRoot, "p", `${FAKE_GH}.jsonl`),
			claudeMsg({ id: `cat ${SECRET_CWD}/notes.txt`, session: `a/${FAKE_GH}` }),
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
		for (const bad of [FAKE_ANT, "token ", "12.34", "notes.txt", "cat "])
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

describe("review fixes (break-it round 1)", () => {
	test("a resumed transcript replaying earlier messages into a new file counts them once", () => {
		const root = tmp("claude-resume");
		mkdirSync(join(root, "p"), { recursive: true });
		writeFileSync(
			join(root, "p", "old.jsonl"),
			claudeMsg({ id: "msg_1", session: "old" }) +
				claudeMsg({ id: "msg_2", session: "old" }),
		);
		writeFileSync(
			join(root, "p", "new.jsonl"),
			claudeMsg({ id: "msg_1", session: "old" }) +
				claudeMsg({ id: "msg_2", session: "old" }) +
				claudeMsg({ id: "msg_3", session: "old" }),
		);
		const state = emptyUsageState();
		scan(root, null, state);
		const rows = usageRows(state, ["claude:old", "claude:new"]);
		expect(rows.reduce((n, r) => n + r.messages, 0)).toBe(3);
		expect(
			rows.find((r) => r.session_id === "claude:new")?.messages,
		).toBeGreaterThanOrEqual(1);
		// a later rescan of the same files adds nothing
		state.dirty = [];
		scan(root, null, state);
		expect(state.dirty).toEqual([]);
	});

	test("sessions come from the path: <dir>/<id>.jsonl and <dir>/<id>/subagents/<agent>.jsonl", () => {
		expect(claudeSessionFromPath(join("/r", "p", "abc-1.jsonl"))).toBe(
			"claude:abc-1",
		);
		expect(
			claudeSessionFromPath(
				join("/r", "p", "abc-1", "subagents", "agent-9.jsonl"),
			),
		).toBe("claude:abc-1");
		expect(claudeSessionFromPath(join("/r", "p", `${FAKE_GH}.jsonl`))).toMatch(
			/^claude:redacted-[0-9a-f]{16}$/,
		);
	});

	test("a limit stamped in the far future or out of ISO range is never kept or sent", () => {
		const root = tmp("codex-future");
		mkdirSync(join(root, "d"), { recursive: true });
		writeFileSync(
			join(root, "d", "rollout-f.jsonl"),
			codexHead("f-1") +
				codexLimits("+275000-01-01T00:00:00Z", 99) +
				codexLimits("2099-01-01T00:00:00Z", 98) +
				codexLimits("2026-11-13T07:00:00Z", 12),
		);
		const state = emptyUsageState();
		scan(null, root, state);
		expect(Object.values(state.limits).map((l) => l.used_percent)).toEqual([
			12,
		]);
	});

	test("a 400 drops that chunk instead of blocking every later one", async () => {
		const s = emptyUsageState();
		for (let i = 0; i < 2; i++)
			s.files[`/f${i}`] = {
				tool: "claude",
				ino: i,
				offset: 1,
				session: `claude:s${i}`,
				project: null,
				model: null,
				last_id: null,
				totals: { "2026-11-13|m": [1, 1, 1, 1, 1] },
				mtime: 0,
			};
		markAll(s);
		const bad = (async () =>
			new Response("{}", { status: 400 })) as unknown as typeof fetch;
		const out = await sendUsage(
			{ hubUrl: "http://hub.test", ingestToken: "t", machine: "cockpit" },
			s,
			bad,
		);
		expect(out.failed).toBe(400);
		expect(s.dirty).toEqual([]);
	});

	test("row counts are clamped to the schema cap before sending", () => {
		const s = emptyUsageState();
		s.files["/f"] = {
			tool: "claude",
			ino: 1,
			offset: 1,
			session: "claude:big",
			project: null,
			model: null,
			last_id: null,
			totals: { "2026-11-13|m": [9e15, 1, 1, 1, 1] },
			mtime: 0,
		};
		const [r] = usageRows(s, ["claude:big"]);
		expect(
			UsageReport.safeParse({
				schema: 1,
				machine_id: "cockpit",
				rows: [r],
				limits: [],
			}).success,
		).toBe(true);
	});

	test("a damaged offsets file loses only its bad entries", () => {
		const home = tmp("home-bad");
		const p = join(home, "s.json");
		writeFileSync(
			p,
			JSON.stringify({
				v: 1,
				files: {
					x: null,
					y: {
						tool: "claude",
						ino: 1,
						offset: 5,
						session: null,
						project: null,
						model: null,
						last_id: null,
						mtime: 0,
					},
					z: {
						tool: "claude",
						ino: 1,
						offset: 5,
						session: "claude:z",
						project: null,
						model: null,
						last_id: null,
						totals: {},
						mtime: 0,
					},
				},
				dirty: [1, "claude:z"],
				limits: { k: null },
				backfill: { v: USAGE_BACKFILL_VERSION, done: null, files: 0, cut: 0 },
			}),
		);
		const s = loadUsageState(p);
		expect(Object.keys(s.files)).toEqual(["z"]);
		expect(s.dirty).toEqual(["claude:z"]);
		expect(s.limits).toEqual({});
		expect(() => markAll(s)).not.toThrow();
	});
});

describe("state stays bounded", () => {
	test("a transcript naming endless models keeps at most FILE_KEYS_MAX (+ per-day unknown) keys", () => {
		const root = tmp("claude-models");
		mkdirSync(join(root, "p"), { recursive: true });
		let body = "";
		for (let i = 0; i < 1000; i++)
			body += claudeMsg(
				{ id: `m${i}`, session: "many", model: `model-${i}` },
				1,
			);
		writeFileSync(join(root, "p", "many.jsonl"), body);
		const state = emptyUsageState();
		scan(root, null, state);
		const keys = Object.keys(
			state.files[join(root, "p", "many.jsonl")]?.totals ?? {},
		);
		expect(keys.length).toBeLessThanOrEqual(FILE_KEYS_MAX + 1);
		const rows = usageRows(state, ["claude:many"]);
		expect(rows.reduce((n, r) => n + r.messages, 0)).toBe(1000); // nothing dropped, folded
	});
});

// ── U4: backfill and the all-time total (18 §5.6) ──────────────────────────────────────────────────

/** A stand-in hub: per (session, day, model) every column keeps the larger value, like recordUsage. */
function maxHub() {
	const rows = new Map<string, Record<string, number>>();
	const COLS = [
		"input_tokens",
		"output_tokens",
		"cache_read_tokens",
		"cache_write_tokens",
		"messages",
	] as const;
	const fetchImpl = (async (_u: string, init: RequestInit) => {
		const body = UsageReport.parse(JSON.parse(String(init.body)));
		for (const r of body.rows) {
			const k = `${r.session_id}|${r.day}|${r.model}`;
			const cur = rows.get(k) ?? {};
			for (const c of COLS) cur[c] = Math.max(cur[c] ?? 0, r[c]);
			rows.set(k, cur);
		}
		return new Response("{}");
	}) as unknown as typeof fetch;
	const total = () => {
		const t = [0, 0, 0, 0, 0];
		for (const r of rows.values())
			COLS.forEach((c, i) => {
				t[i] = (t[i] as number) + (r[c] ?? 0);
			});
		return t;
	};
	const days = () =>
		[...new Set([...rows.keys()].map((k) => k.split("|")[1] ?? ""))].sort();
	return { fetchImpl, rows, total, days };
}
const sendCfg = {
	hubUrl: "http://hub.test",
	ingestToken: "t",
	machine: "cockpit",
};
const DAY_S = 86_400;
/** Set a file's mtime `days` before NOW. */
const age = (path: string, days: number) => {
	const t = NOW / 1000 - days * DAY_S;
	utimesSync(path, t, t);
};
const isoDaysAgo = (days: number) =>
	new Date(NOW - days * DAY_S * 1000).toISOString();

describe("backfill (18 §5.6 U4)", () => {
	test("the first scans read files of any age; then it is marked done and old files cost nothing", async () => {
		const root = tmp("bf-claude");
		mkdirSync(join(root, "p"), { recursive: true });
		const old = join(root, "p", "old.jsonl");
		writeFileSync(
			old,
			claudeMsg({ id: "o1", session: "old", ts: isoDaysAgo(60) }) +
				claudeMsg({ id: "o2", session: "old", ts: isoDaysAgo(59) }),
		);
		age(old, 59);
		const recent = join(root, "p", "new.jsonl");
		writeFileSync(recent, claudeMsg({ id: "n1", session: "new" }));
		const state = emptyUsageState();
		expect(state.backfill.done).toBeNull();
		const r = scan(root, null, state);
		expect(r.backfilled).toBe(true);
		expect(state.backfill).toMatchObject({
			v: USAGE_BACKFILL_VERSION,
			files: 2,
			cut: 0,
		});
		expect(state.backfill.done).toBe(new Date(NOW).toISOString());
		const hub = maxHub();
		expect((await sendUsage(sendCfg, state, hub.fetchImpl)).failed).toBeNull();
		expect(hub.days()).toEqual([
			usageDay(NOW - 60 * DAY_S * 1000) ?? "",
			usageDay(NOW - 59 * DAY_S * 1000) ?? "",
			"2026-11-13",
		]);
		expect(hub.total()).toEqual([30, 60, 900, 120, 3]);
		// sent → the next scan forgets the old file; it is not listed again, so it is never read again
		const next = scan(root, null, state);
		expect(next).toMatchObject({ bytes: 0, backfilled: false });
		expect(state.files[old]).toBeUndefined();
		expect(Object.keys(state.files)).toEqual([recent]);
		appendFileSync(
			old,
			claudeMsg({ id: "o3", session: "old", ts: isoDaysAgo(58) }),
		);
		age(old, 58);
		expect(scan(root, null, state).bytes).toBe(0); // done: no second backfill
	});

	test("an old day is kept until the hub accepted it (a failed send keeps it)", async () => {
		const root = tmp("bf-keep");
		mkdirSync(join(root, "p"), { recursive: true });
		const old = join(root, "p", "k.jsonl");
		writeFileSync(
			old,
			claudeMsg({ id: "k1", session: "k", ts: isoDaysAgo(30) }),
		);
		age(old, 30);
		const state = emptyUsageState();
		scan(root, null, state);
		const down = (async () =>
			new Response("", { status: 503 })) as unknown as typeof fetch;
		expect((await sendUsage(sendCfg, state, down)).failed).toBe(503);
		scan(root, null, state); // not backfilling any more, but the session is still dirty
		expect(Object.keys(state.files[old]?.totals ?? {})).toHaveLength(1);
		const hub = maxHub();
		await sendUsage(sendCfg, state, hub.fetchImpl);
		expect(hub.total()[4]).toBe(1);
		scan(root, null, state);
		expect(state.files[old]).toBeUndefined();
	});

	test("restarted mid-backfill it resumes and reaches the same hub total as one read; repeats change nothing", async () => {
		const root = tmp("bf-restart");
		const home = tmp("bf-restart-home");
		mkdirSync(join(root, "p", "big", "subagents"), { recursive: true });
		let main = "";
		let sub = "";
		for (let i = 0; i < 40; i++) {
			main += claudeMsg({
				id: `m${i}`,
				session: "big",
				ts: isoDaysAgo(50 - i),
			});
			sub += claudeMsg({
				id: `s${i}`,
				session: "big",
				ts: isoDaysAgo(45 - i),
				model: "claude-haiku-5-5",
			});
		}
		const mainPath = join(root, "p", "big.jsonl");
		const subPath = join(root, "p", "big", "subagents", "agent-1.jsonl");
		writeFileSync(mainPath, main);
		writeFileSync(subPath, sub);
		age(mainPath, 11);
		age(subPath, 6);
		// reference: one unbounded read
		const ref = maxHub();
		const one = emptyUsageState();
		scan(root, null, one);
		await sendUsage(sendCfg, one, ref.fetchImpl);
		// bounded reads, a send after each, the state saved and reloaded (a restart) halfway
		const hub = maxHub();
		const statePath = join(home, "usage-offsets.json");
		let state = emptyUsageState();
		let scans = 0;
		for (;;) {
			const r = scan(root, null, state, { perFileMax: 700, totalMax: 900 });
			await sendUsage(sendCfg, state, hub.fetchImpl);
			saveUsageState(statePath, state);
			scans++;
			if (scans === 4) {
				state = loadUsageState(statePath);
				expect(state.backfill.done).toBeNull(); // still running → resumes, not restarted
				markAll(state);
			}
			if (r.backfilled) break;
			expect(scans).toBeLessThan(500);
		}
		expect(scans).toBeGreaterThan(4);
		expect(hub.total()).toEqual(ref.total());
		expect(hub.total()[4]).toBe(80);
		// a restart after it is done re-sends what the state still holds: the hub's total does not move
		const after = loadUsageState(statePath);
		expect(after.backfill.done).not.toBeNull();
		markAll(after);
		scan(root, null, after);
		await sendUsage(sendCfg, after, hub.fetchImpl);
		await sendUsage(sendCfg, after, hub.fetchImpl);
		expect(hub.total()).toEqual(ref.total());
	});

	test("a replay read in a later backfill scan than its original counts once", async () => {
		const root = tmp("bf-replay");
		mkdirSync(join(root, "p"), { recursive: true });
		const orig = join(root, "p", "orig.jsonl");
		const fork = join(root, "p", "fork.jsonl");
		let a = "";
		for (let i = 0; i < 20; i++)
			a += claudeMsg({ id: `r${i}`, session: "orig", ts: isoDaysAgo(40) });
		writeFileSync(orig, a);
		writeFileSync(
			fork,
			a + claudeMsg({ id: "f1", session: "fork", ts: isoDaysAgo(39) }),
		);
		age(orig, 40);
		age(fork, 20);
		const state = emptyUsageState();
		const hub = maxHub();
		let scans = 0;
		for (;;) {
			const r = scan(root, null, state, { perFileMax: 2000, totalMax: 2000 });
			await sendUsage(sendCfg, state, hub.fetchImpl);
			scans++;
			if (r.backfilled) break;
		}
		expect(scans).toBeGreaterThan(2);
		expect(hub.total()[4]).toBe(21);
	});

	test("after the backfill, lines dated before the cutoff are not counted (a late replay of an old message)", async () => {
		const root = tmp("bf-late");
		mkdirSync(join(root, "p"), { recursive: true });
		const state = emptyUsageState();
		scan(root, null, state);
		expect(state.backfill.done).not.toBeNull();
		writeFileSync(
			join(root, "p", "late.jsonl"),
			claudeMsg({ id: "x1", session: "late", ts: isoDaysAgo(KEEP_DAYS + 3) }) +
				claudeMsg({ id: "x2", session: "late" }),
		);
		scan(root, null, state);
		expect(usageRows(state, ["claude:late"]).map((r) => r.day)).toEqual([
			"2026-11-13",
		]);
	});

	test("a state written before U4 (no backfill mark) keeps its limits and reads every file again", () => {
		const home = tmp("bf-old-state");
		const p = join(home, "s.json");
		writeFileSync(
			p,
			JSON.stringify({
				v: 1,
				files: {
					"/x.jsonl": {
						tool: "claude",
						ino: 1,
						offset: 999,
						session: "claude:x",
						project: null,
						model: null,
						last_id: null,
						totals: { "2026-11-13|m": [1, 1, 1, 1, 1] },
						mtime: 0,
					},
				},
				dirty: ["claude:x"],
				limits: {
					"codex|codex|10080": {
						tool: "codex",
						limit_id: "codex",
						window_minutes: 10080,
						used_percent: 4,
						resets_at: null,
						plan_type: null,
						observed_at: "2026-11-13T08:00:00.000Z",
					},
				},
				seen: { abc: "def|2026-11-13" },
			}),
		);
		const s = loadUsageState(p);
		expect(s.files).toEqual({});
		expect(s.dirty).toEqual([]);
		expect(s.seen).toEqual({});
		expect(Object.keys(s.limits)).toEqual(["codex|codex|10080"]);
		expect(s.backfill).toEqual({
			v: USAGE_BACKFILL_VERSION,
			done: null,
			files: 0,
			cut: 0,
		});
		const other = JSON.parse(readFileSync(p, "utf8"));
		other.backfill = {
			v: USAGE_BACKFILL_VERSION + 1,
			done: "2026-11-13T08:00:00.000Z",
			files: 1,
			cut: 0,
		};
		writeFileSync(p, JSON.stringify(other));
		expect(loadUsageState(p).backfill.done).toBeNull(); // another version → runs again
	});

	test("the poller logs the end of the backfill once, with counts only", async () => {
		const root = tmp("bf-log");
		const home = tmp("bf-log-home");
		mkdirSync(join(root, "p"), { recursive: true });
		const f = join(root, "p", "q.jsonl");
		writeFileSync(f, claudeMsg({ id: "1", session: "q", ts: isoDaysAgo(20) }));
		age(f, 20);
		const conf = {
			hubUrl: "http://hub.test",
			ingestToken: "t",
			machine: "cockpit",
			home,
			codex: { sessionsDir: join(home, "none") },
			usage: { enabled: true, claudeProjectsDir: root },
		} as unknown as CollectorConfig;
		const logs: string[] = [];
		const poll = createUsagePoll({
			cfg: conf,
			deps,
			fetchImpl: maxHub().fetchImpl,
			now: () => NOW,
			log: (l) => logs.push(l),
		});
		await poll();
		await poll();
		expect(logs.filter((l) => l.includes("backfill"))).toEqual([
			"[usage] backfill done: 1 files",
		]);
		const saved = JSON.parse(
			readFileSync(join(home, "usage-offsets.json"), "utf8"),
		);
		expect(saved.backfill.done).toBe(new Date(NOW).toISOString());
		expect(statSync(join(home, "usage-offsets.json")).size).toBeLessThan(
			10_000,
		);
	});
});
