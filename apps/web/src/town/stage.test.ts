// The stage's start is all-or-nothing: if any step after the pipeline throws, everything made so far
// is released (pipeline, listeners, observer, canvas), the registry is empty and three's global colour
// switch is handed back. DOM and WebGL are stubbed; the pipeline is a fake that flips the real switch.
import { afterEach, describe, expect, test } from "bun:test";
import { ColorManagement } from "three";
import type { CampusModel } from "../campus/presentation.ts";
import { DisposalRegistry } from "../campus/resources.ts";
import { HQ_HOLD_MS } from "./choreo.ts";
import { paletteColors, type TownPipeline } from "./pipeline.ts";
import { createTownStage } from "./stage.ts";
import { buildTownWorld } from "./world.ts";

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

describe("the HQ shot's five minutes count from the 결재 lead's real arrival", () => {
	// a 결재 visitor that began `ageMs` ago: does the first frame show the HQ shot (blend 1) or the patrol (0)?
	/**
	 * A 결재 visitor that began `ageMs` ago: the blend of the first frame (1 = HQ shot, 0 = patrol), then,
	 * if `laterMs` is given, of a frame after the wall clock moved on that far and a new model (the same
	 * visitor) came in.
	 */
	function blendsOf(ageMs: number, laterMs?: number): number[] {
		const realNow = Date.now;
		const t0 = realNow();
		let wall = t0;
		Date.now = () => wall;
		const dom = fakeDom();
		let frame: ((ts: number) => void) | null = null;
		stubGlobal("requestAnimationFrame", (f: (ts: number) => void) => {
			frame = f;
			return 1;
		});
		const blends: number[] = [];
		const world = buildTownWorld({ time: "day", lots: null });
		const m: CampusModel = {
			...model,
			repos: [
				{
					repo_id: "o/a",
					label: "a",
					active_tasks: 0,
					monitors: [],
					pending_requests: 1,
					has_stopped: false,
				},
			],
			visitors: [
				{
					visit_id: "m:r1",
					kind: "sign",
					carry: "folder",
					repo_id: "o/a",
					created_at: new Date(t0 - ageMs).toISOString(),
				},
			],
		};
		const stage = createTownStage(
			dom.host,
			{ model: m, reducedMotion: false, time: "day" },
			{ onContextLost() {}, onReady() {} },
			{
				createPipeline: () =>
					({
						world,
						setWorld() {},
						setLamps() {},
						setLitWindows() {},
						setBoard() {},
						resize() {},
						render(_a: unknown, shot: { blend: number }) {
							blends.push(shot.blend);
						},
						dispose() {},
					}) as unknown as TownPipeline,
			},
		);
		try {
			(frame as ((ts: number) => void) | null)?.(1000);
			if (laterMs !== undefined) {
				wall = t0 + laterMs;
				stage.update({
					model: { ...m, visitors: [...m.visitors] },
					reducedMotion: false,
					time: "day",
				});
				(frame as ((ts: number) => void) | null)?.(1000 + laterMs);
			}
		} finally {
			Date.now = realNow;
			stage.dispose();
			world.dispose();
		}
		return blends;
	}
	const firstBlend = (ageMs: number) => blendsOf(ageMs)[0] ?? Number.NaN;

	test("arrived 2 minutes ago: the HQ shot; 2 hours ago: the patrol (the lead still stands at the door)", () => {
		expect(firstBlend(2 * 60_000)).toBe(1);
		expect(firstBlend(2 * 3600_000)).toBe(0);
		expect(firstBlend(HQ_HOLD_MS + 60_000)).toBe(0);
	});

	test("a later model does not re-measure the visit's age: 4 min old, 50 s later still the HQ shot", () => {
		// re-measured, the lead would count as having arrived 4 min 50 s ago and the stay would be over
		expect(blendsOf(4 * 60_000, 50_000)).toEqual([1, 1]);
	});

	test("a 보고 lead that turns into a 결재 in place: the HQ shot holds five minutes from the flip", () => {
		const realNow = Date.now;
		const t0 = realNow();
		let wall = t0;
		Date.now = () => wall;
		const dom = fakeDom();
		let frame: ((ts: number) => void) | null = null;
		stubGlobal("requestAnimationFrame", (f: (ts: number) => void) => {
			frame = f;
			return 1;
		});
		const blends: number[] = [];
		const world = buildTownWorld({ time: "day", lots: null });
		const repo = {
			repo_id: "o/a",
			label: "a",
			active_tasks: 1,
			monitors: [],
			pending_requests: 0,
			has_stopped: false,
		};
		const visitor = (carry: "folder" | null) => ({
			visit_id: "m:r1",
			kind: carry ? ("sign" as const) : ("report" as const),
			carry,
			repo_id: "o/a",
			created_at: new Date(t0 - 10_000).toISOString(),
		});
		const m = (carry: "folder" | null): CampusModel => ({
			...model,
			repos: [repo],
			visitors: [visitor(carry)],
		});
		const stage = createTownStage(
			dom.host,
			{ model: m(null), reducedMotion: false, time: "day" },
			{ onContextLost() {}, onReady() {} },
			{
				createPipeline: () =>
					({
						world,
						setWorld() {},
						setLamps() {},
						setLitWindows() {},
						setBoard() {},
						resize() {},
						render(_a: unknown, shot: { blend: number }) {
							blends.push(shot.blend);
						},
						dispose() {},
					}) as unknown as TownPipeline,
			},
		);
		const at = (ms: number) => {
			wall = t0 + ms;
			(frame as ((ts: number) => void) | null)?.(1000 + ms);
		};
		try {
			at(0);
			at(60_000); // a report: the patrol
			const flip = 180_000;
			wall = t0 + flip;
			stage.update({ model: m("folder"), reducedMotion: false, time: "day" });
			at(flip);
			at(flip + 60_000); // walked there by now
			at(flip + 240_000); // 4 min after the flip: still at the HQ
			at(flip + HQ_HOLD_MS + 60_000); // past five minutes: back on patrol
		} finally {
			Date.now = realNow;
			stage.dispose();
			world.dispose();
		}
		expect(blends[1]).toBe(0);
		expect(blends[3]).toBe(1);
		expect(blends[4]).toBe(1);
		expect(blends[5]).toBe(0);
	});
});
