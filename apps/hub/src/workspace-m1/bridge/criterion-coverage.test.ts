// v1.2 §A through the real bridge: Gate 2 opens only for an envelope that satisfies
// resultEligibilityV1_2 against its proposal; a clean v1.2 run carries its coverage; the result of a
// legacy v1 proposal (approved before the obsolete-grant policy) is recorded invalidated with the
// explicit "new proposal + approval" detail. Today such a grant is refused before execution
// (bridge/obsolete-v1-grant.test.ts); this pins the honest record of one approved earlier.
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
	isProposalV1_2,
	isResultV1_2,
	resultEligibilityV1_2,
} from "@agent-city/schema/workspace-m1";
import { createManagedBridge } from "../decisions/index.ts";
import {
	approveLegacyV1Raw,
	publishLegacyV1,
} from "../decisions/test-support.ts";
import { LEGACY_PROPOSAL_DETAIL, SEALED_DIR } from "../evidence/bundle.ts";
import {
	approved,
	createTask,
	makeBridgeEnv,
	resultRequests,
	stageOf,
	tracker,
} from "./test-support.ts";

const t = tracker();
afterEach(() => t.cleanup());

describe("Gate-2 opening under v1.2", () => {
	test("a clean v1.2 run opens Gate 2 with the derived coverage (all satisfied)", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(env, v);
		await env.drain();
		const [r] = resultRequests(env, ids.taskId);
		expect(r?.status).toBe("pending");
		const envelope = r?.result_envelope;
		const proposal = r ? env.store.getProposal(r.proposal_id)?.snapshot : null;
		if (
			!envelope ||
			!isResultV1_2(envelope) ||
			!proposal ||
			!isProposalV1_2(proposal)
		)
			throw new Error("expected v1.2 proposal + envelope");
		expect(envelope.criterion_coverage.map((c) => c.status)).toEqual(
			proposal.criteria.map(() => "satisfied"),
		);
		expect(resultEligibilityV1_2(envelope, proposal).eligible).toBe(true);
		expect(stageOf(env, ids.taskId)).toBe("awaiting_acceptance");
	});

	test("the result of a legacy v1 proposal approved before the obsolete-grant policy is recorded invalidated(evidence_unavailable): a new proposal + approval are required", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const taskId = createTask(env, v);
		const legacy = await publishLegacyV1(env, taskId);
		// approved + executed by the PRE-policy hub (no reconciler wake-up, no workspace authorize)
		approveLegacyV1Raw(
			{
				store: env.store,
				auth: env.auth,
				tick: env.tick,
				services: {
					bridge: createManagedBridge({ db: env.db, config: env.config }),
				},
			},
			v,
			legacy.runRequestId,
		);
		await env.drain(env.engine({ authorize: false, onChange: false }));
		await env.bridge.sweep();
		const [r] = resultRequests(env, taskId);
		expect(r?.status).toBe("invalidated");
		expect(r?.invalidation_reason).toBe("evidence_unavailable");
		expect(r?.invalidation_detail).toContain(LEGACY_PROPOSAL_DETAIL);
		expect(r?.result_envelope?.contract).toBe("agentcity.result/v1");
		expect(r?.evidence_bundle_digest).toBeUndefined();
		expect(stageOf(env, taskId)).toBe("execution_ended");
		expect(env.store.getTask(taskId)?.stage_detail).toContain(
			"criteria_unmapped",
		);
		let bundles: string[] = [];
		try {
			bundles = readdirSync(join(env.config.artifacts_root, SEALED_DIR));
		} catch {
			bundles = [];
		}
		expect(bundles.filter((n) => n.endsWith(".bundle"))).toEqual([]);
	});
});
