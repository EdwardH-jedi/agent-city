// `bun run collector:launchd -- [--tunnel-target user@host] [--office-dir DIR] [options]`
// PRINT-ONLY (decision D7), like `collector:hooks`: writes launchd job files under ~/.agentcity/launchd/
// and prints the commands that load them. It never touches ~/Library/LaunchAgents or ~/.claude, and
// never loads or starts anything — copying the files and `launchctl bootstrap` are the owner's call.
//
// Jobs (each one only when its inputs are given): tunnel (ssh -L to the hub host), heartbeat, codex
// log tailer, Agent Office run exporter, and one more exporter per `--office-instance <name>=<home>`
// (a second Office state home: own label `…exporter.<name>`, own log `exporter.<name>.log`).
//
// No secret is ever written: the heartbeat and the tailer read this checkout's own .env at run time
// (collector/config.ts), and the exporter job sources the owner's projection env file in a shell at
// run time. This generator never opens that file.
//
// The checkout path is baked into the files, so generate them from the `main` checkout.
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

export const LABEL_PREFIX = "local.agentcity";

export interface LaunchdJob {
	/** short name: tunnel | heartbeat | codex | exporter | exporter.<instance> */
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
	office: {
		dir: string;
		envFile: string;
		/** The Office state home the exporter reads (`--home`); null = the exporter's own default. */
		home?: string | null;
		/** `<worktreeId>=<owner/name>` entries, each passed as `--project`. */
		projects?: string[];
		/** Further Office state homes, one exporter job each (same checkout, env file and hub). */
		instances?: OfficeInstance[];
	} | null;
}

export interface OfficeInstance {
	/** `[a-z0-9][a-z0-9-]{0,23}`: goes into the job's label and log file name. */
	name: string;
	/** Absolute Office state home this exporter reads (`--home`). */
	home: string;
	/** `<worktreeId>=<owner/name>` entries for this home only. */
	projects: string[];
}

export const INSTANCE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

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

const WORKTREE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROJECT_NAME_RE =
	/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/** `<worktreeId>=<owner/name>`, the same shape the exporter accepts for `--project`. */
export function validProject(entry: string): boolean {
	const i = entry.indexOf("=");
	if (i < 1) return false;
	return (
		WORKTREE_ID_RE.test(entry.slice(0, i)) &&
		PROJECT_NAME_RE.test(entry.slice(i + 1))
	);
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
		const office = o.office;
		const node = o.bin.node;
		const exporter = (
			name: string,
			home: string | null,
			projects: string[],
		): Omit<LaunchdJob, "stopFirst" | "note"> => ({
			name,
			label: `${LABEL_PREFIX}.${name}`,
			// The token stays in the owner's env file; the shell sources it when the job starts.
			args: [
				"/bin/sh",
				"-c",
				'set -a; . "$1"; set +a; n="$2"; h="$3"; shift 3; exec "$n" scripts/city-export.mjs --hub "$h" "$@"',
				"agentcity-exporter",
				office.envFile,
				node,
				o.hubUrl,
				// Further flags ride along as positional arguments: nothing is spliced into the shell text.
				...(home ? ["--home", home] : []),
				...projects.flatMap((p) => ["--project", p]),
			],
			workingDirectory: office.dir,
			logPath: log(name),
		});
		jobs.push({
			...exporter("exporter", office.home ?? null, office.projects ?? []),
			stopFirst: "the terminal `npm run city:export`",
			note: office.home
				? "Runs scripts/city-export.mjs of the checkout given as --office-dir; if that file is not there, the job exits and is retried every 10 s."
				: "No --office-home: the exporter reads its default state home (~/.agent-office), which may not hold your runs; pass --office-home <the state home that recorded them>. Runs scripts/city-export.mjs of --office-dir; if that file is not there, the job exits and is retried every 10 s.",
		});
		for (const i of office.instances ?? [])
			jobs.push({
				...exporter(`exporter.${i.name}`, i.home, i.projects),
				stopFirst: `a terminal \`npm run city:export\` reading ${i.home}, if one runs`,
			});
	}
	// Two jobs with one label would replace each other in launchd; two with one log would interleave.
	for (const key of ["label", "logPath"] as const) {
		const seen = new Set<string>();
		for (const j of jobs) {
			if (seen.has(j[key]))
				throw new Error(
					`two launchd jobs share a ${key === "label" ? "label" : "log"}: ${j[key]}`,
				);
			seen.add(j[key]);
		}
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

/** The `--home` an existing exporter job file passes, or null when it passes none (or cannot be read). */
export function plistHome(xml: string): string | null {
	const m = /<string>--home<\/string>\s*<string>([^<]*)<\/string>/.exec(xml);
	if (!m?.[1]) return null;
	return m[1]
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
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
		"office-home"?: string;
		"office-instance"?: string[];
		project?: string[];
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
				"office-home": { type: "string" },
				"office-instance": { type: "string", multiple: true },
				project: { type: "string", multiple: true },
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
	const allProjects = values.project ?? [];
	const instanceArgs = values["office-instance"] ?? [];
	if (values["office-dir"] === undefined) {
		if (
			values["office-home"] !== undefined ||
			allProjects.length > 0 ||
			instanceArgs.length > 0
		) {
			deps.log(
				"error: --office-home, --office-instance and --project need --office-dir",
			);
			return 2;
		}
	} else {
		const home = values["office-home"];
		if (home !== undefined && !isAbsolute(home)) {
			deps.log("error: --office-home must be an absolute path");
			return 2;
		}
		// `--office-instance <name>=<absolute home>`: one more exporter job for a second state home.
		// Without --office-home the main exporter reads Office's own default home, which this tool cannot
		// resolve (Office decides it); an instance could then be that same home. So instances need it.
		if (instanceArgs.length > 0 && home === undefined) {
			deps.log(
				"error: --office-instance needs --office-home for the main exporter (so two exporters never read one home)",
			);
			return 2;
		}
		const instances: OfficeInstance[] = [];
		const homes = new Set(home !== undefined ? [resolve(home)] : []);
		for (const arg of instanceArgs) {
			const i = arg.indexOf("=");
			const name = i > 0 ? arg.slice(0, i) : "";
			const ihome = i > 0 ? arg.slice(i + 1) : "";
			if (!INSTANCE_NAME_RE.test(name) || !isAbsolute(ihome)) {
				deps.log(
					"error: --office-instance must look like <name>=<absolute state home>, name [a-z0-9-] (max 24)",
				);
				return 2;
			}
			if (instances.some((x) => x.name === name)) {
				deps.log(`error: --office-instance name '${name}' is given twice`);
				return 2;
			}
			if (homes.has(resolve(ihome))) {
				deps.log(
					"error: two exporters would read the same state home (each home gets one exporter)",
				);
				return 2;
			}
			homes.add(resolve(ihome));
			instances.push({ name, home: ihome, projects: [] });
		}
		// `--project <worktreeId>=<owner/name>` belongs to the default exporter;
		// `--project <name>:<worktreeId>=<owner/name>` to that instance only.
		const projects: string[] = [];
		for (const entry of allProjects) {
			const m = /^([a-z0-9][a-z0-9-]{0,23}):(.*)$/.exec(entry);
			const target = m ? instances.find((x) => x.name === m[1]) : null;
			const value = m ? (m[2] ?? "") : entry;
			if (m && !target) {
				deps.log(
					`error: --project ${m[1]}:… names no --office-instance '${m[1]}'`,
				);
				return 2;
			}
			if (!validProject(value)) {
				deps.log(
					"error: --project must look like <worktreeId>=<owner/name> (or <instance>:<worktreeId>=<owner/name>)",
				);
				return 2;
			}
			(target ? target.projects : projects).push(value);
		}
		office = {
			dir: resolve(values["office-dir"]),
			envFile: resolve(
				values["office-env"] ?? join(agentcityHome, "office-projection.env"),
			),
			home: home ?? null,
			projects,
			instances,
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

	// An exporter file already written for another state home is not replaced: that is how one home's
	// job would silently start reading another home. Checked for every job before anything is written.
	for (const job of plan.jobs) {
		if (!job.name.startsWith("exporter")) continue;
		const path = join(outDir, `${job.label}.plist`);
		if (!existsSync(path)) continue;
		let before: string | null = null;
		try {
			before = plistHome(readFileSync(path, "utf8"));
		} catch {
			before = null;
		}
		const now = plistHome(plistXml(job, []));
		// Only an explicit home replaced by another explicit home is refused; regenerating without
		// --office-home keeps the single-home behaviour it always had.
		if (before !== null && now !== null && before !== now) {
			deps.log(
				`error: ${path} already runs the exporter for another state home — refusing to replace it. ` +
					"Give the new home as --office-instance <name>=<home>, or use another --out-dir.",
			);
			return 1;
		}
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
	if (office && !existsSync(join(office.dir, "scripts", "city-export.mjs")))
		out(
			`warning      : ${join(office.dir, "scripts", "city-export.mjs")} does not exist — the exporter job would exit and be retried every 10 s`,
		);
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
