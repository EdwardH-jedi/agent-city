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
	/** Longest stdout line handed to onStdoutLine; longer lines are dropped. Default 1 MiB. */
	maxLineBytes?: number;
	/** Process inspection/termination (injectable for fault tests). Default: the host. */
	processOps?: ProcessOps;
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
	/**
	 * Set when the run had to be settled without proof that everything it started is gone: the kill
	 * could not be confirmed, or the output pipes stayed open after the leader exited (a descendant
	 * outside the group still holds them). Callers must quarantine `pid`.
	 */
	unresolved: string | null;
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

/** What a pid currently is. `error` = the inspection itself failed — never evidence of absence. */
export type Inspection =
	| { state: "absent" }
	| { state: "present"; started: string }
	| { state: "error"; error: string };

export function inspectProcess(pid: number): Inspection {
	const r = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
		encoding: "utf8",
		timeout: 5_000,
	});
	if (r.error) return { state: "error", error: r.error.message };
	const out = (r.stdout ?? "").trim();
	// ps exits 1 with no output when the pid does not exist
	if (r.status === 1 && out.length === 0) return { state: "absent" };
	if (r.status === 0 && out.length > 0)
		return { state: "present", started: out };
	return { state: "error", error: `ps exited ${r.status}` };
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

/** The host operations the orchestrator needs; tests inject failing variants. */
export interface ProcessOps {
	inspect(pid: number): Inspection;
	/** "error" = could not tell. */
	groupAlive(pid: number): boolean | "error";
	terminateGroup(pid: number, graceMs: number): Promise<boolean>;
}

export const hostProcessOps: ProcessOps = {
	inspect: inspectProcess,
	groupAlive,
	terminateGroup,
};

export type Resolution =
	| { resolved: true; evidence: string }
	| { resolved: false; reason: string };

/**
 * Decide, on objective evidence only, whether a recorded child (`pid` + its start time) and its
 * process group are gone — terminating them if they still are ours. Never signals a pid that now
 * belongs to another process. POSIX does not reuse a pid while a process group with that id still
 * exists, so a recycled leader pid proves the original group is gone.
 */
export async function resolveRecorded(
	id: ProcessIdentity,
	graceMs: number,
	ops: ProcessOps = hostProcessOps,
): Promise<Resolution> {
	const leader = ops.inspect(id.pid);
	if (leader.state === "error")
		return { resolved: false, reason: `inspection failed: ${leader.error}` };
	if (leader.state === "present") {
		if (id.started === null)
			return {
				resolved: false,
				reason:
					"process start time was never recorded; identity cannot be verified",
			};
		if (leader.started !== id.started)
			return {
				resolved: true,
				evidence:
					"pid was recycled by an unrelated process (start time differs); the original process group no longer exists — nothing was signalled",
			};
		return (await ops.terminateGroup(id.pid, graceMs))
			? {
					resolved: true,
					evidence: "process group terminated and confirmed gone",
				}
			: { resolved: false, reason: "termination could not be confirmed" };
	}
	// leader absent: remaining members of its group (if any) are still ours
	const group = ops.groupAlive(id.pid);
	if (group === "error")
		return {
			resolved: false,
			reason: "inspection failed: process group state unknown",
		};
	if (!group)
		return {
			resolved: true,
			evidence: "process and its process group are gone",
		};
	return (await ops.terminateGroup(id.pid, graceMs))
		? {
				resolved: true,
				evidence: "remaining group members terminated and confirmed gone",
			}
		: {
				resolved: false,
				reason: "remaining group members could not be terminated",
			};
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

/** After the leader exits, how long the pipes may stay open before the run is settled anyway. */
export const PIPE_CLOSE_GRACE_MS = 1_000;

export function runProcess(opts: RunOptions): Promise<RunResult> {
	const started = Date.now();
	const ops = opts.processOps ?? hostProcessOps;
	const maxLine = opts.maxLineBytes ?? MAX_LINE_BYTES;
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
		unresolved: null,
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
		// independent bounds: the promise settles even if 'close' never comes
		let settleTimer: ReturnType<typeof setTimeout> | undefined;
		let pipeTimer: ReturnType<typeof setTimeout> | undefined;
		const pid = child.pid;

		const kill = () => {
			if (pid !== undefined && !killing) {
				killing = ops.terminateGroup(pid, opts.killGraceMs);
				// SIGTERM grace + SIGKILL wait + slack; after that we stop waiting for 'close'.
				settleTimer ??= setTimeout(
					() =>
						void finish("the process did not finish after it was terminated"),
					opts.killGraceMs +
						Math.max(opts.killGraceMs, 1_000) +
						PIPE_CLOSE_GRACE_MS,
				);
			}
		};
		const onAbort = () => {
			result.aborted = true;
			kill();
		};

		const emitLine = (line: Buffer) => {
			if (line.length > maxLine) {
				result.lineOverflow = true;
				return;
			}
			opts.onStdoutLine?.(line.toString("utf8"));
		};

		const finish = async (unresolved: string | null = null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(settleTimer);
			clearTimeout(pipeTimer);
			opts.signal?.removeEventListener("abort", onAbort);
			if (unresolved) {
				// stop reading; whatever still holds the pipes is outside our control
				child.stdout?.destroy();
				child.stderr?.destroy();
				child.stdin?.destroy();
			}
			if (pid !== undefined) {
				// The leader is gone (or abandoned); nothing of its group may outlive the run.
				const confirmed = killing
					? await Promise.race([
							killing,
							sleep(opts.killGraceMs * 3 + 1_000).then(() => false),
						])
					: await ops.terminateGroup(pid, opts.killGraceMs);
				result.terminationConfirmed =
					confirmed || (await ops.terminateGroup(pid, opts.killGraceMs));
				if (!result.terminationConfirmed)
					unresolved ??= "the process group could not be confirmed terminated";
			}
			result.unresolved = unresolved;
			if (unresolved) result.terminationConfirmed = false;
			if (partial.length > 0 && !dropping) emitLine(partial);
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
			const id = ops.inspect(pid);
			opts.onSpawn?.({
				pid,
				started: id.state === "present" ? id.started : null,
			});
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
				else if (partial.length + head.length > maxLine)
					result.lineOverflow = true;
				else emitLine(Buffer.concat([partial, head]));
				partial = Buffer.alloc(0);
				rest = rest.subarray(nl + 1);
			}
			if (dropping) return;
			if (partial.length + rest.length > maxLine) {
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
			// A descendant that left the group can hold the pipes forever: bound the wait.
			pipeTimer = setTimeout(
				() =>
					void finish(
						"the output pipes stayed open after the process exited (a descendant outside its process group may still be running)",
					),
				opts.killGraceMs + PIPE_CLOSE_GRACE_MS,
			);
		});
		child.on("close", () => void finish());

		timer = setTimeout(() => {
			result.timedOut = true;
			kill();
		}, opts.timeoutMs);
		opts.signal?.addEventListener("abort", onAbort, { once: true });
	});
}
