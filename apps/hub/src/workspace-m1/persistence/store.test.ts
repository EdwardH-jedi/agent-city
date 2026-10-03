import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OPERATOR_ID } from "@agent-city/schema/workspace-m1";
import {
	canonicalEncode,
	newWorkspaceId,
	sealAnyProposal,
	sealRunApprovalBinding,
	sha256Hex,
} from "@agent-city/schema/workspace-m1/hash";
import { getTask as getManagedTask } from "../../managed/store.ts";
import {
	WorkspaceConflictError,
	WorkspaceIntegrityError,
	WorkspaceRowError,
	WorkspaceTxError,
} from "./errors.ts";
import {
	approvedExecution,
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
	resultRequestRow,
	seedRun,
	taskRow,
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

const conflictOf = (fn: () => unknown) => {
	try {
		fn();
	} catch (err) {
		if (err instanceof WorkspaceConflictError) return err.constraint;
		throw err;
	}
	throw new Error("expected a WorkspaceConflictError");
};

describe("workspace_tasks", () => {
	test("insert + read round-trips the DTO; the draft is stored as canonical JSON", () => {
		const row = createTask(ws.store, now());
		expect(ws.store.getTask(row.id)).toEqual(row);
		const raw = ws.db
			.query<{ draft: string }, [string]>(
				"SELECT draft FROM workspace_tasks WHERE id = ?",
			)
			.get(row.id);
		expect(raw?.draft).toBe(canonicalEncode(row.draft));
		expect(ws.store.getTask(newWorkspaceId("wst"))).toBeNull();
	});

	test("create-command idempotency: duplicate (created_by, key) is a typed conflict and never overwrites", () => {
		const first = createTask(ws.store, now(), { key: "create-key-0001" });
		const before = dumpAll(ws.db);
		const other = taskRow(now(), {
			key: "create-key-0001",
			draft: draftFixture("A different title"),
		});
		expect(
			conflictOf(() => ws.store.transaction((tx) => tx.insertTask(other))),
		).toBe("workspace_task_idempotency");
		expect(dumpAll(ws.db)).toBe(before);
		expect(
			ws.store.findTaskByIdempotencyKey(OPERATOR_ID, "create-key-0001"),
		).toEqual(first);
	});

	test("insert refuses a request_hash that is not H({repo_id, draft})", () => {
		const row = { ...taskRow(now()), request_hash: sha256Hex("other") };
		expect(() => ws.store.transaction((tx) => tx.insertTask(row))).toThrow(
			WorkspaceRowError,
		);
		expect(count(ws.db, "SELECT count(*) AS n FROM workspace_tasks")).toBe(0);
	});

	test("insert refuses rows that violate rows.ts (strict DTO) — nothing written", () => {
		const bad = { ...taskRow(now()), stage: "queued" as const };
		expect(() => ws.store.transaction((tx) => tx.insertTask(bad))).toThrow(
			WorkspaceRowError,
		);
		const extra = { ...taskRow(now()), provider: "live" } as never;
		expect(() => ws.store.transaction((tx) => tx.insertTask(extra))).toThrow(
			WorkspaceRowError,
		);
		expect(count(ws.db, "SELECT count(*) AS n FROM workspace_tasks")).toBe(0);
	});

	test("updateTask is CAS on rev: a miss returns null and changes nothing; a hit bumps rev + updated_at", () => {
		const row = createTask(ws.store, now());
		const t = now();
		const miss = ws.store.transaction((tx) =>
			tx.updateTask(row.id, row.rev + 1, { stage_detail: "x" }, t),
		);
		expect(miss).toBeNull();
		expect(ws.store.getTask(row.id)).toEqual(row);
		const unknown = ws.store.transaction((tx) =>
			tx.updateTask(newWorkspaceId("wst"), 1, { stage_detail: "x" }, t),
		);
		expect(unknown).toBeNull();
		const draft = draftFixture("Edited title");
		const hit = ws.store.transaction((tx) =>
			tx.updateTask(row.id, row.rev, { draft }, t),
		);
		expect(hit).toEqual({ ...row, draft, rev: 2, updated_at: t });
		expect(ws.store.getTask(row.id)).toEqual(hit);
		// the old rev is now stale
		expect(
			ws.store.transaction((tx) =>
				tx.updateTask(row.id, row.rev, { stage_detail: "late" }, now()),
			),
		).toBeNull();
	});

	test("updateTask refuses unknown columns, illegal stage moves and invalid rows", () => {
		const row = createTask(ws.store, now());
		const tryPatch = (patch: object) =>
			ws.store.transaction((tx) =>
				tx.updateTask(row.id, row.rev, patch as never, now()),
			);
		expect(() => tryPatch({ repo_id: "local/other" })).toThrow(
			WorkspaceRowError,
		);
		expect(() => tryPatch({ rev: 9 })).toThrow(WorkspaceRowError);
		expect(() => tryPatch({ stage: "queued" })).toThrow(WorkspaceRowError); // needs pointers
		expect(() => tryPatch({ stage: "rejected" })).toThrow(
			/no workspace transition/,
		);
		expect(() =>
			ws.store.transaction((tx) =>
				tx.updateTask(row.id, row.rev, { stage_detail: "x" }, "yesterday"),
			),
		).toThrow(WorkspaceRowError);
		expect(ws.store.getTask(row.id)).toEqual(row);
	});

	test("a terminal (rejected) task never changes again — store and trigger both refuse", () => {
		const task = createTask(ws.store, now());
		const pub = publishProposal(ws, task.id, now());
		const ch = issueChallenge(ws, pub.request.id, now());
		const out = decideRun(ws, {
			request_id: pub.request.id,
			binding_hash: pub.request.binding_hash,
			action: "reject",
			key: "decide-reject-01",
			expected_request_rev: ch.rev,
			now: now(),
		});
		expect(out.kind).toBe("decided");
		const rejected = ws.store.getTask(task.id);
		expect(rejected?.stage).toBe("rejected");
		if (!rejected) throw new Error("unreachable");
		expect(() =>
			ws.store.transaction((tx) =>
				tx.updateTask(
					task.id,
					rejected.rev,
					{ draft: draftFixture("z") },
					now(),
				),
			),
		).toThrow(/terminal/);
		expect(() =>
			ws.db.run(
				"UPDATE workspace_tasks SET stage_detail = 'x', rev = rev + 1 WHERE id = ?",
				[task.id],
			),
		).toThrow(/terminal/);
	});
});

describe("managed_proposals (immutable)", () => {
	test("stored as canonical text whose sha256 is proposal_hash; round-trips", () => {
		const task = createTask(ws.store, now());
		const pub = publishProposal(ws, task.id, now());
		const p = ws.store.getProposal(pub.proposal_id);
		expect(p).not.toBeNull();
		const raw = ws.db
			.query<{ snapshot: string; proposal_hash: string }, [string]>(
				"SELECT snapshot, proposal_hash FROM managed_proposals WHERE id = ?",
			)
			.get(pub.proposal_id);
		expect(raw?.snapshot).toBe(canonicalEncode(p?.snapshot));
		expect(sha256Hex(raw?.snapshot ?? "")).toBe(raw?.proposal_hash ?? "-");
	});

	test("insert refuses a snapshot that does not hash to proposal_hash", () => {
		const task = createTask(ws.store, now());
		const pub = publishProposal(ws, task.id, now());
		const p = ws.store.getProposal(pub.proposal_id);
		if (!p) throw new Error("unreachable");
		const forged = {
			...p,
			id: newWorkspaceId("wsp"),
			version: 2,
			predecessor_proposal_id: p.id,
		};
		forged.snapshot = {
			...p.snapshot,
			proposal_id: forged.id,
			version: 2,
			predecessor_proposal_id: p.id,
		};
		expect(() =>
			ws.store.transaction((tx) => tx.insertProposal(forged)),
		).toThrow(/proposal_hash does not match/);
	});

	test("UPDATE and DELETE are refused by triggers; an exact duplicate is a typed conflict", () => {
		const task = createTask(ws.store, now());
		const pub = publishProposal(ws, task.id, now());
		expect(() =>
			ws.db.run("UPDATE managed_proposals SET created_by = 'x' WHERE id = ?", [
				pub.proposal_id,
			]),
		).toThrow(/immutable/);
		expect(() =>
			ws.db.run("DELETE FROM managed_proposals WHERE id = ?", [
				pub.proposal_id,
			]),
		).toThrow(/immutable/);
		const p = ws.store.getProposal(pub.proposal_id);
		if (!p) throw new Error("unreachable");
		// an exact duplicate hits several unique rules; SQLite names the first index it checks
		expect(
			conflictOf(() => ws.store.transaction((tx) => tx.insertProposal(p))),
		).toMatch(/^(primary_key|proposal_version|proposal_hash)$/);
	});

	test("versions are contiguous per task: duplicate version is a typed conflict; a gap is refused", () => {
		const task = createTask(ws.store, now());
		const v1 = publishProposal(ws, task.id, now());
		const p1 = ws.store.getProposal(v1.proposal_id);
		if (!p1) throw new Error("unreachable");
		const again = (version: number, predecessor: string | null) => {
			const id = newWorkspaceId("wsp");
			const sealed = sealAnyProposal({
				...p1.snapshot,
				proposal_id: id,
				version,
				predecessor_proposal_id: predecessor,
			});
			return {
				...p1,
				id,
				version,
				predecessor_proposal_id: predecessor,
				snapshot: sealed.value,
				proposal_hash: sealed.hash,
			};
		};
		expect(
			conflictOf(() =>
				ws.store.transaction((tx) => tx.insertProposal(again(1, null))),
			),
		).toBe("proposal_version");
		expect(() =>
			ws.store.transaction((tx) => tx.insertProposal(again(3, p1.id))),
		).toThrow(/version N > 1 must name version N-1/);
	});

	test("tampering below the triggers is detected on read (fail closed)", () => {
		const task = createTask(ws.store, now());
		const pub = publishProposal(ws, task.id, now());
		ws.db.run("DROP TRIGGER managed_proposals_no_update");
		ws.db.run(
			"UPDATE managed_proposals SET snapshot = replace(snapshot, 'Add a greeting', 'Delete the repo') WHERE id = ?",
			[pub.proposal_id],
		);
		expect(() => ws.store.getProposal(pub.proposal_id)).toThrow(
			WorkspaceIntegrityError,
		);
	});
});

describe("managed_approval_requests", () => {
	test("hashed columns are canonical text verbatim and verified on read", () => {
		const task = createTask(ws.store, now());
		const pub = publishProposal(ws, task.id, now());
		const raw = ws.db
			.query<Record<string, string>, [string]>(
				"SELECT * FROM managed_approval_requests WHERE id = ?",
			)
			.get(pub.request.id);
		if (!raw) throw new Error("unreachable");
		expect(sha256Hex(raw.binding ?? "")).toBe(raw.binding_hash ?? "-");
		expect(sha256Hex(raw.execution_binding ?? "")).toBe(
			raw.execution_binding_hash ?? "-",
		);
		ws.db.run("DROP TRIGGER managed_approval_requests_update_rules");
		ws.db.run(
			"UPDATE managed_approval_requests SET binding = replace(binding, '\"run\"', '\"run\" ') WHERE id = ?",
			[pub.request.id],
		);
		expect(() => ws.store.getApprovalRequest(pub.request.id)).toThrow(
			WorkspaceIntegrityError,
		);
	});

	test("unique rules surface as typed conflicts: one pending per gate, one Gate 1 per managed task", () => {
		const task = createTask(ws.store, now());
		const pub = publishProposal(ws, task.id, now());
		const r = pub.request;
		// a second pending run request for the task (fresh id + binding, same managed task)
		const second = (status: "pending" | "invalidated") => {
			const id = newWorkspaceId("wsa");
			const b = sealRunApprovalBinding({
				approval_request_id: id,
				workspace_task_id: r.workspace_task_id,
				proposal_id: r.proposal_id,
				proposal_hash: r.proposal_hash,
				execution_binding_hash: r.execution_binding_hash,
			});
			return {
				...r,
				id,
				binding: b.value,
				binding_hash: b.hash,
				status,
				invalidation_reason:
					status === "invalidated" ? ("withdrawn" as const) : null,
				closed_at: status === "invalidated" ? r.created_at : null,
			};
		};
		// closed duplicate → only the per-managed-task rule applies
		expect(
			conflictOf(() =>
				ws.store.transaction((tx) =>
					tx.insertApprovalRequest(second("invalidated")),
				),
			),
		).toBe("run_request_per_managed_task");
		expect(
			conflictOf(() =>
				ws.store.transaction((tx) =>
					tx.insertApprovalRequest(second("pending")),
				),
			),
		).toMatch(/one_pending_request|run_request_per_managed_task/);
		expect(
			conflictOf(() =>
				ws.store.transaction((tx) => tx.insertApprovalRequest(r)),
			),
		).toMatch(
			/^(primary_key|binding_hash|one_pending_request|run_request_per_managed_task)$/,
		);
		expect(
			ws.store.listApprovalRequests({ workspace_task_id: task.id }),
		).toEqual([r]);
	});

	test("CAS: miss returns null; challenge issuance bumps rev; status moves only from pending, once", () => {
		const task = createTask(ws.store, now());
		const pub = publishProposal(ws, task.id, now());
		const r = pub.request;
		expect(
			ws.store.transaction((tx) =>
				tx.updateApprovalRequest(
					r.id,
					r.rev + 5,
					{ challenge_status: "none" },
					now(),
				),
			),
		).toBeNull();
		const issued = issueChallenge(ws, r.id, now());
		expect(issued.rev).toBe(r.rev + 1);
		expect(issued.challenge_status).toBe("issued");
		// partial challenge columns violate the all-or-nothing rule
		expect(() =>
			ws.store.transaction((tx) =>
				tx.updateApprovalRequest(
					r.id,
					issued.rev,
					{ challenge_hash: null },
					now(),
				),
			),
		).toThrow(WorkspaceRowError);
		const t = now();
		const closed = ws.store.transaction((tx) =>
			tx.updateApprovalRequest(
				r.id,
				issued.rev,
				{
					status: "invalidated",
					invalidation_reason: "withdrawn",
					invalidation_detail: null,
					closed_at: t,
				},
				t,
			),
		);
		expect(closed?.status).toBe("invalidated");
		if (!closed) throw new Error("unreachable");
		// final statuses never move (store refuses; the trigger refuses raw SQL too)
		expect(() =>
			ws.store.transaction((tx) =>
				tx.updateApprovalRequest(
					r.id,
					closed.rev,
					{ status: "pending", invalidation_reason: null, closed_at: null },
					now(),
				),
			),
		).toThrow(/closed request never changes/);
		expect(() =>
			ws.db.run(
				"UPDATE managed_approval_requests SET status = 'pending', invalidation_reason = NULL, closed_at = NULL, rev = rev + 1 WHERE id = ?",
				[r.id],
			),
		).toThrow(/closed request never changes/);
		expect(() =>
			ws.db.run("DELETE FROM managed_approval_requests WHERE id = ?", [r.id]),
		).toThrow(/never deleted/);
	});

	test("a run request can never be 'accepted' and status jumps must follow canTransitionApproval", () => {
		const task = createTask(ws.store, now());
		const pub = publishProposal(ws, task.id, now());
		const t = now();
		expect(() =>
			ws.store.transaction((tx) =>
				tx.updateApprovalRequest(
					pub.request.id,
					pub.request.rev,
					{ status: "accepted", closed_at: t },
					t,
				),
			),
		).toThrow(WorkspaceRowError);
	});

	test("raw writers must bump rev by exactly 1 and cannot touch binding columns", () => {
		const task = createTask(ws.store, now());
		const pub = publishProposal(ws, task.id, now());
		expect(() =>
			ws.db.run(
				"UPDATE managed_approval_requests SET invalidation_detail = 'x' WHERE id = ?",
				[pub.request.id],
			),
		).toThrow(/rev must grow by exactly 1/);
		expect(() =>
			ws.db.run(
				"UPDATE managed_approval_requests SET binding_hash = ?, rev = rev + 1 WHERE id = ?",
				[sha256Hex("x"), pub.request.id],
			),
		).toThrow(/immutable/);
		expect(() =>
			ws.db.run("UPDATE workspace_tasks SET stage_detail = 'x' WHERE id = ?", [
				task.id,
			]),
		).toThrow(/rev must grow by exactly 1/);
		expect(() =>
			ws.db.run("DELETE FROM workspace_tasks WHERE id = ?", [task.id]),
		).toThrow(/never deleted/);
	});

	test("Gate 2: result request needs an approved Gate 1; one result request per attempt, ever (OQ-7 history kept)", () => {
		const ex = approvedExecution(ws, now);
		const run = seedRun(ws, ex.managed_task_id, now());
		// OQ-7: an ineligible result is inserted already invalidated
		const first = resultRequestRow(
			ex.runRequest,
			ex.decision_id,
			run.id,
			now(),
			"invalidated",
		);
		ws.store.transaction((tx) => tx.insertApprovalRequest(first));
		expect(ws.store.getApprovalRequest(first.id)).toEqual(first);
		const second = resultRequestRow(
			ex.runRequest,
			ex.decision_id,
			run.id,
			now(),
		);
		expect(
			conflictOf(() =>
				ws.store.transaction((tx) => tx.insertApprovalRequest(second)),
			),
		).toBe("result_request_per_run");
		// without an approved Gate 1 of the same execution → refused by trigger
		const task2 = createTask(ws.store, now());
		const pub2 = publishProposal(ws, task2.id, now());
		const run2 = seedRun(ws, pub2.managed_task_id, now());
		const orphan = resultRequestRow(
			pub2.request,
			ex.decision_id,
			run2.id,
			now(),
		);
		expect(() =>
			ws.store.transaction((tx) => tx.insertApprovalRequest(orphan)),
		).toThrow(/needs the approved run request/);
		// a run of another managed task is refused
		const crossed = resultRequestRow(
			ex.runRequest,
			ex.decision_id,
			run2.id,
			now(),
		);
		expect(() =>
			ws.store.transaction((tx) => tx.insertApprovalRequest(crossed)),
		).toThrow(/run_id must be an attempt of managed_task_id/);
		expect(ws.store.findResultRequestForRun(run.id)?.invalidation_reason).toBe(
			"evidence_unavailable",
		);
	});

	test("listApprovalRequests filters and orders newest first; foreign_key_check stays clean", () => {
		const task = createTask(ws.store, now());
		publishProposal(ws, task.id, now());
		ws.store.transaction((tx) => {
			const t = tx.getTask(task.id);
			if (!t) throw new Error("unreachable");
			tx.updateTask(task.id, t.rev, { draft: draftFixture("v2 title") }, now());
		});
		const pub2 = publishProposal(ws, task.id, now());
		const all = ws.store.listApprovalRequests({ workspace_task_id: task.id });
		expect(all.map((r) => r.status)).toEqual(["pending", "invalidated"]);
		expect(all[0]?.id).toBe(pub2.request.id);
		expect(
			ws.store.listApprovalRequests({ status: "invalidated", kind: "run" }),
		).toHaveLength(1);
		expect(ws.store.listApprovalRequests({ kind: "result" })).toEqual([]);
		expect(ws.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
	});
});

describe("managed_decisions (append-only receipts)", () => {
	test("duplicate key: same operator+key is a typed conflict and the stored receipt is never overwritten", () => {
		const task = createTask(ws.store, now());
		const pub = publishProposal(ws, task.id, now());
		const ch = issueChallenge(ws, pub.request.id, now());
		const out = decideRun(ws, {
			request_id: pub.request.id,
			binding_hash: pub.request.binding_hash,
			action: "approve",
			key: "decide-key-0001",
			expected_request_rev: ch.rev,
			now: now(),
		});
		expect(out.kind).toBe("decided");
		const stored = ws.store.findReceipt(OPERATOR_ID, "decide-key-0001");
		if (!stored || out.kind !== "decided") throw new Error("unreachable");
		expect(stored.response_body).toEqual(out.receipt);
		const before = dumpAll(ws.db);
		// same key, different decision content → conflict, nothing changes
		const forged = {
			...stored,
			id: newWorkspaceId("wsd"),
			payload_hash: sha256Hex("different payload"),
		};
		forged.response_body = {
			...stored.response_body,
			decision_id: forged.id,
			payload_hash: forged.payload_hash,
		};
		expect(
			conflictOf(() => ws.store.transaction((tx) => tx.insertDecision(forged))),
		).toMatch(/decision_idempotency|decision_per_request/);
		// a different key for the same request → one decision per request
		const otherKey = { ...forged, idempotency_key: "decide-key-0002" };
		expect(
			conflictOf(() =>
				ws.store.transaction((tx) => tx.insertDecision(otherKey)),
			),
		).toBe("decision_per_request");
		expect(dumpAll(ws.db)).toBe(before);
		expect(ws.store.findReceipt(OPERATOR_ID, "decide-key-0001")).toEqual(
			stored,
		);
		expect(ws.store.findReceipt(OPERATOR_ID, "decide-key-0002")).toBeNull();
	});

	test("UPDATE/DELETE refused; a receipt that does not describe its decision is refused", () => {
		const ex = approvedExecution(ws, now);
		expect(() =>
			ws.db.run("UPDATE managed_decisions SET reason = 'x' WHERE id = ?", [
				ex.decision_id,
			]),
		).toThrow(/append-only/);
		expect(() =>
			ws.db.run("DELETE FROM managed_decisions WHERE id = ?", [ex.decision_id]),
		).toThrow(/append-only/);
		const d = ws.store.getDecision(ex.decision_id);
		if (!d) throw new Error("unreachable");
		const lying = {
			...d,
			id: newWorkspaceId("wsd"),
			idempotency_key: "decide-key-lying",
		};
		expect(() =>
			ws.store.transaction((tx) => tx.insertDecision(lying)),
		).toThrow(/receipt does not describe this decision/);
	});
});

describe("transactions", () => {
	test("a throw rolls back every write of the callback", () => {
		const row = taskRow(now());
		expect(() =>
			ws.store.transaction((tx) => {
				tx.insertTask(row);
				expect(tx.getTask(row.id)).not.toBeNull();
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(ws.store.getTask(row.id)).toBeNull();
	});

	test("refuses nesting inside another transaction, async callbacks, and a tx used after its callback", () => {
		expect(() =>
			ws.db.transaction(() => ws.store.transaction(() => 1))(),
		).toThrow(WorkspaceTxError);
		const row = taskRow(now());
		expect(() =>
			ws.store.transaction(async (tx) => {
				tx.insertTask(row);
			}),
		).toThrow(/synchronous/);
		expect(ws.store.getTask(row.id)).toBeNull();
		let leaked:
			| Parameters<Parameters<typeof ws.store.transaction>[0]>[0]
			| null = null;
		ws.store.transaction((tx) => {
			leaked = tx;
		});
		expect(() => leaked?.getTask(row.id)).toThrow(WorkspaceTxError);
		expect(() => leaked?.insertTask(row)).toThrow(WorkspaceTxError);
		expect(ws.store.getTask(row.id)).toBeNull();
	});
});

describe("up-pointers on workspace_tasks (trigger-validated, no FK cycle)", () => {
	test("Gate 2 accept: accepted_decision_id must be this task's result `accept`; engine stays human_ready", () => {
		const ex = approvedExecution(ws, now);
		const run = seedRun(ws, ex.managed_task_id, now());
		ws.db.run(
			"UPDATE managed_tasks SET state = 'human_ready', result_run_id = ?, rev = rev + 1 WHERE id = ?",
			[run.id, ex.managed_task_id],
		); // simulated engine outcome (test-only)
		const result = resultRequestRow(
			ex.runRequest,
			ex.decision_id,
			run.id,
			now(),
		);
		ws.store.transaction((tx) => {
			let t = tx.getTask(ex.task.id);
			if (!t) throw new Error("unreachable");
			t = tx.updateTask(t.id, t.rev, { stage: "running" }, now());
			if (!t) throw new Error("unreachable");
			tx.insertApprovalRequest(result);
			tx.updateTask(t.id, t.rev, { stage: "awaiting_acceptance" }, now());
		});
		const task = ws.store.getTask(ex.task.id);
		if (!task) throw new Error("unreachable");
		// pointing at the Gate-1 approve decision is refused (trigger), as is accepted without a pointer
		expect(() =>
			ws.store.transaction((tx) =>
				tx.updateTask(
					task.id,
					task.rev,
					{ stage: "accepted", accepted_decision_id: ex.decision_id },
					now(),
				),
			),
		).toThrow(/Gate-2 accept/);
		expect(() =>
			ws.store.transaction((tx) =>
				tx.updateTask(task.id, task.rev, { stage: "accepted" }, now()),
			),
		).toThrow(WorkspaceRowError);

		const decision_id = newWorkspaceId("wsd");
		const t = now();
		ws.store.transaction((tx) => {
			const r = tx.getApprovalRequest(result.id);
			const cur = tx.getTask(task.id);
			if (!r || !cur || !r.result_envelope_hash) throw new Error("unreachable");
			const payload_hash = sha256Hex("gate2-accept-payload");
			tx.insertDecision({
				id: decision_id,
				approval_request_id: r.id,
				workspace_task_id: cur.id,
				kind: "result",
				action: "accept",
				operator_id: OPERATOR_ID,
				idempotency_key: "gate2-accept-key-1",
				payload_hash,
				binding_hash: r.binding_hash,
				request_rev: r.rev,
				confirmation_text: "Edward",
				reason: null,
				boot_id: "boot-99999999-9999-4999-8999-999999999999",
				session_generation: 1,
				managed_task_id: r.managed_task_id,
				result_envelope_hash: r.result_envelope_hash,
				decided_at: t,
				response_status: 201,
				response_body: {
					contract: "agentcity.decision/v1",
					decision_id,
					approval_request_id: r.id,
					workspace_task_id: cur.id,
					kind: "result",
					action: "accept",
					operator_id: OPERATOR_ID,
					decided_at: t,
					payload_hash,
					binding_hash: r.binding_hash,
					approval_request: { status: "accepted", rev: r.rev + 1 },
					workspace_task: { stage: "accepted", rev: cur.rev + 1 },
					effects: {
						managed_task_id: r.managed_task_id,
						managed_task_state: "human_ready",
						result_envelope_hash: r.result_envelope_hash,
					},
				},
			});
			tx.updateApprovalRequest(
				r.id,
				r.rev,
				{ status: "accepted", closed_at: t },
				t,
			);
			tx.updateTask(
				cur.id,
				cur.rev,
				{ stage: "accepted", accepted_decision_id: decision_id },
				t,
			);
		});
		const accepted = ws.store.getTask(task.id);
		expect(accepted?.stage).toBe("accepted");
		expect(accepted?.accepted_decision_id).toBe(decision_id);
		expect(ws.store.getApprovalRequest(result.id)?.status).toBe("accepted");
		expect(getManagedTask(ws.db, ex.managed_task_id)?.state).toBe(
			"human_ready",
		);
		expect(ws.store.listDecisions(task.id).map((d) => d.action)).toEqual([
			"accept",
			"approve",
		]);
	});

	test("current_managed_task_id must have a run request of this task for the current proposal", () => {
		const a = createTask(ws.store, now());
		const pubA = publishProposal(ws, a.id, now());
		const b = createTask(ws.store, now());
		const pubB = publishProposal(ws, b.id, now());
		const tb = ws.store.getTask(b.id);
		if (!tb) throw new Error("unreachable");
		// B pointing at A's managed task
		expect(() =>
			ws.store.transaction((tx) =>
				tx.updateTask(
					b.id,
					tb.rev,
					{ current_managed_task_id: pubA.managed_task_id },
					now(),
				),
			),
		).toThrow(/run request of this task/);
		// B pointing at A's proposal
		expect(() =>
			ws.store.transaction((tx) =>
				tx.updateTask(
					b.id,
					tb.rev,
					{ current_proposal_id: pubA.proposal_id },
					now(),
				),
			),
		).toThrow(/proposal of this task/);
		expect(ws.store.getTask(b.id)?.current_managed_task_id).toBe(
			pubB.managed_task_id,
		);
	});
});
