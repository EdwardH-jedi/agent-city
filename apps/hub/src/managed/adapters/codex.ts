// Codex CLI reviewer (execution_mode `live`). Off unless the managed config enables live execution.
//
// UNVERIFIED AGAINST A BINARY: `codex` is not installed on the machine this was written on. The
// flags and JSONL events below are taken from the non-interactive docs
// (learn.chatgpt.com/docs/non-interactive-mode) and exercised only against stub executables:
//   codex exec --json --sandbox read-only --model <m> --cd <dir>
//              --ignore-user-config --ignore-rules                          no inherited config/rules
//              --output-schema <file> --output-last-message <file> -        (prompt on stdin)
//   codex exec resume <SESSION_ID> …                                        explicit id, never --last
//   events: thread.started{thread_id} · turn.completed{usage} · turn.failed · item.completed · error
// Capability policy (v0.1.1 P2.5): every flag above must appear in `codex exec --help` before a
// review is launched. Auth: Codex documents no machine-readable login status, so a review is
// blocked unless `auth_status_pattern` (set after a no-model capability check) matches the output
// of `codex login status`. Text is never treated as conclusive without that explicit pattern.
//
// Read-only is requested with --sandbox read-only AND checked: the orchestrator fingerprints the
// workspace before and after the review and discards a review that changed it. Scratch files
// (schema, last message) live in a private per-run directory the orchestrator removes afterwards.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "@agent-city/schema";
import type { CodexProviderConfig } from "../config.ts";
import { clipTail } from "../evidence.ts";
import {
	BoundedLog,
	checkCapabilities,
	checkExecutable,
	classifyFailure,
	obj,
	parseJsonLine,
	protocolLoss,
	providerEnv,
	REVIEW_JSON_SCHEMA,
	readFileBounded,
	reviewPrompt,
	settled,
	str,
	UNSETTLED_DETAIL,
} from "./cli.ts";
import type {
	AdapterContext,
	Preflight,
	ProviderMeta,
	ReviewAdapter,
	ReviewInput,
	ReviewResult,
} from "./types.ts";

export const LAST_MESSAGE_MAX_BYTES = 1_048_576;
const ERRORS_MAX = 20;

/** Controls that must be present in `codex exec --help`. */
export const CODEX_REQUIRED_CONTROLS = [
	"--json",
	"--sandbox",
	"--model",
	"--cd",
	"--ignore-user-config",
	"--ignore-rules",
	"--output-schema",
	"--output-last-message",
] as const;

export function codexArgs(
	cfg: CodexProviderConfig,
	o: {
		worktree: string;
		schemaFile: string;
		outFile: string;
		resumeThread?: string;
	},
): string[] {
	return [
		cfg.executable,
		"exec",
		...(o.resumeThread ? ["resume", o.resumeThread] : []),
		"--json",
		"--sandbox",
		"read-only",
		"--ignore-user-config",
		"--ignore-rules",
		"--model",
		cfg.model,
		"--cd",
		o.worktree,
		"--output-schema",
		o.schemaFile,
		"--output-last-message",
		o.outFile,
		"-",
	];
}

export interface CodexStream {
	threadId: string | null;
	usage: Record<string, unknown> | null;
	/** Last agent message, clipped to LAST_MESSAGE_MAX_BYTES characters. */
	lastMessage: string | null;
	errors: string[];
	malformed: number;
	transcript: BoundedLog;
}

export function newCodexStream(maxLogBytes = 262_144): CodexStream {
	return {
		threadId: null,
		usage: null,
		lastMessage: null,
		errors: [],
		malformed: 0,
		transcript: new BoundedLog(maxLogBytes),
	};
}

export function foldCodexLine(s: CodexStream, line: string): void {
	if (line.trim().length === 0) return;
	const ev = parseJsonLine(line);
	if (!ev) {
		s.malformed++;
		return;
	}
	const type = (str(ev.type) ?? "?").slice(0, 40);
	if (type === "thread.started")
		s.threadId = str(ev.thread_id)?.slice(0, 128) ?? s.threadId;
	else if (type === "turn.completed") {
		const usage = obj(ev.usage);
		const json = usage ? JSON.stringify(usage) : "";
		s.usage = usage && json.length <= 16_000 ? usage : s.usage;
	} else if (type === "turn.failed" || type === "error") {
		const msg = str(obj(ev.error)?.message) ?? str(ev.message) ?? type;
		if (s.errors.length < ERRORS_MAX) s.errors.push(msg.slice(0, 500));
	} else if (type === "item.completed") {
		const item = obj(ev.item);
		const itemType = (str(item?.type) ?? "?").slice(0, 40);
		if (itemType === "agent_message")
			s.lastMessage =
				str(item?.text)?.slice(0, LAST_MESSAGE_MAX_BYTES) ?? s.lastMessage;
		// item kind only — no reasoning text, no command output
		s.transcript.push(`item.completed ${itemType}`);
		return;
	}
	s.transcript.push(type);
}

/** `codex login status` → ok only if the operator-established pattern matches (P2.5). */
export function readCodexAuth(
	output: string,
	exitCode: number | null,
	pattern: string | null,
): Preflight {
	if (exitCode !== 0)
		return {
			ok: false,
			kind: "provider_auth",
			detail: "codex is not logged in (run `codex login` yourself)",
		};
	if (pattern === null)
		return {
			ok: false,
			kind: "provider_auth",
			detail:
				"codex sign-in method cannot be verified: Codex documents no machine-readable login status and auth_status_pattern is not set (establish it with a no-model capability check)",
		};
	let re: RegExp;
	try {
		re = new RegExp(pattern);
	} catch {
		return {
			ok: false,
			kind: "provider_auth",
			detail: "auth_status_pattern is not a valid regular expression",
		};
	}
	return re.test(output.slice(0, 4_096))
		? { ok: true, detail: "codex sign-in matches auth_status_pattern" }
		: {
				ok: false,
				kind: "provider_auth",
				detail:
					"codex sign-in does not match auth_status_pattern (an API-key or unknown sign-in is refused)",
			};
}

export function createCodexReviewer(cfg: CodexProviderConfig): ReviewAdapter {
	return {
		provider: "codex",
		mode: "live",
		model_requested: cfg.model,

		async preflight(ctx: AdapterContext): Promise<Preflight> {
			const exe = await checkExecutable(ctx, cfg.executable, ctx.scratchDir);
			if (!exe.ok) return exe;
			const caps = await checkCapabilities(
				ctx,
				[cfg.executable, "exec", "--help"],
				CODEX_REQUIRED_CONTROLS,
				ctx.scratchDir,
			);
			if (!caps.ok) return { ...caps, version: exe.version };
			const r = await ctx.run({
				argv: [cfg.executable, "login", "status"],
				cwd: ctx.scratchDir,
				env: providerEnv(),
				timeoutMs: 10_000,
				maxOutputBytes: 4_096,
			});
			if (!settled(r))
				return {
					ok: false,
					kind: "provider_unavailable",
					detail: `codex login status ${UNSETTLED_DETAIL}`,
					version: exe.version,
				};
			const auth = readCodexAuth(
				`${r.stdout}\n${r.stderr}`,
				r.exitCode,
				cfg.auth_status_pattern,
			);
			return {
				...auth,
				detail: `${exe.detail}; ${caps.detail}; ${auth.detail}`,
				version: exe.version,
			};
		},

		async review(
			input: ReviewInput,
			ctx: AdapterContext,
		): Promise<ReviewResult> {
			// Scratch files live outside the worktree so the review cannot dirty the candidate.
			const schemaFile = join(ctx.scratchDir, "review-schema.json");
			const outFile = join(ctx.scratchDir, "review-last-message.json");
			writeFileSync(schemaFile, JSON.stringify(REVIEW_JSON_SCHEMA), {
				mode: 0o600,
			});
			writeFileSync(outFile, "", { mode: 0o600 });
			try {
				const stream = newCodexStream(ctx.maxLogBytes);
				const r = await ctx.run({
					argv: codexArgs(cfg, {
						worktree: input.worktree,
						schemaFile,
						outFile,
					}),
					cwd: input.worktree,
					env: providerEnv(),
					stdin: reviewPrompt(
						input.task,
						input.candidate_sha,
						input.manifest_hash,
						input.manifest.verification,
						input.diff,
					),
					timeoutMs: cfg.timeout_s * 1000,
					onStdoutLine: (line) => foldCodexLine(stream, line),
				});

				const meta: ProviderMeta = {
					session_ref: stream.threadId,
					// the documented event stream does not report the resolved model
					model_resolved: null,
					usage: stream.usage,
					logTruncated:
						r.stdoutTruncated ||
						r.stderrTruncated ||
						r.lineOverflow ||
						stream.transcript.truncated,
					log: [
						`codex exit=${r.exitCode ?? "none"} signal=${r.signal ?? "none"} timed_out=${r.timedOut} aborted=${r.aborted} malformed_lines=${stream.malformed}`,
						stream.transcript.text(),
						"## errors",
						...stream.errors,
						"## stderr",
						clipTail(r.stderr, 4000),
					].join("\n"),
				};

				if (!r.spawned)
					return {
						...meta,
						ok: false,
						kind: "provider_unavailable",
						detail: `codex could not be started: ${redact(r.spawnError ?? "unknown")}`,
					};
				if (r.aborted)
					return {
						...meta,
						ok: false,
						kind: "cancelled",
						detail: "codex was stopped",
					};
				if (r.timedOut)
					return {
						...meta,
						ok: false,
						kind: "timeout",
						detail: `codex did not finish within ${cfg.timeout_s}s and was terminated`,
					};
				if (r.exitCode !== 0 || stream.errors.length > 0) {
					const text = `${stream.errors.join("\n")}\n${r.stderr}`;
					return {
						...meta,
						ok: false,
						kind: classifyFailure(text),
						detail: `codex exited ${r.exitCode}: ${redact((stream.errors[0] ?? r.stderr).slice(0, 300))}`,
					};
				}

				// an explicit turn.failed may be exactly the record that was lost
				const loss = protocolLoss(r, stream.malformed);
				if (loss)
					return {
						...meta,
						ok: false,
						kind: "provider_output_invalid",
						detail: `codex protocol output is incomplete (${loss}); its verdict is not trusted`,
					};

				const fromFile = readFileBounded(outFile, LAST_MESSAGE_MAX_BYTES);
				if (fromFile.rejected)
					return {
						...meta,
						ok: false,
						kind: "provider_output_invalid",
						detail: `codex final message file was refused: ${fromFile.rejected}`,
					};
				if (fromFile.truncated)
					return {
						...meta,
						ok: false,
						kind: "provider_output_invalid",
						detail: `codex final message exceeds ${LAST_MESSAGE_MAX_BYTES} bytes`,
					};
				let text = fromFile.text;
				if (text.trim().length === 0) text = stream.lastMessage ?? "";
				if (text.trim().length === 0)
					return {
						...meta,
						ok: false,
						kind: "provider_output_invalid",
						detail: `codex produced no final message${meta.logTruncated ? " (output was truncated)" : ""}`,
					};
				// Not validated here: the orchestrator checks the shape and the candidate binding.
				let raw: unknown;
				try {
					raw = JSON.parse(text);
				} catch {
					raw = text.slice(0, 4000);
				}
				return { ...meta, ok: true, raw };
			} finally {
				// the raw final message is never retained; only validated/redacted copies are stored
				rmSync(outFile, { force: true });
				rmSync(schemaFile, { force: true });
			}
		},
	};
}
