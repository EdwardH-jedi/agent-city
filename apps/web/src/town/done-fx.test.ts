// The finish show's pure parts (17 §3): where the flag stands, how a burst's pieces fly (bounded, gone by
// 20 s, deterministic), the 48-piece cap across bursts, and the pixels of the flag and a piece.
import { describe, expect, test } from "bun:test";
import {
	BURST_S,
	burstPieces,
	CONFETTI_MAX,
	confettiAt,
	confettiCell,
	DONE_FRAME_MAX,
	doneKey,
	flagCell,
	PIECES_PER_BURST,
	roofSpot,
} from "./done-fx.ts";
import { LOTS } from "./engine/ring-layout.mjs";
import { CELL_H, CELL_W } from "./engine/sprite-atlas.mjs";

const lot = LOTS.find((l) => l.id === "engineering");
if (!lot) throw new Error("no engineering lot");
const spot = roofSpot({ ...lot, h: 15 });

describe("roofSpot", () => {
	test("on the front parapet at the middle of the frontage, above the roof", () => {
		expect(spot.y).toBeGreaterThan(15);
		// a hair behind the door's line, into the building (the outward normal)
		const d = (spot.x - lot.doorX) * spot.nx + (spot.z - lot.doorZ) * spot.nz;
		expect(d).toBeGreaterThan(0);
		expect(d).toBeLessThan(0.3);
		// the tangent and the normal are unit and square
		expect(Math.hypot(spot.nx, spot.nz)).toBeCloseTo(1, 6);
		expect(spot.nx * spot.tx + spot.nz * spot.tz).toBeCloseTo(0, 6);
	});
});

describe("burstPieces", () => {
	test("pieces pop over the first seconds, fly, and are all gone by BURST_S", () => {
		expect(burstPieces(spot, 7, 0, 48).length).toBe(1);
		expect(burstPieces(spot, 7, 3, 48).length).toBe(48);
		expect(burstPieces(spot, 7, BURST_S, 48)).toEqual([]);
		expect(burstPieces(spot, 7, -1, 48)).toEqual([]);
		expect(burstPieces(spot, 7, Number.NaN, 48)).toEqual([]);
	});
	test("they rise off the roof, drift toward the road, then fall and leave at the street", () => {
		const at = (t: number) => burstPieces(spot, 7, t, 48);
		expect(Math.max(...at(1).map((p) => p.y))).toBeGreaterThan(spot.y);
		const late = at(16);
		expect(late.length).toBeLessThan(48);
		expect(late.length).toBeGreaterThan(0);
		expect(late.every((p) => p.y > 0)).toBe(true);
		expect(at(19.2)).toEqual([]); // all landed before BURST_S
		// falling, not climbing, once past the first seconds
		const a = at(8);
		const b = burstPieces(spot, 7, 8.5, 48);
		expect(
			b.every((p, i) => p.y <= (a[i]?.y ?? Number.POSITIVE_INFINITY)),
		).toBe(true);
		// toward the road: against the outward normal
		const out = at(6).map(
			(p) => (p.x - spot.x) * spot.nx + (p.z - spot.z) * spot.nz,
		);
		expect(Math.max(...out)).toBeLessThan(0.01);
	});
	test("deterministic: the same seed and time give the same pieces (a reload draws them where they were)", () => {
		expect(burstPieces(spot, 42, 4.2, 30)).toEqual(
			burstPieces(spot, 42, 4.2, 30),
		);
		expect(burstPieces(spot, 42, 4.2, 30)).not.toEqual(
			burstPieces(spot, 43, 4.2, 30),
		);
	});
});

describe("confettiAt: the cap across bursts", () => {
	const b = (at: number, seed: number) => ({ spot, at, seed });
	test("never more than 48, however many bursts", () => {
		expect(confettiAt([b(0, 1)], 5_000).length).toBe(PIECES_PER_BURST);
		for (const n of [2, 3, 5, 10, 60]) {
			const many = Array.from({ length: n }, (_, i) => b(i * 100, i));
			expect(confettiAt(many, 6_000).length).toBeLessThanOrEqual(CONFETTI_MAX);
		}
		expect(confettiAt([b(0, 1)], BURST_S * 1000)).toEqual([]);
		expect(confettiAt([b(10_000, 1)], 5_000)).toEqual([]); // not begun
		expect(confettiAt([], 5_000)).toEqual([]);
	});
	test("a second burst beginning or ending moves no piece of the first (nothing jumps or vanishes mid-air)", () => {
		const a = b(0, 1);
		const second = b(10_000, 2);
		const only = (ps: ReturnType<typeof confettiAt>, ref: typeof ps) =>
			ps.filter((p) =>
				ref.some((q) => q.x === p.x && q.y === p.y && q.z === p.z),
			);
		for (const t of [10_016, 15_000, 19_000]) {
			const alone = confettiAt([a], t);
			const both = confettiAt([a, second], t);
			expect(only(both, alone)).toEqual(alone);
		}
		// and the second's pieces are the same whether the first is still flying or not
		const late = confettiAt([a, second], 25_000);
		expect(late).toEqual(confettiAt([second], 25_000));
	});
	test("a third burst while two fly does not fly at all (it would only appear late, mid-air)", () => {
		const three = [b(0, 1), b(1_000, 2), b(2_000, 3)];
		expect(confettiAt(three, 5_000).length).toBe(CONFETTI_MAX);
		expect(confettiAt(three, 21_500)).toEqual([]); // 1 and 2 have landed; 3 never flew
	});
});

describe("pixels", () => {
	test("a 32 × 40 cell; the flag stands on the cell's bottom middle, the pieces are 9 or 3 pixels", () => {
		for (const phase of [0, 1]) {
			const c = flagCell(phase);
			expect(c.length).toBe(CELL_W * CELL_H * 4);
			const alpha = (x: number, y: number) => c[(y * CELL_W + x) * 4 + 3];
			expect(alpha(CELL_W / 2 - 1, CELL_H - 1)).toBe(255); // the pole's foot
		}
		expect(flagCell(0)).not.toEqual(flagCell(1)); // it waves
		const count = (cell: Uint8Array) =>
			cell.filter((_, i) => i % 4 === 3 && cell[i] === 255).length;
		expect(count(confettiCell(0, 0))).toBe(9);
		expect(count(confettiCell(3, 1))).toBe(3);
	});
	test("frames are keyed by look, never by piece: at most DONE_FRAME_MAX", () => {
		const keys = new Set<string>();
		for (let c = 0; c < 20; c += 1)
			for (let s = 0; s < 2; s += 1)
				keys.add(doneKey({ kind: "confetti", color: c % 6, shape: s }));
		keys.add(doneKey({ kind: "flag", phase: 0 }));
		keys.add(doneKey({ kind: "flag", phase: 1 }));
		expect(keys.size).toBe(DONE_FRAME_MAX);
	});
});
