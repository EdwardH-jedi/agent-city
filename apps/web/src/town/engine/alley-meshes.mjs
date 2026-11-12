// Buildings, props and the exit doorway for the alley (M2.7 §3.3), built from alley-layout.mjs.
// Every mesh that has a collision rect carries userData.colliderTag; its bounding box equals that rect exactly.
import {
  Mesh, Group, BoxGeometry, PlaneGeometry, MeshBasicMaterial, Sprite, SpriteMaterial, DataTexture, RGBAFormat, UnsignedByteType,
  NearestFilter, RepeatWrapping, ClampToEdgeWrapping, Color, AdditiveBlending
} from 'three';
import { BUILDINGS, PROPS, EXIT_DOOR } from './alley-layout.mjs';
import { PX_PER_UNIT, BAND_W, BAND_H, RAMPS, flipRows, makeDoorFrameImage, tintImage } from './textures.mjs';
import { makeFacade, makeEndBand, planTrim, paintTrimFace, texels } from './facade-gen.mjs';
import { makeRoad, makePavement, planStreet, planProp, faceRoles, faceTexels, paintPropFace, makeCanopy, makeGlow } from './street-gen.mjs';
import { TIME_PRESETS } from './presets.mjs';

// Raw sRGB bytes -> Color without any colour-space conversion (independent of ColorManagement's global flag).
export function rgbColor(rgb) { return new Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255); }
export const GLOW_SIZE = 2;             // lamp glow sprite, world units (32 texels)
const SIDE_TINT = rgbColor([214, 214, 214]); // end faces are a touch darker than the facade (cheap form shading)

export function pixelTexture(img, wrap) {
  const f = flipRows(img);
  const t = new DataTexture(f.data, f.width, f.height, RGBAFormat, UnsignedByteType);
  t.magFilter = t.minFilter = NearestFilter;
  t.generateMipmaps = false;
  t.wrapS = t.wrapT = wrap || ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}
function basic(map, color) { return new MeshBasicMaterial({ map: map || null, color: color || new Color(1, 1, 1) }); }

// Generator spec of one layout building (renderer/facade-gen.mjs); `seed` is the scene seed.
export function facadeSpec(b, seed) {
  return {
    family: b.family, wall: b.wall, awning: b.awning, width: b.z1 - b.z0, height: b.h, seed: (seed || 0) + b.seed, doorU: b.door,
    sign: b.sign || null, entrance: !!b.entrance, drainpipe: b.drainpipe, fireEscape: b.fireEscape, balcony: b.balcony, blade: b.blade
  };
}

// One facade building (M2.8 Phase B/D), shared by the alley and (Phase F) the town. b uses the alley-layout schema: footprint
// x0..x1 / z0..z1, side 'west' (facade on +x, u from the +z end) or 'east' (facade on -x, u from the -z end), h, family, wall,
// door, details. The town builds every building in this frame as a 'west' lot and rotates it into place.
// ctx: { look, track, note } (look = resolved time-of-day fields; track/note collect disposables and the texture inventory).
export function buildFacadeBuilding(b, seed, ctx) {
  const look = ctx.look || TIME_PRESETS.day, track = ctx.track, note = ctx.note || (() => {});
  const WHITE = new Color(1, 1, 1), TINT = new Color().setRGB(...look.tint);
  const tinted = (c) => c.clone().multiply(TINT);
  const plain = look.lit === 0 && look.tint.every((v) => v === 1);
  const len = b.z1 - b.z0, depth = b.x1 - b.x0, h = b.h, wall = b.wall, cz = (b.z0 + b.z1) / 2;
  const spec = facadeSpec(b, seed);
  const facadeImg = makeFacade(spec), litImg = look.lit ? makeFacade(Object.assign({}, spec, { lit: look.lit })) : facadeImg;
  const shownImg = plain ? facadeImg : tintImage(litImg, look.tint, facadeImg);
  note('facade:' + b.id, shownImg, litImg.windows);
  const facadeTex = track(pixelTexture(shownImg, ClampToEdgeWrapping));
  const bandImg = makeEndBand(spec);
  const endTex = track(pixelTexture(bandImg, RepeatWrapping));
  endTex.repeat.set(depth * PX_PER_UNIT / BAND_W, h * PX_PER_UNIT / BAND_H); // exact tiling: depth/2 x h/1.5
  note('end-band:' + b.id, bandImg);
  const facadeMat = track(basic(facadeTex));
  const endMat = track(basic(endTex, tinted(SIDE_TINT)));
  const backMat = track(basic(null, tinted(rgbColor(RAMPS[wall][1]))));
  const roofMat = track(basic(null, tinted(rgbColor(RAMPS[wall][0]))));
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z
  const mats = b.side === 'west'
    ? [facadeMat, backMat, roofMat, roofMat, endMat, endMat]
    : [backMat, facadeMat, roofMat, roofMat, endMat, endMat];
  const geo = track(new BoxGeometry(depth, h, len));
  const mesh = new Mesh(geo, mats);
  mesh.position.set((b.x0 + b.x1) / 2, h / 2, cz);
  // Trim children (decor, not part of the collision footprint): cornice, parapet, rooftop boxes, and where the layout
  // asks for them an entrance stoop + canopy, fire escape, balcony, blade sign. Each face gets its own exact-size texture,
  // so every trim face is 16 texels per world unit. facadeX/out: the facade plane and the street-ward direction.
  const out = b.side === 'west' ? 1 : -1, facadeX = b.side === 'west' ? b.x1 : b.x0;
  planTrim(spec).forEach((t) => {
    const [sx, sy, sz] = t.size, m3 = {};
    for (const [ax, fw, fh] of [['x', sz, sy], ['y', sx, sz], ['z', sx, sy]]) {
      const tex = track(pixelTexture(paintTrimFace(t.kind, ax, texels(fw), texels(fh), spec)));
      m3[ax] = track(new MeshBasicMaterial({ map: tex, alphaTest: t.alpha ? 0.5 : 0, color: t.kind === 'blade' ? WHITE : TINT }));
    }
    const child = new Mesh(track(new BoxGeometry(sx, sy, sz)), [m3.x, m3.x, m3.y, m3.y, m3.z, m3.z]);
    const wz = b.side === 'west' ? b.z1 - t.a : b.z0 + t.a;
    child.position.set(facadeX + out * t.out - mesh.position.x, t.y + sy / 2 - h / 2, wz - cz);
    child.name = t.name + ':' + b.id;
    mesh.add(child);
  });
  mesh.userData.colliderTag = 'building:' + b.id;
  mesh.name = 'building:' + b.id;
  return mesh;
}

// look: a resolved preset's time-of-day fields (presets.mjs TIME_PRESETS; default day = no tint, nothing lit).
//  - Facades swap texture: painted with `lit` windows, then every texel that matches the unlit painting is multiplied by
//    the tint, so lit panes keep full brightness (one material cannot tint part of a texture).
//  - Every other material multiplies its colour by the tint (groundTint for the street surfaces). Lit lamp heads and the
//    blade sign stay untinted. With glow > 0 each lamp also gets an additive glow sprite (group 'lamp-glows').
export function buildAlleyMeshes(seed, look) {
  look = look || TIME_PRESETS.day;
  const group = new Group();
  const colliders = new Map();        // tag -> mesh (the primary footprint mesh)
  const disposables = [];
  const inventory = [];               // {name, width, height[, windows]} of every generated texture (for tests/docs)
  const track = (o) => { disposables.push(o); return o; };
  const note = (name, img, windows) => inventory.push(Object.assign({ name, width: img.width, height: img.height }, windows ? { windows } : {}));
  const WHITE = new Color(1, 1, 1), TINT = new Color().setRGB(...look.tint), GROUND = new Color().setRGB(...look.groundTint);
  const tinted = (c) => c.clone().multiply(TINT);
  const lampsLit = look.glow > 0;

  BUILDINGS.forEach((b) => {
    const mesh = buildFacadeBuilding(b, seed, { look, track, note });
    group.add(mesh);
    colliders.set(mesh.userData.colliderTag, mesh);
  });

  // Street layer (M2.8 Phase C, renderer/street-gen.mjs): flat road and pavement planes + thin curb boxes. Walk-over
  // surfaces, so no collider tags. Every face carries an exact-size texture: 16 texels per world unit.
  const s0 = (seed || 0) + 300;
  const boxPart = (size, paint, side, alpha, color) => {
    const mats = faceRoles(side).map((role) => {
      const [w, h] = faceTexels(size, role);
      return track(new MeshBasicMaterial({ map: track(pixelTexture(paint(role, w, h))), alphaTest: alpha ? 0.5 : 0, color: color || TINT }));
    });
    return new Mesh(track(new BoxGeometry(size[0], size[1], size[2])), mats);
  };
  planStreet().forEach((s) => {
    let m;
    if (s.kind === 'curb') m = boxPart(s.size, (role, w, h) => paintPropFace('curb', role, w, h, s0), s.side, false, GROUND);
    else {
      const img = s.kind === 'road' ? makeRoad(s0) : makePavement(s.side, s0);
      note(s.name, img);
      m = new Mesh(track(new PlaneGeometry(s.size[0], s.size[2])), track(basic(track(pixelTexture(img)), GROUND)));
      m.rotation.x = -Math.PI / 2;                     // image row 0 (v = 1) lands on the far (-z) end
    }
    m.position.set(s.at[0], s.at[1] + s.size[1] / 2, s.at[2]);
    m.name = s.name;
    group.add(m);
  });

  // Street furniture: the primary box's footprint IS the collider rect; the other parts are decor children.
  PROPS.forEach((p, k) => {
    const sd = s0 + 11 * (k + 1);
    let mesh = null, base = 0;
    planProp(p).forEach((part) => {
      let m;
      if (part.sprite) {
        const img = makeCanopy(texels(part.size[0]), texels(part.size[1]), sd);
        note('prop:' + p.id + ':' + part.name, img);
        m = new Sprite(track(new SpriteMaterial({ map: track(pixelTexture(img)), alphaTest: 0.5, transparent: false, depthWrite: true, color: TINT })));
        m.scale.set(part.size[0], part.size[1], 1);
        m.position.set(part.at[0], part.at[1] + part.size[1] / 2 - base, part.at[2]);
      } else {
        const lit = lampsLit && part.kind === 'lamp-head';
        m = boxPart(part.size, (role, w, h) => paintPropFace(part.kind, role, w, h, sd, lit), p.side, part.alpha, lit ? WHITE : TINT);
        if (part.primary) { base = part.at[1] + part.size[1] / 2; m.position.set(p.x + part.at[0], base, p.z + part.at[2]); }
        else m.position.set(part.at[0], part.at[1] + part.size[1] / 2 - base, part.at[2]);
      }
      m.name = part.name + ':' + p.id;
      if (part.primary) mesh = m; else mesh.add(m);
    });
    mesh.userData.colliderTag = 'prop:' + p.id;
    mesh.userData.kind = p.kind;
    mesh.name = 'prop:' + p.id;
    group.add(mesh);
    colliders.set(mesh.userData.colliderTag, mesh);
  });

  // Exit doorway at the near end: two low steel posts + a threshold mat (decor; the trigger lives in the layout/world).
  // Deliberately low and lintel-free: a tall frame sits between the camera and the player right after entering.
  const frameImg = makeDoorFrameImage(3);
  note('door-frame', frameImg);
  const frameMat = track(basic(track(pixelTexture(frameImg)), TINT));
  const matMat = track(basic(null, tinted(rgbColor(RAMPS.steel[0]))));
  const hw = EXIT_DOOR.halfWidth;
  // [centre x, size x, size y, size z, centre y, centre z, material]
  [[-hw - 0.125, 0.25, 1.4, 0.3, 0.7, EXIT_DOOR.z, frameMat], [hw + 0.125, 0.25, 1.4, 0.3, 0.7, EXIT_DOOR.z, frameMat],
    [0, 2 * hw, 0.04, 0.9, 0.02, EXIT_DOOR.z, matMat]].forEach((p) => {
    const geo = track(new BoxGeometry(p[1], p[2], p[3]));
    const m = new Mesh(geo, p[6]);
    m.position.set(p[0], p[4], p[5]);
    m.name = 'exit-frame';
    group.add(m);
  });

  // Lamp glows (dusk / night): one camera-facing sprite per lamp, centred on the lantern. Additive and untinted, not fogged
  // (a light reads through haze), depth-tested against the scene but writing no depth. Kept out of the prop subtrees: they
  // are light, not furniture (no collider, not part of any footprint).
  const glows = [];
  if (lampsLit) {
    const glowGroup = new Group();
    glowGroup.name = 'lamp-glows';
    const img = makeGlow(texels(GLOW_SIZE));
    note('lamp-glow', img);
    const glowMat = track(new SpriteMaterial({
      map: track(pixelTexture(img)), color: WHITE, opacity: look.glow, transparent: true, blending: AdditiveBlending,
      depthWrite: false, depthTest: true, fog: false
    }));
    PROPS.filter((p) => p.kind === 'lamp').forEach((p) => {
      const head = planProp(p).find((part) => part.kind === 'lamp-head');
      const g = new Sprite(glowMat);
      g.scale.set(GLOW_SIZE, GLOW_SIZE, 1);
      g.position.set(p.x + head.at[0], head.at[1] + head.size[1] / 2, p.z + head.at[2]);
      g.name = 'glow:' + p.id;
      glowGroup.add(g);
      glows.push(g);
    });
    group.add(glowGroup);
  }

  return { group, colliders, glows, inventory, dispose() { disposables.forEach((d) => d.dispose && d.dispose()); } };
}
