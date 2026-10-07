// Worker profiles: the provider-independent description of a worker by durable role and capability
// (a fast clerk, a standard engineer, a principal engineer, an independent reviewer, a decision
// engine, a local model worker…) instead of one hard-coded model. A workflow asks for a role and a
// minimum capability; the model behind a profile is configuration, never a workflow role.
//
// Descriptive only: nothing here launches a process or talks to a provider. This module is part of
// the web-safe shared schema, so it carries NO credentials, executable paths, URLs, env or other
// provider configuration — strict objects reject those keys. Remote Git delivery (push / PR / merge /
// deploy) is not a worker capability at all: it belongs to a deterministic delivery subsystem, so a
// profile has no field for it and the strict schema rejects one.
import { z } from "zod";
import { TOKEN_PATTERNS } from "./secret-patterns.ts";

const holdsSecret = (s: string) => TOKEN_PATTERNS.some((p) => p.re.test(s));

/**
 * Stable profile id. Lowercase only, so duplicate detection is an exact string comparison with no
 * case ambiguity (`Clerk` vs `clerk` cannot both exist). Lookups never normalize or guess.
 */
export const WORKER_PROFILE_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
export const WorkerProfileId = z
	.string()
	.regex(WORKER_PROFILE_ID_PATTERN, "lowercase [a-z][a-z0-9._-]{0,63}");
export type WorkerProfileId = z.infer<typeof WorkerProfileId>;

/** Who serves the profile. `fake` = deterministic stub, never a model. */
export const WorkerProvider = z.enum([
	"claude",
	"openai",
	"codex",
	"jev",
	"local",
	"fake",
]);
export type WorkerProvider = z.infer<typeof WorkerProvider>;

/** The durable job a worker does in a workflow. */
export const WorkerRole = z.enum([
	"clerk",
	"implementer",
	"reviewer",
	"decision",
]);
export type WorkerRole = z.infer<typeof WorkerRole>;

/**
 * Capability tier. `fast < standard < senior < principal` is a linear scale (see
 * WORKER_CAPABILITY_RANK). `specialist` is deliberately OFF that scale: it is matched only when it
 * is requested explicitly, never satisfies a linear minimum and is never returned by one.
 */
export const WorkerCapabilityTier = z.enum([
	"fast",
	"standard",
	"senior",
	"principal",
	"specialist",
]);
export type WorkerCapabilityTier = z.infer<typeof WorkerCapabilityTier>;

/** What the worker may change: nothing, or files in its own disposable worktree. */
export const WorkerMutabilityClass = z.enum(["read_only", "worktree"]);
export type WorkerMutabilityClass = z.infer<typeof WorkerMutabilityClass>;

/** Expected response latency (low = quick). Descriptive; used for selection, not enforcement. */
export const WorkerLatencyClass = z.enum(["low", "medium", "high"]);
export type WorkerLatencyClass = z.infer<typeof WorkerLatencyClass>;

/** Relative cost per task. `none` = no metered quota (fake, a local runtime). */
export const WorkerCostClass = z.enum(["none", "low", "medium", "high"]);
export type WorkerCostClass = z.infer<typeof WorkerCostClass>;

// ── capability scale ────────────────────────────────────────────────────────

export const WORKER_LINEAR_CAPABILITY_TIERS = [
	"fast",
	"standard",
	"senior",
	"principal",
] as const satisfies readonly WorkerCapabilityTier[];
export type WorkerLinearCapabilityTier =
	(typeof WORKER_LINEAR_CAPABILITY_TIERS)[number];

/** Rank on the linear scale; higher = more capable. `specialist` has no rank. */
export const WORKER_CAPABILITY_RANK: Readonly<
	Record<WorkerLinearCapabilityTier, number>
> = Object.freeze({ fast: 0, standard: 1, senior: 2, principal: 3 });

/** Linear rank of a tier, or null for the off-scale `specialist`. */
export function workerCapabilityRank(
	tier: WorkerCapabilityTier,
): number | null {
	return tier === "specialist" ? null : WORKER_CAPABILITY_RANK[tier];
}

/**
 * Does a profile of `tier` satisfy a request for `required`?
 * - `required: "specialist"` → only a `specialist` (an explicit request, exact match).
 * - a linear `required` → only a linear tier of equal or higher rank; a `specialist` never
 *   satisfies a linear minimum (it is not "above principal", it is a different axis).
 */
export function workerTierSatisfies(
	tier: WorkerCapabilityTier,
	required: WorkerCapabilityTier,
): boolean {
	if (required === "specialist") return tier === "specialist";
	const rank = workerCapabilityRank(tier);
	return rank !== null && rank >= WORKER_CAPABILITY_RANK[required];
}

/**
 * Total order for deterministic listings: linear tiers by rank ascending, then `specialist` last.
 * Its position is a sort convention only, not a capability claim.
 */
export function compareWorkerCapabilityTier(
	a: WorkerCapabilityTier,
	b: WorkerCapabilityTier,
): number {
	const ra = workerCapabilityRank(a) ?? WORKER_LINEAR_CAPABILITY_TIERS.length;
	const rb = workerCapabilityRank(b) ?? WORKER_LINEAR_CAPABILITY_TIERS.length;
	return ra - rb;
}

// ── profile ─────────────────────────────────────────────────────────────────

/** Bounds of `max_concurrency` (simultaneous tasks one profile may serve). */
export const WORKER_MAX_CONCURRENCY = 16;
/** Bound of a profile list (config or registry). */
export const WORKER_MAX_PROFILES = 32;

/** Same shape as the managed config's CLI provider `model`; secret-shaped values are rejected. */
export const WORKER_MODEL_PATTERN = /^[A-Za-z0-9._:[\]-]{1,100}$/;

/**
 * Which mutability each role may have. A reviewer or decision maker that changes files is not
 * independent (the managed pipeline already fails a mutating reviewer); an implementer that cannot
 * write cannot implement.
 */
export const WORKER_ROLE_ALLOWED_MUTABILITY: Readonly<
	Record<WorkerRole, readonly WorkerMutabilityClass[]>
> = Object.freeze({
	clerk: Object.freeze(["read_only", "worktree"] as const),
	implementer: Object.freeze(["worktree"] as const),
	reviewer: Object.freeze(["read_only"] as const),
	decision: Object.freeze(["read_only"] as const),
});

/**
 * Providers whose profile must pin a model. A null model on a model runtime means "whatever the
 * CLI/runtime defaults to" — a silent fallback model, which managed runs never allow. `jev` (decision
 * engine) and `fake` (stub) may have no model.
 */
export function workerProviderRequiresModel(provider: WorkerProvider): boolean {
	return provider !== "jev" && provider !== "fake";
}

export const WorkerProfile = z
	.strictObject({
		profile_id: WorkerProfileId,
		provider: WorkerProvider,
		role: WorkerRole,
		capability_tier: WorkerCapabilityTier,
		/** Provider model identifier, or null where the provider has none (see above). */
		model: z
			.string()
			.regex(WORKER_MODEL_PATTERN)
			.refine((m) => !holdsSecret(m), "must not be a credential")
			.nullable()
			.default(null),
		mutability: WorkerMutabilityClass,
		latency_class: WorkerLatencyClass,
		cost_class: WorkerCostClass,
		/** false = kept in the registry for display, never returned as available. */
		enabled: z.boolean().default(true),
		max_concurrency: z
			.number()
			.int()
			.min(1)
			.max(WORKER_MAX_CONCURRENCY)
			.default(1),
		/** Human-readable name for the UI. Printable text, no credentials. */
		label: z
			.string()
			.min(1)
			.max(80)
			.regex(/^[^\p{Cc}]+$/u, "no control characters")
			.refine((l) => !holdsSecret(l), "must not contain a credential")
			.optional(),
	})
	.superRefine((p, ctx) => {
		if (!WORKER_ROLE_ALLOWED_MUTABILITY[p.role].includes(p.mutability))
			ctx.addIssue({
				code: "custom",
				path: ["mutability"],
				message: `role ${p.role} cannot have mutability ${p.mutability}`,
			});
		if (p.model === null && workerProviderRequiresModel(p.provider))
			ctx.addIssue({
				code: "custom",
				path: ["model"],
				message: `provider ${p.provider} must pin a model (no default/fallback model)`,
			});
	});
export type WorkerProfile = z.infer<typeof WorkerProfile>;
export type WorkerProfileInput = z.input<typeof WorkerProfile>;

/** A profile list: bounded, profile ids unique (duplicates fail closed, nothing is merged). */
export const WorkerProfileList = z
	.array(WorkerProfile)
	.max(WORKER_MAX_PROFILES)
	.superRefine((list, ctx) => {
		const seen = new Set<string>();
		list.forEach((p, i) => {
			if (seen.has(p.profile_id))
				ctx.addIssue({
					code: "custom",
					path: [i, "profile_id"],
					message: `duplicate worker profile ${p.profile_id}`,
				});
			seen.add(p.profile_id);
		});
	});
export type WorkerProfileList = z.infer<typeof WorkerProfileList>;
