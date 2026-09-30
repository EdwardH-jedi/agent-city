// Shared pieces of the real CLI adapters (Claude implement, Codex review): executable preflight,
// JSONL parsing, failure classification, prompts and the JSON Schemas handed to the CLIs.
import { accessSync, constants, statSync } from "node:fs";
import { basename } from "node:path";
import {
	type FailureKind,
	IMPLEMENTATION_CONTRACT,
	type ManagedRun,
	type ManagedTask,
	REVIEW_CONTRACT,
} from "@agent-city/schema";
import { childEnv } from "../proc.ts";
import type { AdapterContext, Preflight } from "./types.ts";

/**
 * Environment for a provider CLI: the allowlist only. API keys are deliberately NOT passed
 * (ANTHROPIC_API_KEY, OPENAI_API_KEY, CODEX_API_KEY, …), so a CLI uses its own saved login and
 * cannot silently switch to metered API billing.
 */
export const providerEnv = () => childEnv();

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
	if (!r.spawned || r.timedOut || r.exitCode !== 0)
		return {
			ok: false,
			kind: "provider_unavailable",
			detail: `${name} --version did not succeed`,
		};
	const version = r.stdout.trim().split("\n")[0]?.slice(0, 80) ?? null;
	return { ok: true, detail: `${name} ${version ?? ""}`.trim(), version };
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
