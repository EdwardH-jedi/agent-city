// Right column (design doc 15 §3, decision D10): SESSIONS — the projects, their Claude / Codex sessions and a
// terminal tail (last commands and files) under each working one. It replaces 지금 진행: a project row says
// its run's state (or its branch) with a thin phase bar, a session row `● Claude · opus 5.5 … 12초`. Read
// only; the arrangement is session-panel.ts, the tail lines tail.ts. Nothing here asks the hub for more:
// sessions and events are what useHub already holds. The panel never scrolls (the model folds to fit).
import type { Session } from "@agent-city/schema";
import { useMemo } from "react";
import type { VillageModel } from "./model.ts";
import { PanelHead } from "./PanelHead.tsx";
import {
	cwdLookup,
	type PanelRow,
	type SessionPanel,
	sessionPanel,
} from "./session-panel.ts";
import { sessionTails, shortModel, type TailEvent } from "./tail.ts";

/** A screen under this width shows two tail lines instead of three (15 §3). */
export const WIDE_MIN = 1600;

/** `12초`, `3분`, `2시간`, `1일`. */
export function agoShort(iso: string, now: number): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return "";
	const s = Math.max(0, Math.floor((now - t) / 1000));
	if (s < 60) return `${s}초`;
	if (s < 3600) return `${Math.floor(s / 60)}분`;
	if (s < 86_400) return `${Math.floor(s / 3600)}시간`;
	return `${Math.floor(s / 86_400)}일`;
}

const STATUS_TAG: Record<PanelRow["status"], string | null> = {
	waiting: "입력 대기",
	idle: "쉬는 중",
	active: null,
};

function Row({ r, now }: { r: PanelRow; now: number }) {
	const tag = STATUS_TAG[r.status];
	return (
		<li className={`sess-row st-${r.status}`}>
			<div className="sess-line">
				<i className="sess-dot" aria-hidden="true" />
				<span className="sess-who">
					{r.provider}
					{r.model ? ` · ${r.model}` : ""}
				</span>
				{r.subagents > 0 && (
					<span className="sess-sub">+{r.subagents} sub</span>
				)}
				{tag && <span className={`tag tag-${r.status}`}>{tag}</span>}
				<span className="sess-age">{agoShort(r.last_event_at, now)}</span>
			</div>
			{r.tail.length > 0 && (
				<ol
					className={`sess-tail${r.status === "active" ? " tail-live" : ""}`}
					aria-label="최근 명령"
				>
					{r.tail.map((l, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional (newest last)
						<li key={i}>
							{l.text}
							{l.count > 1 && <span className="tail-n"> ×{l.count}</span>}
						</li>
					))}
				</ol>
			)}
		</li>
	);
}

export function Sessions({
	model,
	sessions,
	events,
	now,
	budget,
	ui,
	wide,
	pixel = false,
}: {
	model: VillageModel;
	sessions: readonly Session[];
	events: readonly TailEvent[];
	now: number;
	/** Height the list may take, px (the column under its head). */
	budget: number;
	ui: number;
	wide: boolean;
	pixel?: boolean;
}) {
	// tails follow the events, not the clock
	const tails = useMemo(
		() => sessionTails(events, cwdLookup(sessions)),
		[events, sessions],
	);
	const panel: SessionPanel = useMemo(
		() =>
			sessionPanel({
				sessions,
				tails,
				model,
				now,
				budget,
				ui,
				tailMax: wide ? 3 : 2,
				shortModel,
			}),
		[sessions, tails, model, now, budget, ui, wide],
	);
	const c = panel.counts;
	return (
		<aside className="now" aria-label="세션">
			<section className="sessions" aria-label="세션">
				<PanelHead
					title="SESSIONS"
					label="세션"
					sub={`진행 ${c.active} · 대기 ${c.waiting} · 쉼 ${c.idle}`}
					pixel={pixel}
				/>
				{panel.groups.length === 0 ? (
					<p className="hq-empty">없음</p>
				) : (
					<ul className="sess-list">
						{panel.groups.map((g) => (
							<li key={g.project_id} className="sess-group">
								<div className="sess-proj">
									<span className="sess-name">{g.label}</span>
									{g.tag && (
										<span className={`tag tag-${g.tag.kind}`}>
											{g.tag.text}
										</span>
									)}
								</div>
								{g.phase !== null && (
									<div
										className="sess-phase"
										role="img"
										aria-label={`단계 ${g.phase + 1}/9`}
									>
										<i style={{ width: `${((g.phase + 1) / 9) * 100}%` }} />
									</div>
								)}
								{g.rows.length > 0 && (
									<ul className="sess-rows">
										{g.rows.map((r) => (
											<Row key={r.id} r={r} now={now} />
										))}
									</ul>
								)}
								{g.more > 0 && <p className="sess-more">외 {g.more}</p>}
							</li>
						))}
					</ul>
				)}
				{panel.moreGroups > 0 && (
					<p className="sess-more sess-more-groups">외 {panel.moreGroups}곳</p>
				)}
			</section>
		</aside>
	);
}
