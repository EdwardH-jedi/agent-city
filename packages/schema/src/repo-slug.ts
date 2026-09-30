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

/** Id for a checkout without a GitHub origin: `local/<basename of the work tree>`, verbatim. */
export function localRepoId(toplevel: string): string {
	const base =
		toplevel
			.replace(/[/\\]+$/, "")
			.split(/[/\\]/)
			.pop() || "unknown";
	return `local/${base}`;
}
