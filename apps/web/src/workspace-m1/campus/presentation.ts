// Frozen presentation interface for the business-campus scene (lead-owned, milestone "campus port").
//
// The scene is PRESENTATION ONLY. It receives a read-only `CampusModel` derived from the existing
// server-backed store state (`WsState` — never a fixture authority, never synthetic hashes) and may
// emit exactly three intents: select a repository, select a task, open an approval document. It has
// no way to approve, queue, advance, cancel or accept anything; every gate stays in the DOM document
// with a freshly typed `Edward` and an explicit button. Animation completion never emits anything.
import type {
	AcceptanceValidityStatus,
	ApprovalKind,
	Provenance,
	WorkspacePhase,
} from "@agent-city/schema/workspace-m1";
import type { WsState } from "../store.ts";

export const CAMPUS_INTERFACE_VERSION = "agentcity.campus-presentation/v1";

export interface CampusValidity {
	status: AcceptanceValidityStatus;
	reason: string | null;
	/** When the SERVER last checked (periodic; not a detection-time guarantee). */
	checked_at: string;
}

export interface CampusTask {
	task_id: string;
	repo_id: string;
	title: string;
	phase: WorkspacePhase;
	selected: boolean;
	/** Historical decision: true once a Gate-2 accept exists (never rewritten by validity). */
	accepted: boolean;
	/** Current validity of the accepted result (null when nothing is accepted). */
	validity: CampusValidity | null;
	/** Present only when the task's detail is loaded (selected task). */
	execution: {
		managed_task_id: string;
		attempt_no: number | null;
		engine_state: string;
	} | null;
	/** Worst criterion status of the sealed result, when the detail is loaded and a result exists. */
	coverage: "satisfied" | "unsatisfied" | "unresolved" | "none" | null;
}

export interface CampusPendingRequest {
	/** Stable identity: the scene keys CEO visits by this id (polling must not restart a visit). */
	request_id: string;
	kind: ApprovalKind;
	gate_label: "Execution approval" | "Result acceptance";
	task_id: string;
	repo_id: string;
	title: string;
	created_at: string;
	selected: boolean;
}

export interface CampusRepo {
	repo_id: string;
	/** Display name (the part after the slash). */
	label: string;
	selected: boolean;
	active_tasks: number;
	pending_requests: number;
	/** Any accepted task in this repo whose CURRENT validity is invalid. */
	has_invalid_acceptance: boolean;
}

export interface CampusModel {
	version: typeof CAMPUS_INTERFACE_VERSION;
	provenance: Provenance | null;
	connection: {
		status: "connecting" | "online" | "offline";
		last_confirmed_at: string | null;
	};
	view: "projects" | "hq" | "activity";
	repos: CampusRepo[];
	tasks: CampusTask[];
	/** Every pending approval request (oldest first, as the server lists them). */
	pending: CampusPendingRequest[];
	selected: {
		repo_id: string | null;
		task_id: string | null;
		request_id: string | null;
	};
}

/** The ONLY intents the scene may emit. They change selection/navigation, never workflow state. */
export interface CampusActions {
	selectRepo(repoId: string): void;
	selectTask(taskId: string): void;
	/** Opens the approval document in the DOM (Headquarters). Never decides anything. */
	openRequest(requestId: string): void;
}

/** Props of the lazily loaded scene component (Worker B implements `CampusScene`). */
export interface CampusSceneProps {
	model: CampusModel;
	actions: CampusActions;
	/** prefers-reduced-motion: stationary or immediate-arrival equivalents, no ambient motion. */
	reducedMotion: boolean;
	/** Called once if WebGL is unavailable or the context is lost (the DOM navigator stays usable). */
	onUnavailable?(reason: "no_webgl" | "context_lost" | "init_failed"): void;
}

const ACTIVE: ReadonlySet<WorkspacePhase> = new Set([
	"queued",
	"implementing",
	"verifying",
	"reviewing",
	"repairing",
	"finalizing",
	"cancel_requested",
]);

const COVERAGE_RANK = { satisfied: 0, unresolved: 1, unsatisfied: 2 } as const;

/** Pure selector: existing store state → frozen presentation model. */
export function toCampusModel(s: WsState): CampusModel {
	const snap = s.snapshot;
	const route = s.route;
	const tasks: CampusTask[] = (snap?.tasks ?? []).map((item) => {
		const t = item.task;
		const detail = s.details[t.id]?.data ?? null;
		const engine = detail?.engine ?? null;
		const result = detail?.approval_requests.find(
			(r) => r.kind === "result" && r.result_envelope !== null,
		);
		const cov =
			result?.result_envelope && "criterion_coverage" in result.result_envelope
				? result.result_envelope.criterion_coverage
				: null;
		let coverage: CampusTask["coverage"] = detail ? "none" : null;
		if (cov && cov.length > 0)
			coverage = cov.reduce<"satisfied" | "unresolved" | "unsatisfied">(
				(worst, c) =>
					COVERAGE_RANK[c.status] > COVERAGE_RANK[worst] ? c.status : worst,
				"satisfied",
			);
		const v = item.acceptance_validity;
		return {
			task_id: t.id,
			repo_id: t.repo_id,
			title: t.draft.title,
			phase: item.phase,
			selected: route.taskId === t.id,
			accepted: t.accepted_decision_id !== null,
			validity: v
				? { status: v.status, reason: v.reason, checked_at: v.checked_at }
				: null,
			execution: engine
				? {
						managed_task_id: engine.managed_task_id,
						attempt_no: engine.attempt_no,
						engine_state: engine.state,
					}
				: null,
			coverage,
		};
	});
	const byId = new Map(tasks.map((t) => [t.task_id, t]));
	const pending: CampusPendingRequest[] = (snap?.pending_requests ?? []).map(
		(r) => ({
			request_id: r.id,
			kind: r.kind,
			gate_label: r.kind === "run" ? "Execution approval" : "Result acceptance",
			task_id: r.workspace_task_id,
			repo_id: byId.get(r.workspace_task_id)?.repo_id ?? "",
			title: byId.get(r.workspace_task_id)?.title ?? "",
			created_at: r.created_at,
			selected: route.requestId === r.id,
		}),
	);
	const repos: CampusRepo[] = (snap?.repos ?? []).map((r) => ({
		repo_id: r.repo_id,
		label: r.repo_id.split("/")[1] ?? r.repo_id,
		selected: route.repoId === r.repo_id,
		active_tasks: tasks.filter(
			(t) => t.repo_id === r.repo_id && ACTIVE.has(t.phase),
		).length,
		pending_requests: pending.filter((p) => p.repo_id === r.repo_id).length,
		has_invalid_acceptance: tasks.some(
			(t) => t.repo_id === r.repo_id && t.validity?.status === "invalid",
		),
	}));
	return {
		version: CAMPUS_INTERFACE_VERSION,
		provenance: snap?.provenance ?? null,
		connection: {
			status: s.conn.status,
			last_confirmed_at: s.conn.lastConfirmedAt,
		},
		view: route.view,
		repos,
		tasks,
		pending,
		selected: {
			repo_id: route.repoId,
			task_id: route.taskId,
			request_id: route.requestId,
		},
	};
}
