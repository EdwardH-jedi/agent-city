// Session / agent id namespace (audit F10), shared by both collectors and the hub. zod-free.
//
//   session    <provider>:<raw>              claude:0b1c… · codex:019a…
//   main agent = the session id
//   subagent   <session_id>/sub:<tool_use_id>
//
// Raw provider ids are UUIDs, so provider-prefixed ids never collide across providers, and a
// subagent id can't collide across sessions. Event ids keep their own prefixes (`cc:` / `codex:`)
// so events spooled before this change still dedupe.
//
// Every function is idempotent: the hub re-applies them to whatever a collector sent, which also
// upgrades events spooled by an older collector (raw session id, bare `sub:<id>` agent).
import type { Provider } from "./types.ts";

/** `<provider>:<raw>`; unchanged when already prefixed. */
export function sessionId(provider: Provider, raw: string): string {
	const prefix = `${provider}:`;
	return raw.startsWith(prefix) ? raw : prefix + raw;
}

/** The main agent of a session shares its id. */
export function mainAgentId(session: string): string {
	return session;
}

/** `<session>/sub:<toolUseId>`. */
export function subagentId(session: string, toolUseId: string): string {
	return `${session}/sub:${toolUseId}`;
}

/**
 * Scope an agent id to its session. `rawSession` is the session id as the collector sent it (a
 * legacy collector used it for the main agent and as `parent_agent_id`).
 *   null · session · rawSession → main agent
 *   `<session>/…`               → unchanged
 *   anything else (`sub:<id>`…) → `<session>/<id>`
 */
export function scopedAgentId(
	session: string,
	agent: string | null | undefined,
	rawSession: string = session,
): string {
	if (agent == null || agent === session || agent === rawSession)
		return mainAgentId(session);
	if (agent.startsWith(`${session}/`)) return agent;
	return `${session}/${agent}`;
}

interface IdFields {
	provider: Provider;
	session_id: string;
	agent_id?: string | null;
	parent_agent_id?: string | null;
}

/** Namespace an event's session / agent / parent ids (idempotent). */
export function namespaceIds<T extends IdFields>(ev: T): T {
	const session = sessionId(ev.provider, ev.session_id);
	const out: T = { ...ev, session_id: session };
	if (ev.agent_id != null)
		out.agent_id = scopedAgentId(session, ev.agent_id, ev.session_id);
	if (ev.parent_agent_id != null)
		out.parent_agent_id = scopedAgentId(
			session,
			ev.parent_agent_id,
			ev.session_id,
		);
	return out;
}
