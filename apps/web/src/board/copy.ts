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
	// decision D1: a new mission with its goal on record and no plan yet
	GOAL_RECORDED: "목표를 기록했습니다. 계획을 세워 주세요.",
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
	// Confirmed in Agent Office server/pipeline/lifecycle.mjs (read only):
	// a dispatch ended before every planned task was complete (status READY or HOLD)
	DISPATCH_STOPPED: "계획한 작업을 다 끝내기 전에 멈췄습니다.",
	// the run was closed before Report; it is recorded PARTIAL and the worktree is kept
	PRESERVED_ON_HOLD:
		"끝까지 가기 전에 닫았습니다. 작업 폴더는 남겨 두었습니다.",
};

/**
 * The short words of 자리 비운 사이 (§13.4: one line, `시각 · 프로젝트 · 짧은 말`). Never a code string;
 * the code stays in the detail view.
 */
export const SHORT = {
	sign: "결재 요청",
	stopped: "멈춤",
	passed: "전부 끝남",
	partial: "일부만 끝냄",
	unknown: "확인 필요",
} as const;

/** Short words for the codes the table knows, where the state alone says less. */
const CODE_SHORT: Readonly<Record<string, string>> = {
	DISPATCH_STOPPED: "중간에 멈춤",
	PRESERVED_ON_HOLD: "일부만 끝냄 · 폴더 보존",
};

export const codeShort = (code: string | null): string | null =>
	code ? (CODE_SHORT[code] ?? null) : null;

/** `T3 통과`, `opus로 올림`; null when the table has nothing for the transition. */
export function eventShort(
	e: Pick<RunEventView, "transition" | "task_id"> &
		Partial<Pick<RunEventView, "to_model">>,
): string | null {
	switch (e.transition) {
		case "task.completed":
			return `${e.task_id ?? "작업"} 통과`;
		case "task.escalated":
			return e.to_model ? `${e.to_model}로 올림` : "모델 올림";
		default:
			return null;
	}
}

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

/** Decision D2: a paused run (Office's loop ended for the day with tasks left). Said once, in its list. */
export const PAUSED_HEADING = "쉬는 중 · 이어서 실행 필요";
export const PAUSED_TEXT = "오늘 몫은 끝났습니다. 남은 작업이 있습니다.";

/** Decision D4: a Claude Code / Codex session waiting for input. */
export const SESSION_WAIT_TEXT = "입력을 기다리고 있습니다.";

/**
 * The short tag on an HQ 대기 row and a project row (design doc 15 §2, §3): the code in a few Korean
 * words. The code itself is never on the main screen; the detail view (D) has it.
 */
const TAG_OF_CODE: Readonly<Record<string, string>> = {
	GOAL_RECORDED: "계획 필요",
	AWAITING_PLAN_APPROVAL: "계획 승인",
	PLAN_APPROVED: "실행 대기",
	AWAITING_OWNER_INTEGRATION: "통합 대기",
	DRAFT_REQUIRES_OWNER_COMMIT: "commit 필요",
	APPROVAL_STALE: "범위 바뀜",
	SOURCE_HEAD_CHANGED: "범위 바뀜",
	PATH_NOT_ALLOWED: "범위 바뀜",
	WORKTREE_IDENTITY_CHANGED: "범위 바뀜",
	MODEL_CHAIN_EXHAUSTED: "모델 소진",
	PIPELINE_TOKEN_BUDGET_EXHAUSTED: "예산 소진",
	BUDGET_EXHAUSTED: "예산 소진",
	REVIEW_BUDGET_EXHAUSTED: "예산 소진",
	PLANNER_USAGE_UNKNOWN: "사용량 확인",
	MISSION_USAGE_UNVERIFIED: "사용량 확인",
	SANDBOX_CREDENTIALS_CHANGED: "안전 규칙",
	POLICY_VIOLATION: "안전 규칙",
	CHECK_SANDBOX_DENIED: "안전 규칙",
	PERMISSION_PROFILE_DISABLED: "안전 규칙",
	RUNNING_AGENTS_OR_OPEN_FILES: "저장소 사용 중",
	DIRTY_WORKTREE: "저장소 사용 중",
	REPOSITORY_RESERVED: "저장소 사용 중",
	GIT_OPERATION_IN_PROGRESS: "저장소 사용 중",
	DISPATCHER_RUN_LOCK_PRESENT: "저장소 사용 중",
	FAILED_PROCESS_RECONCILE: "복구 확인",
	MISSION_RECONCILIATION_REQUIRED: "복구 확인",
	PLANNER_INTERRUPTED: "복구 확인",
	EVENT_LOG_TORN: "복구 확인",
	DISPATCH_STOPPED: "중간에 멈춤",
	PRESERVED_ON_HOLD: "일부만 끝냄",
};
export const SESSION_WAIT_TAG = "입력 대기";
export const PAUSED_TAG = "쉬는 중";

/** Every code the sentence table knows has a tag (copy.test.ts holds the two tables together). */
export const tagOfCode = (code: string | null): string | null =>
	code ? (TAG_OF_CODE[code] ?? null) : null;

/**
 * The tag of an HQ 대기 row: a session waiting for input (its visit ids are `session:<id>`) → 입력 대기;
 * a known code → its words; a 멈춤 (binder) the table does not know → 멈춤; anything else → 확인 필요.
 */
export function hqTag(card: {
	ids: readonly string[];
	code: string | null;
	carry: "folder" | "binder";
}): string {
	if (card.ids.length > 0 && card.ids.every((id) => id.startsWith("session:")))
		return SESSION_WAIT_TAG;
	return (
		tagOfCode(card.code) ??
		(card.carry === "binder" ? SHORT.stopped : SHORT.unknown)
	);
}

/** How long, in one short word: `방금`, `12분`, `6시간`, `3일`. Empty for a bad time. */
export function elapsedKo(iso: string, now: number): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return "";
	const min = Math.max(0, Math.floor((now - t) / 60_000));
	if (min < 1) return "방금";
	if (min < 60) return `${min}분`;
	const h = Math.floor(min / 60);
	return h < 48 ? `${h}시간` : `${Math.floor(h / 24)}일`;
}

/** The provider's name on screen (`docs · Claude`). */
export const PROVIDER_NAME: Readonly<Record<string, string>> = {
	claude: "Claude",
	codex: "Codex",
	ollama: "Ollama",
};

/** "T1 통과했습니다. 다음으로 넘어갑니다." → "T1 통과했습니다." (the history list keeps only what happened). */
export function firstSentence(text: string): string {
	const i = text.indexOf(". ");
	return i < 0 ? text : text.slice(0, i + 1);
}

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
