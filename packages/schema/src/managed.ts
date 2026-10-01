// Managed-run contracts (v1). A managed task is an explicit, authorized attempt at a bounded task in
// one allowed repo: Agent City owns its input, workspace, provider invocation, evidence and review.
// Field names are snake_case and match migrations/006_managed_runs.sql 1:1 (JSON columns are parsed
// at the hub boundary). Timestamps are ISO-8601 UTC strings.
//
// Not the same thing as an observed Session (types.ts): nothing here is derived from telemetry.
import { z } from "zod";

export const MANAGED_CONTRACT = "agentcity.managed/v1";
export const IMPLEMENTATION_CONTRACT = "agentcity.implementation/v1";
export const REVIEW_CONTRACT = "agentcity.review/v1";
export const EVIDENCE_CONTRACT = "agentcity.evidence/v1";

/**
 * Has the live path (real Claude implement + real Codex review) ever been run end to end and
 * checked by a person? It has not: the CLI adapters are only tested against stub executables.
 * While this is false the UI labels every live result "integration not live-verified".
 */
export const LIVE_INTEGRATION_VERIFIED = false;

/** Automatic repair cycles per lineage. Default 1 in this milestone; never above the max. */
export const DEFAULT_REPAIR_LIMIT = 1;
export const MAX_REPAIR_LIMIT = 3;

const Ts = z.iso.datetime({ offset: true });
const Sha = z.string().regex(/^[0-9a-f]{40}$/, "40-hex commit sha");
const Hash = z.string().regex(/^[0-9a-f]{64}$/, "sha256 hex");

export const TaskState = z.enum([
	"draft",
	"queued",
	"executing",
	"verifying",
	"reviewing",
	"repairing",
	"human_ready",
	"failed",
	"blocked",
	"cancelled",
	"interrupted",
]);
export type TaskState = z.infer<typeof TaskState>;

/** `simulated` = deterministic fake adapters, never a model. `live` = real CLI providers. */
export const ExecutionMode = z.enum(["simulated", "live"]);
export type ExecutionMode = z.infer<typeof ExecutionMode>;

/** What the fake adapters do. Only meaningful (and only allowed) in simulated mode. */
export const SimulationScenario = z.enum([
	"approve",
	"reject_then_approve",
	"reject_always",
	"malformed_review",
	"reviewer_error",
	"review_wrong_candidate",
	"reviewer_mutates",
	"verification_fails",
	"verification_fails_then_fixed",
	"no_changes",
	"out_of_scope",
	"impl_hangs",
]);
export type SimulationScenario = z.infer<typeof SimulationScenario>;

export const FailureKind = z.enum([
	// the tool could not run → task `blocked`
	"provider_unavailable",
	"provider_auth",
	"provider_quota",
	"provider_model",
	"verification_unavailable",
	"verification_missing",
	"approval_void",
	"repo_invalid",
	"workspace_error",
	// the attempt ran and did not pass → task `failed`
	"provider_error",
	"provider_output_invalid",
	"timeout",
	"no_changes",
	"scope_violation",
	"candidate_mutated",
	// stored evidence bytes no longer match what was recorded/hashed
	"evidence_invalid",
	"verification_failed",
	"review_invalid",
	"review_rejected",
	"repair_limit_exhausted",
	"internal_error",
	// lifecycle
	"interrupted",
	"cancelled",
]);
export type FailureKind = z.infer<typeof FailureKind>;

export const RunState = z.enum([
	"running",
	"finished",
	"failed",
	"cancelled",
	"unknown",
]);
export type RunState = z.infer<typeof RunState>;

export const RunPhase = z.enum(["implement", "verify", "review", "done"]);
export type RunPhase = z.infer<typeof RunPhase>;

export const RunKind = z.enum(["initial", "repair", "rerun"]);
export type RunKind = z.infer<typeof RunKind>;

export const ManagedProvider = z.enum(["fake", "claude", "codex"]);
export type ManagedProvider = z.infer<typeof ManagedProvider>;

// ── submission ──────────────────────────────────────────────────────────────

/** A relative path prefix: no leading `/`, no `..`, no backslash, no control chars. `.` = whole repo. */
const ScopePath = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[A-Za-z0-9._@+][A-Za-z0-9._@+/ -]*$/, "relative path prefix")
	.refine(
		(p) => !p.split("/").some((seg) => seg === ".." || seg === ""),
		"no empty or `..` segments",
	);

export const TaskSubmission = z
	.strictObject({
		/** Client-generated; resubmitting the same key + same body returns the same task. */
		idempotency_key: z.string().regex(/^[A-Za-z0-9._-]{8,128}$/),
		repo_id: z.string().min(1).max(200),
		title: z.string().trim().min(1).max(120),
		objective: z.string().trim().min(1).max(4000),
		acceptance_criteria: z
			.array(z.string().trim().min(1).max(500))
			.min(1)
			.max(20),
		approved_scope: z.array(ScopePath).min(1).max(20),
		execution_mode: ExecutionMode,
		simulation_scenario: SimulationScenario.optional(),
		repair_limit: z
			.number()
			.int()
			.min(0)
			.max(MAX_REPAIR_LIMIT)
			.default(DEFAULT_REPAIR_LIMIT),
	})
	.refine(
		(t) => t.execution_mode === "simulated" || !t.simulation_scenario,
		"simulation_scenario is only valid in simulated mode",
	);
export type TaskSubmission = z.infer<typeof TaskSubmission>;

// ── rows ────────────────────────────────────────────────────────────────────

export const ManagedTask = z.object({
	id: z.string().min(1),
	contract_version: z.literal(MANAGED_CONTRACT),
	idempotency_key: z.string(),
	request_hash: Hash,
	repo_id: z.string(),
	title: z.string(),
	objective: z.string(),
	acceptance_criteria: z.array(z.string()),
	approved_scope: z.array(z.string()),
	execution_mode: ExecutionMode,
	simulation_scenario: SimulationScenario.nullable(),
	repair_limit: z.number().int().min(0).max(MAX_REPAIR_LIMIT),
	base_ref: z.string(),
	base_sha: Sha,
	state: TaskState,
	failure_kind: FailureKind.nullable(),
	state_detail: z.string().nullable(),
	approval_hash: Hash.nullable(),
	run_requested_at: Ts.nullable(),
	cancel_requested_at: Ts.nullable(),
	lease_owner: z.string().nullable(),
	lease_until: Ts.nullable(),
	fence_token: z.number().int().nonnegative(),
	infra_retries: z.number().int().nonnegative(),
	current_run_id: z.string().nullable(),
	result_run_id: z.string().nullable(),
	created_at: Ts,
	updated_at: Ts,
	rev: z.number().int().positive(),
});
export type ManagedTask = z.infer<typeof ManagedTask>;

export const FindingSeverity = z.enum(["blocker", "major", "minor", "info"]);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

export const Finding = z.strictObject({
	severity: FindingSeverity,
	title: z.string().min(1).max(200),
	detail: z.string().max(2000),
	file: z.string().max(400).nullable(),
	line: z.number().int().positive().nullable(),
	/** Something an implementer can act on. A rejection with none cannot be repaired automatically. */
	actionable: z.boolean(),
});
export type Finding = z.infer<typeof Finding>;

export const ManagedRun = z.object({
	id: z.string().min(1),
	task_id: z.string(),
	attempt_no: z.number().int().positive(),
	kind: RunKind,
	parent_run_id: z.string().nullable(),
	state: RunState,
	phase: RunPhase,
	outcome: z.enum(["approved", "rejected"]).nullable(),
	repair_input: z.array(Finding).nullable(),
	workspace_path: z.string().nullable(),
	branch: z.string().nullable(),
	base_sha: Sha,
	parent_sha: Sha.nullable(),
	candidate_sha: Sha.nullable(),
	manifest_hash: Hash.nullable(),
	provider: ManagedProvider,
	mode: ExecutionMode,
	model_requested: z.string().nullable(),
	/** null = the provider did not report it. Never inferred from the request. */
	model_resolved: z.string().nullable(),
	session_ref: z.string().nullable(),
	usage: z.record(z.string(), z.unknown()).nullable(),
	proc_phase: z.enum(["implement", "verify", "review"]).nullable(),
	proc_started_at: Ts.nullable(),
	child_pid: z.number().int().positive().nullable(),
	child_started: z.string().nullable(),
	failure_kind: FailureKind.nullable(),
	failure_detail: z.string().nullable(),
	started_at: Ts,
	ended_at: Ts.nullable(),
});
export type ManagedRun = z.infer<typeof ManagedRun>;

export const ArtifactKind = z.enum([
	"diff",
	"changed_files",
	"implementation_log",
	"verification_log",
	"review_log",
	"review_output",
	"manifest",
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export const ManagedArtifact = z.object({
	id: z.string().min(1),
	task_id: z.string(),
	run_id: z.string(),
	kind: ArtifactKind,
	name: z.string(),
	rel_path: z.string(),
	sha256: Hash,
	byte_len: z.number().int().nonnegative(),
	truncated: z.boolean(),
	candidate_sha: Sha.nullable(),
	meta: z.record(z.string(), z.unknown()),
	created_at: Ts,
});
export type ManagedArtifact = z.infer<typeof ManagedArtifact>;

export const ManagedReview = z.object({
	id: z.string().min(1),
	task_id: z.string(),
	run_id: z.string(),
	provider: ManagedProvider,
	mode: ExecutionMode,
	model_requested: z.string().nullable(),
	model_resolved: z.string().nullable(),
	session_ref: z.string().nullable(),
	candidate_sha: Sha,
	manifest_hash: Hash,
	verdict: z.enum(["approve", "reject"]).nullable(),
	/** true only when the output matched ReviewOutput AND named this candidate + manifest. */
	valid: z.boolean(),
	invalidated_reason: z.string().nullable(),
	findings: z.array(Finding),
	summary: z.string().nullable(),
	usage: z.record(z.string(), z.unknown()).nullable(),
	created_at: Ts,
});
export type ManagedReview = z.infer<typeof ManagedReview>;

// ── provider outputs ────────────────────────────────────────────────────────

/** What an implementer reports. The evidence is the diff, not this text. */
export const ImplementationOutput = z.strictObject({
	contract: z.literal(IMPLEMENTATION_CONTRACT),
	status: z.enum(["completed", "blocked"]),
	summary: z.string().max(2000),
});
export type ImplementationOutput = z.infer<typeof ImplementationOutput>;

/**
 * What a reviewer must return (ARCHITECTURE #8 verdict shape). `audited_sha` + `manifest_hash` bind
 * the verdict to the exact candidate and evidence it was given. Reviewers get read-only access and
 * do not run tests — verification is Agent City's job — so `tests_executed` must be false; a review
 * claiming otherwise is invalid.
 */
export const ReviewOutput = z.strictObject({
	contract: z.literal(REVIEW_CONTRACT),
	audited_sha: Sha,
	manifest_hash: Hash,
	verdict: z.enum(["approve", "reject"]),
	findings: z.array(Finding).max(50),
	tests_executed: z.literal(false),
	summary: z.string().max(2000),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;

// ── evidence ────────────────────────────────────────────────────────────────

export const VerificationResult = z.strictObject({
	name: z.string(),
	argv: z.array(z.string()),
	/** null when the command never produced one (spawn failure, timeout kill). */
	exit_code: z.number().int().nullable(),
	/** false = it did not run to completion; never counts as a pass. */
	completed: z.boolean(),
	timed_out: z.boolean(),
	duration_ms: z.number().int().nonnegative(),
	log_sha256: Hash,
	log_truncated: z.boolean(),
});
export type VerificationResult = z.infer<typeof VerificationResult>;

export const EvidenceManifest = z.strictObject({
	contract: z.literal(EVIDENCE_CONTRACT),
	task_id: z.string(),
	run_id: z.string(),
	attempt_no: z.number().int().positive(),
	base_sha: Sha,
	parent_sha: Sha,
	candidate_sha: Sha,
	candidate_tree: Sha,
	changed_files: z.array(
		z.strictObject({ status: z.string(), path: z.string() }),
	),
	diff_sha256: Hash,
	diff_truncated: z.boolean(),
	verification: z.array(VerificationResult),
});
export type EvidenceManifest = z.infer<typeof EvidenceManifest>;

export const verificationPassed = (
	results: readonly VerificationResult[],
): boolean =>
	results.length > 0 &&
	results.every((r) => r.completed && !r.timed_out && r.exit_code === 0);
