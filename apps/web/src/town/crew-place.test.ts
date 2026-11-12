// Where the crew stand and walk (16 A1): spots on the pavement clear of the lane, the props and the
// facade; sticky spots; walks that never jump.
import { describe, expect, test } from "bun:test";
import { DOOR_SPOT, LANE } from "./choreo.ts";
import {
	assignCrewSlots,
	BUILDING_SPOTS,
	CAFE_SPOTS,
	companionSpot,
	crewPath,
	crewSpot,
	doorPoint,
} from "./crew-place.ts";
import { ellipseOffset, PROPS } from "./engine/ring-layout.mjs";
import { CAFE_LOT, PROJECT_SLOTS } from "./lots.ts";

const LOTS = [...PROJECT_SLOTS, CAFE_LOT];

describe("spots", () => {
	test("every spot is on the outer pavement, no nearer the facade than the HQ queue's first spot", () => {
		for (const lot of LOTS) {
			const n = lot === CAFE_LOT ? CAFE_SPOTS.length : BUILDING_SPOTS.length;
			for (let k = 0; k < n; k += 1) {
				const p = crewSpot(lot, k, false);
				const off = ellipseOffset(p.x, p.z);
				expect(off).toBeGreaterThan(2.5); // off the road
				expect(off).toBeLessThanOrEqual(DOOR_SPOT + 1e-6);
			}
		}
	});

	test("spots at a lot are apart, and clear of the lamps, benches, bins and trees", () => {
		for (const lot of LOTS) {
			const n = lot === CAFE_LOT ? CAFE_SPOTS.length : BUILDING_SPOTS.length;
			const pts = Array.from({ length: n }, (_, k) => crewSpot(lot, k, false));
			for (let i = 0; i < pts.length; i += 1)
				for (let j = i + 1; j < pts.length; j += 1) {
					const a = pts[i] as { x: number; z: number };
					const b = pts[j] as { x: number; z: number };
					expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(0.9);
				}
			for (const p of pts)
				for (const prop of PROPS)
					expect(Math.hypot(p.x - prop.x, p.z - prop.z)).toBeGreaterThan(0.9);
		}
	});

	test("a building's spots leave the door clear (its lead steps out there)", () => {
		for (const lot of PROJECT_SLOTS) {
			const d = doorPoint(lot);
			for (let k = 0; k < BUILDING_SPOTS.length; k += 1) {
				const p = crewSpot(lot, k, false);
				expect(Math.hypot(p.x - d.x, p.z - d.z)).toBeGreaterThan(1.3);
			}
		}
	});

	test("working faces the road, waiting faces the door, the cafe faces its middle", () => {
		const lot = PROJECT_SLOTS[0] as string;
		const work = crewSpot(lot, 0, false);
		const wait = crewSpot(lot, 0, true);
		expect(work.x).toBe(wait.x);
		expect(work.face[0]).toBeCloseTo(-wait.face[0], 9);
		expect(work.face[1]).toBeCloseTo(-wait.face[1], 9);
		const a = crewSpot(CAFE_LOT, 0, false);
		const b = crewSpot(CAFE_LOT, 1, false);
		// the two either side of the door turn toward each other
		expect(a.face[0] * b.face[0] + a.face[1] * b.face[1]).toBeLessThan(0);
	});

	test("a companion stands half a step beside, nearer the road", () => {
		const lot = PROJECT_SLOTS[2] as string;
		const at = crewSpot(lot, 0, false);
		const c0 = companionSpot(at, 0);
		const c1 = companionSpot(at, 1);
		expect(Math.hypot(c0.x - at.x, c0.z - at.z)).toBeLessThan(0.8);
		expect(Math.hypot(c0.x - c1.x, c0.z - c1.z)).toBeGreaterThan(0.9);
		expect(ellipseOffset(c0.x, c0.z)).toBeLessThan(ellipseOffset(at.x, at.z));
	});
});

describe("sticky spots", () => {
	test("a member keeps its spot while it stays at the lot; newcomers take the lowest free", () => {
		const a = PROJECT_SLOTS[0] as string;
		const s1 = assignCrewSlots(new Map(), [
			{ id: "x", lot: a },
			{ id: "y", lot: a },
		]);
		expect(s1.get("x")).toEqual({ lot: a, k: 0 });
		expect(s1.get("y")).toEqual({ lot: a, k: 1 });
		// x leaves, z arrives first in order: y keeps 1, z takes 0
		const s2 = assignCrewSlots(s1, [
			{ id: "z", lot: a },
			{ id: "y", lot: a },
		]);
		expect(s2.get("y")).toEqual({ lot: a, k: 1 });
		expect(s2.get("z")).toEqual({ lot: a, k: 0 });
		// y moves to the cafe: a new spot there
		const s3 = assignCrewSlots(s2, [{ id: "y", lot: CAFE_LOT }]);
		expect(s3.get("y")).toEqual({ lot: CAFE_LOT, k: 0 });
	});

	test("no more members at a lot than its spots", () => {
		const a = PROJECT_SLOTS[0] as string;
		const s = assignCrewSlots(
			new Map(),
			Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, lot: a })),
		);
		expect(s.size).toBe(BUILDING_SPOTS.length);
	});
});

describe("walks", () => {
	test("a walk across the ring keeps to the lane and never jumps", () => {
		const from = crewSpot(PROJECT_SLOTS[1] as string, 0, false);
		const to = crewSpot(CAFE_LOT, 2, false);
		const p = crewPath(from, to);
		expect(p.pts[0]).toEqual({ x: from.x, z: from.z });
		expect(p.pts[p.pts.length - 1]).toEqual({ x: to.x, z: to.z });
		for (let i = 1; i < p.pts.length; i += 1) {
			const a = p.pts[i - 1] as { x: number; z: number };
			const b = p.pts[i] as { x: number; z: number };
			expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(1.6);
		}
		for (const q of p.pts.slice(1, -1))
			expect(Math.abs(ellipseOffset(q.x, q.z) - LANE)).toBeLessThan(0.05);
	});

	test("out of a door to a spot of the same lot: straight", () => {
		const lot = PROJECT_SLOTS[3] as string;
		const p = crewPath(doorPoint(lot), crewSpot(lot, 1, false));
		expect(p.pts).toHaveLength(2);
	});
});
