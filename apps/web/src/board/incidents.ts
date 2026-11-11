// "자리 비운 사이": the last 8 things that happened, newest first (design doc §3). Two sources, both
// reports Office already sent: events of the current runs that have a sentence in the table, and the
// state each current run is in. Nothing is made up; a state the table doesn't know says 확인이 필요합니다.
import {
	eventPhrase,
	PARTIAL_TEXT,
	PASSED_TEXT,
	stopPhrase,
	UNKNOWN_TEXT,
} from "./copy.ts";
import type { CurrentRun, EventsByRun } from "./types.ts";

export const INCIDENT_LIMIT = 8;

export interface Incident {
	at: string;
	project_id: string;
	text: string;
	code: string | null;
}

export function buildIncidents(
	current: readonly CurrentRun[],
	eventsByRun: EventsByRun,
): Incident[] {
	const out: Incident[] = [];
	for (const c of current) {
		for (const e of eventsByRun.get(c.key) ?? []) {
			const text = eventPhrase(e);
			if (text && e.occurred_at) {
				out.push({
					at: e.occurred_at,
					project_id: c.project_id,
					text,
					code: null,
				});
			}
		}
		const at = c.run.last_progress_at ?? c.run.reported_at;
		const here = { at, project_id: c.project_id };
		switch (c.state) {
			case "waiting_owner":
			case "hold":
			case "needs_reconcile": {
				const p = stopPhrase({ ...c.run, last_display: c.state });
				out.push({ ...here, text: p.text, code: p.code });
				break;
			}
			case "passed":
				out.push({ ...here, text: PASSED_TEXT, code: null });
				break;
			case "partial":
				out.push({ ...here, text: PARTIAL_TEXT, code: c.run.reason });
				break;
			case "unverified":
			case "unknown":
				// not a visit: an old finished run stays `unverified` forever (doc §3)
				out.push({
					...here,
					text: UNKNOWN_TEXT,
					code: c.run.alert ?? c.run.reason ?? c.run.status,
				});
				break;
			default:
				break; // running / no_progress_suspected / snapshot_stale: shown in 지금 진행
		}
	}
	return out
		.sort(
			(a, b) =>
				Date.parse(b.at) - Date.parse(a.at) || a.text.localeCompare(b.text),
		)
		.slice(0, INCIDENT_LIMIT);
}
