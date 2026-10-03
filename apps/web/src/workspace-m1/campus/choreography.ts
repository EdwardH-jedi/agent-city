// Where each figure stands, as a pure function of the plan, the visit and the clock (no three, no
// DOM). The engine only copies these numbers onto meshes; nothing here can emit an intent.
import {
	type CampusLayout,
	ceoRoute,
	DESK_SPOT,
	lobbySpot,
	routeLength,
	sampleRoute,
} from "./layout.ts";
import type { CampusModel } from "./presentation.ts";
import { type Visit, visitProgress, walkDurationMs } from "./visits.ts";

export interface FigurePose {
	x: number;
	z: number;
	yaw: number;
	posture: "walk" | "sit" | "stand";
	/** Distance walked so far (drives the leg cycle; 0 when not walking). */
	stride: number;
	progress: number;
}

/** Visits that start together leave one after another (seat order), not as a clump. */
const DEPART_GAP_MS = 900;

export function walkMsFor(layout: CampusLayout, v: Visit): number {
	return walkDurationMs(routeLength(ceoRoute(layout, v.repo_id, v.seat)));
}

export function figurePose(
	layout: CampusLayout,
	v: Visit,
	now: number,
	reducedMotion: boolean,
	atDesk: boolean,
): FigurePose {
	const route = ceoRoute(layout, v.repo_id, v.seat);
	const progress = visitProgress(
		v,
		now - (v.seat % 4) * DEPART_GAP_MS,
		walkDurationMs(routeLength(route)),
		reducedMotion,
	);
	if (progress < 1) {
		const s = sampleRoute(route, progress);
		return {
			x: s.x,
			z: s.z,
			yaw: s.yaw,
			posture: progress > 0 ? "walk" : "stand",
			stride: s.distance,
			progress,
		};
	}
	if (atDesk)
		return {
			x: DESK_SPOT.x,
			z: DESK_SPOT.z,
			yaw: DESK_SPOT.yaw,
			posture: "stand",
			stride: 0,
			progress,
		};
	const spot = lobbySpot(v.seat);
	return {
		x: spot.x,
		z: spot.z,
		yaw: spot.yaw,
		posture: spot.sit ? "sit" : "stand",
		stride: 0,
		progress,
	};
}

/**
 * Everything the scene draws from a model, as one string. The store re-derives the model every
 * second (clock tick) and every 2 s (poll); an unchanged key means nothing to redraw.
 */
export function sceneKey(model: CampusModel, reducedMotion: boolean): string {
	return JSON.stringify([
		model.view,
		model.selected.repo_id,
		model.selected.request_id,
		reducedMotion,
		model.repos.map((r) => [
			r.repo_id,
			r.label,
			r.active_tasks,
			r.pending_requests,
			r.has_invalid_acceptance,
		]),
		model.pending.map((p) => [p.request_id, p.kind, p.repo_id, p.created_at]),
	]);
}
