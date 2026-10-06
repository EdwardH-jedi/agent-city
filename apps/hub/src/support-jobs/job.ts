// Support job domain: high-volume, read-only informational work (status, handoffs, triage, drafts)
// that never enters the managed implementation → verification → review → Gate 2 pipeline.
//
// A support job carries NO authority: no shell command strings, no writable repository path, no Git
// push / merge, no deploy, no credentials. Every schema here is a zod strictObject, so such keys are
// rejected rather than ignored, and every string / array is bounded. Pure — no I/O.
import { normalizeRepoId } from "@agent-city/schema";
import { z } from "zod";
import { containsSecret, deepFreeze, parseGuarded } from "./guards.ts";
import { SupportCapability, SupportProfileId } from "./vocabulary.ts";

/** Kinds of informational artifact a support job may produce (PR_DRAFT = text; never opens a PR). */
export const SUPPORT_JOB_KINDS = [
	"REPO_STATUS",
	"HANDOFF",
	"LOG_TRIAGE",
	"EVIDENCE_SUMMARY",
	"REVIEW_TO_TODOS",
	"PR_DRAFT",
	"CONTEXT_PACKAGE",
] as const;
export const SupportJobKind = z.enum(SUPPORT_JOB_KINDS);
export type SupportJobKind = z.infer<typeof SupportJobKind>;

/**
 * Support-lane states. Upper-case on purpose: they share no value with the managed task states
 * (`queued`, `executing`, `human_ready`, …), so neither machine can be fed the other's state.
 */
export const SUPPORT_JOB_STATUSES = [
	"QUEUED",
	"RUNNING",
	"COMPLETED",
	"FAILED",
	"CANCELLED",
] as const;
export const SupportJobStatus = z.enum(SUPPORT_JOB_STATUSES);
export type SupportJobStatus = z.infer<typeof SupportJobStatus>;

/** Why a RUNNING job failed. Detail text is bounded and redacted, never raw executor output. */
export const SUPPORT_FAILURE_CLASSES = [
	"EXECUTOR_ERROR",
	"INVALID_OUTPUT",
	"FORBIDDEN_AUTHORITY",
	"KIND_MISMATCH",
	"OUTPUT_SECRET",
] as const;
export const SupportFailureClass = z.enum(SUPPORT_FAILURE_CLASSES);
export type SupportFailureClass = z.infer<typeof SupportFailureClass>;

export const MAX_INPUT_REFS = 32;
export const BRIEF_MAX = 2000;
export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 100;
export const DEFAULT_PRIORITY = 50;

/** Job ids: the ids.ts raw-id alphabet, starting alphanumeric. Assigned by the caller (future store). */
export const SupportJobId = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "job id");

/** Artifact ids are derived from the job id (`<job id>.artifact`). */
export const SupportArtifactId = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.artifact$/, "artifact id");

// GitHub owner/name (owner ≤ 39, name ≤ 100) or local/<dir> (verbatim folder name, no separators,
// no control characters). Same id space as packages/schema/src/repo-slug.ts.
const GITHUB_REPO_ID =
	/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const LOCAL_REPO_ID = /^local\/(?!\.{1,2}$)[^/\\\p{Cc}]{1,255}$/u;
const REPO_ID_MAX = 300;

const isSupportRepoId = (id: string): boolean =>
	id.length <= REPO_ID_MAX &&
	id === normalizeRepoId(id) &&
	(GITHUB_REPO_ID.test(id) || LOCAL_REPO_ID.test(id));

/** A stored repo id: already in normalizeRepoId() form. */
export const SupportRepoId = z
	.string()
	.max(REPO_ID_MAX)
	.refine(isSupportRepoId, "repo id must be owner/name or local/<dir>");

/** A requested repo id: normalized (trim, trailing '/') before the same check. */
const RequestedRepoId = z
	.string()
	.max(REPO_ID_MAX)
	.transform((s) => normalizeRepoId(s))
	.pipe(SupportRepoId);

// Reference ids name an existing record (run, review, log…) — never a filesystem path: no '/',
// no '\', no '..', bounded alphabet.
const RefId = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "reference id")
	.refine((s) => !s.includes(".."), "reference id must not contain '..'");

/** Read-only, typed reference to something the executor may read. */
export const SupportInputRef = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("commit"),
		id: z.string().regex(/^[0-9a-f]{7,40}$/, "commit sha"),
	}),
	z.strictObject({ kind: z.literal("run"), id: RefId }),
	z.strictObject({ kind: z.literal("artifact"), id: RefId }),
	z.strictObject({ kind: z.literal("review"), id: RefId }),
	z.strictObject({ kind: z.literal("log"), id: RefId }),
	z.strictObject({ kind: z.literal("session"), id: RefId }),
]);
export type SupportInputRef = z.infer<typeof SupportInputRef>;
export type SupportInputRefKind = SupportInputRef["kind"];

/**
 * Kinds that need a particular input to make sense: at least one ref of one of the listed kinds.
 * Kinds not listed accept any (or no) refs.
 */
export const REQUIRED_REF_KINDS: Readonly<
	Partial<Record<SupportJobKind, readonly SupportInputRefKind[]>>
> = {
	LOG_TRIAGE: ["log", "run"],
	EVIDENCE_SUMMARY: ["artifact", "run"],
	REVIEW_TO_TODOS: ["review"],
	PR_DRAFT: ["commit"],
};

const InputRefs = z.array(SupportInputRef).max(MAX_INPUT_REFS);

/** Optional free-text focus for the executor. Informational only — it is never executed. */
const Brief = z
	.string()
	.min(1)
	.max(BRIEF_MAX)
	.refine((s) => !containsSecret(s), "brief must not contain a secret");

const Priority = z.int().min(PRIORITY_MIN).max(PRIORITY_MAX);

/** Metadata of the artifact a COMPLETED job produced (the artifact itself is returned separately). */
export const SupportResultMeta = z.strictObject({
	artifact_id: SupportArtifactId,
	artifact_kind: SupportJobKind,
	text_chars: z.int().min(0).max(1_000_000),
});
export type SupportResultMeta = z.infer<typeof SupportResultMeta>;

export const SupportFailure = z.strictObject({
	classification: SupportFailureClass,
	detail: z.string().max(500),
});
export type SupportFailure = z.infer<typeof SupportFailure>;

interface RefRuleInput {
	kind: SupportJobKind;
	inputs: readonly SupportInputRef[];
}

function checkRefs(v: RefRuleInput, ctx: z.RefinementCtx): void {
	const seen = new Set<string>();
	for (const ref of v.inputs) {
		const key = `${ref.kind}\u0000${ref.id}`;
		if (seen.has(key))
			ctx.addIssue({
				code: "custom",
				path: ["inputs"],
				message: "duplicate input reference",
			});
		seen.add(key);
	}
	const required = REQUIRED_REF_KINDS[v.kind];
	if (required && !v.inputs.some((r) => required.includes(r.kind)))
		ctx.addIssue({
			code: "custom",
			path: ["inputs"],
			message: `${v.kind} needs a ${required.join(" or ")} reference`,
		});
}

/**
 * A support job as the lane stores it. Invariants: COMPLETED ⇔ result set (of the job's kind);
 * FAILED ⇔ failure set; cancel_requested only while RUNNING (or after it ended as CANCELLED).
 */
export const SupportJob = z
	.strictObject({
		id: SupportJobId,
		repo_id: SupportRepoId,
		kind: SupportJobKind,
		capability: SupportCapability,
		inputs: InputRefs,
		brief: Brief.nullable(),
		status: SupportJobStatus,
		priority: Priority,
		/** Monotonic creation sequence from the caller — the scheduler's FIFO key. */
		created_seq: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
		created_at: z.iso.datetime(),
		/** Held back from scheduling (e.g. its kind is switched off) without being cancelled. */
		disabled: z.boolean(),
		cancel_requested: z.boolean(),
		/** Set only by a future capability → profile router; null until then. */
		profile_id: SupportProfileId.nullable(),
		result: SupportResultMeta.nullable(),
		failure: SupportFailure.nullable(),
	})
	.superRefine((job, ctx) => {
		checkRefs(job, ctx);
		if ((job.status === "COMPLETED") !== (job.result !== null))
			ctx.addIssue({
				code: "custom",
				path: ["result"],
				message: "result is set exactly when COMPLETED",
			});
		if (job.result !== null && job.result.artifact_kind !== job.kind)
			ctx.addIssue({
				code: "custom",
				path: ["result"],
				message: "result kind differs from job kind",
			});
		if ((job.status === "FAILED") !== (job.failure !== null))
			ctx.addIssue({
				code: "custom",
				path: ["failure"],
				message: "failure is set exactly when FAILED",
			});
		if (
			job.cancel_requested &&
			job.status !== "RUNNING" &&
			job.status !== "CANCELLED"
		)
			ctx.addIssue({
				code: "custom",
				path: ["cancel_requested"],
				message: "cancel_requested only while RUNNING",
			});
	});
export type SupportJob = Readonly<z.infer<typeof SupportJob>>;

/** What a requester may say. Status, ordering, profile, result and failure are never requestable. */
export const SupportJobRequest = z
	.strictObject({
		repo_id: RequestedRepoId,
		kind: SupportJobKind,
		capability: SupportCapability,
		inputs: InputRefs.default([]),
		brief: Brief.nullable().default(null),
		priority: Priority.default(DEFAULT_PRIORITY),
		disabled: z.boolean().default(false),
	})
	.superRefine(checkRefs);
export type SupportJobRequest = z.input<typeof SupportJobRequest>;

/** Identity and ordering assigned by the caller (a future store), not by the requester. */
export const SupportJobMeta = z.strictObject({
	id: SupportJobId,
	created_seq: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
	created_at: z.iso.datetime(),
});
export type SupportJobMeta = z.infer<typeof SupportJobMeta>;

export type SupportCreateResult =
	| { readonly ok: true; readonly job: SupportJob }
	| { readonly ok: false; readonly issues: readonly string[] };

/**
 * Validate an untrusted request and build a frozen QUEUED job. Never throws: an unreadable
 * request or meta (throwing getter / Proxy trap) is `{ ok: false, issues: ["(root):unreadable"] }`.
 */
export function createSupportJob(
	request: unknown,
	meta: SupportJobMeta,
): SupportCreateResult {
	const req = parseGuarded(SupportJobRequest, request);
	if (!req.ok) return { ok: false, issues: req.issues };
	const m = parseGuarded(SupportJobMeta, meta);
	if (!m.ok) return { ok: false, issues: m.issues };
	const job = parseGuarded(SupportJob, {
		...req.data,
		...m.data,
		status: "QUEUED",
		cancel_requested: false,
		profile_id: null,
		result: null,
		failure: null,
	});
	if (!job.ok) return { ok: false, issues: job.issues };
	return { ok: true, job: deepFreeze(job.data) };
}

/**
 * Re-validate a job value that came from outside this module (e.g. a future store row). Never
 * throws: invalid or unreadable → null. The result is a frozen plain copy.
 */
export function parseSupportJob(value: unknown): SupportJob | null {
	const parsed = parseGuarded(SupportJob, value);
	return parsed.ok ? deepFreeze(parsed.data) : null;
}
