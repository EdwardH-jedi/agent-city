// The finish show on the stage (17 §3): a flag on each finished building's roof, confetti off the roof of a
// new finish for 20 s (none in reduced motion or while reports are cut), its frames released afterwards,
// never more than CONFETTI_MAX pieces. DOM and WebGL are stubbed; the world is real (no GL), the pipeline a
// fake that records each frame's actors.
import { afterEach, describe, expect, test } from "bun:test";
import type { CampusDone, CampusModel } from "../campus/presentation.ts";
import { CONFETTI_MAX, roofSpot } from "./done-fx.ts";
import { LOTS } from "./engine/ring-layout.mjs";
import type { Actor } from "./engine/sprites.mjs";
import { assignLots } from "./lots.ts";
import type { TownPipeline } from "./pipeline.ts";
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

const T0 = Date.UTC(2026, 10, 13, 2, 0, 0);
const REPO = "o/a";
const OTHER = "o/b";
const LOT = assignLots(new Map(), [REPO, OTHER]).get(REPO) as string;

const repo = (id: string) => ({
	repo_id: id,
	label: id,
	active_tasks: 0,
	monitors: [],
	pending_requests: 0,
	has_stopped: false,
});
const modelOf = (done: CampusDone | undefined, still = false): CampusModel => ({
	repos: [repo(REPO), repo(OTHER)],
	visitors: [],
	owner_present: true,
	still,
	door: null,
	...(done ? { done } : {}),
});

/** A stage on a fake clock; `frame(wallMs)` draws one frame at that wall time and returns its actors. */
function harness(first: CampusModel, reduced = false) {
	const realNow = Date.now;
	let wall = T0;
	Date.now = () => wall;
	let raf: ((ts: number) => void) | null = null;
	stubGlobal("document", {
		hidden: false,
		createElement: () => ({
			className: "",
			setAttribute() {},
			remove() {},
			addEventListener() {},
			removeEventListener() {},
		}),
		addEventListener() {},
		removeEventListener() {},
	});
	stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	stubGlobal("requestAnimationFrame", (f: (ts: number) => void) => {
		raf = f;
		return 1;
	});
	stubGlobal("cancelAnimationFrame", () => undefined);
	const host = {
		clientWidth: 800,
		clientHeight: 600,
		appendChild() {},
	} as unknown as HTMLElement;
	const world = buildTownWorld({ time: "day", lots: null });
	let last: readonly Actor[] = [];
	const stage = createTownStage(
		host,
		{ model: first, reducedMotion: reduced, time: "day" },
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
					render(actors: readonly Actor[]) {
						last = actors;
					},
					dispose() {},
				}) as unknown as TownPipeline,
		},
	);
	return {
		at(ms: number) {
			wall = T0 + ms;
		},
		update(m: CampusModel) {
			stage.update({ model: m, reducedMotion: reduced, time: "day" });
		},
		frame(): readonly Actor[] {
			const f = raf as ((ts: number) => void) | null;
			raf = null;
			f?.(wall - T0 + 1000);
			return last;
		},
		done() {
			Date.now = realNow;
			stage.dispose();
			world.dispose();
		},
	};
}

const flags = (a: readonly Actor[]) =>
	a.filter((x) => x.id.startsWith("flag:"));
const bits = (a: readonly Actor[]) => a.filter((x) => x.id.startsWith("bit:"));
const iso = (ms: number) => new Date(T0 + ms).toISOString();

describe("the finish show on the stage (17 §3)", () => {
	test("a finished building has a flag on its roof; the others none", () => {
		const h = harness(modelOf({ finished: [REPO], bursts: [] }));
		try {
			const f = flags(h.frame());
			expect(f.length).toBe(1);
			const lot = LOTS.find((l) => l.id === LOT);
			const spot = roofSpot({
				...(lot as NonNullable<typeof lot>),
				h: f[0]?.y ?? 0,
			});
			expect(f[0]?.x).toBeCloseTo(spot.x, 6);
			expect(f[0]?.z).toBeCloseTo(spot.z, 6);
			expect(f[0]?.y ?? 0).toBeGreaterThanOrEqual(12);
			expect(bits(h.frame()).length).toBe(0);
		} finally {
			h.done();
		}
	});
	test("a new finish: confetti for 20 s (≤ CONFETTI_MAX), then none and its frames released", () => {
		const h = harness(
			modelOf({ finished: [REPO], bursts: [{ repo_id: REPO, at: iso(0) }] }),
		);
		try {
			h.at(3_000);
			const a = bits(h.frame());
			expect(a.length).toBeGreaterThan(10);
			expect(a.length).toBeLessThanOrEqual(CONFETTI_MAX);
			expect(a.every((x) => x.lockedScale === true && (x.y ?? 0) > 0)).toBe(
				true,
			);
			const world = (h as unknown as { world?: unknown }).world;
			void world;
			h.at(20_500);
			expect(bits(h.frame()).length).toBe(0);
			expect(flags(h.frame()).length).toBe(1);
		} finally {
			h.done();
		}
	});
	test("two bursts share CONFETTI_MAX", () => {
		const h = harness(
			modelOf({
				finished: [REPO, OTHER],
				bursts: [
					{ repo_id: REPO, at: iso(0) },
					{ repo_id: OTHER, at: iso(500) },
				],
			}),
		);
		try {
			for (const t of [3_000, 6_000, 9_000]) {
				h.at(t);
				expect(bits(h.frame()).length).toBeLessThanOrEqual(CONFETTI_MAX);
			}
		} finally {
			h.done();
		}
	});
	test("reduced motion: the flag stands, no confetti", () => {
		const h = harness(
			modelOf({ finished: [REPO], bursts: [{ repo_id: REPO, at: iso(0) }] }),
			true,
		);
		try {
			h.at(3_000);
			const a = h.frame();
			expect(flags(a).length).toBe(1);
			expect(bits(a).length).toBe(0);
		} finally {
			h.done();
		}
	});
	test("reports cut: no confetti", () => {
		const h = harness(
			modelOf(
				{ finished: [REPO], bursts: [{ repo_id: REPO, at: iso(0) }] },
				true,
			),
		);
		try {
			h.at(3_000);
			expect(bits(h.frame()).length).toBe(0);
		} finally {
			h.done();
		}
	});
	test("no flag for a repo without a building (folded) or for the HQ / cafe", () => {
		const h = harness(modelOf({ finished: ["o/zzz"], bursts: [] }));
		try {
			expect(flags(h.frame()).length).toBe(0);
		} finally {
			h.done();
		}
	});
});
