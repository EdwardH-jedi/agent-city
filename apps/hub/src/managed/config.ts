// Trusted managed-run configuration: which local repos may be targeted, which verification commands
// run (argv arrays, never a shell string), where workspaces/artifacts live, and which provider
// executables exist. It comes from a local file the user wrote (MANAGED_CONFIG) — never from a task,
// a repo file or a model. This module does not read process.env; index.ts passes the path in.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const expandHome = (p: string) =>
	p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;

const AbsPath = z
	.string()
	.min(1)
	.transform(expandHome)
	.refine((p) => isAbsolute(p), "must be an absolute path (or start with ~/)")
	.transform((p) => resolve(p));

const VerificationCommand = z.strictObject({
	name: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
	/** argv[0] is an absolute executable path; the rest are literal arguments. No shell. */
	argv: z
		.array(z.string().max(1000))
		.min(1)
		.max(40)
		.refine((a) => isAbsolute(a[0] ?? ""), "argv[0] must be an absolute path"),
	timeout_s: z.number().int().min(1).max(3600).default(300),
});
export type VerificationCommand = z.infer<typeof VerificationCommand>;

const RepoConfig = z.strictObject({
	id: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "owner/name or local/<dir>"),
	path: AbsPath,
	base_ref: z
		.string()
		.regex(/^[A-Za-z0-9._/-]{1,200}$/)
		.refine((r) => !r.startsWith("-") && !r.includes(".."), "unsafe ref"),
	verification: z.array(VerificationCommand).max(10).default([]),
});
export type RepoConfig = z.infer<typeof RepoConfig>;

const CliProvider = z.strictObject({
	executable: AbsPath,
	model: z.string().regex(/^[A-Za-z0-9._:[\]-]{1,100}$/),
	timeout_s: z.number().int().min(1).max(7200).default(1800),
});
export type CliProviderConfig = z.infer<typeof CliProvider>;

const ClaudeProvider = CliProvider.extend({
	/** Built-in tools the implementer may use. No Bash by default: verification is Agent City's job. */
	tools: z
		.array(z.string().regex(/^[A-Za-z]{1,40}$/))
		.min(1)
		.max(20)
		.default(["Read", "Edit", "Write", "Glob", "Grep"]),
	/**
	 * `authMethod` values of `claude auth status --json` that count as subscription sign-in. The CLI
	 * does not document the possible values, so this starts EMPTY = every live run is blocked until
	 * a person records the value a no-model capability check reported (never an API-key method).
	 */
	allowed_auth_methods: z
		.array(z.string().regex(/^[A-Za-z0-9._:-]{1,60}$/))
		.max(10)
		.default([]),
});
export type ClaudeProviderConfig = z.infer<typeof ClaudeProvider>;

const CodexProvider = CliProvider.extend({
	/**
	 * Codex documents no machine-readable login status. A regular expression that `codex login
	 * status` output must match to count as ChatGPT (subscription) sign-in, established by a
	 * no-model capability check against the installed version. null (default) = cannot be verified →
	 * every live review is blocked.
	 */
	auth_status_pattern: z.string().min(1).max(200).nullable().default(null),
});
export type CodexProviderConfig = z.infer<typeof CodexProvider>;

const Limits = z.strictObject({
	max_log_bytes: z.number().int().min(1024).max(8_000_000).default(262_144),
	max_diff_bytes: z.number().int().min(1024).max(8_000_000).default(1_048_576),
	// complete old/new file context read to decide safe diff disclosure (M1 omitted-hunk guard)
	max_context_file_bytes: z
		.number()
		.int()
		.min(1024)
		.max(16_777_216)
		.default(1_048_576),
	max_context_total_bytes: z
		.number()
		.int()
		.min(1024)
		.max(67_108_864)
		.default(16_777_216),
	// total bytes one sealed result may read (workspace evidence sealer)
	max_evidence_bytes: z
		.number()
		.int()
		.min(1024)
		.max(268_435_456)
		.default(67_108_864),
	kill_grace_ms: z.number().int().min(50).max(30_000).default(2_000),
	lease_ttl_ms: z.number().int().min(200).max(600_000).default(30_000),
	max_infra_retries: z.number().int().min(0).max(5).default(2),
});

export const ManagedConfig = z.strictObject({
	workspace_root: AbsPath,
	artifacts_root: AbsPath,
	git_executable: AbsPath.default("/usr/bin/git"),
	repos: z.array(RepoConfig).min(1).max(20),
	live: z
		.strictObject({
			/** Master switch. false (default) → live tasks are refused and no CLI adapter is built. */
			enabled: z.boolean().default(false),
			claude: ClaudeProvider.optional(),
			codex: CodexProvider.optional(),
		})
		.default({ enabled: false }),
	limits: Limits.default(Limits.parse({})),
});
export type ManagedConfig = z.infer<typeof ManagedConfig>;

export function parseManagedConfig(raw: unknown): ManagedConfig {
	const cfg = ManagedConfig.parse(raw);
	const ids = new Set<string>();
	for (const r of cfg.repos) {
		if (ids.has(r.id))
			throw new Error(`managed config: duplicate repo ${r.id}`);
		ids.add(r.id);
	}
	return cfg;
}

/** Read + validate the YAML/JSON config file. Throws with a field path, never the file contents. */
export function loadManagedConfig(path: string): ManagedConfig {
	const text = readFileSync(expandHome(path), "utf8");
	try {
		return parseManagedConfig(Bun.YAML.parse(text));
	} catch (err) {
		if (err instanceof z.ZodError) {
			const issues = err.issues
				.slice(0, 10)
				.map((i) => `${i.path.join(".")}: ${i.message}`)
				.join("; ");
			throw new Error(`managed config invalid — ${issues}`);
		}
		throw err;
	}
}

export const findRepo = (cfg: ManagedConfig, id: string) =>
	cfg.repos.find((r) => r.id === id) ?? null;

/** Deterministic JSON: object keys sorted at every level. */
export function canonicalJson(value: unknown): string {
	const norm = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(norm);
		if (v && typeof v === "object") {
			const out: Record<string, unknown> = {};
			for (const k of Object.keys(v as object).sort())
				out[k] = norm((v as Record<string, unknown>)[k]);
			return out;
		}
		return v;
	};
	return JSON.stringify(norm(value));
}

export const sha256Hex = (data: string | Uint8Array): string =>
	createHash("sha256").update(data).digest("hex");

/**
 * Hash of everything in the config that decides what a run of `repoId` may do or produce: the repo
 * entry (path, base ref, verification commands), every provider/capability setting, limits, git and
 * the output roots. Part of the approval binding: changing any of it after approval voids the
 * approval — for queued AND resumed stages. Other repos' entries are excluded on purpose.
 */
export function policyHash(cfg: ManagedConfig, repoId: string): string {
	return sha256Hex(
		canonicalJson({
			repo: findRepo(cfg, repoId),
			live: cfg.live,
			git: cfg.git_executable,
			limits: cfg.limits,
			workspace_root: cfg.workspace_root,
			artifacts_root: cfg.artifacts_root,
		}),
	);
}
