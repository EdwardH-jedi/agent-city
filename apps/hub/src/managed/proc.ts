// Process-execution boundary for managed runs. Every child Agent City starts on behalf of a task
// goes through runProcess():
//   - argv array, no shell; explicit cwd; explicit env (allowlist, see childEnv)
//   - its own process group (detached), so cancel/timeout kills the whole tree
//   - bounded wall time and bounded captured output (the rest is drained and dropped)
//   - SIGTERM → grace → SIGKILL, then the group is confirmed gone (ESRCH)
// Nothing here knows about tasks or the DB.
import { spawn, spawnSync } from "node:child_process";

export interface ProcessIdentity {
	pid: number;
	/** `ps -o lstart=` — start time, so a recycled pid is not mistaken for our child. */
	started: string | null;
}

export interface RunOptions {
	argv: readonly string[];
	cwd: string;
	env: Record<string, string>;
	stdin?: string;
	timeoutMs: number;
	maxOutputBytes: number;
	killGraceMs: number;
	/** Abort = cancel: the group is terminated and the result has `aborted: true`. */
	signal?: AbortSignal;
	onSpawn?: (id: ProcessIdentity) => void;
	/** Complete stdout lines as they arrive (independent of the capture cap). */
	onStdoutLine?: (line: string) => void;
}

export interface RunResult {
	spawned: boolean;
	spawnError: string | null;
	pid: number | null;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	aborted: boolean;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	/** A stdout line longer than MAX_LINE_BYTES was dropped (protocol output is then incomplete). */
	lineOverflow: boolean;
	durationMs: number;
	/** The child's process group no longer exists. false = something may still be running. */
	terminationConfirmed: boolean;
}

export const MAX_LINE_BYTES = 1_048_576;

const ENV_ALLOW = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TMPDIR",
	"TERM",
	"SHELL",
] as const;

/**
 * Environment for a child: a small allowlist of the hub's own env plus explicit extras. Tokens and
 * API keys (GITHUB_TOKEN, INGEST_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY, …) are never inherited,
 * so a provider CLI cannot silently fall back to paid API billing and a verification command cannot
 * read the hub's secrets from its environment.
 */
export function childEnv(
	extra: Record<string, string> = {},
	source: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const k of ENV_ALLOW) {
		const v = source[k];
		if (v !== undefined) env[k] = v;
	}
	return { ...env, ...extra };
}

export function processStarted(pid: number): string | null {
	const r = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
		encoding: "utf8",
	});
	const out = r.status === 0 ? r.stdout.trim() : "";
	return out.length > 0 ? out : null;
}

/** Is the process group led by `pid` still there? */
export function groupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (err) {
		// EPERM = exists but not ours to signal; still alive.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function signalGroup(pid: number, sig: NodeJS.Signals): void {
	try {
		process.kill(-pid, sig);
	} catch {
		// already gone
	}
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitGroupGone(pid: number, withinMs: number): Promise<boolean> {
	const deadline = Date.now() + withinMs;
	while (groupAlive(pid)) {
		if (Date.now() >= deadline) return false;
		await sleep(20);
	}
	return true;
}

/**
 * Terminate a process group: SIGTERM, wait up to `graceMs`, SIGKILL, wait again.
 * Returns whether the group is confirmed gone.
 */
export async function terminateGroup(
	pid: number,
	graceMs: number,
): Promise<boolean> {
	if (!groupAlive(pid)) return true;
	signalGroup(pid, "SIGTERM");
	if (await waitGroupGone(pid, graceMs)) return true;
	signalGroup(pid, "SIGKILL");
	return waitGroupGone(pid, Math.max(graceMs, 1_000));
}

/**
 * Terminate a group recorded by an earlier hub process — only if `pid` still is that process
 * (same start time). Returns "gone" (nothing to kill), "killed", "foreign" (pid reused by something
 * else; untouched) or "unconfirmed".
 */
export async function terminateRecorded(
	id: ProcessIdentity,
	graceMs: number,
): Promise<"gone" | "killed" | "foreign" | "unconfirmed"> {
	const now = processStarted(id.pid);
	if (now === null) {
		// leader exited; members of its group may remain
		if (!groupAlive(id.pid)) return "gone";
		return (await terminateGroup(id.pid, graceMs)) ? "killed" : "unconfirmed";
	}
	if (id.started === null || now !== id.started) return "foreign";
	return (await terminateGroup(id.pid, graceMs)) ? "killed" : "unconfirmed";
}

class Capture {
	private chunks: Buffer[] = [];
	private size = 0;
	truncated = false;
	constructor(private readonly max: number) {}
	push(chunk: Buffer): void {
		const room = this.max - this.size;
		if (room <= 0) {
			this.truncated = true;
			return;
		}
		if (chunk.length > room) {
			this.chunks.push(chunk.subarray(0, room));
			this.size += room;
			this.truncated = true;
		} else {
			this.chunks.push(chunk);
			this.size += chunk.length;
		}
	}
	text(): string {
		return Buffer.concat(this.chunks).toString("utf8");
	}
}

export function runProcess(opts: RunOptions): Promise<RunResult> {
	const started = Date.now();
	const out = new Capture(opts.maxOutputBytes);
	const err = new Capture(opts.maxOutputBytes);
	const result: RunResult = {
		spawned: false,
		spawnError: null,
		pid: null,
		exitCode: null,
		signal: null,
		timedOut: false,
		aborted: false,
		stdout: "",
		stderr: "",
		stdoutTruncated: false,
		stderrTruncated: false,
		lineOverflow: false,
		durationMs: 0,
		terminationConfirmed: true,
	};
	const [file, ...args] = opts.argv;

	return new Promise<RunResult>((resolvePromise) => {
		if (!file) {
			result.spawnError = "empty argv";
			resolvePromise(result);
			return;
		}
		if (opts.signal?.aborted) {
			result.aborted = true;
			resolvePromise(result);
			return;
		}

		const child = spawn(file, args, {
			cwd: opts.cwd,
			env: opts.env,
			detached: true, // own process group
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let settled = false;
		// stdout line splitting state (lines survive chunk boundaries)
		let partial: Buffer = Buffer.alloc(0);
		let dropping = false;
		let killing: Promise<boolean> | null = null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const pid = child.pid;

		const kill = () => {
			if (pid !== undefined && !killing)
				killing = terminateGroup(pid, opts.killGraceMs);
		};
		const onAbort = () => {
			result.aborted = true;
			kill();
		};

		const finish = async () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			if (pid !== undefined) {
				// The leader is gone; nothing of its group may outlive the run.
				const confirmed = killing
					? await killing
					: await terminateGroup(pid, opts.killGraceMs);
				result.terminationConfirmed =
					confirmed || (await terminateGroup(pid, opts.killGraceMs));
			}
			if (partial.length > 0 && !result.lineOverflow)
				opts.onStdoutLine?.(partial.toString("utf8"));
			result.stdout = out.text();
			result.stderr = err.text();
			result.stdoutTruncated = out.truncated;
			result.stderrTruncated = err.truncated;
			result.durationMs = Date.now() - started;
			resolvePromise(result);
		};

		child.on("error", (e) => {
			// ENOENT / EACCES: never started
			if (!result.spawned) result.spawnError = (e as Error).message;
			void finish();
		});

		if (pid === undefined) return; // the 'error' event follows

		result.spawned = true;
		result.pid = pid;
		try {
			opts.onSpawn?.({ pid, started: processStarted(pid) });
		} catch {
			// a bookkeeping failure must not leak the child: stop it
			result.aborted = true;
			kill();
		}

		child.stdout.on("data", (chunk: Buffer) => {
			out.push(chunk);
			if (!opts.onStdoutLine) return;
			let rest = chunk;
			for (;;) {
				const nl = rest.indexOf(0x0a);
				if (nl === -1) break;
				const head = rest.subarray(0, nl);
				if (dropping) dropping = false;
				else opts.onStdoutLine(Buffer.concat([partial, head]).toString("utf8"));
				partial = Buffer.alloc(0);
				rest = rest.subarray(nl + 1);
			}
			if (dropping) return;
			if (partial.length + rest.length > MAX_LINE_BYTES) {
				result.lineOverflow = true;
				dropping = true;
				partial = Buffer.alloc(0);
			} else if (rest.length > 0) {
				partial = Buffer.concat([partial, rest]);
			}
		});
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		child.stdin.on("error", () => {
			// child closed stdin early (EPIPE) — not an error for us
		});
		child.stdin.end(opts.stdin ?? "");

		child.on("exit", (code, sig) => {
			result.exitCode = code;
			result.signal = sig;
			// Leftover group members can hold the pipes open and delay 'close'; reap them now.
			kill();
		});
		child.on("close", () => void finish());

		timer = setTimeout(() => {
			result.timedOut = true;
			kill();
		}, opts.timeoutMs);
		opts.signal?.addEventListener("abort", onAbort, { once: true });
	});
}
