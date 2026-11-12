// Hand-written declarations for the ported engine (agent-city; see PROVENANCE.md). Only the pure model and
// drawing functions: the DOM section of minimap.mjs (hover, click, keys, a Focus button) is never used by
// the screen, and scripts/no-run-actions.test.ts keeps it that way.
export interface MapLot {
	readonly id: string;
	readonly label: string;
	readonly corners: readonly (readonly [number, number])[];
	readonly lampAt: readonly [number, number];
	readonly labelAt: readonly [number, number];
}
export interface RingMapModel {
	readonly kind: "ring";
	readonly key: string;
	readonly bounds: { x0: number; x1: number; z0: number; z1: number };
	readonly lots: readonly MapLot[];
}
export interface MapTransform {
	readonly s: number;
	readonly width: number;
	readonly height: number;
	readonly mapHeight: number;
	toPx(x: number, z: number): [number, number];
	toWorld(px: number, py: number): [number, number];
}
export declare function ringModel(): RingMapModel;
export declare function fitTransform(
	bounds: RingMapModel["bounds"],
	width: number,
	pad?: number,
	maxHeight?: number,
	cue?: boolean,
): MapTransform;
export declare function drawBase(
	ctx: CanvasRenderingContext2D,
	model: RingMapModel,
	T: MapTransform,
): void;
export declare function guideTriangle(
	T: MapTransform,
	x: number,
	z: number,
	yawDeg: number,
	size?: number,
): [[number, number], [number, number], [number, number]];
