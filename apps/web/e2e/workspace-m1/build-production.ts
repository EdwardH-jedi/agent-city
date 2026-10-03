// Isolated PRODUCTION build of the workspace UI for `campus-recovery.suite.ts` (CI and local).
//
//   bun --no-env-file apps/web/e2e/workspace-m1/build-production.ts <absolute outDir>
//
// Same recipe as the campus-repair verification: installed Vite with configFile:false (so
// apps/web/vite.config.ts — repo-root .env, :4317 proxy — is NOT used), an empty envDir and a cache
// under TMPDIR, the React plugin, and the explicit compile flags of the real-hub workspace UI
// (__AGENTCITY_WORKSPACE_UI__ = true, __AGENTCITY_WORKSPACE_FIXTURE__ = false). The outDir must not
// exist yet (a stale build is never reused). Prints only the outDir and the emitted file count.
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { build } from "vite";

const outDir = process.argv[2] ?? "";
if (!outDir || !isAbsolute(outDir) || existsSync(outDir)) {
	console.error(
		"usage: build-production.ts <absolute outDir that does not exist yet>",
	);
	process.exit(2);
}
const scratch = mkdtempSync(join(tmpdir(), "agentcity-m1-prodbuild-"));
const envDir = join(scratch, "empty-env");
mkdirSync(envDir);
try {
	await build({
		configFile: false,
		root: resolve(import.meta.dir, "../.."),
		envDir,
		cacheDir: join(scratch, "vite-cache"),
		mode: "production",
		logLevel: "warn",
		plugins: [react()],
		define: {
			__AGENTCITY_WORKSPACE_UI__: "true",
			__AGENTCITY_WORKSPACE_FIXTURE__: "false",
		},
		build: { outDir, emptyOutDir: false },
	});
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
const count = (d: string): number =>
	readdirSync(d, { withFileTypes: true }).reduce(
		(n, e) => n + (e.isDirectory() ? count(join(d, e.name)) : 1),
		0,
	);
if (!existsSync(join(outDir, "index.html"))) {
	console.error("build produced no index.html");
	process.exit(1);
}
console.log(
	`[build] workspace production output ${outDir} (${count(outDir)} files)`,
);
