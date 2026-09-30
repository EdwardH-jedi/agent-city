// Claude Code hook input → IngestEvent. Pure (clock, ids and git lookup are injected).
// Whitelist only: prompt text, tool_input and tool_response are never copied — just the tool name,
// a file path, the first 80 chars of a command (redacted) and lengths.
import {
	clip,
	type IngestEvent,
	mainAgentId,
	sessionId as namespacedSession,
	redact,
	SUBAGENT_TOOLS,
	sanitizeEvent,
	subagentId,
	summarizeToolInput,
} from "@agent-city/schema/core";
import type { GitInfo } from "./git-info.ts";

export const CLAUDE_HOOK_EVENTS = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"Notification",
	"Stop",
	"SubagentStop",
	"SessionEnd",
] as const;

export interface MapContext {
	machine: string;
	hostname: string;
	now: () => Date;
	newId: () => string;
	git: (cwd: string) => GitInfo | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
	typeof v === "string" && v.length > 0 ? v : null;

/** Hook input reduced to the fields we use; every string capped (F01), the prompt reduced to its length. */
export interface ClaudeInput {
	session_id: string | null;
	hook_event_name: string | null;
	tool_name: string | null;
	tool_use_id: string | null;
	cwd: string | null;
	model: string | null;
	source: string | null;
	reason: string | null;
	message: string | null;
	notification_type: string | null;
	permission_mode: string | null;
	transcript_path: string | null;
	agent_id: string | null;
	agent_type: string | null;
	prompt_length: number | null;
	tool_input: {
		command?: string;
		file_path?: string;
		path?: string;
		notebook_path?: string;
		subagent_type?: string;
		description?: string;
	} | null;
}

const FIELD_MAX = 4096;
const pickStr = (v: unknown, max = FIELD_MAX): string | null =>
	typeof v === "string" && v.length > 0 ? clip(v, max) : null;

/**
 * Copy only what the mapper needs out of the parsed hook JSON. The caller drops its reference to the
 * full object right after, so prompt text / tool_input / tool_response never travel further.
 */
export function pickClaudeInput(raw: unknown): ClaudeInput | null {
	if (!isObj(raw)) return null;
	const ti = isObj(raw.tool_input) ? raw.tool_input : null;
	const tool_input: ClaudeInput["tool_input"] = ti ? {} : null;
	if (ti && tool_input) {
		for (const k of [
			"command",
			"file_path",
			"path",
			"notebook_path",
			"subagent_type",
			"description",
		] as const) {
			const v = pickStr(ti[k]);
			if (v !== null) tool_input[k] = v;
		}
	}
	return {
		session_id: pickStr(raw.session_id, 256),
		hook_event_name: pickStr(raw.hook_event_name, 64),
		tool_name: pickStr(raw.tool_name, 256),
		tool_use_id: pickStr(raw.tool_use_id, 256),
		cwd: pickStr(raw.cwd),
		model: pickStr(raw.model, 256),
		source: pickStr(raw.source, 64),
		reason: pickStr(raw.reason, 64),
		message: pickStr(raw.message),
		notification_type: pickStr(raw.notification_type, 64),
		permission_mode: pickStr(raw.permission_mode, 64),
		transcript_path: pickStr(raw.transcript_path),
		agent_id: pickStr(raw.agent_id, 256),
		agent_type: pickStr(raw.agent_type, 128),
		prompt_length: typeof raw.prompt === "string" ? raw.prompt.length : null,
		tool_input,
	};
}

export function mapClaudeHook(
	raw: unknown,
	ctx: MapContext,
): IngestEvent | null {
	// Accept either the raw hook JSON or an already-picked ClaudeInput (the hook picks early).
	const input = isPicked(raw) ? raw : pickClaudeInput(raw);
	if (!input) return null;
	const rawInput = str(input.session_id);
	if (!rawInput) return null;

	const hook = str(input.hook_event_name) ?? "unknown";
	const tool = str(input.tool_name);
	const toolUseId = str(input.tool_use_id);
	const cwd = str(input.cwd);
	const git = cwd ? ctx.git(cwd) : null;
	const toolInput: Obj = input.tool_input ?? {};
	const toolSummary = tool ? summarizeToolInput(tool, input.tool_input) : null;

	// Subagents are derived from the Task/Agent call that spawns them: Pre creates, Post ends.
	const spawnsSubagent =
		tool !== null &&
		SUBAGENT_TOOLS.has(tool) &&
		toolUseId !== null &&
		(hook === "PreToolUse" || hook === "PostToolUse");
	// Only the Pre call carries subagent_type; the Post must not overwrite the label with a default.
	const subagentType = str(toolInput.subagent_type);

	let summary: string | null = null;
	const payload: Obj = { hook };
	switch (hook) {
		case "SessionStart":
			payload.source = str(input.source);
			summary = `session start${payload.source ? ` (${payload.source})` : ""}`;
			break;
		case "SessionEnd":
			payload.reason = str(input.reason);
			summary = `session end${payload.reason ? ` (${payload.reason})` : ""}`;
			break;
		case "UserPromptSubmit": {
			// prompt body is never stored — only its length
			const len = input.prompt_length ?? 0;
			payload.prompt_length = len;
			summary = `prompt (${len} chars)`;
			break;
		}
		case "Notification": {
			const msg = str(input.message);
			payload.notification_type = str(input.notification_type);
			payload.message = msg ? clip(redact(msg), 200) : null;
			summary = msg ? clip(redact(msg), 120) : "notification";
			break;
		}
		case "PreToolUse":
		case "PostToolUse":
			payload.tool = toolSummary;
			payload.tool_use_id = toolUseId;
			if (spawnsSubagent) {
				const desc = str(toolInput.description);
				summary = `${tool} → ${subagentType ?? "subagent"}${desc ? `: ${clip(redact(desc), 60)}` : ""}`;
			} else {
				summary = toolSummary?.command
					? `${tool}: ${toolSummary.command}`
					: toolSummary?.file_path
						? `${tool} ${toolSummary.file_path}`
						: tool;
			}
			break;
		case "Stop":
		case "SubagentStop":
			summary = hook === "Stop" ? "stop" : "subagent stop";
			// Claude's own subagent id can't be matched to the Task call → keep it as data only.
			payload.claude_agent_id = str(input.agent_id);
			payload.claude_agent_type = str(input.agent_type);
			break;
	}
	payload.permission_mode = str(input.permission_mode);
	payload.transcript_path = str(input.transcript_path);

	// Ids (re-audit N03/N04): the EVENT id keeps the exact 1f4f025 recipe — raw session id, then
	// sanitizeEvent hashes the whole id if unsafe — so events spooled before the upgrade still dedupe.
	// The SESSION / subagent ids use the final namespace (unsafe raw parts hashed, then prefixed).
	const session = namespacedSession("claude", rawInput);
	return sanitizeEvent({
		id: toolUseId ? `cc:${rawInput}:${hook}:${toolUseId}` : `cc:${ctx.newId()}`,
		ts: ctx.now().toISOString(),
		machine_id: ctx.machine,
		session_id: session,
		agent_id:
			spawnsSubagent && toolUseId ? subagentId(session, toolUseId) : null,
		provider: "claude" as const,
		type: hook,
		tool,
		summary: summary === null ? null : redact(summary),
		repo_id: git?.repo_id ?? null,
		payload_redacted: payload,
		cwd,
		branch: git?.branch ?? null,
		model: str(input.model),
		hostname: ctx.hostname,
		...(spawnsSubagent
			? {
					parent_agent_id: mainAgentId(session),
					agent_kind: "subagent" as const,
					agent_label: subagentType ? clip(redact(subagentType), 60) : null,
				}
			: {}),
	});
}

const PICKED = Symbol("picked");
const isPicked = (v: unknown): v is ClaudeInput =>
	isObj(v) && (v as Record<symbol, unknown>)[PICKED] === true;
/** Mark a picked input so mapClaudeHook doesn't re-pick it. */
export function markPicked(input: ClaudeInput): ClaudeInput {
	Object.defineProperty(input, PICKED, { value: true });
	return input;
}
