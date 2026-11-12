// Hand-written declarations for the ported engine (agent-city; see PROVENANCE.md).
export interface XZ {
	x: number;
	z: number;
}
export declare const A: number;
export declare const B: number;
export declare const ROAD_HALF: number;
export declare const INNER_EDGE: number;
export declare const OUTER_EDGE: number;
export declare const PLAZA_R: number;
export interface RingLot {
	readonly id: string;
	readonly deg: number;
	readonly name: string;
	readonly label: string;
	readonly dept: string | null;
	readonly kind: string;
	readonly family: string;
	readonly wall: string;
	readonly awning: string;
	readonly h: number;
	readonly seed: number;
	readonly sign: string;
	readonly boarded?: boolean;
	readonly index: number;
	readonly theta: number;
	readonly doorX: number;
	readonly doorZ: number;
}
export declare const LOTS: readonly RingLot[];
export declare const SPAWN: {
	readonly x: number;
	readonly z: number;
	readonly theta: number;
	readonly facing: "north" | "east" | "south" | "west";
};
export declare const PYLON: {
	readonly x: number;
	readonly z: number;
	readonly w: number;
	readonly d: number;
	readonly h: number;
};
export declare function ellipsePoint(theta: number): XZ;
export declare function ellipseTangent(theta: number): XZ;
export declare function ellipseNormal(theta: number): XZ;
export declare function offsetPoint(theta: number, d: number): XZ;
export declare function ellipseTheta(x: number, z: number): number;
export declare function ellipseOffset(x: number, z: number): number;
export interface ArcTable {
	readonly length: number;
	/** θ at arc length s from θ = 0 (clockwise), wrapping. */
	at(s: number): number;
	lenAt(theta: number): number;
}
export declare function arcTable(offset: number): ArcTable;
