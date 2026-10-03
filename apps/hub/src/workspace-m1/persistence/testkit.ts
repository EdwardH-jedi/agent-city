// Test-only support for the persistence tests (never imported by production code). Synthetic data
// only: the disposable `local/fixture` repo id, non-existent absolute paths in the managed config
// (policyHash never touches the file system), fake shas, no git, no network.
//
// `publishProposal` and `decideRun` are minimal stand-ins for the §6 publish row and the §7
// decision transaction (roles 04/05 own the real ones). The challenge here is an OPAQUE synthetic
// value written with the generic CAS update — challenge hashing/verification is role 03's.
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS_DIR } from "@agent-city/schema/migrations";
import {
	type ApprovalRequestRow,
	approvalStatusFor,
	buildProposalSnapshot,
	DECISION_CONTRACT,
	type DecisionPayload,
	type DecisionReceiptBody,
	OPERATOR_ID,
	ProposalDraft,
	RESULT_CONTRACT,
	REVIEW_RECORD_CONTRACT,
	type ResultEnvelope,
	stageAfterDecision,
	WORKSPACE_TASK_CONTRACT,
	type WorkspaceDraft,
	type WorkspaceTaskRow,
} from "@agent-city/schema/workspace-m1";
import {
	buildProposalSnapshotV1_2,
	createTaskRequestHash,
	decisionPayloadHash,
	newWorkspaceId,
	reviewRecordHash,
	sealAnyProposal,
	sealResultApprovalBinding,
	sealResultEnvelope,
	sealRunApprovalBinding,
	sha256Hex,
} from "@agent-city/schema/workspace-m1/hash";
import { openDb } from "../../db.ts";
import {
	type ManagedConfig,
	parseManagedConfig,
} from "../../managed/config.ts";
import { getTask, insertRun } from "../../managed/store.ts";
import {
	enqueueApprovedTask,
	type ManagedWriteDeps,
	type ManagedWriteHooks,
	releaseReservedTask,
	reserveManagedTask,
} from "./managed-writes.ts";
import { ensureWorkspaceSchema } from "./migration.ts";
import {
	createWorkspaceStore,
	type PersistentWorkspaceStore,
} from "./store.ts";

export const FIXTURE_REPO = "local/fixture";
export const BASE_SHA = "a1".repeat(20);
export const BOOT_ID = "boot-99999999-9999-4999-8999-999999999999";
const T0 = Date.parse("2026-10-02T00:00:00.000Z");

/** Deterministic, strictly increasing timestamps (toISOString form). */
export function clock(startSeconds = 0) {
	let n = startSeconds;
	return () => new Date(T0 + 1000 * n++).toISOString();
}

/** Trusted managed config pointing at non-existent paths; `variant` changes the policy hash. */
export function fixtureConfig(variant = 0): ManagedConfig {
	return parseManagedConfig({
		workspace_root: "/nonexistent/agentcity-ws02/workspaces",
		artifacts_root: "/nonexistent/agentcity-ws02/artifacts",
		git_executable: "/usr/bin/git",
		repos: [
			{
				id: FIXTURE_REPO,
				path: "/nonexistent/agentcity-ws02/repo",
				base_ref: "main",
				verification: [
					{
						name: "unit",
						argv: ["/bin/sh", "verify.sh"],
						timeout_s: 60 + variant,
					},
				],
			},
		],
	});
}

export function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "ws02-persistence-"));
}

export const removeDir = (dir: string) =>
	rmSync(dir, { recursive: true, force: true });

/** A handle with openDb's pragmas (busy_timeout before WAL, foreign keys) but NO migrations. */
export function openRaw(path: string): Database {
	const db = new Database(path, { create: true, strict: true });
	db.run("PRAGMA busy_timeout = 5000");
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");
	return db;
}

/**
 * A genuine 007 database (openDb now applies the registered 008 itself): applies only the
 * registered `001`–`007` files from MIGRATIONS_DIR with db.ts semantics (each file + its
 * `PRAGMA user_version` in one immediate transaction, skipped if already applied).
 */
export function openDb007(path: string): Database {
	const db = openRaw(path);
	const files = readdirSync(MIGRATIONS_DIR)
		.filter((f) => /^\d+_.*\.sql$/.test(f))
		.sort();
	for (const file of files) {
		const version = Number.parseInt(file, 10);
		if (version > 7) continue;
		const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
		db.transaction(() => {
			const current =
				db
					.query<{ v: number }, []>(
						"SELECT user_version AS v FROM pragma_user_version",
					)
					.get()?.v ?? 0;
			if (version <= current) return;
			db.run(sql);
			db.run(`PRAGMA user_version = ${version}`);
		}).immediate();
	}
	return db;
}

export interface Workspace {
	db: Database;
	store: PersistentWorkspaceStore;
	deps: ManagedWriteDeps;
}

/** openDb (001–007 + WAL + FK + busy_timeout) then 008 via ensureWorkspaceSchema. */
export function openWorkspace(
	path: string,
	opts: { config?: ManagedConfig; hooks?: ManagedWriteHooks } = {},
): Workspace {
	const db = openDb(path);
	ensureWorkspaceSchema(db);
	return {
		db,
		store: createWorkspaceStore(db),
		deps: { db, config: opts.config ?? fixtureConfig(), hooks: opts.hooks },
	};
}

export const draftFixture = (title = "Add a greeting"): WorkspaceDraft => ({
	title,
	objective: "Print a greeting from the CLI.",
	criteria: ["Prints hello", "Exit code stays 0"],
	scope: { allowed: ["src"], protected: ["config"] },
	execution_mode: "simulated",
	simulation_scenario: "approve",
	repair_policy: { max_repairs: 0 },
	// v1.2 (explicit, never inferred): each criterion is covered by the trusted check `unit`
	criterion_checks: [
		{ criterion: "Prints hello", checks: ["unit"] },
		{ criterion: "Exit code stays 0", checks: ["unit"] },
	],
});

export function taskRow(
	now: string,
	opts: { key?: string; draft?: WorkspaceDraft; id?: string } = {},
): WorkspaceTaskRow {
	const draft = opts.draft ?? draftFixture();
	return {
		id: opts.id ?? newWorkspaceId("wst"),
		contract_version: WORKSPACE_TASK_CONTRACT,
		repo_id: FIXTURE_REPO,
		created_by: OPERATOR_ID,
		idempotency_key: opts.key ?? `create-${crypto.randomUUID()}`,
		request_hash: createTaskRequestHash({ repo_id: FIXTURE_REPO, draft }),
		draft,
		stage: "draft",
		stage_detail: null,
		current_proposal_id: null,
		current_managed_task_id: null,
		accepted_decision_id: null,
		cancel_requested_at: null,
		created_at: now,
		updated_at: now,
		rev: 1,
	};
}

export function createTask(
	store: PersistentWorkspaceStore,
	now: string,
	opts: { key?: string; draft?: WorkspaceDraft } = {},
): WorkspaceTaskRow {
	const row = taskRow(now, opts);
	store.transaction((tx) => tx.insertTask(row));
	return row;
}

const noChallenge = {
	challenge_status: "none",
	challenge_hash: null,
	challenge_operator_id: null,
	challenge_session_generation: null,
	challenge_boot_id: null,
	challenge_request_rev: null,
	challenge_issued_at: null,
	challenge_expires_at: null,
} as const;

/**
 * §6 publish_proposal: insert proposal v(N+1); supersede the pending run request (invalidate +
 * release its reserved task); reserve a managed task; insert the run request; point the task.
 */
export function publishProposal(
	ws: Workspace,
	workspace_task_id: string,
	now: string,
	/** `legacy: true` = a pre-v1.2 (v1) proposal, as stored before migration 010. */
	o: { legacy?: boolean } = {},
): {
	task: WorkspaceTaskRow;
	request: ApprovalRequestRow;
	proposal_id: string;
	managed_task_id: string;
} {
	return ws.store.transaction((tx) => {
		const task = tx.getTask(workspace_task_id);
		if (!task) throw new Error("no task");
		const prev = task.current_proposal_id
			? tx.getProposal(task.current_proposal_id)
			: null;
		const proposal_id = newWorkspaceId("wsp");
		const input = {
			proposal_id,
			workspace_task_id,
			version: prev ? prev.version + 1 : 1,
			predecessor_proposal_id: prev?.id ?? null,
			repo_id: task.repo_id,
			base_ref: "main",
			base_sha: BASE_SHA,
			required_checks: ["unit"],
			draft: ProposalDraft.parse(task.draft),
		};
		const built = o.legacy
			? buildProposalSnapshot(input)
			: buildProposalSnapshotV1_2(input);
		if (!built.ok) throw new Error(JSON.stringify(built.issues));
		const sealed = sealAnyProposal(built.snapshot);
		tx.insertProposal({
			id: proposal_id,
			workspace_task_id,
			version: sealed.value.version,
			predecessor_proposal_id: sealed.value.predecessor_proposal_id,
			contract_version: sealed.value.contract,
			snapshot: sealed.value,
			proposal_hash: sealed.hash,
			created_by: OPERATOR_ID,
			created_at: now,
		});
		const pending = tx.listApprovalRequests({
			workspace_task_id,
			kind: "run",
			status: "pending",
		})[0];
		if (pending) {
			const closed = tx.updateApprovalRequest(
				pending.id,
				pending.rev,
				{
					status: "invalidated",
					invalidation_reason: "proposal_superseded",
					invalidation_detail: `superseded by version ${sealed.value.version}`,
					closed_at: now,
				},
				now,
			);
			if (!closed) throw new Error("CAS miss on the superseded request");
			releaseReservedTask(ws.deps, tx, {
				managed_task_id: pending.managed_task_id,
				reason: "proposal_superseded",
				now,
			});
		}
		const request_id = newWorkspaceId("wsa");
		const reserved = reserveManagedTask(ws.deps, tx, {
			proposal: sealed.value,
			proposal_hash: sealed.hash,
			approval_request_id: request_id,
			now,
		});
		const binding = sealRunApprovalBinding({
			approval_request_id: request_id,
			workspace_task_id,
			proposal_id,
			proposal_hash: sealed.hash,
			execution_binding_hash: reserved.execution_binding_hash,
		});
		tx.insertApprovalRequest({
			id: request_id,
			workspace_task_id,
			kind: "run",
			proposal_id,
			proposal_hash: sealed.hash,
			managed_task_id: reserved.managed_task_id,
			execution_binding: reserved.execution_binding,
			execution_binding_hash: reserved.execution_binding_hash,
			run_id: null,
			result_envelope: null,
			result_envelope_hash: null,
			binding: binding.value,
			binding_hash: binding.hash,
			status: "pending",
			invalidation_reason: null,
			invalidation_detail: null,
			created_at: now,
			updated_at: now,
			closed_at: null,
			rev: 1,
			...noChallenge,
		});
		const updated = tx.updateTask(
			workspace_task_id,
			task.rev,
			{
				stage: "awaiting_run_approval",
				current_proposal_id: proposal_id,
				current_managed_task_id: reserved.managed_task_id,
			},
			now,
		);
		if (!updated) throw new Error("CAS miss on the workspace task");
		const request = tx.getApprovalRequest(request_id);
		if (!request) throw new Error("request vanished");
		return {
			task: updated,
			request,
			proposal_id,
			managed_task_id: reserved.managed_task_id,
		};
	});
}

/** Synthetic challenge issuance (opaque hash; bumps the request rev like ChallengePort.issue). */
export function issueChallenge(
	ws: Workspace,
	request_id: string,
	now: string,
): ApprovalRequestRow {
	return ws.store.transaction((tx) => {
		const r = tx.getApprovalRequest(request_id);
		if (!r) throw new Error("no request");
		const out = tx.updateApprovalRequest(
			request_id,
			r.rev,
			{
				challenge_status: "issued",
				challenge_hash: sha256Hex(`synthetic-challenge:${request_id}:${r.rev}`),
				challenge_operator_id: OPERATOR_ID,
				challenge_session_generation: 1,
				challenge_boot_id: BOOT_ID,
				challenge_request_rev: r.rev + 1,
				challenge_issued_at: now,
				challenge_expires_at: new Date(Date.parse(now) + 300_000).toISOString(),
			},
			now,
		);
		if (!out) throw new Error("CAS miss");
		return out;
	});
}

export type InjectionPoint =
	| "after_consume"
	| "after_insert_decision"
	| "after_effects";

export type DecideOutcome =
	| { kind: "decided"; receipt: DecisionReceiptBody }
	| { kind: "replayed"; receipt: DecisionReceiptBody }
	| { kind: "conflict" }
	| { kind: "stale" }
	| { kind: "challenge_invalid" };

/**
 * §7 for a Gate-1 decision: receipt lookup first (before any challenge check), then ONE immediate
 * transaction: load + compare request/task, consume the challenge, insert decision + receipt
 * (receipt precomputed from the expected revs), close the request, move the stage, apply the
 * managed effect; finally assert the effects equal the receipt (else roll back).
 */
export function decideRun(
	ws: Workspace,
	input: {
		request_id: string;
		binding_hash: string;
		action: "approve" | "request_changes" | "reject";
		key: string;
		expected_request_rev: number;
		now: string;
		decision_id?: string;
		inject?: (point: InjectionPoint) => void;
	},
): DecideOutcome {
	const approve = input.action === "approve";
	const payload: DecisionPayload = {
		contract: DECISION_CONTRACT,
		approval_request_id: input.request_id,
		kind: "run",
		action: input.action,
		expected_request_rev: input.expected_request_rev,
		binding_hash: input.binding_hash,
		confirmation_text: approve ? "Edward" : null,
		reason: approve ? null : "Please narrow the scope.",
	};
	const payload_hash = decisionPayloadHash(payload);
	const replay = (): DecideOutcome | null => {
		const prior = ws.store.findReceipt(OPERATOR_ID, input.key);
		if (!prior) return null;
		return prior.payload_hash === payload_hash
			? { kind: "replayed", receipt: prior.response_body }
			: { kind: "conflict" };
	};
	const early = replay();
	if (early) return early;

	return ws.store.transaction((tx): DecideOutcome => {
		// a concurrent duplicate may have committed between the lookup and BEGIN IMMEDIATE
		const prior = tx.findReceipt(OPERATOR_ID, input.key);
		if (prior)
			return prior.payload_hash === payload_hash
				? { kind: "replayed", receipt: prior.response_body }
				: { kind: "conflict" };
		const req = tx.getApprovalRequest(input.request_id);
		const task = req ? tx.getTask(req.workspace_task_id) : null;
		if (
			!req ||
			!task ||
			req.kind !== "run" ||
			req.status !== "pending" ||
			task.stage !== "awaiting_run_approval" ||
			req.rev !== input.expected_request_rev ||
			req.binding_hash !== input.binding_hash
		)
			return { kind: "stale" };
		if (req.challenge_status !== "issued") return { kind: "challenge_invalid" };
		const consumed = tx.updateApprovalRequest(
			req.id,
			req.rev,
			{ challenge_status: "consumed" },
			input.now,
		);
		if (!consumed) throw new Error("CAS miss while consuming");
		input.inject?.("after_consume");

		const status = approvalStatusFor(input.action);
		const { to } = stageAfterDecision("run", input.action);
		const decision_id = input.decision_id ?? newWorkspaceId("wsd");
		const receipt: DecisionReceiptBody = {
			contract: DECISION_CONTRACT,
			decision_id,
			approval_request_id: req.id,
			workspace_task_id: task.id,
			kind: "run",
			action: input.action,
			operator_id: OPERATOR_ID,
			decided_at: input.now,
			payload_hash,
			binding_hash: req.binding_hash,
			approval_request: { status, rev: consumed.rev + 1 },
			workspace_task: { stage: to, rev: task.rev + 1 },
			effects: {
				managed_task_id: req.managed_task_id,
				managed_task_state: approve ? "queued" : "cancelled",
				result_envelope_hash: null,
			},
		};
		tx.insertDecision({
			id: decision_id,
			approval_request_id: req.id,
			workspace_task_id: task.id,
			kind: "run",
			action: input.action,
			operator_id: OPERATOR_ID,
			idempotency_key: input.key,
			payload_hash,
			binding_hash: req.binding_hash,
			request_rev: input.expected_request_rev,
			confirmation_text: payload.confirmation_text,
			reason: payload.reason,
			boot_id: BOOT_ID,
			session_generation: 1,
			managed_task_id: req.managed_task_id,
			result_envelope_hash: null,
			decided_at: input.now,
			response_status: 201,
			response_body: receipt,
		});
		input.inject?.("after_insert_decision");

		const closed = tx.updateApprovalRequest(
			req.id,
			consumed.rev,
			{ status, closed_at: input.now },
			input.now,
		);
		const moved = tx.updateTask(task.id, task.rev, { stage: to }, input.now);
		if (!closed || !moved) throw new Error("CAS miss while applying effects");
		if (approve) {
			const res = enqueueApprovedTask(ws.deps, tx, {
				managed_task_id: req.managed_task_id,
				decision_id,
				execution_binding_hash: req.execution_binding_hash,
				now: input.now,
			});
			if (!res.queued) throw new Error(`enqueue refused: ${res.reason}`);
		} else {
			releaseReservedTask(ws.deps, tx, {
				managed_task_id: req.managed_task_id,
				reason: input.action === "reject" ? "rejected" : "changes_requested",
				now: input.now,
			});
		}
		input.inject?.("after_effects");
		const engine = getTask(ws.db, req.managed_task_id);
		if (
			closed.rev !== receipt.approval_request.rev ||
			moved.rev !== receipt.workspace_task.rev ||
			engine?.state !== receipt.effects.managed_task_state
		)
			throw new Error("effects differ from the precomputed receipt");
		return { kind: "decided", receipt };
	});
}

/** Every row of the workflow + engine tables, in insert order — byte-comparable snapshots. */
export function dumpAll(db: Database): string {
	const tables = [
		"workspace_tasks",
		"managed_proposals",
		"managed_approval_requests",
		"managed_decisions",
		"managed_tasks",
		"managed_runs",
		"managed_quarantine",
	];
	return JSON.stringify(
		Object.fromEntries(
			tables.map((t) => [
				t,
				db.query(`SELECT * FROM ${t} ORDER BY rowid`).all(),
			]),
		),
	);
}

export const count = (db: Database, sql: string, ...args: string[]): number =>
	db.query<{ n: number }, string[]>(sql).get(...args)?.n ?? 0;

/** Seed one attempt row the way the engine would (test-only; the worker owns this in production). */
export function seedRun(ws: Workspace, managed_task_id: string, now: string) {
	const task = getTask(ws.db, managed_task_id);
	if (!task) throw new Error("no managed task");
	return insertRun(ws.db, {
		task,
		kind: "initial",
		parent_run_id: null,
		repair_input: null,
		workspace_path: null,
		branch: null,
		parent_sha: null,
		provider: "fake",
		mode: "simulated",
		model_requested: null,
		now,
	});
}

/** An eligible-looking result envelope for one attempt (shape of fixtures/sample.ts, attempt 1). */
export function resultEnvelopeFor(i: {
	workspace_task_id: string;
	proposal_id: string;
	proposal_hash: string;
	execution_binding_hash: string;
	policy_hash: string;
	run_decision_id: string;
	managed_task_id: string;
	run_id: string;
}) {
	const candidate = "c3".repeat(20);
	const manifest = "f6".repeat(32);
	const review_id = `rev-${crypto.randomUUID()}`;
	const review_hash = reviewRecordHash({
		contract: REVIEW_RECORD_CONTRACT,
		review_id,
		managed_task_id: i.managed_task_id,
		run_id: i.run_id,
		provider: "fake",
		mode: "simulated",
		model_requested: null,
		model_resolved: null,
		candidate_sha: candidate,
		manifest_hash: manifest,
		verdict: "approve",
		valid: true,
		invalidated_reason: null,
		findings: [],
		summary: "Simulated review: approve.",
	});
	const art = (
		n: number,
		name: string,
		kind: ResultEnvelope["artifacts"][number]["kind"],
	) => ({
		name,
		kind,
		status: "verified" as const,
		artifact_id: `art-77777777-7777-4777-8777-77777777777${n}`,
		sha256: `0${n}`.repeat(32),
		byte_len: 100 + n,
		truncated: false,
	});
	const fake = {
		provider: "fake" as const,
		mode: "simulated" as const,
		model_requested: null,
		model_resolved: null,
	};
	return sealResultEnvelope({
		contract: RESULT_CONTRACT,
		workspace_task_id: i.workspace_task_id,
		proposal_id: i.proposal_id,
		proposal_hash: i.proposal_hash,
		execution_binding_hash: i.execution_binding_hash,
		run_decision_id: i.run_decision_id,
		managed_task_id: i.managed_task_id,
		run_id: i.run_id,
		attempt_no: 1,
		max_repairs: 0,
		base_sha: BASE_SHA,
		parent_sha: BASE_SHA,
		candidate_sha: candidate,
		candidate_tree: "d4".repeat(20),
		manifest_hash: manifest,
		execution_mode: "simulated",
		policy_hash: i.policy_hash,
		required_checks: ["unit"],
		artifacts: [
			art(2, "diff.patch", "diff"),
			art(4, "manifest.json", "manifest"),
			art(5, "review-output.json", "review_output"),
			art(7, "verify-1-unit.log", "verification_log"),
		],
		verification: [
			{
				name: "unit",
				completed: true,
				timed_out: false,
				exit_code: 0,
				duration_ms: 10,
				log_sha256: "07".repeat(32),
				log_truncated: false,
			},
		],
		review: {
			review_id,
			review_hash,
			verdict: "approve",
			valid: true,
			candidate_sha: candidate,
			manifest_hash: manifest,
			findings: 0,
			blocking_findings: 0,
		},
		provenance: { implementer: fake, reviewer: fake },
		evidence_status: "verified",
	});
}

/** A Gate-2 request row for an attempt of an approved execution (status chosen by the caller). */
export function resultRequestRow(
	runRequest: ApprovalRequestRow,
	run_decision_id: string,
	run_id: string,
	now: string,
	status: "pending" | "invalidated" = "pending",
): ApprovalRequestRow {
	const id = newWorkspaceId("wsa");
	const env = resultEnvelopeFor({
		workspace_task_id: runRequest.workspace_task_id,
		proposal_id: runRequest.proposal_id,
		proposal_hash: runRequest.proposal_hash,
		execution_binding_hash: runRequest.execution_binding_hash,
		policy_hash: runRequest.execution_binding.policy_hash,
		run_decision_id,
		managed_task_id: runRequest.managed_task_id,
		run_id,
	});
	const binding = sealResultApprovalBinding({
		approval_request_id: id,
		workspace_task_id: runRequest.workspace_task_id,
		managed_task_id: runRequest.managed_task_id,
		run_id,
		result_envelope_hash: env.hash,
	});
	return {
		id,
		workspace_task_id: runRequest.workspace_task_id,
		kind: "result",
		proposal_id: runRequest.proposal_id,
		proposal_hash: runRequest.proposal_hash,
		managed_task_id: runRequest.managed_task_id,
		execution_binding: runRequest.execution_binding,
		execution_binding_hash: runRequest.execution_binding_hash,
		run_id,
		result_envelope: env.value,
		result_envelope_hash: env.hash,
		binding: binding.value,
		binding_hash: binding.hash,
		status,
		invalidation_reason:
			status === "invalidated" ? "evidence_unavailable" : null,
		invalidation_detail: null,
		created_at: now,
		updated_at: now,
		closed_at: status === "invalidated" ? now : null,
		rev: 1,
		...noChallenge,
	};
}

/** publish + challenge + approve: a task whose Gate 1 is approved and whose managed task is queued. */
export function approvedExecution(
	ws: Workspace,
	now: () => string,
	o: { legacy?: boolean } = {},
) {
	const task = createTask(ws.store, now());
	const pub = publishProposal(ws, task.id, now(), o);
	const ch = issueChallenge(ws, pub.request.id, now());
	const decision_id = newWorkspaceId("wsd");
	const out = decideRun(ws, {
		request_id: pub.request.id,
		binding_hash: pub.request.binding_hash,
		action: "approve",
		key: `decide-${crypto.randomUUID()}`,
		expected_request_rev: ch.rev,
		now: now(),
		decision_id,
	});
	if (out.kind !== "decided") throw new Error(`approve failed: ${out.kind}`);
	const runRequest = ws.store.getApprovalRequest(pub.request.id);
	if (!runRequest) throw new Error("run request vanished");
	return { ...pub, runRequest, decision_id };
}

/**
 * A Gate-2 `accept` written through the store (test-only; role 04 owns the real decision path):
 * approved execution → attempt → engine human_ready → result request (+ an evidence bundle row when
 * `digest` is given, inserted first) → accept decision (+ receipt) → close request → task accepted.
 * `digest: null` = a legacy (pre-009) acceptance without durable evidence.
 */
export function gate2Accept(
	ws: Workspace,
	now: () => string,
	o: {
		digest?: string | null;
		validity?: boolean;
		/** Override the decision's (and receipt's) digest — trigger tests only. */
		decision_digest?: string | null;
		/** Stop with the result request still pending (no decision). */
		pending?: boolean;
		/** A legacy (v1, pre-010) proposal. */
		legacy?: boolean;
	} = {},
) {
	const ex = approvedExecution(ws, now, { legacy: o.legacy ?? false });
	const run = seedRun(ws, ex.managed_task_id, now());
	ws.db.run(
		"UPDATE managed_tasks SET state = 'human_ready', result_run_id = ?, rev = rev + 1 WHERE id = ?",
		[run.id, ex.managed_task_id],
	); // simulated engine outcome (test-only)
	const base = resultRequestRow(ex.runRequest, ex.decision_id, run.id, now());
	const digest = o.digest ?? null;
	const result: ApprovalRequestRow = digest
		? { ...base, evidence_bundle_digest: digest }
		: base;
	const at = now();
	ws.store.transaction((tx) => {
		let t = tx.getTask(ex.task.id);
		if (!t) throw new Error("unreachable");
		t = tx.updateTask(t.id, t.rev, { stage: "running" }, at);
		if (!t) throw new Error("unreachable");
		if (digest && result.result_envelope_hash)
			tx.insertEvidenceBundle({
				digest,
				result_envelope_hash: result.result_envelope_hash,
				managed_task_id: ex.managed_task_id,
				run_id: run.id,
				rel_path: `_sealed/${digest}.bundle`,
				byte_len: 100,
				item_count: 4,
				created_at: at,
			});
		tx.insertApprovalRequest(result);
		tx.updateTask(t.id, t.rev, { stage: "awaiting_acceptance" }, at);
	});
	if (o.pending)
		return {
			...ex,
			run_id: run.id,
			result_request_id: result.id,
			accept_decision_id: "",
			digest,
		};
	const decision_id = newWorkspaceId("wsd");
	const t = now();
	const key = `gate2-accept-${crypto.randomUUID()}`;
	const decided = o.decision_digest === undefined ? digest : o.decision_digest;
	ws.store.transaction((tx) => {
		const r = tx.getApprovalRequest(result.id);
		const cur = tx.getTask(ex.task.id);
		if (!r || !cur || !r.result_envelope_hash) throw new Error("unreachable");
		const payload_hash = sha256Hex(`gate2-accept-payload-${key}`);
		tx.insertDecision({
			id: decision_id,
			approval_request_id: r.id,
			workspace_task_id: cur.id,
			kind: "result",
			action: "accept",
			operator_id: OPERATOR_ID,
			idempotency_key: key,
			payload_hash,
			binding_hash: r.binding_hash,
			request_rev: r.rev,
			confirmation_text: "Edward",
			reason: null,
			boot_id: BOOT_ID,
			session_generation: 1,
			managed_task_id: r.managed_task_id,
			result_envelope_hash: r.result_envelope_hash,
			decided_at: t,
			response_status: 201,
			response_body: {
				contract: DECISION_CONTRACT,
				decision_id,
				approval_request_id: r.id,
				workspace_task_id: cur.id,
				kind: "result",
				action: "accept",
				operator_id: OPERATOR_ID,
				decided_at: t,
				payload_hash,
				binding_hash: r.binding_hash,
				approval_request: { status: "accepted", rev: r.rev + 1 },
				workspace_task: { stage: "accepted", rev: cur.rev + 1 },
				effects: {
					managed_task_id: r.managed_task_id,
					managed_task_state: "human_ready",
					result_envelope_hash: r.result_envelope_hash,
					...(decided ? { evidence_bundle_digest: decided } : {}),
				},
			},
			...(decided ? { evidence_bundle_digest: decided } : {}),
		});
		if (digest && o.validity !== false)
			tx.insertAcceptanceValidity({
				decision_id,
				result_request_id: r.id,
				workspace_task_id: cur.id,
				evidence_bundle_digest: digest,
				status: "valid",
				reason: null,
				detail: null,
				checked_at: t,
				first_invalid_at: null,
				rev: 1,
			});
		tx.updateApprovalRequest(
			r.id,
			r.rev,
			{ status: "accepted", closed_at: t },
			t,
		);
		tx.updateTask(
			cur.id,
			cur.rev,
			{ stage: "accepted", accepted_decision_id: decision_id },
			t,
		);
	});
	return {
		...ex,
		run_id: run.id,
		result_request_id: result.id,
		accept_decision_id: decision_id,
		digest,
	};
}
