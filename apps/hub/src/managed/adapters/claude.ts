// Claude Code CLI implementer (execution_mode `live`). Off unless the managed config enables live
// execution. Flags were checked against `claude --help` of the installed 2.1.285 and the CLI
// reference (code.claude.com/docs/en/cli-reference):
//   -p --output-format stream-json --verbose        non-interactive, one JSON object per line
//   --session-id <uuid> | --resume <session id>     explicit session; never --continue
//   --model <m>                                     requested model; NO --fallback-model
//   --permission-mode acceptEdits --permission-prompts none   edits allowed, anything else denied
//   --tools / --allowedTools <list>                 built-in tools limited to the configured list
//   --json-schema <schema>                          structured final output
// Isolation from inherited configuration (v0.1.1 P2.5) — required, checked in `--help` first:
//   --safe-mode                 no CLAUDE.md, skills, plugins, hooks, MCP servers, custom agents…
//   --restricted                only managed settings + --settings load; file tools confined to the
//                               working directory; command-running tools removed unless in --tools
//   --strict-mcp-config         (with no --mcp-config) no MCP servers at all
//   --disable-slash-commands    no skills / commands
// Organisation-managed policy (managed settings) still applies by design of the CLI.
// Not used on purpose: --bare (API-key auth only), --dangerously-skip-permissions /
// bypassPermissions, --continue, --fallback-model.
//
// NOT live-verified: stream-json field shapes, the combined behaviour of the isolation flags, and
// the `auth status --json` field values come from the docs / --help only and are exercised against
// stub executables. Unknown shapes degrade to blocked / invalid, never to a fabricated success.
import { randomUUID } from "node:crypto";
import {
	type FailureKind,
	IMPLEMENTATION_CONTRACT,
	ImplementationOutput,
	redact,
} from "@agent-city/schema";
import type { ClaudeProviderConfig } from "../config.ts";
import { clipTail, dropTrailingFragment } from "../evidence.ts";
import {
	BoundedLog,
	checkCapabilities,
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

/** Controls that must be present in `claude --help`; without any of them nothing is launched. */
export const CLAUDE_REQUIRED_CONTROLS = [
	"--print",
	"--output-format",
	"--verbose",
	"--model",
	"--permission-mode",
	"--permission-prompts",
	"--tools",
	"--allowedTools",
	"--json-schema",
	"--session-id",
	"--resume",
	"--safe-mode",
	"--restricted",
	"--strict-mcp-config",
	"--disable-slash-commands",
] as const;

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
		"--safe-mode",
		"--restricted",
		"--strict-mcp-config",
		"--disable-slash-commands",
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

/** Bounded fields of the CLI's final `result` event (nothing else of it is kept). */
export interface ClaudeResult {
	subtype: string | null;
	is_error: boolean;
	session_id: string | null;
	/** Final text, clipped. */
	text: string;
	structured_output: unknown;
	usage: Record<string, unknown> | null;
}

export interface ClaudeStream {
	sessionId: string | null;
	model: string | null;
	result: ClaudeResult | null;
	/** `error` categories of system/api_retry events (bounded). */
	retryErrors: string[];
	malformed: number;
	/** Event summary: types, tool names. No message bodies, no thinking. Bounded. */
	transcript: BoundedLog;
}

export const RESULT_TEXT_MAX = 8_000;
const STRUCTURED_MAX = 64_000;
const USAGE_MAX = 16_000;
const RETRY_ERRORS_MAX = 20;

export function newClaudeStream(maxLogBytes = 262_144): ClaudeStream {
	return {
		sessionId: null,
		model: null,
		result: null,
		retryErrors: [],
		malformed: 0,
		transcript: new BoundedLog(maxLogBytes),
	};
}

/** A JSON value only if its serialization stays under `max` characters. */
function bounded(v: unknown, max: number): unknown {
	if (v === undefined || v === null) return null;
	const json = JSON.stringify(v);
	return json !== undefined && json.length <= max ? v : null;
}

/** Fold one stream-json line into the state. Unknown event types are counted, not trusted. */
export function foldClaudeLine(s: ClaudeStream, line: string): void {
	if (line.trim().length === 0) return;
	const ev = parseJsonLine(line);
	if (!ev) {
		s.malformed++;
		return;
	}
	const type = (str(ev.type) ?? "?").slice(0, 40);
	const subtype = str(ev.subtype)?.slice(0, 40) ?? null;
	if (type === "system" && subtype === "init") {
		s.sessionId = str(ev.session_id)?.slice(0, 128) ?? s.sessionId;
		s.model = str(ev.model)?.slice(0, 100) ?? s.model;
		s.transcript.push("system/init");
	} else if (type === "system" && subtype === "api_retry") {
		const e = str(ev.error)?.slice(0, 60) ?? null;
		if (e && s.retryErrors.length < RETRY_ERRORS_MAX) s.retryErrors.push(e);
		s.transcript.push(`system/api_retry ${e ?? "unknown"}`);
	} else if (type === "assistant") {
		const content = obj(ev.message)?.content;
		const blocks = Array.isArray(content)
			? content
					.slice(0, 20)
					.map((b) => {
						const o = obj(b);
						const t = (str(o?.type) ?? "?").slice(0, 30);
						return t === "tool_use"
							? `tool_use:${(str(o?.name) ?? "?").slice(0, 60)}`
							: t;
					})
					.join(",")
			: "";
		s.transcript.push(`assistant [${blocks}]`);
	} else if (type === "result") {
		const usage: Record<string, unknown> = {};
		for (const k of [
			"usage",
			"modelUsage",
			"total_cost_usd",
			"num_turns",
			"duration_ms",
		]) {
			const v = bounded(ev[k], USAGE_MAX);
			if (v !== null) usage[k] = v;
		}
		s.result = {
			subtype,
			is_error: ev.is_error === true,
			session_id: str(ev.session_id)?.slice(0, 128) ?? null,
			text: (str(ev.result) ?? "").slice(0, RESULT_TEXT_MAX),
			structured_output: bounded(ev.structured_output, STRUCTURED_MAX),
			usage: Object.keys(usage).length > 0 ? usage : null,
		};
		s.sessionId = s.result.session_id ?? s.sessionId;
		s.transcript.push(
			`result/${subtype ?? "?"} is_error=${ev.is_error === true}`,
		);
	} else {
		s.transcript.push(subtype ? `${type}/${subtype}` : type);
	}
}

/** `auth status --json` → only non-identifying fields; never the email or org. */
export function readClaudeAuth(
	stdout: string,
	exitCode: number | null,
	allowed: readonly string[],
): Preflight {
	const status = parseJsonLine(stdout.replace(/\r?\n/g, " "));
	if (!status)
		return {
			ok: false,
			kind: "provider_auth",
			detail:
				"claude auth status gave no parseable JSON; sign-in cannot be verified",
		};
	if (exitCode !== 0 || status.loggedIn !== true)
		return {
			ok: false,
			kind: "provider_auth",
			detail: "claude is not logged in (run `claude auth login` yourself)",
		};
	const method = str(status.authMethod);
	if (!method)
		return {
			ok: false,
			kind: "provider_auth",
			detail:
				"claude auth status reports no auth method; subscription sign-in cannot be verified",
		};
	if (!allowed.includes(method))
		return {
			ok: false,
			kind: "provider_auth",
			detail:
				allowed.length === 0
					? `auth method "${method.slice(0, 60)}" cannot be accepted: allowed_auth_methods is empty (record the subscription method from a no-model capability check)`
					: `auth method "${method.slice(0, 60)}" is not an allowed subscription method — metered/API-key sign-in is refused`,
		};
	const plan = str(status.subscriptionType)?.slice(0, 40) ?? "unknown";
	return {
		ok: true,
		detail: `logged in (auth method ${method.slice(0, 60)}, subscription ${plan})`,
	};
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
			const caps = await checkCapabilities(
				ctx,
				[cfg.executable, "--help"],
				CLAUDE_REQUIRED_CONTROLS,
				ctx.scratchDir,
			);
			if (!caps.ok) return { ...caps, version: exe.version };
			// Assumed to be a local credential read (no model request) — see docs/managed-runs.md.
			const r = await ctx.run({
				argv: [cfg.executable, "auth", "status", "--json"],
				cwd: ctx.scratchDir,
				env: providerEnv(),
				timeoutMs: 10_000,
				maxOutputBytes: 16_384,
			});
			const auth = readClaudeAuth(
				r.stdout,
				r.exitCode,
				cfg.allowed_auth_methods,
			);
			return {
				...auth,
				detail: `${exe.detail}; ${caps.detail}; ${auth.detail}`,
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
			const stream = newClaudeStream(ctx.maxLogBytes);
			const r = await ctx.run({
				argv: claudeArgs(cfg, session),
				cwd: input.worktree,
				env: providerEnv(),
				stdin: implementationPrompt(input.task, input.run),
				timeoutMs: cfg.timeout_s * 1000,
				onStdoutLine: (line) => foldClaudeLine(stream, line),
			});

			const result = stream.result;
			const resultText = result?.text ?? "";
			const meta: ProviderMeta = {
				// what the CLI reported; the id we asked for only when it reported none
				session_ref: stream.sessionId ?? (r.spawned ? session.id : null),
				model_resolved: stream.model,
				usage: result?.usage ?? null,
				logTruncated:
					r.stdoutTruncated ||
					r.stderrTruncated ||
					r.lineOverflow ||
					stream.transcript.truncated,
				log: [
					`claude exit=${r.exitCode ?? "none"} signal=${r.signal ?? "none"} timed_out=${r.timedOut} aborted=${r.aborted} malformed_lines=${stream.malformed}`,
					stream.transcript.text(),
					"## result",
					resultText.length > 4000
						? dropTrailingFragment(resultText.slice(0, 4000))
						: resultText,
					"## stderr",
					clipTail(r.stderr, 4000),
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
			if (result.is_error || result.subtype !== "success" || r.exitCode !== 0)
				return failed(
					classifyFailure(errorText, stream.retryErrors),
					`claude reported ${result.subtype ?? "an error"}: ${redact(resultText.slice(0, 300))}`,
				);

			// The implementation contract is structured output — or, failing that, the result text as
			// exactly that JSON. Anything else (plain text, wrong schema, "blocked" prose) is invalid:
			// it never becomes a completed implementation.
			const structured = ImplementationOutput.safeParse(
				result.structured_output,
			);
			if (structured.success)
				return { ...meta, ok: true, output: structured.data };
			const fromText = ImplementationOutput.safeParse(
				parseJsonLine(resultText),
			);
			if (fromText.success) return { ...meta, ok: true, output: fromText.data };
			return failed(
				"provider_output_invalid",
				`claude finished without a valid ${IMPLEMENTATION_CONTRACT} result (no structured output and the result text is not that JSON)`,
			);
		},
	};
}
