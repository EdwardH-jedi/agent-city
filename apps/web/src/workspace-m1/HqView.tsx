// Headquarters (role 07): the approval inbox, the selected request's approval document with the
// gate controls, and the task's decision history. Gate controls are never inside a <form>; the
// signature field ignores Enter; Approve/Accept are natively disabled with reasons described.
import {
	type ApprovalRequestView,
	isProposalV1_2,
	type WorkspaceTaskDetail,
} from "@agent-city/schema/workspace-m1";
import { useId, useState } from "react";
import { Campus } from "./CampusSlot.tsx";
import { canRetry } from "./decision-attempt.ts";
import { EvidenceList, ResultSummary } from "./Evidence.tsx";
import { declineBlockers, grantBlockers } from "./gate.ts";
import {
	ACTION_LABEL,
	APPROVAL_STATUS_LABEL,
	acceptanceStatus,
	acceptedResultRequest,
	clockTime,
	dateTime,
	engineLabel,
	GATE_ATTR,
	GATE_HISTORY_NAME,
	GATE_NAME,
	GRANT_BUTTON,
	inboxItemName,
	isObsoleteGrant,
	OBSOLETE_GRANT_LABEL,
	OBSOLETE_GRANT_NOTE,
	OBSOLETE_GRANT_PENDING_NOTE,
	proposalVersionLabel,
	requestStatusLine,
	SIGNATURE_LABEL,
	shortHash,
} from "./labels.ts";
import {
	Chip,
	DECISION_STATUS_ID,
	focusById,
	KV,
	Mono,
	PANEL_TITLE_ID,
	ProposalView,
	ProvenanceChips,
	useWs,
} from "./parts.tsx";
import { inboxKey } from "./store.ts";
import {
	AcceptanceValidityBlock,
	freshnessOf,
	ValidityHistoryLine,
} from "./Validity.tsx";

type GateFilter = "all" | "run" | "result";

function titleOf(
	taskId: string,
	tasks: { task: { id: string; draft: { title: string } } }[],
): string {
	return tasks.find((t) => t.task.id === taskId)?.task.draft.title ?? "";
}

/** The repository of a task as the one cache knows it (detail first, else the snapshot row). */
function repoOf(
	taskId: string | null,
	d: WorkspaceTaskDetail | null,
	tasks: { task: { id: string; repo_id: string } }[],
): string | null {
	if (!taskId) return null;
	if (d?.task.id === taskId) return d.task.repo_id;
	return tasks.find((t) => t.task.id === taskId)?.task.repo_id ?? null;
}

function Inbox() {
	const { store, state } = useWs();
	// review repair APP-P2-02: a repository filter is a SERVER query (its own bounded pages); the
	// unfiltered view is the snapshot's first page plus explicit continuation pages. Search and the gate
	// filter of the unfiltered view apply to the loaded rows only — the disclosure line says so.
	// T0-RR-P3-01: the loaded filter comes from the collection's structured scope — the exact repository id,
	// whatever punctuation it holds (never recovered by splitting a key)
	const scoped = state.inbox?.scope ?? null;
	const [gate, setGate] = useState<GateFilter>(
		scoped?.repoId != null && scoped.kind !== null ? scoped.kind : "all",
	);
	const [repo, setRepo] = useState<string>(scoped?.repoId ?? "all");
	const [query, setQuery] = useState("");
	const id = useId();
	const tasks = state.snapshot?.tasks ?? [];
	const first = state.snapshot?.pending_requests ?? [];
	const firstPage = state.snapshot?.pending_page ?? null;
	const repoOf = (r: ApprovalRequestView) =>
		r.repo_id ??
		tasks.find((x) => x.task.id === r.workspace_task_id)?.task.repo_id ??
		null;
	const titleFor = (r: ApprovalRequestView) =>
		r.task_title ?? titleOf(r.workspace_task_id, tasks);
	const kind = gate === "all" ? null : gate;
	const filtered = repo !== "all";
	const box =
		state.inbox?.key ===
		inboxKey(filtered ? repo : null, filtered ? kind : null)
			? state.inbox
			: null;
	const loaded: ApprovalRequestView[] = filtered
		? (box?.items ?? [])
		: [
				...first,
				...(box?.items ?? []).filter((r) => !first.some((f) => f.id === r.id)),
			];
	const total = filtered
		? (box?.page?.total ?? null)
		: (firstPage?.total ?? first.length);
	const hasMore = filtered
		? (box?.page?.has_more ?? false)
		: box
			? (box.page?.has_more ?? false)
			: (firstPage?.has_more ?? false);
	const pick = (nextRepo: string, nextGate: GateFilter) => {
		setRepo(nextRepo);
		setGate(nextGate);
		if (nextRepo === "all") store.closeInbox();
		else void store.loadInbox(nextRepo, nextGate === "all" ? null : nextGate);
	};
	const more = () =>
		void store.loadInbox(filtered ? repo : null, filtered ? kind : null, true);
	// a failed FIRST filtered page is read again from the start; a failed later page continues its cursor
	const retry = () =>
		filtered && !box?.page?.next_cursor
			? void store.loadInbox(repo, kind)
			: more();
	const q = query.trim().toLowerCase();
	const items = loaded.filter((r) => {
		if (!filtered && gate !== "all" && r.kind !== gate) return false;
		if (!q) return true;
		return `${titleFor(r)} ${repoOf(r) ?? ""}`.toLowerCase().includes(q);
	});
	const repos = state.snapshot?.repos ?? [];
	const pendingIn = (repoId: string) =>
		state.snapshot?.repo_summaries?.find((x) => x.repo_id === repoId)
			?.pending_requests;
	const disclosure = filtered
		? box?.status === "loading" && !box.page
			? `Loading the pending requests of ${repo}…`
			: box?.page
				? `Showing ${loaded.length} of ${box.page.total} pending in ${repo}${kind ? ` (${kind === "run" ? "execution approval" : "result acceptance"})` : ""} · read at ${clockTime(box.page.as_of)}.`
				: ""
		: `Showing ${loaded.length} of ${total} pending across all repositories${hasMore ? " — load more to see the rest" : ""}.${gate !== "all" || q ? " Gate and search filters apply to the loaded rows." : ""}`;
	return (
		<section
			aria-label="Approval inbox"
			className="wsm1-card wsm1-inbox"
			data-inbox-scope={filtered ? repo : "all"}
		>
			<div className="wsm1-card-head">
				<h2>Approval inbox</h2>
				<span className="wsm1-muted" data-testid="inbox-total">
					{firstPage?.total ?? first.length} pending
				</span>
			</div>
			<div className="wsm1-filters">
				<label htmlFor={`${id}-gate`}>Gate</label>
				<select
					id={`${id}-gate`}
					value={gate}
					onChange={(e) => pick(repo, e.target.value as GateFilter)}
				>
					<option value="all">All gates</option>
					<option value="run">Execution approval</option>
					<option value="result">Result acceptance</option>
				</select>
				<label htmlFor={`${id}-repo`}>Repository</label>
				<select
					id={`${id}-repo`}
					value={repo}
					onChange={(e) => pick(e.target.value, gate)}
				>
					<option value="all">All repositories</option>
					{repos.map((r) => {
						const n = pendingIn(r.repo_id);
						return (
							<option key={r.repo_id} value={r.repo_id}>
								{r.repo_id}
								{n !== undefined ? ` (${n} pending)` : ""}
							</option>
						);
					})}
				</select>
				<label htmlFor={`${id}-q`}>Search</label>
				<input
					id={`${id}-q`}
					type="search"
					value={query}
					autoComplete="off"
					onChange={(e) => setQuery(e.target.value)}
				/>
			</div>
			<p
				className="wsm1-hint"
				data-testid="inbox-disclosure"
				aria-live="polite"
			>
				{disclosure}
			</p>
			{items.length === 0 ? (
				<p className="wsm1-muted">
					{box?.status === "loading"
						? "Loading…"
						: total === 0
							? "Nothing awaits a decision."
							: "No loaded pending request matches the filter."}
				</p>
			) : (
				<ul className="wsm1-list">
					{items.map((r) => {
						const repoId = repoOf(r);
						const selected = state.route.requestId === r.id;
						return (
							<li key={r.id}>
								<button
									type="button"
									className="wsm1-item"
									data-request-id={r.id}
									data-gate={GATE_ATTR[r.kind]}
									data-repo-id={repoId ?? undefined}
									aria-current={selected ? "true" : undefined}
									onClick={() =>
										store.navigate({
											view: "hq",
											repoId: null,
											taskId: r.workspace_task_id,
											requestId: r.id,
										})
									}
								>
									<span className="wsm1-item-title wsm1-wrap">
										{inboxItemName(r, titleFor(r))}
									</span>
									<span className="wsm1-muted wsm1-wrap">
										<span data-testid="inbox-repo">
											{repoId ?? "repository unknown"}
										</span>{" "}
										· waiting since {dateTime(r.created_at)}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			)}
			{box?.status === "error" ? (
				<p role="alert" className="wsm1-error-text" data-testid="inbox-error">
					{box.error} The requests already shown stay as they were read.{" "}
					<button type="button" onClick={retry}>
						Retry
					</button>
				</p>
			) : null}
			{hasMore ? (
				<button
					type="button"
					data-testid="inbox-load-more"
					disabled={box?.status === "loading"}
					onClick={more}
				>
					Load more pending requests
				</button>
			) : null}
		</section>
	);
}

/**
 * A pending Gate-1 request bound to a legacy (v1) proposal: the hub refuses every decision on it
 * (obsolete-v1 grant policy) and retires it; the UI says so before any attempt.
 */
function pendingObsolete(
	d: WorkspaceTaskDetail | null,
	r: ApprovalRequestView,
): boolean {
	return (
		r.kind === "run" &&
		r.status === "pending" &&
		d?.current_proposal?.id === r.proposal_id &&
		!isProposalV1_2(d.current_proposal.snapshot)
	);
}

function DecisionHistory() {
	const { store, state } = useWs();
	const d = store.detail(state.route.taskId);
	const freshness = d ? freshnessOf(d.acceptance_validity, state.conn) : null;
	// one announced alert per view: the document announces it when it shows this acceptance
	const docShowsValidity =
		d !== null &&
		state.route.requestId !== null &&
		acceptedResultRequest(d)?.id === state.route.requestId;
	return (
		<section aria-label="Decision history" className="wsm1-card wsm1-history">
			<div className="wsm1-card-head">
				<h2>Decision history</h2>
				{d ? (
					<span className="wsm1-muted wsm1-wrap">{d.task.draft.title}</span>
				) : null}
			</div>
			{!d ? (
				<p className="wsm1-muted">
					Select a request to see its task's history.
				</p>
			) : d.decisions.length === 0 &&
				d.approval_requests.every((r) => r.status === "pending") ? (
				<p className="wsm1-muted">No decision yet.</p>
			) : (
				<ul className="wsm1-history-list">
					{d.decisions.map((x) => {
						const req = d.approval_requests.find(
							(r) => r.id === x.approval_request_id,
						);
						const version = req ? proposalVersionLabel(d, req.proposal_id) : "";
						const bound =
							x.kind === "result" && x.result_envelope_hash
								? `result ${shortHash(x.result_envelope_hash)}${version ? ` · ${version}` : ""}`
								: version;
						return (
							<li key={x.id} data-decision-id={x.id}>
								<span>
									{x.operator_id} · {GATE_HISTORY_NAME[x.kind]} ·{" "}
									{ACTION_LABEL[x.action]} · {bound}
								</span>
								<span className="wsm1-muted">{dateTime(x.decided_at)}</span>
								{x.reason ? (
									<span className="wsm1-muted">Reason: {x.reason}</span>
								) : null}
								{req && req.status === "invalidated" ? (
									<span>Later invalidated: {requestStatusLine(req)}</span>
								) : null}
								{x.kind === "result" &&
								x.action === "accept" &&
								req?.status === "accepted" ? (
									<ValidityHistoryLine
										validity={d.acceptance_validity}
										freshness={freshness}
										announce={!docShowsValidity}
									/>
								) : null}
							</li>
						);
					})}
					{d.approval_requests
						.filter((r) => r.status === "invalidated")
						.map((r) => (
							<li key={r.id} data-request-id={r.id}>
								<span>
									{GATE_NAME[r.kind]} · {proposalVersionLabel(d, r.proposal_id)}{" "}
									· {requestStatusLine(r)}
								</span>
								<span className="wsm1-muted">
									{r.closed_at ? dateTime(r.closed_at) : ""}
								</span>
							</li>
						))}
				</ul>
			)}
		</section>
	);
}

function GateControls({
	request,
	obsolete = false,
}: {
	request: ApprovalRequestView;
	/** Bound to an obsolete v1 proposal: approving is impossible (the hub refuses it). */
	obsolete?: boolean;
}) {
	const { store, state } = useWs();
	const g = state.gate;
	const ctx = store.gateContext();
	const id = useId();
	if (!g || g.requestId !== request.id || !ctx) return null;
	const grant = obsolete
		? [OBSOLETE_GRANT_LABEL, ...grantBlockers(g, ctx)]
		: grantBlockers(g, ctx);
	const decline = declineBlockers(g, ctx);
	const attempt = state.attempts[request.id];
	const interactive = ctx.canDecide && ctx.online && !ctx.busy && ctx.pending;
	const act = async (
		action: "approve" | "accept" | "request_changes" | "reject",
	) => {
		focusById(DECISION_STATUS_ID);
		await store.decide(action);
	};
	return (
		<div className="wsm1-gate">
			{g.notice ? (
				<p className="wsm1-notice" id={`${id}-notice`}>
					{g.notice}
				</p>
			) : null}
			<div className="wsm1-gate-row">
				<div className="wsm1-field wsm1-signature">
					<label htmlFor={`${id}-sig`}>{SIGNATURE_LABEL[request.kind]}</label>
					<input
						id={`${id}-sig`}
						type="text"
						autoComplete="off"
						spellCheck={false}
						autoCapitalize="off"
						autoCorrect="off"
						value={g.signature}
						disabled={!interactive}
						aria-describedby={g.notice ? `${id}-notice` : undefined}
						onChange={(e) => store.setSignature(e.target.value)}
						onKeyDown={(e) => {
							// Enter / NumpadEnter / Ctrl+Enter never decide anything
							if (e.key === "Enter") e.preventDefault();
						}}
					/>
				</div>
				<button
					type="button"
					className="wsm1-primary"
					disabled={grant.length > 0}
					aria-describedby={`${id}-grant-why`}
					onClick={() =>
						void act(request.kind === "run" ? "approve" : "accept")
					}
				>
					{GRANT_BUTTON[request.kind]}
				</button>
			</div>
			<ul id={`${id}-grant-why`} className="wsm1-why">
				{grant.map((m) => (
					<li key={m}>{m}</li>
				))}
			</ul>
			<div className="wsm1-gate-row">
				<div className="wsm1-field wsm1-reason">
					<label htmlFor={`${id}-reason`}>Decision reason</label>
					<textarea
						id={`${id}-reason`}
						rows={2}
						maxLength={1000}
						value={g.reason}
						disabled={!interactive}
						onChange={(e) => store.setReason(e.target.value)}
					/>
				</div>
				<div className="wsm1-gate-buttons">
					<button
						type="button"
						disabled={decline.length > 0}
						aria-describedby={`${id}-decline-why`}
						onClick={() => void act("request_changes")}
					>
						Request changes
					</button>
					<button
						type="button"
						className="wsm1-danger"
						disabled={decline.length > 0}
						aria-describedby={`${id}-decline-why`}
						onClick={() => void act("reject")}
					>
						Reject
					</button>
				</div>
			</div>
			<ul id={`${id}-decline-why`} className="wsm1-why">
				{decline.map((m) => (
					<li key={m}>{m}</li>
				))}
			</ul>
			{canRetry(attempt) ? (
				<button
					type="button"
					onClick={() => void store.retryDecision(request.id)}
				>
					Check decision outcome
				</button>
			) : null}
		</div>
	);
}

/** What Gate 1 means for THIS request, by its status (truthful after the decision too). */
function runRequestNote(status: ApprovalRequestView["status"]): string {
	switch (status) {
		case "pending":
			return "Approving queues exactly one bounded, simulated execution of this proposal version. Nothing has run yet.";
		case "approved":
			return "Approved: exactly one bounded, simulated execution of this proposal version was queued. Its progress is on the task.";
		case "invalidated":
			return "This request lost its authority before a decision; nothing was queued under it.";
		default:
			return "Not approved: nothing was queued under this request.";
	}
}

function ApprovalDocument() {
	const { store, state } = useWs();
	const { taskId, requestId } = state.route;
	const request = store.findRequest(taskId, requestId);
	const d = store.detail(taskId);
	if (!requestId || !request)
		return (
			<section aria-label="Approval document" className="wsm1-panel">
				<div className="wsm1-panel-head">
					<h2 id={PANEL_TITLE_ID} tabIndex={-1}>
						{requestId ? "Loading request…" : "No request selected"}
					</h2>
				</div>
				<div className="wsm1-panel-body">
					<p className="wsm1-muted">
						{requestId
							? "Reading the request from the workspace."
							: (state.routeNotice ??
								"Open one request from the inbox. Only one request is open at a time.")}
					</p>
				</div>
			</section>
		);
	const title =
		(d?.current_proposal?.id === request.proposal_id
			? d.current_proposal.snapshot.title
			: null) ??
		titleOf(request.workspace_task_id, state.snapshot?.tasks ?? []);
	const proposal =
		d?.current_proposal && d.current_proposal.id === request.proposal_id
			? d.current_proposal
			: null;
	const decision = d?.decisions.find(
		(x) => x.approval_request_id === request.id,
	);
	const receipt = store.committedReceipt(request);
	const acc = d ? acceptanceStatus(d) : "none";
	const obsoleteRecord = isObsoleteGrant(request);
	const obsoletePending = pendingObsolete(d, request);
	const repoId = repoOf(
		request.workspace_task_id,
		d,
		state.snapshot?.tasks ?? [],
	);
	return (
		<section
			aria-label="Approval document"
			className="wsm1-panel"
			data-request-id={request.id}
			data-gate={GATE_ATTR[request.kind]}
			data-request-status={request.status}
			data-rev={request.rev}
		>
			<div className="wsm1-panel-head">
				<h2 id={PANEL_TITLE_ID} tabIndex={-1} className="wsm1-wrap">
					{GATE_NAME[request.kind]} · {title || "Untitled task"}
				</h2>
				<div className="wsm1-identity">
					<span className="wsm1-repo-label">
						Repository{" "}
						<strong data-testid="document-repo" className="wsm1-wrap">
							{repoId ?? "unknown"}
						</strong>
					</span>
					{proposal ? (
						<span>
							Proposal v
							<span data-testid="proposal-version">{proposal.version}</span>
						</span>
					) : (
						<span>
							{d
								? proposalVersionLabel(d, request.proposal_id)
								: `Bound proposal …${request.proposal_id.slice(-8)}`}
						</span>
					)}
					<ProvenanceChips snapshot={state.snapshot} source={state.source} />
					{repoId ? (
						<button
							type="button"
							className="wsm1-link-button"
							onClick={() =>
								store.navigate({
									view: "projects",
									repoId,
									taskId: request.workspace_task_id,
									requestId: null,
								})
							}
						>
							Open task in Projects
						</button>
					) : null}
				</div>
				<dl className="wsm1-status-row">
					<KV label="Request">
						<Chip
							tone={
								request.status === "pending"
									? "waiting"
									: request.status === "invalidated"
										? "bad"
										: "neutral"
							}
						>
							{requestStatusLine(request)}
						</Chip>
					</KV>
					{request.kind === "result" && d?.engine ? (
						<KV label="Engine">
							<Chip
								tone="neutral"
								testId="engine-state"
								data={{ state: d.engine.state }}
							>
								{engineLabel(d.engine.state, acc)}
							</Chip>
						</KV>
					) : null}
					{request.kind === "result" ? (
						<KV label="Acceptance">
							<Chip
								tone={
									acc === "accepted"
										? "ok"
										: acc === "pending"
											? "waiting"
											: "neutral"
								}
								testId="acceptance-status"
								data={{ status: acc }}
							>
								{acc === "none" ? "No result yet" : APPROVAL_STATUS_LABEL[acc]}
							</Chip>
						</KV>
					) : null}
				</dl>
				{request.kind === "result" && request.status === "accepted" && d ? (
					<AcceptanceValidityBlock
						detail={d}
						freshness={freshnessOf(d.acceptance_validity, state.conn)}
					/>
				) : null}
			</div>
			<div className="wsm1-panel-body">
				{request.kind === "run" ? (
					<>
						{obsoleteRecord || obsoletePending ? (
							<p
								className="wsm1-banner wsm1-tone-neutral wsm1-obsolete-grant"
								data-testid="obsolete-grant"
								data-status={obsoleteRecord ? "retired" : "pending"}
							>
								{obsoleteRecord
									? OBSOLETE_GRANT_NOTE
									: OBSOLETE_GRANT_PENDING_NOTE}
							</p>
						) : (
							<p className="wsm1-note">{runRequestNote(request.status)}</p>
						)}
						{proposal ? (
							<ProposalView
								proposal={proposal}
								heading="Proposal under review"
							/>
						) : (
							<p className="wsm1-banner wsm1-tone-waiting">
								This request binds a proposal version that is no longer current.
							</p>
						)}
					</>
				) : (
					<>
						<ResultSummary request={request} detail={d} />
						{d ? <EvidenceList detail={d} /> : null}
						{proposal ? (
							<details className="wsm1-block">
								<summary>
									Proposal v{proposal.version} (what was approved)
								</summary>
								<ProposalView
									proposal={proposal}
									heading={`Proposal v${proposal.version}`}
								/>
							</details>
						) : null}
					</>
				)}
				<div className="wsm1-block">
					<h3>Binding</h3>
					<dl className="wsm1-kvs wsm1-ids">
						<KV label="Request">
							<Mono value={request.id} />
						</KV>
						<KV label="Binding hash">
							<Mono value={request.binding_hash} />
						</KV>
						<KV label="Execution binding">
							<Mono value={request.execution_binding_hash} />
						</KV>
						<KV label="Opened">{dateTime(request.created_at)}</KV>
					</dl>
				</div>
			</div>
			<div className="wsm1-panel-foot">
				{request.status === "pending" && receipt ? (
					// P2 F-03: our decision is committed (the hub's receipt names this exact request); the
					// confirmation controls close now, not when the follow-up reads arrive
					<p className="wsm1-hint" data-testid="decision-receipt">
						This request is{" "}
						{APPROVAL_STATUS_LABEL[
							receipt.approval_request.status
						].toLowerCase()}{" "}
						· {receipt.operator_id} · {ACTION_LABEL[receipt.action]} ·{" "}
						{dateTime(receipt.decided_at)} (from the hub's decision receipt; the
						request record is being refreshed). No further decision is possible
						on it.
					</p>
				) : request.status === "pending" ? (
					<GateControls request={request} obsolete={obsoletePending} />
				) : (
					<p className="wsm1-hint">
						This request is{" "}
						{requestStatusLine(request).replace(/\.$/, "").toLowerCase()}
						{decision
							? ` · ${decision.operator_id} · ${ACTION_LABEL[decision.action]} · ${dateTime(decision.decided_at)}`
							: ""}
						. No further decision is possible on it.
					</p>
				)}
				<output
					aria-label="Decision status"
					id={DECISION_STATUS_ID}
					tabIndex={-1}
					className="wsm1-decision-status"
				>
					{store.decisionStatus(request.id)}
				</output>
			</div>
		</section>
	);
}

export function HqView() {
	return (
		<div className="wsm1-split">
			<div className="wsm1-left">
				<Campus />
				<Inbox />
				<DecisionHistory />
			</div>
			<ApprovalDocument />
		</div>
	);
}
