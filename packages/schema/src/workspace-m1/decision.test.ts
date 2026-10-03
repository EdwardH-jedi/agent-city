import { describe, expect, test } from "bun:test";
import { REDACTED } from "../redact.ts";
import { IDS, sampleGraph } from "./fixtures/sample.ts";
import { decisionPayloadHash } from "./hash.ts";
import {
	ACTIONS_BY_KIND,
	ChallengeIssueRequest,
	CONFIRMATION_TEXT,
	confirmationMatches,
	DecisionPayload,
	DecisionReceiptBody,
	DecisionRequest,
	decisionPayloadFrom,
	OperatorPrincipal,
	SessionView,
	WORKSPACE_ERROR_STATUS,
	WorkspaceErrorBody,
	WorkspaceErrorCode,
	workspaceErrorStatus,
} from "./index.ts";

const g = sampleGraph();
const approve = {
	idempotency_key: "idem-approve-0001",
	kind: "run" as const,
	action: "approve" as const,
	expected_request_rev: 2,
	binding_hash: g.runBinding.hash,
	confirmation_text: "Edward",
	reason: null,
	challenge: "c".repeat(43),
};
const reject = {
	...approve,
	idempotency_key: "idem-reject-0001",
	action: "reject" as const,
	confirmation_text: null,
	reason: "Scope is too wide, narrow it to src only.",
};

describe("DecisionRequest", () => {
	test("valid approve and reject bodies", () => {
		expect(DecisionRequest.safeParse(approve).success).toBe(true);
		expect(DecisionRequest.safeParse(reject).success).toBe(true);
		expect(
			DecisionRequest.safeParse({ ...reject, action: "request_changes" })
				.success,
		).toBe(true);
		expect(
			DecisionRequest.safeParse({
				...approve,
				kind: "result",
				action: "accept",
			}).success,
		).toBe(true);
	});

	const invalid: [string, Record<string, unknown>][] = [
		["approve at the result gate", { kind: "result" }],
		["accept at the run gate", { action: "accept" }],
		["approve without confirmation", { confirmation_text: null }],
		["approve with a reason", { reason: "because" }],
		["no challenge", { challenge: undefined }],
		["short challenge", { challenge: "abc" }],
		["challenge with padding", { challenge: `${"c".repeat(42)}=` }],
		["bad idempotency key", { idempotency_key: "short" }],
		["key with slash", { idempotency_key: "abc/defgh" }],
		["rev 0", { expected_request_rev: 0 }],
		["rev float", { expected_request_rev: 1.5 }],
		["upper-case hash", { binding_hash: g.runBinding.hash.toUpperCase() }],
		["unknown key", { operator_id: "operator:edward" }],
		["confirmation too long", { confirmation_text: "E".repeat(65) }],
	];
	for (const [name, patch] of invalid)
		test(`invalid: ${name}`, () => {
			expect(DecisionRequest.safeParse({ ...approve, ...patch }).success).toBe(
				false,
			);
		});

	test("reject / request_changes need a non-empty reason and no confirmation", () => {
		expect(DecisionRequest.safeParse({ ...reject, reason: null }).success).toBe(
			false,
		);
		expect(
			DecisionRequest.safeParse({ ...reject, reason: "  \n " }).success,
		).toBe(false);
		expect(
			DecisionRequest.safeParse({ ...reject, reason: "x".repeat(1001) })
				.success,
		).toBe(false);
		expect(
			DecisionRequest.safeParse({ ...reject, confirmation_text: "Edward" })
				.success,
		).toBe(false);
		expect(
			DecisionRequest.safeParse({ ...reject, reason: "a\u0007b" }).success,
		).toBe(false);
	});

	test("actions per gate", () => {
		expect(ACTIONS_BY_KIND.run).toEqual([
			"approve",
			"request_changes",
			"reject",
		]);
		expect(ACTIONS_BY_KIND.result).toEqual([
			"accept",
			"request_changes",
			"reject",
		]);
	});
});

describe("confirmation is exact", () => {
	const ok = (text: string) =>
		confirmationMatches(
			DecisionRequest.parse({ ...approve, confirmation_text: text }),
		);
	test("only `Edward` matches", () => {
		expect(CONFIRMATION_TEXT).toBe("Edward");
		expect(ok("Edward")).toBe(true);
		for (const wrong of [
			"edward",
			"EDWARD",
			"Edward ",
			" Edward",
			"Edward\t",
			"Edwrd",
			"",
			"Е dward",
			"Edward​",
		])
			expect(ok(wrong)).toBe(false);
	});
	test("reasons-only actions need no confirmation", () => {
		expect(confirmationMatches(DecisionRequest.parse(reject))).toBe(true);
	});
});

describe("DecisionPayload and payload_hash", () => {
	test("the payload excludes challenge and idempotency key", () => {
		const p = decisionPayloadFrom(
			DecisionRequest.parse(approve),
			IDS.run_request,
		);
		expect(Object.keys(p).sort()).toEqual([
			"action",
			"approval_request_id",
			"binding_hash",
			"confirmation_text",
			"contract",
			"expected_request_rev",
			"kind",
			"reason",
		]);
		expect(p).toEqual(g.runPayload);
	});
	test("same payload with a different challenge or key → same hash (replay)", () => {
		const a = decisionPayloadFrom(
			DecisionRequest.parse(approve),
			IDS.run_request,
		);
		const b = decisionPayloadFrom(
			DecisionRequest.parse({
				...approve,
				challenge: "d".repeat(43),
				idempotency_key: "other-key-1",
			}),
			IDS.run_request,
		);
		expect(decisionPayloadHash(a)).toBe(decisionPayloadHash(b));
	});
	test("any content change → different hash (409 idempotency_conflict)", () => {
		const base = decisionPayloadHash(
			decisionPayloadFrom(DecisionRequest.parse(reject), IDS.run_request),
		);
		const variants = [
			{ ...reject, reason: "Different reason." },
			{ ...reject, action: "request_changes" as const },
			{ ...reject, expected_request_rev: 3 },
			{ ...reject, binding_hash: "0".repeat(64) },
		];
		for (const v of variants)
			expect(
				decisionPayloadHash(
					decisionPayloadFrom(DecisionRequest.parse(v), IDS.run_request),
				),
			).not.toBe(base);
		expect(
			decisionPayloadHash(
				decisionPayloadFrom(DecisionRequest.parse(reject), IDS.result_request),
			),
		).not.toBe(base);
	});
	test("reason is stored trimmed, \\r\\n-normalized and redacted (and hashed that way)", () => {
		const secret = ["sk", "-", "x".repeat(24)].join("");
		const p = decisionPayloadFrom(
			DecisionRequest.parse({
				...reject,
				reason: `  line one\r\nkey ${secret}  `,
			}),
			IDS.run_request,
		);
		expect(p.reason).toBe(`line one\nkey ${REDACTED}`);
		const same = decisionPayloadFrom(
			DecisionRequest.parse({ ...reject, reason: `line one\nkey ${secret}` }),
			IDS.run_request,
		);
		expect(decisionPayloadHash(same)).toBe(decisionPayloadHash(p));
	});
	test("an unconfirmed approve cannot become a payload", () => {
		expect(() =>
			decisionPayloadFrom(
				DecisionRequest.parse({ ...approve, confirmation_text: "edward" }),
				IDS.run_request,
			),
		).toThrow();
		expect(
			DecisionPayload.safeParse({ ...g.runPayload, confirmation_text: null })
				.success,
		).toBe(false);
	});
});

describe("receipt, challenge request, session, principal", () => {
	test("a receipt body is strict and never carries a challenge", () => {
		const receipt = {
			contract: "agentcity.decision/v1",
			decision_id: IDS.run_decision,
			approval_request_id: IDS.run_request,
			workspace_task_id: IDS.workspace_task,
			kind: "run",
			action: "approve",
			operator_id: "operator:edward",
			decided_at: "2026-10-02T00:01:00.000Z",
			payload_hash: g.runPayloadHash,
			binding_hash: g.runBinding.hash,
			approval_request: { status: "approved", rev: 3 },
			workspace_task: { stage: "queued", rev: 5 },
			effects: {
				managed_task_id: IDS.managed_task,
				managed_task_state: "queued",
				result_envelope_hash: null,
			},
		};
		expect(DecisionReceiptBody.safeParse(receipt).success).toBe(true);
		expect(
			DecisionReceiptBody.safeParse({ ...receipt, challenge: "c".repeat(43) })
				.success,
		).toBe(false);
	});
	test("challenge issue request is strict", () => {
		const body = {
			kind: "run",
			binding_hash: g.runBinding.hash,
			expected_request_rev: 1,
		};
		expect(ChallengeIssueRequest.safeParse(body).success).toBe(true);
		expect(
			ChallengeIssueRequest.safeParse({ ...body, operator_id: "x" }).success,
		).toBe(false);
	});
	test("principal and session view", () => {
		expect(
			OperatorPrincipal.safeParse({
				operator_id: "operator:edward",
				scopes: ["workspace:read", "workspace:decide"],
				session_generation: 1,
				boot_id: IDS.boot,
			}).success,
		).toBe(true);
		expect(
			OperatorPrincipal.safeParse({
				operator_id: "operator:mallory",
				scopes: ["workspace:read"],
				session_generation: 1,
				boot_id: IDS.boot,
			}).success,
		).toBe(false);
		expect(
			SessionView.safeParse({
				operator_id: "operator:edward",
				scopes: ["workspace:read"],
				csrf_token: "t".repeat(43),
				expires_at: "2026-10-02T01:00:00.000Z",
				boot_id: IDS.boot,
			}).success,
		).toBe(false);
	});
});

describe("error codes", () => {
	test("closed set with fixed statuses", () => {
		expect(WorkspaceErrorCode.options.length).toBe(
			Object.keys(WORKSPACE_ERROR_STATUS).length,
		);
		expect(workspaceErrorStatus("unauthenticated")).toBe(401);
		expect(workspaceErrorStatus("challenge_invalid")).toBe(409);
		expect(workspaceErrorStatus("confirmation_mismatch")).toBe(422);
		expect(workspaceErrorStatus("live_disabled")).toBe(422);
		expect(workspaceErrorStatus("idempotency_conflict")).toBe(409);
		expect(workspaceErrorStatus("payload_too_large")).toBe(413);
		expect(workspaceErrorStatus("disabled")).toBe(503);
		for (const s of Object.values(WORKSPACE_ERROR_STATUS)) {
			expect(s).toBeGreaterThanOrEqual(400);
			expect(s).toBeLessThan(600);
		}
	});
	test("error body is strict", () => {
		expect(
			WorkspaceErrorBody.safeParse({ error: "stale_binding", message: "x" })
				.success,
		).toBe(true);
		expect(
			WorkspaceErrorBody.safeParse({ error: "challenge_expired", message: "x" })
				.success,
		).toBe(false);
		expect(
			WorkspaceErrorBody.safeParse({
				error: "not_found",
				message: "x",
				stack: "…",
			}).success,
		).toBe(false);
	});
});
