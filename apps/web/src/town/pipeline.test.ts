// The stage's render target (doc 12 §12): the original 384×288 at the largest integer scale that fits;
// when only 1× would, a narrower target (height 288 kept, so the texel density is the original's) at 2×.
import { afterEach, describe, expect, test } from "bun:test";
import { PerspectiveCamera, Vector3 } from "three";
import { RT_W, RT_W_MAX, setRenderWidth } from "./engine/pipeline-core.mjs";
import { snapToPixel, worldPerPixel } from "./engine/sprites.mjs";
import { createPipelineTargets, fitStage, RT_W_MIN } from "./pipeline.ts";

afterEach(() => {
	setRenderWidth(RT_W_MAX);
});

describe("fitStage", () => {
	test("1920×1080 board (column ≈1300×1000): the original 384×288 at 3×, centred", () => {
		const l = fitStage(1300, 1000);
		expect(l).toMatchObject({
			rtW: 384,
			scale: 3,
			width: 1152,
			height: 864,
			fits: true,
		});
		expect([l.x, l.y]).toEqual([74, 68]);
	});

	test("1366×768 board (column ≈746×688): 373×288 at 2× instead of a tiny 1×", () => {
		expect(fitStage(746, 688)).toMatchObject({
			rtW: 373,
			scale: 2,
			width: 746,
			height: 576,
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
