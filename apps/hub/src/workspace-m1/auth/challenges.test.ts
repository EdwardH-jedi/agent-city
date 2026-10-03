// ChallengePort tests (role 03) against an in-memory WorkspaceTx fake that enforces the port's CAS
// contract and re-validates every row with the frozen ApprovalRequestRow schema. Contexts come from
// real requests through the guard (a VerifiedAuthContext cannot be built by hand). Tokens are
// generated at runtime.
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type {
	ApprovalRequestRow,
	VerifiedAuthContext,
} from "@agent-city/schema/workspace-m1";
import { challengeHash } from "@agent-city/schema/workspace-m1/hash";
import { ChallengePortError } from "./challenges.ts";
import {
	BASE,
	FakeTx,
	type Harness,
	harness,
	mutationHeaders,
	runRequestRow,
	type Session,
	signIn,
} from "./test-support.ts";

const token43 = () => randomBytes(32).toString("base64url");
const INVALID = { ok: false, code: "challenge_invalid" } as const;

/** A fresh VerifiedAuthContext for `s`, minted by a real mutation through the guard. */
async function verifiedFor(
	h: Harness,
	s: Session,
): Promise<VerifiedAuthContext> {
	const res = await h.app.request(`${BASE}/tasks`, {
		method: "POST",
		headers: mutationHeaders(s),
		body: "{}",
	});
	if (res.status !== 200 || h.seen.verified === null)
		throw new Error(`no verified context (${res.status})`);
	return h.seen.verified;
}

async function setup(over: Parameters<typeof harness>[0] = {}) {
	const h = harness(over);
	const row = runRequestRow();
	h.tx.put(row);
	const s = await signIn(h);
	const auth = await verifiedFor(h, s);
	return { h, row, s, auth };
}

const current = (h: Harness, id: string) => {
	const r = h.tx.getApprovalRequest(id);
	if (!r) throw new Error("row missing");
	return r;
};

describe("issue", () => {
	test("stores only H(ChallengeBinding) + bound fields, bumps rev once, returns the token once", async () => {
		const { h, row, auth } = await setup();
		const now = h.clock.now();
		const out = h.auth.challenges.issue(h.tx, row, auth, now);
		expect(out.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(out.request_rev).toBe(row.rev + 1);
		expect(out.approval_request_id).toBe(row.id);
		expect(out.kind).toBe("run");
		expect(out.binding_hash).toBe(row.binding_hash);
		expect(out.expires_at).toBe(
			new Date(now.getTime() + 300_000).toISOString(),
		);
		const after = current(h, row.id);
		expect(after.rev).toBe(row.rev + 1);
		expect(after.challenge_status).toBe("issued");
		expect(after.challenge_request_rev).toBe(after.rev);
		expect(after.challenge_boot_id).toBe(auth.principal.boot_id);
		expect(after.challenge_operator_id).toBe(auth.principal.operator_id);
		expect(after.challenge_session_generation).toBe(
			auth.principal.session_generation,
		);
		expect(after.challenge_issued_at).toBe(now.toISOString());
		expect(after.challenge_hash).toBe(
			challengeHash({
				token: out.challenge,
				approval_request_id: row.id,
				kind: "run",
				binding_hash: row.binding_hash,
				request_rev: after.rev,
				operator_id: auth.principal.operator_id,
				session_generation: auth.principal.session_generation,
				boot_id: auth.principal.boot_id,
				expires_at: out.expires_at,
			}),
		);
		expect(JSON.stringify(after)).not.toContain(out.challenge);
		expect(h.tx.writes).toBe(1);
	});

	test("refuses non-pending requests and stale rows without writing", async () => {
		const { h, row, auth } = await setup();
		for (const status of [
			"approved",
			"rejected",
			"changes_requested",
		] as const) {
			const closed = { ...row, status, closed_at: row.created_at };
			expect(() =>
				h.auth.challenges.issue(h.tx, closed, auth, h.clock.now()),
			).toThrow(ChallengePortError);
		}
		const invalidated = {
			...row,
			status: "invalidated" as const,
			invalidation_reason: "proposal_superseded" as const,
			closed_at: row.created_at,
		};
		try {
			h.auth.challenges.issue(h.tx, invalidated, auth, h.clock.now());
			throw new Error("expected refusal");
		} catch (err) {
			expect((err as ChallengePortError).code).toBe("invalid_state");
		}
		const stale = { ...row, rev: row.rev + 5 };
		try {
			h.auth.challenges.issue(h.tx, stale, auth, h.clock.now());
			throw new Error("expected refusal");
		} catch (err) {
			expect((err as ChallengePortError).code).toBe("stale_binding");
		}
		expect(h.tx.writes).toBe(0);
		expect(current(h, row.id)).toEqual(row);
	});

	test("forged or foreign contexts are refused (a context cannot be constructed by hand)", async () => {
		const { h, row, auth } = await setup();
		const forged: VerifiedAuthContext = {
			principal: { ...auth.principal },
			origin_verified: true,
			csrf_verified: true,
		};
		expect(() =>
			h.auth.challenges.issue(h.tx, row, forged, h.clock.now()),
		).toThrow(ChallengePortError);
		const other = harness({}, { clock: h.clock, tx: h.tx });
		const otherAuth = await verifiedFor(other, await signIn(other));
		expect(() =>
			h.auth.challenges.issue(h.tx, row, otherAuth, h.clock.now()),
		).toThrow(ChallengePortError);
		expect(h.tx.writes).toBe(0);
	});

	test("a context whose session was signed out or went idle is refused", async () => {
		const { h, row, auth } = await setup({ idle_timeout_ms: 10_000 });
		h.clock.advance(10_000);
		expect(() =>
			h.auth.challenges.issue(h.tx, row, auth, h.clock.now()),
		).toThrow(ChallengePortError);
		const s2 = await signIn(h);
		const auth2 = await verifiedFor(h, s2);
		await h.app.request(`${BASE}/session`, {
			method: "DELETE",
			headers: mutationHeaders(s2, { "content-type": undefined }),
		});
		expect(() =>
			h.auth.challenges.issue(h.tx, row, auth2, h.clock.now()),
		).toThrow(ChallengePortError);
		expect(h.tx.writes).toBe(0);
	});

	test("TTL is configurable and clamped to 300 s", async () => {
		const short = await setup({ challenge_ttl_ms: 60_000 });
		const a = short.h.auth.challenges.issue(
			short.h.tx,
			short.row,
			short.auth,
			short.h.clock.now(),
		);
		expect(Date.parse(a.expires_at) - short.h.clock.now().getTime()).toBe(
			60_000,
		);
		const long = await setup({ challenge_ttl_ms: 3_600_000 });
		expect(long.h.auth.settings?.challenge_ttl_ms).toBe(300_000);
		const b = long.h.auth.challenges.issue(
			long.h.tx,
			long.row,
			long.auth,
			long.h.clock.now(),
		);
		expect(Date.parse(b.expires_at) - long.h.clock.now().getTime()).toBe(
			300_000,
		);
	});

	test("a store that breaks the CAS contract (rev not +1) aborts the transaction", async () => {
		const { h, row, auth } = await setup();
		class SkippingTx extends FakeTx {
			override updateApprovalRequest(
				id: string,
				rev: number,
				patch: Parameters<FakeTx["updateApprovalRequest"]>[2],
				now: string,
			) {
				const r = super.updateApprovalRequest(id, rev, patch, now);
				return r ? { ...r, rev: r.rev + 1 } : null;
			}
		}
		const tx = new SkippingTx();
		tx.put(row);
		expect(() => h.auth.challenges.issue(tx, row, auth, h.clock.now())).toThrow(
			/CAS contract/,
		);
	});
});

describe("verifyAndConsume", () => {
	test("success consumes once and returns the row at rev + 1; replay is challenge_invalid", async () => {
		const { h, row, auth } = await setup();
		const out = h.auth.challenges.issue(h.tx, row, auth, h.clock.now());
		const issued = current(h, row.id);
		const res = h.auth.challenges.verifyAndConsume(
			h.tx,
			issued,
			out.challenge,
			auth,
			h.clock.now(),
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.request.rev).toBe(issued.rev + 1);
		expect(res.request.challenge_status).toBe("consumed");
		expect(current(h, row.id)).toEqual(res.request);
		// replay with the new row, with the old row, and with a fresh context of the same session
		expect(
			h.auth.challenges.verifyAndConsume(
				h.tx,
				res.request,
				out.challenge,
				auth,
				h.clock.now(),
			),
		).toEqual(INVALID);
		expect(
			h.auth.challenges.verifyAndConsume(
				h.tx,
				issued,
				out.challenge,
				auth,
				h.clock.now(),
			),
		).toEqual(INVALID);
		expect(current(h, row.id)).toEqual(res.request);
	});

	test("every failed attempt writes nothing and leaves the challenge usable (R-A2)", async () => {
		const { h, row, s, auth } = await setup();
		const other = runRequestRow("b");
		h.tx.put(other);
		const out = h.auth.challenges.issue(h.tx, row, auth, h.clock.now());
		const otherOut = h.auth.challenges.issue(h.tx, other, auth, h.clock.now());
		const issued = current(h, row.id);
		const writes = h.tx.writes;
		const second = await signIn(h); // same operator, new session generation
		const secondAuth = await verifiedFor(h, second);
		const freshSame = await verifiedFor(h, s); // same session, new request context → still valid
		const attempts: [string, () => unknown][] = [
			[
				"forged token",
				() =>
					h.auth.challenges.verifyAndConsume(
						h.tx,
						issued,
						token43(),
						auth,
						h.clock.now(),
					),
			],
			[
				"other request's token",
				() =>
					h.auth.challenges.verifyAndConsume(
						h.tx,
						issued,
						otherOut.challenge,
						auth,
						h.clock.now(),
					),
			],
			[
				"token on the other request",
				() =>
					h.auth.challenges.verifyAndConsume(
						h.tx,
						current(h, other.id),
						out.challenge,
						auth,
						h.clock.now(),
					),
			],
			[
				"kind flipped",
				() =>
					h.auth.challenges.verifyAndConsume(
						h.tx,
						{ ...issued, kind: "result" } as ApprovalRequestRow,
						out.challenge,
						auth,
						h.clock.now(),
					),
			],
			[
				"binding changed",
				() =>
					h.auth.challenges.verifyAndConsume(
						h.tx,
						{ ...issued, binding_hash: "0".repeat(64) },
						out.challenge,
						auth,
						h.clock.now(),
					),
			],
			[
				"rev moved",
				() =>
					h.auth.challenges.verifyAndConsume(
						h.tx,
						{ ...issued, rev: issued.rev + 1 },
						out.challenge,
						auth,
						h.clock.now(),
					),
			],
			[
				"other session of the same operator",
				() =>
					h.auth.challenges.verifyAndConsume(
						h.tx,
						issued,
						out.challenge,
						secondAuth,
						h.clock.now(),
					),
			],
			[
				"expired (now = expires_at)",
				() =>
					h.auth.challenges.verifyAndConsume(
						h.tx,
						issued,
						out.challenge,
						auth,
						new Date(Date.parse(out.expires_at)),
					),
			],
			[
				"not a string",
				() =>
					h.auth.challenges.verifyAndConsume(
						h.tx,
						issued,
						42 as unknown as string,
						auth,
						h.clock.now(),
					),
			],
			[
				"empty",
				() =>
					h.auth.challenges.verifyAndConsume(
						h.tx,
						issued,
						"",
						auth,
						h.clock.now(),
					),
			],
			[
				"44 chars",
				() =>
					h.auth.challenges.verifyAndConsume(
						h.tx,
						issued,
						`${out.challenge}A`,
						auth,
						h.clock.now(),
					),
			],
			[
				"status not pending",
				() =>
					h.auth.challenges.verifyAndConsume(
						h.tx,
						{ ...issued, status: "approved", closed_at: issued.created_at },
						out.challenge,
						auth,
						h.clock.now(),
					),
			],
			[
				"forged context",
				() =>
					h.auth.challenges.verifyAndConsume(
						h.tx,
						issued,
						out.challenge,
						{
							principal: { ...auth.principal },
							origin_verified: true,
							csrf_verified: true,
						},
						h.clock.now(),
					),
			],
		];
		for (const [name, attempt] of attempts) {
			expect({ name, result: attempt() }).toEqual({ name, result: INVALID });
			expect(h.tx.writes).toBe(writes);
			expect(current(h, row.id)).toEqual(issued);
		}
		// a newer request context of the SAME session is the same principal → still accepted
		const ok = h.auth.challenges.verifyAndConsume(
			h.tx,
			issued,
			out.challenge,
			freshSame,
			new Date(Date.parse(out.expires_at) - 1),
		);
		expect(ok.ok).toBe(true);
	});

	test("supersede: a newer challenge voids the older one", async () => {
		const { h, row, auth } = await setup();
		const c1 = h.auth.challenges.issue(h.tx, row, auth, h.clock.now());
		const c2 = h.auth.challenges.issue(
			h.tx,
			current(h, row.id),
			auth,
			h.clock.now(),
		);
		expect(c2.request_rev).toBe(c1.request_rev + 1);
		const now = current(h, row.id);
		expect(
			h.auth.challenges.verifyAndConsume(
				h.tx,
				now,
				c1.challenge,
				auth,
				h.clock.now(),
			),
		).toEqual(INVALID);
		expect(
			h.auth.challenges.verifyAndConsume(
				h.tx,
				now,
				c2.challenge,
				auth,
				h.clock.now(),
			).ok,
		).toBe(true);
	});

	test("restart: a challenge from the previous boot never verifies; the new boot can issue its own", async () => {
		const { h, row, auth } = await setup();
		const old = h.auth.challenges.issue(h.tx, row, auth, h.clock.now());
		const rebooted = harness(
			{},
			{ clock: h.clock, tx: h.tx, operatorCredential: h.operatorCredential },
		);
		const auth2 = await verifiedFor(rebooted, await signIn(rebooted));
		expect(auth2.principal.boot_id).not.toBe(auth.principal.boot_id);
		const issued = current(h, row.id);
		const writes = h.tx.writes;
		expect(
			rebooted.auth.challenges.verifyAndConsume(
				h.tx,
				issued,
				old.challenge,
				auth2,
				h.clock.now(),
			),
		).toEqual(INVALID);
		// the old instance's context is unusable in the new instance
		expect(
			rebooted.auth.challenges.verifyAndConsume(
				h.tx,
				issued,
				old.challenge,
				auth,
				h.clock.now(),
			),
		).toEqual(INVALID);
		expect(h.tx.writes).toBe(writes);
		const fresh = rebooted.auth.challenges.issue(
			h.tx,
			issued,
			auth2,
			h.clock.now(),
		);
		expect(
			rebooted.auth.challenges.verifyAndConsume(
				h.tx,
				current(h, row.id),
				fresh.challenge,
				auth2,
				h.clock.now(),
			).ok,
		).toBe(true);
	});

	test("expiry boundary: valid 1 ms before expires_at, invalid at it and after", async () => {
		const { h, row, auth } = await setup({
			challenge_ttl_ms: 60_000,
			idle_timeout_ms: 600_000,
		});
		const out = h.auth.challenges.issue(h.tx, row, auth, h.clock.now());
		const issued = current(h, row.id);
		const exp = Date.parse(out.expires_at);
		expect(
			h.auth.challenges.verifyAndConsume(
				h.tx,
				issued,
				out.challenge,
				auth,
				new Date(exp),
			),
		).toEqual(INVALID);
		expect(
			h.auth.challenges.verifyAndConsume(
				h.tx,
				issued,
				out.challenge,
				auth,
				new Date(exp + 1),
			),
		).toEqual(INVALID);
		expect(
			h.auth.challenges.verifyAndConsume(
				h.tx,
				issued,
				out.challenge,
				auth,
				new Date(exp - 1),
			).ok,
		).toBe(true);
	});

	test("sign-out or idle expiry after issuance voids the challenge for that context", async () => {
		const { h, row, s, auth } = await setup({ idle_timeout_ms: 60_000 });
		const out = h.auth.challenges.issue(h.tx, row, auth, h.clock.now());
		const issued = current(h, row.id);
		await h.app.request(`${BASE}/session`, {
			method: "DELETE",
			headers: mutationHeaders(s, { "content-type": undefined }),
		});
		expect(
			h.auth.challenges.verifyAndConsume(
				h.tx,
				issued,
				out.challenge,
				auth,
				h.clock.now(),
			),
		).toEqual(INVALID);
		// re-login = new generation → the old challenge is still not usable
		const again = await verifiedFor(h, await signIn(h));
		expect(
			h.auth.challenges.verifyAndConsume(
				h.tx,
				issued,
				out.challenge,
				again,
				h.clock.now(),
			),
		).toEqual(INVALID);
		expect(current(h, row.id)).toEqual(issued);
	});

	test("a row whose window exceeds the configured TTL is rejected even with a matching hash", async () => {
		const { h, row, auth } = await setup({ challenge_ttl_ms: 60_000 });
		const out = h.auth.challenges.issue(h.tx, row, auth, h.clock.now());
		const issued = current(h, row.id);
		const longer = new Date(Date.parse(out.expires_at) + 600_000).toISOString();
		const tampered: ApprovalRequestRow = {
			...issued,
			challenge_expires_at: longer,
			challenge_hash: challengeHash({
				token: out.challenge,
				approval_request_id: row.id,
				kind: "run",
				binding_hash: row.binding_hash,
				request_rev: issued.rev,
				operator_id: auth.principal.operator_id,
				session_generation: auth.principal.session_generation,
				boot_id: auth.principal.boot_id,
				expires_at: longer,
			}),
		};
		h.tx.put(tampered);
		h.clock.advance(120_000); // past the real expiry, inside the forged window
		expect(
			h.auth.challenges.verifyAndConsume(
				h.tx,
				current(h, row.id),
				out.challenge,
				auth,
				h.clock.now(),
			),
		).toEqual(INVALID);
	});

	test("a CAS miss on the consume write (stale row from the caller) is challenge_invalid, nothing written", async () => {
		const { h, row, auth } = await setup();
		const out = h.auth.challenges.issue(h.tx, row, auth, h.clock.now());
		const issued = current(h, row.id);
		class MissTx extends FakeTx {
			override updateApprovalRequest() {
				return null;
			}
		}
		const miss = new MissTx();
		miss.put(issued);
		expect(
			h.auth.challenges.verifyAndConsume(
				miss,
				issued,
				out.challenge,
				auth,
				h.clock.now(),
			),
		).toEqual(INVALID);
		expect(miss.getApprovalRequest(row.id)).toEqual(issued);
	});
});
