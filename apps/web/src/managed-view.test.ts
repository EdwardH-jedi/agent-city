import { describe, expect, test } from "bun:test";
import type { ManagedTask, TaskState } from "@agent-city/schema";
import {
	blockingReason,
	canCancel,
	canRun,
	isActive,
	modeBadge,
	modelLabel,
	splitList,
	stateBadge,
} from "./managed-view.ts";
import { parseHubMessage } from "./merge.ts";

const task = (over: Partial<ManagedTask>): ManagedTask =>
	({
		state: "draft",
		execution_mode: "simulated",
		failure_kind: null,
		state_detail: null,
		cancel_requested_at: null,
		...over,
	}) as ManagedTask;

describe("simulated / live-unverified / failed / human-ready never look alike", () => {
	test("mode badge", () => {
		expect(modeBadge(task({}), false)).toEqual({
			text: "SIMULATED — no model",
			tone: "sim",
		});
		expect(modeBadge(task({ execution_mode: "live" }), false)).toEqual({
			text: "LIVE — integration not live-verified",
			tone: "warn",
		});
		expect(modeBadge(task({ execution_mode: "live" }), true)).toEqual({
			text: "LIVE",
			tone: "info",
		});
	});

	test("state badge: four distinct outcomes", () => {
		const sim = stateBadge(task({ state: "human_ready" }));
		const live = stateBadge(
			task({ state: "human_ready", execution_mode: "live" }),
		);
		const failed = stateBadge(task({ state: "failed" }));
		const blocked = stateBadge(task({ state: "blocked" }));
		expect(sim).toEqual({ text: "simulated human-ready", tone: "sim" });
		expect(live).toEqual({ text: "human-ready", tone: "ok" });
		expect(new Set([sim, live, failed, blocked].map((b) => b.text)).size).toBe(
			4,
		);
		expect(new Set([sim, live, failed, blocked].map((b) => b.tone)).size).toBe(
			4,
		);
	});

	test("a result whose workspace changed after review is shown as stale, in both modes", () => {
		for (const execution_mode of ["simulated", "live"] as const)
			expect(
				stateBadge(task({ state: "human_ready", execution_mode }), {
					intact: false,
					reason: "HEAD moved",
				}),
			).toEqual({
				text: "stale — workspace changed after review",
				tone: "bad",
			});
		expect(
			stateBadge(task({ state: "human_ready" }), { intact: true, reason: null })
				.text,
		).toBe("simulated human-ready");
	});
});

describe("actions", () => {
	const states: TaskState[] = [
		"draft",
		"queued",
		"executing",
		"verifying",
		"reviewing",
		"repairing",
		"human_ready",
		"failed",
		"blocked",
		"cancelled",
		"interrupted",
	];
	test("Run only from draft / interrupted / blocked", () => {
		expect(states.filter((s) => canRun(task({ state: s })))).toEqual([
			"draft",
			"blocked",
			"interrupted",
		]);
	});
	test("Cancel until finished, and not twice", () => {
		expect(states.filter((s) => canCancel(task({ state: s })))).toEqual([
			"draft",
			"queued",
			"executing",
			"verifying",
			"reviewing",
			"repairing",
			"blocked",
			"interrupted",
		]);
		expect(
			canCancel(
				task({
					state: "executing",
					cancel_requested_at: "2026-01-01T00:00:00.000Z",
				}),
			),
		).toBe(false);
	});
	test("active = queued or owned by the worker", () => {
		expect(states.filter((s) => isActive(task({ state: s })))).toEqual([
			"queued",
			"executing",
			"verifying",
			"reviewing",
			"repairing",
		]);
	});
});

describe("explanations", () => {
	test("blocking reason names the failure kind; a pending cancel is explained", () => {
		expect(blockingReason(task({}))).toBeNull();
		expect(
			blockingReason(
				task({
					state: "blocked",
					failure_kind: "provider_auth",
					state_detail: "claude is not logged in",
				}),
			),
		).toBe("provider_auth: claude is not logged in");
		expect(
			blockingReason(
				task({
					state: "executing",
					cancel_requested_at: "2026-01-01T00:00:00.000Z",
				}),
			),
		).toContain("cancel requested");
	});

	test("an unreported model is 'unknown', never the requested name", () => {
		expect(modelLabel({ model_requested: "opus", model_resolved: null })).toBe(
			"requested opus → resolved unknown",
		);
		expect(
			modelLabel({ model_requested: "opus", model_resolved: "claude-x" }),
		).toBe("requested opus → resolved claude-x");
		expect(modelLabel({ model_requested: null, model_resolved: null })).toBe(
			"resolved unknown",
		);
	});

	test("splitList", () => {
		expect(splitList(" a \n\n b, c ,")).toEqual(["a", "b", "c"]);
	});
});

describe("/ws managed frames", () => {
	test("only a task id is accepted", () => {
		expect(
			parseHubMessage(
				JSON.stringify({ kind: "managed", data: { task_id: "task-1" } }),
			),
		).toEqual({ kind: "managed", data: { task_id: "task-1" } });
		expect(
			parseHubMessage(JSON.stringify({ kind: "managed", data: {} })),
		).toBeNull();
	});
});
