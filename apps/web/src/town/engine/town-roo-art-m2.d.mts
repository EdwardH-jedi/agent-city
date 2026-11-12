// Hand-written declarations for the ported engine (agent-city; see PROVENANCE.md).
export type RooDirection = "north" | "east" | "south" | "west";
export type RooAction = "idle" | "walk" | "sprint" | "hop" | "interact";
export interface RooArt {
	readonly version: string;
	readonly metrics: {
		readonly directions: readonly RooDirection[];
		readonly actions: readonly RooAction[];
	};
	getFrameCount(req: { direction: RooDirection; action: RooAction }): number;
	getFrame(req: { direction: RooDirection; action: RooAction; frame: number }): {
		readonly w: number;
		readonly h: number;
		readonly rgba: Uint8Array;
		readonly anchorX: number;
		readonly anchorY: number;
	};
}
export declare const TownRooArtM2: RooArt;
