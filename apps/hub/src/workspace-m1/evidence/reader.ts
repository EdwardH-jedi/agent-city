// Display reader for GET /api/workspace/tasks/:id/artifacts/:artifact_id (contract v1.1
// `ArtifactTextResponse`). Text is returned only when the artifact's status is `verified` or
// `truncated` AND its bytes decode as UTF-8; otherwise `text` is null and `withheld_reasons` holds
// fixed reason codes only.
//
// v1.2 §B (`readArtifactFromBundle`): an artifact of a result request WITH a durable evidence bundle
// is served ONLY from that verified bundle — the status recorded in the sealed envelope, the bytes of
// the one verified bundle read; the mutable artifact store is never consulted, so a later change to
// it can never substitute content. Bundle verification failure → corrupt/unknown with `text: null`.
//
// Without a bundle (legacy requests, invalidated requests, attempts with no Gate 2):
//   - the artifact belongs to a SEALED result (the caller passes the bound envelope + hash) and the
//     retained store still holds that envelope's verified buffer → that buffer (re-hashed), with the
//     status recorded inside the envelope; no file is opened;
//   - otherwise → a fresh verified read of the attempt's WHOLE evidence unit (C5: every artifact's
//     bytes vs its row, manifest hash + links, every review of the attempt bound to the attempt's
//     candidate + manifest, diff = complete-context disclosure of the candidate), and the buffer of
//     that same read is served. With a bound envelope, any difference from the envelope item
//     (identity or status) makes the artifact `corrupt` — post-acceptance replacement is refused.
// Artifacts outside the manifest (implementation/review logs, changed files) get the unit verdict
// too: one failing part of the unit makes every artifact of the attempt unservable.

import type { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import {
	type AnyResultEnvelope,
	ArtifactId,
	type ArtifactTextResponse,
	ArtifactTextResponse as ArtifactTextResponseSchema,
	type EvidenceStatus,
	ManagedTaskId,
} from "@agent-city/schema/workspace-m1";
import {
	hashesEqual,
	sealAnyResultEnvelope,
} from "@agent-city/schema/workspace-m1/hash";
import type { ManagedConfig } from "../../managed/config.ts";
import {
	ArtifactAccessError,
	dropTrailingFragment,
	readArtifactBytes,
	redactLog,
} from "../../managed/evidence.ts";
import { getRun, getTask } from "../../managed/store.ts";
import { verifyBundle } from "./bundle.ts";
import type { GitRunner } from "./context-loader.ts";
import type { RetainedEvidenceStore } from "./retained.ts";
import {
	candidateTreeOf,
	collectRunEvidence,
	type EvidenceLimits,
	evidenceLimits,
	SealError,
	toArtifact,
	worse,
} from "./run-evidence.ts";
import { defaultGitFor } from "./sealer.ts";

export class ArtifactNotFound extends Error {
	constructor() {
		super("artifact not found");
		this.name = "ArtifactNotFound";
	}
}

export interface ArtifactReaderDeps {
	db: Database;
	config: ManagedConfig;
	retained?: RetainedEvidenceStore;
	gitFor?: (cwd: string) => GitRunner;
	limits?: Partial<EvidenceLimits>;
	recheckDisclosure?: boolean;
	/** Display cap (default 1 MiB, as the legacy artifact view). */
	view_max_bytes?: number;
	now?: () => number;
}

export interface ArtifactReadInput {
	managed_task_id: string;
	artifact_id: string;
	/** The sealed result of this task's current result request, when there is one. */
	bound?: { envelope: AnyResultEnvelope; envelope_hash: string } | null;
	/**
	 * false: never serve the retained in-memory copy (an invalidated result is history whose current
	 * bytes must be re-verified — R-F5); the fresh read must still reproduce `bound` exactly.
	 */
	use_retained?: boolean;
}

export interface BundledArtifactReadInput {
	managed_task_id: string;
	artifact_id: string;
	/** The result request's sealed envelope (hash-checked by the store on read) and its hash. */
	envelope: AnyResultEnvelope;
	envelope_hash: string;
	/** The request's immutable durable bundle digest and its recorded byte length. */
	digest: string;
	byte_len?: number;
}

const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const REASON = /^[a-z0-9_]{1,64}$/;
const UNIT_FAILING: ReadonlySet<EvidenceStatus> = new Set([
	"corrupt",
	"stale",
	"unknown",
]);

interface ResponseMeta {
	artifact_id: string;
	run_id: string;
	name: string;
	kind: ArtifactTextResponse["kind"];
	truncated: boolean;
}

/** The one place a verified buffer becomes response text (UTF-8 judged on the full bytes, capped). */
function respondWith(
	deps: Pick<ArtifactReaderDeps, "view_max_bytes">,
	meta: ResponseMeta,
	status: EvidenceStatus,
	reasons: readonly string[],
	buffer: Buffer | null,
): ArtifactTextResponse {
	let text: string | null = null;
	let truncated = meta.truncated;
	let st = status;
	const why = new Set(reasons.filter((r) => REASON.test(r)));
	if ((st === "verified" || st === "truncated") && buffer) {
		const max = deps.view_max_bytes ?? 1_048_576;
		let decoded: string | null = null;
		try {
			FATAL_UTF8.decode(buffer); // judged on the full verified bytes
			let end = Math.min(max, buffer.length);
			// never cut inside a multi-byte character
			while (
				end > 0 &&
				end < buffer.length &&
				((buffer[end] as number) & 0xc0) === 0x80
			)
				end--;
			decoded = FATAL_UTF8.decode(buffer.subarray(0, end));
		} catch {
			decoded = null;
		}
		if (decoded === null) {
			st = "withheld";
			why.add("undecodable");
		} else {
			if (buffer.length > max) {
				decoded = dropTrailingFragment(decoded);
				truncated = true;
			}
			// logs/outputs were redacted when written; again at display (defence in depth). The
			// diff is served as verified: it is the complete-context disclosure of the candidate.
			text = meta.kind === "diff" ? decoded : redactLog(decoded);
		}
	}
	if (text === null && st === "verified") why.add("not_served");
	return ArtifactTextResponseSchema.parse({
		artifact_id: meta.artifact_id,
		run_id: meta.run_id,
		name: meta.name,
		kind: meta.kind,
		status: st,
		text,
		truncated,
		withheld_reasons: [...why].sort().slice(0, 50),
	});
}

const metaOf = (row: {
	id: string;
	run_id: string;
	name: string;
	kind: ArtifactTextResponse["kind"];
	truncated: boolean;
}): ResponseMeta => ({
	artifact_id: row.id,
	run_id: row.run_id,
	name: row.name,
	kind: row.kind,
	truncated: row.truncated,
});

function loadRow(
	deps: ArtifactReaderDeps,
	managed_task_id: string,
	artifact_id: string,
) {
	if (
		!ManagedTaskId.safeParse(managed_task_id).success ||
		!ArtifactId.safeParse(artifact_id).success
	)
		throw new ArtifactNotFound();
	const raw = deps.db
		.query<Record<string, unknown>, [string, string]>(
			"SELECT id, task_id, run_id, kind, name, rel_path, sha256, byte_len, truncated, candidate_sha, meta, created_at FROM managed_artifacts WHERE id = ? AND task_id = ?",
		)
		.get(artifact_id, managed_task_id);
	const row = raw ? toArtifact(raw) : null;
	if (!row || row.name.length > 200 || !/^run-[0-9a-f-]{36}$/.test(row.run_id))
		throw new ArtifactNotFound();
	return row;
}

/**
 * v1.2 §B: an artifact of a result request that has a durable evidence bundle — served ONLY from
 * the verified bundle. Identity shown (name, kind, truncated) comes from the sealed envelope item;
 * the status is the one sealed; the bytes are the slice of the single verified bundle read. The
 * mutable artifact store (file or row) is never read here. Synchronous, bounded.
 */
export function readArtifactFromBundle(
	deps: ArtifactReaderDeps,
	input: BundledArtifactReadInput,
): ArtifactTextResponse {
	const row = loadRow(deps, input.managed_task_id, input.artifact_id);
	const env = input.envelope;
	const sealed = env.artifacts.find((a) => a.artifact_id === row.id);
	if (
		!sealed ||
		env.run_id !== row.run_id ||
		env.managed_task_id !== input.managed_task_id
	)
		return respondWith(
			deps,
			metaOf(row),
			"corrupt",
			["not_in_sealed_result"],
			null,
		);
	const meta: ResponseMeta = {
		artifact_id: row.id,
		run_id: env.run_id,
		name: sealed.name,
		kind: sealed.kind,
		truncated: sealed.truncated ?? row.truncated,
	};
	if (sealed.status !== "verified" && sealed.status !== "truncated")
		return respondWith(deps, meta, sealed.status, ["sealed_status"], null);
	const v = verifyBundle(
		deps.config.artifacts_root,
		{
			digest: input.digest,
			result_envelope_hash: input.envelope_hash,
			envelope: env,
			...(input.byte_len !== undefined ? { byte_len: input.byte_len } : {}),
		},
		deps.now ? { now: deps.now } : {},
	);
	if (!v.ok)
		return respondWith(
			deps,
			meta,
			v.transient ? "unknown" : "corrupt",
			[v.code],
			null,
		);
	const item = v.items.get(row.id);
	if (!item)
		return respondWith(
			deps,
			meta,
			"corrupt",
			["bundle_binding_mismatch"],
			null,
		);
	return respondWith(deps, meta, item.status, [], item.bytes);
}

export async function readArtifactText(
	deps: ArtifactReaderDeps,
	input: ArtifactReadInput,
): Promise<ArtifactTextResponse> {
	const row = loadRow(deps, input.managed_task_id, input.artifact_id);
	const respond = (
		status: EvidenceStatus,
		reasons: readonly string[],
		buffer: Buffer | null,
	): ArtifactTextResponse =>
		respondWith(deps, metaOf(row), status, reasons, buffer);

	const bound =
		input.bound &&
		input.bound.envelope.run_id === row.run_id &&
		input.bound.envelope.managed_task_id === input.managed_task_id
			? input.bound
			: null;
	// the bound envelope must be the one its hash names (a rewritten request row is not trusted)
	if (bound) {
		let ok = false;
		try {
			ok = hashesEqual(
				sealAnyResultEnvelope(bound.envelope).hash,
				bound.envelope_hash,
			);
		} catch {
			ok = false;
		}
		if (!ok) return respond("corrupt", ["sealed_envelope_mismatch"], null);
	}
	const sealedItem = bound?.envelope.artifacts.find(
		(a) => a.artifact_id === row.id,
	);

	// 1. the retained verified buffer of the sealed result (no file is opened); its status is the
	//    one recorded when those bytes were sealed
	if (bound && sealedItem && deps.retained && input.use_retained !== false) {
		const kept = deps.retained.take(
			bound.envelope_hash,
			{ managed_task_id: input.managed_task_id, run_id: row.run_id },
			row.id,
		);
		if (
			kept &&
			kept.sha256 === sealedItem.sha256 &&
			kept.status === sealedItem.status
		)
			return respond(kept.status, [], kept.buffer);
	}

	// 2. fresh verified read of the whole unit
	const task = getTask(deps.db, input.managed_task_id);
	const run = getRun(deps.db, row.run_id);
	if (!task || !run || run.task_id !== task.id)
		return respond("unknown", ["attempt_unavailable"], null);

	if (!run.manifest_hash || !run.candidate_sha) {
		// an attempt that never produced evidence: only its logs exist; the row is the binding
		if (row.kind !== "implementation_log" && row.kind !== "review_log")
			return respond("unknown", ["manifest_unbound"], null);
		try {
			const buf = readArtifactBytes(deps.config.artifacts_root, row);
			return respond(row.truncated ? "truncated" : "verified", [], buf);
		} catch (err) {
			if (err instanceof ArtifactAccessError)
				return respond("corrupt", ["unreadable"], null);
			throw err;
		}
	}

	const limits = evidenceLimits(deps.config, deps.limits);
	const now = deps.now ?? Date.now;
	const repo = deps.config.repos.find((r) => r.id === task.repo_id);
	let repoPath: string | null = null;
	try {
		repoPath = repo ? realpathSync(repo.path) : null;
	} catch {
		repoPath = null;
	}
	if (!repoPath) return respond("unknown", ["repo_unavailable"], null);
	const git = (deps.gitFor ?? defaultGitFor(deps.config))(repoPath);
	let ev: Awaited<ReturnType<typeof collectRunEvidence>>;
	try {
		const tree = await candidateTreeOf(git, run.candidate_sha);
		ev = await collectRunEvidence(
			{
				db: deps.db,
				config: deps.config,
				limits,
				git,
				recheckDisclosure: deps.recheckDisclosure ?? true,
				deadline: now() + limits.deadline_ms,
				now,
			},
			task,
			run,
			tree,
		);
	} catch (err) {
		if (err instanceof SealError) return respond("unknown", [err.code], null);
		throw err;
	}
	const own = ev.items.find((i) => i.row.id === row.id);
	if (!own) return respond("corrupt", ["duplicate_name"], null);

	// C5: the unit as a whole
	let unit: EvidenceStatus = "verified";
	const unitReasons: string[] = [];
	for (const i of ev.items)
		if (i !== own && UNIT_FAILING.has(i.status)) {
			unit = worse(unit, "corrupt");
			unitReasons.push("evidence_unit_not_verified");
		}
	if (ev.missing.length > 0) {
		unit = worse(unit, "corrupt");
		unitReasons.push("evidence_unit_incomplete");
	}
	if (!ev.reviewsReadable) {
		unit = worse(unit, "unknown");
		unitReasons.push("review_unreadable");
	}
	for (const r of ev.reviews)
		if (
			r.candidate_sha !== run.candidate_sha ||
			r.manifest_hash !== run.manifest_hash
		) {
			unit = worse(unit, "stale");
			unitReasons.push("review_binding_mismatch");
		}
	let status = own.status;
	const reasons = [...own.reasons];
	if (unit !== "verified") {
		status = worse(status, unit);
		reasons.push(...unitReasons);
	}
	// a sealed result: the fresh read must reproduce exactly what was sealed
	if (bound) {
		if (
			!sealedItem ||
			sealedItem.sha256 !== row.sha256 ||
			sealedItem.byte_len !== row.byte_len ||
			sealedItem.truncated !== row.truncated ||
			sealedItem.status !== own.status
		) {
			status = worse(status, "corrupt");
			reasons.push("differs_from_sealed");
		}
	}
	return respond(status, reasons, own.buffer);
}
