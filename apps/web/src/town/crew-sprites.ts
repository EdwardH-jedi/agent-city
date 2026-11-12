// The crew's sprites (design doc 16 A1): TownArt people, as the original draws its agents — the look of
// the session's model family (Opus, Sonnet, Haiku, Codex), so Claude and Codex read apart by their
// clothes; a session id picks one of CREW_VARIANTS (skin and a small hue turn inside the family's colours).
// A Fable session wears the Opus look (TownArt has no Fable style; its own would be the "?" smock), a
// Claude session of an unknown model one of the three Claude looks by its id. Companions (subagents) are
// the same figure at 2/3 size. Name tags are the pylon's 3 × 5 glyphs (leaderboard.mjs, the panel
// titles' font) on a plate in the style's own nameplate colour, over working figures only (at the cafe
// a group's tags overlapped), drawn as their own actor whose frame
// stands one cell above the feet (centre y −1), so tag and figure share the one snapped foot pixel.
//
// Frames are keyed by look, never by session id — family × variant × facing × action × phase × size,
// and one per tag text — so the cache is bounded however many sessions a night brings (CREW_FRAME_MAX).
// Made on demand, disposed with the world (lead-sprites.ts does the same).
import {
	ClampToEdgeWrapping,
	DataTexture,
	NearestFilter,
	RGBAFormat,
	UnsignedByteType,
} from "three";
import * as board from "./engine/leaderboard.mjs";
import {
	CELL_H,
	CELL_W,
	phaseStartFrames,
	recolorRGBA,
} from "./engine/sprite-atlas.mjs";
import type { Actor } from "./engine/sprites.mjs";
import type { TownArtApi } from "./engine/town-art.mjs";
import type { RooDirection } from "./engine/town-roo-art-m2.mjs";
import { hash32 } from "./lots.ts";

/** TownArt style per crew family. */
export const STYLE_OF: Readonly<Record<string, string>> = {
	opus: "Opus",
	sonnet: "Sonnet",
	haiku: "Haiku",
	fable: "Opus",
	codex: "Codex",
};
const CLAUDE_STYLES = ["Opus", "Sonnet", "Haiku"] as const;
/** Looks per style: a skin and a hue turn (degrees; small, so the family's colours stay). */
export const CREW_VARIANTS = 3;
const HUE_TURNS = [0, 18, 342] as const;
/** The nameplate colours TownArt gives its styles (listStyles). */
const PLATE: Readonly<Record<string, readonly [number, number, number]>> = {
	Opus: [0xc4, 0x7a, 0x50],
	Sonnet: [0x5b, 0x7a, 0x63],
	Haiku: [0x86, 0xb2, 0xc4],
	Codex: [0x78, 0xa4, 0x5e],
	Unknown: [0x87, 0x8c, 0x8f],
};
const OUTLINE = [0x1b, 0x15, 0x12] as const;
const INK = [0xf4, 0xef, 0xe0] as const;
const INK_DARK = [0x1b, 0x15, 0x12] as const;

export interface CrewLook {
	style: string;
	variant: number;
}

/** A session's look: its family's style (unknown Claude model: by id), a variant by id. */
export function crewLook(
	id: string,
	provider: string,
	family: string | null,
): CrewLook {
	const h = hash32(id);
	const style =
		(family && STYLE_OF[family]) ||
		(provider === "claude"
			? (CLAUDE_STYLES[h % CLAUDE_STYLES.length] ?? "Opus")
			: "Unknown");
	return { style, variant: (h >>> 8) % CREW_VARIANTS };
}

export interface CrewSprite {
	kind: "crew";
	look: CrewLook;
	facing: RooDirection;
	action: "idle" | "walk";
	phase: number;
	/** A companion: the figure at 2/3 size. */
	small: boolean;
}
export interface TagSprite {
	kind: "tag";
	text: string;
	style: string;
}

export const crewKey = (s: CrewSprite): string =>
	`crew|${s.look.style}|${s.look.variant}|${s.facing}|${s.action}|${s.phase}|${s.small ? 1 : 0}`;
export const tagKey = (s: TagSprite): string => `tag|${s.style}|${s.text}`;

/** Styles × variants × 4 facings × (idle 2 + walk 4 phases) × 2 sizes, plus tags (≤ 6 texts × 5 styles). */
export const CREW_FRAME_MAX = 5 * CREW_VARIANTS * 4 * 6 * 2 + 6 * 5;

/** One crew frame as a 32 × 40 RGBA cell, feet at (16, 40) like the atlas. */
export function crewCell(art: TownArtApi, s: CrewSprite): Uint8Array {
	const starts = phaseStartFrames(art, s.action);
	const frame = starts[s.phase] ?? s.phase;
	const sp = art.getSprite({
		// TownArt picks skin and hair from the id: one per variant, not per session
		id: `crew-${s.look.style}-${s.look.variant}`,
		modelFamily: s.look.style,
		facing: s.facing,
		action: s.action,
		frame,
		costume: null,
	});
	const rgba = recolorRGBA(sp.rgba, HUE_TURNS[s.look.variant] ?? 0);
	const out = new Uint8Array(CELL_W * CELL_H * 4);
	const k = s.small ? 2 / 3 : 1;
	const w = Math.round(sp.width * k);
	const h = Math.round(sp.height * k);
	const ox = Math.round(CELL_W / 2 - sp.pivotX * k);
	const oy = CELL_H - Math.round(sp.pivotY * k);
	for (let y = 0; y < h; y += 1)
		for (let x = 0; x < w; x += 1) {
			const sx = Math.min(sp.width - 1, Math.floor(x / k));
			const sy = Math.min(sp.height - 1, Math.floor(y / k));
			const dx = ox + x;
			const dy = oy + y;
			if (dx < 0 || dx >= CELL_W || dy < 0 || dy >= CELL_H) continue;
			const si = (sy * sp.width + sx) * 4;
			if (!rgba[si + 3]) continue;
			out.set(rgba.subarray(si, si + 4), (dy * CELL_W + dx) * 4);
		}
	return out;
}

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
}
// drawBoardText / boardTextWidth are not in the hand-written leaderboard.d.mts (pixel-title.tsx reads them
// the same way)
const font = board as unknown as BoardFont;
/** Plate rows at the bottom of the tag cell: outline, pad, 5 glyph rows, pad, outline. */
export const TAG_H = 9;

/** A name tag as a 32 × 40 RGBA cell: the plate centred on the cell's bottom rows. */
export function tagCell(s: TagSprite): Uint8Array {
	const text = font.boardText(s.text, 7, CELL_W - 4);
	const tw = Math.max(1, font.boardTextWidth(text));
	const pw = Math.min(CELL_W, tw + 4);
	const x0 = Math.floor((CELL_W - pw) / 2);
	const y0 = CELL_H - TAG_H;
	const out = new Uint8Array(CELL_W * CELL_H * 4);
	const plate = PLATE[s.style] ?? PLATE.Unknown ?? [0x87, 0x8c, 0x8f];
	const set = (x: number, y: number, c: readonly number[]) => {
		const i = (y * CELL_W + x) * 4;
		out[i] = c[0] ?? 0;
		out[i + 1] = c[1] ?? 0;
		out[i + 2] = c[2] ?? 0;
		out[i + 3] = 255;
	};
	for (let y = 0; y < TAG_H; y += 1)
		for (let x = 0; x < pw; x += 1) {
			const edge = x === 0 || y === 0 || x === pw - 1 || y === TAG_H - 1;
			set(x0 + x, y0 + y, edge ? OUTLINE : plate);
		}
	// light ink on a dark plate, dark ink on a light one
	const lum = 0.299 * plate[0] + 0.587 * plate[1] + 0.114 * plate[2];
	const img: PixelImage = { width: CELL_W, height: CELL_H, data: out };
	font.drawBoardText(
		img,
		text,
		x0 + Math.floor((pw - tw) / 2),
		y0 + 2,
		lum > 150 ? INK_DARK : INK,
	);
	return out;
}

export interface CrewFrames {
	/** createActorLayer's frameFor: a frame for a crew or tag actor (its `sprite`), made once per key. */
	frameFor(a: Actor): unknown;
	readonly size: number;
	dispose(): void;
}

export function createCrewFrames(art: TownArtApi): CrewFrames {
	const cache = new Map<
		string,
		{ texture: DataTexture; cx: number; cy: number }
	>();
	const make = (cell: Uint8Array, cy: number) => {
		// rows flipped for the GL texture (v = 0 at the bottom), as the atlas does
		const flipped = new Uint8Array(cell.length);
		const row = CELL_W * 4;
		for (let y = 0; y < CELL_H; y += 1)
			flipped.set(
				cell.subarray(y * row, (y + 1) * row),
				(CELL_H - 1 - y) * row,
			);
		const t = new DataTexture(
			flipped,
			CELL_W,
			CELL_H,
			RGBAFormat,
			UnsignedByteType,
		);
		t.magFilter = NearestFilter;
		t.minFilter = NearestFilter;
		t.generateMipmaps = false;
		t.wrapS = ClampToEdgeWrapping;
		t.wrapT = ClampToEdgeWrapping;
		t.needsUpdate = true;
		return { texture: t, cx: 0.5, cy };
	};
	return {
		frameFor(a) {
			const s = a.sprite as CrewSprite | TagSprite | undefined;
			if (!s || (s.kind !== "crew" && s.kind !== "tag")) return null;
			const key = s.kind === "crew" ? crewKey(s) : tagKey(s);
			let f = cache.get(key);
			if (!f) {
				// a tag's cell stands one cell above the feet (its plate just over the head)
				f =
					s.kind === "crew" ? make(crewCell(art, s), 0) : make(tagCell(s), -1);
				cache.set(key, f);
			}
			return f;
		},
		get size() {
			return cache.size;
		},
		dispose() {
			for (const f of cache.values()) f.texture.dispose();
			cache.clear();
		},
	};
}
