// Gate 1 (run approval) through the DecisionService directly, against role 02's real store, role
// 03's real ChallengePort and the managed store on a disposable fixture. Fake providers only.
import { afterEach, describe, expect, test } from "bun:test";
import { parseManagedConfig } from "../../managed/config.ts";
import { getTask } from "../../managed/store.ts";
import {
	approvedTask,
	challenge,
	count,
	createTask,
	decisionBody,
	draft,
	dump,
	type Env,
	expectOk,
	key,
	makeEnv,
	publish,
} from "./test-support.ts";

const envs: Env[] = [];
const env = (o: Parameters<typeof makeEnv>[0] = {}) => {
	const e = makeEnv(o);
	envs.push(e);
	return e;
};
afterEach(() => {
	for (const e of envs.splice(0)) e.fx.cleanup();
});

const decisions = (e: Env) =>
	count(e.db, "SELECT count(*) AS n FROM managed_decisions");

describe("Gate 1 approve", () => {
	test("creates exactly one queue linkage, stamped with decided_at, revs as the receipt says", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(e, v);
		const { request } = await publish(e, v, created.task.id);
		const before = getTask(e.db, request.managed_task_id);
		expect(before?.state).toBe("draft");
		expect(before?.run_requested_at).toBeNull();
		const ch = challenge(e, v, request.id);
		expect(ch.request_rev).toBe(request.rev + 1); // issuance bumps the request rev
		const task = e.store.getTask(created.task.id);
		const res = await e.services.decisions.decide(
			v,
			request.id,
			decisionBody(ch),
			e.tick(),
		);
		expect(res.status).toBe(201);
		const out = expectOk(res);
		expect(out.replayed).toBe(false);
		const r = out.receipt;
		expect(r.action).toBe("approve");
		expect(r.approval_request).toEqual({
			status: "approved",
			rev: ch.request_rev + 2, // consume r→r+1, close r+1→r+2
		});
		expect(r.workspace_task).toEqual({
			stage: "queued",
			rev: (task?.rev ?? 0) + 1,
		});
		expect(r.effects.managed_task_state).toBe("queued");
		expect(r.effects.result_envelope_hash).toBeNull();

		const after = getTask(e.db, request.managed_task_id);
		expect(after?.state).toBe("queued");
		expect(after?.run_requested_at).toBe(r.decided_at);
		expect(after?.fence_token).toBe((before?.fence_token ?? 0) + 1);
		expect(after?.approval_hash).not.toBeNull();

		const row = e.store.getApprovalRequest(request.id);
		expect(row?.status).toBe("approved");
		expect(row?.challenge_status).toBe("consumed");
		expect(row?.rev).toBe(r.approval_request.rev);
		expect(e.store.getTask(created.task.id)?.stage).toBe("queued");
		expect(decisions(e)).toBe(1);
		const d = e.store.getDecision(r.decision_id);
		expect(d?.confirmation_text).toBe("Edward");
		expect(d?.operator_id).toBe("operator:edward");
		expect(d?.request_rev).toBe(ch.request_rev);
		expect(d?.boot_id).toBe(v.principal.boot_id);
		expect(d?.response_body).toEqual(r);
	});

	test("request_changes and reject release the reservation and queue nothing", async () => {
		for (const action of ["request_changes", "reject"] as const) {
			const e = env();
			const v = await e.ctx();
			const created = await createTask(e, v);
			const { request } = await publish(e, v, created.task.id);
			const ch = challenge(e, v, request.id);
			const out = expectOk(
				await e.services.decisions.decide(
					v,
					request.id,
					decisionBody(ch, { action }),
					e.tick(),
				),
			);
			expect(out.receipt.effects.managed_task_state).toBe("cancelled");
			const managed = getTask(e.db, request.managed_task_id);
			expect(managed?.state).toBe("cancelled");
			expect(managed?.run_requested_at).toBeNull();
			expect(managed?.approval_hash).toBeNull();
			expect(e.store.getTask(created.task.id)?.stage).toBe(
				action === "reject" ? "rejected" : "changes_requested",
			);
			const d = e.store.getDecision(out.receipt.decision_id);
			expect(d?.confirmation_text).toBeNull();
			expect(d?.reason).toBe("Please narrow the scope.");
		}
	});

	test("a reason holding a runtime secret is stored redacted and never echoed", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(e, v);
		const { request } = await publish(e, v, created.task.id);
		const ch = challenge(e, v, request.id);
		const canary = `gh${"p_"}${"A1b2C3d4E5".repeat(4).slice(0, 36)}`;
		const res = await e.services.decisions.decide(
			v,
			request.id,
			decisionBody(ch, {
				action: "reject",
				reason: `token ${canary} leaked`,
			}),
			e.tick(),
		);
		const out = expectOk(res);
		expect(JSON.stringify(res)).not.toContain(canary);
		const d = e.store.getDecision(out.receipt.decision_id);
		expect(d?.reason).not.toContain(canary);
		expect(dump(e.db)).not.toContain(canary);
	});
});

describe("typed confirmation", () => {
	const WRONG = [
		"edward",
		"EDWARD",
		"eDward",
		"Edward Hwang",
		"Edward.",
		"operator:edward",
		"",
		" Edward",
		"Edward ",
		"\tEdward",
		"Edward\n",
		"Edward\r\n",
		"Еdward", // Cyrillic Е
		"Ｅdward", // fullwidth Ｅ
		"Ed​ward", // zero-width space
		"Ed‍ward", // zero-width joiner
		"‮Edward", // RTL override
		"Edward\u0000",
		"Edward".normalize("NFD").replace("d", "d́"),
	];

	test("anything but exact `Edward` → 422 confirmation_mismatch, nothing consumed, then exact works", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(e, v);
		const { request } = await publish(e, v, created.task.id);
		const ch = challenge(e, v, request.id);
		const snapshot = dump(e.db);
		for (const text of WRONG) {
			const res = await e.services.decisions.decide(
				v,
				request.id,
				decisionBody(ch, { confirmation_text: text }),
				e.now(),
			);
			expect({
				text,
				status: res.status,
				error: (res.body as { error?: string }).error,
			}).toEqual({
				text,
				status: 422,
				error: "confirmation_mismatch",
			});
		}
		expect(dump(e.db)).toBe(snapshot);
		expect(e.store.getApprovalRequest(request.id)?.challenge_status).toBe(
			"issued",
		);
		// the same challenge still works: failures consumed nothing (R-A2)
		const ok = await e.services.decisions.decide(
			v,
			request.id,
			decisionBody(ch),
			e.now(),
		);
		expect(ok.status).toBe(201);
	});

	test("type confusion → 400 invalid_request, no effect", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(e, v);
		const { request } = await publish(e, v, created.task.id);
		const ch = challenge(e, v, request.id);
		const snapshot = dump(e.db);
		for (const value of [null, 1, true, ["Edward"], { v: "Edward" }]) {
			const body = { ...decisionBody(ch), confirmation_text: value };
			const res = await e.services.decisions.decide(
				v,
				request.id,
				body,
				e.now(),
			);
			expect(res.status).toBe(400);
			expect((res.body as { error: string }).error).toBe("invalid_request");
		}
		// reject without reason / with a confirmation → 400
		for (const over of [
			{ reason: null },
			{ reason: "   " },
			{ confirmation_text: "Edward" },
			{ confirmation_text: "" },
		]) {
			const res = await e.services.decisions.decide(
				v,
				request.id,
				{ ...decisionBody(ch, { action: "reject" }), ...over },
				e.now(),
			);
			expect(res.status).toBe(400);
		}
		expect(dump(e.db)).toBe(snapshot);
	});

	test("exact `Edward` without a valid challenge never decides (the name is intent, not auth)", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(e, v);
		const { request } = await publish(e, v, created.task.id);
		const ch = challenge(e, v, request.id);
		const snapshot = dump(e.db);
		const forged = "A".repeat(43);
		const res = await e.services.decisions.decide(
			v,
			request.id,
			decisionBody(ch, { challenge: forged }),
			e.now(),
		);
		expect(res.status).toBe(409);
		expect((res.body as { error: string }).error).toBe("challenge_invalid");
		const missing = await e.services.decisions.decide(
			v,
			request.id,
			{ ...decisionBody(ch), challenge: undefined },
			e.now(),
		);
		expect(missing.status).toBe(400);
		expect(dump(e.db)).toBe(snapshot);
	});
});

describe("bindings", () => {
	test("wrong binding hash / stale rev / wrong kind → 409 stale_binding, nothing consumed", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(e, v);
		const { request } = await publish(e, v, created.task.id);
		const ch = challenge(e, v, request.id);
		const snapshot = dump(e.db);
		const cases = [
			decisionBody(ch, { binding_hash: "ab".repeat(32) }),
			decisionBody(ch, { expected_request_rev: ch.request_rev - 1 }),
			decisionBody(ch, { expected_request_rev: ch.request_rev + 1 }),
			decisionBody({ ...ch, kind: "result" }, { action: "accept" }),
		];
		for (const body of cases) {
			const res = await e.services.decisions.decide(
				v,
				request.id,
				body,
				e.now(),
			);
			expect(res.status).toBe(409);
			expect((res.body as { error: string }).error).toBe("stale_binding");
		}
		expect(dump(e.db)).toBe(snapshot);
		expect(
			(
				await e.services.decisions.decide(
					v,
					request.id,
					decisionBody(ch),
					e.now(),
				)
			).status,
		).toBe(201);
	});

	test("a challenge of request A cannot decide request B", async () => {
		const e = env();
		const v = await e.ctx();
		const a = await createTask(e, v);
		const b = await createTask(e, v, draft({ title: "Second task" }));
		const ra = (await publish(e, v, a.task.id)).request;
		const rb = (await publish(e, v, b.task.id)).request;
		const cha = challenge(e, v, ra.id);
		const chb = challenge(e, v, rb.id);
		const snapshot = dump(e.db);
		// B's binding + rev, A's token
		const res = await e.services.decisions.decide(
			v,
			rb.id,
			decisionBody(chb, { challenge: cha.challenge }),
			e.now(),
		);
		expect(res.status).toBe(409);
		expect((res.body as { error: string }).error).toBe("challenge_invalid");
		expect(dump(e.db)).toBe(snapshot);
	});

	test("expired challenge (T+1 ms) fails; a fresh challenge used at T−1 ms works (authoritative clock)", async () => {
		// The service reads its own clock inside the transaction (review finding 3); the time passed
		// to decide() is request-entry only, so expiry is driven by advancing the authoritative clock.
		const e = env();
		const v = await e.ctx();
		const created = await createTask(e, v);
		const { request } = await publish(e, v, created.task.id);
		const issue = () => {
			const row = e.store.getApprovalRequest(request.id);
			return expectOk(
				e.services.decisions.issueChallenge(
					v,
					request.id,
					{
						kind: "run",
						binding_hash: request.binding_hash,
						expected_request_rev: row?.rev ?? 0,
					},
					e.clock.now(),
				),
			);
		};
		const first = issue();
		e.clock.advance(300_000 + 1);
		const res = await e.services.decisions.decide(
			v,
			request.id,
			decisionBody(first),
			e.clock.now(),
		);
		expect((res.body as { error: string }).error).toBe("challenge_invalid");
		const second = issue();
		e.clock.advance(300_000 - 1);
		expect(
			(
				await e.services.decisions.decide(
					v,
					request.id,
					decisionBody(second),
					e.clock.now(),
				)
			).status,
		).toBe(201);
	});

	test("a newer challenge supersedes the older one; another session's challenge is invalid", async () => {
		const e = env();
		const v1 = await e.ctx();
		const created = await createTask(e, v1);
		const { request } = await publish(e, v1, created.task.id);
		const c1 = challenge(e, v1, request.id);
		const c2 = challenge(e, v1, request.id);
		const snapshot = dump(e.db);
		// C1's token with C2's rev → hash mismatch; with C1's rev → stale rev
		for (const body of [
			decisionBody(c2, { challenge: c1.challenge }),
			decisionBody(c1),
		]) {
			const res = await e.services.decisions.decide(
				v1,
				request.id,
				body,
				e.now(),
			);
			expect(res.status).toBe(409);
		}
		// a second login (new session generation) cannot use C2
		const v2 = await e.ctx(await e.login());
		const other = await e.services.decisions.decide(
			v2,
			request.id,
			decisionBody(c2),
			e.now(),
		);
		expect((other.body as { error: string }).error).toBe("challenge_invalid");
		expect(dump(e.db)).toBe(snapshot);
		expect(
			(
				await e.services.decisions.decide(
					v1,
					request.id,
					decisionBody(c2),
					e.now(),
				)
			).status,
		).toBe(201);
	});

	test("a policy change between publish and approve → 409 stale_binding before the challenge is consumed", async () => {
		const e1 = env();
		const v1 = await e1.ctx();
		const created = await createTask(e1, v1);
		const { request } = await publish(e1, v1, created.task.id);
		// same database, a hub whose trusted config differs (policy hash changes)
		const e2 = makeEnv({
			reuse: { fx: e1.fx, db: e1.db },
			config: (fx) =>
				parseManagedConfig({
					...fx.config,
					limits: {
						...fx.config.limits,
						kill_grace_ms: fx.config.limits.kill_grace_ms + 1,
					},
				}),
		});
		const v2 = await e2.ctx();
		const ch = challenge(e2, v2, request.id);
		const snapshot = dump(e2.db);
		const res = await e2.services.decisions.decide(
			v2,
			request.id,
			decisionBody(ch),
			e2.now(),
		);
		expect(res.status).toBe(409);
		expect((res.body as { error: string }).error).toBe("stale_binding");
		expect(dump(e2.db)).toBe(snapshot);
		expect(e2.store.getApprovalRequest(request.id)?.challenge_status).toBe(
			"issued",
		);
	});
});

describe("idempotency and receipts", () => {
	test("lost response: the byte-identical retry returns the stored receipt, no effects", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(e, v);
		const { request } = await publish(e, v, created.task.id);
		const ch = challenge(e, v, request.id);
		const body = decisionBody(ch);
		const first = expectOk(
			await e.services.decisions.decide(v, request.id, body, e.tick()),
		);
		const snapshot = dump(e.db);
		const again = await e.services.decisions.decide(
			v,
			request.id,
			structuredClone(body),
			e.tick(),
		);
		expect(again.status).toBe(201); // the stored status (frozen §7)
		const replay = expectOk(again);
		expect(replay.replayed).toBe(true);
		expect(replay.receipt).toEqual(first.receipt);
		expect(dump(e.db)).toBe(snapshot);
		// key order / whitespace do not matter: same canonical payload
		const permuted = JSON.parse(
			JSON.stringify(
				Object.fromEntries(Object.entries(body).reverse()),
				null,
				2,
			),
		);
		expect(
			expectOk(
				await e.services.decisions.decide(v, request.id, permuted, e.tick()),
			).replayed,
		).toBe(true);
		// a different (valid) challenge token is excluded from the payload → still a replay
		expect(
			expectOk(
				await e.services.decisions.decide(
					v,
					request.id,
					{ ...body, challenge: "B".repeat(43) },
					e.tick(),
				),
			).replayed,
		).toBe(true);
	});

	test("same key, different payload → 409 idempotency_conflict, nothing changes", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(e, v);
		const { request } = await publish(e, v, created.task.id);
		const ch = challenge(e, v, request.id);
		const body = decisionBody(ch);
		expectOk(await e.services.decisions.decide(v, request.id, body, e.tick()));
		const snapshot = dump(e.db);
		for (const over of [
			{ action: "reject" as const, confirmation_text: null, reason: "no" },
			{ expected_request_rev: body.expected_request_rev + 1 },
			{ binding_hash: "cd".repeat(32) },
			{ confirmation_text: "edward" },
			{ kind: "result" as const, action: "accept" as const },
		]) {
			const res = await e.services.decisions.decide(
				v,
				request.id,
				{ ...body, ...over },
				e.tick(),
			);
			expect(res.status).toBe(409);
			expect((res.body as { error: string }).error).toBe(
				"idempotency_conflict",
			);
		}
		expect(dump(e.db)).toBe(snapshot);
	});

	test("a failed attempt leaves no receipt: the same key then succeeds", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(e, v);
		const { request } = await publish(e, v, created.task.id);
		const ch = challenge(e, v, request.id);
		const k = key("retry");
		const wrong = await e.services.decisions.decide(
			v,
			request.id,
			decisionBody(ch, { idempotency_key: k, confirmation_text: "edward" }),
			e.now(),
		);
		expect(wrong.status).toBe(422);
		const stale = await e.services.decisions.decide(
			v,
			request.id,
			decisionBody(ch, { idempotency_key: k, challenge: "C".repeat(43) }),
			e.now(),
		);
		expect(stale.status).toBe(409);
		expect(decisions(e)).toBe(0);
		expect(
			(
				await e.services.decisions.decide(
					v,
					request.id,
					decisionBody(ch, { idempotency_key: k }),
					e.now(),
				)
			).status,
		).toBe(201);
	});

	test("a second successful decision is impossible: new key after success → 409, one decision", async () => {
		const e = env();
		const v = await e.ctx();
		const ids = await approvedTask(e, v);
		const row = e.store.getApprovalRequest(ids.runRequestId);
		const replayedChallenge = decisionBody(
			{
				challenge: "D".repeat(43),
				request_rev: row?.rev ?? 0,
				binding_hash: row?.binding_hash ?? "",
				kind: "run",
			},
			{ action: "reject" },
		);
		const res = await e.services.decisions.decide(
			v,
			ids.runRequestId,
			replayedChallenge,
			e.now(),
		);
		expect(res.status).toBe(409);
		expect((res.body as { error: string }).error).toBe("invalid_state");
		// issuing a challenge for a closed request is refused too
		const ch = e.services.decisions.issueChallenge(
			v,
			ids.runRequestId,
			{
				kind: "run",
				binding_hash: row?.binding_hash,
				expected_request_rev: row?.rev,
			},
			e.now(),
		);
		expect(ch.status).toBe(409);
		expect(decisions(e)).toBe(1);
	});

	test("concurrent submissions: one challenge, many keys → exactly one decision and one queue linkage", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(e, v);
		const { request } = await publish(e, v, created.task.id);
		const ch = challenge(e, v, request.id);
		const fence = getTask(e.db, request.managed_task_id)?.fence_token ?? 0;
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				e.services.decisions.decide(
					v,
					request.id,
					decisionBody(ch, i % 2 === 0 ? {} : { action: "reject" }),
					e.now(),
				),
			),
		);
		const statuses = results.map((r) => r.status).sort();
		expect(statuses.filter((s) => s === 201)).toHaveLength(1);
		expect(statuses.filter((s) => s === 409)).toHaveLength(19);
		expect(results.some((r) => r.status >= 500)).toBe(false);
		expect(decisions(e)).toBe(1);
		const managed = getTask(e.db, request.managed_task_id);
		const winner = results.find((r) => r.status === 201);
		const action = expectOk(winner as (typeof results)[number]).receipt.action;
		if (action === "approve") {
			expect(managed?.state).toBe("queued");
			expect(managed?.fence_token).toBe(fence + 1);
		} else expect(managed?.state).toBe("cancelled");
	});

	test("concurrent duplicates of one body → one decision, the others are replays", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(e, v);
		const { request } = await publish(e, v, created.task.id);
		const ch = challenge(e, v, request.id);
		const body = decisionBody(ch);
		const results = await Promise.all(
			Array.from({ length: 10 }, () =>
				e.services.decisions.decide(
					v,
					request.id,
					structuredClone(body),
					e.now(),
				),
			),
		);
		expect(results.every((r) => r.status === 201)).toBe(true);
		expect(results.filter((r) => r.ok && !r.body.replayed)).toHaveLength(1);
		expect(decisions(e)).toBe(1);
	});
});

describe("atomicity", () => {
	for (const point of [
		"after_consume",
		"after_insert_decision",
		"after_close_request",
		"after_effects",
	] as const) {
		test(`a failure ${point} rolls everything back (challenge unconsumed, no receipt)`, async () => {
			let armed = true;
			const e = env({
				hooks: {
					inDecisionTx(p) {
						if (armed && p === point) throw new Error(`injected ${p}`);
					},
				},
			});
			const v = await e.ctx();
			const created = await createTask(e, v);
			const { request } = await publish(e, v, created.task.id);
			const ch = challenge(e, v, request.id);
			const body = decisionBody(ch);
			const snapshot = dump(e.db);
			await expect(
				e.services.decisions.decide(v, request.id, body, e.now()),
			).rejects.toThrow(`injected ${point}`);
			expect(dump(e.db)).toBe(snapshot);
			const row = e.store.getApprovalRequest(request.id);
			expect(row?.challenge_status).toBe("issued");
			expect(row?.status).toBe("pending");
			expect(getTask(e.db, request.managed_task_id)?.state).toBe("draft");
			armed = false;
			expect(
				(await e.services.decisions.decide(v, request.id, body, e.now()))
					.status,
			).toBe(201);
			expect(
				expectOk(
					await e.services.decisions.decide(v, request.id, body, e.now()),
				).replayed,
			).toBe(true);
			expect(decisions(e)).toBe(1);
		});
	}
});

describe("invalidation and history", () => {
	test("publishing v2 supersedes the pending v1 request and its challenge", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(e, v);
		const { request: r1 } = await publish(e, v, created.task.id);
		const c1 = challenge(e, v, r1.id);
		const { request: r2 } = await publish(e, v, created.task.id);
		const old = e.store.getApprovalRequest(r1.id);
		expect(old?.status).toBe("invalidated");
		expect(old?.invalidation_reason).toBe("proposal_superseded");
		expect(getTask(e.db, r1.managed_task_id)?.state).toBe("cancelled");
		expect(r2.managed_task_id).not.toBe(r1.managed_task_id);
		const snapshot = dump(e.db);
		const res = await e.services.decisions.decide(
			v,
			r1.id,
			decisionBody(c1),
			e.now(),
		);
		expect(res.status).toBe(409);
		expect((res.body as { error: string }).error).toBe("stale_binding");
		// the old token cannot approve the new request either
		const r2row = e.store.getApprovalRequest(r2.id);
		const cross = await e.services.decisions.decide(
			v,
			r2.id,
			decisionBody({
				challenge: c1.challenge,
				request_rev: r2row?.rev ?? 0,
				binding_hash: r2.binding_hash,
				kind: "run",
			}),
			e.now(),
		);
		expect((cross.body as { error: string }).error).toBe("challenge_invalid");
		expect(dump(e.db)).toBe(snapshot);
		// proposal history: v1 and v2 are both kept, v2 names v1
		const versions = e.store.listProposals(created.task.id);
		expect(versions.map((p) => p.version)).toEqual([1, 2]);
		expect(versions[1]?.predecessor_proposal_id).toBe(versions[0]?.id ?? null);
	});

	test("request_changes → edit draft → new proposal → new Gate 1 → approve", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(e, v);
		const { request: r1 } = await publish(e, v, created.task.id);
		const c1 = challenge(e, v, r1.id);
		expectOk(
			await e.services.decisions.decide(
				v,
				r1.id,
				decisionBody(c1, { action: "request_changes" }),
				e.tick(),
			),
		);
		const t1 = e.store.getTask(created.task.id);
		expect(t1?.stage).toBe("changes_requested");
		const saved = expectOk(
			e.services.commands.saveDraft(
				v,
				created.task.id,
				{
					expected_rev: t1?.rev,
					draft: draft({ objective: "A narrower objective." }),
				},
				e.tick(),
			),
		);
		const { request: r2 } = await publish(e, v, saved.task.id);
		expect(r2.id).not.toBe(r1.id);
		expect(e.store.getProposal(r2.proposal_id)?.snapshot.objective).toBe(
			"A narrower objective.",
		);
		const c2 = challenge(e, v, r2.id);
		expect(
			expectOk(
				await e.services.decisions.decide(v, r2.id, decisionBody(c2), e.tick()),
			).receipt.action,
		).toBe("approve");
		expect(getTask(e.db, r2.managed_task_id)?.state).toBe("queued");
		expect(getTask(e.db, r1.managed_task_id)?.state).toBe("cancelled");
	});

	test("reject is terminal: no draft save, no publish, no rerun, no challenge", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(e, v);
		const { request } = await publish(e, v, created.task.id);
		const ch = challenge(e, v, request.id);
		expectOk(
			await e.services.decisions.decide(
				v,
				request.id,
				decisionBody(ch, { action: "reject" }),
				e.tick(),
			),
		);
		const t = e.store.getTask(created.task.id);
		expect(t?.stage).toBe("rejected");
		const snapshot = dump(e.db);
		const save = e.services.commands.saveDraft(
			v,
			created.task.id,
			{ expected_rev: t?.rev, draft: draft() },
			e.now(),
		);
		const pub = await e.services.commands.publishProposal(
			v,
			created.task.id,
			{ expected_rev: t?.rev },
			e.now(),
		);
		const rerun = e.services.commands.requestRerun(
			v,
			created.task.id,
			{ expected_rev: t?.rev, proposal_id: t?.current_proposal_id },
			e.now(),
		);
		const cancel = e.services.commands.cancel(
			v,
			created.task.id,
			{ expected_rev: t?.rev },
			e.now(),
		);
		for (const r of [save, pub, rerun, cancel]) {
			expect(r.status).toBe(409);
			expect((r.body as { error: string }).error).toBe("invalid_state");
		}
		expect(dump(e.db)).toBe(snapshot);
	});

	test("cancel during a pending Gate 1 withdraws it; a later approve is refused", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(e, v);
		const { request } = await publish(e, v, created.task.id);
		const ch = challenge(e, v, request.id);
		const t = e.store.getTask(created.task.id);
		const view = expectOk(
			e.services.commands.cancel(
				v,
				created.task.id,
				{ expected_rev: t?.rev },
				e.tick(),
			),
		);
		expect(view.task.stage).toBe("cancelled");
		const row = e.store.getApprovalRequest(request.id);
		expect(row?.status).toBe("invalidated");
		expect(row?.invalidation_reason).toBe("withdrawn");
		expect(getTask(e.db, request.managed_task_id)?.state).toBe("cancelled");
		const snapshot = dump(e.db);
		const res = await e.services.decisions.decide(
			v,
			request.id,
			decisionBody(ch),
			e.now(),
		);
		expect(res.status).toBe(409);
		expect(dump(e.db)).toBe(snapshot);
	});
});

describe("races at the decision boundary", () => {
	test("v2 published inside the window before BEGIN IMMEDIATE → approve of v1 is 409 stale_binding, nothing queued", async () => {
		let race: (() => Promise<void>) | null = null;
		const e = env({
			hooks: {
				async beforeTransaction() {
					const r = race;
					race = null;
					if (r) await r();
				},
			},
		});
		const v = await e.ctx();
		const created = await createTask(e, v);
		const { request: r1 } = await publish(e, v, created.task.id);
		const ch = challenge(e, v, r1.id);
		race = async () => {
			await publish(e, v, created.task.id);
		};
		const res = await e.services.decisions.decide(
			v,
			r1.id,
			decisionBody(ch),
			e.now(),
		);
		expect(res.status).toBe(409);
		expect((res.body as { error: string }).error).toBe("stale_binding");
		expect(decisions(e)).toBe(0);
		expect(getTask(e.db, r1.managed_task_id)?.state).toBe("cancelled");
		expect(getTask(e.db, r1.managed_task_id)?.run_requested_at).toBeNull();
	});

	test("a reserved execution queued by any other path is never approved (no second linkage)", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(e, v);
		const { request } = await publish(e, v, created.task.id);
		const ch = challenge(e, v, request.id);
		// a bypass (legacy requestRun / direct write) moved the reservation out of draft
		const { requestRun } = await import("../../managed/store.ts");
		requestRun(
			e.db,
			request.managed_task_id,
			"ef".repeat(32),
			e.now().toISOString(),
		);
		const snapshot = dump(e.db);
		const res = await e.services.decisions.decide(
			v,
			request.id,
			decisionBody(ch),
			e.now(),
		);
		expect(res.status).toBe(409);
		expect((res.body as { error: string }).error).toBe("invalid_state");
		expect(dump(e.db)).toBe(snapshot);
		expect(decisions(e)).toBe(0);
	});
});

describe("precedence", () => {
	test("live precedence: a decision body naming a non-simulated mode → 422 before parsing", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(e, v);
		const { request } = await publish(e, v, created.task.id);
		const ch = challenge(e, v, request.id);
		const res = await e.services.decisions.decide(
			v,
			request.id,
			{ ...decisionBody(ch), execution_mode: "live" },
			e.now(),
		);
		expect(res.status).toBe(422);
		expect((res.body as { error: string }).error).toBe("live_disabled");
		const chRes = e.services.decisions.issueChallenge(
			v,
			request.id,
			{
				kind: "run",
				binding_hash: request.binding_hash,
				expected_request_rev: 1,
				execution_mode: "live",
			},
			e.now(),
		);
		expect(chRes.status).toBe(422);
	});

	test("ids are pattern-checked; unknown request → 404", async () => {
		const e = env();
		const v = await e.ctx();
		const body = decisionBody({
			challenge: "E".repeat(43),
			request_rev: 1,
			binding_hash: "ab".repeat(32),
			kind: "run",
		});
		for (const id of [
			"../x",
			"wsa-1",
			`wsa-${crypto.randomUUID()}`.toUpperCase(),
			"",
		]) {
			expect(
				(await e.services.decisions.decide(v, id, body, e.now())).status,
			).toBe(404);
		}
		expect(
			(
				await e.services.decisions.decide(
					v,
					`wsa-${crypto.randomUUID()}`,
					body,
					e.now(),
				)
			).status,
		).toBe(404);
	});
});
