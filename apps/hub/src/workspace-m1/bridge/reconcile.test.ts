// Engine → workspace reconciliation through the real Orchestrator (fake adapters) with authorize +
// onChange wired to the bridge exactly as the hub will: run linkage, fake success / failure,
// Gate 2 opened exactly once at human_ready, acceptance keeps the engine human_ready.
import { afterEach, describe, expect, test } from "bun:test";
import { sealAnyResultEnvelope } from "@agent-city/schema/workspace-m1/hash";
import {
	approved,
	decide,
	draft,
	dump,
	engineOf,
	makeBridgeEnv,
	resultRequests,
	runsOf,
	stageOf,
	tracker,
} from "./test-support.ts";

const t = tracker();
afterEach(() => t.cleanup());

describe("run linkage and Gate 2", () => {
	test("approved proposal → queued → running → human_ready → exactly one pending Gate-2 request bound to this execution", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(env, v);
		await env.bridge.idle();
		expect(stageOf(env, ids.taskId)).toBe("queued");
		expect(engineOf(env, ids.managedTaskId)?.state).toBe("queued");

		const stages: string[] = [];
		const orch = env.engine({
			hooks: {
				at: async () => {
					await env.bridge.idle();
					stages.push(stageOf(env, ids.taskId) ?? "?");
				},
			},
		});
		await env.drain(orch);
		expect(stages).toContain("running");

		const managed = engineOf(env, ids.managedTaskId);
		expect(managed?.state).toBe("human_ready");
		expect(stageOf(env, ids.taskId)).toBe("awaiting_acceptance");
		const results = resultRequests(env, ids.taskId);
		expect(results).toHaveLength(1);
		const r = results[0];
		if (!r?.result_envelope) throw new Error("no envelope");
		expect(r.status).toBe("pending");
		expect(r.managed_task_id).toBe(ids.managedTaskId);
		expect(r.run_id).toBe(managed?.result_run_id ?? "");
		// explicit mapping: proposal → Gate-1 receipt → managed task → attempt → candidate → envelope
		const runReq = env.store.getApprovalRequest(ids.runRequestId);
		expect(r.proposal_id).toBe(runReq?.proposal_id ?? "");
		expect(r.execution_binding_hash).toBe(runReq?.execution_binding_hash ?? "");
		expect(r.result_envelope.run_decision_id).toBe(ids.decisionId);
		expect(r.result_envelope.attempt_no).toBe(1);
		expect(r.result_envelope.max_repairs).toBe(0);
		expect(r.result_envelope.execution_mode).toBe("simulated");
		const run = runsOf(env, ids.managedTaskId)[0];
		expect(r.result_envelope.candidate_sha).toBe(run?.candidate_sha ?? "");
		expect(r.result_envelope.manifest_hash).toBe(run?.manifest_hash ?? "");
		// the stored column is the sealer's canonical text verbatim
		const raw = env.db
			.query<{ result_envelope: string }, [string]>(
				"SELECT result_envelope FROM managed_approval_requests WHERE id = ?",
			)
			.get(r.id);
		expect(raw?.result_envelope).toBe(
			sealAnyResultEnvelope(r.result_envelope).canonical,
		);
		expect(env.alarms).toEqual([]);
		// one attempt, fake providers only
		expect(env.calls.implement).toBe(1);
		expect(env.calls.review).toBe(1);
		expect(env.calls.lookups.live).toBe(0);
	});

	test("repeated notify + concurrent sweeps open Gate 2 exactly once; a later sweep changes nothing", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(env, v);
		// engine runs without onChange wiring: the bridge learns about human_ready only below
		const orch = env.engine({ onChange: false });
		while (await orch.tick()) {
			// drain
		}
		expect(engineOf(env, ids.managedTaskId)?.state).toBe("human_ready");
		expect(stageOf(env, ids.taskId)).toBe("queued");
		for (let i = 0; i < 5; i++) env.bridge.notify(ids.managedTaskId);
		await Promise.all([env.bridge.sweep(), env.bridge.sweep()]);
		env.bridge.notify(ids.managedTaskId);
		await env.bridge.idle();
		expect(resultRequests(env, ids.taskId)).toHaveLength(1);
		expect(stageOf(env, ids.taskId)).toBe("awaiting_acceptance");
		const before = dump(env.db);
		await env.bridge.sweep();
		expect(dump(env.db)).toBe(before);
	});

	test("Gate-2 accept keeps the engine human_ready; the bridge never moves an accepted task; nothing executes", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(env, v);
		await env.drain();
		const [result] = resultRequests(env, ids.taskId);
		if (!result) throw new Error("no Gate-2 request");
		const callsBefore = { ...env.calls, lookups: { ...env.calls.lookups } };
		const runsBefore = runsOf(env, ids.managedTaskId).length;
		const res = await decide(env, v, result.id);
		expect(res.status).toBe(201);
		await env.bridge.idle();
		await env.bridge.sweep();
		await env.drain();
		expect(stageOf(env, ids.taskId)).toBe("accepted");
		expect(engineOf(env, ids.managedTaskId)?.state).toBe("human_ready");
		expect(env.store.getApprovalRequest(result.id)?.status).toBe("accepted");
		expect(runsOf(env, ids.managedTaskId)).toHaveLength(runsBefore);
		expect(env.calls).toEqual(callsBefore);
	});
});

describe("fake failures end the execution truthfully (no Gate 2)", () => {
	for (const [scenario, state, kind] of [
		["verification_fails", "failed", "verification_failed"],
		["reviewer_error", "failed", "provider_error"],
		["no_changes", "failed", "no_changes"],
		["malformed_review", "failed", "review_invalid"],
	] as const) {
		test(`${scenario} → engine ${state}/${kind} → workspace execution_ended`, async () => {
			const env = t.track(makeBridgeEnv());
			const v = await env.ctx();
			const ids = await approved(
				env,
				v,
				draft({ simulation_scenario: scenario }),
			);
			await env.drain();
			const m = engineOf(env, ids.managedTaskId);
			expect(m?.state).toBe(state);
			expect(m?.failure_kind).toBe(kind);
			expect(stageOf(env, ids.taskId)).toBe("execution_ended");
			expect(env.store.getTask(ids.taskId)?.stage_detail).toContain(kind);
			expect(resultRequests(env, ids.taskId)).toHaveLength(0);
			expect(runsOf(env, ids.managedTaskId)).toHaveLength(1);
			expect(env.alarms).toEqual([]);
		});
	}

	test("a sealed but ineligible result is recorded already invalidated(evidence_unavailable) (OQ-7)", async () => {
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
		const ids = await approved(env, v);
		await env.drain();
		expect(engineOf(env, ids.managedTaskId)?.state).toBe("human_ready");
		expect(stageOf(env, ids.taskId)).toBe("execution_ended");
		const [r] = resultRequests(env, ids.taskId);
		expect(r?.status).toBe("invalidated");
		expect(r?.invalidation_reason).toBe("evidence_unavailable");
		expect(r?.result_envelope).not.toBeNull();
	});

	test("an unsealable result: transient failures retry (no write), a permanent one ends the execution without a request", async () => {
		const { SealError } = await import("../evidence/run-evidence.ts");
		let mode: "transient" | "permanent" = "transient";
		const env = t.track(
			makeBridgeEnv({
				sealer: (real) => ({
					seal: async () => {
						throw new SealError(
							mode === "transient" ? "timeout" : "review_missing",
						);
					},
					revalidate: (r) => real.revalidate(r),
				}),
			}),
		);
		const v = await env.ctx();
		const ids = await approved(env, v);
		await env.drain();
		expect(engineOf(env, ids.managedTaskId)?.state).toBe("human_ready");
		// transient: nothing written, alarm raised, stage stays (derived phase: finalizing)
		expect(stageOf(env, ids.taskId)).toBe("running");
		expect(env.alarms.some((a) => a.kind === "seal_failed")).toBe(true);
		mode = "permanent";
		await env.bridge.sweep();
		expect(stageOf(env, ids.taskId)).toBe("execution_ended");
		expect(env.store.getTask(ids.taskId)?.stage_detail).toContain(
			"review_missing",
		);
		expect(resultRequests(env, ids.taskId)).toHaveLength(0);
	});
});
