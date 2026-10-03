// Programmatic Vite dev server for the UI fixture page (role 07, dev tool). No hub, no proxy:
// `configFile: false` (apps/web/vite.config.ts and the repo .env are never loaded), `envDir` =
// an empty temp directory, loopback only, a free port ≠ 4317, HMR off, and the fixture switch set
// through `define` exactly as R-N1 prescribes.
//
//   …/iso/run.sh bun --no-env-file apps/web/src/workspace-m1/dev/fixture-server.ts   (manual use)
import { mkdtempSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";

export const WEB_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const DEV_PAGE = "/src/workspace-m1/dev/fixture.html";
export const FIXTURE_DEFINE = { __AGENTCITY_WORKSPACE_FIXTURE__: "true" };

export function freePort(): Promise<number> {
	return new Promise((ok, fail) => {
		const s = createNetServer();
		s.once("error", fail);
		s.listen(0, "127.0.0.1", () => {
			const addr = s.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			s.close(() => ok(port));
		});
	});
}

export async function startFixtureServer(
	opts: { define?: Record<string, string> } = {},
): Promise<{ server: ViteDevServer; origin: string }> {
	const envDir = mkdtempSync(join(tmpdir(), "agentcity-m1-fx-env-"));
	let port = await freePort();
	if (port === 4317) port = await freePort();
	if (port === 4317) throw new Error("refusing port 4317");
	const server = await createServer({
		configFile: false,
		root: WEB_ROOT,
		envDir,
		// dependency cache in TMPDIR, never apps/web/node_modules/.vite
		cacheDir: join(tmpdir(), "agentcity-m1-fx-vite-cache"),
		mode: "development",
		logLevel: "error",
		clearScreen: false,
		plugins: [react()],
		define: opts.define ?? FIXTURE_DEFINE,
		server: { host: "127.0.0.1", port, strictPort: true, hmr: false },
	});
	await server.listen();
	return { server, origin: `http://127.0.0.1:${port}` };
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
	const { origin } = await startFixtureServer();
	console.log(`UI fixture: ${origin}${DEV_PAGE}#/projects (Ctrl+C to stop)`);
}
