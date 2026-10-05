// The seam a decision model plugs into (later: Jev). A provider RECOMMENDS; it never decides. Its
// output is untrusted: the fabric validates it with strict schemas, checks it echoes the request,
// and then deterministic policy may override it. Nothing a provider returns grants authority.
import type { Choice, DecisionInput, DecisionKind } from "./contracts.ts";

export type ProviderRequestFor<K extends DecisionKind> = Readonly<{
	decision_kind: K;
	/** The normalized input (a frozen copy: the provider cannot change what policy sees). */
	input: Readonly<DecisionInput<K>>;
	/** Must be echoed back in the recommendation; binds the answer to this exact input. */
	input_hash: string;
	/** The kind's closed choice set. Anything else is unsupported and fails closed. */
	allowed_choices: readonly Choice<K>[];
	/** Aborted when the fabric stops waiting (timeout); the provider should stop its work. */
	signal: AbortSignal;
}>;
export type ProviderRequest = {
	[K in DecisionKind]: ProviderRequestFor<K>;
}[DecisionKind];

export interface DecisionProvider {
	/** Stable identifier recorded with every recommendation, `[a-z][a-z0-9._:-]{0,63}`. */
	readonly id: string;
	/**
	 * Return a recommendation object (see `Recommendation` in contracts.ts): decision_kind, choice,
	 * confidence, provider, input_hash, reason_codes and optional bounded metadata. Never reasoning
	 * or transcripts — the schema has no field for them and rejects unknown keys.
	 */
	recommend(request: ProviderRequest): Promise<unknown>;
}
