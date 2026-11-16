import type { InteriorTheme, Point } from "./themes/types.ts";

export const ENTRY_MS = 4_000;
export interface RitualPose extends Point {
	walking: boolean;
	phase: number;
	light: boolean;
	open: boolean;
}
const mix = (a: Point, b: Point, t: number): Point => ({
	x: a.x + (b.x - a.x) * t,
	z: a.z + (b.z - a.z) * t,
});
/** A fixed data timestamp, never the room's mount time. Motionless callers pass a frozen clock. */
export function ritualAt(
	theme: InteriorTheme,
	target: Point,
	since: string,
	now: number,
	reduced: boolean,
): RitualPose {
	const began = Date.parse(since);
	const elapsed = Number.isFinite(began) ? now - began : ENTRY_MS;
	if (reduced || elapsed < 0 || elapsed >= ENTRY_MS)
		return { ...target, walking: false, phase: 0, light: false, open: false };
	const t = Math.max(0, elapsed);
	let point: Point;
	if (t < 1_200) point = mix(theme.entrance, theme.gate, t / 1_200);
	else if (t < 1_800)
		point =
			theme.entry === "faregate"
				? theme.gate
				: mix(
						theme.gate,
						{ x: theme.gate.x, z: target.z },
						(t - 1_200) / 1_500,
					);
	else if (t < 2_700)
		point = mix(
			theme.gate,
			{ x: theme.gate.x, z: target.z },
			theme.entry === "faregate" ? (t - 1_800) / 900 : (t - 1_200) / 1_500,
		);
	else
		point = mix({ x: theme.gate.x, z: target.z }, target, (t - 2_700) / 1_300);
	return {
		...point,
		walking: theme.entry === "door" || t < 1_200 || t >= 1_800,
		phase: Math.floor(t / 150) % 4,
		light: theme.entry === "faregate" && t >= 1_200 && t < 1_800,
		open: theme.entry === "faregate" && t >= 1_500 && t < 2_700,
	};
}
