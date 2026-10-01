// Shared pieces of the real CLI adapters (Claude implement, Codex review): executable preflight,
// JSONL parsing, failure classification, prompts and the JSON Schemas handed to the CLIs.
import {
	accessSync,
	closeSync,
	constants,
	fstatSync,
	openSync,
	readSync,
	statSync,
} from "node:fs";
import { basename } from "node:path";
import {
	type FailureKind,
	IMPLEMENTATION_CONTRACT,
	type ManagedRun,
	type ManagedTask,
	REVIEW_CONTRACT,
} from "@agent-city/schema";
import { SAFE_READ_FLAGS } from "../evidence.ts";
import { childEnv, type RunResult } from "../proc.ts";
import type { AdapterContext, Preflight } from "./types.ts";

/**
 * The check command ran to its own exit AND everything it started is proven gone. Its exit code
 * never outweighs an unresolved child: such a run is quarantined and nothing more may start.
 */
export const settled = (r: RunResult): boolean =>
	r.spawned &&
	!r.timedOut &&
	!r.aborted &&
	r.exitCode !== null &&
	r.terminationConfirmed &&
	r.unresolved === null;

/** Settled with exit code 0. */
export const cleanExit = (r: RunResult): boolean =>
	settled(r) && r.exitCode === 0;

export const UNSETTLED_DETAIL =
	"did not finish cleanly (stopped, timed out, or something it started could not be confirmed gone)";

/**
 * Environment for a provider CLI: the allowlist only. API-key variables (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, CODEX_API_KEY, …) are not passed. That alone does NOT guarantee subscription
 * billing — HOME still holds whatever login the CLI saved (which may be an API-key / Console
 * login). The positive auth check in each adapter's preflight is what refuses those; see
 * docs/managed-runs.md for what remains unverified against real binaries.
 */
export const providerEnv = () => childEnv();

/**
 * Append-only diagnostic text with a hard byte budget: many small events cannot grow it past
 * `maxBytes`. Each entry is clipped; once the budget is spent further entries only bump a counter.
 */
export class BoundedLog {
	private entries: string[] = [];
	private bytes = 0;
	private dropped = 0;
	constructor(
		private readonly maxBytes: number,
		private readonly maxEntry = 300,
	) {}
	push(entry: string): void {
		const e =
			entry.length > this.maxEntry
				? `${entry.slice(0, this.maxEntry)}…`
				: entry;
		const size = Buffer.byteLength(e) + 1;
		if (this.bytes + size > this.maxBytes) {
			this.dropped++;
			return;
		}
		this.entries.push(e);
		this.bytes += size;
	}
	get truncated(): boolean {
		return this.dropped > 0;
	}
	text(): string {
		return this.dropped > 0
			? `${this.entries.join("\n")}\n[${this.dropped} further events not kept]`
			: this.entries.join("\n");
	}
}

/**
 * Read at most `maxBytes` of a file: the buffer is allocated from the real (bounded) size, not from
 * the whole file. Missing → "". Anything that is not a regular file (symlink, FIFO, device,
 * directory) or cannot be opened → "" with `rejected` set. `truncated` when the file is larger.
 */
export function readFileBounded(
	path: string,
	maxBytes: number,
): { text: string; truncated: boolean; rejected?: string } {
	let fd: number;
	try {
		fd = openSync(path, SAFE_READ_FLAGS);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { text: "", truncated: false };
		return {
			text: "",
			truncated: false,
			rejected:
				code === "ELOOP" ? "is a symlink" : `cannot be opened (${code})`,
		};
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile())
			return { text: "", truncated: false, rejected: "not a regular file" };
		const len = Math.min(st.size, maxBytes);
		const buf = Buffer.alloc(len);
		let off = 0;
		while (off < len) {
			const n = readSync(fd, buf, off, len - off, off);
			if (n <= 0) break;
			off += n;
		}
		return {
			text: buf.subarray(0, off).toString("utf8"),
			truncated: st.size > maxBytes,
		};
	} finally {
		closeSync(fd);
	}
}

/**
 * Version-supported capability policy: every required control must appear in the executable's
 * own help output (no model call). A missing control blocks the run — the isolation it provides
 * cannot be established, so nothing is launched. Help text is matched as whole flags only.
 */
export async function checkCapabilities(
	ctx: AdapterContext,
	helpArgv: readonly string[],
	required: readonly string[],
	cwd: string,
): Promise<Preflight> {
	const name = basename(helpArgv[0] ?? "provider");
	const r = await ctx.run({
		argv: helpArgv,
		cwd,
		env: providerEnv(),
		timeoutMs: PREFLIGHT_TIMEOUT_MS,
		maxOutputBytes: 262_144,
	});
	if (!cleanExit(r))
		return {
			ok: false,
			kind: "provider_unavailable",
			detail: `${name}: help output unavailable; required controls cannot be verified`,
		};
	const text = `${r.stdout}\n${r.stderr}`;
	const missing = required.filter(
		(flag) =>
			!new RegExp(
				`(^|[\\s,])${flag.replace(/[-]/g, "\\-")}(?=[\\s,=<\\[]|$)`,
				"m",
			).test(text),
	);
	if (missing.length > 0)
		return {
			ok: false,
			kind: "provider_unavailable",
			detail: `${name}: this version does not offer required controls: ${missing.join(", ")}`,
		};
	return { ok: true, detail: `${name}: required controls present` };
}

const PREFLIGHT_TIMEOUT_MS = 10_000;

/** The configured path must be an executable regular file that answers `--version`. No model call. */
export async function checkExecutable(
	ctx: AdapterContext,
	executable: string,
	cwd: string,
): Promise<Preflight> {
	const name = basename(executable);
	try {
		if (!statSync(executable).isFile()) throw new Error("not a file");
		accessSync(executable, constants.X_OK);
	} catch {
		return {
			ok: false,
			kind: "provider_unavailable",
			detail: `${name}: configured executable is missing or not executable`,
		};
	}
	const r = await ctx.run({
		argv: [executable, "--version"],
		cwd,
		env: providerEnv(),
		timeoutMs: PREFLIGHT_TIMEOUT_MS,
		maxOutputBytes: 4_096,
	});
	if (!cleanExit(r))
		return {
			ok: false,
			kind: "provider_unavailable",
			detail: `${name} --version did not succeed`,
		};
	const version = r.stdout.trim().split("\n")[0]?.slice(0, 80) ?? null;
	return { ok: true, detail: `${name} ${version ?? ""}`.trim(), version };
}

/**
 * Protocol loss, as opposed to diagnostic truncation. In both providers' JSONL modes every stdout
 * line is a protocol record (diagnostics go to stderr; blank lines are ignored; unknown event types
 * are tolerated). A record dropped for its size, or one that does not parse, may have been the one
 * that reported failure — so a later terminal success cannot be trusted. Capture caps (stdout /
 * stderr / transcript truncation) only shorten the stored log and are NOT protocol loss.
 */
export function protocolLoss(
	r: Pick<RunResult, "lineOverflow">,
	malformed: number,
): string | null {
	const lost: string[] = [];
	if (r.lineOverflow) lost.push("a record over the line limit was dropped");
	if (malformed > 0)
		lost.push(`${malformed} stdout line(s) were not valid records`);
	return lost.length > 0 ? lost.join("; ") : null;
}

/** Parse one JSONL line; null when it is not a JSON object. */
export function parseJsonLine(line: string): Record<string, unknown> | null {
	const t = line.trim();
	if (!t.startsWith("{")) return null;
	try {
		const v = JSON.parse(t) as unknown;
		return v !== null && typeof v === "object" && !Array.isArray(v)
			? (v as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

export const str = (v: unknown): string | null =>
	typeof v === "string" && v.length > 0 ? v : null;

export const obj = (v: unknown): Record<string, unknown> | null =>
	v !== null && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: null;

const RETRY_KINDS: Record<string, FailureKind> = {
	authentication_failed: "provider_auth",
	oauth_org_not_allowed: "provider_auth",
	billing_error: "provider_quota",
	account_on_hold: "provider_quota",
	rate_limit: "provider_quota",
	model_not_found: "provider_model",
};

/**
 * Map a provider failure to a kind. Structured error categories win; otherwise a text heuristic
 * (UNVERIFIED against live failures — a miss falls back to `provider_error`, never to success).
 */
export function classifyFailure(
	text: string,
	categories: readonly string[] = [],
): FailureKind {
	for (const c of categories) {
		const k = RETRY_KINDS[c];
		if (k) return k;
	}
	if (
		/model[^\n]{0,60}(not found|not available|unsupported|does not exist|not supported)|unknown model|invalid model/i.test(
			text,
		)
	)
		return "provider_model";
	if (
		/not logged in|please (run|use) \/?login|login required|invalid api key|unauthori[sz]ed|authentication|\b401\b/i.test(
			text,
		)
	)
		return "provider_auth";
	if (
		/usage limit|rate limit|quota|billing|insufficient credit|\b429\b/i.test(
			text,
		)
	)
		return "provider_quota";
	return "provider_error";
}

// ── schemas handed to the CLIs (strict: every key required, no extras) ───────

export const IMPLEMENTATION_JSON_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["contract", "status", "summary"],
	properties: {
		contract: { type: "string", enum: [IMPLEMENTATION_CONTRACT] },
		status: { type: "string", enum: ["completed", "blocked"] },
		summary: { type: "string" },
	},
} as const;

export const REVIEW_JSON_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: [
		"contract",
		"audited_sha",
		"manifest_hash",
		"verdict",
		"findings",
		"tests_executed",
		"summary",
	],
	properties: {
		contract: { type: "string", enum: [REVIEW_CONTRACT] },
		audited_sha: { type: "string" },
		manifest_hash: { type: "string" },
		verdict: { type: "string", enum: ["approve", "reject"] },
		findings: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["severity", "title", "detail", "file", "line", "actionable"],
				properties: {
					severity: {
						type: "string",
						enum: ["blocker", "major", "minor", "info"],
					},
					title: { type: "string" },
					detail: { type: "string" },
					file: { type: ["string", "null"] },
					line: { type: ["integer", "null"] },
					actionable: { type: "boolean" },
				},
			},
		},
		tests_executed: { type: "boolean", enum: [false] },
		summary: { type: "string" },
	},
} as const;

// ── prompts (user-authored task text + trusted evidence; passed on stdin, never as argv) ──

const list = (items: readonly string[]) =>
	items.map((i) => `- ${i}`).join("\n");

export function implementationPrompt(
	task: ManagedTask,
	run: ManagedRun,
): string {
	const repair =
		run.kind === "repair" && run.repair_input
			? `\n## Findings to fix (from verification / review of the previous attempt)\n${run.repair_input
					.map(
						(f) =>
							`- [${f.severity}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}\n  ${f.detail.replace(/\n/g, "\n  ")}`,
					)
					.join("\n")}\n`
			: "";
	return `You are implementing one bounded task in the current working directory (a git worktree).

## Task: ${task.title}
${task.objective}

## Acceptance criteria
${list(task.acceptance_criteria)}

## Approved scope (only change files under these paths)
${list(task.approved_scope)}
${repair}
## Rules
- Work only inside the current working directory and the approved scope.
- Do not commit, push, create branches or pull requests, or change git configuration. Leave your changes in the working tree; they are checkpointed for you.
- Do not read files outside this directory.
- You cannot run tests here; verification is run separately after you finish.
- If you cannot complete the task, report status "blocked" and say why.

Finish with a JSON object matching the provided schema (contract "${IMPLEMENTATION_CONTRACT}").`;
}

export const REVIEW_DIFF_MAX_CHARS = 200_000;

export function reviewPrompt(
	task: ManagedTask,
	candidateSha: string,
	manifestHash: string,
	verification: readonly { name: string; exit_code: number | null }[],
	diff: string,
): string {
	const clipped =
		diff.length > REVIEW_DIFF_MAX_CHARS
			? `${diff.slice(0, REVIEW_DIFF_MAX_CHARS)}\n[diff truncated — read the files in the working directory for the rest]`
			: diff;
	return `You are reviewing one candidate change. The current working directory is a read-only checkout of the candidate.

## Task: ${task.title}
${task.objective}

## Acceptance criteria
${list(task.acceptance_criteria)}

## Approved scope
${list(task.approved_scope)}

## Candidate
- commit: ${candidateSha}
- evidence manifest: ${manifestHash}
- verification already run by the orchestrator: ${verification.map((v) => `${v.name} (exit ${v.exit_code})`).join(", ")}

## Rules
- Do not modify any file and do not run tests or builds. You did not execute tests: "tests_executed" must be false.
- Judge the change against the task and acceptance criteria. Mark a finding "actionable" only if an implementer can fix it from your description.
- "audited_sha" must be exactly ${candidateSha} and "manifest_hash" exactly ${manifestHash}.
- An approval must not contain blocker or major findings.

Return only a JSON object matching the provided schema (contract "${REVIEW_CONTRACT}").

## Diff (base → candidate)
${clipped}`;
}
