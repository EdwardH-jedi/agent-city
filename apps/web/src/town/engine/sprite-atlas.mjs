// Sprite atlas (M2.7 §3.5): TownRooArtM2 kangaroo frames (32x40, feet anchor 16,38; reused unmodified) and the
// synthetic worker frames (TownArt, 24x40, pivot 12,40) packed into one RGBA image on a 32x40 cell grid.
// Worker frames are placed so their pivot lands on cell (16, 40). A DataTexture stands in for the prompt's
// CanvasTexture: identical to the GPU, and it needs no DOM so the atlas is testable headless.
import { DataTexture, RGBAFormat, UnsignedByteType, NearestFilter, ClampToEdgeWrapping } from 'three';
import { flipRows } from './textures.mjs';

export const CELL_W = 32;
export const CELL_H = 40;
export const COLS = 16;
export const NPC_FACINGS = ['north', 'east', 'south', 'west'];
export const NPC_ACTIONS = Object.freeze({ idle: 2, walk: 4 });

export const rooKey = (direction, action, frame) => `roo|${direction}|${action}|${frame}`;
export const npcKey = (id, facing, action, frame) => `npc|${id}|${facing}|${action}|${frame}`;

// TownArt's `frame` is a 60 Hz display-frame counter, not a phase index: walk is 4 phases x 8 frames, idle holds phase 0
// for 168 frames then blinks. Atlas frame i of an action is TownArt phase i, requested at the frame where that phase
// starts (walk 0/8/16/24, idle 0/168). M2.7 passed i itself, which packed phase 0 four times (M2.8 Phase E).
export function phaseStartFrames(art, action) {
  const out = [];
  if (typeof art.getAnimation !== 'function') return out;
  let t = 0;
  for (const seg of art.getAnimation(action).timeline) { if (out[seg.phase] === undefined) out[seg.phase] = t; t += seg.frames; }
  return out;
}

// M2.9 T2: townsfolk palette swap. Rotates the hue of clothing and hair pixels by `deg`; keeps outlines / deep shadows
// (lightness < 0.2), skin tones (hue 8-48, saturation 0.2-0.8, lightness >= 0.4) and near-greys (saturation < 0.12) as drawn,
// so a townsperson shares the art's grammar but never wears an agent's exact palette. Returns a new RGBA array.
export function recolorRGBA(rgba, deg) {
  const out = new Uint8Array(rgba.length);
  out.set(rgba);
  if (!deg) return out;
  for (let i = 0; i < out.length; i += 4) {
    if (!out[i + 3]) continue;
    const r = out[i] / 255, g = out[i + 1] / 255, b = out[i + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (l < 0.2 || d < 1e-6) continue;
    const sat = d / (1 - Math.abs(2 * l - 1));
    let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    if (sat < 0.12) continue;
    if (h >= 8 && h <= 48 && sat >= 0.2 && sat <= 0.8 && l >= 0.4) continue;
    const h2 = (h + deg) % 360, c = (1 - Math.abs(2 * l - 1)) * sat, x = c * (1 - Math.abs(((h2 / 60) % 2) - 1)), m = l - c / 2;
    const [r1, g1, b1] = h2 < 60 ? [c, x, 0] : h2 < 120 ? [x, c, 0] : h2 < 180 ? [0, c, x] : h2 < 240 ? [0, x, c] : h2 < 300 ? [x, 0, c] : [c, 0, x];
    out[i] = Math.round((r1 + m) * 255); out[i + 1] = Math.round((g1 + m) * 255); out[i + 2] = Math.round((b1 + m) * 255);
  }
  return out;
}

// rooArt: window.TownRooArtM2. art: window.TownArt (optional; without it no NPC frames are packed).
// npcs: [{id, family, recolor?}] (alley-layout NPCS; M2.9 town-walkers TOWN_WALKERS carry recolor = hue degrees).
export function buildSpriteAtlas({ rooArt, art, npcs }) {
  if (!rooArt || typeof rooArt.getFrame !== 'function') throw new TypeError('buildSpriteAtlas: rooArt (TownRooArtM2) is required');
  const entries = []; // {key, pixels (w,h,rgba), ox, oy, anchorX, anchorY}
  const m = rooArt.metrics;
  for (const direction of m.directions) for (const action of m.actions) {
    const n = rooArt.getFrameCount({ direction, action });
    for (let f = 0; f < n; f++) {
      const g = rooArt.getFrame({ direction, action, frame: f });
      if (g.w !== CELL_W || g.h !== CELL_H) throw new Error('roo frame is not 32x40: ' + direction + '/' + action + '/' + f);
      entries.push({ key: rooKey(direction, action, f), w: g.w, h: g.h, rgba: g.rgba, ox: 0, oy: 0, anchorX: g.anchorX, anchorY: g.anchorY });
    }
  }
  const variants = new Map();       // npc id -> TownArt 'style/skin' (debug and tests: which look each walker got)
  if (art && typeof art.getSprite === 'function') {
    const starts = {};
    for (const action of Object.keys(NPC_ACTIONS)) starts[action] = phaseStartFrames(art, action);
    for (const npc of npcs || []) {
      if (typeof art.resolve === 'function') { const r = art.resolve({ id: npc.id, modelFamily: npc.family }); variants.set(npc.id, r.style + '/' + r.skin + (npc.recolor ? '/hue' + npc.recolor : '')); }
    }
    for (const npc of npcs || []) for (const facing of NPC_FACINGS) for (const action of Object.keys(NPC_ACTIONS)) {
      for (let f = 0; f < NPC_ACTIONS[action]; f++) {
        const at = starts[action][f] === undefined ? f : starts[action][f];
        const s = art.getSprite({ id: npc.id, modelFamily: npc.family, facing, action, frame: at, costume: null });
        const ox = Math.round(CELL_W / 2 - s.pivotX), oy = CELL_H - Math.round(s.pivotY);
        if (ox < 0 || oy < 0 || ox + s.width > CELL_W || oy + s.height > CELL_H) throw new Error('worker frame does not fit the 32x40 cell');
        entries.push({ key: npcKey(npc.id, facing, action, f), w: s.width, h: s.height, rgba: npc.recolor ? recolorRGBA(s.rgba, npc.recolor) : s.rgba, ox, oy, anchorX: CELL_W / 2, anchorY: CELL_H });
      }
    }
  }
  const rows = Math.ceil(entries.length / COLS);
  const width = COLS * CELL_W, height = rows * CELL_H;
  const data = new Uint8Array(width * height * 4);
  const frames = new Map();
  entries.forEach((e, i) => {
    const x = (i % COLS) * CELL_W, y = Math.floor(i / COLS) * CELL_H;
    for (let r = 0; r < e.h; r++) {
      const dst = ((y + e.oy + r) * width + x + e.ox) * 4;
      data.set(e.rgba.subarray(r * e.w * 4, (r + 1) * e.w * 4), dst);
    }
    frames.set(e.key, Object.freeze({
      key: e.key, x, y, w: CELL_W, h: CELL_H,
      u0: x / width, u1: (x + CELL_W) / width,
      v0: 1 - (y + CELL_H) / height, v1: 1 - y / height,        // v = 0 is the bottom row of the (flipped) texture
      anchorX: e.anchorX, anchorY: e.anchorY,
      cx: e.anchorX / CELL_W, cy: (CELL_H - e.anchorY) / CELL_H  // Sprite.center: pivot at the feet anchor
    }));
  });
  return Object.freeze({ width, height, data, frames, cols: COLS, rows, variants });
}

export function makeAtlasTexture(atlas) {
  const f = flipRows({ width: atlas.width, height: atlas.height, data: atlas.data });
  const t = new DataTexture(f.data, f.width, f.height, RGBAFormat, UnsignedByteType);
  t.magFilter = t.minFilter = NearestFilter;
  t.generateMipmaps = false;
  t.wrapS = t.wrapT = ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}
