import { afterEach, expect, test } from "bun:test";
import { demoData } from "../../board/demo.ts";
import { toVillageModel } from "../../board/model.ts";
import { toCampusModel } from "../../campus/presentation.ts";
import { DisposalRegistry } from "../../campus/resources.ts";
import type { TownPipeline } from "../pipeline.ts";
import { createTownStage, type TownInput } from "../stage.ts";
import { buildTownWorld } from "../world.ts";

const global = globalThis as unknown as Record<string, unknown>;
const saved = new Map<string, unknown>();
function stub(k: string, v: unknown) {
	if (!saved.has(k)) saved.set(k, global[k]);
	global[k] = v;
}
afterEach(() => {
	for (const [k, v] of saved) {
		if (v === undefined) delete global[k];
		else global[k] = v;
	}
	saved.clear();
});

test("stage navigation releases the actual room before drawing a new D3 or still frame", async () => {
	const realNow = Date.now;
	let now = Date.UTC(2026, 10, 16);
	Date.now = () => now;
	let frame: ((ts: number) => void) | null = null;
	const nodes = new Set<unknown>();
	const make = () => ({
		className: "",
		style: {},
		dataset: {} as Record<string, string>,
		setAttribute() {},
		addEventListener() {},
		removeEventListener() {},
		remove() {
			nodes.delete(this);
		},
	});
	stub("document", {
		hidden: false,
		createElement: make,
		addEventListener() {},
		removeEventListener() {},
	});
	stub(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	stub("requestAnimationFrame", (f: (ts: number) => void) => {
		frame = f;
		return 1;
	});
	stub("cancelAnimationFrame", () => {});
	const host = {
		clientWidth: 768,
		clientHeight: 680,
		dataset: {},
		appendChild(n: unknown) {
			nodes.add(n);
		},
	} as unknown as HTMLElement;
	const data = demoData(now, "interior");
	const model = toVillageModel({ ...data, now, conn: "open" });
	const source = { model, sessions: data.sessions, events: data.events, now };
	const input: TownInput = {
		model: toCampusModel(model),
		time: "day",
		reducedMotion: false,
		interiorSource: source,
		tourOff: true,
	};
	const world = buildTownWorld({ time: "day", lots: null });
	const reg = new DisposalRegistry();
	let inside: string | null = null,
		roomDraws = 0,
		ringDraws = 0;
	const stage = createTownStage(
		host,
		input,
		{
			onContextLost() {},
			onReady() {},
			onInteriorChange(v) {
				inside = v?.repo_id ?? null;
			},
		},
		{
			registry: reg,
			createPipeline: () =>
				({
					world,
					layout: { rtW: 384, rtH: 340 },
					setWorld() {},
					setLamps() {},
					setBoard() {},
					setLitWindows() {},
					resize() {},
					render() {
						ringDraws++;
					},
					renderScene() {
						roomDraws++;
					},
					dispose() {
						world.dispose();
					},
				}) as unknown as TownPipeline,
		},
	);
	const paint = () => {
		const f = frame;
		if (f) f(now);
	};
	try {
		paint();
		stage.update({ ...input, interiorCommand: { serial: 1, index: 0 } });
		for (let i = 0; i < 50 && !inside; i++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		now += 500;
		paint();
		expect(inside).toBe("demo/station0");
		expect(roomDraws).toBe(1);
		const ringBefore = ringDraws;
		stage.update({
			...input,
			model: {
				...input.model,
				visitors: [
					{
						visit_id: "demo:sign",
						kind: "sign",
						carry: "folder",
						repo_id: "demo/station0",
						created_at: new Date(now).toISOString(),
					},
				],
			},
			interiorCommand: { serial: 1, index: 0 },
		});
		expect(inside).toBeNull();
		paint();
		expect(ringDraws).toBe(ringBefore + 1);
		expect(roomDraws).toBe(1);
		stage.update({ ...input, interiorCommand: { serial: 2, index: 0 } });
		for (let i = 0; i < 50 && !inside; i++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		now += 500;
		paint();
		expect(inside).toBe("demo/station0");
		stage.update({
			...input,
			model: { ...input.model, still: true },
			interiorCommand: { serial: 2, index: 0 },
		});
		expect(inside).toBeNull();
		paint();
		// A load requested immediately before disposal cannot recreate a room later.
		stage.update({ ...input, interiorCommand: { serial: 3, index: 0 } });
		stage.dispose();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(inside).toBeNull();
		expect(nodes.size).toBe(0);
		expect(reg.size).toBe(0);
		expect(reg.errors).toEqual([]);
	} finally {
		stage.dispose();
		Date.now = realNow;
	}
});
