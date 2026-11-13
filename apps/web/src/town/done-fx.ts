// The finish show in the town (17 §3): a flag on the roof of every building that finished today, and a
// burst of confetti off the roof of one that has just finished. Drawn the original's way — code-drawn
// pixels in 32 × 40 runtime frames through the engine's actor layer (frameFor), as lead-sprites.ts and
// crew-sprites.ts do; the engine is not edited.
//
// Pure parts (positions, pixels) are tested on their own; the frames (GPU textures) are keyed by look —
// flag phase, confetti colour × shape — never by piece, so the cache is bounded (DONE_FRAME_MAX). The
// confetti frames are released as soon as no burst is flying; the flag frames go with the world.
import {
	ClampToEdgeWrapping,
	DataTexture,
	NearestFilter,
	RGBAFormat,
	UnsignedByteType,
} from "three";
import { ellipseNormal, ellipseTangent } from "./engine/ring-layout.mjs";
import { CELL_H, CELL_W } from "./engine/sprite-atlas.mjs";
import type { Actor } from "./engine/sprites.mjs";
import { hash32 } from "./lots.ts";

/** Seconds the confetti flies (board/done.ts BURST_MS). */
export const BURST_S = 20;
/** Confetti pieces on screen at most, all bursts together (17 §3 [제안] 48). */
export const CONFETTI_MAX = 48;
/** Seconds over which a burst's pieces pop (so they do not move as one block); all land by 19 s. */
const POP_S = 2.4;
const GRAVITY = 9.8;

/** The town's own colours: the lamps' red, yellow, green, the sky blue, the plates' cream, a rose. */
export const CONFETTI_COLORS: readonly (readonly [number, number, number])[] = [
	[0xe0, 0x4a, 0x3c],
	[0xf0, 0xb0, 0x30],
	[0x4c, 0xd0, 0x6a],
	[0x5a, 0x9b, 0xe0],
	[0xf4, 0xef, 0xe0],
	[0xd8, 0x6a, 0xb0],
];
/** A piece turns as it falls: a 3 × 3 square, then 3 × 1 edge-on. */
export const CONFETTI_SHAPES = 2;
/** The flag waves in this many frames. */
export const FLAG_PHASES = 2;
/** Every frame this module can make. */
export const DONE_FRAME_MAX =
	CONFETTI_COLORS.length * CONFETTI_SHAPES + FLAG_PHASES;

export interface RoofSpot {
	/** The roof's front edge, at the middle of the frontage. */
	x: number;
	z: number;
	/** The roof's height. */
	y: number;
	/** Outward normal (away from the road) and the clockwise tangent along the frontage. */
	nx: number;
	nz: number;
	tx: number;
	tz: number;
}

/** How much of the fixed pixel size the flag takes (sprites.mjs lockedScale 0..1; 0 = world size). */
export const FLAG_LOCK = 0.35;
/** The facade's parapet: 0.25 thick just behind the front edge, 0.5–0.75 tall (facade-gen.mjs TRIM). */
const PARAPET_MID = 0.125;
const PARAPET_TOP = 0.5;

/**
 * Where a lot's flag stands and its confetti pops: on the front parapet, at the middle of the frontage
 * (seen from the street over the facade). The lot's door is on the pavement edge at its angle (ring-layout LOTS: the
 * frontage runs along the tangent, the building lies out along the normal); `h` is the lot's height.
 */
export function roofSpot(lot: {
	theta: number;
	doorX: number;
	doorZ: number;
	h: number;
}): RoofSpot {
	const n = ellipseNormal(lot.theta);
	const t = ellipseTangent(lot.theta);
	return {
		x: lot.doorX + n.x * PARAPET_MID,
		z: lot.doorZ + n.z * PARAPET_MID,
		y: lot.h + PARAPET_TOP,
		nx: n.x,
		nz: n.z,
		tx: t.x,
		tz: t.z,
	};
}

export interface Piece {
	x: number;
	y: number;
	z: number;
	color: number;
	shape: number;
}

const unit = (seed: number, k: number): number =>
	(hash32(`${seed}:${k}`) % 10_000) / 10_000;

/**
 * One burst's pieces `t` seconds after it began (`n` pieces, seeded): they pop up off the roof, drift out
 * over the road, then flutter down at their own pace; a piece is gone once it reaches the street, and
 * all of them by BURST_S. Deterministic (a reload mid-burst draws the same positions).
 */
export function burstPieces(
	spot: RoofSpot,
	seed: number,
	t: number,
	n: number,
): Piece[] {
	const out: Piece[] = [];
	if (!(t >= 0) || t >= BURST_S) return out;
	for (let i = 0; i < n; i += 1) {
		const pop = (i / Math.max(1, n)) * POP_S;
		const tau = t - pop;
		if (tau < 0) continue;
		const along = (unit(seed, i * 7) - 0.5) * 9; // across the frontage
		const up = 3 + unit(seed, i * 7 + 1) * 3; // u/s
		const out_ = 0.8 + unit(seed, i * 7 + 2) * 2.2; // toward the road
		const side = (unit(seed, i * 7 + 3) - 0.5) * 2.4;
		const sway = 0.25 + unit(seed, i * 7 + 5) * 0.35;
		const freq = 2 + unit(seed, i * 7 + 6) * 2.5; // rad/s
		// rise against gravity to its peak, then flutter down at a steady pace that lands it between 13.5
		// and 19 s after the burst began (all down before BURST_S: nothing vanishes in mid-air)
		const peakT = up / GRAVITY;
		const peakY = spot.y + 0.3 + (up * up) / (2 * GRAVITY);
		const landTau = 13.5 + unit(seed, i * 7 + 4) * 5.5 - pop;
		const fall = peakY / Math.max(1, landTau - peakT);
		const y =
			tau < peakT
				? spot.y + 0.3 + up * tau - 0.5 * GRAVITY * tau * tau
				: peakY - fall * (tau - peakT);
		if (y <= 0.05) continue;
		// the push out and to the side dies away (drag), a sway along the frontage stays
		const drift = (1 - Math.exp(-1.1 * tau)) / 1.1;
		const s = Math.sin(freq * tau + i) * sway * Math.min(1, tau);
		const o = -out_ * drift; // −n is toward the road
		const a = along + side * drift + s;
		out.push({
			x: spot.x + spot.nx * o + spot.tx * a,
			y,
			z: spot.z + spot.nz * o + spot.tz * a,
			color: i % CONFETTI_COLORS.length,
			shape: Math.floor(tau * 5 + i) % CONFETTI_SHAPES,
		});
	}
	return out;
}

/** Pieces per burst, fixed (a burst's pieces never change with what else flies): two fit CONFETTI_MAX. */
export const PIECES_PER_BURST = CONFETTI_MAX / 2;
/** Bursts flying at once. */
export const BURSTS_AT_ONCE = CONFETTI_MAX / PIECES_PER_BURST;

/**
 * All bursts' pieces at `nowMs`, at most CONFETTI_MAX. Each burst has its own fixed pieces and timeline;
 * whether it flies is decided once, by its start: a burst that begins while BURSTS_AT_ONCE earlier ones
 * are still flying does not fly at all (so no piece ever appears or vanishes mid-air because another
 * burst began or ended).
 */
export function confettiAt(
	bursts: readonly { spot: RoofSpot; at: number; seed: number }[],
	nowMs: number,
): Piece[] {
	const span = BURST_S * 1000;
	const sorted = [...bursts]
		.filter((b) => Number.isFinite(b.at))
		.sort((a, b) => a.at - b.at || a.seed - b.seed);
	const flying: typeof sorted = [];
	for (const b of sorted) {
		const busy = flying.filter((f) => b.at - f.at < span).length;
		if (busy < BURSTS_AT_ONCE) flying.push(b);
	}
	return flying
		.filter((b) => nowMs - b.at >= 0 && nowMs - b.at < span)
		.flatMap((b) =>
			burstPieces(b.spot, b.seed, (nowMs - b.at) / 1000, PIECES_PER_BURST),
		)
		.slice(0, CONFETTI_MAX);
}

// ── pixels ─────────────────────────────────────────────────────────────────────────────────────────

export interface FlagSprite {
	kind: "flag";
	phase: number;
}
export interface ConfettiSprite {
	kind: "confetti";
	color: number;
	shape: number;
}
export type DoneSprite = FlagSprite | ConfettiSprite;

export const doneKey = (s: DoneSprite): string =>
	s.kind === "flag" ? `done|flag|${s.phase}` : `done|bit|${s.color}|${s.shape}`;

const POLE = [0x3a, 0x30, 0x2a] as const;
const POLE_LIT = [0xd8, 0xcf, 0xbf] as const;
const KNOB = [0xf0, 0xb0, 0x30] as const;
const CLOTH = [0x4c, 0xd0, 0x6a] as const;
const CLOTH_DARK = [0x2f, 0x8f, 0x45] as const;
const OUTLINE = [0x1b, 0x15, 0x12] as const;
/** Flag cell: the pole's foot is the cell's bottom middle (the actor's x, y, z). */
export const POLE_H = 26;
export const CLOTH_W = 13;
export const CLOTH_H = 9;

/** The flag as a 32 × 40 RGBA cell (row 0 at the top): a pole with a gold knob and a green pennant. */
export function flagCell(phase: number): Uint8Array {
	const out = new Uint8Array(CELL_W * CELL_H * 4);
	const set = (x: number, y: number, c: readonly number[]) => {
		if (x < 0 || y < 0 || x >= CELL_W || y >= CELL_H) return;
		const i = (y * CELL_W + x) * 4;
		out[i] = c[0] ?? 0;
		out[i + 1] = c[1] ?? 0;
		out[i + 2] = c[2] ?? 0;
		out[i + 3] = 255;
	};
	const px = CELL_W / 2 - 1; // the pole: two columns, lit on the left
	const top = CELL_H - POLE_H;
	for (let y = top; y < CELL_H; y += 1) {
		set(px, y, POLE_LIT);
		set(px + 1, y, POLE);
	}
	set(px, top - 1, KNOB);
	set(px + 1, top - 1, KNOB);
	set(px, top - 2, KNOB);
	set(px + 1, top - 2, KNOB);
	// the pennant: a triangle to the right of the pole, its rows shifted by a wave
	const y0 = top + 1;
	for (let r = 0; r < CLOTH_H; r += 1) {
		const half = (CLOTH_H - 1) / 2;
		const len = Math.round(CLOTH_W * (1 - Math.abs(r - half) / (half + 1)));
		const wave = phase % 2 === 0 ? (r < half ? 0 : 1) : r > half ? 0 : 1;
		const y = y0 + r;
		for (let k = 0; k < len; k += 1) {
			const x = px + 2 + k;
			const ripple = (k + phase) % 4 === 0;
			const edge = r === 0 || r === CLOTH_H - 1 || k === len - 1;
			set(
				x,
				y + (ripple ? wave : 0),
				edge ? OUTLINE : ripple ? CLOTH_DARK : CLOTH,
			);
		}
	}
	return out;
}

/** A confetti piece as a 32 × 40 cell: 3 × 3 or 3 × 1 pixels at the middle (drawn at fixed pixel size). */
export function confettiCell(color: number, shape: number): Uint8Array {
	const out = new Uint8Array(CELL_W * CELL_H * 4);
	const c =
		CONFETTI_COLORS[color % CONFETTI_COLORS.length] ?? CONFETTI_COLORS[0];
	const cx = CELL_W / 2;
	const cy = CELL_H / 2;
	// shape 0: a 3 × 3 square face-on; shape 1: edge-on, a 3 × 1 strip
	const cells: [number, number][] = [];
	for (let dy = shape === 0 ? -1 : 0; dy <= (shape === 0 ? 1 : 0); dy += 1)
		for (let dx = -1; dx <= 1; dx += 1) cells.push([cx + dx, cy + dy]);
	for (const [x, y] of cells) {
		const i = ((y ?? 0) * CELL_W + (x ?? 0)) * 4;
		out[i] = c?.[0] ?? 0;
		out[i + 1] = c?.[1] ?? 0;
		out[i + 2] = c?.[2] ?? 0;
		out[i + 3] = 255;
	}
	return out;
}

// ── frames (GPU) ───────────────────────────────────────────────────────────────────────────────────

export interface DoneFrames {
	/** createActorLayer's frameFor: a frame for a flag or confetti actor (its `sprite`), made once per key. */
	frameFor(a: Actor): unknown;
	/** Releases the confetti frames (called when no burst is flying; made again on the next one). */
	releaseConfetti(): void;
	readonly size: number;
	dispose(): void;
}

export function createDoneFrames(): DoneFrames {
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
			const s = a.sprite as DoneSprite | undefined;
			if (!s || (s.kind !== "flag" && s.kind !== "confetti")) return null;
			const key = doneKey(s);
			let f = cache.get(key);
			if (!f) {
				f =
					s.kind === "flag"
						? make(flagCell(s.phase), 0)
						: make(confettiCell(s.color, s.shape), 0.5);
				cache.set(key, f);
			}
			return f;
		},
		releaseConfetti() {
			for (const [k, f] of cache)
				if (k.startsWith("done|bit|")) {
					f.texture.dispose();
					cache.delete(k);
				}
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
