// Middle: the project village as a 2D grid (V1, and the fallback when there is no WebGL). The HQ on
// top with the owner's chair and the lobby, one speech bubble at its door, and at most eight project
// buildings. A building holds its name and pictures only (windows = lit monitors, a flag, the lead at
// the door); every sentence lives in the side columns or the one bubble. Everything drawn comes from
// the VillageModel; when reports stop, the village dims and every figure stands still (CSS class).
import type { MonitorKind, VillageModel, VillageProject } from "./model.ts";
import { projectLabel } from "./types.ts";

const MONITOR_GLYPH: Record<MonitorKind, string> = {
	code: "</>",
	checks: "✓",
	review: "◎",
	other: "▪",
};
const MONITOR_NAME: Record<MonitorKind, string> = {
	code: "코드",
	checks: "검사",
	review: "리뷰",
	other: "작업",
};

/** Four windows per building; a lit one per running run (more than four stay four). */
const WINDOWS = 4;
const SLOTS = Array.from({ length: WINDOWS }, (_, i) => `w${i}`);

function Building({ p, away }: { p: VillageProject; away: boolean }) {
	const flag = p.stopped > 0 ? "red" : p.waiting > 0 ? "yellow" : null;
	const label = [
		p.label,
		p.monitors.length
			? `켜진 모니터 ${p.monitors.map((m) => MONITOR_NAME[m]).join(", ")}`
			: "모니터 꺼짐",
		flag === "red" ? "빨간 깃발" : flag === "yellow" ? "노란 깃발" : "",
		away ? "책임자 HQ에 감" : "책임자 안에 있음",
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<li className="building" aria-label={label}>
			{flag && <i className={`flag flag-${flag}`} aria-hidden="true" />}
			<span className="building-name">{p.label}</span>
			<span className="windows" aria-hidden="true">
				{SLOTS.map((slot, i) => {
					const kind = p.monitors[i];
					return kind ? (
						<i key={slot} className={`win win-on win-${kind}`}>
							{MONITOR_GLYPH[kind]}
						</i>
					) : (
						<i key={slot} className="win" />
					);
				})}
			</span>
			<i
				className={`fig fig-lead${away ? " fig-gone" : ""}`}
				aria-hidden="true"
			/>
		</li>
	);
}

export function Village2d({ model }: { model: VillageModel; now: number }) {
	const { shown, folded } = model.village;
	const away = new Set(model.visits.map((v) => v.project_id));
	const door = model.door;
	return (
		<main
			className={`village${model.status.dim ? " village-dim" : ""}`}
			aria-label="프로젝트 마을"
		>
			<section
				className="hq-building"
				aria-label={
					model.owner.present ? "HQ · 사장 자리에 있음" : "HQ · 빈 의자"
				}
			>
				<span className="building-name">HQ</span>
				<span className="hq-rooms" aria-hidden="true">
					<i
						className={`fig fig-owner${model.owner.present ? "" : " fig-chair"}`}
					/>
					<span className="lobby">
						{model.visits.map((v) => (
							<i
								key={v.id}
								className={`fig fig-visit fig-${v.kind === "sign" ? (v.carry ?? "folder") : "report"}`}
							/>
						))}
					</span>
				</span>
			</section>
			<div className="door">
				{door && (
					<p className="bubble">
						<b>{projectLabel(door.project_id)}</b> {door.text}
					</p>
				)}
			</div>
			<ul className="buildings">
				{shown.map((p) => (
					<Building key={p.id} p={p} away={away.has(p.id)} />
				))}
			</ul>
			{folded > 0 && <p className="quiet">외 {folded}곳</p>}
		</main>
	);
}
