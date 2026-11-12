// gitInfo() runs inside the Claude Code hook (Hard rule 4: all work inside 450 ms). Every .git file it
// reads — the worktree's `.git` pointer (gitdir line), `commondir`, `HEAD`, `config` — is filled to
// GIT_FILE_MAX with the shape that makes a backtracking regex go quadratic: one character repeated,
// then a different one at the end. Each call must stay under BUDGET_MS. (Seen: commondir
// "../../" + 60 000 backslashes + "x" took 1.5 s through localRepoId's /[/\\]+$/.)
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_FILE_MAX, gitInfo } from "./git-info.ts";

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
