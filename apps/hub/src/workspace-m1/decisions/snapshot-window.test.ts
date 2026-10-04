// P2 F-01 (docs/workspace-m1/CORRECTIVE_P2_2026-10-04.md): the snapshot's task list is a bounded window
// (500), so a repository's absence from it never proves the repository has no tasks. The window always
// holds every task the emitted inbox (`pending_requests`) and execution queue name, and `repo_task_counts`
// carries complete per-repository totals. Three allowlisted repositories: A (the primary `local/fixture`),
// B (`local/fixture-b`) and C (`local/fixture-c`, never given a task).
import { afterEach, describe, expect, test } from "bun:test";
import type {
	VerifiedAuthContext,
	WorkspaceSnapshot,
} from "@agent-city/schema/workspace-m1";
import {
	challenge,
	decisionBody,
	draft,
	type Env,
	expectOk,
	key,
	makeEnv,
	publish,
} from "./test-support.ts";

const A = "local/fixture";
const B = "local/fixture-b";
const C = "local/fixture-c";
const WINDOW = 500;
const SLOW = 120_000; // hundreds of real service-level creates

const envs: Env[] = [];
afterEach(() => {
	for (const e of envs.splice(0)) e.fx.cleanup();
});
const env = () => {
	const e = makeEnv({
		fixture: {
			extraRepos: [
				{ id: B, label: "b" },
				{ id: C, label: "c" },
			],
		},
	});
	envs.push(e);
	return e;
};

function createIn(e: Env, v: VerifiedAuthContext, repo: string, title: string) {
	return expectOk(
		e.services.commands.createTask(
			v,
			{
				idempotency_key: key("create"),
				repo_id: repo,
				draft: draft({ title }),
			},
			e.tick(10),
		),
		`create in ${repo}`,
	).task.id;
}

/** A task in `repo` with a pending Gate-1 request. */
async function pendingIn(e: Env, v: VerifiedAuthContext, repo: string) {
	const taskId = createIn(e, v, repo, `pending in ${repo}`);
	const { request } = await publish(e, v, taskId);
	return { taskId, requestId: request.id };
}

function newerDrafts(e: Env, v: VerifiedAuthContext, repo: string, n: number) {
	const ids: string[] = [];
	for (let i = 0; i < n; i++) ids.push(createIn(e, v, repo, `${repo} #${i}`));
	return ids;
}

const snapshot = (e: Env): WorkspaceSnapshot =>
	expectOk(e.services.reads.snapshot(e.now()), "snapshot");

const ids = (s: WorkspaceSnapshot) => s.tasks.map((t) => t.task.id);
const countOf = (s: WorkspaceSnapshot, repo: string) =>
	s.repo_task_counts.find((c) => c.repo_id === repo);

/** Every request in the inbox resolves to a task (and so a repository) of the same snapshot. */
function inboxResolves(s: WorkspaceSnapshot): void {
	const listed = new Set(ids(s));
	for (const r of s.pending_requests)
		expect(listed.has(r.workspace_task_id)).toBe(true);
}

function newestFirst(s: WorkspaceSnapshot): void {
	for (let i = 1; i < s.tasks.length; i++)
		expect(
			(s.tasks[i - 1]?.task.updated_at ?? "") >=
				(s.tasks[i]?.task.updated_at ?? ""),
		).toBe(true);
}

describe("P2 F-01 — a bounded task window never hides a repository's pending work", () => {
	test(
		"one pending A task, then 500 newer B drafts: A stays in the snapshot, attributable, with complete counts",
		async () => {
			const e = env();
			const v = await e.ctx();
			const a = await pendingIn(e, v, A);
			const b = newerDrafts(e, v, B, WINDOW);
			const s = snapshot(e);

			expect(s.tasks.length).toBe(WINDOW);
			const aRow = s.tasks.find((t) => t.task.id === a.taskId);
			expect(aRow?.task.repo_id).toBe(A);
			expect(aRow?.phase).toBe("awaiting_run_approval");
			expect(s.pending_requests.map((r) => r.id)).toEqual([a.requestId]);
			inboxResolves(s);
			// the oldest B draft made room for the pinned A task (newest first otherwise)
			expect(ids(s)).not.toContain(b[0]);
			expect(ids(s)).toContain(b[WINDOW - 1] ?? "missing");
			newestFirst(s);
			// complete totals, independent of the window
			expect(countOf(s, A)).toEqual({ repo_id: A, tasks: 1 });
			expect(countOf(s, B)).toEqual({ repo_id: B, tasks: WINDOW });
		},
		SLOW,
	);

	test(
		"exact boundary: 499 newer drafts keep every task; the 500th newer draft drops only the oldest draft",
		async () => {
			const e = env();
			const v = await e.ctx();
			const a = await pendingIn(e, v, A);
			const b = newerDrafts(e, v, B, WINDOW - 1);
			let s = snapshot(e);
			expect(s.tasks.length).toBe(WINDOW);
			expect(new Set(ids(s))).toEqual(new Set([a.taskId, ...b]));
			expect(countOf(s, B)?.tasks).toBe(WINDOW - 1);

			const last = newerDrafts(e, v, B, 1)[0];
			s = snapshot(e);
			expect(s.tasks.length).toBe(WINDOW);
			expect(ids(s)).toContain(a.taskId);
			expect(ids(s)).toContain(last ?? "missing");
			expect(ids(s)).not.toContain(b[0]);
			expect(countOf(s, B)?.tasks).toBe(WINDOW);
			expect(countOf(s, A)).toEqual({ repo_id: A, tasks: 1 });
			inboxResolves(s);
		},
		SLOW,
	);

	test(
		"several repositories: pending work in A and B survives 500 newer C drafts; each keeps its own repository",
		async () => {
			const e = env();
			const v = await e.ctx();
			const a = await pendingIn(e, v, A);
			const b = await pendingIn(e, v, B);
			newerDrafts(e, v, C, WINDOW);
			const s = snapshot(e);
			expect(s.tasks.length).toBe(WINDOW);
			inboxResolves(s);
			expect(s.tasks.find((t) => t.task.id === a.taskId)?.task.repo_id).toBe(A);
			expect(s.tasks.find((t) => t.task.id === b.taskId)?.task.repo_id).toBe(B);
			// repository filtering over the window still yields each repository's own tasks only
			expect(
				s.tasks.filter((t) => t.task.repo_id === A).map((t) => t.task.id),
			).toEqual([a.taskId]);
			expect(
				s.tasks.filter((t) => t.task.repo_id === B).map((t) => t.task.id),
			).toEqual([b.taskId]);
			expect(s.repo_task_counts).toEqual([
				{ repo_id: A, tasks: 1 },
				{ repo_id: B, tasks: 1 },
				{ repo_id: C, tasks: WINDOW },
			]);
		},
		SLOW,
	);

	test(
		"an approved, queued A execution stays in the window behind 500 newer B drafts",
		async () => {
			const e = env();
			const v = await e.ctx();
			const a = await pendingIn(e, v, A);
			const ch = challenge(e, v, a.requestId);
			expectOk(
				await e.services.decisions.decide(
					v,
					a.requestId,
					decisionBody(ch),
					e.tick(10),
				),
				"approve A",
			);
			newerDrafts(e, v, B, WINDOW);
			const s = snapshot(e);
			const queued = [s.execution_queue.active, ...s.execution_queue.queued];
			expect(queued.some((q) => q?.workspace_task_id === a.taskId)).toBe(true);
			expect(ids(s)).toContain(a.taskId);
			expect(s.tasks.length).toBe(WINDOW);
			expect(countOf(s, A)).toEqual({ repo_id: A, tasks: 1 });
		},
		SLOW,
	);

	test("a genuinely empty repository is counted 0; every allowlisted repository has exactly one entry", async () => {
		const e = env();
		const v = await e.ctx();
		createIn(e, v, A, "only A");
		const s = snapshot(e);
		expect(s.repo_task_counts.map((c) => c.repo_id)).toEqual(
			e.config.repos.map((r) => r.id),
		);
		expect(countOf(s, C)).toEqual({ repo_id: C, tasks: 0 });
		expect(s.tasks.some((t) => t.task.repo_id === C)).toBe(false);
	});
});
