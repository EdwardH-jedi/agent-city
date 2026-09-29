// `bun run collector:hooks [settings.json] [--out merged.json]`
// PRINT-ONLY: reads the Claude Code settings file, merges the Agent City hook into it (existing
// hooks untouched, re-runs idempotent), writes the result OUTSIDE ~/.claude and prints a diff plus
// the backup/apply commands. It never writes to ~/.claude — applying is the user's call.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CLAUDE_HOOK_EVENTS } from "./claude-map.ts";

export const HOOK_BIN = resolve(import.meta.dir, "../bin/claude-hook");
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);

interface HookCmd {
	type: string;
	command?: string;
	timeout?: number;
	async?: boolean;
}

/**
 * Observation only → async (Claude Code doesn't wait for it) and a 2s timeout as a last resort; the
 * launcher itself kills the hook at 0.6s.
 */
export const HOOK_ENTRY = { type: "command", async: true, timeout: 2 } as const;
interface HookGroup {
	matcher?: string;
	hooks?: HookCmd[];
}
type Settings = Record<string, unknown> & {
	hooks?: Record<string, HookGroup[]>;
};

/** Append one group per event unless a hook with `command` is already registered for it. */
export function mergeHooks(
	settings: Settings,
	command: string,
): { merged: Settings; added: string[]; updated: string[] } {
	const merged: Settings = structuredClone(settings);
	merged.hooks ??= {};
	const hooks = merged.hooks;
	const added: string[] = [];
	const updated: string[] = [];
	for (const event of CLAUDE_HOOK_EVENTS) {
		hooks[event] ??= [];
		const groups = hooks[event];
		const ours = groups.flatMap((g) =>
			(g.hooks ?? []).filter((h) => h.command === command),
		);
		if (ours.length > 0) {
			// Already installed: bring our own entries up to the current settings (older installs had
			// timeout 5 and no async). Other hooks are never touched.
			let changed = false;
			for (const h of ours) {
				if (h.async !== HOOK_ENTRY.async || h.timeout !== HOOK_ENTRY.timeout) {
					h.async = HOOK_ENTRY.async;
					h.timeout = HOOK_ENTRY.timeout;
					changed = true;
				}
			}
			if (changed) updated.push(event);
			continue;
		}
		groups.push({
			...(TOOL_EVENTS.has(event) ? { matcher: "*" } : {}),
			hooks: [{ ...HOOK_ENTRY, command }],
		});
		added.push(event);
	}
	return { merged, added, updated };
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const outIdx = args.indexOf("--out");
	const claudeDir = join(homedir(), ".claude");
	const positional = args.filter(
		(a, i) => !a.startsWith("--") && i !== outIdx + 1,
	);
	const settingsPath = resolve(
		positional[0] ?? join(claudeDir, "settings.json"),
	);
	const outArg = outIdx >= 0 ? args[outIdx + 1] : undefined;
	const outPath = resolve(
		outArg ?? join(homedir(), ".agentcity", "claude-settings.merged.json"),
	);
	if (outPath === claudeDir || outPath.startsWith(`${claudeDir}/`)) {
		console.error(
			"refusing to write under ~/.claude — apply the result yourself",
		);
		process.exit(1);
	}

	const current: Settings = existsSync(settingsPath)
		? JSON.parse(readFileSync(settingsPath, "utf8"))
		: {};
	const { merged, added, updated } = mergeHooks(current, HOOK_BIN);
	mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });
	writeFileSync(outPath, `${JSON.stringify(merged, null, 2)}\n`, {
		mode: 0o600,
	});

	console.log(`hook command : ${HOOK_BIN}`);
	console.log(`read         : ${settingsPath}`);
	console.log(`merged copy  : ${outPath}`);
	console.log(
		added.length
			? `adds         : ${added.join(", ")}`
			: "adds         : nothing — already installed",
	);
	if (updated.length)
		console.log(
			`updates      : ${updated.join(", ")} (async: true, timeout: 2)`,
		);
	console.log(`\nreview:  diff -u ${settingsPath} ${outPath}`);
	console.log(`backup:  cp ${settingsPath} ${settingsPath}.bak.$(date +%s)`);
	console.log(`apply :  cp ${outPath} ${settingsPath}`);
}
