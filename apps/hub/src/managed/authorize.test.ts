// The orchestrator's injected authorization (M1 L3): checked with the approval binding before every
// stage, so a denied task launches no adapter at all, and a denial discovered later stops the next
// stage. The workspace bridge plugs "approved Gate-1 decision" into this hook.
import { afterEach, describe, expect, test } from "bun:test";
import type { ExecutionMode, ManagedTask } from "@agent-city/schema";
import type { AdapterSet } from "./adapters/types.ts";
import { Orchestrator } from "./orchestrator.ts";
import {
	type ManagedDeps,
	runTask,
	submitTask,
	taskDetail,
} from "./service.ts";
import { type Fixture, makeFixture } from "./testkit.ts";
import { createAdapters } from "./worker.ts";

let fixtures: Fixture[] = [];
afterEach(() => {
	for (const f of fixtures) f.cleanup();
	fixtures = [];
});

/**
 * Real fake adapters, counted where work would start: every preflight / implement / review call.
 * (Obtaining an adapter object — e.g. the availability check at claim — launches nothing.)
 */
function counted(inner: AdapterSet) {
	const calls = { implementer: 0, reviewer: 0 };
	const adapters: AdapterSet = {
		implementer(mode: ExecutionMode) {
			const a = inner.implementer(mode);
			if (!a) return a;
			return {
				...a,
				preflight: (ctx) => {
					calls.implementer++;
					return a.preflight(ctx);
				},
				implement: (...args) => {
					calls.implementer++;
					return a.implement(...args);
				},
			};
		},
		reviewer(mode: ExecutionMode) {
			const a = inner.reviewer(mode);
			if (!a) return a;
			return {
				...a,
				preflight: (ctx) => {
					calls.reviewer++;
					return a.preflight(ctx);
				},
				review: (input, ctx) => {
					calls.reviewer++;
					return a.review(input, ctx);
				},
			};
		},
	};
	return { adapters, calls };
}

let keySeq = 0;
async function drive(authorize: (t: ManagedTask) => string | null) {
	const fx = makeFixture();
	fixtures.push(fx);
	const deps: ManagedDeps = { db: fx.db, config: fx.config };
	const { adapters, calls } = counted(createAdapters(fx.config));
	const seen: string[] = [];
	const orch = new Orchestrator({
		db: fx.db,
		config: fx.config,
		adapters,
		heartbeatMs: 50,
		authorize: (t) => {
			seen.push(t.state);
			return authorize(t);
		},
	});
	const { task } = await submitTask(deps, {
		idempotency_key: `authz-key-${++keySeq}`,
		repo_id: fx.repoId,
		title: "Authorization hook",
		objective: "Exercise the injected authorization check.",
		acceptance_criteria: ["The fixture check passes"],
		approved_scope: ["."],
		execution_mode: "simulated",
		simulation_scenario: "approve",
		repair_limit: 0,
	});
	runTask(deps, task.id);
	while (await orch.tick()) {
		// drain
	}
	return { detail: await taskDetail(deps, task.id), calls, seen };
}

describe("injected authorization", () => {
	test("allowed at every stage → the pipeline runs to human_ready", async () => {
		const { detail, calls, seen } = await drive(() => null);
		expect(detail.task.state).toBe("human_ready");
		expect(calls.implementer).toBeGreaterThan(0);
		expect(calls.reviewer).toBeGreaterThan(0);
		// checked before each stage: queued (start), executing, verifying, reviewing
		expect(seen).toEqual(["queued", "executing", "verifying", "reviewing"]);
	});

	test("denied before the first stage → approval_void, no attempt, no adapter call", async () => {
		const { detail, calls } = await drive(() => "no approved Gate-1 decision");
		expect(detail.task.state).toBe("blocked");
		expect(detail.task.failure_kind).toBe("approval_void");
		expect(detail.task.state_detail).toContain("not authorized");
		expect(detail.runs).toHaveLength(0);
		expect(calls).toEqual({ implementer: 0, reviewer: 0 });
	});

	test("denied at a later stage → that stage and everything after it never launches", async () => {
		const { detail, calls } = await drive((t) =>
			t.state === "reviewing" ? "the decision was invalidated" : null,
		);
		expect(detail.task.state).toBe("blocked");
		expect(detail.task.failure_kind).toBe("approval_void");
		expect(calls.implementer).toBeGreaterThan(0);
		expect(calls.reviewer).toBe(0);
	});

	test("a throwing check is a denial (fail closed)", async () => {
		const { detail, calls } = await drive(() => {
			throw new Error("db unavailable");
		});
		expect(detail.task.failure_kind).toBe("approval_void");
		expect(detail.task.state_detail).toContain("authorization check failed");
		expect(calls).toEqual({ implementer: 0, reviewer: 0 });
	});
});
