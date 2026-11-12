import { describe, expect, test } from "bun:test";
import {
	githubRepoFromConfig,
	githubRepoFromRemotes,
	localRepoId,
	parseGithubRemote,
	remotesFromConfig,
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
});
