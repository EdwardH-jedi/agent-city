// Diff disclosure decided from COMPLETE bounded old/new file content (closes the omitted-hunk gap of
// `redactDiff`: a secret-named YAML header outside the hunk context left its block body visible).
//
// Pure and deterministic: no I/O, no logging, no clock, no randomness. For each file of a `git diff`:
//   1. the parse must be clean (exact hunk counts, known headers, not binary/special/truncated);
//   2. every side the diff shows must be supplied as bytes (an added file's old side and a deleted
//      file's new side must be `absent`), within the byte limits, NUL-free and strict UTF-8;
//   3. the bytes must BE the diffed versions: the `index` blob ids are prefixes of the git blob ids of
//      the bytes, every context/removed line equals the old line at its number, every context/added
//      line equals the new line at its number, and "\ No newline" markers match the bytes;
//   4. each full version is scanned (secret-lines.ts); a version whose secret structure cannot be
//      delimited withholds the file;
//   5. secret lines are masked on the diff through their line numbers (context lines when either
//      version marks them), hunk headings (an old line outside the hunk) are masked unless they
//      locate to clean old lines, and name-bearing header lines go through `redact`.
// Any failure withholds that file's whole diff content; failures carry reason codes, sizes and a
// path hash only — never file content, never a secret, never a "nearby" excerpt.
import { createHash } from "node:crypto";
import { REDACTED, redact } from "@agent-city/schema";
import type { EvidenceStatus } from "@agent-city/schema/workspace-m1";
import { type ParsedFile, parseGitDiff } from "./diff-parse.ts";
import { maskedLine, scanSecretLines } from "./secret-lines.ts";

export interface DisclosureLimits {
	/** Whole diff text (UTF-8 bytes). */
	max_diff_bytes: number;
	/** Files in one diff. */
	max_files: number;
	/** One old or new version. */
	max_file_bytes: number;
	/** All context bytes of one diff together. */
	max_total_context_bytes: number;
}

export const DEFAULT_DISCLOSURE_LIMITS: Readonly<DisclosureLimits> = {
	max_diff_bytes: 8_000_000,
	max_files: 500,
	max_file_bytes: 1_048_576,
	max_total_context_bytes: 16_777_216,
};

/** Why a loader could not supply a version (sanitized; no message text). */
export type ContextUnavailableReason =
	| "oversized"
	| "unreadable"
	| "special_file"
	| "binary"
	| "undecodable"
	| "not_found"
	| "timeout"
	| "bad_request";

const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
	"oversized",
	"unreadable",
	"special_file",
	"binary",
	"undecodable",
	"not_found",
	"timeout",
	"bad_request",
]);

export type ContextSource =
	| { kind: "bytes"; bytes: Uint8Array }
	| { kind: "absent" }
	| { kind: "unavailable"; reason: ContextUnavailableReason };

/** Old/new versions of one diffed file, matched to the diff by exact (old_path, new_path). */
export interface FileContextEntry {
	/** null for an added file. */
	old_path: string | null;
	/** null for a deleted file. */
	new_path: string | null;
	old: ContextSource;
	new: ContextSource;
}

export type DisclosureFailureReason =
	| "diff_oversized"
	| "too_many_files"
	| "unparseable_diff"
	| "diff_truncated"
	| "binary"
	| "special_file"
	| "context_missing"
	| "context_ambiguous"
	| "context_unavailable"
	| "context_oversized"
	| "context_budget_exceeded"
	| "context_binary"
	| "context_undecodable"
	| "context_mismatch"
	| "index_missing"
	| "context_uninterpretable";

export interface DisclosureFailure {
	/** Position of the file in the diff; null = the diff as a whole. */
	file_index: number | null;
	/** First 16 hex of sha256(path) — identifies the file without revealing its name. */
	path_id: string | null;
	/** The path itself only when it is plainly safe to show (strict charset, nothing redact masks). */
	path: string | null;
	side: "old" | "new" | null;
	reason: DisclosureFailureReason;
	/** A code from a fixed set (loader reason / uninterpretable structure), never free text. */
	detail: string | null;
	bytes: number | null;
	limit: number | null;
}

export type FileDisclosure =
	| {
			status: "disclosed";
			file_index: number;
			path_id: string | null;
			path: string | null;
			/** This file's lines of the diff, masked; concatenating every file gives the diff. */
			text: string;
			masked_lines: number;
	  }
	| {
			status: "withheld";
			file_index: number;
			path_id: string | null;
			path: string | null;
			failures: DisclosureFailure[];
	  };

export type DisclosureResult =
	| {
			status: "disclosed";
			text: string;
			files: FileDisclosure[];
			masked_lines: number;
	  }
	| {
			status: "withheld";
			failures: DisclosureFailure[];
			/** Per-file outcomes (disclosed files may still be shown individually). */
			files: FileDisclosure[];
	  };

export interface DisclosureInput {
	diff: string;
	/** The diff text was cut by a byte cap: its last file cannot be complete. */
	truncated?: boolean;
	contexts: readonly FileContextEntry[];
	limits?: Partial<DisclosureLimits>;
}

const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const SAFE_PATH = /^[A-Za-z0-9._/-]{1,200}$/;
const ZEROS = /^0+$/;

export function pathId(path: string): string {
	return createHash("sha256").update(path, "utf8").digest("hex").slice(0, 16);
}

export function safePath(path: string): string | null {
	if (!SAFE_PATH.test(path)) return null;
	if (path.split("/").some((seg) => seg === "" || seg === "." || seg === ".."))
		return null;
	return redact(path) === path ? path : null;
}

/** git blob ids (sha1 and sha256 object formats) of `bytes`. */
export function gitBlobIds(bytes: Uint8Array): {
	sha1: string;
	sha256: string;
} {
	const head = Buffer.from(`blob ${bytes.length}\0`, "utf8");
	return {
		sha1: createHash("sha1").update(head).update(bytes).digest("hex"),
		sha256: createHash("sha256").update(head).update(bytes).digest("hex"),
	};
}

const SIDE_ORDER = { old: 0, new: 1 } as const;

function byOrder(a: DisclosureFailure, b: DisclosureFailure): number {
	const fa = a.file_index ?? -1;
	const fb = b.file_index ?? -1;
	if (fa !== fb) return fa - fb;
	const sa = a.side === null ? 2 : SIDE_ORDER[a.side];
	const sb = b.side === null ? 2 : SIDE_ORDER[b.side];
	if (sa !== sb) return sa - sb;
	return a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0;
}

interface Version {
	lines: string[];
	/** The bytes ended with "\n" (so the last element of `lines` is a full line). */
	eol: boolean;
	secret: Set<number>;
}

interface Budget {
	used: number;
}

type SideResult =
	| { ok: true; version: Version | null }
	| { ok: false; failures: DisclosureFailure[] };

function failure(
	f: ParsedFile | null,
	side: "old" | "new" | null,
	reason: DisclosureFailureReason,
	extra: Partial<Pick<DisclosureFailure, "detail" | "bytes" | "limit">> = {},
): DisclosureFailure {
	const p = f
		? side === "old"
			? f.old_path
			: side === "new"
				? f.new_path
				: (f.new_path ?? f.old_path)
		: null;
	return {
		file_index: f ? f.index : null,
		path_id: p === null ? null : pathId(p),
		path: p === null ? null : safePath(p),
		side,
		reason,
		detail: extra.detail ?? null,
		bytes: extra.bytes ?? null,
		limit: extra.limit ?? null,
	};
}

/** Validate, bind and scan one side of one file. */
function loadSide(
	f: ParsedFile,
	side: "old" | "new",
	src: ContextSource,
	limits: DisclosureLimits,
	budget: Budget,
): SideResult {
	const needed = side === "old" ? f.change !== "added" : f.change !== "deleted";
	const blob = side === "old" ? f.old_blob : f.new_blob;
	const fail = (
		...a: [DisclosureFailureReason, Parameters<typeof failure>[3]?]
	) => ({
		ok: false as const,
		failures: [failure(f, side, a[0], a[1])],
	});
	if (!needed) {
		if (src.kind !== "absent") return fail("context_mismatch");
		if (blob !== null && !ZEROS.test(blob)) return fail("context_mismatch");
		return { ok: true, version: null };
	}
	if (src.kind === "absent") return fail("context_missing");
	if (src.kind === "unavailable")
		return fail("context_unavailable", {
			detail: UNAVAILABLE_REASONS.has(src.reason) ? src.reason : "other",
		});
	const size = src.bytes.length;
	if (size > limits.max_file_bytes)
		return fail("context_oversized", {
			bytes: size,
			limit: limits.max_file_bytes,
		});
	if (budget.used + size > limits.max_total_context_bytes)
		return fail("context_budget_exceeded", {
			bytes: size,
			limit: limits.max_total_context_bytes,
		});
	budget.used += size;
	if (src.bytes.includes(0)) return fail("context_binary", { bytes: size });
	let text: string;
	try {
		text = FATAL_UTF8.decode(src.bytes);
	} catch {
		return fail("context_undecodable", { bytes: size });
	}
	// binding 1: the bytes are the blob the diff's `index` line names
	if (blob === null) return fail("index_missing");
	if (ZEROS.test(blob)) return fail("context_mismatch");
	const ids = gitBlobIds(src.bytes);
	if (!ids.sha1.startsWith(blob) && !ids.sha256.startsWith(blob))
		return fail("context_mismatch");
	const lines = text.split("\n");
	const eol = text.endsWith("\n");
	if (eol || text === "") lines.pop();
	const scan = scanSecretLines(lines);
	if (scan.uninterpretable)
		return fail("context_uninterpretable", { detail: scan.uninterpretable });
	return { ok: true, version: { lines, eol, secret: scan.lines } };
}

/** binding 2: every shown line is the line of the version at its number; EOL markers agree. */
function linesAgree(f: ParsedFile, oldV: Version | null, newV: Version | null) {
	const bad: ("old" | "new")[] = [];
	const check = (
		side: "old" | "new",
		v: Version | null,
		no: number | null,
		text: string,
	) => {
		if (no === null) return;
		if (!v || no < 1 || no > v.lines.length || v.lines[no - 1] !== text)
			if (!bad.includes(side)) bad.push(side);
	};
	for (const h of f.hunks) {
		for (const hl of h.lines) {
			check("old", oldV, hl.old_no, hl.text);
			check("new", newV, hl.new_no, hl.text);
		}
		const eolCheck = (
			side: "old" | "new",
			v: Version | null,
			marker: number | null,
		) => {
			if (!v) return;
			const lastShown = h.lines.reduce<number | null>((acc, hl) => {
				const no = side === "old" ? hl.old_no : hl.new_no;
				return no === null ? acc : no;
			}, null);
			const coversEnd = lastShown !== null && lastShown === v.lines.length;
			const expected = coversEnd && !v.eol ? v.lines.length : null;
			if (marker !== expected && !bad.includes(side)) bad.push(side);
		};
		eolCheck("old", oldV, h.no_eol_old);
		eolCheck("new", newV, h.no_eol_new);
	}
	return bad;
}

/** Hunk heading: shown only when it is a prefix of clean old lines before the hunk. */
function headingSafe(
	heading: string,
	oldStart: number,
	oldV: Version | null,
): boolean {
	if (redact(heading) !== heading) return false;
	if (!oldV) return false;
	let found = false;
	const last = Math.min(oldStart, oldV.lines.length);
	for (let no = 1; no <= last; no++) {
		const line = oldV.lines[no - 1] as string;
		if (line.startsWith(heading)) {
			if (oldV.secret.has(no - 1)) return false;
			found = true;
		}
	}
	return found;
}

function renderFile(
	lines: readonly string[],
	f: ParsedFile,
	oldV: Version | null,
	newV: Version | null,
): { out: string[]; masked: number } {
	const out = lines.slice(f.start, f.end);
	let masked = 0;
	for (const at of f.path_lines) {
		const k = at - f.start;
		out[k] = redact(out[k] as string);
	}
	for (const h of f.hunks) {
		if (h.heading !== null && !headingSafe(h.heading, h.old_start, oldV)) {
			const raw = lines[h.at] as string;
			out[h.at - f.start] =
				`${raw.slice(0, raw.length - h.heading.length)}${REDACTED}`;
			masked++;
		}
		for (const hl of h.lines) {
			const secret =
				(hl.old_no !== null && oldV?.secret.has(hl.old_no - 1) === true) ||
				(hl.new_no !== null && newV?.secret.has(hl.new_no - 1) === true);
			if (!secret) continue;
			const raw = lines[hl.at] as string;
			const prefix = raw === "" ? " " : (raw[0] as string);
			const shown = `${prefix}${maskedLine(hl.text)}`;
			if (shown !== raw) masked++;
			out[hl.at - f.start] = raw === "" ? "" : shown;
		}
	}
	return { out, masked };
}

function decideFile(
	lines: readonly string[],
	f: ParsedFile,
	contexts: readonly FileContextEntry[],
	limits: DisclosureLimits,
	budget: Budget,
): { out: string[] | null; masked: number; failures: DisclosureFailure[] } {
	if (f.problem !== null)
		return { out: null, masked: 0, failures: [failure(f, null, f.problem)] };
	if (f.hunks.length === 0) {
		const r = renderFile(lines, f, null, null);
		return { out: r.out, masked: r.masked, failures: [] };
	}
	const matches = contexts.filter(
		(c) => c.old_path === f.old_path && c.new_path === f.new_path,
	);
	if (matches.length === 0)
		return {
			out: null,
			masked: 0,
			failures: [failure(f, null, "context_missing")],
		};
	if (matches.length > 1)
		return {
			out: null,
			masked: 0,
			failures: [failure(f, null, "context_ambiguous")],
		};
	const ctx = matches[0] as FileContextEntry;
	if (!f.has_index)
		return {
			out: null,
			masked: 0,
			failures: [failure(f, null, "index_missing")],
		};
	const o = loadSide(f, "old", ctx.old, limits, budget);
	const n = loadSide(f, "new", ctx.new, limits, budget);
	const failures = [...(o.ok ? [] : o.failures), ...(n.ok ? [] : n.failures)];
	if (!o.ok || !n.ok) return { out: null, masked: 0, failures };
	const bad = linesAgree(f, o.version, n.version);
	if (bad.length > 0)
		return {
			out: null,
			masked: 0,
			failures: bad.map((side) => failure(f, side, "context_mismatch")),
		};
	const r = renderFile(lines, f, o.version, n.version);
	return { out: r.out, masked: r.masked, failures: [] };
}

/**
 * Decide what of a `git diff` may be disclosed (stored, served, handed to a reviewer). The overall
 * result is `disclosed` only when every file is disclosed and the diff as a whole is sound; then
 * `text` is the diff with secret lines masked (byte-identical when nothing needed masking).
 */
export function decideDiffDisclosure(input: DisclosureInput): DisclosureResult {
	const limits: DisclosureLimits = {
		...DEFAULT_DISCLOSURE_LIMITS,
		...input.limits,
	};
	const size = Buffer.byteLength(input.diff, "utf8");
	if (size > limits.max_diff_bytes)
		return {
			status: "withheld",
			failures: [
				{
					...failure(null, null, "diff_oversized"),
					bytes: size,
					limit: limits.max_diff_bytes,
				},
			],
			files: [],
		};
	const parsed = parseGitDiff(input.diff, { truncated: input.truncated });
	if (parsed.files.length > limits.max_files)
		return {
			status: "withheld",
			failures: [
				{
					...failure(null, null, "too_many_files"),
					limit: limits.max_files,
				},
			],
			files: [],
		};
	const global: DisclosureFailure[] = [];
	if (parsed.preamble) global.push(failure(null, null, "unparseable_diff"));
	if (parsed.truncated && parsed.files.length === 0)
		global.push(failure(null, null, "diff_truncated"));

	const budget: Budget = { used: 0 };
	const out = [...parsed.lines];
	const files: FileDisclosure[] = [];
	let masked = 0;
	for (const f of parsed.files) {
		const d = decideFile(parsed.lines, f, input.contexts, limits, budget);
		const shownPath = f.new_path ?? f.old_path;
		const id = {
			file_index: f.index,
			path_id: shownPath === null ? null : pathId(shownPath),
			path: shownPath === null ? null : safePath(shownPath),
		};
		if (d.out === null) {
			files.push({
				status: "withheld",
				...id,
				failures: d.failures.sort(byOrder),
			});
			continue;
		}
		d.out.forEach((l, k) => {
			out[f.start + k] = l;
		});
		const isLast = f.index === parsed.files.length - 1;
		const nl = !isLast || parsed.trailing_newline ? "\n" : "";
		files.push({
			status: "disclosed",
			...id,
			text: d.out.join("\n") + nl,
			masked_lines: d.masked,
		});
		masked += d.masked;
	}
	const failures = [
		...global,
		...files.flatMap((f) => (f.status === "withheld" ? f.failures : [])),
	].sort(byOrder);
	if (failures.length > 0) return { status: "withheld", failures, files };
	return {
		status: "disclosed",
		text: out.join("\n") + (parsed.trailing_newline ? "\n" : ""),
		files,
		masked_lines: masked,
	};
}

// ── frozen-contract view (agentcity.result/v1 EvidenceStatus) ────────────────

/**
 * A disclosure decision as evidence status: `verified` when the whole diff may be disclosed, else
 * `withheld` with the failure reason codes (sorted, unique; each matches `^[a-z0-9_]{1,64}$`, the
 * ArtifactTextResponse `withheld_reasons` rule). Never content.
 */
export function disclosureEvidence(r: DisclosureResult): {
	status: Extract<EvidenceStatus, "verified" | "withheld">;
	withheld_reasons: DisclosureFailureReason[];
} {
	if (r.status === "disclosed")
		return { status: "verified", withheld_reasons: [] };
	return {
		status: "withheld",
		withheld_reasons: [...new Set(r.failures.map((f) => f.reason))].sort(),
	};
}

/**
 * R-E3 partial display: the individually disclosed files' text, each withheld file replaced by one
 * fixed placeholder line carrying its position and reason codes only. Not acceptance evidence —
 * the overall status stays `withheld`.
 */
export function renderWithPlaceholders(r: DisclosureResult): string {
	if (r.status === "disclosed") return r.text;
	if (r.files.length === 0)
		return `# agent-city: diff withheld (${[...new Set(r.failures.map((f) => f.reason))].sort().join(",")})\n`;
	return r.files
		.map((f) =>
			f.status === "disclosed"
				? f.text
				: `# agent-city: file ${f.file_index} withheld (${[...new Set(f.failures.map((x) => x.reason))].sort().join(",")})\n`,
		)
		.join("");
}
