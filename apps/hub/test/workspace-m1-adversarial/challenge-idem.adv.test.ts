// biome-ignore-all lint/suspicious/noExplicitAny: adversarial tests inspect raw, untyped HTTP bodies and SQLite rows on purpose
// ADV-NAME, ADV-CHAL, ADV-IDEM — typed confirmation, single-use challenge binding, receipts and
// lost responses, against the real hub (startHub, workspace mode) with a fake auth clock.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { CHALLENGE_TTL_MS } from "@agent-city/schema/workspace-m1";
import {
	approveGate1,
	assertIsolation,
	BASE,
	type Client,
	canary,
	count,
	decide,
	decisionBody,
	dump,
	FakeClock,
	http,
	issueChallenge,
	key,
	linkage,
	liveServers,
	openGate1,
	type RealHub,
	realHub,
	requestRow,
	signIn,
	taskView,
	teardown,
} from "./harness.ts";

assertIsolation();

let H: RealHub;
let op: Client;
const clock = new FakeClock();

beforeAll(async () => {
	H = realHub({ clock, auth: { max_sessions_per_principal: 16 } });
	op = await H.signIn();
});
afterAll(async () => {
	await teardown(); // replaced hubs were stopped explicitly inside their tests
	expect(liveServers).toBe(0);
});

/** NE for one Gate-1 subject: nothing decided, nothing queued, challenge state as expected. */
function expectUntouched(g: { req: any }, challenge: "issued" | "none") {
	const row = requestRow(H.db, g.req.id);
	expect(row.status).toBe("pending");
	expect(row.challenge_status).toBe(challenge);
	const l = linkage(H.db, g.req.managed_task_id);
	expect(l.state).toBe("draft");
	expect(l.run_requested_at).toBeNull();
	expect(l.approval_hash).toBeNull();
	expect(l.decisions).toBe(0);
	expect(l.runs).toBe(0);
}

describe("ADV-NAME typed confirmation", () => {
	test("ADV-NAME-01…05 every non-exact confirmation is refused, consumes nothing; exact Edward then succeeds", async () => {
		const g = await openGate1(op, H.fx);
		const ch = await issueChallenge(op, g.req);
		const strings = [
			"",
			"edward",
			"EDWARD",
			"eDward",
			"Edward Hwang",
			"Edward.",
			"operator:edward",
			" Edward",
			"Edward ",
			"\tEdward",
			"Edward\n",
			"Edward\r\n",
			"Edwаrd", // Cyrillic a
			"Ｅdward", // fullwidth E
			"Ed‍ward", // zero-width joiner
			"Edward​",
			"‮Edward",
			"Edward\u0000",
			"Edward́", // combining mark
		];
		const statuses = new Set<number>();
		for (const confirmation_text of strings) {
			const r = await decide(
				op,
				g.req,
				decisionBody(g.req, ch, "approve", { confirmation_text }),
			);
			statuses.add(r.status);
			expect([
				JSON.stringify(confirmation_text),
				[400, 422].includes(r.status),
			]).toEqual([JSON.stringify(confirmation_text), true]);
		}
		expect(statuses.has(422)).toBe(true);
		for (const confirmation_text of [
			null,
			1,
			true,
			["Edward"],
			{ v: "Edward" },
		]) {
			const r = await decide(
				op,
				g.req,
				decisionBody(g.req, ch, "approve", { confirmation_text }),
			);
			expect([JSON.stringify(confirmation_text), r.status]).toEqual([
				JSON.stringify(confirmation_text),
				400,
			]);
		}
		expectUntouched(g, "issued");
		const ok = await decide(op, g.req, decisionBody(g.req, ch, "approve"));
		expect(ok.status).toBe(201);
	});

	test("ADV-NAME-06 exact Edward with a forged challenge → 409 challenge_invalid, nothing consumed", async () => {
		const g = await openGate1(op, H.fx);
		const ch = await issueChallenge(op, g.req);
		const r = await decide(
			op,
			g.req,
			decisionBody(g.req, ch, "approve", {
				challenge: randomBytes(32).toString("base64url"),
			}),
		);
		expect(r.status).toBe(409);
		expect(r.body.error).toBe("challenge_invalid");
		expectUntouched(g, "issued");
	});

	test("ADV-NAME-07 reject needs a reason (none → 400); with a reason it queues nothing", async () => {
		const g = await openGate1(op, H.fx);
		const ch = await issueChallenge(op, g.req);
		for (const reason of [null, "", "   "]) {
			const r = await decide(
				op,
				g.req,
				decisionBody(g.req, ch, "reject", { reason }),
			);
			expect([reason, r.status]).toEqual([reason, 400]);
		}
		const withName = await decide(
			op,
			g.req,
			decisionBody(g.req, ch, "reject", { confirmation_text: "Edward" }),
		);
		expect(withName.status).toBe(400);
		const ok = await decide(op, g.req, decisionBody(g.req, ch, "reject"));
		expect(ok.status).toBe(201);
		const l = linkage(H.db, g.req.managed_task_id);
		expect(l.state).toBe("cancelled");
		expect(l.run_requested_at).toBeNull();
		expect(l.runs).toBe(0);
		expect(requestRow(H.db, g.req.id).status).toBe("rejected");
	});

	test("ADV-NAME-08/09 a canary in the reason is stored redacted; the decision row records Edward + the authenticated operator", async () => {
		const g = await openGate1(op, H.fx);
		const ch = await issueChallenge(op, g.req);
		const secret = canary.github();
		const r = await decide(
			op,
			g.req,
			decisionBody(g.req, ch, "request_changes", {
				reason: `please rotate ${secret} first`,
			}),
		);
		expect(r.status).toBe(201);
		expect(r.text).not.toContain(secret);
		expect(dump(H.db)).not.toContain(secret);
		expect(
			(await taskView(op, g.taskId)) &&
				JSON.stringify(await taskView(op, g.taskId)),
		).not.toContain(secret);
		const a = await approveGate1(op, H.fx);
		const row = H.db
			.query(
				"SELECT confirmation_text, operator_id, reason FROM managed_decisions WHERE approval_request_id = ?",
			)
			.get(a.req.id) as any;
		expect(row).toEqual({
			confirmation_text: "Edward",
			operator_id: "operator:edward",
			reason: null,
		});
	});
});

describe("ADV-CHAL single-use challenge binding", () => {
	test("ADV-CHAL-01 no / malformed / forged challenge → 400 / 409, nothing consumed", async () => {
		const g = await openGate1(op, H.fx);
		const ch = await issueChallenge(op, g.req);
		const body = decisionBody(g.req, ch, "approve") as Record<string, unknown>;
		const { challenge: _drop, ...noChallenge } = body;
		expect((await decide(op, g.req, noChallenge)).status).toBe(400);
		expect(
			(await decide(op, g.req, { ...body, challenge: "short" })).status,
		).toBe(400);
		const forged = await decide(op, g.req, {
			...body,
			challenge: randomBytes(32).toString("base64url"),
		});
		expect([forged.status, forged.body.error]).toEqual([
			409,
			"challenge_invalid",
		]);
		expectUntouched(g, "issued");
	});

	test("ADV-CHAL-02 a challenge for R1 presented on R2 → 409; neither consumed; R1 still decidable", async () => {
		const g1 = await openGate1(op, H.fx);
		const g2 = await openGate1(op, H.fx);
		const c1 = await issueChallenge(op, g1.req);
		const r = await decide(
			op,
			g2.req,
			decisionBody(g2.req, { ...c1, request_rev: g2.req.rev }, "approve"),
		);
		expect(r.status).toBe(409);
		expectUntouched(g2, "none");
		expectUntouched(g1, "issued");
		expect(
			(await decide(op, g1.req, decisionBody(g1.req, c1, "approve"))).status,
		).toBe(201);
	});

	test("ADV-CHAL-04 proposal v2 published after the challenge → 409 stale_binding; v1 request invalidated; nothing queued", async () => {
		const g = await openGate1(op, H.fx);
		const ch = await issueChallenge(op, g.req);
		const v = await taskView(op, g.taskId);
		const re = await op.post(`/tasks/${g.taskId}/proposals`, {
			expected_rev: v.task.rev,
		});
		expect(re.status).toBe(201);
		const r = await decide(op, g.req, decisionBody(g.req, ch, "approve"));
		expect(r.status).toBe(409);
		expect(["stale_binding", "invalid_state"]).toContain(r.body.error);
		const row = requestRow(H.db, g.req.id);
		expect(row.status).toBe("invalidated");
		expect(row.invalidation_reason).toBe("proposal_superseded");
		const l = linkage(H.db, g.req.managed_task_id);
		expect(l.state).toBe("cancelled");
		expect(l.run_requested_at).toBeNull();
		expect(l.decisions).toBe(0);
	});

	test("ADV-CHAL-05 body binding_hash or expected_request_rev drift → 409 stale_binding; challenge survives", async () => {
		const g = await openGate1(op, H.fx);
		const ch = await issueChallenge(op, g.req);
		const wrongHash = await decide(
			op,
			g.req,
			decisionBody(g.req, ch, "approve", {
				binding_hash: "0".repeat(64),
			}),
		);
		expect([wrongHash.status, wrongHash.body.error]).toEqual([
			409,
			"stale_binding",
		]);
		const staleRev = await decide(
			op,
			g.req,
			decisionBody(g.req, ch, "approve", { expected_request_rev: g.req.rev }),
		);
		expect([staleRev.status, staleRev.body.error]).toEqual([
			409,
			"stale_binding",
		]);
		const futureRev = await decide(
			op,
			g.req,
			decisionBody(g.req, ch, "approve", {
				expected_request_rev: ch.request_rev + 1,
			}),
		);
		expect(futureRev.status).toBe(409);
		expectUntouched(g, "issued");
		expect(
			(await decide(op, g.req, decisionBody(g.req, ch, "approve"))).status,
		).toBe(201);
	});

	test("ADV-CHAL-06 expiry: TTL−1 ms succeeds; TTL+1 ms → 409 challenge_invalid, nothing consumed", async () => {
		const a = await openGate1(op, H.fx);
		const ca = await issueChallenge(op, a.req);
		clock.advance(CHALLENGE_TTL_MS - 1);
		await op.get("/snapshot"); // keep the session's idle clock fresh
		expect(
			(await decide(op, a.req, decisionBody(a.req, ca, "approve"))).status,
		).toBe(201);

		const b = await openGate1(op, H.fx);
		const cb = await issueChallenge(op, b.req);
		clock.advance(CHALLENGE_TTL_MS + 1);
		await op.get("/snapshot").catch(() => null);
		const fresh = await H.signIn();
		const expired = await decide(
			fresh,
			b.req,
			decisionBody(b.req, cb, "approve"),
		);
		// the old session may also have idled out; the fresh session must still be refused
		expect([expired.status, expired.body.error]).toEqual([
			409,
			"challenge_invalid",
		]);
		expectUntouched(b, "issued");
		const v = await taskView(fresh, b.taskId);
		const req = v.approval_requests.find((r: any) => r.id === b.req.id);
		const cb2 = await issueChallenge(fresh, req);
		expect(
			(await decide(fresh, req, decisionBody(req, cb2, "approve"))).status,
		).toBe(201);
		op = fresh;
	});

	test("ADV-CHAL-07 a challenge from a previous boot is dead; the request stays pending and needs a new challenge", async () => {
		const g = await openGate1(op, H.fx);
		const ch = await issueChallenge(op, g.req);
		const A = H;
		await A.stop();
		const B = realHub({
			reuse: A.fx,
			clock,
			credentials: { operator: A.credential, readOnly: A.readOnlyCredential },
			auth: { max_sessions_per_principal: 16 },
		});
		const c = await B.signIn();
		const r = await decide(c, g.req, decisionBody(g.req, ch, "approve"));
		expect([r.status, r.body.error]).toEqual([409, "challenge_invalid"]);
		const row = requestRow(B.db, g.req.id);
		expect(row.status).toBe("pending");
		const v = await taskView(c, g.taskId);
		const req = v.approval_requests.find((x: any) => x.id === g.req.id);
		const ch2 = await issueChallenge(c, req);
		expect(
			(await decide(c, req, decisionBody(req, ch2, "approve"))).status,
		).toBe(201);
		H = B;
		op = c;
	});

	test("ADV-CHAL-08 another session of the same operator cannot use the challenge", async () => {
		const g = await openGate1(op, H.fx);
		const ch = await issueChallenge(op, g.req);
		const s2 = await H.signIn();
		const r = await decide(s2, g.req, decisionBody(g.req, ch, "approve"));
		expect([r.status, r.body.error]).toEqual([409, "challenge_invalid"]);
		expectUntouched(g, "issued");
		expect(
			(await decide(op, g.req, decisionBody(g.req, ch, "approve"))).status,
		).toBe(201);
	});

	test("ADV-CHAL-09 replaying a consumed challenge with a new key → 409; still exactly one linkage", async () => {
		const a = await approveGate1(op, H.fx);
		const before = linkage(H.db, a.managedTaskId);
		const r = await decide(op, a.req, { ...a.body, idempotency_key: key() });
		expect(r.status).toBe(409);
		expect(["invalid_state", "challenge_invalid"]).toContain(r.body.error);
		const reject = await decide(
			op,
			a.req,
			decisionBody(a.req, a.ch, "reject", { idempotency_key: key() }),
		);
		expect(reject.status).toBe(409);
		const after = linkage(H.db, a.managedTaskId);
		expect(after.decisions).toBe(1);
		expect(after.run_requested_at).toBe(before.run_requested_at);
		expect(
			count(
				H.db,
				"SELECT count(*) AS n FROM managed_decisions WHERE approval_request_id = ?",
				a.req.id,
			),
		).toBe(1);
	});

	test("ADV-CHAL-10 a newer challenge supersedes the older one", async () => {
		const g = await openGate1(op, H.fx);
		const c1 = await issueChallenge(op, g.req);
		const v = await taskView(op, g.taskId);
		const req = v.approval_requests.find((x: any) => x.id === g.req.id);
		const c2 = await issueChallenge(op, req);
		const old = await decide(op, g.req, decisionBody(g.req, c1, "approve"));
		expect(old.status).toBe(409);
		const oldWithNewRev = await decide(
			op,
			g.req,
			decisionBody(g.req, { ...c1, request_rev: c2.request_rev }, "approve"),
		);
		expect([oldWithNewRev.status, oldWithNewRev.body.error]).toEqual([
			409,
			"challenge_invalid",
		]);
		expect(
			(await decide(op, g.req, decisionBody(g.req, c2, "approve"))).status,
		).toBe(201);
	});

	test("ADV-CHAL-11 no challenge for a closed request", async () => {
		const a = await approveGate1(op, H.fx);
		const r = await op.post(`/approval-requests/${a.req.id}/challenge`, {
			kind: "run",
			binding_hash: a.req.binding_hash,
			expected_request_rev: requestRow(H.db, a.req.id).rev,
		});
		expect(r.status).toBe(409);
		expect(r.body.error).toBe("invalid_state");
	});

	test("ADV-CHAL-12 only the challenge hash is stored; the token never appears in the DB or a later response", async () => {
		const g = await openGate1(op, H.fx);
		const ch = await issueChallenge(op, g.req);
		const row = requestRow(H.db, g.req.id);
		expect(row.challenge_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(dump(H.db)).not.toContain(ch.challenge);
		const all = JSON.stringify(
			H.db.query("SELECT * FROM managed_approval_requests").all(),
		);
		expect(all).not.toContain(ch.challenge);
		expect(JSON.stringify(await taskView(op, g.taskId))).not.toContain(
			ch.challenge,
		);
		expect(JSON.stringify(await taskView(op, g.taskId))).not.toContain(
			row.challenge_hash,
		);
		expect((await op.get("/snapshot")).text).not.toContain(ch.challenge);
	});
});

describe("ADV-IDEM receipts and lost responses", () => {
	test("ADV-IDEM-01 lost response: the byte-identical body replays the original receipt (201, replayed:true), no new effect", async () => {
		const a = await approveGate1(op, H.fx);
		const first = a.res.body;
		const before = linkage(H.db, a.managedTaskId);
		const snap = count(H.db, "SELECT count(*) AS n FROM managed_decisions");
		for (let i = 0; i < 3; i++) {
			const r = await decide(op, a.req, a.body);
			expect(r.status).toBe(201);
			expect(r.body.replayed).toBe(true);
			expect(r.body.receipt).toEqual(first.receipt);
		}
		expect(count(H.db, "SELECT count(*) AS n FROM managed_decisions")).toBe(
			snap,
		);
		const after = linkage(H.db, a.managedTaskId);
		expect(after.decisions).toBe(1);
		expect(after.run_requested_at).toBe(before.run_requested_at);
		expect(after.fence_token).toBeGreaterThanOrEqual(before.fence_token);
	});

	test("ADV-IDEM-02 the durable decision is readable from the task (operator and read-only), never anonymously", async () => {
		const a = await approveGate1(op, H.fx);
		const id = a.res.body.receipt.decision_id ?? a.res.body.receipt.id;
		const v = await taskView(op, a.taskId);
		expect(JSON.stringify(v.decisions)).toContain(id);
		const viewer = await H.signIn("viewer");
		expect(
			JSON.stringify((await viewer.get(`/tasks/${a.taskId}`)).body),
		).toContain(id);
		const anon = await http(
			H.base,
			"GET",
			`${BASE}/tasks/${a.taskId}`,
			undefined,
			{
				cookie: null,
			},
		);
		expect(anon.status).toBe(401);
		expect(anon.text).not.toContain(id);
	});

	test("ADV-IDEM-03 same key, changed payload → 409 idempotency_conflict, nothing changes", async () => {
		const a = await approveGate1(op, H.fx);
		const before = dump(H.db);
		const variants: Record<string, unknown>[] = [
			{ action: "reject", confirmation_text: null, reason: "changed mind" },
			{ binding_hash: "f".repeat(64) },
			{ expected_request_rev: a.body.expected_request_rev + 1 },
			{ confirmation_text: "edward" },
		];
		for (const v of variants) {
			const r = await decide(op, a.req, { ...a.body, ...v });
			expect([JSON.stringify(v), r.status, r.body?.error]).toEqual([
				JSON.stringify(v),
				409,
				"idempotency_conflict",
			]);
		}
		expect(dump(H.db)).toBe(before);
	});

	test("ADV-IDEM-04/05 the replay path still requires session, CSRF and exact Origin; no receipt leaks", async () => {
		const a = await approveGate1(op, H.fx);
		const id = a.res.body.receipt.decision_id;
		const path = `${BASE}/approval-requests/${a.req.id}/decisions`;
		const noCookie = await http(H.base, "POST", path, a.body, {
			cookie: null,
			csrf: op.csrf,
		});
		const noCsrf = await http(H.base, "POST", path, a.body, {
			cookie: op.cookie,
			csrf: null,
		});
		const badOrigin = await http(H.base, "POST", path, a.body, {
			session: { cookie: op.cookie, csrf: op.csrf },
			origin: "http://127.0.0.1:6123",
		});
		expect([noCookie.status, noCsrf.status, badOrigin.status]).toEqual([
			401, 403, 403,
		]);
		for (const r of [noCookie, noCsrf, badOrigin])
			expect(r.text).not.toContain(id);
	});

	test("ADV-IDEM-06 the read-only principal reusing the operator's key gets 403 before any receipt lookup", async () => {
		const a = await approveGate1(op, H.fx);
		const viewer = await H.signIn("viewer");
		const r = await decide(viewer, a.req, a.body);
		expect(r.status).toBe(403);
		expect(r.text).not.toContain(a.res.body.receipt.decision_id);
	});

	test("ADV-IDEM-07 an unused key never bypasses the challenge", async () => {
		const g = await openGate1(op, H.fx);
		await issueChallenge(op, g.req);
		const r = await decide(
			op,
			g.req,
			decisionBody(
				g.req,
				{
					challenge: randomBytes(32).toString("base64url"),
					request_rev: requestRow(H.db, g.req.id).rev,
				},
				"approve",
			),
		);
		expect([r.status, r.body.error]).toEqual([409, "challenge_invalid"]);
		expectUntouched(g, "issued");
	});

	test("ADV-IDEM-08 receipts survive a restart: same key + payload replays after re-login", async () => {
		const a = await approveGate1(op, H.fx);
		const A = H;
		await A.stop();
		const B = realHub({
			reuse: A.fx,
			clock,
			credentials: { operator: A.credential, readOnly: A.readOnlyCredential },
			auth: { max_sessions_per_principal: 16 },
		});
		const c = await B.signIn();
		const r = await decide(c, a.req, a.body);
		expect(r.status).toBe(201);
		expect(r.body.replayed).toBe(true);
		expect(r.body.receipt).toEqual(a.res.body.receipt);
		expect(linkage(B.db, a.managedTaskId).decisions).toBe(1);
		H = B;
		op = c;
	});

	test("ADV-IDEM-09 key order / whitespace do not matter; an extra field is a 400, not a conflict", async () => {
		const a = await approveGate1(op, H.fx);
		const permuted = Object.fromEntries(Object.entries(a.body).reverse());
		const raw = JSON.stringify(permuted, null, 3);
		const r = await op.post(
			`/approval-requests/${a.req.id}/decisions`,
			undefined,
			{
				raw,
			},
		);
		expect([r.status, r.body.replayed]).toEqual([201, true]);
		const extra = await decide(op, a.req, { ...a.body, note: "x" });
		expect(extra.status).toBe(400);
	});

	test("ADV-IDEM-11 a failed attempt does not create a receipt: same key then succeeds", async () => {
		const g = await openGate1(op, H.fx);
		const ch = await issueChallenge(op, g.req);
		const k = key();
		const bad = await decide(
			op,
			g.req,
			decisionBody(g.req, ch, "approve", {
				idempotency_key: k,
				confirmation_text: "edward",
			}),
		);
		expect(bad.status).toBe(422);
		const good = await decide(
			op,
			g.req,
			decisionBody(g.req, ch, "approve", { idempotency_key: k }),
		);
		expect(good.status).toBe(201);
		expect(good.body.replayed).toBe(false);
	});

	test("ADV-IDEM-12 a reject/request_changes decision replays too (decline receipts are durable)", async () => {
		const g = await openGate1(op, H.fx);
		const ch = await issueChallenge(op, g.req);
		const body = decisionBody(g.req, ch, "reject");
		const first = await decide(op, g.req, body);
		expect(first.status).toBe(201);
		const again = await decide(op, g.req, body);
		expect([again.status, again.body.replayed]).toEqual([201, true]);
		expect(again.body.receipt).toEqual(first.body.receipt);
	});
});

describe("sanity", () => {
	test("sign-in helper honours the exact origin", async () => {
		await expect(
			signIn(H.base, H.credential, "http://127.0.0.1:6123"),
		).rejects.toThrow();
	});
});
