// M3.2a Phase 2 (prompts/M32_PANELS.md §2): the left panel's minimap. A 2D canvas drawn from the same data the
// renderer and the collision world use (renderer/ring-layout.mjs on the ring; TownWorld's debug `town` block in the
// town; the walk rect of an alley-world or a room), so it cannot drift from them. North up (-z up, +x right).
// Per frame it only reads what main.js already produced: the debug state (guide, camera yaw, townsfolk) and the board
// rows the pylon shows (status lamps, agent counts). Read-only: a click selects a lot and shows its card; the card's
// Focus button is the HUD's existing Focus action (it moves the guide to the door, see DECISIONS #156).
import { LOTS, lotRect, doorOf, offsetPoint, OUTER_EDGE, INNER_EDGE, ROAD_HALF, PLAZA_R, PYLON, obbDistance, DOOR_W, DOOR_DEPTH, LOT_W, LOT_D } from './ring-layout.mjs';
import { lampState, LAMP_COLORS } from './scene-ring.mjs';
import { boardViewFromSnapshot, drawBoardText, boardTextWidth, boardText } from './leaderboard.mjs';
import { createImage } from './textures.mjs';

const TAU = Math.PI * 2, DEG = Math.PI / 180;
// Three letters (or fewer) per lot / department for the map labels (the pylon's 6-character labels do not fit a lot).
export const SHORT_LABEL = Object.freeze({
  engineering: 'ENG', research: 'RES', operations: 'OPS', qa: 'QA', design: 'DES', planning: 'PLN',
  sportsgang: 'SPG', 'no-wukkas-cafe': 'CAF', 'lot-9': 'L9', 'lot-10': 'L10'
});
const shortLabel = (id) => SHORT_LABEL[id] || boardText(String(id || '?'), 3, 30);
const DEPT_NAME = { planning: 'Planning', engineering: 'Engineering', research: 'Research', design: 'Design', qa: 'QA', operations: 'Operations' };
const SCENE_NAME = Object.assign({ ring: 'the ring', town: 'the town', alley: 'the alley', sportsgang: 'the Sportsgang lobby' }, DEPT_NAME);
export const GRID_UNITS = 10;            // §2 scale cue: 1 px grid lines every 10 units

// ---- models (static geometry per scene) -------------------------------------------------------------------------------
function boundsOf(points, margin) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of points) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  return { x0: x0 - margin, x1: x1 + margin, z0: z0 - margin, z1: z1 + margin };
}
const curve = (d, n) => Array.from({ length: n }, (_, i) => { const p = offsetPoint(i / n * TAU, d); return [p.x, p.z]; });

// The ring: walk boundary (outer pavement edge), road band, inner pavement edge, plaza disc, pylon, the ten lots as
// oriented rectangles with their door on the front edge.
let ringCache = null;
export function ringModel() {
  if (ringCache) return ringCache;
  const lots = LOTS.map((L) => {
    const r = lotRect(L), d = doorOf(L);
    return Object.freeze({
      id: L.id, name: L.name, dept: L.dept, kind: L.kind, label: shortLabel(L.id), rect: r, corners: r.corners.map((c) => [c[0], c[1]]),
      cx: r.cx, cz: r.cz, door: { x: d.x, z: d.z, nx: d.nx, nz: d.nz, tx: d.tx, tz: d.tz },
      // Map anchors: the lamp just behind the door, the label a little behind the lot's centre, the count badge in the
      // back corner (clockwise side), so the three never overlap whichever way the lot faces on the map.
      lampAt: [d.x + d.nx * 1.4, d.z + d.nz * 1.4], labelAt: [r.cx + d.nx * 0.8, r.cz + d.nz * 0.8],
      badgeAt: [r.cx + d.nx * (LOT_D / 2 - 1.8) + d.tx * (LOT_W / 2 - 2.4), r.cz + d.nz * (LOT_D / 2 - 1.8) + d.tz * (LOT_W / 2 - 2.4)]
    });
  });
  const pts = [].concat(...lots.map((l) => l.corners), curve(OUTER_EDGE, 90));
  ringCache = Object.freeze({
    kind: 'ring', key: 'ring', bounds: boundsOf(pts, 1.5),
    outer: curve(OUTER_EDGE, 180), inner: curve(INNER_EDGE, 180), roadOut: curve(ROAD_HALF, 180), roadIn: curve(-ROAD_HALF, 180),
    plaza: { x: 0, z: 0, r: PLAZA_R },
    pylon: [[PYLON.x - PYLON.w / 2, PYLON.z - PYLON.d / 2], [PYLON.x + PYLON.w / 2, PYLON.z - PYLON.d / 2], [PYLON.x + PYLON.w / 2, PYLON.z + PYLON.d / 2], [PYLON.x - PYLON.w / 2, PYLON.z + PYLON.d / 2]],
    lots, walk: null
  });
  return ringCache;
}
const rectCorners = (b) => [[b.x0, b.z0], [b.x1, b.z0], [b.x1, b.z1], [b.x0, b.z1]];
// The town (TownWorld's debug `town` block: walk rect, plaza, alley, parks, buildings with their department).
export function townModel(town) {
  const lots = (town.buildings || []).map((b) => Object.freeze({
    id: b.department, name: DEPT_NAME[b.department] || b.title || b.department, dept: b.department, kind: 'department', label: shortLabel(b.department),
    rect: null, corners: rectCorners(b), cx: (b.x0 + b.x1) / 2, cz: (b.z0 + b.z1) / 2, door: null,
    lampAt: [(b.x0 + b.x1) / 2, b.z0 + 1.2], labelAt: [(b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2], badgeAt: [b.x1 - 2.2, b.z1 - 1.8]
  }));
  return Object.freeze({
    kind: 'town', key: 'town', bounds: boundsOf(rectCorners(town.walk).concat(...lots.map((l) => l.corners)), 1.5),
    walk: town.walk, plazaRect: town.plaza || null, alley: town.alley || null, parks: town.parks || [], lots
  });
}
// A room, the alley or the lobby: its walk rect only.
export function rectModel(key, walk) {
  return Object.freeze({ kind: 'rect', key: key + ':' + [walk.x0, walk.x1, walk.z0, walk.z1].join(','), bounds: boundsOf(rectCorners(walk), 1), walk, lots: [] });
}

// ---- transform ----------------------------------------------------------------------------------------------------------
// Fit `bounds` into `width` CSS px (minus `pad` on each side), north up; the height follows from the aspect (capped at
// maxHeight, which narrows the drawing instead). Uniform scale s px per unit; toPx / toWorld are exact inverses.
// cue: add a strip under the map (mapHeight .. height) for the 10-unit scale grid, so it never covers a lot.
export function fitTransform(bounds, width, pad, maxHeight, cue) {
  const bw = bounds.x1 - bounds.x0, bh = bounds.z1 - bounds.z0, p = pad == null ? 4 : pad;
  let s = Math.max(0.01, (width - 2 * p) / bw);
  if (maxHeight && bh * s + 2 * p > maxHeight) s = Math.max(0.01, (maxHeight - 2 * p) / bh);
  const mapHeight = Math.ceil(bh * s + 2 * p), height = mapHeight + (cue ? Math.ceil(GRID_UNITS * s) + 6 : 0);
  const ox = (width - bw * s) / 2 - bounds.x0 * s, oz = (mapHeight - bh * s) / 2 - bounds.z0 * s;
  return {
    s, width, height, mapHeight,
    toPx: (x, z) => [ox + x * s, oz + z * s],
    toWorld: (px, py) => [(px - ox) / s, (py - oz) / s]
  };
}
// The guide marker: a triangle at the guide pointing along the camera's forward. Camera-rig / orbit-rig convention:
// forward = (sin yaw, -cos yaw) on the ground, which is the same vector on a north-up map (screen y grows with z).
// Returns [tip, back-left, back-right] in CSS px.
export function guideTriangle(T, x, z, yawDeg, size) {
  const r = (+yawDeg || 0) * DEG, fx = Math.sin(r), fz = -Math.cos(r), sz = size || 7, b = sz * 0.6;
  const [px, py] = T.toPx(x, z);
  return [[px + fx * sz, py + fz * sz], [px - fx * b - fz * b, py - fz * b + fx * b], [px - fx * b + fz * b, py - fz * b - fx * b]];
}
// The lot under a map point (world coordinates), or null.
export function lotAt(model, x, z) {
  for (const l of model.lots) {
    if (l.rect ? obbDistance(l.rect, x, z) <= 0 : (x >= l.corners[0][0] && x <= l.corners[1][0] && z >= l.corners[0][1] && z <= l.corners[2][1])) return l;
  }
  return null;
}

// ---- what the debug state says right now ------------------------------------------------------------------------------
// -> { scene, model, guide: { x, z, yaw } | null, folk: [[x, z]], rows: Map(lot id -> row), offline } | null.
// rows are the pylon's BoardView rows on the ring (m27.ring.board); in the town the same rule (boardViewFromSnapshot)
// over the six department buildings.
let townCache = { town: null, model: null };
const boardFor = new WeakMap();
export function minimapView(debug, snap) {
  if (!debug || debug.disposed) return null;
  const m = debug.m27 || {}, ring = m.ring;
  const yawOf = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
  const folkOf = (list) => (list || []).map((n) => [n.x, n.z]);
  if (m.active && m.scene === 'ring' && ring && ring.world && !ring.world.disposed) {
    const b = ring.board, rows = new Map();
    if (b && b.rows) b.rows.forEach((r) => rows.set(r.lot, r));
    return { scene: 'ring', model: ringModel(), guide: { x: ring.world.player.x, z: ring.world.player.z, yaw: yawOf(ring.camera && ring.camera.yaw) },
      folk: folkOf(ring.world.npcs), rows, offline: !b || !!b.offline };
  }
  // A building entered from the ring (a room world), the lobby, the alley: their walk rect. Rooms keep yaw 0 (north).
  const rectFrom = (key, w) => (w && w.bounds && w.player ? { scene: key, model: rectModel(key, w.bounds), guide: { x: w.player.x, z: w.player.z, yaw: 0 }, folk: folkOf(w.npcs), rows: new Map(), offline: false } : null);
  if (m.active) {
    if (ring && ring.inside && ring.building && ring.building.world) return rectFrom(m.scene, ring.building.world);
    if (m.scene === 'sportsgang') return rectFrom('sportsgang', m.lobby);
    if (m.scene === 'alley') return rectFrom('alley', m.alley);
    return null;
  }
  if (debug.sceneId === 'town' && debug.town && debug.player) {
    if (townCache.town !== debug.town) townCache = { town: debug.town, model: townModel(debug.town) };
    const model = townCache.model, rows = new Map();
    let offline = false;
    if (snap) {
      let bv = boardFor.get(snap);
      if (!bv) { bv = boardViewFromSnapshot(snap, model.lots.map((l) => ({ id: l.id, dept: l.dept }))); boardFor.set(snap, bv); }
      bv.rows.forEach((r) => rows.set(r.lot, r));
      offline = !!bv.offline;
    }
    const tr = m.renderer && m.renderer.town;
    return { scene: 'town', model, guide: { x: debug.player.x, z: debug.player.z, yaw: yawOf(tr ? tr.yaw : debug.camera && debug.camera.yaw) },
      folk: folkOf(m.townsfolk && m.townsfolk.walkers), rows, offline };
  }
  if (debug.interior && debug.interior.bounds && debug.player) {
    return { scene: debug.sceneId, model: rectModel(debug.sceneId, debug.interior.bounds), guide: { x: debug.player.x, z: debug.player.z, yaw: yawOf(debug.camera && debug.camera.yaw) }, folk: [], rows: new Map(), offline: false };
  }
  return null;
}
const COUNT_KEYS = ['working', 'waiting', 'idle', 'unknown'];
export function rowCount(row) {
  if (!row) return 0;
  let n = 0;
  for (const k of COUNT_KEYS) if (typeof row[k] === 'number' && row[k] > 0) n += row[k];
  return n;
}
// The lot's lamp as the pylon's door lamps show it (scene-ring lampState), with the map's offline rule: all grey.
export function lotLamp(view, lotId) { return view.offline ? 'offline' : lampState(view.rows.get(lotId), false); }

// ---- drawing ------------------------------------------------------------------------------------------------------------
const C = {
  bg: '#15110e', walk: '#2a241e', road: '#3a332b', paveLine: '#5b4a3a', plaza: '#4a3d2c', pylon: '#e0a43c',
  lot: '#231c17', lotEdge: '#8f826e', lotHi: '#e0a43c', label: '#efe6d4', grid: '#6b5a48', folk: '#b9ab92',
  guide: '#f6d070', guideEdge: '#1b1512', badge: '#0f0c0b', grey: '#6a6660'
};
const rgb = (c) => 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
// Lamp colours from the door lamps (scene-ring LAMP_COLORS); offline is the map's all-grey, 'off' draws nothing.
export const LAMP_CSS = Object.freeze({
  working: rgb(LAMP_COLORS.working), waiting: rgb(LAMP_COLORS.waiting), idle: rgb(LAMP_COLORS.idle), unknown: rgb(LAMP_COLORS.unknown), offline: C.grey, off: null
});

// Pixel text in the pylon's font at k CSS px per texel, snapped to whole CSS px. Returns the drawn width.
const glyphCache = new Map();
function textImage(s) {
  let g = glyphCache.get(s);
  if (!g) {
    const w = Math.max(1, boardTextWidth(s)), img = createImage(w, 5);
    drawBoardText(img, s, 0, 0, [255, 255, 255]);
    g = { w, h: 5, on: [] };
    for (let y = 0; y < 5; y++) for (let x = 0; x < w; x++) if (img.data[(y * w + x) * 4 + 3]) g.on.push(x, y);
    glyphCache.set(s, g);
  }
  return g;
}
export function pixelText(ctx, text, x, y, k, color) {
  const g = textImage(boardText(text, 12, 200)), x0 = Math.round(x), y0 = Math.round(y);
  ctx.fillStyle = color;
  for (let i = 0; i < g.on.length; i += 2) ctx.fillRect(x0 + g.on[i] * k, y0 + g.on[i + 1] * k, k, k);
  return g.w * k;
}
const textW = (text, k) => textImage(boardText(text, 12, 200)).w * k;

function path(ctx, T, pts, close) {
  pts.forEach((p, i) => { const [x, y] = T.toPx(p[0], p[1]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
  if (close) ctx.closePath();
}
function poly(ctx, T, pts) { ctx.beginPath(); path(ctx, T, pts, true); }
function rectPx(ctx, T, b) { const [x0, y0] = T.toPx(b.x0, b.z0), [x1, y1] = T.toPx(b.x1, b.z1); ctx.rect(x0, y0, x1 - x0, y1 - y0); }

// The static layer: ground, walk area, road, plaza, pylon, lots (outline, door notch, label), scale grid.
export function drawBase(ctx, model, T) {
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, T.width, T.height);
  ctx.lineWidth = 1;
  if (model.kind === 'ring') {
    poly(ctx, T, model.outer); ctx.fillStyle = C.walk; ctx.fill();
    ctx.beginPath(); path(ctx, T, model.roadOut, true); path(ctx, T, model.roadIn.slice().reverse(), true);
    ctx.fillStyle = C.road; ctx.fill('evenodd');
    ctx.strokeStyle = C.paveLine;
    poly(ctx, T, model.inner); ctx.stroke();
    poly(ctx, T, model.outer); ctx.stroke();
    const [px, py] = T.toPx(model.plaza.x, model.plaza.z);
    ctx.beginPath(); ctx.arc(px, py, model.plaza.r * T.s, 0, TAU); ctx.fillStyle = C.plaza; ctx.fill();
    poly(ctx, T, model.pylon); ctx.fillStyle = C.pylon; ctx.fill();
  } else if (model.kind === 'town') {
    ctx.beginPath(); rectPx(ctx, T, model.walk); ctx.fillStyle = C.walk; ctx.fill();
    if (model.plazaRect) { ctx.beginPath(); rectPx(ctx, T, model.plazaRect); ctx.fillStyle = C.plaza; ctx.fill(); }
    if (model.alley) { ctx.beginPath(); rectPx(ctx, T, model.alley); ctx.fillStyle = C.road; ctx.fill(); }
    ctx.strokeStyle = C.paveLine; ctx.beginPath(); rectPx(ctx, T, model.walk); ctx.stroke();
  } else {
    ctx.beginPath(); rectPx(ctx, T, model.walk); ctx.fillStyle = C.walk; ctx.fill();
    ctx.strokeStyle = C.paveLine; ctx.stroke();
  }
  const k = T.s >= 3 ? 2 : 1;
  for (const l of model.lots) {
    poly(ctx, T, l.corners); ctx.fillStyle = C.lot; ctx.fill();
    ctx.strokeStyle = C.lotEdge; ctx.stroke();
    if (l.door) {                                          // the door: a notch cut into the front edge, DOOR_W wide
      const d = l.door, hw = DOOR_W / 2, dp = DOOR_DEPTH;
      poly(ctx, T, [[d.x - d.tx * hw, d.z - d.tz * hw], [d.x + d.tx * hw, d.z + d.tz * hw], [d.x + d.tx * hw + d.nx * dp, d.z + d.tz * hw + d.nz * dp], [d.x - d.tx * hw + d.nx * dp, d.z - d.tz * hw + d.nz * dp]]);
      ctx.fillStyle = C.walk; ctx.fill();
    }
    const [cx, cy] = T.toPx(l.labelAt[0], l.labelAt[1]);
    pixelText(ctx, l.label, cx - textW(l.label, k) / 2, cy - 2.5 * k, k, C.label);
  }
  // Scale cue (bottom-left, in the strip under the map when there is one): a 2 x 1 patch of 10-unit cells in 1 px lines,
  // labelled "10".
  const g = GRID_UNITS * T.s, gx = 4, gy = T.mapHeight != null && T.height > T.mapHeight ? T.mapHeight + 2 : T.height - 4 - g;
  ctx.strokeStyle = C.grid;
  ctx.beginPath();
  for (let i = 0; i <= 2; i++) { const x = Math.round(gx + i * g) + 0.5; ctx.moveTo(x, Math.round(gy) + 0.5); ctx.lineTo(x, Math.round(gy + g) + 0.5); }
  for (let j = 0; j <= 1; j++) { const y = Math.round(gy + j * g) + 0.5; ctx.moveTo(Math.round(gx) + 0.5, y); ctx.lineTo(Math.round(gx + 2 * g) + 0.5, y); }
  ctx.stroke();
  pixelText(ctx, '10', gx + 2, gy + 2, 1, C.grid);
}

// The live layer: lot lamps and agent-count badges, townsfolk dots, the guide triangle, hover / selection outlines.
export function drawOverlay(ctx, view, T, ui) {
  const model = view.model, k = T.s >= 3 ? 2 : 1;
  for (const l of model.lots) {
    const lamp = lotLamp(view, l.id), css = LAMP_CSS[lamp];
    // Lamp: a small square just inside the lot behind its door (ring), or just inside its top edge (town).
    const [lx, ly] = T.toPx(l.lampAt[0], l.lampAt[1]), r = Math.max(2, Math.round(T.s * 0.7));
    if (lamp === 'unknown') {                             // unknown: a dotted square, no fill
      ctx.save(); ctx.setLineDash([1, 2]); ctx.strokeStyle = css; ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(lx - r) + 0.5, Math.round(ly - r) + 0.5, 2 * r, 2 * r); ctx.restore();
    } else if (css) { ctx.fillStyle = css; ctx.fillRect(Math.round(lx - r), Math.round(ly - r), 2 * r, 2 * r); }
    const n = view.offline ? 0 : rowCount(view.rows.get(l.id));
    if (n > 0) {                                          // count badge in the lot's back corner
      const s = String(Math.min(n, 99)), w = textW(s, k) + 2 * k + 2, h = 5 * k + 2 * k + 2;
      const [bx, by] = T.toPx(l.badgeAt[0], l.badgeAt[1]);
      const x0 = Math.round(bx - w / 2), y0 = Math.round(by - h / 2);
      ctx.fillStyle = C.badge; ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = css || C.lotEdge; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
      pixelText(ctx, s, x0 + k + 1, y0 + k + 1, k, C.label);
    }
    if (ui && (ui.hover === l.id || ui.selected === l.id)) {
      poly(ctx, T, l.corners); ctx.lineWidth = ui.selected === l.id ? 2 : 1; ctx.strokeStyle = C.lotHi; ctx.stroke();
    }
  }
  ctx.fillStyle = C.folk;
  for (const [x, z] of view.folk) { const [px, py] = T.toPx(x, z); ctx.fillRect(Math.round(px) - 1, Math.round(py) - 1, 2, 2); }
  if (view.guide) {
    const tri = guideTriangle(T, view.guide.x, view.guide.z, view.guide.yaw, Math.max(6, Math.round(T.s * 1.8)));
    ctx.beginPath(); ctx.moveTo(tri[0][0], tri[0][1]); ctx.lineTo(tri[1][0], tri[1][1]); ctx.lineTo(tri[2][0], tri[2][1]); ctx.closePath();
    ctx.fillStyle = C.guide; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = C.guideEdge; ctx.stroke();
  }
}

// ---- the panel section (DOM; mounted by renderer/panels.mjs into the left panel's body) ---------------------------------
const MAX_MAP_H = 560;
export function lotSummary(view, l) {
  const row = view.rows.get(l.id), lamp = lotLamp(view, l.id);
  const counts = view.offline ? 'offline — counts unknown' : row ? COUNT_KEYS.map((k) => k + ' ' + (row[k] == null ? '—' : row[k])).join(' · ') : 'no agents';
  return { name: l.name, lamp, counts };
}
export const minimapSection = Object.freeze({
  mount(body, ctx) {
    const doc = ctx.doc, win = ctx.win;
    const wrap = doc.createElement('div'); wrap.className = 'm32-map';
    const canvas = doc.createElement('canvas'); canvas.className = 'm32-map-canvas';
    canvas.setAttribute('role', 'img');
    const tip = doc.createElement('div'); tip.className = 'm32-map-tip'; tip.hidden = true; tip.setAttribute('aria-hidden', 'true');
    const card = doc.createElement('div'); card.className = 'm32-lot'; card.hidden = true; card.setAttribute('aria-live', 'polite');
    const empty = doc.createElement('p'); empty.className = 'm32-empty'; empty.textContent = 'No map for this view.'; empty.hidden = true;
    wrap.append(canvas, tip);
    body.append(wrap, card, empty);
    const g2 = canvas.getContext('2d');
    const base = doc.createElement('canvas'), b2 = base.getContext('2d');
    let T = null, baseKey = '', view = null, hover = null, selected = null, cardKey = '', label = '';
    const listeners = [];
    const on = (t, type, fn) => { t.addEventListener(type, fn); listeners.push([t, type, fn]); };

    function local(e) { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
    function lotUnder(e) { if (!T || !view) return null; const [px, py] = local(e), [x, z] = T.toWorld(px, py); return lotAt(view.model, x, z); }
    on(canvas, 'pointermove', (e) => {
      const l = lotUnder(e);
      hover = l ? l.id : null;
      canvas.style.cursor = l ? 'pointer' : 'default';
      if (!l) { tip.hidden = true; return; }
      const s = lotSummary(view, l), [px, py] = local(e);
      tip.textContent = s.name + ' · ' + s.counts;
      tip.hidden = false;
      tip.style.left = Math.round(Math.max(0, Math.min(px + 12, T.width - tip.offsetWidth - 2))) + 'px';
      tip.style.top = Math.round(py + 14 > T.height - 24 ? py - 28 : py + 14) + 'px';
    });
    on(canvas, 'pointerleave', () => { hover = null; tip.hidden = true; });
    on(canvas, 'click', (e) => { const l = lotUnder(e); selected = l ? (selected === l.id ? null : l.id) : null; cardKey = ''; });
    on(win, 'keydown', (e) => { if (e.key === 'Escape' && selected) { selected = null; cardKey = ''; } });

    function renderCard() {
      const l = selected && view ? view.model.lots.find((x) => x.id === selected) : null;
      if (!l) { if (!card.hidden) { card.hidden = true; card.replaceChildren(); } cardKey = ''; return; }
      const s = lotSummary(view, l), key = l.id + '|' + s.lamp + '|' + s.counts + '|' + view.scene;
      if (key === cardKey) return;
      cardKey = key;
      const h = doc.createElement('p'); h.className = 'm32-lot-name'; h.textContent = s.name + ' ';
      const lamp = doc.createElement('span'); lamp.className = 'm32-lamp'; lamp.dataset.lamp = s.lamp; lamp.textContent = s.lamp;
      h.appendChild(lamp);
      const c = doc.createElement('p'); c.className = 'm32-lot-counts'; c.textContent = s.counts;
      card.replaceChildren(h, c);
      // The HUD's own Focus action (main.js): on the ring any lot by id; in the town the department.
      const act = view.scene === 'ring' ? (l.dept ? { type: 'focus', department: l.dept } : { type: 'focus', lot: l.id }) : l.dept ? { type: 'focus', department: l.dept } : null;
      if (act) {
        const b = doc.createElement('button'); b.type = 'button'; b.className = 'm32-toggle m32-focus'; b.textContent = 'Focus ' + s.name;
        b.title = 'The HUD Focus action: moves the guide to this door';
        b.addEventListener('click', () => ctx.onAction(act));
        card.appendChild(b);
      }
      card.hidden = false;
    }

    return {
      render(snap, debug, layout) {
        view = minimapView(debug, snap);
        const open = layout && (layout.mode === 'two' ? layout.leftOpen : layout.mode === 'single' ? layout.single === 'left' : layout.mode === 'tabs');
        if (!open) return;
        empty.hidden = !!view; wrap.hidden = !view;
        if (!view) { card.hidden = true; return; }
        if (selected && !view.model.lots.some((l) => l.id === selected)) selected = null;
        const cssW = Math.floor(wrap.clientWidth || body.clientWidth || 0);
        if (cssW <= 0) return;
        const dpr = Math.max(1, Math.round((win && win.devicePixelRatio) || 1));
        // Fit the map (and an open card) in the height the panel has, so its body never overflows: a scrolling body over
        // the WebGL stage (a tab sheet) left the stage unpainted above the sheet in Chromium's composite (DECISIONS #175).
        const avail = layout.mode === 'tabs' ? Math.floor(Math.min(0.6 * layout.stageH, 520)) - 48 : (body.clientHeight || MAX_MAP_H) - 16;
        const maxH = Math.max(120, Math.min(MAX_MAP_H, avail - (card.hidden ? 0 : card.offsetHeight + 8)));
        const key = view.model.key + '|' + cssW + '|' + dpr + '|' + maxH;
        if (key !== baseKey) {
          baseKey = key;
          T = fitTransform(view.model.bounds, cssW, 4, maxH, true);
          if (T.height > maxH) T = fitTransform(view.model.bounds, cssW, 4, maxH - (T.height - T.mapHeight), true);
          for (const c of [canvas, base]) { c.width = T.width * dpr; c.height = T.height * dpr; }
          canvas.style.width = T.width + 'px'; canvas.style.height = T.height + 'px';
          b2.setTransform(dpr, 0, 0, dpr, 0, 0); b2.imageSmoothingEnabled = false;
          drawBase(b2, view.model, T);
        }
        const lbl = 'Minimap of ' + (SCENE_NAME[view.scene] || view.scene) + ', north up' + (view.model.lots.length ? ', ' + view.model.lots.length + ' buildings' : '');
        if (lbl !== label) { label = lbl; canvas.setAttribute('aria-label', lbl); }
        g2.setTransform(1, 0, 0, 1, 0, 0); g2.imageSmoothingEnabled = false;
        g2.drawImage(base, 0, 0);
        g2.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawOverlay(g2, view, T, { hover, selected });
        renderCard();
      },
      get selected() { return selected; },
      select(id) { selected = id || null; cardKey = ''; },
      get transform() { return T; },
      dispose() { listeners.forEach((l) => l[0].removeEventListener(l[1], l[2])); wrap.remove(); card.remove(); empty.remove(); }
    };
  }
});
