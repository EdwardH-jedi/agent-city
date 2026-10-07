// biome-ignore-all lint/suspicious/noExplicitAny: fake transport answers carry partial, untyped rows on purpose
// Review repair APP-P2-01 / APP-P2-02 — the store's bounded collections (repository history, inbox pages):
// late answers after a repository / filter / auth change are dropped, a load-more failure keeps the
// confirmed rows, duplicates never regress, and the unfiltered inbox only CONTINUES the snapshot's own
// first page with its exact cursor and page size. Fixture transport for everything else.
import { describe, expect, test } from "bun:test";
import {
	type PageMeta,
	SNAPSHOT_INBOX_LIMIT,
} from "@agent-city/schema/workspace-m1";
import { createFixtureTransport } from "./fixture-transport.ts";
import {
	type CollectionScope,
	collectionKey,
	foldTaskIntoCollections,
	foldTaskIntoSnapshot,
	historyKey,
	historyScope,
	INBOX_PAGE_SIZE,
	inboxKey,
	inboxScope,
	WorkspaceStore,
} from "./store.ts";
import type {
	HistoryQuery,
	InboxQuery,
	TransportResult,
	WorkspaceTransport,
} from "./transport.ts";

const REPO = "local/fixture";
const OTHER = "local/empty-sandbox";

interface Pending<Q> {
	q: Q;
	resolve(r: TransportResult<any>): void;
}

function harness() {
	const tx = createFixtureTransport();
	const hist: Pending<HistoryQuery>[] = [];
	const box: Pending<InboxQuery>[] = [];
	let snapPatch: ((s: any) => any) | null = null;
	const transport = {
		...tx,
		getSnapshot: async () => {
			const r = await tx.getSnapshot();
			return r.ok && snapPatch ? { ...r, data: snapPatch(r.data) } : r;
		},
		getTaskHistory: (q: HistoryQuery) =>
			new Promise<TransportResult<any>>((resolve) => hist.push({ q, resolve })),
		getInbox: (q: InboxQuery) =>
			new Promise<TransportResult<any>>((resolve) => box.push({ q, resolve })),
	} as unknown as WorkspaceTransport;
	const store = new WorkspaceStore({ transport });
	return {
		store,
		hist,
		box,
		patchSnapshot(f: (s: any) => any) {
			snapPatch = f;
		},
	};
}

const page = (
	total: number,
	returned: number,
	next: string | null,
): PageMeta => ({
	total,
	returned,
	complete: next === null,
	has_more: next !== null,
	next_cursor: next,
	as_of: "2026-10-05T03:00:00.000Z",
});
const row = (id: string, rev = 1) =>
	({ task: { id, rev, repo_id: REPO }, engine: null }) as any;
const req = (id: string, rev = 1) => ({ id, rev }) as any;
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
const tick = () => new Promise((r) => setTimeout(r, 0));

async function signedIn() {
	const h = harness();
	await h.store.boot();
	if (h.store.getState().auth.status !== "signed_in")
		await h.store.signIn("x".repeat(24));
	expect(h.store.getState().auth.status).toBe("signed_in");
	h.store.navigate({
		view: "projects",
		repoId: REPO,
		taskId: null,
		requestId: null,
	});
	return h;
}

describe("repository history pages", () => {
	test("a late page for repository A after selecting B is dropped (no cross-repository rows)", async () => {
		const h = await signedIn();
		void h.store.loadHistory(REPO, "all");
		expect(h.hist).toHaveLength(1);
		h.store.navigate({
			view: "projects",
			repoId: OTHER,
			taskId: null,
			requestId: null,
		});
		expect(h.store.getState().history).toBeNull();
		h.hist[0]?.resolve(
			ok({
				repo_id: REPO,
				filter: "all",
				items: [row("wst-a")],
				page: page(1, 1, null),
			}),
		);
		await tick();
		expect(h.store.getState().history).toBeNull();
	});

	test("a filter change supersedes the earlier scope; its late answer is ignored", async () => {
		const h = await signedIn();
		void h.store.loadHistory(REPO, "all");
		void h.store.loadHistory(REPO, "attention");
		h.hist[0]?.resolve(
			ok({
				repo_id: REPO,
				filter: "all",
				items: [row("wst-x")],
				page: page(9, 1, "c"),
			}),
		);
		await tick();
		expect(h.store.getState().history).toMatchObject({
			key: historyKey(REPO, "attention"),
			status: "loading",
			items: [],
		});
	});

	test("load-more failure keeps every confirmed row; retry continues the same cursor and never duplicates", async () => {
		const h = await signedIn();
		void h.store.loadHistory(REPO, "all");
		h.hist[0]?.resolve(
			ok({
				repo_id: REPO,
				filter: "all",
				items: [row("wst-1"), row("wst-2")],
				page: page(3, 2, "cursor-1"),
			}),
		);
		await tick();
		void h.store.loadHistory(REPO, "all", true);
		expect(h.hist[1]?.q).toMatchObject({ repo_id: REPO, cursor: "cursor-1" });
		h.hist[1]?.resolve(lost);
		await tick();
		const failed = h.store.getState().history;
		expect(failed?.status).toBe("error");
		expect(failed?.items.map((t) => t.task.id)).toEqual(["wst-1", "wst-2"]);
		expect(failed?.page?.next_cursor).toBe("cursor-1");
		// retry: the same cursor; an overlapping row with a newer rev replaces, a new one is appended
		void h.store.loadHistory(REPO, "all", true);
		expect(h.hist[2]?.q.cursor).toBe("cursor-1");
		h.hist[2]?.resolve(
			ok({
				repo_id: REPO,
				filter: "all",
				items: [row("wst-2", 5), row("wst-3")],
				page: page(3, 2, null),
			}),
		);
		await tick();
		const done = h.store.getState().history;
		expect(done?.status).toBe("ready");
		expect(done?.items.map((t) => [t.task.id, t.task.rev])).toEqual([
			["wst-1", 1],
			["wst-2", 5],
			["wst-3", 1],
		]);
		// end of history: no further read is started
		void h.store.loadHistory(REPO, "all", true);
		expect(h.hist).toHaveLength(3);
	});

	test("an older duplicate never regresses a newer row", async () => {
		const h = await signedIn();
		void h.store.loadHistory(REPO, "all");
		h.hist[0]?.resolve(
			ok({
				repo_id: REPO,
				filter: "all",
				items: [row("wst-1", 7)],
				page: page(2, 1, "c1"),
			}),
		);
		await tick();
		void h.store.loadHistory(REPO, "all", true);
		h.hist[1]?.resolve(
			ok({
				repo_id: REPO,
				filter: "all",
				items: [row("wst-1", 3)],
				page: page(2, 1, null),
			}),
		);
		await tick();
		expect(h.store.getState().history?.items[0]?.task.rev).toBe(7);
	});

	test("sign-out purges the history; a late page of the old session never lands", async () => {
		const h = await signedIn();
		void h.store.loadHistory(REPO, "all");
		await h.store.signOut();
		h.hist[0]?.resolve(
			ok({
				repo_id: REPO,
				filter: "all",
				items: [row("wst-a")],
				page: page(1, 1, null),
			}),
		);
		await tick();
		expect(h.store.getState().history).toBeNull();
		expect(h.store.getState().auth.status).toBe("signed_out");
	});
});

describe("inbox pages", () => {
	test("the unfiltered inbox only continues the snapshot's first page — its cursor, its page size", async () => {
		const h = await signedIn();
		h.patchSnapshot((s) => ({
			...s,
			pending_page: page(501, s.pending_requests.length, "snap-cursor"),
		}));
		await h.store.loadSnapshot();
		h.store.navigate({
			view: "hq",
			repoId: null,
			taskId: null,
			requestId: null,
		});
		void h.store.loadInbox(null, null);
		expect(h.box[0]?.q).toEqual({
			limit: SNAPSHOT_INBOX_LIMIT,
			cursor: "snap-cursor",
		});
		h.box[0]?.resolve(
			ok({
				repo_id: null,
				kind: null,
				items: [req("wsa-c")],
				page: page(501, 1, null),
			}),
		);
		await tick();
		expect(h.store.getState().inbox).toMatchObject({
			key: inboxKey(null, null),
			status: "ready",
		});
		expect(h.store.getState().inbox?.items.map((r) => r.id)).toEqual(["wsa-c"]);
		// nothing more to continue: no automatic loop, no further read
		void h.store.loadInbox(null, null);
		expect(h.box).toHaveLength(1);
	});

	test("a failed FIRST continuation keeps the loaded first page and Retry continues from the snapshot's cursor again", async () => {
		const h = await signedIn();
		h.patchSnapshot((s) => ({
			...s,
			pending_page: page(501, s.pending_requests.length, "snap-cursor"),
		}));
		await h.store.loadSnapshot();
		h.store.navigate({
			view: "hq",
			repoId: null,
			taskId: null,
			requestId: null,
		});
		void h.store.loadInbox(null, null);
		h.box[0]?.resolve(lost);
		await tick();
		expect(h.store.getState().inbox).toMatchObject({
			status: "error",
			items: [],
		});
		// browser regression RR-04: the retry used to find no cursor and do nothing
		void h.store.loadInbox(null, null, true);
		expect(h.box[1]?.q).toEqual({
			limit: SNAPSHOT_INBOX_LIMIT,
			cursor: "snap-cursor",
		});
		h.box[1]?.resolve(
			ok({
				repo_id: null,
				kind: null,
				items: [req("wsa-c")],
				page: page(501, 1, null),
			}),
		);
		await tick();
		expect(h.store.getState().inbox?.items.map((r) => r.id)).toEqual(["wsa-c"]);
	});

	test("a repository filter is a server query; a late page of the previous filter is dropped", async () => {
		const h = await signedIn();
		h.store.navigate({
			view: "hq",
			repoId: null,
			taskId: null,
			requestId: null,
		});
		void h.store.loadInbox(REPO, null);
		expect(h.box[0]?.q).toEqual({ repo_id: REPO, limit: INBOX_PAGE_SIZE });
		void h.store.loadInbox(OTHER, "run");
		expect(h.box[1]?.q).toEqual({
			repo_id: OTHER,
			kind: "run",
			limit: INBOX_PAGE_SIZE,
		});
		h.box[0]?.resolve(
			ok({
				repo_id: REPO,
				kind: null,
				items: [req("wsa-a")],
				page: page(1, 1, null),
			}),
		);
		await tick();
		expect(h.store.getState().inbox).toMatchObject({
			key: inboxKey(OTHER, "run"),
			status: "loading",
			items: [],
		});
		h.box[1]?.resolve(
			ok({
				repo_id: OTHER,
				kind: "run",
				items: [req("wsa-o")],
				page: page(1, 1, null),
			}),
		);
		await tick();
		expect(h.store.getState().inbox?.items.map((r) => r.id)).toEqual(["wsa-o"]);
	});

	test("leaving Headquarters drops the inbox pages and any late answer", async () => {
		const h = await signedIn();
		h.store.navigate({
			view: "hq",
			repoId: null,
			taskId: null,
			requestId: null,
		});
		void h.store.loadInbox(REPO, null);
		h.store.navigate({
			view: "projects",
			repoId: REPO,
			taskId: null,
			requestId: null,
		});
		expect(h.store.getState().inbox).toBeNull();
		h.box[0]?.resolve(
			ok({
				repo_id: REPO,
				kind: null,
				items: [req("wsa-a")],
				page: page(1, 1, null),
			}),
		);
		await tick();
		expect(h.store.getState().inbox).toBeNull();
	});
});

describe("fresher task reads fold into the loaded rows (membership stays the server's)", () => {
	const coll = <S extends CollectionScope>(scope: S, items: any[]) => ({
		scope,
		key: collectionKey(scope),
		items,
		page: page(items.length, items.length, null),
		status: "ready" as const,
		error: null,
	});
	const view = (id: string, rev: number, requests: any[]) =>
		({
			task: { id, rev, repo_id: REPO },
			phase: "rejected",
			approval_requests: requests,
			acceptance_validity: null,
			engine: null,
		}) as any;
	const pending = (id: string, task: string, rev: number) =>
		({
			id,
			workspace_task_id: task,
			rev,
			status: "pending",
			repo_id: OTHER,
			task_title: "Paged",
		}) as any;

	test("a request decided after its page was read leaves the loaded inbox; other rows stay; an older read never regresses", () => {
		const inbox = coll(inboxScope(null, null), [
			pending("wsa-1", "wst-1", 1),
			pending("wsa-2", "wst-2", 1),
		]);
		const decided = foldTaskIntoCollections(
			{ history: null, inbox },
			view("wst-1", 3, [
				{ ...pending("wsa-1", "wst-1", 2), status: "rejected" },
			]),
		);
		expect(decided.inbox?.items.map((r) => r.id)).toEqual(["wsa-2"]);
		expect(decided.inbox?.page?.total).toBe(1); // the loaded total follows the proven departure
		// still pending with a newer revision: replaced, keeping the page's display ownership
		const bumped = foldTaskIntoCollections(
			{ history: null, inbox },
			view("wst-2", 3, [
				{ ...pending("wsa-2", "wst-2", 4), repo_id: undefined },
			]),
		);
		expect(bumped.inbox?.items.find((r) => r.id === "wsa-2")).toMatchObject({
			rev: 4,
			repo_id: OTHER,
		});
		// an OLDER read of the request never removes or regresses the row
		const newer = coll(inboxScope(null, null), [pending("wsa-1", "wst-1", 5)]);
		const stale = foldTaskIntoCollections(
			{ history: null, inbox: newer },
			view("wst-1", 2, [
				{ ...pending("wsa-1", "wst-1", 4), status: "rejected" },
			]),
		);
		expect(stale.inbox?.items).toEqual(newer.items);
		// membership is the server's: a task's other pending request is not added
		const other = foldTaskIntoCollections(
			{ history: null, inbox },
			view("wst-1", 3, [
				pending("wsa-1", "wst-1", 1),
				pending("wsa-9", "wst-1", 1),
			]),
		);
		expect(other.inbox?.items.map((r) => r.id)).toEqual(["wsa-1", "wsa-2"]);
	});

	test("the snapshot's pending total (TopBar) follows a folded decision when its first page was the whole set; a truncated page keeps the server's total", () => {
		const snap = (has_more: boolean) =>
			({
				tasks: [],
				pending_requests: [
					pending("wsa-1", "wst-1", 1),
					pending("wsa-2", "wst-2", 1),
				],
				pending_page: page(has_more ? 900 : 2, 2, has_more ? "c" : null),
			}) as any;
		const decided = view("wst-1", 3, [
			{ ...pending("wsa-1", "wst-1", 2), status: "rejected" },
		]);
		const whole = foldTaskIntoSnapshot(snap(false), decided);
		expect(whole?.pending_requests.map((r) => r.id)).toEqual(["wsa-2"]);
		expect(whole?.pending_page).toMatchObject({ total: 1, complete: true });
		const cut = foldTaskIntoSnapshot(snap(true), decided);
		expect(cut?.pending_page).toMatchObject({ total: 900, has_more: true });
	});

	test("a history row takes a fresher read of its task; an older read is ignored", () => {
		const history = coll(historyScope(REPO, "all"), [
			row("wst-1", 2),
			row("wst-2", 1),
		]);
		const fresh = foldTaskIntoCollections(
			{ history, inbox: null },
			view("wst-1", 3, []),
		);
		expect(fresh.history?.items[0]).toMatchObject({
			task: { rev: 3 },
			phase: "rejected",
		});
		const old = foldTaskIntoCollections(
			{ history, inbox: null },
			view("wst-1", 1, []),
		);
		expect(old.history?.items).toEqual(history.items);
	});
});
