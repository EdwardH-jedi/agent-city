// The process-execution boundary: no shell, bounded time and output, whole-group termination.
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
	childEnv,
	groupAlive,
	hostProcessOps,
	processStarted,
	resolveRecorded,
	runProcess,
} from "./proc.ts";

const BUN = process.execPath;
const base = {
	cwd: "/",
	env: childEnv(),
	timeoutMs: 10_000,
	maxOutputBytes: 65_536,
	killGraceMs: 200,
};
const js = (code: string) => [BUN, "-e", code];

describe("runProcess", () => {
	test("argv is passed literally — no shell expansion", async () => {
		const r = await runProcess({
			...base,
			argv: ["/bin/echo", "$HOME; echo injected && `id`"],
		});
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toBe("$HOME; echo injected && `id`\n");
	});

	test("stdin, stderr and a nonzero exit are reported as they happened", async () => {
		const r = await runProcess({
			...base,
			argv: js(
				"const t = await Bun.stdin.text(); console.log(t.toUpperCase()); console.error('oops'); process.exit(7)",
			),
			stdin: "payload",
		});
		expect(r).toMatchObject({
			spawned: true,
			exitCode: 7,
			timedOut: false,
			aborted: false,
			stdout: "PAYLOAD\n",
			terminationConfirmed: true,
		});
		expect(r.stderr).toContain("oops");
	});

	test("missing executable → not spawned, no throw", async () => {
		const r = await runProcess({
			...base,
			argv: ["/nonexistent/agentcity-bin"],
		});
		expect(r.spawned).toBe(false);
		expect(r.spawnError).not.toBeNull();
		expect(r.exitCode).toBeNull();
		expect((await runProcess({ ...base, argv: [] })).spawnError).toBe(
			"empty argv",
		);
	});

	test("captured output is capped; the stream is still drained and the exit code kept", async () => {
		const r = await runProcess({
			...base,
			maxOutputBytes: 1000,
			argv: js(
				"for (let i = 0; i < 2000; i++) process.stdout.write('x'.repeat(999) + '\\n'); process.stderr.write('e'.repeat(5000))",
			),
		});
		expect(r.exitCode).toBe(0);
		expect(r.stdout.length).toBe(1000);
		expect(r.stdoutTruncated).toBe(true);
		expect(r.stderr.length).toBe(1000);
		expect(r.stderrTruncated).toBe(true);
	});

	test("lines are reassembled across chunk boundaries, independent of the capture cap", async () => {
		const lines: string[] = [];
		const r = await runProcess({
			...base,
			maxOutputBytes: 8,
			onStdoutLine: (l) => lines.push(l),
			argv: js(
				"process.stdout.write('{\"a\":'); await Bun.sleep(30); process.stdout.write('1}\\n{\"b\":2}\\nlast-without-newline')",
			),
		});
		expect(lines).toEqual(['{"a":1}', '{"b":2}', "last-without-newline"]);
		expect(r.stdoutTruncated).toBe(true);
	});

	test("timeout kills the whole process group, including a background grandchild", async () => {
		let pid = 0;
		const r = await runProcess({
			...base,
			timeoutMs: 300,
			argv: ["/bin/sh", "-c", "sleep 600 & sleep 600"],
			onSpawn: (id) => {
				pid = id.pid;
				expect(id.started).not.toBeNull();
			},
		});
		expect(r.timedOut).toBe(true);
		expect(r.exitCode).toBeNull();
		expect(r.terminationConfirmed).toBe(true);
		expect(groupAlive(pid)).toBe(false);
	});

	test("SIGTERM is escalated to SIGKILL for a child that ignores it", async () => {
		let pid = 0;
		const ac = new AbortController();
		const pending = runProcess({
			...base,
			signal: ac.signal,
			argv: js(
				"process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
			),
			onSpawn: (id) => {
				pid = id.pid;
			},
			onStdoutLine: () => ac.abort(),
		});
		const r = await pending;
		expect(r.aborted).toBe(true);
		expect(r.signal).toBe("SIGKILL");
		expect(r.terminationConfirmed).toBe(true);
		expect(groupAlive(pid)).toBe(false);
	});

	test("a background child left behind by a normal exit is reaped", async () => {
		let pid = 0;
		const r = await runProcess({
			...base,
			argv: ["/bin/sh", "-c", "sleep 600 >/dev/null 2>&1 & echo done"],
			onSpawn: (id) => {
				pid = id.pid;
			},
		});
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toBe("done\n");
		expect(r.terminationConfirmed).toBe(true);
		expect(groupAlive(pid)).toBe(false);
	});

	test("an already-aborted signal never spawns; a throwing onSpawn stops the child", async () => {
		const ac = new AbortController();
		ac.abort();
		const never = await runProcess({
			...base,
			signal: ac.signal,
			argv: ["/bin/echo", "x"],
		});
		expect(never).toMatchObject({ spawned: false, aborted: true });

		let pid = 0;
		const r = await runProcess({
			...base,
			argv: js("setInterval(() => {}, 1000)"),
			onSpawn: (id) => {
				pid = id.pid;
				throw new Error("bookkeeping failed");
			},
		});
		expect(r.aborted).toBe(true);
		expect(groupAlive(pid)).toBe(false);
	});
});

describe("child environment", () => {
	test("allowlist only: tokens and API keys are never inherited", () => {
		const env = childEnv(
			{ EXTRA: "1" },
			{
				PATH: "/usr/bin",
				HOME: "/home/u",
				GITHUB_TOKEN: "x",
				INGEST_TOKEN: "x",
				MANAGED_TOKEN: "x",
				ANTHROPIC_API_KEY: "x",
				OPENAI_API_KEY: "x",
				CODEX_API_KEY: "x",
				GIT_DIR: "/somewhere",
			},
		);
		expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/u", EXTRA: "1" });
	});
});

describe("resolveRecorded (orphans from an earlier hub process)", () => {
	test("absent / recycled pid (never signalled) / unverifiable identity / terminated", async () => {
		expect(
			await resolveRecorded({ pid: 2 ** 22 - 3, started: "x" }, 100),
		).toMatchObject({ resolved: true });
		const child = spawn("/bin/sleep", ["600"], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
		const pid = child.pid as number;
		try {
			const recycled = await resolveRecorded(
				{ pid, started: "not its start time" },
				100,
			);
			expect(recycled).toMatchObject({ resolved: true });
			expect(groupAlive(pid)).toBe(true); // not signalled
			expect(await resolveRecorded({ pid, started: null }, 100)).toMatchObject({
				resolved: false,
			});
			expect(
				await resolveRecorded({ pid, started: processStarted(pid) }, 100, {
					...hostProcessOps,
					terminateGroup: async () => false,
				}),
			).toMatchObject({
				resolved: false,
				reason: "termination could not be confirmed",
			});
			expect(groupAlive(pid)).toBe(true);
			expect(
				await resolveRecorded({ pid, started: processStarted(pid) }, 100, {
					...hostProcessOps,
					inspect: () => ({ state: "error", error: "boom" }),
				}),
			).toMatchObject({ resolved: false, reason: "inspection failed: boom" });
			expect(
				await resolveRecorded({ pid, started: processStarted(pid) }, 200),
			).toMatchObject({ resolved: true });
			expect(groupAlive(pid)).toBe(false);
		} finally {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
	});
});
