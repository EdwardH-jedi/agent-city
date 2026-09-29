import { describe, expect, test } from "bun:test";
import { localRepoId, parseGithubRemote } from "./repo-slug.ts";

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
});
