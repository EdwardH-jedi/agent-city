// Placeholder ground tile (Phase 1). 16x16 texels = 1 world unit. Deterministic for a seed.
// Phase 2 replaces this with the full procedural texture set; no ROM or external art is involved.
export const TILE_PX = 16;
const PALETTE = [[0x6b, 0x70, 0x78], [0x5e, 0x63, 0x6b], [0x7a, 0x7f, 0x86], [0x4a, 0x4e, 0x55]]; // 3 shades + mortar

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Paver pattern: 8x4 stone blocks in running bond, 1 px mortar, 3 stone shades picked per block.
export function makeGroundTileRGBA(seed) {
  const rnd = mulberry32(seed);
  const out = new Uint8Array(TILE_PX * TILE_PX * 4);
  const shade = [];
  for (let by = 0; by < 4; by++) for (let bx = 0; bx < 3; bx++) shade[by * 3 + bx] = (rnd() * 3) | 0;
  for (let y = 0; y < TILE_PX; y++) {
    const row = (y / 4) | 0;
    const off = (row & 1) ? 4 : 0;
    for (let x = 0; x < TILE_PX; x++) {
      const xx = (x + off) % TILE_PX;
      const mortar = (y % 4 === 3) || (xx % 8 === 7);
      const c = mortar ? PALETTE[3] : PALETTE[shade[row * 3 + ((xx / 8) | 0)]];
      const i = (y * TILE_PX + x) * 4;
      out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255;
    }
  }
  return out;
}
