import type { RooDirection } from "../../engine/town-roo-art-m2.mjs";

export interface Point {
	x: number;
	z: number;
}
export interface Slot extends Point {
	pose: "sit" | "stand";
	facing: RooDirection;
}
export interface Rect extends Point {
	y: number;
	w: number;
	h: number;
}
export interface Colors {
	top: string;
	front: string;
	side: string;
	edge: string;
}
export interface RoomItem extends Point {
	id: string;
	kind: string;
	w: number;
	d: number;
	h: number;
	y?: number;
	colors?: Colors;
	facing?: string;
	render?: "box" | "billboard";
	collide?: boolean;
	parent?: string;
	mount?: "wall-north" | "surface";
}
/** The original scene-interior's data, without TownWorld, collision or game state. */
export interface RoomData {
	id: string;
	title: string;
	width: number;
	depth: number;
	floorStyle?: string;
	exit: Point;
	obstacles: RoomItem[];
	furniture: RoomItem[];
	decorations: RoomItem[];
	floorPalette: string[];
	background: {
		wall: { palette: string[]; wainscot: { height: number; color: string } };
	};
	doors: { frame: { color: string } }[];
}
/** One theme is data for the common, original room painter. Units remain 16 texels. */
export interface InteriorTheme {
	id: string;
	match: readonly string[];
	entry: "door" | "faregate";
	entrance: Point;
	gate: Point;
	slots: readonly Slot[];
	waitSlots: readonly Slot[];
	statusBoard: Rect;
	entryLamp: readonly (Point & { y: number })[];
	gateBars?: readonly string[];
	clock?: Rect;
	signs?: readonly (Rect & { text: string })[];
	boardColors?: { background: number; ink: number; frame: number };
	room: RoomData;
}

export const WOOD: Colors = {
	top: "#a88760",
	front: "#785940",
	side: "#5b4435",
	edge: "#352d29",
};
export const TEAL: Colors = {
	top: "#72958c",
	front: "#516f68",
	side: "#3b5550",
	edge: "#243c39",
};
export const METAL: Colors = {
	top: "#a3b2b1",
	front: "#788c8f",
	side: "#53686e",
	edge: "#2a3d46",
};
export const box = (
	id: string,
	kind: string,
	x: number,
	z: number,
	w: number,
	d: number,
	h: number,
	colors = WOOD,
	y = 0,
): RoomItem => ({
	id,
	kind,
	x,
	z,
	w,
	d,
	h,
	colors,
	y,
	facing: "south",
	render: "box",
});
export const slot = (
	x: number,
	z: number,
	pose: Slot["pose"] = "stand",
	facing: RooDirection = "south",
): Slot => ({ x, z, pose, facing });
