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
