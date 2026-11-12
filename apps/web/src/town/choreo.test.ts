// Doc 12 §5 choreography, pure: lead paths (start, mid, arrival, return), the shorter way round, the
// queue, the kangaroo's patrol → HQ → patrol, still freeze / resume, reduced motion, reload
// determinism, and the HQ shot's framing.
import { describe, expect, test } from "bun:test";
import { PerspectiveCamera, Vector3 } from "three";
import {
	reconcileVisits,
	type SceneClock,
	START_CLOCK,
	sceneNow,
	setStill,
	type Visit,
	type VisitBook,
	visitProgress,
} from "../campus/visits.ts";
import {
	arrivesAt,
	assignSpots,
	CAM_BLEND_MS,
	DOOR_SPOT,
	followRig,
	HQ_HOLD_MS,
	HQ_LOT,
	HQ_SHOT,
	HQ_STAND,
	hqSpot,
	initialRoo,
	LANE,
	leadPath,
	leadPose,
	PLAZA_SHOT,
	patrolAt,
	QUEUE_GAP,
	type RooState,
	rooPose,
	SHUFFLE_SPEED,
	shorterArc,
	shufflePos,
	stepKangaroo,
} from "./choreo.ts";
import {
	arcTable,
	doorOf,
	ellipseNormal,
	ellipseOffset,
	LOTS,
	offsetPoint,
	PROPS,
	PYLON,
} from "./engine/ring-layout.mjs";
import { ENTRY_THETA } from "./patrol.ts";
import { buildTownWorld } from "./world.ts";

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) =>
	Math.hypot(a.x - b.x, a.z - b.z);

const visit = (o: Partial<Visit> = {}): Visit => ({
	visit_id: "m:r1",
	carry: "folder",
	repo_id: "o/a",
	seat: 0,
	seen_at: 0,
	head_start_ms: 0,
	left_at: null,
	left_from: 0,
	...o,
});
const book = (...v: Visit[]): VisitBook => ({ visits: v });
const WALK = 10_000;
const walkMsOf = () => WALK;

describe("lead paths", () => {
	test("start at the lot door, walk the lane, end at the spot; return walks it backwards", () => {
		const p = leadPath("engineering", "sign", 0);
		const d = doorOf("engineering");
		const v = visit();
		const start = leadPose(v, p, 0, false);
		expect(dist(start, d)).toBeLessThan(1e-9);
		expect(start.moving).toBe(false);
		const mid = leadPose(v, p, 0.5, false);
		expect(mid.moving).toBe(true);
		expect(Math.abs(ellipseOffset(mid.x, mid.z) - LANE)).toBeLessThan(0.05);
		const end = leadPose(v, p, 1, false);
		expect(dist(end, hqSpot("sign", 0))).toBeLessThan(1e-9);
		expect(end.moving).toBe(false);
		// arrived: faces the HQ door (outward)
		const hq = doorOf(HQ_LOT);
		expect(end.dir[0] * hq.nx + end.dir[1] * hq.nz).toBeGreaterThan(0.99);
		// returning: same point, opposite direction
		const back = leadPose(visit({ left_at: 1 }), p, 0.5, false);
		expect(dist(back, mid)).toBeLessThan(1e-9);
		expect(back.dir[0] * mid.dir[0] + back.dir[1] * mid.dir[1]).toBeLessThan(
			-0.99,
		);
	});

	test("the shorter way round, from every lot", () => {
		const lane = arcTable(LANE);
		for (const L of LOTS) {
			if (L.id === HQ_LOT) continue;
			const p = leadPath(L.id, "sign", 0);
			expect(p.length).toBeLessThan(lane.length / 2 + 8);
			const arc = shorterArc(lane, L.theta, hqSpot("sign", 0).theta);
			expect(Math.abs(arc)).toBeLessThanOrEqual(lane.length / 2 + 1e-9);
		}
		// lots just clockwise of the HQ walk anticlockwise to it, and the other way round
		expect(
			shorterArc(lane, 252 * (Math.PI / 180), 216 * (Math.PI / 180)),
		).toBeLessThan(0);
		expect(
			shorterArc(lane, 180 * (Math.PI / 180), 216 * (Math.PI / 180)),
		).toBeGreaterThan(0);
	});

	test("a folded building's lead walks in from the lane point opposite the HQ", () => {
		const p = leadPath(null, "report", 0);
		const first = p.pts[0] ?? { x: 0, z: 0 };
		expect(Math.abs(ellipseOffset(first.x, first.z) - LANE)).toBeLessThan(0.01);
		expect(dist(first, doorOf(HQ_LOT))).toBeGreaterThan(30);
	});
});

describe("the queue at the HQ door", () => {
	test("first on the door mat, the rest QUEUE_GAP apart along the lane; reports beside the door, apart from it", () => {
		const s0 = hqSpot("sign", 0);
		expect(Math.abs(ellipseOffset(s0.x, s0.z) - DOOR_SPOT)).toBeLessThan(0.01);
		for (let k = 1; k < 6; k += 1) {
			const a = hqSpot("sign", k);
			const b = hqSpot("sign", k + 1);
			expect(dist(a, b)).toBeGreaterThan(QUEUE_GAP * 0.95);
			expect(dist(a, b)).toBeLessThan(QUEUE_GAP * 1.05);
		}
		const signs = Array.from({ length: 6 }, (_, k) => hqSpot("sign", k));
		for (let j = 0; j < 4; j += 1) {
			const r = hqSpot("report", j);
			for (const s of signs) expect(dist(r, s)).toBeGreaterThan(0.8);
		}
	});

	test("order follows the model: spot k is k places from the door", () => {
		const door = doorOf(HQ_LOT);
		const d = [0, 1, 2, 3].map((k) => dist(hqSpot("sign", k), door));
		expect([...d].sort((a, b) => a - b)).toEqual(d);
	});
});

// A tiny driver for the kangaroo's state machine: visits appear at `seen`, end at `left` (if any) and are
// gone once their lead is home again; the machine is stepped every `step` ms like the stage does.
interface Ev {
	id: string;
	carry: "folder" | "binder" | null;
	seen: number;
	left?: number;
}
function bookAt(evs: readonly Ev[], t: number): VisitBook {
	const visits: Visit[] = [];
	for (const e of evs) {
		if (t < e.seen) continue;
		const left = e.left !== undefined && t >= e.left ? e.left : null;
		if (left !== null) {
			const from = Math.min(1, (left - e.seen) / WALK);
			if (t - left >= from * WALK) continue; // home again
			visits.push(
				visit({
					visit_id: e.id,
					carry: e.carry,
					seen_at: e.seen,
					left_at: left,
					left_from: from,
				}),
			);
		} else
			visits.push(visit({ visit_id: e.id, carry: e.carry, seen_at: e.seen }));
	}
	return { visits };
}
function run(evs: readonly Ev[], t0: number, t1: number, step = 16) {
	let st: RooState | null = null;
	let last = t0;
	const out: { t: number; st: RooState; pose: ReturnType<typeof rooPose> }[] =
		[];
	for (let t = t0; t <= t1; t += step) {
		const input = {
			now: t,
			book: bookAt(evs, t),
			walkMsOf,
			reducedMotion: false,
		};
		st = st ? stepKangaroo(st, input, t - last) : initialRoo(input);
		last = t;
		out.push({ t, st, pose: rooPose(st, t) });
	}
	return out;
}
/** Largest move between two consecutive steps. */
const maxStep = (r: ReturnType<typeof run>) => {
	let m = 0;
	for (let i = 1; i < r.length; i += 1) {
		const a = r[i - 1]?.pose;
		const b = r[i]?.pose;
		if (a && b) m = Math.max(m, dist(a, b));
	}
	return m;
};
/** A sprint step at 60 Hz (7.2 u/s, the original's sprint) — no normal move may exceed it. */
const SPRINT_STEP = 7.2 * 0.016 + 1e-6;

describe("the kangaroo", () => {
	test("patrols until a 결재 lead has arrived, walks there from where it is, stands; the camera blends in", () => {
		const r = run([{ id: "A", carry: "folder", seen: 0 }], 0, 80_000);
		const at = (t: number) => r.find((x) => x.t >= t) ?? r[r.length - 1];
		expect(at(5_000)?.st.mode).toBe("patrol");
		expect(
			dist(at(5_000)?.pose ?? { x: 0, z: 0 }, patrolAt(at(5_000)?.t ?? 0)),
		).toBeLessThan(1e-9);
		expect(at(WALK + 100)?.st.mode).toBe("to-hq");
		const end = r[r.length - 1];
		expect(end?.st.mode).toBe("at-hq");
		expect(end?.pose.cam).toBe(1);
		expect(end?.pose.moving).toBe(false);
		expect(dist(end?.pose ?? { x: 0, z: 0 }, HQ_STAND)).toBeLessThan(1e-9);
		expect(maxStep(r)).toBeLessThanOrEqual(SPRINT_STEP);
		// the camera blend moves by at most one step's worth per frame
		for (let i = 1; i < r.length; i += 1)
			expect(
				Math.abs((r[i]?.pose.cam ?? 0) - (r[i - 1]?.pose.cam ?? 0)),
			).toBeLessThanOrEqual(16 / CAM_BLEND_MS + 1e-9);
	});

	test("the near way: never more than half the ring to the HQ", () => {
		const centre = arcTable(0);
		for (let s = 0; s < 240; s += 30) {
			const r = run(
				[{ id: "A", carry: "folder", seen: s * 1000 }],
				s * 1000,
				s * 1000 + 60_000,
				100,
			);
			const going = r
				.filter((x) => x.st.mode === "to-hq")
				.map((x) => x.pose.walked);
			expect(Math.max(0, ...going)).toBeLessThan(centre.length / 2 + 3);
		}
	});

	test("when the 결재 ends it walks back onto the line at walking speed and the patrol carries on from there", () => {
		const r = run(
			[{ id: "A", carry: "folder", seen: 0, left: 60_000 }],
			0,
			90_000,
		);
		const back = r.filter((x) => x.st.mode === "back");
		expect(back.length).toBeGreaterThan(0);
		const after = r.filter((x) => x.t > 60_000 && x.st.mode === "patrol");
		expect(after.length).toBeGreaterThan(0);
		expect(maxStep(r)).toBeLessThanOrEqual(SPRINT_STEP);
		// the HQ is in the quarter the plaza stretch cuts (16 A2): it walks the centre line to the nearer end
		// of that quarter (θ = 180°, no chase round the ring) and the patrol carries on from there into the
		// plaza; the camera follows again
		const first = after[0];
		expect(
			dist(first?.pose ?? { x: 0, z: 0 }, offsetPoint(ENTRY_THETA, 0)),
		).toBeLessThan(0.5);
		expect(r[r.length - 1]?.pose.cam).toBe(0);
	});

	test("one 결재 that is never resolved: HQ_HOLD_MS at the HQ after its lead arrives, then patrol only (20 min)", () => {
		const r = run([{ id: "A", carry: "folder", seen: 0 }], 0, 20 * 60_000, 50);
		const at = (t: number) => r.find((x) => x.t >= t) ?? r[r.length - 1];
		expect(at(WALK + 60_000)?.st.mode).toBe("at-hq");
		expect(at(WALK + HQ_HOLD_MS - 2_000)?.st.mode).toBe("at-hq");
		// after the hold it leaves, and never comes back for the same lead
		const after = r.filter((x) => x.t > WALK + HQ_HOLD_MS + 30_000);
		expect(after.every((x) => x.st.mode === "patrol")).toBe(true);
		expect(after.every((x) => x.pose.cam === 0)).toBe(true);
		// one stay only: to-hq / at-hq never start again
		const modes = r.map((x) => x.st.mode).filter((m, i, a) => m !== a[i - 1]);
		expect(modes.filter((m) => m === "at-hq").length).toBe(1);
		expect(maxStep(r)).toBeLessThanOrEqual(SPRINT_STEP * (50 / 16) + 1e-6);
	});

	test("a new 결재 later brings it back for another HQ_HOLD_MS from that lead's arrival", () => {
		const second = 10 * 60_000;
		const r = run(
			[
				{ id: "A", carry: "folder", seen: 0 },
				{ id: "B", carry: "binder", seen: second },
			],
			0,
			25 * 60_000,
			50,
		);
		const at = (t: number) => r.find((x) => x.t >= t) ?? r[r.length - 1];
		expect(at(second - 1_000)?.st.mode).toBe("patrol");
		expect(at(second + WALK + 30_000)?.st.mode).toBe("at-hq");
		expect(at(second + WALK + HQ_HOLD_MS - 2_000)?.st.mode).toBe("at-hq");
		expect(at(second + WALK + HQ_HOLD_MS + 60_000)?.st.mode).toBe("patrol");
		// leaving the patrol for B walks from where it is (A's long-past arrival is not the anchor)
		const near = run(
			[
				{ id: "A", carry: "folder", seen: 0 },
				{ id: "B", carry: "binder", seen: second },
			],
			second - 2_000,
			second + WALK + 30_000,
			16,
		);
		expect(maxStep(near)).toBeLessThanOrEqual(SPRINT_STEP);
	});

	test("a 보고 lead that becomes a 결재 in place: the five minutes count from that moment, and it walks there", () => {
		const F = 180_000; // the report arrived at WALK; the 결재 came 3 minutes later, same visit id
		let st: RooState | null = null;
		let last = 0;
		const out: { t: number; mode: string; pose: ReturnType<typeof rooPose> }[] =
			[];
		for (let t = 0; t <= F + HQ_HOLD_MS + 60_000; t += 16) {
			const v = visit({ carry: t < F ? null : "folder" });
			const input = {
				now: t,
				book: book(v),
				walkMsOf,
				signedAtOf: () => (t < F ? Number.NEGATIVE_INFINITY : F),
				reducedMotion: false,
			};
			st = st ? stepKangaroo(st, input, t - last) : initialRoo(input);
			last = t;
			out.push({ t, mode: st.mode, pose: rooPose(st, t) });
		}
		const at = (t: number) => out.find((x) => x.t >= t) ?? out[out.length - 1];
		expect(at(F - 1_000)?.mode).toBe("patrol");
		expect(at(F + 60_000)?.mode).toBe("at-hq");
		expect(at(F + HQ_HOLD_MS - 2_000)?.mode).toBe("at-hq");
		expect(at(F + HQ_HOLD_MS + 40_000)?.mode).toBe("patrol");
		let m = 0;
		for (let i = 1; i < out.length; i += 1) {
			const a = out[i - 1]?.pose;
			const b = out[i]?.pose;
			if (a && b) m = Math.max(m, dist(a, b));
		}
		expect(m).toBeLessThanOrEqual(SPRINT_STEP);
	});

	test("reports never bring it out", () => {
		const r = run([{ id: "R", carry: null, seen: 0 }], 0, 60_000, 200);
		expect(r.every((x) => x.st.mode === "patrol")).toBe(true);
	});

	test("no jump in any sequence: overlapping, resolving and new 결재 visits at random times", () => {
		let seed = 7;
		const rnd = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		for (let trial = 0; trial < 40; trial += 1) {
			const evs: Ev[] = [];
			const n = 1 + Math.floor(rnd() * 4);
			for (let i = 0; i < n; i += 1) {
				const seen = Math.floor(rnd() * 60_000);
				const left =
					rnd() < 0.8 ? seen + Math.floor(rnd() * 50_000) : undefined;
				evs.push({
					id: `v${i}`,
					carry: rnd() < 0.8 ? "folder" : null,
					seen,
					...(left !== undefined ? { left } : {}),
				});
			}
			const r = run(evs, 0, 140_000, 16);
			expect({ trial, step: maxStep(r) <= SPRINT_STEP }).toEqual({
				trial,
				step: true,
			});
		}
	});

	test("the reviewer's cases: the first 결재 resolves while a second is on its way / just arrived", () => {
		for (const evs of [
			[
				{ id: "A", carry: "folder" as const, seen: 0, left: 65_000 },
				{ id: "B", carry: "folder" as const, seen: 60_000 },
			],
			[
				{ id: "A", carry: "folder" as const, seen: 0, left: 51_000 },
				{ id: "B", carry: "folder" as const, seen: 40_000 },
			],
		]) {
			const r = run(evs, 0, 120_000);
			expect(maxStep(r)).toBeLessThanOrEqual(SPRINT_STEP);
			expect(r[r.length - 1]?.st.mode).toBe("at-hq");
		}
	});

	test("reduced motion: standing at the HQ, the HQ shot, no walking", () => {
		const input = { now: 123, book: book(), walkMsOf, reducedMotion: true };
		const st = initialRoo(input);
		expect(rooPose(st, 123)).toMatchObject({
			phase: "at-hq",
			cam: 1,
			moving: false,
		});
		expect(stepKangaroo(st, input, 16).mode).toBe("at-hq");
		expect(visitProgress(visit({ seen_at: 0 }), 0, WALK, true)).toBe(1);
	});

	test("a 결재 that arrived 2 minutes ago, only in the 2nd model (data loading): at the HQ at once, HQ shot, no walk", () => {
		let st = initialRoo({
			now: 1_000,
			book: book(),
			walkMsOf,
			reducedMotion: false,
		});
		expect(st.mode).toBe("patrol");
		// began 2 min 10 s ago: head start clamped to 60 s, the other 70 s are `late`
		const v = visit({ seen_at: 1_200, head_start_ms: 60_000 });
		const input = {
			now: 1_200,
			book: book(v),
			walkMsOf,
			lateMsOf: () => 70_000,
			reducedMotion: false,
		};
		st = stepKangaroo(st, input, 200);
		expect(st).toMatchObject({ mode: "at-hq", cam: 1 });
		expect(dist(rooPose(st, 1_200), HQ_STAND)).toBeLessThan(1e-9);
	});

	test("a 결재 that has waited for hours: the patrol goes on (no HQ shot on every reload); its lead stays", () => {
		const v = visit({ seen_at: 1_200, head_start_ms: 60_000 });
		const input = {
			now: 1_200,
			book: book(v),
			walkMsOf,
			lateMsOf: () => 2 * 3600_000,
			reducedMotion: false,
		};
		const st = initialRoo(input);
		expect(st).toMatchObject({ mode: "patrol", cam: 0 });
		expect(stepKangaroo(st, { ...input, now: 1_216 }, 16).mode).toBe("patrol");
		// the lead itself is at the door all along (the book is untouched)
		expect(visitProgress(v, 1_216, WALK, false)).toBe(1);
	});

	test("a 결재 that arrived a moment before the page opened: the walk is already under way, not restarted", () => {
		const v = visit({ seen_at: 10_000, head_start_ms: WALK + 2_000 }); // arrived 2 s before 10 s
		const st = initialRoo({
			now: 10_000,
			book: book(v),
			walkMsOf,
			reducedMotion: false,
		});
		expect(st.mode).toBe("to-hq");
		const p = rooPose(st, 10_000);
		expect(p.walked).toBeCloseTo(2 * 4.2, 6);
	});

	test("opened while a 결재 lead is already at the HQ: it starts there (no replay)", () => {
		const input = {
			now: 50_000,
			book: book(visit()),
			walkMsOf,
			reducedMotion: false,
		};
		const st = initialRoo(input);
		expect(st).toMatchObject({ mode: "at-hq", cam: 1 });
	});
});

describe("still and reload", () => {
	test("still: the scene clock stands, so every pose holds; on resume it continues from there", () => {
		let c: SceneClock = START_CLOCK;
		const b = book(visit());
		let st: RooState = initialRoo({
			now: 0,
			book: b,
			walkMsOf,
			reducedMotion: false,
		});
		let last = 0;
		const step = (wall: number) => {
			const now = sceneNow(c, wall);
			st = stepKangaroo(
				st,
				{ now, book: b, walkMsOf, reducedMotion: false },
				now - last,
			);
			last = now;
			return rooPose(st, now);
		};
		for (let w = 0; w <= 15_000; w += 16) step(w);
		c = setStill(c, true, 15_000);
		const frozen = step(15_000);
		expect(step(50_000)).toEqual(frozen);
		expect(step(90_000)).toEqual(frozen);
		const lead = (wall: number) =>
			leadPose(
				visit(),
				leadPath("qa", "sign", 0),
				visitProgress(visit(), sceneNow(c, wall), WALK, false),
				false,
			);
		const l0 = lead(15_000);
		expect(lead(90_000)).toEqual(l0);
		c = setStill(c, false, 90_000);
		expect(dist(step(90_000), frozen)).toBeLessThan(1e-9);
		expect(dist(lead(90_000), l0)).toBeLessThan(1e-9);
	});

	test("reload: the same visitor at the same time gives the same lead pose, whenever the page was opened", () => {
		const visitor = {
			visit_id: "m:r9",
			carry: "folder" as const,
			repo_id: "o/a",
			created_at: new Date(1_000_000).toISOString(),
			kind: "sign" as const,
		};
		const at = 1_000_000 + 4_000; // mid-walk
		const opened = (mount: number) =>
			reconcileVisits({ visits: [] }, [visitor], mount, () => WALK);
		const va = opened(1_000_500).visits[0] as Visit;
		const vb = opened(1_003_000).visits[0] as Visit;
		expect(visitProgress(va, at, WALK, false)).toBeCloseTo(
			visitProgress(vb, at, WALK, false),
			9,
		);
		expect(arrivesAt(va, WALK)).toBe(arrivesAt(vb, WALK));
		const old = reconcileVisits(
			{ visits: [] },
			[{ ...visitor, created_at: new Date(0).toISOString() }],
			at,
			() => WALK,
		);
		expect(visitProgress(old.visits[0] as Visit, at, WALK, false)).toBe(1);
		expect(patrolAt(77_777)).toEqual(patrolAt(77_777));
		expect(dist(patrolAt(0), patrolAt(240_000))).toBeLessThan(1e-6);
	});
});

describe("the queue: spots", () => {
	test("model order; a spot still held by a leaving lead is skipped until it is free", () => {
		expect([...assignSpots(["a", "b", "c"], new Set())]).toEqual([
			["a", 0],
			["b", 1],
			["c", 2],
		]);
		expect([...assignSpots(["b", "c"], new Set([0]))]).toEqual([
			["b", 1],
			["c", 2],
		]);
		expect([...assignSpots(["b", "c"], new Set())]).toEqual([
			["b", 0],
			["c", 1],
		]);
	});

	test("stepping up walks there at SHUFFLE_SPEED (no snap)", () => {
		const from = hqSpot("sign", 1);
		const sh = { from: { x: from.x, z: from.z }, toK: 0, t0: 0 };
		const d = dist(from, hqSpot("sign", 0));
		const a = shufflePos("sign", sh, 0);
		expect(dist(a, from)).toBeLessThan(1e-9);
		expect(a.done).toBe(false);
		const mid = shufflePos("sign", sh, (d / 2 / SHUFFLE_SPEED) * 1000);
		expect(dist(mid, from)).toBeCloseTo(d / 2, 6);
		const end = shufflePos("sign", sh, ((d + 0.1) / SHUFFLE_SPEED) * 1000);
		expect(end.done).toBe(true);
		expect(dist(end, hqSpot("sign", 0))).toBeLessThan(1e-9);
	});
});

describe("the orbit rig after a pause", () => {
	test("a long frame gap or a jump snaps it: it looks along the patrol at once", () => {
		const world = buildTownWorld({ time: "day", lots: null });
		const rig = world.rig;
		let t = 0;
		for (let i = 0; i < 10; i += 1, t += 16)
			followRig(rig, patrolAt(t), i ? 16 : Number.POSITIVE_INFINITY, 0.016);
		t = 120_000; // the tab was hidden for two minutes
		const p = patrolAt(t);
		expect(followRig(rig, p, 120_000, 0)).toBe("snap");
		const off = ((((rig.yawDeg - rig.yawFor(p)) % 360) + 540) % 360) - 180;
		expect(Math.abs(off)).toBeLessThan(1);
		expect(followRig(rig, patrolAt(t + 16), 16, 0.016)).toBe("follow");
		world.dispose();
	});
});

describe("the HQ shot (a 결재 lead at the door)", () => {
	// the stage's render target is 288 rows high and 320–384 wide (pipeline.ts fitStage)
	const camAt = (shot: typeof HQ_SHOT, rtW: number) => {
		const cam = new PerspectiveCamera(54, rtW / 288, 0.5, 200);
		cam.position.set(shot.position.x, shot.position.y, shot.position.z);
		cam.lookAt(shot.lookAt.x, shot.lookAt.y, shot.lookAt.z);
		cam.updateMatrixWorld(true);
		return (x: number, y: number, z: number) =>
			new Vector3(x, y, z).project(cam);
	};
	const inside = (v: Vector3, m = 0.95) =>
		Math.abs(v.x) <= m && Math.abs(v.y) <= m && v.z < 1;
	/** Rows a 2.4-unit lead takes on the 288-row target. */
	const rows = (ndc: ReturnType<typeof camAt>, s: { x: number; z: number }) =>
		(ndc(s.x, 2.4, s.z).y - ndc(s.x, 0, s.z).y) * 144;

	test.each([384, 373, 320])(
		"at a %i × 288 target: door, sign, kangaroo and four queue spots in frame; a lead is 40+ rows tall (a desk away); the queue spreads across",
		(rtW) => {
			const ndc = camAt(HQ_SHOT, rtW);
			const door = doorOf(HQ_LOT);
			expect(inside(ndc(door.x, 0, door.z))).toBe(true);
			expect(inside(ndc(door.x, 5, door.z))).toBe(true); // the HQ sign over the door
			expect(inside(ndc(HQ_STAND.x, 0, HQ_STAND.z))).toBe(true);
			const xs: number[] = [];
			for (let k = 0; k < 4; k += 1) {
				const s = hqSpot("sign", k);
				expect(inside(ndc(s.x, 0, s.z))).toBe(true);
				expect(inside(ndc(s.x, 2.4, s.z))).toBe(true);
				expect(rows(ndc, s)).toBeGreaterThan(40);
				xs.push((ndc(s.x, 0, s.z).x * rtW) / 2);
			}
			for (let k = 1; k < 4; k += 1)
				expect(
					Math.abs((xs[k] ?? 0) - (xs[k - 1] ?? 0)),
				).toBeGreaterThanOrEqual(10);
			// several times the old wide shot, which kept the whole pylon in view
			const old = camAt(PLAZA_SHOT, rtW);
			expect(rows(ndc, hqSpot("sign", 0))).toBeGreaterThan(
				3 * rows(old, hqSpot("sign", 0)),
			);
		},
	);

	test("every figure in the queue and the first two reports: whole sprite in frame, in front of the facade, no tree in front", () => {
		// people are camera-facing quads that lean back with the camera's pitch: test the leaning quad
		const cam = new PerspectiveCamera(54, 320 / 288, 0.5, 200);
		const { position: p, lookAt: l } = HQ_SHOT;
		cam.position.set(p.x, p.y, p.z);
		cam.lookAt(l.x, l.y, l.z);
		cam.updateMatrixWorld(true);
		const up = new Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
		const right = new Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
		const hq = LOTS.find((x) => x.id === HQ_LOT);
		const n = ellipseNormal(hq?.theta ?? 0);
		const wall = offsetPoint(hq?.theta ?? 0, 4.5); // the facade line (OUTER_EDGE)
		const trees = PROPS.filter((o) => o.kind === "tree");
		const figures = [
			...[0, 1, 2, 3].map((k) => hqSpot("sign", k)),
			...[0, 1].map((k) => hqSpot("report", k)),
		];
		for (const s of figures) {
			// the body's corners up to the shoulders, the head on the centre line (the quad's edges are clear)
			for (const [h, w] of [
				[0, -0.5],
				[0, 0.5],
				[1.2, -0.5],
				[1.2, 0.5],
				[2.4, 0],
			] as const) {
				const pt = new Vector3(
					s.x + up.x * h + right.x * w,
					up.y * h,
					s.z + up.z * h + right.z * w,
				);
				const v = pt.clone().project(cam);
				expect(Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1).toBe(true);
				// in front of the facade (outward normal n points into the building)
				const into = (pt.x - wall.x) * n.x + (pt.z - wall.z) * n.z;
				expect(into).toBeLessThan(-0.1);
				// no tree canopy or trunk on the line of sight (until 0.6 short of the figure)
				const len = pt.distanceTo(cam.position);
				for (let i = 1; i < 60; i += 1) {
					const f = i / 60;
					if (f * len > len - 0.6) break;
					const q = cam.position.clone().lerp(pt, f);
					for (const o of trees) {
						const d = Math.hypot(q.x - o.x, q.z - o.z);
						const hit =
							(q.y > 1.9 && q.y < 4.4 && d < 1.25) || (q.y <= 1.9 && d < 0.3);
						expect({ s, h, tree: o.id, hit }).toEqual({
							s,
							h,
							tree: o.id,
							hit: false,
						});
					}
				}
			}
		}
	});
});

describe("the reduced-motion plaza shot", () => {
	test.each([384, 373, 320])(
		"at a %i × 288 target: frames the HQ door, the first four queue spots and the whole pylon, with the pylon clear of the door",
		(rtW) => {
			const cam = new PerspectiveCamera(54, rtW / 288, 0.5, 200);
			const { position: p, lookAt: l } = PLAZA_SHOT;
			cam.position.set(p.x, p.y, p.z);
			cam.lookAt(l.x, l.y, l.z);
			cam.updateMatrixWorld(true);
			const ndc = (x: number, y: number, z: number) =>
				new Vector3(x, y, z).project(cam);
			const inside = (v: Vector3, m = 0.95) =>
				Math.abs(v.x) <= m && Math.abs(v.y) <= m && v.z < 1;
			const door = doorOf(HQ_LOT);
			expect(inside(ndc(door.x, 0, door.z))).toBe(true);
			expect(inside(ndc(door.x, 3, door.z))).toBe(true);
			for (let k = 0; k < 4; k += 1) {
				const s = hqSpot("sign", k);
				expect(inside(ndc(s.x, 0, s.z))).toBe(true);
				expect(inside(ndc(s.x, 2.4, s.z))).toBe(true);
			}
			const top = ndc(PYLON.x, PYLON.h, PYLON.z);
			const bottom = ndc(PYLON.x, 0, PYLON.z);
			expect(inside(top)).toBe(true);
			expect(inside(bottom)).toBe(true);
			// the pylon's corners too (its faces are what it is for), at least just inside the frame
			for (const dx of [-PYLON.w / 2, PYLON.w / 2])
				for (const dz of [-PYLON.d / 2, PYLON.d / 2])
					for (const y of [0, PYLON.h])
						expect({
							dx,
							dz,
							y,
							ok: inside(ndc(PYLON.x + dx, y, PYLON.z + dz), 1),
						}).toEqual({ dx, dz, y, ok: true });
			expect(Math.abs(bottom.x - ndc(door.x, 0, door.z).x)).toBeGreaterThan(
				0.5,
			);
		},
	);
});
