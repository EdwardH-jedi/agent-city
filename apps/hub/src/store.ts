// All hub SQL. Routes stay thin; everything here is synchronous bun:sqlite.
import type { Database } from "bun:sqlite";
import {
	type Agent,
	applyStale,
	type Event,
	endsAgent,
	type IngestEvent,
	MachineRole,
	mainAgentId,
	namespaceIds,
	nextStatus,
	normalizeRepoId,
	type Repo,
	type Session,
	type SessionStatus,
	STALE_AFTER_MS,
	sanitizeEvent,
} from "@agent-city/schema";

export interface IngestResult {
	accepted: number;
	duplicates: number;
	/** Existing session/event/repo_path rows re-pointed to a canonical repo id (→ `invalidate`). */
	remapped: number;
	/** Rows to broadcast — publish only after the transaction committed. */
	events: Event[];
	sessions: Session[];
}

type EventRow = Omit<Event, "payload_redacted"> & { payload_redacted: string };

const toEvent = (r: EventRow): Event => ({
	...r,
	payload_redacted: JSON.parse(r.payload_redacted) as Record<string, unknown>,
});

/** ISO-8601 with any offset → canonical UTC `…Z`, so TEXT comparison == time comparison. */
const utc = (ts: string): string => new Date(ts).toISOString();

/**
 * Insert a batch atomically. Event id is the idempotency key: a duplicate is skipped entirely (no
 * session/agent side effects). The main agent's id is the session id; `events.agent_id` stores the
 * resolved agent (main when the collector sent none).
 */
export function ingestEvents(
	db: Database,
	rawBatch: readonly IngestEvent[],
): IngestResult {
	// Final redaction of every string field — collectors are not trusted (F02). Done first so the
	// sanitized id is the dedupe key and the sanitized machine id the FK value. Then the id namespace
	// (F10) — idempotent, so it also upgrades events spooled by an older collector.
	const batch = rawBatch.map((e) => namespaceIds(sanitizeEvent(e)));
	const upsertMachine = db.query(
		`INSERT INTO machines (id, hostname, role, last_seen_at) VALUES ($id, $hostname, $role, $ts)
		 ON CONFLICT(id) DO UPDATE SET
		   hostname = coalesce(excluded.hostname, hostname),
		   last_seen_at = max(coalesce(last_seen_at, ''), excluded.last_seen_at)`,
	);
	const insertEvent = db.query(
		`INSERT INTO events (id, ts, machine_id, session_id, agent_id, provider, type, tool, summary, repo_id, payload_redacted)
		 VALUES ($id, $ts, $machine_id, $session_id, $agent_id, $provider, $type, $tool, $summary, $repo_id, $payload)
		 ON CONFLICT(id) DO NOTHING`,
	);
	const upsertSession = db.query(
		`INSERT INTO sessions (id, provider, machine_id, repo_id, cwd, branch, model, status, started_at, last_event_at, ended_at, rev)
		 VALUES ($id, $provider, $machine_id, $repo_id, $cwd, $branch, $model, $status, $ts, $ts, $ended_at, 1)
		 ON CONFLICT(id) DO UPDATE SET
		   rev = rev + 1,
		   -- Only a newer (or same-instant) event may move status or overwrite metadata (F08); a late
		   -- arrival only fills fields that are still NULL. SET expressions all see the old row.
		   status        = CASE WHEN excluded.last_event_at >= last_event_at THEN excluded.status ELSE status END,
		   ended_at      = CASE WHEN excluded.last_event_at >= last_event_at THEN excluded.ended_at ELSE ended_at END,
		   repo_id = CASE WHEN excluded.last_event_at >= last_event_at
		                  THEN coalesce(excluded.repo_id, repo_id) ELSE coalesce(repo_id, excluded.repo_id) END,
		   cwd     = CASE WHEN excluded.last_event_at >= last_event_at
		                  THEN coalesce(excluded.cwd, cwd) ELSE coalesce(cwd, excluded.cwd) END,
		   branch  = CASE WHEN excluded.last_event_at >= last_event_at
		                  THEN coalesce(excluded.branch, branch) ELSE coalesce(branch, excluded.branch) END,
		   model   = CASE WHEN excluded.last_event_at >= last_event_at
		                  THEN coalesce(excluded.model, model) ELSE coalesce(model, excluded.model) END,
		   last_event_at = max(last_event_at, excluded.last_event_at),
		   started_at    = min(started_at, excluded.started_at)`,
	);
	const upsertAgent = db.query(
		`INSERT INTO agents (id, session_id, parent_agent_id, kind, label) VALUES ($id, $session_id, $parent, $kind, $label)
		 ON CONFLICT(id) DO UPDATE SET label = coalesce(excluded.label, label)`,
	);
	const remapCounter = { n: 0 };
	const resolveRepo = repoResolver(db, remapCounter);
	// A parent must be an agent of the same session (F10: no cross-session references).
	const agentInSession = db.query<
		{ one: number },
		{ id: string; session_id: string }
	>("SELECT 1 AS one FROM agents WHERE id = $id AND session_id = $session_id");
	const lastEventAt = db.query<{ last_event_at: string }, { id: string }>(
		"SELECT last_event_at FROM sessions WHERE id = $id",
	);
	const endAgent = db.query(
		"UPDATE agents SET ended_at = coalesce(ended_at, $ts) WHERE id = $id",
	);
	const endAllAgents = db.query(
		"UPDATE agents SET ended_at = coalesce(ended_at, $ts) WHERE session_id = $session_id",
	);
	// Resume (F09): a newer event reopens the main agent a SessionEnd closed. Subagents stay ended.
	// Same-ts policy (re-audit N01): the later ARRIVAL wins — `<=`, the same comparison as `newest`.
	const reopenAgent = db.query(
		"UPDATE agents SET ended_at = NULL WHERE id = $id AND ended_at IS NOT NULL AND ended_at <= $ts",
	);
	const getEvent = db.query<EventRow, { id: string }>(
		"SELECT * FROM events WHERE id = $id",
	);
	const getSession = db.query<Session, { id: string }>(
		"SELECT * FROM sessions WHERE id = $id",
	);

	const result: IngestResult = {
		accepted: 0,
		duplicates: 0,
		remapped: 0,
		events: [],
		sessions: [],
	};
	const touchedSessions = new Set<string>();

	db.transaction(() => {
		for (const ev of batch) {
			// Duplicate (earlier request or earlier in this batch) → no side effects at all.
			if (getEvent.get({ id: ev.id })) {
				result.duplicates++;
				continue;
			}

			const ts = utc(ev.ts);
			const mainAgent = mainAgentId(ev.session_id);
			const repoId = ev.repo_id ? resolveRepo(ev.repo_id) : null;
			const agentId = ev.agent_id ?? mainAgent;
			const status = nextStatus(ev.type);
			// Decided before the upsert moves last_event_at: does this event supersede the session's
			// current state? Agent end / reopen follow the same rule as status (F09).
			const prevLast = lastEventAt.get({ id: ev.session_id })?.last_event_at;
			const newest = prevLast === undefined || ts >= prevLast;

			// FK order: machine → session → main agent → subagent → event.
			upsertMachine.run({
				id: ev.machine_id,
				hostname: ev.hostname ?? null,
				role: MachineRole.safeParse(ev.machine_id).success
					? ev.machine_id
					: null,
				ts,
			});
			upsertSession.run({
				id: ev.session_id,
				provider: ev.provider,
				machine_id: ev.machine_id,
				repo_id: repoId,
				cwd: ev.cwd ?? null,
				branch: ev.branch ?? null,
				model: ev.model ?? null,
				status,
				ts,
				ended_at: status === "ended" ? ts : null,
			});
			upsertAgent.run({
				id: mainAgent,
				session_id: ev.session_id,
				parent: null,
				kind: "main",
				label: null,
			});
			if (agentId !== mainAgent) {
				// Unknown parent → hang the subagent off the main agent instead of failing the batch.
				const parent =
					ev.parent_agent_id &&
					agentInSession.get({
						id: ev.parent_agent_id,
						session_id: ev.session_id,
					})
						? ev.parent_agent_id
						: mainAgent;
				upsertAgent.run({
					id: agentId,
					session_id: ev.session_id,
					parent,
					kind: ev.agent_kind ?? "subagent",
					label: ev.agent_label ?? null,
				});
				if (endsAgent(ev.type, ev.tool)) endAgent.run({ id: agentId, ts });
			}
			// A late SessionEnd (older than what the session already saw) ends nothing; a newer
			// non-end event after SessionEnd is a resume and reopens the main agent.
			if (newest && status === "ended") {
				endAllAgents.run({ session_id: ev.session_id, ts });
			} else if (newest) {
				reopenAgent.run({ id: mainAgent, ts });
			}

			// Already sanitized above (sanitizeEvent on the whole batch).
			insertEvent.run({
				id: ev.id,
				ts,
				machine_id: ev.machine_id,
				session_id: ev.session_id,
				agent_id: agentId,
				provider: ev.provider,
				type: ev.type,
				tool: ev.tool,
				summary: ev.summary,
				repo_id: repoId,
				payload: JSON.stringify(ev.payload_redacted ?? {}),
			});
			result.accepted++;
			const row = getEvent.get({ id: ev.id });
			if (row) result.events.push(toEvent(row));
			touchedSessions.add(ev.session_id);
		}
		for (const id of touchedSessions) {
			const s = getSession.get({ id });
			if (s) result.sessions.push(s);
		}
	})();

	result.remapped = remapCounter.n;
	return result;
}

/**
 * Repo id → the one spelling the DB uses for it (F13). GitHub names are case-insensitive and
 * collectors derive slugs from remote URLs, so: a repos row (GitHub row before a local-only one) →
 * else the casing sessions already use → else the normalized input. When the incoming spelling
 * differs from the resolved one, existing references to it are re-pointed too. Memoized per batch.
 */
function repoResolver(
	db: Database,
	counter: { n: number } = { n: 0 },
): (raw: string) => string {
	const repoRow = db.query<{ id: string }, { id: string }>(
		"SELECT id FROM repos WHERE id = $id COLLATE NOCASE ORDER BY is_local_only, id LIMIT 1",
	);
	const sessionRef = db.query<{ repo_id: string }, { id: string }>(
		"SELECT repo_id FROM sessions WHERE repo_id = $id COLLATE NOCASE ORDER BY started_at LIMIT 1",
	);
	const memo = new Map<string, string>();
	return (raw) => {
		const id = normalizeRepoId(raw);
		const hit = memo.get(id);
		if (hit !== undefined) return hit;
		const resolved =
			repoRow.get({ id })?.id ?? sessionRef.get({ id })?.repo_id ?? id;
		// A variant spelling showed up: re-point every case variant of the canonical id now (not just
		// this one), so older rows and clients converge immediately (N07). Only runs on a mismatch.
		if (resolved !== id) counter.n += repointVariants(db, resolved);
		memo.set(id, resolved);
		return resolved;
	};
}

const REPO_REF_TABLES = ["sessions", "events", "repo_paths"] as const;

/** Exact-match re-point (indexed on every table). Returns rows changed. Sessions get rev + 1. */
function repointRepo(db: Database, from: string, to: string): number {
	let changed = 0;
	for (const table of REPO_REF_TABLES) {
		const bump = table === "sessions" ? ", rev = rev + 1" : "";
		changed += db
			.query(`UPDATE ${table} SET repo_id = $to${bump} WHERE repo_id = $from`)
			.run({ from, to }).changes;
	}
	return changed;
}

/** Re-point every case variant of `canonical` to it (all ref tables). Sessions get rev + 1. */
function repointVariants(db: Database, canonical: string): number {
	let changed = 0;
	for (const table of REPO_REF_TABLES) {
		const bump = table === "sessions" ? ", rev = rev + 1" : "";
		changed += db
			.query(
				`UPDATE ${table} SET repo_id = $to${bump}
				 WHERE repo_id = $to COLLATE NOCASE AND repo_id != $to`,
			)
			.run({ to: canonical }).changes;
	}
	return changed;
}

/**
 * Re-point every reference whose repo_id is only a case variant of a repos row to that row's id,
 * and fold local-only rows into their GitHub twin (F13). Run after sync upserts repos: sessions /
 * events ingested before the canonical row existed would otherwise never JOIN to it. Returns the
 * number of reference rows changed.
 */
export function remapRepoIds(db: Database): number {
	const canonical = db.query<{ id: string }, { id: string }>(
		"SELECT id FROM repos WHERE id = $id COLLATE NOCASE ORDER BY is_local_only, id LIMIT 1",
	);
	let changed = 0;
	db.transaction(() => {
		const twins = db
			.query<{ local: string; gh: string }, []>(
				`SELECT l.id AS local, g.id AS gh FROM repos l
				 JOIN repos g ON g.id = l.id COLLATE NOCASE AND g.id != l.id
				 WHERE l.is_local_only = 1 AND g.is_local_only = 0`,
			)
			.all();
		const dropRepo = db.query("DELETE FROM repos WHERE id = $id");
		for (const { local, gh } of twins) {
			changed += repointRepo(db, local, gh);
			dropRepo.run({ id: local });
		}
		for (const table of REPO_REF_TABLES) {
			const orphans = db
				.query<{ repo_id: string }, []>(
					`SELECT DISTINCT repo_id FROM ${table}
					 WHERE repo_id IS NOT NULL AND repo_id NOT IN (SELECT id FROM repos)`,
				)
				.all();
			for (const { repo_id } of orphans) {
				const to = canonical.get({ id: repo_id })?.id;
				if (to && to !== repo_id) changed += repointRepo(db, repo_id, to);
			}
		}
	})();
	return changed;
}

/** Apply applyStale() to every candidate session. Returns the sessions that changed. */
export function sweepStale(db: Database, now: Date): Session[] {
	const cutoff = new Date(now.getTime() - STALE_AFTER_MS).toISOString();
	// SQL narrows the candidates; applyStale stays the single source of truth for the rule.
	const candidates = db
		.query<Session, { cutoff: string }>(
			"SELECT * FROM sessions WHERE status NOT IN ('ended', 'stale') AND last_event_at <= $cutoff",
		)
		.all({ cutoff });
	const update = db.query(
		"UPDATE sessions SET status = $status, rev = rev + 1 WHERE id = $id AND status = $prev",
	);
	const reread = db.query<Session, { id: string }>(
		"SELECT * FROM sessions WHERE id = $id",
	);
	const changed: Session[] = [];
	db.transaction(() => {
		for (const s of candidates) {
			const next = applyStale(s.status, s.last_event_at, now);
			if (next === s.status) continue;
			if (update.run({ id: s.id, status: next, prev: s.status }).changes === 0)
				continue;
			const row = reread.get({ id: s.id }); // carries the bumped rev
			if (row) changed.push(row);
		}
	})();
	return changed;
}

type Flag = "is_private" | "is_archived" | "is_fork" | "is_local_only";
type RepoRow = Omit<Repo, Flag> &
	Record<Flag, number> & { active_sessions: number };

export type RepoView = Repo & { active_sessions: number };

/** Repos grouped by district, each with its count of live (active/waiting/idle) sessions. */
export function listReposByDistrict(db: Database): Record<string, RepoView[]> {
	const rows = db
		.query<RepoRow, []>(
			`SELECT r.*, coalesce(s.n, 0) AS active_sessions
			 FROM repos r
			 LEFT JOIN (
			   SELECT repo_id, count(*) AS n FROM sessions
			   WHERE status IN ('active', 'waiting', 'idle') AND repo_id IS NOT NULL
			   GROUP BY repo_id
			 ) s ON s.repo_id = r.id
			 ORDER BY r.district, r.pushed_at DESC`,
		)
		.all();
	const out: Record<string, RepoView[]> = {};
	for (const r of rows) {
		const list = out[r.district] ?? [];
		list.push({
			...r,
			is_private: r.is_private === 1,
			is_archived: r.is_archived === 1,
			is_fork: r.is_fork === 1,
			is_local_only: r.is_local_only === 1,
		});
		out[r.district] = list;
	}
	return out;
}

/** Sessions, `waiting` first, then most recent. */
export function listSessions(
	db: Database,
	statuses: readonly SessionStatus[],
): Session[] {
	const where = statuses.length
		? `WHERE status IN (${statuses.map((_, i) => `$s${i}`).join(", ")})`
		: "";
	const params = Object.fromEntries(statuses.map((s, i) => [`s${i}`, s]));
	return db
		.query<Session, Record<string, string>>(
			`SELECT * FROM sessions ${where}
			 ORDER BY (status = 'waiting') DESC, last_event_at DESC LIMIT 500`,
		)
		.all(params);
}

export interface EventQuery {
	since: string | null;
	repo: string | null;
	provider: string | null;
	limit: number;
}

/** Newest first; `since` is exclusive. */
export function listEvents(db: Database, q: EventQuery): Event[] {
	const clauses: string[] = [];
	const params: Record<string, string | number> = { limit: q.limit };
	if (q.since) {
		clauses.push("ts > $since");
		params.since = utc(q.since);
	}
	if (q.repo) {
		clauses.push("repo_id = $repo");
		params.repo = q.repo;
	}
	if (q.provider) {
		clauses.push("provider = $provider");
		params.provider = q.provider;
	}
	const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
	return db
		.query<EventRow, Record<string, string | number>>(
			`SELECT * FROM events ${where} ORDER BY ts DESC, id DESC LIMIT $limit`,
		)
		.all(params)
		.map(toEvent);
}

export function listAgents(db: Database, sessionId: string): Agent[] {
	return db
		.query<Agent, { id: string }>(
			"SELECT * FROM agents WHERE session_id = $id ORDER BY kind, id",
		)
		.all({ id: sessionId });
}
