// Runs the cockpit (Agent Office) reported to City. Read-only by construction: this file renders text
// and nothing else — no control, no form, no request. Approving, launching or retrying a run happens
// in Agent Office on the cockpit, never here. Every card says whose report it is and how old.
import type { RunDisplay, RunView } from "@agent-city/schema";

function since(iso: string, now: number): string {
	const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
	if (Number.isNaN(s)) return "unknown time ago";
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

const LABEL: Record<RunDisplay, string> = {
	running: "running",
	no_progress_suspected: "no progress suspected",
	needs_reconcile: "needs reconcile",
	waiting_owner: "waiting for owner",
	hold: "hold",
	passed: "passed",
	partial: "partial",
	unverified: "unverified",
	unknown: "unknown",
	snapshot_stale: "snapshot stale",
};

/** "running", "hold · MODEL_CHAIN_EXHAUSTED", or "last report: running (3m ago)" when the report is stale. */
function stateText(r: RunView, now: number): string {
	if (r.display === "snapshot_stale") {
		return `last report: ${LABEL[r.last_display]} (${since(r.reported_at, now)})`;
	}
	const detail =
		r.display === "hold" || r.display === "waiting_owner"
			? ` · ${r.reason ?? "—"}`
			: "";
	return `${LABEL[r.display]}${detail}`;
}

function RunRow({ r, now }: { r: RunView; now: number }) {
	return (
		<tr className={`run run-${r.display}`}>
			<td className="run-state">● {stateText(r, now)}</td>
			<td>{r.workflow_id}</td>
			<td>{r.project ?? "—"}</td>
			<td>
				{r.phase} · {r.reason ?? "—"}
			</td>
			<td>{r.completed.length ? r.completed.join(" ") : "—"}</td>
			<td>
				{r.tokens_today ?? "—"}
				{r.usage_unknown ? " + unknown usage" : ""}
			</td>
			<td className="run-report">
				{r.machine_id} report · {since(r.reported_at, now)}
			</td>
		</tr>
	);
}

const HEAD = (
	<tr>
		<th>State</th>
		<th>Workflow</th>
		<th>Project</th>
		<th>Phase · reason</th>
		<th>Done</th>
		<th>Tokens today</th>
		<th>Source</th>
	</tr>
);

/** Runs that need a person to look: waiting for the owner, on hold, needing reconcile, or unverified. */
export function NeedsOwner({ runs, now }: { runs: RunView[]; now: number }) {
	const need = runs.filter((r) => r.needs_owner);
	return (
		<section className="needs-owner">
			<h2>Needs owner</h2>
			{need.length === 0 ? (
				<p className="muted">nothing waiting on the owner</p>
			) : (
				<table>
					<thead>{HEAD}</thead>
					<tbody>
						{need.map((r) => (
							<RunRow key={`${r.machine_id}/${r.run_id}`} r={r} now={now} />
						))}
					</tbody>
				</table>
			)}
		</section>
	);
}

export function Runs({ runs, now }: { runs: RunView[]; now: number }) {
	const sorted = [...runs].sort((a, b) =>
		a.reported_at < b.reported_at ? 1 : a.reported_at > b.reported_at ? -1 : 0,
	);
	return (
		<section className="runs">
			<h2>Runs</h2>
			<table>
				<thead>{HEAD}</thead>
				<tbody>
					{sorted.map((r) => (
						<RunRow key={`${r.machine_id}/${r.run_id}`} r={r} now={now} />
					))}
				</tbody>
			</table>
		</section>
	);
}
