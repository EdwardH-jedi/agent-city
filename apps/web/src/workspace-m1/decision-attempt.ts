// One decision attempt per approval request (role 07). Pure; no React.
//
// Hazard 2 (lead): an uncertain outcome ("Decision outcome unknown") is retried by resending the
// BYTE-IDENTICAL body — same idempotency_key, same expected_request_rev, same challenge — without
// fetching a new challenge first. The key is reused until the outcome is reconciled: the server
// looks the receipt up by (operator, key) BEFORE checking the (by then consumed) challenge, so a
// committed decision replays and an uncommitted one is decided once.
import type {
	ApprovalKind,
	ApprovalRequestView,
	DecisionAction,
	DecisionReceiptBody,
	DecisionResponse,
	DecisionView,
} from "@agent-city/schema/workspace-m1";
import { errorCopy } from "./labels.ts";
import type { TransportResult } from "./transport.ts";

export type AttemptStatus = "in_flight" | "unknown" | "committed" | "failed";

export interface DecisionAttempt {
	requestId: string;
	taskId: string;
	kind: ApprovalKind;
	action: DecisionAction;
	idempotencyKey: string;
	/** The serialized DecisionRequest; retries send exactly these bytes. */
	body: string;
	status: AttemptStatus;
	/** Auth generation the attempt belongs to; another generation never sees its outcome. */
	authGen: number;
	sends: number;
	receipt: DecisionReceiptBody | null;
	replayed: boolean;
	/** The committed decision was not this attempt's action (decided in another tab). */
	decidedElsewhere: boolean;
	error: { code: string; message: string } | null;
}

export function startAttempt(a: {
	requestId: string;
	taskId: string;
	kind: ApprovalKind;
	action: DecisionAction;
	idempotencyKey: string;
	body: string;
	authGen: number;
}): DecisionAttempt {
	return {
		...a,
		status: "in_flight",
		sends: 1,
		receipt: null,
		replayed: false,
		decidedElsewhere: false,
		error: null,
	};
}

/** Classify one answer: contract error = definitive (no effect); anything else = unknown. */
export function settleAttempt(
	a: DecisionAttempt,
	r: TransportResult<DecisionResponse>,
): DecisionAttempt {
	if (r.ok) {
		const same =
			r.data.receipt.approval_request_id === a.requestId &&
			r.data.receipt.action === a.action;
		return {
			...a,
			status: "committed",
			receipt: r.data.receipt,
			replayed: r.data.replayed,
			decidedElsewhere: !same,
			error: null,
		};
	}
	if (r.kind === "http") {
		const code = r.error.error;
		const message =
			a.sends > 1 && code === "challenge_invalid"
				? "The decision was not recorded (its approval window is no longer valid). Type Edward again to decide."
				: errorCopy(code, r.error.message);
		return { ...a, status: "failed", error: { code, message } };
	}
	return {
		...a,
		status: "unknown",
		error: { code: r.kind, message: "No answer from the hub." },
	};
}

export const canRetry = (a: DecisionAttempt | undefined): boolean =>
	a?.status === "unknown";

/** Same key, same bytes; only the send counter moves. */
export function beginRetry(a: DecisionAttempt): DecisionAttempt {
	return { ...a, status: "in_flight", sends: a.sends + 1, error: null };
}

/** In flight or unknown: no other decision (with another key) may start for this request. */
export const blocksNewDecision = (a: DecisionAttempt | undefined): boolean =>
	a?.status === "in_flight" || a?.status === "unknown";

/**
 * P2 F-03: the hub's receipt of a committed decision closes exactly the request it names — same request
 * id and binding hash, and only until a read of that request newer than the receipt (higher rev) speaks
 * for it. It closes the confirmation controls at once, before any follow-up read; it says nothing about
 * the pipeline beyond what the receipt records. An unknown outcome has no receipt and closes nothing.
 */
export function closingReceipt(
	a: DecisionAttempt | undefined,
	request: Pick<ApprovalRequestView, "id" | "binding_hash" | "rev"> | null,
): DecisionReceiptBody | null {
	const r = a?.status === "committed" ? a.receipt : null;
	if (!r || !request || a?.requestId !== request.id) return null;
	if (r.approval_request_id !== request.id) return null;
	if (r.binding_hash !== request.binding_hash) return null;
	if (request.rev > r.approval_request.rev) return null;
	return r;
}

/**
 * Reconcile an UNKNOWN attempt from a fresh read of its task (a read also shows the durable
 * decision — OQ-13). Pending → still unknown (retry with the same bytes); decided → committed;
 * closed without a decision → failed.
 */
export function reconcileWithServer(
	a: DecisionAttempt,
	request: { id: string; status: string } | null,
	decisions: readonly DecisionView[],
): DecisionAttempt {
	if (a.status !== "unknown" || !request || request.id !== a.requestId)
		return a;
	const d = decisions.find((x) => x.approval_request_id === a.requestId);
	if (d)
		return {
			...a,
			status: "committed",
			decidedElsewhere: d.action !== a.action,
			error: null,
		};
	if (request.status !== "pending")
		return {
			...a,
			status: "failed",
			error: {
				code: "invalid_state",
				message: "The request closed without this decision being recorded.",
			},
		};
	return a;
}

/** Client retry key ([A-Za-z0-9._-]{8,128}); never derived from secrets. */
export function newIdempotencyKey(
	prefix: string,
	random: () => string = () => crypto.randomUUID(),
): string {
	return `${prefix}-${random()}`;
}
