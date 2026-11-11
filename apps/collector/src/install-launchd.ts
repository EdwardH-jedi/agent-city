// `bun run collector:launchd -- [--tunnel-target user@host] [--office-dir DIR] [options]`
// PRINT-ONLY (decision D7), like `collector:hooks`: writes launchd job files under ~/.agentcity/launchd/
// and prints the commands that load them. It never touches ~/Library/LaunchAgents or ~/.claude, and
// never loads or starts anything — copying the files and `launchctl bootstrap` are the owner's call.
//
// Jobs (each one only when its inputs are given): tunnel (ssh -L to the hub host), heartbeat, codex
// log tailer, Agent Office run exporter.
//
// No secret is ever written: the heartbeat and the tailer read this checkout's own .env at run time
// (collector/config.ts), and the exporter job sources the owner's projection env file in a shell at
// run time. This generator never opens that file.
//
// The checkout path is baked into the files, so generate them from the `main` checkout.
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

export const LABEL_PREFIX = "local.agentcity";

export interface LaunchdJob {
	/** short name: tunnel | heartbeat | codex | exporter */
	name: string;
	label: string;
	args: string[];
	workingDirectory: string;
	logPath: string;
	/** What the owner must stop before loading this job (a terminal copy of the same thing). */
	stopFirst: string;
	/** An extra fact the owner needs, printed with the apply steps. */
	note?: string;
}

export interface PlanOptions {
	/** The checkout the collector scripts run from. */
	repoRoot: string;
	/** ~/.agentcity — logs live in <agentcityHome>/logs. */
	agentcityHome: string;
	/** Absolute paths: launchd has a bare PATH. */
	bin: { bun: string; node: string | null; ssh: string };
	hubUrl: string;
	tunnel: { target: string; ports: number[] } | null;
	office: { dir: string; envFile: string } | null;
}

export interface Plan {
	jobs: LaunchdJob[];
	skipped: string[];
}

const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

/** `user@host` or an ssh alias. Never starts with `-` (it would be read as an ssh option). */
export function validTunnelTarget(target: string): boolean {
	return TARGET_RE.test(target);
}

export function parsePorts(text: string): number[] | null {
	const out: number[] = [];
	for (const raw of text.split(",")) {
		const p = raw.trim();
		if (!/^\d{1,5}$/.test(p)) return null;
		const n = Number(p);
		if (n < 1 || n > 65535) return null;
		if (!out.includes(n)) out.push(n);
	}
	return out.length > 0 ? out : null;
}

export function buildPlan(o: PlanOptions): Plan {
	const jobs: LaunchdJob[] = [];
	const skipped: string[] = [];
	const log = (name: string) => join(o.agentcityHome, "logs", `${name}.log`);
	const collector = (file: string) =>
		join(o.repoRoot, "apps", "collector", "src", file);

	if (o.tunnel) {
		jobs.push({
			name: "tunnel",
			label: `${LABEL_PREFIX}.tunnel`,
			args: [
				o.bin.ssh,
				"-N",
				"-o",
				"BatchMode=yes",
				"-o",
				"ServerAliveInterval=30",
				// Without this a failed forward leaves ssh alive and KeepAlive never restarts it.
				"-o",
				"ExitOnForwardFailure=yes",
				...o.tunnel.ports.flatMap((p) => ["-L", `${p}:127.0.0.1:${p}`]),
				o.tunnel.target,
			],
			workingDirectory: o.agentcityHome,
			logPath: log("tunnel"),
			stopFirst: "the terminal `ssh -N … -L 4317:…` (Ctrl-C it)",
			note: "BatchMode: the key must work without a prompt. Check first: ssh -o BatchMode=yes <target> true",
		});
	} else {
		skipped.push("tunnel: no --tunnel-target given");
	}

	jobs.push({
		name: "heartbeat",
		label: `${LABEL_PREFIX}.heartbeat`,
		args: [o.bin.bun, "--no-env-file", collector("heartbeat.ts")],
		workingDirectory: o.repoRoot,
		logPath: log("heartbeat"),
		stopFirst: "the terminal `bun run collector:heartbeat`",
	});
	jobs.push({
		name: "codex",
		label: `${LABEL_PREFIX}.codex`,
		args: [o.bin.bun, "--no-env-file", collector("codex-tail.ts")],
		workingDirectory: o.repoRoot,
		logPath: log("codex"),
		stopFirst:
			"the running `bun run collector:codex` (two tailers would share one offsets file)",
	});

	if (!o.office) {
		skipped.push("exporter: no --office-dir given");
	} else if (!o.bin.node) {
		skipped.push("exporter: `node` not found on PATH");
	} else {
		jobs.push({
			name: "exporter",
			label: `${LABEL_PREFIX}.exporter`,
			// The token stays in the owner's env file; the shell sources it when the job starts.
			args: [
				"/bin/sh",
				"-c",
				'set -a; . "$1"; set +a; exec "$2" scripts/city-export.mjs --hub "$3"',
				"agentcity-exporter",
				o.office.envFile,
				o.bin.node,
				o.hubUrl,
			],
			workingDirectory: o.office.dir,
			logPath: log("exporter"),
			stopFirst: "the terminal `npm run city:export`",
			note: "Runs scripts/city-export.mjs of the checkout given as --office-dir; if that file is not there, the job exits and is retried every 10 s.",
		});
	}
	return { jobs, skipped };
}

export function xmlEscape(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function plistXml(job: LaunchdJob, pathDirs: string[]): string {
	const strings = job.args
		.map((x) => `\t\t<string>${xmlEscape(x)}</string>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xmlEscape(job.label)}</string>
\t<key>ProgramArguments</key>
\t<array>
${strings}
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${xmlEscape(job.workingDirectory)}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>${xmlEscape(pathDirs.join(":"))}</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(job.logPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(job.logPath)}</string>
</dict>
</plist>
`;
}

function isInside(root: string, path: string): boolean {
	const rel = relative(resolve(root), resolve(path));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Why `outDir` may not be written, or null when it is allowed (only under ~/.agentcity). */
export function outDirProblem(
	outDir: string,
	userHome: string,
	agentcityHome: string,
): string | null {
	if (isInside(join(userHome, "Library", "LaunchAgents"), outDir))
		return "refusing to write under ~/Library/LaunchAgents — apply the files yourself";
	if (isInside(join(userHome, ".claude"), outDir))
		return "refusing to write under ~/.claude";
	if (!isInside(agentcityHome, outDir))
		return `--out-dir must be inside ${agentcityHome} (this tool writes only there)`;
	return null;
}

export interface Deps {
	userHome: string;
	repoRoot: string;
	bun: string;
	node: string | null;
	log: (line: string) => void;
}

/** Returns the process exit code. */
export function run(argv: string[], deps: Deps): number {
	let values: {
		"tunnel-target"?: string;
		ports?: string;
		"office-dir"?: string;
		"office-env"?: string;
		hub?: string;
		"out-dir"?: string;
	};
	try {
		values = parseArgs({
			args: argv,
			options: {
				"tunnel-target": { type: "string" },
				ports: { type: "string", default: "4317,5173" },
				"office-dir": { type: "string" },
				"office-env": { type: "string" },
				hub: { type: "string", default: "http://127.0.0.1:4317" },
				"out-dir": { type: "string" },
			},
			allowPositionals: false,
		}).values;
	} catch (e) {
		deps.log(`error: ${(e as Error).message}`);
		return 2;
	}

	const agentcityHome = join(deps.userHome, ".agentcity");
	const outDir = resolve(values["out-dir"] ?? join(agentcityHome, "launchd"));
	const problem = outDirProblem(outDir, deps.userHome, agentcityHome);
	if (problem) {
		deps.log(`error: ${problem}`);
		return 1;
	}

	let tunnel: PlanOptions["tunnel"] = null;
	if (values["tunnel-target"] !== undefined) {
		const target = values["tunnel-target"];
		const ports = parsePorts(values.ports ?? "");
		if (!validTunnelTarget(target)) {
			deps.log(
				"error: --tunnel-target must look like user@host or an ssh alias",
			);
			return 2;
		}
		if (!ports) {
			deps.log("error: --ports must be a comma list of 1..65535");
			return 2;
		}
		tunnel = { target, ports };
	}

	let office: PlanOptions["office"] = null;
	if (values["office-dir"] !== undefined) {
		office = {
			dir: resolve(values["office-dir"]),
			envFile: resolve(
				values["office-env"] ?? join(agentcityHome, "office-projection.env"),
			),
		};
	}

	const pathDirs = [
		...new Set(
			[
				dirname(deps.bun),
				deps.node ? dirname(deps.node) : null,
				"/usr/local/bin",
				"/usr/bin",
				"/bin",
				"/usr/sbin",
				"/sbin",
			].filter((d): d is string => d !== null),
		),
	];
	const plan = buildPlan({
		repoRoot: deps.repoRoot,
		agentcityHome,
		bin: { bun: deps.bun, node: deps.node, ssh: "/usr/bin/ssh" },
		hubUrl: values.hub ?? "http://127.0.0.1:4317",
		tunnel,
		office,
	});

	mkdirSync(agentcityHome, { recursive: true, mode: 0o700 });
	const realHome = realpathSync(agentcityHome);
	for (const dir of [outDir, join(agentcityHome, "logs")]) {
		// Before creating anything: no symlink on the leaf, and the nearest existing ancestor must
		// really be inside ~/.agentcity (a symlinked parent could lead out of it).
		let existing = dir;
		for (;;) {
			try {
				if (lstatSync(existing).isSymbolicLink()) {
					deps.log(`error: ${existing} is a symlink — refusing`);
					return 1;
				}
				break;
			} catch {
				const parent = dirname(existing);
				if (parent === existing) break;
				existing = parent;
			}
		}
		if (!isInside(realHome, realpathSync(existing))) {
			deps.log(`error: ${dir} resolves outside ~/.agentcity — refusing`);
			return 1;
		}
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}

	const written: Array<{ job: LaunchdJob; path: string }> = [];
	for (const job of plan.jobs) {
		const path = join(outDir, `${job.label}.plist`);
		writeFileSync(path, plistXml(job, pathDirs), { mode: 0o600 });
		try {
			chmodSync(path, 0o600);
		} catch {
			// not supported on every platform
		}
		written.push({ job, path });
	}

	const la = "~/Library/LaunchAgents";
	const out = deps.log;
	out(
		`checkout     : ${deps.repoRoot}  (baked into the files — generate from the main checkout)`,
	);
	out(`files in     : ${outDir}`);
	for (const { job, path } of written) out(`  ${job.name.padEnd(9)} ${path}`);
	for (const s of plan.skipped) out(`skipped      : ${s}`);
	out(
		"\n1. stop the terminal copies first (two of a kind fight over a port / offsets file / boot_id):",
	);
	for (const { job } of written) out(`   - ${job.name}: ${job.stopFirst}`);
	for (const { job } of written)
		if (job.note) out(`   note (${job.name}): ${job.note}`);
	out(`\n2. review:  plutil -lint ${join(outDir, "*.plist")}`);
	out("\n3. apply (yours to run):");
	out(`   mkdir -p ${la}`);
	for (const { job, path } of written) {
		out(`   cp ${path} ${la}/`);
		out(`   launchctl bootstrap gui/$(id -u) ${la}/${job.label}.plist`);
	}
	out(
		"\n4. stop / start / restart one job (KeepAlive restarts a killed job; bootout keeps it down):",
	);
	out(`   launchctl bootout gui/$(id -u)/${LABEL_PREFIX}.<job>`);
	out(`   launchctl bootstrap gui/$(id -u) ${la}/${LABEL_PREFIX}.<job>.plist`);
	out(`   launchctl kickstart -k gui/$(id -u)/${LABEL_PREFIX}.<job>`);
	out(`   logs: ${join(agentcityHome, "logs")}/<job>.log`);
	out(`\n5. remove: bootout, then rm the file from ${la}`);
	return 0;
}

if (import.meta.main) {
	process.exit(
		run(process.argv.slice(2), {
			userHome: homedir(),
			repoRoot: resolve(import.meta.dir, "../../.."),
			bun: process.execPath,
			node: Bun.which("node"),
			log: (l) => console.log(l),
		}),
	);
}
