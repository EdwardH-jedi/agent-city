// The right panel's model (design doc 15 §3): projects, their Claude / Codex sessions, and a terminal
// tail under each working session. Pure, no React. It reads the sessions the screen already has (GET
// /api/sessions + ws `session`) and the tails tail.ts made from the events it already has — nothing new is
// fetched. The decisions (who visits, sounds, 60 s, 30 min) stay in visits.ts / sessions.ts; this only
// arranges what is shown. It is the one board module that reads a session's folder (`cwd`, only to make
// tail paths relative; never shown) and branch (a project's tag when it has no run) — decision D10.
//
// - groups: a project with a visible session, a run waiting for the owner, a running run or a paused one
//   — at most GROUP_CAP; first those that need the owner (결재 or 입력 대기), then those working, then the
//   most recent activity
// - rows: `active`, `waiting`, and `idle` or `stale` within REST_SHOWN_MS (6 h) of its last activity
//   (`ended` is hidden). The status is re-derived with this screen's clock (applyStale, as the town does):
//   an `idle` or `active` session silent for 15 min is `stale` (the hub stores the same); its row stays,
//   dim, as 쉬는 중 with no tail (no window light, no visit — the town is unchanged). A `waiting` session
//   whose HQ visit is over (model.waitingSessions: sessions.ts's 30 min / `?session_wait=`, read only)
//   keeps its row with a dim 입력 대기 tag and how long it has waited; it no longer counts as 대기 nor puts
//   its project first. In a group: 입력 대기 → 진행 → 오래된 입력 대기 → 쉬는 중, newest first; at most
//   ROWS_PER_GROUP, then `외 N`.
// - tails: under `active` and `waiting` rows only, at most TAIL_CAP boxes of `tailMax` lines (the lines
//   come from the screen's memory, tail-memory.ts)
// - caps: ROW_CAP rows in all; then it must fit `budget` px with no scroll — folding first the oldest
//   active session's tail, then the waiting ones' tails, then rows (resting before old waits before
//   active, the last groups first; a 입력 대기 row is the last to go), then whole groups from the end
import { applyStale, type Session } from "@agent-city/schema";
import { PAUSED_TAG, PROVIDER_NAME, SHORT, tagOfCode } from "./copy.ts";
import type { VillageModel } from "./model.ts";
import { SESSION_RECENT_MS } from "./sessions.ts";
import type { TailLine } from "./tail.ts";
import { projectLabel, UNASSIGNED } from "./types.ts";

export const GROUP_CAP = 8;
export const ROWS_PER_GROUP = 4;
export const ROW_CAP = 16;
export const TAIL_CAP = 6;
/** An `idle` or `stale` session shows (dim, 쉬는 중) this long after its last activity. */
export const REST_SHOWN_MS = 6 * 3_600_000;

/**
 * Heights the panel's rows are drawn at (style.css uses the same numbers): text rows scale with --ui,
 * boxes and gaps do not. The fit below is plain arithmetic on these.
 */
export const PX = {
	groupHead: 20, // × ui
	phase: 6,
	row: 18, // × ui
	tailLine: 15, // × ui
	tailBox: 10, // padding 4 + 4, margin 2
	more: 16, // × ui
	groupGap: 8,
} as const;

export type RowStatus = "active" | "waiting" | "idle" | "stale";

export interface PanelRow {
	id: string;
	provider: string;
	/** `opus 5.5` (tail.ts shortModel), or null when the hub has no model. */
	model: string | null;
	status: RowStatus;
	/**
	 * A `waiting` row whose HQ visit is over: when the wait began (the tag is dim and shows how long).
	 * Null for a wait still at the HQ (yellow) and for every other status.
	 */
	waited_since: string | null;
	last_event_at: string;
	subagents: number;
	tail: TailLine[];
}

export interface GroupTag {
	text: string;
	kind: "wait" | "stop" | "run" | "pause" | "branch";
}

export interface PanelGroup {
	project_id: string;
	label: string;
	tag: GroupTag | null;
	/** The run's phase (0–8) for the thin bar under the project, or null. */
	phase: number | null;
	rows: PanelRow[];
	/** Rows folded into `외 N`. */
	more: number;
}

export interface SessionPanel {
	groups: PanelGroup[];
	/** Groups folded away (`외 N곳`). */
	moreGroups: number;
	/**
	 * Every visible session, before any cap (`진행 1 · 대기 1 · 쉼 2`): 대기 counts only the yellow waits
	 * (an old wait is in none of the three), 쉼 the `idle` and `stale` rows.
	 */
	counts: { active: number; waiting: number; idle: number };
}

export interface PanelInput {
	sessions: readonly Session[];
	tails: ReadonlyMap<string, { lines: TailLine[]; subagents: number }>;
	model: Pick<VillageModel, "visits" | "now" | "paused" | "waitingSessions">;
	now: number;
	/** Height in px the list may take (the panel never scrolls). Infinity: no fit. */
	budget: number;
	ui: number;
	/** Lines per tail: 3, or 2 on a screen under 1600 px wide. */
	tailMax: number;
	/** Short model name (tail.ts shortModel), passed in to keep this module free of tail rules. */
	shortModel: (m: string | null) => string | null;
}

/** The session's folder, for tail.ts (relative paths). Never drawn. */
export function cwdLookup(
	sessions: readonly Session[],
): (id: string) => string | null {
	const m = new Map(sessions.map((s) => [s.id, s.cwd]));
	return (id) => m.get(id) ?? null;
}

/** Order in a group and what folds last (lower stays): a yellow wait, working, an old wait, resting. */
const rank = (r: Pick<PanelRow, "status" | "waited_since">): number =>
	r.status === "waiting"
		? r.waited_since
			? 2
			: 0
		: r.status === "active"
			? 1
			: 3;

interface Draft {
	group: PanelGroup;
	attention: boolean;
	working: boolean;
	last: string;
}

export interface VisibleSession {
	session: Session;
	/** The status with this screen's clock (applyStale). */
	status: RowStatus;
	/** A `waiting` session whose HQ visit is over: when the wait began; else null. */
	waited_since: string | null;
}

/**
 * The sessions the board shows, before any cap (the panel's rows and the town's crew both come from
 * this, so the two never disagree): `active`, `waiting`, and `idle` / `stale` within REST_SHOWN_MS of
 * the last activity, with the status re-derived at `now`. A `waiting` one whose HQ visit is over
 * (`waitingSessions`, sessions.ts) — or older than the town's 7 days — carries when its wait began.
 */
export function visibleSessions(
	sessions: readonly Session[],
	waitingSessions: VillageModel["waitingSessions"],
	now: number,
): VisibleSession[] {
	const at = new Date(now);
	// waits whose HQ visit is over (sessions.ts decides; `session:<id>` → since)
	const waited = new Map(
		waitingSessions.map((w) => [w.id.replace(/^session:/, ""), w.since]),
	);
	const out: VisibleSession[] = [];
	for (const s of sessions) {
		const status = applyStale(s.status, s.last_event_at, at);
		const t = Date.parse(s.last_event_at);
		const resting = status === "idle" || status === "stale";
		const shown =
			status === "active" ||
			status === "waiting" ||
			(resting && !Number.isNaN(t) && now - t < REST_SHOWN_MS);
		if (!shown) continue;
		// a wait older than the town's 7 days has no visit and is in no list: an old wait too
		const waitedSince =
			status === "waiting"
				? (waited.get(s.id) ??
					(!Number.isNaN(t) && now - t >= SESSION_RECENT_MS
						? s.last_event_at
						: null))
				: null;
		out.push({
			session: s,
			status: status as RowStatus,
			waited_since: waitedSince,
		});
	}
	return out;
}

export function sessionPanel(input: PanelInput): SessionPanel {
	const { sessions, tails, model, now, ui } = input;
	const counts = { active: 0, waiting: 0, idle: 0 };
	const drafts = new Map<string, Draft>();
	const draft = (project: string): Draft => {
		let d = drafts.get(project);
		if (!d) {
			d = {
				group: {
					project_id: project,
					label: projectLabel(project),
					tag: null,
					phase: null,
					rows: [],
					more: 0,
				},
				attention: false,
				working: false,
				last: "",
			};
			drafts.set(project, d);
		}
		return d;
	};
	const touch = (d: Draft, iso: string) => {
		if (iso > d.last) d.last = iso;
	};

	// visible sessions (the same rule the town's crew uses: visibleSessions)
	const branchOf = new Map<string, { at: string; branch: string }>();
	for (const {
		session: s,
		status,
		waited_since: waitedSince,
	} of visibleSessions(sessions, model.waitingSessions, now)) {
		const resting = status === "idle" || status === "stale";
		if (resting) counts.idle++;
		else if (status === "active") counts.active++;
		else if (!waitedSince) counts.waiting++;
		const project = s.repo_id ?? UNASSIGNED;
		const d = draft(project);
		const tail = tails.get(s.id);
		d.group.rows.push({
			id: s.id,
			provider: PROVIDER_NAME[s.provider] ?? s.provider,
			model: input.shortModel(s.model),
			status,
			waited_since: waitedSince,
			last_event_at: s.last_event_at,
			subagents: status === "active" ? (tail?.subagents ?? 0) : 0,
			tail: resting ? [] : (tail?.lines ?? []).slice(-input.tailMax),
		});
		if (status === "waiting" && !waitedSince) d.attention = true;
		if (status === "active") d.working = true;
		touch(d, s.last_event_at);
		const b = branchOf.get(project);
		if (s.branch && (!b || s.last_event_at > b.at))
			branchOf.set(project, { at: s.last_event_at, branch: s.branch });
	}

	// runs: running (phase), paused, waiting for the owner (strongest last, so it wins the tag)
	for (const n of model.now) {
		if (n.kind !== "run") continue;
		const d = draft(n.project_id);
		d.working = true;
		d.group.tag = { text: `${n.phase_label} 중`, kind: "run" };
		d.group.phase = n.phase_index >= 0 ? n.phase_index : null;
		touch(d, n.reported_at);
	}
	for (const p of model.paused) {
		const d = draft(p.project_id);
		if (!d.group.tag) d.group.tag = { text: PAUSED_TAG, kind: "pause" };
		touch(d, p.since);
	}
	for (const v of model.visits) {
		if (v.kind !== "sign" || v.id.startsWith("session:")) continue;
		const d = draft(v.project_id);
		d.attention = true;
		d.group.tag =
			v.carry === "binder"
				? { text: tagOfCode(v.code) ?? SHORT.stopped, kind: "stop" }
				: { text: tagOfCode(v.code) ?? SHORT.unknown, kind: "wait" };
		touch(d, v.since);
	}
	for (const [project, d] of drafts) {
		const b = branchOf.get(project);
		if (!d.group.tag && b) d.group.tag = { text: b.branch, kind: "branch" };
	}

	const ordered = [...drafts.values()].sort(
		(a, b) =>
			Number(b.attention) - Number(a.attention) ||
			Number(b.working) - Number(a.working) ||
			b.last.localeCompare(a.last) ||
			a.group.label.localeCompare(b.group.label),
	);
	const groups = ordered.slice(0, GROUP_CAP).map((d) => d.group);
	let moreGroups = ordered.length - groups.length;

	for (const g of groups) {
		g.rows.sort(
			(a, b) =>
				rank(a) - rank(b) ||
				b.last_event_at.localeCompare(a.last_event_at) ||
				a.id.localeCompare(b.id),
		);
		g.more += Math.max(0, g.rows.length - ROWS_PER_GROUP);
		g.rows = g.rows.slice(0, ROWS_PER_GROUP);
	}

	// rows beyond ROW_CAP: the least needed first (resting, old waits, active, then 입력 대기; the last
	// groups first)
	const dropRow = (): boolean => {
		let best: { g: PanelGroup; i: number; key: number[] } | null = null;
		for (let gi = 0; gi < groups.length; gi++) {
			const g = groups[gi] as PanelGroup;
			for (let i = 0; i < g.rows.length; i++) {
				const r = g.rows[i] as PanelRow;
				const key = [rank(r), gi, i];
				if (!best || cmp(key, best.key) > 0) best = { g, i, key };
			}
		}
		if (!best) return false;
		best.g.rows.splice(best.i, 1);
		best.g.more++;
		return true;
	};
	while (groups.reduce((n, g) => n + g.rows.length, 0) > ROW_CAP) dropRow();

	// tails beyond TAIL_CAP: old waits first, then the oldest active, then the oldest 입력 대기
	const dropTail = (): boolean => {
		let pick: PanelRow | null = null;
		for (const g of groups)
			for (const r of g.rows) {
				if (r.tail.length === 0) continue;
				if (
					!pick ||
					rank(r) > rank(pick) ||
					(rank(r) === rank(pick) && r.last_event_at < pick.last_event_at)
				)
					pick = r;
			}
		if (!pick) return false;
		pick.tail = [];
		return true;
	};
	const tailCount = () =>
		groups.reduce((n, g) => n + g.rows.filter((r) => r.tail.length).length, 0);
	while (tailCount() > TAIL_CAP) dropTail();

	// fit the height: tails, then rows, then whole groups from the end
	const fits = () =>
		panelHeight({ groups, moreGroups, counts }, ui) <= input.budget;
	while (!fits()) {
		if (dropTail()) continue;
		if (dropRow()) continue;
		if (!groups.pop()) break;
		moreGroups++;
	}
	return { groups, moreGroups, counts };
}

const cmp = (a: number[], b: number[]): number => {
	for (let i = 0; i < a.length; i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d) return d;
	}
	return 0;
};

/** The list's height in px at `ui` (the same numbers as style.css). */
export function panelHeight(p: SessionPanel, ui: number): number {
	let h = 0;
	p.groups.forEach((g, i) => {
		if (i > 0) h += PX.groupGap;
		h += PX.groupHead * ui;
		if (g.phase !== null) h += PX.phase;
		for (const r of g.rows) {
			h += PX.row * ui;
			if (r.tail.length) h += r.tail.length * PX.tailLine * ui + PX.tailBox;
		}
		if (g.more > 0) h += PX.more * ui;
	});
	if (p.moreGroups > 0) h += (p.groups.length ? PX.groupGap : 0) + PX.more * ui;
	return h;
}
