// Strict parser for `git diff` unified output — the format the hub's `diffText` produces
// (`git diff --no-color --no-ext-diff --no-textconv base head`). Pure: no I/O, no logging.
//
// Strictness is the point: hunk line counts are consumed exactly, only known extended headers are
// accepted, and anything else (combined diffs, foreign prefixes, preamble text, stray lines) is a
// parse problem, so the disclosure decision can withhold instead of guessing. The diff is split on
// "\n" only — a CRLF file's lines keep their "\r", so a clean diff re-joins byte-identically.

export interface HunkLine {
	kind: "context" | "removed" | "added";
	/** Index of the line in `ParsedDiff.lines`. */
	at: number;
	/** Content without the one-character prefix (may end with "\r"). */
	text: string;
	/** 1-based line number in the old version (context/removed lines), else null. */
	old_no: number | null;
	/** 1-based line number in the new version (context/added lines), else null. */
	new_no: number | null;
}

export interface Hunk {
	/** Index of the `@@` header in `ParsedDiff.lines`. */
	at: number;
	old_start: number;
	old_count: number;
	new_start: number;
	new_count: number;
	/** Text git appended after the second `@@` (a line of the OLD file, see heading rules), or null. */
	heading: string | null;
	lines: HunkLine[];
	/** Old line number after which "\ No newline at end of file" appeared, or null. */
	no_eol_old: number | null;
	/** New line number after which "\ No newline at end of file" appeared, or null. */
	no_eol_new: number | null;
}

export type FileProblem =
	| "unparseable_diff"
	| "diff_truncated"
	| "binary"
	| "special_file";

export type ChangeKind =
	| "modified"
	| "added"
	| "deleted"
	| "renamed"
	| "copied";

export interface ParsedFile {
	/** 0-based position of the file in the diff. */
	index: number;
	/** Lines `[start, end)` of `ParsedDiff.lines` belong to this file. */
	start: number;
	end: number;
	/** Old-side path (no `a/` prefix); null when the file is added (or unknown, with a problem). */
	old_path: string | null;
	/** New-side path (no `b/` prefix); null when the file is deleted (or unknown, with a problem). */
	new_path: string | null;
	change: ChangeKind;
	/** Abbreviated blob ids from the `index <old>..<new>` header (all zeros = side absent). */
	old_blob: string | null;
	new_blob: string | null;
	has_index: boolean;
	hunks: Hunk[];
	/** Lines carrying file names (`diff --git`, `---`, `+++`, rename/copy): redacted on output. */
	path_lines: number[];
	problem: FileProblem | null;
}

export interface ParsedDiff {
	lines: string[];
	/** The text ended with "\n" (not represented in `lines`). */
	trailing_newline: boolean;
	/** Non-empty text before the first `diff --git` (git never produces it). */
	preamble: boolean;
	/** The caller said the diff text was cut by a byte cap. */
	truncated: boolean;
	files: ParsedFile[];
}

/** What a context loader needs to know about one file of the diff. */
export interface DiffFileRef {
	index: number;
	old_path: string | null;
	new_path: string | null;
	/** The file shows content lines (hunks), so old/new context is required to disclose it. */
	needs_context: boolean;
}

const HUNK =
	/^@@ -(\d{1,10})(?:,(\d{1,10}))? \+(\d{1,10})(?:,(\d{1,10}))? @@(?: (.*))?$/;
const H_OLD_MODE = /^old mode ([0-7]{6})$/;
const H_NEW_MODE = /^new mode ([0-7]{6})$/;
const H_DELETED = /^deleted file mode ([0-7]{6})$/;
const H_NEW_FILE = /^new file mode ([0-7]{6})$/;
const H_INDEX = /^index ([0-9a-f]{4,64})\.\.([0-9a-f]{4,64})(?: ([0-7]{6}))?$/;
const H_SIMILARITY = /^(?:dis)?similarity index \d{1,3}%$/;
const NO_EOL = "\\ No newline at end of file";
const SPECIAL_MODES = new Set(["120000", "160000"]);
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const SIMPLE_ESC: Record<string, number> = {
	a: 7,
	b: 8,
	t: 9,
	n: 10,
	v: 11,
	f: 12,
	r: 13,
	'"': 34,
	"\\": 92,
};

/**
 * Parse a git C-style quoted name starting at `s[from] === '"'`. Escapes: \a \b \t \n \v \f \r
 * \" \\ and \ooo octal bytes (git writes non-ASCII bytes that way). The bytes must be UTF-8.
 */
export function unquoteGitPath(
	s: string,
	from = 0,
): { value: string; end: number } | null {
	if (s[from] !== '"') return null;
	const bytes: number[] = [];
	let i = from + 1;
	while (i < s.length) {
		const c = s[i] as string;
		if (c === '"') {
			try {
				return {
					value: FATAL_UTF8.decode(Uint8Array.from(bytes)),
					end: i + 1,
				};
			} catch {
				return null;
			}
		}
		if (c === "\\") {
			const e = s[i + 1];
			if (e === undefined) return null;
			const simple = SIMPLE_ESC[e];
			if (simple !== undefined) {
				bytes.push(simple);
				i += 2;
				continue;
			}
			const oct = /^[0-3][0-7]{2}/.exec(s.slice(i + 1, i + 4));
			if (!oct) return null;
			bytes.push(Number.parseInt(oct[0], 8));
			i += 4;
			continue;
		}
		const cp = s.codePointAt(i) as number;
		const ch = String.fromCodePoint(cp);
		for (const b of new TextEncoder().encode(ch)) bytes.push(b);
		i += ch.length;
	}
	return null;
}

/** A name field (`rename from …`, …): quoted or verbatim. */
function nameField(rest: string): string | null {
	if (rest.startsWith('"')) {
		const q = unquoteGitPath(rest);
		return q && q.end === rest.length ? q.value : null;
	}
	return rest.length > 0 ? rest : null;
}

/**
 * `--- a/x` / `+++ b/x` → path; `/dev/null` → null; undefined = not parseable. Git appends one TAB
 * to these lines when the name contains a space — exactly one is stripped.
 */
function sidePath(
	rest: string,
	prefix: "a/" | "b/",
): string | null | undefined {
	if (rest === "/dev/null") return null;
	const r = rest.endsWith("\t") ? rest.slice(0, -1) : rest;
	if (r.startsWith('"')) {
		const q = unquoteGitPath(r);
		if (!q || q.end !== r.length || !q.value.startsWith(prefix))
			return undefined;
		const p = q.value.slice(prefix.length);
		return p.length > 0 ? p : undefined;
	}
	if (!r.startsWith(prefix) || r.length === prefix.length) return undefined;
	return r.slice(prefix.length);
}

/** Paths from `diff --git <a> <b>` — a fallback only (an unquoted pair with spaces is ambiguous). */
function headerPaths(rest: string): { a: string; b: string } | null {
	const strip = (v: string, p: string) =>
		v.startsWith(p) && v.length > p.length ? v.slice(p.length) : null;
	if (rest.startsWith('"')) {
		const q = unquoteGitPath(rest);
		if (!q || rest[q.end] !== " ") return null;
		const tail = rest.slice(q.end + 1);
		const b = tail.startsWith('"') ? unquoteGitPath(tail) : null;
		const bv = tail.startsWith('"')
			? b && b.end === tail.length
				? b.value
				: null
			: tail;
		const a = strip(q.value, "a/");
		const bb = bv === null ? null : strip(bv, "b/");
		return a !== null && bb !== null ? { a, b: bb } : null;
	}
	if (rest.endsWith('"')) {
		for (let k = rest.indexOf(' "'); k >= 0; k = rest.indexOf(' "', k + 1)) {
			const q = unquoteGitPath(rest, k + 1);
			if (q && q.end === rest.length) {
				const a = strip(rest.slice(0, k), "a/");
				const b = strip(q.value, "b/");
				return a !== null && b !== null ? { a, b } : null;
			}
		}
		return null;
	}
	// unquoted, same name on both sides: "a/P b/P"
	if ((rest.length - 5) % 2 !== 0 || rest.length < 7) return null;
	const p = rest.slice(2, 2 + (rest.length - 5) / 2);
	return rest === `a/${p} b/${p}` ? { a: p, b: p } : null;
}

function parseFile(
	lines: readonly string[],
	start: number,
	end: number,
	index: number,
): ParsedFile {
	const f: ParsedFile = {
		index,
		start,
		end,
		old_path: null,
		new_path: null,
		change: "modified",
		old_blob: null,
		new_blob: null,
		has_index: false,
		hunks: [],
		path_lines: [start],
		problem: null,
	};
	const header = headerPaths(
		(lines[start] as string).slice("diff --git ".length),
	);
	if (header) {
		f.old_path = header.a;
		f.new_path = header.b;
	}
	const modes: string[] = [];
	let isNew = false;
	let isDeleted = false;
	let renameFrom: string | null | undefined;
	let renameTo: string | null | undefined;
	let copyFrom: string | null | undefined;
	let copyTo: string | null | undefined;
	let minus: string | null | undefined;
	let plus: string | null | undefined;
	let sawSides = false;
	const bad = (p: FileProblem): ParsedFile => {
		f.problem = p;
		return f;
	};

	let i = start + 1;
	for (; i < end; i++) {
		const l = lines[i] as string;
		if (
			l.startsWith("--- ") ||
			l.startsWith("@@") ||
			l.startsWith("Binary files ") ||
			l === "GIT binary patch"
		)
			break;
		const mode = H_OLD_MODE.exec(l) ?? H_NEW_MODE.exec(l);
		const deleted = H_DELETED.exec(l);
		const created = H_NEW_FILE.exec(l);
		const idx = H_INDEX.exec(l);
		if (mode) {
			modes.push(mode[1] as string);
		} else if (deleted) {
			isDeleted = true;
			modes.push(deleted[1] as string);
		} else if (created) {
			isNew = true;
			modes.push(created[1] as string);
		} else if (idx) {
			if (f.has_index) return bad("unparseable_diff");
			f.has_index = true;
			f.old_blob = idx[1] as string;
			f.new_blob = idx[2] as string;
			if (idx[3]) modes.push(idx[3]);
		} else if (H_SIMILARITY.test(l)) {
			// informational
		} else if (l.startsWith("rename from ")) {
			renameFrom = nameField(l.slice(12));
			f.path_lines.push(i);
		} else if (l.startsWith("rename to ")) {
			renameTo = nameField(l.slice(10));
			f.path_lines.push(i);
		} else if (l.startsWith("copy from ")) {
			copyFrom = nameField(l.slice(10));
			f.path_lines.push(i);
		} else if (l.startsWith("copy to ")) {
			copyTo = nameField(l.slice(8));
			f.path_lines.push(i);
		} else return bad("unparseable_diff");
	}

	// paths and change kind (recorded before any content problem, for failure metadata)
	const renamed = renameFrom !== undefined || renameTo !== undefined;
	const copied = copyFrom !== undefined || copyTo !== undefined;
	if (renamed && copied) return bad("unparseable_diff");
	if (renamed) {
		if (!renameFrom || !renameTo) return bad("unparseable_diff");
		f.change = "renamed";
		f.old_path = renameFrom;
		f.new_path = renameTo;
	} else if (copied) {
		if (!copyFrom || !copyTo) return bad("unparseable_diff");
		f.change = "copied";
		f.old_path = copyFrom;
		f.new_path = copyTo;
	}
	if (isNew && isDeleted) return bad("unparseable_diff");
	if ((isNew || isDeleted) && (renamed || copied))
		return bad("unparseable_diff");

	if (i < end && (lines[i] as string).startsWith("--- ")) {
		minus = sidePath((lines[i] as string).slice(4), "a/");
		f.path_lines.push(i);
		i++;
		if (i >= end || !(lines[i] as string).startsWith("+++ "))
			return bad("unparseable_diff");
		plus = sidePath((lines[i] as string).slice(4), "b/");
		f.path_lines.push(i);
		i++;
		if (minus === undefined || plus === undefined)
			return bad("unparseable_diff");
		if (minus === null && plus === null) return bad("unparseable_diff");
		sawSides = true;
	}

	if (isNew) {
		f.change = "added";
		f.old_path = null;
		if (sawSides) {
			if (minus !== null) return bad("unparseable_diff");
			f.new_path = plus ?? null;
		}
	} else if (isDeleted) {
		f.change = "deleted";
		f.new_path = null;
		if (sawSides) {
			if (plus !== null) return bad("unparseable_diff");
			f.old_path = minus ?? null;
		}
	} else if (sawSides) {
		if (minus === null || plus === null) return bad("unparseable_diff");
		if (renamed || copied) {
			if (minus !== f.old_path || plus !== f.new_path)
				return bad("unparseable_diff");
		} else {
			f.old_path = minus ?? null;
			f.new_path = plus ?? null;
		}
	}
	if (
		(f.change !== "added" && f.old_path === null) ||
		(f.change !== "deleted" && f.new_path === null)
	)
		return bad("unparseable_diff");

	if (
		i < end &&
		((lines[i] as string).startsWith("Binary files ") ||
			lines[i] === "GIT binary patch")
	)
		return bad("binary");

	// hunks: counts are consumed exactly; every loop is bounded by `end`
	while (i < end) {
		const m = HUNK.exec(lines[i] as string);
		if (!m) return bad("unparseable_diff");
		const h: Hunk = {
			at: i,
			old_start: Number(m[1]),
			old_count: m[2] === undefined ? 1 : Number(m[2]),
			new_start: Number(m[3]),
			new_count: m[4] === undefined ? 1 : Number(m[4]),
			heading: m[5] ? m[5] : null,
			lines: [],
			no_eol_old: null,
			no_eol_new: null,
		};
		if (
			(h.old_count > 0 && h.old_start === 0) ||
			(h.new_count > 0 && h.new_start === 0)
		)
			return bad("unparseable_diff");
		i++;
		let oldLeft = h.old_count;
		let newLeft = h.new_count;
		let o = h.old_start;
		let n = h.new_start;
		let last: HunkLine | null = null;
		while (i < end) {
			const l = lines[i] as string;
			if (l === NO_EOL) {
				if (last === null) return bad("unparseable_diff");
				if (last.old_no !== null) h.no_eol_old = last.old_no;
				if (last.new_no !== null) h.no_eol_new = last.new_no;
				i++;
				continue;
			}
			if (oldLeft === 0 && newLeft === 0) break;
			const c = l[0];
			if (c === " " || (l === "" && oldLeft > 0 && newLeft > 0)) {
				if (oldLeft === 0 || newLeft === 0) return bad("unparseable_diff");
				last = {
					kind: "context",
					at: i,
					text: l.slice(1),
					old_no: o++,
					new_no: n++,
				};
				oldLeft--;
				newLeft--;
			} else if (c === "-") {
				if (oldLeft === 0) return bad("unparseable_diff");
				last = {
					kind: "removed",
					at: i,
					text: l.slice(1),
					old_no: o++,
					new_no: null,
				};
				oldLeft--;
			} else if (c === "+") {
				if (newLeft === 0) return bad("unparseable_diff");
				last = {
					kind: "added",
					at: i,
					text: l.slice(1),
					old_no: null,
					new_no: n++,
				};
				newLeft--;
			} else return bad("unparseable_diff");
			h.lines.push(last);
			i++;
		}
		if (oldLeft > 0 || newLeft > 0) return bad("unparseable_diff");
		f.hunks.push(h);
	}
	if (f.hunks.length > 0 && modes.some((m) => SPECIAL_MODES.has(m)))
		return bad("special_file");
	return f;
}

/** Parse `git diff` output. Never throws; problems are reported per file / as `preamble`. */
export function parseGitDiff(
	text: string,
	o: { truncated?: boolean } = {},
): ParsedDiff {
	const lines = text.split("\n");
	let trailing = false;
	if (lines[lines.length - 1] === "") {
		lines.pop();
		trailing = text.length > 0;
	}
	const starts: number[] = [];
	lines.forEach((l, i) => {
		if (l.startsWith("diff --git ")) starts.push(i);
	});
	const firstStart = starts[0] ?? lines.length;
	let preamble = false;
	for (let i = 0; i < firstStart; i++)
		if ((lines[i] as string).length > 0) preamble = true;
	const files = starts.map((s, k) =>
		parseFile(lines, s, starts[k + 1] ?? lines.length, k),
	);
	const truncated = o.truncated === true;
	const lastFile = files[files.length - 1];
	if (truncated && lastFile) lastFile.problem = "diff_truncated";
	return { lines, trailing_newline: trailing, preamble, truncated, files };
}

/** The files of a diff, for a context loader (old/new paths and whether content is shown). */
export function listDiffFiles(
	text: string,
	o: { truncated?: boolean } = {},
): DiffFileRef[] {
	return parseGitDiff(text, o).files.map((f) => ({
		index: f.index,
		old_path: f.old_path,
		new_path: f.new_path,
		needs_context: f.problem === null && f.hunks.length > 0,
	}));
}
