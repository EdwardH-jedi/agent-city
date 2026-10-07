// Campus engine (browser only; loaded with the lazy scene chunk). Owns the WebGL renderer, the
// camera, the render-on-demand loop, picking, the visual name tags and the CEO visitors.
//
// Lifecycle: every renderer, GPU resource, listener, observer and frame request is recorded in a
// DisposalRegistry when created; `dispose()` releases all of it (idempotent). The loop runs only
// while something moves (camera ease, cutaway fade, a walking visitor) and never while the tab is
// hidden or the context is lost; otherwise a frame is drawn only when the model changes. Device
// pixel ratio is capped at 2.
//
// Authority: the engine reports a clicked building as a `ScenePick` and nothing else. Arrival of a
// visitor is a pose; it calls nothing. The engine never sees the actions object.
import {
	Color,
	DirectionalLight,
	Fog,
	HemisphereLight,
	MathUtils,
	type Mesh,
	PCFShadowMap,
	PerspectiveCamera,
	Raycaster,
	Scene,
	Vector2,
	Vector3,
	WebGLRenderer,
} from "three";
import { figurePose, sceneKey } from "./choreography.ts";
import type { ScenePick } from "./intents.ts";
import { type CampusLayout, campusLayout } from "./layout.ts";
import { SCENE } from "./palette.ts";
import type { CampusModel } from "./presentation.ts";
import { DisposalRegistry } from "./resources.ts";
import {
	EMPTY_BOOK,
	reconcileVisits,
	type Visit,
	type VisitBook,
} from "./visits.ts";
import {
	type BuildingParts,
	buildCampusWorld,
	type CampusWorld,
	type Figure,
} from "./world.ts";

export const MAX_PIXEL_RATIO = 2;
const CAMERA_MS = 950;
const CUT_MS = 650;

export function boundedPixelRatio(dpr: number | undefined): number {
	const v =
		typeof dpr === "number" && Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
	return Math.min(MAX_PIXEL_RATIO, v);
}

export interface EngineInput {
	model: CampusModel;
	reducedMotion: boolean;
	/** Height (px) of the DOM controls floating over the bottom of the stage. */
	bottomInset?: number;
}

const DEFAULT_INSET = 56;

export interface EngineCallbacks {
	/** A building was clicked on the canvas. */
	onPick(pick: ScenePick): void;
	/** The WebGL context was lost (reported once per loss). */
	onContextLost(): void;
	/** The context came back and the scene is drawing again. */
	onRestored(): void;
	/** First frame drawn. */
	onReady(): void;
}

export interface CampusEngine {
	update(input: EngineInput): void;
	dispose(): void;
	readonly disposed: boolean;
}

type ViewKind =
	| { kind: "overview" }
	| { kind: "building"; id: string }
	| { kind: "hq" };

interface Cam {
	target: Vector3;
	az: number;
	el: number;
	dist: number;
}

interface Tween {
	t0: number;
	dur: number;
	apply(k: number): void;
}

interface Visitor {
	visit: Visit;
	figure: Figure;
}

interface Pin {
	root: HTMLDivElement;
	name: HTMLSpanElement;
	state: HTMLSpanElement;
	anchor: Vector3;
}

const ease = (t: number) =>
	t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

/**
 * Throws when WebGL cannot be initialised (the caller reports `init_failed`); everything created
 * before the failure is released first.
 */
export function createCampusEngine(
	host: HTMLElement,
	pinLayer: HTMLElement,
	initial: EngineInput,
	cb: EngineCallbacks,
): CampusEngine {
	const reg = new DisposalRegistry();
	try {
		return initializeCampusEngine(host, pinLayer, initial, cb, reg);
	} catch (err) {
		reg.disposeAll();
		throw err;
	}
}

/** All initialization shares the caller's registry, including observers and the first update. */
function initializeCampusEngine(
	host: HTMLElement,
	pinLayer: HTMLElement,
	initial: EngineInput,
	cb: EngineCallbacks,
	reg: DisposalRegistry,
): CampusEngine {
	const renderer = new WebGLRenderer({
		antialias: true,
		powerPreference: "high-performance",
	});
	const canvas = renderer.domElement;
	let disposing = false;
	reg.defer(() => {
		disposing = true;
		try {
			renderer.dispose();
		} finally {
			try {
				const gl = renderer.getContext();
				if (gl && !gl.isContextLost()) renderer.forceContextLoss();
			} finally {
				canvas.remove();
			}
		}
	}, "renderer");
	renderer.setPixelRatio(boundedPixelRatio(window.devicePixelRatio));
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = PCFShadowMap;
	renderer.shadowMap.autoUpdate = false;
	renderer.shadowMap.needsUpdate = true;
	canvas.setAttribute("aria-hidden", "true");
	canvas.className = "cmp-canvas";
	host.appendChild(canvas);

	const scene = new Scene();
	scene.background = new Color(SCENE.sky);
	const fog = new Fog(SCENE.sky, 140, 320);
	scene.fog = fog;
	const camera = new PerspectiveCamera(24, 1, 1, 1200);

	const hemi = new HemisphereLight("#eef2f6", "#aeaea8", 0.52 * Math.PI);
	const sun = new DirectionalLight("#fffaf2", 0.82 * Math.PI);
	sun.castShadow = true;
	sun.shadow.mapSize.set(2048, 2048);
	sun.shadow.bias = -0.0004;
	sun.shadow.normalBias = 0.03;
	const fill = new DirectionalLight("#e8eef4", 0.22 * Math.PI);
	fill.position.set(-30, 25, -20);
	scene.add(hemi, sun, sun.target, fill);
	reg.track(sun, "sun (shadow map)");
	reg.track(fill, "fill light");
	reg.track(hemi, "hemisphere light");

	// ── state ───────────────────────────────────────────────────────────────────
	let model = initial.model;
	let reduced = initial.reducedMotion;
	let lastKey = "";
	let layout: CampusLayout = campusLayout([]);
	let world: CampusWorld | null = null;
	let worldReg = new DisposalRegistry();
	reg.defer(() => worldReg.disposeAll(), "world resources");
	let book: VisitBook = EMPTY_BOOK;
	const visitors = new Map<string, Visitor>();
	let pins = new Map<string, Pin>();
	let view: ViewKind = { kind: "overview" };
	let cam: Cam = {
		target: new Vector3(0, 0, 0),
		az: 0.38,
		el: 0.68,
		dist: 120,
	};
	let camTween: Tween | null = null;
	const cutTweens = new Map<string, Tween>();
	let hover: string | null = null;
	let bottomInset = initial.bottomInset ?? DEFAULT_INSET;
	let needsRender = true;
	let raf = 0;
	let contextLost = false;
	let lostReported = false;
	let readySent = false;
	let disposed = false;
	reg.defer(() => {
		disposing = true;
		disposed = true;
		visitors.clear();
		world = null;
	}, "engine state");

	// ── loop ────────────────────────────────────────────────────────────────────
	const canRun = () => !disposed && !contextLost && !document.hidden;
	const schedule = () => {
		if (!raf && canRun()) raf = requestAnimationFrame(frame);
	};
	reg.defer(() => {
		if (raf) cancelAnimationFrame(raf);
		raf = 0;
	}, "animation frame");

	function stepTweens(now: number): boolean {
		let moving = false;
		const run = (tw: Tween) => {
			const k = Math.min(1, (now - tw.t0) / tw.dur);
			tw.apply(k);
			return k < 1;
		};
		if (camTween) {
			if (run(camTween)) moving = true;
			else camTween = null;
		}
		for (const [id, tw] of cutTweens) {
			if (run(tw)) moving = true;
			else cutTweens.delete(id);
			renderer.shadowMap.needsUpdate = true;
		}
		return moving;
	}

	let walkingShown = -1;
	function stepVisitors(now: number): boolean {
		let walking = false;
		let walkers = 0;
		for (const v of visitors.values()) {
			const atDesk =
				model.view === "hq" && model.selected.request_id === v.visit.request_id;
			const p = figurePose(layout, v.visit, now, reduced, atDesk);
			v.figure.group.position.set(p.x, 0.2, p.z);
			v.figure.group.rotation.y = p.yaw;
			v.figure.setPosture(p.posture, p.stride);
			if (p.progress < 1) {
				walking = true; // includes a visitor waiting to depart
				walkers += 1;
			}
		}
		if (walkers !== walkingShown) {
			walkingShown = walkers;
			host.dataset.walking = String(walkers); // QA hook: visitors not yet arrived
		}
		return walking;
	}

	function frame(t: number) {
		raf = 0;
		if (!canRun()) return;
		const moving = stepTweens(t);
		const walking = stepVisitors(Date.now());
		if (needsRender || moving || walking) {
			renderer.render(scene, camera);
			placePins();
			needsRender = false;
			if (!readySent) {
				readySent = true;
				cb.onReady();
			}
		}
		if (moving || walking) schedule();
	}

	// ── camera framing (prototype `fitView`: binary-search the distance, then recentre) ─────
	function applyCam(s: Cam) {
		camera.position.set(
			s.target.x + s.dist * Math.cos(s.el) * Math.sin(s.az),
			s.target.y + s.dist * Math.sin(s.el),
			s.target.z + s.dist * Math.cos(s.el) * Math.cos(s.az),
		);
		camera.lookAt(s.target);
		camera.updateMatrixWorld();
		fog.near = s.dist * 1.05;
		fog.far = s.dist * 2.6;
	}

	interface Spec {
		pts: Vector3[];
		target: Vector3;
		az: number;
		el: number;
		padX: number;
		padTop: number;
		padBot: number;
	}

	const footprint = (
		b: Pick<BuildingParts, "x" | "z" | "w" | "d" | "h">,
		pad: number,
	) => {
		const x0 = b.x - b.w / 2 - pad;
		const x1 = b.x + b.w / 2 + pad;
		const z0 = b.z - b.d / 2 - pad;
		const z1 = b.z + b.d / 2 + pad;
		return [
			new Vector3(x0, 0, z0),
			new Vector3(x1, 0, z0),
			new Vector3(x0, 0, z1),
			new Vector3(x1, 0, z1),
			new Vector3(x0, b.h + 0.6, z0),
			new Vector3(x1, b.h + 0.6, z0),
			new Vector3(x0, b.h + 0.6, z1),
		];
	};

	function specFor(v: ViewKind): Spec {
		const w = world;
		if (!w)
			return {
				pts: [new Vector3()],
				target: new Vector3(),
				az: 0.38,
				el: 0.68,
				padX: 0.9,
				padTop: 0.8,
				padBot: 0.8,
			};
		if (v.kind === "building" || v.kind === "hq") {
			const b = v.kind === "hq" ? w.hq : w.buildings.get(v.id);
			if (b) {
				const pts = footprint(b, 0.4);
				pts.push(new Vector3(b.label.x, 0, b.label.z + 1.2));
				return {
					pts,
					target: new Vector3(b.x, 0.4, b.z),
					az: 0.36,
					el: 0.9,
					padX: 0.9,
					padTop: 0.84,
					padBot: padBottom(0.6),
				};
			}
		}
		const pts: Vector3[] = [...footprint(w.hq, 0.5)];
		for (const b of w.buildings.values()) {
			pts.push(...footprint(b, 0.5));
			pts.push(new Vector3(b.label.x, 0, b.label.z + 2.6)); // the tag hangs below its anchor
		}
		const midZ = (layout.bounds.minZ + layout.bounds.maxZ) / 2;
		return {
			pts,
			target: new Vector3(0, 0, midZ),
			az: 0.38,
			el: 0.68,
			padX: 0.94,
			padTop: 0.86,
			padBot: padBottom(0.66),
		};
	}

	/** Keep framed geometry above the floating building buttons. */
	function padBottom(base: number): number {
		const h = host.clientHeight || 500;
		const p = 1 - (2 * (bottomInset + 8)) / h;
		return Math.max(0.2, Math.min(base, p));
	}

	const tmp = new Vector3();
	function fit(spec: Spec): Cam {
		const w = host.clientWidth || 800;
		const h = host.clientHeight || 500;
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		const s: Cam = {
			target: spec.target.clone(),
			az: spec.az,
			el: spec.el,
			dist: 60,
		};
		for (let pass = 0; pass < 3; pass += 1) {
			let lo = 4;
			let hi = 900;
			for (let it = 0; it < 26; it += 1) {
				s.dist = (lo + hi) / 2;
				applyCam(s);
				const ok = spec.pts.every((c) => {
					const p = tmp.copy(c).project(camera);
					return (
						p.z < 1 &&
						Math.abs(p.x) <= spec.padX &&
						p.y <= spec.padTop &&
						p.y >= -spec.padBot
					);
				});
				if (ok) hi = s.dist;
				else lo = s.dist;
			}
			s.dist = hi;
			applyCam(s);
			let mnx = 9;
			let mxx = -9;
			let mny = 9;
			let mxy = -9;
			for (const c of spec.pts) {
				const p = tmp.copy(c).project(camera);
				mnx = Math.min(mnx, p.x);
				mxx = Math.max(mxx, p.x);
				mny = Math.min(mny, p.y);
				mxy = Math.max(mxy, p.y);
			}
			const cx = (mnx + mxx) / 2;
			const cy = (mny + mxy) / 2 - (spec.padTop - spec.padBot) / 2;
			const halfH = s.dist * Math.tan(MathUtils.degToRad(camera.fov / 2));
			const halfW = halfH * camera.aspect;
			const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
			const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
			const shift = right
				.multiplyScalar(cx * halfW)
				.add(up.multiplyScalar(cy * halfH));
			shift.y = 0;
			s.target.add(shift);
		}
		return s;
	}

	function setView(next: ViewKind, instant: boolean) {
		view = next;
		const to = fit(specFor(next));
		if (instant || reduced) {
			camTween = null;
			cam = to;
			applyCam(cam);
			needsRender = true;
			return;
		}
		const from: Cam = {
			target: cam.target.clone(),
			az: cam.az,
			el: cam.el,
			dist: cam.dist,
		};
		camTween = {
			t0: performance.now(),
			dur: CAMERA_MS,
			apply: (k) => {
				const e = ease(k);
				cam = {
					target: from.target.clone().lerp(to.target, e),
					az: from.az + (to.az - from.az) * e,
					el: from.el + (to.el - from.el) * e,
					dist: from.dist + (to.dist - from.dist) * e,
				};
				applyCam(cam);
			},
		};
	}

	// ── cutaway (prototype `setCut`) ────────────────────────────────────────────────
	function applyCut(b: BuildingParts, v: number) {
		b.cutValue = v;
		const m = b.cutMats;
		m.roof.transparent = v < 1;
		m.roof.opacity = v;
		m.fascia.transparent = v < 1;
		m.fascia.opacity = v;
		m.glass.opacity = 0.26 * v;
		m.mull.transparent = v < 1;
		m.mull.opacity = v;
		b.roof.visible = v > 0.01;
		b.roof.position.y = 0.2 + b.h + (1 - v) * 1.2;
		for (const c of b.cut) c.visible = v > 0.01;
		m.roof.needsUpdate = true;
		m.fascia.needsUpdate = true;
		m.mull.needsUpdate = true;
	}

	function setCut(b: BuildingParts, target: number, instant: boolean) {
		const from = b.cutValue;
		if (from === target && !cutTweens.has(b.id)) return;
		if (instant || reduced) {
			cutTweens.delete(b.id);
			applyCut(b, target);
			renderer.shadowMap.needsUpdate = true;
			return;
		}
		cutTweens.set(b.id, {
			t0: performance.now(),
			dur: CUT_MS,
			apply: (k) => applyCut(b, from + (target - from) * ease(k)),
		});
	}

	// ── visual name tags (aria-hidden; the DOM layer carries the accessible controls) ───────
	function makePin(
		id: string,
		anchor: { x: number; y: number; z: number },
		hq: boolean,
	): Pin {
		const root = document.createElement("div");
		root.className = hq ? "cmp-pin cmp-pin-hq" : "cmp-pin";
		root.dataset.pin = id;
		const name = document.createElement("span");
		name.className = "cmp-pin-name";
		const state = document.createElement("span");
		state.className = "cmp-pin-state";
		root.append(name, state);
		pinLayer.append(root);
		return {
			root,
			name,
			state,
			anchor: new Vector3(anchor.x, anchor.y, anchor.z),
		};
	}

	function clearPins() {
		for (const p of pins.values()) p.root.remove();
		pins = new Map();
	}
	reg.defer(clearPins, "name tags");

	function pinTexts() {
		for (const r of model.repos) {
			const p = pins.get(r.repo_id);
			if (!p) continue;
			p.name.textContent = r.label;
			const bits: string[] = [];
			if (r.active_tasks > 0) bits.push(`${r.active_tasks} in progress`);
			if (r.pending_requests > 0) bits.push(`${r.pending_requests} at HQ`);
			p.state.textContent = bits.length > 0 ? bits.join(" · ") : "Idle";
			p.root.dataset.tone = r.has_invalid_acceptance
				? "danger"
				: r.pending_requests > 0
					? "attention"
					: r.active_tasks > 0
						? "running"
						: "idle";
			if (r.has_invalid_acceptance)
				p.state.textContent = `Integrity warning · ${p.state.textContent}`;
		}
		const hq = pins.get("hq");
		if (hq) {
			const n = model.pending_total ?? model.pending.length;
			hq.name.textContent = "Headquarters";
			hq.state.textContent =
				n === 0
					? "Nothing waiting"
					: `${n} document${n === 1 ? "" : "s"} waiting`;
			hq.root.dataset.tone = n > 0 ? "attention" : "idle";
		}
	}

	function placePins() {
		const w = host.clientWidth;
		const h = host.clientHeight;
		for (const p of pins.values()) {
			const v = tmp.copy(p.anchor).project(camera);
			const x = (v.x * 0.5 + 0.5) * w;
			const y = (-v.y * 0.5 + 0.5) * h;
			// hidden off-stage and where the building buttons float (the DOM layer has the words)
			const out =
				v.z > 1 || x < -20 || x > w + 20 || y < -10 || y + 34 > h - bottomInset;
			p.root.style.display = out ? "none" : "";
			if (!out)
				p.root.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
		}
	}

	// ── world (re)build, activity, selection, visitors ─────────────────────────────────
	function rebuildWorld(next: CampusLayout) {
		if (world) scene.remove(world.root);
		visitors.clear();
		clearPins();
		worldReg.disposeAll();
		worldReg = new DisposalRegistry();
		layout = next;
		world = buildCampusWorld(next, worldReg);
		scene.add(world.root);
		for (const b of world.buildings.values())
			pins.set(b.id, makePin(b.id, b.label, false));
		pins.set("hq", makePin("hq", world.hq.label, true));
		const bx = (next.bounds.minX + next.bounds.maxX) / 2;
		const bz = (next.bounds.minZ + next.bounds.maxZ) / 2;
		const half = Math.max(
			52,
			(next.bounds.maxX - next.bounds.minX) / 2 + 14,
			(next.bounds.maxZ - next.bounds.minZ) / 2 + 14,
		);
		sun.position.set(bx + 38, 64, bz + 30);
		sun.target.position.set(bx, 0, bz);
		sun.target.updateMatrixWorld();
		const sc = sun.shadow.camera;
		sc.left = -half;
		sc.right = half;
		sc.top = half;
		sc.bottom = -half;
		sc.near = 10;
		sc.far = 220;
		sc.updateProjectionMatrix();
		renderer.shadowMap.needsUpdate = true;
	}

	function syncVisitors() {
		const w = world;
		if (!w) return;
		const live = new Set(book.visits.map((v) => v.request_id));
		for (const [id, v] of visitors) {
			if (live.has(id)) continue;
			w.root.remove(v.figure.group); // visit ended: decided, invalidated or removed
			visitors.delete(id);
		}
		for (const visit of book.visits) {
			const have = visitors.get(visit.request_id);
			if (have) {
				have.visit = visit;
				continue;
			}
			const accent = w.buildings.get(visit.repo_id)?.accent ?? SCENE.brass;
			const figure = w.makeVisitor(visit.kind, accent, visit.seat);
			figure.group.traverse((o) => {
				o.castShadow = false;
			});
			w.root.add(figure.group);
			visitors.set(visit.request_id, { visit, figure });
		}
		host.dataset.visitors = String(visitors.size); // QA hook: one per pending request
		const away = new Set(book.visits.map((v) => v.repo_id));
		for (const b of w.buildings.values())
			if (b.homeCeo) b.homeCeo.group.visible = !away.has(b.id);
	}

	function applyActivity() {
		const w = world;
		if (!w) return;
		for (const r of model.repos) {
			const b = w.buildings.get(r.repo_id);
			if (!b) continue;
			const lit = Math.min(r.active_tasks, b.screens.length);
			b.screens.forEach((s, i) => {
				s.mesh.material =
					i < lit ? w.screenMats[s.kind].lit : w.screenMats[s.kind].dim;
			});
			if (b.flag)
				b.flag.material = r.has_invalid_acceptance
					? w.flagMats.danger
					: r.pending_requests > 0
						? w.flagMats.attention
						: w.flagMats.none;
		}
		const n = Math.min(model.pending.length, w.hq.sheets.length);
		w.hq.sheets.forEach((s, i) => {
			s.visible = i < n;
		});
		renderer.shadowMap.needsUpdate = true;
	}

	function applyHighlight() {
		const w = world;
		if (!w) return;
		const sel = model.view === "projects" ? model.selected.repo_id : null;
		const all: BuildingParts[] = [w.hq, ...w.buildings.values()];
		for (const b of all) {
			const on =
				b.id === sel ||
				b.id === hover ||
				(b.kind === "hq" && model.view === "hq");
			const mat = on ? w.accentEdge(b.accent) : w.edgeMat;
			for (const e of b.edges) e.material = mat;
		}
	}

	function viewOf(m: CampusModel): ViewKind {
		if (m.view === "hq") return { kind: "hq" };
		const id = m.selected.repo_id;
		if (m.view === "projects" && id && world?.buildings.has(id))
			return { kind: "building", id };
		return { kind: "overview" };
	}

	const sameView = (a: ViewKind, b: ViewKind) =>
		a.kind === b.kind &&
		(a.kind !== "building" || (b.kind === "building" && a.id === b.id));

	function applySelection(first: boolean) {
		const w = world;
		if (!w) return;
		const next = viewOf(model);
		if (first || !sameView(next, view)) setView(next, first);
		for (const b of w.buildings.values())
			setCut(b, next.kind === "building" && next.id === b.id ? 0 : 1, first);
		setCut(w.hq, next.kind === "hq" ? 0 : 1, first);
		applyHighlight();
	}

	function update(input: EngineInput) {
		if (disposed) return;
		model = input.model;
		const inset = input.bottomInset ?? DEFAULT_INSET;
		const insetChanged = inset !== bottomInset;
		bottomInset = inset;
		const key = sceneKey(input.model, input.reducedMotion);
		if (key === lastKey) {
			if (insetChanged) refit();
			return;
		}
		const first = lastKey === "";
		lastKey = key;
		const reducedChanged = reduced !== input.reducedMotion;
		reduced = input.reducedMotion;
		if (reduced && reducedChanged) {
			camTween?.apply(1);
			camTween = null;
			for (const tw of cutTweens.values()) tw.apply(1);
			cutTweens.clear();
		}
		const nextLayout = campusLayout(model.repos.map((r) => r.repo_id));
		const rebuilt = !world || nextLayout.key !== layout.key;
		if (rebuilt) rebuildWorld(nextLayout);
		book = reconcileVisits(book, model.pending, Date.now());
		syncVisitors();
		applyActivity();
		pinTexts();
		applySelection(first || rebuilt);
		needsRender = true;
		schedule();
	}

	// ── sizing ──────────────────────────────────────────────────────────────────
	function resize() {
		const w = host.clientWidth;
		const h = host.clientHeight;
		if (!w || !h) return;
		renderer.setPixelRatio(boundedPixelRatio(window.devicePixelRatio));
		renderer.setSize(w, h, false);
		canvas.style.width = "100%";
		canvas.style.height = "100%";
		refit();
	}
	function refit() {
		if (world) {
			if (camTween) setView(view, false);
			else {
				cam = fit(specFor(view));
				applyCam(cam);
			}
		}
		needsRender = true;
		schedule();
	}
	const ro = new ResizeObserver(() => resize());
	reg.defer(() => ro.disconnect(), "resize observer");
	ro.observe(host);

	// ── events ──────────────────────────────────────────────────────────────────
	const listen = <K extends keyof HTMLElementEventMap>(
		el: HTMLElement,
		type: K,
		fn: (e: HTMLElementEventMap[K]) => void,
	) => {
		el.addEventListener(type, fn);
		reg.defer(() => el.removeEventListener(type, fn), `listener ${type}`);
	};

	const onVisibility = () => {
		if (document.hidden) {
			if (raf) cancelAnimationFrame(raf);
			raf = 0;
		} else {
			needsRender = true;
			schedule();
		}
	};
	document.addEventListener("visibilitychange", onVisibility);
	reg.defer(
		() => document.removeEventListener("visibilitychange", onVisibility),
		"listener visibilitychange",
	);

	const onLost = (e: Event) => {
		e.preventDefault(); // allow the browser to restore the context
		if (disposing || disposed) return;
		contextLost = true;
		if (raf) cancelAnimationFrame(raf);
		raf = 0;
		if (!lostReported) {
			lostReported = true;
			cb.onContextLost();
		}
	};
	const onRestored = () => {
		if (disposing || disposed) return;
		contextLost = false;
		lostReported = false;
		renderer.shadowMap.needsUpdate = true;
		needsRender = true;
		schedule();
		cb.onRestored();
	};
	canvas.addEventListener("webglcontextlost", onLost);
	canvas.addEventListener("webglcontextrestored", onRestored);
	reg.defer(() => {
		canvas.removeEventListener("webglcontextlost", onLost);
		canvas.removeEventListener("webglcontextrestored", onRestored);
	}, "listeners webglcontext");

	const ray = new Raycaster();
	const ndc = new Vector2();
	function pickAt(e: PointerEvent | MouseEvent): ScenePick | null {
		const w = world;
		if (!w) return null;
		const r = canvas.getBoundingClientRect();
		ndc.set(
			((e.clientX - r.left) / r.width) * 2 - 1,
			-((e.clientY - r.top) / r.height) * 2 + 1,
		);
		ray.setFromCamera(ndc, camera);
		const hit = ray.intersectObjects<Mesh>(w.picks, false)[0];
		const pick = hit?.object.userData.pick as ScenePick | undefined;
		return pick ?? null;
	}
	let downAt: { x: number; y: number } | null = null;
	listen(canvas, "pointerdown", (e) => {
		downAt = { x: e.clientX, y: e.clientY };
	});
	listen(canvas, "click", (e) => {
		if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6)
			return;
		const p = pickAt(e);
		if (p) cb.onPick(p);
	});
	listen(canvas, "pointermove", (e) => {
		const p = pickAt(e);
		const id = p ? (p.kind === "hq" ? "hq" : p.id) : null;
		const actionable =
			p !== null && (p.kind === "repo" || model.pending.length > 0);
		canvas.style.cursor = actionable ? "pointer" : "default";
		if (id !== hover) {
			hover = id;
			applyHighlight();
			needsRender = true;
			schedule();
		}
	});
	listen(canvas, "pointerleave", () => {
		if (hover === null) return;
		hover = null;
		applyHighlight();
		needsRender = true;
		schedule();
	});

	// ── start ───────────────────────────────────────────────────────────────────
	update(initial);
	resize();

	return {
		update,
		get disposed() {
			return disposed;
		},
		dispose() {
			if (disposed) return;
			disposing = true;
			disposed = true;
			visitors.clear();
			reg.disposeAll();
			world = null;
		},
	};
}
