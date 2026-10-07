// Executor contract for future support models (Haiku-class, lightweight OpenAI, local models).
//
// An executor receives a frozen, read-only description of the job and returns untrusted output.
// The core validates that output into an informational artifact and settles the job — and that is
// all: runSupportJob has no callbacks, emits nothing, writes nothing and returns plain data. Output
// can therefore never trigger execution, approval, acceptance, Git mutation or publication; at most
// it fails the job with a classification. Timeouts and process isolation belong to whoever wires a
// real executor in; this core owns no timers and no I/O.
import {
	resultMetaFor,
	type SupportArtifact,
	validateExecutorOutput,
} from "./artifact.ts";
import { deepFreeze, guarded, safeDetail } from "./guards.ts";
import {
	parseSupportJob,
	type SupportInputRef,
	type SupportJob,
	type SupportJobKind,
} from "./job.ts";
import {
	completeSupportJob,
	failSupportJob,
	type SupportTransitionResult,
	transitionSupportJob,
} from "./state.ts";
import type { SupportCapability } from "./vocabulary.ts";

/** Everything an executor may see. Deeply frozen; references, not paths or credentials. */
export interface SupportExecutorInput {
	readonly job_id: string;
	readonly repo_id: string;
	readonly kind: SupportJobKind;
	readonly capability: SupportCapability;
	readonly inputs: readonly Readonly<SupportInputRef>[];
	readonly brief: string | null;
}

export interface SupportExecutorContext {
	/** Aborted when the job's cancellation is requested; executors should stop early. */
	readonly signal: AbortSignal;
}

export interface SupportExecutor {
	/** Stable executor identity (for future logging / routing); not a credential. */
	readonly executor_id: string;
	/** Capabilities this executor can serve. */
	readonly capabilities: readonly SupportCapability[];
	/** Returns untrusted output; the core validates it. May throw — that fails the job. */
	execute(
		input: SupportExecutorInput,
		context: SupportExecutorContext,
	): Promise<unknown>;
}

/** A frozen copy of the read-only part of a job — the executor never sees the job object. */
export function buildSupportExecutorInput(
	job: SupportJob,
): SupportExecutorInput {
	return deepFreeze({
		job_id: job.id,
		repo_id: job.repo_id,
		kind: job.kind,
		capability: job.capability,
		inputs: job.inputs.map((r) => ({ kind: r.kind, id: r.id })),
		brief: job.brief,
	});
}

export type SupportRunError =
	| "invalid_job"
	| "not_running"
	| "capability_unsupported"
	| "settle_failed";

export type SupportRunResult =
	| {
			readonly ok: true;
			/** The settled job: COMPLETED, FAILED or CANCELLED. */
			readonly job: SupportJob;
			/** Present only when the job COMPLETED. */
			readonly artifact: SupportArtifact | null;
	  }
	| { readonly ok: false; readonly error: SupportRunError };

const settled = (
	r: SupportTransitionResult,
	artifact: SupportArtifact | null,
): SupportRunResult =>
	r.ok
		? Object.freeze({
				ok: true as const,
				job: r.job,
				artifact: r.job.status === "COMPLETED" ? artifact : null,
			})
		: Object.freeze({ ok: false as const, error: "settle_failed" as const });

/** Fixed detail for a thrown value whose name / message cannot be read. */
export const UNREADABLE_ERROR_DETAIL = "executor error not readable";

/** Bounded, redacted detail of a thrown value; never throws (fixed fallback, nothing reflected). */
function errorDetail(err: unknown): string {
	return guarded(() => {
		if (err instanceof Error) return safeDetail(`${err.name}: ${err.message}`);
		return "executor threw a non-Error value";
	}, UNREADABLE_ERROR_DETAIL);
}

/**
 * Run one RUNNING job through an executor and settle it. Preconditions (job valid and RUNNING,
 * executor serves the job's capability) are checked first and leave the job untouched. The
 * argument job is never mutated; the result carries a new frozen job.
 */
export async function runSupportJob(
	job: SupportJob,
	executor: SupportExecutor,
	options: { readonly signal?: AbortSignal } = {},
): Promise<SupportRunResult> {
	const current = parseSupportJob(job);
	if (!current) return { ok: false, error: "invalid_job" };
	if (current.status !== "RUNNING") return { ok: false, error: "not_running" };
	if (!guarded(() => executor.capabilities.includes(current.capability), false))
		return { ok: false, error: "capability_unsupported" };

	const signal = options.signal ?? new AbortController().signal;
	if (signal.aborted || current.cancel_requested)
		return settled(transitionSupportJob(current, "CANCELLED"), null);

	let raw: unknown;
	try {
		raw = await executor.execute(buildSupportExecutorInput(current), {
			signal,
		});
	} catch (err) {
		if (signal.aborted)
			return settled(transitionSupportJob(current, "CANCELLED"), null);
		return settled(
			failSupportJob(current, {
				classification: "EXECUTOR_ERROR",
				detail: errorDetail(err),
			}),
			null,
		);
	}
	if (signal.aborted)
		return settled(transitionSupportJob(current, "CANCELLED"), null);

	const output = validateExecutorOutput(current, raw);
	if (!output.ok) return settled(failSupportJob(current, output.failure), null);
	return settled(
		completeSupportJob(current, resultMetaFor(output.artifact)),
		output.artifact,
	);
}
