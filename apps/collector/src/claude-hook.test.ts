import { expect, test } from "bun:test";

import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = `${import.meta.dir}/claude-hook.ts`;
const BIN = `${import.meta.dir}/../bin/claude-hook`;
/** Isolated env: temp AGENTCITY_HOME, and HUB_URL/INGEST_TOKEN set so the repo .env is never used. */
const isolated = (hubUrl = "http://127.0.0.1:9") => ({
	...process.env,
	AGENTCITY_HOME: mkdtempSync(join(tmpdir(), "agentcity-hook-")),
	HUB_URL: hubUrl,
	INGEST_TOKEN: "hook-test-token",
});

test("claude-hook exits 0 and prints nothing, even on garbage input", async () => {
	const proc = Bun.spawn(["bun", "--no-env-file", HOOK], {
		env: isolated(),
		stdin: new TextEncoder().encode("{not json"),
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(await proc.exited).toBe(0);
	expect(await new Response(proc.stdout).text()).toBe("");
});

test("stdin left open after '{}' → exit 0 within 600ms (watchdog)", async () => {
	const t0 = performance.now();
	const proc = Bun.spawn(["bun", "--no-env-file", HOOK], {
		env: isolated(),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	proc.stdin.write("{}");
	proc.stdin.flush();
	// never call proc.stdin.end() — this is the hang Codex reproduced
	const killer = setTimeout(() => proc.kill(), 2000);
	const code = await proc.exited;
	clearTimeout(killer);
	const elapsed = performance.now() - t0;

	expect(proc.signalCode).toBeNull();
	expect(code).toBe(0);
	expect(elapsed).toBeLessThan(600);
	expect(await new Response(proc.stdout).text()).toBe("");
});

test("stdin over the 1MB cap → still exit 0, no output", async () => {
	const proc = Bun.spawn(["bun", "--no-env-file", HOOK], {
		env: isolated(),
		stdin: new TextEncoder().encode(`{"x":"${"a".repeat(3 * 1024 * 1024)}"}`),
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(await proc.exited).toBe(0);
	expect(await new Response(proc.stdout).text()).toBe("");
});

test("bin/claude-hook → hub receives a whitelisted event with the bearer token", async () => {
	const got: { auth: string | null; body: unknown }[] = [];
	const hub = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			got.push({
				auth: req.headers.get("authorization"),
				body: await req.json(),
			});
			return Response.json({ accepted: 1, duplicates: 0 });
		},
	});
	try {
		const env = isolated(`http://127.0.0.1:${hub.port}`);
		const proc = Bun.spawn([BIN], {
			env,
			stdin: new TextEncoder().encode(
				JSON.stringify({
					session_id: "s-e2e",
					cwd: import.meta.dir,
					hook_event_name: "UserPromptSubmit",
					prompt: "PROMPT-MARKER",
				}),
			),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await proc.exited).toBe(0);
		expect(await new Response(proc.stdout).text()).toBe("");
		expect(got).toHaveLength(1);
		expect(got[0]?.auth).toBe("Bearer hook-test-token");
		const event = (got[0]?.body as Record<string, unknown>[] | undefined)?.[0];
		expect(event).toMatchObject({
			session_id: "claude:s-e2e",
			type: "UserPromptSubmit",
			provider: "claude",
			summary: "prompt (13 chars)",
		});
		expect(typeof event?.repo_id).toBe("string"); // computed from this checkout's .git
		expect(JSON.stringify(got)).not.toContain("PROMPT-MARKER");
	} finally {
		hub.stop(true);
	}
});

test("hub unreachable → event lands in the spool, exit 0", async () => {
	const env = isolated("http://127.0.0.1:9");
	const proc = Bun.spawn([BIN], {
		env,
		stdin: new TextEncoder().encode(
			JSON.stringify({
				session_id: "s-down",
				cwd: "/",
				hook_event_name: "Stop",
			}),
		),
		stdout: "pipe",
	});
	expect(await proc.exited).toBe(0);
	// spool-first: after the failed flush the event sits in a claimed spool.*.flushing file
	const spooled = readdirSync(env.AGENTCITY_HOME)
		.filter((f) => f.startsWith("spool") && !f.includes("rejected"))
		.map((f) => readFileSync(join(env.AGENTCITY_HOME, f), "utf8"))
		.join("");
	expect(JSON.parse(spooled.trim())).toMatchObject({
		session_id: "claude:s-down",
		type: "Stop",
	});
});
