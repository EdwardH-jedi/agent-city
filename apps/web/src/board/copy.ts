// The phrase table (design doc §6): a code → one Korean sentence. A code that is not in the table is
// never explained; the screen says "확인이 필요합니다" and shows the code. Pure, no React.
import type { RunDisplay, RunEventView, RunView } from "@agent-city/schema";

export const UNKNOWN_TEXT = "확인이 필요합니다";

export interface Phrase {
	text: string;
	/** Office's own code, shown small under the sentence. */
	code: string | null;
	/** false → the code is not in the table and `text` is the "확인이 필요합니다" default. */
	known: boolean;
}

const SCOPE_CHANGED =
	"승인받은 범위와 달라져 멈췄습니다. 계획을 다시 봐 주세요.";
const BUDGET = "오늘 예산을 다 썼습니다. 한도는 직접 올리셔야 합니다.";
const USAGE = "사용량을 확인하지 못해 멈췄습니다.";
const SAFETY = "안전 규칙에 걸려 멈췄습니다. 우회하지 않았습니다.";
const BUSY = "같은 저장소를 다른 작업이 쓰고 있어 기다립니다.";
const RECONCILE = "실행이 비정상 종료됐습니다. 복구 확인이 필요합니다.";

/** Run-level status / reason / alert codes the owner must look at. */
export const STOP_PHRASES: Readonly<Record<string, string>> = {
	AWAITING_PLAN_APPROVAL: "계획 승인 부탁드립니다.",
	PLAN_APPROVED: "승인은 받았습니다. 실행을 시작해 주세요.",
	AWAITING_OWNER_INTEGRATION: "작업을 마쳤습니다. 통합 확인 부탁드립니다.",
	DRAFT_REQUIRES_OWNER_COMMIT: "초안을 직접 commit해 주셔야 합니다.",
	APPROVAL_STALE: SCOPE_CHANGED,
	SOURCE_HEAD_CHANGED: SCOPE_CHANGED,
	PATH_NOT_ALLOWED: SCOPE_CHANGED,
	WORKTREE_IDENTITY_CHANGED: SCOPE_CHANGED,
	MODEL_CHAIN_EXHAUSTED: "정해 주신 모델을 다 써도 풀지 못했습니다.",
	PIPELINE_TOKEN_BUDGET_EXHAUSTED: BUDGET,
	BUDGET_EXHAUSTED: BUDGET,
	REVIEW_BUDGET_EXHAUSTED: BUDGET,
	PLANNER_USAGE_UNKNOWN: USAGE,
	MISSION_USAGE_UNVERIFIED: USAGE,
	SANDBOX_CREDENTIALS_CHANGED: SAFETY,
	POLICY_VIOLATION: SAFETY,
	CHECK_SANDBOX_DENIED: SAFETY,
	PERMISSION_PROFILE_DISABLED: SAFETY,
	RUNNING_AGENTS_OR_OPEN_FILES: BUSY,
	DIRTY_WORKTREE: BUSY,
	REPOSITORY_RESERVED: BUSY,
	GIT_OPERATION_IN_PROGRESS: BUSY,
	DISPATCHER_RUN_LOCK_PRESENT: BUSY,
	FAILED_PROCESS_RECONCILE: RECONCILE,
	MISSION_RECONCILIATION_REQUIRED: RECONCILE,
	PLANNER_INTERRUPTED: RECONCILE,
	EVENT_LOG_TORN: RECONCILE,
	// PRESERVED_ON_HOLD is deliberately absent: its sentence is the owner's call (doc §12.4).
};

/**
 * The sentence for a run that needs the owner (or is stopped). A HOLD run's own reason is also in
 * `alert`, so the alert is tried first, then the reason; the first one the table knows wins.
 */
export function stopPhrase(
	r: Pick<RunView, "status" | "reason" | "alert"> & {
		last_display: RunDisplay;
	},
): Phrase {
	for (const code of [r.alert, r.reason]) {
		const text = code ? STOP_PHRASES[code] : undefined;
		if (code && text) return { text, code, known: true };
	}
	return {
		text: UNKNOWN_TEXT,
		code: r.alert ?? r.reason ?? r.status ?? null,
		known: false,
	};
}

/** What the screen says when a run finished. */
export const PASSED_TEXT = "전부 끝났습니다.";
export const PARTIAL_TEXT = "일부만 끝내고 닫았습니다.";
export const REVIEW_TEXT = "Codex 리뷰에 들어갑니다.";
export const AGAIN_TEXT = "한 번 실패해서 다시 시도합니다.";
export const LEAVING_TEXT = "진행하겠습니다.";

/** A report sentence for one run event, or null when the table has nothing for that transition. */
export function eventPhrase(
	e: Pick<RunEventView, "transition" | "task_id"> &
		Partial<Pick<RunEventView, "from_model" | "to_model">>,
): string | null {
	switch (e.transition) {
		case "task.completed":
			return `${e.task_id ?? "작업"} 통과했습니다. 다음으로 넘어갑니다.`;
		case "task.escalated":
			return e.from_model && e.to_model
				? `${e.from_model}로 풀리지 않아 ${e.to_model}로 올렸습니다.`
				: "풀리지 않아 더 높은 모델로 올렸습니다.";
		default:
			return null;
	}
}
