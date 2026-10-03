// Obsolete v1 execution grants through the real bridge + the existing Orchestrator (follow-up P2 of
// the independent re-review): the startup / periodic sweep invalidates a pending legacy Gate 1 with
// the decision path's exact rows; an approved legacy execution is refused at the per-stage authorize
// boundary (queued, between stages) and an active stage gets a cancel intent that the workspace
// reports only once the engine confirms termination; restart reopens nothing; historical rows stay
// byte-identical; a fresh v1.2 version completes both gates. Disposable fixture, fake adapters.
import { afterEach, describe, expect, test } from "bun:test";
import { PROPOSAL_CONTRACT_V1_2 } from "@agent-city/schema/workspace-m1";
import { Orchestrator } from "../../managed/orchestrator.ts";
import { pidAlive } from "../../managed/testkit.ts";
import {
	OBSOLETE_V1_GRANT_DETAIL,
	OBSOLETE_V1_GRANT_STAGE_DETAIL,
} from "../decisions/decision-service.ts";
import { createManagedBridge } from "../decisions/index.ts";
import {
	approveLegacyV1Raw,
	publishLegacyV1,
} from "../decisions/test-support.ts";
import { LEGACY_PROPOSAL_DETAIL } from "../evidence/bundle.ts";
import { evaluateAuthorization } from "./authorize.ts";
import {
	approved,
	type BridgeEnv,
	createTask,
	decide,
	draft,
	dump,
	engineOf,
	HOLD_HEARTBEAT_MS,
	makeBridgeEnv,
	providerSpawns,
	publish,
	restartBridgeEnv,
	resultRequests,
	runsOf,
	stageOf,
	tracker,
	waitFor,
} from "./test-support.ts";

const t = tracker();
afterEach(() => t.cleanup());

const fileEnv = () => t.track(makeBridgeEnv({ fixture: { dbFile: true } }));

const OBSOLETE = {
	error: "stale_binding",
	issues: [{ path: "proposal_id", message: OBSOLETE_V1_GRANT_DETAIL }],
};
const NOTHING_LAUNCHED = {
	preflight: 0,
	implement: 0,
	review: 0,
	lookups: { simulated: 0, live: 0 },
};

/** A genuine legacy (pre-v1.2) publish: v1 proposal + reserved execution + pending Gate 1. */
async function legacyPending(env: BridgeEnv, d = draft()) {
	const v = await env.ctx();
	const taskId = createTask(env, v, d);
	const l = await publishLegacyV1(env, taskId);
	return { v, taskId, ...l };
}

/**
 * The pre-policy approval of a legacy request, committed WITHOUT waking this bridge's reconciler
 * (the pre-policy hub had no obsolete-grant rule): only the per-stage authorize can stop it.
 */
function approveBeforePolicy(
	env: BridgeEnv,
	l: Awaited<ReturnType<typeof legacyPending>>,
) {
	return approveLegacyV1Raw(
		{
			store: env.store,
			auth: env.auth,
			tick: env.tick,
			services: {
				bridge: createManagedBridge({ db: env.db, config: env.config }),
			},
		},
		l.v,
		l.runRequestId,
	);
}

/** One gate a hook can await; `open()` releases it, `reached` resolves when the hook arrives. */
function gate() {
	let open: () => void = () => {};
	let arrive: () => void = () => {};
	const released = new Promise<void>((r) => {
		open = r;
	});
	const reached = new Promise<void>((r) => {
		arrive = r;
	});
	return {
		reached,
		open,
		wait: async () => {
			arrive();
			await released;
		},
	};
}

/** An engine wired like the hub, whose workspace authorize rule switches on when `policy.on`. */
function engineAcrossPolicy(
	env: BridgeEnv,
	policy: { on: boolean },
	o: { heartbeatMs?: number; beforeReview?: () => Promise<void> } = {},
) {
	return new Orchestrator({
		db: env.db,
		config: env.fx.config,
		adapters: env.adapters,
		heartbeatMs: o.heartbeatMs ?? 50,
		authorize: (m) => (policy.on ? env.bridge.authorize(m) : null),
		...(o.beforeReview
			? {
					hooks: {
						at: async (point) => {
							if (point === "before_review") await o.beforeReview?.();
						},
					},
				}
			: {}),
	});
}

const violations = (env: BridgeEnv) =>
	env.alarms.filter((a) => a.kind === "violation");

describe("authorize: an approved v1 grant is obsolete under the current policy", () => {
	test("class `obsolete` with the fixed detail (policy: true); the reconciler's structural pass (policy: false) does not flag it; a v1.2 grant passes", async () => {
		const env = t.track(makeBridgeEnv());
		const l = await legacyPending(env);
		approveBeforePolicy(env, l);
		const m = engineOf(env, l.managedTaskId);
		if (!m) throw new Error("no managed task");
		expect(
			evaluateAuthorization(env.store, env.config, m, { policy: true }),
		).toMatchObject({
			ok: false,
			cls: "obsolete",
			reason: OBSOLETE_V1_GRANT_DETAIL,
		});
		expect(
			evaluateAuthorization(env.store, env.config, m, { policy: false }).ok,
		).toBe(true);
		expect(env.bridge.authorize(m)).toBe(OBSOLETE_V1_GRANT_DETAIL);
		const fresh = await approved(env, l.v);
		const fm = engineOf(env, fresh.managedTaskId);
		if (!fm) throw new Error("no managed task");
		expect(env.bridge.authorize(fm)).toBeNull();
	});
});

describe("pending legacy Gate 1: the sweep retires it", () => {
	test("startup sweep of a new process: invalidated with the decision path's exact rows, reservation released, task in draft; a later challenge gets the same 409; nothing runs", async () => {
		const e1 = fileEnv();
		const l = await legacyPending(e1);
		const e2 = t.track(restartBridgeEnv(e1));
		e2.bridge.start({ intervalMs: 3_600_000 });
		await e2.bridge.idle();
		const row = e2.store.getApprovalRequest(l.runRequestId);
		expect(row).toMatchObject({
			status: "invalidated",
			invalidation_reason: "evidence_unavailable",
			invalidation_detail: OBSOLETE_V1_GRANT_DETAIL,
			challenge_status: "none",
		});
		expect(e2.store.getTask(l.taskId)).toMatchObject({
			stage: "draft",
			stage_detail: OBSOLETE_V1_GRANT_STAGE_DETAIL,
		});
		expect(engineOf(e2, l.managedTaskId)).toMatchObject({
			state: "cancelled",
			run_requested_at: null,
		});
		const v2 = await e2.ctx();
		const ch = e2.services.decisions.issueChallenge(
			v2,
			l.runRequestId,
			{
				kind: "run",
				binding_hash: row?.binding_hash,
				expected_request_rev: row?.rev,
			},
			e2.tick(),
		);
		expect([ch.status, ch.body]).toMatchObject([409, OBSOLETE]);
		await e2.drain();
		expect(e2.calls).toEqual(NOTHING_LAUNCHED);
		expect(providerSpawns(e2.fx)).toBe(0);
		expect(e2.store.listDecisions(l.taskId)).toEqual([]);
		expect(violations(e2)).toEqual([]);
	});
});

describe("approved legacy executions: no further stage launches", () => {
	test("queued (engine first): the per-stage authorize refuses the first stage — approval_void with the obsolete reason, zero adapter use; the workspace ends with the guidance, no violation", async () => {
		const env = t.track(makeBridgeEnv());
		const l = await legacyPending(env);
		approveBeforePolicy(env, l);
		expect(stageOf(env, l.taskId)).toBe("queued");
		await env.drain(env.engine({ onChange: false }));
		const m = engineOf(env, l.managedTaskId);
		expect(m).toMatchObject({
			state: "blocked",
			failure_kind: "approval_void",
		});
		expect(m?.state_detail).toContain(OBSOLETE_V1_GRANT_DETAIL);
		expect(runsOf(env, l.managedTaskId)).toHaveLength(0);
		expect(env.calls).toEqual(NOTHING_LAUNCHED);
		expect(providerSpawns(env.fx)).toBe(0);
		await env.bridge.sweep();
		const task = env.store.getTask(l.taskId);
		expect(task?.stage).toBe("execution_ended");
		expect(task?.stage_detail).toContain(OBSOLETE_V1_GRANT_DETAIL);
		expect(resultRequests(env, l.taskId)).toEqual([]);
		expect(violations(env)).toEqual([]);
	});

	test("queued (reconciler first): the cancel intent cancels it before any claim; the workspace shows cancelled with the guidance; never claimed", async () => {
		const env = t.track(makeBridgeEnv());
		const l = await legacyPending(env);
		approveLegacyV1Raw(env, l.v, l.runRequestId); // through the bridge port → reconciler wakes
		await env.bridge.idle();
		expect(engineOf(env, l.managedTaskId)?.state).toBe("cancelled");
		const task = env.store.getTask(l.taskId);
		expect(task?.stage).toBe("cancelled");
		expect(task?.stage_detail).toContain(OBSOLETE_V1_GRANT_DETAIL);
		await env.drain();
		expect(runsOf(env, l.managedTaskId)).toHaveLength(0);
		expect(env.calls).toEqual(NOTHING_LAUNCHED);
		expect(violations(env)).toEqual([]);
	});

	test("an active stage when the policy arrives: cancel intent recorded, the workspace stays running until the engine confirms termination; no further stage", async () => {
		const env = t.track(makeBridgeEnv());
		const l = await legacyPending(
			env,
			draft({ simulation_scenario: "impl_hangs" }),
		);
		approveBeforePolicy(env, l);
		const policy = { on: false };
		// held heartbeat: the "intent recorded, termination not yet confirmed" window stays open
		const orch = engineAcrossPolicy(env, policy, {
			heartbeatMs: HOLD_HEARTBEAT_MS,
		});
		const running = orch.tick();
		await waitFor(
			() =>
				runsOf(env, l.managedTaskId)[0]?.proc_phase === "implement" &&
				runsOf(env, l.managedTaskId)[0]?.child_pid != null,
			"the hanging legacy implementer child",
		);
		const pid = runsOf(env, l.managedTaskId)[0]?.child_pid ?? 0;
		policy.on = true; // the policy arrives while the stage runs
		await env.bridge.sweep();
		const mid = engineOf(env, l.managedTaskId);
		expect(mid?.state).toBe("executing");
		expect(mid?.cancel_requested_at).not.toBeNull();
		expect(stageOf(env, l.taskId)).toBe("running"); // intent only: never cancelled before proof
		expect(pidAlive(pid)).toBe(true);

		await orch.shutdown(); // releases the held heartbeat: the engine terminates + confirms
		await running;
		await env.bridge.sweep();
		expect(engineOf(env, l.managedTaskId)?.state).toBe("cancelled");
		expect(pidAlive(pid)).toBe(false);
		const task = env.store.getTask(l.taskId);
		expect(task?.stage).toBe("cancelled");
		expect(task?.stage_detail).toContain(OBSOLETE_V1_GRANT_DETAIL);
		expect(resultRequests(env, l.taskId)).toEqual([]);
		await env.drain(); // a fresh engine (policy on) launches nothing more
		expect(runsOf(env, l.managedTaskId)).toHaveLength(1);
		expect([env.calls.implement, env.calls.review]).toEqual([1, 0]);
		expect(violations(env)).toEqual([]);
	});

	test("between stages when the policy arrives: the next stage is refused at the authorize boundary (review never launches, no result)", async () => {
		const env = t.track(makeBridgeEnv());
		const l = await legacyPending(env);
		approveBeforePolicy(env, l);
		const policy = { on: false };
		const g = gate();
		const orch = engineAcrossPolicy(env, policy, { beforeReview: g.wait });
		const running = (async () => {
			while (await orch.tick()) {
				// drain
			}
		})();
		await g.reached; // implement + verification done, paused before the review stage
		expect([env.calls.implement, env.calls.review]).toEqual([1, 0]);
		policy.on = true;
		g.open();
		await running;
		const m = engineOf(env, l.managedTaskId);
		expect(m).toMatchObject({
			state: "blocked",
			failure_kind: "approval_void",
		});
		expect(m?.state_detail).toContain(OBSOLETE_V1_GRANT_DETAIL);
		expect(m?.result_run_id).toBeNull();
		expect(env.calls.review).toBe(0);
		await env.bridge.sweep();
		const task = env.store.getTask(l.taskId);
		expect(task?.stage).toBe("execution_ended");
		expect(task?.stage_detail).toContain(OBSOLETE_V1_GRANT_DETAIL);
		expect(resultRequests(env, l.taskId)).toEqual([]);
	});

	test("a legacy execution that already reached human_ready before the policy keeps the existing honest record (sealed, invalidated with LEGACY_PROPOSAL_DETAIL)", async () => {
		const env = t.track(makeBridgeEnv());
		const l = await legacyPending(env);
		approveBeforePolicy(env, l);
		await env.drain(env.engine({ authorize: false, onChange: false })); // pre-policy engine
		expect(engineOf(env, l.managedTaskId)?.state).toBe("human_ready");
		await env.bridge.sweep();
		const [r] = resultRequests(env, l.taskId);
		expect(r).toMatchObject({
			status: "invalidated",
			invalidation_reason: "evidence_unavailable",
		});
		expect(r?.invalidation_detail).toContain(LEGACY_PROPOSAL_DETAIL);
		expect(stageOf(env, l.taskId)).toBe("execution_ended");
		expect(violations(env)).toEqual([]);
	});
});

describe("restart, history, fresh version", () => {
	test("restart cannot reopen an obsolete grant; historical rows stay byte-identical; a fresh v1.2 version completes Gate 1 → execution → Gate 2 → accept", async () => {
		const e1 = fileEnv();
		const a = await legacyPending(e1); // pending legacy Gate 1
		const b = await legacyPending(e1); // legacy Gate 1 approved + queued before the policy
		const rawB = approveBeforePolicy(e1, b);
		const history = (env: BridgeEnv) => {
			const all = (sql: string) => env.db.query(sql).all();
			return {
				proposals: all("SELECT * FROM managed_proposals ORDER BY rowid"),
				decisions: all("SELECT * FROM managed_decisions ORDER BY rowid"),
				bundles: all("SELECT * FROM managed_evidence_bundles ORDER BY rowid"),
				validity: all(
					"SELECT * FROM managed_acceptance_validity ORDER BY rowid",
				),
				approvedRequest: env.db
					.query("SELECT * FROM managed_approval_requests WHERE id = ?")
					.all(b.runRequestId),
			};
		};
		const h0 = history(e1);

		// a new process: the startup sweep retires both
		const e2 = t.track(restartBridgeEnv(e1));
		e2.bridge.start({ intervalMs: 3_600_000 });
		await e2.bridge.idle();
		expect(e2.store.getApprovalRequest(a.runRequestId)?.status).toBe(
			"invalidated",
		);
		expect(stageOf(e2, a.taskId)).toBe("draft");
		expect(engineOf(e2, b.managedTaskId)?.state).toBe("cancelled");
		expect(stageOf(e2, b.taskId)).toBe("cancelled");
		await e2.drain();
		expect(e2.calls).toEqual(NOTHING_LAUNCHED);
		expect(providerSpawns(e2.fx)).toBe(0);

		// another process: nothing reopens, nothing changes
		const e3 = t.track(restartBridgeEnv(e2));
		const before = dump(e3.db);
		await e3.bridge.sweep();
		expect(dump(e3.db)).toBe(before);
		const v3 = await e3.ctx();
		const rowA = e3.store.getApprovalRequest(a.runRequestId);
		const ch = e3.services.decisions.issueChallenge(
			v3,
			a.runRequestId,
			{
				kind: "run",
				binding_hash: rowA?.binding_hash,
				expected_request_rev: rowA?.rev,
			},
			e3.tick(),
		);
		expect([ch.status, ch.body]).toMatchObject([409, OBSOLETE]);
		// the historical receipt still replays verbatim (no new effect)
		const replay = await e3.services.decisions.decide(
			v3,
			b.runRequestId,
			rawB.body,
			e3.tick(),
		);
		expect(replay.ok && replay.body).toEqual({
			receipt: rawB.receipt,
			replayed: true,
		});
		// the v1 proposal cannot run again (draft / cancelled are rerunnable stages)
		for (const x of [a, b]) {
			const task = e3.store.getTask(x.taskId);
			const rerun = e3.services.commands.requestRerun(
				v3,
				x.taskId,
				{ expected_rev: task?.rev ?? 0, proposal_id: x.proposalId },
				e3.tick(),
			);
			expect(rerun.status).toBe(400);
		}
		expect(history(e3)).toEqual(h0);
		expect(dump(e3.db)).toBe(before);

		// the guided way forward: a new v1.2 version + a fresh Gate 1 → execution → Gate 2
		const { runRequestId } = await publish(e3, v3, a.taskId);
		const fresh = e3.store.getApprovalRequest(runRequestId);
		expect(
			fresh && e3.store.getProposal(fresh.proposal_id)?.contract_version,
		).toBe(PROPOSAL_CONTRACT_V1_2);
		expect((await decide(e3, v3, runRequestId)).status).toBe(201);
		await e3.drain();
		const [result] = resultRequests(e3, a.taskId);
		expect(result?.status).toBe("pending");
		const accept = await decide(e3, v3, result?.id as string);
		expect(accept.status).toBe(201);
		expect(stageOf(e3, a.taskId)).toBe("accepted");
		const decisionId = accept.ok ? accept.body.receipt.decision_id : "";
		expect(e3.store.getAcceptanceValidity(decisionId)?.status).toBe("valid");

		// append-only history: every pre-existing row is unchanged
		const h1 = history(e3);
		for (const k of ["proposals", "decisions", "bundles", "validity"] as const)
			expect(h1[k].slice(0, h0[k].length)).toEqual(h0[k]);
		expect(h1.approvedRequest).toEqual(h0.approvedRequest);
	});
});
