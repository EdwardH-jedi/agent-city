// Command outcomes and error mapping for the workspace decision/command services (role 04).
//
// Every failure is a WorkspaceErrorBody with a FIXED message per code (nothing from the request is
// echoed: no values, no unknown key names). Zod issues are reduced to safe paths + fixed messages.
// `DecisionAbort` is thrown inside a store transaction after a point of no return (e.g. after the
// challenge was consumed) so the whole transaction rolls back; it is mapped to a response only
// OUTSIDE `store.transaction`.
import {
	type CommandOutcome,
	WORKSPACE_ERROR_STATUS,
	type WorkspaceErrorBody,
	type WorkspaceErrorCode,
} from "@agent-city/schema/workspace-m1";
import type { z } from "zod";
import { ChallengePortError } from "../auth/index.ts";
import {
	ManagedWriteError,
	WorkspaceConflictError,
	WorkspaceIntegrityError,
	WorkspaceRowError,
} from "../persistence/index.ts";

export type Issue = { path: string; message: string };

const MESSAGES: Readonly<Record<WorkspaceErrorCode, string>> = {
	invalid_request: "invalid request",
	unauthenticated: "sign-in required",
	forbidden_origin: "request origin is not allowed",
	csrf_invalid: "missing or invalid CSRF token",
	forbidden_scope: "this session may not perform this operation",
	not_found: "not found",
	challenge_invalid: "the approval challenge is not valid for this decision",
	stale_binding:
		"the subject changed since it was loaded; reload and review it again",
	invalid_state: "this operation is not possible in the current state",
	idempotency_conflict:
		"this idempotency key was already used with a different request",
	evidence_unavailable:
		"the evidence cannot be verified right now; nothing was changed",
	integrity_failed: "the evidence failed its integrity check",
	payload_too_large: "request body too large",
	unsupported_media_type: "content-type must be application/json",
	confirmation_mismatch: "the confirmation does not match",
	live_disabled: "live execution is disabled; only simulated mode is allowed",
	repo_not_allowed: "the repository is not available for workspace tasks",
	disabled: "workspace API is disabled",
};

export const ok = <T>(status: number, body: T): CommandOutcome<T> => ({
	ok: true,
	status,
	body,
});

export function fail(
	code: WorkspaceErrorCode,
	issues?: readonly Issue[],
): { ok: false; status: number; body: WorkspaceErrorBody } {
	const body: WorkspaceErrorBody = { error: code, message: MESSAGES[code] };
	if (issues && issues.length > 0) body.issues = issues.slice(0, 20);
	return { ok: false, status: WORKSPACE_ERROR_STATUS[code], body };
}

const SAFE_SEGMENT = /^[a-z0-9_]{1,64}$/;

/** Safe, bounded issue list: known snake_case path segments only; fixed messages per issue code. */
export function issuesOf(error: z.ZodError): Issue[] {
	return error.issues.slice(0, 20).map((i) => {
		const path = i.path
			.slice(0, 8)
			.map((s) =>
				typeof s === "number"
					? String(s)
					: typeof s === "string" && SAFE_SEGMENT.test(s)
						? s
						: "?",
			)
			.join(".");
		let message: string;
		switch (i.code) {
			case "unrecognized_keys":
				message = "unknown field";
				break;
			case "invalid_type":
				message = "wrong type or missing";
				break;
			case "too_big":
				message = "too long or too large";
				break;
			case "too_small":
				message = "too short, too small or empty";
				break;
			case "invalid_format":
				message = "invalid format";
				break;
			case "invalid_value":
				message = "value not allowed";
				break;
			case "custom":
				// contract-authored refinement text (enum-validated values only); bounded
				message = i.message.slice(0, 200);
				break;
			default:
				message = "invalid value";
		}
		return { path: path || "(body)", message };
	});
}

/** Thrown inside a transaction to roll everything back; mapped to `code` outside the transaction. */
export class DecisionAbort extends Error {
	constructor(
		readonly code: WorkspaceErrorCode,
		detail: string,
	) {
		super(`decision aborted (${code}): ${detail}`);
		this.name = "DecisionAbort";
	}
}

/** The response body could not be validated against its contract schema → 500, no data. */
export class ResponseContractError extends Error {
	constructor(what: string) {
		super(`response failed its contract: ${what}`);
		this.name = "ResponseContractError";
	}
}

/**
 * Known typed failures → a typed workspace error. Everything else returns null (the caller lets it
 * propagate → 500 without data). Messages are never forwarded to the client.
 */
export function mapKnownError(
	err: unknown,
): { ok: false; status: number; body: WorkspaceErrorBody } | null {
	if (err instanceof DecisionAbort) return fail(err.code);
	if (err instanceof ChallengePortError) return fail(err.code);
	if (err instanceof WorkspaceIntegrityError) return fail("integrity_failed");
	if (err instanceof WorkspaceConflictError) return fail("stale_binding");
	if (err instanceof WorkspaceRowError) return fail("invalid_state");
	if (err instanceof ManagedWriteError)
		switch (err.code) {
			case "repo_not_allowed":
				return fail("repo_not_allowed");
			case "not_found":
				return fail("not_found");
			case "idempotency_conflict":
			case "proposal_hash_mismatch":
			case "proposal_not_stored":
			case "decision_mismatch":
				return fail("stale_binding");
			case "submission_altered":
				return fail("invalid_request");
			default:
				return fail("invalid_state");
		}
	return null;
}
