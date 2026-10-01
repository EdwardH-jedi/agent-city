import { describe, expect, test } from "bun:test";
import type { ManagedTask, TaskState } from "@agent-city/schema";
import {
	blockingReason,
	canCancel,
	canRun,
	diagnose,
	isActive,
	modeBadge,
	modelLabel,
	newerTask,
	sameSubmission,
	splitLines,
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

describe("v0.1.1 form and ordering helpers", () => {
	test("criteria are split by lines only; commas are kept", () => {
		expect(splitLines("a, b and c\r\n\n  second, with comma ")).toEqual([
			"a, b and c",
			"second, with comma",
		]);
		expect(splitList("src, docs")).toEqual(["src", "docs"]);
	});

	test("sameSubmission compares every field", () => {
		const base = {
			repo_id: "r",
			title: "t",
			objective: "o",
			acceptance_criteria: ["a, b"],
			approved_scope: ["."],
			execution_mode: "simulated" as const,
			simulation_scenario: "approve",
			repair_limit: 1,
		};
		expect(sameSubmission(base, { ...base })).toBe(true);
		expect(sameSubmission(base, { ...base, title: "t2" })).toBe(false);
		expect(
			sameSubmission(base, { ...base, acceptance_criteria: ["a", "b"] }),
		).toBe(false);
		expect(sameSubmission(base, { ...base, repair_limit: 0 })).toBe(false);
	});

	test("a lower revision never replaces a newer snapshot", () => {
		expect(newerTask({ rev: 3 }, { rev: 5 })).toBe(false);
		expect(newerTask({ rev: 5 }, { rev: 5 })).toBe(true);
		expect(newerTask({ rev: 6 }, { rev: 5 })).toBe(true);
	});
});

describe("read-only diagnostics", () => {
	const t = (over: Partial<ManagedTask>) =>
		task({ updated_at: "2026-01-01T00:00:00.000Z", ...over });
	const runs = [
		{ phase: "verify" as const, attempt_no: 2, state: "failed" as const },
	];

	test("names the stage, the reason, the last transition and a safe next action", () => {
		const d = diagnose(
			t({
				state: "blocked",
				failure_kind: "provider_auth",
				state_detail: "not logged in",
			}),
			runs,
			null,
			null,
			false,
		);
		expect(d.stage).toBe("attempt 2: verify (failed)");
		expect(d.reason).toBe("provider_auth: not logged in");
		expect(d.lastTransition).toBe("blocked at 2026-01-01T00:00:00.000Z");
		expect(d.nextAction).toContain("Sign in");
		expect(d.workspace).toBe("not checked");
	});

	test("quarantine and invalid evidence take precedence; never suggests an override", () => {
		const q = diagnose(
			t({ state: "interrupted", failure_kind: "interrupted" }),
			runs,
			null,
			null,
			true,
		);
		expect(q.nextAction).toContain("stop it yourself");
		const e = diagnose(
			t({ state: "human_ready" }),
			runs,
			{ intact: true, reason: null },
			false,
			false,
		);
		expect(e.evidence).toBe("invalid");
		expect(e.nextAction).toContain("untrusted");
		for (const d of [q, e])
			expect(d.nextAction).not.toMatch(/force|dismiss|unlock|override/i);
	});

	test("human-ready: simulated vs live vs changed workspace", () => {
		expect(
			diagnose(
				t({ state: "human_ready" }),
				runs,
				{ intact: true, reason: null },
				true,
				false,
			).nextAction,
		).toContain("Simulated");
		expect(
			diagnose(
				t({ state: "human_ready", execution_mode: "live" }),
				runs,
				{ intact: true, reason: null },
				true,
				false,
			).nextAction,
		).toContain("merge or discard");
		expect(
			diagnose(
				t({ state: "human_ready" }),
				runs,
				{ intact: false, reason: "x" },
				true,
				false,
			).workspace,
		).toBe("changed");
	});

	test("every failure kind has a next action", () => {
		for (const k of [
			"approval_void",
			"verification_missing",
			"scope_violation",
			"timeout",
			"evidence_invalid",
			"repair_limit_exhausted",
			"provider_output_invalid",
			"internal_error",
		] as const)
			expect(
				diagnose(t({ state: "failed", failure_kind: k }), [], null, null, false)
					.nextAction,
			).not.toBe("Inspect the detail and logs.");
	});
});
