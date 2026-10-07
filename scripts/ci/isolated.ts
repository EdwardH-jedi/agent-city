// Run one command in a cleared, disposable environment (CI and local), with a hard time limit.
//
//   bun scripts/ci/isolated.ts --root <dir> --label <name> --timeout <seconds> \
//     [--browsers <playwright browsers dir>] [--set NAME=VALUE …] -- <command> [args…]
//
// <root>/<label>/ is created fresh (an existing one is refused, so suites never share state) with
// home/, agentcity/ and tmp/; the command runs with ONLY HOME, AGENTCITY_HOME, TMPDIR, a PATH of
// bun + git + the system directories, LANG, TZ and (if given) PLAYWRIGHT_BROWSERS_PATH — no
// inherited variables, so no provider credentials, tokens or personal config can reach it. `--set`
// (repeatable) adds an explicit test selector given on the command line — only names matching
// ^[A-Z][A-Z0-9_]*_ONLY$ (e.g. M1_ONLY, CAMPUS_ONLY), never a value inherited from the environment.
// The command runs in its own process group: on the time limit or a SIGINT/SIGTERM (job
// cancellation) the whole group gets SIGTERM, then SIGKILL after a grace period; after a normal
// exit any process left in the group is killed and reported. Output is streamed and also written
// to <root>/<label>/suite.log; <root>/<label>/run.json records the outcome (no environment values).
// Exit code: the command's own; 124 on the time limit; 130 / 143 when the wrapper itself received SIGINT /
// SIGTERM (an interrupted suite never reports success, even if the command then exits 0); 128+n when the
// command died of signal n that the wrapper did not send; 127 / 126 / 1 when the command could not be
// launched at all (ENOENT / EACCES / other launch error, settled at once — no exit event is awaited,
// no process group is signalled, run.json says "no_process_launched"). run.json records the command's own exit code and
// signal separately. This exit code describes the wrapper's run only — it does not say how a CI service
// reports a cancelled job.
import { spawn } from "node:child_process";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const GRACE_MS = 15_000;

function usage(message: string): never {
	console.error(`isolated: ${message}`);
	console.error(
		"usage: bun scripts/ci/isolated.ts --root <dir> --label <name> --timeout <seconds> [--browsers <dir>] [--set NAME=VALUE …] -- <command…>",
	);
	process.exit(2);
}

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 0 || sep === argv.length - 1) usage("missing -- <command>");
const opts = new Map<string, string>();
const sets: [string, string][] = [];
const SET_NAME = /^[A-Z][A-Z0-9_]*_ONLY$/;
for (let i = 0; i < sep; i += 2) {
	const key = argv[i];
	const value = argv[i + 1];
	if (!key?.startsWith("--") || value === undefined || i + 1 >= sep)
		usage(`bad option ${key ?? ""}`);
	if (key === "--set") {
		const eq = value.indexOf("=");
		const name = eq > 0 ? value.slice(0, eq) : "";
		const v = eq > 0 ? value.slice(eq + 1) : "";
		if (!SET_NAME.test(name))
			usage("--set only passes test selectors named *_ONLY (NAME=VALUE)");
		if (v.length > 200 || /[\0\r\n]/.test(v))
			usage(`--set ${name}: value must be one line of at most 200 characters`);
		sets.push([name, v]);
		continue;
	}
	if (!["--root", "--label", "--timeout", "--browsers"].includes(key))
		usage(`unknown option ${key}`);
	opts.set(key.slice(2), value);
}
const command = argv.slice(sep + 1);
const root = opts.get("root");
const label = opts.get("label");
const timeoutS = Number(opts.get("timeout"));
const browsers = opts.get("browsers");
if (!root) usage("--root is required");
if (!label || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(label))
	usage("--label must be lower-case letters, digits and dashes");
if (!Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > 6 * 3600)
	usage("--timeout must be whole seconds (1…21600)");
if (browsers !== undefined && !isAbsolute(browsers))
	usage("--browsers must be an absolute path");

const dir = join(resolve(root), label);
if (existsSync(dir))
	usage(`${dir} already exists (one fresh directory per run)`);
const home = join(dir, "home");
const agentcity = join(dir, "agentcity");
const tmp = join(dir, "tmp");
const bin = join(dir, "bin");
for (const d of [home, agentcity, tmp, bin]) mkdirSync(d, { recursive: true });
const git = Bun.which("git");
if (!git) usage("git is not on PATH");
symlinkSync(process.execPath, join(bin, "bun"));
symlinkSync(git, join(bin, "git"));

const env: Record<string, string> = {
	HOME: home,
	AGENTCITY_HOME: agentcity,
	TMPDIR: `${tmp}/`,
	PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
	LANG: "C.UTF-8",
	TZ: "UTC",
};
if (browsers) env.PLAYWRIGHT_BROWSERS_PATH = browsers;
for (const [name, value] of sets) env[name] = value;

const [cmd, ...args] = command as [string, ...string[]];
const log = createWriteStream(join(dir, "suite.log"));
const t0 = Date.now();
type Terminal = {
	code: number | null;
	signal: string | null;
	error: string | null;
};
let launchError: string | null = null;
const child = spawn(cmd === "bun" ? join(bin, "bun") : cmd, args, {
	env,
	cwd: process.cwd(),
	detached: true,
	stdio: ["ignore", "pipe", "pipe"],
});
child.stdout?.on("data", (b: Buffer) => {
	process.stdout.write(b);
	log.write(b);
});
child.stderr?.on("data", (b: Buffer) => {
	process.stderr.write(b);
	log.write(b);
});

// A missing pid means the launch failed and no process group exists ("none"): there is nothing to
// signal and nothing to report as cleaned up. EPERM and other failures are unknown, never proof
// that cleanup succeeded. Launch failure is settled without waiting for an exit that never comes.
const group = (
	signal: NodeJS.Signals | 0,
): "present" | "absent" | "unknown" | "none" => {
	if (!child.pid) return "none";
	try {
		process.kill(-child.pid, signal);
		return "present";
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "unknown";
	}
};
let stoppedBy: string | null = null;
let killTimer: ReturnType<typeof setTimeout> | null = null;
function stop(reason: string) {
	if (stoppedBy) return;
	stoppedBy = reason;
	console.error(`isolated[${label}]: ${reason} — stopping the process group`);
	group("SIGTERM");
	killTimer = setTimeout(() => group("SIGKILL"), GRACE_MS);
}
const limit = setTimeout(
	() => stop(`time limit ${timeoutS} s`),
	timeoutS * 1000,
);
const interrupt = () => stop("SIGINT");
const terminate = () => stop("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
let closeResolve: () => void;
const closed = new Promise<void>((r) => {
	closeResolve = r;
});
const terminal = new Promise<Terminal>((resolve) => {
	let settled = false;
	const finish = (value: Terminal) => {
		if (!settled) {
			settled = true;
			resolve(value);
		}
	};
	child.on("error", (e: NodeJS.ErrnoException) => {
		launchError = e.code ?? "SPAWN_ERROR";
		// Only the error category is recorded; error messages may include sensitive argv/paths.
		console.error(`isolated[${label}]: launch error ${launchError}`);
		finish({ code: null, signal: null, error: launchError });
	});
	child.on("exit", (code, signal) => finish({ code, signal, error: null }));
	child.on("close", (code, signal) => {
		closeResolve();
		finish({ code, signal, error: launchError });
	});
});
const { code, signal, error } = await terminal;
clearTimeout(limit);
if (killTimer) clearTimeout(killTimer);
process.off("SIGINT", interrupt);
process.off("SIGTERM", terminate);
const leftovers = group(0);
const killAttempted = leftovers === "present" || leftovers === "unknown";
if (killAttempted) group("SIGKILL");
// remaining output, bounded; a launch that never produced a process has no streams to drain
await Promise.race([closed, Bun.sleep(child.pid ? 5_000 : 250)]);
// Give reaping a bounded opportunity, then report proof honestly.
for (let i = 0; i < 10 && group(0) === "present"; i++) await Bun.sleep(50);
const cleanup = group(0);
await new Promise<void>((r) => log.end(r));

const signalNumber = (s: string | null): number =>
	s ? (osConstants.signals[s as keyof typeof osConstants.signals] ?? 0) : 0;
const interrupted = stoppedBy === "SIGINT" || stoppedBy === "SIGTERM";
const exit = stoppedBy?.startsWith("time limit")
	? 124
	: interrupted
		? 128 + signalNumber(stoppedBy) // 130 / 143, whatever the command itself exited with
		: error
			? error === "ENOENT"
				? 127
				: error === "EACCES"
					? 126
					: 1
			: code !== null
				? code
				: signalNumber(signal) > 0
					? 128 + signalNumber(signal)
					: 1;
writeFileSync(
	join(dir, "run.json"),
	`${JSON.stringify(
		{
			label,
			command: command.map((a) => (a.startsWith(dir) ? "<run dir>" : a)),
			exit,
			child_exit: code,
			child_signal: signal,
			interrupted,
			stopped_by: stoppedBy,
			launch_error: error,
			process_group_created: child.pid !== undefined,
			cleanup_status:
				cleanup === "none"
					? "no_process_launched"
					: cleanup === "absent"
						? "confirmed_absent"
						: cleanup === "present"
							? "remaining"
							: "unknown",
			cleanup_kill_attempted: killAttempted,
			leftover_processes_killed: killAttempted && cleanup === "absent",
			seconds: Math.round((Date.now() - t0) / 100) / 10,
		},
		null,
		2,
	)}\n`,
);
console.error(
	`isolated[${label}]: exit ${exit} after ${Math.round((Date.now() - t0) / 1000)} s; leftover processes ${cleanup === "absent" ? "confirmed absent" : cleanup === "none" ? "none (no process was launched)" : cleanup}`,
);
process.exit(exit);
