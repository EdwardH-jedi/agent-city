// The leads' sprites: TownArt people per building (stable look), and the coded-pixel folder / binder a
// 결재 lead carries (TownArt has no walking-while-carrying pose).
import { describe, expect, test } from "bun:test";
import { CELL_H, CELL_W } from "./engine/sprite-atlas.mjs";
import { TownArt } from "./engine/town-art.mjs";
import { CARRY_AT, leadCell, leadKey, leadLook } from "./lead-sprites.ts";

const base = {
	repo_id: "o/alpha",
	carry: null,
	facing: "south" as const,
	action: "walk" as const,
	phase: 1,
};
const px = (c: Uint8Array, x: number, y: number) =>
	Array.from(c.subarray((y * CELL_W + x) * 4, (y * CELL_W + x) * 4 + 4));

describe("lead sprites", () => {
	test("one look per building, stable", () => {
		expect(leadLook("o/alpha")).toEqual(leadLook("o/alpha"));
		const fams = new Set(
			Array.from({ length: 40 }, (_, i) => leadLook(`o/r${i}`).family),
		);
		expect(fams.size).toBeGreaterThanOrEqual(3);
		expect(Array.from(leadCell(TownArt, base))).toEqual(
			Array.from(leadCell(TownArt, base)),
		);
	});

	test("a 32 × 40 cell with the feet on the bottom row; alpha only 0 or 255", () => {
		const c = leadCell(TownArt, base);
		expect(c.length).toBe(CELL_W * CELL_H * 4);
		let bottom = 0;
		for (let x = 0; x < CELL_W; x += 1)
			if (px(c, x, CELL_H - 1)[3]) bottom += 1;
		expect(bottom).toBeGreaterThan(0);
		for (let i = 3; i < c.length; i += 4) expect([0, 255]).toContain(c[i]);
	});

	test("folder and binder: an outlined 5 × 7 block at the hand, different colours; nothing without a carry", () => {
		for (const facing of ["north", "east", "south", "west"] as const) {
			const plain = leadCell(TownArt, { ...base, facing });
			const folder = leadCell(TownArt, { ...base, facing, carry: "folder" });
			const binder = leadCell(TownArt, { ...base, facing, carry: "binder" });
			const [x0, y0] = CARRY_AT[facing];
			expect(px(folder, x0, y0)).toEqual([0x1b, 0x15, 0x12, 255]);
			expect(px(folder, x0 + 2, y0 + 3)).not.toEqual(
				px(binder, x0 + 2, y0 + 3),
			);
			expect(px(folder, x0 + 2, y0 + 3)[3]).toBe(255);
			// outside the block the figure is untouched
			expect(px(folder, 2, 2)).toEqual(px(plain, 2, 2));
		}
		expect(leadKey({ ...base, carry: "folder" })).toBe(
			"lead|o/alpha|folder|south|walk|1",
		);
	});
});
