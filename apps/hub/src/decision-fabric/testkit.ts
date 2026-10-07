// Test builders for Decision Fabric requests. Structured facts only; no repo names, no secrets.
import type {
	ChangeFacts,
	DecisionInput,
	DecisionKind,
	ReviewFinding,
} from "./contracts.ts";

/** A plain source change: mutates source, touches nothing sensitive. */
export const change = (over: Partial<ChangeFacts> = {}): ChangeFacts => ({
	mutates_source: true,
	touches_auth: false,
	touches_authorization: false,
	touches_security: false,
	touches_db_migration: false,
	touches_deploy_or_credentials: false,
	requests_remote_delivery: false,
	...over,
});

export const CHANGE_FLAGS = Object.keys(change()) as (keyof ChangeFacts)[];

/** Every combination of the change flags (2^7). */
export function allChanges(): ChangeFacts[] {
	const out: ChangeFacts[] = [];
	for (let mask = 0; mask < 1 << CHANGE_FLAGS.length; mask++) {
		const c = change({ mutates_source: false });
		CHANGE_FLAGS.forEach((flag, i) => {
			c[flag] = (mask & (1 << i)) !== 0;
		});
		out.push(c);
	}
	return out;
}

/** No flags, each flag alone, all flags — a representative subset for large sweeps. */
export function sampleChanges(): ChangeFacts[] {
	const none = change({ mutates_source: false });
	const all = { ...none };
	for (const f of CHANGE_FLAGS) all[f] = true;
	return [none, ...CHANGE_FLAGS.map((f) => ({ ...none, [f]: true })), all];
}

export const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
	severity: "major",
	title: "Missing bounds check",
	detail: "The loop reads one element past the end of the buffer.",
	file: "src/buffer.ts",
	line: 42,
	actionable: true,
	...over,
});

export const FINDING_SETS: readonly (readonly ReviewFinding[])[] = [
	[],
	[finding()],
	[finding({ severity: "minor", actionable: false })],
	[
		finding({ severity: "blocker" }),
		finding({ severity: "info", actionable: false }),
	],
];

export const request = <K extends DecisionKind>(
	decision_kind: K,
	input: DecisionInput<K>,
) => ({ decision_kind, input });

export const taskRoute = (
	over: Partial<DecisionInput<"TASK_ROUTE">> = {},
): DecisionInput<"TASK_ROUTE"> => ({
	change: change(),
	scope: "TRIVIAL",
	...over,
});

export const escalation = (
	over: Partial<DecisionInput<"ESCALATION">> = {},
): DecisionInput<"ESCALATION"> => ({
	change: change(),
	current_tier: "STANDARD",
	attempts_at_tier: 0,
	failure: "VERIFICATION_FAILED",
	...over,
});

export const reviewDepth = (
	over: Partial<DecisionInput<"REVIEW_DEPTH">> = {},
): DecisionInput<"REVIEW_DEPTH"> => ({
	change: change(),
	support_artifact_only: false,
	...over,
});

export const postReview = (
	over: Partial<DecisionInput<"POST_REVIEW">> = {},
): DecisionInput<"POST_REVIEW"> => ({
	change: change(),
	reviewer_verdict: "REJECT",
	findings: [finding()],
	implementer_tier: "STANDARD",
	same_tier_repairs: 0,
	total_repairs: 0,
	...over,
});

export const queuePriority = (
	over: Partial<DecisionInput<"QUEUE_PRIORITY">> = {},
): DecisionInput<"QUEUE_PRIORITY"> => ({
	current_priority: "P2",
	waited_s: 60,
	is_repair: false,
	...over,
});

export const humanEscalate = (
	over: Partial<DecisionInput<"HUMAN_ESCALATE">> = {},
): DecisionInput<"HUMAN_ESCALATE"> => ({
	change: change(),
	consecutive_failures: 0,
	...over,
});

export const overnightContinue = (
	over: Partial<DecisionInput<"OVERNIGHT_CONTINUE">> = {},
): DecisionInput<"OVERNIGHT_CONTINUE"> => ({
	change: change(),
	consecutive_failures: 0,
	budget_exhausted: false,
	...over,
});

/** One valid request per decision kind. */
export const ONE_OF_EACH = [
	request("TASK_ROUTE", taskRoute()),
	request("ESCALATION", escalation()),
	request("REVIEW_DEPTH", reviewDepth()),
	request("POST_REVIEW", postReview()),
	request("QUEUE_PRIORITY", queuePriority()),
	request("HUMAN_ESCALATE", humanEscalate()),
	request("OVERNIGHT_CONTINUE", overnightContinue()),
] as const;

/** The same JSON value with every object's keys inserted in reverse order. */
export function reverseKeys<T>(value: T): T {
	if (Array.isArray(value)) return value.map(reverseKeys) as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(value).reverse())
			out[k] = reverseKeys((value as Record<string, unknown>)[k]);
		return out as T;
	}
	return value;
}
