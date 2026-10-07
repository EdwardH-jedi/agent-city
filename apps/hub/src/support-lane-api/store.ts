// Durable support jobs (migration 011). A thin store over the pure core: every row written was built by
// `createSupportJob` / a state-machine helper, and every row read is re-validated with `parseSupportJob` (a row that
// does not validate is an integrity error, never a job). Nothing here starts work, launches a process, touches Git,
// or reads / writes a workspace, managed-task or approval table.
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
	hashCanonical,
	hashesEqual,
} from "@agent-city/schema/workspace-m1/hash";
import {
	createSupportJob,
	parseSupportJob,
	type SupportJob,
	SupportJobId,
	type SupportJobStatus,
} from "../support-jobs/job.ts";
import {
	requestSupportCancel,
	type SupportTransitionResult,
} from "../support-jobs/state.ts";

export interface SupportJobRecord {
	readonly job: SupportJob;
	/** Row revision: +1 on every update (compare-and-swap key for cancel / transitions). */
	readonly rev: number;
	readonly updated_at: string;
}

/** A stored row that no longer validates as a SupportJob (fail closed: never served as a job). */
export class SupportStoreIntegrityError extends Error {
	constructor(id: string) {
		super(`support job ${id} failed validation`);
		this.name = "SupportStoreIntegrityError";
	}
}

export type SupportCreateOutcome =
	| {
			readonly ok: true;
			readonly created: boolean;
			readonly record: SupportJobRecord;
	  }
	| {
			readonly ok: false;
			readonly error: "invalid_request";
			readonly issues: readonly string[];
	  }
	| { readonly ok: false; readonly error: "idempotency_conflict" };

export type SupportUpdateOutcome =
	| { readonly ok: true; readonly record: SupportJobRecord }
	| {
			readonly ok: false;
			readonly error: "not_found" | "stale_binding" | "invalid_state";
	  };

export interface SupportListQuery {
	repo_id: string | null;
	status: SupportJobStatus | null;
	/** 1..100 (the router bounds it). */
	limit: number;
	/** Keyset continuation: only jobs with a smaller created_seq. */
	before_seq: number | null;
}

export interface SupportListPage {
	records: SupportJobRecord[];
	/** Every row matching the filters now (not only this page). */
	total: number;
	has_more: boolean;
}

interface Row {
	id: string;
	created_seq: number;
	created_by: string;
	idempotency_key: string;
	request_hash: string;
	repo_id: string;
	kind: string;
	capability: string;
	inputs: string;
	brief: string | null;
	priority: number;
	status: string;
	disabled: number;
	cancel_requested: number;
	profile_id: string | null;
	result: string | null;
	failure: string | null;
	created_at: string;
	updated_at: string;
	rev: number;
}

/** The request part of a job, hashed for idempotent replay (identity / ordering / state excluded). */
const requestHash = (j: SupportJob): string =>
	hashCanonical({
		repo_id: j.repo_id,
		kind: j.kind,
		capability: j.capability,
		inputs: j.inputs,
		brief: j.brief,
		priority: j.priority,
		disabled: j.disabled,
	});

function toRecord(row: Row): SupportJobRecord {
	let job: SupportJob | null = null;
	try {
		job = parseSupportJob({
			id: row.id,
			repo_id: row.repo_id,
			kind: row.kind,
			capability: row.capability,
			inputs: JSON.parse(row.inputs),
			brief: row.brief,
			status: row.status,
			priority: row.priority,
			created_seq: row.created_seq,
			created_at: row.created_at,
			disabled: row.disabled === 1,
			cancel_requested: row.cancel_requested === 1,
			profile_id: row.profile_id,
			result: row.result === null ? null : JSON.parse(row.result),
			failure: row.failure === null ? null : JSON.parse(row.failure),
		});
	} catch {
		job = null;
	}
	if (!job) throw new SupportStoreIntegrityError(row.id);
	return { job, rev: row.rev, updated_at: row.updated_at };
}

export interface SupportJobStore {
	create(input: {
		created_by: string;
		idempotency_key: string;
		request: unknown;
		now: Date;
	}): SupportCreateOutcome;
	get(id: string): SupportJobRecord | null;
	list(q: SupportListQuery): SupportListPage;
	/** Cancellation intent (QUEUED → CANCELLED at once; RUNNING → cancel_requested; CANCELLED unchanged). */
	cancel(id: string, expected_rev: number, now: Date): SupportUpdateOutcome;
	/**
	 * Persist one state-machine step (`startSupportJob`, `completeSupportJob`, `failSupportJob`,
	 * `assignSupportProfile`, …) under a rev compare-and-swap. Store-level only: no route exposes it.
	 */
	transition(
		id: string,
		expected_rev: number,
		step: (job: SupportJob) => SupportTransitionResult,
		now: Date,
	): SupportUpdateOutcome;
}

export function createSupportJobStore(db: Database): SupportJobStore {
	const byId = db.query<Row, [string]>(
		"SELECT * FROM support_jobs WHERE id = ?",
	);
	const byKey = db.query<Row, [string, string]>(
		"SELECT * FROM support_jobs WHERE created_by = ? AND idempotency_key = ?",
	);
	const nextSeq = db.query<{ n: number }, []>(
		"SELECT coalesce(max(created_seq), -1) + 1 AS n FROM support_jobs",
	);
	const insert = db.query(
		`INSERT INTO support_jobs (id, created_seq, created_by, idempotency_key, request_hash, repo_id, kind,
		   capability, inputs, brief, priority, status, disabled, cancel_requested, profile_id, result, failure,
		   created_at, updated_at, rev)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, 0, NULL, NULL, NULL, ?, ?, 1)`,
	);
	const update = db.query(
		`UPDATE support_jobs SET status = ?, cancel_requested = ?, profile_id = ?, result = ?, failure = ?,
		   updated_at = ?, rev = rev + 1
		 WHERE id = ? AND rev = ?`,
	);
	const FILTER = "(?1 IS NULL OR repo_id = ?1) AND (?2 IS NULL OR status = ?2)";
	const countQ = db.query<{ n: number }, [string | null, string | null]>(
		`SELECT count(*) AS n FROM support_jobs WHERE ${FILTER}`,
	);
	const pageQ = db.query<
		Row,
		[string | null, string | null, number | null, number]
	>(
		`SELECT * FROM support_jobs WHERE ${FILTER} AND (?3 IS NULL OR created_seq < ?3)
		 ORDER BY created_seq DESC LIMIT ?4`,
	);

	const write = (
		id: string,
		expected_rev: number,
		step: (job: SupportJob) => SupportTransitionResult,
		now: Date,
	): SupportUpdateOutcome =>
		db
			.transaction((): SupportUpdateOutcome => {
				const row = byId.get(id);
				if (!row) return { ok: false, error: "not_found" };
				const current = toRecord(row);
				if (current.rev !== expected_rev)
					return { ok: false, error: "stale_binding" };
				const next = step(current.job);
				if (!next.ok) return { ok: false, error: "invalid_state" };
				const j = next.job;
				// a step that changes nothing (cancel of a CANCELLED job) writes nothing
				if (
					j.status === current.job.status &&
					j.cancel_requested === current.job.cancel_requested &&
					j.profile_id === current.job.profile_id
				)
					return { ok: true, record: current };
				const at = now.toISOString();
				const changed = update.run(
					j.status,
					j.cancel_requested ? 1 : 0,
					j.profile_id,
					j.result === null ? null : JSON.stringify(j.result),
					j.failure === null ? null : JSON.stringify(j.failure),
					at,
					id,
					expected_rev,
				).changes;
				if (changed !== 1) return { ok: false, error: "stale_binding" };
				return {
					ok: true,
					record: { job: j, rev: expected_rev + 1, updated_at: at },
				};
			})
			.immediate();

	return {
		create({ created_by, idempotency_key, request, now }) {
			const at = now.toISOString();
			return db
				.transaction((): SupportCreateOutcome => {
					const made = createSupportJob(request, {
						id: `sj-${randomUUID()}`,
						created_seq: nextSeq.get()?.n ?? 0,
						created_at: at,
					});
					if (!made.ok)
						return { ok: false, error: "invalid_request", issues: made.issues };
					const job = made.job;
					const hash = requestHash(job);
					const prior = byKey.get(created_by, idempotency_key);
					if (prior)
						return hashesEqual(prior.request_hash, hash)
							? { ok: true, created: false, record: toRecord(prior) }
							: { ok: false, error: "idempotency_conflict" };
					insert.run(
						job.id,
						job.created_seq,
						created_by,
						idempotency_key,
						hash,
						job.repo_id,
						job.kind,
						job.capability,
						JSON.stringify(job.inputs),
						job.brief,
						job.priority,
						job.disabled ? 1 : 0,
						at,
						at,
					);
					return {
						ok: true,
						created: true,
						record: { job, rev: 1, updated_at: at },
					};
				})
				.immediate();
		},

		get(id) {
			if (!SupportJobId.safeParse(id).success) return null;
			const row = byId.get(id);
			return row ? toRecord(row) : null;
		},

		list({ repo_id, status, limit, before_seq }) {
			return db
				.transaction((): SupportListPage => {
					const total = countQ.get(repo_id, status)?.n ?? 0;
					const rows = pageQ.all(repo_id, status, before_seq, limit + 1);
					return {
						records: rows.slice(0, limit).map(toRecord),
						total,
						has_more: rows.length > limit,
					};
				})
				.deferred();
		},

		cancel(id, expected_rev, now) {
			return write(id, expected_rev, requestSupportCancel, now);
		},

		transition(id, expected_rev, step, now) {
			return write(id, expected_rev, step, now);
		},
	};
}
