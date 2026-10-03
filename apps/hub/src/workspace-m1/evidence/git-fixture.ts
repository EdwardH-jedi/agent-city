// Test-only: disposable git repositories under TMPDIR producing REAL `git diff` output (same flags
// as the hub's diffText) and a GitRunner over the hub's runProcess. No global/system git config,
// no hooks, no network. Contents are synthetic; secrets in tests are assembled at runtime.
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { childEnv, runProcess } from "../../managed/proc.ts";
import type { GitRunner } from "./context-loader.ts";

export const GIT = Bun.which("git") ?? "git";
const GIT_ENV = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_TERMINAL_PROMPT: "0",
};
const BASE = [
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"commit.gpgsign=false",
	"-c",
	"user.name=Fixture",
	"-c",
	"user.email=fixture@localhost",
	"-c",
	"core.autocrlf=false",
];

export type FileSpec =
	| string
	| Uint8Array
	| { symlink: string }
	| { text: string; mode: 0o755 }
	| null;
export type Tree = Record<string, FileSpec>;

const dirs: string[] = [];

export function cleanupFixtures(): void {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function gitSync(repo: string, ...args: string[]): string {
	const r = Bun.spawnSync([GIT, ...BASE, ...args], {
		cwd: repo,
		env: childEnv(GIT_ENV),
	});
	if (r.exitCode !== 0) throw new Error(`fixture git ${args[0]} failed`);
	return r.stdout.toString();
}

function apply(repo: string, tree: Tree) {
	for (const [path, spec] of Object.entries(tree)) {
		const abs = join(repo, path);
		if (spec === null) {
			rmSync(abs, { force: true });
			continue;
		}
		mkdirSync(dirname(abs), { recursive: true });
		rmSync(abs, { force: true });
		if (typeof spec === "string" || spec instanceof Uint8Array)
			writeFileSync(abs, spec);
		else if ("symlink" in spec) symlinkSync(spec.symlink, abs);
		else {
			writeFileSync(abs, spec.text);
			chmodSync(abs, spec.mode);
		}
	}
}

export interface Scenario {
	repo: string;
	base: string;
	head: string;
	diff: string;
	git: GitRunner;
}

/** Commit `before`, apply `after` (null deletes), commit, diff base..head like the hub does. */
export function scenario(before: Tree, after: Tree): Scenario {
	const repo = mkdtempSync(join(tmpdir(), "ac-m1-evidence-"));
	dirs.push(repo);
	gitSync(repo, "init", "-q", ".");
	apply(repo, before);
	gitSync(repo, "add", "-A");
	gitSync(repo, "commit", "-q", "--allow-empty", "-m", "base");
	const base = gitSync(repo, "rev-parse", "HEAD").trim();
	apply(repo, after);
	gitSync(repo, "add", "-A");
	gitSync(repo, "commit", "-q", "--allow-empty", "-m", "head");
	const head = gitSync(repo, "rev-parse", "HEAD").trim();
	const diff = gitSync(
		repo,
		"diff",
		"--no-color",
		"--no-ext-diff",
		"--no-textconv",
		base,
		head,
	);
	return { repo, base, head, diff, git: runnerFor(repo) };
}

export function runnerFor(repo: string): GitRunner {
	return (args, maxOutputBytes) =>
		runProcess({
			argv: [GIT, ...BASE, ...args],
			cwd: repo,
			env: childEnv(GIT_ENV),
			timeoutMs: 15_000,
			maxOutputBytes,
			killGraceMs: 200,
		});
}
