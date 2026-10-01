// Disposable fixtures for managed-run tests and the deterministic demo: a throwaway git repository,
// a config pointing at it, and generated stub executables. Nothing here touches a real project, a
// real provider CLI or a model. Everything lives under one mkdtemp directory.
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.ts";
import { type ManagedConfig, parseManagedConfig } from "./config.ts";

export const GIT = Bun.which("git") ?? "/usr/bin/git";

const GIT_ENV = {
	PATH: "/usr/bin:/bin",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_TERMINAL_PROMPT: "0",
};

/** Run git in a fixture repo (fixed identity, no user config, no hooks). Throws on failure. */
export function fixtureGit(cwd: string, ...args: string[]): string {
	const r = spawnSync(
		GIT,
		[
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@localhost",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"commit.gpgsign=false",
			...args,
		],
		{ cwd, env: GIT_ENV, encoding: "utf8" },
	);
	if (r.status !== 0)
		throw new Error(`fixture git ${args[0]} failed: ${r.stderr}`);
	return r.stdout.trim();
}

/** Passes only when the simulated implementer wrote `pass` (root scope or `src` scope). */
const VERIFY_SH = `#!/bin/sh
grep -qs '^pass$' agentcity-sim/verify.status src/agentcity-sim/verify.status || exit 1
`;

/** Create a tiny git repository (README, src/app.txt, verify.sh) at `repoPath`; returns its HEAD. */
export function initFixtureRepo(repoPath: string): string {
	mkdirSync(join(repoPath, "src"), { recursive: true });
	writeFileSync(join(repoPath, "README.md"), "# fixture\n");
	writeFileSync(join(repoPath, "src", "app.txt"), "v1\n");
	writeFileSync(join(repoPath, "verify.sh"), VERIFY_SH);
	fixtureGit(repoPath, "init", "--quiet", "-b", "main");
	fixtureGit(repoPath, "add", "-A");
	fixtureGit(repoPath, "commit", "--quiet", "-m", "fixture base");
	return fixtureGit(repoPath, "rev-parse", "HEAD");
}

export interface FixtureOptions {
	/** `status` (default): /bin/sh verify.sh. `none`: no verification configured. Or explicit argv lists. */
	verification?:
		| "status"
		| "none"
		| { name: string; argv: string[]; timeout_s?: number }[];
	live?: Record<string, unknown>;
	limits?: Record<string, unknown>;
	/** File-backed DB (restart tests). Default: in-memory. */
	dbFile?: boolean;
	/** Repo id in the generated config (default `local/fixture`). */
	repoId?: string;
	/** Enable live mode against generated stub `claude` / `codex` executables (never the real CLIs). */
	liveStubs?: { claudeTimeoutS?: number; codexTimeoutS?: number };
}

export interface Fixture {
	dir: string;
	repoPath: string;
	repoId: string;
	baseSha: string;
	config: ManagedConfig;
	db: Database;
	dbPath: string;
	cleanup(): void;
}

export function makeFixture(opts: FixtureOptions = {}): Fixture {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentcity-managed-")));
	const repoPath = join(dir, "repo");
	const baseSha = initFixtureRepo(repoPath);

	const verification =
		opts.verification === "none"
			? []
			: Array.isArray(opts.verification)
				? opts.verification
				: [
						{
							name: "fixture-check",
							argv: ["/bin/sh", "verify.sh"],
							timeout_s: 30,
						},
					];
	const repoId = opts.repoId ?? "local/fixture";
	const config = parseManagedConfig({
		workspace_root: join(dir, "workspaces"),
		artifacts_root: join(dir, "artifacts"),
		git_executable: GIT,
		repos: [{ id: repoId, path: repoPath, base_ref: "main", verification }],
		live: opts.liveStubs
			? {
					enabled: true,
					claude: {
						executable: writeStub(join(dir, "bin"), "claude", CLAUDE_STUB),
						model: "stub-model",
						timeout_s: opts.liveStubs.claudeTimeoutS ?? 30,
						// synthetic value printed by the stub; never a real CLI's
						allowed_auth_methods: ["stub-subscription"],
					},
					codex: {
						executable: writeStub(join(dir, "bin"), "codex", CODEX_STUB),
						model: "stub-review-model",
						timeout_s: opts.liveStubs.codexTimeoutS ?? 30,
						auth_status_pattern: "^Logged in using ChatGPT",
					},
				}
			: (opts.live ?? { enabled: false }),
		limits: { kill_grace_ms: 300, lease_ttl_ms: 3_000, ...opts.limits },
	});
	const dbPath = opts.dbFile ? join(dir, "hub.db") : ":memory:";
	const db = openDb(dbPath);
	return {
		dir,
		repoPath,
		repoId,
		baseSha,
		config,
		db,
		dbPath,
		cleanup() {
			try {
				db.close();
			} catch {
				// already closed
			}
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/**
 * Write an executable stub: `<dir>/<name>` runs `<dir>/<name>.ts` with this Bun. The script gets
 * the real argv; use it to stand in for a provider CLI (protocol fixtures, hangs, failures).
 */
export function writeStub(dir: string, name: string, script: string): string {
	mkdirSync(dir, { recursive: true });
	const scriptPath = join(dir, `${name}.ts`);
	const exe = join(dir, name);
	writeFileSync(scriptPath, script);
	writeFileSync(
		exe,
		`#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
	);
	chmodSync(exe, 0o755);
	return exe;
}

// ── stub provider CLIs ───────────────────────────────────────────────────────
// Behaviour is chosen by `<bin>/<name>.mode`; every invocation is appended to
// `<bin>/<name>.calls.jsonl` (argv, stdin, env variable NAMES, cwd).

const STUB_PRELUDE = `
import { spawn as spawnChild } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = import.meta.dir;
const args = process.argv.slice(2);
const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").trim() : "");
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\\n");
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const hang = async (ignoreTerm: boolean) => {
	if (ignoreTerm) process.on("SIGTERM", () => {});
	const child = Bun.spawn(["/bin/sleep", "600"]);
	writeFileSync(join(dir, NAME + ".pids"), process.pid + " " + child.pid);
	await new Promise(() => setInterval(() => {}, 1000));
};
// mode "escape_<stage>" (version | help | auth): this preflight call exits 0 but leaves a descendant
// outside its process group holding stdout/stderr open
const escapeAt = (stage: string) => {
	if (mode !== "escape_" + stage) return;
	const c = spawnChild("/bin/sleep", ["600"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
	c.unref();
	writeFileSync(join(dir, NAME + ".pids"), process.pid + " " + c.pid);
};
`;

const CLAUDE_STUB = `const NAME = "claude";${STUB_PRELUDE}
const mode = read("claude.mode") || "success";
const stdin = args.includes("-p") ? await Bun.stdin.text() : "";
appendFileSync(join(dir, "claude.calls.jsonl"), JSON.stringify({ argv: args, stdin, env: Object.keys(process.env).sort(), cwd: process.cwd() }) + "\\n");
if (args[0] === "--version") { escapeAt("version"); console.log("9.9.9 (stub claude)"); process.exit(0); }
if (args[0] === "--help") {
	escapeAt("help");
	const flags = ["-p, --print", "--output-format <format>", "--verbose", "--model <model>", "--permission-mode <mode>", "--permission-prompts <target>", "--tools <tools...>", "--allowedTools, --allowed-tools <tools...>", "--json-schema <schema>", "--session-id <uuid>", "-r, --resume [value]", "--safe-mode", "--restricted", "--strict-mcp-config", "--disable-slash-commands"];
	console.log("Usage: claude [options]\\n" + flags.filter((f) => mode !== "no_safe_mode" || f !== "--safe-mode").map((f) => "  " + f + "   (stub)").join("\\n"));
	process.exit(0);
}
if (args[0] === "auth") {
	escapeAt("auth");
	if (mode === "malformed_status") { console.log("Logged in, probably"); process.exit(0); }
	if (mode === "empty_status") { console.log("{}"); process.exit(0); }
	const method = mode === "api_key_auth" ? "stub-api-key" : "stub-subscription";
	console.log(JSON.stringify({ loggedIn: mode !== "logged_out", authMethod: method, subscriptionType: "stub", email: "stub@example.invalid" }, null, 2));
	process.exit(mode === "logged_out" ? 1 : 0);
}
const session = flag("--session-id") ?? flag("--resume") ?? "none";
const init = JSON.stringify({ type: "system", subtype: "init", session_id: session, ...(mode === "no_model" ? {} : { model: "stub-model-resolved" }) });
const result = (extra: object) => out({ type: "result", session_id: session, usage: { input_tokens: 12, output_tokens: 34 }, total_cost_usd: 0, num_turns: 1, ...extra });
const edit = () => {
	mkdirSync("agentcity-sim", { recursive: true });
	writeFileSync("agentcity-sim/verify.status", "pass\\n");
	appendFileSync("live-change.md", "change by stub claude (" + (args.includes("--resume") ? "resume" : "new") + ")\\n");
};
switch (mode) {
	case "nonzero":
		console.error("stub claude: boom");
		process.exit(3);
	case "auth_error":
		out(JSON.parse(init));
		result({ subtype: "error_during_execution", is_error: true, result: "Not logged in · Please run /login" });
		process.exit(1);
	case "quota_error":
		out(JSON.parse(init));
		out({ type: "system", subtype: "api_retry", error: "rate_limit", attempt: 1 });
		result({ subtype: "error_during_execution", is_error: true, result: "You have hit your usage limit" });
		process.exit(1);
	case "model_error":
		out(JSON.parse(init));
		out({ type: "system", subtype: "api_retry", error: "model_not_found", attempt: 1 });
		result({ subtype: "error_during_execution", is_error: true, result: "model unavailable" });
		process.exit(1);
	case "invalid":
		process.stdout.write("this is not json\\n{\\"type\\": \\"broken\\n");
		process.exit(0);
	case "hang":
		await hang(false);
		break;
	case "escape": {
		// a descendant that leaves the process group but keeps our stdout/stderr open
		const { spawn } = await import("node:child_process");
		const c = spawn("/bin/sleep", ["600"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
		c.unref();
		writeFileSync(join(dir, NAME + ".pids"), process.pid + " " + c.pid);
		out(JSON.parse(init));
		edit();
		result({ subtype: "success", is_error: false, result: "done", structured_output: { contract: "agentcity.implementation/v1", status: "completed", summary: "escaped" } });
		process.exit(0);
	}
	case "hang_ignore_term":
		await hang(true);
		break;
	case "big": {
		out(JSON.parse(init));
		const junk = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(4000) }] } });
		for (let i = 0; i < 300; i++) process.stdout.write(junk + "\\n");
		edit();
		result({ subtype: "success", is_error: false, result: "done", structured_output: { contract: "agentcity.implementation/v1", status: "completed", summary: "big run" } });
		break;
	}
	case "blocked":
		out(JSON.parse(init));
		result({ subtype: "success", is_error: false, result: "", structured_output: { contract: "agentcity.implementation/v1", status: "blocked", summary: "cannot do it" } });
		break;
	case "wrong_schema":
		out(JSON.parse(init));
		edit();
		result({ subtype: "success", is_error: false, result: '{"status":"completed"}', structured_output: { contract: "agentcity.implementation/v1", status: "done", summary: 7 } });
		break;
	case "empty_success":
		out(JSON.parse(init));
		edit();
		result({ subtype: "success", is_error: false, result: "" });
		break;
	case "blocked_text":
		out(JSON.parse(init));
		result({ subtype: "success", is_error: false, result: "blocked: I cannot do this" });
		break;
	case "plain_text":
		out(JSON.parse(init));
		edit();
		result({ subtype: "success", is_error: false, result: "I made the change." });
		break;
	// writes the files named in <bin>/claude.payload.json ({ "rel/path": "content" }, built by a test)
	case "write_payload": {
		out(JSON.parse(init));
		const payload = JSON.parse(read("claude.payload.json") || "{}") as Record<string, string>;
		for (const [rel, content] of Object.entries(payload)) {
			mkdirSync(join(rel, ".."), { recursive: true });
			writeFileSync(rel, content);
		}
		result({ subtype: "success", is_error: false, result: "done", structured_output: { contract: "agentcity.implementation/v1", status: "completed", summary: "payload written" } });
		break;
	}
	// a lost or broken protocol record, then an apparently valid success
	case "oversized_then_success":
	case "oversized_error_then_success":
	case "malformed_then_success":
		out(JSON.parse(init));
		if (mode === "oversized_then_success")
			out({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(1_100_000) }] } });
		else if (mode === "oversized_error_then_success")
			result({ subtype: "error_during_execution", is_error: true, result: "e".repeat(1_100_000) });
		else process.stdout.write("this line is not a protocol record\\n");
		edit();
		result({ subtype: "success", is_error: false, result: "done", structured_output: { contract: "agentcity.implementation/v1", status: "completed", summary: "after a lost record" } });
		break;
	default: {
		// a line split across two writes, then stderr noise, a thinking block and a tool call
		process.stdout.write(init.slice(0, 20));
		await Bun.sleep(30);
		process.stdout.write(init.slice(20) + "\\n");
		console.error("stub claude: warning on stderr");
		out({ type: "assistant", message: { content: [{ type: "thinking", thinking: "PRIVATE-REASONING-MARKER" }, { type: "tool_use", name: "Edit", input: {} }] } });
		out({ type: "some_future_event", detail: 1 });
		edit();
		result({ subtype: "success", is_error: false, result: "done", modelUsage: { "stub-model-resolved": { inputTokens: 12 } }, structured_output: { contract: "agentcity.implementation/v1", status: "completed", summary: "Stub implementation complete." } });
	}
}
`;

const CODEX_STUB = `const NAME = "codex";${STUB_PRELUDE}
const mode = read("codex.mode") || "success";
const stdin = args[0] === "exec" ? await Bun.stdin.text() : "";
appendFileSync(join(dir, "codex.calls.jsonl"), JSON.stringify({ argv: args, stdin, env: Object.keys(process.env).sort(), cwd: process.cwd() }) + "\\n");
if (args[0] === "--version") { escapeAt("version"); console.log("codex-cli 0.0.0-stub"); process.exit(0); }
if (args[0] === "exec" && args[1] === "--help") {
	escapeAt("help");
	const flags = ["--json", "-s, --sandbox <MODE>", "-m, --model <MODEL>", "-C, --cd <DIR>", "--ignore-user-config", "--ignore-rules", "--output-schema <FILE>", "-o, --output-last-message <FILE>"];
	console.log("Usage: codex exec [OPTIONS] [PROMPT]\\n" + flags.filter((f) => mode !== "no_ignore_config" || f !== "--ignore-user-config").map((f) => "  " + f).join("\\n"));
	process.exit(0);
}
if (args[0] === "login") {
	escapeAt("auth");
	if (mode === "logged_out") process.exit(1);
	console.log(mode === "api_key_auth" ? "Logged in using an API key (stub)" : "Logged in using ChatGPT (stub)");
	process.exit(0);
}
const sha = /- commit: ([0-9a-f]{40})/.exec(stdin)?.[1] ?? "";
const manifest = /- evidence manifest: ([0-9a-f]{64})/.exec(stdin)?.[1] ?? "";
const outFile = flag("--output-last-message") ?? "";
const verdict = (approve: boolean) => JSON.stringify({
	contract: "agentcity.review/v1", audited_sha: sha, manifest_hash: manifest,
	verdict: approve ? "approve" : "reject",
	findings: approve ? [] : [{ severity: "major", title: "Stub reviewer finding", detail: "needs another pass", file: "live-change.md", line: 1, actionable: true }],
	tests_executed: false, summary: approve ? "Stub review: approved." : "Stub review: rejected.",
});
out({ type: "thread.started", thread_id: "thread-stub-0001" });
out({ type: "turn.started" });
switch (mode) {
	case "turn_failed":
		out({ type: "turn.failed", error: { message: "stream error: usage limit reached" } });
		process.exit(1);
	case "nonzero":
		console.error("stub codex: crashed");
		process.exit(2);
	case "hang":
		await hang(false);
		break;
	case "garbage":
		writeFileSync(outFile, "LGTM, ship it");
		out({ type: "item.completed", item: { type: "agent_message", text: "LGTM, ship it" } });
		break;
	case "no_message":
		break;
	case "mutate":
		writeFileSync("reviewer-edit.txt", "the reviewer wrote this\\n");
		writeFileSync(outFile, verdict(true));
		break;
	case "claims_tests":
		writeFileSync(outFile, JSON.stringify({ ...JSON.parse(verdict(true)), tests_executed: true }));
		break;
	case "reject":
		writeFileSync(outFile, verdict(false));
		break;
	case "reject_once":
		writeFileSync(outFile, verdict(existsSync(join(dir, "codex.rejected"))));
		writeFileSync(join(dir, "codex.rejected"), "1");
		break;
	// the last-message file is replaced by a FIFO nobody writes to; the stream still "approves"
	case "fifo_last_message":
		Bun.spawnSync(["/bin/rm", "-f", outFile]);
		Bun.spawnSync(["/usr/bin/mkfifo", outFile]);
		out({ type: "item.completed", item: { type: "agent_message", text: verdict(true) } });
		break;
	// an explicit failure that is lost (oversized) or a broken record, then a valid approval + exit 0
	case "oversized_failure":
	case "malformed_then_approve":
		if (mode === "oversized_failure")
			out({ type: "turn.failed", error: { message: "f".repeat(1_100_000) } });
		else process.stdout.write("{\\"type\\": \\"turn.failed\\", \\"error\\": \\n");
		out({ type: "item.completed", item: { type: "agent_message", text: verdict(true) } });
		writeFileSync(outFile, verdict(true));
		break;
	default:
		out({ type: "item.completed", item: { type: "reasoning", text: "PRIVATE-REASONING-MARKER" } });
		out({ type: "item.completed", item: { type: "agent_message", text: verdict(true) } });
		writeFileSync(outFile, verdict(true));
}
out({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } });
`;

export const stubDir = (fx: Fixture) => join(fx.dir, "bin");

export function setStubMode(
	fx: Fixture,
	name: "claude" | "codex",
	mode: string,
): void {
	writeFileSync(join(stubDir(fx), `${name}.mode`), mode);
}

export interface StubCall {
	argv: string[];
	stdin: string;
	env: string[];
	cwd: string;
}

export function stubCalls(fx: Fixture, name: "claude" | "codex"): StubCall[] {
	const file = join(stubDir(fx), `${name}.calls.jsonl`);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l) as StubCall);
}

/** `<leader pid> <grandchild pid>` written by a hanging stub; null until it has started. */
export function stubPids(
	fx: Fixture,
	name: "claude" | "codex",
): [number, number] | null {
	const file = join(stubDir(fx), `${name}.pids`);
	if (!existsSync(file)) return null;
	const [a, b] = readFileSync(file, "utf8").split(" ").map(Number);
	return a && b ? [a, b] : null;
}

export const pidAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
