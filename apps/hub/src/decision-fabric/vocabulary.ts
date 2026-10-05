// Decision Fabric routing vocabulary — the ONE place that names capability tiers and route outcomes.
//
// Routing speaks in capability concepts, never in provider models. Provider/model selection happens
// later through the Worker Profile Registry; until the integrator unifies the types, this file is
// the narrow internal stand-in and is the only file to swap.
//
// HUMAN is a route OUTCOME, not a capability tier: a capability route maps to a worker profile tier,
// HUMAN means "no profile lookup — a person decides". Keep them distinct (use `routeTarget`).
import { z } from "zod";

/** Capability tiers in ascending order of capability (index = rank). */
export const CAPABILITY_TIERS = [
	"FAST",
	"STANDARD",
	"SENIOR",
	"PRINCIPAL",
] as const;
export const CapabilityTier = z.enum(CAPABILITY_TIERS);
export type CapabilityTier = z.infer<typeof CapabilityTier>;

/** The non-capability route outcome: hand the work to a person. */
export const HUMAN_ROUTE = "HUMAN";
export type HumanRoute = typeof HUMAN_ROUTE;

export const ROUTE_OUTCOMES = [...CAPABILITY_TIERS, HUMAN_ROUTE] as const;
export const RouteOutcome = z.enum(ROUTE_OUTCOMES);
export type RouteOutcome = z.infer<typeof RouteOutcome>;

export const isCapabilityRoute = (
	route: RouteOutcome,
): route is CapabilityTier => route !== HUMAN_ROUTE;

/** What the integrator dispatches on: a tier to look up in the profile registry, or a person. */
export type RouteTarget =
	| { readonly kind: "CAPABILITY"; readonly tier: CapabilityTier }
	| { readonly kind: "HUMAN" };

export const routeTarget = (route: RouteOutcome): RouteTarget =>
	isCapabilityRoute(route)
		? { kind: "CAPABILITY", tier: route }
		: { kind: "HUMAN" };

export const tierRank = (tier: CapabilityTier): number =>
	CAPABILITY_TIERS.indexOf(tier);

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
