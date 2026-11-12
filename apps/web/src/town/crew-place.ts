// Where the crew stand and how they walk (design doc 16 A1). Pure: no GL, no DOM; the ring's geometry is
// read from the engine (ring-layout.mjs, imported, never edited).
//
// Spots sit on the outer pavement, no nearer the facade than the HQ queue's first spot (choreo.ts
// DOOR_SPOT 3.3: a figure closer to the wall leans back into it in a steep shot) and clear of the curb
// lamps (2.9, ~4 units from a door), the door benches and bins (3.85, at +4.25 / −3.75) and the door
// itself (a lead steps out of it):
//  - a building: CREW_PER_BUILDING spots either side of the door; whoever waits faces the door, whoever
//    works faces the road
//  - the cafe: CREW_AT_CAFE spots in two rows either side of its door, everyone turned to the middle (a
//    group chatting)
//  - a companion: a small figure beside its session, a step toward the road
// A session keeps its spot while it stays at the same lot (assignCrewSlots: sticky, like the lots).
// Walks: from where it stands out to the leads' lane, the shorter way round, in to the new spot (one lot:
// straight across); the length gives the duration (the leads' rule, 4.2 u/s, 7–20 s).
import { LANE, type Path, shorterArc, type XZ } from "./choreo.ts";
import { CREW_AT_CAFE, CREW_PER_BUILDING } from "./crew.ts";
import {
	arcTable,
	doorOf,
	ellipseNormal,
	ellipseTheta,
	LOTS,
	offsetPoint,
} from "./engine/ring-layout.mjs";
import { CAFE_LOT } from "./lots.ts";

/** Building spots: (arc from the door along the pavement, offset from the road's centre line). */
export const BUILDING_SPOTS: readonly (readonly [number, number])[] = [
	[-1.1, 3.25],
	[1.1, 3.25],
	[2.3, 3.05],
];
/** Cafe spots: a back row by the door, a front row toward the road. */
export const CAFE_SPOTS: readonly (readonly [number, number])[] = [
	[-0.8, 3.3],
	[0.8, 3.3],
	[-2.0, 3.3],
	[2.0, 3.3],
	[-1.4, 2.6],
	[1.4, 2.6],
];
/** Where the cafe group looks: the middle of its spots. */
const CAFE_MIDDLE = 3.0;
/** A companion stands this far along (± by its index) and this far toward the road from its session. */
export const COMPANION_ALONG = 0.55;
export const COMPANION_IN = 0.35;

if (
	BUILDING_SPOTS.length < CREW_PER_BUILDING ||
	CAFE_SPOTS.length < CREW_AT_CAFE
)
	throw new Error("crew spots fewer than the caps");

const tabs = new Map<number, ReturnType<typeof arcTable>>();
const tabAt = (offset: number) => {
	let t = tabs.get(offset);
	if (!t) {
		t = arcTable(offset);
		tabs.set(offset, t);
	}
	return t;
};
const thetaOf = (lot: string): number => {
	const l = LOTS.find((x) => x.id === lot);
	if (!l) throw new Error(`no ring lot ${lot}`);
	return l.theta;
};

/** A point `arc` units along the offset curve from a lot's door angle. */
function onPavement(
	lot: string,
	arc: number,
	offset: number,
): XZ & { theta: number } {
	const tab = tabAt(offset);
	const theta = tab.at(tab.lenAt(thetaOf(lot)) + arc);
	return { ...offsetPoint(theta, offset), theta };
}

export interface CrewSpot extends XZ {
	/** World direction it faces when standing. */
	face: [number, number];
}

/** Spot k at a lot. `waiting` (at a building): face the door; else the road (cafe: the group's middle). */
export function crewSpot(lot: string, k: number, waiting: boolean): CrewSpot {
	const cafe = lot === CAFE_LOT;
	const list = cafe ? CAFE_SPOTS : BUILDING_SPOTS;
	const [arc, off] = list[k] ?? list[list.length - 1] ?? [0, 3.2];
	const p = onPavement(lot, arc, off);
	let face: [number, number];
	if (cafe) {
		const m = onPavement(lot, 0, CAFE_MIDDLE);
		const dx = m.x - p.x;
		const dz = m.z - p.z;
		const l = Math.hypot(dx, dz) || 1;
		face = [dx / l, dz / l];
	} else {
		const n = ellipseNormal(p.theta);
		face = waiting ? [n.x, n.z] : [-n.x, -n.z];
	}
	return { x: p.x, z: p.z, face };
}

/** A companion beside a session standing at `at` (index 0 / 1: either side, a step toward the road). */
export function companionSpot(at: XZ, i: number): XZ {
	const n = ellipseNormal(ellipseTheta(at.x, at.z));
	const side = i % 2 === 0 ? 1 : -1;
	// the tangent is the normal turned a quarter (its sign only picks the side)
	return {
		x: at.x - n.z * COMPANION_ALONG * side - n.x * COMPANION_IN,
		z: at.z + n.x * COMPANION_ALONG * side - n.z * COMPANION_IN,
	};
}

/** A lot's door, for a figure that steps out of it. */
export function doorPoint(lot: string): XZ {
	const d = doorOf(lot);
	return { x: d.x, z: d.z };
}

function pathOf(pts: XZ[]): Path {
	const cum = [0];
	for (let i = 1; i < pts.length; i += 1) {
		const a = pts[i - 1] as XZ;
		const b = pts[i] as XZ;
		cum.push((cum[i - 1] ?? 0) + Math.hypot(b.x - a.x, b.z - a.z));
	}
	return { pts, cum, length: cum[cum.length - 1] ?? 0 };
}

const LANE_TAB = arcTable(LANE);

/**
 * A walk from `from` to `to`: straight when they are near (the same lot), else out to the lane, the
 * shorter way round, and in.
 */
export function crewPath(src: XZ, dst: XZ): Path {
	const from = { x: src.x, z: src.z };
	const to = { x: dst.x, z: dst.z };
	if (Math.hypot(to.x - from.x, to.z - from.z) < 6) return pathOf([from, to]);
	const a = ellipseTheta(from.x, from.z);
	const b = ellipseTheta(to.x, to.z);
	const arc = shorterArc(LANE_TAB, a, b);
	const s0 = LANE_TAB.lenAt(a);
	const n = Math.max(1, Math.ceil(Math.abs(arc)));
	const pts: XZ[] = [from];
	for (let i = 0; i <= n; i += 1)
		pts.push(offsetPoint(LANE_TAB.at(s0 + (arc * i) / n), LANE));
	pts.push(to);
	return pathOf(pts);
}

/** Who stands where: lot id and spot index, per crew id. */
export type CrewSlots = ReadonlyMap<string, { lot: string; k: number }>;

/**
 * Sticky spots: a member still at the same lot keeps its spot; the rest (in the given order) take the
 * lowest free one. Members beyond a lot's spots get none (crew.ts caps them first).
 */
export function assignCrewSlots(
	prev: CrewSlots,
	members: readonly { id: string; lot: string }[],
): Map<string, { lot: string; k: number }> {
	const out = new Map<string, { lot: string; k: number }>();
	const used = new Map<string, Set<number>>();
	const usedAt = (lot: string) => {
		let u = used.get(lot);
		if (!u) {
			u = new Set();
			used.set(lot, u);
		}
		return u;
	};
	const cap = (lot: string) =>
		lot === CAFE_LOT ? CAFE_SPOTS.length : BUILDING_SPOTS.length;
	for (const m of members) {
		const p = prev.get(m.id);
		if (p && p.lot === m.lot && p.k < cap(m.lot) && !usedAt(m.lot).has(p.k)) {
			out.set(m.id, p);
			usedAt(m.lot).add(p.k);
		}
	}
	for (const m of members) {
		if (out.has(m.id)) continue;
		const u = usedAt(m.lot);
		let k = 0;
		while (u.has(k)) k += 1;
		if (k >= cap(m.lot)) continue;
		u.add(k);
		out.set(m.id, { lot: m.lot, k });
	}
	return out;
}
