// M3.0 ring town (prompts/M30_RING.md §1.1–1.2): an elliptical boulevard around a central plaza with the leaderboard
// pylon, ten building lots on the outside. Single source of truth for the meshes (scene-ring.mjs), the collision world
// (ring-world.mjs), the orbit camera (orbit-camera.mjs) and the pylon (leaderboard.mjs): every exported shape is frozen.
//
// World frame: 1 unit = 16 texels; origin at the ring centre; +x east, +z south (north = -z).
// The road's centre line is the ellipse E(θ) = (A cos θ, B sin θ). θ is in RADIANS everywhere in this module (lots also
// carry `deg`). θ = 0 is east and θ grows clockwise seen from above (toward +z): θ = π/2 is the south end (0, B).
// "Offset" is the signed distance from the centre line, + outward: road |offset| <= 2.5, inner pavement -4.5..-2.5,
// outer pavement +2.5..+4.5. Everything with offset <= +4.5 is walkable except the colliders; beyond it is blocked.
//
// Colliders are oriented boxes (lots and props turn with the ring). Each carries the oriented form
// { cx, cz, ux, uz, hw, hd } — half-width hw along u = (ux, uz), half-depth hd along v = (uz, -ux) — plus its
// axis-aligned bounds { x0, x1, z0, z1 } in TownWorld's shape, and `rotY`, the three.js rotation.y that turns a box's
// local +x onto u. For a lot u is the clockwise tangent and v the outward normal.

export const A = 28, B = 18;                 // semi-axes of the road's centre line
export const ROAD_W = 5, ROAD_HALF = ROAD_W / 2;
export const PAVE_W = 2;
export const INNER_EDGE = -(ROAD_HALF + PAVE_W), OUTER_EDGE = ROAD_HALF + PAVE_W;   // -4.5 / +4.5
export const PLAZA_R = 9;
export const LOT_W = 14, LOT_D = 10;         // frontage x depth
const TAU = Math.PI * 2;
const normTheta = (t) => { const m = t % TAU; return m < 0 ? m + TAU : m; };

// ---- ellipse helpers ----
export function ellipsePoint(theta) { return { x: A * Math.cos(theta), z: B * Math.sin(theta) }; }
// Unit clockwise tangent (direction of increasing θ) and unit outward normal at θ. normal = (t.z, -t.x).
export function ellipseTangent(theta) {
  const x = -A * Math.sin(theta), z = B * Math.cos(theta), l = Math.hypot(x, z);
  return { x: x / l, z: z / l };
}
export function ellipseNormal(theta) {
  const x = B * Math.cos(theta), z = A * Math.sin(theta), l = Math.hypot(x, z);
  return { x: x / l, z: z / l };
}
// Point at signed offset d from the centre line at θ (the offset curves are the pavement edges, lamp rows, ...).
export function offsetPoint(theta, d) {
  const p = ellipsePoint(theta), n = ellipseNormal(theta);
  return { x: p.x + d * n.x, z: p.z + d * n.z };
}

// θ of the closest point on the centre line to (x, z). The first-quadrant evolute iteration (robust everywhere, also
// deep inside the ellipse) followed by Newton on (P - E(θ))·E'(θ) = 0 for full precision. Inside |offset| < B²/A
// (11.57, the smallest radius of curvature) the closest point is unique, so θ is continuous over the whole ring
// (road and both pavements); near the centre of the plaza it can jump between the two ends of the minor axis.
function closestTheta(x, z) {
  const px = Math.abs(x), pz = Math.abs(z), k = A * A - B * B;
  let tx = Math.SQRT1_2, tz = Math.SQRT1_2;
  for (let i = 0; i < 4; i++) {
    const ex = k * tx * tx * tx / A, ez = -k * tz * tz * tz / B;
    const rx = A * tx - ex, rz = B * tz - ez, qx = px - ex, qz = pz - ez;
    const r = Math.hypot(rx, rz), q = Math.max(Math.hypot(qx, qz), 1e-12);
    tx = Math.min(1, Math.max(0, (qx * r / q + ex) / A));
    tz = Math.min(1, Math.max(0, (qz * r / q + ez) / B));
    const t = Math.hypot(tx, tz); tx /= t; tz /= t;
  }
  let th = Math.atan2((z < 0 ? -1 : 1) * tz, (x < 0 ? -1 : 1) * tx);
  const d2 = (t) => { const c = Math.cos(t), s = Math.sin(t); return (x - A * c) ** 2 + (z - B * s) ** 2; };
  for (let i = 0; i < 4; i++) {
    const c = Math.cos(th), s = Math.sin(th), ex = A * c, ez = B * s, dx = -A * s, dz = B * c;
    const f = (x - ex) * dx + (z - ez) * dz, fp = -(dx * dx + dz * dz) + (x - ex) * (-A * c) + (z - ez) * (-B * s);
    if (!(Math.abs(fp) > 1e-12)) break;
    const next = th - f / fp;
    if (!(d2(next) <= d2(th) + 1e-12)) break;
    th = next;
  }
  return th;
}
export function ellipseTheta(x, z) { return normTheta(closestTheta(x, z)); }
// Signed distance from the centre line, + outward (outside the ellipse), - toward the plaza.
export function ellipseOffset(x, z) {
  const th = closestTheta(x, z), c = Math.cos(th), s = Math.sin(th);
  const d = Math.hypot(x - A * c, z - B * s);
  return (x / A) ** 2 + (z / B) ** 2 < 1 ? -d : d;
}

// ---- oriented boxes ----
function obb(tag, kind, cx, cz, ux, uz, hw, hd, extra) {
  const ex = Math.abs(ux) * hw + Math.abs(uz) * hd, ez = Math.abs(uz) * hw + Math.abs(ux) * hd;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => Object.freeze([
    cx + a * hw * ux + b * hd * uz, cz + a * hw * uz - b * hd * ux]));
  return Object.freeze(Object.assign({
    tag, kind, cx, cz, ux, uz, hw, hd, rotY: Math.atan2(-uz, ux),
    x0: cx - ex, x1: cx + ex, z0: cz - ez, z1: cz + ez, corners: Object.freeze(corners)
  }, extra || {}));
}
// Signed distance from (x, z) to an oriented box (negative inside). Collision treats the walker as a disc of radius r.
export function obbDistance(c, x, z) {
  const dx = x - c.cx, dz = z - c.cz;
  const u = Math.abs(dx * c.ux + dz * c.uz) - c.hw, v = Math.abs(dx * c.uz - dz * c.ux) - c.hd;
  return Math.hypot(Math.max(u, 0), Math.max(v, 0)) + Math.min(Math.max(u, v), 0);
}

// ---- lots ----
// Front edge tangent to the outer pavement edge (+4.5) at θ, facing the ring centre; the door is the frontage midpoint.
// Facade fields use the alley-layout schema (facade-gen families, RAMPS walls, h a multiple of 1.5, `door` = the door's
// left edge along the frontage, 2 wide): scene-ring builds each lot as an alley 'west' lot and turns it by facadeRotY.
// label: 6 characters for the leaderboard rows; name: the HUD name; dept: the TownWorld department id, if any.
const LOT_DEFS = [
  { id: 'engineering', deg: 0, name: 'Engineering', label: 'ENGINR', dept: 'engineering', kind: 'department', family: 'glass', wall: 'glass', awning: 'teal', h: 15, seed: 31, sign: 'ENGINEERING' },
  { id: 'research', deg: 36, name: 'Research', label: 'RSRCH', dept: 'research', kind: 'department', family: 'stone', wall: 'slate', awning: 'teal', h: 13.5, seed: 32, sign: 'RESEARCH' },
  { id: 'operations', deg: 72, name: 'Operations', label: 'OPS', dept: 'operations', kind: 'department', family: 'brick', wall: 'brick', awning: 'rust', h: 15, seed: 33, sign: 'OPERATIONS' },
  { id: 'qa', deg: 108, name: 'QA', label: 'QA', dept: 'qa', kind: 'department', family: 'stone', wall: 'sand', awning: 'mustard', h: 12, seed: 34, sign: 'QA LAB' },
  { id: 'design', deg: 144, name: 'Design', label: 'DESIGN', dept: 'design', kind: 'department', family: 'shopfront', wall: 'rose', awning: 'teal', h: 13.5, seed: 35, sign: 'DESIGN' },
  { id: 'planning', deg: 180, name: 'Planning', label: 'PLAN', dept: 'planning', kind: 'department', family: 'brick', wall: 'rust', awning: 'mustard', h: 15, seed: 36, sign: 'PLANNING' },
  { id: 'sportsgang', deg: 216, name: 'Sportsgang', label: 'SPORTS', dept: null, kind: 'lobby', family: 'glass', wall: 'steel', awning: 'sport', h: 13.5, seed: 37, sign: 'SPORTSGANG' },
  { id: 'no-wukkas-cafe', deg: 252, name: 'No Wukkas Cafe', label: 'CAFE', dept: null, kind: 'cafe', family: 'shopfront', wall: 'ochre', awning: 'rust', h: 12, seed: 38, sign: 'NO WUKKAS' },
  { id: 'lot-9', deg: 288, name: 'Lot 9', label: 'LOT 9', dept: null, kind: 'reserved', family: 'shopfront', wall: 'plaster', awning: 'mustard', h: 12, seed: 39, sign: 'COMING SOON', boarded: true },
  { id: 'lot-10', deg: 324, name: 'Lot 10', label: 'LOT 10', dept: null, kind: 'reserved', family: 'shopfront', wall: 'plaster', awning: 'teal', h: 13.5, seed: 40, sign: 'COMING SOON', boarded: true }
];
export const LOTS = Object.freeze(LOT_DEFS.map((d, i) => {
  const theta = d.deg * Math.PI / 180, t = ellipseTangent(theta), n = ellipseNormal(theta), door = offsetPoint(theta, OUTER_EDGE);
  return Object.freeze(Object.assign({}, d, {
    index: i + 1, theta, entrance: true, door: LOT_W / 2 - 1,
    doorX: door.x, doorZ: door.z, tx: t.x, tz: t.z, nx: n.x, nz: n.z,
    // three.js rotation.y that turns an alley 'west' lot (facade on local +x, u growing toward local -z) to face the
    // ring centre with u growing clockwise (the viewer's right when facing the facade from the road).
    facadeRotY: Math.atan2(n.z, -n.x)
  }));
}));
export function lotById(id) { return LOTS.find((l) => l.id === id) || null; }
// The lot's footprint as an oriented box: u = clockwise tangent (frontage), v = outward normal (depth).
export function lotRect(lot) {
  const L = typeof lot === 'string' ? lotById(lot) : lot;
  return obb('building:' + L.id, 'lot', L.doorX + L.nx * LOT_D / 2, L.doorZ + L.nz * LOT_D / 2, L.tx, L.tz, LOT_W / 2, LOT_D / 2,
    { w: LOT_W, d: LOT_D, h: L.h, lot: L.id });
}

// Nearest of the four sprite facings to a ground direction (north = -z).
export function facingOf(dx, dz) {
  return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north');
}
// The door: centre on the front edge (frontage midpoint), the outward normal (the direction you walk to go in), a
// trigger zone in door coordinates (lateral |s| <= halfWidth, within `depth` of the door plane on the walk side), the
// E/Enter radius, and the return spot on the road in front of it (offset +1.5, facing away from the door).
export const DOOR_W = 2, DOOR_HALF = 1.3, DOOR_DEPTH = 0.8, DOOR_USE_R = 1.8, RETURN_OFFSET = 1.5;
export function doorOf(lot) {
  const L = typeof lot === 'string' ? lotById(lot) : lot;
  const back = offsetPoint(L.theta, RETURN_OFFSET);
  return Object.freeze({
    id: L.id, x: L.doorX, z: L.doorZ, nx: L.nx, nz: L.nz, tx: L.tx, tz: L.tz, theta: L.theta, width: DOOR_W,
    halfWidth: DOOR_HALF, depth: DOOR_DEPTH, useRadius: DOOR_USE_R, inFacing: facingOf(L.nx, L.nz),
    returnAt: Object.freeze({ x: back.x, z: back.z, facing: facingOf(-L.nx, -L.nz) })
  });
}

// ---- plaza ----
export const PYLON = Object.freeze({ x: 0, z: 0, w: 3, d: 3, h: 7 });
const benchAt = (id, dir) => {                                      // dir: unit vector from the centre; 2 long, 0.6 deep
  const x = dir[0] * 6, z = dir[1] * 6;
  return Object.freeze({ id, x, z, w: Math.abs(dir[1]) ? 2 : 0.6, d: Math.abs(dir[1]) ? 0.6 : 2, h: 1.0625, faces: facingOf(-dir[0], -dir[1]) });
};
export const BENCHES = Object.freeze([benchAt('bench-n', [0, -1]), benchAt('bench-e', [1, 0]), benchAt('bench-s', [0, 1]), benchAt('bench-w', [-1, 0])]);
// Four radial footpaths (visual, walkable) from the plaza disc across the lawn to the inner pavement, 2 wide.
export const RADIAL_PATHS = Object.freeze([0, 90, 180, 270].map((deg) => Object.freeze({ deg, theta: deg * Math.PI / 180, width: 2 })));

// ---- spawn ----
// On the road centre line at θ = 90° (the south end), facing west: clockwise along the road.
export const SPAWN = Object.freeze({ x: 0, z: B, theta: Math.PI / 2, facing: 'west' });

// ---- props ----
// Footprints [w, d, h] as alley-layout PROP_SIZES (multiples of 1/16). Pavement props stand on offset curves, spaced by
// arc length, turned with the ring (w along the tangent). Nothing stands on the road, in a door's zebra crossing
// (±CROSS_CLEAR along the curve from the door) or on the spawn.
export const PROP_SIZES = Object.freeze({
  bin: [0.75, 0.75, 1], lamp: [0.375, 0.375, 4.25], bench: [2, 0.625, 1.0625], tree: [0.75, 0.75, 4.375]
});
export const LAMP_OFFSET = 2.9, TREE_OFFSET = -3.4, DOOR_PROP_OFFSET = 3.85, CROSS_W = 2.5, CROSS_CLEAR = 2.75;
export const PLAZA_LAMP_R = 7.5;

// Arc-length table of an offset curve (fine θ steps); at(s) -> θ at arc length s from θ = 0 (clockwise).
function arcTable(d) {
  const N = 4096, th = new Float64Array(N + 1), s = new Float64Array(N + 1);
  let prev = offsetPoint(0, d);
  for (let i = 1; i <= N; i++) {
    th[i] = TAU * i / N;
    const p = offsetPoint(th[i], d);
    s[i] = s[i - 1] + Math.hypot(p.x - prev.x, p.z - prev.z);
    prev = p;
  }
  function at(len) {
    const L = s[N], q = ((len % L) + L) % L;
    let lo = 0, hi = N;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m] <= q) lo = m; else hi = m; }
    const f = (q - s[lo]) / (s[hi] - s[lo]);
    return th[lo] + f * (th[hi] - th[lo]);
  }
  function lenAt(theta) {
    const q = normTheta(theta), i = Math.min(N - 1, Math.floor(q / TAU * N)), f = (q - th[i]) / (th[i + 1] - th[i]);
    return s[i] + f * (s[i + 1] - s[i]);
  }
  return { length: s[N], at, lenAt };
}
export { arcTable };
// Arc distance along an offset curve between two angles (shortest way round).
function arcGap(tab, a, b) { const d = Math.abs(tab.lenAt(a) - tab.lenAt(b)); return Math.min(d, tab.length - d); }

function pavementProp(id, kind, theta, offset, side) {
  const [w, d, h] = PROP_SIZES[kind], p = offsetPoint(theta, offset), t = ellipseTangent(theta);
  return obb('prop:' + id, kind, p.x, p.z, t.x, t.z, w / 2, d / 2, { id, x: p.x, z: p.z, w, d, h, theta: normTheta(theta), offset, side });
}
function buildProps() {
  const out = [];
  // Per gap between two neighbouring doors (lot i at the start, lot i+1 at the end, measured clockwise on the curve):
  // two lamps by the curb of the outer pavement at 1/4 and 3/4 of the gap (so ~8 units apart, never in a crossing);
  // one tree on the inner pavement at the middle, or two, 3 units either side, where a radial footpath meets the gap.
  const outer = arcTable(LAMP_OFFSET), inner = arcTable(TREE_OFFSET), pathThetas = RADIAL_PATHS.map((p) => p.theta);
  LOTS.forEach((L, i) => {
    const next = LOTS[(i + 1) % LOTS.length];
    const s0 = outer.lenAt(L.theta), gap = ((outer.lenAt(next.theta) - s0) % outer.length + outer.length) % outer.length;
    out.push(pavementProp('lamp-o' + (2 * i + 1), 'lamp', outer.at(s0 + gap / 4), LAMP_OFFSET, 'outer'));
    out.push(pavementProp('lamp-o' + (2 * i + 2), 'lamp', outer.at(s0 + 3 * gap / 4), LAMP_OFFSET, 'outer'));
    const t0 = inner.lenAt(L.theta), tgap = ((inner.lenAt(next.theta) - t0) % inner.length + inner.length) % inner.length;
    const mid = inner.at(t0 + tgap / 2), path = pathThetas.find((pt) => arcGap(inner, mid, pt) < 2);
    if (path == null) out.push(pavementProp('tree-i' + (i + 1), 'tree', mid, TREE_OFFSET, 'inner'));
    else {
      const sp = inner.lenAt(path);
      out.push(pavementProp('tree-i' + (i + 1) + 'a', 'tree', inner.at(sp - 3), TREE_OFFSET, 'inner'));
      out.push(pavementProp('tree-i' + (i + 1) + 'b', 'tree', inner.at(sp + 3), TREE_OFFSET, 'inner'));
    }
  });
  // By each open door (not the boarded lots): a bench on the clockwise side and a bin on the other, against the facade
  // side of the outer pavement, ~4 units along the curve from the door.
  const doorRow = arcTable(DOOR_PROP_OFFSET);
  LOTS.forEach((L) => {
    if (L.boarded) return;
    const s0 = doorRow.lenAt(L.theta);
    out.push(pavementProp('bench-' + L.id, 'bench', doorRow.at(s0 + 4.25), DOOR_PROP_OFFSET, 'door'));
    out.push(pavementProp('bin-' + L.id, 'bin', doorRow.at(s0 - 3.75), DOOR_PROP_OFFSET, 'door'));
  });
  // Plaza: 4 benches at radius 6 (N/E/S/W) and 4 lamps at radius 7.5 on the diagonals.
  BENCHES.forEach((b) => out.push(obb('prop:' + b.id, 'bench', b.x, b.z, 1, 0, b.w / 2, b.d / 2,
    { id: b.id, x: b.x, z: b.z, w: b.w, d: b.d, h: b.h, side: 'plaza', faces: b.faces })));
  [45, 135, 225, 315].forEach((deg, i) => {
    const a = deg * Math.PI / 180, x = PLAZA_LAMP_R * Math.cos(a), z = PLAZA_LAMP_R * Math.sin(a), [w, d, h] = PROP_SIZES.lamp;
    out.push(obb('prop:lamp-p' + (i + 1), 'lamp', x, z, 1, 0, w / 2, d / 2, { id: 'lamp-p' + (i + 1), x, z, w, d, h, side: 'plaza' }));
  });
  return Object.freeze(out);
}
export const PROPS = buildProps();

// Zebra crossings (painted, walk-over): one across the road in front of every door, CROSS_W wide along the curve.
export const CROSSINGS = Object.freeze(LOTS.map((L) => Object.freeze({ id: L.id, theta: L.theta, width: CROSS_W })));

// ---- collision ----
// Lots, the pylon, then every prop. Oriented boxes; x0..z1 are their axis-aligned bounds.
export function colliderRects() {
  return [
    ...LOTS.map(lotRect),
    obb('pylon', 'pylon', PYLON.x, PYLON.z, 1, 0, PYLON.w / 2, PYLON.d / 2, { h: PYLON.h }),
    ...PROPS
  ];
}
const COLLIDERS = colliderRects();
// Walkable: inside the outer pavement edge and not inside any collider. r > 0 asks for a disc of radius r to fit.
export function inWalk(x, z, r) {
  const rr = r > 0 ? r : 0;
  if (ellipseOffset(x, z) > OUTER_EDGE - rr) return false;
  for (let i = 0; i < COLLIDERS.length; i++) {
    const d = obbDistance(COLLIDERS[i], x, z);
    if (rr > 0 ? d < rr : d <= 0) return false;
  }
  return true;
}
