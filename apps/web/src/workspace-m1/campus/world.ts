// Business-campus scene graph (three objects only — no renderer, no canvas, no DOM), ported from
// the approved handover prototype (prototype/src/scene.js): plinths, concrete back walls, glass
// south/east façades with mullions, a partial roof over the back rooms (section cut), meeting room,
// CEO office, staff desks with monitors, review table, lounge; Headquarters with brass canopy,
// walnut floor, lobby seats, Edward's office (empty chair) and the decision board.
//
// Every geometry, material and texture is created through `Kit`, which records it in the
// DisposalRegistry at creation time (unit-tested: nothing reachable from `root` is untracked).
// Geometries are cached by dimensions and materials by colour, so figures and repeated furniture
// share them; adding or removing a visitor allocates no GPU resource.
import {
	BoxGeometry,
	type BufferGeometry,
	CylinderGeometry,
	DataTexture,
	EdgesGeometry,
	Group,
	LineBasicMaterial,
	LineSegments,
	type Material,
	Mesh,
	MeshBasicMaterial,
	MeshStandardMaterial,
	type MeshStandardMaterialParameters,
	type Object3D,
	PlaneGeometry,
	RGBAFormat,
	SphereGeometry,
	SRGBColorSpace,
} from "three";
import {
	type CampusLayout,
	FLOOR,
	HQ_BOX,
	lobbySpot,
	officeSeat,
	REPO_BOX,
	type Slot,
} from "./layout.ts";
import { mixHex, SCENE } from "./palette.ts";
import type { DisposalRegistry } from "./resources.ts";

interface BoxOpts {
	cast?: boolean;
	receive?: boolean;
	edges?: boolean;
}

const keyOf = (...n: number[]) => n.map((v) => v.toFixed(3)).join("|");

/** Factory that records every resource it creates. */
export class Kit {
	private readonly boxes = new Map<string, BoxGeometry>();
	private readonly edgeGeos = new Map<string, EdgesGeometry>();
	private readonly cyls = new Map<string, CylinderGeometry>();
	private readonly solids = new Map<string, MeshStandardMaterial>();
	readonly edge: LineBasicMaterial;

	constructor(readonly reg: DisposalRegistry) {
		this.edge = this.track(
			new LineBasicMaterial({
				color: "#4a524e",
				transparent: true,
				opacity: 0.3,
			}),
		);
	}

	track<T extends BufferGeometry | Material | DataTexture>(r: T): T {
		return this.reg.track(r, r.constructor.name);
	}

	boxGeo(w: number, h: number, d: number): BoxGeometry {
		const k = keyOf(w, h, d);
		let g = this.boxes.get(k);
		if (!g) {
			g = this.track(new BoxGeometry(w, h, d));
			this.boxes.set(k, g);
		}
		return g;
	}

	edgesGeo(w: number, h: number, d: number): EdgesGeometry {
		const k = keyOf(w, h, d);
		let g = this.edgeGeos.get(k);
		if (!g) {
			g = this.track(new EdgesGeometry(this.boxGeo(w, h, d)));
			this.edgeGeos.set(k, g);
		}
		return g;
	}

	cylGeo(rt: number, rb: number, h: number, seg: number): CylinderGeometry {
		const k = keyOf(rt, rb, h, seg);
		let g = this.cyls.get(k);
		if (!g) {
			g = this.track(new CylinderGeometry(rt, rb, h, seg));
			this.cyls.set(k, g);
		}
		return g;
	}

	/** Shared matte material by colour (+ options). */
	mat(
		hex: string,
		o: Omit<MeshStandardMaterialParameters, "color"> = {},
	): MeshStandardMaterial {
		const k = `${hex}|${JSON.stringify(o)}`;
		let m = this.solids.get(k);
		if (!m) {
			m = this.track(
				new MeshStandardMaterial({
					color: hex,
					roughness: 0.9,
					metalness: 0,
					...o,
				}),
			);
			this.solids.set(k, m);
		}
		return m;
	}

	/** A private copy (cutaway fades animate these per building). */
	clone(m: MeshStandardMaterial): MeshStandardMaterial {
		return this.track(m.clone());
	}

	box(
		parent: Object3D,
		w: number,
		h: number,
		d: number,
		mat: Material,
		x: number,
		yb: number,
		z: number,
		o: BoxOpts = {},
	): Mesh {
		const m = new Mesh(this.boxGeo(w, h, d), mat);
		m.position.set(x, yb + h / 2, z);
		m.castShadow = o.cast !== false;
		m.receiveShadow = o.receive !== false;
		if (o.edges) {
			const e = new LineSegments(this.edgesGeo(w, h, d), this.edge);
			e.userData.edge = true;
			m.add(e);
		}
		parent.add(m);
		return m;
	}

	cyl(
		parent: Object3D,
		rt: number,
		rb: number,
		h: number,
		seg: number,
		mat: Material,
		x: number,
		yb: number,
		z: number,
		o: BoxOpts = {},
	): Mesh {
		const m = new Mesh(this.cylGeo(rt, rb, h, seg), mat);
		m.position.set(x, yb + h / 2, z);
		m.castShadow = o.cast !== false;
		m.receiveShadow = o.receive !== false;
		parent.add(m);
		return m;
	}
}

// ── monitor screens: small procedural textures (DataTexture: no canvas, no DOM) ─────────

export type ScreenKind = "code" | "checks" | "review" | "ceo";

function screenPixels(kind: ScreenKind): Uint8Array {
	const W = 64;
	const H = 40;
	const px = new Uint8Array(W * H * 4);
	const put = (x: number, y: number, hex: string) => {
		if (x < 0 || y < 0 || x >= W || y >= H) return;
		const v = Number.parseInt(hex.slice(1), 16);
		const i = ((H - 1 - y) * W + x) * 4;
		px[i] = (v >> 16) & 255;
		px[i + 1] = (v >> 8) & 255;
		px[i + 2] = v & 255;
		px[i + 3] = 255;
	};
	const rect = (x: number, y: number, w: number, h: number, hex: string) => {
		for (let yy = y; yy < y + h; yy += 1)
			for (let xx = x; xx < x + w; xx += 1) put(xx, yy, hex);
	};
	let s = kind.length * 17 + 3;
	const rnd = () => {
		s = (s * 9301 + 49297) % 233280;
		return s / 233280;
	};
	rect(0, 0, W, H, "#1d2427");
	for (let i = 0; i < 9; i += 1) {
		const y = 3 + i * 4;
		if (kind === "checks") {
			rect(3, y, 2, 2, i === 6 ? "#e2a64a" : "#5fc2a8");
			rect(8, y, Math.round(20 + rnd() * 30), 1, "#9aa8ae");
		} else if (kind === "review") {
			rect(
				0,
				y - 1,
				W,
				3,
				i % 4 === 1 ? "#3c6b62" : i % 4 === 3 ? "#6b3f3a" : "#263034",
			);
			rect(4 + (i % 3) * 3, y, Math.round(15 + rnd() * 35), 1, "#b8c3c8");
		} else if (kind === "ceo") {
			if (i === 0) {
				rect(4, 4, 25, 32, "#d9d5c9");
				rect(33, 5, 27, 3, "#c9a24f");
			}
			if (i < 6) rect(6, 8 + i * 4, Math.round(15 + rnd() * 5), 1, "#8f8a7e");
			if (i < 2) rect(33, 12 + i * 4, 20 + i * 4, 1, "#9aa8ae");
		} else {
			rect(3, y, 3, 1, "#7d8f97");
			rect(
				8 + (i % 4) * 3,
				y,
				Math.round(10 + rnd() * 35),
				1,
				i % 3 === 0 ? "#d9b26a" : "#a9c3d9",
			);
		}
	}
	return px;
}

// ── figures (proportionate, ~1.72 units, from the prototype's makePerson) ───────────────

const SKIN = ["#e3b893", "#a8714c", "#f0cfb0", "#7a4d33", "#c99470"] as const;
const HAIR = ["#2b2420", "#5a3c26", "#1d1b1a", "#8a6a48", "#3a3532"] as const;

export type Posture = "stand" | "sit" | "walk";

export interface Figure {
	group: Group;
	setPosture(p: Posture, stride?: number): void;
}

interface FigureOpts {
	top: string;
	bottom: string;
	skin: string;
	hair: string;
	badge?: string;
	/** Visitors carry a document: a slim folder (run approval) or a binder (result acceptance). */
	carry?: "run" | "result";
}

// ── building handles ──────────────────────────────────────────────────────────────

export interface BuildingParts {
	id: string;
	kind: "repo" | "hq";
	group: Group;
	x: number;
	z: number;
	w: number;
	d: number;
	h: number;
	accent: string;
	roof: Group;
	/** Façade glass, mullions, canopy: hidden in the cutaway. */
	cut: Object3D[];
	cutMats: {
		roof: MeshStandardMaterial;
		fascia: MeshStandardMaterial;
		glass: MeshStandardMaterial;
		mull: MeshStandardMaterial;
	};
	edges: LineSegments[];
	/** Staff monitors, lit while the repository has active work. */
	screens: { mesh: Mesh; kind: ScreenKind }[];
	flag: Mesh | null;
	sheets: Mesh[];
	hit: Mesh;
	/** World point the visual name tag is pinned to. */
	label: { x: number; y: number; z: number };
	/** 1 = closed, 0 = cut away (animated by the engine). */
	cutValue: number;
	homeCeo: Figure | null;
}

export interface CampusWorld {
	root: Group;
	buildings: Map<string, BuildingParts>;
	hq: BuildingParts;
	picks: Mesh[];
	screenMats: Record<
		ScreenKind,
		{ lit: MeshBasicMaterial; dim: MeshBasicMaterial }
	>;
	flagMats: { none: Material; attention: Material; danger: Material };
	edgeMat: LineBasicMaterial;
	accentEdge(hex: string): LineBasicMaterial;
	makeVisitor(kind: "run" | "result", accent: string, seat: number): Figure;
}

export function buildCampusWorld(
	layout: CampusLayout,
	reg: DisposalRegistry,
): CampusWorld {
	const kit = new Kit(reg);
	const P = SCENE;
	const M = {
		site: kit.mat(mixHex(P.paving, "#a6a8a3", 0.32)),
		paving: kit.mat(P.paving),
		asphalt: kit.mat(P.asphalt),
		curb: kit.mat(mixHex(P.concrete, "#ffffff", 0.25)),
		lawn: kit.mat(mixHex(P.planting, P.paving, 0.35)),
		planting: kit.mat(P.planting, { flatShading: true }),
		plantingDark: kit.mat(mixHex(P.planting, "#2f3a2c", 0.25), {
			flatShading: true,
		}),
		trunk: kit.mat("#6b5a48"),
		concrete: kit.mat(P.concrete),
		concreteDeep: kit.mat(mixHex(P.concrete, "#6d685f", 0.28)),
		roof: kit.mat(P.roof),
		metal: kit.mat(P.metal, { roughness: 0.55, metalness: 0.25 }),
		metalLight: kit.mat(mixHex(P.metal, "#ffffff", 0.45), {
			roughness: 0.6,
			metalness: 0.2,
		}),
		glass: kit.mat(P.glass, {
			transparent: true,
			opacity: 0.26,
			roughness: 0.12,
			metalness: 0.1,
			depthWrite: false,
		}),
		partition: kit.mat(P.glass, {
			transparent: true,
			opacity: 0.18,
			roughness: 0.12,
			metalness: 0.1,
			depthWrite: false,
		}),
		oak: kit.mat(P.oak),
		floorOak: kit.mat(mixHex(P.oak, "#d6d6d2", 0.74)),
		walnut: kit.mat(P.walnut),
		floorWalnut: kit.mat(mixHex(P.walnut, "#c4c2bb", 0.7)),
		white: kit.mat("#f3f2ee"),
		paper: kit.mat("#fbfaf6"),
		dark: kit.mat("#2a3033"),
		chair: kit.mat("#3f474b"),
		fabric: kit.mat("#8b8e86"),
		rug: kit.mat(mixHex(P.concrete, P.metal, 0.18)),
		brass: kit.mat(P.brass, { roughness: 0.45, metalness: 0.4 }),
		carGlass: kit.mat("#3a464c", { roughness: 0.25 }),
		stripe: kit.mat("#f2f1ec"),
		board: kit.mat("#b9a789"),
	};
	const hitMat = kit.track(new MeshBasicMaterial({ visible: false }));
	const accentEdges = new Map<string, LineBasicMaterial>();
	const accentEdge = (hex: string) => {
		let m = accentEdges.get(hex);
		if (!m) {
			m = kit.track(
				new LineBasicMaterial({ color: hex, transparent: true, opacity: 0.95 }),
			);
			accentEdges.set(hex, m);
		}
		return m;
	};

	const screenGeo = kit.track(new PlaneGeometry(0.54, 0.32));
	const screenMats = {} as CampusWorld["screenMats"];
	for (const kind of ["code", "checks", "review", "ceo"] as const) {
		const tex = kit.track(
			new DataTexture(screenPixels(kind), 64, 40, RGBAFormat),
		);
		tex.colorSpace = SRGBColorSpace;
		tex.needsUpdate = true;
		screenMats[kind] = {
			lit: kit.track(
				new MeshBasicMaterial({
					map: tex,
					color: "#ffffff",
					toneMapped: false,
				}),
			),
			dim: kit.track(
				new MeshBasicMaterial({
					map: tex,
					color: "#5e6a70",
					toneMapped: false,
				}),
			),
		};
	}
	const flagMats = {
		none: M.concrete,
		attention: kit.mat(P.attention, { roughness: 0.6 }),
		danger: kit.mat(P.danger, { roughness: 0.6 }),
	};

	const root = new Group();
	root.name = "campus";
	const picks: Mesh[] = [];

	// ── furniture ──────────────────────────────────────────────────────────────
	const desk = (
		parent: Object3D,
		x: number,
		z: number,
		rotY: number,
		o: {
			w?: number;
			d?: number;
			top?: Material;
			monitor?: boolean;
			screen?: ScreenKind;
			paper?: boolean;
		} = {},
	): Mesh | null => {
		const g = new Group();
		g.position.set(x, FLOOR, z);
		g.rotation.y = rotY;
		parent.add(g);
		const w = o.w ?? 1.5;
		const d = o.d ?? 0.72;
		kit.box(g, w, 0.04, d, o.top ?? M.oak, 0, 0.72, 0);
		kit.box(g, 0.05, 0.72, d - 0.08, M.metal, -w / 2 + 0.06, 0, 0);
		kit.box(g, 0.05, 0.72, d - 0.08, M.metal, w / 2 - 0.06, 0, 0);
		kit.box(g, w - 0.2, 0.3, 0.02, M.metalLight, 0, 0.4, -d / 2 + 0.04, {
			cast: false,
		});
		let screen: Mesh | null = null;
		if (o.monitor !== false) {
			const kind = o.screen ?? "code";
			kit.box(g, 0.06, 0.2, 0.06, M.metal, 0, 0.76, -0.16);
			kit.box(g, 0.6, 0.38, 0.03, M.dark, 0, 0.94, -0.16);
			screen = new Mesh(screenGeo, screenMats[kind].dim);
			screen.position.set(0, 1.13, -0.143);
			screen.userData.screen = kind;
			g.add(screen);
			kit.box(g, 0.42, 0.015, 0.14, M.white, 0, 0.76, 0.12, { cast: false });
		}
		if (o.paper)
			kit.box(g, 0.22, 0.01, 0.3, M.paper, 0.45, 0.76, 0.05, { cast: false });
		return screen;
	};
	const chair = (parent: Object3D, x: number, z: number, rotY: number) => {
		const g = new Group();
		g.position.set(x, FLOOR, z);
		g.rotation.y = rotY;
		parent.add(g);
		kit.box(g, 0.46, 0.06, 0.46, M.chair, 0, 0.4, 0);
		kit.box(g, 0.44, 0.5, 0.06, M.chair, 0, 0.46, -0.22);
		kit.cyl(g, 0.03, 0.03, 0.38, 6, M.metal, 0, 0.02, 0);
		kit.box(g, 0.5, 0.03, 0.06, M.metal, 0, 0, 0, { cast: false });
		kit.box(g, 0.06, 0.03, 0.5, M.metal, 0, 0, 0, { cast: false });
	};
	const stool = (parent: Object3D, x: number, z: number) => {
		kit.cyl(parent, 0.19, 0.19, 0.05, 12, M.chair, x, FLOOR + 0.62, z);
		kit.cyl(parent, 0.025, 0.025, 0.62, 6, M.metal, x, FLOOR, z);
	};
	const plant = (parent: Object3D, x: number, z: number, h = 1.5) => {
		kit.box(parent, 0.5, 0.45, 0.5, M.concreteDeep, x, FLOOR, z);
		kit.cyl(parent, 0.12, 0.26, h, 7, M.planting, x, FLOOR + 0.45, z);
	};
	const tree = (x: number, z: number, s = 1) => {
		kit.cyl(root, 0.11 * s, 0.14 * s, 1.3 * s, 6, M.trunk, x, 0, z);
		kit.cyl(root, 0.18 * s, 0.85 * s, 3.4 * s, 7, M.planting, x, 1.1 * s, z);
		kit.cyl(root, 0.02, 0.18 * s, 0.9 * s, 7, M.planting, x, 4.5 * s, z);
	};
	const glassPartition = (
		g: Object3D,
		len: number,
		h: number,
		x: number,
		z: number,
		alongX: boolean,
	) => {
		if (alongX) {
			kit.box(g, len, h, 0.04, M.partition, x, FLOOR, z, {
				cast: false,
				receive: false,
			});
			kit.box(g, len, 0.06, 0.06, M.metal, x, FLOOR + h - 0.06, z, {
				cast: false,
			});
		} else {
			kit.box(g, 0.04, h, len, M.partition, x, FLOOR, z, {
				cast: false,
				receive: false,
			});
			kit.box(g, 0.06, 0.06, len, M.metal, x, FLOOR + h - 0.06, z, {
				cast: false,
			});
		}
	};

	// ── figures ────────────────────────────────────────────────────────────────
	const PG = {
		thigh: kit.boxGeo(0.15, 0.46, 0.17),
		shin: kit.boxGeo(0.13, 0.42, 0.15),
		shoe: kit.boxGeo(0.14, 0.07, 0.26),
		torso: kit.boxGeo(0.4, 0.58, 0.23),
		upper: kit.boxGeo(0.1, 0.32, 0.11),
		fore: kit.boxGeo(0.09, 0.3, 0.1),
		hand: kit.boxGeo(0.08, 0.09, 0.08),
		head: kit.track(new SphereGeometry(0.115, 16, 12)),
		hair: kit.track(
			new SphereGeometry(0.122, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
		),
		neck: kit.cylGeo(0.05, 0.05, 0.08, 8),
		badge: kit.boxGeo(0.07, 0.09, 0.01),
		folder: kit.boxGeo(0.26, 0.34, 0.018),
		folderTab: kit.boxGeo(0.09, 0.035, 0.018),
		binder: kit.boxGeo(0.28, 0.36, 0.07),
		spine: kit.boxGeo(0.045, 0.362, 0.074),
	};
	const docMats = {
		folder: kit.mat("#c9a85c", { roughness: 0.8 }),
		tab: kit.mat("#a88a43", { roughness: 0.8 }),
		binder: kit.mat("#eceee9", { roughness: 0.7 }),
		spine: kit.mat(P.ready, { roughness: 0.6 }),
	};
	const shoeMat = kit.mat("#26292b");

	const makeFigure = (o: FigureOpts): Figure => {
		const group = new Group();
		const body = new Group();
		group.add(body);
		const top = kit.mat(o.top);
		const bottom = kit.mat(o.bottom);
		const skin = kit.mat(o.skin);
		const hair = kit.mat(o.hair);
		const part = (
			geo: BufferGeometry,
			mat: Material,
			x: number,
			y: number,
			z: number,
			parent: Object3D,
		) => {
			const m = new Mesh(geo, mat);
			m.position.set(x, y, z);
			m.castShadow = true;
			parent.add(m);
			return m;
		};
		const legs: { hip: Group; knee: Group }[] = [];
		for (const s of [-1, 1]) {
			const hip = new Group();
			hip.position.set(s * 0.1, 0.92, 0);
			body.add(hip);
			part(PG.thigh, bottom, 0, -0.23, 0, hip);
			const knee = new Group();
			knee.position.set(0, -0.46, 0);
			hip.add(knee);
			part(PG.shin, bottom, 0, -0.21, 0, knee);
			part(PG.shoe, shoeMat, 0, -0.43, 0.05, knee);
			legs.push({ hip, knee });
		}
		part(PG.torso, top, 0, 1.21, 0, body);
		part(PG.neck, skin, 0, 1.53, 0, body);
		part(PG.head, skin, 0, 1.665, 0, body);
		const hr = part(PG.hair, hair, 0, 1.675, -0.01, body);
		hr.rotation.x = -0.25;
		const arms: { sh: Group; el: Group }[] = [];
		for (const s of [-1, 1]) {
			const sh = new Group();
			sh.position.set(s * 0.255, 1.46, 0);
			body.add(sh);
			part(PG.upper, top, 0, -0.16, 0, sh);
			const el = new Group();
			el.position.set(0, -0.32, 0);
			sh.add(el);
			part(PG.fore, top, 0, -0.15, 0, el);
			part(PG.hand, skin, 0, -0.32, 0, el);
			arms.push({ sh, el });
		}
		if (o.badge)
			part(
				PG.badge,
				kit.mat(o.badge, { roughness: 0.6 }),
				0.1,
				1.33,
				0.12,
				body,
			);
		if (o.carry && arms[1]) {
			const doc = new Group();
			doc.position.set(0, -0.32, 0.12);
			doc.rotation.x = 1.2;
			doc.scale.setScalar(1.5);
			arms[1].el.add(doc);
			if (o.carry === "run") {
				part(PG.folder, docMats.folder, 0, 0, 0, doc);
				part(PG.folderTab, docMats.tab, -0.07, 0.185, 0, doc);
			} else {
				part(PG.binder, docMats.binder, 0, 0, 0, doc);
				part(PG.spine, docMats.spine, -0.13, 0, 0, doc);
			}
		}
		const carryArm = () => {
			if (!o.carry || !arms[1]) return;
			arms[1].sh.rotation.x = -0.35;
			arms[1].el.rotation.x = -1.15;
		};
		const setPosture = (p: Posture, stride = 0) => {
			if (p === "sit") {
				body.position.y = -0.375;
				for (const l of legs) {
					l.hip.rotation.x = -Math.PI / 2;
					l.knee.rotation.x = Math.PI / 2;
				}
				for (const a of arms) {
					a.sh.rotation.x = -0.55;
					a.el.rotation.x = -0.9;
				}
				return;
			}
			body.position.y = 0;
			for (const a of arms) {
				a.sh.rotation.x = 0;
				a.el.rotation.x = 0;
			}
			if (p === "walk") {
				const s = Math.sin(stride * 2.4);
				const [l0, l1] = legs;
				if (l0 && l1) {
					l0.hip.rotation.x = s * 0.42;
					l1.hip.rotation.x = -s * 0.42;
					l0.knee.rotation.x = Math.max(0, -s) * 0.55;
					l1.knee.rotation.x = Math.max(0, s) * 0.55;
				}
				if (arms[0]) arms[0].sh.rotation.x = -s * 0.3;
				if (arms[1] && !o.carry) arms[1].sh.rotation.x = s * 0.3;
			} else
				for (const l of legs) {
					l.hip.rotation.x = 0;
					l.knee.rotation.x = 0;
				}
			carryArm();
		};
		setPosture("stand");
		return { group, setPosture };
	};

	// ── building shell (prototype `shell`) ───────────────────────────────────────
	interface ShellOpt {
		doorX: number;
		doorW: number;
		bay: number;
		canopy: Material;
		floor: Material;
		fascia: MeshStandardMaterial;
		roofRect: [number, number, number, number];
	}
	const shell = (g: Group, W: number, D: number, H: number, opt: ShellOpt) => {
		const cut: Object3D[] = [];
		const cutMats = {
			roof: kit.clone(M.roof),
			glass: kit.clone(M.glass),
			mull: kit.clone(M.metal),
			fascia: kit.clone(opt.fascia),
		};
		kit.box(g, W + 0.8, FLOOR, D + 0.8, M.concreteDeep, 0, 0, 0, {
			edges: true,
		});
		kit.box(g, W - 0.3, 0.02, D - 0.3, opt.floor, 0, FLOOR, 0, { cast: false });
		kit.box(g, W, H, 0.26, M.concrete, 0, FLOOR, -D / 2 + 0.13, {
			edges: true,
		});
		kit.box(g, 0.26, H, D, M.concrete, -W / 2 + 0.13, FLOOR, 0, {
			edges: true,
		});
		kit.box(g, W - 2, 0.9, 0.02, M.carGlass, 0, FLOOR + 1.6, -D / 2 - 0.005, {
			cast: false,
		});
		kit.box(g, W - 0.26, 0.32, 0.22, M.concrete, 0.13, FLOOR, D / 2 - 0.11, {
			edges: true,
		});
		kit.box(g, 0.22, 0.32, D - 0.26, M.concrete, W / 2 - 0.11, FLOOR, 0.13, {
			edges: true,
		});
		const gh = H - 0.32 - 0.1;
		const x0 = opt.doorX - opt.doorW / 2;
		const x1 = opt.doorX + opt.doorW / 2;
		const left = x0 - (-W / 2 + 0.26);
		const right = W / 2 - 0.22 - x1;
		const glassOpts = { cast: false, receive: false };
		cut.push(
			kit.box(
				g,
				left,
				gh,
				0.05,
				cutMats.glass,
				-W / 2 + 0.26 + left / 2,
				FLOOR + 0.32,
				D / 2 - 0.1,
				glassOpts,
			),
		);
		cut.push(
			kit.box(
				g,
				right,
				gh,
				0.05,
				cutMats.glass,
				x1 + right / 2,
				FLOOR + 0.32,
				D / 2 - 0.1,
				glassOpts,
			),
		);
		cut.push(
			kit.box(
				g,
				opt.doorW,
				H - 2.3,
				0.05,
				cutMats.glass,
				opt.doorX,
				FLOOR + 2.3,
				D / 2 - 0.1,
				glassOpts,
			),
		);
		cut.push(
			kit.box(
				g,
				0.05,
				gh,
				D - 0.26,
				cutMats.glass,
				W / 2 - 0.1,
				FLOOR + 0.32,
				0.13,
				glassOpts,
			),
		);
		for (let mx = -W / 2 + 0.26; mx <= W / 2 - 0.2; mx += opt.bay)
			cut.push(
				kit.box(g, 0.09, H - 0.1, 0.09, cutMats.mull, mx, FLOOR, D / 2 - 0.1),
			);
		for (let mz = -D / 2 + 0.26; mz <= D / 2; mz += opt.bay)
			cut.push(
				kit.box(g, 0.09, H - 0.1, 0.09, cutMats.mull, W / 2 - 0.1, FLOOR, mz),
			);
		cut.push(
			kit.box(g, W, 0.1, 0.1, cutMats.mull, 0, FLOOR + H - 0.1, D / 2 - 0.1),
		);
		cut.push(
			kit.box(g, 0.1, 0.1, D, cutMats.mull, W / 2 - 0.1, FLOOR + H - 0.1, 0),
		);
		cut.push(kit.box(g, 0.08, 2.3, 0.08, cutMats.mull, x0, FLOOR, D / 2 - 0.1));
		cut.push(kit.box(g, 0.08, 2.3, 0.08, cutMats.mull, x1, FLOOR, D / 2 - 0.1));
		cut.push(
			kit.box(
				g,
				opt.doorW,
				0.08,
				0.08,
				cutMats.mull,
				opt.doorX,
				FLOOR + 2.26,
				D / 2 - 0.1,
			),
		);
		// partial roof over the back rooms; the open floor reads from above as a section cut
		const [r0, r1, r2, r3] = opt.roofRect;
		const rx0 = r0 - (r0 <= -W / 2 ? 0.25 : 0);
		const rx1 = r1 + (r1 >= W / 2 ? 0.25 : 0);
		const rz0 = r2 - 0.25;
		const rz1 = r3;
		const rw = rx1 - rx0;
		const rdp = rz1 - rz0;
		const rcx = (rx0 + rx1) / 2;
		const rcz = (rz0 + rz1) / 2;
		const roof = new Group();
		roof.position.y = FLOOR + H;
		g.add(roof);
		const slab = kit.box(roof, rw, 0.32, rdp, cutMats.roof, rcx, 0, rcz, {
			edges: true,
		});
		slab.castShadow = false;
		kit.box(roof, rw, 0.36, 0.14, cutMats.fascia, rcx, 0.32, rz1 - 0.07, {
			cast: false,
		});
		kit.box(roof, rw, 0.36, 0.14, cutMats.roof, rcx, 0.32, rz0 + 0.07, {
			cast: false,
		});
		kit.box(roof, 0.14, 0.36, rdp, cutMats.roof, rx1 - 0.07, 0.32, rcz, {
			cast: false,
		});
		kit.box(roof, 0.14, 0.36, rdp, cutMats.roof, rx0 + 0.07, 0.32, rcz, {
			cast: false,
		});
		kit.box(
			roof,
			rw - 0.1,
			0.06,
			0.06,
			M.concreteDeep,
			rcx,
			-0.03,
			rz1 + 0.01,
			{ cast: false },
		);
		kit.box(
			roof,
			Math.min(1.8, rw / 4),
			0.9,
			1.3,
			cutMats.roof,
			rx0 + rw * 0.3,
			0.32,
			rcz,
			{ edges: true, cast: false },
		);
		kit.box(
			roof,
			Math.min(1.2, rw / 6),
			0.7,
			0.9,
			cutMats.roof,
			rx0 + rw * 0.3 + 2.2,
			0.32,
			rcz,
			{ edges: true, cast: false },
		);
		for (let bx = -W / 2 + opt.bay; bx < W / 2 - 0.3; bx += opt.bay) {
			const zs = bx > rx0 && bx < rx1 ? rz1 : -D / 2 + 0.26;
			const ze = D / 2 - 0.15;
			cut.push(
				kit.box(
					g,
					0.12,
					0.22,
					ze - zs,
					cutMats.mull,
					bx,
					FLOOR + H - 0.24,
					(zs + ze) / 2,
					{ cast: false },
				),
			);
		}
		cut.push(
			kit.box(
				g,
				opt.doorW + 1.2,
				0.14,
				1.5,
				opt.canopy,
				opt.doorX,
				FLOOR + 2.6,
				D / 2 + 0.65,
				{ edges: true },
			),
		);
		cut.push(
			kit.box(
				g,
				0.08,
				2.6,
				0.08,
				M.metal,
				opt.doorX - opt.doorW / 2 - 0.5,
				FLOOR,
				D / 2 + 1.3,
			),
		);
		cut.push(
			kit.box(
				g,
				0.08,
				2.6,
				0.08,
				M.metal,
				opt.doorX + opt.doorW / 2 + 0.5,
				FLOOR,
				D / 2 + 1.3,
			),
		);
		return { cut, roof, cutMats };
	};

	const collectEdges = (g: Object3D): LineSegments[] => {
		const out: LineSegments[] = [];
		g.traverse((o) => {
			if (o instanceof LineSegments && o.userData.edge) out.push(o);
		});
		return out;
	};

	const addHit = (
		g: Group,
		W: number,
		D: number,
		H: number,
		pick: { kind: "repo"; id: string } | { kind: "hq" },
	) => {
		const h = kit.box(g, W + 1, H + 0.8, D + 1, hitMat, 0, 0, 0, {
			cast: false,
			receive: false,
		});
		h.userData.pick = pick;
		picks.push(h);
		return h;
	};

	// ── repository building ──────────────────────────────────────────────────────
	const buildRepo = (slot: Slot): BuildingParts => {
		const { w: RW, d: RD, h: RH } = REPO_BOX;
		const g = new Group();
		g.position.set(slot.x, 0, slot.z);
		g.name = `repo:${slot.repo_id}`;
		root.add(g);
		const accent = kit.mat(slot.accent, { roughness: 0.6 });
		const sh = shell(g, RW, RD, RH, {
			doorX: 4.7,
			doorW: 1.8,
			bay: 2.3,
			canopy: accent,
			floor: M.floorOak,
			fascia: M.roof,
			roofRect: [-RW / 2, RW / 2, -RD / 2, -1.25],
		});
		// meeting room (north-west), under the roof until the building is selected
		glassPartition(g, 4.1, RH - 0.1, -3.2, -3.45, false);
		glassPartition(g, 3.8, RH - 0.1, -6.0, -1.4, true);
		kit.box(g, 4.4, 0.02, 3.6, M.rug, -5.6, FLOOR + 0.02, -3.45, {
			cast: false,
		});
		kit.box(g, 2.6, 0.05, 1.1, M.oak, -5.6, FLOOR + 0.72, -3.45);
		kit.box(g, 0.12, 0.72, 0.6, M.metal, -6.5, FLOOR, -3.45);
		kit.box(g, 0.12, 0.72, 0.6, M.metal, -4.7, FLOOR, -3.45);
		for (const dx of [-0.85, 0, 0.85]) {
			chair(g, -5.6 + dx, -4.35, 0);
			chair(g, -5.6 + dx, -2.55, Math.PI);
		}
		const wb = new Group();
		wb.position.set(-7.73, FLOOR + 0.9, -3.45);
		wb.rotation.y = Math.PI / 2;
		g.add(wb);
		kit.box(wb, 2.6, 1.3, 0.04, M.white, 0, 0, 0, { cast: false });
		const notes = ["#e7c9a0", "#bcd3c8", "#c9d3e6"];
		for (let c = 0; c < 3; c += 1)
			for (let r = 0; r < 3 - (c === 1 ? 1 : 0); r += 1)
				kit.box(
					wb,
					0.36,
					0.26,
					0.012,
					kit.mat(notes[c] ?? "#e7c9a0"),
					-0.85 + c * 0.85,
					0.82 - r * 0.36,
					0.03,
					{ cast: false },
				);
		// CEO office (north-east)
		glassPartition(g, 3.9, RH - 0.1, 3.6, -3.55, false);
		glassPartition(g, 1.0, RH - 0.1, 7.5, -1.6, true);
		glassPartition(g, 1.9, RH - 0.1, 4.55, -1.6, true);
		desk(g, 5.8, -3.85, Math.PI, { w: 1.7, screen: "ceo", paper: true });
		chair(g, 5.8, -4.62, 0);
		kit.box(g, 0.4, 1.8, 1.4, M.walnut, 7.7, FLOOR, -4.3);
		plant(g, 7.4, -2.1, 1.2);
		// open office: three staff desks, screens toward the viewer, and the facing desks
		const screens: BuildingParts["screens"] = [];
		const stations: [number, ScreenKind][] = [
			[-2.4, "code"],
			[0, "checks"],
			[2.4, "review"],
		];
		for (const [sx, kind] of stations) {
			const s = desk(g, sx, 1.2, 0, { screen: kind, w: 1.6 });
			if (s) screens.push({ mesh: s, kind });
			chair(g, sx, 1.98, Math.PI);
		}
		desk(g, -2.4, 0.42, Math.PI, { w: 1.6, monitor: false, paper: true });
		desk(g, 0, 0.42, Math.PI, { w: 1.6, monitor: false });
		desk(g, 2.4, 0.42, Math.PI, { w: 1.6, monitor: false });
		// review table (standing height) with stools
		kit.box(g, 3.0, 0.05, 0.95, M.oak, -1.6, FLOOR + 0.95, 3.9);
		kit.box(g, 0.1, 0.95, 0.7, M.metal, -2.9, FLOOR, 3.9);
		kit.box(g, 0.1, 0.95, 0.7, M.metal, -0.3, FLOOR, 3.9);
		kit.box(g, 0.34, 0.02, 0.24, M.dark, -2.1, FLOOR + 1.0, 3.95, {
			cast: false,
		});
		for (const dx of [-1, 0, 1]) stool(g, -1.6 + dx, 3.25);
		// kitchenette, lounge, storage wall
		kit.box(g, 0.65, 0.92, 2.2, M.white, -7.5, FLOOR, 0.6);
		kit.box(g, 0.66, 0.04, 2.22, M.walnut, -7.5, FLOOR + 0.92, 0.6);
		kit.box(g, 0.32, 0.4, 0.3, M.dark, -7.55, FLOOR + 0.96, 0.0);
		plant(g, 6.9, 4.4, 1.4);
		kit.box(g, 3.0, 0.02, 2.2, M.rug, -5.6, FLOOR + 0.02, 3.9, { cast: false });
		kit.box(g, 2.2, 0.42, 0.8, M.fabric, -5.6, FLOOR, 4.9);
		kit.box(g, 2.2, 0.4, 0.18, M.fabric, -5.6, FLOOR + 0.42, 5.22);
		kit.box(g, 0.8, 0.42, 1.4, M.fabric, -6.9, FLOOR, 3.95);
		kit.box(g, 1.1, 0.36, 0.6, M.oak, -5.4, FLOOR, 3.6);
		kit.box(g, 5.6, 0.85, 0.5, M.oak, 0.2, FLOOR, -5.12, { edges: true });
		kit.box(g, 0.6, 0.45, 0.45, M.white, 2.4, FLOOR + 0.85, -5.1);
		kit.box(g, 1.6, 0.9, 0.03, M.dark, -1.6, FLOOR + 1.45, -5.33, {
			cast: false,
		});
		// sign monolith by the entrance; its cap carries the attention / integrity tone
		const sign = new Group();
		sign.position.set(slot.x + 7.6, 0, slot.z + RD / 2 + 2.6);
		root.add(sign);
		kit.box(sign, 1.6, 1.0, 0.36, M.concrete, 0, 0, 0, { edges: true });
		kit.box(sign, 1.6, 0.14, 0.38, accent, 0, 1.0, 0);
		const flag = kit.box(sign, 0.36, 0.14, 0.4, flagMats.none, 0.55, 1.14, 0, {
			cast: false,
		});
		const hit = addHit(g, RW, RD, RH, { kind: "repo", id: slot.repo_id });
		// staff, seated; the CEO at home in the office while no document is out
		const palette: [string, string][] = [
			["#2f4a6d", "#3a3f44"],
			["#5d6b4a", "#2f3336"],
			["#7d5a48", "#3d4246"],
		];
		stations.forEach(([sx], k) => {
			const pal = palette[k] ?? palette[0] ?? ["#2f4a6d", "#3a3f44"];
			const p = makeFigure({
				top: pal[0],
				bottom: pal[1],
				skin: SKIN[(k + slot.index) % SKIN.length] ?? SKIN[0],
				hair: HAIR[(k * 2 + slot.index) % HAIR.length] ?? HAIR[0],
			});
			p.group.position.set(slot.x + sx, FLOOR, slot.z + 1.98);
			p.group.rotation.y = Math.PI;
			p.setPosture("sit");
			root.add(p.group);
		});
		const ceo = makeFigure({
			top: SCENE.graphite,
			bottom: "#2a2e31",
			skin: SKIN[(slot.index + 3) % SKIN.length] ?? SKIN[0],
			hair: HAIR[(slot.index + 1) % HAIR.length] ?? HAIR[0],
			badge: slot.accent,
		});
		const [cx, cz] = officeSeat(slot);
		ceo.group.position.set(cx, FLOOR, cz);
		ceo.setPosture("sit");
		root.add(ceo.group);
		const parts: BuildingParts = {
			id: slot.repo_id,
			kind: "repo",
			group: g,
			x: slot.x,
			z: slot.z,
			w: RW,
			d: RD,
			h: RH,
			accent: slot.accent,
			roof: sh.roof,
			cut: sh.cut,
			cutMats: sh.cutMats,
			edges: [],
			screens,
			flag,
			sheets: [],
			hit,
			// on the side away from the axis, clear of the walk from the door to HQ
			label: {
				x: slot.x < 0 ? slot.x - 3.8 : slot.x + 11,
				y: 1.2,
				z: slot.z + RD / 2 + 2.4,
			},
			cutValue: 1,
			homeCeo: ceo,
		};
		parts.edges = [...collectEdges(g), ...collectEdges(sign)];
		return parts;
	};

	// ── Headquarters ─────────────────────────────────────────────────────────────
	const buildHq = (): BuildingParts => {
		const { x: hx, z: hz, w: HW, d: HD, h: HH } = HQ_BOX;
		const g = new Group();
		g.position.set(hx, 0, hz);
		g.name = "hq";
		root.add(g);
		const sh = shell(g, HW, HD, HH, {
			doorX: 0,
			doorW: 2.6,
			bay: 2.4,
			canopy: M.brass,
			floor: M.floorWalnut,
			fascia: M.brass,
			roofRect: [-HW / 2, 1.5, -HD / 2, -1.7],
		});
		// Edward's office (north-east): desk, empty chair, bookshelf, decision board
		glassPartition(g, 6.3, HH - 0.1, 1.5, -3.85, false);
		glassPartition(g, 7.6, HH - 0.1, 7.2, -0.7, true);
		kit.box(g, 8.6, 0.02, 5.6, M.rug, 6.3, FLOOR + 0.02, -3.9, { cast: false });
		const ed = new Group();
		ed.position.set(6.5, 0, -4.4);
		g.add(ed);
		kit.box(ed, 2.6, 0.07, 1.15, M.walnut, 0, FLOOR + 0.72, 0, { edges: true });
		kit.box(ed, 0.1, 0.72, 1.0, M.walnut, -1.2, FLOOR, 0);
		kit.box(ed, 0.1, 0.72, 1.0, M.walnut, 1.2, FLOOR, 0);
		kit.box(ed, 2.3, 0.5, 0.05, M.walnut, 0, FLOOR + 0.2, -0.45);
		kit.box(ed, 0.6, 0.38, 0.03, M.dark, -0.5, FLOOR + 0.95, -0.3);
		kit.box(ed, 0.3, 0.012, 0.4, M.paper, 0.6, FLOOR + 0.8, 0.1, {
			cast: false,
		});
		chair(g, 6.5, -5.3, 0);
		const board = new Group();
		board.position.set(6.5, FLOOR + 1.3, -HD / 2 + 0.3);
		g.add(board);
		kit.box(board, 4.2, 1.4, 0.04, M.board, 0, 0, 0, { cast: false });
		const sheets: Mesh[] = [];
		for (let i = 0; i < 6; i += 1) {
			const s = kit.box(
				board,
				0.42,
				0.56,
				0.012,
				M.paper,
				-1.6 + i * 0.64,
				0.42,
				0.03,
				{ cast: false },
			);
			s.visible = false;
			sheets.push(s);
		}
		// lobby: waiting seats (west), reception, lounge; conference table; shelving
		for (let j = 0; j < 5; j += 1) {
			const spot = lobbySpot(j);
			chair(g, spot.x - hx, spot.z - hz, Math.PI / 2);
		}
		kit.box(g, 3.4, 1.05, 0.7, M.walnut, 6.6, FLOOR, 3.1, { edges: true });
		kit.box(g, 0.7, 1.05, 1.6, M.walnut, 8.65, FLOOR, 3.55);
		chair(g, 6.6, 2.3, 0);
		kit.box(g, 4.2, 0.06, 1.5, M.oak, -5.4, FLOOR + 0.72, -4.2);
		kit.box(g, 0.12, 0.72, 1.0, M.metal, -7.0, FLOOR, -4.2);
		kit.box(g, 0.12, 0.72, 1.0, M.metal, -3.8, FLOOR, -4.2);
		for (const dx of [-1.4, -0.45, 0.45, 1.4]) {
			chair(g, -5.4 + dx, -5.2, 0);
			chair(g, -5.4 + dx, -3.2, Math.PI);
		}
		kit.box(g, 4.0, 2.0, 0.45, M.walnut, -6.5, FLOOR, -HD / 2 + 0.5);
		plant(g, 10.0, 5.6, 1.5);
		plant(g, -10.0, 5.6, 1.3);
		plant(g, 2.2, -6.2, 1.2);
		kit.box(g, 3.4, 0.02, 2.6, M.rug, -4.6, FLOOR + 0.02, 4.4, { cast: false });
		kit.box(g, 2.4, 0.42, 0.8, M.fabric, -4.6, FLOOR, 5.4);
		kit.box(g, 2.4, 0.4, 0.18, M.fabric, -4.6, FLOOR + 0.42, 5.72);
		kit.box(g, 1.2, 0.36, 0.7, M.oak, -4.6, FLOOR, 4.1);
		kit.box(g, 0.8, 0.42, 0.8, M.fabric, -6.3, FLOOR, 3.8);
		kit.box(g, 0.8, 0.42, 0.8, M.fabric, -2.9, FLOOR, 3.8);
		kit.box(g, 0.04, 1.0, 1.6, M.dark, -HW / 2 + 0.3, FLOOR + 1.4, -3.8, {
			cast: false,
		});
		kit.box(g, 0.45, 2.0, 2.4, M.walnut, 10.6, FLOOR, -4.6, { edges: true });
		const hit = addHit(g, HW, HD, HH, { kind: "hq" });
		const parts: BuildingParts = {
			id: "hq",
			kind: "hq",
			group: g,
			x: hx,
			z: hz,
			w: HW,
			d: HD,
			h: HH,
			accent: SCENE.brass,
			roof: sh.roof,
			cut: sh.cut,
			cutMats: sh.cutMats,
			edges: collectEdges(g),
			screens: [],
			flag: null,
			sheets,
			hit,
			label: { x: hx + 9, y: 1.2, z: hz + HD / 2 + 2.6 },
			cutValue: 1,
			homeCeo: null,
		};
		return parts;
	};

	// ── site: ground, roads, promenades, axis, planting, lamps ───────────────────
	const b = layout.bounds;
	const ground = new Mesh(kit.track(new PlaneGeometry(700, 700)), M.site);
	ground.rotation.x = -Math.PI / 2;
	ground.receiveShadow = true;
	root.add(ground);
	const slab = (
		w: number,
		d: number,
		mat: Material,
		x: number,
		z: number,
		h = 0.04,
	) => kit.box(root, w, h, d, mat, x, 0, z, { cast: false });
	const north = HQ_BOX.z - HQ_BOX.d / 2 - 9;
	const south = b.maxZ + 6;
	const west = b.minX - 6;
	const east = b.maxX + 6;
	const spanX = east - west + 6;
	const spanZ = south - north + 6;
	const midX = (east + west) / 2;
	const midZ = (south + north) / 2;
	slab(spanX, 6, M.asphalt, midX, south);
	slab(spanX, 6, M.asphalt, midX, north);
	slab(6, spanZ, M.asphalt, west, midZ);
	slab(6, spanZ, M.asphalt, east, midZ);
	for (let x = west + 3; x <= east - 3; x += 6) {
		slab(2.4, 0.18, M.stripe, x, south, 0.05);
		slab(2.4, 0.18, M.stripe, x, north, 0.05);
	}
	// HQ forecourt and the parking lot west of it
	slab(30, 5, M.paving, HQ_BOX.x, HQ_BOX.z + HQ_BOX.d / 2 + 2.4, 0.06);
	slab(14, 6, M.asphalt, HQ_BOX.x - 24, HQ_BOX.z - 1);
	for (let k = 0; k < 5; k += 1)
		slab(0.12, 4.8, M.stripe, HQ_BOX.x - 29.5 + k * 2.6, HQ_BOX.z - 1, 0.05);
	const cars: [string, number][] = [
		["#9aa3a8", -28.2],
		["#59636a", -25.6],
		["#7a5f4f", -20.4],
	];
	for (const [hex, cx] of cars) {
		const car = new Group();
		car.position.set(HQ_BOX.x + cx, 0, HQ_BOX.z - 1.2);
		root.add(car);
		kit.box(car, 1.8, 0.62, 4.1, kit.mat(hex, { roughness: 0.5 }), 0, 0.22, 0);
		kit.box(car, 1.6, 0.5, 2.1, M.carGlass, 0, 0.84, -0.2);
	}
	// promenades in front of each row, and the main axis from the forecourt to the last row
	const promW = b.maxX - b.minX + 4;
	const promX = (b.maxX + b.minX) / 2;
	for (const pz of layout.promenades)
		slab(promW, 3.2, M.paving, promX, pz, 0.06);
	const lastProm = layout.promenades[layout.promenades.length - 1] ?? 9;
	const axisFrom = HQ_BOX.z + HQ_BOX.d / 2 + 4.9;
	slab(
		3.6,
		lastProm - axisFrom + 1.6,
		M.paving,
		HQ_BOX.x,
		(lastProm + axisFrom) / 2,
		0.07,
	);
	// planting: lawn beds between mirrored pairs (two-column rows), hedges, columnar trees
	const rowsFull = new Set<number>();
	for (const s of layout.slots) if (s.x > 0) rowsFull.add(s.row);
	for (const row of rowsFull) {
		const rz = row * 20;
		if (layout.cols !== 2) continue;
		for (const [lx, lz] of [
			[-6.5, rz - 2.9],
			[6.5, rz - 2.9],
			[-6.5, rz + 3.1],
			[6.5, rz + 3.1],
		] as const) {
			kit.box(root, 8.2, 0.16, 4.6, M.curb, lx, 0, lz, { cast: false });
			kit.box(root, 7.8, 0.18, 4.2, M.lawn, lx, 0, lz, { cast: false });
		}
		for (const tx of [-10.9, 10.9]) tree(tx, rz + 0.1, 0.85);
	}
	for (const pz of layout.promenades) {
		for (const hx of [-11, 11])
			kit.box(root, 5, 0.75, 0.8, M.plantingDark, hx, 0, pz + 2.3);
		for (let lx = b.minX + 4; lx <= b.maxX - 2; lx += 12) {
			if (Math.abs(lx) < 3) continue;
			kit.cyl(root, 0.05, 0.07, 4.2, 6, M.metal, lx, 0, pz + 1.8);
			kit.box(root, 0.7, 0.1, 0.22, M.metal, lx + 0.25, 4.2, pz + 1.8);
		}
	}
	for (const [tx, tz] of [
		[west + 4, north + 5],
		[east - 4, north + 5],
		[west + 4, south - 4],
		[east - 4, south - 4],
		[HQ_BOX.x - 18, HQ_BOX.z - 11],
		[HQ_BOX.x + 18, HQ_BOX.z - 11],
		[HQ_BOX.x + 16, HQ_BOX.z + 2],
	] as const)
		tree(tx, tz, 1.05);
	for (const pz of layout.promenades) {
		tree(west + 4, pz, 1.0);
		tree(east - 4, pz, 1.0);
	}
	for (const [lx, lz] of [
		[-2.4, HQ_BOX.z + HQ_BOX.d / 2 + 8],
		[2.4, HQ_BOX.z + HQ_BOX.d / 2 + 8],
	] as const) {
		kit.cyl(root, 0.05, 0.07, 4.2, 6, M.metal, lx, 0, lz);
		kit.box(root, 0.7, 0.1, 0.22, M.metal, lx + 0.25, 4.2, lz);
	}

	const buildings = new Map<string, BuildingParts>();
	for (const slot of layout.slots) buildings.set(slot.repo_id, buildRepo(slot));
	const hq = buildHq();

	const makeVisitor = (
		kind: "run" | "result",
		accent: string,
		seat: number,
	): Figure =>
		makeFigure({
			top: SCENE.graphite,
			bottom: "#2a2e31",
			skin: SKIN[(seat + 3) % SKIN.length] ?? SKIN[0],
			hair: HAIR[(seat + 1) % HAIR.length] ?? HAIR[0],
			badge: accent,
			carry: kind,
		});

	return {
		root,
		buildings,
		hq,
		picks,
		screenMats,
		flagMats,
		edgeMat: kit.edge,
		accentEdge,
		makeVisitor,
	};
}
