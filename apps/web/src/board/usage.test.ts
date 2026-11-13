// USAGE box and the top band's 토큰 (18 §5 U3). Fake secrets are assembled at runtime.
import { describe, expect, test } from "bun:test";
import type { UsageSummary } from "@agent-city/schema";
import { parseHubMessage } from "../merge.ts";
import { demoUsage } from "./demo.ts";
import {
	NO_PROJECT,
	parseUsage,
	tokenWord,
	USAGE_PROJECTS_SHOWN,
	usagePanel,
	usageProjectLabel,
	usageTopWord,
} from "./usage.ts";

const FAKE_GH = `ghp_${"u".repeat(36)}`;
// 2026-11-13 20:00 AEDT
const NOW = Date.parse("2026-11-13T09:00:00Z");

const row = (over: Partial<UsageSummary["rows"][number]> = {}) => ({
	day: "2026-11-13",
	project: "demo/harbor",
	tool: "claude" as const,
	model: "claude-opus-5-5",
	input_tokens: 10,
	output_tokens: 1_000,
	cache_read_tokens: 50_000,
	cache_write_tokens: 2_000,
	messages: 3,
	sessions: 1,
	...over,
});
const summary = (
	rows: UsageSummary["rows"],
	limits: UsageSummary["limits"] = [],
): UsageSummary => ({
	tz: "Australia/Sydney",
	today: "2026-11-13",
	days: [],
	rows,
	limits,
	updated_at: null,
});
const limit = (over = {}) => ({
	machine_id: "cockpit" as const,
	tool: "codex" as const,
	limit_id: "codex",
	window_minutes: 10080,
	used_percent: 48.4,
	resets_at: "2026-11-16T00:00:00.000Z",
	plan_type: "prolite",
	observed_at: "2026-11-13T08:30:00.000Z",
	received_at: "2026-11-13T08:30:01.000Z",
	...over,
});

describe("usagePanel", () => {
	test("today's figure leaves cache reads out; tools and projects split it; 7 days end today", () => {
		const p = usagePanel(
			summary([
				row(),
				row({ project: "demo/orchard", input_tokens: 5_000 }),
				row({ tool: "codex", model: "gpt-6-astra", project: null }),
				row({ day: "2026-11-12", output_tokens: 7 }),
				row({ day: "2026-11-01" }), // outside the 7 days
			]),
			NOW,
		);
		expect(p).not.toBeNull();
		expect(p?.total).toBe(3_010 + 8_000 + 3_010);
		expect(p?.cacheRead).toBe(150_000);
		expect(p?.claude).toBe(3_010 + 8_000);
		expect(p?.codex).toBe(3_010);
		expect(p?.projects.map((b) => [b.label, b.tokens])).toEqual([
			["orchard", 8_000],
			["harbor", 3_010],
			[NO_PROJECT, 3_010],
		]);
		expect(p?.projects[0]?.share).toBe(1);
		expect(p?.trend.map((d) => d.day)).toEqual([
			"2026-11-07",
			"2026-11-08",
			"2026-11-09",
			"2026-11-10",
			"2026-11-11",
			"2026-11-12",
			"2026-11-13",
		]);
		expect(p?.trend.at(-2)?.tokens).toBe(2_017);
		expect(p?.weekTotal).toBe(14_020 + 2_017);
		expect(usageTopWord(p ?? null)).toBe("14k");
	});

	test(`at most ${USAGE_PROJECTS_SHOWN} bars; the rest are counted`, () => {
		const rows = ["a", "b", "c", "d", "e", "f"].map((n, i) =>
			row({ project: `demo/${n}`, output_tokens: 1000 * (i + 1) }),
		);
		const p = usagePanel(summary(rows), NOW);
		expect(p?.projects).toHaveLength(USAGE_PROJECTS_SHOWN);
		expect(p?.projects[0]?.label).toBe("f");
		expect(p?.more).toBe(2);
	});

	test("Sydney midnight rolls the day over on this device's clock, with no new report", () => {
		const p = usagePanel(summary([row()]), Date.parse("2026-11-13T13:00:00Z"));
		expect(p?.today).toBe("2026-11-14");
		expect(p?.total).toBe(0);
		expect(usageTopWord(p)).toBeNull(); // no 토큰 0 cell
		expect(p?.trend.at(-2)?.tokens).toBe(3_010); // yesterday still in the 7 days
	});

	test("nothing in 7 days and no limit → no box; no summary → no box", () => {
		expect(usagePanel(summary([row({ day: "2026-10-01" })]), NOW)).toBeNull();
		expect(usagePanel(null, NOW)).toBeNull();
	});

	test("a limit is said only while fresh and before its reset, rounded", () => {
		expect(usagePanel(summary([row()], [limit()]), NOW)?.limits).toEqual([
			"Codex 주간 48%",
		]);
		const stale = limit({ observed_at: "2026-11-13T01:00:00.000Z" });
		expect(usagePanel(summary([row()], [stale]), NOW)?.limits).toEqual([]);
		const past = limit({ resets_at: "2026-11-13T08:59:00.000Z" });
		expect(usagePanel(summary([row()], [past]), NOW)?.limits).toEqual([]);
		const five = limit({ window_minutes: 300 });
		expect(usagePanel(summary([row()], [five]), NOW)?.limits).toEqual([
			"Codex 5시간 48%",
		]);
	});
});

describe("what reaches the screen", () => {
	test("project names: repo-id shaped only, the repo's own name, never a secret or a path", () => {
		expect(usageProjectLabel("demo/harbor")).toBe("harbor");
		expect(usageProjectLabel("local/my-folder")).toBe("my-folder");
		expect(usageProjectLabel("local/My Project")).toBe("My Project");
		for (const bad of [
			null,
			`demo/${FAKE_GH}`,
			"cat /Users/me/.ssh/id_ed25519",
			"local/ a",
			"local/a\tb",
			"/Users/me/x",
			"demo/password=hunter2",
		])
			expect(usageProjectLabel(bad)).toBe(NO_PROJECT);
	});

	test("a usage push carrying secrets: malformed → dropped; shaped → only numbers and safe names shown", () => {
		const bad = JSON.stringify({
			kind: "usage",
			data: { ...summary([row()]), rows: [{ ...row(), note: FAKE_GH }] },
		});
		// extra keys are stripped by the schema; the value never reaches the panel
		const parsed = parseHubMessage(bad);
		const shown = JSON.stringify(
			parsed?.kind === "usage" ? usagePanel(parsed.data, NOW) : null,
		);
		expect(shown).not.toContain(FAKE_GH);
		for (const frame of [
			{ kind: "usage", data: { rows: "x" } },
			{ kind: "usage", data: { ...summary([row({ input_tokens: -1 })]) } },
			{ kind: "usage", data: { ...summary([row({ day: FAKE_GH })]) } },
			{ kind: "usage" },
		])
			expect(parseHubMessage(JSON.stringify(frame))).toBeNull();
		const sneaky = summary([
			row({ project: `demo/${FAKE_GH}` }),
			row({ project: "demo/x y /Users/me" }),
			row({ model: FAKE_GH }),
		]);
		const msg = parseHubMessage(
			JSON.stringify({ kind: "usage", data: sneaky }),
		);
		expect(msg?.kind).toBe("usage");
		const text = JSON.stringify(
			msg?.kind === "usage" ? usagePanel(msg.data, NOW) : null,
		);
		for (const leak of [FAKE_GH, "/Users/", "x y"])
			expect(text).not.toContain(leak);
	});

	test("parseUsage refuses a summary with too many rows", () => {
		const many = Array.from({ length: 5_001 }, () => row());
		expect(parseUsage(summary(many))).toBeNull();
	});
});

describe("break-it round 2", () => {
	test("two repos with the same name stay two bars, with their owners", () => {
		const p = usagePanel(
			summary([
				row({ project: "a/web", output_tokens: 5_000 }),
				row({ project: "b/web" }),
				row({ project: "c/api" }),
			]),
			NOW,
		);
		expect(p?.projects.map((b) => b.label)).toEqual(["a/web", "b/web", "api"]);
	});

	test("limits: one per tool and window (the newest), none from the future, at most 16 in a frame", () => {
		const p = usagePanel(
			summary(
				[row()],
				[
					limit({ limit_id: "codex", used_percent: 12, window_minutes: 300 }),
					limit({
						limit_id: "default",
						used_percent: 15,
						window_minutes: 300,
						observed_at: "2026-11-13T08:40:00.000Z",
					}),
					limit({ observed_at: "2026-11-13T20:00:00.000Z", used_percent: 99 }),
				],
			),
			NOW,
		);
		expect(p?.limits).toEqual(["Codex 5시간 15%"]);
		const many = Array.from({ length: 17 }, (_, i) =>
			limit({ limit_id: `l${i}` }),
		);
		expect(parseUsage(summary([row()], many))).toBeNull();
	});
});

describe("tokenWord and the demo", () => {
	test("short forms", () => {
		expect(
			[0, 950, 12_345, 203_000, 1_234_567, 34_000_000, 1_200_000_000].map(
				tokenWord,
			),
		).toEqual(["0", "950", "12k", "203k", "1.2M", "34M", "1.2B"]);
	});

	test("the demo's made-up usage is a valid summary with a box for every case", () => {
		for (const kase of ["default", "calm", "busy", "done"] as const) {
			const u = demoUsage(NOW, kase);
			expect(parseUsage(u)).not.toBeNull();
			const p = usagePanel(u, NOW);
			expect(p?.total).toBeGreaterThan(0);
			expect(p?.limits).toEqual(["Codex 주간 42%"]);
		}
	});
});
