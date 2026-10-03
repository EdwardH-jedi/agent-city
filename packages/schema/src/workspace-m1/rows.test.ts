import { describe, expect, test } from "bun:test";
import {
	FIXTURE_REPO,
	IDS,
	sampleDraft,
	sampleGraph,
} from "./fixtures/sample.ts";
import {
	createTaskRequestHash,
	sha256Hex,
	storedCanonicalMatches,
} from "./hash.ts";
import {
	ApprovalRequestRow,
	ApprovalRequestView,
	CancelRequest,
	CreateWorkspaceTaskRequest,
	ManagedDecisionRow,
	ManagedProposalRow,
	PublishProposalRequest,
	RequestRerunRequest,
	SaveDraftRequest,
	WorkspaceTaskRow,
	WorkspaceTaskSummary,
	WorkspaceTaskView,
} from "./index.ts";

const g = sampleGraph();
const T0 = "2026-10-02T00:00:00.000Z";

const taskRow = (): WorkspaceTaskRow => ({
	id: IDS.workspace_task,
	contract_version: "agentcity.workspace-task/v1",
	repo_id: FIXTURE_REPO,
	created_by: "operator:edward",
	idempotency_key: "create-task-0001",
	request_hash: createTaskRequestHash({
		repo_id: FIXTURE_REPO,
		draft: sampleDraft(),
	}),
	draft: sampleDraft(),
	stage: "awaiting_run_approval",
	stage_detail: null,
	current_proposal_id: IDS.proposal_v1,
	current_managed_task_id: IDS.managed_task,
	accepted_decision_id: null,
	cancel_requested_at: null,
	created_at: T0,
	updated_at: T0,
	rev: 3,
});

const proposalRow = (): ManagedProposalRow => ({
	id: IDS.proposal_v1,
	workspace_task_id: IDS.workspace_task,
	version: 1,
	predecessor_proposal_id: null,
	contract_version: "agentcity.proposal/v1",
	snapshot: g.proposal.value,
	proposal_hash: g.proposal.hash,
	created_by: "operator:edward",
	created_at: T0,
});

const runRequest = (): ApprovalRequestRow => ({
	id: IDS.run_request,
	workspace_task_id: IDS.workspace_task,
	kind: "run",
	proposal_id: IDS.proposal_v1,
	proposal_hash: g.proposal.hash,
	managed_task_id: IDS.managed_task,
	execution_binding: g.execution.value,
	execution_binding_hash: g.execution.hash,
	run_id: null,
	result_envelope: null,
	result_envelope_hash: null,
	binding: g.runBinding.value,
	binding_hash: g.runBinding.hash,
	status: "pending",
	invalidation_reason: null,
	invalidation_detail: null,
	created_at: T0,
	updated_at: T0,
	closed_at: null,
	rev: 2,
	challenge_status: "issued",
	challenge_hash: g.challengeHash,
	challenge_operator_id: "operator:edward",
	challenge_session_generation: 1,
	challenge_boot_id: IDS.boot,
	challenge_request_rev: 2,
	challenge_issued_at: "2026-10-02T00:00:00.000Z",
	challenge_expires_at: "2026-10-02T00:05:00.000Z",
});

const resultRequest = (): ApprovalRequestRow => ({
	...runRequest(),
	id: IDS.result_request,
	kind: "result",
	run_id: IDS.run_repair,
	result_envelope: g.result.value,
	result_envelope_hash: g.result.hash,
	binding: g.resultBinding.value,
	binding_hash: g.resultBinding.hash,
	challenge_status: "none",
	challenge_hash: null,
	challenge_operator_id: null,
	challenge_session_generation: null,
	challenge_boot_id: null,
	challenge_request_rev: null,
	challenge_issued_at: null,
	challenge_expires_at: null,
});

describe("workspace_tasks", () => {
	test("valid row; invariants", () => {
		expect(WorkspaceTaskRow.safeParse(taskRow()).success).toBe(true);
		const t = taskRow();
		expect(
			WorkspaceTaskRow.safeParse({ ...t, stage: "accepted" }).success,
		).toBe(false);
		expect(
			WorkspaceTaskRow.safeParse({
				...t,
				accepted_decision_id: IDS.result_decision,
			}).success,
		).toBe(false);
		expect(
			WorkspaceTaskRow.safeParse({
				...t,
				stage: "accepted",
				accepted_decision_id: IDS.result_decision,
			}).success,
		).toBe(true);
		expect(
			WorkspaceTaskRow.safeParse({ ...t, current_managed_task_id: null })
				.success,
		).toBe(false);
		expect(
			WorkspaceTaskRow.safeParse({ ...t, stage: "cancel_requested" }).success,
		).toBe(false);
		expect(
			WorkspaceTaskRow.safeParse({
				...t,
				stage: "draft",
				current_proposal_id: null,
				current_managed_task_id: null,
			}).success,
		).toBe(true);
		expect(
			WorkspaceTaskRow.safeParse({
				...t,
				created_at: "2026-10-02T10:00:00+10:00",
			}).success,
		).toBe(false);
		expect(
			WorkspaceTaskRow.safeParse({ ...t, created_by: "operator:other" })
				.success,
		).toBe(false);
	});
	test("the summary drops create internals", () => {
		const { idempotency_key: _k, request_hash: _h, ...summary } = taskRow();
		expect(WorkspaceTaskSummary.safeParse(summary).success).toBe(true);
		expect(WorkspaceTaskSummary.safeParse(taskRow()).success).toBe(false);
	});
});

describe("managed_proposals", () => {
	test("snapshot identity must equal the row; stored canonical verifies", () => {
		expect(ManagedProposalRow.safeParse(proposalRow()).success).toBe(true);
		expect(
			ManagedProposalRow.safeParse({ ...proposalRow(), version: 2 }).success,
		).toBe(false);
		expect(
			ManagedProposalRow.safeParse({ ...proposalRow(), id: IDS.proposal_v2 })
				.success,
		).toBe(false);
		expect(
			storedCanonicalMatches(g.proposal.canonical, proposalRow().proposal_hash),
		).toBe(true);
	});
});

describe("managed_approval_requests", () => {
	test("valid run and result rows", () => {
		expect(ApprovalRequestRow.safeParse(runRequest()).success).toBe(true);
		expect(ApprovalRequestRow.safeParse(resultRequest()).success).toBe(true);
	});
	const runBad: [string, Partial<ApprovalRequestRow>][] = [
		["run with run_id", { run_id: IDS.run_repair }],
		["run with envelope hash", { result_envelope_hash: g.result.hash }],
		["binding of another request", { id: IDS.result_request }],
		["binding of the other kind", { kind: "result" }],
		[
			"execution binding of another managed task",
			{ managed_task_id: "task-00000000-0000-4000-8000-000000000000" },
		],
		["invalidated without reason", { status: "invalidated", closed_at: T0 }],
		["reason while pending", { invalidation_reason: "withdrawn" }],
		["closed while pending", { closed_at: T0 }],
		["decided but not closed", { status: "approved" }],
		["run accepted", { status: "accepted", closed_at: T0 }],
		["half a challenge", { challenge_hash: null }],
		["challenge without status", { challenge_status: "none" }],
		[
			"challenge expiry not in hashed form",
			{ challenge_expires_at: "2026-10-02T00:05:00Z" },
		],
	];
	for (const [name, patch] of runBad)
		test(`invalid: ${name}`, () => {
			expect(
				ApprovalRequestRow.safeParse({ ...runRequest(), ...patch }).success,
			).toBe(false);
		});
	test("result request cannot be `approved`", () => {
		expect(
			ApprovalRequestRow.safeParse({
				...resultRequest(),
				status: "approved",
				closed_at: T0,
			}).success,
		).toBe(false);
	});
	test("the client view never contains challenge columns", () => {
		const row = runRequest();
		const view = Object.fromEntries(
			Object.entries(row).filter(([k]) => !k.startsWith("challenge_")),
		);
		expect(ApprovalRequestView.safeParse(view).success).toBe(true);
		expect(ApprovalRequestView.safeParse(row).success).toBe(false);
	});
});

describe("managed_decisions", () => {
	const decision = (): ManagedDecisionRow => ({
		id: IDS.run_decision,
		approval_request_id: IDS.run_request,
		workspace_task_id: IDS.workspace_task,
		kind: "run",
		action: "approve",
		operator_id: "operator:edward",
		idempotency_key: "idem-approve-0001",
		payload_hash: g.runPayloadHash,
		binding_hash: g.runBinding.hash,
		request_rev: 2,
		confirmation_text: "Edward",
		reason: null,
		boot_id: IDS.boot,
		session_generation: 1,
		managed_task_id: IDS.managed_task,
		result_envelope_hash: null,
		decided_at: "2026-10-02T00:01:00.000Z",
		response_status: 201,
		response_body: {
			contract: "agentcity.decision/v1",
			decision_id: IDS.run_decision,
			approval_request_id: IDS.run_request,
			workspace_task_id: IDS.workspace_task,
			kind: "run",
			action: "approve",
			operator_id: "operator:edward",
			decided_at: "2026-10-02T00:01:00.000Z",
			payload_hash: g.runPayloadHash,
			binding_hash: g.runBinding.hash,
			approval_request: { status: "approved", rev: 3 },
			workspace_task: { stage: "queued", rev: 4 },
			effects: {
				managed_task_id: IDS.managed_task,
				managed_task_state: "queued",
				result_envelope_hash: null,
			},
		},
	});
	test("valid receipt row; confirmation literal; 2xx only", () => {
		expect(ManagedDecisionRow.safeParse(decision()).success).toBe(true);
		expect(
			ManagedDecisionRow.safeParse({
				...decision(),
				confirmation_text: "edward",
			}).success,
		).toBe(false);
		expect(
			ManagedDecisionRow.safeParse({ ...decision(), response_status: 409 })
				.success,
		).toBe(false);
		expect(
			ManagedDecisionRow.safeParse({
				...decision(),
				challenge: "c".repeat(43),
			} as unknown).success,
		).toBe(false);
	});
});

describe("views and command bodies", () => {
	test("task view", () => {
		const { idempotency_key: _k, request_hash: _h, ...task } = taskRow();
		const view = {
			task,
			phase: "awaiting_run_approval",
			engine: {
				managed_task_id: IDS.managed_task,
				state: "draft",
				failure_kind: null,
				state_detail: null,
				cancel_requested_at: null,
				current_run_id: null,
				result_run_id: null,
				attempt_no: null,
				quarantined: false,
				rev: 1,
			},
			current_proposal: proposalRow(),
			approval_requests: [
				Object.fromEntries(
					Object.entries(runRequest()).filter(
						([k]) => !k.startsWith("challenge_"),
					),
				),
			],
			decisions: [],
			acceptance_validity: null, // v1.2: required-nullable (null = nothing accepted)
		};
		expect(WorkspaceTaskView.safeParse(view).success).toBe(true);
		// v1.2: the field is required (a view without it is a contract violation)
		const { acceptance_validity: _v, ...without } = view;
		expect(WorkspaceTaskView.safeParse(without).success).toBe(false);
	});
	test("command bodies are strict", () => {
		expect(
			CreateWorkspaceTaskRequest.safeParse({
				idempotency_key: "create-task-0001",
				repo_id: FIXTURE_REPO,
				draft: sampleDraft(),
			}).success,
		).toBe(true);
		expect(
			CreateWorkspaceTaskRequest.safeParse({
				idempotency_key: "create-task-0001",
				repo_id: FIXTURE_REPO,
				draft: sampleDraft(),
				base_sha: "a".repeat(40),
			}).success,
		).toBe(false);
		expect(
			SaveDraftRequest.safeParse({ expected_rev: 1, draft: sampleDraft() })
				.success,
		).toBe(true);
		expect(PublishProposalRequest.safeParse({ expected_rev: 1 }).success).toBe(
			true,
		);
		expect(
			PublishProposalRequest.safeParse({
				expected_rev: 1,
				draft: sampleDraft(),
			}).success,
		).toBe(false);
		expect(
			RequestRerunRequest.safeParse({
				expected_rev: 1,
				proposal_id: IDS.proposal_v1,
			}).success,
		).toBe(true);
		expect(
			CancelRequest.safeParse({ expected_rev: 1, force: true }).success,
		).toBe(false);
		expect(sha256Hex("x")).toHaveLength(64);
	});
});
