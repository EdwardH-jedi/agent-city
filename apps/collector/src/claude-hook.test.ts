import { expect, test } from "bun:test";

const HOOK = `${import.meta.dir}/claude-hook.ts`;

test("claude-hook exits 0 and prints nothing, even on garbage input", async () => {
	const proc = Bun.spawn(["bun", HOOK], {
		stdin: new TextEncoder().encode("{not json"),
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(await proc.exited).toBe(0);
	expect(await new Response(proc.stdout).text()).toBe("");
});

test("stdin left open after '{}' → exit 0 within 600ms (watchdog)", async () => {
	const t0 = performance.now();
	const proc = Bun.spawn(["bun", HOOK], {
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
	const proc = Bun.spawn(["bun", HOOK], {
		stdin: new TextEncoder().encode(`{"x":"${"a".repeat(3 * 1024 * 1024)}"}`),
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(await proc.exited).toBe(0);
	expect(await new Response(proc.stdout).text()).toBe("");
});
