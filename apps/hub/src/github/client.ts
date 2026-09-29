// Minimal read-only GitHub client. REST: GET only. GraphQL: `query` operations only (the endpoint
// is POST by protocol, so mutations are rejected before anything is sent).
// The token never appears in logs, errors, or return values.

export type TokenSource = "env GITHUB_TOKEN" | "gh auth token";

export interface ResolvedToken {
	token: string;
	source: TokenSource;
}

/** Runs `gh auth token`; returns trimmed stdout or null. Injectable for tests. */
export type GhRunner = () => Promise<string | null>;

const runGh: GhRunner = async () => {
	try {
		const p = Bun.spawn(["gh", "auth", "token"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const out = (await new Response(p.stdout).text()).trim();
		return (await p.exited) === 0 && out ? out : null;
	} catch {
		return null;
	}
};

/** GITHUB_TOKEN → `gh auth token` → error. */
export async function resolveGithubToken(
	env: Record<string, string | undefined> = process.env,
	gh: GhRunner = runGh,
): Promise<ResolvedToken> {
	const fromEnv = env.GITHUB_TOKEN?.trim();
	if (fromEnv) return { token: fromEnv, source: "env GITHUB_TOKEN" };
	const fromGh = await gh();
	if (fromGh) return { token: fromGh, source: "gh auth token" };
	throw new Error(
		"no GitHub token: set GITHUB_TOKEN in .env or run `gh auth login`",
	);
}

export type Bucket = "graphql" | "core";

export interface RateState {
	remaining: number | null;
	limit: number | null;
	resetAt: string | null;
}

export class RateLimitLow extends Error {
	constructor(
		readonly bucket: Bucket,
		readonly state: RateState,
	) {
		super(
			`GitHub ${bucket} rate limit low (${state.remaining} left, resets ${state.resetAt ?? "?"})`,
		);
	}
}

export class GithubHttpError extends Error {
	constructor(
		readonly status: number,
		what: string,
	) {
		super(`GitHub ${what} → HTTP ${status}`);
	}
}

export interface EtagStore {
	get(url: string): { etag: string; body: string } | null;
	put(url: string, etag: string, body: string): void;
}

export type DerivedResult<T> =
	| { value: T; cached: boolean }
	| { value: null; status: number };

export interface GithubClient {
	graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
	/**
	 * Conditional GET. On 200 `derive(json)` is cached with the ETag; on 304 the cached derived
	 * value is returned. `value: null` for 403/404/409/451 (no access / Actions disabled / empty).
	 */
	getDerived<T>(
		path: string,
		derive: (json: unknown) => T,
	): Promise<DerivedResult<T>>;
	rate: Record<Bucket, RateState>;
}

export interface ClientOptions {
	token: string;
	etags: EtagStore;
	fetch?: typeof fetch;
	baseUrl?: string;
	/** Stop (throw RateLimitLow) when a bucket drops below this. */
	minRemaining?: number;
	timeoutMs?: number;
}

/** Append to every GraphQL query so the graphql bucket is tracked. */
export const RATE_FIELDS = "rateLimit { remaining limit resetAt }";

export function createGithubClient(opts: ClientOptions): GithubClient {
	const f = opts.fetch ?? fetch;
	const base = opts.baseUrl ?? "https://api.github.com";
	const min = opts.minRemaining ?? 200;
	const timeout = opts.timeoutMs ?? 15_000;
	const rate: Record<Bucket, RateState> = {
		graphql: { remaining: null, limit: null, resetAt: null },
		core: { remaining: null, limit: null, resetAt: null },
	};
	const headers = {
		authorization: `Bearer ${opts.token}`,
		accept: "application/vnd.github+json",
		"x-github-api-version": "2022-11-28",
		"user-agent": "agent-city-sync",
	};

	const guard = (bucket: Bucket) => {
		const s = rate[bucket];
		if (s.remaining !== null && s.remaining < min)
			throw new RateLimitLow(bucket, s);
	};
	const readHeaders = (bucket: Bucket, res: Response) => {
		const rem = res.headers.get("x-ratelimit-remaining");
		const lim = res.headers.get("x-ratelimit-limit");
		const reset = res.headers.get("x-ratelimit-reset");
		if (rem !== null) rate[bucket].remaining = Number(rem);
		if (lim !== null) rate[bucket].limit = Number(lim);
		if (reset !== null)
			rate[bucket].resetAt = new Date(Number(reset) * 1000).toISOString();
	};
	const isRateLimited = (res: Response) =>
		(res.status === 403 || res.status === 429) &&
		(res.headers.get("x-ratelimit-remaining") === "0" ||
			res.headers.has("retry-after"));

	return {
		rate,

		async graphql<T>(query: string, variables: Record<string, unknown> = {}) {
			if (!/^\s*query\b/.test(query)) {
				throw new Error("graphql: only `query` operations are allowed");
			}
			guard("graphql");
			const res = await f(`${base}/graphql`, {
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify({ query, variables }),
				signal: AbortSignal.timeout(timeout),
			});
			readHeaders("graphql", res);
			if (isRateLimited(res)) throw new RateLimitLow("graphql", rate.graphql);
			if (!res.ok) throw new GithubHttpError(res.status, "graphql");
			const body = (await res.json()) as {
				data?: T & {
					rateLimit?: { remaining: number; limit: number; resetAt: string };
				};
				errors?: { type?: string; message: string }[];
			};
			if (body.errors?.length) {
				if (body.errors.some((e) => e.type === "RATE_LIMITED")) {
					throw new RateLimitLow("graphql", rate.graphql);
				}
				throw new Error(
					`graphql: ${body.errors
						.slice(0, 3)
						.map((e) => e.message)
						.join("; ")}`,
				);
			}
			if (!body.data) throw new Error("graphql: empty response");
			const rl = body.data.rateLimit;
			if (rl) {
				rate.graphql = {
					remaining: rl.remaining,
					limit: rl.limit,
					resetAt: rl.resetAt,
				};
			}
			return body.data;
		},

		async getDerived<T>(path: string, derive: (json: unknown) => T) {
			guard("core");
			const url = `${base}${path}`;
			const cached = opts.etags.get(url);
			const res = await f(url, {
				method: "GET",
				headers: cached
					? { ...headers, "if-none-match": cached.etag }
					: headers,
				signal: AbortSignal.timeout(timeout),
			});
			readHeaders("core", res);
			if (res.status === 304 && cached) {
				return { value: JSON.parse(cached.body) as T, cached: true };
			}
			if (isRateLimited(res)) throw new RateLimitLow("core", rate.core);
			if ([403, 404, 409, 451].includes(res.status)) {
				return { value: null, status: res.status };
			}
			if (!res.ok) throw new GithubHttpError(res.status, `GET ${path}`);
			const value = derive(await res.json());
			const etag = res.headers.get("etag");
			if (etag) opts.etags.put(url, etag, JSON.stringify(value));
			return { value, cached: false };
		},
	};
}
