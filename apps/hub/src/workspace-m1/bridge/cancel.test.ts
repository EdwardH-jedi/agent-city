// Cancellation through the bridge: before / during / after execution, the deterministic
// "cancel requested, not yet confirmed" window (R-N2), cancel vs finalize, and fencing of stale
// workers, late seals and late notifications.
import { afterEach, describe, expect, test } from "bun:test";
import { openQuarantine } from "../../managed/store.ts";
import { pidAlive } from "../../managed/testkit.ts";
import {
	approved,
	cancel,
	draft,
	dump,
	engineOf,
	HOLD_HEARTBEAT_MS,
	makeBridgeEnv,
	resultRequests,
	runsOf,
	stageOf,
	tracker,
	waitFor,
} from "./test-support.ts";

const t = tracker();
afterEach(() => t.cleanup());

/** A gate a hook can await; `open()` releases it. `reached` resolves when the hook arrives. */
function gate() {
	let open: () => void = () => {};
	let arrive: () => void = () => {};
	const released = new Promise<void>((r) => {
		open = r;
	});
	const reached = new Promise<void>((r) => {
		arrive = r;
	});
	return {
		reached,
		open,
		wait: async () => {
			arrive();
			await released;
		},
	};
}

describe("cancel before execution", () => {
	test("Gate 1 pending → withdrawn: request invalidated, reservation cancelled, the engine never runs it", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const { createTask, publish } = await import("./test-support.ts");
		const taskId = createTask(env, v);
		const { runRequestId, managedTaskId } = await publish(env, v, taskId);
		expect(cancel(env, v, taskId).status).toBe(200);
		await env.drain();
		await env.bridge.sweep();
		expect(stageOf(env, taskId)).toBe("cancelled");
		expect(
			env.store.getApprovalRequest(runRequestId)?.invalidation_reason,
		).toBe("withdrawn");
		expect(engineOf(env, managedTaskId)?.state).toBe("cancelled");
		expect(env.calls.preflight + env.calls.implement + env.calls.review).toBe(
			0,
		);
	});

	test("queued, unclaimed → cancelled at once; never claimed; the bridge agrees", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(env, v);
		expect(cancel(env, v, ids.taskId).status).toBe(200);
		await env.drain();
		await env.bridge.sweep();
		expect(stageOf(env, ids.taskId)).toBe("cancelled");
		expect(engineOf(env, ids.managedTaskId)?.state).toBe("cancelled");
		expect(runsOf(env, ids.managedTaskId)).toHaveLength(0);
		expect(env.calls.preflight + env.calls.implement + env.calls.review).toBe(
			0,
		);
	});
});

describe("cancel during execution (R-N2 window)", () => {
	test("impl_hangs + held cancel polling: cancel_requested until the engine confirms termination, then cancelled", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(
			env,
			v,
			draft({ simulation_scenario: "impl_hangs" }),
		);
		// R-N2 seam (test-only): the engine notices cancel_requested_at only in its heartbeat; a held
		// heartbeat keeps the "requested, not yet confirmed" window open until shutdown() releases it
		const orch = env.engine({ heartbeatMs: HOLD_HEARTBEAT_MS });
		const running = orch.tick();
		await waitFor(
			() =>
				runsOf(env, ids.managedTaskId)[0]?.proc_phase === "implement" &&
				runsOf(env, ids.managedTaskId)[0]?.child_pid != null,
			"the hanging implementer child",
		);
		await env.bridge.idle();
		expect(stageOf(env, ids.taskId)).toBe("running");
		const pid = runsOf(env, ids.managedTaskId)[0]?.child_pid ?? 0;
		expect(pidAlive(pid)).toBe(true);

		const res = cancel(env, v, ids.taskId);
		expect(res.status).toBe(200);
		await env.bridge.idle();
		await env.bridge.sweep();
		// window: intent persisted, termination not confirmed → never shown cancelled
		expect(stageOf(env, ids.taskId)).toBe("cancel_requested");
		const mid = engineOf(env, ids.managedTaskId);
		expect(mid?.state).toBe("executing");
		expect(mid?.cancel_requested_at).not.toBeNull();
		expect(pidAlive(pid)).toBe(true);

		// release: the engine terminates the child and confirms
		await orch.shutdown();
		await running;
		await env.bridge.idle();
		expect(engineOf(env, ids.managedTaskId)?.state).toBe("cancelled");
		expect(stageOf(env, ids.taskId)).toBe("cancelled");
		expect(pidAlive(pid)).toBe(false);
		expect(resultRequests(env, ids.taskId)).toHaveLength(0);
		// nothing resumes afterwards
		await env.drain();
		expect(runsOf(env, ids.managedTaskId)).toHaveLength(1);
		expect(env.calls.review).toBe(0);
	});

	test("cancel inside the finalize window wins: engine cancelled, no human_ready, no Gate 2", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(env, v);
		const g = gate();
		const orch = env.engine({
			hooks: {
				at: async (point) => {
					if (point === "before_finalize") await g.wait();
				},
			},
		});
		const running = env.drain(orch);
		await g.reached;
		await env.bridge.idle();
		expect(stageOf(env, ids.taskId)).toBe("running");
		expect(cancel(env, v, ids.taskId).status).toBe(200);
		expect(stageOf(env, ids.taskId)).toBe("cancel_requested");
		g.open();
		await running;
		await env.bridge.idle();
		const m = engineOf(env, ids.managedTaskId);
		expect(m?.state).toBe("cancelled");
		expect(m?.result_run_id).toBeNull();
		expect(stageOf(env, ids.taskId)).toBe("cancelled");
		expect(resultRequests(env, ids.taskId)).toHaveLength(0);
	});

	test("interrupted with an open quarantine stays cancel_requested; without one the bridge re-issues the cancel", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(env, v);
		// a leased execution: the cancel is intent only
		env.db
			.query(
				"UPDATE managed_tasks SET lease_owner = 'worker-x', lease_until = ? WHERE id = ?",
			)
			.run(new Date(Date.now() + 60_000).toISOString(), ids.managedTaskId);
		expect(cancel(env, v, ids.taskId).status).toBe(200);
		expect(stageOf(env, ids.taskId)).toBe("cancel_requested");
		// the worker vanished and the engine marked it interrupted, with an unproven child
		env.db
			.query(
				"UPDATE managed_tasks SET state = 'interrupted', lease_owner = NULL, lease_until = NULL WHERE id = ?",
			)
			.run(ids.managedTaskId);
		openQuarantine(env.db, {
			task_id: ids.managedTaskId,
			run_id: null,
			pid: 999_999,
			started: null,
			reason: "test: unproven child",
			now: env.now().toISOString(),
		});
		await env.bridge.sweep();
		expect(stageOf(env, ids.taskId)).toBe("cancel_requested");
		expect(engineOf(env, ids.managedTaskId)?.state).toBe("interrupted");
		// proof arrives (quarantine released by evidence); no open quarantine → re-issue → cancelled
		env.db
			.query(
				"UPDATE managed_quarantine SET released_at = ?, release_evidence = 'test' WHERE task_id = ?",
			)
			.run(env.now().toISOString(), ids.managedTaskId);
		await env.bridge.sweep();
		expect(engineOf(env, ids.managedTaskId)?.state).toBe("cancelled");
		expect(stageOf(env, ids.taskId)).toBe("cancelled");
	});
});

describe("cancel after execution", () => {
	test("awaiting acceptance → 409 invalid_state (R-A1); engine stays human_ready; Gate 2 stays pending", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(env, v);
		await env.drain();
		expect(stageOf(env, ids.taskId)).toBe("awaiting_acceptance");
		const before = dump(env.db);
		const res = cancel(env, v, ids.taskId);
		expect(res.status).toBe(409);
		expect((res.body as { error: string }).error).toBe("invalid_state");
		await env.bridge.sweep();
		expect(dump(env.db)).toBe(before);
		expect(engineOf(env, ids.managedTaskId)?.state).toBe("human_ready");
		expect(resultRequests(env, ids.taskId)[0]?.status).toBe("pending");
	});
});

describe("fences: stale workers, late seals, late notifications", () => {
	test("a worker that lost its lease cannot finalize: no human_ready, no Gate 2; workspace shows the truth", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(env, v);
		const g = gate();
		const a = env.engine({
			workerId: "worker-a",
			hooks: {
				at: async (point) => {
					if (point === "before_finalize") await g.wait();
				},
			},
		});
		const runningA = env.drain(a);
		await g.reached; // A's reviewer approved; A is about to commit human_ready
		// B sees A's lease as expired (clock ahead), fences it and reconciles the launched review
		const b = env.engine({
			workerId: "worker-b",
			now: () => new Date(Date.now() + 120_000),
		});
		await b.tick();
		await env.bridge.idle();
		expect(engineOf(env, ids.managedTaskId)?.state).toBe("interrupted");
		expect(stageOf(env, ids.taskId)).toBe("execution_ended");
		const fence = engineOf(env, ids.managedTaskId)?.fence_token;
		g.open(); // A's late completion
		await runningA;
		await env.bridge.idle();
		await env.bridge.sweep();
		const m = engineOf(env, ids.managedTaskId);
		expect(m?.state).toBe("interrupted");
		expect(m?.result_run_id).toBeNull();
		expect(m?.fence_token).toBe(fence ?? -1);
		expect(resultRequests(env, ids.taskId)).toHaveLength(0);
		expect(stageOf(env, ids.taskId)).toBe("execution_ended");
		// interrupted work is never re-run automatically
		await env.drain();
		expect(runsOf(env, ids.managedTaskId)).toHaveLength(1);
	});

	test("a late seal commit after a cancel intent applies cancel_won: the result is recorded invalidated(task_cancelled)", async () => {
		const at = { stage: "" };
		let envRef: ReturnType<typeof makeBridgeEnv> | null = null;
		let taskRef = "";
		const env = t.track(
			makeBridgeEnv({
				bridge: {
					hooks: {
						beforeSealCommit: () => {
							const e = envRef;
							if (!e) return;
							// the race: an operator cancel intent lands while the seal is outside any tx
							e.store.transaction((tx) => {
								const task = tx.getTask(taskRef);
								if (!task) throw new Error("no task");
								at.stage = task.stage;
								tx.updateTask(
									task.id,
									task.rev,
									{
										stage: "cancel_requested",
										cancel_requested_at: e.now().toISOString(),
									},
									e.now().toISOString(),
								);
							});
						},
					},
				},
			}),
		);
		envRef = env;
		const v = await env.ctx();
		const ids = await approved(env, v);
		taskRef = ids.taskId;
		await env.drain();
		expect(at.stage).toBe("running");
		expect(engineOf(env, ids.managedTaskId)?.state).toBe("human_ready");
		expect(stageOf(env, ids.taskId)).toBe("cancelled");
		const [r] = resultRequests(env, ids.taskId);
		expect(r?.status).toBe("invalidated");
		expect(r?.invalidation_reason).toBe("task_cancelled");
	});

	test("a late notification for a superseded execution changes nothing", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(
			env,
			v,
			draft({ simulation_scenario: "verification_fails" }),
		);
		await env.drain();
		const task = env.store.getTask(ids.taskId);
		expect(
			env.services.commands.requestRerun(
				v,
				ids.taskId,
				{
					expected_rev: task?.rev ?? 0,
					proposal_id: task?.current_proposal_id ?? "",
				},
				env.tick(),
			).status,
		).toBe(201);
		const before = dump(env.db);
		env.bridge.notify(ids.managedTaskId);
		await env.bridge.idle();
		expect(dump(env.db)).toBe(before);
		expect(stageOf(env, ids.taskId)).toBe("awaiting_run_approval");
		expect(env.alarms).toEqual([]);
	});
});
