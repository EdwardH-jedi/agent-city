// biome-ignore-all lint/suspicious/noExplicitAny: adversarial tests inspect raw, untyped HTTP bodies and SQLite rows on purpose
// ADV-G2, ADV-EVID, ADV-ACCEPT — Gate 2 binding, evidence tampering (files, rows, special files,
// symlinks, bounded reads, validation/use window) and human acceptance vs engine human_ready.
// Composed hub (production modules + counted adapters) on a real loopback server.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hostProcessOps } from "../../src/managed/proc.ts";
import { submitTask } from "../../src/managed/service.ts";
import { GIT } from "../../src/managed/testkit.ts";
import {
	approveGate1,
	artifactRows,
	assertIsolation,
	type Client,
	type ComposedHub,
	type ComposedOptions,
	composedHub,
	count,
	decide,
	decisionBody,
	http,
	issueChallenge,
	key,
	liveServers,
	openGate1,
	requestRow,
	taskView,
	teardown,
	toGate2,
	waitFor,
	waitStage,
	writingImplementer,
} from "./harness.ts";

assertIsolation();
afterEach(teardown);
afterAll(() => expect(liveServers).toBe(0));

const sha = (b: Buffer | string) =>
	createHash("sha256").update(b).digest("hex");

async function atGate2(o: ComposedOptions = {}, over = {}) {
	const H = composedHub(o);
	const c = await H.signIn();
	const g = await toGate2(c, H.fx, over);
	return { H, c, g, arts: artifactRows(H.db, g.managedTaskId) };
}

const artPath = (H: ComposedHub, rel: string) =>
	join(H.fx.config.artifacts_root, rel);

async function tryAccept(c: Client, g2: any) {
	const v = await taskView(c, g2.workspace_task_id);
	const req = (v.approval_requests as any[]).find((r) => r.id === g2.id);
	if (req.status !== "pending")
		return { status: 409, body: { error: `request ${req.status}` }, text: "" };
	const ch = await c.post(`/approval-requests/${g2.id}/challenge`, {
		kind: "result",
		binding_hash: req.binding_hash,
		expected_request_rev: req.rev,
	});
	if (ch.status !== 200 && ch.status !== 201) return ch;
	return decide(c, req, decisionBody(req, ch.body, "accept"));
}

function expectNotAccepted(H: ComposedHub, g: { taskId: string; g2: any }) {
	expect(
		count(
			H.db,
			"SELECT count(*) AS n FROM managed_decisions WHERE approval_request_id = ? AND action = 'accept'",
			g.g2.id,
		),
	).toBe(0);
	const t = H.db
		.query(
			"SELECT stage, accepted_decision_id FROM workspace_tasks WHERE id = ?",
		)
		.get(g.taskId) as any;
	expect(t.accepted_decision_id).toBeNull();
	expect(t.stage).not.toBe("accepted");
}

/** Coherent file + row rewrite (sha256 and byte_len updated to the new bytes). */
function coherentRewrite(H: ComposedHub, art: any, content: Buffer | string) {
	const bytes = Buffer.from(content);
	writeFileSync(artPath(H, art.rel_path), bytes);
	H.db
		.query("UPDATE managed_artifacts SET sha256 = ?, byte_len = ? WHERE id = ?")
		.run(sha(bytes), bytes.length, art.id);
}

const named = (arts: any[], name: string) => arts.find((a) => a.name === name);

describe("ADV-G2 Gate 2 exact result binding", () => {
	test("ADV-G2-01 repaired execution: Gate 2 binds attempt 2; repointing result_run_id to attempt 1 → no acceptance", async () => {
		const { H, c, g } = await atGate2(
			{},
			{
				simulation_scenario: "reject_then_approve",
				repair_policy: { max_repairs: 1 },
			},
		);
		const runs = H.db
			.query(
				"SELECT id, attempt_no FROM managed_runs WHERE task_id = ? ORDER BY attempt_no",
			)
			.all(g.managedTaskId) as any[];
		expect(runs.map((r) => r.attempt_no)).toEqual([1, 2]);
		const env = JSON.parse(requestRow(H.db, g.g2.id).result_envelope);
		expect([env.attempt_no, env.run_id]).toEqual([2, runs[1].id]);
		H.db
			.query("UPDATE managed_tasks SET result_run_id = ? WHERE id = ?")
			.run(runs[0].id, g.managedTaskId);
		const r = await tryAccept(c, g.g2);
		expect(r.status).toBe(409);
		expectNotAccepted(H, g);
	});

	test("ADV-G2-02 candidate / manifest row tampering → 409, no acceptance (integrity → invalidated)", async () => {
		const seen: Record<string, unknown> = {};
		for (const variant of [
			"candidate_unknown_commit",
			"candidate_other_commit",
			"manifest_hash",
		] as const) {
			const { H, c, g } = await atGate2();
			const base = (
				H.db
					.query("SELECT base_sha FROM managed_tasks WHERE id = ?")
					.get(g.managedTaskId) as any
			).base_sha;
			const [col, value] =
				variant === "manifest_hash"
					? ["manifest_hash", "b".repeat(64)]
					: [
							"candidate_sha",
							variant === "candidate_other_commit" ? base : "a".repeat(40),
						];
			H.db
				.query(`UPDATE managed_runs SET ${col} = ? WHERE task_id = ?`)
				.run(value, g.managedTaskId);
			const r = await tryAccept(c, g.g2);
			seen[variant] = {
				status: r.status,
				error: r.body?.error,
				request: requestRow(H.db, g.g2.id).status,
			};
			expect([variant, r.status]).toEqual([variant, 409]);
			expectNotAccepted(H, g);
			await H.stop();
		}
		// a nonexistent commit is classified transient (R-E5 `candidate_unavailable` → evidence_unavailable,
		// request stays pending); a different existing commit or manifest is an integrity failure
		expect(seen).toEqual({
			candidate_unknown_commit: {
				status: 409,
				error: "evidence_unavailable",
				request: "pending",
			},
			candidate_other_commit: {
				status: 409,
				error: "integrity_failed",
				request: "invalidated",
			},
			manifest_hash: {
				status: 409,
				error: "integrity_failed",
				request: "invalidated",
			},
		});
	});

	test("ADV-G2-03 a required artifact row deleted → 409, request invalidated", async () => {
		const { H, c, g, arts } = await atGate2();
		const log = arts.find((a) => /^verify-\d+-/.test(a.name));
		H.db.query("DELETE FROM managed_artifacts WHERE id = ?").run(log.id);
		const r = await tryAccept(c, g.g2);
		expect(r.status).toBe(409);
		expectNotAccepted(H, g);
		expect(requestRow(H.db, g.g2.id).status).toBe("invalidated");
	});

	test("ADV-G2-04/05 rejected review or incomplete required check → no Gate-2 request at all", async () => {
		const R = composedHub();
		const c = await R.signIn();
		const a = await approveGate1(c, R.fx, {
			simulation_scenario: "reject_always",
		});
		const v = await waitStage(c, a.taskId, [
			"execution_ended",
			"awaiting_acceptance",
		]);
		expect(v.task.stage).toBe("execution_ended");
		expect(
			count(
				R.db,
				"SELECT count(*) AS n FROM managed_approval_requests WHERE kind='result' AND workspace_task_id = ?",
				a.taskId,
			),
		).toBe(0);
		await R.stop();
		const S = composedHub({
			fixture: {
				verification: [
					{ name: "slow-check", argv: ["/bin/sleep", "5"], timeout_s: 1 },
				],
			},
		});
		const c2 = await S.signIn();
		// v1.2: this repo's only trusted check is `slow-check` (explicit criterion coverage)
		const b = await approveGate1(c2, S.fx, {
			criterion_checks: [
				{ criterion: "The fixture check passes", checks: ["slow-check"] },
			],
		});
		const v2 = await waitStage(
			c2,
			b.taskId,
			["execution_ended", "awaiting_acceptance"],
			40_000,
		);
		expect(v2.task.stage).toBe("execution_ended");
		expect(
			count(
				S.db,
				"SELECT count(*) AS n FROM managed_approval_requests WHERE kind='result' AND workspace_task_id = ?",
				b.taskId,
			),
		).toBe(0);
		expect(S.calls.review).toBe(0);
	}, 60_000);

	test("ADV-G2-06 a managed task forced to human_ready outside Gate 1 never gets a Gate-2 request", async () => {
		const H = composedHub({ manual: true });
		const { task } = await submitTask(
			{ db: H.db, config: H.fx.config },
			{
				idempotency_key: key("bypass"),
				repo_id: H.fx.repoId,
				title: "Forged result",
				objective: "Pretend a result exists without any decision.",
				acceptance_criteria: ["never accepted"],
				approved_scope: ["."],
				execution_mode: "simulated",
				simulation_scenario: "approve",
				repair_limit: 0,
			},
		);
		H.db
			.query("UPDATE managed_tasks SET state = 'human_ready' WHERE id = ?")
			.run(task.id);
		await H.bridge.sweep();
		expect(
			count(
				H.db,
				"SELECT count(*) AS n FROM managed_approval_requests WHERE managed_task_id = ?",
				task.id,
			),
		).toBe(0);
		expect(count(H.db, "SELECT count(*) AS n FROM managed_decisions")).toBe(0);
	});

	test("ADV-G2-07/08/12 + ADV-CHAL-03 + ADV-IDEM-10 gate/kind confusion, stale rev, foreign binding, key reuse across gates", async () => {
		const { H, c, g } = await atGate2();
		const other = await openGate1(c, H.fx);
		const otherCh = await issueChallenge(c, other.req);
		const v = await taskView(c, g.taskId);
		const g2 = (v.approval_requests as any[]).find((r) => r.id === g.g2.id);
		// Gate-1 challenge (other task) on the Gate-2 request
		const cross = await decide(
			c,
			g2,
			decisionBody(
				g2,
				{ challenge: otherCh.challenge, request_rev: g2.rev },
				"accept",
			),
		);
		expect(cross.status).toBe(409);
		// kind confusion: run actions on a result request and vice versa
		const ch = await issueChallenge(c, g2);
		expect(
			(
				await decide(
					c,
					g2,
					decisionBody(g2, ch, "accept", { kind: "run", action: "approve" }),
				)
			).status,
		).toBeGreaterThanOrEqual(400);
		expect((await decide(c, g2, decisionBody(g2, ch, "approve"))).status).toBe(
			400,
		);
		expect(
			(await decide(c, other.req, decisionBody(other.req, otherCh, "accept")))
				.status,
		).toBe(400);
		// stale rev and a foreign binding hash
		expect(
			(
				await decide(
					c,
					g2,
					decisionBody(g2, ch, "accept", { expected_request_rev: g2.rev }),
				)
			).status,
		).toBe(409);
		expect(
			(
				await decide(
					c,
					g2,
					decisionBody(g2, ch, "accept", {
						binding_hash: other.req.binding_hash,
					}),
				)
			).status,
		).toBe(409);
		// the Gate-1 key reused for the Gate-2 decision → conflict, never the Gate-1 receipt
		const reuse = await decide(
			c,
			g2,
			decisionBody(g2, ch, "accept", {
				idempotency_key: g.body.idempotency_key,
			}),
		);
		expect([reuse.status, reuse.body.error]).toEqual([
			409,
			"idempotency_conflict",
		]);
		expectNotAccepted(H, g);
		expect(requestRow(H.db, g2.id).challenge_status).toBe("issued");
		expect((await decide(c, g2, decisionBody(g2, ch, "accept"))).status).toBe(
			201,
		);
	});

	test("ADV-G2-09 a truncated diff (over max_diff_bytes) is withheld: reviewer never called, no Gate 2", async () => {
		const H = composedHub({
			fixture: { limits: { max_diff_bytes: 1024 } },
			adapters: (b) =>
				writingImplementer(b, () => ({
					"big.txt": `${"line of text\n".repeat(600)}`,
				})),
		});
		const c = await H.signIn();
		const a = await approveGate1(c, H.fx);
		const v = await waitStage(c, a.taskId, [
			"execution_ended",
			"awaiting_acceptance",
		]);
		expect(v.task.stage).toBe("execution_ended");
		expect(H.calls.review).toBe(0);
		const t = H.db
			.query("SELECT failure_kind FROM managed_tasks WHERE id = ?")
			.get(a.managedTaskId) as any;
		expect(t.failure_kind).toBe("evidence_invalid");
	});

	test("ADV-G2-10 candidate worktree dirtied after Gate 2 opened → 409 integrity_failed (R-A9)", async () => {
		const { H, c, g } = await atGate2();
		const run = H.db
			.query("SELECT workspace_path FROM managed_runs WHERE task_id = ?")
			.get(g.managedTaskId) as any;
		writeFileSync(
			join(run.workspace_path, "agentcity-sim", "attempt-1.md"),
			"edited after review\n",
		);
		const r = await tryAccept(c, g.g2);
		expect([r.status, r.body.error]).toEqual([409, "integrity_failed"]);
		expectNotAccepted(H, g);
	});

	test("ADV-G2-11 open quarantine / engine cancel intent at accept time → 409, nothing accepted", async () => {
		for (const tamper of ["quarantine", "cancel"] as const) {
			// a quarantine whose pid can never be inspected (so the worker cannot release it);
			// every other pid goes to the real host process ops
			const QPID = 2_000_000_001;
			const { H, c, g } = await atGate2({
				processOps: {
					inspect: (pid) =>
						pid === QPID
							? { state: "error", error: "adversarial" }
							: hostProcessOps.inspect(pid),
					groupAlive: (pid) =>
						pid === QPID ? "error" : hostProcessOps.groupAlive(pid),
					terminateGroup: (pid, ms) =>
						pid === QPID
							? Promise.resolve(false)
							: hostProcessOps.terminateGroup(pid, ms),
				},
			});
			if (tamper === "quarantine")
				H.db
					.query(
						"INSERT INTO managed_quarantine (id, task_id, run_id, pid, started, reason, created_at) SELECT 'qua-' || lower(hex(randomblob(16))), id, result_run_id, ?, NULL, 'adversarial', ? FROM managed_tasks WHERE id = ?",
					)
					.run(QPID, new Date().toISOString(), g.managedTaskId);
			else
				H.db
					.query(
						"UPDATE managed_tasks SET cancel_requested_at = ? WHERE id = ?",
					)
					.run(new Date().toISOString(), g.managedTaskId);
			const r = await tryAccept(c, g.g2);
			expect([tamper, r.status]).toEqual([tamper, 409]);
			expectNotAccepted(H, g);
			await H.stop();
		}
	});
});

describe("ADV-EVID evidence tampering, special files, bounded reads", () => {
	test("ADV-EVID-01 coherent diff file + row rewrite → 409; artifact route never serves the forged bytes (also after restart)", async () => {
		const { H, c, g, arts } = await atGate2({ manual: false });
		const diff = named(arts, "diff.patch");
		const original = readFileSync(artPath(H, diff.rel_path), "utf8");
		const forged = "diff --git a/x b/x\n+FORGED-CONTENT\n";
		coherentRewrite(H, diff, forged);
		const shown = await c.get(`/tasks/${g.taskId}/artifacts/${diff.id}`);
		expect(shown.status).toBe(200);
		expect(shown.text).not.toContain("FORGED-CONTENT");
		if (shown.body.text !== null) expect(shown.body.text).toBe(original);
		const r = await tryAccept(c, g.g2);
		expect(r.status).toBe(409);
		expectNotAccepted(H, g);
		// restart: no retained buffer, a fresh verified read must refuse the forged bytes
		await H.stop();
		const B = composedHub({
			reuse: H.fx,
			manual: true,
			credentials: { operator: H.credential, readOnly: H.readOnlyCredential },
		});
		const c2 = await B.signIn();
		const after = await c2.get(`/tasks/${g.taskId}/artifacts/${diff.id}`);
		expect(after.text).not.toContain("FORGED-CONTENT");
		expect(after.body.text).toBeNull();
		expect(["corrupt", "stale", "unknown", "missing"]).toContain(
			after.body.status,
		);
	});

	test("ADV-EVID-02 diff + manifest + run.manifest_hash rewritten coherently → 409", async () => {
		const { H, c, g, arts } = await atGate2();
		const diff = named(arts, "diff.patch");
		const man = named(arts, "manifest.json");
		const forged = "diff --git a/x b/x\n+FORGED\n";
		coherentRewrite(H, diff, forged);
		const m = JSON.parse(readFileSync(artPath(H, man.rel_path), "utf8"));
		m.diff_sha256 = sha(forged);
		const mText = JSON.stringify(m, null, 2);
		coherentRewrite(H, man, mText);
		H.db
			.query("UPDATE managed_runs SET manifest_hash = ? WHERE task_id = ?")
			.run(sha(mText), g.managedTaskId);
		const r = await tryAccept(c, g.g2);
		expect(r.status).toBe(409);
		expectNotAccepted(H, g);
	});

	for (const name of ["changed-files.json", "review-output.json", "review.log"])
		test(`ADV-EVID-03 coherent file + row rewrite of ${name} (outside the manifest) → 409`, async () => {
			const { H, c, g, arts } = await atGate2();
			const a = named(arts, name);
			expect(a).toBeDefined();
			const old = readFileSync(artPath(H, a.rel_path), "utf8");
			coherentRewrite(H, a, old.replace(/.$/s, " ").concat("\n"));
			const r = await tryAccept(c, g.g2);
			expect(r.status).toBe(409);
			expectNotAccepted(H, g);
		});

	test("ADV-EVID-04/05 a forged second approving review row, or the review row edited in place → 409", async () => {
		for (const mode of ["insert", "edit"] as const) {
			const { H, c, g } = await atGate2();
			if (mode === "insert")
				H.db
					.query(
						"INSERT INTO managed_reviews SELECT 'rev-' || lower(hex(randomblob(16))), task_id, run_id, provider, mode, model_requested, model_resolved, session_ref, candidate_sha, manifest_hash, verdict, valid, invalidated_reason, findings, summary, usage, created_at FROM managed_reviews WHERE task_id = ? LIMIT 1",
					)
					.run(g.managedTaskId);
			else
				H.db
					.query(
						"UPDATE managed_reviews SET summary = 'edited by an attacker' WHERE task_id = ?",
					)
					.run(g.managedTaskId);
			const r = await tryAccept(c, g.g2);
			expect([mode, r.status]).toEqual([mode, 409]);
			expectNotAccepted(H, g);
			await H.stop();
		}
	});

	test("ADV-EVID-07/08 artifact or run directory replaced by a symlink → never served, no acceptance", async () => {
		for (const mode of ["file", "dir"] as const) {
			const { H, c, g, arts } = await atGate2();
			const diff = named(arts, "diff.patch");
			const p = artPath(H, diff.rel_path);
			const outside = join(H.fx.dir, `outside-${mode}`);
			if (mode === "file") {
				copyFileSync(p, outside);
				rmSync(p);
				symlinkSync(outside, p);
			} else {
				const runDir = join(p, "..");
				renameSync(runDir, outside);
				symlinkSync(outside, runDir);
			}
			const r = await tryAccept(c, g.g2);
			expect([mode, r.status]).toEqual([mode, 409]);
			expectNotAccepted(H, g);
			await H.stop();
			const B = composedHub({
				reuse: H.fx,
				manual: true,
				credentials: { operator: H.credential, readOnly: H.readOnlyCredential },
			});
			const shown = await (await B.signIn()).get(
				`/tasks/${g.taskId}/artifacts/${diff.id}`,
			);
			expect([mode, shown.body.text]).toEqual([mode, null]);
			await B.stop();
		}
	});

	test("ADV-EVID-09/10 FIFO / directory in place of an artifact: refused promptly, hub stays responsive", async () => {
		for (const mode of ["fifo", "dir"] as const) {
			const { H, c, g, arts } = await atGate2();
			const diff = named(arts, "diff.patch");
			const p = artPath(H, diff.rel_path);
			rmSync(p);
			if (mode === "fifo")
				expect(spawnSync("/usr/bin/mkfifo", [p]).status).toBe(0);
			else mkdirSync(p);
			const t0 = Date.now();
			const accept = tryAccept(c, g.g2);
			const lat: number[] = [];
			for (let i = 0; i < 5; i++) {
				const s = Date.now();
				const h = await http(H.base, "GET", "/healthz");
				expect(h.status).toBe(200);
				lat.push(Date.now() - s);
			}
			const r = await accept;
			expect([mode, r.status]).toEqual([mode, 409]);
			expect(Date.now() - t0).toBeLessThan(5_000);
			expect(Math.max(...lat)).toBeLessThan(250);
			expectNotAccepted(H, g);
			await H.stop();
			const B = composedHub({
				reuse: H.fx,
				manual: true,
				credentials: { operator: H.credential, readOnly: H.readOnlyCredential },
			});
			const s = Date.now();
			const shown = await (await B.signIn()).get(
				`/tasks/${g.taskId}/artifacts/${diff.id}`,
			);
			expect(Date.now() - s).toBeLessThan(1_000);
			expect([mode, shown.body.text]).toEqual([mode, null]);
			await B.stop();
		}
	});

	test("ADV-EVID-19 (R-F5) pending result: retained verified bytes served; once the request is invalidated the route re-verifies from disk (no restart)", async () => {
		const { H, c, g, arts } = await atGate2();
		const diff = named(arts, "diff.patch");
		const original = readFileSync(artPath(H, diff.rel_path), "utf8");
		coherentRewrite(H, diff, "diff --git a/r b/r\n+R-F5-FORGED\n");
		const pending = await c.get(`/tasks/${g.taskId}/artifacts/${diff.id}`);
		expect(pending.text).not.toContain("R-F5-FORGED");
		expect(pending.body.text).toBe(original); // retained, verified copy (OBS-05)
		const r = await tryAccept(c, g.g2);
		expect([r.status, r.body.error]).toEqual([409, "integrity_failed"]);
		expect(requestRow(H.db, g.g2.id).status).toBe("invalidated");
		const after = await c.get(`/tasks/${g.taskId}/artifacts/${diff.id}`);
		expect(after.status).toBe(200);
		expect(after.text).not.toContain("R-F5-FORGED");
		expect(after.body.text).toBeNull();
		expect(after.body.status).not.toBe("verified");
	});

	test("ADV-EVID-11 artifact over the read cap with a matching row length → 409 without reading it", async () => {
		const { H, c, g, arts } = await atGate2();
		const diff = named(arts, "diff.patch");
		coherentRewrite(H, diff, Buffer.alloc(17 * 1024 * 1024, 0x61));
		const r = await tryAccept(c, g.g2);
		expect(r.status).toBe(409);
		expectNotAccepted(H, g);
	});

	test("ADV-EVID-12 file truncated / appended after registration → 409", async () => {
		for (const mode of ["truncate", "append"] as const) {
			const { H, c, g, arts } = await atGate2();
			const diff = named(arts, "diff.patch");
			const p = artPath(H, diff.rel_path);
			const b = readFileSync(p);
			writeFileSync(
				p,
				mode === "truncate"
					? b.subarray(0, Math.max(1, b.length - 5))
					: Buffer.concat([b, Buffer.from("x")]),
			);
			const r = await tryAccept(c, g.g2);
			expect([mode, r.status]).toEqual([mode, 409]);
			expectNotAccepted(H, g);
			await H.stop();
		}
	});

	test("ADV-EVID-13 file swapped inside the decision window (after revalidation): the accepted hash names the verified bytes; the swapped bytes are never served", async () => {
		let swap: (() => void) | null = null;
		const { H, c, g, arts } = await atGate2({
			decisionHooks: {
				beforeTransaction() {
					const f = swap;
					swap = null;
					f?.();
				},
			},
		});
		const diff = named(arts, "diff.patch");
		const p = artPath(H, diff.rel_path);
		const verified = readFileSync(p);
		swap = () => writeFileSync(p, "diff --git a/s b/s\n+SWAPPED-IN-WINDOW\n");
		const r = await tryAccept(c, g.g2);
		// documented residual window (06 NOTES): acceptance binds the envelope hash of the verified read
		expect(r.status).toBe(201);
		const env = JSON.parse(requestRow(H.db, g.g2.id).result_envelope);
		const item = env.artifacts.find((x: any) => x.name === "diff.patch");
		expect(item.sha256).toBe(sha(verified));
		const shown = await c.get(`/tasks/${g.taskId}/artifacts/${diff.id}`);
		expect(shown.text).not.toContain("SWAPPED-IN-WINDOW");
	});

	test("ADV-EVID-14b tampering after acceptance: the accepted original is served from the durable bundle and the current acceptance becomes invalid", async () => {
		// v1.2 contract (CONTRACT_V1_2.md §B/§C): tampered bytes are never served, the accepted
		// original stays available from the bundle, and the current validity turns invalid (sticky).
		const { H, c, g, arts } = await atGate2();
		expect((await tryAccept(c, g.g2)).status).toBe(201);
		const diff = named(arts, "diff.patch");
		const original = readFileSync(artPath(H, diff.rel_path), "utf8");
		coherentRewrite(H, diff, "diff --git a/t b/t\n+POST-ACCEPT-TAMPER\n");
		await H.stop();
		const B = composedHub({
			reuse: H.fx,
			manual: true,
			credentials: { operator: H.credential, readOnly: H.readOnlyCredential },
		});
		const shown = await (await B.signIn()).get(
			`/tasks/${g.taskId}/artifacts/${diff.id}`,
		);
		expect(shown.text).not.toContain("POST-ACCEPT-TAMPER");
		expect(shown.body.text).toBe(original);
		await B.bridge.sweep();
		const detail = await (await B.signIn()).get(`/tasks/${g.taskId}`);
		expect(detail.body.acceptance_validity.status).toBe("invalid");
		expect(detail.body.task.stage).toBe("accepted"); // history unchanged
	});

	test("ADV-EVID-15 row rel_path pointing at a host file → never served", async () => {
		const { H, c, g, arts } = await atGate2();
		const diff = named(arts, "diff.patch");
		// v1.2: the pending result is served only from its verified durable bundle
		const original = readFileSync(artPath(H, diff.rel_path), "utf8");
		const host = join(H.fx.dir, "host-secret.txt");
		writeFileSync(host, "HOST-FILE-CONTENT\n");
		for (const rel of [`../${"../".repeat(6)}etc/hosts`, host]) {
			H.db
				.query("UPDATE managed_artifacts SET rel_path = ? WHERE id = ?")
				.run(rel, diff.id);
			await H.stop().catch(() => null);
			const B = composedHub({
				reuse: H.fx,
				manual: true,
				credentials: { operator: H.credential, readOnly: H.readOnlyCredential },
			});
			const shown = await (await B.signIn()).get(
				`/tasks/${g.taskId}/artifacts/${diff.id}`,
			);
			expect(shown.text).not.toContain("HOST-FILE-CONTENT");
			expect(shown.text).not.toContain("localhost");
			if (shown.status === 200) expect(shown.body.text).toBe(original);
			await B.stop();
		}
		void c;
	});

	test("ADV-EVID-16 an artifact id of another workspace task → 404", async () => {
		const { H, c, g, arts } = await atGate2();
		const other = await openGate1(c, H.fx);
		const r = await c.get(`/tasks/${other.taskId}/artifacts/${arts[0].id}`);
		expect(r.status).toBe(404);
		expect(r.text).not.toContain(arts[0].id);
		void g;
	});

	test("ADV-EVID-17 hostile HTML in evidence is returned as inert JSON text", async () => {
		const H = composedHub({
			adapters: (b) =>
				writingImplementer(b, () => ({
					"page.html": "<script>alert(document.cookie)</script>\n",
				})),
		});
		const c = await H.signIn();
		const g = await toGate2(c, H.fx);
		const diff = named(artifactRows(H.db, g.managedTaskId), "diff.patch");
		const r = await c.get(`/tasks/${g.taskId}/artifacts/${diff.id}`);
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toContain("application/json");
		expect(r.headers.get("x-content-type-options")).toBe("nosniff");
		expect(r.headers.get("cache-control")).toContain("no-store");
		expect(r.body.text).toContain("<script>");
	});

	test("ADV-EVID-18 an unregistered orphan file in the run directory is never evidence", async () => {
		const { H, c, g, arts } = await atGate2();
		writeFileSync(
			join(artPath(H, arts[0].rel_path), "..", "orphan.txt"),
			"ORPHAN\n",
		);
		const v = await c.get(`/tasks/${g.taskId}`);
		expect(v.text).not.toContain("orphan.txt");
		expect((await tryAccept(c, g.g2)).status).toBe(201);
		const env = requestRow(H.db, g.g2.id).result_envelope;
		expect(env).not.toContain("orphan.txt");
	});
});

describe("ADV-ACCEPT human acceptance is separate and executes nothing", () => {
	test("ADV-ACCEPT-01…04 engine stays human_ready, no adapter call / run / git write, second accept refused", async () => {
		const wrapDir = join(process.env.TMPDIR ?? "/tmp", `adv-git-${Date.now()}`);
		mkdirSync(wrapDir, { recursive: true });
		const log = join(wrapDir, "argv.log");
		const wrapper = join(wrapDir, "git");
		writeFileSync(
			wrapper,
			`#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${GIT}" "$@"\n`,
		);
		chmodSync(wrapper, 0o755);
		const { H, c, g } = await atGate2({
			config: (cfg) => ({ ...cfg, git_executable: wrapper }),
		});
		const refs = () =>
			spawnSync(GIT, ["for-each-ref", "--format=%(refname) %(objectname)"], {
				cwd: H.fx.repoPath,
				encoding: "utf8",
			}).stdout;
		const head = () =>
			spawnSync(GIT, ["rev-parse", "HEAD"], {
				cwd: H.fx.repoPath,
				encoding: "utf8",
			}).stdout;
		const status = () =>
			spawnSync(GIT, ["status", "--porcelain"], {
				cwd: H.fx.repoPath,
				encoding: "utf8",
			}).stdout;
		const before = {
			refs: refs(),
			head: head(),
			status: status(),
			calls: { ...H.calls, reviewInputs: H.calls.reviewInputs.length },
			runs: count(H.db, "SELECT count(*) AS n FROM managed_runs"),
			arts: count(H.db, "SELECT count(*) AS n FROM managed_artifacts"),
		};
		const logBefore = readFileSync(log, "utf8").split("\n").length;
		const r = await tryAccept(c, g.g2);
		expect(r.status).toBe(201);
		await Bun.sleep(300);
		const after = await taskView(c, g.taskId);
		expect(after.task.stage).toBe("accepted");
		expect(after.engine.state).toBe("human_ready");
		expect(requestRow(H.db, g.g2.id).status).toBe("accepted");
		expect({
			refs: refs(),
			head: head(),
			status: status(),
			calls: { ...H.calls, reviewInputs: H.calls.reviewInputs.length },
			runs: count(H.db, "SELECT count(*) AS n FROM managed_runs"),
			arts: count(H.db, "SELECT count(*) AS n FROM managed_artifacts"),
		}).toEqual(before);
		const during = readFileSync(log, "utf8")
			.split("\n")
			.slice(logBefore - 1)
			.filter(Boolean);
		const writes = during.filter((l) =>
			/^(-c \S+ )*(push|merge|fetch|pull|remote|update-ref|checkout|switch|commit|reset|rebase|tag|am|apply|cherry-pick|worktree add|branch -[dDmM])\b/.test(
				l.replace(/^(-C \S+ )/, ""),
			),
		);
		expect(writes).toEqual([]);
		// a second acceptance, a rerun or a new version after acceptance are all refused
		const again = await tryAccept(c, g.g2);
		expect(again.status).toBe(409);
		expect(
			(
				await c.post(`/tasks/${g.taskId}/rerun`, {
					expected_rev: after.task.rev,
					proposal_id: after.task.current_proposal_id,
				})
			).status,
		).toBe(409);
		expect(
			(
				await c.post(`/tasks/${g.taskId}/proposals`, {
					expected_rev: after.task.rev,
				})
			).status,
		).toBe(409);
		expect(
			count(
				H.db,
				"SELECT count(*) AS n FROM managed_decisions WHERE action = 'accept'",
			),
		).toBe(1);
	});

	test("ADV-ACCEPT-05 client-supplied authority fields are rejected", async () => {
		const { H, c, g } = await atGate2();
		const ch = await issueChallenge(
			c,
			(await taskView(c, g.taskId)).approval_requests.find(
				(r: any) => r.id === g.g2.id,
			),
		);
		const v = await taskView(c, g.taskId);
		const req = v.approval_requests.find((r: any) => r.id === g.g2.id);
		for (const extra of [
			{ accepted: true },
			{ result_envelope_hash: "c".repeat(64) },
			{ eligible: true },
			{ operator_id: "operator:edward" },
		]) {
			const r = await decide(c, req, {
				...decisionBody(req, ch, "accept"),
				...extra,
			});
			expect([Object.keys(extra)[0], r.status]).toEqual([
				Object.keys(extra)[0],
				400,
			]);
		}
		expectNotAccepted(H, g);
	});

	test("ADV-INVAL-07/08 Gate-2 request changes / reject queue nothing; changes need a new version + Gate 1", async () => {
		for (const action of ["request_changes", "reject"] as const) {
			const { H, c, g } = await atGate2();
			const v = await taskView(c, g.taskId);
			const req = v.approval_requests.find((r: any) => r.id === g.g2.id);
			const ch = await issueChallenge(c, req);
			const runsBefore = count(H.db, "SELECT count(*) AS n FROM managed_runs");
			const r = await decide(c, req, decisionBody(req, ch, action));
			expect(r.status).toBe(201);
			await Bun.sleep(200);
			const after = await taskView(c, g.taskId);
			expect(after.task.stage).toBe(
				action === "reject" ? "rejected" : "changes_requested",
			);
			expect(after.engine.state).toBe("human_ready");
			expect(count(H.db, "SELECT count(*) AS n FROM managed_runs")).toBe(
				runsBefore,
			);
			expect(
				count(
					H.db,
					"SELECT count(*) AS n FROM managed_tasks WHERE state IN ('queued','executing','verifying','reviewing','repairing')",
				),
			).toBe(0);
			if (action === "request_changes") {
				// the old Gate-1 decision cannot run anything new: publishing opens a fresh Gate 1
				const pub = await c.post(`/tasks/${g.taskId}/proposals`, {
					expected_rev: after.task.rev,
				});
				expect(pub.status).toBe(201);
				const v2 = await taskView(c, g.taskId);
				const r2 = v2.approval_requests.find(
					(x: any) => x.kind === "run" && x.status === "pending",
				);
				expect(r2.managed_task_id).not.toBe(g.managedTaskId);
				expect(
					count(
						H.db,
						"SELECT count(*) AS n FROM managed_tasks WHERE id = ? AND state = 'draft'",
						r2.managed_task_id,
					),
				).toBe(1);
			} else {
				expect(
					(
						await c.post(`/tasks/${g.taskId}/proposals`, {
							expected_rev: after.task.rev,
						})
					).status,
				).toBe(409);
			}
			await H.stop();
		}
	});
});

describe("sanity", () => {
	test("waitFor helper", async () => {
		expect(await waitFor(() => 1)).toBe(1);
	});
});
