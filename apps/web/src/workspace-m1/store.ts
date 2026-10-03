// Workspace client store (role 07): the ONE cache that drives the repo list, task panel and HQ
// (M1-09). A plain TS class (no React, no DOM) so every rule is unit-tested with the fixture
// transport; React subscribes through useSyncExternalStore (useWorkspace.ts).
//
// Rules enforced here:
//  - every async answer carries a Ticket (auth generation + subject slot); stale answers are
//    dropped (A→B navigation, closed viewer, sign-out/in, late 401s never sign a new session out);
//  - reads never regress revs (rev-monotonic merge on top of latest-request-wins);
//  - state is rebuilt from server reads only — no local success flag; nothing is persisted in
//    browser storage; the CSRF value lives only inside the transport;
//  - gate + decision hazards: see gate.ts / decision-attempt.ts.
import type {
	AcceptanceValidityView,
	ApprovalRequestView,
	ArtifactListItem,
	ArtifactTextResponse,
	DecisionAction,
	DecisionResponse,
	EngineView,
	RequestSummary,
	SessionView,
	WorkspaceSnapshot,
	WorkspaceTaskDetail,
	WorkspaceTaskListItem,
	WorkspaceTaskSummary,
	WorkspaceTaskView,
} from "@agent-city/schema/workspace-m1";
import {
	beginRetry,
	blocksNewDecision,
	type DecisionAttempt,
	newIdempotencyKey,
	reconcileWithServer,
	settleAttempt,
	startAttempt,
} from "./decision-attempt.ts";
import {
	type DraftForm,
	draftFromForm,
	formMatchesDraft,
	readableIssuePath,
} from "./draft-form.ts";
import {
	buildDecisionBody,
	challengeFailed,
	challengeLoading,
	challengeReady,
	clearSignature,
	declineBlockers,
	expireIfNeeded,
	type GateContext,
	type GateState,
	grantBlockers,
	openGate,
	setReason,
	setSignature,
	syncGate,
} from "./gate.ts";
import {
	clockTime,
	committedMessage,
	errorCopy,
	errorCopyOf,
	hubStaleReason,
	isObsoleteGrant,
	nextAction,
	OBSOLETE_GRANT_NOTE,
	OUTCOME_UNKNOWN,
	PHASE_LABEL,
} from "./labels.ts";
import { HOME, type Route, sameRoute } from "./route.ts";
import { Sequencer, type Ticket } from "./sequencer.ts";
import {
	errorCode,
	isUnauthenticated,
	type TransportResult,
	type WorkspaceTransport,
} from "./transport.ts";

export interface DetailEntry {
	data: WorkspaceTaskDetail | null;
	loading: boolean;
	error: string | null;
}

export interface ViewerState {
	taskId: string;
	artifactId: string;
	name: string;
	/** DOM id of the control that opened the viewer (focus returns there on close). */
	openerId: string | null;
	state: "loading" | "ok" | "error";
	data: ArtifactTextResponse | null;
	error: string | null;
}

export type CommandName = "create" | "save" | "publish" | "rerun" | "cancel";

export interface CommandState {
	name: CommandName;
	taskId: string | null;
	status: "busy" | "done" | "failed" | "unknown";
	message: string;
}

export interface AlertState {
	message: string;
	lastConfirmed: string;
	next: string;
}

export interface WsState {
	source: "hub" | "fixture";
	authGen: number;
	auth: {
		status: "checking" | "signed_out" | "signed_in";
		session: SessionView | null;
		error: string | null;
		busy: boolean;
		notice: string | null;
	};
	conn: {
		status: "connecting" | "online" | "offline";
		lastConfirmedAt: string | null;
	};
	snapshot: WorkspaceSnapshot | null;
	route: Route;
	details: Readonly<Record<string, DetailEntry>>;
	gate: GateState | null;
	attempts: Readonly<Record<string, DecisionAttempt>>;
	viewer: ViewerState | null;
	command: CommandState | null;
	alert: AlertState | null;
	/** "Assign work" in progress for a repo (no server task yet). */
	composing: { repoId: string; key: string } | null;
	/** Bumped when the store wants the detail heading focused (selection change). */
	focusSeq: number;
	/** How the next route change reaches the URL: a user selection pushes, a normalization replaces. */
	routeMode: "push" | "replace";
	/** Why the selection was just cleared (e.g. an unknown deep link); shown in the empty panel. */
	routeNotice: string | null;
}

export interface StoreDeps {
	transport: WorkspaceTransport;
	now?: () => number;
	/** Random part of idempotency keys (tests inject a counter). */
	random?: () => string;
}

/** Older = a lower task rev, a lower engine rev of the same execution, or a lower request rev. */
export function isOlderDetail(
	incoming: Pick<WorkspaceTaskDetail, "task" | "engine" | "approval_requests">,
	current: Pick<WorkspaceTaskDetail, "task" | "engine" | "approval_requests">,
): boolean {
	if (incoming.task.id !== current.task.id) return false;
	if (incoming.task.rev !== current.task.rev)
		return incoming.task.rev < current.task.rev;
	const ie = incoming.engine;
	const ce = current.engine;
	if (ie && ce && ie.managed_task_id === ce.managed_task_id && ie.rev < ce.rev)
		return true;
	for (const cr of current.approval_requests) {
		const ir = incoming.approval_requests.find((x) => x.id === cr.id);
		if (!ir || ir.rev < cr.rev) return true;
	}
	return false;
}

type Validity = AcceptanceValidityView | null | undefined;

/**
 * Current acceptance validity has its own clock: a validity re-check does not bump the task rev, so
 * the rev-based merge cannot order it. Rule (one place): for the same decision the NEWER check wins
 * (`checked_at`, ties → incoming); `undefined` (not reported by this answer) keeps the current
 * value; anything else follows the hub. The hub keeps `invalid`/`unverifiable` sticky, so an
 * out-of-order older answer (e.g. a snapshot read started before a detail re-check) can never put a
 * "verified" badge back after a newer check said `invalid`.
 */
export function newerValidity(current: Validity, incoming: Validity): Validity {
	if (incoming === undefined) return current;
	if (!current || !incoming) return incoming;
	if (current.decision_id !== incoming.decision_id) return incoming;
	const c = Date.parse(current.checked_at);
	const i = Date.parse(incoming.checked_at);
	if (Number.isFinite(c) && Number.isFinite(i) && i < c) return current;
	return incoming;
}

/**
 * Fold `newerValidity` into an incoming read of the same task (detail or command answer). The
 * cached object always carries `acceptance_validity` explicitly (null when nothing is reported),
 * i.e. already the shape of the required-nullable field.
 */
function withMergedValidity<T extends { acceptance_validity?: Validity }>(
	incoming: T,
	current: { acceptance_validity?: Validity } | null | undefined,
): T & { acceptance_validity: AcceptanceValidityView | null } {
	const v =
		newerValidity(current?.acceptance_validity, incoming.acceptance_validity) ??
		null;
	return { ...incoming, acceptance_validity: v };
}

const byCreated = (a: { created_at: string }, b: { created_at: string }) =>
	a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;

/** The snapshot's `latest_request` summary of a task view's requests (newest first, as the hub lists them). */
export function latestRequestOf(
	requests: readonly ApprovalRequestView[],
): RequestSummary | null {
	const r = requests[0];
	return r
		? {
				id: r.id,
				kind: r.kind,
				status: r.status,
				invalidation_reason: r.invalidation_reason,
				created_at: r.created_at,
				closed_at: r.closed_at,
			}
		: null;
}

/**
 * Older list row = a lower task rev, or the same task rev with an older engine view of the SAME
 * execution (engine progress does not bump the task rev; mirrors `isOlderDetail`).
 */
export function isOlderItem(
	incoming: {
		task: Pick<WorkspaceTaskSummary, "rev">;
		engine?: EngineView | null;
	},
	current: {
		task: Pick<WorkspaceTaskSummary, "rev">;
		engine?: EngineView | null;
	},
): boolean {
	if (incoming.task.rev !== current.task.rev)
		return incoming.task.rev < current.task.rev;
	const ie = incoming.engine;
	const ce = current.engine;
	return !!(
		ie &&
		ce &&
		ie.managed_task_id === ce.managed_task_id &&
		ie.rev < ce.rev
	);
}

/**
 * Latest snapshot wins, but no task row may regress (lower task rev, or an older engine view of the
 * same execution) — and where the cached row has the newer task rev, that task's pending requests are
 * kept from the cache too (inbox membership never regresses). Snapshot-level facts (repos, observed
 * repos, the global execution queue) follow the latest answer.
 */
export function mergeSnapshot(
	prev: WorkspaceSnapshot | null,
	next: WorkspaceSnapshot,
): WorkspaceSnapshot {
	if (!prev) return next;
	const old = new Map(prev.tasks.map((t) => [t.task.id, t]));
	const keptOld = new Set<string>();
	const tasks = next.tasks.map((t) => {
		const o = old.get(t.task.id);
		if (o && isOlderItem(t, o)) {
			if (o.task.rev > t.task.rev) keptOld.add(t.task.id);
			return withMergedValidity(o, t);
		}
		return withMergedValidity(t, o);
	});
	const pending = [
		...next.pending_requests.filter((r) => !keptOld.has(r.workspace_task_id)),
		...prev.pending_requests.filter((r) => keptOld.has(r.workspace_task_id)),
	].sort(byCreated);
	return { ...next, tasks, pending_requests: pending };
}

/**
 * Fold a fresh task read into the snapshot so the repo list, task list and HQ inbox agree with
 * the task panel immediately (one cache, M1-09). Never regresses a newer row.
 */
export function foldTaskIntoSnapshot(
	snap: WorkspaceSnapshot | null,
	v: Pick<
		WorkspaceTaskView,
		"task" | "phase" | "approval_requests" | "acceptance_validity" | "engine"
	>,
): WorkspaceSnapshot | null {
	if (!snap) return snap;
	const i = snap.tasks.findIndex((t) => t.task.id === v.task.id);
	const cur = i >= 0 ? snap.tasks[i] : undefined;
	const engine = v.engine ?? null;
	if (cur && isOlderItem({ task: v.task, engine }, cur)) return snap;
	const item: WorkspaceTaskListItem = {
		task: v.task,
		phase: v.phase,
		acceptance_validity:
			newerValidity(cur?.acceptance_validity, v.acceptance_validity) ?? null,
		engine,
		latest_request: latestRequestOf(v.approval_requests ?? []),
	};
	const tasks = cur
		? snap.tasks.map((t, j) => (j === i ? item : t))
		: [item, ...snap.tasks];
	const pending = [
		...snap.pending_requests.filter((r) => r.workspace_task_id !== v.task.id),
		...v.approval_requests.filter((r) => r.status === "pending"),
	].sort(byCreated);
	return { ...snap, tasks, pending_requests: pending };
}

/** A command answer (WorkspaceTaskView) folded into the cached detail (runs/artifacts kept). */
function detailFromView(
	prev: WorkspaceTaskDetail | null,
	view: WorkspaceTaskView,
): WorkspaceTaskDetail {
	return withMergedValidity(
		{ ...view, runs: prev?.runs ?? [], artifacts: prev?.artifacts ?? [] },
		prev,
	);
}

const initialState = (source: "hub" | "fixture", route: Route): WsState => ({
	source,
	authGen: 0,
	auth: {
		status: "checking",
		session: null,
		error: null,
		busy: false,
		notice: null,
	},
	conn: { status: "connecting", lastConfirmedAt: null },
	snapshot: null,
	route,
	details: {},
	gate: null,
	attempts: {},
	viewer: null,
	command: null,
	alert: null,
	composing: null,
	focusSeq: 0,
	routeMode: "push",
	routeNotice: null,
});

export class WorkspaceStore {
	private state: WsState;
	private readonly listeners = new Set<() => void>();
	private readonly seq = new Sequencer();
	private readonly transport: WorkspaceTransport;
	private readonly now: () => number;
	private readonly random: () => string;

	constructor(deps: StoreDeps, route: Route = HOME) {
		this.transport = deps.transport;
		this.now = deps.now ?? (() => Date.now());
		this.random = deps.random ?? (() => crypto.randomUUID());
		this.state = initialState(deps.transport.source, route);
	}

	// ── subscription ────────────────────────────────────────────────────────

	getState = (): WsState => this.state;

	subscribe = (fn: () => void): (() => void) => {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	};

	private set(patch: Partial<WsState>): void {
		this.state = { ...this.state, ...patch };
		for (const fn of this.listeners) fn();
	}

	private setDetail(taskId: string, entry: Partial<DetailEntry>): void {
		const prev = this.state.details[taskId] ?? {
			data: null,
			loading: false,
			error: null,
		};
		this.set({
			details: { ...this.state.details, [taskId]: { ...prev, ...entry } },
		});
	}

	private nowIso(): string {
		return new Date(this.now()).toISOString();
	}

	private key(prefix: string): string {
		return newIdempotencyKey(prefix, this.random);
	}

	// ── selectors ───────────────────────────────────────────────────────────

	detail(taskId: string | null): WorkspaceTaskDetail | null {
		return taskId ? (this.state.details[taskId]?.data ?? null) : null;
	}

	findRequest(
		taskId: string | null,
		requestId: string | null,
	): ApprovalRequestView | null {
		if (!requestId) return null;
		const d = this.detail(taskId);
		const fromDetail = d?.approval_requests.find((r) => r.id === requestId);
		if (fromDetail) return fromDetail;
		return (
			this.state.snapshot?.pending_requests.find((r) => r.id === requestId) ??
			null
		);
	}

	canDecide(): boolean {
		return (
			this.state.auth.session?.scopes.includes("workspace:decide") ?? false
		);
	}

	gateContext(): GateContext | null {
		const g = this.state.gate;
		if (!g) return null;
		const req = this.findRequest(g.taskId, g.requestId);
		return {
			now: this.now(),
			online: this.state.conn.status !== "offline",
			canDecide: this.canDecide(),
			busy: blocksNewDecision(this.state.attempts[g.requestId]),
			pending: req?.status === "pending",
		};
	}

	private lastConfirmed(taskId: string | null): string {
		const d = this.detail(taskId);
		const at = clockTime(this.state.conn.lastConfirmedAt);
		if (!d) return `Last confirmed update: ${at}.`;
		return `Last confirmed state: ${PHASE_LABEL[d.phase]} (task revision ${d.task.rev}) at ${at}.`;
	}

	private raise(message: string, taskId: string | null, next?: string): void {
		const d = this.detail(taskId);
		this.set({
			alert: {
				message,
				lastConfirmed: this.lastConfirmed(taskId),
				next:
					next ??
					(d
						? nextAction(d.task.stage, d.phase)
						: "Reload the workspace, then try again."),
			},
		});
	}

	dismissAlert(): void {
		this.set({ alert: null });
	}

	// ── session ─────────────────────────────────────────────────────────────

	async boot(): Promise<void> {
		const t = this.seq.begin("session");
		const r = await this.transport.getSession();
		if (!this.seq.isCurrent(t)) return;
		if (r.ok) {
			this.signedIn(r.data);
			await this.refresh();
		} else if (isUnauthenticated(r)) {
			this.set({
				auth: { ...this.state.auth, status: "signed_out" },
				conn: { ...this.state.conn, status: "online" },
			});
		} else if (r.kind === "http") {
			// the hub answered (e.g. 503 disabled, 403 forbidden_origin): say what it said
			this.set({
				auth: {
					...this.state.auth,
					status: "signed_out",
					error: errorCopy(r.error.error, r.error.message),
				},
				conn: { ...this.state.conn, status: "online" },
			});
		} else {
			this.set({
				auth: {
					...this.state.auth,
					status: "signed_out",
					error: "The hub could not be reached. Try again.",
				},
				conn: { ...this.state.conn, status: "offline" },
			});
		}
	}

	private signedIn(session: SessionView): void {
		const authGen = this.seq.bumpAuth();
		this.set({
			authGen,
			auth: {
				status: "signed_in",
				session,
				error: null,
				busy: false,
				notice: null,
			},
			snapshot: null,
			details: {},
			gate: null,
			attempts: {},
			viewer: null,
			command: null,
			alert: null,
			composing: null,
		});
	}

	/** The credential is passed through once and never stored. */
	async signIn(credential: string): Promise<void> {
		if (this.state.auth.busy) return;
		this.set({ auth: { ...this.state.auth, busy: true, error: null } });
		const t = this.seq.begin("signin");
		const r = await this.transport.signIn({ credential });
		if (!this.seq.isCurrent(t)) return;
		if (r.ok) {
			this.signedIn(r.data);
			await this.refresh();
			return;
		}
		const code = r.kind === "http" ? r.error.error : null;
		this.set({
			auth: {
				...this.state.auth,
				status: "signed_out",
				busy: false,
				error:
					code === "unauthenticated" || code === "invalid_request"
						? "Sign-in failed. Check the operator credential and try again."
						: code !== null && r.kind === "http"
							? errorCopy(code, r.error.message)
							: "The hub could not be reached. Try again.",
			},
			conn: {
				...this.state.conn,
				status: r.kind === "http" ? "online" : "offline",
			},
		});
	}

	/** Purge every workspace datum, selection, form, viewer and signature; then end the session. */
	async signOut(): Promise<void> {
		this.purge("Signed out.");
		const gen = this.seq.authGen;
		const r = await this.transport.signOut();
		// local state is gone either way; if the hub did not confirm, say so honestly (a 401 means
		// the session was already over, which is also an end)
		if (
			!r.ok &&
			!isUnauthenticated(r) &&
			this.seq.authGen === gen &&
			this.state.auth.status === "signed_out"
		)
			this.set({
				auth: {
					...this.state.auth,
					notice:
						"Signed out in this browser, but the hub did not confirm ending the session. It ends by itself when it expires.",
				},
			});
	}

	private purge(notice: string | null): void {
		const authGen = this.seq.bumpAuth();
		this.set({
			...initialState(this.state.source, { ...HOME }),
			authGen,
			auth: {
				status: "signed_out",
				session: null,
				error: null,
				busy: false,
				notice,
			},
			conn: this.state.conn,
		});
	}

	/** A 401 ends only the generation that received it (a late 401 cannot sign a new session out). */
	private onUnauthenticated(t: { authGen: number }): void {
		if (!this.seq.isSameAuth(t)) return;
		this.purge("Your session ended. Sign in again.");
	}

	private wentOffline(): void {
		const g = this.state.gate;
		this.set({
			conn: { ...this.state.conn, status: "offline" },
			gate:
				g && (g.signature !== "" || g.challenge.phase !== "none")
					? clearSignature(
							g,
							"offline",
							"Offline: the signature was cleared. It can be entered again when the connection returns.",
						)
					: g,
		});
	}

	private confirmed(): void {
		this.set({ conn: { status: "online", lastConfirmedAt: this.nowIso() } });
	}

	/** Common handling of a failed READ. */
	private readFailed(t: Ticket, r: TransportResult<unknown>): void {
		if (isUnauthenticated(r)) this.onUnauthenticated(t);
		else if (!r.ok && r.kind !== "http") this.wentOffline();
	}

	// ── reads ───────────────────────────────────────────────────────────────

	async refresh(): Promise<void> {
		if (this.state.auth.status !== "signed_in") return;
		const taskId = this.state.route.taskId;
		await Promise.all([
			this.loadSnapshot(),
			taskId ? this.loadDetail(taskId) : Promise.resolve(),
		]);
	}

	async loadSnapshot(): Promise<void> {
		const t = this.seq.begin("snapshot");
		const r = await this.transport.getSnapshot();
		if (!this.seq.isCurrent(t)) return;
		if (r.ok) {
			this.set({ snapshot: mergeSnapshot(this.state.snapshot, r.data) });
			this.confirmed();
			this.normalizeRepo();
			this.ensureGate();
		} else this.readFailed(t, r);
	}

	/** Is this repository on the allowlist (assignable) / observed only / unknown to this hub? */
	repoKind(repoId: string | null): "allowlisted" | "observed" | "unknown" {
		const snap = this.state.snapshot;
		if (!repoId || !snap) return "unknown";
		if (snap.repos.some((r) => r.repo_id === repoId)) return "allowlisted";
		if (snap.observed_repos?.some((r) => r.repo_id === repoId))
			return "observed";
		return "unknown";
	}

	/**
	 * A Projects route naming a repository the hub neither allowlists nor observes: a task deep link
	 * moves to its task's own repository; anything else is cleared with a notice (replace, no loop).
	 */
	private normalizeRepo(): void {
		const { route, snapshot } = this.state;
		if (!snapshot || route.view !== "projects" || !route.repoId) return;
		if (this.repoKind(route.repoId) !== "unknown") return;
		const own = route.taskId
			? snapshot.tasks.find((t) => t.task.id === route.taskId)
			: undefined;
		if (own) {
			this.navigate({ ...route, repoId: own.task.repo_id }, "replace");
			return;
		}
		this.navigate(
			{ view: "projects", repoId: null, taskId: null, requestId: null },
			"replace",
			"That repository is not on the allowlist or known to this hub; the link was cleared.",
		);
	}

	async loadDetail(taskId: string): Promise<void> {
		const t = this.seq.begin(`detail:${taskId}`);
		if (!this.state.details[taskId]?.data)
			this.setDetail(taskId, { loading: true });
		const r = await this.transport.getTask(taskId);
		if (!this.seq.isCurrent(t)) return;
		if (r.ok) {
			const cur = this.state.details[taskId]?.data ?? null;
			if (cur && isOlderDetail(r.data, cur)) return;
			const data = withMergedValidity(r.data, cur);
			this.setDetail(taskId, { data, loading: false, error: null });
			this.set({ snapshot: foldTaskIntoSnapshot(this.state.snapshot, data) });
			this.confirmed();
			this.afterDetail(taskId);
		} else {
			this.setDetail(taskId, {
				loading: false,
				error:
					errorCode(r) === "not_found"
						? "This task does not exist (or is not visible to this session)."
						: (this.state.details[taskId]?.error ?? null),
			});
			this.readFailed(t, r);
			if (errorCode(r) === "not_found") this.normalizeUnknown(taskId);
		}
	}

	/** After fresh task data: sync the open gate and reconcile unknown decision outcomes. */
	private afterDetail(taskId: string): void {
		const d = this.detail(taskId);
		if (!d) return;
		const { route } = this.state;
		// a task always shows under its own repository (a task's repository never changes)
		if (
			route.view === "projects" &&
			route.taskId === taskId &&
			route.repoId !== d.task.repo_id
		) {
			this.navigate({ ...route, repoId: d.task.repo_id }, "replace");
			return;
		}
		if (
			route.view === "hq" &&
			route.taskId === taskId &&
			route.requestId !== null &&
			!d.approval_requests.some((r) => r.id === route.requestId)
		) {
			this.navigate(
				{ view: "hq", repoId: null, taskId: null, requestId: null },
				"replace",
				"That approval request does not exist for this task; the link was cleared.",
			);
			return;
		}
		let attempts = this.state.attempts;
		for (const a of Object.values(attempts)) {
			if (a.taskId !== taskId || a.status !== "unknown") continue;
			const req = d.approval_requests.find((r) => r.id === a.requestId) ?? null;
			const next = reconcileWithServer(a, req, d.decisions);
			if (next !== a) attempts = { ...attempts, [a.requestId]: next };
		}
		const g = this.state.gate;
		const gateReq =
			g && g.taskId === taskId ? this.findRequest(taskId, g.requestId) : null;
		let synced = g && g.taskId === taskId ? syncGate(g, gateReq) : g;
		// copy: an obsolete v1 grant retired by the hub names its own reason (not an evidence problem)
		if (synced && synced !== g && gateReq && isObsoleteGrant(gateReq))
			synced = {
				...synced,
				notice: `${OBSOLETE_GRANT_NOTE} The signature was cleared.`,
			};
		// our own committed decision closed the request: the Decision status says so already
		const own = synced ? attempts[synced.requestId] : undefined;
		if (
			synced &&
			synced !== g &&
			own?.status === "committed" &&
			!own.decidedElsewhere
		)
			synced = { ...synced, notice: null };
		this.set({ attempts, gate: synced });
		this.ensureGate();
	}

	/** An unknown task in the URL: explain it and normalize the URL in place (no history entry, no loop). */
	private normalizeUnknown(taskId: string): void {
		const { route } = this.state;
		if (route.taskId !== taskId) return;
		const notice =
			"That task does not exist (or is not visible to this session); the link was cleared.";
		if (route.view === "hq")
			this.navigate(
				{ view: "hq", repoId: null, taskId: null, requestId: null },
				"replace",
				notice,
			);
		else
			this.navigate(
				{ ...route, taskId: null, requestId: null },
				"replace",
				notice,
			);
	}

	/** Open the gate of the routed HQ request once its view is known. */
	private ensureGate(): void {
		const { route, gate } = this.state;
		if (route.view !== "hq" || !route.requestId) return;
		if (gate?.requestId === route.requestId) return;
		const req = this.findRequest(route.taskId, route.requestId);
		if (req) this.set({ gate: openGate(req) });
	}

	// ── navigation ──────────────────────────────────────────────────────────

	/** Select a subject. Same subject again keeps everything (N-8); anything else resets. */
	navigate(
		next: Route,
		mode: "push" | "replace" = "push",
		notice: string | null = null,
	): void {
		const prev = this.state.route;
		if (sameRoute(prev, next)) return;
		const subjectLeft =
			prev.view !== next.view ||
			prev.taskId !== next.taskId ||
			prev.requestId !== next.requestId;
		// focus moves to the detail heading only when a subject (task / request) is selected
		const selected =
			(next.taskId !== null || next.requestId !== null) && subjectLeft;
		const patch: Partial<WsState> = {
			route: next,
			focusSeq: this.state.focusSeq + (selected ? 1 : 0),
			routeMode: mode,
			routeNotice: notice,
		};
		if (subjectLeft && this.state.viewer) {
			this.seq.invalidate("artifact");
			patch.viewer = null;
		}
		if (next.view !== "hq" || next.requestId !== this.state.gate?.requestId) {
			this.seq.invalidate("challenge");
			patch.gate = null;
		}
		if (
			this.state.composing &&
			(next.view !== "projects" ||
				next.repoId !== this.state.composing.repoId ||
				next.taskId !== null)
		)
			patch.composing = null;
		if (subjectLeft) patch.command = null;
		this.set(patch);
		this.ensureGate();
		if (next.taskId && this.state.auth.status === "signed_in")
			void this.loadDetail(next.taskId);
	}

	// ── evidence viewer ─────────────────────────────────────────────────────

	async openArtifact(
		taskId: string,
		a: ArtifactListItem,
		openerId: string | null,
	): Promise<void> {
		const t = this.seq.begin("artifact");
		this.set({
			viewer: {
				taskId,
				artifactId: a.artifact_id,
				name: a.name,
				openerId,
				state: "loading",
				data: null,
				error: null,
			},
		});
		const r = await this.transport.getArtifact(taskId, a.artifact_id);
		if (
			!this.seq.isCurrent(t) ||
			this.state.viewer?.artifactId !== a.artifact_id
		)
			return;
		if (r.ok)
			this.set({ viewer: { ...this.state.viewer, state: "ok", data: r.data } });
		else {
			this.set({
				viewer: {
					...this.state.viewer,
					state: "error",
					error:
						r.kind === "http"
							? errorCopy(r.error.error, r.error.message)
							: "The evidence could not be loaded (no answer from the hub).",
				},
			});
			this.readFailed(t, r);
		}
	}

	/** Closing drops the in-flight read: a late answer never reopens the viewer. */
	closeArtifact(): void {
		this.seq.invalidate("artifact");
		this.set({ viewer: null });
	}

	// ── gate ────────────────────────────────────────────────────────────────

	setSignature(text: string): void {
		const g = this.state.gate;
		if (!g) return;
		this.set({ gate: setSignature(g, text) });
		if (text.length > 0) void this.ensureChallenge();
	}

	setReason(text: string): void {
		const g = this.state.gate;
		if (!g) return;
		this.set({ gate: setReason(g, text) });
		if (text.length > 0) void this.ensureChallenge();
	}

	/**
	 * Clock tick (1 s): refresh presentation age even while reads are pending and no gate is open.
	 * Hub records remain untouched; only an expired approval window clears the local signature.
	 */
	tick(): void {
		const g = this.state.gate;
		const next = g ? expireIfNeeded(g, this.now()) : null;
		if (this.state.auth.status === "signed_in" || next !== g)
			this.set({ gate: next });
	}

	private async ensureChallenge(): Promise<void> {
		const g = this.state.gate;
		const ctx = this.gateContext();
		if (!g || !ctx?.pending || !ctx.canDecide || !ctx.online || ctx.busy)
			return;
		if (g.challenge.phase === "loading" || g.challenge.phase === "ready")
			return;
		await this.requestChallenge();
	}

	async requestChallenge(): Promise<void> {
		const g = this.state.gate;
		if (!g) return;
		const subject = g.subject;
		const t = this.seq.begin("challenge");
		this.set({ gate: challengeLoading(g) });
		const r = await this.transport.issueChallenge(g.requestId, {
			kind: g.kind,
			binding_hash: g.bindingHash,
			expected_request_rev: g.knownRev,
		});
		const cur = this.state.gate;
		// a late challenge never binds to another subject
		if (!this.seq.isCurrent(t) || !cur || cur.subject !== subject) return;
		if (r.ok) {
			this.set({ gate: challengeReady(cur, r.data) });
			return;
		}
		if (isUnauthenticated(r)) return this.onUnauthenticated(t);
		if (r.kind === "http") {
			const code = r.error.error;
			if (
				code === "stale_binding" ||
				code === "invalid_state" ||
				code === "not_found"
			) {
				this.set({
					gate: clearSignature(
						cur,
						"error",
						`${errorCopyOf(r.error)} The signature was cleared.`,
					),
				});
				void this.loadDetail(cur.taskId);
				void this.loadSnapshot();
			} else
				this.set({
					gate: challengeFailed(cur, errorCopyOf(r.error)),
				});
			return;
		}
		this.set({
			gate: challengeFailed(
				cur,
				"The approval window could not be opened (no answer from the hub).",
			),
		});
		this.wentOffline();
	}

	/** Approve / Accept / Request changes / Reject with a deliberate click. One dispatch per request. */
	async decide(action: DecisionAction): Promise<void> {
		const g = this.state.gate;
		const ctx = this.gateContext();
		if (!g || !ctx) return;
		const grant = action === "approve" || action === "accept";
		const blockers = grant ? grantBlockers(g, ctx) : declineBlockers(g, ctx);
		if (blockers.length > 0) return;
		const key = this.key("dk");
		const built = buildDecisionBody(g, action, key);
		if (!built.ok) {
			this.raise(built.message, g.taskId);
			return;
		}
		const attempt = startAttempt({
			requestId: g.requestId,
			taskId: g.taskId,
			kind: g.kind,
			action,
			idempotencyKey: key,
			body: built.body,
			authGen: this.seq.authGen,
		});
		this.set({ attempts: { ...this.state.attempts, [g.requestId]: attempt } });
		const r = await this.transport.decide(g.requestId, built.body);
		await this.settle(attempt, r);
	}

	/** "Check decision outcome": the byte-identical body, same key, no new challenge first. */
	async retryDecision(requestId: string): Promise<void> {
		const a = this.state.attempts[requestId];
		if (a?.status !== "unknown" || !this.seq.isSameAuth(a)) return;
		const next = beginRetry(a);
		this.set({ attempts: { ...this.state.attempts, [requestId]: next } });
		const r = await this.transport.decide(requestId, a.body);
		await this.settle(next, r);
	}

	private async settle(
		a: DecisionAttempt,
		r: TransportResult<DecisionResponse>,
	): Promise<void> {
		if (!this.seq.isSameAuth(a)) return; // another session: never restore anything
		if (isUnauthenticated(r)) return this.onUnauthenticated(a);
		let next = settleAttempt(a, r);
		// copy: the hub's own fixed reason (e.g. the obsolete-v1 grant issue) instead of generic copy
		if (
			next.status === "failed" &&
			next.error &&
			!r.ok &&
			r.kind === "http" &&
			hubStaleReason(r.error) !== null
		)
			next = {
				...next,
				error: { ...next.error, message: errorCopyOf(r.error) },
			};
		const patch: Partial<WsState> = {
			attempts: { ...this.state.attempts, [a.requestId]: next },
		};
		const g = this.state.gate;
		if (g && g.requestId === a.requestId) {
			if (next.status === "committed")
				patch.gate = clearSignature(g, "submitted", null);
			else if (next.status === "unknown")
				patch.gate = clearSignature(
					g,
					"error",
					"The signature was cleared. “Check decision outcome” resends the same decision; it cannot decide twice.",
				);
			else
				patch.gate = clearSignature(
					g,
					"error",
					`${next.error?.message ?? "The decision failed."} The signature was cleared.`,
				);
		}
		this.set(patch);
		if (next.status === "committed" && this.state.alert)
			this.set({ alert: null });
		await Promise.all([this.loadDetail(a.taskId), this.loadSnapshot()]);
		// raised after the re-read, so "last confirmed state" is the server's state now
		if (next.status === "failed" && this.seq.isSameAuth(a))
			this.raise(
				next.error?.message ?? "The decision failed.",
				a.taskId,
				"Review the request's current state, then decide again with a fresh signature.",
			);
	}

	/** Human-readable decision status for a request (Decision status region). */
	decisionStatus(requestId: string): string {
		const a = this.state.attempts[requestId];
		if (!a) return "";
		switch (a.status) {
			case "in_flight":
				return a.sends > 1
					? "Checking the decision outcome…"
					: "Sending the decision…";
			case "unknown":
				return OUTCOME_UNKNOWN;
			case "committed":
				return a.decidedElsewhere
					? "This request was already decided (see Decision history)."
					: committedMessage(a.kind, a.action);
			case "failed":
				return a.error?.message ?? "The decision failed.";
		}
	}

	// ── drafts and task commands ────────────────────────────────────────────

	/** "Assign work": open an unsaved draft for a repo (a task is created on first save). */
	startComposing(repoId: string): void {
		// only an allowlisted repository can be assigned work (observed / unknown ones never)
		if (this.repoKind(repoId) !== "allowlisted") return;
		// the same unsaved composition keeps its key (an unknown create outcome must not mint a
		// second key → a second task)
		const keep =
			this.state.composing?.repoId === repoId ? this.state.composing : null;
		this.navigate({ view: "projects", repoId, taskId: null, requestId: null });
		this.set({
			composing: keep ?? { repoId, key: this.key("tk") },
			command: keep ? this.state.command : null,
		});
	}

	cancelComposing(): void {
		this.set({ composing: null });
	}

	private async runCommand(
		name: CommandName,
		taskId: string | null,
		call: () => Promise<TransportResult<WorkspaceTaskView>>,
		doneMessage: string,
		stillCurrent: () => boolean = () => this.state.route.taskId === taskId,
	): Promise<WorkspaceTaskView | null> {
		const gen = this.seq.authGen;
		this.set({
			command: { name, taskId, status: "busy", message: "Working…" },
		});
		const r = await call();
		if (!this.seq.isSameAuth({ authGen: gen })) return null;
		// the cache is always updated; the command line / alert only for the subject still shown
		const current = stillCurrent();
		if (r.ok) {
			const id = r.data.task.id;
			const prev = this.detail(id);
			if (!prev || !isOlderDetail(r.data, prev)) {
				this.setDetail(id, {
					data: detailFromView(prev, r.data),
					loading: false,
					error: null,
				});
				this.set({
					snapshot: foldTaskIntoSnapshot(this.state.snapshot, r.data),
				});
			}
			if (current)
				this.set({
					command: { name, taskId: id, status: "done", message: doneMessage },
					alert: null,
				});
			void this.loadSnapshot();
			void this.loadDetail(id);
			return r.data;
		}
		if (isUnauthenticated(r)) {
			this.onUnauthenticated({ authGen: gen });
			return null;
		}
		if (!current) {
			if (taskId) void this.loadDetail(taskId);
			return null;
		}
		if (r.kind === "http") {
			const msg = errorCopy(r.error.error, r.error.message);
			// the hub's issues verbatim, with paths read as "criterion N" / "check mapping N"
			const issues = r.error.issues
				?.map((i) => `${readableIssuePath(i.path)}: ${i.message}`)
				.join("; ");
			this.set({
				command: {
					name,
					taskId,
					status: "failed",
					message: issues ? `${msg} ${issues}` : msg,
				},
			});
			this.raise(issues ? `${msg} ${issues}` : msg, taskId);
		} else {
			this.set({
				command: {
					name,
					taskId,
					status: "unknown",
					message:
						"Outcome unknown (no answer). The task was reloaded; check it before repeating.",
				},
			});
			void this.loadSnapshot();
		}
		if (taskId) void this.loadDetail(taskId);
		return null;
	}

	/** First save of a composed draft: POST /tasks with the composition's stable key. */
	async createFromForm(form: DraftForm): Promise<string | null> {
		const c = this.state.composing;
		if (!c) return null;
		const built = draftFromForm(form);
		if (!built.ok) {
			this.set({
				command: {
					name: "create",
					taskId: null,
					status: "failed",
					message: built.issues.map((i) => i.message).join("; "),
				},
			});
			return null;
		}
		const view = await this.runCommand(
			"create",
			null,
			() =>
				this.transport.createTask({
					idempotency_key: c.key,
					repo_id: c.repoId,
					draft: built.draft,
				}),
			"Draft saved",
			() => this.state.composing?.key === c.key,
		);
		if (!view) return null;
		// the operator moved on while the create was in flight: never pull them back
		if (this.state.composing?.key !== c.key) return view.task.id;
		const done = this.state.command;
		this.set({ composing: null });
		this.navigate({
			view: "projects",
			repoId: view.task.repo_id,
			taskId: view.task.id,
			requestId: null,
		});
		// selecting the new task resets the command line; keep "Draft saved" for it
		this.set({ command: done });
		return view.task.id;
	}

	async saveDraft(taskId: string, form: DraftForm): Promise<boolean> {
		const d = this.detail(taskId);
		const built = draftFromForm(form);
		if (!d) return false;
		if (!built.ok) {
			this.set({
				command: {
					name: "save",
					taskId,
					status: "failed",
					message: built.issues.map((i) => i.message).join("; "),
				},
			});
			return false;
		}
		const view = await this.runCommand(
			"save",
			taskId,
			() =>
				this.transport.saveDraft(taskId, {
					expected_rev: d.task.rev,
					draft: built.draft,
				}),
			"Draft saved",
		);
		return view !== null;
	}

	/** Save first when the form has unsaved edits, then publish the stored draft (opens Gate 1). */
	async publish(taskId: string, form: DraftForm | null): Promise<boolean> {
		let d = this.detail(taskId);
		if (!d) return false;
		if (form && !formMatchesDraft(form, d.task.draft)) {
			if (!(await this.saveDraft(taskId, form))) return false;
			d = this.detail(taskId);
			if (!d) return false;
		}
		const rev = d.task.rev;
		const view = await this.runCommand(
			"publish",
			taskId,
			() => this.transport.publishProposal(taskId, { expected_rev: rev }),
			"Submitted for execution approval",
		);
		return view !== null;
	}

	async rerun(taskId: string): Promise<boolean> {
		const d = this.detail(taskId);
		if (!d?.task.current_proposal_id) return false;
		const proposalId = d.task.current_proposal_id;
		const view = await this.runCommand(
			"rerun",
			taskId,
			() =>
				this.transport.requestRerun(taskId, {
					expected_rev: d.task.rev,
					proposal_id: proposalId,
				}),
			"New run requested; it needs execution approval",
		);
		return view !== null;
	}

	async cancel(taskId: string): Promise<boolean> {
		const d = this.detail(taskId);
		if (!d) return false;
		const view = await this.runCommand(
			"cancel",
			taskId,
			() => this.transport.cancel(taskId, { expected_rev: d.task.rev }),
			"Cancellation recorded",
		);
		return view !== null;
	}
}
