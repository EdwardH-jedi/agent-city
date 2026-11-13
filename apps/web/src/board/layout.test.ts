import { describe, expect, test } from "bun:test";
import { fitStage } from "../town/pipeline.ts";
import {
	boardColumns,
	PANEL_MAX,
	PANEL_MIN,
	STAGE_H,
	STAGE_W,
	TOP_H,
	uiScaleOf,
} from "./layout.ts";

describe("boardColumns (15 §1)", () => {
	test("1920×1080: 384 / 1152 / 384 at 3×", () => {
		const c = boardColumns(1920, 1080);
		expect([c.left, c.middle, c.right, c.scale]).toEqual([384, 1152, 384, 3]);
		expect(c.middle / 1920).toBeGreaterThanOrEqual(0.6);
	});
	test("1366×768: 299 / 768 / 299 at 2×", () => {
		const c = boardColumns(1366, 768);
		expect([c.left, c.middle, c.right, c.scale]).toEqual([299, 768, 299, 2]);
	});
	test("17 F3: the stage fills the body's height — 1920×1080: 341 rows (1152×1023), 1366×768: 356 (768×712)", () => {
		const a = boardColumns(1920, 1080);
		expect([a.rtH, a.rtH * a.scale, a.body]).toEqual([341, 1023, 1024]);
		const b = boardColumns(1366, 768);
		expect([b.rtH, b.rtH * b.scale, b.body]).toEqual([356, 712, 712]);
		expect(boardColumns(1280, 720).rtH).toBe(332);
		expect(boardColumns(2560, 1440).rtH).toBe(346);
		expect(boardColumns(1920, 1200).rtH).toBe(360); // clamped: 64 px left
		expect(boardColumns(Number.NaN, -5).rtH).toBe(288);
	});
	test("panels are equal, whole px, within PANEL_MIN..PANEL_MAX, and fill the width", () => {
		for (let w = 900; w <= 3000; w += 37)
			for (let h = 500; h <= 1700; h += 41) {
				const c = boardColumns(w, h);
				expect(c.left).toBe(c.right);
				expect(Number.isInteger(c.left)).toBe(true);
				expect(c.left).toBeGreaterThanOrEqual(PANEL_MIN);
				expect(c.left).toBeLessThanOrEqual(PANEL_MAX);
				expect(c.left + c.middle + c.right).toBe(Math.max(w, 2 * c.left));
				expect(c.body).toBe(h - TOP_H);
			}
	});
	test("the town's own fit of the middle column picks the same scale at full width", () => {
		for (let w = 1248; w <= 3000; w += 29)
			for (let h = 640; h <= 1700; h += 31) {
				const c = boardColumns(w, h);
				if (c.scale < 2) continue;
				const fit = fitStage(c.middle, c.body);
				expect({ w, h, scale: fit.scale, rtW: fit.rtW, rtH: fit.rtH }).toEqual({
					w,
					h,
					scale: c.scale,
					rtW: STAGE_W,
					rtH: c.rtH,
				});
				expect(fit.height).toBe(c.rtH * c.scale);
				expect(c.rtH).toBeGreaterThanOrEqual(STAGE_H);
			}
	});
	test("a window too narrow for two panels beside 2× drops the stage to 1×", () => {
		const c = boardColumns(1100, 768);
		expect(c.scale).toBe(1);
		expect([c.left, c.right]).toEqual([358, 358]);
		expect(c.middle).toBe(384);
	});
	test("panels are capped at 420 on a wide window; the middle takes the rest", () => {
		const c = boardColumns(2560, 1080);
		expect(c.scale).toBe(3);
		expect([c.left, c.right]).toEqual([420, 420]);
		expect(c.middle).toBe(2560 - 840);
	});
	test("junk sizes give whole, non-negative numbers", () => {
		const c = boardColumns(Number.NaN, -5);
		expect(c.scale).toBe(1);
		expect(c.middle).toBe(0);
		expect(c.body).toBe(0);
	});
});

describe("uiScaleOf (?ui=)", () => {
	test("1, 1.15 and 1.3 are taken", () => {
		expect(uiScaleOf("")).toBe(1);
		expect(uiScaleOf("?ui=1")).toBe(1);
		expect(uiScaleOf("?ui=1.15")).toBe(1.15);
		expect(uiScaleOf("?ui=1.3")).toBe(1.3);
		expect(uiScaleOf("?demo=1&ui=1.30")).toBe(1.3);
	});
	test("anything else is 1", () => {
		for (const q of [
			"?ui=",
			"?ui=2",
			"?ui=0.5",
			"?ui=1.2",
			"?ui=abc",
			"?ui=-1.3",
			"?ui=Infinity",
		])
			expect(uiScaleOf(q)).toBe(1);
	});
});
