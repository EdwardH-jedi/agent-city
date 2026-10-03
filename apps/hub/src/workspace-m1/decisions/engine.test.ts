// The default ExecutionBridge (over 02's managed writes) and the client-facing engine detail.
import { afterEach, describe, expect, test } from "bun:test";
import { getTask } from "../../managed/store.ts";
import { scrubDetail } from "./engine.ts";
import {
	createTask,
	type Env,
	expectOk,
	makeEnv,
	publish,
} from "./test-support.ts";

const envs: Env[] = [];
afterEach(() => {
	for (const e of envs.splice(0)) e.fx.cleanup();
});

describe("engine detail", () => {
	test("host paths never reach a client through state_detail", () => {
		expect(
			scrubDetail(
				"verification changed the workspace (/private/tmp/x/workspaces/run-1/a.txt); stop",
			),
		).toBe("verification changed the workspace ([path]); stop");
		expect(scrubDetail("see ~/secret/dir now")).toBe("see [path] now");
		expect(scrubDetail("cancelled; no owned process is running")).toBe(
			"cancelled; no owned process is running",
		);
		expect(scrubDetail("x".repeat(2000)).length).toBe(500);
	});

	test("EngineView of a reserved execution, and the bridge's requestCancel", async () => {
		const e = makeEnv();
		envs.push(e);
		const v = await e.ctx();
		const created = await createTask(e, v);
		const { request } = await publish(e, v, created.task.id);
		const view = e.services.bridge.engineView(request.managed_task_id);
		expect(view?.state).toBe("draft");
		expect(view?.quarantined).toBe(false);
		expect(view?.attempt_no).toBeNull();
		expect(
			e.services.bridge.engineView(`task-${crypto.randomUUID()}`),
		).toBeNull();
		expect(e.services.bridge.currentPolicyHash(e.fx.repoId)).toBe(
			request.execution_binding.policy_hash,
		);
		// a reserved (unleased) task cancels at once — never queued
		const t = e.store.getTask(created.task.id);
		expectOk(
			e.services.commands.cancel(
				v,
				created.task.id,
				{ expected_rev: t?.rev },
				e.tick(),
			),
		);
		expect(getTask(e.db, request.managed_task_id)?.state).toBe("cancelled");
		expect(getTask(e.db, request.managed_task_id)?.run_requested_at).toBeNull();
	});
});
