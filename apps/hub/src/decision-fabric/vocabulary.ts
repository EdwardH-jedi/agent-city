// Decision Fabric routing vocabulary — the ONE place that names capability tiers and route outcomes.
//
// Routing speaks in capability concepts, never in provider models. The tiers themselves are the
// canonical Worker Profile tiers (`WORKER_LINEAR_CAPABILITY_TIERS` in @agent-city/schema); this
// file only fixes their spelling as TASK_ROUTE / ESCALATION choice tokens (upper case, like every
// other Decision Fabric choice) and is compile-checked against the canonical list, so a tier added
// or reordered there fails to compile here. Rank comes from the canonical `WORKER_CAPABILITY_RANK`.
// The off-scale `specialist` tier is never a route: it is only ever requested explicitly.
//
// HUMAN is a route OUTCOME, not a capability tier: a capability route maps to a worker profile tier,
// HUMAN means "no profile lookup — a person decides". Keep them distinct (use `routeTarget`).
import {
	WORKER_CAPABILITY_RANK,
	type WORKER_LINEAR_CAPABILITY_TIERS,
	type WorkerLinearCapabilityTier,
} from "@agent-city/schema";
import { z } from "zod";

type UppercaseTuple<T extends readonly string[]> = {
	readonly [I in keyof T]: Uppercase<T[I] & string>;
};

/** Route tokens of the canonical linear tiers, in the same (ascending) order. */
export const CAPABILITY_TIERS = [
	"FAST",
	"STANDARD",
	"SENIOR",
	"PRINCIPAL",
] as const satisfies UppercaseTuple<typeof WORKER_LINEAR_CAPABILITY_TIERS>;
export const CapabilityTier = z.enum(CAPABILITY_TIERS);
export type CapabilityTier = z.infer<typeof CapabilityTier>;

const CANONICAL_TIER: {
	readonly [T in CapabilityTier]: Lowercase<T> & WorkerLinearCapabilityTier;
} = Object.freeze({
	FAST: "fast",
	STANDARD: "standard",
	SENIOR: "senior",
	PRINCIPAL: "principal",
});

/** The canonical Worker Profile tier a route token names. */
export const toWorkerTier = (
	tier: CapabilityTier,
): WorkerLinearCapabilityTier => CANONICAL_TIER[tier];

/** The route token of a canonical linear tier. */
export const fromWorkerTier = (
	tier: WorkerLinearCapabilityTier,
): CapabilityTier => tier.toUpperCase() as Uppercase<typeof tier>;

/** The non-capability route outcome: hand the work to a person. */
export const HUMAN_ROUTE = "HUMAN";
export type HumanRoute = typeof HUMAN_ROUTE;

export const ROUTE_OUTCOMES = [...CAPABILITY_TIERS, HUMAN_ROUTE] as const;
export const RouteOutcome = z.enum(ROUTE_OUTCOMES);
export type RouteOutcome = z.infer<typeof RouteOutcome>;

export const isCapabilityRoute = (
	route: RouteOutcome,
): route is CapabilityTier => route !== HUMAN_ROUTE;

/**
 * What the integrator dispatches on: a canonical tier to look up in the Worker Profile Registry,
 * or a person.
 */
export type RouteTarget =
	| { readonly kind: "CAPABILITY"; readonly tier: WorkerLinearCapabilityTier }
	| { readonly kind: "HUMAN" };

export const routeTarget = (route: RouteOutcome): RouteTarget =>
	isCapabilityRoute(route)
		? { kind: "CAPABILITY", tier: toWorkerTier(route) }
		: { kind: "HUMAN" };

/** Canonical rank (WORKER_CAPABILITY_RANK) of a route token. */
export const tierRank = (tier: CapabilityTier): number =>
	WORKER_CAPABILITY_RANK[toWorkerTier(tier)];

export const maxTier = (
	a: CapabilityTier,
	b: CapabilityTier,
): CapabilityTier => (tierRank(a) >= tierRank(b) ? a : b);

/** The next more capable tier, or null at the top (escalating past PRINCIPAL means a person). */
export const nextTier = (tier: CapabilityTier): CapabilityTier | null =>
	CAPABILITY_TIERS[tierRank(tier) + 1] ?? null;

/** Raise a route to at least `floor`. HUMAN stays HUMAN (it is never lowered to a tier). */
export const atLeastTier = (
	route: RouteOutcome,
	floor: CapabilityTier,
): RouteOutcome => (isCapabilityRoute(route) ? maxTier(route, floor) : route);
