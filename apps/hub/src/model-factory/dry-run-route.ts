// Model-factory dry run: the pure composition of the three foundation subsystems.
//
//   SupportJob (support-jobs/)                      a read-only job asking for a capability
//     → Decision Fabric TASK_ROUTE (decision-fabric/)  provider recommendation + deterministic policy
//     → capability (canonical Worker Profile tier)
//     → Worker Profile Registry (managed/worker-profile-registry.ts)
//     → a profile RECOMMENDATION — nothing more.
//
// DRY RUN / ADVISORY ONLY. This module launches nothing, queues nothing, assigns nothing and writes
// nothing: no managed task, no workspace or approval state, no Gate 1 (neither opened nor
// bypassed), no repository, no git. The only call it makes is to the DecisionProvider the caller
// passes in; today only the deterministic fakes in decision-fabric/fake-provider.ts exist (no Jev,
// OpenAI, Claude or Codex provider). The Hub's own gates and human approval stay authoritative.
//
// Rules:
// - A support job is read-only by contract (no mutation authority in its schema), so its change
//   facts are all false — constant, never taken from a provider.
// - Only a QUEUED, enabled, not-cancelling job is routed; anything else is not routable.
// - Required tier = the higher of the job's requested capability (a trusted floor) and the
//   enforced route: the fabric can raise a job's tier, never lower it.
// - A HUMAN route or any undecided/fail-closed fabric outcome → no profile lookup at all.
// - The lane serves only read-only clerks (SUPPORT_LANE_ROLE / SUPPORT_LANE_MUTABILITY).
// - A job that already carries a profile_id is resolved EXACTLY (registry.resolve) and fails closed
//   if that profile is unknown, disabled, insufficient or mutable — it is never swapped for another.
// - A job without one gets the first eligible profile in registry order (lowest sufficient tier,
//   then profile_id) — reported as `source: "selected"`, distinct from `"assigned"`. The job itself
//   is not changed (assignSupportProfile is never called here).
//
// Implementation tasks (dryRunTaskRoute) take the same path with the implementer lane: trusted change
// facts → TASK_ROUTE → policy floors (auth / authorization / security / migration ≥ SENIOR, deploy /
// credentials / remote delivery → a person) → an implementer profile with a worktree. Still a
// recommendation only: no proposal, no Gate 1, no managed task, no provider.
import {
	WORKER_CAPABILITY_RANK,
	WORKER_LINEAR_CAPABILITY_TIERS,
	type WorkerLinearCapabilityTier,
	type WorkerMutabilityClass,
	type WorkerProfile,
	type WorkerRole,
} from "@agent-city/schema";
import {
	type ChangeFacts,
	type DecisionInput,
	TaskRouteInput,
} from "../decision-fabric/contracts.ts";
import {
	type DecideOptions,
	decide,
	type FabricOutcome,
} from "../decision-fabric/fabric.ts";
import type { DecisionProvider } from "../decision-fabric/provider.ts";
import { routeTarget } from "../decision-fabric/vocabulary.ts";
import type {
	WorkerProfileRegistry,
	WorkerProfileRequirement,
	WorkerProfileResolutionFailure,
} from "../managed/worker-profile-registry.ts";
import { deepFreeze, guarded } from "../support-jobs/guards.ts";
import { parseSupportJob, type SupportJobKind } from "../support-jobs/job.ts";
import type { SupportCapability } from "../support-jobs/vocabulary.ts";

export const DRY_RUN_MODE = "DRY_RUN";

/** The worker role and mutability the support lane may be served by. */
export const SUPPORT_LANE_ROLE: WorkerRole = "clerk";
export const SUPPORT_LANE_MUTABILITY: WorkerMutabilityClass = "read_only";

/** What a support job changes: nothing (its schema carries no mutation authority). */
export const SUPPORT_JOB_CHANGE_FACTS: Readonly<ChangeFacts> = Object.freeze({
	mutates_source: false,
	touches_auth: false,
	touches_authorization: false,
	touches_security: false,
	touches_db_migration: false,
	touches_deploy_or_credentials: false,
	requests_remote_delivery: false,
});

export type DryRunScope = DecisionInput<"TASK_ROUTE">["scope"];

export type DryRunNoProfileReason =
	| "invalid_job"
	| "job_not_routable"
	| WorkerProfileResolutionFailure
	| "mutability_mismatch"
	| "no_matching_profile";

export type DryRunProfile =
	| Readonly<{
			status: "PROFILE_RECOMMENDED";
			/** assigned = the job's own profile_id, resolved exactly; selected = chosen here. */
			source: "assigned" | "selected";
			profile_id: string;
			profile: WorkerProfile;
	  }>
	| Readonly<{
			status: "HUMAN_REQUIRED";
			/** HUMAN route, a fail-closed decision, or no usable decision at all. */
			reason: "route_human" | "decision_fail_closed" | "decision_unsupported";
			profile_id: null;
			profile: null;
	  }>
	| Readonly<{
			status: "NO_PROFILE";
			reason: DryRunNoProfileReason;
			/** The profile id that failed to resolve (assigned path), else null. */
			profile_id: string | null;
			profile: null;
	  }>;

export type DryRunRoute = Readonly<{
	mode: typeof DRY_RUN_MODE;
	authority: "ADVISORY";
	job_id: string | null;
	repo_id: string | null;
	kind: SupportJobKind | null;
	requested_capability: SupportCapability | null;
	/** The complete Decision Fabric outcome (recommendation and enforced decision side by side). */
	fabric: FabricOutcome | null;
	/** Canonical tier of the enforced route; null for HUMAN / no decision. */
	routed_tier: WorkerLinearCapabilityTier | null;
	/** max(requested_capability, routed_tier); null when no lookup happens. */
	required_tier: WorkerLinearCapabilityTier | null;
	profile: DryRunProfile;
}>;

export interface DryRunRequest {
	/** The support job (validated here; never modified). */
	job: unknown;
	/** Task size for TASK_ROUTE, from trusted Hub analysis — never from a provider. */
	scope: DryRunScope;
}

export interface DryRunDeps {
	provider: DecisionProvider;
	registry: WorkerProfileRegistry;
	decide_options?: DecideOptions;
}

const higherTier = (
	a: WorkerLinearCapabilityTier,
	b: WorkerLinearCapabilityTier,
): WorkerLinearCapabilityTier =>
	WORKER_CAPABILITY_RANK[a] >= WORKER_CAPABILITY_RANK[b] ? a : b;

/** Recommend (never assign, never run) a worker profile for one support job. */
export async function dryRunSupportRoute(
	req: DryRunRequest,
	deps: DryRunDeps,
): Promise<DryRunRoute> {
	// each request field is read once, inside a guard (an unreadable job / scope fails closed)
	const job = guarded(() => parseSupportJob(req.job), null);
	const scope = guarded<unknown>(() => req.scope, null);
	const base = {
		mode: DRY_RUN_MODE,
		authority: "ADVISORY",
		job_id: job?.id ?? null,
		repo_id: job?.repo_id ?? null,
		kind: job?.kind ?? null,
		requested_capability: job?.capability ?? null,
	} as const;
	const noLookup = (
		fabric: FabricOutcome | null,
		routed_tier: WorkerLinearCapabilityTier | null,
		profile: DryRunProfile,
	): DryRunRoute =>
		deepFreeze({ ...base, fabric, routed_tier, required_tier: null, profile });

	if (!job)
		return noLookup(null, null, {
			status: "NO_PROFILE",
			reason: "invalid_job",
			profile_id: null,
			profile: null,
		});
	if (job.status !== "QUEUED" || job.disabled || job.cancel_requested)
		return noLookup(null, null, {
			status: "NO_PROFILE",
			reason: "job_not_routable",
			profile_id: job.profile_id,
			profile: null,
		});

	const fabric = await decide(
		deps.provider,
		{
			decision_kind: "TASK_ROUTE",
			input: { change: { ...SUPPORT_JOB_CHANGE_FACTS }, scope },
		},
		deps.decide_options,
	);
	if (fabric.outcome !== "DECIDED" || fabric.decision_kind !== "TASK_ROUTE")
		return noLookup(fabric, null, {
			status: "HUMAN_REQUIRED",
			reason: "decision_unsupported",
			profile_id: null,
			profile: null,
		});
	const target = routeTarget(fabric.decision.route ?? "HUMAN");
	if (target.kind === "HUMAN")
		return noLookup(fabric, null, {
			status: "HUMAN_REQUIRED",
			reason: fabric.decision.fail_closed
				? "decision_fail_closed"
				: "route_human",
			profile_id: null,
			profile: null,
		});

	const required_tier = higherTier(job.capability, target.tier);
	const requirement = {
		role: SUPPORT_LANE_ROLE,
		min_capability: required_tier,
	} as const;
	const done = (profile: DryRunProfile): DryRunRoute =>
		deepFreeze({
			...base,
			fabric,
			routed_tier: target.tier,
			required_tier,
			profile,
		});

	return done(
		recommendProfile(
			deps.registry,
			requirement,
			SUPPORT_LANE_MUTABILITY,
			job.profile_id,
		),
	);
}

/**
 * An assigned profile is resolved EXACTLY (unknown / disabled / unfit / wrong mutability → no
 * profile, never a substitute); without one, the first eligible enabled profile in registry order
 * (lowest sufficient tier, then profile_id) is selected.
 */
function recommendProfile(
	registry: WorkerProfileRegistry,
	requirement: WorkerProfileRequirement,
	mutability: WorkerMutabilityClass,
	assigned: string | null,
): DryRunProfile {
	if (assigned !== null) {
		const r = registry.resolve(assigned, requirement);
		if (!r.ok)
			return {
				status: "NO_PROFILE",
				reason: r.reason,
				profile_id: assigned,
				profile: null,
			};
		if (r.profile.mutability !== mutability)
			return {
				status: "NO_PROFILE",
				reason: "mutability_mismatch",
				profile_id: assigned,
				profile: null,
			};
		return {
			status: "PROFILE_RECOMMENDED",
			source: "assigned",
			profile_id: r.profile.profile_id,
			profile: r.profile,
		};
	}
	const pick = registry
		.select(requirement)
		.find((p) => p.mutability === mutability);
	return pick
		? {
				status: "PROFILE_RECOMMENDED",
				source: "selected",
				profile_id: pick.profile_id,
				profile: pick,
			}
		: {
				status: "NO_PROFILE",
				reason: "no_matching_profile",
				profile_id: null,
				profile: null,
			};
}

// ── implementation tasks ─────────────────────────────────────────────────────────────────────

/** The worker role and mutability an implementation task is served by. */
export const IMPLEMENTATION_ROLE: WorkerRole = "implementer";
export const IMPLEMENTATION_MUTABILITY: WorkerMutabilityClass = "worktree";

export type DryRunTaskRoute = Readonly<{
	mode: typeof DRY_RUN_MODE;
	authority: "ADVISORY";
	/**
	 * The change facts exactly as normalized once — the same snapshot the fabric hashed and the policy
	 * enforced. null when the request did not validate or could not be read (→ fail closed).
	 */
	change: Readonly<ChangeFacts> | null;
	/** The complete Decision Fabric outcome (recommendation and enforced decision side by side). */
	fabric: FabricOutcome;
	/** Canonical tier of the enforced route; null for HUMAN / no decision. */
	routed_tier: WorkerLinearCapabilityTier | null;
	/** max(min_capability, routed_tier); null when no lookup happens. */
	required_tier: WorkerLinearCapabilityTier | null;
	profile: DryRunProfile;
}>;

export interface DryRunTaskRequest {
	/** What the change touches, from trusted Hub analysis — never from a provider or the task text. */
	change: unknown;
	/** Task size for TASK_ROUTE, from trusted Hub analysis. */
	scope: DryRunScope;
	/** Optional trusted minimum tier (like a support job's capability): raised to, never lowered. */
	min_capability?: WorkerLinearCapabilityTier | null;
	/** An implementer profile already named by trusted configuration: resolved exactly. */
	profile_id?: string | null;
}

/** A task request read once: the single snapshot used for policy, hashing and returned evidence. */
type NormalizedTaskRequest = Readonly<{
	input: DecisionInput<"TASK_ROUTE">;
	min_capability: WorkerLinearCapabilityTier | null;
	profile_id: string | null;
}>;

const isLinearTier = (v: unknown): v is WorkerLinearCapabilityTier =>
	typeof v === "string" &&
	(WORKER_LINEAR_CAPABILITY_TIERS as readonly string[]).includes(v);

/**
 * Read every request field exactly once, inside a guard. Valid → plain copies (zod's copy of the
 * change facts and scope); invalid or unreadable (a throwing getter / Proxy trap) → null, which
 * fails closed. Unreadable facts are never replaced by all-false ones, and an unknown minimum tier
 * is refused rather than ignored.
 */
function normalizeTaskRequest(
	req: DryRunTaskRequest,
): NormalizedTaskRequest | null {
	return guarded<NormalizedTaskRequest | null>(() => {
		const { change, scope, min_capability = null, profile_id = null } = req;
		const input = TaskRouteInput.safeParse({ change, scope });
		if (!input.success) return null;
		if (min_capability !== null && !isLinearTier(min_capability)) return null;
		if (profile_id !== null && typeof profile_id !== "string") return null;
		return { input: input.data, min_capability, profile_id };
	}, null);
}

/** Not a TaskRouteInput: the fabric reports INPUT_INVALID and never asks the provider. */
const INVALID_TASK_INPUT = null;

/**
 * Recommend (never assign, never run, never queue, never propose) an implementer profile for one
 * implementation task. A provider can raise the tier but never lower it below the policy floors or
 * `min_capability`; a HUMAN route or an undecided / fail-closed outcome means no profile lookup.
 * The change facts are normalized once: the fabric decides on that snapshot and the result returns
 * it as `change`, so the reported facts are always the ones the policy enforced.
 */
export async function dryRunTaskRoute(
	req: DryRunTaskRequest,
	deps: DryRunDeps,
): Promise<DryRunTaskRoute> {
	const norm = normalizeTaskRequest(req);
	const base = {
		mode: DRY_RUN_MODE,
		authority: "ADVISORY",
		change: norm?.input.change ?? null,
	} as const;
	const fabric = await decide(
		deps.provider,
		{
			decision_kind: "TASK_ROUTE",
			input: norm?.input ?? INVALID_TASK_INPUT,
		},
		deps.decide_options,
	);
	const human = (
		reason: "route_human" | "decision_fail_closed" | "decision_unsupported",
	): DryRunTaskRoute =>
		deepFreeze({
			...base,
			fabric,
			routed_tier: null,
			required_tier: null,
			profile: {
				status: "HUMAN_REQUIRED",
				reason,
				profile_id: null,
				profile: null,
			},
		});
	if (fabric.outcome !== "DECIDED" || fabric.decision_kind !== "TASK_ROUTE")
		return human("decision_unsupported");
	// an unreadable / invalid request already made the fabric fail closed (INPUT_INVALID)
	if (norm === null) return human("decision_fail_closed");
	const target = routeTarget(fabric.decision.route ?? "HUMAN");
	if (target.kind === "HUMAN")
		return human(
			fabric.decision.fail_closed ? "decision_fail_closed" : "route_human",
		);
	const required_tier = norm.min_capability
		? higherTier(norm.min_capability, target.tier)
		: target.tier;
	return deepFreeze({
		...base,
		fabric,
		routed_tier: target.tier,
		required_tier,
		profile: recommendProfile(
			deps.registry,
			{ role: IMPLEMENTATION_ROLE, min_capability: required_tier },
			IMPLEMENTATION_MUTABILITY,
			norm.profile_id,
		),
	});
}
