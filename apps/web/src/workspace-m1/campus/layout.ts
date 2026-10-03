// Campus site plan (pure; no three, no DOM). One office building per repository, keyed by repo id:
// the same set of ids always yields the same plan, whatever order the server lists them in.
// Headquarters sits north on the main axis; repository buildings stand in rows south of it, in
// mirrored pairs either side of the axis (the axis stays clear so every walk to HQ has a lane).
// Units are roughly metres, as in the handover prototype (repo 16×11×3.6, HQ 22×14×4.2).
import { ACCENTS } from "./palette.ts";

export const REPO_BOX = { w: 16, d: 11, h: 3.6 } as const;
export const HQ_BOX = { x: 0, z: -17, w: 22, d: 14, h: 4.2 } as const;
export const ROW_STEP = 20;
/** Floor height of every building (plinth top). */
export const FLOOR = 0.2;

export interface Slot {
	repo_id: string;
	/** Position in the sorted id list (also picks the accent). */
	index: number;
	row: number;
	x: number;
	z: number;
	accent: string;
}

export interface CampusLayout {
	/** Identity of the plan: the sorted, de-duplicated repo ids. */
	key: string;
	slots: Slot[];
	cols: number;
	rows: number;
	/** z of the promenade in front of each row. */
	promenades: number[];
	bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export function columnsFor(n: number): number {
	if (n <= 4) return 2;
	if (n <= 12) return 4;
	return 6;
}

/** x of each slot in a row: inner-left, inner-right, then outwards. Never on the axis (x = 0). */
function rowXs(cols: number): number[] {
	const xs: number[] = [];
	const spacing = cols === 2 ? 42 : 22;
	for (let k = 0; k < cols / 2; k += 1) {
		const x = spacing / 2 + k * spacing;
		xs.push(-x, x);
	}
	return xs;
}

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function campusLayout(repoIds: readonly string[]): CampusLayout {
	const ids = [...new Set(repoIds)].sort(byCodePoint);
	const cols = columnsFor(ids.length);
	const xs = rowXs(cols);
	const slots: Slot[] = ids.map((repo_id, index) => {
		const row = Math.floor(index / cols);
		const col = index % cols;
		// a lone building sits closer to the axis so the composition stays balanced
		const x = ids.length === 1 ? -13 : (xs[col] ?? 0);
		return {
			repo_id,
			index,
			row,
			x,
			z: row * ROW_STEP,
			accent: ACCENTS[index % ACCENTS.length] ?? ACCENTS[0],
		};
	});
	const rows = Math.max(1, Math.ceil(ids.length / cols));
	const promenades = Array.from(
		{ length: rows },
		(_, r) => r * ROW_STEP + REPO_BOX.d / 2 + 3.5,
	);
	let minX = HQ_BOX.x - HQ_BOX.w / 2 - 14;
	let maxX = HQ_BOX.x + HQ_BOX.w / 2 + 6;
	for (const s of slots) {
		minX = Math.min(minX, s.x - REPO_BOX.w / 2);
		maxX = Math.max(maxX, s.x + REPO_BOX.w / 2 + 2);
	}
	const lastProm = promenades[promenades.length - 1] ?? 9;
	return {
		key: ids.join("\n"),
		slots,
		cols,
		rows,
		promenades,
		bounds: {
			minX,
			maxX,
			minZ: HQ_BOX.z - HQ_BOX.d / 2,
			maxZ: lastProm + 2,
		},
	};
}

export function slotOf(layout: CampusLayout, repoId: string): Slot | null {
	return layout.slots.find((s) => s.repo_id === repoId) ?? null;
}

// ── walking routes (CEO document delivery) ─────────────────────────────────

export type P2 = readonly [number, number];

/** Where an arrived visitor waits in the HQ lobby (stable per seat index). */
export function lobbySpot(seat: number): {
	x: number;
	z: number;
	yaw: number;
	sit: boolean;
} {
	const hx = HQ_BOX.x;
	const hz = HQ_BOX.z;
	if (seat < 5)
		return {
			x: hx - 9.7,
			z: hz - 0.6 + seat * 1.25,
			yaw: Math.PI / 2,
			sit: true,
		};
	if (seat < 10)
		return {
			x: hx - 7.9,
			z: hz - 0.6 + (seat - 5) * 1.25,
			yaw: Math.PI / 2,
			sit: false,
		};
	const k = seat - 10;
	return {
		x: hx - 2.4 - (k % 4) * 1.0,
		z: hz + 2.2 + Math.floor(k / 4) * 1.0,
		yaw: -Math.PI / 2,
		sit: false,
	};
}

/** In front of Edward's desk (the visitor whose document is open stands here). */
export const DESK_SPOT = {
	x: HQ_BOX.x + 6.5,
	z: HQ_BOX.z - 2.75,
	yaw: Math.PI,
} as const;

/** The CEO's chair in a repository building (building-local offsets from the prototype). */
export function officeSeat(slot: Pick<Slot, "x" | "z">): P2 {
	return [slot.x + 5.8, slot.z - 4.62];
}

/**
 * Route of one visit: CEO office → office door → aisle → building door → promenade → main axis
 * → HQ door → lobby → waiting spot. Unknown repository: from the campus entrance on the axis.
 * `lane` shifts the shared stretch a little so simultaneous walkers never overlap exactly.
 */
export function ceoRoute(
	layout: CampusLayout,
	repoId: string,
	seat: number,
): P2[] {
	const lane = ((seat % 3) - 1) * 0.55;
	const hx = HQ_BOX.x;
	const hz = HQ_BOX.z;
	const spot = lobbySpot(seat);
	const tail: P2[] = [
		[hx + lane, hz + HQ_BOX.d / 2 + 1.6],
		[hx + lane * 0.5, hz + 6],
		[hx, hz + 1.6],
		[hx - 6.5, hz + 1.6 + lane],
		[spot.x + (spot.sit ? 1.0 : 0.6), spot.z],
		[spot.x, spot.z],
	];
	const slot = slotOf(layout, repoId);
	if (!slot) {
		const south = layout.bounds.maxZ + 4;
		return [[hx + lane, south], ...tail];
	}
	const prom = (layout.promenades[slot.row] ?? 9) + lane;
	const { x, z } = slot;
	return [
		officeSeat(slot),
		[x + 6.95, z - 4.62],
		[x + 6.6, z - 2.6],
		[x + 6.25, z - 0.9],
		[x + 4.7, z + 3.0],
		[x + 4.7, z + 4.9],
		[x + 4.7, z + 7.0],
		[x + 4.7, prom],
		[hx + lane, prom],
		...tail,
	];
}

export function routeLength(pts: readonly P2[]): number {
	let len = 0;
	for (let i = 1; i < pts.length; i += 1) {
		const a = pts[i - 1];
		const b = pts[i];
		if (a && b) len += Math.hypot(b[0] - a[0], b[1] - a[1]);
	}
	return len;
}

/** Point at fraction `t` of the route's length, with the heading of that segment. */
export function sampleRoute(
	pts: readonly P2[],
	t: number,
): { x: number; z: number; yaw: number; distance: number } {
	const first = pts[0] ?? [0, 0];
	if (pts.length < 2) return { x: first[0], z: first[1], yaw: 0, distance: 0 };
	const total = routeLength(pts);
	const want = Math.min(1, Math.max(0, t)) * total;
	let acc = 0;
	for (let i = 1; i < pts.length; i += 1) {
		const a = pts[i - 1] ?? first;
		const b = pts[i] ?? first;
		const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
		if (seg > 0 && (acc + seg >= want || i === pts.length - 1)) {
			const k = Math.min(1, Math.max(0, (want - acc) / seg));
			return {
				x: a[0] + (b[0] - a[0]) * k,
				z: a[1] + (b[1] - a[1]) * k,
				yaw: Math.atan2(b[0] - a[0], b[1] - a[1]),
				distance: want,
			};
		}
		acc += seg;
	}
	const last = pts[pts.length - 1] ?? first;
	return { x: last[0], z: last[1], yaw: 0, distance: total };
}
