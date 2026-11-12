// Hand-written declarations for the ported engine (agent-city; see PROVENANCE.md).
import type { Camera, Group, Mesh, Object3D, Scene, Texture } from "three";
import type { BoardView } from "./leaderboard.mjs";
import type { ScenePreset } from "./presets.mjs";
export type LampState = "working" | "waiting" | "idle" | "unknown" | "offline" | "off";
export declare const LAMP_COLORS: Readonly<Record<LampState, readonly [number, number, number]>>;
export interface RingSkyline {
	readonly mesh: Mesh;
	readonly texture: Texture;
	follow(camera: Camera): void;
	dispose(): void;
}
export interface RingMeshes {
	readonly group: Group;
	readonly glows: Object3D[];
	readonly lamps: number;
	readonly pylon: Object3D;
	dispose(): void;
}
export interface RingScene {
	readonly scene: Scene;
	readonly ground: Mesh;
	readonly groundTexture: Texture;
	readonly skyTexture: Texture;
	readonly meshes: RingMeshes;
	readonly skyline: RingSkyline;
	/** Door status lamps from a BoardView (or its rows); returns how many changed. */
	setLamps(view: BoardView | BoardView["rows"]): number;
	lampStates(): Record<string, LampState>;
	dispose(): void;
}
export declare function buildRingScene(
	preset: ScenePreset,
	seed: number | null | undefined,
	horizonNdcY: number | null | undefined,
	opts?: {
		pylon?: (o: { seed: number; look: ScenePreset; at: unknown }) => Object3D | { mesh: Object3D };
	},
): RingScene;
