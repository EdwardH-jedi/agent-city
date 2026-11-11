// Campus engine (browser only; loaded with the lazy scene chunk). Owns the WebGL renderer, the fixed
// overview camera, the render-on-demand loop, the name tags, the one speech bubble at the HQ door,
// the owner at the HQ desk and the leads walking to the HQ and back.
//
// Lifecycle: every renderer, GPU resource, listener, observer and frame request is recorded in a
// DisposalRegistry when created; `dispose()` releases all of it (idempotent). The loop runs only
// while a lead walks, never while the tab is hidden, the context is lost or reports are stopped;
// otherwise a frame is drawn only when the model changes. Device pixel ratio is capped at 2.
//
// Nothing here listens to the pointer or the keyboard: the camera never moves on its own or by hand
// (a fixed panorama), and the scene has no way to emit anything but its own lifecycle facts.
import {
	Color,
	DirectionalLight,
	Fog,
	HemisphereLight,
	MathUtils,
	PCFShadowMap,
	PerspectiveCamera,
	Scene,
	Vector3,
	WebGLRenderer,
} from "three";
import { figurePose, sceneKey, walkMsFor } from "./choreography.ts";
import { type CampusLayout, campusLayout, HQ_BOX } from "./layout.ts";
import { GLOW, LIGHT, SCENE } from "./palette.ts";
import type { CampusModel } from "./presentation.ts";
import { DisposalRegistry } from "./resources.ts";
import {
	EMPTY_BOOK,
	reconcileVisits,
	type SceneClock,
	START_CLOCK,
	sceneNow,
	setStill,
	settleVisits,
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

export function boundedPixelRatio(dpr: number | undefined): number {
	const v =
		typeof dpr === "number" && Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
	return Math.min(MAX_PIXEL_RATIO, v);
}

export interface EngineInput {
	model: CampusModel;
	reducedMotion: boolean;
}

export interface EngineCallbacks {
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

interface Cam {
	target: Vector3;
	az: number;
	el: number;
	dist: number;
}

interface Visitor {
	visit: Visit;
	figure: Figure;
}

interface Pin {
	root: HTMLDivElement;
	anchor: Vector3;
	/** The bubble hangs above its anchor; a tag sits below it. */
	above: boolean;
}

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

	// evening light: a dim blue sky, a low warm sun, a cool fill (palette.ts LIGHT)
	const hemi = new HemisphereLight(
		LIGHT.sky,
		LIGHT.ground,
		LIGHT.hemi * Math.PI,
	);
	const sun = new DirectionalLight(LIGHT.sun, LIGHT.sunIntensity * Math.PI);
	sun.castShadow = true;
	sun.shadow.mapSize.set(2048, 2048);
	sun.shadow.bias = -0.0004;
	sun.shadow.normalBias = 0.03;
	const fill = new DirectionalLight(LIGHT.fill, LIGHT.fillIntensity * Math.PI);
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
	let clock: SceneClock = START_CLOCK;
	const visitors = new Map<string, Visitor>();
	let pins = new Map<string, Pin>();
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

	const walkMsOf = (v: Pick<Visit, "repo_id" | "seat">) => walkMsFor(layout, v);
	const now = () => sceneNow(clock, Date.now());

	// ── loop ────────────────────────────────────────────────────────────────────
	const canRun = () => !disposed && !contextLost && !document.hidden;
	const schedule = () => {
		if (!raf && canRun()) raf = requestAnimationFrame(frame);
	};
	reg.defer(() => {
		if (raf) cancelAnimationFrame(raf);
		raf = 0;
	}, "animation frame");

	let walkingShown = -1;
	/** Pose every lead; true while one is still on its way (and reports are flowing). */
	function stepVisitors(t: number): boolean {
		const settled = settleVisits(book, t, walkMsOf, reduced);
		if (settled !== book) {
			book = settled;
			syncVisitors();
		}
		let walkers = 0;
		for (const v of visitors.values()) {
			const p = figurePose(layout, v.visit, t, reduced);
			v.figure.group.position.set(p.x, 0.2, p.z);
			v.figure.group.rotation.y = p.yaw;
			v.figure.setPosture(p.posture, p.stride);
			if (p.returning ? p.progress > 0 : p.progress < 1) walkers += 1;
		}
		// a lead that reached home on this frame is forgotten now (no frame may follow to do it)
		const home = settleVisits(book, t, walkMsOf, reduced);
		if (home !== book) {
			book = home;
			syncVisitors();
			needsRender = true;
		}
		if (walkers !== walkingShown) {
			walkingShown = walkers;
			host.dataset.walking = String(walkers); // QA hook: leads on their way
		}
		return walkers > 0 && !model.still;
	}

	function frame() {
		raf = 0;
		if (!canRun()) return;
		const walking = stepVisitors(now());
		if (needsRender || walking) {
			renderer.render(scene, camera);
			placePins();
			needsRender = false;
			if (!readySent) {
				readySent = true;
				cb.onReady();
			}
		}
		if (walking) schedule();
	}

	// ── the fixed panorama (prototype `fitView`: binary-search the distance, then recentre) ─
	const AZ = 0.38;
	const EL = 0.68;
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

	const tmp = new Vector3();
	function fitOverview(): Cam {
		const w = host.clientWidth || 800;
		const h = host.clientHeight || 500;
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		// the buildings themselves fill the stage (tags and the bubble are kept inside by placePins)
		const pts: Vector3[] = [];
		if (world) {
			pts.push(...footprint(world.hq, 0.2));
			for (const b of world.buildings.values()) pts.push(...footprint(b, 0.2));
		} else pts.push(new Vector3());
		const midZ = (layout.bounds.minZ + layout.bounds.maxZ) / 2;
		const s: Cam = {
			target: new Vector3(0, 0, midZ),
			az: AZ,
			el: EL,
			dist: 60,
		};
		const padX = 0.97;
		const padTop = 0.84;
		const padBot = 0.97;
		for (let pass = 0; pass < 3; pass += 1) {
			let lo = 4;
			let hi = 900;
			for (let it = 0; it < 26; it += 1) {
				s.dist = (lo + hi) / 2;
				applyCam(s);
				const ok = pts.every((c) => {
					const p = tmp.copy(c).project(camera);
					return (
						p.z < 1 && Math.abs(p.x) <= padX && p.y <= padTop && p.y >= -padBot
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
			for (const c of pts) {
				const p = tmp.copy(c).project(camera);
				mnx = Math.min(mnx, p.x);
				mxx = Math.max(mxx, p.x);
				mny = Math.min(mny, p.y);
				mxy = Math.max(mxy, p.y);
			}
			const cx = (mnx + mxx) / 2;
			const cy = (mny + mxy) / 2 - (padTop - padBot) / 2;
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

	// ── name tags and the door bubble (aria-hidden; the side columns carry the words) ───────
	function makePin(id: string, anchor: Vector3, className: string): Pin {
		const root = document.createElement("div");
		root.className = className;
		root.dataset.pin = id;
		pinLayer.append(root);
		return { root, anchor, above: className === "cmp-bubble" };
	}

	function clearPins() {
		for (const p of pins.values()) p.root.remove();
		pins = new Map();
	}
	reg.defer(clearPins, "name tags");

	/** Names only (no state words in or on a building); the bubble says the newest report. */
	function pinTexts() {
		for (const r of model.repos) {
			const p = pins.get(r.repo_id);
			if (p) p.root.textContent = r.label;
		}
		const hq = pins.get("hq");
		if (hq) hq.root.textContent = "HQ";
		const door = pins.get("door");
		if (door) {
			door.root.textContent = "";
			if (model.door) {
				const b = document.createElement("b");
				b.textContent = model.door.label;
				door.root.append(b, ` ${model.door.text}`);
			}
			door.root.hidden = model.door === null;
		}
	}

	function placePins() {
		const w = host.clientWidth;
		const h = host.clientHeight;
		for (const p of pins.values()) {
			const v = tmp.copy(p.anchor).project(camera);
			const x = (v.x * 0.5 + 0.5) * w;
			const y = (-v.y * 0.5 + 0.5) * h;
			const out = v.z > 1 || x < -20 || x > w + 20 || y < -10 || y > h + 10;
			p.root.style.display = out ? "none" : "";
			if (out) continue;
			// centred on its anchor, but never past an edge of the stage (long names, the bubble)
			const pw = p.root.offsetWidth;
			const ph = p.root.offsetHeight;
			const left = Math.max(4, Math.min(w - pw - 4, x - pw / 2));
			const top = Math.max(4, Math.min(h - ph - 4, p.above ? y - ph : y));
			p.root.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
		}
	}

	// ── world (re)build, activity, owner, visitors ──────────────────────────────────
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
			pins.set(
				b.id,
				makePin(b.id, new Vector3(b.label.x, b.label.y, b.label.z), "cmp-pin"),
			);
		// the HQ's name sits on its roof; the bubble floats above its door, higher up
		pins.set(
			"hq",
			makePin(
				"hq",
				new Vector3(HQ_BOX.x, HQ_BOX.h + 0.8, HQ_BOX.z - 1),
				"cmp-pin cmp-pin-hq",
			),
		);
		pins.set(
			"door",
			makePin(
				"door",
				new Vector3(HQ_BOX.x, HQ_BOX.h + 7, HQ_BOX.z + HQ_BOX.d / 2),
				"cmp-bubble",
			),
		);
		const bx = (next.bounds.minX + next.bounds.maxX) / 2;
		const bz = (next.bounds.minZ + next.bounds.maxZ) / 2;
		const half = Math.max(
			52,
			(next.bounds.maxX - next.bounds.minX) / 2 + 14,
			(next.bounds.maxZ - next.bounds.minZ) / 2 + 14,
		);
		// a low evening sun from the west
		sun.position.set(bx - 70, 30, bz + 24);
		sun.target.position.set(bx, 0, bz);
		sun.target.updateMatrixWorld();
		const sc = sun.shadow.camera;
		sc.left = -half;
		sc.right = half;
		sc.top = half;
		sc.bottom = -half;
		sc.near = 10;
		sc.far = 260;
		sc.updateProjectionMatrix();
		renderer.shadowMap.needsUpdate = true;
		applyCam(fitOverview());
	}

	function syncVisitors() {
		const w = world;
		if (!w) return;
		const live = new Set(book.visits.map((v) => v.visit_id));
		for (const [id, v] of visitors) {
			if (live.has(id)) continue;
			w.root.remove(v.figure.group); // home again
			visitors.delete(id);
		}
		for (const visit of book.visits) {
			const have = visitors.get(visit.visit_id);
			if (have && have.visit.carry === visit.carry) {
				have.visit = visit;
				continue;
			}
			if (have) w.root.remove(have.figure.group); // what it carries changed
			const accent = w.buildings.get(visit.repo_id)?.accent ?? SCENE.brass;
			const figure = w.makeVisitor(visit.carry, accent, visit.seat);
			figure.group.traverse((o) => {
				o.castShadow = false;
			});
			w.root.add(figure.group);
			visitors.set(visit.visit_id, { visit, figure });
		}
		host.dataset.visitors = String(visitors.size); // QA hook
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
			// light one screen per running run, the picture matching its phase where the desk has one
			const lit = new Set<number>();
			for (const kind of r.monitors.slice(0, b.screens.length)) {
				let i = b.screens.findIndex((s, k) => !lit.has(k) && s.kind === kind);
				if (i < 0) i = b.screens.findIndex((_, k) => !lit.has(k));
				if (i >= 0) lit.add(i);
			}
			b.screens.forEach((s, i) => {
				s.mesh.material = lit.has(i)
					? w.screenMats[s.kind].lit
					: w.screenMats[s.kind].dim;
			});
			const tone = r.has_stopped
				? w.flagMats.danger
				: r.pending_requests > 0
					? w.flagMats.attention
					: null;
			if (b.flag) b.flag.material = tone ?? w.flagMats.none;
			if (b.marker) b.marker.visible = tone !== null;
			if (b.cloth && tone) b.cloth.material = tone;
			// "불 켜진 건물 = 일하는 중": warm floor and glass while a run is going, dark otherwise
			const on = r.active_tasks > 0;
			if (b.glow) {
				b.glow.emissive.set(on ? GLOW.on : "#000000");
				b.glow.emissiveIntensity = on ? GLOW.onIntensity : 0;
			}
			const glass = b.cutMats.glass;
			glass.color.set(on ? GLOW.glassOn : GLOW.glassOff);
			glass.emissive.set(on ? GLOW.on : "#000000");
			glass.emissiveIntensity = on ? 1.1 : 0;
			glass.opacity = on ? 0.55 : 0.7;
		}
		const docs = model.visitors.filter((v) => v.carry !== null).length;
		const n = Math.min(docs, w.hq.sheets.length);
		w.hq.sheets.forEach((s, i) => {
			s.visible = i < n;
		});
		w.owner.group.visible = model.owner_present;
		renderer.shadowMap.needsUpdate = true;
	}

	function update(input: EngineInput) {
		if (disposed) return;
		model = input.model;
		clock = setStill(clock, model.still, Date.now());
		const key = sceneKey(input.model, input.reducedMotion);
		if (key === lastKey) return;
		lastKey = key;
		reduced = input.reducedMotion;
		const nextLayout = campusLayout(model.repos.map((r) => r.repo_id));
		if (!world || nextLayout.key !== layout.key) rebuildWorld(nextLayout);
		// forget leads already home (also while the tab was hidden and no frame ran), then reconcile
		book = settleVisits(book, now(), walkMsOf, reduced);
		book = reconcileVisits(
			book,
			model.visitors,
			now(),
			walkMsOf,
			reduced,
			model.still,
		);
		syncVisitors();
		applyActivity();
		pinTexts();
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
		if (world) applyCam(fitOverview());
		needsRender = true;
		schedule();
	}
	const ro = new ResizeObserver(() => resize());
	reg.defer(() => ro.disconnect(), "resize observer");
	ro.observe(host);

	// ── page and GPU lifecycle (no input events: the scene is not operated) ─────────
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
