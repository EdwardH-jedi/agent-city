// All hub SQL. Routes stay thin; everything here is synchronous bun:sqlite.
import type { Database } from "bun:sqlite";
import {
	type Agent,
	applyStale,
	compareInstants,
	dayMinus,
	type Event,
	endsAgent,
	type Heartbeat,
	type IngestEvent,
	type MachineLiveness,
	MachineRole,
	type MachineView,
	machineStatus,
	mainAgentId,
	sessionId as namespacedSessionId,
	namespaceIds,
	nextStatus,
	normalizeRepoId,
	type Repo,
	type RunEventView,
	type RunsPayload,
	type RunView,
	runStateAt,
	type Session,
	type SessionStatus,
	STALE_AFTER_MS,
	safeText,
	sanitizeEvent,
	USAGE_TZ,
	type UsageLimitView,
	type UsageReport,
	type UsageSummary,
	type UsageSummaryRow,
	usageDay,
	usageLabel,
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

interface MachineRow {
	id: string;
	hostname: string | null;
	heartbeat_at: string | null;
	heartbeat_boot: string | null;
	heartbeat_seq: number | null;
	heartbeat_interval_s: number | null;
}

const MACHINE_COLUMNS =
	"id, hostname, heartbeat_at, heartbeat_boot, heartbeat_seq, heartbeat_interval_s";

const toMachineView = (
	role: MachineRole,
	row: MachineRow | null | undefined,
	now: Date,
): MachineView => ({
	id: role,
	hostname: row?.hostname ?? null,
	heartbeat_at: row?.heartbeat_at ?? null,
	interval_s: row?.heartbeat_interval_s ?? null,
	status: machineStatus(row?.heartbeat_at ?? null, now),
});

export interface HeartbeatResult {
	/** false → a repeat or out-of-order beat of the same boot: nothing was changed. */
	accepted: boolean;
	machine: MachineView;
}

/**
 * Record one heartbeat. The liveness clock is `now` (the hub's receive time); the sender's `sent_at`
 * is never stored. Within one `boot_id` the sequence must increase, so a retransmitted or reordered
 * beat is a harmless no-op; a new `boot_id` is a restart and is always accepted.
 */
export function recordHeartbeat(
	db: Database,
	hb: Heartbeat,
	now: Date,
): HeartbeatResult {
	const hostname = safeText(hb.hostname, 64);
	const apply = db.transaction(() => {
		db.query(
			`INSERT INTO machines (id, hostname, role) VALUES ($id, $hostname, $id)
			 ON CONFLICT(id) DO NOTHING`,
		).run({ id: hb.machine_id, hostname });
		const read = () =>
			db
				.query<MachineRow, { id: string }>(
					`SELECT ${MACHINE_COLUMNS} FROM machines WHERE id = $id`,
				)
				.get({ id: hb.machine_id });
		const before = read();
		const repeat =
			before?.heartbeat_boot === hb.boot_id &&
			before.heartbeat_seq !== null &&
			hb.seq <= before.heartbeat_seq;
		if (repeat) return { accepted: false, row: before };
		db.query(
			`UPDATE machines SET
			   hostname = coalesce($hostname, hostname),
			   heartbeat_at = $at,
			   heartbeat_boot = $boot,
			   heartbeat_seq = $seq,
			   heartbeat_interval_s = $interval
			 WHERE id = $id`,
		).run({
			id: hb.machine_id,
			hostname,
			at: now.toISOString(),
			boot: hb.boot_id,
			seq: hb.seq,
			interval: hb.interval_s,
		});
		return { accepted: true, row: read() };
	});
	const { accepted, row } = apply();
	return { accepted, machine: toMachineView(hb.machine_id, row, now) };
}

/** Always one row per MachineRole (cockpit, forge, spine); a machine never heard from is `unobserved`. */
export function listMachines(db: Database, now: Date): MachineView[] {
	const rows = db
		.query<MachineRow, []>(`SELECT ${MACHINE_COLUMNS} FROM machines`)
		.all();
	const byId = new Map(rows.map((r) => [r.id, r]));
	return MachineRole.options.map((role) =>
		toMachineView(role, byId.get(role), now),
	);
}

// ── Office run projection ─────────────────────────────────────────────────────────────────
// Stored exactly as reported (never re-interpreted). The only thing City adds is its own receive time
// and, from that and the machine heartbeat, whether the snapshot has gone stale (runStateAt).

interface RunRow {
	machine_id: MachineRole;
	run_id: string;
	project: string | null;
	workflow_id: string;
	phase: string;
	status: string;
	reason: string | null;
	alert: string | null;
	last_progress_at: string | null;
	idle_seconds: number | null;
	completed: string;
	tokens_today: number | null;
	usage_unknown: number;
	evidence_verified: number;
	last_event_sequence: number | null;
	ledger_revision: number;
	observed_at: string;
	received_at: string;
}

const toRunView = (
	r: RunRow,
	machine: MachineLiveness,
	now: Date,
): RunView => ({
	machine_id: r.machine_id,
	run_id: r.run_id,
	project: r.project,
	workflow_id: r.workflow_id,
	phase: r.phase,
	status: r.status,
	reason: r.reason,
	alert: r.alert,
	last_progress_at: r.last_progress_at,
	idle_seconds: r.idle_seconds,
	completed: JSON.parse(r.completed) as string[],
	tokens_today: r.tokens_today,
	usage_unknown: r.usage_unknown === 1,
	evidence_verified: r.evidence_verified === 1,
	last_event_sequence: r.last_event_sequence,
	ledger_revision: r.ledger_revision,
	observed_at: r.observed_at,
	reported_at: r.received_at,
	...runStateAt(
		{
			status: r.status,
			reason: r.reason,
			alert: r.alert,
			evidence_verified: r.evidence_verified === 1,
		},
		r.received_at,
		machine,
		now,
	),
});

export interface RunsResult {
	/** Runs whose stored state was replaced by this report. */
	applied: number;
	/** Runs skipped because the report was older than what is stored. */
	ignored: number;
	/** Views of the applied runs, to broadcast after the commit. */
	views: RunView[];
}

/**
 * Store one run report. Order: a higher `ledger_revision` wins, then a higher `last_event_sequence`;
 * at the same position only a strictly newer `observed_at` wins (an idle alert appears without any
 * new ledger event), compared exactly (sub-millisecond, offsets applied). An older or equal report
 * changes nothing, not even the receive time. Events are unique by (machine, run, sequence).
 */
export function upsertRuns(
	db: Database,
	payload: RunsPayload,
	now: Date,
): RunsResult {
	const at = now.toISOString();
	const apply = db.transaction(() => {
		db.query(
			`INSERT INTO machines (id, hostname, role) VALUES ($id, NULL, $id)
			 ON CONFLICT(id) DO NOTHING`,
		).run({ id: payload.machine_id });
		const keys: string[] = [];
		let ignored = 0;
		for (const run of payload.runs) {
			const seq = run.last_event_sequence ?? -1;
			const prev = db
				.query<
					{
						ledger_revision: number;
						last_event_sequence: number | null;
						observed_at: string;
					},
					{ m: string; r: string }
				>(
					"SELECT ledger_revision, last_event_sequence, observed_at FROM runs WHERE machine_id = $m AND run_id = $r",
				)
				.get({ m: payload.machine_id, r: run.run_id });
			if (prev) {
				const order =
					payload.ledger_revision !== prev.ledger_revision
						? payload.ledger_revision - prev.ledger_revision
						: seq - (prev.last_event_sequence ?? -1);
				// Same position: only a strictly newer observed_at applies. An equal one (a replay, or a
				// different body claiming the same instant) is ignored and does not refresh received_at, so a
				// replay cannot turn a stale run back into a fresh one.
				const notNewer =
					order < 0 ||
					(order === 0 &&
						compareInstants(payload.observed_at, prev.observed_at) <= 0);
				if (notNewer) {
					ignored++;
					continue;
				}
			}
			db.query(
				`INSERT INTO runs (machine_id, run_id, project, workflow_id, phase, status, reason, alert,
				   last_progress_at, idle_seconds, completed, tokens_today, usage_unknown, evidence_verified,
				   last_event_sequence, ledger_revision, observed_at, received_at)
				 VALUES ($machine_id, $run_id, $project, $workflow_id, $phase, $status, $reason, $alert,
				   $last_progress_at, $idle_seconds, $completed, $tokens_today, $usage_unknown, $evidence_verified,
				   $last_event_sequence, $ledger_revision, $observed_at, $received_at)
				 ON CONFLICT(machine_id, run_id) DO UPDATE SET
				   project = excluded.project, workflow_id = excluded.workflow_id, phase = excluded.phase,
				   status = excluded.status, reason = excluded.reason, alert = excluded.alert,
				   last_progress_at = excluded.last_progress_at, idle_seconds = excluded.idle_seconds,
				   completed = excluded.completed, tokens_today = excluded.tokens_today,
				   usage_unknown = excluded.usage_unknown, evidence_verified = excluded.evidence_verified,
				   last_event_sequence = excluded.last_event_sequence, ledger_revision = excluded.ledger_revision,
				   observed_at = excluded.observed_at, received_at = excluded.received_at`,
			).run({
				machine_id: payload.machine_id,
				run_id: run.run_id,
				project: run.project,
				workflow_id: run.workflow_id,
				phase: run.phase,
				status: run.status,
				reason: run.reason,
				alert: run.alert,
				last_progress_at: run.last_progress_at,
				idle_seconds: run.idle_seconds,
				completed: JSON.stringify(run.completed),
				tokens_today: run.tokens_today,
				usage_unknown: run.usage_unknown ? 1 : 0,
				evidence_verified: run.evidence_verified ? 1 : 0,
				last_event_sequence: run.last_event_sequence,
				ledger_revision: payload.ledger_revision,
				observed_at: payload.observed_at,
				received_at: at,
			});
			for (const e of run.events) {
				db.query(
					`INSERT OR IGNORE INTO run_events (machine_id, run_id, sequence, transition, occurred_at, task_id,
					   attempt, outcome, reason, review_verdict, commit_sha, base_commit, diff_digest, tree_digest,
					   test_run_key, model, from_model, to_model)
					 VALUES ($machine_id, $run_id, $sequence, $transition, $occurred_at, $task_id,
					   $attempt, $outcome, $reason, $review_verdict, $commit_sha, $base_commit, $diff_digest, $tree_digest,
					   $test_run_key, $model, $from_model, $to_model)`,
				).run({
					machine_id: payload.machine_id,
					run_id: run.run_id,
					sequence: e.sequence,
					transition: e.transition,
					occurred_at: e.occurred_at ?? null,
					task_id: e.task_id ?? null,
					attempt: e.attempt ?? null,
					outcome: e.outcome ?? null,
					reason: e.reason ?? null,
					review_verdict: e.review_verdict ?? null,
					commit_sha: e.commit ?? null,
					base_commit: e.base_commit ?? null,
					diff_digest: e.diff_digest ?? null,
					tree_digest: e.tree_digest ?? null,
					test_run_key: e.test_run_key ?? null,
					model: e.model ?? null,
					from_model: e.from_model ?? null,
					to_model: e.to_model ?? null,
				});
			}
			keys.push(run.run_id);
		}
		return { keys, ignored };
	});
	const { keys, ignored } = apply();
	const machine = listMachines(db, now).find(
		(m) => m.id === payload.machine_id,
	);
	const views = keys.flatMap((id) => {
		const row = db
			.query<RunRow, { m: string; r: string }>(
				"SELECT * FROM runs WHERE machine_id = $m AND run_id = $r",
			)
			.get({ m: payload.machine_id, r: id });
		return row ? [toRunView(row, machine?.status ?? "unobserved", now)] : [];
	});
	return { applied: keys.length, ignored, views };
}

/** Newest report first. The status shown depends on the hub clock and the machine's heartbeat. */
export function listRuns(db: Database, now: Date, limit = 200): RunView[] {
	const machines = new Map(listMachines(db, now).map((m) => [m.id, m.status]));
	return db
		.query<RunRow, { limit: number }>(
			"SELECT * FROM runs ORDER BY received_at DESC, run_id LIMIT $limit",
		)
		.all({ limit })
		.map((r) => toRunView(r, machines.get(r.machine_id) ?? "unobserved", now));
}

/** Recent events of one run, newest first. */
export function listRunEvents(
	db: Database,
	machine: string,
	runId: string,
	limit = 200,
): RunEventView[] {
	return db
		.query<
			Omit<RunEventView, "commit"> & { commit_sha: string | null },
			{ m: string; r: string; limit: number }
		>(
			"SELECT * FROM run_events WHERE machine_id = $m AND run_id = $r ORDER BY sequence DESC LIMIT $limit",
		)
		.all({ m: machine, r: runId, limit })
		.map(({ commit_sha, ...rest }) => ({ ...rest, commit: commit_sha }));
}

// ── token usage (M1, 18 §5.1) ──────────────────────────────────────────────────────────────────────

/** Rows for days outside this window around the hub's today are ignored (a skewed or replayed report). */
export const USAGE_ACCEPT_PAST_DAYS = 40;

export interface UsageResult {
	/** Rows inside the accepted day window (stored or already equal). */
	accepted: number;
	/** Rows that grew (or were new). */
	changed: number;
	/** Rows outside the day window or naming a session of another tool. */
	ignored: number;
	limits: number;
}

/**
 * Upsert one collector report. Per (session_id, day, model) every count keeps the larger value, so a
 * repeat or an older total changes nothing. Strings are re-checked here (collectors are not trusted):
 * the session id goes through ids.ts again, the model through usageLabel, the project through
 * normalizeRepoId + safeText. Limits: the newest `observed_at` per (machine, tool, limit, window) wins.
 */
export function recordUsage(
	db: Database,
	report: UsageReport,
	now: Date,
): UsageResult {
	const result: UsageResult = {
		accepted: 0,
		changed: 0,
		ignored: 0,
		limits: 0,
	};
	const today = usageDay(now) ?? now.toISOString().slice(0, 10);
	const oldest = dayMinus(today, USAGE_ACCEPT_PAST_DAYS);
	const newest = dayMinus(today, -1);
	const at = now.toISOString();
	const upsert = db.query(
		`INSERT INTO usage (session_id, day, model, tool, project, machine_id, input_tokens,
		   output_tokens, cache_read_tokens, cache_write_tokens, messages, updated_at)
		 VALUES ($session, $day, $model, $tool, $project, $machine, $in, $out, $cr, $cw, $msgs, $at)
		 ON CONFLICT(session_id, day, model) DO UPDATE SET
		   input_tokens = max(input_tokens, excluded.input_tokens),
		   output_tokens = max(output_tokens, excluded.output_tokens),
		   cache_read_tokens = max(cache_read_tokens, excluded.cache_read_tokens),
		   cache_write_tokens = max(cache_write_tokens, excluded.cache_write_tokens),
		   messages = max(messages, excluded.messages),
		   project = coalesce(excluded.project, project),
		   machine_id = excluded.machine_id,
		   updated_at = excluded.updated_at
		 WHERE excluded.input_tokens > input_tokens
		    OR excluded.output_tokens > output_tokens
		    OR excluded.cache_read_tokens > cache_read_tokens
		    OR excluded.cache_write_tokens > cache_write_tokens
		    OR excluded.messages > messages
		    OR (excluded.project IS NOT NULL AND project IS NULL)`,
	);
	const limit = db.query(
		`INSERT INTO usage_limits (machine_id, tool, limit_id, window_minutes, used_percent, resets_at,
		   plan_type, observed_at, received_at)
		 VALUES ($machine, $tool, $id, $win, $pct, $resets, $plan, $observed, $at)
		 ON CONFLICT(machine_id, tool, limit_id, window_minutes) DO UPDATE SET
		   used_percent = excluded.used_percent, resets_at = excluded.resets_at,
		   plan_type = excluded.plan_type, observed_at = excluded.observed_at,
		   received_at = excluded.received_at
		 WHERE excluded.observed_at > observed_at`,
	);
	db.transaction(() => {
		for (const r of report.rows) {
			const session = namespacedSessionId(r.tool, r.session_id);
			if (
				r.day < oldest ||
				r.day > newest ||
				!r.session_id.startsWith(`${r.tool}:`)
			) {
				result.ignored++;
				continue;
			}
			const project =
				r.project === null ? null : safeText(normalizeRepoId(r.project), 256);
			const changes = upsert.run({
				session,
				day: r.day,
				model: usageLabel(r.model) ?? "unknown",
				tool: r.tool,
				project: project || null,
				machine: report.machine_id,
				in: r.input_tokens,
				out: r.output_tokens,
				cr: r.cache_read_tokens,
				cw: r.cache_write_tokens,
				msgs: r.messages,
				at,
			}).changes;
			result.accepted++;
			if (changes > 0) result.changed++;
		}
		for (const l of report.limits) {
			const observed = utc(l.observed_at);
			if (Date.parse(observed) > now.getTime() + 86_400_000) continue; // a clock far ahead
			result.limits += limit.run({
				machine: report.machine_id,
				tool: l.tool,
				id: usageLabel(l.limit_id) ?? "default",
				win: l.window_minutes,
				pct: l.used_percent,
				resets: l.resets_at === null ? null : utc(l.resets_at),
				plan: usageLabel(l.plan_type),
				observed,
				at,
			}).changes;
		}
	})();
	return result;
}

/**
 * Sums for the `days` days ending at the hub's Sydney today, per (day, project, tool, model). Projects
 * are folded case-insensitively onto the repos row's spelling (a GitHub row before a local-only one),
 * else the first spelling seen, so a later repo remap never splits a project.
 */
export function usageSummary(db: Database, now: Date, days = 7): UsageSummary {
	const today = usageDay(now) ?? now.toISOString().slice(0, 10);
	const list: string[] = [];
	for (let i = days - 1; i >= 0; i--) list.push(dayMinus(today, i));
	const from = list[0] ?? today;
	const rows = db
		.query<UsageSummaryRow, { from: string; to: string }>(
			`WITH u AS (
			   SELECT usage.*, coalesce(
			     (SELECT id FROM repos WHERE id = usage.project COLLATE NOCASE
			      ORDER BY is_local_only, id LIMIT 1),
			     (SELECT min(project) FROM usage AS v WHERE v.project = usage.project COLLATE NOCASE)
			   ) AS proj
			   FROM usage WHERE day >= $from AND day <= $to
			 )
			 SELECT day, proj AS project, tool, model,
			   sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
			   sum(cache_read_tokens) AS cache_read_tokens, sum(cache_write_tokens) AS cache_write_tokens,
			   sum(messages) AS messages, count(*) AS sessions
			 FROM u GROUP BY day, proj, tool, model
			 ORDER BY day, proj IS NULL, proj, tool, model`,
		)
		.all({ from, to: today });
	const limits = db
		.query<UsageLimitView, { since: string }>(
			`SELECT machine_id, tool, limit_id, window_minutes, used_percent, resets_at, plan_type,
			   observed_at, received_at
			 FROM usage_limits AS l
			 WHERE observed_at >= $since AND NOT EXISTS (
			   SELECT 1 FROM usage_limits AS n
			   WHERE n.tool = l.tool AND n.limit_id = l.limit_id AND n.window_minutes = l.window_minutes
			     AND (n.observed_at > l.observed_at
			          OR (n.observed_at = l.observed_at AND n.machine_id > l.machine_id)))
			 ORDER BY tool, limit_id, window_minutes`,
		)
		.all({ since: new Date(now.getTime() - 8 * 86_400_000).toISOString() });
	const updated =
		db
			.query<{ at: string | null }, { from: string }>(
				"SELECT max(updated_at) AS at FROM usage WHERE day >= $from",
			)
			.get({ from })?.at ?? null;
	return { tz: USAGE_TZ, today, days: list, rows, limits, updated_at: updated };
}
