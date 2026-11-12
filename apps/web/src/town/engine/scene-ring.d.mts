// Hand-written declarations for the ported engine (agent-city; see PROVENANCE.md).
import type { Camera, Group, Mesh, Object3D, Scene, Texture } from "three";
import type { BoardView } from "./leaderboard.mjs";
import type { ScenePreset } from "./presets.mjs";
import type { RingLot } from "./ring-layout.mjs";
export type LampState =
	| "working"
	| "waiting"
	| "idle"
	| "unknown"
	| "offline"
	| "off"
	| "stopped";
export declare const LAMP_COLORS: Readonly<Record<LampState, readonly [number, number, number]>>;
/** agent-city: explicit lamp rows (scene-ring lampState reads `row.lamp` first). */
export interface LampInput {
	rows: { lot: string; lamp: LampState }[];
	offline: boolean;
}
export declare function lampState(
	row: { lamp?: LampState; working?: number | null; waiting?: number | null } | null | undefined,
	offline: boolean,
): LampState;
/** Width in texels of a lit-sign string at scale s; throws on a character the sign font lacks. */
export declare function signTextWidth(text: string, s: number): number;
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
	readonly meshes: RingMeshes & {
		/** collider tag (`building:<lot id>`, …) → the object standing there */
		readonly colliders: ReadonlyMap<string, Object3D>;
	};
	readonly skyline: RingSkyline;
	/** Door status lamps from a BoardView or lamp rows (an explicit `lamp` wins); returns how many changed. */
	setLamps(view: BoardView | BoardView["rows"] | LampInput): number;
	lampStates(): Record<string, LampState>;
	dispose(): void;
}
export declare function buildRingScene(
	preset: ScenePreset,
	seed: number | null | undefined,
	horizonNdcY: number | null | undefined,
	opts?: {
		pylon?: (o: { seed: number; look: ScenePreset; at: unknown }) => Object3D | { mesh: Object3D };
		/** agent-city: LOTS override (same ids and positions); `litWindows` / `lit` per lot. */
		lots?: readonly RingLot[];
	},
): RingScene;
