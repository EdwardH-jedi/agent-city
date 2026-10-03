// One verified read of an attempt's evidence unit, shared by the sealer and the display reader.
//
// Every artifact row of the attempt is read AT MOST ONCE through the hub's verified reader
// (`readArtifactBytes`: path containment, O_RDONLY|O_NOFOLLOW|O_NONBLOCK open, fstat of the
// descriptor = regular file, exact size = row byte_len, full read, sha256 of THAT buffer = row
// sha256). The returned buffers are the verified bytes; callers hash, compare and serve these same
// buffers and never reopen a path. Counts, per-file and total bytes, and wall time are bounded; a FIFO
// cannot block (O_NONBLOCK) and symlinks/directories/devices are refused at the descriptor.
//
// Statuses follow agentcity.result/v1 (`EvidenceStatus`): a present row is verified, truncated,
// withheld, stale, unknown or corrupt — never `missing` (that is an expected name with no row).
// Reason codes are fixed snake_case strings; nothing here returns or logs content.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	EvidenceManifest,
	ManagedArtifact,
	ManagedReview,
	type ManagedRun,
	type ManagedTask,
} from "@agent-city/schema";
import {
	ArtifactId,
	DIFF_ARTIFACT_NAME,
	EnvelopeCheck,
	EVIDENCE_STATUS_SEVERITY,
	type EvidenceStatus,
	MANIFEST_ARTIFACT_NAME,
	REVIEW_OUTPUT_ARTIFACT_NAME,
	verificationLogName,
} from "@agent-city/schema/workspace-m1";
import type { ManagedConfig } from "../../managed/config.ts";
import {
	ArtifactAccessError,
	MAX_ARTIFACT_BYTES,
	readArtifactBytes,
	redactDiff,
} from "../../managed/evidence.ts";
import { type GitRunner, loadDiffContexts } from "./context-loader.ts";
import { listDiffFiles } from "./diff-parse.ts";
import { decideDiffDisclosure } from "./disclosure.ts";

export interface EvidenceLimits {
	/** Artifact rows per attempt (the envelope holds at most 64). */
	max_artifacts: number;
	max_artifact_bytes: number;
	max_total_bytes: number;
	/** Review rows per attempt that are read. */
	max_reviews: number;
	/** Fresh `git diff` cap for the disclosure recheck (the engine's max_diff_bytes). */
	max_diff_bytes: number;
	/** Wall-clock bound of one seal / reader call. */
	deadline_ms: number;
}

export function evidenceLimits(
	config: ManagedConfig,
	over: Partial<EvidenceLimits> = {},
): EvidenceLimits {
	return {
		max_artifacts: 64,
		max_artifact_bytes: MAX_ARTIFACT_BYTES,
		max_total_bytes: 64 * 1024 * 1024,
		max_reviews: 20,
		max_diff_bytes: config.limits.max_diff_bytes,
		deadline_ms: 60_000,
		...over,
	};
}

/** Why no envelope can be built (or the candidate no longer matches). Fixed codes only. */
export type SealErrorCode =
	| "input_mismatch"
	| "not_a_result_request"
	| "revalidation_unavailable"
	| "task_not_found"
	| "run_not_found"
	| "run_not_result"
	| "binding_mismatch"
	| "candidate_missing"
	| "attempt_out_of_range"
	| "repo_unavailable"
	| "candidate_unavailable"
	| "candidate_workspace_invalid"
	| "candidate_mutated"
	| "too_many_artifacts"
	| "artifact_row_invalid"
	| "review_missing"
	| "review_unreadable"
	| "envelope_invalid"
	| "timeout";

export class SealError extends Error {
	constructor(readonly code: SealErrorCode) {
		super(code);
		this.name = "SealError";
	}
}

export interface EvidenceItem {
	row: ManagedArtifact;
	status: EvidenceStatus;
	reasons: string[];
	/** The verified bytes (only when the row's own bytes verified). */
	buffer: Buffer | null;
}

export interface ReviewOutputBinding {
	audited_sha: unknown;
	manifest_hash: unknown;
	verdict: unknown;
}

export interface RunEvidence {
	/** One item per distinct artifact name, sorted by name (UTF-16 code units). */
	items: EvidenceItem[];
	/** The manifest, only when its item is `verified` (bytes, hash, schema, binding). */
	manifest: EvidenceManifest | null;
	/** Required names the trusted manifest (or the fixed set) expects but no row provides. */
	missing: string[];
	/** Review rows of this attempt (bounded), ordered by created_at, id. */
	reviews: ManagedReview[];
	/** false: a review row failed its schema, or there were more than max_reviews. */
	reviewsReadable: boolean;
	/** Parsed review-output.json fields (when its bytes verified and parsed). */
	reviewOutput: ReviewOutputBinding | null;
	/** Display-only diagnostics: safe names + reason codes. */
	problems: string[];
}

const SEVERITY = (s: EvidenceStatus) => EVIDENCE_STATUS_SEVERITY.indexOf(s);
export const worse = (a: EvidenceStatus, b: EvidenceStatus): EvidenceStatus =>
	SEVERITY(a) <= SEVERITY(b) ? a : b;

const SAFE_NAME = /^[A-Za-z0-9._-]{1,80}$/;
const VERIFY_LOG = /^verify-[1-9][0-9]{0,2}-[A-Za-z0-9._-]{1,60}\.log$/;
const SHA = /^[0-9a-f]{40}$/;
const REASON = /^[a-z0-9_]{1,64}$/;

/** The engine's fixed artifact names (orchestrator.ts) and the kind each must have. */
const FIXED_KINDS: Readonly<Record<string, ManagedArtifact["kind"]>> = {
	[MANIFEST_ARTIFACT_NAME]: "manifest",
	[DIFF_ARTIFACT_NAME]: "diff",
	[REVIEW_OUTPUT_ARTIFACT_NAME]: "review_output",
	"review.log": "review_log",
	"implementation.log": "implementation_log",
	"changed-files.json": "changed_files",
};

export const sha256Hex = (b: Uint8Array | string) =>
	createHash("sha256").update(b).digest("hex");

/** Fixed code for a verified-read failure (the error text itself is never passed on). */
function accessReason(err: ArtifactAccessError): string {
	const m = err.message;
	if (/symlink/.test(m)) return "symlink";
	if (/not a regular file/.test(m)) return "special_file";
	if (/missing/.test(m)) return "file_missing";
	if (/size \d+ B, recorded/.test(m)) return "size_mismatch";
	if (/sha256/.test(m)) return "hash_mismatch";
	if (/outside/.test(m)) return "path_outside_root";
	if (/too large/.test(m)) return "oversized";
	if (/short read/.test(m)) return "short_read";
	return "unreadable";
}

type Row = Record<string, unknown>;

/** Bounded, read-only row fetch (never inside a caller's transaction: the caller is async). */
export function readArtifactRows(
	db: Database,
	taskId: string,
	runId: string,
	limit: number,
): { rows: ManagedArtifact[]; invalid: number; overflow: boolean } {
	const raw = db
		.query<Row, [string, string, number]>(
			"SELECT id, task_id, run_id, kind, name, rel_path, sha256, byte_len, truncated, candidate_sha, meta, created_at FROM managed_artifacts WHERE task_id = ? AND run_id = ? ORDER BY name, id LIMIT ?",
		)
		.all(taskId, runId, limit + 1);
	const rows: ManagedArtifact[] = [];
	let invalid = 0;
	for (const r of raw.slice(0, limit)) {
		const parsed = toArtifact(r);
		if (parsed) rows.push(parsed);
		else invalid++;
	}
	return { rows, invalid, overflow: raw.length > limit };
}

export function toArtifact(r: Row): ManagedArtifact | null {
	if (r.truncated !== 0 && r.truncated !== 1) return null;
	let meta: unknown = {};
	try {
		meta = typeof r.meta === "string" ? JSON.parse(r.meta) : {};
	} catch {
		return null;
	}
	const p = ManagedArtifact.safeParse({
		...r,
		truncated: r.truncated === 1,
		meta,
	});
	if (!p.success || !ArtifactId.safeParse(p.data.id).success) return null;
	return p.data;
}

export function readReviewRows(
	db: Database,
	taskId: string,
	runId: string,
	limit: number,
): { rows: ManagedReview[]; invalid: number; overflow: boolean } {
	const raw = db
		.query<Row, [string, string, number]>(
			"SELECT * FROM managed_reviews WHERE task_id = ? AND run_id = ? ORDER BY created_at, id LIMIT ?",
		)
		.all(taskId, runId, limit + 1);
	const rows: ManagedReview[] = [];
	let invalid = 0;
	for (const r of raw.slice(0, limit)) {
		let findings: unknown;
		let usage: unknown;
		try {
			findings = typeof r.findings === "string" ? JSON.parse(r.findings) : [];
			usage = typeof r.usage === "string" ? JSON.parse(r.usage) : null;
		} catch {
			invalid++;
			continue;
		}
		if (r.valid !== 0 && r.valid !== 1) {
			invalid++;
			continue;
		}
		const p = ManagedReview.safeParse({
			...r,
			valid: r.valid === 1,
			findings,
			usage,
		});
		if (p.success) rows.push(p.data);
		else invalid++;
	}
	return { rows, invalid, overflow: raw.length > limit };
}

export interface CollectDeps {
	db: Database;
	config: ManagedConfig;
	limits: EvidenceLimits;
	/** Runner in the trusted repository (blob/diff reads for the disclosure recheck). */
	git: GitRunner;
	recheckDisclosure: boolean;
	deadline: number;
	now: () => number;
}

const timeCheck = (d: CollectDeps) => {
	if (d.now() > d.deadline) throw new SealError("timeout");
};

/**
 * Fresh disclosure check of the stored diff: recompute `git diff base candidate` from immutable
 * objects, decide disclosure from complete old/new contexts (Part A), and require the stored bytes
 * to be exactly that disclosed text.
 */
async function recheckDiff(
	d: CollectDeps,
	run: ManagedRun,
	stored: Buffer,
): Promise<{ status: EvidenceStatus; reasons: string[] }> {
	const base = run.base_sha;
	const candidate = run.candidate_sha as string;
	if (!SHA.test(base) || !SHA.test(candidate))
		return { status: "unknown", reasons: ["diff_recheck_failed"] };
	const r = await d.git(
		["diff", "--no-color", "--no-ext-diff", "--no-textconv", base, candidate],
		d.limits.max_diff_bytes,
	);
	timeCheck(d);
	if (!r.spawned || r.timedOut || r.aborted || r.exitCode !== 0)
		return { status: "unknown", reasons: ["diff_recheck_failed"] };
	if (r.stdoutTruncated)
		return { status: "withheld", reasons: ["diff_truncated"] };
	const refs = listDiffFiles(r.stdout);
	const contexts = await loadDiffContexts(
		d.git,
		refs,
		{ old_rev: base, new_rev: candidate },
		{ max_files: 500 },
	);
	timeCheck(d);
	const decision = decideDiffDisclosure({ diff: r.stdout, contexts });
	if (decision.status === "withheld")
		return {
			status: "withheld",
			reasons: [...new Set(decision.failures.map((f) => f.reason))].sort(),
		};
	if (stored.equals(Buffer.from(decision.text, "utf8")))
		return { status: "verified", reasons: [] };
	const text = stored.toString("utf8");
	// the raw or the legacy line-based form of THIS candidate's diff: real, but not safely disclosable
	if (text === r.stdout || text === redactDiff(r.stdout))
		return { status: "withheld", reasons: ["diff_not_disclosure_form"] };
	return { status: "corrupt", reasons: ["diff_not_from_candidate"] };
}

/**
 * Read and classify every artifact of the attempt `run` of `task`. `candidateTree` (from git) is
 * required for the manifest binding; null means it could not be established (manifest → stale).
 * Throws SealError only for unbounded / unrepresentable input (too many rows, invalid rows, timeout).
 */
export async function collectRunEvidence(
	d: CollectDeps,
	task: ManagedTask,
	run: ManagedRun,
	candidateTree: string | null,
): Promise<RunEvidence> {
	const problems: string[] = [];
	const { rows, invalid, overflow } = readArtifactRows(
		d.db,
		task.id,
		run.id,
		d.limits.max_artifacts,
	);
	if (overflow) throw new SealError("too_many_artifacts");
	if (invalid > 0) throw new SealError("artifact_row_invalid");

	const items: EvidenceItem[] = [];
	let total = 0;
	for (const row of rows) {
		const prev = items[items.length - 1];
		if (prev && prev.row.name === row.name) {
			// a second row with the same name: the kept one cannot be trusted either
			prev.status = "corrupt";
			prev.reasons.push("duplicate_name");
			problems.push(`${prev.row.name}: duplicate row ignored`);
			continue;
		}
		const item: EvidenceItem = {
			row,
			status: "verified",
			reasons: [],
			buffer: null,
		};
		const down = (s: EvidenceStatus, reason: string) => {
			item.status = worse(item.status, s);
			item.reasons.push(reason);
		};
		items.push(item);
		if (!SAFE_NAME.test(row.name)) {
			down("corrupt", "unsafe_name");
			continue;
		}
		const expected =
			FIXED_KINDS[row.name] ??
			(VERIFY_LOG.test(row.name) ? "verification_log" : null);
		if (expected === null) down("corrupt", "unexpected_artifact");
		else if (row.kind !== expected) down("corrupt", "kind_mismatch");
		if (row.candidate_sha !== run.candidate_sha)
			down("stale", "candidate_mismatch");
		if (row.byte_len > d.limits.max_artifact_bytes) {
			down("unknown", "oversized");
			continue;
		}
		if (total + row.byte_len > d.limits.max_total_bytes) {
			down("unknown", "budget_exceeded");
			continue;
		}
		total += row.byte_len;
		timeCheck(d);
		try {
			item.buffer = readArtifactBytes(d.config.artifacts_root, row);
		} catch (err) {
			if (!(err instanceof ArtifactAccessError)) throw err;
			down("corrupt", accessReason(err));
			continue;
		}
		if (row.truncated) down("truncated", "truncated_capture");
	}
	const byName = new Map(items.map((i) => [i.row.name, i]));

	// manifest: bytes → run.manifest_hash → schema → binding to task/run/candidate/tree
	let manifest: EvidenceManifest | null = null;
	const mItem = byName.get(MANIFEST_ARTIFACT_NAME);
	if (mItem?.buffer) {
		const down = (s: EvidenceStatus, r: string) => {
			mItem.status = worse(mItem.status, s);
			mItem.reasons.push(r);
		};
		let parsed: EvidenceManifest | null = null;
		if (sha256Hex(mItem.buffer) !== run.manifest_hash)
			down("corrupt", "manifest_hash_mismatch");
		try {
			const p = EvidenceManifest.safeParse(
				JSON.parse(mItem.buffer.toString("utf8")),
			);
			if (p.success) parsed = p.data;
			else down("corrupt", "manifest_unparseable");
		} catch {
			down("corrupt", "manifest_unparseable");
		}
		if (parsed) {
			if (
				parsed.task_id !== task.id ||
				parsed.run_id !== run.id ||
				parsed.attempt_no !== run.attempt_no ||
				parsed.base_sha !== run.base_sha ||
				parsed.parent_sha !== run.parent_sha ||
				parsed.candidate_sha !== run.candidate_sha ||
				candidateTree === null ||
				parsed.candidate_tree !== candidateTree
			)
				down("stale", "manifest_binding_mismatch");
			if (
				parsed.verification.length > 10 ||
				parsed.verification.some(
					(v) =>
						!EnvelopeCheck.safeParse({
							name: v.name,
							completed: v.completed,
							timed_out: v.timed_out,
							exit_code: v.exit_code,
							duration_ms: v.duration_ms,
							log_sha256: v.log_sha256,
							log_truncated: v.log_truncated,
						}).success,
				)
			)
				down("corrupt", "manifest_unsupported");
		}
		if (mItem.status === "verified") manifest = parsed;
	}

	// manifest-linked items
	const expectedLogs = new Map<
		string,
		EvidenceManifest["verification"][number]
	>();
	for (const [i, v] of (manifest?.verification ?? []).entries())
		expectedLogs.set(verificationLogName(i, v.name), v);
	for (const item of items) {
		const down = (s: EvidenceStatus, r: string) => {
			item.status = worse(item.status, s);
			item.reasons.push(r);
		};
		const { row } = item;
		if (row.kind === "diff" && row.name === DIFF_ARTIFACT_NAME) {
			if (!manifest) down("unknown", "manifest_untrusted");
			else if (
				row.sha256 !== manifest.diff_sha256 ||
				row.truncated !== manifest.diff_truncated
			)
				down("corrupt", "manifest_link_broken");
			const disclosure = (row.meta as { disclosure?: unknown }).disclosure as
				| { status?: unknown }
				| undefined;
			if (disclosure && disclosure.status !== "disclosed")
				down("withheld", "disclosure_withheld");
		} else if (row.kind === "verification_log") {
			const v = expectedLogs.get(row.name);
			if (!manifest) down("unknown", "manifest_untrusted");
			else if (!v) down("corrupt", "not_in_manifest");
			else if (row.sha256 !== v.log_sha256 || row.truncated !== v.log_truncated)
				down("corrupt", "manifest_link_broken");
		} else if (row.kind === "changed_files" && manifest && item.buffer) {
			try {
				const listed = JSON.stringify(JSON.parse(item.buffer.toString("utf8")));
				if (listed !== JSON.stringify(manifest.changed_files))
					down("corrupt", "manifest_link_broken");
			} catch {
				down("corrupt", "manifest_link_broken");
			}
		}
	}

	// review output: must name this candidate and manifest
	let reviewOutput: ReviewOutputBinding | null = null;
	const rItem = byName.get(REVIEW_OUTPUT_ARTIFACT_NAME);
	if (rItem?.buffer) {
		try {
			const o = JSON.parse(rItem.buffer.toString("utf8")) as Record<
				string,
				unknown
			> | null;
			if (o === null || typeof o !== "object" || Array.isArray(o))
				throw new Error("not an object");
			reviewOutput = {
				audited_sha: o.audited_sha,
				manifest_hash: o.manifest_hash,
				verdict: o.verdict,
			};
			if (
				o.audited_sha !== run.candidate_sha ||
				o.manifest_hash !== run.manifest_hash
			) {
				rItem.status = worse(rItem.status, "stale");
				rItem.reasons.push("review_output_binding_mismatch");
			}
		} catch {
			rItem.status = worse(rItem.status, "corrupt");
			rItem.reasons.push("review_output_unparseable");
		}
	}

	// the stored diff must be the complete-context disclosure of THIS candidate's diff
	const dItem = byName.get(DIFF_ARTIFACT_NAME);
	if (
		d.recheckDisclosure &&
		dItem?.buffer &&
		dItem.row.kind === "diff" &&
		(dItem.status === "verified" || dItem.status === "truncated")
	) {
		timeCheck(d);
		const r = await recheckDiff(d, run, dItem.buffer);
		dItem.status = worse(dItem.status, r.status);
		dItem.reasons.push(...r.reasons);
	}

	const present = new Set(items.map((i) => i.row.name));
	const missing = [
		MANIFEST_ARTIFACT_NAME,
		DIFF_ARTIFACT_NAME,
		REVIEW_OUTPUT_ARTIFACT_NAME,
		...expectedLogs.keys(),
	].filter((n) => !present.has(n));

	const reviews = readReviewRows(d.db, task.id, run.id, d.limits.max_reviews);
	if (reviews.overflow || reviews.invalid > 0)
		problems.push("review rows: unreadable or too many");

	for (const i of items) {
		i.reasons = [...new Set(i.reasons.filter((r) => REASON.test(r)))].sort();
		if (i.status !== "verified")
			problems.push(
				`${SAFE_NAME.test(i.row.name) ? i.row.name : "(unsafe name)"}: ${i.status} (${i.reasons.join(",")})`,
			);
	}
	for (const m of missing) problems.push(`${m}: missing`);
	return {
		items,
		manifest,
		missing,
		reviews: reviews.rows,
		reviewsReadable: !reviews.overflow && reviews.invalid === 0,
		reviewOutput,
		problems: problems.slice(0, 50),
	};
}

/** `rev-parse --verify <sha>^{commit}` and `^{tree}` from the trusted repository; null if unknown. */
export async function candidateTreeOf(
	git: GitRunner,
	candidate: string,
): Promise<string | null> {
	if (!SHA.test(candidate)) return null;
	const c = await git(
		[
			"rev-parse",
			"--verify",
			"--quiet",
			"--end-of-options",
			`${candidate}^{commit}`,
		],
		256,
	);
	if (!c.spawned || c.exitCode !== 0 || c.stdout.trim() !== candidate)
		return null;
	const t = await git(
		[
			"rev-parse",
			"--verify",
			"--quiet",
			"--end-of-options",
			`${candidate}^{tree}`,
		],
		256,
	);
	const tree = t.stdout.trim();
	return t.spawned && t.exitCode === 0 && SHA.test(tree) ? tree : null;
}
