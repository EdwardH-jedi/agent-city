// biome-ignore-all lint/suspicious/noExplicitAny: adversarial tests inspect raw, untyped HTTP bodies and SQLite rows on purpose
// ADV-REPAIR, ADV-CANCEL, ADV-RESTART — repair 0/1 boundary and forbidden classes, cancellation vs
// finalization and stale workers, restart reconciliation. Composed hub (counted adapters, engine
// hooks, fake process ops) on disposable fixtures; every child process started here is killed.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_ROUTES } from "@agent-city/schema/workspace-m1";
import type { AdapterSet } from "../../src/managed/adapters/types.ts";
import { Orchestrator } from "../../src/managed/orchestrator.ts";
import {
	childEnv,
	hostProcessOps,
	resolveRecorded,
} from "../../src/managed/proc.ts";
import { createAdapters } from "../../src/managed/worker.ts";
import { simulatedOnly } from "../../src/workspace-hub.ts";
import {
	approveGate1,
	artifactRows,
	assertIsolation,
	composedHub,
	count,
	decide,
	decisionBody,
	dump,
	issueChallenge,
	key,
	linkage,
	liveServers,
	openGate1,
	realHub,
	requestRow,
	rows,
	taskView,
	teardown,
	toGate2,
	waitFor,
	waitStage,
	draft as wsDraft,
} from "./harness.ts";

assertIsolation();
const strays: number[] = [];
afterEach(async () => {
	await teardown();
	for (const pid of strays.splice(0))
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// gone
		}
});
afterAll(() => expect(liveServers).toBe(0));

const ENDED = ["execution_ended", "awaiting_acceptance", "cancelled"];
const engine = (H: { db: any }, id: string) =>
	H.db
		.query(
			"SELECT state, failure_kind, result_run_id FROM managed_tasks WHERE id = ?",
		)
		.get(id) as any;
const attempts = (H: { db: any }, id: string) =>
	rows(
		H.db,
		"SELECT attempt_no, kind FROM managed_runs WHERE task_id = ? ORDER BY attempt_no",
		id,
	);

/** Implementer whose attempt `n` hangs in a real owned child until it is stopped. */
function hangOnAttempt(base: AdapterSet, n: number): AdapterSet {
	return {
		reviewer: (m) => base.reviewer(m),
		implementer(mode) {
			const a = base.implementer(mode);
			if (!a) return null;
			return {
				...a,
				async implement(input, ctx) {
					if (input.run.attempt_no !== n) return a.implement(input, ctx);
					const r = await ctx.run({
						argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
						cwd: input.worktree,
						env: childEnv(),
						timeoutMs: 3_600_000,
					});
					return {
						session_ref: null,
						model_resolved: null,
						usage: null,
						log: "hung",
						logTruncated: false,
						ok: false as const,
						kind: r.aborted
							? ("cancelled" as const)
							: ("provider_error" as const),
						detail: "stopped",
					};
				},
			};
		},
	};
}

describe("ADV-REPAIR repair 0/1 boundary and forbidden classes", () => {
	test("ADV-REPAIR-01/02 default (no repair) never repairs", async () => {
		for (const scenario of [
			"verification_fails",
			"reject_then_approve",
		] as const) {
			const H = composedHub();
			const c = await H.signIn();
			const a = await approveGate1(c, H.fx, { simulation_scenario: scenario });
			await waitStage(c, a.taskId, ENDED);
			expect([
				scenario,
				attempts(H, a.managedTaskId).length,
				H.calls.implement,
			]).toEqual([scenario, 1, 1]);
			expect([scenario, engine(H, a.managedTaskId).failure_kind]).toEqual([
				scenario,
				scenario === "verification_fails"
					? "verification_failed"
					: "review_rejected",
			]);
			await H.stop();
		}
	});

	test("ADV-REPAIR-03 preapproved 1 + verification_fails_then_fixed → exactly 2 attempts, Gate 2 binds attempt 2", async () => {
		const H = composedHub();
		const c = await H.signIn();
		const g = await toGate2(c, H.fx, {
			simulation_scenario: "verification_fails_then_fixed",
			repair_policy: { max_repairs: 1 },
		});
		expect(attempts(H, g.managedTaskId)).toEqual([
			{ attempt_no: 1, kind: "initial" },
			{ attempt_no: 2, kind: "repair" },
		]);
		const env = JSON.parse(requestRow(H.db, g.g2.id).result_envelope);
		expect(env.attempt_no).toBe(2);
		// attempt 1 evidence is retained and readable history
		const runs = rows(
			H.db,
			"SELECT id FROM managed_runs WHERE task_id = ? ORDER BY attempt_no",
			g.managedTaskId,
		);
		expect(
			artifactRows(H.db, g.managedTaskId).some((x) => x.run_id === runs[0].id),
		).toBe(true);
	});

	test("ADV-REPAIR-04 preapproved 1 + reject_always → one repair then repair_limit_exhausted, never a third attempt", async () => {
		const H = composedHub();
		const c = await H.signIn();
		const a = await approveGate1(c, H.fx, {
			simulation_scenario: "reject_always",
			repair_policy: { max_repairs: 1 },
		});
		const v = await waitStage(c, a.taskId, ENDED);
		expect(v.task.stage).toBe("execution_ended");
		expect(attempts(H, a.managedTaskId).length).toBe(2);
		expect(engine(H, a.managedTaskId).failure_kind).toBe(
			"repair_limit_exhausted",
		);
		expect(
			count(
				H.db,
				"SELECT count(*) AS n FROM managed_proposals WHERE workspace_task_id = ?",
				a.taskId,
			),
		).toBe(1);
	});

	test("ADV-REPAIR-05 repair allowance outside {0,1} is rejected at the draft", async () => {
		const H = composedHub({ manual: true });
		const c = await H.signIn();
		for (const max_repairs of [2, 3, -1, 1.5, "1", null, true])
			expect([
				max_repairs,
				(
					await c.post("/tasks", {
						idempotency_key: key(),
						repo_id: H.fx.repoId,
						draft: { ...wsDraft(), repair_policy: { max_repairs } },
					})
				).status,
			]).toEqual([max_repairs, 400]);
		expect(
			(
				await c.post("/tasks", {
					idempotency_key: key(),
					repo_id: H.fx.repoId,
					draft: { ...wsDraft(), repair_policy: {} },
				})
			).status,
		).toBe(400);
	});

	test("ADV-REPAIR-06 forbidden classes never repair even with one repair preapproved", async () => {
		const results: Record<string, unknown> = {};
		for (const scenario of [
			"out_of_scope",
			"malformed_review",
			"review_wrong_candidate",
			"reviewer_mutates",
			"reviewer_error",
			"no_changes",
		] as const) {
			const H = composedHub();
			const c = await H.signIn();
			// out_of_scope writes at the repo root: only out of scope when the approved scope is narrower
			const scope =
				scenario === "out_of_scope"
					? { scope: { allowed: ["src"], protected: [] } }
					: {};
			const a = await approveGate1(c, H.fx, {
				simulation_scenario: scenario,
				repair_policy: { max_repairs: 1 },
				...scope,
			});
			await waitStage(c, a.taskId, ENDED);
			results[scenario] = {
				attempts: attempts(H, a.managedTaskId).length,
				kind: engine(H, a.managedTaskId).failure_kind,
			};
			await H.stop();
		}
		for (const [name, fn] of [
			[
				"evidence_corrupted_before_review",
				(H: any, id: string) => {
					const d = artifactRows(H.db, id).find((x) => x.name === "diff.patch");
					writeFileSync(
						join(H.fx.config.artifacts_root, d.rel_path),
						"tampered\n",
					);
				},
			],
			[
				"authorization_revoked_before_review",
				(H: any, id: string) => {
					H.db
						.query(
							"UPDATE managed_tasks SET objective = objective || '!' WHERE id = ?",
						)
						.run(id);
				},
			],
		] as const) {
			let target = "";
			let Hh: any = null;
			const H = composedHub({
				orchestratorHooks: {
					at(point, taskId) {
						if (point === "before_review" && taskId === target) fn(Hh, taskId);
					},
				},
			});
			Hh = H;
			const c = await H.signIn();
			const g = await openGate1(c, H.fx, {
				simulation_scenario: "reject_then_approve",
				repair_policy: { max_repairs: 1 },
			});
			target = g.req.managed_task_id;
			const ch = await issueChallenge(c, g.req);
			expect(
				(await decide(c, g.req, decisionBody(g.req, ch, "approve"))).status,
			).toBe(201);
			await waitStage(c, g.taskId, ENDED);
			results[name] = {
				attempts: attempts(H, target).length,
				kind: engine(H, target).failure_kind,
			};
			await H.stop();
		}
		for (const [k, v] of Object.entries(results)) {
			expect([k, (v as any).attempts]).toEqual([k, 1]);
			expect([k, (v as any).kind === null]).toEqual([k, false]); // every case actually failed
		}
		console.log(`[adv-repair forbidden classes] ${JSON.stringify(results)}`);
	}, 60_000);

	test("ADV-REPAIR-07 an actionable finding outside the approved scope never starts a repair", async () => {
		const H = composedHub({
			adapters: (base) => ({
				implementer: (m) => base.implementer(m),
				reviewer(m) {
					const r = base.reviewer(m);
					if (!r) return null;
					return {
						...r,
						async review(input) {
							return {
								session_ref: null,
								model_resolved: null,
								usage: null,
								log: "scripted",
								logTruncated: false,
								ok: true as const,
								raw: {
									contract: "agentcity.review/v1",
									audited_sha: input.candidate_sha,
									manifest_hash: input.manifest_hash,
									verdict: "reject",
									tests_executed: false,
									summary: "needs a change elsewhere",
									findings: [
										{
											severity: "major",
											title: "Fix the deploy secrets too",
											detail: "edit outside scope",
											file: "secrets/deploy.yaml",
											line: 1,
											actionable: true,
										},
									],
								},
							};
						},
					};
				},
			}),
		});
		const c = await H.signIn();
		const a = await approveGate1(c, H.fx, {
			scope: { allowed: ["src"], protected: [] },
			repair_policy: { max_repairs: 1 },
		});
		await waitStage(c, a.taskId, ENDED);
		expect(attempts(H, a.managedTaskId).length).toBe(1);
		expect(engine(H, a.managedTaskId).failure_kind).toBe("scope_violation");
	});

	test("ADV-REPAIR-08 a hub stop during the repair attempt → interrupted, never re-run, repair count persists", async () => {
		const A = composedHub({ adapters: (b) => hangOnAttempt(b, 2) });
		const c = await A.signIn();
		const a = await approveGate1(c, A.fx, {
			simulation_scenario: "reject_then_approve",
			repair_policy: { max_repairs: 1 },
		});
		await waitFor(
			() =>
				attempts(A, a.managedTaskId).length === 2 &&
				engine(A, a.managedTaskId).state === "repairing",
		);
		await waitFor(
			() =>
				(
					A.db
						.query(
							"SELECT child_pid FROM managed_runs WHERE task_id = ? AND attempt_no = 2",
						)
						.get(a.managedTaskId) as any
				)?.child_pid,
		);
		await A.stop();
		const B = composedHub({
			reuse: A.fx,
			credentials: { operator: A.credential, readOnly: A.readOnlyCredential },
		});
		await waitFor(
			() =>
				["interrupted", "failed", "blocked"].includes(
					engine(B, a.managedTaskId).state,
				),
			20_000,
		);
		expect(engine(B, a.managedTaskId).state).toBe("interrupted");
		await Bun.sleep(300);
		expect(attempts(B, a.managedTaskId).length).toBe(2);
		expect([B.calls.preflight, B.calls.implement, B.calls.review]).toEqual([
			0, 0, 0,
		]);
	}, 40_000);

	test("ADV-REPAIR-09 no workspace route can create a repair or raise the allowance", () => {
		expect(Object.values(WORKSPACE_ROUTES).sort()).toEqual([
			"/approval-requests/:id/challenge",
			"/approval-requests/:id/decisions",
			"/inbox", // review repair: GET-only read (non-GET refused in review-repair.adv.test.ts)
			"/session",
			"/snapshot",
			"/task-history", // review repair: GET-only read
			"/tasks",
			"/tasks/:id",
			"/tasks/:id/artifacts/:artifact_id",
			"/tasks/:id/cancel",
			"/tasks/:id/draft",
			"/tasks/:id/proposals",
			"/tasks/:id/rerun",
		]);
	});
});

describe("ADV-CANCEL cancellation vs completion", () => {
	test("ADV-CANCEL-01 cancel a queued, unclaimed execution → cancelled, never claimed", async () => {
		const H = composedHub({ manual: true });
		const c = await H.signIn();
		const a = await approveGate1(c, H.fx);
		const v = await taskView(c, a.taskId);
		const r = await c.post(`/tasks/${a.taskId}/cancel`, {
			expected_rev: v.task.rev,
		});
		expect(r.status).toBe(200);
		expect(r.body.task.stage).toBe("cancelled");
		await H.drain();
		expect([linkage(H.db, a.managedTaskId).runs, H.calls.implement]).toEqual([
			0, 0,
		]);
		expect(engine(H, a.managedTaskId).state).toBe("cancelled");
	});

	test("ADV-CANCEL-02/10 cancel while running stays cancel_requested until termination is confirmed; repeated cancel is a no-op", async () => {
		const H = composedHub({ adapters: (b) => hangOnAttempt(b, 1) });
		const c = await H.signIn();
		const a = await approveGate1(c, H.fx);
		await waitFor(
			() =>
				(
					H.db
						.query("SELECT child_pid FROM managed_runs WHERE task_id = ?")
						.get(a.managedTaskId) as any
				)?.child_pid,
		);
		const v = await waitStage(c, a.taskId, ["running"]);
		const r = await c.post(`/tasks/${a.taskId}/cancel`, {
			expected_rev: v.task.rev,
		});
		expect(r.status).toBe(200);
		expect(r.body.task.stage).toBe("cancel_requested");
		const again = await c.post(`/tasks/${a.taskId}/cancel`, {
			expected_rev: r.body.task.rev,
		});
		expect([again.status, again.body.task.rev]).toEqual([200, r.body.task.rev]);
		const at = (
			H.db
				.query("SELECT cancel_requested_at FROM managed_tasks WHERE id = ?")
				.get(a.managedTaskId) as any
		).cancel_requested_at;
		// observe: never `cancelled` while the engine is still active
		const seen: string[] = [];
		const done = await waitFor(async () => {
			const x = await taskView(c, a.taskId);
			seen.push(`${x.task.stage}/${x.engine.state}`);
			return x.task.stage === "cancelled" ? x : null;
		}, 20_000);
		expect(done.engine.state).toBe("cancelled");
		expect(
			seen.filter(
				(s) => s.startsWith("cancelled/") && !s.endsWith("/cancelled"),
			),
		).toEqual([]);
		expect(
			(
				H.db
					.query("SELECT cancel_requested_at FROM managed_tasks WHERE id = ?")
					.get(a.managedTaskId) as any
			).cancel_requested_at,
		).toBe(at);
		expect(
			count(
				H.db,
				"SELECT count(*) AS n FROM managed_approval_requests WHERE kind='result' AND workspace_task_id = ?",
				a.taskId,
			),
		).toBe(0);
	}, 30_000);

	test("ADV-CANCEL-03 cancel recorded while the engine is about to finalize → cancel wins, nothing offered at Gate 2", async () => {
		let release: () => void = () => {};
		let target = "";
		const held = new Promise<void>((r) => {
			release = r;
		});
		let reached = false;
		const H = composedHub({
			orchestratorHooks: {
				async at(point, id) {
					if (point === "before_finalize" && id === target) {
						reached = true;
						await held;
					}
				},
			},
		});
		const c = await H.signIn();
		const g = await openGate1(c, H.fx);
		target = g.req.managed_task_id;
		const ch = await issueChallenge(c, g.req);
		expect(
			(await decide(c, g.req, decisionBody(g.req, ch, "approve"))).status,
		).toBe(201);
		await waitFor(() => reached);
		const v = await taskView(c, g.taskId);
		const r = await c.post(`/tasks/${g.taskId}/cancel`, {
			expected_rev: v.task.rev,
		});
		expect(r.status).toBe(200);
		release();
		const end = await waitStage(c, g.taskId, [
			"cancelled",
			"awaiting_acceptance",
			"execution_ended",
		]);
		expect(end.task.stage).toBe("cancelled");
		expect(engine(H, target).state).toBe("cancelled");
		expect(
			count(
				H.db,
				"SELECT count(*) AS n FROM managed_approval_requests WHERE kind='result' AND status='pending'",
			),
		).toBe(0);
	});

	test("ADV-CANCEL-04 cancel at awaiting_acceptance → 409 invalid_state; the pending Gate 2 is unaffected", async () => {
		const H = composedHub();
		const c = await H.signIn();
		const g = await toGate2(c, H.fx);
		const v = await taskView(c, g.taskId);
		const r = await c.post(`/tasks/${g.taskId}/cancel`, {
			expected_rev: v.task.rev,
		});
		expect([r.status, r.body.error]).toEqual([409, "invalid_state"]);
		const req = (await taskView(c, g.taskId)).approval_requests.find(
			(x: any) => x.id === g.g2.id,
		);
		expect(req.status).toBe("pending");
		const ch = await issueChallenge(c, req);
		expect((await decide(c, req, decisionBody(req, ch, "accept"))).status).toBe(
			201,
		);
	});

	test("ADV-CANCEL-05 a stale worker (lease lost, then seized) writes nothing when it resumes", async () => {
		let release: () => void = () => {};
		const held = new Promise<void>((r) => {
			release = r;
		});
		let target = "";
		let reached = false;
		const H = composedHub({
			manual: true,
			heartbeatMs: 1_000_000_000, // no lease renewal: the worker is "lost"
			orchestratorHooks: {
				async at(point, id) {
					if (point === "before_finalize" && id === target) {
						reached = true;
						await held;
					}
				},
			},
		});
		const c = await H.signIn();
		const g = await openGate1(c, H.fx);
		target = g.req.managed_task_id;
		const ch = await issueChallenge(c, g.req);
		expect(
			(await decide(c, g.req, decisionBody(g.req, ch, "approve"))).status,
		).toBe(201);
		const aTick = H.orch.tick(); // worker A claims and drives until before_finalize
		await waitFor(() => reached, 20_000);
		const fenceA = linkage(H.db, target).fence_token;
		await Bun.sleep(H.fx.config.limits.lease_ttl_ms + 300);
		const config = simulatedOnly(H.fx.config);
		const B = new Orchestrator({
			db: H.db,
			config,
			adapters: createAdapters(config),
			authorize: H.bridge.authorize,
			onChange: H.bridge.notify,
			workerId: "worker-B",
		});
		await B.tick(); // reconcile: fence first, then decide the stale task
		const afterB = {
			engine: engine(H, target),
			fence: linkage(H.db, target).fence_token,
			dump: dump(H.db),
		};
		expect(afterB.fence).toBeGreaterThan(fenceA);
		release();
		await aTick;
		await H.bridge.idle();
		expect(engine(H, target).state).not.toBe("human_ready");
		expect(
			count(
				H.db,
				"SELECT count(*) AS n FROM managed_approval_requests WHERE kind='result'",
			),
		).toBe(0);
		expect(linkage(H.db, target).fence_token).toBe(afterB.fence);
		await B.shutdown();
	}, 30_000);

	test("ADV-CANCEL-06 termination that cannot be confirmed → quarantine; stays cancel_requested; rerun refused", async () => {
		const H = composedHub({
			adapters: (b) => hangOnAttempt(b, 1),
			processOps: {
				inspect: () => ({
					state: "error",
					error: "adversarial: cannot inspect",
				}),
				groupAlive: () => "error",
				// really terminate (no stray), but report it as unconfirmed
				terminateGroup: async (pid, ms) => {
					await hostProcessOps.terminateGroup(pid, ms);
					return false;
				},
			},
		});
		const c = await H.signIn();
		const a = await approveGate1(c, H.fx);
		const pid = await waitFor(
			() =>
				(
					H.db
						.query("SELECT child_pid FROM managed_runs WHERE task_id = ?")
						.get(a.managedTaskId) as any
				)?.child_pid,
		);
		strays.push(pid);
		const v = await waitStage(c, a.taskId, ["running"]);
		expect(
			(await c.post(`/tasks/${a.taskId}/cancel`, { expected_rev: v.task.rev }))
				.status,
		).toBe(200);
		await waitFor(
			() =>
				count(
					H.db,
					"SELECT count(*) AS n FROM managed_quarantine WHERE task_id = ? AND released_at IS NULL",
					a.managedTaskId,
				) > 0,
			20_000,
		);
		await Bun.sleep(500);
		const x = await taskView(c, a.taskId);
		expect(x.task.stage).toBe("cancel_requested");
		expect(x.engine.quarantined).toBe(true);
		const re = await c.post(`/tasks/${a.taskId}/rerun`, {
			expected_rev: x.task.rev,
			proposal_id: x.task.current_proposal_id,
		});
		expect(re.status).toBe(409);
	}, 40_000);

	test("ADV-CANCEL-07 cancel during a pending Gate 1 withdraws it; a later approve with a valid challenge → 409", async () => {
		const H = composedHub({ manual: true });
		const c = await H.signIn();
		const g = await openGate1(c, H.fx);
		const ch = await issueChallenge(c, g.req);
		const v = await taskView(c, g.taskId);
		expect(
			(await c.post(`/tasks/${g.taskId}/cancel`, { expected_rev: v.task.rev }))
				.status,
		).toBe(200);
		const r = await decide(c, g.req, decisionBody(g.req, ch, "approve"));
		expect(r.status).toBe(409);
		expect(requestRow(H.db, g.req.id).invalidation_reason).toBe("withdrawn");
		expect(linkage(H.db, g.req.managed_task_id)).toMatchObject({
			state: "cancelled",
			decisions: 0,
			runs: 0,
		});
	});

	test("ADV-CANCEL-08 cancel without session / with foreign Origin / without CSRF / read-only → refused, no effect", async () => {
		const H = composedHub({ manual: true });
		const c = await H.signIn();
		const a = await approveGate1(c, H.fx);
		const v = await taskView(c, a.taskId);
		const body = { expected_rev: v.task.rev };
		const before = dump(H.db);
		const viewer = await H.signIn("viewer");
		expect(
			(await c.post(`/tasks/${a.taskId}/cancel`, body, { cookie: null }))
				.status,
		).toBe(401);
		expect(
			(
				await c.post(`/tasks/${a.taskId}/cancel`, body, {
					origin: "http://127.0.0.1:6123",
				})
			).status,
		).toBe(403);
		expect(
			(await c.post(`/tasks/${a.taskId}/cancel`, body, { csrf: null })).status,
		).toBe(403);
		expect((await viewer.post(`/tasks/${a.taskId}/cancel`, body)).status).toBe(
			403,
		);
		expect(dump(H.db)).toBe(before);
	});

	test("ADV-CANCEL-09 a recorded pid whose start time differs is never signalled", async () => {
		const signalled: number[] = [];
		const res = await resolveRecorded(
			{ pid: 424242, started: "Mon Jan  1 00:00:00 2001" },
			100,
			{
				inspect: () => ({
					state: "present",
					started: "Tue Oct  1 00:00:00 2026",
				}),
				groupAlive: () => true,
				terminateGroup: async (pid) => {
					signalled.push(pid);
					return true;
				},
			},
		);
		expect(res.resolved).toBe(true);
		expect(signalled).toEqual([]);
	});
});

describe("ADV-RESTART reconciliation", () => {
	test("ADV-RESTART-01 stop after the implement launch intent → interrupted on restart, never re-run; decisions byte-identical", async () => {
		const A = composedHub({ adapters: (b) => hangOnAttempt(b, 1) });
		const c = await A.signIn();
		const a = await approveGate1(c, A.fx);
		await waitFor(
			() =>
				(
					A.db
						.query("SELECT child_pid FROM managed_runs WHERE task_id = ?")
						.get(a.managedTaskId) as any
				)?.child_pid,
		);
		const decisions = JSON.stringify(
			A.db.query("SELECT * FROM managed_decisions ORDER BY id").all(),
		);
		await A.stop();
		const B = composedHub({
			reuse: A.fx,
			credentials: { operator: A.credential, readOnly: A.readOnlyCredential },
		});
		await waitFor(
			() => engine(B, a.managedTaskId).state === "interrupted",
			20_000,
		);
		const c2 = await B.signIn();
		const v = await waitStage(c2, a.taskId, ["execution_ended"]);
		expect(v.task.stage).toBe("execution_ended");
		await Bun.sleep(300);
		expect(attempts(B, a.managedTaskId).length).toBe(1);
		expect([B.calls.preflight, B.calls.implement]).toEqual([0, 0]);
		expect(
			JSON.stringify(
				B.db.query("SELECT * FROM managed_decisions ORDER BY id").all(),
			),
		).toBe(decisions);
		// a human rerun is a NEW managed task behind a NEW Gate 1
		const re = await c2.post(`/tasks/${a.taskId}/rerun`, {
			expected_rev: v.task.rev,
			proposal_id: v.task.current_proposal_id,
		});
		expect(re.status).toBe(201);
		const v2 = await taskView(c2, a.taskId);
		const r2 = v2.approval_requests.find(
			(x: any) => x.kind === "run" && x.status === "pending",
		);
		expect(r2.managed_task_id).not.toBe(a.managedTaskId);
		expect(engine(B, r2.managed_task_id).state).toBe("draft");
	}, 40_000);

	test("ADV-RESTART-03 stop while queued (no launch intent) → after restart it runs exactly once", async () => {
		const A = composedHub({ manual: true });
		const c = await A.signIn();
		const a = await approveGate1(c, A.fx);
		await A.stop();
		const B = composedHub({
			reuse: A.fx,
			credentials: { operator: A.credential, readOnly: A.readOnlyCredential },
		});
		const c2 = await B.signIn();
		await waitStage(c2, a.taskId, ["awaiting_acceptance"]);
		expect(attempts(B, a.managedTaskId).length).toBe(1);
		expect(B.calls.implement).toBe(1);
	});

	test("ADV-RESTART-05/08 Gate 2 pending across restarts: fresh challenge required; acceptance and the single result request survive", async () => {
		const A = composedHub();
		const c = await A.signIn();
		const g = await toGate2(c, A.fx);
		const v = await taskView(c, g.taskId);
		const req = v.approval_requests.find((x: any) => x.id === g.g2.id);
		const oldCh = await issueChallenge(c, req);
		await A.stop();
		const B = realHub({
			reuse: A.fx,
			credentials: { operator: A.credential, readOnly: A.readOnlyCredential },
		});
		const c2 = await B.signIn();
		const r1 = await decide(c2, req, decisionBody(req, oldCh, "accept"));
		expect(r1.status).toBe(409);
		const req2 = (await taskView(c2, g.taskId)).approval_requests.find(
			(x: any) => x.id === g.g2.id,
		);
		const ch2 = await issueChallenge(c2, req2);
		expect(
			(await decide(c2, req2, decisionBody(req2, ch2, "accept"))).status,
		).toBe(201);
		await B.stop();
		const D1 = realHub({
			reuse: A.fx,
			credentials: { operator: A.credential, readOnly: A.readOnlyCredential },
		});
		await Bun.sleep(300);
		const d1 = dump(D1.db);
		await D1.stop();
		const D2 = realHub({
			reuse: A.fx,
			credentials: { operator: A.credential, readOnly: A.readOnlyCredential },
		});
		await Bun.sleep(300);
		expect(dump(D2.db)).toBe(d1);
		const c3 = await D2.signIn();
		const fin = await taskView(c3, g.taskId);
		expect(fin.task.stage).toBe("accepted");
		expect(fin.engine.state).toBe("human_ready");
		expect(
			count(
				D2.db,
				"SELECT count(*) AS n FROM managed_approval_requests WHERE kind='result'",
			),
		).toBe(1);
	}, 40_000);

	test("ADV-RESTART-06 a pending cancel across a restart resolves to cancelled only with the engine's confirmation", async () => {
		const A = composedHub({
			adapters: (b) => hangOnAttempt(b, 1),
			heartbeatMs: 1_000_000_000,
		});
		const c = await A.signIn();
		const a = await approveGate1(c, A.fx);
		await waitFor(
			() =>
				(
					A.db
						.query("SELECT child_pid FROM managed_runs WHERE task_id = ?")
						.get(a.managedTaskId) as any
				)?.child_pid,
		);
		const v = await waitStage(c, a.taskId, ["running"]);
		const r = await c.post(`/tasks/${a.taskId}/cancel`, {
			expected_rev: v.task.rev,
		});
		expect(r.body.task.stage).toBe("cancel_requested");
		await A.stop();
		const B = composedHub({
			reuse: A.fx,
			credentials: { operator: A.credential, readOnly: A.readOnlyCredential },
		});
		const c2 = await B.signIn();
		const end = await waitStage(
			c2,
			a.taskId,
			["cancelled", "execution_ended", "awaiting_acceptance"],
			20_000,
		);
		expect(end.task.stage).toBe("cancelled");
		expect(end.engine.state).toBe("cancelled");
		expect(B.calls.implement).toBe(0);
	}, 40_000);
});
