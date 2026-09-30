// Fault injection: restart during execution, missing acknowledgements, stale workers, durable
// cancellation with real (stub) child processes, and the "no real model call" guarantee.
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMPLEMENTATION_CONTRACT, type ManagedRun } from "@agent-city/schema";
import { fakeReviewer } from "./adapters/fake.ts";
import {
	type AdapterSet,
	EMPTY_META,
	type ImplementResult,
} from "./adapters/types.ts";
import { parseManagedConfig } from "./config.ts";
import { Orchestrator } from "./orchestrator.ts";
import { processStarted } from "./proc.ts";
import {
	cancelTask,
	type ManagedDeps,
	runTask,
	submitTask,
	taskDetail,
} from "./service.ts";
import {
	getRun,
	getTask,
	patchRun,
	renewLease,
	StaleLeaseError,
	seize,
	withFence,
} from "./store.ts";
import {
	type Fixture,
	type FixtureOptions,
	makeFixture,
	pidAlive,
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
			process.kill(-pid, "SIGKILL");
		} catch {
			// already gone
		}
	for (const f of fixtures) f.cleanup();
	fixtures = [];
});

/** A clock far enough ahead that every lease taken "now" has expired. */
const later = () => new Date(Date.now() + 10 * 60_000);

let seq = 0;
function setup(opts: FixtureOptions = {}) {
	const fx = makeFixture(opts);
	fixtures.push(fx);
	const deps: ManagedDeps = { db: fx.db, config: fx.config };
	const worker = (o: { now?: () => Date; adapters?: AdapterSet } = {}) =>
		new Orchestrator({
			db: fx.db,
			config: fx.config,
			adapters: o.adapters ?? createAdapters(fx.config),
			heartbeatMs: 40,
			now: o.now,
		});
	const submit = async (over: Record<string, unknown> = {}) => {
		const { task } = await submitTask(deps, {
			idempotency_key: `recovery-${++seq}-${Date.now()}`,
			repo_id: fx.repoId,
			title: "Recovery test task",
			objective: "Exercise recovery paths.",
			acceptance_criteria: ["The fixture check passes"],
			approved_scope: ["."],
			execution_mode: opts.liveStubs ? "live" : "simulated",
			...over,
		});
		runTask(deps, task.id);
		return task.id;
	};
	const currentRun = (id: string): ManagedRun | null => {
		const t = getTask(fx.db, id);
		return t?.current_run_id ? getRun(fx.db, t.current_run_id) : null;
	};
	const until = async (cond: () => boolean, what: string) => {
		const deadline = Date.now() + 10_000;
		while (!cond()) {
			if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
			await Bun.sleep(15);
		}
	};
	const drain = async (o: Orchestrator) => {
		while (await o.tick()) {
			// drain
		}
	};
	return { fx, deps, worker, submit, currentRun, until, drain };
}

const promptCalls = (fx: Fixture) =>
	stubCalls(fx, "claude").filter((c) => c.argv.includes("-p")).length;

describe("restart during execution", () => {
	test("hub stops mid-implementation → interrupted, never re-run automatically; a person can run it again", async () => {
		const s = setup({ liveStubs: {} });
		setStubMode(s.fx, "claude", "hang");
		const id = await s.submit();

		// worker A starts the implementer, then the hub "stops"
		const a = s.worker();
		const tickA = a.tick();
		await s.until(
			() => stubPids(s.fx, "claude") !== null,
			"implementer started",
		);
		const pids = stubPids(s.fx, "claude") ?? [];
		await a.shutdown();
		await tickA;
		for (const pid of pids) expect(pidAlive(pid)).toBe(false);

		// what the crash left behind: still "executing", launch intent recorded, no result
		const left = getTask(s.fx.db, id);
		expect(left?.state).toBe("executing");
		expect(left?.lease_owner).toBe(a.workerId);
		expect(s.currentRun(id)).toMatchObject({
			state: "running",
			proc_phase: "implement",
			candidate_sha: null,
		});
		expect(promptCalls(s.fx)).toBe(1);

		// a new worker before the lease expired: hands off
		const early = s.worker();
		expect(await early.tick()).toBe(false);
		expect(getTask(s.fx.db, id)?.state).toBe("executing");

		// after expiry: reconciled to interrupted; the model stage is NOT launched again
		setStubMode(s.fx, "claude", "success");
		const b = s.worker({ now: later });
		await s.drain(b);
		const t = getTask(s.fx.db, id);
		expect(t).toMatchObject({
			state: "interrupted",
			failure_kind: "interrupted",
			lease_owner: null,
		});
		expect(t?.state_detail).toContain("not re-run automatically");
		expect(s.currentRun(id)).toMatchObject({
			state: "unknown",
			failure_kind: "interrupted",
		});
		await s.drain(b);
		expect(promptCalls(s.fx)).toBe(1);

		// explicit human Run → a fresh attempt in a fresh worktree
		expect(runTask(s.deps, id).queued).toBe(true);
		await s.drain(s.worker());
		const d = await taskDetail(s.deps, id);
		expect(d.task.state).toBe("human_ready");
		expect(d.runs.map((r) => [r.attempt_no, r.kind, r.state])).toEqual([
			[1, "initial", "unknown"],
			[2, "rerun", "finished"],
		]);
		expect(d.runs[1]?.workspace_path).not.toBe(d.runs[0]?.workspace_path ?? "");
		expect(existsSync(d.runs[0]?.workspace_path ?? "")).toBe(true); // preserved for inspection
		expect(promptCalls(s.fx)).toBe(2);
	});

	test("an orphaned child that survived the crash is terminated — only if it is still that process", async () => {
		const s = setup({ liveStubs: {} });
		setStubMode(s.fx, "claude", "hang");
		const id = await s.submit();
		const a = s.worker();
		const tickA = a.tick();
		await s.until(
			() => stubPids(s.fx, "claude") !== null,
			"implementer started",
		);
		await a.shutdown();
		await tickA;

		// pretend the recorded child outlived the hub: an independent process group
		const orphan = spawn("/bin/sleep", ["600"], {
			detached: true,
			stdio: "ignore",
		});
		orphan.unref();
		const pid = orphan.pid as number;
		strays.push(pid);
		const run = s.currentRun(id) as ManagedRun;

		// same pid but a different start time = a recycled pid → left alone
		patchRun(s.fx.db, run.id, {
			child_pid: pid,
			child_started: "Thu  1 Jan 00:00:00 1970",
		});
		await s.worker({ now: later }).reconcile();
		expect(pidAlive(pid)).toBe(true);
		expect(getTask(s.fx.db, id)?.state).toBe("interrupted");

		// identity matches → killed and confirmed
		const s2 = setup({ liveStubs: {} });
		setStubMode(s2.fx, "claude", "hang");
		const id2 = await s2.submit();
		const a2 = s2.worker();
		const tick2 = a2.tick();
		await s2.until(
			() => stubPids(s2.fx, "claude") !== null,
			"implementer started",
		);
		await a2.shutdown();
		await tick2;
		patchRun(s2.fx.db, (s2.currentRun(id2) as ManagedRun).id, {
			child_pid: pid,
			child_started: processStarted(pid),
		});
		await s2.worker({ now: later }).reconcile();
		expect(pidAlive(pid)).toBe(false);
		expect(getTask(s2.fx.db, id2)?.state).toBe("interrupted");
		expect(s2.currentRun(id2)?.child_pid).toBeNull();
	});

	test("hub stops during verification (no model launched) → resumed, bounded, implementer not re-run", async () => {
		const gate = join(tmpdir(), `agentcity-gate-${process.pid}-${Date.now()}`);
		const s = setup({
			verification: [
				{
					name: "gated",
					argv: ["/bin/sh", "-c", `[ -f "${gate}" ] || sleep 600`],
					timeout_s: 60,
				},
			],
		});
		try {
			const id = await s.submit({ simulation_scenario: "approve" });
			const a = s.worker();
			const tickA = a.tick();
			await s.until(
				() =>
					s.currentRun(id)?.proc_phase === "verify" &&
					!!s.currentRun(id)?.child_pid,
				"verification started",
			);
			const candidate = s.currentRun(id)?.candidate_sha;
			await a.shutdown();
			await tickA;
			expect(getTask(s.fx.db, id)?.state).toBe("verifying");

			// first reconcile: released for retry (not interrupted), counted
			writeFileSync(gate, "");
			const b = s.worker({ now: later });
			await b.reconcile();
			expect(getTask(s.fx.db, id)).toMatchObject({
				state: "verifying",
				lease_owner: null,
				infra_retries: 1,
			});
			await s.drain(s.worker());
			const d = await taskDetail(s.deps, id);
			expect(d.task.state).toBe("human_ready");
			expect(d.runs).toHaveLength(1); // same attempt, same candidate
			expect(d.runs[0]?.candidate_sha).toBe(candidate ?? "");
		} finally {
			writeFileSync(gate, "");
		}
	});

	test("the automatic retry is bounded", async () => {
		const s = setup();
		const id = await s.submit({ simulation_scenario: "approve" });
		// a worker claimed the queued task and died before doing anything, three times over
		for (let i = 0; i < 3; i++) {
			s.fx.db.run(
				"UPDATE managed_tasks SET lease_owner = 'dead-worker', lease_until = '2000-01-01T00:00:00.000Z' WHERE id = ?",
				[id],
			);
			await s.worker().reconcile();
		}
		expect(getTask(s.fx.db, id)).toMatchObject({
			state: "blocked",
			failure_kind: "workspace_error",
			infra_retries: 2,
			lease_owner: null,
		});
	});
});

describe("stale worker", () => {
	test("fence: an old token can neither write nor renew", async () => {
		const s = setup();
		const id = await s.submit();
		const task = getTask(s.fx.db, id);
		if (!task) throw new Error("no task");
		const old = task.fence_token;
		const until = new Date(Date.now() + 60_000).toISOString();
		expect(seize(s.fx.db, task, "other-worker", until)).not.toBeNull(); // someone else took it
		expect(() => withFence(s.fx.db, id, old, () => {})).toThrow(
			StaleLeaseError,
		);
		expect(renewLease(s.fx.db, id, old, new Date().toISOString())).toBe(false);
		// a snapshot that is out of date cannot take over either
		expect(seize(s.fx.db, task, "third-worker", until)).toBeNull();
	});

	test("a worker whose lease was taken over cannot complete late: its result is discarded", async () => {
		const s = setup();
		let release: (r: ImplementResult) => void = () => {};
		const gate = new Promise<ImplementResult>((r) => {
			release = r;
		});
		let started = false;
		const slow: AdapterSet = {
			reviewer: () => fakeReviewer,
			implementer: () => ({
				provider: "fake",
				mode: "simulated",
				model_requested: null,
				preflight: async () => ({ ok: true, detail: "test" }),
				implement: async ({ worktree }) => {
					started = true;
					const r = await gate;
					mkdirSync(join(worktree, "agentcity-sim"), { recursive: true });
					writeFileSync(
						join(worktree, "agentcity-sim", "verify.status"),
						"pass\n",
					);
					return r;
				},
			}),
		};
		const id = await s.submit();
		const a = s.worker({ adapters: slow });
		const tickA = a.tick();
		await s.until(() => started, "implementer started");

		// lease expires; worker B reconciles and takes the task away
		await s.worker({ now: later }).reconcile();
		const afterTakeover = getTask(s.fx.db, id);
		expect(afterTakeover?.state).toBe("interrupted");

		// A's implementer now "succeeds" — far too late
		release({
			...EMPTY_META,
			ok: true,
			output: {
				contract: IMPLEMENTATION_CONTRACT,
				status: "completed",
				summary: "late",
			},
		});
		await tickA;

		const t = getTask(s.fx.db, id);
		expect(t?.state).toBe("interrupted");
		expect(t?.rev).toBe(afterTakeover?.rev ?? -1); // A wrote nothing
		expect(s.currentRun(id)).toMatchObject({
			state: "unknown",
			candidate_sha: null,
		});
		expect((await taskDetail(s.deps, id)).artifacts).toHaveLength(0);
	});

	test("a takeover while the child is still running stops that child", async () => {
		const s = setup({ liveStubs: {} });
		setStubMode(s.fx, "claude", "hang");
		const id = await s.submit();
		const a = s.worker();
		const tickA = a.tick();
		await s.until(
			() => stubPids(s.fx, "claude") !== null,
			"implementer started",
		);
		const pids = stubPids(s.fx, "claude") ?? [];

		// B takes over while A is alive (e.g. A was frozen past its lease)
		await s.worker({ now: later }).reconcile();
		await tickA; // A notices on its next heartbeat and stops
		for (const pid of pids) expect(pidAlive(pid)).toBe(false);
		expect(getTask(s.fx.db, id)?.state).toBe("interrupted");
	});
});

describe("cancellation", () => {
	test("before any work: cancelled at once, idempotent, cannot be run again", async () => {
		const s = setup();
		const id = await s.submit();
		expect(getTask(s.fx.db, id)?.state).toBe("queued");
		const first = cancelTask(s.deps, id);
		expect(first).toMatchObject({
			state: "cancelled",
			failure_kind: "cancelled",
		});
		expect(first.cancel_requested_at).not.toBeNull();
		const again = cancelTask(s.deps, id);
		expect(again.rev).toBe(first.rev);
		expect(runTask(s.deps, id).queued).toBe(false);
		expect(await s.worker().tick()).toBe(false);
	});

	test("while a child runs: intent is persisted, the owned process group is terminated, then cancelled", async () => {
		const s = setup({ liveStubs: {} });
		setStubMode(s.fx, "claude", "hang_ignore_term"); // needs the SIGKILL escalation
		const id = await s.submit();
		const a = s.worker();
		const tickA = a.tick();
		await s.until(
			() => stubPids(s.fx, "claude") !== null,
			"implementer started",
		);
		const pids = stubPids(s.fx, "claude") ?? [];
		expect(pids).toHaveLength(2);
		for (const pid of pids) expect(pidAlive(pid)).toBe(true);

		const requested = cancelTask(s.deps, id);
		// not "cancelled" yet: only the intent is recorded while the process is alive
		expect(requested.state).toBe("executing");
		expect(requested.cancel_requested_at).not.toBeNull();

		await tickA;
		for (const pid of pids) expect(pidAlive(pid)).toBe(false);
		const d = await taskDetail(s.deps, id);
		expect(d.task).toMatchObject({
			state: "cancelled",
			failure_kind: "cancelled",
			lease_owner: null,
		});
		expect(d.task.state_detail).toContain("confirmed terminated");
		expect(d.runs[0]).toMatchObject({ state: "cancelled", child_pid: null });
		expect(d.reviews).toHaveLength(0);
		expect(cancelTask(s.deps, id).rev).toBe(d.task.rev); // idempotent
	});

	test("simulated implementer that hangs is cancellable too", async () => {
		const s = setup();
		const id = await s.submit({ simulation_scenario: "impl_hangs" });
		const a = s.worker();
		const tickA = a.tick();
		await s.until(() => !!s.currentRun(id)?.child_pid, "child recorded");
		const pid = s.currentRun(id)?.child_pid as number;
		expect(pidAlive(pid)).toBe(true);
		cancelTask(s.deps, id);
		await tickA;
		expect(pidAlive(pid)).toBe(false);
		expect(getTask(s.fx.db, id)?.state).toBe("cancelled");
	});

	test("cancel requested while no worker is alive survives the restart", async () => {
		const s = setup({ liveStubs: {} });
		setStubMode(s.fx, "claude", "hang");
		const id = await s.submit();
		const a = s.worker();
		const tickA = a.tick();
		await s.until(
			() => stubPids(s.fx, "claude") !== null,
			"implementer started",
		);
		await a.shutdown();
		await tickA;

		expect(cancelTask(s.deps, id).state).toBe("executing"); // hub "down": intent only
		await s.worker({ now: later }).reconcile();
		expect(getTask(s.fx.db, id)).toMatchObject({
			state: "cancelled",
			failure_kind: "cancelled",
		});
		expect(s.currentRun(id)?.state).toBe("cancelled");
	});
});

describe("default development and test paths make zero real model calls", () => {
	test("default config builds no CLI adapter at all", () => {
		const s = setup();
		const adapters = createAdapters(s.fx.config);
		expect(s.fx.config.live.enabled).toBe(false);
		expect(adapters.implementer("live")).toBeNull();
		expect(adapters.reviewer("live")).toBeNull();
		expect(adapters.implementer("simulated")?.provider).toBe("fake");
		expect(adapters.reviewer("simulated")?.mode).toBe("simulated");
	});

	test("provider blocks without the master switch stay off", () => {
		const s = setup({
			live: {
				enabled: false,
				claude: { executable: "/usr/bin/false", model: "m" },
				codex: { executable: "/usr/bin/false", model: "m" },
			},
		});
		expect(createAdapters(s.fx.config).implementer("live")).toBeNull();
	});

	test("a full simulated run never executes `claude` or `codex`, even when they are first on PATH", async () => {
		const s = setup();
		const trap = join(s.fx.dir, "trap-bin");
		const marker = join(s.fx.dir, "MODEL-CLI-WAS-CALLED");
		mkdirSync(trap);
		for (const name of ["claude", "codex"]) {
			writeFileSync(
				join(trap, name),
				`#!/bin/sh\necho "$0 $@" >> "${marker}"\n`,
			);
			chmodSync(join(trap, name), 0o755);
		}
		const savedPath = process.env.PATH;
		process.env.PATH = `${trap}:${savedPath ?? ""}`;
		try {
			for (const scenario of [
				"approve",
				"reject_then_approve",
				"reject_always",
			]) {
				const id = await s.submit({ simulation_scenario: scenario });
				await s.drain(s.worker());
				expect(getTask(s.fx.db, id)?.execution_mode).toBe("simulated");
			}
		} finally {
			process.env.PATH = savedPath;
		}
		expect(existsSync(marker)).toBe(false);
	});

	test("the example config is valid and ships with live execution off", async () => {
		const text = await Bun.file(
			join(import.meta.dir, "../../../../config/managed.example.yaml"),
		).text();
		const cfg = parseManagedConfig(Bun.YAML.parse(text));
		expect(cfg.live).toEqual({ enabled: false });
		expect(createAdapters(cfg).implementer("live")).toBeNull();
		expect(cfg.repos[0]?.verification[0]?.argv[0]).toMatch(/^\//);
	});

	test("no package script invokes a model", async () => {
		const pkg = (await Bun.file(
			join(import.meta.dir, "../../../../package.json"),
		).json()) as { scripts: Record<string, string> };
		for (const [name, cmd] of Object.entries(pkg.scripts)) {
			expect(`${name}: ${cmd}`).not.toMatch(
				/claude\s+(-p|--print)|codex\s+exec/,
			);
		}
	});
});
