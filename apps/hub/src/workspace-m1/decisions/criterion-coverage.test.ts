// v1.2 §A at the service level (publish command + Gate 2) against a REAL fixture execution: publish is
// v1.2 only and fails closed on any unmapped / dangling / untrusted / duplicate mapping; criterion ids
// are stable across revisions; the sealed envelope carries the derived coverage; a legacy v1
// proposal can neither run again nor have a result accepted (its execution grant itself is refused
// today: obsolete-v1-grant.test.ts); tampered mapping / coverage is refused.
import { afterEach, describe, expect, test } from "bun:test";
import {
	isProposalV1_2,
	isResultV1_2,
	PROPOSAL_CONTRACT_V1_2,
	type WorkspaceDraft,
} from "@agent-city/schema/workspace-m1";
import { criterionId, sha256Hex } from "@agent-city/schema/workspace-m1/hash";
import { getTask } from "../../managed/store.ts";
import { LEGACY_PROPOSAL_DETAIL } from "../evidence/bundle.ts";
import {
	approvedTask,
	approveLegacyV1Raw,
	challenge,
	count,
	createTask,
	decisionBody,
	draft,
	type Env,
	expectOk,
	makeEnv,
	openGate2,
	publish,
	publishLegacyV1,
	runEngine,
} from "./test-support.ts";

const envs: Env[] = [];
afterEach(() => {
	for (const e of envs.splice(0)) e.fx.cleanup();
});

const env = () => {
	const e = makeEnv();
	envs.push(e);
	return e;
};

const proposals = (e: Env) =>
	count(e.db, "SELECT count(*) AS n FROM managed_proposals");
const managedTasks = (e: Env) =>
	count(e.db, "SELECT count(*) AS n FROM managed_tasks");

describe("publish is v1.2 only and fails closed (CONTRACT_V1_2.md §A)", () => {
	const cases: [string, Partial<WorkspaceDraft>, RegExp][] = [
		[
			"a criterion without a mapping",
			{
				criteria: ["A passes", "B passes"],
				criterion_checks: [
					{ criterion: "A passes", checks: ["fixture-check"] },
				],
			},
			/no check mapping/,
		],
		[
			"no mapping at all (coverage is never inferred)",
			{ criteria: ["A passes"], criterion_checks: [] },
			/no check mapping/,
		],
		[
			"a dangling mapping key",
			{
				criteria: ["A passes"],
				criterion_checks: [
					{ criterion: "A passes", checks: ["fixture-check"] },
					{ criterion: "not a criterion", checks: ["fixture-check"] },
				],
			},
			/names no criterion/,
		],
		[
			"a check outside the repo's trusted required checks",
			{
				criteria: ["A passes"],
				criterion_checks: [{ criterion: "A passes", checks: ["lint"] }],
			},
			/not a trusted required check/,
		],
		[
			"a criterion mapped to no check",
			{
				criteria: ["A passes"],
				criterion_checks: [{ criterion: "A passes", checks: [] }],
			},
			/maps to no check/,
		],
		[
			"a duplicate criterion text",
			{
				criteria: ["A passes", "A passes"],
				criterion_checks: [
					{ criterion: "A passes", checks: ["fixture-check"] },
				],
			},
			/duplicate criterion/,
		],
		[
			"two texts that freeze to the same criterion (duplicate id)",
			{
				criteria: ["A passes", " A passes "],
				criterion_checks: [
					{ criterion: "A passes", checks: ["fixture-check"] },
					{ criterion: " A passes ", checks: ["fixture-check"] },
				],
			},
			/duplicate criterion/,
		],
	];
	for (const [name, over, issue] of cases)
		test(`${name} → 400 invalid_request with issues; nothing written`, async () => {
			const e = env();
			const v = await e.ctx();
			const created = await createTask(e, v, draft(over)); // save accepts an incomplete mapping
			const before = { p: proposals(e), m: managedTasks(e) };
			const res = await e.services.commands.publishProposal(
				v,
				created.task.id,
				{ expected_rev: created.task.rev },
				e.tick(),
			);
			expect(res.status).toBe(400);
			const body = res.body as {
				error: string;
				issues?: { path: string; message: string }[];
			};
			expect(body.error).toBe("invalid_request");
			expect(body.issues?.some((i) => issue.test(i.message))).toBe(true);
			expect({ p: proposals(e), m: managedTasks(e) }).toEqual(before);
			expect(e.store.getTask(created.task.id)?.rev).toBe(created.task.rev);
			expect(e.store.getTask(created.task.id)?.stage).toBe("draft");
		});

	test("the stored proposal is the canonical v1.2 snapshot; managed task text is byte-identical", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(
			e,
			v,
			draft({ criteria: ["Fixture check passes", "Nothing else changes"] }),
		);
		const { view, request } = await publish(e, v, created.task.id);
		const row = view.current_proposal;
		if (!row || !isProposalV1_2(row.snapshot)) throw new Error("not v1.2");
		expect(row.contract_version).toBe(PROPOSAL_CONTRACT_V1_2);
		expect(row.snapshot.criteria).toEqual([
			{ id: criterionId("Fixture check passes"), text: "Fixture check passes" },
			{ id: criterionId("Nothing else changes"), text: "Nothing else changes" },
		]);
		expect(row.snapshot.coverage_plan).toEqual(
			row.snapshot.criteria.map((c) => ({
				criterion_id: c.id,
				checks: ["fixture-check"],
			})),
		);
		const raw = e.db
			.query<{ snapshot: string; proposal_hash: string }, [string]>(
				"SELECT snapshot, proposal_hash FROM managed_proposals WHERE id = ?",
			)
			.get(row.id);
		expect(sha256Hex(raw?.snapshot ?? "")).toBe(raw?.proposal_hash ?? "-");
		expect(getTask(e.db, request.managed_task_id)?.acceptance_criteria).toEqual(
			["Fixture check passes", "Nothing else changes"],
		);
	});

	test("criterion ids are stable across a revision: unchanged text keeps its id, an edited one gets a new id", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(
			e,
			v,
			draft({ criteria: ["Keep this criterion", "Edit this criterion"] }),
		);
		const first = await publish(e, v, created.task.id);
		const v1 = first.view.current_proposal?.snapshot;
		if (!v1 || !isProposalV1_2(v1)) throw new Error("not v1.2");
		const task = e.store.getTask(created.task.id);
		if (!task) throw new Error("no task");
		const saved = await e.services.commands.saveDraft(
			v,
			task.id,
			{
				expected_rev: task.rev,
				draft: draft({
					criteria: ["Keep this criterion", "Edited criterion text"],
				}),
			},
			e.tick(),
		);
		expect(saved.status).toBe(200);
		const second = await publish(e, v, created.task.id);
		const v2 = second.view.current_proposal?.snapshot;
		if (!v2 || !isProposalV1_2(v2)) throw new Error("not v1.2");
		expect(v2.version).toBe(2);
		expect(v2.criteria[0]?.id).toBe(v1.criteria[0]?.id as string);
		expect(v2.criteria[1]?.id).not.toBe(v1.criteria[1]?.id as string);
		expect(v2.criteria[1]?.id).toBe(criterionId("Edited criterion text"));
		expect(v2.coverage_plan.map((p) => p.criterion_id)).toEqual(
			v2.criteria.map((c) => c.id),
		);
		// the first version's Gate 1 was superseded
		expect(
			e.store.getApprovalRequest(first.request.id)?.invalidation_reason,
		).toBe("proposal_superseded");
	});
});

describe("Gate 2 under v1.2", () => {
	test("a clean v1.2 run seals coverage inside the envelope hash and is accepted with the durable bundle + validity", async () => {
		const e = env();
		const v = await e.ctx();
		const ids = await approvedTask(e, v);
		await runEngine(e);
		const result = await openGate2(e, ids);
		const envelope = result.result_envelope;
		if (!envelope || !isResultV1_2(envelope))
			throw new Error("not a v1.2 envelope");
		const proposal = e.store.getProposal(result.proposal_id)?.snapshot;
		if (!proposal || !isProposalV1_2(proposal)) throw new Error("not v1.2");
		expect(envelope.criterion_coverage.map((c) => c.criterion_id)).toEqual(
			proposal.criteria.map((c) => c.id),
		);
		const cov = envelope.criterion_coverage[0];
		const log = envelope.artifacts.find(
			(a) => a.name === "verify-1-fixture-check.log",
		);
		expect(cov?.status).toBe("satisfied");
		expect(cov?.checks).toEqual([
			{
				check: "fixture-check",
				outcome: "passed",
				log_artifact_id: log?.artifact_id ?? "-",
				log_sha256: log?.sha256 ?? "-",
			},
		]);
		const ch = challenge(e, v, result.id);
		const res = await e.services.decisions.decide(
			v,
			result.id,
			decisionBody(ch),
			e.tick(),
		);
		const receipt = expectOk(res).receipt;
		expect(receipt.effects.result_envelope_hash).toBe(
			result.result_envelope_hash as string,
		);
		expect(receipt.effects.evidence_bundle_digest).toBe(
			result.evidence_bundle_digest as string,
		);
		expect(e.store.getAcceptanceValidity(receipt.decision_id)?.status).toBe(
			"valid",
		);
	});

	test("a legacy v1 proposal approved before the obsolete-grant policy: its pending result is never acceptable (invalidated with the explicit detail); it cannot run again", async () => {
		const e = env();
		const v = await e.ctx();
		const created = await createTask(e, v);
		const legacy = await publishLegacyV1(e, created.task.id);
		// Gate 1 approved by the PRE-policy hub (today the API refuses it: obsolete-v1-grant.test.ts)
		const raw = approveLegacyV1Raw(e, v, legacy.runRequestId);
		await runEngine(e); // this service-level env has no workspace authorize (pre-policy engine)
		const result = await openGate2(
			e,
			{
				taskId: created.task.id,
				runRequestId: legacy.runRequestId,
				managedTaskId: legacy.managedTaskId,
				decisionId: raw.decisionId,
			},
			{ allowIneligible: true },
		);
		expect(result.result_envelope?.contract).toBe("agentcity.result/v1");
		const ch2 = challenge(e, v, result.id);
		const res = await e.services.decisions.decide(
			v,
			result.id,
			decisionBody(ch2),
			e.tick(),
		);
		expect([res.status, (res.body as { error: string }).error]).toEqual([
			409,
			"evidence_unavailable",
		]);
		const row = e.store.getApprovalRequest(result.id);
		expect(row?.status).toBe("invalidated");
		expect(row?.invalidation_reason).toBe("evidence_unavailable");
		expect(row?.invalidation_detail).toBe(LEGACY_PROPOSAL_DETAIL);
		const task = e.store.getTask(created.task.id);
		expect(task?.stage).toBe("execution_ended");
		expect(
			count(
				e.db,
				"SELECT count(*) AS n FROM managed_decisions WHERE kind = 'result'",
			),
		).toBe(0);
		// …and the legacy proposal is not executed again
		const rerun = e.services.commands.requestRerun(
			v,
			created.task.id,
			{ expected_rev: task?.rev ?? 0, proposal_id: legacy.proposalId },
			e.tick(),
		);
		expect(rerun.status).toBe(400);
		expect(JSON.stringify(rerun.body)).toContain("legacy proposal");
	});

	test("tampered mapping (proposal row) or coverage (envelope row) is refused by the integrity checks", async () => {
		const e = env();
		const v = await e.ctx();
		const ids = await approvedTask(e, v);
		await runEngine(e);
		const result = await openGate2(e, ids);
		const ch = challenge(e, v, result.id);
		const body = decisionBody(ch);
		// a privileged writer lifts the immutability triggers (below the model) …
		e.db.run("DROP TRIGGER managed_proposals_no_update");
		const raw = e.db
			.query<{ snapshot: string }, [string]>(
				"SELECT snapshot FROM managed_proposals WHERE id = ?",
			)
			.get(result.proposal_id)?.snapshot as string;
		const forged = JSON.parse(raw);
		forged.coverage_plan[0].checks = ["forged-check"];
		// (a) mapping rewritten without the hash: the row no longer verifies
		e.db.run("UPDATE managed_proposals SET snapshot = ? WHERE id = ?", [
			JSON.stringify(forged),
			result.proposal_id,
		]);
		const a = await e.services.decisions.decide(v, result.id, body, e.tick());
		expect([a.status, (a.body as { error: string }).error]).toEqual([
			409,
			"integrity_failed",
		]);
		expect(
			count(
				e.db,
				"SELECT count(*) AS n FROM managed_decisions WHERE kind = 'result'",
			),
		).toBe(0);
		// (b) a forged id rewritten COHERENTLY with its own hash: the id ↔ text binding refuses it,
		//     and the request still names the original proposal hash
		e.db.run("UPDATE managed_proposals SET snapshot = ? WHERE id = ?", [
			raw,
			result.proposal_id,
		]);
		const idForged = JSON.parse(raw);
		idForged.criteria[0].id = "crit-0000000000000000";
		idForged.coverage_plan[0].criterion_id = "crit-0000000000000000";
		const text = JSON.stringify(idForged);
		e.db.run(
			"UPDATE managed_proposals SET snapshot = ?, proposal_hash = ? WHERE id = ?",
			[text, sha256Hex(text), result.proposal_id],
		);
		expect(() => e.store.getProposal(result.proposal_id)).toThrow(
			/criterion id/,
		);
		const b = await e.services.decisions.decide(v, result.id, body, e.tick());
		expect(b.status).toBe(409);
		expect(
			count(
				e.db,
				"SELECT count(*) AS n FROM managed_decisions WHERE kind = 'result'",
			),
		).toBe(0);
	});

	test("tampered coverage in the stored envelope (even coherently re-hashed) never verifies", async () => {
		const e = env();
		const v = await e.ctx();
		const ids = await approvedTask(e, v);
		await runEngine(e);
		const result = await openGate2(e, ids);
		const ch = challenge(e, v, result.id);
		e.db.run("DROP TRIGGER managed_approval_requests_update_rules");
		const raw = e.db
			.query<{ result_envelope: string }, [string]>(
				"SELECT result_envelope FROM managed_approval_requests WHERE id = ?",
			)
			.get(result.id)?.result_envelope as string;
		const forged = JSON.parse(raw);
		forged.criterion_coverage[0].checks[0].log_sha256 = "ab".repeat(32);
		const text = JSON.stringify(forged);
		e.db.run(
			"UPDATE managed_approval_requests SET result_envelope = ?, result_envelope_hash = ? WHERE id = ?",
			[text, sha256Hex(text), result.id],
		);
		// the envelope schema re-derives coverage from its own artifacts: the row is refused on read
		expect(() => e.store.getApprovalRequest(result.id)).toThrow();
		const res = await e.services.decisions.decide(
			v,
			result.id,
			decisionBody(ch),
			e.tick(),
		);
		expect(res.status).toBe(409);
		expect(
			count(
				e.db,
				"SELECT count(*) AS n FROM managed_decisions WHERE kind = 'result'",
			),
		).toBe(0);
	});
});
