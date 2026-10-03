// EvidenceSealer (ports.ts, role 06): builds the canonical agentcity.result/v1 envelope of one
// human_ready attempt from FRESH, bounded, verified reads, and re-seals it for Gate 2.
//
// seal(input):
//   1. input coherence: proposal_hash = H(proposal), execution_binding_hash = H(binding), the
//      binding names this proposal, managed task and base;
//   2. engine rows: the managed task (same repo/base, simulated, result_run_id = run_id) and the
//      attempt (same task/base, candidate + manifest present, attempt ≤ 1 + max_repairs);
//   3. git (trusted repo path from config, immutable objects): the candidate is a commit, its tree;
//      the candidate worktree (inside workspace_root) is still exactly the candidate (R-A9);
//   4. one verified read of every artifact (run-evidence.ts) → per-item EvidenceStatus;
//   5. the attempt's review row(s): zero → no envelope (L-06, never a vacuous pass); more than one
//      → review output `corrupt`; the chosen row is hashed as a ReviewRecord;
//   6. envelope → seal (strict schema, canonical, sha256) → eligibility; verified buffers are
//      retained under the envelope hash and attached to the result (durable bundle, v1.2 §B).
//      v1.2 (CONTRACT_V1_2.md §A): a v1.2 proposal seals `agentcity.result/v1.2` with
//      `criterion_coverage = deriveCriterionCoverage(proposal.coverage_plan, envelope)` (the pure
//      derivation, never inferred); eligibility is ALWAYS `resultEligibilityV1_2(envelope, proposal)`,
//      so a legacy v1 proposal seals a v1 envelope that is ineligible (`criteria_unmapped`).
// No DB writes; no I/O inside a transaction (async; the caller must not hold one). Failures that
// leave no representable envelope reject with SealError (fixed code); callers treat any rejection
// as `evidence_unavailable` / `integrity_failed`.
import type { Database } from "bun:sqlite";
import { realpathSync, statSync } from "node:fs";
import {
	type AnyResultEnvelope,
	type ApprovalRequestRow,
	deriveCriterionCoverage,
	type EnvelopeArtifact,
	type EnvelopeCheck,
	type EvidenceSealer,
	isProposalV1_2,
	type ManagedDecisionRow,
	type ManagedProposalRow,
	overallEvidenceStatus,
	RESULT_CONTRACT,
	RESULT_CONTRACT_V1_2,
	REVIEW_RECORD_CONTRACT,
	type ResultEnvelope,
	type ReviewRecord,
	resultEligibilityV1_2,
	type SealedResult,
	type SealInput,
} from "@agent-city/schema/workspace-m1";
import {
	hashesEqual,
	reviewRecordHash,
	sealAnyProposal,
	sealAnyResultEnvelope,
	sealExecutionBinding,
} from "@agent-city/schema/workspace-m1/hash";
import type { ManagedConfig } from "../../managed/config.ts";
import { isInside } from "../../managed/git.ts";
import { getRun, getTask } from "../../managed/store.ts";
import { attachSealedEvidence } from "./bundle.ts";
import type { GitRunner } from "./context-loader.ts";
import { hardenedGitRunner } from "./git-runner.ts";
import { RetainedEvidenceStore } from "./retained.ts";
import {
	type CollectDeps,
	candidateTreeOf,
	collectRunEvidence,
	type EvidenceLimits,
	evidenceLimits,
	SealError,
} from "./run-evidence.ts";

/** What revalidation reads from the workspace tables (role 02 implements WorkspaceReads). */
export interface RevalidationReads {
	getProposal(id: string): ManagedProposalRow | null;
	getDecision(id: string): ManagedDecisionRow | null;
	getApprovalRequest(id: string): ApprovalRequestRow | null;
}

export interface EvidenceSealerDeps {
	db: Database;
	config: ManagedConfig;
	/** Needed by revalidate() only. */
	reads?: RevalidationReads;
	/** Read-only git runner for a directory (default: hardenedGitRunner with config.git_executable). */
	gitFor?: (cwd: string) => GitRunner;
	limits?: Partial<EvidenceLimits>;
	/** Where verified buffers are retained (default: a private store). */
	retained?: RetainedEvidenceStore;
	/** Recompute the diff disclosure from git (default true). */
	recheckDisclosure?: boolean;
	now?: () => number;
}

export interface EvidenceSealerImpl extends EvidenceSealer {
	readonly retained: RetainedEvidenceStore;
}

const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;

export function defaultGitFor(config: ManagedConfig) {
	return (cwd: string) =>
		hardenedGitRunner({
			git: config.git_executable,
			cwd,
			killGraceMs: config.limits.kill_grace_ms,
		});
}

export function createEvidenceSealer(
	deps: EvidenceSealerDeps,
): EvidenceSealerImpl {
	const retained = deps.retained ?? new RetainedEvidenceStore();
	const now = deps.now ?? Date.now;
	const gitFor = deps.gitFor ?? defaultGitFor(deps.config);
	const limits = evidenceLimits(deps.config, deps.limits);

	async function seal(input: SealInput): Promise<SealedResult> {
		const deadline = now() + limits.deadline_ms;
		const fail = (code: ConstructorParameters<typeof SealError>[0]): never => {
			throw new SealError(code);
		};
		const timeCheck = () => {
			if (now() > deadline) fail("timeout");
		};

		// 1. input coherence
		let proposalHash: string;
		let binding: ReturnType<typeof sealExecutionBinding>;
		try {
			// v1 | v1.2 (a v1.2 snapshot whose criterion ids do not match their texts is refused)
			proposalHash = sealAnyProposal(input.proposal).hash;
			binding = sealExecutionBinding(input.execution_binding);
		} catch {
			return fail("input_mismatch");
		}
		const p = input.proposal;
		const b = binding.value;
		if (
			!hashesEqual(proposalHash, input.proposal_hash) ||
			!hashesEqual(binding.hash, input.execution_binding_hash) ||
			input.execution_binding.contract !== b.contract ||
			b.proposal_id !== p.proposal_id ||
			b.proposal_hash !== input.proposal_hash ||
			b.managed_task_id !== input.managed_task_id ||
			b.base_sha !== p.base_sha ||
			p.workspace_task_id !== input.workspace_task_id
		)
			fail("input_mismatch");

		// 2. engine rows (synchronous reads; never inside the caller's transaction)
		const task = getTask(deps.db, input.managed_task_id);
		if (!task) return fail("task_not_found");
		if (
			task.repo_id !== p.repo_id ||
			task.base_sha !== p.base_sha ||
			task.execution_mode !== "simulated"
		)
			fail("binding_mismatch");
		if (task.result_run_id !== input.run_id) fail("run_not_result");
		const run = getRun(deps.db, input.run_id);
		if (!run) return fail("run_not_found");
		if (run.task_id !== task.id || run.base_sha !== p.base_sha)
			fail("binding_mismatch");
		const candidate = run.candidate_sha;
		const manifestHash = run.manifest_hash;
		const parent = run.parent_sha;
		if (
			!candidate ||
			!SHA.test(candidate) ||
			!manifestHash ||
			!HASH.test(manifestHash) ||
			!parent ||
			!SHA.test(parent)
		)
			return fail("candidate_missing");
		const maxRepairs = p.repair_policy.max_repairs;
		if (
			(run.attempt_no !== 1 && run.attempt_no !== 2) ||
			run.attempt_no > 1 + maxRepairs
		)
			fail("attempt_out_of_range");
		if (run.attempt_no === 1 && parent !== p.base_sha) fail("binding_mismatch");

		// 3. git: immutable candidate objects from the trusted repo; the candidate worktree (R-A9)
		const repo = deps.config.repos.find((r) => r.id === p.repo_id);
		if (!repo) return fail("repo_unavailable");
		let repoPath: string;
		try {
			repoPath = realpathSync(repo.path);
		} catch {
			return fail("repo_unavailable");
		}
		const git = gitFor(repoPath);
		const tree = await candidateTreeOf(git, candidate);
		timeCheck();
		if (tree === null) fail("candidate_unavailable");
		await checkWorktree(run.workspace_path, candidate);
		timeCheck();

		// 4. one verified read of the attempt's evidence
		const collect: CollectDeps = {
			db: deps.db,
			config: deps.config,
			limits,
			git,
			recheckDisclosure: deps.recheckDisclosure ?? true,
			deadline,
			now,
		};
		const ev = await collectRunEvidence(collect, task, run, tree);
		timeCheck();

		// 5. the attempt's review (L-06: none → no envelope)
		if (!ev.reviewsReadable) fail("review_unreadable");
		const review = ev.reviews[ev.reviews.length - 1];
		if (!review) return fail("review_missing");
		const outItem = ev.items.find((i) => i.row.kind === "review_output");
		if (ev.reviews.length > 1 && outItem) {
			outItem.status = "corrupt";
			outItem.reasons = [
				...new Set([...outItem.reasons, "review_ambiguous"]),
			].sort();
		}
		if (
			outItem &&
			ev.reviewOutput &&
			(ev.reviewOutput.verdict !== review.verdict ||
				ev.reviewOutput.audited_sha !== review.candidate_sha ||
				ev.reviewOutput.manifest_hash !== review.manifest_hash) &&
			review.verdict !== null
		) {
			outItem.status = "corrupt";
			outItem.reasons = [
				...new Set([...outItem.reasons, "review_row_mismatch"]),
			].sort();
		}
		const record: ReviewRecord = {
			contract: REVIEW_RECORD_CONTRACT,
			review_id: review.id,
			managed_task_id: task.id,
			run_id: run.id,
			provider: review.provider,
			mode: review.mode,
			model_requested: review.model_requested,
			model_resolved: review.model_resolved,
			candidate_sha: review.candidate_sha,
			manifest_hash: review.manifest_hash,
			verdict: review.verdict,
			valid: review.valid,
			invalidated_reason: review.invalidated_reason,
			findings: review.findings.map((f) => ({
				severity: f.severity,
				title: f.title,
				detail: f.detail,
				file: f.file,
				line: f.line,
				actionable: f.actionable,
			})),
			summary: review.summary,
		};
		let reviewHash: string;
		try {
			reviewHash = reviewRecordHash(record);
		} catch {
			return fail("review_unreadable");
		}

		// 6. envelope
		const verification: EnvelopeCheck[] = (ev.manifest?.verification ?? []).map(
			(v) => ({
				name: v.name,
				completed: v.completed,
				timed_out: v.timed_out,
				exit_code: v.exit_code,
				duration_ms: v.duration_ms,
				log_sha256: v.log_sha256,
				log_truncated: v.log_truncated,
			}),
		);
		const artifacts: EnvelopeArtifact[] = [
			...ev.items.map((i) => ({
				name: i.row.name,
				kind: i.row.kind,
				status: i.status,
				artifact_id: i.row.id,
				sha256: i.row.sha256,
				byte_len: i.row.byte_len,
				truncated: i.row.truncated,
			})),
			...ev.missing.map((name) => ({
				name,
				kind: missingKind(name),
				status: "missing" as const,
				artifact_id: null,
				sha256: null,
				byte_len: null,
				truncated: null,
			})),
		].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
		const blocking = record.findings.filter(
			(f) => f.severity === "blocker" || f.severity === "major",
		).length;
		const envelope: ResultEnvelope = {
			contract: RESULT_CONTRACT,
			workspace_task_id: input.workspace_task_id,
			proposal_id: p.proposal_id,
			proposal_hash: input.proposal_hash,
			execution_binding_hash: input.execution_binding_hash,
			run_decision_id: input.run_decision_id,
			managed_task_id: task.id,
			run_id: run.id,
			attempt_no: run.attempt_no as 1 | 2,
			max_repairs: maxRepairs,
			base_sha: p.base_sha,
			parent_sha: parent,
			candidate_sha: candidate,
			candidate_tree: tree as string,
			manifest_hash: manifestHash,
			execution_mode: "simulated",
			policy_hash: b.policy_hash,
			required_checks: [...p.verification_plan.required_checks],
			artifacts,
			verification,
			review: {
				review_id: review.id,
				review_hash: reviewHash,
				verdict: review.verdict,
				valid: review.valid,
				candidate_sha: review.candidate_sha,
				manifest_hash: review.manifest_hash,
				findings: record.findings.length,
				blocking_findings: blocking,
			},
			provenance: {
				implementer: {
					provider: run.provider,
					mode: run.mode,
					model_requested: run.model_requested,
					model_resolved: run.model_resolved,
				},
				reviewer: {
					provider: review.provider,
					mode: review.mode,
					model_requested: review.model_requested,
					model_resolved: review.model_resolved,
				},
			},
			evidence_status: "verified",
		};
		envelope.evidence_status = overallEvidenceStatus(envelope);
		// v1.2: coverage from the proposal's trusted plan + this envelope's own verification results
		// and artifact items (inside the envelope hash); a legacy v1 proposal keeps the v1 shape
		const full: AnyResultEnvelope = isProposalV1_2(p)
			? {
					...envelope,
					contract: RESULT_CONTRACT_V1_2,
					criterion_coverage: deriveCriterionCoverage(
						p.coverage_plan,
						envelope,
					),
				}
			: envelope;
		let sealed: ReturnType<typeof sealAnyResultEnvelope>;
		try {
			sealed = sealAnyResultEnvelope(full);
		} catch {
			return fail("envelope_invalid");
		}
		retained.put({
			envelope_hash: sealed.hash,
			managed_task_id: task.id,
			run_id: run.id,
			items: ev.items.flatMap((i) =>
				i.buffer
					? [
							{
								artifact_id: i.row.id,
								sha256: i.row.sha256,
								status: i.status,
								buffer: i.buffer,
							},
						]
					: [],
			),
		});
		const result: SealedResult = {
			envelope: sealed.value,
			envelope_hash: sealed.hash,
			canonical: sealed.canonical,
			// the v1.2 rule everywhere acceptance is gated (fail closed: v1 proposal → criteria_unmapped)
			eligibility: resultEligibilityV1_2(sealed.value, p),
			problems: ev.problems,
		};
		// v1.2 §B: the exact verified buffers behind this result, for the durable bundle (published
		// by the bridge at Gate-2 opening — never rebuilt from a later read)
		attachSealedEvidence(result, {
			envelope_hash: sealed.hash,
			managed_task_id: task.id,
			run_id: run.id,
			items: ev.items.flatMap((i) =>
				i.buffer && (i.status === "verified" || i.status === "truncated")
					? [
							{
								artifact_id: i.row.id,
								name: i.row.name,
								sha256: i.row.sha256,
								byte_len: i.row.byte_len,
								status: i.status,
								buffer: i.buffer,
							},
						]
					: [],
			),
		});
		return result;
	}

	/** R-A9: the attempt's worktree (inside workspace_root) is exactly the candidate, nothing else. */
	async function checkWorktree(path: string | null, candidate: string) {
		if (!path) throw new SealError("candidate_workspace_invalid");
		let real: string;
		let root: string;
		try {
			real = realpathSync(path);
			root = realpathSync(deps.config.workspace_root);
			if (!statSync(real).isDirectory()) throw new Error("not a directory");
		} catch {
			throw new SealError("candidate_workspace_invalid");
		}
		if (real === root || !isInside(root, real))
			throw new SealError("candidate_workspace_invalid");
		const wt = gitFor(real);
		const head = await wt(["rev-parse", "--verify", "HEAD"], 256);
		if (!head.spawned || head.exitCode !== 0)
			throw new SealError("candidate_workspace_invalid");
		if (head.stdout.trim() !== candidate)
			throw new SealError("candidate_mutated");
		const st = await wt(
			["status", "--porcelain=v1", "--untracked-files=all"],
			65_536,
		);
		if (!st.spawned || st.exitCode !== 0 || st.stdoutTruncated)
			throw new SealError("candidate_workspace_invalid");
		if (st.stdout.trim().length > 0) throw new SealError("candidate_mutated");
	}

	async function revalidate(
		request: ApprovalRequestRow,
	): Promise<SealedResult> {
		if (
			request.kind !== "result" ||
			request.run_id === null ||
			request.result_envelope === null ||
			request.result_envelope_hash === null
		)
			throw new SealError("not_a_result_request");
		const reads = deps.reads;
		if (!reads) throw new SealError("revalidation_unavailable");
		// inputs re-derived from their own rows, not copied from the envelope being checked
		const proposal = reads.getProposal(request.proposal_id);
		if (
			!proposal ||
			proposal.id !== request.proposal_id ||
			!hashesEqual(proposal.proposal_hash, request.proposal_hash)
		)
			throw new SealError("input_mismatch");
		const decision = reads.getDecision(request.result_envelope.run_decision_id);
		const runRequest = decision
			? reads.getApprovalRequest(decision.approval_request_id)
			: null;
		if (
			decision?.kind !== "run" ||
			decision.action !== "approve" ||
			decision.managed_task_id !== request.managed_task_id ||
			!runRequest ||
			runRequest.kind !== "run" ||
			runRequest.status !== "approved" ||
			runRequest.managed_task_id !== request.managed_task_id ||
			runRequest.workspace_task_id !== request.workspace_task_id ||
			!hashesEqual(runRequest.proposal_hash, request.proposal_hash) ||
			!hashesEqual(
				runRequest.execution_binding_hash,
				request.execution_binding_hash,
			)
		)
			throw new SealError("input_mismatch");
		return seal({
			workspace_task_id: request.workspace_task_id,
			proposal: proposal.snapshot,
			proposal_hash: request.proposal_hash,
			execution_binding: request.execution_binding,
			execution_binding_hash: request.execution_binding_hash,
			run_decision_id: decision.id,
			managed_task_id: request.managed_task_id,
			run_id: request.run_id,
		});
	}

	return { seal, revalidate, retained };
}

function missingKind(name: string): EnvelopeArtifact["kind"] {
	if (name === "manifest.json") return "manifest";
	if (name === "diff.patch") return "diff";
	if (name === "review-output.json") return "review_output";
	return "verification_log";
}

/**
 * Gate 2 (before the decision transaction): accept only if a fresh re-seal reproduces the bound
 * envelope hash exactly (constant-time) and the re-sealed envelope is eligible. One comparison
 * covers bytes, rows, review, statuses and candidate identity.
 */
export function gate2Check(
	request: Pick<ApprovalRequestRow, "result_envelope_hash">,
	resealed: SealedResult,
):
	| { ok: true }
	| { ok: false; code: "integrity_failed" | "evidence_unavailable" } {
	if (
		request.result_envelope_hash === null ||
		!hashesEqual(resealed.envelope_hash, request.result_envelope_hash)
	)
		return { ok: false, code: "integrity_failed" };
	if (!resealed.eligibility.eligible)
		return { ok: false, code: "evidence_unavailable" };
	return { ok: true };
}

/** Gate-2 helper: revalidate and compare; any SealError counts as integrity_failed. */
export async function revalidateForGate2(
	sealer: EvidenceSealer,
	request: ApprovalRequestRow,
): Promise<
	| { ok: true; sealed: SealedResult }
	| {
			ok: false;
			code: "integrity_failed" | "evidence_unavailable";
			seal_error: string | null;
	  }
> {
	let resealed: SealedResult;
	try {
		resealed = await sealer.revalidate(request);
	} catch (err) {
		if (err instanceof SealError)
			return { ok: false, code: "integrity_failed", seal_error: err.code };
		throw err;
	}
	const r = gate2Check(request, resealed);
	return r.ok
		? { ok: true, sealed: resealed }
		: { ok: false, code: r.code, seal_error: null };
}
