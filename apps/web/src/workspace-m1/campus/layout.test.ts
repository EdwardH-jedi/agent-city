// Site plan determinism (pure): stable per repo id, order-independent, any count, no overlaps,
// the main axis stays clear for walks, routes start at the office and end in the HQ lobby.
import { describe, expect, test } from "bun:test";
import {
	campusLayout,
	ceoRoute,
	columnsFor,
	HQ_BOX,
	lobbySpot,
	officeSeat,
	REPO_BOX,
	routeLength,
	sampleRoute,
} from "./layout.ts";

const ids = (n: number) =>
	Array.from(
		{ length: n },
		(_, i) => `owner-${String(i).padStart(2, "0")}/repo`,
	);

function shuffled<T>(xs: readonly T[], seed: number): T[] {
	const out = [...xs];
	let s = seed;
	for (let i = out.length - 1; i > 0; i -= 1) {
		s = (s * 9301 + 49297) % 233280;
		const j = Math.floor((s / 233280) * (i + 1));
		const a = out[i];
		const b = out[j];
		if (a !== undefined && b !== undefined) {
			out[i] = b;
			out[j] = a;
		}
	}
	return out;
}

describe("campus layout", () => {
	test("same set of ids → identical plan, whatever the input order or duplicates", () => {
		for (const n of [1, 2, 3, 4, 5, 9, 12, 13, 24]) {
			const base = campusLayout(ids(n));
			for (const seed of [1, 7, 42]) {
				const again = campusLayout([
					...shuffled(ids(n), seed),
					...ids(n).slice(0, 2),
				]);
				expect(again).toEqual(base);
			}
		}
	});

	test("each repo keeps its slot across calls and is keyed by id", () => {
		const a = campusLayout(["b/two", "a/one", "c/three"]);
		expect(a.slots.map((s) => s.repo_id)).toEqual([
			"a/one",
			"b/two",
			"c/three",
		]);
		expect(campusLayout(["c/three", "a/one", "b/two"]).slots).toEqual(a.slots);
	});

	test("any count: no two buildings overlap, none sits on the main axis or on HQ", () => {
		for (let n = 0; n <= 30; n += 1) {
			const l = campusLayout(ids(n));
			expect(l.slots).toHaveLength(n);
			expect(l.cols).toBe(columnsFor(n));
			for (const s of l.slots) {
				// the axis lane (|x| < 2) is never covered by a building
				expect(Math.abs(s.x) - REPO_BOX.w / 2).toBeGreaterThanOrEqual(2);
				// south of Headquarters
				expect(s.z - REPO_BOX.d / 2).toBeGreaterThan(HQ_BOX.z + HQ_BOX.d / 2);
			}
			for (let i = 0; i < l.slots.length; i += 1)
				for (let j = i + 1; j < l.slots.length; j += 1) {
					const a = l.slots[i];
					const b = l.slots[j];
					if (!a || !b) continue;
					const apartX = Math.abs(a.x - b.x) >= REPO_BOX.w + 2;
					const apartZ = Math.abs(a.z - b.z) >= REPO_BOX.d + 2;
					expect(apartX || apartZ).toBe(true);
				}
		}
	});

	test("accents differ between neighbours", () => {
		const l = campusLayout(ids(6));
		const accents = l.slots.map((s) => s.accent);
		expect(new Set(accents).size).toBe(6);
	});

	test("bounds contain every building and Headquarters", () => {
		const l = campusLayout(ids(10));
		for (const s of l.slots) {
			expect(s.x - REPO_BOX.w / 2).toBeGreaterThanOrEqual(l.bounds.minX);
			expect(s.x + REPO_BOX.w / 2).toBeLessThanOrEqual(l.bounds.maxX);
			expect(s.z + REPO_BOX.d / 2).toBeLessThanOrEqual(l.bounds.maxZ);
		}
		expect(l.bounds.minZ).toBe(HQ_BOX.z - HQ_BOX.d / 2);
	});
});

describe("walking routes", () => {
	test("from the CEO's office chair to the visit's lobby spot; the shared stretch uses the axis", () => {
		const l = campusLayout(ids(7));
		for (const s of l.slots) {
			const r = ceoRoute(l, s.repo_id, 3);
			expect(r[0]).toEqual(officeSeat(s));
			const last = r[r.length - 1];
			expect(last).toEqual([lobbySpot(3).x, lobbySpot(3).z]);
			// every point north of the building row is on the axis lane or inside HQ's footprint
			for (const [x, z] of r)
				if (z < s.z - REPO_BOX.d / 2 && z > HQ_BOX.z + HQ_BOX.d / 2)
					expect(Math.abs(x)).toBeLessThan(2);
		}
	});

	test("sampling is monotonic along the route", () => {
		const l = campusLayout(ids(4));
		const r = ceoRoute(l, "owner-03/repo", 0);
		let prev = -1;
		for (let t = 0; t <= 1.0001; t += 0.05) {
			const p = sampleRoute(r, t);
			expect(p.distance).toBeGreaterThanOrEqual(prev);
			prev = p.distance;
		}
		expect(prev).toBeCloseTo(routeLength(r));
	});
});
