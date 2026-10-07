// Projects view (role 07): the DOM campus (one repository = one building; always usable, no 3D),
// the repository list (allowlisted fixture repositories, then observed-only ones) and the selected
// repository's tasks on the left; on the right the selected repository's CEO briefing (a compact card,
// summary first) above the task panel. Selecting a repository changes this DOM synchronously
// (store.navigate); the 3D campus follows, it never gates anything.
import { Briefing } from "./Briefing.tsx";
import { Campus } from "./CampusSlot.tsx";
import {
	clockTime,
	OBSERVED_GROUP_NOTE,
	OBSERVED_REPO_NOTE,
	OBSERVED_SOURCE_LABEL,
	PHASE_LABEL,
	PHASE_TONE,
	TASK_WINDOW_UNKNOWN_NOTE,
	taskWindowNote,
	UNKNOWN_REPO_NOTE,
} from "./labels.ts";
import { Chip, useWs } from "./parts.tsx";
import { TaskPanel } from "./TaskPanel.tsx";

function Repositories() {
	const { store, state } = useWs();
	const repos = state.snapshot?.repos ?? [];
	const observed = state.snapshot?.observed_repos ?? [];
	const tasks = state.snapshot?.tasks ?? [];
	const pending = state.snapshot?.pending_requests ?? [];
	return (
		<section aria-label="Repositories" className="wsm1-card wsm1-repos">
			<div className="wsm1-card-head">
				<h2>Repositories</h2>
				<span className="wsm1-muted">
					{repos.length} on the allowlist · simulated execution only
					{observed.length > 0 ? ` · ${observed.length} observed only` : ""}
				</span>
			</div>
			{repos.length === 0 ? (
				<p className="wsm1-muted">
					{state.snapshot ? "No repository is allowlisted." : "Loading…"}
				</p>
			) : (
				<ul className="wsm1-campus">
					{repos.map((r) => {
						// review repair APP-P2-02: the complete stored counts when the hub provides them (the
						// bounded window can omit this repository's tasks); the window only for an older hub
						const summary = state.snapshot?.repo_summaries?.find(
							(x) => x.repo_id === r.repo_id,
						);
						const own = tasks.filter((t) => t.task.repo_id === r.repo_id);
						const active = summary
							? summary.tasks -
								summary.phases.accepted -
								summary.phases.rejected -
								summary.phases.cancelled
							: own.filter(
									(t) =>
										!["accepted", "rejected", "cancelled"].includes(
											t.task.stage,
										),
								).length;
						const waiting = summary
							? summary.pending_requests
							: pending.filter((p) =>
									own.some((t) => t.task.id === p.workspace_task_id),
								).length;
						const selected = state.route.repoId === r.repo_id;
						return (
							<li key={r.repo_id}>
								<button
									type="button"
									className="wsm1-building"
									data-repo-id={r.repo_id}
									data-repo-kind="allowlisted"
									aria-current={selected ? "true" : undefined}
									onClick={() =>
										store.navigate({
											view: "projects",
											repoId: r.repo_id,
											taskId: null,
											requestId: null,
										})
									}
								>
									<span className="wsm1-facade" aria-hidden="true" />
									<span className="wsm1-building-text">
										<span className="wsm1-building-name">{r.repo_id}</span>
										<span className="wsm1-muted">
											{r.base_ref} · checks {r.required_checks.join(", ")}
										</span>
										<span className="wsm1-building-stats">
											{active} active task{active === 1 ? "" : "s"} · {waiting}{" "}
											awaiting Edward
										</span>
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			)}
			{observed.length > 0 ? (
				<div className="wsm1-observed">
					<p className="wsm1-observed-head">
						<strong>Observed only</strong>{" "}
						<span className="wsm1-hint">{OBSERVED_GROUP_NOTE}</span>
					</p>
					<ul className="wsm1-observed-list">
						{observed.map((r) => {
							const selected = state.route.repoId === r.repo_id;
							return (
								<li key={r.repo_id}>
									<button
										type="button"
										className="wsm1-observed-repo"
										data-repo-id={r.repo_id}
										data-repo-kind="observed"
										aria-current={selected ? "true" : undefined}
										onClick={() =>
											store.navigate({
												view: "projects",
												repoId: r.repo_id,
												taskId: null,
												requestId: null,
											})
										}
									>
										<span className="wsm1-building-name">{r.repo_id}</span>{" "}
										<span className="wsm1-muted">
											· Observed only · {OBSERVED_SOURCE_LABEL[r.source]}
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				</div>
			) : null}
		</section>
	);
}

function Tasks() {
	const { store, state } = useWs();
	const repoId = state.route.repoId;
	const kind = store.repoKind(repoId);
	const items = (state.snapshot?.tasks ?? []).filter(
		(t) => t.task.repo_id === repoId,
	);
	// P2 F-01: the snapshot lists a bounded window of tasks; only the hub's complete count says "none"
	const recorded =
		state.snapshot?.repo_task_counts?.find((c) => c.repo_id === repoId)
			?.tasks ?? null;
	const windowNote =
		recorded !== null && items.length >= recorded
			? null
			: recorded === null
				? TASK_WINDOW_UNKNOWN_NOTE
				: taskWindowNote(items.length, recorded);
	const canDecide = store.canDecide();
	return (
		<section
			aria-label="Tasks"
			className="wsm1-card wsm1-tasks"
			data-repo-id={repoId ?? undefined}
			data-repo-kind={repoId ? kind : undefined}
		>
			<div className="wsm1-card-head">
				<h2>Tasks{repoId ? ` · ${repoId}` : ""}</h2>
				{repoId && kind === "allowlisted" ? (
					<button
						type="button"
						className="wsm1-primary"
						disabled={!canDecide}
						aria-describedby={canDecide ? undefined : "wsm1-assign-why"}
						onClick={() => store.startComposing(repoId)}
					>
						Assign work
					</button>
				) : null}
			</div>
			{!canDecide && repoId && kind === "allowlisted" ? (
				<p id="wsm1-assign-why" className="wsm1-hint">
					This session may read but not assign work.
				</p>
			) : null}
			{!repoId ? (
				<p className="wsm1-muted">
					Select a repository to see and assign its work.
				</p>
			) : kind === "observed" ? (
				<p className="wsm1-note" data-testid="observed-note">
					{OBSERVED_REPO_NOTE}
				</p>
			) : kind === "unknown" && state.snapshot ? (
				<p className="wsm1-note">{UNKNOWN_REPO_NOTE}</p>
			) : items.length === 0 && windowNote === null ? (
				<p className="wsm1-muted">
					No tasks yet. Use Assign work to start one.
				</p>
			) : (
				<>
					{windowNote ? (
						<p className="wsm1-hint" data-testid="task-window-note">
							{windowNote}
						</p>
					) : null}
					{items.length === 0 ? null : (
						<ul className="wsm1-list">
							{items.map(({ task, phase, acceptance_validity }) => {
								const selected = state.route.taskId === task.id;
								return (
									<li key={task.id}>
										<button
											type="button"
											className="wsm1-item"
											data-task-id={task.id}
											aria-current={selected ? "true" : undefined}
											onClick={() =>
												store.navigate({
													view: "projects",
													repoId: task.repo_id,
													taskId: task.id,
													requestId: null,
												})
											}
										>
											<span className="wsm1-item-title wsm1-wrap">
												{task.draft.title || "Untitled task"}
											</span>
											<Chip tone={PHASE_TONE[phase]}>{PHASE_LABEL[phase]}</Chip>
											{acceptance_validity?.status === "invalid" ? (
												<Chip tone="bad" data={{ validity: "invalid" }}>
													No longer valid
												</Chip>
											) : acceptance_validity?.status === "unverifiable" ? (
												<Chip
													tone="neutral"
													data={{ validity: "unverifiable" }}
												>
													Legacy acceptance
												</Chip>
											) : null}
										</button>
									</li>
								);
							})}
						</ul>
					)}
					{repoId && kind === "allowlisted" ? (
						<RepositoryHistory repoId={repoId} />
					) : null}
				</>
			)}
		</section>
	);
}

/**
 * Review repair APP-P2-01: the repository's complete history, read in bounded pages on demand (the snapshot
 * lists only a window). Every row navigates to its task (detail / gate / receipt path); nothing here decides.
 */
function RepositoryHistory({ repoId }: { repoId: string }) {
	const { store, state } = useWs();
	// T0-RR-P3-01: exact repository comparison on the structured scope (no key prefix / split)
	const h = state.history?.scope.repoId === repoId ? state.history : null;
	const filter = h?.scope.filter ?? "all";
	const summary = state.snapshot?.repo_summaries?.find(
		(r) => r.repo_id === repoId,
	);
	const recorded =
		summary?.tasks ??
		state.snapshot?.repo_task_counts?.find((c) => c.repo_id === repoId)
			?.tasks ??
		null;
	const attention = summary?.categories.attention ?? 0;
	const retry = () =>
		void store.loadHistory(
			repoId,
			filter,
			(h?.items.length ?? 0) > 0 && !!h?.page?.next_cursor,
		);
	const status = !h
		? ""
		: h.status === "loading"
			? "Loading history…"
			: h.page
				? `Showing ${h.items.length} of ${h.page.total} ${filter === "attention" ? "tasks needing attention" : "recorded tasks"} · read at ${clockTime(h.page.as_of)} (pages are current reads; close and reopen to re-read from the start).`
				: "";
	return (
		<section
			aria-label="Repository history"
			className="wsm1-history"
			data-repo-id={repoId}
			data-history-status={h?.status ?? "closed"}
			data-history-filter={h ? filter : undefined}
		>
			<div className="wsm1-history-head">
				<h3>Repository history</h3>
				{summary ? (
					<span className="wsm1-muted" data-testid="history-summary">
						{summary.tasks} recorded · {attention} need attention ·{" "}
						{summary.acceptance.invalid} accepted result
						{summary.acceptance.invalid === 1 ? "" : "s"} no longer valid
						(stored facts at {clockTime(summary.as_of)})
					</span>
				) : null}
			</div>
			{!h ? (
				<div className="wsm1-history-actions">
					<button
						type="button"
						className="wsm1-link-button"
						onClick={() => void store.loadHistory(repoId, "all")}
					>
						Show history
						{recorded !== null ? ` (${recorded} recorded)` : ""}
					</button>
					{attention > 0 ? (
						<button
							type="button"
							className="wsm1-link-button"
							onClick={() => void store.loadHistory(repoId, "attention")}
						>
							Show the {attention} {attention === 1 ? "task" : "tasks"} needing
							attention
						</button>
					) : null}
				</div>
			) : (
				<>
					<div className="wsm1-filters">
						<label htmlFor="wsm1-history-filter">Show</label>
						<select
							id="wsm1-history-filter"
							value={filter}
							onChange={(e) =>
								void store.loadHistory(
									repoId,
									e.target.value === "attention" ? "attention" : "all",
								)
							}
						>
							<option value="all">All tasks</option>
							<option value="attention">Needs attention</option>
						</select>
						<button
							type="button"
							className="wsm1-link-button"
							onClick={() => store.closeHistory()}
						>
							Close history
						</button>
					</div>
					<p
						className="wsm1-hint"
						data-testid="history-status"
						aria-live="polite"
					>
						{status}
					</p>
					{h.items.length > 0 ? (
						<ul className="wsm1-list">
							{h.items.map(({ task, phase, acceptance_validity }) => (
								<li key={task.id}>
									<button
										type="button"
										className="wsm1-item"
										data-history-task-id={task.id}
										data-phase={phase}
										onClick={() =>
											store.navigate({
												view: "projects",
												repoId: task.repo_id,
												taskId: task.id,
												requestId: null,
											})
										}
									>
										<span className="wsm1-item-title wsm1-wrap">
											{task.draft.title || "Untitled task"}
										</span>
										<Chip tone={PHASE_TONE[phase]}>{PHASE_LABEL[phase]}</Chip>
										{acceptance_validity?.status === "invalid" ? (
											<Chip tone="bad" data={{ validity: "invalid" }}>
												No longer valid
											</Chip>
										) : acceptance_validity?.status === "unknown" ? (
											<Chip tone="waiting" data={{ validity: "unknown" }}>
												Validity unknown
											</Chip>
										) : null}
									</button>
								</li>
							))}
						</ul>
					) : null}
					{h.status === "error" ? (
						<p role="alert" className="wsm1-error-text">
							{h.error} The rows already shown stay as they were read.{" "}
							<button type="button" onClick={retry}>
								Retry
							</button>
						</p>
					) : null}
					{h.page?.has_more ? (
						<button
							type="button"
							disabled={h.status === "loading"}
							onClick={() => void store.loadHistory(repoId, filter, true)}
						>
							Load more
						</button>
					) : h.status === "ready" ? (
						<p className="wsm1-muted" data-testid="history-end">
							End of history.
						</p>
					) : null}
				</>
			)}
		</section>
	);
}

export function ProjectsView() {
	return (
		<div className="wsm1-split">
			<div className="wsm1-left">
				<Campus />
				<Repositories />
				<Tasks />
			</div>
			<div className="wsm1-right">
				<Briefing />
				<TaskPanel />
			</div>
		</div>
	);
}
