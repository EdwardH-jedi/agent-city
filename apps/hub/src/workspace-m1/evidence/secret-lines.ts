// Conservative secret-line detection over ONE complete file version. Pure and non-executing: no
// YAML/JSON library is run, nothing is evaluated, every loop is bounded by the input and a step
// budget. The question answered is "which lines must not be shown?", so the rules over-mask on
// purpose (a secret-named key in TypeScript masks that line too) and only structures that cannot be
// delimited (an unterminated quote/bracket/heredoc/element under a secret key) make the version
// uninterpretable — the caller then withholds instead of masking.
//
// Shared rules are imported, never forked: `isSecretName`, `redact` (assignments, URL passwords,
// auth headers, token formats) and `SCAN_PATTERNS` all come from @agent-city/schema.
import {
	INPUT_MAX,
	isSecretName,
	REDACTED,
	redact,
	SCAN_PATTERNS,
} from "@agent-city/schema";

export type UninterpretableReason =
	| "unterminated_quote"
	| "unterminated_flow"
	| "unterminated_heredoc"
	| "scan_budget";

export interface SecretLineScan {
	/** 0-based indices of lines whose content must not be disclosed. */
	lines: Set<number>;
	/** Set when a secret-bearing structure cannot be delimited: withhold the whole version. */
	uninterpretable: UninterpretableReason | null;
}

class Uninterpretable extends Error {
	constructor(readonly reason: UninterpretableReason) {
		super(reason);
	}
}

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/i;
const PEM_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/i;
const CONTINUED = /\\[ \t]*$/;
/** `key:` / `key=` / `"key":` / `'key' =>` … anywhere in a line (the key must start a word). */
const KEY_RE =
	/(?<![A-Za-z0-9_$@.-])(?:"([^"\\\n]{1,128})"|'([^'\\\n]{1,128})'|([A-Za-z_$@][A-Za-z0-9_.$@-]{0,127}))[ \t]*(=>|:|[?+:]?=(?![=~]))/g;
/** Dockerfile `ENV NAME value` / `ARG NAME value` (no `=`). */
const DOCKER_ENV =
	/^[ \t]*(?:ENV|ARG)[ \t]+([A-Za-z_][A-Za-z0-9_]{0,127})[ \t]+\S/i;
/** An element opened at the start of a line: `<password>`, `<auth-config attr="x">`. */
const ELEMENT_OPEN =
	/^[ \t]*<([A-Za-z_][A-Za-z0-9_.:-]{0,63})(?:[ \t][^<>]{0,512})?>/;
const BLOCK_SCALAR = /^[|>][-+1-9]{0,2}[ \t]*(?:#.*)?$/;
const HEREDOC = /<<[-~]?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]{0,63})\1/;
const POINTER_VALUE =
	/^(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,127})\1[ \t]*,?[ \t]*$/;
/** Keys whose value NAMES a sibling (`- name: DB_PASSWORD` + `value: …`): normalized form. */
const POINTER_KEYS: ReadonlySet<string> = new Set([
	"name",
	"key",
	"id",
	"env",
	"var",
	"variable",
	"param",
	"parameter",
	"field",
	"property",
	"setting",
	"option",
	"label",
]);
const SCAN = SCAN_PATTERNS.map((p) => p.re);

const stripCr = (l: string) => (l.endsWith("\r") ? l.slice(0, -1) : l);
const isBlank = (l: string) => l.trim() === "";

/** Key-line indentation: a TAB counts 1 (smallest plausible → everything deeper is masked). */
function keyIndent(l: string): number {
	return /^[ \t]*/.exec(l)?.[0].length ?? 0;
}

/** Candidate-line indentation: a TAB counts 8 (largest plausible → biased toward masking). */
function candIndent(l: string): number {
	let w = 0;
	for (const c of l) {
		if (c === " ") w++;
		else if (c === "\t") w += 8;
		else break;
	}
	return w;
}

function sensitiveText(t: string): boolean {
	if (t.length > INPUT_MAX) return true;
	if (redact(t) !== t) return true;
	return SCAN.some((re) => re.test(t));
}

/**
 * Which lines of one complete file version (split on "\n"; a trailing "\r" is ignored) carry or
 * belong to a secret. Deterministic; never throws.
 */
export function scanSecretLines(raw: readonly string[]): SecretLineScan {
	const lines = raw.map(stripCr);
	const n = lines.length;
	const marked = new Set<number>();
	const mark = (a: number, b: number) => {
		for (let k = Math.max(0, a); k <= b && k < n; k++) marked.add(k);
	};
	// indentation precomputed once (walks must not rescan it); the budget counts content characters,
	// so deep indentation cannot buy a quadratic walk more steps
	const kInd = lines.map(keyIndent);
	const cInd = lines.map(candIndent);
	const blank = lines.map(isBlank);
	let chars = 0;
	for (let k = 0; k < n; k++)
		chars += (lines[k] as string).length - (kInd[k] as number);
	let budget = 100_000 + 64 * n + 4 * chars;
	const spend = (k = 1) => {
		budget -= k;
		if (budget < 0) throw new Uninterpretable("scan_budget");
	};

	const nextNonBlank = (from: number): number => {
		for (let k = from; k < n; k++) {
			spend();
			if (!blank[k]) return k;
		}
		return -1;
	};

	/** Following lines indented deeper than `indent` (blank lines in between included). */
	const deeper = (from: number, indent: number): number => {
		let last = from;
		for (let k = nextNonBlank(from + 1); k !== -1; k = nextNonBlank(k + 1)) {
			if ((cInd[k] as number) <= indent) break;
			last = k;
		}
		return last;
	};

	/**
	 * Value on following lines: deeper lines; for an EMPTY value (`markNext`) also a same-indent
	 * `- ` sequence and, whatever it is, the next non-blank line.
	 */
	const block = (i: number, indent: number, markNext: boolean): number => {
		const seq = (k: number) =>
			markNext &&
			(cInd[k] as number) >= indent &&
			/^-(?:[ \t]|$)/.test((lines[k] as string).trimStart());
		const first = nextNonBlank(i + 1);
		if (first === -1) return i;
		if (!((cInd[first] as number) > indent || seq(first)))
			return markNext ? first : i;
		let last = i;
		for (let k = first; k !== -1; k = nextNonBlank(k + 1)) {
			if (!((cInd[k] as number) > indent || seq(k))) break;
			last = k;
		}
		return last;
	};

	/** End of a quoted value opened at (i, p) — may span lines. */
	const quoted = (
		i: number,
		p: number,
		q: string,
	): { line: number; col: number } => {
		const escapes = q !== "'";
		let col = p + 1;
		for (let k = i; k < n; k++, col = 0) {
			const l = lines[k] as string;
			spend(l.length - col + 1);
			for (let c = col; c < l.length; c++) {
				const ch = l[c];
				if (escapes && ch === "\\") {
					c++;
					continue;
				}
				if (ch === q) {
					if (q === "'" && l[c + 1] === "'") {
						c++;
						continue;
					}
					return { line: k, col: c + 1 };
				}
			}
		}
		throw new Uninterpretable("unterminated_quote");
	};

	const triple = (i: number, p: number, d: string): number => {
		let col = p + 3;
		for (let k = i; k < n; k++, col = 0) {
			const l = lines[k] as string;
			spend(l.length + 1);
			if (l.indexOf(d, col) !== -1) return k;
		}
		throw new Uninterpretable("unterminated_quote");
	};

	/** End of a flow collection / object opened at (i, p), skipping quoted strings. */
	const flow = (i: number, p: number): number => {
		let depth = 0;
		let k = i;
		let c = p;
		while (k < n) {
			const l = lines[k] as string;
			if (c >= l.length) {
				k++;
				c = 0;
				spend();
				continue;
			}
			spend();
			const ch = l[c] as string;
			if (ch === '"' || ch === "'" || ch === "`") {
				const end = quoted(k, c, ch);
				k = end.line;
				c = end.col;
				continue;
			}
			if (ch === "{" || ch === "[") depth++;
			else if (ch === "}" || ch === "]") {
				depth--;
				if (depth === 0) return k;
			}
			c++;
		}
		throw new Uninterpretable("unterminated_flow");
	};

	const heredoc = (i: number, delim: string): number => {
		for (let k = i + 1; k < n; k++) {
			spend();
			if ((lines[k] as string).trim() === delim) return k;
		}
		throw new Uninterpretable("unterminated_heredoc");
	};

	const anchorsDone = new Set<string>();
	/** `&name` definitions referenced by a secret key's `*name` alias: mask their values too. */
	const anchors = (name: string) => {
		if (anchorsDone.has(name)) return;
		anchorsDone.add(name);
		const tok = `&${name}`;
		for (let k = 0; k < n; k++) {
			const l = lines[k] as string;
			spend();
			for (let at = l.indexOf(tok); at !== -1; at = l.indexOf(tok, at + 1)) {
				const after = l[at + tok.length];
				if (after !== undefined && !/[ \t,\]}]/.test(after)) continue;
				mark(k, extent(k, at + tok.length, kInd[k] as number));
			}
		}
	};

	/** Last line of the value that starts at column `p` of line `i` (key line indent `ind`). */
	const extent = (i: number, p: number, ind: number): number => {
		const l = lines[i] as string;
		let c = p;
		while (c < l.length && (l[c] === " " || l[c] === "\t")) c++;
		for (let t = 0; t < 3; t++) {
			const m = /^[!&][^\s,[\]{}]*[ \t]*/.exec(l.slice(c));
			if (!m || m[0].length === 0) break;
			c += m[0].length;
		}
		const r = l.slice(c);
		if (r === "" || r.startsWith("#")) return block(i, ind, true);
		if (r.startsWith("*")) {
			const a = /^\*([^\s,[\]{}]{1,128})/.exec(r);
			if (a) anchors(a[1] as string);
			return deeper(i, ind);
		}
		if (BLOCK_SCALAR.test(r)) return block(i, ind, false);
		let end = i;
		if (r.startsWith('"""') || r.startsWith("'''"))
			end = triple(i, c, r.slice(0, 3));
		else if (r[0] === '"' || r[0] === "'" || r[0] === "`")
			end = quoted(i, c, r[0]).line;
		else if (r[0] === "{" || r[0] === "[") end = flow(i, c);
		else {
			const h = HEREDOC.exec(r);
			if (h) end = heredoc(i, h[2] as string);
		}
		// whatever follows deeper-indented (plain multi-line scalars, `"a" +` continuations, …)
		return deeper(end, ind);
	};

	/**
	 * The mapping that contains a key at column `col` of line `i` (both directions). At column 0 the
	 * "mapping" is the whole document, so only the neighbouring lines are taken.
	 */
	const enclosing = (i: number, col: number) => {
		if (col === 0) {
			let prev = i;
			for (let k = i - 1; k >= 0; k--) {
				spend();
				if (!blank[k]) {
					prev = k;
					break;
				}
			}
			const next = nextNonBlank(i + 1);
			mark(prev, next === -1 ? i : next);
			return;
		}
		let first = i;
		const item = /^[ \t]*-[ \t]+/.exec(lines[i] as string);
		if (!(item && item[0].length === col)) {
			for (let k = i - 1; k >= 0; k--) {
				spend();
				if (blank[k]) continue;
				const it = /^[ \t]*-[ \t]+/.exec(lines[k] as string);
				if (it && it[0].length === col) {
					first = k;
					break;
				}
				if ((cInd[k] as number) < col) break;
				first = k;
			}
		}
		let last = i;
		for (let k = nextNonBlank(i + 1); k !== -1; k = nextNonBlank(k + 1)) {
			if ((cInd[k] as number) < col) break;
			last = k;
		}
		mark(first, last);
	};

	/** `? key` (explicit YAML key — or a TS ternary line): the key, its `: value` and deeper lines. */
	const complexKey = (i: number) => {
		const ind = kInd[i] as number;
		let last = i;
		for (let k = nextNonBlank(i + 1); k !== -1; k = nextNonBlank(k + 1)) {
			const t = (lines[k] as string).trimStart();
			if (
				(cInd[k] as number) > ind ||
				(kInd[k] === ind && (t === ":" || t.startsWith(": ")))
			)
				last = k;
			else break;
		}
		mark(i, last);
	};

	try {
		// 1. line by line: shared redaction rules, scan patterns, over-long lines
		for (let i = 0; i < n; i++)
			if (sensitiveText(lines[i] as string)) marked.add(i);

		// 2. `\`-continued chains joined (as redactLog/maskVersion do); a chain beyond the join
		//    bounds is masked whole, so no token can straddle a chain boundary
		for (let i = 0; i < n; i++) {
			if (!CONTINUED.test(lines[i] as string)) continue;
			let j = i;
			let joined = lines[i] as string;
			while (
				CONTINUED.test(joined) &&
				j + 1 < n &&
				j - i < 20 &&
				joined.length < 8_000
			) {
				j++;
				spend();
				joined =
					joined.replace(CONTINUED, "") +
					(lines[j] as string).replace(/^[ \t]+/, "");
			}
			if (CONTINUED.test(joined) && j + 1 < n) {
				while (CONTINUED.test(lines[j] as string) && j + 1 < n) {
					j++;
					spend();
				}
				mark(i, j);
			} else if (sensitiveText(joined)) mark(i, j);
			i = j;
		}

		// 3. private-key blocks: BEGIN … END (or end of file); an orphan END masks back to a blank line
		for (let i = 0; i < n; i++) {
			const l = lines[i] as string;
			const b = PEM_BEGIN.exec(l);
			if (b) {
				let j = i;
				if (!PEM_END.test(l.slice(b.index + b[0].length)))
					for (j = i + 1; j < n && !PEM_END.test(lines[j] as string); j++)
						spend();
				mark(i, Math.min(j, n - 1));
				i = j;
			} else if (PEM_END.test(l)) {
				let k = i;
				while (k > 0 && !blank[k - 1]) k--;
				mark(k, i);
			}
		}

		// 4. structure: secret-named keys and what their values span; name/value pointers;
		//    elements; Dockerfile ENV; explicit YAML keys
		for (let i = 0; i < n; i++) {
			const l = lines[i] as string;
			spend();
			const trimmed = l.trimStart();
			if (trimmed === "?" || trimmed.startsWith("? ")) {
				const k = trimmed.slice(1).trim();
				if (k === "" || isSecretName(k) || sensitiveText(k)) complexKey(i);
			}
			const d = DOCKER_ENV.exec(l);
			if (d && isSecretName(d[1] as string))
				mark(i, deeper(i, kInd[i] as number));
			const el = ELEMENT_OPEN.exec(l);
			if (el && !l.includes("/>", el.index) && isSecretName(el[1] as string)) {
				// an element without its close tag (or JSX this rule misreads) masks to the end
				const close = `</${el[1]}>`;
				let j = n - 1;
				if (l.indexOf(close, el[0].length) !== -1) j = i;
				else
					for (let k = i + 1; k < n; k++) {
						spend();
						if ((lines[k] as string).includes(close)) {
							j = k;
							break;
						}
					}
				mark(i, j);
			}
			KEY_RE.lastIndex = 0;
			for (let m = KEY_RE.exec(l); m !== null; m = KEY_RE.exec(l)) {
				spend();
				const quotedKey = m[1] ?? m[2];
				const key = (quotedKey ?? m[3]) as string;
				if (m[4] === "=>" && quotedKey === undefined) continue;
				const ind = kInd[i] as number;
				const valueAt = m.index + m[0].length;
				if (isSecretName(key)) {
					mark(i, extent(i, valueAt, ind));
					continue;
				}
				if (!POINTER_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, "")))
					continue;
				const pv = POINTER_VALUE.exec(l.slice(valueAt).trim());
				if (pv && isSecretName(pv[2] as string)) enclosing(i, m.index);
			}
		}
	} catch (err) {
		if (err instanceof Uninterpretable)
			return { lines: marked, uninterpretable: err.reason };
		throw err;
	}
	return { lines: marked, uninterpretable: null };
}

/** How a masked line is shown: its indentation, the marker, and its original CR (if any). */
export function maskedLine(line: string): string {
	if (isBlank(line)) return line;
	const ws = /^[ \t]*/.exec(line)?.[0] ?? "";
	return `${ws}${REDACTED}${line.endsWith("\r") ? "\r" : ""}`;
}
