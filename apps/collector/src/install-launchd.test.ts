import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildPlan,
	LABEL_PREFIX,
	outDirProblem,
	parsePorts,
	plistXml,
	run,
	validProject,
	validTunnelTarget,
	xmlEscape,
} from "./install-launchd.ts";
import { isWindows, posixOnly } from "./posix-only.ts";

const TARGET = "tester@example.invalid"; // synthetic; the real host never goes in the repo
const SENTINEL = "SENTINEL_NOT_A_REAL_SECRET_0123456789";

let home: string;
let lines: string[];
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "agentcity-launchd-"));
	lines = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const deps = () => ({
	userHome: home,
	repoRoot: join(home, "checkout"),
	bun: join(home, "bin", "bun"),
	node: join(home, "bin", "node") as string | null,
	log: (l: string) => lines.push(l),
});
const outDir = () => join(home, ".agentcity", "launchd");
const plists = () => readdirSync(outDir()).sort();
const read = (name: string) => readFileSync(join(outDir(), name), "utf8");

describe("argument checks", () => {
	test("tunnel target: user@host or alias; never an ssh option", () => {
		expect(validTunnelTarget("me@host.example")).toBe(true);
		expect(validTunnelTarget("cockpit")).toBe(true);
		expect(validTunnelTarget("-oProxyCommand=evil")).toBe(false);
		expect(validTunnelTarget("a b")).toBe(false);
		expect(validTunnelTarget("")).toBe(false);
		expect(validTunnelTarget("host;rm")).toBe(false);
	});
	test("ports: a comma list of 1..65535, deduplicated", () => {
		expect(parsePorts("4317,5173,4317")).toEqual([4317, 5173]);
		expect(parsePorts("0")).toBeNull();
		expect(parsePorts("70000")).toBeNull();
		expect(parsePorts("43x")).toBeNull();
		expect(parsePorts("")).toBeNull();
	});
	test("a bad target, port or flag writes nothing and exits non-zero", () => {
		expect(run(["--tunnel-target", "-oFoo=bar"], deps())).toBe(2);
		expect(run(["--tunnel-target", TARGET, "--ports", "x"], deps())).toBe(2);
		expect(run(["--nope"], deps())).toBe(2);
		expect(existsSync(outDir())).toBe(false);
	});
});

describe("plan", () => {
	const base = {
		repoRoot: "/r/checkout",
		agentcityHome: "/h/.agentcity",
		bin: {
			bun: "/b/bun",
			node: "/b/node" as string | null,
			ssh: "/usr/bin/ssh",
		},
		hubUrl: "http://127.0.0.1:4317",
		tunnel: { target: TARGET, ports: [4317, 5173] },
		office: {
			dir: "/o/office",
			envFile: "/h/.agentcity/office-projection.env",
		},
	};
	test("four jobs with absolute binaries", () => {
		const { jobs, skipped } = buildPlan(base);
		expect(jobs.map((j) => j.name)).toEqual([
			"tunnel",
			"heartbeat",
			"codex",
			"exporter",
		]);
		expect(skipped).toEqual([]);
		for (const j of jobs) {
			expect(j.label.startsWith(`${LABEL_PREFIX}.`)).toBe(true);
			expect(j.args[0]?.startsWith("/")).toBe(true);
		}
	});
	test("tunnel: no prompt, dies when a forward fails, forwards the given ports to loopback", () => {
		const t = buildPlan(base).jobs.find((j) => j.name === "tunnel");
		expect(t?.args).toContain("BatchMode=yes");
		expect(t?.args).toContain("ExitOnForwardFailure=yes");
		expect(t?.args).toContain("4317:127.0.0.1:4317");
		expect(t?.args).toContain("5173:127.0.0.1:5173");
		expect(t?.args.at(-1)).toBe(TARGET);
	});
	test("collectors run without auto-loading a project .env", () => {
		for (const n of ["heartbeat", "codex"]) {
			const j = buildPlan(base).jobs.find((x) => x.name === n);
			expect(j?.args.slice(0, 2)).toEqual(["/b/bun", "--no-env-file"]);
			expect(j?.workingDirectory).toBe("/r/checkout");
		}
	});
	test("tunnel and exporter are skipped, with a reason, when their input is missing", () => {
		const { jobs, skipped } = buildPlan({
			...base,
			tunnel: null,
			office: null,
		});
		expect(jobs.map((j) => j.name)).toEqual(["heartbeat", "codex"]);
		expect(skipped.join("\n")).toContain("tunnel");
		expect(skipped.join("\n")).toContain("exporter");
		const noNode = buildPlan({ ...base, bin: { ...base.bin, node: null } });
		expect(noNode.jobs.some((j) => j.name === "exporter")).toBe(false);
	});
	test("exporter: the token file is sourced by a shell at run time, its content is never in the job", () => {
		const e = buildPlan(base).jobs.find((j) => j.name === "exporter");
		expect(e?.args.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
		expect(e?.args[2]).toContain('. "$1"');
		expect(e?.args).toContain("/h/.agentcity/office-projection.env");
		expect(e?.workingDirectory).toBe("/o/office");
		expect(JSON.stringify(e)).not.toMatch(/TOKEN=/);
	});
});

describe("plist", () => {
	test("escapes XML in every string", () => {
		expect(xmlEscape(`a&b<c>"d"`)).toBe("a&amp;b&lt;c&gt;&quot;d&quot;");
		const xml = plistXml(
			{
				name: "x",
				label: "l",
				args: ["/a/b&c", "<arg>"],
				workingDirectory: "/w",
				logPath: "/l.log",
				stopFirst: "",
			},
			["/p1", "/p2"],
		);
		expect(xml).toContain("<string>/a/b&amp;c</string>");
		expect(xml).toContain("<string>&lt;arg&gt;</string>");
		expect(xml).toContain("<string>/p1:/p2</string>");
		expect(xml).toContain("<key>KeepAlive</key>");
	});
});

describe("exporter flags (--office-home, --project)", () => {
	const plan = (extra: { home?: string | null; projects?: string[] }) =>
		buildPlan({
			repoRoot: "/r/checkout",
			agentcityHome: "/h/.agentcity",
			bin: { bun: "/b/bun", node: "/b/node", ssh: "/usr/bin/ssh" },
			hubUrl: "http://127.0.0.1:4317",
			tunnel: null,
			office: {
				dir: "/o/office",
				envFile: "/h/.agentcity/office-projection.env",
				...extra,
			},
		}).jobs.find((j) => j.name === "exporter");

	test("project shape mirrors the exporter's own --project check", () => {
		expect(validProject("station0-nav=Owner/station0")).toBe(true);
		expect(validProject("wt.1_x=a-b/c.d_e")).toBe(true);
		for (const bad of [
			"",
			"=Owner/repo",
			"wt",
			"wt=",
			"wt=repo",
			"wt=Owner/..",
			"-wt=Owner/repo",
			"wt=Owner/re po",
			"wt=own_er/repo",
		])
			expect(validProject(bad)).toBe(false);
	});

	test("--home and every --project follow --hub as separate arguments; the shell text never contains them", () => {
		const e = plan({
			home: "/h/.agent-office-x",
			projects: ["wt-a=Owner/repo", "wt-b=Owner/other"],
		});
		// args[3] is $0 of the shell; the positional arguments start after it
		expect(e?.args.slice(4)).toEqual([
			"/h/.agentcity/office-projection.env",
			"/b/node",
			"http://127.0.0.1:4317",
			"--home",
			"/h/.agent-office-x",
			"--project",
			"wt-a=Owner/repo",
			"--project",
			"wt-b=Owner/other",
		]);
		expect(e?.args[2]).toContain('"$@"');
		expect(e?.args[2]).not.toMatch(/agent-office|Owner/);
		expect(e?.note).not.toContain("No --office-home");
	});

	test("without --office-home no --home is passed, and the note says which home is read", () => {
		const e = plan({});
		expect(e?.args).not.toContain("--home");
		expect(e?.args).not.toContain("--project");
		expect(e?.note).toContain("No --office-home");
	});

	test("run: bad or orphaned exporter flags write nothing and exit 2", () => {
		const o = ["--office-dir", join(home, "office")];
		expect(run([...o, "--project", "wt=repo"], deps())).toBe(2);
		expect(run([...o, "--office-home", "relative/dir"], deps())).toBe(2);
		expect(run(["--project", "wt=Owner/repo"], deps())).toBe(2);
		expect(run(["--office-home", join(home, "state")], deps())).toBe(2);
		expect(existsSync(outDir())).toBe(false);
	});

	test("run: the plist carries --home and --project, never the token; a missing exporter script is warned about", () => {
		const office = join(home, "office");
		mkdirSync(join(home, ".agentcity"), { recursive: true });
		writeFileSync(
			join(home, ".agentcity", "office-projection.env"),
			`OFFICE_PROJECTION_TOKEN=${SENTINEL}\n`,
		);
		const state = join(home, "state");
		expect(
			run(
				[
					"--office-dir",
					office,
					"--office-home",
					state,
					"--project",
					"wt-a=Owner/repo",
					"--project",
					"wt-b=Owner/other",
				],
				deps(),
			),
		).toBe(0);
		const xml = read(`${LABEL_PREFIX}.exporter.plist`);
		expect(xml).toContain("<string>--home</string>");
		expect(xml).toContain(`<string>${state}</string>`);
		expect(xml.match(/<string>--project<\/string>/g)).toHaveLength(2);
		expect(xml).toContain("<string>wt-a=Owner/repo</string>");
		expect(xml).not.toContain(SENTINEL);
		expect(lines.join("\n")).not.toContain(SENTINEL);
		expect(lines.join("\n")).toContain("warning      :"); // no scripts/city-export.mjs there yet

		mkdirSync(join(office, "scripts"), { recursive: true });
		writeFileSync(join(office, "scripts", "city-export.mjs"), "");
		lines = [];
		expect(run(["--office-dir", office], deps())).toBe(0);
		expect(lines.join("\n")).not.toContain("warning      :");
	});
});

describe("run: writes only under ~/.agentcity, prints, never loads", () => {
	test("writes one plist per job, logs dir, owner-only mode; prints the steps", () => {
		expect(
			run(
				["--tunnel-target", TARGET, "--office-dir", join(home, "office")],
				deps(),
			),
		).toBe(0);
		expect(plists()).toEqual([
			`${LABEL_PREFIX}.codex.plist`,
			`${LABEL_PREFIX}.exporter.plist`,
			`${LABEL_PREFIX}.heartbeat.plist`,
			`${LABEL_PREFIX}.tunnel.plist`,
		]);
		expect(existsSync(join(home, ".agentcity", "logs"))).toBe(true);
		if (!isWindows)
			expect(statSync(join(outDir(), plists()[0] ?? "")).mode & 0o777).toBe(
				0o600,
			);
		const text = lines.join("\n");
		expect(text).toContain("launchctl bootstrap");
		expect(text).toContain("launchctl bootout");
		expect(text).toContain("stop the terminal copies first");
		expect(text).toContain("collector:heartbeat");
		expect(text).toContain("collector:codex");
		expect(text).toContain("city:export");
		// nothing was installed next to the user's launch agents, and no env file was created
		expect(existsSync(join(home, "Library"))).toBe(false);
		expect(existsSync(join(home, ".agentcity", "office-projection.env"))).toBe(
			false,
		);
	});

	test("the projection env file is never opened: a missing file is fine, a file with a secret is not echoed", () => {
		const office = join(home, "office");
		expect(run(["--office-dir", office], deps())).toBe(0); // env file does not exist
		writeFileSync(
			join(home, ".agentcity", "office-projection.env"),
			`OFFICE_PROJECTION_TOKEN=${SENTINEL}\n`,
		);
		lines = [];
		expect(run(["--office-dir", office], deps())).toBe(0);
		const everything = [lines.join("\n"), ...plists().map(read)].join("\n");
		expect(everything).not.toContain(SENTINEL);
	});

	test("without a target or an office dir only the two collectors are written, and the skips are said", () => {
		expect(run([], deps())).toBe(0);
		expect(plists()).toEqual([
			`${LABEL_PREFIX}.codex.plist`,
			`${LABEL_PREFIX}.heartbeat.plist`,
		]);
		expect(lines.join("\n")).toContain("skipped      : tunnel");
		expect(lines.join("\n")).toContain("skipped      : exporter");
	});

	test("refuses ~/Library/LaunchAgents, ~/.claude and anything outside ~/.agentcity", () => {
		for (const bad of [
			join(home, "Library", "LaunchAgents"),
			join(home, "Library", "LaunchAgents", "sub"),
			join(home, ".claude"),
			join(home, "elsewhere"),
			join(home, ".agentcity", "..", "elsewhere2"),
		]) {
			lines = [];
			expect(run(["--out-dir", bad], deps())).toBe(1);
			expect(lines.join("\n")).toContain("error:");
			expect(existsSync(bad)).toBe(false);
		}
		expect(outDirProblem(outDir(), home, join(home, ".agentcity"))).toBeNull();
		expect(
			outDirProblem(join(outDir(), "x"), home, join(home, ".agentcity")),
		).toBeNull();
	});

	posixOnly("POSIX-only: a symlinked out-dir is refused (symlinks)", () => {
		const real = join(home, ".agentcity", "real");
		mkdirSync(real, { recursive: true });
		symlinkSync(real, outDir());
		expect(run([], deps())).toBe(1);
		expect(lines.join("\n")).toContain("symlink");
	});

	posixOnly(
		"POSIX-only: a symlinked parent inside ~/.agentcity that leads outside is refused (symlinks)",
		() => {
			const outside = join(home, "outside");
			mkdirSync(outside);
			mkdirSync(join(home, ".agentcity"), { recursive: true });
			symlinkSync(outside, join(home, ".agentcity", "link"));
			expect(
				run(["--out-dir", join(home, ".agentcity", "link", "d")], deps()),
			).toBe(1);
			// nothing was created outside, not even the directory
			expect(readdirSync(outside)).toEqual([]);
		},
	);

	posixOnly("POSIX-only: macOS plutil accepts every file", () => {
		if (process.platform !== "darwin" || !Bun.which("plutil")) return;
		expect(
			run(
				["--tunnel-target", TARGET, "--office-dir", join(home, "office")],
				deps(),
			),
		).toBe(0);
		for (const f of plists()) {
			const r = Bun.spawnSync(["plutil", "-lint", join(outDir(), f)]);
			expect(r.exitCode).toBe(0);
		}
	});
});
