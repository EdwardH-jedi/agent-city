// Fixture-only tests: no real GitHub API calls, only fictional repo names (octo-example/*).
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.ts";
import {
	createGithubClient,
	type EtagStore,
	RateLimitLow,
	resolveGithubToken,
} from "./client.ts";
import {
	DISTRICTS_DRAFT_PATH,
	DISTRICTS_PATH,
	parseDistricts,
	renderDistrictsDraft,
} from "./districts.ts";
import { findCheckouts, type LocalCheckout, probeCheckout } from "./local.ts";
import { dbEtagStore, deriveCi, mapCiRun, syncGithub } from "./sync.ts";

const FAKE_TOKEN = `fake${"t".repeat(32)}`;
const NOW = new Date("2026-06-01T00:00:00.000Z");
const daysAgo = (d: number) =>
	new Date(NOW.getTime() - d * 86_400_000).toISOString();

// ── fake GitHub ────────────────────────────────────────────────────────────

interface FakeRepo {
	name: string;
	pushedDaysAgo: number;
	private?: boolean;
	archived?: boolean;
	fork?: boolean;
	empty?: boolean; // no default branch
	commits30?: number;
	run?: { status: string; conclusion: string | null } | null; // null → no runs
	actionsStatus?: number; // e.g. 403
}

const REPOS: FakeRepo[] = [
	{
		name: "octo-example/alpha",
		pushedDaysAgo: 1,
		private: true,
		commits30: 12,
		run: { status: "completed", conclusion: "success" },
	},
	{
		name: "octo-example/beta",
		pushedDaysAgo: 10,
		commits30: 3,
		run: { status: "completed", conclusion: "failure" },
	},
	{
		name: "octo-example/gamma",
		pushedDaysAgo: 20,
		fork: true,
		commits30: 1,
		run: { status: "in_progress", conclusion: null },
	},
	{ name: "octo-example/delta", pushedDaysAgo: 40, commits30: 0, run: null },
	{
		name: "octo-example/epsilon",
		pushedDaysAgo: 5,
		commits30: 2,
		actionsStatus: 403,
	},
	{
		name: "octo-example/zeta",
		pushedDaysAgo: 400,
		archived: true,
		run: { status: "completed", conclusion: "success" },
	},
	{ name: "octo-example/eta", pushedDaysAgo: 2, empty: true },
];

interface FakeOpts {
	pageSize?: number;
	/** graphql rateLimit.remaining to report */
	graphqlRemaining?: number;
}

function fakeGithub(repos: FakeRepo[], opts: FakeOpts = {}) {
	const calls: {
		method: string;
		url: string;
		headers: Headers;
		body?: string;
	}[] = [];
	const pageSize = opts.pageSize ?? 3;
	const nodeId = (r: FakeRepo) => `node:${r.name}`;
	const json = (body: unknown, init: ResponseInit = {}) =>
		new Response(JSON.stringify(body), {
			...init,
			headers: { "content-type": "application/json", ...(init.headers ?? {}) },
		});
	const rateLimit = {
		remaining: opts.graphqlRemaining ?? 4999,
		limit: 5000,
		resetAt: "2026-06-01T01:00:00Z",
	};

	const fetch = async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const headers = new Headers(init?.headers);
		calls.push({
			method: init?.method ?? "GET",
			url,
			headers,
			body: init?.body as string,
		});

		if (url.endsWith("/graphql")) {
			const { query, variables } = JSON.parse(String(init?.body));
			if (query.includes("viewer")) {
				const start = variables.cursor ? Number(variables.cursor) : 0;
				const slice = repos.slice(start, start + pageSize);
				const next = start + pageSize;
				return json({
					data: {
						rateLimit,
						viewer: {
							login: "octo-example",
							repositories: {
								totalCount: repos.length,
								pageInfo: {
									hasNextPage: next < repos.length,
									endCursor: next < repos.length ? String(next) : null,
								},
								nodes: slice.map((r) => ({
									id: nodeId(r),
									nameWithOwner: r.name,
									isPrivate: !!r.private,
									isArchived: !!r.archived,
									isFork: !!r.fork,
									pushedAt: daysAgo(r.pushedDaysAgo),
									primaryLanguage: { name: "TypeScript" },
									defaultBranchRef: r.empty ? null : { name: "main" },
									pullRequests: { totalCount: 1 },
									issues: { totalCount: 2 },
								})),
							},
						},
					},
				});
			}
			const ids: string[] = variables.ids;
			return json({
				data: {
					rateLimit,
					nodes: ids.map((id) => {
						const r = repos.find((x) => nodeId(x) === id);
						return r
							? {
									id,
									defaultBranchRef: {
										target: { history: { totalCount: r.commits30 ?? 0 } },
									},
								}
							: null;
					}),
				},
			});
		}

		const m = /\/repos\/([^/]+\/[^/]+)\/actions\/runs/.exec(url);
		const r = m && repos.find((x) => x.name === m[1]);
		const rest = {
			"x-ratelimit-remaining": "4990",
			"x-ratelimit-limit": "5000",
			"x-ratelimit-reset": "1780275600",
		};
		if (!r)
			return json({ message: "Not Found" }, { status: 404, headers: rest });
		if (r.actionsStatus)
			return json(
				{ message: "Resource not accessible" },
				{ status: r.actionsStatus, headers: rest },
			);
		const etag = `"etag-${r.name}"`;
		if (headers.get("if-none-match") === etag) {
			return new Response(null, { status: 304, headers: rest });
		}
		return json(
			{
				total_count: r.run ? 1 : 0,
				workflow_runs: r.run ? [{ ...r.run, updated_at: daysAgo(1) }] : [],
			},
			{ headers: { ...rest, etag } },
		);
	};
	return { fetch: fetch as typeof globalThis.fetch, calls };
}

const memEtags = (): EtagStore & {
	map: Map<string, { etag: string; body: string }>;
} => {
	const map = new Map<string, { etag: string; body: string }>();
	return {
		map,
		get: (u) => map.get(u) ?? null,
		put: (u, etag, body) => map.set(u, { etag, body }),
	};
};

function setupSync(repos = REPOS, fakeOpts: FakeOpts = {}, minRemaining = 100) {
	const db = openDb(":memory:");
	const gh = fakeGithub(repos, fakeOpts);
	const client = createGithubClient({
		token: FAKE_TOKEN,
		etags: dbEtagStore(db),
		fetch: gh.fetch,
		minRemaining,
	});
	return { db, gh, client };
}

const repoRow = (db: Database, id: string) =>
	db
		.query<Record<string, unknown>, [string]>(
			"SELECT * FROM repos WHERE id = ?",
		)
		.get(id);

const districts = parseDistricts(
	"games:\n  - octo-example/alpha\nschool:\n  - beta\ninfra: []\nuncategorized: []\n",
);

// ── token ──────────────────────────────────────────────────────────────────

describe("resolveGithubToken", () => {
	test("GITHUB_TOKEN wins", async () => {
		let ghCalled = false;
		const r = await resolveGithubToken(
			{ GITHUB_TOKEN: FAKE_TOKEN },
			async () => {
				ghCalled = true;
				return "other";
			},
		);
		expect(r).toEqual({ token: FAKE_TOKEN, source: "env GITHUB_TOKEN" });
		expect(ghCalled).toBe(false);
	});

	test("empty GITHUB_TOKEN → gh auth token", async () => {
		const r = await resolveGithubToken(
			{ GITHUB_TOKEN: "  " },
			async () => FAKE_TOKEN,
		);
		expect(r.source).toBe("gh auth token");
	});

	test("neither → clear error without any token", async () => {
		await expect(resolveGithubToken({}, async () => null)).rejects.toThrow(
			/no GitHub token/,
		);
	});
});

// ── client ─────────────────────────────────────────────────────────────────

describe("client", () => {
	test("rejects mutations before any request is sent", async () => {
		const { gh, client } = setupSync();
		await expect(
			client.graphql(
				"mutation { deleteRepository(input: {}) { clientMutationId } }",
			),
		).rejects.toThrow(/only `query`/);
		expect(gh.calls).toHaveLength(0);
	});

	test("REST is GET with If-None-Match on the second call; 304 → cached value", async () => {
		const gh = fakeGithub(REPOS);
		const etags = memEtags();
		const client = createGithubClient({
			token: FAKE_TOKEN,
			etags,
			fetch: gh.fetch,
		});
		const path = "/repos/octo-example/alpha/actions/runs?per_page=1";

		const first = await client.getDerived(path, deriveCi);
		expect(first).toMatchObject({
			cached: false,
			value: { ci_status: "success" },
		});
		expect(etags.map.size).toBe(1);
		// only the derived value is cached, never the raw response
		expect(
			Object.keys(JSON.parse([...etags.map.values()][0]?.body ?? "{}")),
		).toEqual(["ci_status", "ci_updated_at"]);

		const second = await client.getDerived(path, deriveCi);
		expect(second).toMatchObject({
			cached: true,
			value: { ci_status: "success" },
		});
		expect(gh.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
		expect(gh.calls[1]?.headers.get("if-none-match")).toBe(
			'"etag-octo-example/alpha"',
		);
		expect(client.rate.core.remaining).toBe(4990);
	});

	test("403 on actions → value null + status (not a rate-limit abort)", async () => {
		const { client } = setupSync();
		expect(
			await client.getDerived(
				"/repos/octo-example/epsilon/actions/runs?per_page=1",
				deriveCi,
			),
		).toEqual({ value: null, status: 403 });
	});

	test("guard: bucket below minimum → RateLimitLow before the next request", async () => {
		const { gh, client } = setupSync(REPOS, { graphqlRemaining: 50 }, 100);
		await client.graphql(
			"query { viewer { login } rateLimit { remaining limit resetAt } }",
		);
		const before = gh.calls.length;
		await expect(
			client.graphql("query { viewer { login } }"),
		).rejects.toBeInstanceOf(RateLimitLow);
		expect(gh.calls.length).toBe(before);
	});

	test("the token never appears in errors", async () => {
		const client = createGithubClient({
			token: FAKE_TOKEN,
			etags: memEtags(),
			fetch: (async () =>
				new Response("nope", { status: 500 })) as unknown as typeof fetch,
		});
		const err = await client
			.graphql("query { viewer { login } }")
			.catch((e: Error) => e);
		expect(String((err as Error).message)).not.toContain(FAKE_TOKEN);
	});
});

// ── CI mapping ─────────────────────────────────────────────────────────────

describe("CI mapping", () => {
	test.each([
		[{ status: "completed", conclusion: "success" }, "success"],
		[{ status: "completed", conclusion: "failure" }, "failure"],
		[{ status: "completed", conclusion: "timed_out" }, "failure"],
		[{ status: "completed", conclusion: "startup_failure" }, "failure"],
		[{ status: "completed", conclusion: "cancelled" }, "none"],
		[{ status: "completed", conclusion: "skipped" }, "none"],
		[{ status: "completed", conclusion: "action_required" }, "none"],
		[{ status: "in_progress", conclusion: null }, "running"],
		[{ status: "queued", conclusion: null }, "running"],
		[{ status: "waiting", conclusion: null }, "running"],
	] as const)("%o → %s", (run, expected) => {
		expect(mapCiRun(run)).toBe(expected);
	});

	test("no runs → none", () => {
		expect(deriveCi({ total_count: 0, workflow_runs: [] })).toEqual({
			ci_status: "none",
			ci_updated_at: null,
		});
	});
});

// ── districts ──────────────────────────────────────────────────────────────

describe("districts", () => {
	test("owner/name, bare name, case-insensitive, unlisted → uncategorized", () => {
		expect(districts.districtOf("octo-example/alpha")).toBe("games");
		expect(districts.districtOf("OCTO-EXAMPLE/Alpha")).toBe("games");
		expect(districts.districtOf("anyone/beta")).toBe("school");
		expect(districts.districtOf("octo-example/nope")).toBe("uncategorized");
	});

	test("repo in two districts → first wins + warning", () => {
		const d = parseDistricts("games: [o/x]\nschool: [o/x]\n");
		expect(d.districtOf("o/x")).toBe("games");
		expect(d.warnings[0]).toContain("keeping");
		expect(d.names).toEqual(["games", "school", "uncategorized"]);
	});

	test("draft is valid YAML with every repo and a separate path", () => {
		const text = renderDistrictsDraft(
			[
				{ id: "octo-example/alpha", district: "games", is_local_only: false },
				{
					id: "octo-example/zeta",
					district: "uncategorized",
					is_local_only: false,
				},
				{ id: "local/scratch", district: "uncategorized", is_local_only: true },
			],
			["games", "school", "uncategorized"],
			"2026-06-01T00:00:00.000Z",
		);
		expect(Bun.YAML.parse(text)).toEqual({
			games: ["octo-example/alpha"],
			school: [],
			uncategorized: ["local/scratch", "octo-example/zeta"],
		});
		expect(DISTRICTS_DRAFT_PATH).not.toBe(DISTRICTS_PATH);
		expect(DISTRICTS_DRAFT_PATH.endsWith("config/districts.draft.yaml")).toBe(
			true,
		);
	});
});

// ── full sync ──────────────────────────────────────────────────────────────

describe("syncGithub", () => {
	test("paginates, fills metadata / commits / CI, counts 403s", async () => {
		const { db, gh, client } = setupSync();
		const s = await syncGithub({ db, client, districts, now: NOW });

		expect(s.aborted).toBeNull();
		expect(s.login).toBe("octo-example");
		expect(s.total).toBe(7);
		expect([s.private, s.archived, s.forks]).toEqual([1, 1, 1]);
		// ≤90d with a default branch: alpha beta gamma delta epsilon (eta is empty, zeta is old)
		expect(s.activeWindow).toBe(5);
		expect(s.ci).toEqual({ success: 1, failure: 1, running: 1, none: 4 });
		expect(s.ciUnavailable).toEqual([{ status: 403, count: 1 }]);
		expect(s.changedRepoIds).toHaveLength(7);

		// 3 list pages (page size 3) + 1 history batch
		const gql = gh.calls.filter((c) => c.url.endsWith("/graphql"));
		expect(gql).toHaveLength(4);
		// history only for in-window repos
		const historyIds: string[] = JSON.parse(gql[3]?.body ?? "{}").variables.ids;
		expect(historyIds.sort()).toEqual(
			["alpha", "beta", "delta", "epsilon", "gamma"].map(
				(n) => `node:octo-example/${n}`,
			),
		);
		// CI only for in-window repos, all GET
		const rest = gh.calls.filter((c) => !c.url.endsWith("/graphql"));
		expect(rest).toHaveLength(5);
		expect(rest.every((c) => c.method === "GET")).toBe(true);

		expect(repoRow(db, "octo-example/alpha")).toMatchObject({
			is_private: 1,
			commits_30d: 12,
			open_prs: 1,
			open_issues: 2,
			ci_status: "success",
			district: "games",
			language: "TypeScript",
			is_local_only: 0,
		});
		expect(repoRow(db, "octo-example/beta")).toMatchObject({
			district: "school",
			ci_status: "failure",
		});
		expect(repoRow(db, "octo-example/zeta")).toMatchObject({
			commits_30d: 0,
			ci_status: "none",
			district: "uncategorized",
		});
		expect(repoRow(db, "octo-example/eta")).toMatchObject({
			ci_status: "none",
			commits_30d: 0,
		});
	});

	test("second run uses ETags (304) and reports no changes", async () => {
		const { db, client, gh } = setupSync();
		await syncGithub({ db, client, districts, now: NOW });
		gh.calls.length = 0;
		const s = await syncGithub({ db, client, districts, now: NOW });
		expect(s.ciCached).toBe(4); // alpha beta gamma delta (epsilon is 403)
		expect(s.changedRepoIds).toEqual([]);
		const rest = gh.calls.filter((c) => !c.url.endsWith("/graphql"));
		expect(rest.filter((c) => c.headers.has("if-none-match"))).toHaveLength(4);
	});

	test("rate limit below threshold → aborted, rows written so far kept", async () => {
		const { db, client } = setupSync(REPOS, { graphqlRemaining: 50 }, 100);
		const s = await syncGithub({ db, client, districts, now: NOW });
		expect(s.aborted).toMatch(/^rate-limit \(graphql\)/);
		// first page landed before the guard tripped
		expect(s.total).toBe(3);
		expect(
			db.query<{ n: number }, []>("SELECT count(*) AS n FROM repos").get()?.n,
		).toBe(3);
	});

	test("local mapping: case-insensitive match, local-only, no-origin, worktree, cleanup", async () => {
		const { db, client } = setupSync();
		const checkouts: LocalCheckout[] = [
			{
				path: "/w/alpha",
				slug: "OCTO-EXAMPLE/ALPHA",
				isWorktree: false,
				hasOrigin: true,
				error: null,
			},
			{
				path: "/w/alpha-wt",
				slug: "octo-example/alpha",
				isWorktree: true,
				hasOrigin: true,
				error: null,
			},
			{
				path: "/w/someone-else",
				slug: "other-owner/tool",
				isWorktree: false,
				hasOrigin: true,
				error: null,
			},
			{
				path: "/w/scratch",
				slug: null,
				isWorktree: false,
				hasOrigin: false,
				error: null,
			},
			{
				path: "/w/gitlab-thing",
				slug: null,
				isWorktree: false,
				hasOrigin: true,
				error: null,
			},
			{
				path: "/w/broken",
				slug: null,
				isWorktree: false,
				hasOrigin: false,
				error: "git rev-parse failed",
			},
		];
		let scan = checkouts;
		const s = await syncGithub({
			db,
			client,
			districts,
			now: NOW,
			local: { machineId: "cockpit", roots: ["/w"], scan: async () => scan },
		});
		expect(s.local).toMatchObject({
			scanned: 6,
			mapped: 2,
			worktrees: 1,
			errors: 1,
		});
		expect(s.local?.localOnly.map((l) => [l.id, l.reason])).toEqual([
			["other-owner/tool", "origin not in this account's GitHub repos"],
			["local/scratch", "no origin remote"],
			["local/gitlab-thing", "origin is not github.com"],
		]);
		expect(
			db
				.query(
					"SELECT path, repo_id, is_worktree FROM repo_paths ORDER BY path",
				)
				.all(),
		).toEqual([
			{ path: "/w/alpha", repo_id: "octo-example/alpha", is_worktree: 0 },
			{ path: "/w/alpha-wt", repo_id: "octo-example/alpha", is_worktree: 1 },
			{
				path: "/w/gitlab-thing",
				repo_id: "local/gitlab-thing",
				is_worktree: 0,
			},
			{ path: "/w/scratch", repo_id: "local/scratch", is_worktree: 0 },
			{ path: "/w/someone-else", repo_id: "other-owner/tool", is_worktree: 0 },
		]);
		expect(repoRow(db, "local/scratch")).toMatchObject({
			is_local_only: 1,
			district: "uncategorized",
		});
		expect(
			db.query("SELECT role FROM machines WHERE id = 'cockpit'").get(),
		).toEqual({ role: "cockpit" });

		// checkout removed → its path and the orphaned local-only repo disappear; GitHub repos stay
		scan = checkouts.filter((c) => c.path !== "/w/scratch");
		await syncGithub({
			db,
			client,
			districts,
			now: NOW,
			local: { machineId: "cockpit", roots: ["/w"], scan: async () => scan },
		});
		expect(repoRow(db, "local/scratch")).toBeNull();
		expect(repoRow(db, "octo-example/alpha")).not.toBeNull();
	});
});

// ── local scan against real (temporary) git repos — no network ────────────

describe("local scan (temp git repos)", () => {
	const git = (cwd: string, ...args: string[]) => {
		const p = Bun.spawnSync(
			[
				"git",
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@example.invalid",
				"-c",
				"init.defaultBranch=main",
				...args,
			],
			{ cwd, stdout: "ignore", stderr: "pipe" },
		);
		if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
	};

	test("depth limit, skip dirs, worktree detection, remote parsing", async () => {
		const root = mkdtempSync(join(tmpdir(), "agentcity-scan-"));
		const mk = (...parts: string[]) => {
			const d = join(root, ...parts);
			mkdirSync(d, { recursive: true });
			return d;
		};
		const a = mk("a");
		git(a, "init", "-q");
		git(
			a,
			"remote",
			"add",
			"origin",
			`https://someone:${"p".repeat(12)}@github.com/octo-example/alpha.git`,
		);
		git(a, "commit", "-q", "--allow-empty", "-m", "init");
		git(
			a,
			"worktree",
			"add",
			"-q",
			join(root, "wt", "a-feature"),
			"-b",
			"feature",
		);

		const deep = mk("x1", "x2", "x3", "x4", "deep-ok");
		git(deep, "init", "-q"); // depth 5 from root → out of range
		const d4 = mk("y1", "y2", "y3", "at-four");
		git(d4, "init", "-q"); // depth 4 → found
		writeFileSync(join(mk("node_modules", "pkg"), ".git"), "gitdir: nowhere\n");
		mk(".hidden", "r");
		git(join(root, ".hidden", "r"), "init", "-q");

		const found = findCheckouts([root]).map((p) => p.slice(root.length + 1));
		expect(found).toEqual(["a", "wt/a-feature", "y1/y2/y3/at-four"]);

		const main = await probeCheckout(a);
		expect(main).toMatchObject({
			slug: "octo-example/alpha",
			isWorktree: false,
			hasOrigin: true,
			error: null,
		});
		const wt = await probeCheckout(join(root, "wt", "a-feature"));
		expect(wt).toMatchObject({ slug: "octo-example/alpha", isWorktree: true });
		const bare = await probeCheckout(d4);
		expect(bare).toMatchObject({
			slug: null,
			hasOrigin: false,
			isWorktree: false,
		});
		expect(JSON.stringify([main, wt, bare])).not.toContain("p".repeat(12));
	});
});
