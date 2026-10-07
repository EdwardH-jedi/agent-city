// biome-ignore-all lint/suspicious/noExplicitAny: raw HTTP bodies from the adversarial harness client
// P2 corrective regressions against a REAL isolated hub (docs/workspace-m1/CORRECTIVE_P2_2026-10-04.md):
// the independent review's store-level reproductions, kept as tests. The production store, briefing and
// Headquarters rendering talk to the production hub composition (adversarial harness: disposable fixture
// repositories + temp SQLite, 127.0.0.1 port 0, fake providers, live forced off). Only the transport's
// answers are held or failed by the test — never the product.
//   F-01 — one pending repository-A task, then 500 newer repository-B drafts.
//   F-02 — B withdrawn elsewhere, snapshot reads fail, +61 s, A detail succeeds.
//   F-03 — the decision is committed, the follow-up reads are held (Gate 1 and Gate 2).
//   T0-FINAL-P2-01 — 501 loaded to the end; a second client closes tail X and opens Y in the same repository
//                    and gate (total, first page, cursor and per-repository counts unchanged).
//   T0-SAME-P2-01 — a held history page says `valid`; the bridge sweep records sticky `invalid` in the same
//                    millisecond; the page arrives after the task read.
// Fake adapters only: no provider executable is ever spawned (asserted: `providerSpawns() === 0`), so the
// file runs under `bun run test:unit` like any web test; the full gate still runs it through isolated.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { RepoId } from "@agent-city/schema/workspace-m1";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	approveGate1,
	type Client,
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
	toGate2,
	waitFor,
} from "../../../hub/test/workspace-m1-adversarial/harness.ts";
import { repoBriefing } from "./briefing.ts";
import { HqView } from "./HqView.tsx";
import { ProjectsView } from "./ProjectsView.tsx";
import { StoreContext } from "./parts.tsx";
import { pendingMembership, WorkspaceStore } from "./store.ts";
import type { WorkspaceTransport } from "./transport.ts";

afterAll(async () => {
	await teardown();
});

const SLOW = 180_000;

/** The production store's transport over the harness client; `gate` can hold or fail reads. */
function transportOver(c: Client) {
	const gate = {
		hold: null as Promise<void> | null,
		failSnapshot: false,
	};
	const answer = async (path: string) => {
		if (gate.hold && (path === "/snapshot" || path.startsWith("/tasks/")))
			await gate.hold;
		if (gate.failSnapshot && path === "/snapshot")
			return { ok: false, kind: "network", message: "test: no answer" };
		const r = await c.get(path);
		return r.status === 200
			? { ok: true, status: 200, data: r.body }
			: { ok: false, kind: "http", status: r.status, error: r.body };
	};
	const post = async (path: string, body: unknown) => {
		const r = await c.post(
			path,
			typeof body === "string" ? JSON.parse(body) : body,
		);
		return r.status < 300
			? { ok: true, status: r.status, data: r.body }
			: { ok: false, kind: "http", status: r.status, error: r.body };
	};
	const query = (q: object) =>
		new URLSearchParams(
			Object.entries(q).map(([k, v]) => [k, String(v)] as [string, string]),
		).toString();
	const transport = {
		source: "hub",
		getSession: () => answer("/session"),
		getSnapshot: () => answer("/snapshot"),
		getTask: (id: string) => answer(`/tasks/${id}`),
		getTaskHistory: (q: object) => answer(`/task-history?${query(q)}`),
		getInbox: (q: object) => answer(`/inbox?${query(q)}`),
		issueChallenge: (id: string, b: unknown) =>
			post(`/approval-requests/${id}/challenge`, b),
		decide: (id: string, b: unknown) =>
			post(`/approval-requests/${id}/decisions`, b),
	} as unknown as WorkspaceTransport;
	return { transport, gate };
}

const renderHq = (store: WorkspaceStore) =>
	renderToStaticMarkup(
		createElement(
			StoreContext.Provider,
			{ value: { store, state: store.getState() } },
			createElement(HqView),
		),
	);

const briefingOf = (store: WorkspaceStore, repoId: string, now: number) => {
	const s = store.getState();
	return repoBriefing({
		snapshot: s.snapshot,
		repoId,
		conn: s.conn,
		sync: s.snapshotSync,
		now,
	});
};

describe("P2 F-01 — real hub: 500 newer drafts in B never hide A's pending approval", () => {
	test(
		"A's request stays attributed to A in Headquarters; A's briefing is not empty; B's says what the window leaves out",
		async () => {
			const clock = new FakeClock();
			const H = composedHub({
				fixture: multiRepoFixture(["beta"]),
				manual: true,
				clock,
			});
			const c = await H.signIn();
			const [A, B] = H.fx.repos.map((r) => r.id) as [string, string];
			const old = await openGate1(
				c,
				H.fx,
				{ title: "A still awaiting approval" },
				A,
			);
			for (let i = 0; i < 500; i++) {
				clock.advance(1);
				await createTask(c, H.fx, { title: `B newer draft ${i}` }, B);
			}
			const { transport } = transportOver(c);
			const store = new WorkspaceStore({
				transport,
				now: () => clock.now().getTime(),
			});
			await store.boot();
			const snap = store.getState().snapshot as any;
			expect(snap.tasks.length).toBe(500);
			expect(snap.tasks.some((t: any) => t.task.id === old.taskId)).toBe(true);
			expect(snap.repo_task_counts).toEqual([
				{ repo_id: A, tasks: 1 },
				{ repo_id: B, tasks: 500 },
			]);
			// Headquarters: the inbox item (not the campus strip's document) names A — filter + label,
			// never "repository unknown"
			store.navigate({
				view: "hq",
				repoId: null,
				taskId: null,
				requestId: null,
			});
			const html = renderHq(store);
			const item = html.match(
				new RegExp(
					`<button[^>]*class="wsm1-item"[^>]*data-request-id="${old.req.id}"[^>]*>`,
				),
			)?.[0];
			expect(item).toContain(`data-repo-id="${A}"`);
			expect(html).toContain(`<span data-testid="inbox-repo">${A}</span>`);
			expect(html).not.toContain("repository unknown");
			// review repair APP-P2-02: every allowlisted repository is offered with its complete pending count
			expect(html).toContain(`<option value="${A}">${A} (1 pending)</option>`);
			// A's briefing: the pending approval, never "no tasks"
			const now = clock.now().getTime();
			const a = briefingOf(store, A, now);
			expect(a.state).toBe("attention");
			expect(a.summary).not.toContain("No tasks are recorded");
			expect(a.counts.needsApproval).toBe(1);
			expect(a.window).toEqual({ shown: 1, recorded: 1, complete: true });
			// B's briefing states its truncated window
			const b = briefingOf(store, B, now);
			expect(b.window).toEqual({ shown: 499, recorded: 500, complete: false });
			expect(b.summary).toContain("Showing 499 of 500 recorded tasks");
			expect((await taskView(c, old.taskId)).task.stage).toBe(
				"awaiting_run_approval",
			);
		},
		SLOW,
	);
});

describe("P2 F-02 — real hub: a fresh A detail never makes B's stale facts current", () => {
	test("B withdrawn elsewhere, snapshot reads fail, +61 s, A detail answers → B stale; a snapshot read resolves it", async () => {
		const clock = new FakeClock();
		const H = composedHub({
			fixture: multiRepoFixture(["beta"]),
			manual: true,
			clock,
		});
		const c = await H.signIn();
		const [A, B] = H.fx.repos.map((r) => r.id) as [string, string];
		const a = await openGate1(
			c,
			H.fx,
			{ title: "A detail remains reachable" },
			A,
		);
		const b = await openGate1(
			c,
			H.fx,
			{ title: "B approval is later withdrawn" },
			B,
		);
		const { transport, gate } = transportOver(c);
		const store = new WorkspaceStore({
			transport,
			now: () => clock.now().getTime(),
		});
		await store.boot();
		store.navigate({
			view: "projects",
			repoId: A,
			taskId: a.taskId,
			requestId: null,
		});
		await store.loadDetail(a.taskId);
		const confirmed = new Date(clock.now().getTime()).toISOString(); // the boot snapshot read
		const bv = await taskView(c, b.taskId);
		const cancel = await c.post(`/tasks/${b.taskId}/cancel`, {
			expected_rev: bv.task.rev,
		});
		expect(cancel.status).toBe(200);
		gate.failSnapshot = true;
		clock.advance(61_000);
		await store.refresh(); // the production path: failed snapshot + successful A detail
		store.navigate({
			view: "projects",
			repoId: B,
			taskId: null,
			requestId: null,
		});
		const now = clock.now().getTime();
		const stale = briefingOf(store, B, now);
		expect((await taskView(c, b.taskId)).task.stage).toBe("cancelled");
		expect(stale.freshness).not.toBe("current");
		expect(stale.freshnessLine).toContain(
			`last confirmed ${confirmed.slice(11, 19)} UTC`,
		);
		expect(stale.freshnessLine).not.toContain(
			`${new Date(now).toISOString().slice(11, 19)} UTC`,
		);
		gate.failSnapshot = false;
		await store.loadSnapshot();
		const fresh = briefingOf(store, B, clock.now().getTime());
		expect(fresh.freshness).toBe("current");
		expect(fresh.counts.needsApproval).toBe(0);
		expect(fresh.counts.cancelled).toBe(1);
	});
});

describe("P2 F-03 — real hub: the committed receipt closes the gate before the follow-up reads", () => {
	for (const gateKind of ["run", "result"] as const) {
		test(
			`Gate ${gateKind === "run" ? 1 : 2}: durable decision, reads held → no signature field, no second decision; reads reconcile`,
			async () => {
				const H = composedHub({
					fixture: multiRepoFixture(["beta"]),
					manual: gateKind === "run",
				});
				const c = await H.signIn();
				const A = H.fx.repos[0]?.id as string;
				const subject =
					gateKind === "run"
						? await openGate1(c, H.fx, { title: "Post-decision read gap" }, A)
						: await (async () => {
								const g = await toGate2(
									c,
									H.fx,
									{ title: "Result read gap" },
									A,
								);
								return { taskId: g.taskId, req: g.g2 };
							})();
				const { transport, gate } = transportOver(c);
				const store = new WorkspaceStore({ transport });
				await store.boot();
				store.navigate({
					view: "hq",
					repoId: null,
					taskId: subject.taskId,
					requestId: subject.req.id,
				});
				await store.loadDetail(subject.taskId);
				store.setSignature("Edward");
				await waitFor(() => store.getState().gate?.challenge.phase === "ready");
				let release!: () => void;
				gate.hold = new Promise<void>((r) => {
					release = r;
				});
				const deciding = store.decide(
					gateKind === "run" ? "approve" : "accept",
				);
				await waitFor(
					() =>
						store.getState().attempts[subject.req.id]?.status === "committed",
				);
				const durable = (
					await taskView(c, subject.taskId)
				).approval_requests.find((r: any) => r.id === subject.req.id)?.status;
				expect(durable).toBe(gateKind === "run" ? "approved" : "accepted");
				expect(store.findRequest(subject.taskId, subject.req.id)?.status).toBe(
					"pending",
				);
				const html = renderHq(store);
				expect(html.match(/<input[^>]*-sig"[^>]*>/g) ?? []).toEqual([]);
				expect(html).toContain('data-testid="decision-receipt"');
				expect(store.gateContext()?.pending).toBe(false);
				// a second attempt cannot reach the hub
				await store.decide(gateKind === "run" ? "approve" : "accept");
				const decisions = (await taskView(c, subject.taskId)).decisions.filter(
					(d: any) => d.approval_request_id === subject.req.id,
				);
				expect(decisions).toHaveLength(1);
				gate.hold = null;
				release();
				await deciding;
				expect(store.findRequest(subject.taskId, subject.req.id)?.status).toBe(
					durable,
				);
				expect(renderHq(store)).not.toContain('data-testid="decision-receipt"');
				expect(H.providerSpawns()).toBe(0);
			},
			SLOW,
		);
	}
});

describe("T0-RR-P3-01 — real hub: a legal repository id holding `|` keeps its exact scope", () => {
	test(
		"the hub accepts it; history survives same-repository selection; filtered HQ renders its request; the gate decides exactly that request",
		async () => {
			const repo = "local/review|scope";
			expect(RepoId.safeParse(repo).success).toBe(true);
			const H = composedHub({ manual: true, fixture: { repoId: repo } });
			const c = await H.signIn();
			const x = await openGate1(
				c,
				H.fx,
				{ title: "Legal delimiter repository" },
				repo,
			);
			const { transport } = transportOver(c);
			const store = new WorkspaceStore({ transport });
			await store.boot();
			// history of exactly this repository, kept when one of its tasks is selected
			store.navigate({
				view: "projects",
				repoId: repo,
				taskId: null,
				requestId: null,
			});
			await store.loadHistory(repo, "all");
			expect(store.getState().history?.items.map((t) => t.task.id)).toEqual([
				x.taskId,
			]);
			store.navigate({
				view: "projects",
				repoId: repo,
				taskId: x.taskId,
				requestId: null,
			});
			await store.loadDetail(x.taskId);
			expect(store.getState().history?.items).toHaveLength(1);
			expect(store.getState().history?.scope.repoId).toBe(repo);
			// the server-filtered inbox of exactly this repository, rendered with its full id
			store.navigate({
				view: "hq",
				repoId: null,
				taskId: null,
				requestId: null,
			});
			await store.loadInbox(repo, null);
			const html = renderHq(store);
			expect(html).toContain(`data-inbox-scope="${repo}"`);
			expect(html).toContain(`data-request-id="${x.req.id}"`);
			// the gate path is unchanged: challenge, exact signature, one decision bound to that request
			store.navigate({
				view: "hq",
				repoId: null,
				taskId: x.taskId,
				requestId: x.req.id,
			});
			await store.loadDetail(x.taskId);
			store.setSignature("Edward");
			await waitFor(() => store.getState().gate?.challenge.phase === "ready");
			await store.decide("approve");
			expect(store.getState().attempts[x.req.id]?.status).toBe("committed");
			const v = await taskView(c, x.taskId);
			expect(
				v.approval_requests.find((r: any) => r.id === x.req.id)?.status,
			).toBe("approved");
			expect(
				v.decisions.filter((d: any) => d.approval_request_id === x.req.id),
			).toHaveLength(1);
			await store.loadDetail(x.taskId);
			expect(store.getState().inbox?.items.some((r) => r.id === x.req.id)).toBe(
				false,
			);
			expect(H.providerSpawns()).toBe(0);
		},
		SLOW,
	);
});

describe("T0-FINAL-P2-01 — real hub: a same-total tail replacement reconciles the exhausted global inbox", () => {
	for (const gateKind of ["run", "result"] as const) {
		test(`Gate ${gateKind === "run" ? 1 : 2}: X closed + Y opened beyond the first page at 501 → X leaves, Load more reaches Y${gateKind === "run" ? "; then an arrival, an external close and idle polls" : ""}`, async () => {
			const clock = new FakeClock();
			const H = composedHub({ manual: true, clock });
			const c = await H.signIn();
			const second = await H.signIn();
			for (let i = 1; i <= 500; i++) {
				clock.advance(1);
				await openGate1(c, H.fx, { title: `First page ${i}` });
			}
			/** A pending request of `gateKind` in the fixture repository, opened by the second client. */
			const open = async (title: string) => {
				clock.advance(1);
				if (gateKind === "run") return openGate1(second, H.fx, { title });
				const g = await approveGate1(second, H.fx, { title });
				await H.drain();
				return {
					taskId: g.taskId,
					req: pendingOf(await taskView(second, g.taskId), "result"),
				};
			};
			const close = async (req: any) => {
				const ch = await issueChallenge(second, req);
				expect(
					(await decide(second, req, decisionBody(req, ch, "reject"))).status,
				).toBe(201);
			};
			const x = await open("Old tail X");
			expect(x.req?.kind).toBe(gateKind);
			const { transport } = transportOver(c);
			let inboxReads = 0;
			const counted = {
				...transport,
				getInbox: (q: any) => {
					inboxReads++;
					return transport.getInbox(q);
				},
			} as WorkspaceTransport;
			const store = new WorkspaceStore({
				transport: counted,
				now: () => clock.now().getTime(),
			});
			await store.boot();
			store.navigate({
				view: "hq",
				repoId: null,
				taskId: null,
				requestId: null,
			});
			const inbox = () =>
				renderHq(store).match(
					/<section aria-label="Approval inbox"[\s\S]*?<\/section>/,
				)?.[0] ?? "";
			const shows = (id: string) => inbox().includes(`data-request-id="${id}"`);
			const loadMore = () => inbox().includes('data-testid="inbox-load-more"');
			const poll = async (n: number) => {
				for (let i = 0; i < n; i++) {
					clock.advance(2000);
					await store.refresh();
				}
			};
			const before = store.getState().snapshot as any;
			expect(before.pending_page.total).toBe(501);
			expect(before.pending_requests.some((r: any) => r.id === x.req.id)).toBe(
				false,
			);
			await store.loadInbox(null, null, true);
			expect(store.getState().inbox?.items.map((r) => r.id)).toEqual([
				x.req.id,
			]);
			expect(store.getState().inbox?.page?.next_cursor).toBeNull();
			expect(loadMore()).toBe(false);

			// the reviewed attack: X closed and Y opened by another client, same repository and gate
			await close(x.req);
			const y = await open("New tail Y");
			const after = (await c.get("/snapshot")).body;
			expect(after.pending_page.total).toBe(501);
			expect(after.pending_requests.map((r: any) => r.id)).toEqual(
				before.pending_requests.map((r: any) => r.id),
			);
			expect(pendingMembership(after)).toBe(pendingMembership(before));
			expect(
				after.tasks.some((t: any) => [x.taskId, y.taskId].includes(t.task.id)),
			).toBe(false);
			await poll(20);
			expect(shows(x.req.id)).toBe(false);
			expect(loadMore()).toBe(true);
			expect(inboxReads).toBe(1); // the reset itself reads nothing
			await store.loadInbox(null, null, true); // the operator's Load more
			expect(inboxReads).toBe(2);
			expect(shows(y.req.id)).toBe(true);
			expect(shows(x.req.id)).toBe(false);
			expect(loadMore()).toBe(false);
			expect(inbox()).toContain("Showing 501 of 501 pending");
			// the server still refuses the closed request
			const retry = await second.post(
				`/approval-requests/${x.req.id}/challenge`,
				{
					kind: x.req.kind,
					binding_hash: x.req.binding_hash,
					expected_request_rev: x.req.rev,
				},
			);
			expect(retry.status).toBe(409);
			// what moved: only the hub's membership generation of the global scope
			expect(after.pending_page.membership_generation).not.toBe(
				before.pending_page.membership_generation,
			);
			expect(after.pending_page.membership_generation).toMatch(/:501$/);

			if (gateKind === "run") {
				// 501 → 502: an arrival after the end is reachable on demand
				const z = await open("Arrival Z");
				await poll(2);
				expect(shows(z.req.id)).toBe(false);
				expect(loadMore()).toBe(true);
				expect(inboxReads).toBe(2);
				await store.loadInbox(null, null, true);
				expect(inboxReads).toBe(3);
				expect(shows(y.req.id) && shows(z.req.id)).toBe(true);
				expect(inbox()).toContain("Showing 502 of 502 pending");
				// a cached tail request closed elsewhere leaves without a read
				await close(z.req);
				await poll(1);
				expect(shows(z.req.id)).toBe(false);
				expect(inboxReads).toBe(3);
				// idle: unchanged polls never read the inbox or load anything by themselves
				await poll(20);
				expect(inboxReads).toBe(3);
				expect(loadMore()).toBe(true);
			}
			expect(H.providerSpawns()).toBe(0);
		}, 240_000);
	}
});

describe("T0-SAME-P2-01 — real hub: an equal-time sweep verdict survives a delayed history page", () => {
	test(
		"held page `valid` @T; bridge sweep `invalid` @T; task read; page released; 20 polls → the history row stays invalid",
		async () => {
			const clock = new FakeClock();
			const H = composedHub({ manual: true, clock });
			const c = await H.signIn();
			const g = await openGate1(c, H.fx, {
				title: "Equal-time accepted result",
			});
			for (let i = 0; i < 50; i++) {
				clock.advance(1);
				await createTask(c, H.fx, { title: `Newer draft ${i}` });
			}
			const ch1 = await issueChallenge(c, g.req);
			expect(
				(await decide(c, g.req, decisionBody(g.req, ch1, "approve"))).status,
			).toBe(201);
			await H.drain();
			const result = pendingOf(await taskView(c, g.taskId), "result");
			const ch2 = await issueChallenge(c, result);
			const accepted = await decide(
				c,
				result,
				decisionBody(result, ch2, "accept"),
			);
			expect(accepted.status).toBe(201);
			const { transport } = transportOver(c);
			let release!: () => void;
			const hold = new Promise<void>((r) => {
				release = r;
			});
			let page!: (r: any) => void;
			const held = new Promise<any>((r) => {
				page = r;
			});
			const holding = {
				...transport,
				getTaskHistory: async (q: any) => {
					const r = await transport.getTaskHistory(q);
					if (q.cursor) {
						page(r);
						await hold;
					}
					return r;
				},
			} as WorkspaceTransport;
			const store = new WorkspaceStore({
				transport: holding,
				now: () => clock.now().getTime(),
			});
			await store.boot();
			store.navigate({
				view: "projects",
				repoId: H.fx.repoId,
				taskId: null,
				requestId: null,
			});
			await store.loadHistory(H.fx.repoId, "all");
			expect(store.getState().history?.items).toHaveLength(50);
			const more = store.loadHistory(H.fx.repoId, "all", true);
			const stale = (await held) as any;
			const staleRow = stale.data.items[0];
			expect(staleRow.task.id).toBe(g.taskId);
			expect(staleRow.acceptance_validity.status).toBe("valid");
			// the production sweep records sticky invalid in the same millisecond as the page's check
			rmSync(
				join(
					H.fx.config.artifacts_root,
					"_sealed",
					`${accepted.body.receipt.effects.evidence_bundle_digest}.bundle`,
				),
			);
			expect((await H.bridge.sweep()).accepted_invalid).toBe(1);
			await store.loadDetail(g.taskId);
			const known = store.detail(g.taskId)?.acceptance_validity;
			expect(known?.status).toBe("invalid");
			expect(known?.checked_at).toBe(staleRow.acceptance_validity.checked_at);
			expect(store.detail(g.taskId)?.task.rev).toBe(staleRow.task.rev);
			release();
			await more;
			for (let i = 0; i < 20; i++) {
				clock.advance(2000);
				await store.refresh();
			}
			const row = store
				.getState()
				.history?.items.find((x) => x.task.id === g.taskId);
			expect(row?.acceptance_validity?.status).toBe("invalid");
			const html = renderToStaticMarkup(
				createElement(
					StoreContext.Provider,
					{ value: { store, state: store.getState() } },
					createElement(ProjectsView),
				),
			);
			// the other 50 rows are drafts without a validity: the badge can only be this task's
			const history =
				html.match(
					/<section aria-label="Repository history"[\s\S]*?<\/section>/,
				)?.[0] ?? "";
			expect(history).toContain('data-validity="invalid"');
			expect(history).not.toContain('data-validity="valid"');
			expect((await taskView(c, g.taskId)).acceptance_validity.status).toBe(
				"invalid",
			);
			expect(H.providerSpawns()).toBe(0);
		},
		SLOW,
	);
});
