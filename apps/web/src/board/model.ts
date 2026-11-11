// The one model both the 2D grid and (later) the 3D scene draw from (design doc §8). A pure function
// of what the hub reported and this screen's clock; no React, no DOM.
import type { MachineView, RunView } from "@agent-city/schema";
import type { Conn, Districts } from "../useHub.ts";
import { firstSentence } from "./copy.ts";
import { buildIncidents, INCIDENT_LIMIT, type Incident } from "./incidents.ts";
import {
	type CurrentRun,
	currentRuns,
	type EventsByRun,
	PHASES,
	projectLabel,
	UNASSIGNED,
} from "./types.ts";
import { buildVisits, emptyWatch, type Visit, type Watch } from "./visits.ts";

export const PARTIAL_RED_MS = 24 * 3_600_000;
export const REPO_RECENT_MS = 7 * 24 * 3_600_000;
/** At most this many project buildings stand in the village; the rest fold into one sign. */
export const BUILDING_CAP = 8;

export type Border = "red" | "yellow" | "none";
export type MonitorKind = "code" | "checks" | "review" | "other";

export interface VillageProject {
	id: string;
	label: string;
	running: number;
	waiting: number;
	stopped: number;
	/** No run and no activity in the last 7 days: folded into "조용함 N곳". */
	quiet: boolean;
	last_activity_at: string | null;
	/** One lit monitor per running run. */
	monitors: MonitorKind[];
}

export interface NowItem {
	key: string;
	project_id: string;
	workflow_id: string;
	phase: string;
	phase_index: number;
	display: RunView["display"];
	reported_at: string;
	machine_id: string;
	tokens_today: number | null;
	usage_unknown: boolean;
	/** "마지막 보고: running (N분 전)" instead of "cockpit 보고 · N초 전". */
	stale: boolean;
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
	/** The buildings that stand (at most BUILDING_CAP, most urgent first) and how many fold into one sign. */
	village: { shown: VillageProject[]; folded: number };
	visits: Visit[];
	/** The one speech bubble at the HQ door: the newest report. Signs speak through the HQ 대기 cards. */
	door: Visit | null;
	now: NowItem[];
	incidents: Incident[];
	today: { completed: number; running: number };
	/** Current run keys by the kind of attention they need; the sound planner compares these between ticks. */
	marks: { waiting: string[]; stopped: string[]; passed: string[] };
	conn: "open" | "reconnecting";
}

export interface ModelInput {
	runs: readonly RunView[];
	machines: readonly MachineView[];
	districts: Districts;
	eventsByRun: EventsByRun;
	/** Epoch ms of this screen's clock. */
	now: number;
	conn: Conn;
	/** Changes seen while the screen is open (phase / finish). */
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

export function toVillageModel(input: ModelInput): VillageModel {
	const { runs, machines, districts, eventsByRun, now } = input;
	const current = currentRuns(runs);
	const stopped = current.filter((c) => isStopped(c, now));
	const waiting = current.filter((c) => c.state === "waiting_owner");
	const running = current.filter((c) => RUNNING.has(c.state));

	const cockpit = machines.find((m) => m.id === "cockpit");
	const cockpitStatus = cockpit?.status ?? "unobserved";
	const down = cockpitStatus !== "online";

	// border: red > yellow > none. The cockpit going quiet changes neither; it dims instead (§7).
	const border: Border =
		stopped.length > 0 ? "red" : waiting.length > 0 ? "yellow" : "none";
	const parts: string[] = [];
	if (stopped.length) parts.push(`멈춤 ${stopped.length}건`);
	if (waiting.length) parts.push(`결재 ${waiting.length}건`);
	const sentence = down
		? cockpit?.heartbeat_at
			? `Mac 보고 끊김 (${agoKo(cockpit.heartbeat_at, now)})`
			: "Mac 보고 없음"
		: parts.length
			? parts.join(" · ")
			: "전부 정상";

	const visits = buildVisits(
		current,
		eventsByRun,
		input.watch ?? emptyWatch(),
		now,
	);
	const nowItems: NowItem[] = running
		.map((c) => ({
			key: c.key,
			project_id: c.project_id,
			workflow_id: c.run.workflow_id,
			phase: c.run.phase,
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

	const projects = buildProjects(runs, current, districts, now, {
		stopped,
		waiting,
		running,
	});
	const active = projects.filter((p) => !p.quiet);
	const shown = active.slice(0, BUILDING_CAP);
	const reports = visits.filter((v) => v.kind === "report");
	const conn = input.conn === "open" ? "open" : "reconnecting";
	const door = reports.reduce<Visit | null>(
		(a, v) => (!a || v.since > a.since ? v : a),
		null,
	);
	// the bubble already says it: the history list does not say it again (same project, time, sentence)
	const said = door
		? `${door.project_id}|${Date.parse(door.since)}|${firstSentence(door.text)}`
		: null;
	const incidents = buildIncidents(current, eventsByRun, INCIDENT_LIMIT + 1)
		.filter((i) => `${i.project_id}|${Date.parse(i.at)}|${i.text}` !== said)
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
		incidents,
		today: { completed, running: nowItems.length },
		marks: {
			waiting: waiting.map((c) => c.key),
			stopped: stopped.map((c) => c.key),
			passed: current.filter((c) => c.state === "passed").map((c) => c.key),
		},
		conn,
	};
}

function buildProjects(
	allRuns: readonly RunView[],
	current: readonly CurrentRun[],
	districts: Districts,
	now: number,
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

	return [...byId.values()].sort(
		(a, b) =>
			b.stopped - a.stopped ||
			b.waiting - a.waiting ||
			b.running - a.running ||
			(b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? "") ||
			a.label.localeCompare(b.label),
	);
}
