// Collector tests. All fixtures are synthesized (no real Codex/Claude transcripts); fake secrets are
// assembled at runtime so scripts/check-secrets.ts stays clean.
import { describe, expect, test } from "bun:test";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IngestEvent } from "@agent-city/schema/core";
import { type MapContext, mapClaudeHook } from "./claude-map.ts";
import { type CodexFileContext, mapCodexLine } from "./codex-map.ts";
import { pollOnce, type TailState } from "./codex-tail.ts";
import { loadConfig, parseEnvFile } from "./config.ts";
import { gitInfo, originUrlFromConfig } from "./git-info.ts";
import { mergeHooks } from "./install-hooks.ts";
import { deliver, type PostResult, Spool, type Transport } from "./spool.ts";

const FAKE = `ghp_${"k".repeat(36)}`;
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `agentcity-${p}-`));
const git = (cwd: string, ...args: string[]) => {
	const p = Bun.spawnSync(
		[
			"git",
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@example.invalid",
			"-c",
			"init.defaultBranch=main",
			...args,
		],
		{ cwd, stdout: "ignore", stderr: "pipe" },
	);
	if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
};

// ── config ─────────────────────────────────────────────────────────────────

describe("config", () => {
	test("parseEnvFile keeps only requested keys; handles quotes, export, comments", () => {
		const text = [
			"# comment",
			`GITHUB_TOKEN=${FAKE}`,
			'HUB_URL="http://127.0.0.1:9999"',
			"export INGEST_TOKEN='abc def'",
			"AGENTCITY_MACHINE=forge # trailing comment",
		].join("\n");
		expect(
			parseEnvFile(text, ["HUB_URL", "INGEST_TOKEN", "AGENTCITY_MACHINE"]),
		).toEqual({
			HUB_URL: "http://127.0.0.1:9999",
			INGEST_TOKEN: "abc def",
			AGENTCITY_MACHINE: "forge",
		});
	});

	test("process env wins over the checkout .env; GITHUB_TOKEN is never loaded", () => {
		const dir = tmp("cfg");
		const envPath = join(dir, ".env");
		writeFileSync(
			envPath,
			`GITHUB_TOKEN=${FAKE}\nHUB_URL=http://file:1/\nINGEST_TOKEN=from-file\n`,
		);
		const cfg = loadConfig({ INGEST_TOKEN: "from-env" }, envPath);
		expect(cfg.hubUrl).toBe("http://file:1");
		expect(cfg.ingestToken).toBe("from-env");
		expect(cfg.machine).toBe("cockpit");
		expect(JSON.stringify(cfg)).not.toContain(FAKE);
	});
});

// ── git-info ───────────────────────────────────────────────────────────────

describe("gitInfo (reads .git files, no spawn)", () => {
	test("normal repo from a subdir, worktree, credentials, no origin, detached, non-repo", () => {
		const root = tmp("git");
		const a = join(root, "alpha");
		mkdirSync(join(a, "src", "deep"), { recursive: true });
		git(a, "init", "-q");
		git(
			a,
			"remote",
			"add",
			"origin",
			`https://someone:${"p".repeat(12)}@github.com/octo-example/alpha.git`,
		);
		git(a, "commit", "-q", "--allow-empty", "-m", "init");
		git(a, "worktree", "add", "-q", join(root, "alpha-wt"), "-b", "feature");

		expect(gitInfo(join(a, "src", "deep"))).toEqual({
			toplevel: a,
			repo_id: "octo-example/alpha",
			branch: "main",
		});
		expect(gitInfo(join(root, "alpha-wt"))).toEqual({
			toplevel: join(root, "alpha-wt"),
			repo_id: "octo-example/alpha",
			branch: "feature",
		});
		expect(JSON.stringify(gitInfo(a))).not.toContain("p".repeat(12));

		const b = join(root, "scratch");
		mkdirSync(b);
		git(b, "init", "-q");
		expect(gitInfo(b)).toMatchObject({
			repo_id: "local/scratch",
			branch: "main",
		});

		git(a, "checkout", "-q", "--detach");
		expect(gitInfo(a)?.branch).toBeNull();

		expect(gitInfo(tmp("norepo"))).toBeNull();
	});

	test('originUrlFromConfig only reads [remote "origin"]', () => {
		const cfg = [
			'[remote "upstream"]',
			"\turl = git@github.com:someone/else.git",
			'[remote "origin"]',
			"\tfetch = +refs/heads/*:refs/remotes/origin/*",
			"\turl = git@github.com:octo-example/alpha.git",
		].join("\n");
		expect(originUrlFromConfig(cfg)).toBe(
			"git@github.com:octo-example/alpha.git",
		);
		expect(originUrlFromConfig('[remote "upstream"]\n url = x')).toBeNull();
	});
});

// ── Claude hook mapping ────────────────────────────────────────────────────

const ctx: MapContext = {
	machine: "cockpit",
	hostname: "host-1",
	now: () => new Date("2026-06-01T00:00:00.000Z"),
	newId: () => "fixed-id",
	git: () => ({
		toplevel: "/w/alpha",
		repo_id: "octo-example/alpha",
		branch: "main",
	}),
};
const base = {
	session_id: "s1",
	cwd: "/w/alpha",
	transcript_path: "/tmp/t.jsonl",
	permission_mode: "default",
};
const map = (extra: Record<string, unknown>) =>
	mapClaudeHook({ ...base, ...extra }, ctx) as IngestEvent;

describe("mapClaudeHook", () => {
	test("common fields + repo from cwd", () => {
		const e = map({
			hook_event_name: "SessionStart",
			source: "startup",
			model: "m1",
		});
		expect(e).toMatchObject({
			id: "cc:fixed-id",
			ts: "2026-06-01T00:00:00.000Z",
			machine_id: "cockpit",
			session_id: "s1",
			provider: "claude",
			type: "SessionStart",
			repo_id: "octo-example/alpha",
			branch: "main",
			cwd: "/w/alpha",
			model: "m1",
			hostname: "host-1",
			summary: "session start (startup)",
		});
	});

	test("UserPromptSubmit stores only the prompt length", () => {
		const prompt = `secret plan ${FAKE} PROMPT-MARKER`;
		const e = map({ hook_event_name: "UserPromptSubmit", prompt });
		expect(e.summary).toBe(`prompt (${prompt.length} chars)`);
		expect(e.payload_redacted.prompt_length).toBe(prompt.length);
		expect(JSON.stringify(e)).not.toContain("PROMPT-MARKER");
	});

	test("tool events: whitelist only, command redacted + 80 chars, id from tool_use_id", () => {
		const bash = map({
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_use_id: "tu1",
			tool_input: {
				command: `GITHUB_TOKEN=${FAKE} ${"x".repeat(200)}`,
				description: "DESC-MARKER",
			},
		});
		expect(bash.id).toBe("cc:s1:PreToolUse:tu1");
		expect(bash.tool).toBe("Bash");
		expect(JSON.stringify(bash)).not.toContain(FAKE);
		expect(JSON.stringify(bash)).not.toContain("DESC-MARKER");
		expect(
			(bash.payload_redacted.tool as { command: string }).command.length,
		).toBeLessThanOrEqual(80);

		const write = map({
			hook_event_name: "PreToolUse",
			tool_name: "Write",
			tool_use_id: "tu2",
			tool_input: { file_path: "/w/alpha/a.ts", content: "CONTENT-MARKER" },
		});
		expect(write.summary).toBe("Write /w/alpha/a.ts");
		expect(JSON.stringify(write)).not.toContain("CONTENT-MARKER");

		const post = map({
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_use_id: "tu1",
			tool_input: { command: "ls" },
			tool_response: { stdout: "RESPONSE-MARKER" },
		});
		expect(post.id).toBe("cc:s1:PostToolUse:tu1");
		expect(JSON.stringify(post)).not.toContain("RESPONSE-MARKER");
	});

	test.each(["Task", "Agent"])(
		"%s call: Pre creates the subagent, Post ends it (label only from Pre)",
		(tool) => {
			const pre = map({
				hook_event_name: "PreToolUse",
				tool_name: tool,
				tool_use_id: "tu9",
				tool_input: {
					subagent_type: "Explore",
					description: "find x",
					prompt: "SUB-PROMPT-MARKER",
				},
			});
			expect(pre).toMatchObject({
				agent_id: "sub:tu9",
				parent_agent_id: "s1",
				agent_kind: "subagent",
				agent_label: "Explore",
				summary: `${tool} → Explore: find x`,
			});
			expect(JSON.stringify(pre)).not.toContain("SUB-PROMPT-MARKER");

			const post = map({
				hook_event_name: "PostToolUse",
				tool_name: tool,
				tool_use_id: "tu9",
				tool_input: {},
				tool_response: "SUB-RESULT-MARKER",
			});
			expect(post).toMatchObject({
				agent_id: "sub:tu9",
				agent_label: null,
				type: "PostToolUse",
				tool,
			});
			expect(JSON.stringify(post)).not.toContain("SUB-RESULT-MARKER");
		},
	);

	test("SubagentStop / Stop are session-level (Claude's internal agent id kept as data only)", () => {
		const e = map({
			hook_event_name: "SubagentStop",
			agent_id: "internal-1",
			agent_type: "Explore",
		});
		expect(e.agent_id).toBeNull();
		expect(e.payload_redacted.claude_agent_id).toBe("internal-1");
		expect(map({ hook_event_name: "Stop" }).summary).toBe("stop");
	});

	test("Notification message is redacted and clipped; SessionEnd keeps the reason", () => {
		const n = map({
			hook_event_name: "Notification",
			message: `token ${FAKE} ${"m".repeat(300)}`,
		});
		expect(JSON.stringify(n)).not.toContain(FAKE);
		expect((n.payload_redacted.message as string).length).toBeLessThanOrEqual(
			201,
		);
		expect(
			map({ hook_event_name: "SessionEnd", reason: "logout" }).summary,
		).toBe("session end (logout)");
	});

	test("unusable input → null", () => {
		expect(mapClaudeHook(null, ctx)).toBeNull();
		expect(mapClaudeHook("x", ctx)).toBeNull();
		expect(mapClaudeHook({ hook_event_name: "Stop" }, ctx)).toBeNull();
	});
});

// ── spool / delivery ───────────────────────────────────────────────────────

// Fresh timestamps: the spool drops events older than SPOOL_MAX_AGE_DAYS at flush time.
const ev = (id: string, ts = new Date().toISOString()): IngestEvent => ({
	id,
	ts,
	machine_id: "cockpit",
	session_id: "s1",
	agent_id: null,
	provider: "claude",
	type: "PreToolUse",
	tool: null,
	summary: null,
	repo_id: null,
	payload_redacted: {},
});

function fakeTransport(
	script: (batch: readonly IngestEvent[], call: number) => PostResult,
) {
	const received: string[][] = [];
	const t: Transport = {
		async post(events) {
			received.push(events.map((e) => e.id));
			return script(events, received.length);
		},
	};
	return { t, received };
}

describe("spool", () => {
	test("hub down → spooled; hub back → flushed in order, spool empty", async () => {
		const spool = new Spool(tmp("spool"));
		let up = false;
		const { t, received } = fakeTransport(() => (up ? "ok" : "failed"));

		expect(await deliver([ev("a")], spool, t)).toBe("spooled");
		expect(await deliver([ev("b")], spool, t)).toBe("spooled");
		expect(spool.pending()).toBe(true);

		up = true;
		expect(await deliver([ev("c")], spool, t)).toBe("sent");
		// each delivery claims its own spool file; recovery sends them oldest-first
		expect(received.slice(-3).flat()).toEqual(["a", "b", "c"]);
		expect(spool.pending()).toBe(false);
	});

	test("partial failure removes only what was delivered", async () => {
		const dir = tmp("spool-partial");
		const spool = new Spool(dir);
		spool.append(Array.from({ length: 1200 }, (_, i) => ev(`e${i}`))); // 3 chunks of ≤500
		const { t } = fakeTransport((_b, call) => (call === 2 ? "failed" : "ok"));
		expect(await spool.flush(t)).toMatchObject({ sent: 500, remaining: true });

		const left = readdirSync(dir)
			.filter((f) => f.endsWith(".flushing"))
			.flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n"));
		expect(left).toHaveLength(700);
		expect(JSON.parse(left[0] ?? "{}").id).toBe("e500");

		const again = fakeTransport(() => "ok");
		expect(await spool.flush(again.t)).toMatchObject({
			sent: 700,
			remaining: false,
		});
		expect(again.received.flat()[0]).toBe("e500");
	});

	test("rejected (4xx) batches are parked, not retried forever", async () => {
		const spool = new Spool(tmp("spool-rej"));
		spool.append([ev("bad")]);
		const { t } = fakeTransport(() => "rejected");
		expect(await spool.flush(t)).toMatchObject({
			rejected: 1,
			remaining: false,
		});
		expect(readFileSync(spool.rejectedFile, "utf8")).toContain('"bad"');
	});

	test("leftover .flushing from a killed flusher is sent first", async () => {
		const dir = tmp("spool-left");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "spool.1000.99.abc.flushing"),
			`${JSON.stringify(ev("old"))}\n`,
		);
		const spool = new Spool(dir);
		spool.append([ev("new")]);
		const { t, received } = fakeTransport(() => "ok");
		await spool.flush(t);
		expect(received.flat()).toEqual(["old", "new"]);
		expect(readdirSync(dir).filter((f) => f.startsWith("spool."))).toEqual([]);
	});

	test("empty spool → direct POST, nothing written", async () => {
		const dir = tmp("spool-direct");
		const { t, received } = fakeTransport(() => "ok");
		expect(await deliver([ev("x")], new Spool(dir), t)).toBe("sent");
		expect(received).toEqual([["x"]]);
		expect(existsSync(join(dir, "spool.jsonl"))).toBe(false);
	});
});

// ── Codex mapping (synthesized records in the observed format) ─────────────

const deps = {
	machine: "cockpit",
	hostname: "host-1",
	git: () => ({
		toplevel: "/w/beta",
		repo_id: "octo-example/beta",
		branch: "dev",
	}),
};
const rec = (
	type: string,
	payload: Record<string, unknown>,
	ts = "2026-06-01T00:00:00.000Z",
) => JSON.stringify({ timestamp: ts, type, payload });
const META = rec("session_meta", {
	session_id: "cx-1",
	cwd: "/w/beta",
	cli_version: "0.0.0-test",
	originator: "codex_cli",
	git: { repository_url: "https://github.com/octo-example/beta.git" },
});

describe("mapCodexLine", () => {
	const fresh = (): CodexFileContext => ({ session: null, calls: new Map() });

	test("full turn: meta → context → prompt → tool pre/post → complete", () => {
		const c = fresh();
		const lines = [
			META,
			rec("turn_context", {
				cwd: "/w/beta",
				model: "gpt-test",
				approval_policy: "never",
			}),
			rec("event_msg", {
				type: "item_completed",
				item: {
					type: "UserMessage",
					content: [{ type: "text", text: "PROMPT-MARKER hello" }],
				},
			}),
			rec("response_item", {
				type: "function_call",
				name: "exec_command",
				call_id: "c1",
				arguments: JSON.stringify({ cmd: `GITHUB_TOKEN=${FAKE} ls -la` }),
			}),
			rec("response_item", {
				type: "function_call_output",
				call_id: "c1",
				output: "OUTPUT-MARKER",
			}),
			rec("response_item", {
				type: "custom_tool_call",
				name: "apply_patch",
				call_id: "c2",
				input:
					"*** Begin Patch\n*** Update File: src/a.ts\n+PATCH-CONTENT-MARKER\n*** End Patch",
			}),
			rec("response_item", {
				type: "custom_tool_call_output",
				call_id: "c2",
				output: [],
			}),
			rec("event_msg", {
				type: "task_complete",
				duration_ms: 1234,
				last_agent_message: "AGENT-MESSAGE-MARKER",
			}),
		];
		const events = lines
			.map((l, i) => mapCodexLine(l, i * 100, c, deps))
			.filter((e) => e !== null);
		expect(events.map((e) => [e.type, e.tool])).toEqual([
			["SessionStart", null],
			["codex.turn_context", null],
			["UserPromptSubmit", null],
			["PreToolUse", "exec_command"],
			["PostToolUse", "exec_command"],
			["PreToolUse", "apply_patch"],
			["PostToolUse", "apply_patch"],
			["Stop", null],
		]);
		expect(events[0]).toMatchObject({
			id: "codex:cx-1:0",
			session_id: "cx-1",
			provider: "codex",
			repo_id: "octo-example/beta",
			branch: "dev",
		});
		expect(events[2]?.summary).toBe("prompt (19 chars)");
		expect(events[3]?.summary).toBe(
			"exec_command: GITHUB_TOKEN=[REDACTED] ls -la",
		);
		expect(events[3]?.model).toBe("gpt-test");
		expect(events[5]?.summary).toBe("apply_patch src/a.ts");
		const all = JSON.stringify(events);
		for (const m of [
			"PROMPT-MARKER",
			"OUTPUT-MARKER",
			"PATCH-CONTENT-MARKER",
			"AGENT-MESSAGE-MARKER",
			FAKE,
		]) {
			expect(all).not.toContain(m);
		}
	});

	test("command given as an argv array; exec code is clipped", () => {
		const c = fresh();
		mapCodexLine(META, 0, c, deps);
		const a = mapCodexLine(
			rec("response_item", {
				type: "function_call",
				name: "shell",
				call_id: "x",
				arguments: JSON.stringify({ command: ["git", "status"] }),
			}),
			1,
			c,
			deps,
		);
		expect(a?.summary).toBe("shell: git status");
		const b = mapCodexLine(
			rec("response_item", {
				type: "custom_tool_call",
				name: "exec",
				call_id: "y",
				input: "y".repeat(500),
			}),
			2,
			c,
			deps,
		);
		expect(b?.summary?.length).toBeLessThanOrEqual("exec: ".length + 80);
	});

	test("ignored noise → null; unknown record → type only; junk never throws", () => {
		const c = fresh();
		mapCodexLine(META, 0, c, deps);
		for (const [type, p] of [
			["event_msg", { type: "token_count", info: {} }],
			["response_item", { type: "reasoning", encrypted_content: "x" }],
			["response_item", { type: "message", role: "assistant", content: [] }],
			["token_usage_record", { usage: { input_tokens: 1 } }],
			["world_state", { full: true }],
			["event_msg", { type: "item_completed", item: { type: "AgentMessage" } }],
		] as const) {
			expect(mapCodexLine(rec(type, p), 5, c, deps)).toBeNull();
		}
		const unknown = mapCodexLine(
			rec("brand_new_thing", { type: "sub", secret_stuff: "UNKNOWN-MARKER" }),
			7,
			c,
			deps,
		);
		expect(unknown).toMatchObject({
			type: "codex.brand_new_thing/sub",
			summary: null,
			payload_redacted: { record: "brand_new_thing/sub" },
		});
		expect(JSON.stringify(unknown)).not.toContain("UNKNOWN-MARKER");

		for (const junk of ["{not json", "[]", "null", '"str"', ""]) {
			expect(mapCodexLine(junk, 9, c, deps)).toBeNull();
		}
	});

	test("records before session_meta are dropped", () => {
		expect(
			mapCodexLine(
				rec("event_msg", { type: "task_complete" }),
				0,
				fresh(),
				deps,
			),
		).toBeNull();
	});
});

// ── Codex tail (offsets) ───────────────────────────────────────────────────

describe("pollOnce", () => {
	const setup = () => {
		const root = tmp("codex");
		const day = join(root, "2026", "06", "01");
		mkdirSync(day, { recursive: true });
		return { root, file: join(day, "rollout-test.jsonl") };
	};
	const opts = (root: string, state: TailState, backfillMs = 3_600_000) => ({
		root,
		state,
		now: Date.now(),
		backfillMs,
		deps,
	});
	const turn = rec("event_msg", { type: "task_complete" });

	test("partial trailing line waits; committed state survives a restart → no duplicates", () => {
		const { root, file } = setup();
		writeFileSync(file, `${META}\n${turn}\n${turn.slice(0, 10)}`);
		const state: TailState = { files: {} };
		const first = pollOnce(opts(root, state));
		expect(first.map((e) => e.type)).toEqual(["SessionStart", "Stop"]);
		first.commit();

		appendFileSync(file, `${turn.slice(10)}\n`);
		const restarted: TailState = JSON.parse(JSON.stringify(state)); // as if loaded from disk
		const next = pollOnce(opts(root, restarted));
		expect(next.map((e) => e.type)).toEqual(["Stop"]);
		expect(next[0]?.session_id).toBe("cx-1"); // session context survived the restart
		next.commit();
		expect(pollOnce(opts(root, restarted))).toHaveLength(0);
	});

	test("F06: without commit (delivery failed) the same lines are read again; commit is not serialized", () => {
		const { root, file } = setup();
		writeFileSync(file, `${META}\n${turn}\n`);
		const state: TailState = { files: {} };
		const a = pollOnce(opts(root, state));
		expect(state.files).toEqual({}); // nothing committed yet
		const b = pollOnce(opts(root, state));
		expect(b.map((e) => e.id)).toEqual(a.map((e) => e.id)); // same deterministic ids
		b.commit();
		expect(Object.values(state.files)[0]?.offset).toBeGreaterThan(0);
		expect(JSON.stringify(state)).not.toContain("commit");
		expect(pollOnce(opts(root, state))).toHaveLength(0);
	});

	test("F11: call_id → tool survives across polls", () => {
		const { root, file } = setup();
		const call = rec("response_item", {
			type: "function_call",
			name: "exec_command",
			call_id: "c9",
			arguments: JSON.stringify({ cmd: "true" }),
		});
		writeFileSync(file, `${META}\n${call}\n`);
		const state: TailState = { files: {} };
		pollOnce(opts(root, state)).commit();
		appendFileSync(
			file,
			`${rec("response_item", { type: "function_call_output", call_id: "c9", output: "x" })}\n`,
		);
		const post = pollOnce(opts(root, state));
		expect(post.map((e) => [e.type, e.tool])).toEqual([
			["PostToolUse", "exec_command"],
		]);
	});

	test("truncated file starts over", () => {
		const { root, file } = setup();
		writeFileSync(file, `${META}\n${turn}\n${turn}\n`);
		const state: TailState = { files: {} };
		pollOnce(opts(root, state)).commit();
		truncateSync(file, 0);
		writeFileSync(file, `${META}\n`);
		expect(pollOnce(opts(root, state)).map((e) => e.type)).toEqual([
			"SessionStart",
		]);
	});

	test("old file: session learned from line 1, history skipped, new lines tailed", () => {
		const { root, file } = setup();
		writeFileSync(file, `${META}\n${turn}\n${turn}\n`);
		const state: TailState = { files: {} };
		const skipped = pollOnce(opts(root, state, -1));
		expect(skipped).toHaveLength(0); // everything counts as old
		skipped.commit();
		appendFileSync(file, `${turn}\n`);
		const e = pollOnce(opts(root, state, -1));
		expect(e.map((x) => [x.type, x.session_id])).toEqual([["Stop", "cx-1"]]);
	});
});

// ── settings merge ─────────────────────────────────────────────────────────

describe("mergeHooks", () => {
	const CMD = "/abs/agent-city/apps/collector/bin/claude-hook";
	const existing = {
		theme: "dark",
		hooks: {
			PreToolUse: [
				{
					matcher: "*",
					hooks: [{ type: "command", command: "other-tool", timeout: 10 }],
				},
			],
			StopFailure: [{ hooks: [{ type: "command", command: "other-tool" }] }],
		},
	};

	test("appends to all 8 events, keeps existing hooks and keys untouched", () => {
		const { merged, added } = mergeHooks(existing, CMD);
		expect(added).toHaveLength(8);
		expect(merged.theme).toBe("dark");
		expect(merged.hooks?.PreToolUse).toEqual([
			existing.hooks.PreToolUse[0] as object,
			{
				matcher: "*",
				hooks: [{ type: "command", async: true, timeout: 2, command: CMD }],
			},
		]);
		expect(merged.hooks?.StopFailure).toEqual(existing.hooks.StopFailure);
		expect(merged.hooks?.SessionStart).toEqual([
			{ hooks: [{ type: "command", async: true, timeout: 2, command: CMD }] },
		]);
		expect(existing.hooks.PreToolUse).toHaveLength(1); // input not mutated
	});

	test("idempotent", () => {
		const once = mergeHooks(existing, CMD).merged;
		const twice = mergeHooks(once, CMD);
		expect(twice.added).toEqual([]);
		expect(twice.merged).toEqual(once);
	});
});
