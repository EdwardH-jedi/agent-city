// Repo identity shared by the hub (local scan) and collectors (cwd → repo): both must agree.
// Pure — no Bun/Node imports, so the web app can import it too.

// github.com only. Groups: owner, name (without .git).
const GITHUB_REMOTE: readonly RegExp[] = [
	// https://github.com/o/r(.git), https://user:token@github.com/o/r, http://…, git://…
	/^(?:https?|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
	// ssh://git@github.com/o/r(.git), ssh://git@github.com:22/o/r
	/^ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
	// git@github.com:o/r(.git)  (scp-like)
	/^(?:[^@/\s]+@)?github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
];

/**
 * `owner/name` for a github.com remote URL, else null. Credentials in the URL are discarded —
 * callers must never store or log the raw URL.
 */
export function parseGithubRemote(url: string): string | null {
	const u = url.trim();
	for (const re of GITHUB_REMOTE) {
		const m = re.exec(u);
		if (m?.[1] && m[2]) return normalizeRepoId(`${m[1]}/${m[2]}`);
	}
	return null;
}

/**
 * Canonical spelling of a repo id from any source (collector slug, sync, ingest): trimmed, no
 * trailing `/`. Casing is kept — GitHub's casing is the display form; compare with repoKey().
 * `.git` is NOT stripped here (re-audit N02): that only happens while parsing a remote URL
 * (parseGithubRemote), so a local checkout folder named `foo.git` stays `local/foo.git` everywhere.
 */
export function normalizeRepoId(id: string): string {
	return id.trim().replace(/\/+$/, "");
}

/** Case-insensitive identity of a repo id (GitHub owner/name are case-insensitive). */
export function repoKey(id: string): string {
	return normalizeRepoId(id).toLowerCase();
}

/** Last path segment, either separator, trailing separators ignored ("" when there is none). */
function lastSegment(path: string): string {
	return (
		path
			.replace(/[/\\]+$/, "")
			.split(/[/\\]/)
			.pop() ?? ""
	);
}
/** The path without its last segment (either separator). */
function parentOf(path: string): string {
	const p = path.replace(/[/\\]+$/, "");
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i > 0 ? p.slice(0, i) : "";
}

/**
 * Id for a checkout without a GitHub repo: `local/<folder>`, verbatim. The folder is the work tree's,
 * except for a linked worktree: pass its git common dir (absolute, `git rev-parse --git-common-dir`, or
 * `<gitdir>/commondir` resolved) and when that is a `<main>/.git` the id is the main checkout's folder,
 * so a repo and all its worktrees are one building. A bare common dir (not named `.git`) has no
 * checkout folder: the worktree keeps its own name. Collector and hub both call this.
 */
export function localRepoId(
	toplevel: string,
	commonDir?: string | null,
): string {
	const own = lastSegment(toplevel) || "unknown";
	if (!commonDir || lastSegment(commonDir) !== ".git") return `local/${own}`;
	return `local/${lastSegment(parentOf(commonDir)) || own}`;
}

export interface GitRemote {
	name: string;
	url: string;
}

/**
 * Every `[remote "<name>"]` url in a git config file, in file order (first url per remote). Pure text
 * parsing — the hook never runs git. Urls can hold credentials: callers keep only what
 * parseGithubRemote makes of them.
 */
export function remotesFromConfig(config: string): GitRemote[] {
	const out: GitRemote[] = [];
	let name: string | null = null;
	for (const raw of config.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("[")) {
			const m = /^\[\s*remote\s+"([^"]*)"\s*\]$/i.exec(line);
			name = m ? (m[1] ?? "") : null;
			continue;
		}
		if (name === null || out.some((r) => r.name === name)) continue;
		const m = /^url\s*=\s*(.+)$/i.exec(line);
		if (m?.[1]) out.push({ name, url: m[1].trim().replace(/^"(.*)"$/, "$1") });
	}
	return out;
}

/**
 * The GitHub repo (`owner/name`) a checkout belongs to, from its remotes:
 *  - a remote named `origin` decides alone: its github.com repo, or null when it is elsewhere;
 *  - with no `origin`, exactly one github.com repo among the remotes (any names; the same repo
 *    spelled twice counts once) names it; two different ones or none: null (the checkout is local).
 */
export function githubRepoFromRemotes(
	remotes: readonly GitRemote[],
): string | null {
	const origin = remotes.find((r) => r.name === "origin");
	if (origin) return parseGithubRemote(origin.url);
	const found = new Map<string, string>();
	for (const r of remotes) {
		const slug = parseGithubRemote(r.url);
		if (slug && !found.has(repoKey(slug))) found.set(repoKey(slug), slug);
	}
	return found.size === 1 ? ([...found.values()][0] ?? null) : null;
}
