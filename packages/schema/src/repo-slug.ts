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
	return trimEnd(id.trim(), "/");
}

/** Case-insensitive identity of a repo id (GitHub owner/name are case-insensitive). */
export function repoKey(id: string): string {
	return normalizeRepoId(id).toLowerCase();
}

/**
 * `s` without its trailing run of any char in `chars`. A backward scan, not /[…]+$/: that regex is
 * unanchored, so each start inside a long run re-scans it (O(n²) — a 64 KB commondir of backslashes
 * took 1.5 s in the hook).
 */
function trimEnd(s: string, chars: string): string {
	let end = s.length;
	while (end > 0 && chars.includes(s[end - 1] as string)) end--;
	return s.slice(0, end);
}
/** Last path segment, either separator, trailing separators ignored ("" when there is none). */
function lastSegment(path: string): string {
	const p = trimEnd(path, "/\\");
	return p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
}
/** The path without its last segment (either separator). */
function parentOf(path: string): string {
	const p = trimEnd(path, "/\\");
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i > 0 ? p.slice(0, i) : "";
}

/**
 * Id for a checkout without a GitHub repo: `local/<folder>`, verbatim. The folder is the work tree's,
 * except for a linked worktree: pass its git common dir (absolute, `git rev-parse --git-common-dir`, or
 * `<gitdir>/commondir` resolved) and when that is a `<main>/.git` the id is the main checkout's folder,
 * so a repo and all its worktrees are one building. A bare common dir (not named `.git`) has no
 * checkout folder: the worktree keeps its own name; so does a common dir over GIT_PATH_MAX chars.
 * Collector and hub both call this.
 */
export function localRepoId(
	toplevel: string,
	commonDir?: string | null,
): string {
	const own = lastSegment(toplevel) || "unknown";
	if (
		!commonDir ||
		commonDir.length > GIT_PATH_MAX ||
		lastSegment(commonDir) !== ".git"
	)
		return `local/${own}`;
	return `local/${lastSegment(parentOf(commonDir)) || own}`;
}

// Input limits of the shared rule (collector and hub). Past any of them the checkout is not taken for a
// GitHub repo: the id falls back to local/<folder> — no throw, the event is still spooled. They make the
// worst-case work a constant (see "Worst-case work" below) instead of a product of what a
// hostile .git/config holds (seen: 2 486 remotes × a 16 000-char insteadOf base → 960 ms in the hook).
/** Remotes in one checkout (distinct names). */
export const GIT_REMOTES_MAX = 32;
/** `url.<base>.insteadOf` rules in one config. */
export const GIT_INSTEADOF_MAX = 32;
/** Chars in a remote url (before and after insteadOf), an insteadOf base, an insteadOf prefix. */
export const GIT_URL_MAX = 2048;
/** Chars in a git dir / common dir path (a `gitdir:` pointer, a `commondir` file). */
export const GIT_PATH_MAX = 4096;

export interface GitRemote {
	name: string;
	url: string;
}

// The parsing below is hand-written and linear in the line length (no backtracking regex): it runs in the
// Claude Code hook on a .git/config of up to 64 KB (Hard rule 4: bounded time). The same holds above:
// trimEnd scans instead of /[/\\]+$/, and the GITHUB_REMOTE patterns are ^-anchored with no `m` flag,
// so they try one start position.
//
// Worst-case work, from the limits (the collector reads at most GIT_FILE_MAX = 64 KiB):
//  - scan: one pass over the file, O(1) per char (header, key and value scanners are linear in their
//    line; remote names are deduplicated in a Map), stopping at the first limit hit: ≤ 64 K steps;
//  - rewrite: ≤ 32 rules, each a startsWith of a prefix ≤ 2 048 chars: ≤ 65 K char compares per url.
//    githubRepoFromConfig rewrites origin alone when there is one; without one, each remote in file
//    order until two different repos show up (ambiguous): ≤ 32 urls → ≤ 2.1 M compares;
//    readGitConfig / remotesFromConfig rewrite every remote: the same ≤ 2.1 M;
//  - parse: ≤ 3 anchored regexes over a url ≤ 2 048 chars + repoKey's lower-casing, per remote:
//    ≤ 32 × ~8 K = 0.26 M steps.
// Total ≤ ~2.5 M simple steps whatever the file holds (git-info-bounded.test.ts times the shapes).

/**
 * A section header line: `[remote "x"]`, `[url "base"]`, legacy `[remote.x]` (its name lower-cased, as
 * git does). `rest` is what follows `]` — git allows a key on the header line, or a comment.
 */
function sectionOf(
	line: string,
): { kind: string; sub: string | null; rest: string } | null {
	let i = 1;
	const n = line.length;
	const space = (c: string | undefined) => c === " " || c === "\t";
	while (space(line[i])) i++;
	let name = "";
	while (i < n && /[A-Za-z0-9.-]/.test(line[i] as string)) name += line[i++];
	if (!name) return null;
	while (space(line[i])) i++;
	let sub: string | null = null;
	if (line[i] === '"') {
		i++;
		let q = "";
		while (i < n && line[i] !== '"') {
			if (line[i] === "\\" && i + 1 < n) i++;
			q += line[i++];
		}
		if (line[i] !== '"') return null;
		i++;
		sub = q;
		while (space(line[i])) i++;
	}
	if (line[i] !== "]") return null;
	const rest = line.slice(i + 1).trim();
	const dot = name.indexOf(".");
	if (sub === null && dot > 0)
		return {
			kind: name.slice(0, dot).toLowerCase(),
			sub: name.slice(dot + 1).toLowerCase(),
			rest,
		};
	return { kind: name.toLowerCase(), sub, rest };
}

/** A value as git reads it: quotes removed, `\"` `\\` unescaped, a `#` / `;` outside quotes ends it. */
function configValue(v: string): string {
	let out = "";
	let quoted = false;
	for (let i = 0; i < v.length; i++) {
		const c = v[i] as string;
		if (c === "\\" && i + 1 < v.length) {
			const d = v[++i] as string;
			out += d === "n" ? "\n" : d === "t" ? "\t" : d;
		} else if (c === '"') quoted = !quoted;
		else if (!quoted && (c === "#" || c === ";")) break;
		else out += c;
	}
	return out.trim();
}

export interface GitConfigRemotes {
	/** Every remote's first url, in file order, with `url.<base>.insteadOf` applied (as git does). */
	remotes: GitRemote[];
	/** The file pulls in other files (`[include]` / `[includeIf]`): remotes may be missing from it. */
	includes: boolean;
	/** A GIT_*_MAX limit was hit: the scan stopped there and `remotes` is empty (not a GitHub repo). */
	overLimit: boolean;
}

interface InsteadOf {
	base: string;
	prefix: string;
}
interface ParsedConfig {
	/** First url of each remote as written (no insteadOf), or the remote's name when it has none. */
	remotes: GitRemote[];
	rules: InsteadOf[];
	includes: boolean;
	overLimit: boolean;
}

/** One pass over the file; stops at the first GIT_*_MAX limit hit (the result is then unusable). */
function parseGitConfig(config: string): ParsedConfig {
	// every [remote "x"] section names a remote, url or not (git then uses the name as its url);
	// Map: file order, O(1) dedupe of a section written twice. null = no url seen yet.
	const urls = new Map<string, string | null>();
	const rules: InsteadOf[] = [];
	let includes = false;
	let overLimit = false;
	let sec: ReturnType<typeof sectionOf> = null;
	const entry = (line: string) => {
		if (!sec || sec.sub === null) return;
		const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*=(.*)$/.exec(line);
		if (!kv?.[1] || kv[2] === undefined) return;
		const key = kv[1].toLowerCase();
		const name = sec.sub;
		if (sec.kind === "remote" && key === "url") {
			if (urls.get(name) !== null) return; // only the first url of a remote counts
			const url = configValue(kv[2]);
			if (url.length > GIT_URL_MAX) overLimit = true;
			else urls.set(name, url);
		} else if (sec.kind === "url" && key === "insteadof") {
			const prefix = configValue(kv[2]);
			if (
				rules.length >= GIT_INSTEADOF_MAX ||
				name.length > GIT_URL_MAX ||
				prefix.length > GIT_URL_MAX
			)
				overLimit = true;
			else rules.push({ base: name, prefix });
		}
	};
	for (const rawLine of config.split("\n")) {
		if (overLimit) break;
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		if (line.startsWith("[")) {
			sec = sectionOf(line);
			if (sec && (sec.kind === "include" || sec.kind === "includeif"))
				includes = true;
			if (sec?.kind === "remote" && sec.sub !== null && !urls.has(sec.sub)) {
				if (urls.size >= GIT_REMOTES_MAX) {
					overLimit = true;
					break;
				}
				urls.set(sec.sub, null);
			}
			if (sec?.rest) entry(sec.rest);
			continue;
		}
		entry(line);
	}
	return {
		remotes: [...urls].map(([name, url]) => ({ name, url: url ?? name })),
		rules,
		includes,
		overLimit,
	};
}

/** git: the longest matching insteadOf prefix wins. */
function rewriteUrl(url: string, rules: readonly InsteadOf[]): string {
	let best: InsteadOf | null = null;
	for (const r of rules)
		if (r.prefix && url.startsWith(r.prefix))
			if (!best || r.prefix.length > best.prefix.length) best = r;
	return best ? best.base + url.slice(best.prefix.length) : url;
}

/**
 * The remotes of a git config file, by text only — the hook never runs git. Urls can hold credentials:
 * callers keep only what parseGithubRemote makes of them. Over a GIT_*_MAX limit: [].
 */
export function remotesFromConfig(config: string): GitRemote[] {
	return readGitConfig(config).remotes;
}
export function readGitConfig(config: string): GitConfigRemotes {
	const c = parseGitConfig(config);
	if (c.overLimit)
		return { remotes: [], includes: c.includes, overLimit: true };
	return {
		remotes: c.remotes.map((r) => ({
			name: r.name,
			url: rewriteUrl(r.url, c.rules),
		})),
		includes: c.includes,
		overLimit: false,
	};
}

/**
 * githubRepoFromRemotes for a config file read as text (the collector): when there is no `origin` but
 * the file includes others, the origin may be defined there — no guess from the other remotes. Over a
 * GIT_*_MAX limit: null. insteadOf is applied only to the urls actually looked at (origin alone, when
 * there is one).
 */
export function githubRepoFromConfig(config: string): string | null {
	const c = parseGitConfig(config);
	if (c.overLimit) return null;
	if (c.includes && !c.remotes.some((r) => r.name === "origin")) return null;
	return repoFromRemotes(c.remotes, (url) => rewriteUrl(url, c.rules));
}

/**
 * The GitHub repo (`owner/name`) a checkout belongs to, from its remotes:
 *  - a remote named `origin` decides alone: its github.com repo, or null when it is elsewhere;
 *  - with no `origin`, exactly one github.com repo among the remotes (any names; the same repo
 *    spelled twice counts once) names it; two different ones or none: null (the checkout is local).
 *  - over GIT_REMOTES_MAX remotes, or any url over GIT_URL_MAX chars: null.
 * The hub passes the urls as git resolved them (insteadOf applied); the collector goes through
 * githubRepoFromConfig.
 */
export function githubRepoFromRemotes(
	remotes: readonly GitRemote[],
): string | null {
	return repoFromRemotes(remotes, (url) => url);
}

function repoFromRemotes(
	remotes: readonly GitRemote[],
	rewrite: (url: string) => string,
): string | null {
	if (remotes.length > GIT_REMOTES_MAX) return null;
	for (const r of remotes) if (r.url.length > GIT_URL_MAX) return null;
	const origin = remotes.find((r) => r.name === "origin");
	if (origin) {
		const url = rewrite(origin.url);
		return url.length > GIT_URL_MAX ? null : parseGithubRemote(url);
	}
	let found: string | null = null;
	let foundKey = "";
	for (const r of remotes) {
		const url = rewrite(r.url);
		if (url.length > GIT_URL_MAX) return null;
		const slug = parseGithubRemote(url);
		if (!slug) continue;
		const key = repoKey(slug);
		if (found === null) {
			found = slug;
			foundKey = key;
		} else if (key !== foundKey) return null; // two different repos: ambiguous, stop here
	}
	return found;
}
