// Workspace store (role 07) against the fixture transport, with a wrapper that can hold, fail or
// lose individual answers. Pins: stale-response rejection (A→B, viewer, auth generations, late
// 401), signature clearing, the own-challenge rev bump, decision retry-key reuse, single dispatch,
// draft flow and unknown command outcomes.
import { describe, expect, test } from "bun:test";
import {
	criteriaFromText,
	emptyDraft,
	type WorkspaceTaskDetail,
} from "@agent-city/schema/workspace-m1";
import {
	type DraftForm,
	formCriteria,
	newDraftForm,
	toggleCheck,
} from "./draft-form.ts";
import {
	createFixtureTransport,
	type FixtureTransport,
} from "./fixture-transport.ts";
import { OUTCOME_UNKNOWN } from "./labels.ts";
import {
	foldTaskIntoSnapshot,
	isOlderDetail,
	mergeSnapshot,
	WorkspaceStore,
} from "./store.ts";
import type { TransportResult, WorkspaceTransport } from "./transport.ts";

type Method = Exclude<keyof WorkspaceTransport, "source">;

/** Wraps a transport: hold (deliver later), fail (no call) or lose (call, then no answer). */
function wrap(inner: WorkspaceTransport) {
	const holds = new Map<Method, number>();
	const waiting = new Map<Method, (() => void)[]>();
	const fails = new Map<Method, number>();
	const loses = new Map<Method, number>();
	const decideBodies: string[] = [];
	const take = (m: Map<Method, number>, k: Method) => {
		const n = m.get(k) ?? 0;
		if (n > 0) m.set(k, n - 1);
		return n > 0;
	};
	const transport = { source: inner.source } as WorkspaceTransport;
	const methods: Method[] = [
		"getSession",
		"signIn",
		"signOut",
		"getSnapshot",
		"createTask",
		"getTask",
		"saveDraft",
		"publishProposal",
		"requestRerun",
		"cancel",
		"getArtifact",
		"issueChallenge",
		"decide",
	];
	for (const name of methods) {
		const fn = (
			inner[name] as (...a: unknown[]) => Promise<TransportResult<unknown>>
		).bind(inner);
		(transport as unknown as Record<string, unknown>)[name] = async (
			...args: unknown[]
		) => {
			if (name === "decide") decideBodies.push(args[1] as string);
			if (take(fails, name))
				return { ok: false, kind: "network", message: "test: offline" };
			const result = await fn(...args);
			if (take(loses, name))
				return { ok: false, kind: "network", message: "test: lost" };
			if (take(holds, name))
				await new Promise<void>((resolve) => {
					waiting.set(name, [...(waiting.get(name) ?? []), resolve]);
				});
			return result;
		};
	}
	return {
		transport,
		decideBodies,
		hold: (m: Method) => holds.set(m, (holds.get(m) ?? 0) + 1),
		release: (m: Method) => {
			const list = waiting.get(m) ?? [];
			list.shift()?.();
			waiting.set(m, list);
		},
		fail: (m: Method) => fails.set(m, (fails.get(m) ?? 0) + 1),
		lose: (m: Method) => loses.set(m, (loses.get(m) ?? 0) + 1),
	};
}

const flush = async () => {
	for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

let keyN = 0;
const key = () => `store-test-${++keyN}`;

async function setup(opts: { readOnly?: boolean } = {}) {
	let t = Date.parse("2026-10-02T00:00:00.000Z");
	const tx: FixtureTransport = createFixtureTransport({ now: () => t });
	const make = async (title: string) => {
		const c = await tx.createTask({
			idempotency_key: key(),
			repo_id: "local/fixture",
			draft: {
				...emptyDraft(),
				title,
				objective: `Objective of ${title}`,
				criteria: criteriaFromText("Build passes, lint passes\nDocs updated"),
				scope: { allowed: ["."], protected: [] },
				// v1.2: publish fails closed without a complete criterion → check mapping
				criterion_checks: [
					{ criterion: "Build passes, lint passes", checks: ["unit", "lint"] },
					{ criterion: "Docs updated", checks: ["unit"] },
				],
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
	};
	const A = await make("Task A");
	const B = await make("Task B");
	if (opts.readOnly) tx.controls.setReadOnly(true);
	const w = wrap(tx);
	let r = 0;
	const store = new WorkspaceStore({
		transport: w.transport,
		now: () => t,
		random: () => `rnd-${++r}`,
	});
	await store.boot();
	const hq = (x: { taskId: string; requestId: string }) =>
		store.navigate({
			view: "hq",
			repoId: null,
			taskId: x.taskId,
			requestId: x.requestId,
		});
	const project = (taskId: string | null) =>
		store.navigate({
			view: "projects",
			repoId: "local/fixture",
			taskId,
			requestId: null,
		});
	return {
		tx,
		w,
		store,
		A,
		B,
		hq,
		project,
		tick: (ms: number) => {
			t += ms;
		},
	};
}

const selected = (s: WorkspaceStore) => s.detail(s.getState().route.taskId);

describe("stale responses are dropped", () => {
	test("task A's late answer never replaces the selected task B (A→B)", async () => {
		const { store, w, A, B, project } = await setup();
		w.hold("getTask");
		project(A.taskId);
		project(B.taskId);
		await flush();
		expect(selected(store)?.task.id).toBe(B.taskId);
		w.release("getTask");
		await flush();
		expect(store.getState().route.taskId).toBe(B.taskId);
		expect(selected(store)?.task.id).toBe(B.taskId);
	});

	test("an older read of the same task is dropped (latest request wins)", async () => {
		const { store, w, tx, A, project } = await setup();
		project(A.taskId);
		await flush();
		const rev1 = selected(store)?.task.rev as number;
		w.hold("getTask");
		void store.loadDetail(A.taskId); // held, carries rev1
		const saved = await tx.saveDraft(A.taskId, {
			expected_rev: rev1,
			draft: selected(store)?.task
				.draft as WorkspaceTaskDetail["task"]["draft"],
		});
		expect(saved.ok).toBe(true);
		await store.loadDetail(A.taskId);
		expect(selected(store)?.task.rev).toBe(rev1 + 1);
		w.release("getTask");
		await flush();
		expect(selected(store)?.task.rev).toBe(rev1 + 1);
	});

	test("rev-monotonic merge rules", () => {
		const d = (rev: number, engineRev: number, reqRev: number) =>
			({
				task: { id: "x", rev },
				engine: { managed_task_id: "m", rev: engineRev },
				approval_requests: [{ id: "r", rev: reqRev }],
			}) as unknown as WorkspaceTaskDetail;
		expect(isOlderDetail(d(1, 5, 5), d(2, 1, 1))).toBe(true);
		expect(isOlderDetail(d(2, 4, 5), d(2, 5, 5))).toBe(true);
		expect(isOlderDetail(d(2, 5, 4), d(2, 5, 5))).toBe(true);
		expect(isOlderDetail(d(2, 5, 5), d(2, 5, 5))).toBe(false);
		expect(isOlderDetail(d(3, 1, 1), d(2, 5, 5))).toBe(false);
		const snap = (rev: number) =>
			({
				tasks: [{ task: { id: "x", rev }, phase: "planning" }],
				pending_requests: [],
			}) as never;
		expect(mergeSnapshot(snap(3), snap(2)).tasks[0]?.task.rev).toBe(3);
		expect(mergeSnapshot(snap(2), snap(3)).tasks[0]?.task.rev).toBe(3);
	});

	test("a late challenge for request A never binds to request B", async () => {
		const { store, w, A, B, hq } = await setup();
		hq(A);
		await flush();
		w.hold("issueChallenge");
		store.setSignature("Edward");
		await flush();
		expect(store.getState().gate?.challenge.phase).toBe("loading");
		hq(B);
		await flush();
		expect(store.getState().gate?.requestId).toBe(B.requestId);
		expect(store.getState().gate?.signature).toBe("");
		w.release("issueChallenge");
		await flush();
		expect(store.getState().gate?.challenge.phase).toBe("none");
		store.setSignature("Edward");
		await flush();
		await store.decide("approve");
		const sent = JSON.parse(w.decideBodies.at(-1) as string);
		const bReq = store.findRequest(B.taskId, B.requestId);
		expect(sent.binding_hash).toBe(bReq?.binding_hash as string);
		expect(store.findRequest(A.taskId, A.requestId)?.status).toBe("pending");
		expect(bReq?.status).toBe("approved");
	});

	test("evidence viewer: closed stays closed; a late diff never replaces the manifest", async () => {
		const { store, w, tx, A, hq, project } = await setup();
		hq(A);
		await flush();
		store.setSignature("Edward");
		await flush();
		await store.decide("approve");
		tx.controls.runToEnd(A.taskId);
		project(A.taskId);
		await store.loadDetail(A.taskId);
		const arts = selected(store)?.artifacts ?? [];
		const diff = arts.find((a) => a.kind === "diff");
		const manifest = arts.find((a) => a.kind === "manifest");
		if (!diff || !manifest) throw new Error("artifacts");
		w.hold("getArtifact");
		void store.openArtifact(A.taskId, diff, "opener-diff");
		store.closeArtifact();
		w.release("getArtifact");
		await flush();
		expect(store.getState().viewer).toBeNull();
		w.hold("getArtifact");
		void store.openArtifact(A.taskId, diff, "opener-diff");
		await store.openArtifact(A.taskId, manifest, "opener-manifest");
		w.release("getArtifact");
		await flush();
		expect(store.getState().viewer?.artifactId).toBe(manifest.artifact_id);
		expect(store.getState().viewer?.state).toBe("ok");
		// leaving the subject closes the viewer
		project(null);
		expect(store.getState().viewer).toBeNull();
	});

	test("answers of an old auth generation are dropped; a late 401 cannot sign the new session out", async () => {
		const { store, w, tx, A, project } = await setup();
		w.hold("getSnapshot");
		void store.loadSnapshot();
		await store.signOut();
		expect(store.getState().snapshot).toBeNull();
		await store.signIn("x".repeat(24));
		const snapAfter = store.getState().snapshot;
		w.release("getSnapshot");
		await flush();
		expect(store.getState().snapshot).toBe(snapAfter);

		tx.controls.revokeSession();
		w.hold("getTask");
		project(A.taskId); // answered 401 now, delivered later
		await flush();
		await store.signIn("y".repeat(24));
		expect(store.getState().auth.status).toBe("signed_in");
		w.release("getTask");
		await flush();
		expect(store.getState().auth.status).toBe("signed_in");
	});

	test("a current 401 purges data, selection and gate", async () => {
		const { store, tx, A, hq } = await setup();
		hq(A);
		await flush();
		store.setSignature("Edward");
		tx.controls.revokeSession();
		await store.loadSnapshot();
		const s = store.getState();
		expect(s.auth.status).toBe("signed_out");
		expect(s.auth.notice).toContain("session ended");
		expect([s.snapshot, s.gate, s.viewer, s.route.requestId]).toEqual([
			null,
			null,
			null,
			null,
		]);
		expect(Object.keys(s.details)).toHaveLength(0);
	});
});

describe("signature clearing", () => {
	test("subject change clears; re-selecting the same subject keeps (N-8)", async () => {
		const { store, A, B, hq } = await setup();
		hq(A);
		await flush();
		store.setSignature("Edward");
		hq(A);
		expect(store.getState().gate?.signature).toBe("Edward");
		hq(B);
		hq(A);
		await flush();
		expect(store.getState().gate?.signature).toBe("");
	});

	test("leaving HQ and coming back clears (gate change / back-forward)", async () => {
		const { store, A, hq, project } = await setup();
		hq(A);
		await flush();
		store.setSignature("Edward");
		project(A.taskId);
		expect(store.getState().gate).toBeNull();
		hq(A);
		await flush();
		expect(store.getState().gate?.signature).toBe("");
	});

	test("our own challenge's rev bump keeps the signature (hazard 1)", async () => {
		const { store, A, hq } = await setup();
		hq(A);
		await flush();
		const before = store.findRequest(A.taskId, A.requestId)?.rev as number;
		store.setSignature("Edward");
		await flush();
		await store.loadDetail(A.taskId);
		expect(store.findRequest(A.taskId, A.requestId)?.rev).toBe(before + 1);
		expect(store.getState().gate?.signature).toBe("Edward");
		expect(store.getState().gate?.challenge.phase).toBe("ready");
	});

	test("success clears and reports the committed decision", async () => {
		const { store, A, hq } = await setup();
		hq(A);
		await flush();
		store.setSignature("Edward");
		await flush();
		await store.decide("approve");
		expect(store.getState().gate?.signature).toBe("");
		expect(store.decisionStatus(A.requestId)).toContain("Execution approved");
		expect(store.findRequest(A.taskId, A.requestId)?.status).toBe("approved");
	});

	test("expiry clears", async () => {
		const { store, A, hq, tick } = await setup();
		hq(A);
		await flush();
		store.setSignature("Edward");
		await flush();
		tick(300_000);
		store.tick();
		expect(store.getState().gate?.signature).toBe("");
		expect(store.getState().gate?.notice).toContain("expired");
	});

	test("invalidation (resubmitted in another tab) clears", async () => {
		const { store, tx, A, hq } = await setup();
		hq(A);
		await flush();
		store.setSignature("Edward");
		await flush();
		const d = selected(store) as WorkspaceTaskDetail;
		const p = await tx.publishProposal(A.taskId, { expected_rev: d.task.rev });
		expect(p.ok).toBe(true);
		await store.loadDetail(A.taskId);
		expect(store.getState().gate?.signature).toBe("");
		expect(store.getState().gate?.notice).toContain("newer proposal version");
	});

	test("a definitive error clears and raises an alert with last confirmed state", async () => {
		const { store, tx, A, hq } = await setup();
		hq(A);
		await flush();
		store.setSignature("Edward");
		await flush();
		tx.controls.expireChallenges();
		await store.decide("approve");
		const s = store.getState();
		expect(s.gate?.signature).toBe("");
		expect(s.attempts[A.requestId]?.status).toBe("failed");
		expect(s.alert?.lastConfirmed).toContain("Last confirmed state");
		expect(store.findRequest(A.taskId, A.requestId)?.status).toBe("pending");
	});

	test("going offline clears and disables decisions", async () => {
		const { store, w, A, hq } = await setup();
		hq(A);
		await flush();
		store.setSignature("Edward");
		await flush();
		w.fail("getSnapshot");
		await store.loadSnapshot();
		expect(store.getState().conn.status).toBe("offline");
		expect(store.getState().gate?.signature).toBe("");
		expect(store.gateContext()?.online).toBe(false);
		await store.loadSnapshot();
		expect(store.getState().conn.status).toBe("online");
		expect(store.getState().gate?.challenge.phase).toBe("none"); // a fresh challenge is needed
	});

	test("sign-out drops the gate", async () => {
		const { store, A, hq } = await setup();
		hq(A);
		await flush();
		store.setSignature("Edward");
		await store.signOut();
		expect(store.getState().gate).toBeNull();
	});
});

describe("decisions: single dispatch and retry-key reuse (hazard 2)", () => {
	test("double activation sends one decision", async () => {
		const { store, w, A, hq } = await setup();
		hq(A);
		await flush();
		store.setSignature("Edward");
		await flush();
		await Promise.all([store.decide("approve"), store.decide("approve")]);
		expect(w.decideBodies).toHaveLength(1);
	});

	test("unknown outcome: no new key; the retry resends the identical bytes", async () => {
		const { store, w, tx, A, hq } = await setup();
		hq(A);
		await flush();
		store.setSignature("Edward");
		await flush();
		tx.controls.setDecisionFault("network_before_commit");
		await store.decide("approve");
		expect(store.getState().attempts[A.requestId]?.status).toBe("unknown");
		expect(store.decisionStatus(A.requestId)).toBe(OUTCOME_UNKNOWN);
		expect(store.getState().gate?.signature).toBe("");
		// a new decision cannot start while the outcome is unknown
		store.setSignature("Edward");
		await flush();
		await store.decide("approve");
		expect(w.decideBodies).toHaveLength(1);
		await store.retryDecision(A.requestId);
		expect(w.decideBodies).toHaveLength(2);
		expect(w.decideBodies[1]).toBe(w.decideBodies[0] as string);
		expect(store.getState().attempts[A.requestId]?.status).toBe("committed");
		expect(selected(store)?.decisions).toHaveLength(1);
	});

	test("a lost answer after commit reconciles from the next read (no second POST)", async () => {
		const { store, w, tx, A, hq } = await setup();
		hq(A);
		await flush();
		store.setSignature("Edward");
		await flush();
		tx.controls.setDecisionFault("lose_response_after_commit");
		await store.decide("approve");
		expect(store.getState().attempts[A.requestId]?.status).toBe("committed");
		expect(w.decideBodies).toHaveLength(1);
		expect(selected(store)?.task.stage).toBe("queued");
	});

	test("read-only sessions never open an approval window", async () => {
		const { store, w, A, hq } = await setup({ readOnly: true });
		hq(A);
		await flush();
		store.setSignature("Edward");
		await flush();
		expect(store.getState().gate?.challenge.phase).toBe("none");
		await store.decide("approve");
		expect(w.decideBodies).toHaveLength(0);
	});
});

describe("drafts", () => {
	test("Assign work → save (create) → edit → submit saves first, then opens Gate 1", async () => {
		const { store } = await setup();
		store.startComposing("local/fixture");
		const form = {
			...newDraftForm(),
			title: "Document local setup",
			objective: "Explain how to run the fixture.",
			criteriaText:
				"README has a setup section, with commands\nNo code changes",
		};
		const id = await store.createFromForm(form);
		expect(id).not.toBeNull();
		expect(store.getState().route.taskId).toBe(id as string);
		expect(store.getState().command?.message).toBe("Draft saved");
		expect(selected(store)?.task.draft.criteria).toEqual([
			"README has a setup section, with commands",
			"No code changes",
		]);
		// v1.2: the edited form maps every line (a new line starts unmapped)
		let next: DraftForm = {
			...form,
			criteriaText: `${form.criteriaText}\nChangelog line, short`,
		};
		for (const c of formCriteria(next))
			next = toggleCheck(next, c, "unit", true, ["unit", "lint"]);
		const ok = await store.publish(id as string, next);
		expect(ok).toBe(true);
		await flush();
		const d = selected(store) as WorkspaceTaskDetail;
		expect(d.task.stage).toBe("awaiting_run_approval");
		expect(d.current_proposal?.snapshot.criteria).toHaveLength(3);
		expect(d.task.draft.criterion_checks?.map((x) => x.criterion)).toEqual(
			formCriteria(next),
		);
	});

	test("an unknown create outcome reuses the same key (one task, not two)", async () => {
		const { store, w } = await setup();
		store.startComposing("local/fixture");
		const form = {
			...newDraftForm(),
			title: "Once only",
			objective: "o",
			criteriaText: "c",
		};
		w.lose("createTask");
		expect(await store.createFromForm(form)).toBeNull();
		expect(store.getState().command?.status).toBe("unknown");
		const before = store.getState().snapshot?.tasks.length as number;
		const id = await store.createFromForm(form);
		expect(id).not.toBeNull();
		await store.loadSnapshot();
		expect(store.getState().snapshot?.tasks.length).toBe(before);
	});

	test("cancel while running shows requested until the engine confirms", async () => {
		const { store, tx, A, hq, project } = await setup();
		const d0 = await tx.getTask(A.taskId);
		if (!d0.ok) throw new Error("detail");
		const saved = await tx.saveDraft(A.taskId, {
			expected_rev: d0.data.task.rev,
			draft: { ...d0.data.task.draft, simulation_scenario: "impl_hangs" },
		});
		if (!saved.ok) throw new Error("save");
		const pub = await tx.publishProposal(A.taskId, {
			expected_rev: saved.data.task.rev,
		});
		if (!pub.ok) throw new Error("publish");
		const req = pub.data.approval_requests[0];
		if (!req) throw new Error("req");
		hq({ taskId: A.taskId, requestId: req.id });
		await flush();
		store.setSignature("Edward");
		await flush();
		await store.decide("approve");
		tx.controls.advance(A.taskId);
		project(A.taskId);
		await store.loadDetail(A.taskId);
		expect(await store.cancel(A.taskId)).toBe(true);
		await store.loadDetail(A.taskId);
		expect(selected(store)?.task.stage).toBe("cancel_requested");
		expect(selected(store)?.engine?.state).toBe("executing");
		tx.controls.confirmCancel(A.taskId);
		await store.loadDetail(A.taskId);
		expect(selected(store)?.task.stage).toBe("cancelled");
	});
});

describe("one cache (M1-09)", () => {
	test("a fresh task read updates the task list and the HQ inbox at once", async () => {
		const { store, tx, A, hq, project } = await setup();
		hq(A);
		await flush();
		store.setSignature("Edward");
		await flush();
		await store.decide("approve");
		tx.controls.runToEnd(A.taskId);
		project(A.taskId);
		await store.loadDetail(A.taskId); // no snapshot poll in between
		const snap = store.getState().snapshot;
		const item = snap?.tasks.find((t) => t.task.id === A.taskId);
		expect(item?.phase).toBe("awaiting_acceptance");
		expect(
			snap?.pending_requests.some(
				(r) => r.workspace_task_id === A.taskId && r.kind === "result",
			),
		).toBe(true);
	});

	test("folding and merging never regress a newer row or its inbox entries", () => {
		const req = (task: string, at: string) =>
			({
				id: `r-${task}`,
				workspace_task_id: task,
				status: "pending",
				created_at: at,
			}) as never;
		const snap = (rev: number, pending: unknown[]) =>
			({
				tasks: [{ task: { id: "x", rev }, phase: "planning" }],
				pending_requests: pending,
			}) as never;
		const newer = snap(5, [req("x", "2026-10-02T00:00:01Z")]);
		const older = snap(4, []);
		// an older snapshot arriving later keeps the newer row AND its pending request
		const merged = mergeSnapshot(newer, older);
		expect(merged.tasks[0]?.task.rev).toBe(5);
		expect(merged.pending_requests).toHaveLength(1);
		// an older task read is not folded in
		const view = {
			task: { id: "x", rev: 3 },
			phase: "queued",
			approval_requests: [],
		} as never;
		expect(foldTaskIntoSnapshot(newer, view)).toBe(newer);
	});
});

describe("boot and sign-in report what the hub said", () => {
	const disabled = (): TransportResult<never> => ({
		ok: false,
		kind: "http",
		status: 503,
		error: { error: "disabled", message: "workspace off" },
	});

	test("503 disabled at boot is not 'offline' and not a credential problem", async () => {
		const tx = createFixtureTransport({ signedIn: false });
		const t = {
			...tx,
			getSession: async () => disabled(),
			signIn: async () => disabled(),
		} as WorkspaceTransport;
		const store = new WorkspaceStore({ transport: t });
		await store.boot();
		expect(store.getState().conn.status).toBe("online");
		expect(store.getState().auth.error).toContain("not enabled");
		await store.signIn("x".repeat(24));
		expect(store.getState().auth.error).toContain("not enabled");
		expect(store.getState().conn.status).toBe("online");
	});

	test("no answer at boot is offline; a wrong credential says so", async () => {
		const tx = createFixtureTransport({ signedIn: false });
		const w = wrap(tx);
		w.fail("getSession");
		const store = new WorkspaceStore({ transport: w.transport });
		await store.boot();
		expect(store.getState().conn.status).toBe("offline");
		tx.controls.rejectNextSignIn();
		await store.signIn("x".repeat(24));
		expect(store.getState().auth.error).toContain("credential");
		await store.signIn("x".repeat(24));
		expect(store.getState().auth.status).toBe("signed_in");
	});
});

describe("sign-out degrades safely (09 F-1)", () => {
	test("a failed DELETE /session still clears local state and says so", async () => {
		const tx = createFixtureTransport();
		const t = {
			...tx,
			signOut: async (): Promise<TransportResult<null>> => ({
				ok: false,
				kind: "http",
				status: 403,
				error: { error: "csrf_invalid", message: "x" },
			}),
		} as WorkspaceTransport;
		const store = new WorkspaceStore({ transport: t });
		await store.boot();
		expect(store.getState().auth.status).toBe("signed_in");
		await store.signOut();
		const s = store.getState();
		expect(s.auth.status).toBe("signed_out");
		expect(s.snapshot).toBeNull();
		expect(s.auth.notice).toContain("did not confirm");
	});

	test("a confirmed or already-ended session reads plainly 'Signed out.'", async () => {
		const tx = createFixtureTransport();
		const store = new WorkspaceStore({ transport: tx });
		await store.boot();
		await store.signOut();
		expect(store.getState().auth.notice).toBe("Signed out.");
	});
});

describe("unknown deep links are explained and normalized in place (09 L-4)", () => {
	test("an unknown task id clears the selection with replace, once", async () => {
		const { store } = await setup();
		const ghost = "wst-00000000-0000-4000-8000-0000000fffff";
		store.navigate({
			view: "projects",
			repoId: "local/fixture",
			taskId: ghost,
			requestId: null,
		});
		await flush();
		const s = store.getState();
		expect(s.route).toEqual({
			view: "projects",
			repoId: "local/fixture",
			taskId: null,
			requestId: null,
		});
		expect(s.routeMode).toBe("replace");
		expect(s.routeNotice).toContain("does not exist");
		// the next user selection pushes again and clears the notice
		store.navigate({ view: "hq", repoId: null, taskId: null, requestId: null });
		expect(store.getState().routeMode).toBe("push");
		expect(store.getState().routeNotice).toBeNull();
	});

	test("an unknown request of a known task clears the HQ selection with replace", async () => {
		const { store, A } = await setup();
		const ghost = "wsa-00000000-0000-4000-8000-0000000fffff";
		store.navigate({
			view: "hq",
			repoId: null,
			taskId: A.taskId,
			requestId: ghost,
		});
		await flush();
		const s = store.getState();
		expect(s.route).toEqual({
			view: "hq",
			repoId: null,
			taskId: null,
			requestId: null,
		});
		expect(s.routeMode).toBe("replace");
		expect(s.routeNotice).toContain("approval request does not exist");
	});
});

describe("presentation clock during silent reads", () => {
	test("notifies without a gate or completed read, preserving cached authority and selection", async () => {
		const { store, w, A, project, tick } = await setup();
		project(A.taskId);
		await flush();
		w.hold("getSnapshot");
		w.hold("getTask");
		const pending = store.refresh();
		await flush();
		const before = store.getState();
		expect(before.gate).toBeNull();
		let notifications = 0;
		const unsubscribe = store.subscribe(() => notifications++);
		tick(18_000);
		store.tick();
		const after = store.getState();
		expect(notifications).toBe(1);
		expect(after).not.toBe(before);
		expect(after).toEqual(before);
		expect(after.snapshot).toBe(before.snapshot);
		expect(after.details).toBe(before.details);
		expect(after.conn).toBe(before.conn);
		expect(after.auth).toBe(before.auth);
		expect(after.route).toBe(before.route);
		expect(after.attempts).toBe(before.attempts);
		unsubscribe();
		w.release("getSnapshot");
		w.release("getTask");
		await pending;
	});

	test("signed-out ticks do not publish presentation updates", async () => {
		const { store } = await setup();
		await store.signOut();
		const before = store.getState();
		let notifications = 0;
		const unsubscribe = store.subscribe(() => notifications++);
		store.tick();
		expect(notifications).toBe(0);
		expect(store.getState()).toBe(before);
		unsubscribe();
	});
});
