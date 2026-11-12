// Orbit follow camera for the ring town (M3.0 §1.3). Same surface as camera-rig.mjs's createCameraRig (camera, snapTo,
// setYaw, update, apply, focus, yawDeg) plus yawFor / mode: on the ring the camera looks along the guide's direction of
// travel, so walking the curve turns the view and the world scrolls rotationally (the DS games' street camera) instead of
// sliding sideways in whole-pixel steps (the M2.9 plaza stutter). Inside the inner pavement (the plaza) the yaw freezes
// and the pitch rises 6 degrees so the leaderboard pylon stays in frame. Either way the view turns only as far as it must
// to keep the camera out of the lots (clearance, below).
// The ring layout is passed in (renderer/ring-layout.mjs's exports: A, B, ellipseTheta, ellipseOffset), so this module
// imports nothing from lane A. No DOM, no GL: testable in plain Node.
import { PerspectiveCamera } from 'three';
import { RT_W, RT_H } from './pipeline-core.mjs';
import { snapFocusYaw } from './camera-rig.mjs';

const DEG = Math.PI / 180;

export const TURN_RATE_DEG = 90;     // §1.3: the rig turns toward its target yaw at most this fast (deg/s), never past it
export const DIR_FLIP_S = 0.4;       // §1.3: travel against `dir` must last longer than this before `dir` flips
export const DIR_DEADZONE = 0.5;     // u/s: tangential speeds below this neither run nor reset the flip timer (standing, crossing)
export const PLAZA_OFFSET = -4.5;    // §1.3: ellipseOffset below this (inside the inner pavement) is plaza mode
export const PLAZA_EXIT = -4.25;     // back to orbit only above this: a 0.25-unit band so the pavement edge does not flicker
export const PLAZA_PITCH_DEG = 6;    // §1.3: plaza pitch = preset pitch + 6 ...
export const PLAZA_PITCH_S = 0.5;    // ... reached in 0.5 s (linear), and back at the same rate
export const TELEPORT_U = 2;         // a jump longer than this between updates is a teleport (door, enter(at)), not a velocity
export const CAM_CLEAR = 0.75;       // the camera's ground point stays this far inside the outer pavement edge (the lot fronts)
export const PLAZA_SIDE_KEEP = 10;   // plaza clearance turns the way it turned last unless the other way is 10 degrees shorter

// Yaw convention (camera-rig.mjs, TownWorld): degrees, 0 looks north (-z), 90 looks east (+x), 180 south, -90 west.
// forward = (sin yaw, -cos yaw) is "up" on screen; right = (cos yaw, sin yaw). Lane A's setViewYaw rotates input with these.
export function yawOfDir(dx, dz) { return Math.atan2(dx, -dz) / DEG; }
export function forwardOf(yawDeg) { const r = yawDeg * DEG; return [Math.sin(r), -Math.cos(r)]; }
export function rightOf(yawDeg) { const r = yawDeg * DEG; return [Math.cos(r), Math.sin(r)]; }
// Signed shortest turn from a to b in degrees, in (-180, 180].
export function turnBetween(a, b) { const d = ((b - a) % 360 + 540) % 360 - 180; return d === -180 ? 180 : d; }

// Unit tangent of the ring's centre-line ellipse at the guide, pointing clockwise (increasing theta, §1.1).
export function tangentAt(layout, x, z) {
  const t = layout.ellipseTheta(x, z), tx = -layout.A * Math.sin(t), tz = layout.B * Math.cos(t), n = Math.hypot(tx, tz);
  return [tx / n, tz / n];
}

// Ground-plane snap steps (world units) that move the ground under the guide's feet by exactly one render pixel, in the
// camera's own axes: `lateral` along right, `forward` along forward. The guide is drawn at the snapped focus, so its feet and
// the texels it stands on move together in whole pixels. (camera-rig.mjs's px / sin(pitch) forward step moves the lifted
// look-at point 1 px; with heightOffset 7 that is 3.1 px at the feet and 1.8 px six units ahead: status/DECISIONS.md #110.)
export function snapSteps(preset, pitchDeg) {
  const p = (pitchDeg == null ? preset.pitchDeg : pitchDeg) * DEG, f = (RT_H / 2) / Math.tan(preset.fov * DEG / 2);
  const h = preset.heightOffset + preset.distance * Math.sin(p), back = preset.distance * Math.cos(p);   // camera above / behind the feet
  const below = Math.atan2(h, back) - p;                        // feet angle below the view axis
  const depth = back * Math.cos(p) + h * Math.sin(p);           // feet depth along the view axis
  const rowsPerUnit = f * h / ((back * back + h * h) * Math.cos(below) ** 2);
  return { lateral: depth / f, forward: 1 / rowsPerUnit };
}

// layout: ring-layout.mjs (or anything with A, B, ellipseTheta(x, z) in radians, ellipseOffset(x, z)).
// opts.snap: 'feet' (default, above) | 'none' (continuous; evidence only) | 'world' (camera-rig's snapFocusYaw grid anchored
// at the world origin; the M2.9.1 rig, kept only as the judder test's negative control).
export function createOrbitRig(preset, layout, opts) {
  const snapMode = (opts && opts.snap) || 'feet';
  const camera = new PerspectiveCamera(preset.fov, RT_W / RT_H, 0.5, preset.far || 80);
  camera.rotation.order = 'YXZ';                 // yaw about the world up, then pitch (as camera-rig)
  const basePitch = preset.pitchDeg, plazaPitch = basePitch + (preset.plazaPitchDeg != null ? preset.plazaPitchDeg : PLAZA_PITCH_DEG);
  const pitchRate = Math.abs(plazaPitch - basePitch) / PLAZA_PITCH_S;
  let fx = 0, fz = 0, sx = 0, sz = 0, primed = false;   // raw focus (the guide) and the snapped focus
  let along = 0, gx = 0, gz = 0, snapRoad = false;      // road snap: residual along the tangent, guide at the last snap
  let yaw = 0, target = null, pitch = basePitch;        // yaw is unwrapped (continuous); target: one-shot setYaw
  let dir = 1, against = 0, mode = 'orbit';             // +1 clockwise (spawn walks west at theta 90), seconds against dir
  let frozen = 0, side = 0;                             // plaza: the frozen yaw, and the way clearance last turned it
  let way = 0;                                          // sign of a turn over 90 degrees in progress (0: none)
  const camLimit = (layout.OUTER_EDGE != null ? layout.OUTER_EDGE : 4.5) - CAM_CLEAR;

  const modeAt = (x, z, cur) => (layout.ellipseOffset(x, z) < (cur === 'plaza' ? PLAZA_EXIT : PLAZA_OFFSET) ? 'plaza' : 'orbit');
  const tangentYaw = (x, z, d) => { const t = tangentAt(layout, x, z); return yawOfDir(d * t[0], d * t[1]); };
  // The direction whose tangent yaw is closest to the current yaw (leaving the plaza: turn the least).
  const nearestDir = (x, z) => { const t = tangentAt(layout, x, z), f = forwardOf(yaw); return t[0] * f[0] + t[1] * f[1] < 0 ? -1 : 1; };

  // Clearance (status/DECISIONS.md #119): 17.45 units behind the guide, a camera looking along the tangent stands on the
  // tangent line, which leaves a convex curve outward, into the lots (8 of 24 centre-line angles, 18 of 24 on the outer
  // pavement). The view turns the least that keeps the camera's ground point at ellipseOffset <= OUTER_EDGE - CAM_CLEAR.
  const camOffset = (x, z, y) => {
    const back = preset.distance * Math.cos(pitch * DEG), r = y * DEG;
    return layout.ellipseOffset(x - back * Math.sin(r), z + back * Math.cos(r));
  };
  // Smallest turn (degrees, >= 0) the way of `s` (+1 = yaw up) that clears; 1-degree scan, then bisection to 0.01.
  function clearTurn(x, z, base, s) {
    if (camOffset(x, z, base) <= camLimit) return 0;
    let lo = 0, hi = -1;
    for (let a = 1; a <= 180; a++) if (camOffset(x, z, base + s * a) <= camLimit) { lo = a - 1; hi = a; break; }
    if (hi < 0) return Infinity;
    while (hi - lo > 0.01) { const m = (lo + hi) / 2; if (camOffset(x, z, base + s * m) <= camLimit) hi = m; else lo = m; }
    return hi;
  }
  // On the ring the view turns toward the outward normal (the camera swings inward, over the road).
  function clearRing(x, z, base) {
    const t = tangentAt(layout, x, z), r = rightOf(base), s = t[1] * r[0] - t[0] * r[1] >= 0 ? 1 : -1;   // normal = (t.z, -t.x)
    return base + s * clearTurn(x, z, base, s);
  }
  // In the plaza either way round, keeping the way it turned last unless the other is PLAZA_SIDE_KEEP shorter.
  function clearPlaza(x, z, base, prefer) {
    const up = clearTurn(x, z, base, 1);
    if (up === 0) return { yaw: base, side: 0 };
    const down = clearTurn(x, z, base, -1);
    let s = up <= down ? 1 : -1;
    if (prefer && (prefer > 0 ? up : down) < (prefer > 0 ? down : up) + PLAZA_SIDE_KEEP) s = prefer;
    return { yaw: base + s * (s > 0 ? up : down), side: s };
  }

  // The yaw the rig turns toward at the guide: on the ring the tangent in the current travel direction, inside the plaza
  // the frozen yaw, each turned only as far as clearance needs. Takes (x, z) or {x, z}.
  function yawFor(x, z) {
    if (x && typeof x === 'object') { z = x.z; x = x.x; }
    return modeAt(x, z, mode) === 'plaza' ? clearPlaza(x, z, mode === 'plaza' ? frozen : yaw, side).yaw : clearRing(x, z, tangentYaw(x, z, dir));
  }
  // Teleport (scene entry, door return): focus, yaw and pitch jump to where the guide stands; the travel direction is kept.
  function snapTo(x, z) {
    fx = sx = x; fz = sz = z; primed = true; against = 0; target = null; snapRoad = false; way = 0;
    const was = mode;
    mode = modeAt(x, z, 'orbit');
    pitch = mode === 'plaza' ? plazaPitch : basePitch;
    if (mode === 'orbit') yaw = clearRing(x, z, tangentYaw(x, z, dir));
    else { if (was !== 'plaza') frozen = yaw; const c = clearPlaza(x, z, frozen, 0); yaw = c.yaw; side = c.side; }
  }
  // Target yaw for the next update (turned toward at TURN_RATE_DEG, cleared like yawFor). Ignored in the plaza: frozen there.
  function setYaw(deg) { target = +deg || 0; }
  function snapYaw(deg) { yaw = frozen = +deg || 0; target = null; side = 0; }

  function trackDir(dt, x, z) {
    const t = tangentAt(layout, x, z), vt = ((x - fx) * t[0] + (z - fz) * t[1]) / dt;
    if (vt * dir < -DIR_DEADZONE) { against += dt; if (against > DIR_FLIP_S) { dir = -dir; against = 0; } }
    else if (vt * dir > DIR_DEADZONE) against = 0;
  }
  // Camera locked to the guide (no damping, M2.9.2); dt drives the direction timer, the turn and the pitch ramp.
  function update(dtSec, x, z) {
    if (!primed) { snapTo(x, z); return; }
    const dt = Math.max(0, +dtSec || 0), jump = Math.hypot(x - fx, z - fz);
    const m = modeAt(x, z, mode);
    if (m === 'orbit' && mode === 'orbit' && dt > 0 && jump <= TELEPORT_U) trackDir(dt, x, z);
    else if (jump > TELEPORT_U) against = 0;
    if (m !== mode) {
      if (m === 'orbit') dir = nearestDir(x, z); else { frozen = yaw; side = 0; }
      mode = m; against = 0;
    }
    fx = x; fz = z;
    const pt = mode === 'plaza' ? plazaPitch : basePitch;
    pitch += Math.max(-pitchRate * dt, Math.min(pitchRate * dt, pt - pitch));
    let want;
    if (mode === 'plaza') { const c = clearPlaza(x, z, frozen, side); want = c.yaw; side = c.side; }
    else want = clearRing(x, z, target != null ? target : tangentYaw(x, z, dir));
    target = null;
    // Turns over 90 degrees (a direction flip, a plaza clearance switching sides) go the way round on which the camera
    // stays clear (on the ring: swinging over the road and the plaza, not through the lots), held until the turn is done.
    const cap = TURN_RATE_DEG * dt, d = turnBetween(yaw, want);
    let step = d;
    if (way || Math.abs(d) > 90) {
      if (!way) way = pathClear(x, z, yaw, d) || !pathClear(x, z, yaw, d - 360 * Math.sign(d)) ? Math.sign(d) : -Math.sign(d);
      step = Math.sign(d) === way || d === 0 ? d : d - 360 * Math.sign(d);
    }
    if (Math.abs(step) <= cap) way = 0;
    yaw += Math.max(-cap, Math.min(cap, step));
  }
  function pathClear(x, z, from, delta) {
    for (let k = 1; k < 8; k++) if (camOffset(x, z, from + delta * k / 8) > camLimit) return false;
    return true;
  }

  // Snapped focus (status/DECISIONS.md #110-#111). Never a grid fixed in the world: turning with the camera, such a grid
  // re-rounds the focus every frame while the yaw changes (the M2.9.1 snapFocusYaw rig, opts.snap 'world').
  //  - ring (orbit): road coordinates. Along the road the focus trails or leads the guide by a residual `along` that is
  //    reduced in whole forward steps; across the road it sits on an absolute grid of ellipseOffset. Walking a line of
  //    constant offset never steps sideways (camera-axes steps did, ~1 per 4 s: tangent lines lie outside the curve), and
  //    crossing the road steps one pixel at a time.
  //  - plaza (yaw frozen, pure translation): whole steps along the camera axes, from the previous snapped focus.
  // Idempotent: a second call without a new guide position moves nothing.
  function snap() {
    if (snapMode === 'none') { sx = fx; sz = fz; return [sx, sz]; }
    if (snapMode === 'world') {
      const s = snapFocusYaw(fx, fz, pitch === preset.pitchDeg ? preset : Object.assign({}, preset, { pitchDeg: pitch }), yaw * DEG);
      sx = s[0]; sz = s[1];
      return s;
    }
    const st = snapSteps(preset, pitch);
    if (mode === 'orbit') {
      const t = tangentAt(layout, fx, fz), w = layout.ellipseOffset(fx, fz), dw = Math.round(w / st.lateral) * st.lateral - w;
      along = snapRoad ? along + (fx - gx) * t[0] + (fz - gz) * t[1] : (fx - sx) * t[0] + (fz - sz) * t[1];
      along -= Math.round(along / st.forward) * st.forward;
      sx = fx - along * t[0] + dw * t[1];                        // outward normal = (t.z, -t.x)
      sz = fz - along * t[1] - dw * t[0];
    } else {
      const r = yaw * DEG, c = Math.cos(r), s = Math.sin(r), dx = fx - sx, dz = fz - sz;
      const ku = Math.round((dx * c + dz * s) / st.lateral), kv = Math.round((dx * s - dz * c) / st.forward);
      sx += ku * st.lateral * c + kv * st.forward * s;
      sz += ku * st.lateral * s - kv * st.forward * c;
    }
    snapRoad = mode === 'orbit'; gx = fx; gz = fz;
    return [sx, sz];
  }
  // Writes the camera transform from the snapped focus (camera-rig's geometry at the current yaw and pitch) and returns it.
  function apply() {
    const s = snap(), p = pitch * DEG, r = yaw * DEG, back = preset.distance * Math.cos(p);
    camera.position.set(s[0] - back * Math.sin(r), preset.heightOffset + preset.distance * Math.sin(p), s[1] + back * Math.cos(r));
    camera.rotation.set(-p, -r, 0);
    camera.updateMatrixWorld(true);
    return s;
  }
  return {
    camera, snapTo, setYaw, snapYaw, update, apply, yawFor,
    get focus() { return [fx, fz]; }, get yawDeg() { return yaw; }, get pitchDeg() { return pitch; },
    get mode() { return mode; }, get dir() { return dir; },
    debug() { return { mode, dir, against, yaw, frozen, side, pitch, focus: [fx, fz], snapped: [sx, sz], snap: snapMode, camOffset: camOffset(fx, fz, yaw) }; }
  };
}
