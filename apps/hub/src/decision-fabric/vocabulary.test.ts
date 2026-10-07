// Route tokens stay in lockstep with the canonical Worker Profile tiers (integration of the Decision
// Fabric with the Worker Profile Registry vocabulary).
import { describe, expect, test } from "bun:test";
import {
	WORKER_CAPABILITY_RANK,
	WORKER_LINEAR_CAPABILITY_TIERS,
	WorkerCapabilityTier,
} from "@agent-city/schema";
import {
	CAPABILITY_TIERS,
	CapabilityTier,
	fromWorkerTier,
	HUMAN_ROUTE,
	RouteOutcome,
	routeTarget,
	tierRank,
	toWorkerTier,
} from "./vocabulary.ts";

describe("route tokens = canonical linear tiers", () => {
	test("same tiers, same order", () => {
		expect(CAPABILITY_TIERS.map((t) => t.toLowerCase())).toEqual([
			...WORKER_LINEAR_CAPABILITY_TIERS,
		]);
	});

	test("rank is the canonical rank", () => {
		for (const t of CAPABILITY_TIERS)
			expect(tierRank(t)).toBe(WORKER_CAPABILITY_RANK[toWorkerTier(t)]);
	});

	test("token ↔ canonical tier round-trips", () => {
		for (const t of CAPABILITY_TIERS) {
			expect(WorkerCapabilityTier.parse(toWorkerTier(t))).toBe(toWorkerTier(t));
			expect(fromWorkerTier(toWorkerTier(t))).toBe(t);
		}
		for (const w of WORKER_LINEAR_CAPABILITY_TIERS)
			expect(toWorkerTier(fromWorkerTier(w))).toBe(w);
	});

	test("specialist is never a route token; canonical spellings are not route tokens", () => {
		for (const v of ["specialist", "SPECIALIST", "fast", "principal"]) {
			expect(CapabilityTier.safeParse(v).success).toBe(false);
			expect(RouteOutcome.safeParse(v).success).toBe(false);
		}
	});

	test("routeTarget: capability → canonical tier, HUMAN → no tier", () => {
		expect(CAPABILITY_TIERS.map((t) => routeTarget(t))).toEqual(
			WORKER_LINEAR_CAPABILITY_TIERS.map((tier) => ({
				kind: "CAPABILITY",
				tier,
			})),
		);
		expect(routeTarget(HUMAN_ROUTE)).toEqual({ kind: "HUMAN" });
	});
});
