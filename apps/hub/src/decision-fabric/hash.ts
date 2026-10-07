// Stable input hashing for Decision Fabric. Self-contained on purpose (node:crypto only): the
// fabric does not reach into managed-run modules for its primitives.
import { createHash } from "node:crypto";
import { DECISION_FABRIC_VERSION, type DecisionKind } from "./contracts.ts";

/** Deterministic JSON: object keys sorted at every level; array order is preserved. */
export function canonicalJson(value: unknown): string {
	const norm = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(norm);
		if (v && typeof v === "object") {
			const out: Record<string, unknown> = {};
			for (const k of Object.keys(v).sort())
				out[k] = norm((v as Record<string, unknown>)[k]);
			return out;
		}
		return v;
	};
	return JSON.stringify(norm(value));
}

export const sha256Hex = (data: string): string =>
	createHash("sha256").update(data).digest("hex");

/**
 * sha256 over the canonical JSON of `{version, decision_kind, input}` where `input` is the
 * zod-normalized input. The kind and version are part of the preimage so two kinds (or two contract
 * versions) never share a hash for the same field values.
 */
export const hashDecisionInput = (kind: DecisionKind, input: unknown): string =>
	sha256Hex(
		canonicalJson({
			version: DECISION_FABRIC_VERSION,
			decision_kind: kind,
			input,
		}),
	);
