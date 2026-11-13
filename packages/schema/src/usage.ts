// Token usage (M1, 18 §5.1). zod-free: the collector's resident poller and the hub share it.
//
// The unit is one row per (session_id, day, model): the session's cumulative token counts for that
// Australia/Sydney day and model. Only numbers and identifiers travel — never text, commands or paths.
// A collector re-sends the same cumulative values whenever it likes; the hub keeps the larger value
// per column, so a repeat changes nothing.
import { redact } from "./redact.ts";

/** Days are calendar days in this zone (the owner's), whatever the machine's own zone is. */
export const USAGE_TZ = "Australia/Sydney";

/** POST /ingest/usage body cap: 500 rows of ~250 bytes plus limits fit well inside it. */
export const USAGE_MAX_BODY_BYTES = 256 * 1024;
/** Rows in one POST /ingest/usage. Collectors send in chunks of at most this many. */
export const USAGE_MAX_ROWS = 500;
/** Limit snapshots in one POST /ingest/usage. */
export const USAGE_MAX_LIMITS = 16;
/** `GET /api/usage?days=N`: N is 1..this (default 7). */
export const USAGE_MAX_DAYS = 31;
/** One message can't plausibly use more; anything above is clamped (keeps sums finite and exact). */
export const USAGE_TOKENS_MAX = 1e12;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Model names, limit ids and plan types: a tight charset, else they are not sent as-is. */
const LABEL = /^[A-Za-z0-9._:[\]-]{1,64}$/;

let fmt: Intl.DateTimeFormat | null = null;

/** `YYYY-MM-DD` of an instant in USAGE_TZ, or null when the input is not a valid time. */
export function usageDay(when: string | number | Date): string | null {
	const ms =
		typeof when === "number"
			? when
			: when instanceof Date
				? when.getTime()
				: Date.parse(when);
	if (!Number.isFinite(ms)) return null;
	fmt ??= new Intl.DateTimeFormat("en-CA", {
		timeZone: USAGE_TZ,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	const out = fmt.format(new Date(ms));
	return DAY.test(out) ? out : null;
}

/** `day` minus `n` calendar days (both `YYYY-MM-DD`; pure date arithmetic, no zone). */
export function dayMinus(day: string, n: number): string {
	const t = Date.parse(`${day}T00:00:00Z`) - n * 86_400_000;
	return new Date(t).toISOString().slice(0, 10);
}

/**
 * A model / limit id / plan type that may be stored and shown: unchanged when it fits the charset and
 * holds nothing secret-shaped (a token pasted where a model name goes still fits the charset), else null.
 */
export function usageLabel(v: unknown): string | null {
	return typeof v === "string" && LABEL.test(v) && redact(v) === v ? v : null;
}

/** A token count from a transcript: a finite non-negative integer, clamped; anything else → 0. */
export function tokenCount(v: unknown): number {
	if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return 0;
	return Math.min(Math.floor(v), USAGE_TOKENS_MAX);
}

export const USAGE_LABEL_RE = LABEL;
export const USAGE_DAY_RE = DAY;
