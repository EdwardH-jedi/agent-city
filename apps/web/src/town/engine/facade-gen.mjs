// Facade generator (M2.8 Phase B, prompt section 2 "Buildings"). Pure functions, no three.js: a building spec + seed ->
// the pixel images of its street facade, its side-face floor tile, and every face of its 3D trim (cornice, parapet,
// rooftop boxes, entrance stoop/canopy, fire escape, balcony, blade sign). Images are top-down RGBA (row 0 = top),
// 16 texels per world unit, binary alpha, deterministic per seed (mulberry32 + an integer position hash); no external art.
//
// Four facade families share one grammar: a 3-unit ground-floor band (door, shopfront / lobby / windows, awning or sign)
// + repeating 3-unit floor bands (a window row, a string course along the bottom rows) + an optional 1.5-unit attic row
// + a cornice and a parapet. Side faces repeat the family's 32 x 48 floor tile (one window bay, one floor).
//  - brick:     running-bond brick, cream sash windows with stone lintels and sills, stone string course.
//  - stone:     rendered ashlar, windows in raised surrounds under pediments, heavy string course, quoins, rusticated base.
//  - glass:     glass-and-steel curtain wall, steel mullions, a spandrel band per floor, glazed lobby, thin steel trim.
//  - shopfront: painted render, shuttered windows with flower boxes, display windows under a striped awning.
// Window content stays in the top half of each floor tile, so the half tile at the top of a 1.5-attic side face shows
// plain wall + string course, never half a window (as in M2.7.1).
import {
  PX_PER_UNIT, BAND_W, BAND_H, FLOOR_PX, RAMPS, OUTLINE, mulberry32, createImage, setPx, fillRect, strokeRect, drawText,
  textWidth
} from './textures.mjs';

export const FAMILIES = Object.freeze(['brick', 'stone', 'glass', 'shopfront']);
const STONE = RAMPS.plaster;                       // dressings on brick: lintels, sills, string course, coping
const STEEL = RAMPS.steel, GLASS = RAMPS.glass, WOOD = RAMPS.wood, LAMP = RAMPS.lamp, TRIM = RAMPS.trim;
const CREAM = [0xe8, 0xe2, 0xd2];                  // painted window frames
const BLIND = [0xb8, 0xb0, 0xa0];
const CLOTH = [[0xc4, 0x6e, 0x5a], [0x8e, 0xa4, 0x72], [0xe0, 0xc8, 0x8c], [0x7c, 0x8c, 0xb4]];
const WARES = [RAMPS.rust[3], RAMPS.mustard[3], RAMPS.teal[3], RAMPS.rose[3], RAMPS.green[3]];

// Per-family 3D trim (world units; multiples of 1/16 so every face is a whole number of texels) and rooftop box kinds.
export const FAMILY_TRIM = Object.freeze({
  brick: Object.freeze({ corniceOut: 0.375, corniceH: 0.5, parapetH: 0.75, roof: Object.freeze(['tank', 'ac']) }),
  stone: Object.freeze({ corniceOut: 0.5, corniceH: 0.625, parapetH: 0.5, roof: Object.freeze(['hut', 'ac']) }),
  glass: Object.freeze({ corniceOut: 0.25, corniceH: 0.25, parapetH: 0.5, roof: Object.freeze(['ac', 'ac']) }),
  shopfront: Object.freeze({ corniceOut: 0.375, corniceH: 0.5, parapetH: 0.625, roof: Object.freeze(['tank', 'hut']) })
});
// Rooftop boxes, [out (across the roof), h, along]. A tank stands on an open steel frame.
export const ROOF_BOXES = Object.freeze({
  tank: Object.freeze([1.5, 1.5, 1.5]), stand: Object.freeze([1.25, 1, 1.25]),
  ac: Object.freeze([1, 0.75, 1.25]), hut: Object.freeze([1.5, 1.5, 1.75])
});

export function texels(units) {
  const t = units * PX_PER_UNIT;
  if (!Number.isInteger(t) || t <= 0) throw new Error('size ' + units + ' is not a positive multiple of 1/' + PX_PER_UNIT);
  return t;
}

// Position hash -> [0, 1). Patterns depend on (x, y) only, so a tile and the facade painted from the same rules agree.
export function hash01(seed, a, b) {
  let h = Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((a | 0) + 0x632be5ab, 0xc2b2ae35) ^ Math.imul((b | 0) + 0x27d4eb2f, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

// spec: { family, wall, awning, width, height (world units), seed, doorU, sign, entrance, drainpipe, fireEscape, balcony,
// blade, lit }. lit = fraction of windows drawn lit (0 by day; the dusk/night presets can raise it).
function context(o) {
  const ramp = RAMPS[o.wall];
  if (!ramp || ramp.length < 4) throw new Error('unknown wall ramp: ' + o.wall);
  if (!FAMILY[o.family]) throw new Error('unknown facade family: ' + o.family);
  return { family: o.family, ramp, acc: RAMPS[o.awning] || RAMPS.teal, seed: o.seed | 0, lit: o.lit || 0, litFirst: o.litFirst | 0, windows: { total: 0, lit: 0 } };   // agent-city: litFirst
}
// Lit-window colours (Phase D): warm room light (the lamp ramp), curtains glowing in front of it, cool office panes.
const LIT_CURTAIN = [0xd8, 0x98, 0x4c], LIT_COOL = [[0xc4, 0xe0, 0xec], [0xe8, 0xf6, 0xfc]];

function bays(w) {                                  // left edges of the 32-texel window bays, centred on the facade
  const n = Math.floor(w / BAND_W), off = (w - n * BAND_W) >> 1, out = [];
  for (let i = 0; i < n; i++) out.push(off + i * BAND_W);
  return out;
}
const nearDoor = (cx, dx) => cx + 6 < dx + 36 && cx + 26 > dx - 4;
function course(img, y, w, colours) { colours.forEach((c, i) => fillRect(img, 0, y + i, w, 1, c)); }

function windowState(ctx, x, y) {
  const lit = ctx.windows.total < ctx.litFirst || hash01(ctx.seed, x, y) < ctx.lit;   // agent-city: the first litFirst windows lit
  ctx.windows.total++; if (lit) ctx.windows.lit++;
  if (lit) return 'lit';
  return hash01(ctx.seed + 1, x, y) < 0.3 ? 'curtain' : 'glass';
}
// Window with a 1 px dark outline. frame: inner frame colour or null; bar: 'sash' (horizontal) | 'mullion' (vertical) | null.
function paintWindow(img, x, y, w, h, ctx, frame, bar) {
  const state = windowState(ctx, x, y);
  strokeRect(img, x, y, w, h, OUTLINE);
  let ix = x + 1, iy = y + 1, iw = w - 2, ih = h - 2;
  if (frame) { strokeRect(img, ix, iy, iw, ih, frame); ix++; iy++; iw -= 2; ih -= 2; }
  if (state === 'lit') {
    fillRect(img, ix, iy, iw, ih, LAMP[2]); fillRect(img, ix, iy, iw, 1, LAMP[3]);
    if (hash01(ctx.seed + 1, x, y) < 0.3) { fillRect(img, ix, iy, 2, ih, LIT_CURTAIN); fillRect(img, ix + iw - 2, iy, 2, ih, LIT_CURTAIN); }
  } else {
    fillRect(img, ix, iy, iw, ih, GLASS[hash01(ctx.seed + 2, x, y) < 0.5 ? 1 : 2]);
    fillRect(img, ix, iy, iw, 2, GLASS[3]);
    for (let k = 0; k < 3; k++) setPx(img, ix + iw - 2 - k, iy + 3 + k, GLASS[3]);             // glint
    if (state === 'curtain') {
      const c = CLOTH[(hash01(ctx.seed + 3, x, y) * CLOTH.length) | 0];
      fillRect(img, ix, iy, 2, ih, c); fillRect(img, ix + iw - 2, iy, 2, ih, c); fillRect(img, ix, iy, iw, 2, c);
    }
  }
  const bc = frame || OUTLINE;
  if (bar === 'sash') fillRect(img, x + 1, y + (h >> 1), w - 2, 1, bc);
  else if (bar === 'mullion') fillRect(img, x + (w >> 1), y + 1, 1, h - 2, bc);
}

function woodDoor(img, dx, y, h) {                  // 32-wide double door, outlined, raised panels
  strokeRect(img, dx, y, 32, h, OUTLINE);
  fillRect(img, dx + 1, y + 1, 30, h - 1, WOOD[1]);
  fillRect(img, dx + 15, y + 1, 2, h - 1, WOOD[0]);
  for (const px of [dx + 4, dx + 19]) {
    strokeRect(img, px, y + 4, 9, 13, WOOD[0]); fillRect(img, px + 1, y + 5, 7, 11, WOOD[2]);
    strokeRect(img, px, y + 20, 9, h - 24, WOOD[0]); fillRect(img, px + 1, y + 21, 7, h - 26, WOOD[2]);
  }
  fillRect(img, dx + 13, y + 18, 1, 3, RAMPS.mustard[3]); fillRect(img, dx + 18, y + 18, 1, 3, RAMPS.mustard[3]);
}
function glassDoor(img, dx, y, h) {
  strokeRect(img, dx, y, 32, h, OUTLINE);
  fillRect(img, dx + 1, y + 1, 30, h - 1, STEEL[0]);
  for (const px of [dx + 3, dx + 17]) {
    fillRect(img, px, y + 3, 12, h - 6, GLASS[2]); fillRect(img, px, y + 3, 12, 2, GLASS[3]);
    fillRect(img, px + 1, y + 18, 10, 2, STEEL[3]);                                           // push bar
  }
}
function plinth(img, w, H) { fillRect(img, 0, H - 5, w, 5, TRIM[1]); fillRect(img, 0, H - 5, w, 1, TRIM[3]); }

// Curtain-wall row: glazing rows y0..y0+glaze-1 in 16-texel panes, then a spandrel band down to y0+total-1.
function glassRow(img, x0, y0, w, glaze, total, ctx) {
  for (let px = x0; px < x0 + w; px += 16) {
    const lit = ctx.windows.total < ctx.litFirst || hash01(ctx.seed, px, y0) < ctx.lit;   // agent-city: the first litFirst panes lit
    ctx.windows.total++; if (lit) ctx.windows.lit++;
    const cool = lit && hash01(ctx.seed + 5, px, y0) < 0.4 ? LIT_COOL : null;
    fillRect(img, px, y0, 16, glaze, lit ? (cool ? cool[0] : LAMP[2]) : GLASS[1]);
    if (lit) fillRect(img, px, y0 + 1, 16, 2, cool ? cool[1] : LAMP[3]);
    if (!lit) {
      fillRect(img, px, y0 + 1, 16, 2, GLASS[2]);
      if (hash01(ctx.seed + 1, px, y0) < 0.3) {                                                 // venetian blind
        const bh = Math.floor(glaze / 3);
        fillRect(img, px, y0 + 1, 16, bh, CREAM);
        for (let j = y0 + 3; j < y0 + 1 + bh; j += 3) fillRect(img, px, j, 16, 1, BLIND);
      }
      if (hash01(ctx.seed + 4, px, y0) < 0.5) {                                                 // reflection streak
        for (let t = 0; t < glaze - 5; t++) {
          const x = px + 3 + t, y = y0 + glaze - 3 - t;
          if (x > px + 13) break;
          setPx(img, x, y, GLASS[3]); setPx(img, x + 1, y, GLASS[3]);
        }
      }
    }
    fillRect(img, px, y0, 1, glaze, STEEL[0]); fillRect(img, px + 1, y0, 1, glaze, STEEL[2]);  // mullion
  }
  if (glaze >= 30) fillRect(img, x0, y0 + 12, w, 1, STEEL[1]);                                 // transom
  fillRect(img, x0, y0, w, 1, OUTLINE); fillRect(img, x0, y0 + glaze - 1, w, 1, OUTLINE);
  if (total > glaze) {
    const r = ctx.ramp;
    fillRect(img, x0, y0 + glaze, w, total - glaze, r[1]);
    fillRect(img, x0, y0 + glaze, w, 1, r[3]); fillRect(img, x0, y0 + total - 1, w, 1, r[0]);
    for (let px = x0; px < x0 + w; px += 16) fillRect(img, px, y0 + glaze + 1, 1, total - glaze - 2, r[0]);
  }
}

function shopWindow(img, x, y, w, h, ctx) {         // display window with wares on the bottom shelf
  strokeRect(img, x, y, w, h, OUTLINE);
  fillRect(img, x + 1, y + 1, w - 2, h - 2, GLASS[1]);
  fillRect(img, x + 1, y + 1, w - 2, 2, GLASS[3]);
  for (let k = 0; k < 4; k++) setPx(img, x + w - 4 - k, y + 4 + k, GLASS[3]);
  for (let i = x + 2; i + 3 < x + w - 1; i += 4) {
    const t = hash01(ctx.seed + 6, i, y), bh = 3 + ((t * 4) | 0);
    fillRect(img, i, y + h - 1 - bh, 3, bh, WARES[(t * 97 | 0) % WARES.length]);
  }
}

// Family painters. wall(img, x, y, w, h): background; floor(img, y0, w): one 48-row floor from row y0 (window bays +
// string course); attic(img, rows, w): the top `rows` rows; ground(img, y0, w, H, dx): ground floor from row y0 with the
// door at texel dx; finish(img, w, gfTop): facade-only extras that must not repeat on the side tile.
const FAMILY = {
  brick: {
    wall(img, x, y, w, h, ctx) {
      const r = ctx.ramp;
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
        const row = j >> 2, sx = i + (row & 1) * 4;
        let c = r[2];                                                                          // mortar
        if ((j & 3) !== 3 && (sx & 7) !== 7) { const t = hash01(ctx.seed, sx >> 3, row); c = t < 0.14 ? r[0] : t > 0.95 ? r[3] : r[1]; }
        setPx(img, i, j, c);
      }
    },
    floor(img, y0, w, ctx) {
      for (const cx of bays(w)) {
        fillRect(img, cx + 9, y0 + 3, 14, 2, STONE[2]); fillRect(img, cx + 9, y0 + 3, 14, 1, STONE[3]);   // lintel
        paintWindow(img, cx + 10, y0 + 5, 12, 16, ctx, CREAM, 'sash');
        fillRect(img, cx + 9, y0 + 21, 14, 2, STONE[3]); fillRect(img, cx + 9, y0 + 23, 14, 1, ctx.ramp[0]); // sill
      }
      course(img, y0 + 44, w, [STONE[3], STONE[2], STONE[2], ctx.ramp[0]]);
    },
    attic(img, rows, w, ctx) {
      for (const cx of bays(w)) {
        fillRect(img, cx + 10, 9, 12, 1, STONE[3]);
        paintWindow(img, cx + 11, 10, 10, 9, ctx, null, null);
        fillRect(img, cx + 10, 19, 12, 1, STONE[3]);
      }
      course(img, rows - 4, w, [STONE[3], STONE[2], STONE[2], ctx.ramp[0]]);
    },
    ground(img, y0, w, H, ctx, dx) {
      for (const cx of bays(w)) {
        if (nearDoor(cx, dx)) continue;
        fillRect(img, cx + 9, y0 + 9, 14, 2, STONE[2]); fillRect(img, cx + 9, y0 + 9, 14, 1, STONE[3]);
        paintWindow(img, cx + 10, y0 + 11, 12, 22, ctx, CREAM, 'sash');
        fillRect(img, cx + 9, y0 + 33, 14, 2, STONE[3]);
      }
      plinth(img, w, H);
      fillRect(img, dx - 2, y0 + 6, 36, 4, STONE[2]); fillRect(img, dx - 2, y0 + 6, 36, 1, STONE[3]);
      woodDoor(img, dx, y0 + 10, H - y0 - 10);
    }
  },
  stone: {
    wall(img, x, y, w, h, ctx) {
      const r = ctx.ramp;
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
        const sx = i + ((j >> 3) & 1) * 8, t = hash01(ctx.seed, i, j);
        setPx(img, i, j, (j & 7) === 7 || (sx & 15) === 15 ? r[1] : t < 0.03 ? r[3] : t < 0.05 ? r[1] : r[2]);
      }
    },
    floor(img, y0, w, ctx) {
      const r = ctx.ramp;
      for (const cx of bays(w)) {
        fillRect(img, cx + 7, y0 + 1, 18, 2, r[3]); fillRect(img, cx + 7, y0 + 3, 18, 1, r[0]);   // pediment + shadow
        fillRect(img, cx + 8, y0 + 4, 16, 17, r[3]);                                               // raised surround
        paintWindow(img, cx + 10, y0 + 5, 12, 15, ctx, null, 'mullion');
        fillRect(img, cx + 7, y0 + 21, 18, 2, r[3]); fillRect(img, cx + 7, y0 + 23, 18, 1, r[0]);   // sill + shadow
      }
      course(img, y0 + 42, w, [r[3], r[3], r[2], r[2], r[1], r[0]]);
    },
    attic(img, rows, w, ctx) {
      const r = ctx.ramp;
      for (const cx of bays(w)) { fillRect(img, cx + 9, 9, 14, 11, r[3]); paintWindow(img, cx + 11, 10, 10, 9, ctx, null, null); }
      course(img, rows - 4, w, [r[3], r[2], r[1], r[0]]);
    },
    ground(img, y0, w, H, ctx, dx) {
      const r = ctx.ramp;
      fillRect(img, 0, y0, w, H - y0, r[2]);
      for (let j = y0 + 5; j < H; j += 6) fillRect(img, 0, j, w, 1, r[1]);                     // rusticated courses
      for (const cx of bays(w)) {
        if (nearDoor(cx, dx)) continue;
        fillRect(img, cx + 8, y0 + 9, 16, 26, r[3]);
        paintWindow(img, cx + 10, y0 + 11, 12, 22, ctx, null, 'mullion');
        fillRect(img, cx + 7, y0 + 35, 18, 2, r[3]); fillRect(img, cx + 7, y0 + 37, 18, 1, r[0]);
      }
      plinth(img, w, H);
      fillRect(img, dx - 3, y0 + 5, 38, H - y0 - 5, r[3]); strokeRect(img, dx - 3, y0 + 5, 38, H - y0 - 5, r[1]);
      woodDoor(img, dx, y0 + 10, H - y0 - 10);
    },
    finish(img, w, gfTop, ctx) {                      // quoins up both edges of the upper floors
      const r = ctx.ramp;
      for (let j = 0, k = 0; j < gfTop; j += 8, k++) {
        const qw = k & 1 ? 6 : 10;
        for (const x of [0, w - qw]) { fillRect(img, x, j, qw, 7, r[3]); fillRect(img, x, j + 7, qw, 1, r[1]); }
      }
    }
  },
  glass: {
    wall(img, x, y, w, h, ctx) { fillRect(img, x, y, w, h, ctx.ramp[1]); },
    floor(img, y0, w, ctx) { glassRow(img, 0, y0, w, 36, 48, ctx); },
    attic(img, rows, w, ctx) { glassRow(img, 0, 0, w, rows - 6, rows, ctx); },
    ground(img, y0, w, H, ctx, dx) {
      fillRect(img, 0, y0, w, 6, STEEL[1]); fillRect(img, 0, y0, w, 1, STEEL[3]); fillRect(img, 0, y0 + 5, w, 1, OUTLINE);
      glassRow(img, 0, y0 + 6, w, H - 6 - (y0 + 6), H - 6 - (y0 + 6), ctx);                       // lobby glazing
      fillRect(img, 0, H - 6, w, 1, OUTLINE);
      plinth(img, w, H);
      glassDoor(img, dx, y0 + 10, H - y0 - 10);
    }
  },
  shopfront: {
    wall(img, x, y, w, h, ctx) {
      const r = ctx.ramp;
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) { const t = hash01(ctx.seed, i, j); setPx(img, i, j, t < 0.04 ? r[1] : t < 0.06 ? r[3] : r[2]); }
    },
    floor(img, y0, w, ctx) {
      const r = ctx.ramp, a = ctx.acc;
      for (const cx of bays(w)) {
        fillRect(img, cx + 9, y0 + 3, 14, 2, r[3]);
        for (const sx of [cx + 5, cx + 23]) {                                                   // shutters
          fillRect(img, sx, y0 + 5, 4, 16, a[1]);
          for (let j = y0 + 7; j < y0 + 20; j += 2) fillRect(img, sx + 1, j, 2, 1, a[0]);
          strokeRect(img, sx, y0 + 5, 4, 16, OUTLINE);
        }
        paintWindow(img, cx + 10, y0 + 5, 12, 16, ctx, CREAM, 'mullion');
        if (hash01(ctx.seed + 5, cx, y0) < 0.5) {                                                // flower box
          fillRect(img, cx + 9, y0 + 21, 14, 1, RAMPS.green[2]);
          for (let i = 1; i < 14; i += 3) setPx(img, cx + 9 + i, y0 + 21, WARES[(i + cx) % WARES.length]);
          fillRect(img, cx + 9, y0 + 22, 14, 2, WOOD[1]); fillRect(img, cx + 9, y0 + 23, 14, 1, WOOD[0]);
        } else {
          fillRect(img, cx + 9, y0 + 21, 14, 2, r[3]); fillRect(img, cx + 9, y0 + 23, 14, 1, r[0]);
        }
      }
      course(img, y0 + 44, w, [r[3], a[1], a[1], r[0]]);
    },
    attic(img, rows, w, ctx) {
      const r = ctx.ramp;
      for (const cx of bays(w)) { paintWindow(img, cx + 11, 10, 10, 9, ctx, CREAM, null); fillRect(img, cx + 10, 19, 12, 1, r[3]); }
      course(img, rows - 4, w, [r[3], ctx.acc[1], ctx.acc[1], r[0]]);
    },
    ground(img, y0, w, H, ctx, dx) {
      const r = ctx.ramp, a = ctx.acc;
      fillRect(img, 0, y0, w, H - y0, r[1]);                                                     // shop surround
      fillRect(img, 0, y0 + 1, w, 5, a[0]); fillRect(img, 0, y0 + 1, w, 1, a[2]);                // fascia
      for (let i = 0; i < w; i += 4) fillRect(img, i, y0 + 6, 4, 5, (i >> 2) & 1 ? a[3] : a[2]); // awning stripes
      fillRect(img, 0, y0 + 11, w, 1, OUTLINE);
      for (let i = 0; i < w; i += 8) fillRect(img, i, y0 + 12, 4, 1, a[2]);                      // scalloped edge
      for (const [s, e] of [[3, dx - 5], [dx + 37, w - 3]]) {
        for (let x = s; e - x >= 16;) { const ww = Math.min(44, e - x); shopWindow(img, x, y0 + 15, ww, 24, ctx); x += ww + 3; }
      }
      fillRect(img, 0, y0 + 39, w, H - y0 - 39, WOOD[1]); fillRect(img, 0, y0 + 39, w, 1, OUTLINE);   // stall riser
      plinth(img, w, H);
      strokeRect(img, dx, y0 + 14, 32, H - y0 - 14, OUTLINE);                                    // painted, glazed door
      fillRect(img, dx + 1, y0 + 15, 30, H - y0 - 15, a[1]);
      for (const px of [dx + 4, dx + 18]) { fillRect(img, px, y0 + 18, 10, 12, GLASS[2]); strokeRect(img, px, y0 + 18, 10, 12, OUTLINE); }
      fillRect(img, dx + 14, y0 + 32, 4, 2, RAMPS.mustard[3]);
    }
  }
};

function drainpipe(img, u, w, H) {
  const x = Math.max(1, Math.min(w - 5, Math.round(u * PX_PER_UNIT)));
  fillRect(img, x, 8, 3, H - 13, STEEL[1]); fillRect(img, x, 8, 1, H - 13, STEEL[2]); fillRect(img, x + 2, 8, 1, H - 13, STEEL[0]);
  for (let j = 16; j < H - 8; j += 24) fillRect(img, x - 1, j, 5, 1, OUTLINE);                  // brackets
  fillRect(img, x, H - 7, 5, 2, STEEL[1]); fillRect(img, x, H - 6, 5, 1, OUTLINE);              // shoe
}
function ladder(img, fe, floors, w, H) {            // fire-escape ladder painted behind the 3D decks
  const x = Math.round((fe.a + fe.len - 0.75) * PX_PER_UNIT), top = H - FLOOR_PX * floors, bottom = H - 40;
  if (x < 0 || x + 7 >= w) return;
  fillRect(img, x, top, 1, bottom - top, STEEL[0]); fillRect(img, x + 7, top, 1, bottom - top, STEEL[0]);
  for (let j = top + 2; j < bottom; j += 4) fillRect(img, x + 1, j, 6, 1, STEEL[1]);
}
function signBoard(img, text, w, gfTop, a) {        // text sign above the ground floor (3x5 font, 2x)
  const s = 2, bw = textWidth(text, s) + 10, bh = 5 * s + 6;
  const bx = Math.max(2, Math.min(w - bw - 2, Math.round(w / 2 - bw / 2))), by = gfTop - bh - 4;
  fillRect(img, bx, by, bw, bh, a[0]);
  strokeRect(img, bx, by, bw, bh, OUTLINE);
  strokeRect(img, bx + 1, by + 1, bw - 2, bh - 2, a[3]);
  drawText(img, text, bx + 5, by + 3, s, a[3]);
}

// Street facade, (width x height) * 16 texels. Heights are whole 3-unit floors, optionally + a 1.5-unit attic row.
export function makeFacade(o) {
  const ctx = context(o), fam = FAMILY[o.family], w = texels(o.width), H = texels(o.height);
  if (H < FLOOR_PX || H % (FLOOR_PX / 2) !== 0) throw new Error('height must be 3-unit floors (+ an optional 1.5 attic): ' + o.height);
  const img = createImage(w, H), gfTop = H - FLOOR_PX, floors = Math.floor(gfTop / FLOOR_PX), attic = gfTop - floors * FLOOR_PX;
  fam.wall(img, 0, 0, w, H, ctx);
  for (let k = 1; k <= floors; k++) fam.floor(img, H - FLOOR_PX * (k + 1), w, ctx);
  if (attic) fam.attic(img, attic, w, ctx);
  if (fam.finish) fam.finish(img, w, gfTop, ctx);
  const dx = Math.max(2, Math.min(w - 34, Math.round(o.doorU * PX_PER_UNIT)));
  fam.ground(img, gfTop, w, H, ctx, dx);
  if (o.drainpipe != null) drainpipe(img, o.drainpipe, w, H);
  if (o.fireEscape && floors) ladder(img, o.fireEscape, floors, w, H);
  if (o.sign) signBoard(img, o.sign, w, gfTop, ctx.acc);
  img.windows = ctx.windows;                        // { total, lit } window / curtain-wall pane count (Phase D tests)
  return img;
}

// Side-face tile: one window bay of one floor, BAND_W x BAND_H (2 x 3 world units), tileable both ways.
export function makeEndBand(o) {
  const ctx = context(o), fam = FAMILY[o.family], img = createImage(BAND_W, BAND_H);
  fam.wall(img, 0, 0, BAND_W, BAND_H, ctx);
  fam.floor(img, 0, BAND_W, ctx);
  return img;
}

// The 3D trim of one building in facade-local coordinates: `out` = centre distance in front of the facade plane
// (negative = behind it, over the roof), `y` = bottom height, `a` = centre along the facade on the facade texture's u axis
// (world units from its left edge), size = [out, h, along]. Every size is a multiple of 1/16.
export function planTrim(o) {
  const t = FAMILY_TRIM[o.family], len = o.width, h = o.height, rnd = mulberry32(((o.seed | 0) * 7 + 3) >>> 0), items = [];
  const box = (name, kind, size, out, y, a, alpha) => items.push(Object.freeze({ name, kind, size: Object.freeze(size), out, y, a, alpha: !!alpha }));
  box('cornice', 'cornice', [t.corniceOut, t.corniceH, len], t.corniceOut / 2, h - t.corniceH, len / 2);
  box('parapet', 'parapet', [0.25, t.parapetH, len], -0.125, h, len / 2);
  // 1-2 rooftop boxes against the back of the parapet (so they show above it from the street), one per half of the roof
  const n = 1 + (rnd() < 0.6 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const kind = t.roof[i], s = ROOF_BOXES[kind], lo = i ? len / 2 + 0.5 : 0.5, hi = (i ? len - 0.5 : len / 2 - 0.5) - s[2];
    const a = Math.round((lo + rnd() * Math.max(0, hi - lo)) * 16) / 16 + s[2] / 2;
    if (kind === 'tank') {
      const st = ROOF_BOXES.stand;
      box('roof:' + i + ':stand', 'stand', st.slice(), -0.25 - s[0] / 2, h, a, true);
      box('roof:' + i + ':tank', 'tank', s.slice(), -0.25 - s[0] / 2, h + st[1], a);
    } else box('roof:' + i + ':' + kind, kind, s.slice(), -0.25 - s[0] / 2 - (kind === 'hut' ? 0.5 : 0), h, a);
  }
  if (o.entrance) {
    box('stoop', 'stoop', [0.5, 0.1875, 2.375], 0.25, 0, o.doorU + 1);
    box('canopy', 'canopy', [0.875, 0.125, 3], 0.4375, 2.75, o.doorU + 1);
  }
  if (o.fireEscape) {                               // a deck + railings at every upper floor level
    const f = o.fireEscape, a = f.a + f.len / 2, floors = Math.floor((h - 3) / 3);
    for (let k = 1; k <= floors; k++) {
      const y = 3 * k;
      box('fire-escape:' + k + ':deck', 'grate', [0.75, 0.125, f.len], 0.375, y - 0.125, a);
      box('fire-escape:' + k + ':rail', 'railing', [0.0625, 0.625, f.len], 0.71875, y, a, true);
      box('fire-escape:' + k + ':end0', 'railing', [0.75, 0.625, 0.0625], 0.375, y, f.a + 0.03125, true);
      box('fire-escape:' + k + ':end1', 'railing', [0.75, 0.625, 0.0625], 0.375, y, f.a + f.len - 0.03125, true);
    }
  }
  if (o.balcony) {
    const b = o.balcony, y = 3 * b.floor;
    box('balcony:slab', 'slab', [0.5, 0.1875, 2], 0.25, y - 0.1875, b.a);
    box('balcony:rail', 'balustrade', [0.0625, 0.625, 2], 0.46875, y, b.a, true);
    box('balcony:end0', 'balustrade', [0.5, 0.625, 0.0625], 0.25, y, b.a - 0.96875, true);
    box('balcony:end1', 'balustrade', [0.5, 0.625, 0.0625], 0.25, y, b.a + 0.96875, true);
  }
  if (o.blade) {                                    // lit blade sign standing out into the street, text faces along it
    const b = o.blade, bh = (b.text.length * 12 + 4) / PX_PER_UNIT;
    box('blade-sign', 'blade', [1, bh, 0.25], 0.625, b.y, b.a);
    box('blade-bracket:0', 'bracket', [0.125, 0.125, 0.125], 0.0625, b.y + 0.5, b.a);
    box('blade-bracket:1', 'bracket', [0.125, 0.125, 0.125], 0.0625, b.y + bh - 0.625, b.a);
  }
  return items;
}

// One face image of a trim box, tw x th texels. axis: 'x' = the +-x faces (along x h), 'y' = top/bottom (out x along),
// 'z' = the +-z faces (out x h). Alpha is 0 or 255.
export function paintTrimFace(kind, axis, tw, th, o) {
  const ctx = context(o), img = createImage(tw, th), r = ctx.ramp, a = ctx.acc;
  const c = ctx.family === 'brick' ? STONE : ctx.family === 'glass' ? STEEL : r;               // cornice / coping ramp
  switch (kind) {
    case 'cornice':
      if (axis === 'y') { fillRect(img, 0, 0, tw, th, c[1]); break; }
      fillRect(img, 0, 0, tw, th, c[2]); fillRect(img, 0, 0, tw, 1, c[3]);
      if (axis === 'x' && th >= 6) for (let i = 0; i < tw; i++) fillRect(img, i, th - 4, 1, 2, (i & 3) < 2 ? c[3] : c[0]); // dentils
      fillRect(img, 0, th - 1, tw, 1, OUTLINE);
      break;
    case 'parapet':
      if (axis === 'y') { fillRect(img, 0, 0, tw, th, c[3]); break; }
      if (ctx.family === 'glass') fillRect(img, 0, 0, tw, th, STEEL[1]); else FAMILY[ctx.family].wall(img, 0, 0, tw, th, ctx);
      fillRect(img, 0, 0, tw, 2, c[3]); fillRect(img, 0, 2, tw, 1, c[1]);                    // coping
      break;
    case 'stoop':
      fillRect(img, 0, 0, tw, th, axis === 'y' ? TRIM[2] : TRIM[1]);
      if (axis === 'y') { for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) if (hash01(ctx.seed, i, j) < 0.08) setPx(img, i, j, TRIM[3]); }
      else { fillRect(img, 0, 0, tw, 1, TRIM[3]); fillRect(img, 0, th - 1, tw, 1, TRIM[0]); }
      break;
    case 'canopy':
      if (axis === 'y') { for (let j = 0; j < th; j++) fillRect(img, 0, j, tw, 1, (j >> 2) & 1 ? a[3] : a[2]); fillRect(img, 0, 0, 1, th, a[1]); fillRect(img, tw - 1, 0, 1, th, a[1]); }
      else if (axis === 'x') for (let i = 0; i < tw; i++) fillRect(img, i, 0, 1, th, (i >> 2) & 1 ? a[3] : a[2]);
      else fillRect(img, 0, 0, tw, th, a[1]);
      if (axis !== 'y') fillRect(img, 0, th - 1, tw, 1, OUTLINE);
      break;
    case 'tank':
      if (axis === 'y') { fillRect(img, 0, 0, tw, th, WOOD[0]); strokeRect(img, 0, 0, tw, th, OUTLINE); break; }
      for (let i = 0; i < tw; i++) fillRect(img, i, 0, 1, th, (i & 3) === 3 ? WOOD[0] : (i >> 2) & 1 ? WOOD[2] : WOOD[1]); // staves
      fillRect(img, 0, 3, tw, 1, STEEL[0]); fillRect(img, 0, th - 5, tw, 1, STEEL[0]);         // hoops
      fillRect(img, 0, 0, tw, 1, WOOD[3]); fillRect(img, 0, th - 1, tw, 1, OUTLINE);
      break;
    case 'stand':                                   // open steel frame: legs, top rail, one brace; the rest is cut out
      if (axis === 'y') { fillRect(img, 0, 0, tw, th, STEEL[1]); break; }
      for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) {
        const brace = i === 2 + Math.round((j - 2) * (tw - 5) / Math.max(1, th - 3));
        if (j < 2) setPx(img, i, j, STEEL[1]); else if (i < 2 || i >= tw - 2 || brace) setPx(img, i, j, STEEL[0]);
      }
      break;
    case 'ac':
      fillRect(img, 0, 0, tw, th, STEEL[2]);
      if (axis === 'y') { if (tw >= 10 && th >= 10) { const fx = (tw >> 1) - 3, fy = (th >> 1) - 3; fillRect(img, fx, fy, 6, 6, STEEL[1]); strokeRect(img, fx, fy, 6, 6, STEEL[0]); } break; }
      for (let j = 2; j < th - 2; j += 2) fillRect(img, 2, j, tw - 4, 1, STEEL[1]);             // grille
      strokeRect(img, 0, 0, tw, th, OUTLINE);
      break;
    case 'hut':                                     // roof-access stair hut in the building's wall colour
      if (axis === 'y') { fillRect(img, 0, 0, tw, th, RAMPS.roof[0]); break; }
      fillRect(img, 0, 0, tw, th, r[1]);
      for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) if (hash01(ctx.seed + 9, i, j) < 0.06) setPx(img, i, j, r[0]);
      fillRect(img, 0, 0, tw, 2, r[3]);
      if (axis === 'x') { const dx = (tw >> 1) - 5; strokeRect(img, dx, th - 18, 10, 18, OUTLINE); fillRect(img, dx + 1, th - 17, 8, 17, WOOD[1]); }
      break;
    case 'grate':                                   // fire-escape deck
      if (axis === 'y') { for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) setPx(img, i, j, (i + j) & 1 ? STEEL[0] : STEEL[1]); break; }
      fillRect(img, 0, 0, tw, th, STEEL[0]); fillRect(img, 0, 0, tw, 1, STEEL[2]);
      break;
    case 'slab':                                    // balcony floor
      fillRect(img, 0, 0, tw, th, axis === 'y' ? r[3] : r[2]);
      if (axis !== 'y') { fillRect(img, 0, 0, tw, 1, r[3]); fillRect(img, 0, th - 1, tw, 1, OUTLINE); }
      break;
    case 'railing': case 'balustrade': {            // rails + bars; gaps are cut out (alpha 0)
      const col = kind === 'railing' ? STEEL[0] : r[3], rail = kind === 'railing' ? STEEL[1] : r[1];
      if (tw <= 2 || th <= 2) { fillRect(img, 0, 0, tw, th, col); break; }
      fillRect(img, 0, 0, tw, 1, rail); fillRect(img, 0, th - 1, tw, 1, rail);
      for (let i = 0; i < tw; i++) if (i % 3 === 0 || i === tw - 1) fillRect(img, i, 1, 1, th - 2, col);
      break;
    }
    case 'blade':                                   // lit sign: bright border, text stacked vertically
      if (axis !== 'z') { fillRect(img, 0, 0, tw, th, a[1]); strokeRect(img, 0, 0, tw, th, OUTLINE); break; }
      fillRect(img, 0, 0, tw, th, a[0]);
      strokeRect(img, 0, 0, tw, th, OUTLINE);
      strokeRect(img, 1, 1, tw - 2, th - 2, LAMP[3]);
      [...o.blade.text].forEach((ch, i) => drawText(img, ch, (tw - textWidth(ch, 2)) >> 1, 4 + i * 12, 2, a[3]));
      break;
    case 'bracket':
      fillRect(img, 0, 0, tw, th, STEEL[0]);
      break;
    default:
      throw new Error('unknown trim kind: ' + kind);
  }
  return img;
}
