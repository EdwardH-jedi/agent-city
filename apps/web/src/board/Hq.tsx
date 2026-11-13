// Left column (design doc 15 §2): MAP (the town's minimap), HQ 대기, 쉬는 중, 자리 비운 사이 — each one of the
// original town's panel boxes. Text only — the owner acts in Agent Office on the Mac, never here
// ("Mac에서 처리" is said once, in the HQ head).
//
// HQ 대기 and 쉬는 중 are the original's two-line rows: the project (bold), a small tag (`통합 대기`) and
// how long on the right; under it one dim line, cut with an ellipsis. A 2-px bar on the left says the
// state (yellow: 결재 · 입력 대기, red: 멈춤); 쉬는 중 has none (D2). Office's code is never on this screen
// (the detail view D has it). The 기다리는 세션 list of D4 is gone: the right panel's 입력 대기 rows
// stand for it (D10).
//
// The column never clips an HQ row: at most SIGN_SHOWN rows stand (the rest are counted). When the
// column is short, 자리 비운 사이 gives way first (flex-shrink 100 : 1 against 쉬는 중; each drops whole
// lines and keeps at least one — its list's min-height), then the map (TownMinimap.tsx sizes itself to
// what is left after their one-line floors; `data-yield` marks the blocks that give way).
import type { ReactNode } from "react";
import {
	elapsedKo,
	hqTag,
	PAUSED_HEADING,
	PAUSED_TAG,
	PAUSED_TEXT,
} from "./copy.ts";
import { type Incident, incidentRows } from "./incidents.ts";
import { signCards, type VillageModel } from "./model.ts";
import { PanelHead } from "./PanelHead.tsx";
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

export function Hq({
	model,
	now,
	top,
	bottom,
	pixel = false,
}: {
	model: VillageModel;
	now: number;
	/** The town (default scene): its minimap above the queue (design doc 12 §3). */
	top?: ReactNode;
	/** Under LOG: the USAGE box (18 §5 U3). */
	bottom?: ReactNode;
	/** Titles in the town's pixel font (the town scene). */
	pixel?: boolean;
}) {
	const signs = signCards(model.visits);
	const shown = signs.slice(0, SIGN_SHOWN);
	const waiting = signs.reduce((n, c) => n + c.ids.length, 0);
	const more = signs
		.slice(SIGN_SHOWN)
		.reduce((n, c) => n + c.project_ids.length, 0);
	return (
		<aside className="hq">
			{top}
			<section className="hq-wait" aria-label="HQ 대기">
				<PanelHead
					title="HQ"
					label="HQ 대기"
					sub={`대기 ${waiting} · Mac에서 처리`}
					pixel={pixel}
				/>
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
									<span className="tag tag-wait">{hqTag(v)}</span>
									<span className="card-wait">{elapsedKo(v.since, now)}</span>
								</div>
								<div className="card-text" title={v.text}>
									{v.text}
								</div>
							</li>
						))}
					</ul>
				)}
				{more > 0 && <p className="hq-empty">외 {more}건</p>}
			</section>
			<Paused model={model} now={now} pixel={pixel} />
			<Away model={model} now={now} pixel={pixel} />
			{bottom}
		</aside>
	);
}

/** 자리 비운 사이: one short line per event (§13.4), at most six, a divider where the date changes. */
export function Away({
	model,
	now,
	pixel = false,
}: {
	model: VillageModel;
	now: number;
	pixel?: boolean;
}) {
	const rows = incidentRows(model.incidents, now);
	return (
		<section className="hq-away" aria-label="자리 비운 사이" data-yield="1">
			<PanelHead
				title="LOG"
				label="자리 비운 사이"
				sub="자리 비운 사이"
				pixel={pixel}
			/>
			{model.incidents.length === 0 ? (
				<p className="hq-empty">없음</p>
			) : (
				<ol
					className={`incidents${rows[0]?.kind === "day" ? " lead-day" : ""}`}
				>
					{rows.map((row) =>
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
	);
}

/**
 * Decision D2: runs resting between loops — no sound, no border colour, no colour bar. One row per
 * project: the name, `쉬는 중`, since when; under it the sentence (said on every row, dim).
 */
function Paused({
	model,
	now,
	pixel,
}: {
	model: VillageModel;
	now: number;
	pixel: boolean;
}) {
	if (model.paused.length === 0) return null;
	const byProject = new Map<string, string>();
	for (const p of model.paused) {
		const since = byProject.get(p.project_id);
		if (!since || p.since < since) byProject.set(p.project_id, p.since);
	}
	return (
		<section className="hq-paused" aria-label="쉬는 중" data-yield="1">
			<PanelHead
				title="PAUSED"
				label={PAUSED_HEADING}
				sub={`쉬는 중 · ${byProject.size}`}
				pixel={pixel}
			/>
			<ol className="incidents prows">
				{[...byProject].map(([project, since]) => (
					<li key={project} className="prow">
						<div className="card-project">
							<span className="card-names">{projectLabel(project)}</span>
							<span className="tag">{PAUSED_TAG}</span>
							<span className="card-wait">{elapsedKo(since, now)}</span>
						</div>
						<div className="prow-text" title={PAUSED_TEXT}>
							{PAUSED_TEXT}
						</div>
					</li>
				))}
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
