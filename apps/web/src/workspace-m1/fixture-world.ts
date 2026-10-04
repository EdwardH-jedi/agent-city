// Deterministic in-memory UI fixture (role 07). It imitates the hub's workspace semantics closely
// enough to exercise every UI state, using the contract's own pure helpers (buildProposalSnapshot,
// decisionPayloadFrom, stageAfterDecision, the WORKSPACE_TRANSITIONS table…) so it cannot drift
// from the frozen rules silently. It is NOT authority and NOT evidence:
//   - hashes / shas / tokens are visibly synthetic counters (never a real digest);
//   - artifact content is synthetic text labelled as UI fixture;
//   - the engine only moves when a fixture CONTROL is called (tests / dev harness) — nothing
//     progresses by itself and no control is ever rendered in the product UI;
//   - provenance is always `data_source: "fixture"`.
// Obsolete v1 execution grants (hub follow-up): a Gate-1 request of a legacy (v1) proposal is never
// challenged or decided — the attempt invalidates it (`evidence_unavailable`, the hub's fixed detail),
// cancels its reservation and returns the task to draft, then answers 409 `stale_binding` with the
// hub's one issue; an approved legacy execution is refused before every engine step
// (`approval_void`). `runLegacyBeforePolicy` replays the pre-policy history (approve + execute) so
// legacy results stay renderable.
import {
	type AcceptanceValidityReason,
	type AcceptanceValidityStatus,
	type AcceptanceValidityView,
	type AnyProposalSnapshot,
	type AnyResultEnvelope,
	APPROVAL_CONTRACT,
	type ApprovalRequestView,
	type ApprovalStatus,
	type ArtifactListItem,
	type ArtifactTextResponse,
	approvalStatusFor,
	buildProposalSnapshot,
	CANCELLABLE_STAGES,
	CancelRequest,
	CHALLENGE_TTL_MS,
	ChallengeIssueRequest,
	type ChallengeIssueResponse,
	CreateWorkspaceTaskRequest,
	canTransitionWorkspace,
	composeProposalSnapshotV1_2,
	confirmationMatches,
	DECISION_CONTRACT,
	DECISION_STAGE,
	type DecisionReceiptBody,
	DecisionRequest,
	type DecisionResponse,
	type DecisionView,
	DIFF_ARTIFACT_NAME,
	decisionPayloadFrom,
	deriveCriterionCoverage,
	deriveWorkspacePhase,
	type EngineView,
	type EnvelopeArtifact,
	type EnvelopeCheck,
	type EvidenceStatus,
	EXECUTION_BINDING_CONTRACT,
	type ExecutionBinding,
	type ExecutionQueue,
	type InvalidationReason,
	isDraftEditable,
	isProposalV1_2,
	MANIFEST_ARTIFACT_NAME,
	type ManagedProposalRow,
	type ObservedRepo,
	OPERATOR_ID,
	type OperatorScope,
	overallEvidenceStatus,
	PROPOSAL_CONTRACT,
	PROPOSAL_CONTRACT_V1_2,
	ProposalDraft,
	PUBLISHABLE_STAGES,
	PublishProposalRequest,
	type QueueEntry,
	RERUNNABLE_STAGES,
	RESULT_CONTRACT,
	RESULT_CONTRACT_V1_2,
	REVIEW_OUTPUT_ARTIFACT_NAME,
	RequestRerunRequest,
	type ResultEnvelope,
	type RunSummary,
	requestsNonSimulatedMode,
	resultEligibilityV1_2,
	SaveDraftRequest,
	type SessionView,
	SignInRequest,
	stageAfterDecision,
	stageAfterSealing,
	verificationLogName,
	WORKSPACE_ERROR_STATUS,
	WORKSPACE_TASK_CONTRACT,
	type WorkspaceErrorCode,
	type WorkspaceRepo,
	type WorkspaceSnapshot,
	type WorkspaceStage,
	type WorkspaceTaskDetail,
	type WorkspaceTaskSummary,
	type WorkspaceTaskView,
	type WorkspaceTrigger,
} from "@agent-city/schema/workspace-m1";
import { OBSOLETE_V1_GRANT_DETAIL } from "./labels.ts";
import type { TransportResult } from "./transport.ts";

/** The hub's stage detail after it retires an obsolete grant (decision path and sweep alike). */
const OBSOLETE_STAGE_DETAIL = `Gate 1 was invalidated: ${OBSOLETE_V1_GRANT_DETAIL}`;
const OBSOLETE_ENGINE_DETAIL = `not authorized: ${OBSOLETE_V1_GRANT_DETAIL}; nothing more was executed`;

type TaskState = EngineView["state"];
type FailureKind = NonNullable<EngineView["failure_kind"]>;
type ArtifactKind = ArtifactListItem["kind"];
type Scenario = WorkspaceTaskSummary["draft"]["simulation_scenario"];

/** The primary allowlisted fixture repository (SOL §H: `local/fixture`). */
export const FIXTURE_REPO: WorkspaceRepo = {
	repo_id: "local/fixture",
	base_ref: "main",
	required_checks: ["unit", "lint"],
};

/**
 * A second allowlisted fixture repository (multi-repository milestone), left empty by default so the
 * UI's empty-repository states are visible. Its id never matches `local/fixture` as a substring.
 */
export const FIXTURE_REPO_EMPTY: WorkspaceRepo = {
	repo_id: "local/empty-sandbox",
	base_ref: "main",
	required_checks: ["unit"],
};

/** An observed-only repository (telemetry): shown read-only, never assignable or executable. */
export const FIXTURE_OBSERVED: ObservedRepo = {
	repo_id: "observed-example/telemetry-only",
	source: "telemetry",
};

/** What the evidence of the next sealed result looks like (fixture control). */
export type FixtureEvidence =
	| "verified"
	| "truncated_log"
	| "missing"
	| "corrupt"
	| "withheld"
	/** v1.2: the first verification log is absent → its criteria are `unresolved`. */
	| "log_missing"
	/**
	 * v1.2, FIXTURE-ONLY: the last check is sealed as failed → its criteria are `unsatisfied`. The
	 * real engine fails an attempt with a failing check before sealing; this models how the UI must
	 * render such coverage if a hub ever reports it.
	 */
	| "check_failed";

/** Injected outcome of the next decision POST (fixture control; tests the unknown-outcome path). */
export type DecisionFault =
	| "network_before_commit"
	| "lose_response_after_commit"
	| "server_error_after_commit";

interface FxChallenge {
	token: string;
	rev: number;
	expires_at: string;
	generation: number;
	state: "issued" | "consumed";
}

interface FxRequest {
	view: ApprovalRequestView;
	challenge: FxChallenge | null;
}

interface FxArtifact {
	item: ArtifactListItem;
	status: EvidenceStatus;
	text: string | null;
	sha256: string;
	withheld_reasons: string[];
}

interface FxRun {
	summary: RunSummary;
	artifacts: FxArtifact[];
	checks: EnvelopeCheck[];
}

/** A proposal row: v1 (legacy) or v1.2 snapshot (CONTRACT_V1_2.md §A). */
type FxProposalRow = ManagedProposalRow;

interface FxExecution {
	managed_task_id: string;
	workspace_task_id: string;
	proposal: FxProposalRow;
	binding: ExecutionBinding;
	binding_hash: string;
	scenario: Scenario;
	max_repairs: 0 | 1;
	state: TaskState;
	failure_kind: FailureKind | null;
	state_detail: string | null;
	cancel_requested_at: string | null;
	/** When an approved Gate 1 queued it (the engine's claim order key). */
	run_requested_at: string | null;
	quarantined: boolean;
	rev: number;
	runs: FxRun[];
	result_run_id: string | null;
	run_decision_id: string | null;
}

interface FxTask {
	summary: WorkspaceTaskSummary;
	proposals: FxProposalRow[];
	requests: FxRequest[];
	decisions: DecisionView[];
}

interface FxReceipt {
	payload: string;
	status: number;
	body: DecisionReceiptBody;
}

export interface FixtureWorldOptions {
	/** Clock (ms). Default Date.now. */
	now?: () => number;
	/** Start with an operator session (default true: the fixture has no real credential). */
	signedIn?: boolean;
}

type R<T> = TransportResult<T>;

const ok = <T>(data: T, status = 200): R<T> => ({
	ok: true,
	status,
	data: structuredClone(data),
});

export const fixtureError = (
	code: WorkspaceErrorCode,
	message: string,
	issues?: { path: string; message: string }[],
): R<never> => ({
	ok: false,
	kind: "http",
	status: WORKSPACE_ERROR_STATUS[code],
	error: issues ? { error: code, message, issues } : { error: code, message },
});

const zodIssues = (e: { issues: { path: PropertyKey[]; message: string }[] }) =>
	e.issues.slice(0, 20).map((i) => ({
		path: i.path.map(String).join("."),
		message: i.message,
	}));

const ACTIVE: readonly TaskState[] = [
	"executing",
	"verifying",
	"reviewing",
	"repairing",
];

/** Visibly synthetic hex: a fixed tag followed by a zero-padded counter. Never a digest. */
const synthHex = (tag: string, n: number, len: number): string =>
	tag + n.toString(16).padStart(len - tag.length, "0");

const uuidish = (n: number): string =>
	`00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const byteLen = (s: string): number => new TextEncoder().encode(s).length;

const stableJson = (v: unknown): string =>
	JSON.stringify(v, (_k, val: unknown) =>
		val && typeof val === "object" && !Array.isArray(val)
			? Object.fromEntries(
					Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
						a < b ? -1 : a > b ? 1 : 0,
					),
				)
			: val,
	);

export class FixtureWorld {
	readonly now: () => number;
	private n = 0;
	private generation = 0;
	private session: (SessionView & { generation: number }) | null = null;
	private scopes: OperatorScope[] = ["workspace:read", "workspace:decide"];
	readonly repos: WorkspaceRepo[] = [
		structuredClone(FIXTURE_REPO),
		structuredClone(FIXTURE_REPO_EMPTY),
	];
	readonly observedRepos: ObservedRepo[] = [structuredClone(FIXTURE_OBSERVED)];
	/** Visibly synthetic base commit per repository (distinct across repositories). */
	private baseShaOf(repoId: string): string {
		const i = this.repos.findIndex((r) => r.repo_id === repoId);
		return synthHex("ba5e", i + 1, 40);
	}
	private readonly policyHash = synthHex("90", 1, 64);
	private readonly tasks = new Map<string, FxTask>();
	private readonly order: string[] = [];
	private readonly executions = new Map<string, FxExecution>();
	private readonly receipts = new Map<string, FxReceipt>();
	private readonly createKeys = new Map<
		string,
		{ body: string; taskId: string }
	>();
	private rejectSignIn = false;
	private decisionFault: DecisionFault | null = null;
	private readonly corrupted = new Set<string>();
	/**
	 * v1.2 §C: current validity of each task's accepted result (the fixture's stand-in for
	 * `managed_acceptance_validity`). `invalid` / `unverifiable` are sticky here exactly as on the hub.
	 */
	private readonly validity = new Map<string, AcceptanceValidityView>();
	/** Tasks whose validity check "cannot run" (control): re-checks answer `unknown`. */
	private readonly verificationDown = new Set<string>();
	/**
	 * v1.2 criterion ids. The real hub uses sha256 (Bun-only); the fixture assigns visibly synthetic
	 * ids (`crit-cc…NN`) per exact frozen text, so the same text keeps its id across versions and an
	 * edited text gets a new one — the property the UI relies on — without computing a digest.
	 */
	private readonly critIds = new Map<string, string>();
	/** Control: publish legacy v1 proposals (models rows from before the v1.2 delta). */
	private legacyContract = false;
	/** Only inside `runLegacyBeforePolicy`: the pre-policy engine (no obsolete-grant refusal). */
	private prePolicy = false;

	constructor(opts: FixtureWorldOptions = {}) {
		this.now = opts.now ?? (() => Date.now());
		if (opts.signedIn ?? true) this.openSession();
	}

	// ── helpers ─────────────────────────────────────────────────────────────

	private next(): number {
		this.n += 1;
		return this.n;
	}
	private id(prefix: string): string {
		return `${prefix}-${uuidish(this.next())}`;
	}
	private hash(tag: string): string {
		return synthHex(tag, this.next(), 64);
	}
	private sha(tag: string): string {
		return synthHex(tag, this.next(), 40);
	}
	private token(tag: string): string {
		return `${tag}${this.next().toString(36)}`.padEnd(43, "x");
	}
	private ts(offsetMs = 0): string {
		return new Date(this.now() + offsetMs).toISOString();
	}

	private openSession(): SessionView {
		this.generation += 1;
		this.session = {
			operator_id: OPERATOR_ID,
			scopes: [...this.scopes],
			csrf_token: this.token("fxcsrf"),
			expires_at: this.ts(12 * 3600_000),
			generation: this.generation,
		};
		return this.publicSession();
	}

	private publicSession(): SessionView {
		const s = this.session as SessionView & { generation: number };
		return {
			operator_id: s.operator_id,
			scopes: [...s.scopes],
			csrf_token: s.csrf_token,
			expires_at: s.expires_at,
		};
	}

	/** null = allowed; otherwise the 401/403 answer. */
	private guard(scope: OperatorScope): R<never> | null {
		if (this.session && Date.parse(this.session.expires_at) <= this.now())
			this.session = null;
		if (!this.session)
			return fixtureError("unauthenticated", "Sign in to continue.");
		if (!this.session.scopes.includes(scope))
			return fixtureError(
				"forbidden_scope",
				"This session may read but not decide.",
			);
		return null;
	}

	private task(id: string): FxTask | undefined {
		return this.tasks.get(id);
	}

	private exec(t: FxTask): FxExecution | null {
		const id = t.summary.current_managed_task_id;
		return id ? (this.executions.get(id) ?? null) : null;
	}

	/** Every stage write goes through the frozen transition table (a bug here throws). */
	private moveStage(
		t: FxTask,
		to: WorkspaceStage,
		trigger: WorkspaceTrigger,
		actor: "operator" | "engine" | "reconciler",
		detail: string | null = null,
	): void {
		const from = t.summary.stage;
		if (!canTransitionWorkspace(from, to, trigger, actor))
			throw new Error(
				`fixture: illegal stage change ${from} → ${to} (${trigger})`,
			);
		t.summary.stage = to;
		t.summary.stage_detail = detail;
		this.touch(t);
	}

	private touch(t: FxTask): void {
		t.summary.rev += 1;
		t.summary.updated_at = this.ts();
	}

	private touchExec(e: FxExecution, state?: TaskState): void {
		if (state) e.state = state;
		e.rev += 1;
	}

	private closeRequest(
		r: FxRequest,
		status: ApprovalStatus,
		reason: InvalidationReason | null = null,
		detail: string | null = null,
	): void {
		r.view.status = status;
		r.view.invalidation_reason = reason;
		r.view.invalidation_detail = detail;
		r.view.closed_at = this.ts();
		r.view.updated_at = this.ts();
		r.view.rev += 1;
		r.challenge = null;
	}

	private pending(t: FxTask, kind: "run" | "result"): FxRequest | undefined {
		return t.requests.find(
			(r) => r.view.kind === kind && r.view.status === "pending",
		);
	}

	private findRequest(id: string): { t: FxTask; r: FxRequest } | null {
		for (const t of this.tasks.values()) {
			const r = t.requests.find((x) => x.view.id === id);
			if (r) return { t, r };
		}
		return null;
	}

	/** The request is a Gate-1 request of a legacy (v1) proposal. */
	private obsoleteGrant(t: FxTask, r: FxRequest): boolean {
		if (r.view.kind !== "run") return false;
		const p = t.proposals.find((x) => x.id === r.view.proposal_id);
		return p !== undefined && !isProposalV1_2(p.snapshot);
	}

	/**
	 * Retire a pending obsolete grant exactly like the hub: request invalidated, reservation
	 * cancelled, task → draft (`run_request_invalidated`). No-op unless it is the current Gate 1.
	 */
	private retireObsoleteGrant(t: FxTask, r: FxRequest): void {
		if (r.view.status !== "pending") return;
		if (
			t.summary.stage !== "awaiting_run_approval" ||
			t.summary.current_managed_task_id !== r.view.managed_task_id
		)
			return;
		const e = this.executions.get(r.view.managed_task_id);
		if (e && e.state !== "draft" && e.state !== "cancelled") return;
		this.closeRequest(
			r,
			"invalidated",
			"evidence_unavailable",
			OBSOLETE_V1_GRANT_DETAIL,
		);
		if (e?.state === "draft") this.touchExec(e, "cancelled");
		this.moveStage(
			t,
			"draft",
			"run_request_invalidated",
			"reconciler",
			OBSOLETE_STAGE_DETAIL,
		);
	}

	/** The hub's refusal of an obsolete grant (same code and issue as decision-service.ts). */
	private obsoleteRefusal(): R<never> {
		return fixtureError(
			"stale_binding",
			"The subject changed since it was loaded; reload and review it again.",
			[{ path: "proposal_id", message: OBSOLETE_V1_GRANT_DETAIL }],
		);
	}

	/** Pending → retire + refuse; already retired → the same refusal; anything else → null. */
	private refuseObsolete(t: FxTask, r: FxRequest): R<never> | null {
		if (this.prePolicy || !this.obsoleteGrant(t, r)) return null;
		if (r.view.status === "pending") {
			this.retireObsoleteGrant(t, r);
			return this.obsoleteRefusal();
		}
		if (
			r.view.status === "invalidated" &&
			r.view.invalidation_detail === OBSOLETE_V1_GRANT_DETAIL
		)
			return this.obsoleteRefusal();
		return null;
	}

	/** Synthetic, text-stable criterion id (see `critIds`). */
	private critId(frozenText: string): string {
		const known = this.critIds.get(frozenText);
		if (known) return known;
		const id = `crit-${synthHex("cc", this.critIds.size + 1, 16)}`;
		this.critIds.set(frozenText, id);
		return id;
	}

	// ── views ───────────────────────────────────────────────────────────────

	private engineView(e: FxExecution | null): EngineView | null {
		if (!e) return null;
		const current = e.runs.at(-1) ?? null;
		return {
			managed_task_id: e.managed_task_id,
			state: e.state,
			failure_kind: e.failure_kind,
			state_detail: e.state_detail,
			cancel_requested_at: e.cancel_requested_at,
			current_run_id: current?.summary.run_id ?? null,
			result_run_id: e.result_run_id,
			attempt_no: current?.summary.attempt_no ?? null,
			quarantined: e.quarantined,
			rev: e.rev,
		};
	}

	private taskView(t: FxTask): WorkspaceTaskView {
		const e = this.exec(t);
		return {
			task: t.summary,
			phase: deriveWorkspacePhase(t.summary.stage, e?.state ?? null),
			engine: this.engineView(e),
			current_proposal:
				t.proposals.find((p) => p.id === t.summary.current_proposal_id) ?? null,
			approval_requests: [...t.requests].reverse().map((r) => r.view),
			decisions: [...t.decisions].reverse(),
			acceptance_validity: this.validity.get(t.summary.id) ?? null,
		};
	}

	/** The accepted result request of a task, if any. */
	private acceptedRequest(t: FxTask): FxRequest | undefined {
		return t.requests.find(
			(r) => r.view.kind === "result" && r.view.status === "accepted",
		);
	}

	/**
	 * The hub's detail-read re-check (§C detection timing), simplified: every task-detail read of an
	 * accepted task re-checks. A changed source artifact → `invalid(source_evidence_changed)`,
	 * sticky; a check that cannot run → `unknown(verification_unavailable)`; else `valid` with a
	 * fresh `checked_at`. Snapshots show the stored row (no re-check), like the hub.
	 */
	private recheckValidity(t: FxTask): void {
		const v = this.validity.get(t.summary.id);
		if (!v || v.status === "invalid" || v.status === "unverifiable") return;
		const at = this.ts();
		if (this.verificationDown.has(t.summary.id)) {
			this.validity.set(t.summary.id, {
				...v,
				status: "unknown",
				reason: "verification_unavailable",
				detail: "The evidence check could not run.",
				checked_at: at,
			});
			return;
		}
		const req = this.acceptedRequest(t);
		const e = req ? this.executions.get(req.view.managed_task_id) : undefined;
		const run = e?.runs.find((x) => x.summary.run_id === req?.view.run_id);
		const changed = run?.artifacts.find((a) =>
			this.corrupted.has(a.item.artifact_id),
		);
		this.validity.set(
			t.summary.id,
			changed
				? {
						...v,
						status: "invalid",
						reason: "source_evidence_changed",
						detail: `Stored evidence ${changed.item.name} changed after acceptance.`,
						checked_at: at,
						first_invalid_at: at,
					}
				: {
						...v,
						status: "valid",
						reason: null,
						detail: null,
						checked_at: at,
						first_invalid_at: null,
					},
		);
	}

	private taskDetail(t: FxTask): WorkspaceTaskDetail {
		const runs: RunSummary[] = [];
		const artifacts: ArtifactListItem[] = [];
		for (const e of this.executions.values()) {
			if (e.workspace_task_id !== t.summary.id) continue;
			for (const run of e.runs) {
				runs.push(run.summary);
				for (const a of run.artifacts) artifacts.push(a.item);
			}
		}
		return { ...this.taskView(t), runs, artifacts };
	}

	// ── session routes ──────────────────────────────────────────────────────

	getSession(): R<SessionView> {
		const denied = this.guard("workspace:read");
		return denied ?? ok(this.publicSession());
	}

	signIn(body: unknown): R<SessionView> {
		const p = SignInRequest.safeParse(body);
		if (!p.success)
			return fixtureError("invalid_request", "Invalid sign-in request.");
		if (this.rejectSignIn) {
			this.rejectSignIn = false;
			return fixtureError("unauthenticated", "Sign-in failed.");
		}
		return ok(this.openSession());
	}

	signOut(): R<null> {
		const denied = this.guard("workspace:read");
		if (denied) return denied;
		this.session = null;
		return { ok: true, status: 204, data: null };
	}

	// ── reads ───────────────────────────────────────────────────────────────

	getSnapshot(): R<WorkspaceSnapshot> {
		const denied = this.guard("workspace:read");
		if (denied) return denied;
		const tasks = [...this.order].reverse().map((id) => {
			const t = this.tasks.get(id) as FxTask;
			const e = this.exec(t);
			const latest = t.requests.at(-1)?.view ?? null;
			return {
				task: t.summary,
				phase: deriveWorkspacePhase(t.summary.stage, e?.state ?? null),
				acceptance_validity: this.validity.get(t.summary.id) ?? null,
				engine: this.engineView(e),
				latest_request: latest
					? {
							id: latest.id,
							kind: latest.kind,
							status: latest.status,
							invalidation_reason: latest.invalidation_reason,
							created_at: latest.created_at,
							closed_at: latest.closed_at,
						}
					: null,
			};
		});
		const pending = [...this.tasks.values()]
			.flatMap((t) => t.requests)
			.filter((r) => r.view.status === "pending")
			.map((r) => r.view)
			.sort((a, b) =>
				a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
			);
		return ok({
			provenance: {
				data_source: "fixture",
				execution_mode: "simulated",
				live_integration_verified: false,
			},
			repos: this.repos,
			observed_repos: this.observedRepos,
			tasks,
			// the fixture lists every task, so its window and its complete totals always agree
			repo_task_counts: this.repos.map((r) => ({
				repo_id: r.repo_id,
				tasks: [...this.tasks.values()].filter(
					(t) => t.summary.repo_id === r.repo_id,
				).length,
			})),
			pending_requests: pending,
			execution_queue: this.executionQueue(),
			generated_at: this.ts(),
		});
	}

	/**
	 * The hub's global queue (claimOrder) as the fixture can model it: the fixture steps executions by
	 * hand, so more than one may be active at once — the earliest-requested active one holds the slot
	 * and the others are listed first in the waiting line (resumable before queued, like the engine).
	 */
	private executionQueue(): ExecutionQueue {
		const byRequest = (a: FxExecution, b: FxExecution) =>
			(a.run_requested_at ?? "") < (b.run_requested_at ?? "")
				? -1
				: (a.run_requested_at ?? "") > (b.run_requested_at ?? "")
					? 1
					: 0;
		const all = [...this.executions.values()];
		const active = all.filter((e) => ACTIVE.includes(e.state)).sort(byRequest);
		const queued = all.filter((e) => e.state === "queued").sort(byRequest);
		const entry = (e: FxExecution): QueueEntry => ({
			managed_task_id: e.managed_task_id,
			workspace_task_id: e.workspace_task_id,
			repo_id:
				this.tasks.get(e.workspace_task_id)?.summary.repo_id ??
				FIXTURE_REPO.repo_id,
			state: e.state,
			run_requested_at: e.run_requested_at,
		});
		// like the hub: only an ACTIVE execution holds the slot; a merely queued one never does
		const head = active.shift() ?? null;
		const waiting = [...active, ...queued];
		return {
			active: head ? entry(head) : null,
			queued: waiting.map(entry),
			claims_paused_by_quarantine: all.some((e) => e.quarantined),
		};
	}

	getTask(id: string): R<WorkspaceTaskDetail> {
		const denied = this.guard("workspace:read");
		if (denied) return denied;
		const t = this.task(id);
		if (!t) return fixtureError("not_found", "No such task.");
		this.recheckValidity(t);
		return ok(this.taskDetail(t));
	}

	getArtifact(taskId: string, artifactId: string): R<ArtifactTextResponse> {
		const denied = this.guard("workspace:read");
		if (denied) return denied;
		const t = this.task(taskId);
		if (!t) return fixtureError("not_found", "No such task.");
		for (const e of this.executions.values()) {
			if (e.workspace_task_id !== taskId) continue;
			for (const run of e.runs)
				for (const a of run.artifacts)
					if (a.item.artifact_id === artifactId) {
						const status = this.servedStatus(t, a);
						const disclose = status === "verified" || status === "truncated";
						return ok({
							artifact_id: a.item.artifact_id,
							run_id: a.item.run_id,
							name: a.item.name,
							kind: a.item.kind,
							status,
							text: disclose ? a.text : null,
							truncated: a.item.truncated,
							withheld_reasons: status === "withheld" ? a.withheld_reasons : [],
						});
					}
		}
		return fixtureError("not_found", "No such artifact.");
	}

	/**
	 * Status the artifact route answers with. An accepted result is served from its sealed copy
	 * (v1.2 §B "Serving": the envelope item status; a later change to the mutable file never
	 * substitutes content) unless that copy itself fails (bundle_* reasons → corrupt / unknown).
	 * Anything else reads the mutable store (a corrupted file reads `corrupt`).
	 */
	private servedStatus(t: FxTask, a: FxArtifact): EvidenceStatus {
		const accepted = this.acceptedRequest(t);
		if (accepted && accepted.view.run_id === a.item.run_id) {
			const reason = this.validity.get(t.summary.id)?.reason ?? null;
			if (reason === "bundle_missing") return "unknown";
			if (reason === "bundle_corrupt" || reason === "bundle_binding_mismatch")
				return "corrupt";
			return a.status;
		}
		return this.corrupted.has(a.item.artifact_id) ? "corrupt" : a.status;
	}

	// ── task commands ───────────────────────────────────────────────────────

	createTask(body: unknown): R<WorkspaceTaskView> {
		const denied = this.guard("workspace:decide");
		if (denied) return denied;
		if (requestsNonSimulatedMode(body))
			return fixtureError("live_disabled", "Live execution is disabled in M1.");
		const p = CreateWorkspaceTaskRequest.safeParse(body);
		if (!p.success)
			return fixtureError(
				"invalid_request",
				"Invalid task.",
				zodIssues(p.error),
			);
		const { idempotency_key, repo_id, draft } = p.data;
		const prior = this.createKeys.get(idempotency_key);
		const bodyJson = stableJson({ repo_id, draft });
		if (prior) {
			if (prior.body !== bodyJson)
				return fixtureError(
					"idempotency_conflict",
					"This key was used for a different task.",
				);
			return ok(this.taskView(this.tasks.get(prior.taskId) as FxTask), 200);
		}
		if (!this.repos.some((r) => r.repo_id === repo_id))
			return fixtureError(
				"repo_not_allowed",
				"This repository is not on the allowlist.",
			);
		const id = this.id("wst");
		const at = this.ts();
		const t: FxTask = {
			summary: {
				id,
				contract_version: WORKSPACE_TASK_CONTRACT,
				repo_id,
				created_by: OPERATOR_ID,
				draft,
				stage: "draft",
				stage_detail: null,
				current_proposal_id: null,
				current_managed_task_id: null,
				accepted_decision_id: null,
				cancel_requested_at: null,
				created_at: at,
				updated_at: at,
				rev: 1,
			},
			proposals: [],
			requests: [],
			decisions: [],
		};
		this.tasks.set(id, t);
		this.order.push(id);
		this.createKeys.set(idempotency_key, { body: bodyJson, taskId: id });
		return ok(this.taskView(t), 201);
	}

	saveDraft(taskId: string, body: unknown): R<WorkspaceTaskView> {
		const denied = this.guard("workspace:decide");
		if (denied) return denied;
		if (requestsNonSimulatedMode(body))
			return fixtureError("live_disabled", "Live execution is disabled in M1.");
		const p = SaveDraftRequest.safeParse(body);
		if (!p.success)
			return fixtureError(
				"invalid_request",
				"Invalid draft.",
				zodIssues(p.error),
			);
		const t = this.task(taskId);
		if (!t) return fixtureError("not_found", "No such task.");
		if (!isDraftEditable(t.summary.stage))
			return fixtureError("invalid_state", "This task is closed.");
		if (p.data.expected_rev !== t.summary.rev)
			return fixtureError(
				"stale_binding",
				"The task changed since it was loaded.",
			);
		t.summary.draft = p.data.draft;
		this.touch(t);
		return ok(this.taskView(t));
	}

	publishProposal(taskId: string, body: unknown): R<WorkspaceTaskView> {
		const denied = this.guard("workspace:decide");
		if (denied) return denied;
		const p = PublishProposalRequest.safeParse(body);
		if (!p.success) return fixtureError("invalid_request", "Invalid request.");
		const t = this.task(taskId);
		if (!t) return fixtureError("not_found", "No such task.");
		if (!PUBLISHABLE_STAGES.includes(t.summary.stage))
			return fixtureError(
				"invalid_state",
				"A proposal cannot be submitted in this stage.",
			);
		if (p.data.expected_rev !== t.summary.rev)
			return fixtureError(
				"stale_binding",
				"The task changed since it was loaded.",
			);
		const draft = ProposalDraft.safeParse(t.summary.draft);
		if (!draft.success)
			return fixtureError(
				"invalid_request",
				"The draft is incomplete.",
				zodIssues(draft.error),
			);
		const repo = this.repos.find((r) => r.repo_id === t.summary.repo_id);
		if (!repo)
			return fixtureError(
				"repo_not_allowed",
				"This repository is not on the allowlist.",
			);
		const proposalId = this.id("wsp");
		const input = {
			proposal_id: proposalId,
			workspace_task_id: t.summary.id,
			version: t.proposals.length + 1,
			predecessor_proposal_id: t.summary.current_proposal_id,
			repo_id: repo.repo_id,
			base_ref: repo.base_ref,
			base_sha: this.baseShaOf(repo.repo_id),
			required_checks: repo.required_checks,
			draft: draft.data,
		};
		// v1.2 (like the hub): fail closed without a complete criterion → check mapping
		const built: {
			ok: boolean;
			snapshot?: AnyProposalSnapshot;
			issues?: { path: string; message: string }[];
		} = this.legacyContract
			? buildProposalSnapshot(input)
			: composeProposalSnapshotV1_2(input, (text) => this.critId(text));
		if (!built.ok || !built.snapshot)
			return fixtureError(
				"invalid_request",
				"The proposal could not be frozen.",
				built.issues,
			);
		const superseded = this.pending(t, "run");
		if (superseded) {
			this.closeRequest(superseded, "invalidated", "proposal_superseded");
			const old = this.executions.get(superseded.view.managed_task_id);
			if (old) this.touchExec(old, "cancelled");
		}
		const proposal: FxProposalRow = {
			id: proposalId,
			workspace_task_id: t.summary.id,
			version: built.snapshot.version,
			predecessor_proposal_id: built.snapshot.predecessor_proposal_id,
			contract_version: isProposalV1_2(built.snapshot)
				? PROPOSAL_CONTRACT_V1_2
				: PROPOSAL_CONTRACT,
			snapshot: built.snapshot,
			proposal_hash: this.hash("a1"),
			created_by: OPERATOR_ID,
			created_at: this.ts(),
		};
		t.proposals.push(proposal);
		t.summary.current_proposal_id = proposal.id;
		this.openGate1(t, proposal, "publish_proposal");
		return ok(this.taskView(t));
	}

	/** Reserve a managed task (state draft) and insert the pending Gate-1 request. */
	private openGate1(
		t: FxTask,
		proposal: FxProposalRow,
		trigger: "publish_proposal" | "request_rerun",
	): void {
		const managed_task_id = this.id("task");
		const binding: ExecutionBinding = {
			contract: EXECUTION_BINDING_CONTRACT,
			proposal_id: proposal.id,
			proposal_hash: proposal.proposal_hash,
			managed_task_id,
			base_sha: proposal.snapshot.base_sha,
			policy_hash: this.policyHash,
		};
		const e: FxExecution = {
			managed_task_id,
			workspace_task_id: t.summary.id,
			proposal,
			binding,
			binding_hash: this.hash("b1"),
			scenario: proposal.snapshot.simulation_scenario,
			max_repairs: proposal.snapshot.repair_policy.max_repairs,
			state: "draft",
			failure_kind: null,
			state_detail: null,
			cancel_requested_at: null,
			run_requested_at: null,
			quarantined: false,
			rev: 1,
			runs: [],
			result_run_id: null,
			run_decision_id: null,
		};
		this.executions.set(managed_task_id, e);
		const requestId = this.id("wsa");
		const at = this.ts();
		t.requests.push({
			view: {
				id: requestId,
				workspace_task_id: t.summary.id,
				kind: "run",
				proposal_id: proposal.id,
				proposal_hash: proposal.proposal_hash,
				managed_task_id,
				execution_binding: binding,
				execution_binding_hash: e.binding_hash,
				run_id: null,
				result_envelope: null,
				result_envelope_hash: null,
				binding: {
					contract: APPROVAL_CONTRACT,
					kind: "run",
					approval_request_id: requestId,
					workspace_task_id: t.summary.id,
					proposal_id: proposal.id,
					proposal_hash: proposal.proposal_hash,
					execution_binding_hash: e.binding_hash,
				},
				binding_hash: this.hash("b2"),
				status: "pending",
				invalidation_reason: null,
				invalidation_detail: null,
				created_at: at,
				updated_at: at,
				closed_at: null,
				rev: 1,
			},
			challenge: null,
		});
		t.summary.current_managed_task_id = managed_task_id;
		this.moveStage(t, "awaiting_run_approval", trigger, "operator");
	}

	requestRerun(taskId: string, body: unknown): R<WorkspaceTaskView> {
		const denied = this.guard("workspace:decide");
		if (denied) return denied;
		const p = RequestRerunRequest.safeParse(body);
		if (!p.success) return fixtureError("invalid_request", "Invalid request.");
		const t = this.task(taskId);
		if (!t) return fixtureError("not_found", "No such task.");
		if (
			!RERUNNABLE_STAGES.includes(t.summary.stage) ||
			t.summary.current_proposal_id === null
		)
			return fixtureError(
				"invalid_state",
				"A new run cannot be requested now.",
			);
		if (p.data.expected_rev !== t.summary.rev)
			return fixtureError(
				"stale_binding",
				"The task changed since it was loaded.",
			);
		if (p.data.proposal_id !== t.summary.current_proposal_id)
			return fixtureError("stale_binding", "That proposal is not current.");
		if (this.exec(t)?.quarantined)
			return fixtureError(
				"invalid_state",
				"A process of the last execution is not proven terminated.",
			);
		const proposal = t.proposals.find(
			(x) => x.id === t.summary.current_proposal_id,
		) as FxProposalRow;
		this.openGate1(t, proposal, "request_rerun");
		return ok(this.taskView(t));
	}

	cancel(taskId: string, body: unknown): R<WorkspaceTaskView> {
		const denied = this.guard("workspace:decide");
		if (denied) return denied;
		const p = CancelRequest.safeParse(body);
		if (!p.success) return fixtureError("invalid_request", "Invalid request.");
		const t = this.task(taskId);
		if (!t) return fixtureError("not_found", "No such task.");
		if (p.data.expected_rev !== t.summary.rev)
			return fixtureError(
				"stale_binding",
				"The task changed since it was loaded.",
			);
		const stage = t.summary.stage;
		if (!CANCELLABLE_STAGES.includes(stage))
			return fixtureError(
				"invalid_state",
				"There is no running work to cancel.",
			);
		const e = this.exec(t);
		if (stage === "awaiting_run_approval") {
			const r = this.pending(t, "run");
			if (r) this.closeRequest(r, "invalidated", "withdrawn");
			if (e) this.touchExec(e, "cancelled");
			t.summary.cancel_requested_at = this.ts();
			this.moveStage(t, "cancelled", "cancel", "operator");
		} else if (stage === "queued") {
			if (e) {
				e.failure_kind = "cancelled";
				e.cancel_requested_at = this.ts();
				this.touchExec(e, "cancelled");
			}
			t.summary.cancel_requested_at = this.ts();
			this.moveStage(t, "cancelled", "cancel", "operator");
		} else if (stage === "running") {
			if (e) {
				e.cancel_requested_at = this.ts();
				this.touchExec(e);
			}
			t.summary.cancel_requested_at = this.ts();
			this.moveStage(t, "cancel_requested", "cancel", "operator");
		}
		// cancel_requested: the intent is already recorded; nothing changes.
		return ok(this.taskView(t));
	}

	// ── approvals ───────────────────────────────────────────────────────────

	issueChallenge(requestId: string, body: unknown): R<ChallengeIssueResponse> {
		const denied = this.guard("workspace:decide");
		if (denied) return denied;
		const p = ChallengeIssueRequest.safeParse(body);
		if (!p.success) return fixtureError("invalid_request", "Invalid request.");
		const found = this.findRequest(requestId);
		if (!found) return fixtureError("not_found", "No such approval request.");
		const { t, r } = found;
		const obsolete = this.refuseObsolete(t, r);
		if (obsolete) return obsolete;
		if (
			r.view.status !== "pending" ||
			t.summary.stage !== DECISION_STAGE[r.view.kind]
		)
			return fixtureError(
				"invalid_state",
				"This request is no longer pending.",
			);
		if (
			p.data.kind !== r.view.kind ||
			p.data.binding_hash !== r.view.binding_hash ||
			p.data.expected_request_rev !== r.view.rev
		)
			return fixtureError(
				"stale_binding",
				"The request changed since it was loaded.",
			);
		const session = this.session as SessionView & { generation: number };
		r.view.rev += 1;
		r.view.updated_at = this.ts();
		r.challenge = {
			token: this.token("fxch"),
			rev: r.view.rev,
			expires_at: this.ts(CHALLENGE_TTL_MS),
			generation: session.generation,
			state: "issued",
		};
		return ok({
			approval_request_id: r.view.id,
			kind: r.view.kind,
			binding_hash: r.view.binding_hash,
			request_rev: r.view.rev,
			challenge: r.challenge.token,
			expires_at: r.challenge.expires_at,
		});
	}

	decide(requestId: string, serialized: string): R<DecisionResponse> {
		const denied = this.guard("workspace:decide");
		if (denied) return denied;
		let json: unknown;
		try {
			json = JSON.parse(serialized);
		} catch {
			return fixtureError("invalid_request", "Malformed JSON.");
		}
		if (requestsNonSimulatedMode(json))
			return fixtureError("live_disabled", "Live execution is disabled in M1.");
		const p = DecisionRequest.safeParse(json);
		if (!p.success)
			return fixtureError(
				"invalid_request",
				"Invalid decision.",
				zodIssues(p.error),
			);
		const body = p.data;
		let payload: string | null = null;
		try {
			payload = stableJson(decisionPayloadFrom(body, requestId));
		} catch {
			payload = null;
		}
		const receipt = this.receipts.get(body.idempotency_key);
		if (receipt) {
			if (payload !== null && receipt.payload === payload)
				return ok({ receipt: receipt.body, replayed: true }, receipt.status);
			return fixtureError(
				"idempotency_conflict",
				"This key was used for a different decision.",
			);
		}
		if (!confirmationMatches(body) || payload === null)
			return fixtureError("confirmation_mismatch", "Type exactly Edward.");
		const fault = this.decisionFault;
		this.decisionFault = null;
		if (fault === "network_before_commit")
			return {
				ok: false,
				kind: "network",
				message: "fixture: connection lost",
			};
		const found = this.findRequest(requestId);
		if (!found) return fixtureError("not_found", "No such approval request.");
		const { t, r } = found;
		// before any consumption, like the hub (after receipt replay + confirmation)
		const obsolete = this.refuseObsolete(t, r);
		if (obsolete) return obsolete;
		if (
			r.view.status !== "pending" ||
			t.summary.stage !== DECISION_STAGE[r.view.kind] ||
			body.kind !== r.view.kind
		)
			return fixtureError(
				"invalid_state",
				"This request is no longer pending.",
			);
		if (
			body.expected_request_rev !== r.view.rev ||
			body.binding_hash !== r.view.binding_hash
		)
			return fixtureError(
				"stale_binding",
				"The request changed since it was loaded.",
			);
		const c = r.challenge;
		const session = this.session as SessionView & { generation: number };
		if (
			c?.state !== "issued" ||
			c.token !== body.challenge ||
			c.rev !== r.view.rev ||
			c.generation !== session.generation ||
			Date.parse(c.expires_at) <= this.now()
		)
			return fixtureError(
				"challenge_invalid",
				"The approval challenge is not valid.",
			);
		const e = this.executions.get(r.view.managed_task_id) as FxExecution;
		if (r.view.kind === "result" && body.action === "accept") {
			const problem = this.revalidate(e);
			if (problem) {
				this.closeRequest(r, "invalidated", "integrity_failed", problem);
				this.moveStage(
					t,
					"execution_ended",
					"result_invalidated",
					"reconciler",
					problem,
				);
				return fixtureError("integrity_failed", problem);
			}
		}
		const response = this.applyDecision(t, r, e, body, payload);
		if (fault === "lose_response_after_commit")
			return { ok: false, kind: "network", message: "fixture: response lost" };
		if (fault === "server_error_after_commit")
			return {
				ok: false,
				kind: "invalid_response",
				status: 500,
				message: "fixture: server error after commit",
			};
		return ok(response, 201);
	}

	private applyDecision(
		t: FxTask,
		r: FxRequest,
		e: FxExecution,
		body: DecisionRequest,
		payload: string,
	): DecisionResponse {
		const decisionId = this.id("wsd");
		const at = this.ts();
		const payloadHash = this.hash("f1");
		const parsedPayload = JSON.parse(payload) as { reason: string | null };
		this.closeRequest(r, approvalStatusFor(body.action));
		const { to, trigger } = stageAfterDecision(r.view.kind, body.action);
		if (r.view.kind === "run") {
			if (body.action === "approve") {
				e.run_decision_id = decisionId;
				e.run_requested_at = at;
				this.touchExec(e, "queued");
			} else {
				e.failure_kind = "cancelled";
				this.touchExec(e, "cancelled");
			}
		} else if (body.action === "accept") {
			t.summary.accepted_decision_id = decisionId;
			// Gate-2 accept verified the sealed copy: the validity row starts `valid`
			this.validity.set(t.summary.id, {
				decision_id: decisionId,
				status: "valid",
				reason: null,
				detail: null,
				checked_at: at,
				first_invalid_at: null,
				evidence_bundle_digest: synthHex("b0", this.n, 64),
			});
		}
		this.moveStage(t, to, trigger, "operator");
		const decision: DecisionView = {
			id: decisionId,
			approval_request_id: r.view.id,
			kind: r.view.kind,
			action: body.action,
			operator_id: OPERATOR_ID,
			payload_hash: payloadHash,
			binding_hash: r.view.binding_hash,
			reason: parsedPayload.reason,
			result_envelope_hash: r.view.result_envelope_hash,
			decided_at: at,
		};
		t.decisions.push(decision);
		const receipt: DecisionReceiptBody = {
			contract: DECISION_CONTRACT,
			decision_id: decisionId,
			approval_request_id: r.view.id,
			workspace_task_id: t.summary.id,
			kind: r.view.kind,
			action: body.action,
			operator_id: OPERATOR_ID,
			decided_at: at,
			payload_hash: payloadHash,
			binding_hash: r.view.binding_hash,
			approval_request: { status: r.view.status, rev: r.view.rev },
			workspace_task: { stage: t.summary.stage, rev: t.summary.rev },
			effects: {
				managed_task_id: e.managed_task_id,
				managed_task_state: e.state,
				result_envelope_hash: r.view.result_envelope_hash,
			},
		};
		this.receipts.set(body.idempotency_key, {
			payload,
			status: 201,
			body: receipt,
		});
		return { receipt, replayed: false };
	}

	/** Gate-2 revalidation stand-in: a required artifact marked corrupt fails closed. */
	private revalidate(e: FxExecution): string | null {
		const run = e.runs.find((x) => x.summary.run_id === e.result_run_id);
		if (!run) return "The result attempt is no longer available.";
		for (const a of run.artifacts)
			if (this.corrupted.has(a.item.artifact_id))
				return `Evidence ${a.item.name} no longer verifies.`;
		return null;
	}

	// ── engine simulation (fixture controls only) ───────────────────────────

	/**
	 * One engine step of the task's current execution, following its simulation scenario and
	 * repair policy. Returns false when nothing moved (not running, impl_hangs, terminal…).
	 */
	advance(taskId: string, evidence: FixtureEvidence = "verified"): boolean {
		const t = this.task(taskId);
		const e = t ? this.exec(t) : null;
		if (!t || !e) return false;
		const run = e.runs.at(-1);
		const attempt = run?.summary.attempt_no ?? 0;
		// the hub's per-stage authorize: an approved legacy (v1) execution launches no further stage
		if (
			!this.prePolicy &&
			!isProposalV1_2(e.proposal.snapshot) &&
			(e.state === "queued" ||
				e.state === "repairing" ||
				e.state === "executing" ||
				e.state === "verifying" ||
				e.state === "reviewing")
		)
			return this.endExecution(
				t,
				e,
				"blocked",
				"approval_void",
				OBSOLETE_ENGINE_DETAIL,
				`the execution ended (blocked: approval_void); ${OBSOLETE_V1_GRANT_DETAIL}`,
			);
		switch (e.state) {
			case "queued":
				this.startAttempt(t, e, 1, "initial");
				return true;
			case "repairing":
				this.startAttempt(t, e, attempt + 1, "repair");
				return true;
			case "executing": {
				if (e.scenario === "impl_hangs") return false;
				if (e.scenario === "no_changes")
					return this.endExecution(
						t,
						e,
						"failed",
						"no_changes",
						"The implementer changed nothing.",
					);
				if (e.scenario === "out_of_scope")
					return this.endExecution(
						t,
						e,
						"failed",
						"scope_violation",
						"The change touched files outside the approved scope.",
					);
				this.addImplementationArtifacts(e, run as FxRun);
				(run as FxRun).summary.phase = "verify";
				this.touchExec(e, "verifying");
				return true;
			}
			case "verifying": {
				const fails =
					e.scenario === "verification_fails" ||
					(e.scenario === "verification_fails_then_fixed" && attempt === 1);
				this.addVerificationArtifacts(e, run as FxRun, fails, evidence);
				if (fails) {
					if (attempt < 1 + e.max_repairs)
						return this.toRepair(e, run as FxRun, "verification_failed");
					return this.endExecution(
						t,
						e,
						"failed",
						e.max_repairs > 0
							? "repair_limit_exhausted"
							: "verification_failed",
						"Verification check unit exited with status 1.",
					);
				}
				(run as FxRun).summary.phase = "review";
				this.touchExec(e, "reviewing");
				return true;
			}
			case "reviewing":
				return this.review(t, e, run as FxRun, attempt, evidence);
			default:
				return false;
		}
	}

	private startAttempt(
		t: FxTask,
		e: FxExecution,
		attempt_no: number,
		kind: "initial" | "repair",
	): void {
		e.runs.push({
			summary: {
				run_id: this.id("run"),
				managed_task_id: e.managed_task_id,
				attempt_no,
				kind,
				state: "running",
				phase: "implement",
				outcome: null,
				candidate_sha: null,
				manifest_hash: null,
				failure_kind: null,
				started_at: this.ts(),
				ended_at: null,
			},
			artifacts: [],
			checks: [],
		});
		this.touchExec(e, "executing");
		if (t.summary.stage === "queued")
			this.moveStage(t, "running", "engine_started", "engine");
	}

	private finishRun(
		run: FxRun,
		state: RunSummary["state"],
		outcome: RunSummary["outcome"],
		failure: FailureKind | null,
	): void {
		run.summary.state = state;
		run.summary.phase = "done";
		run.summary.outcome = outcome;
		run.summary.failure_kind = failure;
		run.summary.ended_at = this.ts();
	}

	private toRepair(e: FxExecution, run: FxRun, why: FailureKind): boolean {
		this.finishRun(run, "finished", "rejected", why);
		e.state_detail = `Attempt ${run.summary.attempt_no} did not pass (${why}); one pre-approved repair attempt follows.`;
		this.touchExec(e, "repairing");
		return true;
	}

	private endExecution(
		t: FxTask,
		e: FxExecution,
		state: "failed" | "blocked" | "interrupted",
		failure: FailureKind,
		detail: string,
		stageDetail: string = detail,
	): boolean {
		const run = e.runs.at(-1);
		if (run && run.summary.ended_at === null)
			this.finishRun(
				run,
				state === "interrupted" ? "unknown" : "failed",
				null,
				failure,
			);
		e.failure_kind = failure;
		e.state_detail = detail;
		this.touchExec(e, state);
		const stage = t.summary.stage;
		if (stage === "cancel_requested" && state === "interrupted") {
			e.quarantined = true;
			this.touch(t);
		} else if (
			stage === "queued" ||
			stage === "running" ||
			stage === "cancel_requested"
		)
			this.moveStage(
				t,
				"execution_ended",
				"engine_ended",
				"engine",
				stageDetail,
			);
		return true;
	}

	private review(
		t: FxTask,
		e: FxExecution,
		run: FxRun,
		attempt: number,
		evidence: FixtureEvidence,
	): boolean {
		const s = e.scenario;
		if (s === "malformed_review")
			return this.endExecution(
				t,
				e,
				"failed",
				"review_invalid",
				"The reviewer output was not valid.",
			);
		if (s === "review_wrong_candidate")
			return this.endExecution(
				t,
				e,
				"failed",
				"review_invalid",
				"The review named a different candidate.",
			);
		if (s === "reviewer_error")
			return this.endExecution(
				t,
				e,
				"blocked",
				"provider_unavailable",
				"The reviewer could not run.",
			);
		if (s === "reviewer_mutates")
			return this.endExecution(
				t,
				e,
				"failed",
				"candidate_mutated",
				"The candidate changed during review.",
			);
		const rejects =
			s === "reject_always" || (s === "reject_then_approve" && attempt === 1);
		this.addReviewArtifacts(e, run, rejects ? "reject" : "approve");
		if (rejects) {
			if (attempt < 1 + e.max_repairs)
				return this.toRepair(e, run, "review_rejected");
			return this.endExecution(
				t,
				e,
				"failed",
				e.max_repairs > 0 ? "repair_limit_exhausted" : "review_rejected",
				"The reviewer rejected the candidate.",
			);
		}
		run.summary.candidate_sha = this.sha("c0");
		run.summary.manifest_hash = this.hash("d1");
		this.finishRun(run, "finished", "approved", null);
		e.result_run_id = run.summary.run_id;
		e.state_detail = null;
		this.touchExec(e, "human_ready");
		this.seal(t, e, run, evidence);
		return true;
	}

	private seal(
		t: FxTask,
		e: FxExecution,
		run: FxRun,
		evidence: FixtureEvidence,
	): void {
		if (evidence === "missing")
			run.artifacts = run.artifacts.filter(
				(a) => a.item.name !== DIFF_ARTIFACT_NAME,
			);
		if (evidence === "log_missing" && run.checks[0])
			run.artifacts = run.artifacts.filter(
				(a) =>
					a.item.name !==
					verificationLogName(0, (run.checks[0] as EnvelopeCheck).name),
			);
		if (evidence === "check_failed" && run.checks.length > 0)
			run.checks = run.checks.map((c, i) =>
				i === run.checks.length - 1 ? { ...c, exit_code: 1 } : c,
			);
		for (const a of run.artifacts) {
			if (evidence === "corrupt" && a.item.name === MANIFEST_ARTIFACT_NAME)
				a.status = "corrupt";
			if (evidence === "withheld" && a.item.name === DIFF_ARTIFACT_NAME) {
				a.status = "withheld";
				a.withheld_reasons = ["context_unavailable"];
			}
		}
		const first = e.runs[0] as FxRun;
		const snapshot = e.proposal.snapshot;
		const envelope: ResultEnvelope = {
			contract: RESULT_CONTRACT,
			workspace_task_id: t.summary.id,
			proposal_id: e.proposal.id,
			proposal_hash: e.proposal.proposal_hash,
			execution_binding_hash: e.binding_hash,
			run_decision_id: e.run_decision_id ?? this.id("wsd"),
			managed_task_id: e.managed_task_id,
			run_id: run.summary.run_id,
			attempt_no: run.summary.attempt_no === 2 ? 2 : 1,
			max_repairs: e.max_repairs,
			base_sha: e.binding.base_sha,
			parent_sha:
				run.summary.attempt_no === 1
					? e.binding.base_sha
					: (first.summary.candidate_sha ?? this.sha("c1")),
			candidate_sha: run.summary.candidate_sha as string,
			candidate_tree: this.sha("7e"),
			manifest_hash: run.summary.manifest_hash as string,
			execution_mode: "simulated",
			policy_hash: e.binding.policy_hash,
			required_checks: [
				...e.proposal.snapshot.verification_plan.required_checks,
			],
			artifacts: run.artifacts
				.map(
					(a): EnvelopeArtifact => ({
						name: a.item.name,
						kind: a.item.kind,
						status: a.status,
						artifact_id: a.item.artifact_id,
						sha256: a.sha256,
						byte_len: a.item.byte_len,
						truncated: a.item.truncated,
					}),
				)
				.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
			verification: run.checks,
			review: {
				review_id: this.id("rev"),
				review_hash: this.hash("d2"),
				verdict: "approve",
				valid: true,
				candidate_sha: run.summary.candidate_sha as string,
				manifest_hash: run.summary.manifest_hash as string,
				findings: 1,
				blocking_findings: 0,
			},
			provenance: {
				implementer: {
					provider: "fake",
					mode: "simulated",
					model_requested: null,
					model_resolved: null,
				},
				reviewer: {
					provider: "fake",
					mode: "simulated",
					model_requested: null,
					model_resolved: null,
				},
			},
			evidence_status: "verified",
		};
		envelope.evidence_status = overallEvidenceStatus(envelope);
		// v1.2: coverage derived (pure) from the proposal's plan + this envelope; a legacy proposal
		// keeps a v1 envelope and is ineligible (criteria_unmapped), exactly like the hub
		const sealed: AnyResultEnvelope = isProposalV1_2(snapshot)
			? {
					...envelope,
					contract: RESULT_CONTRACT_V1_2,
					criterion_coverage: deriveCriterionCoverage(
						snapshot.coverage_plan,
						envelope,
					),
				}
			: envelope;
		const eligibility = resultEligibilityV1_2(sealed, snapshot);
		const eligible = eligibility.eligible;
		const why = eligibility.reasons.includes("criteria_unmapped")
			? "Legacy proposal without criterion coverage; a new proposal and approval are required."
			: envelope.evidence_status !== "verified"
				? `Required evidence is ${envelope.evidence_status}.`
				: eligibility.reasons.some((r) => r.startsWith("criterion_"))
					? "Not every criterion is satisfied by the sealed result."
					: `Result not eligible: ${eligibility.reasons.join(", ")}.`;
		const requestId = this.id("wsa");
		const envelopeHash = this.hash("e1");
		const at = this.ts();
		const request: FxRequest = {
			view: {
				id: requestId,
				workspace_task_id: t.summary.id,
				kind: "result",
				proposal_id: e.proposal.id,
				proposal_hash: e.proposal.proposal_hash,
				managed_task_id: e.managed_task_id,
				execution_binding: e.binding,
				execution_binding_hash: e.binding_hash,
				run_id: run.summary.run_id,
				result_envelope: sealed,
				result_envelope_hash: envelopeHash,
				binding: {
					contract: APPROVAL_CONTRACT,
					kind: "result",
					approval_request_id: requestId,
					workspace_task_id: t.summary.id,
					managed_task_id: e.managed_task_id,
					run_id: run.summary.run_id,
					result_envelope_hash: envelopeHash,
				},
				binding_hash: this.hash("b3"),
				status: "pending",
				invalidation_reason: null,
				invalidation_detail: null,
				created_at: at,
				updated_at: at,
				closed_at: null,
				rev: 1,
			},
			challenge: null,
		};
		t.requests.push(request);
		const next = stageAfterSealing(t.summary.stage, eligible);
		if (!next) return;
		if (next.trigger === "cancel_won")
			this.closeRequest(request, "invalidated", "task_cancelled");
		else if (!eligible)
			this.closeRequest(request, "invalidated", "evidence_unavailable", why);
		this.moveStage(t, next.to, next.trigger, "engine", eligible ? null : why);
	}

	private addArtifact(
		e: FxExecution,
		run: FxRun,
		name: string,
		kind: ArtifactKind,
		text: string,
		truncated = false,
	): void {
		run.artifacts.push({
			item: {
				artifact_id: this.id("art"),
				run_id: run.summary.run_id,
				name,
				kind,
				byte_len: byteLen(text),
				truncated,
				created_at: this.ts(),
			},
			status: truncated ? "truncated" : "verified",
			text,
			sha256: this.hash("f2"),
			withheld_reasons: [],
		});
		this.touchExec(e);
	}

	private addImplementationArtifacts(e: FxExecution, run: FxRun): void {
		const n = run.summary.attempt_no;
		this.addArtifact(e, run, DIFF_ARTIFACT_NAME, "diff", fixtureDiff(n));
		this.addArtifact(
			e,
			run,
			"implementation.log",
			"implementation_log",
			[
				"UI fixture — synthetic log; no implementation was executed.",
				`attempt ${n}: fake implementer (simulated)`,
				"Markup in evidence is shown as text: <b>not bold</b> <img src=x>",
			].join("\n"),
		);
		this.addArtifact(
			e,
			run,
			"changed-files.txt",
			"changed_files",
			"src/settings.ts\n",
		);
	}

	private addVerificationArtifacts(
		e: FxExecution,
		run: FxRun,
		fails: boolean,
		evidence: FixtureEvidence,
	): void {
		const checks: readonly string[] =
			e.proposal.snapshot.verification_plan.required_checks;
		run.checks = checks.map((name, i) => {
			const failing = fails && i === 0;
			const truncated = evidence === "truncated_log" && i === 0 && !failing;
			const text = [
				`UI fixture — synthetic output of check \`${name}\`.`,
				failing
					? "1 failing assertion (synthetic)"
					: "all assertions passed (synthetic)",
				`exit ${failing ? 1 : 0}`,
			].join("\n");
			this.addArtifact(
				e,
				run,
				verificationLogName(i, name),
				"verification_log",
				text,
				truncated,
			);
			return {
				name,
				completed: true,
				timed_out: false,
				exit_code: failing ? 1 : 0,
				duration_ms: 1200 + i * 300,
				log_sha256: this.hash("f3"),
				log_truncated: truncated,
			};
		});
		this.addArtifact(
			e,
			run,
			MANIFEST_ARTIFACT_NAME,
			"manifest",
			JSON.stringify(
				{
					note: "UI fixture — synthetic manifest",
					attempt: run.summary.attempt_no,
					checks: run.checks.map((c) => ({
						name: c.name,
						exit_code: c.exit_code,
					})),
				},
				null,
				2,
			),
		);
	}

	private addReviewArtifacts(
		e: FxExecution,
		run: FxRun,
		verdict: "approve" | "reject",
	): void {
		this.addArtifact(
			e,
			run,
			REVIEW_OUTPUT_ARTIFACT_NAME,
			"review_output",
			JSON.stringify(
				{
					note: "UI fixture — synthetic review",
					verdict,
					findings: [
						{
							severity: verdict === "approve" ? "minor" : "major",
							title:
								verdict === "approve"
									? "Consider a unit test for the zero-retry case"
									: "Backoff is not bounded",
							actionable: true,
						},
					],
				},
				null,
				2,
			),
		);
		this.addArtifact(
			e,
			run,
			"review.log",
			"review_log",
			"UI fixture — synthetic reviewer log.\n",
		);
	}

	/** Termination confirmed for a pending cancel (cancel_requested → cancelled). */
	confirmCancel(taskId: string): boolean {
		const t = this.task(taskId);
		const e = t ? this.exec(t) : null;
		if (!t || !e || t.summary.stage !== "cancel_requested") return false;
		const run = e.runs.at(-1);
		if (run && run.summary.ended_at === null)
			this.finishRun(run, "cancelled", null, "cancelled");
		e.failure_kind = "cancelled";
		e.quarantined = false;
		e.state_detail = "Termination confirmed.";
		this.touchExec(e, "cancelled");
		this.moveStage(
			t,
			"cancelled",
			"engine_cancelled",
			"engine",
			"Termination confirmed.",
		);
		return true;
	}

	/** The hub stopped mid-stage (restart without proof). */
	interrupt(taskId: string): boolean {
		const t = this.task(taskId);
		const e = t ? this.exec(t) : null;
		if (!t || !e || !ACTIVE.includes(e.state)) return false;
		return this.endExecution(
			t,
			e,
			"interrupted",
			"interrupted",
			"The hub stopped during this attempt; termination of its process is not proven.",
		);
	}

	/** Reconciler: the pending Gate-1 request lost its authority (policy / repo change). */
	invalidateRunRequest(
		taskId: string,
		reason: "policy_changed" | "repo_unavailable" = "policy_changed",
	): boolean {
		const t = this.task(taskId);
		const r = t ? this.pending(t, "run") : undefined;
		if (!t || !r) return false;
		this.closeRequest(r, "invalidated", reason);
		const e = this.executions.get(r.view.managed_task_id);
		if (e) this.touchExec(e, "cancelled");
		this.moveStage(
			t,
			"draft",
			"run_request_invalidated",
			"reconciler",
			`Approval request invalidated: ${reason}.`,
		);
		return true;
	}

	/** Reconciler sweep: the pending Gate-2 subject no longer verifies. */
	invalidateResult(
		taskId: string,
		reason: "integrity_failed" | "candidate_mutated" = "integrity_failed",
	): boolean {
		const t = this.task(taskId);
		const r = t ? this.pending(t, "result") : undefined;
		if (!t || !r) return false;
		this.closeRequest(r, "invalidated", reason);
		this.moveStage(
			t,
			"execution_ended",
			"result_invalidated",
			"reconciler",
			`Result invalidated: ${reason}.`,
		);
		return true;
	}

	/**
	 * Mark one artifact of the task as corrupt (bytes no longer match). Before acceptance Gate 2 then
	 * fails closed; after acceptance the next task-detail read finds the acceptance `invalid`
	 * (source_evidence_changed) while the accepted original stays served from the sealed copy.
	 */
	corruptEvidence(taskId: string, name: string): boolean {
		for (const e of this.executions.values()) {
			if (e.workspace_task_id !== taskId) continue;
			for (const run of e.runs)
				for (const a of run.artifacts)
					if (a.item.name === name) this.corrupted.add(a.item.artifact_id);
		}
		return this.corrupted.size > 0;
	}

	/**
	 * Fixture control (v1.2 §C): put the accepted result of a task into one of the four validity
	 * states, with the hub's rules — `invalid` / `unverifiable` are sticky (a later request is
	 * refused → false); `unknown` means the check cannot run (re-checks keep answering `unknown`
	 * until `valid` is requested); `valid` re-checks now (a changed artifact still makes it invalid).
	 */
	setAcceptanceValidity(
		taskId: string,
		status: AcceptanceValidityStatus,
		reason?: AcceptanceValidityReason,
	): boolean {
		const t = this.task(taskId);
		const v = this.validity.get(taskId);
		if (!t || !v) return false;
		if (v.status === "invalid" || v.status === "unverifiable") return false;
		const at = this.ts();
		switch (status) {
			case "valid":
				this.verificationDown.delete(taskId);
				this.recheckValidity(t);
				return true;
			case "unknown":
				this.verificationDown.add(taskId);
				this.recheckValidity(t);
				return true;
			case "invalid":
				this.validity.set(taskId, {
					...v,
					status: "invalid",
					reason: reason ?? "source_evidence_changed",
					detail: "Fixture control: acceptance invalidated.",
					checked_at: at,
					first_invalid_at: at,
				});
				return true;
			case "unverifiable":
				this.validity.set(taskId, {
					...v,
					status: "unverifiable",
					reason: "legacy_no_durable_evidence",
					detail: null,
					checked_at: at,
					first_invalid_at: null,
					evidence_bundle_digest: null,
				});
				return true;
		}
	}

	/** Fixture control: publish legacy v1 proposals from now on (true) or v1.2 (false, default). */
	setLegacyContract(on: boolean): void {
		this.legacyContract = on;
	}

	/**
	 * Fixture control (history only): what the PRE-policy hub did with a pending legacy Gate 1 —
	 * approve it and run the execution to its end (its result is ineligible: criteria_unmapped).
	 * Today's routes refuse such a grant; this keeps legacy results renderable. False when the
	 * task has no pending legacy Gate 1.
	 */
	runLegacyBeforePolicy(
		taskId: string,
		evidence: FixtureEvidence = "verified",
		/** Engine steps the pre-policy engine took (0 = approved and queued, not started). */
		steps = 32,
	): boolean {
		const t = this.task(taskId);
		const r = t ? this.pending(t, "run") : undefined;
		if (!t || !r || !this.obsoleteGrant(t, r)) return false;
		const e = this.executions.get(r.view.managed_task_id);
		if (!e) return false;
		const body: DecisionRequest = {
			idempotency_key: `fx-legacy-${this.next()}`,
			kind: "run",
			action: "approve",
			expected_request_rev: r.view.rev,
			binding_hash: r.view.binding_hash,
			confirmation_text: "Edward",
			reason: null,
			challenge: this.token("fxch"),
		};
		this.prePolicy = true;
		try {
			this.applyDecision(
				t,
				r,
				e,
				body,
				stableJson(decisionPayloadFrom(body, r.view.id)),
			);
			for (let i = 0; i < steps && this.advance(taskId, evidence); i++) {
				// the pre-policy engine runs to its end
			}
		} finally {
			this.prePolicy = false;
		}
		return true;
	}

	expireChallenges(): void {
		const past = this.ts(-1);
		for (const t of this.tasks.values())
			for (const r of t.requests)
				if (r.challenge) r.challenge.expires_at = past;
	}

	revokeSession(): void {
		this.session = null;
	}

	setReadOnly(readOnly: boolean): void {
		this.scopes = readOnly
			? ["workspace:read"]
			: ["workspace:read", "workspace:decide"];
		if (this.session) this.session.scopes = [...this.scopes];
	}

	rejectNextSignIn(): void {
		this.rejectSignIn = true;
	}

	setDecisionFault(fault: DecisionFault | null): void {
		this.decisionFault = fault;
	}

	/** Ids of every task, oldest first (for tests and the dev harness). */
	taskIds(): string[] {
		return [...this.order];
	}
}

function fixtureDiff(attempt: number): string {
	return [
		"# UI fixture — synthetic diff; nothing was changed in any repository.",
		"diff --git a/src/settings.ts b/src/settings.ts",
		"--- a/src/settings.ts",
		"+++ b/src/settings.ts",
		"@@ -1,4 +1,6 @@",
		" export const settings = {",
		"-  retries: 0,",
		`+  retries: ${attempt + 1},`,
		"+  backoffMs: 250,",
		" };",
	].join("\n");
}
