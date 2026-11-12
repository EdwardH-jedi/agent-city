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

/** A section header: `[remote "x"]`, `[url "base"]`, legacy `[remote.x]`; a trailing comment is allowed. */
function sectionOf(line: string): { kind: string; sub: string | null } | null {
	const m =
		/^\[\s*([A-Za-z0-9.-]+?)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\](?:\s*[#;].*)?$/.exec(
			line,
		);
	if (!m?.[1]) return null;
	const dot = m[1].indexOf(".");
	if (m[2] === undefined && dot > 0)
		return { kind: m[1].slice(0, dot).toLowerCase(), sub: m[1].slice(dot + 1) };
	return { kind: m[1].toLowerCase(), sub: m[2] ?? null };
}
const configValue = (v: string): string =>
	v
		.replace(/\s+[#;].*$/, "")
		.trim()
		.replace(/^"(.*)"$/, "$1");

export interface GitConfigRemotes {
	/** Every remote's first url, in file order, with `url.<base>.insteadOf` applied (as git does). */
	remotes: GitRemote[];
	/** The file pulls in other files (`[include]` / `[includeIf]`): remotes may be missing from it. */
	includes: boolean;
}

/**
 * The remotes of a git config file, by text only — the hook never runs git. Urls can hold credentials:
 * callers keep only what parseGithubRemote makes of them.
 */
export function remotesFromConfig(config: string): GitRemote[] {
	return readGitConfig(config).remotes;
}
export function readGitConfig(config: string): GitConfigRemotes {
	const raw: GitRemote[] = [];
	const insteadOf: { base: string; prefix: string }[] = [];
	let includes = false;
	let sec: { kind: string; sub: string | null } | null = null;
	for (const rawLine of config.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		if (line.startsWith("[")) {
			sec = sectionOf(line);
			if (sec && (sec.kind === "include" || sec.kind === "includeif"))
				includes = true;
			continue;
		}
		if (!sec || sec.sub === null) continue;
		const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
		if (!kv?.[1] || kv[2] === undefined) continue;
		const key = kv[1].toLowerCase();
		const name = sec.sub;
		if (sec.kind === "remote" && key === "url") {
			if (!raw.some((r) => r.name === name))
				raw.push({ name, url: configValue(kv[2]) });
		} else if (sec.kind === "url" && key === "insteadof")
			insteadOf.push({ base: name, prefix: configValue(kv[2]) });
	}
	// git: the longest matching insteadOf prefix wins
	const rewrite = (url: string): string => {
		let best: { base: string; prefix: string } | null = null;
		for (const r of insteadOf)
			if (r.prefix && url.startsWith(r.prefix))
				if (!best || r.prefix.length > best.prefix.length) best = r;
		return best ? best.base + url.slice(best.prefix.length) : url;
	};
	return {
		remotes: raw.map((r) => ({ name: r.name, url: rewrite(r.url) })),
		includes,
	};
}

/**
 * githubRepoFromRemotes for a config file read as text (the collector): when there is no `origin` but
 * the file includes others, the origin may be defined there — no guess from the other remotes.
 */
export function githubRepoFromConfig(config: string): string | null {
	const { remotes, includes } = readGitConfig(config);
	if (includes && !remotes.some((r) => r.name === "origin")) return null;
	return githubRepoFromRemotes(remotes);
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
