// Zero provider calls (M1 L5, ADV-LIVE / ADV-LEGACY): the config's live block is ENABLED against
// generated stub `claude` / `codex` executables (so the engine would build real CLI adapters), and
// every crafted live path must be refused before any preflight. Evidence: counted adapter
// preflight / implement / review calls (fake AND live), counted live adapter lookups, and the stub
// executables' own call logs (a spawn appends a line).
import { afterEach, describe, expect, test } from "bun:test";
import type { ManagedTask } from "@agent-city/schema";
import {
	approvalHashFor,
	runTask,
	ServiceError,
	submitTask,
} from "../../managed/service.ts";
import { getTask, requestRun } from "../../managed/store.ts";
import {
	approved,
	type BridgeEnv,
	createTask,
	decisionFor,
	draft,
	engineOf,
	key,
	makeBridgeEnv,
	providerSpawns,
	publish,
	runsOf,
	stageOf,
	tracker,
} from "./test-support.ts";

const t = tracker();
afterEach(() => t.cleanup());

const liveEnv = () => t.track(makeBridgeEnv({ fixture: { liveStubs: {} } }));

const noCalls = (env: BridgeEnv) => {
	expect(env.calls.preflight).toBe(0);
	expect(env.calls.implement).toBe(0);
	expect(env.calls.review).toBe(0);
	expect(providerSpawns(env.fx)).toBe(0);
};

async function legacyLiveTask(env: BridgeEnv): Promise<ManagedTask> {
	const { task } = await submitTask(
		{ db: env.db, config: env.fx.config },
		{
			idempotency_key: key("legacy-live"),
			repo_id: env.fx.repoId,
			title: "Crafted live task",
			objective: "A live row created outside the workspace.",
			acceptance_criteria: ["x"],
			approved_scope: ["."],
			execution_mode: "live",
			repair_limit: 0,
		},
	);
	return task;
}

describe("crafted live requests never reach a provider", () => {
	test("the fixture really enables live mode against stub executables (precondition)", () => {
		const env = liveEnv();
		expect(env.fx.config.live.enabled).toBe(true);
		expect(env.adapters.implementer("live")).not.toBeNull();
		expect(env.calls.lookups.live).toBe(1);
	});

	test("legacy Run of a live row (live-enabled config) queues it, but authorize refuses before preflight", async () => {
		const env = liveEnv();
		const task = await legacyLiveTask(env);
		// the legacy service is still callable in-process: it queues (outside workspace mode)
		const res = runTask({ db: env.db, config: env.fx.config }, task.id);
		expect(res.queued).toBe(true);
		await env.bridge.sweep();
		expect(
			env.alarms.some(
				(a) =>
					a.kind === "ungoverned_execution" && a.managed_task_id === task.id,
			),
		).toBe(true);
		await env.drain();
		const m = getTask(env.db, task.id);
		expect(m?.state).toBe("blocked");
		expect(m?.failure_kind).toBe("approval_void");
		expect(runsOf(env, task.id)).toHaveLength(0);
		noCalls(env);
		expect(env.calls.lookups.live).toBe(0); // not even an adapter object was requested
	});

	test("DB-seeded queued live row with a correct approval_hash (no decision) → approval_void, zero calls", async () => {
		const env = liveEnv();
		const task = await legacyLiveTask(env);
		requestRun(
			env.db,
			task.id,
			approvalHashFor(task, env.fx.config),
			new Date().toISOString(),
		);
		await env.drain();
		expect(getTask(env.db, task.id)?.failure_kind).toBe("approval_void");
		noCalls(env);
		expect(env.calls.lookups.live).toBe(0);
	});

	test("an approved simulated execution switched to live in the DB after Gate 1 → refused before preflight (ADV-LIVE-05)", async () => {
		const env = liveEnv();
		const v = await env.ctx();
		const ids = await approved(env, v);
		env.db
			.query("UPDATE managed_tasks SET execution_mode = 'live' WHERE id = ?")
			.run(ids.managedTaskId);
		const row = engineOf(env, ids.managedTaskId);
		if (!row) throw new Error("no row");
		expect(env.bridge.authorize(row)).toBe(
			"only simulated execution is allowed in M1",
		);
		await env.drain();
		const m = engineOf(env, ids.managedTaskId);
		expect(m?.state).toBe("blocked");
		expect(m?.failure_kind).toBe("approval_void");
		expect(stageOf(env, ids.taskId)).toBe("execution_ended");
		noCalls(env);
		expect(env.calls.lookups.live).toBe(0);
	});

	test("legacy Run of a workspace-governed execution → 409 workspace_governed; nothing queued", async () => {
		const env = liveEnv();
		const v = await env.ctx();
		const taskId = createTask(env, v);
		const { managedTaskId } = await publish(env, v, taskId);
		let err: unknown = null;
		try {
			runTask({ db: env.db, config: env.fx.config }, managedTaskId);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(ServiceError);
		expect((err as ServiceError).code).toBe("workspace_governed");
		expect(engineOf(env, managedTaskId)?.state).toBe("draft");
		await env.drain();
		noCalls(env);
	});

	test("client-supplied live mode / provider settings are refused by the workspace commands before anything is stored", async () => {
		const env = liveEnv();
		const v = await env.ctx();
		const managedBefore = env.db
			.query<{ n: number }, []>("SELECT count(*) AS n FROM managed_tasks")
			.get()?.n;
		const live = env.services.commands.createTask(
			v,
			{
				idempotency_key: key("c"),
				repo_id: env.fx.repoId,
				draft: draft({ execution_mode: "live" as "simulated" }),
			},
			env.tick(),
		);
		expect(live.status).toBe(422);
		expect((live.body as { error: string }).error).toBe("live_disabled");
		for (const extra of [
			{ provider: "claude" },
			{ model: "any-model" },
			{ argv: ["/bin/sh", "-c", "true"] },
			{ provider_profiles: { implementer: "claude" } },
		]) {
			const res = env.services.commands.createTask(
				v,
				{
					idempotency_key: key("c"),
					repo_id: env.fx.repoId,
					draft: { ...draft(), ...extra },
				},
				env.tick(),
			);
			expect(res.status).toBe(400);
		}
		// a decision body carrying a mode override
		const taskId = createTask(env, v);
		const { runRequestId, managedTaskId } = await publish(env, v, taskId);
		const body = {
			...decisionFor(env, v, runRequestId),
			execution_mode: "live",
		};
		const res = await env.services.decisions.decide(
			v,
			runRequestId,
			body,
			env.tick(),
		);
		expect(res.status).toBe(422);
		expect(engineOf(env, managedTaskId)?.state).toBe("draft");
		const managedAfter = env.db
			.query<{ n: number }, []>("SELECT count(*) AS n FROM managed_tasks")
			.get()?.n;
		expect(managedAfter).toBe((managedBefore ?? 0) + 1); // only the one reservation
		await env.drain();
		noCalls(env);
	});

	test("a full simulated run on the live-enabled config uses fake adapters only (suite postcondition)", async () => {
		const env = liveEnv();
		const v = await env.ctx();
		const ids = await approved(env, v);
		await env.drain();
		expect(stageOf(env, ids.taskId)).toBe("awaiting_acceptance");
		expect(env.calls.implement).toBe(1);
		expect(env.calls.review).toBe(1);
		expect(env.calls.lookups.live).toBe(0);
		expect(providerSpawns(env.fx)).toBe(0);
	});
});
