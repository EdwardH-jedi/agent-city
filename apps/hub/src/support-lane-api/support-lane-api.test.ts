// biome-ignore-all lint/suspicious/noExplicitAny: raw HTTP bodies and SQLite rows are inspected on purpose
// Support-lane persistence (migration 011, store) and the read-only support API behind the workspace guard (real
// startHub composition). The API records and shows informational jobs only: nothing here may start one, create a
// managed task / workspace task / approval request, launch a provider or touch Git.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertIsolation,
	BASE,
	http,
	realHub,
	teardown,
} from "../../test/workspace-m1-adversarial/harness.ts";
import { openDb } from "../db.ts";
import {
	assignSupportProfile,
	completeSupportJob,
	failSupportJob,
	startSupportJob,
} from "../support-jobs/state.ts";
import { createSupportJobStore, SupportStoreIntegrityError } from "./store.ts";

assertIsolation();
afterAll(() => teardown());

const T0 = new Date("2026-10-07T03:00:00.000Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const REPO = "local/fixture";
const req = (over: Record<string, unknown> = {}) => ({
	repo_id: REPO,
	kind: "REPO_STATUS",
	capability: "fast",
	...over,
});

function fresh() {
	const db = openDb(":memory:");
	return { db, store: createSupportJobStore(db) };
}

describe("migration 011 — the database keeps support jobs honest on its own", () => {
	test("insert shape, no delete, terminal immutability, legal transitions only, immutable request columns", () => {
		const { db, store } = fresh();
		const a = store.create({
			created_by: "op",
			idempotency_key: "key-0000-a",
			request: req(),
			now: at(0),
		});
		if (!a.ok) throw new Error("create");
		const id = a.record.job.id;
		const sql =
			(s: string, ...p: any[]) =>
			() =>
				db.run(s, p);
		expect(sql("DELETE FROM support_jobs WHERE id = ?", id)).toThrow(
			/never deleted/,
		);
		expect(
			sql(
				"UPDATE support_jobs SET status = 'COMPLETED', result = '{}', rev = rev + 1 WHERE id = ?",
				id,
			),
		).toThrow(/illegal status transition/);
		expect(
			sql(
				"UPDATE support_jobs SET kind = 'HANDOFF', rev = rev + 1 WHERE id = ?",
				id,
			),
		).toThrow(/immutable/);
		expect(
			sql("UPDATE support_jobs SET priority = 1 WHERE id = ?", id),
		).toThrow(/rev must grow/);
		expect(
			sql(
				"INSERT INTO support_jobs SELECT 'sj-x', 99, created_by, 'key-0000-x', request_hash, repo_id, kind, capability, inputs, brief, priority, 'RUNNING', disabled, 0, NULL, NULL, NULL, created_at, updated_at, 1 FROM support_jobs WHERE id = ?",
				id,
			),
		).toThrow(/starts QUEUED/);
		expect(store.cancel(id, 1, at(1)).ok).toBe(true);
		expect(
			sql(
				"UPDATE support_jobs SET status = 'RUNNING', rev = rev + 1 WHERE id = ?",
				id,
			),
		).toThrow(/terminal job never changes/);
		db.close();
	});
});

describe("store — create, idempotency, fail-closed reads, keyset paging", () => {
	test("create assigns identity and order; the same key replays; a different request under it conflicts", () => {
		const { db, store } = fresh();
		const a = store.create({
			created_by: "op",
			idempotency_key: "key-0000-a",
			request: req(),
			now: at(0),
		});
		const b = store.create({
			created_by: "op",
			idempotency_key: "key-0000-b",
			request: req({ kind: "HANDOFF" }),
			now: at(1),
		});
		if (!a.ok || !b.ok) throw new Error("create");
		expect(a).toMatchObject({
			created: true,
			record: {
				rev: 1,
				job: { status: "QUEUED", created_seq: 0, profile_id: null },
			},
		});
		expect(b.record.job.created_seq).toBe(1);
		expect(a.record.job.id).toMatch(/^sj-[0-9a-f-]{36}$/);
		const replay = store.create({
			created_by: "op",
			idempotency_key: "key-0000-a",
			request: req(),
			now: at(5),
		});
		expect(replay).toMatchObject({
			ok: true,
			created: false,
			record: { job: { id: a.record.job.id } },
		});
		expect(
			store.create({
				created_by: "op",
				idempotency_key: "key-0000-a",
				request: req({ priority: 1 }),
				now: at(6),
			}),
		).toEqual({ ok: false, error: "idempotency_conflict" });
		// the key is per operator
		const other = store.create({
			created_by: "op2",
			idempotency_key: "key-0000-a",
			request: req(),
			now: at(7),
		});
		expect(other.ok && other.created).toBe(true);
		// the pure core still decides what a valid request is (no authority keys, required refs)
		const bad = store.create({
			created_by: "op",
			idempotency_key: "key-0000-c",
			request: { ...req(), command: "rm -rf /" },
			now: at(8),
		});
		expect(bad.ok).toBe(false);
		const refs = store.create({
			created_by: "op",
			idempotency_key: "key-0000-d",
			request: req({ kind: "PR_DRAFT" }),
			now: at(9),
		});
		expect(refs).toMatchObject({ ok: false, error: "invalid_request" });
		expect(store.get(a.record.job.id)?.job).toEqual(a.record.job);
		expect(store.get("missing-id")).toBeNull();
		expect(store.get("../etc/passwd")).toBeNull();
		db.close();
	});

	test("a stored row that no longer validates is an integrity error, never a job", () => {
		const { db, store } = fresh();
		const a = store.create({
			created_by: "op",
			idempotency_key: "key-0000-a",
			request: req(),
			now: at(0),
		});
		if (!a.ok) throw new Error("create");
		// raw insert around the store: a PR_DRAFT without its required commit reference
		db.run(
			"INSERT INTO support_jobs (id, created_seq, created_by, idempotency_key, request_hash, repo_id, kind, capability, inputs, brief, priority, status, disabled, cancel_requested, created_at, updated_at, rev) VALUES ('sj-raw', 7, 'op', 'key-0000-raw', ?, ?, 'PR_DRAFT', 'fast', '[]', NULL, 50, 'QUEUED', 0, 0, ?, ?, 1)",
			["a".repeat(64), REPO, T0.toISOString(), T0.toISOString()],
		);
		expect(() => store.get("sj-raw")).toThrow(SupportStoreIntegrityError);
		expect(() =>
			store.list({ repo_id: null, status: null, limit: 10, before_seq: null }),
		).toThrow(SupportStoreIntegrityError);
		db.close();
	});

	test("newest first, keyset continuation, filters, totals", () => {
		const { db, store } = fresh();
		for (let i = 0; i < 5; i++)
			store.create({
				created_by: "op",
				idempotency_key: `key-0000-${i}`,
				request: req({ repo_id: i % 2 ? "local/other" : REPO }),
				now: at(i),
			});
		const p1 = store.list({
			repo_id: null,
			status: null,
			limit: 2,
			before_seq: null,
		});
		expect(p1.records.map((r) => r.job.created_seq)).toEqual([4, 3]);
		expect(p1).toMatchObject({ total: 5, has_more: true });
		const p2 = store.list({
			repo_id: null,
			status: null,
			limit: 2,
			before_seq: 3,
		});
		expect(p2.records.map((r) => r.job.created_seq)).toEqual([2, 1]);
		const p3 = store.list({
			repo_id: null,
			status: null,
			limit: 2,
			before_seq: 1,
		});
		expect(p3.records.map((r) => r.job.created_seq)).toEqual([0]);
		expect(p3.has_more).toBe(false);
		const repo = store.list({
			repo_id: REPO,
			status: null,
			limit: 10,
			before_seq: null,
		});
		expect(repo.records.map((r) => r.job.created_seq)).toEqual([4, 2, 0]);
		store.cancel(repo.records[0]?.job.id ?? "", 1, at(9));
		expect(
			store.list({
				repo_id: null,
				status: "CANCELLED",
				limit: 10,
				before_seq: null,
			}).total,
		).toBe(1);
		db.close();
	});

	test("a continuation never repeats or skips a job when newer jobs arrive between pages", () => {
		const { db, store } = fresh();
		const mk = (k: string, s: number) => {
			const r = store.create({
				created_by: "op",
				idempotency_key: k,
				request: req(),
				now: at(s),
			});
			if (!r.ok) throw new Error("create");
		};
		for (let i = 0; i < 5; i++) mk(`key-0000-${i}`, i);
		const q = { repo_id: null, status: null, limit: 2 };
		const p1 = store.list({ ...q, before_seq: null });
		expect(p1.records.map((r) => r.job.created_seq)).toEqual([4, 3]);
		mk("key-0000-late-a", 10);
		mk("key-0000-late-b", 11);
		const p2 = store.list({ ...q, before_seq: 3 });
		const p3 = store.list({ ...q, before_seq: 1 });
		expect(
			[...p1.records, ...p2.records, ...p3.records].map(
				(r) => r.job.created_seq,
			),
		).toEqual([4, 3, 2, 1, 0]);
		expect(p3.has_more).toBe(false);
		expect(p2.total).toBe(7); // the total reports "now"; the continuation itself stays stable
		db.close();
	});
});

describe("store — durable across a restart (file database)", () => {
	test("jobs, revisions, cancellation and settled results survive closing and reopening the database", () => {
		const dir = mkdtempSync(join(tmpdir(), "agentcity-support-"));
		const path = join(dir, "hub.db");
		try {
			const db1 = openDb(path);
			const s1 = createSupportJobStore(db1);
			const mk = (k: string, s: number) => {
				const r = s1.create({
					created_by: "op",
					idempotency_key: k,
					request: req(),
					now: at(s),
				});
				if (!r.ok) throw new Error("create");
				return r.record.job.id;
			};
			const queued = mk("key-0000-q", 0);
			const cancelled = mk("key-0000-c", 1);
			const done = mk("key-0000-d", 2);
			const running = mk("key-0000-r", 3);
			expect(s1.cancel(cancelled, 1, at(4)).ok).toBe(true);
			expect(s1.transition(done, 1, startSupportJob, at(5)).ok).toBe(true);
			const meta = {
				artifact_id: `${done}.artifact`,
				artifact_kind: "REPO_STATUS",
				text_chars: 10,
			} as const;
			expect(
				s1.transition(done, 2, (j) => completeSupportJob(j, meta), at(6)).ok,
			).toBe(true);
			expect(s1.transition(running, 1, startSupportJob, at(7)).ok).toBe(true);
			expect(s1.cancel(running, 2, at(8)).ok).toBe(true);
			const all = { repo_id: null, status: null, limit: 100, before_seq: null };
			const before = s1.list(all);
			db1.close();

			const db2 = openDb(path); // migrate() again: already at 11, nothing re-applied
			const s2 = createSupportJobStore(db2);
			expect(s2.list(all)).toEqual(before);
			expect(s2.get(queued)).toMatchObject({
				rev: 1,
				job: { status: "QUEUED" },
			});
			expect(s2.get(cancelled)).toMatchObject({
				rev: 2,
				updated_at: at(4).toISOString(),
				job: { status: "CANCELLED" },
			});
			expect(s2.get(done)).toMatchObject({
				rev: 3,
				job: { status: "COMPLETED", result: meta },
			});
			expect(s2.get(running)).toMatchObject({
				rev: 3,
				job: { status: "RUNNING", cancel_requested: true },
			});
			// identity, ordering and idempotency continue after the restart
			expect(
				s2.create({
					created_by: "op",
					idempotency_key: "key-0000-q",
					request: req(),
					now: at(9),
				}),
			).toMatchObject({
				ok: true,
				created: false,
				record: { job: { id: queued } },
			});
			const next = s2.create({
				created_by: "op",
				idempotency_key: "key-0000-n",
				request: req(),
				now: at(10),
			});
			expect(next.ok && next.record.job.created_seq).toBe(4);
			// a revision observed before the restart is stale now
			expect(s2.cancel(running, 2, at(11))).toEqual({
				ok: false,
				error: "stale_binding",
			});
			db2.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("store — state persistence under a rev compare-and-swap", () => {
	test("cancel: QUEUED → CANCELLED at once; stale rev refused; repeat is a no-op; terminal stays terminal", () => {
		const { db, store } = fresh();
		const a = store.create({
			created_by: "op",
			idempotency_key: "key-0000-a",
			request: req(),
			now: at(0),
		});
		if (!a.ok) throw new Error("create");
		const id = a.record.job.id;
		expect(store.cancel(id, 2, at(1))).toEqual({
			ok: false,
			error: "stale_binding",
		});
		const c = store.cancel(id, 1, at(1));
		expect(c).toMatchObject({
			ok: true,
			record: { rev: 2, job: { status: "CANCELLED" } },
		});
		expect(store.cancel(id, 2, at(2))).toMatchObject({
			ok: true,
			record: { rev: 2 },
		});
		expect(store.transition(id, 2, startSupportJob, at(3))).toEqual({
			ok: false,
			error: "invalid_state",
		});
		expect(store.cancel("sj-missing", 1, at(3))).toEqual({
			ok: false,
			error: "not_found",
		});
		db.close();
	});

	test("RUNNING: cancel sets the intent and the settling job ends CANCELLED; complete / fail / profile persist", () => {
		const { db, store } = fresh();
		const mk = (k: string) => {
			const r = store.create({
				created_by: "op",
				idempotency_key: k,
				request: req(),
				now: at(0),
			});
			if (!r.ok) throw new Error("create");
			return r.record.job.id;
		};
		const run = mk("key-0000-run");
		expect(
			store.transition(
				run,
				1,
				(j) => assignSupportProfile(j, "fast-clerk"),
				at(1),
			).ok,
		).toBe(true);
		expect(store.transition(run, 2, startSupportJob, at(2))).toMatchObject({
			ok: true,
			record: { rev: 3, job: { status: "RUNNING", profile_id: "fast-clerk" } },
		});
		expect(store.cancel(run, 3, at(3))).toMatchObject({
			ok: true,
			record: { rev: 4, job: { status: "RUNNING", cancel_requested: true } },
		});
		const meta = {
			artifact_id: `${run}.artifact`,
			artifact_kind: "REPO_STATUS",
			text_chars: 10,
		} as const;
		expect(
			store.transition(run, 4, (j) => completeSupportJob(j, meta), at(4)),
		).toMatchObject({
			ok: true,
			record: { job: { status: "CANCELLED", result: null } },
		});
		const ok = mk("key-0000-ok");
		store.transition(ok, 1, startSupportJob, at(5));
		const okMeta = { ...meta, artifact_id: `${ok}.artifact` };
		expect(
			store.transition(ok, 2, (j) => completeSupportJob(j, okMeta), at(6)),
		).toMatchObject({
			ok: true,
			record: { job: { status: "COMPLETED", result: okMeta } },
		});
		expect(store.get(ok)?.job.result).toEqual(okMeta);
		const bad = mk("key-0000-bad");
		store.transition(bad, 1, startSupportJob, at(7));
		const failure = {
			classification: "INVALID_OUTPUT",
			detail: "not a strict body",
		} as const;
		expect(
			store.transition(bad, 2, (j) => failSupportJob(j, failure), at(8)),
		).toMatchObject({
			ok: true,
			record: { job: { status: "FAILED", failure } },
		});
		expect(store.get(bad)?.job.failure).toEqual(failure);
		db.close();
	});
});

describe("support API — behind the workspace guard, read-only, no authority", () => {
	test("auth, scope, CSRF / Origin; create / replay / conflict / allowlist; get; bounded keyset list; cancel; nothing else moves", async () => {
		const H = realHub();
		const op = await H.signIn();
		const viewer = await H.signIn("viewer");
		const count = (t: string) =>
			(H.db.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
		const before = [
			"managed_tasks",
			"workspace_tasks",
			"managed_approval_requests",
			"managed_runs",
		].map(count);
		// guard: no session → 401; viewer reads but cannot write; a write needs CSRF and the exact Origin
		expect((await http(H.base, "GET", `${BASE}/support-jobs`)).status).toBe(
			401,
		);
		expect((await viewer.get("/support-jobs")).status).toBe(200);
		const body = { idempotency_key: "support-key-0001", job: req() };
		expect((await viewer.post("/support-jobs", body)).body.error).toBe(
			"forbidden_scope",
		);
		expect(
			(await op.post("/support-jobs", body, { csrf: null })).body.error,
		).toBe("csrf_invalid");
		expect(
			(await op.post("/support-jobs", body, { origin: "http://evil.example" }))
				.status,
		).toBe(403);
		// create / replay / conflict / validation / allowlist
		const created = await op.post("/support-jobs", body);
		expect(created.status).toBe(201);
		expect(created.headers.get("cache-control")).toBe("no-store");
		expect(created.body).toMatchObject({
			rev: 1,
			job: { status: "QUEUED", repo_id: H.fx.repoId, profile_id: null },
		});
		expect((await op.post("/support-jobs", body)).status).toBe(200);
		expect(
			(await op.post("/support-jobs", { ...body, job: req({ priority: 7 }) }))
				.body.error,
		).toBe("idempotency_conflict");
		expect(
			(
				await op.post("/support-jobs", {
					idempotency_key: "support-key-0002",
					job: req({ repo_id: "local/not-allowlisted" }),
				})
			).status,
		).toBe(422);
		expect(
			(
				await op.post("/support-jobs", {
					idempotency_key: "support-key-0003",
					job: { ...req(), argv: ["git", "push"] },
				})
			).status,
		).toBe(400);
		expect(
			(await op.post("/support-jobs", { idempotency_key: "short", job: req() }))
				.status,
		).toBe(400);
		const id = created.body.job.id as string;
		expect((await viewer.get(`/support-jobs/${id}`)).body.job.id).toBe(id);
		expect((await op.get("/support-jobs/sj-missing")).status).toBe(404);
		// bounded, keyset-paged list; a cursor is refused for any other scope
		for (let i = 0; i < 3; i++)
			expect(
				(
					await op.post("/support-jobs", {
						idempotency_key: `support-page-000${i}`,
						job: req({ kind: "HANDOFF" }),
					})
				).status,
			).toBe(201);
		const p1 = await op.get("/support-jobs?limit=2");
		expect(p1.body.page).toMatchObject({
			total: 4,
			returned: 2,
			has_more: true,
			complete: false,
		});
		const p2 = await op.get(
			`/support-jobs?limit=2&cursor=${p1.body.page.next_cursor}`,
		);
		expect(p2.body.page).toMatchObject({
			returned: 2,
			has_more: false,
			next_cursor: null,
		});
		const seen = [...p1.body.items, ...p2.body.items].map((x: any) => x.job.id);
		expect(new Set(seen).size).toBe(4);
		expect(
			(await op.get(`/support-jobs?limit=3&cursor=${p1.body.page.next_cursor}`))
				.status,
		).toBe(400);
		expect((await op.get("/support-jobs?limit=101")).status).toBe(400);
		expect((await op.get("/support-jobs?limit=2&limit=3")).status).toBe(400);
		expect((await op.get("/support-jobs?status=queued")).status).toBe(400);
		expect(
			(await op.get("/support-jobs?repo_id=local/not-allowlisted")).status,
		).toBe(422);
		expect(
			(
				await op.get(
					`/support-jobs?repo_id=${encodeURIComponent(H.fx.repoId)}&status=QUEUED`,
				)
			).body.page.total,
		).toBe(4);
		// cancellation persists; a stale revision is refused
		expect(
			(await op.post(`/support-jobs/${id}/cancel`, { expected_rev: 9 })).body
				.error,
		).toBe("stale_binding");
		const cancelled = await op.post(`/support-jobs/${id}/cancel`, {
			expected_rev: 1,
		});
		expect(cancelled.body).toMatchObject({
			rev: 2,
			job: { status: "CANCELLED" },
		});
		expect(
			(await viewer.post(`/support-jobs/${id}/cancel`, { expected_rev: 2 }))
				.body.error,
		).toBe("forbidden_scope");
		expect(
			(await op.get("/support-jobs?status=CANCELLED")).body.items.map(
				(x: any) => x.job.id,
			),
		).toEqual([id]);
		// no execution authority: nothing outside support_jobs changed, no provider ran, no other route appeared
		expect(
			[
				"managed_tasks",
				"workspace_tasks",
				"managed_approval_requests",
				"managed_runs",
			].map(count),
		).toEqual(before);
		expect(count("support_jobs")).toBe(4);
		for (const path of [
			`/support-jobs/${id}/start`,
			`/support-jobs/${id}/run`,
			`/support-jobs/${id}/complete`,
		])
			expect((await op.post(path, {})).status).toBe(404);
		expect(H.providerSpawns()).toBe(0);
	}, 60_000);
});
