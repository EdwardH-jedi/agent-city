// Pure guards shared by the support-job domain and the executor contract. No I/O.
import { clip, isSecretName, redact, SCAN_PATTERNS } from "@agent-city/schema";
import type { z } from "zod";

/** Bounds for the authority scan over untrusted executor output (cycles end at the depth cap). */
export const MAX_SCAN_DEPTH = 8;
export const MAX_SCAN_NODES = 5000;

/** Bound for any failure / validation detail string kept on a job. */
export const DETAIL_MAX = 500;

const normalizeKey = (key: string): string =>
	key.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Keys (normalized: lowercase, alphanumerics only) that would claim authority a support job never
 * has: running things, writing files, moving Git, publishing, approving, steering workflow state.
 * Support artifacts are informational text only, so none of their legitimate keys is listed here.
 */
const AUTHORITY_KEYS: ReadonlySet<string> = new Set([
	"accept",
	"accepted",
	"acceptance",
	"action",
	"actions",
	"approval",
	"approve",
	"approved",
	"args",
	"argv",
	"branch",
	"callback",
	"callbacks",
	"checkout",
	"cmd",
	"command",
	"commands",
	"commit",
	"createissue",
	"createpr",
	"cwd",
	"delete",
	"deploy",
	"endpoint",
	"env",
	"environment",
	"exec",
	"execute",
	"file",
	"files",
	"functioncall",
	"gitpush",
	"hook",
	"hooks",
	"merge",
	"mutate",
	"mutation",
	"nextstate",
	"openpr",
	"path",
	"paths",
	"publish",
	"pullrequest",
	"push",
	"rebase",
	"reject",
	"release",
	"remove",
	"reset",
	"run",
	"script",
	"setstatus",
	"shell",
	"spawn",
	"state",
	"status",
	"sudo",
	"toolcall",
	"toolcalls",
	"transition",
	"url",
	"verdict",
	"webhook",
	"worktree",
	"write",
	"writepath",
]);

/** Substrings that mark an authority key even inside a longer name (`run_command`, `git_push_ref`). */
const AUTHORITY_KEY_PARTS: readonly string[] = [
	"approv",
	"argv",
	"callback",
	"command",
	"deploy",
	"exec",
	"merge",
	"publish",
	"push",
	"shell",
	"transition",
	"webhook",
	"writepath",
];

export type AuthorityKeyMatch = "authority" | "credential" | null;

/** Does an object key claim authority (or carry a credential)? */
export function classifyAuthorityKey(key: string): AuthorityKeyMatch {
	const n = normalizeKey(key);
	if (AUTHORITY_KEYS.has(n) || AUTHORITY_KEY_PARTS.some((p) => n.includes(p)))
		return "authority";
	if (isSecretName(key)) return "credential";
	return null;
}

export type ScanResult =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly reason:
				| "forbidden_key"
				| "too_deep"
				| "too_large"
				| "unreadable";
			readonly detail: string;
	  };

/**
 * Bounded walk over every own enumerable key of an untrusted value. Never throws: a throwing
 * Proxy trap or getter is reported as `unreadable`. Key names are only echoed when they are one
 * of the fixed authority words above — an arbitrary key could itself be a secret.
 */
export function scanForAuthorityKeys(value: unknown): ScanResult {
	let nodes = 0;
	const walk = (v: unknown, depth: number): ScanResult => {
		if (v === null || typeof v !== "object") return { ok: true };
		nodes += 1;
		if (nodes > MAX_SCAN_NODES)
			return { ok: false, reason: "too_large", detail: "output too large" };
		if (depth > MAX_SCAN_DEPTH)
			return {
				ok: false,
				reason: "too_deep",
				detail: "output nested too deep",
			};
		const keys = Object.keys(v);
		for (const key of keys) {
			const match = classifyAuthorityKey(key);
			if (match === "authority")
				return {
					ok: false,
					reason: "forbidden_key",
					detail: `authority key '${normalizeKey(key)}'`,
				};
			if (match === "credential")
				return {
					ok: false,
					reason: "forbidden_key",
					detail: "credential-like key",
				};
			const child = walk((v as Record<string, unknown>)[key], depth + 1);
			if (!child.ok) return child;
		}
		return { ok: true };
	};
	try {
		return walk(value, 0);
	} catch {
		return { ok: false, reason: "unreadable", detail: "output not readable" };
	}
}

/** Does free text contain a credential (same patterns as redaction and check:secrets)? */
export function containsSecret(text: string): boolean {
	return SCAN_PATTERNS.some((p) => p.re.test(text));
}

/** Every string inside a plain (already validated) value, depth-first. */
export function collectStrings(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
	else if (value !== null && typeof value === "object")
		for (const v of Object.values(value)) collectStrings(v, out);
	return out;
}

/**
 * Run `fn`; anything it throws (a hostile getter or Proxy trap inside untrusted input) becomes
 * `fallback`. The thrown value is never inspected, logged or returned.
 */
export function guarded<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

/** The single issue reported for an input whose properties cannot be read. */
export const UNREADABLE_ISSUE = "(root):unreadable";

export type GuardedParse<T> =
	| { readonly ok: true; readonly data: T }
	| { readonly ok: false; readonly issues: readonly string[] };

/**
 * `schema.safeParse` that never throws. On success `data` is zod's own plain copy (every property
 * read once), so callers keep using one snapshot; a throwing getter / Proxy trap yields
 * UNREADABLE_ISSUE, and validation issues are reported via formatIssues (no echoed input).
 */
export function parseGuarded<S extends z.ZodType>(
	schema: S,
	value: unknown,
): GuardedParse<z.output<S>> {
	return guarded<GuardedParse<z.output<S>>>(
		() => {
			const r = schema.safeParse(value);
			return r.success
				? { ok: true, data: r.data }
				: { ok: false, issues: formatIssues(r.error.issues) };
		},
		{ ok: false, issues: [UNREADABLE_ISSUE] },
	);
}

/** Recursively freeze a plain value in place and return it. */
export function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const v of Object.values(value)) deepFreeze(v);
		Object.freeze(value);
	}
	return value;
}

/** Bounded, redacted single-line detail. */
export function safeDetail(text: string): string {
	return clip(redact(text.replace(/\s+/g, " ").trim()), DETAIL_MAX);
}

/**
 * Validation issues as `path:code` — never zod's message for structural codes, because messages
 * such as "Unrecognized key: …" echo untrusted input. Custom issues carry our own fixed messages.
 */
export function formatIssues(issues: readonly z.core.$ZodIssue[]): string[] {
	return issues.slice(0, 20).map((issue) => {
		const path = issue.path.map((p) => String(p)).join(".") || "(root)";
		const base = `${path}:${issue.code}`;
		return safeDetail(
			issue.code === "custom" ? `${base}:${issue.message}` : base,
		);
	});
}
