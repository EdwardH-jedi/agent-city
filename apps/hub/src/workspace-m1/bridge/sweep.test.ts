// The reconciler's sweeps beyond engine observation: pending Gate-1 requests vs the current
// policy / repo / base (§6 run_request_invalidated), violation alarms that fail closed (§6 rule),
// and the safety of notify() (deferred, never inside the caller's transaction, never throws).
import { afterEach, describe, expect, test } from "bun:test";
import { fixtureGit } from "../../managed/testkit.ts";
import { defaultCheckBase } from "./reconciler.ts";
import {
	approved,
	cancel,
	createTask,
	decide,
	dump,
	engineOf,
	makeBridgeEnv,
	publish,
	restartBridgeEnv,
	runsOf,
	stageOf,
	tracker,
} from "./test-support.ts";

const t = tracker();
afterEach(() => t.cleanup());

describe("pending Gate 1 vs current policy / repo / base", () => {
	test("policy changed (restart with a new frozen config) → invalidated(policy_changed), reservation cancelled, task back to draft; republish works", async () => {
		const e1 = t.track(makeBridgeEnv({ fixture: { dbFile: true } }));
		const v1 = await e1.ctx();
		const taskId = createTask(e1, v1);
		const { runRequestId, managedTaskId } = await publish(e1, v1, taskId);
		const e2 = t.track(
			restartBridgeEnv(e1, {
				config: (fx) => {
					const c = structuredClone(fx.config);
					const check = c.repos[0]?.verification[0];
					if (check) check.timeout_s = 31;
					return c;
				},
			}),
		);
		const report = await e2.bridge.sweep();
		expect(report.invalidated).toBe(1);
		const req = e2.store.getApprovalRequest(runRequestId);
		expect(req?.status).toBe("invalidated");
		expect(req?.invalidation_reason).toBe("policy_changed");
		expect(engineOf(e2, managedTaskId)?.state).toBe("cancelled");
		expect(stageOf(e2, taskId)).toBe("draft");
		expect(e2.store.getTask(taskId)?.stage_detail).toContain("policy_changed");
		// idempotent
		const before = dump(e2.db);
		expect((await e2.bridge.sweep()).invalidated).toBe(0);
		expect(dump(e2.db)).toBe(before);
		// a new version can be published under the new policy
		const v2 = await e2.ctx();
		const again = await publish(e2, v2, taskId);
		expect(again.runRequestId).not.toBe(runRequestId);
	});

	test("the repository left the allowlist → invalidated(repo_unavailable)", async () => {
		const e1 = t.track(makeBridgeEnv({ fixture: { dbFile: true } }));
		const v1 = await e1.ctx();
		const taskId = createTask(e1, v1);
		const { runRequestId } = await publish(e1, v1, taskId);
		const e2 = t.track(
			restartBridgeEnv(e1, {
				config: (fx) => ({ ...structuredClone(fx.config), repos: [] }),
			}),
		);
		await e2.bridge.sweep();
		expect(e2.store.getApprovalRequest(runRequestId)?.invalidation_reason).toBe(
			"repo_unavailable",
		);
		expect(stageOf(e2, taskId)).toBe("draft");
	});

	test("the base branch moved after publish → invalidated(repo_unavailable) naming the moved base; approve is refused", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const taskId = createTask(env, v);
		const { runRequestId, managedTaskId } = await publish(env, v, taskId);
		fixtureGit(env.fx.repoPath, "commit", "--allow-empty", "-q", "-m", "moved");
		await env.bridge.sweep();
		const req = env.store.getApprovalRequest(runRequestId);
		expect(req?.invalidation_reason).toBe("repo_unavailable");
		expect(req?.invalidation_detail).toContain("base branch moved");
		expect(engineOf(env, managedTaskId)?.state).toBe("cancelled");
		expect(stageOf(env, taskId)).toBe("draft");
	});

	test("defaultCheckBase classifies ok / moved / unresolvable / repo_unavailable", async () => {
		const env = t.track(makeBridgeEnv());
		const repo = env.fx.config.repos[0];
		if (!repo) throw new Error("fixture repo");
		const check = defaultCheckBase(env.fx.config);
		expect(await check(repo, env.fx.baseSha)).toBe("ok");
		expect(await check(repo, "0".repeat(40))).toBe("unresolvable");
		expect(
			await check({ ...repo, path: `${env.fx.dir}/nope` }, env.fx.baseSha),
		).toBe("repo_unavailable");
		fixtureGit(env.fx.repoPath, "commit", "--allow-empty", "-q", "-m", "moved");
		expect(await check(repo, env.fx.baseSha)).toBe("moved");
	});

	test("an approval of a request the sweep invalidated is refused (409); nothing is queued", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const taskId = createTask(env, v);
		const { runRequestId, managedTaskId } = await publish(env, v, taskId);
		fixtureGit(env.fx.repoPath, "commit", "--allow-empty", "-q", "-m", "moved");
		await env.bridge.sweep();
		const row = env.store.getApprovalRequest(runRequestId);
		if (!row) throw new Error("no request");
		// a closed request cannot even get a challenge (a stale tab cannot approve it)
		const ch = env.services.decisions.issueChallenge(
			v,
			runRequestId,
			{
				kind: "run",
				binding_hash: row.binding_hash,
				expected_request_rev: row.rev,
			},
			env.tick(),
		);
		expect(ch.status).toBe(409);
		expect(engineOf(env, managedTaskId)?.state).toBe("cancelled");
		expect(runsOf(env, managedTaskId)).toHaveLength(0);
	});
});

describe("violations: alarm + fail closed, never silent", () => {
	test("a reservation queued by a bypass while Gate 1 is pending → alarm, flagged, cancelled; nothing runs; withdraw still works", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const taskId = createTask(env, v);
		const { runRequestId, managedTaskId } = await publish(env, v, taskId);
		env.db
			.query(
				"UPDATE managed_tasks SET state = 'queued', run_requested_at = ? WHERE id = ?",
			)
			.run(new Date().toISOString(), managedTaskId);
		await env.bridge.sweep();
		expect(
			env.alarms.some(
				(a) => a.kind === "violation" && a.managed_task_id === managedTaskId,
			),
		).toBe(true);
		expect(env.bridge.flagged()).toContain(managedTaskId);
		expect(engineOf(env, managedTaskId)?.state).toBe("cancelled");
		await env.drain();
		expect(runsOf(env, managedTaskId)).toHaveLength(0);
		expect(env.calls.preflight + env.calls.implement).toBe(0);
		// the pending request cannot be approved any more, and the operator can still withdraw
		expect(stageOf(env, taskId)).toBe("awaiting_run_approval");
		const approve = await decide(env, v, runRequestId);
		expect(approve.status).toBe(409);
		expect(cancel(env, v, taskId).status).toBe(200);
		expect(stageOf(env, taskId)).toBe("cancelled");
	});

	test("the bypass-queued reservation claimed by the engine first → approval_void (zero calls), then the sweep cancels it", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const taskId = createTask(env, v);
		const { managedTaskId } = await publish(env, v, taskId);
		env.db
			.query(
				"UPDATE managed_tasks SET state = 'queued', run_requested_at = ? WHERE id = ?",
			)
			.run(new Date().toISOString(), managedTaskId);
		await env.drain(env.engine({ onChange: false }));
		expect(engineOf(env, managedTaskId)?.failure_kind).toBe("approval_void");
		expect(env.calls.preflight + env.calls.implement + env.calls.review).toBe(
			0,
		);
		await env.bridge.sweep();
		expect(engineOf(env, managedTaskId)?.state).toBe("cancelled");
		expect(env.alarms.some((a) => a.kind === "violation")).toBe(true);
	});

	test("an approved execution re-queued by another path (run_requested_at ≠ decided_at) → alarm; the engine refuses it; execution_ended", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(env, v);
		env.db
			.query("UPDATE managed_tasks SET run_requested_at = ? WHERE id = ?")
			.run("2026-10-02T09:59:59.000Z", ids.managedTaskId);
		await env.bridge.sweep();
		expect(env.bridge.flagged()).toContain(ids.managedTaskId);
		expect(
			env.alarms.find((a) => a.managed_task_id === ids.managedTaskId)?.detail,
		).toContain("requeued");
		await env.drain();
		expect(engineOf(env, ids.managedTaskId)?.failure_kind).toBe(
			"approval_void",
		);
		expect(env.calls.preflight).toBe(0);
		expect(stageOf(env, ids.taskId)).toBe("execution_ended");
	});

	test("alarm text is fixed + enum values only (no paths, hashes or row content)", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(env, v);
		env.db
			.query("UPDATE managed_tasks SET run_requested_at = ? WHERE id = ?")
			.run("2026-10-02T09:59:59.000Z", ids.managedTaskId);
		await env.bridge.sweep();
		for (const a of env.alarms) {
			expect(a.detail).not.toContain(env.fx.dir);
			expect(a.detail).not.toMatch(/[0-9a-f]{40}/);
		}
	});
});

describe("notify() safety", () => {
	test("called inside an open transaction: returns at once, runs only after the commit, never throws", async () => {
		const queuedAt: { inTx: boolean; state: string | undefined }[] = [];
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(env, v);
		// the engine marks it executing; the bridge is told INSIDE a transaction
		env.store.transaction(() => {
			env.db
				.query("UPDATE managed_tasks SET state = 'executing' WHERE id = ?")
				.run(ids.managedTaskId);
			env.bridge.notify(ids.managedTaskId);
			env.bridge.notify("");
			env.bridge.notify(42 as unknown as string);
			queuedAt.push({
				inTx: env.db.inTransaction,
				state: stageOf(env, ids.taskId),
			});
		});
		expect(queuedAt).toEqual([{ inTx: true, state: "queued" }]);
		await env.bridge.idle();
		expect(stageOf(env, ids.taskId)).toBe("running");
	});

	test("onQueued fires deferred after the Gate-1 commit, outside any transaction, with the queued execution", async () => {
		const seen: { id: string; inTx: boolean; state: string | undefined }[] = [];
		let envRef: ReturnType<typeof makeBridgeEnv> | null = null;
		const env = t.track(
			makeBridgeEnv({
				bridge: {
					onQueued: (id) => {
						const e = envRef;
						seen.push({
							id,
							inTx: e?.db.inTransaction ?? true,
							state: e ? engineOf(e, id)?.state : undefined,
						});
					},
				},
			}),
		);
		envRef = env;
		const v = await env.ctx();
		const ids = await approved(env, v);
		await Bun.sleep(10);
		expect(seen).toEqual([
			{ id: ids.managedTaskId, inTx: false, state: "queued" },
		]);
	});

	test("an alarm sink that throws does not stop reconciliation", async () => {
		const env = t.track(
			makeBridgeEnv({
				bridge: {
					alarm: () => {
						throw new Error("sink down");
					},
				},
			}),
		);
		const v = await env.ctx();
		const ids = await approved(env, v);
		env.db
			.query("UPDATE managed_tasks SET run_requested_at = ? WHERE id = ?")
			.run("2026-10-02T09:59:59.000Z", ids.managedTaskId);
		await env.bridge.sweep();
		expect(env.bridge.flagged()).toContain(ids.managedTaskId);
		await env.drain();
		expect(stageOf(env, ids.taskId)).toBe("execution_ended");
	});
});
