// Fixture transport semantics vs the frozen contract (role 07). Every answer is parsed again here
// with the contract schemas (independently of the transport's own parse), and the server-side
// rules the UI relies on are pinned: CAS revs, challenge rev bump, idempotent decisions, lost
// responses, invalidation, cancellation requested vs confirmed, terminal stages.
import { describe, expect, test } from "bun:test";
import {
	type ApprovalRequestView,
	ArtifactTextResponse,
	ChallengeIssueResponse,
	criteriaFromText,
	DecisionResponse,
	emptyDraft,
	proposalCriteriaTexts,
	SessionView,
	type WorkspaceDraft,
	WorkspaceSnapshot,
	WorkspaceTaskDetail,
	WorkspaceTaskView,
} from "@agent-city/schema/workspace-m1";
import { createFixtureTransport } from "./fixture-transport.ts";
import type { TransportResult } from "./transport.ts";

const T0 = Date.parse("2026-10-02T00:00:00.000Z");

function setup(opts: { signedIn?: boolean } = {}) {
	let t = T0;
	const tx = createFixtureTransport({
		now: () => t,
		signedIn: opts.signedIn ?? true,
	});
	return {
		tx,
		tick: (ms: number) => {
			t += ms;
		},
	};
}

function must<T>(r: TransportResult<T>): T {
	if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
	return r.data;
}

function code(r: TransportResult<unknown>): string {
	if (r.ok) return "ok";
	return r.kind === "http" ? r.error.error : r.kind;
}

const CRITERIA_TEXT =
	"Build passes, lint passes\nDocs updated, with one example\nNo change outside src/, tests/";

/**
 * v1.2: publish fails closed without a complete criterion → check mapping, so the helper maps
 * every criterion to the fixture repo's `unit` check unless the test passes its own mapping.
 */
function draft(over: Partial<WorkspaceDraft> = {}): WorkspaceDraft {
	const base: WorkspaceDraft = {
		...emptyDraft(),
		title: "Add retry to webhook sender",
		objective: "Retry failed webhook deliveries with bounded backoff.",
		criteria: criteriaFromText(CRITERIA_TEXT),
		scope: { allowed: ["."], protected: [] },
		...over,
	};
	return "criterion_checks" in over
		? base
		: {
				...base,
				criterion_checks: base.criteria.map((criterion) => ({
					criterion,
					checks: ["unit"],
				})),
			};
}

let keyN = 0;
const key = () => `test-key-${++keyN}`;

async function createPublished(
	tx: ReturnType<typeof setup>["tx"],
	over: Partial<WorkspaceDraft> = {},
) {
	const created = must(
		await tx.createTask({
			idempotency_key: key(),
			repo_id: "local/fixture",
			draft: draft(over),
		}),
	);
	WorkspaceTaskView.parse(created);
	const published = must(
		await tx.publishProposal(created.task.id, {
			expected_rev: created.task.rev,
		}),
	);
	WorkspaceTaskView.parse(published);
	return published;
}

async function detail(tx: ReturnType<typeof setup>["tx"], id: string) {
	return WorkspaceTaskDetail.parse(must(await tx.getTask(id)));
}

function pendingOf(
	d: { approval_requests: ApprovalRequestView[] },
	kind: "run" | "result",
) {
	const r = d.approval_requests.find(
		(x) => x.kind === kind && x.status === "pending",
	);
	if (!r) throw new Error(`no pending ${kind} request`);
	return r;
}

function body(
	req: ApprovalRequestView,
	challenge: { request_rev: number; challenge: string },
	action: "approve" | "accept" | "request_changes" | "reject",
	k: string,
	over: Record<string, unknown> = {},
): string {
	const grant = action === "approve" || action === "accept";
	return JSON.stringify({
		idempotency_key: k,
		kind: req.kind,
		action,
		expected_request_rev: challenge.request_rev,
		binding_hash: req.binding_hash,
		confirmation_text: grant ? "Edward" : null,
		reason: grant ? null : "Scope is too broad.",
		challenge: challenge.challenge,
		...over,
	});
}

async function challengeFor(
	tx: ReturnType<typeof setup>["tx"],
	req: ApprovalRequestView,
) {
	return ChallengeIssueResponse.parse(
		must(
			await tx.issueChallenge(req.id, {
				kind: req.kind,
				binding_hash: req.binding_hash,
				expected_request_rev: req.rev,
			}),
		),
	);
}

describe("fixture transport: happy path (both gates)", () => {
	test("create → publish → Gate 1 → run → Gate 2 accept, every answer contract-valid", async () => {
		const { tx } = setup();
		SessionView.parse(must(await tx.getSession()));
		const published = await createPublished(tx);
		const id = published.task.id;
		expect(published.task.stage).toBe("awaiting_run_approval");
		expect(published.engine?.state).toBe("draft");
		expect(published.current_proposal?.version).toBe(1);
		// commas never split a criterion; order is kept (v1.2: texts byte-identical inside {id, text})
		const snapshot = published.current_proposal?.snapshot;
		if (!snapshot) throw new Error("no proposal");
		expect(proposalCriteriaTexts(snapshot)).toEqual([
			"Build passes, lint passes",
			"Docs updated, with one example",
			"No change outside src/, tests/",
		]);
		expect(snapshot.contract).toBe("agentcity.proposal/v1.2");
		if (snapshot.contract !== "agentcity.proposal/v1.2") throw new Error("v1");
		expect(snapshot.coverage_plan.map((p) => p.checks)).toEqual([
			["unit"],
			["unit"],
			["unit"],
		]);
		const snap = WorkspaceSnapshot.parse(must(await tx.getSnapshot()));
		expect(snap.provenance.data_source).toBe("fixture");
		expect(snap.pending_requests).toHaveLength(1);

		const run = pendingOf(await detail(tx, id), "run");
		const ch = await challengeFor(tx, run);
		expect(ch.request_rev).toBe(run.rev + 1); // issuing bumps the request rev
		const approved = DecisionResponse.parse(
			must(await tx.decide(run.id, body(run, ch, "approve", key()))),
		);
		expect(approved.replayed).toBe(false);
		expect(approved.receipt.workspace_task.stage).toBe("queued");
		expect(approved.receipt.effects.managed_task_state).toBe("queued");

		expect(tx.controls.runToEnd(id)).toBeGreaterThan(3);
		const ready = await detail(tx, id);
		expect(ready.task.stage).toBe("awaiting_acceptance");
		expect(ready.engine?.state).toBe("human_ready");
		expect(ready.phase).toBe("awaiting_acceptance");
		expect(ready.runs).toHaveLength(1);
		const result = pendingOf(ready, "result");
		expect(result.result_envelope?.evidence_status).toBe("verified");
		expect(result.result_envelope?.candidate_sha).toBe(
			ready.runs[0]?.candidate_sha as string,
		);
		for (const a of ready.artifacts)
			ArtifactTextResponse.parse(must(await tx.getArtifact(id, a.artifact_id)));

		const ch2 = await challengeFor(tx, result);
		const accepted = DecisionResponse.parse(
			must(await tx.decide(result.id, body(result, ch2, "accept", key()))),
		);
		expect(accepted.receipt.workspace_task.stage).toBe("accepted");
		expect(accepted.receipt.effects.managed_task_state).toBe("human_ready");
		const done = await detail(tx, id);
		expect(done.task.accepted_decision_id).toBe(accepted.receipt.decision_id);
		expect(done.engine?.state).toBe("human_ready"); // engine meaning preserved
		expect(done.decisions.map((d) => d.action)).toEqual(["accept", "approve"]);
		expect(
			WorkspaceSnapshot.parse(must(await tx.getSnapshot())).pending_requests,
		).toHaveLength(0);
	});
});

describe("fixture transport: challenges and decisions", () => {
	test("a reissued challenge supersedes the old one; failures consume nothing", async () => {
		const { tx, tick } = setup();
		const p = await createPublished(tx);
		const run = pendingOf(p, "run");
		const first = await challengeFor(tx, run);
		const fresh = pendingOf(await detail(tx, p.task.id), "run");
		const second = await challengeFor(tx, fresh);
		// old token + old rev → stale_binding (rev moved); old token + new rev → challenge_invalid
		expect(
			code(await tx.decide(run.id, body(run, first, "approve", key()))),
		).toBe("stale_binding");
		expect(
			code(
				await tx.decide(
					run.id,
					body(
						run,
						{ request_rev: second.request_rev, challenge: first.challenge },
						"approve",
						key(),
					),
				),
			),
		).toBe("challenge_invalid");
		// wrong confirmation consumes nothing
		expect(
			code(
				await tx.decide(
					run.id,
					body(run, second, "approve", key(), { confirmation_text: "edward" }),
				),
			),
		).toBe("confirmation_mismatch");
		// request_changes with "" instead of null is malformed (null, not "")
		expect(
			code(
				await tx.decide(
					run.id,
					body(run, second, "request_changes", key(), {
						confirmation_text: "",
					}),
				),
			),
		).toBe("invalid_request");
		// expired challenge → challenge_invalid; a new one works
		tick(300_001);
		expect(
			code(await tx.decide(run.id, body(run, second, "approve", key()))),
		).toBe("challenge_invalid");
		const third = await challengeFor(
			tx,
			pendingOf(await detail(tx, p.task.id), "run"),
		);
		expect(
			must(await tx.decide(run.id, body(run, third, "approve", key())))
				.replayed,
		).toBe(false);
	});

	test("same key + same bytes replays; same key + other payload conflicts", async () => {
		const { tx } = setup();
		const p = await createPublished(tx);
		const run = pendingOf(p, "run");
		const ch = await challengeFor(tx, run);
		const k = key();
		const bytes = body(run, ch, "approve", k);
		const a = must(await tx.decide(run.id, bytes));
		const b = must(await tx.decide(run.id, bytes));
		expect(b.replayed).toBe(true);
		expect(b.receipt.decision_id).toBe(a.receipt.decision_id);
		expect(code(await tx.decide(run.id, body(run, ch, "reject", k)))).toBe(
			"idempotency_conflict",
		);
		expect((await detail(tx, p.task.id)).decisions).toHaveLength(1);
	});

	test("lost response after commit: the byte-identical retry replays the receipt", async () => {
		const { tx } = setup();
		const p = await createPublished(tx);
		const run = pendingOf(p, "run");
		const ch = await challengeFor(tx, run);
		const bytes = body(run, ch, "approve", key());
		tx.controls.setDecisionFault("lose_response_after_commit");
		expect(code(await tx.decide(run.id, bytes))).toBe("network");
		const retry = must(await tx.decide(run.id, bytes));
		expect(retry.replayed).toBe(true);
		const d = await detail(tx, p.task.id);
		expect(d.decisions).toHaveLength(1);
		expect(d.task.stage).toBe("queued");
	});

	test("lost request before commit: the same bytes still decide (challenge unconsumed)", async () => {
		const { tx } = setup();
		const p = await createPublished(tx);
		const run = pendingOf(p, "run");
		const ch = await challengeFor(tx, run);
		const bytes = body(run, ch, "approve", key());
		tx.controls.setDecisionFault("network_before_commit");
		expect(code(await tx.decide(run.id, bytes))).toBe("network");
		expect(must(await tx.decide(run.id, bytes)).replayed).toBe(false);
	});

	test("a server error after commit is an unknown outcome, then reconciles by replay", async () => {
		const { tx } = setup();
		const p = await createPublished(tx);
		const run = pendingOf(p, "run");
		const ch = await challengeFor(tx, run);
		const bytes = body(run, ch, "approve", key());
		tx.controls.setDecisionFault("server_error_after_commit");
		expect(code(await tx.decide(run.id, bytes))).toBe("invalid_response");
		expect(must(await tx.decide(run.id, bytes)).replayed).toBe(true);
	});

	test("crafted live mode is refused before anything else", async () => {
		const { tx } = setup();
		const r = await tx.createTask({
			idempotency_key: key(),
			repo_id: "local/fixture",
			draft: {
				...draft(),
				execution_mode: "live",
			} as unknown as WorkspaceDraft,
		});
		expect(code(r)).toBe("live_disabled");
	});
});

describe("fixture transport: drafts, versions, invalidation", () => {
	test("draft saves are CAS on rev; republish supersedes the pending Gate 1", async () => {
		const { tx } = setup();
		const p = await createPublished(tx);
		const stale = await tx.saveDraft(p.task.id, {
			expected_rev: p.task.rev - 1,
			draft: draft(),
		});
		expect(code(stale)).toBe("stale_binding");
		const saved = must(
			await tx.saveDraft(p.task.id, {
				expected_rev: p.task.rev,
				draft: draft({
					criteria: [...draft().criteria, "Changelog entry, short"],
				}),
			}),
		);
		const v2 = must(
			await tx.publishProposal(p.task.id, { expected_rev: saved.task.rev }),
		);
		expect(v2.current_proposal?.version).toBe(2);
		expect(v2.current_proposal?.predecessor_proposal_id).toBe(
			p.current_proposal?.id as string,
		);
		const statuses = v2.approval_requests.map((r) => [
			r.status,
			r.invalidation_reason,
		]);
		expect(statuses).toEqual([
			["pending", null],
			["invalidated", "proposal_superseded"],
		]);
		expect(
			WorkspaceSnapshot.parse(must(await tx.getSnapshot())).pending_requests,
		).toHaveLength(1);
	});

	test("an incomplete draft cannot be published (issues returned)", async () => {
		const { tx } = setup();
		const created = must(
			await tx.createTask({
				idempotency_key: key(),
				repo_id: "local/fixture",
				draft: emptyDraft(),
			}),
		);
		const r = await tx.publishProposal(created.task.id, {
			expected_rev: created.task.rev,
		});
		expect(code(r)).toBe("invalid_request");
		if (!r.ok && r.kind === "http")
			expect(r.error.issues?.length).toBeGreaterThan(0);
	});

	test("Gate-1 reject is terminal: closed task, engine cancelled, draft not editable", async () => {
		const { tx } = setup();
		const p = await createPublished(tx);
		const run = pendingOf(p, "run");
		const ch = await challengeFor(tx, run);
		must(await tx.decide(run.id, body(run, ch, "reject", key())));
		const d = await detail(tx, p.task.id);
		expect(d.task.stage).toBe("rejected");
		expect(d.engine?.state).toBe("cancelled");
		expect(d.decisions[0]?.reason).toBe("Scope is too broad.");
		expect(
			code(
				await tx.saveDraft(p.task.id, {
					expected_rev: d.task.rev,
					draft: draft(),
				}),
			),
		).toBe("invalid_state");
	});

	test("Gate-2 request changes → changes_requested; a new version needs a new Gate 1", async () => {
		const { tx } = setup();
		const p = await createPublished(tx);
		const run = pendingOf(p, "run");
		must(
			await tx.decide(
				run.id,
				body(run, await challengeFor(tx, run), "approve", key()),
			),
		);
		tx.controls.runToEnd(p.task.id);
		const result = pendingOf(await detail(tx, p.task.id), "result");
		must(
			await tx.decide(
				result.id,
				body(result, await challengeFor(tx, result), "request_changes", key()),
			),
		);
		const d = await detail(tx, p.task.id);
		expect(d.task.stage).toBe("changes_requested");
		expect(d.engine?.state).toBe("human_ready");
		const v2 = must(
			await tx.publishProposal(p.task.id, { expected_rev: d.task.rev }),
		);
		expect(v2.task.stage).toBe("awaiting_run_approval");
		expect(v2.current_proposal?.version).toBe(2);
	});

	test("reconciler invalidation of a pending Gate 1 returns the task to draft", async () => {
		const { tx } = setup();
		const p = await createPublished(tx);
		expect(tx.controls.invalidateRunRequest(p.task.id, "policy_changed")).toBe(
			true,
		);
		const d = await detail(tx, p.task.id);
		expect(d.task.stage).toBe("draft");
		expect(d.approval_requests[0]?.invalidation_reason).toBe("policy_changed");
	});
});

describe("fixture transport: execution outcomes", () => {
	async function approved(
		tx: ReturnType<typeof setup>["tx"],
		over: Partial<WorkspaceDraft> = {},
	) {
		const p = await createPublished(tx, over);
		const run = pendingOf(p, "run");
		must(
			await tx.decide(
				run.id,
				body(run, await challengeFor(tx, run), "approve", key()),
			),
		);
		return p.task.id;
	}

	test("cancel while running is requested until termination is confirmed", async () => {
		const { tx } = setup();
		const id = await approved(tx, { simulation_scenario: "impl_hangs" });
		tx.controls.advance(id);
		let d = await detail(tx, id);
		expect(d.task.stage).toBe("running");
		must(await tx.cancel(id, { expected_rev: d.task.rev }));
		d = await detail(tx, id);
		expect(d.task.stage).toBe("cancel_requested");
		expect(d.engine?.state).toBe("executing"); // never shown cancelled before proof
		expect(d.engine?.cancel_requested_at).not.toBeNull();
		expect(tx.controls.advance(id)).toBe(false); // impl_hangs
		expect(tx.controls.confirmCancel(id)).toBe(true);
		d = await detail(tx, id);
		expect(d.task.stage).toBe("cancelled");
		expect(d.engine?.state).toBe("cancelled");
	});

	test("cancel at awaiting_acceptance is refused (use Reject)", async () => {
		const { tx } = setup();
		const id = await approved(tx);
		tx.controls.runToEnd(id);
		const d = await detail(tx, id);
		expect(code(await tx.cancel(id, { expected_rev: d.task.rev }))).toBe(
			"invalid_state",
		);
	});

	test("verification failure without repair ends the execution; no Gate 2", async () => {
		const { tx } = setup();
		const id = await approved(tx, {
			simulation_scenario: "verification_fails",
		});
		tx.controls.runToEnd(id);
		const d = await detail(tx, id);
		expect(d.task.stage).toBe("execution_ended");
		expect(d.phase).toBe("failed");
		expect(d.engine?.failure_kind).toBe("verification_failed");
		expect(d.approval_requests.some((r) => r.kind === "result")).toBe(false);
	});

	test("one pre-approved repair: attempt 2 is what Gate 2 binds", async () => {
		const { tx } = setup();
		const id = await approved(tx, {
			simulation_scenario: "verification_fails_then_fixed",
			repair_policy: { max_repairs: 1 },
		});
		tx.controls.runToEnd(id);
		const d = await detail(tx, id);
		expect(d.task.stage).toBe("awaiting_acceptance");
		expect(d.runs.map((r) => [r.attempt_no, r.kind, r.outcome])).toEqual([
			[1, "initial", "rejected"],
			[2, "repair", "approved"],
		]);
		const env = pendingOf(d, "result").result_envelope;
		expect(env?.attempt_no).toBe(2);
		expect(env?.run_id).toBe(d.runs[1]?.run_id as string);
	});

	test("unverifiable evidence: the result request is created already invalidated", async () => {
		const { tx } = setup();
		const id = await approved(tx);
		tx.controls.runToEnd(id, "missing");
		const d = await detail(tx, id);
		expect(d.task.stage).toBe("execution_ended");
		const r = d.approval_requests.find((x) => x.kind === "result");
		expect(r?.status).toBe("invalidated");
		expect(r?.invalidation_reason).toBe("evidence_unavailable");
		expect(r?.result_envelope?.evidence_status).toBe("missing");
	});

	test("withheld evidence never discloses text", async () => {
		const { tx } = setup();
		const id = await approved(tx);
		tx.controls.runToEnd(id, "withheld");
		const d = await detail(tx, id);
		const diff = d.artifacts.find((a) => a.kind === "diff");
		const text = ArtifactTextResponse.parse(
			must(await tx.getArtifact(id, diff?.artifact_id as string)),
		);
		expect(text.status).toBe("withheld");
		expect(text.text).toBeNull();
		expect(text.withheld_reasons).toEqual(["context_unavailable"]);
	});

	test("evidence corrupted before acceptance fails closed and invalidates Gate 2", async () => {
		const { tx } = setup();
		const id = await approved(tx);
		tx.controls.runToEnd(id);
		const result = pendingOf(await detail(tx, id), "result");
		const ch = await challengeFor(tx, result);
		tx.controls.corruptEvidence(id, "diff.patch");
		expect(
			code(await tx.decide(result.id, body(result, ch, "accept", key()))),
		).toBe("integrity_failed");
		const d = await detail(tx, id);
		expect(d.task.stage).toBe("execution_ended");
		expect(d.approval_requests[0]?.invalidation_reason).toBe(
			"integrity_failed",
		);
		expect(d.task.accepted_decision_id).toBeNull();
	});

	test("interrupted mid-run does not relaunch; rerun opens a new Gate 1", async () => {
		const { tx } = setup();
		const id = await approved(tx, { simulation_scenario: "impl_hangs" });
		tx.controls.advance(id);
		expect(tx.controls.interrupt(id)).toBe(true);
		let d = await detail(tx, id);
		expect(d.phase).toBe("interrupted");
		expect(tx.controls.advance(id)).toBe(false);
		const r = must(
			await tx.requestRerun(id, {
				expected_rev: d.task.rev,
				proposal_id: d.task.current_proposal_id as string,
			}),
		);
		expect(r.task.stage).toBe("awaiting_run_approval");
		d = await detail(tx, id);
		expect(d.approval_requests.filter((x) => x.kind === "run")).toHaveLength(2);
	});
});

describe("fixture transport: session", () => {
	test("revoked session → 401; sign-in restores; read-only cannot decide", async () => {
		const { tx } = setup();
		const p = await createPublished(tx);
		tx.controls.revokeSession();
		expect(code(await tx.getSnapshot())).toBe("unauthenticated");
		expect(code(await tx.signIn({ credential: "short" }))).toBe(
			"invalid_request",
		);
		tx.controls.rejectNextSignIn();
		expect(code(await tx.signIn({ credential: "x".repeat(20) }))).toBe(
			"unauthenticated",
		);
		SessionView.parse(must(await tx.signIn({ credential: "x".repeat(20) })));
		tx.controls.setReadOnly(true);
		const run = pendingOf(p, "run");
		expect(
			code(
				await tx.issueChallenge(run.id, {
					kind: "run",
					binding_hash: run.binding_hash,
					expected_request_rev: run.rev,
				}),
			),
		).toBe("forbidden_scope");
		must(await tx.signOut());
		expect(code(await tx.getSession())).toBe("unauthenticated");
	});
});

describe("fixture transport: seeded demo", () => {
	test("seedDemo builds every state through public routes, all contract-valid", async () => {
		const { tx } = setup();
		const ids = await tx.controls.seedDemo();
		const stages: Record<string, string> = {};
		for (const [label, id] of Object.entries(ids))
			stages[label] = (await detail(tx, id)).task.stage;
		expect(stages).toEqual({
			draft: "draft",
			gate1: "awaiting_run_approval",
			gate2: "awaiting_acceptance",
			running: "running",
			failed: "execution_ended",
			cancel: "cancel_requested",
			rejected: "rejected",
			accepted: "accepted",
			long: "awaiting_run_approval",
		});
		const snap = WorkspaceSnapshot.parse(must(await tx.getSnapshot()));
		expect(snap.pending_requests.map((r) => r.kind).sort()).toEqual([
			"result",
			"run",
			"run",
		]);
	});
});
