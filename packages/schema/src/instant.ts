// Exact ordering of ISO-8601 timestamps, shared by the hub (run report order) and the web merge.
// zod-free. `Date.parse` keeps only milliseconds, so two reports inside one millisecond would compare
// equal and an older one could replace a newer one; this compares whole seconds as instants (offsets
// applied) and then the fraction digit by digit, at any precision.

/** The shape `z.iso.datetime({ offset: true })` accepts: seconds required, fraction any length. */
const INSTANT =
	/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

interface Instant {
	seconds: number;
	/** Fraction digits without trailing zeros (".100" and ".1" are the same instant). */
	fraction: string;
}

function parseInstant(s: string): Instant | null {
	const m = INSTANT.exec(s);
	if (!m?.[1] || !m[3]) return null;
	const ms = Date.parse(`${m[1]}${m[3]}`);
	if (!Number.isFinite(ms)) return null;
	return { seconds: ms / 1000, fraction: (m[2] ?? "").replace(/0+$/, "") };
}

/**
 * Sign of `a - b` as instants: negative when `a` is earlier, 0 when they are the same instant, positive
 * when `a` is later. A value that is not a valid timestamp sorts before every valid one (never newer).
 */
export function compareInstants(a: string, b: string): number {
	const x = parseInstant(a);
	const y = parseInstant(b);
	if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
	if (x.seconds !== y.seconds) return x.seconds < y.seconds ? -1 : 1;
	const len = Math.max(x.fraction.length, y.fraction.length);
	const fx = x.fraction.padEnd(len, "0");
	const fy = y.fraction.padEnd(len, "0");
	return fx === fy ? 0 : fx < fy ? -1 : 1;
}
