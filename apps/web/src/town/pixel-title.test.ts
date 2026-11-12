import { describe, expect, test } from "bun:test";
import { PANEL_TITLES } from "../board/PanelHead.tsx";
import {
	GLYPH_H,
	TITLE_INK,
	titleDrawable,
	titlePixels,
	titleText,
} from "./pixel-title.tsx";

describe("panel titles in the town's pixel font (15 §2)", () => {
	test("every title has a glyph for every letter (boardText would turn a missing one into a space)", () => {
		for (const t of PANEL_TITLES) {
			expect(titleDrawable(t)).toBe(true);
			expect(titleText(t)).toBe(t);
		}
	});
	test("a title is 5 texels tall, as wide as its glyphs, inked only with the title ink", () => {
		const img = titlePixels("SESSIONS");
		expect(img.height).toBe(GLYPH_H);
		expect(img.width).toBeGreaterThan(20);
		let inked = 0;
		for (let i = 0; i < img.data.length; i += 4) {
			if (img.data[i + 3] === 0) continue;
			inked++;
			expect([img.data[i], img.data[i + 1], img.data[i + 2]]).toEqual([
				...TITLE_INK,
			]);
		}
		expect(inked).toBeGreaterThan(20);
	});
	test("Korean has no glyph: a title in Korean is refused, not drawn as blanks", () => {
		expect(titleDrawable("지도")).toBe(false);
	});
});
