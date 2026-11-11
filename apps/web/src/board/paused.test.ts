// Decision D2: a paused run (Office's loop ended for the day, tasks left) is not a 결재 — no visit, no
// border, no sound — but it is not buried either: it is listed under HQ 대기, and it knocks once on
// the morning after it paused, when the quiet hours end. Local-time fake clock throughout.
import { describe, expect, test } from "bun:test";
import { machine, runIn, screen } from "./fixtures.ts";
import { toVillageModel } from "./model.ts";
import { morningDue } from "./sound.ts";

/** Local time on 11–13 Nov 2026 (the screen's own clock). */
const at = (day: number, h: number, m = 0, s = 0) =>
	new Date(2026, 10, day, h, m, s).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

const paused = (sinceMs: number, over = {}) =>
	runIn("paused", {
		status: "READY",
		reason: "DISPATCH_STOPPED",
		phase: "Implementation",
		last_progress_at: iso(sinceMs),
		reported_at: iso(sinceMs),
		...over,
	});

/** Reports keep coming every tick (the run itself does not change). */
const input = (
	runs: ReturnType<typeof paused>[],
	now: number,
	cockpit = "online" as const,
) => ({
	runs: runs.map((r) => ({ ...r, reported_at: iso(now - 5_000) })),
	machines: [{ ...machine(cockpit), heartbeat_at: iso(now - 5_000) }],
	districts: {},
	eventsByRun: new Map(),
});

describe("D2 · a paused run on the board", () => {
	test("not a visit, no border, not 결재; listed under HQ 대기 with its own quiet list; its building is dark", () => {
		const now = at(11, 15);
		const r = paused(at(11, 14));
		expect(r.needs_owner).toBe(false);
		const m = toVillageModel({ ...input([r], now), now, conn: "open" });
		expect(m.visits).toEqual([]);
		expect(m.status.border).toBe("none");
		expect(m.status.sentence).toBe("전부 정상");
		expect(m.marks.waiting).toEqual([]);
		expect(m.paused).toEqual([
			{
				key: "cockpit:demo-flow-1",
				project_id: "acme/widgets",
				since: iso(at(11, 14)),
			},
		]);
		expect(m.village.shown[0]?.monitors).toEqual([]);
		expect(m.village.shown[0]?.waiting).toBe(0);
		expect(m.now).toEqual([]);
		// one fact, one place: not repeated in 자리 비운 사이
		expect(m.incidents).toEqual([]);
	});
});

describe("D2 · the morning knock (quiet hours end, once per run per day)", () => {
	/** Tick every `stepS` seconds from `from` to `to`, collecting the cues with their times. */
	const run = (
		s: ReturnType<typeof screen>,
		runs: ReturnType<typeof paused>[],
		from: number,
		to: number,
		stepS = 1,
		cockpit: "online" | "offline" = "online",
	) => {
		const cues: [string, string][] = [];
		for (let t = from; t <= to; t += stepS * 1000) {
			for (const c of s.step(t, input(runs, t, cockpit as "online")).cues)
				cues.push([new Date(t).toTimeString().slice(0, 8), c]);
		}
		return cues;
	};

	test("paused in the evening: no sound that evening or overnight; one knock just after 08:00; not again that day", () => {
		const s = screen();
		const r = [paused(at(11, 19))];
		expect(run(s, r, at(11, 20), at(11, 23, 30), 60)).toEqual([]);
		expect(run(s, r, at(11, 23, 30), at(12, 7, 59, 55), 60)).toEqual([]);
		const morning = run(s, r, at(12, 7, 59, 55), at(12, 8, 1));
		expect(morning).toHaveLength(1);
		expect(morning[0]?.[1]).toBe("knock");
		// within the snapshot settle (5 s) after the quiet hours end, never on the minute itself
		expect(morning[0]?.[0] >= "08:00:00" && morning[0]?.[0] <= "08:00:06").toBe(
			true,
		);
		expect(run(s, r, at(12, 8, 1), at(12, 22), 60)).toEqual([]);
		// and the next morning once more (once per day while it stays paused)
		expect(run(s, r, at(12, 22), at(13, 8, 1), 5).map((c) => c[1])).toEqual([
			"knock",
		]);
	});

	test("a reload after 08:00 does not knock a second time that day", () => {
		const r = [paused(at(11, 19))];
		const first = screen();
		run(first, r, at(12, 7, 59), at(12, 8, 1));
		const reloaded = screen();
		expect(run(reloaded, r, at(12, 8, 30), at(12, 12), 10)).toEqual([]);
	});

	test("cockpit offline at 08:00: no knock, and none made up when it comes back", () => {
		const s = screen();
		const r = [paused(at(11, 19))];
		run(s, r, at(12, 7, 50), at(12, 7, 59, 59), 10);
		expect(run(s, r, at(12, 7, 59, 59), at(12, 8, 40), 5, "offline")).toEqual(
			[],
		);
		expect(run(s, r, at(12, 8, 40), at(12, 12), 5)).toEqual([]);
	});

	test("paused after midnight (01:00): knocks at the end of that night's quiet hours", () => {
		const s = screen();
		const r = [paused(at(12, 1))];
		run(s, r, at(12, 1), at(12, 7, 59, 50), 60);
		expect(run(s, r, at(12, 7, 59, 50), at(12, 8, 1)).map((c) => c[1])).toEqual(
			["knock"],
		);
	});

	test("paused during the day (10:00): no knock that day, one the next morning", () => {
		const s = screen();
		const r = [paused(at(12, 10))];
		expect(run(s, r, at(12, 10), at(12, 23), 60)).toEqual([]);
		expect(run(s, r, at(12, 23), at(13, 8, 1), 5).map((c) => c[1])).toEqual([
			"knock",
		]);
	});

	test("?quiet=off: the morning is still 08:00; it knocks on the first tick at 08:00", () => {
		const s = screen("?quiet=off");
		const r = [paused(at(11, 19))];
		run(s, r, at(12, 7, 59, 50), at(12, 7, 59, 59));
		const c = run(s, r, at(12, 8), at(12, 8, 1));
		expect(c).toEqual([["08:00:00", "knock"]]);
	});

	test("?quiet=22-7: the morning is 07:00", () => {
		const s = screen("?quiet=22-7");
		const r = [paused(at(11, 19))];
		run(s, r, at(12, 6, 59, 50), at(12, 6, 59, 59));
		expect(run(s, r, at(12, 7), at(12, 7, 1)).map((c) => c[1])).toEqual([
			"knock",
		]);
	});

	test("two paused runs: one knock for both", () => {
		const s = screen();
		const r = [
			paused(at(11, 19)),
			paused(at(11, 20), {
				run_id: "b-1",
				workflow_id: "b",
				project: "acme/gears",
			}),
		];
		run(s, r, at(12, 7, 59, 50), at(12, 7, 59, 59));
		expect(run(s, r, at(12, 8), at(12, 8, 1)).map((c) => c[1])).toEqual([
			"knock",
		]);
	});

	test("morningDue: owed only after today's end hour, only to runs paused before it", () => {
		const p = [
			{ key: "a", since: iso(at(11, 19)) },
			{ key: "b", since: iso(at(12, 9)) },
		];
		expect(morningDue(p, at(12, 7, 59), 8).keys).toEqual([]);
		expect(morningDue(p, at(12, 8), 8).keys).toEqual(["a"]);
		expect(morningDue(p, at(12, 12), 8).keys).toEqual(["a"]);
		expect(morningDue(p, at(13, 8), 8).keys).toEqual(["a", "b"]);
	});
});
