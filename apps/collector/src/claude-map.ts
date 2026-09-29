// Claude Code hook input → IngestEvent. Pure (clock, ids and git lookup are injected).
// Whitelist only: prompt text, tool_input and tool_response are never copied — just the tool name,
// a file path, the first 80 chars of a command (redacted) and lengths.
import {
	type IngestEvent,
	redact,
	redactObject,
	SUBAGENT_TOOLS,
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
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function mapClaudeHook(
	input: unknown,
	ctx: MapContext,
): IngestEvent | null {
	if (!isObj(input)) return null;
	const sessionId = str(input.session_id);
	if (!sessionId) return null;

	const hook = str(input.hook_event_name) ?? "unknown";
	const tool = str(input.tool_name);
	const toolUseId = str(input.tool_use_id);
	const cwd = str(input.cwd);
	const git = cwd ? ctx.git(cwd) : null;
	const toolInput = isObj(input.tool_input) ? input.tool_input : {};
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
			const len = typeof input.prompt === "string" ? input.prompt.length : 0;
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

	return {
		id: toolUseId
			? `cc:${sessionId}:${hook}:${toolUseId}`
			: `cc:${ctx.newId()}`,
		ts: ctx.now().toISOString(),
		machine_id: ctx.machine,
		session_id: sessionId,
		agent_id: spawnsSubagent ? `sub:${toolUseId}` : null,
		provider: "claude",
		type: hook,
		tool,
		summary: summary === null ? null : redact(summary),
		repo_id: git?.repo_id ?? null,
		payload_redacted: redactObject(payload),
		cwd,
		branch: git?.branch ?? null,
		model: str(input.model),
		hostname: ctx.hostname,
		...(spawnsSubagent
			? {
					parent_agent_id: sessionId,
					agent_kind: "subagent" as const,
					agent_label: subagentType ? clip(redact(subagentType), 60) : null,
				}
			: {}),
	};
}
