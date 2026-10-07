// Deterministic policy enforcement for Decision Fabric. Pure and synchronous: the same normalized
// request and recommendation always give the same decision. It knows nothing about providers — it
// receives a recommendation (or null) and may override it. Every threshold is an exported constant.
//
// A decision here is still ADVISORY: it never grants execution authority. The Hub's own gates and
// human approval stay authoritative; remote delivery (push/PR/merge) is not a decision at all.
import {
	type ChangeFacts,
	type Choice,
	type DecisionKind,
	type DecisionRequest,
	isChoiceOf,
	REVIEW_DEPTH_CHOICES,
	type Recommendation,
	type ReviewDepth,
	type ReviewFinding,
} from "./contracts.ts";
import {
	atLeastTier,
	type CapabilityTier,
	HUMAN_ROUTE,
	maxTier,
	nextTier,
	type RouteOutcome,
	tierRank,
} from "./vocabulary.ts";

// ── constants ───────────────────────────────────────────────────────────────────────────────

/** Below this, a recommendation is followed only in its conservative direction. */
export const MIN_CONFIDENCE = 0.7;
/** A low-confidence route is raised to at least this tier. */
export const LOW_CONFIDENCE_ROUTE_FLOOR: CapabilityTier = "SENIOR";
/** A low-confidence review depth is raised to at least this depth. */
export const LOW_CONFIDENCE_REVIEW_FLOOR: ReviewDepth = "DEEP_REVIEW";
/** Anything that is not purely read-only support artifacts gets at least this review. */
export const NON_SUPPORT_REVIEW_FLOOR: ReviewDepth = "STANDARD_REVIEW";
/** Implementation attempts at one tier before a retry must escalate. */
export const MAX_ATTEMPTS_PER_TIER = 2;
/** Repairs at the implementer's tier before a repair must escalate. */
export const MAX_SAME_TIER_REPAIRS = 2;
/** Repairs overall before a person must step in. */
export const MAX_TOTAL_REPAIRS = 4;
/** Consecutive failures before autonomy stops and a person is involved. */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** A task that has waited this long may not be lowered (no starvation). */
export const STARVATION_WAIT_S = 3600;

export const POLICY_RULES = [
	"FAIL_CLOSED_INVALID_INPUT",
	"FAIL_CLOSED_NO_RECOMMENDATION",
	"REMOTE_DELIVERY_OUT_OF_SCOPE",
	"DEPLOY_OR_CREDENTIALS_HUMAN_ONLY",
	"LOW_CONFIDENCE_CONSERVATIVE",
	"AUTH_ROUTE_FLOOR",
	"AUTHORIZATION_ROUTE_FLOOR",
	"SECURITY_ROUTE_FLOOR",
	"DB_MIGRATION_ROUTE_FLOOR",
	"SOURCE_MUTATION_REVIEW_FLOOR",
	"NON_SUPPORT_ARTIFACT_REVIEW_FLOOR",
	"AUTH_REVIEW_FLOOR",
	"AUTHORIZATION_REVIEW_FLOOR",
	"SECURITY_REVIEW_FLOOR",
	"DB_MIGRATION_REVIEW_FLOOR",
	"RETRY_LIMIT_REACHED",
	"CURRENT_TIER_BELOW_FLOOR",
	"NO_HIGHER_TIER",
	"NO_ACTIONABLE_FINDINGS",
	"SAME_TIER_REPAIR_LIMIT",
	"TOTAL_REPAIR_LIMIT",
	"BLOCKER_FINDING_NOT_READY",
	"REVIEWER_REJECT_NOT_READY",
	"REVIEWER_REJECT_NO_SECOND_OPINION",
	"CONSECUTIVE_FAILURE_LIMIT",
	"BUDGET_EXHAUSTED",
	"PRIORITY_AT_BOUND",
	"STARVATION_GUARD",
] as const;
export type PolicyRule = (typeof POLICY_RULES)[number];

/** Flags that take the decision out of Decision Fabric's hands: a person decides. */
export const HUMAN_ONLY_FLAGS = [
	{ flag: "requests_remote_delivery", rule: "REMOTE_DELIVERY_OUT_OF_SCOPE" },
	{
		flag: "touches_deploy_or_credentials",
		rule: "DEPLOY_OR_CREDENTIALS_HUMAN_ONLY",
	},
] as const satisfies readonly {
	flag: keyof ChangeFacts;
	rule: PolicyRule;
}[];

/**
 * Minimum implementation tier per sensitive flag. Authentication, authorization / approval-contract,
 * security and DB-migration changes all need at least SENIOR: auth and authorization are
 * security-sensitive, so the conservative reading of "never FAST" + "security-sensitive ≥ SENIOR"
 * applies to them too. Several flags → the highest floor.
 */
export const ROUTE_FLOORS = [
	{ flag: "touches_auth", floor: "SENIOR", rule: "AUTH_ROUTE_FLOOR" },
	{
		flag: "touches_authorization",
		floor: "SENIOR",
		rule: "AUTHORIZATION_ROUTE_FLOOR",
	},
	{ flag: "touches_security", floor: "SENIOR", rule: "SECURITY_ROUTE_FLOOR" },
	{
		flag: "touches_db_migration",
		floor: "SENIOR",
		rule: "DB_MIGRATION_ROUTE_FLOOR",
	},
] as const satisfies readonly {
	flag: keyof ChangeFacts;
	floor: CapabilityTier;
	rule: PolicyRule;
}[];

/** Minimum review depth per flag. Any source mutation needs semantic review; sensitive ones more. */
export const REVIEW_FLOORS = [
	{
		flag: "mutates_source",
		floor: "STANDARD_REVIEW",
		rule: "SOURCE_MUTATION_REVIEW_FLOOR",
	},
	{ flag: "touches_auth", floor: "DEEP_REVIEW", rule: "AUTH_REVIEW_FLOOR" },
	{
		flag: "touches_authorization",
		floor: "SECOND_REVIEW",
		rule: "AUTHORIZATION_REVIEW_FLOOR",
	},
	{
		flag: "touches_security",
		floor: "DEEP_REVIEW",
		rule: "SECURITY_REVIEW_FLOOR",
	},
	{
		flag: "touches_db_migration",
		floor: "DEEP_REVIEW",
		rule: "DB_MIGRATION_REVIEW_FLOOR",
	},
] as const satisfies readonly {
	flag: keyof ChangeFacts;
	floor: ReviewDepth;
	rule: PolicyRule;
}[];

/**
 * What each kind becomes when there is no usable recommendation or input. Six of seven involve a
 * person; QUEUE_PRIORITY fails closed to KEEP (no priority change) — the least-authority outcome.
 */
export const FAIL_CLOSED_CHOICE = {
	TASK_ROUTE: "HUMAN",
	ESCALATION: "HUMAN",
	REVIEW_DEPTH: "HUMAN_REQUIRED",
	POST_REVIEW: "HUMAN_REQUIRED",
	QUEUE_PRIORITY: "KEEP",
	HUMAN_ESCALATE: "ESCALATE_TO_HUMAN",
	OVERNIGHT_CONTINUE: "PAUSE_FOR_HUMAN",
} as const satisfies { [K in DecisionKind]: Choice<K> };

// ── decision shape ──────────────────────────────────────────────────────────────────────────

/** One change the policy made to the choice. `from` is null when there was nothing to override. */
export type PolicyStep<C extends string = string> = Readonly<{
	rule: PolicyRule;
	from: C | null;
	to: C;
}>;

/** The record of a policy override: recommended → enforced, and every step in between. */
export type PolicyOverride<C extends string = string> = Readonly<{
	from: C | null;
	to: C;
	steps: readonly PolicyStep<C>[];
}>;

export type EnforcedDecisionFor<K extends DecisionKind> = Readonly<{
	decision_kind: K;
	/** The enforced choice. Advisory: it never grants execution authority. */
	choice: Choice<K>;
	/** Final routing recommendation (TASK_ROUTE / ESCALATION / POST_REVIEW), else null. */
	route: RouteOutcome | null;
	/** True when there was no usable input or recommendation and the kind's fail-closed choice applies. */
	fail_closed: boolean;
	/** Every policy rule whose condition held, in evaluation order (bounded enum). */
	reason_codes: readonly PolicyRule[];
	/** null when the recommendation was followed unchanged. */
	policy_override: PolicyOverride<Choice<K>> | null;
	/** POST_REVIEW: the reviewer findings, carried through unchanged. Otherwise null. */
	findings: readonly ReviewFinding[] | null;
}>;
export type EnforcedDecision = {
	[K in DecisionKind]: EnforcedDecisionFor<K>;
}[DecisionKind];

// ── engine ──────────────────────────────────────────────────────────────────────────────────

type RequestOf<K extends DecisionKind> = Extract<
	DecisionRequest,
	{ decision_kind: K }
>;

interface Trace<C extends string> {
	choice: C;
	readonly from: C | null;
	readonly steps: PolicyStep<C>[];
	readonly codes: PolicyRule[];
}

function startTrace<C extends string>(rec: C | null, failClosed: C): Trace<C> {
	if (rec !== null) return { choice: rec, from: rec, steps: [], codes: [] };
	return {
		choice: failClosed,
		from: null,
		steps: [
			{ rule: "FAIL_CLOSED_NO_RECOMMENDATION", from: null, to: failClosed },
		],
		codes: ["FAIL_CLOSED_NO_RECOMMENDATION"],
	};
}

/** Record that `rule` applied and move the choice to `to` (a no-op move records no step). */
function apply<C extends string>(t: Trace<C>, rule: PolicyRule, to: C): void {
	if (!t.codes.includes(rule)) t.codes.push(rule);
	if (to !== t.choice) {
		t.steps.push({ rule, from: t.choice, to });
		t.choice = to;
	}
}

function finish<K extends DecisionKind>(
	kind: K,
	t: Trace<Choice<K>>,
	route: RouteOutcome | null,
	findings: readonly ReviewFinding[] | null,
): EnforcedDecisionFor<K> {
	return {
		decision_kind: kind,
		choice: t.choice,
		route,
		fail_closed: t.from === null,
		reason_codes: [...t.codes],
		policy_override:
			t.steps.length === 0
				? null
				: { from: t.from, to: t.choice, steps: [...t.steps] },
		findings,
	};
}

type Usable<K extends DecisionKind> = { choice: Choice<K>; confidence: number };

/** A recommendation counts only if it is for this kind, names one of its choices and is bounded. */
function usable<K extends DecisionKind>(
	kind: K,
	rec: Recommendation | null,
): Usable<K> | null {
	if (rec === null || rec.decision_kind !== kind) return null;
	const { choice, confidence } = rec;
	if (!isChoiceOf(kind, choice)) return null;
	if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
		return null;
	return { choice, confidence };
}

const lowConfidence = (rec: Usable<DecisionKind> | null): boolean =>
	rec !== null && rec.confidence < MIN_CONFIDENCE;

const humanOnly = (change: ChangeFacts) =>
	HUMAN_ONLY_FLAGS.filter((h) => change[h.flag]);

/** The highest route floor the change's flags impose (null = none), applying each rule's code. */
function routeFloor<C extends string>(
	t: Trace<C>,
	change: ChangeFacts,
): CapabilityTier | null {
	let floor: CapabilityTier | null = null;
	for (const f of ROUTE_FLOORS) {
		if (!change[f.flag]) continue;
		if (!t.codes.includes(f.rule)) t.codes.push(f.rule);
		floor = floor === null ? f.floor : maxTier(floor, f.floor);
	}
	return floor;
}

const reviewRank = (d: ReviewDepth) => REVIEW_DEPTH_CHOICES.indexOf(d);
const atLeastReview = (d: ReviewDepth, floor: ReviewDepth): ReviewDepth =>
	reviewRank(d) >= reviewRank(floor) ? d : floor;

function taskRoute(
	req: RequestOf<"TASK_ROUTE">,
	rec: Usable<"TASK_ROUTE"> | null,
): EnforcedDecisionFor<"TASK_ROUTE"> {
	const { change } = req.input;
	const t = startTrace(rec?.choice ?? null, FAIL_CLOSED_CHOICE.TASK_ROUTE);
	for (const h of humanOnly(change)) apply(t, h.rule, HUMAN_ROUTE);
	if (lowConfidence(rec))
		apply(
			t,
			"LOW_CONFIDENCE_CONSERVATIVE",
			atLeastTier(t.choice, LOW_CONFIDENCE_ROUTE_FLOOR),
		);
	for (const f of ROUTE_FLOORS)
		if (change[f.flag]) apply(t, f.rule, atLeastTier(t.choice, f.floor));
	return finish("TASK_ROUTE", t, t.choice, null);
}

function escalation(
	req: RequestOf<"ESCALATION">,
	rec: Usable<"ESCALATION"> | null,
): EnforcedDecisionFor<"ESCALATION"> {
	const { change, current_tier, attempts_at_tier } = req.input;
	const t = startTrace(rec?.choice ?? null, FAIL_CLOSED_CHOICE.ESCALATION);
	for (const h of humanOnly(change)) apply(t, h.rule, "HUMAN");
	if (lowConfidence(rec) && t.choice === "RETRY_SAME_TIER")
		apply(t, "LOW_CONFIDENCE_CONSERVATIVE", "ESCALATE_TIER");
	if (
		t.choice === "RETRY_SAME_TIER" &&
		attempts_at_tier >= MAX_ATTEMPTS_PER_TIER
	)
		apply(t, "RETRY_LIMIT_REACHED", "ESCALATE_TIER");
	const floor = routeFloor(t, change);
	if (
		t.choice === "RETRY_SAME_TIER" &&
		floor !== null &&
		tierRank(current_tier) < tierRank(floor)
	)
		apply(t, "CURRENT_TIER_BELOW_FLOOR", "ESCALATE_TIER");
	const up = nextTier(current_tier);
	if (t.choice === "ESCALATE_TIER" && up === null)
		apply(t, "NO_HIGHER_TIER", "HUMAN");
	const route: RouteOutcome =
		t.choice === "RETRY_SAME_TIER"
			? current_tier
			: t.choice === "ESCALATE_TIER" && up !== null
				? floor === null
					? up
					: maxTier(up, floor)
				: HUMAN_ROUTE;
	return finish("ESCALATION", t, route, null);
}

function reviewDepth(
	req: RequestOf<"REVIEW_DEPTH">,
	rec: Usable<"REVIEW_DEPTH"> | null,
): EnforcedDecisionFor<"REVIEW_DEPTH"> {
	const { change, support_artifact_only } = req.input;
	const t = startTrace(rec?.choice ?? null, FAIL_CLOSED_CHOICE.REVIEW_DEPTH);
	for (const h of humanOnly(change)) apply(t, h.rule, "HUMAN_REQUIRED");
	if (lowConfidence(rec))
		apply(
			t,
			"LOW_CONFIDENCE_CONSERVATIVE",
			atLeastReview(t.choice, LOW_CONFIDENCE_REVIEW_FLOOR),
		);
	if (!support_artifact_only)
		apply(
			t,
			"NON_SUPPORT_ARTIFACT_REVIEW_FLOOR",
			atLeastReview(t.choice, NON_SUPPORT_REVIEW_FLOOR),
		);
	for (const f of REVIEW_FLOORS)
		if (change[f.flag]) apply(t, f.rule, atLeastReview(t.choice, f.floor));
	return finish("REVIEW_DEPTH", t, null, null);
}

function postReview(
	req: RequestOf<"POST_REVIEW">,
	rec: Usable<"POST_REVIEW"> | null,
): EnforcedDecisionFor<"POST_REVIEW"> {
	const {
		change,
		reviewer_verdict,
		findings,
		implementer_tier,
		same_tier_repairs,
		total_repairs,
	} = req.input;
	const t = startTrace(rec?.choice ?? null, FAIL_CLOSED_CHOICE.POST_REVIEW);
	const isRepair = () =>
		t.choice === "SAME_TIER_REPAIR" || t.choice === "ESCALATE_REPAIR";

	for (const h of humanOnly(change)) apply(t, h.rule, "HUMAN_REQUIRED");
	if (lowConfidence(rec))
		apply(t, "LOW_CONFIDENCE_CONSERVATIVE", "HUMAN_REQUIRED");
	if (isRepair() && !findings.some((f) => f.actionable))
		apply(t, "NO_ACTIONABLE_FINDINGS", "HUMAN_REQUIRED");
	if (
		t.choice === "SAME_TIER_REPAIR" &&
		same_tier_repairs >= MAX_SAME_TIER_REPAIRS
	)
		apply(t, "SAME_TIER_REPAIR_LIMIT", "ESCALATE_REPAIR");
	const floor = routeFloor(t, change);
	if (
		t.choice === "SAME_TIER_REPAIR" &&
		floor !== null &&
		tierRank(implementer_tier) < tierRank(floor)
	)
		apply(t, "CURRENT_TIER_BELOW_FLOOR", "ESCALATE_REPAIR");
	if (isRepair() && total_repairs >= MAX_TOTAL_REPAIRS)
		apply(t, "TOTAL_REPAIR_LIMIT", "HUMAN_REQUIRED");
	const up = nextTier(implementer_tier);
	if (t.choice === "ESCALATE_REPAIR" && up === null)
		apply(t, "NO_HIGHER_TIER", "HUMAN_REQUIRED");
	if (
		t.choice === "READY_FOR_HUMAN" &&
		findings.some((f) => f.severity === "blocker")
	)
		apply(t, "BLOCKER_FINDING_NOT_READY", "HUMAN_REQUIRED");
	// Last, so no earlier step can undo it: a reviewer REJECT is never "ready", whatever was recommended,
	// and is never sent shopping for another reviewer's opinion — after a rejection the outcomes are a
	// repair (actionable findings), a person, or STOP.
	if (reviewer_verdict === "REJECT" && t.choice === "READY_FOR_HUMAN")
		apply(t, "REVIEWER_REJECT_NOT_READY", "HUMAN_REQUIRED");
	if (reviewer_verdict === "REJECT" && t.choice === "SECOND_REVIEW")
		apply(t, "REVIEWER_REJECT_NO_SECOND_OPINION", "HUMAN_REQUIRED");

	let route: RouteOutcome | null = null;
	if (t.choice === "READY_FOR_HUMAN" || t.choice === "HUMAN_REQUIRED")
		route = HUMAN_ROUTE;
	else if (t.choice === "SAME_TIER_REPAIR") route = implementer_tier;
	else if (t.choice === "ESCALATE_REPAIR" && up !== null)
		route = floor === null ? up : maxTier(up, floor);
	return finish(
		"POST_REVIEW",
		t,
		route,
		findings.map((f) => ({ ...f })),
	);
}

function queuePriority(
	req: RequestOf<"QUEUE_PRIORITY">,
	rec: Usable<"QUEUE_PRIORITY"> | null,
): EnforcedDecisionFor<"QUEUE_PRIORITY"> {
	const { current_priority, waited_s } = req.input;
	const t = startTrace(rec?.choice ?? null, FAIL_CLOSED_CHOICE.QUEUE_PRIORITY);
	if (lowConfidence(rec)) apply(t, "LOW_CONFIDENCE_CONSERVATIVE", "KEEP");
	if (
		(t.choice === "RAISE" && current_priority === "P0") ||
		(t.choice === "LOWER" && current_priority === "P3")
	)
		apply(t, "PRIORITY_AT_BOUND", "KEEP");
	if (t.choice === "LOWER" && waited_s >= STARVATION_WAIT_S)
		apply(t, "STARVATION_GUARD", "KEEP");
	return finish("QUEUE_PRIORITY", t, null, null);
}

function humanEscalate(
	req: RequestOf<"HUMAN_ESCALATE">,
	rec: Usable<"HUMAN_ESCALATE"> | null,
): EnforcedDecisionFor<"HUMAN_ESCALATE"> {
	const { change, consecutive_failures } = req.input;
	const t = startTrace(rec?.choice ?? null, FAIL_CLOSED_CHOICE.HUMAN_ESCALATE);
	for (const h of humanOnly(change)) apply(t, h.rule, "ESCALATE_TO_HUMAN");
	if (lowConfidence(rec))
		apply(t, "LOW_CONFIDENCE_CONSERVATIVE", "ESCALATE_TO_HUMAN");
	if (consecutive_failures >= MAX_CONSECUTIVE_FAILURES)
		apply(t, "CONSECUTIVE_FAILURE_LIMIT", "ESCALATE_TO_HUMAN");
	return finish("HUMAN_ESCALATE", t, null, null);
}

function overnightContinue(
	req: RequestOf<"OVERNIGHT_CONTINUE">,
	rec: Usable<"OVERNIGHT_CONTINUE"> | null,
): EnforcedDecisionFor<"OVERNIGHT_CONTINUE"> {
	const { change, consecutive_failures, budget_exhausted } = req.input;
	const t = startTrace(
		rec?.choice ?? null,
		FAIL_CLOSED_CHOICE.OVERNIGHT_CONTINUE,
	);
	// "Do not continue unattended": PAUSE_FOR_HUMAN, unless already STOP (which is more final).
	const halt = () => (t.choice === "STOP" ? "STOP" : "PAUSE_FOR_HUMAN");
	for (const h of humanOnly(change)) apply(t, h.rule, halt());
	if (lowConfidence(rec)) apply(t, "LOW_CONFIDENCE_CONSERVATIVE", halt());
	if (consecutive_failures >= MAX_CONSECUTIVE_FAILURES)
		apply(t, "CONSECUTIVE_FAILURE_LIMIT", halt());
	if (budget_exhausted) apply(t, "BUDGET_EXHAUSTED", "STOP");
	return finish("OVERNIGHT_CONTINUE", t, null, null);
}

/**
 * Enforce policy on a (validated) request and a provider recommendation, or null when there is
 * none. The recommendation is re-checked here (kind, choice set, confidence bounds): anything not
 * usable fails closed. Deterministic: no clock, no randomness, no I/O.
 */
export function enforcePolicy(
	request: DecisionRequest,
	recommendation: Recommendation | null,
): EnforcedDecision {
	switch (request.decision_kind) {
		case "TASK_ROUTE":
			return taskRoute(request, usable("TASK_ROUTE", recommendation));
		case "ESCALATION":
			return escalation(request, usable("ESCALATION", recommendation));
		case "REVIEW_DEPTH":
			return reviewDepth(request, usable("REVIEW_DEPTH", recommendation));
		case "POST_REVIEW":
			return postReview(request, usable("POST_REVIEW", recommendation));
		case "QUEUE_PRIORITY":
			return queuePriority(request, usable("QUEUE_PRIORITY", recommendation));
		case "HUMAN_ESCALATE":
			return humanEscalate(request, usable("HUMAN_ESCALATE", recommendation));
		case "OVERNIGHT_CONTINUE":
			return overnightContinue(
				request,
				usable("OVERNIGHT_CONTINUE", recommendation),
			);
		default: {
			const never: never = request;
			return never;
		}
	}
}

const FAIL_CLOSED_ROUTE: Readonly<Record<DecisionKind, RouteOutcome | null>> = {
	TASK_ROUTE: HUMAN_ROUTE,
	ESCALATION: HUMAN_ROUTE,
	REVIEW_DEPTH: null,
	POST_REVIEW: HUMAN_ROUTE,
	QUEUE_PRIORITY: null,
	HUMAN_ESCALATE: null,
	OVERNIGHT_CONTINUE: null,
};

/** The decision for a known kind whose input did not validate: the kind's fail-closed choice. */
export function failClosedDecision<K extends DecisionKind>(
	kind: K,
): EnforcedDecisionFor<K> {
	const to: Choice<K> = FAIL_CLOSED_CHOICE[kind];
	return {
		decision_kind: kind,
		choice: to,
		route: FAIL_CLOSED_ROUTE[kind],
		fail_closed: true,
		reason_codes: ["FAIL_CLOSED_INVALID_INPUT"],
		policy_override: {
			from: null,
			to,
			steps: [{ rule: "FAIL_CLOSED_INVALID_INPUT", from: null, to }],
		},
		findings: null,
	};
}
