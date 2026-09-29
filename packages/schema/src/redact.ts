// Secret redaction applied by collectors BEFORE anything is spooled, sent, or logged.
// Detection rules live in secret-patterns.ts (shared with scripts/check-secrets.ts).
import { isSecretName, TOKEN_PATTERNS } from "./secret-patterns.ts";

export const REDACTED = "[REDACTED]";
export const COMMAND_MAX = 80;

const TOKENS = TOKEN_PATTERNS.map(({ re }) => new RegExp(re.source, "g"));

// scheme://user:pass@host → keep user, mask pass.
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):([^\s@/]+)@/gi;

// Authorization: <scheme> <credential> (header, curl -H, JSON). Credential = next token.
const AUTH_HEADER =
	/\b((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)(bearer|basic|token)\s+[^\s"',;]+/gi;
// Digest credentials are `k="v", k="v"…` with embedded quotes → mask to end of line.
const AUTH_DIGEST =
	/\b((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)(digest)\s+[^\r\n]+/gi;
// A bare "Bearer x" / "Basic x" outside a header (e.g. an env value or a log line).
const BARE_SCHEME = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/-]+=*)/gi;

// --flag value / --flag=value where the flag name is secret. Single-dash flags (-p) are skipped:
// too many false positives (-p port, -p parents…).
// Value alternatives shared by both: already masked | "<scheme> <credential>" as one unit (so a
// scheme word can't shield the credential behind it) | quoted | bare.
const LONG_FLAG =
	/(^|\s)(--[A-Za-z0-9][A-Za-z0-9_-]*)(=|\s+)(\[REDACTED\]|(?:bearer|basic|token|digest)\s+[^\s"',;]+|"[^"]*"|'[^']*'|(?!-)[^\s"';&|]+)/gi;

// NAME=value, NAME: value, "name":"value", 'name': 'value' (env, YAML, JSON, Python dicts).
const ASSIGNMENT =
	/(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1(\s*[=:]\s*)(\[REDACTED\]|(?:bearer|basic|token|digest)\s+[^\s"',;]+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"',;&|}\]]+)/gi;

/** Mask a value, keeping surrounding quotes. Returns null when there is nothing to mask. */
function maskValue(value: string): string | null {
	const q = value[0] === '"' || value[0] === "'" ? value[0] : "";
	const inner = q ? value.slice(1, -1) : value;
	// Empty or already masked (incl. "Basic [REDACTED]" left by AUTH_HEADER) → nothing to do.
	if (inner.length === 0 || inner.includes(REDACTED)) return null;
	return `${q}${REDACTED}${q}`;
}

/**
 * Mask secrets in free text: known token formats, Authorization credentials, URL passwords,
 * secret-named `--flags`, and `NAME=value` / `"name": "value"` assignments. Idempotent.
 */
export function redact(input: string): string {
	let out = input;
	for (const re of TOKENS) out = out.replace(re, REDACTED);
	out = out.replace(URL_USERINFO, `$1:${REDACTED}@`);
	out = out.replace(AUTH_HEADER, `$1$2$3 ${REDACTED}`);
	out = out.replace(AUTH_DIGEST, `$1$2$3 ${REDACTED}`);
	out = out.replace(BARE_SCHEME, `$1 ${REDACTED}`);
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
	if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = isSecretName(k) ? REDACTED : walk(v, depth + 1);
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
 * shell command (redacted). Nothing else from tool_input is kept — never store tool_input raw.
 */
export function summarizeToolInput(
	tool: string,
	input: unknown,
): ToolInputSummary {
	const summary: ToolInputSummary = { tool };
	if (input === null || typeof input !== "object") return summary;
	const rec = input as Record<string, unknown>;

	for (const key of PATH_KEYS) {
		const v = rec[key];
		if (typeof v === "string" && v.length > 0) {
			summary.file_path = redact(v);
			break;
		}
	}
	if (typeof rec.command === "string") {
		// Redact before truncating so a secret straddling the cut can't leak its head, then again after.
		summary.command = redact(redact(rec.command).slice(0, COMMAND_MAX));
	}
	return summary;
}
