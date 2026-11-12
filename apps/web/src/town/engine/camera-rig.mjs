// Pitched perspective follow camera (M2.7 §3.2). The player cannot rotate it; pitch/distance/fov come from
// the scene preset. The camera looks along +/-Z (alley runs along Z, far end at -Z).
import { PerspectiveCamera } from 'three';
import { RT_W, RT_H } from './pipeline-core.mjs';

const DEG = Math.PI / 180;

// World units covered by one render-target pixel at the focus depth (distance along the view axis).
export function pixelWorldSize(preset) {
  return (2 * preset.distance * Math.tan(preset.fov * DEG / 2)) / RT_H;
}

// Snap a ground-plane focus point to the render-target pixel grid along the view plane: X steps are one
// pixel wide; Z steps are one pixel tall, and a ground step of dz moves the focus dz*sin(pitch) on screen.
export function snapFocus(x, z, preset) {
  const px = pixelWorldSize(preset);
  const pz = px / Math.sin(preset.pitchDeg * DEG);
  return [Math.round(x / px) * px, Math.round(z / pz) * pz];
}

// snapFocus in the camera's ground basis: right = (cos yaw, sin yaw), forward = (sin yaw, -cos yaw) (camera-rig yaw convention).
export function snapFocusYaw(x, z, preset, yawRad) {
  if (!yawRad) return snapFocus(x, z, preset);
  const px = pixelWorldSize(preset), pv = px / Math.sin(preset.pitchDeg * DEG);
  const c = Math.cos(yawRad), s = Math.sin(yawRad);
  const u = Math.round((x * c + z * s) / px) * px, v = Math.round((x * s - z * c) / pv) * pv;
  return [u * c + v * s, u * s - v * c];
}

// Vertical NDC position of the horizon (+1 = top edge of the frame). > 1 means the horizon is above the frame.
export function horizonNdcY(preset) {
  return Math.tan(preset.pitchDeg * DEG) / Math.tan(preset.fov * DEG / 2);
}

// M2.8 Phase F: `yaw` (degrees, TownWorld's convention: 0 looks north (-z), 180 looks south) turns the camera about the focus,
// and preset.far (default 80) sets the far plane. The alley never sets a yaw, so its camera is unchanged.
export function createCameraRig(preset) {
  const camera = new PerspectiveCamera(preset.fov, RT_W / RT_H, 0.5, preset.far || 80);
  camera.rotation.order = 'YXZ';                 // yaw about the world up, then pitch (identical to XYZ while yaw is 0)
  const pitch = preset.pitchDeg * DEG;
  let fx = 0, fz = 0, primed = false, yaw = 0;

  function snapTo(x, z) { fx = x; fz = z; primed = true; }
  function setYaw(deg) { yaw = (+deg || 0) * DEG; }
  // M2.9.1: the camera is LOCKED to its target by default (preset.followTime 0), as in the DS games: with the old 0.15 s
  // damping the snapped camera crept after the guide in irregular 1-pixel steps (accelerating, then settling), which read as
  // stutter on a 120 Hz display. preset.followTime > 0 restores exponential damping with that time constant.
  const followRate = preset.followTime > 0 ? 1 / preset.followTime : 0;
  function update(dtSec, x, z) {
    if (!primed || !followRate) { snapTo(x, z); return; }
    const a = 1 - Math.exp(-followRate * Math.max(0, dtSec));
    fx += (x - fx) * a;
    fz += (z - fz) * a;
  }
  // Writes the snapped camera transform. Focus = target lifted by heightOffset; camera sits `distance` away
  // on the +Z side at `pitch` above the horizontal, looking at the focus.
  // M2.9.1: snap in the camera's own ground axes (right, forward), not world x / z. With the town's 20 degree yaw offset a
  // world-z snap step (px / sin(pitch) = 0.4 units at pitch 9) projected 2 render pixels sideways, so the street jumped
  // 2 px every ~6 frames while walking ("lag"). At yaw 0 the two are identical.
  function apply() {
    const s = snapFocusYaw(fx, fz, preset, yaw);
    const back = preset.distance * Math.cos(pitch);
    camera.position.set(
      s[0] - back * Math.sin(yaw),
      preset.heightOffset + preset.distance * Math.sin(pitch),
      s[1] + back * Math.cos(yaw)
    );
    camera.rotation.set(-pitch, -yaw, 0);
    camera.updateMatrixWorld(true);
    return s;
  }
  return { camera, snapTo, setYaw, update, apply, get focus() { return [fx, fz]; }, get yawDeg() { return yaw / DEG; } };
}
