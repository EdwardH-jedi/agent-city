// Decision attempts (role 07): outcome classification, retry-key reuse, reconciliation.
import { describe, expect, test } from "bun:test";
import type {
	DecisionResponse,
	DecisionView,
} from "@agent-city/schema/workspace-m1";
import {
	beginRetry,
	blocksNewDecision,
	canRetry,
	newIdempotencyKey,
	reconcileWithServer,
	settleAttempt,
	startAttempt,
} from "./decision-attempt.ts";
import type { TransportResult } from "./transport.ts";

const REQ = "wsa-00000000-0000-4000-8000-000000000001";
const base = () =>
	startAttempt({
		requestId: REQ,
		taskId: "wst-00000000-0000-4000-8000-000000000002",
		kind: "run",
		action: "approve",
		idempotencyKey: "dk-fixed-key-1",
		body: '{"idempotency_key":"dk-fixed-key-1"}',
		authGen: 1,
	});

const okResult = (action = "approve"): TransportResult<DecisionResponse> =>
	({
		ok: true,
		status: 201,
		data: { receipt: { approval_request_id: REQ, action }, replayed: false },
	}) as unknown as TransportResult<DecisionResponse>;

describe("classification", () => {
	test("contract error = definitive failure; no answer / bad answer = unknown", () => {
		expect(settleAttempt(base(), okResult()).status).toBe("committed");
		expect(
			settleAttempt(base(), {
				ok: false,
				kind: "http",
				status: 409,
				error: { error: "stale_binding", message: "x" },
			}).status,
		).toBe("failed");
		expect(
			settleAttempt(base(), { ok: false, kind: "network", message: "reset" })
				.status,
		).toBe("unknown");
		expect(
			settleAttempt(base(), {
				ok: false,
				kind: "invalid_response",
				status: 500,
				message: "x",
			}).status,
		).toBe("unknown");
	});

	test("a receipt for another action is reported as decided elsewhere", () => {
		expect(settleAttempt(base(), okResult("reject")).decidedElsewhere).toBe(
			true,
		);
	});
});

describe("retry (hazard 2)", () => {
	test("retry keeps the key and the exact bytes; only the counter moves", () => {
		const unknown = settleAttempt(base(), {
			ok: false,
			kind: "network",
			message: "reset",
		});
		expect(canRetry(unknown)).toBe(true);
		expect(blocksNewDecision(unknown)).toBe(true);
		const again = beginRetry(unknown);
		expect(again.idempotencyKey).toBe("dk-fixed-key-1");
		expect(again.body).toBe(base().body);
		expect(again.sends).toBe(2);
		expect(again.status).toBe("in_flight");
	});

	test("challenge_invalid on a retry means: not recorded, decide again", () => {
		const retried = beginRetry(
			settleAttempt(base(), { ok: false, kind: "network", message: "reset" }),
		);
		const r = settleAttempt(retried, {
			ok: false,
			kind: "http",
			status: 409,
			error: { error: "challenge_invalid", message: "x" },
		});
		expect(r.status).toBe("failed");
		expect(r.error?.message).toContain("not recorded");
		expect(blocksNewDecision(r)).toBe(false);
	});

	test("keys are fresh per new attempt and match the contract pattern", () => {
		let n = 0;
		const k1 = newIdempotencyKey("dk", () => `r${++n}-abcdef`);
		const k2 = newIdempotencyKey("dk", () => `r${++n}-abcdef`);
		expect(k1).not.toBe(k2);
		expect(/^[A-Za-z0-9._-]{8,128}$/.test(newIdempotencyKey("dk"))).toBe(true);
	});
});

describe("reconciliation from a fresh read (OQ-13)", () => {
	const unknown = settleAttempt(base(), {
		ok: false,
		kind: "network",
		message: "reset",
	});
	const decision = {
		approval_request_id: REQ,
		action: "approve",
	} as DecisionView;

	test("still pending → still unknown", () => {
		expect(
			reconcileWithServer(unknown, { id: REQ, status: "pending" }, []).status,
		).toBe("unknown");
	});
	test("a durable decision → committed", () => {
		expect(
			reconcileWithServer(unknown, { id: REQ, status: "approved" }, [decision])
				.status,
		).toBe("committed");
	});
	test("closed without a decision → failed", () => {
		expect(
			reconcileWithServer(unknown, { id: REQ, status: "invalidated" }, [])
				.status,
		).toBe("failed");
	});
	test("only unknown attempts are reconciled", () => {
		const done = settleAttempt(base(), okResult());
		expect(
			reconcileWithServer(done, { id: REQ, status: "invalidated" }, []),
		).toBe(done);
	});
});
