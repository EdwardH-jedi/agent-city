// Pure support-job scheduler: one synchronous pass over a snapshot of jobs, no timers, no I/O, no
// polling loop. The caller starts the returned jobs (startSupportJob) and calls again later.
//
// Eligible: status QUEUED, not disabled, no cancellation requested.
// Capacity: every RUNNING job (cancel-requested ones included — they still hold a worker) uses a
//   slot; launch ≤ min(concurrency − running, SUPPORT_SCHEDULE_HARD_CAP), never negative.
// Order (total, so any permutation of the same input yields the same result):
//   1. priority, higher first
//   2. created_seq, lower (older) first
//   3. id, by UTF-16 code unit (ids are unique — duplicates are rejected)
// Optional fairness: max_per_repo caps RUNNING + launched jobs per repo (case-insensitive repo
//   key); a capped repo's jobs are skipped and the next eligible job takes the slot.
import { repoKey } from "@agent-city/schema";
import { z } from "zod";
import type { SupportJob } from "./job.ts";

export const DEFAULT_SUPPORT_CONCURRENCY = 4;
export const MIN_SUPPORT_CONCURRENCY = 1;
export const MAX_SUPPORT_CONCURRENCY = 16;
/** Absolute ceiling on one scheduling result, whatever the options say. */
export const SUPPORT_SCHEDULE_HARD_CAP = 16;
/** Largest snapshot one call accepts; larger snapshots are a caller bug. */
export const MAX_SUPPORT_SCHEDULER_INPUT = 10_000;

export const SupportSchedulerOptions = z.strictObject({
	concurrency: z
		.int()
		.min(MIN_SUPPORT_CONCURRENCY)
		.max(MAX_SUPPORT_CONCURRENCY)
		.default(DEFAULT_SUPPORT_CONCURRENCY),
	max_per_repo: z
		.int()
		.min(1)
		.max(MAX_SUPPORT_CONCURRENCY)
		.nullable()
		.default(null),
});
export type SupportSchedulerOptions = z.input<typeof SupportSchedulerOptions>;

export interface SupportSchedule {
	/** Jobs to start now, in launch order (the caller's own objects, not copies). */
	readonly launch: readonly SupportJob[];
	/** RUNNING jobs counted against concurrency. */
	readonly running: number;
	/** Slots that were free before this launch. */
	readonly available_slots: number;
}

/** Scheduling order: priority desc, created_seq asc, id asc (code units). */
export function compareSupportJobs(a: SupportJob, b: SupportJob): number {
	if (a.priority !== b.priority) return b.priority - a.priority;
	if (a.created_seq !== b.created_seq) return a.created_seq - b.created_seq;
	if (a.id < b.id) return -1;
	if (a.id > b.id) return 1;
	return 0;
}

export const isSchedulableSupportJob = (job: SupportJob): boolean =>
	job.status === "QUEUED" && !job.disabled && !job.cancel_requested;

/**
 * Choose the next jobs to start. Throws on invalid options (ZodError), an oversized snapshot or
 * duplicate job ids (RangeError). Never mutates `jobs`.
 */
export function selectSupportJobs(
	jobs: readonly SupportJob[],
	options: SupportSchedulerOptions = {},
): SupportSchedule {
	const opts = SupportSchedulerOptions.parse(options);
	if (jobs.length > MAX_SUPPORT_SCHEDULER_INPUT)
		throw new RangeError(
			`support scheduler accepts at most ${MAX_SUPPORT_SCHEDULER_INPUT} jobs`,
		);

	const ids = new Set<string>();
	const runningPerRepo = new Map<string, number>();
	let running = 0;
	for (const job of jobs) {
		if (ids.has(job.id)) throw new RangeError("duplicate support job id");
		ids.add(job.id);
		if (job.status === "RUNNING") {
			running += 1;
			const key = repoKey(job.repo_id);
			runningPerRepo.set(key, (runningPerRepo.get(key) ?? 0) + 1);
		}
	}

	const available_slots = Math.max(0, opts.concurrency - running);
	const limit = Math.min(available_slots, SUPPORT_SCHEDULE_HARD_CAP);
	const launch: SupportJob[] = [];
	if (limit > 0) {
		const candidates = jobs
			.filter(isSchedulableSupportJob)
			.sort(compareSupportJobs);
		for (const job of candidates) {
			if (launch.length >= limit) break;
			if (opts.max_per_repo !== null) {
				const key = repoKey(job.repo_id);
				const used = runningPerRepo.get(key) ?? 0;
				if (used >= opts.max_per_repo) continue;
				runningPerRepo.set(key, used + 1);
			}
			launch.push(job);
		}
	}
	return Object.freeze({
		launch: Object.freeze(launch),
		running,
		available_slots,
	});
}
