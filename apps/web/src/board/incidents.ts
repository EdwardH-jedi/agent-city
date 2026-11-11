// "자리 비운 사이": the last 8 things that happened, newest first (design doc §3). Two sources, both
// reports Office already sent: events of the current runs that have a sentence in the table, and the
// state each current run is in. Nothing is made up; a state the table doesn't know says 확인이 필요합니다.
// A run that is waiting for the owner has no line here: its card in HQ 대기 already says it, and the
// screen says a thing once. Lines are the short form (first sentence) so the list does not repeat
// "다음으로 넘어갑니다." on every row.
import {
	eventPhrase,
	firstSentence,
	PARTIAL_TEXT,
	PASSED_TEXT,
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
	limit = INCIDENT_LIMIT,
): Incident[] {
	const out: Incident[] = [];
	for (const c of current) {
		for (const e of eventsByRun.get(c.key) ?? []) {
			const text = eventPhrase(e);
			if (text && e.occurred_at) {
				out.push({
					at: e.occurred_at,
					project_id: c.project_id,
					text: firstSentence(text),
					code: null,
				});
			}
		}
		const at = c.run.last_progress_at ?? c.run.reported_at;
		const here = { at, project_id: c.project_id };
		switch (c.state) {
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
				// running / no_progress_suspected / snapshot_stale: in 지금 진행.
				// waiting_owner / hold / needs_reconcile: in HQ 대기.
				break;
		}
	}
	return out
		.sort(
			(a, b) =>
				Date.parse(b.at) - Date.parse(a.at) || a.text.localeCompare(b.text),
		)
		.slice(0, limit);
}
