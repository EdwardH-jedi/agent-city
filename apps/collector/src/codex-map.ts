// Codex rollout JSONL record → IngestEvent. Pure; per-file context is passed in and mutated.
// Format (read from real ~/.codex/sessions files, cli 2026-09): line 1 is always `session_meta`;
// records are {timestamp, type, payload:{type?,…}}.
//
//   session_meta                        → SessionStart
//   turn_context                        → codex.turn_context (model / cwd update)
//   event_msg/item_completed UserMessage→ UserPromptSubmit (text length only)
//   response_item/{function,custom_tool,tool_search,web_search}_call → PreToolUse
//   response_item/*_output              → PostToolUse (tool name via call_id)
//   event_msg/task_complete|turn_aborted→ Stop
//   IGNORE list (high-volume noise)     → nothing
//   anything else                       → codex.<type>[/<payload.type>] with an empty payload
import {
	clip,
	type IngestEvent,
	parseGithubRemote,
	redact,
	safeId,
	safeText,
	sanitizeEvent,
	summarizeToolInput,
	type ToolInputSummary,
} from "@agent-city/schema/core";
import type { GitInfo } from "./git-info.ts";

export interface CodexSession {
	id: string;
	cwd: string | null;
	repo_id: string | null;
	branch: string | null;
	model: string | null;
}

/** Per-file state; `session` is persisted with the offset (line 1 is behind it after a restart). */
export interface CodexFileContext {
	session: CodexSession | null;
	/** call_id → tool name (not persisted; a restart just loses the Post tool name). */
	calls: Map<string, string>;
}

export interface CodexMapDeps {
	machine: string;
	hostname: string;
	git: (cwd: string) => GitInfo | null;
}

export const IGNORE: ReadonlySet<string> = new Set([
	"event_msg/token_count",
	"event_msg/task_started", // the UserMessage item already marks the turn start
	"event_msg/agent_message",
	"event_msg/agent_reasoning",
	"event_msg/thread_goal_updated",
	"event_msg/thread_settings_applied",
	"event_msg/item_completed", // non-UserMessage items duplicate response_item records
	"response_item/reasoning",
	"response_item/message", // user text arrives via item_completed; assistant text isn't stored
	"response_item/agent_message",
	"token_usage_record",
	"world_state",
	"inter_agent_communication_metadata",
	"compacted",
]);

const PRE = new Set([
	"function_call",
	"custom_tool_call",
	"local_shell_call",
	"tool_search_call",
	"web_search_call",
]);
const POST = new Set([
	"function_call_output",
	"custom_tool_call_output",
	"local_shell_call_output",
	"tool_search_output",
	"web_search_output",
]);
const MAX_CALLS = 500;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
	typeof v === "string" && v.length > 0 ? v : null;

/** apply_patch input is a patch (file contents!) — keep only the first touched path (first 4KB only). */
function patchPath(input: string): string | null {
	return (
		/^\*\*\* (?:Update|Add|Delete) File: ([^\n]{1,1024})$/m
			.exec(clip(input))?.[1]
			?.trim() ?? null
	);
}

/** Session context is persisted with offsets — sanitize it at construction (F02). */
function safeSession(s: CodexSession): CodexSession {
	return {
		id: safeId(s.id),
		cwd: safeText(s.cwd, 1024),
		repo_id: safeText(s.repo_id, 256),
		branch: safeText(s.branch, 256),
		model: safeText(s.model, 128),
	};
}

function toolView(p: Obj): { tool: string; view: ToolInputSummary } {
	const type = str(p.type) ?? "tool";
	const name = str(p.name) ?? type.replace(/_call$/, "");
	if (type === "custom_tool_call") {
		const input = typeof p.input === "string" ? p.input : "";
		if (name === "apply_patch") {
			const file = patchPath(input);
			return {
				tool: name,
				view: file ? { tool: name, file_path: redact(file) } : { tool: name },
			};
		}
		return { tool: name, view: summarizeToolInput(name, { command: input }) };
	}
	if (type === "function_call") {
		let args: Obj = {};
		try {
			const parsed = JSON.parse(String(p.arguments ?? "{}"));
			if (isObj(parsed)) args = parsed;
		} catch {
			// unparseable arguments → tool name only
		}
		const cmd = Array.isArray(args.command)
			? args.command.join(" ")
			: (str(args.cmd) ?? str(args.command));
		return {
			tool: name,
			view: summarizeToolInput(
				name,
				cmd ? { command: cmd, path: args.path } : args,
			),
		};
	}
	return { tool: name, view: { tool: name } };
}

/** One line → event (or null when ignored / unparseable / before session_meta). Never throws. */
export function mapCodexLine(
	line: string,
	offset: number,
	ctx: CodexFileContext,
	deps: CodexMapDeps,
): IngestEvent | null {
	let rec: Obj;
	try {
		const parsed = JSON.parse(line);
		if (!isObj(parsed)) return null;
		rec = parsed;
	} catch {
		return null;
	}
	const type = str(rec.type) ?? "unknown";
	const p = isObj(rec.payload) ? rec.payload : {};
	const ptype = str(p.type);
	const key = ptype ? `${type}/${ptype}` : type;
	const ts = str(rec.timestamp) ?? new Date().toISOString();

	const build = (
		evType: string,
		tool: string | null,
		summary: string | null,
		payload: Obj,
	): IngestEvent | null => {
		const s = ctx.session;
		if (!s) return null;
		return sanitizeEvent({
			id: `codex:${s.id}:${offset}`,
			ts,
			machine_id: deps.machine,
			session_id: s.id,
			agent_id: null,
			provider: "codex" as const,
			type: evType,
			tool,
			summary: summary === null ? null : redact(summary),
			repo_id: s.repo_id,
			payload_redacted: { record: key, ...payload },
			cwd: s.cwd,
			branch: s.branch,
			model: s.model,
			hostname: deps.hostname,
		});
	};

	if (type === "session_meta") {
		const id = str(p.session_id) ?? str(p.id);
		if (!id) return null;
		const cwd = str(p.cwd);
		const git = cwd ? deps.git(cwd) : null;
		const remote = isObj(p.git) ? str(p.git.repository_url) : null;
		ctx.session = safeSession({
			id,
			cwd,
			repo_id: git?.repo_id ?? (remote ? parseGithubRemote(remote) : null),
			branch: git?.branch ?? null,
			model: ctx.session?.model ?? null,
		});
		return build("SessionStart", null, "codex session start", {
			originator: str(p.originator),
			cli_version: str(p.cli_version),
			source: str(p.source),
		});
	}

	const s = ctx.session;
	if (!s) return null; // nothing to attribute to

	if (type === "turn_context") {
		const model = str(p.model);
		const cwd = str(p.cwd);
		if (model) s.model = safeText(model, 128);
		const safeCwd = safeText(cwd, 1024);
		if (cwd && safeCwd !== s.cwd) {
			const git = deps.git(cwd);
			s.cwd = safeCwd;
			if (git) {
				s.repo_id = safeText(git.repo_id, 256);
				s.branch = safeText(git.branch, 256);
			}
		}
		return build(
			"codex.turn_context",
			null,
			model ? `turn (${model})` : "turn",
			{ approval_policy: str(p.approval_policy) },
		);
	}

	if (key === "event_msg/item_completed") {
		const item = isObj(p.item) ? p.item : {};
		if (item.type !== "UserMessage") return null;
		const content = Array.isArray(item.content) ? item.content : [];
		const len = content.reduce<number>(
			(n, c) =>
				n + (isObj(c) && typeof c.text === "string" ? c.text.length : 0),
			0,
		);
		return build("UserPromptSubmit", null, `prompt (${len} chars)`, {
			prompt_length: len,
		});
	}

	if (type === "response_item" && ptype && PRE.has(ptype)) {
		const { tool, view } = toolView(p);
		const callId = str(p.call_id);
		if (callId) {
			ctx.calls.set(callId, tool);
			if (ctx.calls.size > MAX_CALLS) {
				const first = ctx.calls.keys().next().value;
				if (first !== undefined) ctx.calls.delete(first);
			}
		}
		const summary = view.command
			? `${tool}: ${view.command}`
			: view.file_path
				? `${tool} ${view.file_path}`
				: tool;
		return build("PreToolUse", tool, summary, { tool: view, call_id: callId });
	}

	if (type === "response_item" && ptype && POST.has(ptype)) {
		const callId = str(p.call_id);
		const tool = (callId && ctx.calls.get(callId)) || null;
		if (callId) ctx.calls.delete(callId);
		return build("PostToolUse", tool, tool ? `${tool} done` : "tool done", {
			call_id: callId,
		});
	}

	if (key === "event_msg/task_complete" || key === "event_msg/turn_aborted") {
		return build(
			"Stop",
			null,
			ptype === "turn_aborted" ? "turn aborted" : "turn complete",
			{ duration_ms: typeof p.duration_ms === "number" ? p.duration_ms : null },
		);
	}

	if (IGNORE.has(key) || IGNORE.has(type)) return null;
	// Unknown record: type only.
	return build(`codex.${key}`, null, null, {});
}
