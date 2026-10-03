// biome-ignore-all lint/suspicious/noExplicitAny: adversarial tests inspect raw, untyped HTTP bodies and SQLite rows on purpose
// Five-fix independent reverification at the engine/adapter layer (C1 preflight descendants and the
// common ctx.run launch guard; C2 protocol loss vs capture truncation; C4 Codex scratch reads). M1
// workspace mode forces live off, so these live-adapter behaviours are attacked on the integrated
// orchestrator with MY OWN stub `claude` / `codex` scripts (never the real CLIs; never the testkit
// stub scenarios). C3 / C4-artifact / C5 are attacked through the M1 routes in redaction / gate2-
// evidence. Every escaped descendant started here is killed in afterEach.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	AdapterSet,
	ImplementationAdapter,
} from "../../src/managed/adapters/types.ts";
import { Orchestrator } from "../../src/managed/orchestrator.ts";
import { childEnv } from "../../src/managed/proc.ts";
import { runTask, submitTask } from "../../src/managed/service.ts";
import { getTask, listQuarantine, listRuns } from "../../src/managed/store.ts";
import {
	type Fixture,
	type FixtureOptions,
	makeFixture,
	writeStub,
} from "../../src/managed/testkit.ts";
import { createAdapters } from "../../src/managed/worker.ts";
import { assertIsolation, key } from "./harness.ts";

assertIsolation();
const fixtures: Fixture[] = [];
afterEach(() => {
	for (const fx of fixtures.splice(0)) {
		const pf = join(fx.dir, "bin", "adv.pids");
		if (existsSync(pf))
			for (const p of readFileSync(pf, "utf8")
				.split(/\s+/)
				.filter(Boolean)
				.map(Number)) {
				for (const target of [p, -p])
					try {
						process.kill(target, "SIGKILL");
					} catch {
						// gone
					}
			}
		fx.cleanup();
	}
});
afterAll(() => expect(fixtures.length).toBe(0));

const PRELUDE = `
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = import.meta.dir;
const args = process.argv.slice(2);
const mode = existsSync(join(dir, NAME + ".advmode")) ? readFileSync(join(dir, NAME + ".advmode"), "utf8").trim() : "ok";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const flag = (...names) => { for (const n of names) { const i = args.indexOf(n); if (i >= 0) return args[i + 1]; } return undefined; };
const pid = (p) => appendFileSync(join(dir, "adv.pids"), p + "\\n");
const MAX = 1048576;
const padTo = (o, total) => { const base = JSON.stringify({ ...o, pad: "" }); return JSON.stringify({ ...o, pad: "p".repeat(total - base.length) }); };
const log = (stage) => appendFileSync(join(dir, NAME + ".adv.jsonl"), JSON.stringify({ stage, argv: args }) + "\\n");
// mode "esc:<stage>:<how>" — leave a descendant behind at this stage
const escape = (stage) => {
	const [kind, st, how] = mode.split(":");
	if (kind !== "esc" || st !== stage) return;
	if (how === "stderr") { const c = spawn("/bin/sleep", ["600"], { detached: true, stdio: ["ignore", "ignore", "inherit"] }); c.unref(); pid(c.pid); }
	else if (how === "shell") { const c = spawn("/bin/sh", ["-c", "/bin/sleep 600 & echo $! >> " + join(dir, "adv.pids")], { detached: true, stdio: ["ignore", "inherit", "inherit"] }); c.unref(); pid(c.pid); }
	else if (how === "closed") { const c = spawn("/bin/sleep", ["600"], { detached: true, stdio: "ignore" }); c.unref(); pid(c.pid); }
	else if (how === "samegroup") { const c = spawn("/bin/sleep", ["600"], { stdio: ["ignore", "inherit", "inherit"] }); c.unref(); pid(c.pid); }
};
`;

const CLAUDE = `const NAME = "claude";${PRELUDE}
const stage = args[0] === "--version" ? "version" : args[0] === "--help" ? "help" : args[0] === "auth" ? "auth" : "implement";
log(stage);
if (stage === "version") { escape("version"); console.log("9.9.9 (adv stub)"); process.exit(0); }
if (stage === "help") {
	escape("help");
	console.log("Usage: claude [options]\\n" + ["-p, --print", "--output-format <format>", "--verbose", "--model <model>", "--permission-mode <mode>", "--permission-prompts <target>", "--tools <tools...>", "--allowedTools, --allowed-tools <tools...>", "--json-schema <schema>", "--session-id <uuid>", "-r, --resume [value]", "--safe-mode", "--restricted", "--strict-mcp-config", "--disable-slash-commands"].map((f) => "  " + f).join("\\n"));
	process.exit(0);
}
if (stage === "auth") { escape("auth"); console.log(JSON.stringify({ loggedIn: true, authMethod: "stub-subscription" })); process.exit(0); }
await Bun.stdin.text();
escape("implement");
const session = flag("--session-id", "--resume") ?? "adv-session";
const init = { type: "system", subtype: "init", session_id: session, model: "adv-model" };
const success = { type: "result", subtype: "success", is_error: false, result: "done", session_id: session, structured_output: { contract: "agentcity.implementation/v1", status: "completed", summary: "adv stub change" } };
const failure = { type: "result", subtype: "error_during_execution", is_error: true, result: "the implementation failed", session_id: session };
mkdirSync("agentcity-sim", { recursive: true });
writeFileSync("agentcity-sim/verify.status", "pass\\n");
appendFileSync("adv-change.md", "adv change\\n");
switch (mode) {
	case "c2:oversized_exact": out(init); process.stdout.write(padTo(failure, MAX + 1) + "\\n"); out(success); break;
	case "c2:boundary_ok": out(init); process.stdout.write(padTo({ type: "assistant", message: { content: [{ type: "text", text: "x" }] } }, MAX) + "\\n"); out(success); break;
	case "c2:tail_oversized": out(init); out(success); process.stdout.write(padTo(failure, MAX + 10)); break;
	case "c2:scalar": out(init); process.stdout.write('"the run failed"\\n'); out(success); break;
	case "c2:array": out(init); process.stdout.write(JSON.stringify([failure]) + "\\n"); out(success); break;
	case "c2:many_small": out(init); for (let i = 0; i < 4000; i++) out({ type: "assistant", message: { content: [{ type: "text", text: "y".repeat(100) }] } }); out(success); break;
	default: out(init); out(success);
}
`;

const CODEX = `const NAME = "codex";${PRELUDE}
const stage = args[0] === "--version" ? "version" : args[0] === "exec" && args[1] === "--help" ? "help" : args[0] === "login" ? "auth" : "review";
log(stage);
if (stage === "version") { escape("version"); console.log("codex-cli 0.0.0-adv"); process.exit(0); }
if (stage === "help") { escape("help"); console.log("Usage: codex exec [OPTIONS] [PROMPT]\\n" + ["--json", "-s, --sandbox <MODE>", "-m, --model <MODEL>", "-C, --cd <DIR>", "--ignore-user-config", "--ignore-rules", "--output-schema <FILE>", "-o, --output-last-message <FILE>"].map((f) => "  " + f).join("\\n")); process.exit(0); }
if (stage === "auth") { escape("auth"); console.log("Logged in using ChatGPT (adv stub)"); process.exit(0); }
const stdin = await Bun.stdin.text();
const sha = /- commit: ([0-9a-f]{40})/.exec(stdin)?.[1] ?? "";
const manifest = /- evidence manifest: ([0-9a-f]{64})/.exec(stdin)?.[1] ?? "";
const outFile = flag("--output-last-message", "-o") ?? "";
const verdict = JSON.stringify({ contract: "agentcity.review/v1", audited_sha: sha, manifest_hash: manifest, verdict: "approve", findings: [], tests_executed: false, summary: "adv stub approval" });
out({ type: "thread.started", thread_id: "thread-adv" });
out({ type: "turn.started" });
switch (mode) {
	case "c2:turn_failed_exact":
		process.stdout.write(padTo({ type: "turn.failed", error: { message: "usage limit reached" } }, MAX + 1) + "\\n");
		writeFileSync(outFile, verdict);
		break;
	case "c4:symlink": {
		const outside = join(dir, "outside-verdict.json");
		writeFileSync(outside, verdict);
		rmSync(outFile, { force: true });
		symlinkSync(outside, outFile);
		break;
	}
	case "c4:dir":
		rmSync(outFile, { force: true });
		mkdirSync(outFile);
		break;
	case "c4:oversized":
		writeFileSync(outFile, verdict + " ".repeat(MAX + 10));
		break;
	default:
		writeFileSync(outFile, verdict);
}
out({ type: "item.completed", item: { type: "agent_message", text: verdict } });
out({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
`;

function liveFx(claudeMode = "ok", codexMode = "ok", o: FixtureOptions = {}) {
	const fx = makeFixture({ liveStubs: {}, ...o });
	fixtures.push(fx);
	const bin = join(fx.dir, "bin");
	writeStub(bin, "claude", CLAUDE);
	writeStub(bin, "codex", CODEX);
	writeFileSync(join(bin, "claude.advmode"), claudeMode);
	writeFileSync(join(bin, "codex.advmode"), codexMode);
	return fx;
}

const stages = (fx: Fixture, name: "claude" | "codex") => {
	const f = join(fx.dir, "bin", `${name}.adv.jsonl`);
	return existsSync(f)
		? readFileSync(f, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l).stage as string)
		: [];
};

async function runLive(
	fx: Fixture,
	adapters?: AdapterSet,
	mode: "live" | "simulated" = "live",
) {
	const deps = { db: fx.db, config: fx.config };
	const { task } = await submitTask(deps, {
		idempotency_key: key("fix"),
		repo_id: fx.repoId,
		title: "Five-fix reverification",
		objective: "Drive one execution against adversarial stub providers.",
		acceptance_criteria: ["the fixture check passes"],
		approved_scope: ["."],
		execution_mode: mode,
		...(mode === "simulated" ? { simulation_scenario: "approve" } : {}),
		repair_limit: 0,
	});
	runTask(deps, task.id);
	const orch = new Orchestrator({
		db: fx.db,
		config: fx.config,
		adapters: adapters ?? createAdapters(fx.config),
		heartbeatMs: 50,
	});
	for (let i = 0; i < 20; i++) if (!(await orch.tick())) break;
	await orch.shutdown();
	const t = getTask(fx.db, task.id);
	if (!t) throw new Error("task vanished");
	return {
		t,
		quarantined: listQuarantine(fx.db, { open: true, taskId: t.id }).length,
		runs: listRuns(fx.db, t.id),
	};
}

describe("C1 (spec #3) preflight descendants never permit a later launch — independent variants", () => {
	for (const [stage, how] of [
		["version", "stderr"],
		["help", "stderr"],
		["auth", "stderr"],
		["version", "shell"],
	] as const)
		test(`claude ${stage} check leaves a descendant (${how}) → quarantine, implement never launched`, async () => {
			const fx = liveFx(`esc:${stage}:${how}`);
			const r = await runLive(fx);
			expect(stages(fx, "claude")).not.toContain("implement");
			expect(stages(fx, "codex")).toEqual([]);
			expect(r.quarantined).toBeGreaterThan(0);
			expect(r.t.state).not.toBe("human_ready");
		}, 30_000);

	test("codex login-status check leaves a stderr-holding descendant → review never launched", async () => {
		const fx = liveFx("ok", "esc:auth:stderr");
		const r = await runLive(fx);
		expect(stages(fx, "claude")).toContain("implement");
		expect(stages(fx, "codex")).not.toContain("review");
		expect(r.quarantined).toBeGreaterThan(0);
		expect(r.t.state).not.toBe("human_ready");
	}, 30_000);

	test("an implement run that leaves an escaped descendant → no verification command, no review (common ctx.run guard)", async () => {
		const fx = liveFx("esc:implement:stderr", "ok", {
			verification: [
				{
					name: "marker",
					argv: ["/usr/bin/touch", "verification-ran.marker"],
					timeout_s: 10,
				},
			],
		});
		const r = await runLive(fx);
		expect(stages(fx, "codex")).toEqual([]);
		expect(
			r.runs.some(
				(x) =>
					x.workspace_path &&
					existsSync(join(x.workspace_path, "verification-ran.marker")),
			),
		).toBe(false);
		expect(r.quarantined).toBeGreaterThan(0);
		expect(r.t.state).not.toBe("human_ready");
	}, 30_000);

	test("an adapter that ignores an unresolved child inside implement cannot launch anything else", async () => {
		const fx = makeFixture({
			verification: [
				{
					name: "marker",
					argv: ["/usr/bin/touch", "verification-ran.marker"],
					timeout_s: 10,
				},
			],
		});
		fixtures.push(fx);
		const base = createAdapters(fx.config);
		const touched: (string | null)[] = [];
		const implementer: ImplementationAdapter = {
			...(base.implementer("simulated") as ImplementationAdapter),
			async implement(input, ctx) {
				// a descendant in a NEW process group that keeps only stderr open (outlives the group kill)
				const script = `const c = require("node:child_process").spawn("/bin/sleep", ["600"], { detached: true, stdio: ["ignore", "ignore", "inherit"] }); c.unref(); require("node:fs").appendFileSync(${JSON.stringify(join(fx.dir, "bin", "adv.pids"))}, c.pid + "\\n");`;
				const esc = await ctx.run({
					argv: [process.execPath, "-e", script],
					cwd: input.worktree,
					env: childEnv(),
					timeoutMs: 10_000,
				});
				expect(esc.terminationConfirmed && esc.unresolved === null).toBe(false);
				const again = await ctx.run({
					argv: ["/usr/bin/touch", join(fx.dir, "second-launch.marker")],
					cwd: input.worktree,
					env: childEnv(),
					timeoutMs: 10_000,
				});
				touched.push(again.spawned ? null : (again.spawnError ?? "refused"));
				writeFileSync(join(input.worktree, "change.txt"), "x\n");
				return {
					session_ref: null,
					model_resolved: null,
					usage: null,
					log: "",
					logTruncated: false,
					ok: true as const,
					output: {
						contract: "agentcity.implementation/v1" as const,
						status: "completed" as const,
						summary: "ignores everything",
					},
				};
			},
		};
		require("node:fs").mkdirSync(join(fx.dir, "bin"), { recursive: true });
		const r = await runLive(
			fx,
			{ implementer: () => implementer, reviewer: (m) => base.reviewer(m) },
			"simulated",
		);
		expect(existsSync(join(fx.dir, "second-launch.marker"))).toBe(false);
		expect(touched).toHaveLength(1);
		expect(touched[0]).toContain("quarantine");
		expect(
			r.runs.some(
				(x) =>
					x.workspace_path &&
					existsSync(join(x.workspace_path, "verification-ran.marker")),
			),
		).toBe(false);
		expect(r.t.state).not.toBe("human_ready");
	}, 30_000);

	test("controls: a same-group descendant is killed with the group (settled → proceeds); a descendant holding no pipe escapes detection (known limitation, ADV-OOS-03)", async () => {
		const same = liveFx("esc:version:samegroup");
		const a = await runLive(same);
		expect(stages(same, "claude")).toContain("implement");
		expect(a.quarantined).toBe(0);
		const closed = liveFx("esc:version:closed");
		const b = await runLive(closed);
		// pipe EOF is the only evidence used: an escaped process that closed its pipes is not detected
		const observed = {
			implementLaunched: stages(closed, "claude").includes("implement"),
			quarantined: b.quarantined,
		};
		console.log(
			`[adv C1 limitation] closed-fd escape: ${JSON.stringify(observed)}`,
		);
		expect(observed.implementLaunched).toBe(true);
	}, 60_000);
});

describe("C2 (spec #4) protocol loss fails closed; capture truncation does not — independent variants", () => {
	for (const mode of [
		"c2:oversized_exact",
		"c2:tail_oversized",
		"c2:scalar",
		"c2:array",
	])
		test(`claude ${mode} then an apparent success → provider_output_invalid, nothing downstream`, async () => {
			const fx = liveFx(mode);
			const r = await runLive(fx);
			expect(r.t.state).not.toBe("human_ready");
			expect(r.runs[0]?.failure_kind).toBe("provider_output_invalid");
			expect(stages(fx, "codex")).toEqual([]);
		}, 30_000);

	for (const mode of ["c2:boundary_ok", "c2:many_small"])
		test(`control ${mode}: a record of exactly MAX_LINE_BYTES / capture over the log cap still succeeds`, async () => {
			const fx = liveFx(mode);
			const r = await runLive(fx);
			expect(r.runs[0]?.failure_kind ?? null).toBeNull();
			expect(stages(fx, "codex")).toContain("review");
			expect(r.t.state).toBe("human_ready");
		}, 30_000);

	test("codex turn.failed of exactly MAX_LINE_BYTES+1 then an approving verdict + exit 0 → no valid review", async () => {
		const fx = liveFx("ok", "c2:turn_failed_exact");
		const r = await runLive(fx);
		expect(stages(fx, "codex")).toContain("review");
		expect(r.t.state).not.toBe("human_ready");
		const reviews = fx.db
			.query("SELECT valid FROM managed_reviews WHERE task_id = ?")
			.all(r.t.id) as { valid: number }[];
		expect(reviews.some((x) => x.valid === 1)).toBe(false);
	}, 30_000);
});

describe("C4 (spec #1) Codex scratch reads — independent variants", () => {
	for (const mode of ["c4:symlink", "c4:dir", "c4:oversized"])
		test(`last-message file ${mode} with an approving stream message → refused, never human_ready`, async () => {
			const fx = liveFx("ok", mode);
			const t0 = Date.now();
			const r = await runLive(fx);
			expect(Date.now() - t0).toBeLessThan(25_000);
			expect(r.t.state).not.toBe("human_ready");
			const reviews = fx.db
				.query("SELECT valid FROM managed_reviews WHERE task_id = ?")
				.all(r.t.id) as { valid: number }[];
			expect(reviews.some((x) => x.valid === 1)).toBe(false);
		}, 30_000);
});
