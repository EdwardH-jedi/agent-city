// Bun-only entry `@agent-city/schema/workspace-m1/hash`: canonical encoder, sha256, the hash
// builders of the workspace hash graph, challenge tokens and id minting. Never imported by
// index.ts (which must stay web-safe). Every builder validates its input against the strict,
// validate-only contract schema first and refuses if parsing changed anything.
import {
	createHash,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import type { z } from "zod";
import {
	ApprovalBinding,
	ExecutionBinding,
	ResultApprovalBinding,
	RunApprovalBinding,
} from "./binding.ts";
import { canonicalEncode } from "./canonical.ts";
import {
	CHALLENGE_TTL_MS,
	ChallengeBinding,
	DecisionPayload,
} from "./decision.ts";
import type { BootId, WorkspaceIdPrefix } from "./ids.ts";
import {
	type AnyProposalSnapshot,
	APPROVAL_CONTRACT,
	CHALLENGE_CONTRACT,
	CRITERION_ID_PREFIX,
	composeProposalSnapshotV1_2,
	EXECUTION_BINDING_CONTRACT,
	PROPOSAL_CONTRACT_V1_2,
	ProposalSnapshot,
	type ProposalSnapshotInput,
	ProposalSnapshotV1_2,
	RESULT_CONTRACT_V1_2,
	type SnapshotResultV1_2,
	WorkspaceDraft,
} from "./proposal.ts";
import {
	type AnyResultEnvelope,
	ResultEnvelope,
	ResultEnvelopeV1_2,
	ReviewRecord,
} from "./result.ts";

export {
	CANONICAL_MAX_DEPTH,
	CanonicalEncodingError,
	canonicalEncode,
} from "./canonical.ts";

export const sha256Hex = (data: string | Uint8Array): string =>
	createHash("sha256").update(data).digest("hex");

/** sha256 of the canonical encoding of any encodable value. */
export const hashCanonical = (value: unknown): string =>
	sha256Hex(canonicalEncode(value));

export interface Sealed<T> {
	value: T;
	/** Store this text verbatim in the JSON column. */
	canonical: string;
	hash: string;
}

/**
 * Validate `value` with a validate-only contract schema, encode, hash. Throws if the schema rejects
 * it or if parsing altered it (a transform/default would make the hash differ from the input).
 */
export function seal<S extends z.ZodType>(
	schema: S,
	value: unknown,
): Sealed<z.infer<S>> {
	const parsed = schema.parse(value) as z.infer<S>;
	const canonical = canonicalEncode(parsed);
	if (canonical !== canonicalEncode(value))
		throw new Error("contract parse altered a hashed value");
	return { value: parsed, canonical, hash: sha256Hex(canonical) };
}

/** Integrity check of a stored canonical column against its stored hash (constant time). */
export const storedCanonicalMatches = (text: string, hash: string): boolean =>
	hashesEqual(sha256Hex(text), hash);

/** Constant-time equality of two hex digests (false on any length/format difference). */
export function hashesEqual(a: string, b: string): boolean {
	if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
	return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

// ── criterion ids (contract delta v1.2) ───────────────────────────────────

/** `crit-` + first 16 hex of sha256(UTF-8 of the frozen criterion text). */
export const criterionId = (frozenText: string): string =>
	`${CRITERION_ID_PREFIX}${sha256Hex(frozenText).slice(0, 16)}`;

/** Every v1.2 criterion id is the id of its own text (the binding the web-safe schema cannot check). */
export const criterionIdsMatch = (
	p: Pick<ProposalSnapshotV1_2, "criteria">,
): boolean => p.criteria.every((c) => c.id === criterionId(c.text));

/** Freeze a draft as a v1.2 snapshot (publish rules fail closed; see composeProposalSnapshotV1_2). */
export const buildProposalSnapshotV1_2 = (
	i: ProposalSnapshotInput,
): SnapshotResultV1_2 => composeProposalSnapshotV1_2(i, criterionId);

// ── the hash graph ─────────────────────────────────────────────────────────

/**
 * Seal a proposal (v1 or v1.2, by `contract`). A v1.2 snapshot is additionally refused unless every
 * criterion id is the id of its text, so a stored hash never covers a forged id. Overload order
 * keeps `ReturnType<typeof sealProposal>` = the v1 form for existing callers; a caller holding the
 * union uses `sealAnyProposal`.
 */
export function sealProposal(
	s: ProposalSnapshotV1_2,
): Sealed<ProposalSnapshotV1_2>;
export function sealProposal(s: ProposalSnapshot): Sealed<ProposalSnapshot>;
export function sealProposal(
	s: AnyProposalSnapshot,
): Sealed<AnyProposalSnapshot> {
	return sealAnyProposal(s);
}

/** `sealProposal` for a value typed as the v1 | v1.2 union (e.g. a parsed row). */
export function sealAnyProposal(
	s: AnyProposalSnapshot,
): Sealed<AnyProposalSnapshot> {
	if (s.contract === PROPOSAL_CONTRACT_V1_2) {
		const sealed = seal(ProposalSnapshotV1_2, s);
		if (!criterionIdsMatch(sealed.value))
			throw new Error("criterion id does not match its text");
		return sealed;
	}
	return seal(ProposalSnapshot, s);
}
export const proposalHash = (s: AnyProposalSnapshot): string =>
	sealAnyProposal(s).hash;

export function sealExecutionBinding(i: {
	proposal_id: string;
	proposal_hash: string;
	managed_task_id: string;
	base_sha: string;
	policy_hash: string;
}) {
	return seal(ExecutionBinding, {
		contract: EXECUTION_BINDING_CONTRACT,
		proposal_id: i.proposal_id,
		proposal_hash: i.proposal_hash,
		managed_task_id: i.managed_task_id,
		base_sha: i.base_sha,
		policy_hash: i.policy_hash,
	});
}

export function sealRunApprovalBinding(i: {
	approval_request_id: string;
	workspace_task_id: string;
	proposal_id: string;
	proposal_hash: string;
	execution_binding_hash: string;
}) {
	return seal(RunApprovalBinding, {
		contract: APPROVAL_CONTRACT,
		kind: "run",
		approval_request_id: i.approval_request_id,
		workspace_task_id: i.workspace_task_id,
		proposal_id: i.proposal_id,
		proposal_hash: i.proposal_hash,
		execution_binding_hash: i.execution_binding_hash,
	});
}

export function sealResultApprovalBinding(i: {
	approval_request_id: string;
	workspace_task_id: string;
	managed_task_id: string;
	run_id: string;
	result_envelope_hash: string;
}) {
	return seal(ResultApprovalBinding, {
		contract: APPROVAL_CONTRACT,
		kind: "result",
		approval_request_id: i.approval_request_id,
		workspace_task_id: i.workspace_task_id,
		managed_task_id: i.managed_task_id,
		run_id: i.run_id,
		result_envelope_hash: i.result_envelope_hash,
	});
}

export const approvalBindingHash = (b: ApprovalBinding): string =>
	seal(ApprovalBinding, b).hash;

export const reviewRecordHash = (r: ReviewRecord): string =>
	seal(ReviewRecord, r).hash;

/**
 * Seal a result envelope (v1 or v1.2, by `contract`). Overload order keeps
 * `ReturnType<typeof sealResultEnvelope>` = the v1 form for existing callers (sealer.ts); a caller
 * holding the union uses `sealAnyResultEnvelope`.
 */
export function sealResultEnvelope(
	e: ResultEnvelopeV1_2,
): Sealed<ResultEnvelopeV1_2>;
export function sealResultEnvelope(e: ResultEnvelope): Sealed<ResultEnvelope>;
export function sealResultEnvelope(
	e: AnyResultEnvelope,
): Sealed<AnyResultEnvelope> {
	return sealAnyResultEnvelope(e);
}

/** `sealResultEnvelope` for a value typed as the v1 | v1.2 union. */
export function sealAnyResultEnvelope(
	e: AnyResultEnvelope,
): Sealed<AnyResultEnvelope> {
	return e.contract === RESULT_CONTRACT_V1_2
		? seal(ResultEnvelopeV1_2, e)
		: seal(ResultEnvelope, e);
}

export const decisionPayloadHash = (p: DecisionPayload): string =>
	seal(DecisionPayload, p).hash;

/** request_hash of the create-task command (same key + different hash → idempotency_conflict). */
export const createTaskRequestHash = (i: {
	repo_id: string;
	draft: WorkspaceDraft;
}): string =>
	hashCanonical({
		repo_id: i.repo_id,
		draft: WorkspaceDraft.parse(i.draft),
	});

// ── challenges ─────────────────────────────────────────────────────────────

/** 32 CSPRNG bytes, base64url without padding (43 chars). Also usable as a CSRF token. */
export const newToken256 = (): string => randomBytes(32).toString("base64url");

export const challengeExpiry = (now: Date): string =>
	new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString();

export function challengeHash(b: Omit<ChallengeBinding, "contract">): string {
	return seal(ChallengeBinding, { contract: CHALLENGE_CONTRACT, ...b }).hash;
}

/**
 * Pure verification core for 03: the presented token must reproduce the stored hash for the
 * CURRENT request/session/boot, be unexpired and unconsumed. One boolean — callers answer
 * `challenge_invalid` for every failure and never say which part failed.
 */
export function challengeValid(i: {
	presented: string;
	stored_hash: string | null;
	status: "none" | "issued" | "consumed";
	expires_at: string | null;
	now: Date;
	binding: Omit<ChallengeBinding, "contract" | "token" | "expires_at">;
}): boolean {
	if (i.status !== "issued" || i.stored_hash === null || i.expires_at === null)
		return false;
	const exp = Date.parse(i.expires_at);
	if (!Number.isFinite(exp) || i.now.getTime() >= exp) return false;
	let computed: string;
	try {
		computed = challengeHash({
			...i.binding,
			token: i.presented,
			expires_at: i.expires_at,
		});
	} catch {
		return false; // malformed token / binding → same answer as a wrong token
	}
	return hashesEqual(computed, i.stored_hash);
}

// ── ids ────────────────────────────────────────────────────────────────────

export const newWorkspaceId = (prefix: WorkspaceIdPrefix): string =>
	`${prefix}-${randomUUID()}`;

export const newBootId = (): BootId => `boot-${randomUUID()}`;
