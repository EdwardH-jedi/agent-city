// M3.2a Phase 2 (prompts/M32_PANELS.md §2): the minimap. Pure parts (no DOM, no GL): the ring model is ring-layout's own
// geometry; the north-up transform and its inverse; the guide triangle points along the camera yaw; lot hit-testing; the
// lamp rule is the pylon's; minimapView reads the real debug state (headless app on the real scene switch, stub renderer).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as RING from '../ring-layout.mjs';
import { lampState } from '../scene-ring.mjs';
import { ringModel, townModel, rectModel, fitTransform, guideTriangle, lotAt, minimapView, lotLamp, rowCount, lotSummary, SHORT_LABEL } from '../minimap.mjs';

const DEG = Math.PI / 180;
function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

test('ring model: ring-layout geometry itself (10 lots, their oriented corners and doors), short labels <= 3 chars', () => {
  const M = ringModel();
  assert.equal(M.lots.length, RING.LOTS.length);
  M.lots.forEach((l, i) => {
    const L = RING.LOTS[i], r = RING.lotRect(L), d = RING.doorOf(L);
    assert.equal(l.id, L.id);
    assert.deepEqual(l.corners, r.corners.map((c) => [c[0], c[1]]));
    assert.deepEqual([l.door.x, l.door.z], [d.x, d.z]);
    assert.ok(SHORT_LABEL[L.id] && SHORT_LABEL[L.id].length <= 3, L.id);
  });
  // Every lot corner and the whole walk boundary are inside the map's bounds.
  for (const [x, z] of [].concat(...M.lots.map((l) => l.corners), M.outer)) assert.ok(x > M.bounds.x0 && x < M.bounds.x1 && z > M.bounds.z0 && z < M.bounds.z1);
  // The outer curve is the walk bound: every sample sits at offset OUTER_EDGE.
  for (const [x, z] of M.outer) assert.ok(Math.abs(RING.ellipseOffset(x, z) - RING.OUTER_EDGE) < 1e-6);
});

test('transform: north up; 20 random walkable points round-trip through whole map pixels within 0.5 unit (both panel widths)', () => {
  const M = ringModel(), rand = rng(32);
  const pts = [];
  while (pts.length < 20) {
    const x = (rand() * 2 - 1) * (RING.A + RING.OUTER_EDGE), z = (rand() * 2 - 1) * (RING.B + RING.OUTER_EDGE);
    if (RING.inWalk(x, z)) pts.push([x, z]);
  }
  // Map widths: the minimap's box in a 240 px panel (206 px) and in a 384 px panel (350 px).
  for (const width of [206, 350]) {
    const T = fitTransform(M.bounds, width, 4, 560, true);
    assert.ok(T.height > T.mapHeight, 'scale-cue strip below the map');
    let worst = 0;
    for (const [x, z] of pts) {
      const [px, py] = T.toPx(x, z);
      assert.ok(px >= 0 && px <= T.width && py >= 0 && py <= T.mapHeight, 'inside the map ' + [x, z]);
      const [ex, ez] = T.toWorld(px, py);
      assert.ok(Math.hypot(ex - x, ez - z) < 1e-9);
      const [rx, rz] = T.toWorld(Math.round(px), Math.round(py));
      worst = Math.max(worst, Math.hypot(rx - x, rz - z));
    }
    assert.ok(worst <= 0.5, width + ' px: worst round trip ' + worst);
  }
  // North up: -z is up the map, +x is right.
  const T = fitTransform(M.bounds, 350, 4);
  assert.ok(T.toPx(0, -10)[1] < T.toPx(0, 10)[1]);
  assert.ok(T.toPx(-10, 0)[0] < T.toPx(10, 0)[0]);
});

test('guide triangle points along the camera yaw (forward = (sin yaw, -cos yaw)), within 2 degrees, unwrapped yaws too', () => {
  const T = fitTransform(ringModel().bounds, 350, 4);
  for (let yaw = -400; yaw <= 400; yaw += 17.5) {
    const [tip, b1, b2] = guideTriangle(T, 3, -4, yaw, 8);
    const back = [(b1[0] + b2[0]) / 2, (b1[1] + b2[1]) / 2];
    // Screen angle of base -> tip, read back as a camera yaw: dx = sin yaw, dy = -cos yaw.
    const got = Math.atan2(tip[0] - back[0], -(tip[1] - back[1])) / DEG;
    const diff = ((got - yaw) % 360 + 540) % 360 - 180;
    assert.ok(Math.abs(diff) <= 2, 'yaw ' + yaw + ' drawn at ' + got);
  }
});

test('lotAt: every lot centre hits that lot; the road in front of each door and the plaza hit nothing', () => {
  const M = ringModel();
  for (const l of M.lots) {
    assert.equal(lotAt(M, l.cx, l.cz).id, l.id);
    const d = RING.doorOf(l.id);
    assert.equal(lotAt(M, d.returnAt.x, d.returnAt.z), null);
  }
  assert.equal(lotAt(M, 0, 0), null);
  const town = townModel({ walk: { x0: -46, x1: 46, z0: -44, z1: 23 }, buildings: [{ department: 'qa', title: 'QA', x0: 0, x1: 10, z0: 0, z1: 8 }] });
  assert.equal(lotAt(town, 5, 4).id, 'qa');
  assert.equal(lotAt(town, 11, 4), null);
  assert.equal(rectModel('alley', { x0: -2, x1: 2, z0: -10, z1: 10 }).lots.length, 0);
});

test('lamps and counts: the pylon door-lamp rule (working > waiting > idle > unknown > off); offline is all grey, no counts', () => {
  const rows = new Map([['qa', { lot: 'qa', working: 0, waiting: 2, idle: 1, unknown: 0 }], ['design', { lot: 'design', working: 0, waiting: 0, idle: 0, unknown: 3 }]]);
  const view = { rows, offline: false };
  for (const id of ['qa', 'design', 'planning']) assert.equal(lotLamp(view, id), lampState(rows.get(id), false));
  assert.deepEqual(['qa', 'design', 'planning'].map((id) => lotLamp(view, id)), ['waiting', 'unknown', 'off']);
  assert.equal(rowCount(rows.get('qa')), 3);
  assert.equal(lotLamp({ rows, offline: true }, 'qa'), 'offline');
  assert.match(lotSummary({ rows, offline: true }, { id: 'qa', name: 'QA' }).counts, /offline/);
  assert.equal(minimapView(null), null);
  assert.equal(minimapView({ disposed: true }), null);
});

// agent-city: test 'minimapView on the real debug state: ...' dropped (needs tests/lib/ring-harness.mjs: scene-switch,
// ring-world and the classic app scripts, not ported). See PROVENANCE.md.
