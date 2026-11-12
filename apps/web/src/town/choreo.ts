// The town's choreography (design doc 12 §5): leads walking to the HQ and back, the queue at the HQ
// door, the kangaroo's patrol and its trips to the HQ, and the camera's HQ shot. Pure: every pose is a
// function of the scene clock (wall time minus the stretches spent still) and the visit book
// (campus/visits.ts, anchored to each visitor's `created_at`), so a reload never replays a walk.
//
// Paths run along the ring (ring-layout's offset curves), the shorter way round:
//  - a lead: its lot door → the outer pavement lane → its spot at the HQ (sign: the queue, first at the
//    door, the rest along the pavement anticlockwise; report: beside the door, clockwise) — and back;
//    a folded building's lead (`~repo`) walks in from the lane point opposite the HQ;
//  - the kangaroo: a small state machine anchored to the moments it changes (stepKangaroo): patrol on
//    the centre line (phase = scene time + a shift); once a waiting 결재 lead has arrived it walks
//    (4.2 u/s) from where it is, the near way, to the road in front of the HQ door and stands there;
//    HQ_HOLD_MS after the last 결재 lead arrived (or when no 결재 is left, if sooner) it walks from where
//    it is back onto the centre line and the patrol carries on from that point (the shift) — the leads
//    stay at the door while their 결재 lasts; a new 결재 lead arriving brings it back for HQ_HOLD_MS.
//    Every transition starts from where it actually is: no jumps;
//  - the camera: follows the kangaroo (orbit rig); it blends toward the fixed HQ shot (door, queue,
//    pylon) while the kangaroo stands at the HQ, and back when it leaves — from wherever the blend is.
import {
	type Visit,
	type VisitBook,
	walkDurationMs,
} from "../campus/visits.ts";
import { type OrbitRig, TELEPORT_U } from "./engine/orbit-camera.mjs";
import {
	arcTable,
	doorOf,
	ellipseNormal,
	LOTS,
	offsetPoint,
} from "./engine/ring-layout.mjs";
import { LAP_S, PATROL_SPEED, patrolPose, patrolTimeAt } from "./patrol.ts";

export const HQ_LOT = "sportsgang";
/** The outer pavement lane the leads walk (between the curb lamps at 2.9 and the door benches at 3.85). */
export const LANE = 3.2;
/** First in the queue stands on the HQ door mat. */
export const DOOR_SPOT = 3.9;
/** Arc distance between two people in the queue. */
export const QUEUE_GAP = 1.2;
/** Reports stand clockwise of the door, this far along the lane. */
export const REPORT_FROM = 1.6;
/** The kangaroo stands on the road in front of the HQ door. */
export const ROO_HQ_OFFSET = 1.6;
/** The kangaroo's walking speed to and from the HQ (the original guide's walk, 4.2 u/s). */
export const ROO_SPEED = 4.2;
/** The camera's blend to and from the HQ shot. */
export const CAM_BLEND_MS = 1_500;
/**
 * How long the kangaroo (and the camera) stays at the HQ after a 결재 lead arrives. A 결재 can wait for
 * hours; after this the patrol resumes and the lead keeps standing at the door (owner review R1).
 */
export const HQ_HOLD_MS = 5 * 60_000;

const TAU = Math.PI * 2;
const HQ = (() => {
	const l = LOTS.find((x) => x.id === HQ_LOT);
	if (!l) throw new Error("no HQ lot");
	return l;
})();
const LANE_TAB = arcTable(LANE);
const CENTRE = arcTable(0);

export interface XZ {
	x: number;
	z: number;
}

/**
 * The HQ shot (§5 "the camera stops facing the HQ front") while a 결재 lead is there: from the inner
 * pavement just clockwise of the HQ, 6.5 up, looking down ~26° at the queue, so the door, the queue
 * (spread across the view, not along it) and the kangaroo fill the frame — a lead at the door is ~60 of
 * the 288 rows, readable from a desk away (owner review R1: the old wide shot made them a few pixels
 * tall to fit the whole pylon). Found by a search over camera positions (figure size 42–60 rows, pitch
 * 18–35°, door + sign, the first four queue spots and the kangaroo in frame, no pavement tree or lamp
 * between the camera and any of them, for every render-target width the stage uses, 320–384 × 288:
 * pipeline.ts fitStage); choreo.test.ts re-checks it at 384, 373 and 320.
 */
export const HQ_SHOT = Object.freeze({
	position: Object.freeze({ x: -17.76, y: 6.5, z: -8.68 }),
	lookAt: Object.freeze({ x: -26.25, y: 2, z: -11.95 }),
});

/**
 * The reduced-motion view (§5 "a fixed view where the plaza and the pylon show"): the S3 shot from the
 * plaza's north-east, low, looking across the plaza at the HQ, the door and queue right of centre and
 * the whole pylon on the left. Nothing moves there, so it keeps the pylon's numbers in view.
 */
export const PLAZA_SHOT = Object.freeze({
	position: Object.freeze({ x: 12.36, y: 11, z: -13.62 }),
	lookAt: Object.freeze({ x: -7.69, y: 2.5, z: -4.19 }),
});

// ── paths ──────────────────────────────────────────────────────────────────────

export interface Path {
	pts: readonly XZ[];
	/** Cumulative length at each point. */
	cum: readonly number[];
	length: number;
}

function path(pts: XZ[]): Path {
	const cum = [0];
	for (let i = 1; i < pts.length; i += 1) {
		const a = pts[i - 1] as XZ;
		const b = pts[i] as XZ;
		cum.push((cum[i - 1] ?? 0) + Math.hypot(b.x - a.x, b.z - a.z));
	}
	return { pts, cum, length: cum[cum.length - 1] ?? 0 };
}

/** Signed arc length from θa to θb along a table, the shorter way (+ = clockwise). */
export function shorterArc(
	tab: { length: number; lenAt(t: number): number },
	a: number,
	b: number,
): number {
	let d = (tab.lenAt(b) - tab.lenAt(a)) % tab.length;
	if (d < 0) d += tab.length;
	return d <= tab.length / 2 ? d : d - tab.length;
}

/** Points along an offset curve from θa, `arc` units (signed), every ≤ 1 unit. */
function arcPoints(
	tab: ReturnType<typeof arcTable>,
	offset: number,
	from: number,
	arc: number,
): XZ[] {
	const s0 = tab.lenAt(from);
	const n = Math.max(1, Math.ceil(Math.abs(arc)));
	const out: XZ[] = [];
	for (let i = 0; i <= n; i += 1)
		out.push(offsetPoint(tab.at(s0 + (arc * i) / n), offset));
	return out;
}

/** Point and unit direction at distance s along a path (clamped). */
export function along(
	p: Path,
	s: number,
): { x: number; z: number; dir: [number, number] } {
	const d = Math.max(0, Math.min(p.length, s));
	let i = 1;
	while (i < p.pts.length - 1 && (p.cum[i] ?? 0) < d) i += 1;
	const a = p.pts[i - 1] ?? p.pts[0] ?? { x: 0, z: 0 };
	const b = p.pts[i] ?? a;
	const seg = (p.cum[i] ?? 0) - (p.cum[i - 1] ?? 0);
	const f = seg > 1e-9 ? (d - (p.cum[i - 1] ?? 0)) / seg : 0;
	const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
	return {
		x: a.x + (b.x - a.x) * f,
		z: a.z + (b.z - a.z) * f,
		dir: [(b.x - a.x) / l, (b.z - a.z) / l],
	};
}

const thetaOfLot = (id: string) => LOTS.find((l) => l.id === id)?.theta;

/** Where a lead stands at the HQ: sign k = the queue, report k = beside the door. */
export function hqSpot(
	kind: "sign" | "report",
	k: number,
): XZ & { theta: number } {
	const s0 = LANE_TAB.lenAt(HQ.theta);
	if (kind === "sign" && k <= 0) {
		const p = offsetPoint(HQ.theta, DOOR_SPOT);
		return { ...p, theta: HQ.theta };
	}
	const s =
		kind === "sign" ? s0 - k * QUEUE_GAP : s0 + REPORT_FROM + k * QUEUE_GAP;
	const theta = LANE_TAB.at(s);
	return { ...offsetPoint(theta, LANE), theta };
}

/**
 * A lead's walk: from its lot's door (or, for a folded building / no lot, the lane point opposite the
 * HQ) out to the lane, the shorter way round to its spot, and in to it.
 */
export function leadPath(
	lotId: string | null,
	kind: "sign" | "report",
	k: number,
): Path {
	const spot = hqSpot(kind, k);
	const pts: XZ[] = [];
	let from: number;
	const th = lotId ? thetaOfLot(lotId) : undefined;
	if (th !== undefined && lotId) {
		const d = doorOf(lotId);
		pts.push({ x: d.x, z: d.z });
		from = th;
	} else {
		from = (HQ.theta + Math.PI) % TAU;
	}
	pts.push(
		...arcPoints(LANE_TAB, LANE, from, shorterArc(LANE_TAB, from, spot.theta)),
	);
	pts.push({ x: spot.x, z: spot.z });
	return path(pts);
}

// ── leads ──────────────────────────────────────────────────────────────────────

/** Walk length (ms) for a route: the campus rule (4.2 u/s, 7–20 s). */
export const leadWalkMs = (p: Path): number => walkDurationMs(p.length);

export interface LeadPose {
	visit_id: string;
	repo_id: string;
	carry: Visit["carry"];
	x: number;
	z: number;
	/** World direction it faces. */
	dir: [number, number];
	moving: boolean;
	/** Distance walked on its route (drives the stride). */
	walked: number;
}

/** progress 0 = at its building, 1 = at its spot; returning walks the same path backwards. */
export function leadPose(
	v: Pick<Visit, "visit_id" | "repo_id" | "carry" | "left_at">,
	p: Path,
	progress: number,
	settled: boolean,
): LeadPose {
	const s = progress * p.length;
	const at = along(p, s);
	const back = v.left_at !== null;
	const arrived = progress >= 1 && !back;
	// standing at the HQ: face the door (outward); walking: along the path (backwards when returning)
	const n = ellipseNormal(HQ.theta);
	const dir: [number, number] = arrived
		? [n.x, n.z]
		: back
			? [-at.dir[0], -at.dir[1]]
			: at.dir;
	return {
		visit_id: v.visit_id,
		repo_id: v.repo_id,
		carry: v.carry,
		x: at.x,
		z: at.z,
		dir,
		moving: !settled && progress > 0 && progress < 1,
		walked: s,
	};
}

// ── the queue ──────────────────────────────────────────────────────────────────

/** A leaving lead holds its spot until it has walked this far back (progress below this). */
export const HOLD_UNTIL = 0.85;
/** Leads stepping up in the queue walk there at this speed (u/s). */
export const SHUFFLE_SPEED = 1.6;

/**
 * Spots for the waiting leads of one kind, in the model's order (the board's cards): each takes the
 * lowest spot not held by a lead still standing on it while it leaves, nor taken by one ahead of it.
 */
export function assignSpots(
	order: readonly string[],
	held: ReadonlySet<number>,
): Map<string, number> {
	const out = new Map<string, number>();
	const used = new Set(held);
	let k = 0;
	for (const id of order) {
		while (used.has(k)) k += 1;
		out.set(id, k);
		used.add(k);
	}
	return out;
}

/** A lead's place: the spot its walk was routed to, the spot it should stand on, and a step between. */
export interface LeadPlace {
	routeK: number;
	spotK: number;
	shuffle: { from: XZ; toK: number; t0: number } | null;
}

/**
 * An arrived lead moving up the queue (or anywhere between two spots): from `from` straight to the
 * spot at SHUFFLE_SPEED. Returns the point, the direction, and whether it is there.
 */
export function shufflePos(
	kind: "sign" | "report",
	sh: NonNullable<LeadPlace["shuffle"]>,
	now: number,
): {
	x: number;
	z: number;
	dir: [number, number];
	done: boolean;
	walked: number;
} {
	const to = hqSpot(kind, sh.toK);
	const d = dist2(sh.from, to);
	const s = Math.max(0, ((now - sh.t0) / 1000) * SHUFFLE_SPEED);
	if (d < 1e-9 || s >= d) {
		const n = ellipseNormal(HQ.theta);
		return { x: to.x, z: to.z, dir: [n.x, n.z], done: true, walked: d };
	}
	const f = s / d;
	return {
		x: sh.from.x + (to.x - sh.from.x) * f,
		z: sh.from.z + (to.z - sh.from.z) * f,
		dir: [(to.x - sh.from.x) / d, (to.z - sh.from.z) / d],
		done: false,
		walked: s,
	};
}
const dist2 = (a: XZ, b: XZ) => Math.hypot(a.x - b.x, a.z - b.z);

// ── the kangaroo ───────────────────────────────────────────────────────────────

/** Patrol on the centre line at scene time `sceneMs` (+ the state's phase shift). */
export function patrolAt(sceneMs: number): {
	x: number;
	z: number;
	dir: [number, number];
	walked: number;
} {
	const t = (((sceneMs / 1000) % LAP_S) + LAP_S) % LAP_S;
	const p = patrolPose(t);
	return { ...p, walked: (sceneMs / 1000) * PATROL_SPEED };
}

export const HQ_STAND = offsetPoint(HQ.theta, ROO_HQ_OFFSET);
const ROO_FACE: [number, number] = (() => {
	const n = ellipseNormal(HQ.theta);
	return [n.x, n.z];
})();

/** The centre-line θ nearest (x, z) (1/4° steps, then a local refinement). */
export function thetaNear(x: number, z: number): number {
	let best = 0;
	let bd = Number.POSITIVE_INFINITY;
	const test = (t: number) => {
		const p = offsetPoint(t, 0);
		const d = (p.x - x) ** 2 + (p.z - z) ** 2;
		if (d < bd) {
			bd = d;
			best = t;
		}
	};
	for (let i = 0; i < 1440; i += 1) test((i / 1440) * TAU);
	const c = best;
	for (let i = -20; i <= 20; i += 1) test(c + (i / 20) * (TAU / 1440));
	return ((best % TAU) + TAU) % TAU;
}

/** From (x, z): onto the centre line, the near way to the HQ, then onto the HQ stand. */
export function rooToHq(from: XZ): Path {
	const th = thetaNear(from.x, from.z);
	const arc = shorterArc(CENTRE, th, HQ.theta);
	return path([
		{ x: from.x, z: from.z },
		...arcPoints(CENTRE, 0, th, arc),
		HQ_STAND,
	]);
}

/** From (x, z) straight onto the nearest centre-line point (where the patrol picks up again). */
export function rooToLine(from: XZ): { path: Path; theta: number } {
	const theta = thetaNear(from.x, from.z);
	return {
		path: path([{ x: from.x, z: from.z }, offsetPoint(theta, 0)]),
		theta,
	};
}

export type RooState =
	| { mode: "patrol"; shiftMs: number; cam: number }
	| { mode: "to-hq"; path: Path; t0: number; shiftMs: number; cam: number }
	| { mode: "at-hq"; since: number; shiftMs: number; cam: number }
	| {
			mode: "back";
			path: Path;
			t0: number;
			/** Patrol shift that continues the patrol from the end of the path on arrival. */
			rejoinShiftMs: number;
			cam: number;
	  };

export interface RooPose {
	x: number;
	z: number;
	dir: [number, number];
	moving: boolean;
	walked: number;
	/** 0 = following (orbit), 1 = the HQ shot. */
	cam: number;
	phase: RooState["mode"];
}

export interface KangarooInput {
	/** Scene clock (ms). */
	now: number;
	book: VisitBook;
	/** Walk length (ms) of a visit's route. */
	walkMsOf(v: Visit): number;
	/**
	 * How much older the visit was when first seen than its head start says (the head start is clamped
	 * to 60 s): a 결재 that began two hours ago arrived two hours ago, not a minute before the page opened.
	 * Absent → 0.
	 */
	lateMsOf?(v: Visit): number;
	reducedMotion: boolean;
}

/** Scene time a visit's lead reaches its spot. */
export const arrivesAt = (v: Visit, walkMs: number): number =>
	v.seen_at + walkMs - v.head_start_ms;

/** Scene time the kangaroo's stay at the HQ for this visit is over: its real arrival + HQ_HOLD_MS. */
export const holdEndsAt = (v: Visit, walkMs: number, lateMs: number): number =>
	arrivesAt(v, walkMs) - Math.max(0, lateMs) + HQ_HOLD_MS;

const holdEnd = (v: Visit, input: KangarooInput): number =>
	holdEndsAt(v, input.walkMsOf(v), input.lateMsOf?.(v) ?? 0);

const walkMs = (p: Path) => (p.length / ROO_SPEED) * 1000;

/** Where the state puts the kangaroo at `now`. */
export function rooPose(st: RooState, now: number): RooPose {
	switch (st.mode) {
		case "patrol":
			return {
				...patrolAt(now + st.shiftMs),
				moving: true,
				cam: st.cam,
				phase: "patrol",
			};
		case "at-hq":
			return {
				x: HQ_STAND.x,
				z: HQ_STAND.z,
				dir: ROO_FACE,
				moving: false,
				walked: 0,
				cam: st.cam,
				phase: "at-hq",
			};
		default: {
			const s = Math.min(st.path.length, ((now - st.t0) / 1000) * ROO_SPEED);
			const at = along(st.path, s);
			return {
				x: at.x,
				z: at.z,
				dir: at.dir,
				moving: s < st.path.length,
				walked: s,
				cam: st.cam,
				phase: st.mode,
			};
		}
	}
}

/** The kangaroo when the scene starts: already at the HQ if a 결재 lead is already there (no replay). */
export function initialRoo(input: KangarooInput): RooState {
	if (input.reducedMotion)
		return { mode: "at-hq", since: input.now, shiftMs: 0, cam: 1 };
	const patrol: RooState = { mode: "patrol", shiftMs: 0, cam: 0 };
	return wantsHq(input) ? leavePatrol(patrol, input) : patrol;
}

/** A waiting 결재 lead reached the HQ less than HQ_HOLD_MS ago: the kangaroo should come. */
function wantsHq(input: KangarooInput): boolean {
	const { book, now, walkMsOf } = input;
	return book.visits.some(
		(v) =>
			v.carry !== null &&
			v.left_at === null &&
			now >= arrivesAt(v, walkMsOf(v)) &&
			now < holdEnd(v, input),
	);
}
/**
 * Some 결재 still holds the kangaroo (on its way, or arrived less than HQ_HOLD_MS ago): it stays at /
 * keeps going to the HQ.
 */
function signsOn(input: KangarooInput): boolean {
	return input.book.visits.some(
		(v) =>
			v.carry !== null && v.left_at === null && input.now < holdEnd(v, input),
	);
}

/**
 * One step of the kangaroo's state machine at `input.now` (scene time), `dtMs` after the previous step
 * (0 while still: nothing moves). Pure: (state, input) → state.
 */
export function stepKangaroo(
	st: RooState,
	input: KangarooInput,
	dtMs: number,
): RooState {
	const { now } = input;
	if (input.reducedMotion)
		return { mode: "at-hq", since: now, shiftMs: 0, cam: 1 };
	const here = rooPose(st, now);
	let next: RooState = st;
	switch (st.mode) {
		case "patrol":
			if (wantsHq(input)) next = leavePatrol(st, input);
			break;
		case "to-hq":
			if (!signsOn(input)) next = back(here, now, st.cam);
			else if (now - st.t0 >= walkMs(st.path))
				next = {
					mode: "at-hq",
					since: st.t0 + walkMs(st.path),
					shiftMs: st.shiftMs,
					cam: st.cam,
				};
			break;
		case "at-hq":
			if (!signsOn(input)) next = back(here, now, st.cam);
			break;
		case "back":
			if (wantsHq(input))
				next = {
					mode: "to-hq",
					path: rooToHq(here),
					t0: now,
					shiftMs: st.rejoinShiftMs,
					cam: st.cam,
				};
			else if (now - st.t0 >= walkMs(st.path))
				next = { mode: "patrol", shiftMs: st.rejoinShiftMs, cam: st.cam };
			break;
	}
	// the camera blends toward the HQ shot while the kangaroo stands there, away otherwise
	const target = next.mode === "at-hq" ? 1 : 0;
	const step = Math.max(0, dtMs) / CAM_BLEND_MS;
	const cam =
		target > next.cam
			? Math.min(target, next.cam + step)
			: Math.max(target, next.cam - step);
	return cam === next.cam ? next : { ...next, cam };
}

/**
 * Off the patrol to the HQ, anchored to when the first waiting 결재 lead arrived (tA): the walk starts
 * from the patrol point at tA. Stepped every frame that is now (no jump); but when the visit only shows
 * up already arrived — the page just opened, or its data came with a later model — the walk is where it
 * would be by now, and if it would be over the kangaroo simply stands at the HQ in the HQ shot (a reload
 * never replays the walk).
 */
function leavePatrol(
	st: Extract<RooState, { mode: "patrol" }>,
	input: KangarooInput,
): RooState {
	const { now, book, walkMsOf } = input;
	const arrived = book.visits
		.filter(
			(v) => v.carry !== null && v.left_at === null && now < holdEnd(v, input),
		)
		.map((v) => arrivesAt(v, walkMsOf(v)))
		.filter((t) => t <= now);
	const tA = Math.min(now, ...arrived);
	const p = rooToHq(patrolAt(tA + st.shiftMs));
	const end = tA + walkMs(p);
	if (now >= end) {
		const cam = Math.min(1, Math.max(st.cam, (now - end) / CAM_BLEND_MS));
		return { mode: "at-hq", since: end, shiftMs: st.shiftMs, cam };
	}
	return { mode: "to-hq", path: p, t0: tA, shiftMs: st.shiftMs, cam: st.cam };
}

/** Walk from `here` onto the centre line; the patrol continues from that point when it gets there. */
function back(here: XZ, now: number, cam: number): RooState {
	const { path: p, theta } = rooToLine(here);
	const arrive = now + walkMs(p);
	return {
		mode: "back",
		path: p,
		t0: now,
		rejoinShiftMs: patrolTimeAt(theta) * 1000 - arrive,
		cam,
	};
}

/** The camera blend eased for display (the state keeps it linear). */
export const easeCam = (c: number): number => {
	const t = Math.max(0, Math.min(1, c));
	return t * t * (3 - 2 * t);
};

/** A frame gap longer than this (hidden tab, still, reduced motion) snaps the orbit rig to the kangaroo. */
export const SNAP_GAP_MS = 500;

/**
 * The orbit rig follows the kangaroo (scene-switch.mjs renderRing). After a pause or a jump it snaps —
 * focus and yaw at once — instead of turning round at 90°/s for seconds.
 */
export function followRig(
	rig: OrbitRig,
	at: XZ,
	gapMs: number,
	dtSec: number,
): "snap" | "follow" {
	const [fx, fz] = rig.focus;
	if (gapMs > SNAP_GAP_MS || Math.hypot(at.x - fx, at.z - fz) > TELEPORT_U) {
		rig.snapTo(at.x, at.z);
		return "snap";
	}
	rig.setYaw(rig.yawFor(at));
	rig.update(dtSec, at.x, at.z);
	return "follow";
}
