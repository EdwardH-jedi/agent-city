// The leads' sprites (design doc 12 §4 "책임자", §12): TownArt people, one look per building — style from
// TownArt's own resolve over (repo id, a model family picked by the repo hash), clothes hue-rotated by
// the repo hash like the original townsfolk. TownArt has no walking-while-carrying pose (its clipboard
// and book poses stand still), so a 결재 lead carries a small folder (승인 대기) or binder (멈춤) drawn
// here in the same coded-pixel style: a 5 × 7 outlined block at the hand. No external art.
//
// Frames are made on demand, one 32 × 40 texture per (look, facing, action, phase), cached for the
// world's lifetime and disposed with it (the original pipeline.mjs runtime-frame path, `frameFor`), so
// nothing is rebuilt per tick and a new lead costs only its own frames.
import {
	ClampToEdgeWrapping,
	DataTexture,
	NearestFilter,
	RGBAFormat,
	UnsignedByteType,
} from "three";
import type { Carry } from "../campus/presentation.ts";
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

const FAMILIES = ["Opus", "Sonnet", "Haiku", "Codex", "Unknown"] as const;

export interface LeadSprite {
	/** The lead's building (TownArt's id). */
	repo_id: string;
	carry: Carry | null;
	facing: RooDirection;
	action: "idle" | "walk";
	phase: number;
}

export const leadKey = (s: LeadSprite): string =>
	`lead|${s.repo_id}|${s.carry ?? "-"}|${s.facing}|${s.action}|${s.phase}`;

export function leadLook(repoId: string): { family: string; recolor: number } {
	const h = hash32(repoId);
	return {
		family: FAMILIES[h % FAMILIES.length] ?? "Unknown",
		recolor: 30 + ((h >>> 8) % 300),
	};
}

type Rgb = readonly [number, number, number];
const OUTLINE: Rgb = [0x1b, 0x15, 0x12];
const CARRY_COLOURS: Record<Carry, { body: Rgb; edge: Rgb; mark: Rgb }> = {
	// manila folder with a sheet showing at the top
	folder: {
		body: [0xd8, 0xb0, 0x60],
		edge: [0xa0, 0x78, 0x30],
		mark: [0xf4, 0xef, 0xe0],
	},
	// dark binder with its spine and a label
	binder: {
		body: [0x2d, 0x4a, 0x8a],
		edge: [0x18, 0x28, 0x48],
		mark: [0xe8, 0xe4, 0xd8],
	},
};
/** Top-left of the 5 × 7 carried block in the 32 × 40 cell, per screen facing (at the hand). */
export const CARRY_AT: Record<RooDirection, readonly [number, number]> = {
	south: [20, 22],
	east: [18, 21],
	west: [9, 21],
	north: [7, 22],
};

/** Paints the folder / binder into a 32 × 40 RGBA cell (row 0 = top). */
export function paintCarry(
	rgba: Uint8Array,
	carry: Carry,
	facing: RooDirection,
): void {
	const [x0, y0] = CARRY_AT[facing];
	const c = CARRY_COLOURS[carry];
	const set = (x: number, y: number, col: Rgb) => {
		const i = ((y0 + y) * CELL_W + x0 + x) * 4;
		rgba[i] = col[0];
		rgba[i + 1] = col[1];
		rgba[i + 2] = col[2];
		rgba[i + 3] = 255;
	};
	for (let y = 0; y < 7; y += 1)
		for (let x = 0; x < 5; x += 1) {
			const edge = x === 0 || y === 0 || x === 4 || y === 6;
			set(x, y, edge ? OUTLINE : c.body);
		}
	if (carry === "folder") {
		for (let x = 1; x < 4; x += 1) set(x, 1, c.mark);
		set(3, 5, c.edge);
	} else {
		for (let y = 1; y < 6; y += 1) set(1, y, c.edge);
		set(3, 3, c.mark);
	}
}

/** One lead frame as a 32 × 40 RGBA cell, feet at (16, 40) like the atlas. */
export function leadCell(art: TownArtApi, s: LeadSprite): Uint8Array {
	const look = leadLook(s.repo_id);
	const starts = phaseStartFrames(art, s.action);
	const frame = starts[s.phase] ?? s.phase;
	const sp = art.getSprite({
		id: s.repo_id,
		modelFamily: look.family,
		facing: s.facing,
		action: s.action,
		frame,
		costume: null,
	});
	const rgba = recolorRGBA(sp.rgba, look.recolor);
	const ox = Math.round(CELL_W / 2 - sp.pivotX);
	const oy = CELL_H - Math.round(sp.pivotY);
	const out = new Uint8Array(CELL_W * CELL_H * 4);
	for (let r = 0; r < sp.height; r += 1)
		out.set(
			rgba.subarray(r * sp.width * 4, (r + 1) * sp.width * 4),
			((oy + r) * CELL_W + ox) * 4,
		);
	if (s.carry) paintCarry(out, s.carry, s.facing);
	return out;
}

export interface LeadFrames {
	/** createActorLayer's frameFor: a frame for a lead actor (its `sprite`), made once per key. */
	frameFor(a: Actor): unknown;
	readonly size: number;
	dispose(): void;
}

export function createLeadFrames(art: TownArtApi): LeadFrames {
	const cache = new Map<
		string,
		{ texture: DataTexture; cx: number; cy: number }
	>();
	return {
		frameFor(a) {
			const s = a.sprite as LeadSprite | undefined;
			if (!s) return null;
			const key = leadKey(s);
			let f = cache.get(key);
			if (!f) {
				const cell = leadCell(art, s);
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
				f = { texture: t, cx: 0.5, cy: 0 };
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
