// Deterministic in-process providers for tests and demos. No network, no model, no clock.
import type { ProviderMetadata } from "./contracts.ts";
import type { DecisionProvider, ProviderRequest } from "./provider.ts";

type Answer = {
	choice: string;
	confidence: number;
	reason_codes?: readonly string[];
	metadata?: ProviderMetadata;
};

const recommendation = (id: string, req: ProviderRequest, a: Answer) => ({
	decision_kind: req.decision_kind,
	choice: a.choice,
	confidence: a.confidence,
	provider: id,
	input_hash: req.input_hash,
	reason_codes: [...(a.reason_codes ?? [])],
	...(a.metadata ? { metadata: { ...a.metadata } } : {}),
});

/** Always recommends the same choice/confidence, echoing the request's kind and hash. */
export function fixedProvider(
	answer: Answer,
	id = "fake:fixed",
): DecisionProvider {
	return { id, recommend: async (req) => recommendation(id, req, answer) };
}

/** Returns whatever `produce` returns, untouched — for malformed-output tests. */
export function rawProvider(
	produce: (req: ProviderRequest) => unknown,
	id = "fake:raw",
): DecisionProvider {
	return { id, recommend: async (req) => produce(req) };
}

export function throwingProvider(id = "fake:throws"): DecisionProvider {
	return {
		id,
		recommend: async () => {
			throw new Error("fake provider failure");
		},
	};
}

/** Never answers on its own; settles (with nothing) only when the fabric aborts the request. */
export function hangingProvider(id = "fake:hangs"): DecisionProvider {
	return {
		id,
		recommend: (req) =>
			new Promise((resolve) => {
				req.signal.addEventListener("abort", () => resolve(undefined), {
					once: true,
				});
			}),
	};
}

/**
 * A deterministic rule-of-thumb provider. It deliberately ignores the sensitive change flags, so
 * tests can show policy overriding a confident recommendation.
 */
export function rulesProvider(id = "fake:rules"): DecisionProvider {
	const answer = (req: ProviderRequest): Answer => {
		switch (req.decision_kind) {
			case "TASK_ROUTE": {
				const tier = {
					TRIVIAL: "FAST",
					SMALL: "STANDARD",
					MEDIUM: "SENIOR",
					LARGE: "PRINCIPAL",
				}[req.input.scope];
				return {
					choice: tier,
					confidence: 0.9,
					reason_codes: [`SCOPE_${req.input.scope}`],
				};
			}
			case "ESCALATION":
				return req.input.attempts_at_tier < 2
					? {
							choice: "RETRY_SAME_TIER",
							confidence: 0.85,
							reason_codes: ["RETRY"],
						}
					: {
							choice: "ESCALATE_TIER",
							confidence: 0.85,
							reason_codes: ["REPEATED"],
						};
			case "REVIEW_DEPTH":
				return req.input.support_artifact_only &&
					!req.input.change.mutates_source
					? { choice: "NO_SEMANTIC_REVIEW", confidence: 0.9 }
					: { choice: "STANDARD_REVIEW", confidence: 0.9 };
			case "POST_REVIEW":
				if (req.input.reviewer_verdict === "APPROVE")
					return { choice: "READY_FOR_HUMAN", confidence: 0.8 };
				return req.input.findings.some((f) => f.actionable)
					? { choice: "SAME_TIER_REPAIR", confidence: 0.8 }
					: { choice: "HUMAN_REQUIRED", confidence: 0.8 };
			case "QUEUE_PRIORITY":
				return req.input.is_repair
					? { choice: "RAISE", confidence: 0.75 }
					: { choice: "KEEP", confidence: 0.75 };
			case "HUMAN_ESCALATE":
				return req.input.consecutive_failures > 0
					? { choice: "ESCALATE_TO_HUMAN", confidence: 0.8 }
					: { choice: "CONTINUE_AUTONOMOUS", confidence: 0.8 };
			case "OVERNIGHT_CONTINUE":
				return { choice: "CONTINUE", confidence: 0.8 };
		}
	};
	return { id, recommend: async (req) => recommendation(id, req, answer(req)) };
}
