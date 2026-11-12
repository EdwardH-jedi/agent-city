// Far-background skyline (M2.8 section 2, "Far background"): one flat plane of distant tower silhouettes in two haze
// colours, standing on a fog-coloured base that blends into the fully fogged ground. The plane is anchored to the
// camera (a fixed offset along -z, eye level fixed on the plane), so it never grows or slides as the player walks: like
// the sky, it reads as infinitely far. It is not fogged; its own colours are the haze. Generated here from a seed.
import {
  Mesh, PlaneGeometry, MeshBasicMaterial, DataTexture, RGBAFormat, UnsignedByteType, NearestFilter, ClampToEdgeWrapping
} from 'three';
import { RT_H } from './pipeline-core.mjs';
import { createImage, fillRect, flipRows, mulberry32, setPx } from './textures.mjs';

export const SKYLINE_DEPTH = 64;        // world units ahead of the camera along -z: past the alley end, inside the far plane (80)
export const SKYLINE_W = 512;           // texels; wider than the frame at SKYLINE_DEPTH
export const SKYLINE_H = 64;            // texels
export const SKYLINE_EYE_ROW = 40;      // texel row (from the top) at the camera's eye level = the horizon
export const SKYLINE_MAX_RISE = 18;     // tallest tower, in texels above the horizon
// Two haze tones (far / near) + the fog-coloured base. Both tones sit > 29 RGB from the day sky line #8ec5ff -> #dff1ff,
// so scripts/measure.mjs reads them as "not sky" and the gradient visibly ends on the silhouette.
export const SKYLINE_TONES = Object.freeze({ far: [0xbc, 0xcf, 0xe2], near: [0xa3, 0xb8, 0xcf] });
// Phase D: per-time silhouette tones (each > 19 RGB from that time's sky line, tested) and a fraction of tower texels lit
// as distant windows. Day is the Phase A image unchanged.
export const SKYLINE_LIGHT = [0xff, 0xd8, 0x8a];
export const SKYLINE_LOOKS = Object.freeze({
  day: Object.freeze({ tones: SKYLINE_TONES, lights: 0 }),
  dusk: Object.freeze({ tones: Object.freeze({ far: [0x7a, 0x44, 0x5a], near: [0x52, 0x2c, 0x48] }), lights: 0.015 }),
  night: Object.freeze({ tones: Object.freeze({ far: [0x10, 0x14, 0x26], near: [0x0a, 0x0c, 0x1a] }), lights: 0.04 })
});

function hexToRgb(h) { return [(h >> 16) & 255, (h >> 8) & 255, h & 255]; }

// Top-down RGBA image. Rows below SKYLINE_EYE_ROW are the base (`base` colour, opaque); above it, far towers (tall, packed)
// and near towers (short, sparse) in the two tones; everything else is transparent (alpha 0) so the sky shows through.
export function makeSkylineImage(seed, base, tones, lights) {
  const img = createImage(SKYLINE_W, SKYLINE_H), rnd = mulberry32(seed), eye = SKYLINE_EYE_ROW;
  tones = tones || SKYLINE_TONES;
  fillRect(img, 0, eye, SKYLINE_W, SKYLINE_H - eye, base);
  const tower = (x, w, rise, tone) => {
    fillRect(img, x, eye - rise, w, rise, tone);
    if (w >= 8 && rnd() < 0.4) {                                  // stepped crown
      const cw = Math.max(2, (w / 2) | 0), cr = Math.min(SKYLINE_MAX_RISE, rise + 2 + ((rnd() * 3) | 0));
      fillRect(img, x + ((w - cw) >> 1), eye - cr, cw, cr - rise, tone);
    } else if (rnd() < 0.25) {                                    // antenna
      const ar = Math.min(SKYLINE_MAX_RISE, rise + 2 + ((rnd() * 3) | 0));
      fillRect(img, x + ((w * rnd()) | 0), eye - ar, 1, ar - rise, tone);
    }
  };
  for (let x = 0; x < SKYLINE_W;) {                               // far layer
    const w = 5 + ((rnd() * 12) | 0), rise = 4 + ((rnd() * 10) | 0);
    tower(x, w, rise, tones.far);
    x += w + (rnd() < 0.35 ? 1 + ((rnd() * 3) | 0) : 0);
  }
  for (let x = (rnd() * 12) | 0; x < SKYLINE_W;) {                // near layer
    const w = 8 + ((rnd() * 14) | 0), rise = 2 + ((rnd() * 6) | 0);
    tower(x, w, rise, tones.near);
    x += w + 6 + ((rnd() * 20) | 0);
  }
  if (lights) {                                                   // distant lit windows: single texels on tower bodies
    const lr = mulberry32((seed ^ 0x5eed) >>> 0);
    for (let y = 0; y < eye - 1; y++) for (let x = 0; x < SKYLINE_W; x++) {
      if (img.data[(y * SKYLINE_W + x) * 4 + 3] && lr() < lights) setPx(img, x, y, SKYLINE_LIGHT);
    }
  }
  return img;
}

// World size of one texel: one render-target pixel at SKYLINE_DEPTH for this preset's fov.
// M2.8 Phase F: preset.skylineDepth (default SKYLINE_DEPTH) puts the plane beyond a bigger scene (the town's outer blocks).
export function skylineDepth(preset) { return preset.skylineDepth || SKYLINE_DEPTH; }
export function skylineTexel(preset) { return (2 * skylineDepth(preset) * Math.tan(preset.fov * Math.PI / 360)) / RT_H; }

export function buildSkyline(preset, seed) {
  const look = SKYLINE_LOOKS[preset.time] || SKYLINE_LOOKS.day;
  const img = flipRows(makeSkylineImage(seed, hexToRgb(preset.haze), look.tones, look.lights));
  const tex = new DataTexture(img.data, img.width, img.height, RGBAFormat, UnsignedByteType);
  tex.magFilter = tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.needsUpdate = true;
  const s = skylineTexel(preset);
  const geo = new PlaneGeometry(SKYLINE_W * s, SKYLINE_H * s);
  const mat = new MeshBasicMaterial({ map: tex, alphaTest: 0.5, fog: false });
  const mesh = new Mesh(geo, mat);
  mesh.name = 'skyline';
  const lift = (SKYLINE_EYE_ROW - SKYLINE_H / 2) * s;           // plane centre above eye level
  // Keep the plane `depth` ahead of the camera along its heading (camera yaw; the alley's is 0, i.e. straight down -z), facing
  // it, with its eye row at the camera's height. Call after the camera moves.
  const depth = skylineDepth(preset);
  function follow(camera) {
    const yaw = camera.rotation.y;
    mesh.position.set(camera.position.x - depth * Math.sin(yaw), camera.position.y + lift, camera.position.z - depth * Math.cos(yaw));
    mesh.rotation.y = yaw;
    mesh.updateMatrixWorld(true);
  }
  return { mesh, texture: tex, texel: s, depth, follow, dispose() { geo.dispose(); mat.dispose(); tex.dispose(); } };
}
