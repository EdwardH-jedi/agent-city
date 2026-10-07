// The support lane's capability / profile vocabulary is the canonical Worker Profile vocabulary,
// narrowed to what a read-only support job may request.
import { describe, expect, test } from "bun:test";
import { WorkerCapabilityTier, WorkerProfileId } from "@agent-city/schema";
import {
	SUPPORT_CAPABILITIES,
	SupportCapability,
	SupportProfileId,
} from "./vocabulary.ts";

describe("support vocabulary = canonical worker vocabulary", () => {
	test("capabilities are canonical tiers: fast and standard only", () => {
		expect([...SUPPORT_CAPABILITIES]).toEqual(["fast", "standard"]);
		for (const c of SUPPORT_CAPABILITIES)
			expect(WorkerCapabilityTier.parse(c)).toBe(c);
	});

	test.each(["senior", "principal", "specialist", "FAST", "STANDARD", "haiku"])(
		"capability %p is not requestable by a support job",
		(v) => {
			expect(SupportCapability.safeParse(v).success).toBe(false);
		},
	);

	test("profile id is the canonical WorkerProfileId", () => {
		expect(SupportProfileId).toBe(WorkerProfileId);
		for (const id of ["fast-clerk", "clerk.openai-mini", "a"])
			expect(SupportProfileId.safeParse(id).success).toBe(true);
		for (const id of ["1clerk", "Clerk", "bad id", "", "x".repeat(65)])
			expect(SupportProfileId.safeParse(id).success).toBe(false);
	});
});
