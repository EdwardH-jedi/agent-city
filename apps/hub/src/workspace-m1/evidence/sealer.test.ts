// EvidenceSealer against REAL human_ready attempts (existing Orchestrator, fake adapters, disposable
// fixture repo). Every tamper below is an ordinary file or row change of the kind the spec lists.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SealedResult } from "@agent-city/schema/workspace-m1";
import { sha256Hex } from "@agent-city/schema/workspace-m1/hash";
import { redactDiff } from "../../managed/evidence.ts";
import { SealError } from "./run-evidence.ts";
import {
	cleanupSealFixtures,
	type Harness,
	humanReadyRun,
} from "./seal-fixture.ts";
import {
	createEvidenceSealer,
	type EvidenceSealerDeps,
	gate2Check,
	revalidateForGate2,
} from "./sealer.ts";

afterAll(cleanupSealFixtures);

const sealerFor = (h: Harness, over: Partial<EvidenceSealerDeps> = {}) =>
	createEvidenceSealer({
		db: h.fx.db,
		config: h.fx.config,
		reads: h.reads,
		...over,
	});

async function sealCode(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "sealed";
	} catch (err) {
		if (err instanceof SealError) return err.code;
		throw err;
	}
}

const status = (s: SealedResult, name: string) =>
	s.envelope.artifacts.find((a) => a.name === name)?.status;

const canary = (tag: string) => `CANARY-${tag}-${"Rk4p".repeat(3)}`;

describe("clean control", () => {
	test("a real human_ready attempt seals verified and eligible; sealing is deterministic", async () => {
		const h = await humanReadyRun();
		const sealer = sealerFor(h);
		const a = await sealer.seal(h.input);
		expect(a.eligibility).toEqual({
			eligible: true,
			evidence_status: "verified",
			reasons: [],
		});
		expect(a.envelope_hash).toBe(sha256Hex(a.canonical));
		expect(a.envelope.evidence_status).toBe("verified");
		expect(a.envelope.artifacts.every((x) => x.status === "verified")).toBe(
			true,
		);
		expect(a.envelope.artifacts.map((x) => x.name)).toEqual([
			"changed-files.json",
			"diff.patch",
			"implementation.log",
			"manifest.json",
			"review-output.json",
			"review.log",
			"verify-1-fixture-check.log",
		]);
		expect(a.envelope.verification.map((c) => c.name)).toEqual([
			"fixture-check",
		]);
		expect(a.envelope.review.verdict).toBe("approve");
		expect(a.envelope.candidate_sha).toBe(h.run.candidate_sha as string);
		expect(a.problems).toEqual([]);
		const b = await sealer.seal(h.input);
		expect(b.envelope_hash).toBe(a.envelope_hash);
		expect(b.canonical).toBe(a.canonical);
		expect(gate2Check({ result_envelope_hash: a.envelope_hash }, b)).toEqual({
			ok: true,
		});
	});

	test("Gate-2 revalidation re-derives its inputs from the proposal/decision rows and matches", async () => {
		const h = await humanReadyRun();
		const sealer = sealerFor(h);
		const a = await sealer.seal(h.input);
		const r = await revalidateForGate2(
			sealer,
			h.requestFor(a.envelope, a.envelope_hash),
		);
		expect(r.ok).toBe(true);
		// a decision row for another task cannot authorize this result
		const forged = sealerFor(h, {
			reads: { ...h.reads, getDecision: () => null },
		});
		expect(
			await revalidateForGate2(
				forged,
				h.requestFor(a.envelope, a.envelope_hash),
			),
		).toEqual({
			ok: false,
			code: "integrity_failed",
			seal_error: "input_mismatch",
		});
		expect(
			await sealCode(
				sealerFor(h, { reads: undefined }).revalidate(
					h.requestFor(a.envelope, a.envelope_hash),
				),
			),
		).toBe("revalidation_unavailable");
	});
});

describe("tampering is detected", () => {
	test("exact-byte mismatch (same length) in a verification log", async () => {
		const h = await humanReadyRun();
		const sealer = sealerFor(h);
		const before = await sealer.seal(h.input);
		const p = h.path("verify-1-fixture-check.log");
		const bytes = Buffer.from(await Bun.file(p).arrayBuffer());
		bytes[0] = (bytes[0] as number) ^ 1;
		writeFileSync(p, bytes);
		const after = await sealer.seal(h.input);
		expect(status(after, "verify-1-fixture-check.log")).toBe("corrupt");
		expect(after.eligibility.eligible).toBe(false);
		expect(after.eligibility.reasons).toContain("evidence_not_verified");
		expect(
			gate2Check({ result_envelope_hash: before.envelope_hash }, after),
		).toEqual({
			ok: false,
			code: "integrity_failed",
		});
	});

	test("file replaced after sealing: Gate 2 refuses (one hash comparison)", async () => {
		const h = await humanReadyRun();
		const sealer = sealerFor(h);
		const sealed = await sealer.seal(h.input);
		const original = await Bun.file(h.path("diff.patch")).text();
		h.writeFile("diff.patch", original.replace(/\+/g, "-"));
		const r = await revalidateForGate2(
			sealer,
			h.requestFor(sealed.envelope, sealed.envelope_hash),
		);
		expect(r).toMatchObject({ ok: false, code: "integrity_failed" });
	});

	test("coherent file + row + manifest rewrite (C5) is caught by the review binding and the git recheck", async () => {
		const h = await humanReadyRun();
		const forged = `${await Bun.file(h.path("diff.patch")).text()}+forged line\n`;
		h.rewrite("diff.patch", forged);
		h.remanifest((m) => {
			m.diff_sha256 = sha256Hex(forged);
		});
		const s = await sealerFor(h).seal(h.input);
		expect(s.eligibility.eligible).toBe(false);
		expect(s.eligibility.reasons).toContain("review_binding_mismatch");
		expect(status(s, "diff.patch")).toBe("corrupt"); // not this candidate's diff
		expect(status(s, "review-output.json")).toBe("stale");
	});

	test("…and also rewriting the review rows/output leaves the forged diff corrupt", async () => {
		const h = await humanReadyRun();
		const forged = `${await Bun.file(h.path("diff.patch")).text()}+forged line\n`;
		h.rewrite("diff.patch", forged);
		h.remanifest(
			(m) => {
				m.diff_sha256 = sha256Hex(forged);
			},
			{ reviews: true },
		);
		const s = await sealerFor(h).seal(h.input);
		expect(status(s, "diff.patch")).toBe("corrupt");
		expect(s.eligibility.reasons).toEqual(["evidence_not_verified"]);
	});

	test("swapped rows (paths exchanged between two artifacts)", async () => {
		const h = await humanReadyRun();
		const a = h.row("implementation.log");
		const b = h.row("review.log");
		h.sql(
			"UPDATE managed_artifacts SET rel_path = ? WHERE id = ?",
			b.rel_path,
			a.id,
		);
		h.sql(
			"UPDATE managed_artifacts SET rel_path = ? WHERE id = ?",
			a.rel_path,
			b.id,
		);
		const s = await sealerFor(h).seal(h.input);
		expect(status(s, "implementation.log")).toBe("corrupt");
		expect(status(s, "review.log")).toBe("corrupt");
		expect(s.eligibility.eligible).toBe(false);
	});

	test("a deleted row leaves a required item missing", async () => {
		const h = await humanReadyRun();
		h.sql(
			"DELETE FROM managed_artifacts WHERE id = ?",
			h.row("verify-1-fixture-check.log").id,
		);
		const s = await sealerFor(h).seal(h.input);
		expect(status(s, "verify-1-fixture-check.log")).toBe("missing");
		expect(s.envelope.evidence_status).toBe("missing");
		expect(s.eligibility.eligible).toBe(false);
	});

	test("manifest omission (coherently rebuilt without the check) → required check missing", async () => {
		const h = await humanReadyRun();
		h.remanifest(
			(m) => {
				m.verification = [];
			},
			{ reviews: true },
		);
		const s = await sealerFor(h).seal(h.input);
		expect(status(s, "verify-1-fixture-check.log")).toBe("corrupt"); // not in the manifest
		expect(s.eligibility.reasons).toEqual(
			expect.arrayContaining([
				"evidence_not_verified",
				"required_check_missing",
			]),
		);
	});

	test("an unexpected row in the attempt makes the unit corrupt (UNIQUE(run_id, name) already forbids duplicates)", async () => {
		const h = await humanReadyRun();
		const l = h.row("review.log");
		h.sql(
			"INSERT INTO managed_artifacts (id, task_id, run_id, kind, name, rel_path, sha256, byte_len, truncated, candidate_sha, meta, created_at) SELECT ?, task_id, run_id, kind, 'notes.txt', rel_path, sha256, byte_len, truncated, candidate_sha, meta, created_at FROM managed_artifacts WHERE id = ?",
			"art-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
			l.id,
		);
		const s = await sealerFor(h).seal(h.input);
		expect(status(s, "notes.txt")).toBe("corrupt");
		expect(s.eligibility.eligible).toBe(false);
	});
});

describe("wrong candidate / attempt / review", () => {
	test("wrong attempt, result run swapped, attempt beyond the repair policy, moved candidate", async () => {
		const h = await humanReadyRun();
		const sealer = sealerFor(h);
		expect(
			await sealCode(
				sealer.seal({
					...h.input,
					run_id: "run-00000000-0000-4000-8000-000000000000",
				}),
			),
		).toBe("run_not_result");
		h.sql("UPDATE managed_runs SET attempt_no = 2 WHERE id = ?", h.run.id);
		expect(await sealCode(sealer.seal(h.input))).toBe("attempt_out_of_range");
		h.sql("UPDATE managed_runs SET attempt_no = 1 WHERE id = ?", h.run.id);
		h.sql(
			"UPDATE managed_runs SET candidate_sha = ? WHERE id = ?",
			h.task.base_sha,
			h.run.id,
		);
		expect(await sealCode(sealer.seal(h.input))).toBe("candidate_mutated");
	});

	test("seal inputs that do not hash to their claims are refused", async () => {
		const h = await humanReadyRun();
		const sealer = sealerFor(h);
		expect(
			await sealCode(
				sealer.seal({ ...h.input, proposal_hash: "0".repeat(64) }),
			),
		).toBe("input_mismatch");
		expect(
			await sealCode(
				sealer.seal({
					...h.input,
					execution_binding: {
						...h.input.execution_binding,
						policy_hash: "1".repeat(64),
					},
				}),
			),
		).toBe("input_mismatch");
	});

	test("attempt manifest naming another attempt is stale", async () => {
		const h = await humanReadyRun();
		h.remanifest(
			(m) => {
				m.attempt_no = 2;
			},
			{ reviews: true },
		);
		const s = await sealerFor(h).seal(h.input);
		expect(status(s, "manifest.json")).toBe("stale");
		expect(s.eligibility.eligible).toBe(false);
	});

	test("zero reviews → no envelope (no vacuous pass, L-06)", async () => {
		const h = await humanReadyRun();
		h.sql("DELETE FROM managed_reviews WHERE run_id = ?", h.run.id);
		expect(await sealCode(sealerFor(h).seal(h.input))).toBe("review_missing");
	});

	test("invalid / rejecting / swapped review rows are ineligible", async () => {
		const h = await humanReadyRun();
		h.sql("UPDATE managed_reviews SET valid = 0 WHERE run_id = ?", h.run.id);
		let s = await sealerFor(h).seal(h.input);
		expect(s.eligibility.reasons).toContain("review_invalid");
		h.sql(
			"UPDATE managed_reviews SET valid = 1, verdict = 'reject' WHERE run_id = ?",
			h.run.id,
		);
		s = await sealerFor(h).seal(h.input);
		expect(s.eligibility.reasons).toEqual(
			expect.arrayContaining(["review_not_approving", "evidence_not_verified"]),
		);
		expect(status(s, "review-output.json")).toBe("corrupt"); // row ≠ stored output
		h.sql(
			"UPDATE managed_reviews SET verdict = 'approve', manifest_hash = ? WHERE run_id = ?",
			"9".repeat(64),
			h.run.id,
		);
		s = await sealerFor(h).seal(h.input);
		expect(s.eligibility.reasons).toContain("review_binding_mismatch");
	});
});

describe("truncated / withheld / oversized / special files", () => {
	test("truncated diff (coherently recorded) blocks acceptance", async () => {
		const h = await humanReadyRun();
		h.sql(
			"UPDATE managed_artifacts SET truncated = 1 WHERE id = ?",
			h.row("diff.patch").id,
		);
		h.remanifest(
			(m) => {
				m.diff_truncated = true;
			},
			{ reviews: true },
		);
		const s = await sealerFor(h).seal(h.input);
		expect(status(s, "diff.patch")).toBe("truncated");
		expect(s.envelope.evidence_status).toBe("truncated");
		expect(s.eligibility.eligible).toBe(false);
	});

	test("omitted-hunk secret: the legacy line-based diff is withheld; the complete-context disclosure verifies", async () => {
		const body = Array.from(
			{ length: 12 },
			(_, i) => `  line-${i}-${canary(`B${i}`)}`,
		);
		const yaml = (b: string[]) =>
			["name: x", "client_secret: |", ...b, "tail: t", ""].join("\n");
		const h = await humanReadyRun({ base: { "config/app.yaml": yaml(body) } });
		const changed = [...body];
		changed[9] = `  line-9-${canary("NEW")}`;
		const legacy = await h.recandidate(
			{ "config/app.yaml": yaml(changed) },
			(raw) => redactDiff(raw),
		);
		expect(redactDiff(legacy.raw)).toContain(canary("B8")); // the gap is real here
		const s = await sealerFor(h).seal(h.input);
		expect(status(s, "diff.patch")).toBe("withheld");
		expect(s.envelope.evidence_status).toBe("withheld");
		expect(s.eligibility.eligible).toBe(false);

		const h2 = await humanReadyRun({ base: { "config/app.yaml": yaml(body) } });
		await h2.recandidate({ "config/app.yaml": yaml(changed) }, (_raw, d) => {
			if (d.status !== "disclosed") throw new Error("expected disclosed");
			return d.text;
		});
		const ok = await sealerFor(h2).seal(h2.input);
		expect(status(ok, "diff.patch")).toBe("verified");
		expect(ok.eligibility.eligible).toBe(true);
	});

	test("a diff whose complete-context disclosure is withheld (binary) is withheld", async () => {
		const h = await humanReadyRun();
		await h.recandidate(
			{ "assets/blob.bin": Uint8Array.from([0, 1, 2, 3]) },
			(raw) => raw,
		);
		const s = await sealerFor(h).seal(h.input);
		expect(status(s, "diff.patch")).toBe("withheld");
		expect(s.eligibility.eligible).toBe(false);
	});

	test("oversized artifacts and an exhausted byte budget are never read and never verified", async () => {
		const h = await humanReadyRun();
		const s = await sealerFor(h, { limits: { max_artifact_bytes: 16 } }).seal(
			h.input,
		);
		expect(s.envelope.artifacts.some((a) => a.status === "unknown")).toBe(true);
		expect(s.eligibility.eligible).toBe(false);
		const t = await sealerFor(h, { limits: { max_total_bytes: 64 } }).seal(
			h.input,
		);
		expect(t.eligibility.eligible).toBe(false);
		expect(
			await sealCode(
				sealerFor(h, { limits: { max_artifacts: 3 } }).seal(h.input),
			),
		).toBe("too_many_artifacts");
	});

	test("FIFO, symlink and directory in place of artifacts: bounded, no hang, corrupt", async () => {
		const h = await humanReadyRun();
		const fifo = h.path("verify-1-fixture-check.log");
		rmSync(fifo);
		expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
		const link = h.path("review.log");
		rmSync(link);
		symlinkSync(h.path("implementation.log"), link);
		const dir = h.path("changed-files.json");
		rmSync(dir);
		mkdirSync(dir);
		const t0 = Date.now();
		const s = await sealerFor(h).seal(h.input);
		expect(Date.now() - t0).toBeLessThan(10_000);
		expect(status(s, "verify-1-fixture-check.log")).toBe("corrupt");
		expect(status(s, "review.log")).toBe("corrupt");
		expect(status(s, "changed-files.json")).toBe("corrupt");
		expect(s.eligibility.eligible).toBe(false);
		expect(JSON.stringify(s)).not.toContain(h.fx.dir); // no host paths in envelope/problems
	});

	test("a mutated candidate worktree (R-A9) fails sealing", async () => {
		const h = await humanReadyRun();
		writeFileSync(join(h.run.workspace_path as string, "stray.txt"), "x\n");
		expect(await sealCode(sealerFor(h).seal(h.input))).toBe(
			"candidate_mutated",
		);
	});
});
