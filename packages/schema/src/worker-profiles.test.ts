import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compareWorkerCapabilityTier,
	ManagedProvider,
	Provider,
	WORKER_CAPABILITY_RANK,
	WORKER_LINEAR_CAPABILITY_TIERS,
	WORKER_MAX_CONCURRENCY,
	WORKER_MAX_PROFILES,
	WORKER_ROLE_ALLOWED_MUTABILITY,
	WorkerCapabilityTier,
	WorkerCostClass,
	WorkerLatencyClass,
	WorkerMutabilityClass,
	WorkerProfile,
	WorkerProfileId,
	type WorkerProfileInput,
	WorkerProfileList,
	WorkerProvider,
	WorkerRole,
	workerCapabilityRank,
	workerProviderRequiresModel,
	workerTierSatisfies,
} from "./index.ts";

const base: WorkerProfileInput = {
	profile_id: "standard-engineer",
	provider: "claude",
	role: "implementer",
	capability_tier: "standard",
	model: "sonnet",
	mutability: "worktree",
	latency_class: "medium",
	cost_class: "medium",
};
const ok = (over: Record<string, unknown>) =>
	WorkerProfile.safeParse({ ...base, ...over }).success;

// Built at runtime so no credential-shaped literal is ever committed.
const fakeKey = () => ["sk", "ant", "a1B2c3D4e5F6g7H8i9J0k1L2"].join("-");

describe("worker profile vocabulary", () => {
	test("enums are exactly the documented sets", () => {
		expect(WorkerProvider.options).toEqual([
			"claude",
			"openai",
			"codex",
			"jev",
			"local",
			"fake",
		]);
		expect(WorkerRole.options).toEqual([
			"clerk",
			"implementer",
			"reviewer",
			"decision",
		]);
		expect(WorkerCapabilityTier.options).toEqual([
			"fast",
			"standard",
			"senior",
			"principal",
			"specialist",
		]);
		expect(WorkerMutabilityClass.options).toEqual(["read_only", "worktree"]);
		expect(WorkerLatencyClass.options).toEqual(["low", "medium", "high"]);
		expect(WorkerCostClass.options).toEqual(["none", "low", "medium", "high"]);
	});

	test("new exports do not shadow existing schema names", () => {
		expect(Provider.options).toEqual(["claude", "codex", "ollama"]);
		expect(ManagedProvider.options).toEqual(["fake", "claude", "codex"]);
	});

	test("the shared module is pure: zod + secret patterns only", () => {
		const src = readFileSync(
			join(import.meta.dir, "worker-profiles.ts"),
			"utf8",
		);
		const specs = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
		expect(specs.sort()).toEqual(["./secret-patterns.ts", "zod"]);
	});
});

describe("capability scale", () => {
	test("linear rank fast < standard < senior < principal; specialist has none", () => {
		expect(WORKER_LINEAR_CAPABILITY_TIERS).toEqual([
			"fast",
			"standard",
			"senior",
			"principal",
		]);
		const ranks = WORKER_LINEAR_CAPABILITY_TIERS.map(workerCapabilityRank);
		expect(ranks).toEqual([0, 1, 2, 3]);
		expect(workerCapabilityRank("specialist")).toBeNull();
		expect(Object.isFrozen(WORKER_CAPABILITY_RANK)).toBe(true);
	});

	test("a linear minimum is met by equal or higher linear tiers only", () => {
		for (const req of WORKER_LINEAR_CAPABILITY_TIERS)
			for (const tier of WORKER_LINEAR_CAPABILITY_TIERS)
				expect(workerTierSatisfies(tier, req)).toBe(
					WORKER_CAPABILITY_RANK[tier] >= WORKER_CAPABILITY_RANK[req],
				);
	});

	test("specialist never satisfies a linear minimum and is matched only when asked for", () => {
		for (const req of WORKER_LINEAR_CAPABILITY_TIERS)
			expect(workerTierSatisfies("specialist", req)).toBe(false);
		expect(workerTierSatisfies("specialist", "specialist")).toBe(true);
		for (const tier of WORKER_LINEAR_CAPABILITY_TIERS)
			expect(workerTierSatisfies(tier, "specialist")).toBe(false);
	});

	test("compare orders linear tiers by rank with specialist last, from any input order", () => {
		const want = ["fast", "standard", "senior", "principal", "specialist"];
		const inputs = [
			["specialist", "principal", "senior", "standard", "fast"],
			["senior", "specialist", "fast", "principal", "standard"],
			["fast", "standard", "senior", "principal", "specialist"],
		] as WorkerCapabilityTier[][];
		for (const input of inputs)
			expect([...input].sort(compareWorkerCapabilityTier)).toEqual(
				want as WorkerCapabilityTier[],
			);
		expect(compareWorkerCapabilityTier("specialist", "specialist")).toBe(0);
	});
});

describe("WorkerProfile schema", () => {
	test("defaults: enabled true, max_concurrency 1, model null only where allowed", () => {
		expect(WorkerProfile.parse(base)).toStrictEqual({
			...base,
			model: "sonnet",
			enabled: true,
			max_concurrency: 1,
		});
		const jev = WorkerProfile.parse({
			...base,
			profile_id: "decision-engine",
			provider: "jev",
			role: "decision",
			capability_tier: "specialist",
			model: undefined,
			mutability: "read_only",
		});
		expect(jev.model).toBeNull();
	});

	test("profile ids: lowercase, bounded, no path or case games", () => {
		for (const id of ["a", "fast-clerk", "codex.reviewer_2", "x".repeat(64)])
			expect(WorkerProfileId.safeParse(id).success).toBe(true);
		for (const id of [
			"",
			"Fast-Clerk",
			"1clerk",
			"-clerk",
			"has space",
			"a/b",
			"../x",
			"x".repeat(65),
			"clerk\n",
		])
			expect(ok({ profile_id: id })).toBe(false);
	});

	test("enum fields reject values outside the vocabulary", () => {
		expect(ok({ provider: "anthropic" })).toBe(false);
		expect(ok({ role: "admin" })).toBe(false);
		expect(ok({ capability_tier: "god" })).toBe(false);
		expect(ok({ mutability: "full" })).toBe(false);
		expect(ok({ latency_class: "instant" })).toBe(false);
		expect(ok({ cost_class: "free" })).toBe(false);
	});

	test("max_concurrency is an integer in 1..16", () => {
		expect(WORKER_MAX_CONCURRENCY).toBe(16);
		expect(ok({ max_concurrency: 1 })).toBe(true);
		expect(ok({ max_concurrency: 16 })).toBe(true);
		for (const n of [0, -1, 17, 1.5, "2"])
			expect(ok({ max_concurrency: n })).toBe(false);
	});

	test("strict: no delivery authority, credentials, executables or provider config", () => {
		for (const key of [
			"push",
			"pr",
			"merge",
			"deploy",
			"delivery",
			"remote",
			"executable",
			"argv",
			"env",
			"api_key",
			"token",
			"credentials",
			"base_url",
			"fallback_model",
		])
			expect(ok({ [key]: key === "push" ? true : "x" })).toBe(false);
	});

	test("model: CLI-provider shape, no credential, pinned for model runtimes", () => {
		expect(ok({ model: "claude-opus-4[1m]" })).toBe(true);
		expect(ok({ model: "has space" })).toBe(false);
		expect(ok({ model: "x".repeat(101) })).toBe(false);
		expect(ok({ model: fakeKey() })).toBe(false);
		for (const provider of WorkerProvider.options) {
			expect(workerProviderRequiresModel(provider)).toBe(
				provider !== "jev" && provider !== "fake",
			);
			const role = "clerk";
			expect(
				WorkerProfile.safeParse({ ...base, provider, role, model: null })
					.success,
			).toBe(!workerProviderRequiresModel(provider));
		}
	});

	test("label: printable display text without credentials", () => {
		expect(ok({ label: "Principal engineer (Opus)" })).toBe(true);
		expect(ok({ label: "" })).toBe(false);
		expect(ok({ label: "a\u0007b" })).toBe(false);
		expect(ok({ label: "line\nbreak" })).toBe(false);
		expect(ok({ label: "x".repeat(81) })).toBe(false);
		expect(ok({ label: `key ${fakeKey()}` })).toBe(false);
	});

	test("role ↔ mutability: reviewer/decision read-only, implementer worktree", () => {
		for (const role of WorkerRole.options)
			for (const mutability of WorkerMutabilityClass.options) {
				const provider = role === "decision" ? "jev" : "claude";
				expect(ok({ role, mutability, provider })).toBe(
					WORKER_ROLE_ALLOWED_MUTABILITY[role].includes(mutability),
				);
			}
		expect(ok({ role: "reviewer", mutability: "worktree" })).toBe(false);
		expect(ok({ role: "implementer", mutability: "read_only" })).toBe(false);
	});
});

describe("WorkerProfileList", () => {
	test("duplicate profile ids fail closed with the offending path", () => {
		const r = WorkerProfileList.safeParse([
			base,
			{ ...base, model: "opus", capability_tier: "principal" },
		]);
		expect(r.success).toBe(false);
		expect(r.error?.issues[0]?.path).toEqual([1, "profile_id"]);
		expect(r.error?.issues[0]?.message).toContain("duplicate worker profile");
	});

	test("bounded size", () => {
		const many = (n: number) =>
			Array.from({ length: n }, (_, i) => ({ ...base, profile_id: `p${i}` }));
		expect(WorkerProfileList.safeParse(many(WORKER_MAX_PROFILES)).success).toBe(
			true,
		);
		expect(
			WorkerProfileList.safeParse(many(WORKER_MAX_PROFILES + 1)).success,
		).toBe(false);
		expect(WorkerProfileList.parse([])).toEqual([]);
	});
});
