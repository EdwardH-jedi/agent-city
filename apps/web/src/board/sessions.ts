// Claude Code / Codex sessions in the village (decision D4). Pure, no React. The hub already sends them
// (GET /api/sessions + ws `session`); nothing here asks for more. A session is drawn by its repo only:
// never its working folder, branch or raw id (decision D5 keeps those in the session tables, not on
// the board).
//
// - building: a session whose last activity is within 7 days makes its repo a building
// - window light: one per `active` session (with the running runs; at most 4 per building)
// - 지금 진행: one line per `active` session, `프로젝트 · Claude` and `N초 전`
// - `waiting` for 60 s → the lead visits the HQ ("입력을 기다리고 있습니다."), one knock, yellow border;
//   30 min after the wait began the visit ends and the session moves to the quiet 기다리는 세션 list
// - `idle`, `stale`, `ended` light nothing and visit nobody
import {
	applyStale,
	HEARTBEAT_ONLINE_BELOW_MS,
	type MachineView,
	type Session,
	type SessionStatus,
} from "@agent-city/schema";
import { UNASSIGNED } from "./types.ts";

/** A session older than this (last activity) makes no building and is in no list. */
export const SESSION_RECENT_MS = 7 * 24 * 3_600_000;
/** `?session_wait=` default, in minutes: how long a waiting session stays at the HQ. */
export const SESSION_WAIT_DEFAULT_MIN = 30;
/** Decision D3: a visit, a knock and a border start only once the state has lasted this long. */
export const DWELL_MS = 60_000;

/**
 * `?session_wait=30` → 30 min at the HQ; `0` → no session visit at all (they go straight to the
 * list). Anything else keeps the default. A URL query, never an env variable.
 */
export function parseSessionWait(search: string): number {
	const raw = new URLSearchParams(search).get("session_wait");
	const min =
		raw !== null && /^\d{1,4}$/.test(raw)
			? Number(raw)
			: SESSION_WAIT_DEFAULT_MIN;
	return min * 60_000;
}

export interface LiveSession {
	id: string;
	/** The repo, or 미지정 when the session ran outside a checkout (no building for those). */
	project_id: string;
	has_repo: boolean;
	provider: Session["provider"];
	machine_id: string;
	/** Re-derived with this screen's clock: an `active` session silent for 15 min is `stale`. */
	status: SessionStatus;
	last_event_at: string;
}

/** Sessions whose last activity is within 7 days, with their status at `now`. */
export function recentSessions(
	sessions: readonly Session[],
	now: number,
): LiveSession[] {
	const out: LiveSession[] = [];
	for (const s of sessions) {
		const t = Date.parse(s.last_event_at);
		if (Number.isNaN(t) || now - t >= SESSION_RECENT_MS) continue;
		out.push({
			id: s.id,
			project_id: s.repo_id ?? UNASSIGNED,
			has_repo: s.repo_id !== null,
			provider: s.provider,
			machine_id: s.machine_id,
			status: applyStale(s.status, s.last_event_at, new Date(now)),
			last_event_at: s.last_event_at,
		});
	}
	return out;
}

type MachineLike = Pick<MachineView, "id" | "status" | "heartbeat_at">;

/**
 * When a machine stopped reporting: the moment it stopped counting as online (last heartbeat + 90 s),
 * so the clock never runs backwards as it turns stale. `now` while it is online or never observed.
 */
function machineClock(
	machineId: string,
	machines: readonly MachineLike[],
	now: number,
): number {
	const m = machines.find((x) => x.id === machineId);
	if (!m || m.status === "online" || m.status === "unobserved") return now;
	const beat = m.heartbeat_at ? Date.parse(m.heartbeat_at) : Number.NaN;
	return Number.isNaN(beat)
		? now
		: Math.min(now, beat + HEARTBEAT_ONLINE_BELOW_MS);
}

/**
 * The clock the 60 s rule and a session's visit run on (§7, Q4: cockpit offline stops session visits).
 * It stops when the cockpit stops reporting, and also when the item's own machine does: no new visit
 * starts, none ends by time, nothing moves that was not reported. Never later than `now`.
 */
export function sessionClock(
	machineId: string,
	machines: readonly MachineLike[],
	now: number,
): number {
	return Math.min(
		machineClock(machineId, machines, now),
		machineClock("cockpit", machines, now),
	);
}

/** The visit id of a session (decision D4): stable for the whole wait, so the walk never restarts. */
export const sessionVisitId = (id: string): string => `session:${id}`;

export interface WaitingSession {
	/** `session:<id>`. */
	id: string;
	project_id: string;
	provider: Session["provider"];
	/** When the wait began. */
	since: string;
}

/**
 * Waiting sessions split into the ones at the HQ (60 s ≤ waited < `waitMs`) and the ones in the quiet
 * list (waited ≥ `waitMs`, or `waitMs` = 0). Under 60 s a session is in neither. `waitingSince` holds
 * when this screen first saw each wait (an event that keeps the session waiting does not restart it);
 * a wait this screen has not seen began at the session's last event.
 */
export function splitWaiting(
	live: readonly LiveSession[],
	waitingSince: Readonly<Record<string, number>>,
	machines: readonly MachineLike[],
	now: number,
	waitMs: number,
): { visits: WaitingSession[]; list: WaitingSession[] } {
	const visits: WaitingSession[] = [];
	const list: WaitingSession[] = [];
	for (const s of live) {
		if (s.status !== "waiting") continue;
		const since = waitingSince[s.id] ?? Date.parse(s.last_event_at);
		if (Number.isNaN(since)) continue;
		const clock = sessionClock(s.machine_id, machines, now);
		const waited = clock - since;
		if (waited < DWELL_MS) continue;
		const w: WaitingSession = {
			id: sessionVisitId(s.id),
			project_id: s.project_id,
			provider: s.provider,
			since: new Date(since).toISOString(),
		};
		if (waitMs > 0 && waited < waitMs) visits.push(w);
		else list.push(w);
	}
	const bySince = (a: WaitingSession, b: WaitingSession) =>
		a.since.localeCompare(b.since) || a.id.localeCompare(b.id);
	return { visits: visits.sort(bySince), list: list.sort(bySince) };
}

/**
 * Remember when each wait began, as this screen saw it: kept while the session stays `waiting` (a
 * second Notification does not restart the 60 s or the walk), dropped as soon as it is not.
 */
export function stepWaiting(
	prev: Readonly<Record<string, number>>,
	live: readonly LiveSession[],
): Record<string, number> {
	const next: Record<string, number> = {};
	for (const s of live) {
		if (s.status !== "waiting") continue;
		const t = Date.parse(s.last_event_at);
		const kept = prev[s.id];
		if (kept !== undefined) next[s.id] = kept;
		else if (!Number.isNaN(t)) next[s.id] = t;
	}
	return next;
}
