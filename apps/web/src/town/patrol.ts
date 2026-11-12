// The kangaroo's patrol (design doc 12 §5): clockwise along the boulevard's centre line from the original
// spawn (θ = 90°, the south end), one lap in about four minutes. Pure: the pose is a function of patrol
// time only, so there is no simulation, no input and nothing to drift. Replaces the original's
// keyboard-driven ring-world.mjs (not ported, PROVENANCE.md); worldToView / facingFrom / frameIndexFor
// are re-implemented here from ring-world.mjs and town-roo-controls-m2.js.
import {
	arcTable,
	ellipseTangent,
	offsetPoint,
	SPAWN,
} from "./engine/ring-layout.mjs";
import type { RooAction, RooDirection } from "./engine/town-roo-art-m2.mjs";

export const LAP_S = 240;
/** World units per walk cycle (town-roo-controls-m2.js WALK_STRIDE). */
export const WALK_STRIDE = 1.6;
/** Seconds per idle cycle (town-roo-controls-m2.js IDLE_PERIOD). */
export const IDLE_PERIOD = 2.4;

const CENTRE = arcTable(0);
const START_S = CENTRE.lenAt(SPAWN.theta);
/** Units per second: one lap of the centre line in LAP_S (≈ 0.6, above the orbit rig's 0.5 dead zone). */
export const PATROL_SPEED = CENTRE.length / LAP_S;

export interface PatrolPose {
	x: number;
	z: number;
	/** Unit world direction of travel (clockwise tangent). */
	dir: [number, number];
	/** Distance walked since the patrol began (drives the stride). */
	walked: number;
}

/** Where the kangaroo is after `t` seconds of patrol (t = 0 is the original spawn). */
export function patrolPose(t: number): PatrolPose {
	const walked = Math.max(0, t) * PATROL_SPEED;
	const theta = CENTRE.at(START_S + walked);
	const p = offsetPoint(theta, 0);
	const tan = ellipseTangent(theta);
	return { x: p.x, z: p.z, dir: [tan.x, tan.z], walked };
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
