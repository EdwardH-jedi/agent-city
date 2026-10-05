// Decision Fabric: Decision Provider → Recommendation → deterministic policy enforcement → final
// (advisory) routing recommendation.
//
// The result keeps the provider's validated recommendation and the policy's enforced decision side
// by side, with the override record, so each can be inspected on its own. Nothing here mutates a
// queue, a workflow or a store, and nothing grants execution authority: `authority` is always
// "ADVISORY" — the Hub's gates and human approval remain authoritative.
import {
	CHOICES,
	DECISION_FABRIC_VERSION,
	DecisionKind,
	DecisionRequest,
	isChoiceOf,
	ProviderId,
	Recommendation,
} from "./contracts.ts";
import { hashDecisionInput } from "./hash.ts";
import {
	type EnforcedDecisionFor,
	enforcePolicy,
	failClosedDecision,
} from "./policy.ts";
import type { DecisionProvider, ProviderRequest } from "./provider.ts";

/** How long the fabric waits for a provider before failing closed. */
export const PROVIDER_TIMEOUT_MS = 2_000;
export const MAX_PROVIDER_TIMEOUT_MS = 30_000;

/** Why a recommendation was not used. Codes only — never the provider's text or a parser message. */
export const REJECTION_CODES = [
	"INPUT_INVALID",
	"PROVIDER_INVALID",
	"PROVIDER_ERROR",
	"PROVIDER_TIMEOUT",
	"OUTPUT_INVALID",
	"KIND_MISMATCH",
	"INPUT_HASH_MISMATCH",
	"PROVIDER_MISMATCH",
	"UNSUPPORTED_CHOICE",
] as const;
export type RejectionCode = (typeof REJECTION_CODES)[number];

/**
 * ACCEPTED — validated and bound to this request; policy saw it.
 * REJECTED — the provider answered but the answer is unusable; policy failed closed.
 * NOT_REQUESTED — the provider was not called (invalid input or provider); policy failed closed.
 */
export type RecommendationStatus = "ACCEPTED" | "REJECTED" | "NOT_REQUESTED";

export type DecisionResultFor<K extends DecisionKind> = Readonly<{
	outcome: "DECIDED";
	fabric_version: typeof DECISION_FABRIC_VERSION;
	authority: "ADVISORY";
	decision_kind: K;
	/** sha256 of the normalized input; null only when the input did not validate. */
	input_hash: string | null;
	provider_id: string | null;
	recommendation_status: RecommendationStatus;
	rejection_code: RejectionCode | null;
	/** The provider's answer after strict validation (bounded facts only), or null. */
	recommendation: Recommendation | null;
	/** What policy enforced, including the override record. */
	decision: EnforcedDecisionFor<K>;
}>;
export type DecisionResult = {
	[K in DecisionKind]: DecisionResultFor<K>;
}[DecisionKind];

/** A request whose decision kind is unknown: nothing is decided, a person must look. */
export type UnsupportedResult = Readonly<{
	outcome: "UNSUPPORTED";
	fabric_version: typeof DECISION_FABRIC_VERSION;
	authority: "ADVISORY";
	decision_kind: null;
	rejection_code: "UNSUPPORTED_KIND";
	fail_closed: true;
	human_required: true;
}>;
export type FabricOutcome = DecisionResult | UnsupportedResult;

export type DecideOptions = { timeout_ms?: number };

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const v of Object.values(value)) deepFreeze(v);
	}
	return value;
}

/** Run `fn`; a throw (hostile getter, cyclic structure, …) yields `fallback`. */
function attempt<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

const timeoutOf = (opts: DecideOptions): number => {
	const t = opts.timeout_ms;
	return typeof t === "number" &&
		Number.isInteger(t) &&
		t >= 1 &&
		t <= MAX_PROVIDER_TIMEOUT_MS
		? t
		: PROVIDER_TIMEOUT_MS;
};

type CallOutcome =
	| { ok: true; raw: unknown }
	| { ok: false; code: "PROVIDER_ERROR" | "PROVIDER_TIMEOUT" };

/** One provider call, bounded in time. Never throws; a late rejection is swallowed, not leaked. */
async function callProvider(
	provider: DecisionProvider,
	build: (signal: AbortSignal) => ProviderRequest,
	timeoutMs: number,
): Promise<CallOutcome> {
	const ac = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<CallOutcome>((resolve) => {
		timer = setTimeout(
			() => resolve({ ok: false, code: "PROVIDER_TIMEOUT" }),
			timeoutMs,
		);
	});
	const answered = Promise.resolve()
		.then(() => provider.recommend(build(ac.signal)))
		.then(
			(raw): CallOutcome => ({ ok: true, raw }),
			(): CallOutcome => ({ ok: false, code: "PROVIDER_ERROR" }),
		);
	try {
		const out = await Promise.race([answered, timedOut]);
		if (!out.ok && out.code === "PROVIDER_TIMEOUT") ac.abort();
		return out;
	} finally {
		clearTimeout(timer);
	}
}

type Checked =
	| { status: "ACCEPTED"; rec: Recommendation }
	| {
			status: "REJECTED" | "NOT_REQUESTED";
			code: RejectionCode;
			rec: Recommendation | null;
	  };

function checkRecommendation(
	raw: unknown,
	kind: DecisionKind,
	inputHash: string,
	providerId: string,
): Checked {
	const parsed = attempt(() => Recommendation.safeParse(raw), null);
	if (!parsed?.success)
		return { status: "REJECTED", code: "OUTPUT_INVALID", rec: null };
	const rec = parsed.data;
	const reject = (code: RejectionCode): Checked => ({
		status: "REJECTED",
		code,
		rec,
	});
	if (rec.decision_kind !== kind) return reject("KIND_MISMATCH");
	if (rec.input_hash !== inputHash) return reject("INPUT_HASH_MISMATCH");
	if (rec.provider !== providerId) return reject("PROVIDER_MISMATCH");
	if (!isChoiceOf(kind, rec.choice)) return reject("UNSUPPORTED_CHOICE");
	return { status: "ACCEPTED", rec };
}

/**
 * Ask `provider` for a recommendation on `request` and enforce policy on it. Never throws, never
 * performs I/O of its own; every failure (unknown kind, invalid input, provider error/timeout,
 * malformed or mismatched output, unsupported choice) fails closed. The result is deeply frozen.
 */
export async function decide(
	provider: DecisionProvider,
	request: unknown,
	opts: DecideOptions = {},
): Promise<FabricOutcome> {
	const base = {
		fabric_version: DECISION_FABRIC_VERSION,
		authority: "ADVISORY",
	} as const;

	const kind = attempt(
		() =>
			DecisionKind.safeParse(
				request && typeof request === "object"
					? (request as { decision_kind?: unknown }).decision_kind
					: undefined,
			),
		null,
	);
	if (!kind?.success)
		return deepFreeze({
			...base,
			outcome: "UNSUPPORTED",
			decision_kind: null,
			rejection_code: "UNSUPPORTED_KIND",
			fail_closed: true,
			human_required: true,
		});
	const decisionKind = kind.data;

	const providerId = attempt(() => ProviderId.safeParse(provider.id), null);
	const id = providerId?.success ? providerId.data : null;
	const parsed = attempt(() => DecisionRequest.safeParse(request), null);
	if (!parsed?.success || parsed.data.decision_kind !== decisionKind)
		return deepFreeze({
			...base,
			outcome: "DECIDED",
			decision_kind: decisionKind,
			input_hash: null,
			provider_id: id,
			recommendation_status: "NOT_REQUESTED",
			rejection_code: "INPUT_INVALID",
			recommendation: null,
			decision: failClosedDecision(decisionKind),
		} as DecisionResult);
	const req = parsed.data;
	const inputHash = hashDecisionInput(req.decision_kind, req.input);

	let checked: Checked;
	if (id === null) {
		checked = { status: "NOT_REQUESTED", code: "PROVIDER_INVALID", rec: null };
	} else {
		const call = await callProvider(
			provider,
			(signal) =>
				({
					decision_kind: req.decision_kind,
					input: deepFreeze(structuredClone(req.input)),
					input_hash: inputHash,
					allowed_choices: Object.freeze([...CHOICES[req.decision_kind]]),
					signal,
				}) as ProviderRequest,
			timeoutOf(opts),
		);
		checked = call.ok
			? checkRecommendation(call.raw, req.decision_kind, inputHash, id)
			: { status: "REJECTED", code: call.code, rec: null };
	}

	const accepted = checked.status === "ACCEPTED" ? checked.rec : null;
	return deepFreeze({
		...base,
		outcome: "DECIDED",
		decision_kind: req.decision_kind,
		input_hash: inputHash,
		provider_id: id,
		recommendation_status: checked.status,
		rejection_code: checked.status === "ACCEPTED" ? null : checked.code,
		recommendation: checked.rec,
		decision: enforcePolicy(req, accepted),
	} as DecisionResult);
}
