// Regression tests for the Phase 0 audit (Batch A+B: F01–F07, collector side). Each case replays the
// audit's reproduction input. Synthetic secrets only, assembled at runtime (check:secrets stays clean).
import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type IngestEvent,
	REDACTED,
	redact,
	safeId,
	sanitizeEvent,
	summarizeToolInput,
} from "@agent-city/schema/core";
import { mapClaudeHook } from "./claude-map.ts";
import { type CodexFileContext, mapCodexLine } from "./codex-map.ts";
import { GIT_FILE_MAX, gitInfo } from "./git-info.ts";
import { deliver, Spool, type Transport } from "./spool.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `agentcity-audit-${p}-`));
const GH = `ghp_${"Q".repeat(36)}`; // audit's synthetic token shape
const MARK = "auditSyntheticCredential42";
const BIN = `${import.meta.dir}/../bin/claude-hook`;
const ctx = {
	machine: "audit",
	hostname: "test",
	now: () => new Date(),
	newId: () => "id",
	git: () => null,
};

/** Run the real launcher; returns exit code, wall-clock ms and stdout bytes (killed at 2s like the audit). */
async function runBin(
	payload: string,
	env: Record<string, string>,
	opts: { cwd?: string; keepStdinOpen?: boolean } = {},
) {
	const t0 = performance.now();
	const p = Bun.spawn([BIN], {
		cwd: opts.cwd,
		env: { ...process.env, ...env },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	p.stdin.write(payload);
	p.stdin.flush();
	if (!opts.keepStdinOpen) p.stdin.end();
	const killer = setTimeout(() => p.kill(9), 2000);
	const code = await p.exited;
	clearTimeout(killer);
	const ms = performance.now() - t0;
	if (opts.keepStdinOpen) p.stdin.end();
	return { code, ms, stdout: (await new Response(p.stdout).text()).length };
}

const spoolText = (dir: string) => {
	try {
		return readdirSync(dir)
			.filter((f) => f.startsWith("spool") && !f.includes("stats"))
			.map((f) => readFileSync(join(dir, f), "utf8"))
			.join("");
	} catch {
		return "";
	}
};

// ── F01 ────────────────────────────────────────────────────────────────────

describe("F01 hook is bounded", () => {
	test.each([100_000, 900_000])(
		"redact / summarize of a %d-char command stay fast (was O(n²))",
		(n) => {
			const t0 = performance.now();
			redact("a".repeat(n));
			const s = summarizeToolInput("Bash", { command: "a".repeat(n) });
			expect(performance.now() - t0).toBeLessThan(100);
			expect(s.command?.length).toBeLessThanOrEqual(80);
		},
	);

	test("order cap → redact → cut 80 → redact: token past the 4KB cap leaves no prefix", () => {
		const cmd = `${"a ".repeat(2046)}${GH}`; // token straddles the 4096 cap
		const s = summarizeToolInput("Bash", { command: cmd });
		expect(s.command).not.toContain("ghp_");
	});

	test("FIFO .git/config, symlinked .git, oversized HEAD → no block, no git info from them", () => {
		const root = tmp("git");
		const fifo = join(root, "fifo");
		mkdirSync(join(fifo, ".git"), { recursive: true });
		writeFileSync(join(fifo, ".git", "HEAD"), "ref: refs/heads/main\n");
		Bun.spawnSync(["mkfifo", join(fifo, ".git", "config")]);
		const t0 = performance.now();
		expect(gitInfo(fifo)).toMatchObject({
			repo_id: "local/fifo",
			branch: "main",
		});
		expect(performance.now() - t0).toBeLessThan(100);

		const real = join(root, "real");
		mkdirSync(join(real, ".git"), { recursive: true });
		const linked = join(root, "linked");
		mkdirSync(linked);
		symlinkSync(join(real, ".git"), join(linked, ".git"));
		expect(gitInfo(linked)).toBeNull();

		const big = join(root, "big");
		mkdirSync(join(big, ".git"), { recursive: true });
		writeFileSync(
			join(big, ".git", "HEAD"),
			`ref: refs/heads/${"x".repeat(GIT_FILE_MAX)}\n`,
		);
		expect(gitInfo(big)?.branch).toBeNull();
	});

	test("launcher kills a stalled hook: fifo-config and 900K command exit 0 under 700ms", async () => {
		const home = tmp("bin-home");
		const env = {
			AGENTCITY_HOME: home,
			HUB_URL: "http://127.0.0.1:9",
			INGEST_TOKEN: "audit-test-only",
		};
		const fifo = join(tmp("bin-fifo"), "p");
		mkdirSync(join(fifo, ".git"), { recursive: true });
		writeFileSync(join(fifo, ".git", "HEAD"), "ref: refs/heads/main\n");
		Bun.spawnSync(["mkfifo", join(fifo, ".git", "config")]);

		const cases = [
			JSON.stringify({ session_id: "s", hook_event_name: "Stop", cwd: fifo }),
			JSON.stringify({
				session_id: "s",
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				cwd: "/",
				tool_input: { command: "a".repeat(900_000) },
			}),
		];
		for (const payload of cases) {
			const r = await runBin(payload, env, { cwd: fifo });
			expect(r.code).toBe(0);
			expect(r.stdout).toBe(0);
			expect(r.ms).toBeLessThan(700);
		}
	});

	test("even a synchronously stuck process is killed by the launcher (<700ms)", async () => {
		const fake = join(tmp("fakebun"), "bun");
		writeFileSync(fake, "#!/bin/sh\nwhile :; do :; done\n", { mode: 0o755 });
		const r = await runBin("{}", { AGENTCITY_BUN: fake });
		expect(r.code).toBe(0);
		expect(r.ms).toBeLessThan(700);
	});
});

// ── F02 ────────────────────────────────────────────────────────────────────

describe("F02 every string field is sanitized", () => {
	test("raw-metadata: token in cwd / model / tool_name never reaches the event", () => {
		const ev = mapClaudeHook(
			{
				session_id: "audit-session",
				hook_event_name: "Stop",
				cwd: `/tmp/${GH}`,
				model: GH,
				tool_name: GH,
			},
			{
				...ctx,
				git: () => ({ toplevel: "/tmp", repo_id: "local/test", branch: GH }),
			},
		);
		expect(JSON.stringify(ev)).not.toContain(GH);
	});

	test("codex session context is sanitized before it is persisted", () => {
		const c: CodexFileContext = { session: null, calls: new Map() };
		const ev = mapCodexLine(
			JSON.stringify({
				timestamp: new Date().toISOString(),
				type: "session_meta",
				payload: { id: "audit-codex", cwd: `/tmp/${GH}` },
			}),
			0,
			c,
			{
				machine: "audit",
				hostname: "test",
				git: () => ({ toplevel: "/tmp", repo_id: "local/x", branch: GH }),
			},
		);
		expect(JSON.stringify(ev)).not.toContain(GH);
		expect(JSON.stringify(c.session)).not.toContain(GH);
	});

	test("unsafe ids become a deterministic hash", () => {
		expect(safeId("claude:abc-123")).toBe("claude:abc-123");
		const a = safeId(`sess ${GH}`);
		expect(a).toMatch(/^redacted-[0-9a-f]{16}$/);
		expect(safeId(`sess ${GH}`)).toBe(a);
		const e = sanitizeEvent({
			id: GH,
			machine_id: "m",
			session_id: GH,
			type: "Stop",
		});
		expect(JSON.stringify(e)).not.toContain(GH);
	});
});

// ── F03 ────────────────────────────────────────────────────────────────────

describe("F03 redaction bypasses (audit sink cases) → spool never holds the value", () => {
	test.each([
		["escaped-JSON", `echo "{\\"token\\":\\"${MARK}\\"}"`],
		["YAML-block", `token: |\n  ${MARK}`],
		["masked-prefix", `TOKEN="[REDACTED]${MARK}"`],
		["masked-prefix bare", `TOKEN=[REDACTED]${MARK}`],
		[
			"incomplete-PEM",
			`${"-".repeat(5)}BEGIN PRIVATE KEY${"-".repeat(5)}\n${MARK}`,
		],
	])("%s", (_name, command) => {
		const ev = mapClaudeHook(
			{
				session_id: "sink",
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command },
			},
			ctx,
		) as IngestEvent;
		const dir = tmp("sink");
		new Spool(dir).append([ev]);
		expect(spoolText(dir)).not.toContain(MARK);
		expect(redact(command)).not.toContain(MARK);
	});

	test("xoxc- and upper-case prefixes are masked; URL username without password is kept", () => {
		expect(redact(`xoxc-${"Q".repeat(36)}`)).toBe(REDACTED);
		expect(redact(`GHP_${"Q".repeat(36)}`)).toBe(REDACTED);
		expect(redact("https://someuser@example.invalid/x")).toBe(
			"https://someuser@example.invalid/x",
		);
	});
});

// ── F04 ────────────────────────────────────────────────────────────────────

describe("F04 spool before POST", () => {
	test("the event is on disk before the transport is called", async () => {
		const dir = tmp("first");
		let onDiskDuringPost = false;
		const t: Transport = {
			async post() {
				onDiskDuringPost = spoolText(dir).includes('"first-1"');
				return "failed";
			},
		};
		const ev = sanitizeEvent({
			id: "first-1",
			ts: new Date().toISOString(),
			machine_id: "m",
			session_id: "s",
			agent_id: null,
			provider: "claude" as const,
			type: "Stop",
			tool: null,
			summary: null,
			repo_id: null,
			payload_redacted: {},
		});
		expect(await deliver([ev], new Spool(dir), t)).toBe("spooled");
		expect(onDiskDuringPost).toBe(true);
	});

	test("stdin held open + hub hanging: exit 0 under 700ms and the event is spooled", async () => {
		const hang = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Promise<Response>(() => {}),
		});
		try {
			const home = tmp("hang");
			const r = await runBin(
				JSON.stringify({
					session_id: "s-hang",
					hook_event_name: "Stop",
					cwd: "/",
				}),
				{
					AGENTCITY_HOME: home,
					HUB_URL: `http://127.0.0.1:${hang.port}`,
					INGEST_TOKEN: "audit-only",
				},
				{ keepStdinOpen: true },
			);
			expect(r.code).toBe(0);
			expect(r.ms).toBeLessThan(700);
			expect(spoolText(home)).toContain('"s-hang"');
		} finally {
			hang.stop(true);
		}
	});
});

// ── F05 ────────────────────────────────────────────────────────────────────

const mk = (id: string, ts = new Date().toISOString()): IngestEvent => ({
	id,
	ts,
	machine_id: "m",
	session_id: "s",
	agent_id: null,
	provider: "claude",
	type: "Stop",
	tool: null,
	summary: null,
	repo_id: null,
	payload_redacted: { pad: "x".repeat(200) },
});

describe("F05 spool bounds", () => {
	test("size cap drops the oldest data first and counts it", () => {
		const dir = tmp("cap");
		const spool = new Spool(dir, { maxBytes: 4_000 });
		for (let i = 0; i < 40; i++) spool.append([mk(`e${i}`)]);
		const kept = spoolText(dir);
		expect(kept).toContain('"e39"'); // newest survives
		expect(kept).not.toContain('"e0"'); // oldest dropped
		expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(4_000);
		expect(spool.stats().dropped_overflow).toBeGreaterThan(0);
	});

	test("events older than the age cap are dropped at flush (counted), not sent", async () => {
		const dir = tmp("age");
		const spool = new Spool(dir, { maxAgeMs: 60_000 });
		spool.append([
			mk("old", new Date(Date.now() - 3_600_000).toISOString()),
			mk("new"),
		]);
		const sent: string[] = [];
		await spool.flush({
			async post(es) {
				sent.push(...es.map((e) => e.id));
				return "ok";
			},
		});
		expect(sent).toEqual(["new"]);
		expect(spool.stats().dropped_age).toBe(1);
	});

	test("old .flushing files past the age cap are removed", () => {
		const dir = tmp("agefile");
		mkdirSync(dir, { recursive: true });
		const f = join(dir, "spool.1000.1.abc.flushing");
		writeFileSync(f, `${JSON.stringify(mk("stale"))}\n`);
		const past = new Date(Date.now() - 30 * 86_400_000);
		utimesSync(f, past, past);
		const spool = new Spool(dir);
		spool.enforceLimits();
		expect(readdirSync(dir).some((n) => n.endsWith(".flushing"))).toBe(false);
		expect(spool.stats().dropped_age).toBe(1);
	});

	test("rejected file is capped, keeping the newest lines", () => {
		const dir = tmp("rej");
		const spool = new Spool(dir, { rejectedMaxBytes: 2_000 });
		for (let i = 0; i < 30; i++) spool.reject([JSON.stringify(mk(`r${i}`))]);
		const text = readFileSync(spool.rejectedFile, "utf8");
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2_000);
		expect(text).toContain('"r29"');
		expect(spool.stats().rejected_overflow).toBeGreaterThan(0);
	});

	test("the drop counter is sent with every flush", async () => {
		const dir = tmp("hdr");
		const spool = new Spool(dir, { maxBytes: 3_000 });
		for (let i = 0; i < 30; i++) spool.append([mk(`h${i}`)]);
		let reported: number | undefined;
		await spool.flush({
			async post(_es, opts) {
				reported = opts?.dropped;
				return "ok";
			},
		});
		expect(reported).toBe(spool.droppedTotal());
		expect(reported).toBeGreaterThan(0);
	});
});
