// Obsolete v1 execution grants at the decision boundary (follow-up P2 of the independent re-review):
// a genuine legacy (pre-v1.2) pending Gate-1 request can be neither challenged nor decided — through
// the real HTTP routes — and the attempt invalidates it (existing reason, fixed detail), releases its
// unlaunched reservation and returns the task to draft. No decision, no receipt, no challenge, no
// queue effect, nothing executed. A historical (pre-policy) legacy approval still replays verbatim.
// Disposable fixture repo + DB, fake providers only.
import { afterEach, describe, expect, test } from "bun:test";
import type { DecisionRequest } from "@agent-city/schema/workspace-m1";
import { getTask } from "../../managed/store.ts";
import {
	OBSOLETE_V1_GRANT_DETAIL,
	OBSOLETE_V1_GRANT_STAGE_DETAIL,
} from "./decision-service.ts";
import {
	approveLegacyV1Raw,
	count,
	countingAdapters,
	createTask,
	type Env,
	key,
	makeEnv,
	publishLegacyV1,
	runEngine,
	type Session,
} from "./test-support.ts";

const envs: Env[] = [];
afterEach(() => {
	for (const e of envs.splice(0)) e.fx.cleanup();
});
const env = () => {
	const e = makeEnv();
	envs.push(e);
	return e;
};

const decisions = (e: Env) =>
	count(e.db, "SELECT count(*) AS n FROM managed_decisions");
const OBSOLETE = {
	error: "stale_binding",
	issues: [{ path: "proposal_id", message: OBSOLETE_V1_GRANT_DETAIL }],
};

async function legacyPending(e: Env) {
	const v = await e.ctx();
	const created = await createTask(e, v);
	const legacy = await publishLegacyV1(e, created.task.id);
	return { v, taskId: created.task.id, ...legacy };
}

const challengeHttp = (e: Env, s: Session, requestId: string) => {
	const row = e.store.getApprovalRequest(requestId);
	if (!row) throw new Error("no request");
	return e.request("POST", `/approval-requests/${requestId}/challenge`, s, {
		kind: row.kind,
		binding_hash: row.binding_hash,
		expected_request_rev: row.rev,
	});
};

/** The rows the refusal must leave: invalidated request, released reservation, task in draft. */
function expectRetired(e: Env, l: Awaited<ReturnType<typeof legacyPending>>) {
	const row = e.store.getApprovalRequest(l.runRequestId);
	expect(row).toMatchObject({
		status: "invalidated",
		invalidation_reason: "evidence_unavailable",
		invalidation_detail: OBSOLETE_V1_GRANT_DETAIL,
	});
	expect(e.store.getTask(l.taskId)).toMatchObject({
		stage: "draft",
		stage_detail: OBSOLETE_V1_GRANT_STAGE_DETAIL,
		current_proposal_id: l.proposalId, // the v1 proposal stays history
	});
	const m = getTask(e.db, l.managedTaskId);
	expect(m?.state).toBe("cancelled");
	expect(m?.run_requested_at).toBeNull(); // never queued
	expect(decisions(e)).toBe(0);
}

describe("obsolete v1 grant: challenge issuance", () => {
	test("HTTP challenge → 409 stale_binding + fixed issue; request invalidated, reservation released, task back to draft; nothing queued or executed", async () => {
		const e = env();
		const l = await legacyPending(e);
		const s = await e.login();
		const res = await challengeHttp(e, s, l.runRequestId);
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject(OBSOLETE);
		expectRetired(e, l);
		expect(e.store.getApprovalRequest(l.runRequestId)?.challenge_status).toBe(
			"none",
		); // no challenge was ever issued
		// the read model shows the reason and the guidance (UI-readable)
		const detail = await e.request("GET", `/tasks/${l.taskId}`, s);
		const body = (await detail.json()) as {
			task: { stage: string; stage_detail: string };
			approval_requests: {
				id: string;
				invalidation_reason: string;
				invalidation_detail: string;
			}[];
		};
		expect(body.task.stage_detail).toBe(OBSOLETE_V1_GRANT_STAGE_DETAIL);
		expect(
			body.approval_requests.find((r) => r.id === l.runRequestId),
		).toMatchObject({
			invalidation_reason: "evidence_unavailable",
			invalidation_detail: OBSOLETE_V1_GRANT_DETAIL,
		});
		// retries (same subject, fresh rev) keep the same refusal; nothing reopens
		const again = await challengeHttp(e, s, l.runRequestId);
		expect(again.status).toBe(409);
		expect(await again.json()).toMatchObject(OBSOLETE);
		const calls = countingAdapters(e.fx.config);
		await runEngine(e, calls);
		expect(calls.calls).toEqual({ preflight: 0, implement: 0, review: 0 });
		expectRetired(e, l);
	});
});

describe("obsolete v1 grant: decision attempts (challenge issued before the policy)", () => {
	for (const action of ["approve", "request_changes", "reject"] as const)
		test(`${action} → 409 stale_binding + fixed issue BEFORE the challenge is consumed; no decision, receipt or queue effect; the identical retry gets the same answer`, async () => {
			const e = env();
			const l = await legacyPending(e);
			// a challenge the pre-policy hub issued to THIS session (the real ChallengePort, same
			// boot): it would verify — the refusal must come before it is consumed
			const s = await e.login();
			const vs = await e.ctx(s);
			const row = e.store.getApprovalRequest(l.runRequestId);
			if (!row) throw new Error("no request");
			const issued = e.store.transaction((tx) =>
				e.auth.challenges.issue(tx, row, vs, e.now()),
			);
			const grants = action === "approve";
			const body: DecisionRequest = {
				idempotency_key: key("obsolete"),
				kind: "run",
				action,
				expected_request_rev: issued.request_rev,
				binding_hash: row.binding_hash,
				confirmation_text: grants ? "Edward" : null,
				reason: grants ? null : "Please narrow the scope.",
				challenge: issued.challenge,
			};
			const path = `/approval-requests/${l.runRequestId}/decisions`;
			const res = await e.request("POST", path, s, body);
			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject(OBSOLETE);
			expectRetired(e, l);
			// failed before consumption: the issued challenge was never consumed
			expect(e.store.getApprovalRequest(l.runRequestId)?.challenge_status).toBe(
				"issued",
			);
			const retry = await e.request("POST", path, s, body);
			expect(retry.status).toBe(409);
			expect(await retry.json()).toMatchObject(OBSOLETE);
			expect(decisions(e)).toBe(0);
		});

	test("a confirmation mismatch is refused first (422) and writes nothing; the confirmed attempt then retires the grant", async () => {
		const e = env();
		const l = await legacyPending(e);
		const row = e.store.getApprovalRequest(l.runRequestId);
		if (!row) throw new Error("no request");
		const issued = e.store.transaction((tx) =>
			e.auth.challenges.issue(tx, row, l.v, e.now()),
		);
		const body: DecisionRequest = {
			idempotency_key: key("obsolete"),
			kind: "run",
			action: "approve",
			expected_request_rev: issued.request_rev,
			binding_hash: row.binding_hash,
			confirmation_text: "edward",
			reason: null,
			challenge: issued.challenge,
		};
		const bad = await e.services.decisions.decide(
			l.v,
			l.runRequestId,
			body,
			e.tick(),
		);
		expect(bad.status).toBe(422);
		expect(e.store.getApprovalRequest(l.runRequestId)?.status).toBe("pending");
		const res = await e.services.decisions.decide(
			l.v,
			l.runRequestId,
			{ ...body, confirmation_text: "Edward" },
			e.tick(),
		);
		expect([res.status, res.body]).toMatchObject([409, OBSOLETE]);
		expectRetired(e, l);
	});
});

describe("historical legacy approvals are history", () => {
	test("a pre-policy legacy approval replays its stored receipt verbatim (no new effect); its request is closed for every new decision", async () => {
		const e = env();
		const l = await legacyPending(e);
		const raw = approveLegacyV1Raw(e, l.v, l.runRequestId);
		const before = e.db
			.query("SELECT * FROM managed_decisions ORDER BY rowid")
			.all();
		const replay = await e.services.decisions.decide(
			l.v,
			l.runRequestId,
			raw.body,
			e.tick(),
		);
		expect(replay.ok && replay.body).toEqual({
			receipt: raw.receipt,
			replayed: true,
		});
		expect(
			e.db.query("SELECT * FROM managed_decisions ORDER BY rowid").all(),
		).toEqual(before);
		// not pending → no challenge (the obsolete-pending path never touches a closed request)
		const ch = e.services.decisions.issueChallenge(
			l.v,
			l.runRequestId,
			{
				kind: "run",
				binding_hash: raw.body.binding_hash,
				expected_request_rev: raw.receipt.approval_request.rev,
			},
			e.tick(),
		);
		expect([ch.status, (ch.body as { error: string }).error]).toEqual([
			409,
			"invalid_state",
		]);
		expect(e.store.getApprovalRequest(l.runRequestId)?.status).toBe("approved");
	});
});
