import { describe, expect, test } from "bun:test";
import {
	mainAgentId,
	namespaceIds,
	scopedAgentId,
	sessionId,
	subagentId,
} from "./ids.ts";
import { normalizeRepoId, parseGithubRemote, repoKey } from "./repo-slug.ts";

describe("F10 id namespace", () => {
	test("session = <provider>:<raw>, idempotent", () => {
		expect(sessionId("claude", "abc")).toBe("claude:abc");
		expect(sessionId("codex", "abc")).toBe("codex:abc");
		expect(sessionId("claude", "claude:abc")).toBe("claude:abc");
		// another provider's prefix is part of the raw id; `:` is reserved → the raw id is hashed
		expect(sessionId("codex", "claude:abc")).toMatch(
			/^codex:redacted-[0-9a-f]{16}$/,
		);
	});

	test("main agent = session; subagent = <session>/sub:<tool_use_id>", () => {
		expect(mainAgentId("claude:s")).toBe("claude:s");
		expect(subagentId("claude:s", "tu1")).toBe("claude:s/sub:tu1");
	});

	test("scopedAgentId maps legacy shapes into the session", () => {
		expect(scopedAgentId("claude:s", null)).toBe("claude:s");
		expect(scopedAgentId("claude:s", "claude:s")).toBe("claude:s");
		expect(scopedAgentId("claude:s", "s", "s")).toBe("claude:s"); // legacy main / parent
		expect(scopedAgentId("claude:s", "sub:tu1")).toBe("claude:s/sub:tu1"); // legacy subagent
		expect(scopedAgentId("claude:s", "claude:s/sub:tu1")).toBe(
			"claude:s/sub:tu1",
		);
	});

	test("namespaceIds upgrades a legacy event and is idempotent", () => {
		const legacy = {
			provider: "claude" as const,
			session_id: "s",
			agent_id: "sub:tu1",
			parent_agent_id: "s",
		};
		const once = namespaceIds(legacy);
		expect(once).toEqual({
			provider: "claude",
			session_id: "claude:s",
			agent_id: "claude:s/sub:tu1",
			parent_agent_id: "claude:s",
		});
		expect(namespaceIds(once)).toEqual(once);
		expect(namespaceIds({ provider: "codex", session_id: "x" })).toEqual({
			provider: "codex",
			session_id: "codex:x",
		});
	});

	test("same raw id under two providers or two sessions never collides", () => {
		const a = namespaceIds({
			provider: "claude",
			session_id: "one",
			agent_id: "sub:reused",
		});
		const b = namespaceIds({
			provider: "codex",
			session_id: "one",
			agent_id: "sub:reused",
		});
		expect(a.session_id).not.toBe(b.session_id);
		expect(a.agent_id).not.toBe(b.agent_id);
	});
});

describe("F13 repo id normalization", () => {
	test.each([
		["octo/alpha", "octo/alpha"],
		["  Octo/Alpha ", "Octo/Alpha"],
		["octo/alpha/", "octo/alpha"],
		// N02: `.git` is only stripped while parsing a remote URL, never here
		["local/foo.git", "local/foo.git"],
		["octo/alpha.GIT", "octo/alpha.GIT"],
	])("normalizeRepoId(%p) → %p", (raw, want) => {
		expect(normalizeRepoId(raw)).toBe(want);
	});

	test("repoKey is case-insensitive; parseGithubRemote strips .git from the URL", () => {
		expect(repoKey("Octo/Alpha")).toBe(repoKey("octo/alpha"));
		expect(repoKey("local/foo.git")).not.toBe(repoKey("local/foo"));
		expect(parseGithubRemote("https://github.com/Octo/Alpha.git")).toBe(
			normalizeRepoId("Octo/Alpha"),
		);
	});
});
