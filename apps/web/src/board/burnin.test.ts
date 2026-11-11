import { describe, expect, test } from "bun:test";
import { BURN_IN_STEP_MS, burnInShift } from "./burnin.ts";

describe("burn-in shift of the top band", () => {
	test("moves every few minutes, never more than 2 px, by 1 px at a time, and loops", () => {
		const seen = new Set<string>();
		let prev = burnInShift(0);
		for (let k = 1; k <= 24; k += 1) {
			const s = burnInShift(k * BURN_IN_STEP_MS);
			expect(Math.abs(s.x)).toBeLessThanOrEqual(2);
			expect(Math.abs(s.y)).toBeLessThanOrEqual(2);
			expect(Math.abs(s.x - prev.x) + Math.abs(s.y - prev.y)).toBe(1);
			seen.add(`${s.x},${s.y}`);
			prev = s;
		}
		expect(seen.size).toBeGreaterThan(6);
		expect(burnInShift(12 * BURN_IN_STEP_MS)).toEqual(burnInShift(0));
	});

	test("stands still within a step (no motion between moves)", () => {
		expect(burnInShift(BURN_IN_STEP_MS + 1)).toEqual(
			burnInShift(2 * BURN_IN_STEP_MS - 1),
		);
		expect(BURN_IN_STEP_MS).toBeGreaterThanOrEqual(60_000);
	});
});
