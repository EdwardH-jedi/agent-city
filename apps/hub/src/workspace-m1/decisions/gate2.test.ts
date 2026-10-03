// Gate 2 (result acceptance) against a REAL fixture execution: Gate 1 through the DecisionService,
// the existing Orchestrator with (counted) fake adapters drives the managed task to human_ready,
// role 06's sealer seals it and the result request is inserted the way the bridge (role 05) will.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ApprovalRequestRow,
	EvidenceSealer,
} from "@agent-city/schema/workspace-m1";
import { getRun, getTask, openQuarantine } from "../../managed/store.ts";
import { SealError } from "../evidence/run-evidence.ts";
import {
	approvedTask,
	artifactPath,
	challenge,
	count,
	countingAdapters,
	decisionBody,
	draft,
	dump,
	type Env,
	expectOk,
	makeEnv,
	openGate2,
	publish,
	runEngine,
} from "./test-support.ts";

const envs: Env[] = [];
afterEach(() => {
	for (const e of envs.splice(0)) e.fx.cleanup();
});

async function awaitingAcceptance(o: Parameters<typeof makeEnv>[0] = {}) {
	const e = makeEnv(o);
	envs.push(e);
	const v = await e.ctx();
	const ids = await approvedTask(e, v);
	const counted = countingAdapters(e.fx.config);
	await runEngine(e, counted);
	expect(getTask(e.db, ids.managedTaskId)?.state).toBe("human_ready");
	const result = await openGate2(e, ids);
	return { e, v, ids, result, calls: counted.calls };
}

const runs = (e: Env) => count(e.db, "SELECT count(*) AS n FROM managed_runs");
const decisions = (e: Env) =>
	count(e.db, "SELECT count(*) AS n FROM managed_decisions");

describe("Gate 2 accept", () => {
	test("records acceptance of the exact envelope; engine stays human_ready; nothing executes", async () => {
		const { e, v, ids, result, calls } = await awaitingAcceptance();
		const before = { ...calls };
		const runsBefore = runs(e);
		const managedBefore = getTask(e.db, ids.managedTaskId);
		const ch = challenge(e, v, result.id);
		const res = await e.services.decisions.decide(
			v,
			result.id,
			decisionBody(ch),
			e.tick(),
		);
		expect(res.status).toBe(201);
		const r = expectOk(res).receipt;
		expect(r.kind).toBe("result");
		expect(r.action).toBe("accept");
		expect(r.effects).toEqual({
			managed_task_id: ids.managedTaskId,
			managed_task_state: "human_ready",
			result_envelope_hash: result.result_envelope_hash,
			// v1.2: the accepted result is bound to its durable evidence bundle
			evidence_bundle_digest: result.evidence_bundle_digest,
		});
		expect(r.approval_request).toEqual({
			status: "accepted",
			rev: ch.request_rev + 2,
		});
		const task = e.store.getTask(ids.taskId);
		expect(task?.stage).toBe("accepted");
		expect(task?.accepted_decision_id).toBe(r.decision_id);
		// engine human_ready untouched (same row rev, no new run, no adapter call)
		const managedAfter = getTask(e.db, ids.managedTaskId);
		expect(managedAfter?.state).toBe("human_ready");
		expect(managedAfter?.rev).toBe(managedBefore?.rev ?? -1);
		expect(runs(e)).toBe(runsBefore);
		expect(calls).toEqual(before);
		const d = e.store.getDecision(r.decision_id);
		expect(d?.result_envelope_hash).toBe(result.result_envelope_hash);
		expect(d?.confirmation_text).toBe("Edward");
		// accepted is terminal; replay works; a second accept is impossible
		expect(
			expectOk(
				await e.services.decisions.decide(
					v,
					result.id,
					decisionBody(ch, { idempotency_key: d?.idempotency_key ?? "" }),
					e.tick(),
				),
			).replayed,
		).toBe(true);
		const second = e.services.decisions.issueChallenge(
			v,
			result.id,
			{
				kind: "result",
				binding_hash: result.binding_hash,
				expected_request_rev: r.approval_request.rev,
			},
			e.now(),
		);
		expect(second.status).toBe(409);
		const t = e.store.getTask(ids.taskId);
		expect(
			(
				await e.services.commands.publishProposal(
					v,
					ids.taskId,
					{ expected_rev: t?.rev },
					e.now(),
				)
			).status,
		).toBe(409);
		expect(decisions(e)).toBe(2); // Gate 1 + Gate 2
	});

	test("wrong name at Gate 2 → 422, nothing consumed; Gate-1 key reused → 409 conflict", async () => {
		const { e, v, ids, result } = await awaitingAcceptance();
		const ch = challenge(e, v, result.id);
		const snapshot = dump(e.db);
		for (const text of ["edward", "Edward ", "Еdward"]) {
			const res = await e.services.decisions.decide(
				v,
				result.id,
				decisionBody(ch, { confirmation_text: text }),
				e.now(),
			);
			expect(res.status).toBe(422);
		}
		const gate1Key = e.store.getDecision(ids.decisionId)?.idempotency_key ?? "";
		const reuse = await e.services.decisions.decide(
			v,
			result.id,
			decisionBody(ch, { idempotency_key: gate1Key }),
			e.now(),
		);
		expect(reuse.status).toBe(409);
		expect((reuse.body as { error: string }).error).toBe(
			"idempotency_conflict",
		);
		expect(dump(e.db)).toBe(snapshot);
	});

	test("concurrent accepts with distinct keys → exactly one acceptance", async () => {
		const { e, v, result } = await awaitingAcceptance();
		const ch = challenge(e, v, result.id);
		const results = await Promise.all(
			Array.from({ length: 8 }, () =>
				e.services.decisions.decide(v, result.id, decisionBody(ch), e.now()),
			),
		);
		expect(results.filter((r) => r.status === 201)).toHaveLength(1);
		expect(results.filter((r) => r.status === 409)).toHaveLength(7);
		expect(
			count(
				e.db,
				"SELECT count(*) AS n FROM managed_decisions WHERE action = 'accept'",
			),
		).toBe(1);
	});
});

describe("Gate 2 revalidation", () => {
	test("a tampered artifact file → 409 integrity_failed; request invalidated; task execution_ended", async () => {
		const { e, v, ids, result } = await awaitingAcceptance();
		const ch = challenge(e, v, result.id);
		writeFileSync(
			artifactPath(e, ids.managedTaskId, "diff.patch"),
			"tampered\n",
		);
		const res = await e.services.decisions.decide(
			v,
			result.id,
			decisionBody(ch),
			e.tick(),
		);
		expect(res.status).toBe(409);
		expect((res.body as { error: string }).error).toBe("integrity_failed");
		const row = e.store.getApprovalRequest(result.id);
		expect(row?.status).toBe("invalidated");
		expect(row?.invalidation_reason).toBe("integrity_failed");
		expect(e.store.getTask(ids.taskId)?.stage).toBe("execution_ended");
		expect(decisions(e)).toBe(1); // only Gate 1
		expect(getTask(e.db, ids.managedTaskId)?.state).toBe("human_ready");
		// the invalidated subject never regains authority
		const again = await e.services.decisions.decide(
			v,
			result.id,
			decisionBody(ch),
			e.tick(),
		);
		expect((again.body as { error: string }).error).toBe("stale_binding");
	});

	test("a coherent row tamper (candidate sha) → integrity_failed", async () => {
		const { e, v, ids, result } = await awaitingAcceptance();
		const ch = challenge(e, v, result.id);
		const runId = getTask(e.db, ids.managedTaskId)?.result_run_id ?? "";
		e.db
			.query("UPDATE managed_runs SET candidate_sha = ? WHERE id = ?")
			.run(getRun(e.db, runId)?.base_sha ?? "", runId);
		const res = await e.services.decisions.decide(
			v,
			result.id,
			decisionBody(ch),
			e.tick(),
		);
		expect((res.body as { error: string }).error).toBe("integrity_failed");
		expect(e.store.getApprovalRequest(result.id)?.status).toBe("invalidated");
	});

	test("a mutated candidate worktree → invalidated(candidate_mutated)", async () => {
		const { e, v, ids, result } = await awaitingAcceptance();
		const ch = challenge(e, v, result.id);
		const runId = getTask(e.db, ids.managedTaskId)?.result_run_id ?? "";
		const wt = getRun(e.db, runId)?.workspace_path ?? "";
		writeFileSync(join(wt, "untracked-after-review.txt"), "x\n");
		const res = await e.services.decisions.decide(
			v,
			result.id,
			decisionBody(ch),
			e.tick(),
		);
		expect((res.body as { error: string }).error).toBe("integrity_failed");
		const row = e.store.getApprovalRequest(result.id);
		expect(row?.invalidation_reason).toBe("candidate_mutated");
	});

	for (const code of [
		"timeout",
		"repo_unavailable",
		"candidate_unavailable",
	] as const) {
		test(`a transient seal failure (${code}) → 409 evidence_unavailable, no write`, async () => {
			let failing = false;
			const { e, v, result } = await awaitingAcceptance({
				sealer: (real): EvidenceSealer => ({
					seal: (i) => real.seal(i),
					revalidate: (r: ApprovalRequestRow) => {
						if (failing) return Promise.reject(new SealError(code));
						return real.revalidate(r);
					},
				}),
			});
			const ch = challenge(e, v, result.id);
			const snapshot = dump(e.db);
			failing = true;
			const res = await e.services.decisions.decide(
				v,
				result.id,
				decisionBody(ch),
				e.now(),
			);
			expect(res.status).toBe(409);
			expect((res.body as { error: string }).error).toBe(
				"evidence_unavailable",
			);
			expect(dump(e.db)).toBe(snapshot);
			expect(e.store.getApprovalRequest(result.id)?.challenge_status).toBe(
				"issued",
			);
			failing = false;
			expect(
				(
					await e.services.decisions.decide(
						v,
						result.id,
						decisionBody(ch),
						e.now(),
					)
				).status,
			).toBe(201);
		});
	}

	test("cancel intent or an open quarantine at accept time → 409 invalid_state, challenge not consumed", async () => {
		const { e, v, ids, result } = await awaitingAcceptance();
		const ch = challenge(e, v, result.id);
		const snapshot = dump(e.db);
		e.db
			.query("UPDATE managed_tasks SET cancel_requested_at = ? WHERE id = ?")
			.run(e.now().toISOString(), ids.managedTaskId);
		const a = await e.services.decisions.decide(
			v,
			result.id,
			decisionBody(ch),
			e.now(),
		);
		expect((a.body as { error: string }).error).toBe("invalid_state");
		e.db
			.query("UPDATE managed_tasks SET cancel_requested_at = NULL WHERE id = ?")
			.run(ids.managedTaskId);
		expect(dump(e.db)).toBe(snapshot);
		openQuarantine(e.db, {
			task_id: ids.managedTaskId,
			run_id: null,
			pid: 999_999,
			started: null,
			reason: "test: unconfirmed termination",
			now: e.now().toISOString(),
		});
		const b = await e.services.decisions.decide(
			v,
			result.id,
			decisionBody(ch),
			e.now(),
		);
		expect((b.body as { error: string }).error).toBe("invalid_state");
		expect(e.store.getApprovalRequest(result.id)?.challenge_status).toBe(
			"issued",
		);
		expect(decisions(e)).toBe(1);
	});
});

describe("Gate 2 decline", () => {
	test("request_changes: request closed, engine stays human_ready, then edit → new proposal → new Gate 1", async () => {
		const { e, v, ids, result, calls } = await awaitingAcceptance();
		const before = { ...calls };
		const ch = challenge(e, v, result.id);
		const r = expectOk(
			await e.services.decisions.decide(
				v,
				result.id,
				decisionBody(ch, {
					action: "request_changes",
					reason: "Use a clearer message.",
				}),
				e.tick(),
			),
		).receipt;
		expect(r.effects.managed_task_state).toBe("human_ready");
		expect(r.effects.result_envelope_hash).toBe(result.result_envelope_hash);
		expect(getTask(e.db, ids.managedTaskId)?.state).toBe("human_ready");
		expect(e.store.getTask(ids.taskId)?.stage).toBe("changes_requested");
		expect(calls).toEqual(before);
		const t = e.store.getTask(ids.taskId);
		expectOk(
			e.services.commands.saveDraft(
				v,
				ids.taskId,
				{
					expected_rev: t?.rev,
					draft: draft({ objective: "Use a clearer message." }),
				},
				e.tick(),
			),
		);
		const { request } = await publish(e, v, ids.taskId);
		expect(request.managed_task_id).not.toBe(ids.managedTaskId);
		expect(getTask(e.db, request.managed_task_id)?.state).toBe("draft");
		// the old Gate-1 decision does not authorize the new execution
		expect(e.store.getProposal(request.proposal_id)?.version).toBe(2);
		expect(e.store.getApprovalRequest(ids.runRequestId)?.status).toBe(
			"approved",
		);
	});

	test("reject at Gate 2 is terminal and starts nothing", async () => {
		const { e, v, ids, result, calls } = await awaitingAcceptance();
		const before = { ...calls };
		const ch = challenge(e, v, result.id);
		expectOk(
			await e.services.decisions.decide(
				v,
				result.id,
				decisionBody(ch, { action: "reject" }),
				e.tick(),
			),
		);
		expect(e.store.getTask(ids.taskId)?.stage).toBe("rejected");
		expect(getTask(e.db, ids.managedTaskId)?.state).toBe("human_ready");
		expect(calls).toEqual(before);
		const t = e.store.getTask(ids.taskId);
		const rerun = e.services.commands.requestRerun(
			v,
			ids.taskId,
			{ expected_rev: t?.rev, proposal_id: t?.current_proposal_id },
			e.now(),
		);
		expect(rerun.status).toBe(409);
	});

	test("cancel at awaiting_acceptance → 409 invalid_state (R-A1); the Gate-2 request is unaffected", async () => {
		const { e, v, ids, result } = await awaitingAcceptance();
		const t = e.store.getTask(ids.taskId);
		const snapshot = dump(e.db);
		const res = e.services.commands.cancel(
			v,
			ids.taskId,
			{ expected_rev: t?.rev },
			e.now(),
		);
		expect(res.status).toBe(409);
		expect((res.body as { error: string }).error).toBe("invalid_state");
		expect(dump(e.db)).toBe(snapshot);
		expect(e.store.getApprovalRequest(result.id)?.status).toBe("pending");
	});
});

describe("cancel vs completion ordering", () => {
	test("engine finished (human_ready) before the bridge noticed: cancel → 409, no cancel intent recorded", async () => {
		const e = makeEnv();
		envs.push(e);
		const v = await e.ctx();
		const ids = await approvedTask(e, v);
		await runEngine(e);
		expect(getTask(e.db, ids.managedTaskId)?.state).toBe("human_ready");
		const t = e.store.getTask(ids.taskId);
		expect(t?.stage).toBe("queued"); // bridge lag
		const res = e.services.commands.cancel(
			v,
			ids.taskId,
			{ expected_rev: t?.rev },
			e.now(),
		);
		expect((res.body as { error: string }).error).toBe("invalid_state");
		expect(getTask(e.db, ids.managedTaskId)?.cancel_requested_at).toBeNull();
	});

	test("cancel of a queued execution before the engine claims it: cancelled, never runs", async () => {
		const e = makeEnv();
		envs.push(e);
		const v = await e.ctx();
		const ids = await approvedTask(e, v);
		const t = e.store.getTask(ids.taskId);
		const view = expectOk(
			e.services.commands.cancel(
				v,
				ids.taskId,
				{ expected_rev: t?.rev },
				e.tick(),
			),
		);
		expect(view.task.stage).toBe("cancelled");
		expect(getTask(e.db, ids.managedTaskId)?.state).toBe("cancelled");
		const counted = countingAdapters(e.fx.config);
		await runEngine(e, counted);
		expect(counted.calls).toEqual({ preflight: 0, implement: 0, review: 0 });
		expect(runs(e)).toBe(0);
	});

	test("cancel of a leased execution records intent only (cancel_requested, never shown cancelled)", async () => {
		const e = makeEnv();
		envs.push(e);
		const v = await e.ctx();
		const ids = await approvedTask(e, v);
		// a worker holds the lease (claimed, not yet started)
		e.db
			.query(
				"UPDATE managed_tasks SET lease_owner = 'worker-x', lease_until = ? WHERE id = ?",
			)
			.run(new Date(Date.now() + 60_000).toISOString(), ids.managedTaskId);
		const t = e.store.getTask(ids.taskId);
		const view = expectOk(
			e.services.commands.cancel(
				v,
				ids.taskId,
				{ expected_rev: t?.rev },
				e.tick(),
			),
		);
		expect(view.task.stage).toBe("cancel_requested");
		expect(view.task.cancel_requested_at).not.toBeNull();
		const managed = getTask(e.db, ids.managedTaskId);
		expect(managed?.state).toBe("queued");
		expect(managed?.cancel_requested_at).not.toBeNull();
		// a repeated cancel is a no-op (no second write)
		const again = expectOk(
			e.services.commands.cancel(
				v,
				ids.taskId,
				{ expected_rev: view.task.rev },
				e.tick(),
			),
		);
		expect(again.task.rev).toBe(view.task.rev);
		expect(again.task.cancel_requested_at).toBe(view.task.cancel_requested_at);
		// lead ruling: still CAS — a stale rev at cancel_requested → 409 stale_binding, no write
		const before = dump(e.db);
		const stale = e.services.commands.cancel(
			v,
			ids.taskId,
			{ expected_rev: view.task.rev - 1 },
			e.tick(),
		);
		expect(stale.status).toBe(409);
		expect((stale.body as { error: string }).error).toBe("stale_binding");
		expect(dump(e.db)).toBe(before);
	});
});
