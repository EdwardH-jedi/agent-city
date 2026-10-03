// Run one command in a cleared, disposable environment (CI and local), with a hard time limit.
//
//   bun scripts/ci/isolated.ts --root <dir> --label <name> --timeout <seconds> \
//     [--browsers <playwright browsers dir>] -- <command> [args…]
//
// <root>/<label>/ is created fresh (an existing one is refused, so suites never share state) with
// home/, agentcity/ and tmp/; the command runs with ONLY HOME, AGENTCITY_HOME, TMPDIR, a PATH of
// bun + git + the system directories, LANG, TZ and (if given) PLAYWRIGHT_BROWSERS_PATH — no
// inherited variables, so no provider credentials, tokens or personal config can reach it.
// The command runs in its own process group: on the time limit or a SIGINT/SIGTERM (job
// cancellation) the whole group gets SIGTERM, then SIGKILL after a grace period; after a normal
// exit any process left in the group is killed and reported. Output is streamed and also written
// to <root>/<label>/suite.log; <root>/<label>/run.json records the outcome (no environment values).
// Exit code: the command's, 124 on the time limit, 128+n when stopped by a signal.
import { spawn } from "node:child_process";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const GRACE_MS = 15_000;

function usage(message: string): never {
	console.error(`isolated: ${message}`);
	console.error(
		"usage: bun scripts/ci/isolated.ts --root <dir> --label <name> --timeout <seconds> [--browsers <dir>] -- <command…>",
	);
	process.exit(2);
}

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 0 || sep === argv.length - 1) usage("missing -- <command>");
const opts = new Map<string, string>();
for (let i = 0; i < sep; i += 2) {
	const key = argv[i];
	const value = argv[i + 1];
	if (!key?.startsWith("--") || value === undefined || i + 1 >= sep)
		usage(`bad option ${key ?? ""}`);
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

const [cmd, ...args] = command as [string, ...string[]];
const log = createWriteStream(join(dir, "suite.log"));
const t0 = Date.now();
const child = spawn(cmd === "bun" ? join(bin, "bun") : cmd, args, {
	env,
	cwd: process.cwd(),
	detached: true, // own process group → the whole tree can be stopped
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

const group = (signal: NodeJS.Signals | 0): boolean => {
	try {
		if (child.pid) process.kill(-child.pid, signal);
		return true;
	} catch {
		return false; // ESRCH: nothing left in the group
	}
};
let stoppedBy = null as string | null; // set from signal / timer callbacks
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
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

const closed = new Promise<void>((r) => child.on("close", () => r()));
const [code, signal] = await new Promise<[number | null, string | null]>((r) =>
	child.on("exit", (c, s) => r([c, s])),
);
clearTimeout(limit);
if (killTimer) clearTimeout(killTimer);
// anything the command left behind (e.g. a browser) dies with the run
const leftovers = group(0);
if (leftovers) group("SIGKILL");
await Promise.race([closed, Bun.sleep(5_000)]); // remaining output, bounded
await new Promise<void>((r) => log.end(r));

const exit = stoppedBy?.startsWith("time limit")
	? 124
	: (code ?? 128 + (signal === "SIGKILL" ? 9 : 15));
writeFileSync(
	join(dir, "run.json"),
	`${JSON.stringify(
		{
			label,
			command: command.map((a) => (a.startsWith(dir) ? "<run dir>" : a)),
			exit,
			signal,
			stopped_by: stoppedBy,
			leftover_processes_killed: leftovers,
			seconds: Math.round((Date.now() - t0) / 100) / 10,
		},
		null,
		2,
	)}\n`,
);
console.error(
	`isolated[${label}]: exit ${exit} after ${Math.round((Date.now() - t0) / 1000)} s; leftover processes ${leftovers ? "killed" : "none"}`,
);
process.exit(exit);
