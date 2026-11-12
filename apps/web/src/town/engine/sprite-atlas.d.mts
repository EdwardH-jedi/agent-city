// Hand-written declarations for the ported engine (agent-city; see PROVENANCE.md).
import type { RooArt } from "./town-roo-art-m2.mjs";
export declare const CELL_W: 32;
export declare const CELL_H: 40;
export interface AtlasFrame {
	readonly key: string;
	readonly u0: number;
	readonly u1: number;
	readonly v0: number;
	readonly v1: number;
	readonly cx: number;
	readonly cy: number;
}
export interface SpriteAtlas {
	readonly width: number;
	readonly height: number;
	readonly data: Uint8Array;
	readonly frames: ReadonlyMap<string, AtlasFrame>;
}
export interface AtlasNpc {
	id: string;
	family: string;
	recolor?: number;
}
export declare function buildSpriteAtlas(opts: {
	rooArt: RooArt;
	art?: unknown;
	npcs?: readonly AtlasNpc[];
}): SpriteAtlas;
export declare const rooKey: (direction: string, action: string, frame: number) => string;
