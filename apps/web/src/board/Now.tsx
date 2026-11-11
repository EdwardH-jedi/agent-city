// Right column (§13.5): one run, two lines — `프로젝트 · 단계` and Office's nine phases as a bar. No
// workflow name, token count or report age; a stale run says `마지막 보고 N분 전`. At most 5, then +N.
import { agoKo, type NowItem, type VillageModel } from "./model.ts";
import { PHASES, projectLabel } from "./types.ts";

export const NOW_SHOWN = 5;

function NowRow({ n, now }: { n: NowItem; now: number }) {
	return (
		<li
			className={`now-run${n.stale ? " now-stale" : ""}${n.display === "no_progress_suspected" ? " now-slow" : ""}`}
		>
			<div className="now-line">
				{projectLabel(n.project_id)} · {n.phase_label}
				{n.stale && (
					<span className="now-age">
						{" "}
						· 마지막 보고 {agoKo(n.reported_at, now)}
					</span>
				)}
			</div>
			<div className="phases" role="img" aria-label={`단계 ${n.phase_label}`}>
				{PHASES.map((p, idx) => (
					<span
						key={p}
						className={`phase${idx < n.phase_index ? " phase-done" : ""}${idx === n.phase_index ? " phase-now" : ""}`}
					/>
				))}
			</div>
		</li>
	);
}

export function Now({ model, now }: { model: VillageModel; now: number }) {
	const shown = model.now.slice(0, NOW_SHOWN);
	const more = model.now.length - shown.length;
	return (
		<aside className="now" aria-label="지금 진행">
			<h2>지금 진행</h2>
			{model.now.length === 0 ? (
				<p className="hq-empty">없음</p>
			) : (
				<ul className="now-list">
					{shown.map((n) => (
						<NowRow key={n.key} n={n} now={now} />
					))}
				</ul>
			)}
			{more > 0 && <p className="hq-empty">+{more}</p>}
		</aside>
	);
}
