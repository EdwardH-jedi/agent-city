// The ring's lots from the scene model (design doc 12 §4). Pure: no GL, no DOM.
//  - HQ is the original lobby lot (`sportsgang`, sign "HQ"); the cafe stays the cafe.
//  - The other eight lots are project slots, filled clockwise from HQ in `model.repos` order (the 2D
//    grid's order). A project keeps its slot while it stays shown; a new one takes the first free slot.
//  - A project's facade (family, walls, awning, height, seed) is fixed by a hash of its repo id, from the
//    combinations the original lots use. Empty slots are boarded COMING SOON, like the original reserved lots.
//  - Lamps: stopped red > waiting (결재·입력 대기) yellow > working green > off; HQ green while the owner is
//    there; everything the original offline look when reports stopped.
//  - Lit windows = active_tasks (0–4); a project's facade lights nothing else, at any time of day.
//  - The pylon: title AGENT CITY, one row per project, ALL = totals; OFFLINE with "—" when reports stopped.
import type { CampusModel, CampusRepo } from "../campus/presentation.ts";
import {
	type BoardCounts,
	type BoardView,
	boardText,
	LABEL_MAX_W,
} from "./engine/leaderboard.mjs";
import { LOTS, type RingLot } from "./engine/ring-layout.mjs";
import {
	type LampInput,
	type LampState,
	signTextWidth,
} from "./engine/scene-ring.mjs";

export const HQ_LOT = "sportsgang";
export const CAFE_LOT = "no-wukkas-cafe";
export const BOARD_TITLE = "AGENT CITY";
/** Lit windows a facade shows at most (the board caps active_tasks at 4 too). */
export const MAX_LIT = 4;
/** A sign's text is at most this many texels wide at scale 2 (10 world units of the 14-unit frontage). */
export const SIGN_MAX_TX = 160;

const lotOf = (id: string): RingLot => {
	const l = LOTS.find((x) => x.id === id);
	if (!l) throw new Error(`no ring lot ${id}`);
	return l;
};

/** The eight project slots, clockwise (θ grows clockwise) starting after HQ. */
export const PROJECT_SLOTS: readonly string[] = (() => {
	const hq = lotOf(HQ_LOT).deg;
	const after = (d: number) => (((d - hq) % 360) + 360) % 360;
	return LOTS.filter((l) => l.id !== HQ_LOT && l.id !== CAFE_LOT)
		.slice()
		.sort((a, b) => after(a.deg) - after(b.deg))
		.map((l) => l.id);
})();

/** repo_id → slot (lot id). */
export type LotAssignment = ReadonlyMap<string, string>;

/**
 * Sticky slots: every repo that had a slot and is still shown keeps it; new repos (in the given order)
 * take the first free slot; a repo that is gone frees its slot. At most PROJECT_SLOTS.length repos.
 */
export function assignLots(
	prev: LotAssignment,
	repoIds: readonly string[],
): LotAssignment {
	const want = [...new Set(repoIds)];
	const next = new Map<string, string>();
	const used = new Set<string>();
	for (const id of want) {
		const s = prev.get(id);
		if (s && PROJECT_SLOTS.includes(s) && !used.has(s)) {
			next.set(id, s);
			used.add(s);
		}
	}
	for (const id of want) {
		if (next.has(id)) continue;
		const free = PROJECT_SLOTS.find((s) => !used.has(s));
		if (!free) break;
		next.set(id, free);
		used.add(free);
	}
	return next;
}

/** FNV-1a, 32 bit. */
export function hash32(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i += 1) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** The original lots' facade family / wall pairs (minus the HQ's steel and the reserved lots' plaster). */
export const FACADE_PAIRS = [
	{ family: "glass", wall: "glass" },
	{ family: "stone", wall: "slate" },
	{ family: "brick", wall: "brick" },
	{ family: "stone", wall: "sand" },
	{ family: "shopfront", wall: "rose" },
	{ family: "brick", wall: "rust" },
	{ family: "shopfront", wall: "ochre" },
] as const;
export const AWNINGS = ["teal", "rust", "mustard"] as const;
export const HEIGHTS = [12, 13.5, 15] as const;

export interface Facade {
	family: string;
	wall: string;
	awning: string;
	h: number;
	seed: number;
}

/** Fixed per repo id: the same project always gets the same building. */
export function facadeOf(repoId: string): Facade {
	const h = hash32(repoId);
	const pair = FACADE_PAIRS[h % FACADE_PAIRS.length] ?? FACADE_PAIRS[0];
	return {
		family: pair.family,
		wall: pair.wall,
		awning: AWNINGS[(h >>> 8) % AWNINGS.length] ?? "teal",
		h: HEIGHTS[(h >>> 16) % HEIGHTS.length] ?? 12,
		seed: 100 + ((h >>> 4) % 900),
	};
}

const signGlyph = new Map<string, boolean>();
function hasSignGlyph(ch: string): boolean {
	let ok = signGlyph.get(ch);
	if (ok === undefined) {
		try {
			signTextWidth(ch, 2);
			ok = true;
		} catch {
			ok = false;
		}
		signGlyph.set(ch, ok);
	}
	return ok;
}

/** The sign: upper case, `_ . /` as spaces, characters the sign font lacks dropped, cut to fit. */
export function signText(label: string): string {
	let out = [...label.toUpperCase().replace(/[_./\s]+/g, " ")]
		.filter((ch) => hasSignGlyph(ch))
		.join("")
		.replace(/ +/g, " ")
		.trim();
	while (out && signTextWidth(out, 2) > SIGN_MAX_TX)
		out = out.slice(0, -1).trimEnd();
	return out || "-";
}

/** The pylon's 6-character row label (leaderboard font: A–Z, digits, `-`). */
export const boardLabel = (label: string): string =>
	boardText(label, 6, LABEL_MAX_W);
/** Three characters for the minimap. */
export const mapLabel = (label: string): string => boardText(label, 3, 30);

export interface TownLot extends RingLot {
	/** The project's repo id (project slots only). */
	readonly repo_id?: string;
}

const clampLit = (n: number) =>
	Math.max(0, Math.min(MAX_LIT, Math.floor(Number.isFinite(n) ? n : 0)));

/** The ten lots for scene-ring's `opts.lots` (same ids and positions as the original LOTS). */
export function buildLots(
	assign: LotAssignment,
	repos: readonly CampusRepo[],
): TownLot[] {
	const byId = new Map(repos.map((r) => [r.repo_id, r]));
	const inSlot = new Map<string, CampusRepo>();
	for (const [repo, slot] of assign) {
		const r = byId.get(repo);
		if (r) inSlot.set(slot, r);
	}
	return LOTS.map((L): TownLot => {
		if (L.id === HQ_LOT) return { ...L, name: "HQ", label: "HQ", sign: "HQ" };
		if (L.id === CAFE_LOT) return L;
		const r = inSlot.get(L.id);
		if (!r) {
			const odd = PROJECT_SLOTS.indexOf(L.id) % 2 === 1;
			return {
				...L,
				name: "",
				label: "",
				dept: null,
				kind: "reserved",
				family: "shopfront",
				wall: "plaster",
				awning: odd ? "teal" : "mustard",
				h: odd ? 13.5 : 12,
				sign: "COMING SOON",
				boarded: true,
				lit: 0,
				litWindows: 0,
			};
		}
		return {
			...L,
			...facadeOf(r.repo_id),
			name: r.label,
			label: boardLabel(r.label),
			dept: null,
			kind: "project",
			sign: signText(r.label),
			boarded: false,
			lit: 0,
			litWindows: clampLit(r.active_tasks),
			repo_id: r.repo_id,
		};
	});
}

/** What the built world depends on (a change rebuilds it); lit windows are repainted in place instead. */
export function lotsKey(lots: readonly TownLot[]): string {
	return JSON.stringify(
		lots.map((l) => [
			l.id,
			l.sign,
			l.family,
			l.wall,
			l.awning,
			l.h,
			l.seed,
			!!l.boarded,
			l.lit ?? null,
		]),
	);
}

/** stopped red > waiting yellow > working green > off. */
export function lampOf(repo: CampusRepo): LampState {
	if (repo.has_stopped) return "stopped";
	if (repo.pending_requests > 0) return "waiting";
	if (repo.active_tasks > 0) return "working";
	return "off";
}

/** Door lamps of all ten lots. */
export function lampInput(
	model: CampusModel,
	assign: LotAssignment,
): LampInput {
	const byId = new Map(model.repos.map((r) => [r.repo_id, r]));
	const slotLamp = new Map<string, LampState>();
	for (const [repo, slot] of assign) {
		const r = byId.get(repo);
		if (r) slotLamp.set(slot, lampOf(r));
	}
	return {
		offline: model.still,
		rows: LOTS.map((L) => ({
			lot: L.id,
			lamp:
				L.id === HQ_LOT
					? model.owner_present
						? "working"
						: "off"
					: (slotLamp.get(L.id) ?? "off"),
		})),
	};
}

const NONE: BoardCounts = {
	working: null,
	waiting: null,
	idle: null,
	unknown: null,
};

/** The pylon: one row per project lot (slot order, placed on the face toward its lot), ALL = totals. */
export function boardViewOf(
	model: CampusModel,
	assign: LotAssignment,
): BoardView {
	const offline = model.still;
	const slotOf = new Map(assign);
	const rows = model.repos
		.filter((r) => slotOf.has(r.repo_id))
		.map((r) => {
			const slot = slotOf.get(r.repo_id) ?? "";
			return {
				slot,
				row: {
					lot: slot,
					label: boardLabel(r.label),
					deg: lotOf(slot).deg,
					lastEvidenceS: null,
					...(offline
						? NONE
						: {
								working: r.active_tasks,
								waiting: r.pending_requests,
								idle: 0,
								unknown: 0,
							}),
				},
			};
		})
		.sort(
			(a, b) => PROJECT_SLOTS.indexOf(a.slot) - PROJECT_SLOTS.indexOf(b.slot),
		)
		.map((x) => x.row);
	const shown = model.repos.filter((r) => slotOf.has(r.repo_id));
	const sum = (f: (r: CampusRepo) => number) =>
		shown.reduce((n, r) => n + f(r), 0);
	const totals: BoardCounts = offline
		? { ...NONE }
		: {
				working: sum((r) => r.active_tasks),
				waiting: sum((r) => r.pending_requests),
				idle: 0,
				unknown: 0,
			};
	return { title: BOARD_TITLE, rows, offline, totals, source: "city" };
}
