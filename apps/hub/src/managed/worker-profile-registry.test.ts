import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkerProfileInput } from "@agent-city/schema";
import {
	canonicalJson,
	type ManagedConfig,
	parseManagedConfig,
	policyHash,
	sha256Hex,
} from "./config.ts";
import { liveConfigured } from "./service.ts";
import { createAdapters } from "./worker.ts";
import {
	buildWorkerProfileRegistry,
	workerProfileRegistryFromConfig,
} from "./worker-profile-registry.ts";

// Literal absolute paths: parseManagedConfig never touches the filesystem.
const ROOT = "/tmp/agentcity-worker-profiles";
const REPO = "local/fixture";
const RAW = {
	workspace_root: `${ROOT}/workspaces`,
	artifacts_root: `${ROOT}/artifacts`,
	git_executable: "/usr/bin/git",
	repos: [
		{
			id: REPO,
			path: `${ROOT}/repo`,
			base_ref: "main",
			verification: [{ name: "test", argv: ["/usr/bin/true"] }],
		},
	],
};

/** policyHash exactly as it was before worker profiles existed. */
const oldPolicyHash = (cfg: ManagedConfig, repoId: string) =>
	sha256Hex(
		canonicalJson({
			repo: cfg.repos.find((r) => r.id === repoId) ?? null,
			live: cfg.live,
			git: cfg.git_executable,
			limits: cfg.limits,
			workspace_root: cfg.workspace_root,
			artifacts_root: cfg.artifacts_root,
		}),
	);

const P = {
	fastClerk: {
		profile_id: "fast-clerk",
		provider: "claude",
		role: "clerk",
		capability_tier: "fast",
		model: "haiku",
		mutability: "read_only",
		latency_class: "low",
		cost_class: "low",
		max_concurrency: 4,
	},
	openaiClerk: {
		profile_id: "openai-clerk",
		provider: "openai",
		role: "clerk",
		capability_tier: "fast",
		model: "openai-light-model",
		mutability: "read_only",
		latency_class: "low",
		cost_class: "low",
	},
	claudeEngineer: {
		profile_id: "standard-engineer",
		provider: "claude",
		role: "implementer",
		capability_tier: "standard",
		model: "sonnet",
		mutability: "worktree",
		latency_class: "medium",
		cost_class: "medium",
		max_concurrency: 2,
	},
	openaiEngineer: {
		profile_id: "openai-engineer",
		provider: "openai",
		role: "implementer",
		capability_tier: "standard",
		model: "openai-coding-model",
		mutability: "worktree",
		latency_class: "medium",
		cost_class: "medium",
	},
	claudePrincipal: {
		profile_id: "principal-engineer",
		provider: "claude",
		role: "implementer",
		capability_tier: "principal",
		model: "opus",
		mutability: "worktree",
		latency_class: "high",
		cost_class: "high",
	},
	openaiPrincipal: {
		profile_id: "openai-principal",
		provider: "openai",
		role: "implementer",
		capability_tier: "principal",
		model: "openai-strongest-model",
		mutability: "worktree",
		latency_class: "high",
		cost_class: "high",
	},
	reviewer: {
		profile_id: "independent-reviewer",
		provider: "codex",
		role: "reviewer",
		capability_tier: "senior",
		model: "codex-review-model",
		mutability: "read_only",
		latency_class: "medium",
		cost_class: "medium",
	},
	decision: {
		profile_id: "decision-engine",
		provider: "jev",
		role: "decision",
		capability_tier: "specialist",
		model: null,
		mutability: "read_only",
		latency_class: "low",
		cost_class: "none",
	},
	local: {
		profile_id: "local-worker",
		provider: "local",
		role: "clerk",
		capability_tier: "fast",
		model: "local-model",
		mutability: "read_only",
		latency_class: "medium",
		cost_class: "none",
		enabled: false,
	},
} satisfies Record<string, WorkerProfileInput>;
const ALL: WorkerProfileInput[] = Object.values(P);

/** Documented registry order: tier rank (specialist last), then profile_id. */
const ORDER = [
	"fast-clerk",
	"local-worker",
	"openai-clerk",
	"openai-engineer",
	"standard-engineer",
	"independent-reviewer",
	"openai-principal",
	"principal-engineer",
	"decision-engine",
];

const ids = (list: readonly { profile_id: string }[]) =>
	list.map((p) => p.profile_id);

describe("config: worker_profiles is additive", () => {
	test("a config without worker_profiles parses exactly as before", () => {
		const cfg = parseManagedConfig(RAW);
		expect(Object.keys(cfg).sort()).toEqual([
			"artifacts_root",
			"git_executable",
			"limits",
			"live",
			"repos",
			"workspace_root",
		]);
		expect(Object.hasOwn(cfg, "worker_profiles")).toBe(false);
		expect(cfg).toStrictEqual({
			workspace_root: `${ROOT}/workspaces`,
			artifacts_root: `${ROOT}/artifacts`,
			git_executable: "/usr/bin/git",
			repos: [
				{
					id: REPO,
					path: `${ROOT}/repo`,
					base_ref: "main",
					verification: [
						{ name: "test", argv: ["/usr/bin/true"], timeout_s: 300 },
					],
				},
			],
			live: { enabled: false },
			limits: {
				max_log_bytes: 262_144,
				max_diff_bytes: 1_048_576,
				max_context_file_bytes: 1_048_576,
				max_context_total_bytes: 16_777_216,
				max_evidence_bytes: 67_108_864,
				kill_grace_ms: 2_000,
				lease_ttl_ms: 30_000,
				max_infra_retries: 2,
			},
		});
		// the `...fx.config` spread pattern used across the managed tests round-trips unchanged
		expect(parseManagedConfig({ ...cfg })).toStrictEqual(cfg);
	});

	test("profiles parse, round-trip, and coexist across Claude/OpenAI/Codex/Jev/local", () => {
		const cfg = parseManagedConfig({ ...RAW, worker_profiles: ALL });
		expect(cfg.worker_profiles).toHaveLength(ALL.length);
		expect(parseManagedConfig({ ...cfg })).toStrictEqual(cfg);
		const providers = new Set(cfg.worker_profiles?.map((p) => p.provider));
		expect([...providers].sort()).toEqual([
			"claude",
			"codex",
			"jev",
			"local",
			"openai",
		]);
	});

	test("duplicate profile ids fail closed", () => {
		expect(() =>
			parseManagedConfig({
				...RAW,
				worker_profiles: [
					P.claudeEngineer,
					{ ...P.claudePrincipal, profile_id: "standard-engineer" },
				],
			}),
		).toThrow(/duplicate worker profile standard-engineer/);
	});

	test("invalid ids, unknown keys and impossible values fail the whole config", () => {
		const bad: unknown[] = [
			{ ...P.fastClerk, profile_id: "Fast-Clerk" },
			{ ...P.fastClerk, push: true },
			{ ...P.fastClerk, deploy: "prod" },
			{ ...P.fastClerk, executable: "/usr/local/bin/claude" },
			{ ...P.fastClerk, api_key: "x" },
			{ ...P.fastClerk, provider: "anthropic" },
			{ ...P.fastClerk, max_concurrency: 0 },
			{ ...P.fastClerk, max_concurrency: 17 },
			{ ...P.claudePrincipal, model: null },
			{ ...P.reviewer, mutability: "worktree" },
			{ ...P.claudeEngineer, mutability: "read_only" },
		];
		for (const p of bad)
			expect(() =>
				parseManagedConfig({ ...RAW, worker_profiles: [p] }),
			).toThrow();
	});
});

describe("config: policyHash", () => {
	test("absent or empty worker_profiles hash exactly as the pre-profile formula", () => {
		const absent = parseManagedConfig(RAW);
		const empty = parseManagedConfig({ ...RAW, worker_profiles: [] });
		expect(empty.worker_profiles).toEqual([]);
		expect(policyHash(absent, REPO)).toBe(oldPolicyHash(absent, REPO));
		expect(policyHash(empty, REPO)).toBe(oldPolicyHash(empty, REPO));
		expect(policyHash(empty, REPO)).toBe(policyHash(absent, REPO));
		// also with live providers configured (the fields the existing hash already covers)
		const liveRaw = {
			...RAW,
			live: {
				enabled: true,
				claude: { executable: "/opt/bin/claude", model: "opus" },
				codex: { executable: "/opt/bin/codex", model: "codex-model" },
			},
		};
		for (const raw of [liveRaw, { ...liveRaw, worker_profiles: [] }]) {
			const cfg = parseManagedConfig(raw);
			expect(policyHash(cfg, REPO)).toBe(oldPolicyHash(cfg, REPO));
		}
	});

	test("adding, changing or disabling a profile changes the hash; reordering does not", () => {
		const absent = policyHash(parseManagedConfig(RAW), REPO);
		const hashOf = (profiles: unknown[]) =>
			policyHash(
				parseManagedConfig({ ...RAW, worker_profiles: profiles }),
				REPO,
			);
		const one = hashOf([P.claudeEngineer]);
		expect(one).not.toBe(absent);
		const two = hashOf([P.claudeEngineer, P.reviewer]);
		expect(two).not.toBe(one);
		expect(hashOf([P.reviewer, P.claudeEngineer])).toBe(two);
		const variants: Record<string, unknown>[] = [
			{ enabled: false },
			{ model: "opus" },
			{ capability_tier: "senior" },
			{ max_concurrency: 3 },
			{ latency_class: "high" },
			{ cost_class: "high" },
			{ label: "Engineer" },
			{ profile_id: "engineer" },
		];
		const seen = new Set([absent, one]);
		for (const v of variants) {
			const h = hashOf([{ ...P.claudeEngineer, ...v }]);
			expect(seen.has(h)).toBe(false);
			seen.add(h);
		}
	});
});

describe("registry", () => {
	test("omitted worker_profiles → safe empty registry", () => {
		const reg = workerProfileRegistryFromConfig(parseManagedConfig(RAW));
		expect(reg.size).toBe(0);
		expect(reg.all()).toEqual([]);
		expect(reg.enabled()).toEqual([]);
		expect(reg.select()).toEqual([]);
		expect(reg.byRole("implementer")).toEqual([]);
		expect(reg.atLeast("fast")).toEqual([]);
		expect(reg.get("fast-clerk")).toBeNull();
		expect(reg.resolve("fast-clerk")).toEqual({
			ok: false,
			reason: "unknown_profile",
			profile_id: "fast-clerk",
		});
		expect(buildWorkerProfileRegistry(undefined).size).toBe(0);
		expect(buildWorkerProfileRegistry([]).size).toBe(0);
	});

	test("deterministic order, independent of input order", () => {
		const perms: WorkerProfileInput[][] = [
			ALL,
			[...ALL].reverse(),
			...ALL.map((_, i) => [...ALL.slice(i), ...ALL.slice(0, i)]),
			[...ALL].sort((a, b) => (a.model ?? "").localeCompare(b.model ?? "")),
		];
		for (const input of perms) {
			const reg = buildWorkerProfileRegistry(input);
			expect(ids(reg.all())).toEqual(ORDER);
			expect(ids(reg.byRole("implementer"))).toEqual([
				"openai-engineer",
				"standard-engineer",
				"openai-principal",
				"principal-engineer",
			]);
			expect(ids(reg.atLeast("senior"))).toEqual([
				"independent-reviewer",
				"openai-principal",
				"principal-engineer",
			]);
		}
	});

	test("disabled profiles are never returned as available", () => {
		const reg = buildWorkerProfileRegistry(ALL);
		expect(ids(reg.enabled())).toEqual(
			ORDER.filter((id) => id !== "local-worker"),
		);
		expect(ids(reg.byRole("clerk"))).toEqual(["fast-clerk", "openai-clerk"]);
		expect(ids(reg.atLeast("fast"))).not.toContain("local-worker");
		// still visible for display, and get() reports it as disabled
		expect(ids(reg.all())).toContain("local-worker");
		expect(reg.get("local-worker")?.enabled).toBe(false);
		expect(reg.resolve("local-worker")).toEqual({
			ok: false,
			reason: "disabled_profile",
			profile_id: "local-worker",
		});
	});

	test("role, minimum-capability and provider filters", () => {
		const reg = buildWorkerProfileRegistry(ALL);
		expect(ids(reg.byRole("reviewer"))).toEqual(["independent-reviewer"]);
		expect(ids(reg.byRole("decision"))).toEqual(["decision-engine"]);
		// specialist: never from a linear minimum, only when requested explicitly
		for (const tier of ["fast", "standard", "senior", "principal"] as const)
			expect(ids(reg.atLeast(tier))).not.toContain("decision-engine");
		expect(ids(reg.atLeast("specialist"))).toEqual(["decision-engine"]);
		expect(
			ids(reg.select({ role: "implementer", min_capability: "principal" })),
		).toEqual(["openai-principal", "principal-engineer"]);
		expect(
			ids(
				reg.select({
					role: "implementer",
					min_capability: "principal",
					provider: "claude",
				}),
			),
		).toEqual(["principal-engineer"]);
		expect(
			reg.select({ role: "reviewer", min_capability: "principal" }),
		).toEqual([]);
	});

	test("unknown profile lookup returns no profile — no case-folding or prefix guess", () => {
		const reg = buildWorkerProfileRegistry(ALL);
		for (const id of [
			"Fast-Clerk",
			"fast",
			"fast-clerk ",
			"fast-clerk-2",
			"",
		]) {
			expect(reg.get(id)).toBeNull();
			expect(reg.resolve(id)).toEqual({
				ok: false,
				reason: "unknown_profile",
				profile_id: id,
			});
		}
		expect(reg.get("fast-clerk")?.model).toBe("haiku");
	});

	test("resolution never silently falls back to another profile", () => {
		const principalOff = ALL.map((p) =>
			p.profile_id === "principal-engineer" ? { ...p, enabled: false } : p,
		);
		const reg = buildWorkerProfileRegistry(principalOff);
		// a same-role, same-tier profile exists — it is NOT substituted
		expect(reg.resolve("principal-engineer")).toEqual({
			ok: false,
			reason: "disabled_profile",
			profile_id: "principal-engineer",
		});
		expect(reg.resolve("principal-engineer-v2")).toMatchObject({
			ok: false,
			reason: "unknown_profile",
		});
		expect(reg.resolve("fast-clerk", { role: "implementer" })).toMatchObject({
			ok: false,
			reason: "role_mismatch",
		});
		expect(
			reg.resolve("standard-engineer", { min_capability: "principal" }),
		).toMatchObject({ ok: false, reason: "insufficient_capability" });
		expect(
			reg.resolve("openai-principal", { min_capability: "specialist" }),
		).toMatchObject({ ok: false, reason: "insufficient_capability" });
		expect(
			reg.resolve("decision-engine", { min_capability: "principal" }),
		).toMatchObject({ ok: false, reason: "insufficient_capability" });
		expect(
			reg.resolve("openai-principal", { provider: "claude" }),
		).toMatchObject({ ok: false, reason: "provider_mismatch" });
		const hit = reg.resolve("openai-principal", {
			role: "implementer",
			min_capability: "senior",
			provider: "openai",
		});
		expect(hit.ok && hit.profile.profile_id).toBe("openai-principal");
		expect(hit.ok && hit.profile.model).toBe("openai-strongest-model");
	});

	test("the registry is immutable and detached from its input", () => {
		const input = ALL.map((p) => ({ ...p }));
		const reg = buildWorkerProfileRegistry(input);
		(input[0] as { model: string }).model = "mutated";
		input.length = 0;
		expect(reg.size).toBe(ALL.length);
		expect(reg.get("fast-clerk")?.model).toBe("haiku");
		expect(Object.isFrozen(reg)).toBe(true);
		expect(Object.isFrozen(reg.all())).toBe(true);
		expect(Object.isFrozen(reg.enabled())).toBe(true);
		expect(Object.isFrozen(reg.byRole("clerk"))).toBe(true);
		const p = reg.get("fast-clerk");
		expect(p && Object.isFrozen(p)).toBe(true);
		expect(() => {
			(p as { model: string | null }).model = "opus";
		}).toThrow();
		expect(() => {
			(reg.all() as unknown[]).push({});
		}).toThrow();
	});

	test("programmatic input is validated like the config (fail closed)", () => {
		expect(() =>
			buildWorkerProfileRegistry([P.fastClerk, { ...P.fastClerk }]),
		).toThrow(/duplicate worker profile/);
		expect(() =>
			buildWorkerProfileRegistry([{ ...P.fastClerk, pr: true }]),
		).toThrow();
		expect(() =>
			buildWorkerProfileRegistry([{ ...P.claudePrincipal, model: null }]),
		).toThrow();
	});
});

describe("no live provider, live-off behaviour intact", () => {
	test("profiles never build adapters or turn live on", () => {
		const cfg = parseManagedConfig({ ...RAW, worker_profiles: ALL });
		expect(cfg.live).toEqual({ enabled: false });
		expect(liveConfigured(cfg)).toBe(false);
		const adapters = createAdapters(cfg);
		expect(adapters.implementer("live")).toBeNull();
		expect(adapters.reviewer("live")).toBeNull();
		expect(adapters.implementer("simulated")?.provider).toBe("fake");
		expect(adapters.reviewer("simulated")?.provider).toBe("fake");
		// live.enabled without provider blocks is still not live, profiles or not
		const half = parseManagedConfig({
			...RAW,
			live: { enabled: true },
			worker_profiles: ALL,
		});
		expect(liveConfigured(half)).toBe(false);
		expect(createAdapters(half).implementer("live")).toBeNull();
	});

	test("the registry module has no I/O, process or adapter imports", () => {
		const src = readFileSync(
			join(import.meta.dir, "worker-profile-registry.ts"),
			"utf8",
		);
		const specs = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
		expect(specs.sort()).toEqual(["./config.ts", "@agent-city/schema"]);
		expect(src).toMatch(
			/import type \{ ManagedConfig \} from "\.\/config\.ts"/,
		);
		expect(src).not.toMatch(/\b(Bun\.spawn|fetch\(|process\.env|require\()/);
	});
});

describe("example config", () => {
	const text = readFileSync(
		join(import.meta.dir, "../../../../config/managed.example.yaml"),
		"utf8",
	);

	test("as shipped: no worker_profiles, live off", () => {
		const cfg = parseManagedConfig(Bun.YAML.parse(text));
		expect(Object.hasOwn(cfg, "worker_profiles")).toBe(false);
		expect(cfg.live).toEqual({ enabled: false });
	});

	test("the commented worker_profiles block is valid once uncommented", () => {
		const lines = text.split("\n");
		const start = lines.indexOf("# worker_profiles:");
		expect(start).toBeGreaterThan(-1);
		const block: string[] = [];
		for (const line of lines.slice(start)) {
			if (line !== "# worker_profiles:" && !line.startsWith("#   ")) break;
			block.push(line.replace(/^# /, ""));
		}
		const cfg = parseManagedConfig(
			Bun.YAML.parse(`${text}\n${block.join("\n")}\n`),
		);
		const reg = workerProfileRegistryFromConfig(cfg);
		expect(reg.size).toBe(7);
		expect(new Set(reg.all().map((p) => p.role))).toEqual(
			new Set(["clerk", "implementer", "reviewer", "decision"]),
		);
		expect(reg.get("decision-engine")?.model).toBeNull();
		expect(cfg.live).toEqual({ enabled: false });
		expect(createAdapters(cfg).implementer("live")).toBeNull();
		expect(policyHash(cfg, cfg.repos[0]?.id ?? "")).not.toBe(
			oldPolicyHash(cfg, cfg.repos[0]?.id ?? ""),
		);
	});
});
