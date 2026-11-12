// The screen's memory of each session's last tail lines (REVIEW 2026-11-13 #3). The events useHub holds are
// one window of the newest 200 of all sessions, so a busy session pushes a quiet one's events out of it;
// what the tail last showed is kept here instead. Pure, no React (Sessions.tsx holds it in a ref). No
// request: it reads the same window as before.
//
// - every step rebuilds each session's lines from the window as before (tail.ts tailLine: sorted by time,
//   so an event that arrives late still lands in place, and with the session's folder as it is now), then
//   puts in front of them the remembered lines older than the window's first line for that session; a run
//   of the same line cut by the window's edge is joined (`×N` keeps counting)
// - per session at most TAIL_MAX finished lines (redacted, no absolute path) and their times; never an
//   event or a summary
// - the same window on every render gives the same memory (the step returns `prev` itself while under
//   the cap; at the cap an equal copy)
// - ended sessions (status `ended`, or their newest event in the window is SessionEnd) are dropped on
//   every step; past MEMORY_SESSIONS the entry with the oldest line goes. The memory stays bounded however
//   long the board runs (a night with hundreds of sessions keeps at most 64 × 3 lines).
// - subagent counts are not remembered: they come from the window as before (tail.ts runningSubagents)
// Known limits: a line that left the window keeps the text it had then (its folder, its order); an event
// that arrives late right at the window's first line can drop or under-count the remembered run before it.
import type { Event, Session } from "@agent-city/schema";
import {
	runningSubagents,
	TAIL_MAX,
	type TailEvent,
	type TailLine,
	tailLine,
} from "./tail.ts";

/** Sessions remembered at most. */
export const MEMORY_SESSIONS = 64;

export type MemEvent = TailEvent & Pick<Event, "id">;

/** A remembered line: a run of the same text, from its first event's time to its last's. */
export interface MemLine extends TailLine {
	first: string;
	last: string;
}

export type TailMemory = ReadonlyMap<string, readonly MemLine[]>;

/** Sessions over: `ended` on the hub, or whose newest event in the window is SessionEnd. */
export function endedSessions(
	sessions: readonly Pick<Session, "id" | "status">[],
	events: readonly MemEvent[],
): Set<string> {
	const out = new Set<string>();
	for (const s of sessions) if (s.status === "ended") out.add(s.id);
	const newest = new Map<string, MemEvent>();
	for (const e of events) {
		if (!e.session_id) continue;
		const n = newest.get(e.session_id);
		if (!n || e.ts > n.ts) newest.set(e.session_id, e);
	}
	for (const [id, e] of newest) if (e.type === "SessionEnd") out.add(id);
	return out;
}

/** One session's lines from the window, oldest first, each run with the times of all its events. */
function windowRuns(
	list: { e: MemEvent; i: number }[],
	cwd: string | null,
): { text: string; ts: string[] }[] {
	// oldest first; equal times keep the hub's order reversed (it lists newest first)
	list.sort((a, b) => (a.e.ts < b.e.ts ? -1 : a.e.ts > b.e.ts ? 1 : b.i - a.i));
	const runs: { text: string; ts: string[] }[] = [];
	for (const { e } of list) {
		const text = tailLine(e, cwd);
		if (text === null) continue;
		const last = runs[runs.length - 1];
		if (last && last.text === text) last.ts.push(e.ts);
		else runs.push({ text, ts: [e.ts] });
	}
	return runs;
}

const sameLines = (a: readonly MemLine[], b: readonly MemLine[]) =>
	a.length === b.length &&
	a.every(
		(x, i) =>
			x.text === b[i]?.text &&
			x.count === b[i]?.count &&
			x.first === b[i]?.first &&
			x.last === b[i]?.last,
	);

/**
 * One step: each session's lines = its remembered lines older than the window's first line, then the
 * window's lines; the last `max` kept. Returns `prev` itself when nothing changed.
 */
export function stepTailMemory(
	prev: TailMemory,
	events: readonly MemEvent[],
	ended: ReadonlySet<string>,
	cwdOf: (sessionId: string) => string | null,
	max: number = TAIL_MAX,
): TailMemory {
	const bySession = new Map<string, { e: MemEvent; i: number }[]>();
	events.forEach((e, i) => {
		const id = e.session_id;
		if (!id || ended.has(id)) return;
		const list = bySession.get(id);
		if (list) list.push({ e, i });
		else bySession.set(id, [{ e, i }]);
	});
	// copied on the first change only, so an unchanged step returns `prev` itself
	const box: { next: Map<string, readonly MemLine[]> | null } = { next: null };
	const write = (id: string, lines: readonly MemLine[] | null) => {
		box.next ??= new Map(prev);
		if (lines) box.next.set(id, lines);
		else box.next.delete(id);
	};
	for (const [id, list] of bySession) {
		const runs = windowRuns(list, cwdOf(id));
		const head = runs[0];
		if (!head) continue;
		const firstTs = head.ts[0] as string;
		const lines: MemLine[] = [];
		for (const l of prev.get(id) ?? []) {
			if (l.last < firstTs) lines.push({ ...l });
			else if (l.first < firstTs && l.text === head.text) {
				// the same run, cut by the window's edge: what was counted plus what came after it
				const more = head.ts.filter((t) => t > l.last).length;
				lines.push({
					...l,
					count: l.count + more,
					last: head.ts.at(-1) as string,
				});
				runs.shift();
				break;
			}
		}
		for (const r of runs) {
			const tail = lines[lines.length - 1];
			if (tail && tail.text === r.text) {
				tail.count += r.ts.length;
				tail.last = r.ts.at(-1) as string;
			} else
				lines.push({
					text: r.text,
					count: r.ts.length,
					first: r.ts[0] as string,
					last: r.ts.at(-1) as string,
				});
		}
		const kept = lines.slice(-max);
		const before = prev.get(id);
		if (!before || !sameLines(before, kept)) write(id, kept);
	}
	for (const id of prev.keys()) if (ended.has(id)) write(id, null);
	const out: TailMemory = box.next ?? prev;
	if (out.size <= MEMORY_SESSIONS) return out;
	const newest = (lines: readonly MemLine[]) => lines.at(-1)?.last ?? "";
	const byAge = [...out.entries()].sort(
		([a, x], [b, y]) =>
			newest(x).localeCompare(newest(y)) || a.localeCompare(b),
	);
	for (const [id] of byAge.slice(0, out.size - MEMORY_SESSIONS))
		write(id, null);
	return box.next ?? prev;
}

/** The remembered lines with each session's running subagents counted in the window (tail.ts). */
export function tailsWithSubagents(
	memory: TailMemory,
	events: readonly TailEvent[],
): Map<string, { lines: TailLine[]; subagents: number }> {
	const bySession = new Map<string, TailEvent[]>();
	for (const e of events) {
		if (!e.session_id) continue;
		const list = bySession.get(e.session_id);
		if (list) list.push(e);
		else bySession.set(e.session_id, [e]);
	}
	const out = new Map<string, { lines: TailLine[]; subagents: number }>();
	for (const [id, lines] of memory)
		out.set(id, {
			lines: lines.map(({ text, count }) => ({ text, count })),
			subagents: 0,
		});
	for (const [id, list] of bySession) {
		const subagents = runningSubagents(list);
		const have = out.get(id);
		if (have) have.subagents = subagents;
		else if (subagents > 0) out.set(id, { lines: [], subagents });
	}
	return out;
}
