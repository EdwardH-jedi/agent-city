// Test fixtures for the support lane. Fictional repos only; no tokens, no real repo names.
import {
	createSupportJob,
	type SupportInputRef,
	type SupportJob,
	type SupportJobKind,
} from "./job.ts";
import { requestSupportCancel, startSupportJob } from "./state.ts";
import type { SupportCapability } from "./vocabulary.ts";

export const T0 = "2026-10-06T00:00:00.000Z";

/** Minimal refs that satisfy REQUIRED_REF_KINDS for each kind. */
export const DEFAULT_REFS: Readonly<
	Record<SupportJobKind, readonly SupportInputRef[]>
> = {
	REPO_STATUS: [],
	HANDOFF: [{ kind: "session", id: "claude:abc-123" }],
	LOG_TRIAGE: [{ kind: "log", id: "ci-log-42" }],
	EVIDENCE_SUMMARY: [{ kind: "run", id: "run-7" }],
	REVIEW_TO_TODOS: [{ kind: "review", id: "review-9" }],
	PR_DRAFT: [
		{ kind: "commit", id: "0123456789abcdef0123456789abcdef01234567" },
	],
	CONTEXT_PACKAGE: [{ kind: "artifact", id: "art-1" }],
};

export interface JobSpec {
	id: string;
	seq?: number;
	kind?: SupportJobKind;
	repo_id?: string;
	capability?: SupportCapability;
	priority?: number;
	disabled?: boolean;
	inputs?: readonly SupportInputRef[];
	brief?: string | null;
}

/** A QUEUED job (throws if the spec is invalid — fixtures must be valid). */
export function queued(spec: JobSpec): SupportJob {
	const kind = spec.kind ?? "REPO_STATUS";
	const r = createSupportJob(
		{
			repo_id: spec.repo_id ?? "acme/widgets",
			kind,
			capability: spec.capability ?? "FAST",
			inputs: spec.inputs ?? DEFAULT_REFS[kind],
			brief: spec.brief ?? null,
			priority: spec.priority ?? 50,
			disabled: spec.disabled ?? false,
		},
		{ id: spec.id, created_seq: spec.seq ?? 0, created_at: T0 },
	);
	if (!r.ok) throw new Error(`fixture invalid: ${r.issues.join("; ")}`);
	return r.job;
}

export function running(spec: JobSpec): SupportJob {
	const r = startSupportJob(queued(spec));
	if (!r.ok) throw new Error(`fixture start failed: ${r.error}`);
	return r.job;
}

export function cancelled(spec: JobSpec): SupportJob {
	const r = requestSupportCancel(queued(spec));
	if (!r.ok) throw new Error(`fixture cancel failed: ${r.error}`);
	return r.job;
}

/** RUNNING with cancellation requested. */
export function cancelRequested(spec: JobSpec): SupportJob {
	const r = requestSupportCancel(running(spec));
	if (!r.ok) throw new Error(`fixture cancel failed: ${r.error}`);
	return r.job;
}

/** Deterministic Fisher–Yates with a 32-bit LCG — no Math.random in tests. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
	const out = [...items];
	let s = seed >>> 0;
	for (let i = out.length - 1; i > 0; i--) {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		const j = s % (i + 1);
		const a = out[i];
		const b = out[j];
		if (a === undefined || b === undefined) continue;
		out[i] = b;
		out[j] = a;
	}
	return out;
}
