import { describe, expect, test } from "bun:test";
import {
	GIT_INSTEADOF_MAX,
	GIT_PATH_MAX,
	GIT_REMOTES_MAX,
	GIT_URL_MAX,
	githubRepoFromConfig,
	githubRepoFromRemotes,
	localRepoId,
	normalizeRepoId,
	parseGithubRemote,
	remotesFromConfig,
	repoKey,
} from "./repo-slug.ts";

describe("parseGithubRemote", () => {
	test.each([
		["https://github.com/octo-example/alpha", "octo-example/alpha"],
		["https://github.com/octo-example/alpha.git", "octo-example/alpha"],
		["https://github.com/octo-example/alpha/", "octo-example/alpha"],
		["http://github.com/octo-example/alpha.git", "octo-example/alpha"],
		["git@github.com:octo-example/alpha.git", "octo-example/alpha"],
		["git@github.com:octo-example/alpha", "octo-example/alpha"],
		["ssh://git@github.com/octo-example/alpha.git", "octo-example/alpha"],
		["ssh://git@github.com:22/octo-example/alpha", "octo-example/alpha"],
		["git://github.com/octo-example/alpha.git", "octo-example/alpha"],
		["https://GitHub.com/Octo-Example/Alpha.git", "Octo-Example/Alpha"],
		[
			"  https://github.com/octo-example/dotted.name.git\n",
			"octo-example/dotted.name",
		],
	])("%s → %s", (url, slug) => {
		expect(parseGithubRemote(url)).toBe(slug);
	});

	test("credentials in the URL are discarded", () => {
		const secret = `x${"s".repeat(30)}`;
		const slug = parseGithubRemote(
			`https://someone:${secret}@github.com/octo-example/alpha.git`,
		);
		expect(slug).toBe("octo-example/alpha");
		expect(slug).not.toContain(secret);
	});

	test.each([
		"https://gitlab.com/octo-example/alpha.git",
		"git@bitbucket.org:octo-example/alpha.git",
		"https://github.com.evil.example/octo-example/alpha",
		"https://github.com/octo-example",
		"https://github.com/octo-example/alpha/tree/main",
		"/local/path/repo",
		"",
	])("not a github.com repo: %s", (url) => {
		expect(parseGithubRemote(url)).toBeNull();
	});
});

describe("localRepoId", () => {
	test("basename of the work tree", () => {
		expect(localRepoId("/Users/example/code/scratch")).toBe("local/scratch");
		expect(localRepoId("/Users/example/code/scratch/")).toBe("local/scratch");
	});

	test("a linked worktree (common dir `<main>/.git`) takes the main checkout's folder", () => {
		expect(
			localRepoId("/w/_worktrees/rover/notes-1", "/w/code/rover/.git"),
		).toBe("local/rover");
		expect(localRepoId("/w/code/rover", "/w/code/rover/.git")).toBe(
			"local/rover",
		);
		// trailing separators, Windows paths, mixed separators
		expect(localRepoId("/w/wt/", "/w/code/rover/.git/")).toBe("local/rover");
		expect(localRepoId("C:\\code\\wt\\notes", "C:\\code\\rover\\.git\\")).toBe(
			"local/rover",
		);
		expect(localRepoId("C:/code/wt", "C:\\code\\rover\\.git")).toBe(
			"local/rover",
		);
	});

	test("a bare common dir or none: the work tree's own folder, as before", () => {
		expect(localRepoId("/w/wt/feature", "/w/repos/rover.git")).toBe(
			"local/feature",
		);
		expect(localRepoId("/w/wt/feature", undefined)).toBe("local/feature");
		expect(localRepoId("/w/wt/feature", "")).toBe("local/feature");
		expect(localRepoId("/w/wt/feature", ".git")).toBe("local/feature");
	});
});

describe("remotes", () => {
	const cfg = [
		"[core]",
		"\tbare = false",
		'[remote "upstream-x"]',
		"\turl = git@github.com:octo-example/rover.git",
		"\tfetch = +refs/heads/*:refs/remotes/upstream-x/*",
		'[remote "mirror"]',
		'\turl = "https://gitlab.example.invalid/octo/rover.git"',
		'[branch "main"]',
		"\tremote = upstream-x",
	].join("\n");

	test("remotesFromConfig: every [remote] url, quotes stripped, other sections ignored", () => {
		expect(remotesFromConfig(cfg)).toEqual([
			{ name: "upstream-x", url: "git@github.com:octo-example/rover.git" },
			{ name: "mirror", url: "https://gitlab.example.invalid/octo/rover.git" },
		]);
		expect(remotesFromConfig("")).toEqual([]);
	});

	const gh = (name: string, slug: string) => ({
		name,
		url: `https://github.com/${slug}.git`,
	});
	test("origin wins when it is on github.com; a non-github origin stays local (unchanged)", () => {
		expect(
			githubRepoFromRemotes([
				gh("upstream", "someone/else"),
				gh("origin", "octo-example/alpha"),
			]),
		).toBe("octo-example/alpha");
		expect(
			githubRepoFromRemotes([
				{ name: "origin", url: "https://gitlab.example.invalid/o/a.git" },
				gh("github", "octo-example/alpha"),
			]),
		).toBeNull();
	});

	test("no origin: exactly one github.com repo among the remotes names it; two or none: null", () => {
		expect(githubRepoFromRemotes(remotesFromConfig(cfg))).toBe(
			"octo-example/rover",
		);
		expect(
			githubRepoFromRemotes([
				gh("github-rover", "octo-example/rover"),
				gh("backup", "Octo-Example/Rover"), // the same repo spelled twice
			]),
		).toBe("octo-example/rover");
		expect(
			githubRepoFromRemotes([
				gh("a", "octo-example/rover"),
				gh("b", "octo-example/rover-fork"),
			]),
		).toBeNull();
		expect(githubRepoFromRemotes([])).toBeNull();
		expect(
			githubRepoFromRemotes([
				{ name: "mirror", url: "https://gitlab.example.invalid/o/a.git" },
			]),
		).toBeNull();
	});
});

describe("githubRepoFromConfig (the collector reads .git/config as text)", () => {
	const gh = '[remote "gh"]\n\turl = https://github.com/octo-example/x.git';
	test("an origin written another way is still found, so the other remote is not taken for it", () => {
		const elsewhere = "url = https://gitlab.example.invalid/o/x.git";
		expect(
			githubRepoFromConfig(`[remote "origin"] # c\n\t${elsewhere}\n${gh}`),
		).toBeNull();
		expect(
			githubRepoFromConfig(`[remote.origin]\n\t${elsewhere}\n${gh}`),
		).toBeNull();
		expect(
			githubRepoFromConfig(`[remote "origin"]\r\n\t${elsewhere}\r\n${gh}`),
		).toBeNull();
	});

	test("an [include] may hold the origin: with no origin in the file itself, no guess", () => {
		expect(
			githubRepoFromConfig(`[include]\n\tpath = more.cfg\n${gh}`),
		).toBeNull();
		expect(
			githubRepoFromConfig(
				`[includeIf "gitdir:~/w/"]\n\tpath = more.cfg\n${gh}`,
			),
		).toBeNull();
		expect(githubRepoFromConfig(gh)).toBe("octo-example/x");
	});

	test("url.<base>.insteadOf is applied (longest prefix); the first url of a remote counts", () => {
		const cfg = [
			'[url "https://github.com/"]',
			"\tinsteadOf = gh:",
			'[url "https://gitlab.example.invalid/"]',
			"\tinsteadOf = gh:mirror/",
			'[remote "origin"]',
			"\turl = gh:octo-example/aliased",
			"\turl = https://github.com/someone/second.git",
		].join("\n");
		expect(githubRepoFromConfig(cfg)).toBe("octo-example/aliased");
		expect(
			githubRepoFromConfig(
				cfg.replace("gh:octo-example/aliased", "gh:mirror/aliased"),
			),
		).toBeNull();
	});

	test("as git reads them: a key on the header line, `#` with no space, legacy names lower-cased, a remote without url", () => {
		const gh = '[remote "gh"]\n\turl = https://github.com/octo-example/x.git';
		const elsewhere = "url = https://gitlab.example.invalid/o/x";
		expect(
			githubRepoFromConfig(`[remote "origin"] ${elsewhere}\n${gh}`),
		).toBeNull();
		expect(githubRepoFromConfig(`[include] path = more.cfg\n${gh}`)).toBeNull();
		expect(
			githubRepoFromConfig(
				'[remote "origin"]\n\turl = https://github.com/o/r.git#c',
			),
		).toBe("o/r");
		expect(
			githubRepoFromConfig(`[remote.Origin]\n\t${elsewhere}\n${gh}`),
		).toBeNull();
		// origin with no url: git uses the name as its url → not github, and origin decides
		expect(
			githubRepoFromConfig(`[remote "origin"]\n\tprune = true\n${gh}`),
		).toBeNull();
		// escaped quotes inside a quoted value: unescaped, and the trailing comment dropped
		expect(
			remotesFromConfig(
				'[remote "origin"]\n\turl = "https://h/\\"q\\".git" # c',
			),
		).toEqual([{ name: "origin", url: 'https://h/"q".git' }]);
		// pushInsteadOf does not rewrite the fetch url
		expect(
			githubRepoFromConfig(
				'[url "https://github.com/"]\n\tpushInsteadOf = gh:\n[remote "origin"]\n\turl = gh:o/r',
			),
		).toBeNull();
	});

	test("bounded time on a 64 KB config the hook might read (no backtracking)", () => {
		const pad = " ".repeat(64_000);
		for (const cfg of [
			`[remote "origin"]\n\turl = https://github.com/o/r.git${pad}x`,
			`[remote "${"a".repeat(64_000)}`,
			`[${"a.".repeat(32_000)}]`,
			`[remote "origin"]\n\turl = "${'\\"'.repeat(20_000)}`,
			`${'[url "x"]\n\tinsteadOf = y\n'.repeat(2_000)}[remote "origin"]\n\turl = y/z`,
		]) {
			const t = performance.now();
			githubRepoFromConfig(cfg);
			expect(performance.now() - t).toBeLessThan(50);
		}
	});
});

describe("trailing-separator trimming is linear (the hook and ingest feed it untrusted text)", () => {
	// Was /[/\\]+$/ and /\/+$/: unanchored, so every start position inside a long separator run
	// re-scanned it — 60 000 backslashes + "x" in a worktree's commondir took 1.5 s in the hook.
	const N = 64 * 1024;
	test.each([
		["localRepoId, toplevel", () => localRepoId(`/w/${"\\".repeat(N)}x`)],
		[
			"localRepoId, toplevel of slashes",
			() => localRepoId(`/w/${"/".repeat(N)}x`),
		],
		[
			"localRepoId, common dir",
			() => localRepoId("/w/wt", `../../${"\\".repeat(N)}x`),
		],
		[
			"localRepoId, common dir ending in .git (parent folder)",
			() => localRepoId("/w/wt", `../../${"\\".repeat(N)}/.git`),
		],
		["normalizeRepoId", () => normalizeRepoId(`${"/".repeat(N)}x`)],
		["repoKey", () => repoKey(`o/${"/".repeat(N)}x`)],
	] as const)("%s: < 50 ms", (_, run) => {
		const t = performance.now();
		run();
		expect(performance.now() - t).toBeLessThan(50);
	});

	// The ids must not change: compare with the regex versions on every short string over the
	// characters that matter (separators, a space, a dot, a letter, "git").
	const old = {
		lastSegment: (p: string) =>
			p
				.replace(/[/\\]+$/, "")
				.split(/[/\\]/)
				.pop() ?? "",
		parentOf: (p: string) => {
			const q = p.replace(/[/\\]+$/, "");
			const i = Math.max(q.lastIndexOf("/"), q.lastIndexOf("\\"));
			return i > 0 ? q.slice(0, i) : "";
		},
		normalizeRepoId: (id: string) => id.trim().replace(/\/+$/, ""),
	};
	const oldLocalRepoId = (toplevel: string, commonDir?: string | null) => {
		const own = old.lastSegment(toplevel) || "unknown";
		if (!commonDir || old.lastSegment(commonDir) !== ".git")
			return `local/${own}`;
		return `local/${old.lastSegment(old.parentOf(commonDir)) || own}`;
	};
	const strings = (alphabet: string[], max: number): string[] => {
		let level = [""];
		const all = [""];
		for (let len = 1; len <= max; len++) {
			level = level.flatMap((s) => alphabet.map((c) => s + c));
			all.push(...level);
		}
		return all;
	};

	test("normalizeRepoId / repoKey: same output as the regex version", () => {
		for (const s of strings(["/", "\\", " ", "a", "A", "\n"], 6)) {
			expect(normalizeRepoId(s)).toBe(old.normalizeRepoId(s));
			expect(repoKey(s)).toBe(old.normalizeRepoId(s).toLowerCase());
		}
	});

	test("localRepoId: same output as the regex version", () => {
		const parts = strings(["/", "\\", "a", "."], 4);
		const tops = [...parts, "/w/wt", "C:\\w\\wt\\"];
		// common dirs that end in a .git segment (reach parentOf), plus plain ones
		const commons = [
			null,
			undefined,
			"",
			...parts,
			...parts.flatMap((p) => [
				`${p}.git`,
				`${p}/.git`,
				`${p}.git/`,
				`${p}\\.git\\`,
			]),
		];
		for (const t of tops)
			for (const c of commons)
				expect(localRepoId(t, c)).toBe(oldLocalRepoId(t, c));
	});
});

describe("input limits: over one, the checkout is not taken for a GitHub repo (local/<folder>)", () => {
	test("the limits", () => {
		expect([
			GIT_REMOTES_MAX,
			GIT_INSTEADOF_MAX,
			GIT_URL_MAX,
			GIT_PATH_MAX,
		]).toEqual([32, 32, 2048, 4096]);
	});
	const remoteSec = (name: string, url: string) =>
		`[remote "${name}"]\n\turl = ${url}\n`;
	const gh = "https://github.com/o/r.git";

	test(`remotes: ${GIT_REMOTES_MAX} counted, one more → null (config and the hub's remote list alike)`, () => {
		const many = (n: number) =>
			Array.from({ length: n }, (_, i) => remoteSec(`r${i}`, gh)).join("");
		expect(githubRepoFromConfig(many(GIT_REMOTES_MAX))).toBe("o/r");
		expect(githubRepoFromConfig(many(GIT_REMOTES_MAX + 1))).toBeNull();
		// the same remote written twice is one remote
		expect(githubRepoFromConfig(many(1).repeat(GIT_REMOTES_MAX + 5))).toBe(
			"o/r",
		);
		const list = (n: number) =>
			Array.from({ length: n }, (_, i) => ({ name: `r${i}`, url: gh }));
		expect(githubRepoFromRemotes(list(GIT_REMOTES_MAX))).toBe("o/r");
		expect(githubRepoFromRemotes(list(GIT_REMOTES_MAX + 1))).toBeNull();
		expect(
			githubRepoFromRemotes([
				{ name: "origin", url: gh },
				...list(GIT_REMOTES_MAX),
			]),
		).toBeNull();
	});

	test(`urls: ${GIT_URL_MAX} chars parse, one more → null (origin or not, config or hub)`, () => {
		const url = (len: number) => {
			const head = "https://github.com/o/";
			return head + "r".repeat(len - head.length);
		};
		const name = (len: number) =>
			`o/${"r".repeat(len - "https://github.com/o/".length)}`;
		expect(url(GIT_URL_MAX)).toHaveLength(GIT_URL_MAX);
		expect(githubRepoFromConfig(remoteSec("origin", url(GIT_URL_MAX)))).toBe(
			name(GIT_URL_MAX),
		);
		expect(
			githubRepoFromConfig(remoteSec("origin", url(GIT_URL_MAX + 1))),
		).toBeNull();
		expect(
			githubRepoFromConfig(remoteSec("gh", url(GIT_URL_MAX + 1))),
		).toBeNull();
		// a long url on another remote: no guess even though origin decides alone
		expect(
			githubRepoFromConfig(
				remoteSec("origin", gh) + remoteSec("x", url(GIT_URL_MAX + 1)),
			),
		).toBeNull();
		expect(
			githubRepoFromRemotes([{ name: "origin", url: url(GIT_URL_MAX + 1) }]),
		).toBeNull();
		expect(
			githubRepoFromRemotes([
				{ name: "a", url: gh },
				{ name: "b", url: url(GIT_URL_MAX + 1) },
			]),
		).toBeNull();
		// a remote without url uses its name as url: the same limit
		expect(
			githubRepoFromConfig(`[remote "${"n".repeat(GIT_URL_MAX + 1)}"]\n`),
		).toBeNull();
	});

	test(`insteadOf: ${GIT_INSTEADOF_MAX} rules, base and prefix ${GIT_URL_MAX} chars; one more → null`, () => {
		const rules = (n: number) =>
			`[url "https://github.com/"]\n${Array.from({ length: n }, (_, i) => `\tinsteadOf = p${i}:\n`).join("")}`;
		const origin = remoteSec("origin", "p0:o/r");
		expect(githubRepoFromConfig(rules(GIT_INSTEADOF_MAX) + origin)).toBe("o/r");
		expect(
			githubRepoFromConfig(rules(GIT_INSTEADOF_MAX + 1) + origin),
		).toBeNull();
		const base = (len: number) =>
			`https://github.com/o/${"r".repeat(len - 21)}`;
		const viaBase = (len: number) =>
			`[url "${base(len)}"]\n\tinsteadOf = g\n${remoteSec("origin", "g")}`;
		expect(githubRepoFromConfig(viaBase(GIT_URL_MAX - 10))).toBe(
			`o/${"r".repeat(GIT_URL_MAX - 31)}`,
		);
		expect(githubRepoFromConfig(viaBase(GIT_URL_MAX + 1))).toBeNull();
		// the origin url is the prefix itself, so only the prefix is at the limit
		const prefix = (len: number) => "q".repeat(len);
		const viaPrefix = (len: number) =>
			`[url "https://github.com/o/r"]\n\tinsteadOf = ${prefix(len)}\n${remoteSec("origin", prefix(len))}`;
		expect(githubRepoFromConfig(viaPrefix(GIT_URL_MAX))).toBe("o/r");
		expect(githubRepoFromConfig(viaPrefix(GIT_URL_MAX + 1))).toBeNull();
		// the rewritten url is a url too: base + rest over the limit → null
		expect(
			githubRepoFromConfig(
				`[url "${base(GIT_URL_MAX)}"]\n\tinsteadOf = g\n${remoteSec("origin", "gx")}`,
			),
		).toBeNull();
	});

	test("no origin: two different github repos end the search (ambiguous → null)", () => {
		expect(
			githubRepoFromConfig(
				remoteSec("a", "https://github.com/o/one") +
					remoteSec("b", "https://github.com/o/two") +
					remoteSec("c", "https://github.com/o/one"),
			),
		).toBeNull();
	});

	test(`common dir over ${GIT_PATH_MAX} chars is ignored: the worktree keeps its own folder`, () => {
		const common = (len: number) =>
			`/${"a".repeat(len - "//main/.git".length)}/main/.git`;
		expect(common(GIT_PATH_MAX)).toHaveLength(GIT_PATH_MAX);
		expect(localRepoId("/w/wt", common(GIT_PATH_MAX))).toBe("local/main");
		expect(localRepoId("/w/wt", common(GIT_PATH_MAX + 1))).toBe("local/wt");
	});
});
