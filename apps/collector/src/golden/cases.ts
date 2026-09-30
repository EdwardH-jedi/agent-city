// Inputs for the event-id golden test (re-audit N03). Shared by the generator
// (scripts/gen-golden-event-ids.ts, which runs the 1f4f025 mappers) and golden.test.ts (current
// mappers). Synthetic values only; the token-shaped id is assembled at runtime.

export const GOLDEN_COMMIT = "1f4f025";

const TOKEN = `ghp_${"Q".repeat(36)}`;

/** Claude hook inputs, each with a tool_use_id so the event id is deterministic. */
export function claudeCases(): {
	name: string;
	input: Record<string, unknown>;
}[] {
	const base = (session_id: string, extra: Record<string, unknown> = {}) => ({
		session_id,
		hook_event_name: "PreToolUse",
		tool_name: "Bash",
		tool_use_id: "toolu_01GoldenAAAA",
		cwd: "/",
		tool_input: { command: "true" },
		...extra,
	});
	return [
		{ name: "safe-uuid", input: base("0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0") },
		{ name: "space", input: base("golden session id") },
		{ name: "slash", input: base("a/sub:x") },
		{ name: "colon", input: base("claude:prefixed:raw") },
		{ name: "control-char", input: base("golden\u0007bell") },
		{ name: "token-shaped", input: base(`s-${TOKEN}`) },
		{ name: "over-128", input: base(`g${"x".repeat(200)}`) },
		{ name: "over-256-clipped", input: base(`g${"y".repeat(400)}`) },
		{
			name: "task-pre",
			input: base("0b1c2d3e-task", {
				tool_name: "Task",
				tool_use_id: "toolu_task_1",
				tool_input: { subagent_type: "Explore", description: "d" },
			}),
		},
		{
			name: "task-post",
			input: base("0b1c2d3e-task", {
				hook_event_name: "PostToolUse",
				tool_name: "Task",
				tool_use_id: "toolu_task_1",
				tool_input: {},
			}),
		},
		{
			name: "unsafe-tool-use-id",
			input: base("0b1c2d3e-tu", { tool_use_id: "tu/with:reserved chars" }),
		},
		{
			name: "no-tool-use-id",
			input: {
				session_id: "0b1c2d3e-stop",
				hook_event_name: "Stop",
				cwd: "/",
			},
		},
	];
}

/** Codex rollout files (lines); event ids are codex:<session>:<byte offset>. */
export function codexCases(): { name: string; lines: string[] }[] {
	const ts = "2026-09-29T00:00:00.000Z";
	const file = (id: string) => [
		JSON.stringify({
			timestamp: ts,
			type: "session_meta",
			payload: { id, cwd: "/" },
		}),
		JSON.stringify({
			timestamp: ts,
			type: "response_item",
			payload: {
				type: "function_call",
				name: "exec_command",
				call_id: "call_1",
				arguments: JSON.stringify({ cmd: "true" }),
			},
		}),
		JSON.stringify({
			timestamp: ts,
			type: "event_msg",
			payload: { type: "task_complete" },
		}),
	];
	return [
		{ name: "codex-safe", lines: file("019a0b1c-2d3e-7f40-8152-637485960a1b") },
		{ name: "codex-slash-colon", lines: file("codex/sub:odd id") },
		{ name: "codex-token-shaped", lines: file(`s-${TOKEN}`) },
	];
}

/** Byte offset of each line in a file made of `lines` joined with \n. */
export function lineOffsets(lines: readonly string[]): number[] {
	let at = 0;
	return lines.map((l) => {
		const here = at;
		at += Buffer.byteLength(l) + 1;
		return here;
	});
}
