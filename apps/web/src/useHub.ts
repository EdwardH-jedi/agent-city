// Hub data for the 2D view: REST snapshot + /ws live updates, with reconnect.
// On every (re)connect the snapshot is re-fetched, so anything missed while disconnected is filled
// in; live messages are merged by id so a message racing the snapshot is never lost or doubled.
import type {
	Event,
	MachineView,
	Provider,
	Repo,
	RunEventView,
	RunView,
	Session,
	UsageSummary,
} from "@agent-city/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	EVENT_LIMIT,
	mergeEvents,
	mergeMachines,
	mergeRuns,
	mergeSessions,
	parseHubMessage,
} from "./merge.ts";

export type RepoView = Repo & { active_sessions: number };
export type Districts = Record<string, RepoView[]>;
export type Conn = "connecting" | "open" | "reconnecting";
export interface EventFilter {
	repo: string | null;
	provider: Provider | null;
}

export { EVENT_LIMIT };

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000];

async function getJson<T>(path: string): Promise<T> {
	const res = await fetch(path);
	if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
	return (await res.json()) as T;
}

const eventsPath = (f: EventFilter) => {
	const q = new URLSearchParams({ limit: String(EVENT_LIMIT) });
	if (f.repo) q.set("repo", f.repo);
	if (f.provider) q.set("provider", f.provider);
	return `/api/events?${q}`;
};

const matches = (e: Event, f: EventFilter) =>
	(!f.repo || e.repo_id === f.repo) &&
	(!f.provider || e.provider === f.provider);

function upsertRepo(districts: Districts, repo: RepoView): Districts {
	const next: Districts = {};
	for (const [d, list] of Object.entries(districts)) {
		next[d] = list.filter((r) => r.id !== repo.id);
	}
	next[repo.district] = [...(next[repo.district] ?? []), repo];
	return next;
}

export function useHub(filter: EventFilter) {
	const [districts, setDistricts] = useState<Districts>({});
	const [sessions, setSessions] = useState<Session[]>([]);
	const [events, setEvents] = useState<Event[]>([]);
	const [machines, setMachines] = useState<MachineView[]>([]);
	const [runs, setRuns] = useState<RunView[]>([]);
	// token usage (18 §5): only from /ws — the hub sends it when the socket opens and when it changes, so
	// there is no request for it; an older hub sends none and it stays null
	const [usage, setUsage] = useState<UsageSummary | null>(null);
	const [conn, setConn] = useState<Conn>("connecting");
	const [error, setError] = useState<string | null>(null);
	const filterRef = useRef(filter);
	filterRef.current = filter;

	const loadEvents = useCallback(async (f: EventFilter) => {
		const { events: list } = await getJson<{ events: Event[] }>(eventsPath(f));
		// drop live rows that no longer match (filter changed), then merge the snapshot in
		setEvents((cur) =>
			mergeEvents(
				cur.filter((e) => matches(e, f)),
				list,
			),
		);
	}, []);

	const loadSessions = useCallback(async () => {
		const s = await getJson<{ sessions: Session[] }>("/api/sessions");
		setSessions((cur) => mergeSessions(cur, s.sessions));
	}, []);

	const loadSnapshot = useCallback(async () => {
		try {
			const [r, s, m, ru] = await Promise.all([
				getJson<{ districts: Districts }>("/api/repos"),
				getJson<{ sessions: Session[] }>("/api/sessions"),
				getJson<{ machines: MachineView[] }>("/api/machines"),
				getJson<{ runs: RunView[] }>("/api/runs"),
				loadEvents(filterRef.current),
			]);
			setDistricts(r.districts);
			setMachines((cur) => mergeMachines(cur, m.machines));
			setRuns((cur) => mergeRuns(cur, ru.runs));
			setSessions((cur) => mergeSessions(cur, s.sessions));
			setError(null);
		} catch (err) {
			setError((err as Error).message);
		}
	}, [loadEvents]);

	// filter change → server-side query (the hub filters by repo / provider)
	useEffect(() => {
		setEvents([]);
		loadEvents(filter).catch((err: Error) => setError(err.message));
	}, [filter, loadEvents]);

	useEffect(() => {
		let ws: WebSocket | null = null;
		let attempt = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let disposed = false;

		const connect = () => {
			const proto = location.protocol === "https:" ? "wss" : "ws";
			ws = new WebSocket(`${proto}://${location.host}/ws`);
			setConn(attempt === 0 ? "connecting" : "reconnecting");
			ws.onopen = () => {
				attempt = 0;
				setConn("open");
				void loadSnapshot(); // fill whatever happened while we were away
			};
			ws.onmessage = (m) => {
				const msg = parseHubMessage(String(m.data));
				if (!msg) return;
				if (msg.kind === "invalidate") {
					// rows were rewritten in bulk (repo remap): re-fetch those snapshots (N07)
					if (msg.scope.includes("sessions"))
						loadSessions().catch((err: Error) => setError(err.message));
					if (msg.scope.includes("events"))
						loadEvents(filterRef.current).catch((err: Error) =>
							setError(err.message),
						);
					if (msg.scope.includes("repos")) void loadSnapshot();
				} else if (msg.kind === "event") {
					const e = msg.data as Event;
					if (matches(e, filterRef.current))
						setEvents((cur) => mergeEvents([e], cur));
				} else if (msg.kind === "session") {
					setSessions((cur) => mergeSessions(cur, [msg.data as Session]));
				} else if (msg.kind === "repo") {
					setDistricts((cur) => upsertRepo(cur, msg.data as RepoView));
				} else if (msg.kind === "machine") {
					setMachines((cur) => mergeMachines(cur, [msg.data]));
				} else if (msg.kind === "run") {
					setRuns((cur) => mergeRuns(cur, [msg.data]));
				} else if (msg.kind === "usage") {
					setUsage(msg.data);
				}
			};
			ws.onclose = () => {
				if (disposed) return;
				setConn("reconnecting");
				const delay =
					BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 10_000;
				attempt++;
				timer = setTimeout(connect, delay);
			};
		};
		connect();
		return () => {
			disposed = true;
			clearTimeout(timer);
			ws?.close();
		};
	}, [loadSnapshot, loadSessions, loadEvents]);

	return { districts, sessions, events, machines, runs, usage, conn, error };
}

/** What the board needs to know changed about a run before its events are fetched again. */
const eventsSignature = (r: RunView) =>
	`${r.ledger_revision}:${r.last_event_sequence ?? "-"}`;

/**
 * Recent events (newest first) of the given runs, keyed `${machine_id}:${run_id}`. GET only. There is no
 * websocket message for run events, so a run's events are fetched again whenever its ledger revision or
 * last event sequence changes. A failed fetch keeps what was there.
 */
export function useRunEvents(
	runs: readonly RunView[],
): ReadonlyMap<string, readonly RunEventView[]> {
	const [byRun, setByRun] = useState<
		ReadonlyMap<string, readonly RunEventView[]>
	>(new Map());
	const fetched = useRef(new Map<string, string>());
	// per hook, not per effect run: a fetch started for an earlier set of runs must still land
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	// a stable string, so a new array of identical runs does not refetch
	const wanted = runs
		.map((r) => `${r.machine_id}\u0000${r.run_id}\u0000${eventsSignature(r)}`)
		.sort()
		.join("\u0001");

	useEffect(() => {
		for (const item of wanted ? wanted.split("\u0001") : []) {
			const [machine = "", id = "", sig = ""] = item.split("\u0000");
			const key = `${machine}:${id}`;
			if (fetched.current.get(key) === sig) continue;
			fetched.current.set(key, sig);
			getJson<{ events: RunEventView[] }>(
				`/api/runs/${encodeURIComponent(machine)}/${encodeURIComponent(id)}/events?limit=100`,
			)
				.then((r) => {
					// a reply to an older request never replaces a newer one
					if (!alive.current || fetched.current.get(key) !== sig) return;
					setByRun((cur) => new Map(cur).set(key, r.events));
				})
				.catch(() => {
					// try again on the next change; the board keeps showing the last events it had
					if (fetched.current.get(key) === sig) fetched.current.delete(key);
				});
		}
	}, [wanted]);

	return byRun;
}
