// v1.2 §A in the sealer: a v1.2 proposal seals `agentcity.result/v1.2` whose `criterion_coverage` is
// the pure derivation from the proposal's trusted plan and the envelope's own verification results /
// artifact items (inside the envelope hash); eligibility is resultEligibilityV1_2. Real human_ready
// attempts (existing Orchestrator, fake adapters, disposable fixture repo); ordinary file/row tampers.
import { afterAll, describe, expect, test } from "bun:test";
import {
	deriveCriterionCoverage,
	isProposalV1_2,
	isResultV1_2,
	type SealedResult,
} from "@agent-city/schema/workspace-m1";
import {
	sealAnyResultEnvelope,
	sha256Hex,
} from "@agent-city/schema/workspace-m1/hash";
import {
	cleanupSealFixtures,
	type Harness,
	humanReadyRun,
} from "./seal-fixture.ts";
import { createEvidenceSealer, gate2Check } from "./sealer.ts";

afterAll(cleanupSealFixtures);

const sealerFor = (h: Harness) =>
	createEvidenceSealer({ db: h.fx.db, config: h.fx.config, reads: h.reads });

const coverageOf = (s: SealedResult) => {
	if (!isResultV1_2(s.envelope)) throw new Error("not a v1.2 envelope");
	return s.envelope.criterion_coverage;
};

describe("sealing v1.2", () => {
	test("clean: coverage = derivation from the proposal's plan, satisfied with log identity; eligible; bound by the envelope hash", async () => {
		const h = await humanReadyRun();
		if (!isProposalV1_2(h.proposal)) throw new Error("fixture is not v1.2");
		const s = await sealerFor(h).seal(h.input);
		expect(s.envelope.contract).toBe("agentcity.result/v1.2");
		const log = h.row("verify-1-fixture-check.log");
		expect(coverageOf(s)).toEqual([
			{
				criterion_id: h.proposal.criteria[0]?.id as string,
				status: "satisfied",
				checks: [
					{
						check: "fixture-check",
						outcome: "passed",
						log_artifact_id: log.id,
						log_sha256: log.sha256,
					},
				],
			},
		]);
		expect(coverageOf(s)).toEqual(
			deriveCriterionCoverage(h.proposal.coverage_plan, s.envelope),
		);
		expect(s.eligibility).toEqual({
			eligible: true,
			evidence_status: "verified",
			reasons: [],
		});
		// coverage is inside the hash: any change to it is a different envelope (or no envelope)
		const forged = structuredClone(s.envelope) as typeof s.envelope & {
			criterion_coverage: { status: string }[];
		};
		(forged.criterion_coverage[0] as { status: string }).status = "unresolved";
		expect(() => sealAnyResultEnvelope(forged as never)).toThrow();
		// Gate-2 revalidation re-derives the same envelope from fresh reads
		const request = h.requestFor(s.envelope, s.envelope_hash);
		const again = await sealerFor(h).revalidate(request);
		expect(gate2Check(request, again)).toEqual({ ok: true });
		expect(sha256Hex(again.canonical)).toBe(s.envelope_hash);
	});

	test("a mapped check that failed → criterion unsatisfied → ineligible (criterion_unsatisfied)", async () => {
		const h = await humanReadyRun();
		h.remanifest(
			(m) => {
				const v = (m.verification as Record<string, unknown>[])[0] as Record<
					string,
					unknown
				>;
				v.exit_code = 1;
			},
			{ reviews: true },
		);
		const s = await sealerFor(h).seal(h.input);
		expect(coverageOf(s)[0]?.status).toBe("unsatisfied");
		expect(coverageOf(s)[0]?.checks[0]?.outcome).toBe("failed");
		expect(s.eligibility.eligible).toBe(false);
		expect(s.eligibility.reasons).toContain("criterion_unsatisfied");
	});

	test("a passed check whose log artifact is missing → unresolved (no log evidence) → ineligible (criterion_unresolved)", async () => {
		const h = await humanReadyRun();
		h.sql(
			"DELETE FROM managed_artifacts WHERE id = ?",
			h.row("verify-1-fixture-check.log").id,
		);
		const s = await sealerFor(h).seal(h.input);
		const c = coverageOf(s)[0];
		expect(c?.status).toBe("unresolved");
		expect(c?.checks[0]).toMatchObject({
			outcome: "passed",
			log_artifact_id: null,
			log_sha256: null,
		});
		expect(s.eligibility.eligible).toBe(false);
		expect(s.eligibility.reasons).toContain("criterion_unresolved");
	});

	test("a legacy v1 proposal seals a v1 envelope that is never eligible (criteria_unmapped)", async () => {
		const h = await humanReadyRun({ legacy: true });
		const s = await sealerFor(h).seal(h.input);
		expect(s.envelope.contract).toBe("agentcity.result/v1");
		expect(s.eligibility.eligible).toBe(false);
		expect(s.eligibility.reasons).toEqual(["criteria_unmapped"]);
		// the durable bundle still depends only on artifacts / ids (it can be built), but nothing
		// offers this result for acceptance
		const request = h.requestFor(s.envelope, s.envelope_hash);
		expect(gate2Check(request, await sealerFor(h).revalidate(request))).toEqual(
			{
				ok: false,
				code: "evidence_unavailable",
			},
		);
	});
});
