// The "never write under ~/.claude" guard of `collector:hooks`. Windows paths use backslashes (and
// a case-insensitive drive/dir), so the check is exercised with `path.win32` on any host.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { isInsideDir } from "./install-hooks.ts";

describe("isInsideDir — Windows paths", () => {
	const w = path.win32;
	const claude = "C:\\Users\\me\\.claude";

	test.each([
		["a file directly inside", "C:\\Users\\me\\.claude\\settings.json"],
		["a file nested deeper", "C:\\Users\\me\\.claude\\hooks\\sub\\x.json"],
		["the directory itself", "C:\\Users\\me\\.claude"],
		["forward slashes", "C:/Users/me/.claude/settings.json"],
		["different letter case", "c:\\users\\ME\\.CLAUDE\\settings.json"],
		["a .. that stays inside", "C:\\Users\\me\\.claude\\a\\..\\x.json"],
		["a trailing separator", "C:\\Users\\me\\.claude\\"],
	])("refuses %s", (_name, target) => {
		expect(isInsideDir(target, claude, w)).toBe(true);
	});

	test.each([
		[
			"a sibling that shares the prefix",
			"C:\\Users\\me\\.claude-backup\\x.json",
		],
		["the default output dir", "C:\\Users\\me\\.agentcity\\merged.json"],
		["another drive", "D:\\Users\\me\\.claude\\x.json"],
		["a .. that leaves it", "C:\\Users\\me\\.claude\\..\\.agentcity\\x.json"],
		["the parent", "C:\\Users\\me"],
	])("allows %s", (_name, target) => {
		expect(isInsideDir(target, claude, w)).toBe(false);
	});

	test("a directory whose name starts with '..' is still inside", () => {
		expect(isInsideDir("C:\\Users\\me\\.claude\\..hidden\\x", claude, w)).toBe(
			true,
		);
	});
});

describe("isInsideDir — POSIX paths", () => {
	const p = path.posix;
	const claude = "/home/me/.claude";

	test("refuses the directory, a file in it and a nested file", () => {
		expect(isInsideDir("/home/me/.claude", claude, p)).toBe(true);
		expect(isInsideDir("/home/me/.claude/settings.json", claude, p)).toBe(true);
		expect(isInsideDir("/home/me/.claude/a/b/x.json", claude, p)).toBe(true);
		expect(isInsideDir("/home/me/.claude/..hidden/x", claude, p)).toBe(true);
	});

	test("allows siblings, the parent and a .. that leaves it", () => {
		expect(isInsideDir("/home/me/.claude-backup/x.json", claude, p)).toBe(
			false,
		);
		expect(isInsideDir("/home/me/.agentcity/merged.json", claude, p)).toBe(
			false,
		);
		expect(isInsideDir("/home/me", claude, p)).toBe(false);
		expect(isInsideDir("/home/me/.claude/../x.json", claude, p)).toBe(false);
	});

	test("the default host path module behaves like POSIX on this input", () => {
		if (path.sep === "/")
			expect(isInsideDir("/home/me/.claude/x.json", claude)).toBe(true);
	});
});
