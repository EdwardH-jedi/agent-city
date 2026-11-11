import { describe, expect, test } from "bun:test";
import { ev, iso, runIn, T0 } from "./fixtures.ts";
import {
	buildIncidents,
	INCIDENT_LIMIT,
	type Incident,
	incidentRows,
} from "./incidents.ts";
import { currentRuns, runKey } from "./types.ts";

describe("자리 비운 사이 (§13.4)", () => {
	test("newest first, at most 6, only lines the phrase table backs", () => {
		const r = runIn("passed");
		const events = Array.from({ length: 12 }, (_, i) =>
			ev({
				sequence: i + 1,
				task_id: `T${i + 1}`,
				occurred_at: iso(-(12 - i) * 60_000),
			}),
		);
		const out = buildIncidents(
			currentRuns([r]),
			new Map([[runKey(r), events]]),
		);
		expect(INCIDENT_LIMIT).toBe(6);
		expect(out).toHaveLength(6);
		const times = out.map((i) => Date.parse(i.at));
		expect([...times].sort((a, b) => b - a)).toEqual(times);
	});

	test("short words: 결재 요청 → T1 통과 → 전부 끝남, in order", () => {
		const r = runIn("passed", { last_progress_at: iso(-10_000) });
		const out = buildIncidents(
			currentRuns([r]),
			new Map([
				[
					runKey(r),
					[
						ev({ sequence: 6, occurred_at: iso(-20_000) }),
						ev({
							sequence: 2,
							transition: "task.started",
							occurred_at: iso(-90_000),
						}),
					],
				],
			]),
		);
		expect(out.map((i) => i.text)).toEqual(["전부 끝남", "T1 통과"]);
		const w = buildIncidents(
			currentRuns([
				runIn("waiting_owner", { reason: "AWAITING_PLAN_APPROVAL" }),
			]),
			new Map(),
		);
		expect(w.map((i) => i.text)).toEqual(["결재 요청"]);
	});

	test("escalation says where it went: opus로 올림", () => {
		const r = runIn("running");
		const out = buildIncidents(
			currentRuns([r]),
			new Map([
				[
					runKey(r),
					[
						ev({
							transition: "task.escalated",
							from_model: "sonnet",
							to_model: "opus",
						}),
					],
				],
			]),
		);
		expect(out.map((i) => i.text)).toEqual(["opus로 올림"]);
	});

	test("no line is a sentence or a code: short words only", () => {
		const out = buildIncidents(
			currentRuns([
				runIn("unknown", {
					status: "READY",
					reason: "SOMETHING_NEW",
					display: "snapshot_stale",
					workflow_id: "a",
				}),
				runIn("hold", { reason: "MODEL_CHAIN_EXHAUSTED", workflow_id: "b" }),
				runIn("partial", { reason: "PRESERVED_ON_HOLD", workflow_id: "c" }),
				runIn("unknown", { reason: "DISPATCH_STOPPED", workflow_id: "d" }),
			]),
			new Map(),
		);
		expect(out.map((i) => i.text).sort()).toEqual(
			["확인 필요", "멈춤", "일부만 끝냄 · 폴더 보존", "중간에 멈춤"].sort(),
		);
		for (const i of out) {
			expect(i.text).not.toMatch(/[A-Z_]{4,}/);
			expect(i.text).not.toMatch(/다\.$/);
		}
	});

	test("a running run has no line (it is in 지금 진행)", () => {
		expect(buildIncidents(currentRuns([runIn("running")]), new Map())).toEqual(
			[],
		);
	});

	test("the clock is not used: the same input gives the same lines", () => {
		const cur = currentRuns([runIn("passed")]);
		expect(buildIncidents(cur, new Map())).toEqual(
			buildIncidents(cur, new Map()),
		);
		expect(T0).toBeGreaterThan(0);
	});
});

describe("day dividers", () => {
	const at = (y: number, mo: number, d: number, h: number) =>
		new Date(y, mo, d, h).toISOString();
	const inc = (iso: string): Incident => ({
		at: iso,
		project_id: "acme/a",
		text: "T1 통과",
		code: null,
		source: "event",
	});
	const now = new Date(2026, 10, 11, 9).getTime();

	test("none before today's lines; 어제 where yesterday starts; a date for older days", () => {
		const rows = incidentRows(
			[
				inc(at(2026, 10, 11, 8)),
				inc(at(2026, 10, 11, 1)),
				inc(at(2026, 10, 10, 23)),
				inc(at(2026, 10, 10, 20)),
				inc(at(2026, 10, 8, 12)),
			],
			now,
		);
		expect(rows.map((r) => (r.kind === "day" ? r.label : "·"))).toEqual([
			"·",
			"·",
			"어제",
			"·",
			"·",
			"11월 8일",
			"·",
		]);
	});

	test("a list that starts yesterday opens with 어제", () => {
		expect(incidentRows([inc(at(2026, 10, 10, 22))], now)[0]).toEqual({
			kind: "day",
			label: "어제",
		});
	});
});
