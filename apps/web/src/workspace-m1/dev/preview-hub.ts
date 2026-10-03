// Local preview of the integrated workspace UI (campus + Headquarters) against a real, isolated hub
// (lead, campus milestone; dev tool). It reuses the browser suites' harness unchanged:
//   - disposable fixture repo + temp SQLite file, fake providers only (simulated), live execution off
//   - hub in workspace mode on a free 127.0.0.1 port (never 4317), Vite on another free loopback port
//     with configFile false and an empty envDir (never apps/web/vite.config.ts or the repo .env)
//   - the per-run synthetic operator credential is written to a 0600 file and never printed
// Ctrl-C (or SIGTERM) stops both servers and removes everything this run created.
//
//   …/iso/run.sh bun --no-env-file apps/web/src/workspace-m1/dev/preview-hub.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface PreviewEnv {
	fx: { dbPath: string };
	repoId: string;
	uiUrl: string;
	hubUrl: string;
	credential: string;
	stop(): Promise<void>;
}
// dynamic import: keeps the Bun-only harness out of apps/web's typecheck (as in hub-kit.ts)
const harnessUrl = new URL("../../../e2e/workspace-harness.ts", import.meta.url)
	.href;
const { startWorkspaceEnv } = (await import(harnessUrl)) as {
	startWorkspaceEnv(): Promise<PreviewEnv>;
};

const env = await startWorkspaceEnv();
const secretDir = mkdtempSync(join(tmpdir(), "agentcity-m1-preview-"));
const credentialFile = join(secretDir, "operator-credential");
writeFileSync(credentialFile, `${env.credential}\n`, { mode: 0o600 });

let stopping = false;
async function shutdown() {
	if (stopping) return;
	stopping = true;
	try {
		await env.stop();
	} finally {
		rmSync(secretDir, { recursive: true, force: true });
		console.log("preview stopped; disposable data removed");
		process.exit(0);
	}
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(
	[
		"Agent City workspace preview (simulated only; disposable data)",
		`  UI (open this):      ${env.uiUrl}`,
		`  hub (loopback):      ${env.hubUrl}`,
		`  repository:          ${env.repoId}`,
		`  database (temp):     ${env.fx.dbPath}`,
		`  operator credential: ${credentialFile} (0600; paste into the sign-in field)`,
		"  approvals: type Edward exactly in each Headquarters document",
		"  Ctrl-C stops the hub and Vite and deletes the fixture, database and credential file",
	].join("\n"),
);
