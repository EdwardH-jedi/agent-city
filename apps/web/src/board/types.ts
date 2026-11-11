// Shared shapes of the board and the "current run" rule (design doc §3). Pure, no React.
import type {
	OfficePhase,
	RunDisplay,
	RunEventView,
	RunView,
} from "@agent-city/schema";

/** Office's nine phases in pipeline order: the "지금 진행" bar has one step each. */
export const PHASES: readonly OfficePhase[] = [
	"Goal",
	"Plan",
	"Approval",
	"Implementation",
	"QA",
	"Independent Review",
	"Integration",
	"Cleanup",
	"Report",
];

/** The building for runs that name no project. */
export const UNASSIGNED = "(none)";

export const projectLabel = (id: string): string =>
	id === UNASSIGNED ? "미지정" : (id.split("/")[1] ?? id);

export const runKey = (r: Pick<RunView, "machine_id" | "run_id">): string =>
	`${r.machine_id}:${r.run_id}`;

/** A run's recent events by `runKey`, as GET /api/runs/:machine/:id/events returns them (newest first, may be partial). */
export type EventsByRun = ReadonlyMap<string, readonly RunEventView[]>;

export interface CurrentRun {
	run: RunView;
	key: string;
	project_id: string;
	/**
	 * What the cockpit last reported. The board classifies on this, never on `display`: with the Mac
	 * asleep every unfinished run becomes `snapshot_stale`, and visits, border and figures must stay put.
	 */
	state: RunDisplay;
	/** The last report is old (or the cockpit is offline): show "마지막 보고", freeze. */
	stale: boolean;
}

const ms = (iso: string | null): number => {
	const t = iso ? Date.parse(iso) : Number.NaN;
	return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
};

/**
 * Is `a` the more recent run? `last_progress_at` first (a missing one is oldest). `reported_at` can't
 * tell runs apart (one report carries them all) and `last_event_sequence` is per run, so ties fall to
 * the sequence and then to the run id (…-3 after …-2), which is deterministic.
 */
function newerRun(a: RunView, b: RunView): boolean {
	const t = ms(a.last_progress_at) - ms(b.last_progress_at);
	if (t !== 0 && !Number.isNaN(t)) return t > 0;
	const s = (a.last_event_sequence ?? -1) - (b.last_event_sequence ?? -1);
	if (s !== 0) return s > 0;
	return a.run_id.localeCompare(b.run_id, "en", { numeric: true }) > 0;
}

/** One run per (project, workflow): the most recent. The rest only appear in the detail view. */
export function currentRuns(runs: readonly RunView[]): CurrentRun[] {
	const best = new Map<string, RunView>();
	for (const r of runs) {
		const k = `${r.project ?? ""}\u0000${r.workflow_id}`;
		const cur = best.get(k);
		if (!cur || newerRun(r, cur)) best.set(k, r);
	}
	return [...best.values()].map((run) => ({
		run,
		key: runKey(run),
		project_id: run.project ?? UNASSIGNED,
		state: run.last_display,
		stale: run.display === "snapshot_stale",
	}));
}
