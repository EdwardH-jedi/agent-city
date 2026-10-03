// Review finding 3 (P1): authority must hold at the COMMIT boundary, not only at request start.
// The decision service reads its clock inside the transaction callback (after BEGIN IMMEDIATE holds
// the write lock). These tests drive both gates with a deterministic barrier immediately before
// the transaction (`DecisionHooks.beforeTransaction`) that advances the fake clock or revokes the
// session — the honest in-process model of time spent waiting for the lock or in Gate-2
// revalidation: bun:sqlite blocks the thread while waiting, so no in-process test can move a clock
// *during* the wait itself; the barrier is the last point before the callback runs.
//
// Every refused commit must leave the database byte-identical: no decision/receipt, challenge still
// `issued`, nothing queued, nothing accepted. A successful decision must still replay under current
// valid authentication even after its challenge was consumed and has expired.
import { afterEach, describe, expect, test } from "bun:test";
import { getTask } from "../../managed/store.ts";
import {
	approvedTask,
	challenge,
	count,
	createTask,
	decisionBody,
	dump,
	type Env,
	type EnvOptions,
	makeEnv,
	openGate2,
	publish,
	runEngine,
} from "./test-support.ts";

const envs: Env[] = [];
afterEach(() => {
	for (const e of envs.splice(0)) e.fx.cleanup();
});

type Gate = "run" | "result";
const CHALLENGE_TTL = 300_000;
const SESSION_TTL = 120_000;

/** One env per case; `barrier` runs right before the decision transaction (once per decide call). */
function setup(o: Omit<EnvOptions, "hooks"> = {}) {
	let barrier: ((n: number) => void | Promise<void>) | null = null;
	let inTx: ((point: string) => void) | null = null;
	let calls = 0;
	const e = makeEnv({
		...o,
		auth: {
			session_ttl_ms: SESSION_TTL,
			idle_timeout_ms: SESSION_TTL,
			challenge_ttl_ms: CHALLENGE_TTL,
			...o.auth,
		},
		hooks: {
			beforeTransaction: () => {
				calls += 1;
				return barrier?.(calls);
			},
			inDecisionTx: (point) => inTx?.(point),
		},
	});
	envs.push(e);
	return {
		e,
		setBarrier(f: ((n: number) => void | Promise<void>) | null) {
			barrier = f;
			calls = 0;
		},
		setInTx(f: ((point: string) => void) | null) {
			inTx = f;
		},
	};
}

/** Bring one approval request of `gate` to pending, with a fresh challenge. */
async function pendingRequest(e: Env, gate: Gate) {
	const v = await e.ctx();
	let requestId: string;
	let taskId: string;
	if (gate === "run") {
		const created = await createTask(e, v);
		const { request } = await publish(e, v, created.task.id);
		requestId = request.id;
		taskId = created.task.id;
	} else {
		const ids = await approvedTask(e, v);
		await runEngine(e);
		const g2 = await openGate2(e, ids);
		requestId = g2.id;
		taskId = ids.taskId;
	}
	const ch = challenge(e, v, requestId);
	return { v, requestId, taskId, ch };
}

const decisionsFor = (e: Env, requestId: string) =>
	count(
		e.db,
		"SELECT count(*) AS n FROM managed_decisions WHERE approval_request_id = ?",
		requestId,
	);

function expectNoEffect(
	e: Env,
	before: string,
	requestId: string,
	res: { status: number; body: unknown },
) {
	expect(res.status).toBe(409);
	expect((res.body as { error: string }).error).toBe("challenge_invalid");
	expect(dump(e.db)).toBe(before); // byte-identical: nothing consumed, decided, queued or accepted
	expect(decisionsFor(e, requestId)).toBe(0);
	expect(e.store.getApprovalRequest(requestId)?.challenge_status).toBe(
		"issued",
	);
}

describe.each<Gate>(["run", "result"])(
	"commit-time authority — %s gate",
	(gate) => {
		test("challenge expires between validation and commit → refused, no effects", async () => {
			// session outlives the challenge here, so only the challenge expiry can refuse the commit
			const { e, setBarrier } = setup({
				auth: { session_ttl_ms: 3_600_000, idle_timeout_ms: 3_600_000 },
			});
			const { v, requestId, ch } = await pendingRequest(e, gate);
			const before = dump(e.db);
			setBarrier(() => e.clock.advance(CHALLENGE_TTL + 1));
			const res = await e.services.decisions.decide(
				v,
				requestId,
				decisionBody(ch),
				e.now(), // request-entry time: still inside the challenge window
			);
			expectNoEffect(e, before, requestId, res);
		});

		test("session expires between validation and commit → refused, no effects", async () => {
			const { e, setBarrier } = setup();
			const { v, requestId, ch } = await pendingRequest(e, gate);
			const before = dump(e.db);
			// past the absolute session lifetime, still well inside the challenge window
			setBarrier(() => e.clock.advance(SESSION_TTL + 1));
			const res = await e.services.decisions.decide(
				v,
				requestId,
				decisionBody(ch),
				e.now(),
			);
			expectNoEffect(e, before, requestId, res);
		});

		test("session revoked between validation and commit → refused, no effects", async () => {
			const { e, setBarrier } = setup();
			const { v, requestId, ch } = await pendingRequest(e, gate);
			const before = dump(e.db);
			setBarrier(() => e.auth.revokeAllSessions());
			const res = await e.services.decisions.decide(
				v,
				requestId,
				decisionBody(ch),
				e.now(),
			);
			expectNoEffect(e, before, requestId, res);
		});

		test("a delay that stays inside both windows commits, stamped with the commit-time clock", async () => {
			const { e, setBarrier } = setup();
			const { v, requestId, ch, taskId } = await pendingRequest(e, gate);
			const requestStart = e.now();
			setBarrier(() => e.clock.advance(30_000));
			const res = await e.services.decisions.decide(
				v,
				requestId,
				decisionBody(ch),
				requestStart,
			);
			expect(res.status).toBe(201);
			const receipt = (res.body as { receipt: { decided_at: string } }).receipt;
			// decided at the authoritative commit-time read, not at request start
			expect(receipt.decided_at).toBe(e.now().toISOString());
			expect(receipt.decided_at).not.toBe(requestStart.toISOString());
			expect(decisionsFor(e, requestId)).toBe(1);
			if (gate === "run") {
				const managed = getTask(
					e.db,
					e.store.getApprovalRequest(requestId)?.managed_task_id ?? "",
				);
				expect(managed?.state).toBe("queued");
				expect(managed?.run_requested_at).toBe(receipt.decided_at);
			} else {
				expect(e.store.getTask(taskId)?.stage).toBe("accepted");
			}
		});

		test("concurrent submissions: the one committing after expiry is refused; exactly one decision", async () => {
			const { e, setBarrier } = setup({
				auth: { session_ttl_ms: 3_600_000, idle_timeout_ms: 3_600_000 },
			});
			const { v, requestId, ch } = await pendingRequest(e, gate);
			// the second call to reach the barrier waits until the first has committed, then finds the
			// challenge expired (and already consumed) at its own commit-time clock read
			let release: () => void = () => undefined;
			const firstCommitted = new Promise<void>((r) => {
				release = r;
			});
			setBarrier(async (n) => {
				if (n === 2) {
					await firstCommitted;
					e.clock.advance(CHALLENGE_TTL + 1);
				}
			});
			const pa = e.services.decisions.decide(
				v,
				requestId,
				decisionBody(ch),
				e.now(),
			);
			const pb = e.services.decisions.decide(
				v,
				requestId,
				decisionBody(ch),
				e.now(),
			);
			await Promise.race([pa, pb]);
			release();
			const [a, b] = await Promise.all([pa, pb]);
			expect([a.status, b.status].sort()).toEqual([201, 409]);
			expect(decisionsFor(e, requestId)).toBe(1);
		});

		test("rollback after consumption leaves no trace; a retry inside the window commits once", async () => {
			const { e, setInTx } = setup();
			const { v, requestId, ch } = await pendingRequest(e, gate);
			const before = dump(e.db);
			setInTx((point) => {
				if (point === "after_insert_decision") throw new Error("injected");
			});
			await expect(
				e.services.decisions.decide(v, requestId, decisionBody(ch), e.now()),
			).rejects.toThrow("injected");
			expect(dump(e.db)).toBe(before);
			expect(e.store.getApprovalRequest(requestId)?.challenge_status).toBe(
				"issued",
			);
			setInTx(null);
			const retry = await e.services.decisions.decide(
				v,
				requestId,
				decisionBody(ch),
				e.now(),
			);
			expect(retry.status).toBe(201);
			expect(decisionsFor(e, requestId)).toBe(1);
		});

		test("a rollback whose retry happens after expiry commits nothing", async () => {
			const { e, setInTx, setBarrier } = setup({
				auth: { session_ttl_ms: 3_600_000, idle_timeout_ms: 3_600_000 },
			});
			const { v, requestId, ch } = await pendingRequest(e, gate);
			const before = dump(e.db);
			setInTx((point) => {
				if (point === "after_insert_decision") throw new Error("injected");
			});
			await expect(
				e.services.decisions.decide(v, requestId, decisionBody(ch), e.now()),
			).rejects.toThrow("injected");
			setInTx(null);
			setBarrier(() => e.clock.advance(CHALLENGE_TTL + 1));
			const late = await e.services.decisions.decide(
				v,
				requestId,
				decisionBody(ch),
				e.now(),
			);
			expectNoEffect(e, before, requestId, late);
		});

		test("successful receipt replays after its challenge was consumed and expired (session still valid)", async () => {
			const { e } = setup({
				auth: { session_ttl_ms: 3_600_000, idle_timeout_ms: 3_600_000 },
			});
			const { v, requestId, ch } = await pendingRequest(e, gate);
			const body = decisionBody(ch);
			const first = await e.services.decisions.decide(
				v,
				requestId,
				body,
				e.now(),
			);
			expect(first.status).toBe(201);
			const afterFirst = dump(e.db);
			e.clock.advance(CHALLENGE_TTL + 1); // challenge consumed AND expired; session live
			const replay = await e.services.decisions.decide(
				v,
				requestId,
				body,
				e.now(),
			);
			expect(replay.status).toBe(201);
			expect((replay.body as { replayed: boolean }).replayed).toBe(true);
			expect(dump(e.db)).toBe(afterFirst);
			expect(decisionsFor(e, requestId)).toBe(1);
		});

		test("replay over HTTP needs current authentication: an expired session gets 401, a fresh one replays", async () => {
			const { e } = setup();
			const s = await e.login();
			const v = await e.ctx(s);
			let requestId: string;
			if (gate === "run") {
				const created = await createTask(e, v);
				requestId = (await publish(e, v, created.task.id)).request.id;
			} else {
				const ids = await approvedTask(e, v);
				await runEngine(e);
				requestId = (await openGate2(e, ids)).id;
			}
			const ch = challenge(e, v, requestId);
			const body = decisionBody(ch);
			const path = `/approval-requests/${requestId}/decisions`;
			expect((await e.request("POST", path, s, body)).status).toBe(201);
			e.clock.advance(SESSION_TTL + 1);
			expect((await e.request("POST", path, s, body)).status).toBe(401);
			const fresh = await e.login();
			const again = await e.request("POST", path, fresh, body);
			expect(again.status).toBe(201);
			expect(((await again.json()) as { replayed: boolean }).replayed).toBe(
				true,
			);
			expect(decisionsFor(e, requestId)).toBe(1);
		});
	},
);
