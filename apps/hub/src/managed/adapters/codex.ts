// Codex CLI reviewer (execution_mode `live`). Off unless the managed config enables live execution.
//
// UNVERIFIED AGAINST A BINARY: `codex` is not installed on the machine this was written on. The
// flags and JSONL events below are taken from the non-interactive docs
// (learn.chatgpt.com/docs/non-interactive-mode) and exercised only against stub executables:
//   codex exec --json --sandbox read-only --model <m> --cd <dir>
//              --output-schema <file> --output-last-message <file> -        (prompt on stdin)
//   codex exec resume <SESSION_ID> …                                        explicit id, never --last
//   events: thread.started{thread_id} · turn.completed{usage} · turn.failed · item.completed · error
// `codex login status` as an auth preflight is an assumption as well.
//
// Read-only is requested with --sandbox read-only AND checked: the orchestrator fingerprints the
// workspace before and after the review and discards a review that changed it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "@agent-city/schema";
import type { CliProviderConfig } from "../config.ts";
import {
	checkExecutable,
	classifyFailure,
	obj,
	parseJsonLine,
	providerEnv,
	REVIEW_JSON_SCHEMA,
	reviewPrompt,
	str,
} from "./cli.ts";
import type {
	AdapterContext,
	Preflight,
	ProviderMeta,
	ReviewAdapter,
	ReviewInput,
	ReviewResult,
} from "./types.ts";

const LAST_MESSAGE_MAX_BYTES = 1_048_576;

export function codexArgs(
	cfg: CliProviderConfig,
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
	lastMessage: string | null;
	errors: string[];
	malformed: number;
	transcript: string[];
}

export function newCodexStream(): CodexStream {
	return {
		threadId: null,
		usage: null,
		lastMessage: null,
		errors: [],
		malformed: 0,
		transcript: [],
	};
}

export function foldCodexLine(s: CodexStream, line: string): void {
	if (line.trim().length === 0) return;
	const ev = parseJsonLine(line);
	if (!ev) {
		s.malformed++;
		return;
	}
	const type = str(ev.type) ?? "?";
	if (type === "thread.started") s.threadId = str(ev.thread_id) ?? s.threadId;
	else if (type === "turn.completed") s.usage = obj(ev.usage) ?? s.usage;
	else if (type === "turn.failed" || type === "error") {
		const msg = str(obj(ev.error)?.message) ?? str(ev.message) ?? type;
		s.errors.push(msg);
	} else if (type === "item.completed") {
		const item = obj(ev.item);
		const itemType = str(item?.type) ?? "?";
		if (itemType === "agent_message")
			s.lastMessage = str(item?.text) ?? s.lastMessage;
		// item kind only — no reasoning text, no command output
		s.transcript.push(`item.completed ${itemType}`);
		return;
	}
	s.transcript.push(type);
}

export function createCodexReviewer(cfg: CliProviderConfig): ReviewAdapter {
	return {
		provider: "codex",
		mode: "live",
		model_requested: cfg.model,

		async preflight(ctx: AdapterContext): Promise<Preflight> {
			const exe = await checkExecutable(ctx, cfg.executable, ctx.scratchDir);
			if (!exe.ok) return exe;
			const r = await ctx.run({
				argv: [cfg.executable, "login", "status"],
				cwd: ctx.scratchDir,
				env: providerEnv(),
				timeoutMs: 10_000,
				maxOutputBytes: 4_096,
			});
			if (r.exitCode !== 0)
				return {
					ok: false,
					kind: "provider_auth",
					detail: "codex is not logged in (run `codex login` yourself)",
					version: exe.version,
				};
			return {
				ok: true,
				detail: `${exe.detail}; logged in`,
				version: exe.version,
			};
		},

		async review(
			input: ReviewInput,
			ctx: AdapterContext,
		): Promise<ReviewResult> {
			// Scratch files live outside the worktree so the review cannot dirty the candidate.
			const schemaFile = join(ctx.scratchDir, "review-schema.json");
			const outFile = join(
				ctx.scratchDir,
				`review-last-message-${input.run.id}.json`,
			);
			writeFileSync(schemaFile, JSON.stringify(REVIEW_JSON_SCHEMA), {
				mode: 0o600,
			});
			writeFileSync(outFile, "", { mode: 0o600 });

			const stream = newCodexStream();
			const r = await ctx.run({
				argv: codexArgs(cfg, { worktree: input.worktree, schemaFile, outFile }),
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
				logTruncated: r.stdoutTruncated || r.stderrTruncated || r.lineOverflow,
				log: [
					`codex exit=${r.exitCode ?? "none"} signal=${r.signal ?? "none"} timed_out=${r.timedOut} aborted=${r.aborted} malformed_lines=${stream.malformed}`,
					...stream.transcript.slice(-400),
					"## errors",
					...stream.errors.map((e) => e.slice(0, 500)),
					"## stderr",
					r.stderr.slice(-4000),
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

			let text = "";
			if (existsSync(outFile))
				text = readFileSync(outFile)
					.subarray(0, LAST_MESSAGE_MAX_BYTES)
					.toString("utf8");
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
		},
	};
}
