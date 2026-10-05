// Support job state machine. Pure and deterministic: every helper returns a NEW frozen job (or a
// typed error) and never mutates its argument. The transition functions only accept the support
// lane's own upper-case states — a managed state such as "executing" or "human_ready" (or even
// lower-case "queued") is not a SupportJobStatus and is rejected as `unknown_state`.
//
//   QUEUED  ──► RUNNING ──► COMPLETED
//     │           ├──────► FAILED
//     └──► CANCELLED ◄─────┘ (cancel)
//
// Terminal: COMPLETED, FAILED, CANCELLED. Nothing re-queues; a retry is a new job.
import { deepFreeze } from "./guards.ts";
import {
	type SupportFailure,
	SupportJob,
	SupportJobStatus,
	type SupportResultMeta,
} from "./job.ts";
import { SupportProfileId } from "./vocabulary.ts";

export const SUPPORT_JOB_TRANSITIONS: Readonly<
	Record<SupportJobStatus, readonly SupportJobStatus[]>
> = Object.freeze({
	QUEUED: Object.freeze(["RUNNING", "CANCELLED"] as const),
	RUNNING: Object.freeze(["COMPLETED", "FAILED", "CANCELLED"] as const),
	COMPLETED: Object.freeze([] as const),
	FAILED: Object.freeze([] as const),
	CANCELLED: Object.freeze([] as const),
});

export const TERMINAL_SUPPORT_STATUSES: readonly SupportJobStatus[] =
	Object.freeze(["COMPLETED", "FAILED", "CANCELLED"] as const);

export const isTerminalSupportStatus = (s: SupportJobStatus): boolean =>
	TERMINAL_SUPPORT_STATUSES.includes(s);

/** Is `from → to` a legal support transition? Anything outside the support enum is false. */
export function canSupportTransition(from: unknown, to: unknown): boolean {
	const f = SupportJobStatus.safeParse(from);
	const t = SupportJobStatus.safeParse(to);
	if (!f.success || !t.success) return false;
	return SUPPORT_JOB_TRANSITIONS[f.data].includes(t.data);
}

export type SupportTransitionError =
	| "invalid_job"
	| "unknown_state"
	| "illegal_transition"
	| "invariant"
	| "disabled"
	| "invalid_profile";

export type SupportTransitionResult =
	| { readonly ok: true; readonly job: SupportJob }
	| { readonly ok: false; readonly error: SupportTransitionError };

/** Fields a transition may set alongside the status. */
interface TransitionFields {
	result?: SupportResultMeta;
	failure?: SupportFailure;
}

function rebuild(
	job: SupportJob,
	patch: Partial<Record<keyof SupportJob, unknown>>,
): SupportTransitionResult {
	const next = SupportJob.safeParse({ ...job, ...patch });
	return next.success
		? { ok: true, job: deepFreeze(next.data) }
		: { ok: false, error: "invariant" };
}

/**
 * The single place a status changes. `to` is untrusted: it must be a SupportJobStatus and a legal
 * successor of the current status; the resulting job must satisfy every SupportJob invariant
 * (COMPLETED needs `result`, FAILED needs `failure`).
 */
export function transitionSupportJob(
	job: SupportJob,
	to: unknown,
	fields: TransitionFields = {},
): SupportTransitionResult {
	const current = SupportJob.safeParse(job);
	if (!current.success) return { ok: false, error: "invalid_job" };
	const target = SupportJobStatus.safeParse(to);
	if (!target.success) return { ok: false, error: "unknown_state" };
	if (!canSupportTransition(current.data.status, target.data))
		return { ok: false, error: "illegal_transition" };
	if (target.data === "RUNNING" && current.data.disabled)
		return { ok: false, error: "disabled" };
	return rebuild(current.data, {
		status: target.data,
		result: fields.result ?? null,
		failure: fields.failure ?? null,
	});
}

/** QUEUED → RUNNING (refused while the job is disabled). */
export const startSupportJob = (job: SupportJob): SupportTransitionResult =>
	transitionSupportJob(job, "RUNNING");

/**
 * Cancellation intent. QUEUED → CANCELLED at once; RUNNING keeps running with
 * `cancel_requested` set and ends CANCELLED when it settles (its output is discarded);
 * an already CANCELLED job is returned unchanged; COMPLETED / FAILED cannot be cancelled.
 */
export function requestSupportCancel(job: SupportJob): SupportTransitionResult {
	const current = SupportJob.safeParse(job);
	if (!current.success) return { ok: false, error: "invalid_job" };
	switch (current.data.status) {
		case "QUEUED":
			return transitionSupportJob(current.data, "CANCELLED");
		case "RUNNING":
			return rebuild(current.data, { cancel_requested: true });
		case "CANCELLED":
			return { ok: true, job: deepFreeze(current.data) };
		default:
			return { ok: false, error: "illegal_transition" };
	}
}

/** RUNNING → COMPLETED with the artifact's metadata — or CANCELLED if cancellation was requested. */
export function completeSupportJob(
	job: SupportJob,
	result: SupportResultMeta,
): SupportTransitionResult {
	if (job.cancel_requested) return transitionSupportJob(job, "CANCELLED");
	return transitionSupportJob(job, "COMPLETED", { result });
}

/** RUNNING → FAILED with a classification — or CANCELLED if cancellation was requested. */
export function failSupportJob(
	job: SupportJob,
	failure: SupportFailure,
): SupportTransitionResult {
	if (job.cancel_requested) return transitionSupportJob(job, "CANCELLED");
	return transitionSupportJob(job, "FAILED", { failure });
}

/** Record the profile a (future) router resolved for the job's capability. QUEUED only. */
export function assignSupportProfile(
	job: SupportJob,
	profile_id: unknown,
): SupportTransitionResult {
	const current = SupportJob.safeParse(job);
	if (!current.success) return { ok: false, error: "invalid_job" };
	if (current.data.status !== "QUEUED")
		return { ok: false, error: "illegal_transition" };
	const id = SupportProfileId.safeParse(profile_id);
	if (!id.success) return { ok: false, error: "invalid_profile" };
	return rebuild(current.data, { profile_id: id.data });
}
