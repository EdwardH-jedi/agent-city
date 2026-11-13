// The finish show (17 §3). Pure: it only reads what the board already decided.
//
// - A burst: when visits.ts makes a new "전부 끝났습니다." report (a run seen to finish while the screen is
//   open; a run already finished when the screen opened is only remembered there, so it never bursts),
//   that building throws confetti for BURST_MS. Never while reports are cut. A task that passes (`T2 통과`)
//   is not a finish.
// - Flags: every building whose `전부 끝남` LOG line is from today (the same rule as incidents.ts, without
//   the six-line limit) keeps a flag until local midnight. Recomputed from the runs, so a reload keeps
//   them. A building only has a flag while it stands (the village shows at most eight).
// - The chime: once per tick when a new burst begins and the board may sound (sound.ts isAudible: on, not
//   quiet, the Mac reporting, the screen connected), never on a tick the sound planner keeps silent (the
//   first look, the settle window after a load or a reconnect). What was missed is not played later.
import type { MachineView, RunView } from "@agent-city/schema";
import { PASSED_TEXT, SHORT } from "./copy.ts";
import { buildIncidents } from "./incidents.ts";
import { isAudible, type SoundPrefs } from "./sound.ts";
import { localMidnight } from "./today.ts";
import { currentRuns } from "./types.ts";
import { REPORT_LEAVE_MS, REPORT_STAY_MS, type Visit } from "./visits.ts";

/** How long the confetti flies (17 §3 [제안] 20 s). */
export const BURST_MS = 20_000;

export interface Burst {
	project_id: string;
	/** When the finish was seen (the visit's `since`): the confetti's clock starts here. */
	at: string;
}

/** The projects whose `전부 끝남` line is from today (local), from the runs useHub holds. */
export function finishedToday(runs: readonly RunView[], now: number): string[] {
	const t = localMidnight(now);
	const out = new Set<string>();
	for (const i of buildIncidents(
		currentRuns(runs),
		new Map(),
		Number.MAX_SAFE_INTEGER,
	)) {
		const at = Date.parse(i.at);
		if (
			i.source === "state" &&
			i.text === SHORT.passed &&
			Number.isFinite(at) &&
			at >= t &&
			at <= now + 60_000
		)
			out.add(i.project_id);
	}
	return [...out].sort();
}

const isFinish = (v: Visit): boolean =>
	v.kind === "report" && v.text === PASSED_TEXT && !v.closing;

/** The bursts seen so far that may still fly: kept for BURST_MS from their start. */
export type BurstMemory = readonly Burst[];

/**
 * Remember each new finish for BURST_MS from its start, even when a newer report of the same project
 * takes its place at the door (buildVisits keeps one per project): a burst, once begun, flies to the end.
 */
export function stepBursts(
	prev: BurstMemory,
	visits: readonly Visit[],
	now: number,
): BurstMemory {
	const live = (b: Burst) => {
		const age = now - Date.parse(b.at);
		return age >= 0 && age < BURST_MS;
	};
	const out = prev.filter(live);
	for (const v of visits) {
		if (!isFinish(v)) continue;
		const b = { project_id: v.project_id, at: v.since };
		if (
			live(b) &&
			!out.some((x) => x.project_id === b.project_id && x.at === b.at)
		)
			out.push(b);
	}
	return out;
}

/** The bursts flying at `now`: new finishes younger than BURST_MS. None while reports are cut. */
export function burstsAt(
	visits: readonly Visit[],
	now: number,
	still: boolean,
): Burst[] {
	return still ? [] : [...stepBursts([], visits, now)];
}

/**
 * The finishes the chime has already answered (or let pass), `id|since` → until when to remember it (the
 * report's stay and its leaving): a finish hidden at the door for a while and shown again is not new.
 */
export type ChimeMemory = Readonly<Record<string, number>>;

/** How long a finish is remembered: the report's 5 minutes at the door and its 5 s leaving, and a margin. */
const REMEMBER_MS = REPORT_STAY_MS + REPORT_LEAVE_MS + 60_000;

/**
 * Whether to chime now. `settled`: the sound planner is past its settle window this tick (sound.ts
 * SoundMemory.settleUntil). The first look and every silent tick only re-base the memory.
 */
export function planChime(
	prev: ChimeMemory | null,
	visits: readonly Visit[],
	ctx: {
		prefs: SoundPrefs;
		date: Date;
		cockpit: MachineView["status"];
		conn: "open" | "reconnecting";
		settled: boolean;
	},
): { memory: ChimeMemory; chime: boolean } {
	const now = ctx.date.getTime();
	const memory: Record<string, number> = {};
	for (const [k, until] of Object.entries(prev ?? {}))
		if (until > now) memory[k] = until;
	const fresh: string[] = [];
	for (const v of visits.filter(isFinish)) {
		const k = `${v.id}|${v.since}`;
		if (!(k in memory)) fresh.push(k);
		memory[k] = Math.max(memory[k] ?? 0, Date.parse(v.since) + REMEMBER_MS);
	}
	if (!prev || !ctx.settled || !isAudible(ctx)) return { memory, chime: false };
	return { memory, chime: fresh.length > 0 };
}
