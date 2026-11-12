// The town's crew (16 A1): who is drawn where, the caps, and when each took its place.
import { describe, expect, test } from "bun:test";
import { type Session, STALE_AFTER_MS } from "@agent-city/schema";
import { SUBAGENT_TOOLS } from "@agent-city/schema/core";
import type { VillageModel } from "../board/model.ts";
import { sessionPanel } from "../board/session-panel.ts";
import { shortModel, type TailEvent } from "../board/tail.ts";
import {
	COMPANIONS_MAX,
	COMPANIONS_PER,
	CREW_AT_CAFE,
	CREW_MAX,
	CREW_PER_BUILDING,
	familyOf,
	tagOf,
	townCrew,
} from "./crew.ts";

const NOW = Date.UTC(2026, 10, 13, 2, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

let n = 0;
const sess = (
	repo: string | null,
	status: Session["status"],
	agoMs: number,
	over: Partial<Session> = {},
): Session => ({
	id: `claude:c${n++}`,
	provider: "claude",
	machine_id: "cockpit",
	repo_id: repo,
	cwd: "/tmp/x",
	branch: "main",
	model: "claude-opus-5-5",
	status,
	started_at: ago(agoMs + HOUR),
	last_event_at: ago(agoMs),
	ended_at: null,
	rev: 1,
	...over,
});

type CrewModel = Pick<VillageModel, "waitingSessions" | "village">;
const villageOf = (ids: string[]): CrewModel["village"] => ({
	shown: ids.map((id) => ({ id }) as VillageModel["village"]["shown"][number]),
	folded: 0,
});
const MODEL: CrewModel = {
	waitingSessions: [],
	village: villageOf(["o/a", "o/b", "o/c", "o/d", "o/e", "o/f", "o/g", "o/h"]),
};
const crew = (
	sessions: Session[],
	over: { events?: TailEvent[]; model?: CrewModel; now?: number } = {},
) =>
	townCrew({
		sessions,
		events: over.events ?? [],
		model: over.model ?? MODEL,
		now: over.now ?? NOW,
	});

describe("who stands where (16 A1 table)", () => {
	test("active → in front of its building; the walk anchor is its last event", () => {
		const s = sess("o/a", "active", 5_000);
		expect(crew([s])).toEqual([
			{
				id: s.id,
				repo_id: "o/a",
				place: "work",
				since: s.last_event_at,
				started_at: s.started_at,
				provider: "claude",
				family: "opus",
				tag: "OPUS",
				companions: 0,
			},
		]);
	});

	test("waiting, its HQ visit not over (and in its first 60 s): at its building's door", () => {
		const fresh = sess("o/a", "waiting", 10_000);
		const visiting = sess("o/b", "waiting", 10 * MIN);
		const c = crew([fresh, visiting]);
		expect(c.map((x) => [x.id, x.place, x.repo_id])).toEqual([
			[fresh.id, "door", "o/a"],
			[visiting.id, "door", "o/b"],
		]);
	});

	test("a wait whose HQ visit is over: at the cafe, since its wait start + the session wait", () => {
		const s = sess("o/a", "waiting", 50 * MIN);
		const m: CrewModel = {
			...MODEL,
			waitingSessions: [
				{
					id: `session:${s.id}`,
					project_id: "o/a",
					provider_label: "Claude",
					since: s.last_event_at,
				},
			],
		};
		const [c] = crew([s], { model: m });
		expect(c?.place).toBe("cafe");
		expect(c?.since).toBe(ago(20 * MIN)); // 50 min ago + 30 min
		// it keeps its building, so a reload mid-walk starts it from there
		expect(c?.repo_id).toBe("o/a");
	});

	test("a wait older than 7 days (no visit, in no list): at the cafe, settled", () => {
		const s = sess("o/a", "waiting", 8 * 24 * HOUR);
		const [c] = crew([s]);
		expect(c?.place).toBe("cafe");
		expect(Date.parse(c?.since ?? "")).toBeLessThan(NOW - 7 * 24 * HOUR);
	});

	test("idle → cafe at its last event; stale (hub or this clock) → cafe at last event + 15 min", () => {
		const idle = sess("o/a", "idle", 5 * MIN);
		const staleByClock = sess("o/a", "active", 20 * MIN);
		const staleHub = sess("o/b", "stale", 2 * HOUR);
		const c = crew([idle, staleByClock, staleHub]);
		const byId = new Map(c.map((x) => [x.id, x]));
		expect(byId.get(idle.id)?.place).toBe("cafe");
		expect(byId.get(idle.id)?.since).toBe(idle.last_event_at);
		expect(byId.get(staleByClock.id)?.place).toBe("cafe");
		expect(byId.get(staleByClock.id)?.since).toBe(
			new Date(NOW - 20 * MIN + STALE_AFTER_MS).toISOString(),
		);
		expect(byId.get(staleHub.id)?.since).toBe(
			new Date(NOW - 2 * HOUR + STALE_AFTER_MS).toISOString(),
		);
	});

	test("ended, and resting past 6 h: not drawn", () => {
		expect(
			crew([
				sess("o/a", "ended", 1_000),
				sess("o/a", "idle", 7 * HOUR),
				sess("o/a", "stale", 6 * HOUR + 1),
			]),
		).toEqual([]);
	});

	test("no building in the town (no repo, or folded out): working / waiting not drawn, resting at the cafe", () => {
		const c = crew([
			sess(null, "active", 1_000),
			sess("o/zz", "waiting", 1_000),
			sess(null, "idle", 1_000),
			sess("o/zz", "idle", 2_000),
		]);
		expect(c.map((x) => [x.place, x.repo_id])).toEqual([
			["cafe", null],
			["cafe", null],
		]);
	});

	test("the same sessions as the SESSIONS panel, before its height folding", () => {
		const list = [
			sess("o/a", "active", 1_000),
			sess("o/a", "waiting", 2_000),
			sess("o/b", "idle", 3 * HOUR),
			sess("o/b", "ended", 1_000),
			sess("o/c", "idle", 9 * HOUR),
			sess("o/c", "stale", 40 * MIN),
		];
		const panel = sessionPanel({
			sessions: list,
			tails: new Map(),
			model: { visits: [], now: [], paused: [], waitingSessions: [] },
			now: NOW,
			budget: Number.POSITIVE_INFINITY,
			ui: 1,
			tailMax: 3,
			shortModel,
		});
		const rows = panel.groups.flatMap((g) => g.rows.map((r) => r.id)).sort();
		expect(
			crew(list)
				.map((c) => c.id)
				.sort(),
		).toEqual(rows);
	});
});

describe("looks and tags", () => {
	test("family from the model; Codex by provider; tags in capitals", () => {
		expect(familyOf("claude", "claude-opus-5-5")).toBe("opus");
		expect(familyOf("claude", "claude-sonnet-4-20250514")).toBe("sonnet");
		expect(familyOf("claude", "claude-fable-5-2")).toBe("fable");
		expect(familyOf("claude", "claude-haiku-5-5")).toBe("haiku");
		expect(familyOf("claude", "gpt-x")).toBeNull();
		expect(familyOf("claude", null)).toBeNull();
		expect(familyOf("codex", "gpt-6-astra")).toBe("codex");
		expect(tagOf("claude", "fable")).toBe("FABLE");
		expect(tagOf("codex", "codex")).toBe("CODEX");
		expect(tagOf("claude", null)).toBe("CLAUDE");
		expect(tagOf("other", null)).toBeNull();
	});
});

describe("caps", () => {
	test(`at most ${CREW_PER_BUILDING} at a building: waits first, then the newest active`, () => {
		const wait = sess("o/a", "waiting", 30_000);
		const act = [1, 2, 3, 4].map((i) => sess("o/a", "active", i * 1_000));
		const c = crew([...act, wait]);
		expect(c.map((x) => x.id)).toEqual([
			wait.id,
			act[0]?.id,
			act[1]?.id,
		] as string[]);
	});

	test("a working session's new event does not swap who is drawn at its building", () => {
		const act = [1, 2, 3, 4].map((i) =>
			sess("o/a", "active", i * 1_000, { started_at: ago(i * HOUR) }),
		);
		const drawn = (list: Session[]) =>
			crew(list)
				.map((c) => c.id)
				.sort();
		const before = drawn(act);
		// the fourth (the oldest started) gets the newest event
		const bumped = act.map((s, i) =>
			i === 3 ? { ...s, last_event_at: ago(100) } : s,
		);
		expect(drawn(bumped)).toEqual(before);
		expect(before).not.toContain(act[3]?.id);
	});

	test(`at most ${CREW_AT_CAFE} at the cafe, the newest`, () => {
		const rest = Array.from({ length: 9 }, (_, i) =>
			sess("o/a", "idle", (i + 1) * MIN),
		);
		const c = crew(rest);
		expect(c.map((x) => x.id)).toEqual(
			rest.slice(0, CREW_AT_CAFE).map((s) => s.id),
		);
	});

	test(`at most ${CREW_MAX} in all: the oldest resting go first`, () => {
		const ids = ["o/a", "o/b", "o/c", "o/d", "o/e", "o/f"];
		const act = ids.flatMap((r, j) =>
			[1, 2, 3].map((i) => sess(r, "active", (i * 10 + j) * 1_000)),
		);
		const rest = [1, 2, 3].map((i) => sess("o/a", "idle", i * MIN));
		const c = crew([...rest, ...act]);
		expect(c).toHaveLength(CREW_MAX);
		expect(c.filter((x) => x.place === "cafe")).toHaveLength(0);
		// 18 active over the cap of 16: the two oldest active go
		const kept = new Set(c.map((x) => x.id));
		const oldest = [...act]
			.sort((a, b) => a.last_event_at.localeCompare(b.last_event_at))
			.slice(0, 2);
		for (const s of oldest) expect(kept.has(s.id)).toBe(false);
	});

	test(`companions: running subagents of an active one, ${COMPANIONS_PER} each, ${COMPANIONS_MAX} in all`, () => {
		const tool = [...SUBAGENT_TOOLS][0] as string;
		const list = Array.from({ length: 6 }, (_, i) =>
			sess(`o/${"abcdef"[i]}`, "active", (i + 1) * 1_000),
		);
		const events: TailEvent[] = list.flatMap((s, i) =>
			[0, 1, 2].map((k) => ({
				session_id: s.id,
				agent_id: `${s.id}/sub:t${i}${k}`,
				type: "PreToolUse",
				tool,
				summary: null,
				ts: ago(5_000),
			})),
		);
		// a resting session's subagents are not drawn
		const idle = sess("o/g", "idle", 2 * MIN);
		events.push({
			session_id: idle.id,
			agent_id: `${idle.id}/sub:x`,
			type: "PreToolUse",
			tool,
			summary: null,
			ts: ago(3 * MIN),
		});
		const c = crew([...list, idle], { events });
		expect(c.map((x) => x.companions)).toEqual([2, 2, 2, 2, 0, 0, 0]);
	});
});
