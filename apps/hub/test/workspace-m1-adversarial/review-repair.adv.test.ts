// biome-ignore-all lint/suspicious/noExplicitAny: adversarial tests inspect raw, untyped HTTP bodies and SQLite rows on purpose
// Review repair regressions (review of d158571, 2026-10-05): APP-P2-01 (omitted history looked quiet and hid
// an invalid acceptance) and APP-P2-02 (inbox pins exhausted the 500-task window; requests beyond the inbox
// cap were stranded). Final re-review T0-FINAL-P2-01: the inbox membership generation of each scope.
// Real composed hub, fake adapters only, synthetic repositories; every assertion here fails the run (no
// logical FAIL with exit 0).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
	approveGate1,
	assertIsolation,
	type ComposedHub,
	composedHub,
	createTask,
	decide,
	decisionBody,
	FakeClock,
	issueChallenge,
	multiRepoFixture,
	openGate1,
	pendingOf,
	taskView,
	teardown,
	waitGate2,
} from "./harness.ts";

assertIsolation();
afterAll(() => teardown());

type Client = Awaited<ReturnType<ComposedHub["signIn"]>>;
const q = (params: Record<string, string | number>) =>
	new URLSearchParams(
		Object.entries(params).map(([k, v]) => [k, String(v)] as [string, string]),
	).toString();

describe("APP-P2-01 — omitted history never reads as quiet", () => {
	let H: ComposedHub;
	let c: Client;
	let A: string;
	let B: string;
	const ids: Record<string, string> = {};
	const clock = new FakeClock();
	let forceBlock = false;

	beforeAll(async () => {
		H = composedHub({
			manual: true,
			clock,
			adapters: (base) => ({
				...base,
				implementer: (mode) => (forceBlock ? null : base.implementer(mode)),
			}),
			fixture: multiRepoFixture(["beta"]),
		});
		c = await H.signIn();
		[A, B] = H.fx.repos.map((r) => r.id) as [string, string];
		// the review's reproduction: A failed, A blocked, A accepted through both gates then invalid
		const failed = await approveGate1(
			c,
			H.fx,
			{ title: "Old failed A", simulation_scenario: "verification_fails" },
			A,
		);
		await H.drain();
		const blocked = await approveGate1(c, H.fx, { title: "Old blocked A" }, A);
		forceBlock = true;
		await H.drain();
		forceBlock = false;
		const accepted = await approveGate1(
			c,
			H.fx,
			{ title: "Old accepted A now invalid" },
			A,
		);
		await H.drain();
		const g2 = pendingOf(await taskView(c, accepted.taskId), "result");
		const ch = await issueChallenge(c, g2);
		const res = await decide(c, g2, decisionBody(g2, ch, "accept"));
		expect(res.status).toBe(201);
		const digest = res.body.receipt.effects.evidence_bundle_digest;
		rmSync(join(H.fx.config.artifacts_root, "_sealed", `${digest}.bundle`));
		clock.advance(6001);
		const v = await taskView(c, accepted.taskId);
		expect(v.acceptance_validity.status).toBe("invalid"); // sticky invalid established
		Object.assign(ids, {
			failed: failed.taskId,
			blocked: blocked.taskId,
			accepted: accepted.taskId,
		});
		expect(
			(
				await Promise.all(
					[ids.failed, ids.blocked, ids.accepted].map((id) =>
						taskView(c, id ?? ""),
					),
				)
			).map((x) => x.phase),
		).toEqual(["failed", "blocked", "accepted"]);
		// 500 newer B drafts push every A task out of the 500-task window
		for (let i = 0; i < 500; i++) {
			clock.advance(1);
			await createTask(c, H.fx, { title: `Newer B draft ${i}` }, B);
		}
	}, 180_000);

	test("the window omits A, but A's complete summary keeps 3 attention tasks and the invalid acceptance", async () => {
		const snap = (await c.get("/snapshot")).body;
		expect(snap.tasks).toHaveLength(500);
		expect(snap.tasks.filter((t: any) => t.task.repo_id === A)).toHaveLength(0);
		const a = snap.repo_summaries.find((r: any) => r.repo_id === A);
		expect(a).toMatchObject({
			tasks: 3,
			complete: true,
			active_tasks: 0,
			pending_requests: 0,
		});
		expect(a.phases).toMatchObject({ failed: 1, blocked: 1, accepted: 1 });
		expect(a.categories).toMatchObject({ attention: 3, accepted: 0 });
		expect(a.acceptance).toMatchObject({ invalid: 1, valid: 0, unknown: 0 });
		expect(a.acceptance.latest_checked_at).not.toBeNull();
		const b = snap.repo_summaries.find((r: any) => r.repo_id === B);
		expect(b).toMatchObject({ tasks: 500 });
		expect(b.categories.drafts).toBe(500);
		// totals agree with the separate complete count
		expect(snap.repo_task_counts.find((r: any) => r.repo_id === A).tasks).toBe(
			3,
		);
	});

	test("bounded history continuation reaches every omitted A task exactly once", async () => {
		const p1 = await c.get(`/task-history?${q({ repo_id: A, limit: 2 })}`);
		expect(p1.status).toBe(200);
		expect(p1.body.items).toHaveLength(2);
		expect(p1.body.page).toMatchObject({
			total: 3,
			returned: 2,
			has_more: true,
			complete: false,
		});
		const p2 = await c.get(
			`/task-history?${q({ repo_id: A, limit: 2, cursor: p1.body.page.next_cursor })}`,
		);
		expect(p2.status).toBe(200);
		expect(p2.body.items).toHaveLength(1);
		expect(p2.body.page).toMatchObject({
			has_more: false,
			next_cursor: null,
			complete: false, // a later page is never "the complete list"
		});
		const all = [...p1.body.items, ...p2.body.items];
		expect(new Set(all.map((t: any) => t.task.id)).size).toBe(3);
		expect(all.every((t: any) => t.task.repo_id === A)).toBe(true);
		const byId = Object.fromEntries(all.map((t: any) => [t.task.id, t]));
		expect(byId[ids.failed ?? ""].phase).toBe("failed");
		expect(byId[ids.blocked ?? ""].phase).toBe("blocked");
		expect(byId[ids.accepted ?? ""].acceptance_validity.status).toBe("invalid");
		// order contract: created_at DESC, then the unique id DESC (these three share one fake instant, so
		// the id tiebreak decides — deterministically)
		const key = (t: any) => `${t.task.created_at}|${t.task.id}`;
		expect(all.map(key)).toEqual(
			[...all].map(key).sort((x, y) => (x < y ? 1 : x > y ? -1 : 0)),
		);
		const att = await c.get(
			`/task-history?${q({ repo_id: A, filter: "attention" })}`,
		);
		expect(att.body.page).toMatchObject({ total: 3, complete: true });
	});

	test("a pinned pending A task restores ownership and the summary still carries the omitted attention", async () => {
		const pending = await openGate1(c, H.fx, { title: "One pending A" }, A);
		const snap = (await c.get("/snapshot")).body;
		const shownA = snap.tasks.filter((t: any) => t.task.repo_id === A);
		expect(shownA.map((t: any) => t.task.id)).toEqual([pending.taskId]);
		const a = snap.repo_summaries.find((r: any) => r.repo_id === A);
		expect(a).toMatchObject({ tasks: 4, pending_requests: 1 });
		expect(a.categories).toMatchObject({ attention: 3, needsApproval: 1 });
		// count drift follows a supported transition (reject → rejected; attention unchanged)
		const ch = await issueChallenge(c, pending.req);
		const res = await decide(
			c,
			pending.req,
			decisionBody(pending.req, ch, "reject"),
		);
		expect(res.status).toBe(201);
		const after = (await c.get("/snapshot")).body.repo_summaries.find(
			(r: any) => r.repo_id === A,
		);
		expect(after).toMatchObject({ tasks: 4, pending_requests: 0 });
		expect(after.categories).toMatchObject({
			attention: 3,
			needsApproval: 0,
			rejected: 1,
		});
	});

	test("history scope, bounds and cursors are validated server-side", async () => {
		const st = async (params: Record<string, string | number>) =>
			(await c.get(`/task-history?${q(params)}`)).status;
		expect(await st({ repo_id: A, limit: 101 })).toBe(400);
		expect(await st({ repo_id: A, limit: 0 })).toBe(400);
		expect(await st({ repo_id: A, filter: "everything" })).toBe(400);
		expect(await st({ repo_id: A, extra: "x" })).toBe(400);
		expect(await st({ repo_id: "local/not-allowlisted" })).toBe(422);
		expect(await st({ repo_id: A, cursor: "not*base64" })).toBe(400);
		// the read collections are GET-only: no write, repair or decision is reachable through them
		for (const path of ["/task-history", "/inbox"]) {
			const before = H.db
				.query("SELECT count(*) AS n FROM managed_decisions")
				.get();
			const r = await c.post(`${path}?${q({ repo_id: A })}`, {});
			expect(r.status).toBeGreaterThanOrEqual(400);
			expect(r.status).toBeLessThan(500);
			expect(
				H.db.query("SELECT count(*) AS n FROM managed_decisions").get(),
			).toEqual(before);
		}
		expect(
			(await c.get(`/task-history?repo_id=${A}&repo_id=${B}`)).status,
		).toBe(400); // duplicate parameter
		expect((await c.get("/task-history")).status).toBe(400); // repository required
		const pb = await c.get(`/task-history?${q({ repo_id: B, limit: 100 })}`);
		expect(pb.body.items).toHaveLength(100);
		expect(pb.body.items.every((t: any) => t.task.repo_id === B)).toBe(true);
		// a B cursor is scope-bound: refused for A and for another page size
		expect(
			await st({ repo_id: A, limit: 100, cursor: pb.body.page.next_cursor }),
		).toBe(400);
		expect(
			await st({ repo_id: B, limit: 50, cursor: pb.body.page.next_cursor }),
		).toBe(400);
		expect(H.providerSpawns()).toBe(0);
	});
});

describe("APP-P2-02 — inbox and queue stay complete beyond the 500-task window", () => {
	let H: ComposedHub;
	let c: Client;
	let A: string;
	let B: string;
	let C: string;
	let queuedA: { taskId: string; managedTaskId: string };
	const frames: Record<number, any> = {};
	const clock = new FakeClock();
	const owner = (taskId: string) =>
		(
			H.db
				.query("SELECT repo_id FROM workspace_tasks WHERE id = ?")
				.get(taskId) as { repo_id: string } | undefined
		)?.repo_id;

	beforeAll(async () => {
		// manual worker: A is approved and stays queued (held) while the inbox fills up
		H = composedHub({
			manual: true,
			clock,
			fixture: multiRepoFixture(["beta", "gamma"]),
		});
		c = await H.signIn();
		[A, B, C] = H.fx.repos.map((r) => r.id) as [string, string, string];
		const a = await approveGate1(
			c,
			H.fx,
			{ title: "A queued behind the inbox cap" },
			A,
		);
		queuedA = { taskId: a.taskId, managedTaskId: a.managedTaskId };
		for (let i = 1; i <= 501; i++) {
			clock.advance(1);
			await openGate1(c, H.fx, { title: `Pending ${i}` }, i === 501 ? C : B);
			if (i >= 499) frames[i] = (await c.get("/snapshot")).body;
		}
	}, 240_000);

	test("499 / 500 / 501: the queue keeps A's ownership and A's summary counts it although its task row is cut", () => {
		for (const n of [499, 500, 501]) {
			const s = frames[n];
			expect(s.tasks.length).toBeLessThanOrEqual(500);
			const inQueue = [
				s.execution_queue.active,
				...s.execution_queue.queued,
			].find((e: any) => e?.workspace_task_id === queuedA.taskId);
			expect(inQueue?.repo_id).toBe(A);
			expect(s.execution_queue).toMatchObject({
				total_executions: 1,
				queued_complete: true,
			});
			const a = s.repo_summaries.find((r: any) => r.repo_id === A);
			expect(a).toMatchObject({ tasks: 1, active_tasks: 1 });
			expect(a.categories.queued).toBe(1);
		}
		// at 499 queued A still fits the window; at 500 every slot is pinned by the inbox
		expect(
			frames[499].tasks.some((t: any) => t.task.id === queuedA.taskId),
		).toBe(true);
		expect(
			frames[500].tasks.some((t: any) => t.task.id === queuedA.taskId),
		).toBe(false);
	});

	test("every emitted inbox item carries its own repository and title, verified against the database", () => {
		for (const n of [499, 500, 501])
			for (const r of frames[n].pending_requests) {
				expect(r.repo_id).toBe(owner(r.workspace_task_id));
				expect(typeof r.task_title).toBe("string");
			}
	});

	test("501: the global first page discloses truncation; C's request is reachable by filter and by continuation", async () => {
		const s = frames[501];
		expect(s.pending_requests).toHaveLength(500);
		expect(s.pending_page).toMatchObject({
			total: 501,
			returned: 500,
			has_more: true,
			complete: false,
		});
		expect(s.pending_requests.some((r: any) => r.repo_id === C)).toBe(false);
		expect(
			s.repo_summaries.find((r: any) => r.repo_id === C).pending_requests,
		).toBe(1);
		const fc = await c.get(`/inbox?${q({ repo_id: C })}`);
		expect(fc.status).toBe(200);
		expect(fc.body.items).toHaveLength(1);
		expect(fc.body.items[0]).toMatchObject({ repo_id: C, kind: "run" });
		expect(fc.body.page).toMatchObject({ total: 1, complete: true });
		const more = await c.get(
			`/inbox?${q({ limit: 500, cursor: s.pending_page.next_cursor })}`,
		);
		expect(more.status).toBe(200);
		expect(more.body.items.map((r: any) => r.repo_id)).toEqual([C]);
		expect(more.body.page).toMatchObject({
			has_more: false,
			next_cursor: null,
		});
		const seen = new Set([
			...s.pending_requests.map((r: any) => r.id),
			...more.body.items.map((r: any) => r.id),
		]);
		expect(seen.size).toBe(501);
	});

	test("a decision between pages: no duplicate, no gap, totals follow", async () => {
		const p1 = await c.get(`/inbox?${q({ repo_id: B, limit: 250 })}`);
		expect(p1.body.page).toMatchObject({
			total: 500,
			returned: 250,
			has_more: true,
		});
		const first = p1.body.items[0];
		const req = pendingOf(await taskView(c, first.workspace_task_id), "run");
		const ch = await issueChallenge(c, req);
		expect((await decide(c, req, decisionBody(req, ch, "reject"))).status).toBe(
			201,
		);
		const p2 = await c.get(
			`/inbox?${q({ repo_id: B, limit: 250, cursor: p1.body.page.next_cursor })}`,
		);
		expect(p2.status).toBe(200);
		expect(p2.body.page.total).toBe(499); // the current total after the decision
		expect(p2.body.items).toHaveLength(250);
		const ids1 = new Set(p1.body.items.map((r: any) => r.id));
		expect(p2.body.items.some((r: any) => ids1.has(r.id))).toBe(false);
		expect(p2.body.page.has_more).toBe(false);
	});

	test("inbox scope, bounds and cursors are validated server-side", async () => {
		const st = async (s: string) => (await c.get(`/inbox?${s}`)).status;
		expect(await st(q({ limit: 501 }))).toBe(400);
		expect(await st(q({ kind: "other" }))).toBe(400);
		expect(await st(q({ repo_id: "local/not-allowlisted" }))).toBe(422);
		expect(await st(q({ cursor: "%%%" }))).toBe(400);
		const pb = await c.get(`/inbox?${q({ repo_id: B, limit: 10 })}`);
		// B's cursor cannot be replayed against C or against the global scope
		expect(
			await st(q({ repo_id: C, limit: 10, cursor: pb.body.page.next_cursor })),
		).toBe(400);
		expect(await st(q({ limit: 10, cursor: pb.body.page.next_cursor }))).toBe(
			400,
		);
		// a history cursor is not an inbox cursor
		const hist = await c.get(`/task-history?${q({ repo_id: B, limit: 10 })}`);
		expect(
			await st(
				q({ repo_id: B, limit: 10, cursor: hist.body.page.next_cursor }),
			),
		).toBe(400);
		expect(H.providerSpawns()).toBe(0);
	});
});

describe("APP-P2-02 — Gate-2 requests in the paged inbox", () => {
	test("a result request is listed with its repository under kind=result; deciding it still needs its own challenge", async () => {
		const H = composedHub({ fixture: multiRepoFixture(["beta"]) });
		const c = await H.signIn();
		const [, B] = H.fx.repos.map((r) => r.id) as [string, string];
		const g1 = await approveGate1(c, H.fx, { title: "B result" }, B);
		const g2 = await waitGate2(c, g1.taskId);
		const page = await c.get(`/inbox?${q({ kind: "result" })}`);
		expect(page.status).toBe(200);
		expect(page.body.items).toHaveLength(1);
		expect(page.body.items[0]).toMatchObject({
			id: g2.id,
			kind: "result",
			repo_id: B,
			binding_hash: g2.binding_hash,
		});
		const ch = await issueChallenge(c, g2);
		expect((await decide(c, g2, decisionBody(g2, ch, "accept"))).status).toBe(
			201,
		);
		const after = await c.get(`/inbox?${q({ kind: "result" })}`);
		expect(after.body.page.total).toBe(0);
		expect(H.providerSpawns()).toBe(0);
	}, 60_000);
});

describe("T0-FINAL-P2-01 — each inbox scope's membership generation follows exactly its pending set", () => {
	let H: ComposedHub;
	let c: Client;
	let A: string;
	let B: string;
	const clock = new FakeClock();
	const gen = async (params: Record<string, string | number> = {}) => {
		const r = await c.get(`/inbox?${q(params)}`);
		expect(r.status).toBe(200);
		return r.body.page.membership_generation as string;
	};
	const scopes = async () => ({
		global: await gen(),
		a: await gen({ repo_id: A }),
		b: await gen({ repo_id: B }),
		run: await gen({ kind: "run" }),
		result: await gen({ kind: "result" }),
		aRun: await gen({ repo_id: A, kind: "run" }),
	});
	const total = async () => (await c.get(`/inbox?${q({})}`)).body.page.total;
	const reject = async (req: any) => {
		const ch = await issueChallenge(c, req);
		expect((await decide(c, req, decisionBody(req, ch, "reject"))).status).toBe(
			201,
		);
	};

	beforeAll(async () => {
		H = composedHub({
			manual: true,
			clock,
			fixture: multiRepoFixture(["beta"]),
		});
		c = await H.signIn();
		[A, B] = H.fx.repos.map((r) => r.id) as [string, string];
	});

	test("every inbox page and the snapshot carry it, history pages do not; repeated reads, continuation pages and a challenge keep it", async () => {
		clock.advance(1);
		const a1 = await openGate1(c, H.fx, { title: "A one" }, A);
		clock.advance(1);
		await openGate1(c, H.fx, { title: "A two" }, A);
		clock.advance(1);
		await openGate1(c, H.fx, { title: "B one" }, B);
		const g = await scopes();
		for (const v of Object.values(g))
			expect(v).toMatch(/^v1:[0-9a-f]{16}:\d+:\d+$/);
		// each scope has its own value, also where the counts are equal (global vs run, A vs A+run)
		expect(new Set(Object.values(g)).size).toBe(6);
		expect(g.global.endsWith(":3:3")).toBe(true);
		const snap = (await c.get("/snapshot")).body;
		expect(snap.pending_page.membership_generation).toBe(g.global);
		const p1 = await c.get(`/inbox?${q({ limit: 1 })}`);
		const p2 = await c.get(
			`/inbox?${q({ limit: 1, cursor: p1.body.page.next_cursor })}`,
		);
		expect(p1.body.page.membership_generation).toBe(g.global);
		expect(p2.body.page.membership_generation).toBe(g.global);
		const hist = await c.get(`/task-history?${q({ repo_id: A })}`);
		expect(hist.status).toBe(200);
		expect("membership_generation" in hist.body.page).toBe(false);
		expect(await scopes()).toEqual(g);
		await issueChallenge(c, a1.req); // the request changes (rev 2); the pending set does not
		expect(await scopes()).toEqual(g);
	});

	test("same-total replacement in one repository and gate changes exactly the scopes that hold it", async () => {
		const before = await scopes();
		const n = await total();
		const [x] = (await c.get(`/inbox?${q({ repo_id: A })}`)).body.items;
		await reject(x);
		clock.advance(1);
		await openGate1(c, H.fx, { title: "A replacement" }, A);
		expect(await total()).toBe(n);
		const after = await scopes();
		expect(after.global).not.toBe(before.global);
		expect(after.a).not.toBe(before.a);
		expect(after.run).not.toBe(before.run);
		expect(after.aRun).not.toBe(before.aRun);
		expect(after.b).toBe(before.b);
		expect(after.result).toBe(before.result);
	});

	test("an opening and a closing each move it; it never returns to an earlier value", async () => {
		const seen = [await gen()];
		clock.advance(1);
		const y = await openGate1(c, H.fx, { title: "Opened, then closed" }, B);
		seen.push(await gen());
		await reject(y.req);
		seen.push(await gen());
		expect(new Set(seen).size).toBe(3);
		expect(H.providerSpawns()).toBe(0);
	});
});
