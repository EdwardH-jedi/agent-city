// Right column: runs that are going now — which project, which of Office's nine phases, how fresh the
// cockpit's report is, and that run's tokens today. No total across runs (they may overlap).
import { agoKo, type NowItem, type VillageModel } from "./model.ts";
import { PHASES, projectLabel } from "./types.ts";

function NowCard({ n, now }: { n: NowItem; now: number }) {
	return (
		<li className={`card now-card${n.stale ? " now-stale" : ""}`}>
			<div className="card-project">{projectLabel(n.project_id)}</div>
			<div className="now-workflow">{n.workflow_id}</div>
			<div className="phases" role="img" aria-label={`단계 ${n.phase}`}>
				{PHASES.map((p, idx) => (
					<span
						key={p}
						className={`phase${idx < n.phase_index ? " phase-done" : ""}${idx === n.phase_index ? " phase-now" : ""}`}
						title={p}
					/>
				))}
			</div>
			<div className="now-phase">
				{n.phase}
				{n.display === "no_progress_suspected" && (
					<b className="now-flag"> · 진행이 멈춘 듯</b>
				)}
			</div>
			<div className="card-meta">
				<span>
					{n.stale
						? `마지막 보고: running (${agoKo(n.reported_at, now)})`
						: `${n.machine_id} 보고 · ${agoKo(n.reported_at, now)}`}
				</span>
				<span>
					오늘 토큰 {n.tokens_today ?? "—"}
					{n.usage_unknown ? " + 사용량 미확인" : ""}
				</span>
			</div>
		</li>
	);
}

export function Now({ model, now }: { model: VillageModel; now: number }) {
	return (
		<aside className="now" aria-label="지금 진행">
			<h2>지금 진행</h2>
			{model.now.length === 0 ? (
				<p className="hq-empty">진행 중인 작업 없음</p>
			) : (
				<ul className="cards">
					{model.now.map((n) => (
						<NowCard key={n.key} n={n} now={now} />
					))}
				</ul>
			)}
		</aside>
	);
}
