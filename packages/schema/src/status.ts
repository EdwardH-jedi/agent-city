// Session state machine. Pure functions — the hub applies nextStatus() on every ingested event and
// applyStale() from its 1-minute timer.
import type { SessionStatus } from "./types.ts";

export const STALE_AFTER_MS = 15 * 60 * 1000;

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
