import { describe, expect, test } from "bun:test";
import { eventPhrase, STOP_PHRASES, stopPhrase, UNKNOWN_TEXT } from "./copy.ts";

const run = (over: Partial<Parameters<typeof stopPhrase>[0]> = {}) => ({
	status: "READY",
	reason: null,
	alert: null,
	last_display: "waiting_owner" as const,
	...over,
});

describe("stopPhrase (§6 文구表)", () => {
	test("a listed code gets its sentence and keeps the code", () => {
		const p = stopPhrase(run({ reason: "AWAITING_PLAN_APPROVAL" }));
		expect(p).toEqual({
			text: "계획 승인 부탁드립니다.",
			code: "AWAITING_PLAN_APPROVAL",
			known: true,
		});
	});

	test("a code that is not in the table is never explained: 확인이 필요합니다 + the code", () => {
		const p = stopPhrase(run({ reason: "SOMETHING_NEW_FROM_OFFICE" }));
		expect(p.text).toBe(UNKNOWN_TEXT);
		expect(p.text).toBe("확인이 필요합니다");
		expect(p.code).toBe("SOMETHING_NEW_FROM_OFFICE");
		expect(p.known).toBe(false);
	});

	test("PRESERVED_ON_HOLD has no sentence yet (owner decides, doc §12.4)", () => {
		const p = stopPhrase(run({ reason: "PRESERVED_ON_HOLD" }));
		expect(p.text).toBe(UNKNOWN_TEXT);
		expect(p.code).toBe("PRESERVED_ON_HOLD");
	});

	test("DISPATCH_STOPPED (seen on the real data, not in the table) is unknown", () => {
		const p = stopPhrase(run({ reason: "DISPATCH_STOPPED" }));
		expect(p).toEqual({
			text: UNKNOWN_TEXT,
			code: "DISPATCH_STOPPED",
			known: false,
		});
	});

	test("a HOLD carries its reason in `alert` too: the alert is tried first, then the reason", () => {
		const p = stopPhrase(
			run({
				status: "HOLD",
				last_display: "hold",
				alert: "MODEL_CHAIN_EXHAUSTED",
				reason: "MODEL_CHAIN_EXHAUSTED",
			}),
		);
		expect(p.text).toBe("정해 주신 모델을 다 써도 풀지 못했습니다.");
		const q = stopPhrase(
			run({
				last_display: "needs_reconcile",
				alert: "FAILED_PROCESS_RECONCILE",
			}),
		);
		expect(q.text).toBe("실행이 비정상 종료됐습니다. 복구 확인이 필요합니다.");
	});

	test("every code of the table maps to exactly one sentence", () => {
		const codes = Object.keys(STOP_PHRASES);
		expect(new Set(codes).size).toBe(codes.length);
		for (const c of [
			"AWAITING_OWNER_INTEGRATION",
			"DRAFT_REQUIRES_OWNER_COMMIT",
			"APPROVAL_STALE",
			"SOURCE_HEAD_CHANGED",
			"PATH_NOT_ALLOWED",
			"WORKTREE_IDENTITY_CHANGED",
			"PIPELINE_TOKEN_BUDGET_EXHAUSTED",
			"BUDGET_EXHAUSTED",
			"REVIEW_BUDGET_EXHAUSTED",
			"PLANNER_USAGE_UNKNOWN",
			"MISSION_USAGE_UNVERIFIED",
			"SANDBOX_CREDENTIALS_CHANGED",
			"POLICY_VIOLATION",
			"CHECK_SANDBOX_DENIED",
			"PERMISSION_PROFILE_DISABLED",
			"RUNNING_AGENTS_OR_OPEN_FILES",
			"DIRTY_WORKTREE",
			"REPOSITORY_RESERVED",
			"GIT_OPERATION_IN_PROGRESS",
			"DISPATCHER_RUN_LOCK_PRESENT",
			"MISSION_RECONCILIATION_REQUIRED",
			"PLANNER_INTERRUPTED",
			"EVENT_LOG_TORN",
			"PLAN_APPROVED",
		]) {
			expect(codes).toContain(c);
		}
	});
});

describe("eventPhrase (보고: already happened, never asking)", () => {
	test("task.completed", () => {
		expect(eventPhrase({ transition: "task.completed", task_id: "T1" })).toBe(
			"T1 통과했습니다. 다음으로 넘어갑니다.",
		);
	});
	test("task.escalated names both models, or says nothing it cannot back", () => {
		expect(
			eventPhrase({
				transition: "task.escalated",
				task_id: "T2",
				from_model: "sonnet",
				to_model: "opus",
			}),
		).toBe("sonnet로 풀리지 않아 opus로 올렸습니다.");
		expect(eventPhrase({ transition: "task.escalated", task_id: "T2" })).toBe(
			"풀리지 않아 더 높은 모델로 올렸습니다.",
		);
	});
	test("transitions that are not in the table give no sentence", () => {
		for (const t of [
			"workflow.started",
			"task.started",
			"session.correlated",
			"review.recorded",
			"task.blocked",
			"task.failed",
		]) {
			expect(eventPhrase({ transition: t, task_id: "T1" })).toBeNull();
		}
	});
});
