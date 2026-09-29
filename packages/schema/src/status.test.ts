import { describe, expect, test } from "bun:test";
import { applyStale, endsAgent, nextStatus, STALE_AFTER_MS } from "./status.ts";

describe("nextStatus", () => {
	test.each([
		["SessionStart", "active"],
		["UserPromptSubmit", "active"],
		["PreToolUse", "active"],
		["PostToolUse", "active"],
		["Notification", "waiting"],
		["Stop", "idle"],
		["SubagentStop", "active"],
		["SessionEnd", "ended"],
		["codex.some_unknown_record", "active"],
	] as const)("%s → %s", (type, expected) => {
		expect(nextStatus(type)).toBe(expected);
	});
});

describe("applyStale", () => {
	const last = "2026-01-01T00:00:00.000Z";
	const at = (ms: number) => new Date(Date.parse(last) + ms);

	test.each(["active", "idle"] as const)(
		"%s → stale at exactly 15 min",
		(status) => {
			expect(applyStale(status, last, at(STALE_AFTER_MS))).toBe("stale");
		},
	);

	test.each(["active", "waiting", "idle"] as const)(
		"%s unchanged just under 15 min",
		(status) => {
			expect(applyStale(status, last, at(STALE_AFTER_MS - 1))).toBe(status);
		},
	);

	test("waiting never goes stale (needs a human; only the next event / SessionEnd moves it)", () => {
		expect(applyStale("waiting", last, at(STALE_AFTER_MS * 100))).toBe(
			"waiting",
		);
		expect(nextStatus("PreToolUse")).toBe("active");
		expect(nextStatus("SessionEnd")).toBe("ended");
	});

	test("ended never goes stale", () => {
		expect(applyStale("ended", last, at(STALE_AFTER_MS * 10))).toBe("ended");
	});

	test("stale stays stale", () => {
		expect(applyStale("stale", last, at(STALE_AFTER_MS * 2))).toBe("stale");
	});

	test("unparseable last_event_at leaves status alone", () => {
		expect(applyStale("active", "garbage", at(STALE_AFTER_MS * 2))).toBe(
			"active",
		);
	});
});

describe("endsAgent", () => {
	test("SubagentStop ends the subagent row while the session stays active", () => {
		expect(endsAgent("SubagentStop")).toBe(true);
		expect(nextStatus("SubagentStop")).toBe("active");
	});

	test.each(["Task", "Agent"])(
		"PostToolUse of %s ends the subagent it spawned",
		(tool) => {
			expect(endsAgent("PostToolUse", tool)).toBe(true);
			expect(endsAgent("PreToolUse", tool)).toBe(false);
		},
	);

	test.each([
		["SessionStart", null],
		["UserPromptSubmit", null],
		["PreToolUse", "Bash"],
		["PostToolUse", "Bash"],
		["PostToolUse", null],
		["Notification", null],
		["Stop", null],
		["SessionEnd", null],
	] as const)("%s (%s) does not end an agent row", (type, tool) => {
		expect(endsAgent(type, tool)).toBe(false);
	});
});
