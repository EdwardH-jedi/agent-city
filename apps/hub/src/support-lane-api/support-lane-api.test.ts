// biome-ignore-all lint/suspicious/noExplicitAny: raw HTTP bodies and SQLite rows are inspected on purpose
// Support-lane persistence (migration 011, store) and the read-only support API behind the workspace guard (real
// startHub composition). The API records and shows informational jobs only: nothing here may start one, create a
// managed task / workspace task / approval request, launch a provider or touch Git.
import type { Database } from "bun:sqlite";
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
import {
	createSupportJobStore,
	decodeStoredFlag,
	SupportStoreIntegrityError,
} from "./store.ts";

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

// ── SUPPORT-P2-01: a persisted flag is exactly 0 or 1; anything else is corruption, never a legitimate boolean ──

/** Out-of-band damage the CHECK constraints would refuse; the triggers stay installed. */
function corrupt(db: Database, sql: string, args: (string | number)[]) {
	db.run("PRAGMA ignore_check_constraints = ON");
	try {
		db.run(sql, args);
	} finally {
		db.run("PRAGMA ignore_check_constraints = OFF");
	}
}
const rawRow = (db: Database, id: string) =>
	db
		.query(
			"SELECT status, disabled, cancel_requested, result, rev FROM support_jobs WHERE id = ?",
		)
		.get(id) as Record<string, unknown> | null;
const SETTLE = (id: string) =>
	({
		artifact_id: `${id}.artifact`,
		artifact_kind: "REPO_STATUS",
		text_chars: 0,
	}) as const;
function withFileDb(fn: (path: string) => void | Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "agentcity-support-"));
	const done = () => rmSync(dir, { recursive: true, force: true });
	try {
		const out = fn(join(dir, "hub.db"));
		if (out instanceof Promise) return out.finally(done);
		done();
	} catch (err) {
		done();
		throw err;
	}
}
function mkJob(
	store: ReturnType<typeof createSupportJobStore>,
	key: string,
	s: number,
	over: Record<string, unknown> = {},
): string {
	const r = store.create({
		created_by: "op",
		idempotency_key: key,
		request: req(over),
		now: at(s),
	});
	if (!r.ok) throw new Error("create");
	return r.record.job.id;
}
const EVERYTHING = { repo_id: null, status: null, limit: 10, before_seq: null };

describe("SUPPORT-P2-01 — a stored flag is 0 or 1; anything else fails closed", () => {
	test("the shared decoder accepts only the canonical 0 / 1", () => {
		expect(decodeStoredFlag(0)).toBe(false);
		expect(decodeStoredFlag(1)).toBe(true);
		for (const v of [
			2,
			-1,
			0.5,
			Number.NaN,
			"0",
			"1",
			"true",
			true,
			false,
			null,
			undefined,
			0n,
			1n,
			{},
			[],
		])
			expect(() => decodeStoredFlag(v)).toThrow();
	});

	test("cancel_requested = 2 after a restart: get, list, cancel and every transition refuse; nothing settles COMPLETED", () =>
		withFileDb((path) => {
			const db1 = openDb(path);
			const s1 = createSupportJobStore(db1);
			const intact = mkJob(s1, "key-p201-ok00", 0);
			const running = mkJob(s1, "key-p201-run0", 1);
			expect(s1.transition(running, 1, startSupportJob, at(2)).ok).toBe(true);
			expect(s1.cancel(running, 2, at(3)).ok).toBe(true); // rev 3, intent recorded
			corrupt(
				db1,
				"UPDATE support_jobs SET cancel_requested = 2, rev = rev + 1 WHERE id = ?",
				[running],
			);
			db1.close();
			const db2 = openDb(path);
			const s2 = createSupportJobStore(db2);
			expect(() => s2.get(running)).toThrow(SupportStoreIntegrityError);
			expect(() => s2.list(EVERYTHING)).toThrow(SupportStoreIntegrityError);
			expect(() =>
				s2.list({ ...EVERYTHING, repo_id: REPO, status: "RUNNING" }),
			).toThrow(SupportStoreIntegrityError);
			for (const step of [
				(j: any) => completeSupportJob(j, SETTLE(j.id)),
				(j: any) =>
					failSupportJob(j, { classification: "EXECUTOR_ERROR", detail: "" }),
				startSupportJob,
			])
				expect(() => s2.transition(running, 4, step, at(4))).toThrow(
					SupportStoreIntegrityError,
				);
			expect(() => s2.cancel(running, 4, at(4))).toThrow(
				SupportStoreIntegrityError,
			);
			// never rewritten as a legitimate job, never settled COMPLETED, the intent is not erased
			expect(rawRow(db2, running)).toEqual({
				status: "RUNNING",
				disabled: 0,
				cancel_requested: 2,
				result: null,
				rev: 4,
			});
			// an intact job beside it is still served
			expect(s2.get(intact)?.job.status).toBe("QUEUED");
			db2.close();
		}));

	test("disabled = 2 after a restart: get, list and every transition refuse; the row is untouched", () =>
		withFileDb((path) => {
			const db1 = openDb(path);
			const s1 = createSupportJobStore(db1);
			const source = mkJob(s1, "key-p201-src0", 0);
			corrupt(
				db1,
				`INSERT INTO support_jobs SELECT 'sj-corrupt-disabled', 99, created_by, 'key-p201-dis0', request_hash,
				   repo_id, kind, capability, inputs, brief, priority, 'QUEUED', 2, 0, NULL, NULL, NULL, created_at,
				   updated_at, 1 FROM support_jobs WHERE id = ?`,
				[source],
			);
			db1.close();
			const db2 = openDb(path);
			const s2 = createSupportJobStore(db2);
			const id = "sj-corrupt-disabled";
			expect(() => s2.get(id)).toThrow(SupportStoreIntegrityError);
			expect(() => s2.list(EVERYTHING)).toThrow(SupportStoreIntegrityError);
			for (const step of [
				startSupportJob,
				(j: any) => assignSupportProfile(j, "fast-clerk"),
			])
				expect(() => s2.transition(id, 1, step, at(1))).toThrow(
					SupportStoreIntegrityError,
				);
			expect(() => s2.cancel(id, 1, at(1))).toThrow(SupportStoreIntegrityError);
			expect(rawRow(db2, id)).toEqual({
				status: "QUEUED",
				disabled: 2,
				cancel_requested: 0,
				result: null,
				rev: 1,
			});
			expect(s2.get(source)?.job.disabled).toBe(false);
			db2.close();
		}));

	test("canonical 0 / 1 round-trip exactly; a cancelled job and a recorded cancel intent survive close / reopen and settle CANCELLED", () =>
		withFileDb((path) => {
			const db1 = openDb(path);
			const s1 = createSupportJobStore(db1);
			const off = mkJob(s1, "key-p201-off0", 0, { disabled: false });
			const on = mkJob(s1, "key-p201-on00", 1, { disabled: true });
			const cancelled = mkJob(s1, "key-p201-can0", 2);
			const intent = mkJob(s1, "key-p201-int0", 3);
			expect(s1.cancel(cancelled, 1, at(4)).ok).toBe(true);
			expect(s1.transition(intent, 1, startSupportJob, at(5)).ok).toBe(true);
			expect(s1.cancel(intent, 2, at(6)).ok).toBe(true);
			db1.close();
			const db2 = openDb(path);
			const s2 = createSupportJobStore(db2);
			expect(s2.get(off)?.job.disabled).toBe(false);
			expect(s2.get(on)?.job.disabled).toBe(true);
			expect(rawRow(db2, on)?.disabled).toBe(1);
			expect(s2.get(cancelled)?.job).toMatchObject({
				status: "CANCELLED",
				cancel_requested: false,
			});
			expect(s2.get(intent)).toMatchObject({
				rev: 3,
				job: { status: "RUNNING", cancel_requested: true },
			});
			expect(rawRow(db2, intent)?.cancel_requested).toBe(1);
			// the surviving intent wins over a completed output: the job ends CANCELLED, never COMPLETED
			const settled = s2.transition(
				intent,
				3,
				(j) => completeSupportJob(j, SETTLE(j.id)),
				at(7),
			);
			expect(settled.ok && settled.record.job.status).toBe("CANCELLED");
			expect(rawRow(db2, intent)).toMatchObject({
				status: "CANCELLED",
				result: null,
			});
			db2.close();
		}));

	test("HTTP after a restart: GET, list and cancel of a corrupted row answer the fixed 500; nothing is written", async () => {
		const H = realHub();
		const op = await H.signIn();
		const made = await op.post("/support-jobs", {
			idempotency_key: "p201-http-0001",
			job: req({ repo_id: H.fx.repoId }),
		});
		expect(made.status).toBe(201);
		const id = made.body.job.id as string;
		const store = createSupportJobStore(H.db);
		expect(store.transition(id, 1, startSupportJob, at(1)).ok).toBe(true);
		expect(
			(await op.post(`/support-jobs/${id}/cancel`, { expected_rev: 2 })).body
				.job.cancel_requested,
		).toBe(true);
		corrupt(
			H.db,
			"UPDATE support_jobs SET cancel_requested = 2, rev = rev + 1 WHERE id = ?",
			[id],
		);
		await H.stop();
		const H2 = realHub({ reuse: H.fx });
		const op2 = await H2.signIn();
		const fixed = { error: "internal error" };
		for (const r of [
			await op2.get(`/support-jobs/${id}`),
			await op2.get("/support-jobs"),
			await op2.get("/support-jobs?status=RUNNING"),
			await op2.post(`/support-jobs/${id}/cancel`, { expected_rev: 4 }),
		]) {
			expect(r.status).toBe(500);
			expect(r.body).toEqual(fixed);
		}
		expect(rawRow(H2.db, id)).toEqual({
			status: "RUNNING",
			disabled: 0,
			cancel_requested: 2,
			result: null,
			rev: 4,
		});
		await H2.stop();
	}, 60_000);
});

// ── SUPPORT-P2-02: the CURRENT allowlist governs every support route, not the one a job was created under ──

describe("SUPPORT-P2-02 — the current allowlist governs every support route", () => {
	test("store scope: a job outside it is not found for get / cancel / transition (before the rev check) and absent from list", () => {
		const OTHER = "local/other-fixture";
		const db = openDb(":memory:");
		const all = createSupportJobStore(db);
		const a = mkJob(all, "key-p202-a000", 0);
		const b = mkJob(all, "key-p202-b000", 1, { repo_id: OTHER });
		const scoped = createSupportJobStore(db, { repos: [OTHER] });
		expect(scoped.get(a)).toBeNull();
		for (const rev of [1, 99])
			expect(scoped.cancel(a, rev, at(2))).toEqual({
				ok: false,
				error: "not_found",
			});
		expect(scoped.transition(a, 1, startSupportJob, at(2))).toEqual({
			ok: false,
			error: "not_found",
		});
		const page = scoped.list(EVERYTHING);
		expect(page.records.map((r) => r.job.id)).toEqual([b]);
		expect(page.total).toBe(1);
		expect(page.has_more).toBe(false);
		expect(scoped.list({ ...EVERYTHING, repo_id: REPO }).total).toBe(0);
		expect(scoped.get(b)?.job.repo_id).toBe(OTHER);
		// an out-of-scope row is never decoded: damaged, it stays hidden (not served, not 500)
		corrupt(
			db,
			"UPDATE support_jobs SET cancel_requested = 2, rev = rev + 1 WHERE id = ?",
			[a],
		);
		expect(scoped.get(a)).toBeNull();
		expect(scoped.list(EVERYTHING).total).toBe(1);
		expect(scoped.cancel(a, 2, at(3))).toEqual({
			ok: false,
			error: "not_found",
		});
		// an empty scope hides everything; nothing was deleted
		const none = createSupportJobStore(db, { repos: [] });
		expect(none.get(b)).toBeNull();
		expect(none.list(EVERYTHING).total).toBe(0);
		expect(
			(db.query("SELECT count(*) AS n FROM support_jobs").get() as any).n,
		).toBe(2);
		db.close();
	});

	test("repository removed (restart): create 422, GET / cancel 404 like an unknown id, absent from the global list, filtered list 422; other repositories unaffected; re-allowing restores read-only visibility", async () => {
		const OTHER = "local/retained-fixture";
		const H = realHub({
			fixture: { extraRepos: [{ id: OTHER, label: "retained" }] },
		});
		const op = await H.signIn();
		const mk = async (key: string, repo: string) => {
			const r = await op.post("/support-jobs", {
				idempotency_key: key,
				job: req({ repo_id: repo }),
			});
			expect(r.status).toBe(201);
			return r.body.job.id as string;
		};
		const gone = await mk("p202-gone-0001", H.fx.repoId);
		const kept = await mk("p202-kept-0001", OTHER);
		const AUTHORITY = [
			"managed_tasks",
			"workspace_tasks",
			"managed_approval_requests",
			"managed_runs",
		];
		const authority = (db: Database) =>
			AUTHORITY.map(
				(t) =>
					(db.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n,
			);
		const before = authority(H.db);
		await H.stop();
		const without = (repo: string) => ({
			...H.fx,
			config: {
				...H.fx.config,
				repos: H.fx.config.repos.filter((r) => r.id !== repo),
			},
		});
		const ids = (r: any) => r.body.items.map((x: any) => x.job.id);

		const H2 = realHub({ reuse: without(H.fx.repoId) });
		const op2 = await H2.signIn();
		// A: create (and replay of the original key) for the removed repository
		for (const key of ["p202-gone-0002", "p202-gone-0001"]) {
			const r = await op2.post("/support-jobs", {
				idempotency_key: key,
				job: req({ repo_id: H.fx.repoId }),
			});
			expect(r.status).toBe(422);
			expect(r.body.error).toBe("repo_not_allowed");
		}
		// B: GET answers exactly like an id that never existed
		const unknown = "sj-00000000-0000-4000-8000-000000000000";
		const missing = await op2.get(`/support-jobs/${unknown}`);
		const hidden = await op2.get(`/support-jobs/${gone}`);
		expect(missing.status).toBe(404);
		expect(hidden.status).toBe(404);
		expect(hidden.body).toEqual(missing.body);
		// C: the global list (with or without a status filter) does not expose it
		const list = await op2.get("/support-jobs");
		expect(ids(list)).toEqual([kept]);
		expect(list.body.page).toMatchObject({
			total: 1,
			returned: 1,
			complete: true,
		});
		expect(ids(await op2.get("/support-jobs?status=QUEUED"))).toEqual([kept]);
		// D: filtered list for the removed repository
		const filtered = await op2.get(
			`/support-jobs?repo_id=${encodeURIComponent(H.fx.repoId)}`,
		);
		expect(filtered.status).toBe(422);
		expect(filtered.body.error).toBe("repo_not_allowed");
		// E: cancel — current or stale revision — answers like an unknown id (no 409 confirms it exists)
		const cancelMissing = await op2.post(`/support-jobs/${unknown}/cancel`, {
			expected_rev: 1,
		});
		for (const rev of [1, 7]) {
			const r = await op2.post(`/support-jobs/${gone}/cancel`, {
				expected_rev: rev,
			});
			expect(r.status).toBe(404);
			expect(r.body).toEqual(cancelMissing.body);
		}
		// F: there is no other mutation route
		for (const action of ["start", "run", "complete", "fail"])
			expect(
				(await op2.post(`/support-jobs/${gone}/${action}`, {})).status,
			).toBe(404);
		// G: the job is still durably stored, unchanged
		expect(rawRow(H2.db, gone)).toMatchObject({ status: "QUEUED", rev: 1 });
		// other allowed repositories keep working
		expect((await op2.get(`/support-jobs/${kept}`)).status).toBe(200);
		const keptCancel = await op2.post(`/support-jobs/${kept}/cancel`, {
			expected_rev: 1,
		});
		expect(keptCancel.status).toBe(200);
		expect(keptCancel.body).toMatchObject({
			rev: 2,
			job: { status: "CANCELLED" },
		});
		await H2.stop();

		// switching the allowlist the other way hides the other repository's jobs instead (no leak either way)
		const H3 = realHub({ reuse: without(OTHER) });
		const op3 = await H3.signIn();
		expect((await op3.get(`/support-jobs/${kept}`)).status).toBe(404);
		expect(
			(await op3.post(`/support-jobs/${kept}/cancel`, { expected_rev: 2 }))
				.status,
		).toBe(404);
		expect(ids(await op3.get("/support-jobs"))).toEqual([gone]);
		expect(
			(await op3.get(`/support-jobs?repo_id=${encodeURIComponent(OTHER)}`))
				.status,
		).toBe(422);
		await H3.stop();

		// H: re-allowing (the original config) restores read-only visibility, deterministically; nothing executed
		for (let boot = 0; boot < 2; boot++) {
			const H4 = realHub({ reuse: H.fx });
			const op4 = await H4.signIn();
			expect((await op4.get(`/support-jobs/${gone}`)).body).toMatchObject({
				rev: 1,
				job: { status: "QUEUED", repo_id: H.fx.repoId },
			});
			expect(ids(await op4.get("/support-jobs"))).toEqual([kept, gone]);
			expect(authority(H4.db)).toEqual(before);
			expect(H4.providerSpawns()).toBe(0);
			await H4.stop();
		}
	}, 60_000);
});

// ── stored lookup columns and the request hash must agree with the decoded row (independent review, attempt 1) ──

/** Rewrite one immutable column around the update trigger (restored right after), CHECKs ignored. */
function tamper(db: Database, id: string, column: string, value: string) {
	const trigger = (
		db
			.query(
				"SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'support_jobs_update_rules'",
			)
			.get() as { sql: string }
	).sql;
	db.run("DROP TRIGGER support_jobs_update_rules");
	try {
		corrupt(db, `UPDATE support_jobs SET ${column} = ? WHERE id = ?`, [
			value,
			id,
		]);
	} finally {
		db.run(trigger);
	}
}
const fullRow = (db: Database, id: string) =>
	db.query("SELECT * FROM support_jobs WHERE id = ?").get(id);

describe("stored metadata — a malformed or inconsistent row fails closed on every path", () => {
	test("store: a malformed request_hash / created_by / idempotency_key, or a request column that drifted from the hash, is an integrity error", () => {
		const cases: [string, string][] = [
			["request_hash", "x"],
			["request_hash", "A".repeat(64)],
			["created_by", ""],
			["created_by", "o".repeat(201)],
			// SQLite length() stops at the first NUL: SQL length 0 / 7, JS length 1 / 14 (independent review, attempt 2)
			["created_by", "\u0000"],
			["idempotency_key", "1234567\u0000suffix"],
			["idempotency_key", "short"],
			["repo_id", "local/other-fixture"],
			["priority", "7"],
		];
		for (const [column, value] of cases) {
			const { db, store } = fresh();
			const id = mkJob(store, "key-meta-0000", 0);
			const intact = mkJob(store, "key-meta-0001", 1);
			tamper(db, id, column, value);
			const before = fullRow(db, id);
			expect(() => store.get(id)).toThrow(SupportStoreIntegrityError);
			expect(() => store.list(EVERYTHING)).toThrow(SupportStoreIntegrityError);
			expect(() => store.cancel(id, 1, at(2))).toThrow(
				SupportStoreIntegrityError,
			);
			expect(() => store.transition(id, 1, startSupportJob, at(2))).toThrow(
				SupportStoreIntegrityError,
			);
			expect(fullRow(db, id)).toEqual(before);
			expect(store.get(intact)?.job.status).toBe("QUEUED");
			db.close();
		}
	});

	test("store: an idempotent replay never returns a row whose request drifted from its hash, nor one outside the scope", () => {
		const OTHER = "local/other-fixture";
		const { db, store } = fresh();
		const id = mkJob(store, "key-meta-0002", 0);
		tamper(db, id, "repo_id", OTHER);
		const replay = () =>
			store.create({
				created_by: "op",
				idempotency_key: "key-meta-0002",
				request: req(),
				now: at(1),
			});
		expect(replay).toThrow(SupportStoreIntegrityError);
		// a malformed prior hash is an integrity error too — not an idempotency conflict
		const hashed = mkJob(store, "key-meta-0004", 2);
		tamper(db, hashed, "request_hash", "x");
		expect(() =>
			store.create({
				created_by: "op",
				idempotency_key: "key-meta-0004",
				request: req(),
				now: at(3),
			}),
		).toThrow(SupportStoreIntegrityError);
		// a scoped store refuses a request outside its scope before it looks at any prior row
		const scoped = createSupportJobStore(db, { repos: [OTHER] });
		const out = scoped.create({
			created_by: "op",
			idempotency_key: "key-meta-0003",
			request: req(),
			now: at(1),
		});
		expect(out.ok).toBe(false);
		expect(
			(db.query("SELECT count(*) AS n FROM support_jobs").get() as any).n,
		).toBe(2);
		db.close();
	});

	test("HTTP after a restart: a malformed hash answers the fixed 500 on GET / list / cancel and nothing is written; a repo_id drifted to a removed repository stays hidden and its replay is the fixed 500, never the job", async () => {
		const A = "local/still-allowed-fixture";
		const B = "local/to-remove-fixture";
		const H = realHub({
			fixture: {
				extraRepos: [
					{ id: A, label: "allowed" },
					{ id: B, label: "removed" },
				],
			},
		});
		const op = await H.signIn();
		const hashBody = { idempotency_key: "meta-hash-0001", job: req() };
		const driftBody = {
			idempotency_key: "meta-drift-0001",
			job: req({ repo_id: A }),
		};
		const hashed = (await op.post("/support-jobs", hashBody)).body.job
			.id as string;
		const drifted = (await op.post("/support-jobs", driftBody)).body.job
			.id as string;
		tamper(H.db, hashed, "request_hash", "x");
		tamper(H.db, drifted, "repo_id", B);
		const before = [fullRow(H.db, hashed), fullRow(H.db, drifted)];
		await H.stop();
		const H2 = realHub({
			reuse: {
				...H.fx,
				config: {
					...H.fx.config,
					repos: H.fx.config.repos.filter((r) => r.id !== B),
				},
			},
		});
		const op2 = await H2.signIn();
		const fixed = { error: "internal error" };
		for (const r of [
			await op2.get(`/support-jobs/${hashed}`),
			await op2.get("/support-jobs"),
			await op2.post(`/support-jobs/${hashed}/cancel`, { expected_rev: 1 }),
			await op2.post("/support-jobs", hashBody),
			await op2.post("/support-jobs", driftBody),
		]) {
			expect(r.status).toBe(500);
			expect(r.body).toEqual(fixed);
		}
		expect((await op2.get(`/support-jobs/${drifted}`)).status).toBe(404);
		expect(
			(await op2.post(`/support-jobs/${drifted}/cancel`, { expected_rev: 1 }))
				.status,
		).toBe(404);
		expect(
			(await op2.get(`/support-jobs?repo_id=${encodeURIComponent(B)}`)).status,
		).toBe(422);
		expect([fullRow(H2.db, hashed), fullRow(H2.db, drifted)]).toEqual(before);
		expect(H2.providerSpawns()).toBe(0);
		await H2.stop();
	}, 60_000);
});
