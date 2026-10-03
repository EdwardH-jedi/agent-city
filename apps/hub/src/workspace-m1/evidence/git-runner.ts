// A GitRunner for the evidence module with the same hardening as apps/hub/src/managed/git.ts
// (`gitRaw` is module-private there): argv only, no global/system config, no hooks, no prompts,
// bounded time and output, the hub's process boundary (runProcess). Read-only commands only are
// issued by this module (ls-tree, cat-file, rev-parse, diff, status).
//
// Patch proposal (lead): export `gitRunner(ctx, cwd)` from git.ts and pass it in instead, so there
// is one copy of these flags.
import { childEnv, runProcess } from "../../managed/proc.ts";
import type { GitRunner } from "./context-loader.ts";

const BASE_ARGS = [
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"advice.detachedHead=false",
];
const GIT_ENV = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_TERMINAL_PROMPT: "0",
};

export function hardenedGitRunner(o: {
	git: string;
	cwd: string;
	killGraceMs: number;
	timeoutMs?: number;
}): GitRunner {
	return (args, maxOutputBytes) =>
		runProcess({
			argv: [o.git, ...BASE_ARGS, ...args],
			cwd: o.cwd,
			env: childEnv(GIT_ENV),
			timeoutMs: o.timeoutMs ?? 30_000,
			maxOutputBytes,
			killGraceMs: o.killGraceMs,
		});
}
