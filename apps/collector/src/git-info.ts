// cwd → {toplevel, repo_id, branch} by reading .git files directly (no `git` spawn: the hook has a
// ~50ms budget). The repo id rule must match the hub's local scan (github/sync.ts):
//   parseGithubRemote(origin url) ?? localRepoId(toplevel)
// Remote URLs can embed credentials; only the parsed slug leaves this module.
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { localRepoId, parseGithubRemote } from "@agent-city/schema/core";

export interface GitInfo {
	toplevel: string;
	repo_id: string;
	branch: string | null;
}

const read = (p: string): string | null => {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return null;
	}
};

/** Walk up to the nearest `.git` (dir, or file for worktrees/submodules). */
function findDotGit(cwd: string): { toplevel: string; dotGit: string } | null {
	let dir = resolve(cwd);
	for (let i = 0; i < 64; i++) {
		const candidate = join(dir, ".git");
		try {
			statSync(candidate);
			return { toplevel: dir, dotGit: candidate };
		} catch {
			// not here
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
	const asFile = read(found.dotGit); // null when .git is a directory
	if (asFile !== null) {
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
