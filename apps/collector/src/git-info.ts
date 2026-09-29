// cwd → {toplevel, repo_id, branch} by reading .git files directly (no `git` spawn: the hook has a
// ~50ms budget). The repo id rule must match the hub's local scan (github/sync.ts):
//   parseGithubRemote(origin url) ?? localRepoId(toplevel)
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
import { localRepoId, parseGithubRemote } from "@agent-city/schema/core";

export interface GitInfo {
	toplevel: string;
	repo_id: string;
	branch: string | null;
}

/** Largest .git metadata file we'll read (HEAD, config, commondir, gitdir pointer). */
export const GIT_FILE_MAX = 64 * 1024;

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
	let inOrigin = false;
	for (const raw of config.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("[")) {
			inOrigin = /^\[\s*remote\s+"origin"\s*\]$/i.test(line);
			continue;
		}
		if (!inOrigin) continue;
		const m = /^url\s*=\s*(.+)$/i.exec(line);
		if (m?.[1]) return m[1].trim().replace(/^"(.*)"$/, "$1");
	}
	return null;
}

export function gitInfo(cwd: string): GitInfo | null {
	const found = findDotGit(cwd);
	if (!found) return null;

	let gitDir = found.dotGit;
	if (!found.isDir) {
		const asFile = read(found.dotGit);
		if (asFile === null) return null;
		// worktree / submodule: "gitdir: <path>"
		const m = /^gitdir:\s*(.+)$/m.exec(asFile);
		if (!m?.[1]) return null;
		const p = m[1].trim();
		gitDir = isAbsolute(p) ? p : resolve(found.toplevel, p);
	}
	const commondirRel = read(join(gitDir, "commondir"))?.trim();
	const commonDir = commondirRel ? resolve(gitDir, commondirRel) : gitDir;

	const head = read(join(gitDir, "HEAD"))?.trim() ?? "";
	const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
	const url = originUrlFromConfig(read(join(commonDir, "config")) ?? "");

	return {
		toplevel: found.toplevel,
		repo_id:
			(url ? parseGithubRemote(url) : null) ?? localRepoId(found.toplevel),
		branch: ref?.[1] ?? null, // detached HEAD → null
	};
}
