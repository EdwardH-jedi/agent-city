// Ring-only low-res pipeline, modelled on the original renderer/pipeline.mjs (preset 'ring' branch; that
// file is not ported because it pulls the alley and interior scenes). The world renders into a low-res
// nearest-filtered target, which is blitted at an integer scale, centred; the rest is cleared to the
// board's page colour (LETTERBOX; the original's own pipeline cleared to the sky, but its picture sat in a
// dark stage). Owns no animation frame: the stage (stage.ts) drives it.
//
// Target size (doc 12 §12): the original's 384×288 at the largest integer scale that fits. When only 1×
// would fit (a 1366×768 screen: the column is ~746×688), the target narrows instead — the height stays 288
// (so the texel density, the camera's pixel size and every snap step are the original's) and the width
// becomes floor(column / 2), down to 320 — so the column gets 2× (373×288) rather than a tiny 1×.
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
	setRenderWidth,
} from "./engine/pipeline-core.mjs";
import type { LampInput } from "./engine/scene-ring.mjs";
import type { Actor } from "./engine/sprites.mjs";
import {
	buildTownWorld,
	type CameraShot,
	type TownWorld,
	type WorldSpec,
	worldKey,
} from "./world.ts";

export { RT_H, RT_W };

/** The narrowest render target the town uses (the HQ shot is checked down to this aspect). */
export const RT_W_MIN = 320;
const MAX_SCALE = 4;

/** The board frame's page colour, around the picture. */
export const LETTERBOX = 0x0f0c0b;

export interface StageLayout extends IntegerLayout {
	/** Render-target width (RT_H is fixed). */
	rtW: number;
}

/**
 * The render target and its integer scale for a stage of winW × winH CSS px: the original 384×288 at
 * the largest integer scale that fits; only when that is 1×, a narrower target (≥ RT_W_MIN wide,
 * floor(winW / 2)) at 2×; otherwise 384 at 1×. Centred, bottom-left origin (GL viewport).
 */
export function fitStage(winW: number, winH: number): StageLayout {
	const mk = (rtW: number, scale: number): StageLayout => {
		const width = rtW * scale;
		const height = RT_H * scale;
		return {
			rtW,
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
		if (RT_W_MAX * scale <= winW && RT_H * scale <= winH)
			return mk(RT_W_MAX, scale);
	// only 1× would fit: narrow the target (≥ 320) to reach 2× instead
	const narrow = Math.floor(winW / 2);
	if (narrow >= RT_W_MIN && RT_H * 2 <= winH) return mk(narrow, 2);
	return mk(RT_W_MAX, 1);
}

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
		targets = createPipelineTargets();
		world = buildTownWorld(opts.spec);
	} catch (e) {
		targets?.dispose();
		renderer?.dispose();
		restoreColors();
		throw e;
	}
	const gl = renderer;
	const rt = targets;
	let board: BoardView | null = null;
	let lamps: LampInput | null = null;
	// Outside the integer-scaled picture: the board's page colour (the original's picture sat in a dark
	// stage), made here so it is not converted by colour management (off from paletteColors() on).
	const letterbox = new Color(LETTERBOX);
	let layout = fitStage(RT_W, RT_H);
	let winW = 1;
	let winH = 1;
	let disposed = false;

	/** The target's width and the camera's aspect follow the layout (new worlds read RT_W themselves). */
	function applyWidth(rtW: number) {
		setRenderWidth(rtW);
		if (rt.target.width !== rtW) rt.target.setSize(rtW, RT_H);
		const cam = world.rig.camera;
		if (Math.abs(cam.aspect - rtW / RT_H) > 1e-9) {
			cam.aspect = rtW / RT_H;
			cam.updateProjectionMatrix();
		}
	}

	function resize(w: number, h: number): StageLayout {
		winW = Math.max(1, Math.floor(w));
		winH = Math.max(1, Math.floor(h));
		gl.setSize(winW, winH, true); // canvas CSS size == backing store (pixel ratio 1)
		layout = fitStage(winW, winH);
		applyWidth(layout.rtW);
		return layout;
	}

	function setWorld(spec: WorldSpec): boolean {
		if (disposed || worldKey(spec) === worldKey(world.spec)) return false;
		const next = buildTownWorld(spec);
		const [x, z] = world.rig.focus;
		world.dispose();
		world = next;
		applyWidth(layout.rtW);
		world.rig.snapTo(x, z);
		if (board) world.setBoard(board);
		if (lamps) world.setLamps(lamps);
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
			world.setLitWindows(lotId, n);
		},
		render,
		dispose() {
			if (disposed) return;
			disposed = true;
			world.dispose();
			rt.dispose();
			gl.dispose();
			setRenderWidth(RT_W_MAX); // the width is module state: hand back the original's
			restoreColors();
		},
	};
}
