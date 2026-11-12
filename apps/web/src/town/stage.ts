// The town stage: owns the canvas, the pipeline, the one animation-frame chain and the page/GPU
// lifecycle (the original scene-switch.mjs renderRing, without the keyboard world). Every resource,
// listener, observer and frame request goes through a DisposalRegistry. The scene listens to no input:
// only visibility, WebGL context loss/restore and the stage's size.
//
// Frame (renderRing order): poses from the scene clock and the visit book (choreo.ts) → orbit rig yaw
// toward the tangent at the kangaroo → rig.update → the HQ shot blend → screen facings from the view's
// yaw → actors → render. Reports stopped: the scene clock stands, everything holds where it is and the
// loop stops; reduced motion: the end state (kangaroo at the HQ, the HQ shot, leads at their spots),
// drawn on change only.
//
// Data (design doc 12 §4, lots.ts): each new model re-assigns the project lots (sticky slots), rebuilds
// the world only when a lot's sign or facade changes, and otherwise updates in place: door lamps, the
// pylon, lit windows. The kangaroo is drawn only while the owner is there; the camera keeps its slow
// patrol either way (burn-in) unless reports stopped, when everything holds still.

import type { CampusModel } from "../campus/presentation.ts";
import { DisposalRegistry } from "../campus/resources.ts";
import {
	EMPTY_BOOK,
	MAX_HEAD_START_MS,
	reconcileVisits,
	type SceneClock,
	START_CLOCK,
	sceneNow,
	setStill,
	settleVisits,
	type Visit,
	type VisitBook,
	visitProgress,
} from "../campus/visits.ts";
import {
	assignSpots,
	easeCam,
	followRig,
	HOLD_UNTIL,
	HQ_SHOT,
	initialRoo,
	type KangarooInput,
	type LeadPlace,
	leadPath,
	leadPose,
	leadWalkMs,
	type Path,
	PLAZA_SHOT,
	type RooState,
	rooPose,
	shufflePos,
	stepKangaroo,
} from "./choreo.ts";
import { turnBetween, yawOfDir } from "./engine/orbit-camera.mjs";
import { LAMP_COLORS, type LampState } from "./engine/scene-ring.mjs";
import type { Actor } from "./engine/sprites.mjs";
import type { RooAction, RooDirection } from "./engine/town-roo-art-m2.mjs";
import { TownRooArtM2 } from "./engine/town-roo-art-m2.mjs";
import { type LeadSprite, leadKey } from "./lead-sprites.ts";
import { townLive } from "./live.ts";
import {
	assignLots,
	boardViewOf,
	buildLots,
	CAFE_MAP_LABEL,
	HQ_LOT,
	type LotAssignment,
	lampInput,
	type TownLot,
} from "./lots.ts";
import type { TimeOfDay } from "./params.ts";
import {
	facingFrom,
	frameIndexFor,
	rooKey,
	rooPhase,
	worldToView,
} from "./patrol.ts";
import { createTownPipeline, type TownPipeline } from "./pipeline.ts";
import type { CameraShot } from "./world.ts";

const DEG = Math.PI / 180;
const lampCss = (s: LampState): string | null => {
	if (s === "off") return null;
	const c = LAMP_COLORS[s];
	return `rgb(${c[0]},${c[1]},${c[2]})`;
};
/** The orbit rig never advances more than this per frame (its turn and pitch ramps). */
const MAX_DT_S = 0.1;
/** A fixed shot's yaw (degrees, camera-rig convention), for the sprites' screen facings. */
const yawOfShot = (s: Omit<CameraShot, "blend">): number =>
	yawOfDir(s.lookAt.x - s.position.x, s.lookAt.z - s.position.z);
/** The 결재 HQ shot; reduced motion stands in the plaza shot (the pylon in view). */
const SHOTS = {
	hq: { shot: HQ_SHOT, yaw: yawOfShot(HQ_SHOT) },
	plaza: { shot: PLAZA_SHOT, yaw: yawOfShot(PLAZA_SHOT) },
} as const;
/** Walk frames: a new phase every 0.45 units walked (ring-world.mjs townsfolk). */
const LEAD_STRIDE = 0.45;

export interface TownInput {
	model: CampusModel;
	reducedMotion: boolean;
	time: TimeOfDay;
}

export interface TownCallbacks {
	onContextLost(): void;
	onReady(): void;
}

export interface TownStage {
	update(input: TownInput): void;
	readonly disposed: boolean;
	dispose(): void;
}

/** Seams for tests: the pipeline factory (WebGL) and the registry. */
export interface StageDeps {
	createPipeline?: typeof createTownPipeline;
	registry?: DisposalRegistry;
}

/**
 * Any step of the start that throws releases everything made so far (renderer, listeners, observer,
 * canvas) and hands back the global colour switch before rethrowing — the 2D grid then takes over.
 */
export function createTownStage(
	host: HTMLElement,
	initial: TownInput,
	cb: TownCallbacks,
	deps: StageDeps = {},
): TownStage {
	const reg = deps.registry ?? new DisposalRegistry();
	try {
		return buildStage(
			reg,
			host,
			initial,
			cb,
			deps.createPipeline ?? createTownPipeline,
		);
	} catch (e) {
		reg.disposeAll();
		throw e;
	}
}

function buildStage(
	reg: DisposalRegistry,
	host: HTMLElement,
	initial: TownInput,
	cb: TownCallbacks,
	makePipeline: typeof createTownPipeline,
): TownStage {
	const canvas = document.createElement("canvas");
	canvas.className = "town-canvas";
	canvas.setAttribute("aria-hidden", "true");
	host.appendChild(canvas);
	reg.defer(() => canvas.remove(), "canvas");

	let assign: LotAssignment = assignLots(
		new Map(),
		initial.model.repos.map((r) => r.repo_id),
	);
	let lots: TownLot[] = buildLots(assign, initial.model.repos);
	const pipe: TownPipeline = makePipeline({
		canvas,
		width: host.clientWidth || 1,
		height: host.clientHeight || 1,
		spec: { time: initial.time, lots },
	});
	reg.track(pipe, "town pipeline");
	reg.defer(() => townLive.set(null), "live mirror");

	// ── state ───────────────────────────────────────────────────────────────────
	let input = initial;
	let facing: RooDirection = "north";
	const leadFacing = new Map<string, RooDirection>();
	let last = 0;
	// the visits (campus/visits.ts: anchored to created_at, walk back when they end) and the scene clock
	let clock: SceneClock = setStill(
		START_CLOCK,
		initial.model.still,
		Date.now(),
	);
	let book: VisitBook = EMPTY_BOOK;
	/** Each lead's place at the HQ (choreo.ts LeadPlace); kept while it walks home. */
	const places = new Map<string, LeadPlace>();
	const routes = new Map<string, Path>();
	const kindOf = (v: Pick<Visit, "carry">) => (v.carry ? "sign" : "report");
	const routeOf = (
		v: Pick<Visit, "visit_id" | "repo_id" | "carry">,
		k = places.get(v.visit_id)?.routeK ?? 0,
	): Path => {
		const kind = kindOf(v);
		const key = `${v.repo_id}|${kind}|${k}`;
		let r = routes.get(key);
		if (!r) {
			r = leadPath(assign.get(v.repo_id) ?? null, kind, k);
			routes.set(key, r);
		}
		return r;
	};
	/** Walk length of a visit: its route to the first spot of its kind (the campus clamp, 7–20 s). */
	const walkMsOf = (v: Pick<Visit, "repo_id" | "seat">): number =>
		leadWalkMs(
			routeOf({
				visit_id: "",
				repo_id: v.repo_id,
				// the book always passes whole visits
				carry: (v as Partial<Visit>).carry ?? null,
			}),
		);
	/** Per visit: how much older it was than its head start when (re)seen (see applyModel). */
	const late = new Map<
		string,
		{ seen: number; ms: number; carry: Visit["carry"]; signedAt: number }
	>();
	const lateMsOf = (v: Visit): number => late.get(v.visit_id)?.ms ?? 0;
	const signedAtOf = (v: Visit): number =>
		late.get(v.visit_id)?.signedAt ?? Number.NEGATIVE_INFINITY;
	/** The kangaroo's state machine (choreo.ts), stepped every frame on the scene clock. */
	let roo: RooState | null = null;
	let lastScene = 0;
	let lastFrameTs = 0;
	let raf = 0;
	let contextLost = false;
	let lostReported = false;
	let readySent = false;
	let disposed = false;
	reg.defer(() => {
		disposed = true;
	}, "stage state");

	const moving = () => !input.reducedMotion && !input.model.still;
	const nowScene = () => sceneNow(clock, Date.now());
	const canRun = () => !disposed && !contextLost && !document.hidden;
	const schedule = () => {
		if (!raf && canRun()) raf = requestAnimationFrame(frame);
	};
	reg.defer(() => {
		if (raf) cancelAnimationFrame(raf);
		raf = 0;
	}, "animation frame");

	function frame(ts: number) {
		raf = 0;
		if (!canRun()) return;
		const walk = moving();
		const gap = lastFrameTs ? ts - lastFrameTs : Number.POSITIVE_INFINITY;
		lastFrameTs = ts;
		const dt =
			walk && last ? Math.min(MAX_DT_S, Math.max(0, (ts - last) / 1000)) : 0;
		last = walk ? ts : 0;
		const reduced = input.reducedMotion;
		const now = nowScene();
		book = settleVisits(book, now, walkMsOf, reduced);
		const kin: KangarooInput = {
			now,
			book,
			walkMsOf,
			lateMsOf,
			signedAtOf,
			reducedMotion: reduced,
		};
		roo = roo ? stepKangaroo(roo, kin, now - lastScene) : initialRoo(kin);
		lastScene = now;
		const pose = rooPose(roo, now);
		const cam = easeCam(pose.cam);
		const fixed = reduced ? SHOTS.plaza : SHOTS.hq;
		const rig = pipe.world.rig;
		followRig(rig, pose, gap, dt);
		// the view's yaw, blended like the camera, for the sprites' screen facings
		const viewYaw =
			(rig.yawDeg + turnBetween(rig.yawDeg, fixed.yaw) * cam) * DEG;
		const actors: Actor[] = [];
		if (input.model.owner_present) {
			const v = worldToView(pose.dir[0], pose.dir[1], viewYaw);
			facing = facingFrom(v[0], v[1], facing) ?? facing;
			const action: RooAction = walk && pose.moving ? "walk" : "idle";
			const n = TownRooArtM2.getFrameCount({ direction: facing, action });
			const idx = frameIndexFor(rooPhase(action, pose.walked, 0), n);
			actors.push({
				id: "player",
				kind: "player",
				x: pose.x,
				z: pose.z,
				key: rooKey(facing, action, idx),
				// followed by the orbit camera: the original fixed pixel size; in the HQ shot it stands
				// among the leads at their world scale; in between the two sizes mix with the camera
				lockedScale: 1 - cam,
			});
		}
		placeLeads(now, reduced);
		book.visits.forEach((v, slot) => {
			const kind = kindOf(v);
			const place = places.get(v.visit_id) ?? {
				routeK: 0,
				spotK: 0,
				shuffle: null,
			};
			places.set(v.visit_id, place);
			const p = visitProgress(v, now, walkMsOf(v), reduced);
			let at = leadPose(v, routeOf(v), p, !walk);
			if (v.left_at === null && p >= 1) {
				// arrived: step up to its spot when the queue moved on
				const target = place.shuffle?.toK ?? place.routeK;
				if (target !== place.spotK) {
					const from = place.shuffle
						? shufflePos(kind, place.shuffle, now)
						: { x: at.x, z: at.z };
					place.shuffle = {
						from: { x: from.x, z: from.z },
						toK: place.spotK,
						t0: now,
					};
				}
				if (place.shuffle) {
					const sh = shufflePos(
						kind,
						place.shuffle,
						reduced ? Number.POSITIVE_INFINITY : now,
					);
					if (sh.done) {
						place.routeK = place.shuffle.toK;
						place.shuffle = null;
					}
					at = {
						...at,
						x: sh.x,
						z: sh.z,
						dir: sh.dir,
						moving: !sh.done && walk,
						walked: sh.walked,
					};
				}
			}
			const w = worldToView(at.dir[0], at.dir[1], viewYaw);
			const f =
				facingFrom(w[0], w[1], leadFacing.get(v.visit_id) ?? null) ?? "south";
			leadFacing.set(v.visit_id, f);
			const sprite: LeadSprite = {
				repo_id: v.repo_id,
				carry: v.carry,
				facing: f,
				action: at.moving ? "walk" : "idle",
				phase: at.moving
					? Math.floor(at.walked / LEAD_STRIDE) & 3
					: walk && now % 3600 < 140
						? 1
						: 0,
			};
			actors.push({
				// a slot per lead on stage (not per visit): the actor layer releases what is not listed
				id: `lead:${slot}`,
				kind: "npc",
				x: at.x,
				z: at.z,
				key: leadKey(sprite),
				lockedScale: false,
				shadow: true,
				sprite,
			});
		});
		for (const id of leadFacing.keys())
			if (!book.visits.some((v) => v.visit_id === id)) leadFacing.delete(id);
		for (const id of places.keys())
			if (!book.visits.some((v) => v.visit_id === id)) places.delete(id);
		pipe.render(actors, { ...fixed.shot, blend: cam });
		const live = townLive.get();
		if (live)
			live.guide = input.model.owner_present
				? { x: pose.x, z: pose.z, yaw: rig.yawDeg }
				: null;
		if (!readySent) {
			readySent = true;
			cb.onReady();
		}
		if (walk) schedule();
	}

	/**
	 * Spots at the HQ, every frame: the waiting leads in the model's order (the board's cards) take the
	 * lowest spots not still held by a lead walking away from one. A new lead's walk is routed to its
	 * spot; one already standing steps up (frame()).
	 */
	function placeLeads(now: number, reduced: boolean) {
		for (const kind of ["sign", "report"] as const) {
			const held = new Set<number>();
			for (const v of book.visits) {
				if (kindOf(v) !== kind || v.left_at === null) continue;
				const pl = places.get(v.visit_id);
				if (pl && visitProgress(v, now, walkMsOf(v), reduced) >= HOLD_UNTIL)
					held.add(pl.shuffle?.toK ?? pl.routeK);
			}
			const waiting = new Set(
				book.visits
					.filter((v) => kindOf(v) === kind && v.left_at === null)
					.map((v) => v.visit_id),
			);
			const order = input.model.visitors
				.filter((v) => kindOf(v) === kind && waiting.has(v.visit_id))
				.map((v) => v.visit_id);
			for (const id of waiting) if (!order.includes(id)) order.push(id);
			for (const [id, k] of assignSpots(order, held)) {
				const pl = places.get(id);
				if (pl) pl.spotK = k;
				else places.set(id, { routeK: k, spotK: k, shuffle: null });
			}
		}
	}

	function update(next: TownInput) {
		if (disposed) return;
		const prev = input;
		input = next;
		if (
			next.model !== prev.model ||
			next.time !== prev.time ||
			next.reducedMotion !== prev.reducedMotion
		)
			applyModel();
		schedule();
	}

	/** The model → lots, world (rebuilt only on a sign / facade / time change), lamps, pylon, windows. */
	function applyModel() {
		const { model, time } = input;
		assign = assignLots(
			assign,
			model.repos.map((r) => r.repo_id),
		);
		lots = buildLots(assign, model.repos);
		routes.clear();
		clock = setStill(clock, model.still, Date.now());
		const known = new Set(book.visits.map((v) => v.visit_id));
		book = reconcileVisits(
			book,
			model.visitors,
			nowScene(),
			walkMsOf,
			input.reducedMotion,
			model.still,
		);
		// A new lead's head start is how long ago its visit began on the wall clock (created_at is wall
		// time; the scene clock lags it by every still stretch), so a reload lands it where it was.
		const wall = Date.now();
		const createdAt = new Map(
			model.visitors.map((v) => [v.visit_id, v.created_at]),
		);
		if (book.visits.some((v) => !known.has(v.visit_id)))
			book = {
				visits: book.visits.map((v) => {
					if (known.has(v.visit_id)) return v;
					const t = Date.parse(createdAt.get(v.visit_id) ?? "");
					const head = Number.isFinite(t)
						? Math.min(MAX_HEAD_START_MS, Math.max(0, wall - t))
						: 0;
					return { ...v, head_start_ms: head };
				}),
			};
		// How much older than its (clamped) head start each visit was when it was (re)seen: the kangaroo's
		// five minutes at the HQ count from the lead's real arrival (choreo.ts HQ_HOLD_MS), so a 결재 that
		// has waited for hours does not pull it back to the HQ on every reload.
		// A visit that turns from a 보고 into a 결재 in place (same id, same seen_at) counts its five minutes
		// from that moment (signedAt).
		const nowS = nowScene();
		for (const v of book.visits) {
			const had = late.get(v.visit_id);
			if (had && had.seen === v.seen_at) {
				if (had.carry === null && v.carry !== null)
					late.set(v.visit_id, { ...had, carry: v.carry, signedAt: nowS });
				else if (had.carry !== v.carry)
					late.set(v.visit_id, { ...had, carry: v.carry });
				continue;
			}
			const t = Date.parse(createdAt.get(v.visit_id) ?? "");
			late.set(v.visit_id, {
				seen: v.seen_at,
				ms: Number.isFinite(t) ? Math.max(0, wall - t - v.head_start_ms) : 0,
				carry: v.carry,
				signedAt: Number.NEGATIVE_INFINITY,
			});
		}
		for (const id of late.keys())
			if (!book.visits.some((v) => v.visit_id === id)) late.delete(id);
		placeLeads(nowScene(), input.reducedMotion);
		pipe.setWorld({ time, lots });
		const lamps = lampInput(model, assign);
		pipe.setLamps(lamps);
		pipe.setBoard(boardViewOf(model, assign));
		for (const l of lots)
			if (l.repo_id) pipe.setLitWindows(l.id, l.litWindows ?? 0);
		const lampOf = new Map(lamps.rows.map((r) => [r.lot, r.lamp]));
		townLive.set({
			offline: model.still,
			guide: townLive.get()?.guide ?? null,
			lots: lots.map((l) => ({
				id: l.id,
				label:
					l.id === HQ_LOT
						? "HQ"
						: l.repo_id
							? (l.mapLabel ?? "")
							: l.boarded
								? ""
								: CAFE_MAP_LABEL,
				lamp: lampOf.get(l.id) ?? "off",
				color: lampCss(lampOf.get(l.id) ?? "off"),
			})),
		});
	}

	// ── size ────────────────────────────────────────────────────────────────────
	function resize() {
		const w = host.clientWidth;
		const h = host.clientHeight;
		if (!w || !h) return;
		pipe.resize(w, h);
		schedule();
	}
	const ro = new ResizeObserver(() => resize());
	reg.defer(() => ro.disconnect(), "resize observer");
	ro.observe(host);

	// ── page and GPU lifecycle (no input events: the scene is not operated) ─────
	const onVisibility = () => {
		if (document.hidden) {
			if (raf) cancelAnimationFrame(raf);
			raf = 0;
			last = 0;
		} else {
			schedule();
		}
	};
	document.addEventListener("visibilitychange", onVisibility);
	reg.defer(
		() => document.removeEventListener("visibilitychange", onVisibility),
		"listener visibilitychange",
	);
	const onLost = (e: Event) => {
		e.preventDefault(); // allow the browser to restore the context
		if (disposed) return;
		contextLost = true;
		if (raf) cancelAnimationFrame(raf);
		raf = 0;
		last = 0;
		if (!lostReported) {
			lostReported = true;
			cb.onContextLost();
		}
	};
	const onRestored = () => {
		if (disposed) return;
		contextLost = false;
		lostReported = false;
		schedule();
	};
	canvas.addEventListener("webglcontextlost", onLost);
	canvas.addEventListener("webglcontextrestored", onRestored);
	reg.defer(() => {
		canvas.removeEventListener("webglcontextlost", onLost);
		canvas.removeEventListener("webglcontextrestored", onRestored);
	}, "listeners webglcontext");

	// ── start ───────────────────────────────────────────────────────────────────
	applyModel();
	resize();
	schedule();

	return {
		update,
		get disposed() {
			return disposed;
		},
		dispose() {
			reg.disposeAll();
		},
	};
}
