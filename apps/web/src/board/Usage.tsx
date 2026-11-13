// USAGE (18 §5 U3): the left column's last box, under LOG. Today's tokens per project (bars), the Claude /
// Codex sums, a plan limit only when its tool's log stated it, and the last 7 days; first, the all-time
// total with its first day (18 §5.6 U4). Text and plain DOM bars only; nothing is fetched (the summary
// comes with /ws). Not drawn at all when there is no usage.
import { PanelHead } from "./PanelHead.tsx";
import { sinceWord, tokenWord, type UsagePanel } from "./usage.ts";

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"] as const;
/** `2026-11-13` → `금` (a calendar date; no zone involved). */
const weekday = (day: string) =>
	WEEKDAY[new Date(`${day}T12:00:00Z`).getUTCDay()] ?? "";

export function Usage({
	panel,
	pixel,
	trend,
}: {
	panel: UsagePanel | null;
	pixel: boolean;
	/** The 7-day row; left out when the column is too short (18 §5.2 U3: 1366×768). */
	trend: boolean;
}) {
	if (!panel) return null;
	const peak = Math.max(1, ...panel.trend.map((d) => d.tokens));
	return (
		<section className="hq-usage" aria-label="토큰 사용량">
			<PanelHead
				title="USAGE"
				label="토큰 사용량"
				sub={`오늘 ${tokenWord(panel.total)} · 7일 ${tokenWord(panel.weekTotal)}`}
				pixel={pixel}
			/>
			<div className="usage-body">
				{/* 1366×768 (measured, demo and live): +21 px, from the map or LOG, whichever has room; no scroll, so it never folds */}
				{panel.cumulative && (
					<p className="usage-total">
						누적 <b>{tokenWord(panel.cumulative.tokens)}</b> ·{" "}
						{sinceWord(panel.cumulative.since, panel.today)}
					</p>
				)}
				<p className="usage-tools">
					Claude <b>{tokenWord(panel.claude)}</b> · Codex{" "}
					<b>{tokenWord(panel.codex)}</b>
					{panel.limits.map((l) => (
						<span key={l} className="usage-limit">
							{" "}
							· {l}
						</span>
					))}
				</p>
				{panel.projects.length > 0 && (
					<ul className="usage-bars">
						{panel.projects.map((p) => (
							<li key={p.label} className="ubar">
								<span className="ubar-name">{p.label}</span>
								<span className="ubar-track" aria-hidden="true">
									<i style={{ width: `${Math.max(2, p.share * 100)}%` }} />
								</span>
								<span className="ubar-n">{tokenWord(p.tokens)}</span>
							</li>
						))}
						{panel.more > 0 && (
							<li className="ubar ubar-more">외 {panel.more}곳</li>
						)}
					</ul>
				)}
				{trend && (
					<ol className="usage-trend" aria-label="최근 7일">
						{panel.trend.map((d) => (
							<li
								key={d.day}
								className={d.day === panel.today ? "ut ut-today" : "ut"}
								title={`${d.day} ${tokenWord(d.tokens)}`}
							>
								<span className="ut-bar" aria-hidden="true">
									<i style={{ height: `${(d.tokens / peak) * 100}%` }} />
								</span>
								<span className="ut-day">{weekday(d.day)}</span>
							</li>
						))}
					</ol>
				)}
				<p className="usage-note">
					캐시 읽기 {tokenWord(panel.cacheRead)}는 따로
				</p>
			</div>
		</section>
	);
}
