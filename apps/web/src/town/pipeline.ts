// Ring-only low-res pipeline, modelled on the original renderer/pipeline.mjs (preset 'ring' branch; that
// file is not ported because it pulls the alley and interior scenes). The world renders into a low-res
// nearest-filtered target, which is blitted at an integer scale, centred; the rest is cleared to the
// board's page colour (LETTERBOX; the original's own pipeline cleared to the sky, but its picture sat in a
// dark stage). Owns no animation frame: the stage (stage.ts) drives it.
//
// Target size (doc 12 §12): the original's 384×288 at the largest integer scale that fits. When only 1×
// would fit, the target narrows instead — the width becomes floor(column / 2), down to 320 — so the column
// gets 2× rather than a tiny 1×. Then (17 F3) the height grows to fill the column: clamp(floor(column height
// / scale), 288, 360), and the world's fov widens with it (world.ts fovFor) so the texel density, the
// camera's pixel size and every snap step stay the original's: more sky and street, nothing bigger.
//
// Two lifetimes: the WebGL renderer and the targets live for the mount; the world (scene, pylon, rig,
// atlas, actors) is rebuilt by setWorld() when its spec changes (time of day, the lots' signs and facades).
import {
	Color,
	ColorManagement,
	LinearSRGBColorSpace,
	Mesh,
	MeshBasicMaterial,
	NearestFilter,
	OrthographicCamera,
	PlaneGeometry,
	Scene,
	WebGLRenderer,
	WebGLRenderTarget,
} from "three";
import type { BoardView } from "./engine/leaderboard.mjs";
import {
	type IntegerLayout,
	RT_H,
	RT_W,
	RT_W_MAX,
	setRenderHeight,
	setRenderWidth,
} from "./engine/pipeline-core.mjs";
import type { LampInput } from "./engine/scene-ring.mjs";
import type { Actor } from "./engine/sprites.mjs";
import {
	BASE_RT_H,
	buildTownWorld,
	type CameraShot,
	type TownWorld,
	type WorldSpec,
	worldKey,
} from "./world.ts";

export { RT_H, RT_W };

/** The tallest render target (17 F3 [제안] 360): how much more sky and street the stage may show. */
export const RT_H_MAX = 360;

/** The narrowest render target the town uses (the HQ shot is checked down to this aspect). */
export const RT_W_MIN = 320;
const MAX_SCALE = 4;

/** The board frame's page colour, around the picture. */
export const LETTERBOX = 0x0f0c0b;

export interface StageLayout extends IntegerLayout {
	/** Render-target width. */
	rtW: number;
	/** Render-target height (17 F3: fills the stage's height, 288..360). */
	rtH: number;
}

/** 17 F3: the target's height for a stage `winH` tall at integer scale `s`: clamp(floor(winH / s), 288, 360). */
export const rtHeightFor = (winH: number, scale: number): number => {
	const rows = Math.floor(Math.max(0, winH || 0) / Math.max(1, scale || 1));
	return Math.max(BASE_RT_H, Math.min(RT_H_MAX, rows));
};

/**
 * The render target and its integer scale for a stage of winW × winH CSS px: the scale is picked as the
 * original's 384×288 (the largest integer that fits; only when that is 1×, a narrower target ≥ RT_W_MIN
 * wide, floor(winW / 2), at 2×; otherwise 384 at 1×), then the target's height grows to fill the stage
 * (17 F3: rtHeightFor, 288..360). Centred, bottom-left origin (GL viewport).
 */
export function fitStage(winW: number, winH: number): StageLayout {
	const mk = (rtW: number, scale: number): StageLayout => {
		const rtH = rtHeightFor(winH, scale);
		const width = rtW * scale;
		const height = rtH * scale;
		return {
			rtW,
			rtH,
			scale,
			width,
			height,
			x: Math.max(0, Math.floor((winW - width) / 2)),
			y: Math.max(0, Math.floor((winH - height) / 2)),
			fits: width <= winW && height <= winH,
		};
	};
	// the original's full 384 width at the largest integer scale that fits
	for (let scale = MAX_SCALE; scale >= 2; scale -= 1)
		if (RT_W_MAX * scale <= winW && BASE_RT_H * scale <= winH)
			return mk(RT_W_MAX, scale);
	// only 1× would fit: narrow the target (≥ 320) to reach 2× instead
	const narrow = Math.floor(winW / 2);
	if (narrow >= RT_W_MIN && BASE_RT_H * 2 <= winH) return mk(narrow, 2);
	return mk(RT_W_MAX, 1);
}

/** The same layout at another target height (kept while a new height settles: see the pipeline's resize). */
export function withRows(
	l: StageLayout,
	rtH: number,
	winH: number,
): StageLayout {
	const height = rtH * l.scale;
	return {
		...l,
		rtH,
		height,
		y: Math.max(0, Math.floor((winH - height) / 2)),
		fits: l.fits && height <= winH,
	};
}

/** How long the stage's height must stay put before the world is rebuilt for a new target height (17 F3). */
export const REBUILD_SETTLE_MS = 300;

/**
 * The original turns three's colour management off so authored texel colours reach the screen
 * unchanged. That switch is global on the shared `three` module (the campus uses it too), so it is
 * set here and handed back on dispose. Returns the restore.
 */
export function paletteColors(): () => void {
	const before = ColorManagement.enabled;
	ColorManagement.enabled = false;
	let done = false;
	return () => {
		if (done) return;
		done = true;
		ColorManagement.enabled = before;
	};
}

/** Target + blit quad (pipeline.mjs createPipelineTargets, without the door fade). No GL context needed. */
export function createPipelineTargets() {
	const target = new WebGLRenderTarget(RT_W, RT_H, {
		minFilter: NearestFilter,
		magFilter: NearestFilter,
		generateMipmaps: false,
		depthBuffer: true,
		stencilBuffer: false,
	});
	const blitCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
	const blitGeo = new PlaneGeometry(2, 2);
	const blitMat = new MeshBasicMaterial({
		map: target.texture,
		depthTest: false,
		depthWrite: false,
		fog: false,
		toneMapped: false,
	});
	const blitScene = new Scene();
	blitScene.add(new Mesh(blitGeo, blitMat));
	return {
		target,
		blitScene,
		blitCamera,
		dispose() {
			target.dispose();
			blitGeo.dispose();
			blitMat.dispose();
		},
	};
}

/**
 * A rebuilt world's new rig takes over where the old one was: its focus, and — inside the plaza, where the
 * rig freezes its view and the stage has turned it to the pylon (choreo.ts steerPlaza) — the same view
 * (16 A2 review: a time-of-day or sign change mid-plaza must not swing the camera). On the ring the rig
 * finds its own view from the travel direction, as before.
 */
export function carryRig(
	from: { x: number; z: number; yaw: number; plaza: boolean },
	rig: TownWorld["rig"],
): void {
	rig.snapTo(from.x, from.z);
	if (from.plaza && rig.mode === "plaza") rig.snapYaw(from.yaw);
}

export interface TownPipeline {
	readonly renderer: WebGLRenderer;
	readonly world: TownWorld;
	readonly layout: StageLayout;
	resize(w: number, h: number): StageLayout;
	/** Rebuilds the world when the spec's key changed; returns true if it did. */
	setWorld(spec: WorldSpec): boolean;
	setBoard(view: BoardView): void;
	setLamps(input: LampInput): void;
	setLitWindows(lotId: string, n: number): void;
	/** One frame: actors staged, world → target → integer blit. */
	render(actors: readonly Actor[], shot?: CameraShot | null): void;
	dispose(): void;
}

export function createTownPipeline(opts: {
	canvas: HTMLCanvasElement;
	width: number;
	height: number;
	spec: WorldSpec;
	/** Called after the pipeline changed its layout on its own (a settled height rebuild): redraw. */
	onRelayout?: (layout: StageLayout) => void;
}): TownPipeline {
	const restoreColors = paletteColors();
	// A failed start releases what it made and hands the colour switch back (the 2D grid takes over).
	let renderer: WebGLRenderer | null = null;
	let targets: ReturnType<typeof createPipelineTargets> | null = null;
	let world: TownWorld;
	try {
		renderer = new WebGLRenderer({
			canvas: opts.canvas,
			antialias: false,
			alpha: false,
			powerPreference: "low-power",
		});
		renderer.setPixelRatio(1);
		renderer.outputColorSpace = LinearSRGBColorSpace;
		// 17 F3: the target's size is set before anything reads it (the first world's camera, the target)
		const first = fitStage(opts.width, opts.height);
		setRenderWidth(first.rtW);
		setRenderHeight(first.rtH);
		targets = createPipelineTargets();
		world = buildTownWorld({ ...opts.spec, rtH: first.rtH });
	} catch (e) {
		targets?.dispose();
		renderer?.dispose();
		setRenderWidth(RT_W_MAX);
		setRenderHeight(BASE_RT_H);
		restoreColors();
		throw e;
	}
	const gl = renderer;
	const rt = targets;
	let board: BoardView | null = null;
	let lamps: LampInput | null = null;
	const lit = new Map<string, number>();
	// Outside the integer-scaled picture: the board's page colour (the original's picture sat in a dark
	// stage), made here so it is not converted by colour management (off from paletteColors() on).
	const letterbox = new Color(LETTERBOX);
	let layout = fitStage(opts.width, opts.height);
	let winW = 1;
	let winH = 1;
	let disposed = false;

	/**
	 * The target's size and the camera's aspect follow the layout (new worlds read RT_W / RT_H themselves). A
	 * new height needs a new fov (world.ts fovFor): the world is rebuilt for it, the rig carried over.
	 */
	function applyLayout(l: StageLayout) {
		setRenderWidth(l.rtW);
		setRenderHeight(l.rtH);
		if (rt.target.width !== l.rtW || rt.target.height !== l.rtH)
			rt.target.setSize(l.rtW, l.rtH);
		if ((world.spec.rtH ?? BASE_RT_H) !== l.rtH) {
			rebuild({ ...world.spec, rtH: l.rtH }, true);
			return;
		}
		const cam = world.rig.camera;
		if (Math.abs(cam.aspect - l.rtW / l.rtH) > 1e-9) {
			cam.aspect = l.rtW / l.rtH;
			cam.updateProjectionMatrix();
		}
	}

	/**
	 * A new height rebuilds the world (a new fov), which takes a few hundred ms: while the size is still
	 * moving (a window dragged, devtools docked) the old height is kept and the picture re-centred; once it
	 * has stayed put for REBUILD_SETTLE_MS, one rebuild. Width and aspect follow at once, as before.
	 */
	let settle: ReturnType<typeof setTimeout> | null = null;
	function resize(w: number, h: number): StageLayout {
		winW = Math.max(1, Math.floor(w));
		winH = Math.max(1, Math.floor(h));
		gl.setSize(winW, winH, true); // canvas CSS size == backing store (pixel ratio 1)
		const want = fitStage(winW, winH);
		const have = world.spec.rtH ?? BASE_RT_H;
		if (settle) clearTimeout(settle);
		settle = null;
		if (want.rtH === have) {
			layout = want;
			applyLayout(layout);
			return layout;
		}
		layout = withRows(want, have, winH);
		applyLayout(layout);
		settle = setTimeout(() => {
			settle = null;
			if (disposed) return;
			layout = fitStage(winW, winH);
			applyLayout(layout);
			opts.onRelayout?.(layout);
		}, REBUILD_SETTLE_MS);
		return layout;
	}

	/** `keepLit`: a rebuild for the height only (same lots) keeps the lit windows set since the lots were built. */
	function rebuild(spec: WorldSpec, keepLit = false) {
		const next = buildTownWorld(spec);
		const prev = world.rig;
		const [x, z] = prev.focus;
		const yaw = prev.yawDeg;
		const plaza = prev.mode === "plaza";
		world.dispose();
		world = next;
		const cam = world.rig.camera;
		if (Math.abs(cam.aspect - RT_W / RT_H) > 1e-9) {
			cam.aspect = RT_W / RT_H;
			cam.updateProjectionMatrix();
		}
		carryRig({ x, z, yaw, plaza }, world.rig);
		if (board) world.setBoard(board);
		if (lamps) world.setLamps(lamps);
		// the lit windows set since the lots were last built (their counts are not in the world's key);
		// a rebuild for new lots is followed by the stage's own setLitWindows
		if (keepLit) for (const [lotId, n] of lit) world.setLitWindows(lotId, n);
		else lit.clear();
	}

	/** The stage's spec (time, lots) with this pipeline's height: rebuilt only when the key changed. */
	function setWorld(spec: WorldSpec): boolean {
		const full = { ...spec, rtH: layout.rtH };
		if (disposed || worldKey(full) === worldKey(world.spec)) return false;
		rebuild(full);
		return true;
	}

	function render(actors: readonly Actor[], shot?: CameraShot | null): void {
		if (disposed) return;
		world.stage(actors, shot);
		gl.setScissorTest(false);
		gl.autoClear = true;
		gl.setRenderTarget(rt.target);
		gl.render(world.scene, world.rig.camera);
		gl.setRenderTarget(null);
		gl.autoClear = false;
		gl.setViewport(0, 0, winW, winH);
		gl.setClearColor(letterbox, 1);
		gl.clear();
		gl.setViewport(layout.x, layout.y, layout.width, layout.height);
		gl.render(rt.blitScene, rt.blitCamera);
	}

	try {
		resize(opts.width, opts.height);
	} catch (e) {
		world.dispose();
		rt.dispose();
		gl.dispose();
		setRenderWidth(RT_W_MAX);
		setRenderHeight(BASE_RT_H);
		restoreColors();
		throw e;
	}
	return {
		renderer: gl,
		get world() {
			return world;
		},
		get layout() {
			return layout;
		},
		resize,
		setWorld,
		setBoard(view) {
			board = view;
			world.setBoard(view);
		},
		setLamps(input) {
			lamps = input;
			world.setLamps(input);
		},
		setLitWindows(lotId, n) {
			lit.set(lotId, n);
			world.setLitWindows(lotId, n);
		},
		render,
		dispose() {
			if (disposed) return;
			disposed = true;
			if (settle) clearTimeout(settle);
			world.dispose();
			rt.dispose();
			gl.dispose();
			setRenderWidth(RT_W_MAX); // the size is module state: hand back the original's
			setRenderHeight(BASE_RT_H);
			restoreColors();
		},
	};
}
