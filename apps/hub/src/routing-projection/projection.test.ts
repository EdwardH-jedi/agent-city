// Workspace routing recommendation projection (display contract): real model-factory dry runs over the
// deterministic fake providers, projected to profile / tier / policy reason / status — and every
// malformed, inconsistent or hostile input is UNAVAILABLE, never a throw. The projection is advisory
// and display-only: nothing here assigns, runs, queues, proposes or approves.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkerProfileInput } from "@agent-city/schema";
import {
	rulesProvider,
	throwingProvider,
} from "../decision-fabric/fake-provider.ts";
import { change } from "../decision-fabric/testkit.ts";
import { buildWorkerProfileRegistry } from "../managed/worker-profile-registry.ts";
import {
	type DryRunTaskRequest,
	dryRunTaskRoute,
} from "../model-factory/dry-run-route.ts";
import {
	projectRoutingRecommendation,
	ROUTING_PROJECTION_VERSION,
	UNAVAILABLE_REASON,
} from "./projection.ts";

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

const registry = buildWorkerProfileRegistry([
	profile({ profile_id: "impl-standard", capability_tier: "standard" }),
	profile({ profile_id: "impl-senior", capability_tier: "senior" }),
	profile({ profile_id: "impl-principal", capability_tier: "principal" }),
]);
const juniorOnly = buildWorkerProfileRegistry([
	profile({ profile_id: "impl-standard", capability_tier: "standard" }),
]);

const route = (
	req: Partial<DryRunTaskRequest> = {},
	deps: Partial<Parameters<typeof dryRunTaskRoute>[1]> = {},
) =>
	dryRunTaskRoute(
		{ change: change(), scope: "SMALL", ...req },
		{ provider: rulesProvider(), registry, ...deps },
	);

const KEYS = [
	"authority",
	"display_only",
	"policy_override",
	"policy_reasons",
	"profile_id",
	"profile_source",
	"projection_version",
	"status",
	"status_reason",
	"tier",
];

describe("projection of real dry runs", () => {
	test("RECOMMENDED: the selected profile at the routed tier, no policy change", async () => {
		const v = projectRoutingRecommendation(await route());
		expect(v).toEqual({
			projection_version: ROUTING_PROJECTION_VERSION,
			authority: "ADVISORY",
			display_only: true,
			status: "RECOMMENDED",
			profile_id: "impl-standard",
			profile_source: "selected",
			tier: "standard",
			policy_reasons: [],
			policy_override: false,
			status_reason: null,
		});
		expect(Object.keys(v).sort()).toEqual(KEYS);
		expect(Object.isFrozen(v)).toBe(true);
		expect(Object.isFrozen(v.policy_reasons)).toBe(true);
	});

	test("a policy floor raises the tier and is shown as the policy reason", async () => {
		const v = projectRoutingRecommendation(
			await route({ change: change({ touches_auth: true }), scope: "TRIVIAL" }),
		);
		expect(v).toMatchObject({
			status: "RECOMMENDED",
			profile_id: "impl-senior",
			tier: "senior",
			policy_override: true,
		});
		expect(v.policy_reasons).toContain("AUTH_ROUTE_FLOOR");
	});

	test("a trusted minimum tier raises the tier; a configured profile is resolved exactly", async () => {
		expect(
			projectRoutingRecommendation(
				await route({ min_capability: "principal" }),
			),
		).toMatchObject({
			status: "RECOMMENDED",
			profile_id: "impl-principal",
			tier: "principal",
		});
		expect(
			projectRoutingRecommendation(await route({ profile_id: "impl-senior" })),
		).toMatchObject({
			status: "RECOMMENDED",
			profile_id: "impl-senior",
			profile_source: "assigned",
		});
	});

	test("HUMAN_REQUIRED: deploy / credentials and remote delivery never get a profile or a tier", async () => {
		for (const c of [
			change({ touches_deploy_or_credentials: true }),
			change({ requests_remote_delivery: true }),
		]) {
			const v = projectRoutingRecommendation(await route({ change: c }));
			expect(v).toMatchObject({
				status: "HUMAN_REQUIRED",
				profile_id: null,
				profile_source: null,
				tier: null,
				status_reason: "route_human",
			});
			expect(
				v.policy_reasons.some(
					(r) =>
						r === "DEPLOY_OR_CREDENTIALS_HUMAN_ONLY" ||
						r === "REMOTE_DELIVERY_OUT_OF_SCOPE",
				),
			).toBe(true);
		}
	});

	test("HUMAN_REQUIRED: a provider failure fails closed", async () => {
		const v = projectRoutingRecommendation(
			await route({}, { provider: throwingProvider() }),
		);
		expect(v.status).toBe("HUMAN_REQUIRED");
		expect(v.tier).toBeNull();
		expect(["decision_fail_closed", "route_human"]).toContain(
			v.status_reason as string,
		);
		expect(v.policy_reasons).toContain("FAIL_CLOSED_NO_RECOMMENDATION");
	});

	test("NO_PROFILE: the needed tier is shown, no profile is substituted", async () => {
		expect(
			projectRoutingRecommendation(
				await route(
					{ change: change({ touches_security: true }) },
					{ registry: juniorOnly },
				),
			),
		).toMatchObject({
			status: "NO_PROFILE",
			profile_id: null,
			tier: "senior",
			status_reason: "no_matching_profile",
		});
		expect(
			projectRoutingRecommendation(await route({ profile_id: "impl-missing" })),
		).toMatchObject({
			status: "NO_PROFILE",
			profile_id: "impl-missing",
			profile_source: null,
			status_reason: "unknown_profile",
		});
	});

	test("deterministic and side-effect free: same dry run → equal projection; the dry run is untouched", async () => {
		const r = await route({ change: change({ touches_db_migration: true }) });
		const before = JSON.stringify(r);
		expect(projectRoutingRecommendation(r)).toEqual(
			projectRoutingRecommendation(r),
		);
		expect(JSON.stringify(r)).toBe(before);
	});
});

describe("fail closed: anything that is not a coherent dry run is UNAVAILABLE", () => {
	const UNAVAILABLE = {
		status: "UNAVAILABLE",
		profile_id: null,
		profile_source: null,
		tier: null,
		policy_reasons: [],
		policy_override: false,
		status_reason: UNAVAILABLE_REASON,
	};

	test("malformed or inconsistent input", async () => {
		const ok = JSON.parse(JSON.stringify(await route()));
		const human = JSON.parse(
			JSON.stringify(
				await route({ change: change({ requests_remote_delivery: true }) }),
			),
		);
		for (const bad of [
			null,
			undefined,
			42,
			"RECOMMENDED",
			[],
			{},
			{ ...ok, mode: "LIVE" },
			{ ...ok, authority: "AUTHORITATIVE" },
			{ ...ok, required_tier: "godlike" },
			{ ...ok, required_tier: null }, // a recommendation without a tier
			{ ...ok, profile: { ...ok.profile, status: "ASSIGNED" } },
			{ ...ok, profile: { ...ok.profile, profile_id: "../../etc/passwd" } },
			{ ...ok, profile: { ...ok.profile, profile_id: "x".repeat(129) } },
			{
				...ok,
				fabric: {
					...ok.fabric,
					decision: { ...ok.fabric.decision, reason_codes: ["MADE_UP_RULE"] },
				},
			},
			{ ...ok, fabric: { outcome: "DECIDED" } }, // decided but no enforced decision
			{ ...human, required_tier: "senior" }, // a person decides, yet a tier is claimed
		])
			expect(projectRoutingRecommendation(bad)).toMatchObject(UNAVAILABLE);
	});

	test("a hostile object (throwing getter / Proxy trap) never escapes as a throw", async () => {
		const ok = await route();
		const getter = { ...ok };
		Object.defineProperty(getter, "profile", {
			enumerable: true,
			get() {
				throw new Error("boom");
			},
		});
		const proxy = new Proxy(
			{},
			{
				get() {
					throw new Error("trap");
				},
				ownKeys() {
					throw new Error("trap");
				},
			},
		);
		for (const hostile of [getter, proxy])
			expect(projectRoutingRecommendation(hostile)).toMatchObject(UNAVAILABLE);
	});

	test("extra keys in the dry run are ignored, never copied into the view", async () => {
		const ok = JSON.parse(JSON.stringify(await route()));
		const v = projectRoutingRecommendation({
			...ok,
			command: "git push",
			profile: { ...ok.profile, model: "secret-model", argv: ["rm", "-rf"] },
		});
		expect(v.status).toBe("RECOMMENDED");
		expect(Object.keys(v).sort()).toEqual(KEYS);
		expect(JSON.stringify(v)).not.toMatch(/git push|secret-model|rm/);
	});
});

describe("boundary: display-only, outside every proposal / gate path", () => {
	const HUB_SRC = join(import.meta.dir, "..");

	test("the projection imports only pure modules and does no I/O", () => {
		const sources = readdirSync(import.meta.dir).filter(
			(f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
		);
		expect(sources).toEqual(["projection.ts"]);
		const text = readFileSync(join(import.meta.dir, "projection.ts"), "utf8");
		const specs = [...text.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]);
		expect(specs.sort()).toEqual([
			"../decision-fabric/policy.ts",
			"../support-jobs/guards.ts",
			"@agent-city/schema",
			"zod",
		]);
		expect(text).not.toMatch(
			/\bfetch\s*\(|\bBun\.|child_process|process\.env|\brequire\s*\(|\bimport\s*\(|setTimeout|setInterval|node:/,
		);
		expect(text).not.toMatch(
			/workspace-m1|store\.ts|db\.ts|hono|orchestrator|adapters|proc\.ts|decide\(|recommend\(|assignSupportProfile/,
		);
	});

	test("nothing in the hub, the web app or the schema package imports it yet (no route, no proposal hash)", () => {
		const roots = [
			HUB_SRC,
			join(HUB_SRC, "..", "..", "web", "src"),
			join(HUB_SRC, "..", "..", "..", "packages", "schema", "src"),
		];
		const hits: string[] = [];
		const walk = (dir: string) => {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				const p = join(dir, e.name);
				if (e.isDirectory()) {
					if (e.name !== "node_modules" && e.name !== "routing-projection")
						walk(p);
				} else if (/\.(ts|tsx)$/.test(e.name)) {
					if (readFileSync(p, "utf8").includes("routing-projection"))
						hits.push(p);
				}
			}
		};
		for (const r of roots) walk(r);
		expect(hits).toEqual([]);
	});
});
