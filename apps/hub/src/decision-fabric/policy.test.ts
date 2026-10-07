// Deterministic policy: explicit constants, and property-style sweeps over every choice × confidence
// × change-flag combination for the invariants the fabric promises. Pure and synchronous.
import { describe, expect, test } from "bun:test";
import {
	CHOICES,
	type DecisionKind,
	DecisionRequest,
	ESCALATION_CHOICES,
	POST_REVIEW_CHOICES,
	REVIEW_DEPTH_CHOICES,
	type Recommendation,
	type ReviewDepth,
} from "./contracts.ts";
import {
	type EnforcedDecision,
	enforcePolicy,
	FAIL_CLOSED_CHOICE,
	failClosedDecision,
	HUMAN_ONLY_FLAGS,
	LOW_CONFIDENCE_REVIEW_FLOOR,
	LOW_CONFIDENCE_ROUTE_FLOOR,
	MAX_ATTEMPTS_PER_TIER,
	MAX_CONSECUTIVE_FAILURES,
	MAX_SAME_TIER_REPAIRS,
	MAX_TOTAL_REPAIRS,
	MIN_CONFIDENCE,
	NON_SUPPORT_REVIEW_FLOOR,
	POLICY_RULES,
	REVIEW_FLOORS,
	ROUTE_FLOORS,
	STARVATION_WAIT_S,
} from "./policy.ts";
import {
	allChanges,
	escalation,
	FINDING_SETS,
	humanEscalate,
	overnightContinue,
	postReview,
	queuePriority,
	request,
	reverseKeys,
	reviewDepth,
	sampleChanges,
	taskRoute,
} from "./testkit.ts";
import {
	CAPABILITY_TIERS,
	type CapabilityTier,
	nextTier,
	ROUTE_OUTCOMES,
	type RouteOutcome,
	tierRank,
} from "./vocabulary.ts";

const CONFIDENCES = [0, 0.01, 0.5, 0.69, MIN_CONFIDENCE, 0.71, 0.99, 1];

const rec = (
	kind: DecisionKind,
	choice: string,
	confidence: number,
): Recommendation => ({
	decision_kind: kind,
	choice,
	confidence,
	provider: "fake:test",
	input_hash: "0".repeat(64),
	reason_codes: [],
});

const parse = (r: { decision_kind: DecisionKind; input: unknown }) =>
	DecisionRequest.parse(r);

/** Runs policy twice (second time on a key-reversed copy) and asserts the same decision. */
function enforce(
	req: DecisionRequest,
	r: Recommendation | null,
): EnforcedDecision {
	const d = enforcePolicy(req, r);
	const again = enforcePolicy(
		parse(reverseKeys(req)),
		r === null ? null : { ...r },
	);
	if (JSON.stringify(again) !== JSON.stringify(d))
		throw new Error("policy is not deterministic");
	return d;
}

const routeRank = (r: RouteOutcome) =>
	r === "HUMAN" ? CAPABILITY_TIERS.length : tierRank(r);
const reviewRank = (d: ReviewDepth) => REVIEW_DEPTH_CHOICES.indexOf(d);

describe("explicit constants", () => {
	test("thresholds, floors and fail-closed choices are pinned", () => {
		expect(MIN_CONFIDENCE).toBe(0.7);
		expect(LOW_CONFIDENCE_ROUTE_FLOOR).toBe("SENIOR");
		expect(LOW_CONFIDENCE_REVIEW_FLOOR).toBe("DEEP_REVIEW");
		expect(NON_SUPPORT_REVIEW_FLOOR).toBe("STANDARD_REVIEW");
		expect(MAX_ATTEMPTS_PER_TIER).toBe(2);
		expect(MAX_SAME_TIER_REPAIRS).toBe(2);
		expect(MAX_TOTAL_REPAIRS).toBe(4);
		expect(MAX_CONSECUTIVE_FAILURES).toBe(3);
		expect(STARVATION_WAIT_S).toBe(3600);
		expect(ROUTE_FLOORS.map((f) => [f.flag, f.floor])).toEqual([
			["touches_auth", "SENIOR"],
			["touches_authorization", "SENIOR"],
			["touches_security", "SENIOR"],
			["touches_db_migration", "SENIOR"],
		]);
		expect(REVIEW_FLOORS.map((f) => [f.flag, f.floor])).toEqual([
			["mutates_source", "STANDARD_REVIEW"],
			["touches_auth", "DEEP_REVIEW"],
			["touches_authorization", "SECOND_REVIEW"],
			["touches_security", "DEEP_REVIEW"],
			["touches_db_migration", "DEEP_REVIEW"],
		]);
		expect(HUMAN_ONLY_FLAGS.map((h) => h.flag)).toEqual([
			"requests_remote_delivery",
			"touches_deploy_or_credentials",
		]);
		expect(FAIL_CLOSED_CHOICE).toEqual({
			TASK_ROUTE: "HUMAN",
			ESCALATION: "HUMAN",
			REVIEW_DEPTH: "HUMAN_REQUIRED",
			POST_REVIEW: "HUMAN_REQUIRED",
			QUEUE_PRIORITY: "KEEP",
			HUMAN_ESCALATE: "ESCALATE_TO_HUMAN",
			OVERNIGHT_CONTINUE: "PAUSE_FOR_HUMAN",
		});
	});

	test("policy reason codes are a bounded enum of [A-Z0-9_]{1,64}", () => {
		for (const r of POLICY_RULES) expect(r).toMatch(/^[A-Z0-9_]{1,64}$/);
		expect(new Set(POLICY_RULES).size).toBe(POLICY_RULES.length);
	});

	test("every fail-closed choice belongs to its kind", () => {
		for (const [kind, choice] of Object.entries(FAIL_CLOSED_CHOICE))
			expect(CHOICES[kind as DecisionKind] as readonly string[]).toContain(
				choice,
			);
	});

	test("no decision kind has a choice that delivers, deploys or approves", () => {
		for (const choices of Object.values(CHOICES))
			for (const c of choices)
				expect(c).not.toMatch(
					/PUSH|MERGE|DEPLOY|PUBLISH|RELEASE|APPROVE|AUTHORI[SZ]E|EXECUTE/,
				);
	});
});

describe("TASK_ROUTE sweep (all 128 flag combinations × every choice × confidence grid)", () => {
	test("floors, human-only flags and low confidence always hold; policy never lowers", () => {
		const bad: string[] = [];
		for (const c of allChanges()) {
			const req = parse(request("TASK_ROUTE", taskRoute({ change: c })));
			for (const choice of [...ROUTE_OUTCOMES, null])
				for (const conf of CONFIDENCES) {
					const d = enforce(
						req,
						choice === null ? null : rec("TASK_ROUTE", choice, conf),
					);
					if (d.decision_kind !== "TASK_ROUTE") throw new Error("kind");
					const out = d.choice;
					const tag = `${JSON.stringify(c)} ${choice}@${conf} → ${out}`;
					if (d.route !== out) bad.push(`route≠choice ${tag}`);
					if (
						(c.requests_remote_delivery || c.touches_deploy_or_credentials) &&
						out !== "HUMAN"
					)
						bad.push(`human-only ${tag}`);
					if ((c.touches_auth || c.touches_authorization) && out === "FAST")
						bad.push(`auth fast ${tag}`);
					if (
						(c.touches_security || c.touches_db_migration) &&
						routeRank(out) < tierRank("SENIOR")
					)
						bad.push(`senior floor ${tag}`);
					if (choice === null && (out !== "HUMAN" || !d.fail_closed))
						bad.push(`fail closed ${tag}`);
					if (choice !== null) {
						if (routeRank(out) < routeRank(choice)) bad.push(`lowered ${tag}`);
						if (conf < MIN_CONFIDENCE && routeRank(out) < tierRank("SENIOR"))
							bad.push(`low confidence ${tag}`);
						const flagged =
							c.requests_remote_delivery ||
							c.touches_deploy_or_credentials ||
							c.touches_auth ||
							c.touches_authorization ||
							c.touches_security ||
							c.touches_db_migration;
						if (
							!flagged &&
							conf >= MIN_CONFIDENCE &&
							(out !== choice || d.policy_override !== null)
						)
							bad.push(`unflagged confident not followed ${tag}`);
					}
				}
		}
		expect(bad).toEqual([]);
	});
});

describe("REVIEW_DEPTH sweep", () => {
	test("source mutation never skips semantic review; sensitive changes get stronger review", () => {
		const bad: string[] = [];
		for (const c of allChanges())
			for (const support of [true, false]) {
				const req = parse(
					request(
						"REVIEW_DEPTH",
						reviewDepth({ change: c, support_artifact_only: support }),
					),
				);
				for (const choice of [...REVIEW_DEPTH_CHOICES, null])
					for (const conf of CONFIDENCES) {
						const d = enforce(
							req,
							choice === null ? null : rec("REVIEW_DEPTH", choice, conf),
						);
						if (d.decision_kind !== "REVIEW_DEPTH") throw new Error("kind");
						const out = d.choice;
						const tag = `${JSON.stringify(c)} support=${support} ${choice}@${conf} → ${out}`;
						if ((c.mutates_source || !support) && out === "NO_SEMANTIC_REVIEW")
							bad.push(`skipped review ${tag}`);
						if (
							(c.touches_auth ||
								c.touches_security ||
								c.touches_db_migration) &&
							reviewRank(out) < reviewRank("DEEP_REVIEW")
						)
							bad.push(`deep floor ${tag}`);
						if (
							c.touches_authorization &&
							reviewRank(out) < reviewRank("SECOND_REVIEW")
						)
							bad.push(`second floor ${tag}`);
						if (
							(c.requests_remote_delivery || c.touches_deploy_or_credentials) &&
							out !== "HUMAN_REQUIRED"
						)
							bad.push(`human-only ${tag}`);
						if (choice === null && out !== "HUMAN_REQUIRED")
							bad.push(`fail closed ${tag}`);
						if (choice !== null) {
							if (reviewRank(out) < reviewRank(choice))
								bad.push(`lowered ${tag}`);
							if (
								conf < MIN_CONFIDENCE &&
								reviewRank(out) < reviewRank("DEEP_REVIEW")
							)
								bad.push(`low confidence ${tag}`);
						}
						if (d.route !== null || d.findings !== null)
							bad.push(`extra fields ${tag}`);
					}
			}
		expect(bad).toEqual([]);
	});
});

describe("POST_REVIEW sweep", () => {
	test("REVIEWER_REJECT + any recommendation never yields READY_FOR_HUMAN; findings carried unchanged", () => {
		const bad: string[] = [];
		let cases = 0;
		for (const c of sampleChanges())
			for (const tier of CAPABILITY_TIERS)
				for (const same of [0, MAX_SAME_TIER_REPAIRS])
					for (const total of [0, MAX_TOTAL_REPAIRS])
						for (const findings of FINDING_SETS) {
							const input = postReview({
								change: c,
								reviewer_verdict: "REJECT",
								findings: [...findings],
								implementer_tier: tier,
								same_tier_repairs: same,
								total_repairs: total,
							});
							const req = parse(request("POST_REVIEW", input));
							for (const choice of [...POST_REVIEW_CHOICES, null])
								for (const conf of CONFIDENCES) {
									cases++;
									const d = enforce(
										req,
										choice === null ? null : rec("POST_REVIEW", choice, conf),
									);
									const tag = `${JSON.stringify(c)} ${tier} same=${same} total=${total} f=${findings.length} ${choice}@${conf} → ${d.choice}`;
									if (d.choice === "READY_FOR_HUMAN") bad.push(`READY ${tag}`);
									if (JSON.stringify(d.findings) !== JSON.stringify(findings))
										bad.push(`findings changed ${tag}`);
								}
						}
		expect(cases).toBe(
			9 * 4 * 2 * 2 * FINDING_SETS.length * 7 * CONFIDENCES.length,
		);
		expect(bad).toEqual([]);
	});

	test("repairs are bounded, need actionable findings and respect tier floors; routes are consistent", () => {
		const bad: string[] = [];
		for (const c of sampleChanges())
			for (const verdict of ["APPROVE", "REJECT"] as const)
				for (const tier of CAPABILITY_TIERS)
					for (const same of [0, MAX_SAME_TIER_REPAIRS])
						for (const total of [0, MAX_TOTAL_REPAIRS - 1, MAX_TOTAL_REPAIRS])
							for (const findings of FINDING_SETS) {
								const req = parse(
									request(
										"POST_REVIEW",
										postReview({
											change: c,
											reviewer_verdict: verdict,
											findings: [...findings],
											implementer_tier: tier,
											same_tier_repairs: same,
											total_repairs: total,
										}),
									),
								);
								for (const choice of [...POST_REVIEW_CHOICES, null])
									for (const conf of CONFIDENCES) {
										const d = enforce(
											req,
											choice === null ? null : rec("POST_REVIEW", choice, conf),
										);
										const out = d.choice;
										const tag = `${JSON.stringify(c)} ${verdict} ${tier} same=${same} total=${total} f=${findings.length} ${choice}@${conf} → ${out}`;
										const repair =
											out === "SAME_TIER_REPAIR" || out === "ESCALATE_REPAIR";
										if (repair && !findings.some((f) => f.actionable))
											bad.push(`no actionable ${tag}`);
										if (repair && total >= MAX_TOTAL_REPAIRS)
											bad.push(`total limit ${tag}`);
										if (
											out === "SAME_TIER_REPAIR" &&
											same >= MAX_SAME_TIER_REPAIRS
										)
											bad.push(`same limit ${tag}`);
										if (
											out === "SAME_TIER_REPAIR" &&
											(c.touches_security || c.touches_db_migration) &&
											tierRank(tier) < tierRank("SENIOR")
										)
											bad.push(`below floor ${tag}`);
										if (
											out === "SAME_TIER_REPAIR" &&
											(c.touches_auth || c.touches_authorization) &&
											tier === "FAST"
										)
											bad.push(`auth fast ${tag}`);
										if (
											out === "READY_FOR_HUMAN" &&
											(verdict !== "APPROVE" ||
												findings.some((f) => f.severity === "blocker"))
										)
											bad.push(`not ready ${tag}`);
										if (
											(c.requests_remote_delivery ||
												c.touches_deploy_or_credentials) &&
											out !== "HUMAN_REQUIRED"
										)
											bad.push(`human-only ${tag}`);
										const expectRoute: RouteOutcome | null =
											out === "READY_FOR_HUMAN" || out === "HUMAN_REQUIRED"
												? "HUMAN"
												: out === "SAME_TIER_REPAIR"
													? tier
													: null;
										if (out === "ESCALATE_REPAIR") {
											const up = nextTier(tier);
											if (
												up === null ||
												d.route === null ||
												d.route === "HUMAN" ||
												tierRank(d.route) < tierRank(up)
											)
												bad.push(`escalate route ${tag} ${d.route}`);
										} else if (d.route !== expectRoute)
											bad.push(`route ${tag} ${d.route}`);
									}
							}
		expect(bad).toEqual([]);
	});
});

describe("ESCALATION sweep", () => {
	test("retries are bounded and floored; PRINCIPAL cannot escalate to a tier", () => {
		const bad: string[] = [];
		for (const c of sampleChanges())
			for (const tier of CAPABILITY_TIERS)
				for (const attempts of [
					0,
					MAX_ATTEMPTS_PER_TIER - 1,
					MAX_ATTEMPTS_PER_TIER,
				]) {
					const req = parse(
						request(
							"ESCALATION",
							escalation({
								change: c,
								current_tier: tier,
								attempts_at_tier: attempts,
							}),
						),
					);
					for (const choice of [...ESCALATION_CHOICES, null])
						for (const conf of CONFIDENCES) {
							const d = enforce(
								req,
								choice === null ? null : rec("ESCALATION", choice, conf),
							);
							const out = d.choice;
							const tag = `${JSON.stringify(c)} ${tier} attempts=${attempts} ${choice}@${conf} → ${out} ${d.route}`;
							if (out === "RETRY_SAME_TIER") {
								if (attempts >= MAX_ATTEMPTS_PER_TIER)
									bad.push(`retry limit ${tag}`);
								if (conf < MIN_CONFIDENCE)
									bad.push(`low confidence retry ${tag}`);
								if (d.route !== tier) bad.push(`retry route ${tag}`);
								if (
									(c.touches_security || c.touches_db_migration) &&
									tierRank(tier) < tierRank("SENIOR")
								)
									bad.push(`below floor ${tag}`);
								if (
									(c.touches_auth || c.touches_authorization) &&
									tier === "FAST"
								)
									bad.push(`auth fast ${tag}`);
							}
							if (out === "ESCALATE_TIER") {
								const r = d.route;
								if (
									r === null ||
									r === "HUMAN" ||
									tierRank(r) <= tierRank(tier as CapabilityTier)
								)
									bad.push(`escalate route ${tag}`);
							}
							if (out === "HUMAN" && d.route !== "HUMAN")
								bad.push(`human route ${tag}`);
							if (tier === "PRINCIPAL" && out === "ESCALATE_TIER")
								bad.push(`no higher tier ${tag}`);
							if (
								(c.requests_remote_delivery ||
									c.touches_deploy_or_credentials) &&
								out !== "HUMAN"
							)
								bad.push(`human-only ${tag}`);
							if (choice === null && out !== "HUMAN")
								bad.push(`fail closed ${tag}`);
						}
				}
		expect(bad).toEqual([]);
	});
});

describe("QUEUE_PRIORITY / HUMAN_ESCALATE / OVERNIGHT_CONTINUE", () => {
	const one = (
		kind: DecisionKind,
		input: unknown,
		choice: string | null,
		conf = 0.9,
	) =>
		enforce(
			parse({ decision_kind: kind, input }),
			choice === null ? null : rec(kind, choice, conf),
		);

	test("queue priority: bounds, starvation guard, low confidence and fail closed keep the priority", () => {
		expect(
			one("QUEUE_PRIORITY", queuePriority({ is_repair: true }), "RAISE").choice,
		).toBe("RAISE");
		expect(
			one("QUEUE_PRIORITY", queuePriority({ current_priority: "P0" }), "RAISE")
				.choice,
		).toBe("KEEP");
		expect(
			one("QUEUE_PRIORITY", queuePriority({ current_priority: "P3" }), "LOWER")
				.choice,
		).toBe("KEEP");
		expect(
			one(
				"QUEUE_PRIORITY",
				queuePriority({ waited_s: STARVATION_WAIT_S }),
				"LOWER",
			).reason_codes,
		).toEqual(["STARVATION_GUARD"]);
		expect(
			one(
				"QUEUE_PRIORITY",
				queuePriority({ waited_s: STARVATION_WAIT_S - 1 }),
				"LOWER",
			).choice,
		).toBe("LOWER");
		expect(one("QUEUE_PRIORITY", queuePriority(), "RAISE", 0.69).choice).toBe(
			"KEEP",
		);
		const failed = one("QUEUE_PRIORITY", queuePriority(), null);
		expect([failed.choice, failed.fail_closed]).toEqual(["KEEP", true]);
	});

	test("human escalate: escalation is never downgraded", () => {
		expect(
			one("HUMAN_ESCALATE", humanEscalate(), "CONTINUE_AUTONOMOUS").choice,
		).toBe("CONTINUE_AUTONOMOUS");
		expect(
			one("HUMAN_ESCALATE", humanEscalate(), "CONTINUE_AUTONOMOUS", 0.5).choice,
		).toBe("ESCALATE_TO_HUMAN");
		expect(
			one(
				"HUMAN_ESCALATE",
				humanEscalate({ consecutive_failures: MAX_CONSECUTIVE_FAILURES }),
				"CONTINUE_AUTONOMOUS",
			).choice,
		).toBe("ESCALATE_TO_HUMAN");
		for (const flag of [
			"requests_remote_delivery",
			"touches_deploy_or_credentials",
		] as const)
			expect(
				one(
					"HUMAN_ESCALATE",
					humanEscalate({
						change: { ...humanEscalate().change, [flag]: true },
					}),
					"CONTINUE_AUTONOMOUS",
				).choice,
			).toBe("ESCALATE_TO_HUMAN");
		expect(one("HUMAN_ESCALATE", humanEscalate(), null).choice).toBe(
			"ESCALATE_TO_HUMAN",
		);
	});

	test("overnight: budget stops, failures/low confidence/human-only flags pause, STOP is never loosened", () => {
		expect(
			one("OVERNIGHT_CONTINUE", overnightContinue(), "CONTINUE").choice,
		).toBe("CONTINUE");
		expect(
			one(
				"OVERNIGHT_CONTINUE",
				overnightContinue({ budget_exhausted: true }),
				"CONTINUE",
			).choice,
		).toBe("STOP");
		expect(
			one(
				"OVERNIGHT_CONTINUE",
				overnightContinue({ consecutive_failures: MAX_CONSECUTIVE_FAILURES }),
				"CONTINUE",
			).choice,
		).toBe("PAUSE_FOR_HUMAN");
		expect(
			one("OVERNIGHT_CONTINUE", overnightContinue(), "CONTINUE", 0.1).choice,
		).toBe("PAUSE_FOR_HUMAN");
		expect(
			one("OVERNIGHT_CONTINUE", overnightContinue(), "STOP", 0.1).choice,
		).toBe("STOP");
		const deploy = overnightContinue();
		deploy.change.touches_deploy_or_credentials = true;
		expect(one("OVERNIGHT_CONTINUE", deploy, "CONTINUE").choice).toBe(
			"PAUSE_FOR_HUMAN",
		);
		expect(one("OVERNIGHT_CONTINUE", overnightContinue(), null).choice).toBe(
			"PAUSE_FOR_HUMAN",
		);
	});
});

describe("policy re-checks what it is given", () => {
	test("a recommendation for another kind, an unknown choice or an out-of-range confidence fails closed", () => {
		const req = parse(request("TASK_ROUTE", taskRoute()));
		for (const r of [
			rec("REVIEW_DEPTH", "FAST", 0.9),
			rec("TASK_ROUTE", "MERGE", 0.9),
			rec("TASK_ROUTE", "FAST", 1.5),
			rec("TASK_ROUTE", "FAST", Number.NaN),
		]) {
			const d = enforcePolicy(req, r);
			expect([d.choice, d.fail_closed]).toEqual(["HUMAN", true]);
			expect(d.reason_codes).toContain("FAIL_CLOSED_NO_RECOMMENDATION");
		}
	});

	test("invalid input fails closed per kind with an inspectable override record", () => {
		for (const kind of Object.keys(FAIL_CLOSED_CHOICE) as DecisionKind[]) {
			const d = failClosedDecision(kind);
			expect(d.choice).toBe(FAIL_CLOSED_CHOICE[kind]);
			expect(d.fail_closed).toBe(true);
			expect(d.policy_override?.steps).toEqual([
				{
					rule: "FAIL_CLOSED_INVALID_INPUT",
					from: null,
					to: FAIL_CLOSED_CHOICE[kind],
				},
			]);
		}
	});
});
