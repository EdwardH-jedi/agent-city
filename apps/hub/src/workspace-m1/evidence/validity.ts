// Current acceptance validity (contract delta v1.2 §C). The historical decision (append-only row +
// receipt) never changes; this module decides whether an ACCEPTED result is still backed by what was
// accepted, and records that verdict in `managed_acceptance_validity` (sticky invalid/unverifiable).
//
// Policy ("both"): any of these makes the current acceptance `invalid` (sticky) while the accepted
// original bytes stay served from the bundle as history:
//   - the durable bundle is missing / corrupt / bound to something else      (bundle_*)
//   - a source artifact (mutable store: row + file) changed or vanished vs the bundle
//                                                    (source_evidence_changed / _missing)
//   - the candidate commit is gone, or its tree ≠ the envelope's candidate_tree
//                                                    (candidate_unavailable / candidate_mismatch)
// A check that cannot run (repo not configured / not a checkout, git did not run or timed out,
// transient I/O) ⇒ `unknown` (verification_unavailable): not sticky, never shown as verified.
// Worktree drift after acceptance is NOT part of the accepted contract (the deliverable is the commit).
//
// Details are fixed text + safe artifact names + failure codes only (no bytes, paths or hashes).
import type { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import type {
	AcceptanceValidityReason,
	AcceptanceValidityRow,
	ApprovalRequestRow,
	EvidenceBundleRow,
	ResultEnvelope,
} from "@agent-city/schema/workspace-m1";
import type { ManagedConfig } from "../../managed/config.ts";
import {
	ArtifactAccessError,
	readArtifactBytes,
} from "../../managed/evidence.ts";
import { getTask } from "../../managed/store.ts";
import type {
	AcceptanceValidityPatch,
	PersistentWorkspaceStore,
} from "../persistence/index.ts";
import {
	type BundleEnvelope,
	type BundleFailureCode,
	verifyBundle,
} from "./bundle.ts";
import type { GitRunner } from "./context-loader.ts";
import { toArtifact } from "./run-evidence.ts";
import { defaultGitFor } from "./sealer.ts";

export type AcceptanceVerdict =
	| { status: "valid"; reason: null; detail: null }
	| {
			status: "invalid";
			reason: Exclude<
				AcceptanceValidityReason,
				"verification_unavailable" | "legacy_no_durable_evidence"
			>;
			detail: string;
	  }
	| { status: "unknown"; reason: "verification_unavailable"; detail: string };

const VALID: AcceptanceVerdict = {
	status: "valid",
	reason: null,
	detail: null,
};

export interface AcceptanceCheckDeps {
	db: Database;
	config: ManagedConfig;
	gitFor?: (cwd: string) => GitRunner;
	now?: () => number;
}

/** What one check needs: the accepted result request (envelope + digest) and its bundle row. */
export interface AcceptanceSubject {
	request: Pick<
		ApprovalRequestRow,
		"result_envelope" | "result_envelope_hash" | "evidence_bundle_digest"
	>;
	/** The validity row's digest (immutable; must equal the request's). */
	digest: string;
	bundle: EvidenceBundleRow | null;
}

const SAFE_NAME = /^[A-Za-z0-9._-]{1,80}$/;
const safeName = (n: string) => (SAFE_NAME.test(n) ? n : "(unsafe name)");
const SHA = /^[0-9a-f]{40}$/;

const invalid = (
	reason: Extract<AcceptanceVerdict, { status: "invalid" }>["reason"],
	detail: string,
): AcceptanceVerdict => ({
	status: "invalid",
	reason,
	detail: detail.slice(0, 500),
});
const unknown = (detail: string): AcceptanceVerdict => ({
	status: "unknown",
	reason: "verification_unavailable",
	detail: detail.slice(0, 500),
});

export function bundleReason(
	code: BundleFailureCode,
): "bundle_missing" | "bundle_corrupt" | "bundle_binding_mismatch" {
	if (code === "bundle_missing") return "bundle_missing";
	if (code === "bundle_binding_mismatch") return "bundle_binding_mismatch";
	return "bundle_corrupt";
}

/**
 * Synchronous part: the durable bundle (strict verify) and every bundled source artifact (its
 * managed_artifacts row and its file) against the bundle. No git, no write.
 */
export function checkAcceptedEvidence(
	deps: AcceptanceCheckDeps,
	subject: AcceptanceSubject,
): AcceptanceVerdict {
	const { request, digest } = subject;
	const envelope = request.result_envelope as BundleEnvelope | null;
	if (!envelope || request.result_envelope_hash === null)
		return invalid(
			"bundle_binding_mismatch",
			"the accepted result has no sealed envelope",
		);
	if (request.evidence_bundle_digest !== digest)
		return invalid(
			"bundle_binding_mismatch",
			"the accepted request names another evidence bundle",
		);
	const root = deps.config.artifacts_root;
	const v = verifyBundle(
		root,
		{
			digest,
			result_envelope_hash: request.result_envelope_hash,
			envelope,
			...(subject.bundle ? { byte_len: subject.bundle.byte_len } : {}),
		},
		deps.now ? { now: deps.now } : {},
	);
	if (!v.ok)
		return v.transient
			? unknown(
					`the durable evidence bundle could not be read right now (${v.code})`,
				)
			: invalid(bundleReason(v.code), `durable evidence bundle: ${v.code}`);

	// every bundled item vs the mutable artifact store (row identity + the file's bytes)
	for (const it of v.items.values()) {
		const raw = deps.db
			.query<Record<string, unknown>, [string, string]>(
				"SELECT id, task_id, run_id, kind, name, rel_path, sha256, byte_len, truncated, candidate_sha, meta, created_at FROM managed_artifacts WHERE id = ? AND task_id = ?",
			)
			.get(it.artifact_id, envelope.managed_task_id);
		const row = raw ? toArtifact(raw) : null;
		if (!row)
			return invalid(
				"source_evidence_missing",
				`source artifact ${safeName(it.name)}: its record is missing`,
			);
		if (
			row.run_id !== envelope.run_id ||
			row.name !== it.name ||
			row.sha256 !== it.sha256 ||
			row.byte_len !== it.byte_len
		)
			return invalid(
				"source_evidence_changed",
				`source artifact ${safeName(it.name)}: its record no longer matches the accepted bytes`,
			);
		try {
			// verified against the BUNDLE item identity, not against a row that could be rewritten
			readArtifactBytes(root, {
				rel_path: row.rel_path,
				byte_len: it.byte_len,
				sha256: it.sha256,
				name: it.name,
			});
		} catch (err) {
			if (!(err instanceof ArtifactAccessError)) throw err;
			return /file is missing/.test(err.message)
				? invalid(
						"source_evidence_missing",
						`source artifact ${safeName(it.name)}: the file is missing`,
					)
				: invalid(
						"source_evidence_changed",
						`source artifact ${safeName(it.name)}: the stored bytes differ from the accepted bytes`,
					);
		}
	}
	return VALID;
}

/** Asynchronous part: the candidate commit still exists in the trusted repo with the sealed tree. */
export async function checkAcceptedCandidate(
	deps: AcceptanceCheckDeps,
	envelope: Pick<
		ResultEnvelope,
		"managed_task_id" | "candidate_sha" | "candidate_tree"
	>,
): Promise<AcceptanceVerdict> {
	const task = getTask(deps.db, envelope.managed_task_id);
	if (!task) return unknown("the managed execution record is unavailable");
	const repo = deps.config.repos.find((r) => r.id === task.repo_id);
	if (!repo) return unknown("the repository is not in the managed allowlist");
	let path: string;
	try {
		path = realpathSync(repo.path);
	} catch {
		return unknown("the repository checkout is unavailable");
	}
	if (!SHA.test(envelope.candidate_sha))
		return invalid(
			"candidate_unavailable",
			"the sealed candidate is not a commit id",
		);
	const git = (deps.gitFor ?? defaultGitFor(deps.config))(path);
	const ran = (r: Awaited<ReturnType<GitRunner>>) =>
		r.spawned && !r.timedOut && !r.aborted;
	let c: Awaited<ReturnType<GitRunner>>;
	let t: Awaited<ReturnType<GitRunner>>;
	try {
		c = await git(
			[
				"rev-parse",
				"--verify",
				"--quiet",
				"--end-of-options",
				`${envelope.candidate_sha}^{commit}`,
			],
			256,
		);
		if (!ran(c)) return unknown("git could not be run on the repository");
		// --verify --quiet: exit 1 = no such object; anything else non-zero = the repo itself failed
		if (c.exitCode === 1)
			return invalid(
				"candidate_unavailable",
				"the candidate commit no longer exists",
			);
		if (c.exitCode !== 0) return unknown("git could not read the repository");
		if (c.stdout.trim() !== envelope.candidate_sha)
			return invalid(
				"candidate_unavailable",
				"the candidate commit no longer resolves",
			);
		t = await git(
			[
				"rev-parse",
				"--verify",
				"--quiet",
				"--end-of-options",
				`${envelope.candidate_sha}^{tree}`,
			],
			256,
		);
	} catch {
		return unknown("git could not be run on the repository");
	}
	if (!ran(t)) return unknown("git could not be run on the repository");
	if (t.exitCode === 1)
		return invalid(
			"candidate_unavailable",
			"the candidate tree no longer exists",
		);
	if (t.exitCode !== 0) return unknown("git could not read the repository");
	if (t.stdout.trim() !== envelope.candidate_tree)
		return invalid(
			"candidate_mismatch",
			"the candidate commit no longer has the sealed tree",
		);
	return VALID;
}

/** Full check: evidence first (sync), then the candidate (git). First invalid wins; then unknown. */
export async function checkAcceptance(
	deps: AcceptanceCheckDeps,
	subject: AcceptanceSubject,
): Promise<AcceptanceVerdict> {
	const ev = checkAcceptedEvidence(deps, subject);
	if (ev.status === "invalid") return ev;
	const envelope = subject.request.result_envelope;
	if (!envelope)
		return invalid(
			"bundle_binding_mismatch",
			"the accepted result has no sealed envelope",
		);
	const cand = await checkAcceptedCandidate(deps, envelope);
	if (cand.status === "invalid") return cand;
	if (ev.status === "unknown") return ev;
	return cand;
}

/** The subject of a validity row, read from the store (null: not checkable — legacy / sticky / gone). */
export function subjectOf(
	store: Pick<
		PersistentWorkspaceStore,
		"getApprovalRequest" | "getEvidenceBundle"
	>,
	row: AcceptanceValidityRow,
): AcceptanceSubject | null {
	if (row.evidence_bundle_digest === null) return null;
	if (row.status === "invalid" || row.status === "unverifiable") return null;
	const request = store.getApprovalRequest(row.result_request_id);
	if (!request) return null;
	return {
		request: {
			result_envelope: request.result_envelope,
			result_envelope_hash: request.result_envelope_hash,
			evidence_bundle_digest: request.evidence_bundle_digest ?? null,
		},
		digest: row.evidence_bundle_digest,
		bundle: store.getEvidenceBundle(row.evidence_bundle_digest),
	};
}

export function patchFor(
	verdict: AcceptanceVerdict,
	at: string,
): AcceptanceValidityPatch {
	switch (verdict.status) {
		case "valid":
			return {
				status: "valid",
				reason: null,
				detail: null,
				checked_at: at,
				first_invalid_at: null,
			};
		case "invalid":
			return {
				status: "invalid",
				reason: verdict.reason,
				detail: verdict.detail,
				checked_at: at,
				first_invalid_at: at,
			};
		case "unknown":
			return {
				status: "unknown",
				reason: "verification_unavailable",
				detail: verdict.detail,
				checked_at: at,
				first_invalid_at: null,
			};
	}
}

/**
 * Record a verdict on a validity row in ONE workspace transaction (must be called outside any
 * transaction). A sticky row (invalid / unverifiable) is never touched — returns it unchanged.
 */
export function recordAcceptanceVerdict(
	store: PersistentWorkspaceStore,
	decision_id: string,
	verdict: AcceptanceVerdict,
	at: string,
): AcceptanceValidityRow | null {
	return store.transaction((tx) => {
		const cur = tx.getAcceptanceValidity(decision_id);
		if (!cur || cur.status === "invalid" || cur.status === "unverifiable")
			return cur;
		return (
			tx.updateAcceptanceValidity(
				decision_id,
				cur.rev,
				patchFor(verdict, at),
			) ?? cur
		);
	});
}
