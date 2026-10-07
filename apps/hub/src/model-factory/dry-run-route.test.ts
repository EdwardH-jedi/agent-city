// Model-factory foundation integration: the dry-run composition SupportJob → Decision Fabric
// TASK_ROUTE → canonical capability → Worker Profile Registry → profile recommendation, plus the
// cross-subsystem authority invariants (RC 1–10). Only deterministic fake providers; no network,
// no process, no model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WorkerProfile, type WorkerProfileInput } from "@agent-city/schema";
import { decide } from "../decision-fabric/fabric.ts";
import {
	fixedProvider,
	hangingProvider,
	rawProvider,
	rulesProvider,
	throwingProvider,
} from "../decision-fabric/fake-provider.ts";
import type { DecisionProvider } from "../decision-fabric/provider.ts";
import {
	change,
	finding,
	postReview,
	request,
	reviewDepth,
	taskRoute,
} from "../decision-fabric/testkit.ts";
import {
	canonicalJson,
	type ManagedConfig,
	parseManagedConfig,
	policyHash,
	sha256Hex,
} from "../managed/config.ts";
import {
	buildWorkerProfileRegistry,
	type WorkerProfileRegistry,
	workerProfileRegistryFromConfig,
} from "../managed/worker-profile-registry.ts";
import { SupportJob, SupportJobRequest } from "../support-jobs/job.ts";
import { assignSupportProfile } from "../support-jobs/state.ts";
import {
	cancelled,
	cancelRequested,
	queued,
	running,
	seededShuffle,
} from "../support-jobs/testkit.ts";
import {
	type DryRunRoute,
	dryRunSupportRoute,
	SUPPORT_JOB_CHANGE_FACTS,
} from "./dry-run-route.ts";

// ── fixtures (fictional models, no credentials) ──────────────────────────────────────────────

const profile = (
	over: Partial<WorkerProfileInput> & Pick<WorkerProfileInput, "profile_id">,
): WorkerProfileInput => ({
	provider: "claude",
	role: "clerk",
	capability_tier: "fast",
	model: "fast-model",
	mutability: "read_only",
	latency_class: "low",
	cost_class: "low",
	...over,
});

const P = {
	clerkFastA: profile({ profile_id: "clerk-fast-a", model: "haiku" }),
	clerkFastB: profile({
		profile_id: "clerk-fast-b",
		provider: "openai",
		model: "openai-light-model",
	}),
	clerkStandard: profile({
		profile_id: "clerk-standard",
		capability_tier: "standard",
		model: "sonnet",
		latency_class: "medium",
		cost_class: "medium",
	}),
	clerkWorktree: profile({
		profile_id: "clerk-worktree",
		capability_tier: "standard",
		mutability: "worktree",
	}),
	clerkDisabled: profile({ profile_id: "clerk-disabled", enabled: false }),
	clerkSpecialist: profile({
		profile_id: "clerk-specialist",
		provider: "local",
		capability_tier: "specialist",
		model: "local-model",
		cost_class: "none",
	}),
	implementerPrincipal: profile({
		profile_id: "engineer-principal",
		role: "implementer",
		capability_tier: "principal",
		model: "opus",
		mutability: "worktree",
		latency_class: "high",
		cost_class: "high",
	}),
	reviewerCodex: profile({
		profile_id: "reviewer-codex",
		provider: "codex",
		role: "reviewer",
		capability_tier: "senior",
		model: "codex-model",
	}),
	decisionJev: profile({
		profile_id: "decision-jev",
		provider: "jev",
		role: "decision",
		capability_tier: "senior",
		model: null,
	}),
} satisfies Record<string, WorkerProfileInput>;

const ALL = Object.values(P);
const registry = (list: readonly WorkerProfileInput[] = ALL) =>
	buildWorkerProfileRegistry(list);
const senior = profile({
	profile_id: "clerk-senior",
	capability_tier: "senior",
	model: "senior-model",
});

const assigned = (profileId: string, spec = { id: "job-a" }) => {
	const r = assignSupportProfile(queued(spec), profileId);
	if (!r.ok) throw new Error(`fixture assign failed: ${r.error}`);
	return r.job;
};

const run = (
	job: unknown,
	provider: DecisionProvider = rulesProvider(),
	reg: WorkerProfileRegistry = registry(),
	scope: "TRIVIAL" | "SMALL" | "MEDIUM" | "LARGE" = "TRIVIAL",
) =>
	dryRunSupportRoute(
		{ job, scope },
		{ provider, registry: reg, decide_options: { timeout_ms: 50 } },
	);

const recommendedId = (r: DryRunRoute) =>
	r.profile.status === "PROFILE_RECOMMENDED" ? r.profile.profile_id : null;

// Every network / process entry point throws while this file runs and records the attempt.
const touched: string[] = [];
const saved = {
	fetch: globalThis.fetch,
	spawn: Bun.spawn,
	spawnSync: Bun.spawnSync,
};
beforeAll(() => {
	const trap = (name: string) => () => {
		touched.push(name);
		throw new Error(`${name} is not allowed in the model-factory dry run`);
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
});

// ── composition ──────────────────────────────────────────────────────────────────────────────

describe("dry-run composition: SupportJob → TASK_ROUTE → capability → registry → recommendation", () => {
	test("fast job, FAST route → the first read-only fast clerk in registry order", async () => {
		const r = await run(queued({ id: "job-1" }));
		expect(r).toMatchObject({
			mode: "DRY_RUN",
			authority: "ADVISORY",
			job_id: "job-1",
			repo_id: "acme/widgets",
			kind: "REPO_STATUS",
			requested_capability: "fast",
			routed_tier: "fast",
			required_tier: "fast",
			profile: {
				status: "PROFILE_RECOMMENDED",
				source: "selected",
				profile_id: "clerk-fast-a",
			},
		});
		expect(r.profile.profile?.mutability).toBe("read_only");
		expect(r.profile.profile?.role).toBe("clerk");
	});

	test("the job's capability is a floor: standard job + FAST route → standard clerk", async () => {
		const r = await run(queued({ id: "job-2", capability: "standard" }));
		expect(r.routed_tier).toBe("fast");
		expect(r.required_tier).toBe("standard");
		expect(recommendedId(r)).toBe("clerk-standard");
	});

	test("the fabric can raise the tier (scope SMALL → STANDARD) but never lower it", async () => {
		const r = await run(
			queued({ id: "job-3" }),
			rulesProvider(),
			registry(),
			"SMALL",
		);
		expect(r.routed_tier).toBe("standard");
		expect(r.required_tier).toBe("standard");
		expect(recommendedId(r)).toBe("clerk-standard");
	});

	test("low confidence is raised by policy to SENIOR → no read-only senior clerk → fail closed", async () => {
		const low = fixedProvider({ choice: "FAST", confidence: 0.5 });
		const r = await run(queued({ id: "job-4" }), low);
		expect(r.fabric?.outcome).toBe("DECIDED");
		if (r.fabric?.outcome !== "DECIDED") throw new Error("unreachable");
		// provider recommendation and enforced decision are both inspectable
		expect(r.fabric.recommendation?.choice).toBe("FAST");
		expect(r.fabric.decision.route).toBe("SENIOR");
		expect(r.fabric.decision.policy_override).not.toBeNull();
		expect(r.required_tier).toBe("senior");
		expect(r.profile).toEqual({
			status: "NO_PROFILE",
			reason: "no_matching_profile",
			profile_id: null,
			profile: null,
		});
		// with a senior clerk configured, that one is recommended — never a fast one
		const r2 = await run(
			queued({ id: "job-4" }),
			low,
			registry([...ALL, senior]),
		);
		expect(recommendedId(r2)).toBe("clerk-senior");
	});

	test("support change facts are constant and all false (never taken from a provider)", async () => {
		expect(
			Object.values(SUPPORT_JOB_CHANGE_FACTS).every((v) => v === false),
		).toBe(true);
		expect(Object.isFrozen(SUPPORT_JOB_CHANGE_FACTS)).toBe(true);
		const seen: unknown[] = [];
		const spy: DecisionProvider = {
			id: "fake:spy",
			recommend: async (req) => {
				seen.push(req.input);
				return rulesProvider("fake:spy").recommend(req);
			},
		};
		await run(queued({ id: "job-5", kind: "PR_DRAFT" }), spy);
		expect(seen).toEqual([
			{ change: { ...SUPPORT_JOB_CHANGE_FACTS }, scope: "TRIVIAL" },
		]);
	});

	test("PR_DRAFT is informational: no remote delivery flag, routed like any support job", async () => {
		const r = await run(queued({ id: "job-6", kind: "PR_DRAFT" }));
		expect(SUPPORT_JOB_CHANGE_FACTS.requests_remote_delivery).toBe(false);
		expect(r.profile.status).toBe("PROFILE_RECOMMENDED");
		expect(r.routed_tier).toBe("fast");
	});

	test("deterministic: same input → identical result; profile order in config is irrelevant", async () => {
		const job = queued({ id: "job-7", capability: "standard" });
		const first = await run(job);
		for (let seed = 1; seed <= 5; seed++) {
			const r = await run(
				job,
				rulesProvider(),
				registry(seededShuffle(ALL, seed)),
			);
			expect(r).toEqual(first);
		}
	});
});

// ── RC invariants ────────────────────────────────────────────────────────────────────────────

describe("1 — Decision Fabric recommends; Hub policy / approval stays authoritative", () => {
	const ALLOWED_KEYS = [
		"authority",
		"fabric",
		"job_id",
		"kind",
		"mode",
		"profile",
		"repo_id",
		"requested_capability",
		"required_tier",
		"routed_tier",
	];
	const FORBIDDEN_KEY =
		/managed_task|execution|approv|binding|queue|gate|enqueue|run_id|push|merge|deploy|publish|command|argv|executable|token|credential|worktree_path/i;
	const keysDeep = (v: unknown, out: string[] = []): string[] => {
		if (Array.isArray(v)) for (const x of v) keysDeep(x, out);
		else if (v && typeof v === "object")
			for (const [k, x] of Object.entries(v)) {
				out.push(k);
				keysDeep(x, out);
			}
		return out;
	};

	test("every outcome has exactly the advisory key set and nothing execution-shaped", async () => {
		const outcomes = [
			await run(queued({ id: "k1" })),
			await run(
				queued({ id: "k2" }),
				fixedProvider({ choice: "HUMAN", confidence: 1 }),
			),
			await run(queued({ id: "k3" }), throwingProvider()),
			await run(assigned("clerk-disabled")),
			await run(running({ id: "k4" })),
			await run({ not: "a job" }),
		];
		for (const r of outcomes) {
			expect(Object.keys(r).sort()).toEqual(ALLOWED_KEYS);
			expect(r.mode).toBe("DRY_RUN");
			expect(r.authority).toBe("ADVISORY");
			expect(keysDeep(r).filter((k) => FORBIDDEN_KEY.test(k))).toEqual([]);
			expect(Object.isFrozen(r)).toBe(true);
			if (r.fabric) expect(r.fabric.authority).toBe("ADVISORY");
		}
	});
});

describe("2 — profile resolution executes nothing", () => {
	test("the dry run only ever calls the given decision provider", async () => {
		let calls = 0;
		const counting: DecisionProvider = {
			id: "fake:count",
			recommend: async (req) => {
				calls++;
				return rulesProvider("fake:count").recommend(req);
			},
		};
		await run(queued({ id: "x1" }), counting);
		await run(assigned("clerk-fast-b"), counting);
		expect(calls).toBe(2);
		expect(touched).toEqual([]);
	});

	test("source boundary: model-factory imports only pure foundation modules", () => {
		const dir = import.meta.dir;
		const sources = readdirSync(dir).filter(
			(f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
		);
		expect(sources).toEqual(["dry-run-route.ts", "support-launch-plan.ts"]);
		const allowed = new Set([
			"@agent-city/schema",
			"../decision-fabric/contracts.ts",
			"../decision-fabric/fabric.ts",
			"../decision-fabric/provider.ts",
			"../decision-fabric/vocabulary.ts",
			"../managed/worker-profile-registry.ts",
			"../support-jobs/guards.ts",
			"../support-jobs/job.ts",
			"../support-jobs/scheduler.ts",
			"../support-jobs/vocabulary.ts",
			"./dry-run-route.ts",
		]);
		for (const f of sources) {
			const text = readFileSync(join(dir, f), "utf8");
			const specs = [...text.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]);
			expect(specs.filter((s) => !allowed.has(s ?? ""))).toEqual([]);
			expect(text).not.toMatch(
				/\bfetch\s*\(|\bBun\.|child_process|process\.env|\brequire\s*\(|\bimport\s*\(|setTimeout|setInterval|node:/,
			);
			expect(text).not.toMatch(
				/orchestrator|managed\/worker\.ts|adapters|proc\.ts|service\.ts|store\.ts|workspace-m1|assignSupportProfile\(/,
			);
		}
	});
});

describe("3 — support jobs stay read-only and unchanged", () => {
	test("the input job is not modified and is never assigned a profile", async () => {
		const job = structuredClone(queued({ id: "ro-1", capability: "standard" }));
		const before = structuredClone(job);
		const r = await run(job);
		expect(r.profile.status).toBe("PROFILE_RECOMMENDED");
		expect(job).toEqual(before);
		expect(job.profile_id).toBeNull();
		expect(job.status).toBe("QUEUED");
	});

	test("only read-only clerks are ever recommended (sweep)", async () => {
		const shuffled = [1, 2, 3].map((s) => registry(seededShuffle(ALL, s)));
		for (const reg of shuffled)
			for (const capability of ["fast", "standard"] as const)
				for (const scope of ["TRIVIAL", "SMALL", "MEDIUM", "LARGE"] as const) {
					const r = await run(
						queued({ id: "ro-sweep", capability }),
						rulesProvider(),
						reg,
						scope,
					);
					if (r.profile.status === "PROFILE_RECOMMENDED") {
						expect(r.profile.profile.role).toBe("clerk");
						expect(r.profile.profile.mutability).toBe("read_only");
						expect(r.profile.profile.enabled).toBe(true);
					}
				}
	});

	test("a mutable clerk that sorts first is skipped; alone it yields no profile", async () => {
		const first = profile({
			profile_id: "clerk-a-worktree",
			mutability: "worktree",
		});
		const r = await run(
			queued({ id: "ro-3" }),
			rulesProvider(),
			registry([first, P.clerkFastB]),
		);
		expect(recommendedId(r)).toBe("clerk-fast-b");
		const alone = await run(
			queued({ id: "ro-4" }),
			rulesProvider(),
			registry([first]),
		);
		expect(alone.profile).toEqual({
			status: "NO_PROFILE",
			reason: "no_matching_profile",
			profile_id: null,
			profile: null,
		});
	});

	test("support job schemas carry no mutation, delivery or credential authority", () => {
		for (const key of [
			"command",
			"argv",
			"write_path",
			"push",
			"deploy",
			"token",
		]) {
			const job = { ...queued({ id: "ro-2" }), [key]: "x" };
			expect(SupportJob.safeParse(job).success).toBe(false);
		}
		const req = {
			repo_id: "acme/widgets",
			kind: "REPO_STATUS",
			capability: "fast",
			inputs: [],
			brief: null,
			priority: 1,
			disabled: false,
			push: true,
		};
		expect(SupportJobRequest.safeParse(req).success).toBe(false);
	});

	test("jobs that are not QUEUED / are disabled / are cancelling are not routed", async () => {
		let calls = 0;
		const counting: DecisionProvider = {
			id: "fake:count",
			recommend: async (req) => {
				calls++;
				return rulesProvider("fake:count").recommend(req);
			},
		};
		for (const job of [
			running({ id: "nr-1" }),
			cancelled({ id: "nr-2" }),
			cancelRequested({ id: "nr-3" }),
			queued({ id: "nr-4", disabled: true }),
		]) {
			const r = await run(job, counting);
			expect(r.profile.status).toBe("NO_PROFILE");
			expect(r.profile.status === "NO_PROFILE" && r.profile.reason).toBe(
				"job_not_routable",
			);
			expect(r.fabric).toBeNull();
		}
		expect(calls).toBe(0);
	});
});

describe("4 — a reviewer rejection never becomes ready", () => {
	test("REJECT + a confident READY_FOR_HUMAN recommendation → not ready, findings kept", async () => {
		const findings = [
			finding({ severity: "blocker", title: "unsafe path join" }),
			finding({ severity: "minor", title: "naming" }),
		];
		for (const confidence of [0, 0.5, 0.7, 0.99, 1]) {
			const o = await decide(
				fixedProvider({ choice: "READY_FOR_HUMAN", confidence }),
				request(
					"POST_REVIEW",
					postReview({ reviewer_verdict: "REJECT", findings }),
				),
			);
			if (o.outcome !== "DECIDED") throw new Error("expected DECIDED");
			expect(o.decision.choice).not.toBe("READY_FOR_HUMAN");
			expect(o.decision.findings).toEqual(findings);
			expect(o.authority).toBe("ADVISORY");
		}
	});
});

describe("5 — no source-code mutation skips minimum semantic review", () => {
	test("mutating change + confident NO_SEMANTIC_REVIEW → at least STANDARD_REVIEW", async () => {
		for (const support_artifact_only of [false, true]) {
			const o = await decide(
				fixedProvider({ choice: "NO_SEMANTIC_REVIEW", confidence: 1 }),
				request(
					"REVIEW_DEPTH",
					reviewDepth({
						change: change({ mutates_source: true }),
						support_artifact_only,
					}),
				),
			);
			if (o.outcome !== "DECIDED") throw new Error("expected DECIDED");
			expect(o.decision.choice).not.toBe("NO_SEMANTIC_REVIEW");
		}
	});
});

describe("6 — git push / PR / deploy is absent from worker authority", () => {
	test("worker profiles reject any delivery or credential field", () => {
		for (const key of [
			"push",
			"pr",
			"merge",
			"deploy",
			"executable",
			"token",
			"api_key",
		])
			expect(
				WorkerProfile.safeParse({ ...P.clerkFastA, [key]: true }).success,
			).toBe(false);
	});

	test("remote delivery / deploy changes route to a person, never to a tier", async () => {
		for (const flag of [
			"requests_remote_delivery",
			"touches_deploy_or_credentials",
		] as const) {
			const o = await decide(
				fixedProvider({ choice: "FAST", confidence: 1 }),
				request("TASK_ROUTE", taskRoute({ change: change({ [flag]: true }) })),
			);
			if (o.outcome !== "DECIDED") throw new Error("expected DECIDED");
			expect(o.decision.route).toBe("HUMAN");
		}
	});
});

describe("7/8 — no silent profile swap; unknown / disabled / unfit profiles fail closed", () => {
	test("an assigned profile is resolved exactly, even when another sorts first", async () => {
		const r = await run(assigned("clerk-fast-b"));
		expect(r.profile).toMatchObject({
			status: "PROFILE_RECOMMENDED",
			source: "assigned",
			profile_id: "clerk-fast-b",
		});
	});

	test.each([
		["clerk-unknown", "unknown_profile"],
		["clerk-disabled", "disabled_profile"],
		["engineer-principal", "role_mismatch"],
		["reviewer-codex", "role_mismatch"],
		["clerk-specialist", "insufficient_capability"],
		["clerk-worktree", "mutability_mismatch"],
	])("assigned %p → NO_PROFILE %p, no substitute", async (id, reason) => {
		const r = await run(assigned(id));
		expect(r.profile).toEqual({
			status: "NO_PROFILE",
			reason: reason as never,
			profile_id: id,
			profile: null,
		});
	});

	test("an assigned fast clerk is not swapped up when policy requires more", async () => {
		const low = fixedProvider({ choice: "FAST", confidence: 0.1 });
		const r = await run(
			assigned("clerk-fast-a"),
			low,
			registry([...ALL, senior]),
		);
		expect(r.required_tier).toBe("senior");
		expect(r.profile).toEqual({
			status: "NO_PROFILE",
			reason: "insufficient_capability",
			profile_id: "clerk-fast-a",
			profile: null,
		});
	});

	test("an empty registry (no worker_profiles) recommends nothing", async () => {
		const r = await run(queued({ id: "e-1" }), rulesProvider(), registry([]));
		expect(r.profile.status).toBe("NO_PROFILE");
		expect(r.profile.status === "NO_PROFILE" && r.profile.reason).toBe(
			"no_matching_profile",
		);
	});

	test("disabled profiles are never selected, even as the only fast clerk", async () => {
		const r = await run(
			queued({ id: "e-2" }),
			rulesProvider(),
			registry([P.clerkDisabled, P.clerkStandard]),
		);
		expect(r.required_tier).toBe("fast");
		expect(recommendedId(r)).toBe("clerk-standard");
	});

	test("an invalid job is rejected before any decision", async () => {
		const r = await run({ ...queued({ id: "bad" }), capability: "principal" });
		expect(r.fabric).toBeNull();
		expect(r.profile).toEqual({
			status: "NO_PROFILE",
			reason: "invalid_job",
			profile_id: null,
			profile: null,
		});
	});
});

describe("HUMAN routes and unusable decisions fail closed with no profile lookup", () => {
	const guarded = (): WorkerProfileRegistry => {
		const reg = registry();
		const fail = () => {
			throw new Error("registry must not be consulted");
		};
		return { ...reg, resolve: fail, select: fail, byRole: fail, atLeast: fail };
	};

	test.each([
		[
			"HUMAN recommendation",
			() => fixedProvider({ choice: "HUMAN", confidence: 1 }),
			"route_human",
		],
		["throwing provider", () => throwingProvider(), "decision_fail_closed"],
		["hanging provider", () => hangingProvider(), "decision_fail_closed"],
		[
			"malformed output",
			() => rawProvider(() => ({ choice: "FAST" })),
			"decision_fail_closed",
		],
		[
			"chain-of-thought output",
			() =>
				rawProvider((req) => ({
					decision_kind: req.decision_kind,
					choice: "FAST",
					confidence: 1,
					provider: "fake:raw",
					input_hash: req.input_hash,
					reason_codes: [],
					reasoning: "step by step…",
				})),
			"decision_fail_closed",
		],
		[
			"unsupported choice",
			() => fixedProvider({ choice: "SPECIALIST", confidence: 1 }),
			"decision_fail_closed",
		],
	] as const)("%s → HUMAN_REQUIRED (%s)", async (_name, make, reason) => {
		const r = await run(queued({ id: "h-1" }), make(), guarded());
		expect(r.profile).toEqual({
			status: "HUMAN_REQUIRED",
			reason,
			profile_id: null,
			profile: null,
		});
		expect(r.routed_tier).toBeNull();
		expect(r.required_tier).toBeNull();
		expect(r.fabric?.outcome).toBe("DECIDED");
	});

	test("an invalid scope fails closed (input rejected, provider not asked)", async () => {
		const r = await dryRunSupportRoute(
			{ job: queued({ id: "h-2" }), scope: "HUGE" as never },
			{ provider: throwingProvider(), registry: guarded() },
		);
		expect(r.profile.status).toBe("HUMAN_REQUIRED");
		if (r.fabric?.outcome !== "DECIDED") throw new Error("expected DECIDED");
		expect(r.fabric.recommendation_status).toBe("NOT_REQUESTED");
	});
});

// ── live-off / approval binding untouched (9, 10) ────────────────────────────────────────────

describe("9/10 — no live provider; live-off config and policy hash unchanged", () => {
	const ROOT = "/tmp/agentcity-model-factory";
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
	const oldPolicyHash = (cfg: ManagedConfig) =>
		sha256Hex(
			canonicalJson({
				repo: cfg.repos.find((r) => r.id === REPO) ?? null,
				live: cfg.live,
				git: cfg.git_executable,
				limits: cfg.limits,
				workspace_root: cfg.workspace_root,
				artifacts_root: cfg.artifacts_root,
			}),
		);

	test("a profile-less config parses as before and hashes exactly as before", () => {
		const cfg = parseManagedConfig(RAW);
		expect("worker_profiles" in cfg).toBe(false);
		expect(cfg.live).toEqual({ enabled: false });
		expect(policyHash(cfg, REPO)).toBe(oldPolicyHash(cfg));
		const empty = parseManagedConfig({ ...RAW, worker_profiles: [] });
		expect(policyHash(empty, REPO)).toBe(oldPolicyHash(cfg));
	});

	test("enabled profiles are bound by the policy hash but leave live off; disabled ones are not bound", () => {
		const cfg = parseManagedConfig({ ...RAW, worker_profiles: ALL });
		expect(cfg.live).toEqual({ enabled: false });
		expect(policyHash(cfg, REPO)).not.toBe(oldPolicyHash(cfg));
		const allOff = parseManagedConfig({
			...RAW,
			worker_profiles: ALL.map((p) => ({ ...p, enabled: false })),
		});
		expect(policyHash(allOff, REPO)).toBe(oldPolicyHash(allOff));
	});

	test("config → registry → dry run launches nothing", async () => {
		const cfg = parseManagedConfig({ ...RAW, worker_profiles: ALL });
		const reg = workerProfileRegistryFromConfig(cfg);
		const r = await run(queued({ id: "cfg-1" }), rulesProvider(), reg);
		expect(recommendedId(r)).toBe("clerk-fast-a");
		expect(touched).toEqual([]);
	});
});
