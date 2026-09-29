// Hub data for the 2D view: REST snapshot + /ws live updates, with reconnect.
// On every (re)connect the snapshot is re-fetched, so anything missed while disconnected is filled
// in; live messages are merged by id so a message racing the snapshot is never lost or doubled.
import type { Event, Provider, Repo, Session } from "@agent-city/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { EVENT_LIMIT, mergeEvents, mergeSessions } from "./merge.ts";

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

	const loadSnapshot = useCallback(async () => {
		try {
			const [r, s] = await Promise.all([
				getJson<{ districts: Districts }>("/api/repos"),
				getJson<{ sessions: Session[] }>("/api/sessions"),
				loadEvents(filterRef.current),
			]);
			setDistricts(r.districts);
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
				let msg: { kind: string; data: unknown };
				try {
					msg = JSON.parse(String(m.data));
				} catch {
					return;
				}
				if (msg.kind === "event") {
					const e = msg.data as Event;
					if (matches(e, filterRef.current))
						setEvents((cur) => mergeEvents([e], cur));
				} else if (msg.kind === "session") {
					setSessions((cur) => mergeSessions(cur, [msg.data as Session]));
				} else if (msg.kind === "repo") {
					setDistricts((cur) => upsertRepo(cur, msg.data as RepoView));
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
	}, [loadSnapshot]);

	return { districts, sessions, events, conn, error };
}
