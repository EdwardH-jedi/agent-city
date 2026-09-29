// All hub SQL. Routes stay thin; everything here is synchronous bun:sqlite.
import type { Database } from "bun:sqlite";
import {
	type Agent,
	applyStale,
	type Event,
	endsAgent,
	type IngestEvent,
	MachineRole,
	nextStatus,
	type Repo,
	type Session,
	type SessionStatus,
	STALE_AFTER_MS,
	sanitizeEvent,
} from "@agent-city/schema";

export interface IngestResult {
	accepted: number;
	duplicates: number;
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
	// sanitized id is the dedupe key and the sanitized machine id the FK value.
	const batch = rawBatch.map((e) => sanitizeEvent(e));
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
		`INSERT INTO sessions (id, provider, machine_id, repo_id, cwd, branch, model, status, started_at, last_event_at, ended_at)
		 VALUES ($id, $provider, $machine_id, $repo_id, $cwd, $branch, $model, $status, $ts, $ts, $ended_at)
		 ON CONFLICT(id) DO UPDATE SET
		   -- only a newer (or same-instant) event may move status; late arrivals just fill gaps
		   status        = CASE WHEN excluded.last_event_at >= last_event_at THEN excluded.status ELSE status END,
		   ended_at      = CASE WHEN excluded.last_event_at >= last_event_at THEN excluded.ended_at ELSE ended_at END,
		   last_event_at = max(last_event_at, excluded.last_event_at),
		   started_at    = min(started_at, excluded.started_at),
		   repo_id = coalesce(excluded.repo_id, repo_id),
		   cwd     = coalesce(excluded.cwd, cwd),
		   branch  = coalesce(excluded.branch, branch),
		   model   = coalesce(excluded.model, model)`,
	);
	const upsertAgent = db.query(
		`INSERT INTO agents (id, session_id, parent_agent_id, kind, label) VALUES ($id, $session_id, $parent, $kind, $label)
		 ON CONFLICT(id) DO UPDATE SET label = coalesce(excluded.label, label)`,
	);
	// GitHub names are case-insensitive; collectors derive slugs from remote URLs → use the canonical row id.
	const canonicalRepo = db.query<{ id: string }, { id: string }>(
		"SELECT id FROM repos WHERE id = $id COLLATE NOCASE LIMIT 1",
	);
	const agentExists = db.query<{ one: number }, { id: string }>(
		"SELECT 1 AS one FROM agents WHERE id = $id",
	);
	const endAgent = db.query(
		"UPDATE agents SET ended_at = coalesce(ended_at, $ts) WHERE id = $id",
	);
	const endAllAgents = db.query(
		"UPDATE agents SET ended_at = coalesce(ended_at, $ts) WHERE session_id = $session_id",
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
			const mainAgent = ev.session_id;
			const repoId = ev.repo_id
				? (canonicalRepo.get({ id: ev.repo_id })?.id ?? ev.repo_id)
				: null;
			const agentId = ev.agent_id ?? mainAgent;
			const status = nextStatus(ev.type);

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
					ev.parent_agent_id && agentExists.get({ id: ev.parent_agent_id })
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
			if (status === "ended") {
				endAllAgents.run({ session_id: ev.session_id, ts });
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

	return result;
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
		"UPDATE sessions SET status = $status WHERE id = $id AND status = $prev",
	);
	const changed: Session[] = [];
	db.transaction(() => {
		for (const s of candidates) {
			const next = applyStale(s.status, s.last_event_at, now);
			if (next === s.status) continue;
			update.run({ id: s.id, status: next, prev: s.status });
			changed.push({ ...s, status: next });
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
