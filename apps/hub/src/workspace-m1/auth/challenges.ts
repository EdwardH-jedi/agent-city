// ChallengePort (role 03): single-use approval challenges stored as H(ChallengeBinding) on the
// approval-request row (INTERFACE.md §7). Both methods run INSIDE the caller's WorkspaceTx (one
// BEGIN IMMEDIATE), use only the `now` they are given, and never log anything.
//
//   issue            request pending → token (32 CSPRNG bytes, returned once) → CAS update at
//                    request.rev: challenge_status issued + hash + bound fields, rev → rev + 1.
//                    Supersedes any earlier challenge (its hash no longer matches).
//   verifyAndConsume explicit field checks + `challengeValid` (recomputes the hash from the presented
//                    token and the CURRENT row/session/boot, constant-time compare, expiry, status).
//                    Failure → `challenge_invalid`, NOTHING written (R-A2). Success → CAS update at
//                    request.rev: challenge_status consumed, rev → rev + 1.
//
// Rev arithmetic for 04: the decision tx sees the row at r = challenge_request_rev; the consume
// leaves it at r + 1 (returned as `request`); 04's own status update must CAS at r + 1 → r + 2.
// Through the plain port type, re-read with `tx.getApprovalRequest(id)` after `ok: true`.
//
// The challenge is never consumed or rejected in middleware: 04 calls verifyAndConsume only after its
// receipt lookup, so a same-key retry of a completed decision still finds its receipt first.
import type {
	ApprovalRequestRow,
	ChallengePort,
	VerifiedAuthContext,
	WorkspaceErrorCode,
	WorkspaceTx,
} from "@agent-city/schema/workspace-m1";
import { ChallengeIssueResponse } from "@agent-city/schema/workspace-m1";
import {
	challengeHash,
	challengeValid,
	newToken256,
} from "@agent-city/schema/workspace-m1/hash";
import type { SessionRecord, SessionStore } from "./sessions.ts";

/** Thrown by `issue` (inside the tx → rollback). 04 maps `code` with WORKSPACE_ERROR_STATUS. */
export class ChallengePortError extends Error {
	readonly code: Extract<
		WorkspaceErrorCode,
		"unauthenticated" | "forbidden_scope" | "invalid_state" | "stale_binding"
	>;
	constructor(code: ChallengePortError["code"]) {
		super(`challenge issuance refused: ${code}`);
		this.name = "ChallengePortError";
		this.code = code;
	}
}

export type VerifyResult =
	| { ok: true; request: ApprovalRequestRow }
	| { ok: false; code: "challenge_invalid" };

const INVALID = { ok: false, code: "challenge_invalid" } as const;

export interface ChallengeDeps {
	sessions: SessionStore;
	/** The session that minted a VerifiedAuthContext (per auth instance; forged contexts are absent). */
	sessionOf(auth: VerifiedAuthContext): SessionRecord | undefined;
	ttl_ms: number;
}

export class WorkspaceChallenges implements ChallengePort {
	readonly #deps: ChallengeDeps;

	constructor(deps: ChallengeDeps) {
		this.#deps = deps;
	}

	get ttl_ms(): number {
		return this.#deps.ttl_ms;
	}

	/** Minted by this auth instance, session still live at `now`, decide scope, this boot. */
	#authorized(auth: VerifiedAuthContext, now: Date): boolean {
		const session = this.#deps.sessionOf(auth);
		return (
			session !== undefined &&
			session.principal === auth.principal &&
			this.#deps.sessions.isLive(session, now.getTime()) &&
			auth.principal.boot_id === this.#deps.sessions.boot_id &&
			auth.principal.scopes.includes("workspace:decide")
		);
	}

	issue(
		tx: WorkspaceTx,
		request: ApprovalRequestRow,
		auth: VerifiedAuthContext,
		now: Date,
	): ChallengeIssueResponse {
		const session = this.#deps.sessionOf(auth);
		if (
			session === undefined ||
			!this.#deps.sessions.isLive(session, now.getTime())
		)
			throw new ChallengePortError("unauthenticated");
		if (!this.#authorized(auth, now))
			throw new ChallengePortError("forbidden_scope");
		if (request.status !== "pending")
			throw new ChallengePortError("invalid_state");

		const token = newToken256();
		const request_rev = request.rev + 1;
		const issued_at = now.toISOString();
		const expires_at = new Date(
			now.getTime() + this.#deps.ttl_ms,
		).toISOString();
		const p = auth.principal;
		const challenge_hash = challengeHash({
			token,
			approval_request_id: request.id,
			kind: request.kind,
			binding_hash: request.binding_hash,
			request_rev,
			operator_id: p.operator_id,
			session_generation: p.session_generation,
			boot_id: p.boot_id,
			expires_at,
		});
		const updated = tx.updateApprovalRequest(
			request.id,
			request.rev,
			{
				challenge_status: "issued",
				challenge_hash,
				challenge_operator_id: p.operator_id,
				challenge_session_generation: p.session_generation,
				challenge_boot_id: p.boot_id,
				challenge_request_rev: request_rev,
				challenge_issued_at: issued_at,
				challenge_expires_at: expires_at,
			},
			issued_at,
		);
		if (updated === null) throw new ChallengePortError("stale_binding");
		if (
			updated.rev !== request_rev ||
			updated.id !== request.id ||
			updated.kind !== request.kind ||
			updated.binding_hash !== request.binding_hash ||
			updated.challenge_hash !== challenge_hash
		)
			// a store that does not bump rev by exactly one would make the challenge unverifiable
			throw new Error("approval request store violated the CAS contract");
		return ChallengeIssueResponse.parse({
			approval_request_id: request.id,
			kind: request.kind,
			binding_hash: request.binding_hash,
			request_rev,
			challenge: token,
			expires_at,
		});
	}

	verifyAndConsume(
		tx: WorkspaceTx,
		request: ApprovalRequestRow,
		presented: string,
		auth: VerifiedAuthContext,
		now: Date,
	): VerifyResult {
		if (typeof presented !== "string") return INVALID;
		if (!this.#authorized(auth, now)) return INVALID;
		const p = auth.principal;
		const boot_id = this.#deps.sessions.boot_id;
		if (
			request.status !== "pending" ||
			request.challenge_status !== "issued" ||
			request.challenge_boot_id !== boot_id ||
			request.challenge_operator_id !== p.operator_id ||
			request.challenge_session_generation !== p.session_generation ||
			request.challenge_request_rev !== request.rev ||
			request.challenge_issued_at === null ||
			request.challenge_expires_at === null
		)
			return INVALID;
		const issuedMs = Date.parse(request.challenge_issued_at);
		const expiresMs = Date.parse(request.challenge_expires_at);
		// a row whose window is longer than the configured TTL was not written by this issuer
		if (
			!Number.isFinite(issuedMs) ||
			!Number.isFinite(expiresMs) ||
			expiresMs - issuedMs > this.#deps.ttl_ms ||
			expiresMs - now.getTime() > this.#deps.ttl_ms
		)
			return INVALID;
		const valid = challengeValid({
			presented,
			stored_hash: request.challenge_hash,
			status: request.challenge_status,
			expires_at: request.challenge_expires_at,
			now,
			binding: {
				approval_request_id: request.id,
				kind: request.kind,
				binding_hash: request.binding_hash,
				request_rev: request.rev,
				operator_id: p.operator_id,
				session_generation: p.session_generation,
				boot_id,
			},
		});
		if (!valid) return INVALID;
		const updated = tx.updateApprovalRequest(
			request.id,
			request.rev,
			{ challenge_status: "consumed" },
			now.toISOString(),
		);
		// inside BEGIN IMMEDIATE a CAS miss means the caller passed a stale row: nothing was written
		if (updated === null) return INVALID;
		if (
			updated.challenge_status !== "consumed" ||
			updated.rev !== request.rev + 1
		)
			throw new Error("approval request store violated the CAS contract");
		return { ok: true, request: updated };
	}
}
