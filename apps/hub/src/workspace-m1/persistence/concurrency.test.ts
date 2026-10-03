// Concurrent decisions on one database file through SEPARATE Database handles (busy_timeout 5 s
// from openDb). Real races use Workers released together by a SharedArrayBuffer gate; the stale-read
// race and the lock test run on two handles in this thread.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDb } from "../../db.ts";
import { getTask } from "../../managed/store.ts";
import type { WorkerJob, WorkerReply } from "./concurrency-worker.ts";
import {
	clock,
	count,
	createTask,
	decideRun,
	issueChallenge,
	openDb007,
	openWorkspace,
	publishProposal,
	removeDir,
	taskRow,
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

const WORKER_URL = new URL("./concurrency-worker.ts", import.meta.url).href;

/**
 * Start the workers ONE AT A TIME (each opens its own handle and reports ready before the next is
 * created; simultaneous opens of one file were a source of "database is locked" failures), then
 * release them together through the gate. Every worker settles before any is
 * terminated, so no thread is killed while it holds SQLite locks.
 */
async function race(
	jobs: ((gate: SharedArrayBuffer) => WorkerJob)[],
): Promise<string[]> {
	const gate = new SharedArrayBuffer(4);
	const release = () => {
		const g = new Int32Array(gate);
		Atomics.store(g, 0, 1);
		Atomics.notify(g, 0);
	};
	const workers: Worker[] = [];
	const done: Promise<string>[] = [];
	try {
		for (const job of jobs) {
			const w = new Worker(WORKER_URL);
			workers.push(w);
			let markReady: () => void = () => {};
			const ready = new Promise<void>((r) => {
				markReady = r;
			});
			const finished = new Promise<string>((resolve, reject) => {
				w.onmessage = (ev: MessageEvent<WorkerReply>) => {
					const m = ev.data;
					if (m.type === "ready") markReady();
					else if (m.type === "done") resolve(m.outcome);
					else reject(new Error(m.message));
				};
				w.onerror = (e) => reject(new Error(String(e.message)));
			});
			finished.catch(() => {}); // observed below via allSettled
			done.push(finished);
			w.postMessage(job(gate));
			await Promise.race([ready, finished]);
		}
		release();
		const settled = await Promise.allSettled(done);
		const failed = settled.find((r) => r.status === "rejected");
		if (failed) throw (failed as PromiseRejectedResult).reason;
		return settled
			.map((r) => (r as PromiseFulfilledResult<string>).value)
			.sort();
	} finally {
		release(); // never leave a ready worker blocked on the gate
		if (done.length > 0) await Promise.allSettled(done);
		for (const w of workers) w.terminate();
	}
}

function pendingGate1(ws: Workspace) {
	const task = createTask(ws.store, now());
	const pub = publishProposal(ws, task.id, now());
	const ch = issueChallenge(ws, pub.request.id, now());
	return { task, pub, ch };
}

describe("concurrent decisions", () => {
	test("two clients (different keys) race one Gate 1: exactly one wins, exactly one queue linkage", async () => {
		for (let round = 0; round < 4; round++) {
			const ws = openWorkspace(path);
			const { pub, ch } = pendingGate1(ws);
			const fence0 = getTask(ws.db, pub.managed_task_id)?.fence_token ?? -1;
			ws.db.close();
			const t = now();
			const outcomes = await race(
				["client-a-key-0001", "client-b-key-0002"].map(
					(key) =>
						(gate): WorkerJob => ({
							mode: "decide",
							path,
							gate,
							request_id: pub.request.id,
							binding_hash: pub.request.binding_hash,
							expected_request_rev: ch.rev,
							key: `${key}-${round}`,
							now: t,
						}),
				),
			);
			expect(outcomes).toEqual(["decided", "stale"]);
			const check = openWorkspace(path);
			expect(
				count(
					check.db,
					"SELECT count(*) AS n FROM managed_decisions WHERE approval_request_id = ?",
					pub.request.id,
				),
			).toBe(1);
			const m = getTask(check.db, pub.managed_task_id);
			expect(m?.state).toBe("queued");
			expect(m?.fence_token).toBe(fence0 + 1); // requestRun ran exactly once
			expect(
				count(
					check.db,
					"SELECT count(*) AS n FROM managed_tasks WHERE state = 'queued' AND id = ?",
					pub.managed_task_id,
				),
			).toBe(1);
			check.db.close();
		}
	}, 30_000);

	test("duplicate delivery (same key, same payload) racing: one decided, one replayed, one effect", async () => {
		const ws = openWorkspace(path);
		const { pub, ch } = pendingGate1(ws);
		const fence0 = getTask(ws.db, pub.managed_task_id)?.fence_token ?? -1;
		ws.db.close();
		const t = now();
		const job = (gate: SharedArrayBuffer): WorkerJob => ({
			mode: "decide",
			path,
			gate,
			request_id: pub.request.id,
			binding_hash: pub.request.binding_hash,
			expected_request_rev: ch.rev,
			key: "dup-delivery-key-01",
			now: t,
		});
		expect(await race([job, job])).toEqual(["decided", "replayed"]);
		const check = openWorkspace(path);
		expect(count(check.db, "SELECT count(*) AS n FROM managed_decisions")).toBe(
			1,
		);
		expect(getTask(check.db, pub.managed_task_id)?.fence_token).toBe(
			fence0 + 1,
		);
		check.db.close();
	}, 30_000);

	test("four handles racing ensureWorkspaceSchema on a 007 file apply 008 + 009 + 010 exactly once", async () => {
		openDb007(path).close(); // a genuine 007 file (openDb would apply 008–010 itself)
		const outcomes = await race(
			[1, 2, 3, 4].map(
				() =>
					(gate): WorkerJob => ({ mode: "migrate", path, gate }),
			),
		);
		expect(outcomes).toEqual(["applied", "noop", "noop", "noop"]);
		const db = openDb(path);
		expect(
			db
				.query<{ v: number }, []>(
					"SELECT user_version AS v FROM pragma_user_version",
				)
				.get()?.v,
		).toBe(10);
		db.close();
	}, 30_000);

	test("stale read on a second handle: B decided on what it read before A committed → CAS refuses B", () => {
		const a = openWorkspace(path);
		const b = openWorkspace(path);
		const { pub, ch } = pendingGate1(a);
		const seenByB = b.store.getApprovalRequest(pub.request.id);
		expect(seenByB?.status).toBe("pending");
		const first = decideRun(a, {
			request_id: pub.request.id,
			binding_hash: pub.request.binding_hash,
			action: "approve",
			key: "handle-a-key-0001",
			expected_request_rev: ch.rev,
			now: now(),
		});
		const second = decideRun(b, {
			request_id: pub.request.id,
			binding_hash: pub.request.binding_hash,
			action: "approve",
			key: "handle-b-key-0001",
			expected_request_rev: seenByB?.rev ?? -1,
			now: now(),
		});
		expect(first.kind).toBe("decided");
		expect(second.kind).toBe("stale");
		expect(count(a.db, "SELECT count(*) AS n FROM managed_decisions")).toBe(1);
		a.db.close();
		b.db.close();
	});

	test("BEGIN IMMEDIATE takes the write lock up front: a second handle cannot even start", () => {
		const a = openWorkspace(path);
		const b = openWorkspace(path);
		b.db.run("PRAGMA busy_timeout = 50");
		const task = createTask(a.store, now());
		let bError = "";
		a.store.transaction((tx) => {
			const cur = tx.getTask(task.id);
			if (!cur) throw new Error("unreachable");
			tx.updateTask(
				cur.id,
				cur.rev,
				{ stage_detail: "A holds the lock" },
				now(),
			);
			try {
				b.store.transaction((btx) => {
					btx.insertTask(taskRow(now()));
				});
			} catch (err) {
				bError = err instanceof Error ? err.message : String(err);
			}
		});
		expect(bError).toMatch(/locked|busy/i);
		expect(a.store.getTask(task.id)?.stage_detail).toBe("A holds the lock");
		expect(count(a.db, "SELECT count(*) AS n FROM workspace_tasks")).toBe(1);
		a.db.close();
		b.db.close();
	});
});
