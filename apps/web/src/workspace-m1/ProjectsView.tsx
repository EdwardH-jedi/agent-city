// Projects view (role 07): the DOM campus (one repository = one building; always usable, no 3D),
// the selected repository's tasks, and the task panel on the right.
import { Campus } from "./CampusSlot.tsx";
import { PHASE_LABEL, PHASE_TONE } from "./labels.ts";
import { Chip, useWs } from "./parts.tsx";
import { TaskPanel } from "./TaskPanel.tsx";

function Repositories() {
	const { store, state } = useWs();
	const repos = state.snapshot?.repos ?? [];
	const tasks = state.snapshot?.tasks ?? [];
	const pending = state.snapshot?.pending_requests ?? [];
	return (
		<section aria-label="Repositories" className="wsm1-card wsm1-repos">
			<div className="wsm1-card-head">
				<h2>Repositories</h2>
				<span className="wsm1-muted">
					{repos.length} on the allowlist · simulated execution only
				</span>
			</div>
			{repos.length === 0 ? (
				<p className="wsm1-muted">
					{state.snapshot ? "No repository is allowlisted." : "Loading…"}
				</p>
			) : (
				<ul className="wsm1-campus">
					{repos.map((r) => {
						const own = tasks.filter((t) => t.task.repo_id === r.repo_id);
						const active = own.filter(
							(t) =>
								!["accepted", "rejected", "cancelled"].includes(t.task.stage),
						).length;
						const waiting = pending.filter((p) =>
							own.some((t) => t.task.id === p.workspace_task_id),
						).length;
						const selected = state.route.repoId === r.repo_id;
						return (
							<li key={r.repo_id}>
								<button
									type="button"
									className="wsm1-building"
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
		</section>
	);
}

function Tasks() {
	const { store, state } = useWs();
	const repoId = state.route.repoId;
	const items = (state.snapshot?.tasks ?? []).filter(
		(t) => t.task.repo_id === repoId,
	);
	const canDecide = store.canDecide();
	return (
		<section aria-label="Tasks" className="wsm1-card wsm1-tasks">
			<div className="wsm1-card-head">
				<h2>Tasks{repoId ? ` · ${repoId}` : ""}</h2>
				{repoId ? (
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
			{!canDecide && repoId ? (
				<p id="wsm1-assign-why" className="wsm1-hint">
					This session may read but not assign work.
				</p>
			) : null}
			{!repoId ? (
				<p className="wsm1-muted">
					Select a repository to see and assign its work.
				</p>
			) : items.length === 0 ? (
				<p className="wsm1-muted">
					No tasks yet. Use Assign work to start one.
				</p>
			) : (
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
										<Chip tone="neutral" data={{ validity: "unverifiable" }}>
											Legacy acceptance
										</Chip>
									) : null}
								</button>
							</li>
						);
					})}
				</ul>
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
			<TaskPanel />
		</div>
	);
}
