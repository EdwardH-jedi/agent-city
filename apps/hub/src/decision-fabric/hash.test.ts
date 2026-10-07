// Test 2 — stable input hashing: key-order independent, changes whenever the input changes.
import { describe, expect, test } from "bun:test";
import {
	DecisionRequest,
	PostReviewInput,
	TaskRouteInput,
} from "./contracts.ts";
import { decide } from "./fabric.ts";
import { rulesProvider } from "./fake-provider.ts";
import { canonicalJson, hashDecisionInput } from "./hash.ts";
import {
	CHANGE_FLAGS,
	change,
	finding,
	postReview,
	request,
	reverseKeys,
	taskRoute,
} from "./testkit.ts";

describe("canonicalJson", () => {
	test("sorts keys at every level and keeps array order", () => {
		expect(
			canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }, 3], c: null } }),
		).toBe('{"a":{"c":null,"d":[{"y":2,"z":1},3]},"b":1}');
	});
});

describe("hashDecisionInput", () => {
	const input = TaskRouteInput.parse(taskRoute());

	test("golden vector (sha256 of the canonical preimage, cross-checked with shasum)", () => {
		expect(hashDecisionInput("TASK_ROUTE", input)).toBe(
			"e4cd71c7496880a534b7f2ea33846d666da43c39566a7c0234edd07f42d7ce4d",
		);
	});

	test("is 64 lowercase hex and repeatable", () => {
		const h = hashDecisionInput("TASK_ROUTE", input);
		expect(h).toMatch(/^[0-9a-f]{64}$/);
		expect(hashDecisionInput("TASK_ROUTE", structuredClone(input))).toBe(h);
	});

	test("does not depend on key order", () => {
		expect(hashDecisionInput("TASK_ROUTE", reverseKeys(input))).toBe(
			hashDecisionInput("TASK_ROUTE", input),
		);
	});

	test("changes when any flag, field or the kind changes", () => {
		const base = hashDecisionInput("TASK_ROUTE", input);
		const seen = new Set([base]);
		for (const flag of CHANGE_FLAGS) {
			const flipped = {
				...input,
				change: { ...input.change, [flag]: !input.change[flag] },
			};
			seen.add(hashDecisionInput("TASK_ROUTE", flipped));
		}
		seen.add(hashDecisionInput("TASK_ROUTE", { ...input, scope: "LARGE" }));
		seen.add(hashDecisionInput("REVIEW_DEPTH", input));
		expect(seen.size).toBe(CHANGE_FLAGS.length + 3);
	});

	test("finding content and order are part of the input", () => {
		const a = finding({ title: "First" });
		const b = finding({ title: "Second" });
		const h = (findings: ReturnType<typeof finding>[]) =>
			hashDecisionInput(
				"POST_REVIEW",
				PostReviewInput.parse(postReview({ findings })),
			);
		expect(h([a, b])).not.toBe(h([b, a]));
		expect(h([a])).not.toBe(h([{ ...a, detail: "different" }]));
	});
});

describe("decide() binds the hash to the normalized input", () => {
	test("the same request with keys in another order gets the same hash and decision", async () => {
		const req = request(
			"TASK_ROUTE",
			taskRoute({ change: change({ touches_auth: true }) }),
		);
		const a = await decide(rulesProvider(), req);
		const b = await decide(rulesProvider(), reverseKeys(req));
		expect(a.outcome).toBe("DECIDED");
		expect(b).toEqual(a);
		if (a.outcome !== "DECIDED") throw new Error("unreachable");
		expect(a.input_hash).toBe(
			hashDecisionInput("TASK_ROUTE", DecisionRequest.parse(req).input),
		);
	});
});
