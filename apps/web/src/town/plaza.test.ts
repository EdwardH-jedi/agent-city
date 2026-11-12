// The plaza stretch of the patrol (16 A2), with the real orbit rig (no GL) and the built world's pylon:
// every lap the pylon's title and ALL numbers face the camera, inside the frame and clear of lamps and
// trees, for at least 8 s (at every render-target width the stage uses); on leaving the plaza the camera
// keeps looking the way it walks; a 결재 that comes (or goes) while it is in the plaza never makes it jump
// or cut across the plaza's lamps.
import { afterEach, describe, expect, test } from "bun:test";
import { type Mesh, Vector3 } from "three";
import { EMPTY_BOOK, type Visit } from "../campus/visits.ts";
import {
	followRig,
	initialRoo,
	type KangarooInput,
	rooPose,
	rooToHq,
	rooToRoute,
	stepKangaroo,
} from "./choreo.ts";
import { turnBetween, yawOfDir } from "./engine/orbit-camera.mjs";
import { RT_H, setRenderWidth } from "./engine/pipeline-core.mjs";
import { PROPS } from "./engine/ring-layout.mjs";
import {
	LAP_S,
	PLAZA_END_S,
	PLAZA_START_S,
	patrolPose,
	patrolTimeAtS,
	routeAt,
} from "./patrol.ts";
import { buildTownWorld } from "./world.ts";

afterEach(() => setRenderWidth(384));

/** Points on a face (its local plane: x across, y up, 3 × 7): the title band and the ALL row. */
const FACE_POINTS: readonly (readonly [number, number])[] = [
	[-1.2, 2.94],
	[0, 2.94],
	[1.2, 2.94],
	[-1.2, -1.81],
	[0, -1.81],
	[1.2, -1.81],
];
const blockers = PROPS.filter((o) => o.kind === "tree" || o.kind === "lamp");
function clearSight(from: Vector3, to: Vector3): boolean {
	const len = from.distanceTo(to);
	for (let i = 1; i < 80; i += 1) {
		const f = i / 80;
		if (f * len > len - 0.3) break;
		const q = from.clone().lerp(to, f);
		for (const o of blockers) {
			const d = Math.hypot(q.x - o.x, q.z - o.z);
			if (o.kind === "tree") {
				if ((q.y > 1.9 && q.y < 4.4 && d < 1.25) || (q.y <= 1.9 && d < 0.3))
					return false;
			} else if (q.y < 4.4 && d < 0.35) return false;
		}
	}
	return true;
}

/** Longest stretch (s) in one lap with a whole pylon face's title and ALL row in view. */
function pylonSeconds(rtW: number) {
	setRenderWidth(rtW);
	const world = buildTownWorld({ time: "day", lots: null });
	try {
		const rig = world.rig;
		const faces = world.board.mesh.children.filter((o) =>
			o.name.startsWith("leaderboard:face"),
		) as Mesh[];
		world.board.mesh.updateMatrixWorld(true);
		const dt = 1 / 20;
		const t0 = patrolTimeAtS(PLAZA_START_S) - 15;
		let p = patrolPose(t0);
		followRig(rig, p, 9_999, 0);
		let run = 0;
		let best = 0;
		let worstExit = 0;
		const exitT = patrolTimeAtS(PLAZA_END_S);
		for (let t = t0; t < exitT + 30; t += dt) {
			p = patrolPose(t);
			followRig(rig, p, dt * 1000, dt);
			rig.apply();
			const cam = rig.camera;
			cam.aspect = rtW / RT_H;
			cam.updateProjectionMatrix();
			cam.updateMatrixWorld(true);
			const seen = faces.some((m) => {
				const n = new Vector3(0, 0, 1).transformDirection(m.matrixWorld);
				const c = new Vector3().setFromMatrixPosition(m.matrixWorld);
				if (n.dot(cam.position.clone().sub(c)) <= 0) return false;
				return FACE_POINTS.every(([x, y]) => {
					const w = m.localToWorld(new Vector3(x, y, 0.01));
					const v = w.clone().project(cam);
					return (
						Math.abs(v.x) <= 0.98 &&
						Math.abs(v.y) <= 0.98 &&
						v.z < 1 &&
						clearSight(cam.position, w)
					);
				});
			});
			run = seen ? run + dt : 0;
			best = Math.max(best, run);
			if (t > exitT + 1) {
				const d = new Vector3();
				cam.getWorldDirection(d);
				worstExit = Math.max(
					worstExit,
					Math.abs(
						turnBetween(yawOfDir(d.x, d.z), yawOfDir(p.dir[0], p.dir[1])),
					),
				);
				expect(rig.dir).toBe(1);
			}
		}
		return { best, worstExit };
	} finally {
		world.dispose();
	}
}

describe("the pylon on the plaza stretch (16 A2)", () => {
	test.each([384, 373, 320])(
		"at a %i × 288 target: title and numbers in view, clear, for ≥ 8 s; the camera then looks the way it walks",
		(rtW) => {
			const { best, worstExit } = pylonSeconds(rtW);
			expect(best).toBeGreaterThanOrEqual(8);
			expect(worstExit).toBeLessThan(45);
		},
	);
});

// ── a 결재 while on the plaza stretch ──────────────────────────────────────────

const plazaLamps = PROPS.filter((o) => o.side === "plaza" && o.kind === "lamp");
const visit = (over: Partial<Visit>): Visit =>
	({
		visit_id: "A",
		repo_id: "o/a",
		carry: "folder",
		seen_at: 0,
		head_start_ms: 0,
		left_at: null,
		...over,
	}) as Visit;

describe("a 결재 during the plaza stretch", () => {
	test("from anywhere on the plaza stretch the walk to the HQ follows the route out (no lamp, no jump)", () => {
		for (let s = PLAZA_START_S + 0.5; s < PLAZA_END_S; s += 1.5) {
			const at = routeAt(s);
			const path = rooToHq(at);
			expect(path.pts[0]).toEqual({ x: at.x, z: at.z });
			for (let i = 1; i < path.pts.length; i += 1) {
				const a = path.pts[i - 1] as { x: number; z: number };
				const b = path.pts[i] as { x: number; z: number };
				expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThan(1.7);
				for (const l of plazaLamps)
					expect(Math.hypot(b.x - l.x, b.z - l.z)).toBeGreaterThan(0.45);
			}
		}
	});

	test("withdrawn on the way: back onto the route from where it is (the walk starts at its feet)", () => {
		const at = routeAt((PLAZA_START_S + PLAZA_END_S) / 2);
		const { path, s } = rooToRoute(at);
		expect(path.pts[0]).toEqual({ x: at.x, z: at.z });
		const end = routeAt(s);
		const last = path.pts[path.pts.length - 1] as { x: number; z: number };
		expect(Math.hypot(last.x - end.x, last.z - end.z)).toBeLessThan(1e-6);
	});

	test("the state machine: patrol in the plaza → to the HQ → back → patrol, no step longer than a sprint", () => {
		// scene time at which the patrol is half way round the pylon
		const mid = patrolTimeAtS((PLAZA_START_S + PLAZA_END_S) / 2) * 1000;
		const book = (left: number | null) => ({
			...EMPTY_BOOK,
			visits: [visit({ seen_at: mid - 20_000, left_at: left })],
		});
		const input = (now: number, left: number | null): KangarooInput => ({
			now,
			book: book(left),
			walkMsOf: () => 20_000,
			reducedMotion: false,
		});
		let st = initialRoo(input(mid - 50, null));
		expect(st.mode).toBe("patrol");
		let prev = rooPose(st, mid - 50);
		let maxStep = 0;
		const modes = new Set<string>();
		for (let now = mid; now < mid + LAP_S * 1000; now += 50) {
			const left = now > mid + 2_000 ? mid + 2_000 : null; // withdrawn 2 s after it came
			st = stepKangaroo(st, input(now, left), 50);
			const pose = rooPose(st, now);
			modes.add(st.mode);
			maxStep = Math.max(maxStep, Math.hypot(pose.x - prev.x, pose.z - prev.z));
			prev = pose;
		}
		expect(modes.has("to-hq")).toBe(true);
		expect(modes.has("back")).toBe(true);
		expect(st.mode).toBe("patrol");
		// 4.2 u/s × 50 ms = 0.21; the patrol is slower
		expect(maxStep).toBeLessThan(0.25);
	});
});
