// Deterministic sample of the contract delta v1.2 structures (CONTRACT_V1_2.md §A), built through
// the real builders (Bun-only: imports ../hash.ts). Reuses the frozen v1 sample's synthetic ids,
// shas and draft text (sample.ts is unchanged); adds a criterion → check mapping and a second
// trusted check. vectors-v1.2.json freezes the canonical strings and sha256 of every structure
// built here; fixtures/vectors.json (v1) is not touched.
import {
	buildProposalSnapshotV1_2,
	reviewRecordHash,
	sealExecutionBinding,
	sealProposal,
	sealResultEnvelope,
} from "../hash.ts";
import {
	deriveCriterionCoverage,
	type EnvelopeArtifact,
	overallEvidenceStatus,
	type ProposalDraft,
	RESULT_CONTRACT_V1_2,
	type ResultEnvelopeV1_2,
	type WorkspaceDraft,
} from "../index.ts";
import { FIXTURE_REPO, IDS, SHAS, sampleDraft, sampleGraph } from "./sample.ts";

export const IDS_V1_2 = {
	proposal: "wsp-22222222-2222-4222-8222-222222222223",
} as const;

/** Trusted config order of the v1.2 sample repo (two checks so a criterion can need both). */
export const REQUIRED_CHECKS_V1_2 = ["unit", "lint"] as const;

/**
 * The frozen v1 sample draft plus a complete mapping. Entries are deliberately NOT in criteria
 * order and one lists its checks unsorted: the builder orders the plan by criteria and sorts checks.
 */
export function sampleDraftV1_2(): WorkspaceDraft {
	const d = sampleDraft();
	const [a, b, c] = d.criteria as [string, string, string];
	return {
		...d,
		criterion_checks: [
			{ criterion: c, checks: ["unit"] },
			{ criterion: a, checks: ["unit"] },
			{ criterion: b, checks: ["unit", "lint"] },
		],
	};
}

export function sampleProposalV1_2(draft: ProposalDraft = sampleDraftV1_2()) {
	const res = buildProposalSnapshotV1_2({
		proposal_id: IDS_V1_2.proposal,
		workspace_task_id: IDS.workspace_task,
		version: 1,
		predecessor_proposal_id: null,
		repo_id: FIXTURE_REPO,
		base_ref: "main",
		base_sha: SHAS.base,
		required_checks: REQUIRED_CHECKS_V1_2,
		draft,
	});
	if (!res.ok) throw new Error(JSON.stringify(res.issues));
	return sealProposal(res.snapshot);
}

const art = (
	n: number,
	name: string,
	kind: EnvelopeArtifact["kind"],
	truncated = false,
): EnvelopeArtifact => ({
	name,
	kind,
	status: truncated ? "truncated" : "verified",
	artifact_id: IDS.art(n),
	sha256: SHAS.art(n),
	byte_len: 100 + n,
	truncated,
});

export function sampleGraphV1_2() {
	const proposal = sampleProposalV1_2();
	const execution = sealExecutionBinding({
		proposal_id: IDS_V1_2.proposal,
		proposal_hash: proposal.hash,
		managed_task_id: IDS.managed_task,
		base_sha: SHAS.base,
		policy_hash: SHAS.policy,
	});
	const review = sampleGraph().review;
	const artifacts: EnvelopeArtifact[] = [
		art(1, "changed-files.json", "changed_files"),
		art(2, "diff.patch", "diff"),
		art(3, "implementation.log", "implementation_log", true),
		art(4, "manifest.json", "manifest"),
		art(5, "review-output.json", "review_output"),
		art(6, "review.log", "review_log"),
		art(7, "verify-1-unit.log", "verification_log"),
		// a truncated log capture still counts as log evidence (verified bytes, outcome in manifest)
		art(8, "verify-2-lint.log", "verification_log", true),
	];
	const verification: ResultEnvelopeV1_2["verification"] = [
		{
			name: "unit",
			completed: true,
			timed_out: false,
			exit_code: 0,
			duration_ms: 1234,
			log_sha256: SHAS.art(7),
			log_truncated: false,
		},
		{
			name: "lint",
			completed: true,
			timed_out: false,
			exit_code: 0,
			duration_ms: 321,
			log_sha256: SHAS.art(8),
			log_truncated: true,
		},
	];
	const coverage = deriveCriterionCoverage(proposal.value.coverage_plan, {
		verification,
		artifacts,
	});
	const envelope: ResultEnvelopeV1_2 = {
		contract: RESULT_CONTRACT_V1_2,
		workspace_task_id: IDS.workspace_task,
		proposal_id: IDS_V1_2.proposal,
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
		required_checks: [...REQUIRED_CHECKS_V1_2],
		artifacts,
		verification,
		review: {
			review_id: IDS.review,
			review_hash: reviewRecordHash(review),
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
		criterion_coverage: coverage,
	};
	envelope.evidence_status = overallEvidenceStatus(envelope);
	const result = sealResultEnvelope(envelope);
	return { proposal, execution, coverage, result };
}
