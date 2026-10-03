// Copy an ALLOWLIST of synthetic browser-suite evidence out of isolated runs for upload, and summarize.
//
//   bun scripts/ci/collect-browser-evidence.ts --root <isolated root> --out <dir> [--summary <file>]
//
// <root> holds one directory per `scripts/ci/isolated.ts` run. From each run only these are copied:
//   run.json, suite.log                                      (the wrapper's outcome and the suite output)
//   tmp/agentcity-m1-09-{hub,fx,multi}-*/results.json and *.png (workspace / campus / repair / multi-repo suites)
//   tmp/agentcity-browser-evidence-*/*.png                    (legacy browser gate screenshots)
// Never copied: HOME, the fixture repository, SQLite files, browser profiles or storage, traces, HARs,
// accessibility snapshots, Vite caches, anything else under tmp/. Symlinks are skipped. Every copied
// text file is scanned with the shared secret patterns first; a hit is not copied and fails the step
// (the file and pattern name are printed, never the value). Exit 0 when nothing was blocked.
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SCAN_PATTERNS } from "../../packages/schema/src/secret-patterns.ts";

const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 250 * 1024 * 1024;
const EVIDENCE_DIR =
	/^agentcity-(m1-09-(hub|fx|multi)|browser-evidence)-[A-Za-z0-9]+$/;
const PNG = /^[A-Za-z0-9._-]+\.png$/;

const args = process.argv.slice(2);
const opt = (name: string) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
};
const root = opt("root");
const outArg = opt("out");
const summaryFile = opt("summary");
if (!root || !outArg) {
	console.error(
		"usage: bun scripts/ci/collect-browser-evidence.ts --root <dir> --out <dir> [--summary <file>]",
	);
	process.exit(2);
}
const out = resolve(outArg);
mkdirSync(out, { recursive: true });

const blocked: string[] = [];
let total = 0;
let skippedForSize = 0;

const kind = (p: string) => {
	try {
		const s = lstatSync(p); // never follows a symlink
		return s.isFile() ? "file" : s.isDirectory() ? "dir" : "other";
	} catch {
		return "missing";
	}
};

function copy(src: string, dest: string, text: boolean) {
	if (kind(src) !== "file") return;
	const size = lstatSync(src).size;
	if (size > MAX_FILE || total + size > MAX_TOTAL) {
		skippedForSize++;
		return;
	}
	if (text) {
		const lines = readFileSync(src, "utf8").split("\n");
		for (const [i, line] of lines.entries())
			for (const { name, re } of SCAN_PATTERNS)
				if (re.test(line)) {
					blocked.push(`${dest.slice(out.length + 1)}:${i + 1} ${name}`);
					return;
				}
	}
	mkdirSync(dirname(dest), { recursive: true });
	copyFileSync(src, dest);
	total += size;
}

interface Row {
	label: string;
	exit: string;
	records: string;
	seconds: string;
}
const rows: Row[] = [];
const runs =
	kind(root) === "dir"
		? readdirSync(root)
				.filter((l) => kind(join(root, l)) === "dir")
				.sort()
		: [];

for (const label of runs) {
	const run = join(root, label);
	copy(join(run, "run.json"), join(out, label, "run.json"), true);
	copy(join(run, "suite.log"), join(out, label, "suite.log"), true);
	const counts = new Map<string, number>();
	const tmp = join(run, "tmp");
	for (const name of kind(tmp) === "dir" ? readdirSync(tmp).sort() : []) {
		const dir = join(tmp, name);
		if (!EVIDENCE_DIR.test(name) || kind(dir) !== "dir") continue;
		for (const f of readdirSync(dir).sort()) {
			if (f === "results.json") {
				copy(join(dir, f), join(out, label, name, f), true);
				try {
					const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
						results?: { status?: string }[];
					};
					for (const c of r.results ?? []) {
						const s = c.status ?? "?";
						counts.set(s, (counts.get(s) ?? 0) + 1);
					}
				} catch {
					counts.set("unreadable results.json", 1);
				}
			} else if (PNG.test(f))
				copy(join(dir, f), join(out, label, name, f), false);
		}
	}
	let meta: { exit?: number; seconds?: number; stopped_by?: string | null } =
		{};
	try {
		meta = JSON.parse(readFileSync(join(run, "run.json"), "utf8"));
	} catch {
		// the wrapper never finished (e.g. the runner was cancelled)
	}
	let records = [...counts].map(([k, n]) => `${k} ${n}`).join(" · ");
	if (!records && existsSync(join(run, "suite.log"))) {
		// the legacy gate prints "N/M browser checks passed" instead of a results file
		const m = /(\d+)\/(\d+) browser checks passed/.exec(
			readFileSync(join(run, "suite.log"), "utf8"),
		);
		if (m) records = `${m[1]}/${m[2]} checks passed`;
	}
	rows.push({
		label,
		exit:
			meta.exit === undefined
				? "unknown"
				: `${meta.exit}${meta.stopped_by ? ` (${meta.stopped_by})` : ""}`,
		records: records || "no results",
		seconds: meta.seconds === undefined ? "?" : String(meta.seconds),
	});
}

const md = [
	"### Browser suites (isolated, simulated only)",
	"",
	"Records are runner pass records per suite, not assertions.",
	"",
	"| suite run | exit | records | seconds |",
	"| --- | --- | --- | --- |",
	...rows.map(
		(r) => `| ${r.label} | ${r.exit} | ${r.records} | ${r.seconds} |`,
	),
	...(rows.length === 0 ? ["| (no isolated runs) | | | |"] : []),
	"",
	`Evidence copied: ${(total / 1024 / 1024).toFixed(1)} MiB${skippedForSize ? `; ${skippedForSize} file(s) skipped by the size cap` : ""}.`,
	blocked.length
		? `**Blocked by the secret scan (not uploaded):** ${blocked.join("; ")}`
		: "Secret scan of copied text files: no hits.",
	"",
].join("\n");
writeFileSync(join(out, "SUMMARY.md"), md);
if (summaryFile) appendFileSync(summaryFile, md);
console.log(md);
process.exit(blocked.length ? 1 : 0);
