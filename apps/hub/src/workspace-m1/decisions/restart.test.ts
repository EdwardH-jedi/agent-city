// Restart: a new hub process on the same database file (new handle, new store, new auth boot).
// Receipts and workflow state survive; challenges and sessions do not; nothing re-runs by itself.
import { afterEach, describe, expect, test } from "bun:test";
import { getTask } from "../../managed/store.ts";
import {
	approvedTask,
	challenge,
	createTask,
	decisionBody,
	dump,
	type Env,
	expectOk,
	makeEnv,
	openGate2,
	publish,
	restartEnv,
	runEngine,
} from "./test-support.ts";

const envs: Env[] = [];
afterEach(() => {
	const seen = new Set<string>();
	for (const e of envs.splice(0)) {
		try {
			e.db.close();
		} catch {
			// already closed
		}
		if (!seen.has(e.fx.dir)) {
			seen.add(e.fx.dir);
			e.fx.cleanup();
		}
	}
});
const track = (e: Env) => {
	envs.push(e);
	return e;
};

describe("restart", () => {
	test("lost response across a restart: the same body returns the original receipt", async () => {
		const e1 = track(makeEnv({ fixture: { dbFile: true } }));
		const v1 = await e1.ctx();
		const created = await createTask(e1, v1);
		const { request } = await publish(e1, v1, created.task.id);
		const ch = challenge(e1, v1, request.id);
		const body = decisionBody(ch);
		const first = expectOk(
			await e1.services.decisions.decide(v1, request.id, body, e1.tick()),
		);
		const e2 = track(restartEnv(e1));
		expect(e2.auth.boot_id).not.toBe(e1.auth.boot_id);
		const v2 = await e2.ctx();
		const snapshot = dump(e2.db);
		const again = expectOk(
			await e2.services.decisions.decide(v2, request.id, body, e2.tick()),
		);
		expect(again.replayed).toBe(true);
		expect(again.receipt).toEqual(first.receipt);
		expect(dump(e2.db)).toBe(snapshot);
		// a different payload with the same key is still a conflict after the restart
		const conflict = await e2.services.decisions.decide(
			v2,
			request.id,
			{ ...body, action: "reject", confirmation_text: null, reason: "x" },
			e2.tick(),
		);
		expect((conflict.body as { error: string }).error).toBe(
			"idempotency_conflict",
		);
	});

	test("a new boot voids outstanding challenges without a write; the request stays pending", async () => {
		const e1 = track(makeEnv({ fixture: { dbFile: true } }));
		const v1 = await e1.ctx();
		const created = await createTask(e1, v1);
		const { request } = await publish(e1, v1, created.task.id);
		const ch = challenge(e1, v1, request.id);
		const e2 = track(restartEnv(e1));
		const v2 = await e2.ctx();
		const snapshot = dump(e2.db);
		const res = await e2.services.decisions.decide(
			v2,
			request.id,
			decisionBody(ch),
			e2.now(),
		);
		expect(res.status).toBe(409);
		expect((res.body as { error: string }).error).toBe("challenge_invalid");
		expect(dump(e2.db)).toBe(snapshot);
		expect(e2.store.getApprovalRequest(request.id)?.status).toBe("pending");
		expect(getTask(e2.db, request.managed_task_id)?.state).toBe("draft");
		// a fresh challenge from the new boot works
		const fresh = challenge(e2, v2, request.id);
		expect(
			(
				await e2.services.decisions.decide(
					v2,
					request.id,
					decisionBody(fresh),
					e2.now(),
				)
			).status,
		).toBe(201);
	});

	test("Gate 2 pending across a restart needs a fresh challenge; the acceptance survives the next restart", async () => {
		const e1 = track(makeEnv({ fixture: { dbFile: true } }));
		const v1 = await e1.ctx();
		const ids = await approvedTask(e1, v1);
		await runEngine(e1);
		const result = await openGate2(e1, ids);
		const old = challenge(e1, v1, result.id);
		const e2 = track(restartEnv(e1));
		const v2 = await e2.ctx();
		const stale = await e2.services.decisions.decide(
			v2,
			result.id,
			decisionBody(old),
			e2.now(),
		);
		expect((stale.body as { error: string }).error).toBe("challenge_invalid");
		const ch = challenge(e2, v2, result.id);
		const body = decisionBody(ch);
		const accepted = expectOk(
			await e2.services.decisions.decide(v2, result.id, body, e2.tick()),
		);
		const e3 = track(restartEnv(e2));
		const v3 = await e3.ctx();
		expect(e3.store.getTask(ids.taskId)?.stage).toBe("accepted");
		expect(getTask(e3.db, ids.managedTaskId)?.state).toBe("human_ready");
		const replay = expectOk(
			await e3.services.decisions.decide(v3, result.id, body, e3.tick()),
		);
		expect(replay.replayed).toBe(true);
		expect(replay.receipt).toEqual(accepted.receipt);
	});

	test("a queued execution is not re-queued by a restart (one linkage, same run_requested_at)", async () => {
		const e1 = track(makeEnv({ fixture: { dbFile: true } }));
		const v1 = await e1.ctx();
		const ids = await approvedTask(e1, v1);
		const before = getTask(e1.db, ids.managedTaskId);
		const e2 = track(restartEnv(e1));
		const after = getTask(e2.db, ids.managedTaskId);
		expect(after?.state).toBe("queued");
		expect(after?.run_requested_at).toBe(before?.run_requested_at ?? "");
		expect(after?.fence_token).toBe(before?.fence_token ?? -1);
	});
});
