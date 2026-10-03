// Result envelope (agentcity.result/v1) and evidence status (web-safe). The envelope binds Gate 2
// to one exact attempt + candidate + manifest + full review + every artifact's identity, as seen
// by ONE verified read of the stored bytes (role 06 seals it). Per-item evidence status is INSIDE
// the hash: Gate-2 revalidation re-seals from fresh verified reads and compares envelope hashes, so
// any change — bytes, rows, review, status — is one mismatch.
//
// `eligible` is never stored: resultEligibility() derives it, and nothing defaults it to true.
// Delta v1.2 (CONTRACT_V1_2.md §A): ResultEnvelopeV1_2 adds `criterion_coverage`, derived by the pure
// deriveCriterionCoverage(); resultEligibilityV1_2(envelope, proposal) is the full v1.2 rule.
import { z } from "zod";
import {
	ArtifactKind,
	ExecutionMode,
	FindingSeverity,
	ManagedProvider,
} from "../managed.ts";
import {
	ArtifactId,
	DecisionId,
	ManagedTaskId,
	ProposalId,
	ReviewId,
	RunId,
	WorkspaceTaskId,
} from "./ids.ts";
import {
	CheckId,
	Hash,
	hasDuplicates,
	isStrictlySorted,
	Sha,
} from "./primitives.ts";
import {
	type AnyProposalSnapshot,
	CRITERIA_MAX_ITEMS,
	CRITERION_CHECKS_MAX,
	CriterionId,
	isProposalV1_2,
	M1_EXECUTION_MODE,
	MaxRepairs,
	RESULT_CONTRACT,
	RESULT_CONTRACT_V1_2,
	REVIEW_RECORD_CONTRACT,
} from "./proposal.ts";

// ── evidence status ────────────────────────────────────────────────────────

/**
 * verified  — full stored bytes read once, match row sha256 + byte_len, bound to this candidate
 *             (and, for manifest-referenced items, to the manifest); not truncated.
 * truncated — verified bytes, but the content is a truncated capture.
 * withheld  — verified bytes that cannot be safely disclosed (redaction failed closed).
 * missing   — expected item has no row or no file.
 * corrupt   — bytes/row disagree, symlink/FIFO/special file, unreadable, or manifest link broken.
 * stale     — bound to a different candidate / manifest / attempt than this envelope.
 * unknown   — could not be determined.
 * Only `verified` (and, where the per-kind policy allows, `truncated` / `withheld`) is acceptable.
 * Nothing normalizes unknown/missing/corrupt/stale to success.
 */
export const EvidenceStatus = z.enum([
	"verified",
	"truncated",
	"withheld",
	"missing",
	"corrupt",
	"stale",
	"unknown",
]);
export type EvidenceStatus = z.infer<typeof EvidenceStatus>;

/** Worst first; overall status = the worst unacceptable item, else `verified`. */
export const EVIDENCE_STATUS_SEVERITY: readonly EvidenceStatus[] = [
	"corrupt",
	"stale",
	"missing",
	"unknown",
	"withheld",
	"truncated",
	"verified",
];

/**
 * Per artifact kind: is it required for acceptance, and which statuses are acceptable.
 * Required: manifest, diff, review output (verified, never truncated) and every verification log
 * named by the manifest (bytes must verify; a truncated log capture is acceptable — the check
 * outcome is in the manifest). Optional diagnostics may be truncated or withheld but never
 * missing/corrupt/stale/unknown.
 */
export const ARTIFACT_POLICY: Readonly<
	Record<
		ArtifactKind,
		{ required: boolean; acceptable: readonly EvidenceStatus[] }
	>
> = {
	manifest: { required: true, acceptable: ["verified"] },
	diff: { required: true, acceptable: ["verified"] },
	review_output: { required: true, acceptable: ["verified"] },
	verification_log: { required: true, acceptable: ["verified", "truncated"] },
	review_log: {
		required: false,
		acceptable: ["verified", "truncated", "withheld"],
	},
	implementation_log: {
		required: false,
		acceptable: ["verified", "truncated", "withheld"],
	},
	changed_files: {
		required: false,
		acceptable: ["verified", "truncated", "withheld"],
	},
};

/** Artifact file names the engine writes (orchestrator.ts / evidence.ts). */
export const MANIFEST_ARTIFACT_NAME = "manifest.json";
export const DIFF_ARTIFACT_NAME = "diff.patch";
export const REVIEW_OUTPUT_ARTIFACT_NAME = "review-output.json";
export const verificationLogName = (index: number, check: string): string =>
	`verify-${index + 1}-${check}.log`;

const ArtifactName = z
	.string()
	.regex(/^[A-Za-z0-9._-]{1,80}$/, "artifact name");

/**
 * One artifact of the result attempt. A `missing` item (expected but absent) has null identity
 * fields; every other item carries the row identity that was verified.
 */
export const EnvelopeArtifact = z
	.strictObject({
		name: ArtifactName,
		kind: ArtifactKind,
		status: EvidenceStatus,
		artifact_id: ArtifactId.nullable(),
		sha256: Hash.nullable(),
		byte_len: z
			.number()
			.int()
			.nonnegative()
			.max(Number.MAX_SAFE_INTEGER)
			.nullable(),
		truncated: z.boolean().nullable(),
	})
	.superRefine((a, ctx) => {
		const absent = a.artifact_id === null;
		if (
			absent !==
			(a.sha256 === null && a.byte_len === null && a.truncated === null)
		)
			ctx.addIssue({
				code: "custom",
				message: "identity fields are all null (missing) or all set",
			});
		if (absent !== (a.status === "missing"))
			ctx.addIssue({
				code: "custom",
				message: "status is `missing` exactly when the item has no row",
			});
		if (a.status === "verified" && a.truncated !== false)
			ctx.addIssue({
				code: "custom",
				message: "a truncated capture is `truncated`, not `verified`",
			});
		if (a.status === "truncated" && a.truncated !== true)
			ctx.addIssue({
				code: "custom",
				message: "`truncated` status needs a truncated row",
			});
	});
export type EnvelopeArtifact = z.infer<typeof EnvelopeArtifact>;

/**
 * One verification result from the verified manifest, in manifest order. argv is deliberately
 * absent (absolute host paths; it is bound through manifest_hash). Its log is the artifact
 * `verificationLogName(index, name)`.
 */
export const EnvelopeCheck = z.strictObject({
	name: CheckId,
	completed: z.boolean(),
	timed_out: z.boolean(),
	exit_code: z.number().int().min(-2_147_483_648).max(2_147_483_647).nullable(),
	duration_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	log_sha256: Hash,
	log_truncated: z.boolean(),
});
export type EnvelopeCheck = z.infer<typeof EnvelopeCheck>;

/** Same rule as managed.ts `verificationPassed`, per check. */
export const checkPassed = (c: EnvelopeCheck): boolean =>
	c.completed && !c.timed_out && c.exit_code === 0;

/**
 * A finding as STORED on a review row. Looser text bounds than managed.ts `Finding` because the
 * engine redacts after validating, and redaction can lengthen text; still bounded and strict.
 */
export const RecordedFinding = z.strictObject({
	severity: FindingSeverity,
	title: z.string().max(8192),
	detail: z.string().max(8192),
	file: z.string().max(8192).nullable(),
	line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
	actionable: z.boolean(),
});
export type RecordedFinding = z.infer<typeof RecordedFinding>;

/**
 * Hash preimage of one managed_reviews row (review_hash). Excluded: `usage` (provider-shaped,
 * may hold non-integer numbers the canonical encoder rejects), `session_ref` (provider handle),
 * `created_at` (row metadata). The raw review output bytes are bound separately as the
 * review_output artifact.
 */
export const ReviewRecord = z.strictObject({
	contract: z.literal(REVIEW_RECORD_CONTRACT),
	review_id: ReviewId,
	managed_task_id: ManagedTaskId,
	run_id: RunId,
	provider: ManagedProvider,
	mode: ExecutionMode,
	model_requested: z.string().nullable(),
	model_resolved: z.string().nullable(),
	candidate_sha: Sha,
	manifest_hash: Hash,
	verdict: z.enum(["approve", "reject"]).nullable(),
	valid: z.boolean(),
	invalidated_reason: z.string().nullable(),
	findings: z.array(RecordedFinding).max(50),
	summary: z.string().nullable(),
});
export type ReviewRecord = z.infer<typeof ReviewRecord>;

export const EnvelopeReview = z.strictObject({
	review_id: ReviewId,
	review_hash: Hash,
	verdict: z.enum(["approve", "reject"]).nullable(),
	valid: z.boolean(),
	candidate_sha: Sha,
	manifest_hash: Hash,
	findings: z.number().int().nonnegative().max(50),
	/** Findings with severity blocker|major. */
	blocking_findings: z.number().int().nonnegative().max(50),
});
export type EnvelopeReview = z.infer<typeof EnvelopeReview>;

/** What actually ran, as recorded on the run / review rows (null = not reported, never guessed). */
export const ProviderProvenance = z.strictObject({
	provider: ManagedProvider,
	mode: ExecutionMode,
	model_requested: z.string().nullable(),
	model_resolved: z.string().nullable(),
});
export type ProviderProvenance = z.infer<typeof ProviderProvenance>;

/** Envelope fields after `contract` (identical in v1 and v1.2; shape order kept). */
const ENVELOPE_FIELDS = {
	workspace_task_id: WorkspaceTaskId,
	proposal_id: ProposalId,
	proposal_hash: Hash,
	execution_binding_hash: Hash,
	/** The Gate-1 decision that authorized this execution. */
	run_decision_id: DecisionId,
	managed_task_id: ManagedTaskId,
	run_id: RunId,
	/** 1 = initial attempt, 2 = the single pre-approved repair. */
	attempt_no: z.union([z.literal(1), z.literal(2)]),
	max_repairs: MaxRepairs,
	base_sha: Sha,
	parent_sha: Sha,
	candidate_sha: Sha,
	candidate_tree: Sha,
	manifest_hash: Hash,
	execution_mode: z.literal(M1_EXECUTION_MODE),
	policy_hash: Hash,
	/** Copied from the proposal's verification_plan (also bound via proposal_hash). */
	required_checks: z.array(CheckId).min(1).max(10),
	/** Sorted by name (UTF-16 code units), unique. */
	artifacts: z.array(EnvelopeArtifact).min(1).max(64),
	verification: z.array(EnvelopeCheck).max(10),
	review: EnvelopeReview,
	provenance: z.strictObject({
		implementer: ProviderProvenance,
		reviewer: ProviderProvenance,
	}),
	/** Must equal overallEvidenceStatus(this) — stored for display, re-derived for decisions. */
	evidence_status: EvidenceStatus,
} as const;

type EnvelopeCore = {
	artifacts: EnvelopeArtifact[];
	required_checks: string[];
	attempt_no: 1 | 2;
	max_repairs: 0 | 1;
	parent_sha: string;
	base_sha: string;
	evidence_status: EvidenceStatus;
	verification: EnvelopeCheck[];
};

const envelopeInvariants = (e: EnvelopeCore, ctx: z.RefinementCtx): void => {
	const issue = (path: string, message: string) =>
		ctx.addIssue({ code: "custom", path: [path], message });
	const names = e.artifacts.map((a) => a.name);
	if (!isStrictlySorted(names))
		issue("artifacts", "artifacts must be sorted by name and unique");
	if (hasDuplicates(e.required_checks))
		issue("required_checks", "duplicate check id");
	if (e.attempt_no > 1 + e.max_repairs)
		issue("attempt_no", "attempt exceeds the approved repair policy");
	if (e.attempt_no === 1 && e.parent_sha !== e.base_sha)
		issue("parent_sha", "the initial attempt starts from base_sha");
	if (e.evidence_status !== overallEvidenceStatus(e))
		issue("evidence_status", "does not match the items");
};

export const ResultEnvelope = z
	.strictObject({
		contract: z.literal(RESULT_CONTRACT),
		...ENVELOPE_FIELDS,
	})
	.superRefine(envelopeInvariants);
export type ResultEnvelope = z.infer<typeof ResultEnvelope>;

// ── criterion coverage (contract delta v1.2, CONTRACT_V1_2.md §A) ──────────

/**
 * Outcome of one mapped check, from the manifest verification results:
 * passed     ⇔ completed ∧ ¬timed_out ∧ exit 0;
 * failed     ⇔ completed ∧ exit ≠ 0 (a null exit code is not an exit code ≠ 0 → incomplete);
 * incomplete otherwise — also when several results carry the same name (ambiguous, never passed);
 * missing    ⇔ no verification result of that name.
 */
export const CheckOutcome = z.enum([
	"passed",
	"failed",
	"incomplete",
	"missing",
]);
export type CheckOutcome = z.infer<typeof CheckOutcome>;

/**
 * satisfied   ⇔ every mapped check passed AND has log evidence;
 * unsatisfied ⇔ any mapped check failed;
 * unresolved  otherwise (incomplete, missing, or passed without log evidence).
 */
export const CriterionStatus = z.enum([
	"satisfied",
	"unsatisfied",
	"unresolved",
]);
export type CriterionStatus = z.infer<typeof CriterionStatus>;

/**
 * One mapped check of a criterion. `log_artifact_id` / `log_sha256` = the identity of the check's
 * log item `verify-N-<check>.log` (N = 1 + its index in `verification`) from the envelope's own
 * artifact list, set only when that item is present with status verified or truncated; else null.
 */
export const CoverageCheck = z
	.strictObject({
		check: CheckId,
		outcome: CheckOutcome,
		log_artifact_id: ArtifactId.nullable(),
		log_sha256: Hash.nullable(),
	})
	.refine(
		(c) => (c.log_artifact_id === null) === (c.log_sha256 === null),
		"log identity fields are both null or both set",
	);
export type CoverageCheck = z.infer<typeof CoverageCheck>;

export const CriterionCoverage = z
	.strictObject({
		criterion_id: CriterionId,
		status: CriterionStatus,
		/** The proposal's coverage_plan checks of this criterion (sorted, unique). */
		checks: z.array(CoverageCheck).min(1).max(CRITERION_CHECKS_MAX),
	})
	.refine(
		(c) => isStrictlySorted(c.checks.map((x) => x.check)),
		"checks must be sorted and unique",
	);
export type CriterionCoverage = z.infer<typeof CriterionCoverage>;

/** Outcome + log identity of one check name against the envelope's verification + artifacts. */
export function coverageCheckFor(
	check: string,
	e: Pick<ResultEnvelope, "verification" | "artifacts">,
): CoverageCheck {
	const at: number[] = [];
	e.verification.forEach((v, i) => {
		if (v.name === check) at.push(i);
	});
	const none = { log_artifact_id: null, log_sha256: null };
	if (at.length === 0) return { check, outcome: "missing", ...none };
	if (at.length > 1) return { check, outcome: "incomplete", ...none };
	const i = at[0] as number;
	const v = e.verification[i] as EnvelopeCheck;
	const outcome: CheckOutcome = checkPassed(v)
		? "passed"
		: v.completed && v.exit_code !== null && v.exit_code !== 0
			? "failed"
			: "incomplete";
	const item = e.artifacts.find(
		(a) => a.name === verificationLogName(i, check),
	);
	const evidence =
		item !== undefined &&
		(item.status === "verified" || item.status === "truncated") &&
		item.artifact_id !== null &&
		item.sha256 !== null;
	return {
		check,
		outcome,
		log_artifact_id: evidence ? (item.artifact_id as string) : null,
		log_sha256: evidence ? (item.sha256 as string) : null,
	};
}

/** Criterion status from its mapped checks (rules on CriterionStatus). */
export function criterionStatusOf(
	checks: readonly CoverageCheck[],
): CriterionStatus {
	if (
		checks.length > 0 &&
		checks.every((c) => c.outcome === "passed" && c.log_artifact_id !== null)
	)
		return "satisfied";
	if (checks.some((c) => c.outcome === "failed")) return "unsatisfied";
	return "unresolved";
}

/**
 * The pure coverage derivation: for each proposal `coverage_plan` entry (proposal criteria order),
 * each mapped check's outcome from the manifest verification results and its log identity from the
 * envelope artifact items, then the criterion status. No I/O, no hashing; the envelope stores the
 * result (`criterion_coverage`, inside the envelope hash) and decisions re-derive it.
 */
export function deriveCriterionCoverage(
	plan: readonly { criterion_id: string; checks: readonly string[] }[],
	e: Pick<ResultEnvelope, "verification" | "artifacts">,
): CriterionCoverage[] {
	return plan.map((p) => {
		const checks = p.checks.map((c) => coverageCheckFor(c, e));
		return {
			criterion_id: p.criterion_id,
			status: criterionStatusOf(checks),
			checks,
		};
	});
}

/** Field-by-field equality of two coverage lists (order-sensitive; key order irrelevant). */
export function sameCoverage(
	a: readonly CriterionCoverage[],
	b: readonly CriterionCoverage[],
): boolean {
	return (
		a.length === b.length &&
		a.every((x, i) => {
			const y = b[i] as CriterionCoverage;
			return (
				x.criterion_id === y.criterion_id &&
				x.status === y.status &&
				x.checks.length === y.checks.length &&
				x.checks.every((c, k) => {
					const d = y.checks[k] as CoverageCheck;
					return (
						c.check === d.check &&
						c.outcome === d.outcome &&
						c.log_artifact_id === d.log_artifact_id &&
						c.log_sha256 === d.log_sha256
					);
				})
			);
		})
	);
}

/**
 * ResultEnvelope v1.2 (`agentcity.result/v1.2`): v1 fields plus `criterion_coverage` in proposal
 * criteria order. Coverage is inside the envelope hash (it names proposal criterion ids and artifact
 * identities that precede the envelope — no circularity). The schema re-derives every entry from
 * the envelope's own verification results + artifacts (like `evidence_status`); the binding to the
 * proposal's ids and plan is checked by `resultEligibilityV1_2(envelope, proposal)`.
 */
export const ResultEnvelopeV1_2 = z
	.strictObject({
		contract: z.literal(RESULT_CONTRACT_V1_2),
		...ENVELOPE_FIELDS,
		criterion_coverage: z
			.array(CriterionCoverage)
			.min(1)
			.max(CRITERIA_MAX_ITEMS),
	})
	.superRefine((e, ctx) => {
		envelopeInvariants(e, ctx);
		const issue = (message: string) =>
			ctx.addIssue({ code: "custom", path: ["criterion_coverage"], message });
		if (hasDuplicates(e.criterion_coverage.map((c) => c.criterion_id)))
			issue("duplicate criterion id");
		const required = new Set(e.required_checks);
		if (
			e.criterion_coverage.some((c) =>
				c.checks.some((x) => !required.has(x.check)),
			)
		)
			issue("a covered check is not in required_checks");
		const plan = e.criterion_coverage.map((c) => ({
			criterion_id: c.criterion_id,
			checks: c.checks.map((x) => x.check),
		}));
		if (!sameCoverage(deriveCriterionCoverage(plan, e), e.criterion_coverage))
			issue("does not match the verification results and artifacts");
	});
export type ResultEnvelopeV1_2 = z.infer<typeof ResultEnvelopeV1_2>;

/** Row parser: v1 | v1.2, discriminated by `contract`. */
export const AnyResultEnvelope = z.discriminatedUnion("contract", [
	ResultEnvelope,
	ResultEnvelopeV1_2,
]);
export type AnyResultEnvelope = z.infer<typeof AnyResultEnvelope>;

export const isResultV1_2 = (e: AnyResultEnvelope): e is ResultEnvelopeV1_2 =>
	e.contract === RESULT_CONTRACT_V1_2;

/** Names that must be present in `artifacts` for this envelope (required kinds). */
export function expectedRequiredArtifactNames(
	e: Pick<ResultEnvelope, "verification">,
): string[] {
	return [
		MANIFEST_ARTIFACT_NAME,
		DIFF_ARTIFACT_NAME,
		REVIEW_OUTPUT_ARTIFACT_NAME,
		...e.verification.map((c, i) => verificationLogName(i, c.name)),
	];
}

/** Worst unacceptable status across items (absent required items count as `missing`). */
export function overallEvidenceStatus(
	e: Pick<ResultEnvelope, "artifacts" | "verification">,
): EvidenceStatus {
	const bad: EvidenceStatus[] = [];
	for (const a of e.artifacts)
		if (!ARTIFACT_POLICY[a.kind].acceptable.includes(a.status))
			bad.push(a.status);
	const present = new Set(e.artifacts.map((a) => a.name));
	for (const name of expectedRequiredArtifactNames(e))
		if (!present.has(name)) bad.push("missing");
	for (const s of EVIDENCE_STATUS_SEVERITY) if (bad.includes(s)) return s;
	return "verified";
}

export const IneligibleReason = z.enum([
	"evidence_not_verified",
	"required_check_missing",
	"required_check_failed",
	"review_not_approving",
	"review_invalid",
	"review_binding_mismatch",
	"review_blocking_findings",
	"attempt_out_of_range",
	"not_simulated",
	// v1.2 (additive; CONTRACT_V1_2.md §A)
	/** The proposal is v1 (no criterion ids / coverage plan): a new proposal + Gate 1 is required. */
	"criteria_unmapped",
	/** A v1.2 proposal but the envelope carries no `criterion_coverage` (v1 envelope). */
	"coverage_missing",
	/** Coverage ids ≠ the proposal's criterion ids, or coverage ≠ its derivation from the plan. */
	"coverage_mismatch",
	/** A criterion is `unsatisfied` (a mapped check failed). */
	"criterion_unsatisfied",
	/** A criterion is `unresolved` (incomplete / missing check, or no log evidence). */
	"criterion_unresolved",
]);
export type IneligibleReason = z.infer<typeof IneligibleReason>;

export interface ResultEligibility {
	eligible: boolean;
	/** Re-derived from the items, never read from `envelope.evidence_status`. */
	evidence_status: EvidenceStatus;
	reasons: IneligibleReason[];
}

/**
 * Acceptance eligibility of a (schema-valid) envelope: every required evidence item verified,
 * every required check present and passed, and an approving, valid review with no blocking
 * findings bound to the same candidate + manifest. Live conditions (cancel pending, quarantine,
 * engine still human_ready, request rev) are checked by the decision transaction, not here.
 *
 * v1 envelopes: unchanged (the hub cannot produce v1.2 yet; its flows depend on this). v1.2
 * envelopes: additionally every `criterion_coverage` entry must be `satisfied`. The FULL v1.2 rule
 * (proposal v1.2, coverage present, ids = proposal ids, coverage = derivation from the plan) needs
 * the proposal: `resultEligibilityV1_2(envelope, proposal)`.
 */
export function resultEligibility(e: AnyResultEnvelope): ResultEligibility {
	const reasons: IneligibleReason[] = [];
	const evidence_status = overallEvidenceStatus(e);
	if (evidence_status !== "verified") reasons.push("evidence_not_verified");
	for (const name of e.required_checks) {
		const runs = e.verification.filter((c) => c.name === name);
		if (runs.length !== 1) reasons.push("required_check_missing");
		else if (!checkPassed(runs[0] as EnvelopeCheck))
			reasons.push("required_check_failed");
	}
	if (e.review.verdict !== "approve") reasons.push("review_not_approving");
	if (!e.review.valid) reasons.push("review_invalid");
	if (
		e.review.candidate_sha !== e.candidate_sha ||
		e.review.manifest_hash !== e.manifest_hash
	)
		reasons.push("review_binding_mismatch");
	if (e.review.blocking_findings > 0) reasons.push("review_blocking_findings");
	if (e.attempt_no > 1 + e.max_repairs) reasons.push("attempt_out_of_range");
	for (const p of [e.provenance.implementer, e.provenance.reviewer])
		if (p.provider !== "fake" || p.mode !== "simulated")
			reasons.push("not_simulated");
	if (isResultV1_2(e))
		reasons.push(...coverageStatusReasons(e.criterion_coverage));
	const unique = [...new Set(reasons)];
	return { eligible: unique.length === 0, evidence_status, reasons: unique };
}

const coverageStatusReasons = (
	coverage: readonly CriterionCoverage[],
): IneligibleReason[] => {
	const out: IneligibleReason[] = [];
	for (const c of coverage) {
		if (c.status === "unsatisfied") out.push("criterion_unsatisfied");
		if (c.status === "unresolved") out.push("criterion_unresolved");
	}
	return out;
};

/**
 * The v1.2 acceptance rule (CONTRACT_V1_2.md §A): everything `resultEligibility` requires, plus a
 * v1.2 proposal (else `criteria_unmapped` — a legacy proposal needs a new proposal + Gate 1), a v1.2
 * envelope (else `coverage_missing`), coverage criterion ids = the proposal's criterion ids exactly
 * (same order) and coverage = `deriveCriterionCoverage(proposal.coverage_plan, envelope)` (else
 * `coverage_mismatch`), and every criterion `satisfied`. `proposal` must be the snapshot the
 * envelope's `proposal_hash` names (the caller loads it by that binding). Not yet called by the hub
 * (lead integration once results are sealed as v1.2).
 */
export function resultEligibilityV1_2(
	e: AnyResultEnvelope,
	proposal: AnyProposalSnapshot,
): ResultEligibility {
	const base = resultEligibility(e);
	const reasons = [...base.reasons];
	if (!isProposalV1_2(proposal)) reasons.push("criteria_unmapped");
	else if (!isResultV1_2(e)) reasons.push("coverage_missing");
	else {
		const ids = proposal.criteria.map((c) => c.id);
		const covered = e.criterion_coverage.map((c) => c.criterion_id);
		const derived = deriveCriterionCoverage(proposal.coverage_plan, e);
		if (
			e.proposal_id !== proposal.proposal_id ||
			ids.length !== covered.length ||
			ids.some((id, i) => covered[i] !== id) ||
			!sameCoverage(derived, e.criterion_coverage)
		)
			reasons.push("coverage_mismatch");
		reasons.push(...coverageStatusReasons(derived));
	}
	const unique = [...new Set(reasons)];
	return {
		eligible: unique.length === 0,
		evidence_status: base.evidence_status,
		reasons: unique,
	};
}
