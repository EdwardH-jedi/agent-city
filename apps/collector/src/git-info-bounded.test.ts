// gitInfo() runs inside the Claude Code hook (Hard rule 4: all work inside 450 ms). Every .git file it
// reads — the worktree's `.git` pointer (gitdir line), `commondir`, `HEAD`, `config` — is filled to
// GIT_FILE_MAX with the shape that makes a backtracking regex go quadratic: one character repeated,
// then a different one at the end. Each call must stay under BUDGET_MS. (Seen: commondir
// "../../" + 60 000 backslashes + "x" took 1.5 s through localRepoId's /[/\\]+$/.)
import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_PATH_MAX } from "@agent-city/schema/core";
import { GIT_FILE_MAX, GIT_INFO_BUDGET_MS, gitInfo } from "./git-info.ts";
import { posixOnly } from "./posix-only.ts";

/** Per call. The quadratic cases took 300–1500 ms at this size; linear code takes a few ms. */
const BUDGET_MS = 100;

const REPEATED = [
	"/",
	"\\",
	" ",
	"\t",
	"\n",
	"\r",
	"a",
	".",
	":",
	"@",
	"=",
	'"',
	"[",
	"#",
	"-",
];
const TAILS = ["x", "\n", "/", "\\"];
/** A commondir ending in a `.git` segment also walks parentOf (the main checkout's folder). */
const EXTRA_TAILS: Record<Slot, string[]> = {
	gitdir: [],
	commondir: ["/.git", "\\.git"],
	HEAD: [],
	config: [],
};

type Slot = "gitdir" | "commondir" | "HEAD" | "config";

/**
 * A main checkout `main/` (its .git a directory) with a linked worktree `wt/` (its .git a file
 * pointing at main/.git/worktrees/wt, whose commondir leads back to main/.git). All good files.
 */
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "agentcity-gitbound-"));
	const main = join(root, "main");
	const common = join(main, ".git");
	const wtGitDir = join(common, "worktrees", "wt");
	const wt = join(root, "wt");
	mkdirSync(wtGitDir, { recursive: true });
	mkdirSync(wt);
	writeFileSync(join(common, "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(
		join(common, "config"),
		'[remote "origin"]\n\turl = https://github.com/octo-example/alpha.git\n',
	);
	writeFileSync(join(wtGitDir, "HEAD"), "ref: refs/heads/wt\n");
	writeFileSync(join(wtGitDir, "commondir"), "../..\n");
	writeFileSync(join(wt, ".git"), `gitdir: ${wtGitDir}\n`);
	return { root, main, common, wtGitDir, wt };
}

/** Where each slot's file lives, which checkout reads it, and the prefixes that reach deeper code. */
function slotSetup(slot: Slot, f: ReturnType<typeof fixture>) {
	switch (slot) {
		case "gitdir":
			return {
				file: join(f.wt, ".git"),
				cwd: f.wt,
				prefixes: ["", "gitdir: ", `gitdir: ${f.wtGitDir}\n`],
			};
		case "commondir":
			return {
				file: join(f.wtGitDir, "commondir"),
				cwd: f.wt,
				prefixes: ["", "../..", "../../"],
			};
		case "HEAD":
			return {
				file: join(f.common, "HEAD"),
				cwd: f.main,
				prefixes: ["", "ref: ", "ref: refs/heads/"],
			};
		case "config":
			return {
				file: join(f.common, "config"),
				cwd: f.main,
				prefixes: [
					"",
					'[remote "origin"]\n\turl = ',
					'[remote "origin"]\n\turl = https://github.com/o/',
					'[remote "origin"]\n\turl = git@github.com:o/',
					'[url "',
				],
			};
	}
}

/** prefix + `c` repeated + tail, exactly GIT_FILE_MAX bytes (the largest file gitInfo reads). */
function filled(prefix: string, c: string, tail: string): string {
	const n = GIT_FILE_MAX - Buffer.byteLength(prefix + tail);
	return `${prefix}${c.repeat(n)}${tail}`;
}

const warm = fixture();
gitInfo(warm.wt); // warm up (JIT) so the first timed case is not penalised
rmSync(warm.root, { recursive: true, force: true });

const show = (s: string) =>
	JSON.stringify(s.length > 24 ? `${s.slice(0, 24)}…` : s);

for (const slot of ["gitdir", "commondir", "HEAD", "config"] as const) {
	describe(`gitInfo on a GIT_FILE_MAX ${slot} of one repeated char + a different last char`, () => {
		test.each(REPEATED)(
			`%j repeated: every call < ${BUDGET_MS} ms`,
			(c) => {
				const f = fixture();
				const { file, cwd, prefixes } = slotSetup(slot, f);
				const slow: string[] = [];
				try {
					for (const tail of [...TAILS, ...EXTRA_TAILS[slot]]) {
						if (tail === c) continue;
						for (const prefix of prefixes) {
							const content = filled(prefix, c, tail);
							expect(Buffer.byteLength(content)).toBe(GIT_FILE_MAX);
							writeFileSync(file, content);
							const t0 = performance.now();
							gitInfo(cwd);
							const ms = performance.now() - t0;
							if (ms >= BUDGET_MS)
								slow.push(
									`prefix ${show(prefix)} tail ${JSON.stringify(tail)}: ${ms.toFixed(0)} ms`,
								);
						}
					}
				} finally {
					rmSync(f.root, { recursive: true, force: true });
				}
				expect(slow).toEqual([]);
			},
			60_000,
		);
	});
}

// ── Limits (repo-slug.ts GIT_*_MAX) ────────────────────────────────────────────────────────────────
// Work that grows with what the config holds (remotes × insteadOf rules × url length) is capped by
// input limits, so the worst case is a constant, not a function of the file. Each shape below is
// built at half and at full GIT_FILE_MAX: both must finish in LIMITS_MS, and doubling the input must
// not add measurable time. (Seen before the limits: no origin, a 16 000 × U+0130 github.com base and
// 2 486 remotes rewritten to it → 960 ms.)
const LIMITS_MS = 50;
/** Doubling the file may add at most this much (a linear scan of 32 KB more, nothing that multiplies). */
const DOUBLING_SLACK_MS = 5;

const bytes = (s: string) => Buffer.byteLength(s);
/** head + units while they fit + space padding + tail: exactly `size` bytes. */
function sized(
	size: number,
	head: string,
	unit: (i: number) => string,
	tail = "",
): string {
	const parts = [head];
	let used = bytes(head) + bytes(tail);
	for (let i = 0; ; i++) {
		const u = unit(i);
		if (used + bytes(u) > size) break;
		parts.push(u);
		used += bytes(u);
	}
	parts.push(" ".repeat(size - used), tail);
	return parts.join("");
}
const I_DOT = "\u0130"; // İ: 2 UTF-8 bytes, and toLowerCase() makes it 2 UTF-16 units

type Bad = {
	name: string;
	slot: "config" | "gitdir" | "commondir";
	make: (size: number) => string;
	/** repo_id gitInfo must still produce (the fixture's main checkout is `main/`, the worktree `wt/`). */
	repo: string;
};
const remote = (i: number, url: string) => `[remote "r${i}"]\n\turl = ${url}\n`;
const BAD: Bad[] = [
	{
		name: "thousands of remotes, each a different github repo",
		slot: "config",
		make: (n) => sized(n, "", (i) => remote(i, `https://github.com/o/r${i}`)),
		repo: "local/main",
	},
	{
		name: "thousands of remotes, all the same github repo",
		slot: "config",
		make: (n) => sized(n, "", (i) => remote(i, "https://github.com/o/r.git")),
		repo: "local/main",
	},
	{
		name: "long base x many remotes (Codex: U+0130 base, no origin)",
		slot: "config",
		make: (n) =>
			sized(
				n,
				`[url "https://github.com/o/${I_DOT.repeat(Math.floor(n / 4))}"]\n\tinsteadOf = g\n`,
				(i) => remote(i, "g"),
			),
		repo: "local/main",
	},
	{
		name: "thousands of insteadOf rules x thousands of remotes",
		slot: "config",
		make: (n) => {
			const rules = sized(
				Math.floor(n / 2),
				'[url "https://github.com/o/r"]\n',
				(i) => `\tinsteadOf = p${i}\n`,
			);
			return sized(n, rules, (i) => remote(i, `p${i}x`));
		},
		repo: "local/main",
	},
	{
		name: "U+0130 repeated in origin's url",
		slot: "config",
		make: (n) =>
			sized(
				n,
				'[remote "origin"]\n\turl = https://github.com/o/',
				() => I_DOT,
				"x",
			),
		repo: "local/main",
	},
	{
		name: "U+0130 repeated in a remote's name (its url, by default)",
		slot: "config",
		make: (n) => sized(n, '[remote "', () => I_DOT, '"]\n'),
		repo: "local/main",
	},
	{
		name: "long section name",
		slot: "config",
		make: (n) => sized(n, "[", () => "a", "]\n"),
		repo: "local/main",
	},
	{
		name: "long legacy remote name [remote.aaa…]",
		slot: "config",
		make: (n) => sized(n, "[remote.", () => "a", "]\n"),
		repo: "local/main",
	},
	{
		name: "quoted subsection full of backslashes",
		slot: "config",
		make: (n) => sized(n, '[remote "', () => "\\\\", '"]\n'),
		repo: "local/main",
	},
	{
		name: "one line, no newline",
		slot: "config",
		make: (n) => sized(n, "", () => "a"),
		repo: "local/main",
	},
	{
		name: "one line: origin + a comment to the end of the file",
		slot: "config",
		make: (n) =>
			sized(
				n,
				'[remote "origin"] url = https://github.com/o/r.git #',
				() => "x",
			),
		repo: "o/r",
	},
	{
		name: "the same remote section repeated",
		slot: "config",
		make: (n) =>
			sized(
				n,
				"",
				() => '[remote "origin"]\n\turl = https://github.com/o/r.git\n',
			),
		repo: "o/r",
	},
	{
		name: "long gitdir path",
		slot: "gitdir",
		make: (n) => sized(n, "gitdir: /", () => "a/", "\n"),
		repo: "local/wt",
	},
	{
		name: "long commondir path",
		slot: "commondir",
		make: (n) => sized(n, "../../", () => "a/", "\n"),
		repo: "local/wt",
	},
];

function placeBad(f: ReturnType<typeof fixture>, bad: Bad, content: string) {
	if (bad.slot === "config") {
		writeFileSync(join(f.common, "config"), content);
		return f.main;
	}
	writeFileSync(
		bad.slot === "gitdir" ? join(f.wt, ".git") : join(f.wtGitDir, "commondir"),
		content,
	);
	return f.wt;
}
/** Median of 5 calls (the first one warms up). */
function timed(cwd: string): { ms: number; repo: string | undefined } {
	const runs: number[] = [];
	let repo: string | undefined;
	for (let k = 0; k < 6; k++) {
		const t0 = performance.now();
		repo = gitInfo(cwd)?.repo_id;
		if (k > 0) runs.push(performance.now() - t0);
	}
	runs.sort((a, b) => a - b);
	return { ms: runs[2] as number, repo };
}

describe(`gitInfo on bad configs and paths: < ${LIMITS_MS} ms, flat when the input doubles`, () => {
	test.each(BAD.map((b) => [b.name, b] as const))(
		"%s",
		(_, bad) => {
			const f = fixture();
			try {
				const full = bad.make(GIT_FILE_MAX);
				const half = bad.make(GIT_FILE_MAX / 2);
				expect(bytes(full)).toBe(GIT_FILE_MAX);
				expect(bytes(half)).toBe(GIT_FILE_MAX / 2);
				const cwd = placeBad(f, bad, half);
				const h = timed(cwd);
				placeBad(f, bad, full);
				const t = timed(cwd);
				expect({ half: h.repo, full: t.repo }).toEqual({
					half: bad.repo,
					full: bad.repo,
				});
				expect(t.ms).toBeLessThan(LIMITS_MS);
				expect(h.ms).toBeLessThan(LIMITS_MS);
				expect(t.ms - h.ms).toBeLessThan(DOUBLING_SLACK_MS);
			} finally {
				rmSync(f.root, { recursive: true, force: true });
			}
		},
		60_000,
	);

	test("a cwd over GIT_PATH_MAX chars (the hook clips to 4 096 + an ellipsis): null at once", () => {
		const f = fixture();
		try {
			for (const n of [GIT_PATH_MAX + 1, 1 << 20]) {
				const cwd = `${f.main}/${"a/".repeat(n / 2)}`;
				const t0 = performance.now();
				expect(gitInfo(cwd)).toBeNull();
				expect(performance.now() - t0).toBeLessThan(LIMITS_MS);
			}
			// under the limit a cwd below the checkout (not created) still walks up to it
			const deep = `${f.main}/${"b".repeat(GIT_PATH_MAX - f.main.length - 1)}`;
			expect(deep).toHaveLength(GIT_PATH_MAX);
			expect(gitInfo(deep)?.repo_id).toBe("octo-example/alpha");
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	test(`over the time budget (${GIT_INFO_BUDGET_MS} ms) between steps: local/<folder>, never a throw`, () => {
		const f = fixture();
		try {
			expect(gitInfo(f.main)?.repo_id).toBe("octo-example/alpha");
			let t = 0;
			const slowClock = () => {
				t += GIT_INFO_BUDGET_MS; // every step looks like it took the whole budget
				return t;
			};
			expect(gitInfo(f.main, slowClock)).toEqual({
				toplevel: f.main,
				repo_id: "local/main",
				branch: null,
			});
			expect(gitInfo(f.wt, slowClock)?.repo_id).toBe("local/wt");
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	// POSIX-only: spawns bin/claude-hook, a `#!/bin/sh` launcher that SIGKILLs the hook at 0.6 s — so a
	// slow gitInfo() (it runs before the spool append) loses the event and this test fails.
	posixOnly(
		"the real hook on the Codex config: exit 0, the event is spooled as local/<folder>",
		async () => {
			const f = fixture();
			const home = mkdtempSync(join(tmpdir(), "agentcity-gitbound-home-"));
			try {
				const codex = BAD.find((b) => b.name.startsWith("long base"));
				placeBad(f, codex as Bad, (codex as Bad).make(GIT_FILE_MAX));
				const proc = Bun.spawn(
					[join(import.meta.dir, "..", "bin", "claude-hook")],
					{
						cwd: f.main,
						env: {
							...process.env,
							AGENTCITY_HOME: home,
							HUB_URL: "http://127.0.0.1:9",
							INGEST_TOKEN: "gitbound-test-only",
						},
						stdin: new TextEncoder().encode(
							JSON.stringify({
								hook_event_name: "PreToolUse",
								session_id: "gitbound-1",
								cwd: f.main,
								tool_name: "Bash",
								tool_input: { command: "ls" },
								tool_use_id: "toolu_gitbound",
							}),
						),
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				expect(await proc.exited).toBe(0);
				const spooled = readdirSync(home)
					// spool.jsonl, or spool.<µs>.<pid>.<rand>.flushing once a send failed (hub unreachable here)
					.filter((n) => n.startsWith("spool") && !n.includes("stats"))
					.map((n) => readFileSync(join(home, n), "utf8"))
					.join("");
				const events = spooled
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l));
				expect(events.map((e) => e.repo_id)).toEqual(["local/main"]);
			} finally {
				rmSync(f.root, { recursive: true, force: true });
				rmSync(home, { recursive: true, force: true });
			}
		},
	);
});
