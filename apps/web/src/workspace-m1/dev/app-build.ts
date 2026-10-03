// Production-bundle proof of the WHOLE workspace UI in hub mode (role 07, dev tool):
//
//   …/iso/run.sh bun --no-env-file apps/web/src/workspace-m1/dev/app-build.ts
//
// Programmatic `vite build` (configFile false, empty envDir, root apps/web, plugin-react, NO
// define → hub mode) of dev/fixture.html → fixture-main.tsx → WorkspaceApp. Asserts: no
// node:/bun:/Bun/Buffer/require/browser-external in any chunk; the scoped CSS asset is emitted;
// the fixture world is NOT in the entry chunk (only in a lazily loaded chunk).
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { build, createLogger } from "vite";

const WEB_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HTML = fileURLToPath(new URL("./fixture.html", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "agentcity-m1-appbuild-"));
const envDir = join(work, "empty-env");
const outDir = join(work, "out");
mkdirSync(envDir);

const warnings: string[] = [];
const logger = createLogger("warn", { allowClearScreen: false });
logger.warn = (m) => {
	warnings.push(m);
};
logger.warnOnce = (m) => {
	warnings.push(m);
};

await build({
	configFile: false,
	root: WEB_ROOT,
	envDir,
	cacheDir: join(work, "vite-cache"),
	mode: "production",
	customLogger: logger,
	logLevel: "warn",
	plugins: [react()],
	build: {
		outDir,
		emptyOutDir: true,
		copyPublicDir: false,
		rollupOptions: {
			input: HTML,
			onLog(level, log) {
				if (level === "warn") warnings.push(String(log.message));
			},
		},
	},
});

const files = readdirSync(outDir, { recursive: true, encoding: "utf8" }).filter(
	(f) => statSync(join(outDir, f)).isFile(),
);
const problems: string[] = [];
const chunks: { file: string; bytes: number }[] = [];
const FIXTURE_MARKERS = ["fixture: illegal stage change", "seed-demo-"];
const html = readFileSync(
	join(outDir, files.find((f) => f.endsWith(".html")) ?? ""),
	"utf8",
);
const entry = /src="\/?([^"]+\.js)"/.exec(html)?.[1] ?? "";
let fixtureChunk = "";
for (const f of files) {
	const bytes = statSync(join(outDir, f)).size;
	chunks.push({ file: f, bytes });
	if (!f.endsWith(".js")) continue;
	const src = readFileSync(join(outDir, f), "utf8");
	const checks: [string, RegExp][] = [
		["node: specifier", /["']node:/],
		["bun: specifier", /["']bun:/],
		["Bun global", /\bBun\./],
		["Buffer global", /\bBuffer\b/],
		["require()", /\brequire\(/],
		["vite browser-external stub", /__vite[-_]browser[-_]external/],
	];
	for (const [what, re] of checks)
		if (re.test(src)) problems.push(`${f}: ${what}`);
	if (FIXTURE_MARKERS.every((m) => src.includes(m))) fixtureChunk = f;
}
if (!entry) problems.push("entry chunk not found in the built HTML");
else {
	const entrySrc = readFileSync(join(outDir, entry), "utf8");
	for (const m of FIXTURE_MARKERS)
		if (entrySrc.includes(m))
			problems.push(`entry chunk contains fixture marker "${m}"`);
	if (!entrySrc.includes("Skip to task panel"))
		problems.push("entry chunk lacks the workspace UI");
}
if (!fixtureChunk) problems.push("no separate lazily loaded fixture chunk");
const css = files.filter((f) => f.endsWith(".css"));
if (!css.some((f) => readFileSync(join(outDir, f), "utf8").includes(".wsm1")))
	problems.push("scoped workspace CSS not emitted");
for (const w of warnings.filter((x) =>
	/externali[sz]ed|browser compatibility/i.test(x),
))
	problems.push(`warning: ${w.split("\n")[0]}`);

console.log(
	JSON.stringify(
		{
			ok: problems.length === 0,
			outDir,
			entry,
			fixtureChunk,
			chunks,
			warnings: warnings.length,
			problems,
		},
		null,
		2,
	),
);
process.exit(problems.length === 0 ? 0 : 1);
