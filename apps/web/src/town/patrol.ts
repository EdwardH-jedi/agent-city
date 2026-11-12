// The kangaroo's patrol (design doc 12 §5, 16 A2): clockwise from the original spawn (θ = 90°, the south
// end) — a quarter through the plaza past the pylon, then the boulevard's centre line — one lap in four
// minutes. Pure: the pose is a function of patrol
// time only, so there is no simulation, no input and nothing to drift. Replaces the original's
// keyboard-driven ring-world.mjs (not ported, PROVENANCE.md); worldToView / facingFrom / frameIndexFor
// are re-implemented here from ring-world.mjs and town-roo-controls-m2.js.
import { arcTable, offsetPoint, SPAWN } from "./engine/ring-layout.mjs";
import type { RooAction, RooDirection } from "./engine/town-roo-art-m2.mjs";

export const LAP_S = 240;
/** World units per walk cycle (town-roo-controls-m2.js WALK_STRIDE). */
export const WALK_STRIDE = 1.6;
/** Seconds per idle cycle (town-roo-controls-m2.js IDLE_PERIOD). */
export const IDLE_PERIOD = 2.4;

// ── the route (design doc 16 A2) ───────────────────────────────────────────────
// One lap crosses a quarter of the plaza so the pylon's title and numbers are in view every lap: from the
// spawn (θ = 90°) clockwise along the boulevard's centre line to θ = 180°, in along the west footpath, a
// quarter round the pylon on a circle of PLAZA_LOOP_R (between the plaza benches at 6 and the plaza lamps at
// 7.5), out along the north footpath to θ = 270°, and the boulevard again back to the spawn. The quarter it
// cuts holds the HQ and the cafe — never a project lot, so every building is still driven past (the
// kangaroo walks to the HQ for every 결재 anyway). The camera is the original orbit rig, which has its own
// plaza mode (the original guide could walk there): nothing in the engine changes. The lap is ~4 % longer
// than the centre line; LAP_S stays 240 s and the patrol walks that much faster.

const CENTRE = arcTable(0);
/** Radius of the quarter circle round the pylon. */
export const PLAZA_LOOP_R = 7;
/** Where the route leaves the boulevard (the west footpath) and comes back (the north footpath). */
export const ENTRY_THETA = Math.PI;
export const EXIT_THETA = (3 * Math.PI) / 2;

export interface RoutePoint {
	x: number;
	z: number;
}
const ringPoints = (from: number, to: number, out: RoutePoint[]) => {
	const s0 = CENTRE.lenAt(from);
	const len =
		(((CENTRE.lenAt(to) - s0) % CENTRE.length) + CENTRE.length) % CENTRE.length;
	const n = Math.max(1, Math.ceil(len / 0.5));
	for (let i = 0; i < n; i += 1)
		out.push(offsetPoint(CENTRE.at(s0 + (len * i) / n), 0));
};
const ROUTE: RoutePoint[] = (() => {
	const pts: RoutePoint[] = [];
	const entry = offsetPoint(ENTRY_THETA, 0);
	const exit = offsetPoint(EXIT_THETA, 0);
	const R = PLAZA_LOOP_R;
	ringPoints(SPAWN.theta, ENTRY_THETA, pts);
	// in: the centre line → radius R, along the footpath
	const er = Math.hypot(entry.x, entry.z);
	for (let r = er; r > R; r -= 0.5)
		pts.push({ x: (entry.x / er) * r, z: (entry.z / er) * r });
	// a quarter round the pylon, clockwise (as the patrol walks)
	const a0 = Math.atan2(entry.z, entry.x);
	const a1 = Math.atan2(exit.z, exit.x);
	const da = (((a1 - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
	const arcN = Math.ceil((R * da) / 0.5);
	for (let i = 0; i < arcN; i += 1) {
		const a = a0 + (da * i) / arcN;
		pts.push({ x: R * Math.cos(a), z: R * Math.sin(a) });
	}
	// out: radius R → the centre line, along the other footpath
	const xr = Math.hypot(exit.x, exit.z);
	for (let r = R; r < xr; r += 0.5)
		pts.push({ x: (exit.x / xr) * r, z: (exit.z / xr) * r });
	ringPoints(EXIT_THETA, SPAWN.theta, pts);
	pts.push(offsetPoint(SPAWN.theta, 0));
	return pts;
})();
const CUM: number[] = (() => {
	const c = [0];
	for (let i = 1; i < ROUTE.length; i += 1) {
		const a = ROUTE[i - 1] as RoutePoint;
		const b = ROUTE[i] as RoutePoint;
		c.push((c[i - 1] ?? 0) + Math.hypot(b.x - a.x, b.z - a.z));
	}
	return c;
})();
const sOfPoint = (p: RoutePoint): number => {
	let best = 0;
	let bd = Number.POSITIVE_INFINITY;
	ROUTE.forEach((q, i) => {
		const d = Math.hypot(q.x - p.x, q.z - p.z);
		if (d < bd - 1e-9) {
			bd = d;
			best = i;
		}
	});
	return CUM[best] ?? 0;
};
/** Where the plaza stretch begins and ends on the route (the footpaths meet the centre line). */
export const PLAZA_START_S = sOfPoint(offsetPoint(ENTRY_THETA, 0));
export const PLAZA_END_S = sOfPoint(offsetPoint(EXIT_THETA, 0));
/** One lap of the route (world units). */
export const ROUTE_LENGTH = CUM[CUM.length - 1] ?? 0;
/** The centre line's length (the lap before the plaza stretch, for comparison). */
export const CENTRE_LENGTH = CENTRE.length;
/** Units per second: one lap of the route in LAP_S (≈ 0.64, above the orbit rig's 0.5 dead zone). */
export const PATROL_SPEED = ROUTE_LENGTH / LAP_S;

/** The point and direction at distance s along the route (wrapping). */
export function routeAt(s: number): {
	x: number;
	z: number;
	dir: [number, number];
	s: number;
} {
	const q = ((s % ROUTE_LENGTH) + ROUTE_LENGTH) % ROUTE_LENGTH;
	let lo = 0;
	let hi = CUM.length - 1;
	while (hi - lo > 1) {
		const m = (lo + hi) >> 1;
		if ((CUM[m] ?? 0) <= q) lo = m;
		else hi = m;
	}
	const a = ROUTE[lo] as RoutePoint;
	const b = ROUTE[hi] as RoutePoint;
	const seg = (CUM[hi] ?? 0) - (CUM[lo] ?? 0);
	const f = seg > 1e-9 ? (q - (CUM[lo] ?? 0)) / seg : 0;
	const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
	return {
		x: a.x + (b.x - a.x) * f,
		z: a.z + (b.z - a.z) * f,
		dir: [(b.x - a.x) / l, (b.z - a.z) / l],
		s: q,
	};
}

/** The route's points from distance s0 to s1 (s0 ≤ s1, no wrap), ends included. */
export function routeSlice(s0: number, s1: number): RoutePoint[] {
	const out: RoutePoint[] = [routeAt(s0)];
	for (let i = 0; i < ROUTE.length; i += 1) {
		const c = CUM[i] ?? 0;
		if (c > s0 && c < s1) out.push(ROUTE[i] as RoutePoint);
	}
	const end = routeAt(Math.min(s1, ROUTE_LENGTH - 1e-9));
	out.push({ x: end.x, z: end.z });
	return out.map((p) => ({ x: p.x, z: p.z }));
}

/** The route point nearest (x, z): its distance along the route. */
export function routeNearest(x: number, z: number): number {
	let best = 0;
	let bd = Number.POSITIVE_INFINITY;
	for (let i = 1; i < ROUTE.length; i += 1) {
		const a = ROUTE[i - 1] as RoutePoint;
		const b = ROUTE[i] as RoutePoint;
		const dx = b.x - a.x;
		const dz = b.z - a.z;
		const l2 = dx * dx + dz * dz || 1;
		const f = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2));
		const px = a.x + dx * f;
		const pz = a.z + dz * f;
		const d = (px - x) ** 2 + (pz - z) ** 2;
		if (d < bd) {
			bd = d;
			best = (CUM[i - 1] ?? 0) + f * Math.sqrt(l2);
		}
	}
	return best;
}

export interface PatrolPose {
	x: number;
	z: number;
	/** Unit world direction of travel. */
	dir: [number, number];
	/** Distance walked since the patrol began (drives the stride). */
	walked: number;
	/** Where on the route (0 ≤ s < ROUTE_LENGTH). */
	s: number;
}

/** Where the kangaroo is after `t` seconds of patrol (t = 0 is the original spawn). */
export function patrolPose(t: number): PatrolPose {
	const walked = Math.max(0, t) * PATROL_SPEED;
	const p = routeAt(walked);
	return { x: p.x, z: p.z, dir: p.dir, walked, s: p.s };
}

/** Patrol time (seconds, 0 ≤ t < LAP_S) at which the patrol is at distance s along the route. */
export function patrolTimeAtS(s: number): number {
	const q = ((s % ROUTE_LENGTH) + ROUTE_LENGTH) % ROUTE_LENGTH;
	return q / PATROL_SPEED;
}

/** Whether the centre-line point at θ is on the route (not in the quarter the plaza stretch cuts). */
export function onRouteRing(theta: number): boolean {
	const d =
		(((CENTRE.lenAt(theta) - CENTRE.lenAt(ENTRY_THETA)) % CENTRE.length) +
			CENTRE.length) %
		CENTRE.length;
	const cut =
		(((CENTRE.lenAt(EXIT_THETA) - CENTRE.lenAt(ENTRY_THETA)) % CENTRE.length) +
			CENTRE.length) %
		CENTRE.length;
	return d <= 1e-6 || d >= cut - 1e-6;
}

/** World → camera frame (right, down-screen); yaw in radians, camera-rig convention (ring-world.mjs). */
export function worldToView(
	wx: number,
	wz: number,
	yaw: number,
): [number, number] {
	const c = Math.cos(yaw);
	const s = Math.sin(yaw);
	return [wx * c + wz * s, -wx * s + wz * c];
}

/** Screen facing of a step (ring-world.mjs facingFrom): near a diagonal the current facing holds. */
export function facingFrom(
	dx: number,
	dz: number,
	cur: RooDirection | null,
): RooDirection | null {
	const ax = Math.abs(dx);
	const az = Math.abs(dz);
	if (ax < 1e-6 && az < 1e-6) return cur;
	const hx: RooDirection = dx > 0 ? "east" : "west";
	const hz: RooDirection = dz > 0 ? "south" : "north";
	if (
		ax > 1e-6 &&
		az > 1e-6 &&
		Math.abs(ax - az) < 0.3 * Math.max(ax, az) &&
		(cur === hx || cur === hz)
	)
		return cur;
	return ax > az ? hx : hz;
}

const frac = (v: number) => {
	const f = v - Math.floor(v);
	return f >= 1 ? 0 : f;
};

/** town-roo-controls-m2.js frameIndexFor: phase 0..1 → frame index of n. */
export function frameIndexFor(phase: number, n: number): number {
	const k = Math.floor(n);
	if (!(k >= 1) || !Number.isFinite(phase)) return 0;
	const i = Math.floor(frac(phase) * k);
	return i >= k ? k - 1 : i;
}

/** Animation phase: the stride while walking (feet never slide), the idle cycle while standing. */
export function rooPhase(
	action: RooAction,
	walked: number,
	idleS: number,
): number {
	return action === "walk" ? walked / WALK_STRIDE : idleS / IDLE_PERIOD;
}

export const rooKey = (
	facing: RooDirection,
	action: RooAction,
	frame: number,
) => `roo|${facing}|${action}|${frame}`;
