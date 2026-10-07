// Support artifacts: the only thing a support job produces. Informational text and lists — no
// action, command, approval, state or publication field exists in any body schema, every body is
// a strictObject, and output is scanned for authority / credential keys before it is parsed.
import { z } from "zod";
import {
	collectStrings,
	containsSecret,
	deepFreeze,
	formatIssues,
	safeDetail,
	scanForAuthorityKeys,
} from "./guards.ts";
import {
	type SupportFailure,
	type SupportJob,
	SupportJobId,
	SupportJobKind,
	SupportRepoId,
	type SupportResultMeta,
} from "./job.ts";

export const TITLE_MAX = 200;
export const TEXT_MAX = 20_000;
export const ITEM_MAX = 500;
export const LIST_MAX = 100;
export const SECTIONS_MAX = 32;
/** Total characters across every string of one artifact body. */
export const MAX_ARTIFACT_TEXT_CHARS = 64_000;

const Title = z.string().min(1).max(TITLE_MAX);
const Text = z.string().min(1).max(TEXT_MAX);
const Item = z.string().min(1).max(ITEM_MAX);
const Items = z.array(Item).max(LIST_MAX);

export const TodoSeverity = z.enum(["blocker", "major", "minor", "info"]);
export const TriageSeverity = z.enum(["info", "warning", "error", "critical"]);

/** One strict body per job kind; `kind` must equal the job's kind. */
export const SupportArtifactBody = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("REPO_STATUS"),
		title: Title,
		summary: Text,
		highlights: Items,
	}),
	z.strictObject({
		kind: z.literal("HANDOFF"),
		title: Title,
		handoff_text: Text,
		open_questions: Items,
	}),
	z.strictObject({
		kind: z.literal("LOG_TRIAGE"),
		title: Title,
		severity: TriageSeverity,
		summary: Text,
		findings: Items,
	}),
	z.strictObject({
		kind: z.literal("EVIDENCE_SUMMARY"),
		title: Title,
		summary: Text,
		gaps: Items,
	}),
	z.strictObject({
		kind: z.literal("REVIEW_TO_TODOS"),
		title: Title,
		todos: z
			.array(z.strictObject({ text: Item, severity: TodoSeverity }))
			.min(1)
			.max(LIST_MAX),
	}),
	z.strictObject({
		kind: z.literal("PR_DRAFT"),
		draft_title: Title,
		draft_body: Text,
	}),
	z.strictObject({
		kind: z.literal("CONTEXT_PACKAGE"),
		title: Title,
		sections: z
			.array(z.strictObject({ heading: Title, body: Text }))
			.min(1)
			.max(SECTIONS_MAX),
	}),
]);
export type SupportArtifactBody = z.infer<typeof SupportArtifactBody>;

/** A stored support artifact. `informational: true` is the only mode there is. */
export const SupportArtifact = z.strictObject({
	artifact_id: z.string().max(200),
	job_id: SupportJobId,
	repo_id: SupportRepoId,
	kind: SupportJobKind,
	informational: z.literal(true),
	text_chars: z.int().min(0).max(MAX_ARTIFACT_TEXT_CHARS),
	body: SupportArtifactBody,
});
export type SupportArtifact = Readonly<z.infer<typeof SupportArtifact>>;

export const artifactIdFor = (jobId: string): string => `${jobId}.artifact`;

export type OutputValidation =
	| { readonly ok: true; readonly artifact: SupportArtifact }
	| { readonly ok: false; readonly failure: SupportFailure };

const fail = (
	classification: SupportFailure["classification"],
	detail: string,
): OutputValidation => ({
	ok: false,
	failure: deepFreeze({ classification, detail: safeDetail(detail) }),
});

/**
 * Turn untrusted executor output into a frozen artifact, or a classified failure:
 * FORBIDDEN_AUTHORITY (an action / command / approval / state / credential key anywhere),
 * INVALID_OUTPUT (not a strict body of any kind, too large, too deep, unreadable),
 * KIND_MISMATCH (a valid body for another kind), OUTPUT_SECRET (a credential in the text).
 * The artifact is built from zod's parsed copy, so nothing of the raw value (getters, prototypes,
 * functions, extra keys) survives.
 */
export function validateExecutorOutput(
	job: SupportJob,
	raw: unknown,
): OutputValidation {
	const scan = scanForAuthorityKeys(raw);
	if (!scan.ok)
		return fail(
			scan.reason === "forbidden_key"
				? "FORBIDDEN_AUTHORITY"
				: "INVALID_OUTPUT",
			scan.detail,
		);
	let parsed: ReturnType<typeof SupportArtifactBody.safeParse>;
	try {
		parsed = SupportArtifactBody.safeParse(raw);
	} catch {
		return fail("INVALID_OUTPUT", "output not readable");
	}
	if (!parsed.success)
		return fail("INVALID_OUTPUT", formatIssues(parsed.error.issues).join("; "));
	const body = parsed.data;
	if (body.kind !== job.kind)
		return fail("KIND_MISMATCH", `expected ${job.kind}, got ${body.kind}`);
	const strings = collectStrings(body);
	const text_chars = strings.reduce((n, s) => n + s.length, 0);
	if (text_chars > MAX_ARTIFACT_TEXT_CHARS)
		return fail("INVALID_OUTPUT", "artifact text too large");
	if (strings.some(containsSecret))
		return fail("OUTPUT_SECRET", "artifact text contains a credential");
	const artifact = SupportArtifact.safeParse({
		artifact_id: artifactIdFor(job.id),
		job_id: job.id,
		repo_id: job.repo_id,
		kind: job.kind,
		informational: true,
		text_chars,
		body,
	});
	if (!artifact.success)
		return fail(
			"INVALID_OUTPUT",
			formatIssues(artifact.error.issues).join("; "),
		);
	return { ok: true, artifact: deepFreeze(artifact.data) };
}

/** The metadata a COMPLETED job keeps about its artifact. */
export function resultMetaFor(artifact: SupportArtifact): SupportResultMeta {
	return deepFreeze({
		artifact_id: artifact.artifact_id,
		artifact_kind: artifact.kind,
		text_chars: artifact.text_chars,
	});
}
