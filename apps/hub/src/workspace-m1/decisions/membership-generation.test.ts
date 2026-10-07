// T0-FINAL-P2-01 (docs/workspace-m1/REPAIR_READ_CONTRACT_2026-10-05.md, "Inbox membership generation"): an
// inbox scope's `membership_generation` counts the requests that ever entered its pending set. A request the
// production reconciler records already closed (a sealed but ineligible result → invalidated
// (evidence_unavailable) at birth, OQ-7) never was pending, so it changes no generation; an eligible result
// opens a pending Gate 2 and changes exactly the scopes that hold it. Real bridge, engine and read model; fake
// adapters only.
import { afterEach, describe, expect, test } from "bun:test";
import {
	approved,
	type BridgeEnv,
	makeBridgeEnv,
	resultRequests,
	tracker,
} from "../bridge/test-support.ts";
import { createWorkspaceReadModel } from "./read-model.ts";

const t = tracker();
afterEach(() => t.cleanup());

/** Every inbox scope of the fixture: global, per gate, the repository, and the snapshot's first page. */
function generations(env: BridgeEnv) {
	const reads = createWorkspaceReadModel({
		store: env.store,
		config: env.config,
		bridge: env.services.bridge,
		clock: env.clock,
	});
	const of = (query: Record<string, string>) => {
		const r = reads.inbox(query, env.now());
		if (!r.ok) throw new Error(`inbox ${r.status}`);
		return { total: r.body.page.total, gen: r.body.page.membership_generation };
	};
	const snap = reads.snapshot(env.now());
	if (!snap.ok) throw new Error(`snapshot ${snap.status}`);
	return {
		global: of({}),
		run: of({ kind: "run" }),
		result: of({ kind: "result" }),
		repo: of({ repo_id: env.fx.repoId }),
		snapshot: snap.body.pending_page?.membership_generation,
	};
}

describe("T0-FINAL-P2-01 — a request created already closed never changes a membership generation", () => {
	test("sealed but ineligible result (invalidated at birth, rev 1): every scope keeps its generation", async () => {
		const env = t.track(
			makeBridgeEnv({
				sealer: (real) => ({
					seal: async (input) => {
						const s = await real.seal(input);
						return {
							...s,
							eligibility: {
								...s.eligibility,
								eligible: false,
								reasons: ["evidence_not_verified"],
							},
						};
					},
					revalidate: (r) => real.revalidate(r),
				}),
			}),
		);
		const v = await env.ctx();
		const ids = await approved(env, v); // Gate 1 opened and closed (approved) before the baseline
		const before = generations(env);
		expect(before.global.gen).toMatch(/^v1:[0-9a-f]{16}:1:0$/);
		expect(before.snapshot).toBe(before.global.gen);
		await env.drain();
		const [r] = resultRequests(env, ids.taskId);
		expect(r).toMatchObject({
			kind: "result",
			status: "invalidated",
			invalidation_reason: "evidence_unavailable",
			rev: 1,
		});
		expect(generations(env)).toEqual(before);
	});

	test("control — an eligible result opens a pending Gate 2: the scopes holding it change, the run gate does not", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(env, v);
		const before = generations(env);
		await env.drain();
		const [r] = resultRequests(env, ids.taskId);
		expect(r).toMatchObject({ kind: "result", status: "pending", rev: 1 });
		const after = generations(env);
		expect(after.global).toEqual({
			total: 1,
			gen: expect.stringMatching(/^v1:[0-9a-f]{16}:2:1$/),
		});
		expect(after.result.gen).not.toBe(before.result.gen);
		expect(after.repo.gen).not.toBe(before.repo.gen);
		expect(after.snapshot).toBe(after.global.gen);
		expect(after.run).toEqual(before.run);
	});
});
