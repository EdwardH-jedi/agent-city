// Real CLI adapters (Claude implement, Codex review) against generated STUB executables and
// protocol fixtures. No real `claude` / `codex` binary is started and no model is called; these
// tests prove process/protocol handling, not a live model run.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ManagedRun, ManagedTask } from "@agent-city/schema";
import {
	claudeArgs,
	createClaudeImplementer,
	foldClaudeLine,
	newClaudeStream,
} from "./adapters/claude.ts";
import { classifyFailure } from "./adapters/cli.ts";
import {
	codexArgs,
	createCodexReviewer,
	foldCodexLine,
	newCodexStream,
} from "./adapters/codex.ts";
import type { AdapterContext } from "./adapters/types.ts";
import { Orchestrator } from "./orchestrator.ts";
import { runProcess } from "./proc.ts";
import {
	type ManagedDeps,
	runTask,
	submitTask,
	taskDetail,
} from "./service.ts";
import {
	type Fixture,
	type FixtureOptions,
	makeFixture,
	pidAlive,
	setStubMode,
	stubCalls,
	stubDir,
	stubPids,
} from "./testkit.ts";
import { createAdapters } from "./worker.ts";

let fixtures: Fixture[] = [];
afterEach(() => {
	for (const f of fixtures) f.cleanup();
	fixtures = [];
});

function live(opts: FixtureOptions = {}) {
	const fx = makeFixture({ liveStubs: {}, ...opts });
	fixtures.push(fx);
	const claudeCfg = fx.config.live.claude;
	const codexCfg = fx.config.live.codex;
	if (!claudeCfg || !codexCfg) throw new Error("stub config missing");
	return { fx, claudeCfg, codexCfg };
}

function ctxFor(fx: Fixture, signal?: AbortSignal): AdapterContext {
	return {
		signal: signal ?? new AbortController().signal,
		scratchDir: fx.dir,
		maxLogBytes: fx.config.limits.max_log_bytes,
		run: (o) =>
			runProcess({
				...o,
				maxOutputBytes: o.maxOutputBytes ?? fx.config.limits.max_log_bytes,
				killGraceMs: fx.config.limits.kill_grace_ms,
				signal,
			}),
	};
}

const OBJECTIVE = "OBJECTIVE-TEXT-MARKER: add the change";
const task = (fx: Fixture): ManagedTask =>
	({
		id: "task-00000000-0000-0000-0000-000000000001",
		title: "Stub task",
		objective: OBJECTIVE,
		acceptance_criteria: ["criterion one"],
		approved_scope: ["."],
		base_sha: fx.baseSha,
	}) as ManagedTask;
const run = (over: Partial<ManagedRun> = {}): ManagedRun =>
	({
		id: "run-00000000-0000-0000-0000-000000000001",
		attempt_no: 1,
		kind: "initial",
		repair_input: null,
		...over,
	}) as ManagedRun;

const implement = (
	fx: Fixture,
	cfg: Parameters<typeof createClaudeImplementer>[0],
	o: { resume?: string; signal?: AbortSignal; run?: ManagedRun } = {},
) =>
	createClaudeImplementer(cfg).implement(
		{
			task: task(fx),
			run: o.run ?? run(),
			worktree: fx.repoPath,
			resumeSession: o.resume ?? null,
		},
		ctxFor(fx, o.signal),
	);

const SHA = "a".repeat(40);
const MANIFEST = "b".repeat(64);
const review = (
	fx: Fixture,
	cfg: Parameters<typeof createCodexReviewer>[0],
	signal?: AbortSignal,
) =>
	createCodexReviewer(cfg).review(
		{
			task: task(fx),
			run: run(),
			worktree: fx.repoPath,
			candidate_sha: SHA,
			manifest_hash: MANIFEST,
			manifest: {
				verification: [{ name: "check", exit_code: 0 }],
			} as never,
			diff: "diff --git a/x b/x\n+DIFF-MARKER\n",
		},
		ctxFor(fx, signal),
	);

describe("claude adapter: invocation", () => {
	test("argv is explicit and carries no bypass, no fallback, no 'most recent session'", () => {
		const { claudeCfg } = live();
		const fresh = claudeArgs(claudeCfg, { id: "sid-1", resume: false });
		const resumed = claudeArgs(claudeCfg, { id: "sid-1", resume: true });
		expect(fresh[0]).toBe(claudeCfg.executable);
		expect(fresh.slice(-2)).toEqual(["--session-id", "sid-1"]);
		expect(resumed.slice(-2)).toEqual(["--resume", "sid-1"]);
		for (const argv of [fresh, resumed]) {
			expect(argv).toContain("-p");
			expect(argv.join(" ")).toContain("--output-format stream-json --verbose");
			expect(argv.join(" ")).toContain("--model stub-model");
			expect(argv.join(" ")).toContain("--permission-mode acceptEdits");
			expect(argv.join(" ")).toContain("--permission-prompts none");
			expect(argv.join(" ")).toContain("--tools Read,Edit,Write,Glob,Grep");
			for (const banned of [
				"--dangerously-skip-permissions",
				"--allow-dangerously-skip-permissions",
				"bypassPermissions",
				"--bare",
				"--continue",
				"-c",
				"--fallback-model",
			])
				expect(argv).not.toContain(banned);
		}
	});

	test("prompt goes on stdin (not argv), env is the allowlist — no API keys, no hub tokens", async () => {
		const { fx, claudeCfg } = live();
		const saved = { ...process.env };
		// fake values assembled at runtime; none is a real credential
		for (const k of [
			"ANTHROPIC_API_KEY",
			"OPENAI_API_KEY",
			"GITHUB_TOKEN",
			"INGEST_TOKEN",
			"MANAGED_TOKEN",
		])
			process.env[k] = `fake-${k.toLowerCase()}`;
		try {
			const res = await implement(fx, claudeCfg);
			expect(res.ok).toBe(true);
		} finally {
			for (const k of Object.keys(process.env))
				if (!(k in saved)) delete process.env[k];
		}
		const call = stubCalls(fx, "claude").at(-1);
		expect(call?.stdin).toContain(OBJECTIVE);
		expect(call?.stdin).toContain("criterion one");
		expect(call?.argv.join(" ")).not.toContain("OBJECTIVE-TEXT-MARKER");
		expect(call?.cwd).toBe(fx.repoPath);
		for (const k of call?.env ?? []) expect(k).not.toMatch(/KEY|TOKEN|SECRET/);
		expect(call?.env).toContain("PATH");
	});
});

describe("claude adapter: protocol handling (stub executable)", () => {
	test("success: partial lines, stderr noise, unknown events → structured output + reported metadata", async () => {
		const { fx, claudeCfg } = live();
		const res = await implement(fx, claudeCfg);
		if (!res.ok) throw new Error(res.detail);
		expect(res.output).toEqual({
			contract: "agentcity.implementation/v1",
			status: "completed",
			summary: "Stub implementation complete.",
		});
		const sid = stubCalls(fx, "claude").at(-1)?.argv.at(-1);
		expect(res.session_ref).toBe(sid ?? "");
		expect(res.session_ref).toMatch(/^[0-9a-f-]{36}$/);
		expect(res.model_resolved).toBe("stub-model-resolved"); // reported by init, not the request
		expect(res.usage).toMatchObject({
			usage: { input_tokens: 12, output_tokens: 34 },
			modelUsage: { "stub-model-resolved": { inputTokens: 12 } },
		});
		// transcript: event kinds and tool names only — no thinking text
		expect(res.log).toContain("tool_use:Edit");
		expect(res.log).toContain("some_future_event");
		expect(res.log).toContain("warning on stderr");
		expect(res.log).not.toContain("PRIVATE-REASONING-MARKER");
	});

	test("repair resumes the explicit parent session id", async () => {
		const { fx, claudeCfg } = live();
		const res = await implement(fx, claudeCfg, {
			resume: "11111111-2222-3333-4444-555555555555",
			run: run({
				kind: "repair",
				repair_input: [
					{
						severity: "major",
						title: "FINDING-MARKER",
						detail: "fix it",
						file: "a.ts",
						line: 3,
						actionable: true,
					},
				],
			}),
		});
		expect(res.ok).toBe(true);
		const call = stubCalls(fx, "claude").at(-1);
		expect(call?.argv.slice(-2)).toEqual([
			"--resume",
			"11111111-2222-3333-4444-555555555555",
		]);
		expect(call?.argv).not.toContain("--session-id");
		expect(call?.stdin).toContain("FINDING-MARKER");
		expect(res.session_ref).toBe("11111111-2222-3333-4444-555555555555");
	});

	test("model not reported → unknown (null), never the requested name", async () => {
		const { fx, claudeCfg } = live();
		setStubMode(fx, "claude", "no_model");
		const res = await implement(fx, claudeCfg);
		expect(res.ok).toBe(true);
		expect(res.model_resolved).toBeNull();
	});

	test("no structured output → plain result text, noted in the log", async () => {
		const { fx, claudeCfg } = live();
		setStubMode(fx, "claude", "plain_text");
		const res = await implement(fx, claudeCfg);
		if (!res.ok) throw new Error(res.detail);
		expect(res.output.summary).toBe("I made the change.");
		expect(res.log).toContain("no structured output");
	});

	const failures: [string, string][] = [
		["nonzero", "provider_error"],
		["auth_error", "provider_auth"],
		["quota_error", "provider_quota"],
		["model_error", "provider_model"],
		["invalid", "provider_output_invalid"],
	];
	for (const [mode, kind] of failures)
		test(`${mode} → ${kind}, never a success`, async () => {
			const { fx, claudeCfg } = live();
			setStubMode(fx, "claude", mode);
			const res = await implement(fx, claudeCfg);
			expect(res.ok).toBe(false);
			if (res.ok) return;
			expect(res.kind).toBe(kind as typeof res.kind);
			expect(res.log.length).toBeGreaterThan(0);
		});

	test("output over the cap is truncated in the log but the result is still parsed", async () => {
		const { fx, claudeCfg } = live({ limits: { max_log_bytes: 4096 } });
		setStubMode(fx, "claude", "big");
		const res = await implement(fx, claudeCfg);
		if (!res.ok) throw new Error(res.detail);
		expect(res.logTruncated).toBe(true);
		expect(res.output.summary).toBe("big run");
	});

	test("timeout: the process group (incl. a grandchild) is terminated and confirmed gone", async () => {
		const { fx, claudeCfg } = live({ liveStubs: { claudeTimeoutS: 1 } });
		setStubMode(fx, "claude", "hang");
		const res = await implement(fx, claudeCfg);
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.kind).toBe("timeout");
		const pids = stubPids(fx, "claude");
		expect(pids).not.toBeNull();
		for (const pid of pids ?? []) expect(pidAlive(pid)).toBe(false);
	});

	test("cancellation: SIGTERM is escalated to SIGKILL when the child ignores it", async () => {
		const { fx, claudeCfg } = live();
		setStubMode(fx, "claude", "hang_ignore_term");
		const ac = new AbortController();
		const pending = implement(fx, claudeCfg, { signal: ac.signal });
		while (stubPids(fx, "claude") === null) await Bun.sleep(20);
		const pids = stubPids(fx, "claude") ?? [];
		for (const pid of pids) expect(pidAlive(pid)).toBe(true);
		ac.abort();
		const res = await pending;
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.kind).toBe("cancelled");
		for (const pid of pids) expect(pidAlive(pid)).toBe(false);
	});

	test("preflight: missing executable, logged out, ok — none of them runs a prompt", async () => {
		const { fx, claudeCfg } = live();
		const missing = await createClaudeImplementer({
			...claudeCfg,
			executable: join(fx.dir, "bin", "no-such-claude"),
		}).preflight(ctxFor(fx));
		expect(missing).toMatchObject({ ok: false, kind: "provider_unavailable" });

		setStubMode(fx, "claude", "logged_out");
		const out = await createClaudeImplementer(claudeCfg).preflight(ctxFor(fx));
		expect(out).toMatchObject({ ok: false, kind: "provider_auth" });

		setStubMode(fx, "claude", "success");
		const ok = await createClaudeImplementer(claudeCfg).preflight(ctxFor(fx));
		expect(ok.ok).toBe(true);
		expect(ok.detail).toContain("9.9.9");
		expect(ok.detail).not.toContain("@"); // the account email is never kept
		for (const call of stubCalls(fx, "claude"))
			expect(call.argv).not.toContain("-p");
	});

	test("stream folding tolerates blank, malformed and non-object lines", () => {
		const s = newClaudeStream();
		for (const line of [
			"",
			"   ",
			"not json",
			"[1,2]",
			'{"type":"result"',
			'{"type":"result","subtype":"success","session_id":"s"}',
		])
			foldClaudeLine(s, line);
		expect(s.malformed).toBe(3);
		expect(s.result?.subtype).toBe("success");
		expect(s.sessionId).toBe("s");
		expect(s.model).toBeNull();
	});
});

describe("codex adapter (stub executable; flags are docs-derived, unverified against a binary)", () => {
	test("argv: read-only sandbox, explicit model and cwd, schema + last-message files, prompt on stdin", () => {
		const { codexCfg } = live();
		const o = { worktree: "/w", schemaFile: "/s.json", outFile: "/o.json" };
		expect(codexArgs(codexCfg, o).slice(1)).toEqual([
			"exec",
			"--json",
			"--sandbox",
			"read-only",
			"--model",
			"stub-review-model",
			"--cd",
			"/w",
			"--output-schema",
			"/s.json",
			"--output-last-message",
			"/o.json",
			"-",
		]);
		const resumed = codexArgs(codexCfg, { ...o, resumeThread: "thread-9" });
		expect(resumed.slice(1, 4)).toEqual(["exec", "resume", "thread-9"]);
		for (const argv of [codexArgs(codexCfg, o), resumed]) {
			expect(argv).not.toContain("--last");
			expect(argv).not.toContain("danger-full-access");
			expect(argv).not.toContain("workspace-write");
		}
	});

	test("success: thread id, usage, unknown model, verdict from the last-message file", async () => {
		const { fx, codexCfg } = live();
		const res = await review(fx, codexCfg);
		if (!res.ok) throw new Error(res.detail);
		expect(res.raw).toMatchObject({
			contract: "agentcity.review/v1",
			audited_sha: SHA,
			manifest_hash: MANIFEST,
			verdict: "approve",
			tests_executed: false,
		});
		expect(res.session_ref).toBe("thread-stub-0001");
		expect(res.model_resolved).toBeNull(); // not reported by the event stream
		expect(res.usage).toMatchObject({ input_tokens: 100, output_tokens: 20 });
		expect(res.log).toContain("item.completed reasoning");
		expect(res.log).not.toContain("PRIVATE-REASONING-MARKER");

		const call = stubCalls(fx, "codex").at(-1);
		expect(call?.stdin).toContain("DIFF-MARKER");
		expect(call?.stdin).toContain(OBJECTIVE);
		expect(call?.argv.join(" ")).not.toContain("OBJECTIVE-TEXT-MARKER");
		for (const k of call?.env ?? []) expect(k).not.toMatch(/KEY|TOKEN|SECRET/);
		// scratch files are outside the worktree
		const schema = call?.argv[call.argv.indexOf("--output-schema") + 1] ?? "";
		expect(schema.startsWith(fx.repoPath)).toBe(false);
		expect(JSON.parse(readFileSync(schema, "utf8")).additionalProperties).toBe(
			false,
		);
	});

	test("non-JSON final message is passed on as-is (the orchestrator rejects it)", async () => {
		const { fx, codexCfg } = live();
		setStubMode(fx, "codex", "garbage");
		const res = await review(fx, codexCfg);
		if (!res.ok) throw new Error(res.detail);
		expect(res.raw).toBe("LGTM, ship it");
	});

	const failures: [string, string][] = [
		["turn_failed", "provider_quota"],
		["nonzero", "provider_error"],
		["no_message", "provider_output_invalid"],
	];
	for (const [mode, kind] of failures)
		test(`${mode} → ${kind}`, async () => {
			const { fx, codexCfg } = live();
			setStubMode(fx, "codex", mode);
			const res = await review(fx, codexCfg);
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.kind).toBe(kind as typeof res.kind);
		});

	test("timeout terminates the reviewer's process group", async () => {
		const { fx, codexCfg } = live({ liveStubs: { codexTimeoutS: 1 } });
		setStubMode(fx, "codex", "hang");
		const res = await review(fx, codexCfg);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.kind).toBe("timeout");
		for (const pid of stubPids(fx, "codex") ?? [])
			expect(pidAlive(pid)).toBe(false);
	});

	test("preflight: missing executable / logged out", async () => {
		const { fx, codexCfg } = live();
		expect(
			await createCodexReviewer({
				...codexCfg,
				executable: join(fx.dir, "bin", "no-such-codex"),
			}).preflight(ctxFor(fx)),
		).toMatchObject({ ok: false, kind: "provider_unavailable" });
		setStubMode(fx, "codex", "logged_out");
		expect(
			await createCodexReviewer(codexCfg).preflight(ctxFor(fx)),
		).toMatchObject({ ok: false, kind: "provider_auth" });
	});

	test("stream folding: errors, usage, malformed lines", () => {
		const s = newCodexStream();
		for (const line of [
			"garbage",
			'{"type":"thread.started","thread_id":"t1"}',
			'{"type":"error","message":"boom"}',
			'{"type":"turn.completed","usage":{"output_tokens":3}}',
		])
			foldCodexLine(s, line);
		expect(s).toMatchObject({
			threadId: "t1",
			errors: ["boom"],
			usage: { output_tokens: 3 },
			malformed: 1,
		});
	});
});

describe("failure classification", () => {
	test("structured categories win; text is a fallback; unknown → provider_error", () => {
		expect(classifyFailure("whatever", ["authentication_failed"])).toBe(
			"provider_auth",
		);
		expect(classifyFailure("whatever", ["billing_error"])).toBe(
			"provider_quota",
		);
		expect(classifyFailure("Unknown model: foo")).toBe("provider_model");
		expect(classifyFailure("Please run /login")).toBe("provider_auth");
		expect(classifyFailure("You have hit your usage limit")).toBe(
			"provider_quota",
		);
		expect(classifyFailure("segfault")).toBe("provider_error");
	});
});

// ── the whole pipeline with the CLI adapters (still stubs, still no model) ───

function pipeline(opts: FixtureOptions = {}) {
	const { fx } = live(opts);
	const deps: ManagedDeps = { db: fx.db, config: fx.config };
	const orch = new Orchestrator({
		db: fx.db,
		config: fx.config,
		adapters: createAdapters(fx.config),
		heartbeatMs: 50,
	});
	let n = 0;
	const go = async () => {
		const { task: t } = await submitTask(deps, {
			idempotency_key: `live-stub-${++n}-${Date.now()}`,
			repo_id: fx.repoId,
			title: "Live-mode task against stubs",
			objective: OBJECTIVE,
			acceptance_criteria: ["The fixture check passes"],
			approved_scope: ["."],
			execution_mode: "live",
		});
		runTask(deps, t.id);
		while (await orch.tick()) {
			// drain
		}
		return taskDetail(deps, t.id);
	};
	return { fx, go };
}

describe("live-mode pipeline through the CLI adapters (stub executables)", () => {
	test("implement (claude stub) → verify → review (codex stub) → human_ready, labelled live", async () => {
		const { fx, go } = pipeline();
		const d = await go();
		expect(d.task.state).toBe("human_ready");
		expect(d.task.execution_mode).toBe("live");
		expect(d.task.state_detail).not.toContain("simulated");
		expect(d.runs[0]).toMatchObject({
			provider: "claude",
			mode: "live",
			model_requested: "stub-model",
			model_resolved: "stub-model-resolved",
			outcome: "approved",
		});
		expect(d.runs[0]?.session_ref).toMatch(/^[0-9a-f-]{36}$/);
		expect(d.reviews[0]).toMatchObject({
			provider: "codex",
			mode: "live",
			model_requested: "stub-review-model",
			model_resolved: null,
			session_ref: "thread-stub-0001",
			valid: true,
			verdict: "approve",
			candidate_sha: d.runs[0]?.candidate_sha,
		});
		// implementer ran in the worktree, reviewer in the same candidate checkout
		expect(
			stubCalls(fx, "claude").find((c) => c.argv.includes("-p"))?.cwd,
		).toBe(d.runs[0]?.workspace_path ?? "");
		const reviewCall = stubCalls(fx, "codex").find((c) => c.argv[0] === "exec");
		expect(reviewCall?.stdin).toContain(d.runs[0]?.candidate_sha ?? "x");
		expect(reviewCall?.stdin).toContain(d.runs[0]?.manifest_hash ?? "x");
	});

	test("reject → the repair resumes the implementer's session by id → approve", async () => {
		const { fx, go } = pipeline();
		setStubMode(fx, "codex", "reject_once");
		const d = await go();
		expect(d.task.state).toBe("human_ready");
		expect(d.runs).toHaveLength(2);
		const prompts = stubCalls(fx, "claude").filter((c) =>
			c.argv.includes("-p"),
		);
		expect(prompts).toHaveLength(2);
		expect(prompts[1]?.argv.slice(-2)).toEqual([
			"--resume",
			d.runs[0]?.session_ref ?? "",
		]);
		expect(prompts[1]?.stdin).toContain("Stub reviewer finding");
	});

	test("a reviewer that writes to the candidate is detected; its approval is void", async () => {
		const { fx, go } = pipeline();
		setStubMode(fx, "codex", "mutate");
		const d = await go();
		expect(d.task.state).toBe("failed");
		expect(d.task.failure_kind).toBe("candidate_mutated");
		expect(d.reviews[0]).toMatchObject({ valid: false, verdict: "approve" });
		expect(
			existsSync(join(d.runs[0]?.workspace_path ?? "", "reviewer-edit.txt")),
		).toBe(true);
	});

	test("a reviewer claiming it executed tests is invalid", async () => {
		const { fx, go } = pipeline();
		setStubMode(fx, "codex", "claims_tests");
		const d = await go();
		expect(d.task.state).toBe("failed");
		expect(d.task.failure_kind).toBe("review_invalid");
		expect(d.reviews[0]?.invalidated_reason).toContain("tests_executed");
	});

	test("free-text 'LGTM' is not an approval", async () => {
		const { fx, go } = pipeline();
		setStubMode(fx, "codex", "garbage");
		const d = await go();
		expect(d.task.state).toBe("failed");
		expect(d.task.failure_kind).toBe("review_invalid");
	});

	test("implementer not logged in → blocked (auth), no prompt was sent", async () => {
		const { fx, go } = pipeline();
		setStubMode(fx, "claude", "logged_out");
		const d = await go();
		expect(d.task.state).toBe("blocked");
		expect(d.task.failure_kind).toBe("provider_auth");
		expect(stubCalls(fx, "claude").some((c) => c.argv.includes("-p"))).toBe(
			false,
		);
		expect(stubCalls(fx, "codex")).toHaveLength(0);
	});

	test("implementer quota error → blocked (quota); implementer timeout → failed (timeout)", async () => {
		const a = pipeline();
		setStubMode(a.fx, "claude", "quota_error");
		const quota = await a.go();
		expect([quota.task.state, quota.task.failure_kind]).toEqual([
			"blocked",
			"provider_quota",
		]);

		const b = pipeline({ liveStubs: { claudeTimeoutS: 1 } });
		setStubMode(b.fx, "claude", "hang");
		const timeout = await b.go();
		expect([timeout.task.state, timeout.task.failure_kind]).toEqual([
			"failed",
			"timeout",
		]);
		for (const pid of stubPids(b.fx, "claude") ?? [])
			expect(pidAlive(pid)).toBe(false);
	});

	test("implementer reports 'blocked' → not a candidate", async () => {
		const { fx, go } = pipeline();
		setStubMode(fx, "claude", "blocked");
		const d = await go();
		expect(d.task.state).toBe("failed");
		expect(d.task.failure_kind).toBe("provider_error");
		expect(d.runs[0]?.candidate_sha).toBeNull();
	});

	test("stub executables live in the fixture, not on PATH", () => {
		const { fx } = pipeline();
		expect(fx.config.live.claude?.executable.startsWith(stubDir(fx))).toBe(
			true,
		);
		expect(fx.config.live.codex?.executable.startsWith(stubDir(fx))).toBe(true);
	});
});
