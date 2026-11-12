// The pylon's and the door lamps' BoardView from the scene model. S1 keeps the original lots (they are
// still the original departments), so every lot row is zero and its lamp off; only the ALL row carries
// the model's totals, and a stopped report (`still`) is the original OFFLINE band with "—", never 0.
// S2 replaces this with the real lot mapping (doc 12 §4): this function is that seam.
import type { CampusModel } from "../campus/presentation.ts";
import {
	type BoardCounts,
	type BoardView,
	boardText,
	LABEL_MAX_W,
	TITLE,
} from "./engine/leaderboard.mjs";
import { LOTS } from "./engine/ring-layout.mjs";

const NONE: BoardCounts = {
	working: null,
	waiting: null,
	idle: null,
	unknown: null,
};

export function boardViewOf(model: CampusModel): BoardView {
	const offline = model.still;
	const rows = LOTS.map((lot) => ({
		lot: lot.id,
		label: boardText(lot.label, 6, LABEL_MAX_W),
		deg: lot.deg,
		lastEvidenceS: null,
		...(offline ? NONE : { working: 0, waiting: 0, idle: 0, unknown: 0 }),
	}));
	const sum = (f: (r: CampusModel["repos"][number]) => number) =>
		model.repos.reduce((n, r) => n + f(r), 0);
	const totals: BoardCounts = offline
		? { ...NONE }
		: {
				working: sum((r) => r.active_tasks),
				waiting: sum((r) => r.pending_requests),
				idle: 0,
				unknown: 0,
			};
	return { title: TITLE, rows, offline, totals, source: "city" };
}
