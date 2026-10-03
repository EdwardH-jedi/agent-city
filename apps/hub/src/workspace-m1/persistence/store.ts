// WorkspaceStore / WorkspaceTx (ports.ts) on bun:sqlite. One `BEGIN IMMEDIATE` per transaction on
// the hub's single Database handle; managed-store calls made inside the callback (its own
// `db.transaction(fn).immediate()`) nest as SAVEPOINTs and roll back with the outer transaction.
//
// Rows are validated with the rows.ts DTO schemas on every write AND every read. Hashed structures
// (proposal snapshot, execution binding, approval binding, result envelope) are re-sealed through
// their contract schema before insert (the row's hash column must match) and stored as their
// canonical text verbatim; every read re-checks `storedCanonicalMatches` and fails closed with
// WorkspaceIntegrityError. SQL uses positional parameters only (independent of `strict` binding).
import type { Database } from "bun:sqlite";
import {
	AcceptanceValidityRow,
	type AcceptanceValidityStatus,
	AnyResultEnvelope,
	ApprovalBinding,
	type ApprovalKind,
	type ApprovalRequestPatch,
	ApprovalRequestRow,
	type ApprovalStatus,
	canTransitionApproval,
	EvidenceBundleRow,
	ExecutionBinding,
	isProposalV1_2,
	isTerminalWorkspaceStage,
	ManagedDecisionRow,
	ManagedProposalRow,
	UtcTs,
	WORKSPACE_TRANSITIONS,
	type WorkspaceReads,
	type WorkspaceStore,
	type WorkspaceTaskPatch,
	WorkspaceTaskRow,
	type WorkspaceTx,
} from "@agent-city/schema/workspace-m1";
import {
	canonicalEncode,
	createTaskRequestHash,
	criterionIdsMatch,
	hashesEqual,
	seal,
	sealAnyProposal,
	storedCanonicalMatches,
} from "@agent-city/schema/workspace-m1/hash";
import type { z } from "zod";
import {
	WorkspaceConflictError,
	type WorkspaceConstraint,
	WorkspaceIntegrityError,
	WorkspaceRowError,
	WorkspaceTxError,
} from "./errors.ts";

// ── column maps (1:1 with rows.ts; a test pins them against PRAGMA table_info) ─────────────

type Cols<T> = readonly (keyof T & string)[];
type Exhaustive<T, C extends Cols<T>> = [Exclude<keyof T, C[number]>] extends [
	never,
]
	? C
	: never;

const TASK_COLS_LIST = [
	"id",
	"contract_version",
	"repo_id",
	"created_by",
	"idempotency_key",
	"request_hash",
	"draft",
	"stage",
	"stage_detail",
	"current_proposal_id",
	"current_managed_task_id",
	"accepted_decision_id",
	"cancel_requested_at",
	"created_at",
	"updated_at",
	"rev",
] as const;
const PROPOSAL_COLS_LIST = [
	"id",
	"workspace_task_id",
	"version",
	"predecessor_proposal_id",
	"contract_version",
	"snapshot",
	"proposal_hash",
	"created_by",
	"created_at",
] as const;
const REQUEST_COLS_LIST = [
	"id",
	"workspace_task_id",
	"kind",
	"proposal_id",
	"proposal_hash",
	"managed_task_id",
	"execution_binding",
	"execution_binding_hash",
	"run_id",
	"result_envelope",
	"result_envelope_hash",
	"binding",
	"binding_hash",
	"status",
	"invalidation_reason",
	"invalidation_detail",
	"created_at",
	"updated_at",
	"closed_at",
	"rev",
	"challenge_status",
	"challenge_hash",
	"challenge_operator_id",
	"challenge_session_generation",
	"challenge_boot_id",
	"challenge_request_rev",
	"challenge_issued_at",
	"challenge_expires_at",
	"evidence_bundle_digest", // 009 (ADD COLUMN appends)
] as const;
const DECISION_COLS_LIST = [
	"id",
	"approval_request_id",
	"workspace_task_id",
	"kind",
	"action",
	"operator_id",
	"idempotency_key",
	"payload_hash",
	"binding_hash",
	"request_rev",
	"confirmation_text",
	"reason",
	"boot_id",
	"session_generation",
	"managed_task_id",
	"result_envelope_hash",
	"decided_at",
	"response_status",
	"response_body",
	"evidence_bundle_digest", // 009 (ADD COLUMN appends)
] as const;
const BUNDLE_COLS_LIST = [
	"digest",
	"result_envelope_hash",
	"managed_task_id",
	"run_id",
	"rel_path",
	"byte_len",
	"item_count",
	"created_at",
] as const;
const VALIDITY_COLS_LIST = [
	"decision_id",
	"result_request_id",
	"workspace_task_id",
	"evidence_bundle_digest",
	"status",
	"reason",
	"detail",
	"checked_at",
	"first_invalid_at",
	"rev",
] as const;

export const TASK_COLUMNS: Exhaustive<WorkspaceTaskRow, typeof TASK_COLS_LIST> =
	TASK_COLS_LIST;
export const PROPOSAL_COLUMNS: Exhaustive<
	ManagedProposalRow,
	typeof PROPOSAL_COLS_LIST
> = PROPOSAL_COLS_LIST;
export const REQUEST_COLUMNS: Exhaustive<
	ApprovalRequestRow,
	typeof REQUEST_COLS_LIST
> = REQUEST_COLS_LIST;
export const DECISION_COLUMNS: Exhaustive<
	ManagedDecisionRow,
	typeof DECISION_COLS_LIST
> = DECISION_COLS_LIST;
export const BUNDLE_COLUMNS: Exhaustive<
	EvidenceBundleRow,
	typeof BUNDLE_COLS_LIST
> = BUNDLE_COLS_LIST;
export const VALIDITY_COLUMNS: Exhaustive<
	AcceptanceValidityRow,
	typeof VALIDITY_COLS_LIST
> = VALIDITY_COLS_LIST;

const TASK_PATCH_KEYS: readonly (keyof WorkspaceTaskPatch)[] = [
	"draft",
	"stage",
	"stage_detail",
	"current_proposal_id",
	"current_managed_task_id",
	"accepted_decision_id",
	"cancel_requested_at",
];
const REQUEST_PATCH_KEYS: readonly (keyof ApprovalRequestPatch)[] = [
	"status",
	"invalidation_reason",
	"invalidation_detail",
	"closed_at",
	"challenge_status",
	"challenge_hash",
	"challenge_operator_id",
	"challenge_session_generation",
	"challenge_boot_id",
	"challenge_request_rev",
	"challenge_issued_at",
	"challenge_expires_at",
];

const T_TASKS = "workspace_tasks";
const T_PROPOSALS = "managed_proposals";
const T_REQUESTS = "managed_approval_requests";
const T_DECISIONS = "managed_decisions";
const T_BUNDLES = "managed_evidence_bundles";
const T_VALIDITY = "managed_acceptance_validity";

type Raw = Record<string, unknown>;
type Bind = string | number | null;

// ── encode / decode ──────────────────────────────────────────────────────────

const issuesOf = (e: z.ZodError): string[] =>
	e.issues
		.slice(0, 10)
		.map((i) => `${i.path.join(".") || "(row)"}: ${i.message}`);

function parseRow<S extends z.ZodType>(
	table: string,
	schema: S,
	value: unknown,
): z.infer<S> {
	const r = schema.safeParse(value);
	if (!r.success) throw new WorkspaceRowError(table, issuesOf(r.error));
	return r.data as z.infer<S>;
}

function jsonColumn(table: string, id: string, col: string, v: unknown) {
	if (typeof v !== "string")
		throw new WorkspaceIntegrityError(table, id, `${col} is not JSON text`);
	try {
		return JSON.parse(v) as unknown;
	} catch {
		throw new WorkspaceIntegrityError(table, id, `${col} is not valid JSON`);
	}
}

function hashedColumn(
	table: string,
	id: string,
	col: string,
	text: unknown,
	hash: unknown,
): unknown {
	if (
		typeof text !== "string" ||
		typeof hash !== "string" ||
		!storedCanonicalMatches(text, hash)
	)
		throw new WorkspaceIntegrityError(
			table,
			id,
			`${col} no longer hashes to its stored hash`,
		);
	return jsonColumn(table, id, col, text);
}

function verified<S extends z.ZodType>(
	table: string,
	id: string,
	schema: S,
	value: unknown,
): z.infer<S> {
	const r = schema.safeParse(value);
	if (!r.success)
		throw new WorkspaceIntegrityError(
			table,
			id,
			`row no longer satisfies its contract (${issuesOf(r.error)[0] ?? "invalid"})`,
		);
	return r.data as z.infer<S>;
}

const idOf = (r: Raw): string => (typeof r.id === "string" ? r.id : "?");

function decodeTask(r: Raw): WorkspaceTaskRow {
	const id = idOf(r);
	return verified(T_TASKS, id, WorkspaceTaskRow, {
		...r,
		draft: jsonColumn(T_TASKS, id, "draft", r.draft),
	});
}

function decodeProposal(r: Raw): ManagedProposalRow {
	const id = idOf(r);
	const row = verified(T_PROPOSALS, id, ManagedProposalRow, {
		...r,
		snapshot: hashedColumn(
			T_PROPOSALS,
			id,
			"snapshot",
			r.snapshot,
			r.proposal_hash,
		),
	});
	// v1.2: every criterion id must be the id of its own text (a stored hash never covers a forged id)
	if (isProposalV1_2(row.snapshot) && !criterionIdsMatch(row.snapshot))
		throw new WorkspaceIntegrityError(
			T_PROPOSALS,
			id,
			"a criterion id does not match its text",
		);
	return row;
}

/**
 * 009 columns are optional in the DTOs: a NULL column is read as an ABSENT key, so a row written
 * before 009 (or without a bundle) has exactly its pre-009 shape.
 */
function withoutNullDigest(r: Raw): Raw {
	const { evidence_bundle_digest, ...rest } = r;
	return evidence_bundle_digest === null || evidence_bundle_digest === undefined
		? rest
		: { ...rest, evidence_bundle_digest };
}

function decodeRequest(raw: Raw): ApprovalRequestRow {
	const r = withoutNullDigest(raw);
	const id = idOf(r);
	return verified(T_REQUESTS, id, ApprovalRequestRow, {
		...r,
		execution_binding: hashedColumn(
			T_REQUESTS,
			id,
			"execution_binding",
			r.execution_binding,
			r.execution_binding_hash,
		),
		binding: hashedColumn(T_REQUESTS, id, "binding", r.binding, r.binding_hash),
		result_envelope:
			r.result_envelope === null && r.result_envelope_hash === null
				? null
				: hashedColumn(
						T_REQUESTS,
						id,
						"result_envelope",
						r.result_envelope,
						r.result_envelope_hash,
					),
	});
}

function decodeDecision(raw: Raw): ManagedDecisionRow {
	const r = withoutNullDigest(raw);
	const id = idOf(r);
	return verified(T_DECISIONS, id, ManagedDecisionRow, {
		...r,
		response_body: jsonColumn(
			T_DECISIONS,
			id,
			"response_body",
			r.response_body,
		),
	});
}

function decodeBundle(r: Raw): EvidenceBundleRow {
	const id = typeof r.digest === "string" ? r.digest : "?";
	return verified(T_BUNDLES, id, EvidenceBundleRow, r);
}

function decodeValidity(r: Raw): AcceptanceValidityRow {
	const id = typeof r.decision_id === "string" ? r.decision_id : "?";
	return verified(T_VALIDITY, id, AcceptanceValidityRow, r);
}

/** Column value for SQLite: JSON columns are pre-encoded by the caller; everything else is scalar. */
function bindValue(v: unknown): Bind {
	if (v === null || typeof v === "string" || typeof v === "number") return v;
	if (typeof v === "boolean") return v ? 1 : 0;
	throw new Error("persistence: non-scalar column value");
}

// ── SQLite error mapping ─────────────────────────────────────────────────────

const UNIQUE_RULES: Record<string, WorkspaceConstraint> = {
	"workspace_tasks.id": "primary_key",
	"workspace_tasks.created_by, workspace_tasks.idempotency_key":
		"workspace_task_idempotency",
	"workspace_tasks.current_managed_task_id": "workspace_task_managed_task",
	"managed_proposals.id": "primary_key",
	"managed_proposals.workspace_task_id, managed_proposals.version":
		"proposal_version",
	"managed_proposals.proposal_hash": "proposal_hash",
	"managed_approval_requests.id": "primary_key",
	"managed_approval_requests.binding_hash": "binding_hash",
	"managed_approval_requests.managed_task_id": "run_request_per_managed_task",
	"managed_approval_requests.run_id": "result_request_per_run",
	"managed_approval_requests.workspace_task_id, managed_approval_requests.kind":
		"one_pending_request",
	"managed_decisions.id": "primary_key",
	"managed_decisions.approval_request_id": "decision_per_request",
	"managed_decisions.operator_id, managed_decisions.idempotency_key":
		"decision_idempotency",
	"managed_evidence_bundles.digest": "primary_key",
	"managed_acceptance_validity.decision_id": "primary_key",
	"managed_acceptance_validity.result_request_id":
		"acceptance_validity_per_request",
};

/** Translate SQLite constraint failures into typed errors; anything else is rethrown unchanged. */
function mapSqliteError(table: string, err: unknown): never {
	const code = (err as { code?: unknown } | null)?.code;
	const message = err instanceof Error ? err.message : "";
	if (
		code === "SQLITE_CONSTRAINT_UNIQUE" ||
		code === "SQLITE_CONSTRAINT_PRIMARYKEY"
	) {
		const cols = message.replace(/^UNIQUE constraint failed: /, "");
		const rule = UNIQUE_RULES[cols];
		if (rule) throw new WorkspaceConflictError(table, rule);
	}
	if (
		typeof code === "string" &&
		(code === "SQLITE_CONSTRAINT_TRIGGER" ||
			code === "SQLITE_CONSTRAINT_CHECK" ||
			code === "SQLITE_CONSTRAINT_FOREIGNKEY" ||
			code === "SQLITE_CONSTRAINT_NOTNULL")
	)
		throw new WorkspaceRowError(table, [`${code}: ${message}`]);
	throw err;
}

function insertRow(
	db: Database,
	table: string,
	cols: readonly string[],
	values: Bind[],
): void {
	try {
		db.query(
			`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
		).run(...values);
	} catch (err) {
		mapSqliteError(table, err);
	}
}

// ── reads ────────────────────────────────────────────────────────────────────

export interface ApprovalRequestFilter {
	workspace_task_id?: string;
	status?: ApprovalStatus;
	kind?: ApprovalKind;
}

/**
 * Additive reads beyond the frozen port (proposed as port delta v1.2 in NOTES.md). Without
 * `findTaskByIdempotencyKey` the create-task command cannot be key-idempotent.
 */
export interface WorkspaceReadsExt extends WorkspaceReads {
	/** Create-command retry scope: UNIQUE(created_by, idempotency_key). */
	findTaskByIdempotencyKey(
		created_by: string,
		idempotency_key: string,
	): WorkspaceTaskRow | null;
	/** Newest first (updated_at DESC). */
	listTasks(limit?: number): WorkspaceTaskRow[];
	/** All versions of a task, oldest first. */
	listProposals(workspace_task_id: string): ManagedProposalRow[];
	/** All decisions of a task, newest first. */
	listDecisions(workspace_task_id: string): ManagedDecisionRow[];
	/** The Gate-1 request of a managed task (unique per managed task), or null. */
	findRunRequestForManagedTask(
		managed_task_id: string,
	): ApprovalRequestRow | null;
	/** The Gate-2 request of an attempt (unique per run), or null. */
	findResultRequestForRun(run_id: string): ApprovalRequestRow | null;
	/** The workspace task whose CURRENT execution is this managed task, or null. */
	findTaskByManagedTask(managed_task_id: string): WorkspaceTaskRow | null;
}

/** 009 reads: durable evidence bundles and current acceptance validity (v1.2 §B/§C). */
export interface EvidenceValidityReads {
	getEvidenceBundle(digest: string): EvidenceBundleRow | null;
	getAcceptanceValidity(decision_id: string): AcceptanceValidityRow | null;
	/** Oldest check first (checked_at, then insert order); optionally only these statuses. */
	listAcceptanceValidity(o?: {
		statuses?: readonly AcceptanceValidityStatus[];
		limit?: number;
	}): AcceptanceValidityRow[];
}

/** The mutable part of a validity row (rev +1 on every write; identity columns never change). */
export type AcceptanceValidityPatch = Pick<
	AcceptanceValidityRow,
	"status" | "reason" | "detail" | "checked_at" | "first_invalid_at"
>;

/** 009 writes (inside a workspace transaction only). */
export interface EvidenceValidityTx extends EvidenceValidityReads {
	/** Append a bundle row; an identical existing row is a no-op (content address), any other → conflict. */
	insertEvidenceBundle(row: EvidenceBundleRow): void;
	insertAcceptanceValidity(row: AcceptanceValidityRow): void;
	/**
	 * CAS on rev; null on rev miss / unknown id. A sticky row (invalid / unverifiable) throws
	 * WorkspaceRowError — it never changes again.
	 */
	updateAcceptanceValidity(
		decision_id: string,
		expected_rev: number,
		patch: AcceptanceValidityPatch,
	): AcceptanceValidityRow | null;
}

export interface PersistentWorkspaceTx
	extends WorkspaceTx,
		WorkspaceReadsExt,
		EvidenceValidityTx {}

export interface PersistentWorkspaceStore
	extends WorkspaceStore,
		WorkspaceReadsExt,
		EvidenceValidityReads {
	readonly db: Database;
	transaction<T>(fn: (tx: PersistentWorkspaceTx) => T): T;
}

const STICKY_VALIDITY: readonly AcceptanceValidityStatus[] = [
	"invalid",
	"unverifiable",
];

function makeReads(
	db: Database,
	guard: () => void,
): WorkspaceReadsExt & EvidenceValidityReads {
	const one = <R>(sql: string, decode: (r: Raw) => R, ...args: Bind[]) => {
		guard();
		const r = db.query<Raw, Bind[]>(sql).get(...args);
		return r ? decode(r) : null;
	};
	const all = <R>(sql: string, decode: (r: Raw) => R, ...args: Bind[]) => {
		guard();
		return db
			.query<Raw, Bind[]>(sql)
			.all(...args)
			.map(decode);
	};
	return {
		getTask: (id) =>
			one(`SELECT * FROM ${T_TASKS} WHERE id = ?`, decodeTask, id),
		getProposal: (id) =>
			one(`SELECT * FROM ${T_PROPOSALS} WHERE id = ?`, decodeProposal, id),
		getApprovalRequest: (id) =>
			one(`SELECT * FROM ${T_REQUESTS} WHERE id = ?`, decodeRequest, id),
		listApprovalRequests: (filter: ApprovalRequestFilter) => {
			const where: string[] = [];
			const args: Bind[] = [];
			if (filter.workspace_task_id !== undefined) {
				where.push("workspace_task_id = ?");
				args.push(filter.workspace_task_id);
			}
			if (filter.status !== undefined) {
				where.push("status = ?");
				args.push(filter.status);
			}
			if (filter.kind !== undefined) {
				where.push("kind = ?");
				args.push(filter.kind);
			}
			return all(
				`SELECT * FROM ${T_REQUESTS}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC`,
				decodeRequest,
				...args,
			);
		},
		getDecision: (id) =>
			one(`SELECT * FROM ${T_DECISIONS} WHERE id = ?`, decodeDecision, id),
		findReceipt: (operator_id, idempotency_key) =>
			one(
				`SELECT * FROM ${T_DECISIONS} WHERE operator_id = ? AND idempotency_key = ?`,
				decodeDecision,
				operator_id,
				idempotency_key,
			),
		findTaskByIdempotencyKey: (created_by, idempotency_key) =>
			one(
				`SELECT * FROM ${T_TASKS} WHERE created_by = ? AND idempotency_key = ?`,
				decodeTask,
				created_by,
				idempotency_key,
			),
		listTasks: (limit = 500) =>
			all(
				`SELECT * FROM ${T_TASKS} ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
				decodeTask,
				Math.max(1, Math.min(5000, Math.trunc(limit))),
			),
		listProposals: (workspace_task_id) =>
			all(
				`SELECT * FROM ${T_PROPOSALS} WHERE workspace_task_id = ? ORDER BY version`,
				decodeProposal,
				workspace_task_id,
			),
		listDecisions: (workspace_task_id) =>
			all(
				`SELECT * FROM ${T_DECISIONS} WHERE workspace_task_id = ? ORDER BY decided_at DESC, rowid DESC`,
				decodeDecision,
				workspace_task_id,
			),
		findRunRequestForManagedTask: (managed_task_id) =>
			one(
				`SELECT * FROM ${T_REQUESTS} WHERE kind = 'run' AND managed_task_id = ?`,
				decodeRequest,
				managed_task_id,
			),
		findResultRequestForRun: (run_id) =>
			one(
				`SELECT * FROM ${T_REQUESTS} WHERE kind = 'result' AND run_id = ?`,
				decodeRequest,
				run_id,
			),
		findTaskByManagedTask: (managed_task_id) =>
			one(
				`SELECT * FROM ${T_TASKS} WHERE current_managed_task_id = ?`,
				decodeTask,
				managed_task_id,
			),
		getEvidenceBundle: (digest) =>
			one(`SELECT * FROM ${T_BUNDLES} WHERE digest = ?`, decodeBundle, digest),
		getAcceptanceValidity: (decision_id) =>
			one(
				`SELECT * FROM ${T_VALIDITY} WHERE decision_id = ?`,
				decodeValidity,
				decision_id,
			),
		listAcceptanceValidity: (o = {}) => {
			const statuses = o.statuses ?? [];
			const where = statuses.length
				? ` WHERE status IN (${statuses.map(() => "?").join(", ")})`
				: "";
			return all(
				`SELECT * FROM ${T_VALIDITY}${where} ORDER BY checked_at, rowid LIMIT ?`,
				decodeValidity,
				...statuses,
				Math.max(1, Math.min(5000, Math.trunc(o.limit ?? 500))),
			);
		},
	};
}

// ── write validation ─────────────────────────────────────────────────────────

function mustEqualHash(
	table: string,
	what: string,
	computed: string,
	stored: string,
) {
	if (!hashesEqual(computed, stored))
		throw new WorkspaceRowError(table, [`${what} does not match its content`]);
}

function sealOrReject<S extends z.ZodType>(
	table: string,
	what: string,
	schema: S,
	value: unknown,
) {
	try {
		return seal(schema, value);
	} catch (err) {
		throw new WorkspaceRowError(table, [
			`${what} cannot be sealed: ${err instanceof Error ? err.message.slice(0, 200) : "invalid"}`,
		]);
	}
}

function requireNow(table: string, now: string): void {
	if (!UtcTs.safeParse(now).success)
		throw new WorkspaceRowError(table, [
			"now must be an ISO-8601 UTC timestamp",
		]);
}

function patchEntries<P extends object>(
	table: string,
	patch: P,
	allowed: readonly (keyof P)[],
): [keyof P & string, unknown][] {
	const out: [keyof P & string, unknown][] = [];
	for (const [k, v] of Object.entries(patch)) {
		if (!allowed.includes(k as keyof P))
			throw new WorkspaceRowError(table, [`column ${k} cannot be patched`]);
		if (v !== undefined) out.push([k as keyof P & string, v]);
	}
	return out;
}

// ── transaction object ───────────────────────────────────────────────────────

/** Open WorkspaceTx objects → their database (lets managed-writes prove it runs inside one). */
const OPEN_TX = new WeakMap<object, Database>();

/**
 * The PersistentWorkspaceTx behind a port-typed WorkspaceTx, if it is an OPEN transaction of this
 * store on `db`. Throws otherwise (a closed tx, another handle, or a foreign object).
 */
export function openTxOn(tx: WorkspaceTx, db: Database): PersistentWorkspaceTx {
	if (OPEN_TX.get(tx) !== db || !db.inTransaction)
		throw new WorkspaceTxError(
			"not inside an open workspace transaction on this database",
		);
	return tx as PersistentWorkspaceTx;
}

function makeTx(db: Database): {
	tx: PersistentWorkspaceTx;
	close: () => void;
} {
	let open = true;
	const guard = () => {
		if (!open)
			throw new WorkspaceTxError(
				"WorkspaceTx used after its transaction callback returned",
			);
	};
	const reads = makeReads(db, guard);

	const currentTaskRaw = (id: string) =>
		db.query<Raw, [string]>(`SELECT * FROM ${T_TASKS} WHERE id = ?`).get(id);
	const currentRequestRaw = (id: string) =>
		db.query<Raw, [string]>(`SELECT * FROM ${T_REQUESTS} WHERE id = ?`).get(id);

	const casUpdate = (
		table: string,
		id: string,
		expected_rev: number,
		entries: [string, Bind][],
		now: string,
	): boolean => {
		const sets = [
			...entries.map(([k]) => `${k} = ?`),
			"rev = ?",
			"updated_at = ?",
		];
		try {
			const res = db
				.query(
					`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ? AND rev = ?`,
				)
				.run(
					...entries.map(([, v]) => v),
					expected_rev + 1,
					now,
					id,
					expected_rev,
				);
			return res.changes === 1;
		} catch (err) {
			mapSqliteError(table, err);
		}
	};

	const tx: PersistentWorkspaceTx = {
		...reads,

		insertTask(row) {
			guard();
			const r = parseRow(T_TASKS, WorkspaceTaskRow, row);
			mustEqualHash(
				T_TASKS,
				"request_hash",
				createTaskRequestHash({ repo_id: r.repo_id, draft: r.draft }),
				r.request_hash,
			);
			const enc: Record<keyof WorkspaceTaskRow, unknown> = {
				...r,
				draft: canonicalEncode(r.draft),
			};
			insertRow(
				db,
				T_TASKS,
				TASK_COLUMNS,
				TASK_COLUMNS.map((c) => bindValue(enc[c])),
			);
		},

		updateTask(id, expected_rev, patch, now) {
			guard();
			requireNow(T_TASKS, now);
			const entries = patchEntries(T_TASKS, patch, TASK_PATCH_KEYS);
			const raw = currentTaskRaw(id);
			if (!raw || raw.rev !== expected_rev) return null;
			const current = decodeTask(raw);
			if (isTerminalWorkspaceStage(current.stage))
				throw new WorkspaceRowError(T_TASKS, [
					`task is ${current.stage} (terminal); it never changes again`,
				]);
			const next = parseRow(T_TASKS, WorkspaceTaskRow, {
				...current,
				...Object.fromEntries(entries),
				rev: current.rev + 1,
				updated_at: now,
			});
			if (
				next.stage !== current.stage &&
				!WORKSPACE_TRANSITIONS.some(
					(t) => t.from === current.stage && t.to === next.stage,
				)
			)
				throw new WorkspaceRowError(T_TASKS, [
					`no workspace transition ${current.stage} → ${next.stage}`,
				]);
			const bound: [string, Bind][] = entries.map(([k]) => [
				k,
				k === "draft" ? canonicalEncode(next.draft) : bindValue(next[k]),
			]);
			return casUpdate(T_TASKS, id, expected_rev, bound, now) ? next : null;
		},

		insertProposal(row) {
			guard();
			const r = parseRow(T_PROPOSALS, ManagedProposalRow, row);
			// v1 | v1.2 by contract; v1.2 also requires every criterion id = the id of its text
			let sealed: ReturnType<typeof sealAnyProposal>;
			try {
				sealed = sealAnyProposal(r.snapshot);
			} catch (err) {
				throw new WorkspaceRowError(T_PROPOSALS, [
					`snapshot cannot be sealed: ${err instanceof Error ? err.message.slice(0, 200) : "invalid"}`,
				]);
			}
			mustEqualHash(T_PROPOSALS, "proposal_hash", sealed.hash, r.proposal_hash);
			const task = reads.getTask(r.workspace_task_id);
			if (task && task.repo_id !== r.snapshot.repo_id)
				throw new WorkspaceRowError(T_PROPOSALS, [
					"snapshot repo_id differs from the workspace task's repo",
				]);
			const enc: Record<keyof ManagedProposalRow, unknown> = {
				...r,
				snapshot: sealed.canonical,
			};
			insertRow(
				db,
				T_PROPOSALS,
				PROPOSAL_COLUMNS,
				PROPOSAL_COLUMNS.map((c) => bindValue(enc[c])),
			);
		},

		insertApprovalRequest(row) {
			guard();
			const r = parseRow(T_REQUESTS, ApprovalRequestRow, row);
			const exec = sealOrReject(
				T_REQUESTS,
				"execution_binding",
				ExecutionBinding,
				r.execution_binding,
			);
			mustEqualHash(
				T_REQUESTS,
				"execution_binding_hash",
				exec.hash,
				r.execution_binding_hash,
			);
			const binding = sealOrReject(
				T_REQUESTS,
				"binding",
				ApprovalBinding,
				r.binding,
			);
			mustEqualHash(T_REQUESTS, "binding_hash", binding.hash, r.binding_hash);
			const problems: string[] = [];
			const b = r.binding;
			if (b.workspace_task_id !== r.workspace_task_id)
				problems.push("binding names another workspace task");
			if (b.kind === "run") {
				if (
					b.proposal_id !== r.proposal_id ||
					b.proposal_hash !== r.proposal_hash ||
					b.execution_binding_hash !== r.execution_binding_hash
				)
					problems.push("run binding differs from the row");
			} else if (
				b.managed_task_id !== r.managed_task_id ||
				b.run_id !== r.run_id ||
				b.result_envelope_hash !== r.result_envelope_hash
			)
				problems.push("result binding differs from the row");
			let envelopeText: string | null = null;
			if (r.result_envelope !== null && r.result_envelope_hash !== null) {
				const env = sealOrReject(
					T_REQUESTS,
					"result_envelope",
					AnyResultEnvelope,
					r.result_envelope,
				);
				mustEqualHash(
					T_REQUESTS,
					"result_envelope_hash",
					env.hash,
					r.result_envelope_hash,
				);
				const e = r.result_envelope;
				if (
					e.workspace_task_id !== r.workspace_task_id ||
					e.proposal_id !== r.proposal_id ||
					e.proposal_hash !== r.proposal_hash ||
					e.execution_binding_hash !== r.execution_binding_hash ||
					e.managed_task_id !== r.managed_task_id ||
					e.run_id !== r.run_id
				)
					problems.push("result envelope differs from the row");
				envelopeText = env.canonical;
			}
			const proposal = reads.getProposal(r.proposal_id);
			if (
				proposal &&
				proposal.snapshot.base_sha !== r.execution_binding.base_sha
			)
				problems.push("execution binding base_sha differs from the proposal");
			if (problems.length > 0)
				throw new WorkspaceRowError(T_REQUESTS, problems);
			const enc: Record<keyof ApprovalRequestRow, unknown> = {
				...r,
				execution_binding: exec.canonical,
				binding: binding.canonical,
				result_envelope: envelopeText,
				evidence_bundle_digest: r.evidence_bundle_digest ?? null,
			};
			insertRow(
				db,
				T_REQUESTS,
				REQUEST_COLUMNS,
				REQUEST_COLUMNS.map((c) => bindValue(enc[c])),
			);
		},

		updateApprovalRequest(id, expected_rev, patch, now) {
			guard();
			requireNow(T_REQUESTS, now);
			const entries = patchEntries(T_REQUESTS, patch, REQUEST_PATCH_KEYS);
			const raw = currentRequestRaw(id);
			if (!raw || raw.rev !== expected_rev) return null;
			const current = decodeRequest(raw);
			if (current.status !== "pending")
				throw new WorkspaceRowError(T_REQUESTS, [
					`request is ${current.status}; a closed request never changes`,
				]);
			const next = parseRow(T_REQUESTS, ApprovalRequestRow, {
				...current,
				...Object.fromEntries(entries),
				rev: current.rev + 1,
				updated_at: now,
			});
			if (
				next.status !== current.status &&
				!canTransitionApproval(current.kind, current.status, next.status)
			)
				throw new WorkspaceRowError(T_REQUESTS, [
					`no approval transition ${current.status} → ${next.status} for ${current.kind}`,
				]);
			const bound: [string, Bind][] = entries.map(([k]) => [
				k,
				bindValue(next[k]),
			]);
			return casUpdate(T_REQUESTS, id, expected_rev, bound, now) ? next : null;
		},

		insertDecision(row) {
			guard();
			const r = parseRow(T_DECISIONS, ManagedDecisionRow, row);
			const body = r.response_body;
			const problems: string[] = [];
			if (
				body.decision_id !== r.id ||
				body.approval_request_id !== r.approval_request_id ||
				body.workspace_task_id !== r.workspace_task_id ||
				body.kind !== r.kind ||
				body.action !== r.action ||
				body.operator_id !== r.operator_id ||
				body.decided_at !== r.decided_at ||
				body.payload_hash !== r.payload_hash ||
				body.binding_hash !== r.binding_hash
			)
				problems.push("receipt does not describe this decision");
			if (
				body.effects.managed_task_id !== r.managed_task_id ||
				body.effects.result_envelope_hash !== r.result_envelope_hash ||
				(body.effects.evidence_bundle_digest ?? null) !==
					(r.evidence_bundle_digest ?? null)
			)
				problems.push(
					"receipt effects name another execution / envelope / evidence bundle",
				);
			if (problems.length > 0)
				throw new WorkspaceRowError(T_DECISIONS, problems);
			const enc: Record<keyof ManagedDecisionRow, unknown> = {
				...r,
				response_body: canonicalEncode(body),
				evidence_bundle_digest: r.evidence_bundle_digest ?? null,
			};
			insertRow(
				db,
				T_DECISIONS,
				DECISION_COLUMNS,
				DECISION_COLUMNS.map((c) => bindValue(enc[c])),
			);
		},

		insertEvidenceBundle(row) {
			guard();
			const r = parseRow(T_BUNDLES, EvidenceBundleRow, row);
			const existing = reads.getEvidenceBundle(r.digest);
			if (existing) {
				// content-addressed: the same publication recorded twice is one row
				if (BUNDLE_COLUMNS.every((c) => existing[c] === r[c])) return;
				throw new WorkspaceConflictError(T_BUNDLES, "primary_key");
			}
			insertRow(
				db,
				T_BUNDLES,
				BUNDLE_COLUMNS,
				BUNDLE_COLUMNS.map((c) => bindValue(r[c])),
			);
		},

		insertAcceptanceValidity(row) {
			guard();
			const r = parseRow(T_VALIDITY, AcceptanceValidityRow, row);
			if (r.rev !== 1)
				throw new WorkspaceRowError(T_VALIDITY, ["a new row starts at rev 1"]);
			insertRow(
				db,
				T_VALIDITY,
				VALIDITY_COLUMNS,
				VALIDITY_COLUMNS.map((c) => bindValue(r[c])),
			);
		},

		updateAcceptanceValidity(decision_id, expected_rev, patch) {
			guard();
			const raw = db
				.query<Raw, [string]>(
					`SELECT * FROM ${T_VALIDITY} WHERE decision_id = ?`,
				)
				.get(decision_id);
			if (!raw || raw.rev !== expected_rev) return null;
			const current = decodeValidity(raw);
			if (STICKY_VALIDITY.includes(current.status))
				throw new WorkspaceRowError(T_VALIDITY, [
					`validity is ${current.status} (sticky); it never changes again`,
				]);
			const next = parseRow(T_VALIDITY, AcceptanceValidityRow, {
				...current,
				status: patch.status,
				reason: patch.reason,
				detail: patch.detail,
				checked_at: patch.checked_at,
				first_invalid_at: patch.first_invalid_at,
				rev: current.rev + 1,
			});
			try {
				const res = db
					.query(
						`UPDATE ${T_VALIDITY} SET status = ?, reason = ?, detail = ?, checked_at = ?, first_invalid_at = ?, rev = ? WHERE decision_id = ? AND rev = ?`,
					)
					.run(
						next.status,
						next.reason,
						next.detail,
						next.checked_at,
						next.first_invalid_at,
						next.rev,
						decision_id,
						expected_rev,
					);
				return res.changes === 1 ? next : null;
			} catch (err) {
				mapSqliteError(T_VALIDITY, err);
			}
		},
	};

	OPEN_TX.set(tx, db);
	return {
		tx,
		close: () => {
			open = false;
			OPEN_TX.delete(tx);
		},
	};
}

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
	(typeof v === "object" || typeof v === "function") &&
	v !== null &&
	typeof (v as { then?: unknown }).then === "function";

/**
 * The workspace store on the hub's Database handle (opened by apps/hub/src/db.ts `openDb`, schema
 * ≥ 008). Reads outside a transaction see committed data; `transaction` is the only way to write.
 */
export function createWorkspaceStore(db: Database): PersistentWorkspaceStore {
	const reads = makeReads(db, () => {});
	return {
		...reads,
		db,
		transaction<T>(fn: (tx: PersistentWorkspaceTx) => T): T {
			if (db.inTransaction)
				throw new WorkspaceTxError(
					"a workspace transaction must be the outermost transaction (BEGIN IMMEDIATE)",
				);
			const { tx, close } = makeTx(db);
			try {
				return db
					.transaction(() => {
						const out = fn(tx);
						if (isThenable(out)) {
							// The async remainder would run after COMMIT: refuse and roll back.
							Promise.resolve(out).then(
								() => {},
								() => {},
							);
							throw new WorkspaceTxError(
								"workspace transaction callbacks must be synchronous",
							);
						}
						return out;
					})
					.immediate();
			} finally {
				close();
			}
		},
	};
}
