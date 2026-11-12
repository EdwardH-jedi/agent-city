// The ring's lots from the scene model (design doc 12 §4). Pure: no GL, no DOM.
//  - HQ is the original lobby lot (`sportsgang`, sign "HQ"); the cafe stays the cafe.
//  - The other eight lots are project slots, filled clockwise from HQ in `model.repos` order (the 2D
//    grid's order). A project keeps its slot while it stays shown; a new one takes the first free slot.
//  - A project's facade (family, walls, awning, height, seed) is fixed by a hash of its repo id, from the
//    combinations the original lots use. Empty slots are boarded COMING SOON, like the original reserved lots.
//  - Lamps: stopped red > waiting (결재·입력 대기) yellow > working green > off; HQ green while the owner is
//    there; everything the original offline look when reports stopped.
//  - Lit windows = active_tasks (0–4); a project's facade lights nothing else, at any time of day.
//  - The pylon: title AGENT CITY, one row per project (진행, 대기), ALL = totals; OFFLINE with "—" when
//    reports stopped.
//  - Signs (lit boards, 3×), pylon rows and minimap labels are short and distinct among the projects shown
//    (distinctLabels): two `station0…` repos never read the same.
import type { CampusModel, CampusRepo } from "../campus/presentation.ts";
import {
	type BoardView,
	boardText,
	hasGlyph,
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
/**
 * The frontage a sign board must stay inside (world units): 8 of the 14-unit frontage, so the board keeps
 * ≥ 3 units clear on each side, inside the curb lamps and their glows seen from the road.
 */
export const SIGN_BOARD_MAX_UNITS = 14 - 2 * 3;

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

// ── short, distinct names (signs, pylon rows, minimap) ──────────────────────────
// A name is cut into words (anything the font cannot draw, and `-`, separates them: `station0-ui_x` →
// STATION0 UI X). Each place has a fit (characters and texels). A name tries, in order: all its words; the
// most whole words that fit (4 characters or more); all its words cut to fit; its first word cut to fit;
// its first word shortened + one later word (`STATI-NAV`, `SNA`). Names that would read the same move on to their next try — except that one of them
// with the fewest words keeps it (the `station0` among `station0-ui`, `station0-nav`…). Still alike after
// every try (identical names): the end becomes a digit.

/** Words of a name in a font: upper case, split at `-` and every character the font lacks. */
export function nameWords(
	name: string,
	has: (ch: string) => boolean,
): string[] {
	return [...name.toUpperCase()]
		.map((ch) => (ch !== "-" && has(ch) ? ch : " "))
		.join("")
		.split(" ")
		.filter(Boolean);
}

export interface LabelFont {
	has(ch: string): boolean;
	fits(s: string): boolean;
	/** Between words: `-`, or nothing where every character counts (the minimap's 3). */
	sep: string;
}

function cutToFit(s: string, f: LabelFont): string {
	let out = s;
	while (out && !f.fits(out)) out = out.slice(0, -1);
	while (f.sep && out.endsWith(f.sep)) out = out.slice(0, -f.sep.length);
	return out;
}

/** The tries for one name, best first; each fits and none is empty (an unwritable name → `-`). */
export function labelTries(name: string, f: LabelFont): string[] {
	const w = nameWords(name, f.has);
	if (w.length === 0) return f.fits("-") ? ["-"] : [];
	const out: string[] = [];
	const add = (s: string) => {
		if (s && f.fits(s) && !out.includes(s)) out.push(s);
	};
	add(w.join(f.sep));
	// fewer whole words, but not a stub like `NO` for `no-wukkas-cafe`
	for (let j = w.length - 1; j >= 1; j -= 1) {
		const s = w.slice(0, j).join(f.sep);
		if (s.length >= 4) add(s);
	}
	add(cutToFit(w.join(f.sep), f));
	const first = w[0] ?? "";
	add(cutToFit(first, f));
	for (let i = 1; i < w.length; i += 1) {
		const tail = f.sep + (w[i] ?? "");
		let k = first.length;
		while (k > 1 && !f.fits(first.slice(0, k) + tail)) k -= 1;
		add(cutToFit(first.slice(0, k) + tail, f));
	}
	return out;
}

/**
 * One short label per name, all different from each other and from `reserved` (the HQ, the cafe), each
 * fitting the font. Deterministic for the same names in the same order.
 */
export function distinctLabels(
	names: readonly string[],
	f: LabelFont,
	reserved: readonly string[] = [],
): string[] {
	const tries = names.map((n) => labelTries(n, f));
	const words = names.map((n) => nameWords(n, f.has).length);
	const out: (string | null)[] = names.map(() => null);
	const used = new Set(reserved);
	const depth = Math.max(0, ...tries.map((t) => t.length));
	for (let level = 0; level < depth; level += 1) {
		const want = new Map<string, number[]>();
		tries.forEach((t, i) => {
			const s = t[level];
			if (out[i] !== null || s === undefined || used.has(s)) return;
			want.set(s, [...(want.get(s) ?? []), i]);
		});
		for (const [s, who] of want) {
			let pick: number | undefined;
			if (who.length === 1) pick = who[0];
			else {
				const fewest = Math.min(...who.map((i) => words[i] ?? 0));
				const roots = who.filter((i) => (words[i] ?? 0) === fewest);
				if (roots.length === 1) pick = roots[0];
			}
			if (pick === undefined) continue;
			out[pick] = s;
			used.add(s);
		}
	}
	return out.map((s, i) => {
		if (s !== null) return s;
		const base = tries[i]?.[0] ?? "";
		for (let d = 1; d <= 99; d += 1) {
			const digit = String(d);
			let stem = base;
			while (stem && !f.fits(stem + digit)) stem = stem.slice(0, -1);
			const c = stem + digit;
			if (f.fits(c) && !used.has(c)) {
				used.add(c);
				return c;
			}
		}
		return base || "-";
	});
}

/**
 * Project signs are lit boards with 3× glyphs: the original 2× (0.625 units high) breaks into noise on the
 * 384 × 288 target once a sign is ~35 units away — every sign across the plaza. A board holds about 8
 * characters; the full name is in the side columns.
 */
export const SIGN_SCALE = 3;
/** Text width (texels) a 3× board may take: ceil((tw + 18) / 8) / 2 ≤ SIGN_BOARD_MAX_UNITS. */
export const SIGN_TEXT_MAX_TX = 110;
export const SIGN_FONT: LabelFont = {
	has: hasSignGlyph,
	fits: (s) => signTextWidth(s, SIGN_SCALE) <= SIGN_TEXT_MAX_TX,
	sep: "-",
};
/** The pylon's row label: 6 characters of the leaderboard font, 25 texels. */
export const BOARD_FONT: LabelFont = {
	has: hasGlyph,
	fits: (s) => s.length <= 6 && boardText(s, 6, LABEL_MAX_W) === s,
	sep: "-",
};
/** The minimap's lot label: 3 characters. */
export const MAP_FONT: LabelFont = {
	has: hasGlyph,
	fits: (s) => s.length <= 3 && boardText(s, 3, 30) === s,
	sep: "",
};
export const CAFE_MAP_LABEL = "CAF";

/** Each shown project's sign, pylon label and map label, distinct among the projects in the lots. */
export interface LotLabels {
	sign: string;
	board: string;
	map: string;
}
export function lotLabels(
	assign: LotAssignment,
	repos: readonly CampusRepo[],
): Map<string, LotLabels> {
	const shown = repos
		.filter((r) => assign.has(r.repo_id))
		.sort(
			(a, b) =>
				PROJECT_SLOTS.indexOf(assign.get(a.repo_id) ?? "") -
				PROJECT_SLOTS.indexOf(assign.get(b.repo_id) ?? ""),
		);
	const names = shown.map((r) => r.label);
	const sign = distinctLabels(names, SIGN_FONT, ["HQ", "NO WUKKAS"]);
	const board = distinctLabels(names, BOARD_FONT, ["ALL"]);
	const map = distinctLabels(names, MAP_FONT, ["HQ", CAFE_MAP_LABEL]);
	return new Map(
		shown.map((r, i) => [
			r.repo_id,
			{ sign: sign[i] ?? "-", board: board[i] ?? "-", map: map[i] ?? "-" },
		]),
	);
}

export interface TownLot extends RingLot {
	/** The project's repo id (project slots only). */
	readonly repo_id?: string;
	/** The minimap's label (project slots only). */
	readonly mapLabel?: string;
	/** scene-ring: draw the sign on the lit board at this glyph scale (project slots). */
	readonly signLit?: boolean;
	readonly signScale?: number;
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
	const names = lotLabels(assign, repos);
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
		const n = names.get(r.repo_id);
		return {
			...L,
			...facadeOf(r.repo_id),
			name: r.label,
			label: n?.board ?? "-",
			mapLabel: n?.map ?? "-",
			dept: null,
			kind: "project",
			sign: n?.sign ?? "-",
			signLit: true,
			signScale: SIGN_SCALE,
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
			l.signScale ?? 2,
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

/**
 * The pylon: one row per project lot (slot order, placed on the face toward its lot), ALL = totals. A row
 * carries only what the city knows — 진행 (working) and 대기 (waiting); idle, unknown and the evidence age
 * are left out, so the board draws no made-up "00" for them (leaderboard.mjs, agent-city).
 */
export function boardViewOf(
	model: CampusModel,
	assign: LotAssignment,
): BoardView {
	const offline = model.still;
	const slotOf = new Map(assign);
	const names = lotLabels(assign, model.repos);
	const rows = model.repos
		.filter((r) => slotOf.has(r.repo_id))
		.map((r) => {
			const slot = slotOf.get(r.repo_id) ?? "";
			return {
				slot,
				row: {
					lot: slot,
					label: names.get(r.repo_id)?.board ?? "-",
					deg: lotOf(slot).deg,
					working: offline ? null : r.active_tasks,
					waiting: offline ? null : r.pending_requests,
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
	const totals = offline
		? { working: null, waiting: null }
		: {
				working: sum((r) => r.active_tasks),
				waiting: sum((r) => r.pending_requests),
			};
	return { title: BOARD_TITLE, rows, offline, totals, source: "city" };
}
