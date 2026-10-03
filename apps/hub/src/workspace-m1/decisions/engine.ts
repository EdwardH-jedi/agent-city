// The engine seam of the decision/command services: the frozen `ExecutionBridge` port (ports.ts).
// Role 05 owns the real bridge; until it lands (and for tests) `createManagedBridge` implements the
// port on top of role 02's accepted managed writes (reserve / enqueueApproved / releaseReserved, each
// of which proves it runs inside an open workspace transaction on the same Database handle) and the
// existing managed store reads. Nothing here starts work: enqueue only moves draft → queued.
import type { Database } from "bun:sqlite";
import type { ManagedTask } from "@agent-city/schema";
import { redact } from "@agent-city/schema";
import type {
	EngineView,
	ExecutionBridge,
} from "@agent-city/schema/workspace-m1";
import { EngineView as EngineViewSchema } from "@agent-city/schema/workspace-m1";
import type { ManagedConfig } from "../../managed/config.ts";
import {
	getRun,
	getTask,
	openQuarantineFor,
	requestCancel,
} from "../../managed/store.ts";
import {
	currentPolicyHash,
	enqueueApprovedTask,
	type ManagedWriteHooks,
	releaseReservedTask,
	reserveManagedTask,
} from "../persistence/index.ts";

const DETAIL_MAX = 500;
/** Absolute host paths (`/a/b…`, `~/…`) never reach a client, even inside engine detail text. */
const HOST_PATH = /(?:~\/|(?<![\w.])\/)(?:[^\s'"`(),;:]+\/)*[^\s'"`(),;:]*/g;

export const scrubDetail = (detail: string): string =>
	redact(detail).replace(HOST_PATH, "[path]").slice(0, DETAIL_MAX);

/** EngineView of one managed task (derived at read time; never copied into workspace rows). */
export function engineViewOf(db: Database, task: ManagedTask): EngineView {
	const run = task.current_run_id ? getRun(db, task.current_run_id) : null;
	return EngineViewSchema.parse({
		managed_task_id: task.id,
		state: task.state,
		failure_kind: task.failure_kind,
		state_detail:
			task.state_detail === null ? null : scrubDetail(task.state_detail),
		cancel_requested_at: task.cancel_requested_at,
		current_run_id: task.current_run_id,
		result_run_id: task.result_run_id,
		attempt_no: run ? run.attempt_no : null,
		quarantined: openQuarantineFor(db, task.id).length > 0,
		rev: task.rev,
	});
}

export interface ManagedBridgeDeps {
	/** The hub's single Database handle — the same one the WorkspaceStore was created on. */
	db: Database;
	/** The orchestrator's frozen config snapshot (source of policy_hash and approval_hash). */
	config: ManagedConfig;
	/** Test-only failure injection inside enqueue (02's hook points). */
	hooks?: ManagedWriteHooks;
}

/** ExecutionBridge over 02's managed writes. Replaceable by role 05's bridge (same port). */
export function createManagedBridge(deps: ManagedBridgeDeps): ExecutionBridge {
	const writeDeps = {
		db: deps.db,
		config: deps.config,
		...(deps.hooks ? { hooks: deps.hooks } : {}),
	};
	return {
		reserve(tx, input) {
			const r = reserveManagedTask(writeDeps, tx, input);
			return {
				managed_task_id: r.managed_task_id,
				execution_binding: r.execution_binding,
				execution_binding_hash: r.execution_binding_hash,
			};
		},
		enqueueApproved: (tx, input) => enqueueApprovedTask(writeDeps, tx, input),
		releaseReserved: (tx, input) => releaseReservedTask(writeDeps, tx, input),
		requestCancel(managed_task_id, now) {
			const t = requestCancel(deps.db, managed_task_id, now);
			if (!t) throw new Error("managed task not found");
			return engineViewOf(deps.db, t);
		},
		engineView(managed_task_id) {
			const t = getTask(deps.db, managed_task_id);
			return t ? engineViewOf(deps.db, t) : null;
		},
		currentPolicyHash: (repo_id) => currentPolicyHash(deps.config, repo_id),
	};
}
