import { describe, expect, test } from "bun:test";
import {
	codeShort,
	elapsedKo,
	eventPhrase,
	eventShort,
	hqTag,
	STOP_PHRASES,
	stopPhrase,
	tagOfCode,
	UNKNOWN_TEXT,
} from "./copy.ts";

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

	test("D1: a new mission (READY / GOAL_RECORDED) asks for a plan", () => {
		expect(stopPhrase(run({ reason: "GOAL_RECORDED" }))).toEqual({
			text: "목표를 기록했습니다. 계획을 세워 주세요.",
			code: "GOAL_RECORDED",
			known: true,
		});
	});

	test("D8: PRESERVED_ON_HOLD keeps the sentence checked in Office lifecycle.mjs (report --close before Report → PARTIAL, worktree kept)", () => {
		expect(STOP_PHRASES.PRESERVED_ON_HOLD).toBe(
			"끝까지 가기 전에 닫았습니다. 작업 폴더는 남겨 두었습니다.",
		);
	});

	test("DELEGATED_CONFIG_MISMATCH: the delegated-integration setting differs from the approval (reason and alert alike)", () => {
		const text = "위임 통합 설정이 승인 때와 다릅니다. Mac에서 확인해 주세요.";
		const want = { text, code: "DELEGATED_CONFIG_MISMATCH", known: true };
		expect(
			stopPhrase(
				run({
					status: "HOLD",
					last_display: "hold",
					reason: "DELEGATED_CONFIG_MISMATCH",
					alert: "DELEGATED_CONFIG_MISMATCH",
				}),
			),
		).toEqual(want);
		expect(
			stopPhrase(
				run({
					status: "HOLD",
					last_display: "hold",
					reason: "DELEGATED_CONFIG_MISMATCH",
				}),
			),
		).toEqual(want);
		expect(tagOfCode("DELEGATED_CONFIG_MISMATCH")).toBe("설정 확인");
	});

	test("a code that is not in the table is never explained: 확인이 필요합니다 + the code", () => {
		const p = stopPhrase(run({ reason: "SOMETHING_NEW_FROM_OFFICE" }));
		expect(p.text).toBe(UNKNOWN_TEXT);
		expect(p.text).toBe("확인이 필요합니다");
		expect(p.code).toBe("SOMETHING_NEW_FROM_OFFICE");
		expect(p.known).toBe(false);
	});

	test("PRESERVED_ON_HOLD and DISPATCH_STOPPED: sentences confirmed in Agent Office lifecycle.mjs", () => {
		expect(stopPhrase(run({ reason: "PRESERVED_ON_HOLD" }))).toEqual({
			text: "끝까지 가기 전에 닫았습니다. 작업 폴더는 남겨 두었습니다.",
			code: "PRESERVED_ON_HOLD",
			known: true,
		});
		expect(stopPhrase(run({ reason: "DISPATCH_STOPPED" }))).toEqual({
			text: "계획한 작업을 다 끝내기 전에 멈췄습니다.",
			code: "DISPATCH_STOPPED",
			known: true,
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

describe("short words for 자리 비운 사이 (§13.4)", () => {
	test("events: T3 통과 / opus로 올림 / nothing else", () => {
		expect(eventShort({ transition: "task.completed", task_id: "T3" })).toBe(
			"T3 통과",
		);
		expect(
			eventShort({
				transition: "task.escalated",
				task_id: "T1",
				to_model: "opus",
			}),
		).toBe("opus로 올림");
		expect(
			eventShort({ transition: "task.started", task_id: "T1" }),
		).toBeNull();
	});

	test("codes: only the confirmed ones have a short word, and no short word holds a code", () => {
		expect(codeShort("DISPATCH_STOPPED")).toBe("중간에 멈춤");
		expect(codeShort("SOMETHING_NEW")).toBeNull();
		expect(codeShort(null)).toBeNull();
	});
});

describe("HQ and project tags (15 §2: a code becomes a few Korean words)", () => {
	test("every code the sentence table knows has a tag, and no tag holds a code", () => {
		for (const code of Object.keys(STOP_PHRASES)) {
			const tag = tagOfCode(code);
			expect({ code, tag: typeof tag }).toEqual({ code, tag: "string" });
			expect(tag).not.toMatch(/[A-Z]{2,}_/);
		}
	});
	test("a waiting session's row says 입력 대기; known codes their words; the rest 멈춤 or 확인 필요", () => {
		expect(
			hqTag({ ids: ["session:claude:x"], code: null, carry: "folder" }),
		).toBe("입력 대기");
		expect(
			hqTag({
				ids: ["m:r:wf"],
				code: "AWAITING_OWNER_INTEGRATION",
				carry: "folder",
			}),
		).toBe("통합 대기");
		expect(
			hqTag({ ids: ["m:r:wf"], code: "SOMETHING_NEW", carry: "binder" }),
		).toBe("멈춤");
		expect(hqTag({ ids: ["m:r:wf"], code: null, carry: "folder" })).toBe(
			"확인 필요",
		);
	});
	test("elapsed: 방금 / N분 / N시간 / N일", () => {
		const now = Date.parse("2026-11-12T12:00:00Z");
		const ago = (ms: number) => new Date(now - ms).toISOString();
		expect(elapsedKo(ago(20_000), now)).toBe("방금");
		expect(elapsedKo(ago(12 * 60_000), now)).toBe("12분");
		expect(elapsedKo(ago(6 * 3_600_000 + 5), now)).toBe("6시간");
		expect(elapsedKo(ago(72 * 3_600_000), now)).toBe("3일");
		expect(elapsedKo("nope", now)).toBe("");
	});
});
