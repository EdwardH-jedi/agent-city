// Workspace drafts and immutable proposals (web-safe). A draft is the operator's mutable working
// copy on the workspace task; publishing freezes it — trimmed, redacted, composed with trusted
// config — into a ProposalSnapshot whose canonical encoding is hashed (proposal_hash).
import { z } from "zod";
import { SimulationScenario } from "../managed.ts";
import { redact } from "../redact.ts";
import { ProposalId, WorkspaceTaskId } from "./ids.ts";
import {
	BaseRef,
	CheckId,
	draftLine,
	draftText,
	frozenLine,
	frozenText,
	hasDuplicates,
	isStrictlySorted,
	pathWithin,
	RepoId,
	ScopePath,
	Sha,
} from "./primitives.ts";

// ── contract ids ───────────────────────────────────────────────────────────

export const WORKSPACE_TASK_CONTRACT = "agentcity.workspace-task/v1";
export const PROPOSAL_CONTRACT = "agentcity.proposal/v1";
/** Contract delta v1.2 (docs/workspace-m1/CONTRACT_V1_2.md §A): criterion ids + coverage plan. */
export const PROPOSAL_CONTRACT_V1_2 = "agentcity.proposal/v1.2";
export const EXECUTION_BINDING_CONTRACT = "agentcity.execution-binding/v1";
/** Approval request + approval binding. */
export const APPROVAL_CONTRACT = "agentcity.approval/v1";
/** Decision payload + decision receipt. */
export const DECISION_CONTRACT = "agentcity.decision/v1";
/** Result envelope. */
export const RESULT_CONTRACT = "agentcity.result/v1";
/** Result envelope v1.2: v1 + `criterion_coverage` (CONTRACT_V1_2.md §A). */
export const RESULT_CONTRACT_V1_2 = "agentcity.result/v1.2";
/** Hash preimage of one stored review row (inside the result envelope). Internal; see OQ-2. */
export const REVIEW_RECORD_CONTRACT = "agentcity.review-record/v1";
/** Hash preimage of one approval challenge. Internal, never on the wire; see OQ-2. */
export const CHALLENGE_CONTRACT = "agentcity.challenge/v1";

// ── M1 policy (fixed; the client cannot choose providers, models, argv or paths) ───────────

/** The only execution mode M1 accepts. A `live` value anywhere is rejected (live_disabled). */
export const M1_EXECUTION_MODE = "simulated" as const;

/** Repairs: 0 (default) or exactly one pre-approved bounded repair. */
export const MaxRepairs = z.union([z.literal(0), z.literal(1)]);
export type MaxRepairs = z.infer<typeof MaxRepairs>;
export const RepairPolicy = z.strictObject({ max_repairs: MaxRepairs });
export type RepairPolicy = z.infer<typeof RepairPolicy>;
/** Explicit default. The legacy DEFAULT_REPAIR_LIMIT (1) is never used by the workspace path. */
export const M1_DEFAULT_MAX_REPAIRS: MaxRepairs = 0;

const FakeProfile = <R extends "implementer" | "reviewer">(role: R) =>
	z.strictObject({
		profile_id: z.literal(`fake-${role}` as `fake-${R}`),
		provider: z.literal("fake"),
		mode: z.literal("simulated"),
		model: z.null(),
	});
export const ProviderProfiles = z.strictObject({
	implementer: FakeProfile("implementer"),
	reviewer: FakeProfile("reviewer"),
});
export type ProviderProfiles = z.infer<typeof ProviderProfiles>;
export const m1ProviderProfiles = (): ProviderProfiles => ({
	implementer: {
		profile_id: "fake-implementer",
		provider: "fake",
		mode: "simulated",
		model: null,
	},
	reviewer: {
		profile_id: "fake-reviewer",
		provider: "fake",
		mode: "simulated",
		model: null,
	},
});

/**
 * What the providers are given. M1: the repository snapshot at base_sha plus the proposal text;
 * no extra context references. (Network/host access is NOT claimed here — see INTERFACE.md §9.)
 */
export const ContextPolicy = z.strictObject({
	source: z.literal("base_snapshot"),
	refs: z.tuple([]),
});
export type ContextPolicy = z.infer<typeof ContextPolicy>;
export const m1ContextPolicy = (): ContextPolicy => ({
	source: "base_snapshot",
	refs: [],
});

/**
 * Trusted verification commands to run, by profile id, in the trusted config's order. The engine
 * runs EVERY configured check of the repo, so this is the full list, never a client subset.
 */
export const VerificationPlan = z
	.strictObject({ required_checks: z.array(CheckId).min(1).max(10) })
	.refine((p) => !hasDuplicates(p.required_checks), "duplicate check id");
export type VerificationPlan = z.infer<typeof VerificationPlan>;

/**
 * Upper bounds the engine actually enforces through repair_limit: attempts = 1 + max_repairs,
 * model invocations ≤ 2 per attempt (one implement, one review). Wall-clock/output limits are
 * trusted policy (covered by policy_hash), not proposal fields.
 */
export const Budgets = z.strictObject({
	max_attempts: z.union([z.literal(1), z.literal(2)]),
	max_model_invocations: z.union([z.literal(2), z.literal(4)]),
});
export type Budgets = z.infer<typeof Budgets>;
export const budgetsFor = (p: RepairPolicy): Budgets =>
	p.max_repairs === 0
		? { max_attempts: 1, max_model_invocations: 2 }
		: { max_attempts: 2, max_model_invocations: 4 };

// ── criteria ───────────────────────────────────────────────────────────────

export const CRITERIA_MAX_ITEMS = 20;
export const CRITERION_MAX_CHARS = 500;
export const TITLE_MAX_CHARS = 120;
export const OBJECTIVE_MAX_CHARS = 4000;
export const SCOPE_MAX_ITEMS = 20;

/**
 * One acceptance criterion per line. Splits ONLY on line breaks (`\n`; a `\r\n` pair counts as
 * one), trims each line and drops blank lines. Commas, quotes and any other characters inside a
 * line stay part of that criterion. Does not enforce counts/lengths — the schemas do.
 */
export function criteriaFromText(text: string): string[] {
	return text
		.split("\n")
		.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line).trim())
		.filter((line) => line.length > 0);
}

/** Inverse for display/editing: one criterion per line. */
export const criteriaToText = (criteria: readonly string[]): string =>
	criteria.join("\n");

// ── criterion identity and coverage (contract delta v1.2, CONTRACT_V1_2.md §A) ───────────────

/**
 * `crit-` + the first 16 hex chars of sha256(UTF-8 of the frozen criterion text) — deterministic and
 * stateless: unchanged text keeps its id across proposal versions, edited text gets a new id,
 * identical texts collide (and are rejected). Computed by `criterionId()` in the Bun-only
 * `./hash.ts`; this web-safe schema checks the form only (sealProposal checks the binding).
 */
export const CRITERION_ID_PREFIX = "crit-";
export const CriterionId = z
	.string()
	.regex(/^crit-[0-9a-f]{16}$/, "criterion id (crit-<16 hex>)");
export type CriterionId = z.infer<typeof CriterionId>;

/** At most as many checks per criterion as the verification plan can hold. */
export const CRITERION_CHECKS_MAX = 10;

/**
 * One draft mapping entry, keyed by the EXACT stored criterion text (redacted with the same
 * `redact()` as the criteria — see `redactDraft`). While drafting the list may be incomplete
 * (missing / dangling entries, entries with no checks); `checks` may not repeat a check id.
 */
export const DraftCriterionChecks = z.strictObject({
	criterion: draftLine(CRITERION_MAX_CHARS),
	checks: z
		.array(CheckId)
		.max(CRITERION_CHECKS_MAX)
		.refine((xs) => !hasDuplicates(xs), "duplicate check in one criterion"),
});
export type DraftCriterionChecks = z.infer<typeof DraftCriterionChecks>;

/** Save-time rules: bounded, and each criterion text is a key at most once. */
export const DraftCriterionChecksList = z
	.array(DraftCriterionChecks)
	.max(CRITERIA_MAX_ITEMS)
	.superRefine((xs, ctx) => {
		const seen = new Set<string>();
		xs.forEach((x, i) => {
			if (seen.has(x.criterion))
				ctx.addIssue({
					code: "custom",
					path: [i, "criterion"],
					message: "duplicate criterion mapping",
				});
			seen.add(x.criterion);
		});
	});

/** A draft's mapping; an absent `criterion_checks` means `[]` (the default). */
export const draftCriterionChecks = (d: {
	criterion_checks?: readonly DraftCriterionChecks[] | undefined;
}): readonly DraftCriterionChecks[] => d.criterion_checks ?? [];

export type CoverageIssue = { path: string; message: string };

/**
 * Publish-time coverage rules (fail closed; coverage is never inferred), over the STORED draft:
 * every criterion has exactly one entry (matched by exact text) with ≥ 1 check; no dangling entry;
 * every check ∈ the repository's trusted `required_checks`; no duplicate criterion text. Pure and
 * web-safe so the editor can show the same issues the hub answers with.
 */
export function criterionCoverageProblems(i: {
	criteria: readonly string[];
	criterion_checks: readonly DraftCriterionChecks[];
	required_checks: readonly string[];
}): CoverageIssue[] {
	const out: CoverageIssue[] = [];
	const trusted = new Set(i.required_checks);
	const seenText = new Set<string>();
	i.criteria.forEach((c, n) => {
		if (seenText.has(c))
			out.push({ path: `criteria.${n}`, message: "duplicate criterion" });
		seenText.add(c);
		const entries = i.criterion_checks.filter((x) => x.criterion === c);
		if (entries.length === 0)
			out.push({
				path: `criteria.${n}`,
				message: "criterion has no check mapping",
			});
		else if (entries.length > 1)
			out.push({
				path: `criteria.${n}`,
				message: "criterion is mapped more than once",
			});
	});
	i.criterion_checks.forEach((x, n) => {
		if (!seenText.has(x.criterion))
			out.push({
				path: `criterion_checks.${n}.criterion`,
				message: "mapping names no criterion of this draft",
			});
		if (x.checks.length === 0)
			out.push({
				path: `criterion_checks.${n}.checks`,
				message: "criterion maps to no check",
			});
		if (hasDuplicates(x.checks))
			out.push({
				path: `criterion_checks.${n}.checks`,
				message: "duplicate check in one criterion",
			});
		x.checks.forEach((check, k) => {
			if (!trusted.has(check))
				out.push({
					path: `criterion_checks.${n}.checks.${k}`,
					message: "not a trusted required check of this repository",
				});
		});
	});
	return out;
}

// ── scope ──────────────────────────────────────────────────────────────────

const scopeProblems = (allowed: readonly string[], prot: readonly string[]) => {
	const out: string[] = [];
	if (hasDuplicates(allowed)) out.push("duplicate allowed path");
	if (hasDuplicates(prot)) out.push("duplicate protected path");
	for (const p of prot)
		if (allowed.some((a) => pathWithin(p, a) || pathWithin(a, p)))
			out.push(
				`protected path "${p}" overlaps the allowed scope (M1 cannot enforce carve-outs)`,
			);
	return out;
};

/**
 * `allowed`: the only path prefixes a candidate may change (engine `approved_scope`).
 * `protected`: declared off-limits paths. In M1 they must NOT overlap `allowed` (neither inside nor
 * containing an allowed prefix): the engine enforces only `allowed`, so a protected carve-out inside
 * an allowed prefix would be a promise nobody keeps (OQ-4).
 */
export const ProposalScope = z
	.strictObject({
		allowed: z.array(ScopePath).min(1).max(SCOPE_MAX_ITEMS),
		protected: z.array(ScopePath).max(SCOPE_MAX_ITEMS),
	})
	.superRefine((s, ctx) => {
		for (const message of scopeProblems(s.allowed, s.protected))
			ctx.addIssue({ code: "custom", message });
	});
export type ProposalScope = z.infer<typeof ProposalScope>;

// ── drafts ─────────────────────────────────────────────────────────────────

/**
 * The mutable working copy stored on the workspace task (`workspace_tasks.draft`). Anything may
 * still be empty; nothing here grants anything. Strict: unknown keys (provider, model, argv, path,
 * repo, base…) are rejected.
 */
export const WorkspaceDraft = z.strictObject({
	title: draftLine(TITLE_MAX_CHARS),
	objective: draftText(OBJECTIVE_MAX_CHARS),
	criteria: z.array(draftLine(CRITERION_MAX_CHARS)).max(CRITERIA_MAX_ITEMS),
	scope: z.strictObject({
		allowed: z.array(ScopePath).max(SCOPE_MAX_ITEMS),
		protected: z.array(ScopePath).max(SCOPE_MAX_ITEMS),
	}),
	execution_mode: z.literal(M1_EXECUTION_MODE),
	simulation_scenario: SimulationScenario,
	repair_policy: RepairPolicy,
	/**
	 * v1.2 (additive): criterion → trusted check mapping, keyed by exact criterion text. Absent ≡ `[]`
	 * (`draftCriterionChecks`). Deliberately `.optional()` and not `.default([])`: parsing never adds
	 * the key, so legacy drafts and their create-command `request_hash` stay byte-identical.
	 */
	criterion_checks: DraftCriterionChecksList.optional(),
});
export type WorkspaceDraft = z.infer<typeof WorkspaceDraft>;

/**
 * The stored form of a draft's user text (CLAUDE.md rule 3): title, objective, each criterion AND
 * each `criterion_checks` key pass the same `redact()`, so a key still matches its criterion
 * byte-for-byte after storage. Scope paths are pattern-restricted and copied. Does not validate:
 * redaction can lengthen text, so the caller re-parses with `WorkspaceDraft` (never truncates).
 */
export function redactDraft(d: WorkspaceDraft): WorkspaceDraft {
	const out: WorkspaceDraft = {
		...d,
		title: redact(d.title),
		objective: redact(d.objective),
		criteria: d.criteria.map((c) => redact(c)),
		scope: { allowed: [...d.scope.allowed], protected: [...d.scope.protected] },
	};
	if (d.criterion_checks !== undefined)
		out.criterion_checks = d.criterion_checks.map((x) => ({
			criterion: redact(x.criterion),
			checks: [...x.checks],
		}));
	return out;
}

export const emptyDraft = (): WorkspaceDraft => ({
	title: "",
	objective: "",
	criteria: [],
	scope: { allowed: [], protected: [] },
	execution_mode: M1_EXECUTION_MODE,
	simulation_scenario: "approve",
	repair_policy: { max_repairs: M1_DEFAULT_MAX_REPAIRS },
});

/** A draft that may be published: every required field present and the scope consistent. */
export const ProposalDraft = WorkspaceDraft.superRefine((d, ctx) => {
	const issue = (path: (string | number)[], message: string) =>
		ctx.addIssue({ code: "custom", path, message });
	if (d.title.trim().length === 0) issue(["title"], "required");
	if (d.objective.trim().length === 0) issue(["objective"], "required");
	if (d.criteria.length === 0)
		issue(["criteria"], "at least one criterion is required");
	d.criteria.forEach((c, i) => {
		if (c.trim().length === 0) issue(["criteria", i], "empty criterion");
	});
	if (d.scope.allowed.length === 0)
		issue(["scope", "allowed"], "at least one allowed path is required");
	for (const message of scopeProblems(d.scope.allowed, d.scope.protected))
		issue(["scope"], message);
});
export type ProposalDraft = z.infer<typeof ProposalDraft>;

// ── live precedence ────────────────────────────────────────────────────────

/**
 * True when a request body names any execution mode other than `simulated` (any `execution_mode`
 * key, at any depth ≤ 6). Checked BEFORE strict parsing so a crafted live request is answered
 * `live_disabled` (422), not a generic `invalid_request`, and never reaches any preflight.
 */
export function requestsNonSimulatedMode(body: unknown, depth = 0): boolean {
	if (depth > 6 || body === null || typeof body !== "object") return false;
	if (Array.isArray(body))
		return body.some((v) => requestsNonSimulatedMode(v, depth + 1));
	for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
		if (k === "execution_mode" && v !== M1_EXECUTION_MODE) return true;
		if (requestsNonSimulatedMode(v, depth + 1)) return true;
	}
	return false;
}

// ── immutable proposal snapshot ────────────────────────────────────────────

/** Snapshot fields before `criteria` (identical in v1 and v1.2; shape order kept). */
const SNAPSHOT_HEAD = {
	proposal_id: ProposalId,
	workspace_task_id: WorkspaceTaskId,
	version: z.number().int().min(1).max(100_000),
	predecessor_proposal_id: ProposalId.nullable(),
	repo_id: RepoId,
	base_ref: BaseRef,
	base_sha: Sha,
	/** Optional repair seed commit (SOL §C). Always null in M1. */
	seed_sha: z.null(),
	title: frozenLine(TITLE_MAX_CHARS),
	objective: frozenText(OBJECTIVE_MAX_CHARS),
} as const;

/** Snapshot fields after `criteria` (identical in v1 and v1.2). */
const SNAPSHOT_TAIL = {
	scope: ProposalScope,
	execution_mode: z.literal(M1_EXECUTION_MODE),
	simulation_scenario: SimulationScenario,
	provider_profiles: ProviderProfiles,
	verification_plan: VerificationPlan,
	context_policy: ContextPolicy,
	budgets: Budgets,
	repair_policy: RepairPolicy,
} as const;

type SnapshotCommon = {
	version: number;
	proposal_id: string;
	predecessor_proposal_id: string | null;
	repair_policy: RepairPolicy;
	budgets: Budgets;
};

const snapshotInvariants = (p: SnapshotCommon, ctx: z.RefinementCtx): void => {
	if ((p.version === 1) !== (p.predecessor_proposal_id === null))
		ctx.addIssue({
			code: "custom",
			path: ["predecessor_proposal_id"],
			message: "version 1 has no predecessor; later versions must name one",
		});
	if (p.predecessor_proposal_id === p.proposal_id)
		ctx.addIssue({
			code: "custom",
			path: ["predecessor_proposal_id"],
			message: "a proposal cannot be its own predecessor",
		});
	const b = budgetsFor(p.repair_policy);
	if (
		p.budgets.max_attempts !== b.max_attempts ||
		p.budgets.max_model_invocations !== b.max_model_invocations
	)
		ctx.addIssue({
			code: "custom",
			path: ["budgets"],
			message: "budgets must follow the repair policy",
		});
};

/**
 * Everything Gate 1 authorizes, frozen. Hashed in full (proposal_hash). Row metadata — created_at,
 * created_by — is deliberately OUTSIDE the hash: it does not change what is authorized, and the
 * proposal_id inside already makes every snapshot unique. (v1: criteria are plain strings.)
 */
export const ProposalSnapshot = z
	.strictObject({
		contract: z.literal(PROPOSAL_CONTRACT),
		...SNAPSHOT_HEAD,
		criteria: z
			.array(frozenLine(CRITERION_MAX_CHARS))
			.min(1)
			.max(CRITERIA_MAX_ITEMS),
		...SNAPSHOT_TAIL,
	})
	.superRefine(snapshotInvariants);
export type ProposalSnapshot = z.infer<typeof ProposalSnapshot>;

/** v1.2: one frozen criterion with its deterministic id. */
export const ProposalCriterion = z.strictObject({
	id: CriterionId,
	text: frozenLine(CRITERION_MAX_CHARS),
});
export type ProposalCriterion = z.infer<typeof ProposalCriterion>;

/** v1.2: the trusted checks that must pass (with log evidence) for one criterion. */
export const CoveragePlanEntry = z.strictObject({
	criterion_id: CriterionId,
	/** Sorted (UTF-16 code units) and unique; ⊆ verification_plan.required_checks. */
	checks: z.array(CheckId).min(1).max(CRITERION_CHECKS_MAX),
});
export type CoveragePlanEntry = z.infer<typeof CoveragePlanEntry>;

type CoverageLike = {
	criteria: readonly { id: string; text: string }[];
	coverage_plan: readonly { criterion_id: string; checks: readonly string[] }[];
	verification_plan: { required_checks: readonly string[] };
};

/**
 * v1.2 structural rules (web-safe; no hashing): criterion ids unique and texts unique; the plan is
 * a bijection with the criteria — exactly one entry per criterion, in criteria order, no dangling
 * id; each entry's checks sorted + unique and ⊆ verification_plan.required_checks.
 */
export function coveragePlanProblems(p: CoverageLike): CoverageIssue[] {
	const out: CoverageIssue[] = [];
	const ids = new Set<string>();
	const texts = new Set<string>();
	p.criteria.forEach((c, i) => {
		if (ids.has(c.id))
			out.push({
				path: `criteria.${i}.id`,
				message: "duplicate criterion id",
			});
		if (texts.has(c.text))
			out.push({
				path: `criteria.${i}.text`,
				message: "duplicate criterion text",
			});
		ids.add(c.id);
		texts.add(c.text);
	});
	const planned = new Set(p.coverage_plan.map((e) => e.criterion_id));
	p.criteria.forEach((c, i) => {
		if (!planned.has(c.id))
			out.push({
				path: `criteria.${i}`,
				message: "criterion has no coverage plan entry",
			});
	});
	const required = new Set(p.verification_plan.required_checks);
	const seenPlan = new Set<string>();
	p.coverage_plan.forEach((e, i) => {
		if (!ids.has(e.criterion_id))
			out.push({
				path: `coverage_plan.${i}.criterion_id`,
				message: "coverage plan names no criterion (dangling id)",
			});
		if (seenPlan.has(e.criterion_id))
			out.push({
				path: `coverage_plan.${i}.criterion_id`,
				message: "criterion planned more than once",
			});
		seenPlan.add(e.criterion_id);
		if (p.criteria[i]?.id !== e.criterion_id)
			out.push({
				path: `coverage_plan.${i}`,
				message: "coverage plan must follow the criteria order",
			});
		if (!isStrictlySorted(e.checks))
			out.push({
				path: `coverage_plan.${i}.checks`,
				message: "checks must be sorted and unique",
			});
		e.checks.forEach((check, k) => {
			if (!required.has(check))
				out.push({
					path: `coverage_plan.${i}.checks.${k}`,
					message: "check is not in verification_plan.required_checks",
				});
		});
	});
	if (p.coverage_plan.length !== p.criteria.length)
		out.push({
			path: "coverage_plan",
			message: "exactly one coverage plan entry per criterion",
		});
	return out;
}

/**
 * ProposalSnapshot v1.2 (`agentcity.proposal/v1.2`): identical to v1 except `criteria: [{id, text}]`
 * (order preserved) and `coverage_plan` (criterion → trusted checks). Ids and mapping are inside the
 * proposal hash. New proposals are always v1.2 once the hub is wired (CONTRACT_V1_2.md §A).
 */
export const ProposalSnapshotV1_2 = z
	.strictObject({
		contract: z.literal(PROPOSAL_CONTRACT_V1_2),
		...SNAPSHOT_HEAD,
		criteria: z.array(ProposalCriterion).min(1).max(CRITERIA_MAX_ITEMS),
		...SNAPSHOT_TAIL,
		coverage_plan: z.array(CoveragePlanEntry).min(1).max(CRITERIA_MAX_ITEMS),
	})
	.superRefine((p, ctx) => {
		snapshotInvariants(p, ctx);
		for (const x of coveragePlanProblems(p))
			ctx.addIssue({
				code: "custom",
				path: x.path.split(".").map((k) => (/^\d+$/.test(k) ? Number(k) : k)),
				message: x.message,
			});
	});
export type ProposalSnapshotV1_2 = z.infer<typeof ProposalSnapshotV1_2>;

/** Row parser: v1 | v1.2, discriminated by `contract` (legacy rows stay readable). */
export const AnyProposalSnapshot = z.discriminatedUnion("contract", [
	ProposalSnapshot,
	ProposalSnapshotV1_2,
]);
export type AnyProposalSnapshot = z.infer<typeof AnyProposalSnapshot>;

/** `managed_proposals.contract_version` values (v1 | v1.2). */
export const ProposalContractVersion = z.enum([
	PROPOSAL_CONTRACT,
	PROPOSAL_CONTRACT_V1_2,
]);
export type ProposalContractVersion = z.infer<typeof ProposalContractVersion>;

export const isProposalV1_2 = (
	p: AnyProposalSnapshot,
): p is ProposalSnapshotV1_2 => p.contract === PROPOSAL_CONTRACT_V1_2;

/** The frozen criterion texts in order (v1 strings; v1.2 `criteria[].text`, byte-identical). */
export const proposalCriteriaTexts = (p: AnyProposalSnapshot): string[] =>
	isProposalV1_2(p) ? p.criteria.map((c) => c.text) : [...p.criteria];

export interface ProposalSnapshotInput {
	proposal_id: string;
	workspace_task_id: string;
	version: number;
	predecessor_proposal_id: string | null;
	/** From the workspace task row (never from the draft). */
	repo_id: string;
	/** From the trusted managed config + git, resolved at publish time. */
	base_ref: string;
	base_sha: string;
	/** Trusted config `verification[].name` of this repo, in config order. */
	required_checks: readonly string[];
	/** A ProposalDraft (already parsed). */
	draft: ProposalDraft;
}

export type SnapshotResult =
	| { ok: true; snapshot: ProposalSnapshot }
	| { ok: false; issues: { path: string; message: string }[] };

export type SnapshotResultV1_2 =
	| { ok: true; snapshot: ProposalSnapshotV1_2 }
	| { ok: false; issues: { path: string; message: string }[] };

/** The one freezing rule for a criterion: trim, redact, trim (redaction may lengthen it). */
export const freezeCriterion = (c: string): string => redact(c.trim()).trim();

/** Everything a snapshot freezes from the draft + trusted inputs, except contract and criteria. */
function frozenCommon(i: ProposalSnapshotInput) {
	const d = i.draft;
	return {
		head: {
			proposal_id: i.proposal_id,
			workspace_task_id: i.workspace_task_id,
			version: i.version,
			predecessor_proposal_id: i.predecessor_proposal_id,
			repo_id: i.repo_id,
			base_ref: i.base_ref,
			base_sha: i.base_sha,
			seed_sha: null,
			title: redact(d.title.trim()).trim(),
			objective: redact(d.objective.replace(/\r\n/g, "\n").trim()).trim(),
		},
		tail: {
			scope: {
				allowed: [...d.scope.allowed],
				protected: [...d.scope.protected],
			},
			execution_mode: M1_EXECUTION_MODE,
			simulation_scenario: d.simulation_scenario,
			provider_profiles: m1ProviderProfiles(),
			verification_plan: { required_checks: [...i.required_checks] },
			context_policy: m1ContextPolicy(),
			budgets: budgetsFor(d.repair_policy),
			repair_policy: { max_repairs: d.repair_policy.max_repairs },
		},
	};
}

const issuesOf = (e: z.ZodError) =>
	e.issues.slice(0, 20).map((x) => ({
		path: x.path.join("."),
		message: x.message,
	}));

/**
 * The one way to freeze a draft: trim, normalize `\r\n` → `\n`, redact user text (redaction can
 * LENGTHEN text, so bounds are re-validated afterwards and may fail), attach the fixed M1 policy
 * and the trusted inputs, validate. The displayed snapshot is exactly what Gate 1 approves.
 */
export function buildProposalSnapshot(
	i: ProposalSnapshotInput,
): SnapshotResult {
	const { head, tail } = frozenCommon(i);
	const candidate = {
		contract: PROPOSAL_CONTRACT,
		...head,
		criteria: i.draft.criteria.map(freezeCriterion),
		...tail,
	};
	const parsed = ProposalSnapshot.safeParse(candidate);
	if (parsed.success) return { ok: true, snapshot: parsed.data };
	return { ok: false, issues: issuesOf(parsed.error) };
}

/**
 * v1.2 freezing (pure; the id function is injected — use `buildProposalSnapshotV1_2` from the
 * Bun-only `./hash.ts`, which passes `criterionId`). Publish rules fail closed BEFORE freezing
 * (`criterionCoverageProblems` over the stored draft, keys matched by exact text); then each
 * criterion is frozen with `freezeCriterion`, its id derived from the frozen text, its checks
 * sorted + de-duplicated, and the result validated (duplicate frozen texts ⇒ duplicate ids ⇒
 * rejected). Not yet called by the hub's publish command (lead integration).
 */
export function composeProposalSnapshotV1_2(
	i: ProposalSnapshotInput,
	criterionIdOf: (frozenText: string) => string,
): SnapshotResultV1_2 {
	const d = i.draft;
	const mapping = draftCriterionChecks(d);
	const problems = criterionCoverageProblems({
		criteria: d.criteria,
		criterion_checks: mapping,
		required_checks: i.required_checks,
	});
	if (problems.length > 0) return { ok: false, issues: problems.slice(0, 20) };
	const { head, tail } = frozenCommon(i);
	const criteria = d.criteria.map((c) => {
		const text = freezeCriterion(c);
		return { id: criterionIdOf(text), text };
	});
	const coverage_plan = d.criteria.map((c, n) => {
		const entry = mapping.find((x) => x.criterion === c);
		return {
			criterion_id: (criteria[n] as { id: string }).id,
			checks: [...new Set(entry?.checks ?? [])].sort(),
		};
	});
	const candidate = {
		contract: PROPOSAL_CONTRACT_V1_2,
		...head,
		criteria,
		...tail,
		coverage_plan,
	};
	const parsed = ProposalSnapshotV1_2.safeParse(candidate);
	if (parsed.success) return { ok: true, snapshot: parsed.data };
	return { ok: false, issues: issuesOf(parsed.error) };
}

/**
 * The managed_tasks columns the bridge writes when it reserves the execution of a proposal. Text
 * fields are byte-identical to the snapshot (already redacted) so `approvalHashFor(task)` and the
 * snapshot describe the same work. `repair_limit` is always explicit (never DEFAULT_REPAIR_LIMIT).
 * v1.2: `acceptance_criteria` = `criteria.map(c => c.text)` (byte-identical to the v1 strings).
 */
export function managedTaskFieldsFor(p: AnyProposalSnapshot) {
	return {
		repo_id: p.repo_id,
		title: p.title,
		objective: p.objective,
		acceptance_criteria: proposalCriteriaTexts(p),
		approved_scope: [...p.scope.allowed],
		execution_mode: p.execution_mode,
		simulation_scenario: p.simulation_scenario,
		repair_limit: p.repair_policy.max_repairs,
		base_ref: p.base_ref,
		base_sha: p.base_sha,
	};
}
