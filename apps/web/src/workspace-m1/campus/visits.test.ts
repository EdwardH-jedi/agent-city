// CEO visit scheduler + figure poses (pure). Stable ids, no duplication on repeated models, removal
// on disappearance, reduced motion = already arrived, several requests at once, remount resumes.
import { describe, expect, test } from "bun:test";
import { figurePose, sceneKey, walkMsFor } from "./choreography.ts";
import {
	campusLayout,
	DESK_SPOT,
	lobbySpot,
	officeSeat,
	slotOf,
} from "./layout.ts";
import {
	CAMPUS_INTERFACE_VERSION,
	type CampusModel,
	type CampusPendingRequest,
} from "./presentation.ts";
import {
	EMPTY_BOOK,
	MAX_HEAD_START_MS,
	MAX_WALK_MS,
	MIN_WALK_MS,
	reconcileVisits,
	type VisitBook,
	visitProgress,
	walkDurationMs,
} from "./visits.ts";

const T0 = Date.parse("2026-10-03T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function req(
	n: number,
	over: Partial<CampusPendingRequest> = {},
): CampusPendingRequest {
	return {
		request_id: `wsa-00000000-0000-4000-8000-00000000000${n}`,
		kind: n % 2 === 0 ? "result" : "run",
		gate_label: n % 2 === 0 ? "Result acceptance" : "Execution approval",
		task_id: `wst-00000000-0000-4000-8000-00000000000${n}`,
		repo_id: "local/alpha",
		title: `Task ${n}`,
		created_at: iso(T0),
		selected: false,
		...over,
	};
}

function model(over: Partial<CampusModel> = {}): CampusModel {
	return {
		version: CAMPUS_INTERFACE_VERSION,
		provenance: null,
		connection: { status: "online", last_confirmed_at: iso(T0) },
		view: "projects",
		repos: [
			{
				repo_id: "local/alpha",
				label: "alpha",
				selected: false,
				active_tasks: 1,
				pending_requests: 1,
				has_invalid_acceptance: false,
			},
		],
		tasks: [],
		pending: [req(1)],
		selected: { repo_id: null, task_id: null, request_id: null },
		...over,
	};
}

describe("visit scheduler", () => {
	test("one visit per pending request, seats in created_at order", () => {
		const pending = [
			req(2, { created_at: iso(T0 + 2_000) }),
			req(1, { created_at: iso(T0) }),
			req(3, { created_at: iso(T0 + 1_000) }),
		];
		const book = reconcileVisits(EMPTY_BOOK, pending, T0 + 3_000);
		expect(book.visits.map((v) => [v.request_id.slice(-1), v.seat])).toEqual([
			["1", 0],
			["3", 1],
			["2", 2],
		]);
	});

	test("re-polling with the same ids returns the same book (no restart, no duplicate)", () => {
		const a = reconcileVisits(EMPTY_BOOK, [req(1), req(2)], T0 + 500);
		const same = reconcileVisits(a, [req(1), req(2)], T0 + 2_500);
		expect(same).toBe(a);
		// a fresh model object with cloned requests and other fields changed (title, selection)
		const cloned = [req(2, { title: "renamed", selected: true }), req(1)];
		const again = reconcileVisits(a, structuredClone(cloned), T0 + 9_000);
		expect(again).toBe(a);
		expect(again.visits).toHaveLength(2);
		// a duplicate id in one list still yields one visit
		const dup = reconcileVisits(EMPTY_BOOK, [req(1), req(1)], T0);
		expect(dup.visits).toHaveLength(1);
	});

	test("timing of a kept visit never changes across polls", () => {
		let book: VisitBook = reconcileVisits(EMPTY_BOOK, [req(1)], T0 + 1_000);
		const first = book.visits[0];
		for (let i = 1; i <= 20; i += 1)
			book = reconcileVisits(book, [req(1)], T0 + 1_000 + i * 2_000);
		expect(book.visits[0]).toBe(first);
	});

	test("a request that leaves the pending list ends its visit; others keep seat and timing", () => {
		const a = reconcileVisits(EMPTY_BOOK, [req(1), req(2), req(3)], T0);
		const keep2 = a.visits.find((v) => v.request_id === req(2).request_id);
		const b = reconcileVisits(a, [req(2), req(3)], T0 + 4_000);
		expect(b.visits.map((v) => v.request_id)).toEqual([
			req(2).request_id,
			req(3).request_id,
		]);
		expect(b.visits.find((v) => v.request_id === req(2).request_id)).toBe(
			keep2,
		);
		// the freed seat 0 goes to the next new request
		const c = reconcileVisits(b, [req(2), req(3), req(4)], T0 + 6_000);
		expect(c.visits.find((v) => v.request_id === req(4).request_id)?.seat).toBe(
			0,
		);
		// everything decided → no visit left
		expect(reconcileVisits(c, [], T0 + 7_000).visits).toEqual([]);
	});

	test("several requests from one repository get distinct visits and seats", () => {
		const pending = [1, 2, 3, 4, 5, 6, 7].map((n) =>
			req(n, { created_at: iso(T0 + n) }),
		);
		const book = reconcileVisits(EMPTY_BOOK, pending, T0 + 100);
		expect(new Set(book.visits.map((v) => v.seat)).size).toBe(7);
		expect(new Set(book.visits.map((v) => v.request_id)).size).toBe(7);
	});

	test("progress is anchored to created_at: a remount mid-walk resumes, skew is clamped", () => {
		const walk = 10_000;
		// first seen 4 s after creation → 40 % already walked
		const fresh = reconcileVisits(EMPTY_BOOK, [req(1)], T0 + 4_000);
		const v = fresh.visits[0];
		if (!v) throw new Error("no visit");
		expect(visitProgress(v, T0 + 4_000, walk, false)).toBeCloseTo(0.4);
		expect(visitProgress(v, T0 + 7_000, walk, false)).toBeCloseTo(0.7);
		expect(visitProgress(v, T0 + 60_000, walk, false)).toBe(1);
		// server clock ahead of the client: never negative, starts at the office
		const ahead = reconcileVisits(
			EMPTY_BOOK,
			[req(1, { created_at: iso(T0 + 90_000) })],
			T0,
		).visits[0];
		expect(ahead?.head_start_ms).toBe(0);
		// long-pending request seen for the first time: clamped, already arrived
		const old = reconcileVisits(
			EMPTY_BOOK,
			[req(1, { created_at: iso(T0 - 86_400_000) })],
			T0,
		).visits[0];
		expect(old?.head_start_ms).toBe(MAX_HEAD_START_MS);
		if (old) expect(visitProgress(old, T0, walk, false)).toBe(1);
		// unparsable timestamp: starts at 0
		const bad = reconcileVisits(
			EMPTY_BOOK,
			[req(1, { created_at: "not a time" })],
			T0,
		).visits[0];
		expect(bad?.head_start_ms).toBe(0);
	});

	test("reduced motion: every visit is already arrived", () => {
		const v = reconcileVisits(EMPTY_BOOK, [req(1)], T0).visits[0];
		if (!v) throw new Error("no visit");
		expect(visitProgress(v, T0, 10_000, false)).toBe(0);
		expect(visitProgress(v, T0, 10_000, true)).toBe(1);
	});

	test("walk duration is bounded", () => {
		expect(walkDurationMs(0)).toBe(MIN_WALK_MS);
		expect(walkDurationMs(10_000)).toBe(MAX_WALK_MS);
	});
});

describe("figure poses", () => {
	const layout = campusLayout(["local/alpha", "local/beta"]);

	test("walking starts at the CEO's office chair and ends at a stable lobby spot", () => {
		const book = reconcileVisits(EMPTY_BOOK, [req(1)], T0);
		const v = book.visits[0];
		if (!v) throw new Error("no visit");
		const slot = slotOf(layout, "local/alpha");
		if (!slot) throw new Error("no slot");
		const start = figurePose(layout, v, T0, false, false);
		expect(start.posture).toBe("stand"); // about to leave the office
		expect([start.x, start.z]).toEqual([...officeSeat(slot)]);
		const mid = figurePose(
			layout,
			v,
			T0 + walkMsFor(layout, v) / 2,
			false,
			false,
		);
		expect(mid.posture).toBe("walk");
		const end = figurePose(
			layout,
			v,
			T0 + walkMsFor(layout, v) + 1,
			false,
			false,
		);
		const spot = lobbySpot(v.seat);
		expect([end.x, end.z, end.posture]).toEqual([spot.x, spot.z, "sit"]);
	});

	test("reduced motion places the visitor in the lobby at once; an open document puts it at the desk", () => {
		const v = reconcileVisits(EMPTY_BOOK, [req(1)], T0).visits[0];
		if (!v) throw new Error("no visit");
		const r = figurePose(layout, v, T0, true, false);
		expect(r.posture).toBe("sit");
		const desk = figurePose(layout, v, T0, true, true);
		expect([desk.x, desk.z, desk.posture]).toEqual([
			DESK_SPOT.x,
			DESK_SPOT.z,
			"stand",
		]);
	});

	test("unknown repository: the visitor still reaches Headquarters", () => {
		const v = reconcileVisits(EMPTY_BOOK, [req(1, { repo_id: "" })], T0)
			.visits[0];
		if (!v) throw new Error("no visit");
		const end = figurePose(layout, v, T0 + MAX_WALK_MS, false, false);
		expect([end.x, end.z]).toEqual([lobbySpot(0).x, lobbySpot(0).z]);
	});
});

describe("scene key", () => {
	test("ignores clock-only model churn, reacts to what the scene draws", () => {
		const a = model();
		const ticked = model({
			connection: { status: "online", last_confirmed_at: iso(T0 + 1_000) },
		});
		expect(sceneKey(ticked, false)).toBe(sceneKey(a, false));
		expect(sceneKey(a, true)).not.toBe(sceneKey(a, false));
		expect(sceneKey(model({ pending: [] }), false)).not.toBe(
			sceneKey(a, false),
		);
		expect(
			sceneKey(
				model({
					selected: { repo_id: "local/alpha", task_id: null, request_id: null },
				}),
				false,
			),
		).not.toBe(sceneKey(a, false));
	});
});
