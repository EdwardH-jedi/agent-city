// Git operations for managed workspaces. Local only — nothing here fetches, pushes or talks to a
// remote. The user's global/system git config and hooks are not applied (GIT_CONFIG_GLOBAL=/dev/null,
// core.hooksPath=/dev/null), so a run behaves the same on every machine and cannot trigger a hook.
//
// A worktree is Git isolation (its own branch + working directory), NOT a security sandbox: a
// process started in it has the hub user's full filesystem and network access.
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, sep } from "node:path";
import { childEnv, runProcess } from "./proc.ts";

export interface GitCtx {
	git: string;
	killGraceMs: number;
}

export class GitError extends Error {
	constructor(
		message: string,
		readonly detail: string,
	) {
		super(message);
		this.name = "GitError";
	}
}

const BASE_ARGS = [
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"commit.gpgsign=false",
	"-c",
	"user.name=Agent City",
	"-c",
	"user.email=agent-city@localhost",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"advice.detachedHead=false",
];

const GIT_ENV = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_TERMINAL_PROMPT: "0",
};

const GIT_TIMEOUT_MS = 60_000;

async function gitRaw(
	ctx: GitCtx,
	cwd: string,
	args: readonly string[],
	maxOutputBytes = 4_000_000,
) {
	return runProcess({
		argv: [ctx.git, ...BASE_ARGS, ...args],
		cwd,
		env: childEnv(GIT_ENV),
		timeoutMs: GIT_TIMEOUT_MS,
		maxOutputBytes,
		killGraceMs: ctx.killGraceMs,
	});
}

async function gitOk(
	ctx: GitCtx,
	cwd: string,
	args: readonly string[],
): Promise<string> {
	const r = await gitRaw(ctx, cwd, args);
	if (!r.spawned)
		throw new GitError("git could not be started", r.spawnError ?? "");
	if (r.exitCode !== 0 || r.timedOut)
		throw new GitError(
			`git ${args[0]} failed (exit ${r.exitCode ?? "none"})`,
			r.stderr.slice(0, 500),
		);
	return r.stdout;
}

const SHA = /^[0-9a-f]{40}$/;

/** Is `child` the same as or inside `parent`? Both must already be canonical (realpath). */
export function isInside(parent: string, child: string): boolean {
	return child === parent || child.startsWith(parent + sep);
}

/** Canonical path of the deepest existing ancestor + the remaining (not yet existing) tail. */
export function canonicalize(path: string): string {
	let existing = path;
	const tail: string[] = [];
	while (!existsSync(existing)) {
		const up = dirname(existing);
		if (up === existing) break;
		tail.unshift(existing.slice(up.length).replace(/^[/\\]/, ""));
		existing = up;
	}
	const real = realpathSync(existing);
	return tail.length > 0 ? [real, ...tail].join(sep) : real;
}

/**
 * The configured repo must be a directory that is the top level of a git work tree, and must not
 * overlap the workspace/artifact roots. Returns its canonical path.
 */
export async function validateRepo(
	ctx: GitCtx,
	repoPath: string,
	roots: readonly string[],
): Promise<string> {
	let real: string;
	try {
		real = realpathSync(repoPath);
		if (!statSync(real).isDirectory()) throw new Error("not a directory");
	} catch {
		throw new GitError("configured repo path does not exist", repoPath);
	}
	const top = (await gitOk(ctx, real, ["rev-parse", "--show-toplevel"])).trim();
	if (realpathSync(top) !== real)
		throw new GitError(
			"configured repo path is not a repository top level",
			"",
		);
	for (const root of roots) {
		const r = canonicalize(root);
		if (isInside(real, r) || isInside(r, real))
			throw new GitError("workspace/artifact root overlaps the repo", "");
	}
	return real;
}

export async function resolveCommit(
	ctx: GitCtx,
	repoPath: string,
	ref: string,
): Promise<string> {
	const out = (
		await gitOk(ctx, repoPath, [
			"rev-parse",
			"--verify",
			"--quiet",
			"--end-of-options",
			`${ref}^{commit}`,
		])
	).trim();
	if (!SHA.test(out)) throw new GitError("ref did not resolve to a commit", "");
	return out;
}

export async function treeOf(
	ctx: GitCtx,
	cwd: string,
	sha: string,
): Promise<string> {
	return (
		await gitOk(ctx, cwd, ["rev-parse", "--verify", `${sha}^{tree}`])
	).trim();
}

/** `git worktree add -b <branch> <path> <sha>`; the path must not exist and must be under `root`. */
export async function addWorktree(
	ctx: GitCtx,
	repoPath: string,
	root: string,
	path: string,
	branch: string,
	sha: string,
): Promise<string> {
	mkdirSync(dirname(path), { recursive: true });
	const canonical = canonicalize(path);
	if (!isInside(canonicalize(root), canonical) || existsSync(canonical))
		throw new GitError("worktree path is not a fresh path under the root", "");
	await gitOk(ctx, repoPath, [
		"worktree",
		"add",
		"-b",
		branch,
		"--",
		canonical,
		sha,
	]);
	return canonical;
}

export interface Fingerprint {
	head: string;
	/** No staged, unstaged or untracked (non-ignored) changes. */
	clean: boolean;
	/** `git status --porcelain` text, bounded — for the failure detail only. */
	status: string;
}

/**
 * Identity of a workspace right now: HEAD plus everything not committed. A candidate SHA alone is
 * not enough — the working tree may have been changed after the commit was made.
 */
export async function fingerprint(
	ctx: GitCtx,
	worktree: string,
): Promise<Fingerprint> {
	const head = (await gitOk(ctx, worktree, ["rev-parse", "HEAD"])).trim();
	const status = await gitOk(ctx, worktree, [
		"status",
		"--porcelain=v1",
		"--untracked-files=all",
	]);
	return {
		head,
		clean: status.trim().length === 0,
		status: status.slice(0, 400),
	};
}

/** null when the workspace is exactly `sha` with nothing uncommitted, else what differs. */
export async function mutationSince(
	ctx: GitCtx,
	worktree: string,
	sha: string,
): Promise<string | null> {
	const fp = await fingerprint(ctx, worktree);
	if (fp.head !== sha) return `HEAD moved to ${fp.head}`;
	if (!fp.clean) return `uncommitted changes: ${fp.status.trim()}`;
	return null;
}

/**
 * Checkpoint everything in the workspace (tracked, modified, untracked non-ignored) as one commit
 * and return HEAD. If the implementer already committed, those commits are part of the candidate.
 */
export async function captureCandidate(
	ctx: GitCtx,
	worktree: string,
	message: string,
): Promise<string> {
	await gitOk(ctx, worktree, ["add", "-A", "--", "."]);
	const staged = await gitRaw(ctx, worktree, ["diff", "--cached", "--quiet"]);
	if (staged.exitCode === 1)
		await gitOk(ctx, worktree, [
			"commit",
			"--no-verify",
			"--quiet",
			"-m",
			message,
		]);
	else if (staged.exitCode !== 0)
		throw new GitError("git diff --cached failed", staged.stderr.slice(0, 500));
	return (await gitOk(ctx, worktree, ["rev-parse", "HEAD"])).trim();
}

export interface ChangedFile {
	status: string;
	path: string;
}

export async function changedFiles(
	ctx: GitCtx,
	cwd: string,
	base: string,
	head: string,
): Promise<ChangedFile[]> {
	const out = await gitOk(ctx, cwd, [
		"diff",
		"--name-status",
		"--no-renames",
		"-z",
		base,
		head,
	]);
	const parts = out.split("\0").filter((p) => p.length > 0);
	const files: ChangedFile[] = [];
	for (let i = 0; i + 1 < parts.length; i += 2)
		files.push({ status: parts[i] as string, path: parts[i + 1] as string });
	return files;
}

export async function diffText(
	ctx: GitCtx,
	cwd: string,
	base: string,
	head: string,
	maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
	const r = await gitRaw(
		ctx,
		cwd,
		["diff", "--no-color", "--no-ext-diff", "--no-textconv", base, head],
		maxBytes,
	);
	if (!r.spawned || r.exitCode !== 0)
		throw new GitError("git diff failed", r.stderr.slice(0, 500));
	return { text: r.stdout, truncated: r.stdoutTruncated };
}

/** Does every changed path sit under one of the approved prefixes? `.` approves the whole repo. */
export function outOfScope(
	files: readonly ChangedFile[],
	scope: readonly string[],
): string[] {
	if (scope.includes(".")) return [];
	const prefixes = scope.map((s) => s.replace(/\/+$/, ""));
	return files
		.map((f) => f.path)
		.filter(
			(p) => !prefixes.some((pre) => p === pre || p.startsWith(`${pre}/`)),
		);
}
