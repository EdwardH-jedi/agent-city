// URL ↔ selection (role 07): ids only, invalid parts normalized away.
import { describe, expect, test } from "bun:test";
import { formatHash, HOME, parseHash, type Route } from "./route.ts";

const TASK = "wst-00000000-0000-4000-8000-000000000002";
const REQ = "wsa-00000000-0000-4000-8000-000000000003";

describe("route", () => {
	test("round-trips every view", () => {
		const routes: Route[] = [
			HOME,
			{
				view: "projects",
				repoId: "local/fixture",
				taskId: null,
				requestId: null,
			},
			{
				view: "projects",
				repoId: "local/fixture",
				taskId: TASK,
				requestId: null,
			},
			{ view: "hq", repoId: null, taskId: null, requestId: null },
			{ view: "hq", repoId: null, taskId: TASK, requestId: REQ },
			{ view: "activity", repoId: null, taskId: null, requestId: null },
		];
		for (const r of routes) expect(parseHash(formatHash(r))).toEqual(r);
	});

	test("observed-only and second-repository routes round-trip as one segment", () => {
		for (const repoId of [
			"observed-example/telemetry-only",
			"local/empty-sandbox",
		]) {
			const r: Route = {
				view: "projects",
				repoId,
				taskId: TASK,
				requestId: null,
			};
			expect(parseHash(formatHash(r))).toEqual(r);
		}
	});

	test("repo ids are encoded as one segment", () => {
		expect(
			formatHash({
				view: "projects",
				repoId: "local/fixture",
				taskId: null,
				requestId: null,
			}),
		).toBe("#/projects/local%2Ffixture");
	});

	test("unknown or malformed ids are dropped (normalized)", () => {
		expect(parseHash("#/hq/not-an-id/also-not")).toEqual({
			view: "hq",
			repoId: null,
			taskId: null,
			requestId: null,
		});
		expect(parseHash(`#/projects/local%2Ffixture/${REQ}`).taskId).toBeNull();
		expect(parseHash("#/projects/%E0%A4%A")).toEqual(HOME);
		expect(parseHash("#tasks")).toEqual(HOME);
		expect(parseHash("")).toEqual(HOME);
	});
});
