// The detail screen (#/detail, key D; design doc 16 A3): the same tables as before — machines, runs (Runs.tsx,
// text only), repos, sessions, events with their repo / provider filters — drawn in the main screen's
// panel look (15 §1: the board's colours, panel boxes with a head strip, every text calc(10.5–14px ×
// --ui), `?ui=` works here too). Every event line is cleaned like the right panel's tails (tail.ts
// eventLine: commands shortened, paths relative to the session's folder or scrubbed, secrets hidden), so
// `/Users/…` never shows. Picking a session shows only its events, oldest first, as one long terminal —
// filtered from the events already held (nothing more is fetched). No way to act on anything.
import type {
	Event,
	MachineView,
	Provider,
	Session,
	SessionStatus,
} from "@agent-city/schema";
import { useEffect, useMemo, useState } from "react";
import { uiScaleOf } from "./board/layout.ts";
import { PanelHead } from "./board/PanelHead.tsx";
import { agoShort } from "./board/Sessions.tsx";
import { cwdLookup } from "./board/session-panel.ts";
import { eventLine, shortModel } from "./board/tail.ts";
import { liveCountByRepo, machinesAt, runsAt } from "./merge.ts";
import { NeedsOwner, Runs } from "./Runs.tsx";
import {
	type Conn,
	EVENT_LIMIT,
	type EventFilter,
	type RepoView,
	type useHub,
} from "./useHub.ts";

const LIVE: ReadonlySet<SessionStatus> = new Set(["active", "waiting", "idle"]);

const STATUS_WORD: Record<SessionStatus, string> = {
	active: "진행",
	waiting: "입력 대기",
	idle: "쉬는 중",
	stale: "오래 조용",
	ended: "끝남",
};
const MACHINE_WORD: Record<MachineView["status"], string> = {
	online: "켜짐",
	stale: "늦음",
	offline: "꺼짐",
	unobserved: "모름",
};
const CONN_WORD: Record<Conn, string> = {
	connecting: "연결 중",
	open: "실시간",
	reconnecting: "다시 연결 중",
};

function useNow(ms: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(t);
	}, [ms]);
	return now;
}

/** The event's type, short (the line itself reads the same before and after a tool runs). */
const TYPE_MARK: Record<string, string> = {
	PreToolUse: "→",
	PostToolUse: "✓",
	PostToolUseFailure: "✗",
	UserPromptSubmit: "›",
	Notification: "!",
	Stop: "■",
	SessionStart: "▶",
	SessionEnd: "◼",
	SubagentStop: "■",
};

const repoName = (id: string | null) => (id ? (id.split("/")[1] ?? id) : "—");
const ago = (iso: string | null, now: number) =>
	iso ? `${agoShort(iso, now)} 전` : "—";

export function Detail({
	hub,
	filter,
	setFilter,
}: {
	hub: ReturnType<typeof useHub>;
	filter: EventFilter;
	setFilter: (f: EventFilter) => void;
}) {
	const { districts, sessions, events, machines, runs, conn, error } = hub;
	const now = useNow(5_000);
	const [ui] = useState(() => uiScaleOf(window.location.search));
	// machine and run states are re-derived from this screen's clock every tick (no message needed)
	const shownMachines = useMemo(
		() => machinesAt(machines, now),
		[machines, now],
	);
	const shownRuns = useMemo(
		() => runsAt(runs, shownMachines, now),
		[runs, shownMachines, now],
	);
	const liveByRepo = useMemo(() => liveCountByRepo(sessions), [sessions]);
	const repoIds = useMemo(
		() =>
			Object.values(districts)
				.flat()
				.map((r) => r.id)
				.sort((a, b) => a.localeCompare(b)),
		[districts],
	);
	// the one session whose events are shown alone (null: every event in the window)
	const [picked, setPicked] = useState<string | null>(null);
	return (
		<div className="board detail" style={{ "--ui": String(ui) } as never}>
			<header className="board-top detail-top">
				<h1 className="detail-title">상세</h1>
				<ul className="board-machines" aria-label="머신">
					{shownMachines.map((m) => (
						<li
							key={m.id}
							className={`bm bm-${m.status}`}
							title={
								m.heartbeat_at
									? `마지막 신호 ${ago(m.heartbeat_at, now)}`
									: "신호 없음"
							}
						>
							<i className="bm-dot" aria-hidden="true" />
							{m.id} {MACHINE_WORD[m.status]}
							<span className="detail-beat">
								{m.heartbeat_at ? ago(m.heartbeat_at, now) : "신호 없음"}
							</span>
						</li>
					))}
				</ul>
				<span className={`bm detail-conn conn-${conn}`}>
					<i className="bm-dot" aria-hidden="true" />
					{CONN_WORD[conn]}
				</span>
				<a className="board-link" href="#/">
					보드로 (D)
				</a>
			</header>
			{error && <div className="board-error">{error}</div>}
			<div className="detail-body">
				<div className="detail-col">
					<section className="dpanel detail-runs" aria-label="run">
						<PanelHead
							title="RUNS"
							label="run 보고"
							sub={`결재·확인 ${shownRuns.filter((r) => r.needs_owner).length} · 전체 ${shownRuns.length}`}
							pixel={false}
						/>
						<div className="dscroll">
							{shownRuns.length > 0 ? (
								<>
									<NeedsOwner runs={shownRuns} now={now} />
									<Runs runs={shownRuns} now={now} />
								</>
							) : (
								<p className="quiet dpad">보고된 run 없음</p>
							)}
						</div>
					</section>
					<Repos districts={districts} liveByRepo={liveByRepo} />
				</div>
				<SessionList
					sessions={sessions}
					now={now}
					picked={picked}
					setPicked={setPicked}
				/>
				<EventList
					events={events}
					sessions={sessions}
					filter={filter}
					setFilter={setFilter}
					repoIds={repoIds}
					now={now}
					picked={picked}
					setPicked={setPicked}
				/>
			</div>
		</div>
	);
}

// ── repos ──────────────────────────────────────────────────────────────────

function Repos({
	districts,
	liveByRepo,
}: {
	districts: Record<string, RepoView[]>;
	liveByRepo: Map<string, number>;
}) {
	const names = Object.keys(districts).sort((a, b) =>
		a === "uncategorized" ? 1 : b === "uncategorized" ? -1 : a.localeCompare(b),
	);
	const total = names.reduce((n, d) => n + (districts[d]?.length ?? 0), 0);
	return (
		<section className="dpanel detail-repos" aria-label="저장소">
			<PanelHead
				title="REPOS"
				label="저장소"
				sub={`${total}곳 · CI · 30일 커밋 · PR · 세션`}
				pixel={false}
			/>
			<div className="dscroll">
				{names.map((d) => {
					const list = [...(districts[d] ?? [])].sort(
						(a, b) =>
							(liveByRepo.get(b.id) ?? 0) - (liveByRepo.get(a.id) ?? 0) ||
							(b.pushed_at ?? "").localeCompare(a.pushed_at ?? ""),
					);
					return (
						<div key={d} className="ddistrict">
							<div className="dgroup">
								{d} <span className="dim">{list.length}</span>
							</div>
							<table className="dtable">
								<tbody>
									{list.map((r) => {
										const live = liveByRepo.get(r.id) ?? 0;
										return (
											<tr key={r.id} className={live ? "has-live" : undefined}>
												<td className="dname" title={r.id}>
													{r.is_private && <span title="private">🔒 </span>}
													{repoName(r.id)}
													{r.is_local_only && (
														<span className="tag">local-only</span>
													)}
													{r.is_archived && (
														<span className="tag">archived</span>
													)}
													{r.is_fork && <span className="tag">fork</span>}
												</td>
												<td
													className={`dci ci-${r.ci_status}`}
													title={r.ci_status}
												>
													{r.ci_status === "none" ? "–" : r.ci_status}
												</td>
												<td className="num">{r.commits_30d ?? "–"}</td>
												<td className="num">{r.open_prs ?? "–"}</td>
												<td className="num">{live ? <b>{live}</b> : "·"}</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
					);
				})}
				{total === 0 && (
					<p className="quiet dpad">저장소 없음 — `bun run sync:github`</p>
				)}
			</div>
		</section>
	);
}

// ── sessions ───────────────────────────────────────────────────────────────

function SessionList({
	sessions,
	now,
	picked,
	setPicked,
}: {
	sessions: Session[];
	now: number;
	picked: string | null;
	setPicked: (id: string | null) => void;
}) {
	const [showAll, setShowAll] = useState(false);
	const visible = sessions
		.filter((s) => showAll || LIVE.has(s.status) || s.id === picked)
		.sort(
			(a, b) =>
				Number(b.status === "waiting") - Number(a.status === "waiting") ||
				b.last_event_at.localeCompare(a.last_event_at),
		);
	const waiting = visible.filter((s) => s.status === "waiting").length;
	return (
		<section className="dpanel detail-sessions" aria-label="세션">
			<PanelHead
				title="SESSIONS"
				label="세션"
				sub={`${visible.length}개${waiting ? ` · 입력 대기 ${waiting}` : ""} · 고르면 그 세션의 사건만`}
				pixel={false}
			/>
			<label className="dcheck">
				<input
					type="checkbox"
					checked={showAll}
					onChange={(e) => setShowAll(e.target.checked)}
				/>{" "}
				오래 조용 · 끝남 포함
			</label>
			<ul className="dscroll dsess">
				{visible.map((s) => (
					<li key={s.id}>
						<button
							type="button"
							className={`drow st-${s.status}${s.id === picked ? " picked" : ""}`}
							aria-pressed={s.id === picked}
							title={`세션 ${s.id}`}
							onClick={() => setPicked(s.id === picked ? null : s.id)}
						>
							<i className="sess-dot" aria-hidden="true" />
							<span className="dwho">
								{s.provider}
								{s.model ? ` · ${shortModel(s.model)}` : ""}
							</span>
							<span className={`tag dstat st-${s.status}`}>
								{STATUS_WORD[s.status]}
							</span>
							<span className="dwhere">
								{s.machine_id} · {repoName(s.repo_id)}
								{s.branch && <span className="dim"> @{s.branch}</span>}
							</span>
							<span className="dage" title={s.last_event_at}>
								{agoShort(s.last_event_at, now)}
							</span>
						</button>
					</li>
				))}
			</ul>
			{visible.length === 0 && <p className="quiet dpad">세션 없음</p>}
		</section>
	);
}

// ── events ─────────────────────────────────────────────────────────────────

function EventList({
	events,
	sessions,
	filter,
	setFilter,
	repoIds,
	now,
	picked,
	setPicked,
}: {
	events: Event[];
	sessions: Session[];
	filter: EventFilter;
	setFilter: (f: EventFilter) => void;
	repoIds: string[];
	now: number;
	picked: string | null;
	setPicked: (id: string | null) => void;
}) {
	const options = useMemo(() => {
		const set = new Set(repoIds);
		for (const e of events) if (e.repo_id) set.add(e.repo_id);
		if (filter.repo) set.add(filter.repo);
		return [...set].sort((a, b) => a.localeCompare(b));
	}, [repoIds, events, filter.repo]);
	// each line cleaned with its own session's folder (tail.ts; the folder itself is never drawn)
	const cwdOf = useMemo(() => cwdLookup(sessions), [sessions]);
	const shown = useMemo(() => {
		if (!picked) return events;
		// one session: oldest first, like a terminal (the hub lists newest first)
		// equal times keep the hub's order reversed (it lists newest first), as the tails do
		return events
			.map((e, i) => ({ e, i }))
			.filter(({ e }) => e.session_id === picked)
			.sort((a, b) => (a.e.ts < b.e.ts ? -1 : a.e.ts > b.e.ts ? 1 : b.i - a.i))
			.map(({ e }) => e);
	}, [events, picked]);
	return (
		<section className="dpanel detail-events" aria-label="사건">
			<PanelHead
				title="EVENTS"
				label="사건"
				sub={
					picked
						? `세션 하나 · ${shown.length}건 (오래된 것부터)`
						: `${events.length}/${EVENT_LIMIT} (최근 것부터)`
				}
				pixel={false}
			/>
			<div className="dfilters">
				<select
					aria-label="저장소 거르기"
					value={filter.repo ?? ""}
					onChange={(e) =>
						setFilter({ ...filter, repo: e.target.value || null })
					}
				>
					<option value="">모든 저장소</option>
					{options.map((id) => (
						<option key={id} value={id}>
							{id}
						</option>
					))}
				</select>
				<select
					aria-label="provider 거르기"
					value={filter.provider ?? ""}
					onChange={(e) =>
						setFilter({
							...filter,
							provider: (e.target.value || null) as Provider | null,
						})
					}
				>
					<option value="">모든 provider</option>
					<option value="claude">claude</option>
					<option value="codex">codex</option>
					<option value="ollama">ollama</option>
				</select>
				{picked && (
					<button
						type="button"
						className="dclear"
						onClick={() => setPicked(null)}
					>
						전체 사건 보기
					</button>
				)}
			</div>
			<ol className={`dscroll devents${picked ? " dterm" : ""}`}>
				{shown.map((e) => (
					<li key={e.id} title={`${e.ts} · 세션 ${e.session_id ?? "—"}`}>
						<span className="dtime">{agoShort(e.ts, now)}</span>
						{!picked && (
							<span className={`dprov prov-${e.provider}`}>{e.provider}</span>
						)}
						<span className="dtype" title={e.type}>
							{TYPE_MARK[e.type] ?? "·"}
						</span>
						<span className="dline">
							{eventLine(e, e.session_id ? cwdOf(e.session_id) : null)}
						</span>
						{!picked && <span className="drepo">{repoName(e.repo_id)}</span>}
					</li>
				))}
			</ol>
			{shown.length === 0 && (
				<p className="quiet dpad">
					{picked && (filter.repo || filter.provider)
						? "이 세션의 사건 없음 — 저장소·provider 거르기에 걸렸을 수 있음"
						: "사건 없음"}
				</p>
			)}
		</section>
	);
}
