// biome-ignore-all lint/suspicious/noExplicitAny: fake transport answers carry partial, untyped rows on purpose
// Final T0 repair (independent review 2fca4d29…, docs/workspace-m1/REVIEW_REPAIR_2026-10-05.md):
//   T0-RR-P2-01 — a delayed history / inbox page settles into the CURRENT collection and every fact confirmed
//                 while it was in flight (validity re-check, task read, committed receipt); it never restores
//                 the rows captured when it started.
//   T0-RR-P2-02 — the unfiltered inbox continuation continues exactly one snapshot membership; a newer
//                 snapshot showing another one (arrival after the end, a decision elsewhere, equal-total
//                 churn) drops it so new requests stay reachable and decided ones leave the pending display.
//   T0-RR-P3-01 — collection scope is structured: a legal repository id holding `|` keeps its exact scope.
//   T0-FINAL-P2-01 — a same-total replacement beyond the first page (same repository and gate) changes only
//                 the hub's membership generation; that alone drops the exhausted continuation.
// Production store + rendered views over the fixture transport; only collection pages, snapshots and reads
// are held / patched by the test (deterministic barriers, no timing). Nothing here decides anything except
// through the store's own gate path.
import { describe, expect, test } from "bun:test";
import {
	criteriaFromText,
	emptyDraft,
	type PageMeta,
	SNAPSHOT_INBOX_LIMIT,
	type WorkspaceTaskDetail,
} from "@agent-city/schema/workspace-m1";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	createFixtureTransport,
	type FixtureTransport,
} from "./fixture-transport.ts";
import { HqView } from "./HqView.tsx";
import { ProjectsView } from "./ProjectsView.tsx";
import { StoreContext } from "./parts.tsx";
import {
	historyKey,
	inboxKey,
	type KnownFacts,
	pendingMembership,
	reconcileHistoryPage,
	WorkspaceStore,
} from "./store.ts";
import type {
	HistoryQuery,
	InboxQuery,
	TransportResult,
	WorkspaceTransport,
} from "./transport.ts";

const REPO = "local/fixture";
const PIPE = "local/review|scope"; // a legal RepoId (schema / config accept it)
const PREFIX = "local/review"; // its prefix-confusable neighbour

interface Held<Q> {
	q: Q;
	resolve(r: TransportResult<any>): void;
}

const ok = <T>(data: T): TransportResult<T> => ({
	ok: true,
	status: 200,
	data,
});
const lost: TransportResult<never> = {
	ok: false,
	kind: "network",
	message: "No answer from the hub.",
};
const meta = (
	total: number,
	next: string | null,
	returned = 1,
	first = false,
): PageMeta => ({
	total,
	returned,
	complete: first && !next && returned === total,
	has_more: !!next,
	next_cursor: next,
	as_of: "2026-10-06T00:00:00.000Z",
});
const flush = async () => {
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

/**
 * The fixture transport with collection pages held (resolved by the test), snapshots patchable and task /
 * snapshot reads holdable — the production store does everything else.
 */
function harness() {
	// one deterministic clock for the fixture hub and the store: a re-check is always later than the read
	// it supersedes (the product orders validity by `checked_at`, ties → the incoming answer)
	let t = Date.parse("2026-10-06T00:00:00.000Z");
	const tx = createFixtureTransport({ now: () => t });
	const hist: Held<HistoryQuery>[] = [];
	const box: Held<InboxQuery>[] = [];
	let patch: ((s: any) => any) | null = null;
	let readHold: Promise<void> | null = null;
	const transport = {
		...tx,
		getSnapshot: async () => {
			if (readHold) await readHold;
			const r = await tx.getSnapshot();
			return r.ok && patch ? { ...r, data: patch(r.data) } : r;
		},
		getTask: async (id: string) => {
			if (readHold) await readHold;
			return tx.getTask(id);
		},
		getTaskHistory: (q: HistoryQuery) =>
			new Promise<TransportResult<any>>((resolve) => hist.push({ q, resolve })),
		getInbox: (q: InboxQuery) =>
			new Promise<TransportResult<any>>((resolve) => box.push({ q, resolve })),
	} as unknown as WorkspaceTransport;
	const store = new WorkspaceStore({
		transport,
		now: () => t,
		random: () => `settle-${Math.random().toString(36).slice(2)}`,
	});
	return {
		tx,
		store,
		hist,
		box,
		patchSnapshot(f: ((s: any) => any) | null) {
			patch = f;
		},
		/** Let fixture time pass (e.g. before a validity re-check). */
		tick(ms = 1000) {
			t += ms;
		},
		/** Hold every snapshot / task read until the returned release is called. */
		holdReads() {
			let open!: () => void;
			readHold = new Promise<void>((r) => {
				open = r;
			});
			return () => {
				readHold = null;
				open();
			};
		},
	};
}

async function signedIn(h: ReturnType<typeof harness>) {
	await h.store.boot();
	if (h.store.getState().auth.status !== "signed_in")
		await h.store.signIn("x".repeat(24));
	expect(h.store.getState().auth.status).toBe("signed_in");
	return h;
}

const render = (store: WorkspaceStore, view: "hq" | "projects") =>
	renderToStaticMarkup(
		createElement(
			StoreContext.Provider,
			{ value: { store, state: store.getState() } },
			createElement(view === "hq" ? HqView : ProjectsView),
		),
	);
const inboxSection = (html: string) =>
	html.match(/<section aria-label="Approval inbox"[\s\S]*?<\/section>/)?.[0] ??
	"";
const historySection = (html: string) =>
	html.match(
		/<section aria-label="Repository history"[\s\S]*?<\/section>/,
	)?.[0] ?? "";
const rowsIn = (html: string, attr: string) =>
	(html.match(new RegExp(`${attr}="`, "g")) ?? []).length;

/** One accepted task's list row three times, its validity checks sharing one instant (T0-SAME-P2-01). */
function sameInstant() {
	const at = "2026-10-06T00:00:00.000Z";
	const row = (status: "valid" | "invalid" | "unverifiable") =>
		({
			task: { id: "wst-00000000-0000-4000-8000-00000000d001", rev: 7 },
			phase: "accepted",
			engine: null,
			latest_request: null,
			acceptance_validity: {
				decision_id: "wsd-00000000-0000-4000-8000-00000000d001",
				status,
				reason:
					status === "invalid"
						? "bundle_missing"
						: status === "unverifiable"
							? "legacy_no_durable_evidence"
							: null,
				detail: null,
				checked_at: at,
				first_invalid_at: status === "invalid" ? at : null,
				evidence_bundle_digest: null,
			},
		}) as any;
	return {
		validAt: row("valid"),
		invalidAt: row("invalid"),
		unverifiableAt: row("unverifiable"),
	};
}

let keyN = 0;
async function makeTask(tx: FixtureTransport, repo: string, title: string) {
	const c = await tx.createTask({
		idempotency_key: `settle-create-${++keyN}`,
		repo_id: repo,
		draft: {
			...emptyDraft(),
			title,
			objective: `Objective of ${title}`,
			criteria: criteriaFromText("Build passes"),
			scope: { allowed: ["."], protected: [] },
			criterion_checks: [{ criterion: "Build passes", checks: ["unit"] }],
		},
	});
	if (!c.ok) throw new Error("create");
	const p = await tx.publishProposal(c.data.task.id, {
		expected_rev: c.data.task.rev,
	});
	if (!p.ok) throw new Error("publish");
	const req = p.data.approval_requests[0];
	if (!req) throw new Error("request");
	return { taskId: c.data.task.id, requestId: req.id };
}

/** Open one request's gate through the store (challenge issued, exact signature typed). */
async function openGateFor(
	store: WorkspaceStore,
	x: { taskId: string; requestId: string },
) {
	store.navigate({
		view: "hq",
		repoId: null,
		taskId: x.taskId,
		requestId: x.requestId,
	});
	await flush();
	store.setSignature("Edward");
	await flush();
	expect(store.getState().gate?.challenge.phase).toBe("ready");
}

/** Decide one request through the store's own gate path (challenge, exact signature, button). */
async function decideThroughGate(
	store: WorkspaceStore,
	x: { taskId: string; requestId: string },
	action: "approve" | "accept",
) {
	await openGateFor(store, x);
	return store.decide(action);
}

/** Gate 2 of `x`: approve its Gate 1 through the store, run the fixture engine to the result request. */
async function toResult(
	tx: FixtureTransport,
	store: WorkspaceStore,
	x: { taskId: string; requestId: string },
) {
	await decideThroughGate(store, x, "approve");
	tx.controls.runToEnd(x.taskId);
	await store.refresh();
	const d = store.detail(x.taskId) as WorkspaceTaskDetail;
	const r = d.approval_requests.find(
		(q) => q.kind === "result" && q.status === "pending",
	);
	if (!r) throw new Error("no pending result request");
	return { taskId: x.taskId, requestId: r.id, request: r };
}

// ── T0-RR-P2-01: history ──────────────────────────────────────────────────────

describe("T0-RR-P2-01 — a delayed history page settles into current rows and newer validity", () => {
	async function accepted() {
		const h = await signedIn(harness());
		const ids = await h.tx.controls.seedDemo();
		await h.store.loadSnapshot();
		const id = ids.accepted as string;
		h.store.navigate({
			view: "projects",
			repoId: REPO,
			taskId: null,
			requestId: null,
		});
		const old = h.store
			.getState()
			.snapshot?.tasks.find((x) => x.task.id === id) as any;
		expect(old.acceptance_validity?.status).toBe("valid");
		const other = h.store
			.getState()
			.snapshot?.tasks.find((x) => x.task.id !== id) as any;
		return { h, id, old, other };
	}
	/** A validity re-check that finds the acceptance invalid — always later than the reads before it. */
	const invalidate = (h: ReturnType<typeof harness>, id: string) => {
		h.tick();
		return h.tx.controls.setAcceptanceValidity(id, "invalid");
	};
	const validityOf = (h: ReturnType<typeof harness>, id: string) =>
		h.store.getState().history?.items.find((x) => x.task.id === id)
			?.acceptance_validity?.status;

	test("validity proven invalid while the continuation was in flight stays invalid after it answers", async () => {
		const { h, id, old, other } = await accepted();
		const first = h.store.loadHistory(REPO, "all");
		h.hist[0]?.resolve(
			ok({ repo_id: REPO, filter: "all", items: [old], page: meta(2, "c2") }),
		);
		await first;
		const more = h.store.loadHistory(REPO, "all", true);
		expect(invalidate(h, id)).toBe(true);
		await h.store.loadDetail(id);
		expect(validityOf(h, id)).toBe("invalid");
		h.hist[1]?.resolve(
			ok({ repo_id: REPO, filter: "all", items: [other], page: meta(2, null) }),
		);
		await more;
		expect(validityOf(h, id)).toBe("invalid");
		expect(h.store.detail(id)?.acceptance_validity?.status).toBe("invalid");
		expect(h.store.getState().history?.items.map((x) => x.task.id)).toEqual([
			id,
			other.task.id,
		]);
		// the rendered row keeps its badge
		const html = historySection(render(h.store, "projects"));
		expect(html).toContain('data-validity="invalid"');
	});

	test("same task rev: an older `valid` check arriving after a newer `invalid` one cannot replace it", async () => {
		const { h, id, old } = await accepted();
		const first = h.store.loadHistory(REPO, "all");
		h.hist[0]?.resolve(
			ok({ repo_id: REPO, filter: "all", items: [old], page: meta(2, "c2") }),
		);
		await first;
		invalidate(h, id);
		await h.store.loadDetail(id);
		const detail = h.store.detail(id) as WorkspaceTaskDetail;
		expect(detail.task.rev).toBe(old.task.rev); // a validity re-check does not bump the task rev
		expect(
			Date.parse(detail.acceptance_validity?.checked_at ?? "") >
				Date.parse(old.acceptance_validity.checked_at),
		).toBe(true);
		const more = h.store.loadHistory(REPO, "all", true);
		h.hist[1]?.resolve(
			ok({ repo_id: REPO, filter: "all", items: [old], page: meta(2, null) }),
		);
		await more;
		expect(validityOf(h, id)).toBe("invalid");
		expect(h.store.getState().history?.items).toHaveLength(1);
	});

	test("T0-SAME-P2-01: an EQUAL checked_at — the delayed `valid` page row never replaces the known sticky `invalid`", async () => {
		const { h, id, old } = await accepted();
		const first = h.store.loadHistory(REPO, "all");
		h.hist[0]?.resolve(
			ok({ repo_id: REPO, filter: "all", items: [], page: meta(2, "c2") }),
		);
		await first;
		const more = h.store.loadHistory(REPO, "all", true);
		// the re-check happens in the same millisecond as the page's `valid` check (no tick)
		expect(h.tx.controls.setAcceptanceValidity(id, "invalid")).toBe(true);
		await h.store.loadDetail(id);
		const detail = h.store.detail(id) as WorkspaceTaskDetail;
		expect(detail.acceptance_validity?.status).toBe("invalid");
		expect(detail.acceptance_validity?.checked_at).toBe(
			old.acceptance_validity.checked_at,
		);
		expect(detail.task.rev).toBe(old.task.rev);
		h.hist[1]?.resolve(
			ok({ repo_id: REPO, filter: "all", items: [old], page: meta(2, null) }),
		);
		await more;
		expect(validityOf(h, id)).toBe("invalid");
		const html = historySection(render(h.store, "projects"));
		expect(html).toContain('data-validity="invalid"');
		for (let i = 0; i < 5; i++) await h.store.loadSnapshot();
		expect(validityOf(h, id)).toBe("invalid");
	});

	test("T0-SAME-P2-01: reconcileHistoryPage keeps a known sticky verdict against an equal-time page row (loaded row or task read)", () => {
		const { invalidAt, validAt, unverifiableAt } = sameInstant();
		const facts = (detail: any = null): KnownFacts => ({
			detail: () => detail,
			snapshotRow: () => undefined,
			receiptCloses: () => false,
		});
		// a loaded row already invalid; the delayed page says valid at the same instant
		expect(
			reconcileHistoryPage([invalidAt], [validAt], facts())[0]
				?.acceptance_validity?.status,
		).toBe("invalid");
		// a row first seen in the page; the task read is unverifiable at the same instant
		expect(
			reconcileHistoryPage(
				[],
				[validAt],
				facts({
					...validAt,
					approval_requests: [],
					acceptance_validity: unverifiableAt.acceptance_validity,
				}),
			)[0]?.acceptance_validity?.status,
		).toBe("unverifiable");
		// the other direction still follows the sticky verdict
		expect(
			reconcileHistoryPage([validAt], [invalidAt], facts())[0]
				?.acceptance_validity?.status,
		).toBe("invalid");
	});

	test("overlapping pages: a stale duplicate in a later page neither duplicates the row nor regresses it — even a row first seen in that page", async () => {
		const { h, id, old, other } = await accepted();
		// the first page holds only `other`; the task's detail is read (invalid) while page 2 is in flight
		const first = h.store.loadHistory(REPO, "all");
		h.hist[0]?.resolve(
			ok({ repo_id: REPO, filter: "all", items: [other], page: meta(3, "c2") }),
		);
		await first;
		const more = h.store.loadHistory(REPO, "all", true);
		invalidate(h, id);
		await h.store.loadDetail(id);
		// page 2 overlaps page 1 (`other` again) and brings the accepted row as read before the re-check
		h.hist[1]?.resolve(
			ok({
				repo_id: REPO,
				filter: "all",
				items: [other, old],
				page: meta(3, "c3"),
			}),
		);
		await more;
		expect(validityOf(h, id)).toBe("invalid");
		const again = h.store.loadHistory(REPO, "all", true);
		h.hist[2]?.resolve(
			ok({ repo_id: REPO, filter: "all", items: [old], page: meta(3, null) }),
		);
		await again;
		const ids = h.store.getState().history?.items.map((x) => x.task.id) ?? [];
		expect(ids).toEqual([other.task.id, id]);
		expect(validityOf(h, id)).toBe("invalid");
		// the row first seen in a later page renders as a complete history row (title, badge)
		const html = historySection(render(h.store, "projects"));
		expect(html).toContain(`data-history-task-id="${id}"`);
		expect(html).toContain(old.task.draft.title);
		expect(html).toContain('data-validity="invalid"');
	});

	test("a later page cannot hide a newer task revision either (row newer in the detail than in the page)", async () => {
		const { h, other } = await accepted();
		const first = h.store.loadHistory(REPO, "all");
		h.hist[0]?.resolve(
			ok({ repo_id: REPO, filter: "all", items: [], page: meta(1, "c2", 0) }),
		);
		await first;
		const more = h.store.loadHistory(REPO, "all", true);
		await h.store.loadDetail(other.task.id);
		const newer = h.store.detail(other.task.id) as WorkspaceTaskDetail;
		const stale = {
			...other,
			task: { ...other.task, rev: newer.task.rev - 1 },
		};
		h.hist[1]?.resolve(
			ok({ repo_id: REPO, filter: "all", items: [stale], page: meta(1, null) }),
		);
		await more;
		expect(h.store.getState().history?.items[0]?.task.rev).toBe(newer.task.rev);
	});

	test("auth generation changes while a page is in flight: the old answer is discarded", async () => {
		const { h, old } = await accepted();
		const pending = h.store.loadHistory(REPO, "all");
		await h.store.signOut();
		await h.store.signIn("x".repeat(24));
		h.hist[0]?.resolve(
			ok({ repo_id: REPO, filter: "all", items: [old], page: meta(1, null) }),
		);
		await pending;
		expect(h.store.getState().history).toBeNull();
	});

	test("repository / filter change while a page is in flight: the old answer is discarded", async () => {
		const { h, old } = await accepted();
		const a = h.store.loadHistory(REPO, "all");
		const b = h.store.loadHistory(REPO, "attention"); // filter change
		h.hist[0]?.resolve(
			ok({ repo_id: REPO, filter: "all", items: [old], page: meta(1, null) }),
		);
		await a;
		expect(h.store.getState().history).toMatchObject({
			status: "loading",
			items: [],
			key: historyKey(REPO, "attention"),
		});
		h.store.navigate({
			view: "projects",
			repoId: "local/empty-sandbox",
			taskId: null,
			requestId: null,
		});
		h.hist[1]?.resolve(
			ok({
				repo_id: REPO,
				filter: "attention",
				items: [old],
				page: meta(1, null),
			}),
		);
		await b;
		expect(h.store.getState().history).toBeNull();
	});

	test("a failed page keeps every confirmed row (and its newer validity); retry continues and settles into them", async () => {
		const { h, id, old, other } = await accepted();
		const first = h.store.loadHistory(REPO, "all");
		h.hist[0]?.resolve(
			ok({ repo_id: REPO, filter: "all", items: [old], page: meta(2, "c2") }),
		);
		await first;
		invalidate(h, id);
		await h.store.loadDetail(id);
		const failed = h.store.loadHistory(REPO, "all", true);
		h.hist[1]?.resolve(lost);
		await failed;
		expect(h.store.getState().history).toMatchObject({ status: "error" });
		expect(validityOf(h, id)).toBe("invalid");
		const retry = h.store.loadHistory(REPO, "all", true);
		expect(h.hist[2]?.q.cursor).toBe("c2");
		h.hist[2]?.resolve(
			ok({
				repo_id: REPO,
				filter: "all",
				items: [old, other],
				page: meta(2, null),
			}),
		);
		await retry;
		expect(h.store.getState().history?.items.map((x) => x.task.id)).toEqual([
			id,
			other.task.id,
		]);
		expect(validityOf(h, id)).toBe("invalid");
	});
});

// ── T0-RR-P2-01: inbox ────────────────────────────────────────────────────────

describe("T0-RR-P2-01 — a delayed inbox page never resurrects a request closed while it was in flight", () => {
	async function twoPending() {
		const h = await signedIn(harness());
		const A = await makeTask(h.tx, REPO, "A pending");
		const B = await makeTask(h.tx, REPO, "B pending");
		await h.store.loadSnapshot();
		h.store.navigate({
			view: "hq",
			repoId: null,
			taskId: null,
			requestId: null,
		});
		const pendingOf = (requestId: string) =>
			h.store
				.getState()
				.snapshot?.pending_requests.find((r) => r.id === requestId) as any;
		return {
			h,
			A,
			B,
			reqA: pendingOf(A.requestId),
			reqB: pendingOf(B.requestId),
		};
	}
	const inboxIds = (h: ReturnType<typeof harness>) =>
		h.store.getState().inbox?.items.map((r) => r.id) ?? [];

	async function firstPageThenMore(
		h: ReturnType<typeof harness>,
		first: any[],
		kind: "run" | "result" | null = null,
	) {
		const p = h.store.loadInbox(REPO, kind);
		h.box[h.box.length - 1]?.resolve(
			ok({
				repo_id: REPO,
				kind,
				items: first,
				page: meta(3, "c2", first.length),
			}),
		);
		await p;
		// wrapped: an async function returning the promise would make `await` wait for the held page
		return { pending: h.store.loadInbox(REPO, kind, true) };
	}

	test("Gate 1 closed by a task read (reconciler invalidation): the stale page row is not put back; the total follows", async () => {
		const { h, A, reqA, reqB } = await twoPending();
		const { pending: more } = await firstPageThenMore(h, [reqB]);
		expect(h.tx.controls.invalidateRunRequest(A.taskId)).toBe(true);
		await h.store.loadDetail(A.taskId);
		// the delayed page was read before the invalidation: it still lists A as pending
		const page = h.box[1];
		page?.resolve(
			ok({ repo_id: REPO, kind: null, items: [reqA], page: meta(2, null) }),
		);
		await more;
		expect(inboxIds(h)).toEqual([reqB.id]);
		expect(h.store.getState().inbox?.page?.total).toBe(1);
		expect(inboxSection(render(h.store, "hq"))).not.toContain(
			`data-request-id="${reqA.id}"`,
		);
	});

	test("Gate 1 row removed from the loaded rows while the next page was in flight stays removed (the reviewed sequence)", async () => {
		const { h, A, reqA, reqB } = await twoPending();
		const { pending: more } = await firstPageThenMore(h, [reqA]);
		h.tx.controls.invalidateRunRequest(A.taskId);
		await h.store.loadDetail(A.taskId);
		expect(inboxIds(h)).toEqual([]);
		h.box[1]?.resolve(
			ok({ repo_id: REPO, kind: null, items: [reqB], page: meta(1, null) }),
		);
		await more;
		expect(inboxIds(h)).toEqual([reqB.id]);
	});

	test("Gate 2 closed by a task read: the delayed page cannot restore the result request", async () => {
		const { h, A } = await twoPending();
		const g2 = await toResult(h.tx, h.store, A);
		h.store.navigate({
			view: "hq",
			repoId: null,
			taskId: null,
			requestId: null,
		});
		const { pending: more } = await firstPageThenMore(h, [], "result");
		expect(h.tx.controls.invalidateResult(A.taskId)).toBe(true);
		await h.store.loadDetail(A.taskId);
		h.box[1]?.resolve(
			ok({
				repo_id: REPO,
				kind: "result",
				items: [{ ...g2.request, repo_id: REPO }],
				page: meta(1, null),
			}),
		);
		await more;
		expect(inboxIds(h)).toEqual([]);
	});

	for (const gate of ["run", "result"] as const) {
		test(`Gate ${gate === "run" ? 1 : 2} closed by this session's committed receipt (follow-up reads held): the delayed page cannot restore it`, async () => {
			const { h, A } = await twoPending();
			const subject =
				gate === "run"
					? {
							...A,
							request: h.store
								.getState()
								.snapshot?.pending_requests.find((r) => r.id === A.requestId),
						}
					: await toResult(h.tx, h.store, A);
			const stale = { ...(subject.request as any), repo_id: REPO };
			h.store.navigate({
				view: "hq",
				repoId: null,
				taskId: null,
				requestId: null,
			});
			const { pending: more } = await firstPageThenMore(h, [stale], gate);
			await openGateFor(h.store, subject);
			const release = h.holdReads(); // the hub commits; every follow-up read waits
			const deciding = h.store.decide(gate === "run" ? "approve" : "accept");
			await flush();
			expect(h.store.getState().attempts[subject.requestId]?.status).toBe(
				"committed",
			);
			// the cached rows still say pending: only the receipt knows better yet
			expect(
				h.store.findRequest(subject.taskId, subject.requestId)?.status,
			).toBe("pending");
			h.box[1]?.resolve(
				ok({
					repo_id: REPO,
					kind: gate,
					items: [stale],
					page: meta(1, null),
				}),
			);
			await more;
			expect(inboxIds(h)).toEqual([]);
			expect(inboxSection(render(h.store, "hq"))).not.toContain(
				`data-request-id="${subject.requestId}"`,
			);
			release();
			await deciding;
			await flush();
			expect(inboxIds(h)).toEqual([]);
		});
	}

	test("auth generation change while an inbox page is in flight: the old answer is discarded", async () => {
		const { h, reqA } = await twoPending();
		const p = h.store.loadInbox(REPO, null);
		await h.store.signOut();
		await h.store.signIn("x".repeat(24));
		h.box[0]?.resolve(
			ok({ repo_id: REPO, kind: null, items: [reqA], page: meta(1, null) }),
		);
		await p;
		expect(h.store.getState().inbox).toBeNull();
	});

	test("filter change while an inbox page is in flight: the old answer is discarded; a failed page then retry keeps rows", async () => {
		const { h, reqA, reqB } = await twoPending();
		const a = h.store.loadInbox(REPO, null);
		const b = h.store.loadInbox(REPO, "run");
		h.box[0]?.resolve(
			ok({ repo_id: REPO, kind: null, items: [reqA], page: meta(1, null) }),
		);
		await a;
		expect(h.store.getState().inbox).toMatchObject({
			status: "loading",
			items: [],
			key: inboxKey(REPO, "run"),
		});
		h.box[1]?.resolve(
			ok({ repo_id: REPO, kind: "run", items: [reqA], page: meta(2, "c2") }),
		);
		await b;
		const failed = h.store.loadInbox(REPO, "run", true);
		h.box[2]?.resolve(lost);
		await failed;
		expect(h.store.getState().inbox).toMatchObject({ status: "error" });
		expect(inboxIds(h)).toEqual([reqA.id]);
		const retry = h.store.loadInbox(REPO, "run", true);
		expect(h.box[3]?.q.cursor).toBe("c2");
		h.box[3]?.resolve(
			ok({
				repo_id: REPO,
				kind: "run",
				items: [reqA, reqB],
				page: meta(2, null),
			}),
		);
		await retry;
		expect(inboxIds(h)).toEqual([reqA.id, reqB.id]);
	});
});

// ── T0-RR-P2-02: the unfiltered continuation follows the snapshot membership ──

const ROW_AT = Date.parse("2026-10-01T00:00:00.000Z");
const fake = (
	n: number,
	repo = "local/bulk",
	kind: "run" | "result" = "run",
) => ({
	id: `wsa-${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`,
	workspace_task_id: `wst-${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`,
	kind,
	status: "pending",
	rev: 1,
	created_at: new Date(ROW_AT + n * 1000).toISOString(),
	repo_id: repo,
	task_title: `Bulk ${n}`,
});
const range = (from: number, to: number, repo?: string) =>
	Array.from({ length: to - from + 1 }, (_, i) => fake(from + i, repo));
const summary = (repo: string, pending: number, approval = pending) => ({
	repo_id: repo,
	pending_requests: pending,
	categories: { needsApproval: approval, needsAcceptance: pending - approval },
});
/** A server snapshot whose pending set is `first` (≤ 500) of `total`, continued by `cursor`. */
const pendingSet =
	(first: any[], total: number, cursor: string | null, summaries?: any[]) =>
	(s: any) => ({
		...s,
		pending_requests: first,
		pending_page: meta(total, cursor, first.length, true),
		...(summaries ? { repo_summaries: summaries } : {}),
	});

describe("T0-RR-P2-02 — an exhausted / cached continuation is reconciled with a fresh snapshot", () => {
	async function atHq() {
		const h = await signedIn(harness());
		h.store.navigate({
			view: "hq",
			repoId: null,
			taskId: null,
			requestId: null,
		});
		return h;
	}
	const ids = (h: ReturnType<typeof harness>) =>
		h.store.getState().inbox?.items.map((r) => r.id) ?? [];
	const disclosure = (html: string) =>
		html.match(/data-testid="inbox-disclosure"[^>]*>([^<]*)</)?.[1] ?? "";
	const loadMore = (html: string) =>
		html.includes('data-testid="inbox-load-more"');

	/** 500 on the first page + 1 continued to the end (501 of 501). */
	async function exhausted501() {
		const h = await atHq();
		h.patchSnapshot(pendingSet(range(1, 500), 501, "c1"));
		await h.store.loadSnapshot();
		const p = h.store.loadInbox(null, null, true);
		expect(h.box[0]?.q).toMatchObject({
			cursor: "c1",
			limit: SNAPSHOT_INBOX_LIMIT,
		});
		h.box[0]?.resolve(
			ok({
				repo_id: null,
				kind: null,
				items: [fake(501)],
				page: meta(501, null),
			}),
		);
		await p;
		const html = inboxSection(render(h.store, "hq"));
		expect(disclosure(html)).toContain("Showing 501 of 501 pending");
		expect(loadMore(html)).toBe(false);
		return h;
	}

	test("501 loaded to the end → a 502nd pending request: reachable without reload or filter teardown", async () => {
		const h = await exhausted501();
		h.patchSnapshot(pendingSet(range(1, 500), 502, "c2"));
		await h.store.loadSnapshot();
		let html = inboxSection(render(h.store, "hq"));
		expect(disclosure(html)).toContain("of 502 pending");
		expect(loadMore(html)).toBe(true);
		const more = h.store.loadInbox(null, null, true);
		expect(h.box).toHaveLength(2);
		expect(h.box[1]?.q).toMatchObject({
			cursor: "c2",
			limit: SNAPSHOT_INBOX_LIMIT,
		});
		h.box[1]?.resolve(
			ok({
				repo_id: null,
				kind: null,
				items: [fake(501), fake(502)],
				page: meta(502, null, 2),
			}),
		);
		await more;
		html = inboxSection(render(h.store, "hq"));
		expect(html).toContain(`data-request-id="${fake(502).id}"`);
		expect(disclosure(html)).toContain("Showing 502 of 502 pending");
		expect(loadMore(html)).toBe(false);
	});

	test("the reviewer's sequence (cursor/total only): the store issues the new bounded continuation from the fresh cursor", async () => {
		const h = await atHq();
		h.patchSnapshot((s: any) => ({
			...s,
			pending_page: meta(501, "first-window-cursor"),
		}));
		await h.store.loadSnapshot();
		const old = h.store.loadInbox(null, null, true);
		h.box[0]?.resolve(
			ok({ repo_id: null, kind: null, items: [], page: meta(501, null) }),
		);
		await old;
		h.patchSnapshot((s: any) => ({
			...s,
			pending_page: meta(502, "fresh-window-cursor"),
		}));
		await h.store.loadSnapshot();
		const before = h.box.length;
		const next = h.store.loadInbox(null, null, true);
		expect(h.box.length).toBe(before + 1);
		expect(h.box[before]?.q.cursor).toBe("fresh-window-cursor");
		h.box[before]?.resolve(
			ok({
				repo_id: null,
				kind: null,
				items: [fake(502)],
				page: meta(502, null),
			}),
		);
		await next;
		expect(ids(h)).toEqual([fake(502).id]);
	});

	test("a cached-tail request decided elsewhere leaves the pending display (no controls reopen)", async () => {
		const h = await exhausted501();
		// 501 was decided through another client: the fresh snapshot counts 500 (its first page is the whole set)
		h.patchSnapshot(pendingSet(range(1, 500), 500, null));
		await h.store.loadSnapshot();
		expect(h.store.getState().inbox).toBeNull();
		const html = inboxSection(render(h.store, "hq"));
		expect(html).not.toContain(`data-request-id="${fake(501).id}"`);
		expect(disclosure(html)).toContain("Showing 500 of 500 pending");
		expect(loadMore(html)).toBe(false);
	});

	test("equal-total churn on the first page (one closed, one new): the continuation is reconciled", async () => {
		const h = await exhausted501();
		// request 1 decided elsewhere, 502 arrives: total still 501, the first page shifted by one
		h.patchSnapshot(pendingSet(range(2, 501), 501, "c3"));
		await h.store.loadSnapshot();
		expect(h.store.getState().inbox).toBeNull();
		let html = inboxSection(render(h.store, "hq"));
		expect(html).not.toContain(`data-request-id="${fake(1).id}"`);
		expect(loadMore(html)).toBe(true);
		const more = h.store.loadInbox(null, null, true);
		expect(h.box[1]?.q.cursor).toBe("c3");
		h.box[1]?.resolve(
			ok({
				repo_id: null,
				kind: null,
				items: [fake(502)],
				page: meta(501, null),
			}),
		);
		await more;
		html = inboxSection(render(h.store, "hq"));
		expect(html).toContain(`data-request-id="${fake(502).id}"`);
		expect(html).not.toContain(`data-request-id="${fake(1).id}"`);
		expect(disclosure(html)).toContain("Showing 501 of 501 pending");
	});

	test("equal-total churn entirely in the cached tail across repositories: per-repository counts change → reconciled", async () => {
		const h = await atHq();
		h.patchSnapshot(
			pendingSet(range(1, 500), 501, "c1", [
				summary("local/bulk", 500),
				summary("local/tail", 1),
			]),
		);
		await h.store.loadSnapshot();
		const p = h.store.loadInbox(null, null, true);
		h.box[0]?.resolve(
			ok({
				repo_id: null,
				kind: null,
				items: [fake(501, "local/tail")],
				page: meta(501, null),
			}),
		);
		await p;
		// the tail request was decided elsewhere and a new one opened in another repository: same first page,
		// same total, same cursor — only the complete per-repository counts differ
		h.patchSnapshot(
			pendingSet(range(1, 500), 501, "c1", [
				summary("local/bulk", 500),
				summary("local/tail", 0),
				summary("local/new", 1),
			]),
		);
		await h.store.loadSnapshot();
		expect(h.store.getState().inbox).toBeNull();
		expect(inboxSection(render(h.store, "hq"))).not.toContain(
			`data-request-id="${fake(501, "local/tail").id}"`,
		);
	});

	test("an unchanged membership keeps the loaded continuation (no reload churn on every poll)", async () => {
		const h = await exhausted501();
		await h.store.loadSnapshot();
		await h.store.loadSnapshot();
		expect(ids(h)).toEqual([fake(501).id]);
		expect(inboxSection(render(h.store, "hq"))).toContain(
			`data-request-id="${fake(501).id}"`,
		);
	});

	test("a task read folded locally between two unchanged server snapshots keeps the continuation", async () => {
		const h = await atHq();
		const T = await makeTask(h.tx, REPO, "Folded between snapshot reads");
		h.patchSnapshot(pendingSet(range(1, 500), 501, "c1"));
		await h.store.loadSnapshot();
		const p = h.store.loadInbox(null, null, true);
		h.box[0]?.resolve(
			ok({
				repo_id: null,
				kind: null,
				items: [fake(501)],
				page: meta(501, null),
			}),
		);
		await p;
		await h.store.loadDetail(T.taskId); // folds its pending request into the LOCAL snapshot only
		expect(
			h.store
				.getState()
				.snapshot?.pending_requests.some((r) => r.id === T.requestId),
		).toBe(true);
		await h.store.loadSnapshot(); // the server's membership is unchanged
		expect(ids(h)).toEqual([fake(501).id]);
	});

	test("membership changes while Load more is pending: the late page cannot restore the old membership", async () => {
		const h = await atHq();
		h.patchSnapshot(pendingSet(range(1, 500), 501, "c1"));
		await h.store.loadSnapshot();
		const p = h.store.loadInbox(null, null, true);
		h.patchSnapshot(pendingSet(range(1, 500), 502, "c2"));
		await h.store.loadSnapshot();
		h.box[0]?.resolve(
			ok({
				repo_id: null,
				kind: null,
				items: [fake(501)],
				page: meta(501, null),
			}),
		);
		await p;
		expect(h.store.getState().inbox).toBeNull();
		const html = inboxSection(render(h.store, "hq"));
		expect(disclosure(html)).toContain("of 502 pending");
		expect(loadMore(html)).toBe(true);
	});

	test("repeated and overlapping pages: no duplicate effective rows, no stale resurrection", async () => {
		const h = await atHq();
		h.patchSnapshot(pendingSet(range(1, 500), 503, "c1"));
		await h.store.loadSnapshot();
		const p1 = h.store.loadInbox(null, null, true);
		h.box[0]?.resolve(
			ok({
				repo_id: null,
				kind: null,
				// overlaps the snapshot's first page (500) and repeats itself
				items: [fake(500), fake(501), fake(501), fake(502)],
				page: meta(503, "c2", 4),
			}),
		);
		await p1;
		const p2 = h.store.loadInbox(null, null, true);
		h.box[1]?.resolve(
			ok({
				repo_id: null,
				kind: null,
				items: [fake(502), fake(503)],
				page: meta(503, null, 2),
			}),
		);
		await p2;
		const html = inboxSection(render(h.store, "hq"));
		expect(rowsIn(html, "data-request-id")).toBe(503);
		expect(disclosure(html)).toContain("Showing 503 of 503 pending");
	});

	test("Gate 1 and Gate 2 rows in the continuation are reconciled alike", async () => {
		const h = await atHq();
		const g1 = fake(501, "local/tail", "run");
		const g2 = fake(502, "local/tail", "result");
		h.patchSnapshot(
			pendingSet(range(1, 500), 502, "c1", [
				summary("local/bulk", 500),
				summary("local/tail", 2, 1),
			]),
		);
		await h.store.loadSnapshot();
		const p = h.store.loadInbox(null, null, true);
		h.box[0]?.resolve(
			ok({
				repo_id: null,
				kind: null,
				items: [g1, g2],
				page: meta(502, null, 2),
			}),
		);
		await p;
		let html = inboxSection(render(h.store, "hq"));
		expect(html).toContain('data-gate="execution"');
		expect(html).toContain('data-gate="result"');
		// Gate 2 accepted elsewhere: total 501, local/tail now 1 pending (approval)
		h.patchSnapshot(
			pendingSet(range(1, 500), 501, "c1", [
				summary("local/bulk", 500),
				summary("local/tail", 1, 1),
			]),
		);
		await h.store.loadSnapshot();
		html = inboxSection(render(h.store, "hq"));
		expect(html).not.toContain(`data-request-id="${g2.id}"`);
		expect(loadMore(html)).toBe(true);
	});

	test("auth reset drops the continuation; the next session continues from its own snapshot", async () => {
		const h = await exhausted501();
		await h.store.signOut();
		await h.store.signIn("x".repeat(24));
		expect(h.store.getState().inbox).toBeNull();
		h.store.navigate({
			view: "hq",
			repoId: null,
			taskId: null,
			requestId: null,
		});
		h.patchSnapshot(pendingSet(range(1, 500), 501, "c9"));
		await h.store.loadSnapshot();
		void h.store.loadInbox(null, null, true);
		expect(h.box.at(-1)?.q.cursor).toBe("c9");
	});

	test("a repository-filtered inbox is its own server scope: snapshot membership changes leave it loaded", async () => {
		const h = await atHq();
		h.patchSnapshot(pendingSet(range(1, 500), 501, "c1"));
		await h.store.loadSnapshot();
		const p = h.store.loadInbox("local/bulk", null);
		h.box[0]?.resolve(
			ok({
				repo_id: "local/bulk",
				kind: null,
				items: [fake(1)],
				page: meta(1, null),
			}),
		);
		await p;
		h.patchSnapshot(pendingSet(range(1, 500), 502, "c2"));
		await h.store.loadSnapshot();
		expect(h.store.getState().inbox).toMatchObject({
			key: inboxKey("local/bulk", null),
			status: "ready",
		});
		expect(ids(h)).toEqual([fake(1).id]);
	});

	test("a failed first continuation, retry, end: metadata stays honest", async () => {
		const h = await atHq();
		h.patchSnapshot(pendingSet(range(1, 500), 501, "c1"));
		await h.store.loadSnapshot();
		const failed = h.store.loadInbox(null, null, true);
		h.box[0]?.resolve(lost);
		await failed;
		let html = inboxSection(render(h.store, "hq"));
		expect(html).toContain('data-testid="inbox-error"');
		expect(rowsIn(html, "data-request-id")).toBe(500);
		const retry = h.store.loadInbox(null, null, true);
		expect(h.box[1]?.q.cursor).toBe("c1");
		h.box[1]?.resolve(
			ok({
				repo_id: null,
				kind: null,
				items: [fake(501)],
				page: meta(501, null),
			}),
		);
		await retry;
		html = inboxSection(render(h.store, "hq"));
		expect(disclosure(html)).toContain("Showing 501 of 501 pending");
		expect(loadMore(html)).toBe(false);
		expect(html).not.toContain('data-testid="inbox-error"');
	});

	for (const n of [499, 500, 501]) {
		test(`boundary ${n}: the first page, Load more and the disclosure agree with the snapshot`, async () => {
			const h = await atHq();
			const first = range(1, Math.min(n, 500));
			h.patchSnapshot(pendingSet(first, n, n > 500 ? "c1" : null));
			await h.store.loadSnapshot();
			const html = inboxSection(render(h.store, "hq"));
			expect(rowsIn(html, "data-request-id")).toBe(first.length);
			expect(disclosure(html)).toContain(
				`Showing ${first.length} of ${n} pending`,
			);
			expect(loadMore(html)).toBe(n > 500);
			const before = h.box.length;
			await (n > 500 ? Promise.resolve() : h.store.loadInbox(null, null, true));
			expect(h.box.length).toBe(before); // nothing to continue below the cap
		});
	}
});

// ── T0-FINAL-P2-01: the hub's membership generation reconciles a same-total tail replacement ──

describe("T0-FINAL-P2-01 — same-total replacement beyond the first page reconciles the exhausted continuation", () => {
	const G = (entered: number, pending: number) =>
		`v1:0123456789abcdef:${entered}:${pending}`;
	/** A server snapshot of `pendingSet` whose first page carries the hub's generation. */
	const at =
		(generation: string, kind: "run" | "result" = "run") =>
		(s: any) => {
			const out = pendingSet(range(1, 500), 501, "c1", [
				summary("local/bulk", 500),
				summary("local/tail", 1, kind === "run" ? 1 : 0),
			])(s);
			return {
				...out,
				pending_page: {
					...out.pending_page,
					membership_generation: generation,
				},
			};
		};
	const tailPage = (items: any[], generation: string) =>
		ok({
			repo_id: null,
			kind: null,
			items,
			page: {
				...meta(501, null, items.length),
				membership_generation: generation,
			},
		});
	const ids = (h: ReturnType<typeof harness>) =>
		h.store.getState().inbox?.items.map((r) => r.id) ?? [];
	const disclosure = (html: string) =>
		html.match(/data-testid="inbox-disclosure"[^>]*>([^<]*)</)?.[1] ?? "";
	const loadMore = (html: string) =>
		html.includes('data-testid="inbox-load-more"');
	async function atHq() {
		const h = await signedIn(harness());
		h.store.navigate({
			view: "hq",
			repoId: null,
			taskId: null,
			requestId: null,
		});
		return h;
	}
	/** 500 on the first page + the tail request continued to the end, at `generation`. */
	async function exhausted(
		tail: any,
		generation: string,
		kind: "run" | "result" = "run",
	) {
		const h = await atHq();
		h.patchSnapshot(at(generation, kind));
		await h.store.loadSnapshot();
		const p = h.store.loadInbox(null, null, true);
		h.box[0]?.resolve(tailPage([tail], generation));
		await p;
		const html = inboxSection(render(h.store, "hq"));
		expect(html).toContain(`data-request-id="${tail.id}"`);
		expect(disclosure(html)).toContain("Showing 501 of 501 pending");
		expect(loadMore(html)).toBe(false);
		return h;
	}

	for (const kind of ["run", "result"] as const) {
		test(`Gate ${kind === "run" ? 1 : 2}: X closed and Y opened in the same repository and gate at 501 → X leaves, Load more reaches Y`, async () => {
			const x = fake(501, "local/tail", kind);
			const y = fake(502, "local/tail", kind);
			const h = await exhausted(x, G(501, 501), kind);
			// the attack's precondition: first page, total, cursor and per-repository counts are all equal —
			// only the hub's generation differs
			const base = ((await h.tx.getSnapshot()) as any).data;
			const before = at(G(501, 501), kind)(base);
			const after = at(G(502, 501), kind)(base);
			expect(pendingMembership(after)).toBe(pendingMembership(before));
			expect(after.pending_page.membership_generation).not.toBe(
				before.pending_page.membership_generation,
			);
			h.patchSnapshot(at(G(502, 501), kind));
			await h.store.loadSnapshot();
			expect(h.store.getState().inbox).toBeNull();
			let html = inboxSection(render(h.store, "hq"));
			expect(html).not.toContain(`data-request-id="${x.id}"`);
			expect(disclosure(html)).toContain("Showing 500 of 501 pending");
			expect(loadMore(html)).toBe(true);
			expect(h.box).toHaveLength(1); // the reset itself reads nothing
			const more = h.store.loadInbox(null, null, true);
			expect(h.box).toHaveLength(2);
			expect(h.box[1]?.q).toMatchObject({
				cursor: "c1",
				limit: SNAPSHOT_INBOX_LIMIT,
			});
			h.box[1]?.resolve(tailPage([y], G(502, 501)));
			await more;
			html = inboxSection(render(h.store, "hq"));
			expect(html).toContain(`data-request-id="${y.id}"`);
			expect(html).not.toContain(`data-request-id="${x.id}"`);
			expect(disclosure(html)).toContain("Showing 501 of 501 pending");
			expect(loadMore(html)).toBe(false);
		});
	}

	test("an unchanged generation keeps the exhausted continuation through repeated polls: no reset, no read", async () => {
		const x = fake(501, "local/tail");
		const h = await exhausted(x, G(501, 501));
		for (let i = 0; i < 20; i++) await h.store.loadSnapshot();
		expect(h.box).toHaveLength(1);
		expect(ids(h)).toEqual([x.id]);
		expect(h.store.getState().inbox?.status).toBe("ready");
	});

	test("after the reset, unchanged polls read nothing and keep Load more; nothing loads by itself", async () => {
		const h = await exhausted(fake(501, "local/tail"), G(501, 501));
		h.patchSnapshot(at(G(502, 501)));
		for (let i = 0; i < 20; i++) await h.store.loadSnapshot();
		expect(h.box).toHaveLength(1);
		expect(h.store.getState().inbox).toBeNull();
		expect(loadMore(inboxSection(render(h.store, "hq")))).toBe(true);
	});

	test("the generation changes while Load more is in flight: the late page is discarded; Load more continues the fresh snapshot", async () => {
		const x = fake(501, "local/tail");
		const y = fake(502, "local/tail");
		const h = await atHq();
		h.patchSnapshot(at(G(501, 501)));
		await h.store.loadSnapshot();
		const late = h.store.loadInbox(null, null, true);
		h.patchSnapshot(at(G(502, 501)));
		await h.store.loadSnapshot();
		h.box[0]?.resolve(tailPage([x], G(501, 501)));
		await late;
		expect(h.store.getState().inbox).toBeNull();
		let html = inboxSection(render(h.store, "hq"));
		expect(html).not.toContain(`data-request-id="${x.id}"`);
		expect(loadMore(html)).toBe(true);
		const more = h.store.loadInbox(null, null, true);
		expect(h.box[1]?.q.cursor).toBe("c1");
		h.box[1]?.resolve(tailPage([y], G(502, 501)));
		await more;
		html = inboxSection(render(h.store, "hq"));
		expect(html).toContain(`data-request-id="${y.id}"`);
		expect(html).not.toContain(`data-request-id="${x.id}"`);
	});
});

// ── T0-RR-P3-01: structured collection scope ──────────────────────────────────

describe("T0-RR-P3-01 — a legal repository id holding `|` keeps its exact collection scope", () => {
	const row = (id: string, repo: string, rev = 1) => ({
		task: {
			id,
			rev,
			repo_id: repo,
			stage: "draft",
			draft: { title: `Row ${id}` },
			updated_at: "2026-10-06T00:00:00.000Z",
			created_at: "2026-10-06T00:00:00.000Z",
		},
		phase: "draft",
		acceptance_validity: null,
		engine: null,
		latest_request: null,
	});
	const histOf = (h: ReturnType<typeof harness>) =>
		h.store.getState().history?.items.map((x) => x.task.id) ?? null;

	test("selecting a task in the same exact repository keeps its loaded history; a prefix-confusable repository does not", async () => {
		const h = await signedIn(harness());
		h.store.navigate({
			view: "projects",
			repoId: PIPE,
			taskId: null,
			requestId: null,
		});
		const p = h.store.loadHistory(PIPE, "attention");
		h.hist[0]?.resolve(
			ok({
				repo_id: PIPE,
				filter: "attention",
				items: [row("wst-p1", PIPE)],
				page: meta(1, null),
			}),
		);
		await p;
		h.store.navigate({
			view: "projects",
			repoId: PIPE,
			taskId: "wst-p1",
			requestId: null,
		});
		expect(histOf(h)).toEqual(["wst-p1"]);
		expect(h.store.getState().history?.scope).toEqual({
			feed: "history",
			repoId: PIPE,
			filter: "attention",
		});
		h.store.navigate({
			view: "projects",
			repoId: PREFIX,
			taskId: null,
			requestId: null,
		});
		expect(h.store.getState().history).toBeNull();
	});

	test("a late page of one repository never lands in its prefix-confusable neighbour (both directions)", async () => {
		const h = await signedIn(harness());
		h.store.navigate({
			view: "projects",
			repoId: PREFIX,
			taskId: null,
			requestId: null,
		});
		const a = h.store.loadHistory(PREFIX, "all");
		h.store.navigate({
			view: "projects",
			repoId: PIPE,
			taskId: null,
			requestId: null,
		});
		const b = h.store.loadHistory(PIPE, "all");
		h.hist[0]?.resolve(
			ok({
				repo_id: PREFIX,
				filter: "all",
				items: [row("wst-x", PREFIX)],
				page: meta(1, null),
			}),
		);
		await a;
		expect(histOf(h)).toEqual([]);
		h.hist[1]?.resolve(
			ok({
				repo_id: PIPE,
				filter: "all",
				items: [row("wst-p", PIPE)],
				page: meta(1, null),
			}),
		);
		await b;
		expect(histOf(h)).toEqual(["wst-p"]);
		// back to the neighbour, then return: each scope is read again on its own
		h.store.navigate({
			view: "projects",
			repoId: PREFIX,
			taskId: null,
			requestId: null,
		});
		expect(h.store.getState().history).toBeNull();
		h.store.navigate({
			view: "projects",
			repoId: PIPE,
			taskId: null,
			requestId: null,
		});
		const c = h.store.loadHistory(PIPE, "all");
		expect(h.hist[2]?.q).toMatchObject({ repo_id: PIPE, filter: "all" });
		h.hist[2]?.resolve(
			ok({
				repo_id: PIPE,
				filter: "all",
				items: [row("wst-p", PIPE)],
				page: meta(1, null),
			}),
		);
		await c;
		expect(histOf(h)).toEqual(["wst-p"]);
	});

	test("Headquarters initializes its filter to the full repository id and gate, and renders the returned request", async () => {
		const h = await signedIn(harness());
		h.store.navigate({
			view: "hq",
			repoId: null,
			taskId: null,
			requestId: null,
		});
		const req = fake(7, PIPE, "run");
		const p = h.store.loadInbox(PIPE, "run");
		expect(h.box[0]?.q).toMatchObject({ repo_id: PIPE, kind: "run" });
		h.box[0]?.resolve(
			ok({ repo_id: PIPE, kind: "run", items: [req], page: meta(1, null) }),
		);
		await p;
		const html = inboxSection(render(h.store, "hq"));
		expect(html).toContain(`data-inbox-scope="${PIPE}"`);
		expect(html).toContain(`data-request-id="${req.id}"`);
		expect(html).toMatch(/<option value="run" selected="">/);
		// the neighbour's scope is a different collection
		const q = h.store.loadInbox(PREFIX, "run");
		h.box[1]?.resolve(
			ok({ repo_id: PREFIX, kind: "run", items: [], page: meta(0, null, 0) }),
		);
		await q;
		const other = inboxSection(render(h.store, "hq"));
		expect(other).toContain(`data-inbox-scope="${PREFIX}"`);
		expect(other).not.toContain(`data-request-id="${req.id}"`);
	});

	test("other allowed punctuation round-trips exactly through the collection scope", async () => {
		const h = await signedIn(harness());
		for (const repo of [
			"o.w_n-er/na.me_1-x",
			"local/a|b|c",
			"local/x:y",
			"owner/name",
		]) {
			h.store.navigate({
				view: "projects",
				repoId: repo,
				taskId: null,
				requestId: null,
			});
			const p = h.store.loadHistory(repo, "all");
			h.hist.at(-1)?.resolve(
				ok({
					repo_id: repo,
					filter: "all",
					items: [row(`wst-${repo}`, repo)],
					page: meta(1, null),
				}),
			);
			await p;
			expect(h.store.getState().history?.scope.repoId).toBe(repo);
			h.store.navigate({
				view: "projects",
				repoId: repo,
				taskId: `wst-${repo}`,
				requestId: null,
			});
			expect(histOf(h)).toEqual([`wst-${repo}`]);
		}
	});
});
