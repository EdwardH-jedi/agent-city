// Claude Code hook entrypoint. HARD RULE: never block the agent.
// - always exit 0, whatever happens (bad JSON, hub down, disk full, stdin never closed…)
// - never print to stdout (Claude Code may interpret it); never log payload contents
//
// TODO(phase-0, Step 4): parse JSON → map to schema.IngestEvent → redact → spool → best-effort POST.

// Hard deadline, armed before anything else: even if an await below hangs, we are gone by then.
// unref() so the timer itself never keeps an otherwise-finished process alive.
const HARD_DEADLINE_MS = 500;
setTimeout(() => process.exit(0), HARD_DEADLINE_MS).unref();

const STDIN_TIMEOUT_MS = 200;
const STDIN_MAX_BYTES = 1024 * 1024;

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

async function main(): Promise<void> {
	const _raw = await readStdin(STDIN_TIMEOUT_MS, STDIN_MAX_BYTES);
}

export {};

try {
	await main();
} catch {
	// swallow — a broken collector must not break the session
}
process.exit(0);
