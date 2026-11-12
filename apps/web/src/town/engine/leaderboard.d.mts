// Hand-written declarations for the ported engine (agent-city; see PROVENANCE.md).
import type { Group } from "three";
import type { ScenePreset } from "./presets.mjs";
export interface BoardCounts {
	working: number | null;
	waiting: number | null;
	idle: number | null;
	unknown: number | null;
}
export interface BoardRow extends BoardCounts {
	/** Ring lot id. */
	lot: string;
	label: string;
	/** Places the row on the face that looks toward its lot. */
	deg: number | null;
	lastEvidenceS: number | null;
}
export interface BoardView {
	title: string;
	rows: BoardRow[];
	offline: boolean;
	totals?: BoardCounts;
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
export declare function createLeaderboard(opts?: {
	seed?: number;
	look?: ScenePreset;
	view?: BoardView;
}): Leaderboard;
