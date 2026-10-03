// Field-level rules shared by every workspace-m1 contract (web-safe). Schemas used for HASHED
// structures are validate-only: no .trim()/.default()/.transform(), so `Schema.parse(x)` is
// canonically identical to `x` and hashing the parsed value hashes exactly what was given.
import { z } from "zod";

export const Sha = z.string().regex(/^[0-9a-f]{40}$/, "40-hex commit sha");
export type Sha = z.infer<typeof Sha>;

export const Hash = z.string().regex(/^[0-9a-f]{64}$/, "sha256 hex");
export type Hash = z.infer<typeof Hash>;

/** Row timestamps: ISO-8601 UTC ending in `Z` (the hub normalizes to …Z). Never hashed. */
export const UtcTs = z.iso.datetime();
export type UtcTs = z.infer<typeof UtcTs>;

/**
 * A timestamp that IS part of a hash preimage (only the challenge's expires_at): exactly the
 * `Date.prototype.toISOString()` form, so no normalization can silently change a hash.
 */
export const HashedTs = z
	.string()
	.regex(
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
		"YYYY-MM-DDTHH:mm:ss.sssZ",
	)
	.refine((s) => {
		const t = Date.parse(s);
		return Number.isFinite(t) && new Date(t).toISOString() === s;
	}, "not a real UTC instant");
export type HashedTs = z.infer<typeof HashedTs>;

export const Rev = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const LONE_SURROGATE =
	/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** Any C0 control (U+0000–U+001F) or DEL, except the code units listed in `allowed`. */
function hasControl(s: string, allowed: readonly number[]): boolean {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if ((c < 0x20 || c === 0x7f) && !allowed.includes(c)) return true;
	}
	return false;
}

export const isWellFormed = (s: string): boolean => !LONE_SURROGATE.test(s);
/** No C0 controls and no DEL. */
export const isSingleLine = (s: string): boolean => !hasControl(s, []);
/** Multi-line text: `\t` and `\n` allowed, every other control (including `\r`) is not. */
export const isMultiLineSafe = (s: string): boolean =>
	!hasControl(s, [0x09, 0x0a]);
const isTrimmed = (s: string): boolean => s === s.trim();

/** Free text field while drafting: may be empty / untrimmed, bounded, no controls. */
export const draftLine = (max: number) =>
	z
		.string()
		.max(max)
		.refine(isWellFormed, "lone surrogate")
		.refine(isSingleLine, "control characters are not allowed");

/** Multi-line draft text: `\r\n` is tolerated here (a pasted Windows line end) and becomes `\n`. */
export const draftText = (max: number) =>
	z
		.string()
		.max(max)
		.refine(isWellFormed, "lone surrogate")
		.refine(
			(s) => isMultiLineSafe(s.replace(/\r\n/g, "\n")),
			"control characters are not allowed",
		);

/** Frozen single-line text: trimmed, non-empty, bounded (length = UTF-16 code units). */
export const frozenLine = (max: number) =>
	z
		.string()
		.min(1)
		.max(max)
		.refine(isWellFormed, "lone surrogate")
		.refine(isSingleLine, "control characters are not allowed")
		.refine(isTrimmed, "must be trimmed");

/** Frozen multi-line text: trimmed, non-empty, `\n`/`\t` allowed, never `\r`. */
export const frozenText = (max: number) =>
	z
		.string()
		.min(1)
		.max(max)
		.refine(isWellFormed, "lone surrogate")
		.refine(isMultiLineSafe, "control characters are not allowed")
		.refine(isTrimmed, "must be trimmed");

/**
 * Relative path prefix — the same rule as managed.ts `ScopePath` (not exported there; an
 * equivalence test pins it): no leading `/`, no `..`, no empty segment, no backslash/controls.
 * `.` = whole repository.
 */
export const ScopePath = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[A-Za-z0-9._@+][A-Za-z0-9._@+/ -]*$/, "relative path prefix")
	.refine(
		(p) => !p.split("/").some((seg) => seg === ".." || seg === ""),
		"no empty or `..` segments",
	);
export type ScopePath = z.infer<typeof ScopePath>;

/** `owner/name` or `local/<dir>` — same rule as the managed config's repo id. */
export const RepoId = z
	.string()
	.min(3)
	.max(200)
	.regex(/^[^/\s]+\/[^/\s]+$/, "owner/name or local/<dir>")
	.refine(isWellFormed, "lone surrogate")
	.refine(isSingleLine, "control characters are not allowed");
export type RepoId = z.infer<typeof RepoId>;

/** Same rule as the managed config's base_ref. */
export const BaseRef = z
	.string()
	.regex(/^[A-Za-z0-9._/-]{1,200}$/)
	.refine((r) => !r.startsWith("-") && !r.includes(".."), "unsafe ref");
export type BaseRef = z.infer<typeof BaseRef>;

/** A verification check profile id = a `verification[].name` in the trusted managed config. */
export const CheckId = z.string().regex(/^[A-Za-z0-9._-]{1,40}$/, "check id");
export type CheckId = z.infer<typeof CheckId>;

/** True when `inner` is the same path as, or lies under, prefix `outer` (`.` covers everything). */
export function pathWithin(inner: string, outer: string): boolean {
	return outer === "." || inner === outer || inner.startsWith(`${outer}/`);
}

export const hasDuplicates = (xs: readonly string[]): boolean =>
	new Set(xs).size !== xs.length;

/** Strictly ascending by UTF-16 code units (sorted and unique). */
export const isStrictlySorted = (xs: readonly string[]): boolean =>
	xs.every((x, i) => i === 0 || (xs[i - 1] as string) < x);
