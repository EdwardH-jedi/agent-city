// Evidence for "one SQLite transaction": the managed store's own `db.transaction(fn).immediate()`
// nests as a SAVEPOINT inside the workspace BEGIN IMMEDIATE, and a failure anywhere — before,
// inside or after the nested managed write, or at COMMIT itself — leaves NO trace: no decision,
// managed task still `draft`, challenge columns and every rev unchanged.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { TaskSubmission } from "@agent-city/schema";
import { OPERATOR_ID } from "@agent-city/schema/workspace-m1";
import { sha256Hex } from "@agent-city/schema/workspace-m1/hash";
import {
	createTask as createManagedTask,
	getTask,
	requestRun,
} from "../../managed/store.ts";
import {
	BASE_SHA,
	clock,
	count,
	createTask,
	type DecideOutcome,
	decideRun,
	dumpAll,
	FIXTURE_REPO,
	type InjectionPoint,
	issueChallenge,
	openWorkspace,
	publishProposal,
	removeDir,
	tempDir,
	type Workspace,
} from "./testkit.ts";

let dir: string;
let ws: Workspace;
let now: () => string;

beforeEach(() => {
	dir = tempDir();
	ws = openWorkspace(join(dir, "hub.db"));
	now = clock();
});
afterEach(() => {
	ws.db.close();
	removeDir(dir);
});

const legacySubmission = (key: string) =>
	TaskSubmission.parse({
		idempotency_key: key,
		repo_id: FIXTURE_REPO,
		title: "nesting probe",
		objective: "nesting probe",
		acceptance_criteria: ["x"],
		approved_scope: ["src"],
		execution_mode: "simulated",
	});

describe("nesting: managed store transactions join the workspace transaction", () => {
	test("createTask inside store.transaction runs as a SAVEPOINT and rolls back with the outer throw", () => {
		const seen: boolean[] = [];
		let id = "";
		expect(() =>
			ws.store.transaction(() => {
				seen.push(ws.db.inTransaction);
				// control: a real BEGIN here is impossible — so the managed tx() below cannot be one
				expect(() => ws.db.run("BEGIN IMMEDIATE")).toThrow(
					/within a transaction/,
				);
				id = createManagedTask(ws.db, {
					submission: legacySubmission("nesting-probe-0001"),
					request_hash: sha256Hex("probe"),
					base_ref: "main",
					base_sha: BASE_SHA,
					now: now(),
				}).task.id;
				seen.push(ws.db.inTransaction);
				expect(getTask(ws.db, id)?.state).toBe("draft"); // visible inside
				throw new Error("outer failure after the nested managed write");
			}),
		).toThrow("outer failure");
		expect(seen).toEqual([true, true]);
		expect(ws.db.inTransaction).toBe(false);
		expect(getTask(ws.db, id)).toBeNull();
	});

	test("an inner managed failure rolls back only to its savepoint; the outer transaction continues", () => {
		const t = now();
		const id = createManagedTask(ws.db, {
			submission: legacySubmission("nesting-probe-0002"),
			request_hash: sha256Hex("probe2"),
			base_ref: "main",
			base_sha: BASE_SHA,
			now: t,
		}).task.id;
		const workspaceTask = createTask(ws.store, now());
		ws.db.run(
			"CREATE TEMP TRIGGER inject_inner BEFORE UPDATE OF state ON managed_tasks WHEN NEW.state = 'queued' BEGIN SELECT RAISE(ABORT, 'injected inside requestRun'); END",
		);
		ws.store.transaction((tx) => {
			expect(() => requestRun(ws.db, id, sha256Hex("a"), now())).toThrow(
				"injected inside requestRun",
			);
			expect(ws.db.inTransaction).toBe(true); // savepoint released, outer still open
			const cur = tx.getTask(workspaceTask.id);
			if (!cur) throw new Error("unreachable");
			tx.updateTask(cur.id, cur.rev, { stage_detail: "outer kept" }, now());
		});
		ws.db.run("DROP TRIGGER temp.inject_inner");
		expect(getTask(ws.db, id)?.state).toBe("draft");
		expect(ws.store.getTask(workspaceTask.id)?.stage_detail).toBe("outer kept");
	});
});

type Injection = {
	name: string;
	point?: InjectionPoint;
	enqueueHook?: "before_request_run" | "after_request_run";
	setup?: () => void;
	teardown?: () => void;
	action?: "approve" | "request_changes";
	error: RegExp;
};

const INJECTIONS: Injection[] = [
	{
		name: "after challenge consumption",
		point: "after_consume",
		error: /injected/,
	},
	{
		name: "after insertDecision, before any effect",
		point: "after_insert_decision",
		error: /injected/,
	},
	{
		name: "inside the enqueue step, before requestRun",
		enqueueHook: "before_request_run",
		error: /injected/,
	},
	{
		name: "inside the enqueue step, AFTER requestRun returned (savepoint already released)",
		enqueueHook: "after_request_run",
		error: /injected/,
	},
	{
		name: "inside requestRun's own savepoint (the queue UPDATE aborts)",
		setup: () =>
			ws.db.run(
				"CREATE TEMP TRIGGER inject_queue BEFORE UPDATE OF state ON managed_tasks WHEN NEW.state = 'queued' BEGIN SELECT RAISE(ABORT, 'injected inside requestRun'); END",
			),
		teardown: () => ws.db.run("DROP TRIGGER temp.inject_queue"),
		error: /injected inside requestRun/,
	},
	{
		name: "after every effect, before COMMIT",
		point: "after_effects",
		error: /injected/,
	},
	{
		name: "at COMMIT (deferred FK violation makes COMMIT itself fail)",
		point: "after_effects",
		setup: () => {},
		error: /FOREIGN KEY/,
	},
	{
		name: "request_changes: after releaseReserved cancelled the managed task",
		point: "after_effects",
		action: "request_changes",
		error: /injected/,
	},
];

describe("failure injection around the decision transaction", () => {
	for (const inj of INJECTIONS)
		test(`${inj.name} → no decision, managed task draft, challenge + revs unchanged`, () => {
			const task = createTask(ws.store, now());
			const pub = publishProposal(ws, task.id, now());
			const ch = issueChallenge(ws, pub.request.id, now());
			const before = dumpAll(ws.db);
			const m0 = getTask(ws.db, pub.managed_task_id);
			const t0 = ws.store.getTask(task.id);
			if (!m0 || !t0) throw new Error("unreachable");
			const commitFailure = /FOREIGN KEY/.test(inj.error.source);
			const action = inj.action ?? "approve";
			const decide = (inject?: (p: InjectionPoint) => void): DecideOutcome =>
				decideRun(ws, {
					request_id: pub.request.id,
					binding_hash: pub.request.binding_hash,
					action,
					key: "decide-inject-0001",
					expected_request_rev: ch.rev,
					now: now(),
					inject,
				});

			// managed state observed INSIDE the transaction right before the injected failure
			let observed: string | undefined;
			const observe = () => {
				observed = getTask(ws.db, pub.managed_task_id)?.state;
			};
			inj.setup?.();
			if (inj.enqueueHook)
				ws.deps.hooks = {
					enqueue: (point) => {
						if (point !== inj.enqueueHook) return;
						observe();
						throw new Error("injected");
					},
				};
			expect(() =>
				decide((p) => {
					if (p !== inj.point) return;
					observe();
					if (commitFailure) {
						ws.db.run("PRAGMA defer_foreign_keys = ON");
						ws.db.run(
							"INSERT INTO managed_quarantine (id, task_id, pid, reason, created_at) VALUES ('qua-inject', 'task-00000000-0000-4000-8000-000000000000', 1, 'inject', ?)",
							[now()],
						);
						return; // the callback returns normally; COMMIT is what fails
					}
					throw new Error("injected");
				}),
			).toThrow(inj.error);
			ws.deps.hooks = undefined;
			inj.teardown?.();

			// the nested managed write had really happened before the failure (not a vacuous test)
			if (
				inj.enqueueHook === "after_request_run" ||
				inj.point === "after_effects"
			)
				expect(observed).toBe(action === "approve" ? "queued" : "cancelled");
			if (
				inj.point === "after_insert_decision" ||
				inj.point === "after_consume"
			)
				expect(observed).toBe("draft");

			expect(ws.db.inTransaction).toBe(false);
			expect(dumpAll(ws.db)).toBe(before); // byte-identical: nothing at all persisted
			expect(count(ws.db, "SELECT count(*) AS n FROM managed_decisions")).toBe(
				0,
			);
			expect(
				ws.store.findReceipt(OPERATOR_ID, "decide-inject-0001"),
			).toBeNull();
			const m1 = getTask(ws.db, pub.managed_task_id);
			expect(m1?.state).toBe("draft");
			expect(m1?.fence_token).toBe(m0.fence_token);
			expect(m1?.rev).toBe(m0.rev);
			expect(m1?.approval_hash).toBeNull();
			const r1 = ws.store.getApprovalRequest(pub.request.id);
			expect(r1?.status).toBe("pending");
			expect(r1?.rev).toBe(ch.rev);
			expect(r1?.challenge_status).toBe("issued");
			expect(r1?.challenge_hash).toBe(ch.challenge_hash);
			expect(r1?.challenge_request_rev).toBe(ch.challenge_request_rev);
			const t1 = ws.store.getTask(task.id);
			expect(t1?.stage).toBe("awaiting_run_approval");
			expect(t1?.rev).toBe(t0.rev);

			// R-A2: the failed attempt consumed nothing — the same decision now succeeds, exactly once
			const ok = decide();
			expect(ok.kind).toBe("decided");
			expect(count(ws.db, "SELECT count(*) AS n FROM managed_decisions")).toBe(
				1,
			);
			const m2 = getTask(ws.db, pub.managed_task_id);
			expect(m2?.state).toBe(action === "approve" ? "queued" : "cancelled");
			expect(m2?.fence_token).toBe(m0.fence_token + 1);
			expect(
				ws.store.getApprovalRequest(pub.request.id)?.challenge_status,
			).toBe("consumed");
			// and a duplicate delivery replays without a second effect
			const again = decide();
			expect(again.kind).toBe("replayed");
			expect(getTask(ws.db, pub.managed_task_id)?.fence_token).toBe(
				m0.fence_token + 1,
			);
		});
});
