// M3.0 lane A: the ring layout (prompts/M30_RING.md §1.1–1.2) — ellipse helpers, lots, doors, colliders, walk bounds.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  A, B, ROAD_W, ROAD_HALF, OUTER_EDGE, INNER_EDGE, PLAZA_R, LOTS, LOT_W, LOT_D, lotRect, doorOf, ellipsePoint, ellipseTheta,
  ellipseOffset, ellipseTangent, ellipseNormal, offsetPoint, inWalk, colliderRects, obbDistance, SPAWN, PYLON, BENCHES, PROPS
} from '../ring-layout.mjs';

const DEG = Math.PI / 180, TAU = Math.PI * 2;
const angDiff = (a, b) => { const d = Math.abs(a - b) % TAU; return Math.min(d, TAU - d); };
// Points covering an oriented box: an n x n grid including its edges and corners.
function boxSamples(c, n) {
  const out = [];
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    const a = (2 * i / n - 1) * c.hw, b = (2 * j / n - 1) * c.hd;
    out.push([c.cx + a * c.ux + b * c.uz, c.cz + a * c.uz - b * c.ux]);
  }
  return out;
}
// Separating-axis test for two oriented boxes (touching counts as apart).
function obbOverlap(p, q) {
  const axes = [[p.ux, p.uz], [p.uz, -p.ux], [q.ux, q.uz], [q.uz, -q.ux]];
  const proj = (c, ax) => {
    const m = c.cx * ax[0] + c.cz * ax[1];
    const r = c.hw * Math.abs(c.ux * ax[0] + c.uz * ax[1]) + c.hd * Math.abs(c.uz * ax[0] - c.ux * ax[1]);
    return [m - r, m + r];
  };
  return axes.every((ax) => { const [a0, a1] = proj(p, ax), [b0, b1] = proj(q, ax); return a1 > b0 + 1e-9 && b1 > a0 + 1e-9; });
}
const PLAZA_TAGS = new Set(['pylon', ...PROPS.filter((p) => p.side === 'plaza').map((p) => p.tag)]);

test('contract constants (§1.1)', () => {
  assert.deepEqual([A, B, ROAD_W, ROAD_HALF, INNER_EDGE, OUTER_EDGE, PLAZA_R, LOT_W, LOT_D], [28, 18, 5, 2.5, -4.5, 4.5, 9, 14, 10]);
  assert.deepEqual([PYLON.x, PYLON.z, PYLON.w, PYLON.d, PYLON.h], [0, 0, 3, 3, 7]);
  assert.equal(BENCHES.length, 4);
  BENCHES.forEach((b) => {
    assert.equal(Math.hypot(b.x, b.z), 6, b.id + ' at radius 6');
    assert.deepEqual([Math.min(b.w, b.d), Math.max(b.w, b.d)], [0.6, 2], b.id + ' is 0.6 x 2');
  });
  assert.deepEqual(BENCHES.map((b) => [Math.sign(b.x), Math.sign(b.z)]), [[0, -1], [1, 0], [0, 1], [-1, 0]], 'N, E, S, W');
});

test('ellipse helpers: θ = 0 is east, θ grows toward +z (clockwise from above), and they round-trip', () => {
  assert.deepEqual(ellipsePoint(0), { x: A, z: 0 });
  const s = ellipsePoint(Math.PI / 2);
  assert.ok(Math.abs(s.x) < 1e-12 && s.z === B, 'θ = 90° is the south end');
  let maxT = 0, maxD = 0;
  for (let deg = 0; deg < 360; deg += 0.5) {
    const th = deg * DEG, t = ellipseTangent(th), n = ellipseNormal(th), p = ellipsePoint(th);
    assert.ok(Math.abs((p.x / A) ** 2 + (p.z / B) ** 2 - 1) < 1e-12, 'on the ellipse');
    assert.ok(Math.abs(t.x * n.x + t.z * n.z) < 1e-12 && Math.abs(Math.hypot(t.x, t.z) - 1) < 1e-12, 'unit tangent ⟂ normal');
    assert.ok(n.x * p.x / A ** 2 + n.z * p.z / B ** 2 > 0, 'normal points outward');
    for (const d of [-11, -8, INNER_EDGE, -ROAD_HALF, -1, 0, 1, ROAD_HALF, OUTER_EDGE, 7, 15]) {
      const q = offsetPoint(th, d);
      maxT = Math.max(maxT, angDiff(ellipseTheta(q.x, q.z), th));
      maxD = Math.max(maxD, Math.abs(ellipseOffset(q.x, q.z) - d));
    }
  }
  assert.ok(maxT < 1e-9, 'ellipseTheta round-trip error ' + maxT);
  assert.ok(maxD < 1e-9, 'ellipseOffset round-trip error ' + maxD);
  for (let i = 0; i < 200; i++) {                                   // range [0, 2π) everywhere, also off the ring
    const th = ellipseTheta(Math.cos(i * 1.7) * 60, Math.sin(i * 2.3) * 60);
    assert.ok(th >= 0 && th < TAU, 'θ in [0, 2π): ' + th);
  }
  assert.equal(ellipseOffset(0, 0), -B, 'the centre is B inside the centre line');
  assert.ok(ellipseOffset(0, B + 3) > 2.999 && ellipseOffset(A - 1, 0) < -0.999);
});

test('spawn: on the road centre line at θ = 90°, facing west = clockwise along the road', () => {
  assert.equal(SPAWN.facing, 'west');
  assert.ok(Math.abs(ellipseOffset(SPAWN.x, SPAWN.z)) < 1e-9 && angDiff(ellipseTheta(SPAWN.x, SPAWN.z), Math.PI / 2) < 1e-9);
  const t = ellipseTangent(Math.PI / 2);
  assert.ok(t.x < -0.999, 'the clockwise tangent at the south end points west');
  assert.equal(inWalk(SPAWN.x, SPAWN.z, 0.34), true);
});

test('lots: ten at the contract angles, front edge tangent to the outer pavement edge, facing the ring centre', () => {
  assert.deepEqual(LOTS.map((l) => [l.id, l.deg]), [['engineering', 0], ['research', 36], ['operations', 72], ['qa', 108],
    ['design', 144], ['planning', 180], ['sportsgang', 216], ['no-wukkas-cafe', 252], ['lot-9', 288], ['lot-10', 324]]);
  assert.deepEqual(LOTS.filter((l) => l.boarded).map((l) => [l.id, l.family, l.wall]), [['lot-9', 'shopfront', 'plaster'], ['lot-10', 'shopfront', 'plaster']]);
  LOTS.forEach((L) => {
    assert.ok(L.h >= 8 && L.h <= 16 && L.h % 1.5 === 0, L.id + ' height ' + L.h);
    assert.ok(L.label.length <= 6, L.id + ' label fits 6 chars');
    const r = lotRect(L), t = ellipseTangent(L.theta), n = ellipseNormal(L.theta), P = offsetPoint(L.theta, OUTER_EDGE);
    assert.deepEqual([r.hw * 2, r.hd * 2], [LOT_W, LOT_D]);
    assert.ok(Math.abs(r.ux - t.x) < 1e-6 && Math.abs(r.uz - t.z) < 1e-6, 'frontage along the tangent');
    // front edge = the line through P along t: both front corners are on it, ±7 from P
    const front = r.corners.filter(([x, z]) => Math.abs((x - P.x) * n.x + (z - P.z) * n.z) < 1e-5);
    assert.equal(front.length, 2, L.id + ' has two corners on the tangent line');
    front.forEach(([x, z]) => assert.ok(Math.abs(Math.abs((x - P.x) * t.x + (z - P.z) * t.z) - 7) < 1e-4, L.id + ' front corner 7 from the tangent point'));
    // the whole lot lies beyond the outer pavement edge (touching it only at the tangent point)
    const minOff = Math.min(...boxSamples(r, 20).map(([x, z]) => ellipseOffset(x, z)));
    assert.ok(minOff > OUTER_EDGE - 1e-6, L.id + ' min offset ' + minOff);
    // it stands on the outer side and its facade faces the centre: the rect centre is 5 out along the normal
    assert.ok(Math.abs((r.cx - P.x) * n.x + (r.cz - P.z) * n.z - LOT_D / 2) < 1e-6);
    const toCentre = [-r.cx, -r.cz], facade = [-n.x, -n.z];
    assert.ok(toCentre[0] * facade[0] + toCentre[1] * facade[1] > 0, L.id + ' faces the ring centre');
    // facadeRotY turns local +x (an alley west lot's facade normal) onto the inward normal
    assert.ok(Math.abs(Math.cos(L.facadeRotY) + n.x) < 1e-6 && Math.abs(-Math.sin(L.facadeRotY) + n.z) < 1e-6, L.id + ' facadeRotY');
  });
});

test('doors: on the frontage midpoints, on the outer pavement edge, with a return spot on the road in front', () => {
  LOTS.forEach((L) => {
    const d = doorOf(L), r = lotRect(L), n = ellipseNormal(L.theta);
    const front = r.corners.filter(([x, z]) => Math.abs((x - d.x) * n.x + (z - d.z) * n.z) < 1e-5);
    assert.ok(Math.abs((front[0][0] + front[1][0]) / 2 - d.x) < 1e-5 && Math.abs((front[0][1] + front[1][1]) / 2 - d.z) < 1e-5, L.id + ' door = frontage midpoint');
    assert.ok(Math.abs(ellipseOffset(d.x, d.z) - OUTER_EDGE) < 1e-6, L.id + ' door on the +4.5 edge');
    assert.equal(doorOf(L.id).x, d.x, 'doorOf accepts the id');
    const back = d.returnAt;
    assert.ok(Math.abs(ellipseOffset(back.x, back.z)) <= ROAD_HALF, L.id + ' return spot on the road');
    assert.ok(Math.abs(ellipseOffset(back.x, back.z) - (OUTER_EDGE - Math.hypot(back.x - d.x, back.z - d.z))) < 1e-6, 'straight in front of the door');
    assert.equal(inWalk(back.x, back.z, 0.34), true, L.id + ' return spot is walkable');
    // the approach to the door is clear: walkable from the return spot to 0.4 short of the door
    for (let k = 0; k <= 10; k++) {
      const f = k / 10, x = back.x + (d.x - 0.4 * d.nx - back.x) * f, z = back.z + (d.z - 0.4 * d.nz - back.z) * f;
      assert.equal(inWalk(x, z, 0.34), true, L.id + ' approach blocked at ' + f);
    }
    assert.ok(['north', 'east', 'south', 'west'].includes(back.facing) && back.facing !== d.inFacing);
  });
});

test('no collider overlaps the road; only the plaza furniture stands in the plaza disc; no two colliders overlap', () => {
  const cs = colliderRects();
  assert.ok(cs.length === 10 + 1 + PROPS.length);
  cs.forEach((c) => {
    assert.ok(c.x0 <= c.cx - c.hw * Math.abs(c.ux) && c.x1 >= c.cx + c.hw * Math.abs(c.ux), c.tag + ' AABB covers the box');
    const pts = boxSamples(c, 16);
    pts.forEach(([x, z]) => assert.ok(Math.abs(ellipseOffset(x, z)) > ROAD_HALF, c.tag + ' overlaps the road at ' + x + ',' + z));
    const inDisc = pts.filter(([x, z]) => Math.hypot(x, z) <= PLAZA_R).length;
    if (PLAZA_TAGS.has(c.tag)) assert.equal(inDisc, pts.length, c.tag + ' stays inside the plaza');
    else assert.equal(inDisc, 0, c.tag + ' overlaps the plaza disc');
  });
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) assert.ok(!obbOverlap(cs[i], cs[j]), cs[i].tag + ' overlaps ' + cs[j].tag);
});

test('props: lamps on the outer pavement, trees on the inner, door benches/bins, plaza lamps at r 7.5', () => {
  const kind = (k, side) => PROPS.filter((p) => p.kind === k && p.side === side);
  const lamps = kind('lamp', 'outer'), trees = kind('tree', 'inner');
  assert.equal(lamps.length, 20);
  assert.equal(trees.length, 12);
  lamps.forEach((p) => boxSamples(p, 4).forEach(([x, z]) => { const o = ellipseOffset(x, z); assert.ok(o > ROAD_HALF && o < OUTER_EDGE, p.id); }));
  trees.forEach((p) => boxSamples(p, 4).forEach(([x, z]) => { const o = ellipseOffset(x, z); assert.ok(o < -ROAD_HALF && o > INNER_EDGE, p.id); }));
  // two lamps per gap between doors (~8 apart along the curve); none stands in a crossing
  lamps.forEach((p) => LOTS.forEach((L) => assert.ok(Math.hypot(p.x - L.doorX, p.z - L.doorZ) > 2.5, p.id + ' clear of ' + L.id)));
  assert.equal(PROPS.filter((p) => p.side === 'door').length, 16, 'a bench and a bin by each of the 8 open doors');
  const pl = kind('lamp', 'plaza');
  assert.equal(pl.length, 4);
  pl.forEach((p) => assert.ok(Math.abs(Math.hypot(p.x, p.z) - 7.5) < 1e-5));
});

test('inWalk: true on the road, pavements and plaza (outside colliders), false inside lots and beyond the outer edge', () => {
  const cs = colliderRects(), inCollider = (x, z) => cs.some((c) => obbDistance(c, x, z) <= 0);
  for (let deg = 0; deg < 360; deg += 1) {
    const th = deg * DEG;
    for (const d of [-2.49, -1.25, 0, 1.25, 2.49]) { const p = offsetPoint(th, d); assert.equal(inWalk(p.x, p.z), true, 'road ' + deg + '/' + d); }
    let pave = 0;
    for (const d of [-4.4, -3.5, -2.6, 2.6, 3.5, 4.4]) {
      const p = offsetPoint(th, d), w = inWalk(p.x, p.z);
      assert.equal(w, !inCollider(p.x, p.z), 'pavement ' + deg + '/' + d);
      if (w) pave++;
    }
    assert.ok(pave >= 4, 'pavements mostly free at ' + deg);
    for (const d of [4.6, 6, 20]) { const p = offsetPoint(th, d); assert.equal(inWalk(p.x, p.z), false, 'beyond the outer edge ' + deg + '/' + d); }
  }
  for (let r = 0; r <= PLAZA_R; r += 0.5) for (let deg = 0; deg < 360; deg += 7.5) {
    const x = r * Math.cos(deg * DEG), z = r * Math.sin(deg * DEG);
    assert.equal(inWalk(x, z), !inCollider(x, z), 'plaza ' + r + '/' + deg);
  }
  assert.equal(inWalk(0, 0), false, 'the pylon');
  assert.equal(inWalk(0, 4, 0.34), true, 'beside the pylon');
  LOTS.forEach((L) => {
    const r = lotRect(L), inside = Object.assign({}, r, { hw: r.hw - 0.01, hd: r.hd - 0.01 });   // strictly inside
    boxSamples(inside, 8).forEach(([x, z]) => assert.equal(inWalk(x, z), false, 'inside lot ' + L.id));
  });
});
