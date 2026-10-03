// Restart behaviour: receipts survive (lost-response recovery after reopen), opening a database
// writes nothing and resumes nothing, a crash inside the decision transaction leaves no trace, a
// crash right after COMMIT leaves exactly one durable effect, and invalidated history is retained.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OPERATOR_ID } from "@agent-city/schema/workspace-m1";
import { getTask } from "../../managed/store.ts";
import {
	clock,
	count,
	createTask,
	decideRun,
	draftFixture,
	dumpAll,
	issueChallenge,
	openWorkspace,
	publishProposal,
	removeDir,
	tempDir,
	type Workspace,
} from "./testkit.ts";

let dir: string;
let path: string;
let now: () => string;

beforeEach(() => {
	dir = tempDir();
	path = join(dir, "hub.db");
	now = clock();
});
afterEach(() => removeDir(dir));

function pendingGate1(ws: Workspace) {
	const task = createTask(ws.store, now());
	const pub = publishProposal(ws, task.id, now());
	const ch = issueChallenge(ws, pub.request.id, now());
	return { task, pub, ch };
}

const CHILD = join(import.meta.dir, "crash-child.ts");

function runChild(job: object): number {
	const r = Bun.spawnSync(
		[process.execPath, "--no-env-file", CHILD, path, JSON.stringify(job)],
		{
			stdout: "pipe",
			stderr: "pipe",
			timeout: 20_000,
		},
	);
	return r.exitCode ?? -1;
}

describe("restart", () => {
	test("lost response: the receipt is readable after commit + reopen and replays without effects", () => {
		const ws = openWorkspace(path);
		const { pub, ch } = pendingGate1(ws);
		const input = {
			request_id: pub.request.id,
			binding_hash: pub.request.binding_hash,
			action: "approve" as const,
			key: "lost-response-key-1",
			expected_request_rev: ch.rev,
			now: now(),
		};
		const first = decideRun(ws, input);
		if (first.kind !== "decided") throw new Error(first.kind);
		ws.db.close(); // the response never reached the client; the hub restarts

		const back = openWorkspace(path);
		const stored = back.store.findReceipt(OPERATOR_ID, input.key);
		expect(stored?.response_body).toEqual(first.receipt);
		expect(stored?.response_status).toBe(201);
		const before = dumpAll(back.db);
		// byte-identical retry after the challenge was consumed → stored receipt, no effects
		const replay = decideRun(back, input);
		expect(replay).toEqual({ kind: "replayed", receipt: first.receipt });
		// same key, different payload → conflict, nothing overwritten
		const changed = decideRun(back, {
			...input,
			action: "reject",
		});
		expect(changed).toEqual({ kind: "conflict" });
		expect(dumpAll(back.db)).toBe(before);
		expect(getTask(back.db, pub.managed_task_id)?.state).toBe("queued");
		back.db.close();
	});

	test("reopening writes nothing and resumes nothing (queued stays queued, pending stays pending)", () => {
		const ws = openWorkspace(path);
		const a = pendingGate1(ws);
		decideRun(ws, {
			request_id: a.pub.request.id,
			binding_hash: a.pub.request.binding_hash,
			action: "approve",
			key: "restart-approve-01",
			expected_request_rev: a.ch.rev,
			now: now(),
		});
		const b = pendingGate1(ws); // Gate 1 pending with an outstanding challenge
		const c = createTask(ws.store, now()); // plain draft
		const before = dumpAll(ws.db);
		ws.db.close();

		for (let i = 0; i < 2; i++) {
			const back = openWorkspace(path);
			expect(dumpAll(back.db)).toBe(before);
			const queued = getTask(back.db, a.pub.managed_task_id);
			expect(queued?.state).toBe("queued");
			expect(queued?.lease_owner).toBeNull(); // nothing claimed it
			const pending = back.store.getApprovalRequest(b.pub.request.id);
			expect(pending?.status).toBe("pending");
			// challenge fields are retained; the new boot id voids them at verification (03)
			expect(pending?.challenge_status).toBe("issued");
			expect(getTask(back.db, b.pub.managed_task_id)?.state).toBe("draft");
			expect(back.store.getTask(c.id)?.stage).toBe("draft");
			back.db.close();
		}
	});

	test("crash inside the decision transaction (after the nested requestRun): nothing persisted, retry works once", () => {
		const ws = openWorkspace(path);
		const { pub, ch } = pendingGate1(ws);
		const before = dumpAll(ws.db);
		const fence0 = getTask(ws.db, pub.managed_task_id)?.fence_token ?? -1;
		ws.db.close();
		const job = {
			request_id: pub.request.id,
			binding_hash: pub.request.binding_hash,
			expected_request_rev: ch.rev,
			key: "crash-inside-key-01",
			now: now(),
		};
		expect(runChild({ ...job, mode: "exit_inside_tx" })).toBe(17);

		const back = openWorkspace(path);
		expect(dumpAll(back.db)).toBe(before);
		expect(back.store.findReceipt(OPERATOR_ID, job.key)).toBeNull();
		expect(getTask(back.db, pub.managed_task_id)?.state).toBe("draft");
		const retry = decideRun(back, { ...job, action: "approve" });
		expect(retry.kind).toBe("decided");
		expect(getTask(back.db, pub.managed_task_id)?.fence_token).toBe(fence0 + 1);
		back.db.close();
	}, 30_000);

	test("crash right after COMMIT (response lost): exactly one durable effect; the retry replays", () => {
		const ws = openWorkspace(path);
		const { pub, ch } = pendingGate1(ws);
		const fence0 = getTask(ws.db, pub.managed_task_id)?.fence_token ?? -1;
		ws.db.close();
		const job = {
			request_id: pub.request.id,
			binding_hash: pub.request.binding_hash,
			expected_request_rev: ch.rev,
			key: "crash-after-key-01",
			now: now(),
		};
		expect(runChild({ ...job, mode: "exit_after_commit" })).toBe(18);

		const back = openWorkspace(path);
		const stored = back.store.findReceipt(OPERATOR_ID, job.key);
		expect(stored).not.toBeNull();
		expect(count(back.db, "SELECT count(*) AS n FROM managed_decisions")).toBe(
			1,
		);
		const m = getTask(back.db, pub.managed_task_id);
		expect(m?.state).toBe("queued");
		expect(m?.fence_token).toBe(fence0 + 1);
		const before = dumpAll(back.db);
		const retry = decideRun(back, { ...job, action: "approve" });
		expect(retry).toEqual({
			kind: "replayed",
			receipt: stored?.response_body as never,
		});
		expect(dumpAll(back.db)).toBe(before);
		back.db.close();
	}, 30_000);

	test("invalidated approvals and superseded proposals are retained as history across restart", () => {
		const ws = openWorkspace(path);
		const task = createTask(ws.store, now());
		const v1 = publishProposal(ws, task.id, now());
		ws.store.transaction((tx) => {
			const t = tx.getTask(task.id);
			if (!t) throw new Error("unreachable");
			tx.updateTask(
				task.id,
				t.rev,
				{ draft: draftFixture("Second version") },
				now(),
			);
		});
		const v2 = publishProposal(ws, task.id, now());
		ws.db.close();

		const back = openWorkspace(path);
		const proposals = back.store.listProposals(task.id);
		expect(
			proposals.map((p) => [p.version, p.predecessor_proposal_id]),
		).toEqual([
			[1, null],
			[2, v1.proposal_id],
		]);
		const requests = back.store.listApprovalRequests({
			workspace_task_id: task.id,
		});
		expect(
			requests.map((r) => [r.id, r.status, r.invalidation_reason]),
		).toEqual([
			[v2.request.id, "pending", null],
			[v1.request.id, "invalidated", "proposal_superseded"],
		]);
		expect(requests[1]?.closed_at).not.toBeNull();
		expect(getTask(back.db, v1.managed_task_id)?.state).toBe("cancelled");
		expect(getTask(back.db, v2.managed_task_id)?.state).toBe("draft");
		expect(back.store.getTask(task.id)?.current_proposal_id).toBe(
			v2.proposal_id,
		);
		expect(back.store.findTaskByManagedTask(v2.managed_task_id)?.id).toBe(
			task.id,
		);
		expect(back.store.findTaskByManagedTask(v1.managed_task_id)).toBeNull();
		expect(
			back.store.findRunRequestForManagedTask(v1.managed_task_id)?.status,
		).toBe("invalidated");
		back.db.close();
	});
});
