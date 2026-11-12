// M3.0 lane B: the ring town's orbit camera (renderer/orbit-camera.mjs, prompts/M30_RING.md §1.3-1.4). Headless: the rig's
// three.js camera and Vector3.project only, no GL. The layout is lane A's renderer/ring-layout.mjs; the preset is the ring
// preset §1.2 asks the integrator for (pitch 9, fov 54, distance 9 / tan 27, heightOffset 7, no yawOffset).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import * as RING from '../ring-layout.mjs';
import {
  createOrbitRig, yawOfDir, forwardOf, turnBetween, tangentAt, snapSteps,
  TURN_RATE_DEG, DIR_FLIP_S, PLAZA_OFFSET, PLAZA_EXIT, PLAZA_PITCH_DEG, PLAZA_PITCH_S, CAM_CLEAR
} from '../orbit-camera.mjs';
import { createCameraRig } from '../camera-rig.mjs';

const DEG = Math.PI / 180, RT_W = 384, RT_H = 288, SPEED = 4.2;
const PRESET = Object.freeze({ pitchDeg: 9, fov: 54, distance: 9 / Math.tan(27 * DEG), heightOffset: 7, far: 200 });
const CENTRE = RING.arcTable(0);              // arc length along the road's centre line
const at = (s) => { const p = RING.ellipsePoint(CENTRE.at(s)); return [p.x, p.z]; };

// Render-target pixel of a world point (origin top-left, x right, y down) and whether it is in front of the camera.
function project(camera, x, y, z) {
  const v = new Vector3(x, y, z).project(camera);
  return { x: (v.x + 1) / 2 * RT_W, y: (1 - v.y) / 2 * RT_H, front: v.z > -1 && v.z < 1 };
}
const inFrame = (p) => p.front && p.x >= 0 && p.x <= RT_W && p.y >= 0 && p.y <= RT_H;
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b} (±${eps})`);

// Walk the centre line from arc length s at `sign` (+1 clockwise) for `secs` at `hz`; onFrame(rig, sBefore, sAfter).
function walk(rig, s, sign, hz, secs, onFrame) {
  const dt = 1 / hz;
  for (let i = 0; i < Math.round(secs * hz); i++) {
    const s1 = s + sign * SPEED * dt, p = at(s1);
    rig.update(dt, p[0], p[1]);
    rig.apply();
    if (onFrame) onFrame(rig, s, s1);
    s = s1;
  }
  return s;
}
// A rig standing on the centre line at theta (radians) with travel direction `sign`: anticlockwise rigs walk back for 3 s
// first (the flip after 0.4 s, then the 180 degree turn at 90 deg/s) and return to theta by snapTo, which keeps the direction.
function rigAt(theta, sign, opts) {
  const rig = createOrbitRig(PRESET, RING, opts), p = RING.ellipsePoint(theta);
  rig.snapTo(p.x, p.z);
  if (sign < 0) { walk(rig, CENTRE.lenAt(theta), -1, 60, 3); rig.snapTo(p.x, p.z); }
  rig.apply();
  return rig;
}

test('orbit rig surface: camera-rig\'s API plus yawFor / mode; focus is the raw guide, apply() returns the snapped focus', () => {
  const rig = createOrbitRig(PRESET, RING), base = createCameraRig(PRESET);
  for (const k of Object.keys(base)) assert.ok(k in rig, 'createCameraRig key ' + k);
  for (const k of ['yawFor', 'mode', 'snapYaw', 'pitchDeg', 'dir']) assert.ok(k in rig, 'orbit key ' + k);
  rig.update(0, RING.SPAWN.x, RING.SPAWN.z);            // first update primes like snapTo
  assert.deepEqual(rig.focus, [RING.SPAWN.x, RING.SPAWN.z]);
  assert.equal(rig.mode, 'orbit');
  const s = walk(rig, CENTRE.lenAt(RING.SPAWN.theta), 1, 120, 0.37);
  const p = at(s), snapped = rig.apply(), st = snapSteps(PRESET);
  assert.deepEqual(rig.focus, p, 'focus = the guide exactly (pipeline.mjs draws the guide at the snapped focus only then)');
  assert.ok(Math.hypot(snapped[0] - p[0], snapped[1] - p[1]) <= Math.hypot(st.forward, st.lateral) / 2 + 1e-9, 'snapped within half a step');
  assert.deepEqual(rig.apply(), snapped, 'apply() is idempotent');
  assert.equal(rig.yawFor({ x: p[0], z: p[1] }), rig.yawFor(p[0], p[1]), 'yawFor takes (x, z) or {x, z}');
});

test('yaw convention through the real camera: at the spawn (theta 90) walking clockwise the camera looks -x, -x is up', () => {
  const rig = rigAt(RING.SPAWN.theta, 1);
  near(rig.yawDeg, -90, 1e-9, 'spawn yaw');
  near(yawOfDir(-1, 0), -90, 1e-12, 'yawOfDir(-x)');
  const f = forwardOf(rig.yawDeg), g = rig.focus;
  near(f[0], -1, 1e-12, 'forward x'); near(f[1], 0, 1e-12, 'forward z');
  const feet = project(rig.camera, g[0], 0, g[1]), ahead = project(rig.camera, g[0] - 6, 0, g[1]), north = project(rig.camera, g[0], 0, g[1] - 3);
  near(feet.x, RT_W / 2, 1e-6, 'guide on the centre column');
  near(ahead.x, RT_W / 2, 1e-6, 'a point 6 units west stays on the centre column');
  assert.ok(ahead.y < feet.y - 20, `west is up on screen (row ${ahead.y.toFixed(1)} above the feet ${feet.y.toFixed(1)})`);
  assert.ok(north.x > feet.x + 20, 'north (toward the plaza) is to the right when walking clockwise at the south end');
});

// Camera ground point and its ellipseOffset; clearance keeps it <= OUTER_EDGE - CAM_CLEAR (status/DECISIONS.md #119).
const LIMIT = RING.OUTER_EDGE - CAM_CLEAR, BACK = PRESET.distance * Math.cos(PRESET.pitchDeg * DEG);
const tangentCamOffset = (x, z, yaw) => { const f = forwardOf(yaw); return RING.ellipseOffset(x - BACK * f[0], z - BACK * f[1]); };
const camOffsetOf = (rig) => RING.ellipseOffset(rig.camera.position.x, rig.camera.position.z);

test('tangent yaw at 8 angles, both directions: the view follows the direction of travel, turned only for clearance', () => {
  const cardinal = { 0: 180, 90: -90, 180: 0, 270: 90 };   // clockwise: south at the east end, west at the south end, ...
  let straight = 0, turned = 0;
  for (const sign of [1, -1]) {
    for (let deg = 0; deg < 360; deg += 45) {
      const th = deg * DEG, p = RING.ellipsePoint(th), t = RING.ellipseTangent(th), tyaw = yawOfDir(sign * t.x, sign * t.z);
      const tt = tangentAt(RING, p.x, p.z);                // the rig's tangent is lane A's
      near(tt[0], t.x, 1e-9, 'tangent x'); near(tt[1], t.z, 1e-9, 'tangent z');
      if (deg in cardinal) near(turnBetween(tyaw, sign > 0 ? cardinal[deg] : cardinal[deg] + 180), 0, 1e-9, `cardinal ${deg} sign ${sign}`);
      const rig = rigAt(th, sign), alpha = turnBetween(tyaw, rig.yawDeg), tag = `${deg} deg sign ${sign}`;
      assert.equal(rig.dir, sign, 'dir ' + tag);
      assert.equal(rig.mode, 'orbit');
      near(turnBetween(rig.yawFor(p.x, p.z), rig.yawDeg), 0, 1e-9, 'yawFor = the rig yaw at rest ' + tag);
      if (tangentCamOffset(p.x, p.z, tyaw) <= LIMIT) { near(alpha, 0, 1e-9, 'exactly the tangent ' + tag); straight++; }
      else {                                               // turned toward the outside, so the camera swings in over the road
        const n = RING.ellipseNormal(th), f = forwardOf(rig.yawDeg);
        assert.ok(f[0] * n.x + f[1] * n.z > 0, 'turned outward ' + tag);
        assert.ok(Math.abs(alpha) > 0 && Math.abs(alpha) <= 30, `turned ${alpha} at ${tag}`);
        near(camOffsetOf(rig), LIMIT, 0.02, 'just enough: camera on the clearance line ' + tag);
        turned++;
      }
      // The rendered view: the road 6 units ahead in the direction of travel is above the guide, near the centre column.
      const s = CENTRE.lenAt(th), q = at(s + sign * 6), feet = project(rig.camera, p.x, 0, p.z), ahead = project(rig.camera, q[0], 0, q[1]);
      assert.ok(ahead.front && ahead.y < feet.y - 20, `road ahead is up at ${tag}`);
      assert.ok(Math.abs(ahead.x - RT_W / 2) < 60, `road ahead near the centre column at ${tag}: ${ahead.x.toFixed(1)}`);
    }
  }
  assert.ok(straight >= 4 && turned >= 4, `straight ${straight}, turned ${turned}`);
});

test('clearance: the camera never stands in a lot (anywhere walkable, both directions, the plaza, and walking laps with flips)', () => {
  const lots = RING.LOTS.map((l) => RING.lotRect(l));
  let maxOff = -Infinity, checks = 0;
  const check = (rig, tag) => {
    const c = rig.camera.position, o = RING.ellipseOffset(c.x, c.z);
    assert.ok(o <= LIMIT + 0.1, `${tag}: camera at offset ${o.toFixed(3)}`);
    for (const r of lots) assert.ok(RING.obbDistance(r, c.x, c.z) > 0.5, `${tag}: camera in or at ${r.lot}`);
    maxOff = Math.max(maxOff, o); checks++;
  };
  for (const sign of [1, -1]) {                            // the walkable ring: theta every 5 deg x offset -4.5 .. +4.5
    const rig = rigAt(0, sign);
    for (let deg = 0; deg < 360; deg += 5) for (let off = -4.5; off <= 4.5; off += 0.5) {
      const p = RING.offsetPoint(deg * DEG, off);
      rig.snapTo(p.x, p.z); rig.apply();
      check(rig, `theta ${deg} offset ${off} sign ${sign}`);
    }
  }
  for (let yaw = 0; yaw < 360; yaw += 45) {                // plaza and lawn (plaza mode) at any frozen yaw
    for (let x = -24; x <= 24; x += 1.5) for (let z = -14; z <= 14; z += 1.5) {
      if (RING.ellipseOffset(x, z) >= PLAZA_OFFSET || !RING.inWalk(x, z)) continue;
      const rig = createOrbitRig(PRESET, RING); rig.snapYaw(yaw); rig.snapTo(x, z); rig.apply();
      assert.equal(rig.mode, 'plaza');
      check(rig, `plaza (${x}, ${z}) frozen yaw ${yaw}`);
    }
  }
  for (const off of [0, 4]) for (const deg of [0, 90]) {  // laps: 5 s one way, then back (flip + 180 degree swing), 60 Hz
    const tab = RING.arcTable(off), rig = createOrbitRig(PRESET, RING), hz = 60;
    let s = tab.lenAt(deg * DEG), p = RING.offsetPoint(tab.at(s), off);
    rig.snapTo(p.x, p.z); rig.apply();
    for (let i = 0; i < 40 * hz; i++) {
      s += (i < 5 * hz || i >= 15 * hz ? 1 : -1) * SPEED / hz;
      p = RING.offsetPoint(tab.at(s), off); rig.update(1 / hz, p.x, p.z); rig.apply();
      check(rig, `lap offset ${off} from ${deg} deg, frame ${i}`);
    }
  }
  assert.ok(checks > 10000, 'checks ' + checks);
});

test('direction flip hysteresis: reversal must last > 0.4 s; standing holds the timer, walking forward resets it', () => {
  const hz = 120, s0 = CENTRE.lenAt(RING.SPAWN.theta);
  assert.equal(DIR_FLIP_S, 0.4);
  // 0.3 s back: no flip; 0.45 s back: flipped
  let rig = rigAt(RING.SPAWN.theta, 1), s = walk(rig, s0, 1, hz, 1);
  s = walk(rig, s, -1, hz, 0.3);
  assert.equal(rig.dir, 1, 'after 0.30 s against');
  walk(rig, s, -1, hz, 0.15);
  assert.equal(rig.dir, -1, 'after 0.45 s against');
  // 0.3 s back, 1 s standing, 0.15 s back: 0.45 s of reversal in total -> flipped (standstill neither runs nor resets it)
  rig = rigAt(RING.SPAWN.theta, 1); s = walk(rig, s0, 1, hz, 1); s = walk(rig, s, -1, hz, 0.3);
  for (let i = 0; i < hz; i++) { const p = at(s); rig.update(1 / hz, p[0], p[1]); }
  assert.equal(rig.dir, 1, 'standing still');
  walk(rig, s, -1, hz, 0.15);
  assert.equal(rig.dir, -1, 'resumed reversal completes the 0.4 s');
  // 0.3 s back, 0.1 s forward, 0.3 s back: the forward step resets the timer -> no flip
  rig = rigAt(RING.SPAWN.theta, 1); s = walk(rig, s0, 1, hz, 1);
  s = walk(rig, s, -1, hz, 0.3); s = walk(rig, s, 1, hz, 0.1); walk(rig, s, -1, hz, 0.3);
  assert.equal(rig.dir, 1, 'reset by walking forward');
  // crossing the road (radial, no tangential speed) for 2 s never flips, and a teleport is not a velocity
  rig = rigAt(RING.SPAWN.theta, 1);
  for (let i = 0; i < 2 * hz; i++) rig.update(1 / hz, 0, RING.B + 2.4 * Math.sin(i / hz * 3));
  assert.equal(rig.dir, 1, 'radial walking');
  const far = at(s0 - 20); rig.update(1 / hz, far[0], far[1]);
  for (let i = 0; i < hz; i++) rig.update(1 / hz, far[0], far[1]);
  assert.equal(rig.dir, 1, 'teleport 20 units back along the road');
});

test('turn-rate cap 90 deg/s: after a flip the yaw turns at exactly the cap, one way round (the clear way), and stops on the tangent', () => {
  assert.equal(TURN_RATE_DEG, 90);
  for (const hz of [120, 60]) {
    const rig = rigAt(RING.SPAWN.theta, 1), dt = 1 / hz;
    let s = walk(rig, CENTRE.lenAt(RING.SPAWN.theta), 1, hz, 0.5), flippedAt = -1, arrivedAt = -1, prevYaw = rig.yawDeg, prevSign = 0, t = 0;
    let turned = 0, capped = 0;
    for (let i = 0; i < 4 * hz; i++) {
      s -= SPEED * dt; t += dt;
      const p = at(s); rig.update(dt, p[0], p[1]); rig.apply();
      const step = rig.yawDeg - prevYaw, left = turnBetween(rig.yawDeg, rig.yawFor(p[0], p[1]));
      assert.ok(Math.abs(step) <= TURN_RATE_DEG * dt + 1e-9, `${hz} Hz frame ${i}: turned ${step} deg`);
      if (rig.dir === -1 && flippedAt < 0) flippedAt = t;
      if (flippedAt >= 0 && arrivedAt < 0) {
        turned += step;
        if (Math.abs(left) < 1e-6) arrivedAt = t;
        else {
          near(Math.abs(step), TURN_RATE_DEG * dt, 1e-9, `${hz} Hz frame ${i}: turning at the cap`); capped++;
          if (prevSign) assert.equal(Math.sign(left), prevSign, `${hz} Hz: one way round`);
          prevSign = Math.sign(left);
        }
      }
      if (arrivedAt >= 0) assert.ok(Math.abs(left) < 1, `${hz} Hz: stays on the tangent after arriving (${left})`);
      assert.ok(camOffsetOf(rig) <= LIMIT + 0.1, `${hz} Hz frame ${i}: camera clear while turning (${camOffsetOf(rig).toFixed(2)})`);
      prevYaw = rig.yawDeg;
    }
    assert.ok(flippedAt > DIR_FLIP_S && flippedAt < DIR_FLIP_S + 2 * dt, `${hz} Hz flip at ${flippedAt}`);
    // The way round that keeps the camera over the road and the plaza: at the spawn the short way (~168 degrees, through
    // north) would swing the camera south through the lots, so it turns ~192 degrees through south (#119).
    assert.ok(turned < -180 && turned > -200, `${hz} Hz turned ${turned}`);
    near(arrivedAt - flippedAt, Math.abs(turned) / TURN_RATE_DEG, dt + 1e-9, `${hz} Hz: arrival time = turn / 90 deg/s`);
    assert.ok(capped >= Math.floor(Math.abs(turned) / (TURN_RATE_DEG * dt)) - 1, `${hz} Hz capped frames ${capped}`);
  }
  // setYaw is a target: 120 degrees away takes 4/3 s and stops exactly there (turning toward the plaza: the camera stays clear)
  const rig = rigAt(RING.SPAWN.theta, 1), y0 = rig.yawDeg, p = rig.focus;
  for (let i = 0; i < 60; i++) { rig.setYaw(y0 - 120); rig.update(1 / 60, p[0], p[1]); }
  near(rig.yawDeg - y0, -90, 1e-9, 'one second: 90 degrees');
  for (let i = 0; i < 60; i++) { rig.setYaw(y0 - 120); rig.update(1 / 60, p[0], p[1]); }
  near(rig.yawDeg - y0, -120, 1e-9, 'stops on the target');
  rig.update(1 / 60, p[0], p[1]);
  assert.ok(rig.yawDeg - y0 > -120, 'without setYaw it turns back toward the tangent');
});

test('plaza mode: inside the inner pavement the yaw freezes and the pitch rises 6 degrees over 0.5 s; back on the ring it returns', () => {
  assert.equal(PLAZA_OFFSET, -4.5); assert.equal(PLAZA_PITCH_DEG, 6); assert.equal(PLAZA_PITCH_S, 0.5);
  const hz = 120, dt = 1 / hz, rig = rigAt(RING.SPAWN.theta, 1), yaw0 = rig.yawDeg;
  let x = 0, z = RING.B, entered = -1, t = 0, pitchAtEntry = [];
  while (z > 0) {                                        // walk north from the spawn to the pylon's south face
    z -= SPEED * dt; t += dt;
    if (z < 1.5 + 0.3) break;
    rig.update(dt, x, z); rig.apply();
    const off = RING.ellipseOffset(x, z);
    assert.equal(rig.mode, off < PLAZA_OFFSET || entered >= 0 ? 'plaza' : 'orbit', `mode at offset ${off.toFixed(2)}`);
    if (rig.mode === 'plaza' && entered < 0) entered = t;
    if (entered >= 0) pitchAtEntry.push([t - entered, rig.pitchDeg]);
    assert.ok(rig.pitchDeg >= PRESET.pitchDeg - 1e-9 && rig.pitchDeg <= PRESET.pitchDeg + 6 + 1e-9, 'pitch within 9..15');
  }
  near(entered, (RING.B - 13.5) / SPEED, 2 * dt, 'plaza entered at offset -4.5');
  const pitchAt = (s) => pitchAtEntry.find((e) => e[0] >= s - 1e-9)[1];
  near(pitchAt(0.25), PRESET.pitchDeg + 3, 12 * dt + 1e-9, 'half way after 0.25 s');
  near(pitchAt(0.5), PRESET.pitchDeg + 6, 1e-9, '+6 after 0.5 s');
  near(rig.yawDeg, yaw0, 1e-9, 'yaw unchanged since the ring (walking radially at the spawn)');
  // walk around the plaza: yaw frozen, setYaw ignored, yawFor answers the frozen yaw
  for (let i = 0; i < 2 * hz; i++) {
    const a = i / hz * 1.5, px = 6 * Math.cos(a), pz = 6 * Math.sin(a) + 1;
    rig.setYaw(rig.yawDeg + 90);
    rig.update(dt, px, pz); rig.apply();
    assert.equal(rig.mode, 'plaza');
    assert.equal(rig.yawDeg, yaw0, 'yaw frozen');
    assert.equal(rig.yawFor(px, pz), yaw0, 'yawFor = the frozen yaw');
  }
  // out to the north end (theta 270: clockwise = east). Frozen yaw looks west, so the rig picks dir -1 and does not turn.
  rig.snapTo(0, -8);
  let left = -1;
  for (z = -8, t = 0; z > -RING.B; z -= SPEED * dt, t += dt) {
    rig.update(dt, 0, z); rig.apply();
    if (rig.mode === 'orbit' && left < 0) { left = t; near(RING.ellipseOffset(0, z), PLAZA_EXIT, SPEED * dt + 1e-9, 'leaves at offset -4.25'); }
  }
  assert.equal(rig.mode, 'orbit');
  assert.equal(rig.dir, -1, 'travel direction nearest the frozen yaw');
  near(rig.yawDeg, yaw0, 1e-9, 'no turn on leaving the plaza');
  near(rig.pitchDeg, PRESET.pitchDeg, 1e-9, 'pitch back to 9 (0.5 s after leaving)');
});

test('plaza: the leaderboard pylon is in frame for a guide anywhere on the plaza disc, at any frozen yaw', () => {
  const pylon = RING.colliderRects().find((c) => c.tag === 'pylon'), H = RING.PYLON.h;
  let samples = 0, worst = { share: 1 };
  for (let yaw = 0; yaw < 360; yaw += 22.5) {
    for (let x = -RING.PLAZA_R; x <= RING.PLAZA_R; x += 0.5) {
      for (let z = -RING.PLAZA_R; z <= RING.PLAZA_R; z += 0.5) {
        if (Math.hypot(x, z) > RING.PLAZA_R || RING.obbDistance(pylon, x, z) < 0.3) continue;
        const rig = createOrbitRig(PRESET, RING);
        rig.snapYaw(yaw); rig.snapTo(x, z); rig.apply();
        assert.equal(rig.mode, 'plaza');
        near(rig.pitchDeg, PRESET.pitchDeg + 6, 1e-9, 'plaza pitch');
        const top = project(rig.camera, RING.PYLON.x, H, RING.PYLON.z);
        assert.ok(inFrame(top), `pylon top (title band) in frame: guide (${x}, ${z}) yaw ${yaw} -> ${top.x.toFixed(1)}, ${top.y.toFixed(1)}`);
        let seen = 0;
        for (let i = 0; i <= 70; i++) if (inFrame(project(rig.camera, RING.PYLON.x, H * i / 70, RING.PYLON.z))) seen++;
        if (seen / 71 < worst.share) worst = { share: seen / 71, x, z, yaw };
        samples++;
      }
    }
  }
  assert.ok(samples > 15000, 'samples ' + samples);
  // Worst case: the guide at the far edge of the disc straight behind the pylon (yaw frozen), the pylon 8 units in front of
  // the camera: its top 38 % is in frame (status/DECISIONS.md #116).
  assert.ok(worst.share >= 0.35, `at least 35 % of the pylon's height in frame everywhere: ${JSON.stringify(worst)}`);
});

test('snap: standing still while the camera turns never moves the snapped focus (the M2.9.1 world grid jumps)', () => {
  const p = RING.ellipsePoint(30 * DEG);
  for (const [snap, expectStill] of [['feet', true], ['world', false]]) {
    const rig = createOrbitRig(PRESET, RING, { snap });
    rig.snapTo(p.x, p.z); rig.snapYaw(rig.yawDeg - 90);
    let last = rig.apply(), maxJump = 0;
    for (let i = 0; i < 120; i++) { rig.update(1 / 120, p.x, p.z); const s = rig.apply(); maxJump = Math.max(maxJump, Math.hypot(s[0] - last[0], s[1] - last[1])); last = s; }
    if (expectStill) assert.equal(maxJump, 0, snap);
    else assert.ok(maxJump > 0.2, `${snap} jumps ${maxJump.toFixed(3)} units while turning in place`);
  }
});

test('snap steps move the ground under the guide by whole render pixels (plaza: pure translation)', () => {
  const st = snapSteps(PRESET);
  near(st.forward, 0.1275, 0.0005, 'forward step at pitch 9');
  near(st.lateral, 0.0664, 0.0005, 'lateral step at pitch 9');
  const rig = createOrbitRig(PRESET, RING), hz = 120, dt = 1 / hz;
  rig.snapYaw(-30); rig.snapTo(-6, 5); rig.apply();
  let prev = rig.camera.clone(), x = -6, z = 5, steps = 0;
  for (let i = 0; i < hz * 2; i++) {
    const feet = rig.apply();
    x += SPEED * dt * 0.8; z -= SPEED * dt * 0.6;
    rig.update(dt, x, z);
    rig.apply();
    const a = project(prev, feet[0], 0, feet[1]), b = project(rig.camera, feet[0], 0, feet[1]);
    for (const d of [b.x - a.x, b.y - a.y]) {
      assert.ok(Math.abs(d - Math.round(d)) < 0.08, `frame ${i}: the ground under the guide moved ${d.toFixed(3)} px`);
      if (Math.round(d)) steps++;
    }
    prev = rig.camera.clone();
  }
  assert.ok(steps > 30, 'it moved: ' + steps + ' pixel steps');
});

// §1.4 judder gate on the rig alone: walking the centre line at 4.2 u/s for 4 s, a static ground point 6 units ahead (on the
// road, by arc length) moves at most 1 render pixel per frame in each axis between consecutive frames, and the sign of its
// lateral motion changes at most 3 times per second. Measured as float pixel positions and as whole pixels.
function judder(theta, sign, hz, opts) {
  const rig = rigAt(theta, sign, opts), secs = 4;
  let prev = rig.camera.clone(), maxX = 0, maxY = 0, maxPx = 0, flips = 0, lastSign = 0;
  walk(rig, CENTRE.lenAt(theta), sign, hz, secs, (r, s0) => {
    const q = at(s0 + sign * 6), a = project(prev, q[0], 0, q[1]), b = project(r.camera, q[0], 0, q[1]);
    const dx = b.x - a.x, dy = b.y - a.y;
    maxX = Math.max(maxX, Math.abs(dx)); maxY = Math.max(maxY, Math.abs(dy));
    maxPx = Math.max(maxPx, Math.abs(Math.round(b.x) - Math.round(a.x)), Math.abs(Math.round(b.y) - Math.round(a.y)));
    if (Math.abs(dx) > 1e-6) { const sg = Math.sign(dx); if (lastSign && sg !== lastSign) flips++; lastSign = sg; }
    prev = r.camera.clone();
  });
  return { maxX, maxY, maxPx, flipsPerS: flips / secs };
}

test('judder gate (§1.4): 6 units ahead moves <= 1 px per frame per axis, <= 3 lateral sign flips/s, at 120 and 60 Hz', () => {
  const worst = {};
  for (const hz of [120, 60]) {
    const w = worst[hz] = { maxX: 0, maxY: 0, maxPx: 0, flipsPerS: 0 };
    for (const sign of [1, -1]) {
      for (let deg = 0; deg < 360; deg += 45) {
        const j = judder(deg * DEG, sign, hz), tag = `${hz} Hz from ${deg} deg ${sign > 0 ? 'clockwise' : 'anticlockwise'}`;
        assert.ok(j.maxX <= 1 && j.maxY <= 1, `${tag}: ${j.maxX.toFixed(3)} / ${j.maxY.toFixed(3)} px`);
        assert.ok(j.maxPx <= 1, `${tag}: whole pixels ${j.maxPx}`);
        assert.ok(j.flipsPerS <= 3, `${tag}: ${j.flipsPerS} flips/s`);
        for (const k of Object.keys(w)) w[k] = Math.max(w[k], j[k]);
      }
    }
  }
  // Measured with clearance (status/DECISIONS.md #112): 120 Hz 0.65 / 0.58 px, 60 Hz 0.82 / 0.58 px, 0 flips/s.
  assert.ok(worst[120].maxX < 0.75 && worst[120].maxY < 0.7 && worst[120].flipsPerS === 0, JSON.stringify(worst));
});

test('judder gate negative control: the M2.9.1 world-anchored snap (snapFocusYaw grid) fails it', () => {
  const j = judder(RING.SPAWN.theta, 1, 120, { snap: 'world' });
  assert.ok(j.maxY > 1 || j.flipsPerS > 3, 'the gate can fail: ' + JSON.stringify(j));
});
