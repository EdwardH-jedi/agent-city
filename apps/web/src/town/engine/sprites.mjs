// Camera-facing sprites on the atlas (M2.7 §3.5). Depth sorting is the WebGL depth buffer (alphaTest cut-outs),
// so M2's manual z-buffer/occlusion code is not used. Hop lift and shadow are baked into the frame art: the
// sprite pivot is the ground point, never lifted. After projection the feet are snapped to whole
// render-target pixels.
import {
  Sprite, SpriteMaterial, Vector3, Mesh, PlaneGeometry, MeshBasicMaterial, DataTexture, RGBAFormat, UnsignedByteType,
  NearestFilter, ClampToEdgeWrapping
} from 'three';
import { RT_W, RT_H } from './pipeline-core.mjs';
import { CELL_W, CELL_H, makeAtlasTexture } from './sprite-atlas.mjs';

const DEG = Math.PI / 180;
export const PLAYER_PX_PER_TEXEL = 2;     // the player is drawn at exactly 2 render pixels per texel

// M2.8 Phase E NPC shadow: a flat ellipse on the ground (not a billboard), 12 x 6 texels at 16 texels per unit, black at
// a fixed 45 % opacity, hard-edged (alpha 0 or 255, nearest filter). It lies 1/64 above the street planes (y 0) and fogs
// with the ground. Its centre is where the camera ray through the pixel-snapped foot meets that plane, so it never
// drifts against the snapped sprite. The kangaroo keeps the shadow baked into its frames, so it gets none.
export const SHADOW = Object.freeze({ w: 12, h: 6, texelsPerUnit: 16, y: 1 / 64, opacity: 0.45 });
export function makeShadowRGBA() {
  const { w, h } = SHADOW, out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = (x + 0.5 - w / 2) / (w / 2), v = (y + 0.5 - h / 2) / (h / 2);
    if (u * u + v * v <= 1) out[(y * w + x) * 4 + 3] = 255;   // rgb stays 0: black
  }
  return out;
}

// World position whose foot projects onto the nearest whole render-target pixel, at the same view depth.
export function snapToPixel(camera, pos, out) {
  const ndc = pos.clone().project(camera);
  const px = Math.round((ndc.x * 0.5 + 0.5) * RT_W), py = Math.round((ndc.y * 0.5 + 0.5) * RT_H);
  ndc.x = (px / RT_W) * 2 - 1;
  ndc.y = (py / RT_H) * 2 - 1;
  return (out || new Vector3()).copy(ndc).unproject(camera);
}

// Projected render-target pixel coordinates of a world point (origin bottom-left, pixel edges at integers).
export function toPixels(camera, pos) {
  const n = pos.clone().project(camera);
  return [(n.x * 0.5 + 0.5) * RT_W, (n.y * 0.5 + 0.5) * RT_H];
}

// World size of one render-target pixel at a given view-space depth.
export function worldPerPixel(camera, depth) { return (2 * depth * Math.tan(camera.fov * DEG / 2)) / RT_H; }

// tint: optional [r, g, b] material colour multiplier (M2.8 Phase D time of day); the frames themselves are never redrawn.
// opts (M2.8 Phase F, the town): playerPxPerTexel (default PLAYER_PX_PER_TEXEL) and frameFor(actor) -> frame for keys that
// are not in the atlas (TownWorld agents, whose looks arrive at runtime); such a frame carries its own `texture`.
export function createActorLayer(scene, atlas, tint, opts) {
  opts = opts || {};
  const playerPx = opts.playerPxPerTexel || PLAYER_PX_PER_TEXEL;
  const texture = makeAtlasTexture(atlas);
  const sprites = new Map();          // id -> {sprite, material, map, shadow (Mesh, NPCs only)}
  const tmp = new Vector3(), snapped = new Vector3(), eye = new Vector3(), camUp = new Vector3(), fwd = new Vector3(), pt = new Vector3();
  // One shadow geometry/material/texture shared by every NPC shadow mesh.
  const shadowTex = new DataTexture(makeShadowRGBA(), SHADOW.w, SHADOW.h, RGBAFormat, UnsignedByteType);
  shadowTex.magFilter = shadowTex.minFilter = NearestFilter;
  shadowTex.generateMipmaps = false;
  shadowTex.wrapS = shadowTex.wrapT = ClampToEdgeWrapping;
  shadowTex.needsUpdate = true;
  const shadowGeo = new PlaneGeometry(SHADOW.w / SHADOW.texelsPerUnit, SHADOW.h / SHADOW.texelsPerUnit);
  shadowGeo.rotateX(-Math.PI / 2);   // flat on the ground: width along x, height along z
  const shadowMat = new MeshBasicMaterial({ map: shadowTex, transparent: true, opacity: SHADOW.opacity, depthWrite: false, depthTest: true });
  function ensureShadow(s, id) {
    if (s.shadow) return s.shadow;
    s.shadow = new Mesh(shadowGeo, shadowMat);
    s.shadow.name = 'shadow:' + id;
    scene.add(s.shadow);
    return s.shadow;
  }
  // Point at height y on the camera ray through p (p is the snapped foot, a hair off the ground).
  function onGroundUnder(camera, p, y, out) {
    eye.setFromMatrixPosition(camera.matrixWorld);
    const t = (y - eye.y) / (p.y - eye.y);
    return out.set(eye.x + (p.x - eye.x) * t, y, eye.z + (p.z - eye.z) * t);
  }

  // M2.8 Phase G, opts.upright (the interior): under a steep camera (pitch 55) a camera-facing sprite leans back into whatever
  // stands behind the actor, and a desk behind a seated agent comes out nearer the camera than the agent's feet and cuts
  // through it. Upright actors are vertical quads standing at the feet (TownWorld's rule: billboards are depth-tested
  // against a vertical plane at the feet), turned to the camera's heading, their height scaled by 1/cos(pitch) so they
  // cover the same screen rows as a camera-facing sprite. Off by default: the alley and the town are unchanged.
  const upright = !!opts.upright;
  const uprightGeo = upright ? new PlaneGeometry(1, 1).translate(0, 0.5, 0) : null;   // pivot at the bottom centre
  function ensure(id) {
    let s = sprites.get(id);
    if (s) return s;
    const map = texture.clone();      // shares the image source; own offset/repeat
    map.needsUpdate = true;
    const material = upright ? new MeshBasicMaterial({ map, alphaTest: 0.5, transparent: false, depthWrite: true, depthTest: true })
      : new SpriteMaterial({ map, alphaTest: 0.5, transparent: false, depthWrite: true, depthTest: true });
    if (tint) material.color.setRGB(tint[0], tint[1], tint[2]);
    const sprite = upright ? new Mesh(uprightGeo, material) : new Sprite(material);
    sprite.name = 'actor:' + id;
    scene.add(sprite);
    s = { sprite, material, map };
    sprites.set(id, s);
    return s;
  }
  function setFrame(s, frame) {
    if (frame.texture) {                // a runtime frame with its own 32 x 40 texture (shared by every sprite showing it)
      s.material.map = frame.texture;
    } else {
      s.material.map = s.map;
      s.map.offset.set(frame.u0, frame.v0);
      s.map.repeat.set(frame.u1 - frame.u0, frame.v1 - frame.v0);
    }
    if (upright) { s.cx = frame.cx; s.cy = frame.cy; } else s.sprite.center.set(frame.cx, frame.cy);
  }

  // actors: [{id, x, z, y (ground height, default 0), key, lockedScale, shadow}]. Returns debug rows with the final integer
  // pixel position.
  function sync(camera, actors) {
    camera.updateMatrixWorld(true);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    const live = new Set(), rows = [];
    for (const a of actors) {
      const frame = atlas.frames.get(a.key) || (opts.frameFor && opts.frameFor(a));
      if (!frame) throw new Error('actor frame not in atlas: ' + a.key);
      const s = ensure(a.id);
      live.add(a.id);
      setFrame(s, frame);
      tmp.set(a.x, a.y || 0, a.z);
      snapToPixel(camera, tmp, snapped);
      s.sprite.position.copy(snapped);
      s.sprite.visible = true;
      const depth = -tmp.clone().applyMatrix4(camera.matrixWorldInverse).z;
      if (a.lockedScale) {
        const k = playerPx * worldPerPixel(camera, depth);
        s.sprite.scale.set(CELL_W * k, CELL_H * k, 1);
      } else {
        s.sprite.scale.set(CELL_W / 16, CELL_H / 16, 1);   // 1 world unit = 16 texels
      }
      const screenH = s.sprite.scale.y;
      if (upright) {                     // vertical quad covering exactly the screen rows the camera-facing sprite would
        const yaw = camera.rotation.y, sx = s.sprite.scale.x, ox = (0.5 - s.cx) * sx;
        eye.setFromMatrixPosition(camera.matrixWorld);
        camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
        camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
        // the camera-facing sprite's top / bottom edge points, carried along the eye ray onto the vertical plane at the foot
        const onPlane = (k) => { pt.copy(snapped).addScaledVector(camUp, k).sub(eye); return eye.y + pt.y * (snapped.clone().sub(eye).dot(fwd) / pt.dot(fwd)); };
        const yTop = onPlane(screenH * (1 - s.cy)), yBot = onPlane(-screenH * s.cy);
        s.sprite.scale.y = yTop - yBot;
        s.sprite.rotation.set(0, yaw, 0);
        s.sprite.position.set(snapped.x + ox * Math.cos(yaw), yBot, snapped.z - ox * Math.sin(yaw));
      }
      if (a.shadow) {
        const sh = ensureShadow(s, a.id);
        onGroundUnder(camera, snapped, (a.y || 0) + SHADOW.y, sh.position);
        sh.visible = true;
      } else if (s.shadow) s.shadow.visible = false;
      const px = toPixels(camera, snapped);
      rows.push({ id: a.id, key: a.key, px: px[0], py: px[1], depth, heightPx: screenH / worldPerPixel(camera, depth), shadow: !!a.shadow });
    }
    sprites.forEach((s, id) => { if (!live.has(id)) { s.sprite.visible = false; if (s.shadow) s.shadow.visible = false; } });
    return rows;
  }
  function dispose() {
    sprites.forEach((s) => { scene.remove(s.sprite); if (s.shadow) scene.remove(s.shadow); s.material.dispose(); s.map.dispose(); });
    sprites.clear();
    texture.dispose();
    shadowGeo.dispose(); shadowMat.dispose(); shadowTex.dispose();
    if (uprightGeo) uprightGeo.dispose();
  }
  return { sync, dispose, sprites, texture };
}
