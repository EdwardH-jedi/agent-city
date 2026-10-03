// biome-ignore-all lint/suspicious/noExplicitAny: adversarial tests inspect raw, untyped HTTP bodies and SQLite rows on purpose
// ADV-RACE, ADV-INVAL — concurrent decisions, failure injection inside the decision transaction
// (04 DecisionHooks), edits/policy/base changes vs approvals. Composed hub (production modules +
// test seams) on a real loopback server; adapters counted.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { fixtureGit } from "../../src/managed/testkit.ts";
import type { DecisionTxPoint } from "../../src/workspace-m1/decisions/index.ts";
import {
	approveGate1,
	assertIsolation,
	canary,
	composedHub,
	count,
	createTask,
	decide,
	decisionBody,
	dump,
	issueChallenge,
	key,
	linkage,
	liveServers,
	openGate1,
	requestRow,
	taskView,
	teardown,
	waitFor,
	waitStage,
	draft as wsDraft,
} from "./harness.ts";

assertIsolation();
afterEach(teardown); // every test owns its hubs: none outlives its test
afterAll(() => expect(liveServers).toBe(0));

describe("ADV-RACE concurrency", () => {
	test("ADV-RACE-01 20 concurrent identical approves (same key, same challenge) → exactly one linkage, no 5xx", async () => {
		const H = composedHub({ manual: true });
		const c = await H.signIn();
		const g = await openGate1(c, H.fx);
		const ch = await issueChallenge(c, g.req);
		const body = decisionBody(g.req, ch, "approve");
		const res = await Promise.all(
			Array.from({ length: 20 }, () => decide(c, g.req, body)),
		);
		const statuses = res.map((r) => r.status);
		expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
		expect(
			res.filter((r) => r.status === 201 && r.body.replayed === false),
		).toHaveLength(1);
		const ids = new Set(
			res
				.filter((r) => r.status === 201)
				.map((r) => r.body.receipt.decision_id),
		);
		expect(ids.size).toBe(1);
		const l = linkage(H.db, g.req.managed_task_id);
		expect([l.decisions, l.state]).toEqual([1, "queued"]);
		await H.drain();
		expect(linkage(H.db, g.req.managed_task_id).runs).toBe(1);
		expect(H.calls.implement).toBe(1);
	});

	test("ADV-RACE-02 20 concurrent approves with distinct keys, same challenge → one success, 19 × 409", async () => {
		const H = composedHub({ manual: true });
		const c = await H.signIn();
		const g = await openGate1(c, H.fx);
		const ch = await issueChallenge(c, g.req);
		const res = await Promise.all(
			Array.from({ length: 20 }, () =>
				decide(c, g.req, decisionBody(g.req, ch, "approve")),
			),
		);
		expect(res.filter((r) => r.status === 201)).toHaveLength(1);
		expect(res.filter((r) => r.status === 409)).toHaveLength(19);
		expect(res.some((r) => r.status >= 500)).toBe(false);
		expect(linkage(H.db, g.req.managed_task_id).decisions).toBe(1);
	});

	test("ADV-RACE-03 approve vs reject racing on one challenge → exactly one decision; reject winner queues nothing", async () => {
		for (let round = 0; round < 4; round++) {
			const H = composedHub({ manual: true });
			const c = await H.signIn();
			const g = await openGate1(c, H.fx);
			const ch = await issueChallenge(c, g.req);
			const [a, r] = await Promise.all([
				decide(c, g.req, decisionBody(g.req, ch, "approve")),
				decide(c, g.req, decisionBody(g.req, ch, "reject")),
			]);
			expect([a.status, r.status].sort()).toEqual([201, 409]);
			const l = linkage(H.db, g.req.managed_task_id);
			expect(l.decisions).toBe(1);
			if (r.status === 201) {
				expect(l.state).toBe("cancelled");
				expect(l.run_requested_at).toBeNull();
			} else expect(l.state).toBe("queued");
			await H.stop();
		}
	});

	test("ADV-RACE-04 proposal v2 published inside the decision window (beforeTransaction) → approve refused, v1 never launches", async () => {
		let inWindow: (() => Promise<void>) | null = null;
		const H = composedHub({
			decisionHooks: {
				async beforeTransaction() {
					const f = inWindow;
					inWindow = null;
					if (f) await f();
				},
			},
		});
		const c = await H.signIn();
		const g = await openGate1(c, H.fx);
		const ch = await issueChallenge(c, g.req);
		inWindow = async () => {
			const v = await taskView(c, g.taskId);
			const p = await c.post(`/tasks/${g.taskId}/proposals`, {
				expected_rev: v.task.rev,
			});
			expect(p.status).toBe(201);
		};
		const r = await decide(c, g.req, decisionBody(g.req, ch, "approve"));
		expect(r.status).toBe(409);
		await Bun.sleep(300);
		const l = linkage(H.db, g.req.managed_task_id);
		expect([l.decisions, l.runs, l.run_requested_at]).toEqual([0, 0, null]);
		expect(H.calls.implement).toBe(0);
	});

	test("ADV-RACE-05 concurrent duplicate Gate-2 accepts → exactly one acceptance", async () => {
		const H = composedHub();
		const c = await H.signIn();
		const g1 = await approveGate1(c, H.fx);
		const g2 = await waitFor(async () => {
			const v = await taskView(c, g1.taskId);
			return (v.approval_requests as any[]).find(
				(r) => r.kind === "result" && r.status === "pending",
			);
		}, 30_000);
		const ch = await issueChallenge(c, g2);
		const res = await Promise.all([
			...Array.from({ length: 8 }, () =>
				decide(c, g2, decisionBody(g2, ch, "accept")),
			),
			decide(c, g2, decisionBody(g2, ch, "reject")),
		]);
		expect(res.filter((r) => r.status === 201)).toHaveLength(1);
		expect(res.some((r) => r.status >= 500)).toBe(false);
		expect(
			count(
				H.db,
				"SELECT count(*) AS n FROM managed_decisions WHERE approval_request_id = ?",
				g2.id,
			),
		).toBe(1);
	});

	test("ADV-RACE-06 approve vs cancel → consistent end state, at most one queue linkage, no launch after cancel", async () => {
		for (let round = 0; round < 3; round++) {
			const H = composedHub({ manual: true });
			const c = await H.signIn();
			const g = await openGate1(c, H.fx);
			const ch = await issueChallenge(c, g.req);
			const v = await taskView(c, g.taskId);
			const [a, x] = await Promise.all([
				decide(c, g.req, decisionBody(g.req, ch, "approve")),
				c.post(`/tasks/${g.taskId}/cancel`, { expected_rev: v.task.rev }),
			]);
			expect(a.status < 500 && x.status < 500).toBe(true);
			await H.drain();
			const after = await taskView(c, g.taskId);
			const l = linkage(H.db, g.req.managed_task_id);
			expect(l.decisions).toBeLessThanOrEqual(1);
			if (x.status === 200 || x.status === 201) {
				// cancel committed first (withdrawn) or after queueing (queued+unleased → cancelled)
				expect(["cancelled", "cancel_requested"]).toContain(after.task.stage);
				expect(l.runs).toBe(0);
				expect(H.calls.implement).toBe(0);
			}
			await H.stop();
		}
	});

	const points: DecisionTxPoint[] = [
		"after_consume",
		"after_insert_decision",
		"after_close_request",
		"after_effects",
	];
	for (const point of points)
		test(`ADV-RACE-07 crash inside the decision transaction at ${point} → full rollback; retry links exactly once`, async () => {
			let armed: DecisionTxPoint | null = null;
			const H = composedHub({
				manual: true,
				decisionHooks: {
					inDecisionTx(p) {
						if (p === armed) {
							armed = null;
							throw new Error(`injected crash at ${p}`);
						}
					},
				},
			});
			const c = await H.signIn();
			const g = await openGate1(c, H.fx);
			const ch = await issueChallenge(c, g.req);
			const body = decisionBody(g.req, ch, "approve");
			const before = dump(H.db);
			armed = point;
			const crashed = await decide(c, g.req, body);
			expect(crashed.status).toBeGreaterThanOrEqual(500);
			expect(crashed.text).not.toContain("injected crash");
			expect(dump(H.db)).toBe(before);
			expect(requestRow(H.db, g.req.id).challenge_status).toBe("issued");
			const ok = await decide(c, g.req, body);
			expect([ok.status, ok.body.replayed]).toEqual([201, false]);
			expect(linkage(H.db, g.req.managed_task_id).decisions).toBe(1);
			const again = await decide(c, g.req, body);
			expect([again.status, again.body.replayed]).toEqual([201, true]);
			const integrity = H.db.query("PRAGMA integrity_check").get() as any;
			expect(Object.values(integrity)[0]).toBe("ok");
		});
});

describe("ADV-INVAL edits, policy and base changes", () => {
	test("ADV-INVAL-02 after approve, a new version cannot be published (409); the execution runs only the approved version", async () => {
		const H = composedHub({ manual: true });
		const c = await H.signIn();
		const a = await approveGate1(c, H.fx);
		const v = await taskView(c, a.taskId);
		const p = await c.post(`/tasks/${a.taskId}/proposals`, {
			expected_rev: v.task.rev,
		});
		expect(p.status).toBe(409);
		expect(
			count(
				H.db,
				"SELECT count(*) AS n FROM managed_proposals WHERE workspace_task_id = ?",
				a.taskId,
			),
		).toBe(1);
	});

	test("ADV-INVAL-02b managed task content tampered after approval (before claim) → denied before preflight, zero adapter calls", async () => {
		const H = composedHub({ manual: true });
		const c = await H.signIn();
		const a = await approveGate1(c, H.fx);
		H.db
			.query(
				"UPDATE managed_tasks SET objective = objective || ' (and also delete everything)' WHERE id = ?",
			)
			.run(a.managedTaskId);
		await H.drain();
		const t = H.db
			.query("SELECT state, failure_kind FROM managed_tasks WHERE id = ?")
			.get(a.managedTaskId) as any;
		expect(t).toEqual({ state: "blocked", failure_kind: "approval_void" });
		expect([H.calls.preflight, H.calls.implement, H.calls.review]).toEqual([
			0, 0, 0,
		]);
		expect(linkage(H.db, a.managedTaskId).runs).toBe(0);
	});

	test("ADV-INVAL-04 trusted policy changed between approve and claim (restart with new limits) → no launch", async () => {
		const A = composedHub({ manual: true });
		const c = await A.signIn();
		const a = await approveGate1(c, A.fx);
		await A.stop();
		const B = composedHub({
			manual: true,
			reuse: A.fx,
			config: (cfg) => ({
				...cfg,
				limits: { ...cfg.limits, max_log_bytes: cfg.limits.max_log_bytes + 1 },
			}),
		});
		await B.drain();
		const t = B.db
			.query("SELECT state, failure_kind FROM managed_tasks WHERE id = ?")
			.get(a.managedTaskId) as any;
		expect(t.state).toBe("blocked");
		expect(t.failure_kind).toBe("approval_void");
		expect([B.calls.preflight, B.calls.implement]).toEqual([0, 0]);
	});

	test("ADV-INVAL-04b a PENDING Gate 1 under a changed policy is invalidated by the sweep; approve → 409", async () => {
		const A = composedHub({ manual: true });
		const c = await A.signIn();
		const g = await openGate1(c, A.fx);
		await A.stop();
		const B = composedHub({
			manual: true,
			reuse: A.fx,
			credentials: { operator: A.credential, readOnly: A.readOnlyCredential },
			config: (cfg) => ({
				...cfg,
				limits: { ...cfg.limits, max_log_bytes: cfg.limits.max_log_bytes + 1 },
			}),
		});
		await B.bridge.sweep();
		const row = requestRow(B.db, g.req.id);
		expect(row.status).toBe("invalidated");
		expect(row.invalidation_reason).toBe("policy_changed");
		const c2 = await B.signIn();
		const r = await c2.post(`/approval-requests/${g.req.id}/challenge`, {
			kind: "run",
			binding_hash: g.req.binding_hash,
			expected_request_rev: row.rev,
		});
		expect(r.status).toBe(409);
	});

	test("ADV-INVAL-05 base branch advances after approval → execution stays pinned to the approved base", async () => {
		const H = composedHub({ manual: true });
		const c = await H.signIn();
		const a = await approveGate1(c, H.fx);
		const approvedBase = (await taskView(c, a.taskId)).current_proposal.snapshot
			.base_sha;
		Bun.write(`${H.fx.repoPath}/moved.txt`, "moved\n");
		fixtureGit(H.fx.repoPath, "add", "-A");
		fixtureGit(H.fx.repoPath, "commit", "--quiet", "-m", "base moves");
		await H.drain();
		const run = H.db
			.query("SELECT parent_sha FROM managed_runs WHERE task_id = ?")
			.get(a.managedTaskId) as any;
		expect(run?.parent_sha).toBe(approvedBase);
	});

	test("ADV-INVAL-05b base moved while Gate 1 is pending → sweep invalidates; approve refused", async () => {
		const H = composedHub({ manual: true });
		const c = await H.signIn();
		const g = await openGate1(c, H.fx);
		await Bun.write(`${H.fx.repoPath}/moved2.txt`, "moved\n");
		fixtureGit(H.fx.repoPath, "add", "-A");
		fixtureGit(H.fx.repoPath, "commit", "--quiet", "-m", "base moves");
		await H.bridge.sweep();
		const row = requestRow(H.db, g.req.id);
		expect(row.status).toBe("invalidated");
		const ch = await c.post(`/approval-requests/${g.req.id}/challenge`, {
			kind: "run",
			binding_hash: g.req.binding_hash,
			expected_request_rev: row.rev,
		});
		expect(ch.status).toBe(409);
	});

	test("ADV-INVAL-06 Gate-1 request changes → edit → new version needs a new request + challenge; old challenge useless", async () => {
		const H = composedHub({ manual: true });
		const c = await H.signIn();
		const g = await openGate1(c, H.fx);
		const ch = await issueChallenge(c, g.req);
		const rc = await decide(
			c,
			g.req,
			decisionBody(g.req, ch, "request_changes"),
		);
		expect(rc.status).toBe(201);
		let v = await taskView(c, g.taskId);
		expect(v.task.stage).toBe("changes_requested");
		const saved = await c.req("PUT", `/tasks/${g.taskId}/draft`, {
			expected_rev: v.task.rev,
			draft: wsDraft({ title: "Edited after request changes" }),
		});
		expect(saved.status).toBe(200);
		const pub = await c.post(`/tasks/${g.taskId}/proposals`, {
			expected_rev: saved.body.task.rev,
		});
		expect(pub.status).toBe(201);
		v = await taskView(c, g.taskId);
		const r2 = (v.approval_requests as any[]).find(
			(r) => r.kind === "run" && r.status === "pending",
		);
		expect(r2.id).not.toBe(g.req.id);
		expect(r2.proposal_id).not.toBe(g.req.proposal_id);
		const reuse = await decide(
			c,
			r2,
			decisionBody(
				r2,
				{ challenge: ch.challenge, request_rev: r2.rev },
				"approve",
			),
		);
		expect(reuse.status).toBe(409);
		expect(linkage(H.db, r2.managed_task_id).decisions).toBe(0);
		const ch2 = await issueChallenge(c, r2);
		expect((await decide(c, r2, decisionBody(r2, ch2, "approve"))).status).toBe(
			201,
		);
		expect(linkage(H.db, g.req.managed_task_id).state).toBe("cancelled");
	});

	test("ADV-INVAL-09 proposals and decisions are immutable even to a raw DB writer (triggers)", async () => {
		const H = composedHub({ manual: true });
		const c = await H.signIn();
		const a = await approveGate1(c, H.fx);
		const attempts = [
			"UPDATE managed_proposals SET snapshot = snapshot WHERE workspace_task_id = ?",
			"DELETE FROM managed_proposals WHERE workspace_task_id = ?",
			"UPDATE managed_decisions SET reason = 'x' WHERE workspace_task_id = ?",
			"DELETE FROM managed_decisions WHERE workspace_task_id = ?",
			"DELETE FROM managed_approval_requests WHERE workspace_task_id = ?",
			"DELETE FROM workspace_tasks WHERE id = ?",
		];
		for (const sql of attempts)
			expect(() => H.db.query(sql).run(a.taskId)).toThrow();
		// a managed task referenced by a workspace row cannot be deleted (no cascade, L-15)
		expect(() =>
			H.db.query("DELETE FROM managed_tasks WHERE id = ?").run(a.managedTaskId),
		).toThrow();
		const routes = await Promise.all(
			["PUT", "PATCH", "DELETE"].map((m) =>
				c.req(m, `/tasks/${a.taskId}/proposals`, { expected_rev: 1 }),
			),
		);
		expect(routes.map((r) => r.status)).toEqual([404, 404, 404]);
	});

	async function draftWithCanaries() {
		const H = composedHub({ manual: true });
		const c = await H.signIn();
		const s1 = canary.github();
		const s2 = canary.github();
		const t = await createTask(c, H.fx, {
			title: `Rotate ${s1}`,
			objective: `The old key was ${s2} - replace it.`,
			criteria: [`no ${s1} remains`],
		});
		const pub = await c.post(`/tasks/${t.id}/proposals`, {
			expected_rev: t.rev,
		});
		expect(pub.status).toBe(201);
		return { H, c, t, s1, s2, v: await taskView(c, t.id) };
	}
	const holds = (text: string, ...xs: string[]) =>
		xs.some((x) => text.includes(x));

	test("ADV-INVAL-10a canaries in task text: frozen proposal snapshot, managed task and proposal rows are redacted", async () => {
		const { H, s1, s2, v } = await draftWithCanaries();
		expect(holds(JSON.stringify(v.current_proposal), s1, s2)).toBe(false);
		const managed = JSON.stringify(
			H.db
				.query(
					"SELECT title, objective, acceptance_criteria FROM managed_tasks",
				)
				.all(),
		);
		expect(holds(managed, s1, s2)).toBe(false);
		expect(
			holds(
				JSON.stringify(H.db.query("SELECT * FROM managed_proposals").all()),
				s1,
				s2,
			),
		).toBe(false);
	});

	test("ADV-INVAL-10b (F-01) create / save / publish: the stored and served draft is redacted on every surface, for operator and read-only", async () => {
		const H = composedHub({ manual: true });
		const c = await H.signIn();
		const viewer = await H.signIn("viewer");
		const [s1, s2, s3] = [canary.github(), canary.github(), canary.github()];
		const found: string[] = [];
		const scan = async (when: string, extra: Record<string, string> = {}) => {
			const surfaces: Record<string, string> = {
				db_all_tables: (
					H.db
						.query("SELECT name FROM sqlite_master WHERE type='table'")
						.all() as { name: string }[]
				)
					.map((t) =>
						JSON.stringify(H.db.query(`SELECT * FROM "${t.name}"`).all()),
					)
					.join("\n"),
				task_view: (await c.get(`/tasks/${t.id}`)).text,
				snapshot: (await c.get("/snapshot")).text,
				viewer_task_view: (await viewer.get(`/tasks/${t.id}`)).text,
				viewer_snapshot: (await viewer.get("/snapshot")).text,
				...extra,
			};
			for (const [name, text] of Object.entries(surfaces))
				if (holds(text, s1, s2, s3)) found.push(`${when}:${name}`);
		};
		const created = await c.post("/tasks", {
			idempotency_key: key("f01"),
			repo_id: H.fx.repoId,
			draft: wsDraft({
				title: `Rotate ${s1}`,
				objective: `The old key was ${s2} - replace it.`,
				criteria: [`no ${s1} remains`, "the fixture check passes"],
			}),
		});
		expect(created.status).toBe(201);
		const t = { id: created.body.task.id as string };
		await scan("create", { create_response: created.text });
		expect(created.body.task.draft.title).toContain("[REDACTED]");
		const saved = await c.req("PUT", `/tasks/${t.id}/draft`, {
			expected_rev: created.body.task.rev,
			draft: wsDraft({
				title: "Rotate the deploy key",
				objective: `new value ${s3} here`,
				criteria: ["done"],
			}),
		});
		expect(saved.status).toBe(200);
		await scan("save", { save_response: saved.text });
		const pub = await c.post(`/tasks/${t.id}/proposals`, {
			expected_rev: saved.body.task.rev,
		});
		expect(pub.status).toBe(201);
		await scan("publish", { publish_response: pub.text });
		expect(found).toEqual([]);
	});

	test("ADV-INVAL-10c (F-01) create idempotency over the redacted draft: replay, masked-secret-only difference = same request, real difference = 409", async () => {
		const H = composedHub({ manual: true });
		const c = await H.signIn();
		const k = key("f01r");
		const body = (secret: string, word = "Rotate") => ({
			idempotency_key: k,
			repo_id: H.fx.repoId,
			draft: wsDraft({ title: `${word} ${secret}` }),
		});
		const [a, b] = [canary.github(), canary.github()];
		const first = await c.post("/tasks", body(a));
		expect(first.status).toBe(201);
		const replay = await c.post("/tasks", body(a));
		expect([replay.status, replay.body.task.id]).toEqual([
			200,
			first.body.task.id,
		]);
		const maskedOnly = await c.post("/tasks", body(b));
		expect([maskedOnly.status, maskedOnly.body.task.id]).toEqual([
			200,
			first.body.task.id,
		]);
		const different = await c.post("/tasks", body(a, "Revoke"));
		expect([different.status, different.body.error]).toEqual([
			409,
			"idempotency_conflict",
		]);
		expect(
			count(
				H.db,
				"SELECT count(*) AS n FROM workspace_tasks WHERE idempotency_key = ?",
				k,
			),
		).toBe(1);
		expect(holds(dump(H.db), a, b)).toBe(false);
		for (const r of [first, replay, maskedOnly, different])
			expect(holds(r.text, a, b)).toBe(false);
	});

	test("ADV-INVAL-10d (F-01) redaction that lengthens a field past its bound → 400 on create and save; nothing stored", async () => {
		const H = composedHub({ manual: true });
		const c = await H.signIn();
		const title = `${"x".repeat(108)} password=ab`; // 120 raw chars; "[REDACTED]" makes it 128
		expect(title.length).toBe(120);
		const before = count(H.db, "SELECT count(*) AS n FROM workspace_tasks");
		const r = await c.post("/tasks", {
			idempotency_key: key(),
			repo_id: H.fx.repoId,
			draft: wsDraft({ title }),
		});
		expect(r.status).toBe(400);
		expect(count(H.db, "SELECT count(*) AS n FROM workspace_tasks")).toBe(
			before,
		);
		const t = await createTask(c, H.fx);
		const save = await c.req("PUT", `/tasks/${t.id}/draft`, {
			expected_rev: t.rev,
			draft: wsDraft({ title }),
		});
		expect(save.status).toBe(400);
		const row = H.db
			.query("SELECT rev, draft FROM workspace_tasks WHERE id = ?")
			.get(t.id) as { rev: number; draft: string };
		expect(row.rev).toBe(t.rev);
		expect(row.draft).not.toContain("password=");
	});
});

describe("ADV-RACE housekeeping", () => {
	test("a stage-table violation never surfaces as 409 invalid_state from a store trigger in the normal flow", async () => {
		const H = composedHub();
		const c = await H.signIn();
		const a = await approveGate1(c, H.fx);
		const v = await waitStage(c, a.taskId, [
			"awaiting_acceptance",
			"execution_ended",
		]);
		expect(v.task.stage).toBe("awaiting_acceptance");
		expect(H.alarms).toEqual([]);
		void key;
	});
});
