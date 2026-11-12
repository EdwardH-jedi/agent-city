// The crew on the stage (16 A1): a member stands at its spot or walks there from its `since`; a reload
// lands it where it was; a new event does not move it; reports stopped hold everyone; reduced motion
// shows them arrived. DOM and WebGL are stubbed; the world is real (no GL), the pipeline a fake that
// records each frame's actors.
import { afterEach, describe, expect, test } from "bun:test";
import type { CampusCrew, CampusModel } from "../campus/presentation.ts";
import { crewSpot, doorPoint } from "./crew-place.ts";
import type { Actor } from "./engine/sprites.mjs";
import { assignLots, CAFE_LOT } from "./lots.ts";
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
const LOT = assignLots(new Map(), [REPO]).get(REPO) as string;

const member = (over: Partial<CampusCrew> = {}): CampusCrew => ({
	id: "claude:s1",
	repo_id: REPO,
	place: "work",
	since: new Date(T0 - 3_600_000).toISOString(),
	started_at: new Date(T0 - 7_200_000).toISOString(),
	provider: "claude",
	family: "opus",
	tag: "OPUS",
	companions: 0,
	...over,
});
const modelOf = (crew: CampusCrew[], still = false): CampusModel => ({
	repos: [
		{
			repo_id: REPO,
			label: "a",
			active_tasks: 1,
			monitors: [],
			pending_requests: 0,
			has_stopped: false,
		},
	],
	visitors: [],
	owner_present: true,
	still,
	door: null,
	crew,
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

const crewActors = (a: readonly Actor[]) =>
	a.filter((x) => x.id.startsWith("crew:"));
const near = (a: Actor | undefined, p: { x: number; z: number }) =>
	!!a && Math.hypot(a.x - p.x, a.z - p.z) < 1e-6;

describe("crew on the stage", () => {
	test("settled long ago: stands at its spot, a tag over it at the same foot", () => {
		const h = harness(modelOf([member()]));
		try {
			const a = h.frame();
			const c = crewActors(a)[0];
			expect(near(c, crewSpot(LOT, 0, false))).toBe(true);
			const tag = a.find((x) => x.id === "tag:0");
			expect(tag?.x).toBe(c?.x as number);
			expect(tag?.z).toBe(c?.z as number);
			expect(tag?.key).toBe("tag|Opus|OPUS");
		} finally {
			h.done();
		}
	});

	test("first seen at work with a recent event but an old session: standing (a reload never replays a walk)", () => {
		const h = harness(
			modelOf([member({ since: new Date(T0 - 2_000).toISOString() })]),
		);
		try {
			expect(near(crewActors(h.frame())[0], crewSpot(LOT, 0, false))).toBe(
				true,
			);
		} finally {
			h.done();
		}
	});

	test("a session that started 2 s ago: walking out of its building's door; a reload shows the same pose", () => {
		const m = modelOf([
			member({
				since: new Date(T0 - 1_000).toISOString(),
				started_at: new Date(T0 - 2_000).toISOString(),
			}),
		]);
		// a reload: a second stage, the same data, the same wall time
		const h2 = harness(m);
		const b = crewActors(h2.frame())[0];
		h2.done();
		const h1 = harness(m);
		try {
			const a = crewActors(h1.frame())[0];
			expect(a?.x).toBeCloseTo(b?.x as number, 9);
			expect(a?.z).toBeCloseTo(b?.z as number, 9);
			const spot = crewSpot(LOT, 0, false);
			const door = doorPoint(LOT);
			expect(near(a, spot)).toBe(false);
			expect(
				Math.hypot((a?.x ?? 0) - door.x, (a?.z ?? 0) - door.z),
			).toBeLessThan(Math.hypot(spot.x - door.x, spot.z - door.z));
			expect((a?.sprite as { action: string } | undefined)?.action).toBe(
				"walk",
			);
			// 30 s later it has arrived
			h1.at(30_000);
			expect(near(crewActors(h1.frame())[0], spot)).toBe(true);
		} finally {
			h1.done();
		}
	});

	test("a new event on a working session (same place, later since) does not move it", () => {
		const h = harness(modelOf([member()]));
		try {
			const before = crewActors(h.frame())[0];
			h.at(5_000);
			h.update(
				modelOf([member({ since: new Date(T0 + 4_000).toISOString() })]),
			);
			const after = crewActors(h.frame())[0];
			expect(after?.x).toBe(before?.x as number);
			expect(after?.z).toBe(before?.z as number);
		} finally {
			h.done();
		}
	});

	test("work → cafe: walks from where it stood, from its since, and arrives at the cafe", () => {
		const h = harness(modelOf([member()]));
		try {
			const start = crewActors(h.frame())[0];
			h.at(10_000);
			h.update(
				modelOf([
					member({ place: "cafe", since: new Date(T0 + 10_000).toISOString() }),
				]),
			);
			const step = crewActors(h.frame())[0];
			// just set off: still at its old spot
			expect(
				Math.hypot(
					(step?.x ?? 0) - (start?.x ?? 0),
					(step?.z ?? 0) - (start?.z ?? 0),
				),
			).toBeLessThan(0.01);
			h.at(14_000);
			const mid = crewActors(h.frame())[0];
			expect(near(mid, crewSpot(CAFE_LOT, 0, false))).toBe(false);
			expect((mid?.sprite as { action: string } | undefined)?.action).toBe(
				"walk",
			);
			h.at(60_000);
			expect(near(crewActors(h.frame())[0], crewSpot(CAFE_LOT, 0, false))).toBe(
				true,
			);
		} finally {
			h.done();
		}
	});

	test("tags over working figures only (not at the door, not at the cafe)", () => {
		const h = harness(
			modelOf([
				member(),
				member({ id: "claude:s3", place: "door" }),
				member({ id: "claude:s4", place: "cafe" }),
			]),
		);
		try {
			expect(
				h
					.frame()
					.filter((x) => x.id.startsWith("tag:"))
					.map((x) => x.id),
			).toEqual(["tag:0"]);
		} finally {
			h.done();
		}
	});

	test("first seen just after it went to rest: walking from its building to the cafe", () => {
		const h = harness(
			modelOf([
				member({ place: "cafe", since: new Date(T0 - 2_000).toISOString() }),
			]),
		);
		try {
			const a = crewActors(h.frame())[0];
			expect(near(a, crewSpot(CAFE_LOT, 0, false))).toBe(false);
			expect((a?.sprite as { action: string } | undefined)?.action).toBe(
				"walk",
			);
		} finally {
			h.done();
		}
	});

	test("reports stopped: everyone holds where they are", () => {
		const walking = member({
			place: "cafe",
			since: new Date(T0 - 2_000).toISOString(),
		});
		const h = harness(modelOf([walking]));
		try {
			const a = crewActors(h.frame())[0];
			h.update(modelOf([walking], true));
			h.at(8_000);
			h.update(modelOf([walking], true));
			// the loop stopped; force one more draw through a model change
			const b = crewActors(h.frame())[0] ?? a;
			expect(b?.x).toBeCloseTo(a?.x as number, 2);
			expect(b?.z).toBeCloseTo(a?.z as number, 2);
		} finally {
			h.done();
		}
	});

	test("a place change while reports stopped lands at once (no figure frozen in the road)", () => {
		const h = harness(modelOf([member()], true));
		try {
			h.frame();
			h.at(5_000);
			h.update(
				modelOf(
					[
						member({
							place: "cafe",
							since: new Date(T0 + 5_000).toISOString(),
						}),
					],
					true,
				),
			);
			expect(near(crewActors(h.frame())[0], crewSpot(CAFE_LOT, 0, false))).toBe(
				true,
			);
		} finally {
			h.done();
		}
	});

	test("reduced motion: already at its spot", () => {
		const h = harness(
			modelOf([
				member({
					place: "cafe",
					since: new Date(T0 - 1_000).toISOString(),
				}),
			]),
			true,
		);
		try {
			expect(near(crewActors(h.frame())[0], crewSpot(CAFE_LOT, 0, false))).toBe(
				true,
			);
		} finally {
			h.done();
		}
	});

	test("companions: small figures beside it; ids per slot so nothing piles up", () => {
		const h = harness(
			modelOf([
				member({ companions: 2 }),
				member({
					id: "codex:s2",
					provider: "codex",
					family: "codex",
					tag: "CODEX",
				}),
			]),
		);
		try {
			const a = h.frame();
			expect(
				a.filter((x) => x.id.startsWith("mate:")).map((x) => x.id),
			).toEqual(["mate:0", "mate:1"]);
			expect(
				a
					.filter((x) => x.id.startsWith("mate:"))
					.every((x) => (x.sprite as { small: boolean }).small),
			).toBe(true);
			expect(crewActors(a).map((x) => x.id)).toEqual(["crew:0", "crew:1"]);
			expect(a.find((x) => x.id === "tag:1")?.key).toBe("tag|Codex|CODEX");
		} finally {
			h.done();
		}
	});
});
