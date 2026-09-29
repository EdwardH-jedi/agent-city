// GitHub → repos table sync. READ-ONLY: only GET requests, never mutate anything on GitHub.
//
// Token loading order (never log the token, never write it to disk):
//   1. process.env.GITHUB_TOKEN (fine-grained PAT, read-only) from .env
//   2. `gh auth token` (spawned, stdout trimmed) if GITHUB_TOKEN is empty
//   3. otherwise fail with a clear message — do not fall back to unauthenticated calls

/** Resolve a GitHub token per the order above. TODO(phase-0). */
export async function resolveGithubToken(): Promise<string> {
	throw new Error("resolveGithubToken: not implemented");
}

/**
 * List repos for GITHUB_LOGIN, map them to districts via config/districts.yaml, upsert into `repos`.
 * TODO(phase-0): paginate, respect rate-limit headers, set repos.synced_at.
 */
export async function syncGithub(): Promise<void> {
	throw new Error("syncGithub: not implemented");
}

if (import.meta.main) {
	console.error(
		"[sync:github] not implemented yet (Step 0 scaffold). No GitHub calls were made.",
	);
	process.exit(1);
}
