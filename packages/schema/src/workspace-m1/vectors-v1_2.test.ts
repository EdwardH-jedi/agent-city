// Golden vectors of contract delta v1.2 (fixtures/vectors-v1.2.json). The frozen v1 file
// fixtures/vectors.json is separate and unchanged (its guard is hash.test.ts).
import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { sampleGraph } from "./fixtures/sample.ts";
import { sampleGraphV1_2 } from "./fixtures/sample-v1.2.ts";
import v1vectors from "./fixtures/vectors.json";
import vectors from "./fixtures/vectors-v1.2.json";
import { canonicalEncode, criterionId, sha256Hex } from "./hash.ts";
import {
	CriterionCoverage,
	managedTaskFieldsFor,
	ProposalSnapshot,
	ProposalSnapshotV1_2,
	ResultEnvelopeV1_2,
} from "./index.ts";

type Vector = {
	name: string;
	input: unknown;
	canonical: string;
	sha256: string;
};
const contracts = vectors.contracts as Vector[];

describe("v1.2 vectors (fixtures/vectors-v1.2.json)", () => {
	for (const v of contracts)
		test(v.name, () => {
			expect(canonicalEncode(v.input)).toBe(v.canonical);
			expect(sha256Hex(v.canonical)).toBe(v.sha256);
		});

	test("criterion ids = crit- + 16 hex of sha256(UTF-8 text)", () => {
		expect(vectors.criterion_ids.length).toBe(3);
		for (const c of vectors.criterion_ids) {
			expect(sha256Hex(c.text)).toBe(c.sha256);
			expect(criterionId(c.text)).toBe(c.id);
			expect(c.id).toBe(`crit-${c.sha256.slice(0, 16)}`);
		}
	});

	test("the v1.2 sample graph still produces exactly the frozen vectors", () => {
		const g = sampleGraphV1_2();
		const byName = new Map(contracts.map((v) => [v.name, v]));
		const built: [string, unknown, string][] = [
			["proposal_snapshot_v1_2", g.proposal.value, g.proposal.hash],
			[
				"criterion_coverage_v1_2",
				g.coverage,
				sha256Hex(canonicalEncode(g.coverage)),
			],
			["result_envelope_v1_2", g.result.value, g.result.hash],
		];
		for (const [name, value, hash] of built) {
			const v = byName.get(name);
			expect(v).toBeDefined();
			expect(canonicalEncode(value)).toBe(v?.canonical as string);
			expect(hash).toBe(v?.sha256 as string);
		}
		expect(g.result.value.criterion_coverage).toEqual(g.coverage);
	});

	test("every vector input is valid against its contract schema (validate-only)", () => {
		const schemas: Record<string, z.ZodType> = {
			proposal_snapshot_v1_2: ProposalSnapshotV1_2,
			result_envelope_v1_2: ResultEnvelopeV1_2,
		};
		for (const v of contracts) {
			const parsed =
				v.name === "criterion_coverage_v1_2"
					? (v.input as unknown[]).map((c) => CriterionCoverage.parse(c))
					: (schemas[v.name] as z.ZodType).parse(v.input);
			expect(canonicalEncode(parsed)).toBe(v.canonical);
		}
	});

	test("the v1.2 proposal freezes the same criterion text as the frozen v1 vector", () => {
		const v1 = v1vectors.contracts.find((v) => v.name === "proposal_snapshot");
		const v1Snapshot = ProposalSnapshot.parse(v1?.input);
		const v12 = ProposalSnapshotV1_2.parse(
			contracts.find((v) => v.name === "proposal_snapshot_v1_2")?.input,
		);
		expect(managedTaskFieldsFor(v12).acceptance_criteria).toEqual(
			managedTaskFieldsFor(v1Snapshot).acceptance_criteria,
		);
		expect(v12.title).toBe(v1Snapshot.title);
		expect(v12.objective).toBe(v1Snapshot.objective);
	});

	test("v1 vectors are untouched by the delta (sample graph v1 hash unchanged)", () => {
		const v1 = v1vectors.contracts.find((v) => v.name === "proposal_snapshot");
		expect(sampleGraph().proposal.hash).toBe(v1?.sha256 as string);
	});

	test("no structure contains its own hash; the envelope names the proposal hash", () => {
		const g = sampleGraphV1_2();
		expect(canonicalEncode(g.proposal.value).includes(g.proposal.hash)).toBe(
			false,
		);
		expect(canonicalEncode(g.result.value).includes(g.result.hash)).toBe(false);
		expect(g.result.value.proposal_hash).toBe(g.proposal.hash);
	});
});
