import { describe, expect, test } from "bun:test";
import { TaskSubmission } from "../managed.ts";
import { REDACTED, redact } from "../redact.ts";
import { IDS, SHAS, sampleDraft, sampleProposal } from "./fixtures/sample.ts";
import {
	budgetsFor,
	buildProposalSnapshot,
	criteriaFromText,
	criteriaToText,
	emptyDraft,
	managedTaskFieldsFor,
	ProposalDraft,
	ProposalSnapshot,
	requestsNonSimulatedMode,
	ScopePath,
	WorkspaceDraft,
} from "./index.ts";

describe("criteriaFromText — one criterion per line", () => {
	test("commas, quotes and unicode stay inside one criterion", () => {
		expect(
			criteriaFromText(
				'Prints "hello, world"\nHandles a, b, and c\nnaïve café, 日本語 😀\n\'single\', "double"',
			),
		).toEqual([
			'Prints "hello, world"',
			"Handles a, b, and c",
			"naïve café, 日本語 😀",
			"'single', \"double\"",
		]);
	});
	test("\\r\\n counts as one line break; lines are trimmed; blank lines dropped", () => {
		expect(
			criteriaFromText("  first  \r\n\r\n\t second\t\n   \n third"),
		).toEqual(["first", "second", "third"]);
	});
	test("a comma-only separated line is NOT split", () => {
		expect(criteriaFromText("a,b,c")).toEqual(["a,b,c"]);
	});
	test("empty input → no criteria", () => {
		expect(criteriaFromText("")).toEqual([]);
		expect(criteriaFromText("\n \r\n\t")).toEqual([]);
	});
	test("round trip with criteriaToText", () => {
		const c = ["a, b", 'c "d"', "é"];
		expect(criteriaFromText(criteriaToText(c))).toEqual(c);
	});
	test("a lone \\r inside a line is kept and then rejected by the schema", () => {
		const parsed = criteriaFromText("a\rb");
		expect(parsed).toEqual(["a\rb"]);
		expect(
			WorkspaceDraft.safeParse({ ...emptyDraft(), criteria: parsed }).success,
		).toBe(false);
	});
});

describe("WorkspaceDraft / ProposalDraft", () => {
	test("an empty draft can be saved but not published", () => {
		expect(WorkspaceDraft.safeParse(emptyDraft()).success).toBe(true);
		expect(ProposalDraft.safeParse(emptyDraft()).success).toBe(false);
	});
	test("the sample draft is publishable", () => {
		expect(ProposalDraft.safeParse(sampleDraft()).success).toBe(true);
	});
	const bad: [string, Record<string, unknown>][] = [
		["live mode", { execution_mode: "live" }],
		["unknown key: provider", { provider: "claude" }],
		["unknown key: model", { model: "x" }],
		["unknown key: argv", { argv: ["/bin/sh"] }],
		["unknown key: repo_id", { repo_id: "local/fixture" }],
		["two repairs", { repair_policy: { max_repairs: 2 } }],
		["repair policy extra key", { repair_policy: { max_repairs: 1, x: 1 } }],
		["unknown scenario", { simulation_scenario: "do_anything" }],
		["absolute scope path", { scope: { allowed: ["/etc"], protected: [] } }],
		[
			"dot-dot scope path",
			{ scope: { allowed: ["src/../.."], protected: [] } },
		],
		["trailing slash scope", { scope: { allowed: ["src/"], protected: [] } }],
		["control char in title", { title: "a\u0007b" }],
		["newline in title", { title: "a\nb" }],
		["lone surrogate", { title: "a\ud800" }],
		["title too long", { title: "x".repeat(121) }],
		[
			"21 criteria",
			{ criteria: Array.from({ length: 21 }, (_, i) => `c${i}`) },
		],
		["criterion too long", { criteria: ["x".repeat(501)] }],
	];
	for (const [name, patch] of bad)
		test(`rejected: ${name}`, () => {
			expect(
				WorkspaceDraft.safeParse({ ...sampleDraft(), ...patch }).success,
			).toBe(false);
		});

	test("publish needs title, objective, ≥1 criterion and ≥1 allowed path", () => {
		const d = sampleDraft();
		for (const patch of [
			{ title: "   " },
			{ objective: "\n\t " },
			{ criteria: [] },
			{ criteria: ["ok", "  "] },
			{ scope: { allowed: [], protected: [] } },
		])
			expect(ProposalDraft.safeParse({ ...d, ...patch }).success).toBe(false);
	});

	test("protected paths may not overlap the allowed scope (M1 cannot enforce carve-outs)", () => {
		const d = sampleDraft();
		const scope = (allowed: string[], prot: string[]) =>
			ProposalDraft.safeParse({ ...d, scope: { allowed, protected: prot } })
				.success;
		expect(scope(["src"], ["config"])).toBe(true);
		expect(scope(["src"], ["src/secrets"])).toBe(false); // carve-out inside allowed
		expect(scope(["src/app"], ["src"])).toBe(false); // protected contains allowed
		expect(scope(["src"], ["src"])).toBe(false);
		expect(scope(["."], ["config"])).toBe(false); // whole repo allowed
		expect(scope(["src"], ["."])).toBe(false);
		expect(scope(["src"], ["srcx"])).toBe(true); // segment boundary, not string prefix
		expect(scope(["src", "src"], [])).toBe(false); // duplicates
	});
});

describe("ScopePath ≡ managed TaskSubmission scope rule", () => {
	const samples = [
		".",
		"src",
		"src/app",
		"a b/c-d",
		"@scope/pkg",
		"x+y",
		"_x",
		"/abs",
		"..",
		"a/../b",
		"a//b",
		"a/",
		"-flag",
		"a\\b",
		"a\tb",
		"",
		"x".repeat(200),
		"x".repeat(201),
		".hidden",
		"é",
	];
	const base = {
		idempotency_key: "key-12345678",
		repo_id: "local/fixture",
		title: "t",
		objective: "o",
		acceptance_criteria: ["c"],
		execution_mode: "simulated" as const,
	};
	for (const p of samples)
		test(JSON.stringify(p).slice(0, 40), () => {
			const ours = ScopePath.safeParse(p).success;
			const theirs = TaskSubmission.safeParse({
				...base,
				approved_scope: [p],
			}).success;
			expect(ours).toBe(theirs);
		});
});

describe("buildProposalSnapshot", () => {
	test("trims, normalizes \\r\\n, attaches the fixed M1 policy", () => {
		const s = sampleProposal(1).value;
		expect(s.title).toBe("Add a greeting, politely");
		expect(s.objective).not.toContain("\r");
		expect(s.objective.startsWith("Print a greeting")).toBe(true);
		expect(s.execution_mode).toBe("simulated");
		expect(s.provider_profiles.implementer.provider).toBe("fake");
		expect(s.provider_profiles.reviewer.model).toBeNull();
		expect(s.context_policy).toEqual({ source: "base_snapshot", refs: [] });
		expect(s.budgets).toEqual(budgetsFor({ max_repairs: 1 }));
		expect(s.verification_plan.required_checks).toEqual(["unit"]);
		expect(s.seed_sha).toBeNull();
		expect(ProposalSnapshot.safeParse(s).success).toBe(true);
	});

	test("version 2 must name its predecessor", () => {
		const v2 = sampleProposal(2).value;
		expect(v2.predecessor_proposal_id).toBe(IDS.proposal_v1);
		expect(
			ProposalSnapshot.safeParse({ ...v2, predecessor_proposal_id: null })
				.success,
		).toBe(false);
		expect(
			ProposalSnapshot.safeParse({
				...sampleProposal(1).value,
				predecessor_proposal_id: IDS.proposal_v2,
			}).success,
		).toBe(false);
	});

	test("user text is redacted before it is frozen", () => {
		const secret = ["ghp", "_", "A".repeat(36)].join("");
		const d = { ...sampleDraft(), criteria: [`do not leak ${secret}, ok`] };
		const s = sampleProposal(1, d).value;
		expect(s.criteria[0]).toBe(`do not leak ${REDACTED}, ok`);
		expect(JSON.stringify(s)).not.toContain(secret);
	});

	test("redaction that lengthens text past a bound fails with issues (never truncates)", () => {
		const criterion = `${"z".repeat(489)} password=x`;
		expect(criterion.length).toBe(500);
		expect(redact(criterion).length).toBeGreaterThan(500);
		const d = { ...sampleDraft(), criteria: [criterion] };
		expect(ProposalDraft.safeParse(d).success).toBe(true);
		const res = buildProposalSnapshot({
			proposal_id: IDS.proposal_v1,
			workspace_task_id: IDS.workspace_task,
			version: 1,
			predecessor_proposal_id: null,
			repo_id: "local/fixture",
			base_ref: "main",
			base_sha: SHAS.base,
			required_checks: ["unit"],
			draft: d,
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.issues.map((i) => i.path)).toEqual(["criteria.0"]);
	});

	test("bad trusted inputs are refused", () => {
		const build = (patch: Record<string, unknown>) =>
			buildProposalSnapshot({
				proposal_id: IDS.proposal_v1,
				workspace_task_id: IDS.workspace_task,
				version: 1,
				predecessor_proposal_id: null,
				repo_id: "local/fixture",
				base_ref: "main",
				base_sha: SHAS.base,
				required_checks: ["unit"],
				draft: sampleDraft(),
				...patch,
			}).ok;
		expect(build({})).toBe(true);
		expect(build({ required_checks: [] })).toBe(false);
		expect(build({ required_checks: ["unit", "unit"] })).toBe(false);
		expect(build({ base_sha: "abc" })).toBe(false);
		expect(build({ base_ref: "--upload-pack=x" })).toBe(false);
		expect(build({ repo_id: "no-slash" })).toBe(false);
		expect(build({ proposal_id: "wsp-not-a-uuid" })).toBe(false);
	});
});

describe("managed task mapping", () => {
	test("fields map 1:1 and always parse as a TaskSubmission", () => {
		const s = sampleProposal(1).value;
		const f = managedTaskFieldsFor(s);
		expect(f.acceptance_criteria).toEqual(s.criteria);
		expect(f.approved_scope).toEqual(s.scope.allowed);
		expect(f.repair_limit).toBe(1);
		const parsed = TaskSubmission.parse({
			idempotency_key: IDS.run_request,
			repo_id: f.repo_id,
			title: f.title,
			objective: f.objective,
			acceptance_criteria: f.acceptance_criteria,
			approved_scope: f.approved_scope,
			execution_mode: f.execution_mode,
			simulation_scenario: f.simulation_scenario,
			repair_limit: f.repair_limit,
		});
		// nothing was trimmed / defaulted on the way in: the managed row text is the snapshot text
		expect(parsed.title).toBe(s.title);
		expect(parsed.objective).toBe(s.objective);
		expect(parsed.acceptance_criteria).toEqual(s.criteria);
		expect(parsed.repair_limit).toBe(1);
	});
	test("repair_limit is explicit 0 by default", () => {
		const s = sampleProposal(1, {
			...sampleDraft(),
			repair_policy: { max_repairs: 0 },
		}).value;
		expect(managedTaskFieldsFor(s).repair_limit).toBe(0);
		expect(emptyDraft().repair_policy.max_repairs).toBe(0);
	});
});

describe("live precedence", () => {
	test("any non-simulated execution_mode is detected before parsing", () => {
		expect(
			requestsNonSimulatedMode({ draft: { execution_mode: "live" } }),
		).toBe(true);
		expect(requestsNonSimulatedMode({ execution_mode: "LIVE" })).toBe(true);
		expect(
			requestsNonSimulatedMode({ a: [{ b: { execution_mode: null } }] }),
		).toBe(true);
		expect(requestsNonSimulatedMode({ draft: sampleDraft() })).toBe(false);
		expect(requestsNonSimulatedMode(null)).toBe(false);
		expect(requestsNonSimulatedMode("live")).toBe(false);
	});
});
