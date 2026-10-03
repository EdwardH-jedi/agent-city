// biome-ignore-all lint/suspicious/noExplicitAny: adversarial tests inspect raw, untyped HTTP bodies and SQLite rows on purpose
// ADV-MR — multiple simulated repositories (QA, multi-repository milestone; MULTIREPO_MILESTONE.md).
// Direct HTTP against the real hub (`realHub`, black box) or the same modules composed with test seams
// (`composedHub`), always on disposable fixtures: an allowlisted primary repository A
// (`local/adv-alpha-<nonce>`), a second allowlisted repository B (`local/adv-beta-<nonce>`, its own git
// repository with a distinct base commit) and an observed-only telemetry row (`observed-example/…`).
// What is attacked: wrong repository / task / request / binding / challenge / artifact combinations,
// unknown repository fields, duplicate and dropped decision responses, approval-context changes while a
// signature is in flight (same repository, other repository, other repository's trusted policy), one
// repository's cancellation while the other holds the engine, the global quarantine pause, invalid
// evidence staying with its own repository, the snapshot's queue against the engine's real claim order,
// and restart. Refused requests are checked against settled DB dumps (no durable effect).
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterSet } from "../../src/managed/adapters/types.ts";
import { childEnv, hostProcessOps } from "../../src/managed/proc.ts";
import {
	approveGate1,
	artifactRows,
	assertIsolation,
	Barrier,
	type Client,
	composedHub,
	count,
	createTask,
	decide,
	decisionBody,
	dump,
	gitHas,
	issueChallenge,
	key,
	linkage,
	liveServers,
	multiRepoFixture,
	observeRepo,
	openGate1,
	pendingOf,
	type RealHub,
	realHub,
	repoOf,
	requestRow,
	rows,
	settledDump,
	snapshotOf,
	taskView,
	teardown,
	toGate2,
	waitFor,
	waitGate2,
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

interface Two {
	H: RealHub;
	c: Client;
	/** allowlisted primary */
	A: string;
	/** allowlisted second repository */
	B: string;
	/** observed-only (telemetry row, never allowlisted) */
	O: string;
}

function twoRepos(o: { hooks?: Barrier } = {}): Promise<Two> {
	const H = realHub({
		fixture: multiRepoFixture(["beta"]),
		...(o.hooks ? { hooks: o.hooks } : {}),
	});
	const O = observeRepo(H.db, "watched");
	return H.signIn().then((c) => ({
		H,
		c,
		A: H.fx.repos[0]?.id ?? "",
		B: H.fx.repos[1]?.id ?? "",
		O,
	}));
}

const fakeArtifact = () => `art-${crypto.randomUUID()}`;
const managedRow = (db: any, id: string) =>
	db
		.query(
			"SELECT id, repo_id, state, lease_owner, fence_token, run_requested_at FROM managed_tasks WHERE id = ?",
		)
		.get(id) as any;
const runsOf = (db: any, mt: string) =>
	count(db, "SELECT count(*) AS n FROM managed_runs WHERE task_id = ?", mt);
const decisionsOf = (db: any, requestId: string) =>
	count(
		db,
		"SELECT count(*) AS n FROM managed_decisions WHERE approval_request_id = ?",
		requestId,
	);
const leased = (db: any) =>
	count(
		db,
		"SELECT count(*) AS n FROM managed_tasks WHERE lease_owner IS NOT NULL",
	);
const artPath = (H: { fx: any }, rel: string) =>
	join(H.fx.config.artifacts_root, rel);
function flipByte(path: string) {
	const buf = readFileSync(path);
	buf[0] = (buf[0] ?? 0) ^ 0x01;
	writeFileSync(path, buf);
}

/** Simulated implementer whose attempts in repository `repoId` hang in a real owned child. */
function hangInRepo(base: AdapterSet, repoId: string): AdapterSet {
	return {
		reviewer: (m) => base.reviewer(m),
		implementer(mode) {
			const a = base.implementer(mode);
			if (!a) return null;
			return {
				...a,
				async implement(input, ctx) {
					if (input.task.repo_id !== repoId) return a.implement(input, ctx);
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

describe("ADV-MR repository identity and isolation", () => {
	test("ADV-MR-01 two allowlisted fixtures are distinct; each task's proposal, binding and engine row carry ITS repository; the observed row is display-only", async () => {
		const { H, c, A, B, O } = await twoRepos();
		const [ra, rb] = H.fx.repos as [any, any];
		expect(H.fx.repos).toHaveLength(2);
		expect(ra.id).not.toBe(rb.id);
		expect(ra.path).not.toBe(rb.path);
		expect(ra.baseSha).not.toBe(rb.baseSha);
		const snap = await snapshotOf(c);
		expect(snap.status).toBe(200);
		expect(snap.body.repos.map((r: any) => r.repo_id).sort()).toEqual(
			[A, B].sort(),
		);
		expect(snap.body.observed_repos).toContainEqual({
			repo_id: O,
			source: "github",
		});
		expect(snap.body.repos.map((r: any) => r.repo_id)).not.toContain(O);
		expect(snap.body.execution_queue).toEqual({
			active: null,
			queued: [],
			claims_paused_by_quarantine: false,
		});
		const ga = await openGate1(c, H.fx, { title: "Alpha identity" }, A);
		const gb = await openGate1(c, H.fx, { title: "Beta identity" }, B);
		for (const [g, repo] of [
			[ga, ra],
			[gb, rb],
		] as const) {
			expect(g.view.task.repo_id).toBe(repo.id);
			expect(g.view.current_proposal.snapshot.repo_id).toBe(repo.id);
			expect(g.view.current_proposal.snapshot.base_sha).toBe(repo.baseSha);
			expect(g.req.execution_binding.base_sha).toBe(repo.baseSha);
			expect(managedRow(H.db, g.req.managed_task_id).repo_id).toBe(repo.id);
			expect(managedRow(H.db, g.req.managed_task_id).state).toBe("draft");
		}
		// policy is per repository: the two bindings carry different policy hashes
		expect(ga.req.execution_binding.policy_hash).not.toBe(
			gb.req.execution_binding.policy_hash,
		);
		const after = await snapshotOf(c);
		const repoOfTask = new Map(
			after.body.tasks.map((t: any) => [t.task.id, t.task.repo_id]),
		);
		expect(repoOfTask.get(ga.taskId)).toBe(A);
		expect(repoOfTask.get(gb.taskId)).toBe(B);
		// nothing was queued by publishing in either repository
		expect(after.body.execution_queue.active).toBeNull();
		expect(after.body.execution_queue.queued).toEqual([]);
	});

	test("ADV-MR-02 observed-only and unknown repository ids → 422 repo_not_allowed at creation, nothing reserved", async () => {
		const { H, c, B, O } = await twoRepos();
		const ghost = `local/adv-ghost-${crypto.randomUUID().slice(0, 6)}`;
		const before = await settledDump(H.db);
		for (const repo_id of [O, ghost]) {
			const r = await c.post("/tasks", {
				idempotency_key: key("obs"),
				repo_id,
				draft: wsDraft({ title: "Must not be reserved" }),
			});
			expect([repo_id, r.status, r.body?.error]).toEqual([
				repo_id,
				422,
				"repo_not_allowed",
			]);
		}
		expect(dump(H.db)).toBe(before);
		expect(
			count(
				H.db,
				"SELECT count(*) AS n FROM workspace_tasks WHERE repo_id IN (?, ?)",
				O,
				ghost,
			),
		).toBe(0);
		expect(
			count(
				H.db,
				"SELECT count(*) AS n FROM managed_tasks WHERE repo_id IN (?, ?)",
				O,
				ghost,
			),
		).toBe(0);
		// the observed row stays observed (listed, never in the allowlist)
		const snap = await snapshotOf(c);
		expect(snap.body.observed_repos.map((r: any) => r.repo_id)).toContain(O);
		expect(snap.body.repos.map((r: any) => r.repo_id)).toContain(B);
	}, 30_000);

	test("ADV-MR-03 extra / unknown repository fields in every body → 400, value never echoed, no durable effect; the clean body still works", async () => {
		const { H, c, A, B } = await twoRepos();
		const t = await createTask(c, H.fx, { title: "Alpha draft" }, A);
		const g = await openGate1(c, H.fx, { title: "Alpha pending" }, A);
		const ch = await issueChallenge(c, g.req);
		const pv = g.view;
		const before = await settledDump(H.db);
		const bodies: [string, string, unknown][] = [
			[
				"POST",
				"/tasks",
				{ idempotency_key: key(), repo_id: A, draft: wsDraft(), repo: B },
			],
			[
				"POST",
				"/tasks",
				{
					idempotency_key: key(),
					repo_id: A,
					draft: wsDraft(),
					target_repo_id: B,
				},
			],
			[
				"POST",
				"/tasks",
				{
					idempotency_key: key(),
					repo_id: A,
					draft: { ...wsDraft(), repo_id: B },
				},
			],
			[
				"PUT",
				`/tasks/${t.id}/draft`,
				{ expected_rev: t.rev, draft: wsDraft(), repo_id: B },
			],
			[
				"PUT",
				`/tasks/${t.id}/draft`,
				{ expected_rev: t.rev, draft: { ...wsDraft(), repo_id: B } },
			],
			["POST", `/tasks/${t.id}/proposals`, { expected_rev: t.rev, repo_id: B }],
			[
				"POST",
				`/tasks/${g.taskId}/rerun`,
				{
					expected_rev: pv.task.rev,
					proposal_id: pv.task.current_proposal_id,
					repo_id: B,
				},
			],
			[
				"POST",
				`/tasks/${g.taskId}/cancel`,
				{ expected_rev: pv.task.rev, repo_id: B },
			],
			[
				"POST",
				`/approval-requests/${g.req.id}/challenge`,
				{
					kind: "run",
					binding_hash: g.req.binding_hash,
					expected_request_rev: ch.request_rev,
					repo_id: B,
				},
			],
			[
				"POST",
				`/approval-requests/${g.req.id}/decisions`,
				{ ...decisionBody(g.req, ch, "approve"), repo_id: B },
			],
		];
		for (const [m, p, b] of bodies) {
			const r = await c.req(m, p, b);
			expect([m, p, r.status]).toEqual([m, p, 400]);
			expect(r.text).not.toContain(B);
		}
		expect(dump(H.db)).toBe(before);
		// none of the refused bodies consumed the challenge: the clean decision is accepted
		const ok = await decide(c, g.req, decisionBody(g.req, ch, "approve"));
		expect(ok.status).toBe(201);
		expect(ok.body.receipt.workspace_task_id).toBe(g.taskId);
	}, 30_000);
});

describe("ADV-MR cross-repository references", () => {
	test("ADV-MR-04 A's challenge on B's request, B's binding on A's request, ids of one kind in another's slot → refused; nothing consumed", async () => {
		const { H, c, A, B } = await twoRepos();
		const ga = await openGate1(c, H.fx, { title: "Alpha gate" }, A);
		const gb = await openGate1(c, H.fx, { title: "Beta gate" }, B);
		// a challenge cannot even be issued on A for B's binding
		const wrongIssue = await c.post(
			`/approval-requests/${ga.req.id}/challenge`,
			{
				kind: "run",
				binding_hash: gb.req.binding_hash,
				expected_request_rev: ga.req.rev,
			},
		);
		expect([wrongIssue.status, wrongIssue.body?.error]).toEqual([
			409,
			"stale_binding",
		]);
		const chA = await issueChallenge(c, ga.req);
		const chB = await issueChallenge(c, gb.req);
		const before = await settledDump(H.db);
		const attempts: [string, any, Record<string, unknown>, string][] = [
			// A's challenge token on B's request (B's own binding and rev)
			["A-challenge→B", gb.req, { challenge: chA.challenge }, "B"],
			// B's binding hash on A's request (A's own challenge)
			["B-binding→A", ga.req, { binding_hash: gb.req.binding_hash }, "A"],
			// B's challenge token on A's request
			["B-challenge→A", ga.req, { challenge: chB.challenge }, "A"],
			// B's request rev on A's request
			["B-rev→A", ga.req, { expected_request_rev: chB.request_rev + 7 }, "A"],
		];
		for (const [name, target, over, which] of attempts) {
			const own = which === "A" ? chA : chB;
			const r = await decide(
				c,
				target,
				decisionBody(target, own, "approve", over),
			);
			expect([name, r.status]).toEqual([name, 409]);
			expect(["challenge_invalid", "stale_binding"]).toContain(r.body?.error);
		}
		// ids of the wrong kind in each other's slots: never a match, never data
		for (const [m, p] of [
			["POST", `/approval-requests/${gb.taskId}/challenge`],
			["POST", `/approval-requests/${gb.taskId}/decisions`],
			["GET", `/tasks/${ga.req.id}`],
			["GET", `/tasks/${gb.taskId}/artifacts/${ga.req.id}`],
			["POST", `/tasks/${ga.req.id}/cancel`],
		] as const) {
			const r =
				m === "GET"
					? await c.get(p)
					: await c.post(p, {
							kind: "run",
							binding_hash: ga.req.binding_hash,
							expected_request_rev: 1,
						});
			// GET: 404; a POST may also stop at the strict body parse (400) — never a match or data
			expect([
				m,
				p,
				m === "GET" ? r.status === 404 : [400, 404].includes(r.status),
			]).toEqual([m, p, true]);
			expect(r.text).not.toContain(ga.req.binding_hash);
		}
		expect(dump(H.db)).toBe(before);
		expect([
			decisionsOf(H.db, ga.req.id),
			decisionsOf(H.db, gb.req.id),
		]).toEqual([0, 0]);
		// both challenges are intact: each decides only its own request
		const okA = await decide(c, ga.req, decisionBody(ga.req, chA, "approve"));
		const okB = await decide(c, gb.req, decisionBody(gb.req, chB, "approve"));
		expect([okA.status, okB.status]).toEqual([201, 201]);
		expect(okA.body.receipt.effects.managed_task_id).toBe(
			ga.req.managed_task_id,
		);
		expect(okB.body.receipt.effects.managed_task_id).toBe(
			gb.req.managed_task_id,
		);
		await waitGate2(c, ga.taskId);
		await waitGate2(c, gb.taskId);
	}, 40_000);

	test("ADV-MR-05 rerun naming the other repository's proposal → 409 stale_binding, nothing reserved; its own proposal reruns in its own repository", async () => {
		const { H, c, A, B } = await twoRepos();
		const ga = await openGate1(c, H.fx, { title: "Alpha proposal" }, A);
		const gb = await openGate1(c, H.fx, { title: "Beta withdrawn" }, B);
		const v = await taskView(c, gb.taskId);
		const cancel = await c.post(`/tasks/${gb.taskId}/cancel`, {
			expected_rev: v.task.rev,
		});
		expect([cancel.status, cancel.body.task.stage]).toEqual([200, "cancelled"]);
		const vb = await taskView(c, gb.taskId);
		const va = await taskView(c, ga.taskId);
		const before = await settledDump(H.db);
		const wrongB = await c.post(`/tasks/${gb.taskId}/rerun`, {
			expected_rev: vb.task.rev,
			proposal_id: va.task.current_proposal_id,
		});
		expect([wrongB.status, wrongB.body?.error]).toEqual([409, "stale_binding"]);
		const wrongA = await c.post(`/tasks/${ga.taskId}/rerun`, {
			expected_rev: va.task.rev,
			proposal_id: vb.task.current_proposal_id,
		});
		expect(wrongA.status).toBe(409);
		expect(dump(H.db)).toBe(before);
		const right = await c.post(`/tasks/${gb.taskId}/rerun`, {
			expected_rev: vb.task.rev,
			proposal_id: vb.task.current_proposal_id,
		});
		expect(right.status).toBe(201);
		const nb = pendingOf(await taskView(c, gb.taskId), "run");
		expect(nb.proposal_id).toBe(vb.task.current_proposal_id);
		expect(managedRow(H.db, nb.managed_task_id).repo_id).toBe(B);
		expect(nb.execution_binding.base_sha).toBe(repoOf(H.fx, B).baseSha);
	}, 30_000);

	test("ADV-MR-06 artifacts and result references never cross repositories: 404 without an existence oracle, Gate-2 substitutions refused, each acceptance names its own evidence", async () => {
		const { H, c, A, B } = await twoRepos();
		const a = await toGate2(c, H.fx, { title: "Alpha result" }, A);
		const b = await toGate2(c, H.fx, { title: "Beta result" }, B);
		const va = await taskView(c, a.taskId);
		const vb = await taskView(c, b.taskId);
		const aArts = artifactRows(H.db, a.managedTaskId);
		const bArts = artifactRows(H.db, b.managedTaskId);
		expect(aArts.length).toBeGreaterThan(0);
		expect(bArts.length).toBeGreaterThan(0);
		const aIds = new Set(aArts.map((x) => x.id));
		expect(bArts.some((x) => aIds.has(x.id))).toBe(false);
		for (const [own, other, arts] of [
			[a.taskId, b.taskId, aArts],
			[b.taskId, a.taskId, bArts],
		] as const) {
			const absent = await c.get(`/tasks/${other}/artifacts/${fakeArtifact()}`);
			expect(absent.status).toBe(404);
			for (const art of arts) {
				const mine = await c.get(`/tasks/${own}/artifacts/${art.id}`);
				expect([art.name, mine.status]).toEqual([art.name, 200]);
				const theirs = await c.get(`/tasks/${other}/artifacts/${art.id}`);
				expect([art.name, theirs.status]).toEqual([art.name, 404]);
				// byte-identical to a never-issued id on the same task: no existence oracle
				expect(theirs.text).toBe(absent.text);
				expect(theirs.text).not.toContain(art.id);
				const text = mine.body?.text;
				if (typeof text === "string" && text.length >= 16)
					expect(theirs.text).not.toContain(text.slice(0, 64));
			}
		}
		// Gate-2 substitutions between the two pending results
		const chA = await issueChallenge(c, a.g2);
		const chB = await issueChallenge(c, b.g2);
		const before = await settledDump(H.db);
		for (const [name, target, own, over] of [
			["A-result-binding→B", b.g2, chB, { binding_hash: a.g2.binding_hash }],
			["A-result-challenge→B", b.g2, chB, { challenge: chA.challenge }],
			["B-result-challenge→A", a.g2, chA, { challenge: chB.challenge }],
			["run-kind→A-result", a.g2, chA, { kind: "run", action: "approve" }],
		] as const) {
			const r = await decide(
				c,
				target,
				decisionBody(target, own, "accept", over),
			);
			expect([name, r.status]).toEqual([name, 409]);
			expect(["challenge_invalid", "stale_binding"]).toContain(r.body?.error);
		}
		expect(dump(H.db)).toBe(before);
		const okA = await decide(c, a.g2, decisionBody(a.g2, chA, "accept"));
		const okB = await decide(c, b.g2, decisionBody(b.g2, chB, "accept"));
		expect([okA.status, okB.status]).toEqual([201, 201]);
		for (const [ok, g, mt, repo, other, view, arts, otherArts] of [
			[okA, a.g2, a.managedTaskId, A, B, va, aArts, bArts],
			[okB, b.g2, b.managedTaskId, B, A, vb, bArts, aArts],
		] as const) {
			const row = requestRow(H.db, g.id);
			const env = JSON.parse(row.result_envelope);
			expect(ok.body.receipt.effects.managed_task_id).toBe(mt);
			expect(ok.body.receipt.effects.result_envelope_hash).toBe(
				row.result_envelope_hash,
			);
			expect(env.workspace_task_id).toBe(view.task.id);
			expect(env.managed_task_id).toBe(mt);
			expect(env.base_sha).toBe(repoOf(H.fx, repo).baseSha);
			// the candidate commit exists in its own repository and not in the other one
			expect(gitHas(H.fx, repoOf(H.fx, repo).path, env.candidate_sha)).toBe(
				true,
			);
			expect(gitHas(H.fx, repoOf(H.fx, other).path, env.candidate_sha)).toBe(
				false,
			);
			const ownIds = new Set(arts.map((x: any) => x.id));
			const otherIds = new Set(otherArts.map((x: any) => x.id));
			for (const item of env.artifacts)
				if (item.artifact_id) {
					expect(ownIds.has(item.artifact_id)).toBe(true);
					expect(otherIds.has(item.artifact_id)).toBe(false);
				}
		}
	}, 60_000);
});

describe("ADV-MR decisions under duplication, loss and context change", () => {
	test("ADV-MR-07 duplicate / dropped decision responses: identical resend → same receipt, concurrent duplicates → one decision, a body replayed on the other repository's request → refused", async () => {
		const { H, c, A, B } = await twoRepos();
		const ga = await openGate1(c, H.fx, { title: "Alpha duplicate" }, A);
		const gb = await openGate1(c, H.fx, { title: "Beta duplicate" }, B);
		const chA = await issueChallenge(c, ga.req);
		const chB = await issueChallenge(c, gb.req);
		const bodyA = decisionBody(ga.req, chA, "approve");
		const bodyB = decisionBody(gb.req, chB, "approve");
		// A's body + key sent to B's request before B is decided: never a decision on B
		const crossFirst = await decide(c, gb.req, bodyA);
		expect(crossFirst.status).toBeGreaterThanOrEqual(400);
		expect(decisionsOf(H.db, gb.req.id)).toBe(0);
		// concurrent duplicates of A's decision (a double submit / a retry racing the original)
		const [r1, r2] = await Promise.all([
			decide(c, ga.req, bodyA),
			decide(c, ga.req, bodyA),
		]);
		expect([r1.status, r2.status].every((s) => s === 201 || s === 200)).toBe(
			true,
		);
		expect(r1.body.receipt.decision_id).toBe(r2.body.receipt.decision_id);
		expect([r1.body.replayed, r2.body.replayed].filter((x) => !x)).toHaveLength(
			1,
		);
		expect(decisionsOf(H.db, ga.req.id)).toBe(1);
		// the response was "dropped": the identical resend recovers the same receipt
		const resend = await decide(c, ga.req, bodyA);
		expect(resend.status).toBe(201);
		expect(resend.body.replayed).toBe(true);
		expect(resend.body.receipt).toEqual(
			r1.body.replayed ? r2.body.receipt : r1.body.receipt,
		);
		// B decides with its own body; A's key on B's URL (now decided) is still refused
		const okB = await decide(c, gb.req, bodyB);
		expect(okB.status).toBe(201);
		const crossAfter = await decide(c, ga.req, bodyB);
		expect(crossAfter.status).toBeGreaterThanOrEqual(400);
		expect(crossAfter.text).not.toContain(okB.body.receipt.decision_id);
		// a fresh key on A's consumed challenge never makes a second decision
		const fresh = await decide(c, ga.req, { ...bodyA, idempotency_key: key() });
		expect(fresh.status).toBe(409);
		expect([
			decisionsOf(H.db, ga.req.id),
			decisionsOf(H.db, gb.req.id),
		]).toEqual([1, 1]);
		await waitGate2(c, ga.taskId);
		await waitGate2(c, gb.taskId);
		// exactly one execution each, in its own repository
		for (const [g, repo] of [
			[ga, A],
			[gb, B],
		] as const) {
			expect(linkage(H.db, g.req.managed_task_id).runs).toBe(1);
			expect(managedRow(H.db, g.req.managed_task_id).repo_id).toBe(repo);
		}
		// before A's key has a receipt, A's body is simply the wrong subject for B (binding / challenge);
		// once it has one, the same key on another request is a conflicting payload (the payload hash
		// covers the request id), never A's receipt presented as B's
		expect(["stale_binding", "challenge_invalid"]).toContain(
			crossFirst.body?.error,
		);
		expect(crossAfter.body?.error).toBe("idempotency_conflict");
	}, 40_000);

	test("ADV-MR-08 a new proposal version published between challenge and decision → 409, nothing queued; the same change in repository B leaves A's pending request and challenge intact", async () => {
		const { H, c, A, B } = await twoRepos();
		// (a) same repository: v2 published while v1's signature is in flight
		const g1 = await openGate1(c, H.fx, { title: "Alpha v1" }, A);
		const ch1 = await issueChallenge(c, g1.req);
		const v1 = await taskView(c, g1.taskId);
		const saved = await c.req("PUT", `/tasks/${g1.taskId}/draft`, {
			expected_rev: v1.task.rev,
			draft: wsDraft({ title: "Alpha v2" }),
		});
		expect(saved.status).toBe(200);
		const pub = await c.post(`/tasks/${g1.taskId}/proposals`, {
			expected_rev: saved.body.task.rev,
		});
		expect(pub.status).toBe(201);
		const late = await decide(c, g1.req, decisionBody(g1.req, ch1, "approve"));
		expect(late.status).toBe(409);
		expect(decisionsOf(H.db, g1.req.id)).toBe(0);
		expect(requestRow(H.db, g1.req.id).status).toBe("invalidated");
		expect(managedRow(H.db, g1.req.managed_task_id).state).not.toBe("queued");
		expect(runsOf(H.db, g1.req.managed_task_id)).toBe(0);
		expect(
			count(
				H.db,
				"SELECT count(*) AS n FROM managed_tasks WHERE state = 'queued' OR lease_owner IS NOT NULL",
			),
		).toBe(0);
		// (b) other repository: A's request is pending with an issued challenge; B publishes v2 and then withdraws
		const ga = await openGate1(c, H.fx, { title: "Alpha steady" }, A);
		const chA = await issueChallenge(c, ga.req);
		const rowBefore = requestRow(H.db, ga.req.id);
		const gb = await openGate1(c, H.fx, { title: "Beta v1" }, B);
		await issueChallenge(c, gb.req);
		const vb = await taskView(c, gb.taskId);
		const sb = await c.req("PUT", `/tasks/${gb.taskId}/draft`, {
			expected_rev: vb.task.rev,
			draft: wsDraft({ title: "Beta v2" }),
		});
		const pb = await c.post(`/tasks/${gb.taskId}/proposals`, {
			expected_rev: sb.body.task.rev,
		});
		expect(pb.status).toBe(201);
		expect(requestRow(H.db, gb.req.id).status).toBe("invalidated");
		const vb2 = await taskView(c, gb.taskId);
		const cb = await c.post(`/tasks/${gb.taskId}/cancel`, {
			expected_rev: vb2.task.rev,
		});
		expect(cb.status).toBe(200);
		const rowAfter = requestRow(H.db, ga.req.id);
		expect(rowAfter.status).toBe("pending");
		expect(rowAfter.rev).toBe(rowBefore.rev);
		expect(rowAfter.binding_hash).toBe(rowBefore.binding_hash);
		expect(rowAfter.updated_at).toBe(rowBefore.updated_at);
		const ok = await decide(c, ga.req, decisionBody(ga.req, chA, "approve"));
		expect(ok.status).toBe(201);
		await waitGate2(c, ga.taskId);
	}, 40_000);

	test("ADV-MR-09 a trusted-policy change for repository B (restart) voids only B's pending Gate 1; A's is approved with a fresh challenge", async () => {
		const H1 = realHub({ fixture: multiRepoFixture(["beta"]) });
		const A = H1.fx.repos[0]?.id ?? "";
		const B = H1.fx.repos[1]?.id ?? "";
		const c1 = await H1.signIn();
		const ga = await openGate1(c1, H1.fx, { title: "Alpha policy" }, A);
		const gb = await openGate1(c1, H1.fx, { title: "Beta policy" }, B);
		await settledDump(H1.db);
		await H1.stop();
		const H2 = composedHub({
			reuse: H1.fx,
			credentials: { operator: H1.credential, readOnly: H1.readOnlyCredential },
			// only B's trusted entry changes (a verification timeout): policyHash(config, B) moves, A's does not
			config: (cfg) => ({
				...cfg,
				repos: cfg.repos.map((r) =>
					r.id === B
						? {
								...r,
								verification: r.verification.map((v) => ({
									...v,
									timeout_s: v.timeout_s + 1,
								})),
							}
						: r,
				),
			}),
		});
		await H2.bridge.idle();
		const c2 = await H2.signIn();
		// B: no approval is possible under the changed policy (refused at challenge or decision)
		const rb = requestRow(H2.db, gb.req.id);
		let bDecided = false;
		if (rb.status === "pending") {
			const chB = await c2.post(`/approval-requests/${gb.req.id}/challenge`, {
				kind: "run",
				binding_hash: gb.req.binding_hash,
				expected_request_rev: rb.rev,
			});
			if (chB.status === 201 || chB.status === 200) {
				const d = await decide(
					c2,
					gb.req,
					decisionBody(gb.req, chB.body, "approve"),
				);
				expect([d.status, d.body?.error]).toEqual([409, "stale_binding"]);
				bDecided = d.status === 201;
			} else expect(chB.status).toBe(409);
		}
		expect(bDecided).toBe(false);
		expect(decisionsOf(H2.db, gb.req.id)).toBe(0);
		expect(managedRow(H2.db, gb.req.managed_task_id).state).not.toBe("queued");
		// A: still pending and approvable (old challenges died with the old boot; a fresh one works)
		const ra = requestRow(H2.db, ga.req.id);
		expect(ra.status).toBe("pending");
		const chA = await issueChallenge(c2, { ...ga.req, rev: ra.rev });
		const ok = await decide(c2, ga.req, decisionBody(ga.req, chA, "approve"));
		expect(ok.status).toBe(201);
		await waitGate2(c2, ga.taskId);
	}, 40_000);
});

describe("ADV-MR one engine across repositories", () => {
	test("ADV-MR-10 cancelling B while it waits behind A cancels B only; A keeps the slot and finishes", async () => {
		const bar = new Barrier().arm("before_review");
		const { H, c, A, B } = await twoRepos({ hooks: bar });
		const a = await approveGate1(c, H.fx, { title: "Alpha holds the slot" }, A);
		await waitFor(() => bar.holding("before_review", a.managedTaskId));
		const b = await approveGate1(c, H.fx, { title: "Beta waits" }, B);
		const qs = await snapshotOf(c);
		expect(qs.body.execution_queue.active).toMatchObject({
			managed_task_id: a.managedTaskId,
			workspace_task_id: a.taskId,
			repo_id: A,
		});
		expect(
			qs.body.execution_queue.queued.map((q: any) => [
				q.managed_task_id,
				q.repo_id,
			]),
		).toEqual([[b.managedTaskId, B]]);
		const aTask = (await taskView(c, a.taskId)).task;
		const aEngine = managedRow(H.db, a.managedTaskId);
		const vb = await taskView(c, b.taskId);
		expect(vb.task.stage).toBe("queued");
		const cancel = await c.post(`/tasks/${b.taskId}/cancel`, {
			expected_rev: vb.task.rev,
		});
		expect([cancel.status, cancel.body.task.stage]).toEqual([200, "cancelled"]);
		expect(managedRow(H.db, b.managedTaskId).state).toBe("cancelled");
		// A untouched: same workspace rev, same engine row, still holding the slot
		expect((await taskView(c, a.taskId)).task.rev).toBe(aTask.rev);
		expect(managedRow(H.db, a.managedTaskId)).toEqual(aEngine);
		expect(bar.holding("before_review", a.managedTaskId)).toBe(true);
		const q2 = await snapshotOf(c);
		expect(q2.body.execution_queue.active?.managed_task_id).toBe(
			a.managedTaskId,
		);
		expect(q2.body.execution_queue.queued).toEqual([]);
		bar.releaseAll();
		await waitGate2(c, a.taskId);
		await Bun.sleep(300);
		expect(runsOf(H.db, b.managedTaskId)).toBe(0);
		expect(managedRow(H.db, b.managedTaskId).lease_owner).toBeNull();
		expect(
			bar.arrivals.filter((x) => x.taskId === b.managedTaskId),
		).toHaveLength(0);
	}, 40_000);

	test("ADV-MR-11 the snapshot's queue is the engine's claim order across repositories, and never more than one execution holds a lease", async () => {
		const bar = new Barrier().arm("before_review");
		const { H, c, A, B } = await twoRepos({ hooks: bar });
		let maxLeased = 0;
		let sampling = true;
		const sampler = (async () => {
			while (sampling) {
				maxLeased = Math.max(maxLeased, leased(H.db));
				await Bun.sleep(5);
			}
		})();
		try {
			const a = await approveGate1(c, H.fx, { title: "Alpha first" }, A);
			await waitFor(() => bar.holding("before_review", a.managedTaskId));
			const others = [
				await approveGate1(c, H.fx, { title: "Beta second" }, B),
				await approveGate1(c, H.fx, { title: "Alpha third" }, A),
				await approveGate1(c, H.fx, { title: "Beta fourth" }, B),
			];
			// the claim order as the engine defines it (run_requested_at, created_at, id) — not assumed
			const expected = rows(
				H.db,
				"SELECT id FROM managed_tasks WHERE state = 'queued' AND lease_owner IS NULL ORDER BY run_requested_at, created_at, id",
			).map((r) => r.id as string);
			expect(new Set(expected)).toEqual(
				new Set(others.map((o) => o.managedTaskId)),
			);
			const reviewed: string[] = [a.managedTaskId];
			let held = a.managedTaskId;
			for (let i = 0; i <= expected.length; i++) {
				const snap = await snapshotOf(c);
				const q = snap.body.execution_queue;
				expect(q.active?.managed_task_id).toBe(held);
				expect(q.queued.map((x: any) => x.managed_task_id)).toEqual(
					expected.slice(i),
				);
				for (const e of q.queued)
					expect(e.repo_id).toBe(managedRow(H.db, e.managed_task_id).repo_id);
				bar.release("before_review", held);
				const next = expected[i];
				if (!next) break;
				await waitFor(() => bar.holding("before_review", next));
				reviewed.push(next);
				held = next;
			}
			expect(
				bar.arrivals
					.filter((x) => x.point === "before_review")
					.map((x) => x.taskId),
			).toEqual([a.managedTaskId, ...expected]);
			expect(reviewed).toEqual([a.managedTaskId, ...expected]);
			for (const g of [a, ...others]) {
				await waitGate2(c, g.taskId);
				expect(linkage(H.db, g.managedTaskId).runs).toBe(1);
			}
		} finally {
			sampling = false;
			await sampler;
			bar.releaseAll();
		}
		expect(maxLeased).toBe(1);
	}, 60_000);

	test("ADV-MR-12 an open quarantine in repository A pauses claims in every repository (snapshot says so; B is never claimed)", async () => {
		const fo = multiRepoFixture(["beta"]);
		const A = fo.repoId ?? "";
		const H = composedHub({
			fixture: fo,
			adapters: (b) => hangInRepo(b, A),
			processOps: {
				inspect: () => ({
					state: "error",
					error: "adversarial: cannot inspect",
				}),
				groupAlive: () => "error",
				terminateGroup: async (pid, ms) => {
					await hostProcessOps.terminateGroup(pid, ms);
					return false; // really terminated, but reported unconfirmed
				},
			},
		});
		expect(H.fx.repos[0]?.id).toBe(A);
		const B = H.fx.repos[1]?.id ?? "";
		const c = await H.signIn();
		const a = await approveGate1(c, H.fx, { title: "Alpha hangs" }, A);
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
					"SELECT count(*) AS n FROM managed_quarantine WHERE released_at IS NULL",
				) > 0,
			20_000,
		);
		const b = await approveGate1(c, H.fx, { title: "Beta must wait" }, B);
		const fence = managedRow(H.db, b.managedTaskId).fence_token;
		await Bun.sleep(1500); // ≈ 50 worker polls
		const row = managedRow(H.db, b.managedTaskId);
		expect([row.state, row.lease_owner, row.fence_token]).toEqual([
			"queued",
			null,
			fence,
		]);
		expect(runsOf(H.db, b.managedTaskId)).toBe(0);
		const snap = await snapshotOf(c);
		expect(snap.status).toBe(200);
		expect(snap.body.execution_queue.claims_paused_by_quarantine).toBe(true);
		// frozen API v1.2: `active` = the leased execution, else the active one that resumes first —
		// B is neither (queued, never claimed), so it must be listed as waiting, not as holding the slot
		expect(
			snap.body.execution_queue.queued.map((q: any) => q.managed_task_id),
		).toContain(b.managedTaskId);
		expect(snap.body.execution_queue.active?.managed_task_id).not.toBe(
			b.managedTaskId,
		);
		expect((await taskView(c, b.taskId)).task.stage).toBe("queued");
	}, 40_000);
});

describe("ADV-MR queue contract", () => {
	test("ADV-MR-16 a queued execution that nothing has claimed is waiting, never `active` (API v1.2: active = leased, else an active one that resumes first)", async () => {
		const H = composedHub({
			fixture: multiRepoFixture(["beta"]),
			manual: true,
		});
		const c = await H.signIn();
		const A = H.fx.repos[0]?.id ?? "";
		const B = H.fx.repos[1]?.id ?? "";
		const b = await approveGate1(c, H.fx, { title: "Beta queued first" }, B);
		const a = await approveGate1(c, H.fx, { title: "Alpha queued second" }, A);
		expect(leased(H.db)).toBe(0);
		const q = (await snapshotOf(c)).body.execution_queue;
		expect(q.claims_paused_by_quarantine).toBe(false);
		expect(q.active).toBeNull();
		expect(q.queued.map((x: any) => x.managed_task_id)).toEqual([
			b.managedTaskId,
			a.managedTaskId,
		]);
	});
});

describe("ADV-MR evidence validity stays with its repository", () => {
	test("ADV-MR-13 a tampered artifact in A fails A's acceptance (A invalidated) while B's pending result is accepted and verified", async () => {
		const { H, c, A, B } = await twoRepos();
		const a = await toGate2(c, H.fx, { title: "Alpha tampered" }, A);
		const b = await toGate2(c, H.fx, { title: "Beta clean" }, B);
		const diff = artifactRows(H.db, a.managedTaskId).find(
			(x) => x.name === "diff.patch",
		);
		expect(diff).toBeTruthy();
		flipByte(artPath(H, diff.rel_path));
		const chA = await issueChallenge(c, a.g2);
		const ra = await decide(c, a.g2, decisionBody(a.g2, chA, "accept"));
		expect(ra.status).toBe(409);
		expect(["integrity_failed", "evidence_unavailable"]).toContain(
			ra.body?.error,
		);
		expect(decisionsOf(H.db, a.g2.id)).toBe(0);
		expect(requestRow(H.db, a.g2.id).status).toBe("invalidated");
		expect((await taskView(c, a.taskId)).task.stage).not.toBe("accepted");
		// B: nothing changed — still pending, its artifacts verified, its acceptance goes through
		expect(requestRow(H.db, b.g2.id).status).toBe("pending");
		for (const art of artifactRows(H.db, b.managedTaskId)) {
			const r = await c.get(`/tasks/${b.taskId}/artifacts/${art.id}`);
			expect([art.name, r.status, r.body?.status]).toEqual([
				art.name,
				200,
				r.body?.truncated ? "truncated" : "verified",
			]);
		}
		const chB = await issueChallenge(c, b.g2);
		const rb = await decide(c, b.g2, decisionBody(b.g2, chB, "accept"));
		expect(rb.status).toBe(201);
		const vb = await taskView(c, b.taskId);
		expect(vb.task.stage).toBe("accepted");
		expect(vb.acceptance_validity?.status).toBe("valid");
	}, 60_000);

	test("ADV-MR-14 an accepted result of A later corrupted reads invalid; B's accepted result stays valid (detail and snapshot)", async () => {
		const { H, c, A, B } = await twoRepos();
		const a = await toGate2(
			c,
			H.fx,
			{ title: "Alpha accepted then corrupted" },
			A,
		);
		const b = await toGate2(c, H.fx, { title: "Beta accepted" }, B);
		for (const g of [a, b]) {
			const ch = await issueChallenge(c, g.g2);
			expect(
				(await decide(c, g.g2, decisionBody(g.g2, ch, "accept"))).status,
			).toBe(201);
		}
		const decA = rows(
			H.db,
			"SELECT id, decided_at, response_body FROM managed_decisions WHERE approval_request_id = ?",
			a.g2.id,
		);
		const diff = artifactRows(H.db, a.managedTaskId).find(
			(x) => x.name === "diff.patch",
		);
		flipByte(artPath(H, diff.rel_path));
		// detection = the task-detail re-check once the last check is older than 5 s (RUNBOOK): poll
		const va = await waitFor(
			async () => {
				const v = await taskView(c, a.taskId);
				return v.acceptance_validity?.status === "invalid" ? v : null;
			},
			20_000,
			500,
		);
		expect(va.task.stage).toBe("accepted");
		expect(va.acceptance_validity.reason).toBe("source_evidence_changed");
		await Bun.sleep(5_200); // B's last check is now old enough to be re-checked on read too
		const vb = await taskView(c, b.taskId);
		expect(vb.task.stage).toBe("accepted");
		expect(vb.acceptance_validity?.status).toBe("valid");
		const snap = await snapshotOf(c);
		const byId = new Map(snap.body.tasks.map((t: any) => [t.task.id, t]));
		expect((byId.get(a.taskId) as any)?.acceptance_validity?.status).toBe(
			"invalid",
		);
		expect((byId.get(b.taskId) as any)?.acceptance_validity?.status).toBe(
			"valid",
		);
		// history unchanged
		expect(
			rows(
				H.db,
				"SELECT id, decided_at, response_body FROM managed_decisions WHERE approval_request_id = ?",
				a.g2.id,
			),
		).toEqual(decA);
	}, 60_000);
});

describe("ADV-MR restart", () => {
	test("ADV-MR-15 restart preserves both repositories' tasks, requests, decisions and relationships; receipts replay; B's pending Gate 1 needs a fresh challenge", async () => {
		const H1 = realHub({ fixture: multiRepoFixture(["beta"]) });
		const A = H1.fx.repos[0]?.id ?? "";
		const B = H1.fx.repos[1]?.id ?? "";
		const O = observeRepo(H1.db, "watched");
		const c1 = await H1.signIn();
		const a = await toGate2(c1, H1.fx, { title: "Alpha accepted" }, A);
		const chA = await issueChallenge(c1, a.g2);
		const acceptA = decisionBody(a.g2, chA, "accept");
		const okA = await decide(c1, a.g2, acceptA);
		expect(okA.status).toBe(201);
		const gb = await openGate1(c1, H1.fx, { title: "Beta pending" }, B);
		const oldChB = await issueChallenge(c1, gb.req);
		const draftB = await createTask(c1, H1.fx, { title: "Beta draft" }, B);
		const ids = [a.taskId, gb.taskId, draftB.id];
		const durable = (v: any) => ({
			task: v.task,
			current_proposal: v.current_proposal,
			approval_requests: v.approval_requests,
			decisions: v.decisions,
			engine: v.engine
				? { managed_task_id: v.engine.managed_task_id, state: v.engine.state }
				: null,
			validity: v.acceptance_validity?.status ?? null,
		});
		const beforeViews = new Map<string, any>();
		for (const id of ids) beforeViews.set(id, durable(await taskView(c1, id)));
		const rel = () =>
			rows(
				H1.db,
				`SELECT w.id AS task, w.repo_id AS repo, m.id AS mt, m.repo_id AS mrepo,
				        json_extract(p.snapshot, '$.repo_id') AS prepo
				   FROM workspace_tasks w
				   LEFT JOIN managed_tasks m ON m.id = w.current_managed_task_id
				   LEFT JOIN managed_proposals p ON p.id = w.current_proposal_id
				  ORDER BY w.id`,
			);
		const relBefore = rel();
		for (const r of relBefore) {
			if (r.mt) expect(r.mrepo).toBe(r.repo);
			if (r.prepo) expect(r.prepo).toBe(r.repo);
		}
		await settledDump(H1.db);
		await H1.stop();
		const H2 = realHub({
			reuse: H1.fx,
			credentials: { operator: H1.credential, readOnly: H1.readOnlyCredential },
		});
		const c2 = await H2.signIn();
		for (const id of ids)
			expect(durable(await taskView(c2, id))).toEqual(beforeViews.get(id));
		expect(
			rows(
				H2.db,
				`SELECT w.id AS task, w.repo_id AS repo, m.id AS mt, m.repo_id AS mrepo,
				        json_extract(p.snapshot, '$.repo_id') AS prepo
				   FROM workspace_tasks w
				   LEFT JOIN managed_tasks m ON m.id = w.current_managed_task_id
				   LEFT JOIN managed_proposals p ON p.id = w.current_proposal_id
				  ORDER BY w.id`,
			),
		).toEqual(relBefore);
		const snap = await snapshotOf(c2);
		expect(snap.body.repos.map((r: any) => r.repo_id).sort()).toEqual(
			[A, B].sort(),
		);
		expect(snap.body.observed_repos.map((r: any) => r.repo_id)).toContain(O);
		const repoOfTask = new Map(
			snap.body.tasks.map((t: any) => [t.task.id, t.task.repo_id]),
		);
		expect(ids.map((id) => repoOfTask.get(id))).toEqual([A, B, B]);
		// the lost response of A's acceptance is recovered by the identical resend (receipt survives)
		const replay = await decide(c2, a.g2, acceptA);
		expect([replay.status, replay.body?.replayed]).toEqual([201, true]);
		expect(replay.body.receipt).toEqual(okA.body.receipt);
		expect(decisionsOf(H2.db, a.g2.id)).toBe(1);
		// B's old-boot challenge is dead; a fresh one approves B, which runs in B only
		const stale = await decide(
			c2,
			gb.req,
			decisionBody(gb.req, oldChB, "approve"),
		);
		expect(stale.status).toBe(409);
		expect(decisionsOf(H2.db, gb.req.id)).toBe(0);
		const rb = requestRow(H2.db, gb.req.id);
		expect(rb.status).toBe("pending");
		const chB = await issueChallenge(c2, { ...gb.req, rev: rb.rev });
		const okB = await decide(c2, gb.req, decisionBody(gb.req, chB, "approve"));
		expect(okB.status).toBe(201);
		const g2b = await waitGate2(c2, gb.taskId);
		const envB = JSON.parse(requestRow(H2.db, g2b.id).result_envelope);
		expect(envB.base_sha).toBe(repoOf(H2.fx, B).baseSha);
		expect(gitHas(H2.fx, repoOf(H2.fx, B).path, envB.candidate_sha)).toBe(true);
		expect(gitHas(H2.fx, repoOf(H2.fx, A).path, envB.candidate_sha)).toBe(
			false,
		);
		// the observed repository is still not executable after the restart
		const obs = await c2.post("/tasks", {
			idempotency_key: key("obs"),
			repo_id: O,
			draft: wsDraft(),
		});
		expect([obs.status, obs.body?.error]).toEqual([422, "repo_not_allowed"]);
	}, 60_000);
});
