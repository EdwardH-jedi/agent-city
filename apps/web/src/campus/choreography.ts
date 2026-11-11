// Where each figure stands, as a pure function of the plan, the visit and the scene clock (no three,
// no DOM). The engine only copies these numbers onto meshes; nothing here can emit anything.
import {
	type CampusLayout,
	ceoRoute,
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
	/** Walking back to its own building. */
	returning: boolean;
}

/** Visits that start together leave one after another (seat order), not as a clump. */
const DEPART_GAP_MS = 900;

export function walkMsFor(
	layout: CampusLayout,
	v: Pick<Visit, "repo_id" | "seat">,
): number {
	return walkDurationMs(routeLength(ceoRoute(layout, v.repo_id, v.seat)));
}

export function figurePose(
	layout: CampusLayout,
	v: Visit,
	now: number,
	reducedMotion: boolean,
): FigurePose {
	const route = ceoRoute(layout, v.repo_id, v.seat);
	const returning = v.left_at !== null;
	const progress = visitProgress(
		v,
		returning ? now : now - (v.seat % 4) * DEPART_GAP_MS,
		walkDurationMs(routeLength(route)),
		reducedMotion,
	);
	if (progress < 1) {
		const s = sampleRoute(route, progress);
		return {
			x: s.x,
			z: s.z,
			// walking back faces the other way along the same path
			yaw: returning ? s.yaw + Math.PI : s.yaw,
			posture: progress > 0 && progress < 1 ? "walk" : "stand",
			stride: s.distance,
			progress,
			returning,
		};
	}
	const spot = lobbySpot(v.seat);
	return {
		x: spot.x,
		z: spot.z,
		yaw: spot.yaw,
		posture: spot.sit ? "sit" : "stand",
		stride: 0,
		progress,
		returning,
	};
}

/**
 * Everything the scene draws from a model, as one string. The board re-derives the model every
 * second (clock tick); an unchanged key means nothing to redraw.
 */
export function sceneKey(model: CampusModel, reducedMotion: boolean): string {
	return JSON.stringify([
		reducedMotion,
		model.owner_present,
		model.still,
		model.door,
		model.repos.map((r) => [
			r.repo_id,
			r.label,
			r.active_tasks,
			r.monitors,
			r.pending_requests,
			r.has_stopped,
		]),
		model.visitors.map((p) => [p.visit_id, p.carry, p.repo_id, p.created_at]),
	]);
}
