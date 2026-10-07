// Model-factory integration cases A–E (overnight build, 2026-10-06): the dry-run boundary
//   input (support job | implementation task) → TASK_ROUTE recommendation → deterministic policy →
//   canonical capability tier → Worker Profile Registry (built from a parsed managed config) →
//   resolved enabled profile, or a fail-closed outcome.
// Nothing launches: network / process entry points are trapped for the whole file, live stays off,
// and no managed task, workspace state, Gate 1 or git is involved.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { WorkerProfileInput } from "@agent-city/schema";
import { decide, type FabricOutcome } from "../decision-fabric/fabric.ts";
import { fixedProvider } from "../decision-fabric/fake-provider.ts";
import { hashDecisionInput } from "../decision-fabric/hash.ts";
import type { DecisionProvider } from "../decision-fabric/provider.ts";
import {
	change,
	finding,
	postReview,
	request,
	reviewDepth,
} from "../decision-fabric/testkit.ts";
import { parseManagedConfig } from "../managed/config.ts";
import {
	buildWorkerProfileRegistry,
	type WorkerProfileRegistry,
	workerProfileRegistryFromConfig,
} from "../managed/worker-profile-registry.ts";
import { assignSupportProfile } from "../support-jobs/state.ts";
import { queued } from "../support-jobs/testkit.ts";
import {
	type DryRunProfile,
	dryRunSupportRoute,
	dryRunTaskRoute,
} from "./dry-run-route.ts";

const profile = (
	over: Partial<WorkerProfileInput> & { profile_id: string },
): WorkerProfileInput => ({
	provider: "claude",
	role: "implementer",
	capability_tier: "standard",
	model: "synthetic-model",
	mutability: "worktree",
	latency_class: "medium",
	cost_class: "medium",
	...over,
});

const PROFILES: WorkerProfileInput[] = [
	profile({
		profile_id: "clerk-fast",
		role: "clerk",
		capability_tier: "fast",
		mutability: "read_only",
		latency_class: "low",
		cost_class: "low",
	}),
	profile({ profile_id: "impl-standard", capability_tier: "standard" }),
	profile({
		profile_id: "impl-senior",
		provider: "openai",
		capability_tier: "senior",
	}),
	profile({ profile_id: "impl-principal", capability_tier: "principal" }),
	profile({
		profile_id: "impl-fast-off",
		capability_tier: "fast",
		enabled: false,
	}),
	profile({
		profile_id: "reviewer-codex",
		provider: "codex",
		role: "reviewer",
		capability_tier: "senior",
		mutability: "read_only",
	}),
	profile({
		profile_id: "decision-jev",
		provider: "jev",
		role: "decision",
		model: null,
		mutability: "read_only",
	}),
];

const ROOT = "/tmp/agentcity-model-factory-cases";
const CONFIG = parseManagedConfig({
	workspace_root: `${ROOT}/workspaces`,
	artifacts_root: `${ROOT}/artifacts`,
	git_executable: "/usr/bin/git",
	repos: [
		{
			id: "local/fixture",
			path: `${ROOT}/repo`,
			base_ref: "main",
			verification: [{ name: "test", argv: ["/usr/bin/true"] }],
		},
	],
	worker_profiles: PROFILES,
});
const REGISTRY = workerProfileRegistryFromConfig(CONFIG);

const recommend = (choice: string, confidence = 0.95): DecisionProvider =>
	fixedProvider({ choice, confidence }, "fake:case");
const deps = (provider: DecisionProvider, registry = REGISTRY) => ({
	provider,
	registry,
	decide_options: { timeout_ms: 50 },
});
const recommended = (p: DryRunProfile) =>
	p.status === "PROFILE_RECOMMENDED" ? p.profile : null;
const decided = (o: FabricOutcome | null) => {
	if (o?.outcome !== "DECIDED") throw new Error("expected a decision");
	return o;
};

const touched: string[] = [];
const saved = {
	fetch: globalThis.fetch,
	spawn: Bun.spawn,
	spawnSync: Bun.spawnSync,
};
beforeAll(() => {
	const trap = (name: string) => () => {
		touched.push(name);
		throw new Error(`${name} is not allowed in the model-factory cases`);
	};
	globalThis.fetch = trap("fetch") as unknown as typeof fetch;
	Bun.spawn = trap("Bun.spawn") as unknown as typeof Bun.spawn;
	Bun.spawnSync = trap("Bun.spawnSync") as unknown as typeof Bun.spawnSync;
});
afterAll(() => {
	globalThis.fetch = saved.fetch;
	Bun.spawn = saved.spawn;
	Bun.spawnSync = saved.spawnSync;
	expect(touched).toEqual([]);
	// the trusted config stayed live-off throughout
	expect(CONFIG.live).toEqual({ enabled: false });
});

describe("Case A — lightweight handoff: HANDOFF → FAST → policy allows → fast clerk", () => {
	test("a queued HANDOFF support job is recommended the read-only fast clerk", async () => {
		const job = queued({ id: "case-a", kind: "HANDOFF", capability: "fast" });
		const r = await dryRunSupportRoute(
			{ job, scope: "TRIVIAL" },
			deps(recommend("FAST")),
		);
		const f = decided(r.fabric);
		expect(f.decision.choice).toBe("FAST");
		expect(f.decision.policy_override).toBeNull();
		expect(r.routed_tier).toBe("fast");
		expect(recommended(r.profile)).toMatchObject({
			profile_id: "clerk-fast",
			role: "clerk",
			capability_tier: "fast",
			mutability: "read_only",
		});
		expect(r.authority).toBe("ADVISORY");
		expect(r.mode).toBe("DRY_RUN");
	});
});

describe("Case B — ordinary source change → FAST/STANDARD → implementer profile", () => {
	for (const choice of ["FAST", "STANDARD"] as const)
		test(`a plain source change, ${choice} recommended → the lowest enabled sufficient implementer`, async () => {
			const r = await dryRunTaskRoute(
				{ change: change(), scope: "SMALL" },
				deps(recommend(choice)),
			);
			expect(decided(r.fabric).decision.choice).toBe(choice);
			// the disabled fast implementer is never chosen; the first enabled one that suffices is
			expect(recommended(r.profile)).toMatchObject({
				profile_id: "impl-standard",
				role: "implementer",
				mutability: "worktree",
			});
			expect(r.profile.status).toBe("PROFILE_RECOMMENDED");
		});

	test("a trusted minimum tier is a floor the recommendation cannot lower", async () => {
		const r = await dryRunTaskRoute(
			{ change: change(), scope: "SMALL", min_capability: "senior" },
			deps(recommend("FAST")),
		);
		expect(r.routed_tier).toBe("fast");
		expect(r.required_tier).toBe("senior");
		expect(recommended(r.profile)?.profile_id).toBe("impl-senior");
	});

	test("the source change still needs semantic review: NO_SEMANTIC_REVIEW is raised", async () => {
		const d = decided(
			await decide(
				recommend("NO_SEMANTIC_REVIEW"),
				request("REVIEW_DEPTH", reviewDepth({ change: change() })),
			),
		);
		expect(d.decision.choice).toBe("STANDARD_REVIEW");
	});
});

describe("Case C — security / auth task: FAST recommended → policy SENIOR+ → senior implementer", () => {
	for (const flag of [
		"touches_auth",
		"touches_authorization",
		"touches_security",
		"touches_db_migration",
	] as const)
		test(`${flag}: a confident FAST is overridden to SENIOR`, async () => {
			const r = await dryRunTaskRoute(
				{ change: change({ [flag]: true }), scope: "TRIVIAL" },
				deps(recommend("FAST", 0.99)),
			);
			const f = decided(r.fabric);
			expect(f.recommendation?.choice).toBe("FAST");
			expect(f.decision.choice).toBe("SENIOR");
			expect(f.decision.policy_override?.from).toBe("FAST");
			expect(r.required_tier).toBe("senior");
			expect(recommended(r.profile)).toMatchObject({
				profile_id: "impl-senior",
				capability_tier: "senior",
				role: "implementer",
			});
		});

	test("without a senior implementer the principal one serves; never a standard one", async () => {
		const reg = buildWorkerProfileRegistry(
			PROFILES.filter((p) => p.profile_id !== "impl-senior"),
		);
		const r = await dryRunTaskRoute(
			{ change: change({ touches_auth: true }), scope: "TRIVIAL" },
			deps(recommend("FAST", 0.99), reg),
		);
		expect(recommended(r.profile)?.profile_id).toBe("impl-principal");
	});

	test("a low-confidence route is raised conservatively too", async () => {
		const r = await dryRunTaskRoute(
			{ change: change(), scope: "TRIVIAL" },
			deps(recommend("FAST", 0.2)),
		);
		expect(decided(r.fabric).decision.choice).toBe("SENIOR");
		expect(recommended(r.profile)?.capability_tier).toBe("senior");
	});

	test("deploy / credentials / remote delivery go to a person: no profile lookup at all", async () => {
		for (const flag of [
			"touches_deploy_or_credentials",
			"requests_remote_delivery",
		] as const) {
			const r = await dryRunTaskRoute(
				{ change: change({ [flag]: true }), scope: "TRIVIAL" },
				deps(recommend("PRINCIPAL", 0.99)),
			);
			expect(r.profile).toEqual({
				status: "HUMAN_REQUIRED",
				reason: "route_human",
				profile_id: null,
				profile: null,
			});
			expect(r.required_tier).toBeNull();
		}
	});
});

describe("Case D — a reviewer REJECT stays not-ready whatever the decision provider says", () => {
	test("REJECT + a confident READY_FOR_HUMAN → HUMAN_REQUIRED, findings carried through", async () => {
		const findings = [finding()];
		const d = decided(
			await decide(
				recommend("READY_FOR_HUMAN", 0.99),
				request(
					"POST_REVIEW",
					postReview({ reviewer_verdict: "REJECT", findings }),
				),
			),
		);
		expect(d.recommendation?.choice).toBe("READY_FOR_HUMAN");
		expect(d.decision.choice).toBe("HUMAN_REQUIRED");
		expect(d.decision.choice).not.toBe("READY_FOR_HUMAN");
		expect(d.decision.reason_codes).toContain("REVIEWER_REJECT_NOT_READY");
		expect(d.decision.findings).toEqual(findings);
		expect(d.authority).toBe("ADVISORY");
	});

	test("REJECT + a confident SECOND_REVIEW is not review shopping: a person decides", async () => {
		const d = decided(
			await decide(
				recommend("SECOND_REVIEW", 0.99),
				request("POST_REVIEW", postReview({ reviewer_verdict: "REJECT" })),
			),
		);
		expect(d.decision.choice).toBe("HUMAN_REQUIRED");
	});
});

describe("Case E — a missing or disabled worker fails closed, with no silent fallback", () => {
	const taskWith = (profile_id: string, flags = {}) =>
		dryRunTaskRoute(
			{ change: change(flags), scope: "SMALL", profile_id },
			deps(recommend("STANDARD")),
		);

	test("an unknown assigned profile → NO_PROFILE unknown_profile (not another implementer)", async () => {
		const r = await taskWith("impl-missing");
		expect(r.profile).toEqual({
			status: "NO_PROFILE",
			reason: "unknown_profile",
			profile_id: "impl-missing",
			profile: null,
		});
	});

	test("a disabled assigned profile → NO_PROFILE disabled_profile", async () => {
		const r = await taskWith("impl-fast-off");
		expect(r.profile.status).toBe("NO_PROFILE");
		expect(r.profile).toMatchObject({ reason: "disabled_profile" });
	});

	test("an assigned profile below the policy floor is not swapped up", async () => {
		const r = await taskWith("impl-standard", { touches_security: true });
		expect(r.profile).toMatchObject({
			status: "NO_PROFILE",
			reason: "insufficient_capability",
			profile_id: "impl-standard",
		});
	});

	test("an assigned profile of another role is refused (a reviewer never implements)", async () => {
		const r = await taskWith("reviewer-codex");
		expect(r.profile).toMatchObject({ reason: "role_mismatch" });
	});

	test("no enabled implementer at the required tier → no_matching_profile (a lower one is not used)", async () => {
		const reg: WorkerProfileRegistry = buildWorkerProfileRegistry(
			PROFILES.map((p) =>
				p.capability_tier === "senior" || p.capability_tier === "principal"
					? { ...p, enabled: false }
					: p,
			),
		);
		const r = await dryRunTaskRoute(
			{ change: change({ touches_security: true }), scope: "SMALL" },
			deps(recommend("FAST", 0.99), reg),
		);
		expect(r.required_tier).toBe("senior");
		expect(r.profile).toEqual({
			status: "NO_PROFILE",
			reason: "no_matching_profile",
			profile_id: null,
			profile: null,
		});
	});

	test("a support job assigned a disabled or unknown clerk fails closed too", async () => {
		const reg = buildWorkerProfileRegistry([
			...PROFILES,
			profile({
				profile_id: "clerk-off",
				role: "clerk",
				capability_tier: "fast",
				mutability: "read_only",
				enabled: false,
			}),
		]);
		for (const [id, reason] of [
			["clerk-off", "disabled_profile"],
			["clerk-gone", "unknown_profile"],
		] as const) {
			const a = assignSupportProfile(queued({ id: `case-e-${id}` }), id);
			if (!a.ok) throw new Error(a.error);
			const r = await dryRunSupportRoute(
				{ job: a.job, scope: "TRIVIAL" },
				deps(recommend("FAST"), reg),
			);
			expect(r.profile).toMatchObject({ status: "NO_PROFILE", reason });
		}
	});

	test("invalid change facts fail closed before any profile lookup", async () => {
		const r = await dryRunTaskRoute(
			{ change: { mutates_source: true }, scope: "SMALL" },
			deps(recommend("FAST")),
		);
		expect(r.change).toBeNull();
		expect(r.profile).toMatchObject({
			status: "HUMAN_REQUIRED",
			reason: "decision_fail_closed",
		});
	});
});

describe("determinism and authority", () => {
	test("same normalized input + same policy → identical result", async () => {
		const a = await dryRunTaskRoute(
			{ change: change({ touches_auth: true }), scope: "MEDIUM" },
			deps(recommend("FAST", 0.99)),
		);
		const b = await dryRunTaskRoute(
			{ change: change({ touches_auth: true }), scope: "MEDIUM" },
			deps(recommend("FAST", 0.99)),
		);
		expect(a).toEqual(b);
		expect(Object.isFrozen(a)).toBe(true);
	});

	test("the result carries no execution-shaped field", async () => {
		const r = await dryRunTaskRoute(
			{ change: change(), scope: "SMALL" },
			deps(recommend("STANDARD")),
		);
		expect(Object.keys(r).sort()).toEqual([
			"authority",
			"change",
			"fabric",
			"mode",
			"profile",
			"required_tier",
			"routed_tier",
		]);
	});
});

describe("MF-P2-01 — policy, input hash and returned evidence use one guarded snapshot", () => {
	const fastOnly = buildWorkerProfileRegistry([
		profile({ profile_id: "impl-fast", capability_tier: "fast" }),
	]);
	/** A provider that counts its calls (and recommends FAST, confidently). */
	const counting = () => {
		const inner = recommend("FAST", 0.99);
		const state = { calls: 0 };
		const provider: DecisionProvider = {
			id: "fake:count",
			recommend: async (req) => {
				state.calls += 1;
				return inner.recommend(req);
			},
		};
		return { provider, state };
	};
	const throwing = (value: object, key: string) => {
		const copy = { ...value };
		Object.defineProperty(copy, key, {
			enumerable: true,
			get() {
				throw new Error("unreadable change facts");
			},
		});
		return copy;
	};
	const hostile = () =>
		new Proxy(
			{},
			{
				get() {
					throw new Error("trap");
				},
				ownKeys() {
					throw new Error("trap");
				},
				getOwnPropertyDescriptor() {
					throw new Error("trap");
				},
			},
		);

	test("a getter that changes between reads is read once; the reported auth fact gets the SENIOR floor", async () => {
		let reads = 0;
		const facts = change();
		Object.defineProperty(facts, "touches_auth", {
			enumerable: true,
			get: () => ++reads === 1,
		});
		const r = await dryRunTaskRoute(
			{ change: facts, scope: "TRIVIAL" },
			deps(recommend("FAST", 0.99), fastOnly),
		);
		expect(reads).toBe(1);
		expect(r.change?.touches_auth).toBe(true);
		expect(decided(r.fabric).decision.choice).toBe("SENIOR");
		expect(r.routed_tier).toBe("senior");
		expect(r.profile).toMatchObject({
			status: "NO_PROFILE",
			reason: "no_matching_profile",
		});
	});

	test("the fabric's input hash is the hash of exactly the returned facts", async () => {
		for (const facts of [change(), change({ touches_security: true })]) {
			const r = await dryRunTaskRoute(
				{ change: facts, scope: "SMALL" },
				deps(recommend("STANDARD")),
			);
			expect(decided(r.fabric).input_hash).toBe(
				hashDecisionInput("TASK_ROUTE", { change: r.change, scope: "SMALL" }),
			);
		}
	});

	test("unreadable facts, an unreadable request or a Proxy fail closed — the provider is never asked", async () => {
		const requests: unknown[] = [
			{ change: throwing(change(), "touches_auth"), scope: "TRIVIAL" },
			{ change: hostile(), scope: "TRIVIAL" },
			throwing({ scope: "TRIVIAL" }, "change"),
			hostile(),
		];
		for (const req of requests) {
			const { provider, state } = counting();
			let r: Awaited<ReturnType<typeof dryRunTaskRoute>> | undefined;
			await expect(
				(async () => {
					r = await dryRunTaskRoute(
						req as Parameters<typeof dryRunTaskRoute>[0],
						deps(provider),
					);
				})(),
			).resolves.toBeUndefined();
			expect(state.calls).toBe(0);
			expect(r?.change).toBeNull(); // never replaced by all-false facts
			expect(r?.profile).toEqual({
				status: "HUMAN_REQUIRED",
				reason: "decision_fail_closed",
				profile_id: null,
				profile: null,
			});
			const f = decided(r?.fabric ?? null);
			expect(f.rejection_code).toBe("INPUT_INVALID");
			expect(f.recommendation_status).toBe("NOT_REQUESTED");
		}
	});

	test("an unknown minimum tier or a non-string profile id is refused, never ignored", async () => {
		for (const extra of [
			{ min_capability: "ultra" },
			{ min_capability: "specialist" },
			{ profile_id: 42 },
		]) {
			const { provider, state } = counting();
			const r = await dryRunTaskRoute(
				{ change: change(), scope: "SMALL", ...extra } as Parameters<
					typeof dryRunTaskRoute
				>[0],
				deps(provider),
			);
			expect(state.calls).toBe(0);
			expect(r.profile).toMatchObject({
				status: "HUMAN_REQUIRED",
				reason: "decision_fail_closed",
			});
		}
	});

	test("support route: an unreadable job or scope fails closed without a provider call", async () => {
		const { provider, state } = counting();
		const noJob = await dryRunSupportRoute(
			throwing({ scope: "TRIVIAL" }, "job") as Parameters<
				typeof dryRunSupportRoute
			>[0],
			deps(provider),
		);
		expect(noJob.profile).toMatchObject({
			status: "NO_PROFILE",
			reason: "invalid_job",
		});
		const noScope = await dryRunSupportRoute(
			throwing({ job: queued({ id: "mf-scope" }) }, "scope") as Parameters<
				typeof dryRunSupportRoute
			>[0],
			deps(provider),
		);
		expect(noScope.profile).toMatchObject({
			status: "HUMAN_REQUIRED",
			reason: "decision_fail_closed",
		});
		expect(state.calls).toBe(0);
	});
});
