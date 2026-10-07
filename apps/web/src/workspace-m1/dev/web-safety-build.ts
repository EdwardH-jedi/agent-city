// Web-safety proof for `@agent-city/schema/workspace-m1` (role 07, dev tool; never imported by the
// app). Run through the isolated runner:
//
//   …/iso/run.sh bun --no-env-file apps/web/src/workspace-m1/dev/web-safety-build.ts
//
// Programmatic Vite build with `configFile: false` (apps/web/vite.config.ts and the repo .env are
// never loaded), `envDir` = an empty temp directory, `root` = apps/web, the probe entry as the only
// input (entry signature preserved, so the whole barrel is bundled), output under TMPDIR.
// Fails (exit 1) when Vite/Rolldown externalizes a Node built-in for the browser, when the bundle
// references node:/bun:/Bun/Buffer/require or a bare import, or when the bundle does not run.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, createLogger } from "vite";

const WEB_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
// Optional argv[2]: another entry (negative control, e.g. a file importing node:crypto).
const ENTRY = process.argv[2]
	? resolve(process.argv[2])
	: fileURLToPath(new URL("./web-safety-entry.ts", import.meta.url));

const work = mkdtempSync(join(tmpdir(), "agentcity-m1-websafety-"));
const envDir = join(work, "empty-env");
const outDir = join(work, "out");
mkdirSync(envDir);

const warnings: string[] = [];
const logger = createLogger("warn", { allowClearScreen: false });
logger.warn = (msg) => {
	warnings.push(msg);
};
logger.warnOnce = (msg) => {
	warnings.push(msg);
};

await build({
	configFile: false,
	root: WEB_ROOT,
	envDir,
	cacheDir: join(work, "vite-cache"),
	mode: "production",
	customLogger: logger,
	logLevel: "warn",
	build: {
		outDir,
		emptyOutDir: true,
		minify: false,
		modulePreload: false,
		copyPublicDir: false,
		rollupOptions: {
			input: ENTRY,
			preserveEntrySignatures: "strict",
			output: { format: "es", entryFileNames: "probe.js" },
			onLog(level, log) {
				if (level === "warn") warnings.push(String(log.message));
			},
		},
	},
});

const files = readdirSync(outDir, { recursive: true, encoding: "utf8" }).filter(
	(f) => f.endsWith(".js"),
);
const problems: string[] = [];
let bytes = 0;
for (const f of files) {
	const src = readFileSync(join(outDir, f), "utf8");
	bytes += src.length;
	const checks: [string, RegExp][] = [
		["node: specifier", /["']node:/],
		["bun: specifier", /["']bun:/],
		["Bun global", /\bBun\./],
		["Buffer global", /\bBuffer\b/],
		["require()", /\brequire\(/],
		["vite browser-external stub", /__vite[-_]browser[-_]external/],
		["bare import", /\bfrom\s*["'](?![./])[^"']+["']/],
	];
	for (const [what, re] of checks)
		if (re.test(src)) problems.push(`${f}: ${what}`);
}
const externalized = warnings.filter((w) =>
	/externali[sz]ed|browser compatibility|node:/i.test(w),
);
for (const w of externalized) problems.push(`warning: ${w.split("\n")[0]}`);

const main = readFileSync(join(outDir, "probe.js"), "utf8");
for (const marker of [
	"agentcity.workspace-api/v1.2",
	"operator:edward",
	"agentcity.result/v1",
])
	if (!main.includes(marker)) problems.push(`bundle lacks marker ${marker}`);

const mod = (await import(pathToFileURL(join(outDir, "probe.js")).href)) as {
	probe?: () => Record<string, unknown>;
	WORKSPACE_API_CONTRACT?: string;
};
let result: Record<string, unknown> | null = null;
try {
	result = mod.probe?.() ?? null;
} catch (err) {
	problems.push(`probe threw: ${(err as Error).message.split("\n")[0]}`);
}
const expected = {
	criteria: ["a, b", "c"],
	phase: "verifying",
	routes: 13, // + the review-repair read routes /task-history and /inbox
	snapshotRejectsEmpty: true,
	decisionRejectsEmpty: true,
};
if (JSON.stringify(result) !== JSON.stringify(expected))
	problems.push(`probe result ${JSON.stringify(result)}`);
if (mod.WORKSPACE_API_CONTRACT !== "agentcity.workspace-api/v1.2")
	problems.push("barrel re-export missing from the bundle's exports");

console.log(
	JSON.stringify(
		{
			ok: problems.length === 0,
			outDir,
			files,
			bytes,
			warnings: warnings.length,
			problems,
			probe: result,
		},
		null,
		2,
	),
);
process.exit(problems.length === 0 ? 0 : 1);
