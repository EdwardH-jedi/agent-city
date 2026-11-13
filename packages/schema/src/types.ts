// Row schemas. Field names are snake_case and match migrations/002_event_model.sql 1:1, so a DB row
// is a valid value of its type (booleans are 0/1 in SQLite; the hub converts at the boundary).
// Timestamps are ISO-8601 UTC strings.
import { z } from "zod";
import {
	HEARTBEAT_INTERVAL_MAX_S,
	HEARTBEAT_INTERVAL_MIN_S,
	MAX_INGEST_BATCH,
	RUN_COMPLETED_MAX,
	RUN_EVENTS_MAX_PER_RUN,
	RUNS_MAX_PER_PAYLOAD,
} from "./limits.ts";
import { redact } from "./redact.ts";
import {
	USAGE_DAY_RE,
	USAGE_LABEL_RE,
	USAGE_MAX_LIMITS,
	USAGE_MAX_ROWS,
	USAGE_ROW_MAX,
} from "./usage.ts";

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

// ── Office run projection (POST /ingest/runs, GET /api/runs) ───────────────────────────────
// The cockpit pushes a read-only picture of its runs. Every string is a short code from a closed
// character class (no path separator, no quote, nothing token-shaped), so a goal text, an absolute
// path or a secret has no field to ride in. Field names are snake_case (City convention).

// Every check below is an allowlist shape plus two secret checks (`phase` is a closed enum; `project`
// skips the opaque check, see there), and every message is a fixed phrase: a rejected value is never
// echoed back.
//   - redact(v) === v: no self-identifying token (sk-, ghp_, AKIA, JWT, "Bearer x"…) inside it;
//   - not opaque: no long unbroken alphanumeric run that looks random. redact() only knows prefixed
//     tokens, so a bare random key (base64 / hex / mixed-case) is refused by its shape instead.
// Office's own codes are words joined by `_ . : -` (CODEX_REVIEW_RUNNING, task.started,
// station0-notes-2, run-0123456789abcdef), whose runs stay short.

/** Longest alphanumeric run allowed when it mixes digits or cases (a 16-hex key suffix is fine). */
const OPAQUE_MIXED_RUN = 20;
/** Longest alphanumeric run allowed at all. */
const OPAQUE_ANY_RUN = 32;

/** A long unbroken run of letters/digits that looks like a random key rather than a word. */
function looksOpaque(v: string): boolean {
	for (const run of v.split(/[^A-Za-z0-9]+/)) {
		if (run.length >= OPAQUE_ANY_RUN) return true;
		if (
			run.length >= OPAQUE_MIXED_RUN &&
			(/\d/.test(run) || (/[a-z]/.test(run) && /[A-Z]/.test(run)))
		)
			return true;
	}
	return false;
}

const notSecret = <T extends z.ZodString>(s: T) =>
	s
		.refine((v) => redact(v) === v, "secret-shaped")
		.refine((v) => !looksOpaque(v), "opaque-token-shaped");

/**
 * An id or code Office produced (run/workflow/task id, transition, model, event outcome…). Starts with
 * a letter or digit (no `.env`, `~`, `-flag`), has no path separator or space, no `..`, and is not a
 * drive letter (`C:`).
 */
const code = (max = 64) =>
	notSecret(
		z
			.string()
			.regex(new RegExp(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,${max - 1}}$`))
			.refine((v) => !v.includes(".."), "path-shaped")
			.refine((v) => !/^[A-Za-z]:/.test(v), "path-shaped"),
	);
/** A run-level status / reason / alert: Office's UPPER_SNAKE vocabulary (README state table). */
const upperCode = notSecret(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/));
const hex = z.string().regex(/^[0-9a-f]{7,64}$/);
/**
 * Pipeline phase: exactly one of Agent Office's phases (server/pipeline/store.mjs `phases`), so a
 * phase cannot carry prose or a credential. A phase Office adds later needs a City release.
 */
export const OfficePhase = z.enum([
	"Goal",
	"Plan",
	"Approval",
	"Implementation",
	"QA",
	"Independent Review",
	"Integration",
	"Cleanup",
	"Report",
]);
export type OfficePhase = z.infer<typeof OfficePhase>;
/**
 * GitHub `owner/repo`, configured by the Office owner (not run data). Exactly one slash; the owner
 * starts with a letter or digit (so `/Users/…`, `~/x`, `.ssh/id_rsa`, `a/b/c`, `C:\x` do not match);
 * the repo follows GitHub's rules: `[A-Za-z0-9._-]{1,100}`, may start with `.` (`.github`), is not
 * `.` or `..` and does not end in `.git`. Known token prefixes are refused via redact(); the
 * opaque-run heuristic is NOT applied here because ordinary long repo names trip it.
 */
const project = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9._-]{1,100}$/)
	.refine((v) => {
		const repo = v.slice(v.indexOf("/") + 1);
		return repo !== "." && repo !== ".." && !/\.git$/i.test(repo);
	}, "path-shaped")
	.refine((v) => redact(v) === v, "secret-shaped");

export const RunEventInput = z.strictObject({
	sequence: z.number().int().nonnegative(),
	transition: code(48),
	occurred_at: Ts.nullish(),
	task_id: code(32).nullish(),
	attempt: z.number().int().min(0).max(1000).nullish(),
	outcome: code().nullish(),
	reason: code().nullish(),
	review_verdict: code().nullish(),
	commit: hex.nullish(),
	base_commit: hex.nullish(),
	diff_digest: hex.nullish(),
	tree_digest: hex.nullish(),
	test_run_key: code(40).nullish(),
	model: code().nullish(),
	from_model: code().nullish(),
	to_model: code().nullish(),
});
export type RunEventInput = z.infer<typeof RunEventInput>;

export const RunInput = z.strictObject({
	run_id: code(128),
	project: project.nullable(),
	workflow_id: code(128),
	phase: OfficePhase,
	status: upperCode,
	reason: upperCode.nullable(),
	alert: upperCode.nullable(),
	last_progress_at: Ts.nullable(),
	idle_seconds: z.number().int().nonnegative().nullable(),
	completed: z.array(code(32)).max(RUN_COMPLETED_MAX),
	tokens_today: z.number().int().nonnegative().nullable(),
	usage_unknown: z.boolean(),
	evidence_verified: z.boolean(),
	last_event_sequence: z.number().int().nonnegative().nullable(),
	events: z.array(RunEventInput).max(RUN_EVENTS_MAX_PER_RUN),
});
export type RunInput = z.infer<typeof RunInput>;

export const RunsPayload = z.strictObject({
	schema: z.literal(1),
	source: z.literal("agent-office"),
	machine_id: MachineRole,
	/** Sender clock, display only; staleness is measured on the hub's receive time. */
	observed_at: Ts,
	ledger_revision: z.number().int().nonnegative(),
	runs: z.array(RunInput).max(RUNS_MAX_PER_PAYLOAD),
});
export type RunsPayload = z.infer<typeof RunsPayload>;

/** What the screen shows for a run. Office decides all but `snapshot_stale`; City only adds that. */
export const RunDisplay = z.enum([
	"running",
	"no_progress_suspected",
	"needs_reconcile",
	"waiting_owner",
	"paused",
	"hold",
	"passed",
	"partial",
	"unverified",
	"unknown",
	"snapshot_stale",
]);
export type RunDisplay = z.infer<typeof RunDisplay>;

/** GET /api/runs row: the reported fields plus what City itself knows (receive time, staleness). */
export const RunView = z.object({
	machine_id: MachineRole,
	run_id: z.string(),
	project: z.string().nullable(),
	workflow_id: z.string(),
	phase: z.string(),
	status: z.string(),
	reason: z.string().nullable(),
	alert: z.string().nullable(),
	last_progress_at: Ts.nullable(),
	idle_seconds: z.number().int().nullable(),
	completed: z.array(z.string()),
	tokens_today: z.number().int().nullable(),
	usage_unknown: z.boolean(),
	evidence_verified: z.boolean(),
	last_event_sequence: z.number().int().nullable(),
	ledger_revision: z.number().int(),
	/** Sender clock of the stored report; orders reports at the same ledger position (never staleness). */
	observed_at: Ts,
	/** Hub receive time of the latest accepted report ("cockpit report · N s ago"). */
	reported_at: Ts,
	/** What to show now; `snapshot_stale` when the report is old or the machine is offline. */
	display: RunDisplay,
	/** What the last report said, before any staleness override. */
	last_display: RunDisplay,
	needs_owner: z.boolean(),
});
export type RunView = z.infer<typeof RunView>;

export const RunEventView = z.object({
	sequence: z.number().int(),
	transition: z.string(),
	occurred_at: z.string().nullable(),
	task_id: z.string().nullable(),
	attempt: z.number().int().nullable(),
	outcome: z.string().nullable(),
	reason: z.string().nullable(),
	review_verdict: z.string().nullable(),
	commit: z.string().nullable(),
	base_commit: z.string().nullable(),
	diff_digest: z.string().nullable(),
	tree_digest: z.string().nullable(),
	test_run_key: z.string().nullable(),
	model: z.string().nullable(),
	from_model: z.string().nullable(),
	to_model: z.string().nullable(),
});
export type RunEventView = z.infer<typeof RunEventView>;

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

// ── token usage (M1, 18 §5.1) ──────────────────────────────────────────────────────────────────────

export const UsageTool = z.enum(["claude", "codex"]);
export type UsageTool = z.infer<typeof UsageTool>;

/** Session ids as ids.ts builds them for the two usage tools (`redacted-<hash>` fits the charset). */
const UsageSessionId = z
	.string()
	.regex(/^(claude|codex):[A-Za-z0-9._-]{1,128}$/);
const UsageDay = z.string().regex(USAGE_DAY_RE);
const UsageLabel = z.string().regex(USAGE_LABEL_RE);
/** One row's count; see USAGE_ROW_MAX. */
const TokenSum = z.number().int().nonnegative().max(USAGE_ROW_MAX);

/**
 * One cumulative row: a session's tokens for one Australia/Sydney day and one model. Strict, and
 * there is deliberately no field that could carry text, a command or a path.
 */
export const UsageRow = z.strictObject({
	session_id: UsageSessionId,
	day: UsageDay,
	model: UsageLabel,
	tool: UsageTool,
	/** Repo id by the shared rule (repo-slug.ts); null when the session ran outside a repo. */
	project: z.string().min(1).max(256).nullable(),
	/** Input not served from the prompt cache (Codex's cached part is moved to cache_read_tokens). */
	input_tokens: TokenSum,
	output_tokens: TokenSum,
	cache_read_tokens: TokenSum,
	cache_write_tokens: TokenSum,
	/** Model responses counted (one per API message; an advisor call counts under its own model). */
	messages: TokenSum,
});
export type UsageRow = z.infer<typeof UsageRow>;

/** A plan limit exactly as the tool's own log stated it (Codex `rate_limits`); never computed. */
export const UsageLimit = z.strictObject({
	tool: UsageTool,
	limit_id: UsageLabel,
	window_minutes: z.number().int().positive().max(1_000_000),
	used_percent: z.number().min(0).max(1000),
	resets_at: Ts.nullable(),
	plan_type: UsageLabel.nullable(),
	/** Time of the log record that stated it. The newest observation wins at the hub. */
	observed_at: Ts,
});
export type UsageLimit = z.infer<typeof UsageLimit>;

/** POST /ingest/usage body. */
export const UsageReport = z.strictObject({
	schema: z.literal(1),
	machine_id: MachineRole,
	rows: z.array(UsageRow).max(USAGE_MAX_ROWS),
	limits: z.array(UsageLimit).max(USAGE_MAX_LIMITS),
});
export type UsageReport = z.infer<typeof UsageReport>;

/** GET /api/usage row: sums over sessions for one (day, project, tool, model). */
export const UsageSummaryRow = z.object({
	day: UsageDay,
	project: z.string().nullable(),
	tool: UsageTool,
	model: z.string(),
	input_tokens: z.number().int().nonnegative(),
	output_tokens: z.number().int().nonnegative(),
	cache_read_tokens: z.number().int().nonnegative(),
	cache_write_tokens: z.number().int().nonnegative(),
	messages: z.number().int().nonnegative(),
	sessions: z.number().int().nonnegative(),
});
export type UsageSummaryRow = z.infer<typeof UsageSummaryRow>;

/** GET /api/usage limit: the newest observation per (tool, limit_id, window) across machines. */
export const UsageLimitView = UsageLimit.extend({
	machine_id: MachineRole,
	received_at: Ts,
});
export type UsageLimitView = z.infer<typeof UsageLimitView>;

/**
 * GET /api/usage?days=N body (also pushed on /ws as `{kind:"usage"}` when a report changed it).
 * `today` is the hub's Australia/Sydney day; `days` lists the N days ending today, oldest first.
 */
export const UsageSummary = z.object({
	tz: z.string(),
	today: UsageDay,
	days: z.array(UsageDay),
	rows: z.array(UsageSummaryRow),
	limits: z.array(UsageLimitView),
	/** Hub receive time of the newest report that changed a row; null when there is none. */
	updated_at: Ts.nullable(),
});
export type UsageSummary = z.infer<typeof UsageSummary>;
