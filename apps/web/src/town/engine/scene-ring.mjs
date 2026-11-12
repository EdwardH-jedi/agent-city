// M3.0 ring town scene (prompts/M30_RING.md §1.2, §2) on the low-res WebGL renderer. Everything stands where
// renderer/ring-layout.mjs puts it (the collision world reads the same data), built from the alley/town generators:
//  - ten lot facades: facade-gen through alley-meshes' buildFacadeBuilding, each built as an alley 'west' lot and turned to
//    face the ring centre (lot.facadeRotY); lots 9/10 are boarded shopfronts with a lit COMING SOON board;
//  - pavement and plaza props (lamps, trees, benches, bins): street-gen planProp parts, turned to face the road;
//  - one painted ground image (16 texels per unit): the town's sunburst plaza, a lawn with four radial paths, slab
//    pavements with curbs, the asphalt ring with a dashed centre line and a zebra crossing in front of every door,
//    planting verges beyond the outer pavement edge (not walkable), a low hedge in each gap between two lots;
//  - a status lamp above every door, coloured from the leaderboard's BoardView rows by setLamps(rows);
//  - sky gradient, fog and the skyline as the town; lamp glows at dusk / night.
// The pylon is lane C's: opts.pylon (a function returning a three.js object or { mesh }) is called once and its mesh
// placed on PYLON; without it a plain 3 x 3 x 7 steel placeholder stands there.
import {
  Scene, Fog, Mesh, Group, PlaneGeometry, BoxGeometry, MeshBasicMaterial, Sprite, SpriteMaterial, DataTexture, RGBAFormat,
  UnsignedByteType, NearestFilter, RepeatWrapping, ClampToEdgeWrapping, Color, AdditiveBlending, Vector3
} from 'three';
import { makeSkyGradientRGBA, GROUND_Y } from './scene-alley.mjs';
import { buildFacadeBuilding, pixelTexture, rgbColor, GLOW_SIZE } from './alley-meshes.mjs';
import { hash01, texels } from './facade-gen.mjs';
import { planProp, faceRoles, faceTexels, paintPropFace, makeCanopy, makeGlow, STREET_PALETTE } from './street-gen.mjs';
import { groundTexel, makeTile, worldUvBox } from './scene-town.mjs';
import { buildSkyline } from './skyline.mjs';
import { PX_PER_UNIT, RAMPS, OUTLINE, createImage, setPx, fillRect, strokeRect, drawText, textWidth } from './textures.mjs';
import {
  LOTS, LOT_W, LOT_D, PROPS, PYLON, PLAZA_R, ROAD_HALF, INNER_EDGE, OUTER_EDGE, CROSS_W,
  ellipseTheta, ellipseOffset, ellipseNormal, offsetPoint, arcTable, lotRect, doorOf, obbDistance
} from './ring-layout.mjs';
import { TIME_PRESETS } from './presets.mjs';

// Painted ground: one image over the ring, the lots and a margin (row 0 = north edge, column 0 = west edge).
export const RING_GROUND_RECT = Object.freeze({ x0: -48, x1: 48, z0: -40, z1: 40 });
const { ASPHALT, PAVING, CURB, PAINT, SOIL, LEAF } = STREET_PALETTE;
const GRASS = RAMPS.green, STONE = RAMPS.plaster;
const m16 = (v, n) => ((v % n) + n) % n;
const CURB_W = 0.25, SLAB = 0.625, MAT_DEPTH = 1;

// Lit sign boards (COMING SOON, NO WUKKAS) use two glyphs textures.mjs's font does not have, drawn here on the same 5-row
// grid; every other letter is textures.mjs's. Facade-gen's painted signs stay on its own font (signs it can draw).
const SIGN_GLYPHS = { M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'], U: ['#.#', '#.#', '#.#', '#.#', '###'] };
const glyphW = (ch) => (SIGN_GLYPHS[ch] ? SIGN_GLYPHS[ch][0].length : textWidth(ch, 1));
export function signTextWidth(text, s) { let w = 0; for (const ch of text) w += (glyphW(ch) + 1) * s; return w - s; }
export function drawSignText(img, text, x, y, s, color) {
  let cx = x;
  for (const ch of text) {
    const g = SIGN_GLYPHS[ch];
    if (g) { for (let r = 0; r < 5; r++) for (let c = 0; c < g[r].length; c++) if (g[r][c] === '#') fillRect(img, cx + c * s, y + r * s, s, s, color); }
    else drawText(img, ch, cx, y, s, color);
    cx += (glyphW(ch) + 1) * s;
  }
}
const facadeCanSign = (text) => { try { textWidth(text, 2); return true; } catch (e) { return false; } };

// Status lamps (one above each door): the lot's state from its BoardView row. Colours match the pylon's counters
// (working green / waiting amber / idle grey); 'unknown' is a dim violet, 'offline' a dim red, 'off' an unlit lens.
export const LAMP_COLORS = Object.freeze({
  working: [0x4c, 0xd0, 0x6a], waiting: [0xf0, 0xb0, 0x30], idle: [0xa8, 0xae, 0xb6], unknown: [0x7a, 0x6a, 0x9a],
  offline: [0x9a, 0x2c, 0x2c], off: [0x2a, 0x2c, 0x32]
});
export function lampState(row, offline) {
  if (offline) return 'offline';
  if (!row) return 'off';
  const n = (v) => (typeof v === 'number' && v > 0 ? v : 0);
  return n(row.working) ? 'working' : n(row.waiting) ? 'waiting' : n(row.idle) ? 'idle' : n(row.unknown) ? 'unknown' : 'off';
}

// ---- ground ----
// Offset and θ change slowly, so they are evaluated exactly on a quarter-unit grid and interpolated per texel (offset
// error < 0.001 units, i.e. < 1/60 texel); θ is interpolated as (cos θ, sin θ). Arc length along the centre line (`s`)
// drives the centre-line dashes and the radial slab joints.
const GRID = 4;                                                   // texels per grid cell
export function makeRingGround(seed) {
  const R = RING_GROUND_RECT, W = texels(R.x1 - R.x0), H = texels(R.z1 - R.z0), img = createImage(W, H);
  const gx0 = R.x0 * PX_PER_UNIT, gz0 = R.z0 * PX_PER_UNIT;
  const GW = W / GRID + 1, GH = H / GRID + 1, OFF = new Float64Array(GW * GH), CS = new Float64Array(GW * GH), SN = new Float64Array(GW * GH);
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const x = (gx0 + i * GRID) / PX_PER_UNIT, z = (gz0 + j * GRID) / PX_PER_UNIT, th = ellipseTheta(x, z), k = j * GW + i;
    OFF[k] = ellipseOffset(x, z); CS[k] = Math.cos(th); SN[k] = Math.sin(th);
  }
  const centre = arcTable(0), doors = LOTS.map((L) => doorOf(L)), matWall = new Map(LOTS.map((L) => [L.id, RAMPS[L.wall][2]]));
  const lerp = (arr, i, j, fx, fz) => {
    const k = j * GW + i;
    return (arr[k] * (1 - fx) + arr[k + 1] * fx) * (1 - fz) + (arr[k + GW] * (1 - fx) + arr[k + GW + 1] * fx) * fz;
  };
  for (let r = 0; r < H; r++) {
    const j = Math.floor((r + 0.5) / GRID), fz = ((r + 0.5) - j * GRID) / GRID;
    for (let c = 0; c < W; c++) {
      const gx = gx0 + c, gz = gz0 + r, x = (gx + 0.5) / PX_PER_UNIT, z = (gz + 0.5) / PX_PER_UNIT;
      const i = Math.floor((c + 0.5) / GRID), fx = ((c + 0.5) - i * GRID) / GRID;
      const o = lerp(OFF, i, j, fx, fz), h = hash01(seed, gx, gz), rr = Math.hypot(x, z);
      let col;
      if (rr <= PLAZA_R) {
        col = rr > PLAZA_R - 0.375 ? (m16(Math.floor(Math.atan2(z, x) * 48 / Math.PI), 2) ? STONE[2] : STONE[3])   // kerb ring
          : groundTexel(gx, gz, seed);                                                                          // the town's sunburst
      } else if (o < INNER_EDGE) {                                                                                // lawn + paths
        const ns = Math.abs(x) <= 1 && Math.abs(z) > PLAZA_R - 1, ew = Math.abs(z) <= 1 && Math.abs(x) > PLAZA_R - 1;
        if (ns || ew) {
          const edge = (1 - (ns ? Math.abs(x) : Math.abs(z))) * PX_PER_UNIT < 1;
          col = edge ? STONE[1] : m16(ns ? gz : gx, 10) === 9 ? PAVING[0] : PAVING[hash01(seed + 3, gx >> 3, gz >> 3) < 0.5 ? 2 : 3];
        } else col = h > 0.992 ? [RAMPS.rose[3], RAMPS.mustard[3], STONE[3]][m16(gx + gz, 3)] : GRASS[h < 0.2 ? 1 : h > 0.85 ? 3 : 2];
      } else if (o >= OUTER_EDGE) {                                                                               // planting verge
        col = o < OUTER_EDGE + 2 / 16 ? STONE[1] : h < 0.18 ? LEAF[h < 0.06 ? 1 : 2] : SOIL[h < 0.6 ? 0 : 1];
      } else {
        const s = centre.lenAt(Math.atan2(lerp(SN, i, j, fx, fz), lerp(CS, i, j, fx, fz))), ao = Math.abs(o);
        if (ao < ROAD_HALF) {                                                                                     // asphalt
          col = h < 0.08 ? ASPHALT[0] : h < 0.55 ? ASPHALT[1] : h < 0.93 ? ASPHALT[2] : ASPHALT[3];
          if (ao > ROAD_HALF - 2 / 16) col = h < 0.2 ? CURB[0] : CURB[1];                                          // gutter pans
          else if (ao < 1 / 16 + 1e-9 && (Math.floor(s) & 1) === 0) col = h < 0.15 ? PAINT[0] : PAINT[1];         // centre dashes
          if (ao < ROAD_HALF - 4 / 16) {
            for (const d of doors) {                                                                               // zebra bars
              if (Math.abs((x - d.x) * d.tx + (z - d.z) * d.tz) > CROSS_W / 2 || (x - d.x) * d.nx + (z - d.z) * d.nz > -ROAD_HALF) continue;
              if (Math.floor((o + ROAD_HALF) * 2.5) & 1) col = h < 0.06 ? PAINT[0] : PAINT[1];
              break;
            }
          }
        } else if (ao < ROAD_HALF + CURB_W) {                                                                      // curbs
          col = m16(Math.floor(s * 3.2), 2) ? CURB[2] : CURB[1];
        } else {                                                                                                    // slab pavements
          const sj = s / SLAB, aj = (ao - ROAD_HALF - CURB_W) / SLAB, jw = 1 / (SLAB * PX_PER_UNIT);
          const slab = hash01(seed + 1, Math.floor(sj), Math.floor(aj) + (o < 0 ? 50 : 0));
          col = sj - Math.floor(sj) < jw || aj - Math.floor(aj) < jw || h < 0.05 ? PAVING[0] : PAVING[slab < 0.4 ? 1 : slab < 0.8 ? 2 : 3];
          if (o > 0) {                                                                                            // door mats
            for (const d of doors) {
              const lat = Math.abs((x - d.x) * d.tx + (z - d.z) * d.tz), dn = (x - d.x) * d.nx + (z - d.z) * d.nz;
              if (lat > 1.25 || dn <= -MAT_DEPTH) continue;
              col = Math.min(1.25 - lat, dn + MAT_DEPTH) * PX_PER_UNIT < 2 ? matWall.get(d.id) : (gz & 1 ? [0x3a, 0x36, 0x3c] : [0x46, 0x42, 0x48]);
              break;
            }
          }
        }
      }
      setPx(img, c, r, col);
    }
  }
  return img;
}
// The base plane beyond the painted rect: one unit of lawn (the ring stands in parkland), 16 x 16 texels.
export function makeLawnTileRGBA(seed) {
  const out = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const h = hash01(seed + 21, x, y), c = GRASS[h < 0.25 ? 0 : h < 0.75 ? 1 : 2], k = (y * 16 + x) * 4;
    out[k] = c[0]; out[k + 1] = c[1]; out[k + 2] = c[2]; out[k + 3] = 255;
  }
  return out;
}

// look: resolved preset time fields (TIME_PRESETS). opts: { pylon }. Returns { group, colliders, glows, inventory, lamps,
// hedges, statusLamps, pylon, dispose }. colliders: tag -> the object standing on that ring-layout collider.
export function buildRingMeshes(seed, look, opts) {
  look = look || TIME_PRESETS.day;
  seed = seed == null ? 1 : seed;
  opts = opts || {};
  const group = new Group(), colliders = new Map(), disposables = [], inventory = [], glows = [], lampHeads = [], statusLamps = new Map();
  const track = (o) => { disposables.push(o); return o; };
  const note = (name, img, windows) => inventory.push(Object.assign({ name, width: img.width, height: img.height }, windows ? { windows } : {}));
  const WHITE = new Color(1, 1, 1), TINT = new Color().setRGB(...look.tint);
  const lampsLit = look.glow > 0;
  const add = (obj, name, tag) => { obj.name = name; if (tag) { obj.userData.colliderTag = tag; colliders.set(tag, obj); } group.add(obj); return obj; };
  const tileMats = new Map();
  function tileMat(pattern, ramp) {
    const key = pattern + ':' + ramp;
    if (!tileMats.has(key)) {
      const img = makeTile(pattern, ramp, seed + key.length);
      note('tile:' + key, img);
      tileMats.set(key, track(new MeshBasicMaterial({ map: track(pixelTexture(img, RepeatWrapping)), color: TINT, alphaTest: pattern === 'fence' ? 0.5 : 0 })));
    }
    return tileMats.get(key);
  }
  const flat = (rgb) => track(new MeshBasicMaterial({ color: rgbColor(rgb).multiply(TINT) }));

  // ---- lots: built as alley 'west' lots (facade on local +x, u from the local +z end), turned by facadeRotY ----
  // The group's origin is the anticlockwise front corner (u = 0): local +x -> the inward normal, local -z -> clockwise.
  LOTS.forEach((L) => {
    const r = lotRect(L), g = new Group();
    const painted = !L.boarded && facadeCanSign(L.sign);
    const b = {
      id: L.id, side: 'west', x0: -LOT_D, x1: 0, z0: -LOT_W, z1: 0, h: L.h, seed: L.seed, family: L.family, wall: L.wall,
      awning: L.awning, door: L.door, sign: painted ? L.sign : null, entrance: !L.boarded
    };
    g.add(buildFacadeBuilding(b, seed, { look, track, note }));
    if (L.boarded) {
      // Boards over the ground floor (door included: the lot is closed).
      const boards = new Mesh(track(worldUvBox(0.0625, 2.375, LOT_W - 1)), tileMat('wood', 'wood'));
      boards.position.set(0.03125, 0.125 + 2.375 / 2, -LOT_W / 2);
      boards.name = 'boards:' + L.id;
      g.add(boards);
    }
    if (!painted) {
      // A lit board where facade-gen paints its signs (centred, 3.25..4.25 up): COMING SOON on the boarded lots, the cafe's
      // name. Untinted, so it reads lit at dusk / night like the alley's blade sign.
      const tw = signTextWidth(L.sign, 2), SW = Math.ceil((tw + 12) / 8) / 2, SH = 1, img = createImage(texels(SW), texels(SH));
      fillRect(img, 0, 0, img.width, img.height, [0x2c, 0x2a, 0x30]);
      strokeRect(img, 0, 0, img.width, img.height, OUTLINE);
      drawSignText(img, L.sign, Math.floor((img.width - tw) / 2), Math.floor((img.height - 10) / 2), 2, RAMPS.lamp[3]);
      note('sign:' + L.id, img);
      const face = track(new MeshBasicMaterial({ map: track(pixelTexture(img)), color: WHITE })), side = flat([0x2c, 0x2a, 0x30]);
      const sign = new Mesh(track(new BoxGeometry(0.125, SH, SW)), [face, side, side, side, side, side]);
      sign.position.set(0.0625 + (L.boarded ? 0.0625 : 0), 3.25 + SH / 2, -LOT_W / 2);
      sign.name = 'sign-lit:' + L.id;
      g.add(sign);
    }
    // Status lamp beside the door (just past its right edge, under the canopy): a dark housing with a lens whose colour
    // setLamps() sets (never tinted, so it reads lit at every time of day). Clear of the painted sign above the ground floor.
    const lampZ = -(L.door + 2 + 0.375), lampY = 2.1875, out = L.boarded ? 0.0625 : 0;
    const housing = new Mesh(track(new BoxGeometry(0.1875, 0.5, 0.375)), flat([0x2a, 0x2c, 0x32]));
    housing.position.set(out + 0.09375, lampY, lampZ);
    housing.name = 'status-housing:' + L.id;
    const lensMat = track(new MeshBasicMaterial({ color: rgbColor(LAMP_COLORS.off) }));
    const lens = new Mesh(track(new BoxGeometry(0.0625, 0.375, 0.25)), lensMat);
    lens.position.set(out + 0.21875, lampY, lampZ);
    lens.name = 'status-lamp:' + L.id;
    g.add(housing, lens);
    statusLamps.set(L.id, { mesh: lens, material: lensMat, state: 'off' });
    g.rotation.y = L.facadeRotY;
    g.position.set(r.corners[0][0], 0, r.corners[0][1]);
    g.userData.lot = L.id;
    add(g, 'building:' + L.id, r.tag);
  });

  // ---- street-gen props: built as west-pavement props (front = local +x), turned so the front faces `face` ----
  function streetProp(kind, size, at, face, sd) {
    const [w, d, h] = size, p = { id: kind, kind, x: 0, z: 0, w, d, h, side: 'west' }, g = new Group();
    planProp(p).forEach((part) => {
      let m;
      if (part.sprite) {
        const img = makeCanopy(texels(part.size[0]), texels(part.size[1]), sd);
        m = new Sprite(track(new SpriteMaterial({ map: track(pixelTexture(img)), alphaTest: 0.5, transparent: false, depthWrite: true, color: TINT })));
        m.scale.set(part.size[0], part.size[1], 1);
      } else {
        const lit = lampsLit && part.kind === 'lamp-head';
        const mats = faceRoles('west').map((role) => {
          const [fw, fh] = faceTexels(part.size, role);
          return track(new MeshBasicMaterial({ map: track(pixelTexture(paintPropFace(part.kind, role, fw, fh, sd, lit))), alphaTest: part.alpha ? 0.5 : 0, color: lit ? WHITE : TINT }));
        });
        m = new Mesh(track(new BoxGeometry(part.size[0], part.size[1], part.size[2])), mats);
        if (part.kind === 'lamp-head') lampHeads.push(m);
      }
      m.position.set(part.at[0], part.at[1] + part.size[1] / 2, part.at[2]);
      m.name = part.name;
      g.add(m);
    });
    g.rotation.y = Math.atan2(-face[1], face[0]);
    g.position.set(at[0], 0, at[1]);
    return g;
  }
  PROPS.forEach((p, i) => {
    let face;
    if (p.side === 'plaza') face = p.kind === 'bench' ? [-Math.sign(p.x), -Math.sign(p.z)] : [-p.x, -p.z];   // toward the pylon
    else { const n = ellipseNormal(p.theta); face = p.offset > 0 ? [-n.x, -n.z] : [n.x, n.z]; }              // toward the road
    const l = Math.hypot(face[0], face[1]);
    face = [face[0] / l, face[1] / l];
    // street-gen sizes are [across (local x), along (local z), h]; the layout's w runs along the tangent (a bench's length).
    const bench = p.side === 'plaza' && p.kind === 'bench';
    // Drawn on the 1/16 grid (the plaza benches' 0.6 contract collider is drawn 0.625 = 10 texels deep).
    const g16 = (v) => Math.round(v * PX_PER_UNIT) / PX_PER_UNIT;
    const across = g16(bench ? Math.min(p.w, p.d) : p.d), along = g16(bench ? Math.max(p.w, p.d) : p.w);
    add(streetProp(p.kind, [across, along, p.h], [p.x, p.z], face, seed + 700 + 13 * i), p.id, p.tag);
  });

  // ---- hedges: a low hedge in each gap between two neighbouring lots, on the verge just past the outer pavement edge ----
  // Chords of <= 2 units on offset 4.875 (0.5 thick: 4.625..5.125, outside the walk bound), skipped where they would touch
  // a lot. Decor: the walk bound already blocks there.
  const hedgeMat = tileMat('hedge', 'green'), HEDGE_O = OUTER_EDGE + 0.375, hedgeTab = arcTable(HEDGE_O), lotBoxes = LOTS.map(lotRect);
  let hedges = 0;
  LOTS.forEach((L, k) => {
    const a = lotBoxes[k].corners[1], b = lotBoxes[(k + 1) % LOTS.length].corners[0];
    const s0 = hedgeTab.lenAt(ellipseTheta(a[0], a[1]));
    let s1 = hedgeTab.lenAt(ellipseTheta(b[0], b[1]));
    if (s1 < s0) s1 += hedgeTab.length;
    const n = Math.max(1, Math.ceil((s1 - s0) / 2));
    for (let q = 0; q < n; q++) {
      const p0 = offsetPoint(hedgeTab.at(s0 + (s1 - s0) * q / n), HEDGE_O), p1 = offsetPoint(hedgeTab.at(s0 + (s1 - s0) * (q + 1) / n), HEDGE_O);
      const len = Math.hypot(p1.x - p0.x, p1.z - p0.z), cx = (p0.x + p1.x) / 2, cz = (p0.z + p1.z) / 2, ux = (p1.x - p0.x) / len, uz = (p1.z - p0.z) / len;
      const hit = lotBoxes.some((lb) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].some(([sa, sb]) =>
        obbDistance(lb, cx + sa * len / 2 * ux + sb * 0.25 * uz, cz + sa * len / 2 * uz - sb * 0.25 * ux) < 0.05));
      if (hit) continue;
      const m = new Mesh(track(worldUvBox(len, 0.6875, 0.5)), hedgeMat);
      m.position.set(cx, 0.6875 / 2, cz);
      m.rotation.y = Math.atan2(-uz, ux);
      m.name = 'hedge:' + L.id + ':' + q;
      group.add(m);
      hedges++;
    }
  });

  // ---- the pylon (lane C) or a placeholder ----
  let pylon = null;
  if (typeof opts.pylon === 'function') {
    const made = opts.pylon({ seed, look, at: PYLON });
    pylon = made && made.isObject3D ? made : made && made.mesh;
  }
  if (!pylon) {
    const panel = tileMat('panel', 'steel'), top = flat(RAMPS.steel[0]);
    pylon = new Mesh(track(worldUvBox(PYLON.w, PYLON.h, PYLON.d)), [panel, panel, top, top, panel, panel]);
    pylon.position.y = PYLON.h / 2;
    pylon.userData.placeholder = true;
  }
  const pylonGroup = new Group();
  pylonGroup.position.set(PYLON.x, 0, PYLON.z);
  pylonGroup.add(pylon);
  add(pylonGroup, pylon.userData.placeholder ? 'pylon:placeholder' : 'pylon', 'pylon');

  // Lamp glows (dusk / night), as the alley and the town: one additive, untinted, unfogged sprite per lamp head.
  if (lampsLit) {
    const glowGroup = new Group();
    glowGroup.name = 'lamp-glows';
    const img = makeGlow(texels(GLOW_SIZE));
    note('lamp-glow', img);
    const glowMat = track(new SpriteMaterial({ map: track(pixelTexture(img)), color: WHITE, opacity: look.glow, transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: true, fog: false }));
    group.updateMatrixWorld(true);
    const v = new Vector3();
    lampHeads.forEach((head, k) => {
      const s = new Sprite(glowMat);
      s.scale.set(GLOW_SIZE, GLOW_SIZE, 1);
      s.position.copy(head.getWorldPosition(v));
      s.name = 'glow:' + k;
      glowGroup.add(s);
      glows.push(s);
    });
    group.add(glowGroup);
  }
  return { group, colliders, glows, inventory, lamps: lampHeads.length, hedges, statusLamps, pylon, dispose() { disposables.forEach((d) => d.dispose && d.dispose()); } };
}

// buildRingScene(preset, seed, horizonNdcY, opts) -> { scene, ground, groundTexture, skyTexture, meshes, skyline, setLamps,
// lampStates, dispose }. opts.pylon: see the header.
// setLamps(rows | BoardView): rows [{ lot, working, waiting, idle, unknown }] (a BoardView's `rows`; a whole BoardView is
// accepted too, and its `offline` turns every lamp 'offline'). Lots without a row go 'off'. Only lamps whose state changed
// are touched; returns how many changed.
export function buildRingScene(preset, seed, horizonNdcY, opts) {
  seed = seed == null ? 1 : seed;
  const scene = new Scene();
  scene.fog = new Fog(rgbColor([(preset.haze >> 16) & 255, (preset.haze >> 8) & 255, preset.haze & 255]), preset.fogNear, preset.fogFar);
  const horizonV = ((horizonNdcY == null ? 99 : horizonNdcY) + 1) / 2;
  const sky = new DataTexture(makeSkyGradientRGBA(preset.sky, preset.haze, 48, horizonV, 6), 1, 48, RGBAFormat, UnsignedByteType);
  sky.magFilter = sky.minFilter = NearestFilter;
  sky.generateMipmaps = false;
  sky.wrapS = sky.wrapT = ClampToEdgeWrapping;
  sky.needsUpdate = true;
  scene.background = sky;

  const gt = preset.groundTint || [1, 1, 1], groundColor = new Color().setRGB(gt[0], gt[1], gt[2]);
  const tile = new DataTexture(makeLawnTileRGBA(seed), 16, 16, RGBAFormat, UnsignedByteType);
  tile.magFilter = tile.minFilter = NearestFilter;
  tile.generateMipmaps = false;
  tile.wrapS = tile.wrapT = RepeatWrapping;
  tile.repeat.set(400, 400);
  tile.needsUpdate = true;
  // As the town's base plane: pushed back in depth so the painted ground always wins at grazing angles.
  const baseGeo = new PlaneGeometry(400, 400), baseMat = new MeshBasicMaterial({ map: tile, color: groundColor, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 8 });
  const base = new Mesh(baseGeo, baseMat);
  base.rotation.x = -Math.PI / 2;
  base.position.y = GROUND_Y;
  base.name = 'ground:base';
  scene.add(base);
  const R = RING_GROUND_RECT, groundImg = makeRingGround(seed), groundTex = pixelTexture(groundImg);
  const groundGeo = new PlaneGeometry(R.x1 - R.x0, R.z1 - R.z0), groundMat = new MeshBasicMaterial({ map: groundTex, color: groundColor });
  const ground = new Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set((R.x0 + R.x1) / 2, 0, (R.z0 + R.z1) / 2);
  ground.name = 'ground:town';                    // the name pipeline.groundFraction()'s ID pass counts as ground
  scene.add(ground);

  const meshes = buildRingMeshes(seed, preset.tint ? preset : undefined, opts);
  meshes.inventory.push({ name: 'ground:ring', width: groundImg.width, height: groundImg.height });
  scene.add(meshes.group);
  const skyline = buildSkyline(preset, seed);
  scene.add(skyline.mesh);

  function setLamps(arg) {
    const rows = Array.isArray(arg) ? arg : (arg && arg.rows) || [], offline = !Array.isArray(arg) && !!(arg && arg.offline);
    const byLot = new Map(rows.filter((r) => r && r.lot).map((r) => [r.lot, r]));
    let changed = 0;
    meshes.statusLamps.forEach((l, id) => {
      const s = lampState(byLot.get(id), offline);
      if (s === l.state) return;
      l.state = s;
      l.material.color.copy(rgbColor(LAMP_COLORS[s]));
      changed++;
    });
    return changed;
  }
  function lampStates() { const o = {}; meshes.statusLamps.forEach((l, id) => { o[id] = l.state; }); return o; }
  return {
    scene, ground, groundTexture: groundTex, skyTexture: sky, meshes, skyline, setLamps, lampStates,
    dispose() { baseGeo.dispose(); baseMat.dispose(); tile.dispose(); groundGeo.dispose(); groundMat.dispose(); groundTex.dispose(); sky.dispose(); meshes.dispose(); skyline.dispose(); }
  };
}
