// Alley scene: banded sky gradient, fog, one textured ground plane, the buildings/props, and the far skyline (M2.8 Phase A).
import {
  Scene, Fog, Mesh, PlaneGeometry, MeshBasicMaterial, DataTexture, RGBAFormat, UnsignedByteType,
  NearestFilter, RepeatWrapping, ClampToEdgeWrapping, Color
} from 'three';
import { TILE_PX, makeGroundTileRGBA } from './ground.mjs';
import { buildAlleyMeshes, rgbColor } from './alley-meshes.mjs';
import { buildSkyline } from './skyline.mjs';

export const GROUND_W = 48;             // world units (x in [-24, 24])
export const GROUND_L = 440;            // world units (z in [-412, 28]): street + camera near edge + fogged run-out to the horizon
export const GROUND_CENTER_Z = -192;
export const GROUND_Y = -1 / 128;
const SKY_ROWS = 48;
const SKY_STEPS = 6;                    // visible gradient bands

function hexToRgb(h) { return [(h >> 16) & 255, (h >> 8) & 255, h & 255]; }

// 1 x rows screen-space gradient, row 0 = bottom. Haze at/below the horizon (horizonV in 0..1 of frame height,
// >1 = horizon above the frame => all haze), ramping to sky at the top in `steps` hard bands.
export function makeSkyGradientRGBA(sky, haze, rows, horizonV, steps) {
  const a = hexToRgb(sky), b = hexToRgb(haze); // raw sRGB bytes; independent of three's ColorManagement flag
  const out = new Uint8Array(rows * 4);
  const span = Math.max(1e-6, 1 - horizonV);
  for (let i = 0; i < rows; i++) {
    const v = (i + 0.5) / rows;
    const raw = Math.min(1, Math.max(0, (v - horizonV) / span));
    const t = Math.round(raw * steps) / steps; // 0 = haze, 1 = sky
    out[i * 4] = Math.round(b[0] + (a[0] - b[0]) * t);
    out[i * 4 + 1] = Math.round(b[1] + (a[1] - b[1]) * t);
    out[i * 4 + 2] = Math.round(b[2] + (a[2] - b[2]) * t);
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function buildAlleyScene(preset, seed, horizonNdcY) {
  const scene = new Scene();
  scene.fog = new Fog(rgbColor([(preset.haze >> 16) & 255, (preset.haze >> 8) & 255, preset.haze & 255]), preset.fogNear, preset.fogFar);

  const horizonV = ((horizonNdcY == null ? 99 : horizonNdcY) + 1) / 2;
  const sky = new DataTexture(makeSkyGradientRGBA(preset.sky, preset.haze, SKY_ROWS, horizonV, SKY_STEPS), 1, SKY_ROWS, RGBAFormat, UnsignedByteType);
  sky.magFilter = sky.minFilter = NearestFilter;
  sky.generateMipmaps = false;
  sky.wrapS = sky.wrapT = ClampToEdgeWrapping;
  sky.needsUpdate = true;
  scene.background = sky;

  const tile = new DataTexture(makeGroundTileRGBA(seed == null ? 1 : seed), TILE_PX, TILE_PX, RGBAFormat, UnsignedByteType);
  tile.magFilter = tile.minFilter = NearestFilter;
  tile.generateMipmaps = false;
  tile.wrapS = tile.wrapT = RepeatWrapping;
  tile.repeat.set(GROUND_W, GROUND_L); // 1 world unit = 1 tile = 16 texels
  tile.needsUpdate = true;

  const groundGeo = new PlaneGeometry(GROUND_W, GROUND_L);
  const gt = preset.groundTint || [1, 1, 1];             // time-of-day material tint (presets.mjs TIME_PRESETS)
  const groundMat = new MeshBasicMaterial({ map: tile, color: new Color().setRGB(gt[0], gt[1], gt[2]) });
  const ground = new Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  // M2.8 Phase C: the street's road/pavement planes lie at y = 0 over |x| <= 3; the paver ground sits 1/128 below so the two
  // never z-fight. It still shows beyond the street (under the far-end run-out).
  ground.position.set(0, GROUND_Y, GROUND_CENTER_Z);
  scene.add(ground);
  const meshes = buildAlleyMeshes(seed == null ? 1 : seed, preset.tint ? preset : undefined);
  scene.add(meshes.group);
  const skyline = buildSkyline(preset, seed == null ? 1 : seed);
  scene.add(skyline.mesh);

  return {
    scene, ground, groundTexture: tile, skyTexture: sky, meshes, skyline,
    dispose() { groundGeo.dispose(); groundMat.dispose(); tile.dispose(); sky.dispose(); meshes.dispose(); skyline.dispose(); }
  };
}
