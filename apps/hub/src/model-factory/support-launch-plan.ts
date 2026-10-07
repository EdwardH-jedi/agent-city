// Support launch plan (DRY RUN / ADVISORY): the support-lane scheduler, Decision Fabric routing and the
// Worker Profile Registry composed into one answer — "which queued support jobs WOULD start now, and on
// which worker profile". It starts nothing, assigns nothing and changes no job: the caller's snapshot
// is read, never written, and the result is deeply frozen.
//
// Rules:
// - Order and capacity come from selectSupportJobs (support-jobs/scheduler.ts): concurrency (default
//   4), RUNNING jobs hold slots, cancelled / disabled / cancel-requested jobs never start, priority →
//   created_seq → id, optional per-repo fairness.
// - Every picked job is routed by dryRunSupportRoute: a job without a recommended profile (unknown,
//   disabled or unfit assigned profile, no eligible profile, HUMAN route, undecided fabric) is HELD —
//   it fails closed and never falls back to another profile or to "run anyway".
// - A profile serves at most its `max_concurrency` jobs: RUNNING jobs naming it count, and a job whose
//   recommended profile is full is held (never moved to a different profile).
// - A held job frees its slot; the scheduler is asked again with planned jobs counted as running, so
//   the next eligible job can take it. Bounded: at most MAX_PLAN_ROUTED jobs are routed per plan.
import { deepFreeze } from "../support-jobs/guards.ts";
import type { SupportJob } from "../support-jobs/job.ts";
import {
	type SupportSchedulerOptions,
	selectSupportJobs,
} from "../support-jobs/scheduler.ts";
import {
	DRY_RUN_MODE,
	type DryRunDeps,
	type DryRunRoute,
	type DryRunScope,
	dryRunSupportRoute,
} from "./dry-run-route.ts";

/** Most jobs one plan routes (planned + held), whatever the snapshot size: no load-everything loop. */
export const MAX_PLAN_ROUTED = 64;

export type SupportLaunchHoldReason =
	| "no_profile"
	| "human_required"
	| "profile_at_capacity";

export type SupportLaunchPlan = Readonly<{
	mode: typeof DRY_RUN_MODE;
	authority: "ADVISORY";
	/** Jobs that would start now, in launch order, each with the profile it would run on. */
	launch: readonly Readonly<{
		job_id: string;
		profile_id: string;
		route: DryRunRoute;
	}>[];
	/** Jobs the scheduler picked that cannot start: they fail closed and free their slot. */
	held: readonly Readonly<{
		job_id: string;
		reason: SupportLaunchHoldReason;
		route: DryRunRoute;
	}>[];
	/** RUNNING jobs in the snapshot (they hold slots). */
	running: number;
	/** Slots free before this plan. */
	available_slots: number;
	/** True when MAX_PLAN_ROUTED ended the plan before every free slot was considered. */
	truncated: boolean;
}>;

export interface SupportLaunchDeps extends DryRunDeps {
	/** Task size per job, from trusted Hub analysis — never from a provider. */
	scope_of: (job: SupportJob) => DryRunScope;
}

/**
 * Plan (never perform) the next support-job launches. Throws exactly like selectSupportJobs on
 * invalid options, an oversized snapshot or duplicate job ids.
 */
export async function planSupportLaunches(
	jobs: readonly SupportJob[],
	deps: SupportLaunchDeps,
	options: SupportSchedulerOptions = {},
): Promise<SupportLaunchPlan> {
	const first = selectSupportJobs(jobs, options);
	const planned = new Set<string>();
	const excluded = new Set<string>();
	const launch: {
		job_id: string;
		profile_id: string;
		route: DryRunRoute;
	}[] = [];
	const held: {
		job_id: string;
		reason: SupportLaunchHoldReason;
		route: DryRunRoute;
	}[] = [];
	// a profile's load: RUNNING jobs that name it
	const load = new Map<string, number>();
	for (const j of jobs)
		if (j.status === "RUNNING" && j.profile_id !== null)
			load.set(j.profile_id, (load.get(j.profile_id) ?? 0) + 1);

	let routed = 0;
	let truncated = false;
	let picks = first.launch;
	while (picks.length > 0 && !truncated) {
		for (const job of picks) {
			if (routed >= MAX_PLAN_ROUTED) {
				truncated = true;
				break;
			}
			routed += 1;
			const route = await dryRunSupportRoute(
				{ job, scope: deps.scope_of(job) },
				deps,
			);
			const p = route.profile;
			if (p.status !== "PROFILE_RECOMMENDED") {
				held.push({
					job_id: job.id,
					reason:
						p.status === "HUMAN_REQUIRED" ? "human_required" : "no_profile",
					route,
				});
				excluded.add(job.id);
				continue;
			}
			const used = load.get(p.profile_id) ?? 0;
			if (used >= p.profile.max_concurrency) {
				held.push({ job_id: job.id, reason: "profile_at_capacity", route });
				excluded.add(job.id);
				continue;
			}
			load.set(p.profile_id, used + 1);
			launch.push({ job_id: job.id, profile_id: p.profile_id, route });
			planned.add(job.id);
		}
		// refill: planned jobs hold slots (seen as RUNNING), held jobs are out of this plan
		const view = jobs
			.filter((j) => !excluded.has(j.id))
			.map((j) =>
				planned.has(j.id) ? { ...j, status: "RUNNING" as const } : j,
			);
		picks = selectSupportJobs(view, options).launch;
	}
	return deepFreeze({
		mode: DRY_RUN_MODE,
		authority: "ADVISORY",
		launch,
		held,
		running: first.running,
		available_slots: first.available_slots,
		truncated,
	});
}
