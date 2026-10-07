// Decision Fabric contracts: decision kinds, their structured inputs, their closed choice sets and
// the bounded recommendation a provider may return.
//
// Inputs are structured facts (flags, counts, enums) — never diff text, prompts or transcripts.
// Every change flag is REQUIRED: a missing flag is invalid input (fail closed), never "assumed safe".
// A recommendation carries bounded operational facts only; there is no field for reasoning, and the
// strict schemas reject any unknown key (`reasoning`, `chain_of_thought`, `findings`, …).
import { z } from "zod";
import { CapabilityTier, ROUTE_OUTCOMES } from "./vocabulary.ts";

/** Folded into every input hash and result, so a contract change never reuses an old hash. */
export const DECISION_FABRIC_VERSION = "agentcity.decision-fabric/v0";

export const DECISION_KINDS = [
	"TASK_ROUTE",
	"ESCALATION",
	"REVIEW_DEPTH",
	"POST_REVIEW",
	"QUEUE_PRIORITY",
	"HUMAN_ESCALATE",
	"OVERNIGHT_CONTINUE",
] as const;
export const DecisionKind = z.enum(DECISION_KINDS);
export type DecisionKind = z.infer<typeof DecisionKind>;

// ── choice sets (closed; a choice outside its kind's set is unsupported → fail closed) ──────────

export const ESCALATION_CHOICES = [
	"RETRY_SAME_TIER",
	"ESCALATE_TIER",
	"HUMAN",
] as const;
/** Ascending review strength (index = rank). */
export const REVIEW_DEPTH_CHOICES = [
	"NO_SEMANTIC_REVIEW",
	"STANDARD_REVIEW",
	"DEEP_REVIEW",
	"SECOND_REVIEW",
	"HUMAN_REQUIRED",
] as const;
export const POST_REVIEW_CHOICES = [
	"READY_FOR_HUMAN",
	"SAME_TIER_REPAIR",
	"ESCALATE_REPAIR",
	"SECOND_REVIEW",
	"HUMAN_REQUIRED",
	"STOP",
] as const;
export const QUEUE_PRIORITY_CHOICES = ["RAISE", "KEEP", "LOWER"] as const;
export const HUMAN_ESCALATE_CHOICES = [
	"ESCALATE_TO_HUMAN",
	"CONTINUE_AUTONOMOUS",
] as const;
export const OVERNIGHT_CONTINUE_CHOICES = [
	"CONTINUE",
	"PAUSE_FOR_HUMAN",
	"STOP",
] as const;

export const CHOICES = {
	TASK_ROUTE: ROUTE_OUTCOMES,
	ESCALATION: ESCALATION_CHOICES,
	REVIEW_DEPTH: REVIEW_DEPTH_CHOICES,
	POST_REVIEW: POST_REVIEW_CHOICES,
	QUEUE_PRIORITY: QUEUE_PRIORITY_CHOICES,
	HUMAN_ESCALATE: HUMAN_ESCALATE_CHOICES,
	OVERNIGHT_CONTINUE: OVERNIGHT_CONTINUE_CHOICES,
} as const satisfies Record<DecisionKind, readonly string[]>;
export type Choice<K extends DecisionKind> = (typeof CHOICES)[K][number];
export type ReviewDepth = (typeof REVIEW_DEPTH_CHOICES)[number];

export const isChoiceOf = <K extends DecisionKind>(
	kind: K,
	choice: string,
): choice is Choice<K> => (CHOICES[kind] as readonly string[]).includes(choice);

// ── inputs ──────────────────────────────────────────────────────────────────────────────────

const Count = z.number().int().min(0).max(10_000);

/** What a change touches, as flags. All required: absence is not evidence of safety. */
export const ChangeFacts = z.strictObject({
	/** Source code, tests, build or runtime config — anything executable or that changes behaviour. */
	mutates_source: z.boolean(),
	/** Authentication: sign-in, sessions, token verification. */
	touches_auth: z.boolean(),
	/** Authorization, permission checks, approval contracts / approval bindings. */
	touches_authorization: z.boolean(),
	/** Other security-sensitive code: sandboxing, isolation, redaction, secret handling, crypto. */
	touches_security: z.boolean(),
	touches_db_migration: z.boolean(),
	/** Deployment, release/publishing, credentials or secret configuration. Human-only. */
	touches_deploy_or_credentials: z.boolean(),
	/** Push / PR / merge / any remote write. Outside Decision Fabric entirely. */
	requests_remote_delivery: z.boolean(),
});
export type ChangeFacts = z.infer<typeof ChangeFacts>;

/** Mirrors the managed-run `Finding` shape so reviewer findings pass straight through. */
export const ReviewFinding = z.strictObject({
	severity: z.enum(["blocker", "major", "minor", "info"]),
	title: z.string().min(1).max(200),
	detail: z.string().max(2000),
	file: z.string().max(400).nullable(),
	line: z.number().int().positive().nullable(),
	/** Something an implementer can act on. A rejection with none cannot be repaired automatically. */
	actionable: z.boolean(),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

export const MAX_FINDINGS = 50;

export const TaskRouteInput = z.strictObject({
	change: ChangeFacts,
	scope: z.enum(["TRIVIAL", "SMALL", "MEDIUM", "LARGE"]),
});
export const EscalationInput = z.strictObject({
	change: ChangeFacts,
	current_tier: CapabilityTier,
	attempts_at_tier: Count,
	failure: z.enum([
		"VERIFICATION_FAILED",
		"TIMEOUT",
		"NO_PROGRESS",
		"INFRA_ERROR",
	]),
});
export const ReviewDepthInput = z.strictObject({
	change: ChangeFacts,
	/** Every changed artifact is a non-executable, read-only support artifact (notes, reports). */
	support_artifact_only: z.boolean(),
});
export const PostReviewInput = z.strictObject({
	change: ChangeFacts,
	reviewer_verdict: z.enum(["APPROVE", "REJECT"]),
	findings: z.array(ReviewFinding).max(MAX_FINDINGS),
	implementer_tier: CapabilityTier,
	same_tier_repairs: Count,
	total_repairs: Count,
});
export const QueuePriorityInput = z.strictObject({
	current_priority: z.enum(["P0", "P1", "P2", "P3"]),
	waited_s: z.number().int().min(0).max(31_536_000),
	is_repair: z.boolean(),
});
export const HumanEscalateInput = z.strictObject({
	change: ChangeFacts,
	consecutive_failures: Count,
});
export const OvernightContinueInput = z.strictObject({
	change: ChangeFacts,
	consecutive_failures: Count,
	budget_exhausted: z.boolean(),
});

export const INPUT_SCHEMAS = {
	TASK_ROUTE: TaskRouteInput,
	ESCALATION: EscalationInput,
	REVIEW_DEPTH: ReviewDepthInput,
	POST_REVIEW: PostReviewInput,
	QUEUE_PRIORITY: QueuePriorityInput,
	HUMAN_ESCALATE: HumanEscalateInput,
	OVERNIGHT_CONTINUE: OvernightContinueInput,
} as const satisfies Record<DecisionKind, z.ZodType>;
export type DecisionInput<K extends DecisionKind> = z.infer<
	(typeof INPUT_SCHEMAS)[K]
>;

/** A request: one decision kind plus its normalized input. Strict at every level. */
export const DecisionRequest = z.discriminatedUnion("decision_kind", [
	z.strictObject({
		decision_kind: z.literal("TASK_ROUTE"),
		input: TaskRouteInput,
	}),
	z.strictObject({
		decision_kind: z.literal("ESCALATION"),
		input: EscalationInput,
	}),
	z.strictObject({
		decision_kind: z.literal("REVIEW_DEPTH"),
		input: ReviewDepthInput,
	}),
	z.strictObject({
		decision_kind: z.literal("POST_REVIEW"),
		input: PostReviewInput,
	}),
	z.strictObject({
		decision_kind: z.literal("QUEUE_PRIORITY"),
		input: QueuePriorityInput,
	}),
	z.strictObject({
		decision_kind: z.literal("HUMAN_ESCALATE"),
		input: HumanEscalateInput,
	}),
	z.strictObject({
		decision_kind: z.literal("OVERNIGHT_CONTINUE"),
		input: OvernightContinueInput,
	}),
]);
export type DecisionRequest = z.infer<typeof DecisionRequest>;

// ── provider output ─────────────────────────────────────────────────────────────────────────

export const ProviderId = z.string().regex(/^[a-z][a-z0-9._:-]{0,63}$/);
export const InputHash = z.string().regex(/^[0-9a-f]{64}$/);

/** Concise operational classifications, not prose: `[A-Z0-9_]{1,64}`, at most this many. */
export const MAX_REASON_CODES = 8;
export const ReasonCode = z.string().regex(/^[A-Z0-9_]{1,64}$/);

const MetaToken = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);
/** Fixed keys, bounded tokens. No free-text field exists, so nothing can smuggle reasoning in. */
export const ProviderMetadata = z.strictObject({
	provider_version: MetaToken.optional(),
	trace_id: MetaToken.optional(),
	latency_ms: z.number().int().min(0).max(600_000).optional(),
	cache_hit: z.boolean().optional(),
});
export type ProviderMetadata = z.infer<typeof ProviderMetadata>;

/**
 * What a provider must return. `decision_kind`, `input_hash` and `provider` must echo the request
 * (checked by the fabric); `choice` is syntax-checked here and checked against its kind's set later.
 */
export const Recommendation = z.strictObject({
	decision_kind: DecisionKind,
	choice: z.string().regex(/^[A-Z0-9_]{1,64}$/),
	confidence: z.number().min(0).max(1),
	provider: ProviderId,
	input_hash: InputHash,
	reason_codes: z
		.array(ReasonCode)
		.max(MAX_REASON_CODES)
		.refine((a) => new Set(a).size === a.length, "duplicate reason code"),
	metadata: ProviderMetadata.optional(),
});
export type Recommendation = z.infer<typeof Recommendation>;
