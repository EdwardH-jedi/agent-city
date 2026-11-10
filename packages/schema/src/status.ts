// Session state machine. Pure functions — the hub applies nextStatus() on every ingested event and
// applyStale() from its 1-minute timer.
import {
	HEARTBEAT_OFFLINE_FROM_MS,
	HEARTBEAT_ONLINE_BELOW_MS,
	RUN_SNAPSHOT_STALE_MS,
} from "./limits.ts";
import type { MachineLiveness, RunDisplay, SessionStatus } from "./types.ts";

export const STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * Machine liveness from the hub's receive time of the latest heartbeat. Pure: the screen calls it
 * again with its own clock so a machine that stops beating turns stale/offline without any message.
 * No receive time (or an unparseable one) → unobserved. A receive time slightly ahead of `now`
 * (clock rounding) counts as just received.
 */
export function machineStatus(
	heartbeatAt: string | null,
	now: Date,
): MachineLiveness {
	if (heartbeatAt === null) return "unobserved";
	const at = Date.parse(heartbeatAt);
	if (Number.isNaN(at)) return "unobserved";
	const age = now.getTime() - at;
	if (age < HEARTBEAT_ONLINE_BELOW_MS) return "online";
	if (age < HEARTBEAT_OFFLINE_FROM_MS) return "stale";
	return "offline";
}

/** READY states in which Office is waiting for the owner (02 §6). */
const WAITING_OWNER_REASONS: ReadonlySet<string> = new Set([
	"AWAITING_PLAN_APPROVAL",
	"AWAITING_OWNER_INTEGRATION",
	"DRAFT_REQUIRES_OWNER_COMMIT",
	"PLAN_APPROVED",
]);

/** Displays that put a run in the "Needs owner" list. */
const NEEDS_OWNER: ReadonlySet<RunDisplay> = new Set([
	"waiting_owner",
	"hold",
	"needs_reconcile",
	"unverified",
]);

/**
 * The state Office reported, mapped by the 02 §6 table. City never reinterprets: a combination the
 * table does not list is `unknown` rather than a guess. Unverified evidence wins over everything, so
 * a run with unchecked evidence can never read as passed.
 */
export function reportedRunState(run: {
	status: string;
	reason: string | null;
	alert: string | null;
	evidence_verified: boolean;
}): RunDisplay {
	if (!run.evidence_verified || run.alert === "EVIDENCE_UNVERIFIED") {
		return "unverified";
	}
	if (
		run.alert === "FAILED_PROCESS_RECONCILE" ||
		run.alert === "MISSION_RECONCILIATION_REQUIRED"
	) {
		return "needs_reconcile";
	}
	if (run.alert === "STALE_OR_IDLE") return "no_progress_suspected";
	if (run.alert !== null) return "unknown";
	switch (run.status) {
		case "RUNNING":
			return "running";
		case "READY":
			return run.reason !== null && WAITING_OWNER_REASONS.has(run.reason)
				? "waiting_owner"
				: "unknown";
		case "HOLD":
			return "hold";
		case "PASS":
			return "passed";
		case "PARTIAL":
			return "partial";
		default:
			return "unknown";
	}
}

export interface RunState {
	/** What to show now. */
	display: RunDisplay;
	/** What the last report said. */
	last_display: RunDisplay;
	needs_owner: boolean;
}

/**
 * Display state of a reported run at `now`. A report that is 90 s old (three missed sends), or whose
 * machine is offline, becomes `snapshot_stale`: the screen then says "last report: <last_display>
 * (N min ago)" so a closed laptop never leaves a run looking alive. A finished run (passed/partial)
 * stays as reported. Pure: the web view calls it again with its own clock.
 */
export function runStateAt(
	run: {
		status: string;
		reason: string | null;
		alert: string | null;
		evidence_verified: boolean;
	},
	reportedAt: string,
	machine: MachineLiveness,
	now: Date,
): RunState {
	const last = reportedRunState(run);
	const finished = last === "passed" || last === "partial";
	const age = now.getTime() - Date.parse(reportedAt);
	const stale =
		!finished &&
		(Number.isNaN(age) ||
			age >= RUN_SNAPSHOT_STALE_MS ||
			machine === "offline");
	return {
		display: stale ? "snapshot_stale" : last,
		last_display: last,
		needs_owner: NEEDS_OWNER.has(last),
	};
}

/**
 * Status a session moves to after an event of `type` (canonical Claude hook names; the Codex
 * collector maps its records onto these). Any other event — including one arriving after
 * SessionEnd, e.g. a resumed session — means the agent is working again → active.
 */
export function nextStatus(type: string): SessionStatus {
	switch (type) {
		case "Notification":
			return "waiting";
		case "Stop":
			return "idle";
		case "SessionEnd":
			return "ended";
		default:
			return "active";
	}
}

/** Tools whose call spawns a subagent (Claude Code: `Task`, renamed `Agent` in newer versions). */
export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["Task", "Agent"]);

/**
 * Does this event end the (sub)agent it is attributed to? The session itself stays active
 * (nextStatus). Collectors derive subagents from Task/Agent calls, so the PostToolUse of that call
 * ends the subagent; a SubagentStop that carries a subagent id does too.
 */
export function endsAgent(type: string, tool: string | null = null): boolean {
	if (type === "SubagentStop") return true;
	return type === "PostToolUse" && tool !== null && SUBAGENT_TOOLS.has(tool);
}

// Never time out: `ended` is final; `waiting` needs a human and must stay visible until the next
// event or SessionEnd; `stale` already is.
const NEVER_STALE: ReadonlySet<SessionStatus> = new Set([
	"ended",
	"waiting",
	"stale",
]);

/** `stale` once no event for ≥ 15 minutes, except for ended / waiting sessions. */
export function applyStale(
	status: SessionStatus,
	lastEventAt: string,
	now: Date,
): SessionStatus {
	if (NEVER_STALE.has(status)) return status;
	const last = Date.parse(lastEventAt);
	if (Number.isNaN(last)) return status;
	return now.getTime() - last >= STALE_AFTER_MS ? "stale" : status;
}
