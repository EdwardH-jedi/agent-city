// M3.0 lane C (prompts/M30_RING.md §1.2, §2): the leaderboard pylon at the centre of the ring plaza.
// A 3-sided steel pylon, 3 x 3 footprint, 7 high. Each face is one 48 x 112 texel board (16 texels per unit) painted at
// runtime from a BoardView: an "AGENT OFFICE" title band, one two-line row per lot, an ALL row and, when the data is
// offline, a red OFFLINE band with every counter "—" (never 0). The boards are untinted at every time of day (lit at
// dusk/night, like the facades' lit windows); the steel frame, cap and plinth take the time-of-day tint.
//
// BoardView = { title, rows: [{ lot, label, working, waiting, idle, unknown, lastEvidenceS, deg }], offline, totals }
//   (deg and totals are additive to the §1.2 contract: deg places the row on the face that looks toward its lot; totals
//   are the declared global counts, shown in the ALL row, so they are never re-counted from rows.)
//
// Layout arithmetic (why rows are split over the faces): a 3 x 5 glyph plus its gap is 4 texels, so a one-line row
// (6-char label 25 + three 2-digit counters 3 x 7 + gaps + 4-char age 15) needs ~70 texels; the board is 44 wide inside its
// 2-texel frame. Rows are therefore two lines (label + age / counters), 15 texels tall, and 10 such rows do not fit under
// the title in 108 rows. Each face lists the lots in its 120-degree sector instead (4 / 3 / 3 for the ten §1.1 lots), so
// the face you look at lists the buildings on your side of the ring, and the ALL row on every face shows the global counts.
//
// Text: textures.mjs drawText has no digits, no lowercase and no dash. Those glyphs live here (EXTRA_GLYPHS, painted with
// fillRect); every other character is drawn by drawText. textures.mjs is not edited (shared with lane A's signs).
import {
  Group, Mesh, PlaneGeometry, BoxGeometry, BufferGeometry, Float32BufferAttribute, MeshBasicMaterial, Color
} from 'three';
import { PX_PER_UNIT, RAMPS, OUTLINE, mulberry32, createImage, fillRect, setPx, drawText, textWidth, flipRows } from './textures.mjs';
import { pixelTexture, rgbColor } from './alley-meshes.mjs';
import { TIME_PRESETS } from './presets.mjs';

export const PYLON_W = 3, PYLON_H = 7;                                    // face width (= triangle side) and height, units
export const FACE_W = PYLON_W * PX_PER_UNIT, FACE_H = PYLON_H * PX_PER_UNIT; // 48 x 112 texels
export const PLINTH_H = 2 / PX_PER_UNIT;
// Outward face normals, in the ring's angle convention (θ = 0 east, clockwise seen from above: direction (cos θ, sin θ) in
// x / z). One face looks south (θ 90), at the spawn. A side-3 equilateral triangle centred on its centroid would poke
// 0.23 past the 3 x 3 collider, so the triangle is centred on its 3 x 2.6 bounding box instead (centroid 0.433 south).
export const FACE_DEG = Object.freeze([90, 210, 330]);
const TRI_H = PYLON_W * Math.sqrt(3) / 2, INRADIUS = PYLON_W / (2 * Math.sqrt(3)), CENTROID_Z = TRI_H / 2 - INRADIUS;
export const PYLON_CENTROID = Object.freeze({ x: 0, z: CENTROID_Z });
export const TITLE = 'AGENT OFFICE';

export const BOARD_COLORS = Object.freeze({
  bg: [0x12, 0x16, 0x1e], rule: [0x2a, 0x30, 0x3c], title: RAMPS.sport[1], titleText: RAMPS.sport[3],
  label: [0xd6, 0xd8, 0xd2], age: RAMPS.glass[3],
  working: [0x5c, 0xd0, 0x6a], waiting: [0xf0, 0xb0, 0x3a], idle: [0x9c, 0xa4, 0xae], unknown: [0xb4, 0x92, 0xdc],
  dash: [0x9c, 0xa4, 0xae], offline: [0xb0, 0x24, 0x1e], offlineText: [0xff, 0xec, 0xe4]
});
// Texel layout of one face (top-down rows). Inside the frame: x 2..45, y 2..109.
export const BOARD_LAYOUT = Object.freeze({
  border: 2, titleY: 2, titleH: 14, rowsY: 18, rowH: 15, maxRows: 4, allY: 78, bandY: 94, bandH: 13,
  textX: 4, right: 45, line2: 6, counterX: Object.freeze([4, 15, 26]), unknownX: 34
});

// ---- text -------------------------------------------------------------------------------------------------------------
const EXTRA_GLYPHS = Object.freeze({
  0: ['.#.', '#.#', '#.#', '#.#', '.#.'], 1: ['.#.', '##.', '.#.', '.#.', '###'], 2: ['##.', '..#', '.#.', '#..', '###'],
  3: ['##.', '..#', '.#.', '..#', '##.'], 4: ['#.#', '#.#', '###', '..#', '..#'], 5: ['###', '#..', '##.', '..#', '##.'],
  6: ['.##', '#..', '###', '#.#', '###'], 7: ['###', '..#', '.#.', '.#.', '.#.'], 8: ['###', '#.#', '###', '#.#', '###'],
  9: ['###', '#.#', '###', '..#', '##.'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'], U: ['#.#', '#.#', '#.#', '#.#', '###'], V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'], J: ['..#', '..#', '..#', '#.#', '###'], Z: ['###', '..#', '.#.', '#..', '###'],
  s: ['...', '.##', '#..', '..#', '##.'], m: ['.....', '.....', '##.#.', '#.#.#', '#.#.#'], h: ['#..', '#..', '##.', '#.#', '#.#'],
  d: ['..#', '..#', '.##', '#.#', '.##'],
  '—': ['.....', '.....', '#####', '.....', '.....'], '-': ['...', '...', '###', '...', '...'], '+': ['...', '.#.', '###', '.#.', '...'],
  '?': ['##.', '..#', '.#.', '...', '.#.']
});
const baseGlyph = new Map();
function hasBaseGlyph(ch) {
  if (!baseGlyph.has(ch)) { let ok = true; try { textWidth(ch, 1); } catch (e) { ok = false; } baseGlyph.set(ch, ok); }
  return baseGlyph.get(ch);
}
export function hasGlyph(ch) { return Object.prototype.hasOwnProperty.call(EXTRA_GLYPHS, ch) || hasBaseGlyph(ch); }
function glyphWidth(ch) { return EXTRA_GLYPHS[ch] ? EXTRA_GLYPHS[ch][0].length : textWidth(ch, 1); }
export function boardTextWidth(s) { let w = 0; for (const ch of s) w += glyphWidth(ch) + 1; return Math.max(0, w - 1); }
// Scale-1 text: EXTRA_GLYPHS via fillRect, everything else via textures.mjs drawText. Returns the width drawn.
export function drawBoardText(img, s, x, y, color) {
  let cx = x;
  for (const ch of s) {
    const g = EXTRA_GLYPHS[ch];
    if (g) { for (let r = 0; r < 5; r++) for (let c = 0; c < g[r].length; c++) if (g[r][c] === '#') fillRect(img, cx + c, y + r, 1, 1, color); }
    else drawText(img, ch, cx, y, 1, color);
    cx += glyphWidth(ch) + 1;
  }
  return Math.max(0, cx - x - 1);
}
// Upper-cased, unknown characters as spaces, at most `max` characters and `maxW` texels wide.
export function boardText(s, max, maxW) {
  let out = '';
  for (const ch of String(s == null ? '' : s).toUpperCase().slice(0, max)) out += hasGlyph(ch) ? ch : ' ';
  while (out && boardTextWidth(out) > maxW) out = out.slice(0, -1);
  return out.trimEnd();
}

// ---- formats ----------------------------------------------------------------------------------------------------------
export const LABEL_MAX_W = 25;
export function counterText(n) { return n == null || !Number.isFinite(n) ? '—' : String(Math.max(0, Math.min(99, Math.floor(n)))).padStart(2, '0'); }
export function formatAge(s) {
  if (s == null || !Number.isFinite(s) || s < 0) return '—';
  s = Math.floor(s);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  const d = Math.floor(s / 86400);
  return d > 99 ? '99d+' : d + 'd';
}

// ---- BoardView builders -----------------------------------------------------------------------------------------------
const COUNT_KEYS = ['working', 'waiting', 'idle', 'unknown'];
const nullCounts = () => ({ working: null, waiting: null, idle: null, unknown: null });
const lotDeg = (lot) => (Number.isFinite(lot.deg) ? lot.deg : Number.isFinite(lot.theta) ? lot.theta * 180 / Math.PI : null);
function emptyRow(lot, offline) {
  const row = { lot: lot.id, label: boardText(lot.label || String(lot.id).replace(/-/g, ' '), 6, LABEL_MAX_W), deg: lotDeg(lot), lastEvidenceS: null };
  return Object.assign(row, offline ? nullCounts() : { working: 0, waiting: 0, idle: 0, unknown: 0 });
}
const minAge = (a, b) => (b == null || !Number.isFinite(b) ? a : a == null ? b : Math.min(a, b));
function ageOf(a) { const v = a.lastEvidenceS != null ? a.lastEvidenceS : a.ageS; return v == null || !Number.isFinite(+v) ? null : +v; }

// main.js snapshot (or its world view): { agents: [{ department, status, freshness }], counts, transportAvailable }.
// Same rules as main.js countsOf: completed is not counted; stale evidence or status unknown counts as unknown; transport
// unavailable is offline (every count null), checked first because the world view then marks every agent stale. A lot
// takes the agents whose department is its `dept` (its id when the lot has no dept field). The snapshot has no evidence
// times, so lastEvidenceS is null ("—") unless an agent carries lastEvidenceS / ageS.
export function boardViewFromSnapshot(snapshot, lots) {
  const s = snapshot || {}, c = s.counts;
  const offline = !snapshot || s.transportAvailable === false || (!!c && c.working == null);
  const rows = lots.map((lot) => emptyRow(lot, offline));
  const byDept = new Map();
  lots.forEach((lot, i) => { const d = Object.prototype.hasOwnProperty.call(lot, 'dept') ? lot.dept : lot.id; if (d != null && !byDept.has(d)) byDept.set(d, rows[i]); });
  let unmapped = 0;
  (s.agents || []).forEach((a) => {
    if (!a || a.status === 'completed') return;
    const row = byDept.get(a.department);
    if (!row) { unmapped++; return; }
    row.lastEvidenceS = minAge(row.lastEvidenceS, ageOf(a));
    if (offline) return;
    const k = a.freshness !== 'fresh' || a.status === 'unknown' || !COUNT_KEYS.includes(a.status) ? 'unknown' : a.status;
    row[k]++;
  });
  const totals = offline ? nullCounts() : c ? { working: c.working, waiting: c.waiting, idle: c.idle, unknown: c.unknown } : sumRows(rows);
  return { title: TITLE, rows, offline, totals, unmapped, source: 'snapshot' };
}

// live-bridge view ({ transport, counts, records: [{ project, state, ageS }] }) + bindings [{ project, place }]. A record
// belongs to a lot only when a binding names its project exactly and its place is that lot's id (no name matching, as
// assignToLobby). ended is not counted; stale and unknown count as unknown. Anything but transport 'live' (offline or
// still connecting) is offline: counts null. Ages stay: lastEvidenceS is the lot's freshest evidence, true either way.
// totals are the observer's global counts (bound or not); `unmapped` counts the live records no binding places on a lot.
export function boardViewFromLive(liveView, bindings, lots) {
  const v = liveView || {}, offline = v.transport !== 'live';
  const rows = lots.map((lot) => emptyRow(lot, offline));
  const byId = new Map(lots.map((lot, i) => [lot.id, rows[i]]));
  const place = new Map();
  (bindings || []).forEach((b) => { if (b && b.project != null && b.place != null && byId.has(String(b.place)) && !place.has(String(b.project))) place.set(String(b.project), String(b.place)); });
  let unmapped = 0;
  (v.records || []).forEach((r) => {
    if (!r || r.state === 'ended') return;
    const row = r.project != null ? byId.get(place.get(String(r.project))) : null;
    if (!row) { unmapped++; return; }
    row.lastEvidenceS = minAge(row.lastEvidenceS, ageOf(r));
    if (offline) return;
    row[r.state === 'working' || r.state === 'waiting' || r.state === 'idle' ? r.state : 'unknown']++;
  });
  const c = v.counts;
  const totals = offline || !c ? nullCounts() : { working: c.working | 0, waiting: c.waiting | 0, idle: c.idle | 0, unknown: (c.stale | 0) + (c.unknown | 0) };
  return { title: TITLE, rows, offline, totals, unmapped, source: 'live' };
}

function sumRows(rows) {
  const t = { working: 0, waiting: 0, idle: 0, unknown: 0 };
  for (const r of rows) for (const k of COUNT_KEYS) { if (r[k] == null) return nullCounts(); t[k] += r[k]; }
  return t;
}

// ---- face plan + painting ---------------------------------------------------------------------------------------------
export function faceOfDeg(deg) {
  let best = 0, bd = Infinity;
  FACE_DEG.forEach((f, k) => { const d = Math.abs((((deg - f) % 360) + 540) % 360 - 180); if (d < bd - 1e-9) { bd = d; best = k; } });
  return best;
}
// Rows on face k, in the view's order: by angle when the row has one, else by position (first 4 / next 3 / last 3).
export function faceRows(rows, k) {
  const n = rows.length;
  return rows.filter((r, i) => (Number.isFinite(r.deg) ? faceOfDeg(r.deg) : Math.min(2, Math.floor(i * 3 / n))) === k);
}

// Display list of one face: every rect and string the painter draws, with what it means (tests read it back from pixels).
export function planFace(view, k) {
  const L = BOARD_LAYOUT, C = BOARD_COLORS, offline = !!view.offline, texts = [], rects = [];
  const inner = FACE_W - 2 * L.border;
  const text = (s, x, y, color, meta) => texts.push(Object.assign({ s, x, y, color }, meta || {}));
  rects.push({ x: L.border, y: L.titleY, w: inner, h: L.titleH, color: C.title });
  const words = boardText(view.title == null ? TITLE : view.title, 24, Infinity).split(' ').filter(Boolean).slice(0, 2);
  words.forEach((w, i) => {
    const s = boardText(w, 11, inner - 2);
    text(s, L.border + Math.floor((inner - boardTextWidth(s)) / 2), L.titleY + 1 + i * 6 + (words.length === 1 ? 3 : 0), C.titleText, { field: 'title' });
  });
  rects.push({ x: L.border, y: L.titleY + L.titleH, w: inner, h: 1, color: C.rule });
  const counters = (row, y, meta, withUnknown) => {
    ['working', 'waiting', 'idle'].forEach((key, j) => {
      const v = offline ? null : row[key], s = counterText(v);
      text(s, L.counterX[j] + (s === '—' ? 1 : 0), y, v == null ? C.dash : C[key], Object.assign({ field: key, value: v }, meta));
    });
    if (withUnknown) {
      const v = offline ? null : row.unknown, s = '?' + counterText(v);
      text(s, L.unknownX, y, v == null ? C.dash : C.unknown, Object.assign({ field: 'unknown', value: v }, meta));
    }
  };
  const shown = faceRows(view.rows || [], k), list = shown.slice(0, L.maxRows);
  list.forEach((row, r) => {
    const y0 = L.rowsY + r * L.rowH, meta = { lot: row.lot };
    text(boardText(row.label, 6, LABEL_MAX_W), L.textX, y0 + 1, C.label, Object.assign({ field: 'label' }, meta));
    const age = formatAge(row.lastEvidenceS);
    text(age, L.right - boardTextWidth(age), y0 + 1, C.age, Object.assign({ field: 'age' }, meta));
    counters(row, y0 + 1 + L.line2, meta, true);
    rects.push({ x: L.border + 1, y: y0 + 13, w: inner - 2, h: 1, color: C.rule });
  });
  const t = view.totals || sumRows(view.rows || []);
  rects.push({ x: L.border, y: L.allY - 2, w: inner, h: 1, color: C.rule });
  text('ALL', L.textX, L.allY + 1, C.label, { field: 'label', lot: '*' });
  counters(t, L.allY + 1 + L.line2, { lot: '*' }, true);
  rects.push({ x: L.border, y: L.allY + 13, w: inner, h: 1, color: C.rule });
  if (offline) {
    rects.push({ x: L.border, y: L.bandY, w: inner, h: L.bandH, color: C.offline });
    text('OFFLINE', L.border + Math.floor((inner - boardTextWidth('OFFLINE')) / 2), L.bandY + 4, C.offlineText, { field: 'offline' });
  }
  return { face: k, deg: FACE_DEG[k], rects, texts, overflow: Math.max(0, shown.length - L.maxRows) };
}

const tintRgb = (c, tint) => [0, 1, 2].map((i) => Math.min(255, Math.round(c[i] * tint[i])));
// Paints a face plan. The 2-texel steel frame (outline + speckled steel, speckle from the seed) takes the time-of-day
// tint; everything inside it is the lit board and is never tinted.
export function paintFace(plan, look, seed) {
  const tint = (look && look.tint) || [1, 1, 1], img = createImage(FACE_W, FACE_H), rnd = mulberry32(((seed | 0) * 31 + plan.face * 7 + 1) >>> 0);
  fillRect(img, 0, 0, FACE_W, FACE_H, BOARD_COLORS.bg);
  const out = tintRgb(OUTLINE, tint), steel = [tintRgb(RAMPS.steel[0], tint), tintRgb(RAMPS.steel[1], tint)];
  for (let y = 0; y < FACE_H; y++) for (let x = 0; x < FACE_W; x++) {
    const edge = Math.min(x, y, FACE_W - 1 - x, FACE_H - 1 - y);
    if (edge === 0) setPx(img, x, y, out);
    else if (edge === 1) setPx(img, x, y, steel[rnd() < 0.3 ? 0 : 1]);
  }
  for (const r of plan.rects) fillRect(img, r.x, r.y, r.w, r.h, r.color);
  for (const t of plan.texts) drawBoardText(img, t.s, t.x, t.y, t.color);
  return img;
}
// The frame texels of a face (edge distance < BOARD_LAYOUT.border): the only ones the time of day changes.
export function isFrameTexel(x, y) { return Math.min(x, y, FACE_W - 1 - x, FACE_H - 1 - y) < BOARD_LAYOUT.border; }

// ---- mesh -------------------------------------------------------------------------------------------------------------
// createLeaderboard({ seed, look }) -> { mesh, faces, update(view), setLook(look), getDebugState(), dispose() }.
//  - mesh: Group at the origin (the scene places it at the pylon); bounding box exactly 3 x 7 x 3 (the plinth is the
//    3 x 3 footprint), userData.colliderTag 'pylon'.
//  - update(view): repaints only the faces whose display list changed; returns the indices repainted.
//  - setLook(look): time of day (presets.mjs TIME_PRESETS shape); repaints the frames, retints cap and plinth.
export function createLeaderboard(opts) {
  opts = opts || {};
  const seed = opts.seed == null ? 1 : opts.seed;
  let look = opts.look || TIME_PRESETS.day, lastView = null;
  const group = new Group();
  group.name = 'leaderboard';
  group.userData.colliderTag = 'pylon';
  const disposables = [];
  const track = (o) => { disposables.push(o); return o; };
  const faceGeo = track(new PlaneGeometry(PYLON_W, PYLON_H));
  const faces = FACE_DEG.map((deg, k) => {
    const blank = createImage(FACE_W, FACE_H);
    const texture = track(pixelTexture(blank));
    const material = track(new MeshBasicMaterial({ map: texture, color: new Color(1, 1, 1) }));
    const mesh = new Mesh(faceGeo, material);
    const nx = Math.cos(deg * Math.PI / 180), nz = Math.sin(deg * Math.PI / 180);
    mesh.position.set(nx * INRADIUS, PYLON_H / 2, CENTROID_Z + nz * INRADIUS);
    mesh.rotation.y = Math.atan2(nx, nz);               // the plane's +z onto (nx, nz); its +x is then the viewer's right
    mesh.name = 'leaderboard:face' + k;
    group.add(mesh);
    return { index: k, deg, normal: [nx, nz], mesh, texture, material, image: blank, plan: null, sig: null, paints: 0 };
  });
  const capMat = track(new MeshBasicMaterial({ color: new Color() }));
  const plinthMat = track(new MeshBasicMaterial({ color: new Color() }));
  const capGeo = track(new BufferGeometry());
  const zs = TRI_H / 2;
  capGeo.setAttribute('position', new Float32BufferAttribute([-PYLON_W / 2, 0, zs, PYLON_W / 2, 0, zs, 0, 0, -zs], 3));
  capGeo.setAttribute('normal', new Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  const cap = new Mesh(capGeo, capMat);
  cap.position.y = PYLON_H;
  cap.name = 'leaderboard:cap';
  const plinth = new Mesh(track(new BoxGeometry(PYLON_W, PLINTH_H, PYLON_W)), plinthMat);
  plinth.position.y = PLINTH_H / 2;
  plinth.name = 'leaderboard:plinth';
  group.add(cap, plinth);

  function retint() {
    capMat.color.copy(rgbColor(RAMPS.steel[1])).multiply(new Color().setRGB(...look.tint));
    plinthMat.color.copy(rgbColor(RAMPS.steel[0])).multiply(new Color().setRGB(...look.tint));
  }
  function paint(face, view) {
    const plan = planFace(view, face.index), sig = JSON.stringify(plan);
    if (sig === face.sig) return false;
    const img = paintFace(plan, look, seed);
    face.texture.image.data.set(flipRows(img).data);
    face.texture.needsUpdate = true;
    Object.assign(face, { image: img, plan, sig, paints: face.paints + 1 });
    return true;
  }
  function update(view) {
    if (!view) return [];
    lastView = view;
    return faces.filter((f) => paint(f, view)).map((f) => f.index);
  }
  function setLook(l) {
    look = l || TIME_PRESETS.day;
    retint();
    faces.forEach((f) => { f.sig = null; });
    return update(lastView);
  }
  retint();
  update(opts.view || { title: TITLE, rows: [], offline: true });   // nothing known yet: OFFLINE until the first update
  return {
    mesh: group, faces, update, setLook,
    getDebugState() {
      return {
        time: look.time || null, offline: !!(lastView && lastView.offline),
        faces: faces.map((f) => ({ deg: f.deg, lots: f.plan.texts.filter((t) => t.field === 'label' && t.lot !== '*').map((t) => t.lot), paints: f.paints, overflow: f.plan.overflow }))
      };
    },
    dispose() { disposables.forEach((d) => d.dispose()); disposables.length = 0; }
  };
}
