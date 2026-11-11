// Left column: the 결재 cards waiting at the HQ, and what happened while the owner was away.
// Text only — the owner acts in Agent Office on the Mac, never here ("Mac에서 처리" is said once, in
// the heading). The column never clips a card or a line in half: at most SIGN_SHOWN cards stand (the
// rest are counted), and history lines that do not fit drop out whole (CSS column wrap).
import type { Incident } from "./incidents.ts";
import { agoKo, signCards, type VillageModel } from "./model.ts";
import { projectLabel } from "./types.ts";

export const SIGN_SHOWN = 3;

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
	if (min < 60) return `${min}분째`;
	return `${Math.floor(min / 60)}시간째`;
}

export function Hq({ model, now }: { model: VillageModel; now: number }) {
	const signs = signCards(model.visits);
	const shown = signs.slice(0, SIGN_SHOWN);
	const more = signs
		.slice(SIGN_SHOWN)
		.reduce((n, c) => n + c.project_ids.length, 0);
	return (
		<aside className="hq">
			<section className="hq-wait" aria-label="HQ 대기">
				<h2>HQ 대기 · Mac에서 처리</h2>
				{signs.length === 0 ? (
					<p className="hq-empty">없음</p>
				) : (
					<ul className="cards">
						{shown.map((v) => (
							<li key={v.ids.join(" ")} className={`card card-${v.carry}`}>
								<div className="card-project">
									<span className="card-names">
										{v.project_ids.map(projectLabel).join(" · ")}
									</span>
									<span className="card-wait">{waited(v.since, now)}</span>
								</div>
								<div className="card-text">{v.text}</div>
								{v.code && <code>{v.code}</code>}
							</li>
						))}
					</ul>
				)}
				{more > 0 && <p className="hq-empty">외 {more}건</p>}
			</section>
			<section className="hq-away" aria-label="자리 비운 사이">
				<h2>자리 비운 사이</h2>
				{model.incidents.length === 0 ? (
					<p className="hq-empty">없음</p>
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
			<span className="inc-text">
				{i.text}
				{i.code && <code className="inc-code"> {i.code}</code>}
			</span>
		</li>
	);
}
