// M2.8 Phase B: facade generator (renderer/facade-gen.mjs) and the alley buildings built from it. Headless (no GL).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, NearestFilter } from 'three';
import { BUILDINGS } from '../alley-layout.mjs';
import { buildAlleyScene } from '../scene-alley.mjs';
import { facadeSpec } from '../alley-meshes.mjs';
import { resolvePreset } from '../presets.mjs';
import { PX_PER_UNIT, BAND_W, BAND_H, OUTLINE } from '../textures.mjs';
import { FAMILIES, makeFacade, makeEndBand, planTrim, paintTrimFace, texels } from '../facade-gen.mjs';

const AXES = ['x', 'x', 'y', 'y', 'z', 'z'];   // BoxGeometry material groups: +x, -x, +y, -y, +z, -z
const faceSize = (p, ax) => (ax === 'x' ? [p.depth, p.height] : ax === 'y' ? [p.width, p.depth] : [p.width, p.height]);
const trimImages = (spec) => planTrim(spec).flatMap((t) => {
  const [sx, sy, sz] = t.size;
  return [['x', sz, sy], ['y', sx, sz], ['z', sx, sy]].map(([ax, w, h]) => paintTrimFace(t.kind, ax, texels(w), texels(h), spec));
});
const px = (img, x, y) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));
function count(img, rgb) {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i] === rgb[0] && img.data[i + 1] === rgb[1] && img.data[i + 2] === rgb[2]) n++;
  return n;
}

test('facade generator: deterministic per seed, differs across seeds, 16 texels per world unit, 32 x 48 side tile', () => {
  for (const b of BUILDINGS) {
    const s = facadeSpec(b, 1), f = makeFacade(s);
    assert.deepEqual([f.width, f.height], [(b.z1 - b.z0) * PX_PER_UNIT, b.h * PX_PER_UNIT], b.id + ' facade size');
    assert.deepEqual(makeFacade(facadeSpec(b, 1)).data, f.data, b.id + ' facade is deterministic');
    assert.notDeepEqual(makeFacade(facadeSpec(b, 2)).data, f.data, b.id + ' facade depends on the seed');
    const band = makeEndBand(s);
    assert.deepEqual([band.width, band.height], [BAND_W, BAND_H], b.id + ' side tile');
    assert.deepEqual(makeEndBand(facadeSpec(b, 1)).data, band.data, b.id + ' side tile is deterministic');
    assert.deepEqual(planTrim(facadeSpec(b, 1)), planTrim(s), b.id + ' trim plan is deterministic');
    assert.deepEqual(trimImages(facadeSpec(b, 1)).map((i) => i.data), trimImages(s).map((i) => i.data), b.id + ' trim textures');
  }
  assert.throws(() => texels(0.3), /multiple of 1\/16/);
  assert.throws(() => makeFacade(Object.assign(facadeSpec(BUILDINGS[0], 1), { family: 'nope' })));
});

test('four families give four different facades; facades and side tiles opaque, trim alpha binary; doors and windows outlined', () => {
  assert.deepEqual([...FAMILIES], ['brick', 'stone', 'glass', 'shopfront']);
  const base = { wall: 'plaster', awning: 'teal', width: 8, height: 9, seed: 5, doorU: 3 };
  const imgs = FAMILIES.map((family) => makeFacade(Object.assign({ family }, base)));
  for (let i = 0; i < imgs.length; i++) for (let j = i + 1; j < imgs.length; j++) assert.notDeepEqual(imgs[i].data, imgs[j].data, FAMILIES[i] + ' vs ' + FAMILIES[j]);
  for (const b of BUILDINGS) {
    const s = facadeSpec(b, 1), f = makeFacade(s), band = makeEndBand(s);
    for (const img of [f, band]) for (let i = 3; i < img.data.length; i += 4) assert.equal(img.data[i], 255, b.id + ' opaque');
    for (const img of trimImages(s)) for (let i = 3; i < img.data.length; i += 4) assert.ok(img.data[i] === 0 || img.data[i] === 255, b.id + ' binary alpha');
    const dx = Math.max(2, Math.min(f.width - 34, Math.round(b.door * PX_PER_UNIT)));
    assert.deepEqual(px(f, dx, f.height - 20), OUTLINE, b.id + ' door has a 1 px dark outline');
    assert.ok(count(band, OUTLINE) >= 40, b.id + ' side tile windows are outlined (' + count(band, OUTLINE) + ' px)');
  }
});

test('alley: >= 8 buildings, all four families, >= 3 heights; the first 20 units from spawn show >= 3 families and heights', () => {
  assert.ok(BUILDINGS.length >= 8, 'buildings ' + BUILDINGS.length);
  assert.deepEqual(new Set(BUILDINGS.map((b) => b.family)), new Set(FAMILIES));
  assert.ok(new Set(BUILDINGS.map((b) => b.h)).size >= 3, 'heights');
  const near = BUILDINGS.filter((b) => b.z1 > -20);
  assert.ok(new Set(near.map((b) => b.family)).size >= 3, 'families near spawn');
  assert.ok(new Set(near.map((b) => b.h)).size >= 3, 'heights near spawn');
  for (const side of ['west', 'east']) assert.ok(new Set(BUILDINGS.filter((b) => b.side === side).map((b) => b.family)).size >= 3, side + ' mixes families');
  assert.equal(BUILDINGS.filter((b) => b.fireEscape).length, 1, 'one fire escape');
  assert.ok(BUILDINGS.some((b) => b.balcony) && BUILDINGS.some((b) => b.blade) && BUILDINGS.some((b) => b.drainpipe != null), 'balcony, lit blade sign, drainpipe');
});

test('every textured face of every building and its trim maps 16 texels per world unit (side faces included); nearest, no mipmaps', () => {
  const world = buildAlleyScene(resolvePreset('alley'), 1, 2);
  let faces = 0;
  for (const b of BUILDINGS) {
    const root = world.meshes.colliders.get('building:' + b.id);
    root.traverse((m) => {
      if (!m.isMesh) return;
      const p = m.geometry.parameters, mats = Array.isArray(m.material) ? m.material : AXES.map(() => m.material);
      assert.deepEqual([m.scale.x, m.scale.y, m.scale.z], [1, 1, 1], m.name + ' unscaled');
      mats.forEach((mat, g) => {
        if (!mat.map) { assert.equal(m, root, m.name + ': every trim face is textured'); return; }
        const [fw, fh] = faceSize(p, AXES[g]), t = mat.map;
        assert.equal(t.image.width * t.repeat.x / fw, 16, m.name + ' face ' + g + ' u');
        assert.equal(t.image.height * t.repeat.y / fh, 16, m.name + ' face ' + g + ' v');
        assert.equal(t.magFilter, NearestFilter); assert.equal(t.minFilter, NearestFilter); assert.equal(t.generateMipmaps, false);
        faces++;
      });
      const uv = m.geometry.attributes.uv.array;
      assert.deepEqual([Math.min(...uv), Math.max(...uv)], [0, 1], m.name + ' uv range');
    });
    // Primary box: facade + both end faces textured. Back, roof and underside face away from the street (flat colour).
    const textured = root.material.map((mt, g) => (mt.map ? g : -1)).filter((g) => g >= 0);
    assert.deepEqual(textured, b.side === 'west' ? [0, 4, 5] : [1, 4, 5], b.id + ' textured faces');
  }
  assert.ok(faces > 300, 'faces checked: ' + faces);
  world.dispose();
});

test('trim: cornice, parapet and 1-2 rooftop boxes on every building; fire-escape decks per upper floor; street-side trim clears head height', () => {
  const world = buildAlleyScene(resolvePreset('alley'), 1, 2);
  for (const b of BUILDINGS) {
    const root = world.meshes.colliders.get('building:' + b.id), names = root.children.map((c) => c.name);
    assert.ok(names.includes('cornice:' + b.id) && names.includes('parapet:' + b.id), b.id + ' cornice + parapet');
    const roof = names.filter((n) => n.startsWith('roof:') && !n.includes(':stand:'));
    assert.ok(roof.length >= 1 && roof.length <= 2, b.id + ' rooftop boxes: ' + roof.length);
    if (b.fireEscape) assert.equal(names.filter((n) => /^fire-escape:\d+:deck:/.test(n)).length, Math.floor((b.h - 3) / 3), b.id + ' decks');
    root.updateMatrixWorld(true);
    for (const c of root.children) {
      const box = new Box3().setFromObject(c);
      if (/^(roof|parapet):/.test(c.name)) assert.ok(box.min.y >= b.h - 1e-9, c.name + ' stands on the roof');
      assert.ok(box.min.z >= b.z0 - 1e-9 && box.max.z <= b.z1 + 1e-9, c.name + ' stays within its lot');
      // Anything over the street (x in -3..3) is a low step or sits above the 2.5-unit sprite height.
      const overStreet = box.max.x > -3 + 1e-9 && box.min.x < 3 - 1e-9;
      if (overStreet && !c.name.startsWith('stoop:')) assert.ok(box.min.y > 2.5, c.name + ' clears head height: ' + box.min.y);
    }
  }
  world.dispose();
});
