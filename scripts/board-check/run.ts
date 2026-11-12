// `bun run check:board [ab1|ab2|ab3|all]` — runs the agent-browser screen checks against
// http://127.0.0.1:4317/ (or AGENTCITY_BOARD_URL, loopback only; a query such as ?scene=town is kept
// and the cases add their own, e.g. demo=1). Read-only: GETs and the D key only; captures go to
// ~/Documents/AgentCityCaptures/ab/ (outside the repo). Needs the `agent-browser` CLI on PATH;
// without it the check is skipped (exit 0) and says so. Nothing is installed by this script.
//   ab1  board at 1920×1080 and 1366×768, live and demo, D round trip   (default)
//   ab2  90 s live observation (needs a built page: vite preview or the hub, not the dev server): GET-only, loopback-only, WebSocket lifecycle
//   ab3  ab1's 1920×1080 cases with WebGL disabled (2D tiles fallback)
//   all  ab1, ab2, ab3 in turn
// Exit 1 if any check is FAIL (KNOWN is an accepted limit, not a failure).
import { join } from "node:path";

const HERE = import.meta.dir;
const SUITES: Record<string, string[]> = {
	ab1: ["board-check.py", "ab1"],
	ab2: ["readonly-check.py"],
	ab3: ["board-check.py", "ab3"],
};

const arg = process.argv[2] ?? "ab1";
const wanted = arg === "all" ? Object.keys(SUITES) : [arg];
if (!wanted.every((name) => name in SUITES)) {
	console.error(`[check:board] unknown suite "${arg}" (ab1 | ab2 | ab3 | all)`);
	process.exit(2);
}

const agentBrowser = Bun.which("agent-browser");
if (!agentBrowser) {
	console.log(
		"[check:board] SKIPPED: agent-browser is not on PATH, so no screen check was run.",
	);
	process.exit(0);
}
const python = Bun.which("python3");
if (!python) {
	console.error("[check:board] python3 is not on PATH; the checks need it");
	process.exit(2);
}

const version = Bun.spawnSync([agentBrowser, "--version"]);
console.log(
	`[check:board] ${version.stdout.toString().trim() || "agent-browser (version unknown)"}`,
);

let failed = 0;
for (const name of wanted) {
	const [script, ...rest] = SUITES[name] as string[];
	console.log(`[check:board] ${name}: ${[script, ...rest].join(" ")}`);
	const run = Bun.spawnSync(
		[python, "-B", join(HERE, script as string), ...rest],
		{ stdout: "inherit", stderr: "inherit" },
	);
	if (run.exitCode !== 0) {
		failed++;
		console.error(`[check:board] ${name}: FAILED (exit ${run.exitCode})`);
	}
}
console.log(
	failed === 0
		? "[check:board] all checks passed"
		: `[check:board] ${failed} suite(s) failed — read the RESULT lines above and report.txt in the capture directory`,
);
process.exit(failed === 0 ? 0 : 1);
