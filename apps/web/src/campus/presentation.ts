// What the 3D campus draws, derived from the board's VillageModel (design doc §8, §10 V2). Local
// types only: the scene never sees the hub, a store or any way to act. It draws buildings, the
// leads walking to the HQ and back, the owner at the HQ desk, and one speech bubble at the HQ door.
import type { MonitorKind, VillageModel } from "../board/model.ts";
import { projectLabel } from "../board/types.ts";

/** What a lead carries to the HQ: a folder (승인 대기) or a binder (멈춤). Reports carry nothing. */
export type Carry = "folder" | "binder";

export interface CampusRepo {
	repo_id: string;
	label: string;
	/** Running runs: one lit monitor each. */
	active_tasks: number;
	/** The picture on each lit monitor, by the run's phase. */
	monitors: MonitorKind[];
	/** 결재 + 멈춤 waiting at the HQ. */
	pending_requests: number;
	/** Something stopped (red flag). */
	has_stopped: boolean;
}

export interface CampusVisitor {
	/** `${machine_id}:${run_id}` — the same run keeps the same walk. */
	visit_id: string;
	kind: "sign" | "report";
	carry: Carry | null;
	repo_id: string;
	/** When the visit began (anchors the walk so a reload does not replay it). */
	created_at: string;
}

export interface CampusModel {
	repos: CampusRepo[];
	visitors: CampusVisitor[];
	/** The owner sits at the HQ desk while the Mac reports; otherwise the chair is empty. */
	owner_present: boolean;
	/** Reports stopped (Mac or this screen): every figure stands where it is. */
	still: boolean;
	/** The one bubble at the HQ door. */
	door: { label: string; text: string } | null;
}

/** Props of the lazily loaded scene (CampusScene.tsx); here so the view needs no import of it. */
export interface CampusSceneProps {
	model: CampusModel;
	/** prefers-reduced-motion: leads are already where they go. */
	reducedMotion: boolean;
	/** Called once if WebGL cannot start, the context is lost or the chunk is missing (2D takes over). */
	onUnavailable(reason: "context_lost" | "init_failed"): void;
	onReady?(): void;
}

/** Pure: the village model → the scene model. Only the buildings that stand in the 2D grid (≤ 8). */
export function toCampusModel(v: VillageModel): CampusModel {
	const shown = new Set(v.village.shown.map((p) => p.id));
	return {
		repos: v.village.shown.map((p) => ({
			repo_id: p.id,
			label: p.label,
			active_tasks: p.running,
			monitors: [...p.monitors],
			pending_requests: p.waiting + p.stopped,
			has_stopped: p.stopped > 0,
		})),
		visitors: v.visits.map((x) => ({
			visit_id: x.id,
			kind: x.kind,
			carry: x.kind === "sign" ? (x.carry ?? "folder") : null,
			// a lead from a folded building walks in from the campus entrance
			repo_id: shown.has(x.project_id) ? x.project_id : `~${x.project_id}`,
			created_at: x.since,
		})),
		owner_present: v.owner.present,
		still: v.status.dim,
		door: v.door
			? { label: projectLabel(v.door.project_id), text: v.door.text }
			: null,
	};
}
