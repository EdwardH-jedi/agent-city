// Find git checkouts under REPO_ROOTS and identify them (read-only: `git rev-parse` / `remote get-url`).
// Remote URLs may embed credentials — only the parsed `owner/name` ever leaves this module.
import { type Dirent, existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseGithubRemote } from "@agent-city/schema";

export const MAX_DEPTH = 4;
const SKIP_DIRS = new Set(["node_modules", "vendor", "target", "dist"]);

export interface LocalCheckout {
	path: string; // work tree top level
	slug: string | null; // owner/name from a github.com origin
	isWorktree: boolean;
	hasOrigin: boolean;
	error: string | null;
}

/** "~/a, /b" → absolute, de-duplicated paths. */
export function expandRoots(raw: string | undefined): string[] {
	if (!raw) return [];
	const home = homedir();
	return [
		...new Set(
			raw
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
				.map((s) => resolve(s.replace(/^~(?=$|\/)/, home))),
		),
	];
}

interface RootWalk {
	exists: boolean;
	/** Directories we couldn't list — the root's view is incomplete. */
	unreadable: number;
	dirs: string[];
}

/**
 * Directories containing `.git` (dir OR file — worktrees/submodules use a file), at most `maxDepth`
 * levels below `root`. Doesn't descend into a repo, dot-dirs, node_modules, or symlinks.
 */
function walkRoot(root: string, maxDepth: number): RootWalk {
	const out: RootWalk = { exists: existsSync(root), unreadable: 0, dirs: [] };
	if (!out.exists) return out;
	const walk = (dir: string, depth: number) => {
		if (existsSync(join(dir, ".git"))) {
			out.dirs.push(dir);
			return;
		}
		if (depth >= maxDepth) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			out.unreadable++;
			return;
		}
		for (const e of entries) {
			if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name))
				continue;
			walk(join(dir, e.name), depth + 1);
		}
	};
	walk(root, 0);
	return out;
}

export function findCheckouts(
	roots: readonly string[],
	maxDepth = MAX_DEPTH,
): string[] {
	return roots.flatMap((r) => walkRoot(r, maxDepth).dirs).sort();
}

export interface RootScan {
	/** realpath of the root (as stored paths are), or the configured path when it doesn't exist. */
	path: string;
	exists: boolean;
	/** Every directory was readable and every checkout probed without error. */
	complete: boolean;
}

export interface LocalScan {
	roots: RootScan[];
	checkouts: (LocalCheckout & { root: string })[];
}

const real = (p: string) => {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
};

async function git(
	cwd: string,
	args: string[],
): Promise<{ ok: boolean; out: string }> {
	const p = Bun.spawn(["git", "-C", cwd, ...args], {
		stdout: "pipe",
		stderr: "ignore",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
	});
	const out = (await new Response(p.stdout).text()).trim();
	return { ok: (await p.exited) === 0, out };
}

export async function probeCheckout(dir: string): Promise<LocalCheckout> {
	const rp = await git(dir, [
		"rev-parse",
		"--path-format=absolute",
		"--show-toplevel",
		"--git-dir",
		"--git-common-dir",
	]);
	if (!rp.ok) {
		return {
			path: dir,
			slug: null,
			isWorktree: false,
			hasOrigin: false,
			error: "git rev-parse failed",
		};
	}
	const [top, gitDir, commonDir] = rp.out.split("\n");
	const origin = await git(dir, ["remote", "get-url", "origin"]);
	return {
		path: top || dir,
		slug: origin.ok ? parseGithubRemote(origin.out) : null,
		isWorktree:
			!!gitDir && !!commonDir && resolve(gitDir) !== resolve(commonDir),
		hasOrigin: origin.ok && origin.out.length > 0,
		error: null,
	};
}

/** Scan every root and report, per root, whether the scan was complete (F07). */
export async function scanLocal(
	roots: readonly string[],
	maxDepth = MAX_DEPTH,
	concurrency = 8,
): Promise<LocalScan> {
	const result: LocalScan = { roots: [], checkouts: [] };
	for (const configured of roots) {
		const walk = walkRoot(configured, maxDepth);
		const root = walk.exists ? real(configured) : configured;
		let errors = 0;
		for (let i = 0; i < walk.dirs.length; i += concurrency) {
			const probed = await Promise.all(
				walk.dirs.slice(i, i + concurrency).map(probeCheckout),
			);
			for (const c of probed) {
				if (c.error) errors++;
				result.checkouts.push({ ...c, root });
			}
		}
		result.roots.push({
			path: root,
			exists: walk.exists,
			complete: walk.exists && walk.unreadable === 0 && errors === 0,
		});
	}
	return result;
}
