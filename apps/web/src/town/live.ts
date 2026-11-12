// What the town stage shows right now, for the minimap beside it (both live in the town chunk, so they
// share this one module). Written by stage.ts, read by TownMinimap.tsx on its own slow timer. Nothing
// here acts; it only mirrors what is drawn.
import type { LampState } from "./engine/scene-ring.mjs";

export interface LiveLot {
	/** Ring lot id. */
	id: string;
	/** Three characters for the map ("" for an empty slot). */
	label: string;
	lamp: LampState;
	/** The lamp's colour as CSS (scene-ring LAMP_COLORS), or null when off. */
	color: string | null;
}

export interface TownLive {
	lots: LiveLot[];
	/** Reports stopped: the map shows every lamp grey. */
	offline: boolean;
	/** The kangaroo (null while the owner is away). */
	guide: { x: number; z: number; yaw: number } | null;
}

let current: TownLive | null = null;

export const townLive = {
	get(): TownLive | null {
		return current;
	},
	set(next: TownLive | null): void {
		current = next;
	},
};
