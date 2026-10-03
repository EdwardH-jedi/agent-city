// `bridge.authorize` (OrchestratorDeps.authorize) — every denial class against real rows created
// through 04's Gate-1 flow, plus fail-closed behaviour on tampered rows. Pure reads: the check must
// never open a transaction (it runs inside orchestrator flows).
import { afterEach, describe, expect, test } from "bun:test";
import type { ManagedTask } from "@agent-city/schema";
import { submitTask } from "../../managed/service.ts";
import { requestRun } from "../../managed/store.ts";
import { evaluateAuthorization } from "./authorize.ts";
import {
	approved,
	createTask,
	draft,
	engineOf,
	makeBridgeEnv,
	publish,
	stageOf,
	tracker,
} from "./test-support.ts";

const t = tracker();
afterEach(() => t.cleanup());

const must = (m: ManagedTask | null): ManagedTask => {
	if (!m) throw new Error("no managed task");
	return m;
};

describe("authorize: allowed", () => {
	test("the queued execution of an approved Gate-1 request passes; the check opens no transaction", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(env, v);
		const task = must(engineOf(env, ids.managedTaskId));
		let began = 0;
		const original = env.db.transaction.bind(env.db);
		env.db.transaction = ((fn: never) => {
			began++;
			return original(fn);
		}) as typeof env.db.transaction;
		try {
			expect(env.bridge.authorize(task)).toBeNull();
		} finally {
			env.db.transaction = original;
		}
		expect(began).toBe(0);
		expect(env.db.inTransaction).toBe(false);
	});
});

describe("authorize: denials (each is a fixed reason; the engine records approval_void)", () => {
	test("ungoverned: a legacy managed task queued by the old Run path", async () => {
		const env = t.track(makeBridgeEnv());
		const { task } = await submitTask(
			{ db: env.db, config: env.fx.config },
			{
				idempotency_key: "legacy-authz-0001",
				repo_id: env.fx.repoId,
				title: "Legacy",
				objective: "A row created outside the workspace.",
				acceptance_criteria: ["x"],
				approved_scope: ["."],
				execution_mode: "simulated",
				simulation_scenario: "approve",
				repair_limit: 0,
			},
		);
		const queued = requestRun(
			env.db,
			task.id,
			"0".repeat(64),
			"2026-10-02T08:00:00.000Z",
		);
		expect(env.bridge.authorize(must(queued?.task ?? null))).toBe(
			"no workspace Gate-1 request governs this execution",
		);
	});

	test("not_approved: the reservation of a pending Gate 1 (even if something queued it)", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const taskId = createTask(env, v);
		const { managedTaskId } = await publish(env, v, taskId);
		const reserved = must(engineOf(env, managedTaskId));
		expect(env.bridge.authorize(reserved)).toBe(
			"the Gate-1 request is pending",
		);
		expect(
			env.bridge.authorize({
				...reserved,
				state: "queued",
				run_requested_at: "2026-10-02T08:00:09.000Z",
			}),
		).toBe("the Gate-1 request is pending");
	});

	test("mode / requeued / content / identity: the managed row must be exactly what Gate 1 queued", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(env, v);
		const task = must(engineOf(env, ids.managedTaskId));
		const deny = (over: Partial<ManagedTask>) =>
			env.bridge.authorize({ ...task, ...over });
		expect(deny({ execution_mode: "live" })).toBe(
			"only simulated execution is allowed in M1",
		);
		expect(deny({ run_requested_at: "2026-10-02T09:00:00.000Z" })).toBe(
			"the execution was queued by something other than its Gate-1 decision",
		);
		expect(deny({ run_requested_at: null })).toBe(
			"the execution was queued by something other than its Gate-1 decision",
		);
		const content = "the managed task differs from the approved proposal";
		expect(deny({ title: "Another title" })).toBe(content);
		expect(deny({ approved_scope: ["src"] })).toBe(content);
		expect(deny({ repair_limit: 1 })).toBe(content);
		expect(deny({ simulation_scenario: "reject_always" })).toBe(content);
		expect(deny({ base_sha: "f".repeat(40) })).toBe(content);
		expect(deny({ idempotency_key: "another-key-0001" })).toBe(content);
		expect(deny({ request_hash: "e".repeat(64) })).toBe(content);
	});

	test("policy: the binding no longer recomputes under the current frozen config; repo: left the allowlist", async () => {
		const base = t.track(makeBridgeEnv());
		const v = await base.ctx();
		const ids = await approved(base, v);
		const task = must(engineOf(base, ids.managedTaskId));
		const changed = structuredClone(base.fx.config);
		const repo = changed.repos[0];
		if (!repo?.verification[0]) throw new Error("fixture repo");
		repo.verification[0].timeout_s = 31;
		expect(
			evaluateAuthorization(base.store, changed, task, { policy: true }),
		).toMatchObject({ ok: false, cls: "policy" });
		// the reconciler's structural check ignores policy (the engine's approval_void covers it)
		expect(
			evaluateAuthorization(base.store, changed, task, { policy: false }).ok,
		).toBe(true);
		const gone = { ...structuredClone(base.fx.config), repos: [] };
		expect(
			evaluateAuthorization(base.store, gone, task, { policy: true }),
		).toMatchObject({ ok: false, cls: "repo" });
	});

	test("not_current / stage: an ended execution's row, and a superseded execution after a rerun", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(
			env,
			v,
			draft({ simulation_scenario: "verification_fails" }),
		);
		await env.drain();
		expect(stageOf(env, ids.taskId)).toBe("execution_ended");
		const ended = must(engineOf(env, ids.managedTaskId));
		expect(env.bridge.authorize({ ...ended, state: "queued" })).toBe(
			"the workspace task is execution_ended",
		);
		// rerun = new managed task + new Gate 1; the old row is no longer current
		const task = env.store.getTask(ids.taskId);
		const rerun = env.services.commands.requestRerun(
			v,
			ids.taskId,
			{
				expected_rev: task?.rev ?? 0,
				proposal_id: task?.current_proposal_id ?? "",
			},
			env.tick(),
		);
		expect(rerun.status).toBe(201);
		expect(env.bridge.authorize({ ...ended, state: "queued" })).toBe(
			"this is not the current execution of its workspace task",
		);
	});

	test("flagged: a managed task the reconciler found in violation is denied", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(env, v);
		const task = must(engineOf(env, ids.managedTaskId));
		// violation: the reserved row of another Gate 1 queued without a decision → flag (not this one)
		expect(env.bridge.authorize(task)).toBeNull();
		const taskId2 = createTask(env, v);
		const second = await publish(env, v, taskId2);
		env.db
			.query(
				"UPDATE managed_tasks SET state = 'queued', run_requested_at = ? WHERE id = ?",
			)
			.run("2026-10-02T08:00:30.000Z", second.managedTaskId);
		await env.bridge.sweep();
		expect(env.bridge.flagged()).toContain(second.managedTaskId);
		expect(env.bridge.flagged()).not.toContain(ids.managedTaskId);
		expect(
			env.bridge.authorize(must(engineOf(env, second.managedTaskId))),
		).toBe("a workspace violation was detected for this execution");
	});

	test("error: a tampered hashed column (store integrity error) is a denial, never a throw", async () => {
		const env = t.track(makeBridgeEnv());
		const v = await env.ctx();
		const ids = await approved(env, v);
		const task = must(engineOf(env, ids.managedTaskId));
		env.db.run("DROP TRIGGER IF EXISTS managed_approval_requests_update_rules");
		env.db
			.query(
				"UPDATE managed_approval_requests SET execution_binding = replace(execution_binding, '\"contract\"', '\"contract\" ') WHERE id = ?",
			)
			.run(ids.runRequestId);
		expect(env.bridge.authorize(task)).toBe(
			"the workspace authorization check failed",
		);
	});
});
