// Adapted from renderer/scene-interior.mjs; see PROVENANCE.md.
// M2.8 Phase G: one department interior (Engineering) on the low-res WebGL renderer. Like the town (scene-town.mjs) it is a
// VIEW of TownWorld: TownWorld builds and collides the room from TownInteriors.getInterior(id) and runs the player, agents,
// the door and the camera focus. This module draws the same room data (app/town-interiors.js; room axes x east 0..W,
// z south 0..D, back wall at z < 0, near wall with the door gap at z = D):
//  - floor: one checker-tile image (1-unit tiles in the room's floor ramp, grout + bevel), rugs, the door mat and contact
//    shadows baked in (no coplanar decals);
//  - walls: thick boxes (data walls, 0.5 thick), back and sides at the data's 4.5 height with a lighter top band, the
//    near wall at the cutaway rest height 0.5 so it never hides the floor; the back wall carries the window (the
//    time-of-day sky and a city silhouette behind it), wall panels (whiteboard, clock, wall cabinet) stand in front of it;
//  - furniture: boxes for every 'box' item, painted per kind (books, drawers, doors, cushions), 'surface' items as small
//    boxes on their parent's top (monitors drawn off, as TownWorld does), plants and the floor lamp as a pot/base box
//    plus an alpha-cut camera-facing billboard;
//  - the door back to the plaza: frame posts on the near-wall ends at the gap, the mat inside it.
// Every box is snapped to the 1/16 grid so each face is exactly 16 texels per unit; footprints are within 1/32 of the
// collider rect TownWorld uses (data.obstacles). No fog indoors; dusk/night only change the window and light the lamps.
import {
	AdditiveBlending,
	BoxGeometry,
	Group,
	Mesh,
	MeshBasicMaterial,
	PlaneGeometry,
	Scene,
	Sprite,
	SpriteMaterial,
} from "three";
import { GLOW_SIZE, pixelTexture, rgbColor } from "../engine/alley-meshes.mjs";
import { hash01 } from "../engine/facade-gen.mjs";
import { makeGlow } from "../engine/street-gen.mjs";
import {
	createImage,
	fillRect,
	PX_PER_UNIT,
	setPx,
	strokeRect,
} from "../engine/textures.mjs";

const T = PX_PER_UNIT;
export const WALL_H = 4.5,
	WALL_T = 0.5,
	NEAR_H = 0.5,
	POST = 0.125,
	POST_H = 2.75;
export const snap16 = (v) => Math.round(v * T) / T;
export const hexRGB = (s) => {
	if (Array.isArray(s)) return s.slice(0, 3);
	const n =
		typeof s === "number" ? s : parseInt(String(s).replace("#", ""), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const shade = (c, k) =>
	c.map((v) => Math.max(0, Math.min(255, Math.round(v * k))));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const BOOKS = [
	[0x8c, 0x32, 0x26],
	[0x2c, 0x3c, 0x6e],
	[0xb8, 0x90, 0x3c],
	[0x3a, 0x74, 0x6a],
	[0xe8, 0xe0, 0xd4],
	[0x5c, 0x42, 0x29],
];
const POT = {
	top: [0xc4, 0x7a, 0x50],
	front: [0xa8, 0x5e, 0x3e],
	side: [0x8a, 0x46, 0x30],
	edge: [0x6a, 0x32, 0x22],
};
const SCREEN_OFF = [
	[0x0c, 0x14, 0x20],
	[0x13, 0x22, 0x38],
	[0x2c, 0x58, 0x78],
];
export const BILLBOARD = Object.freeze({
	plant_tall: [16, 30],
	plant_round: [18, 16],
	plant_snake: [8, 16],
	floor_lamp: [12, 40],
	// M2.9 T3: the other rooms' upright items
	plant_fern: [22, 18],
	plant_monstera: [20, 30],
	coat_rack: [12, 32],
	globe_stand: [14, 24],
	fabric_roll_stand: [14, 30],
}); // texels

// M2.9 T3: each department's floor pattern, drawn in that room's own floorPalette (app/town-interiors.js).
//  checker: 1-unit light/dark tiles (Engineering, M2.8); carpet: loop-pile speckle with a border band; tile: half-unit
//  square tiles with grout; planks: east-west boards with staggered joints; panel: raised-floor panels (1 unit, a bevel, a
//  vent grid every few panels). summary.floor names the pattern.
export const FLOOR_STYLES = Object.freeze({
	engineering: "checker",
	planning: "carpet",
	research: "tile",
	design: "planks",
	qa: "tile",
	operations: "panel",
	sportsgang: "checker",
});

// TownWorld's interior colliders for a room (town-world.js buildInterior, mirrored): its three wall boxes (0.4 thick), the
// two near-wall stubs either side of the exit (gap 1.2 each side), then every data obstacle (walls and furniture).
export function interiorColliderRects(data) {
	const W = data.width,
		D = data.depth,
		t = 0.4,
		ex = data.exit ? data.exit.x : W / 2,
		gap = 1.2;
	return [
		{ x0: -t, x1: W + t, z0: -t, z1: 0, tag: "wall" },
		{ x0: -t, x1: 0, z0: 0, z1: D + t, tag: "wall" },
		{ x0: W, x1: W + t, z0: 0, z1: D + t, tag: "wall" },
		{ x0: -t, x1: ex - gap, z0: D, z1: D + t, tag: "wall" },
		{ x0: ex + gap, x1: W + t, z0: D, z1: D + t, tag: "wall" },
	].concat(
		(data.obstacles || []).map((o) => ({
			x0: o.x,
			x1: o.x + o.w,
			z0: o.z,
			z1: o.z + o.d,
			tag: /wall/.test(o.kind) ? "wall" : "furniture",
			id: o.id,
		})),
	);
}
// The drawn wall boxes: back and sides full height, the near wall (both sides of the door gap) at NEAR_H, corners closed.
export function wallBoxes(data) {
	const W = data.width,
		D = data.depth,
		ex = data.exit ? data.exit.x : W / 2;
	const near = (data.nearWallSegments || []).filter(
		(s) => s.occlusionClass !== "partition",
	);
	const west = near.filter((s) => s.x <= ex),
		east = near.filter((s) => s.x > ex);
	const gx0 = west.length ? Math.max(...west.map((s) => s.x + s.w)) : ex - 1,
		gx1 = east.length ? Math.min(...east.map((s) => s.x)) : ex + 1;
	return [
		{
			name: "wall:back",
			x0: -WALL_T,
			x1: W + WALL_T,
			z0: -WALL_T,
			z1: 0,
			h: WALL_H,
			inner: "pz",
		},
		{
			name: "wall:west",
			x0: -WALL_T,
			x1: 0,
			z0: 0,
			z1: D,
			h: WALL_H,
			inner: "px",
		},
		{
			name: "wall:east",
			x0: W,
			x1: W + WALL_T,
			z0: 0,
			z1: D,
			h: WALL_H,
			inner: "nx",
		},
		{
			name: "wall:near-west",
			x0: -WALL_T,
			x1: gx0,
			z0: D,
			z1: D + WALL_T,
			h: NEAR_H,
			inner: "pz",
		},
		{
			name: "wall:near-east",
			x0: gx1,
			x1: W + WALL_T,
			z0: D,
			z1: D + WALL_T,
			h: NEAR_H,
			inner: "pz",
		},
	];
}

// ---- floor -------------------------------------------------------------------------------------------------------
// Checker tiles (1 unit = 16 texels) in the room's floor ramp: light / dark tiles, 1-texel grout on the south-east edges,
// a 1-texel bevel highlight on the north-west edges, sparse speckle. Rugs, the door mat and 1-texel contact shadows south
// and east of every furniture collider are painted on top. Row 0 = north edge (z -WALL_T), column 0 = west edge (x -WALL_T).
export function makeInteriorFloor(data, seed) {
	const W = data.width + 2 * WALL_T,
		D = data.depth + 2 * WALL_T,
		img = createImage(W * T, D * T);
	const ramp = (
		data.floorPalette || [
			"#4a2f22",
			"#6b4430",
			"#8a5a3a",
			"#a8744a",
			"#be8a58",
			"#d4a26a",
			"#e6bd86",
		]
	).map(hexRGB);
	const r = (i) => ramp[Math.max(0, Math.min(ramp.length - 1, i))];
	const light = r(5),
		dark = r(3),
		grout = r(2),
		bevelL = r(6),
		bevelD = r(4),
		o = WALL_T * T;
	const style = data.floorStyle || FLOOR_STYLES[data.id] || "checker",
		m = (v, n) => ((v % n) + n) % n;
	const RW = data.width * T,
		RD = data.depth * T;
	for (let j = 0; j < img.height; j++)
		for (let i = 0; i < img.width; i++) {
			const gx = i - o,
				gz = j - o,
				lu = m(gx, T),
				lv = m(gz, T),
				lit = ((Math.floor(gx / T) + Math.floor(gz / T)) & 1) === 0,
				h = hash01(seed, gx, gz);
			let c;
			if (style === "carpet") {
				// loop pile in the mid tones; a darker 6-texel border band inside the walls
				const border = gx < 6 || gz < 6 || gx >= RW - 6 || gz >= RD - 6,
					edge = gx === 6 || gz === 6 || gx === RW - 7 || gz === RD - 7;
				c = edge
					? r(2)
					: border
						? h < 0.5
							? r(2)
							: r(3)
						: ((gx + gz * 3) & 3) === 0 && h < 0.6
							? r(3)
							: h < 0.15
								? r(5)
								: r(4);
			} else if (style === "tile") {
				// half-unit tiles, light with a one-texel grout line, sparse speckle
				const hu = m(gx, 8),
					hv = m(gz, 8),
					alt = ((Math.floor(gx / 8) + Math.floor(gz / 8)) & 3) === 0;
				c =
					hu === 7 || hv === 7
						? grout
						: hu === 0 || hv === 0
							? bevelL
							: alt
								? r(4)
								: h < 0.05
									? r(4)
									: light;
			} else if (style === "planks") {
				// boards 6 texels wide running east-west, staggered butt joints
				const row = Math.floor(gz / 6),
					pv = m(gz, 6),
					shift = (hash01(seed + 3, row, 0) * 48) | 0,
					pu = m(gx + shift, 48);
				const tone =
					hash01(seed + 4, row, Math.floor((gx + shift) / 48)) < 0.5
						? r(4)
						: r(5);
				c =
					pv === 5
						? grout
						: pu === 47
							? r(2)
							: pv === 0
								? shade(tone, 1.08)
								: h < 0.06
									? r(3)
									: tone;
			} else if (style === "panel") {
				// raised-floor panels: bevel, darker seam, a vent grid on every third panel
				const vent =
					(Math.floor(gx / T) * 7 + Math.floor(gz / T) * 3) % 5 === 0 &&
					lu > 3 &&
					lu < 12 &&
					lv > 3 &&
					lv < 12;
				c =
					lu === T - 1 || lv === T - 1
						? r(1)
						: lu === 0 || lv === 0
							? bevelD
							: vent
								? (lu + lv) & 1
									? r(2)
									: r(3)
								: h < 0.03
									? r(3)
									: r(4);
			} else {
				// checker (Engineering, M2.8 Phase G, unchanged)
				c = lit ? light : dark;
				if (lu === T - 1 || lv === T - 1) c = grout;
				else if (lu === 0 || lv === 0) c = lit ? bevelL : bevelD;
				else if (h < 0.04) c = lit ? bevelD : grout;
			}
			setPx(img, i, j, c);
		}
	const at = (x, z) => [
		Math.round((x + WALL_T) * T),
		Math.round((z + WALL_T) * T),
	];
	(data.floor?.rugs || []).forEach((rug) => {
		const [x0, z0] = at(rug.x, rug.z),
			[x1, z1] = at(rug.x + rug.w, rug.z + rug.d),
			w = x1 - x0,
			d = z1 - z0;
		const cl = rug.colors || {},
			top = hexRGB(cl.top || "#5b7a63"),
			front = hexRGB(cl.front || "#46604f"),
			edge = hexRGB(cl.edge || "#34463b");
		fillRect(img, x0, z0, w, d, top);
		if (rug.kind === "door_mat") {
			strokeRect(img, x0, z0, w, d, edge);
			strokeRect(img, x0 + 1, z0 + 1, w - 2, d - 2, [0xd6, 0xb0, 0x58]);
			return;
		}
		strokeRect(img, x0 + 1, z0 + 1, w - 2, d - 2, front);
		strokeRect(img, x0, z0, w, d, edge);
		if (w > 24 && d > 24)
			strokeRect(img, x0 + 5, z0 + 5, w - 10, d - 10, front); // inner border line on the big rugs
	});
	interiorColliderRects(data)
		.filter((c) => c.tag === "furniture")
		.forEach((c) => {
			// contact shadow, south + east
			const [x0, z0] = at(snap16(c.x0), snap16(c.z0)),
				[x1, z1] = at(snap16(c.x1), snap16(c.z1));
			for (let i = x0 + 1; i <= x1; i++)
				setPx(img, i, z1, shade(readPx(img, i, z1), 0.72));
			for (let j = z0 + 1; j < z1; j++)
				setPx(img, x1, j, shade(readPx(img, x1, j), 0.72));
		});
	return img;
}
function readPx(img, x, y) {
	if (x < 0 || y < 0 || x >= img.width || y >= img.height) return [0, 0, 0];
	const i = (y * img.width + x) * 4;
	return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

// ---- walls -------------------------------------------------------------------------------------------------------
// Inner face of a wall: a lighter top band (5 texels, an edge line under it), plaster body with speckle, a wood wainscot
// (data height) on a dark skirting. The low near wall keeps the band and the skirting.
function paintWallFace(img, bg, seed) {
	const pal = (
		bg.wall?.palette || [
			"#6a5848",
			"#8e7a64",
			"#b39c80",
			"#cdb898",
			"#dfcdac",
			"#ece0c4",
		]
	).map(hexRGB);
	const p = (i) => pal[Math.max(0, Math.min(pal.length - 1, i))],
		w = img.width,
		h = img.height;
	const wain = Math.round((bg.wall?.wainscot?.height || 0.35) * T);
	const wood = hexRGB(bg.wall?.wainscot?.color || "#8a5a3a");
	for (let j = 0; j < h; j++)
		for (let i = 0; i < w; i++)
			setPx(img, i, j, hash01(seed, i >> 1, j >> 1) < 0.12 ? p(2) : p(3));
	fillRect(img, 0, 0, w, Math.min(5, h), p(5));
	fillRect(img, 0, 0, w, 1, p(4));
	fillRect(img, 0, Math.min(5, h - 1), w, 1, p(1));
	if (h > 24) {
		fillRect(img, 0, h - wain, w, wain, wood);
		fillRect(img, 0, h - wain, w, 1, shade(wood, 1.25));
	}
	fillRect(img, 0, h - 2, w, 2, shade(wood, 0.6));
}
// The back-wall window (data.background.windows, room units): trim frame, a cross mullion, a sill, and behind the glass the
// time's sky (preset sky -> haze, 4 bands) over a city silhouette from the backdrop palette; lit windows at dusk/night.
function paintWindow(img, win, bg, look, seed) {
	const x0 = Math.round((win.x0 + WALL_T) * T),
		x1 = Math.round((win.x1 + WALL_T) * T);
	const y0 = Math.round((WALL_H - win.y1) * T),
		y1 = Math.round((WALL_H - win.y0) * T),
		w = x1 - x0,
		h = y1 - y0;
	const sky = hexRGB(look.sky),
		haze = hexRGB(look.haze),
		trim = hexRGB(bg.wall?.trim || "#34463b");
	const city = (
		bg.backdrop?.palette || [
			"#4a5262",
			"#5e6878",
			"#76808e",
			"#8f98a2",
			"#a8b0b4",
		]
	)
		.slice(-5)
		.map(hexRGB);
	const night = look.time === "night",
		dusk = look.time === "dusk";
	// M2.9 T3: a backdrop palette may have fewer than 5 entries (Research has 3): clamp the index, fall back to the default grey.
	if (!city.length) city.push([0x76, 0x80, 0x8e]);
	const cityAt = (k) => city[Math.min(k, city.length - 1)];
	const tone = (k) =>
		night
			? shade(cityAt(k), 0.35)
			: dusk
				? mix(cityAt(k), [0x7a, 0x44, 0x5a], 0.45)
				: cityAt(k);
	for (let j = 0; j < h; j++) {
		const c = mix(sky, haze, Math.min(3, Math.floor((j / h) * 4)) / 3);
		fillRect(img, x0, y0 + j, w, 1, c);
	}
	for (let i = 0, k = 0; i < w; k++) {
		// towers: seeded widths and heights, two tones
		const bw = 6 + Math.floor(hash01(seed, k, 1) * 9),
			bh = Math.round(h * (0.3 + 0.45 * hash01(seed, k, 2))),
			c = tone(k & 1 ? 1 : 3),
			cw = Math.min(bw, w - i);
		fillRect(img, x0 + i, y1 - bh, cw, bh, c);
		for (let yy = y1 - bh + 2; yy < y1 - 1; yy += 3)
			for (let xx = x0 + i + 1; xx < x0 + i + cw - 1; xx += 2) {
				if (hash01(seed + 7, xx, yy) < (look.lit || 0))
					setPx(img, xx, yy, [0xff, 0xd8, 0x8a]);
				else if (!night && !dusk) setPx(img, xx, yy, shade(c, 0.85));
			}
		i += bw;
	}
	if (!night && !dusk)
		for (let k = 0; k < Math.min(w, h) - 4; k++)
			if (k % 7 < 2)
				setPx(img, x0 + 4 + k, y0 + 2 + k, mix(sky, [255, 255, 255], 0.5)); // glint
	strokeRect(img, x0 - 2, y0 - 2, w + 4, h + 4, shade(trim, 0.7));
	strokeRect(img, x0 - 1, y0 - 1, w + 2, h + 2, trim);
	fillRect(img, x0 + (w >> 1) - 1, y0, 2, h, trim);
	fillRect(img, x0, y0 + Math.round(h * 0.4), w, 1, trim);
	fillRect(
		img,
		x0 - 3,
		y1 + 1,
		w + 6,
		2,
		hexRGB((bg.wall?.palette || ["#ece0c4"]).slice(-1)[0]),
	);
	fillRect(img, x0 - 3, y1 + 3, w + 6, 1, shade(trim, 0.7));
}

// ---- furniture faces ---------------------------------------------------------------------------------------------
const FACES = ["px", "nx", "py", "ny", "pz", "nz"]; // BoxGeometry material order
const FRONT_OF = { south: "pz", north: "nz", east: "px", west: "nx" };
function faceSize(f, tx, ty, tz) {
	return f === "px" || f === "nx"
		? [tz, ty]
		: f === "py" || f === "ny"
			? [tx, tz]
			: [tx, ty];
}
// One face image (row 0 = top, as seen from outside): top = colors.top, front = colors.front, sides = colors.side (underside
// darker), a lit top row on vertical faces, a 1-texel edge outline; the front gets the kind's detail.
export function paintFace(item, f, w, h, seed) {
	const cl = item.colors || {},
		top = hexRGB(cl.top || "#a8744a"),
		front = hexRGB(cl.front || "#8a5a3a"),
		side = hexRGB(cl.side || "#6b4430");
	const edge = hexRGB(cl.edge || "#44301f"),
		isFront = f === FRONT_OF[item.facing || "south"],
		img = createImage(w, h);
	fillRect(
		img,
		0,
		0,
		w,
		h,
		f === "py" ? top : f === "ny" ? shade(side, 0.7) : isFront ? front : side,
	);
	if (f !== "py" && f !== "ny" && h > 2) fillRect(img, 0, 0, w, 1, top);
	if (isFront)
		paintDetail(img, item.kind, { top, front, side, edge }, seed, item);
	else if (f === "pz" && /desk|bench/.test(item.kind) && h > 6)
		fillRect(img, 1, 3, w - 2, h - 5, shade(side, 0.9)); // modesty panel
	strokeRect(img, 0, 0, w, h, edge);
	return img;
}
function paintDetail(img, kind, c, seed, item) {
	const w = img.width,
		h = img.height;
	if (kind === "wall_sign" && item && item.text) {
		// M2.9 T4: lit lettering on a dark board (Sportsgang lobby)
		fillRect(img, 1, 1, w - 2, h - 2, c.front);
		const tw = textWidth(item.text, 2),
			sc = tw + 4 <= w ? 2 : 1,
			x = Math.floor((w - textWidth(item.text, sc)) / 2),
			y = Math.floor((h - 5 * sc) / 2);
		drawText(img, item.text, x, y, sc, [0xf4, 0xf6, 0xfa]);
		return;
	}
	if (kind === "elevator") {
		// M2.9 T4: brushed steel doors, centre split, floor indicator
		fillRect(img, 1, 6, w - 2, h - 7, c.front);
		for (let x = 3; x < w - 3; x += 4)
			fillRect(img, x, 7, 1, h - 9, shade(c.front, 1.08));
		fillRect(img, w >> 1, 6, 1, h - 7, c.edge);
		fillRect(img, (w >> 1) - 4, 1, 8, 4, [0x1c, 0x2a, 0x52]);
		setPx(img, (w >> 1) - 1, 2, [0xff, 0xb0, 0x40]);
		setPx(img, w >> 1, 2, [0xff, 0xb0, 0x40]);
		fillRect(img, w - 3, h >> 1, 1, 2, [0x58, 0xc0, 0x6a]);
		return;
	}
	// M2.9 T3: the other rooms' kinds reuse these details: shelves of any name get books, benches and drafting tables the
	// desk front, drawers / fridges / flat files / hoods the cabinet doors, racks a slot-and-LED front.
	if (kind === "screen_door") {
		fillRect(img, 2, 2, w - 4, h - 4, [0x26, 0x3b, 0x48]);
		fillRect(img, 3, 3, w - 6, Math.round(h * 0.6), [0x40, 0x5e, 0x68]);
		fillRect(img, (w >> 1) - 1, 1, 2, h - 2, c.edge);
		fillRect(img, 1, h - 8, w - 2, 2, [0x72, 0x96, 0x92]);
		for (let y = 4; y < h - 10; y += 4) setPx(img, 5, y, [0x83, 0xa7, 0xaa]);
		return;
	}
	if (kind === "faregate") {
		fillRect(img, 2, 2, w - 4, 3, c.edge);
		fillRect(img, 2, 3, w - 4, 1, [0x48, 0x66, 0x70]);
		fillRect(img, 2, h - 5, w - 4, 2, c.side);
		return;
	}
	if (/rack$/.test(kind) && kind !== "coat_rack" && h > 8) {
		fillRect(img, 1, 1, w - 2, h - 2, shade(c.front, 0.8));
		for (let y = 3; y + 3 < h - 2; y += 4) {
			fillRect(img, 2, y, w - 4, 3, shade(c.side, 0.9));
			setPx(
				img,
				w - 4,
				y + 1,
				hash01(seed, w, y) < 0.7 ? [0x58, 0xc0, 0x6a] : [0xe8, 0xb0, 0x40],
			);
		}
		return;
	}
	if (/bookshelf|bookcase|stack_shelf|binder_shelf|material_shelf/.test(kind)) {
		for (let y = 2; y + 9 <= h - 3; y += 10) {
			fillRect(img, 2, y + 9, w - 4, 1, c.top);
			for (let x = 2; x < w - 2; ) {
				const bw = 1 + Math.floor(hash01(seed, x, y) * 3),
					bh = 5 + Math.floor(hash01(seed + 1, x, y) * 4);
				if (hash01(seed + 2, x, y) > 0.08)
					fillRect(
						img,
						x,
						y + 9 - bh,
						Math.min(bw, w - 2 - x),
						bh,
						BOOKS[Math.floor(hash01(seed + 3, x, y) * BOOKS.length)],
					);
				x += bw;
			}
		}
		fillRect(img, 1, 1, 1, h - 2, c.side);
		fillRect(img, w - 2, 1, 1, h - 2, c.side);
	} else if (/desk|table|bench/.test(kind) && h > 6) {
		fillRect(img, 1, 4, w - 2, h - 5, shade(c.edge, 0.9)); // knee space in shadow
		fillRect(img, 1, 1, w - 2, 3, c.front);
		fillRect(img, 1, 4, 2, h - 5, c.side);
		fillRect(img, w - 3, 4, 2, h - 5, c.side);
		if (kind !== "coffee_table" && w >= 32) {
			// drawer pedestal at the right end
			const px = w - 15;
			fillRect(img, px, 4, 12, h - 5, c.front);
			for (let y = 10; y < h - 2; y += 6) fillRect(img, px, y, 12, 1, c.side);
			for (let y = 6; y < h - 2; y += 6) fillRect(img, px + 5, y, 2, 1, c.edge);
		}
	} else if (
		/counter|cabinet|drawers|fridge|flat_file|hood|chamber/.test(kind) &&
		h > 8
	) {
		fillRect(img, 1, h - 3, w - 2, 2, shade(c.edge, 0.9));
		for (let x = 1; x < w - 2; x += 16) {
			strokeRect(img, x + 1, 3, Math.min(14, w - 2 - x), h - 7, c.side);
			fillRect(img, x + Math.min(12, w - 4 - x), 6, 1, 3, c.edge);
		}
	} else if (kind === "printer") {
		fillRect(img, 2, 4, w - 4, 2, c.edge);
		fillRect(img, 3, h - 7, w - 6, 3, c.side);
		setPx(img, w - 4, 2, [0x58, 0xc0, 0x6a]);
	} else if (kind === "water_cooler") {
		const b = Math.round(h * 0.38);
		fillRect(img, 1, 1, w - 2, b, [0x86, 0xb2, 0xc4]);
		fillRect(img, 2, 2, 2, b - 3, [0xc4, 0xe0, 0xe8]);
		fillRect(img, 1, b + 1, w - 2, 1, c.edge);
		fillRect(img, (w >> 1) - 1, b + 5, 2, 2, [0x40, 0x54, 0x8c]);
	} else if (kind === "sofa") {
		const back = Math.round(h * 0.45);
		fillRect(img, 1, 1, w - 2, back, c.top);
		for (
			let x = 6 + Math.round((w - 12) / 3);
			x < w - 7;
			x += Math.round((w - 12) / 3)
		)
			fillRect(img, x, back + 1, 1, h - back - 4, c.edge);
		fillRect(img, 1, 1, 5, h - 3, c.side);
		fillRect(img, w - 6, 1, 5, h - 3, c.side);
		fillRect(img, 1, h - 2, w - 2, 1, c.edge);
	} else if (/chair/.test(kind)) {
		fillRect(img, 2, 2, w - 4, Math.max(1, Math.round(h * 0.45)), c.top);
	} else if ((kind === "monitor" || kind === "laptop") && h > 4) {
		fillRect(img, 1, 1, w - 2, h - 2, SCREEN_OFF[0]); // drawn OFF: furniture never implies work
		fillRect(img, 2, 2, w - 4, h - 4, SCREEN_OFF[1]);
		for (let k = 0; k < Math.min(w, h) - 5; k++)
			if (k % 5 < 2) setPx(img, 3 + k, 3 + k, SCREEN_OFF[2]);
	} else if (kind === "whiteboard") {
		fillRect(img, 1, 1, w - 2, h - 3, [0xf4, 0xf2, 0xea]);
		const ink = [
			[0x2c, 0x58, 0x78],
			[0x8c, 0x32, 0x26],
			[0x46, 0x60, 0x4f],
		];
		for (let k = 0; k < 9; k++) {
			const x = 4 + Math.floor(hash01(seed, k, 1) * (w - 20)),
				y = 4 + Math.floor(hash01(seed, k, 2) * (h - 12)),
				len = 6 + Math.floor(hash01(seed, k, 3) * 12);
			fillRect(img, x, y, len, 1, ink[k % 3]);
			if (k % 3 === 0) strokeRect(img, x, y + 2, 5, 4, ink[(k + 1) % 3]);
		}
		fillRect(img, 1, h - 2, w - 2, 1, c.side);
	} else if (kind === "coffee_machine") {
		const y = Math.round(h * 0.45);
		fillRect(img, 3, y, w - 6, 3, c.edge);
		fillRect(img, (w >> 1) - 1, y + 3, 2, 3, [0xe8, 0xe0, 0xd4]);
	}
}
// Upright alpha-cut billboard art (row 0 = top): leaf blades (tall, snake: with its own pot), a round bush, a floor lamp.
export function paintBillboard(kind, w, h, cl, seed) {
	cl = cl || {};
	const img = createImage(w, h),
		leaf = [
			hexRGB(cl.side || "#3f6c3a"),
			hexRGB(cl.front || "#58884a"),
			hexRGB(cl.top || "#78a45e"),
		],
		edge = hexRGB(cl.edge || "#203a24");
	const on = (x, y) =>
		x >= 0 && y >= 0 && x < w && y < h && img.data[(y * w + x) * 4 + 3] > 0;
	if (kind === "coat_rack") {
		// M2.9 T3: pole, hooks, two coats
		const pole = hexRGB(cl.side || "#6b4430"),
			cx = (w >> 1) - 1;
		fillRect(img, cx, 2, 2, h - 2, pole);
		fillRect(img, 2, h - 2, w - 4, 2, pole);
		fillRect(img, 2, 4, w - 4, 1, pole);
		fillRect(img, 1, 5, 4, 12, hexRGB(cl.front || "#8c3226"));
		fillRect(img, w - 5, 5, 4, 10, hexRGB(cl.top || "#2c3c6e"));
	} else if (kind === "globe_stand") {
		// M2.9 T3: a globe on a stand
		const cx = w / 2,
			cy = 6.5,
			sea = [0x3a, 0x74, 0xa6],
			land = [0x58, 0x88, 0x4a];
		for (let y = 0; y < 13; y++)
			for (let x = 0; x < w; x++)
				if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= 6)
					setPx(img, x, y, hash01(seed, x >> 1, y >> 1) < 0.35 ? land : sea);
		fillRect(img, (w >> 1) - 1, 13, 2, h - 15, [0x8a, 0x5a, 0x3a]);
		fillRect(img, 3, h - 2, w - 6, 2, [0x6b, 0x44, 0x30]);
	} else if (kind === "fabric_roll_stand") {
		// M2.9 T3: an A-frame with three fabric rolls
		const wood = [0x8a, 0x5a, 0x3a];
		fillRect(img, 1, 2, 2, h - 2, wood);
		fillRect(img, w - 3, 2, 2, h - 2, wood);
		[
			[0xc4, 0x7a, 0x50],
			[0x3a, 0x74, 0x6a],
			[0xb8, 0x90, 0x3c],
		].forEach((c, k) => {
			fillRect(img, 2, 4 + k * 8, w - 4, 6, c);
		});
	} else if (kind === "floor_lamp") {
		fillRect(img, (w >> 1) - 1, 8, 2, h - 8, hexRGB(cl.side || "#7c8086"));
		for (let y = 0; y < 8; y++) {
			const inset = 1 + ((7 - y) >> 2);
			fillRect(
				img,
				inset,
				y,
				w - 2 * inset,
				1,
				y === 7 ? [0xbe, 0xb0, 0x90] : [0xeb, 0xe6, 0xd8],
			);
		}
	} else if (kind === "plant_round") {
		const cx = w / 2,
			cy = h / 2;
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				const r =
					((x + 0.5 - cx) / (w / 2 - 0.5)) ** 2 +
					((y + 0.5 - cy) / (h / 2 - 0.5)) ** 2;
				if (r <= 1 - 0.2 * hash01(seed, x >> 1, y >> 1))
					setPx(
						img,
						x,
						y,
						leaf[r < 0.35 && y < cy ? 2 : hash01(seed + 1, x, y) < 0.5 ? 1 : 0],
					);
			}
	} else if (kind === "plant_fern") {
		// M2.9 T3: a wide fern (round bush, flatter)
		const cx = w / 2,
			cy = h * 0.6;
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				const r =
					((x + 0.5 - cx) / (w / 2 - 0.5)) ** 2 +
					((y + 0.5 - cy) / (h * 0.6)) ** 2;
				if (
					r <= 1 - 0.3 * hash01(seed, x, y >> 1) &&
					((x + y) % 3 !== 0 || r < 0.4)
				)
					setPx(img, x, y, leaf[r < 0.3 ? 2 : (x + y) & 1 ? 1 : 0]);
			}
	} else {
		const snake = kind === "plant_snake",
			pot = snake ? 4 : 0,
			n = snake ? 3 : kind === "plant_monstera" ? 5 : 7,
			bottom = h - 1 - pot;
		for (let k = 0; k < n; k++) {
			const off = k - (n - 1) / 2,
				dx = off * (snake ? 0.08 : 0.28),
				len = Math.round(bottom * (0.55 + 0.45 * hash01(seed, k, 5)));
			for (let s = 0; s < len; s++)
				fillRect(
					img,
					Math.round((w >> 1) - 1 + off * (snake ? 2 : 0.6) + dx * s),
					bottom - s,
					2,
					1,
					leaf[s < len * 0.5 ? 1 : 2],
				);
		}
		if (pot) {
			fillRect(img, 1, h - pot, w - 2, pot, POT.front);
			fillRect(img, 1, h - pot, w - 2, 1, POT.top);
		}
	}
	const out = createImage(w, h); // 1-texel outline on the foliage
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			if (!on(x, y)) continue;
			const i = (y * w + x) * 4,
				rim = !on(x - 1, y) || !on(x + 1, y) || !on(x, y - 1) || !on(x, y + 1);
			setPx(
				out,
				x,
				y,
				rim &&
					!/floor_lamp|coat_rack|fabric_roll_stand|globe_stand/.test(kind) &&
					y < h - 4
					? edge
					: [img.data[i], img.data[i + 1], img.data[i + 2]],
			);
		}
	return out;
}

// ---- assembly ----------------------------------------------------------------------------------------------------
// look: the resolved interior preset ({ sky, haze, time, lit, glow }). Returns the room group, the object standing on each
// colliding furniture item (colliders: data id -> Object3D), lamp glows, a texture inventory and a summary.
export function buildInteriorMeshes(data, seed, look) {
	seed = seed == null ? 1 : seed;
	look = look || {
		sky: 0x8ec5ff,
		haze: 0xdff1ff,
		time: "day",
		lit: 0,
		glow: 0,
	};
	const disposables = [],
		inventory = [],
		colliders = new Map();
	const track = (d) => {
		disposables.push(d);
		return d;
	};
	const dispose = () => {
		for (const d of disposables.splice(0).reverse()) d.dispose?.();
	};
	try {
		const group = new Group();
		group.name = `interior:${data.id}`;
		let boxes = 0,
			billboards = 0;
		function texBox(name, x0, x1, y0, y1, z0, z1, painter) {
			const sx = x1 - x0,
				sy = y1 - y0,
				sz = z1 - z0,
				tx = Math.round(sx * T),
				ty = Math.round(sy * T),
				tz = Math.round(sz * T);
			if (tx < 1 || ty < 1 || tz < 1)
				throw new Error(`box ${name} is below one texel`);
			const mats = FACES.map((f) => {
				const [w, h] = faceSize(f, tx, ty, tz),
					img = painter(f, w, h);
				inventory.push({
					name: `${name}:${f}`,
					width: img.width,
					height: img.height,
				});
				return track(new MeshBasicMaterial({ map: track(pixelTexture(img)) }));
			});
			const m = new Mesh(track(new BoxGeometry(sx, sy, sz)), mats);
			m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
			m.name = name;
			boxes++;
			return m;
		}
		function billboard(name, kind, cx, y, cz, cl, s) {
			const [w, h] = BILLBOARD[kind],
				img = paintBillboard(kind, w, h, cl, s);
			inventory.push({ name, width: w, height: h });
			const sp = new Sprite(
				track(
					new SpriteMaterial({
						map: track(pixelTexture(img)),
						alphaTest: 0.5,
						transparent: false,
						depthWrite: true,
					}),
				),
			);
			sp.center.set(0.5, 0);
			sp.scale.set(w / T, h / T, 1);
			sp.position.set(cx, y, cz);
			sp.name = name;
			billboards++;
			return sp;
		}
		// floor
		const floorImg = makeInteriorFloor(data, seed),
			FW = data.width + 2 * WALL_T,
			FD = data.depth + 2 * WALL_T;
		inventory.push({
			name: "floor",
			width: floorImg.width,
			height: floorImg.height,
		});
		const floor = new Mesh(
			track(new PlaneGeometry(FW, FD)),
			track(new MeshBasicMaterial({ map: track(pixelTexture(floorImg)) })),
		);
		floor.rotation.x = -Math.PI / 2;
		floor.position.set(data.width / 2, 0, data.depth / 2);
		floor.name = "floor";
		group.add(floor);
		// walls
		const bg = data.background || {},
			wallCl = (data.walls || [])[0]?.colors || {};
		for (const b of wallBoxes(data)) {
			const m = texBox(b.name, b.x0, b.x1, 0, b.h, b.z0, b.z1, (f, w, h) => {
				const img = createImage(w, h);
				if (f === "py") {
					fillRect(
						img,
						0,
						0,
						w,
						h,
						shade(hexRGB(wallCl.top || "#dfcdac"), 1.06),
					);
					strokeRect(img, 0, 0, w, h, hexRGB(wallCl.edge || "#8e7a64"));
					return img;
				}
				if (f !== b.inner) {
					fillRect(img, 0, 0, w, h, hexRGB(wallCl.side || "#b39c80"));
					return img;
				}
				paintWallFace(img, bg, seed + w);
				if (b.name === "wall:back")
					(bg.windows || []).forEach((win) => {
						paintWindow(img, win, bg, look, seed);
					});
				return img;
			});
			m.userData.wall = true;
			group.add(m);
		}
		// furniture standing on the floor (data.furniture), snapped to the 1/16 grid
		const byId = new Map((data.furniture || []).map((f) => [f.id, f]));
		(data.furniture || []).forEach((it, k) => {
			const x0 = snap16(it.x),
				x1 = snap16(it.x + it.w),
				z0 = snap16(it.z),
				z1 = snap16(it.z + it.d),
				y0 = snap16(it.y || 0);
			let obj;
			if (it.render === "billboard" && BILLBOARD[it.kind]) {
				// a pot (plants) or a base plate (floor lamp) + the billboard on it
				obj = new Group();
				obj.name = it.id;
				const lamp = /floor_lamp|coat_rack|globe_stand|fabric_roll_stand/.test(
						it.kind,
					),
					baseH = lamp ? 0.125 : 0.5,
					base = { kind: "pot", colors: lamp ? it.colors : POT };
				obj.add(
					texBox(`${it.id}:base`, x0, x1, y0, y0 + baseH, z0, z1, (f, w, h) =>
						paintFace(base, f, w, h, seed),
					),
				);
				obj.add(
					billboard(
						`${it.id}:billboard`,
						it.kind,
						(x0 + x1) / 2,
						y0 + baseH,
						(z0 + z1) / 2,
						it.colors,
						seed + k,
					),
				);
			} else if (/chair/.test(it.kind)) {
				// seat block + backrest on the side away from the facing
				obj = new Group();
				obj.name = it.id;
				const seatH = 0.75,
					back = 0.1875,
					bz = it.facing === "north" ? [z1 - back, z1] : [z0, z0 + back];
				obj.add(
					texBox(`${it.id}:seat`, x0, x1, 0, seatH, z0, z1, (f, w, h) =>
						paintFace(it, f, w, h, seed + k),
					),
				);
				obj.add(
					texBox(
						`${it.id}:back`,
						x0 + 0.0625,
						x1 - 0.0625,
						seatH,
						snap16(it.h),
						bz[0],
						bz[1],
						(f, w, h) => paintFace(it, f, w, h, seed + k),
					),
				);
			} else {
				obj = texBox(it.id, x0, x1, y0, y0 + snap16(it.h), z0, z1, (f, w, h) =>
					paintFace(it, f, w, h, seed + k),
				);
			}
			if (it.collide) colliders.set(it.id, obj);
			group.add(obj);
		});
		// decorations: wall panels just in front of the back wall, surface items on their parent's top
		(data.decorations || []).forEach((dc, k) => {
			const x0 = snap16(dc.x),
				x1 = Math.max(snap16(dc.x + dc.w), x0 + 0.0625);
			if (dc.mount === "wall-north") {
				const y0 = snap16(dc.y),
					y1 = snap16(dc.y + dc.h),
					d = dc.kind === "wall_cabinet" ? snap16(dc.d) : 0.125;
				if (dc.kind === "wall_clock") {
					// a round dial: alpha-cut plane 1/16 in front of the wall
					const n = Math.round((x1 - x0) * T),
						img = createImage(n, n),
						c = n / 2,
						ink = [0x16, 0x17, 0x1b];
					for (let y = 0; y < n; y++)
						for (let x = 0; x < n; x++) {
							const r = Math.hypot(x + 0.5 - c, y + 0.5 - c);
							if (r <= c)
								setPx(
									img,
									x,
									y,
									r > c - 1.5 ? [0x30, 0x33, 0x3b] : [0xf8, 0xf4, 0xea],
								);
						}
					fillRect(img, n >> 1, 3, 1, (n >> 1) - 3, ink);
					fillRect(img, n >> 1, n >> 1, (n >> 1) - 4, 1, ink);
					inventory.push({ name: dc.id, width: n, height: n });
					const m = new Mesh(
						track(new PlaneGeometry(n / T, n / T)),
						track(
							new MeshBasicMaterial({
								map: track(pixelTexture(img)),
								alphaTest: 0.5,
							}),
						),
					);
					m.position.set((x0 + x1) / 2, y0 + n / T / 2, 0.0625);
					m.name = dc.id;
					group.add(m);
					return;
				}
				group.add(
					texBox(dc.id, x0, x1, y0, y1, 0, d, (f, w, h) =>
						paintFace(dc, f, w, h, seed + k),
					),
				);
				return;
			}
			const parent = byId.get(dc.parent),
				y0 = snap16(parent ? (parent.y || 0) + parent.h : dc.y || 0);
			const z0 = snap16(dc.z),
				z1 = Math.max(z0 + 0.0625, snap16(dc.z + dc.d));
			if (dc.render === "billboard" && BILLBOARD[dc.kind]) {
				group.add(
					billboard(
						dc.id,
						dc.kind,
						(x0 + x1) / 2,
						y0,
						(z0 + z1) / 2,
						dc.colors,
						seed + k,
					),
				);
				return;
			}
			group.add(
				texBox(
					dc.id,
					x0,
					x1,
					y0,
					y0 + Math.max(0.0625, snap16(dc.h)),
					z0,
					z1,
					(f, w, h) => paintFace(dc, f, w, h, seed + k),
				),
			);
		});
		// the door back to the plaza: frame posts standing on the near-wall ends either side of the gap
		const door = (data.doors || [])[0];
		if (door) {
			const postCl = hexRGB(door.frame?.color || "#34463b"),
				nb = wallBoxes(data),
				D = data.depth;
			[
				[nb[3].x1 - POST, nb[3].x1],
				[nb[4].x0, nb[4].x0 + POST],
			].forEach(([a, b], i) => {
				group.add(
					texBox(
						`door:post-${i ? "east" : "west"}`,
						a,
						b,
						NEAR_H,
						POST_H,
						D,
						D + WALL_T,
						(f, w, h) => {
							const img = createImage(w, h);
							fillRect(
								img,
								0,
								0,
								w,
								h,
								f === "py" ? shade(postCl, 1.3) : postCl,
							);
							strokeRect(img, 0, 0, w, h, shade(postCl, 0.6));
							return img;
						},
					),
				);
			});
		}
		// dusk/night: additive glows on the floor-lamp shade and the reading lamp (indoor lights are on at every time)
		const glows = [];
		if (look.glow > 0) {
			const glowMat = track(
				new SpriteMaterial({
					map: track(pixelTexture(makeGlow(GLOW_SIZE * T))),
					transparent: true,
					opacity: look.glow,
					blending: AdditiveBlending,
					depthWrite: false,
					depthTest: true,
					fog: false,
				}),
			);
			const lamps = (data.furniture || [])
				.filter((f) => f.kind === "floor_lamp")
				.map((f) => [
					snap16(f.x + f.w / 2),
					(f.y || 0) + 0.125 + 2.25,
					snap16(f.z + f.d / 2) + 0.25,
				])
				.concat(
					(data.decorations || [])
						.filter((d) => d.kind === "desk_lamp")
						.map((d) => {
							const p = byId.get(d.parent);
							return [
								snap16(d.x + d.w / 2),
								(p ? p.h : 0) + d.h,
								snap16(d.z + d.d / 2) + 0.25,
							];
						}),
				);
			lamps.forEach((p, i) => {
				const g = new Sprite(glowMat);
				g.scale.set(GLOW_SIZE * 0.75, GLOW_SIZE * 0.75, 1);
				g.position.set(p[0], p[1], p[2]);
				g.name = `glow:${i}`;
				group.add(g);
				glows.push(g);
			});
		}
		const summary = {
			department: data.id,
			title: data.title,
			floor: data.floorStyle || FLOOR_STYLES[data.id] || "checker",
			boxes,
			billboards,
			walls: wallBoxes(data).length,
			colliders: interiorColliderRects(data).length,
			furniture: (data.furniture || []).length,
			decorations: (data.decorations || []).length,
		};
		return {
			group,
			colliders,
			glows,
			inventory,
			lamps: glows.length,
			summary,
			dispose,
		};
	} catch (error) {
		dispose();
		throw error;
	}
}

// The scene: a flat indoor backdrop colour (preset.backdrop, also the letterbox), no fog, no sky gradient, no skyline.
export function buildInteriorScene(preset, data, seed) {
	if (!data || !Array.isArray(data.obstacles))
		throw new Error("the interior scene needs TownInteriors room data");
	const scene = new Scene();
	scene.background = rgbColor(
		hexRGB(preset.backdrop != null ? preset.backdrop : 0x1c1714),
	);
	const meshes = buildInteriorMeshes(data, seed, preset);
	scene.add(meshes.group);
	return {
		scene,
		meshes,
		skyline: null,
		dispose() {
			meshes.dispose();
		},
	};
}
