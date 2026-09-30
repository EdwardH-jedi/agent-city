// Claude Code CLI implementer (execution_mode `live`). Off unless the managed config enables live
// execution. Flags were checked against `claude --help` of the installed 2.1.285 and the headless
// docs (code.claude.com/docs/en/headless):
//   -p --output-format stream-json --verbose        non-interactive, one JSON object per line
//   --session-id <uuid> | --resume <session id>     explicit session; never --continue
//   --model <m>                                     requested model; NO --fallback-model
//   --permission-mode acceptEdits --permission-prompts none   edits allowed, anything else denied
//   --tools / --allowedTools <list>                 built-in tools limited to the configured list
//   --json-schema <schema>                          structured final output
// Not used on purpose: --bare (it ignores the subscription login and needs an API key),
// --dangerously-skip-permissions / bypassPermissions, --continue.
//
// NOT live-verified in this repo: the exact stream-json field shapes below come from the docs and
// are exercised only against stub executables. Unknown shapes degrade to "unknown"/invalid output,
// never to a fabricated success.
import { randomUUID } from "node:crypto";
import {
	type FailureKind,
	IMPLEMENTATION_CONTRACT,
	ImplementationOutput,
	redact,
} from "@agent-city/schema";
import type { ClaudeProviderConfig } from "../config.ts";
import {
	checkExecutable,
	classifyFailure,
	IMPLEMENTATION_JSON_SCHEMA,
	implementationPrompt,
	obj,
	parseJsonLine,
	providerEnv,
	str,
} from "./cli.ts";
import type {
	AdapterContext,
	ImplementationAdapter,
	ImplementInput,
	ImplementResult,
	Preflight,
	ProviderMeta,
} from "./types.ts";

export function claudeArgs(
	cfg: ClaudeProviderConfig,
	session: { id: string; resume: boolean },
): string[] {
	const tools = cfg.tools.join(",");
	return [
		cfg.executable,
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--model",
		cfg.model,
		"--permission-mode",
		"acceptEdits",
		"--permission-prompts",
		"none",
		"--tools",
		tools,
		"--allowedTools",
		tools,
		"--json-schema",
		JSON.stringify(IMPLEMENTATION_JSON_SCHEMA),
		session.resume ? "--resume" : "--session-id",
		session.id,
	];
}

export interface ClaudeStream {
	sessionId: string | null;
	model: string | null;
	result: Record<string, unknown> | null;
	/** `error` categories of system/api_retry events. */
	retryErrors: string[];
	malformed: number;
	/** Event summary: types, tool names, final text. No message bodies, no thinking. */
	transcript: string[];
}

export function newClaudeStream(): ClaudeStream {
	return {
		sessionId: null,
		model: null,
		result: null,
		retryErrors: [],
		malformed: 0,
		transcript: [],
	};
}

/** Fold one stream-json line into the state. Unknown event types are counted, not trusted. */
export function foldClaudeLine(s: ClaudeStream, line: string): void {
	if (line.trim().length === 0) return;
	const ev = parseJsonLine(line);
	if (!ev) {
		s.malformed++;
		return;
	}
	const type = str(ev.type) ?? "?";
	const subtype = str(ev.subtype);
	if (type === "system" && subtype === "init") {
		s.sessionId = str(ev.session_id) ?? s.sessionId;
		s.model = str(ev.model) ?? s.model;
		s.transcript.push("system/init");
	} else if (type === "system" && subtype === "api_retry") {
		const e = str(ev.error);
		if (e) s.retryErrors.push(e);
		s.transcript.push(`system/api_retry ${e ?? "unknown"}`);
	} else if (type === "assistant") {
		const content = obj(ev.message)?.content;
		const blocks = Array.isArray(content)
			? content
					.map((b) => {
						const o = obj(b);
						const t = str(o?.type) ?? "?";
						return t === "tool_use" ? `tool_use:${str(o?.name) ?? "?"}` : t;
					})
					.join(",")
			: "";
		s.transcript.push(`assistant [${blocks}]`);
	} else if (type === "result") {
		s.result = ev;
		s.sessionId = str(ev.session_id) ?? s.sessionId;
		s.transcript.push(
			`result/${subtype ?? "?"} is_error=${ev.is_error === true}`,
		);
	} else {
		s.transcript.push(subtype ? `${type}/${subtype}` : type);
	}
}

function usageOf(result: Record<string, unknown> | null) {
	if (!result) return null;
	const out: Record<string, unknown> = {};
	for (const k of [
		"usage",
		"modelUsage",
		"total_cost_usd",
		"num_turns",
		"duration_ms",
	])
		if (result[k] !== undefined && result[k] !== null) out[k] = result[k];
	return Object.keys(out).length > 0 ? out : null;
}

export function createClaudeImplementer(
	cfg: ClaudeProviderConfig,
): ImplementationAdapter {
	return {
		provider: "claude",
		mode: "live",
		model_requested: cfg.model,

		async preflight(ctx: AdapterContext): Promise<Preflight> {
			const exe = await checkExecutable(ctx, cfg.executable, ctx.scratchDir);
			if (!exe.ok) return exe;
			// Assumed to be a local credential read (no model request). Output may contain the
			// account email, so only three non-identifying fields are kept.
			const r = await ctx.run({
				argv: [cfg.executable, "auth", "status", "--json"],
				cwd: ctx.scratchDir,
				env: providerEnv(),
				timeoutMs: 10_000,
				maxOutputBytes: 16_384,
			});
			const status = parseJsonLine(r.stdout.replace(/\n/g, " "));
			if (r.exitCode !== 0 || status?.loggedIn === false)
				return {
					ok: false,
					kind: "provider_auth",
					detail: "claude is not logged in (run `claude auth login` yourself)",
					version: exe.version,
				};
			const method = str(status?.authMethod) ?? "unknown";
			const plan = str(status?.subscriptionType) ?? "unknown";
			return {
				ok: true,
				detail: `${exe.detail}; logged in (auth method ${method}, subscription ${plan})`,
				version: exe.version,
			};
		},

		async implement(
			input: ImplementInput,
			ctx: AdapterContext,
		): Promise<ImplementResult> {
			const session = input.resumeSession
				? { id: input.resumeSession, resume: true }
				: { id: randomUUID(), resume: false };
			const stream = newClaudeStream();
			const r = await ctx.run({
				argv: claudeArgs(cfg, session),
				cwd: input.worktree,
				env: providerEnv(),
				stdin: implementationPrompt(input.task, input.run),
				timeoutMs: cfg.timeout_s * 1000,
				onStdoutLine: (line) => foldClaudeLine(stream, line),
			});

			const result = stream.result;
			const resultText = str(result?.result) ?? "";
			const meta: ProviderMeta = {
				// what the CLI reported; the id we asked for only when it reported none
				session_ref: stream.sessionId ?? (r.spawned ? session.id : null),
				model_resolved: stream.model,
				usage: usageOf(result),
				logTruncated: r.stdoutTruncated || r.stderrTruncated || r.lineOverflow,
				log: [
					`claude exit=${r.exitCode ?? "none"} signal=${r.signal ?? "none"} timed_out=${r.timedOut} aborted=${r.aborted} malformed_lines=${stream.malformed}`,
					...stream.transcript.slice(-400),
					"## result",
					resultText.slice(0, 4000),
					"## stderr",
					r.stderr.slice(-4000),
				].join("\n"),
			};
			const failed = (kind: FailureKind, detail: string): ImplementResult => ({
				...meta,
				ok: false,
				kind,
				detail,
			});

			if (!r.spawned)
				return failed(
					"provider_unavailable",
					`claude could not be started: ${redact(r.spawnError ?? "unknown")}`,
				);
			if (r.aborted) return failed("cancelled", "claude was stopped");
			if (r.timedOut)
				return failed(
					"timeout",
					`claude did not finish within ${cfg.timeout_s}s and was terminated`,
				);
			const errorText = `${resultText}\n${r.stderr}`;
			if (!result) {
				if (r.exitCode !== 0)
					return failed(
						classifyFailure(errorText, stream.retryErrors),
						`claude exited ${r.exitCode} without a result message`,
					);
				return failed(
					"provider_output_invalid",
					`claude produced no result message${meta.logTruncated ? " (output was truncated)" : ""}`,
				);
			}
			if (
				result.is_error === true ||
				result.subtype !== "success" ||
				r.exitCode !== 0
			)
				return failed(
					classifyFailure(errorText, stream.retryErrors),
					`claude reported ${str(result.subtype) ?? "an error"}: ${redact(resultText.slice(0, 300))}`,
				);

			// Structured output if the CLI provided it; else the result text as JSON; else plain text.
			const structured = ImplementationOutput.safeParse(
				result.structured_output,
			);
			if (structured.success)
				return { ...meta, ok: true, output: structured.data };
			const fromText = ImplementationOutput.safeParse(
				parseJsonLine(resultText),
			);
			if (fromText.success) return { ...meta, ok: true, output: fromText.data };
			return {
				...meta,
				ok: true,
				log: `${meta.log}\n## note\nno structured output; the summary is the plain result text`,
				output: {
					contract: IMPLEMENTATION_CONTRACT,
					status: "completed",
					summary: redact(resultText).slice(0, 2000),
				},
			};
		},
	};
}
