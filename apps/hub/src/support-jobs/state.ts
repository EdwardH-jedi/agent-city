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
import { deepFreeze, guarded } from "./guards.ts";
import {
	parseSupportJob,
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
	return guarded(() => {
		const f = SupportJobStatus.safeParse(from);
		const t = SupportJobStatus.safeParse(to);
		if (!f.success || !t.success) return false;
		return SUPPORT_JOB_TRANSITIONS[f.data].includes(t.data);
	}, false);
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

const INVARIANT: SupportTransitionResult = Object.freeze({
	ok: false,
	error: "invariant",
});

/**
 * Build the next job from a parsed current job and a patch. The patch is produced inside the guard
 * (it may read caller-supplied result / failure values), so an unreadable value is `invariant`,
 * never a thrown exception.
 */
function rebuild(
	job: SupportJob,
	patch: () => Partial<Record<keyof SupportJob, unknown>>,
): SupportTransitionResult {
	return guarded<SupportTransitionResult>(() => {
		const next = SupportJob.safeParse({ ...job, ...patch() });
		return next.success ? { ok: true, job: deepFreeze(next.data) } : INVARIANT;
	}, INVARIANT);
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
	const current = parseSupportJob(job);
	if (!current) return { ok: false, error: "invalid_job" };
	const target = guarded(() => SupportJobStatus.safeParse(to), null);
	if (!target?.success) return { ok: false, error: "unknown_state" };
	if (!canSupportTransition(current.status, target.data))
		return { ok: false, error: "illegal_transition" };
	if (target.data === "RUNNING" && current.disabled)
		return { ok: false, error: "disabled" };
	return rebuild(current, () => ({
		status: target.data,
		result: fields.result ?? null,
		failure: fields.failure ?? null,
	}));
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
	const current = parseSupportJob(job);
	if (!current) return { ok: false, error: "invalid_job" };
	switch (current.status) {
		case "QUEUED":
			return transitionSupportJob(current, "CANCELLED");
		case "RUNNING":
			return rebuild(current, () => ({ cancel_requested: true }));
		case "CANCELLED":
			return { ok: true, job: current };
		default:
			return { ok: false, error: "illegal_transition" };
	}
}

/** RUNNING → COMPLETED with the artifact's metadata — or CANCELLED if cancellation was requested. */
export function completeSupportJob(
	job: SupportJob,
	result: SupportResultMeta,
): SupportTransitionResult {
	const current = parseSupportJob(job);
	if (!current) return { ok: false, error: "invalid_job" };
	if (current.cancel_requested)
		return transitionSupportJob(current, "CANCELLED");
	return transitionSupportJob(current, "COMPLETED", { result });
}

/** RUNNING → FAILED with a classification — or CANCELLED if cancellation was requested. */
export function failSupportJob(
	job: SupportJob,
	failure: SupportFailure,
): SupportTransitionResult {
	const current = parseSupportJob(job);
	if (!current) return { ok: false, error: "invalid_job" };
	if (current.cancel_requested)
		return transitionSupportJob(current, "CANCELLED");
	return transitionSupportJob(current, "FAILED", { failure });
}

/** Record the profile a (future) router resolved for the job's capability. QUEUED only. */
export function assignSupportProfile(
	job: SupportJob,
	profile_id: unknown,
): SupportTransitionResult {
	const current = parseSupportJob(job);
	if (!current) return { ok: false, error: "invalid_job" };
	if (current.status !== "QUEUED")
		return { ok: false, error: "illegal_transition" };
	const id = guarded(() => SupportProfileId.safeParse(profile_id), null);
	if (!id?.success) return { ok: false, error: "invalid_profile" };
	return rebuild(current, () => ({ profile_id: id.data }));
}
