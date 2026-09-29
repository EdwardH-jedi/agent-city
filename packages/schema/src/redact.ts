// Secret redaction applied by collectors BEFORE anything is spooled, sent, or logged, and again by
// the hub before storing. Detection rules live in secret-patterns.ts (shared with check-secrets).
//
// Linear-time by construction: every input is capped at INPUT_MAX before any regex runs, and every
// quantifier is bounded, so no input can make redaction slow (audit F01: 100K-char commands used to
// hit an O(n²) path in ASSIGNMENT).
import { isSecretName, TOKEN_PATTERNS } from "./secret-patterns.ts";

export const REDACTED = "[REDACTED]";
export const COMMAND_MAX = 80;
/** No regex ever sees more than this many characters of one string. */
export const INPUT_MAX = 4096;

const TOKENS = TOKEN_PATTERNS.map(
	({ re }) => new RegExp(re.source, `${re.flags.replace("g", "")}g`),
);

// scheme://user:pass@host → keep user, mask pass. `user@host` (no password) is left alone: a bare
// username isn't a secret, and self-identifying tokens used as usernames are caught by TOKENS.
const URL_USERINFO =
	/\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/]{1,256}):([^\s@/]{1,512})@/gi;

// Authorization: <scheme> <credential> (header, curl -H, JSON incl. escaped JSON). Next token only.
const AUTH_HEADER =
	/\b((?:proxy-)?authorization)(\\?["']?\s*[:=]\s*\\?["']?)(bearer|basic|token)\s+[^\s"'\\,;]{1,2048}/gi;
// Digest credentials are `k="v", k="v"…` with embedded quotes → mask to end of line.
const AUTH_DIGEST =
	/\b((?:proxy-)?authorization)(\\?["']?\s*[:=]\s*\\?["']?)(digest)\s+[^\r\n]{1,4096}/gi;
// A bare "Bearer x" / "Basic x" outside a header (e.g. an env value or a log line).
const BARE_SCHEME = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/-]{1,2048}=*)/gi;

// Value forms shared by `--flag value` and `NAME=value`, tried in this order:
//   already masked (only when the WHOLE token is [REDACTED])
//   "<scheme> <credential>" as one unit (a scheme word can't shield the credential behind it)
//   escaped-JSON \"…\"   "…"   '…'   bare
const V_MASKED = String.raw`\[REDACTED\](?![^\s"',;&|}])`;
const V_SCHEME = String.raw`(?:bearer|basic|token|digest)\s+[^\s"'\\,;]{1,2048}`;
const V_ESC_DQ = String.raw`\\"(?:(?!\\")[^\n]){0,2048}\\"`;
const V_DQ = String.raw`"(?:[^"\\\n]|\\.){0,2048}"`;
const V_SQ = String.raw`'(?:[^'\\\n]|\\.){0,2048}'`;
const NAME = "[A-Za-z_][A-Za-z0-9_.-]{0,63}";

// --flag value / --flag=value where the flag name is secret. Single-dash flags (-p) are skipped:
// too many false positives (-p port, -p parents…).
const LONG_FLAG = new RegExp(
	String.raw`(^|\s)(--[A-Za-z0-9][A-Za-z0-9_-]{0,63})(=|\s+)(${V_MASKED}|${V_SCHEME}|${V_ESC_DQ}|${V_DQ}|${V_SQ}|(?!-)[^\s"';&|]{1,512})`,
	"gi",
);

// NAME=value, NAME: value, "name":"value", \"name\":\"value\", 'name': 'value'.
const ASSIGNMENT = new RegExp(
	String.raw`(\\?["']?)(${NAME})\1(\s*[=:]\s*)(${V_MASKED}|${V_SCHEME}|${V_ESC_DQ}|${V_DQ}|${V_SQ}|[^\s"',;&|}]{1,512})`,
	"gi",
);

// YAML block scalar:  token: |  (or >, |-, >+ …) followed by indented lines.
const YAML_BLOCK = new RegExp(
	String.raw`(${NAME})([ \t]*:[ \t]*[|>][-+0-9]{0,2}[ \t]*\r?\n)((?:[ \t]+[^\n]{0,4096}(?:\n|$)){1,200})`,
	"g",
);

const MASKED_WHOLE = /^(?:(?:bearer|basic|token|digest) )?\[REDACTED\]$/i;

/** Mask a value, keeping surrounding quotes. null = nothing to mask (empty or already fully masked). */
function maskValue(value: string): string | null {
	let q = "";
	if (value.length >= 4 && value.startsWith('\\"') && value.endsWith('\\"'))
		q = '\\"';
	else if (
		value.length >= 2 &&
		(value[0] === '"' || value[0] === "'") &&
		value.endsWith(value[0])
	)
		q = value[0];
	const inner = q ? value.slice(q.length, -q.length) : value;
	// Judged on the whole value: "[REDACTED]secret" is NOT masked.
	if (inner.length === 0 || MASKED_WHOLE.test(inner)) return null;
	return `${q}${REDACTED}${q}`;
}

/**
 * First `max` chars. When the input is longer, a trailing word fragment is dropped too, so a secret
 * straddling the cut can't leave an unrecognisable (and unmasked) head behind.
 */
export function clip(input: string, max = INPUT_MAX): string {
	if (input.length <= max) return input;
	const head = input.slice(0, max);
	const frag = /[^\s"'=:,;]{1,256}$/.exec(head);
	return `${frag ? head.slice(0, frag.index) : head}…`;
}

/**
 * Mask secrets in free text: known token formats, Authorization credentials, URL passwords,
 * secret-named `--flags`, `NAME=value` / `"name": "value"` / escaped-JSON assignments and YAML
 * block scalars. Input is clipped to INPUT_MAX first. Idempotent on inputs ≤ INPUT_MAX.
 */
export function redact(input: string): string {
	let out = clip(input);
	for (const re of TOKENS) out = out.replace(re, REDACTED);
	out = out.replace(URL_USERINFO, `$1:${REDACTED}@`);
	out = out.replace(AUTH_HEADER, `$1$2$3 ${REDACTED}`);
	out = out.replace(AUTH_DIGEST, `$1$2$3 ${REDACTED}`);
	out = out.replace(BARE_SCHEME, `$1 ${REDACTED}`);
	out = out.replace(
		YAML_BLOCK,
		(m, name: string, head: string, block: string) => {
			if (!isSecretName(name)) return m;
			const indent = /^[ \t]+/.exec(block)?.[0] ?? "  ";
			return `${name}${head}${indent}${REDACTED}${block.endsWith("\n") ? "\n" : ""}`;
		},
	);
	out = out.replace(
		LONG_FLAG,
		(m, lead: string, flag: string, sep: string, value: string) => {
			if (!isSecretName(flag)) return m;
			const masked = maskValue(value);
			return masked === null ? m : `${lead}${flag}${sep}${masked}`;
		},
	);
	out = out.replace(
		ASSIGNMENT,
		(m, q: string, name: string, sep: string, value: string) => {
			if (!isSecretName(name)) return m;
			const masked = maskValue(value);
			return masked === null ? m : `${q}${name}${q}${sep}${masked}`;
		},
	);
	return out;
}

/**
 * Deep-redact: keys with a secret-looking name (same rule as `NAME=value`) have their whole value
 * replaced — including objects/arrays; every other string is run through redact().
 */
export function redactObject<T>(value: T): T {
	return walk(value, 0) as T;
}

function walk(value: unknown, depth: number): unknown {
	if (depth > 20) return REDACTED;
	if (typeof value === "string") return redact(value);
	if (Array.isArray(value))
		return value.slice(0, 200).map((v) => walk(v, depth + 1));
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value).slice(0, 200)) {
			const key = clip(k, 128);
			out[key] = isSecretName(key) ? REDACTED : walk(v, depth + 1);
		}
		return out;
	}
	return value;
}

export interface ToolInputSummary {
	tool: string;
	file_path?: string;
	command?: string;
}

const PATH_KEYS = ["file_path", "path", "notebook_path"] as const;

/**
 * Whitelist view of a tool call: tool name, a file path if present, and the first 80 chars of a
 * shell command. Order (F01): cap 4KB → redact → cut 80 → redact. Nothing else from tool_input is
 * kept — never store tool_input raw.
 */
export function summarizeToolInput(
	tool: string,
	input: unknown,
): ToolInputSummary {
	const summary: ToolInputSummary = { tool: redact(clip(tool, 256)) };
	if (input === null || typeof input !== "object") return summary;
	const rec = input as Record<string, unknown>;

	for (const key of PATH_KEYS) {
		const v = rec[key];
		if (typeof v === "string" && v.length > 0) {
			summary.file_path = redact(clip(v, 1024));
			break;
		}
	}
	if (typeof rec.command === "string") {
		summary.command = redact(redact(clip(rec.command)).slice(0, COMMAND_MAX));
	}
	return summary;
}
