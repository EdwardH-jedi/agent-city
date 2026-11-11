import { describe, expect, test } from "bun:test";
import { ev, iso, runIn, T0 } from "./fixtures.ts";
import { buildIncidents, INCIDENT_LIMIT } from "./incidents.ts";
import { currentRuns, runKey } from "./types.ts";

describe("자리 비운 사이", () => {
	test("newest first, at most 8, only lines the phrase table backs", () => {
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
		expect(out).toHaveLength(INCIDENT_LIMIT);
		const times = out.map((i) => Date.parse(i.at));
		expect([...times].sort((a, b) => b - a)).toEqual(times);
	});

	test("승인 대기 → 실행 → 완료 show up in order", () => {
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
		expect(out.map((i) => i.text)).toEqual([
			"전부 끝났습니다.",
			"T1 통과했습니다.",
		]);
	});

	test("a run waiting for the owner has no line: its HQ 대기 card says it (said once)", () => {
		for (const state of ["waiting_owner", "hold", "needs_reconcile"] as const) {
			expect(
				buildIncidents(
					currentRuns([runIn(state, { reason: "AWAITING_PLAN_APPROVAL" })]),
					new Map(),
				),
			).toEqual([]);
		}
	});

	test("no line repeats the tail of another: only the first sentence of a report", () => {
		const r = runIn("running");
		const out = buildIncidents(
			currentRuns([r]),
			new Map([
				[
					runKey(r),
					[1, 2, 3].map((n) =>
						ev({
							sequence: n,
							task_id: `T${n}`,
							occurred_at: iso(-n * 60_000),
						}),
					),
				],
			]),
		);
		expect(out.map((i) => i.text)).toEqual([
			"T1 통과했습니다.",
			"T2 통과했습니다.",
			"T3 통과했습니다.",
		]);
	});

	test("a state the table does not know says 확인이 필요합니다 with its code", () => {
		const out = buildIncidents(
			currentRuns([
				runIn("unknown", {
					status: "READY",
					reason: "DISPATCH_STOPPED",
					display: "snapshot_stale",
				}),
			]),
			new Map(),
		);
		expect(out[0]).toMatchObject({
			text: "확인이 필요합니다",
			code: "DISPATCH_STOPPED",
		});
	});

	test("a running run has no line (it is in 지금 진행)", () => {
		expect(buildIncidents(currentRuns([runIn("running")]), new Map())).toEqual(
			[],
		);
	});

	test("partial keeps its code and does not invent a sentence for it", () => {
		const out = buildIncidents(
			currentRuns([runIn("partial", { reason: "PRESERVED_ON_HOLD" })]),
			new Map(),
		);
		expect(out[0]).toMatchObject({
			text: "일부만 끝내고 닫았습니다.",
			code: "PRESERVED_ON_HOLD",
		});
	});

	test("the clock is not used: the same input gives the same lines", () => {
		const cur = currentRuns([runIn("passed")]);
		expect(buildIncidents(cur, new Map())).toEqual(
			buildIncidents(cur, new Map()),
		);
		expect(T0).toBeGreaterThan(0);
	});
});
