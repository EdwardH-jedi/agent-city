// Ring-only low-res pipeline, modelled on the original renderer/pipeline.mjs (preset 'ring' branch; that
// file is not ported because it pulls the alley and interior scenes). The world renders into a 384×288
// nearest-filtered target, which is blitted at the largest integer scale that fits, centred, the rest
// cleared to the sky colour. Owns no animation frame: the stage (stage.ts) drives it.
//
// Two lifetimes: the WebGL renderer and the targets live for the mount; the world (scene, pylon, rig,
// atlas, actors) is rebuilt by setWorld() when its spec changes (time of day now, lot overrides in S2).
import {
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
	chooseIntegerScale,
	type IntegerLayout,
	RT_H,
	RT_W,
} from "./engine/pipeline-core.mjs";
import type { Actor } from "./engine/sprites.mjs";
import {
	buildTownWorld,
	type TownWorld,
	type WorldSpec,
	worldKey,
} from "./world.ts";

export { RT_H, RT_W };

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
	readonly layout: IntegerLayout;
	resize(w: number, h: number): IntegerLayout;
	/** Rebuilds the world when the spec's key changed; returns true if it did. */
	setWorld(spec: WorldSpec): boolean;
	setBoard(view: BoardView): void;
	/** One frame: actors staged, world → target → integer blit. */
	render(actors: readonly Actor[]): void;
	dispose(): void;
}

export function createTownPipeline(opts: {
	canvas: HTMLCanvasElement;
	width: number;
	height: number;
	spec: WorldSpec;
	maxScale?: number;
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
	let layout = chooseIntegerScale(1, 1, opts.maxScale);
	let winW = 1;
	let winH = 1;
	let disposed = false;

	function resize(w: number, h: number): IntegerLayout {
		winW = Math.max(1, Math.floor(w));
		winH = Math.max(1, Math.floor(h));
		gl.setSize(winW, winH, true); // canvas CSS size == backing store (pixel ratio 1)
		layout = chooseIntegerScale(winW, winH, opts.maxScale);
		return layout;
	}

	function setWorld(spec: WorldSpec): boolean {
		if (disposed || worldKey(spec) === worldKey(world.spec)) return false;
		const next = buildTownWorld(spec);
		const [x, z] = world.rig.focus;
		world.dispose();
		world = next;
		world.rig.snapTo(x, z);
		if (board) world.setBoard(board);
		return true;
	}

	function render(actors: readonly Actor[]): void {
		if (disposed) return;
		world.stage(actors);
		gl.setScissorTest(false);
		gl.autoClear = true;
		gl.setRenderTarget(rt.target);
		gl.render(world.scene, world.rig.camera);
		gl.setRenderTarget(null);
		gl.autoClear = false;
		gl.setViewport(0, 0, winW, winH);
		gl.setClearColor(world.skyColor, 1);
		gl.clear();
		gl.setViewport(layout.x, layout.y, layout.width, layout.height);
		gl.render(rt.blitScene, rt.blitCamera);
	}

	resize(opts.width, opts.height);
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
		render,
		dispose() {
			if (disposed) return;
			disposed = true;
			world.dispose();
			rt.dispose();
			gl.dispose();
			restoreColors();
		},
	};
}
