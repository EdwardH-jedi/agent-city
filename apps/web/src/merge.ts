// Pure merge rules for the live view (unit-tested in merge.test.ts). No React, no DOM.
import type {
	Event,
	Provider,
	Repo,
	Session,
	SessionStatus,
} from "@agent-city/schema";

export const EVENT_LIMIT = 200;

/** Newest first, unique by id, capped. */
export function mergeEvents(
	a: readonly Event[],
	b: readonly Event[],
	limit = EVENT_LIMIT,
): Event[] {
	const byId = new Map<string, Event>();
	for (const e of [...a, ...b]) byId.set(e.id, e);
	return [...byId.values()]
		.sort((x, y) => (x.ts < y.ts ? 1 : x.ts > y.ts ? -1 : 0))
		.slice(0, limit);
}

/**
 * Upsert by id, ordered by the row version `rev` (re-audit N05): the hub bumps it on every write
 * (ingest, stale sweep, repo remap), so a higher rev is strictly newer. Equal rev → keep what we
 * have (same version). Timestamps are not compared — a snapshot that raced a live update can't win
 * with an older version, whatever order the two arrive in.
 */
export function mergeSessions(
	current: readonly Session[],
	incoming: readonly Session[],
): Session[] {
	const byId = new Map(current.map((s) => [s.id, s]));
	for (const s of incoming) {
		const prev = byId.get(s.id);
		if (!prev || (s.rev ?? 0) > (prev.rev ?? 0)) byId.set(s.id, s);
	}
	return [...byId.values()];
}

export type Scope = "sessions" | "events" | "repos";
const SCOPES: readonly Scope[] = ["sessions", "events", "repos"];

export type HubMessage =
	| { kind: "event"; data: Event }
	| { kind: "session"; data: Session }
	| { kind: "repo"; data: unknown }
	// a managed task changed; only its id is broadcast (content is behind the managed token)
	| { kind: "managed"; data: { task_id: string } }
	| { kind: "invalidate"; scope: Scope[] };

const isObj = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => typeof v === "string" && v.length > 0;

/** Minimal shape checks: a frame that could not have come from this hub is dropped, not merged. */
const validEvent = (d: unknown) =>
	isObj(d) && str(d.id) && str(d.ts) && str(d.provider) && str(d.type);
const validSession = (d: unknown) =>
	isObj(d) &&
	str(d.id) &&
	str(d.status) &&
	str(d.last_event_at) &&
	typeof d.rev === "number";
const validRepo = (d: unknown) => isObj(d) && str(d.id) && str(d.district);

/** Parse one /ws frame; unknown or malformed frames → null. */
export function parseHubMessage(raw: string): HubMessage | null {
	let m: { kind?: unknown; data?: unknown; scope?: unknown };
	try {
		m = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isObj(m)) return null;
	if (m.kind === "invalidate") {
		const scope = Array.isArray(m.scope)
			? SCOPES.filter((s) => (m.scope as unknown[]).includes(s))
			: [];
		return { kind: "invalidate", scope };
	}
	if (m.kind === "managed") {
		const id = (m.data as { task_id?: unknown } | undefined)?.task_id;
		return typeof id === "string"
			? { kind: "managed", data: { task_id: id } }
			: null;
	}
	if (m.kind === "event" && validEvent(m.data))
		return { kind: "event", data: m.data as Event };
	if (m.kind === "session" && validSession(m.data))
		return { kind: "session", data: m.data as Session };
	if (m.kind === "repo" && validRepo(m.data))
		return { kind: "repo", data: m.data };
	return null;
}

const LIVE: ReadonlySet<SessionStatus> = new Set(["active", "waiting", "idle"]);

/** Live (active / waiting / idle) sessions per repo id. */
export function liveCountByRepo(
	sessions: readonly Session[],
): Map<string, number> {
	const m = new Map<string, number>();
	for (const s of sessions)
		if (s.repo_id && LIVE.has(s.status))
			m.set(s.repo_id, (m.get(s.repo_id) ?? 0) + 1);
	return m;
}

export interface EventFilter {
	repo: string | null;
	provider: Provider | null;
}

export const matchesFilter = (e: Event, f: EventFilter): boolean =>
	(!f.repo || e.repo_id === f.repo) &&
	(!f.provider || e.provider === f.provider);

/**
 * An events snapshot merged into the current list under the filter that is current NOW (not the
 * one the request was made with): a late answer for an old filter cannot inject rows that do not
 * match what the user selected since.
 */
export function mergeEventSnapshot(
	current: readonly Event[],
	snapshot: readonly Event[],
	filter: EventFilter,
): Event[] {
	return mergeEvents(
		current.filter((e) => matchesFilter(e, filter)),
		snapshot.filter((e) => matchesFilter(e, filter)),
	);
}

/** Repos carry no rev; `synced_at`, then `ci_updated_at`, order versions of the same repo row. */
type RepoVersioned = Pick<
	Repo,
	"id" | "district" | "synced_at" | "ci_updated_at"
>;
const versionKey = (r: RepoVersioned) =>
	`${r.synced_at ?? ""}|${r.ci_updated_at ?? ""}`;

/** Is `a` strictly newer than `b`? */
export const repoNewer = (a: RepoVersioned, b: RepoVersioned): boolean =>
	versionKey(a) > versionKey(b);

function regroup<R extends RepoVersioned>(
	rows: Iterable<R>,
): Record<string, R[]> {
	const out: Record<string, R[]> = {};
	for (const r of rows) {
		const list = out[r.district] ?? [];
		list.push(r);
		out[r.district] = list;
	}
	return out;
}

/**
 * A REST repo snapshot merged with what live `repo` frames already delivered: per repo the newer
 * version wins (a late snapshot cannot roll a repo back); repos only known from live frames stay
 * (the hub never deletes repo rows).
 */
export function mergeDistricts<R extends RepoVersioned>(
	current: Readonly<Record<string, readonly R[]>>,
	snapshot: Readonly<Record<string, readonly R[]>>,
): Record<string, R[]> {
	const byId = new Map<string, R>();
	for (const list of Object.values(current))
		for (const r of list) byId.set(r.id, r);
	for (const list of Object.values(snapshot))
		for (const r of list) {
			const prev = byId.get(r.id);
			if (!prev || !repoNewer(prev, r)) byId.set(r.id, r);
		}
	return regroup(byId.values());
}

/** One live `repo` frame; ignored when what we have is strictly newer. */
export function upsertRepo<R extends RepoVersioned>(
	current: Readonly<Record<string, readonly R[]>>,
	repo: R,
): Record<string, R[]> {
	const byId = new Map<string, R>();
	for (const list of Object.values(current))
		for (const r of list) byId.set(r.id, r);
	const prev = byId.get(repo.id);
	if (prev && repoNewer(prev, repo)) return regroup(byId.values());
	byId.set(repo.id, repo);
	return regroup(byId.values());
}
