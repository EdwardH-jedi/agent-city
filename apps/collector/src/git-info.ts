// cwd → {toplevel, repo_id, branch} by reading .git files directly (no `git` spawn: the hook has a
// ~50ms budget). The repo id rule is the hub's local scan's (github/local.ts + sync.ts), both from
// @agent-city/schema repo-slug.ts:
//   githubRepoFromConfig(the common config) ?? localRepoId(toplevel, common dir of a worktree)
// (origin's github repo; with no origin, the one github repo among the remotes; else local/<folder>,
// the main checkout's folder for a linked worktree)
// Remote URLs can embed credentials; only the parsed slug leaves this module.
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	GIT_PATH_MAX,
	githubRepoFromConfig,
	localRepoId,
	remotesFromConfig,
} from "@agent-city/schema/core";

export interface GitInfo {
	toplevel: string;
	repo_id: string;
	branch: string | null;
}

/** Largest .git metadata file we'll read (HEAD, config, commondir, gitdir pointer). */
export const GIT_FILE_MAX = 64 * 1024;
/**
 * Backstop for the whole of gitInfo(): past it, checked between steps, the answer is local/<folder>.
 * The input limits (GIT_*_MAX in @agent-city/schema repo-slug.ts) are what bound the work; this only
 * catches what they don't (a slow disk, a stalled filesystem call that eventually returns).
 */
export const GIT_INFO_BUDGET_MS = 100;

/**
 * Read a small regular file without ever blocking (audit F01: a FIFO .git/config hung the hook):
 * open non-blocking and without following symlinks, then fstat the open fd — FIFOs, sockets,
 * devices, symlinks and files over GIT_FILE_MAX all come back as null. No lstat→read race.
 */
export function readSmallFile(p: string): string | null {
	let fd: number | undefined;
	try {
		fd = openSync(
			p,
			constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
		);
		const st = fstatSync(fd);
		if (!st.isFile() || st.size > GIT_FILE_MAX) return null;
		const buf = Buffer.alloc(st.size);
		const n = readSync(fd, buf, 0, st.size, 0);
		return buf.subarray(0, n).toString("utf8");
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
const read = readSmallFile;

/**
 * Walk up to the nearest `.git` (dir, or regular file for worktrees/submodules). A `.git` that is a
 * symlink, FIFO or anything else stops the walk with no git info.
 */
function findDotGit(
	cwd: string,
): { toplevel: string; dotGit: string; isDir: boolean } | null {
	let dir = resolve(cwd);
	for (let i = 0; i < 64; i++) {
		const candidate = join(dir, ".git");
		let st: ReturnType<typeof lstatSync> | undefined;
		try {
			st = lstatSync(candidate);
		} catch {
			// not here
		}
		if (st) {
			if (st.isDirectory() || st.isFile())
				return { toplevel: dir, dotGit: candidate, isDir: st.isDirectory() };
			return null;
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

/** `url` of [remote "origin"] in a git config file. */
export function originUrlFromConfig(config: string): string | null {
	return (
		remotesFromConfig(config).find((r) => r.name === "origin")?.url ?? null
	);
}

/**
 * The checkout `cwd` is in, or null outside one (or for a cwd over GIT_PATH_MAX chars). Never throws,
 * and stays bounded: a path over
 * GIT_PATH_MAX or the time budget passed between steps ends it with local/<folder> (the work tree's
 * own folder); config limits (GIT_*_MAX) end the GitHub lookup the same way. `now` is for tests.
 */
export function gitInfo(
	cwd: string,
	now: () => number = () => performance.now(),
): GitInfo | null {
	const deadline = now() + GIT_INFO_BUDGET_MS;
	// the hook clips cwd to 4 096 chars (+ "…"): longer is no real path, and the walk up is linear in it
	if (cwd.length > GIT_PATH_MAX) return null;
	const found = findDotGit(cwd);
	if (!found) return null;
	const local = (branch: string | null = null): GitInfo => ({
		toplevel: found.toplevel,
		repo_id: localRepoId(found.toplevel),
		branch,
	});
	const late = () => now() > deadline;
	if (late()) return local();

	let gitDir = found.dotGit;
	if (!found.isDir) {
		const asFile = read(found.dotGit);
		if (asFile === null) return null;
		// worktree / submodule: "gitdir: <path>"
		const m = /^gitdir:\s*(.+)$/m.exec(asFile);
		if (!m?.[1]) return null;
		const p = m[1].trim();
		if (p.length > GIT_PATH_MAX) return local();
		gitDir = isAbsolute(p) ? p : resolve(found.toplevel, p);
		if (late()) return local();
	}
	const commondirRel = read(join(gitDir, "commondir"))?.trim();
	if (commondirRel && commondirRel.length > GIT_PATH_MAX) return local();
	const commonDir = commondirRel ? resolve(gitDir, commondirRel) : gitDir;
	if (late()) return local();

	const head = read(join(gitDir, "HEAD"))?.trim() ?? "";
	const branch = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1] ?? null; // detached HEAD → null
	if (late()) return local(branch);
	const config = read(join(commonDir, "config")) ?? "";
	if (late()) return local(branch);
	// only a linked worktree (its own git dir under the common one) names the main checkout
	const linked = resolve(commonDir) !== resolve(gitDir);

	return {
		toplevel: found.toplevel,
		repo_id:
			githubRepoFromConfig(config) ??
			localRepoId(found.toplevel, linked ? resolve(commonDir) : null),
		branch,
	};
}
