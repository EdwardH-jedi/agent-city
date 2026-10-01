// v0.1.1 optional D: table-driven state-machine regressions — crash at every stage boundary,
// policy changes between stages, invalid evidence rows, duplicate requests. Fake adapters only.
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeImplementer, fakeReviewer } from "./adapters/fake.ts";
import type { AdapterSet } from "./adapters/types.ts";
import { type ManagedConfig, parseManagedConfig } from "./config.ts";
import { Orchestrator, type OrchestratorHooks } from "./orchestrator.ts";
import {
	type ManagedDeps,
	runTask,
	submitTask,
	taskDetail,
} from "./service.ts";
import { claimNext, getRun, getTask, listArtifacts } from "./store.ts";
import { type Fixture, makeFixture } from "./testkit.ts";

let fixtures: Fixture[] = [];
const gates: string[] = [];
afterEach(() => {
	for (const g of gates.splice(0)) rmSync(g, { force: true });
	for (const f of fixtures) f.cleanup();
	fixtures = [];
});

const later = () => new Date(Date.now() + 10 * 60_000);

function deferred() {
	let release: () => void = () => {};
	const promise = new Promise<void>((r) => {
		release = r;
	});
	return { promise, release };
}

/** Resolves when `signal` aborts (a paused adapter must still honour shutdown). */
const aborted = (signal: AbortSignal) =>
	new Promise<void>((r) => {
		if (signal.aborted) r();
		else signal.addEventListener("abort", () => r(), { once: true });
	});

type Point = "implement" | "review_preflight" | "review";

/** Fake adapters that can pause at one point and count every call. */
function probedAdapters(pauseAt: Point | null) {
	const calls = { implement: 0, preflight: 0, review: 0 };
	const reached = deferred();
	const adapters: AdapterSet = {
		implementer: () => ({
			...fakeImplementer,
			implement: async (input, ctx) => {
				calls.implement++;
				if (pauseAt === "implement") {
					reached.release();
					await aborted(ctx.signal);
					return {
						ok: false,
						kind: "cancelled",
						detail: "paused",
						session_ref: null,
						model_resolved: null,
						usage: null,
						log: "",
						logTruncated: false,
					};
				}
				return fakeImplementer.implement(input, ctx);
			},
		}),
		reviewer: () => ({
			...fakeReviewer,
			preflight: async (ctx) => {
				calls.preflight++;
				if (pauseAt === "review_preflight" && calls.preflight === 1) {
					reached.release();
					await aborted(ctx.signal);
				}
				return { ok: true, detail: "test" };
			},
			review: async (input, ctx) => {
				calls.review++;
				if (pauseAt === "review") {
					reached.release();
					await aborted(ctx.signal);
					return {
						ok: false,
						kind: "cancelled",
						detail: "paused",
						session_ref: null,
						model_resolved: null,
						usage: null,
						log: "",
						logTruncated: false,
					};
				}
				return fakeReviewer.review(input, ctx);
			},
		}),
	};
	return { adapters, calls, reached };
}

let seq = 0;
function setup(verificationGate: string | null = null) {
	const fx = makeFixture(
		verificationGate
			? {
					verification: [
						{
							name: "gated",
							argv: [
								"/bin/sh",
								"-c",
								`[ -f "${verificationGate}" ] || sleep 600`,
							],
							timeout_s: 60,
						},
					],
				}
			: {},
	);
	fixtures.push(fx);
	const deps: ManagedDeps = { db: fx.db, config: fx.config };
	const worker = (o: {
		adapters: AdapterSet;
		config?: ManagedConfig;
		now?: () => Date;
		hooks?: OrchestratorHooks;
	}) =>
		new Orchestrator({
			db: fx.db,
			config: o.config ?? fx.config,
			adapters: o.adapters,
			heartbeatMs: 40,
			now: o.now,
			hooks: o.hooks,
		});
	const submit = async () => {
		const { task } = await submitTask(deps, {
			idempotency_key: `sm-${++seq}-${Date.now()}`,
			repo_id: fx.repoId,
			title: "State machine",
			objective: "Table-driven crash points.",
			acceptance_criteria: ["The fixture check passes"],
			approved_scope: ["."],
			execution_mode: "simulated",
			simulation_scenario: "approve",
		});
		runTask(deps, task.id);
		return task.id;
	};
	const drain = async (w: Orchestrator) => {
		while (await w.tick()) {
			// drain
		}
	};
	return { fx, deps, worker, submit, drain };
}

const changedPolicy = (cfg: ManagedConfig) =>
	parseManagedConfig({
		...cfg,
		limits: { ...cfg.limits, max_log_bytes: cfg.limits.max_log_bytes + 1 },
	});

interface Row {
	name: string;
	pause: Point | "verify" | "claimed";
	/** after the crash, with an unchanged policy */
	expect: "resumed" | "interrupted";
	modelCallsAfter: { implement: number; review: number };
}

const ROWS: Row[] = [
	{
		name: "claimed, before any stage",
		pause: "claimed",
		expect: "resumed",
		modelCallsAfter: { implement: 1, review: 1 },
	},
	{
		name: "implement launched",
		pause: "implement",
		expect: "interrupted",
		modelCallsAfter: { implement: 1, review: 0 },
	},
	{
		name: "verification running",
		pause: "verify",
		expect: "resumed",
		modelCallsAfter: { implement: 1, review: 1 },
	},
	{
		name: "review preflight (not launched)",
		pause: "review_preflight",
		expect: "resumed",
		modelCallsAfter: { implement: 1, review: 1 },
	},
	{
		name: "review launched",
		pause: "review",
		expect: "interrupted",
		modelCallsAfter: { implement: 1, review: 1 },
	},
];

async function crashAt(row: Row, policyChanged: boolean) {
	const gate =
		row.pause === "verify"
			? join(tmpdir(), `agentcity-sm-gate-${process.pid}-${++seq}`)
			: null;
	if (gate) gates.push(gate);
	const s = setup(gate);
	const probe = probedAdapters(
		row.pause === "verify" || row.pause === "claimed" ? null : row.pause,
	);
	const id = await s.submit();

	if (row.pause === "claimed") {
		// a worker claimed the task and died before doing anything
		claimNext(
			s.fx.db,
			"dead-worker",
			new Date(Date.now() + 1_000).toISOString(),
		);
	} else {
		const a = s.worker({ adapters: probe.adapters });
		const tick = a.tick();
		if (row.pause === "verify") {
			const deadline = Date.now() + 10_000;
			for (;;) {
				const t = getTask(s.fx.db, id);
				const run = t?.current_run_id
					? getRun(s.fx.db, t.current_run_id)
					: null;
				if (run?.proc_phase === "verify" && run.child_pid) break;
				if (Date.now() > deadline)
					throw new Error("verification never started");
				await Bun.sleep(10);
			}
		} else await probe.reached.promise;
		await a.shutdown();
		await tick;
	}
	if (gate) writeFileSync(gate, "");

	const config = policyChanged ? changedPolicy(s.fx.config) : s.fx.config;
	await s.drain(s.worker({ adapters: probe.adapters, config, now: later }));
	await s.drain(s.worker({ adapters: probe.adapters, config }));
	return { s, id, probe };
}

describe("crash at every stage boundary (unchanged policy)", () => {
	for (const row of ROWS)
		test(`${row.name} → ${row.expect}; no model stage launched twice`, async () => {
			const { s, id, probe } = await crashAt(row, false);
			const t = getTask(s.fx.db, id);
			if (row.expect === "resumed") expect(t?.state).toBe("human_ready");
			else
				expect(t).toMatchObject({
					state: "interrupted",
					failure_kind: "interrupted",
				});
			expect({
				implement: probe.calls.implement,
				review: probe.calls.review,
			}).toEqual(row.modelCallsAfter);
			expect((await taskDetail(s.deps, id)).runs).toHaveLength(1);
		});
});

describe("policy change between stages (resumable boundaries)", () => {
	for (const row of ROWS.filter((r) => r.expect === "resumed"))
		test(`${row.name} + changed policy → approval_void before anything else runs`, async () => {
			const { s, id, probe } = await crashAt(row, true);
			expect(getTask(s.fx.db, id)).toMatchObject({
				state: "blocked",
				failure_kind: "approval_void",
			});
			// nothing beyond what ran before the crash
			expect(probe.calls.review).toBe(0);
			expect(probe.calls.implement).toBe(row.pause === "claimed" ? 0 : 1);
		});
});

describe("invalid evidence rows are caught before the reviewer runs", () => {
	const CASES: [string, (db: Fixture["db"], runId: string) => void][] = [
		[
			"diff row sha256 changed",
			(db, run) =>
				db.run(
					"UPDATE managed_artifacts SET sha256 = ? WHERE run_id = ? AND name = 'diff.patch'",
					["0".repeat(64), run],
				),
		],
		[
			"manifest row byte_len changed",
			(db, run) =>
				db.run(
					"UPDATE managed_artifacts SET byte_len = byte_len + 1 WHERE run_id = ? AND name = 'manifest.json'",
					[run],
				),
		],
		[
			"verification log row points outside the root",
			(db, run) =>
				db.run(
					"UPDATE managed_artifacts SET rel_path = '../../etc/hosts' WHERE run_id = ? AND kind = 'verification_log'",
					[run],
				),
		],
		[
			"manifest row deleted",
			(db, run) =>
				db.run(
					"DELETE FROM managed_artifacts WHERE run_id = ? AND name = 'manifest.json'",
					[run],
				),
		],
		[
			"verification log row deleted",
			(db, run) =>
				db.run(
					"DELETE FROM managed_artifacts WHERE run_id = ? AND kind = 'verification_log'",
					[run],
				),
		],
		[
			"run manifest_hash changed",
			(db, run) =>
				db.run("UPDATE managed_runs SET manifest_hash = ? WHERE id = ?", [
					"f".repeat(64),
					run,
				]),
		],
	];
	for (const [name, tamper] of CASES)
		test(name, async () => {
			const s = setup();
			const probe = probedAdapters(null);
			const id = await s.submit();
			const w = s.worker({
				adapters: probe.adapters,
				hooks: {
					at: (point, taskId) => {
						if (point !== "before_review") return;
						const runId = getTask(s.fx.db, taskId)?.current_run_id ?? "-";
						tamper(s.fx.db, runId);
					},
				},
			});
			await s.drain(w);
			expect(getTask(s.fx.db, id)).toMatchObject({
				state: "failed",
				failure_kind: "evidence_invalid",
			});
			expect(probe.calls.review).toBe(0);
			expect(probe.calls.preflight).toBe(0);
			expect(
				listArtifacts(s.fx.db, id).some((a) => a.kind === "review_output"),
			).toBe(false);
		});
});

describe("the binding is re-checked at the final commit", () => {
	test("manifest_hash changed while the review ran → failed (evidence_invalid), not human_ready", async () => {
		const s = setup();
		const probe = probedAdapters(null);
		const id = await s.submit();
		const w = s.worker({
			adapters: probe.adapters,
			hooks: {
				at: (point, taskId) => {
					if (point !== "before_finalize") return;
					const runId = getTask(s.fx.db, taskId)?.current_run_id ?? "-";
					s.fx.db.run(
						"UPDATE managed_runs SET manifest_hash = ? WHERE id = ?",
						["e".repeat(64), runId],
					);
				},
			},
		});
		await s.drain(w);
		expect(getTask(s.fx.db, id)).toMatchObject({
			state: "failed",
			failure_kind: "evidence_invalid",
			result_run_id: null,
		});
		expect(probe.calls.review).toBe(1); // the review ran; its approval did not count
	});
});

describe("duplicate requests", () => {
	test("five concurrent submissions with one key → one task", async () => {
		const s = setup();
		const body = {
			idempotency_key: `dup-${Date.now()}`,
			repo_id: s.fx.repoId,
			title: "dup",
			objective: "o",
			acceptance_criteria: ["c"],
			approved_scope: ["."],
			execution_mode: "simulated",
		};
		const results = await Promise.all(
			Array.from({ length: 5 }, () => submitTask(s.deps, { ...body })),
		);
		expect(new Set(results.map((r) => r.task.id)).size).toBe(1);
		expect(results.filter((r) => r.created)).toHaveLength(1);
		const n = s.fx.db
			.query<{ n: number }, []>("SELECT count(*) AS n FROM managed_tasks")
			.get()?.n;
		expect(n).toBe(1);
	});

	test("Run repeated while queued / running / finished never adds an attempt", async () => {
		const s = setup();
		const probe = probedAdapters(null);
		const id = await s.submit();
		for (let i = 0; i < 3; i++) expect(runTask(s.deps, id).queued).toBe(false);
		await s.drain(s.worker({ adapters: probe.adapters }));
		for (let i = 0; i < 3; i++) expect(runTask(s.deps, id).queued).toBe(false);
		expect((await taskDetail(s.deps, id)).runs).toHaveLength(1);
		expect(probe.calls.implement).toBe(1);
	});
});
