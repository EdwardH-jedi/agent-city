// M2.8 Phase F: the town scene (plaza + the six department facades) on the low-res WebGL renderer. A view of TownWorld:
// everything stands where renderer/town-layout.mjs (a mirror of TownWorld's town plan) puts it, and TownWorld keeps doing
// the collision, doors, agents and camera. Built from the same generators as the alley:
//  - department facades, kiosks and the Lantern Row end wall: renderer/facade-gen.mjs through alley-meshes'
//    buildFacadeBuilding (each built as an alley 'west' lot, then rotated so its facade faces the street);
//  - lamps, benches, trees, the mailbox and the bin: renderer/street-gen.mjs planProp parts;
//  - plain blocks repeat a facade family's floor tile; ground, fixtures and the fountain are painted here.
// Every textured face is 16 texels per world unit (tile textures repeat once per unit; exact-size images elsewhere).
// New in the town (prompt Phase F): a fountain box with a curved railing on its rim, trees in the plaza planters and parks.
import {
  Scene, Fog, Mesh, Group, PlaneGeometry, BoxGeometry, MeshBasicMaterial, Sprite, SpriteMaterial, DataTexture, RGBAFormat,
  UnsignedByteType, NearestFilter, RepeatWrapping, ClampToEdgeWrapping, Color, AdditiveBlending, Vector3
} from 'three';
import { makeSkyGradientRGBA, GROUND_Y } from './scene-alley.mjs';
import { TILE_PX, makeGroundTileRGBA } from './ground.mjs';
import { buildFacadeBuilding, pixelTexture, rgbColor, GLOW_SIZE } from './alley-meshes.mjs';
import { makeEndBand, hash01, texels } from './facade-gen.mjs';
import { planProp, faceRoles, faceTexels, paintPropFace, makeCanopy, makeGlow, STREET_PALETTE } from './street-gen.mjs';
import { buildSkyline } from './skyline.mjs';
import { PX_PER_UNIT, BAND_W, BAND_H, RAMPS, OUTLINE, createImage, setPx, fillRect, strokeRect, drawText, textWidth } from './textures.mjs';
import { DEPARTMENTS, FILLERS, FIXTURES, DOORS, groundKind, doorMatAt } from './town-layout.mjs';
import { TIME_PRESETS } from './presets.mjs';

// Painted ground: one image over the walkable town plus a margin (row 0 = north edge, column 0 = west edge).
export const GROUND_RECT = Object.freeze({ x0: -48, x1: 48, z0: -48, z1: 32 });
const { ASPHALT, PAVING, CURB, PAINT, SOIL, LEAF } = STREET_PALETTE;
const SAND = RAMPS.sand, STONE = RAMPS.plaster, TERRA = RAMPS.rust, GRASS = RAMPS.green, BRICK = RAMPS.brick;
const UNDER = [0x3a, 0x34, 0x30];
const pick4 = (ramp, h) => ramp[h < 0.25 ? 1 : h < 0.85 ? 2 : 3];
const m16 = (v, n) => ((v % n) + n) % n;

// One ground texel at world texel (gx, gz) (texel k covers [k/16, (k+1)/16)). Zones from town-layout groundKind.
export function groundTexel(gx, gz, seed) {
  const x = (gx + 0.5) / PX_PER_UNIT, z = (gz + 0.5) / PX_PER_UNIT, k = groundKind(x, z), h = hash01(seed, gx, gz);
  switch (k) {
    case 'plaza': {
      const rr = Math.hypot(x, z), ang = Math.atan2(z, x) + Math.PI;
      if (x < -13.2 || x >= 13.2 || z < -11.2 || z >= 11.2) {                              // stone border band
        const j = m16(gx, 16) === 0 || m16(gz, 8) === 0;
        return j ? STONE[0] : STONE[((gx >> 4) + (gz >> 3)) & 1 ? 2 : 3];
      }
      if ((rr > 3.1 && rr < 3.7) || (rr > 7.6 && rr < 8.1)) return TERRA[Math.floor(ang * 16 / Math.PI) & 1 ? 2 : 3];   // rings
      if (rr <= 7.6) {                                                                        // sunburst sectors
        const sec = Math.floor(ang / (Math.PI / 12));
        return Math.abs(rr - 5.4) < 0.06 ? SAND[1] : SAND[sec & 1 ? 2 : 3];
      }
      const tx2 = Math.floor(x / 2), tz2 = Math.floor(z / 2);                                 // 2 x 2 slabs
      if (m16(gx, 32) === 0 || m16(gz, 32) === 0) return SAND[1];
      return hash01(seed + 5, tx2, tz2) < 0.2 ? STONE[3] : SAND[(tx2 + tz2) & 1 ? 2 : 3];
    }
    case 'walk': {
      const joint = m16(gx, 10) === 9 || m16(gz, 10) === 9, slab = hash01(seed + 1, Math.floor(gx / 10), Math.floor(gz / 10));
      return joint || h < 0.07 ? PAVING[0] : PAVING[slab < 0.4 ? 1 : slab < 0.8 ? 2 : 3];
    }
    case 'curb': return (m16(gz, 5) === 0 || m16(gz, 5) === 4) ? CURB[1] : CURB[2];
    case 'road': case 'cross': {
      let c = h < 0.08 ? ASPHALT[0] : h < 0.55 ? ASPHALT[1] : h < 0.93 ? ASPHALT[2] : ASPHALT[3];
      const cz = z < 0 ? -14.6 : 14.6, edge = Math.min(Math.abs(z - (z < 0 ? -17.2 : 12)), Math.abs(z - (z < 0 ? -12 : 17.2)));
      if (edge < 2 / 16) c = h < 0.2 ? CURB[0] : CURB[1];                                     // gutter pans
      else if (k === 'road' && Math.abs(z - cz) < 1 / 16 + 1e-9 && (Math.floor(x) & 1) === 0) c = h < 0.15 ? PAINT[0] : PAINT[1];
      if (k === 'cross' && (Math.floor(x * 1.25) & 1) && edge >= 4 / 16) c = h < 0.06 ? PAINT[0] : PAINT[1];   // zebra bars
      return c;
    }
    case 'ave': {                                                                              // running-bond terracotta pavers
      if (Math.abs(z) < 0.25) return STONE[2];
      const row = Math.floor(gz / 4), off = (row & 1) ? 6 : 0, s = Math.floor((gx + off) / 12);
      if (m16(gz, 4) === 3 || m16(gx + off, 12) === 11) return TERRA[1];
      return hash01(seed + 6, s, row) < 0.35 ? TERRA[2] : TERRA[3];
    }
    case 'park': return h > 0.992 ? [RAMPS.rose[3], RAMPS.mustard[3], STONE[3]][m16(gx + gz, 3)] : GRASS[h < 0.2 ? 1 : h > 0.85 ? 3 : 2];
    case 'court': case 'qacourt': {
      const ramp = k === 'court' ? STONE : RAMPS.slate;
      if (m16(gx, 24) === 0 || m16(gz, 24) === 0) return ramp[1];
      return hash01(seed + 8, gx >> 2, gz >> 2) < 0.25 ? ramp[2] : ramp[3];
    }
    case 'hazard': return ((gx + gz) >> 3) & 1 ? [0x2c, 0x2a, 0x2a] : RAMPS.mustard[3];
    case 'mat': {
      const mat = doorMatAt(x, z), e = Math.min(x - mat.x0, mat.x1 - x, z - mat.z0, mat.z1 - z) * PX_PER_UNIT;
      return e < 2 ? RAMPS[mat.wall][2] : (gz & 1 ? [0x3a, 0x36, 0x3c] : [0x46, 0x42, 0x48]);
    }
    case 'alley': {                                                                            // basket-weave brick
      const bx = Math.floor(gx / 8), bz = Math.floor(gz / 8), horiz = (bx + bz) & 1, lu = m16(gx, 8), lv = m16(gz, 8);
      if ((horiz && (lv === 3 || lv === 7)) || (!horiz && (lu === 3 || lu === 7))) return BRICK[0];
      return hash01(seed + 13, bx * 2 + (horiz ? 0 : lu >> 2), bz * 2 + (horiz ? lv >> 2 : 0)) < 0.5 ? BRICK[2] : BRICK[3];
    }
    case 'gutter': return m16(gz, 6) < 1 ? STONE[0] : RAMPS.steel[2];
    default: return UNDER;
  }
}
export function makeTownGround(seed) {
  const R = GROUND_RECT, W = texels(R.x1 - R.x0), H = texels(R.z1 - R.z0), img = createImage(W, H);
  const gx0 = R.x0 * PX_PER_UNIT, gz0 = R.z0 * PX_PER_UNIT;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) setPx(img, c, r, groundTexel(gx0 + c, gz0 + r, seed));
  return img;
}

// ---- 16 x 16 tiles (one world unit) for walls and fixtures -------------------------------------------------------------
// pattern: block (ashlar), soil, hedge, wood (planks), crate, panel (steel panel), fence (alpha post + rails), solid.
export function makeTile(pattern, rampName, seed) {
  const img = createImage(16, 16), ramp = RAMPS[rampName] || STONE;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const h = hash01(seed, x, y);
    let c = null;
    switch (pattern) {
      case 'block': { const off = ((y >> 2) & 1) ? 4 : 0; c = (y & 3) === 3 || ((x + off) & 7) === 7 ? ramp[0] : pick4(ramp, h); break; }
      case 'soil': c = SOIL[h < 0.5 ? 0 : 1]; break;
      case 'hedge': c = h < 0.1 ? [0x18, 0x30, 0x20] : LEAF[h < 0.35 ? 1 : h < 0.85 ? 2 : 3]; break;
      case 'wood': c = (y & 3) === 3 ? ramp[0] : ramp[h < 0.3 ? 1 : 2]; break;
      case 'crate': c = (x === 0 || y === 0 || x === 15 || y === 15 || x === y || x === 15 - y) ? ramp[0] : ramp[(y & 3) === 3 ? 1 : 2]; break;
      case 'panel': c = (x === 0 || y === 0) ? ramp[0] : (x === 15 || y === 15) ? ramp[3] : ramp[h < 0.5 ? 1 : 2]; break;
      case 'fence': c = x < 2 ? (y < 1 ? ramp[3] : ramp[1]) : (y === 2 || y === 3 || y === 10) ? ramp[2] : null; break;
      default: c = ramp[2];
    }
    if (c) setPx(img, x, y, c);
  }
  return img;
}

// Box with world-unit UVs: u/v run 0..(face size in units), so one 16-texel tile covers exactly one unit on every face.
// keepFaces: face indices (+x, -x, +y, -y, +z, -z = 0..5) whose 0..1 UVs stay (an exact-size image on that face).
export function worldUvBox(sx, sy, sz, keepFaces) {
  const geo = new BoxGeometry(sx, sy, sz), uv = geo.attributes.uv;
  const dims = [[sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy]];
  for (let i = 0; i < uv.count; i++) {
    const f = Math.floor(i / 4);
    if (keepFaces && keepFaces.includes(f)) continue;
    uv.setXY(i, uv.getX(i) * dims[f][0], uv.getY(i) * dims[f][1]);
  }
  return geo;
}

// look: resolved preset time fields (TIME_PRESETS). Returns { group, glows, colliders, inventory, lamps, dispose }.
// colliders: tag -> the object standing on that TownWorld collider (town-layout colliderRects tags, except fixtures use
// 'fixture:<id>').
export function buildTownMeshes(seed, look) {
  look = look || TIME_PRESETS.day;
  seed = seed == null ? 1 : seed;
  const group = new Group(), colliders = new Map(), disposables = [], inventory = [], glows = [], lampHeads = [];
  const track = (o) => { disposables.push(o); return o; };
  const note = (name, img, windows) => inventory.push(Object.assign({ name, width: img.width, height: img.height }, windows ? { windows } : {}));
  const WHITE = new Color(1, 1, 1), TINT = new Color().setRGB(...look.tint);
  const lampsLit = look.glow > 0;
  const add = (obj, name, tag) => { obj.name = name; if (tag) { obj.userData.colliderTag = tag; colliders.set(tag, obj); } group.add(obj); return obj; };

  // Tile materials, cached per (pattern, ramp). Tinted like the alley's trim and props.
  const tileMats = new Map();
  function tileMat(pattern, ramp) {
    const key = pattern + ':' + ramp;
    if (tileMats.has(key)) return tileMats.get(key);
    const img = makeTile(pattern, ramp, seed + key.length);
    note('tile:' + key, img);
    const m = track(new MeshBasicMaterial({ map: track(pixelTexture(img, RepeatWrapping)), color: TINT, alphaTest: pattern === 'fence' ? 0.5 : 0 }));
    tileMats.set(key, m);
    return m;
  }
  const flat = (rgb) => track(new MeshBasicMaterial({ color: rgbColor(rgb).multiply(TINT) }));
  // b = [x0, x1, y0, y1, z0, z1]; side / top = [pattern, ramp] or a material.
  function tileBox(b, side, top, opts) {
    const [x0, x1, y0, y1, z0, z1] = b, sm = side.isMaterial ? side : tileMat(side[0], side[1]);
    const tm = top ? (top.isMaterial ? top : tileMat(top[0], top[1])) : sm;
    const m = new Mesh(track(worldUvBox(x1 - x0, y1 - y0, z1 - z0, opts && opts.exactTop ? [2] : null)), [sm, sm, tm, sm, sm, sm]);
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    return m;
  }

  // ---- buildings: built as alley 'west' lots (facade on +x, u from the +z end), then rotated to face the street ----------
  // south front: local (x, z) -> world (x0 - z, z1 + x); north front: world (x1 + z, z0 - x). Either way u = 0 is the
  // viewer's left, the facade plane is the front edge of the TownWorld footprint and the door is centred on the contract door.
  function facadeLot(id, fp, front, spec) {
    const L = fp.x1 - fp.x0, D = fp.z1 - fp.z0;
    const doorU = front === 'south' ? spec.doorX - 1 - fp.x0 : fp.x1 - spec.doorX - 1;
    const b = Object.assign({ id, side: 'west', x0: -D, x1: 0, z0: -L, z1: 0, door: doorU }, spec);
    const g = new Group();
    g.add(buildFacadeBuilding(b, seed, { look, track, note }));
    g.rotation.y = front === 'south' ? -Math.PI / 2 : Math.PI / 2;
    if (front === 'south') g.position.set(fp.x0, 0, fp.z1); else g.position.set(fp.x1, 0, fp.z0);
    g.userData.doorX = spec.doorX;
    return g;
  }
  DEPARTMENTS.forEach((d) => {
    const g = facadeLot(d.dept, d, d.front, { h: d.vh, seed: d.seed, family: d.family, wall: d.wall, awning: d.awning, sign: d.title, entrance: d.entrance, doorX: DOORS[d.dept].x });
    add(g, 'building:' + d.dept, 'building:' + d.dept).userData.department = d.dept;
  });
  FILLERS.forEach((f, i) => {
    if (f.face) {
      const g = facadeLot(f.id, f, f.face, { h: f.vh, seed: 40 + i, family: f.family, wall: f.wall, awning: f.awning, sign: f.sign, entrance: false, doorX: f.door });
      add(g, 'filler:' + f.id, 'filler:' + f.id).userData.alleyEnd = !!f.alleyEnd;
      return;
    }
    // Plain block: the family's 32 x 48 floor tile repeated on all four walls (one tile per 2 x 3 units), flat roof.
    const band = makeEndBand({ family: f.family, wall: f.wall, awning: 'teal', width: 2, height: 3, seed: seed + 50 + i });
    note('filler-band:' + f.id, band);
    const tex = track(pixelTexture(band, RepeatWrapping));
    tex.repeat.set(PX_PER_UNIT / BAND_W, PX_PER_UNIT / BAND_H);
    const wallMat = track(new MeshBasicMaterial({ map: tex, color: TINT })), roofMat = flat(RAMPS[f.wall][0]);
    const m = new Mesh(track(worldUvBox(f.x1 - f.x0, f.h, f.z1 - f.z0)), [wallMat, wallMat, roofMat, roofMat, wallMat, wallMat]);
    m.position.set((f.x0 + f.x1) / 2, f.h / 2, (f.z0 + f.z1) / 2);
    add(m, 'filler:' + f.id, 'filler:' + f.id);
  });

  // ---- street-gen props (lamp, bench, tree, mailbox, bin): built as west-pavement props (front = +x), then turned ----------
  const TURN = { east: 0, south: -Math.PI / 2, north: Math.PI / 2, west: Math.PI };
  function streetProp(kind, size, at, faces, sd, y) {
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
    g.rotation.y = TURN[faces || 'east'];
    g.position.set(at[0], y || 0, at[1]);
    g.userData.footprint = [w, d];
    return g;
  }

  // Fountain box (TownWorld's 4.8 x 4.8 basin collider; drawn 4.75 = 76 texels) with a pool top, a column, a bowl, a spray
  // sprite, and the curved railing: 28 posts on a circle of radius 2.125 on the basin rim (inside the collider), joined by
  // two rails of chords.
  function buildFountain(q) {
    const g = new Group(), H = 0.75, S = 4.75, N = texels(S), pool = createImage(N, N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const rim = i < 3 || j < 3 || i >= N - 3 || j >= N - 3, w = Math.sin((i + j * 1.7) * 0.55) + Math.sin((i * 0.7 - j) * 0.42);
      setPx(pool, i, j, rim ? STONE[(i + j) % 5 === 0 ? 2 : 3] : RAMPS.glass[w > 1.3 ? 3 : w > 0.4 ? 2 : w < -1.2 ? 0 : 1]);
    }
    note('fountain-pool', pool);
    const poolMat = track(new MeshBasicMaterial({ map: track(pixelTexture(pool)), color: TINT }));
    g.add(tileBox([-S / 2, S / 2, 0, H, -S / 2, S / 2], ['block', 'plaster'], poolMat, { exactTop: true }));
    g.add(tileBox([-0.4375, 0.4375, H, 1.875, -0.4375, 0.4375], ['block', 'sand']));
    g.add(tileBox([-1.125, 1.125, 1.875, 2.125, -1.125, 1.125], ['block', 'sand'], tileMat('solid', 'glass')));
    const spray = createImage(24, 32);
    for (let j = 0; j < 32; j++) for (let i = 0; i < 24; i++) {
      const dx = (i + 0.5 - 12) / 12, t = j / 31, reach = 0.18 + 0.75 * Math.max(0, 1 - Math.abs(t - 0.35) / 0.65);
      if (Math.abs(dx) < reach && hash01(seed + 77, i, j) < 0.45 + 0.45 * (1 - Math.abs(dx))) setPx(spray, i, j, hash01(seed + 78, i, j) < 0.4 ? [0xff, 0xff, 0xff] : RAMPS.glass[3]);
    }
    note('fountain-spray', spray);
    const sp = new Sprite(track(new SpriteMaterial({ map: track(pixelTexture(spray)), alphaTest: 0.5, transparent: false, depthWrite: true, color: TINT })));
    sp.scale.set(1.5, 2, 1);
    sp.position.set(0, 3.125, 0);
    sp.name = 'fountain-spray';
    g.add(sp);
    const rail = new Group(), R = 2.125, P = 28, railMat = flat(RAMPS.steel[0]), postMat = flat(RAMPS.steel[2]);
    rail.name = 'fountain-railing';
    const postGeo = track(new BoxGeometry(0.0625, 0.5625, 0.0625)), chord = 2 * R * Math.sin(Math.PI / P);
    const segGeo = track(new BoxGeometry(chord, 0.0625, 0.0625)), rMid = R * Math.cos(Math.PI / P);
    for (let k = 0; k < P; k++) {
      const a = (k / P) * Math.PI * 2, post = new Mesh(postGeo, postMat);
      post.position.set(Math.cos(a) * R, H + 0.28125, Math.sin(a) * R);
      rail.add(post);
      const a2 = ((k + 0.5) / P) * Math.PI * 2;
      for (const y of [H + 0.25, H + 0.5]) {
        const seg = new Mesh(segGeo, railMat);
        seg.position.set(Math.cos(a2) * rMid, y, Math.sin(a2) * rMid);
        seg.rotation.y = Math.PI / 2 - a2;
        rail.add(seg);
      }
    }
    g.add(rail);
    g.position.set((q.x0 + q.x1) / 2, 0, (q.z0 + q.z1) / 2);
    return g;
  }
  // Fenced pocket park: railings on all four edges (TownWorld's fence line), hedges along the long sides, four trees.
  function buildPark(q, sd) {
    const g = new Group(), t = 0.125;
    for (const b of [[q.x0, q.x1, q.z0, q.z0 + t], [q.x0, q.x1, q.z1 - t, q.z1], [q.x0, q.x0 + t, q.z0, q.z1], [q.x1 - t, q.x1, q.z0, q.z1]]) {
      const m = tileBox([b[0], b[1], 0, 0.8125, b[2], b[3]], ['fence', 'steel']);
      m.name = 'railing';
      g.add(m);
    }
    g.add(tileBox([q.x0 + 0.4, q.x1 - 0.4, 0, 0.6875, q.z0 + 0.4, q.z0 + 1.0], ['hedge', 'green']));
    g.add(tileBox([q.x0 + 0.4, q.x1 - 0.4, 0, 0.6875, q.z1 - 1.0, q.z1 - 0.4], ['hedge', 'green']));
    const midZ = (q.z0 + q.z1) / 2;
    for (let k = 0; k < 4; k++) g.add(streetProp('tree', [0.75, 0.75, 4.375], [q.x0 + 4 + k * 8, midZ + ((k & 1) ? 0.8 : -0.8)], 'east', sd + k));
    return g;
  }
  // Street-name board over the mouth of Lantern Row: two lines of lit 2x text on a dark board, kept inside the 5-unit gap
  // between Planning and Engineering (TownWorld's 5.6-unit board pokes into both walls, which would hide its first and last
  // letters). The text stays untinted, like the alley's blade sign.
  function buildSign(f) {
    const x0 = -15.9375, x1 = -11.0625, y0 = f.box[2], y1 = y0 + 1.625, z0 = f.box[4], z1 = f.box[5];
    const W = texels(x1 - x0), Hh = texels(y1 - y0), img = createImage(W, Hh);
    fillRect(img, 0, 0, W, Hh, [0x2c, 0x2a, 0x30]);
    strokeRect(img, 0, 0, W, Hh, OUTLINE);
    f.text.split(' ').forEach((line, k) => drawText(img, line, Math.floor((W - textWidth(line, 2)) / 2), 2 + k * 12, 2, RAMPS.lamp[3]));
    note('sign:' + f.id, img);
    const face = track(new MeshBasicMaterial({ map: track(pixelTexture(img)), color: WHITE })), side = flat([0x2c, 0x2a, 0x30]);
    const m = new Mesh(track(new BoxGeometry(x1 - x0, y1 - y0, z1 - z0)), [side, side, side, side, face, side]);
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    return m;
  }

  // ---- fixtures ---------------------------------------------------------------------------------------------------------
  const cx = (q) => (q.x0 + q.x1) / 2, cz = (q) => (q.z0 + q.z1) / 2;
  const boxOf = (q, y0, y1) => [q.x0, q.x1, y0, y1, q.z0, q.z1];
  FIXTURES.forEach((f, i) => {
    const q = f.rect, sd = seed + 600 + 13 * i, tag = q ? 'fixture:' + f.id : null;
    let obj;
    switch (f.kind) {
      case 'door-planter': case 'bed': {
        const inset = f.kind === 'bed' ? 0.25 : 0.0625;
        obj = new Group();
        obj.add(tileBox(boxOf(q, 0, f.h), ['block', 'plaster'], ['soil', 'plaster']));
        obj.add(tileBox([q.x0 + inset, q.x1 - inset, f.h, f.h + 0.5, q.z0 + inset, q.z1 - inset], ['hedge', 'green']));
        break;
      }
      case 'board': obj = tileBox(boxOf(q, 0, 0.875), ['wood', 'wood']); break;   // A-board on TownWorld's 0.6 x 0.6 collider
      case 'step': obj = tileBox(f.box, ['block', 'plaster'], ['block', 'sand']); break;
      case 'column': obj = tileBox(boxOf(q, 0, f.h), ['block', 'sand']); break;
      case 'entablature': obj = tileBox(f.box, ['block', 'sand']); break;
      case 'bollard': obj = tileBox(boxOf(q, 0, f.h), flat(RAMPS.mustard[3]), flat([0x2c, 0x2a, 0x2a])); break;
      case 'canopy': case 'bridge': obj = tileBox(f.box, ['panel', 'steel']); break;
      case 'cabinet': obj = tileBox(boxOf(q, 0, f.h), ['panel', 'steel']); break;
      case 'utility': obj = tileBox(boxOf(q, 0, f.h), ['panel', 'olive']); break;
      case 'crate': obj = tileBox(q ? boxOf(q, 0, f.h) : f.box, ['crate', 'wood']); break;
      case 'fountain': obj = buildFountain(q); break;
      case 'tree-planter':
        obj = new Group();
        obj.add(tileBox(boxOf(q, 0, f.h), ['block', 'sand'], ['soil', 'sand']));
        obj.add(streetProp('tree', [0.75, 0.75, 4.375], [cx(q), cz(q)], 'east', sd, f.h));
        break;
      case 'bench': obj = streetProp('bench', [0.6875, 2.625, 1.0625], [cx(q), cz(q)], f.faces, sd); break;
      case 'lamp': obj = streetProp('lamp', [0.375, 0.375, 4.25], [cx(q), cz(q)], f.faces, sd); break;
      case 'mailbox': obj = streetProp('mailbox', [0.5, 0.5, 1.125], [cx(q), cz(q)], f.faces, sd); break;
      case 'bin': obj = streetProp('bin', [0.75, 0.75, 1], [cx(q), cz(q)], f.faces, sd); break;
      case 'park': obj = buildPark(q, sd); break;
      case 'sign': obj = buildSign(f); break;
      default: throw new Error('unknown town fixture kind: ' + f.kind);
    }
    obj.userData.kind = f.kind;
    add(obj, f.id, tag);
  });

  // Lamp glows (dusk / night), as in the alley: one additive, untinted, unfogged sprite per lamp head, in their own group.
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
  return { group, colliders, glows, inventory, lamps: lampHeads.length, dispose() { disposables.forEach((d) => d.dispose && d.dispose()); } };
}

export function buildTownScene(preset, seed, horizonNdcY) {
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
  // Base ground beyond the painted rect (under the outer blocks, out toward the horizon): the M2.7 paver tile, 1/128 lower.
  const tile = new DataTexture(makeGroundTileRGBA(seed), TILE_PX, TILE_PX, RGBAFormat, UnsignedByteType);
  tile.magFilter = tile.minFilter = NearestFilter;
  tile.generateMipmaps = false;
  tile.wrapS = tile.wrapT = RepeatWrapping;
  tile.repeat.set(400, 400);
  tile.needsUpdate = true;
  // M2.9 T1: pushed back in depth (polygonOffset) so the painted ground always wins at the lower three-quarter camera's
  // grazing angles (pitch 8 at 30+ units z-fought the 1/128 gap).
  const baseGeo = new PlaneGeometry(400, 400), baseMat = new MeshBasicMaterial({ map: tile, color: groundColor, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 8 });
  const base = new Mesh(baseGeo, baseMat);
  base.rotation.x = -Math.PI / 2;
  base.position.y = GROUND_Y;
  base.name = 'ground:base';
  scene.add(base);
  // Painted town ground, 16 texels per unit (image row 0 = the north edge, lands on -z after the rotation).
  const R = GROUND_RECT, groundImg = makeTownGround(seed), groundTex = pixelTexture(groundImg);
  const groundGeo = new PlaneGeometry(R.x1 - R.x0, R.z1 - R.z0), groundMat = new MeshBasicMaterial({ map: groundTex, color: groundColor });
  const ground = new Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set((R.x0 + R.x1) / 2, 0, (R.z0 + R.z1) / 2);
  ground.name = 'ground:town';
  scene.add(ground);

  const meshes = buildTownMeshes(seed, preset.tint ? preset : undefined);
  meshes.inventory.push({ name: 'ground:town', width: groundImg.width, height: groundImg.height });
  scene.add(meshes.group);
  const skyline = buildSkyline(preset, seed);
  scene.add(skyline.mesh);
  return {
    scene, ground, groundTexture: groundTex, skyTexture: sky, meshes, skyline,
    dispose() { baseGeo.dispose(); baseMat.dispose(); tile.dispose(); groundGeo.dispose(); groundMat.dispose(); groundTex.dispose(); sky.dispose(); meshes.dispose(); skyline.dispose(); }
  };
}
