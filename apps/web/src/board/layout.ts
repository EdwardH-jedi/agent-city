// The board's frame (design doc 15 §1, decision D10): the column widths and the panel text scale.
// Pure and tiny: the board imports this statically, so it must not import the engine or three (the town is
// a lazy chunk). The rule is the original town's (renderer/panels.mjs `panelLayout`): the stage picks its
// integer scale FIRST, then the two panels share what is left, each at most PANEL_MAX. The same widths are
// used under ?scene=campus and the 2D fallback; the middle column takes the rest there. 17 F3: the town's
// render target then grows to fill the column's height (rtH, 288..360; town/pipeline.ts fitStage).

/** The original's render target (town/engine/pipeline-core.mjs RT_W_MAX × RT_H). */
export const STAGE_W = 384;
export const STAGE_H = 288;
/** 17 F3: the tallest the town's target grows to fill the column (town/pipeline.ts RT_H_MAX). */
export const STAGE_H_MAX = 360;
/** Largest integer scale the town uses (town/pipeline.ts). */
export const STAGE_MAX_SCALE = 4;
/** The original's panel cap. */
export const PANEL_MAX = 420;
/**
 * The narrowest a side panel may be. The original switches to one panel or tabs below 2 × 240 px; the
 * board has neither (both panels always show), so the stage drops a scale instead (15 §1, decided in P1).
 */
export const PANEL_MIN = 240;
/** The top band: the status sentence (28 px) and the chips. Was 80 px with the 48 px sentence. */
export const TOP_H = 56;

export interface BoardColumns {
	/** Stage scale the middle column fits (town/pipeline.ts `fitStage` picks the same). */
	scale: number;
	left: number;
	middle: number;
	right: number;
	top: number;
	/** Height of the columns (the window under the top band). */
	body: number;
	/**
	 * 17 F3: the town's render-target height at this scale, clamp(floor(body / scale), 288, 360) — the
	 * stage is 384·s × rtH·s (town/pipeline.ts fitStage picks the same).
	 */
	rtH: number;
}

/**
 * Columns for a window of width × height CSS px. Scale: the largest integer s ≤ 4 with 384·s beside two
 * PANEL_MIN panels and 288·s within the body; at least 1. Then (17 F3) the town's target height rtH fills
 * the body: clamp(floor(body / s), 288, 360). Panels: min(PANEL_MAX, floor((width − 384·s) / 2)),
 * never under PANEL_MIN (a window too narrow even for 1× gives the middle what is left). Whole px only.
 */
export function boardColumns(width: number, height: number): BoardColumns {
	const W = Math.max(0, Math.floor(width || 0));
	const H = Math.max(0, Math.floor(height || 0));
	const body = Math.max(0, H - TOP_H);
	let scale = 1;
	for (let s = STAGE_MAX_SCALE; s >= 2; s -= 1) {
		if (STAGE_W * s + 2 * PANEL_MIN <= W && STAGE_H * s <= body) {
			scale = s;
			break;
		}
	}
	const each = Math.max(
		PANEL_MIN,
		Math.min(PANEL_MAX, Math.floor((W - STAGE_W * scale) / 2)),
	);
	const middle = Math.max(0, W - 2 * each);
	const rtH = Math.max(
		STAGE_H,
		Math.min(STAGE_H_MAX, Math.floor(body / Math.max(1, scale))),
	);
	return { scale, left: each, middle, right: each, top: TOP_H, body, rtH };
}

/** `?ui=1.15` or `?ui=1.3` scales every panel text size (15 §1); any other value (or none) is 1. */
export const UI_SCALES = [1, 1.15, 1.3] as const;
export function uiScaleOf(search: string): number {
	const raw = new URLSearchParams(search).get("ui");
	if (raw === null) return 1;
	const v = Number(raw.trim());
	return UI_SCALES.find((s) => s === v) ?? 1;
}
