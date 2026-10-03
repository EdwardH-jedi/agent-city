// Draft editor model (role 07). The form keeps raw text; the draft sent to the hub is built only
// through the contract's `criteriaFromText` (one criterion per line — commas, quotes and unicode
// stay inside a criterion; blank lines dropped; each line trimmed). Pure; no React.
//
// v1.2 (CONTRACT_V1_2.md §A): each criterion line maps to ≥ 1 of the repository's trusted checks.
// The mapping is keyed by the EXACT criterion text (the line after criteriaFromText), never by
// position; editing a line's text makes it a new criterion (new id) whose mapping starts empty.
// Keys that no longer name a line are pruned from the saved draft. Coverage is never inferred.
import {
	criteriaFromText,
	criteriaToText,
	criterionCoverageProblems,
	type DraftCriterionChecks,
	emptyDraft,
	ProposalDraft,
	WorkspaceDraft,
} from "@agent-city/schema/workspace-m1";

export type Scenario = WorkspaceDraft["simulation_scenario"];

/** Simulation scenarios (simulated mode only; part of the immutable proposal — R-N4). */
export const SCENARIOS: readonly Scenario[] =
	WorkspaceDraft.shape.simulation_scenario.options;

export interface DraftForm {
	title: string;
	objective: string;
	/** One criterion per line. */
	criteriaText: string;
	/** One path prefix per line (`.` = whole repository). */
	allowedText: string;
	protectedText: string;
	scenario: Scenario;
	maxRepairs: 0 | 1;
	/**
	 * v1.2 criterion → trusted checks, keyed by exact criterion text. May hold keys of lines that
	 * were edited away (they are pruned when the draft is built; retyping the exact text restores
	 * them — same text, same criterion).
	 */
	criterionChecks?: Readonly<Record<string, readonly string[]>>;
}

export interface FormIssue {
	field: keyof DraftForm | "form";
	message: string;
}

/** Paths: one per line, trimmed, blank lines dropped (no comma splitting either). */
export const linesOf = (text: string): string[] =>
	text
		.split("\n")
		.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l).trim())
		.filter((l) => l.length > 0);

/** "Assign work": an empty draft whose allowed scope is the whole repository (editable). */
export function newDraftForm(): DraftForm {
	return formFromDraft({
		...emptyDraft(),
		scope: { allowed: ["."], protected: [] },
	});
}

export function formFromDraft(d: WorkspaceDraft): DraftForm {
	const map: Record<string, string[]> = {};
	for (const e of d.criterion_checks ?? []) map[e.criterion] = [...e.checks];
	return {
		title: d.title,
		objective: d.objective,
		criteriaText: criteriaToText(d.criteria),
		allowedText: d.scope.allowed.join("\n"),
		protectedText: d.scope.protected.join("\n"),
		scenario: d.simulation_scenario,
		maxRepairs: d.repair_policy.max_repairs,
		criterionChecks: map,
	};
}

/** The criterion lines exactly as they will be stored (criteriaFromText). */
export const formCriteria = (f: DraftForm): string[] =>
	criteriaFromText(f.criteriaText);

/** The checks mapped to one criterion (exact text). */
export const checksFor = (f: DraftForm, criterion: string): readonly string[] =>
	f.criterionChecks?.[criterion] ?? [];

/** Toggle one check of one criterion; keeps the repository's check order. */
export function toggleCheck(
	f: DraftForm,
	criterion: string,
	check: string,
	on: boolean,
	order: readonly string[] = [],
): DraftForm {
	const cur = new Set(checksFor(f, criterion));
	if (on) cur.add(check);
	else cur.delete(check);
	const ordered = [
		...order.filter((c) => cur.has(c)),
		...[...cur].filter((c) => !order.includes(c)),
	];
	return {
		...f,
		criterionChecks: { ...(f.criterionChecks ?? {}), [criterion]: ordered },
	};
}

/**
 * The mapping to store: one entry per current criterion line that has ≥ 1 check, in criteria
 * order; keys of lines that no longer exist are pruned. No entry at all → the key is omitted.
 */
export function mappingForDraft(f: DraftForm): DraftCriterionChecks[] {
	const seen = new Set<string>();
	const out: DraftCriterionChecks[] = [];
	for (const c of formCriteria(f)) {
		if (seen.has(c)) continue;
		seen.add(c);
		const checks = checksFor(f, c);
		if (checks.length > 0) out.push({ criterion: c, checks: [...checks] });
	}
	return out;
}

/** Criterion lines (1-based numbers + text) that have no check yet. */
export function unmappedCriteria(
	f: DraftForm,
): { n: number; criterion: string }[] {
	return formCriteria(f)
		.map((criterion, i) => ({ n: i + 1, criterion }))
		.filter((x) => checksFor(f, x.criterion).length === 0);
}

const FIELD_OF: Record<string, keyof DraftForm> = {
	title: "title",
	objective: "objective",
	criteria: "criteriaText",
	scope: "allowedText",
	simulation_scenario: "scenario",
	repair_policy: "maxRepairs",
	criterion_checks: "criterionChecks",
};

function issuesOf(error: {
	issues: { path: PropertyKey[]; message: string }[];
}): FormIssue[] {
	return error.issues.slice(0, 20).map((i) => {
		const head = String(i.path[0] ?? "");
		const field =
			head === "scope" && i.path[1] === "protected"
				? "protectedText"
				: (FIELD_OF[head] ?? "form");
		const where = i.path.length > 1 ? ` (${i.path.slice(1).join(".")})` : "";
		return { field, message: `${i.message}${where}` };
	});
}

/** The WorkspaceDraft this form describes (strict contract parse). */
export function draftFromForm(
	f: DraftForm,
): { ok: true; draft: WorkspaceDraft } | { ok: false; issues: FormIssue[] } {
	const mapping = mappingForDraft(f);
	const parsed = WorkspaceDraft.safeParse({
		title: f.title,
		objective: f.objective,
		criteria: criteriaFromText(f.criteriaText),
		scope: {
			allowed: linesOf(f.allowedText),
			protected: linesOf(f.protectedText),
		},
		execution_mode: "simulated",
		simulation_scenario: f.scenario,
		repair_policy: { max_repairs: f.maxRepairs },
		...(mapping.length > 0 ? { criterion_checks: mapping } : {}),
	});
	return parsed.success
		? { ok: true, draft: parsed.data }
		: { ok: false, issues: issuesOf(parsed.error) };
}

/**
 * A server / contract issue path as the operator reads it: `criteria.1` → "criterion 2",
 * `criterion_checks.0.checks.1` → "check mapping 1". Content-free; the message stays verbatim.
 */
export function readableIssuePath(path: string): string {
	const crit = /^criteria\.(\d+)/.exec(path);
	if (crit) return `criterion ${Number(crit[1]) + 1}`;
	const map = /^criterion_checks\.(\d+)/.exec(path);
	if (map) return `check mapping ${Number(map[1]) + 1}`;
	return path || "draft";
}

/**
 * What still blocks publishing, for display next to Submit: the ProposalDraft rules, then the v1.2
 * coverage rules over the draft that would be stored (every criterion mapped to ≥ 1 of the
 * repository's trusted checks, no duplicate criterion). `requiredChecks` = the repository's trusted
 * checks (snapshot `repos[]`); null = unknown → publishing is blocked until they are known.
 */
export function publishIssues(
	f: DraftForm,
	requiredChecks: readonly string[] | null,
): FormIssue[] {
	const d = draftFromForm(f);
	if (!d.ok) return d.issues;
	const p = ProposalDraft.safeParse(d.draft);
	const out = p.success ? [] : issuesOf(p.error);
	if (requiredChecks === null)
		return [
			...out,
			{
				field: "criterionChecks",
				message:
					"the repository's trusted checks are not known yet, so the mapping cannot be checked",
			},
		];
	const criteria = d.draft.criteria;
	for (const x of criterionCoverageProblems({
		criteria,
		criterion_checks: d.draft.criterion_checks ?? [],
		required_checks: requiredChecks,
	})) {
		const n = /^criteria\.(\d+)$/.exec(x.path);
		out.push({
			field: "criterionChecks",
			message: n
				? `criterion ${Number(n[1]) + 1}: ${x.message}`
				: `${readableIssuePath(x.path)}: ${x.message}`,
		});
	}
	return out;
}

export const sameForm = (a: DraftForm, b: DraftForm): boolean =>
	a.title === b.title &&
	a.objective === b.objective &&
	a.criteriaText === b.criteriaText &&
	a.allowedText === b.allowedText &&
	a.protectedText === b.protectedText &&
	a.scenario === b.scenario &&
	a.maxRepairs === b.maxRepairs &&
	JSON.stringify(mappingForDraft(a)) === JSON.stringify(mappingForDraft(b));

/** Does the stored draft already equal what the form would save? (no unsaved edits) */
export function formMatchesDraft(f: DraftForm, d: WorkspaceDraft): boolean {
	const built = draftFromForm(f);
	return built.ok && JSON.stringify(built.draft) === JSON.stringify(d);
}
