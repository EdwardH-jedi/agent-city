// The town's pure parts: URL switches, time of day by hour, and the kangaroo's patrol (a pure function
// of patrol time: clockwise on the centre line from the original spawn, one lap ≈ 4 minutes).
import { describe, expect, test } from "bun:test";
import { ellipseOffset, ellipseTheta, SPAWN } from "./engine/ring-layout.mjs";
import { pinnedTimeOf, sceneOf, timeOfDayAt, timeOfHour } from "./params.ts";
import {
	facingFrom,
	frameIndexFor,
	LAP_S,
	PATROL_SPEED,
	patrolPose,
	rooKey,
	worldToView,
} from "./patrol.ts";

describe("URL switches", () => {
	test("the town is the default; only ?scene=campus picks the 3D campus", () => {
		expect(sceneOf("")).toBe("town");
		expect(sceneOf("?demo=1")).toBe("town");
		expect(sceneOf("?scene=town&demo=1")).toBe("town");
		expect(sceneOf("?scene=TOWN")).toBe("town");
		expect(sceneOf("?scene=whatever")).toBe("town");
		expect(sceneOf("?scene=campus")).toBe("campus");
		expect(sceneOf("?demo=1&scene=campus")).toBe("campus");
	});

	test("?time= pins day / dusk / night; a misspelt value is ignored", () => {
		expect(pinnedTimeOf("?time=dusk")).toBe("dusk");
		expect(pinnedTimeOf("?time=noon")).toBe(null);
		expect(timeOfDayAt("?time=night", new Date(2026, 0, 1, 12))).toBe("night");
		expect(timeOfDayAt("", new Date(2026, 0, 1, 12))).toBe("day");
	});

	test("local hour: day 07–17, dusk 17–20, night 20–07", () => {
		const want = (h: number) =>
			h >= 7 && h < 17 ? "day" : h >= 17 && h < 20 ? "dusk" : "night";
		for (let h = 0; h < 24; h += 1) expect(timeOfHour(h)).toBe(want(h));
		expect([
			timeOfHour(6),
			timeOfHour(7),
			timeOfHour(17),
			timeOfHour(20),
		]).toEqual(["night", "day", "dusk", "night"]);
	});
});

describe("patrol", () => {
	test("starts on the original spawn, on the road's centre line, heading west (clockwise)", () => {
		const p = patrolPose(0);
		expect(p.x).toBeCloseTo(SPAWN.x, 6);
		expect(p.z).toBeCloseTo(SPAWN.z, 6);
		expect(p.dir[0]).toBeLessThan(-0.99);
		expect(p.walked).toBe(0);
	});

	test("clockwise (θ grows), on the centre line, one lap in LAP_S, faster than the rig's 0.5 dead zone", () => {
		expect(LAP_S).toBe(240);
		expect(PATROL_SPEED).toBeGreaterThan(0.5);
		let prev = ellipseTheta(patrolPose(0).x, patrolPose(0).z);
		let turned = 0;
		for (let t = 1; t <= LAP_S; t += 1) {
			const p = patrolPose(t);
			expect(Math.abs(ellipseOffset(p.x, p.z))).toBeLessThan(1e-3);
			const th = ellipseTheta(p.x, p.z);
			const d =
				((((th - prev) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) -
				Math.PI;
			expect(d).toBeGreaterThan(0);
			turned += d;
			prev = th;
		}
		expect(turned).toBeCloseTo(2 * Math.PI, 2);
		const end = patrolPose(LAP_S);
		expect(Math.hypot(end.x - SPAWN.x, end.z - SPAWN.z)).toBeLessThan(1e-3);
	});

	test("pure: the same time gives the same pose; steps per frame are small (no teleports)", () => {
		expect(patrolPose(37.25)).toEqual(patrolPose(37.25));
		for (let t = 0; t < 60; t += 0.1) {
			const a = patrolPose(t);
			const b = patrolPose(t + 0.1);
			expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThan(0.1);
		}
	});
});

describe("sprite facing and frames (ring-world / roo controls rules)", () => {
	test("walking along the view direction shows the back (north); across it, east / west", () => {
		// camera yaw 0 looks north (-z)
		const f = (dx: number, dz: number, yawDeg: number) => {
			const v = worldToView(dx, dz, (yawDeg * Math.PI) / 180);
			return facingFrom(v[0], v[1], null);
		};
		expect(f(0, -1, 0)).toBe("north");
		expect(f(0, 1, 0)).toBe("south");
		expect(f(1, 0, 0)).toBe("east");
		expect(f(-1, 0, -90)).toBe("north"); // at the spawn, looking west, walking west
	});

	test("near a diagonal the current facing holds", () => {
		expect(facingFrom(1, -0.95, "north")).toBe("north");
		expect(facingFrom(1, -0.95, "east")).toBe("east");
		expect(facingFrom(0, 0, "west")).toBe("west");
	});

	test("frame index of a phase, wrapped; key format as ring-world", () => {
		expect(frameIndexFor(0, 4)).toBe(0);
		expect(frameIndexFor(0.99, 4)).toBe(3);
		expect(frameIndexFor(1.25, 4)).toBe(1);
		expect(frameIndexFor(Number.NaN, 4)).toBe(0);
		expect(frameIndexFor(0.5, 0)).toBe(0);
		expect(rooKey("north", "walk", 2)).toBe("roo|north|walk|2");
	});
});
