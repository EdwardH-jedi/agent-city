// Contract delta v1.2 (CONTRACT_V1_2.md §A): draft `criterion_checks`, criterion ids, ProposalSnapshot
// v1.2 validation, the v1 | v1.2 row union, the v1.2 builder and managedTaskFieldsFor on both.
import { describe, expect, test } from "bun:test";
import { REDACTED } from "../redact.ts";
import { IDS, SHAS, sampleDraft, sampleProposal } from "./fixtures/sample.ts";
import {
	REQUIRED_CHECKS_V1_2,
	sampleDraftV1_2,
	sampleProposalV1_2,
} from "./fixtures/sample-v1.2.ts";
import {
	buildProposalSnapshotV1_2,
	createTaskRequestHash,
	criterionId,
	criterionIdsMatch,
	hashCanonical,
	proposalHash,
	sealAnyProposal,
	sealProposal,
} from "./hash.ts";
import {
	AnyProposalSnapshot,
	CRITERIA_MAX_ITEMS,
	CriterionId,
	composeProposalSnapshotV1_2,
	coveragePlanProblems,
	criterionCoverageProblems,
	draftCriterionChecks,
	emptyDraft,
	freezeCriterion,
	isProposalV1_2,
	managedTaskFieldsFor,
	PROPOSAL_CONTRACT_V1_2,
	ProposalContractVersion,
	ProposalSnapshot,
	ProposalSnapshotV1_2,
	proposalCriteriaTexts,
	redactDraft,
	WorkspaceDraft,
} from "./index.ts";

const v12 = (): ProposalSnapshotV1_2 =>
	structuredClone(sampleProposalV1_2().value);

const input = (
	draft: WorkspaceDraft = sampleDraftV1_2(),
	required_checks: readonly string[] = REQUIRED_CHECKS_V1_2,
) => ({
	proposal_id: "wsp-22222222-2222-4222-8222-222222222223",
	workspace_task_id: IDS.workspace_task,
	version: 1,
	predecessor_proposal_id: null,
	repo_id: "local/fixture",
	base_ref: "main",
	base_sha: SHAS.base,
	required_checks,
	draft,
});

const messages = (r: { ok: boolean; issues?: { message: string }[] }) =>
	r.ok ? [] : (r.issues ?? []).map((i) => i.message);

describe("criterion id", () => {
	test("crit- + first 16 hex of sha256(UTF-8 text); deterministic", () => {
		const text = "Handles naïve café input — ünïcode, 日本語, 😀";
		const id = criterionId(text);
		expect(id).toMatch(/^crit-[0-9a-f]{16}$/);
		expect(id).toBe(criterionId(text));
		expect(CriterionId.safeParse(id).success).toBe(true);
		// independent recomputation over the UTF-8 bytes
		const hex = new Bun.CryptoHasher("sha256")
			.update(new TextEncoder().encode(text))
			.digest("hex");
		expect(id).toBe(`crit-${hex.slice(0, 16)}`);
	});
	test("unchanged text keeps its id; an edit (even one character) gives a new id", () => {
		expect(criterionId("Exit code stays 0")).toBe(
			criterionId("Exit code stays 0"),
		);
		expect(criterionId("Exit code stays 0")).not.toBe(
			criterionId("Exit code stays 0."),
		);
	});
	test("no Unicode normalization: NFC and NFD texts get different ids", () => {
		expect(criterionId("café")).not.toBe(criterionId("café"));
	});
	test("id form is strict", () => {
		for (const bad of [
			"crit-ABCDEF0123456789",
			"crit-0123",
			"crit-0123456789abcdef0",
			"c-0123456789abcdef",
		])
			expect(CriterionId.safeParse(bad).success).toBe(false);
	});
});

describe("WorkspaceDraft.criterion_checks (save-time rules)", () => {
	test("absent ≡ [] and parsing never adds the key (legacy request_hash unchanged)", () => {
		const legacy = sampleDraft();
		const parsed = WorkspaceDraft.parse(legacy);
		expect("criterion_checks" in parsed).toBe(false);
		expect(draftCriterionChecks(parsed)).toEqual([]);
		expect(
			createTaskRequestHash({ repo_id: "local/fixture", draft: legacy }),
		).toBe(hashCanonical({ repo_id: "local/fixture", draft: legacy }));
	});
	test("an incomplete mapping can be saved (dangling key, no checks yet)", () => {
		const d = {
			...emptyDraft(),
			criteria: ["a"],
			criterion_checks: [
				{ criterion: "a", checks: [] },
				{ criterion: "not yet a criterion", checks: ["unit"] },
			],
		};
		expect(WorkspaceDraft.safeParse(d).success).toBe(true);
	});
	const bad: [string, unknown][] = [
		[
			"duplicate key",
			[
				{ criterion: "a", checks: ["unit"] },
				{ criterion: "a", checks: ["lint"] },
			],
		],
		[
			"duplicate check in one entry",
			[{ criterion: "a", checks: ["unit", "unit"] }],
		],
		["bad check id", [{ criterion: "a", checks: ["has space"] }]],
		[
			"too many checks",
			[
				{
					criterion: "a",
					checks: Array.from({ length: 11 }, (_, i) => `c${i}`),
				},
			],
		],
		[
			"too many entries",
			Array.from({ length: CRITERIA_MAX_ITEMS + 1 }, (_, i) => ({
				criterion: `c${i}`,
				checks: ["unit"],
			})),
		],
		["over-long key", [{ criterion: "x".repeat(501), checks: [] }]],
		["control char in key", [{ criterion: "a\u0007", checks: [] }]],
		["unknown entry key", [{ criterion: "a", checks: [], argv: ["/bin/sh"] }]],
		["not an array", { a: ["unit"] }],
	];
	for (const [name, criterion_checks] of bad)
		test(`rejects ${name}`, () => {
			expect(
				WorkspaceDraft.safeParse({ ...emptyDraft(), criterion_checks }).success,
			).toBe(false);
		});
	test("WorkspaceDraft stays a plain object schema (shape is readable)", () => {
		expect(
			WorkspaceDraft.shape.simulation_scenario.options.length,
		).toBeGreaterThan(0);
		expect("criterion_checks" in WorkspaceDraft.shape).toBe(true);
	});
});

describe("redactDraft — keys redacted exactly like the criteria", () => {
	test("a secret in a criterion and its key becomes the same masked text", () => {
		const secret = ["ghp", "_", "B".repeat(36)].join("");
		const c = `rotate ${secret} today`;
		const d: WorkspaceDraft = {
			...sampleDraft(),
			criteria: [c],
			criterion_checks: [{ criterion: c, checks: ["unit"] }],
		};
		const r = redactDraft(d);
		expect(r.criteria[0]).toBe(`rotate ${REDACTED} today`);
		expect(r.criterion_checks?.[0]?.criterion).toBe(r.criteria[0] as string);
		expect(JSON.stringify(r)).not.toContain(secret);
		expect(WorkspaceDraft.safeParse(r).success).toBe(true);
		// the stored (redacted) draft still publishes: key matches criterion byte-for-byte
		expect(
			criterionCoverageProblems({
				criteria: r.criteria,
				criterion_checks: draftCriterionChecks(r),
				required_checks: ["unit"],
			}),
		).toEqual([]);
	});
	test("a draft without a mapping stays without one", () => {
		expect("criterion_checks" in redactDraft(sampleDraft())).toBe(false);
	});
});

describe("publish rules (criterionCoverageProblems / builder fail closed)", () => {
	const base = sampleDraftV1_2();
	const [a, b, c] = base.criteria as [string, string, string];
	const cases: [string, Partial<WorkspaceDraft>, string][] = [
		[
			"unmapped criterion",
			{
				criterion_checks: [
					{ criterion: a, checks: ["unit"] },
					{ criterion: b, checks: ["unit"] },
				],
			},
			"criterion has no check mapping",
		],
		[
			"criterion with no checks",
			{
				criterion_checks: [
					{ criterion: a, checks: [] },
					{ criterion: b, checks: ["unit"] },
					{ criterion: c, checks: ["unit"] },
				],
			},
			"criterion maps to no check",
		],
		[
			"dangling entry",
			{
				criterion_checks: [
					...(base.criterion_checks ?? []),
					{ criterion: "an old criterion text", checks: ["unit"] },
				],
			},
			"mapping names no criterion of this draft",
		],
		[
			"check outside required_checks",
			{
				criterion_checks: [
					{ criterion: a, checks: ["unit", "e2e"] },
					{ criterion: b, checks: ["unit"] },
					{ criterion: c, checks: ["unit"] },
				],
			},
			"not a trusted required check of this repository",
		],
		[
			"duplicate criterion text",
			{
				criteria: [a, a],
				criterion_checks: [{ criterion: a, checks: ["unit"] }],
			},
			"duplicate criterion",
		],
		[
			"no mapping at all (legacy draft)",
			{ criterion_checks: undefined },
			"criterion has no check mapping",
		],
	];
	for (const [name, patch, message] of cases)
		test(`rejects: ${name}`, () => {
			const d = { ...base, ...patch } as WorkspaceDraft;
			const r = buildProposalSnapshotV1_2(input(d));
			expect(r.ok).toBe(false);
			expect(messages(r)).toContain(message);
		});
	test("matching is by exact stored text (no trimming or case folding)", () => {
		const d: WorkspaceDraft = {
			...base,
			criterion_checks: [
				{ criterion: ` ${a}`, checks: ["unit"] },
				{ criterion: b, checks: ["unit"] },
				{ criterion: c.toUpperCase(), checks: ["unit"] },
			],
		};
		const r = buildProposalSnapshotV1_2(input(d));
		expect(messages(r)).toContain("criterion has no check mapping");
		expect(messages(r)).toContain("mapping names no criterion of this draft");
	});
	test("two criteria that differ only in surrounding whitespace collapse → duplicate id → rejected", () => {
		const d: WorkspaceDraft = {
			...base,
			criteria: ["same text", "same text  "],
			criterion_checks: [
				{ criterion: "same text", checks: ["unit"] },
				{ criterion: "same text  ", checks: ["unit"] },
			],
		};
		const r = buildProposalSnapshotV1_2(input(d));
		expect(r.ok).toBe(false);
		expect(messages(r)).toContain("duplicate criterion id");
	});
});

describe("the v1.2 builder", () => {
	test("orders the plan by criteria, sorts + de-duplicates checks, derives ids from frozen text", () => {
		const p = v12();
		expect(p.contract).toBe(PROPOSAL_CONTRACT_V1_2);
		const texts = sampleDraft().criteria.map(freezeCriterion);
		expect(p.criteria.map((c) => c.text)).toEqual(texts);
		expect(p.criteria.map((c) => c.id)).toEqual(texts.map(criterionId));
		expect(p.coverage_plan).toEqual([
			{ criterion_id: criterionId(texts[0] as string), checks: ["unit"] },
			{
				criterion_id: criterionId(texts[1] as string),
				checks: ["lint", "unit"],
			},
			{ criterion_id: criterionId(texts[2] as string), checks: ["unit"] },
		]);
		expect(p.verification_plan.required_checks).toEqual(["unit", "lint"]);
	});
	test("ids are computed from the redacted, trimmed text", () => {
		const secret = ["ghp", "_", "C".repeat(36)].join("");
		const raw = `  keep ${secret} out  `;
		const d: WorkspaceDraft = {
			...sampleDraftV1_2(),
			criteria: [raw],
			criterion_checks: [{ criterion: raw, checks: ["unit"] }],
		};
		const r = buildProposalSnapshotV1_2(input(d));
		if (!r.ok) throw new Error(JSON.stringify(r.issues));
		const c = r.snapshot.criteria[0];
		expect(c?.text).toBe(`keep ${REDACTED} out`);
		expect(c?.id).toBe(criterionId(`keep ${REDACTED} out`));
		expect(JSON.stringify(r.snapshot)).not.toContain(secret);
	});
	test("unchanged criteria keep their ids across versions; an edited one is replaced", () => {
		const v1 = v12();
		const d = sampleDraftV1_2();
		const edited = `${d.criteria[1]} (also for whitespace-only input)`;
		const next: WorkspaceDraft = {
			...d,
			criteria: [d.criteria[0] as string, edited, d.criteria[2] as string],
			criterion_checks: [
				{ criterion: d.criteria[0] as string, checks: ["unit"] },
				{ criterion: edited, checks: ["lint"] },
				{ criterion: d.criteria[2] as string, checks: ["unit"] },
			],
		};
		const r = buildProposalSnapshotV1_2({
			...input(next),
			proposal_id: "wsp-22222222-2222-4222-8222-222222222224",
			version: 2,
			predecessor_proposal_id: v1.proposal_id,
		});
		if (!r.ok) throw new Error(JSON.stringify(r.issues));
		const ids = r.snapshot.criteria.map((c) => c.id);
		expect(ids[0]).toBe(v1.criteria[0]?.id as string);
		expect(ids[2]).toBe(v1.criteria[2]?.id as string);
		expect(ids[1]).not.toBe(v1.criteria[1]?.id as string);
	});
	test("compose with a forged id function → sealProposal refuses the snapshot", () => {
		const r = composeProposalSnapshotV1_2(input(), (t) => criterionId(`${t}!`));
		if (!r.ok) throw new Error("schema-valid ids expected");
		expect(criterionIdsMatch(r.snapshot)).toBe(false);
		expect(() => sealProposal(r.snapshot)).toThrow(
			"criterion id does not match its text",
		);
	});
});

describe("ProposalSnapshot v1.2 schema", () => {
	test("the sample is valid; v1 schema rejects it and vice versa", () => {
		expect(ProposalSnapshotV1_2.safeParse(v12()).success).toBe(true);
		expect(ProposalSnapshot.safeParse(v12()).success).toBe(false);
		expect(ProposalSnapshotV1_2.safeParse(sampleProposal().value).success).toBe(
			false,
		);
	});
	const broken: [string, (p: ProposalSnapshotV1_2) => unknown, string][] = [
		[
			"duplicate criterion id",
			(p) => ({
				...p,
				criteria: [
					p.criteria[0],
					{ ...p.criteria[1], id: p.criteria[0]?.id },
					p.criteria[2],
				],
			}),
			"duplicate criterion id",
		],
		[
			"duplicate criterion text",
			(p) => ({
				...p,
				criteria: [
					p.criteria[0],
					{ ...p.criteria[1], text: p.criteria[0]?.text },
					p.criteria[2],
				],
			}),
			"duplicate criterion text",
		],
		[
			"unmapped criterion (plan entry missing)",
			(p) => ({ ...p, coverage_plan: p.coverage_plan.slice(0, 2) }),
			"criterion has no coverage plan entry",
		],
		[
			"dangling plan id",
			(p) => ({
				...p,
				coverage_plan: [
					...p.coverage_plan.slice(0, 2),
					{ criterion_id: "crit-0000000000000000", checks: ["unit"] },
				],
			}),
			"coverage plan names no criterion (dangling id)",
		],
		[
			"plan out of criteria order",
			(p) => ({ ...p, coverage_plan: [...p.coverage_plan].reverse() }),
			"coverage plan must follow the criteria order",
		],
		[
			"criterion planned twice",
			(p) => ({
				...p,
				coverage_plan: [
					p.coverage_plan[0],
					p.coverage_plan[0],
					p.coverage_plan[2],
				],
			}),
			"criterion planned more than once",
		],
		[
			"check outside verification_plan.required_checks",
			(p) => ({
				...p,
				coverage_plan: p.coverage_plan.map((e, i) =>
					i === 0 ? { ...e, checks: ["e2e", "unit"] } : e,
				),
			}),
			"check is not in verification_plan.required_checks",
		],
		[
			"unsorted checks",
			(p) => ({
				...p,
				coverage_plan: p.coverage_plan.map((e, i) =>
					i === 1 ? { ...e, checks: ["unit", "lint"] } : e,
				),
			}),
			"checks must be sorted and unique",
		],
		[
			"duplicate checks",
			(p) => ({
				...p,
				coverage_plan: p.coverage_plan.map((e, i) =>
					i === 0 ? { ...e, checks: ["unit", "unit"] } : e,
				),
			}),
			"checks must be sorted and unique",
		],
	];
	for (const [name, mutate, message] of broken)
		test(`rejects: ${name}`, () => {
			const r = ProposalSnapshotV1_2.safeParse(mutate(v12()));
			expect(r.success).toBe(false);
			if (!r.success)
				expect(r.error.issues.map((i) => i.message)).toContain(message);
		});
	test("empty checks / empty plan / unknown key are rejected", () => {
		const p = v12();
		for (const bad of [
			{
				...p,
				coverage_plan: p.coverage_plan.map((e) => ({ ...e, checks: [] })),
			},
			{ ...p, coverage_plan: [] },
			{ ...p, criteria: p.criteria.map((c) => ({ ...c, weight: 1 })) },
			{ ...p, coverage: p.coverage_plan },
		])
			expect(ProposalSnapshotV1_2.safeParse(bad).success).toBe(false);
	});
	test("coveragePlanProblems is the same rule set, usable without zod", () => {
		expect(coveragePlanProblems(v12())).toEqual([]);
	});
});

describe("row union v1 | v1.2 (legacy rows stay readable)", () => {
	test("parses both by contract; isProposalV1_2 discriminates", () => {
		const legacy = AnyProposalSnapshot.parse(sampleProposal().value);
		const cur = AnyProposalSnapshot.parse(v12());
		expect(isProposalV1_2(legacy)).toBe(false);
		expect(isProposalV1_2(cur)).toBe(true);
		expect(
			AnyProposalSnapshot.safeParse({
				...v12(),
				contract: "agentcity.proposal/v2",
			}).success,
		).toBe(false);
		expect(ProposalContractVersion.options).toEqual([
			"agentcity.proposal/v1",
			"agentcity.proposal/v1.2",
		]);
	});
	test("a v1 row cannot smuggle a coverage plan; a v1.2 row cannot drop it", () => {
		expect(
			AnyProposalSnapshot.safeParse({
				...sampleProposal().value,
				coverage_plan: v12().coverage_plan,
			}).success,
		).toBe(false);
		const { coverage_plan: _drop, ...noPlan } = v12();
		expect(AnyProposalSnapshot.safeParse(noPlan).success).toBe(false);
	});
	test("the legacy v1 hash is unchanged by the union (sealAnyProposal = sealProposal)", () => {
		const legacy = sampleProposal();
		expect(sealAnyProposal(legacy.value).hash).toBe(legacy.hash);
		expect(proposalHash(legacy.value)).toBe(legacy.hash);
	});
});

describe("managedTaskFieldsFor handles v1 and v1.2", () => {
	test("v1.2 acceptance_criteria are byte-identical to the v1 strings of the same draft", () => {
		const a = managedTaskFieldsFor(sampleProposal().value);
		const b = managedTaskFieldsFor(v12());
		expect(b.acceptance_criteria).toEqual(a.acceptance_criteria);
		expect(JSON.stringify(b.acceptance_criteria)).toBe(
			JSON.stringify(a.acceptance_criteria),
		);
		expect(proposalCriteriaTexts(v12())).toEqual(a.acceptance_criteria);
		// every other managed field is the same too (only the check list differs)
		expect({ ...b, acceptance_criteria: null }).toEqual({
			...a,
			acceptance_criteria: null,
		});
	});
});

describe("hash binding", () => {
	test("changing the mapping changes the proposal hash", () => {
		const p = v12();
		const h = proposalHash(p);
		const moved = {
			...p,
			coverage_plan: p.coverage_plan.map((e, i) =>
				i === 0 ? { ...e, checks: ["lint", "unit"] } : e,
			),
		};
		expect(ProposalSnapshotV1_2.safeParse(moved).success).toBe(true);
		expect(proposalHash(moved)).not.toBe(h);
	});
	test("changing a criterion text (with its matching id) changes the hash; a stale id is refused", () => {
		const p = v12();
		const text = `${p.criteria[0]?.text} now`;
		const edited = {
			...p,
			criteria: p.criteria.map((c, i) =>
				i === 0 ? { id: criterionId(text), text } : c,
			),
			coverage_plan: p.coverage_plan.map((e, i) =>
				i === 0 ? { ...e, criterion_id: criterionId(text) } : e,
			),
		};
		expect(proposalHash(edited)).not.toBe(proposalHash(p));
		const stale = {
			...p,
			criteria: p.criteria.map((c, i) => (i === 0 ? { ...c, text } : c)),
		};
		expect(() => sealProposal(stale)).toThrow(
			"criterion id does not match its text",
		);
	});
});
