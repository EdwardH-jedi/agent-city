// The pylon in the plaza and the S1 board view (the seam S2 replaces with the real lot mapping).
import { describe, expect, test } from "bun:test";
import { Vector3 } from "three";
import type { CampusModel } from "../campus/presentation.ts";
import { boardViewOf } from "./board-view.ts";
import { LOTS, PYLON } from "./engine/ring-layout.mjs";
import { buildTownWorld } from "./world.ts";

const repo = (id: string, active: number, pending: number) => ({
	repo_id: id,
	label: id,
	active_tasks: active,
	monitors: [],
	pending_requests: pending,
	has_stopped: false,
});
const model = (still: boolean): CampusModel => ({
	repos: [repo("a/x", 2, 1), repo("b/y", 1, 0)],
	visitors: [],
	owner_present: true,
	still,
	door: null,
});

describe("board view (S1)", () => {
	test("every original lot has a zero row (lamps off); the ALL row carries the model's totals", () => {
		const v = boardViewOf(model(false));
		expect(v.offline).toBe(false);
		expect(v.rows.map((r) => r.lot)).toEqual(LOTS.map((l) => l.id));
		expect(v.rows.every((r) => r.working === 0 && r.waiting === 0)).toBe(true);
		expect(v.totals).toEqual({ working: 3, waiting: 1, idle: 0, unknown: 0 });
	});

	test("reports stopped: OFFLINE, every counter null (painted '—', never 0)", () => {
		const v = boardViewOf(model(true));
		expect(v.offline).toBe(true);
		expect(v.totals).toEqual({
			working: null,
			waiting: null,
			idle: null,
			unknown: null,
		});
		expect(v.rows.every((r) => r.working === null && r.unknown === null)).toBe(
			true,
		);
	});
});

describe("the pylon", () => {
	test("is the leaderboard (not the placeholder), standing in the plaza at PYLON, painted from the view", () => {
		const world = buildTownWorld({ time: "day" });
		const pylon = world.scene.getObjectByName("pylon");
		expect(pylon).toBeDefined();
		expect(world.scene.getObjectByName("pylon:placeholder")).toBeUndefined();
		expect(world.board.mesh.parent).toBe(pylon ?? null);
		world.scene.updateMatrixWorld(true);
		const at = world.board.mesh.getWorldPosition(new Vector3());
		expect([at.x, at.z]).toEqual([PYLON.x, PYLON.z]);
		expect(world.board.getDebugState().offline).toBe(true); // nothing known yet
		world.setBoard(boardViewOf(model(false)));
		expect(world.board.getDebugState().offline).toBe(false);
		world.setBoard(boardViewOf(model(true)));
		expect(world.board.getDebugState().offline).toBe(true);
		expect(
			Object.values(world.ring.lampStates()).every((s) => s === "offline"),
		).toBe(true);
		world.dispose();
	});
});
