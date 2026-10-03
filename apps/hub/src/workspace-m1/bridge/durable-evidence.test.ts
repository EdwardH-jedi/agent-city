// v1.2 §B/§C in the bridge: the durable bundle is published at Gate-2 opening from the sealer's
// buffers BEFORE the result request exists; a publication failure never offers anything; legacy
// pending results are invalidated; the sweep re-checks accepted results (≤ N per sweep, oldest check
// first; startup + every 30 s in the hub). Real engine, fake adapters, disposable fixture repo.
import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
	ApprovalRequestRow,
	ManagedProposalRow,
} from "@agent-city/schema/workspace-m1";
import { sealResultApprovalBinding } from "@agent-city/schema/workspace-m1/hash";
import { getTask } from "../../managed/store.ts";
import {
	DURABLE_SEAL_FAILED_DETAIL,
	LEGACY_RESULT_DETAIL,
	SEALED_DIR,
	verifyBundle,
} from "../evidence/bundle.ts";
import { defaultGitFor } from "../evidence/sealer.ts";
import {
	approved,
	artifactFile,
	type BridgeEnv,
	decide,
	type Ids,
	makeBridgeEnv,
	restartBridgeEnv,
	resultRequests,
	stageOf,
	tracker,
} from "./test-support.ts";

const t = tracker();
afterEach(() => t.cleanup());

const sealedDir = (env: BridgeEnv) =>
	join(env.config.artifacts_root, SEALED_DIR);
const bundles = (env: BridgeEnv) => {
	try {
		return readdirSync(sealedDir(env)).filter((n) => n.endsWith(".bundle"));
	} catch {
		return [];
	}
};

/** create → Gate 1 → engine → Gate 2 opened by the bridge (pending, with a bundle). */
async function atGate2(env: BridgeEnv) {
	const v = await env.ctx();
	const ids = await approved(env, v);
	await env.drain();
	const [r] = resultRequests(env, ids.taskId);
	if (r?.status !== "pending")
		throw new Error(`no pending Gate 2: ${r?.status}`);
	return { v, ids, request: r };
}

async function acceptedTask(env: BridgeEnv) {
	const g = await atGate2(env);
	const res = await decide(env, g.v, g.request.id);
	if (!res.ok) throw new Error(`accept failed: ${JSON.stringify(res.body)}`);
	return { ...g, decision_id: res.body.receipt.decision_id };
}

const validity = (env: BridgeEnv, decision_id: string) =>
	env.store.getAcceptanceValidity(decision_id);

describe("Gate-2 opening publishes the durable bundle first (v1.2 §B)", () => {
	test("bundle file exists before the request row; request + bundle row commit together; the bundle verifies against the envelope", async () => {
		const seen: { files: string[]; rows: number; requests: number }[] = [];
		const env = t.track(
			makeBridgeEnv({
				bridge: {
					hooks: {
						beforeSealCommit(id) {
							const ws = env.store.findTaskByManagedTask(id);
							seen.push({
								files: bundles(env),
								rows: env.db
									.query<{ n: number }, []>(
										"SELECT count(*) AS n FROM managed_evidence_bundles",
									)
									.get()?.n as number,
								requests: ws ? resultRequests(env, ws.id).length : -1,
							});
						},
					},
				},
			}),
		);
		const { request } = await atGate2(env);
		expect(seen).toEqual([
			{
				files: [`${request.evidence_bundle_digest}.bundle`],
				rows: 0,
				requests: 0,
			},
		]);
		const digest = request.evidence_bundle_digest as string;
		const row = env.store.getEvidenceBundle(digest);
		expect(row?.result_envelope_hash).toBe(
			request.result_envelope_hash as string,
		);
		expect(row?.run_id).toBe(request.run_id as string);
		const v = verifyBundle(env.config.artifacts_root, {
			digest,
			result_envelope_hash: request.result_envelope_hash as string,
			envelope: request.result_envelope as NonNullable<
				ApprovalRequestRow["result_envelope"]
			>,
			byte_len: row?.byte_len,
		});
		expect(v.ok).toBe(true);
		// a second sweep does not republish or duplicate anything
		await env.bridge.sweep();
		expect(bundles(env)).toEqual([`${digest}.bundle`]);
	});

	test("publication failure: bounded transient retries (nothing offered), then invalidated(evidence_unavailable) 'durable evidence seal failed'", async () => {
		const env = t.track(
			makeBridgeEnv({
				bridge: {
					hooks: {
						publishFaults: {
							beforeRename() {
								throw new Error("injected publication failure");
							},
						},
					},
				},
			}),
		);
		const v = await env.ctx();
		const ids = await approved(env, v);
		await env.drain();
		expect(stageOf(env, ids.taskId)).toBe("running");
		expect(resultRequests(env, ids.taskId)).toHaveLength(0);
		expect(
			env.alarms.some(
				(a) =>
					a.kind === "seal_failed" &&
					a.detail.includes(DURABLE_SEAL_FAILED_DETAIL) &&
					a.detail.includes("attempt 1 of 3"),
			),
		).toBe(true);
		await env.bridge.sweep(); // attempt 2
		expect(resultRequests(env, ids.taskId)).toHaveLength(0);
		await env.bridge.sweep(); // attempt 3 → final
		const [r] = resultRequests(env, ids.taskId);
		expect(r?.status).toBe("invalidated");
		expect(r?.invalidation_reason).toBe("evidence_unavailable");
		expect(r?.invalidation_detail).toBe(DURABLE_SEAL_FAILED_DETAIL);
		expect(r?.evidence_bundle_digest).toBeUndefined();
		expect(stageOf(env, ids.taskId)).toBe("execution_ended");
		expect(env.store.getTask(ids.taskId)?.stage_detail).toContain(
			DURABLE_SEAL_FAILED_DETAIL,
		);
		expect(bundles(env)).toEqual([]);
		// nothing can be accepted
		const res = await env.services.decisions.decide(
			v,
			(r as ApprovalRequestRow).id,
			{
				idempotency_key: "accept-after-seal-failure",
				kind: "result",
				action: "accept",
				expected_request_rev: 1,
				binding_hash: (r as ApprovalRequestRow).binding_hash,
				confirmation_text: "Edward",
				reason: null,
				challenge: "x".repeat(43),
			},
			env.tick(),
		);
		expect(res.ok).toBe(false);
		expect(
			env.db
				.query<{ n: number }, []>(
					"SELECT count(*) AS n FROM managed_decisions WHERE kind = 'result'",
				)
				.get()?.n,
		).toBe(0);
	});

	test("an unwritable _sealed is a transient failure: once writable, the next sweep offers the result with its bundle", async () => {
		const env = t.track(makeBridgeEnv());
		mkdirSync(sealedDir(env), { recursive: true, mode: 0o700 });
		chmodSync(sealedDir(env), 0o500);
		const v = await env.ctx();
		const ids = await approved(env, v);
		try {
			await env.drain();
			expect(resultRequests(env, ids.taskId)).toHaveLength(0);
			expect(stageOf(env, ids.taskId)).toBe("running");
		} finally {
			chmodSync(sealedDir(env), 0o700);
		}
		await env.bridge.sweep();
		const [r] = resultRequests(env, ids.taskId);
		expect(r?.status).toBe("pending");
		expect(bundles(env)).toEqual([`${r?.evidence_bundle_digest}.bundle`]);
		expect(stageOf(env, ids.taskId)).toBe("awaiting_acceptance");
	});
});

describe("legacy pending Gate 2 (no durable bundle)", () => {
	test("the sweep invalidates it with the v1.2 wording; the task ends; nothing else changes", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(env, v);
		// the engine finishes WITHOUT the bridge noticing (as before 009), then a legacy request appears
		const orch = env.engine({ onChange: false });
		while (await orch.tick()) {
			// drain
		}
		const legacy = await insertLegacyGate2(env, ids);
		expect(legacy.evidence_bundle_digest).toBeUndefined();
		const report = await env.bridge.sweep();
		expect(report.legacy_invalidated).toBe(1);
		const r = env.store.getApprovalRequest(legacy.id);
		expect(r?.status).toBe("invalidated");
		expect(r?.invalidation_reason).toBe("evidence_unavailable");
		expect(r?.invalidation_detail).toBe(LEGACY_RESULT_DETAIL);
		expect(stageOf(env, ids.taskId)).toBe("execution_ended");
		expect((await env.bridge.sweep()).legacy_invalidated).toBe(0);
	});
});

describe("accepted results: the sweep re-checks current validity (v1.2 §C)", () => {
	test("clean control stays valid; source tamper → invalid (sticky) + alarm; restart keeps it; the original is served from the bundle", async () => {
		const env = t.track(makeBridgeEnv({ fixture: { dbFile: true } }));
		const a = await acceptedTask(env);
		const before = validity(env, a.decision_id);
		expect(before?.status).toBe("valid");
		env.tick(30_000);
		const r1 = await env.bridge.sweep();
		expect([r1.accepted_checked, r1.accepted_invalid]).toEqual([1, 0]);
		const after = validity(env, a.decision_id);
		expect(after?.status).toBe("valid");
		expect(after?.rev).toBe(2);
		expect(after && before && after.checked_at > before.checked_at).toBe(true);

		const diff = artifactFile(env, a.request.run_id as string, "diff.patch");
		const original = readFileSync(diff, "utf8");
		writeFileSync(diff, "tampered after acceptance\n");
		env.tick(30_000);
		const r2 = await env.bridge.sweep();
		expect([r2.accepted_checked, r2.accepted_invalid]).toEqual([1, 1]);
		expect(validity(env, a.decision_id)).toMatchObject({
			status: "invalid",
			reason: "source_evidence_changed",
		});
		expect(env.alarms.some((x) => x.kind === "acceptance_invalid")).toBe(true);
		expect(env.alarms.every((x) => !x.detail.includes("tampered"))).toBe(true);

		writeFileSync(diff, original); // sticky: never re-checked, never restored
		env.tick(30_000);
		expect((await env.bridge.sweep()).accepted_checked).toBe(0);
		expect(validity(env, a.decision_id)?.status).toBe("invalid");

		const env2 = t.track(restartBridgeEnv(env));
		await env2.bridge.sweep();
		expect(validity(env2, a.decision_id)?.status).toBe("invalid");
		expect(env2.store.getTask(a.ids.taskId)?.stage).toBe("accepted");
		const id = env2.db
			.query<{ id: string }, [string]>(
				"SELECT id FROM managed_artifacts WHERE run_id = ? AND name = 'diff.patch'",
			)
			.get(a.request.run_id as string)?.id as string;
		writeFileSync(diff, "tampered again\n");
		const shown = await env2.services.reads.artifact(a.ids.taskId, id);
		expect(shown.ok && shown.body.text).toBe(original);
	});

	test("≤ N per sweep, oldest check first", async () => {
		const env = t.track(
			makeBridgeEnv({ bridge: { maxAcceptedChecksPerSweep: 1 } }),
		);
		const a = await acceptedTask(env);
		env.tick();
		const b = await acceptedTask(env);
		const at = (id: string) => validity(env, id)?.checked_at as string;
		const [a0, b0] = [at(a.decision_id), at(b.decision_id)];
		expect(a0 < b0).toBe(true);
		env.tick(30_000);
		expect((await env.bridge.sweep()).accepted_checked).toBe(1);
		expect(at(a.decision_id) > a0).toBe(true); // A was the oldest check
		expect(at(b.decision_id)).toBe(b0);
		env.tick(30_000);
		expect((await env.bridge.sweep()).accepted_checked).toBe(1);
		expect(at(b.decision_id) > b0).toBe(true); // now B was the oldest
	});

	test("candidate tree no longer the sealed one (git replace in the trusted repo) → invalid(candidate_mismatch)", async () => {
		const env = t.track(makeBridgeEnv());
		const a = await acceptedTask(env);
		const candidate = a.request.result_envelope?.candidate_sha as string;
		const base = a.request.result_envelope?.base_sha as string;
		const git = Bun.spawnSync(
			[env.config.git_executable, "replace", candidate, base],
			{
				cwd: env.config.repos[0]?.path,
				env: {
					PATH: "/usr/bin:/bin",
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
				},
			},
		);
		expect(git.exitCode).toBe(0);
		env.tick(30_000);
		await env.bridge.sweep();
		expect(validity(env, a.decision_id)).toMatchObject({
			status: "invalid",
			reason: "candidate_mismatch",
		});
	});

	test("a check that cannot run → unknown (not sticky, never valid); the next successful check restores valid", async () => {
		let broken = true;
		const env = t.track(
			makeBridgeEnv({
				bridge: {
					gitFor: (cwd) =>
						broken
							? async () =>
									({
										spawned: false,
										exitCode: null,
										signal: null,
										stdout: "",
										stderr: "",
										stdoutTruncated: false,
										stderrTruncated: false,
										timedOut: false,
										aborted: false,
									}) as never
							: defaultGitFor(env.config)(cwd),
				},
			}),
		);
		const a = await acceptedTask(env);
		env.tick(30_000);
		await env.bridge.sweep();
		expect(validity(env, a.decision_id)).toMatchObject({
			status: "unknown",
			reason: "verification_unavailable",
			first_invalid_at: null,
		});
		broken = false;
		env.tick(30_000);
		await env.bridge.sweep();
		expect(validity(env, a.decision_id)?.status).toBe("valid");
	});
});

/** A Gate-2 request recorded the pre-009 way: sealed envelope, NO durable bundle. */
async function insertLegacyGate2(
	env: BridgeEnv,
	ids: Ids,
): Promise<ApprovalRequestRow> {
	const managed = getTask(env.db, ids.managedTaskId);
	if (managed?.state !== "human_ready" || !managed.result_run_id)
		throw new Error(`engine not human_ready: ${managed?.state}`);
	const runReq = env.store.getApprovalRequest(ids.runRequestId);
	if (!runReq) throw new Error("no run request");
	const proposal = env.store.getProposal(
		runReq.proposal_id,
	) as ManagedProposalRow;
	const sealed = await env.sealer.seal({
		workspace_task_id: ids.taskId,
		proposal: proposal.snapshot,
		proposal_hash: proposal.proposal_hash,
		execution_binding: runReq.execution_binding,
		execution_binding_hash: runReq.execution_binding_hash,
		run_decision_id: ids.decisionId,
		managed_task_id: ids.managedTaskId,
		run_id: managed.result_run_id,
	});
	const at = env.tick().toISOString();
	const id = `wsa-${crypto.randomUUID()}`;
	const binding = sealResultApprovalBinding({
		approval_request_id: id,
		workspace_task_id: ids.taskId,
		managed_task_id: ids.managedTaskId,
		run_id: managed.result_run_id,
		result_envelope_hash: sealed.envelope_hash,
	});
	const row: ApprovalRequestRow = {
		id,
		workspace_task_id: ids.taskId,
		kind: "result",
		proposal_id: runReq.proposal_id,
		proposal_hash: runReq.proposal_hash,
		managed_task_id: ids.managedTaskId,
		execution_binding: runReq.execution_binding,
		execution_binding_hash: runReq.execution_binding_hash,
		run_id: managed.result_run_id,
		result_envelope: sealed.envelope,
		result_envelope_hash: sealed.envelope_hash,
		binding: binding.value,
		binding_hash: binding.hash,
		status: "pending",
		invalidation_reason: null,
		invalidation_detail: null,
		created_at: at,
		updated_at: at,
		closed_at: null,
		rev: 1,
		challenge_status: "none",
		challenge_hash: null,
		challenge_operator_id: null,
		challenge_session_generation: null,
		challenge_boot_id: null,
		challenge_request_rev: null,
		challenge_issued_at: null,
		challenge_expires_at: null,
	};
	env.store.transaction((tx) => {
		tx.insertApprovalRequest(row);
		const task = tx.getTask(ids.taskId);
		if (!task) throw new Error("no task");
		if (!tx.updateTask(task.id, task.rev, { stage: "awaiting_acceptance" }, at))
			throw new Error("CAS miss");
	});
	return env.store.getApprovalRequest(id) as ApprovalRequestRow;
}
