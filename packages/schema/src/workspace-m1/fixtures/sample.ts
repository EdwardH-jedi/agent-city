// Deterministic sample of the whole workspace hash graph, built through the real builders (Bun-only:
// imports ../hash.ts). Synthetic ids/shas only; the repo is the disposable `local/fixture`; the
// challenge token is an obvious placeholder that matches no secret pattern. vectors.json freezes
// the canonical strings and sha256 of every structure built here.
import {
	challengeHash,
	decisionPayloadHash,
	reviewRecordHash,
	sealExecutionBinding,
	sealProposal,
	sealResultApprovalBinding,
	sealResultEnvelope,
	sealRunApprovalBinding,
} from "../hash.ts";
import {
	buildProposalSnapshot,
	DECISION_CONTRACT,
	type DecisionPayload,
	type ProposalDraft,
	RESULT_CONTRACT,
	REVIEW_RECORD_CONTRACT,
	type ResultEnvelope,
	type ReviewRecord,
	type WorkspaceDraft,
} from "../index.ts";

const rep = (pair: string, n: number) => pair.repeat(n);

export const IDS = {
	workspace_task: "wst-11111111-1111-4111-8111-111111111111",
	proposal_v1: "wsp-22222222-2222-4222-8222-222222222221",
	proposal_v2: "wsp-22222222-2222-4222-8222-222222222222",
	run_request: "wsa-33333333-3333-4333-8333-333333333331",
	result_request: "wsa-33333333-3333-4333-8333-333333333332",
	run_decision: "wsd-44444444-4444-4444-8444-444444444441",
	result_decision: "wsd-44444444-4444-4444-8444-444444444442",
	managed_task: "task-55555555-5555-4555-8555-555555555555",
	run_initial: "run-66666666-6666-4666-8666-666666666661",
	run_repair: "run-66666666-6666-4666-8666-666666666662",
	review: "rev-88888888-8888-4888-8888-888888888888",
	boot: "boot-99999999-9999-4999-8999-999999999999",
	art: (n: number) => `art-77777777-7777-4777-8777-77777777777${n}`,
} as const;

export const SHAS = {
	base: rep("a1", 20),
	first_candidate: rep("b2", 20),
	candidate: rep("c3", 20),
	tree: rep("d4", 20),
	policy: rep("e5", 32),
	manifest: rep("f6", 32),
	art: (n: number) => rep(`0${n}`, 32),
} as const;

export const FIXTURE_REPO = "local/fixture";
export const FIXTURE_CHALLENGE_TOKEN =
	"fixture-challenge-token-0000000000000000000";

export const sampleDraft = (): WorkspaceDraft => ({
	title: "  Add a greeting, politely  ",
	objective:
		"Print a greeting from the CLI.\r\nKeep the output stable:\n\t- one line\n\t- no colour",
	criteria: [
		'Prints "hello, world" (comma included)',
		"Exit code stays 0, even on empty input",
		"Handles naïve café input — ünïcode, 日本語, 😀",
	],
	scope: { allowed: ["src", "test"], protected: ["config"] },
	execution_mode: "simulated",
	simulation_scenario: "reject_then_approve",
	repair_policy: { max_repairs: 1 },
});

export function sampleProposal(
	version: 1 | 2 = 1,
	draft: ProposalDraft = sampleDraft(),
) {
	const res = buildProposalSnapshot({
		proposal_id: version === 1 ? IDS.proposal_v1 : IDS.proposal_v2,
		workspace_task_id: IDS.workspace_task,
		version,
		predecessor_proposal_id: version === 1 ? null : IDS.proposal_v1,
		repo_id: FIXTURE_REPO,
		base_ref: "main",
		base_sha: SHAS.base,
		required_checks: ["unit"],
		draft,
	});
	if (!res.ok) throw new Error(JSON.stringify(res.issues));
	return sealProposal(res.snapshot);
}

export function sampleGraph() {
	const proposal = sampleProposal(1);
	const execution = sealExecutionBinding({
		proposal_id: IDS.proposal_v1,
		proposal_hash: proposal.hash,
		managed_task_id: IDS.managed_task,
		base_sha: SHAS.base,
		policy_hash: SHAS.policy,
	});
	const runBinding = sealRunApprovalBinding({
		approval_request_id: IDS.run_request,
		workspace_task_id: IDS.workspace_task,
		proposal_id: IDS.proposal_v1,
		proposal_hash: proposal.hash,
		execution_binding_hash: execution.hash,
	});
	const review: ReviewRecord = {
		contract: REVIEW_RECORD_CONTRACT,
		review_id: IDS.review,
		managed_task_id: IDS.managed_task,
		run_id: IDS.run_repair,
		provider: "fake",
		mode: "simulated",
		model_requested: null,
		model_resolved: null,
		candidate_sha: SHAS.candidate,
		manifest_hash: SHAS.manifest,
		verdict: "approve",
		valid: true,
		invalidated_reason: null,
		findings: [
			{
				severity: "minor",
				title: "Greeting could mention the date",
				detail: "Optional, not required by any criterion.",
				file: "src/greet.ts",
				line: 3,
				actionable: false,
			},
		],
		summary: "Simulated review: approve.",
	};
	const review_hash = reviewRecordHash(review);
	const art = (
		n: number,
		name: string,
		kind: ResultEnvelope["artifacts"][number]["kind"],
		truncated = false,
	) => ({
		name,
		kind,
		status: truncated ? ("truncated" as const) : ("verified" as const),
		artifact_id: IDS.art(n),
		sha256: SHAS.art(n),
		byte_len: 100 + n,
		truncated,
	});
	const envelope: ResultEnvelope = {
		contract: RESULT_CONTRACT,
		workspace_task_id: IDS.workspace_task,
		proposal_id: IDS.proposal_v1,
		proposal_hash: proposal.hash,
		execution_binding_hash: execution.hash,
		run_decision_id: IDS.run_decision,
		managed_task_id: IDS.managed_task,
		run_id: IDS.run_repair,
		attempt_no: 2,
		max_repairs: 1,
		base_sha: SHAS.base,
		parent_sha: SHAS.first_candidate,
		candidate_sha: SHAS.candidate,
		candidate_tree: SHAS.tree,
		manifest_hash: SHAS.manifest,
		execution_mode: "simulated",
		policy_hash: SHAS.policy,
		required_checks: ["unit"],
		artifacts: [
			art(1, "changed-files.json", "changed_files"),
			art(2, "diff.patch", "diff"),
			art(3, "implementation.log", "implementation_log", true),
			art(4, "manifest.json", "manifest"),
			art(5, "review-output.json", "review_output"),
			art(6, "review.log", "review_log"),
			art(7, "verify-1-unit.log", "verification_log"),
		],
		verification: [
			{
				name: "unit",
				completed: true,
				timed_out: false,
				exit_code: 0,
				duration_ms: 1234,
				log_sha256: SHAS.art(7),
				log_truncated: false,
			},
		],
		review: {
			review_id: IDS.review,
			review_hash,
			verdict: "approve",
			valid: true,
			candidate_sha: SHAS.candidate,
			manifest_hash: SHAS.manifest,
			findings: 1,
			blocking_findings: 0,
		},
		provenance: {
			implementer: {
				provider: "fake",
				mode: "simulated",
				model_requested: null,
				model_resolved: null,
			},
			reviewer: {
				provider: "fake",
				mode: "simulated",
				model_requested: null,
				model_resolved: null,
			},
		},
		evidence_status: "verified",
	};
	const result = sealResultEnvelope(envelope);
	const resultBinding = sealResultApprovalBinding({
		approval_request_id: IDS.result_request,
		workspace_task_id: IDS.workspace_task,
		managed_task_id: IDS.managed_task,
		run_id: IDS.run_repair,
		result_envelope_hash: result.hash,
	});
	const runPayload: DecisionPayload = {
		contract: DECISION_CONTRACT,
		approval_request_id: IDS.run_request,
		kind: "run",
		action: "approve",
		expected_request_rev: 2,
		binding_hash: runBinding.hash,
		confirmation_text: "Edward",
		reason: null,
	};
	const resultPayload: DecisionPayload = {
		contract: DECISION_CONTRACT,
		approval_request_id: IDS.result_request,
		kind: "result",
		action: "request_changes",
		expected_request_rev: 4,
		binding_hash: resultBinding.hash,
		confirmation_text: null,
		reason: "Please also cover the empty-input case, with a test.",
	};
	const challenge = {
		token: FIXTURE_CHALLENGE_TOKEN,
		approval_request_id: IDS.run_request,
		kind: "run" as const,
		binding_hash: runBinding.hash,
		request_rev: 2,
		operator_id: "operator:edward" as const,
		session_generation: 1,
		boot_id: IDS.boot,
		expires_at: "2026-10-02T00:05:00.000Z",
	};
	return {
		proposal,
		execution,
		runBinding,
		review,
		review_hash,
		result,
		resultBinding,
		runPayload,
		runPayloadHash: decisionPayloadHash(runPayload),
		resultPayload,
		resultPayloadHash: decisionPayloadHash(resultPayload),
		challenge,
		challengeHash: challengeHash(challenge),
	};
}
