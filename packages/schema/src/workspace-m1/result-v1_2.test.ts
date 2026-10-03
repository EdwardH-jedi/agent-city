// Contract delta v1.2 (CONTRACT_V1_2.md §A): ResultEnvelope v1.2 `criterion_coverage`, the pure
// derivation rules, eligibility (v1 unchanged; resultEligibilityV1_2 = the full rule), hash binding.
import { describe, expect, test } from "bun:test";
import { sampleGraph } from "./fixtures/sample.ts";
import { sampleGraphV1_2 } from "./fixtures/sample-v1.2.ts";
import { sealAnyResultEnvelope, sealResultEnvelope } from "./hash.ts";
import {
	AnyResultEnvelope,
	type CoveragePlanEntry,
	coverageCheckFor,
	criterionStatusOf,
	deriveCriterionCoverage,
	type EnvelopeArtifact,
	type EnvelopeCheck,
	isResultV1_2,
	overallEvidenceStatus,
	type ProposalSnapshotV1_2,
	ResultEnvelope,
	ResultEnvelopeV1_2,
	resultEligibility,
	resultEligibilityV1_2,
} from "./index.ts";

const g = () => sampleGraphV1_2();
const env = (): ResultEnvelopeV1_2 => structuredClone(g().result.value);
const proposal = (): ProposalSnapshotV1_2 =>
	structuredClone(g().proposal.value);
const plan = (): CoveragePlanEntry[] => proposal().coverage_plan;

/** Keep the envelope schema-valid after a mutation: re-derive evidence status and coverage. */
const rebuild = (
	e: ResultEnvelopeV1_2,
	p: readonly CoveragePlanEntry[] = plan(),
): ResultEnvelopeV1_2 => {
	const out = { ...e, evidence_status: overallEvidenceStatus(e) };
	return { ...out, criterion_coverage: deriveCriterionCoverage(p, out) };
};

const withCheck = (
	e: ResultEnvelopeV1_2,
	name: string,
	patch: Partial<EnvelopeCheck>,
): ResultEnvelopeV1_2 => ({
	...e,
	verification: e.verification.map((c) =>
		c.name === name ? { ...c, ...patch } : c,
	),
});

const withArtifact = (
	e: ResultEnvelopeV1_2,
	name: string,
	patch: Partial<EnvelopeArtifact> | null,
): ResultEnvelopeV1_2 => ({
	...e,
	artifacts:
		patch === null
			? e.artifacts.filter((a) => a.name !== name)
			: e.artifacts.map((a) => (a.name === name ? { ...a, ...patch } : a)),
});

const statuses = (e: ResultEnvelopeV1_2) =>
	e.criterion_coverage.map((c) => c.status);

describe("sample v1.2 envelope", () => {
	test("valid, every criterion satisfied, eligible under both rules", () => {
		const e = env();
		expect(ResultEnvelopeV1_2.safeParse(e).success).toBe(true);
		expect(statuses(e)).toEqual(["satisfied", "satisfied", "satisfied"]);
		expect(resultEligibility(e).eligible).toBe(true);
		expect(resultEligibilityV1_2(e, proposal())).toEqual({
			eligible: true,
			evidence_status: "verified",
			reasons: [],
		});
	});
	test("coverage follows the proposal criteria order and plan", () => {
		const e = env();
		const p = proposal();
		expect(e.criterion_coverage.map((c) => c.criterion_id)).toEqual(
			p.criteria.map((c) => c.id),
		);
		expect(
			e.criterion_coverage.map((c) => c.checks.map((x) => x.check)),
		).toEqual(p.coverage_plan.map((x) => x.checks));
	});
	test("log identity comes from the envelope's own verify-N-<check>.log item", () => {
		const e = env();
		const lint = e.criterion_coverage[1]?.checks[0];
		const item = e.artifacts.find((a) => a.name === "verify-2-lint.log");
		expect(lint?.check).toBe("lint");
		expect(lint?.log_artifact_id).toBe(item?.artifact_id as string);
		expect(lint?.log_sha256).toBe(item?.sha256 as string);
		expect(item?.status).toBe("truncated"); // truncated log capture still counts
	});
});

describe("derivation rules (pure)", () => {
	const outcomeFor = (patch: Partial<EnvelopeCheck>) =>
		coverageCheckFor("unit", withCheck(env(), "unit", patch)).outcome;
	test("check outcomes", () => {
		expect(outcomeFor({})).toBe("passed");
		expect(outcomeFor({ exit_code: 1 })).toBe("failed");
		expect(outcomeFor({ exit_code: -1 })).toBe("failed");
		// completed ∧ exit ≠ 0 is failed even when it also timed out
		expect(outcomeFor({ timed_out: true, exit_code: 137 })).toBe("failed");
		// timed out with exit 0: neither passed nor failed
		expect(outcomeFor({ timed_out: true, exit_code: 0 })).toBe("incomplete");
		// no exit code is not an exit code ≠ 0
		expect(outcomeFor({ exit_code: null })).toBe("incomplete");
		expect(outcomeFor({ completed: false, exit_code: null })).toBe(
			"incomplete",
		);
		expect(outcomeFor({ completed: false, exit_code: 1 })).toBe("incomplete");
		expect(coverageCheckFor("e2e", env()).outcome).toBe("missing");
	});
	test("several results with the same name are ambiguous → incomplete, no log identity", () => {
		const e = env();
		const dup = {
			...e,
			verification: [
				...e.verification,
				{ ...(e.verification[0] as EnvelopeCheck) },
			],
		};
		const c = coverageCheckFor("unit", dup);
		expect(c).toEqual({
			check: "unit",
			outcome: "incomplete",
			log_artifact_id: null,
			log_sha256: null,
		});
	});
	test("passed WITHOUT log evidence → unresolved (log missing, corrupt, stale, withheld, unknown)", () => {
		const cases: [string, Partial<EnvelopeArtifact> | null][] = [
			["absent", null],
			[
				"missing",
				{
					status: "missing",
					artifact_id: null,
					sha256: null,
					byte_len: null,
					truncated: null,
				},
			],
			["corrupt", { status: "corrupt" }],
			["stale", { status: "stale" }],
			["withheld", { status: "withheld" }],
			["unknown", { status: "unknown" }],
		];
		for (const [name, patch] of cases) {
			const e = rebuild(withArtifact(env(), "verify-1-unit.log", patch));
			const unit = e.criterion_coverage[0]?.checks[0];
			expect({ name, outcome: unit?.outcome }).toEqual({
				name,
				outcome: "passed",
			});
			expect({ name, log: unit?.log_artifact_id ?? null }).toEqual({
				name,
				log: null,
			});
			expect({ name, s: statuses(e) }).toEqual({
				name,
				s: ["unresolved", "unresolved", "unresolved"],
			});
			expect(ResultEnvelopeV1_2.safeParse(e).success).toBe(true);
			expect(resultEligibilityV1_2(e, proposal()).reasons).toContain(
				"criterion_unresolved",
			);
		}
	});
	test("the log item is found by the verification index, not the required_checks position", () => {
		const e = env();
		// manifest order swapped: lint is result #1, so its log must be verify-1-lint.log
		const swapped = {
			...e,
			verification: [e.verification[1], e.verification[0]] as EnvelopeCheck[],
		};
		const lint = coverageCheckFor("lint", swapped);
		const unit = coverageCheckFor("unit", swapped);
		expect(lint.outcome).toBe("passed");
		expect(lint.log_artifact_id).toBeNull(); // only verify-2-lint.log exists
		expect(unit.log_artifact_id).toBeNull(); // only verify-1-unit.log exists
	});
	test("criterion status: satisfied / unsatisfied / unresolved", () => {
		const ok = {
			check: "a",
			outcome: "passed" as const,
			log_artifact_id: "art-77777777-7777-4777-8777-777777777771",
			log_sha256: "01".repeat(32),
		};
		const noLog = { ...ok, log_artifact_id: null, log_sha256: null };
		expect(criterionStatusOf([ok])).toBe("satisfied");
		expect(criterionStatusOf([ok, { ...ok, check: "b" }])).toBe("satisfied");
		expect(criterionStatusOf([ok, noLog])).toBe("unresolved");
		expect(criterionStatusOf([{ ...ok, outcome: "failed" }])).toBe(
			"unsatisfied",
		);
		// any failed wins over missing / incomplete
		expect(
			criterionStatusOf([
				{ ...noLog, outcome: "missing" },
				{ ...ok, outcome: "failed" },
			]),
		).toBe("unsatisfied");
		expect(criterionStatusOf([{ ...noLog, outcome: "incomplete" }])).toBe(
			"unresolved",
		);
		expect(criterionStatusOf([{ ...noLog, outcome: "missing" }])).toBe(
			"unresolved",
		);
		expect(criterionStatusOf([])).toBe("unresolved");
	});
	test("a failing check makes exactly the criteria that map it unsatisfied", () => {
		const e = rebuild(withCheck(env(), "lint", { exit_code: 2 }));
		expect(statuses(e)).toEqual(["satisfied", "unsatisfied", "satisfied"]);
		expect(ResultEnvelopeV1_2.safeParse(e).success).toBe(true);
		const r = resultEligibilityV1_2(e, proposal());
		expect(r.eligible).toBe(false);
		expect(r.reasons).toContain("criterion_unsatisfied");
		expect(r.reasons).toContain("required_check_failed");
		expect(resultEligibility(e).reasons).toContain("criterion_unsatisfied");
	});
});

describe("envelope schema re-derives coverage (stored for display, re-derived for decisions)", () => {
	const rejects = (e: unknown, message: string) => {
		const r = ResultEnvelopeV1_2.safeParse(e);
		expect(r.success).toBe(false);
		if (!r.success)
			expect(r.error.issues.map((i) => i.message)).toContain(message);
	};
	test("claims satisfied while the check failed → rejected", () => {
		const e = withCheck(env(), "lint", { exit_code: 2 });
		rejects(
			{ ...e, evidence_status: overallEvidenceStatus(e) },
			"does not match the verification results and artifacts",
		);
	});
	test("forged log identity → rejected", () => {
		const e = env();
		const forged = structuredClone(e);
		const c = forged.criterion_coverage[0]?.checks[0];
		if (c) c.log_sha256 = "ff".repeat(32);
		rejects(forged, "does not match the verification results and artifacts");
	});
	test("duplicate criterion id / check outside required_checks / unsorted checks → rejected", () => {
		const e = env();
		rejects(
			{
				...e,
				criterion_coverage: [e.criterion_coverage[0], e.criterion_coverage[0]],
			},
			"duplicate criterion id",
		);
		const outside = rebuild(e, [
			...plan().slice(0, 2),
			{ criterion_id: plan()[2]?.criterion_id as string, checks: ["e2e"] },
		]);
		rejects(outside, "a covered check is not in required_checks");
		const unsorted = structuredClone(e);
		unsorted.criterion_coverage[1]?.checks.reverse();
		rejects(unsorted, "checks must be sorted and unique");
	});
	test("half-set log identity and unknown keys → rejected", () => {
		const e = structuredClone(env());
		const c = e.criterion_coverage[0]?.checks[0];
		if (c) c.log_sha256 = null;
		expect(ResultEnvelopeV1_2.safeParse(e).success).toBe(false);
		expect(
			ResultEnvelopeV1_2.safeParse({ ...env(), eligible: true }).success,
		).toBe(false);
		const { criterion_coverage: _c, ...noCoverage } = env();
		expect(ResultEnvelopeV1_2.safeParse(noCoverage).success).toBe(false);
	});
});

describe("eligibility: v1 unchanged, v1.2 rule separate", () => {
	const v1Env = (): ResultEnvelope =>
		structuredClone(sampleGraph().result.value);
	test("a legacy v1 envelope keeps its v1 eligibility (hub flows still produce v1)", () => {
		expect(resultEligibility(v1Env())).toEqual({
			eligible: true,
			evidence_status: "verified",
			reasons: [],
		});
	});
	test("legacy v1 proposal → ineligible under the v1.2 rule (criteria_unmapped)", () => {
		const r = resultEligibilityV1_2(v1Env(), sampleGraph().proposal.value);
		expect(r).toEqual({
			eligible: false,
			evidence_status: "verified",
			reasons: ["criteria_unmapped"],
		});
		// even a v1.2 envelope cannot rescue a v1 proposal
		expect(
			resultEligibilityV1_2(env(), sampleGraph().proposal.value).reasons,
		).toEqual(["criteria_unmapped"]);
	});
	test("v1.2 proposal + v1 envelope → coverage_missing", () => {
		expect(resultEligibilityV1_2(v1Env(), proposal()).reasons).toEqual([
			"coverage_missing",
		]);
	});
	test("coverage ids ≠ proposal ids → coverage_mismatch", () => {
		const p = proposal();
		const other = {
			...p,
			criteria: [...p.criteria].reverse(),
			coverage_plan: [...p.coverage_plan].reverse(),
		};
		expect(resultEligibilityV1_2(env(), other).reasons).toContain(
			"coverage_mismatch",
		);
		const fewer = rebuild(env(), plan().slice(0, 2));
		expect(ResultEnvelopeV1_2.safeParse(fewer).success).toBe(true);
		expect(resultEligibilityV1_2(fewer, proposal()).reasons).toContain(
			"coverage_mismatch",
		);
	});
	test("coverage built from another mapping → coverage_mismatch, even if all satisfied", () => {
		const looser = rebuild(
			env(),
			plan().map((x, i) => (i === 1 ? { ...x, checks: ["unit"] } : x)),
		);
		expect(statuses(looser)).toEqual(["satisfied", "satisfied", "satisfied"]);
		expect(resultEligibility(looser).eligible).toBe(true);
		expect(resultEligibilityV1_2(looser, proposal()).reasons).toEqual([
			"coverage_mismatch",
		]);
	});
	test("envelope for another proposal → coverage_mismatch", () => {
		const p = {
			...proposal(),
			proposal_id: "wsp-22222222-2222-4222-8222-222222222229",
		};
		expect(resultEligibilityV1_2(env(), p).reasons).toContain(
			"coverage_mismatch",
		);
	});
});

describe("hash binding and the row union", () => {
	test("changing the coverage (or the mapping behind it) changes the envelope hash", () => {
		const h = g().result.hash;
		const failed = rebuild(withCheck(env(), "lint", { exit_code: 2 }));
		expect(sealResultEnvelope(failed).hash).not.toBe(h);
		const remapped = rebuild(
			env(),
			plan().map((x, i) => (i === 1 ? { ...x, checks: ["unit"] } : x)),
		);
		expect(sealResultEnvelope(remapped).hash).not.toBe(h);
		expect(sealResultEnvelope(env()).hash).toBe(h);
	});
	test("v1 | v1.2 parse by contract; legacy v1 rows stay readable with their hash", () => {
		const legacy = sampleGraph().result;
		const parsedLegacy = AnyResultEnvelope.parse(legacy.value);
		expect(isResultV1_2(parsedLegacy)).toBe(false);
		expect(sealAnyResultEnvelope(parsedLegacy).hash).toBe(legacy.hash);
		const cur = AnyResultEnvelope.parse(env());
		expect(isResultV1_2(cur)).toBe(true);
		expect(sealAnyResultEnvelope(cur).hash).toBe(g().result.hash);
		// a v1 envelope cannot carry coverage; the v1 schema rejects a v1.2 envelope
		expect(
			AnyResultEnvelope.safeParse({
				...legacy.value,
				criterion_coverage: env().criterion_coverage,
			}).success,
		).toBe(false);
		expect(ResultEnvelope.safeParse(env()).success).toBe(false);
	});
});
