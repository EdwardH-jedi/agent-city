// v0.1.1 Priority 1: lifecycle and evidence must fail closed.
//   P1.1 unresolved child processes are quarantined persistently
//   P1.2 approval is revalidated before every resumed stage
//   P1.3 cancellation has a defined ordering with completion
//   P1.4 reviews and artifact views are bound to the exact stored bytes
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
	readFileSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedRun } from "@agent-city/schema";
import { fakeImplementer, fakeReviewer } from "./adapters/fake.ts";
import type { AdapterSet, ReviewAdapter } from "./adapters/types.ts";
import { type ManagedConfig, parseManagedConfig } from "./config.ts";
import { Orchestrator, type OrchestratorHooks } from "./orchestrator.ts";
import { hostProcessOps, type ProcessOps, processStarted } from "./proc.ts";
import {
	cancelTask,
	type ManagedDeps,
	readTaskArtifact,
	runTask,
	ServiceError,
	submitTask,
	taskDetail,
} from "./service.ts";
import {
	getRun,
	getTask,
	listArtifacts,
	listQuarantine,
	patchRun,
	seize,
} from "./store.ts";
import {
	type Fixture,
	type FixtureOptions,
	makeFixture,
	pidAlive,
} from "./testkit.ts";
import { createAdapters } from "./worker.ts";

let fixtures: Fixture[] = [];
const strays: number[] = [];
const gates: string[] = [];
afterEach(() => {
	for (const g of gates.splice(0)) rmSync(g, { force: true });
	for (const pid of strays.splice(0))
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// gone
		}
	for (const f of fixtures) f.cleanup();
	fixtures = [];
});

const later = () => new Date(Date.now() + 10 * 60_000);

/** A promise that the test releases by hand: a deterministic boundary, not a sleep. */
function deferred() {
	let release: () => void = () => {};
	const promise = new Promise<void>((r) => {
		release = r;
	});
	return { promise, release };
}

let seq = 0;
function setup(opts: FixtureOptions = {}) {
	const fx = makeFixture(opts);
	fixtures.push(fx);
	const deps: ManagedDeps = { db: fx.db, config: fx.config };
	const worker = (
		o: {
			now?: () => Date;
			adapters?: AdapterSet;
			config?: ManagedConfig;
			processOps?: ProcessOps;
			hooks?: OrchestratorHooks;
		} = {},
	) =>
		new Orchestrator({
			db: fx.db,
			config: o.config ?? fx.config,
			adapters: o.adapters ?? createAdapters(o.config ?? fx.config),
			heartbeatMs: 40,
			now: o.now,
			processOps: o.processOps,
			hooks: o.hooks,
		});
	const submit = async (over: Record<string, unknown> = {}) => {
		const { task } = await submitTask(deps, {
			idempotency_key: `hardening-${++seq}-${Date.now()}`,
			repo_id: fx.repoId,
			title: "Hardening task",
			objective: "Exercise fail-closed paths.",
			acceptance_criteria: ["The fixture check passes"],
			approved_scope: ["."],
			execution_mode: "simulated",
			simulation_scenario: "approve",
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
			await Bun.sleep(10);
		}
	};
	const drain = async (o: Orchestrator) => {
		while (await o.tick()) {
			// drain
		}
	};
	return { fx, deps, worker, submit, currentRun, until, drain };
}

const code = (fn: () => unknown) => {
	try {
		fn();
	} catch (err) {
		if (err instanceof ServiceError) return `${err.status} ${err.code}`;
		throw err;
	}
	return "ok";
};

/** An independent long-running process group standing in for an orphaned child. */
function orphan(): number {
	const child = spawn("/bin/sleep", ["600"], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	const pid = child.pid as number;
	strays.push(pid);
	return pid;
}

/** Process ops whose kill never takes effect (the "unconfirmed termination" case). */
const unkillable: ProcessOps = {
	...hostProcessOps,
	terminateGroup: async () => false,
};

// ── P1.1 ────────────────────────────────────────────────────────────────────

describe("P1.1 unresolved child processes are quarantined", () => {
	/** Leaves task `id` interrupted with an open quarantine on a live process `pid`. */
	async function quarantined(s: ReturnType<typeof setup>) {
		const id = await s.submit({ simulation_scenario: "impl_hangs" });
		const a = s.worker();
		const tickA = a.tick();
		await s.until(() => !!s.currentRun(id)?.child_pid, "child recorded");
		await a.shutdown();
		await tickA;
		const pid = orphan();
		patchRun(s.fx.db, (s.currentRun(id) as ManagedRun).id, {
			child_pid: pid,
			child_started: processStarted(pid),
		});
		await s.worker({ now: later, processOps: unkillable }).reconcile();
		return { id, pid };
	}

	test("termination not confirmed → interrupted + open quarantine, child pid retained", async () => {
		const s = setup();
		const { id, pid } = await quarantined(s);
		const t = getTask(s.fx.db, id);
		expect(t).toMatchObject({ state: "interrupted", lease_owner: null });
		expect(s.currentRun(id)).toMatchObject({
			state: "unknown",
			child_pid: pid,
		});
		const q = listQuarantine(s.fx.db, { open: true });
		expect(q).toHaveLength(1);
		expect(q[0]).toMatchObject({ task_id: id, pid, released_at: null });
		expect(pidAlive(pid)).toBe(true);
	});

	test("Cancel does not pretend: the task stays interrupted with the intent recorded", async () => {
		const s = setup();
		const { id } = await quarantined(s);
		const after = cancelTask(s.deps, id);
		expect(after.state).toBe("interrupted");
		expect(after.cancel_requested_at).not.toBeNull();
		expect(listQuarantine(s.fx.db, { open: true })).toHaveLength(1);
	});

	test("Run (also after Cancel) is refused while the process is unresolved", async () => {
		const s = setup();
		const { id } = await quarantined(s);
		expect(code(() => runTask(s.deps, id))).toBe("409 process_quarantined");
		cancelTask(s.deps, id);
		expect(code(() => runTask(s.deps, id))).toBe("409 process_quarantined");
		expect(getTask(s.fx.db, id)?.state).toBe("interrupted");
	});

	test("no other task is claimed while a quarantine is open (single-worker policy), across a restart", async () => {
		const s = setup({ dbFile: true });
		const { id } = await quarantined(s);
		const other = await s.submit();
		const w = s.worker({ processOps: unkillable });
		expect(await w.tick()).toBe(false);
		expect(getTask(s.fx.db, other)?.state).toBe("queued");
		expect(s.currentRun(other)).toBeNull();
		// restart: a new hub process on the same DB file still refuses
		const reopened = s.worker({ processOps: unkillable });
		expect(await reopened.tick()).toBe(false);
		expect(listQuarantine(s.fx.db, { open: true })[0]?.task_id).toBe(id);
	});

	test("an inspection failure is not evidence of absence", async () => {
		const s = setup();
		const { pid } = await quarantined(s);
		const blind: ProcessOps = {
			...unkillable,
			inspect: () => ({ state: "error", error: "ps could not run" }),
			groupAlive: () => "error",
		};
		await s.worker({ processOps: blind }).tick();
		const q = listQuarantine(s.fx.db, { open: true });
		expect(q).toHaveLength(1);
		expect(q[0]?.last_check).toContain("inspection failed");
		expect(pidAlive(pid)).toBe(true);
	});

	test("an unrecorded identity cannot be verified: stays quarantined, nothing is signalled", async () => {
		const s = setup();
		const { id, pid } = await quarantined(s);
		s.fx.db.run(
			"UPDATE managed_quarantine SET started = NULL WHERE task_id = ?",
			[id],
		);
		await s.worker({ processOps: hostProcessOps }).tick();
		expect(listQuarantine(s.fx.db, { open: true })).toHaveLength(1);
		expect(pidAlive(pid)).toBe(true);
	});

	test("a recycled pid (different start time) is never signalled; the original group is provably gone", async () => {
		const s = setup();
		const { id, pid } = await quarantined(s);
		s.fx.db.run(
			"UPDATE managed_quarantine SET started = 'Thu  1 Jan 00:00:00 1970' WHERE task_id = ?",
			[id],
		);
		await s.worker({ processOps: hostProcessOps }).tick();
		expect(pidAlive(pid)).toBe(true); // not ours: untouched
		const q = listQuarantine(s.fx.db, {});
		expect(q[0]?.released_at).not.toBeNull();
		expect(q[0]?.release_evidence).toContain("recycled");
	});

	test("objective evidence releases it: then the pending cancel completes and the queue moves", async () => {
		const s = setup();
		const { id, pid } = await quarantined(s);
		cancelTask(s.deps, id);
		const other = await s.submit();
		// the owned group really terminates (here: by the host ops on the next check)
		await s.drain(s.worker({ processOps: hostProcessOps }));
		expect(pidAlive(pid)).toBe(false);
		const q = listQuarantine(s.fx.db, {});
		expect(q[0]?.released_at).not.toBeNull();
		expect(q[0]?.release_evidence).toMatch(/terminated|gone/);
		expect(getTask(s.fx.db, id)).toMatchObject({
			state: "cancelled",
			failure_kind: "cancelled",
		});
		expect(getTask(s.fx.db, other)?.state).toBe("human_ready");
	});

	test("a child whose termination is unconfirmed during a live stage is quarantined at once", async () => {
		const s = setup();
		const id = await s.submit({ simulation_scenario: "impl_hangs" });
		const a = s.worker({ processOps: unkillable });
		const tickA = a.tick();
		await s.until(() => !!s.currentRun(id)?.child_pid, "child recorded");
		const pid = s.currentRun(id)?.child_pid as number;
		strays.push(pid);
		cancelTask(s.deps, id);
		await tickA;
		expect(getTask(s.fx.db, id)?.state).toBe("interrupted");
		expect(listQuarantine(s.fx.db, { open: true })[0]).toMatchObject({
			task_id: id,
			pid,
		});
	});
});

// ── P1.2 ────────────────────────────────────────────────────────────────────

/** Same fixture repo, different verification command (a policy change after approval). */
function withVerification(cfg: ManagedConfig, argv: string[]): ManagedConfig {
	const repo = cfg.repos[0];
	if (!repo) throw new Error("no repo");
	return parseManagedConfig({
		...cfg,
		repos: [
			{ ...repo, verification: [{ name: "changed", argv, timeout_s: 30 }] },
		],
	});
}

describe("P1.2 approval is revalidated before every resumed stage", () => {
	async function crashDuringVerification(
		s: ReturnType<typeof setup>,
		gate: string,
	) {
		const id = await s.submit();
		const a = s.worker();
		const tickA = a.tick();
		await s.until(
			() =>
				s.currentRun(id)?.proc_phase === "verify" &&
				!!s.currentRun(id)?.child_pid,
			"verification started",
		);
		await a.shutdown();
		await tickA;
		writeFileSync(gate, "");
		expect(getTask(s.fx.db, id)?.state).toBe("verifying");
		return id;
	}

	const gated = (gate: string) => ({
		verification: [
			{
				name: "gated",
				argv: ["/bin/sh", "-c", `[ -f "${gate}" ] || sleep 600`],
				timeout_s: 60,
			},
		],
	});

	test("changed verification command after a restart → blocked before the new command runs", async () => {
		const gate = join(tmpdir(), `agentcity-gate-${process.pid}-${++seq}`);
		gates.push(gate);
		const s = setup(gated(gate));
		const id = await crashDuringVerification(s, gate);
		const marker = join(s.fx.dir, "NEW-COMMAND-RAN");
		const changed = withVerification(s.fx.config, [
			"/bin/sh",
			"-c",
			`echo ran > "${marker}"`,
		]);
		await s.drain(s.worker({ now: later, config: changed }));
		await s.drain(s.worker({ config: changed }));
		expect(getTask(s.fx.db, id)).toMatchObject({
			state: "blocked",
			failure_kind: "approval_void",
		});
		expect(() => readFileSync(marker)).toThrow();
	});

	test("unchanged configuration resumes the same deterministic step", async () => {
		const gate = join(tmpdir(), `agentcity-gate-${process.pid}-${++seq}`);
		gates.push(gate);
		const s = setup(gated(gate));
		const id = await crashDuringVerification(s, gate);
		await s.drain(s.worker({ now: later }));
		await s.drain(s.worker());
		expect(getTask(s.fx.db, id)?.state).toBe("human_ready");
	});

	test("a resumed review with a changed policy is blocked before the reviewer is called", async () => {
		const s = setup();
		const gate = deferred();
		let reviewerCalls = 0;
		const slowReviewer: ReviewAdapter = {
			...fakeReviewer,
			preflight: async () => {
				await gate.promise;
				return { ok: true, detail: "test" };
			},
			review: async (input, ctx) => {
				reviewerCalls++;
				return fakeReviewer.review(input, ctx);
			},
		};
		const adapters: AdapterSet = {
			implementer: () => fakeImplementer,
			reviewer: () => slowReviewer,
		};
		const id = await s.submit();
		const a = s.worker({ adapters });
		const tickA = a.tick();
		await s.until(
			() => getTask(s.fx.db, id)?.state === "reviewing",
			"reviewing",
		);
		const stopping = a.shutdown();
		gate.release();
		await stopping;
		await tickA;
		const changed = parseManagedConfig({
			...s.fx.config,
			limits: { ...s.fx.config.limits, max_log_bytes: 9_999 },
		});
		await s.drain(s.worker({ now: later, config: changed, adapters }));
		await s.drain(s.worker({ config: changed, adapters }));
		expect(getTask(s.fx.db, id)).toMatchObject({
			state: "blocked",
			failure_kind: "approval_void",
		});
		expect(reviewerCalls).toBe(0);
	});

	test("the orchestrator works from an immutable snapshot of its config", async () => {
		const s = setup();
		const cfg = structuredClone(s.fx.config) as ManagedConfig;
		const w = s.worker({ config: cfg });
		(cfg.repos[0] as { verification: unknown[] }).verification = [];
		const id = await s.submit();
		await s.drain(w);
		expect(getTask(s.fx.db, id)?.state).toBe("human_ready");
	});
});

// ── P1.3 ────────────────────────────────────────────────────────────────────

describe("P1.3 cancellation vs completion", () => {
	test("Cancel acknowledged during the final integrity await wins over human_ready", async () => {
		const s = setup();
		const gate = deferred();
		const reached = deferred();
		const hooks: OrchestratorHooks = {
			at: async (point) => {
				if (point !== "before_finalize") return;
				reached.release();
				await gate.promise;
			},
		};
		const id = await s.submit();
		const w = s.worker({ hooks });
		const t = w.tick();
		await reached.promise; // the review is done; only the final commit is left
		const acked = cancelTask(s.deps, id);
		expect(acked.cancel_requested_at).not.toBeNull();
		gate.release();
		await t;
		const d = await taskDetail(s.deps, id);
		expect(d.task).toMatchObject({
			state: "cancelled",
			failure_kind: "cancelled",
			result_run_id: null,
		});
		// the review that was produced stays on record, unchanged
		expect(d.reviews).toHaveLength(1);
		expect(d.reviews[0]).toMatchObject({ verdict: "approve", valid: true });
	});

	test("Cancel after completion is a no-op with a consistent answer", async () => {
		const s = setup();
		const id = await s.submit();
		await s.drain(s.worker());
		const before = getTask(s.fx.db, id);
		const after = cancelTask(s.deps, id);
		expect(after.state).toBe("human_ready");
		expect(after.cancel_requested_at).toBeNull();
		expect(after.rev).toBe(before?.rev ?? -1);
	});

	test("a fence change during the final await means the old worker commits nothing", async () => {
		const s = setup();
		const gate = deferred();
		const reached = deferred();
		const id = await s.submit();
		const w = s.worker({
			hooks: {
				at: async (point) => {
					if (point !== "before_finalize") return;
					reached.release();
					await gate.promise;
				},
			},
		});
		const t = w.tick();
		await reached.promise;
		const snapshot = getTask(s.fx.db, id);
		if (!snapshot) throw new Error("no task");
		const until = new Date(Date.now() + 60_000).toISOString();
		expect(seize(s.fx.db, snapshot, "other-worker", until)).not.toBeNull();
		const seized = getTask(s.fx.db, id);
		gate.release();
		await t;
		const final = getTask(s.fx.db, id);
		expect(final?.state).toBe("reviewing");
		expect(final?.rev).toBe(seized?.rev ?? -1);
		expect((await taskDetail(s.deps, id)).reviews).toHaveLength(0);
	});
});

// ── P1.4 ────────────────────────────────────────────────────────────────────

describe("P1.4 evidence is bound to the exact bytes", () => {
	function flipOneByte(path: string) {
		const buf = readFileSync(path);
		const i = buf.length - 2;
		buf[i] = (buf[i] ?? 0) ^ 0x01;
		writeFileSync(path, buf);
	}

	test("a same-length diff change after verification blocks review before the reviewer runs", async () => {
		const s = setup();
		const gate = deferred();
		let reviewerCalls = 0;
		const adapters: AdapterSet = {
			implementer: () => fakeImplementer,
			reviewer: () => ({
				...fakeReviewer,
				review: async (i, c) => {
					reviewerCalls++;
					return fakeReviewer.review(i, c);
				},
			}),
		};
		const id = await s.submit();
		const w = s.worker({
			adapters,
			hooks: {
				at: async (point) => {
					if (point === "before_review") await gate.promise;
				},
			},
		});
		const t = w.tick();
		await s.until(
			() => getTask(s.fx.db, id)?.state === "reviewing",
			"reviewing",
		);
		const diff = listArtifacts(s.fx.db, id).find(
			(a) => a.name === "diff.patch",
		);
		const path = join(s.fx.config.artifacts_root, diff?.rel_path ?? "-");
		const len = readFileSync(path).length;
		flipOneByte(path);
		expect(readFileSync(path).length).toBe(len);
		gate.release();
		await t;
		expect(getTask(s.fx.db, id)).toMatchObject({
			state: "failed",
			failure_kind: "evidence_invalid",
		});
		expect(reviewerCalls).toBe(0);
	});

	test("a corrupted verification log referenced by the manifest also blocks review", async () => {
		const s = setup();
		const gate = deferred();
		const id = await s.submit();
		const w = s.worker({
			hooks: {
				at: async (p) => {
					if (p === "before_review") await gate.promise;
				},
			},
		});
		const t = w.tick();
		await s.until(
			() => getTask(s.fx.db, id)?.state === "reviewing",
			"reviewing",
		);
		const log = listArtifacts(s.fx.db, id).find(
			(a) => a.kind === "verification_log",
		);
		flipOneByte(join(s.fx.config.artifacts_root, log?.rel_path ?? "-"));
		gate.release();
		await t;
		expect(getTask(s.fx.db, id)?.failure_kind).toBe("evidence_invalid");
	});

	async function done() {
		const s = setup();
		const id = await s.submit();
		await s.drain(s.worker());
		const arts = listArtifacts(s.fx.db, id);
		const path = (name: string) =>
			join(
				s.fx.config.artifacts_root,
				arts.find((a) => a.name === name)?.rel_path ?? "-",
			);
		const idOf = (name: string) => arts.find((a) => a.name === name)?.id ?? "-";
		return { s, id, path, idOf };
	}

	test("after human_ready: changed / truncated / missing / symlinked bytes → integrity error, not text", async () => {
		const { s, id, path, idOf } = await done();
		expect(readTaskArtifact(s.deps, id, idOf("diff.patch")).text).toContain(
			"diff --git",
		);

		flipOneByte(path("diff.patch"));
		expect(code(() => readTaskArtifact(s.deps, id, idOf("diff.patch")))).toBe(
			"409 artifact_integrity",
		);

		truncateSync(path("manifest.json"), 10);
		expect(
			code(() => readTaskArtifact(s.deps, id, idOf("manifest.json"))),
		).toBe("409 artifact_integrity");

		rmSync(path("review.log"));
		expect(code(() => readTaskArtifact(s.deps, id, idOf("review.log")))).toBe(
			"409 artifact_integrity",
		);

		const target = path("changed-files.json");
		const copy = `${target}.copy`;
		writeFileSync(copy, readFileSync(target));
		rmSync(target);
		symlinkSync(copy, target);
		expect(
			code(() => readTaskArtifact(s.deps, id, idOf("changed-files.json"))),
		).toBe("409 artifact_integrity");
	});

	test("task detail separates workspace integrity from evidence integrity", async () => {
		const { s, id, path } = await done();
		const clean = await taskDetail(s.deps, id);
		expect(clean.integrity?.intact).toBe(true);
		expect(clean.evidence_integrity).toEqual({ intact: true, problems: [] });

		flipOneByte(path("verify-1-fixture-check.log"));
		const tampered = await taskDetail(s.deps, id);
		expect(tampered.integrity?.intact).toBe(true); // the workspace did not change
		expect(tampered.evidence_integrity?.intact).toBe(false);
		expect(tampered.evidence_integrity?.problems.join(" ")).toContain(
			"verify-1-fixture-check.log",
		);
	});
});
