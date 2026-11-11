// The one model both the 2D grid and (later) the 3D scene draw from (design doc §8). A pure function
// of what the hub reported and this screen's clock; no React, no DOM.
import type { MachineView, RunView, Session } from "@agent-city/schema";
import type { Conn, Districts } from "../useHub.ts";
import { PROVIDER_NAME } from "./copy.ts";
import { buildIncidents, INCIDENT_LIMIT, type Incident } from "./incidents.ts";
import {
	type LiveSession,
	recentSessions,
	SESSION_WAIT_DEFAULT_MIN,
	splitWaiting,
	type WaitingSession,
} from "./sessions.ts";
import {
	type CurrentRun,
	currentRuns,
	type EventsByRun,
	PHASES,
	projectLabel,
	UNASSIGNED,
} from "./types.ts";
import {
	buildVisits,
	condSince,
	emptyWatch,
	settled,
	type Visit,
	type Watch,
} from "./visits.ts";

export const PARTIAL_RED_MS = 24 * 3_600_000;
export const REPO_RECENT_MS = 7 * 24 * 3_600_000;
/** At most this many project buildings stand in the village; the rest fold into one sign. */
export const BUILDING_CAP = 8;
/** Lit windows per building: running runs + active sessions, never more than this. */
export const WINDOW_CAP = 4;

export type Border = "red" | "yellow" | "none";
export type MonitorKind = "code" | "checks" | "review" | "other";

export interface VillageProject {
	id: string;
	label: string;
	running: number;
	waiting: number;
	stopped: number;
	/** `active` sessions in this repo (decision D4). */
	sessions: number;
	/** No run and no activity in the last 7 days: folded into "조용함 N곳". */
	quiet: boolean;
	last_activity_at: string | null;
	/** One lit monitor per running run, then one per active session: at most WINDOW_CAP. */
	monitors: MonitorKind[];
}

export interface NowItem {
	/** A dispatcher run (two lines, the phase bar) or a Claude / Codex session (one line, `N초 전`). */
	kind: "run" | "session";
	key: string;
	project_id: string;
	workflow_id: string;
	phase: string;
	/** The phase in the screen's language (구현, 검사 …); Office's name when unknown. */
	phase_label: string;
	phase_index: number;
	display: RunView["display"];
	reported_at: string;
	machine_id: string;
	tokens_today: number | null;
	usage_unknown: boolean;
	/** "마지막 보고: running (N분 전)" instead of "cockpit 보고 · N초 전". */
	stale: boolean;
}

/** A run resting between loops (decision D2): listed quietly under HQ 대기. */
export interface PausedItem {
	key: string;
	project_id: string;
	/** When it paused (its last progress). The next morning's knock is for runs paused before it. */
	since: string;
}

/** A session in the quiet 기다리는 세션 list (its HQ visit is over, or `?session_wait=0`). */
export interface WaitingItem {
	id: string;
	project_id: string;
	provider_label: string;
	since: string;
}

export interface VillageModel {
	status: {
		sentence: string;
		border: Border;
		/**
		 * The cockpit is not reporting, or this screen lost the hub: dim the village and freeze every
		 * figure. Nothing moves that was not reported.
		 */
		dim: boolean;
	};
	owner: { present: boolean; last_report_at: string | null };
	machines: {
		id: string;
		status: MachineView["status"];
		heartbeat_at: string | null;
	}[];
	projects: VillageProject[];
	/**
	 * The buildings that stand (at most BUILDING_CAP, most recent activity first; one with a flag is
	 * never left out) and how many fold into the one "조용함 N곳" sign.
	 */
	village: { shown: VillageProject[]; folded: number };
	visits: Visit[];
	/** The one speech bubble at the HQ door: the newest report. Signs speak through the HQ 대기 cards. */
	door: Visit | null;
	now: NowItem[];
	/** Decision D2: runs resting between loops (no visit, no sound, no border). */
	paused: PausedItem[];
	/** Decision D4: sessions still waiting for input after their HQ visit (no sound, no border). */
	waitingSessions: WaitingItem[];
	incidents: Incident[];
	today: { completed: number; running: number };
	/**
	 * What the sound planner compares between ticks: current run keys by the kind of attention they
	 * need (each only once its state has lasted 60 s), the session visits at the HQ (one knock each, no
	 * reminder), and the paused runs (one knock the next morning).
	 */
	marks: {
		waiting: string[];
		stopped: string[];
		passed: string[];
		sessions: string[];
		paused: { key: string; since: string }[];
	};
	conn: "open" | "reconnecting";
}

export interface ModelInput {
	runs: readonly RunView[];
	machines: readonly MachineView[];
	districts: Districts;
	eventsByRun: EventsByRun;
	/** Claude Code / Codex sessions as the hub sent them (decision D4). */
	sessions?: readonly Session[];
	/** `?session_wait=` in ms: how long a waiting session stays at the HQ; 0 = never visits. */
	sessionWaitMs?: number;
	/** Epoch ms of this screen's clock. */
	now: number;
	conn: Conn;
	/** Changes seen while the screen is open (phase / finish, when a condition or a wait began). */
	watch?: Watch;
}

/** "3분 전", "2시간 전", "1일 전". */
export function agoKo(iso: string | null, now: number): string {
	const t = iso ? Date.parse(iso) : Number.NaN;
	if (Number.isNaN(t)) return "알 수 없음";
	const s = Math.max(0, Math.floor((now - t) / 1000));
	if (s < 60) return `${s}초 전`;
	if (s < 3600) return `${Math.floor(s / 60)}분 전`;
	if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
	return `${Math.floor(s / 86400)}일 전`;
}

const monitorOf = (phase: string): MonitorKind =>
	phase === "Implementation"
		? "code"
		: phase === "QA"
			? "checks"
			: phase === "Independent Review"
				? "review"
				: "other";

const RUNNING = new Set(["running", "no_progress_suspected"]);

/** Closed as partial less than 24 h ago: red, and counted as stopped. */
function recentPartial(c: CurrentRun, now: number): boolean {
	if (c.state !== "partial") return false;
	const t = Date.parse(c.run.last_progress_at ?? c.run.reported_at);
	return !Number.isNaN(t) && now - t < PARTIAL_RED_MS;
}

const isStopped = (c: CurrentRun, now: number) =>
	c.state === "hold" || c.state === "needs_reconcile" || recentPartial(c, now);

export interface SignCard {
	/** The visits it stands for (one or more projects saying the same thing). */
	ids: string[];
	project_ids: string[];
	carry: "folder" | "binder";
	text: string;
	code: string | null;
	/** The oldest of them: how long the owner has been waited for. */
	since: string;
}

/**
 * The HQ 대기 cards: 결재 visits that say the same sentence (and code) share one card, so a sentence
 * is never on screen twice. 멈춤 (binder) cards come first so a red one is never folded out of sight,
 * then 승인 대기 (folder); oldest first within each.
 */
export function signCards(visits: readonly Visit[]): SignCard[] {
	const byText = new Map<string, SignCard>();
	for (const v of visits) {
		if (v.kind !== "sign") continue;
		const carry = v.carry ?? "folder";
		const k = `${carry}|${v.text}|${v.code ?? ""}`;
		const card = byText.get(k);
		if (!card) {
			byText.set(k, {
				ids: [v.id],
				project_ids: [v.project_id],
				carry,
				text: v.text,
				code: v.code,
				since: v.since,
			});
			continue;
		}
		card.ids.push(v.id);
		if (!card.project_ids.includes(v.project_id))
			card.project_ids.push(v.project_id);
		if (v.since < card.since) card.since = v.since;
	}
	const rank = (c: SignCard) => (c.carry === "binder" ? 0 : 1);
	return [...byText.values()].sort(
		(a, b) => rank(a) - rank(b) || a.since.localeCompare(b.since),
	);
}

const PHASE_LABEL: Readonly<Record<string, string>> = {
	Goal: "목표",
	Plan: "계획",
	Approval: "승인",
	Implementation: "구현",
	QA: "검사",
	"Independent Review": "리뷰",
	Integration: "통합",
	Cleanup: "정리",
	Report: "보고",
};

const recent = (a: VillageProject, b: VillageProject) =>
	(b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? "") ||
	a.label.localeCompare(b.label);

/**
 * §13: at most BUILDING_CAP buildings, chosen by recent activity. A building with a flag (결재 or
 * 멈춤) always stands, even when its activity is old, so a red or yellow one is never folded away.
 */
export function pickBuildings(
	active: readonly VillageProject[],
): VillageProject[] {
	const flagged = active.filter((p) => p.waiting + p.stopped > 0).sort(recent);
	const rest = active.filter((p) => p.waiting + p.stopped === 0).sort(recent);
	const picked = new Set(
		[...flagged, ...rest].slice(0, BUILDING_CAP).map((p) => p.id),
	);
	return active.filter((p) => picked.has(p.id)).sort(recent);
}

export function toVillageModel(input: ModelInput): VillageModel {
	const { runs, machines, districts, eventsByRun, now } = input;
	const watch = input.watch ?? emptyWatch();
	const current = currentRuns(runs);
	// decision D3: 결재 and 멈춤 count (visit, knock, border, flag, sentence) once they have lasted 60 s
	const stopped = current.filter(
		(c) => isStopped(c, now) && settled(c, watch, now),
	);
	const waiting = current.filter(
		(c) => c.state === "waiting_owner" && settled(c, watch, now),
	);
	const running = current.filter((c) => RUNNING.has(c.state));
	const paused = current.filter((c) => c.state === "paused");

	const live = recentSessions(input.sessions ?? [], now);
	const waits = splitWaiting(
		live,
		watch.waiting,
		machines,
		now,
		input.sessionWaitMs ?? SESSION_WAIT_DEFAULT_MIN * 60_000,
	);

	const cockpit = machines.find((m) => m.id === "cockpit");
	const cockpitStatus = cockpit?.status ?? "unobserved";
	const down = cockpitStatus !== "online";

	// border: red > yellow > none. The cockpit going quiet changes neither; it dims instead (§7).
	const border: Border =
		stopped.length > 0
			? "red"
			: waiting.length > 0 || waits.visits.length > 0
				? "yellow"
				: "none";
	const parts: string[] = [];
	if (stopped.length) parts.push(`멈춤 ${stopped.length}건`);
	if (waiting.length) parts.push(`결재 ${waiting.length}건`);
	if (waits.visits.length) parts.push(`입력 대기 ${waits.visits.length}건`);
	const sentence = down
		? cockpit?.heartbeat_at
			? `Mac 보고 끊김 (${agoKo(cockpit.heartbeat_at, now)})`
			: "Mac 보고 없음"
		: parts.length
			? parts.join(" · ")
			: "전부 정상";

	const visits = buildVisits(current, eventsByRun, watch, now, waits.visits);
	const nowItems: NowItem[] = running
		.map((c) => ({
			kind: "run" as const,
			key: c.key,
			project_id: c.project_id,
			workflow_id: c.run.workflow_id,
			phase: c.run.phase,
			phase_label: PHASE_LABEL[c.run.phase] ?? c.run.phase,
			phase_index: (PHASES as readonly string[]).indexOf(c.run.phase),
			display: c.state,
			reported_at: c.run.reported_at,
			machine_id: c.run.machine_id,
			tokens_today: c.run.tokens_today,
			usage_unknown: c.run.usage_unknown,
			stale: c.stale,
		}))
		.sort(
			(a, b) =>
				a.project_id.localeCompare(b.project_id) || a.key.localeCompare(b.key),
		);
	// then the active sessions, most recent first: one line each, no phase bar (decision D4)
	nowItems.push(...nowSessions(live));

	let completed = 0;
	const today = new Date(now).toDateString();
	for (const events of eventsByRun.values()) {
		for (const e of events) {
			if (
				e.transition === "task.completed" &&
				e.occurred_at &&
				new Date(e.occurred_at).toDateString() === today
			) {
				completed++;
			}
		}
	}

	const projects = buildProjects(runs, current, districts, now, live, {
		stopped,
		waiting,
		running,
	});
	const active = projects.filter((p) => !p.quiet);
	const shown = pickBuildings(active);
	const reports = visits.filter((v) => v.kind === "report");
	const conn = input.conn === "open" ? "open" : "reconnecting";
	const door = reports.reduce<Visit | null>(
		(a, v) => (!a || v.since > a.since ? v : a),
		null,
	);
	// the bubble already says it: the history list does not say it again (same project, time, sentence)
	// the bubble already says the newest report: its event is not listed again in 자리 비운 사이
	const said = door ? `${door.project_id}|${Date.parse(door.since)}` : null;
	const incidents = buildIncidents(current, eventsByRun, INCIDENT_LIMIT + 1)
		.filter(
			(i) =>
				i.source !== "event" || `${i.project_id}|${Date.parse(i.at)}` !== said,
		)
		.slice(0, INCIDENT_LIMIT);

	return {
		status: { sentence, border, dim: down || conn !== "open" },
		owner: {
			present: cockpitStatus === "online",
			last_report_at: cockpit?.heartbeat_at ?? null,
		},
		machines: machines.map((m) => ({
			id: m.id,
			status: m.status,
			heartbeat_at: m.heartbeat_at,
		})),
		projects,
		village: { shown, folded: projects.length - shown.length },
		visits,
		door,
		now: nowItems,
		paused: paused
			.map((c) => ({
				key: c.key,
				project_id: c.project_id,
				since: new Date(condSince(c, watch, now)).toISOString(),
			}))
			.sort(
				(a, b) =>
					a.project_id.localeCompare(b.project_id) ||
					a.key.localeCompare(b.key),
			),
		waitingSessions: waits.list.map(waitingItem),
		incidents,
		today: { completed, running: nowItems.length },
		marks: {
			waiting: waiting.map((c) => c.key),
			stopped: stopped.map((c) => c.key),
			passed: current.filter((c) => c.state === "passed").map((c) => c.key),
			sessions: waits.visits.map((w) => w.id),
			paused: paused.map((c) => ({
				key: c.key,
				since: new Date(condSince(c, watch, now)).toISOString(),
			})),
		},
		conn,
	};
}

const providerLabel = (p: string): string => PROVIDER_NAME[p] ?? p;

const waitingItem = (w: WaitingSession): WaitingItem => ({
	id: w.id,
	project_id: w.project_id,
	provider_label: providerLabel(w.provider),
	since: w.since,
});

/** 지금 진행 rows for the `active` sessions: `프로젝트 · Claude` and the age of the last event. */
function nowSessions(live: readonly LiveSession[]): NowItem[] {
	return live
		.filter((s) => s.status === "active")
		.sort(
			(a, b) =>
				b.last_event_at.localeCompare(a.last_event_at) ||
				a.id.localeCompare(b.id),
		)
		.map((s) => ({
			kind: "session" as const,
			key: `session:${s.id}`,
			project_id: s.project_id,
			workflow_id: "",
			phase: "",
			phase_label: providerLabel(s.provider),
			phase_index: -1,
			display: "running" as const,
			reported_at: s.last_event_at,
			machine_id: s.machine_id,
			tokens_today: null,
			usage_unknown: false,
			stale: false,
		}));
}

function buildProjects(
	allRuns: readonly RunView[],
	current: readonly CurrentRun[],
	districts: Districts,
	now: number,
	live: readonly LiveSession[],
	groups: {
		stopped: CurrentRun[];
		waiting: CurrentRun[];
		running: CurrentRun[];
	},
): VillageProject[] {
	const byId = new Map<string, VillageProject>();
	const slot = (id: string): VillageProject => {
		const k = id.toLowerCase();
		let p = byId.get(k);
		if (!p) {
			p = {
				id,
				label: projectLabel(id),
				running: 0,
				waiting: 0,
				stopped: 0,
				sessions: 0,
				quiet: true,
				last_activity_at: null,
				monitors: [],
			};
			byId.set(k, p);
		}
		return p;
	};
	const later = (p: VillageProject, iso: string | null) => {
		if (iso && (!p.last_activity_at || iso > p.last_activity_at))
			p.last_activity_at = iso;
	};

	for (const r of allRuns) slot(r.project ?? UNASSIGNED).quiet = false;
	for (const c of groups.running) {
		const p = slot(c.project_id);
		p.running++;
		p.monitors.push(monitorOf(c.run.phase));
	}
	for (const c of groups.waiting) slot(c.project_id).waiting++;
	for (const c of groups.stopped) slot(c.project_id).stopped++;
	for (const c of current)
		later(slot(c.project_id), c.run.last_progress_at ?? c.run.reported_at);

	for (const repo of Object.values(districts).flat()) {
		const p = slot(repo.id);
		later(p, repo.pushed_at);
		const pushed = repo.pushed_at ? Date.parse(repo.pushed_at) : Number.NaN;
		if (
			repo.active_sessions > 0 ||
			(!Number.isNaN(pushed) && now - pushed < REPO_RECENT_MS)
		) {
			p.quiet = false;
		}
	}

	// decision D4: a session active in the last 7 days makes its repo a building; an `active` one lights a
	// window (idle / stale / ended / waiting light nothing). `live` holds only the last 7 days.
	for (const s of live) {
		if (!s.has_repo) continue; // D4 counts the repo; a session outside a checkout raises no building
		const p = slot(s.project_id);
		p.quiet = false;
		later(p, s.last_event_at);
		if (s.status === "active") {
			p.sessions++;
			p.monitors.push("code");
		}
	}
	for (const p of byId.values()) p.monitors = p.monitors.slice(0, WINDOW_CAP);

	return [...byId.values()].sort(
		(a, b) =>
			b.stopped - a.stopped ||
			b.waiting - a.waiting ||
			b.running - a.running ||
			(b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? "") ||
			a.label.localeCompare(b.label),
	);
}
