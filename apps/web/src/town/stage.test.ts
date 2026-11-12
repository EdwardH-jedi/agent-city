// The stage's start is all-or-nothing: if any step after the pipeline throws, everything made so far
// is released (pipeline, listeners, observer, canvas), the registry is empty and three's global colour
// switch is handed back. DOM and WebGL are stubbed; the pipeline is a fake that flips the real switch.
import { afterEach, describe, expect, test } from "bun:test";
import { ColorManagement } from "three";
import type { CampusModel } from "../campus/presentation.ts";
import { DisposalRegistry } from "../campus/resources.ts";
import { paletteColors, type TownPipeline } from "./pipeline.ts";
import { createTownStage } from "./stage.ts";

const g = globalThis as unknown as Record<string, unknown>;
const saved = new Map<string, unknown>();
function stubGlobal(name: string, value: unknown) {
	if (!saved.has(name)) saved.set(name, g[name]);
	g[name] = value;
}
afterEach(() => {
	for (const [k, v] of saved) {
		if (v === undefined) delete g[k];
		else g[k] = v;
	}
	saved.clear();
});

function fakeDom() {
	const docListeners = new Set<string>();
	const canvasListeners = new Set<string>();
	let canvasRemoved = 0;
	let observers = 0;
	const canvas = {
		className: "",
		setAttribute() {},
		remove() {
			canvasRemoved += 1;
		},
		addEventListener(t: string) {
			canvasListeners.add(t);
		},
		removeEventListener(t: string) {
			canvasListeners.delete(t);
		},
	};
	stubGlobal("document", {
		hidden: false,
		createElement: () => canvas,
		addEventListener(t: string) {
			docListeners.add(t);
		},
		removeEventListener(t: string) {
			docListeners.delete(t);
		},
	});
	stubGlobal(
		"ResizeObserver",
		class {
			observe() {
				observers += 1;
			}
			disconnect() {
				observers -= 1;
			}
		},
	);
	stubGlobal("requestAnimationFrame", () => 1);
	stubGlobal("cancelAnimationFrame", () => undefined);
	const host = {
		clientWidth: 800,
		clientHeight: 600,
		appendChild() {},
	} as unknown as HTMLElement;
	return {
		host,
		get docListeners() {
			return docListeners.size;
		},
		get canvasListeners() {
			return canvasListeners.size;
		},
		get canvasRemoved() {
			return canvasRemoved;
		},
		get observers() {
			return observers;
		},
	};
}

const model: CampusModel = {
	repos: [],
	visitors: [],
	owner_present: true,
	still: false,
	door: null,
};

describe("town stage start", () => {
	test("a step after the pipeline throws: pipeline disposed, listeners and observer gone, colour switch back", () => {
		const dom = fakeDom();
		const before = ColorManagement.enabled;
		let disposed = 0;
		const reg = new DisposalRegistry();
		const fake = () => {
			const restore = paletteColors();
			return {
				setWorld() {},
				setLamps() {},
				setLitWindows() {},
				setBoard() {
					throw new Error("boom: board");
				},
				resize() {},
				dispose() {
					disposed += 1;
					restore();
				},
			} as unknown as TownPipeline;
		};
		expect(() =>
			createTownStage(
				dom.host,
				{ model, reducedMotion: false, time: "day" },
				{ onContextLost() {}, onReady() {} },
				{ createPipeline: fake, registry: reg },
			),
		).toThrow("boom: board");
		expect(disposed).toBe(1);
		expect(ColorManagement.enabled).toBe(before);
		expect(reg.disposed).toBe(true);
		expect(reg.size).toBe(0);
		expect(reg.errors).toEqual([]);
		expect(dom.docListeners).toBe(0);
		expect(dom.canvasListeners).toBe(0);
		expect(dom.observers).toBe(0);
		expect(dom.canvasRemoved).toBe(1);
	});

	test("the pipeline itself throws: the canvas goes, nothing else was made", () => {
		const dom = fakeDom();
		const reg = new DisposalRegistry();
		expect(() =>
			createTownStage(
				dom.host,
				{ model, reducedMotion: false, time: "day" },
				{ onContextLost() {}, onReady() {} },
				{
					createPipeline: () => {
						throw new Error("no webgl");
					},
					registry: reg,
				},
			),
		).toThrow("no webgl");
		expect(reg.size).toBe(0);
		expect(dom.canvasRemoved).toBe(1);
		expect(dom.docListeners).toBe(0);
	});

	test("a good start registers everything and one dispose releases it all", () => {
		const dom = fakeDom();
		const before = ColorManagement.enabled;
		let disposed = 0;
		const reg = new DisposalRegistry();
		const stage = createTownStage(
			dom.host,
			{ model, reducedMotion: false, time: "day" },
			{ onContextLost() {}, onReady() {} },
			{
				createPipeline: () => {
					const restore = paletteColors();
					return {
						setWorld() {},
						setLamps() {},
						setLitWindows() {},
						setBoard() {},
						resize() {},
						dispose() {
							disposed += 1;
							restore();
						},
					} as unknown as TownPipeline;
				},
				registry: reg,
			},
		);
		expect(ColorManagement.enabled).toBe(false);
		expect(dom.docListeners).toBe(1);
		expect(dom.observers).toBe(1);
		stage.dispose();
		stage.dispose();
		expect(disposed).toBe(1);
		expect(ColorManagement.enabled).toBe(before);
		expect([dom.docListeners, dom.canvasListeners, dom.observers]).toEqual([
			0, 0, 0,
		]);
		expect(reg.size).toBe(0);
	});
});
