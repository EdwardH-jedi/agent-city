// Hand-written declarations for the ported engine (agent-city; see PROVENANCE.md).
export type TimeOfDay = "day" | "dusk" | "night";
export type Rgb = readonly [number, number, number];
export interface ScenePreset {
	readonly pitchDeg: number;
	readonly distance: number;
	readonly heightOffset: number;
	readonly fov: number;
	readonly sky: number;
	readonly haze: number;
	readonly fogNear: number;
	readonly fogFar: number;
	readonly far?: number;
	readonly skylineDepth?: number;
	readonly playerPxPerTexel?: number;
	readonly backdrop?: number;
	readonly upright?: boolean;
	readonly yawOffset?: number;
	readonly time: TimeOfDay;
	readonly tint: Rgb;
	readonly groundTint: Rgb;
	readonly actorTint: Rgb;
	readonly lit: number;
	readonly glow: number;
}
export declare const TIMES: readonly TimeOfDay[];
export declare function timeOf(name: unknown): TimeOfDay;
export declare function resolvePreset(
	name: "alley" | "plaza" | "interior" | "ring",
	overrides?: Partial<ScenePreset> | null,
	time?: TimeOfDay | null,
): ScenePreset;
