// Event sanitation shared by collectors (before spool/send) and the hub (before storing) — the hub
// never trusts the collector (audit F02). zod-free: the Claude hook imports this via ./core.
//
// Every string field is clipped and redacted; identifier fields are additionally checked against a
// safe charset, and anything unsafe (or containing a secret) is replaced by a deterministic hash so
// retries still map to the same row.
import { clip, redact, redactObject } from "./redact.ts";

const SAFE_ID = /^[A-Za-z0-9._:/@-]{1,200}$/;

/** 64-bit FNV-1a (two 32-bit lanes) → 16 hex chars. Identity only, not security. */
export function fnv1a64(input: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193 ^ 0x9e3779b9;
	for (let i = 0; i < input.length; i++) {
		const c = input.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
		h2 = Math.imul(h2 ^ c ^ (i & 0xff), 0x01000193) >>> 0;
	}
	return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** An id that is safe to store, index and show: unchanged when clean, else `redacted-<hash>`. */
export function safeId(id: string): string {
	if (SAFE_ID.test(id) && redact(id) === id) return id;
	return `redacted-${fnv1a64(id)}`;
}

/** clip + redact; null stays null. */
export function safeText(
	value: string | null | undefined,
	max: number,
): string | null {
	if (value === null || value === undefined) return null;
	return redact(clip(value, max));
}

const TEXT_MAX = {
	type: 128,
	tool: 256,
	summary: 512,
	repo_id: 256,
	cwd: 1024,
	branch: 256,
	model: 128,
	hostname: 256,
	agent_label: 128,
} as const;

/** Structural subset of IngestEvent that sanitizeEvent touches (keeps this file type-light). */
export interface SanitizableEvent {
	id: string;
	machine_id: string;
	session_id: string | null;
	agent_id?: string | null;
	parent_agent_id?: string | null;
	type: string;
	tool?: string | null;
	summary?: string | null;
	repo_id?: string | null;
	cwd?: string | null;
	branch?: string | null;
	model?: string | null;
	hostname?: string | null;
	agent_label?: string | null;
	payload_redacted?: Record<string, unknown>;
}

/** Sanitize every string an event carries. Returns a new object; unknown extra keys are kept as-is. */
export function sanitizeEvent<T extends SanitizableEvent>(ev: T): T {
	const out: T = { ...ev };
	out.id = safeId(ev.id);
	out.machine_id = safeId(ev.machine_id);
	if (ev.session_id !== null) out.session_id = safeId(ev.session_id);
	if (ev.agent_id != null) out.agent_id = safeId(ev.agent_id);
	if (ev.parent_agent_id != null)
		out.parent_agent_id = safeId(ev.parent_agent_id);
	out.type = safeText(ev.type, TEXT_MAX.type) ?? "unknown";
	for (const key of [
		"tool",
		"summary",
		"repo_id",
		"cwd",
		"branch",
		"model",
		"hostname",
		"agent_label",
	] as const) {
		if (key in ev) out[key] = safeText(ev[key], TEXT_MAX[key]) as T[typeof key];
	}
	if (ev.payload_redacted !== undefined)
		out.payload_redacted = redactObject(ev.payload_redacted);
	return out;
}
