// v0.1.1 Priority 2: provider contracts, process bounds and private output — all against generated
// stub executables and synthetic canaries. No real provider binary, login or model is involved.
//   P2.5 capability policy + positive subscription-auth verification
//   P2.6 multiline redaction through real artifact paths; no raw scratch retained
//   P2.7 independent termination bound; bounded parsing / file reads
//   P2.8 invalid implementation contracts never start downstream stages
import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	claudeArgs,
	createClaudeImplementer,
	foldClaudeLine,
	newClaudeStream,
	readClaudeAuth,
} from "./adapters/claude.ts";
import { BoundedLog, readFileBounded } from "./adapters/cli.ts";
import {
	createCodexReviewer,
	foldCodexLine,
	newCodexStream,
	readCodexAuth,
} from "./adapters/codex.ts";
import type { AdapterContext } from "./adapters/types.ts";
import { parseManagedConfig, policyHash } from "./config.ts";
import { readArtifact, redactLog } from "./evidence.ts";
import { Orchestrator } from "./orchestrator.ts";
import { hostProcessOps, runProcess } from "./proc.ts";
import {
	type ManagedDeps,
	runTask,
	submitTask,
	taskDetail,
} from "./service.ts";
import { getTask, listArtifacts, listQuarantine } from "./store.ts";
import {
	type Fixture,
	type FixtureOptions,
	makeFixture,
	pidAlive,
	setStubMode,
	stubCalls,
	stubPids,
} from "./testkit.ts";
import { createAdapters } from "./worker.ts";

let fixtures: Fixture[] = [];
const strays: number[] = [];
afterEach(() => {
	for (const pid of strays.splice(0))
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// gone
		}
	for (const f of fixtures) f.cleanup();
	fixtures = [];
});

/** Synthetic canaries, assembled at runtime — never real secrets. */
const PK = ["PRIVATE", "KEY"].join(" "); // keeps literal key markers out of the source
const fakeGh = (tag: string) => `ghp_${tag}${"Zz09".repeat(8)}`;

function live(opts: FixtureOptions = {}) {
	const fx = makeFixture({ liveStubs: {}, ...opts });
	fixtures.push(fx);
	const claude = fx.config.live.claude;
	const codex = fx.config.live.codex;
	if (!claude || !codex) throw new Error("stub config missing");
	return { fx, claude, codex };
}

function ctxFor(fx: Fixture): AdapterContext {
	return {
		signal: new AbortController().signal,
		scratchDir: fx.dir,
		maxLogBytes: fx.config.limits.max_log_bytes,
		run: (o) =>
			runProcess({
				...o,
				maxOutputBytes: o.maxOutputBytes ?? fx.config.limits.max_log_bytes,
				killGraceMs: fx.config.limits.kill_grace_ms,
			}),
	};
}

let seq = 0;
async function runLive(fx: Fixture, over: Record<string, unknown> = {}) {
	const deps: ManagedDeps = { db: fx.db, config: fx.config };
	const { task } = await submitTask(deps, {
		idempotency_key: `p2-${++seq}-${Date.now()}`,
		repo_id: fx.repoId,
		title: "P2 task",
		objective: "Provider hardening.",
		acceptance_criteria: ["The fixture check passes"],
		approved_scope: ["."],
		execution_mode: fx.config.live.enabled ? "live" : "simulated",
		...over,
	});
	runTask(deps, task.id);
	const orch = new Orchestrator({
		db: fx.db,
		config: fx.config,
		adapters: createAdapters(fx.config),
		heartbeatMs: 40,
	});
	while (await orch.tick()) {
		// drain
	}
	return { deps, id: task.id, orch };
}

const prompts = (fx: Fixture) =>
	stubCalls(fx, "claude").filter((c) => c.argv.includes("-p")).length;

// ── P2.5 ────────────────────────────────────────────────────────────────────

describe("P2.5 capability policy and subscription-only auth", () => {
	test("the implementer argv carries every isolation control and no bypass", () => {
		const { claude } = live();
		const argv = claudeArgs(claude, { id: "s", resume: false });
		for (const flag of [
			"--safe-mode",
			"--restricted",
			"--strict-mcp-config",
			"--disable-slash-commands",
		])
			expect(argv).toContain(flag);
		expect(argv).not.toContain("--mcp-config");
		expect(argv).not.toContain("--settings");
		expect(argv).not.toContain("--bare");
	});

	test("a version lacking a required control is blocked before any prompt", async () => {
		const { fx, claude } = live();
		setStubMode(fx, "claude", "no_safe_mode");
		const pre = await createClaudeImplementer(claude).preflight(ctxFor(fx));
		expect(pre).toMatchObject({ ok: false, kind: "provider_unavailable" });
		expect(pre.detail).toContain("--safe-mode");
		const run = await runLive(fx);
		expect(getTask(fx.db, run.id)).toMatchObject({
			state: "blocked",
			failure_kind: "provider_unavailable",
		});
		expect(prompts(fx)).toBe(0);
	});

	test("auth: API-key method, malformed, empty, not allowlisted → blocked before any prompt", async () => {
		for (const mode of ["api_key_auth", "malformed_status", "empty_status"]) {
			const { fx } = live();
			setStubMode(fx, "claude", mode);
			const run = await runLive(fx);
			expect([mode, getTask(fx.db, run.id)?.failure_kind]).toEqual([
				mode,
				"provider_auth",
			]);
			expect(prompts(fx)).toBe(0);
		}
		// the default (empty) allowlist accepts nothing
		expect(
			readClaudeAuth(
				'{"loggedIn":true,"authMethod":"anything","subscriptionType":"x"}',
				0,
				[],
			),
		).toMatchObject({ ok: false, kind: "provider_auth" });
		expect(readClaudeAuth("", 0, ["a"]).ok).toBe(false);
		expect(
			readClaudeAuth('{"loggedIn":true,"authMethod":"a"}', 1, ["a"]).ok,
		).toBe(false);
	});

	test("the identifying fields of auth status are never kept", () => {
		const r = readClaudeAuth(
			JSON.stringify({
				loggedIn: true,
				authMethod: "m",
				subscriptionType: "s",
				email: "person@example.invalid",
				orgName: "Org Name",
			}),
			0,
			["m"],
		);
		expect(r.ok).toBe(true);
		expect(r.detail).not.toContain("example.invalid");
		expect(r.detail).not.toContain("Org Name");
	});

	test("codex: no pattern → blocked; API-key text → blocked; a missing control → blocked", async () => {
		expect(readCodexAuth("Logged in using ChatGPT", 0, null)).toMatchObject({
			ok: false,
			kind: "provider_auth",
		});
		expect(
			readCodexAuth(
				"Logged in using an API key",
				0,
				"^Logged in using ChatGPT",
			),
		).toMatchObject({ ok: false });
		expect(readCodexAuth("x", 0, "([")).toMatchObject({ ok: false });
		const { fx, codex } = live();
		setStubMode(fx, "codex", "api_key_auth");
		expect(
			await createCodexReviewer(codex).preflight(ctxFor(fx)),
		).toMatchObject({ ok: false, kind: "provider_auth" });
		setStubMode(fx, "codex", "no_ignore_config");
		const caps = await createCodexReviewer(codex).preflight(ctxFor(fx));
		expect(caps).toMatchObject({ ok: false, kind: "provider_unavailable" });
		expect(caps.detail).toContain("--ignore-user-config");
		expect(
			stubCalls(fx, "codex").some(
				(c) => c.argv[0] === "exec" && c.argv.includes("--json"),
			),
		).toBe(false);
	});

	test("capability and auth settings are part of the approval binding", () => {
		const { fx } = live();
		const base = policyHash(fx.config, fx.repoId);
		const variants = [
			{ allowed_auth_methods: ["other"] },
			{ tools: ["Read"] },
			{ model: "other-model" },
		];
		for (const v of variants) {
			const cfg = parseManagedConfig({
				...fx.config,
				live: {
					...fx.config.live,
					claude: { ...fx.config.live.claude, ...v },
				},
			});
			expect(policyHash(cfg, fx.repoId)).not.toBe(base);
		}
		const codexChanged = parseManagedConfig({
			...fx.config,
			live: {
				...fx.config.live,
				codex: { ...fx.config.live.codex, auth_status_pattern: "^x" },
			},
		});
		expect(policyHash(codexChanged, fx.repoId)).not.toBe(base);
	});
});

// ── P2.6 ────────────────────────────────────────────────────────────────────

describe("P2.6 multiline redaction and no raw scratch", () => {
	test("redactLog keeps redact()'s multi-line protections over a whole log", () => {
		const t1 = fakeGh("ONE");
		const t2 = fakeGh("TWO");
		const yamlCanary = "YAML-CANARY-0001-abcdef";
		const keyCanary = "KEY-CANARY-0002-abcdef";
		const log = [
			"line before",
			"client_secret: |",
			`  ${yamlCanary}`,
			"  second line of the block",
			"next_key: visible",
			`export DEPLOY_TOKEN=${t1.slice(0, 15)}\\`,
			`  ${t1.slice(15)}`,
			`-----BEGIN OPENSSH ${PK}-----`,
			keyCanary,
			"-----END OPENSSH PRIVATE KEY-----",
			`crlf line ${t2}\r`,
			`${"word ".repeat(1200)}password=${"Q".repeat(24)} ${"tail ".repeat(400)}`,
			"after",
		].join("\n");
		const out = redactLog(log);
		for (const canary of [
			yamlCanary,
			keyCanary,
			t1,
			t1.slice(15),
			t2,
			"Q".repeat(24),
		])
			expect(out).not.toContain(canary);
		expect(out).toContain("next_key: visible");
		expect(out).toContain("line before");
		expect(out).toContain("after");
		expect(out).not.toContain("\r");
		// long lines are redacted, not silently clipped at 4 KB
		expect(out).toContain("tail tail");
	});

	test("a token cut by a byte cap does not survive as an unmasked fragment", () => {
		const t = fakeGh("CUT");
		const cut = `output ${t.slice(0, 12)}`; // shorter than the token pattern's minimum
		expect(redactLog(cut, { truncated: true })).not.toContain(t.slice(0, 12));
		expect(redactLog(cut, { truncated: true })).toContain("output");
		// an unbroken run longer than 1 KiB is masked whole
		expect(redactLog("x".repeat(5000))).not.toContain("x".repeat(1025));
	});

	test("canaries printed by verification never reach the stored artifacts", async () => {
		const fx = makeFixture({
			verification: [{ name: "noisy", argv: ["/bin/sh", "PLACEHOLDER"] }],
		});
		fixtures.push(fx);
		const t1 = fakeGh("VERIFY");
		const script = join(fx.dir, "noisy.sh");
		writeFileSync(
			script,
			[
				"#!/bin/sh",
				"echo 'api_key: |'",
				"echo '  MULTILINE-CANARY-7777'",
				`printf '%s\\\\\\n%s\\n' 'TOKEN=${t1.slice(0, 10)}' '${t1.slice(10)}'`,
				`echo '-----BEGIN RSA ${PK}-----'`,
				"echo 'RSA-CANARY-8888'",
				"echo '-----END RSA PRIVATE KEY-----'",
				"grep -qs '^pass$' agentcity-sim/verify.status || exit 1",
			].join("\n"),
		);
		const cfg = parseManagedConfig({
			...fx.config,
			repos: [
				{
					...fx.config.repos[0],
					verification: [{ name: "noisy", argv: ["/bin/sh", script] }],
				},
			],
		});
		const deps: ManagedDeps = { db: fx.db, config: cfg };
		const { task } = await submitTask(deps, {
			idempotency_key: `p26-${Date.now()}`,
			repo_id: fx.repoId,
			title: "redaction",
			objective: "o",
			acceptance_criteria: ["c"],
			approved_scope: ["."],
			execution_mode: "simulated",
		});
		runTask(deps, task.id);
		const orch = new Orchestrator({
			db: fx.db,
			config: cfg,
			adapters: createAdapters(cfg),
		});
		while (await orch.tick()) {
			// drain
		}
		expect(getTask(fx.db, task.id)?.state).toBe("human_ready");
		const log = listArtifacts(fx.db, task.id).find(
			(a) => a.kind === "verification_log",
		);
		const text = readArtifact(
			cfg.artifacts_root,
			log as NonNullable<typeof log>,
			1_000_000,
		).text;
		for (const canary of [
			"MULTILINE-CANARY-7777",
			"RSA-CANARY-8888",
			t1,
			t1.slice(10),
		])
			expect(text).not.toContain(canary);
		expect(text).toContain("api_key: |");
	});

	test("no raw scratch remains after success, invalid output, timeout or cancellation", async () => {
		for (const mode of ["success", "garbage", "nonzero"]) {
			const { fx } = live();
			setStubMode(fx, "codex", mode);
			await runLive(fx);
			const scratch = join(fx.config.artifacts_root, "_scratch");
			const left = existsSync(scratch) ? readdirSync(scratch) : [];
			expect([mode, left]).toEqual([mode, []]);
		}
		const t = live({ liveStubs: { codexTimeoutS: 1 } });
		setStubMode(t.fx, "codex", "hang");
		await runLive(t.fx);
		expect(readdirSync(join(t.fx.config.artifacts_root, "_scratch"))).toEqual(
			[],
		);
	}, 30_000);

	test("crash leftovers: only our own scratch entries are removed", async () => {
		const { fx } = live();
		const scratch = join(fx.config.artifacts_root, "_scratch");
		mkdirSync(scratch, { recursive: true });
		const ours = join(
			scratch,
			"run-00000000-0000-0000-0000-000000000000-abcd1234",
		);
		mkdirSync(ours);
		writeFileSync(
			join(ours, "review-last-message.json"),
			"raw provider output",
		);
		const foreign = join(scratch, "keep-me");
		mkdirSync(foreign);
		const outside = join(fx.dir, "outside-dir");
		mkdirSync(outside);
		writeFileSync(join(outside, "precious.txt"), "do not delete");
		const link = join(
			scratch,
			"run-00000000-0000-0000-0000-000000000001-abcd1234",
		);
		symlinkSync(outside, link);
		const orch = new Orchestrator({
			db: fx.db,
			config: fx.config,
			adapters: createAdapters(fx.config),
		});
		await orch.tick();
		expect(existsSync(ours)).toBe(false);
		expect(existsSync(foreign)).toBe(true);
		expect(existsSync(join(outside, "precious.txt"))).toBe(true);
	});
});

// ── P2.7 ────────────────────────────────────────────────────────────────────

describe("P2.7 bounded termination and bounded parsing", () => {
	test("a descendant that escapes the group and holds the pipes cannot hang the run", async () => {
		const started = Date.now();
		let escaped = 0;
		const r = await runProcess({
			argv: [
				process.execPath,
				"-e",
				`const { spawn } = require("node:child_process");
				 const c = spawn("/bin/sleep", ["600"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
				 c.unref(); console.log(String(c.pid));`,
			],
			cwd: "/",
			env: { PATH: "/usr/bin:/bin" },
			timeoutMs: 30_000,
			maxOutputBytes: 4096,
			killGraceMs: 200,
			onStdoutLine: (l) => {
				escaped = Number(l.trim()) || escaped;
			},
		});
		if (escaped) strays.push(escaped);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(r.unresolved).toContain("pipes stayed open");
		expect(r.unresolvedKind).toBe("pipe");
		expect(r.terminationConfirmed).toBe(false);
		// the held pipe's EOF is the evidence once the descendant goes
		let closed = false;
		void r.pipesClosed.then(() => {
			closed = true;
		});
		expect(closed).toBe(false);
		process.kill(escaped, "SIGKILL");
		await r.pipesClosed;
		expect(closed).toBe(true);
	});

	test("an unconfirmed kill settles within its bound as unresolved", async () => {
		const started = Date.now();
		const r = await runProcess({
			argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
			cwd: "/",
			env: { PATH: "/usr/bin:/bin" },
			timeoutMs: 200,
			maxOutputBytes: 4096,
			killGraceMs: 100,
			processOps: { ...hostProcessOps, terminateGroup: async () => false },
		});
		if (r.pid) strays.push(r.pid);
		expect(Date.now() - started).toBeLessThan(6_000);
		expect(r.timedOut).toBe(true);
		expect(r.unresolved).not.toBeNull();
		expect(r.terminationConfirmed).toBe(false);
	});

	test("escaped descendant during a live stage → interrupted + pipe quarantine, released only on EOF", async () => {
		const { fx } = live();
		setStubMode(fx, "claude", "escape");
		const run = await runLive(fx);
		const pids = stubPids(fx, "claude");
		if (pids) strays.push(pids[1]);
		expect(getTask(fx.db, run.id)?.state).toBe("interrupted");
		const q = listQuarantine(fx.db, { open: true });
		expect(q).toHaveLength(1);
		expect(q[0]?.reason).toContain("[pipe]");
		// group gone, descendant alive: still quarantined
		await run.orch.tick();
		expect(listQuarantine(fx.db, { open: true })).toHaveLength(1);
		expect(listQuarantine(fx.db, { open: true })[0]?.last_check).toContain(
			"still holds",
		);
		// a different hub process cannot observe the pipe: it stays (fail closed)
		const other = new Orchestrator({
			db: fx.db,
			config: fx.config,
			adapters: createAdapters(fx.config),
		});
		await other.tick();
		expect(listQuarantine(fx.db, { open: true })[0]?.last_check).toContain(
			"cannot be verified",
		);
		// the descendant goes → EOF → the owning process releases it
		process.kill(pids?.[1] ?? 0, "SIGKILL");
		const deadline = Date.now() + 5_000;
		while (listQuarantine(fx.db, { open: true }).length > 0) {
			if (Date.now() > deadline) throw new Error("quarantine not released");
			await run.orch.tick();
			await Bun.sleep(20);
		}
		expect(pidAlive(pids?.[1] ?? 0)).toBe(false);
		expect((await taskDetail(run.deps, run.id)).quarantine).toEqual([]);
	});

	test("lines: an oversized newline-terminated line is dropped before the callback", async () => {
		const seen: number[] = [];
		const r = await runProcess({
			argv: [
				process.execPath,
				"-e",
				"process.stdout.write('a'.repeat(5000) + '\\nshort\\n')",
			],
			cwd: "/",
			env: { PATH: "/usr/bin:/bin" },
			timeoutMs: 10_000,
			maxOutputBytes: 100_000,
			killGraceMs: 200,
			maxLineBytes: 1000,
			onStdoutLine: (l) => seen.push(l.length),
		});
		expect(r.lineOverflow).toBe(true);
		expect(seen).toEqual([5]);
	});

	test("many small events cannot grow the parser state past its budget", () => {
		const s = newClaudeStream(2_000);
		for (let i = 0; i < 50_000; i++) {
			foldClaudeLine(
				s,
				'{"type":"system","subtype":"api_retry","error":"rate_limit"}',
			);
			foldClaudeLine(
				s,
				`{"type":"assistant","message":{"content":[{"type":"text"}]}}`,
			);
		}
		expect(Buffer.byteLength(s.transcript.text())).toBeLessThan(2_200);
		expect(s.transcript.truncated).toBe(true);
		expect(s.retryErrors.length).toBeLessThanOrEqual(20);
		foldClaudeLine(
			s,
			JSON.stringify({
				type: "result",
				subtype: "success",
				result: "r".repeat(100_000),
				structured_output: { big: "s".repeat(100_000) },
			}),
		);
		expect(s.result?.text.length).toBeLessThanOrEqual(8_000);
		expect(s.result?.structured_output).toBeNull(); // too large to keep
		const c = newCodexStream(1_000);
		for (let i = 0; i < 10_000; i++)
			foldCodexLine(c, '{"type":"error","message":"boom"}');
		expect(c.errors.length).toBeLessThanOrEqual(20);
		const b = new BoundedLog(100, 10);
		b.push("x".repeat(1000));
		expect(b.text().length).toBeLessThan(20);
	});

	test("file reads are bounded before allocation", () => {
		const { fx } = live();
		const big = join(fx.dir, "big.json");
		writeFileSync(big, "x".repeat(300_000));
		const r = readFileBounded(big, 1_000);
		expect(r.text.length).toBe(1_000);
		expect(r.truncated).toBe(true);
		expect(readFileBounded(join(fx.dir, "missing"), 10)).toEqual({
			text: "",
			truncated: false,
		});
	});
});

// ── P2.8 ────────────────────────────────────────────────────────────────────

describe("P2.8 invalid implementation contracts", () => {
	const cases: [string, string][] = [
		["plain_text", "provider_output_invalid"],
		["invalid", "provider_output_invalid"],
		["wrong_schema", "provider_output_invalid"],
		["empty_success", "provider_output_invalid"],
		["blocked_text", "provider_output_invalid"],
		["blocked", "provider_error"], // a valid "blocked" contract: an explicit stop, not success
	];
	for (const [mode, kind] of cases)
		test(`${mode} → ${kind}; verification and review never start`, async () => {
			const { fx } = live();
			setStubMode(fx, "claude", mode);
			const run = await runLive(fx);
			const d = await taskDetail(run.deps, run.id);
			expect(d.task.failure_kind).toBe(kind as typeof d.task.failure_kind);
			expect(d.runs).toHaveLength(1);
			expect(d.runs[0]?.candidate_sha).toBeNull();
			expect(d.artifacts.some((a) => a.kind === "verification_log")).toBe(
				false,
			);
			expect(d.reviews).toHaveLength(0);
			expect(
				stubCalls(fx, "codex").some(
					(c) => c.argv[0] === "exec" && c.argv.includes("--json"),
				),
			).toBe(false);
		});

	test("a valid completed contract still works (control)", async () => {
		const { fx } = live();
		const run = await runLive(fx);
		expect(getTask(fx.db, run.id)?.state).toBe("human_ready");
	});
});
