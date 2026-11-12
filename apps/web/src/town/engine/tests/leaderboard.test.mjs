// M3.0 lane C: the ring plaza's leaderboard pylon (renderer/leaderboard.mjs). Headless: no GL context needed.
// Counts are checked against main.js's own borough fixture snapshot and read back from the painted texels (a small OCR over
// the board font), so a passing test means the pixels show the snapshot's numbers, not just the data structure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Vector3, NearestFilter } from 'three';
import { BOROUGH_ONLINE, BOROUGH_OFFLINE } from './borough-snapshot.mjs';   // agent-city: replaces loadLanes() and live-bridge (PROVENANCE.md)
import { TIME_PRESETS } from '../presets.mjs';
import { createImage, RAMPS } from '../textures.mjs';
import { LOTS, PYLON } from '../ring-layout.mjs';
import {
  createLeaderboard, boardViewFromSnapshot, boardViewFromLive, planFace, paintFace, faceRows, faceOfDeg, isFrameTexel,
  drawBoardText, boardTextWidth, counterText, formatAge, FACE_W, FACE_H, FACE_DEG, PYLON_W, PYLON_H, PYLON_CENTROID,
  BOARD_COLORS, BOARD_LAYOUT
} from '../leaderboard.mjs';

// agent-city: the borough snapshots come from ./borough-snapshot.mjs (dumped from main.js at a4f842d); see PROVENANCE.md.
const L = { initialSnapshot: (fx, transport) => (transport ? BOROUGH_ONLINE : BOROUGH_OFFLINE) };
const plain = (v) => JSON.parse(JSON.stringify(v));
const borough = () => null;
const KEYS = ['working', 'waiting', 'idle', 'unknown'];

// Borough fixture (main.js boroughSpecs), counted by hand: completed (Lark) is not counted; stale Rue (qa) and stale Vale
// (operations, working) are unknown; the three plaza idlers count for their department. Totals 8 / 3 / 4 / 2.
const BOROUGH = {
  engineering: [2, 1, 1, 0], research: [1, 0, 2, 0], operations: [1, 0, 0, 1], qa: [2, 0, 0, 1], design: [1, 1, 1, 0],
  planning: [1, 1, 0, 0], sportsgang: [0, 0, 0, 0], 'no-wukkas-cafe': [0, 0, 0, 0], 'lot-9': [0, 0, 0, 0], 'lot-10': [0, 0, 0, 0]
};

// ---- OCR over the board font -------------------------------------------------------------------------------------------
const ALPHABET = [...'0123456789—?smhd+ABCDEFGHIJKLMNOPQRSTUVWXYZ', ' '];
const GLYPHS = new Map(ALPHABET.map((ch) => {
  const w = boardTextWidth(ch), img = createImage(w, 5);
  drawBoardText(img, ch, 0, 0, [255, 255, 255]);
  return [ch, { w, img }];
}));
const inkAt = (img, x, y, color) => { const i = (y * img.width + x) * 4; return img.data[i] === color[0] && img.data[i + 1] === color[1] && img.data[i + 2] === color[2]; };
function glyphAt(img, x, y, color, ch) {
  const g = GLYPHS.get(ch);
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < g.w; c++) if (inkAt(img, x + c, y + r, color) !== (g.img.data[(r * g.w + c) * 4 + 3] === 255)) return false;
    if (inkAt(img, x + g.w, y + r, color)) return false;                   // the gap column after the glyph is clear
  }
  return true;
}
function readText(img, x, y, color, n) {
  let out = '', cx = x;
  for (let i = 0; i < n; i++) {
    const ch = ALPHABET.find((c) => glyphAt(img, cx, y, color, c));
    if (ch == null) return out + '<?>';
    out += ch; cx += GLYPHS.get(ch).w + 1;
  }
  return out;
}
// What the pixels of a planned string say (read with the planned colour, as many characters as planned).
const readEntry = (img, t) => readText(img, t.x, t.y, t.color, [...t.s].length);
const entry = (plan, lot, field) => plan.texts.find((t) => t.lot === lot && t.field === field);
function faceWithLot(board, lot) { return board.faces.find((f) => f.plan.texts.some((t) => t.lot === lot && t.field === 'label')); }

test('16 texels per unit: 48 x 112 boards on 3 x 7 faces; the pylon is ring-layout PYLON (3 x 3 x 7); faces outward, text not mirrored', () => {
  const lb = createLeaderboard({ seed: 1 });
  assert.deepEqual([FACE_W, FACE_H], [48, 112]);
  assert.equal(FACE_W / PYLON_W, 16); assert.equal(FACE_H / PYLON_H, 16);
  lb.mesh.updateMatrixWorld(true);
  lb.faces.forEach((f) => {
    const p = f.mesh.geometry.parameters, t = f.texture;
    assert.deepEqual([p.width, p.height], [PYLON_W, PYLON_H]);
    assert.deepEqual([t.image.width, t.image.height], [FACE_W, FACE_H]);
    assert.equal(t.image.width / p.width, 16); assert.equal(t.image.height / p.height, 16);
    assert.equal(t.magFilter, NearestFilter); assert.equal(t.minFilter, NearestFilter); assert.equal(t.generateMipmaps, false);
    const n = new Vector3(0, 0, 1).transformDirection(f.mesh.matrixWorld), right = new Vector3(1, 0, 0).transformDirection(f.mesh.matrixWorld);
    const want = new Vector3(Math.cos(f.deg * Math.PI / 180), 0, Math.sin(f.deg * Math.PI / 180));
    assert.ok(n.distanceTo(want) < 1e-9, 'face ' + f.index + ' normal points out along ' + f.deg + ' deg');
    // Seen from outside (looking along -n), the board's +u must be the viewer's right: (nz, 0, -nx).
    assert.ok(right.distanceTo(new Vector3(want.z, 0, -want.x)) < 1e-9, 'face ' + f.index + ' is not mirrored');
    const c = f.mesh.getWorldPosition(new Vector3());
    assert.ok((c.x - PYLON_CENTROID.x) * want.x + (c.z - PYLON_CENTROID.z) * want.z > 0.8, 'face sits outside the centroid');
  });
  const box = new Box3().setFromObject(lb.mesh);
  const r = (v) => Math.round(v * 1e6) / 1e6;
  assert.deepEqual([box.min.x, box.min.y, box.min.z].map(r), [-PYLON.w / 2, 0, -PYLON.d / 2]);
  assert.deepEqual([box.max.x, box.max.y, box.max.z].map(r), [PYLON.w / 2, PYLON.h, PYLON.d / 2]);
  assert.equal(lb.mesh.userData.colliderTag, 'pylon');
  lb.dispose();
});

test('ten ring lots: 4 / 3 / 3 over the faces, each lot on the face that looks toward it', () => {
  const view = boardViewFromSnapshot(L.initialSnapshot(borough(), true), LOTS);
  const split = FACE_DEG.map((_, k) => faceRows(view.rows, k).map((r) => r.lot));
  assert.deepEqual(split.map((s) => s.length), [4, 3, 3]);
  assert.deepEqual(split.flat().sort(), LOTS.map((l) => l.id).sort(), 'every lot on exactly one face');
  LOTS.forEach((lot) => {
    const k = split.findIndex((s) => s.includes(lot.id));
    const dots = FACE_DEG.map((d) => Math.cos((d - lot.deg) * Math.PI / 180));
    assert.equal(k, dots.indexOf(Math.max(...dots)), lot.id + ' is on the face nearest its angle');
    assert.equal(faceOfDeg(lot.deg), k);
  });
  const lb = createLeaderboard({ seed: 1 });
  lb.update(view);
  assert.deepEqual(lb.getDebugState().faces.map((f) => f.lots), split);
  assert.deepEqual(lb.getDebugState().faces.map((f) => f.overflow), [0, 0, 0]);
  lb.dispose();
});

test('counts match the borough fixture snapshot (gate 6): per lot, totals, and the digits painted on the boards', () => {
  const fx = borough(), snap = L.initialSnapshot(fx, true);
  assert.deepEqual(plain(snap.counts), { working: 8, waiting: 3, idle: 4, unknown: 2 });
  const view = boardViewFromSnapshot(snap, LOTS);
  assert.equal(view.offline, false);
  assert.equal(view.unmapped, 0, 'every borough department is a ring lot');
  view.rows.forEach((row) => assert.deepEqual(KEYS.map((k) => row[k]), BOROUGH[row.lot], row.lot));
  const sum = KEYS.reduce((a, k) => (a[k] = view.rows.reduce((s, r) => s + r[k], 0), a), {});
  assert.deepEqual(sum, plain(snap.counts), 'the rows add up to the snapshot counts');
  assert.deepEqual(view.totals, plain(snap.counts), 'the ALL row is the snapshot counts');
  assert.ok(view.rows.every((r) => r.lastEvidenceS === null), 'the fixture has no evidence times: ages are "—"');

  const lb = createLeaderboard({ seed: 1 });
  lb.update(view);
  for (const row of view.rows) {
    const f = faceWithLot(lb, row.lot);
    assert.equal(readEntry(f.image, entry(f.plan, row.lot, 'label')), row.label, row.lot + ' label');
    assert.equal(readEntry(f.image, entry(f.plan, row.lot, 'age')), '—', row.lot + ' age');
    ['working', 'waiting', 'idle'].forEach((k) => assert.equal(readEntry(f.image, entry(f.plan, row.lot, k)), counterText(row[k]), row.lot + ' ' + k));
    assert.equal(readEntry(f.image, entry(f.plan, row.lot, 'unknown')), '?' + counterText(row.unknown), row.lot + ' unknown');
  }
  for (const f of lb.faces) {
    assert.equal(readEntry(f.image, entry(f.plan, '*', 'label')), 'ALL');
    assert.deepEqual(KEYS.map((k) => readEntry(f.image, entry(f.plan, '*', k))), ['08', '03', '04', '?02'], 'ALL row on face ' + f.index);
    assert.equal(f.plan.texts.filter((t) => t.field === 'title').map((t) => readEntry(f.image, t)).join(' '), 'AGENT OFFICE');
    assert.ok(!f.plan.texts.some((t) => t.field === 'offline'), 'no OFFLINE band while the transport is up');
  }
  // agent-city: the scripted-timeline loop (main.js L.stepFixture / L.countsOf) is dropped; see PROVENANCE.md.
  lb.dispose();
});

test('offline: transport unavailable -> every counter "—" (never 0) and a red OFFLINE band on every face', () => {
  const fx = borough(), snap = L.initialSnapshot(fx, false);
  // main.js's world view hands every agent over as stale while offline: still offline, not "unknown".
  const worldView = { agents: snap.agents.map((a) => Object.assign({}, a, { freshness: 'stale' })), counts: snap.counts, transportAvailable: false };
  for (const s of [snap, worldView]) {
    const view = boardViewFromSnapshot(s, LOTS);
    assert.equal(view.offline, true);
    view.rows.forEach((r) => assert.deepEqual(KEYS.map((k) => r[k]), [null, null, null, null], r.lot));
    assert.deepEqual(view.totals, { working: null, waiting: null, idle: null, unknown: null });
    const lb = createLeaderboard({ seed: 1 });
    lb.update(view);
    for (const f of lb.faces) {
      const counters = f.plan.texts.filter((t) => KEYS.includes(t.field));
      assert.equal(counters.length, (faceRows(view.rows, f.index).length + 1) * 4);
      counters.forEach((t) => assert.equal(readEntry(f.image, t), t.field === 'unknown' ? '?—' : '—', 'face ' + f.index + ' ' + t.lot + ' ' + t.field));
      const band = f.plan.texts.find((t) => t.field === 'offline');
      assert.equal(readEntry(f.image, band), 'OFFLINE');
      let red = 0;
      for (let y = BOARD_LAYOUT.bandY; y < BOARD_LAYOUT.bandY + BOARD_LAYOUT.bandH; y++) for (let x = 0; x < FACE_W; x++) red += inkAt(f.image, x, y, BOARD_COLORS.offline) ? 1 : 0;
      assert.ok(red > 400, 'red band texels: ' + red);
    }
    lb.dispose();
  }
  // Before the first update the board knows nothing: it shows OFFLINE, not zeros.
  const fresh = createLeaderboard({ seed: 1 });
  assert.equal(readEntry(fresh.faces[0].image, fresh.faces[0].plan.texts.find((t) => t.field === 'offline')), 'OFFLINE');
  fresh.dispose();
});

// agent-city: test 'live view: exact project bindings only, ...' dropped (needs renderer/live-bridge.mjs, not ported).

test('lit at dusk and night: board texels untinted (identical to day), only the steel frame, cap and plinth take the tint', () => {
  const view = boardViewFromSnapshot(L.initialSnapshot(borough(), true), LOTS);
  const day = createLeaderboard({ seed: 3 });
  day.update(view);
  for (const time of ['dusk', 'night']) {
    const look = TIME_PRESETS[time], lb = createLeaderboard({ seed: 3, look });
    lb.update(view);
    assert.equal(lb.getDebugState().time, time);
    lb.faces.forEach((f, k) => {
      assert.deepEqual([f.material.color.r, f.material.color.g, f.material.color.b], [1, 1, 1], 'board material untinted');
      let frameDiff = 0;
      for (let y = 0; y < FACE_H; y++) for (let x = 0; x < FACE_W; x++) {
        const i = (y * FACE_W + x) * 4, same = [0, 1, 2, 3].every((c) => f.image.data[i + c] === day.faces[k].image.data[i + c]);
        if (!isFrameTexel(x, y)) assert.ok(same, time + ' face ' + k + ' board texel ' + x + ',' + y + ' is lit (untinted)');
        else if (!same) frameDiff++;
      }
      assert.ok(frameDiff > 2 * (FACE_W + FACE_H), time + ' frame texels tinted: ' + frameDiff);
    });
    const cap = lb.mesh.getObjectByName('leaderboard:cap').material.color, steel = RAMPS.steel[1];
    [cap.r, cap.g, cap.b].forEach((v, c) => assert.ok(Math.abs(v - steel[c] / 255 * look.tint[c]) < 1e-6, time + ' cap tinted'));
    // setLook on the day board repaints all three faces and lands on the same pixels as a board built at that time.
    const swapped = createLeaderboard({ seed: 3 });
    swapped.update(view);
    assert.deepEqual(swapped.setLook(look), [0, 1, 2]);
    swapped.faces.forEach((f, k) => assert.deepEqual(f.image.data, lb.faces[k].image.data));
    lb.dispose(); swapped.dispose();
  }
  day.dispose();
});

test('deterministic per seed; update repaints only the faces whose content changed', () => {
  const view = boardViewFromSnapshot(L.initialSnapshot(borough(), true), LOTS);
  const a = createLeaderboard({ seed: 7 }), b = createLeaderboard({ seed: 7 }), c = createLeaderboard({ seed: 8 });
  [a, b, c].forEach((lb) => assert.deepEqual(lb.update(view), [0, 1, 2]));
  a.faces.forEach((f, k) => {
    assert.deepEqual(f.image.data, b.faces[k].image.data, 'same seed, same texels');
    assert.deepEqual(f.texture.image.data, b.faces[k].texture.image.data);
    assert.deepEqual(f.image.data, paintFace(planFace(view, k), TIME_PRESETS.day, 7).data, 'the texture is its display list painted');
    let frame = 0;
    for (let y = 0; y < FACE_H; y++) for (let x = 0; x < FACE_W; x++) {
      const i = (y * FACE_W + x) * 4, same = f.image.data[i] === c.faces[k].image.data[i] && f.image.data[i + 1] === c.faces[k].image.data[i + 1];
      if (!isFrameTexel(x, y)) assert.ok(same, 'the seed only changes the frame speckle');
      else if (!same) frame++;
    }
    assert.ok(frame > 0, 'another seed speckles the frame differently');
  });
  const versions = () => a.faces.map((f) => f.texture.version);
  const v0 = versions();
  assert.deepEqual(a.update(view), [], 'same view: nothing repainted');
  assert.deepEqual(a.update(boardViewFromSnapshot(L.initialSnapshot(borough(), true), LOTS)), [], 'an equal view: nothing repainted');
  assert.deepEqual(versions(), v0);
  const aged = plain(view), kPlan = faceWithLot(a, 'planning').index;
  aged.rows.find((r) => r.lot === 'planning').lastEvidenceS = 120;
  assert.deepEqual(a.update(aged), [kPlan], 'a new age repaints only the face that lists the lot');
  assert.deepEqual(versions(), v0.map((v, k) => (k === kPlan ? v + 1 : v)));
  aged.rows.find((r) => r.lot === 'planning').lastEvidenceS = 150;
  assert.deepEqual(a.update(aged), [], '120 s and 150 s both read "2m": no repaint');
  const busier = plain(aged), kEng = faceWithLot(a, 'engineering').index;
  busier.rows.find((r) => r.lot === 'engineering').working = 3;
  busier.totals.working = 9;
  assert.deepEqual(a.update(busier), [0, 1, 2], 'a count change moves the ALL row, which every face shows');
  busier.rows.find((r) => r.lot === 'engineering').working = 4;
  assert.deepEqual(a.update(busier), [kEng], 'a row change with the same totals repaints only its face');
  [a, b, c].forEach((lb) => lb.dispose());
});

test('layout: every string stays inside the frame and clear of the others, for the widest values', () => {
  const rows = ['WWWWWW', 'MMMMMM', 'LOT 10', 'ENGINR'].map((label, i) => ({
    lot: 'w' + i, label, deg: 90, working: 100, waiting: 99, idle: 0, unknown: 1234, lastEvidenceS: [1e9, 59, 3599, 86399][i]
  }));
  const views = [{ title: 'AGENT OFFICE', rows, offline: false, totals: { working: 999, waiting: 99, idle: 9, unknown: 99 } },
    { title: 'AGENT OFFICE', rows, offline: true }];
  for (const view of views) {
    const plan = planFace(view, 0), B = BOARD_LAYOUT.border;
    assert.equal(plan.overflow, 0);
    const boxes = plan.texts.map((t) => ({ t, x0: t.x, x1: t.x + boardTextWidth(t.s) - 1, y0: t.y, y1: t.y + 4 }));
    boxes.forEach((b) => {
      assert.ok(b.t.s.length > 0, 'nothing empty: ' + JSON.stringify(b.t));
      assert.ok(b.x0 >= B + 1 && b.x1 <= FACE_W - B - 2 && b.y0 >= B && b.y1 <= FACE_H - B - 1, 'inside the frame: ' + b.t.s + ' at ' + b.x0 + '..' + b.x1);
    });
    boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => {
      const apart = a.x1 + 1 < b.x0 || b.x1 + 1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0;
      assert.ok(apart, '"' + a.t.s + '" and "' + b.t.s + '" overlap');
    }));
    const img = paintFace(plan, TIME_PRESETS.day, 1);
    plan.texts.forEach((t) => assert.equal(readEntry(img, t), t.s, 'painted as planned: ' + t.s));
  }
});

test('formats: 2-digit counters (null -> "—"), ages of at most 4 characters, digits distinct from look-alike letters', () => {
  assert.deepEqual([null, undefined, NaN, 0, 7, 42, 99, 123].map(counterText), ['—', '—', '—', '00', '07', '42', '99', '99']);
  const ages = [null, -1, 0, 59, 60, 3599, 3600, 86399, 86400, 99 * 86400, 1e9].map(formatAge);
  assert.deepEqual(ages, ['—', '—', '0s', '59s', '1m', '59m', '1h', '23h', '1d', '99d', '99d+']);
  ages.forEach((a) => assert.ok([...a].length <= 4, a));
  for (const [d, l] of [['0', 'O'], ['1', 'I'], ['2', 'Z'], ['5', 'S'], ['6', 'G'], ['8', 'B']]) {
    assert.notDeepEqual(GLYPHS.get(d).img.data, GLYPHS.get(l).img.data, d + ' vs ' + l);
  }
});
