import { describe, expect, test } from "bun:test";
import {
	canTransition,
	DEFAULT_REPAIR_LIMIT,
	FailureKind,
	isActiveTaskState,
	isTerminalTaskState,
	LIVE_INTEGRATION_VERIFIED,
	MAX_REPAIR_LIMIT,
	outcomeStateFor,
	REVIEW_CONTRACT,
	ReviewOutput,
	RUNNABLE_TASK_STATES,
	TaskState,
	TaskSubmission,
	verificationPassed,
} from "./index.ts";

const SHA = "a".repeat(40);
const HASH = "b".repeat(64);

describe("managed task state machine", () => {
	const all = TaskState.options;

	test("terminal states go nowhere; nothing skips straight to human_ready", () => {
		for (const from of ["human_ready", "failed", "cancelled"] as const) {
			expect(isTerminalTaskState(from)).toBe(true);
			for (const to of all) expect(canTransition(from, to)).toBe(false);
		}
		// only a review can produce human_ready
		expect(all.filter((s) => canTransition(s, "human_ready"))).toEqual([
			"reviewing",
		]);
		// only an explicit Run queues
		expect(all.filter((s) => canTransition(s, "queued"))).toEqual([
			"draft",
			"blocked",
			"interrupted",
		]);
		expect([...RUNNABLE_TASK_STATES].sort()).toEqual([
			"blocked",
			"draft",
			"interrupted",
		]);
	});

	test("a repair always goes back through verification and review", () => {
		expect(canTransition("repairing", "verifying")).toBe(true);
		expect(canTransition("repairing", "reviewing")).toBe(false);
		expect(canTransition("repairing", "human_ready")).toBe(false);
		expect(canTransition("executing", "reviewing")).toBe(false);
		expect(canTransition("verifying", "human_ready")).toBe(false);
	});

	test("every active state can be cancelled, interrupted, failed or blocked", () => {
		for (const s of all.filter(isActiveTaskState))
			for (const to of [
				"cancelled",
				"interrupted",
				"failed",
				"blocked",
			] as const)
				expect(canTransition(s, to)).toBe(true);
		expect(all.filter(isActiveTaskState)).toEqual([
			"executing",
			"verifying",
			"reviewing",
			"repairing",
		]);
	});

	test("'the tool could not run' is blocked, never failed — and never both", () => {
		const blocked = FailureKind.options.filter(
			(k) => outcomeStateFor(k) === "blocked",
		);
		expect(blocked.sort()).toEqual([
			"approval_void",
			"provider_auth",
			"provider_model",
			"provider_quota",
			"provider_unavailable",
			"repo_invalid",
			"verification_missing",
			"verification_unavailable",
			"workspace_error",
		]);
		for (const k of [
			"verification_failed",
			"review_invalid",
			"candidate_mutated",
		] as const)
			expect(outcomeStateFor(k)).toBe("failed");
	});
});

describe("contracts", () => {
	const submission = {
		idempotency_key: "key-12345678",
		repo_id: "local/fixture",
		title: "t",
		objective: "o",
		acceptance_criteria: ["c"],
		approved_scope: ["src"],
		execution_mode: "simulated",
	};

	test("submission: bounded repair limit, strict shape, safe scope", () => {
		expect(TaskSubmission.parse(submission).repair_limit).toBe(
			DEFAULT_REPAIR_LIMIT,
		);
		expect(DEFAULT_REPAIR_LIMIT).toBe(1);
		const bad = (over: Record<string, unknown>) =>
			TaskSubmission.safeParse({ ...submission, ...over }).success;
		expect(bad({ repair_limit: MAX_REPAIR_LIMIT })).toBe(true);
		expect(bad({ repair_limit: MAX_REPAIR_LIMIT + 1 })).toBe(false);
		expect(bad({ repair_limit: -1 })).toBe(false);
		expect(bad({ repair_limit: 1.5 })).toBe(false);
		expect(bad({ verification: [["rm", "-rf", "/"]] })).toBe(false);
		expect(bad({ acceptance_criteria: [] })).toBe(false);
		expect(
			bad({ execution_mode: "live", simulation_scenario: "approve" }),
		).toBe(false);
		for (const scope of [
			"..",
			"../x",
			"/abs",
			"a/../b",
			"a//b",
			"a\\b",
			"-x",
			"",
		])
			expect(bad({ approved_scope: [scope] })).toBe(false);
		for (const scope of [".", "src", "apps/web/src", ".github"])
			expect(bad({ approved_scope: [scope] })).toBe(true);
	});

	test("review output: exact shape, bound to a commit + manifest, no claimed test runs", () => {
		const review = {
			contract: REVIEW_CONTRACT,
			audited_sha: SHA,
			manifest_hash: HASH,
			verdict: "approve",
			findings: [],
			tests_executed: false,
			summary: "ok",
		};
		expect(ReviewOutput.safeParse(review).success).toBe(true);
		for (const over of [
			{ tests_executed: true },
			{ audited_sha: "abc" },
			{ manifest_hash: undefined },
			{ verdict: "lgtm" },
			{ contract: "something/else" },
			{ extra: 1 },
		])
			expect(ReviewOutput.safeParse({ ...review, ...over }).success).toBe(
				false,
			);
	});

	test("verification passes only when every command completed with exit 0 — and there is one", () => {
		const r = (over: Record<string, unknown> = {}) =>
			({
				exit_code: 0,
				completed: true,
				timed_out: false,
				...over,
			}) as never;
		expect(verificationPassed([])).toBe(false);
		expect(verificationPassed([r()])).toBe(true);
		expect(verificationPassed([r(), r({ exit_code: 1 })])).toBe(false);
		expect(verificationPassed([r({ completed: false, exit_code: null })])).toBe(
			false,
		);
		expect(verificationPassed([r({ timed_out: true })])).toBe(false);
	});

	test("the live path is not claimed as verified", () => {
		expect(LIVE_INTEGRATION_VERIFIED).toBe(false);
	});
});
