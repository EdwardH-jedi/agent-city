// Two screens over one hub connection: the board (default: status, HQ queue, project village, what is
// running now) and the detail tables (#/detail, key D) — the Phase 0 view, unchanged.
import type {
	Event,
	MachineView,
	Provider,
	Session,
	SessionStatus,
} from "@agent-city/schema";
import { useEffect, useMemo, useState } from "react";
import { Board, DemoBoard } from "./board/Board.tsx";
import { isDemo } from "./board/demo.ts";
import { liveCountByRepo, machinesAt, runsAt } from "./merge.ts";
import { NeedsOwner, Runs } from "./Runs.tsx";
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

type Route = "board" | "detail";
const routeOf = (): Route =>
	window.location.hash === "#/detail" ? "detail" : "board";

// The hash picks the screen; the D key flips it (not while typing in a filter).
function useRoute(): Route {
	const [route, setRoute] = useState<Route>(routeOf);
	useEffect(() => {
		const onHash = () => setRoute(routeOf());
		const onKey = (e: KeyboardEvent) => {
			if (e.key.toLowerCase() !== "d" || e.ctrlKey || e.metaKey || e.altKey)
				return;
			const tag = (e.target as HTMLElement | null)?.tagName;
			if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
			window.location.hash = routeOf() === "detail" ? "#/" : "#/detail";
		};
		window.addEventListener("hashchange", onHash);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("hashchange", onHash);
			window.removeEventListener("keydown", onKey);
		};
	}, []);
	return route;
}

/** `?demo=1` draws the board from made-up data and never opens the hub connection. */
export function App() {
	return isDemo(window.location.search) ? <DemoBoard /> : <LiveApp />;
}

function LiveApp() {
	const [filter, setFilter] = useState<EventFilter>({
		repo: null,
		provider: null,
	});
	const hub = useHub(filter);
	const route = useRoute();
	return route === "detail" ? (
		<Detail hub={hub} filter={filter} setFilter={setFilter} />
	) : (
		<Board hub={hub} />
	);
}

function Detail({
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
	// machine and run states are re-derived from this screen's clock every tick (no message needed)
	const shownMachines = useMemo(
		() => machinesAt(machines, now),
		[machines, now],
	);
	const shownRuns = useMemo(
		() => runsAt(runs, shownMachines, now),
		[runs, shownMachines, now],
	);

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
				<ConnBadge conn={conn} />
				<a href="#/">보드로 (D)</a>
				{error && <span className="err">{error}</span>}
			</header>
			<Machines machines={shownMachines} now={now} />
			{shownRuns.length > 0 && (
				<div className="runs-area">
					<NeedsOwner runs={shownRuns} now={now} />
					<Runs runs={shownRuns} now={now} />
				</div>
			)}
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
		</div>
	);
}

// Machine liveness: cockpit / forge / spine and the hub's last heartbeat from each. A machine fact,
// not whether any AI work succeeded. `machines` already carries the status re-derived from `now`.
function Machines({ machines, now }: { machines: MachineView[]; now: number }) {
	if (machines.length === 0) return null;
	return (
		<div className="machines">
			{machines.map((m) => (
				<div key={m.id} className={`machine machine-${m.status}`}>
					<span className="machine-name">{m.id}</span>
					<span className="machine-status">● {m.status}</span>
					<span className="machine-beat">
						{m.heartbeat_at
							? `last beat ${ago(m.heartbeat_at, now)}`
							: "no beat yet"}
					</span>
				</div>
			))}
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
