// Multi-repository boundaries, server side (multi-repository milestone, Worker A). Two allowlisted fixture
// repositories (A = the primary `local/fixture`, B = `local/fixture-b`, each its own git repository with a
// distinct base commit) on one hub database: every repository/task relationship is enforced by the server —
// never by client-side filtering — and the engine keeps ONE execution at a time across repositories.
import { afterEach, describe, expect, test } from "bun:test";
import type { VerifiedAuthContext } from "@agent-city/schema/workspace-m1";
import { policyHash } from "../../managed/config.ts";
import {
	claimNext,
	getTask,
	listArtifacts,
	openQuarantine,
} from "../../managed/store.ts";
import {
	approvedTask,
	challenge,
	count,
	decisionBody,
	draft,
	type Env,
	expectOk,
	key,
	makeEnv,
	publish,
	runEngine,
} from "./test-support.ts";

const REPO_B = "local/fixture-b";

const envs: Env[] = [];
afterEach(() => {
	for (const e of envs.splice(0)) e.fx.cleanup();
});
const env = () => {
	const e = makeEnv({
		fixture: { extraRepos: [{ id: REPO_B, label: "b" }] },
	});
	envs.push(e);
	return e;
};

const errorOf = (o: { body: unknown }) => (o.body as { error?: string }).error;

/** create in `repo` (service level, the route's own command). */
function createIn(e: Env, v: VerifiedAuthContext, repo: string, title: string) {
	return expectOk(
		e.services.commands.createTask(
			v,
			{
				idempotency_key: key("create"),
				repo_id: repo,
				draft: draft({ title }),
			},
			e.tick(),
		),
		`create in ${repo}`,
	);
}

/** create in `repo` → publish → challenge → approve; returns the ids of the queued execution. */
async function approvedIn(
	e: Env,
	v: VerifiedAuthContext,
	repo: string,
	title: string,
) {
	const created = createIn(e, v, repo, title);
	const { request } = await publish(e, v, created.task.id);
	const ch = challenge(e, v, request.id);
	const out = expectOk(
		await e.services.decisions.decide(
			v,
			request.id,
			decisionBody(ch),
			e.tick(),
		),
		"approve",
	);
	return {
		taskId: created.task.id,
		runRequestId: request.id,
		managedTaskId: request.managed_task_id,
		decisionId: out.receipt.decision_id,
	};
}

const snapshot = (e: Env) =>
	expectOk(e.services.reads.snapshot(e.now()), "snapshot");

describe("repository ownership is the server's", () => {
	test("the fixture repositories are distinct: ids, paths, base commits, policy hashes", () => {
		const e = env();
		const [a, b] = e.fx.repos;
		expect(e.fx.repos.map((r) => r.id)).toEqual(["local/fixture", REPO_B]);
		expect(a?.path).not.toBe(b?.path);
		expect(a?.baseSha).toMatch(/^[0-9a-f]{40}$/);
		expect(b?.baseSha).toMatch(/^[0-9a-f]{40}$/);
		expect(a?.baseSha).not.toBe(b?.baseSha);
		expect(policyHash(e.config, "local/fixture")).not.toBe(
			policyHash(e.config, REPO_B),
		);
	});

	test("each task's proposal and Gate-1 binding carry ITS repository, base commit and policy", async () => {
		const e = env();
		const v = await e.ctx();
		const ta = createIn(e, v, "local/fixture", "A task");
		const tb = createIn(e, v, REPO_B, "B task");
		const pa = await publish(e, v, ta.task.id);
		const pb = await publish(e, v, tb.task.id);
		for (const [p, repo, i] of [
			[pa, "local/fixture", 0],
			[pb, REPO_B, 1],
		] as const) {
			const fxRepo = e.fx.repos[i];
			expect(p.view.task.repo_id).toBe(repo);
			expect(p.view.current_proposal?.snapshot.repo_id).toBe(repo);
			expect(p.view.current_proposal?.snapshot.base_sha).toBe(fxRepo?.baseSha);
			expect(String(p.request.execution_binding.base_sha)).toBe(
				fxRepo?.baseSha ?? "",
			);
			expect(p.request.execution_binding.policy_hash).toBe(
				policyHash(e.config, repo),
			);
			expect(getTask(e.db, p.request.managed_task_id)?.repo_id).toBe(repo);
			expect(getTask(e.db, p.request.managed_task_id)?.base_sha).toBe(
				fxRepo?.baseSha,
			);
		}
		// neither publish started anything
		expect(
			count(
				e.db,
				"SELECT count(*) AS n FROM managed_tasks WHERE state != 'draft'",
			),
		).toBe(0);
		// the snapshot attributes tasks and pending documents to the right repository
		const snap = snapshot(e);
		const repoOf = new Map(snap.tasks.map((t) => [t.task.id, t.task.repo_id]));
		expect(repoOf.get(ta.task.id)).toBe("local/fixture");
		expect(repoOf.get(tb.task.id)).toBe(REPO_B);
		expect(
			snap.pending_requests.map((r) => [r.id, repoOf.get(r.workspace_task_id)]),
		).toEqual([
			[pa.request.id, "local/fixture"],
			[pb.request.id, REPO_B],
		]);
		expect(
			snap.tasks.find((t) => t.task.id === tb.task.id)?.latest_request,
		).toMatchObject({ id: pb.request.id, kind: "run", status: "pending" });
	});

	test("a task cannot change repository: draft bodies refuse repo_id; the row trigger refuses an UPDATE", async () => {
		const e = env();
		const v = await e.ctx();
		const ta = createIn(e, v, "local/fixture", "Stays in A");
		const save = e.services.commands.saveDraft(
			v,
			ta.task.id,
			{
				expected_rev: ta.task.rev,
				draft: { ...draft({ title: "Stays in A" }), repo_id: REPO_B },
			},
			e.tick(),
		);
		expect(save.status).toBe(400);
		const res = await e.request(
			"PUT",
			`/tasks/${ta.task.id}/draft`,
			await e.login(),
			{ expected_rev: ta.task.rev, draft: draft(), repo_id: REPO_B },
		);
		expect(res.status).toBe(400);
		expect(() =>
			e.db
				.query("UPDATE workspace_tasks SET repo_id = ? WHERE id = ?")
				.run(REPO_B, ta.task.id),
		).toThrow();
		const { request } = await publish(e, v, ta.task.id);
		expect(e.store.getTask(ta.task.id)?.repo_id).toBe("local/fixture");
		expect(getTask(e.db, request.managed_task_id)?.repo_id).toBe(
			"local/fixture",
		);
	});
});

describe("cross-repository references are refused", () => {
	test("rerun of B naming A's proposal → 409 stale_binding, nothing reserved", async () => {
		const e = env();
		const v = await e.ctx();
		const a = await approvedIn(e, v, "local/fixture", "A for rerun");
		const tb = createIn(e, v, REPO_B, "B rerun target");
		const pb = await publish(e, v, tb.task.id);
		// withdraw B's Gate 1 so B is rerunnable (cancelled)
		const bRow = e.store.getTask(tb.task.id);
		expectOk(
			e.services.commands.cancel(
				v,
				tb.task.id,
				{ expected_rev: bRow?.rev ?? 0 },
				e.tick(),
			),
			"withdraw B",
		);
		const aProposal = e.store.getTask(a.taskId)?.current_proposal_id ?? "";
		const before = count(e.db, "SELECT count(*) AS n FROM managed_tasks");
		const bNow = e.store.getTask(tb.task.id);
		const res = e.services.commands.requestRerun(
			v,
			tb.task.id,
			{ expected_rev: bNow?.rev ?? 0, proposal_id: aProposal },
			e.tick(),
		);
		expect([res.status, errorOf(res)]).toEqual([409, "stale_binding"]);
		expect(count(e.db, "SELECT count(*) AS n FROM managed_tasks")).toBe(before);
		// B's own proposal still reruns (control)
		const ok = e.services.commands.requestRerun(
			v,
			tb.task.id,
			{
				expected_rev: bNow?.rev ?? 0,
				proposal_id: pb.view.task.current_proposal_id ?? "",
			},
			e.tick(),
		);
		expect(ok.status).toBe(201);
	});

	test("A's challenge cannot decide B's request; B's binding hash cannot open a challenge on A's", async () => {
		const e = env();
		const v = await e.ctx();
		const pa = await publish(
			e,
			v,
			createIn(e, v, "local/fixture", "A gate").task.id,
		);
		const pb = await publish(e, v, createIn(e, v, REPO_B, "B gate").task.id);
		const before = count(e.db, "SELECT count(*) AS n FROM managed_decisions");
		// B's binding on A's request → stale_binding, no challenge issued on A
		const crossIssue = e.services.decisions.issueChallenge(
			v,
			pa.request.id,
			{
				kind: "run",
				binding_hash: pb.request.binding_hash,
				expected_request_rev: pa.request.rev,
			},
			e.tick(),
		);
		expect([crossIssue.status, errorOf(crossIssue)]).toEqual([
			409,
			"stale_binding",
		]);
		expect(e.store.getApprovalRequest(pa.request.id)?.challenge_status).toBe(
			"none",
		);
		// A's challenge string presented on B's request with B's own binding and rev → challenge_invalid
		const chA = challenge(e, v, pa.request.id);
		const chB = challenge(e, v, pb.request.id);
		const swapped = await e.services.decisions.decide(
			v,
			pb.request.id,
			decisionBody({ ...chB, challenge: chA.challenge }),
			e.tick(),
		);
		expect([swapped.status, errorOf(swapped)]).toEqual([
			409,
			"challenge_invalid",
		]);
		// A's whole body (A's binding) sent to B's request → stale_binding
		const wholeA = await e.services.decisions.decide(
			v,
			pb.request.id,
			decisionBody(chA),
			e.tick(),
		);
		expect(wholeA.status).toBe(409);
		expect(count(e.db, "SELECT count(*) AS n FROM managed_decisions")).toBe(
			before,
		);
		expect(
			count(
				e.db,
				"SELECT count(*) AS n FROM managed_tasks WHERE state != 'draft'",
			),
		).toBe(0);
	});

	test("an artifact of A's execution is not served through B's task (404); through A's it is", async () => {
		const e = env();
		const v = await e.ctx();
		const a = await approvedTask(e, v);
		await runEngine(e);
		const art = listArtifacts(e.db, a.managedTaskId)[0];
		expect(art).toBeDefined();
		const tb = createIn(e, v, REPO_B, "B looks at A's evidence");
		const cross = await e.services.reads.artifact(tb.task.id, art?.id ?? "");
		expect([cross.status, errorOf(cross)]).toEqual([404, "not_found"]);
		const res = await e.request(
			"GET",
			`/tasks/${tb.task.id}/artifacts/${art?.id}`,
			await e.login(),
		);
		expect(res.status).toBe(404);
		const own = await e.services.reads.artifact(a.taskId, art?.id ?? "");
		expect(own.status).toBe(200);
	});
});

describe("observed-only repositories are display data, never execution-eligible", () => {
	test("listed in the snapshot (allowlisted ids excluded case-insensitively); create → 422, nothing reserved", async () => {
		const e = env();
		const at = new Date().toISOString();
		e.db
			.query(
				"INSERT INTO repos (id, district, is_local_only, synced_at) VALUES (?, 'uncategorized', ?, ?)",
			)
			.run("observed-org/observed-only", 0, at);
		e.db
			.query(
				"INSERT INTO repos (id, district, is_local_only, synced_at) VALUES (?, 'uncategorized', ?, ?)",
			)
			.run("local/observed-checkout", 1, at);
		// a case variant of an allowlisted repository is NOT an observed-only repository
		e.db
			.query(
				"INSERT INTO repos (id, district, is_local_only, synced_at) VALUES (?, 'uncategorized', 0, ?)",
			)
			.run("LOCAL/Fixture-B", at);
		e.db.query("INSERT INTO machines (id) VALUES ('m-test')").run();
		e.db
			.query(
				"INSERT INTO sessions (id, provider, machine_id, repo_id, started_at, last_event_at) VALUES ('s1', 'claude', 'm-test', ?, ?, ?)",
			)
			.run("telemetry-org/only-in-sessions", at, at);
		const snap = snapshot(e);
		expect(snap.observed_repos).toEqual([
			{ repo_id: "local/observed-checkout", source: "local_checkout" },
			{ repo_id: "observed-org/observed-only", source: "github" },
			{ repo_id: "telemetry-org/only-in-sessions", source: "telemetry" },
		]);
		expect(snap.repos.map((r) => r.repo_id)).toEqual(["local/fixture", REPO_B]);
		const v = await e.ctx();
		const before = {
			tasks: count(e.db, "SELECT count(*) AS n FROM workspace_tasks"),
			managed: count(e.db, "SELECT count(*) AS n FROM managed_tasks"),
		};
		for (const repo of snap.observed_repos.map((r) => r.repo_id)) {
			const r = e.services.commands.createTask(
				v,
				{ idempotency_key: key("obs"), repo_id: repo, draft: draft() },
				e.tick(),
			);
			expect([repo, r.status, errorOf(r)]).toEqual([
				repo,
				422,
				"repo_not_allowed",
			]);
		}
		const http = await e.request("POST", "/tasks", await e.login(), {
			idempotency_key: key("obs-http"),
			repo_id: "observed-org/observed-only",
			draft: draft(),
		});
		expect(http.status).toBe(422);
		expect({
			tasks: count(e.db, "SELECT count(*) AS n FROM workspace_tasks"),
			managed: count(e.db, "SELECT count(*) AS n FROM managed_tasks"),
		}).toEqual(before);
	});
});

describe("one execution at a time across repositories", () => {
	test("A then B approved → queue shows A in the slot and B waiting; B is never claimed while A holds it", async () => {
		const e = env();
		const v = await e.ctx();
		const a = await approvedIn(e, v, "local/fixture", "A first");
		const b = await approvedIn(e, v, REPO_B, "B second");
		// nothing claimed yet: no execution holds the slot (a merely queued one never does); both wait
		// in claim order, A first
		let q = snapshot(e).execution_queue;
		expect(q.active).toBeNull();
		expect(q.queued).toEqual([
			expect.objectContaining({
				managed_task_id: a.managedTaskId,
				workspace_task_id: a.taskId,
				repo_id: "local/fixture",
				state: "queued",
			}),
			expect.objectContaining({
				managed_task_id: b.managedTaskId,
				workspace_task_id: b.taskId,
				repo_id: REPO_B,
				state: "queued",
			}),
		]);
		expect(q.claims_paused_by_quarantine).toBe(false);
		const until = new Date(Date.now() + 60_000).toISOString();
		const first = claimNext(e.db, "worker-1", until);
		expect(first?.id).toBe(a.managedTaskId);
		// a second worker (another process) gets nothing while A is leased
		expect(claimNext(e.db, "worker-2", until)).toBeNull();
		q = snapshot(e).execution_queue;
		expect(q.active?.managed_task_id).toBe(a.managedTaskId);
		expect(q.queued.map((x) => x.managed_task_id)).toEqual([b.managedTaskId]);
		expect(getTask(e.db, b.managedTaskId)?.lease_owner).toBeNull();
		// the snapshot list items carry each task's engine view
		const snap = snapshot(e);
		expect(
			snap.tasks.find((t) => t.task.id === b.taskId)?.engine,
		).toMatchObject({ managed_task_id: b.managedTaskId, state: "queued" });
	});

	test("an open quarantine pauses every claim (any repository) and is reported in the queue", async () => {
		const e = env();
		const v = await e.ctx();
		const a = await approvedIn(e, v, "local/fixture", "A quarantined");
		const b = await approvedIn(e, v, REPO_B, "B blocked by quarantine");
		openQuarantine(e.db, {
			task_id: a.managedTaskId,
			run_id: null,
			pid: 999_999,
			started: null,
			reason: "test: unconfirmed child",
			now: new Date().toISOString(),
		});
		const q = snapshot(e).execution_queue;
		expect(q.claims_paused_by_quarantine).toBe(true);
		expect(
			claimNext(e.db, "worker-1", new Date(Date.now() + 60_000).toISOString()),
		).toBeNull();
		expect(getTask(e.db, b.managedTaskId)?.state).toBe("queued");
		expect(getTask(e.db, b.managedTaskId)?.lease_owner).toBeNull();
	});

	test("cancelling B while it waits behind A cancels B only; A keeps the slot", async () => {
		const e = env();
		const v = await e.ctx();
		const a = await approvedIn(e, v, "local/fixture", "A keeps running");
		const b = await approvedIn(e, v, REPO_B, "B cancelled while waiting");
		const until = new Date(Date.now() + 60_000).toISOString();
		expect(claimNext(e.db, "worker-1", until)?.id).toBe(a.managedTaskId);
		const aBefore = getTask(e.db, a.managedTaskId);
		const bRow = e.store.getTask(b.taskId);
		const res = e.services.commands.cancel(
			v,
			b.taskId,
			{ expected_rev: bRow?.rev ?? 0 },
			e.tick(),
		);
		expect(res.status).toBe(200);
		expect(getTask(e.db, b.managedTaskId)?.state).toBe("cancelled");
		const aAfter = getTask(e.db, a.managedTaskId);
		expect({
			state: aAfter?.state,
			lease: aAfter?.lease_owner,
			fence: aAfter?.fence_token,
			cancel: aAfter?.cancel_requested_at,
		}).toEqual({
			state: aBefore?.state,
			lease: aBefore?.lease_owner,
			fence: aBefore?.fence_token,
			cancel: null,
		});
		expect(e.store.getTask(a.taskId)?.stage).toBe("queued");
		const q = snapshot(e).execution_queue;
		expect(q.active?.managed_task_id).toBe(a.managedTaskId);
		expect(q.queued).toEqual([]);
	});

	test("drained by one engine, the two repositories' executions never overlap; each result stays with its task", async () => {
		const e = env();
		const v = await e.ctx();
		const a = await approvedIn(e, v, "local/fixture", "A serial");
		const b = await approvedIn(e, v, REPO_B, "B serial");
		await runEngine(e);
		const runs = e.db
			.query<
				{ task_id: string; started_at: string; ended_at: string | null },
				[]
			>(
				"SELECT task_id, started_at, ended_at FROM managed_runs ORDER BY started_at",
			)
			.all();
		expect(runs.map((r) => r.task_id)).toEqual([
			a.managedTaskId,
			b.managedTaskId,
		]);
		expect((runs[0]?.ended_at ?? "") <= (runs[1]?.started_at ?? "")).toBe(true);
		for (const [ids, repo] of [
			[a, "local/fixture"],
			[b, REPO_B],
		] as const) {
			const mt = getTask(e.db, ids.managedTaskId);
			expect(mt?.state).toBe("human_ready");
			expect(mt?.repo_id).toBe(repo);
			for (const art of listArtifacts(e.db, ids.managedTaskId))
				expect(art.task_id).toBe(ids.managedTaskId);
		}
	});
});
