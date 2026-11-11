// Middle: the project village as a grid of cards (V1, 2D). HQ on top with the owner's chair, one
// building per project. Everything drawn comes from the VillageModel; the cockpit going quiet dims it
// and stops every figure (CSS class), it never adds motion of its own.
import {
	agoKo,
	type MonitorKind,
	type VillageModel,
	type VillageProject,
} from "./model.ts";

const MONITOR_LABEL: Record<MonitorKind, string> = {
	code: "코드",
	checks: "검사",
	review: "리뷰",
	other: "작업",
};

/** One lit monitor per running run, grouped by the picture on it. */
function monitorCounts(list: readonly MonitorKind[]): [MonitorKind, number][] {
	const m = new Map<MonitorKind, number>();
	for (const k of list) m.set(k, (m.get(k) ?? 0) + 1);
	return [...m.entries()];
}

function whereIsTheLead(model: VillageModel, p: VillageProject): string {
	const v = model.visits.find((x) => x.project_id === p.id);
	if (!v) return "책임자 · 건물 안";
	return v.kind === "sign"
		? "책임자 · HQ에서 결재 기다림"
		: "책임자 · HQ에 보고하러 감";
}

function Building({ p, model }: { p: VillageProject; model: VillageModel }) {
	const visiting = model.visits.some((x) => x.project_id === p.id);
	return (
		<li className="building">
			<div className="building-head">
				<span className="building-name">{p.label}</span>
				{p.waiting > 0 && (
					<span className="flag flag-yellow">결재 {p.waiting}</span>
				)}
				{p.stopped > 0 && (
					<span className="flag flag-red">멈춤 {p.stopped}</span>
				)}
			</div>
			<div
				className="monitors"
				role="img"
				aria-label={`켜진 모니터 ${p.monitors.length}대`}
			>
				{p.monitors.length === 0 ? (
					<span className="monitor monitor-off">꺼짐</span>
				) : (
					monitorCounts(p.monitors).map(([kind, n]) => (
						<span key={kind} className={`monitor monitor-on monitor-${kind}`}>
							{MONITOR_LABEL[kind]}
							{n > 1 ? ` ×${n}` : ""}
						</span>
					))
				)}
			</div>
			<div className={`lead${visiting ? " lead-away" : ""}`}>
				{whereIsTheLead(model, p)}
			</div>
		</li>
	);
}

export function Village2d({
	model,
	now,
}: {
	model: VillageModel;
	now: number;
}) {
	const shown = model.projects.filter((p) => !p.quiet);
	const quiet = model.projects.length - shown.length;
	const visitors = model.visits.length;
	return (
		<main
			className={`village${model.status.dim ? " village-dim" : ""}`}
			aria-label="프로젝트 마을"
		>
			<section
				className={`hq-building${model.owner.present ? "" : " hq-empty-chair"}`}
			>
				<h2>내 건물 (HQ)</h2>
				<p className="owner">
					{model.owner.present
						? "사장실 · 자리에 앉아 있음"
						: `빈 의자 · 자리 비움 · 마지막 보고 ${agoKo(model.owner.last_report_at, now)}`}
				</p>
				<p className="lobby">로비 {visitors}명 대기·방문</p>
			</section>
			<ul className="buildings">
				{shown.map((p) => (
					<Building key={p.id} p={p} model={model} />
				))}
			</ul>
			{shown.length === 0 && (
				<p className="hq-empty">마을에 활동 중인 프로젝트가 없습니다</p>
			)}
			{quiet > 0 && <p className="quiet">조용함 {quiet}곳</p>}
		</main>
	);
}
