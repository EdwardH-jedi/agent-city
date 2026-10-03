// Workspace commands (create / save draft / publish / rerun / cancel) at the service level.
import { afterEach, describe, expect, test } from "bun:test";
import { parseManagedConfig } from "../../managed/config.ts";
import { GitError } from "../../managed/git.ts";
import { getTask, openQuarantine } from "../../managed/store.ts";
import {
	approvedTask,
	createTask,
	draft,
	dump,
	type Env,
	expectOk,
	key,
	makeEnv,
	publish,
	runEngine,
} from "./test-support.ts";

const envs: Env[] = [];
const env = (o: Parameters<typeof makeEnv>[0] = {}) => {
	const e = makeEnv(o);
	envs.push(e);
	return e;
};
afterEach(() => {
	for (const e of envs.splice(0)) e.fx.cleanup();
});

const errorOf = (o: { body: unknown }) => (o.body as { error?: string }).error;

describe("create task", () => {
	test("key-idempotent: same key + body → the same task (200); different body → 409", async () => {
		const e = env();
		const v = await e.ctx();
		const k = key("create");
		const body = { idempotency_key: k, repo_id: e.fx.repoId, draft: draft() };
		const first = e.services.commands.createTask(v, body, e.tick());
		expect(first.status).toBe(201);
		const id = expectOk(first).task.id;
		const again = e.services.commands.createTask(
			v,
			structuredClone(body),
			e.tick(),
		);
		expect(again.status).toBe(200);
		expect(expectOk(again).task.id).toBe(id);
		const other = e.services.commands.createTask(
			v,
			{ ...body, draft: draft({ title: "Something else" }) },
			e.tick(),
		);
		expect(other.status).toBe(409);
		expect(errorOf(other)).toBe("idempotency_conflict");
		expect(e.store.listTasks().length).toBe(1);
		const t = expectOk(first).task;
		expect(t.stage).toBe("draft");
		expect(JSON.stringify(first.body)).not.toContain("idempotency_key");
		expect(JSON.stringify(first.body)).not.toContain("request_hash");
	});

	test("only the exact allowlisted repo id is accepted", async () => {
		const e = env();
		const v = await e.ctx();
		// well-formed but not allowlisted → 422; malformed for the frozen RepoId schema → 400
		const cases: [string, number, string][] = [
			["LOCAL/fixture", 422, "repo_not_allowed"],
			["local/Fixture", 422, "repo_not_allowed"],
			["local/other", 422, "repo_not_allowed"],
			["owner/name", 422, "repo_not_allowed"],
			["local/fixture/", 400, "invalid_request"],
			["local/./fixture", 400, "invalid_request"],
			["local/fixture ", 400, "invalid_request"],
		];
		for (const [repo_id, status, error] of cases) {
			const res = e.services.commands.createTask(
				v,
				{ idempotency_key: key(), repo_id, draft: draft() },
				e.now(),
			);
			expect({ repo_id, status: res.status, error: errorOf(res) }).toEqual({
				repo_id,
				status,
				error,
			});
		}
		expect(e.store.listTasks().length).toBe(0);
	});

	test("strict bodies: unknown fields, provider/model/argv overrides → 400; live → 422", async () => {
		const e = env();
		const v = await e.ctx();
		const base = {
			idempotency_key: key(),
			repo_id: e.fx.repoId,
			draft: draft(),
		};
		for (const body of [
			{ ...base, extra: 1 },
			{ ...base, draft: { ...draft(), provider: "claude" } },
			{ ...base, draft: { ...draft(), model: "x" } },
			{ ...base, draft: { ...draft(), argv: ["/bin/sh"] } },
			JSON.parse(
				`{"__proto__":{"polluted":true},"idempotency_key":"${key()}","repo_id":"${e.fx.repoId}","draft":${JSON.stringify(draft())}}`,
			),
		]) {
			const res = e.services.commands.createTask(v, body, e.now());
			expect(res.status).toBe(400);
			expect(JSON.stringify(res.body)).not.toContain("polluted");
		}
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		const live = e.services.commands.createTask(
			v,
			{ ...base, draft: { ...draft(), execution_mode: "live" } },
			e.now(),
		);
		expect(live.status).toBe(422);
		expect(errorOf(live)).toBe("live_disabled");
		expect(e.store.listTasks().length).toBe(0);
	});
});

describe("save draft", () => {
	test("CAS on rev: stale rev → 409; success bumps rev and never touches authority", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(e, v);
		const { request } = await publish(e, v, created.task.id);
		const t = e.store.getTask(created.task.id);
		const stale = e.services.commands.saveDraft(
			v,
			created.task.id,
			{ expected_rev: (t?.rev ?? 0) - 1, draft: draft({ title: "x" }) },
			e.now(),
		);
		expect(errorOf(stale)).toBe("stale_binding");
		const saved = expectOk(
			e.services.commands.saveDraft(
				v,
				created.task.id,
				{
					expected_rev: t?.rev,
					draft: draft({ title: "Edited while Gate 1 is pending" }),
				},
				e.tick(),
			),
		);
		expect(saved.task.rev).toBe((t?.rev ?? 0) + 1);
		expect(saved.task.stage).toBe("awaiting_run_approval");
		// the pending request still binds the PUBLISHED proposal, not the edited draft
		const row = e.store.getApprovalRequest(request.id);
		expect(row?.status).toBe("pending");
		expect(e.store.getProposal(row?.proposal_id ?? "")?.snapshot.title).toBe(
			"Add a simulated change",
		);
	});

	test("unknown task → 404; malformed id → 404; live draft → 422", async () => {
		const e = env();
		const v = await e.ctx();
		expect(
			e.services.commands.saveDraft(
				v,
				`wst-${crypto.randomUUID()}`,
				{ expected_rev: 1, draft: draft() },
				e.now(),
			).status,
		).toBe(404);
		expect(
			e.services.commands.saveDraft(
				v,
				"wst-../x",
				{ expected_rev: 1, draft: draft() },
				e.now(),
			).status,
		).toBe(404);
		const created = await createTask(e, v);
		expect(
			e.services.commands.saveDraft(
				v,
				created.task.id,
				{ expected_rev: 1, draft: { ...draft(), execution_mode: "live" } },
				e.now(),
			).status,
		).toBe(422);
	});
});

describe("publish proposal", () => {
	test("publishes the stored draft: proposal v1, reserved draft managed task, pending Gate 1", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(e, v);
		const { view, request } = await publish(e, v, created.task.id);
		expect(view.task.stage).toBe("awaiting_run_approval");
		expect(view.current_proposal?.version).toBe(1);
		expect(view.current_proposal?.snapshot.base_sha).toBe(e.fx.baseSha);
		expect(
			view.current_proposal?.snapshot.verification_plan.required_checks,
		).toEqual(["fixture-check"]);
		expect(view.current_proposal?.snapshot.repair_policy.max_repairs).toBe(0);
		expect(request.kind).toBe("run");
		const managed = getTask(e.db, request.managed_task_id);
		expect(managed?.state).toBe("draft");
		expect(managed?.idempotency_key).toBe(request.id);
		expect(managed?.request_hash).toBe(request.execution_binding_hash);
		expect(managed?.repair_limit).toBe(0);
		expect(managed?.run_requested_at).toBeNull();
		expect(view.engine?.state).toBe("draft");
		expect(view.phase).toBe("awaiting_run_approval");
	});

	test("stale rev → 409; incomplete draft → 400 with issues, nothing written", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(e, v, draft({ title: "", criteria: [] }));
		const snapshot = dump(e.db);
		const stale = await e.services.commands.publishProposal(
			v,
			created.task.id,
			{ expected_rev: 7 },
			e.now(),
		);
		expect(errorOf(stale)).toBe("stale_binding");
		const res = await e.services.commands.publishProposal(
			v,
			created.task.id,
			{ expected_rev: 1 },
			e.now(),
		);
		expect(res.status).toBe(400);
		const issues = (res.body as { issues?: { path: string }[] }).issues ?? [];
		expect(issues.map((i) => i.path)).toEqual(
			expect.arrayContaining(["title", "criteria"]),
		);
		expect(dump(e.db)).toBe(snapshot);
	});

	test("user text is redacted when frozen; the hash covers the sanitized snapshot", async () => {
		const e = env();
		const v = await e.ctx();
		const canary = `gh${"p_"}${"Z9y8X7w6V5".repeat(4).slice(0, 36)}`;
		const created = await createTask(
			e,
			v,
			draft({ objective: `Rotate ${canary} today.` }),
		);
		const { view } = await publish(e, v, created.task.id);
		expect(view.current_proposal?.snapshot.objective).not.toContain(canary);
		const proposals = e.db
			.query("SELECT snapshot FROM managed_proposals")
			.all() as { snapshot: string }[];
		for (const p of proposals) expect(p.snapshot).not.toContain(canary);
		const managed = e.db.query("SELECT objective FROM managed_tasks").all() as {
			objective: string;
		}[];
		for (const m of managed) expect(m.objective).not.toContain(canary);
	});

	test("a repo without configured checks / an unresolvable base → 422, nothing written", async () => {
		const none = env({ fixture: { verification: "none" } });
		const v1 = await none.ctx();
		const t1 = await createTask(none, v1);
		const r1 = await none.services.commands.publishProposal(
			v1,
			t1.task.id,
			{ expected_rev: 1 },
			none.now(),
		);
		expect(errorOf(r1)).toBe("repo_not_allowed");

		const broken = env({
			config: (fx) =>
				parseManagedConfig({
					...fx.config,
					repos: [{ ...fx.config.repos[0], base_ref: "no-such-branch" }],
				}),
		});
		const v2 = await broken.ctx();
		const t2 = await createTask(broken, v2);
		const snapshot = dump(broken.db);
		const r2 = await broken.services.commands.publishProposal(
			v2,
			t2.task.id,
			{ expected_rev: 1 },
			broken.now(),
		);
		expect(errorOf(r2)).toBe("repo_not_allowed");
		expect(dump(broken.db)).toBe(snapshot);
		expect(new GitError("x", "")).toBeInstanceOf(Error);
	});
});

describe("rerun", () => {
	test("after a cancelled execution: new managed task + new Gate 1 for the SAME proposal", async () => {
		const e = env();
		const v = await e.ctx();
		const ids = await approvedTask(e, v);
		const t = e.store.getTask(ids.taskId);
		expectOk(
			e.services.commands.cancel(
				v,
				ids.taskId,
				{ expected_rev: t?.rev },
				e.tick(),
			),
		);
		const t2 = e.store.getTask(ids.taskId);
		expect(t2?.stage).toBe("cancelled");
		const wrong = e.services.commands.requestRerun(
			v,
			ids.taskId,
			{ expected_rev: t2?.rev, proposal_id: `wsp-${crypto.randomUUID()}` },
			e.now(),
		);
		expect(errorOf(wrong)).toBe("stale_binding");
		const view = expectOk(
			e.services.commands.requestRerun(
				v,
				ids.taskId,
				{ expected_rev: t2?.rev, proposal_id: t2?.current_proposal_id },
				e.tick(),
			),
		);
		expect(view.task.stage).toBe("awaiting_run_approval");
		expect(view.task.current_proposal_id).toBe(t2?.current_proposal_id ?? "");
		expect(view.task.current_managed_task_id).not.toBe(ids.managedTaskId);
		expect(view.task.cancel_requested_at).toBeNull();
		const pending = view.approval_requests.filter(
			(r) => r.status === "pending",
		);
		expect(pending).toHaveLength(1);
		expect(getTask(e.db, pending[0]?.managed_task_id ?? "")?.state).toBe(
			"draft",
		);
		// a second rerun while Gate 1 is pending → invalid_state
		const again = e.services.commands.requestRerun(
			v,
			ids.taskId,
			{
				expected_rev: view.task.rev,
				proposal_id: view.task.current_proposal_id,
			},
			e.now(),
		);
		expect(errorOf(again)).toBe("invalid_state");
	});

	test("after the execution ended (engine failed): rerun opens a new Gate 1; an open quarantine blocks it", async () => {
		const e = env();
		const v = await e.ctx();
		const ids = await approvedTask(
			e,
			v,
			draft({ simulation_scenario: "verification_fails" }),
		);
		await runEngine(e);
		const managed = getTask(e.db, ids.managedTaskId);
		expect(managed?.state).toBe("failed");
		// the bridge (05) observes engine_ended
		e.store.transaction((tx) => {
			const t = tx.getTask(ids.taskId);
			if (
				!t ||
				!tx.updateTask(
					t.id,
					t.rev,
					{ stage: "execution_ended" },
					e.now().toISOString(),
				)
			)
				throw new Error("CAS");
		});
		openQuarantine(e.db, {
			task_id: ids.managedTaskId,
			run_id: null,
			pid: 999_998,
			started: null,
			reason: "test: unconfirmed termination",
			now: e.now().toISOString(),
		});
		const t = e.store.getTask(ids.taskId);
		const blocked = e.services.commands.requestRerun(
			v,
			ids.taskId,
			{ expected_rev: t?.rev, proposal_id: t?.current_proposal_id },
			e.now(),
		);
		expect(errorOf(blocked)).toBe("invalid_state");
		e.db
			.query("UPDATE managed_quarantine SET released_at = ? WHERE task_id = ?")
			.run(e.now().toISOString(), ids.managedTaskId);
		const view = expectOk(
			e.services.commands.requestRerun(
				v,
				ids.taskId,
				{ expected_rev: t?.rev, proposal_id: t?.current_proposal_id },
				e.tick(),
			),
		);
		expect(view.phase).toBe("awaiting_run_approval");
		expect(getTask(e.db, ids.managedTaskId)?.state).toBe("failed"); // the old execution is untouched
	});
});

describe("live precedence on every command", () => {
	test("execution_mode other than simulated anywhere in the body → 422 live_disabled", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(e, v);
		const id = created.task.id;
		const live = { execution_mode: "live" };
		const outs = [
			e.services.commands.saveDraft(
				v,
				id,
				{ expected_rev: 1, draft: draft(), ...live },
				e.now(),
			),
			await e.services.commands.publishProposal(
				v,
				id,
				{ expected_rev: 1, ...live },
				e.now(),
			),
			e.services.commands.requestRerun(
				v,
				id,
				{ expected_rev: 1, proposal_id: null, nested: [{ ...live }] },
				e.now(),
			),
			e.services.commands.cancel(
				v,
				id,
				{ expected_rev: 1, x: { y: { ...live } } },
				e.now(),
			),
		];
		for (const o of outs) expect(errorOf(o)).toBe("live_disabled");
	});
});
