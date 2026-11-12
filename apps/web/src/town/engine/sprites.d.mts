// Hand-written declarations for the ported engine (agent-city; see PROVENANCE.md).
import type { Camera, Object3D, Scene, Texture } from "three";
import type { SpriteAtlas } from "./sprite-atlas.mjs";
export interface Actor {
	id: string;
	kind?: "player" | "npc";
	x: number;
	z: number;
	y?: number;
	/** Atlas key, e.g. `roo|north|walk|2`. */
	key: string;
	lockedScale?: boolean;
	shadow?: boolean;
}
export interface ActorRow {
	id: string;
	key: string;
	px: number;
	py: number;
}
export interface ActorLayer {
	sync(camera: Camera, actors: readonly Actor[]): ActorRow[];
	dispose(): void;
	readonly sprites: ReadonlyMap<string, { sprite: Object3D }>;
	readonly texture: Texture;
}
export declare function createActorLayer(
	scene: Scene,
	atlas: SpriteAtlas,
	tint: readonly [number, number, number] | null,
	opts?: { playerPxPerTexel?: number; upright?: boolean; frameFor?: (a: Actor) => unknown },
): ActorLayer;
