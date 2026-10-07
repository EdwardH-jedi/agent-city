// Worker profile registry: an immutable, pure (no I/O, no process, no provider) view over the
// trusted config's `worker_profiles`. It answers "which configured profile serves this role at
// this capability?" and "is this exact profile available?" — it never launches anything and never
// substitutes one profile/model for another.
//
// Deterministic order everywhere (documented sort key): capability tier via
// compareWorkerCapabilityTier (fast < standard < senior < principal, then the off-scale specialist),
// then profile_id by code unit order. Input order never matters.
import {
	compareWorkerCapabilityTier,
	type WorkerCapabilityTier,
	type WorkerProfile,
	WorkerProfileList,
	type WorkerProvider,
	type WorkerRole,
	workerTierSatisfies,
} from "@agent-city/schema";
import type { ManagedConfig } from "./config.ts";

/** Requirements a caller may place on a profile it resolves or selects. */
export interface WorkerProfileRequirement {
	role?: WorkerRole;
	/**
	 * Linear tier = that rank or higher (never a specialist). `specialist` = only specialists
	 * (an explicit request). See workerTierSatisfies.
	 */
	min_capability?: WorkerCapabilityTier;
	provider?: WorkerProvider;
}

export type WorkerProfileResolutionFailure =
	| "unknown_profile"
	| "disabled_profile"
	| "role_mismatch"
	| "insufficient_capability"
	| "provider_mismatch";

/** Exactly the requested profile, or a fail-closed reason. Never a substitute. */
export type WorkerProfileResolution =
	| { ok: true; profile: WorkerProfile }
	| {
			ok: false;
			reason: WorkerProfileResolutionFailure;
			profile_id: string;
	  };

export interface WorkerProfileRegistry {
	/** Number of configured profiles (enabled or not). */
	readonly size: number;
	/** Exact-id lookup (enabled or not). Unknown → null; no case-folding, prefix or fuzzy match. */
	get(profileId: string): WorkerProfile | null;
	/**
	 * The requested profile if it exists, is enabled and meets `requirement`; otherwise a failure.
	 * There is no fallback: a missing/disabled/mismatched profile is never replaced by another.
	 */
	resolve(
		profileId: string,
		requirement?: WorkerProfileRequirement,
	): WorkerProfileResolution;
	/** Every configured profile, disabled ones included (for display), in registry order. */
	all(): readonly WorkerProfile[];
	/** Enabled profiles only, in registry order. */
	enabled(): readonly WorkerProfile[];
	/** Enabled profiles meeting every given requirement, in registry order. */
	select(requirement?: WorkerProfileRequirement): readonly WorkerProfile[];
	/** Shorthand for select({ role }). */
	byRole(role: WorkerRole): readonly WorkerProfile[];
	/** Shorthand for select({ min_capability }). */
	atLeast(minimum: WorkerCapabilityTier): readonly WorkerProfile[];
}

/** Registry sort key: capability tier (specialist last), then profile_id. */
export function compareWorkerProfiles(
	a: WorkerProfile,
	b: WorkerProfile,
): number {
	const byTier = compareWorkerCapabilityTier(
		a.capability_tier,
		b.capability_tier,
	);
	if (byTier !== 0) return byTier;
	return a.profile_id < b.profile_id ? -1 : a.profile_id > b.profile_id ? 1 : 0;
}

const unmet = (
	p: WorkerProfile,
	req: WorkerProfileRequirement,
): WorkerProfileResolutionFailure | null => {
	if (req.role !== undefined && p.role !== req.role) return "role_mismatch";
	if (req.provider !== undefined && p.provider !== req.provider)
		return "provider_mismatch";
	if (
		req.min_capability !== undefined &&
		!workerTierSatisfies(p.capability_tier, req.min_capability)
	)
		return "insufficient_capability";
	return null;
};

/**
 * Build a registry. The input is re-validated with the shared schema (strict fields, bounds, unique
 * ids) so a programmatic caller fails closed exactly like the config file; `undefined` (the config
 * has no `worker_profiles`) gives an empty registry. Profiles are frozen copies.
 */
export function buildWorkerProfileRegistry(
	profiles: readonly unknown[] | undefined,
): WorkerProfileRegistry {
	const parsed = WorkerProfileList.parse(profiles ?? []);
	const ordered: readonly WorkerProfile[] = Object.freeze(
		parsed
			.map((p) => Object.freeze({ ...p }) as WorkerProfile)
			.sort(compareWorkerProfiles),
	);
	const byId = new Map(ordered.map((p) => [p.profile_id, p] as const));
	const enabled: readonly WorkerProfile[] = Object.freeze(
		ordered.filter((p) => p.enabled),
	);
	const select = (req: WorkerProfileRequirement = {}) =>
		Object.freeze(enabled.filter((p) => unmet(p, req) === null));

	return Object.freeze({
		size: ordered.length,
		get: (profileId: string) => byId.get(profileId) ?? null,
		resolve: (
			profileId: string,
			requirement: WorkerProfileRequirement = {},
		): WorkerProfileResolution => {
			const profile = byId.get(profileId);
			if (!profile)
				return { ok: false, reason: "unknown_profile", profile_id: profileId };
			if (!profile.enabled)
				return { ok: false, reason: "disabled_profile", profile_id: profileId };
			const reason = unmet(profile, requirement);
			if (reason) return { ok: false, reason, profile_id: profileId };
			return { ok: true, profile };
		},
		all: () => ordered,
		enabled: () => enabled,
		select,
		byRole: (role: WorkerRole) => select({ role }),
		atLeast: (minimum: WorkerCapabilityTier) =>
			select({ min_capability: minimum }),
	});
}

/** The registry for a parsed managed config (no `worker_profiles` → empty registry). */
export const workerProfileRegistryFromConfig = (
	cfg: Pick<ManagedConfig, "worker_profiles">,
): WorkerProfileRegistry => buildWorkerProfileRegistry(cfg.worker_profiles);
