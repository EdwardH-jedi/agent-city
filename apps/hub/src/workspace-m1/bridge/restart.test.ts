// Restart (file-backed DB, same artifacts root): a new hub process = new handle, new store, new auth
// boot, new bridge whose startup sweep re-derives everything from durable rows. Truthful
// interrupted / blocked state, no automatic execution, receipts intact, Gate 2 opened exactly once.
import { afterEach, describe, expect, test } from "bun:test";
import { pidAlive } from "../../managed/testkit.ts";
import {
	approved,
	createTask,
	draft,
	dump,
	engineOf,
	HOLD_HEARTBEAT_MS,
	makeBridgeEnv,
	publish,
	restartBridgeEnv,
	resultRequests,
	runsOf,
	stageOf,
	tracker,
	waitFor,
} from "./test-support.ts";

const t = tracker();
afterEach(() => t.cleanup());

const fileEnv = () => t.track(makeBridgeEnv({ fixture: { dbFile: true } }));

describe("restart reconciliation", () => {
	test("crash after the implement launch intent: interrupted, never re-run, the stale worker writes nothing, receipts intact", async () => {
		const e1 = fileEnv();
		const v = await e1.ctx();
		const ids = await approved(
			e1,
			v,
			draft({ simulation_scenario: "impl_hangs" }),
		);
		const decision = e1.store.getDecision(ids.decisionId);
		const a = e1.engine({ heartbeatMs: HOLD_HEARTBEAT_MS, workerId: "old" });
		const runningA = a.tick();
		await waitFor(
			() => runsOf(e1, ids.managedTaskId)[0]?.child_pid != null,
			"the hanging implementer child",
		);
		const pid = runsOf(e1, ids.managedTaskId)[0]?.child_pid ?? 0;
		await e1.bridge.idle();
		expect(stageOf(e1, ids.taskId)).toBe("running");

		// "crash": a new process opens the same DB; its worker sees the old lease as expired
		const e2 = t.track(restartBridgeEnv(e1));
		await e2.bridge.sweep();
		expect(stageOf(e2, ids.taskId)).toBe("running"); // the engine has not judged it yet
		const b = e2.engine({
			workerId: "new",
			now: () => new Date(Date.now() + 120_000),
		});
		await b.tick();
		await e2.bridge.idle();
		const m = engineOf(e2, ids.managedTaskId);
		expect(m?.state).toBe("interrupted");
		expect(runsOf(e2, ids.managedTaskId)[0]?.state).toBe("unknown");
		expect(pidAlive(pid)).toBe(false); // the recorded child was ours and is gone
		expect(stageOf(e2, ids.taskId)).toBe("execution_ended");

		// the old worker's late callbacks are fenced out
		const fence = m?.fence_token;
		await a.shutdown();
		await runningA;
		expect(engineOf(e2, ids.managedTaskId)?.fence_token).toBe(fence ?? -1);
		expect(engineOf(e2, ids.managedTaskId)?.state).toBe("interrupted");

		// no automatic re-run, by either process
		await e2.drain();
		await e2.bridge.sweep();
		expect(runsOf(e2, ids.managedTaskId)).toHaveLength(1);
		expect(e1.calls.implement + e2.calls.implement).toBe(1);
		expect(resultRequests(e2, ids.taskId)).toHaveLength(0);
		// receipts survive byte-identically
		expect(e2.store.getDecision(ids.decisionId)).toEqual(decision);
	});

	test("crash while queued (no launch intent): after restart the durable decision still authorizes it; it runs exactly once", async () => {
		const e1 = fileEnv();
		const v = await e1.ctx();
		const ids = await approved(e1, v);
		const e2 = t.track(restartBridgeEnv(e1));
		await e2.bridge.sweep();
		expect(stageOf(e2, ids.taskId)).toBe("queued");
		await e2.drain();
		expect(engineOf(e2, ids.managedTaskId)?.state).toBe("human_ready");
		expect(stageOf(e2, ids.taskId)).toBe("awaiting_acceptance");
		expect(runsOf(e2, ids.managedTaskId)).toHaveLength(1);
		expect(e2.calls.implement).toBe(1);
		expect(e1.calls.implement).toBe(0);
		expect(
			resultRequests(e2, ids.taskId)[0]?.result_envelope?.run_decision_id,
		).toBe(ids.decisionId);
	});

	test("human_ready but the bridge never sealed (crash): the restart sweep opens Gate 2 once; a second restart changes nothing", async () => {
		const e1 = fileEnv();
		const v = await e1.ctx();
		const ids = await approved(e1, v);
		await e1.drain(e1.engine({ onChange: false }));
		expect(engineOf(e1, ids.managedTaskId)?.state).toBe("human_ready");
		expect(stageOf(e1, ids.taskId)).toBe("queued");
		expect(resultRequests(e1, ids.taskId)).toHaveLength(0);

		const e2 = t.track(restartBridgeEnv(e1));
		await e2.bridge.sweep();
		expect(stageOf(e2, ids.taskId)).toBe("awaiting_acceptance");
		expect(resultRequests(e2, ids.taskId)).toHaveLength(1);

		const e3 = t.track(restartBridgeEnv(e2));
		const before = dump(e3.db);
		await e3.bridge.sweep();
		await e3.bridge.sweep();
		expect(dump(e3.db)).toBe(before);
		expect(e3.alarms).toEqual([]);
	});

	test("a pending Gate 1 survives a restart untouched (unchanged policy and base)", async () => {
		const e1 = fileEnv();
		const v = await e1.ctx();
		const taskId = createTask(e1, v);
		const { managedTaskId } = await publish(e1, v, taskId);
		const e2 = t.track(restartBridgeEnv(e1));
		const before = dump(e2.db);
		const report = await e2.bridge.sweep();
		expect(report.invalidated).toBe(0);
		expect(dump(e2.db)).toBe(before);
		expect(stageOf(e2, taskId)).toBe("awaiting_run_approval");
		expect(engineOf(e2, managedTaskId)?.state).toBe("draft");
	});

	test("start() runs the startup sweep and stop() halts the queue", async () => {
		const e1 = fileEnv();
		const v = await e1.ctx();
		const ids = await approved(e1, v);
		await e1.drain(e1.engine({ onChange: false }));
		const e2 = t.track(restartBridgeEnv(e1));
		e2.bridge.start({ intervalMs: 60_000 });
		await waitFor(
			() => stageOf(e2, ids.taskId) === "awaiting_acceptance",
			"the startup sweep",
		);
		await e2.bridge.stop();
		const before = dump(e2.db);
		e2.bridge.notify(ids.managedTaskId);
		await e2.bridge.idle();
		expect(dump(e2.db)).toBe(before);
	});
});
