// Draft editor model (role 07): criteria one per line (commas never split), round-trips, issues.
import { describe, expect, test } from "bun:test";
import { criteriaFromText, emptyDraft } from "@agent-city/schema/workspace-m1";
import {
	checksFor,
	draftFromForm,
	formFromDraft,
	formMatchesDraft,
	linesOf,
	newDraftForm,
	publishIssues,
	readableIssuePath,
	SCENARIOS,
	toggleCheck,
	unmappedCriteria,
} from "./draft-form.ts";

/** The fixture repository's trusted checks, in config order. */
const CHECKS = ["unit", "lint"] as const;

const LONG = `${"x, ".repeat(99)}end`; // 300 characters with commas

describe("criteria (BRW-J-02, N-9)", () => {
	test("one criterion per non-blank line; commas, quotes and unicode stay inside", () => {
		const text = [
			"a, b and c",
			"  leading spaces",
			"unicode — café, ok",
			"",
			LONG,
			'"quoted", too\r',
		].join("\n");
		const f = {
			...newDraftForm(),
			title: "T",
			objective: "O",
			criteriaText: text,
		};
		const d = draftFromForm(f);
		expect(d.ok).toBe(true);
		if (!d.ok) return;
		expect(d.draft.criteria).toEqual([
			"a, b and c",
			"leading spaces",
			"unicode — café, ok",
			LONG,
			'"quoted", too',
		]);
		expect(d.draft.criteria).toEqual(criteriaFromText(text));
	});

	test("form → draft → form → draft is stable", () => {
		const f = {
			...newDraftForm(),
			title: "Add retry",
			objective: "Line one\nLine two",
			criteriaText: "Build passes, lint passes\nDocs updated, with one example",
		};
		const d1 = draftFromForm(f);
		if (!d1.ok) throw new Error("draft");
		const f2 = formFromDraft(d1.draft);
		const d2 = draftFromForm(f2);
		expect(d2.ok && d2.draft).toEqual(d1.draft);
		expect(formMatchesDraft(f2, d1.draft)).toBe(true);
		expect(
			formMatchesDraft(
				{ ...f2, criteriaText: `${f2.criteriaText}\nmore` },
				d1.draft,
			),
		).toBe(false);
	});
});

describe("defaults and validation", () => {
	test("Assign work starts with the whole repository allowed, no repair, approve scenario", () => {
		const f = newDraftForm();
		expect(f.allowedText).toBe(".");
		expect(f.maxRepairs).toBe(0);
		expect(f.scenario).toBe("approve");
		expect(SCENARIOS).toContain("verification_fails_then_fixed");
	});

	test("paths are one per line", () => {
		expect(linesOf("src\n\n tests \r\n")).toEqual(["src", "tests"]);
	});

	test("publish issues name the missing fields; a complete, mapped draft has none", () => {
		const issues = publishIssues(newDraftForm(), CHECKS);
		const fields = issues.map((i) => i.field);
		expect(fields).toContain("title");
		expect(fields).toContain("objective");
		expect(fields).toContain("criteriaText");
		// v1.2 (CONTRACT_V1_2.md §A): "complete" now includes a criterion → check mapping
		const complete = {
			...newDraftForm(),
			title: "T",
			objective: "O",
			criteriaText: "c",
		};
		expect(
			publishIssues(toggleCheck(complete, "c", "unit", true), CHECKS),
		).toEqual([]);
	});

	test("an unmapped criterion blocks publishing and is named", () => {
		const f = {
			...newDraftForm(),
			title: "T",
			objective: "O",
			criteriaText: "first, with a comma\nsecond",
		};
		const one = toggleCheck(f, "first, with a comma", "lint", true, CHECKS);
		expect(unmappedCriteria(one)).toEqual([{ n: 2, criterion: "second" }]);
		const issues = publishIssues(one, CHECKS);
		expect(issues).toEqual([
			{
				field: "criterionChecks",
				message: "criterion 2: criterion has no check mapping",
			},
		]);
		// unknown repository checks never pass silently
		const all = toggleCheck(one, "second", "unit", true, CHECKS);
		expect(publishIssues(all, CHECKS)).toEqual([]);
		expect(publishIssues(all, null).map((i) => i.field)).toEqual([
			"criterionChecks",
		]);
		// a check the repository does not trust is rejected like the hub would
		expect(
			publishIssues(toggleCheck(all, "second", "e2e", true), CHECKS)
				.map((i) => i.message)
				.join(" "),
		).toContain("not a trusted required check");
	});

	test("the mapping is keyed by exact text: editing a line unmaps it; dangling keys are pruned", () => {
		let f = {
			...newDraftForm(),
			title: "T",
			objective: "O",
			criteriaText: "keep\nchange me",
		};
		f = toggleCheck(f, "keep", "unit", true, CHECKS);
		f = toggleCheck(f, "change me", "lint", true, CHECKS);
		const edited = { ...f, criteriaText: "keep\nchanged" };
		expect(unmappedCriteria(edited).map((u) => u.criterion)).toEqual([
			"changed",
		]);
		const built = draftFromForm(edited);
		if (!built.ok) throw new Error("draft");
		expect(built.draft.criterion_checks).toEqual([
			{ criterion: "keep", checks: ["unit"] },
		]);
		// same text again = the same criterion: its mapping comes back
		expect(
			checksFor({ ...edited, criteriaText: "keep\nchange me" }, "change me"),
		).toEqual(["lint"]);
		// checks keep the repository order regardless of click order
		const both = toggleCheck(
			toggleCheck(f, "keep", "lint", true, CHECKS),
			"keep",
			"unit",
			true,
			CHECKS,
		);
		expect(checksFor(both, "keep")).toEqual(["unit", "lint"]);
		// no mapping at all → the key is omitted (legacy drafts keep their byte form)
		const none = draftFromForm({ ...f, criterionChecks: {} });
		expect(none.ok && "criterion_checks" in none.draft).toBe(false);
	});

	test("formFromDraft → draftFromForm round-trips a stored mapping (Save never strips it)", () => {
		const d = {
			...emptyDraft(),
			title: "T",
			objective: "O",
			criteria: ["a", "b"],
			scope: { allowed: ["."], protected: [] },
			criterion_checks: [
				{ criterion: "a", checks: ["unit"] },
				{ criterion: "b", checks: ["unit", "lint"] },
			],
		};
		const f = formFromDraft(d);
		expect(formMatchesDraft(f, d)).toBe(true);
		const back = draftFromForm(f);
		expect(back.ok && back.draft.criterion_checks).toEqual(d.criterion_checks);
	});

	test("server issue paths read as criterion / mapping numbers", () => {
		expect(readableIssuePath("criteria.0")).toBe("criterion 1");
		expect(readableIssuePath("criterion_checks.2.checks.0")).toBe(
			"check mapping 3",
		);
		expect(readableIssuePath("")).toBe("draft");
		expect(readableIssuePath("title")).toBe("title");
	});

	test("overlapping protected scope is reported on the protected field", () => {
		const issues = publishIssues(
			{
				...newDraftForm(),
				title: "T",
				objective: "O",
				criteriaText: "c",
				allowedText: "src",
				protectedText: "src/secret",
			},
			CHECKS,
		);
		expect(issues.length).toBeGreaterThan(0);
	});

	test("control characters are rejected, not silently dropped", () => {
		const d = draftFromForm({ ...newDraftForm(), title: "bad\u0007title" });
		expect(d.ok).toBe(false);
	});
});
