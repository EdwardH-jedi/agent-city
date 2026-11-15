import { expect, test } from "bun:test";
import { type RooState, rooPose } from "../choreo.ts";
import {
	holdRoo,
	newTour,
	stepTour,
	type TourInput,
	type TourState,
	tourPosition,
	tourRoom,
	tourShade,
} from "./tour.ts";

const repo = (id: string, active = 1) => ({
	repo_id: `demo/${id}`,
	label: id,
	active_tasks: active,
	monitors: [],
	pending_requests: 0,
	has_stopped: false,
});
const repos = [repo("station0"), repo("office"), repo("third")];
const input = (over: Partial<TourInput> = {}): TourInput => ({
	now: 1000,
	lap: 1,
	owner: true,
	still: false,
	reduced: false,
	sign: false,
	off: false,
	pinned: false,
	repos,
	front: { repo_id: "demo/station0", x: 20, z: 0, door: { x: 24, z: 0 } },
	here: { x: 20, z: 0 },
	ready: true,
	...over,
});
function inside(mode: "auto" | "manual" = "auto") {
	let s = stepTour(
		newTour(),
		input(mode === "manual" ? { command: { serial: 1, index: 0 } } : {}),
	);
	if (mode === "auto") s = stepTour(s, input({ now: 2000 }));
	s = stepTour(s, input({ now: 2200 }));
	expect(s.visit?.phase).toBe("inside");
	return s;
}
test("only working project fronts; no HQ, cafe, owner absence, signs, still, reduced or off", () => {
	for (const over of [
		{ repos: [repo("station0", 0)] },
		{ repos: [repo("hq")] },
		{ repos: [repo("no-wukkas-cafe")] },
		{ owner: false },
		{ sign: true },
		{ still: true },
		{ reduced: true },
		{ off: true },
		{ pinned: true },
		{ front: null },
	])
		expect(stepTour(newTour(), input(over)).visit).toBeNull();
	expect(stepTour(newTour(), input()).visit?.phase).toBe("door");
});
test("two visits per lap, ten minute same-building cooldown and bounded departed-building memory", () => {
	let s: TourState = stepTour(newTour(), input());
	s = { ...s, visit: null };
	expect(stepTour(s, input({ now: 5000 })).visit).toBeNull();
	s = stepTour(
		s,
		input({
			now: 6000,
			front: {
				...{ repo_id: "demo/station0", x: 20, z: 0, door: { x: 24, z: 0 } },
				repo_id: "demo/office",
			},
		}),
	);
	expect(s.count).toBe(2);
	s = { ...s, visit: null };
	expect(
		stepTour(
			s,
			input({
				front: {
					...{ repo_id: "demo/station0", x: 20, z: 0, door: { x: 24, z: 0 } },
					repo_id: "demo/third",
				},
				now: 7000,
			}),
		).visit,
	).toBeNull();
	expect(stepTour(s, input({ now: 610001, lap: 3 })).visit?.repo_id).toBe(
		"demo/station0",
	);
	expect(stepTour(s, input({ repos: [], front: null })).seen.size).toBe(0);
});
test("all live interruptions exit immediately; rejected commands never replay after recovery", () => {
	const s = inside();
	for (const over of [
		{ sign: true },
		{ still: true },
		{ reduced: true },
		{ owner: false },
		{ repos: [] },
	])
		expect(stepTour(s, input(over)).visit).toBeNull();
	const blocked = stepTour(
		newTour(),
		input({ sign: true, command: { serial: 4, index: 0 } }),
	);
	expect(
		stepTour(blocked, input({ off: true, command: { serial: 4, index: 0 } }))
			.visit,
	).toBeNull();
});
test("automatic stays 25 s, fades 300 ms and walks back to the saved patrol position", () => {
	let s = inside();
	expect(stepTour(s, input({ now: 27199 })).visit?.phase).toBe("inside");
	s = stepTour(s, input({ now: 27200 }));
	expect(s.visit?.phase).toBe("leaving");
	expect(tourRoom(s.visit, 27300)).toBe("demo/station0");
	expect(tourRoom(s.visit, 27351)).toBeNull();
	expect(tourShade(s.visit, 27350)).toBe(1);
	s = stepTour(s, input({ now: 27500 }));
	expect(s.visit?.phase).toBe("returning");
	if (!s.visit) throw Error("missing return");
	expect(tourPosition(s.visit, 29000)).toMatchObject({
		x: 20,
		z: 0,
		moving: false,
	});
	expect(stepTour(s, input({ now: 29000 })).visit).toBeNull();
});
test("numeric order permits quiet projects with tour off, Esc/0 exit and 60 s timeout", () => {
	const quiet = [repo("station0", 0), repo("office", 0)];
	let s = stepTour(
		newTour(),
		input({ off: true, repos: quiet, command: { serial: 1, index: 1 } }),
	);
	expect(s.visit?.repo_id).toBe(quiet[1]?.repo_id);
	s = stepTour(s, input({ now: 1200, off: true, repos: quiet }));
	expect(
		stepTour(s, input({ now: 61199, off: true, repos: quiet })).visit?.phase,
	).toBe("inside");
	expect(
		stepTour(s, input({ now: 61200, off: true, repos: quiet })).visit?.phase,
	).toBe("leaving");
	expect(
		stepTour(s, input({ command: { serial: 2, index: -1 } })).visit,
	).toBeNull();
	expect(
		stepTour(newTour(), input({ command: { serial: 1, index: 7 } })).visit,
	).toBeNull();
	expect(
		stepTour(
			{
				...s,
				visit: {
					...(s.visit ??
						(() => {
							throw Error("no visit");
						})()),
					phase: "entering",
					at: 1000,
				},
			},
			input({ now: 12000, ready: false }),
		).visit,
	).toBeNull();
});
test("every existing kangaroo mode resumes the identical position and animation clock", () => {
	const path = {
		pts: [
			{ x: 0, z: 0 },
			{ x: 20, z: 0 },
		],
		cum: [0, 20],
		length: 20,
	};
	const states: RooState[] = [
		{ mode: "patrol", shiftMs: 0, cam: 0 },
		{ mode: "to-hq", path, t0: 1000, shiftMs: 0, cam: 0 },
		{ mode: "at-hq", since: 1000, shiftMs: 0, cam: 1 },
		{ mode: "back", path, t0: 1000, rejoinShiftMs: 0, cam: 0 },
	];
	for (const s of states)
		expect(rooPose(holdRoo(s, 26000), 28000)).toEqual(rooPose(s, 2000));
});
