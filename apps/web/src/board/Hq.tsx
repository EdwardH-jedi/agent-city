// Left column: the 결재 cards waiting at the HQ, and what happened while the owner was away.
// Text only — the owner acts in Agent Office on the Mac, never here ("Mac에서 처리" is said once, in
// the heading). The column never clips a card or a line in half: at most SIGN_SHOWN cards stand (the
// rest are counted), and history lines are one short line each (§13.4) with a divider where the
// date changes; lines that do not fit drop out whole (CSS column wrap).
import { PAUSED_HEADING, PAUSED_TEXT, SESSION_LIST_HEADING } from "./copy.ts";
import { type Incident, incidentRows } from "./incidents.ts";
import { signCards, type VillageModel } from "./model.ts";
import { projectLabel } from "./types.ts";

export const SIGN_SHOWN = 3;
/** Rows of 기다리는 세션 before `외 N` (old waits never go stale on the hub; §13.8 at 1366×768). */
export const WAITING_SHOWN = 3;

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
			<Paused model={model} />
			<WaitingSessions model={model} now={now} />
			<section className="hq-away" aria-label="자리 비운 사이">
				<h2>자리 비운 사이</h2>
				{model.incidents.length === 0 ? (
					<p className="hq-empty">없음</p>
				) : (
					<ol className="incidents">
						{incidentRows(model.incidents, now).map((row) =>
							row.kind === "day" ? (
								<li key={`day|${row.label}`} className="inc-day">
									{row.label}
								</li>
							) : (
								<IncidentRow
									key={`${row.incident.at}|${row.incident.project_id}|${row.incident.text}`}
									i={row.incident}
								/>
							),
						)}
					</ol>
				)}
			</section>
		</aside>
	);
}

/**
 * Decision D2: runs resting between loops, under HQ 대기 — no sound, no border colour, dim text. The
 * sentence is said once for all of them; the names are one line.
 */
function Paused({ model }: { model: VillageModel }) {
	if (model.paused.length === 0) return null;
	const names = [
		...new Set(model.paused.map((p) => projectLabel(p.project_id))),
	];
	return (
		<section className="hq-wait" aria-label="쉬는 중">
			<h2>{PAUSED_HEADING}</h2>
			<ol className="incidents">
				<li className="inc">
					<span className="inc-text">{names.join(" · ")}</span>
				</li>
				<li className="inc">
					<span className="inc-text">{PAUSED_TEXT}</span>
				</li>
			</ol>
		</section>
	);
}

/**
 * Decision D4: sessions still waiting for input after their 30 minutes at the HQ — one dim line each
 * (`42분째 docs Claude`), no sound, no border colour. At most WAITING_SHOWN, then `외 N`.
 */
function WaitingSessions({ model, now }: { model: VillageModel; now: number }) {
	const list = model.waitingSessions;
	if (list.length === 0) return null;
	const shown = list.slice(0, WAITING_SHOWN);
	return (
		<section className="hq-wait" aria-label={SESSION_LIST_HEADING}>
			<h2>{SESSION_LIST_HEADING}</h2>
			<ol className="incidents">
				{shown.map((w) => (
					<li key={w.id} className="inc">
						<span className="inc-time">{waited(w.since, now)}</span>
						<span className="inc-project">{projectLabel(w.project_id)}</span>
						<span className="inc-text">{w.provider_label}</span>
					</li>
				))}
				{list.length > shown.length && (
					<li className="inc">
						<span className="inc-text">외 {list.length - shown.length}</span>
					</li>
				)}
			</ol>
		</section>
	);
}

/** One line: `17:03 docs T3 통과`. No code string (the detail view has it). */
function IncidentRow({ i }: { i: Incident }) {
	return (
		<li className="inc">
			<span className="inc-time">{hhmm(i.at)}</span>
			<span className="inc-project">{projectLabel(i.project_id)}</span>
			<span className="inc-text">{i.text}</span>
		</li>
	);
}
