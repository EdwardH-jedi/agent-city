// Region "Task detail" (role 07): identity/status header, draft editor or proposal, execution
// monitoring, evidence, approval record, and the stage's actions. No <form>: Enter never submits.
import type {
	WorkspaceDraft,
	WorkspaceTaskDetail,
} from "@agent-city/schema/workspace-m1";
import {
	isDraftEditable,
	isProposalV1_2,
} from "@agent-city/schema/workspace-m1";
import { useEffect, useId, useRef, useState } from "react";
import { TaskCoverage } from "./Coverage.tsx";
import {
	checksFor,
	type DraftForm,
	formCriteria,
	formFromDraft,
	newDraftForm,
	publishIssues,
	SCENARIOS,
	toggleCheck,
	unmappedCriteria,
} from "./draft-form.ts";
import { EvidenceList } from "./Evidence.tsx";
import {
	APPROVAL_STATUS_LABEL,
	acceptanceStatus,
	cancellationStatus,
	dateTime,
	engineAheadNote,
	engineLabel,
	failureLabel,
	GATE_NAME,
	isClosed,
	nextAction,
	PHASE_LABEL,
	PHASE_TONE,
	proposalVersionLabel,
	requestStatusLine,
	shortHash,
	UNMAPPED_HINT,
} from "./labels.ts";
import {
	Chip,
	focusById,
	KV,
	Mono,
	PANEL_TITLE_ID,
	ProposalView,
	ProvenanceChips,
	useWs,
} from "./parts.tsx";
import { AcceptanceValidityBlock, freshnessOf } from "./Validity.tsx";

function EmptyPanel({ title, text }: { title: string; text: string }) {
	return (
		<section aria-label="Task detail" className="wsm1-panel">
			<div className="wsm1-panel-head">
				<h2 id={PANEL_TITLE_ID} tabIndex={-1}>
					{title}
				</h2>
			</div>
			<div className="wsm1-panel-body">
				<p className="wsm1-muted">{text}</p>
			</div>
		</section>
	);
}

export function TaskPanel() {
	const { state } = useWs();
	const { route, composing } = state;
	if (!route.taskId && composing && composing.repoId === route.repoId)
		return <ComposePanel repoId={composing.repoId} />;
	if (!route.taskId)
		return (
			<EmptyPanel
				title="No task selected"
				text={
					state.routeNotice ??
					"Select a task, or choose a repository and Assign work."
				}
			/>
		);
	const entry = state.details[route.taskId];
	if (!entry?.data)
		return (
			<EmptyPanel
				title={entry?.error ? "Task unavailable" : "Loading task…"}
				text={entry?.error ?? "Reading the task from the workspace."}
			/>
		);
	return <TaskDetail key={entry.data.task.id} d={entry.data} />;
}

// ── draft editor ────────────────────────────────────────────────────────────

/** The repository's trusted checks (snapshot `repos[]`), or null while unknown. */
function repoChecks(
	snapshot: { repos: { repo_id: string; required_checks: string[] }[] } | null,
	repoId: string,
): readonly string[] | null {
	return (
		snapshot?.repos.find((r) => r.repo_id === repoId)?.required_checks ?? null
	);
}

/**
 * v1.2 criterion → check mapping (CONTRACT_V1_2.md §A): one group per criterion line
 * (`Checks for criterion N`, one checkbox per trusted check). Keyed by the exact line text; an
 * edited line is a new criterion and starts unmapped. Nothing is preselected (never inferred).
 */
function CriterionChecksEditor({
	form,
	setForm,
	checks,
}: {
	form: DraftForm;
	setForm: (f: DraftForm) => void;
	checks: readonly string[] | null;
}) {
	const id = useId();
	const criteria = formCriteria(form);
	const unmapped = unmappedCriteria(form);
	return (
		<section
			aria-labelledby={`${id}-head`}
			className="wsm1-critmaps"
			data-testid="criterion-mapping"
			data-unmapped={unmapped.length}
		>
			<h4 id={`${id}-head`}>Criterion checks</h4>
			<p className="wsm1-hint">
				{UNMAPPED_HINT} A criterion counts as covered only if every check you
				select for it passes with its log in the sealed evidence.
			</p>
			{checks === null ? (
				<p className="wsm1-muted">Loading the repository's trusted checks…</p>
			) : criteria.length === 0 ? (
				<p className="wsm1-muted">
					Add criteria above; each line gets its own check mapping.
				</p>
			) : (
				<>
					<output className="wsm1-hint" aria-live="polite">
						{unmapped.length === 0
							? `All ${criteria.length} criteria are mapped.`
							: `${unmapped.length} of ${criteria.length} criteria have no check: ${unmapped.map((u) => u.n).join(", ")}.`}
					</output>
					{criteria.map((c, i) => {
						const mine = checksFor(form, c);
						const textId = `${id}-c${i}`;
						return (
							<fieldset
								// biome-ignore lint/suspicious/noArrayIndexKey: one group per line position
								key={`${i}-${c}`}
								className={`wsm1-critmap${mine.length === 0 ? " wsm1-critmap-missing" : ""}`}
								data-criterion-index={i + 1}
								data-mapped={mine.length > 0 ? "true" : "false"}
								aria-describedby={textId}
							>
								<legend>Checks for criterion {i + 1}</legend>
								<p id={textId} className="wsm1-critmap-text wsm1-wrap">
									{c}
								</p>
								<div className="wsm1-critmap-boxes">
									{checks.map((ch) => (
										<label key={ch}>
											<input
												type="checkbox"
												checked={mine.includes(ch)}
												onChange={(e) =>
													setForm(
														toggleCheck(form, c, ch, e.target.checked, checks),
													)
												}
											/>
											{ch}
										</label>
									))}
								</div>
								{mine.length === 0 ? (
									<p className="wsm1-critmap-note">No check selected yet.</p>
								) : null}
							</fieldset>
						);
					})}
				</>
			)}
		</section>
	);
}

function DraftEditor({
	form,
	setForm,
	saved,
	checks,
}: {
	form: DraftForm;
	setForm: (f: DraftForm) => void;
	saved: WorkspaceDraft | null;
	checks: readonly string[] | null;
}) {
	const id = useId();
	const set = <K extends keyof DraftForm>(k: K, v: DraftForm[K]) =>
		setForm({ ...form, [k]: v });
	return (
		<div className="wsm1-block wsm1-editor">
			<h3>Draft</h3>
			<div className="wsm1-field">
				<label htmlFor={`${id}-title`}>Title</label>
				<input
					id={`${id}-title`}
					type="text"
					value={form.title}
					maxLength={120}
					onChange={(e) => set("title", e.target.value)}
				/>
			</div>
			<div className="wsm1-field">
				<label htmlFor={`${id}-objective`}>Objective</label>
				<textarea
					id={`${id}-objective`}
					rows={4}
					value={form.objective}
					onChange={(e) => set("objective", e.target.value)}
				/>
			</div>
			<div className="wsm1-field">
				<label htmlFor={`${id}-criteria`}>Acceptance criteria</label>
				<textarea
					id={`${id}-criteria`}
					rows={5}
					aria-describedby={`${id}-criteria-hint`}
					value={form.criteriaText}
					onChange={(e) => set("criteriaText", e.target.value)}
				/>
				<p id={`${id}-criteria-hint`} className="wsm1-hint">
					One criterion per line. Commas stay inside a criterion.
				</p>
			</div>
			<CriterionChecksEditor form={form} setForm={setForm} checks={checks} />
			<div className="wsm1-field-row">
				<div className="wsm1-field">
					<label htmlFor={`${id}-allowed`}>Allowed paths</label>
					<textarea
						id={`${id}-allowed`}
						rows={2}
						aria-describedby={`${id}-allowed-hint`}
						value={form.allowedText}
						onChange={(e) => set("allowedText", e.target.value)}
					/>
					<p id={`${id}-allowed-hint`} className="wsm1-hint">
						One path prefix per line; “.” is the whole repository.
					</p>
				</div>
				<div className="wsm1-field">
					<label htmlFor={`${id}-protected`}>Protected paths</label>
					<textarea
						id={`${id}-protected`}
						rows={2}
						value={form.protectedText}
						onChange={(e) => set("protectedText", e.target.value)}
					/>
				</div>
			</div>
			<div className="wsm1-field-row">
				<fieldset
					// biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: MATRIX §7 requires role radiogroup (a fieldset alone is role group)
					role="radiogroup"
					aria-labelledby={`${id}-repair`}
					className="wsm1-radios"
				>
					<legend id={`${id}-repair`}>Repair policy</legend>
					<label>
						<input
							type="radio"
							name={`${id}-repair-policy`}
							checked={form.maxRepairs === 0}
							onChange={() => set("maxRepairs", 0)}
						/>
						No automatic repair
					</label>
					<label>
						<input
							type="radio"
							name={`${id}-repair-policy`}
							checked={form.maxRepairs === 1}
							onChange={() => set("maxRepairs", 1)}
						/>
						Allow one repair
					</label>
				</fieldset>
				<div className="wsm1-field">
					<label htmlFor={`${id}-scenario`}>Simulation scenario</label>
					<select
						id={`${id}-scenario`}
						value={form.scenario}
						aria-describedby={`${id}-scenario-hint`}
						onChange={(e) =>
							set("scenario", e.target.value as DraftForm["scenario"])
						}
					>
						{SCENARIOS.map((s) => (
							<option key={s} value={s}>
								{s.replaceAll("_", " ")}
							</option>
						))}
					</select>
					<p id={`${id}-scenario-hint`} className="wsm1-hint">
						Simulated mode only: chooses what the fake providers do. It is part
						of the proposal Edward approves.
					</p>
				</div>
			</div>
			<p className="wsm1-hint">
				Execution mode: Simulated. Live execution is disabled in this milestone.
			</p>
			{saved ? (
				<div className="wsm1-saved">
					<h4>Saved draft</h4>
					<ol aria-label="Acceptance criteria" className="wsm1-criteria">
						{saved.criteria.map((c, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: positional list
							<li key={i}>{c}</li>
						))}
					</ol>
				</div>
			) : null}
		</div>
	);
}

function IssuesList({
	id,
	form,
	checks,
}: {
	id: string;
	form: DraftForm;
	checks: readonly string[] | null;
}) {
	const issues = publishIssues(form, checks);
	if (issues.length === 0) return null;
	return (
		<ul id={id} className="wsm1-why">
			{issues.map((i) => (
				<li key={`${i.field}-${i.message}`}>
					{i.field === "form" ? "" : `${FIELD_NAME[i.field]}: `}
					{i.message}
				</li>
			))}
		</ul>
	);
}

const FIELD_NAME: Record<keyof DraftForm, string> = {
	title: "Title",
	objective: "Objective",
	criteriaText: "Acceptance criteria",
	allowedText: "Allowed paths",
	protectedText: "Protected paths",
	scenario: "Simulation scenario",
	maxRepairs: "Repair policy",
	criterionChecks: "Criterion check mapping",
};

function SaveStatus({ taskId }: { taskId: string | null }) {
	const { state } = useWs();
	const c = state.command;
	const mine =
		c &&
		(c.name === "save" || c.name === "create") &&
		(c.taskId === taskId || (c.name === "create" && taskId === null));
	return (
		<output aria-label="Save status" className="wsm1-save-status">
			{mine ? c.message : ""}
		</output>
	);
}

function ComposePanel({ repoId }: { repoId: string }) {
	const { store, state } = useWs();
	const [form, setForm] = useState<DraftForm>(newDraftForm);
	const why = useId();
	const busy = state.command?.status === "busy";
	const checks = repoChecks(state.snapshot, repoId);
	return (
		<section aria-label="Task detail" className="wsm1-panel">
			<div className="wsm1-panel-head">
				<h2 id={PANEL_TITLE_ID} tabIndex={-1}>
					New task · {repoId}
				</h2>
				<div className="wsm1-identity">
					<span>Unsaved draft</span>
					<ProvenanceChips snapshot={state.snapshot} source={state.source} />
				</div>
			</div>
			<div className="wsm1-panel-body">
				<DraftEditor
					form={form}
					setForm={setForm}
					saved={null}
					checks={checks}
				/>
			</div>
			<div className="wsm1-panel-foot">
				<div className="wsm1-actions">
					<button
						type="button"
						className="wsm1-primary"
						disabled={busy}
						onClick={() => void store.createFromForm(form)}
					>
						Save draft
					</button>
					<button
						type="button"
						disabled={busy || publishIssues(form, checks).length > 0}
						aria-describedby={why}
						onClick={async () => {
							const id = await store.createFromForm(form);
							if (id) {
								await store.publish(id, null);
								focusById(PANEL_TITLE_ID);
							}
						}}
					>
						Submit for run approval
					</button>
					<button type="button" onClick={() => store.cancelComposing()}>
						Discard draft
					</button>
				</div>
				<IssuesList id={why} form={form} checks={checks} />
				<SaveStatus taskId={null} />
			</div>
		</section>
	);
}

// ── task detail ─────────────────────────────────────────────────────────────

function TaskDetail({ d }: { d: WorkspaceTaskDetail }) {
	const { store, state } = useWs();
	const stage = d.task.stage;
	const closed = isClosed(stage);
	const startsEditing =
		!closed &&
		(stage === "changes_requested" ||
			(stage === "draft" && d.current_proposal === null));
	const [editing, setEditing] = useState(startsEditing);
	// changes requested → the operator edits next; a closed task is never editable
	useEffect(() => {
		if (stage === "changes_requested") setEditing(true);
		if (isClosed(stage)) setEditing(false);
	}, [stage]);
	// a newly published proposal (also from the compose panel's Submit) ends the edit: show it
	const proposalId = d.current_proposal?.id ?? null;
	const seenProposal = useRef(proposalId);
	useEffect(() => {
		if (proposalId !== null && proposalId !== seenProposal.current)
			setEditing(false);
		seenProposal.current = proposalId;
	}, [proposalId]);
	const [form, setForm] = useState<DraftForm>(() =>
		formFromDraft(d.task.draft),
	);
	const why = useId();
	const checks = repoChecks(state.snapshot, d.task.repo_id);
	const engine = d.engine;
	const acc = acceptanceStatus(d);
	const cancel = cancellationStatus(d.task, engine);
	const busy = state.command?.status === "busy";
	const canDecide = store.canDecide();
	const online = state.conn.status !== "offline";
	const writable = canDecide && online && !busy;
	const pendingRun = d.approval_requests.find(
		(r) => r.kind === "run" && r.status === "pending",
	);
	const pendingResult = d.approval_requests.find(
		(r) => r.kind === "result" && r.status === "pending",
	);
	const approvedExecution =
		engine &&
		d.approval_requests.some(
			(r) =>
				r.kind === "run" &&
				r.status === "approved" &&
				r.managed_task_id === engine.managed_task_id,
		);
	const currentRun = d.runs
		.filter((r) => r.managed_task_id === engine?.managed_task_id)
		.at(-1);
	const resultReq = d.approval_requests.find((r) => r.kind === "result");
	const candidate =
		resultReq?.result_envelope?.candidate_sha ??
		[...d.runs].reverse().find((r) => r.candidate_sha)?.candidate_sha ??
		null;
	const proposal = d.current_proposal;
	const attemptsUsed = d.runs.filter(
		(r) => r.managed_task_id === engine?.managed_task_id,
	).length;
	const failure = failureLabel(engine?.failure_kind ?? null);
	// a legacy (v1) proposal cannot run again (the hub refuses it): publish a new version instead
	const canRerun =
		(stage === "execution_ended" ||
			stage === "cancelled" ||
			stage === "draft") &&
		proposal !== null &&
		isProposalV1_2(proposal.snapshot) &&
		!engine?.quarantined;
	const cmdMsg =
		state.command &&
		state.command.taskId === d.task.id &&
		state.command.name !== "save" &&
		state.command.name !== "create"
			? state.command.message
			: null;

	const openGate = (requestId: string) =>
		store.navigate({
			view: "hq",
			repoId: null,
			taskId: d.task.id,
			requestId,
		});

	const assignmentBlock =
		editing && isDraftEditable(stage) ? (
			<>
				{proposal ? (
					<p className="wsm1-note">
						Editing the draft. Proposal v{proposal.version} stays as submitted;
						submitting creates v{proposal.version + 1} and needs a new execution
						approval.
					</p>
				) : null}
				<DraftEditor
					form={form}
					setForm={setForm}
					saved={d.task.draft}
					checks={checks}
				/>
			</>
		) : proposal ? (
			<ProposalView
				proposal={proposal}
				heading={`Proposal v${proposal.version}`}
			/>
		) : null;
	const executionBlock = engine ? (
		<section aria-labelledby={`${why}-exec`} className="wsm1-block">
			<h3 id={`${why}-exec`}>Execution</h3>
			<dl className="wsm1-kvs">
				<KV label="Execution">
					{approvedExecution ? (
						<Mono value={engine.managed_task_id} testId="execution-id" />
					) : (
						<span>
							Reserved, not approved to run (…
							{engine.managed_task_id.slice(-8)})
						</span>
					)}
				</KV>
				{currentRun ? (
					<KV label="Current attempt">
						<code
							className="wsm1-mono"
							data-testid="attempt-id"
							data-attempt-number={currentRun.attempt_no}
						>
							{currentRun.run_id}
						</code>{" "}
						(attempt {currentRun.attempt_no}, {currentRun.kind}, phase{" "}
						{currentRun.phase})
					</KV>
				) : null}
				{candidate ? (
					<KV label="Candidate">
						<Mono value={candidate} testId="candidate-sha" />
					</KV>
				) : null}
				{proposal ? (
					<KV label="Repair allowance">
						{proposal.snapshot.repair_policy.max_repairs === 0
							? "none (no automatic repair)"
							: `${Math.max(0, proposal.snapshot.repair_policy.max_repairs - Math.max(0, attemptsUsed - 1))} of 1 remaining`}
					</KV>
				) : null}
				<KV label="Providers">fake implementer · fake reviewer (simulated)</KV>
				{engine.cancel_requested_at ? (
					<KV label="Cancel requested">
						{dateTime(engine.cancel_requested_at)}
					</KV>
				) : null}
			</dl>
			{d.runs.length > 0 ? (
				<ol className="wsm1-attempts" aria-label="Attempts">
					{d.runs.map((r) => (
						<li key={r.run_id}>
							<strong>Attempt {r.attempt_no}</strong> · {r.kind} · {r.state} ·{" "}
							{r.phase}
							{r.outcome ? ` · review ${r.outcome}` : ""}
							{r.failure_kind ? ` · ${failureLabel(r.failure_kind)}` : ""}
							{r.candidate_sha ? (
								<span className="wsm1-muted">
									{" "}
									· candidate {shortHash(r.candidate_sha)}
								</span>
							) : null}
							<span className="wsm1-muted">
								{" "}
								· started {dateTime(r.started_at)}
							</span>
						</li>
					))}
				</ol>
			) : null}
		</section>
	) : null;
	const evidenceBlock = (
		<>
			<TaskCoverage detail={d} />
			{d.artifacts.length > 0 || resultReq ? <EvidenceList detail={d} /> : null}
		</>
	);
	// assignment and monitoring first: once an execution is approved, monitoring leads
	const monitorFirst = Boolean(approvedExecution) && !editing;
	const aheadNote = engineAheadNote(d);
	const engineBad =
		engine?.state === "failed" ||
		engine?.state === "blocked" ||
		engine?.state === "interrupted";
	// the stored stage detail is stale while the engine is ahead of the stage
	const showStageDetail =
		d.task.stage_detail !== null &&
		aheadNote === null &&
		d.task.stage_detail !== engine?.state_detail;
	const cancelConfirmedEarly =
		cancel === "confirmed" && stage === "cancel_requested";

	return (
		<section
			aria-label="Task detail"
			className="wsm1-panel"
			data-task-id={d.task.id}
			data-rev={d.task.rev}
		>
			<div className="wsm1-panel-head">
				<h2 id={PANEL_TITLE_ID} tabIndex={-1} className="wsm1-wrap">
					{proposal?.snapshot.title ?? (d.task.draft.title || "Untitled task")}
				</h2>
				<div className="wsm1-identity">
					<span>{d.task.repo_id}</span>
					<span title={d.task.id}>Task …{d.task.id.slice(-8)}</span>
					{proposal ? (
						<span>
							Proposal v
							<span data-testid="proposal-version">{proposal.version}</span>
						</span>
					) : (
						<span>No proposal yet</span>
					)}
					<ProvenanceChips snapshot={state.snapshot} source={state.source} />
				</div>
				<dl className="wsm1-status-row">
					<KV label="Stage">
						<Chip tone={PHASE_TONE[d.phase]} testId="current-stage">
							{PHASE_LABEL[d.phase]}
						</Chip>
					</KV>
					{engine ? (
						<KV label="Engine">
							<Chip
								tone={
									engine.state === "failed" ||
									engine.state === "blocked" ||
									engine.state === "interrupted"
										? "bad"
										: "neutral"
								}
								testId="engine-state"
								data={{ state: engine.state }}
							>
								{engineLabel(engine.state, acc)}
							</Chip>
						</KV>
					) : null}
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
					{cancel ? (
						<KV label="Cancellation">
							<Chip
								tone={cancel === "requested" ? "waiting" : "neutral"}
								testId="cancellation-status"
								data={{ status: cancel }}
							>
								{cancel === "requested"
									? "Cancellation requested"
									: "Cancellation confirmed"}
							</Chip>
						</KV>
					) : null}
				</dl>
				{acc === "accepted" || d.acceptance_validity ? (
					<AcceptanceValidityBlock
						detail={d}
						freshness={freshnessOf(d.acceptance_validity, state.conn)}
					/>
				) : null}
				<output aria-label="Task status" className="wsm1-task-status">
					{cancelConfirmedEarly
						? "Cancellation confirmed by the engine. The workspace stage is updated when the hub reconciles it."
						: `${PHASE_LABEL[d.phase]}. ${aheadNote ?? nextAction(stage, d.phase)}`}
				</output>
			</div>

			<div className="wsm1-panel-body">
				{closed ? (
					<p className="wsm1-banner wsm1-tone-closed">
						This task is closed (
						{stage === "accepted" ? "accepted" : "rejected"}). Start a new task
						for further work.
					</p>
				) : null}
				{aheadNote ? (
					<p className="wsm1-banner wsm1-tone-info">{aheadNote}</p>
				) : null}
				{failure ||
				engine?.state_detail ||
				showStageDetail ||
				engine?.quarantined ? (
					<div
						className={`wsm1-banner ${engineBad || engine?.quarantined ? "wsm1-tone-bad" : "wsm1-tone-neutral"}`}
					>
						{failure ? <p>{failure}</p> : null}
						{engine?.state_detail ? <p>Engine: {engine.state_detail}</p> : null}
						{showStageDetail ? <p>{d.task.stage_detail}</p> : null}
						{engine?.quarantined ? (
							<p>
								A process of this execution is not proven terminated. Nothing
								else runs until that is resolved.
							</p>
						) : null}
					</div>
				) : null}

				{monitorFirst ? (
					<>
						{executionBlock}
						{evidenceBlock}
						{assignmentBlock}
					</>
				) : (
					<>
						{assignmentBlock}
						{executionBlock}
						{evidenceBlock}
					</>
				)}

				{d.approval_requests.length > 0 ? (
					<section aria-labelledby={`${why}-record`} className="wsm1-block">
						<h3 id={`${why}-record`}>Approval record</h3>
						<ul className="wsm1-record">
							{d.approval_requests.map((r) => {
								const dec = d.decisions.find(
									(x) => x.approval_request_id === r.id,
								);
								return (
									<li key={r.id} data-request-id={r.id}>
										<strong>{GATE_NAME[r.kind]}</strong> ·{" "}
										{proposalVersionLabel(d, r.proposal_id)} ·{" "}
										{requestStatusLine(r)}
										{dec
											? ` · ${dec.operator_id} at ${dateTime(dec.decided_at)}`
											: ""}
										{dec?.reason ? (
											<span className="wsm1-muted"> · “{dec.reason}”</span>
										) : null}
									</li>
								);
							})}
						</ul>
					</section>
				) : null}
			</div>

			<div className="wsm1-panel-foot">
				<div className="wsm1-actions">
					{editing && isDraftEditable(stage) ? (
						<>
							<button
								type="button"
								className="wsm1-primary"
								disabled={!writable}
								onClick={() => void store.saveDraft(d.task.id, form)}
							>
								Save draft
							</button>
							<button
								type="button"
								disabled={!writable || publishIssues(form, checks).length > 0}
								aria-describedby={`${why}-issues`}
								onClick={async () => {
									if (await store.publish(d.task.id, form)) {
										setEditing(false);
										focusById(PANEL_TITLE_ID);
									}
								}}
							>
								Submit for run approval
							</button>
							{proposal ? (
								<button
									type="button"
									onClick={() => {
										setEditing(false);
										setForm(formFromDraft(d.task.draft));
									}}
								>
									Close editor
								</button>
							) : null}
						</>
					) : null}
					{!editing &&
					isDraftEditable(stage) &&
					stage !== "cancel_requested" ? (
						<button
							type="button"
							disabled={!canDecide}
							onClick={() => setEditing(true)}
						>
							Edit draft
						</button>
					) : null}
					{pendingRun ? (
						<button
							type="button"
							className="wsm1-primary"
							onClick={() => openGate(pendingRun.id)}
						>
							Open execution approval
						</button>
					) : null}
					{pendingResult ? (
						<button
							type="button"
							className="wsm1-primary"
							onClick={() => openGate(pendingResult.id)}
						>
							Open result acceptance
						</button>
					) : null}
					{stage === "queued" || stage === "running" ? (
						<button
							type="button"
							className="wsm1-danger"
							disabled={!writable}
							onClick={() => void store.cancel(d.task.id)}
						>
							Cancel execution
						</button>
					) : null}
					{stage === "awaiting_run_approval" ? (
						<button
							type="button"
							disabled={!writable}
							onClick={() => void store.cancel(d.task.id)}
						>
							Withdraw request
						</button>
					) : null}
					{canRerun && !editing ? (
						<button
							type="button"
							disabled={!writable}
							onClick={() => void store.rerun(d.task.id)}
						>
							Request a new run
						</button>
					) : null}
				</div>
				{editing ? (
					<IssuesList id={`${why}-issues`} form={form} checks={checks} />
				) : null}
				{stage === "cancel_requested" && cancel !== "confirmed" ? (
					<p className="wsm1-hint">
						Cancellation requested. It is confirmed only when the engine proves
						the execution stopped.
					</p>
				) : null}
				{!canDecide ? (
					<p className="wsm1-hint">
						This session may read but not change tasks.
					</p>
				) : null}
				{cmdMsg ? <p className="wsm1-hint">{cmdMsg}</p> : null}
				<SaveStatus taskId={d.task.id} />
			</div>
		</section>
	);
}
