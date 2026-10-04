// P2 corrective regressions (docs/workspace-m1/CORRECTIVE_P2_2026-10-04.md), store + rendered HQ against
// the fixture transport, with deterministic barriers (no timing):
//   F-02 — repository facts age with the last successful SNAPSHOT read; a successful detail read of one
//          task (or general connection liveness) never certifies them.
//   F-03 — the hub's receipt of OUR committed decision closes exactly that request's confirmation
//          controls at once, before the follow-up reads close the cached request.
// The same reproductions against a real isolated hub are in p2-real-hub.test.ts.
import { describe, expect, test } from "bun:test";
import {
	criteriaFromText,
	emptyDraft,
	type WorkspaceTaskDetail,
} from "@agent-city/schema/workspace-m1";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { repoBriefing } from "./briefing.ts";
import {
	createFixtureTransport,
	type FixtureTransport,
} from "./fixture-transport.ts";
import { HqView } from "./HqView.tsx";
import { OUTCOME_UNKNOWN, SNAPSHOT_STALE_AFTER_MS } from "./labels.ts";
import { StoreContext } from "./parts.tsx";
import { WorkspaceStore } from "./store.ts";
import type { TransportResult, WorkspaceTransport } from "./transport.ts";

const A_REPO = "local/fixture";
const B_REPO = "local/empty-sandbox";
const T0 = Date.parse("2026-10-04T03:00:00.000Z");

type Outcome = "ok" | "network" | "http";
type Read = "getSnapshot" | "getTask";

/** A deferred: resolve it to let a held call continue (deterministic ordering). */
function deferred() {
	let open!: () => void;
	const p = new Promise<void>((r) => {
		open = r;
	});
	return { p, open };
}

/**
 * Wraps the fixture transport: per-call plans for reads (hold on a barrier, then answer ok / no answer /
 * an HTTP error), a global read barrier, a hold on decision ANSWERS (the hub commits, the answer waits),
 * and a log of decision and challenge calls.
 */
function control(inner: WorkspaceTransport) {
	const plans: Record<Read, { hold?: Promise<void>; outcome: Outcome }[]> = {
		getSnapshot: [],
		getTask: [],
	};
	let readBarrier: Promise<void> | null = null;
	let answerBarrier: Promise<void> | null = null;
	const calls = { decide: [] as string[], challenge: 0 };
	const failure = (o: Outcome): TransportResult<never> =>
		o === "network"
			? { ok: false, kind: "network", message: "test: no answer" }
			: {
					ok: false,
					kind: "http",
					status: 503,
					error: { error: "disabled", message: "test: unavailable" },
				};
	const transport = new Proxy(inner, {
		get(target, prop, recv) {
			const v = Reflect.get(target, prop, recv);
			if (typeof v !== "function") return v;
			return async (...args: unknown[]) => {
				if (prop === "decide") calls.decide.push(args[1] as string);
				if (prop === "issueChallenge") calls.challenge++;
				if (prop === "getSnapshot" || prop === "getTask") {
					const plan = plans[prop].shift();
					if (readBarrier) await readBarrier;
					if (plan?.hold) await plan.hold;
					if (plan && plan.outcome !== "ok") return failure(plan.outcome);
				}
				const result = await (v as (...a: unknown[]) => unknown).apply(
					target,
					args,
				);
				if (prop === "decide" && answerBarrier) await answerBarrier;
				return result;
			};
		},
	}) as WorkspaceTransport;
	const barrier = (set: (p: Promise<void> | null) => void) => {
		const d = deferred();
		set(d.p);
		return () => {
			set(null);
			d.open();
		};
	};
	return {
		transport,
		calls,
		plan: (m: Read, outcome: Outcome, hold?: Promise<void>) =>
			plans[m].push({ outcome, ...(hold ? { hold } : {}) }),
		/** Hold every read until the returned release is called. */
		holdReads: () =>
			barrier((p) => {
				readBarrier = p;
			}),
		/** The hub decides at once; its answer is delivered only on release. */
		holdDecisionAnswers: () =>
			barrier((p) => {
				answerBarrier = p;
			}),
	};
}

const flush = async () => {
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

let keyN = 0;
async function makeTask(tx: FixtureTransport, repo: string, title: string) {
	const c = await tx.createTask({
		idempotency_key: `p2-create-${++keyN}`,
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

async function setup() {
	let t = T0;
	const tx = createFixtureTransport({ now: () => t });
	const A = await makeTask(tx, A_REPO, "A detail stays reachable");
	const B = await makeTask(tx, B_REPO, "B approval is later withdrawn");
	const ctl = control(tx);
	const store = new WorkspaceStore({
		transport: ctl.transport,
		now: () => t,
		random: () => `p2-rnd-${++keyN}`,
	});
	await store.boot();
	return {
		tx,
		ctl,
		store,
		A,
		B,
		now: () => t,
		tick: (ms: number) => {
			t += ms;
		},
	};
}

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

const iso = (ms: number) => new Date(ms).toISOString();
const clock = (ms: number) => `${iso(ms).slice(11, 19)} UTC`;

async function withdrawB(tx: FixtureTransport, taskId: string) {
	const v = await tx.getTask(taskId);
	if (!v.ok) throw new Error("read B");
	const c = await tx.cancel(taskId, { expected_rev: v.data.task.rev });
	if (!c.ok) throw new Error("cancel B");
}

describe("P2 F-02 — an unrelated detail read never makes stale repository facts current", () => {
	test("the reviewed sequence: B withdrawn elsewhere, snapshot reads fail, +61 s, A detail succeeds → B stays stale", async () => {
		const { tx, ctl, store, A, B, now, tick } = await setup();
		store.navigate({
			view: "projects",
			repoId: A_REPO,
			taskId: A.taskId,
			requestId: null,
		});
		await flush();
		const confirmedBefore = iso(T0); // the boot snapshot read
		await withdrawB(tx, B.taskId); // another client
		tick(61_000);
		ctl.plan("getSnapshot", "network");
		await store.refresh(); // snapshot: no answer · A detail: answered
		store.navigate({
			view: "projects",
			repoId: B_REPO,
			taskId: null,
			requestId: null,
		});
		const s = store.getState();
		// the connection is live again (A answered) — that is all it proves
		expect(s.conn.status).toBe("online");
		expect(s.conn.lastConfirmedAt).toBe(iso(now()));
		const b = briefingOf(store, B_REPO, now());
		expect(b.freshness).toBe("stale");
		expect(b.freshnessLine).toContain(`last confirmed ${clock(T0)}`);
		expect(b.freshnessLine).not.toContain(clock(now()));
		// last-known data is kept, and labelled stale (the withdrawal is not known yet)
		expect(b.counts.needsApproval).toBe(1);
		expect(s.snapshotSync).toEqual({
			confirmedAt: confirmedBefore,
			failedAt: iso(now()),
		});

		// an authoritative snapshot read resolves it: current, and B's withdrawal is shown
		await store.loadSnapshot();
		const after = briefingOf(store, B_REPO, now());
		expect(after.freshness).toBe("current");
		expect(after.freshnessLine).toBe(
			`From the UI fixture record confirmed at ${clock(now())}.`,
		);
		expect(after.counts.needsApproval).toBe(0);
		expect(after.counts.cancelled).toBe(1);
	});

	test("both completion orders of a mixed refresh: detail-first-then-snapshot-fails is offline, never current", async () => {
		const { ctl, store, A, now, tick } = await setup();
		store.navigate({
			view: "projects",
			repoId: A_REPO,
			taskId: A.taskId,
			requestId: null,
		});
		await flush();
		tick(61_000);
		const snapAnswer = deferred();
		ctl.plan("getSnapshot", "network", snapAnswer.p);
		const refreshing = store.refresh();
		await flush(); // A's detail answers first
		expect(store.getState().conn.lastConfirmedAt).toBe(iso(now()));
		expect(briefingOf(store, A_REPO, now()).freshness).toBe("stale");
		snapAnswer.open(); // then the snapshot read fails
		await refreshing;
		expect(store.getState().conn.status).toBe("offline");
		const b = briefingOf(store, A_REPO, now());
		expect(b.freshness).toBe("offline");
		expect(b.freshnessLine).toContain(`last confirmed ${clock(T0)}`);
	});

	test("an HTTP error on the snapshot keeps the connection online but the facts stale", async () => {
		const { ctl, store, now, tick } = await setup();
		tick(1_000);
		ctl.plan("getSnapshot", "http");
		await store.loadSnapshot();
		expect(store.getState().conn.status).toBe("online");
		const b = briefingOf(store, A_REPO, now());
		expect(b.freshness).toBe("stale");
		expect(b.freshnessLine).toContain("the latest read failed");
		expect(b.freshnessLine).toContain(`last confirmed ${clock(T0)}`);
	});

	test("repeated failures keep the original confirmation time; detail reads in between never reset it", async () => {
		const { ctl, store, A, now, tick } = await setup();
		for (let i = 0; i < 3; i++) {
			tick(5_000);
			ctl.plan("getSnapshot", "network");
			await store.loadSnapshot();
			await store.loadDetail(A.taskId);
			expect(store.getState().snapshotSync).toEqual({
				confirmedAt: iso(T0),
				failedAt: iso(now()),
			});
			expect(briefingOf(store, A_REPO, now()).freshness).toBe("stale");
		}
	});

	test("threshold with an injected clock: current up to SNAPSHOT_STALE_AFTER_MS after the read, stale after", async () => {
		const { store, A, now, tick } = await setup();
		tick(SNAPSHOT_STALE_AFTER_MS);
		// a detail read keeps the CONNECTION fresh, isolating the snapshot rule
		await store.loadDetail(A.taskId);
		expect(briefingOf(store, A_REPO, now()).freshness).toBe("current");
		tick(1);
		await store.loadDetail(A.taskId);
		expect(briefingOf(store, A_REPO, now()).freshness).toBe("stale");
		await store.loadSnapshot();
		expect(briefingOf(store, A_REPO, now()).freshness).toBe("current");
	});

	test("out-of-order snapshot answers: a late older success never clears a newer failure, nor a late failure a newer success", async () => {
		const { ctl, store, now, tick } = await setup();
		tick(1_000);
		const older = deferred();
		ctl.plan("getSnapshot", "ok", older.p);
		const first = store.loadSnapshot(); // held; will succeed late
		ctl.plan("getSnapshot", "http"); // an answer (connection online): isolates the snapshot rule
		await store.loadSnapshot(); // the newer read fails now
		older.open();
		await first;
		expect(store.getState().snapshotSync.failedAt).toBe(iso(now()));
		expect(briefingOf(store, A_REPO, now()).freshness).toBe("stale");

		tick(1_000);
		const olderFail = deferred();
		ctl.plan("getSnapshot", "network", olderFail.p);
		const second = store.loadSnapshot(); // held; will fail late
		await store.loadSnapshot(); // the newer read succeeds now
		olderFail.open();
		await second;
		expect(store.getState().snapshotSync).toEqual({
			confirmedAt: iso(now()),
			failedAt: null,
		});
		expect(briefingOf(store, A_REPO, now()).freshness).toBe("current");
	});

	test("switching repositories neither refreshes nor ages the facts; signing out drops the confirmation", async () => {
		const { ctl, store, now, tick } = await setup();
		tick(2_000);
		ctl.plan("getSnapshot", "http");
		await store.loadSnapshot();
		for (const repoId of [B_REPO, A_REPO, B_REPO]) {
			store.navigate({
				view: "projects",
				repoId,
				taskId: null,
				requestId: null,
			});
			expect(store.getState().snapshotSync.confirmedAt).toBe(iso(T0));
			expect(briefingOf(store, repoId, now()).freshness).toBe("stale");
		}
		await store.signOut();
		expect(store.getState().snapshotSync).toEqual({
			confirmedAt: null,
			failedAt: null,
		});
	});
});

const renderHq = (store: WorkspaceStore) =>
	renderToStaticMarkup(
		createElement(
			StoreContext.Provider,
			{ value: { store, state: store.getState() } },
			createElement(HqView),
		),
	);
const signatureInputs = (html: string) =>
	(html.match(/<input[^>]*-sig"[^>]*>/g) ?? []).length;

async function openGate(
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

/** Gate 2 of task `x`: approve its Gate 1, run the fixture engine to human_ready. */
async function toResult(
	tx: FixtureTransport,
	store: WorkspaceStore,
	x: { taskId: string; requestId: string },
) {
	await openGate(store, x);
	await store.decide("approve");
	tx.controls.runToEnd(x.taskId);
	await store.refresh();
	const d = store.detail(x.taskId) as WorkspaceTaskDetail;
	const r = d.approval_requests.find(
		(q) => q.kind === "result" && q.status === "pending",
	);
	if (!r) throw new Error("no pending result request");
	return { taskId: x.taskId, requestId: r.id };
}

describe("P2 F-03 — a committed decision closes its confirmation controls from the receipt", () => {
	for (const gate of ["run", "result"] as const) {
		test(`Gate ${gate === "run" ? 1 : 2}: reads held after the hub committed → controls closed at once; one POST; reads reconcile`, async () => {
			const { tx, ctl, store, A } = await setup();
			const subject = gate === "run" ? A : await toResult(tx, store, A);
			const action = gate === "run" ? "approve" : "accept";
			await openGate(store, subject);
			const postsBefore = ctl.calls.decide.length;
			const release = ctl.holdReads();
			const deciding = store.decide(action);
			await flush(); // the decision is committed and answered; the follow-up reads are held
			expect(store.getState().attempts[subject.requestId]?.status).toBe(
				"committed",
			);
			// the cached request is still pending (the reads have not answered)…
			const req = store.findRequest(subject.taskId, subject.requestId);
			expect(req?.status).toBe("pending");
			// …but the receipt closes it now: no signature field, no grant button, a closed statement
			const html = renderHq(store);
			expect(signatureInputs(html)).toBe(0);
			expect(html).not.toContain(
				gate === "run" ? "Approve execution" : "Accept result",
			);
			expect(html).toContain("No further decision is possible on it.");
			expect(html).toContain('data-testid="decision-receipt"');
			expect(store.gateContext()?.pending).toBe(false);
			expect(store.committedReceipt(req)?.approval_request_id).toBe(
				subject.requestId,
			);
			// duplicate interaction: no new challenge, no second decision
			const challenges = ctl.calls.challenge;
			store.setSignature("Edward");
			await store.decide(action);
			await flush();
			expect(ctl.calls.challenge).toBe(challenges);
			expect(ctl.calls.decide.length).toBe(postsBefore + 1);
			// later reads reconcile: the request is closed by its own record, still no controls
			release();
			await deciding;
			const closed = store.findRequest(subject.taskId, subject.requestId);
			expect(closed?.status).toBe(gate === "run" ? "approved" : "accepted");
			const after = renderHq(store);
			expect(signatureInputs(after)).toBe(0);
			expect(after).not.toContain('data-testid="decision-receipt"');
			expect(after).toContain("No further decision is possible on it.");
		});
	}

	test("subject switching: A's receipt never closes B; B's own gate stays usable", async () => {
		const { ctl, store, A, B } = await setup();
		await openGate(store, A);
		const release = ctl.holdReads();
		const deciding = store.decide("approve");
		await flush();
		store.navigate({
			view: "hq",
			repoId: null,
			taskId: B.taskId,
			requestId: B.requestId,
		});
		release();
		await deciding;
		await flush();
		expect(store.gateContext()?.pending).toBe(true);
		store.setSignature("Edward");
		await flush();
		const html = renderHq(store);
		expect(signatureInputs(html)).toBe(1);
		expect(html).not.toContain('data-testid="decision-receipt"');
		expect(store.getState().gate?.challenge.phase).toBe("ready");
	});

	test("a late receipt for A, answering after B was selected, does not close B", async () => {
		const { ctl, store, A, B } = await setup();
		await openGate(store, A);
		const release = ctl.holdDecisionAnswers();
		const deciding = store.decide("approve"); // the hub commits; the answer waits
		await flush();
		store.navigate({
			view: "hq",
			repoId: null,
			taskId: B.taskId,
			requestId: B.requestId,
		});
		await flush();
		release();
		await deciding;
		await flush();
		expect(store.getState().attempts[A.requestId]?.status).toBe("committed");
		expect(store.getState().route.requestId).toBe(B.requestId);
		expect(store.gateContext()?.pending).toBe(true);
		expect(signatureInputs(renderHq(store))).toBe(1);
	});

	test("an unknown outcome is not a receipt: “Check decision outcome” stays, and the retry has exactly one effect", async () => {
		const { tx, ctl, store, A } = await setup();
		await openGate(store, A);
		tx.controls.setDecisionFault("network_before_commit");
		const release = ctl.holdReads();
		const deciding = store.decide("approve");
		await flush();
		expect(store.getState().attempts[A.requestId]?.status).toBe("unknown");
		const req = store.findRequest(A.taskId, A.requestId);
		expect(store.committedReceipt(req)).toBeNull();
		expect(store.decisionStatus(A.requestId)).toBe(OUTCOME_UNKNOWN);
		const html = renderHq(store);
		expect(html).toContain("Check decision outcome");
		expect(html).not.toContain('data-testid="decision-receipt"');
		release();
		await deciding;
		await store.retryDecision(A.requestId);
		expect(ctl.calls.decide).toHaveLength(2);
		expect(ctl.calls.decide[1]).toBe(ctl.calls.decide[0] as string);
		expect(store.getState().attempts[A.requestId]?.status).toBe("committed");
		const d = store.detail(A.taskId) as WorkspaceTaskDetail;
		expect(
			d.decisions.filter((x) => x.approval_request_id === A.requestId),
		).toHaveLength(1);
	});

	test("signing out drops the receipt with every other attempt (auth generation)", async () => {
		const { ctl, store, A } = await setup();
		await openGate(store, A);
		const release = ctl.holdReads();
		const deciding = store.decide("approve");
		await flush();
		const req = store.findRequest(A.taskId, A.requestId);
		expect(store.committedReceipt(req)).not.toBeNull();
		release();
		await deciding;
		await store.signOut();
		expect(store.committedReceipt(req)).toBeNull();
	});
});
