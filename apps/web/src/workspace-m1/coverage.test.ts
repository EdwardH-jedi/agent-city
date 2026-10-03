// Criterion ids, check mapping and per-criterion coverage in the UI (role 07, contract delta v1.2
// §A — CONTRACT_V1_2.md). Pins: the fixture rejects an unmapped draft like the hub (400 + issues
// the store renders honestly), v1.2 proposals carry text-stable ids and the plan, Gate-2 envelopes
// carry per-criterion coverage (satisfied / unresolved / unsatisfied, never a green count), legacy
// v1 proposals/results say they have no coverage, and the components render exactly that.
import { describe, expect, test } from "bun:test";
import {
	type AnyProposalSnapshot,
	type ApprovalRequestView,
	emptyDraft,
	isProposalV1_2,
	isResultV1_2,
	type WorkspaceDraft,
	WorkspaceTaskDetail,
} from "@agent-city/schema/workspace-m1";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CriterionCoverageView, TaskCoverage } from "./Coverage.tsx";
import {
	createFixtureTransport,
	type FixtureTransport,
} from "./fixture-transport.ts";
import type { FixtureEvidence } from "./fixture-world.ts";
import {
	LEGACY_COVERAGE_NOTE,
	LEGACY_PROPOSAL_NOTE,
	NO_RESULT_COVERAGE_NOTE,
	worstCriterionStatus,
} from "./labels.ts";
import { CriteriaPlan } from "./parts.tsx";
import { WorkspaceStore } from "./store.ts";
import type { TransportResult } from "./transport.ts";

const T0 = Date.parse("2026-10-02T00:00:00.000Z");
const CRITERIA = ["Build passes, lint passes", "Docs updated", "No new deps"];

function must<T>(r: TransportResult<T>): T {
	if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
	return r.data;
}

let keyN = 0;
const key = () => `coverage-test-${++keyN}`;

const mapped = (
	criteria: readonly string[] = CRITERIA,
): WorkspaceDraft["criterion_checks"] =>
	criteria.map((criterion, i) => ({
		criterion,
		checks: i === 0 ? ["unit", "lint"] : i === 1 ? ["lint"] : ["unit"],
	}));

function draft(over: Partial<WorkspaceDraft> = {}): WorkspaceDraft {
	return {
		...emptyDraft(),
		title: "Coverage task",
		objective: "Exercise criterion coverage.",
		criteria: [...CRITERIA],
		scope: { allowed: ["."], protected: [] },
		criterion_checks: mapped(),
		simulation_scenario: "approve",
		...over,
	};
}

async function create(
	tx: FixtureTransport,
	over: Partial<WorkspaceDraft> = {},
) {
	return must(
		await tx.createTask({
			idempotency_key: key(),
			repo_id: "local/fixture",
			draft: draft(over),
		}),
	);
}

function pendingOf(
	d: { approval_requests: ApprovalRequestView[] },
	kind: "run" | "result",
) {
	const r = d.approval_requests.find(
		(x) => x.kind === kind && x.status === "pending",
	);
	if (!r) throw new Error(`no pending ${kind}`);
	return r;
}

async function decide(
	tx: FixtureTransport,
	req: ApprovalRequestView,
	action: "approve" | "accept",
) {
	const ch = must(
		await tx.issueChallenge(req.id, {
			kind: req.kind,
			binding_hash: req.binding_hash,
			expected_request_rev: req.rev,
		}),
	);
	return tx.decide(
		req.id,
		JSON.stringify({
			idempotency_key: key(),
			kind: req.kind,
			action,
			expected_request_rev: ch.request_rev,
			binding_hash: req.binding_hash,
			confirmation_text: "Edward",
			reason: null,
			challenge: ch.challenge,
		}),
	);
}

/** Published + approved + engine run to the end with the given fixture evidence. */
async function toResult(
	tx: FixtureTransport,
	evidence: FixtureEvidence = "verified",
	over: Partial<WorkspaceDraft> = {},
) {
	const c = await create(tx, over);
	const p = must(
		await tx.publishProposal(c.task.id, { expected_rev: c.task.rev }),
	);
	must(await decide(tx, pendingOf(p, "run"), "approve"));
	tx.controls.runToEnd(c.task.id, evidence);
	return WorkspaceTaskDetail.parse(must(await tx.getTask(c.task.id)));
}

const issuesOf = (r: TransportResult<unknown>) =>
	!r.ok && r.kind === "http"
		? {
				code: r.error.error,
				issues: (r.error.issues ?? []).map((i) => `${i.path}: ${i.message}`),
			}
		: { code: r.ok ? "ok" : r.kind, issues: [] as string[] };

const fixture = () => createFixtureTransport({ now: () => T0 });

describe("publish fails closed without a complete mapping (like the hub)", () => {
	const cases: [string, Partial<WorkspaceDraft>, string][] = [
		[
			"an unmapped criterion",
			{ criterion_checks: mapped().slice(0, 2) },
			"criteria.2: criterion has no check mapping",
		],
		[
			"no mapping at all",
			{ criterion_checks: undefined },
			"criteria.0: criterion has no check mapping",
		],
		[
			"a check the repository does not trust",
			{
				criterion_checks: [
					...mapped().slice(0, 2),
					{ criterion: "No new deps", checks: ["e2e"] },
				],
			},
			"criterion_checks.2.checks.0: not a trusted required check of this repository",
		],
		[
			"a dangling key (saved while editing, then the line changed)",
			{
				criterion_checks: [
					...(mapped() ?? []),
					{ criterion: "an older line", checks: ["unit"] },
				],
			},
			"criterion_checks.3.criterion: mapping names no criterion of this draft",
		],
	];
	for (const [name, over, issue] of cases)
		test(`400 for ${name}; no Gate 1 is opened`, async () => {
			const tx = fixture();
			const c = await create(tx, over); // save accepts an incomplete mapping
			const r = await tx.publishProposal(c.task.id, {
				expected_rev: c.task.rev,
			});
			const got = issuesOf(r);
			expect(got.code).toBe("invalid_request");
			expect(got.issues).toContain(issue);
			const d = WorkspaceTaskDetail.parse(must(await tx.getTask(c.task.id)));
			expect(d.task.stage).toBe("draft");
			expect(d.approval_requests).toEqual([]);
			expect(d.current_proposal).toBeNull();
		});

	test("the store renders the hub's issues verbatim with readable criterion numbers", async () => {
		const tx = fixture();
		const c = await create(tx, { criterion_checks: mapped().slice(0, 1) });
		const store = new WorkspaceStore({ transport: tx, now: () => T0 });
		await store.boot();
		store.navigate({
			view: "projects",
			repoId: "local/fixture",
			taskId: c.task.id,
			requestId: null,
		});
		await store.loadDetail(c.task.id);
		expect(await store.publish(c.task.id, null)).toBe(false);
		const msg = store.getState().command?.message ?? "";
		expect(msg).toContain("criterion 2: criterion has no check mapping");
		expect(msg).toContain("criterion 3: criterion has no check mapping");
		expect(store.getState().command?.status).toBe("failed");
	});
});

describe("v1.2 proposals: text-stable ids and the plan", () => {
	test("criteria carry ids and the coverage plan (checks sorted, criteria order)", async () => {
		const tx = fixture();
		const c = await create(tx);
		const p = must(
			await tx.publishProposal(c.task.id, { expected_rev: c.task.rev }),
		);
		const s = p.current_proposal?.snapshot as AnyProposalSnapshot;
		expect(isProposalV1_2(s)).toBe(true);
		if (!isProposalV1_2(s)) return;
		expect(s.criteria.map((x) => x.text)).toEqual(CRITERIA);
		expect(s.coverage_plan).toEqual(
			s.criteria.map((x, i) => ({
				criterion_id: x.id,
				checks: i === 0 ? ["lint", "unit"] : i === 1 ? ["lint"] : ["unit"],
			})),
		);
		expect(p.current_proposal?.contract_version).toBe(
			"agentcity.proposal/v1.2",
		);
	});

	test("editing one criterion in a revision changes only that criterion's id", async () => {
		const tx = fixture();
		const c = await create(tx);
		const v1 = must(
			await tx.publishProposal(c.task.id, { expected_rev: c.task.rev }),
		);
		// Gate-1 request changes → the operator edits one line and resubmits
		const req = pendingOf(v1, "run");
		const ch = must(
			await tx.issueChallenge(req.id, {
				kind: "run",
				binding_hash: req.binding_hash,
				expected_request_rev: req.rev,
			}),
		);
		must(
			await tx.decide(
				req.id,
				JSON.stringify({
					idempotency_key: key(),
					kind: "run",
					action: "request_changes",
					expected_request_rev: ch.request_rev,
					binding_hash: req.binding_hash,
					confirmation_text: null,
					reason: "Make the docs criterion precise.",
					challenge: ch.challenge,
				}),
			),
		);
		const edited = [
			"Build passes, lint passes",
			"Docs updated, with an example",
			"No new deps",
		];
		const d = must(await tx.getTask(c.task.id));
		const saved = must(
			await tx.saveDraft(c.task.id, {
				expected_rev: d.task.rev,
				draft: draft({ criteria: edited, criterion_checks: mapped(edited) }),
			}),
		);
		const v2 = must(
			await tx.publishProposal(c.task.id, { expected_rev: saved.task.rev }),
		);
		const a = v1.current_proposal?.snapshot as AnyProposalSnapshot;
		const b = v2.current_proposal?.snapshot as AnyProposalSnapshot;
		if (!isProposalV1_2(a) || !isProposalV1_2(b)) throw new Error("v1.2");
		expect(b.version).toBe(2);
		expect(b.criteria[0]?.id).toBe(a.criteria[0]?.id as string);
		expect(b.criteria[2]?.id).toBe(a.criteria[2]?.id as string);
		expect(b.criteria[1]?.id).not.toBe(a.criteria[1]?.id as string);
	});
});

describe("Gate-2 coverage from the sealed result", () => {
	test("verified evidence → every criterion satisfied with log identity; acceptable", async () => {
		const tx = fixture();
		const d = await toResult(tx);
		const r = pendingOf(d, "result");
		const env = r.result_envelope;
		if (!env || !isResultV1_2(env)) throw new Error("v1.2 envelope");
		expect(env.criterion_coverage.map((c) => c.status)).toEqual([
			"satisfied",
			"satisfied",
			"satisfied",
		]);
		for (const c of env.criterion_coverage)
			for (const x of c.checks) {
				expect(x.outcome).toBe("passed");
				const item = env.artifacts.find(
					(a) => a.artifact_id === x.log_artifact_id,
				);
				expect(item?.name).toMatch(new RegExp(`^verify-\\d-${x.check}\\.log$`));
				expect(x.log_sha256).toBe(item?.sha256 as string);
			}
		must(await decide(tx, r, "accept"));
	});

	test("a missing log → its criteria unresolved; the result is not offered for acceptance", async () => {
		const tx = fixture();
		const d = await toResult(tx, "log_missing");
		const r = d.approval_requests.find((x) => x.kind === "result");
		const env = r?.result_envelope;
		if (!env || !isResultV1_2(env)) throw new Error("v1.2 envelope");
		// unit is check #1 (its log removed): criteria 1 (lint+unit) and 3 (unit) are unresolved
		expect(env.criterion_coverage.map((c) => c.status)).toEqual([
			"unresolved",
			"satisfied",
			"unresolved",
		]);
		expect(r?.status).toBe("invalidated");
		expect(r?.invalidation_reason).toBe("evidence_unavailable");
		expect(d.task.stage).toBe("execution_ended");
	});

	test("a failing check → the criteria mapped to it are NOT satisfied; no acceptance", async () => {
		const tx = fixture();
		const d = await toResult(tx, "check_failed");
		const r = d.approval_requests.find((x) => x.kind === "result");
		const env = r?.result_envelope;
		if (!env || !isResultV1_2(env)) throw new Error("v1.2 envelope");
		// lint (the last check) failed: criteria 1 (lint+unit) and 2 (lint) are unsatisfied
		expect(env.criterion_coverage.map((c) => c.status)).toEqual([
			"unsatisfied",
			"unsatisfied",
			"satisfied",
		]);
		expect(r?.status).toBe("invalidated");
		expect(d.task.stage).toBe("execution_ended");
		expect(d.task.stage_detail).toContain("Not every criterion is satisfied");
		// and a decision on it is impossible
		expect(d.approval_requests.some((x) => x.status === "pending")).toBe(false);
	});

	test("verification failure without repair: no sealed result, so nothing is covered", async () => {
		const tx = fixture();
		const d = await toResult(tx, "verified", {
			simulation_scenario: "verification_fails",
		});
		expect(d.approval_requests.some((x) => x.kind === "result")).toBe(false);
		const html = renderToStaticMarkup(
			createElement(TaskCoverage, { detail: d }),
		);
		expect(html).toContain('data-status="none"');
		expect(html).toContain(NO_RESULT_COVERAGE_NOTE);
	});
});

describe("legacy (v1) proposals and results have no coverage — never invented", () => {
	test("a legacy proposal is published as v1 and its result is ineligible (criteria_unmapped)", async () => {
		const tx = fixture();
		tx.controls.setLegacyContract(true);
		// today the routes refuse a legacy grant; its result exists only from pre-policy history
		const c = await create(tx, { criterion_checks: undefined });
		must(await tx.publishProposal(c.task.id, { expected_rev: c.task.rev }));
		expect(tx.controls.runLegacyBeforePolicy(c.task.id, "verified")).toBe(true);
		const d = WorkspaceTaskDetail.parse(must(await tx.getTask(c.task.id)));
		const s = d.current_proposal?.snapshot as AnyProposalSnapshot;
		expect(isProposalV1_2(s)).toBe(false);
		expect(d.current_proposal?.contract_version).toBe("agentcity.proposal/v1");
		const r = d.approval_requests.find((x) => x.kind === "result");
		expect(r?.result_envelope && isResultV1_2(r.result_envelope)).toBe(false);
		expect(r?.status).toBe("invalidated");
		expect(d.task.stage_detail).toContain(
			"a new proposal and approval are required",
		);
		const plan = renderToStaticMarkup(
			createElement(CriteriaPlan, { snapshot: s }),
		);
		expect(plan).toContain('data-status="legacy"');
		expect(plan).toContain(LEGACY_PROPOSAL_NOTE);
		const cov = renderToStaticMarkup(
			createElement(TaskCoverage, { detail: d }),
		);
		expect(cov).toContain('data-status="legacy"');
		expect(cov).toContain(LEGACY_COVERAGE_NOTE);
		expect(cov).not.toContain("data-criterion-id");
	});
});

describe("rendering", () => {
	test("plan: one row per criterion with its id and mapped checks", async () => {
		const tx = fixture();
		const c = await create(tx);
		const p = must(
			await tx.publishProposal(c.task.id, { expected_rev: c.task.rev }),
		);
		const s = p.current_proposal?.snapshot as AnyProposalSnapshot;
		if (!isProposalV1_2(s)) throw new Error("v1.2");
		const html = renderToStaticMarkup(
			createElement(CriteriaPlan, { snapshot: s }),
		);
		for (const [i, x] of s.criteria.entries()) {
			expect(html).toContain(`data-criterion-id="${x.id}"`);
			expect(html).toContain(
				`data-checks="${s.coverage_plan[i]?.checks.join(" ")}"`,
			);
		}
	});

	test("coverage: per-criterion rows, outcomes and log identity; status is the worst criterion", async () => {
		const tx = fixture();
		const d = await toResult(tx, "check_failed");
		const r = d.approval_requests.find((x) => x.kind === "result");
		const env = r?.result_envelope;
		if (!env || !isResultV1_2(env)) throw new Error("v1.2 envelope");
		const html = renderToStaticMarkup(
			createElement(CriterionCoverageView, {
				envelope: env,
				proposal: d.current_proposal?.snapshot ?? null,
			}),
		);
		expect(html).toContain(
			'data-testid="criterion-coverage" data-status="unsatisfied"',
		);
		for (const c of env.criterion_coverage)
			expect(html).toContain(
				`data-criterion-id="${c.criterion_id}" data-status="${c.status}"`,
			);
		expect(html).toContain('data-check="lint" data-outcome="failed"');
		expect(html).toContain(
			'data-check="unit" data-outcome="passed" data-log="present"',
		);
		expect(html).toContain("1 of 3 criteria satisfied · 2 not satisfied");
		// the criterion text comes from the proposal the envelope names
		expect(html).toContain("Docs updated");
	});

	test("worst status: one failing criterion is never hidden by green ones", () => {
		expect(worstCriterionStatus(["satisfied", "satisfied"])).toBe("satisfied");
		expect(worstCriterionStatus(["satisfied", "unresolved"])).toBe(
			"unresolved",
		);
		expect(
			worstCriterionStatus(["unresolved", "unsatisfied", "satisfied"]),
		).toBe("unsatisfied");
		expect(worstCriterionStatus([])).toBe("unresolved");
	});
});
