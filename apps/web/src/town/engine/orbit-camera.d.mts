// Hand-written declarations for the ported engine (agent-city; see PROVENANCE.md).
import type { PerspectiveCamera } from "three";
import type { ScenePreset } from "./presets.mjs";
export interface RingLayoutLike {
	A: number;
	B: number;
	OUTER_EDGE?: number;
	ellipseTheta(x: number, z: number): number;
	ellipseOffset(x: number, z: number): number;
}
export interface OrbitRig {
	readonly camera: PerspectiveCamera;
	snapTo(x: number, z: number): void;
	setYaw(deg: number): void;
	snapYaw(deg: number): void;
	update(dtSec: number, x: number, z: number): void;
	/** Writes the camera transform; returns the snapped focus. */
	apply(): [number, number];
	yawFor(x: number | { x: number; z: number }, z?: number): number;
	readonly focus: [number, number];
	readonly yawDeg: number;
	readonly pitchDeg: number;
	readonly mode: "orbit" | "plaza";
	readonly dir: 1 | -1;
}
/** Signed shortest turn from a to b in degrees, in (-180, 180]. */
export declare function turnBetween(a: number, b: number): number;
/** Yaw (degrees, 0 = north / -z) of a ground direction. */
export declare function yawOfDir(dx: number, dz: number): number;
export declare const TURN_RATE_DEG: number;
export declare const TELEPORT_U: number;
export declare function createOrbitRig(
	preset: ScenePreset,
	layout: RingLayoutLike,
	opts?: { snap?: "feet" | "none" | "world" },
): OrbitRig;
