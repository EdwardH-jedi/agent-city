// The CI browser tooling's own guarantees: the isolation wrapper clears the environment, enforces its
// time limit and leaves no process behind; the evidence collector copies only its allowlist and never
// uploads a text file that matches a secret pattern. Fake tokens are built at runtime.
import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

const HERE = import.meta.dir;
const scratch = mkdtempSync(join(tmpdir(), "agentcity-ci-tools-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(cmd: string[], env: Record<string, string> = {}) {
	const p = Bun.spawnSync(cmd, {
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
}

function files(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true }))
			if (e.isDirectory()) walk(join(d, e.name));
			else out.push(relative(dir, join(d, e.name)));
	};
	walk(dir);
	return out.sort();
}

describe("isolated.ts", () => {
	const root = join(scratch, "iso");
	const wrap = (label: string, timeout: number, ...cmd: string[]) =>
		run(
			[
				"bun",
				join(HERE, "isolated.ts"),
				"--root",
				root,
				"--label",
				label,
				"--timeout",
				String(timeout),
				"--",
				...cmd,
			],
			{ MANAGED_TOKEN: "must-not-leak", AGENTCITY_TEST_MARKER: "x" },
		);

	test("only the isolation variables reach the command; fresh dirs; run.json", () => {
		const r = wrap(
			"env",
			30,
			"bun",
			"-e",
			"console.log(JSON.stringify({ keys: Object.keys(process.env).sort(), home: process.env.HOME, tmp: process.env.TMPDIR }))",
		);
		expect(r.code).toBe(0);
		const seen = JSON.parse(r.out.trim().split("\n").at(-1) ?? "{}");
		expect(seen.keys).toEqual([
			"AGENTCITY_HOME",
			"HOME",
			"LANG",
			"PATH",
			"TMPDIR",
			"TZ",
		]);
		expect(seen.home).toBe(join(root, "env", "home"));
		expect(seen.tmp).toBe(`${join(root, "env", "tmp")}/`);
		const meta = JSON.parse(
			readFileSync(join(root, "env", "run.json"), "utf8"),
		);
		expect(meta).toMatchObject({ label: "env", exit: 0, stopped_by: null });
		expect(readFileSync(join(root, "env", "suite.log"), "utf8")).toContain(
			"AGENTCITY_HOME",
		);
		// a label is never reused
		expect(wrap("env", 5, "bun", "-e", "0").code).toBe(2);
	});

	test("the time limit stops the command (exit 124)", () => {
		const r = wrap("slow", 1, "bun", "-e", "setInterval(() => {}, 1000)");
		expect(r.code).toBe(124);
		expect(
			JSON.parse(readFileSync(join(root, "slow", "run.json"), "utf8"))
				.stopped_by,
		).toBe("time limit 1 s");
	});

	test("a failing command's own exit code passes through (not interrupted)", () => {
		const r = wrap("fail7", 30, "bun", "-e", "process.exit(7)");
		expect(r.code).toBe(7);
		expect(
			JSON.parse(readFileSync(join(root, "fail7", "run.json"), "utf8")),
		).toMatchObject({
			exit: 7,
			child_exit: 7,
			child_signal: null,
			interrupted: false,
			stopped_by: null,
		});
	});

	test("a signal the wrapper did not send → 128 + its number (SIGHUP → 129)", () => {
		const r = wrap(
			"sighup",
			30,
			"bun",
			"-e",
			'process.kill(process.pid, "SIGHUP"); setInterval(() => {}, 1000)',
		);
		expect(r.code).toBe(129);
		expect(
			JSON.parse(readFileSync(join(root, "sighup", "run.json"), "utf8")),
		).toMatchObject({
			exit: 129,
			child_exit: null,
			child_signal: "SIGHUP",
			interrupted: false,
		});
	});

	/**
	 * Interrupt the wrapper (job cancellation) once the command is demonstrably running: the command writes
	 * a readiness marker, traps the signal and exits 0 — the run must still not count as a success.
	 */
	async function interrupt(label: string, signal: "SIGTERM" | "SIGINT") {
		const ready = join(scratch, `${label}.ready`);
		const child = [
			'const fs = require("fs");',
			'process.on("SIGTERM", () => process.exit(0));',
			'process.on("SIGINT", () => process.exit(0));',
			`fs.writeFileSync(${JSON.stringify(ready)}, "ready");`,
			"setInterval(() => {}, 1000);",
		].join(" ");
		const p = Bun.spawn(
			[
				"bun",
				join(HERE, "isolated.ts"),
				"--root",
				root,
				"--label",
				label,
				"--timeout",
				"60",
				"--",
				"bun",
				"-e",
				child,
			],
			{ stdout: "ignore", stderr: "ignore" },
		);
		const t0 = Date.now();
		while (!existsSync(ready)) {
			if (Date.now() - t0 > 20_000) throw new Error("child never became ready");
			await Bun.sleep(25);
		}
		p.kill(signal);
		const code = await p.exited;
		return {
			code,
			meta: JSON.parse(readFileSync(join(root, label, "run.json"), "utf8")),
		};
	}

	test("SIGTERM after the command is ready → 143 even though the command exits 0", async () => {
		const { code, meta } = await interrupt("term-trap", "SIGTERM");
		expect(code).toBe(143);
		expect(meta).toMatchObject({
			exit: 143,
			child_exit: 0,
			child_signal: null,
			interrupted: true,
			stopped_by: "SIGTERM",
		});
	});

	test("SIGINT after the command is ready → 130 even though the command exits 0", async () => {
		const { code, meta } = await interrupt("int-trap", "SIGINT");
		expect(code).toBe(130);
		expect(meta).toMatchObject({
			exit: 130,
			child_exit: 0,
			interrupted: true,
			stopped_by: "SIGINT",
		});
	});

	test("--set passes only *_ONLY test selectors given on the command line", () => {
		const r = run(
			[
				"bun",
				join(HERE, "isolated.ts"),
				"--root",
				root,
				"--label",
				"set-ok",
				"--timeout",
				"30",
				"--set",
				"M1_ONLY=BRW-P-06|BRW-R-2[34]",
				"--set",
				"CAMPUS_ONLY=CAM-01",
				"--",
				"bun",
				"-e",
				"console.log(JSON.stringify({ m1: process.env.M1_ONLY, campus: process.env.CAMPUS_ONLY, keys: Object.keys(process.env).length }))",
			],
			{ M1_ONLY: "inherited-must-not-win" },
		);
		expect(r.code).toBe(0);
		expect(JSON.parse(r.out.trim().split("\n").at(-1) ?? "{}")).toEqual({
			m1: "BRW-P-06|BRW-R-2[34]",
			campus: "CAM-01",
			keys: 8,
		});
		const refused = (label: string, ...opt: string[]) =>
			run([
				"bun",
				join(HERE, "isolated.ts"),
				"--root",
				root,
				"--label",
				label,
				"--timeout",
				"30",
				...opt,
				"--",
				"bun",
				"-e",
				"0",
			]).code;
		expect(refused("set-home", "--set", "HOME=/tmp")).toBe(2);
		expect(refused("set-token", "--set", "MANAGED_TOKEN=x")).toBe(2);
		expect(refused("set-noeq", "--set", "M1_ONLY")).toBe(2);
		expect(refused("set-nl", "--set", "M1_ONLY=a\nb")).toBe(2);
		expect(refused("set-long", "--set", `M1_ONLY=${"x".repeat(201)}`)).toBe(2);
		expect(refused("set-unknown", "--env", "M1_ONLY=x")).toBe(2);
		// refused runs never created their directory
		expect(existsSync(join(root, "set-home"))).toBe(false);
	});

	// RUN-P2-01: launch failures settle promptly. Every case here runs under an OUTER bound independent
	// of isolated.ts (the wrapper is SIGKILLed if it is still alive), so a regression fails instead of
	// hanging the suite; reaching the outer bound is itself a failure.
	async function bounded(
		label: string,
		timeout: number,
		cmd: string[],
		outerMs = 4_000, // below bun test's 5 s per-test limit, so a hang is reported by this bound
	): Promise<{ code: number | null; outerHit: boolean; ms: number }> {
		const t0 = Date.now();
		const p = Bun.spawn(
			[
				"bun",
				join(HERE, "isolated.ts"),
				"--root",
				root,
				"--label",
				label,
				"--timeout",
				String(timeout),
				"--",
				...cmd,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		let outerHit = false;
		const outer = setTimeout(() => {
			outerHit = true;
			p.kill("SIGKILL");
		}, outerMs);
		const code = await p.exited;
		clearTimeout(outer);
		return { code: outerHit ? null : code, outerHit, ms: Date.now() - t0 };
	}
	const meta = (label: string) =>
		JSON.parse(readFileSync(join(root, label, "run.json"), "utf8"));

	test("a command that does not exist (ENOENT) settles at once: exit 127, run.json written, nothing signalled", async () => {
		const r = await bounded("enoent", 3, ["no-such-agentcity-command"]);
		expect(r.outerHit).toBe(false);
		expect(r.code).toBe(127);
		expect(r.ms).toBeLessThan(3_000); // before its own 3 s time limit
		expect(meta("enoent")).toMatchObject({
			exit: 127,
			launch_error: "ENOENT",
			process_group_created: false,
			cleanup_status: "no_process_launched", // never "cleaned up" from a missing pid
			cleanup_kill_attempted: false,
			leftover_processes_killed: false,
			child_exit: null,
			interrupted: false,
			stopped_by: null,
		});
	});

	test("a command that is not executable (EACCES) settles at once: exit 126", async () => {
		const file = join(scratch, "not-executable.sh");
		writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
		const r = await bounded("eacces", 3, [file]);
		expect(r.outerHit).toBe(false);
		expect(r.code).toBe(126);
		expect(meta("eacces")).toMatchObject({
			exit: 126,
			launch_error: "EACCES",
			process_group_created: false,
			cleanup_status: "no_process_launched",
		});
	});

	test("a launch failure racing a 1 s time limit still has exactly one outcome (127, not 124)", async () => {
		const r = await bounded("enoent-race", 1, ["no-such-agentcity-command"]);
		expect(r.outerHit).toBe(false);
		expect(r.code).toBe(127);
		expect(meta("enoent-race").stopped_by).toBeNull();
	});

	test("bounded: success and nonzero exits still pass through with a confirmed-absent group", async () => {
		const ok = await bounded("bounded-ok", 10, ["/bin/sh", "-c", "exit 0"]);
		const bad = await bounded("bounded-bad", 10, ["/bin/sh", "-c", "exit 5"]);
		expect([ok.outerHit, ok.code, bad.outerHit, bad.code]).toEqual([
			false,
			0,
			false,
			5,
		]);
		expect(meta("bounded-ok")).toMatchObject({
			launch_error: null,
			process_group_created: true,
			cleanup_status: "confirmed_absent",
		});
		expect(meta("bounded-bad").child_exit).toBe(5);
	});

	test("processes left behind are killed; the exit code is the command's", () => {
		const marker = `agentcity-orphan-${process.pid}`;
		const r = wrap(
			"orphan",
			30,
			"/bin/sh",
			"-c",
			`bun -e "setInterval(() => {}, 1000)" ${marker} & exit 3`,
		);
		expect(r.code).toBe(3);
		expect(
			JSON.parse(readFileSync(join(root, "orphan", "run.json"), "utf8"))
				.leftover_processes_killed,
		).toBe(true);
		expect(run(["pgrep", "-f", marker]).code).toBe(1); // none left
	});
});

describe("collect-browser-evidence.ts", () => {
	const root = join(scratch, "collect");
	const put = (path: string, body = "x") => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), body);
	};
	const clean = JSON.stringify({
		results: [{ status: "PASS" }, { status: "PASS" }, { status: "NOT RUN" }],
	});
	// allowlisted
	put("hub/run.json", JSON.stringify({ exit: 0, seconds: 12 }));
	put("hub/suite.log", "[HUB] PASS 2 · FAIL 0");
	put("hub/tmp/agentcity-m1-09-hub-Ab12/results.json", clean);
	put("hub/tmp/agentcity-m1-09-hub-Ab12/HUB-1440x900-01-shot.png");
	put("legacy/suite.log", "\n27/27 browser checks passed\n");
	put("legacy/tmp/agentcity-browser-evidence-Zz9/01-observed.png");
	put("multi/run.json", JSON.stringify({ exit: 0, seconds: 30 }));
	put("multi/tmp/agentcity-m1-09-multi-Mm1/results.json", clean);
	put("multi/tmp/agentcity-m1-09-multi-Mm1/MULTI-1440x900-01-repos.png");
	// never copied
	put("hub/home/.bashrc");
	put("hub/agentcity/spool.json");
	put("hub/tmp/agentcity-m1-09-hub-Ab12/HUB-A07-aria-snapshot.yml");
	put("hub/tmp/agentcity-m1-09-hub-Ab12/state.sqlite");
	put("hub/tmp/agentcity-m1-09-hub-Ab12/nested/deep.png");
	put("hub/tmp/m1-fixture-abc/repo/file.png");
	put("hub/tmp/agentcity-m1-env-q1/vite-cache/x.png");
	symlinkSync(
		"/etc/hosts",
		join(root, "hub/tmp/agentcity-m1-09-hub-Ab12/link.png"),
	);
	// a secret-shaped value in a results file is blocked, never copied
	const fake = `ghp_${"a1B2".repeat(9)}`;
	put("leaky/tmp/agentcity-m1-09-fx-Q1/results.json", `{"detail":"${fake}"}`);

	const out = join(scratch, "evidence");
	const summary = join(scratch, "step-summary.md");
	const r = run([
		"bun",
		join(HERE, "collect-browser-evidence.ts"),
		"--root",
		root,
		"--out",
		out,
		"--summary",
		summary,
	]);

	test("copies exactly the allowlist", () => {
		expect(files(out)).toEqual([
			"SUMMARY.md",
			"hub/agentcity-m1-09-hub-Ab12/HUB-1440x900-01-shot.png",
			"hub/agentcity-m1-09-hub-Ab12/results.json",
			"hub/run.json",
			"hub/suite.log",
			"legacy/agentcity-browser-evidence-Zz9/01-observed.png",
			"legacy/suite.log",
			"multi/agentcity-m1-09-multi-Mm1/MULTI-1440x900-01-repos.png",
			"multi/agentcity-m1-09-multi-Mm1/results.json",
			"multi/run.json",
		]);
	});

	test("a secret-pattern hit fails the step and names the file, never the value", () => {
		expect(r.code).toBe(1);
		const md = readFileSync(summary, "utf8");
		expect(md).toContain(
			"leaky/agentcity-m1-09-fx-Q1/results.json:1 github token",
		);
		expect(md + r.out + r.err).not.toContain(fake);
		expect(existsSync(join(out, "leaky"))).toBe(false);
	});

	test("the summary reports records per suite", () => {
		const md = readFileSync(join(out, "SUMMARY.md"), "utf8");
		expect(md).toContain("| hub | 0 | PASS 2 · NOT RUN 1 | 12 |");
		expect(md).toContain("| legacy | unknown | 27/27 checks passed | ? |");
	});
});
