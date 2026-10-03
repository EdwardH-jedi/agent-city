// v1.2 §C current acceptance validity — the checks themselves, against REAL sealed attempts (existing
// Orchestrator, fake adapters, disposable fixture repo) and a bundle published from the sealer's
// buffers. Policy "both": evidence/candidate damage ⇒ invalid; a check that cannot run ⇒ unknown.
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	EvidenceBundleRow,
	SealedResult,
} from "@agent-city/schema/workspace-m1";
import { publishSealedEvidence, SEALED_DIR } from "./bundle.ts";
import {
	cleanupSealFixtures,
	type Harness,
	humanReadyRun,
} from "./seal-fixture.ts";
import { createEvidenceSealer } from "./sealer.ts";
import {
	type AcceptanceSubject,
	checkAcceptance,
	checkAcceptedCandidate,
	checkAcceptedEvidence,
	patchFor,
} from "./validity.ts";

afterAll(cleanupSealFixtures);

async function accepted(): Promise<{
	h: Harness;
	s: SealedResult;
	bundle: EvidenceBundleRow;
	subject: AcceptanceSubject;
}> {
	const h = await humanReadyRun();
	const sealer = createEvidenceSealer({
		db: h.fx.db,
		config: h.fx.config,
		reads: h.reads,
	});
	const s = await sealer.seal(h.input);
	const bundle = publishSealedEvidence(
		h.fx.config.artifacts_root,
		s,
		"2026-10-02T08:00:00.000Z",
	);
	return {
		h,
		s,
		bundle,
		subject: {
			request: {
				result_envelope: s.envelope,
				result_envelope_hash: s.envelope_hash,
				evidence_bundle_digest: bundle.digest,
			},
			digest: bundle.digest,
			bundle,
		},
	};
}

const deps = (h: Harness) => ({ db: h.fx.db, config: h.fx.config });

describe("checkAcceptedEvidence (bundle + source artifacts, synchronous)", () => {
	test("clean control: valid", async () => {
		const { h, subject } = await accepted();
		expect(checkAcceptedEvidence(deps(h), subject)).toEqual({
			status: "valid",
			reason: null,
			detail: null,
		});
		expect(await checkAcceptance(deps(h), subject)).toEqual({
			status: "valid",
			reason: null,
			detail: null,
		});
	});

	test("source file replaced / truncated → source_evidence_changed; deleted → source_evidence_missing", async () => {
		const { h, subject } = await accepted();
		h.writeFile("diff.patch", "diff --git a/z b/z\n+REPLACED\n");
		const changed = checkAcceptedEvidence(deps(h), subject);
		expect([changed.status, changed.reason]).toEqual([
			"invalid",
			"source_evidence_changed",
		]);
		expect(changed.detail).toContain("diff.patch");
		expect(changed.detail).not.toContain("REPLACED");
		rmSync(h.path("diff.patch"));
		const missing = checkAcceptedEvidence(deps(h), subject);
		expect([missing.status, missing.reason]).toEqual([
			"invalid",
			"source_evidence_missing",
		]);
	});

	test("coherent file + row rewrite of the mutable store → source_evidence_changed; row deleted → missing", async () => {
		const { h, subject } = await accepted();
		h.rewrite("verify-1-fixture-check.log", "coherently forged log\n");
		const v = checkAcceptedEvidence(deps(h), subject);
		expect([v.status, v.reason]).toEqual([
			"invalid",
			"source_evidence_changed",
		]);
		const { h: h2, subject: s2 } = await accepted();
		h2.sql(
			"DELETE FROM managed_artifacts WHERE id = ?",
			h2.row("manifest.json").id,
		);
		const gone = checkAcceptedEvidence(deps(h2), s2);
		expect([gone.status, gone.reason]).toEqual([
			"invalid",
			"source_evidence_missing",
		]);
	});

	test("bundle missing / corrupt / bound to another request → bundle_missing / bundle_corrupt / bundle_binding_mismatch", async () => {
		const { h, subject, bundle } = await accepted();
		const file = join(
			h.fx.config.artifacts_root,
			SEALED_DIR,
			`${bundle.digest}.bundle`,
		);
		writeFileSync(file, "corrupt");
		expect(checkAcceptedEvidence(deps(h), subject).reason).toBe(
			"bundle_corrupt",
		);
		rmSync(file);
		expect(checkAcceptedEvidence(deps(h), subject).reason).toBe(
			"bundle_missing",
		);
		const other = { ...subject, digest: "ab".repeat(32) };
		expect(checkAcceptedEvidence(deps(h), other).reason).toBe(
			"bundle_binding_mismatch",
		);
	});
});

describe("checkAcceptedCandidate (git, trusted repo)", () => {
	test("commit gone → candidate_unavailable; tree differs → candidate_mismatch", async () => {
		const { h, s } = await accepted();
		expect((await checkAcceptedCandidate(deps(h), s.envelope)).status).toBe(
			"valid",
		);
		const gone = await checkAcceptedCandidate(deps(h), {
			...s.envelope,
			candidate_sha: "1".repeat(40),
		});
		expect([gone.status, gone.reason]).toEqual([
			"invalid",
			"candidate_unavailable",
		]);
		const other = await checkAcceptedCandidate(deps(h), {
			...s.envelope,
			candidate_tree: "2".repeat(40),
		});
		expect([other.status, other.reason]).toEqual([
			"invalid",
			"candidate_mismatch",
		]);
	});

	test("a check that cannot run is unknown (never valid, never invalid): repo not configured / not a checkout / git did not run", async () => {
		const { h, s, subject } = await accepted();
		const noRepo = { ...h.fx.config, repos: [] };
		const a = await checkAcceptedCandidate(
			{ db: h.fx.db, config: noRepo },
			s.envelope,
		);
		expect([a.status, a.reason]).toEqual([
			"unknown",
			"verification_unavailable",
		]);
		const badPath = {
			...h.fx.config,
			repos: h.fx.config.repos.map((r) => ({
				...r,
				path: join(h.fx.dir, "nope"),
			})),
		};
		expect(
			(
				await checkAcceptedCandidate(
					{ db: h.fx.db, config: badPath },
					s.envelope,
				)
			).status,
		).toBe("unknown");
		const noGit = {
			db: h.fx.db,
			config: h.fx.config,
			gitFor: () => async () => ({
				spawned: false,
				exitCode: null,
				signal: null,
				stdout: "",
				stderr: "",
				stdoutTruncated: false,
				stderrTruncated: false,
				timedOut: false,
				aborted: false,
			}),
		} as unknown as Parameters<typeof checkAcceptedCandidate>[0];
		expect((await checkAcceptedCandidate(noGit, s.envelope)).status).toBe(
			"unknown",
		);
		// the full check: evidence fine + candidate unknown → unknown; evidence invalid wins over unknown
		expect((await checkAcceptance(noGit, subject)).status).toBe("unknown");
		h.writeFile("diff.patch", "changed\n");
		expect((await checkAcceptance(noGit, subject)).reason).toBe(
			"source_evidence_changed",
		);
	});
});

test("patchFor: invalid stamps first_invalid_at; valid / unknown never do", () => {
	const at = "2026-10-02T08:00:00.000Z";
	expect(patchFor({ status: "valid", reason: null, detail: null }, at)).toEqual(
		{
			status: "valid",
			reason: null,
			detail: null,
			checked_at: at,
			first_invalid_at: null,
		},
	);
	expect(
		patchFor({ status: "invalid", reason: "bundle_missing", detail: "x" }, at)
			.first_invalid_at,
	).toBe(at);
	expect(
		patchFor(
			{ status: "unknown", reason: "verification_unavailable", detail: "x" },
			at,
		).first_invalid_at,
	).toBeNull();
});
