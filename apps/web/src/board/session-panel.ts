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
// - rows: `active`, `waiting`, and `idle` within IDLE_SHOWN_MS of its last activity (`stale` and `ended`
//   are hidden); in a group 입력 대기 → 진행 → 쉬는 중, newest first; at most ROWS_PER_GROUP, then `외 N`.
//   The status is re-derived with this screen's clock (applyStale, as the town does): an `idle` or
//   `active` session silent for 15 min is `stale` (the hub stores the same), so in practice an idle row
//   shows for its first 15 minutes; a `waiting` one never goes stale.
// - tails: under `active` and `waiting` rows only, at most TAIL_CAP boxes of `tailMax` lines
// - caps: ROW_CAP rows in all; then it must fit `budget` px with no scroll — folding first the oldest
//   active session's tail, then the waiting ones' tails, then rows (idle before active, the last groups
//   first; a waiting row is the last to go), then whole groups from the end
import { applyStale, type Session } from "@agent-city/schema";
import { PAUSED_TAG, PROVIDER_NAME, SHORT, tagOfCode } from "./copy.ts";
import type { VillageModel } from "./model.ts";
import type { TailLine } from "./tail.ts";
import { projectLabel, UNASSIGNED } from "./types.ts";

export const GROUP_CAP = 8;
export const ROWS_PER_GROUP = 4;
export const ROW_CAP = 16;
export const TAIL_CAP = 6;
export const IDLE_SHOWN_MS = 24 * 3_600_000;

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

export type RowStatus = "active" | "waiting" | "idle";

export interface PanelRow {
	id: string;
	provider: string;
	/** `opus 5.5` (tail.ts shortModel), or null when the hub has no model. */
	model: string | null;
	status: RowStatus;
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
	/** Every visible session, before any cap (`진행 1 · 대기 1 · 쉼 2`). */
	counts: { active: number; waiting: number; idle: number };
}

export interface PanelInput {
	sessions: readonly Session[];
	tails: ReadonlyMap<string, { lines: TailLine[]; subagents: number }>;
	model: Pick<VillageModel, "visits" | "now" | "paused">;
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

const RANK: Record<RowStatus, number> = { waiting: 0, active: 1, idle: 2 };

interface Draft {
	group: PanelGroup;
	attention: boolean;
	working: boolean;
	last: string;
}

export function sessionPanel(input: PanelInput): SessionPanel {
	const { sessions, tails, model, now, ui } = input;
	const at = new Date(now);
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

	// visible sessions
	const branchOf = new Map<string, { at: string; branch: string }>();
	for (const s of sessions) {
		const status = applyStale(s.status, s.last_event_at, at);
		const t = Date.parse(s.last_event_at);
		const shown =
			status === "active" ||
			status === "waiting" ||
			(status === "idle" && !Number.isNaN(t) && now - t < IDLE_SHOWN_MS);
		if (!shown) continue;
		counts[status]++;
		const project = s.repo_id ?? UNASSIGNED;
		const d = draft(project);
		const tail = tails.get(s.id);
		d.group.rows.push({
			id: s.id,
			provider: PROVIDER_NAME[s.provider] ?? s.provider,
			model: input.shortModel(s.model),
			status,
			last_event_at: s.last_event_at,
			subagents: status === "active" ? (tail?.subagents ?? 0) : 0,
			tail: status === "idle" ? [] : (tail?.lines ?? []).slice(-input.tailMax),
		});
		if (status === "waiting") d.attention = true;
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
				RANK[a.status] - RANK[b.status] ||
				b.last_event_at.localeCompare(a.last_event_at) ||
				a.id.localeCompare(b.id),
		);
		g.more += Math.max(0, g.rows.length - ROWS_PER_GROUP);
		g.rows = g.rows.slice(0, ROWS_PER_GROUP);
	}

	// rows beyond ROW_CAP: the least needed first (idle, then active, then waiting; the last groups first)
	const dropRow = (): boolean => {
		let best: { g: PanelGroup; i: number; key: number[] } | null = null;
		for (let gi = 0; gi < groups.length; gi++) {
			const g = groups[gi] as PanelGroup;
			for (let i = 0; i < g.rows.length; i++) {
				const r = g.rows[i] as PanelRow;
				const key = [RANK[r.status], gi, i];
				if (!best || cmp(key, best.key) > 0) best = { g, i, key };
			}
		}
		if (!best) return false;
		best.g.rows.splice(best.i, 1);
		best.g.more++;
		return true;
	};
	while (groups.reduce((n, g) => n + g.rows.length, 0) > ROW_CAP) dropRow();

	// tails beyond TAIL_CAP: the oldest active first, then the oldest waiting
	const dropTail = (): boolean => {
		let pick: PanelRow | null = null;
		for (const g of groups)
			for (const r of g.rows) {
				if (r.tail.length === 0) continue;
				if (
					!pick ||
					RANK[r.status] > RANK[pick.status] ||
					(RANK[r.status] === RANK[pick.status] &&
						r.last_event_at < pick.last_event_at)
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
