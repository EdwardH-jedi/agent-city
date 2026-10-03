// Operator identity, approval challenges, decisions and receipts (web-safe).
//
// Normative decision order (INTERFACE.md §7): body limit + strict parse → session auth → exact
// Origin → CSRF → receipt lookup by (operator_id, idempotency_key) → found: replay (same
// payload_hash) or 409 idempotency_conflict → not found: confirmation check → ONE SQLite
// transaction (load request + subject; status/rev/binding; verify + consume challenge; insert
// decision + receipt; apply gate effects; bump revs).
import { z } from "zod";
import { TaskState } from "../managed.ts";
import { redact } from "../redact.ts";
import { ApprovalKind } from "./binding.ts";
import {
	ApprovalRequestId,
	BootId,
	DecisionId,
	IdempotencyKey,
	ManagedTaskId,
	WorkspaceTaskId,
} from "./ids.ts";
import {
	Hash,
	HashedTs,
	isMultiLineSafe,
	isWellFormed,
	Rev,
	UtcTs,
} from "./primitives.ts";
import { CHALLENGE_CONTRACT, DECISION_CONTRACT } from "./proposal.ts";
import { ApprovalStatus, WorkspaceStage } from "./state.ts";

// ── operator ───────────────────────────────────────────────────────────────

export const OPERATOR_ID = "operator:edward";
export const OperatorId = z.literal(OPERATOR_ID);
export type OperatorId = z.infer<typeof OperatorId>;

/** read: every workspace GET. decide: every workspace mutation (drafts, publish, cancel, challenge, decide). */
export const OperatorScope = z.enum(["workspace:read", "workspace:decide"]);
export type OperatorScope = z.infer<typeof OperatorScope>;

/**
 * The authenticated principal of one in-memory operator session. `session_generation` increases
 * with every login within a boot; `boot_id` changes on every hub start. Both are bound into every
 * challenge, so logout/expiry/restart void outstanding challenges without any write.
 */
export const OperatorPrincipal = z.strictObject({
	operator_id: OperatorId,
	scopes: z.array(OperatorScope).min(1).max(2),
	session_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	boot_id: BootId,
});
export type OperatorPrincipal = z.infer<typeof OperatorPrincipal>;

/** CSRF token header for every workspace mutation (value from SessionView.csrf_token). */
export const CSRF_HEADER = "x-agentcity-csrf";
/** 32 random bytes, base64url, no padding. Used for challenges and CSRF tokens. */
export const Token256 = z
	.string()
	.regex(/^[A-Za-z0-9_-]{43}$/, "43-char base64url token");

/** What the browser learns about its session. No boot id, no generation, no credential. */
export const SessionView = z.strictObject({
	operator_id: OperatorId,
	scopes: z.array(OperatorScope).min(1).max(2),
	csrf_token: Token256,
	expires_at: UtcTs,
});
export type SessionView = z.infer<typeof SessionView>;

// ── confirmation ───────────────────────────────────────────────────────────

/** Exact, case-sensitive. No trimming, no Unicode normalization: "Edward " and "edward" fail. */
export const CONFIRMATION_TEXT = "Edward";
export const CONFIRMATION_MAX_CHARS = 64;
export const REASON_MAX_CHARS = 1000;

// ── actions ────────────────────────────────────────────────────────────────

export const DecisionAction = z.enum([
	"approve",
	"accept",
	"request_changes",
	"reject",
]);
export type DecisionAction = z.infer<typeof DecisionAction>;

export const ACTIONS_BY_KIND: Readonly<
	Record<ApprovalKind, readonly DecisionAction[]>
> = {
	run: ["approve", "request_changes", "reject"],
	result: ["accept", "request_changes", "reject"],
};

export const isActionAllowed = (
	kind: ApprovalKind,
	action: DecisionAction,
): boolean => ACTIONS_BY_KIND[kind].includes(action);

/** approve / accept grant something → they need the typed confirmation. */
export const needsConfirmation = (a: DecisionAction): boolean =>
	a === "approve" || a === "accept";

// ── challenge ──────────────────────────────────────────────────────────────

/** Challenge lifetime. Fixed; ≤ 5 minutes. */
export const CHALLENGE_TTL_MS = 300_000;

export const ChallengeStatus = z.enum(["none", "issued", "consumed"]);
export type ChallengeStatus = z.infer<typeof ChallengeStatus>;

/** POST /approval-requests/:id/challenge — the client states what it is looking at. */
export const ChallengeIssueRequest = z.strictObject({
	kind: ApprovalKind,
	binding_hash: Hash,
	expected_request_rev: Rev,
});
export type ChallengeIssueRequest = z.infer<typeof ChallengeIssueRequest>;

/**
 * Returned exactly once. Issuing bumps the request's `rev` (repo rev convention); the decision
 * must send `expected_request_rev = request_rev` from this response. A newer challenge supersedes.
 */
export const ChallengeIssueResponse = z.strictObject({
	approval_request_id: ApprovalRequestId,
	kind: ApprovalKind,
	binding_hash: Hash,
	request_rev: Rev,
	challenge: Token256,
	expires_at: HashedTs,
});
export type ChallengeIssueResponse = z.infer<typeof ChallengeIssueResponse>;

/**
 * Hash preimage of a challenge (challenge_hash, stored on the request row; the token itself is
 * never stored). Verification recomputes it from the presented token + the CURRENT row, session
 * and boot, and compares in constant time. Any difference — other request, kind, binding, rev,
 * operator, session generation, boot, expiry — is the single error `challenge_invalid`.
 */
export const ChallengeBinding = z.strictObject({
	contract: z.literal(CHALLENGE_CONTRACT),
	token: Token256,
	approval_request_id: ApprovalRequestId,
	kind: ApprovalKind,
	binding_hash: Hash,
	request_rev: Rev,
	operator_id: OperatorId,
	session_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	boot_id: BootId,
	expires_at: HashedTs,
});
export type ChallengeBinding = z.infer<typeof ChallengeBinding>;

// ── decision request (wire) ────────────────────────────────────────────────

/**
 * POST /approval-requests/:id/decisions body. approve/accept: `confirmation_text` set (compared
 * exactly by confirmationMatches → 422 confirmation_mismatch), `reason` null. request_changes /
 * reject: non-empty `reason`, `confirmation_text` null. All four need a fresh challenge (stale
 * tabs cannot act). Wrong action for the kind → invalid_request.
 */
export const DecisionRequest = z
	.strictObject({
		idempotency_key: IdempotencyKey,
		kind: ApprovalKind,
		action: DecisionAction,
		expected_request_rev: Rev,
		binding_hash: Hash,
		confirmation_text: z.string().max(CONFIRMATION_MAX_CHARS).nullable(),
		reason: z
			.string()
			.max(REASON_MAX_CHARS)
			.refine(isWellFormed, "lone surrogate")
			.refine(
				(s) => isMultiLineSafe(s.replace(/\r\n/g, "\n")),
				"control characters are not allowed",
			)
			.nullable(),
		challenge: Token256,
	})
	.superRefine((r, ctx) => {
		const issue = (path: string, message: string) =>
			ctx.addIssue({ code: "custom", path: [path], message });
		if (!isActionAllowed(r.kind, r.action))
			issue("action", `\`${r.action}\` is not an action of the ${r.kind} gate`);
		if (needsConfirmation(r.action)) {
			if (r.confirmation_text === null) issue("confirmation_text", "required");
			if (r.reason !== null) issue("reason", "must be null for this action");
		} else {
			if (r.confirmation_text !== null)
				issue("confirmation_text", "must be null for this action");
			if (r.reason === null || r.reason.trim().length === 0)
				issue("reason", "a reason is required");
		}
	});
export type DecisionRequest = z.infer<typeof DecisionRequest>;

export const confirmationMatches = (r: DecisionRequest): boolean =>
	!needsConfirmation(r.action) || r.confirmation_text === CONFIRMATION_TEXT;

// ── decision payload (hashed) ──────────────────────────────────────────────

/**
 * Canonical decision payload (payload_hash). Everything the decision says, WITHOUT the challenge
 * and without the idempotency key (the key is the lookup scope, not content). `reason` is in its
 * stored form: `\r\n` → `\n`, trimmed, redacted — so the receipt row alone recomputes the hash.
 * Consequence: two raw reasons that redact to the same text are the same payload (a replay).
 */
export const DecisionPayload = z
	.strictObject({
		contract: z.literal(DECISION_CONTRACT),
		approval_request_id: ApprovalRequestId,
		kind: ApprovalKind,
		action: DecisionAction,
		expected_request_rev: Rev,
		binding_hash: Hash,
		confirmation_text: z.literal(CONFIRMATION_TEXT).nullable(),
		reason: z.string().min(1).max(8192).nullable(),
	})
	.superRefine((p, ctx) => {
		if (!isActionAllowed(p.kind, p.action))
			ctx.addIssue({ code: "custom", message: "action/kind mismatch" });
		if (needsConfirmation(p.action) !== (p.confirmation_text !== null))
			ctx.addIssue({ code: "custom", message: "confirmation/action mismatch" });
		if (needsConfirmation(p.action) !== (p.reason === null))
			ctx.addIssue({ code: "custom", message: "reason/action mismatch" });
	});
export type DecisionPayload = z.infer<typeof DecisionPayload>;

/** Stored form of a reason (also what is hashed). */
export const storedReason = (reason: string): string =>
	redact(reason.replace(/\r\n/g, "\n").trim()).trim();

/**
 * Build the hashed payload from a parsed request whose confirmation already matched. Throws if the
 * request is inconsistent (callers parse DecisionRequest first and check confirmationMatches).
 */
export function decisionPayloadFrom(
	r: DecisionRequest,
	approval_request_id: string,
): DecisionPayload {
	return DecisionPayload.parse({
		contract: DECISION_CONTRACT,
		approval_request_id,
		kind: r.kind,
		action: r.action,
		expected_request_rev: r.expected_request_rev,
		binding_hash: r.binding_hash,
		confirmation_text: needsConfirmation(r.action) ? r.confirmation_text : null,
		reason: needsConfirmation(r.action) ? null : storedReason(r.reason ?? ""),
	});
}

// ── receipt (stored verbatim, replayed verbatim) ───────────────────────────

/**
 * The full response body of a successful decision, stored in managed_decisions.response_body and
 * returned unchanged on every same-key/same-payload retry. Never hashed into anything.
 */
export const DecisionReceiptBody = z.strictObject({
	contract: z.literal(DECISION_CONTRACT),
	decision_id: DecisionId,
	approval_request_id: ApprovalRequestId,
	workspace_task_id: WorkspaceTaskId,
	kind: ApprovalKind,
	action: DecisionAction,
	operator_id: OperatorId,
	decided_at: UtcTs,
	payload_hash: Hash,
	binding_hash: Hash,
	approval_request: z.strictObject({ status: ApprovalStatus, rev: Rev }),
	workspace_task: z.strictObject({ stage: WorkspaceStage, rev: Rev }),
	effects: z.strictObject({
		managed_task_id: ManagedTaskId,
		/** Engine state right after the decision: run approve → queued; run changes/reject → cancelled; result gate → human_ready (unchanged). */
		managed_task_state: TaskState,
		/** Gate 2 only: the envelope that was accepted / declined. */
		result_envelope_hash: Hash.nullable(),
		/**
		 * v1.2 (CONTRACT_V1_2.md §B), Gate-2 accept only: the durable evidence bundle the acceptance
		 * names (sha256 of `<artifacts_root>/_sealed/<digest>.bundle`). Optional + nullable so every
		 * earlier receipt (and every other decision's receipt) still parses and replays verbatim.
		 */
		evidence_bundle_digest: Hash.nullable().optional(),
	}),
});
export type DecisionReceiptBody = z.infer<typeof DecisionReceiptBody>;

/** HTTP body of POST …/decisions. `replayed` = served from the stored receipt, no effects. */
export const DecisionResponse = z.strictObject({
	receipt: DecisionReceiptBody,
	replayed: z.boolean(),
});
export type DecisionResponse = z.infer<typeof DecisionResponse>;

// ── errors ─────────────────────────────────────────────────────────────────

/** Closed set of workspace API error codes and their HTTP status. */
export const WORKSPACE_ERROR_STATUS = {
	invalid_request: 400,
	unauthenticated: 401,
	forbidden_origin: 403,
	csrf_invalid: 403,
	forbidden_scope: 403,
	not_found: 404,
	/** One code for missing / expired / consumed / superseded / mismatched challenges. */
	challenge_invalid: 409,
	stale_binding: 409,
	invalid_state: 409,
	idempotency_conflict: 409,
	evidence_unavailable: 409,
	integrity_failed: 409,
	payload_too_large: 413,
	unsupported_media_type: 415,
	confirmation_mismatch: 422,
	live_disabled: 422,
	repo_not_allowed: 422,
	disabled: 503,
} as const;

export type WorkspaceErrorCode = keyof typeof WORKSPACE_ERROR_STATUS;
export const WorkspaceErrorCode = z.enum(
	Object.keys(WORKSPACE_ERROR_STATUS) as [
		WorkspaceErrorCode,
		...WorkspaceErrorCode[],
	],
);

export const workspaceErrorStatus = (code: WorkspaceErrorCode): number =>
	WORKSPACE_ERROR_STATUS[code];

/** Error body (same shape as the existing managed API: `{ error, message, issues? }`). */
export const WorkspaceErrorBody = z.strictObject({
	error: WorkspaceErrorCode,
	message: z.string().max(500),
	issues: z
		.array(z.strictObject({ path: z.string(), message: z.string() }))
		.max(20)
		.optional(),
});
export type WorkspaceErrorBody = z.infer<typeof WorkspaceErrorBody>;
