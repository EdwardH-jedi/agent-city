// planSupportLaunches: scheduler (concurrency 4, order, cancelled/disabled) × Decision Fabric routing ×
// Worker Profile Registry (exact resolution, max_concurrency) — a plan only; nothing starts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { WorkerProfileInput } from "@agent-city/schema";
import {
	fixedProvider,
	throwingProvider,
} from "../decision-fabric/fake-provider.ts";
import type { DecisionProvider } from "../decision-fabric/provider.ts";
import {
	buildWorkerProfileRegistry,
	type WorkerProfileRegistry,
} from "../managed/worker-profile-registry.ts";
import type { SupportJob } from "../support-jobs/job.ts";
import {
	assignSupportProfile,
	startSupportJob,
} from "../support-jobs/state.ts";
import {
	cancelled,
	cancelRequested,
	queued,
	running,
	seededShuffle,
} from "../support-jobs/testkit.ts";
import {
	MAX_PLAN_ROUTED,
	planSupportLaunches,
	type SupportLaunchPlan,
} from "./support-launch-plan.ts";

const clerk = (
	profile_id: string,
	over: Partial<WorkerProfileInput> = {},
): WorkerProfileInput => ({
	profile_id,
	provider: "claude",
	role: "clerk",
	capability_tier: "fast",
	model: "synthetic-model",
	mutability: "read_only",
	latency_class: "low",
	cost_class: "low",
	max_concurrency: 16,
	...over,
});

const REG = buildWorkerProfileRegistry([
	clerk("clerk-fast"),
	clerk("clerk-off", { enabled: false }),
]);

const plan = (
	jobs: readonly SupportJob[],
	opts: {
		provider?: DecisionProvider;
		registry?: WorkerProfileRegistry;
		concurrency?: number;
	} = {},
): Promise<SupportLaunchPlan> =>
	planSupportLaunches(
		jobs,
		{
			provider:
				opts.provider ?? fixedProvider({ choice: "FAST", confidence: 0.9 }),
			registry: opts.registry ?? REG,
			decide_options: { timeout_ms: 50 },
			scope_of: () => "TRIVIAL",
		},
		opts.concurrency ? { concurrency: opts.concurrency } : {},
	);

const assigned = (id: string, profile: string, seq = 0) => {
	const r = assignSupportProfile(queued({ id, seq }), profile);
	if (!r.ok) throw new Error(r.error);
	return r.job;
};
const runningOn = (id: string, profile: string) => {
	const r = startSupportJob(assigned(id, profile));
	if (!r.ok) throw new Error(r.error);
	return r.job;
};
const ids = (p: SupportLaunchPlan) => p.launch.map((l) => l.job_id);
const queuedN = (n: number, prefix = "q", firstSeq = 0) =>
	Array.from({ length: n }, (_, i) =>
		queued({
			id: `${prefix}-${String(i).padStart(3, "0")}`,
			seq: firstSeq + i,
		}),
	);

const touched: string[] = [];
const saved = { fetch: globalThis.fetch, spawn: Bun.spawn };
beforeAll(() => {
	const trap = (name: string) => () => {
		touched.push(name);
		throw new Error(`${name} is not allowed in a launch plan`);
	};
	globalThis.fetch = trap("fetch") as unknown as typeof fetch;
	Bun.spawn = trap("Bun.spawn") as unknown as typeof Bun.spawn;
});
afterAll(() => {
	globalThis.fetch = saved.fetch;
	Bun.spawn = saved.spawn;
	expect(touched).toEqual([]);
});

describe("capacity and order come from the scheduler", () => {
	test("default concurrency 4: four jobs in scheduler order, each on the fast clerk", async () => {
		const p = await plan(queuedN(6));
		expect(ids(p)).toEqual(["q-000", "q-001", "q-002", "q-003"]);
		expect(p.launch.every((l) => l.profile_id === "clerk-fast")).toBe(true);
		expect(p).toMatchObject({
			mode: "DRY_RUN",
			authority: "ADVISORY",
			running: 0,
			available_slots: 4,
			held: [],
			truncated: false,
		});
	});

	test("running jobs consume capacity", async () => {
		const p = await plan([
			running({ id: "r-1" }),
			running({ id: "r-2" }),
			...queuedN(5),
		]);
		expect(p.running).toBe(2);
		expect(ids(p)).toEqual(["q-000", "q-001"]);
	});

	test("cancelled, cancel-requested and disabled jobs are never planned", async () => {
		const p = await plan([
			cancelled({ id: "c-1" }),
			cancelRequested({ id: "c-2" }),
			queued({ id: "d-1", disabled: true }),
			queued({ id: "ok-1", seq: 5 }),
		]);
		// the cancel-requested job is still RUNNING: it holds a slot
		expect(p.running).toBe(1);
		expect(ids(p)).toEqual(["ok-1"]);
		expect(p.held).toEqual([]);
	});

	test("the plan is deterministic and ignores input order", async () => {
		const jobs = [
			...queuedN(7, "q", 1),
			assigned("x-unknown", "clerk-gone", 0),
		];
		const a = await plan(jobs);
		for (const seed of [1, 7, 42]) {
			const b = await plan(seededShuffle(jobs, seed));
			expect(b).toEqual(a);
		}
	});
});

describe("profile routing fails closed and never falls back", () => {
	test("an unknown assigned profile is held; the next eligible job takes its slot", async () => {
		const p = await plan([
			assigned("a-gone", "clerk-gone", 0),
			...queuedN(5, "q", 1),
		]);
		expect(p.held.map((h) => [h.job_id, h.reason])).toEqual([
			["a-gone", "no_profile"],
		]);
		expect(p.held[0]?.route.profile).toMatchObject({
			reason: "unknown_profile",
		});
		expect(ids(p)).toEqual(["q-000", "q-001", "q-002", "q-003"]);
	});

	test("a disabled assigned profile is held, never swapped for the enabled clerk", async () => {
		const p = await plan([assigned("a-off", "clerk-off")]);
		expect(p.launch).toEqual([]);
		expect(p.held[0]?.route.profile).toMatchObject({
			status: "NO_PROFILE",
			reason: "disabled_profile",
		});
	});

	test("no enabled clerk at all → every picked job is held (no_profile)", async () => {
		const p = await plan(queuedN(3), {
			registry: buildWorkerProfileRegistry([
				clerk("clerk-off", { enabled: false }),
			]),
		});
		expect(p.launch).toEqual([]);
		expect(p.held.map((h) => h.reason)).toEqual([
			"no_profile",
			"no_profile",
			"no_profile",
		]);
	});

	test("an unusable decision provider → human_required, nothing planned", async () => {
		const p = await plan(queuedN(2), { provider: throwingProvider() });
		expect(p.launch).toEqual([]);
		expect(p.held.map((h) => h.reason)).toEqual([
			"human_required",
			"human_required",
		]);
	});
});

describe("a profile serves at most its max_concurrency jobs", () => {
	test("jobs beyond a full profile are held, not moved to another profile", async () => {
		const reg = buildWorkerProfileRegistry([
			clerk("clerk-fast", { max_concurrency: 2 }),
			clerk("clerk-spare", { capability_tier: "standard" }),
		]);
		const p = await plan([runningOn("r-1", "clerk-fast"), ...queuedN(5)], {
			registry: reg,
		});
		expect(ids(p)).toEqual(["q-000"]);
		expect(p.launch[0]?.profile_id).toBe("clerk-fast");
		expect(p.held.every((h) => h.reason === "profile_at_capacity")).toBe(true);
		expect(p.held.map((h) => h.job_id)).toEqual([
			"q-001",
			"q-002",
			"q-003",
			"q-004",
		]);
	});
});

describe("bounded and side-effect free", () => {
	test("at most MAX_PLAN_ROUTED jobs are routed per plan", async () => {
		const jobs = Array.from({ length: 100 }, (_, i) =>
			assigned(`b-${String(i).padStart(3, "0")}`, "clerk-gone", i),
		);
		const p = await plan(jobs, { concurrency: 16 });
		expect(p.launch).toEqual([]);
		expect(p.held).toHaveLength(MAX_PLAN_ROUTED);
		expect(p.truncated).toBe(true);
	});

	test("the snapshot is not modified and the plan is frozen", async () => {
		const jobs = queuedN(3);
		const before = structuredClone(jobs);
		const p = await plan(jobs);
		expect(jobs).toEqual(before);
		expect(
			jobs.every((j) => j.status === "QUEUED" && j.profile_id === null),
		).toBe(true);
		expect(Object.isFrozen(p)).toBe(true);
		expect(Object.isFrozen(p.launch)).toBe(true);
	});

	test("invalid scheduler options throw like the scheduler", async () => {
		await expect(plan(queuedN(1), { concurrency: 99 })).rejects.toThrow();
	});
});
