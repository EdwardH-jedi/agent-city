// Workspace routing recommendation — the display contract (docs/routing-projection.md).
//
// Maps ONE model-factory dry run (`dryRunTaskRoute` output) to what a draft view may show next to the
// draft: recommended worker profile, tier, policy reason and recommendation status. Nothing more.
//
// ADVISORY / DISPLAY-ONLY. Pure and synchronous: no provider call, no DB, no HTTP, no timer, no Git.
// It never assigns, runs, queues, proposes or approves anything, and it is not part of any proposal,
// Gate 1 / Gate 2 binding or hash — putting a profile into a proposal needs a new proposal contract
// version (docs/model-factory.md), never this projection.
//
// Rules:
// - The input is untrusted shape-wise (`unknown`): it is read once inside a guard and strictly
//   validated; anything malformed, inconsistent or unreadable (a throwing getter / Proxy trap) is
//   UNAVAILABLE — never a guess, never a throw.
// - Only bounded vocabulary leaves: a profile id, a canonical tier, policy rule codes (a closed enum),
//   a fixed status and a fixed reason token. No provider confidence, no model name, no free text.
// - The recommended tier is the dry run's `required_tier` (the enforced route raised to any trusted
//   minimum); policy reasons are the enforced decision's `reason_codes` in evaluation order.
import {
	WORKER_LINEAR_CAPABILITY_TIERS,
	type WorkerLinearCapabilityTier,
} from "@agent-city/schema";
import { z } from "zod";
import { POLICY_RULES, type PolicyRule } from "../decision-fabric/policy.ts";
import { deepFreeze, guarded } from "../support-jobs/guards.ts";

export const ROUTING_PROJECTION_VERSION = 1;

export const ROUTING_RECOMMENDATION_STATUSES = [
	"RECOMMENDED",
	"HUMAN_REQUIRED",
	"NO_PROFILE",
	"UNAVAILABLE",
] as const;
export type RoutingRecommendationStatus =
	(typeof ROUTING_RECOMMENDATION_STATUSES)[number];

const HUMAN_REASONS = [
	"route_human",
	"decision_fail_closed",
	"decision_unsupported",
] as const;
const NO_PROFILE_REASONS = [
	"invalid_job",
	"job_not_routable",
	"unknown_profile",
	"disabled_profile",
	"role_mismatch",
	"insufficient_capability",
	"provider_mismatch",
	"mutability_mismatch",
	"no_matching_profile",
] as const;
/** The dry run could not be read or did not hold together. */
export const UNAVAILABLE_REASON = "invalid_route";

export type RoutingStatusReason =
	| (typeof HUMAN_REASONS)[number]
	| (typeof NO_PROFILE_REASONS)[number]
	| typeof UNAVAILABLE_REASON;

export type RoutingRecommendation = Readonly<{
	projection_version: typeof ROUTING_PROJECTION_VERSION;
	authority: "ADVISORY";
	display_only: true;
	status: RoutingRecommendationStatus;
	/** RECOMMENDED: the recommended profile; NO_PROFILE: the configured profile that failed (if any). */
	profile_id: string | null;
	/** RECOMMENDED only: `assigned` = configured profile resolved exactly; `selected` = first eligible. */
	profile_source: "assigned" | "selected" | null;
	/** The tier a profile must meet; null when no lookup happened (HUMAN_REQUIRED / UNAVAILABLE). */
	tier: WorkerLinearCapabilityTier | null;
	/** Every policy rule whose condition held, in evaluation order (closed enum). */
	policy_reasons: readonly PolicyRule[];
	/** True when policy changed the provider's recommendation. */
	policy_override: boolean;
	/** Why there is no recommended profile; null when RECOMMENDED. */
	status_reason: RoutingStatusReason | null;
}>;

const Tier = z.enum(WORKER_LINEAR_CAPABILITY_TIERS);
const ProfileId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);

/** The part of a dry run the projection reads. Unknown extra keys are ignored, never copied. */
const RouteShape = z.object({
	mode: z.literal("DRY_RUN"),
	authority: z.literal("ADVISORY"),
	required_tier: Tier.nullable(),
	fabric: z.object({
		outcome: z.enum(["DECIDED", "UNSUPPORTED"]),
		decision: z
			.object({
				reason_codes: z.array(z.enum(POLICY_RULES)).max(POLICY_RULES.length),
				// only its presence is shown (an object = policy changed the choice); its content is not copied
				policy_override: z.object({}).nullable(),
			})
			.optional(),
	}),
	profile: z.discriminatedUnion("status", [
		z.object({
			status: z.literal("PROFILE_RECOMMENDED"),
			source: z.enum(["assigned", "selected"]),
			profile_id: ProfileId,
		}),
		z.object({
			status: z.literal("HUMAN_REQUIRED"),
			reason: z.enum(HUMAN_REASONS),
			profile_id: z.null(),
		}),
		z.object({
			status: z.literal("NO_PROFILE"),
			reason: z.enum(NO_PROFILE_REASONS),
			profile_id: ProfileId.nullable(),
		}),
	]),
});

const UNAVAILABLE: RoutingRecommendation = deepFreeze({
	projection_version: ROUTING_PROJECTION_VERSION,
	authority: "ADVISORY",
	display_only: true,
	status: "UNAVAILABLE",
	profile_id: null,
	profile_source: null,
	tier: null,
	policy_reasons: [],
	policy_override: false,
	status_reason: UNAVAILABLE_REASON,
});

function project(route: unknown): RoutingRecommendation {
	const parsed = RouteShape.safeParse(route);
	if (!parsed.success) return UNAVAILABLE;
	const r = parsed.data;
	// an UNSUPPORTED fabric outcome carries no enforced decision
	const decision = r.fabric.outcome === "DECIDED" ? r.fabric.decision : null;
	if (r.fabric.outcome === "DECIDED" && !decision) return UNAVAILABLE;
	const base = {
		projection_version: ROUTING_PROJECTION_VERSION,
		authority: "ADVISORY",
		display_only: true,
		policy_reasons: [...(decision?.reason_codes ?? [])],
		policy_override: (decision?.policy_override ?? null) !== null,
	} as const;
	const p = r.profile;
	switch (p.status) {
		case "PROFILE_RECOMMENDED":
			// a recommendation always names the tier it was looked up at
			if (r.required_tier === null || decision === null) return UNAVAILABLE;
			return {
				...base,
				status: "RECOMMENDED",
				profile_id: p.profile_id,
				profile_source: p.source,
				tier: r.required_tier,
				status_reason: null,
			};
		case "HUMAN_REQUIRED":
			// a person decides: no lookup happened, so no tier is shown
			if (r.required_tier !== null) return UNAVAILABLE;
			return {
				...base,
				status: "HUMAN_REQUIRED",
				profile_id: null,
				profile_source: null,
				tier: null,
				status_reason: p.reason,
			};
		case "NO_PROFILE":
			if (decision === null) return UNAVAILABLE;
			return {
				...base,
				status: "NO_PROFILE",
				profile_id: p.profile_id,
				profile_source: null,
				tier: r.required_tier,
				status_reason: p.reason,
			};
	}
}

/**
 * Project one dry run into the display contract. Never throws; never returns anything but bounded,
 * frozen display data. Calling it twice with the same dry run gives equal results.
 */
export function projectRoutingRecommendation(
	route: unknown,
): RoutingRecommendation {
	return guarded(() => deepFreeze(project(route)), UNAVAILABLE);
}
