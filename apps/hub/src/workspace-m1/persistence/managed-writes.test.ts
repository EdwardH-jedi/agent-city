import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { TaskSubmission } from "@agent-city/schema";
import {
	type AnyProposalSnapshot,
	managedTaskFieldsFor,
} from "@agent-city/schema/workspace-m1";
import {
	canonicalEncode,
	newWorkspaceId,
	sealAnyProposal,
	sha256Hex,
} from "@agent-city/schema/workspace-m1/hash";
import {
	canonicalJson,
	type ManagedConfig,
	parseManagedConfig,
	policyHash,
} from "../../managed/config.ts";
import { approvalHashFor } from "../../managed/service.ts";
import {
	createTask as createManagedTask,
	getTask,
	openQuarantine,
} from "../../managed/store.ts";
import { WorkspaceTxError } from "./errors.ts";
import {
	enqueueApprovedTask,
	ManagedWriteError,
	releaseReservedTask,
	reserveManagedTask,
} from "./managed-writes.ts";
import {
	BASE_SHA,
	clock,
	createTask,
	decideRun,
	FIXTURE_REPO,
	fixtureConfig,
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

/** A published Gate 1 + an inserted approve decision, stopped right before the enqueue step. */
function approveUpToEnqueue(config: ManagedConfig = fixtureConfig()) {
	const task = createTask(ws.store, now());
	const pub = publishProposal(ws, task.id, now());
	issueChallenge(ws, pub.request.id, now());
	return { task, pub, config };
}

class Rollback<T> {
	constructor(readonly value: T) {}
}

/**
 * Insert the decision row inside a tx and run `fn` (enqueue) in the same tx. Commits only when the
 * enqueue queued — a refused enqueue rolls the decision back, as the decision service must.
 */
function withDecision<T extends { queued: boolean }>(
	pub: ReturnType<typeof publishProposal>,
	fn: (
		tx: Parameters<Parameters<typeof ws.store.transaction>[0]>[0],
		decision_id: string,
	) => T,
): T {
	try {
		return decideInTx(pub, fn);
	} catch (err) {
		if (err instanceof Rollback) return err.value as T;
		throw err;
	}
}

function decideInTx<T extends { queued: boolean }>(
	pub: ReturnType<typeof publishProposal>,
	fn: (
		tx: Parameters<Parameters<typeof ws.store.transaction>[0]>[0],
		decision_id: string,
	) => T,
): T {
	return ws.store.transaction((tx) => {
		const r = tx.getApprovalRequest(pub.request.id);
		if (!r) throw new Error("unreachable");
		const decision_id = newWorkspaceId("wsd");
		const t = now();
		tx.insertDecision({
			id: decision_id,
			approval_request_id: r.id,
			workspace_task_id: r.workspace_task_id,
			kind: "run",
			action: "approve",
			operator_id: "operator:edward",
			idempotency_key: `k-${crypto.randomUUID()}`,
			payload_hash: sha256Hex("payload"),
			binding_hash: r.binding_hash,
			request_rev: r.rev,
			confirmation_text: "Edward",
			reason: null,
			boot_id: "boot-99999999-9999-4999-8999-999999999999",
			session_generation: 1,
			managed_task_id: r.managed_task_id,
			result_envelope_hash: null,
			decided_at: t,
			response_status: 201,
			response_body: {
				contract: "agentcity.decision/v1",
				decision_id,
				approval_request_id: r.id,
				workspace_task_id: r.workspace_task_id,
				kind: "run",
				action: "approve",
				operator_id: "operator:edward",
				decided_at: t,
				payload_hash: sha256Hex("payload"),
				binding_hash: r.binding_hash,
				approval_request: { status: "approved", rev: r.rev + 1 },
				workspace_task: { stage: "queued", rev: 3 },
				effects: {
					managed_task_id: r.managed_task_id,
					managed_task_state: "queued",
					result_envelope_hash: null,
				},
			},
		});
		const out = fn(tx, decision_id);
		if (!out.queued) throw new Rollback(out);
		return out;
	});
}

describe("reserve (ExecutionBridge.reserve)", () => {
	test("inserts a draft managed task: key = request id, request_hash = execution binding hash, fields = managedTaskFieldsFor", () => {
		const task = createTask(ws.store, now());
		const pub = publishProposal(ws, task.id, now());
		const m = getTask(ws.db, pub.managed_task_id);
		const proposal = ws.store.getProposal(pub.proposal_id);
		if (!m || !proposal) throw new Error("unreachable");
		expect(m.state).toBe("draft");
		expect(m.idempotency_key).toBe(pub.request.id);
		expect(m.request_hash).toBe(pub.request.execution_binding_hash);
		expect(m.approval_hash).toBeNull();
		expect(m.run_requested_at).toBeNull();
		const fields = managedTaskFieldsFor(proposal.snapshot);
		expect({
			repo_id: m.repo_id,
			title: m.title,
			objective: m.objective,
			acceptance_criteria: m.acceptance_criteria,
			approved_scope: m.approved_scope,
			execution_mode: m.execution_mode,
			simulation_scenario: m.simulation_scenario,
			repair_limit: m.repair_limit,
			base_ref: m.base_ref,
			base_sha: m.base_sha,
		}).toEqual(fields);
		expect(m.repair_limit).toBe(0); // explicit, never DEFAULT_REPAIR_LIMIT (1)
		// the binding covers the pre-minted id and the CURRENT policy hash
		expect(pub.request.execution_binding).toEqual({
			contract: "agentcity.execution-binding/v1",
			proposal_id: pub.proposal_id,
			proposal_hash: proposal.proposal_hash,
			managed_task_id: m.id,
			base_sha: BASE_SHA,
			policy_hash: policyHash(fixtureConfig(), FIXTURE_REPO),
		});
		// TaskSubmission parsing is the identity on the snapshot fields, so approvalHashFor(task)
		// hashes exactly the frozen proposal text
		const { base_ref: _r, base_sha: _s, ...submissionFields } = fields;
		const submission = {
			idempotency_key: m.idempotency_key,
			...submissionFields,
		};
		expect(canonicalJson(TaskSubmission.parse(submission))).toBe(
			canonicalJson(submission),
		);
		expect(approvalHashFor(m, fixtureConfig())).toBe(
			approvalHashFor({ ...m, ...fields }, fixtureConfig()),
		);
	});

	test("refuses outside an open workspace transaction (and with a leaked tx)", () => {
		const task = createTask(ws.store, now());
		const pub = publishProposal(ws, task.id, now());
		const proposal = ws.store.getProposal(pub.proposal_id);
		if (!proposal) throw new Error("unreachable");
		let leaked:
			| Parameters<Parameters<typeof ws.store.transaction>[0]>[0]
			| null = null;
		ws.store.transaction((tx) => {
			leaked = tx;
		});
		const input = {
			proposal: proposal.snapshot,
			proposal_hash: proposal.proposal_hash,
			approval_request_id: newWorkspaceId("wsa"),
			now: now(),
		};
		expect(() => reserveManagedTask(ws.deps, leaked as never, input)).toThrow(
			WorkspaceTxError,
		);
		expect(() => reserveManagedTask(ws.deps, {} as never, input)).toThrow(
			WorkspaceTxError,
		);
	});

	test("refuses a proposal that is not stored / does not hash / names a repo outside the allowlist", () => {
		const task = createTask(ws.store, now());
		const pub = publishProposal(ws, task.id, now());
		const proposal = ws.store.getProposal(pub.proposal_id);
		if (!proposal) throw new Error("unreachable");
		const attempt = (
			snapshot: AnyProposalSnapshot,
			hash: string,
			config: ManagedConfig = fixtureConfig(),
		) => {
			try {
				ws.store.transaction((tx) =>
					reserveManagedTask({ ...ws.deps, config }, tx, {
						proposal: snapshot,
						proposal_hash: hash,
						approval_request_id: newWorkspaceId("wsa"),
						now: now(),
					}),
				);
			} catch (err) {
				if (err instanceof ManagedWriteError) return err.code;
				throw err;
			}
			return "reserved";
		};
		expect(attempt(proposal.snapshot, sha256Hex("x"))).toBe(
			"proposal_hash_mismatch",
		);
		const otherRepoConfig = parseManagedConfig({
			workspace_root: "/nonexistent/w",
			artifacts_root: "/nonexistent/a",
			repos: [{ id: "local/other", path: "/nonexistent/r", base_ref: "main" }],
		});
		expect(
			attempt(proposal.snapshot, proposal.proposal_hash, otherRepoConfig),
		).toBe("repo_not_allowed");
		// a sealed but never-inserted snapshot
		const unsaved = sealAnyProposal({
			...proposal.snapshot,
			proposal_id: newWorkspaceId("wsp"),
		});
		expect(attempt(unsaved.value, unsaved.hash)).toBe("proposal_not_stored");
		// a second reservation of the same proposal is a fresh managed task (rerun semantics)
		expect(attempt(proposal.snapshot, proposal.proposal_hash)).toBe("reserved");
	});
});

describe("enqueueApproved (ExecutionBridge.enqueueApproved)", () => {
	test("draft → queued with exactly requestRun's writes", () => {
		const { pub } = approveUpToEnqueue();
		const before = getTask(ws.db, pub.managed_task_id);
		if (!before) throw new Error("unreachable");
		const t = now();
		const res = withDecision(pub, (tx, decision_id) =>
			enqueueApprovedTask(ws.deps, tx, {
				managed_task_id: pub.managed_task_id,
				decision_id,
				execution_binding_hash: pub.request.execution_binding_hash,
				now: t,
			}),
		);
		expect(res).toEqual({ queued: true });
		const after = getTask(ws.db, pub.managed_task_id);
		if (!after) throw new Error("unreachable");
		expect(after.state).toBe("queued");
		expect(after.approval_hash).toBe(approvalHashFor(before, fixtureConfig()));
		expect(after.run_requested_at).toBe(t);
		expect(after.fence_token).toBe(before.fence_token + 1);
		expect(after.infra_retries).toBe(0);
		expect(after.lease_owner).toBeNull();
		expect(after.cancel_requested_at).toBeNull();
		expect(after.rev).toBe(before.rev + 1);
		// nothing else changed (content columns untouched)
		const normalized: typeof before = {
			...after,
			state: "draft",
			approval_hash: null,
			run_requested_at: null,
			fence_token: before.fence_token,
			rev: before.rev,
			updated_at: before.updated_at,
		};
		expect(normalized).toEqual(before);
	});

	test("never re-queues blocked / interrupted / queued tasks (legacy rerun bypass stays closed)", () => {
		for (const state of [
			"blocked",
			"interrupted",
			"queued",
			"cancelled",
		] as const) {
			const { pub } = approveUpToEnqueue();
			ws.db.run(
				"UPDATE managed_tasks SET state = ?, rev = rev + 1 WHERE id = ?",
				[state, pub.managed_task_id],
			);
			const fence = getTask(ws.db, pub.managed_task_id)?.fence_token;
			const res = withDecision(pub, (tx, decision_id) =>
				enqueueApprovedTask(ws.deps, tx, {
					managed_task_id: pub.managed_task_id,
					decision_id,
					execution_binding_hash: pub.request.execution_binding_hash,
					now: now(),
				}),
			);
			expect(res).toEqual({ queued: false, reason: "not_draft" });
			const m = getTask(ws.db, pub.managed_task_id);
			expect(m?.state).toBe(state);
			expect(m?.fence_token).toBe(fence ?? -1);
		}
	});

	test("policy drift, a wrong binding hash or tampered task content → binding_mismatch, nothing queued", () => {
		const { pub } = approveUpToEnqueue();
		const enqueue = (deps: typeof ws.deps, hash: string) =>
			withDecision(pub, (tx, decision_id) =>
				enqueueApprovedTask(deps, tx, {
					managed_task_id: pub.managed_task_id,
					decision_id,
					execution_binding_hash: hash,
					now: now(),
				}),
			);
		const mismatch = { queued: false, reason: "binding_mismatch" } as const;
		expect(
			enqueue(
				{ ...ws.deps, config: fixtureConfig(1) },
				pub.request.execution_binding_hash,
			),
		).toEqual(mismatch);
		expect(enqueue(ws.deps, sha256Hex("other"))).toEqual(mismatch);
		ws.db.run(
			"UPDATE managed_tasks SET objective = 'Exfiltrate everything', rev = rev + 1 WHERE id = ?",
			[pub.managed_task_id],
		);
		expect(enqueue(ws.deps, pub.request.execution_binding_hash)).toEqual(
			mismatch,
		);
		expect(getTask(ws.db, pub.managed_task_id)?.state).toBe("draft");
	});

	test("open quarantine → quarantined; repo left the allowlist → repo_not_allowed", () => {
		const { pub } = approveUpToEnqueue();
		const otherRepoConfig = parseManagedConfig({
			workspace_root: "/nonexistent/w",
			artifacts_root: "/nonexistent/a",
			repos: [{ id: "local/other", path: "/nonexistent/r", base_ref: "main" }],
		});
		const enqueue = (deps: typeof ws.deps) =>
			withDecision(pub, (tx, decision_id) =>
				enqueueApprovedTask(deps, tx, {
					managed_task_id: pub.managed_task_id,
					decision_id,
					execution_binding_hash: pub.request.execution_binding_hash,
					now: now(),
				}),
			);
		expect(enqueue({ ...ws.deps, config: otherRepoConfig })).toEqual({
			queued: false,
			reason: "repo_not_allowed",
		});
		openQuarantine(ws.db, {
			task_id: pub.managed_task_id,
			run_id: null,
			pid: 4242,
			started: null,
			reason: "synthetic",
			now: now(),
		});
		expect(enqueue(ws.deps)).toEqual({ queued: false, reason: "quarantined" });
		expect(getTask(ws.db, pub.managed_task_id)?.state).toBe("draft");
	});

	test("without an approve decision of this request in the transaction it throws (nothing queued)", () => {
		const { pub } = approveUpToEnqueue();
		expect(() =>
			ws.store.transaction((tx) =>
				enqueueApprovedTask(ws.deps, tx, {
					managed_task_id: pub.managed_task_id,
					decision_id: newWorkspaceId("wsd"),
					execution_binding_hash: pub.request.execution_binding_hash,
					now: now(),
				}),
			),
		).toThrow(ManagedWriteError);
		expect(getTask(ws.db, pub.managed_task_id)?.state).toBe("draft");
	});
});

describe("releaseReserved (ExecutionBridge.releaseReserved)", () => {
	test("reserved draft → cancelled via requestCancel; idempotent; queued is a violation; legacy tasks are not touched", () => {
		const task = createTask(ws.store, now());
		const pub = publishProposal(ws, task.id, now());
		const release = (id: string) =>
			ws.store.transaction((tx) =>
				releaseReservedTask(ws.deps, tx, {
					managed_task_id: id,
					reason: "withdrawn",
					now: now(),
				}),
			);
		release(pub.managed_task_id);
		const m = getTask(ws.db, pub.managed_task_id);
		expect(m?.state).toBe("cancelled");
		expect(m?.failure_kind).toBe("cancelled");
		const rev = m?.rev;
		release(pub.managed_task_id); // idempotent
		expect(getTask(ws.db, pub.managed_task_id)?.rev).toBe(rev ?? -1);

		const t2 = createTask(ws.store, now());
		const pub2 = publishProposal(ws, t2.id, now());
		const ch = issueChallenge(ws, pub2.request.id, now());
		decideRun(ws, {
			request_id: pub2.request.id,
			binding_hash: pub2.request.binding_hash,
			action: "approve",
			key: "decide-approve-r1",
			expected_request_rev: ch.rev,
			now: now(),
		});
		expect(getTask(ws.db, pub2.managed_task_id)?.state).toBe("queued");
		expect(() => release(pub2.managed_task_id)).toThrow(/not draft/);
		expect(getTask(ws.db, pub2.managed_task_id)?.state).toBe("queued");

		const legacy = createManagedTask(ws.db, {
			submission: TaskSubmission.parse({
				idempotency_key: "legacy-task-0001",
				repo_id: FIXTURE_REPO,
				title: "legacy",
				objective: "legacy",
				acceptance_criteria: ["x"],
				approved_scope: ["src"],
				execution_mode: "simulated",
			}),
			request_hash: sha256Hex("legacy"),
			base_ref: "main",
			base_sha: BASE_SHA,
			now: now(),
		}).task;
		expect(() => release(legacy.id)).toThrow(/not a workspace reservation/);
		expect(getTask(ws.db, legacy.id)?.state).toBe("draft");
		expect(canonicalEncode(getTask(ws.db, legacy.id)?.state)).toBe('"draft"');
	});
});
