// Disposable fixtures for managed-run tests and the deterministic demo: a throwaway git repository,
// a config pointing at it, and generated stub executables. Nothing here touches a real project, a
// real provider CLI or a model. Everything lives under one mkdtemp directory.
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.ts";
import { type ManagedConfig, parseManagedConfig } from "./config.ts";

export const GIT = Bun.which("git") ?? "/usr/bin/git";

const GIT_ENV = {
	PATH: "/usr/bin:/bin",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_TERMINAL_PROMPT: "0",
};

/** Run git in a fixture repo (fixed identity, no user config, no hooks). Throws on failure. */
export function fixtureGit(cwd: string, ...args: string[]): string {
	const r = spawnSync(
		GIT,
		[
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@localhost",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"commit.gpgsign=false",
			...args,
		],
		{ cwd, env: GIT_ENV, encoding: "utf8" },
	);
	if (r.status !== 0)
		throw new Error(`fixture git ${args[0]} failed: ${r.stderr}`);
	return r.stdout.trim();
}

/** Passes only when the simulated implementer wrote `pass` (root scope or `src` scope). */
const VERIFY_SH = `#!/bin/sh
grep -qs '^pass$' agentcity-sim/verify.status src/agentcity-sim/verify.status || exit 1
`;

export interface FixtureOptions {
	/** `status` (default): /bin/sh verify.sh. `none`: no verification configured. Or explicit argv lists. */
	verification?:
		| "status"
		| "none"
		| { name: string; argv: string[]; timeout_s?: number }[];
	live?: Record<string, unknown>;
	limits?: Record<string, unknown>;
	/** File-backed DB (restart tests). Default: in-memory. */
	dbFile?: boolean;
}

export interface Fixture {
	dir: string;
	repoPath: string;
	repoId: string;
	baseSha: string;
	config: ManagedConfig;
	db: Database;
	dbPath: string;
	cleanup(): void;
}

export function makeFixture(opts: FixtureOptions = {}): Fixture {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentcity-managed-")));
	const repoPath = join(dir, "repo");
	mkdirSync(join(repoPath, "src"), { recursive: true });
	writeFileSync(join(repoPath, "README.md"), "# fixture\n");
	writeFileSync(join(repoPath, "src", "app.txt"), "v1\n");
	writeFileSync(join(repoPath, "verify.sh"), VERIFY_SH);
	fixtureGit(repoPath, "init", "--quiet", "-b", "main");
	fixtureGit(repoPath, "add", "-A");
	fixtureGit(repoPath, "commit", "--quiet", "-m", "fixture base");
	const baseSha = fixtureGit(repoPath, "rev-parse", "HEAD");

	const verification =
		opts.verification === "none"
			? []
			: Array.isArray(opts.verification)
				? opts.verification
				: [
						{
							name: "fixture-check",
							argv: ["/bin/sh", "verify.sh"],
							timeout_s: 30,
						},
					];
	const repoId = "local/fixture";
	const config = parseManagedConfig({
		workspace_root: join(dir, "workspaces"),
		artifacts_root: join(dir, "artifacts"),
		git_executable: GIT,
		repos: [{ id: repoId, path: repoPath, base_ref: "main", verification }],
		live: opts.live ?? { enabled: false },
		limits: { kill_grace_ms: 300, lease_ttl_ms: 3_000, ...opts.limits },
	});
	const dbPath = opts.dbFile ? join(dir, "hub.db") : ":memory:";
	const db = openDb(dbPath);
	return {
		dir,
		repoPath,
		repoId,
		baseSha,
		config,
		db,
		dbPath,
		cleanup() {
			try {
				db.close();
			} catch {
				// already closed
			}
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/**
 * Write an executable stub: `<dir>/<name>` runs `<dir>/<name>.ts` with this Bun. The script gets
 * the real argv; use it to stand in for a provider CLI (protocol fixtures, hangs, failures).
 */
export function writeStub(dir: string, name: string, script: string): string {
	mkdirSync(dir, { recursive: true });
	const scriptPath = join(dir, `${name}.ts`);
	const exe = join(dir, name);
	writeFileSync(scriptPath, script);
	writeFileSync(
		exe,
		`#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
	);
	chmodSync(exe, 0o755);
	return exe;
}
