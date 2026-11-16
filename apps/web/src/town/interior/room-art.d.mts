import type { Group, Scene } from "three";
import type { ScenePreset } from "../engine/presets.mjs";
import type { RoomData } from "./themes/types.ts";

export declare function buildInteriorScene(
	preset: ScenePreset,
	data: RoomData,
	seed: number,
): {
	scene: Scene;
	meshes: {
		group: Group;
		inventory: { name: string; width: number; height: number }[];
	};
	dispose(): void;
};
