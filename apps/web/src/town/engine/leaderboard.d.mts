// Hand-written declarations for the ported engine (agent-city; see PROVENANCE.md).
import type { Group } from "three";
import type { ScenePreset } from "./presets.mjs";
export interface BoardCounts {
	working: number | null;
	waiting: number | null;
	idle: number | null;
	unknown: number | null;
}
/** agent-city: a count left out (undefined) is not drawn at all; null draws "—". */
export interface BoardRow extends Partial<BoardCounts> {
	/** Ring lot id. */
	lot: string;
	label: string;
	/** Places the row on the face that looks toward its lot. */
	deg: number | null;
	/** agent-city: left out → no age column. */
	lastEvidenceS?: number | null;
}
export interface BoardView {
	title: string;
	rows: BoardRow[];
	offline: boolean;
	totals?: Partial<BoardCounts>;
	source?: string;
}
export interface Leaderboard {
	readonly mesh: Group;
	update(view: BoardView | null): number[];
	setLook(look: ScenePreset): number[];
	getDebugState(): {
		time: string | null;
		offline: boolean;
		faces: { deg: number; lots: string[]; paints: number; overflow: unknown }[];
	};
	dispose(): void;
}
export declare const TITLE: string;
export declare const LABEL_MAX_W: number;
export declare function boardText(s: unknown, max: number, maxW: number): string;
/** The leaderboard font has this character (A–Z, 0–9, `-` and a few more). */
export declare function hasGlyph(ch: string): boolean;
export declare function createLeaderboard(opts?: {
	seed?: number;
	look?: ScenePreset;
	view?: BoardView;
}): Leaderboard;
