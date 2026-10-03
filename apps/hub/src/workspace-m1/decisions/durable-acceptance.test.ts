// v1.2 §B/§C at Gate 2 (decision service + read model) against a REAL fixture execution: Gate 1 via
// the DecisionService, the existing Orchestrator with fake adapters, 06's sealer, and the bridge
// emulation (`openGate2`) that publishes the durable bundle before inserting the result request.
//
// Covers the independent review's findings: OBS-04 (a source swap after Gate-2 validation, before
// the commit — the review's barrier) and J-22 (corruption after acceptance must not leave the
// acceptance "valid"), across restart (new handle + new auth boot) and retained-cache eviction.
import { afterEach, describe, expect, test } from "bun:test";
import {
	copyFileSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ApprovalRequestRow } from "@agent-city/schema/workspace-m1";
import { sha256Hex } from "@agent-city/schema/workspace-m1/hash";
import { getTask } from "../../managed/store.ts";
import { LEGACY_RESULT_DETAIL } from "../evidence/bundle.ts";
import { createWorkspaceReadModel } from "./read-model.ts";
import {
	approvedTask,
	artifactPath,
	bundlePath,
	challenge,
	count,
	decisionBody,
	dump,
	type Env,
	expectOk,
	makeEnv,
	openGate2,
	restartEnv,
	runEngine,
} from "./test-support.ts";

const envs: Env[] = [];
afterEach(() => {
	const dirs = new Set<string>();
	for (const e of envs.splice(0)) {
		try {
			e.db.close();
		} catch {
			// closed
		}
		if (!dirs.has(e.fx.dir)) {
			dirs.add(e.fx.dir);
			e.fx.cleanup();
		}
	}
});

async function awaitingAcceptance(
	o: Parameters<typeof makeEnv>[0] = {},
	gate2: { bundle?: boolean } = {},
) {
	const e = makeEnv(o);
	envs.push(e);
	const v = await e.ctx();
	const ids = await approvedTask(e, v);
	await runEngine(e);
	expect(getTask(e.db, ids.managedTaskId)?.state).toBe("human_ready");
	const result = await openGate2(e, ids, gate2);
	return { e, v, ids, result };
}

/** A read model on THIS env with its fake clock (deterministic "older than 5 s"). */
const readsFor = (e: Env) =>
	createWorkspaceReadModel({
		store: e.store,
		config: e.config,
		bridge: e.services.bridge,
		reader: { db: e.db, config: e.fx.config, retained: e.retained },
		clock: e.clock,
	});

const artifactId = (e: Env, managedTaskId: string, name: string): string => {
	const managed = getTask(e.db, managedTaskId);
	const row = e.db
		.query<{ id: string }, [string, string, string]>(
			"SELECT id FROM managed_artifacts WHERE task_id = ? AND run_id = ? AND name = ?",
		)
		.get(managedTaskId, managed?.result_run_id ?? "", name);
	if (!row) throw new Error(`no artifact ${name}`);
	return row.id;
};

const decisions = (e: Env) =>
	count(e.db, "SELECT count(*) AS n FROM managed_decisions");
const validityRows = (e: Env) =>
	count(e.db, "SELECT count(*) AS n FROM managed_acceptance_validity");

async function accept(
	e: Env,
	v: Awaited<ReturnType<Env["ctx"]>>,
	r: ApprovalRequestRow,
) {
	const ch = challenge(e, v, r.id);
	const body = decisionBody(ch);
	return {
		body,
		res: await e.services.decisions.decide(v, r.id, body, e.tick()),
	};
}

describe("Gate 2 accept names the durable bundle (v1.2 §B)", () => {
	test("decision row + receipt carry the request's digest; validity starts `valid` at decided_at; replay is byte-identical", async () => {
		const { e, v, ids, result } = await awaitingAcceptance();
		const digest = result.evidence_bundle_digest as string;
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
		expect(e.store.getEvidenceBundle(digest)?.result_envelope_hash).toBe(
			result.result_envelope_hash as string,
		);
		expect(sha256Hex(readFileSync(bundlePath(e, digest)))).toBe(digest);
		const { body, res } = await accept(e, v, result);
		const receipt = expectOk(res).receipt;
		expect(receipt.effects.evidence_bundle_digest).toBe(digest);
		const decision = e.store.getDecision(receipt.decision_id);
		expect(decision?.evidence_bundle_digest).toBe(digest);
		expect(decision?.response_body).toEqual(receipt);
		expect(e.store.getAcceptanceValidity(receipt.decision_id)).toEqual({
			decision_id: receipt.decision_id,
			result_request_id: result.id,
			workspace_task_id: ids.taskId,
			evidence_bundle_digest: digest,
			status: "valid",
			reason: null,
			detail: null,
			checked_at: receipt.decided_at,
			first_invalid_at: null,
			rev: 1,
		});
		const replay = expectOk(
			await e.services.decisions.decide(v, result.id, body, e.tick()),
		);
		expect(replay.replayed).toBe(true);
		expect(replay.receipt).toEqual(receipt);
		const view = e.services.reads.taskView(ids.taskId);
		expect(view?.acceptance_validity?.status).toBe("valid");
		expect(view?.acceptance_validity?.evidence_bundle_digest).toBe(digest);
		const snap = expectOk(e.services.reads.snapshot(e.now()));
		const item = snap.tasks.find((t) => t.task.id === ids.taskId);
		expect(item?.acceptance_validity?.status).toBe("valid");
		// the request view stays the frozen v1 shape (the digest is server-side)
		expect(view?.approval_requests[0]).not.toHaveProperty(
			"evidence_bundle_digest",
		);
	});

	test("rollback: a failure inserting the validity row undoes the whole decision; the same body then succeeds once", async () => {
		const { e, v, result } = await awaitingAcceptance();
		const ch = challenge(e, v, result.id);
		const body = decisionBody(ch);
		const before = dump(e.db);
		e.db.run(
			"CREATE TEMP TRIGGER inject_validity_failure BEFORE INSERT ON managed_acceptance_validity BEGIN SELECT RAISE(ABORT, 'injected'); END",
		);
		const failed = await e.services.decisions.decide(
			v,
			result.id,
			body,
			e.tick(),
		);
		expect(failed.ok).toBe(false);
		expect(dump(e.db)).toBe(before);
		expect(decisions(e)).toBe(1); // Gate 1 only
		expect(validityRows(e)).toBe(0);
		expect(e.store.getApprovalRequest(result.id)?.challenge_status).toBe(
			"issued",
		);
		e.db.run("DROP TRIGGER inject_validity_failure");
		const ok = await e.services.decisions.decide(v, result.id, body, e.tick());
		expect(ok.status).toBe(201);
		expect(validityRows(e)).toBe(1);
	});
});

describe("OBS-04: the review's barrier — source replaced after Gate-2 validation, before the commit", () => {
	test("history kept, original bytes served from the bundle, current validity invalid (sticky) — across restart and cache eviction", async () => {
		let swap: (() => void) | null = null;
		const { e, v, ids, result } = await awaitingAcceptance({
			fixture: { dbFile: true }, // restart below reopens the same file
			hooks: {
				beforeTransaction(kind) {
					if (kind !== "result") return;
					const f = swap;
					swap = null;
					f?.();
				},
			},
		});
		const diffPath = artifactPath(e, ids.managedTaskId, "diff.patch");
		const original = readFileSync(diffPath, "utf8");
		const diffId = artifactId(e, ids.managedTaskId, "diff.patch");
		swap = () => writeFileSync(diffPath, "independent changed evidence\n");
		const { res } = await accept(e, v, result);
		expect(res.status).toBe(201); // validation passed before the swap: the accepted hash = verified bytes
		const receipt = expectOk(res).receipt;
		expect(readFileSync(diffPath, "utf8")).toBe(
			"independent changed evidence\n",
		);

		const reads = readsFor(e);
		const shown = expectOk(await reads.artifact(ids.taskId, diffId));
		expect([shown.status, shown.text]).toEqual(["verified", original]);

		e.tick(6_000); // the stored check is now older than 5 s → the detail read re-checks
		const detail = expectOk(reads.taskDetail(ids.taskId));
		expect(detail.task.stage).toBe("accepted"); // history
		expect(detail.task.accepted_decision_id).toBe(receipt.decision_id);
		expect(detail.acceptance_validity).toMatchObject({
			decision_id: receipt.decision_id,
			status: "invalid",
			reason: "source_evidence_changed",
		});
		expect(detail.acceptance_validity?.first_invalid_at).toBe(
			detail.acceptance_validity?.checked_at,
		);
		expect(detail.acceptance_validity?.detail).toContain("diff.patch");
		expect(detail.acceptance_validity?.detail).not.toContain("independent");

		// sticky: restoring the bytes never restores `valid`
		writeFileSync(diffPath, original);
		e.tick(6_000);
		expect(
			expectOk(await reads.taskDetailChecked(ids.taskId)).acceptance_validity
				?.status,
		).toBe("invalid");
		expect(() =>
			e.db.run(
				"UPDATE managed_acceptance_validity SET status = 'valid', reason = NULL, first_invalid_at = NULL, rev = rev + 1 WHERE decision_id = ?",
				[receipt.decision_id],
			),
		).toThrow(/sticky/);
		writeFileSync(diffPath, "independent changed evidence\n");

		// cache eviction: the retained copy is never authoritative
		e.retained.clear();
		expect(expectOk(await reads.artifact(ids.taskId, diffId)).text).toBe(
			original,
		);

		// restart: new handle, new auth boot, new (empty) retained store
		const e2 = restartEnv(e);
		envs.push(e2);
		const reads2 = readsFor(e2);
		const after = expectOk(await reads2.artifact(ids.taskId, diffId));
		expect([after.status, after.text]).toEqual(["verified", original]);
		const d2 = expectOk(reads2.taskDetail(ids.taskId));
		expect(d2.task.stage).toBe("accepted");
		expect(d2.acceptance_validity?.status).toBe("invalid");
		expect(
			expectOk(reads2.snapshot(e2.now())).tasks.find(
				(t) => t.task.id === ids.taskId,
			)?.acceptance_validity?.status,
		).toBe("invalid");
		// the historical decision and its receipt never changed
		expect(e2.store.getDecision(receipt.decision_id)?.response_body).toEqual(
			receipt,
		);
		expect(e2.store.getApprovalRequest(result.id)?.status).toBe("accepted");
	});
});

describe("J-22: corruption after acceptance", () => {
	test("coherent file + DB-row rewrite of the mutable artifact: the bundle still serves the original; validity → invalid", async () => {
		const { e, v, ids, result } = await awaitingAcceptance();
		expect((await accept(e, v, result)).res.status).toBe(201);
		const logName = "verify-1-fixture-check.log";
		const path = artifactPath(e, ids.managedTaskId, logName);
		const original = readFileSync(path, "utf8");
		const forged = "FORGED-AFTER-ACCEPT verification log\n";
		writeFileSync(path, forged);
		e.db.run(
			"UPDATE managed_artifacts SET sha256 = ?, byte_len = ? WHERE id = ?",
			[
				sha256Hex(forged),
				Buffer.byteLength(forged),
				artifactId(e, ids.managedTaskId, logName),
			],
		);
		const reads = readsFor(e);
		const shown = expectOk(
			await reads.artifact(
				ids.taskId,
				artifactId(e, ids.managedTaskId, logName),
			),
		);
		expect(shown.text).toBe(original);
		expect(shown.text).not.toContain("FORGED");
		e.tick(6_000);
		const d = expectOk(reads.taskDetail(ids.taskId));
		expect(d.acceptance_validity).toMatchObject({
			status: "invalid",
			reason: "source_evidence_changed",
		});
	});

	test("bundle deleted after acceptance: validity → invalid(bundle_missing); the artifact is no longer served (text null)", async () => {
		const { e, v, ids, result } = await awaitingAcceptance();
		expect((await accept(e, v, result)).res.status).toBe(201);
		rmSync(bundlePath(e, result.evidence_bundle_digest as string));
		const reads = readsFor(e);
		const diffId = artifactId(e, ids.managedTaskId, "diff.patch");
		const shown = expectOk(await reads.artifact(ids.taskId, diffId));
		expect([shown.status, shown.text]).toEqual(["corrupt", null]);
		expect(shown.withheld_reasons).toContain("bundle_missing");
		e.tick(6_000);
		expect(
			expectOk(reads.taskDetail(ids.taskId)).acceptance_validity?.reason,
		).toBe("bundle_missing");
	});

	test("clean accepted control: re-checks stay `valid` and advance checked_at (no false alarm)", async () => {
		const { e, v, ids, result } = await awaitingAcceptance({
			fixture: { dbFile: true },
		});
		const receipt = expectOk((await accept(e, v, result)).res).receipt;
		const reads = readsFor(e);
		// within 5 s: no re-check, the stored row is served
		expect(
			expectOk(reads.taskDetail(ids.taskId)).acceptance_validity?.checked_at,
		).toBe(receipt.decided_at);
		e.tick(6_000);
		const d = expectOk(await reads.taskDetailChecked(ids.taskId));
		expect(d.acceptance_validity?.status).toBe("valid");
		expect(Date.parse(d.acceptance_validity?.checked_at ?? "")).toBeGreaterThan(
			Date.parse(receipt.decided_at),
		);
		expect(e.store.getAcceptanceValidity(receipt.decision_id)?.rev).toBe(2);
		// a restart serves the same verified bytes and keeps `valid`
		const e2 = restartEnv(e);
		envs.push(e2);
		e2.clock.advance(e.now().getTime() - e2.now().getTime() + 6_000);
		const d2 = expectOk(await readsFor(e2).taskDetailChecked(ids.taskId));
		expect(d2.acceptance_validity?.status).toBe("valid");
	});
});

describe("durable evidence failures at accept (409, never accepted)", () => {
	for (const mode of ["missing", "hash_mismatch", "symlink", "fifo"] as const)
		test(`bundle ${mode} → 409 integrity_failed, request invalidated naming the bundle, no decision`, async () => {
			const { e, v, ids, result } = await awaitingAcceptance();
			const file = bundlePath(e, result.evidence_bundle_digest as string);
			const copy = join(e.fx.dir, "copy.bundle");
			copyFileSync(file, copy);
			if (mode === "missing") rmSync(file);
			else if (mode === "hash_mismatch")
				writeFileSync(file, readFileSync(copy).subarray(0, 50));
			else if (mode === "symlink") {
				rmSync(file);
				symlinkSync(copy, file); // a valid bundle behind a symlink is still refused
			} else {
				rmSync(file);
				expect(Bun.spawnSync(["/usr/bin/mkfifo", file]).exitCode).toBe(0);
			}
			const t0 = performance.now();
			const { res } = await accept(e, v, result);
			expect(performance.now() - t0).toBeLessThan(5_000);
			expect([res.status, (res.body as { error: string }).error]).toEqual([
				409,
				"integrity_failed",
			]);
			const row = e.store.getApprovalRequest(result.id);
			expect(row?.status).toBe("invalidated");
			expect(row?.invalidation_reason).toBe("integrity_failed");
			expect(row?.invalidation_detail).toContain("durable evidence bundle");
			expect(e.store.getTask(ids.taskId)?.stage).toBe("execution_ended");
			expect(decisions(e)).toBe(1);
			expect(validityRows(e)).toBe(0);
		});

	test("legacy pending result without a durable bundle → 409 evidence_unavailable, invalidated with the v1.2 wording", async () => {
		const { e, v, ids, result } = await awaitingAcceptance(
			{},
			{ bundle: false },
		);
		expect(result.evidence_bundle_digest).toBeUndefined();
		const { res } = await accept(e, v, result);
		expect([res.status, (res.body as { error: string }).error]).toEqual([
			409,
			"evidence_unavailable",
		]);
		const row = e.store.getApprovalRequest(result.id);
		expect(row?.status).toBe("invalidated");
		expect(row?.invalidation_reason).toBe("evidence_unavailable");
		expect(row?.invalidation_detail).toBe(LEGACY_RESULT_DETAIL);
		expect(e.store.getTask(ids.taskId)?.stage).toBe("execution_ended");
		expect(decisions(e)).toBe(1);
	});
});
