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
	stopPhrase,
} from "./copy.ts";
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

/** One sign per current run that needs the owner. `unverified` is not one (it lands in the incidents). */
export function signVisits(current: readonly CurrentRun[]): Visit[] {
	return current
		.filter((c) => SIGN_STATES.has(c.state))
		.map((c) => {
			const p = stopPhrase({ ...c.run, last_display: c.state });
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
				since: c.run.last_progress_at ?? c.run.reported_at,
				until: null,
				closing: false,
			};
		})
		.sort((a, b) => a.since.localeCompare(b.since));
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

export interface Watch {
	seen: Readonly<Record<string, { state: string; phase: string }>>;
	observed: readonly { c: CurrentRun; text: string; at: number }[];
}

export const emptyWatch = (): Watch => ({ seen: {}, observed: [] });

/**
 * Remember the states seen and note the changes that happen while the screen is open: the run entered
 * Independent Review, or finished (passed/partial). On first sight a run is only remembered, so opening
 * the screen never replays old news. The time of such a report is when this screen saw it.
 */
export function stepWatch(
	prev: Watch,
	current: readonly CurrentRun[],
	now: number,
): Watch {
	const seen: Record<string, { state: string; phase: string }> = {};
	const observed = prev.observed.filter(
		(o) => now < o.at + REPORT_STAY_MS + REPORT_LEAVE_MS,
	);
	for (const c of current) {
		seen[c.key] = { state: c.state, phase: c.run.phase };
		const before = prev.seen[c.key];
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
	return { seen, observed };
}

/**
 * Everything that is at the HQ now: signs oldest first (they sit in the lobby in arrival order), then
 * at most one report per project (a newer one replaces the older), and none for a run that has a sign.
 */
export function buildVisits(
	current: readonly CurrentRun[],
	eventsByRun: EventsByRun,
	watch: Watch,
	now: number,
): Visit[] {
	const signs = signVisits(current);
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
