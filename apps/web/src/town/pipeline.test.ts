// The stage's render target (doc 12 §12): the original 384 wide at the largest integer scale that fits;
// when only 1× would, a narrower target at 2×. 17 F3: the height then fills the stage (288..360) and the
// fov widens with it, so the texel density and the horizontal view are the original's.
import { afterEach, describe, expect, test } from "bun:test";
import { PerspectiveCamera, Vector3 } from "three";
import {
	RT_H,
	RT_W,
	RT_W_MAX,
	setRenderHeight,
	setRenderWidth,
} from "./engine/pipeline-core.mjs";
import { snapToPixel, worldPerPixel } from "./engine/sprites.mjs";
import {
	createPipelineTargets,
	fitStage,
	RT_H_MAX,
	RT_W_MIN,
	rtHeightFor,
	withRows,
} from "./pipeline.ts";
import { BASE_RT_H, fovFor } from "./world.ts";

afterEach(() => {
	// the target's size is module state: every test hands back the original's
	setRenderWidth(RT_W_MAX);
	setRenderHeight(BASE_RT_H);
});

describe("fitStage", () => {
	test("a 1300×1000 column: 384 wide at 3×, the height filled (333 rows), centred", () => {
		const l = fitStage(1300, 1000);
		expect(l).toMatchObject({
			rtW: 384,
			rtH: 333,
			scale: 3,
			width: 1152,
			height: 999,
			fits: true,
		});
		expect([l.x, l.y]).toEqual([74, 0]);
	});

	test("a 746×688 column: 373 wide at 2× instead of a tiny 1×, 344 rows", () => {
		expect(fitStage(746, 688)).toMatchObject({
			rtW: 373,
			rtH: 344,
			scale: 2,
			width: 746,
			height: 688,
			fits: true,
		});
	});

	test("the full 384 width wins whenever it fits at 2× or more (no needless narrowing)", () => {
		expect(fitStage(980, 920)).toMatchObject({
			rtW: 384,
			scale: 2,
			width: 768,
		});
		expect(fitStage(1160, 870)).toMatchObject({ rtW: 384, scale: 3 });
		expect(fitStage(1100, 870)).toMatchObject({ rtW: 384, scale: 2 });
	});

	test("large screens get 4×; the width never goes past 384 nor (above 1×) under 320", () => {
		expect(fitStage(2000, 1400)).toMatchObject({ rtW: 384, scale: 4 });
		for (let w = 300; w <= 2600; w += 37)
			for (let h = 250; h <= 1500; h += 41) {
				const l = fitStage(w, h);
				expect(l.rtW).toBeLessThanOrEqual(384);
				expect(l.rtW).toBeGreaterThanOrEqual(RT_W_MIN);
				if (l.scale >= 2) expect(l.fits).toBe(true);
				if (l.scale === 1)
					expect(
						Math.min(Math.floor(w / RT_W_MIN), Math.floor(h / 288)),
					).toBeLessThan(2);
				// 17 F3: 288..360 rows, filling the height to under one scale step unless clamped at 360
				expect(l.rtH).toBeGreaterThanOrEqual(288);
				expect(l.rtH).toBeLessThanOrEqual(RT_H_MAX);
				if (l.scale >= 2 && l.rtH < RT_H_MAX)
					expect(h - l.height).toBeLessThan(l.scale);
				// narrowed only to reach 2× where 384 would have been 1×
				if (l.rtW < 384) {
					expect(l.scale).toBe(2);
					expect(w).toBeLessThan(768);
				}
			}
	});

	test("too small for 2×: 1× (as wide as fits)", () => {
		expect(fitStage(500, 400)).toMatchObject({ scale: 1, rtW: 384 });
		expect(fitStage(700, 500)).toMatchObject({ scale: 1, rtW: 384 });
	});
});

describe("the narrowed target", () => {
	test("RT_W is live in the engine: targets, pixel snapping; the height (texel density) is unchanged", () => {
		const cam = new PerspectiveCamera(54, 384 / 288, 0.5, 200);
		cam.position.set(0, 10, 20);
		cam.lookAt(0, 0, 0);
		cam.updateMatrixWorld(true);
		const before = worldPerPixel(cam, 18);
		expect(setRenderWidth(373)).toBe(373);
		expect(RT_W).toBe(373);
		const t = createPipelineTargets();
		expect([t.target.width, t.target.height]).toEqual([373, 288]);
		expect(worldPerPixel(cam, 18)).toBe(before);
		// snapping lands on whole pixels of the narrow target
		cam.aspect = 373 / 288;
		cam.updateProjectionMatrix();
		const p = snapToPixel(cam, new Vector3(1.234, 0, 2.345)).project(cam);
		const px = (p.x * 0.5 + 0.5) * 373;
		expect(Math.abs(px - Math.round(px))).toBeLessThan(1e-6);
		t.dispose();
		expect(setRenderWidth(10_000)).toBe(384);
		expect(setRenderWidth(Number.NaN)).toBe(384);
	});

	test("resizing the target releases its GL storage each time and once more at the end; same objects", () => {
		const t = createPipelineTargets();
		const tex = t.target.texture;
		let released = 0;
		t.target.addEventListener("dispose", () => {
			released += 1;
		});
		t.target.setSize(373, 288);
		t.target.setSize(373, 288); // same size: nothing to release
		t.target.setSize(384, 288);
		t.dispose();
		expect(released).toBe(3);
		expect(t.target.texture).toBe(tex);
	});
});

describe("17 F3: the target fills the stage's height", () => {
	// the board's middle column under the 56 px top band (board/layout.ts)
	test.each([
		["1920×1080", 1152, 1024, 3, 341, 1023],
		["1366×768", 768, 712, 2, 356, 712],
		["1280×720", 768, 664, 2, 332, 664],
		["2560×1440", 1720, 1384, 4, 346, 1384],
		["1920×1200 (clamped)", 1152, 1144, 3, 360, 1080],
	])("%s: scale %i… rows", (_n, w, h, scale, rtH, height) => {
		expect(fitStage(w, h)).toMatchObject({ scale, rtH, height, rtW: 384 });
	});
	test("a very low window: never under 288 rows (as before), never over 360", () => {
		expect(rtHeightFor(200, 1)).toBe(288);
		expect(rtHeightFor(0, 3)).toBe(288);
		expect(rtHeightFor(Number.NaN, 2)).toBe(288);
		expect(rtHeightFor(5000, 1)).toBe(360);
	});
	test("RT_H is live in the engine and clamped 288..360", () => {
		expect(setRenderHeight(341)).toBe(341);
		expect(RT_H).toBe(341);
		const t = createPipelineTargets();
		expect([t.target.width, t.target.height]).toEqual([384, 341]);
		t.dispose();
		expect(setRenderHeight(100)).toBe(288);
		expect(setRenderHeight(1000)).toBe(360);
		expect(setRenderHeight(Number.NaN)).toBe(288);
	});
	test("while a new height settles the old rows are kept, re-centred (withRows)", () => {
		const want = fitStage(1366 - 598, 712); // 768 × 712: 356 rows at 2×
		const kept = withRows(want, 341, 712);
		expect(kept).toMatchObject({
			scale: 2,
			rtW: 384,
			rtH: 341,
			height: 682,
			y: 15,
		});
		expect(kept.fits).toBe(true);
		expect(withRows(want, 360, 712)).toMatchObject({
			height: 720,
			y: 0,
			fits: false,
		});
	});
	test("fovFor: 288 rows is the original's fov; more rows, a wider fov", () => {
		expect(fovFor(54, 288)).toBeCloseTo(54, 12);
		expect(fovFor(54, 341)).toBeGreaterThan(54);
		expect(fovFor(54, 360)).toBeLessThan(90);
	});
	test("the widened fov keeps the texel density and the view: every point's pixel offset from the centre is the original's", () => {
		const cam = (fov: number, rows: number) => {
			const c = new PerspectiveCamera(fov, 384 / rows, 0.5, 200);
			c.position.set(3, 9, 22);
			c.lookAt(0, 4, 0);
			c.updateMatrixWorld(true);
			c.updateProjectionMatrix();
			return c;
		};
		const a = cam(54, 288);
		const wppA = worldPerPixel(a, 18);
		setRenderHeight(341);
		const b = cam(fovFor(54, 341), 341);
		// worldPerPixel reads the live RT_H: the same world size per pixel at the same depth
		expect(worldPerPixel(b, 18)).toBeCloseTo(wppA, 9);
		for (const p of [
			new Vector3(0, 0, 0),
			new Vector3(-6, 2, 3),
			new Vector3(5, 7, -4),
			new Vector3(2, 0.5, 10),
		]) {
			const pa = p.clone().project(a);
			const pb = p.clone().project(b);
			// offsets in target pixels from the picture's centre
			expect((pb.x * 384) / 2).toBeCloseTo((pa.x * 384) / 2, 6);
			expect((pb.y * 341) / 2).toBeCloseTo((pa.y * 288) / 2, 6);
		}
	});
});
