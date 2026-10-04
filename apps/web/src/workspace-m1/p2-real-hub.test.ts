// biome-ignore-all lint/suspicious/noExplicitAny: raw HTTP bodies from the adversarial harness client
// P2 corrective regressions against a REAL isolated hub (docs/workspace-m1/CORRECTIVE_P2_2026-10-04.md):
// the independent review's store-level reproductions, kept as tests. The production store, briefing and
// Headquarters rendering talk to the production hub composition (adversarial harness: disposable fixture
// repositories + temp SQLite, 127.0.0.1 port 0, fake providers, live forced off). Only the transport's
// answers are held or failed by the test — never the product.
//   F-01 — one pending repository-A task, then 500 newer repository-B drafts.
//   F-02 — B withdrawn elsewhere, snapshot reads fail, +61 s, A detail succeeds.
//   F-03 — the decision is committed, the follow-up reads are held (Gate 1 and Gate 2).
// Fake adapters only: no provider executable is ever spawned (asserted: `providerSpawns() === 0`), so the
// file runs under `bun run test:unit` like any web test; the full gate still runs it through isolated.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type Client,
	composedHub,
	createTask,
	FakeClock,
	multiRepoFixture,
	openGate1,
	taskView,
	teardown,
	toGate2,
	waitFor,
} from "../../../hub/test/workspace-m1-adversarial/harness.ts";
import { repoBriefing } from "./briefing.ts";
import { HqView } from "./HqView.tsx";
import { StoreContext } from "./parts.tsx";
import { WorkspaceStore } from "./store.ts";
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
	const transport = {
		source: "hub",
		getSession: () => answer("/session"),
		getSnapshot: () => answer("/snapshot"),
		getTask: (id: string) => answer(`/tasks/${id}`),
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
			expect(html).toContain(`<option value="${A}">${A}</option>`);
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
