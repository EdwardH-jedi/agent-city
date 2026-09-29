// Claude Code hook entrypoint (run via bin/claude-hook → `bun --no-env-file`). HARD RULE: never
// block the agent.
// - always exit 0, whatever happens (bad JSON, hub down, disk full, stdin never closed…)
// - never print to stdout (Claude Code may interpret it); never log payload contents
// - bounded: 500ms hard deadline, 200ms stdin, 300ms POST; on failure → spool
// Imports stay zod-free (@agent-city/schema/core) to keep startup small.

// Hard deadline: armed as the first statement of this module (the static imports below are hoisted
// and evaluate first — they're synchronous and fast). Even if an await hangs, we exit by then.
// unref() so the timer itself never keeps an otherwise-finished process alive.
const HARD_DEADLINE_MS = 500;
setTimeout(() => process.exit(0), HARD_DEADLINE_MS).unref();

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { mapClaudeHook } from "./claude-map.ts";
import { loadConfig } from "./config.ts";
import { gitInfo } from "./git-info.ts";
import { createTransport, deliver, Spool } from "./spool.ts";

const STARTED = Date.now();
const STDIN_TIMEOUT_MS = 200;
const STDIN_MAX_BYTES = 1024 * 1024;
const POST_TIMEOUT_MS = 300;
/** Stop starting new work (spool flush chunks) after this; the watchdog is the backstop. */
const WORK_DEADLINE_MS = 400;

/**
 * Read stdin until EOF, `timeoutMs`, or `maxBytes` — whichever comes first. Bytes past the cap are
 * dropped (the JSON then fails to parse and the event is skipped, which is the safe outcome).
 */
async function readStdin(timeoutMs: number, maxBytes: number): Promise<string> {
	const reader = Bun.stdin.stream().getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;

	const read = (async () => {
		while (size < maxBytes) {
			const { done, value } = await reader.read();
			if (done) break;
			const take = value.subarray(0, maxBytes - size);
			chunks.push(take);
			size += take.byteLength;
		}
	})().catch(() => {}); // a read aborted by cancel() below must not surface as an unhandled rejection
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, timeoutMs);
	});

	await Promise.race([read, timeout]);
	clearTimeout(timer);
	reader.cancel().catch(() => {});
	return Buffer.concat(chunks).toString("utf8");
}

const cfg = loadConfig();

/** Opt-in (AGENTCITY_DEBUG=1): error messages + timings only, never payloads. */
function debug(msg: string): void {
	if (!cfg.debug) return;
	try {
		mkdirSync(cfg.home, { recursive: true, mode: 0o700 });
		appendFileSync(
			join(cfg.home, "hook.log"),
			`${new Date().toISOString()} ${msg}\n`,
			{ mode: 0o600 },
		);
	} catch {
		// ignore
	}
}

async function main(): Promise<void> {
	const raw = await readStdin(STDIN_TIMEOUT_MS, STDIN_MAX_BYTES);
	const event = mapClaudeHook(JSON.parse(raw), {
		machine: cfg.machine,
		hostname: cfg.hostname,
		now: () => new Date(),
		newId: () => Bun.randomUUIDv7(),
		git: gitInfo,
	});
	if (!event) return;
	const outcome = await deliver(
		[event],
		new Spool(cfg.home),
		createTransport(cfg, POST_TIMEOUT_MS),
		STARTED + WORK_DEADLINE_MS,
	);
	debug(`${event.type} ${outcome} in ${Date.now() - STARTED}ms`);
}

try {
	await main();
} catch (err) {
	// swallow — a broken collector must not break the session
	debug(`error: ${(err as Error).message}`);
}
process.exit(0);
