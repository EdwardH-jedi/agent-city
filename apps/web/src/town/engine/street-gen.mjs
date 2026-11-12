// M2.8 Phase C street generator: road, pavements, curbs and the street furniture of the alley. Pure functions, no three.js.
// Images are top-down RGBA (row 0 = top) like textures.mjs, sized at 16 texels per world unit (texels() throws otherwise).
// Ground images are laid out as the camera sees them from above: columns run along +x, row 0 is the far (-z) end.
// Patterns come from hash01(seed, texel x, texel z) in world texel coordinates, so neighbouring surfaces agree.
import { PX_PER_UNIT, RAMPS, OUTLINE, createImage, setPx, fillRect, strokeRect } from './textures.mjs';
import { hash01, texels } from './facade-gen.mjs';
import { ROAD_HALF, CURB_W, CURB_H, ROAD_Z, PAVE_Z, DRAINS, DRAIN_W, DRAIN_D, MANHOLE, CROSSWALK, PROPS } from './alley-layout.mjs';

const ASPHALT = [[0x3e, 0x42, 0x4c], [0x4a, 0x4f, 0x5a], [0x54, 0x59, 0x64], [0x60, 0x65, 0x70]];
const PAVING = [[0x8e, 0x8a, 0x84], [0xae, 0xaa, 0xa0], [0xbc, 0xb8, 0xae], [0xca, 0xc6, 0xbc]];
const CURB = [[0x76, 0x76, 0x7a], [0x9e, 0x9e, 0xa2], [0xbc, 0xbc, 0xbc], [0xd8, 0xd8, 0xd4]];
const PAINT = [[0xc8, 0xc6, 0xbc], [0xe8, 0xe6, 0xdc]];
const SOIL = [[0x34, 0x28, 0x22], [0x46, 0x36, 0x2a]];
const LEAF = [[0x24, 0x4a, 0x2e], [0x34, 0x66, 0x3a], [0x4a, 0x84, 0x48], [0x6c, 0xa2, 0x5a]];
const LEAF_EDGE = [0x18, 0x30, 0x20];
const BARK = [[0x46, 0x34, 0x28], [0x5c, 0x44, 0x32], [0x74, 0x58, 0x40]];
const RED = [[0x6e, 0x1c, 0x20], [0x92, 0x28, 0x2a], [0xb2, 0x38, 0x34], [0xd0, 0x58, 0x4c]];
const CREAM = [0xf0, 0xe4, 0xc0];
export const STREET_PALETTE = Object.freeze({ ASPHALT, PAVING, CURB, PAINT, SOIL, LEAF, RED });

function clearPx(img, x, y) { const i = (y * img.width + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = img.data[i + 3] = 0; }
const pick = (ramp, t) => ramp[Math.min(ramp.length - 1, Math.floor(t * ramp.length))];
// Texel index of a world coordinate (texel k covers [k/16, (k+1)/16)).
export const tx = (w) => Math.floor(w * PX_PER_UNIT + 1e-6);

// ---- road: asphalt, gutters, dashed centre line, drains, manhole, zebra crossing -----------------------------------
export function makeRoad(seed) {
  const W = texels(2 * ROAD_HALF), H = texels(ROAD_Z.z1 - ROAD_Z.z0), img = createImage(W, H);
  const x0 = tx(-ROAD_HALF), z0 = tx(ROAD_Z.z0), cw0 = tx(CROSSWALK.z0), cw1 = tx(CROSSWALK.z1);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const wz = z0 + r, h = hash01(seed, x0 + c, wz);
    let col = h < 0.08 ? ASPHALT[0] : h < 0.55 ? ASPHALT[1] : h < 0.93 ? ASPHALT[2] : ASPHALT[3];
    if (c < 2 || c >= W - 2) col = h < 0.2 ? CURB[0] : CURB[1];                           // concrete gutter pan
    else if (c === 2 || c === W - 3) col = ASPHALT[0];                                     // seam
    else if ((c === W / 2 - 1 || c === W / 2) && (wz >> 4) % 2 === 0 && (wz < cw0 - 8 || wz >= cw1 + 8)) col = h < 0.15 ? PAINT[0] : PAINT[1];
    if (wz >= cw0 && wz < cw1 && c >= 4 && c < W - 4 && ((c - 4) % 6) < 4) col = (wz === cw0 || wz === cw1 - 1 || h < 0.06) ? PAINT[0] : PAINT[1];
    setPx(img, c, r, col);
  }
  for (const d of DRAINS) {                                                                // grate against the curb
    const dw = texels(DRAIN_W), dd = texels(DRAIN_D), c0 = d.side === 'west' ? 0 : W - dw, r0 = tx(d.z - DRAIN_D / 2) - z0;
    fillRect(img, c0, r0, dw, dd, OUTLINE);
    for (let j = 1; j < dd - 1; j += 2) fillRect(img, c0 + 1, r0 + j, dw - 2, 1, RAMPS.steel[1]);
  }
  const mr = texels(MANHOLE.d) / 2, mcx = tx(MANHOLE.x) - x0, mcz = tx(MANHOLE.z) - z0;   // round cover, 1 px rim
  for (let j = -mr; j < mr; j++) for (let i = -mr; i < mr; i++) {
    const d2 = (i + 0.5) ** 2 + (j + 0.5) ** 2;
    if (d2 > mr * mr) continue;
    setPx(img, mcx + i, mcz + j, d2 > (mr - 1) * (mr - 1) ? OUTLINE : ((i + j) & 2) ? RAMPS.steel[1] : RAMPS.steel[2]);
  }
  return img;
}

// ---- pavement: lighter 10 x 10 texel slabs with 1 px joints, a soil pit under every tree on this side ---------------
export function makePavement(side, seed) {
  const xa = side === 'west' ? -3 : ROAD_HALF + CURB_W, W = texels(3 - ROAD_HALF - CURB_W), H = texels(PAVE_Z.z1 - PAVE_Z.z0);
  const img = createImage(W, H), x0 = tx(xa), z0 = tx(PAVE_Z.z0);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const wx = x0 + c, wz = z0 + r, joint = ((wx % 10) + 10) % 10 === 9 || ((wz % 10) + 10) % 10 === 9;
    const slab = hash01(seed + 1, Math.floor(wx / 10), Math.floor(wz / 10)), h = hash01(seed, wx, wz);
    setPx(img, c, r, joint || h < 0.07 ? PAVING[0] : PAVING[slab < 0.4 ? 1 : slab < 0.8 ? 2 : 3]);
  }
  for (const p of PROPS) {
    if (p.kind !== 'tree' || p.side !== side) continue;
    const c0 = tx(p.x - p.w / 2) - x0, r0 = tx(p.z - p.d / 2) - z0, n = texels(p.w);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) setPx(img, c0 + i, r0 + j, SOIL[hash01(seed, i, j) < 0.5 ? 0 : 1]);
  }
  return img;
}

// ---- props: one primary box (its footprint = the collider) + decor children ------------------------------------------
// part: { name, kind, size: [sx, sy, sz], at: [x, y, z] (bottom-centre relative to the prop's footprint centre on the
// ground), alpha, primary }, or a camera-facing sprite { sprite: true, size: [w, h] }. dir (+1 west, -1 east) points at
// the road.
export function planProp(p) {
  const dir = p.side === 'west' ? 1 : -1, parts = [];
  const part = (name, kind, size, at, alpha, primary) => parts.push(Object.freeze({ name, kind, size: Object.freeze(size), at: Object.freeze(at), alpha: !!alpha, primary: !!primary }));
  switch (p.kind) {
    case 'bin': case 'mailbox': case 'vending': part(p.kind, p.kind, [p.w, p.h, p.d], [0, 0, 0], false, true); break;
    case 'lamp':
      part('lamp-base', 'lamp-base', [p.w, 0.25, p.d], [0, 0, 0], false, true);
      part('lamp-pole', 'lamp-pole', [0.1875, 4, 0.1875], [0, 0.25, 0]);
      part('lamp-arm', 'lamp-arm', [0.5625, 0.125, 0.125], [dir * 0.375, 4, 0]);
      part('lamp-head', 'lamp-head', [0.375, 0.25, 0.375], [dir * 0.5, 3.75, 0]);
      break;
    case 'bench':
      part('bench-seat', 'bench-seat', [p.w, 0.125, p.d], [0, 0.4375, 0], false, true);
      part('bench-back', 'bench-back', [0.125, 0.5, p.d], [-dir * 0.25, 0.5625, 0]);
      for (const s of [-1, 1]) part('bench-leg:' + (s < 0 ? 0 : 1), 'bench-leg', [0.5, 0.4375, 0.125], [0, 0, s * (p.d / 2 - 0.1875)]);
      break;
    case 'planter':
      part('planter', 'planter', [p.w, 0.5, p.d], [0, 0, 0], false, true);
      part('bush', 'bush', [p.w - 0.125, 0.5, p.d - 0.125], [0, 0.5, 0], true);
      break;
    case 'tree':
      part('tree-guard', 'guard', [p.w, 0.375, p.d], [0, 0, 0], true, true);
      part('trunk', 'trunk', [0.1875, 2.875, 0.1875], [0, 0, 0]);
      parts.push(Object.freeze({ name: 'canopy', kind: 'canopy', sprite: true, size: Object.freeze([2, 1.75]), at: Object.freeze([0, 2.625, 0]), alpha: true, primary: false }));
      break;
    default: throw new Error('unknown prop kind: ' + p.kind);
  }
  return parts;
}

// Face roles of a box part: front faces the road, back the wall, side = the two faces along the street (+z / -z).
// BoxGeometry material order is +x, -x, +y, -y, +z, -z.
export function faceRoles(side) { return side === 'west' ? ['front', 'back', 'top', 'bottom', 'side', 'side'] : ['back', 'front', 'top', 'bottom', 'side', 'side']; }
// Texel size [w, h] of a face role for a box of size [sx, sy, sz].
export function faceTexels(size, role) {
  const [sx, sy, sz] = size;
  return role === 'front' || role === 'back' ? [texels(sz), texels(sy)] : role === 'top' || role === 'bottom' ? [texels(sx), texels(sz)] : [texels(sx), texels(sy)];
}

// Paint one face (w x h texels) of a prop part or curb. Deterministic for (kind, role, w, h, seed, lit); lit: lamp head on.
export function paintPropFace(kind, role, w, h, seed, lit) {
  const img = createImage(w, h), rnd = (i, j) => hash01(seed, i + 17 * w, j + 31 * h);
  const vertical = role !== 'top' && role !== 'bottom';
  switch (kind) {
    case 'bin': {
      const g = RAMPS.green;
      if (!vertical) { fillRect(img, 0, 0, w, h, role === 'top' ? g[2] : g[0]); if (role === 'top') { strokeRect(img, 0, 0, w, h, OUTLINE); fillRect(img, 2, (h >> 1) - 1, w - 4, 2, g[3]); } break; }
      fillRect(img, 0, 0, w, h, g[1]);
      fillRect(img, 0, 0, w, 3, g[3]); fillRect(img, 0, 3, w, 1, OUTLINE);                  // lid
      for (let x = 2; x < w - 1; x += 3) fillRect(img, x, 5, 1, h - 7, g[0]);                // ribs
      for (let j = 4; j < h - 1; j++) for (let i = 1; i < w - 1; i++) if (rnd(i, j) < 0.06) setPx(img, i, j, g[2]);
      fillRect(img, 0, h - 1, w, 1, g[0]);
      strokeRect(img, 0, 0, w, h, OUTLINE);
      break;
    }
    case 'lamp-base':
      fillRect(img, 0, 0, w, h, RAMPS.steel[1]);
      if (vertical) { fillRect(img, 0, 0, w, 1, RAMPS.steel[3]); fillRect(img, 0, h - 1, w, 1, RAMPS.steel[0]); strokeRect(img, 0, 0, w, h, OUTLINE); }
      break;
    case 'lamp-pole': case 'lamp-arm':
      fillRect(img, 0, 0, w, h, RAMPS.lamp[1]);
      if (vertical && kind === 'lamp-pole') { fillRect(img, 0, 0, 1, h, RAMPS.steel[2]); fillRect(img, w - 1, 0, 1, h, RAMPS.lamp[0]); }
      if (vertical && kind === 'lamp-arm') fillRect(img, 0, h - 1, w, 1, RAMPS.lamp[0]);
      break;
    case 'lamp-head':                                  // lantern: glass panels on the four sides; lit at dusk / night (Phase D)
      if (!vertical) { fillRect(img, 0, 0, w, h, role === 'top' ? RAMPS.lamp[0] : lit ? RAMPS.lamp[3] : RAMPS.lamp[1]); break; }
      if (lit) { fillRect(img, 0, 0, w, h, RAMPS.lamp[2]); fillRect(img, 1, 1, w - 2, 1, RAMPS.lamp[3]); }
      else { fillRect(img, 0, 0, w, h, RAMPS.glass[2]); fillRect(img, 1, 1, w - 2, 1, RAMPS.glass[3]); }
      strokeRect(img, 0, 0, w, h, OUTLINE);
      break;
    case 'bench-seat': case 'bench-back': {
      const wd = RAMPS.wood;
      fillRect(img, 0, 0, w, h, wd[2]);
      if (!vertical) { for (let i = 0; i < w; i++) if (i % 3 === 2) fillRect(img, i, 0, 1, h, wd[0]); else if (i % 3 === 0) fillRect(img, i, 0, 1, h, wd[3]); }
      else if (kind === 'bench-back' && role !== 'side') { for (let j = 0; j < h; j++) if (j % 4 === 3) fillRect(img, 0, j, w, 1, wd[0]); else if (j % 4 === 0) fillRect(img, 0, j, w, 1, wd[3]); }
      else { fillRect(img, 0, 0, w, 1, wd[3]); fillRect(img, 0, h - 1, w, 1, wd[0]); }
      if (vertical) { fillRect(img, 0, 0, 1, h, OUTLINE); fillRect(img, w - 1, 0, 1, h, OUTLINE); }
      break;
    }
    case 'bench-leg':
      fillRect(img, 0, 0, w, h, RAMPS.steel[0]);
      if (vertical) fillRect(img, 0, 0, w, 1, RAMPS.steel[2]);
      break;
    case 'planter':
      fillRect(img, 0, 0, w, h, CURB[2]);
      if (vertical) {
        fillRect(img, 0, 0, w, 2, CURB[3]); fillRect(img, 0, 2, w, 1, CURB[0]); fillRect(img, 0, h - 1, w, 1, CURB[0]);
        for (let i = 7; i < w - 1; i += 8) fillRect(img, i, 3, 1, h - 4, CURB[1]);
        strokeRect(img, 0, 0, w, h, OUTLINE);
      } else if (role === 'top') { fillRect(img, 2, 2, w - 4, h - 4, SOIL[0]); strokeRect(img, 0, 0, w, h, CURB[3]); }
      break;
    case 'bush':                                       // leaf block; the top rows of every side are cut irregularly
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const t = rnd(i >> 1, j >> 1);
        setPx(img, i, j, role === 'top' ? pick(LEAF.slice(1), t) : j < 3 ? LEAF[3] : pick(LEAF, t * 0.9));
      }
      if (vertical) for (let i = 0; i < w; i++) { const cut = Math.floor(rnd(i, 99) * 4); for (let j = 0; j < cut; j++) clearPx(img, i, j); setPx(img, i, cut, LEAF_EDGE); }
      else if (role === 'top') for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) if ((i === 0 || j === 0 || i === w - 1 || j === h - 1) && rnd(i, j + 50) < 0.5) clearPx(img, i, j);
      break;
    case 'guard':                                      // open iron tree guard: rails + bars, see-through to the soil pit
      if (vertical) { fillRect(img, 0, 0, w, 1, RAMPS.steel[0]); fillRect(img, 0, h - 2, w, 1, RAMPS.steel[1]); for (let i = 0; i < w; i += 3) fillRect(img, i, 0, 1, h, RAMPS.steel[0]); fillRect(img, w - 1, 0, 1, h, RAMPS.steel[0]); }
      else if (role === 'top') strokeRect(img, 0, 0, w, h, RAMPS.steel[0]);
      break;                                           // everything not painted stays alpha 0
    case 'trunk':
      fillRect(img, 0, 0, w, h, BARK[1]);
      if (vertical) { fillRect(img, 0, 0, 1, h, BARK[2]); fillRect(img, w - 1, 0, 1, h, BARK[0]); for (let j = 0; j < h; j++) if (rnd(0, j) < 0.12) setPx(img, 1, j, BARK[0]); }
      break;
    case 'mailbox':
      if (!vertical) { fillRect(img, 0, 0, w, h, role === 'top' ? RED[3] : RED[0]); if (role === 'top') strokeRect(img, 0, 0, w, h, RED[1]); break; }
      fillRect(img, 0, 0, w, h, RED[2]);
      fillRect(img, 0, 0, w, 2, RED[3]); fillRect(img, 0, 2, w, 1, RED[0]);                  // cap
      fillRect(img, 0, h - 2, w, 2, RED[0]);                                                 // plinth
      fillRect(img, 1, 3, 1, h - 5, RED[3]);                                                 // highlight
      if (role === 'front') { fillRect(img, 2, 5, w - 4, 1, OUTLINE); fillRect(img, 2, 8, w - 4, 3, PAINT[1]); strokeRect(img, 2, 8, w - 4, 3, RED[0]); }
      strokeRect(img, 0, 0, w, h, OUTLINE);
      break;
    case 'vending': {
      const t = RAMPS.teal;
      if (!vertical) { fillRect(img, 0, 0, w, h, t[0]); if (role === 'top') strokeRect(img, 0, 0, w, h, OUTLINE); break; }
      fillRect(img, 0, 0, w, h, role === 'side' ? t[2] : t[1]);
      if (role === 'front') {
        fillRect(img, 2, 2, w - 4, 13, RAMPS.glass[0]); strokeRect(img, 1, 1, w - 2, 15, OUTLINE);   // display window
        const cans = [RAMPS.rust[3], RAMPS.mustard[3], RAMPS.sport[2], RAMPS.green[3], CREAM];
        for (let row = 0; row < 2; row++) for (let k = 0; k < Math.floor((w - 5) / 3); k++) {
          const x = 3 + k * 3, y = 3 + row * 6;
          fillRect(img, x, y, 2, 4, cans[(k + row * 2) % cans.length]); setPx(img, x, y, RAMPS.lamp[3]);
        }
        fillRect(img, 2, 17, w - 4, 5, CREAM);                                                 // button panel
        for (let k = 0; k < Math.floor((w - 6) / 2); k++) setPx(img, 3 + k * 2, 19, t[0]);
        fillRect(img, 3, h - 6, w - 6, 3, OUTLINE);                                            // dispenser slot
      } else if (role === 'side') fillRect(img, 0, 3, w, 2, CREAM);
      fillRect(img, 0, h - 1, w, 1, t[0]);
      strokeRect(img, 0, 0, w, h, OUTLINE);
      break;
    }
    case 'curb':                                       // granite kerb: light top with joints, faces = light lip + body
      if (role === 'top') { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) setPx(img, i, j, rnd(i, j) < 0.1 ? CURB[1] : CURB[2]); for (let j = 15; j < h; j += 16) fillRect(img, 0, j, w, 1, CURB[0]); }
      else if (vertical) { fillRect(img, 0, 0, w, h, CURB[1]); fillRect(img, 0, 0, w, 1, CURB[3]); for (let i = 15; i < w; i += 16) fillRect(img, i, 0, 1, h, CURB[0]); }
      else fillRect(img, 0, 0, w, h, CURB[0]);
      break;
    default: throw new Error('unknown prop part: ' + kind);
  }
  return img;
}

// Tree canopy sprite (w x h texels): a round leaf mass lit from the top left, 1 px dark edge, binary alpha.
export function makeCanopy(w, h, seed) {
  const img = createImage(w, h), cx = w / 2, cy = h / 2, rx = w / 2 - 0.5, ry = h / 2 - 0.5;
  const inside = (i, j) => i >= 0 && j >= 0 && i < w && j < h &&
    ((i + 0.5 - cx) / rx) ** 2 + ((j + 0.5 - cy) / ry) ** 2 <= 1 - 0.18 * hash01(seed, i >> 2, j >> 2);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!inside(i, j)) continue;                       // stays alpha 0
    const edge = !inside(i - 1, j) || !inside(i + 1, j) || !inside(i, j - 1) || !inside(i, j + 1);
    const light = ((cx - i) / w + (cy - j) / h) * 0.9 + 0.5 + (hash01(seed + 3, i >> 1, j >> 1) - 0.5) * 0.45;
    setPx(img, i, j, edge ? LEAF_EDGE : pick(LEAF, Math.max(0, Math.min(0.999, light))));
  }
  return img;
}

// Lamp glow sprite (n x n texels, Phase D): three hard-edged concentric discs of warm light with stepped alpha, drawn
// additively (no filtering, no smooth falloff: every texel is one of three values or empty).
export const GLOW_COLOR = [0xff, 0xd8, 0x8a];
export const GLOW_RINGS = Object.freeze([[0.42, 160], [0.72, 92], [1, 44]]);   // [radius fraction, alpha byte], inner first
export function makeGlow(n) {
  const img = createImage(n, n), c = n / 2;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const r = Math.hypot(i + 0.5 - c, j + 0.5 - c) / c, ring = GLOW_RINGS.find(([f]) => r <= f);
    if (!ring) continue;
    const k = (j * n + i) * 4;
    img.data.set(GLOW_COLOR, k); img.data[k + 3] = ring[1];
  }
  return img;
}

// Ground-layer pieces of the street (walk-over: none has a collider). size = [x, y, z] world units, at = bottom centre.
// Road and pavements are flat planes at y = 0; the curbs are thin boxes CURB_H high between them.
export function planStreet() {
  const len = PAVE_Z.z1 - PAVE_Z.z0, cz = (PAVE_Z.z0 + PAVE_Z.z1) / 2, pw = 3 - ROAD_HALF - CURB_W;
  return Object.freeze([
    { name: 'street:road', kind: 'road', size: [2 * ROAD_HALF, 0, ROAD_Z.z1 - ROAD_Z.z0], at: [0, 0, (ROAD_Z.z0 + ROAD_Z.z1) / 2] },
    { name: 'street:pavement:west', kind: 'pavement', side: 'west', size: [pw, 0, len], at: [-3 + pw / 2, 0, cz] },
    { name: 'street:pavement:east', kind: 'pavement', side: 'east', size: [pw, 0, len], at: [3 - pw / 2, 0, cz] },
    { name: 'street:curb:west', kind: 'curb', side: 'west', size: [CURB_W, CURB_H, len], at: [-ROAD_HALF - CURB_W / 2, 0, cz] },
    { name: 'street:curb:east', kind: 'curb', side: 'east', size: [CURB_W, CURB_H, len], at: [ROAD_HALF + CURB_W / 2, 0, cz] }
  ].map(Object.freeze));
}
