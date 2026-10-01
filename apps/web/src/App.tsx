// Phase 0 2D view: repos by district · live sessions (waiting pinned) · event stream.
// Data validation only — the 3D city comes in Phase 1.
// A second tab holds managed tasks (Tasks.tsx); the telemetry view stays the default.
import type {
	Event,
	Provider,
	Session,
	SessionStatus,
} from "@agent-city/schema";
import { useEffect, useMemo, useState } from "react";
import { liveCountByRepo } from "./merge.ts";
import { Tasks } from "./Tasks.tsx";
import {
	type Conn,
	EVENT_LIMIT,
	type EventFilter,
	type RepoView,
	useHub,
} from "./useHub.ts";

const LIVE: ReadonlySet<SessionStatus> = new Set(["active", "waiting", "idle"]);

function useNow(ms: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(t);
	}, [ms]);
	return now;
}

function ago(iso: string | null, now: number): string {
	if (!iso) return "—";
	const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

const repoName = (id: string | null) => (id ? (id.split("/")[1] ?? id) : "—");

export function App() {
	const [filter, setFilter] = useState<EventFilter>({
		repo: null,
		provider: null,
	});
	const { districts, sessions, events, conn, error, managedSeq } =
		useHub(filter);
	const [view, setView] = useState<"city" | "tasks">(() =>
		location.hash === "#tasks" ? "tasks" : "city",
	);
	const show = (v: "city" | "tasks") => {
		history.replaceState(null, "", v === "tasks" ? "#tasks" : "#");
		setView(v);
	};
	// back/forward and typed `#tasks` links switch the tab too (not only the initial load)
	useEffect(() => {
		const onHash = () => setView(location.hash === "#tasks" ? "tasks" : "city");
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, []);
	const now = useNow(5_000);

	// live session counts per repo, computed from the session list so they update in real time
	const liveByRepo = useMemo(() => liveCountByRepo(sessions), [sessions]);

	const repoIds = useMemo(
		() =>
			Object.values(districts)
				.flat()
				.map((r) => r.id)
				.sort((a, b) => a.localeCompare(b)),
		[districts],
	);

	return (
		<div className="app">
			<header>
				<h1>Agent City</h1>
				<nav className="tabs">
					<button
						type="button"
						className={view === "city" ? "on" : undefined}
						onClick={() => show("city")}
					>
						Observed sessions
					</button>
					<button
						type="button"
						className={view === "tasks" ? "on" : undefined}
						onClick={() => show("tasks")}
					>
						Managed tasks
					</button>
				</nav>
				<ConnBadge conn={conn} />
				{error && <span className="err">{error}</span>}
			</header>
			{view === "tasks" ? (
				<Tasks managedSeq={managedSeq} />
			) : (
				<div className="grid">
					<Repos districts={districts} liveByRepo={liveByRepo} />
					<Sessions sessions={sessions} now={now} />
					<Events
						events={events}
						filter={filter}
						setFilter={setFilter}
						repoIds={repoIds}
						now={now}
					/>
				</div>
			)}
		</div>
	);
}

function ConnBadge({ conn }: { conn: Conn }) {
	const label = {
		connecting: "connecting…",
		open: "live",
		reconnecting: "reconnecting…",
	}[conn];
	return <span className={`conn conn-${conn}`}>● {label}</span>;
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
		<section className="repos">
			<h2>
				Repos <small>{total}</small>
			</h2>
			{names.map((d) => {
				const list = [...(districts[d] ?? [])].sort(
					(a, b) =>
						(liveByRepo.get(b.id) ?? 0) - (liveByRepo.get(a.id) ?? 0) ||
						(b.pushed_at ?? "").localeCompare(a.pushed_at ?? ""),
				);
				return (
					<div key={d} className="district">
						<h3>
							{d} <small>{list.length}</small>
						</h3>
						<table>
							<thead>
								<tr>
									<th>repo</th>
									<th title="CI (latest workflow run)">CI</th>
									<th title="commits on the default branch, last 30 days">
										30d
									</th>
									<th title="open pull requests">PR</th>
									<th title="live sessions (active / waiting / idle)">live</th>
								</tr>
							</thead>
							<tbody>
								{list.map((r) => {
									const live = liveByRepo.get(r.id) ?? 0;
									return (
										<tr key={r.id} className={live ? "has-live" : undefined}>
											<td title={r.id}>
												{r.is_private && <span title="private">🔒 </span>}
												{repoName(r.id)}
												{r.is_local_only && (
													<span className="tag">local-only</span>
												)}
												{r.is_archived && <span className="tag">archived</span>}
												{r.is_fork && <span className="tag">fork</span>}
											</td>
											<td>
												<span
													className={`ci ci-${r.ci_status}`}
													title={r.ci_status}
												>
													{r.ci_status === "none" ? "–" : r.ci_status}
												</span>
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
				<p className="muted">no repos yet — run `bun run sync:github`</p>
			)}
		</section>
	);
}

// ── sessions ───────────────────────────────────────────────────────────────

function Sessions({ sessions, now }: { sessions: Session[]; now: number }) {
	const [showAll, setShowAll] = useState(false);
	const visible = sessions
		.filter((s) => showAll || LIVE.has(s.status))
		.sort(
			(a, b) =>
				Number(b.status === "waiting") - Number(a.status === "waiting") ||
				b.last_event_at.localeCompare(a.last_event_at),
		);
	const waiting = visible.filter((s) => s.status === "waiting").length;
	return (
		<section className="sessions">
			<h2>
				Live sessions <small>{visible.length}</small>
				{waiting > 0 && (
					<span className="waiting-count">{waiting} waiting</span>
				)}
			</h2>
			<label className="muted">
				<input
					type="checkbox"
					checked={showAll}
					onChange={(e) => setShowAll(e.target.checked)}
				/>{" "}
				include stale / ended
			</label>
			<table>
				<thead>
					<tr>
						<th>status</th>
						<th>provider</th>
						<th>model</th>
						<th>machine</th>
						<th>repo</th>
						<th>last event</th>
					</tr>
				</thead>
				<tbody>
					{visible.map((s) => (
						<tr
							key={s.id}
							className={`st-${s.status}`}
							title={`session ${s.id}`}
						>
							<td>
								<span className={`status status-${s.status}`}>{s.status}</span>
							</td>
							<td>{s.provider}</td>
							<td>{s.model ?? "—"}</td>
							<td>{s.machine_id}</td>
							<td className="wrap" title={s.repo_id ?? s.cwd ?? ""}>
								{repoName(s.repo_id)}
								{s.branch && <span className="muted"> @{s.branch}</span>}
							</td>
							<td title={s.last_event_at}>{ago(s.last_event_at, now)}</td>
						</tr>
					))}
				</tbody>
			</table>
			{visible.length === 0 && <p className="muted">no live sessions</p>}
		</section>
	);
}

// ── events ─────────────────────────────────────────────────────────────────

function Events({
	events,
	filter,
	setFilter,
	repoIds,
	now,
}: {
	events: Event[];
	filter: EventFilter;
	setFilter: (f: EventFilter) => void;
	repoIds: string[];
	now: number;
}) {
	const options = useMemo(() => {
		const set = new Set(repoIds);
		for (const e of events) if (e.repo_id) set.add(e.repo_id);
		if (filter.repo) set.add(filter.repo);
		return [...set].sort((a, b) => a.localeCompare(b));
	}, [repoIds, events, filter.repo]);

	return (
		<section className="stream">
			<h2>
				Events{" "}
				<small>
					{events.length}/{EVENT_LIMIT}
				</small>
			</h2>
			<div className="filters">
				<select
					aria-label="repo filter"
					value={filter.repo ?? ""}
					onChange={(e) =>
						setFilter({ ...filter, repo: e.target.value || null })
					}
				>
					<option value="">all repos</option>
					{options.map((id) => (
						<option key={id} value={id}>
							{id}
						</option>
					))}
				</select>
				<select
					aria-label="provider filter"
					value={filter.provider ?? ""}
					onChange={(e) =>
						setFilter({
							...filter,
							provider: (e.target.value || null) as Provider | null,
						})
					}
				>
					<option value="">all providers</option>
					<option value="claude">claude</option>
					<option value="codex">codex</option>
					<option value="ollama">ollama</option>
				</select>
			</div>
			<ol className="events">
				{events.map((e) => (
					<li key={e.id} title={`${e.ts} · session ${e.session_id ?? "—"}`}>
						<span className="muted time">{ago(e.ts, now)}</span>
						<span className={`prov prov-${e.provider}`}>{e.provider}</span>
						<span className="type">{e.type}</span>
						<span className="summary">{e.summary ?? e.tool ?? ""}</span>
						<span className="muted">{repoName(e.repo_id)}</span>
					</li>
				))}
			</ol>
			{events.length === 0 && <p className="muted">no events</p>}
		</section>
	);
}
