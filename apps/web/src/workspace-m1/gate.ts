// Approval-gate state of the ONE open approval document (role 07). Pure; no React.
//
// Hazard 1 (lead): issuing a challenge bumps the request `rev`, so "the subject changed" is decided
// on (request_id, binding_hash, status) and NEVER on rev. The rev returned with the challenge is
// kept only for the decision body (`expected_request_rev`).
//
// The signature is request-local, typed fresh, compared exactly (no trim, no normalization). It is
// cleared on subject change, gate change, successful submission, expiry, invalidation, relevant
// errors, going offline and any sign-out / auth-generation change (the store drops the whole gate).
import {
	type ApprovalKind,
	type ApprovalRequestView,
	type ChallengeIssueResponse,
	CONFIRMATION_TEXT,
	type DecisionAction,
	DecisionRequest,
	isActionAllowed,
	needsConfirmation,
	REASON_MAX_CHARS,
} from "@agent-city/schema/workspace-m1";
import { APPROVAL_STATUS_LABEL, invalidationLabel } from "./labels.ts";

export type SubjectRef = Pick<
	ApprovalRequestView,
	"id" | "binding_hash" | "status"
>;

/** (request_id, binding_hash, status) — never rev. */
export const gateSubjectKey = (r: SubjectRef): string =>
	`${r.id}|${r.binding_hash}|${r.status}`;

export type ChallengePhase =
	| { phase: "none" }
	| { phase: "loading" }
	| { phase: "ready"; token: string; requestRev: number; expiresAt: string }
	| { phase: "failed"; message: string };

export interface GateState {
	requestId: string;
	taskId: string;
	kind: ApprovalKind;
	bindingHash: string;
	subject: string;
	/** Typed signature (request-local). */
	signature: string;
	/** Decision reason (request changes / reject). */
	reason: string;
	challenge: ChallengePhase;
	/** Highest request rev known: the view's rev or the rev returned with our challenge. */
	knownRev: number;
	/** Why the signature was last cleared (shown next to the field). */
	notice: string | null;
}

export type ClearCause =
	| "subject_changed"
	| "submitted"
	| "expired"
	| "error"
	| "offline";

export function openGate(r: ApprovalRequestView): GateState {
	return {
		requestId: r.id,
		taskId: r.workspace_task_id,
		kind: r.kind,
		bindingHash: r.binding_hash,
		subject: gateSubjectKey(r),
		signature: "",
		reason: "",
		challenge: { phase: "none" },
		knownRev: r.rev,
		notice: null,
	};
}

/** Empties the signature and drops the challenge (consumed, invalid or no longer trusted). */
export function clearSignature(
	g: GateState,
	cause: ClearCause,
	notice: string | null = null,
): GateState {
	return {
		...g,
		signature: "",
		reason: cause === "submitted" ? "" : g.reason,
		challenge: { phase: "none" },
		notice,
	};
}

/**
 * Apply a fresh read of the request. Same subject (even with a higher rev, e.g. our own challenge)
 * keeps everything; a different binding or status resets the gate with an explanation.
 */
export function syncGate(
	g: GateState | null,
	r: ApprovalRequestView | null,
): GateState | null {
	if (!g || !r || r.id !== g.requestId) return g;
	const key = gateSubjectKey(r);
	if (key === g.subject)
		return r.rev > g.knownRev ? { ...g, knownRev: r.rev } : g;
	let notice = "The request changed; the signature was cleared.";
	const why = r.status === "invalidated" ? invalidationLabel(r) : null;
	if (why)
		notice = `This request was invalidated: ${why}. The signature was cleared.`;
	else if (r.status !== "pending")
		notice = `This request is ${APPROVAL_STATUS_LABEL[r.status].toLowerCase()}. The signature was cleared.`;
	return { ...openGate(r), reason: "", notice };
}

export const setSignature = (g: GateState, text: string): GateState => ({
	...g,
	signature: text,
	notice: null,
});

export const setReason = (g: GateState, text: string): GateState => ({
	...g,
	reason: text,
});

export const challengeLoading = (g: GateState): GateState => ({
	...g,
	challenge: { phase: "loading" },
});

export function challengeReady(
	g: GateState,
	c: ChallengeIssueResponse,
): GateState {
	if (c.approval_request_id !== g.requestId || c.binding_hash !== g.bindingHash)
		return g;
	return {
		...g,
		challenge: {
			phase: "ready",
			token: c.challenge,
			requestRev: c.request_rev,
			expiresAt: c.expires_at,
		},
		knownRev: Math.max(g.knownRev, c.request_rev),
	};
}

export const challengeFailed = (g: GateState, message: string): GateState => ({
	...g,
	challenge: { phase: "failed", message },
});

export const isExactSignature = (text: string): boolean =>
	text === CONFIRMATION_TEXT;

export function challengeExpired(g: GateState, now: number): boolean {
	return (
		g.challenge.phase === "ready" && Date.parse(g.challenge.expiresAt) <= now
	);
}

/** Clears the signature once the challenge expired (rule: clear on expiry). */
export function expireIfNeeded(g: GateState, now: number): GateState {
	return challengeExpired(g, now)
		? clearSignature(
				g,
				"expired",
				"The approval window expired and the signature was cleared. Type Edward again to continue.",
			)
		: g;
}

export interface GateContext {
	now: number;
	online: boolean;
	canDecide: boolean;
	/** A decision for this request is in flight or its outcome is unknown. */
	busy: boolean;
	/** The request is still pending. */
	pending: boolean;
}

function commonBlockers(g: GateState, ctx: GateContext): string[] {
	const out: string[] = [];
	if (!ctx.pending) out.push("This request is no longer pending.");
	if (!ctx.canDecide) out.push("This session may read but not decide.");
	if (!ctx.online)
		out.push("Offline: decisions are disabled until the connection returns.");
	if (ctx.busy)
		out.push(
			"A decision for this request is in progress or its outcome is unknown.",
		);
	if (g.challenge.phase === "loading")
		out.push("Preparing the approval window…");
	else if (g.challenge.phase === "failed") out.push(g.challenge.message);
	else if (challengeExpired(g, ctx.now))
		out.push("The approval window expired.");
	return out;
}

const NO_WINDOW = "No approval window is open yet.";

/** Why Approve / Accept is disabled (empty = enabled). Exact `Edward` only. */
export function grantBlockers(g: GateState, ctx: GateContext): string[] {
	const out: string[] = [];
	if (!isExactSignature(g.signature))
		out.push("Type Edward exactly (case-sensitive, no spaces).");
	else if (g.challenge.phase === "none") out.push(NO_WINDOW);
	return [...out, ...commonBlockers(g, ctx)];
}

/** Why Request changes / Reject is disabled (empty = enabled). */
export function declineBlockers(g: GateState, ctx: GateContext): string[] {
	const out: string[] = [];
	if (g.reason.trim().length === 0) out.push("Enter a decision reason.");
	else if (g.reason.length > REASON_MAX_CHARS)
		out.push(`The reason is longer than ${REASON_MAX_CHARS} characters.`);
	else if (g.challenge.phase === "none") out.push(NO_WINDOW);
	return [...out, ...commonBlockers(g, ctx)];
}

/**
 * The exact decision body, serialized once. Hazard 3: `confirmation_text` is null (not "") for
 * request_changes / reject, and `reason` is null for approve / accept. Validated with the
 * contract's strict DecisionRequest before it may be sent.
 */
export function buildDecisionBody(
	g: GateState,
	action: DecisionAction,
	idempotencyKey: string,
): { ok: true; body: string } | { ok: false; message: string } {
	if (g.challenge.phase !== "ready")
		return { ok: false, message: "No approval window is open." };
	if (!isActionAllowed(g.kind, action))
		return { ok: false, message: "That action does not belong to this gate." };
	const grant = needsConfirmation(action);
	if (grant && !isExactSignature(g.signature))
		return { ok: false, message: "Type Edward exactly." };
	const candidate = {
		idempotency_key: idempotencyKey,
		kind: g.kind,
		action,
		expected_request_rev: g.challenge.requestRev,
		binding_hash: g.bindingHash,
		confirmation_text: grant ? g.signature : null,
		reason: grant ? null : g.reason,
		challenge: g.challenge.token,
	};
	const parsed = DecisionRequest.safeParse(candidate);
	if (!parsed.success)
		return {
			ok: false,
			message: parsed.error.issues[0]?.message ?? "Invalid decision.",
		};
	return { ok: true, body: JSON.stringify(parsed.data) };
}
