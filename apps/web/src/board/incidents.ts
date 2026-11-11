// "자리 비운 사이" (design doc §3, §13.4): the last 6 things that happened, newest first, one short line
// each — `시각 · 프로젝트 · 짧은 말` (`17:03 docs T3 통과`). Two sources, both reports Office already sent:
// events of the current runs that the phrase table knows, and the state each current run is in. Nothing
// is made up; a state the table doesn't know says 확인 필요. Code strings stay in the detail view.
import { codeShort, eventShort, SHORT } from "./copy.ts";
import type { CurrentRun, EventsByRun } from "./types.ts";

export const INCIDENT_LIMIT = 6;

export interface Incident {
	at: string;
	project_id: string;
	text: string;
	/** Office's code behind the line (kept for the model and tests; never drawn on the board). */
	code: string | null;
	/** A run event (can be what the door bubble is saying) or the run's current state. */
	source: "event" | "state";
}

export function buildIncidents(
	current: readonly CurrentRun[],
	eventsByRun: EventsByRun,
	limit = INCIDENT_LIMIT,
): Incident[] {
	const out: Incident[] = [];
	for (const c of current) {
		for (const e of eventsByRun.get(c.key) ?? []) {
			const text = eventShort(e);
			if (text && e.occurred_at) {
				out.push({
					at: e.occurred_at,
					project_id: c.project_id,
					text,
					code: null,
					source: "event",
				});
			}
		}
		const at = c.run.last_progress_at ?? c.run.reported_at;
		const code = c.run.alert ?? c.run.reason;
		const line = (text: string, code: string | null) =>
			out.push({ at, project_id: c.project_id, text, code, source: "state" });
		switch (c.state) {
			case "waiting_owner":
				line(SHORT.sign, code);
				break;
			case "hold":
			case "needs_reconcile":
				line(codeShort(code) ?? SHORT.stopped, code);
				break;
			case "passed":
				line(SHORT.passed, null);
				break;
			case "partial":
				line(codeShort(c.run.reason) ?? SHORT.partial, c.run.reason);
				break;
			case "unverified":
				// not a visit: an old finished run stays `unverified` forever (doc §3: 확인 필요)
				line(SHORT.unknown, code ?? c.run.status);
				break;
			case "unknown":
				line(codeShort(code) ?? SHORT.unknown, code ?? c.run.status);
				break;
			default:
				break; // running / no_progress_suspected / snapshot_stale: in 지금 진행
		}
	}
	return out
		.sort(
			(a, b) =>
				Date.parse(b.at) - Date.parse(a.at) || a.text.localeCompare(b.text),
		)
		.slice(0, limit);
}

export type IncidentRow =
	| { kind: "day"; label: string }
	| { kind: "item"; incident: Incident };

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** "어제", or "11월 9일" for older days (this screen's local date). */
export function dayLabel(at: Date, now: Date): string {
	const y = new Date(now);
	y.setDate(y.getDate() - 1);
	if (dayKey(at) === dayKey(y)) return "어제";
	return `${at.getMonth() + 1}월 ${at.getDate()}일`;
}

/**
 * The list as drawn: a divider line wherever the date changes (none before today's lines). Pure; the
 * dates are this screen's local dates.
 */
export function incidentRows(
	incidents: readonly Incident[],
	now: number,
): IncidentRow[] {
	const today = dayKey(new Date(now));
	const rows: IncidentRow[] = [];
	let last = today;
	for (const incident of incidents) {
		const d = new Date(incident.at);
		const k = Number.isNaN(d.getTime()) ? last : dayKey(d);
		if (k !== last) {
			rows.push({ kind: "day", label: dayLabel(d, new Date(now)) });
			last = k;
		}
		rows.push({ kind: "item", incident });
	}
	return rows;
}
