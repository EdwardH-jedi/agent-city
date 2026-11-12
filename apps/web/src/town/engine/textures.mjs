// Procedural pixel-art generators for the alley (M2.7 §3.4). Pure functions: (seed, size) -> {width, height, data}
// where data is top-down RGBA bytes (row 0 = top). Deterministic for a seed; no DOM, no canvas, no external art.
// NOTE: the planned procedural-pixel-art library ($PIX = ~/Developer/Edward_world) is not present on this
// machine, so these painters are written fresh here; nothing is copied or traced from any other source.
// Palette: muted DS-era ramps, 3-4 shades per material, 1 px dark outline on windows and doors.

export const PX_PER_UNIT = 16;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Ramps are dark -> light, each a small set of shades.
export const RAMPS = Object.freeze({
  brick: [[0x6e, 0x44, 0x3c], [0x84, 0x52, 0x46], [0x9a, 0x62, 0x52], [0xae, 0x74, 0x60]],
  plaster: [[0xa0, 0x94, 0x80], [0xb6, 0xaa, 0x94], [0xc8, 0xbd, 0xa6], [0xd9, 0xcf, 0xb8]],
  slate: [[0x4a, 0x52, 0x64], [0x5c, 0x66, 0x7a], [0x70, 0x7b, 0x90], [0x86, 0x92, 0xa6]],
  sand: [[0x9a, 0x84, 0x62], [0xb0, 0x9a, 0x76], [0xc4, 0xae, 0x88], [0xd6, 0xc2, 0x9c]],
  glass: [[0x2a, 0x3c, 0x56], [0x3a, 0x54, 0x76], [0x54, 0x78, 0x98], [0x7e, 0xa4, 0xbc]],
  trim: [[0x3a, 0x36, 0x3c], [0x56, 0x50, 0x56], [0x74, 0x6c, 0x70], [0x92, 0x8a, 0x88]],
  steel: [[0x36, 0x3c, 0x46], [0x4c, 0x54, 0x60], [0x66, 0x70, 0x7c], [0x82, 0x8c, 0x98]],
  roof: [[0x4a, 0x42, 0x44]],
  teal: [[0x24, 0x56, 0x54], [0x32, 0x70, 0x6a], [0x46, 0x8a, 0x80], [0x62, 0xa6, 0x98]],
  rust: [[0x6a, 0x2c, 0x22], [0x84, 0x3c, 0x2c], [0xa0, 0x50, 0x38], [0xb8, 0x68, 0x48]],
  mustard: [[0x8a, 0x6c, 0x1c], [0xa8, 0x88, 0x2a], [0xc4, 0xa2, 0x3c], [0xd8, 0xba, 0x58]],
  sport: [[0x20, 0x3c, 0x74], [0x2e, 0x54, 0x9c], [0x44, 0x70, 0xc0], [0xf0, 0xe4, 0xc0]],
  wood: [[0x4c, 0x34, 0x26], [0x68, 0x48, 0x32], [0x86, 0x60, 0x40], [0xa4, 0x7a, 0x50]],
  green: [[0x2c, 0x4a, 0x36], [0x3a, 0x62, 0x46], [0x4c, 0x7c, 0x58], [0x66, 0x98, 0x70]],
  lamp: [[0x2c, 0x2e, 0x34], [0x44, 0x48, 0x50], [0xf4, 0xe0, 0x9a], [0xff, 0xf0, 0xc0]],
  olive: [[0x58, 0x62, 0x40], [0x6c, 0x78, 0x50], [0x82, 0x8e, 0x62], [0x9a, 0xa6, 0x78]],
  rose: [[0x9a, 0x62, 0x62], [0xb2, 0x76, 0x72], [0xc6, 0x8a, 0x84], [0xd8, 0xa0, 0x98]],
  ochre: [[0xa0, 0x78, 0x34], [0xb8, 0x8c, 0x44], [0xcc, 0xa0, 0x56], [0xde, 0xb6, 0x70]]
});
export const OUTLINE = [0x1c, 0x1a, 0x20];

export function createImage(width, height) { return { width, height, data: new Uint8Array(width * height * 4) }; }
export function setPx(img, x, y, c) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
}
export function fillRect(img, x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) setPx(img, x + i, y + j, c); }
export function strokeRect(img, x, y, w, h, c) {
  for (let i = 0; i < w; i++) { setPx(img, x + i, y, c); setPx(img, x + i, y + h - 1, c); }
  for (let j = 0; j < h; j++) { setPx(img, x, y + j, c); setPx(img, x + w - 1, y + j, c); }
}
// Flip rows so row 0 is the bottom (WebGL v = 0). DataTexture uploads are not flipped by three.
export function flipRows(img) {
  const out = createImage(img.width, img.height), row = img.width * 4;
  for (let y = 0; y < img.height; y++) out.data.set(img.data.subarray(y * row, (y + 1) * row), (img.height - 1 - y) * row);
  return out;
}
// Time-of-day tint (M2.8 Phase D): a copy of img with RGB multiplied by tint [r, g, b] (rounded), except where `ref` (an
// image of the same size) differs from img. Those texels are copied unchanged: they are the emissive ones (a facade painted
// with lit windows vs the same facade painted unlit), so lit panes stay full brightness under a darkening tint.
export function tintImage(img, tint, ref) {
  const out = createImage(img.width, img.height), s = img.data, d = out.data, r = ref ? ref.data : null;
  if (r && (ref.width !== img.width || ref.height !== img.height)) throw new Error('tint reference size mismatch');
  for (let i = 0; i < s.length; i += 4) {
    const keep = r && (s[i] !== r[i] || s[i + 1] !== r[i + 1] || s[i + 2] !== r[i + 2] || s[i + 3] !== r[i + 3]);
    for (let c = 0; c < 3; c++) d[i + c] = keep ? s[i + c] : Math.min(255, Math.round(s[i + c] * tint[c]));
    d[i + 3] = s[i + 3];
  }
  return out;
}

// --- 3x5 / 4x5 pixel font (only the letters the alley signs need) ------------------------------------
const FONT = {
  S: ['###', '#..', '###', '..#', '###'], P: ['###', '#.#', '###', '#..', '#..'], O: ['###', '#.#', '#.#', '#.#', '###'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'], T: ['###', '.#.', '.#.', '.#.', '.#.'], G: ['###', '#..', '#.#', '#.#', '###'],
  A: ['.#.', '#.#', '###', '#.#', '#.#'], N: ['#..#', '##.#', '#.##', '#..#', '#..#'], E: ['###', '#..', '##.', '#..', '###'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'], I: ['###', '.#.', '.#.', '.#.', '###'],
  // M2.8 Phase F: the town's department, kiosk and street signs (PLANNING, RESEARCH, DESIGN, QA LAB, COFFEE, BOOKS, BIKES,
  // LANTERN ROW). Same 5-row grid, drawn in-repo.
  B: ['##.', '#.#', '##.', '#.#', '##.'], C: ['###', '#..', '#..', '#..', '###'], D: ['##.', '#.#', '#.#', '#.#', '##.'],
  F: ['###', '#..', '##.', '#..', '#..'], H: ['#.#', '#.#', '###', '#.#', '#.#'], K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'], Q: ['###', '#.#', '#.#', '##.', '..#'], W: ['#...#', '#...#', '#.#.#', '#.#.#', '.#.#.'],
  ' ': ['..', '..', '..', '..', '..']
};
export function textWidth(text, scale) {
  let w = 0;
  for (const ch of text) { const g = FONT[ch]; if (!g) throw new Error('no glyph for ' + ch); w += (g[0].length + 1) * scale; }
  return w - scale;
}
export function drawText(img, text, x, y, scale, color) {
  let cx = x;
  for (const ch of text) {
    const g = FONT[ch];
    if (!g) throw new Error('no glyph for ' + ch);
    for (let r = 0; r < 5; r++) for (let c = 0; c < g[r].length; c++) if (g[r][c] === '#') fillRect(img, cx + c * scale, y + r * scale, scale, scale, color);
    cx += (g[0].length + 1) * scale;
  }
}

function window3(img, x, y, w, h, lit, seed) {
  strokeRect(img, x, y, w, h, OUTLINE);                       // 1 px dark outline
  const gl = RAMPS.glass;
  fillRect(img, x + 1, y + 1, w - 2, h - 2, lit ? RAMPS.lamp[2] : gl[1 + (seed % 2)]);
  fillRect(img, x + 1, y + 1, w - 2, 2, lit ? RAMPS.lamp[3] : gl[3]);                  // top glint
  fillRect(img, x + Math.floor(w / 2), y + 1, 1, h - 2, lit ? RAMPS.lamp[2] : gl[0]);  // mullion
}

// One floor = 3 world units = 48 texels. Repeating window band tile: 2 x 3 world units = 32 x 48 texels (wall base,
// one 12 x 16 window, sill, floor band along the BOTTOM edge). Tileable, and a partial tile at the top of a face (half a floor)
// shows only the lower half: plain wall + the floor band, never half a window.
export const BAND_W = 32, BAND_H = 48;
export const FLOOR_PX = 48;
function floorBand(img, x, y, w, ramp) {          // 4 rows: light edge, two mid rows, dark line
  fillRect(img, x, y, w, 1, ramp[3]); fillRect(img, x, y + 1, w, 2, ramp[2]); fillRect(img, x, y + 3, w, 1, ramp[0]);
}
export function makeWindowBandImage(seed, wall) {
  const img = createImage(BAND_W, BAND_H), ramp = RAMPS[wall] || RAMPS.plaster, rnd = mulberry32(seed);
  fillRect(img, 0, 0, BAND_W, BAND_H, ramp[1]);
  for (let i = 0; i < 80; i++) setPx(img, Math.floor(rnd() * BAND_W), Math.floor(rnd() * BAND_H), ramp[rnd() < 0.5 ? 0 : 2]);
  window3(img, 10, 4, 12, 16, rnd() < 0.15, seed);   // rows 4..19: 0.75 x 1.0 world units
  fillRect(img, 9, 20, 14, 2, ramp[3]);               // sill
  fillRect(img, 9, 21, 14, 1, ramp[0]);
  floorBand(img, 0, BAND_H - 4, BAND_W, ramp);        // floor band on the bottom edge
  return img;
}

// Awning skin for the 3D entrance canopy (stripes), 16 x 8.
export function makeCanopyImage(awning) {
  const img = createImage(16, 8), aw = RAMPS[awning] || RAMPS.teal;
  fillRect(img, 0, 0, 16, 8, aw[2]);
  for (let x = 0; x < 16; x += 4) fillRect(img, x, 0, 2, 8, aw[3]);
  fillRect(img, 0, 7, 16, 1, OUTLINE);
  return img;
}

// Street-facing facade: ground floor (shopfront, door, awning, sign) + upper floors (window, sill, floor band) + an
// optional attic row + a cornice line at the top. Size = world units * 16. Heights are whole floors (3 units) or whole
// floors + 1.5 (an attic row of small windows).
export function makeFacadeImage(o) {
  const w = Math.round(o.width * PX_PER_UNIT), h = Math.round(o.height * PX_PER_UNIT);
  const img = createImage(w, h), rnd = mulberry32(o.seed), ramp = RAMPS[o.wall] || RAMPS.plaster;
  fillRect(img, 0, 0, w, h, ramp[1]);
  for (let i = 0; i < w * h / 24; i++) setPx(img, Math.floor(rnd() * w), Math.floor(rnd() * h), ramp[rnd() < 0.5 ? 0 : 2]);
  const gfH = FLOOR_PX, gfTop = h - gfH;
  const floors = Math.floor((gfTop) / FLOOR_PX);                 // full upper floors
  const attic = gfTop - floors * FLOOR_PX;                       // 0 or 24 texel attic row at the very top
  for (let k = 1; k <= floors; k++) {
    const cy = h - FLOOR_PX * (k + 1);
    for (let cx = 0; cx + BAND_W <= w; cx += BAND_W) {
      const cell = makeWindowBandImage(o.seed + ((cx / BAND_W) | 0) * 7 + k * 13, o.wall);
      for (let y = 0; y < BAND_H; y++) for (let x = 0; x < BAND_W; x++) {
        const i = (y * BAND_W + x) * 4;
        setPx(img, cx + x, cy + y, [cell.data[i], cell.data[i + 1], cell.data[i + 2]]);
      }
    }
  }
  if (attic > 0) {                                               // small attic windows under the cornice
    for (let cx = 0; cx + BAND_W <= w; cx += BAND_W) window3(img, cx + 10, 6, 12, 10, rnd() < 0.1, o.seed + cx);
    floorBand(img, 0, attic - 4, w, ramp);
  }
  fillRect(img, 0, 0, w, 1, ramp[3]); fillRect(img, 0, 1, w, 1, OUTLINE);   // cornice line (the 3D ledge sits on top)
  // ground-floor base (the band above it is the bottom edge of the first-floor tile)
  fillRect(img, 0, gfTop, w, gfH, ramp[2]);                      // ground floor: lighter wall tone than the upper floors
  for (let i = 0; i < w * gfH / 20; i++) setPx(img, Math.floor(rnd() * w), gfTop + Math.floor(rnd() * gfH), ramp[rnd() < 0.5 ? 1 : 3]);
  fillRect(img, 0, h - 5, w, 5, RAMPS.trim[1]);                  // plinth
  fillRect(img, 0, h - 5, w, 1, RAMPS.trim[3]);
  // door
  const dx = Math.max(4, Math.min(w - 36, Math.round(o.doorU * PX_PER_UNIT)));
  strokeRect(img, dx, gfTop + 10, 32, gfH - 10, OUTLINE);
  fillRect(img, dx + 1, gfTop + 11, 30, gfH - 11, RAMPS.wood[1]);
  fillRect(img, dx + 4, gfTop + 14, 10, 14, RAMPS.glass[2]); fillRect(img, dx + 18, gfTop + 14, 10, 14, RAMPS.glass[2]);
  strokeRect(img, dx + 4, gfTop + 14, 10, 14, OUTLINE); strokeRect(img, dx + 18, gfTop + 14, 10, 14, OUTLINE);
  fillRect(img, dx + 14, gfTop + 32, 3, 3, RAMPS.mustard[3]);   // handle
  // shopfront windows either side of the door (not for blank flats)
  if (o.kind !== 'flats') {
    for (const wx of [dx - 40, dx + 40]) {
      if (wx < 4 || wx + 32 > w - 4) continue;
      strokeRect(img, wx, gfTop + 14, 32, gfH - 20, OUTLINE);
      fillRect(img, wx + 1, gfTop + 15, 30, gfH - 22, RAMPS.glass[1]);
      fillRect(img, wx + 1, gfTop + 15, 30, 3, RAMPS.glass[3]);
    }
  }
  // awning stripe above the door/shopfront
  const aw = RAMPS[o.awning] || RAMPS.teal;
  fillRect(img, Math.max(2, dx - 44), gfTop + 4, Math.min(w - 4, 120), 6, aw[2]);
  for (let x = Math.max(2, dx - 44); x < Math.min(w - 2, dx - 44 + 120); x += 8) fillRect(img, x, gfTop + 4, 4, 6, aw[3]);
  fillRect(img, Math.max(2, dx - 44), gfTop + 9, Math.min(w - 4, 120), 1, OUTLINE);
  // sign (text only, no live data)
  if (o.sign) {
    const scale = 2, tw = textWidth(o.sign, scale), bw = tw + 10, bh = 5 * scale + 6;
    const bx = Math.max(2, Math.min(w - bw - 2, Math.round(w / 2 - bw / 2))), by = gfTop - bh - 4;
    fillRect(img, bx, by, bw, bh, RAMPS.sport[0]);
    strokeRect(img, bx, by, bw, bh, OUTLINE);
    strokeRect(img, bx + 1, by + 1, bw - 2, bh - 2, RAMPS.sport[3]);
    drawText(img, o.sign, bx + 5, by + 3, scale, RAMPS.sport[3]);
  }
  return img;
}

// Prop skins (small): bin, lamp pole, bench. All w x h in texels, tiny.
export function makePropImage(kind, seed) {
  const rnd = mulberry32(seed);
  if (kind === 'bin') {
    const img = createImage(16, 20);
    fillRect(img, 0, 0, 16, 20, RAMPS.green[1]);
    fillRect(img, 0, 0, 16, 4, RAMPS.green[3]); fillRect(img, 0, 4, 16, 1, OUTLINE);
    for (let x = 3; x < 16; x += 4) fillRect(img, x, 6, 1, 12, RAMPS.green[0]);
    for (let i = 0; i < 14; i++) setPx(img, Math.floor(rnd() * 16), 5 + Math.floor(rnd() * 14), RAMPS.green[2]);
    strokeRect(img, 0, 0, 16, 20, OUTLINE);
    return img;
  }
  if (kind === 'lamp') {
    const img = createImage(4, 16);
    fillRect(img, 0, 0, 4, 16, RAMPS.lamp[1]); fillRect(img, 0, 0, 1, 16, RAMPS.lamp[0]); fillRect(img, 3, 0, 1, 16, RAMPS.lamp[0]);
    return img;
  }
  if (kind === 'lamphead') {
    const img = createImage(8, 6);
    fillRect(img, 0, 0, 8, 6, RAMPS.lamp[1]); fillRect(img, 1, 2, 6, 3, RAMPS.lamp[2]); fillRect(img, 1, 2, 6, 1, RAMPS.lamp[3]);
    strokeRect(img, 0, 0, 8, 6, OUTLINE);
    return img;
  }
  if (kind === 'bench') { // seen from the side: seat slats, back, legs
    const img = createImage(32, 16);
    fillRect(img, 0, 0, 32, 16, RAMPS.trim[0]);                                               // opaque backing (no alpha cut-outs)
    fillRect(img, 0, 2, 32, 4, RAMPS.wood[2]); fillRect(img, 0, 3, 32, 1, RAMPS.wood[3]);   // back rest
    fillRect(img, 0, 8, 32, 3, RAMPS.wood[1]);                                               // seat
    fillRect(img, 2, 11, 3, 5, RAMPS.steel[1]); fillRect(img, 27, 11, 3, 5, RAMPS.steel[1]);
    return img;
  }
  throw new Error('unknown prop kind: ' + kind);
}

// Door-frame texture (steel jamb/lintel) for the exit doorway.
export function makeDoorFrameImage(seed) {
  const img = createImage(16, 16), rnd = mulberry32(seed);
  fillRect(img, 0, 0, 16, 16, RAMPS.steel[1]);
  for (let i = 0; i < 24; i++) setPx(img, Math.floor(rnd() * 16), Math.floor(rnd() * 16), RAMPS.steel[rnd() < 0.5 ? 0 : 2]);
  strokeRect(img, 0, 0, 16, 16, OUTLINE);
  return img;
}

export const TEXTURE_SIZES = Object.freeze({ band: [BAND_W, BAND_H], pxPerUnit: PX_PER_UNIT });
