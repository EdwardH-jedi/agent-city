// Doc 12 §4 mapping rules (pure): sticky project slots, facades fixed by repo id, sign text, lamp colour
// priority, and the pylon's rows / OFFLINE "—" — read back from the leaderboard's own face plan.
import { describe, expect, test } from "bun:test";
import type { CampusModel, CampusRepo } from "../campus/presentation.ts";
import { planFace } from "./engine/leaderboard.mjs";
import { LOTS } from "./engine/ring-layout.mjs";
import { lampState, signTextWidth } from "./engine/scene-ring.mjs";
import {
	AWNINGS,
	assignLots,
	BOARD_TITLE,
	boardLabel,
	boardViewOf,
	buildLots,
	CAFE_LOT,
	FACADE_PAIRS,
	facadeOf,
	HEIGHTS,
	HQ_LOT,
	lampInput,
	lampOf,
	lotsKey,
	PROJECT_SLOTS,
	SIGN_MAX_TX,
	signText,
} from "./lots.ts";

const repo = (
	id: string,
	o: Partial<Omit<CampusRepo, "repo_id">> = {},
): CampusRepo => ({
	repo_id: id,
	label: id.split("/")[1] ?? id,
	active_tasks: 0,
	monitors: [],
	pending_requests: 0,
	has_stopped: false,
	...o,
});
const model = (repos: CampusRepo[], o: Partial<CampusModel> = {}) =>
	({
		repos,
		visitors: [],
		owner_present: true,
		still: false,
		door: null,
		...o,
	}) satisfies CampusModel;

describe("project slots", () => {
	test("eight slots clockwise after HQ; HQ and the cafe are never project slots", () => {
		expect(PROJECT_SLOTS).toEqual([
			"lot-9",
			"lot-10",
			"engineering",
			"research",
			"operations",
			"qa",
			"design",
			"planning",
		]);
		expect(PROJECT_SLOTS).not.toContain(HQ_LOT);
		expect(PROJECT_SLOTS).not.toContain(CAFE_LOT);
	});

	test("first fill follows the given order", () => {
		const a = assignLots(new Map(), ["o/a", "o/b", "o/c"]);
		expect([...a]).toEqual([
			["o/a", "lot-9"],
			["o/b", "lot-10"],
			["o/c", "engineering"],
		]);
	});

	test("sticky: reorder keeps every slot; a removed project frees its slot; a new one takes the first free", () => {
		const a = assignLots(new Map(), ["o/a", "o/b", "o/c", "o/d"]);
		const reordered = assignLots(a, ["o/d", "o/c", "o/b", "o/a"]);
		for (const id of ["o/a", "o/b", "o/c", "o/d"])
			expect(reordered.get(id)).toBe(a.get(id));
		const removed = assignLots(reordered, ["o/a", "o/c", "o/d"]);
		expect(removed.has("o/b")).toBe(false);
		expect(removed.get("o/c")).toBe(a.get("o/c"));
		const added = assignLots(removed, ["o/e", "o/a", "o/c", "o/d"]);
		expect(added.get("o/e")).toBe(a.get("o/b")); // the freed slot is the first free one
		expect(added.get("o/a")).toBe("lot-9");
		// back again: the old project does not get its old slot back if it was taken
		const back = assignLots(added, ["o/a", "o/b", "o/c", "o/d", "o/e"]);
		expect(back.get("o/e")).toBe("lot-10");
		expect(back.get("o/b")).toBe("operations"); // d keeps research; b takes the first free
	});

	test("never more than eight, never two projects in one slot, duplicates ignored", () => {
		const ids = Array.from({ length: 11 }, (_, i) => `o/p${i}`);
		const a = assignLots(new Map(), [...ids, "o/p0"]);
		expect(a.size).toBe(8);
		expect(new Set(a.values()).size).toBe(8);
		const stale = new Map([
			["o/x", "sportsgang"],
			["o/y", "lot-9"],
		]);
		const b = assignLots(stale, ["o/x", "o/y"]);
		expect(b.get("o/y")).toBe("lot-9");
		expect(b.get("o/x")).toBe("lot-10"); // HQ is not a project slot
	});
});

describe("lots", () => {
	test("HQ is the lobby lot signed HQ; the cafe is unchanged; empty slots boarded COMING SOON; positions unchanged", () => {
		const repos = [repo("o/alpha", { active_tasks: 7 }), repo("o/beta")];
		const lots = buildLots(
			assignLots(
				new Map(),
				repos.map((r) => r.repo_id),
			),
			repos,
		);
		expect(lots.map((l) => l.id)).toEqual(LOTS.map((l) => l.id));
		lots.forEach((l, i) => {
			expect(l.deg).toBe(LOTS[i]?.deg ?? Number.NaN);
			expect(l.doorX).toBe(LOTS[i]?.doorX ?? Number.NaN);
		});
		const by = new Map(lots.map((l) => [l.id, l]));
		expect(by.get(HQ_LOT)?.sign).toBe("HQ");
		expect(by.get(HQ_LOT)?.family).toBe("glass");
		expect(by.get(CAFE_LOT)).toBe(LOTS.find((l) => l.id === CAFE_LOT));
		expect(by.get("lot-9")).toMatchObject({
			sign: "ALPHA",
			boarded: false,
			litWindows: 4, // capped
			lit: 0,
			repo_id: "o/alpha",
		});
		expect(by.get("lot-10")?.litWindows).toBe(0);
		for (const id of PROJECT_SLOTS.slice(2))
			expect(by.get(id)).toMatchObject({
				sign: "COMING SOON",
				boarded: true,
				litWindows: 0,
			});
	});

	test("lotsKey ignores lit windows (repainted in place) but not signs or facades", () => {
		const a = [repo("o/alpha", { active_tasks: 1 })];
		const b = [repo("o/alpha", { active_tasks: 3 })];
		const asg = assignLots(new Map(), ["o/alpha"]);
		expect(lotsKey(buildLots(asg, a))).toBe(lotsKey(buildLots(asg, b)));
		const c = [repo("o/alpha", { label: "alpha2" })];
		expect(lotsKey(buildLots(asg, c))).not.toBe(lotsKey(buildLots(asg, a)));
	});
});

describe("facade by repo id", () => {
	test("stable for an id, from the original value sets, and varied across ids", () => {
		const f = facadeOf("owner/some-repo");
		expect(facadeOf("owner/some-repo")).toEqual(f);
		const ids = Array.from({ length: 60 }, (_, i) => `owner/repo-${i}`);
		const all = ids.map(facadeOf);
		for (const x of all) {
			expect(
				FACADE_PAIRS.some((p) => p.family === x.family && p.wall === x.wall),
			).toBe(true);
			expect(AWNINGS as readonly string[]).toContain(x.awning);
			expect(HEIGHTS as readonly number[]).toContain(x.h);
			expect(Number.isInteger(x.seed)).toBe(true);
		}
		expect(new Set(all.map((x) => x.wall)).size).toBeGreaterThanOrEqual(5);
		expect(new Set(all.map((x) => x.h)).size).toBe(3);
	});
});

describe("sign text", () => {
	test("upper case; digits and '-' drawn; separators become spaces", () => {
		expect(signText("orchard")).toBe("ORCHARD");
		expect(signText("agent-city-2")).toBe("AGENT-CITY-2");
		expect(signText("my_repo.v2")).toBe("MY REPO V2");
	});

	test("every A–Z, 0–9 and '-' has a sign glyph; anything else is dropped", () => {
		for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-")
			expect(() => signTextWidth(ch, 2)).not.toThrow();
		expect(signText("café!")).toBe("CAF");
		expect(signText("한글")).toBe("-");
	});

	test("cut to fit the frontage", () => {
		const s = signText("a-very-long-project-name-that-goes-on");
		expect(signTextWidth(s, 2)).toBeLessThanOrEqual(SIGN_MAX_TX);
		expect("A-VERY-LONG-PROJECT-NAME-THAT-GOES-ON".startsWith(s)).toBe(true);
		expect(s.length).toBeGreaterThan(10);
	});

	test("the pylon's label: 6 characters of the leaderboard font", () => {
		expect(boardLabel("orchard")).toBe("ORCHAR");
		expect(boardLabel("app-2")).toBe("APP-2");
	});
});

describe("lamps", () => {
	test("priority: stopped red > waiting yellow > working green > off", () => {
		const all = { has_stopped: true, pending_requests: 2, active_tasks: 3 };
		expect(lampOf(repo("o/a", all))).toBe("stopped");
		expect(lampOf(repo("o/a", { ...all, has_stopped: false }))).toBe("waiting");
		expect(lampOf(repo("o/a", { active_tasks: 1 }))).toBe("working");
		expect(lampOf(repo("o/a"))).toBe("off");
	});

	test("HQ lit while the owner is there; cafe and empty slots off; still → the original offline look", () => {
		const repos = [repo("o/a", { pending_requests: 1 })];
		const asg = assignLots(new Map(), ["o/a"]);
		const lamp = (m: CampusModel) =>
			new Map(lampInput(m, asg).rows.map((r) => [r.lot, r.lamp]));
		const on = lamp(model(repos));
		expect(on.get(HQ_LOT)).toBe("working");
		expect(on.get("lot-9")).toBe("waiting");
		expect(on.get(CAFE_LOT)).toBe("off");
		expect(on.get("lot-10")).toBe("off");
		expect(lamp(model(repos, { owner_present: false })).get(HQ_LOT)).toBe(
			"off",
		);
		const still = lampInput(model(repos, { still: true }), asg);
		expect(still.offline).toBe(true);
		for (const r of still.rows)
			expect(lampState(r, still.offline)).toBe("offline");
		// what scene-ring does with the explicit states
		expect(lampState({ lamp: "stopped" }, false)).toBe("stopped");
	});
});

describe("the pylon", () => {
	const repos = [
		repo("o/alpha", { active_tasks: 2, pending_requests: 1 }),
		repo("o/beta", { active_tasks: 1 }),
		repo("o/gamma", { has_stopped: true, pending_requests: 1 }),
	];
	const asg = assignLots(
		new Map(),
		repos.map((r) => r.repo_id),
	);

	test("AGENT CITY; one row per project lot (slot order, facing its lot); ALL = totals", () => {
		const v = boardViewOf(model(repos), asg);
		expect(v.title).toBe(BOARD_TITLE);
		expect(v.offline).toBe(false);
		expect(v.rows.map((r) => [r.lot, r.label, r.working, r.waiting])).toEqual([
			["lot-9", "ALPHA", 2, 1],
			["lot-10", "BETA", 1, 0],
			["engineering", "GAMMA", 0, 1],
		]);
		expect(v.rows.map((r) => r.deg)).toEqual([288, 324, 0]);
		expect(v.totals).toEqual({ working: 3, waiting: 2, idle: 0, unknown: 0 });
		const texts = [0, 1, 2].flatMap((k) => planFace(v, k).texts);
		expect(texts.filter((t) => t.field === "title").map((t) => t.s)).toContain(
			"CITY",
		);
		expect(
			texts
				.filter((t) => t.lot === "*" && t.field === "working")
				.map((t) => t.s),
		).toEqual(["03", "03", "03"]);
	});

	test("still: OFFLINE band and '—' everywhere, never 0", () => {
		const v = boardViewOf(model(repos, { still: true }), asg);
		expect(v.offline).toBe(true);
		expect(v.totals).toEqual({
			working: null,
			waiting: null,
			idle: null,
			unknown: null,
		});
		for (const k of [0, 1, 2]) {
			const plan = planFace(v, k);
			expect(plan.texts.some((t) => t.field === "offline")).toBe(true);
			const counters = plan.texts.filter((t) =>
				["working", "waiting", "idle"].includes(String(t.field)),
			);
			expect(counters.length).toBeGreaterThan(0);
			for (const t of counters) expect(t.s).toBe("—");
		}
	});

	test("no projects: no rows, ALL zero", () => {
		const v = boardViewOf(model([]), new Map());
		expect(v.rows).toEqual([]);
		expect(v.totals).toEqual({ working: 0, waiting: 0, idle: 0, unknown: 0 });
	});
});
