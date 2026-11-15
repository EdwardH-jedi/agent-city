// Screen navigation only. The caller supplies existing sign/still/owner facts and patrol position.
import type { CampusRepo } from "../../campus/presentation.ts";
import type { RooState } from "../choreo.ts";
import type { Point } from "./themes/types.ts";

export const AUTO_STAY_MS = 25_000;
export const MANUAL_STAY_MS = 60_000;
export const COOLDOWN_MS = 600_000;
export const FADE_MS = 300;
export interface InteriorCommand {
	serial: number;
	index: number;
}
export interface Stop extends Point {
	repo_id: string;
	door: Point;
}
export interface TourVisit {
	repo_id: string;
	mode: "auto" | "manual";
	phase: "door" | "entering" | "inside" | "leaving" | "returning";
	at: number;
	insideAt: number;
	front: Point;
	door: Point;
	walkMs: number;
}
export interface TourState {
	visit: TourVisit | null;
	lap: number;
	count: number;
	seen: ReadonlyMap<string, number>;
	command: number;
}
export const newTour = (): TourState => ({
	visit: null,
	lap: -1,
	count: 0,
	seen: new Map(),
	command: 0,
});
export interface TourInput {
	now: number;
	lap: number;
	owner: boolean;
	still: boolean;
	reduced: boolean;
	sign: boolean;
	off: boolean;
	pinned: boolean;
	repos: readonly CampusRepo[];
	front: Stop | null;
	here: Point;
	command?: InteriorCommand;
	ready: boolean;
}
const patrol = (s: TourState): TourState => ({ ...s, visit: null });
export function tourBlocked(
	i: Pick<TourInput, "owner" | "still" | "reduced" | "sign">,
) {
	return !i.owner || i.still || i.reduced || i.sign;
}
function start(
	s: TourState,
	i: TourInput,
	repo_id: string,
	mode: TourVisit["mode"],
): TourState {
	const front = { ...i.here },
		door = mode === "auto" && i.front ? i.front.door : front;
	const seen = new Map(s.seen);
	if (mode === "auto") seen.set(repo_id, i.now);
	return {
		...s,
		seen,
		count: s.count + (mode === "auto" ? 1 : 0),
		visit: {
			repo_id,
			mode,
			phase: mode === "auto" ? "door" : "entering",
			at: i.now,
			insideAt: 0,
			front,
			door,
			walkMs: Math.max(
				400,
				(Math.hypot(door.x - front.x, door.z - front.z) / 4.2) * 1000,
			),
		},
	};
}
export function autoEligible(repo: CampusRepo) {
	const name = repo.label.toLowerCase();
	return (
		repo.active_tasks > 0 &&
		name !== "hq" &&
		name !== "no-wukkas-cafe" &&
		!name.startsWith("no-wukkas-cafe-")
	);
}
export function stepTour(prev: TourState, i: TourInput): TourState {
	const ids = new Set(i.repos.map((r) => r.repo_id));
	let s = prev;
	if (i.lap !== s.lap) s = { ...s, lap: i.lap, count: 0 };
	if ([...s.seen.keys()].some((id) => !ids.has(id)))
		s = { ...s, seen: new Map([...s.seen].filter(([id]) => ids.has(id))) };
	const command =
		i.command && i.command.serial !== s.command ? i.command : null;
	if (command) s = { ...s, command: command.serial };
	if (tourBlocked(i) || i.pinned || (s.visit && !ids.has(s.visit.repo_id)))
		return patrol(s);
	if (command) {
		if (command.index < 0) return patrol(s);
		const repo = i.repos[command.index];
		if (repo) return start(s, i, repo.repo_id, "manual");
	}
	const v = s.visit;
	if (v) {
		const age = i.now - v.at;
		if (v.phase === "door" && age >= v.walkMs)
			return { ...s, visit: { ...v, phase: "entering", at: i.now } };
		if (v.phase === "entering") {
			// A failed/missing chunk never traps the kiosk behind black.
			if (age > 10_000) return patrol(s);
			if (age >= FADE_MS / 2 && i.ready)
				return {
					...s,
					visit: { ...v, phase: "inside", at: i.now, insideAt: i.now },
				};
		}
		if (
			v.phase === "inside" &&
			age >= (v.mode === "auto" ? AUTO_STAY_MS : MANUAL_STAY_MS)
		)
			return { ...s, visit: { ...v, phase: "leaving", at: i.now } };
		if (v.phase === "leaving" && age >= FADE_MS)
			return v.mode === "manual"
				? patrol(s)
				: { ...s, visit: { ...v, phase: "returning", at: i.now } };
		if (v.phase === "returning" && age >= v.walkMs) return patrol(s);
		return s;
	}
	if (command || i.off || s.count >= 2 || !i.front) return s;
	const repo = i.repos.find((r) => r.repo_id === i.front?.repo_id);
	if (
		!repo ||
		!autoEligible(repo) ||
		i.now - (s.seen.get(repo.repo_id) ?? -Infinity) < COOLDOWN_MS
	)
		return s;
	return start(s, i, repo.repo_id, "auto");
}
export function tourRoom(v: TourVisit | null, now: number): string | null {
	return v &&
		(v.phase === "entering" ||
			v.phase === "inside" ||
			(v.phase === "leaving" && now - v.at < FADE_MS / 2))
		? v.repo_id
		: null;
}
export function tourShade(v: TourVisit | null, now: number): number {
	if (!v) return 0;
	const t = Math.max(0, now - v.at) / (FADE_MS / 2);
	if (v.phase === "entering") return Math.min(1, t);
	if (v.phase === "inside") return Math.max(0, 1 - t);
	if (v.phase === "leaving") return t <= 1 ? t : Math.max(0, 2 - t);
	return 0;
}
export function tourPosition(v: TourVisit, now: number) {
	const t = Math.max(0, Math.min(1, (now - v.at) / v.walkMs));
	const p = v.phase === "door" ? t : v.phase === "returning" ? 1 - t : 1;
	const dx = v.door.x - v.front.x,
		dz = v.door.z - v.front.z,
		sign = v.phase === "returning" ? -1 : 1;
	return {
		x: v.front.x + dx * p,
		z: v.front.z + dz * p,
		dir: [dx * sign, dz * sign] as [number, number],
		moving: (v.phase === "door" || v.phase === "returning") && t < 1,
		walked: Math.hypot(dx, dz) * t,
	};
}
/** Shift every clock anchor equally: a paused roo resumes the identical pose in any existing mode. */
export function holdRoo(s: RooState, elapsed: number): RooState {
	if (s.mode === "back")
		return {
			...s,
			t0: s.t0 + elapsed,
			rejoinShiftMs: s.rejoinShiftMs - elapsed,
		};
	const shifted = { ...s, shiftMs: s.shiftMs - elapsed };
	if (shifted.mode === "to-hq") return { ...shifted, t0: shifted.t0 + elapsed };
	if (shifted.mode === "at-hq")
		return { ...shifted, since: shifted.since + elapsed };
	return shifted;
}
