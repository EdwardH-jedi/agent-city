// Obsolete v1 execution grants in the UI (lead UI items from the hub follow-up). Pins: the hub's fixed
// reason replaces generic stale_binding copy; a retired Gate-1 request reads as an obsolete proposal,
// never as an evidence problem; no approve control stays enabled; the fixture mirrors the hub policy
// (409 + invalidation + task → draft, challenge refused, per-step authorize refusal); concise
// proposal version labels.
import { describe, expect, test } from "bun:test";
import {
	type ApprovalRequestView,
	criteriaFromText,
	emptyDraft,
	WorkspaceTaskDetail,
} from "@agent-city/schema/workspace-m1";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	createFixtureTransport,
	type FixtureTransport,
} from "./fixture-transport.ts";
import { HqView } from "./HqView.tsx";
import {
	errorCopyOf,
	INVALIDATION_LABEL,
	invalidationLabel,
	isObsoleteGrant,
	OBSOLETE_GRANT_LABEL,
	OBSOLETE_GRANT_NOTE,
	OBSOLETE_GRANT_PENDING_NOTE,
	OBSOLETE_V1_GRANT_DETAIL,
	proposalVersionLabel,
	requestStatusLine,
} from "./labels.ts";
import { StoreContext } from "./parts.tsx";
import { WorkspaceStore } from "./store.ts";
import type { TransportResult, WorkspaceTransport } from "./transport.ts";

const T0 = Date.parse("2026-10-02T00:00:00.000Z");
const ISSUE = { path: "proposal_id", message: OBSOLETE_V1_GRANT_DETAIL };

function must<T>(r: TransportResult<T>): T {
	if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
	return r.data;
}
let keyN = 0;
const key = () => `obsolete-test-${++keyN}`;
const flush = async () => {
	for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A legacy (v1) publish through the fixture's public routes: a pending legacy Gate 1. */
async function legacyPending(tx: FixtureTransport, legacyMapping = false) {
	tx.controls.setLegacyContract(true);
	const c = must(
		await tx.createTask({
			idempotency_key: key(),
			repo_id: "local/fixture",
			draft: {
				...emptyDraft(),
				title: "Legacy task",
				objective: "A proposal from before v1.2.",
				criteria: criteriaFromText("Build passes"),
				scope: { allowed: ["."], protected: [] },
				...(legacyMapping
					? {
							criterion_checks: [
								{ criterion: "Build passes", checks: ["unit"] },
							],
						}
					: {}),
			},
		}),
	);
	const p = must(
		await tx.publishProposal(c.task.id, { expected_rev: c.task.rev }),
	);
	tx.controls.setLegacyContract(false);
	const req = p.approval_requests.find((r) => r.status === "pending");
	if (!req) throw new Error("no pending request");
	return { taskId: c.task.id, req };
}

const detailOf = async (tx: FixtureTransport, taskId: string) =>
	WorkspaceTaskDetail.parse(must(await tx.getTask(taskId)));

const run = (over: Partial<ApprovalRequestView> = {}) =>
	({
		kind: "run",
		status: "invalidated",
		invalidation_reason: "evidence_unavailable",
		invalidation_detail: OBSOLETE_V1_GRANT_DETAIL,
		...over,
	}) as const;

describe("copy: the hub's fixed reason, never an evidence problem", () => {
	test("a retired Gate-1 request reads as an obsolete v1 proposal", () => {
		expect(isObsoleteGrant(run())).toBe(true);
		expect(isObsoleteGrant(run({ invalidation_detail: null }))).toBe(true); // reason alone
		expect(isObsoleteGrant(run({ kind: "result" }))).toBe(false);
		expect(isObsoleteGrant(run({ status: "pending" }))).toBe(false);
		const line = requestStatusLine(run());
		expect(line).toBe(
			"Invalidated: obsolete v1 proposal — publish a new version and request a fresh execution approval.",
		);
		expect(line).not.toContain(INVALIDATION_LABEL.evidence_unavailable);
		expect(line.toLowerCase()).not.toContain("evidence");
		// a result request with the same reason keeps the evidence wording
		expect(
			invalidationLabel(run({ kind: "result", invalidation_detail: "x" })),
		).toBe(INVALIDATION_LABEL.evidence_unavailable);
		expect(
			requestStatusLine(
				run({
					invalidation_reason: "policy_changed",
					invalidation_detail: "y",
				}),
			),
		).toBe(`Invalidated: ${INVALIDATION_LABEL.policy_changed}.`);
	});

	test("409 stale_binding with the obsolete issue → the clear label; other issues → the server text; none → generic", () => {
		expect(
			errorCopyOf({ error: "stale_binding", message: "m", issues: [ISSUE] }),
		).toBe(`${OBSOLETE_GRANT_LABEL}.`);
		expect(
			errorCopyOf({
				error: "stale_binding",
				message: "m",
				issues: [{ path: "proposal_id", message: "some fixed reason" }],
			}),
		).toBe("Some fixed reason.");
		expect(errorCopyOf({ error: "stale_binding", message: "m" })).toBe(
			"The request changed since it was loaded.",
		);
		// other codes keep their own copy, issues or not
		expect(
			errorCopyOf({ error: "invalid_state", message: "m", issues: [ISSUE] }),
		).toBe("This request is no longer open for a decision.");
	});
});

describe("fixture mirrors the hub policy", () => {
	test("challenge on a pending legacy Gate 1 → 409 stale_binding + the hub's issue; request invalidated, reservation cancelled, task → draft; retries agree", async () => {
		const tx = createFixtureTransport({ now: () => T0 });
		const { taskId, req } = await legacyPending(tx);
		const ch = await tx.issueChallenge(req.id, {
			kind: "run",
			binding_hash: req.binding_hash,
			expected_request_rev: req.rev,
		});
		expect(ch.ok).toBe(false);
		if (ch.ok || ch.kind !== "http") throw new Error("expected http");
		expect(ch.status).toBe(409);
		expect(ch.error).toMatchObject({ error: "stale_binding", issues: [ISSUE] });
		const d = await detailOf(tx, taskId);
		const r = d.approval_requests.find((x) => x.id === req.id);
		expect(r).toMatchObject({
			status: "invalidated",
			invalidation_reason: "evidence_unavailable",
			invalidation_detail: OBSOLETE_V1_GRANT_DETAIL,
		});
		expect(d.task.stage).toBe("draft");
		expect(d.task.stage_detail).toBe(
			`Gate 1 was invalidated: ${OBSOLETE_V1_GRANT_DETAIL}`,
		);
		expect(d.engine?.state).toBe("cancelled");
		expect(d.decisions).toEqual([]);
		const again = await tx.issueChallenge(req.id, {
			kind: "run",
			binding_hash: req.binding_hash,
			expected_request_rev: r?.rev ?? 0,
		});
		expect(!again.ok && again.kind === "http" && again.error).toMatchObject({
			error: "stale_binding",
			issues: [ISSUE],
		});
	});

	test("a decision on a pending legacy Gate 1 (any action) → the same 409 before any challenge check; no decision; a wrong confirmation is refused first", async () => {
		for (const action of ["approve", "request_changes", "reject"] as const) {
			const tx = createFixtureTransport({ now: () => T0 });
			const { taskId, req } = await legacyPending(tx);
			const grants = action === "approve";
			const body = {
				idempotency_key: key(),
				kind: "run",
				action,
				expected_request_rev: req.rev,
				binding_hash: req.binding_hash,
				confirmation_text: grants ? "Edward" : null,
				reason: grants ? null : "Not this version.",
				challenge: "x".repeat(43),
			};
			if (grants) {
				const bad = await tx.decide(
					req.id,
					JSON.stringify({ ...body, confirmation_text: "edward" }),
				);
				expect(!bad.ok && bad.kind === "http" && bad.error.error).toBe(
					"confirmation_mismatch",
				);
				expect((await detailOf(tx, taskId)).approval_requests[0]?.status).toBe(
					"pending",
				);
			}
			const res = await tx.decide(req.id, JSON.stringify(body));
			expect(!res.ok && res.kind === "http" && res.error).toMatchObject({
				error: "stale_binding",
				issues: [ISSUE],
			});
			const d = await detailOf(tx, taskId);
			expect(d.decisions).toEqual([]);
			expect(d.task.stage).toBe("draft");
			expect(d.approval_requests[0]?.status).toBe("invalidated");
		}
	});

	test("an approved legacy execution (pre-policy history) launches no further step: blocked approval_void, execution_ended with the guidance", async () => {
		for (const steps of [0, 2]) {
			const tx = createFixtureTransport({ now: () => T0 });
			const { taskId } = await legacyPending(tx);
			expect(tx.controls.runLegacyBeforePolicy(taskId, "verified", steps)).toBe(
				true,
			);
			const before = await detailOf(tx, taskId);
			const runsBefore = before.runs.length;
			expect(tx.controls.advance(taskId)).toBe(true);
			const d = await detailOf(tx, taskId);
			expect(d.engine).toMatchObject({
				state: "blocked",
				failure_kind: "approval_void",
			});
			expect(d.engine?.state_detail).toContain(OBSOLETE_V1_GRANT_DETAIL);
			expect(d.task.stage).toBe("execution_ended");
			expect(d.task.stage_detail).toContain(OBSOLETE_V1_GRANT_DETAIL);
			expect(d.runs.length).toBe(runsBefore); // no new attempt started
			expect(d.approval_requests.some((r) => r.kind === "result")).toBe(false);
			expect(tx.controls.advance(taskId)).toBe(false);
		}
	});

	test("a v1.2 proposal is unaffected (control: approve still works)", async () => {
		const tx = createFixtureTransport({ now: () => T0 });
		const c = must(
			await tx.createTask({
				idempotency_key: key(),
				repo_id: "local/fixture",
				draft: {
					...emptyDraft(),
					title: "Current task",
					objective: "v1.2",
					criteria: criteriaFromText("Build passes"),
					scope: { allowed: ["."], protected: [] },
					criterion_checks: [{ criterion: "Build passes", checks: ["unit"] }],
				},
			}),
		);
		const p = must(
			await tx.publishProposal(c.task.id, { expected_rev: c.task.rev }),
		);
		const req = p.approval_requests[0] as ApprovalRequestView;
		const ch = must(
			await tx.issueChallenge(req.id, {
				kind: "run",
				binding_hash: req.binding_hash,
				expected_request_rev: req.rev,
			}),
		);
		const res = await tx.decide(
			req.id,
			JSON.stringify({
				idempotency_key: key(),
				kind: "run",
				action: "approve",
				expected_request_rev: ch.request_rev,
				binding_hash: req.binding_hash,
				confirmation_text: "Edward",
				reason: null,
				challenge: ch.challenge,
			}),
		);
		expect(res.ok).toBe(true);
	});
});

describe("store + HQ: the attempt shows the hub's reason; no approve control remains", () => {
	async function hqOnLegacy() {
		const tx = createFixtureTransport({ now: () => T0 });
		const l = await legacyPending(tx);
		const store = new WorkspaceStore({
			transport: tx,
			now: () => T0,
			random: (() => {
				let n = 0;
				return () => `rnd-${++n}`;
			})(),
		});
		await store.boot();
		store.navigate({
			view: "hq",
			repoId: null,
			taskId: l.taskId,
			requestId: l.req.id,
		});
		await flush();
		return { tx, store, ...l };
	}
	const render = (store: WorkspaceStore) =>
		renderToStaticMarkup(
			createElement(
				StoreContext.Provider,
				{ value: { store, state: store.getState() } },
				createElement(HqView),
			),
		);

	test("pending legacy request: the obsolete note is shown and Approve is disabled before any attempt", async () => {
		const { store } = await hqOnLegacy();
		const html = render(store);
		expect(html).toMatch(/data-testid="obsolete-grant" data-status="pending"/);
		expect(html).toContain(OBSOLETE_GRANT_PENDING_NOTE);
		expect(html).toMatch(
			/<button[^>]*disabled=""[^>]*>Approve execution<\/button>/,
		);
	});

	test("typing the signature → challenge 409 → the hub's reason; after the re-read the request is retired, the note names the obsolete proposal, and no decision control is rendered", async () => {
		const { store, taskId, req } = await hqOnLegacy();
		store.setSignature("Edward");
		await flush();
		const r = store.findRequest(taskId, req.id);
		expect(r?.status).toBe("invalidated");
		expect(store.gateContext()?.pending).toBe(false);
		const notice = store.getState().gate?.notice ?? "";
		expect(notice).toContain(OBSOLETE_GRANT_LABEL);
		expect(notice).not.toContain(INVALIDATION_LABEL.evidence_unavailable);
		const html = render(store);
		expect(html).toMatch(/data-testid="obsolete-grant" data-status="retired"/);
		expect(html).toContain(OBSOLETE_GRANT_NOTE);
		expect(html).not.toContain("Approve execution</button>");
		expect(html).not.toContain(INVALIDATION_LABEL.evidence_unavailable);
		expect(html).toContain("No further decision is possible on it.");
		expect(store.detail(taskId)?.task.stage).toBe("draft");
	});

	test("a decision attempt that meets the retirement shows the server's reason (Decision status + alert), not generic copy", async () => {
		const tx = createFixtureTransport({ now: () => T0 });
		const l = await legacyPending(tx);
		// a pre-policy hub had issued the approval window: the client holds a ready challenge
		const transport: WorkspaceTransport = {
			...tx,
			issueChallenge: async (id, body) => ({
				ok: true,
				status: 201,
				data: {
					approval_request_id: id,
					kind: body.kind,
					binding_hash: body.binding_hash,
					request_rev: body.expected_request_rev + 1,
					challenge: "y".repeat(43),
					expires_at: new Date(T0 + 60_000).toISOString(),
				},
			}),
		};
		const store = new WorkspaceStore({ transport, now: () => T0 });
		await store.boot();
		store.navigate({
			view: "hq",
			repoId: null,
			taskId: l.taskId,
			requestId: l.req.id,
		});
		await flush();
		store.setReason("Not this version.");
		await flush();
		expect(store.getState().gate?.challenge.phase).toBe("ready");
		await store.decide("request_changes");
		await flush();
		expect(store.decisionStatus(l.req.id)).toBe(`${OBSOLETE_GRANT_LABEL}.`);
		expect(store.getState().alert?.message).toBe(`${OBSOLETE_GRANT_LABEL}.`);
		expect(store.findRequest(l.taskId, l.req.id)?.status).toBe("invalidated");
		expect(store.getState().gate?.notice).toContain(OBSOLETE_GRANT_LABEL);
	});
});

describe("proposal version labels", () => {
	test("current and predecessor versions by number; older ones by id", () => {
		const d = {
			current_proposal: {
				id: "wsp-00000000-0000-4000-8000-000000000003",
				version: 3,
				predecessor_proposal_id: "wsp-00000000-0000-4000-8000-000000000002",
			},
		} as unknown as Parameters<typeof proposalVersionLabel>[0];
		expect(
			proposalVersionLabel(d, "wsp-00000000-0000-4000-8000-000000000003"),
		).toBe("Proposal v3");
		expect(
			proposalVersionLabel(d, "wsp-00000000-0000-4000-8000-000000000002"),
		).toBe("Proposal v2");
		expect(
			proposalVersionLabel(d, "wsp-00000000-0000-4000-8000-000000000001"),
		).toBe("Earlier proposal …00000001");
		expect(
			proposalVersionLabel(
				{ current_proposal: null },
				"wsp-00000000-0000-4000-8000-000000000001",
			),
		).toBe("Earlier proposal …00000001");
	});
});
