// Deterministic end-to-end loop with the fake adapters on a disposable fixture repo:
// task → worktree → implementation → evidence → review → (repair) → outcome. No model is called.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EvidenceManifest, type SimulationScenario } from "@agent-city/schema";
import { parseManagedConfig } from "./config.ts";
import { readArtifact } from "./evidence.ts";
import { Orchestrator } from "./orchestrator.ts";
import {
	type ManagedDeps,
	runTask,
	ServiceError,
	submitTask,
	taskDetail,
} from "./service.ts";
import { claimNext, getTask } from "./store.ts";
import {
	type Fixture,
	type FixtureOptions,
	fixtureGit,
	makeFixture,
} from "./testkit.ts";
import { createAdapters } from "./worker.ts";

let fixtures: Fixture[] = [];
afterEach(() => {
	for (const f of fixtures) f.cleanup();
	fixtures = [];
});

let keySeq = 0;
function setup(opts: FixtureOptions = {}) {
	const fx = makeFixture(opts);
	fixtures.push(fx);
	const deps: ManagedDeps = { db: fx.db, config: fx.config };
	const orch = new Orchestrator({
		db: fx.db,
		config: fx.config,
		adapters: createAdapters(fx.config),
		heartbeatMs: 50,
	});
	const body = (over: Record<string, unknown> = {}) => ({
		idempotency_key: `test-key-${++keySeq}`,
		repo_id: fx.repoId,
		title: "Add a simulated change",
		objective: "Exercise the managed pipeline on the fixture repository.",
		acceptance_criteria: ["The fixture check passes"],
		approved_scope: ["."],
		execution_mode: "simulated",
		...over,
	});
	const go = async (
		scenario: SimulationScenario,
		over: Record<string, unknown> = {},
	) => {
		const { task } = await submitTask(
			deps,
			body({ simulation_scenario: scenario, ...over }),
		);
		runTask(deps, task.id);
		while (await orch.tick()) {
			// drain
		}
		return taskDetail(deps, task.id);
	};
	return { fx, deps, orch, body, go };
}

const code = async (p: Promise<unknown>) => {
	try {
		await p;
	} catch (err) {
		if (err instanceof ServiceError) return `${err.status} ${err.code}`;
		throw err;
	}
	return "ok";
};

describe("simulated happy path", () => {
	test("task → worktree → implementation → evidence → review → human_ready (simulated)", async () => {
		const { fx, go } = setup();
		const d = await go("approve");

		expect(d.task.state).toBe("human_ready");
		expect(d.task.execution_mode).toBe("simulated");
		expect(d.task.failure_kind).toBeNull();
		expect(d.task.state_detail).toContain("simulated");
		expect(d.task.lease_owner).toBeNull();
		expect(d.integrity).toEqual({ intact: true, reason: null });

		expect(d.runs).toHaveLength(1);
		const run = d.runs[0];
		expect(run).toMatchObject({
			attempt_no: 1,
			kind: "initial",
			state: "finished",
			phase: "done",
			outcome: "approved",
			provider: "fake",
			mode: "simulated",
			model_resolved: null, // never guessed
			base_sha: fx.baseSha,
			proc_phase: null,
			child_pid: null,
		});
		expect(run?.candidate_sha).toMatch(/^[0-9a-f]{40}$/);
		expect(run?.candidate_sha).not.toBe(fx.baseSha);
		expect(d.task.result_run_id).toBe(run?.id ?? "");

		// workspace: owned worktree under the workspace root, on its own branch
		expect(run?.workspace_path?.startsWith(fx.config.workspace_root)).toBe(
			true,
		);
		expect(run?.branch).toMatch(/^agentcity\/task-/);
		expect(existsSync(run?.workspace_path ?? "")).toBe(true);
		// the configured checkout itself is untouched
		expect(fixtureGit(fx.repoPath, "rev-parse", "HEAD")).toBe(fx.baseSha);
		expect(fixtureGit(fx.repoPath, "status", "--porcelain")).toBe("");

		// evidence bound to the candidate
		const names = d.artifacts.map((a) => a.name).sort();
		expect(names).toEqual([
			"changed-files.json",
			"diff.patch",
			"implementation.log",
			"manifest.json",
			"review-output.json",
			"review.log",
			"verify-1-fixture-check.log",
		]);
		for (const a of d.artifacts)
			expect(a.candidate_sha).toBe(run?.candidate_sha ?? "");
		const manifestArt = d.artifacts.find((a) => a.name === "manifest.json");
		const manifest = EvidenceManifest.parse(
			JSON.parse(
				readArtifact(
					fx.config.artifacts_root,
					manifestArt as NonNullable<typeof manifestArt>,
					1_000_000,
				).text,
			),
		);
		expect(manifest.candidate_sha).toBe(run?.candidate_sha ?? "");
		expect(manifest.verification).toHaveLength(1);
		expect(manifest.verification[0]).toMatchObject({
			name: "fixture-check",
			argv: ["/bin/sh", "verify.sh"],
			exit_code: 0,
			completed: true,
		});
		expect(manifestArt?.sha256).toBe(run?.manifest_hash ?? "");

		// the review names this exact candidate and manifest
		expect(d.reviews).toHaveLength(1);
		expect(d.reviews[0]).toMatchObject({
			provider: "fake",
			mode: "simulated",
			verdict: "approve",
			valid: true,
			candidate_sha: run?.candidate_sha,
			manifest_hash: run?.manifest_hash,
		});
	});

	test("a workspace change after approval is reported, not hidden", async () => {
		const { deps, go } = setup();
		const d = await go("approve");
		expect(d.integrity?.intact).toBe(true);
		writeFileSync(
			join(d.runs[0]?.workspace_path ?? "", "late-edit.txt"),
			"after review\n",
		);
		const again = await taskDetail(deps, d.task.id);
		expect(again.task.state).toBe("human_ready");
		expect(again.integrity?.intact).toBe(false);
		expect(again.integrity?.reason).toContain("late-edit.txt");
	});
});

describe("rejection and repair", () => {
	test("reject → repair → new candidate → new review → human_ready", async () => {
		const { go } = setup();
		const d = await go("reject_then_approve");

		expect(d.task.state).toBe("human_ready");
		expect(
			d.runs.map((r) => [r.attempt_no, r.kind, r.state, r.outcome]),
		).toEqual([
			[1, "initial", "finished", "rejected"],
			[2, "repair", "finished", "approved"],
		]);
		const [first, second] = d.runs;
		expect(second?.parent_run_id).toBe(first?.id ?? "");
		expect(second?.parent_sha).toBe(first?.candidate_sha ?? "");
		expect(second?.candidate_sha).not.toBe(first?.candidate_sha ?? "");
		expect(second?.workspace_path).toBe(first?.workspace_path ?? "");
		expect(second?.repair_input?.[0]?.actionable).toBe(true);

		// the first review stays bound to the first candidate; only the second approves the result
		expect(d.reviews.map((r) => [r.verdict, r.valid, r.candidate_sha])).toEqual(
			[
				["reject", true, first?.candidate_sha ?? null],
				["approve", true, second?.candidate_sha ?? null],
			],
		);
		expect(d.task.result_run_id).toBe(second?.id ?? "");
		expect(second?.manifest_hash).not.toBe(first?.manifest_hash ?? "");
	});

	test("repair limit is a hard bound (default 1)", async () => {
		const { go } = setup();
		const d = await go("reject_always");
		expect(d.task.repair_limit).toBe(1);
		expect(d.task.state).toBe("failed");
		expect(d.task.failure_kind).toBe("repair_limit_exhausted");
		expect(d.runs).toHaveLength(2);
		expect(d.reviews.map((r) => r.verdict)).toEqual(["reject", "reject"]);
		expect(d.task.result_run_id).toBeNull();
	});

	test("repair_limit 0 → no repair at all; above the maximum is rejected", async () => {
		const { go, deps, body } = setup();
		const d = await go("reject_always", { repair_limit: 0 });
		expect(d.task.state).toBe("failed");
		expect(d.task.failure_kind).toBe("review_rejected");
		expect(d.runs).toHaveLength(1);
		expect(await code(submitTask(deps, body({ repair_limit: 4 })))).toBe(
			"400 invalid_task",
		);
	});

	test("a failed verification is repaired once, then fixed", async () => {
		const { go } = setup();
		const d = await go("verification_fails_then_fixed");
		expect(d.task.state).toBe("human_ready");
		expect(d.runs).toHaveLength(2);
		expect(d.runs[1]?.repair_input?.[0]?.title).toContain("fixture-check");
		// only the passing candidate was ever reviewed
		expect(d.reviews).toHaveLength(1);
		expect(d.reviews[0]?.candidate_sha).toBe(d.runs[1]?.candidate_sha ?? "");
	});
});

describe("nothing but a verified, validly reviewed candidate becomes human_ready", () => {
	test("verification that keeps failing → failed, never reviewed", async () => {
		const { go } = setup();
		const d = await go("verification_fails");
		expect(d.task.state).toBe("failed");
		expect(d.task.failure_kind).toBe("verification_failed");
		expect(d.reviews).toHaveLength(0);
		expect(d.task.result_run_id).toBeNull();
		const log = d.artifacts.find((a) => a.kind === "verification_log");
		expect(log?.meta).toMatchObject({ exit_code: 1, completed: true });
	});

	test("no verification configured → blocked (missing), never approved", async () => {
		const { go } = setup({ verification: "none" });
		const d = await go("approve");
		expect(d.task.state).toBe("blocked");
		expect(d.task.failure_kind).toBe("verification_missing");
		expect(d.reviews).toHaveLength(0);
	});

	test("verification that cannot start → blocked (unavailable), recorded as not completed", async () => {
		const { go } = setup({
			verification: [
				{ name: "missing-tool", argv: ["/nonexistent/agentcity-tool"] },
			],
		});
		const d = await go("approve");
		expect(d.task.state).toBe("blocked");
		expect(d.task.failure_kind).toBe("verification_unavailable");
		const log = d.artifacts.find((a) => a.kind === "verification_log");
		expect(log?.meta).toMatchObject({ completed: false, exit_code: null });
		expect(d.reviews).toHaveLength(0);
	});

	test("verification timeout → terminated, blocked, not a pass", async () => {
		const { go } = setup({
			verification: [
				{
					name: "hangs",
					argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
					timeout_s: 1,
				},
			],
		});
		const d = await go("approve");
		expect(d.task.state).toBe("blocked");
		expect(d.task.failure_kind).toBe("verification_unavailable");
		expect(d.task.state_detail).toContain("timed out");
		const log = d.artifacts.find((a) => a.kind === "verification_log");
		expect(log?.meta).toMatchObject({ completed: false, timed_out: true });
	});

	test("verification that dirties the workspace invalidates its own evidence", async () => {
		const { go } = setup({
			verification: [
				{
					name: "writes-files",
					argv: ["/bin/sh", "-c", "echo generated > generated.txt"],
				},
			],
		});
		const d = await go("approve");
		expect(d.task.state).toBe("failed");
		expect(d.task.failure_kind).toBe("candidate_mutated");
	});

	test("malformed review → failed (review_invalid), stored as invalid", async () => {
		const { go } = setup();
		const d = await go("malformed_review");
		expect(d.task.state).toBe("failed");
		expect(d.task.failure_kind).toBe("review_invalid");
		expect(d.reviews).toHaveLength(1);
		expect(d.reviews[0]).toMatchObject({ valid: false, verdict: null });
		expect(d.reviews[0]?.invalidated_reason).toContain("agentcity.review/v1");
		expect(d.task.result_run_id).toBeNull();
	});

	test("an approval of a different commit is not an approval", async () => {
		const { go } = setup();
		const d = await go("review_wrong_candidate");
		expect(d.task.state).toBe("failed");
		expect(d.task.failure_kind).toBe("review_invalid");
		expect(d.reviews[0]).toMatchObject({ valid: false, verdict: "approve" });
		expect(d.reviews[0]?.invalidated_reason).toContain("different commit");
	});

	test("reviewer error → failed, no verdict", async () => {
		const { go } = setup();
		const d = await go("reviewer_error");
		expect(d.task.state).toBe("failed");
		expect(d.task.failure_kind).toBe("provider_error");
		expect(d.reviews[0]).toMatchObject({ valid: false, verdict: null });
	});

	test("a reviewer that changes the workspace voids its own approval", async () => {
		const { go } = setup();
		const d = await go("reviewer_mutates");
		expect(d.task.state).toBe("failed");
		expect(d.task.failure_kind).toBe("candidate_mutated");
		expect(d.reviews[0]).toMatchObject({ valid: false, verdict: "approve" });
		expect(d.reviews[0]?.invalidated_reason).toContain("changed the workspace");
	});

	test("an implementer that changes nothing → failed (no_changes)", async () => {
		const { go } = setup();
		const d = await go("no_changes");
		expect(d.task.state).toBe("failed");
		expect(d.task.failure_kind).toBe("no_changes");
	});

	test("changes outside the approved scope → failed (scope_violation)", async () => {
		const { go } = setup();
		const d = await go("out_of_scope", { approved_scope: ["src"] });
		expect(d.task.state).toBe("failed");
		expect(d.task.failure_kind).toBe("scope_violation");
		expect(d.task.state_detail).toContain("agentcity-out-of-scope.txt");
		// the same scenario inside an approved scope is fine
		const ok = await setup().go("approve", { approved_scope: ["src"] });
		expect(ok.task.state).toBe("human_ready");
	});
});

describe("submission, approval and claims are idempotent", () => {
	test("same key + same body → the same task; different body → conflict", async () => {
		const { deps, body } = setup();
		const b = body();
		const first = await submitTask(deps, b);
		const second = await submitTask(deps, { ...b });
		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(second.task.id).toBe(first.task.id);
		expect(first.task.state).toBe("draft");
		expect(
			await code(submitTask(deps, { ...b, title: "something else" })),
		).toBe("409 idempotency_conflict");
	});

	test("Run twice queues once; the task runs exactly one initial attempt", async () => {
		const { deps, body, orch } = setup();
		const { task } = await submitTask(deps, body());
		expect(runTask(deps, task.id).queued).toBe(true);
		expect(runTask(deps, task.id).queued).toBe(false);
		while (await orch.tick()) {
			// drain
		}
		expect(runTask(deps, task.id).queued).toBe(false); // finished: still a no-op
		const d = await taskDetail(deps, task.id);
		expect(d.task.state).toBe("human_ready");
		expect(d.runs).toHaveLength(1);
	});

	test("a draft is never picked up; two workers cannot both claim a task", async () => {
		const { fx, deps, body } = setup();
		const { task } = await submitTask(deps, body());
		const until = new Date(Date.now() + 60_000).toISOString();
		expect(claimNext(fx.db, "w1", until)).toBeNull(); // draft: not approved
		runTask(deps, task.id);
		const a = claimNext(fx.db, "w1", until);
		const b = claimNext(fx.db, "w2", until);
		expect(a?.id).toBe(task.id);
		expect(b).toBeNull();
		expect(getTask(fx.db, task.id)?.lease_owner).toBe("w1");
	});

	test("one managed task at a time: a second queued task waits", async () => {
		const { fx, deps, body } = setup();
		const t1 = (await submitTask(deps, body())).task;
		const t2 = (await submitTask(deps, body())).task;
		runTask(deps, t1.id);
		runTask(deps, t2.id);
		const until = new Date(Date.now() + 60_000).toISOString();
		expect(claimNext(fx.db, "w1", until)?.id).toBe(t1.id);
		expect(claimNext(fx.db, "w1", until)).toBeNull();
	});
});

describe("what may be submitted", () => {
	test("repo outside the allowlist, unsafe scope, unknown fields, live while disabled", async () => {
		const { deps, body } = setup();
		expect(await code(submitTask(deps, body({ repo_id: "local/other" })))).toBe(
			"422 repo_not_allowed",
		);
		for (const scope of ["../outside", "/etc", "src/../..", "a//b", "-rf"])
			expect(
				await code(submitTask(deps, body({ approved_scope: [scope] }))),
			).toBe("400 invalid_task");
		expect(await code(submitTask(deps, body({ argv: ["rm"] })))).toBe(
			"400 invalid_task",
		);
		expect(await code(submitTask(deps, body({ execution_mode: "live" })))).toBe(
			"409 live_disabled",
		);
		expect(
			await code(
				submitTask(
					deps,
					body({ execution_mode: "live", simulation_scenario: "approve" }),
				),
			),
		).toBe("400 invalid_task");
	});

	test("user-authored text is redacted before it is stored", async () => {
		const { deps, body } = setup();
		const fake = `ghp_${"a1B2".repeat(9)}`; // built at runtime, not a real token
		const { task } = await submitTask(
			deps,
			body({ objective: `use ${fake} to call the API`, title: `t ${fake}` }),
		);
		expect(task.objective).not.toContain(fake);
		expect(task.title).not.toContain(fake);
		expect(task.objective).toContain("[REDACTED]");
	});

	test("changing the policy after Run voids the approval", async () => {
		const { fx, deps, body } = setup();
		const { task } = await submitTask(deps, body());
		runTask(deps, task.id);
		const changed = parseManagedConfig({
			workspace_root: fx.config.workspace_root,
			artifacts_root: fx.config.artifacts_root,
			git_executable: fx.config.git_executable,
			repos: [
				{
					id: fx.repoId,
					path: fx.repoPath,
					base_ref: "main",
					verification: [{ name: "swapped", argv: ["/usr/bin/true"] }],
				},
			],
			limits: fx.config.limits,
		});
		const orch = new Orchestrator({
			db: fx.db,
			config: changed,
			adapters: createAdapters(changed),
		});
		while (await orch.tick()) {
			// drain
		}
		const t = getTask(fx.db, task.id);
		expect(t?.state).toBe("blocked");
		expect(t?.failure_kind).toBe("approval_void");
		// nothing was executed for it
		expect((await taskDetail(deps, task.id)).runs).toHaveLength(0);
	});
});
