// Panel titles in the town's own pixel font (design doc 15 §2), as the original draws them
// (renderer/panels.mjs `pixelTitle`, not ported): the pylon's 5-texel glyphs (`leaderboard.mjs`
// `boardText` + `drawBoardText`) on a small canvas at an integer CSS scale, ink #b9ab92. The glyphs carry
// M and U (textures.mjs alone does not), and leaderboard.mjs imports three, so this module lives in the
// town's lazy chunk; the board shows the same word as DOM text until (and besides) it is drawn — the
// canvas is aria-hidden, the word stays in the DOM (12 §6-3). The engine is imported, never edited:
// `drawBoardText` and `boardTextWidth` are not in the hand-written leaderboard.d.mts, so they are read
// through the module namespace.
import { useEffect, useRef } from "react";
import * as board from "./engine/leaderboard.mjs";

interface PixelImage {
	width: number;
	height: number;
	data: Uint8Array;
}
interface BoardFont {
	boardText(s: unknown, max: number, maxW: number): string;
	boardTextWidth(s: string): number;
	drawBoardText(
		img: PixelImage,
		s: string,
		x: number,
		y: number,
		color: readonly number[],
	): number;
	hasGlyph(ch: string): boolean;
}
const font = board as unknown as BoardFont;

/** The original's title ink (panels.mjs TITLE_INK, the panel's dim ink). */
export const TITLE_INK = [0xb9, 0xab, 0x92] as const;
/** Glyph rows; the original draws titles at 2× (10 CSS px tall). */
export const GLYPH_H = 5;
export const TITLE_SCALE = 2;

/** The word as the font draws it (upper case; an unknown character would turn into a space). */
export const titleText = (text: string): string =>
	font.boardText(text, 24, 400);
/** Whether every character of `text` has a glyph (a title must not lose a letter silently). */
export const titleDrawable = (text: string): boolean =>
	[...text.toUpperCase()].every((ch) => font.hasGlyph(ch));

/** The RGBA texels of a title at 1×: width × 5, ink where the glyphs are, transparent elsewhere. */
export function titlePixels(text: string): PixelImage {
	const s = titleText(text);
	const width = Math.max(1, font.boardTextWidth(s));
	const img: PixelImage = {
		width,
		height: GLYPH_H,
		data: new Uint8Array(width * GLYPH_H * 4),
	};
	font.drawBoardText(img, s, 0, 0, TITLE_INK);
	return img;
}

/** The title as a canvas at TITLE_SCALE (aria-hidden: the same word is DOM text next to it). */
export default function PixelTitle({ text }: { text: string }) {
	const ref = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		const c = ref.current;
		if (!c) return;
		const img = titlePixels(text);
		c.width = img.width;
		c.height = img.height;
		c.style.width = `${img.width * TITLE_SCALE}px`;
		c.style.height = `${img.height * TITLE_SCALE}px`;
		const ctx = c.getContext("2d");
		if (!ctx) return;
		const id = ctx.createImageData(img.width, img.height);
		id.data.set(img.data);
		ctx.putImageData(id, 0, 0);
	}, [text]);
	// hidden from assistive tech: the same word is DOM text beside it
	return (
		<span className="ptitle-px-box" aria-hidden="true">
			<canvas ref={ref} className="ptitle-px" />
		</span>
	);
}
