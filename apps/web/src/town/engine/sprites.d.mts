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
	/** true = fixed pixel size; agent-city: a number 0..1 mixes it with the world size. */
	lockedScale?: boolean | number;
	shadow?: boolean;
	/** agent-city: what a runtime frame (frameFor) is drawn from. */
	sprite?: unknown;
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
	opts?: {
		playerPxPerTexel?: number;
		upright?: boolean;
		/** A frame for a key the atlas lacks: { texture, cx, cy } (pipeline.mjs agentFrame). */
		frameFor?: (a: Actor) => unknown;
	},
): ActorLayer;
