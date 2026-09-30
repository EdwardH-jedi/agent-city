// Session / agent id namespace — FINAL scheme (audit F10, re-audit N04). Shared by both collectors
// and the hub. zod-free.
//
//   raw part   [A-Za-z0-9._-]{1,128} and free of secrets, else `redacted-<fnv1a64(raw)>`
//              (reserved `/` `:`, whitespace, control chars, >128 chars → hashed, never truncated)
//   session    <provider>:<raw part>          claude:0b1c… · codex:019a…
//   main agent = the session id
//   subagent   <session>/sub:<raw part of tool_use_id>
//
// Because `/` and `:` can't appear in a raw part, a session id can never look like another
// session's subagent (raw session `a/sub:x` hashes; it can't become `claude:a/sub:x`).
//
// Every function is idempotent: the hub re-applies them to whatever a collector sent, which also
// upgrades events spooled by an older collector (raw session id, bare `sub:<id>` agent).
// Event ids are NOT built here — they keep the exact 1f4f025 recipe (re-audit N03).
import { redact } from "./redact.ts";
import { fnv1a64 } from "./sanitize.ts";
import type { Provider } from "./types.ts";

const SAFE_RAW = /^[A-Za-z0-9._-]{1,128}$/;

/** A raw id that can be used verbatim inside a namespaced id. */
export function isSafeRawId(raw: string): boolean {
	return SAFE_RAW.test(raw) && redact(raw) === raw;
}

/** `raw` when safe, else a deterministic `redacted-<hash>` (same raw → same id on every retry). */
export function safeRawId(raw: string): string {
	return isSafeRawId(raw) ? raw : `redacted-${fnv1a64(raw)}`;
}

/**
 * `<provider>:<raw part>`. An input already carrying this provider's prefix is kept only when the
 * rest is a safe raw part; anything else is treated as a raw id and hashed as a whole.
 */
export function sessionId(provider: Provider, raw: string): string {
	const prefix = `${provider}:`;
	if (raw.startsWith(prefix) && isSafeRawId(raw.slice(prefix.length)))
		return raw;
	return prefix + safeRawId(raw);
}

/** The main agent of a session shares its id. */
export function mainAgentId(session: string): string {
	return session;
}

/** `<session>/sub:<raw part of toolUseId>`. */
export function subagentId(session: string, toolUseId: string): string {
	return `${session}/sub:${safeRawId(toolUseId)}`;
}

/**
 * Scope an agent id to its session (strict membership). `rawSession` is the session id as the
 * collector sent it (a legacy collector used it for the main agent and as `parent_agent_id`).
 *   null · session · rawSession            → main agent
 *   `<session>/sub:<safe raw part>`        → unchanged
 *   legacy `sub:<id>`                      → `<session>/sub:<raw part of id>`
 *   anything else — another session's agent, unknown shapes → main agent
 */
export function scopedAgentId(
	session: string,
	agent: string | null | undefined,
	rawSession: string = session,
): string {
	if (agent == null || agent === session || agent === rawSession)
		return mainAgentId(session);
	const own = `${session}/sub:`;
	if (agent.startsWith(own) && isSafeRawId(agent.slice(own.length)))
		return agent;
	if (agent.startsWith("sub:")) return subagentId(session, agent.slice(4));
	return mainAgentId(session);
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
