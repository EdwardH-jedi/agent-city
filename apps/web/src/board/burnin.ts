// Burn-in guard for a screen that never turns off (design doc §10 V3): the top band moves by one or
// two pixels every few minutes and comes back around. Pure: the offset is a function of the clock.
export const BURN_IN_STEP_MS = 3 * 60_000;

/** A slow loop around the origin; no step is more than 2 px from it, neighbours differ by 1 px. */
const PATH: readonly (readonly [number, number])[] = [
	[0, 0],
	[1, 0],
	[2, 0],
	[2, 1],
	[1, 1],
	[0, 1],
	[-1, 1],
	[-1, 0],
	[-2, 0],
	[-2, -1],
	[-1, -1],
	[0, -1],
];

export function burnInShift(now: number): { x: number; y: number } {
	const i = Math.floor(now / BURN_IN_STEP_MS) % PATH.length;
	const [x, y] = PATH[(i + PATH.length) % PATH.length] ?? [0, 0];
	return { x, y };
}
