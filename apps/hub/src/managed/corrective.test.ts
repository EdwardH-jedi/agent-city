// v0.1.1 corrective patch: regressions for five independently reported defects. Everything runs
// against generated stub executables, disposable fixture repos/DBs and synthetic canaries; no real
// provider binary, login or model is involved.
//   C1 an unresolved preflight child stops every later launch (launch boundary + preflight checks)
//   C2 lost or malformed protocol events never permit success
//   C3 unified-diff line prefixes do not defeat multiline secret redaction
//   C4 FIFO evidence / scratch files cannot freeze the hub (probed in separate processes)
//   C5 the artifact API serves only evidence that matches the review-bound manifest
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkCapabilities, checkExecutable } from "./adapters/cli.ts";
import type {
	AdapterContext,
	AdapterSet,
	ImplementationAdapter,
} from "./adapters/types.ts";
import { EMPTY_META } from "./adapters/types.ts";
import { Orchestrator } from "./orchestrator.ts";
import type { RunResult } from "./proc.ts";
import {
	type ManagedDeps,
	runTask,
	ServiceError,
	submitTask,
	taskDetail,
} from "./service.ts";
import { getTask, listQuarantine } from "./store.ts";
import {
	type Fixture,
	type FixtureOptions,
	makeFixture,
	setStubMode,
	stubCalls,
	stubPids,
} from "./testkit.ts";
import { createAdapters } from "./worker.ts";

let fixtures: Fixture[] = [];
const strays: number[] = [];
afterEach(() => {
	for (const pid of strays.splice(0))
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// gone
		}
	for (const f of fixtures) f.cleanup();
	fixtures = [];
});

function live(opts: FixtureOptions = {}) {
	const fx = makeFixture({ liveStubs: {}, ...opts });
	fixtures.push(fx);
	return fx;
}

let seq = 0;
async function submitAndRun(
	fx: Fixture,
	adapters: AdapterSet = createAdapters(fx.config),
) {
	const deps: ManagedDeps = { db: fx.db, config: fx.config };
	const { task } = await submitTask(deps, {
		idempotency_key: `corr-${++seq}-${Date.now()}`,
		repo_id: fx.repoId,
		title: "Corrective task",
		objective: "Corrective patch regression.",
		acceptance_criteria: ["The fixture check passes"],
		approved_scope: ["."],
		execution_mode: fx.config.live.enabled ? "live" : "simulated",
	});
	runTask(deps, task.id);
	const orch = new Orchestrator({
		db: fx.db,
		config: fx.config,
		adapters,
		heartbeatMs: 40,
	});
	while (await orch.tick()) {
		// drain
	}
	return { deps, id: task.id, orch, adapters };
}

/** A settled RunResult for unit checks of the preflight predicates. */
const result = (over: Partial<RunResult>): RunResult => ({
	spawned: true,
	spawnError: null,
	pid: 4242,
	exitCode: 0,
	signal: null,
	timedOut: false,
	aborted: false,
	stdout: "1.0.0\n",
	stderr: "",
	stdoutTruncated: false,
	stderrTruncated: false,
	lineOverflow: false,
	durationMs: 1,
	terminationConfirmed: true,
	unresolved: null,
	unresolvedKind: null,
	pipesClosed: Promise.resolve(),
	...over,
});

const fakeCtx = (r: RunResult, scratchDir: string): AdapterContext => ({
	signal: new AbortController().signal,
	scratchDir,
	maxLogBytes: 4096,
	run: async () => r,
});

// ── C1 ──────────────────────────────────────────────────────────────────────

describe("C1 an unresolved preflight child stops every later provider launch", () => {
	const stages = ["version", "help", "auth"] as const;
	for (const provider of ["claude", "codex"] as const)
		for (const [i, stage] of stages.entries())
			test(`${provider} ${stage} check leaves an escaped descendant → quarantine, zero later launches`, async () => {
				const fx = live();
				setStubMode(fx, provider, `escape_${stage}`);
				const run = await submitAndRun(fx);
				const pids = stubPids(fx, provider);
				if (pids) strays.push(pids[1]);
				expect(pids).not.toBeNull();

				const counts = () => ({
					claude: stubCalls(fx, "claude").length,
					codex: stubCalls(fx, "codex").length,
				});
				// the escaping check is the last thing that provider was ever asked to do; for codex
				// the implementer before it ran normally (version, help, auth, one prompt)
				expect(counts()).toEqual(
					provider === "claude"
						? { claude: i + 1, codex: 0 }
						: { claude: 4, codex: i + 1 },
				);
				const t = getTask(fx.db, run.id);
				expect(t?.state).toBe("interrupted");
				const q = listQuarantine(fx.db, { open: true, taskId: run.id });
				expect(q).toHaveLength(1);
				expect(q[0]?.reason).toContain("[pipe]");

				// retry paths: Run is refused while quarantined; later ticks (this worker and a fresh
				// one) launch nothing
				let refused: unknown = null;
				try {
					runTask(run.deps, run.id);
				} catch (err) {
					refused = err;
				}
				expect(refused).toBeInstanceOf(ServiceError);
				expect((refused as ServiceError).code).toBe("process_quarantined");
				const before = counts();
				await run.orch.tick();
				await new Orchestrator({
					db: fx.db,
					config: fx.config,
					adapters: createAdapters(fx.config),
				}).tick();
				expect(counts()).toEqual(before);
			}, 30_000);

	test("the launch boundary itself refuses every launch after an unresolved child (adapter ignores results)", async () => {
		const fx = makeFixture();
		fixtures.push(fx);
		const marker = (n: string) => join(fx.dir, `launched-${n}`);
		const refusals: (string | null)[] = [];
		let implementCalled = false;
		const escapeScript = `const { spawn } = require("node:child_process");
			const c = spawn("/bin/sleep", ["600"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
			c.unref(); console.log(String(c.pid));`;
		const base = createAdapters(fx.config);
		const implementer: ImplementationAdapter = {
			provider: "fake",
			mode: "simulated",
			model_requested: null,
			// a careless adapter: launches, ignores the unresolved result, launches again
			async preflight(ctx) {
				const r = await ctx.run({
					argv: [process.execPath, "-e", escapeScript],
					cwd: fx.dir,
					env: { PATH: "/usr/bin:/bin" },
					timeoutMs: 10_000,
				});
				const pid = Number(r.stdout.trim());
				if (pid) strays.push(pid);
				const again = await ctx.run({
					argv: ["/usr/bin/touch", marker("preflight")],
					cwd: fx.dir,
					env: { PATH: "/usr/bin:/bin" },
					timeoutMs: 10_000,
				});
				refusals.push(again.spawned ? null : again.spawnError);
				return { ok: true, detail: "ignores every result" };
			},
			async implement(_input, ctx) {
				implementCalled = true;
				await ctx.run({
					argv: ["/usr/bin/touch", marker("implement")],
					cwd: fx.dir,
					env: { PATH: "/usr/bin:/bin" },
					timeoutMs: 10_000,
				});
				return {
					...EMPTY_META,
					ok: false,
					kind: "provider_error",
					detail: "x",
				};
			},
		};
		const adapters: AdapterSet = {
			implementer: () => implementer,
			reviewer: (m) => base.reviewer(m),
		};
		const run = await submitAndRun(fx, adapters);
		expect(existsSync(marker("preflight"))).toBe(false);
		expect(existsSync(marker("implement"))).toBe(false);
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toContain("quarantine");
		expect(implementCalled).toBe(false);
		expect(getTask(fx.db, run.id)?.state).toBe("interrupted");
	}, 30_000);

	test("exit code 0 never overrides an unresolved child in --version / --help checks", async () => {
		const fx = makeFixture();
		fixtures.push(fx);
		const exe = process.execPath;
		for (const bad of [
			{
				unresolved: "the output pipes stayed open",
				unresolvedKind: "pipe" as const,
				terminationConfirmed: false,
			},
			{ terminationConfirmed: false },
			{ aborted: true },
		]) {
			const r = result(bad);
			expect((await checkExecutable(fakeCtx(r, fx.dir), exe, fx.dir)).ok).toBe(
				false,
			);
			expect(
				(
					await checkCapabilities(
						fakeCtx({ ...r, stdout: "  --json\n" }, fx.dir),
						[exe, "--help"],
						["--json"],
						fx.dir,
					)
				).ok,
			).toBe(false);
		}
		// control: a clean result still passes
		expect(
			(await checkExecutable(fakeCtx(result({}), fx.dir), exe, fx.dir)).ok,
		).toBe(true);
	});
});

// ── C2 ──────────────────────────────────────────────────────────────────────

describe("C2 lost or malformed protocol events never permit success", () => {
	const reviewLaunched = (fx: Fixture) =>
		stubCalls(fx, "codex").some(
			(c) => c.argv[0] === "exec" && c.argv.includes("--json"),
		);

	for (const mode of [
		"oversized_then_success",
		"oversized_error_then_success",
		"malformed_then_success",
	])
		test(`claude ${mode} → provider_output_invalid; nothing downstream starts`, async () => {
			const fx = live();
			setStubMode(fx, "claude", mode);
			const run = await submitAndRun(fx);
			const d = await taskDetail(run.deps, run.id);
			expect(d.task.state).not.toBe("human_ready");
			expect(d.task.failure_kind).toBe("provider_output_invalid");
			expect(d.runs[0]?.candidate_sha).toBeNull();
			expect(d.reviews).toHaveLength(0);
			expect(reviewLaunched(fx)).toBe(false);
		}, 30_000);

	for (const mode of ["oversized_failure", "malformed_then_approve"])
		test(`codex ${mode} then a valid approval + exit 0 → no valid review, never human_ready`, async () => {
			const fx = live();
			setStubMode(fx, "codex", mode);
			const run = await submitAndRun(fx);
			const d = await taskDetail(run.deps, run.id);
			expect(reviewLaunched(fx)).toBe(true);
			expect(d.task.state).not.toBe("human_ready");
			expect(d.task.result_run_id).toBeNull();
			expect(d.task.failure_kind).toBe("provider_output_invalid");
			expect(d.reviews.filter((r) => r.valid)).toHaveLength(0);
			expect(d.reviews.some((r) => r.verdict === "approve")).toBe(false);
		}, 30_000);

	test("controls: unknown event types, stderr diagnostics and capped capture still succeed", async () => {
		// default stubs: a split line, stderr noise, an unknown event type, reasoning items
		const fx = live();
		const ok = await submitAndRun(fx);
		expect(getTask(fx.db, ok.id)?.state).toBe("human_ready");
		// ~1.2 MB of valid events with a 4 KiB capture cap: diagnostic truncation, not event loss
		const big = live({ limits: { max_log_bytes: 4096 } });
		setStubMode(big, "claude", "big");
		const bigRun = await submitAndRun(big);
		expect(getTask(big.db, bigRun.id)?.state).toBe("human_ready");
	}, 30_000);
});
