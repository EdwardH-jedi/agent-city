// Real-hub transport skeleton (role 07) against a fake fetch: same-origin credentials, CSRF only
// in memory and only on mutations, contract parsing, error mapping, byte-identical decisions.
import { describe, expect, test } from "bun:test";
import { emptyDraft } from "@agent-city/schema/workspace-m1";
import { createFetchTransport } from "./fetch-transport.ts";

interface Seen {
	url: string;
	init: RequestInit;
}

function fakeFetch(answers: (Response | Error)[]) {
	const seen: Seen[] = [];
	const fetchImpl = async (url: string, init: RequestInit) => {
		seen.push({ url, init });
		const a = answers.shift();
		if (!a) throw new Error("no answer queued");
		if (a instanceof Error) throw a;
		return a;
	};
	return { seen, fetchImpl };
}

const jsonRes = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const CSRF = `csrf${"A".repeat(39)}`; // synthetic 43-char token, built at runtime
const session = {
	operator_id: "operator:edward",
	scopes: ["workspace:read", "workspace:decide"],
	csrf_token: CSRF,
	expires_at: "2026-10-02T12:00:00.000Z",
};
const TASK = "wst-00000000-0000-4000-8000-000000000002";
const REQ = "wsa-00000000-0000-4000-8000-000000000003";
const header = (s: Seen, name: string) =>
	(s.init.headers as Record<string, string>)[name] ?? null;

describe("fetch transport", () => {
	test("session: same-origin, no-store; CSRF kept in memory and sent only on mutations", async () => {
		const f = fakeFetch([
			jsonRes(200, session),
			jsonRes(409, { error: "stale_binding", message: "changed" }),
			jsonRes(401, { error: "unauthenticated", message: "no" }),
			jsonRes(409, { error: "stale_binding", message: "changed" }),
		]);
		const tx = createFetchTransport({ fetchImpl: f.fetchImpl });
		const s = await tx.getSession();
		expect(s.ok).toBe(true);
		const first = f.seen[0] as Seen;
		expect(first.url).toBe("/api/workspace/session");
		expect(first.init.credentials).toBe("same-origin");
		expect(first.init.cache).toBe("no-store");
		expect(header(first, "x-agentcity-csrf")).toBeNull(); // GET: no CSRF
		await tx.saveDraft(TASK, { expected_rev: 1, draft: emptyDraft() });
		expect(f.seen[1]?.init.method).toBe("PUT");
		expect(f.seen[1]?.url).toBe(`/api/workspace/tasks/${TASK}/draft`);
		expect(header(f.seen[1] as Seen, "x-agentcity-csrf")).toBe(CSRF);
		// a 401 forgets the CSRF value
		await tx.getSnapshot();
		await tx.cancel(TASK, { expected_rev: 1 });
		expect(header(f.seen[3] as Seen, "x-agentcity-csrf")).toBeNull();
	});

	test("the sign-in credential travels only in the body", async () => {
		const f = fakeFetch([jsonRes(200, session)]);
		const tx = createFetchTransport({ fetchImpl: f.fetchImpl });
		const credential = `cred-${"z".repeat(20)}`;
		await tx.signIn({ credential });
		const s = f.seen[0] as Seen;
		expect(s.url.includes(credential)).toBe(false);
		expect(JSON.parse(s.init.body as string)).toEqual({ credential });
	});

	test("decisions send the given bytes unchanged", async () => {
		const f = fakeFetch([new Error("reset"), new Error("reset")]);
		const tx = createFetchTransport({ fetchImpl: f.fetchImpl });
		const bytes = '{"idempotency_key":"dk-1","kind":"run"}';
		const a = await tx.decide(REQ, bytes);
		const b = await tx.decide(REQ, bytes);
		expect(a.ok || a.kind).toBe("network");
		expect(b.ok || b.kind).toBe("network");
		expect(f.seen[0]?.init.body).toBe(bytes);
		expect(f.seen[1]?.init.body).toBe(bytes);
		expect(f.seen[0]?.url).toBe(
			`/api/workspace/approval-requests/${REQ}/decisions`,
		);
	});

	test("answers are parsed: malformed success → invalid_response; foreign error → invalid_response", async () => {
		const f = fakeFetch([
			jsonRes(200, { not: "a snapshot" }),
			jsonRes(500, { error: "internal" }),
			jsonRes(404, { error: "stale_binding", message: "status mismatch" }),
			jsonRes(409, { error: "challenge_invalid", message: "x" }),
			new Response("<html>", { status: 502 }),
		]);
		const tx = createFetchTransport({ fetchImpl: f.fetchImpl });
		const kinds = [];
		for (let i = 0; i < 5; i++) {
			const r = await tx.getSnapshot();
			kinds.push(r.ok ? "ok" : r.kind === "http" ? r.error.error : r.kind);
		}
		expect(kinds).toEqual([
			"invalid_response",
			"invalid_response",
			"invalid_response",
			"challenge_invalid",
			"invalid_response",
		]);
	});

	test("ids are validated before any URL is built", async () => {
		const f = fakeFetch([]);
		const tx = createFetchTransport({ fetchImpl: f.fetchImpl });
		const r = await tx.getTask("../../session");
		expect(r.ok).toBe(false);
		expect(f.seen).toHaveLength(0);
		const r2 = await tx.decide("wsa-x", "{}");
		expect(r2.ok).toBe(false);
		expect(f.seen).toHaveLength(0);
	});

	test("sign-out is DELETE and answers null on 204", async () => {
		const f = fakeFetch([new Response(null, { status: 204 })]);
		const tx = createFetchTransport({ fetchImpl: f.fetchImpl });
		const r = await tx.signOut();
		expect(r).toEqual({ ok: true, status: 204, data: null });
		expect(f.seen[0]?.init.method).toBe("DELETE");
	});
});

describe("CSRF is bound to the session generation (09 F-1)", () => {
	/** A fetch whose answers are released by the test, in any order. */
	function heldFetch() {
		const seen: Seen[] = [];
		const pending: ((r: Response) => void)[] = [];
		const fetchImpl = (url: string, init: RequestInit) => {
			seen.push({ url, init });
			return new Promise<Response>((resolve) => pending.push(resolve));
		};
		return { seen, pending, fetchImpl };
	}
	const CSRF2 = `csrf${"B".repeat(39)}`;
	const session2 = { ...session, csrf_token: CSRF2 };

	test("a late 401 of the old generation never clears the new session's CSRF", async () => {
		const f = heldFetch();
		const tx = createFetchTransport({ fetchImpl: f.fetchImpl });
		const s1 = tx.getSession();
		f.pending[0]?.(jsonRes(200, session));
		await s1;
		const held = tx.getSnapshot(); // generation 1, held
		const out = tx.signOut();
		expect(header(f.seen[2] as Seen, "x-agentcity-csrf")).toBe(CSRF); // DELETE carries gen-1 CSRF
		f.pending[2]?.(new Response(null, { status: 204 }));
		await out;
		const s2 = tx.signIn({ credential: `cred-${"z".repeat(20)}` });
		f.pending[3]?.(jsonRes(200, session2));
		await s2;
		f.pending[1]?.(
			jsonRes(401, { error: "unauthenticated", message: "old session" }),
		);
		const late = await held;
		expect(late.ok).toBe(false);
		const save = tx.saveDraft(TASK, { expected_rev: 1, draft: emptyDraft() });
		expect(header(f.seen[4] as Seen, "x-agentcity-csrf")).toBe(CSRF2);
		f.pending[4]?.(jsonRes(409, { error: "stale_binding", message: "x" }));
		await save;
	});

	test("a 401 of the CURRENT generation still forgets the CSRF", async () => {
		const f = heldFetch();
		const tx = createFetchTransport({ fetchImpl: f.fetchImpl });
		const s1 = tx.getSession();
		f.pending[0]?.(jsonRes(200, session));
		await s1;
		const snap = tx.getSnapshot();
		f.pending[1]?.(
			jsonRes(401, { error: "unauthenticated", message: "expired" }),
		);
		await snap;
		const c = tx.cancel(TASK, { expected_rev: 1 });
		expect(header(f.seen[2] as Seen, "x-agentcity-csrf")).toBeNull();
		f.pending[2]?.(jsonRes(401, { error: "unauthenticated", message: "x" }));
		await c;
	});

	test("a GET /session answered after a sign-in does not overwrite the new CSRF", async () => {
		const f = heldFetch();
		const tx = createFetchTransport({ fetchImpl: f.fetchImpl });
		const boot = tx.getSession(); // started before the sign-in
		const s = tx.signIn({ credential: `cred-${"z".repeat(20)}` });
		f.pending[1]?.(jsonRes(200, session2));
		await s;
		f.pending[0]?.(jsonRes(200, session)); // stale confirmation of an older session
		await boot;
		const save = tx.saveDraft(TASK, { expected_rev: 1, draft: emptyDraft() });
		expect(header(f.seen[2] as Seen, "x-agentcity-csrf")).toBe(CSRF2);
		f.pending[2]?.(jsonRes(409, { error: "stale_binding", message: "x" }));
		await save;
	});
});
