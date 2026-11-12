// The town stage: owns the canvas, the pipeline, the one animation-frame chain and the page/GPU
// lifecycle (the original scene-switch.mjs renderRing, without the keyboard world). Every resource,
// listener, observer and frame request goes through a DisposalRegistry. The scene listens to no input:
// only visibility, WebGL context loss/restore and the stage's size.
//
// Frame (renderRing order): the kangaroo's pose from patrol time → orbit rig yaw toward the tangent →
// rig.update → screen facing from the rig's yaw → actors → render.
//
// Data (design doc 12 §4, lots.ts): each new model re-assigns the project lots (sticky slots), rebuilds
// the world only when a lot's sign or facade changes, and otherwise updates in place: door lamps, the
// pylon, lit windows. The kangaroo is drawn only while the owner is there; the camera keeps its slow
// patrol either way (burn-in) unless reports stopped, when everything holds still.

import type { CampusModel } from "../campus/presentation.ts";
import { DisposalRegistry } from "../campus/resources.ts";
import { LAMP_COLORS, type LampState } from "./engine/scene-ring.mjs";
import type { RooAction, RooDirection } from "./engine/town-roo-art-m2.mjs";
import { TownRooArtM2 } from "./engine/town-roo-art-m2.mjs";
import { townLive } from "./live.ts";
import {
	assignLots,
	boardViewOf,
	buildLots,
	HQ_LOT,
	type LotAssignment,
	lampInput,
	mapLabel,
	type TownLot,
} from "./lots.ts";
import type { TimeOfDay } from "./params.ts";
import {
	facingFrom,
	frameIndexFor,
	patrolPose,
	rooKey,
	rooPhase,
	worldToView,
} from "./patrol.ts";
import { createTownPipeline, type TownPipeline } from "./pipeline.ts";

const DEG = Math.PI / 180;
const lampCss = (s: LampState): string | null => {
	if (s === "off") return null;
	const c = LAMP_COLORS[s];
	return `rgb(${c[0]},${c[1]},${c[2]})`;
};
/** A frame never advances the patrol more than this (a hidden tab resumes where it stopped). */
const MAX_DT_S = 0.1;

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
	let patrolT = 0; // seconds of patrol walked so far
	let facing: RooDirection = "north";
	let last = 0;
	let raf = 0;
	let contextLost = false;
	let lostReported = false;
	let readySent = false;
	let disposed = false;
	reg.defer(() => {
		disposed = true;
	}, "stage state");

	const moving = () => !input.reducedMotion && !input.model.still;
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
		const dt = last ? Math.min(MAX_DT_S, Math.max(0, (ts - last) / 1000)) : 0;
		last = ts;
		const walk = moving();
		if (walk) patrolT += dt;
		const pose = patrolPose(patrolT);
		const rig = pipe.world.rig;
		rig.setYaw(rig.yawFor(pose));
		rig.update(dt, pose.x, pose.z);
		const v = worldToView(pose.dir[0], pose.dir[1], rig.yawDeg * DEG);
		facing = facingFrom(v[0], v[1], facing) ?? facing;
		const action: RooAction = walk ? "walk" : "idle";
		const n = TownRooArtM2.getFrameCount({ direction: facing, action });
		const idx = frameIndexFor(rooPhase(action, pose.walked, 0), n);
		const present = input.model.owner_present;
		pipe.render(
			present
				? [
						{
							id: "player",
							kind: "player",
							x: pose.x,
							z: pose.z,
							key: rooKey(facing, action, idx),
							lockedScale: true,
						},
					]
				: [],
		);
		const live = townLive.get();
		if (live)
			live.guide = present ? { x: pose.x, z: pose.z, yaw: rig.yawDeg } : null;
		if (!readySent) {
			readySent = true;
			cb.onReady();
		}
		if (walk) schedule();
		else last = 0;
	}

	function update(next: TownInput) {
		if (disposed) return;
		const prev = input;
		input = next;
		if (next.model !== prev.model || next.time !== prev.time) applyModel();
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
							? mapLabel(l.name)
							: l.boarded
								? ""
								: mapLabel(l.label),
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
