// Lead visits (pure): stable ids, no restart on repeated models, the walk back on disappearance,
// reduced motion, remount resumes, the still clock, poses, scene key, and the model mapping.
import { describe, expect, test } from "bun:test";
import {
	T0 as BT0,
	iso as boardIso,
	ev,
	machine,
	runIn,
} from "../board/fixtures.ts";
import { toVillageModel } from "../board/model.ts";
import { figurePose, sceneKey, walkMsFor } from "./choreography.ts";
import { campusLayout, lobbySpot, officeSeat, slotOf } from "./layout.ts";
import {
	type CampusModel,
	type CampusVisitor,
	toCampusModel,
} from "./presentation.ts";
import {
	EMPTY_BOOK,
	MAX_HEAD_START_MS,
	MAX_WALK_MS,
	MIN_WALK_MS,
	reconcileVisits,
	START_CLOCK,
	sceneNow,
	setStill,
	settleVisits,
	visitDone,
	visitProgress,
	walkDurationMs,
} from "./visits.ts";

const T0 = Date.parse("2026-10-03T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const layout = campusLayout(["acme/alpha", "acme/beta"]);
const walk = (v: { repo_id: string; seat: number }) => walkMsFor(layout, v);

function visitor(n: number, over: Partial<CampusVisitor> = {}): CampusVisitor {
	return {
		visit_id: `cockpit:run-${n}`,
		kind: "sign",
		carry: n % 2 === 0 ? "binder" : "folder",
		repo_id: "acme/alpha",
		created_at: iso(T0),
		...over,
	};
}

describe("visit scheduler", () => {
	test("one visit per visitor, seats in created_at order", () => {
		const b = reconcileVisits(
			EMPTY_BOOK,
			[visitor(2, { created_at: iso(T0 + 5) }), visitor(1)],
			T0,
			walk,
		);
		expect(b.visits.map((v) => [v.visit_id, v.seat])).toEqual([
			["cockpit:run-1", 0],
			["cockpit:run-2", 1],
		]);
	});

	test("asking again with the same ids returns the same book (no restart of the walk)", () => {
		const b1 = reconcileVisits(EMPTY_BOOK, [visitor(1)], T0, walk);
		const b2 = reconcileVisits(b1, [visitor(1)], T0 + 5_000, walk);
		expect(b2).toBe(b1);
	});

	test("a visitor that leaves the list walks back from where it stands, then is gone", () => {
		const b1 = reconcileVisits(EMPTY_BOOK, [visitor(1)], T0, walk);
		const v = b1.visits[0];
		if (!v) throw new Error("no visit");
		const ms = walk(v);
		// half way there when it is resolved
		const half = T0 + ms / 2;
		const b2 = reconcileVisits(b1, [], half, walk);
		const back = b2.visits[0];
		if (!back) throw new Error("dropped at once");
		expect(back.left_at).toBe(half);
		expect(back.left_from).toBeCloseTo(0.5, 5);
		expect(visitProgress(back, half + ms / 4, ms, false)).toBeCloseTo(0.25, 5);
		expect(visitDone(back, half + ms / 4, ms, false)).toBe(false);
		// the same empty list again keeps the walk going (no second turn)
		expect(reconcileVisits(b2, [], half + 10, walk)).toBe(b2);
		expect(settleVisits(b2, half + ms / 4, walk)).toBe(b2);
		expect(settleVisits(b2, half + ms / 2 + 1, walk).visits).toEqual([]);
	});

	test("a report: walks in, stays, and walks all the way back after it ends", () => {
		const r = visitor(3, { kind: "report", carry: null, created_at: iso(T0) });
		const b1 = reconcileVisits(EMPTY_BOOK, [r], T0, walk);
		const v = b1.visits[0];
		if (!v) throw new Error("no visit");
		const ms = walk(v);
		expect(visitProgress(v, T0 + ms + 60_000, ms, false)).toBe(1); // stays at the HQ
		const end = T0 + 5 * 60_000;
		const b2 = reconcileVisits(b1, [], end, walk);
		expect(b2.visits[0]?.left_from).toBe(1);
		const pose = figurePose(layout, b2.visits[0] ?? v, end + ms / 2, false);
		expect(pose.returning).toBe(true);
		expect(pose.posture).toBe("walk");
		expect(settleVisits(b2, end + ms + 1, walk).visits).toEqual([]);
	});

	test("coming back while walking home resumes from where it is, toward the HQ", () => {
		const b1 = reconcileVisits(EMPTY_BOOK, [visitor(1)], T0, walk);
		const ms = walk(b1.visits[0] ?? { repo_id: "acme/alpha", seat: 0 });
		const b2 = reconcileVisits(b1, [], T0 + ms, walk); // arrived, then left
		const b3 = reconcileVisits(b2, [visitor(1)], T0 + ms + ms / 4, walk);
		const v = b3.visits[0];
		if (!v) throw new Error("gone");
		expect(v.left_at).toBeNull();
		expect(visitProgress(v, T0 + ms + ms / 4, ms, false)).toBeCloseTo(0.75, 5);
	});

	test("progress is anchored to created_at: an old visit is already arrived, skew is clamped", () => {
		const old = reconcileVisits(
			EMPTY_BOOK,
			[visitor(1, { created_at: iso(T0 - 3_600_000) })],
			T0,
			walk,
		).visits[0];
		expect(old?.head_start_ms).toBe(MAX_HEAD_START_MS);
		const future = reconcileVisits(
			EMPTY_BOOK,
			[visitor(1, { created_at: iso(T0 + 3_600_000) })],
			T0,
			walk,
		).visits[0];
		expect(future?.head_start_ms).toBe(0);
	});

	test("reduced motion: arrival and return are immediate", () => {
		const b1 = reconcileVisits(EMPTY_BOOK, [visitor(1)], T0, walk, true);
		const v = b1.visits[0];
		if (!v) throw new Error("no visit");
		expect(visitProgress(v, T0, walk(v), true)).toBe(1);
		const b2 = reconcileVisits(b1, [], T0 + 1, walk, true);
		expect(settleVisits(b2, T0 + 1, walk, true).visits).toEqual([]);
	});

	test("walk duration is bounded", () => {
		expect(walkDurationMs(0)).toBe(MIN_WALK_MS);
		expect(walkDurationMs(1e6)).toBe(MAX_WALK_MS);
	});
});

describe("the still clock (reports stopped: every figure stops where it is)", () => {
	test("time stands while still and resumes without a jump", () => {
		let c = START_CLOCK;
		expect(sceneNow(c, 1_000)).toBe(1_000);
		c = setStill(c, true, 1_000);
		expect(sceneNow(c, 61_000)).toBe(1_000);
		expect(setStill(c, true, 5_000)).toBe(c);
		c = setStill(c, false, 61_000);
		expect(sceneNow(c, 61_000)).toBe(1_000);
		expect(sceneNow(c, 62_000)).toBe(2_000);
	});

	test("a walking lead does not move while the clock stands", () => {
		const b = reconcileVisits(EMPTY_BOOK, [visitor(1)], T0, walk);
		const v = b.visits[0];
		if (!v) throw new Error("no visit");
		let c = setStill(START_CLOCK, true, T0 + 2_000);
		const a = figurePose(layout, v, sceneNow(c, T0 + 2_000), false);
		const later = figurePose(layout, v, sceneNow(c, T0 + 600_000), false);
		expect([later.x, later.z]).toEqual([a.x, a.z]);
		c = setStill(c, false, T0 + 600_000);
		expect(figurePose(layout, v, sceneNow(c, T0 + 600_000), false).x).toBe(a.x);
	});
});

describe("figure poses", () => {
	test("walking starts at the lead's office chair and ends at a stable lobby seat", () => {
		const b = reconcileVisits(EMPTY_BOOK, [visitor(1)], T0, walk);
		const v = b.visits[0];
		if (!v) throw new Error("no visit");
		const slot = slotOf(layout, "acme/alpha");
		if (!slot) throw new Error("no slot");
		const [ox, oz] = officeSeat(slot);
		const start = figurePose(layout, v, T0, false);
		expect([start.x, start.z]).toEqual([ox, oz]);
		const end = figurePose(layout, v, T0 + MAX_WALK_MS + 5_000, false);
		const spot = lobbySpot(0);
		expect([end.x, end.z, end.posture]).toEqual([spot.x, spot.z, "sit"]);
	});

	test("a lead from a building that is not standing still reaches the HQ", () => {
		const b = reconcileVisits(
			EMPTY_BOOK,
			[visitor(1, { repo_id: "~acme/folded" })],
			T0,
			walk,
		);
		const v = b.visits[0];
		if (!v) throw new Error("no visit");
		const end = figurePose(layout, v, T0 + MAX_WALK_MS + 5_000, false);
		expect([end.x, end.z]).toEqual([lobbySpot(0).x, lobbySpot(0).z]);
	});
});

describe("scene model", () => {
	const village = (over = {}) =>
		toVillageModel({
			runs: [
				runIn("waiting_owner", {
					project: "acme/alpha",
					workflow_id: "a",
					run_id: "a-1",
					reason: "AWAITING_PLAN_APPROVAL",
				}),
				runIn("hold", {
					project: "acme/beta",
					workflow_id: "b",
					run_id: "b-1",
					reason: "MODEL_CHAIN_EXHAUSTED",
				}),
				runIn("running", {
					project: "acme/gamma",
					workflow_id: "c",
					run_id: "c-1",
				}),
			],
			machines: [machine("online")],
			districts: {},
			eventsByRun: new Map([
				[
					"cockpit:c-1",
					[ev({ task_id: "T1", occurred_at: boardIso(-20_000) })],
				],
			]),
			now: BT0,
			conn: "open",
			...over,
		});

	test("VillageModel → scene: folder / binder / report, flags, owner, one door bubble", () => {
		const m: CampusModel = toCampusModel(village());
		expect(m.visitors.map((v) => [v.repo_id, v.kind, v.carry])).toEqual([
			["acme/alpha", "sign", "folder"],
			["acme/beta", "sign", "binder"],
			["acme/gamma", "report", null],
		]);
		const beta = m.repos.find((r) => r.repo_id === "acme/beta");
		expect(beta).toMatchObject({ has_stopped: true, pending_requests: 1 });
		expect(m.repos.find((r) => r.repo_id === "acme/gamma")?.monitors).toEqual([
			"code",
		]);
		expect(m.owner_present).toBe(true);
		expect(m.still).toBe(false);
		expect(m.door).toEqual({
			label: "gamma",
			text: "T1 통과했습니다. 다음으로 넘어갑니다.",
		});
	});

	test("cockpit offline: owner chair empty and the scene is still", () => {
		const m = toCampusModel(village({ machines: [machine("offline")] }));
		expect(m.owner_present).toBe(false);
		expect(m.still).toBe(true);
	});

	test("the scene key ignores clock-only churn and follows what is drawn", () => {
		const a = toCampusModel(village());
		const b = toCampusModel(village({ now: BT0 + 1_000 }));
		expect(sceneKey(a, false)).toBe(sceneKey(b, false));
		const c = toCampusModel(village({ machines: [machine("offline")] }));
		expect(sceneKey(c, false)).not.toBe(sceneKey(a, false));
	});
});
