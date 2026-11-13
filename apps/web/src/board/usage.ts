// Token usage on the board (18 §5 U3). Pure: the summary arrives on /ws (`{kind:"usage"}`, sent by the
// hub when the socket opens and whenever a collector's report changed it — no request of its own); this
// module validates it and works out what the top band and the left column's USAGE box say.
//
// - The figure is `input + output + cache write` — tokens the model was given fresh or wrote, the way
//   Codex counts its own total. Cache reads are far larger and much cheaper; they are said apart.
// - Days are Australia/Sydney days, taken from this device's clock (usageDay), so an idle kiosk rolls
//   over at midnight even when no report arrives.
// - Only numbers and repo-id-shaped project names reach the screen (usageProject; anything else is
//   counted under "저장소 밖"). Model names are not shown.
// - A plan limit is shown only as its tool's log stated it, only while fresh (observed in the last 6 h)
//   and before its reset.
import {
	dayMinus,
	UsageSummary,
	type UsageSummaryRow,
	usageDay,
	usageProject,
} from "@agent-city/schema";
import { hideCredentials } from "./tail.ts";

export const USAGE_PROJECTS_SHOWN = 4;
export const USAGE_TREND_DAYS = 7;
/**
 * The 7-day row is drawn only when the board body (below the top band) is at least this tall: at
 * 1366×768 (body 712) the left column has no room for it under the map, HQ and LOG (18 §5.2 U3).
 */
export const USAGE_TREND_MIN_BODY = 760;
const LIMIT_FRESH_MS = 6 * 3_600_000;
const ROWS_MAX = 5_000;

/** The validated summary, or null for anything malformed (the panel then stays as it was). */
export function parseUsage(data: unknown): UsageSummary | null {
	const r = UsageSummary.safeParse(data);
	if (!r.success || r.data.rows.length > ROWS_MAX) return null;
	return r.data;
}

const fresh = (
	r: Pick<
		UsageSummaryRow,
		"input_tokens" | "output_tokens" | "cache_write_tokens"
	>,
) => r.input_tokens + r.output_tokens + r.cache_write_tokens;

export interface UsageBar {
	/** Shown name: the repo's own name (`harbor`), or `저장소 밖`. */
	label: string;
	tokens: number;
	/** 0..1 of the largest bar. */
	share: number;
}

export interface UsagePanel {
	today: string;
	total: number;
	cacheRead: number;
	claude: number;
	codex: number;
	projects: UsageBar[];
	/** Projects beyond USAGE_PROJECTS_SHOWN. */
	more: number;
	/** Oldest first, ending today. */
	trend: { day: string; tokens: number }[];
	weekTotal: number;
	/** e.g. `Codex 주간 49%`. */
	limits: string[];
}

export const NO_PROJECT = "저장소 밖";

/** `harbor` from `demo/harbor` (`local/<folder>` → the folder), scrubbed again; else 저장소 밖. */
export function usageProjectLabel(project: string | null): string {
	const p = usageProject(project);
	if (!p) return NO_PROJECT;
	const name = p.slice(p.indexOf("/") + 1);
	return hideCredentials(name) === name ? name : NO_PROJECT;
}

function windowWord(minutes: number): string {
	if (minutes === 10080) return "주간";
	if (minutes % 1440 === 0) return `${minutes / 1440}일`;
	if (minutes % 60 === 0) return `${minutes / 60}시간`;
	return `${minutes}분`;
}

const TOOL_WORD = { claude: "Claude", codex: "Codex" } as const;

/** What the USAGE box shows at `now`; null when there is nothing to say (the box is not drawn). */
export function usagePanel(
	summary: UsageSummary | null,
	now: number,
): UsagePanel | null {
	if (!summary) return null;
	const today = usageDay(now) ?? summary.today;
	const days: string[] = [];
	for (let i = USAGE_TREND_DAYS - 1; i >= 0; i--) days.push(dayMinus(today, i));
	const perDay = new Map(days.map((d) => [d, 0]));
	const byProject = new Map<string, number>();
	let total = 0;
	let cacheRead = 0;
	let claude = 0;
	let codex = 0;
	for (const r of summary.rows) {
		const n = fresh(r);
		if (perDay.has(r.day)) perDay.set(r.day, (perDay.get(r.day) ?? 0) + n);
		if (r.day !== today) continue;
		total += n;
		cacheRead += r.cache_read_tokens;
		if (r.tool === "claude") claude += n;
		else codex += n;
		const label = usageProjectLabel(r.project);
		byProject.set(label, (byProject.get(label) ?? 0) + n);
	}
	const sorted = [...byProject]
		.filter(([, n]) => n > 0)
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
	const top = sorted[0]?.[1] ?? 0;
	const projects = sorted
		.slice(0, USAGE_PROJECTS_SHOWN)
		.map(([label, tokens]) => ({
			label,
			tokens,
			share: top > 0 ? tokens / top : 0,
		}));
	const trend = days.map((day) => ({ day, tokens: perDay.get(day) ?? 0 }));
	const weekTotal = trend.reduce((n, d) => n + d.tokens, 0);
	const limits = summary.limits
		.filter(
			(l) =>
				now - Date.parse(l.observed_at) <= LIMIT_FRESH_MS &&
				(l.resets_at === null || Date.parse(l.resets_at) > now),
		)
		.map(
			(l) =>
				`${TOOL_WORD[l.tool]} ${windowWord(l.window_minutes)} ${Math.round(l.used_percent)}%`,
		);
	if (weekTotal === 0 && limits.length === 0) return null;
	return {
		today,
		total,
		cacheRead,
		claude,
		codex,
		projects,
		more: Math.max(0, sorted.length - USAGE_PROJECTS_SHOWN),
		trend,
		weekTotal,
		limits,
	};
}

/** `950`, `12k`, `203k`, `1.2M`, `34M`, `1.2B` */
export function tokenWord(n: number): string {
	if (n < 1000) return String(Math.round(n));
	if (n < 999_500) return `${Math.round(n / 1000)}k`;
	if (n < 9_950_000)
		return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (n < 999_500_000) return `${Math.round(n / 1_000_000)}M`;
	return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
}

/** The top band's `토큰 …`: today's figure, or null (no cell) when there is none. */
export function usageTopWord(panel: UsagePanel | null): string | null {
	return panel && panel.total > 0 ? tokenWord(panel.total) : null;
}
