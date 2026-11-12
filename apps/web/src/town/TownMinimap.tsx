// The town's minimap (design doc 12 §4): the ring, the ten lots with their labels and door-lamp colours,
// and the kangaroo. Drawn with minimap.mjs's pure model and drawing functions on a plain canvas, from
// what the stage shows right now (live.ts), on a slow timer. No listeners: nothing on it responds.
// It is the first thing to give way in the HQ column (§3): it never pushes the 결재 cards out of view —
// it shrinks to the room left above them (and the blocks under them), and hides when even a small map
// would not fit. Its `MAP` title is drawn as DOM text in the panel-title style (style.css).
import { useEffect, useRef } from "react";
import {
	drawBase,
	fitTransform,
	guideTriangle,
	type RingMapModel,
	ringModel,
} from "./engine/minimap.mjs";
import { townLive } from "./live.ts";

const REDRAW_MS = 500;
const MAX_H = 240;
/** Below this the map says nothing useful: hide it instead. */
const MIN_H = 96;
const GREY = "#6a6660"; // minimap.mjs: every lamp grey while reports are stopped
const GUIDE = "#f6d070";
const GUIDE_EDGE = "#1b1512";

const px = (v: string) => Number.parseFloat(v) || 0;

/**
 * Height a block would have with all the room it wants. The blocks under the 결재 cards may shrink (their
 * line lists are `overflow: hidden` columns that drop whole lines), so their box heights say nothing
 * about the content: sum the title and the single-column list instead.
 */
function naturalHeight(el: HTMLElement): number {
	if (!el.querySelector(".incidents")) return el.offsetHeight;
	const cs = getComputedStyle(el);
	const kids = Array.from(el.children).filter(
		(k): k is HTMLElement =>
			k instanceof HTMLElement && getComputedStyle(k).display !== "none",
	);
	let sum = px(cs.paddingTop) + px(cs.paddingBottom);
	for (const k of kids) {
		if (k.classList.contains("incidents")) {
			const rows = Array.from(k.children).filter(
				(r): r is HTMLElement =>
					r instanceof HTMLElement && getComputedStyle(r).display !== "none",
			);
			sum +=
				rows.reduce((n, r) => n + r.offsetHeight, 0) +
				px(getComputedStyle(k).rowGap) * Math.max(0, rows.length - 1);
		} else sum += k.offsetHeight;
	}
	return sum + px(cs.rowGap) * Math.max(0, kids.length - 1);
}

/**
 * Height the map's canvas may take without pushing the rest of the HQ column (결재 cards, 쉬는 중, 기다리는
 * 세션) past the column's bottom: the room left after every other block and the gaps between them, minus
 * the map's own title.
 */
function roomAbove(wrap: HTMLElement): number {
	const aside = wrap.closest(".hq");
	if (!(aside instanceof HTMLElement)) return MAX_H;
	const cs = getComputedStyle(aside);
	const inner = aside.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom);
	let others = 0;
	let blocks = 1; // the map itself
	for (const el of Array.from(aside.children)) {
		if (
			el === wrap ||
			!(el instanceof HTMLElement) ||
			getComputedStyle(el).display === "none"
		)
			continue;
		others += naturalHeight(el);
		blocks++;
	}
	const title = wrap.querySelector<HTMLElement>(".town-map-title");
	const head = title
		? title.offsetHeight + px(getComputedStyle(wrap).rowGap)
		: 0;
	return Math.min(
		MAX_H,
		Math.floor(inner - others - px(cs.rowGap) * (blocks - 1) - head),
	);
}

export default function TownMinimap() {
	const wrapRef = useRef<HTMLDivElement>(null);
	const ref = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		const base = ringModel();
		let lastKey = "";
		function hide() {
			const w = wrapRef.current;
			if (w && !w.hidden) w.hidden = true;
			lastKey = "";
		}
		function draw() {
			const wrap = wrapRef.current;
			const c = ref.current;
			const live = townLive.get();
			if (!wrap || !c || !live) return hide();
			wrap.hidden = false;
			const width = Math.floor(wrap.clientWidth); // .town-map has no padding: the content box
			const maxH = roomAbove(wrap);
			if (width <= 0 || maxH < MIN_H) return hide();
			const labels = new Map(live.lots.map((l) => [l.id, l.label]));
			const model: RingMapModel = {
				...base,
				lots: base.lots.map((l) => ({ ...l, label: labels.get(l.id) ?? "" })),
			};
			const T = fitTransform(model.bounds, width, 4, maxH, false);
			const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
			const key = `${T.width}|${T.height}|${dpr}`;
			if (key !== lastKey) {
				lastKey = key;
				c.width = T.width * dpr;
				c.height = T.height * dpr;
				c.style.width = `${T.width}px`;
				c.style.height = `${T.height}px`;
			}
			const ctx = c.getContext("2d");
			if (!ctx) return;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.imageSmoothingEnabled = false;
			drawBase(ctx, model, T);
			const color = new Map(live.lots.map((l) => [l.id, l.color]));
			const r = Math.max(2, Math.round(T.s * 0.7));
			for (const l of model.lots) {
				// reports stopped: every lot shows the grey offline marker, as every door lamp does
				const fill = live.offline ? GREY : color.get(l.id);
				if (!fill) continue;
				const [x, y] = T.toPx(l.lampAt[0], l.lampAt[1]);
				ctx.fillStyle = fill;
				ctx.fillRect(Math.round(x - r), Math.round(y - r), 2 * r, 2 * r);
			}
			if (live.guide) {
				const g = live.guide;
				const t = guideTriangle(
					T,
					g.x,
					g.z,
					g.yaw,
					Math.max(6, Math.round(T.s * 1.8)),
				);
				ctx.beginPath();
				ctx.moveTo(t[0][0], t[0][1]);
				ctx.lineTo(t[1][0], t[1][1]);
				ctx.lineTo(t[2][0], t[2][1]);
				ctx.closePath();
				ctx.fillStyle = GUIDE;
				ctx.fill();
				ctx.lineWidth = 1;
				ctx.strokeStyle = GUIDE_EDGE;
				ctx.stroke();
			}
		}
		draw();
		const t = setInterval(draw, REDRAW_MS);
		return () => clearInterval(t);
	}, []);
	return (
		<div ref={wrapRef} className="town-map" aria-hidden="true" hidden>
			<h2 className="town-map-title">MAP</h2>
			<canvas ref={ref} className="town-map-canvas" />
		</div>
	);
}
