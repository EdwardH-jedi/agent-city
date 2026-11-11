// Visits to the HQ (design doc §5). A 결재 (sign) visit lasts while the run still needs the owner and
// ends when its state changes — never because time passed. A 보고 (report) visit says what Office
// already did: it stays 5 minutes from the event, then says "진행하겠습니다." for 5 seconds and goes.
import type { RunEventView } from "@agent-city/schema";
import {
	AGAIN_TEXT,
	eventPhrase,
	LEAVING_TEXT,
	PARTIAL_TEXT,
	PASSED_TEXT,
	REVIEW_TEXT,
	SESSION_WAIT_TEXT,
	stopPhrase,
} from "./copy.ts";
import {
	type Dwell,
	dwellAt,
	isHeld,
	type LiveSession,
	type MachineLike,
	sessionClock,
	stepDwell,
	stepWaiting,
	type Waiting,
	type WaitingSession,
} from "./sessions.ts";
import type { CurrentRun, EventsByRun } from "./types.ts";

export const REPORT_STAY_MS = 5 * 60_000;
export const REPORT_LEAVE_MS = 5_000;

export interface Visit {
	/** `${machine_id}:${run_id}` — the same run keeps the same visit (no restart of the walk). */
	id: string;
	kind: "sign" | "report";
	project_id: string;
	/** What the figure carries: 승인 대기 = folder, 멈춤 = binder. Reports carry nothing. */
	carry: "folder" | "binder" | null;
	text: string;
	code: string | null;
	/** When it began: the report's event time, or the last progress of a run that needs the owner. */
	since: string;
	/** Reports only: the end of the stay (event + 5 min). */
	until: string | null;
	/** Reports only: the stay is over and the figure is on its way back. */
	closing: boolean;
}

const SIGN_STATES = new Set(["waiting_owner", "hold", "needs_reconcile"]);

// ── decision D3: a 결재 visit, its knock and the border start only once the state has lasted 60 s ──

/** What a run is "in" for the 60 s rule: its state and the code behind it (a new code restarts it). */
export const condOf = (c: CurrentRun): string =>
	`${c.state}|${c.run.alert ?? ""}|${c.run.reason ?? ""}`;

/**
 * When the run's current condition began (epoch ms). Once the screen has watched it, the time it first
 * saw this condition; otherwise Office's `last_progress_at` (which moves with every ledger change). A
 * run without one began now: `reported_at` moves with every report and would never let 60 s pass.
 */
export function condSince(c: CurrentRun, watch: Watch, now: number): number {
	const seen = watch.seen[c.key];
	if (seen && seen.cond === condOf(c)) return seen.since;
	const t = Date.parse(c.run.last_progress_at ?? "");
	return Number.isNaN(t) ? now : t;
}

/**
 * Has the run been in this condition for 60 s? Before that it makes no visit, sound or border. The count
 * is the one the watch followed (it stands still while the Mac is not reporting and starts again when it
 * is back, 07 §7); a model built without a watch counts on the clock that stops with the cockpit.
 */
export function settled(
	c: CurrentRun,
	watch: Watch,
	now: number,
	machines: readonly MachineLike[] = [],
): boolean {
	const seen = watch.seen[c.key];
	if (seen && seen.cond === condOf(c)) return seen.dwell.ok;
	return dwellAt(
		condSince(c, watch, now),
		sessionClock(c.run.machine_id, machines, now),
	);
}

/**
 * One sign per current run that needs the owner and has for 60 s. `unverified` is not one (it lands in
 * the incidents); `paused` is not one either (decision D2: it has its own quiet list).
 */
export function signVisits(
	current: readonly CurrentRun[],
	watch: Watch,
	now: number,
	machines: readonly MachineLike[] = [],
): Visit[] {
	return current
		.filter((c) => SIGN_STATES.has(c.state) && settled(c, watch, now, machines))
		.map((c) => {
			const p = stopPhrase({ ...c.run, last_display: c.state });
			const since = new Date(condSince(c, watch, now)).toISOString();
			return {
				id: c.key,
				kind: "sign" as const,
				project_id: c.project_id,
				carry:
					c.state === "waiting_owner"
						? ("folder" as const)
						: ("binder" as const),
				text: p.text,
				code: p.code,
				since,
				until: null,
				closing: false,
			};
		})
		.sort((a, b) => a.since.localeCompare(b.since));
}

/** A session waiting for input at the HQ (decision D4): it carries a folder, like a run waiting for the owner. */
export function sessionVisit(w: WaitingSession): Visit {
	return {
		id: w.id,
		kind: "sign",
		project_id: w.project_id,
		carry: "folder",
		text: SESSION_WAIT_TEXT,
		code: null,
		since: w.since,
		until: null,
		closing: false,
	};
}

function reportVisit(
	c: CurrentRun,
	text: string,
	atMs: number,
	now: number,
): Visit | null {
	const until = atMs + REPORT_STAY_MS;
	if (Number.isNaN(atMs) || now >= until + REPORT_LEAVE_MS) return null;
	const closing = now >= until;
	return {
		id: c.key,
		kind: "report",
		project_id: c.project_id,
		carry: null,
		text: closing ? LEAVING_TEXT : text,
		code: null,
		since: new Date(atMs).toISOString(),
		until: new Date(until).toISOString(),
		closing,
	};
}

/** The report an event stands for, if any. `task.failed` counts only once a later start proves another attempt. */
function eventText(
	e: RunEventView,
	all: readonly RunEventView[],
): string | null {
	const t = eventPhrase(e);
	if (t) return t;
	if (e.transition === "task.failed") {
		const again = all.some(
			(o) =>
				o.transition === "task.started" &&
				o.task_id === e.task_id &&
				o.sequence > e.sequence,
		);
		return again ? AGAIN_TEXT : null;
	}
	return null;
}

/** Reports backed by a run event. An event older than the stay makes none (a freshly opened screen). */
function eventReports(
	current: readonly CurrentRun[],
	eventsByRun: EventsByRun,
	now: number,
): Visit[] {
	const out: Visit[] = [];
	for (const c of current) {
		const events = eventsByRun.get(c.key) ?? [];
		let best: Visit | null = null;
		for (const e of events) {
			const text = eventText(e, events);
			if (!text) continue;
			const v = reportVisit(c, text, Date.parse(e.occurred_at ?? ""), now);
			if (v && (!best || v.since > best.since)) best = v;
		}
		if (best) out.push(best);
	}
	return out;
}

// ── changes only this screen can see (a phase or state change has no event time) ─────────────────

export interface Seen {
	state: string;
	phase: string;
	/** `condOf` and when this screen takes it to have begun. */
	cond: string;
	since: number;
	/** Its 60 s count (decision D3), held while the Mac is not reporting. */
	dwell: Dwell;
}

export interface Watch {
	seen: Readonly<Record<string, Seen>>;
	observed: readonly { c: CurrentRun; text: string; at: number }[];
	/** Sessions seen `waiting`, by session id: when the wait began and its 60 s count (decision D4). */
	waiting: Readonly<Record<string, Waiting>>;
}

export const emptyWatch = (): Watch => ({
	seen: {},
	observed: [],
	waiting: {},
});

/**
 * Remember the states seen and note the changes that happen while the screen is open: the run entered
 * Independent Review, or finished (passed/partial). On first sight a run is only remembered, so opening
 * the screen never replays old news. The time of such a report is when this screen saw it.
 *
 * Also the start of each run's condition (60 s rule): kept while the condition holds; on first sight
 * Office's `last_progress_at` (or now without one); a change seen while open began no earlier than now.
 * And the start of each session's wait (`live`, already re-derived at `now`). Each 60 s count stands
 * still while the Mac is not reporting (`machines`, re-derived at `now`).
 */
export function stepWatch(
	prev: Watch,
	current: readonly CurrentRun[],
	now: number,
	live: readonly LiveSession[] = [],
	machines: readonly MachineLike[] = [],
): Watch {
	const seen: Record<string, Seen> = {};
	const observed = prev.observed.filter(
		(o) => now < o.at + REPORT_STAY_MS + REPORT_LEAVE_MS,
	);
	for (const c of current) {
		const before = prev.seen[c.key];
		const cond = condOf(c);
		const data = Date.parse(c.run.last_progress_at ?? "");
		const since =
			before?.cond === cond
				? before.since
				: before
					? Math.max(Number.isNaN(data) ? now : data, now)
					: Number.isNaN(data)
						? now
						: data;
		const dwell = stepDwell(
			before?.cond === cond ? before.dwell : undefined,
			since,
			isHeld(c.run.machine_id, machines, now),
			now,
		);
		seen[c.key] = { state: c.state, phase: c.run.phase, cond, since, dwell };
		if (!before) continue;
		let text: string | null = null;
		if (c.state !== before.state) {
			if (c.state === "passed") text = PASSED_TEXT;
			else if (c.state === "partial") text = PARTIAL_TEXT;
		} else if (
			c.run.phase !== before.phase &&
			c.run.phase === "Independent Review"
		) {
			text = REVIEW_TEXT;
		}
		if (text) {
			const i = observed.findIndex((o) => o.c.key === c.key);
			if (i >= 0) observed.splice(i, 1);
			observed.push({ c, text, at: now });
		}
	}
	return {
		seen,
		observed,
		waiting: stepWaiting(prev.waiting, live, machines, now),
	};
}

/**
 * Everything that is at the HQ now: signs oldest first (they sit in the lobby in arrival order; a
 * session waiting for input is one of them), then at most one report per project (a newer one replaces
 * the older), and none for a run that has a sign.
 */
export function buildVisits(
	current: readonly CurrentRun[],
	eventsByRun: EventsByRun,
	watch: Watch,
	now: number,
	sessionWaits: readonly WaitingSession[] = [],
	machines: readonly MachineLike[] = [],
): Visit[] {
	const signs = [
		...signVisits(current, watch, now, machines),
		...sessionWaits.map(sessionVisit),
	].sort((a, b) => a.since.localeCompare(b.since) || a.id.localeCompare(b.id));
	const signed = new Set(signs.map((s) => s.id));
	const candidates = [
		...eventReports(current, eventsByRun, now),
		...watch.observed.flatMap((o) => {
			const v = reportVisit(o.c, o.text, o.at, now);
			return v ? [v] : [];
		}),
	].filter((v) => !signed.has(v.id));
	const byProject = new Map<string, Visit>();
	for (const v of candidates) {
		const cur = byProject.get(v.project_id);
		if (!cur || v.since > cur.since) byProject.set(v.project_id, v);
	}
	return [
		...signs,
		...[...byProject.values()].sort((a, b) => a.since.localeCompare(b.since)),
	];
}
