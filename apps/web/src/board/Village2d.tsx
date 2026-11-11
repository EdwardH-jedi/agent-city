// Middle (2D): the village as a small tile grid — V1, and the fallback when there is no WebGL (§13.10).
// A tile holds a name, four window dots (lit = a running run) and a flag; a tile with nothing running
// is dark. The HQ tile shows the owner's chair and the leads waiting in its lobby, and the one speech
// bubble stands at its door. No sentence on a tile. When reports stop, the village dims and every
// figure stands still (CSS class).
import type { MonitorKind, VillageModel, VillageProject } from "./model.ts";
import { projectLabel } from "./types.ts";

const MONITOR_NAME: Record<MonitorKind, string> = {
	code: "코드",
	checks: "검사",
	review: "리뷰",
	other: "작업",
};

/** Four windows per building; one lit per running run (more than four stay four). */
const SLOTS = ["w0", "w1", "w2", "w3"] as const;

function Tile({ p }: { p: VillageProject }) {
	const flag = p.stopped > 0 ? "red" : p.waiting > 0 ? "yellow" : null;
	const lit = Math.min(p.monitors.length, SLOTS.length);
	const label = [
		p.label,
		lit
			? `켜진 창 ${p.monitors.map((m) => MONITOR_NAME[m]).join(", ")}`
			: "불 꺼짐",
		flag === "red" ? "빨간 깃발" : flag === "yellow" ? "노란 깃발" : "",
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<li className={`tile${lit ? " tile-on" : " tile-off"}`} aria-label={label}>
			{flag && <i className={`flag flag-${flag}`} aria-hidden="true" />}
			<span className="tile-name">{p.label}</span>
			<span className="dots" aria-hidden="true">
				{SLOTS.map((slot, i) => (
					<i key={slot} className={`dot${i < lit ? " dot-on" : ""}`} />
				))}
			</span>
		</li>
	);
}

export function Village2d({ model }: { model: VillageModel; now: number }) {
	const { shown, folded } = model.village;
	const door = model.door;
	return (
		<main
			className={`village${model.status.dim ? " village-dim" : ""}`}
			aria-label="프로젝트 마을"
		>
			<section
				className="hq-tile"
				aria-label={
					model.owner.present ? "HQ · 사장 자리에 있음" : "HQ · 빈 의자"
				}
			>
				<span className="tile-name">HQ</span>
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
			<ul className="tiles">
				{shown.map((p) => (
					<Tile key={p.id} p={p} />
				))}
			</ul>
			{folded > 0 && <p className="quiet">조용함 {folded}곳</p>}
		</main>
	);
}
