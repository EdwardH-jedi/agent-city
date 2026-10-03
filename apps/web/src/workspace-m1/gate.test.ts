// Gate state (role 07): subject identity, signature exactness, clearing rules, decision bodies.
import { describe, expect, test } from "bun:test";
import {
	type ApprovalRequestView,
	DecisionRequest,
} from "@agent-city/schema/workspace-m1";
import {
	buildDecisionBody,
	challengeReady,
	clearSignature,
	declineBlockers,
	expireIfNeeded,
	type GateContext,
	type GateState,
	gateSubjectKey,
	grantBlockers,
	isExactSignature,
	openGate,
	setReason,
	setSignature,
	syncGate,
} from "./gate.ts";

const H = (c: string) => c.repeat(64);
const REQ = "wsa-00000000-0000-4000-8000-000000000001";
const TASK = "wst-00000000-0000-4000-8000-000000000002";

function request(over: Partial<ApprovalRequestView> = {}): ApprovalRequestView {
	return {
		id: REQ,
		workspace_task_id: TASK,
		kind: "run",
		binding_hash: H("b"),
		status: "pending",
		rev: 3,
		invalidation_reason: null,
		...over,
	} as ApprovalRequestView;
}

const T = Date.parse("2026-10-02T00:00:00.000Z");
const ctx = (over: Partial<GateContext> = {}): GateContext => ({
	now: T,
	online: true,
	canDecide: true,
	busy: false,
	pending: true,
	...over,
});

function ready(g: GateState, rev = 4): GateState {
	return challengeReady(g, {
		approval_request_id: REQ,
		kind: g.kind,
		binding_hash: g.bindingHash,
		request_rev: rev,
		challenge: "c".repeat(43),
		expires_at: new Date(T + 300_000).toISOString(),
	});
}

describe("subject identity (hazard 1)", () => {
	test("the subject key ignores rev", () => {
		expect(gateSubjectKey(request({ rev: 3 }))).toBe(
			gateSubjectKey(request({ rev: 9 })),
		);
		expect(gateSubjectKey(request())).not.toBe(
			gateSubjectKey(request({ status: "invalidated" })),
		);
		expect(gateSubjectKey(request())).not.toBe(
			gateSubjectKey(request({ binding_hash: H("c") })),
		);
	});

	test("our own challenge's rev bump keeps the signature and the challenge", () => {
		const g = ready(setSignature(openGate(request()), "Edward"), 4);
		const after = syncGate(g, request({ rev: 4 }));
		expect(after?.signature).toBe("Edward");
		expect(after?.challenge.phase).toBe("ready");
		expect(after?.knownRev).toBe(4);
	});

	test("invalidation or a decided status resets the gate with an explanation", () => {
		const g = ready(setSignature(openGate(request()), "Edward"));
		const inv = syncGate(
			g,
			request({
				status: "invalidated",
				invalidation_reason: "proposal_superseded",
			}),
		);
		expect(inv?.signature).toBe("");
		expect(inv?.challenge.phase).toBe("none");
		expect(inv?.notice).toContain("newer proposal version");
		const decided = syncGate(g, request({ status: "approved" }));
		expect(decided?.signature).toBe("");
		expect(decided?.notice).toContain("approved");
	});

	test("a read of another request never touches this gate", () => {
		const g = setSignature(openGate(request()), "Edward");
		expect(
			syncGate(g, request({ id: "wsa-00000000-0000-4000-8000-000000000009" })),
		).toBe(g);
	});

	test("a challenge answer for another subject is ignored", () => {
		const g = openGate(request());
		const other = challengeReady(g, {
			approval_request_id: REQ,
			kind: "run",
			binding_hash: H("d"),
			request_rev: 4,
			challenge: "c".repeat(43),
			expires_at: new Date(T + 1000).toISOString(),
		});
		expect(other.challenge.phase).toBe("none");
	});
});

describe("signature exactness and enabling", () => {
	test("only exactly Edward counts (R-18)", () => {
		for (const v of [
			"edward",
			"EDWARD",
			" Edward",
			"Edward ",
			"Edwards",
			"Edward\t",
			"Edwardx",
			"",
		])
			expect(isExactSignature(v)).toBe(false);
		expect(isExactSignature("Edward")).toBe(true);
	});

	test("Approve needs exact Edward AND a ready, unexpired challenge", () => {
		const g = openGate(request());
		expect(grantBlockers(setSignature(g, "Edward"), ctx())).toContain(
			"No approval window is open yet.",
		);
		const r = ready(setSignature(g, "Edward"));
		expect(grantBlockers(r, ctx())).toEqual([]);
		expect(grantBlockers(setSignature(r, "edward"), ctx()).length).toBe(1);
		expect(grantBlockers(r, ctx({ online: false })).length).toBe(1);
		expect(grantBlockers(r, ctx({ busy: true })).length).toBe(1);
		expect(grantBlockers(r, ctx({ canDecide: false })).length).toBe(1);
		expect(grantBlockers(r, ctx({ now: T + 300_000 }))).toEqual([
			"The approval window expired.",
		]);
	});

	test("Request changes / Reject need a reason (no signature)", () => {
		const g = ready(openGate(request()));
		expect(declineBlockers(g, ctx())).toEqual(["Enter a decision reason."]);
		expect(declineBlockers(setReason(g, "   "), ctx())).toEqual([
			"Enter a decision reason.",
		]);
		expect(declineBlockers(setReason(g, "Narrow the scope"), ctx())).toEqual(
			[],
		);
	});
});

describe("clearing rules", () => {
	test("success clears signature and reason; errors keep the reason", () => {
		const g = setReason(
			ready(setSignature(openGate(request()), "Edward")),
			"why",
		);
		const ok = clearSignature(g, "submitted");
		expect([ok.signature, ok.reason, ok.challenge.phase]).toEqual([
			"",
			"",
			"none",
		]);
		const err = clearSignature(g, "error", "x");
		expect([err.signature, err.reason, err.challenge.phase]).toEqual([
			"",
			"why",
			"none",
		]);
	});

	test("expiry clears the signature at the deadline, not before", () => {
		const g = ready(setSignature(openGate(request()), "Edward"));
		expect(expireIfNeeded(g, T + 299_999)).toBe(g);
		const expired = expireIfNeeded(g, T + 300_000);
		expect(expired.signature).toBe("");
		expect(expired.notice).toContain("expired");
	});
});

describe("decision bodies (hazard 3)", () => {
	test("approve: exact confirmation, reason null, rev from the challenge", () => {
		const g = ready(setSignature(openGate(request()), "Edward"), 4);
		const b = buildDecisionBody(g, "approve", "dk-test-0001");
		expect(b.ok).toBe(true);
		if (!b.ok) return;
		const parsed = DecisionRequest.parse(JSON.parse(b.body));
		expect(parsed).toEqual({
			idempotency_key: "dk-test-0001",
			kind: "run",
			action: "approve",
			expected_request_rev: 4,
			binding_hash: H("b"),
			confirmation_text: "Edward",
			reason: null,
			challenge: "c".repeat(43),
		});
	});

	test('reject: confirmation_text is null (never ""), reason set', () => {
		const g = setReason(
			ready(setSignature(openGate(request()), "edward")),
			"Too broad",
		);
		const b = buildDecisionBody(g, "reject", "dk-test-0002");
		expect(b.ok).toBe(true);
		if (!b.ok) return;
		const json = JSON.parse(b.body);
		expect(json.confirmation_text).toBeNull();
		expect(json.reason).toBe("Too broad");
	});

	test("refuses without a challenge, with a wrong signature or a foreign action", () => {
		const g = setSignature(openGate(request()), "Edward");
		expect(buildDecisionBody(g, "approve", "dk-test-0003").ok).toBe(false);
		expect(
			buildDecisionBody(
				ready(setSignature(g, "Edward ")),
				"approve",
				"dk-test-0003",
			).ok,
		).toBe(false);
		expect(buildDecisionBody(ready(g), "accept", "dk-test-0003").ok).toBe(
			false,
		);
	});
});
