import { describe, expect, test } from "bun:test";
import { sampleGraph } from "./fixtures/sample.ts";
import {
	ARTIFACT_POLICY,
	EnvelopeArtifact,
	type EvidenceStatus,
	expectedRequiredArtifactNames,
	overallEvidenceStatus,
	ResultEnvelope,
	resultEligibility,
} from "./index.ts";

const env = (): ResultEnvelope => structuredClone(sampleGraph().result.value);

/** Recompute evidence_status so the envelope stays schema-valid after a mutation. */
const fix = (e: ResultEnvelope): ResultEnvelope => ({
	...e,
	evidence_status: overallEvidenceStatus(e),
});

const setStatus = (
	e: ResultEnvelope,
	name: string,
	status: EvidenceStatus,
): ResultEnvelope => {
	const artifacts = e.artifacts.map((a) => {
		if (a.name !== name) return a;
		if (status === "missing")
			return {
				...a,
				status,
				artifact_id: null,
				sha256: null,
				byte_len: null,
				truncated: null,
			};
		return { ...a, status, truncated: status === "truncated" };
	});
	return fix({ ...e, artifacts });
};

describe("sample envelope", () => {
	test("is valid and eligible", () => {
		const e = env();
		expect(ResultEnvelope.safeParse(e).success).toBe(true);
		expect(resultEligibility(e)).toEqual({
			eligible: true,
			evidence_status: "verified",
			reasons: [],
		});
	});
	test("has no stored `eligible` field (derived only)", () => {
		expect(ResultEnvelope.safeParse({ ...env(), eligible: true }).success).toBe(
			false,
		);
	});
	test("rejects argv, live mode and unknown keys", () => {
		const e = env();
		expect(
			ResultEnvelope.safeParse({ ...e, execution_mode: "live" }).success,
		).toBe(false);
		const withArgv = structuredClone(e) as unknown as {
			verification: Record<string, unknown>[];
		};
		(withArgv.verification[0] as Record<string, unknown>).argv = ["/bin/true"];
		expect(ResultEnvelope.safeParse(withArgv).success).toBe(false);
	});
	test("required names = manifest, diff, review output, one log per check", () => {
		expect(expectedRequiredArtifactNames(env())).toEqual([
			"manifest.json",
			"diff.patch",
			"review-output.json",
			"verify-1-unit.log",
		]);
	});
});

describe("evidence status never normalizes to success", () => {
	const bad: EvidenceStatus[] = ["missing", "corrupt", "stale", "unknown"];
	for (const name of [
		"manifest.json",
		"diff.patch",
		"review-output.json",
		"verify-1-unit.log",
	])
		for (const s of bad)
			test(`required ${name}: ${s} → ineligible`, () => {
				const e = setStatus(env(), name, s);
				expect(ResultEnvelope.safeParse(e).success).toBe(true);
				expect(e.evidence_status).toBe(s);
				const r = resultEligibility(e);
				expect(r.eligible).toBe(false);
				expect(r.reasons).toContain("evidence_not_verified");
			});

	test("truncated or withheld manifest / diff / review output → ineligible", () => {
		for (const name of ["manifest.json", "diff.patch", "review-output.json"])
			for (const s of ["truncated", "withheld"] as const)
				expect(resultEligibility(setStatus(env(), name, s)).eligible).toBe(
					false,
				);
	});

	test("a truncated verification log capture is acceptable; withheld is not", () => {
		expect(
			resultEligibility(setStatus(env(), "verify-1-unit.log", "truncated"))
				.eligible,
		).toBe(true);
		expect(
			resultEligibility(setStatus(env(), "verify-1-unit.log", "withheld"))
				.eligible,
		).toBe(false);
	});

	test("optional diagnostics may be truncated/withheld but never corrupt/stale/unknown", () => {
		for (const s of ["truncated", "withheld"] as const)
			expect(
				resultEligibility(setStatus(env(), "review.log", s)).eligible,
			).toBe(true);
		for (const s of ["corrupt", "stale", "unknown"] as const)
			expect(
				resultEligibility(setStatus(env(), "implementation.log", s)).eligible,
			).toBe(false);
	});

	test("an expected required artifact absent from the list counts as missing", () => {
		const e = env();
		const without = fix({
			...e,
			artifacts: e.artifacts.filter((a) => a.name !== "diff.patch"),
		});
		expect(without.evidence_status).toBe("missing");
		expect(resultEligibility(without).eligible).toBe(false);
	});

	test("worst status wins (corrupt > stale > missing > unknown)", () => {
		let e = setStatus(env(), "diff.patch", "unknown");
		e = setStatus(e, "manifest.json", "stale");
		expect(e.evidence_status).toBe("stale");
		e = setStatus(e, "review-output.json", "corrupt");
		expect(e.evidence_status).toBe("corrupt");
	});

	test("eligibility re-derives the status instead of trusting the field", () => {
		const e = setStatus(env(), "diff.patch", "corrupt");
		const lying = { ...e, evidence_status: "verified" as const };
		expect(ResultEnvelope.safeParse(lying).success).toBe(false);
		expect(resultEligibility(lying).eligible).toBe(false);
	});

	test("every artifact kind has a policy; required kinds accept only verified bytes", () => {
		for (const [kind, p] of Object.entries(ARTIFACT_POLICY)) {
			expect(p.acceptable).toContain("verified");
			for (const s of ["missing", "corrupt", "stale", "unknown"] as const)
				expect(p.acceptable).not.toContain(s);
			if (kind !== "verification_log" && p.required)
				expect(p.acceptable).toEqual(["verified"]);
		}
	});
});

describe("artifact item shape", () => {
	const ok = sampleGraph().result.value.artifacts[1] as EnvelopeArtifact;
	test("missing ⇔ null identity", () => {
		expect(EnvelopeArtifact.safeParse(ok).success).toBe(true);
		expect(
			EnvelopeArtifact.safeParse({ ...ok, status: "missing" }).success,
		).toBe(false);
		expect(
			EnvelopeArtifact.safeParse({
				...ok,
				artifact_id: null,
				sha256: null,
				byte_len: null,
				truncated: null,
			}).success,
		).toBe(false);
	});
	test("verified ⇒ not truncated; truncated ⇒ truncated row", () => {
		expect(EnvelopeArtifact.safeParse({ ...ok, truncated: true }).success).toBe(
			false,
		);
		expect(
			EnvelopeArtifact.safeParse({ ...ok, status: "truncated" }).success,
		).toBe(false);
	});
	test("artifacts must be sorted and unique", () => {
		const e = env();
		expect(
			ResultEnvelope.safeParse({ ...e, artifacts: [...e.artifacts].reverse() })
				.success,
		).toBe(false);
		expect(
			ResultEnvelope.safeParse({
				...e,
				artifacts: [...e.artifacts, e.artifacts[6]],
			}).success,
		).toBe(false);
	});
});

describe("checks, review, attempt, provenance", () => {
	test("required check failing / missing / timed out", () => {
		const e = env();
		const v = e.verification[0];
		if (!v) throw new Error("fixture");
		expect(
			resultEligibility({ ...e, verification: [{ ...v, exit_code: 1 }] })
				.reasons,
		).toContain("required_check_failed");
		expect(
			resultEligibility({ ...e, verification: [{ ...v, completed: false }] })
				.reasons,
		).toContain("required_check_failed");
		expect(
			resultEligibility({ ...e, verification: [{ ...v, timed_out: true }] })
				.reasons,
		).toContain("required_check_failed");
		expect(
			resultEligibility({ ...e, verification: [{ ...v, exit_code: null }] })
				.reasons,
		).toContain("required_check_failed");
		expect(
			resultEligibility({ ...e, required_checks: ["unit", "lint"] }).reasons,
		).toContain("required_check_missing");
	});
	test("review must approve, be valid, bind the same candidate + manifest, have no blockers", () => {
		const e = env();
		const r = (patch: Partial<ResultEnvelope["review"]>) =>
			resultEligibility({ ...e, review: { ...e.review, ...patch } }).reasons;
		expect(r({ verdict: "reject" })).toContain("review_not_approving");
		expect(r({ verdict: null })).toContain("review_not_approving");
		expect(r({ valid: false })).toContain("review_invalid");
		expect(r({ candidate_sha: "0".repeat(40) })).toContain(
			"review_binding_mismatch",
		);
		expect(r({ manifest_hash: "0".repeat(64) })).toContain(
			"review_binding_mismatch",
		);
		expect(r({ blocking_findings: 1 })).toContain("review_blocking_findings");
	});
	test("attempt 2 needs an approved repair; attempt 1 starts at base", () => {
		const e = env();
		expect(ResultEnvelope.safeParse({ ...e, max_repairs: 0 }).success).toBe(
			false,
		);
		expect(resultEligibility({ ...e, max_repairs: 0 }).reasons).toContain(
			"attempt_out_of_range",
		);
		expect(ResultEnvelope.safeParse({ ...e, attempt_no: 1 }).success).toBe(
			false,
		); // parent ≠ base
		expect(
			ResultEnvelope.safeParse({ ...e, attempt_no: 1, parent_sha: e.base_sha })
				.success,
		).toBe(true);
		expect(ResultEnvelope.safeParse({ ...e, attempt_no: 3 }).success).toBe(
			false,
		);
	});
	test("anything but fake/simulated provenance is ineligible in M1", () => {
		const e = env();
		const live = {
			...e,
			provenance: {
				...e.provenance,
				reviewer: {
					...e.provenance.reviewer,
					provider: "codex" as const,
					mode: "live" as const,
				},
			},
		};
		expect(resultEligibility(live).reasons).toContain("not_simulated");
	});
});
