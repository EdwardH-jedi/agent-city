// Row schemas. Field names are snake_case and match migrations/002_event_model.sql 1:1, so a DB row
// is a valid value of its type (booleans are 0/1 in SQLite; the hub converts at the boundary).
// Timestamps are ISO-8601 UTC strings.
import { z } from "zod";
import {
	HEARTBEAT_INTERVAL_MAX_S,
	HEARTBEAT_INTERVAL_MIN_S,
	MAX_INGEST_BATCH,
} from "./limits.ts";

const Ts = z.iso.datetime({ offset: true });

export const MachineRole = z.enum(["cockpit", "forge", "spine"]);
export type MachineRole = z.infer<typeof MachineRole>;

export const Provider = z.enum(["claude", "codex", "ollama"]);
export type Provider = z.infer<typeof Provider>;

export const CiStatus = z.enum(["success", "failure", "running", "none"]);
export type CiStatus = z.infer<typeof CiStatus>;

export const SessionStatus = z.enum([
	"active",
	"waiting",
	"idle",
	"stale",
	"ended",
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const AgentKind = z.enum(["main", "subagent"]);
export type AgentKind = z.infer<typeof AgentKind>;

/** What the screen shows per machine. A machine fact, never the success of any AI work. */
export const MachineLiveness = z.enum([
	"online",
	"stale",
	"offline",
	"unobserved",
]);
export type MachineLiveness = z.infer<typeof MachineLiveness>;

/**
 * POST /ingest/heartbeat body. Strict: an unknown key is a 400, and there is deliberately no field
 * that could carry a path, command or prompt.
 */
export const Heartbeat = z.strictObject({
	schema: z.literal(1),
	machine_id: MachineRole,
	hostname: z.string().min(1).max(64).optional(),
	boot_id: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
	seq: z.number().int().nonnegative(),
	/** Sender clock. Only for showing a clock difference; liveness never uses it. */
	sent_at: Ts,
	interval_s: z
		.number()
		.int()
		.min(HEARTBEAT_INTERVAL_MIN_S)
		.max(HEARTBEAT_INTERVAL_MAX_S),
});
export type Heartbeat = z.infer<typeof Heartbeat>;

/** GET /api/machines row. Always one per MachineRole; `unobserved` when nothing was ever received. */
export const MachineView = z.object({
	id: MachineRole,
	hostname: z.string().nullable(),
	/** Hub receive time of the latest accepted heartbeat. */
	heartbeat_at: Ts.nullable(),
	interval_s: z.number().int().nullable(),
	status: MachineLiveness,
});
export type MachineView = z.infer<typeof MachineView>;

export const Machine = z.object({
	id: z.string().min(1),
	hostname: z.string().nullable(),
	role: MachineRole.nullable(),
	last_seen_at: Ts.nullable(),
});
export type Machine = z.infer<typeof Machine>;

export const Repo = z.object({
	id: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "owner/name"),
	is_private: z.boolean(),
	is_archived: z.boolean(),
	is_fork: z.boolean(),
	language: z.string().nullable(),
	pushed_at: Ts.nullable(),
	commits_30d: z.number().int().nonnegative().nullable(),
	open_prs: z.number().int().nonnegative().nullable(),
	open_issues: z.number().int().nonnegative().nullable(),
	ci_status: CiStatus,
	ci_updated_at: Ts.nullable(),
	district: z.string().min(1),
	is_local_only: z.boolean(),
	synced_at: Ts.nullable(),
});
export type Repo = z.infer<typeof Repo>;

export const RepoPath = z.object({
	machine_id: z.string().min(1),
	path: z.string().min(1),
	repo_id: z.string().min(1),
	is_worktree: z.boolean(),
});
export type RepoPath = z.infer<typeof RepoPath>;

export const Session = z.object({
	id: z.string().min(1),
	provider: Provider,
	machine_id: z.string().min(1),
	repo_id: z.string().nullable(),
	cwd: z.string().nullable(),
	branch: z.string().nullable(),
	model: z.string().nullable(),
	status: SessionStatus,
	started_at: Ts,
	last_event_at: Ts,
	ended_at: Ts.nullable(),
	/** Version: +1 on every write to the row (re-audit N05); clients keep the higher rev. */
	rev: z.number().int().nonnegative(),
});
export type Session = z.infer<typeof Session>;

export const Agent = z.object({
	id: z.string().min(1),
	session_id: z.string().min(1),
	parent_agent_id: z.string().nullable(),
	kind: AgentKind,
	label: z.string().nullable(),
	ended_at: Ts.nullable(), // set on SubagentStop (migration 003)
});
export type Agent = z.infer<typeof Agent>;

/** Stored event. `type` stays a free string so unknown Codex record types are still recorded. */
export const Event = z.object({
	id: z.string().min(1),
	ts: Ts,
	machine_id: z.string().min(1),
	session_id: z.string().nullable(),
	agent_id: z.string().nullable(),
	provider: Provider,
	type: z.string().min(1),
	tool: z.string().nullable(),
	summary: z.string().nullable(),
	repo_id: z.string().nullable(),
	payload_redacted: z.record(z.string(), z.unknown()),
});
export type Event = z.infer<typeof Event>;

/**
 * What collectors POST to /ingest: an Event plus the session/agent context the hub needs to
 * auto-create or update the session and agent rows. Everything must already be redacted.
 */
export const IngestEvent = Event.extend({
	session_id: z.string().min(1),
	agent_id: z.string().nullable().default(null),
	tool: z.string().nullable().default(null),
	summary: z.string().nullable().default(null),
	repo_id: z.string().nullable().default(null),
	payload_redacted: z.record(z.string(), z.unknown()).default({}),
	cwd: z.string().nullable().optional(),
	branch: z.string().nullable().optional(),
	model: z.string().nullable().optional(),
	hostname: z.string().nullable().optional(),
	parent_agent_id: z.string().nullable().optional(),
	agent_kind: AgentKind.optional(),
	agent_label: z.string().nullable().optional(),
});
export type IngestEvent = z.infer<typeof IngestEvent>;

export const IngestBatch = z.array(IngestEvent).min(1).max(MAX_INGEST_BATCH);
export type IngestBatch = z.infer<typeof IngestBatch>;

/** POST /ingest body: a single event or a batch. */
export const IngestBody = z.union([IngestEvent, IngestBatch]);
export type IngestBody = z.infer<typeof IngestBody>;
