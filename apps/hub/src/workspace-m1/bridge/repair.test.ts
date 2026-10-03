// Repair policy through the bridge (existing engine, unpatched): default 0; one repair only when the
// immutable proposal allows it; forbidden classes never repair; the repaired result binds the NEW
// candidate (fresh verification, fresh review, attempt 2) and Gate 2 opens on it. The L-11 gaps of
// the current engine (scope-expanding findings, revocation right before a repair) are in
// repair-patch.test.ts together with the post-patch expectations.
import { afterEach, describe, expect, test } from "bun:test";
import type { Finding } from "@agent-city/schema";
import {
	approved,
	artifactFile,
	draft,
	engineOf,
	makeBridgeEnv,
	resultRequests,
	runsOf,
	scriptedReviewer,
	stageOf,
	tamper,
	tracker,
} from "./test-support.ts";

const t = tracker();
afterEach(() => t.cleanup());

const finding = (file: string | null): Finding => ({
	severity: "major",
	title: "Scripted defect",
	detail: "Scripted reviewer finding for the repair-policy tests.",
	file,
	line: file ? 1 : null,
	actionable: true,
});

describe("repair limit 0 (default)", () => {
	for (const [scenario, kind] of [
		["reject_then_approve", "review_rejected"],
		["verification_fails_then_fixed", "verification_failed"],
	] as const) {
		test(`${scenario} → ${kind}; one attempt; no repair`, async () => {
			const env = t.track(makeBridgeEnv());
			const v = await env.ctx();
			const ids = await approved(
				env,
				v,
				draft({ simulation_scenario: scenario }),
			);
			await env.drain();
			const m = engineOf(env, ids.managedTaskId);
			expect(m?.repair_limit).toBe(0);
			expect(m?.state).toBe("failed");
			expect(m?.failure_kind).toBe(kind);
			expect(runsOf(env, ids.managedTaskId)).toHaveLength(1);
			expect(env.calls.implement).toBe(1);
			expect(stageOf(env, ids.taskId)).toBe("execution_ended");
		});
	}
});

describe("repair limit 1 (pre-approved in the immutable proposal)", () => {
	for (const scenario of [
		"reject_then_approve",
		"verification_fails_then_fixed",
	] as const) {
		test(`${scenario} → one repair; Gate 2 binds attempt 2's new candidate, fresh verification and review`, async () => {
			const env = t.track(makeBridgeEnv());
			const v = await env.ctx();
			const ids = await approved(
				env,
				v,
				draft({
					simulation_scenario: scenario,
					repair_policy: { max_repairs: 1 },
				}),
			);
			await env.drain();
			const m = engineOf(env, ids.managedTaskId);
			expect(m?.repair_limit).toBe(1);
			expect(m?.state).toBe("human_ready");
			const [a1, a2] = runsOf(env, ids.managedTaskId);
			expect(a1?.kind).toBe("initial");
			expect(a1?.outcome).toBe("rejected");
			expect(a2?.kind).toBe("repair");
			expect(a2?.parent_run_id).toBe(a1?.id ?? "");
			expect(a2?.parent_sha).toBe(a1?.candidate_sha ?? "");
			expect(a2?.candidate_sha).not.toBe(a1?.candidate_sha ?? "");
			expect(a2?.manifest_hash).not.toBe(a1?.manifest_hash ?? "");
			expect(m?.result_run_id).toBe(a2?.id ?? "");
			expect(env.calls.implement).toBe(2);

			expect(stageOf(env, ids.taskId)).toBe("awaiting_acceptance");
			const [r] = resultRequests(env, ids.taskId);
			const e = r?.result_envelope;
			if (!e) throw new Error("no envelope");
			expect(r?.status).toBe("pending");
			expect(r?.run_id).toBe(a2?.id ?? "");
			expect(e.attempt_no).toBe(2);
			expect(e.max_repairs).toBe(1);
			expect(e.parent_sha).toBe(a1?.candidate_sha ?? "");
			expect(e.candidate_sha).toBe(a2?.candidate_sha ?? "");
			expect(e.manifest_hash).toBe(a2?.manifest_hash ?? "");
			// the review bound into the envelope is attempt 2's, of attempt 2's candidate + manifest
			expect(e.review.candidate_sha).toBe(a2?.candidate_sha ?? "");
			expect(e.review.manifest_hash).toBe(a2?.manifest_hash ?? "");
			expect(e.review.verdict).toBe("approve");
		});
	}

	test("reject_always → exactly one repair, then repair_limit_exhausted; no third attempt; no Gate 2", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(
			env,
			v,
			draft({
				simulation_scenario: "reject_always",
				repair_policy: { max_repairs: 1 },
			}),
		);
		await env.drain();
		const m = engineOf(env, ids.managedTaskId);
		expect(m?.state).toBe("failed");
		expect(m?.failure_kind).toBe("repair_limit_exhausted");
		expect(runsOf(env, ids.managedTaskId)).toHaveLength(2);
		expect(env.calls.implement).toBe(2);
		expect(stageOf(env, ids.taskId)).toBe("execution_ended");
		expect(resultRequests(env, ids.taskId)).toHaveLength(0);
	});

	test("an in-scope finding (file inside the approved scope) is repaired once", async () => {
		const env = t.track(
			makeBridgeEnv({
				adapters: (base) =>
					scriptedReviewer(base, (input) =>
						input.run.attempt_no === 1 ? [finding("src/app.txt")] : "approve",
					),
			}),
		);
		const v = await env.ctx();
		const ids = await approved(
			env,
			v,
			draft({
				scope: { allowed: ["src"], protected: [] },
				repair_policy: { max_repairs: 1 },
			}),
		);
		await env.drain();
		expect(engineOf(env, ids.managedTaskId)?.state).toBe("human_ready");
		expect(runsOf(env, ids.managedTaskId)).toHaveLength(2);
		expect(stageOf(env, ids.taskId)).toBe("awaiting_acceptance");
	});
});

describe("forbidden classes never repair (limit 1 allowed, one attempt each)", () => {
	for (const [scenario, kind] of [
		["out_of_scope", "scope_violation"],
		["reviewer_error", "provider_error"],
		["malformed_review", "review_invalid"],
		["review_wrong_candidate", "review_invalid"],
		["reviewer_mutates", "candidate_mutated"],
	] as const) {
		test(`${scenario} → ${kind}`, async () => {
			const env = t.track(makeBridgeEnv());
			const v = await env.ctx();
			const ids = await approved(
				env,
				v,
				draft({
					simulation_scenario: scenario,
					repair_policy: { max_repairs: 1 },
					// a narrowed scope ("." admits every path)
					scope: { allowed: ["src"], protected: [] },
				}),
			);
			await env.drain();
			const m = engineOf(env, ids.managedTaskId);
			expect(m?.failure_kind).toBe(kind);
			expect(runsOf(env, ids.managedTaskId)).toHaveLength(1);
			expect(env.calls.implement).toBe(1);
			expect(stageOf(env, ids.taskId)).toBe("execution_ended");
			expect(resultRequests(env, ids.taskId)).toHaveLength(0);
		});
	}

	test("evidence corrupted between verification and review → evidence_invalid; the reviewer is never called", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(
			env,
			v,
			draft({
				simulation_scenario: "reject_then_approve",
				repair_policy: { max_repairs: 1 },
			}),
		);
		const orch = env.engine({
			hooks: {
				at: (point) => {
					if (point !== "before_review") return;
					const run = runsOf(env, ids.managedTaskId)[0];
					tamper(artifactFile(env, run?.id ?? "", "diff.patch"));
				},
			},
		});
		await env.drain(orch);
		const m = engineOf(env, ids.managedTaskId);
		expect(m?.failure_kind).toBe("evidence_invalid");
		expect(runsOf(env, ids.managedTaskId)).toHaveLength(1);
		expect(env.calls.review).toBe(0);
		expect(stageOf(env, ids.taskId)).toBe("execution_ended");
	});

	test("authorization revoked before the stage → approval_void; nothing more launches", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(
			env,
			v,
			draft({
				simulation_scenario: "reject_then_approve",
				repair_policy: { max_repairs: 1 },
			}),
		);
		await env.drain(
			env.engine({
				alsoDeny: (task) =>
					task.state === "reviewing" ? "revoked for the test" : null,
			}),
		);
		const m = engineOf(env, ids.managedTaskId);
		expect(m?.state).toBe("blocked");
		expect(m?.failure_kind).toBe("approval_void");
		expect(runsOf(env, ids.managedTaskId)).toHaveLength(1);
		expect(env.calls.review).toBe(0);
		expect(stageOf(env, ids.taskId)).toBe("execution_ended");
	});
});
