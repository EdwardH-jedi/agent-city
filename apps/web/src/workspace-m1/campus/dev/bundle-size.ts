// Production build of the campus preview to measure the lazy scene chunk (Worker B, dev tool).
//
//   …/iso/run.sh bun --no-env-file apps/web/src/workspace-m1/campus/dev/bundle-size.ts
//
// Never loads apps/web/vite.config.ts or the repo .env: `configFile: false`, an empty envDir, output
// and cache in TMPDIR. Prints every emitted chunk (raw + gzip), which chunk holds the WebGL scene,
// that three.js is bundled exactly once, and every warning Vite/Rolldown reported.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import react from "@vitejs/plugin-react";
import { build, createLogger } from "vite";
import { FIXTURE_DEFINE, WEB_ROOT } from "../../dev/fixture-server.ts";

const outDir = mkdtempSync(join(tmpdir(), "agentcity-campus-build-"));
const envDir = mkdtempSync(join(tmpdir(), "agentcity-campus-build-env-"));
const warnings: string[] = [];
const logger = createLogger("warn");
const baseWarn = logger.warn.bind(logger);
logger.warn = (msg, opts) => {
	warnings.push(msg.split("\n")[0] ?? msg);
	baseWarn(msg, opts);
};

await build({
	configFile: false,
	root: WEB_ROOT,
	envDir,
	mode: "production",
	cacheDir: join(tmpdir(), "agentcity-campus-build-cache"),
	customLogger: logger,
	logLevel: "warn",
	plugins: [react()],
	define: { ...FIXTURE_DEFINE, __AGENTCITY_WORKSPACE_UI__: "true" },
	build: {
		outDir,
		emptyOutDir: true,
		reportCompressedSize: false,
		rollupOptions: {
			input: join(WEB_ROOT, "src/workspace-m1/campus/dev/preview.html"),
		},
	},
});

const assets = join(outDir, "assets");
const rows = readdirSync(assets)
	.filter((f) => f.endsWith(".js") || f.endsWith(".css"))
	.map((f) => {
		const buf = readFileSync(join(assets, f));
		const text = buf.toString("utf8");
		return {
			file: f,
			kb: buf.length / 1024,
			gzipKb: gzipSync(buf).length / 1024,
			scene: /webglcontextlost/.test(text) && /campus/.test(text),
			threeCopies: (text.match(/WebGLRenderer: Context Lost/g) ?? []).length,
		};
	})
	.sort((a, b) => b.kb - a.kb);
for (const r of rows)
	console.log(
		`${r.file.padEnd(40)} ${r.kb.toFixed(1).padStart(8)} kB  gzip ${r.gzipKb.toFixed(1).padStart(7)} kB${r.scene ? "  ← lazy campus scene" : ""}${r.threeCopies ? `  (three.js ×${r.threeCopies})` : ""}`,
	);
const totalThree = rows.reduce((n, r) => n + r.threeCopies, 0);
console.log(`\nthree.js copies across all chunks: ${totalThree}`);
console.log(`warnings (${warnings.length}):`);
for (const w of warnings) console.log(`  ${w}`);
console.log(`output: ${outDir}`);
