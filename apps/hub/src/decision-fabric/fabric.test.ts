// End-to-end Decision Fabric: provider → strict validation → policy → advisory result.
// In-process fake providers only.
import { describe, expect, test } from "bun:test";
import { CHOICES, DecisionRequest, POST_REVIEW_CHOICES } from "./contracts.ts";
import {
	type DecisionResult,
	decide,
	type FabricOutcome,
	MAX_PROVIDER_TIMEOUT_MS,
	PROVIDER_TIMEOUT_MS,
} from "./fabric.ts";
import {
	fixedProvider,
	hangingProvider,
	rawProvider,
	rulesProvider,
	throwingProvider,
} from "./fake-provider.ts";
import { hashDecisionInput } from "./hash.ts";
import { MIN_CONFIDENCE } from "./policy.ts";
import type { DecisionProvider } from "./provider.ts";
import {
	change,
	FINDING_SETS,
	finding,
	ONE_OF_EACH,
	postReview,
	request,
	reviewDepth,
	taskRoute,
} from "./testkit.ts";
import { routeTarget } from "./vocabulary.ts";

function decided(o: FabricOutcome): DecisionResult {
	if (o.outcome !== "DECIDED")
		throw new Error(`expected DECIDED, got ${o.outcome}`);
	return o;
}

const route = (
	scope: "TRIVIAL" | "LARGE",
	over: Parameters<typeof change>[0] = {},
) => request("TASK_ROUTE", taskRoute({ scope, change: change(over) }));

/** A well-formed recommendation for `req`, echoing kind and hash, with overrides applied. */
const answerFor =
	(
		choice: string,
		confidence: number,
		extra: Record<string, unknown> = {},
		id = "fake:raw",
	) =>
	(req: { decision_kind: string; input_hash: string }) => ({
		decision_kind: req.decision_kind,
		choice,
		confidence,
		provider: id,
		input_hash: req.input_hash,
		reason_codes: [],
		...extra,
	});

describe("1 — deterministic fake provider", () => {
	test("rulesProvider gives the same accepted recommendation every time, for every kind", async () => {
		for (const req of ONE_OF_EACH) {
			const a = decided(await decide(rulesProvider(), req));
			const b = decided(await decide(rulesProvider(), structuredClone(req)));
			expect(b).toEqual(a);
			expect(a.recommendation_status).toBe("ACCEPTED");
			expect(a.recommendation?.provider).toBe("fake:rules");
			expect(a.recommendation?.input_hash).toBe(
				hashDecisionInput(req.decision_kind, DecisionRequest.parse(req).input),
			);
		}
	});

	test("rulesProvider routes by scope", async () => {
		const r = decided(await decide(rulesProvider(), route("TRIVIAL")));
		expect(r.recommendation).toMatchObject({
			decision_kind: "TASK_ROUTE",
			choice: "FAST",
			confidence: 0.9,
			reason_codes: ["SCOPE_TRIVIAL"],
		});
	});
});

describe("3 — high-confidence safe routing", () => {
	test("a confident FAST recommendation on a plain change is followed unchanged", async () => {
		const r = decided(
			await decide(
				fixedProvider({ choice: "FAST", confidence: 0.95 }),
				route("TRIVIAL"),
			),
		);
		expect(r.decision).toMatchObject({
			choice: "FAST",
			route: "FAST",
			fail_closed: false,
			reason_codes: [],
			policy_override: null,
		});
		// the capability route names the canonical Worker Profile tier
		expect(routeTarget(r.decision.route ?? "HUMAN")).toEqual({
			kind: "CAPABILITY",
			tier: "fast",
		});
	});
});

describe("4 — low confidence routes conservatively", () => {
	test("FAST at 0.69 is raised to SENIOR; at exactly MIN_CONFIDENCE it is followed", async () => {
		const low = decided(
			await decide(
				fixedProvider({ choice: "FAST", confidence: 0.69 }),
				route("TRIVIAL"),
			),
		);
		expect(low.decision.choice).toBe("SENIOR");
		expect(low.decision.policy_override?.steps).toEqual([
			{ rule: "LOW_CONFIDENCE_CONSERVATIVE", from: "FAST", to: "SENIOR" },
		]);
		const edge = decided(
			await decide(
				fixedProvider({ choice: "FAST", confidence: MIN_CONFIDENCE }),
				route("TRIVIAL"),
			),
		);
		expect(edge.decision.choice).toBe("FAST");
	});

	test("low confidence never lowers: PRINCIPAL and HUMAN stay", async () => {
		for (const choice of ["PRINCIPAL", "HUMAN"] as const) {
			const r = decided(
				await decide(
					fixedProvider({ choice, confidence: 0.1 }),
					route("LARGE"),
				),
			);
			expect(r.decision.choice).toBe(choice);
		}
	});

	test("low-confidence post-review goes to a human", async () => {
		const r = decided(
			await decide(
				fixedProvider({ choice: "READY_FOR_HUMAN", confidence: 0.5 }),
				request(
					"POST_REVIEW",
					postReview({ reviewer_verdict: "APPROVE", findings: [] }),
				),
			),
		);
		expect(r.decision.choice).toBe("HUMAN_REQUIRED");
	});
});

describe("5 — auth / authorization / security / deploy overrides", () => {
	const cases = [
		[{ touches_auth: true }, "FAST", "SENIOR", "AUTH_ROUTE_FLOOR"],
		[{ touches_auth: true }, "STANDARD", "SENIOR", "AUTH_ROUTE_FLOOR"],
		[
			{ touches_authorization: true },
			"FAST",
			"SENIOR",
			"AUTHORIZATION_ROUTE_FLOOR",
		],
		[{ touches_security: true }, "FAST", "SENIOR", "SECURITY_ROUTE_FLOOR"],
		[{ touches_security: true }, "STANDARD", "SENIOR", "SECURITY_ROUTE_FLOOR"],
		[
			{ touches_deploy_or_credentials: true },
			"PRINCIPAL",
			"HUMAN",
			"DEPLOY_OR_CREDENTIALS_HUMAN_ONLY",
		],
		[
			{ requests_remote_delivery: true },
			"FAST",
			"HUMAN",
			"REMOTE_DELIVERY_OUT_OF_SCOPE",
		],
	] as const;
	for (const [flags, from, to, rule] of cases)
		test(`${Object.keys(flags)[0]}: confident ${from} → ${to}`, async () => {
			const r = decided(
				await decide(
					fixedProvider({ choice: from, confidence: 0.99 }),
					route("TRIVIAL", flags),
				),
			);
			expect(r.recommendation?.choice).toBe(from);
			expect(r.decision.choice).toBe(to);
			expect(r.decision.reason_codes).toContain(rule);
			expect(r.decision.policy_override).toEqual({
				from,
				to,
				steps: [{ rule, from, to }],
			});
		});

	test("HUMAN is a route outcome, not a capability tier", async () => {
		const r = decided(
			await decide(
				fixedProvider({ choice: "FAST", confidence: 0.99 }),
				route("TRIVIAL", { touches_deploy_or_credentials: true }),
			),
		);
		expect(routeTarget(r.decision.route ?? "FAST")).toEqual({ kind: "HUMAN" });
	});
});

describe("6 — database migrations need at least SENIOR", () => {
	for (const [from, to] of [
		["FAST", "SENIOR"],
		["STANDARD", "SENIOR"],
		["SENIOR", "SENIOR"],
		["PRINCIPAL", "PRINCIPAL"],
	] as const)
		test(`${from} → ${to}`, async () => {
			const r = decided(
				await decide(
					fixedProvider({ choice: from, confidence: 0.99 }),
					route("TRIVIAL", { touches_db_migration: true }),
				),
			);
			expect(r.decision.choice).toBe(to);
			expect(r.decision.reason_codes).toContain("DB_MIGRATION_ROUTE_FLOOR");
			expect(r.decision.policy_override === null).toBe(from === to);
		});
});

describe("7 — a reviewer REJECT never becomes READY_FOR_HUMAN", () => {
	test("every choice (valid or not) × confidence × provider behaviour, through decide()", async () => {
		const choices = [
			...POST_REVIEW_CHOICES,
			"APPROVE",
			"MERGE",
			"ready_for_human",
			"READY_FOR_HUMAN_NOW",
		];
		const confidences = [0, 0.3, 0.69, 0.7, 0.71, 1, 1.5, -0.1, Number.NaN];
		const providers: DecisionProvider[] = [
			throwingProvider(),
			rawProvider(() => ({ choice: "READY_FOR_HUMAN" })),
		];
		for (const choice of choices)
			for (const confidence of confidences)
				providers.push(rawProvider(answerFor(choice, confidence)));
		let n = 0;
		for (const findings of FINDING_SETS) {
			const req = request(
				"POST_REVIEW",
				postReview({ reviewer_verdict: "REJECT", findings: [...findings] }),
			);
			for (const p of providers) {
				const r = decided(await decide(p, req));
				n++;
				expect(r.decision.choice).not.toBe("READY_FOR_HUMAN");
				expect(r.decision.findings).toEqual(findings);
			}
		}
		expect(n).toBe(
			FINDING_SETS.length * (2 + choices.length * confidences.length),
		);
	});

	test("the override is recorded and the reviewer findings are carried through intact", async () => {
		const findings = [
			finding(),
			finding({ severity: "minor", title: "Naming", actionable: false }),
		];
		const r = decided(
			await decide(
				fixedProvider({ choice: "READY_FOR_HUMAN", confidence: 0.99 }),
				request(
					"POST_REVIEW",
					postReview({ reviewer_verdict: "REJECT", findings }),
				),
			),
		);
		expect(r.recommendation?.choice).toBe("READY_FOR_HUMAN");
		expect(r.decision.choice).toBe("HUMAN_REQUIRED");
		expect(r.decision.route).toBe("HUMAN");
		expect(r.decision.policy_override?.steps).toEqual([
			{
				rule: "REVIEWER_REJECT_NOT_READY",
				from: "READY_FOR_HUMAN",
				to: "HUMAN_REQUIRED",
			},
		]);
		expect(r.decision.findings).toEqual(findings);
	});

	test("after a REJECT a confident SECOND_REVIEW is not review shopping: a person decides", async () => {
		const findings = [finding()];
		const r = decided(
			await decide(
				fixedProvider({ choice: "SECOND_REVIEW", confidence: 0.99 }),
				request(
					"POST_REVIEW",
					postReview({ reviewer_verdict: "REJECT", findings }),
				),
			),
		);
		expect(r.decision.choice).toBe("HUMAN_REQUIRED");
		expect(r.decision.route).toBe("HUMAN");
		expect(r.decision.policy_override?.steps).toEqual([
			{
				rule: "REVIEWER_REJECT_NO_SECOND_OPINION",
				from: "SECOND_REVIEW",
				to: "HUMAN_REQUIRED",
			},
		]);
		// an APPROVE may still ask for more scrutiny
		const ok = decided(
			await decide(
				fixedProvider({ choice: "SECOND_REVIEW", confidence: 0.99 }),
				request("POST_REVIEW", postReview({ reviewer_verdict: "APPROVE" })),
			),
		);
		expect(ok.decision.choice).toBe("SECOND_REVIEW");
	});

	test("a provider cannot overwrite findings: a `findings` key in its output is rejected", async () => {
		const req = request(
			"POST_REVIEW",
			postReview({ reviewer_verdict: "REJECT" }),
		);
		const r = decided(
			await decide(
				rawProvider(answerFor("SAME_TIER_REPAIR", 0.9, { findings: [] })),
				req,
			),
		);
		expect(r.rejection_code).toBe("OUTPUT_INVALID");
		expect(r.decision.findings).toEqual(req.input.findings);
	});

	test("APPROVE with no blocker and a confident READY is followed", async () => {
		const r = decided(
			await decide(
				fixedProvider({ choice: "READY_FOR_HUMAN", confidence: 0.9 }),
				request(
					"POST_REVIEW",
					postReview({ reviewer_verdict: "APPROVE", findings: [] }),
				),
			),
		);
		expect([r.decision.choice, r.decision.policy_override]).toEqual([
			"READY_FOR_HUMAN",
			null,
		]);
	});

	test("a confident repair with only non-actionable findings goes to a human", async () => {
		const r = decided(
			await decide(
				fixedProvider({ choice: "SAME_TIER_REPAIR", confidence: 0.9 }),
				request(
					"POST_REVIEW",
					postReview({ findings: [finding({ actionable: false })] }),
				),
			),
		);
		expect(r.decision.choice).toBe("HUMAN_REQUIRED");
		expect(r.decision.reason_codes).toEqual(["NO_ACTIONABLE_FINDINGS"]);
	});
});

describe("8 / 9 — semantic review", () => {
	const depth = async (
		over: Parameters<typeof reviewDepth>[0],
		choice = "NO_SEMANTIC_REVIEW",
		confidence = 0.99,
	) =>
		decided(
			await decide(
				fixedProvider({ choice, confidence }),
				request("REVIEW_DEPTH", reviewDepth(over)),
			),
		).decision;

	test("8: source mutation cannot skip semantic review", async () => {
		const d = await depth({
			change: change({ mutates_source: true }),
			support_artifact_only: true,
		});
		expect(d.choice).toBe("STANDARD_REVIEW");
		expect(d.reason_codes).toContain("SOURCE_MUTATION_REVIEW_FLOOR");
	});

	test("8: sensitive source changes get stronger review", async () => {
		expect(
			(await depth({ change: change({ touches_auth: true }) })).choice,
		).toBe("DEEP_REVIEW");
		expect(
			(await depth({ change: change({ touches_security: true }) })).choice,
		).toBe("DEEP_REVIEW");
		expect(
			(await depth({ change: change({ touches_authorization: true }) })).choice,
		).toBe("SECOND_REVIEW");
	});

	test("9: a genuinely read-only support artifact may skip semantic review", async () => {
		const d = await depth({
			change: change({ mutates_source: false }),
			support_artifact_only: true,
		});
		expect([d.choice, d.policy_override]).toEqual(["NO_SEMANTIC_REVIEW", null]);
	});

	test("9: …but not when it is not purely support artifacts, nor at low confidence", async () => {
		expect(
			(
				await depth({
					change: change({ mutates_source: false }),
					support_artifact_only: false,
				})
			).choice,
		).toBe("STANDARD_REVIEW");
		expect(
			(
				await depth(
					{
						change: change({ mutates_source: false }),
						support_artifact_only: true,
					},
					"NO_SEMANTIC_REVIEW",
					0.5,
				)
			).choice,
		).toBe("DEEP_REVIEW");
	});
});

describe("10 — unsupported or invalid fails closed", () => {
	const req = route("TRIVIAL");

	test("unknown or missing decision kind → UNSUPPORTED, human required", async () => {
		for (const bad of [
			{ decision_kind: "DEPLOY", input: {} },
			{ decision_kind: "task_route", input: taskRoute() },
			{ input: taskRoute() },
			null,
			"TASK_ROUTE",
			[],
		]) {
			const o = await decide(rulesProvider(), bad);
			expect(o).toEqual({
				outcome: "UNSUPPORTED",
				fabric_version: "agentcity.decision-fabric/v0",
				authority: "ADVISORY",
				decision_kind: null,
				rejection_code: "UNSUPPORTED_KIND",
				fail_closed: true,
				human_required: true,
			});
		}
	});

	test("invalid input (missing flag, unknown key, wrong type) → provider not called, fail closed", async () => {
		let calls = 0;
		const counting: DecisionProvider = {
			id: "fake:count",
			recommend: async () => {
				calls++;
				return {};
			},
		};
		const { touches_auth: _omit, ...missingFlag } = change();
		for (const input of [
			{ ...taskRoute(), change: missingFlag },
			{ ...taskRoute(), diff: "+++ b/file" },
			{ ...taskRoute(), scope: "HUGE" },
			{ ...taskRoute(), change: { ...change(), touches_auth: "no" } },
		]) {
			const r = decided(
				await decide(counting, { decision_kind: "TASK_ROUTE", input }),
			);
			expect(r).toMatchObject({
				recommendation_status: "NOT_REQUESTED",
				rejection_code: "INPUT_INVALID",
				input_hash: null,
				recommendation: null,
			});
			expect([r.decision.choice, r.decision.fail_closed]).toEqual([
				"HUMAN",
				true,
			]);
		}
		const extraTop = decided(await decide(counting, { ...req, note: "x" }));
		expect(extraTop.rejection_code).toBe("INPUT_INVALID");
		expect(calls).toBe(0);
	});

	const malformed: [string, unknown][] = [
		["null", null],
		["string", "FAST"],
		["array", ["FAST"]],
		["empty object", {}],
		["missing confidence", { decision_kind: "TASK_ROUTE", choice: "FAST" }],
	];
	for (const [name, raw] of malformed)
		test(`malformed provider output (${name}) → OUTPUT_INVALID → HUMAN`, async () => {
			const r = decided(
				await decide(
					rawProvider(() => raw),
					req,
				),
			);
			expect(r).toMatchObject({
				recommendation_status: "REJECTED",
				rejection_code: "OUTPUT_INVALID",
				recommendation: null,
			});
			expect([r.decision.choice, r.decision.fail_closed]).toEqual([
				"HUMAN",
				true,
			]);
		});

	const invalidFields: [string, Record<string, unknown>][] = [
		["confidence > 1", { confidence: 1.01 }],
		["confidence < 0", { confidence: -0.01 }],
		["confidence NaN", { confidence: Number.NaN }],
		["confidence Infinity", { confidence: Number.POSITIVE_INFINITY }],
		["lowercase choice", { choice: "fast" }],
		[
			"too many reason codes",
			{ reason_codes: Array.from({ length: 9 }, (_, i) => `CODE_${i}`) },
		],
		["prose reason code", { reason_codes: ["because the change looks small"] }],
		["oversized reason code", { reason_codes: ["A".repeat(65)] }],
		["duplicate reason codes", { reason_codes: ["SMALL", "SMALL"] }],
		["unknown metadata key", { metadata: { notes: "x" } }],
		["oversized metadata value", { metadata: { trace_id: "t".repeat(65) } }],
		[
			"free-text metadata value",
			{ metadata: { provider_version: "v1 because reasons" } },
		],
		["unknown kind in output", { decision_kind: "DEPLOY" }],
	];
	for (const [name, extra] of invalidFields)
		test(`invalid field (${name}) → OUTPUT_INVALID`, async () => {
			const r = decided(
				await decide(rawProvider(answerFor("FAST", 0.9, extra)), req),
			);
			expect(r.rejection_code).toBe("OUTPUT_INVALID");
			expect(r.decision.choice).toBe("HUMAN");
		});

	test("binding mismatches are rejected but stay inspectable", async () => {
		const wrongKind = decided(
			await decide(
				rawProvider(answerFor("FAST", 0.9, { decision_kind: "REVIEW_DEPTH" })),
				req,
			),
		);
		expect(wrongKind.rejection_code).toBe("KIND_MISMATCH");
		const wrongHash = decided(
			await decide(
				rawProvider(answerFor("FAST", 0.9, { input_hash: "a".repeat(64) })),
				req,
			),
		);
		expect(wrongHash.rejection_code).toBe("INPUT_HASH_MISMATCH");
		const wrongProvider = decided(
			await decide(rawProvider(answerFor("FAST", 0.9, {}, "fake:other")), req),
		);
		expect(wrongProvider.rejection_code).toBe("PROVIDER_MISMATCH");
		for (const r of [wrongKind, wrongHash, wrongProvider]) {
			expect(r.recommendation_status).toBe("REJECTED");
			expect(r.recommendation?.choice).toBe("FAST");
			expect(r.decision.choice).toBe("HUMAN");
		}
	});

	test("a choice outside the kind's set (e.g. MERGE, or another kind's choice) → UNSUPPORTED_CHOICE", async () => {
		for (const choice of [
			"MERGE",
			"DEPLOY",
			"READY_FOR_HUMAN",
			"NO_SEMANTIC_REVIEW",
		]) {
			const r = decided(
				await decide(rawProvider(answerFor(choice, 0.99)), req),
			);
			expect(r.rejection_code).toBe("UNSUPPORTED_CHOICE");
			expect(r.recommendation?.choice).toBe(choice);
			expect([r.decision.choice, r.decision.fail_closed]).toEqual([
				"HUMAN",
				true,
			]);
		}
	});

	test("a provider that throws (sync or async) → PROVIDER_ERROR", async () => {
		const syncThrow: DecisionProvider = {
			id: "fake:sync-throw",
			recommend: () => {
				throw new Error("boom");
			},
		};
		for (const p of [throwingProvider(), syncThrow]) {
			const r = decided(await decide(p, req));
			expect([r.rejection_code, r.decision.choice]).toEqual([
				"PROVIDER_ERROR",
				"HUMAN",
			]);
		}
	});

	test("a provider that hangs → PROVIDER_TIMEOUT, and the request signal is aborted", async () => {
		let aborted = false;
		const p: DecisionProvider = {
			id: "fake:hang-probe",
			recommend: (r) =>
				new Promise((resolve) => {
					r.signal.addEventListener("abort", () => {
						aborted = true;
						resolve(answerFor("FAST", 0.99, {}, "fake:hang-probe")(r));
					});
				}),
		};
		const r = decided(await decide(p, req, { timeout_ms: 20 }));
		expect([r.rejection_code, r.decision.choice]).toEqual([
			"PROVIDER_TIMEOUT",
			"HUMAN",
		]);
		expect(aborted).toBe(true);
		const h = decided(await decide(hangingProvider(), req, { timeout_ms: 5 }));
		expect(h.rejection_code).toBe("PROVIDER_TIMEOUT");
	});

	test("timeout option is bounded", () => {
		expect(PROVIDER_TIMEOUT_MS).toBe(2_000);
		expect(MAX_PROVIDER_TIMEOUT_MS).toBe(30_000);
	});

	test("an invalid provider id → not requested, fail closed", async () => {
		const r = decided(
			await decide(
				fixedProvider({ choice: "FAST", confidence: 0.99 }, "Bad Provider!"),
				req,
			),
		);
		expect(r).toMatchObject({
			provider_id: null,
			recommendation_status: "NOT_REQUESTED",
			rejection_code: "PROVIDER_INVALID",
		});
		expect(r.decision.choice).toBe("HUMAN");
	});

	test("hostile output (throwing getter) is contained", async () => {
		const hostile = rawProvider((r) => {
			const o = answerFor("FAST", 0.9)(r);
			Object.defineProperty(o, "confidence", {
				enumerable: true,
				get() {
					throw new Error("getter");
				},
			});
			return o;
		});
		const r = decided(await decide(hostile, req));
		expect([r.rejection_code, r.decision.choice]).toEqual([
			"OUTPUT_INVALID",
			"HUMAN",
		]);
	});
});

describe("11 — recommendation and enforced decision are separately inspectable", () => {
	test("the result holds the raw validated recommendation, the enforced decision and the override record", async () => {
		const r = decided(
			await decide(
				fixedProvider({
					choice: "FAST",
					confidence: 0.93,
					reason_codes: ["SMALL_CHANGE"],
					metadata: {
						provider_version: "fake-1",
						latency_ms: 3,
						cache_hit: false,
					},
				}),
				route("TRIVIAL", { touches_security: true }),
			),
		);
		expect(r).toMatchObject({
			outcome: "DECIDED",
			authority: "ADVISORY",
			decision_kind: "TASK_ROUTE",
			provider_id: "fake:fixed",
			recommendation_status: "ACCEPTED",
			rejection_code: null,
		});
		expect(r.recommendation).toEqual({
			decision_kind: "TASK_ROUTE",
			choice: "FAST",
			confidence: 0.93,
			provider: "fake:fixed",
			input_hash: r.input_hash ?? "",
			reason_codes: ["SMALL_CHANGE"],
			metadata: { provider_version: "fake-1", latency_ms: 3, cache_hit: false },
		});
		expect(r.decision).toEqual({
			decision_kind: "TASK_ROUTE",
			choice: "SENIOR",
			route: "SENIOR",
			fail_closed: false,
			reason_codes: ["SECURITY_ROUTE_FLOOR"],
			policy_override: {
				from: "FAST",
				to: "SENIOR",
				steps: [{ rule: "SECURITY_ROUTE_FLOOR", from: "FAST", to: "SENIOR" }],
			},
			findings: null,
		});
	});

	test("the result is deeply frozen", async () => {
		const r = decided(
			await decide(rulesProvider(), request("POST_REVIEW", postReview())),
		);
		expect(Object.isFrozen(r)).toBe(true);
		expect(Object.isFrozen(r.decision)).toBe(true);
		expect(Object.isFrozen(r.decision.findings)).toBe(true);
		expect(Object.isFrozen(r.decision.findings?.[0])).toBe(true);
		expect(Object.isFrozen(r.recommendation)).toBe(true);
	});

	test("a provider cannot change what policy sees: its input copy is frozen", async () => {
		let blocked = false;
		const sneaky = rawProvider((r) => {
			try {
				if (r.decision_kind === "TASK_ROUTE")
					(r.input.change as { touches_security: boolean }).touches_security =
						false;
			} catch {
				blocked = true; // frozen: the write throws in strict-mode module code
			}
			return answerFor("FAST", 0.99)(r);
		});
		const r = decided(
			await decide(sneaky, route("TRIVIAL", { touches_security: true })),
		);
		expect(blocked).toBe(true);
		expect(r.recommendation_status).toBe("ACCEPTED");
		expect(r.decision.choice).toBe("SENIOR");
		expect(r.decision.reason_codes).toEqual(["SECURITY_ROUTE_FLOOR"]);

		const mutateChoices = rawProvider((r) => {
			(r.allowed_choices as string[]).push("MERGE");
			return answerFor("MERGE", 0.99)(r);
		});
		const m = decided(await decide(mutateChoices, route("TRIVIAL")));
		expect(m.rejection_code).toBe("PROVIDER_ERROR");
		expect(CHOICES.TASK_ROUTE as readonly string[]).not.toContain("MERGE");
	});
});

describe("no hidden reasoning is requested, stored or exposed", () => {
	test("output carrying reasoning / chain_of_thought is rejected and the text appears nowhere", async () => {
		const marker = "SECRET_REASONING_MARKER_7f3a";
		for (const key of [
			"reasoning",
			"chain_of_thought",
			"thoughts",
			"explanation",
		]) {
			const r = decided(
				await decide(
					rawProvider(answerFor("FAST", 0.99, { [key]: marker })),
					route("TRIVIAL"),
				),
			);
			expect(r.rejection_code).toBe("OUTPUT_INVALID");
			expect(r.recommendation).toBeNull();
			expect(JSON.stringify(r)).not.toContain(marker);
		}
		const meta = decided(
			await decide(
				rawProvider(
					answerFor("FAST", 0.99, { metadata: { reasoning: marker } }),
				),
				route("TRIVIAL"),
			),
		);
		expect(JSON.stringify(meta)).not.toContain(marker);
	});

	test("the provider request carries only structured facts", async () => {
		let seen: unknown;
		await decide(
			rawProvider((r) => {
				seen = r;
				return null;
			}),
			route("TRIVIAL"),
		);
		expect(Object.keys(seen as object).sort()).toEqual([
			"allowed_choices",
			"decision_kind",
			"input",
			"input_hash",
			"signal",
		]);
	});
});
