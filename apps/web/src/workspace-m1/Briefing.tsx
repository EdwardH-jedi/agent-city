// CEO briefing card (multi-repository milestone): the selected repository's recorded state, summary
// first, details on demand. A DOM card, usable at once (no campus animation gates it). Every control
// only navigates (store.navigate) — the briefing never approves, accepts, runs or cancels anything.
import { type RepoBriefing, repoBriefing } from "./briefing.ts";
import { useWs } from "./parts.tsx";

export function Briefing() {
	const { store, state } = useWs();
	const repoId = state.route.repoId;
	if (state.route.view !== "projects" || !repoId) return null;
	const b: RepoBriefing = repoBriefing({
		snapshot: state.snapshot,
		repoId,
		conn: state.conn,
		sync: state.snapshotSync,
		now: Date.now(),
	});
	const total = b.sections.reduce((n, s) => n + s.items.length, 0);
	return (
		<section
			aria-label="CEO briefing"
			className="wsm1-card wsm1-briefing"
			data-repo-id={repoId}
			data-briefing-state={b.state}
			data-freshness={b.freshness}
			data-briefing-complete={
				b.window ? (b.window.complete ? "true" : "false") : undefined
			}
		>
			<div className="wsm1-card-head">
				<h2 className="wsm1-briefing-title">
					<span className="wsm1-ceo-badge" aria-hidden="true" />
					CEO briefing
				</h2>
				<span
					className={`wsm1-briefing-fresh${b.freshness === "current" ? "" : " wsm1-briefing-fresh-off"}`}
				>
					{b.freshnessLine}
				</span>
			</div>
			<p className="wsm1-briefing-summary" data-testid="briefing-summary">
				{b.summary}
			</p>
			{b.next ? (
				<p className="wsm1-briefing-next" data-testid="briefing-next">
					<span>
						<strong>Next:</strong> {b.next.text}
					</span>
					{b.next.target && b.next.label ? (
						<button
							type="button"
							className="wsm1-link-button"
							title={b.next.label}
							onClick={() => {
								const n = b.next;
								if (!n?.target) return;
								// reads only (review repair): open the repository history / filtered inbox
								if (n.open && "history" in n.open)
									store.openHistory(repoId, n.open.history);
								else {
									store.navigate(n.target);
									if (n.open && "inbox" in n.open)
										void store.loadInbox(repoId, null);
								}
							}}
						>
							{b.next.label}
						</button>
					) : null}
				</p>
			) : null}
			{b.notes.map((n) => (
				<p key={n} className="wsm1-hint wsm1-briefing-note">
					{n}
				</p>
			))}
			{total > 0 ? (
				<details
					className="wsm1-briefing-details"
					data-testid="briefing-details"
				>
					<summary>
						Briefing details ({total} {total === 1 ? "item" : "items"})
					</summary>
					{b.sections.map((sec) => (
						<div
							key={sec.id}
							className="wsm1-briefing-section"
							data-section={sec.id}
						>
							<h3>{sec.heading}</h3>
							<ul className="wsm1-briefing-items">
								{sec.items.map((it) => (
									<li
										key={`${it.kind}-${it.taskId}`}
										data-briefing-item={it.kind}
										data-task-id={it.taskId}
										data-request-id={it.requestId ?? undefined}
									>
										<span className="wsm1-briefing-item-title wsm1-wrap">
											{it.title}
										</span>
										<span className="wsm1-wrap">{it.text}</span>
										<span className="wsm1-muted">{it.when}</span>
										<button
											type="button"
											className="wsm1-link-button"
											onClick={() => store.navigate(it.target)}
										>
											{it.linkLabel}
										</button>
									</li>
								))}
							</ul>
						</div>
					))}
					{b.olderFinished > 0 ? (
						<p className="wsm1-muted">
							{b.olderFinished} earlier finished{" "}
							{b.olderFinished === 1 ? "task is" : "tasks are"} in the task
							list.
						</p>
					) : null}
				</details>
			) : null}
		</section>
	);
}
