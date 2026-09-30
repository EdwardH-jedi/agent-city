// `bun run managed:preflight` — check the configured live providers WITHOUT calling a model:
// executable present, `--version` answers, login status. Prints one line per provider. This is the
// same preflight the worker runs before a live task; it never sends a prompt.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIVE_INTEGRATION_VERIFIED, redact } from "@agent-city/schema";
import { createClaudeImplementer } from "./adapters/claude.ts";
import { createCodexReviewer } from "./adapters/codex.ts";
import type { AdapterContext } from "./adapters/types.ts";
import { loadManagedConfig } from "./config.ts";
import { runProcess } from "./proc.ts";

if (import.meta.main) {
	const path = process.env.MANAGED_CONFIG;
	if (!path) {
		console.error("MANAGED_CONFIG is not set");
		process.exit(2);
	}
	let config: ReturnType<typeof loadManagedConfig>;
	try {
		config = loadManagedConfig(path);
	} catch (err) {
		console.error(redact((err as Error).message));
		process.exit(2);
	}
	const scratchDir = mkdtempSync(join(tmpdir(), "agentcity-preflight-"));
	const ctx: AdapterContext = {
		signal: new AbortController().signal,
		scratchDir,
		maxLogBytes: config.limits.max_log_bytes,
		run: (o) =>
			runProcess({
				...o,
				maxOutputBytes: o.maxOutputBytes ?? config.limits.max_log_bytes,
				killGraceMs: config.limits.kill_grace_ms,
			}),
	};
	let ok = true;
	try {
		console.log(
			`live.enabled: ${config.live.enabled}${config.live.enabled ? "" : "  (live tasks are refused until this is true)"}`,
		);
		const checks = [
			[
				"implementer claude",
				config.live.claude && createClaudeImplementer(config.live.claude),
			],
			[
				"reviewer    codex ",
				config.live.codex && createCodexReviewer(config.live.codex),
			],
		] as const;
		for (const [name, adapter] of checks) {
			if (!adapter) {
				console.log(`${name}: not configured`);
				ok = false;
				continue;
			}
			const p = await adapter.preflight(ctx);
			if (!p.ok) ok = false;
			console.log(
				`${name}: ${p.ok ? "ok" : `BLOCKED (${p.kind})`} — ${p.detail} — requested model ${adapter.model_requested}`,
			);
		}
		console.log(
			`live integration verified end to end: ${LIVE_INTEGRATION_VERIFIED ? "yes" : "NO (stub-tested only)"}`,
		);
		console.log("No model was called by this check.");
	} finally {
		rmSync(scratchDir, { recursive: true, force: true });
	}
	process.exit(ok ? 0 : 1);
}
