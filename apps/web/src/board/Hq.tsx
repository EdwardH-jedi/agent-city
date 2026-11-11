// Left column: the 결재 cards waiting at the HQ, and what happened while the owner was away.
// Text only — the owner acts in Agent Office on the Mac, never here.
import type { Incident } from "./incidents.ts";
import { agoKo, type VillageModel } from "./model.ts";
import { projectLabel } from "./types.ts";

const hhmm = (iso: string) => {
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? "--:--"
		: d.toLocaleTimeString("ko-KR", {
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			});
};

function waited(iso: string, now: number): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return "";
	const min = Math.max(0, Math.floor((now - t) / 60_000));
	if (min < 1) return "방금";
	if (min < 60) return `${min}분째 기다림`;
	return `${Math.floor(min / 60)}시간째 기다림`;
}

export function Hq({ model, now }: { model: VillageModel; now: number }) {
	const signs = model.visits.filter((v) => v.kind === "sign");
	return (
		<aside className="hq">
			<section className="hq-wait" aria-label="HQ 대기">
				<h2>HQ 대기</h2>
				{signs.length === 0 ? (
					<p className="hq-empty">기다리는 결재 없음</p>
				) : (
					<ul className="cards">
						{signs.map((v) => (
							<li key={v.id} className={`card card-${v.carry ?? "folder"}`}>
								<div className="card-project">{projectLabel(v.project_id)}</div>
								<div className="card-text">{v.text}</div>
								<div className="card-meta">
									{v.code && <code>{v.code}</code>}
									<span>{waited(v.since, now)} · Mac에서 처리</span>
								</div>
							</li>
						))}
					</ul>
				)}
			</section>
			<section className="hq-away" aria-label="자리 비운 사이">
				<h2>자리 비운 사이</h2>
				{model.incidents.length === 0 ? (
					<p className="hq-empty">아직 없음</p>
				) : (
					<ol className="incidents">
						{model.incidents.map((i) => (
							<IncidentRow
								key={`${i.at}|${i.project_id}|${i.text}`}
								i={i}
								now={now}
							/>
						))}
					</ol>
				)}
			</section>
		</aside>
	);
}

function IncidentRow({ i, now }: { i: Incident; now: number }) {
	return (
		<li title={`${i.at} · ${agoKo(i.at, now)}`}>
			<span className="inc-time">{hhmm(i.at)}</span>
			<span className="inc-project">{projectLabel(i.project_id)}</span>
			<span className="inc-text">{i.text}</span>
			{i.code && <code className="inc-code">{i.code}</code>}
		</li>
	);
}
