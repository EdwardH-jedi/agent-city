// M2.8 Phase F: the town (plaza + six departments) as data for the WebGL renderer. TownWorld (app/town-world.js) stays the
// authority for movement, collision, doors, agents and the camera; this file mirrors its town plan so the meshes stand
// exactly where TownWorld collides. tests/m27/town-webgl.test.mjs checks it against TownWorld's getDebugState()
// (buildings, doors, parks, walk bounds, collider count). Nothing here feeds collision.
// Axes as TownWorld: plaza centre at the origin, north = -z (Engineering), south = +z (QA Lab).

export const TOWN_WALK = Object.freeze({ x0: -46, x1: 46, z0: -44, z1: 23 });
export const TOWN_CAM = Object.freeze({ x0: -36, x1: 36, z0: -38, z1: 30 });
export const PLAZA = Object.freeze({ x0: -14, x1: 14, z0: -12, z1: 12 });
export const LANTERN_ROW = Object.freeze({ x0: -16, x1: -11, z0: -44, z1: -20 });
export const PARKS = Object.freeze([
  { x0: -46, x1: -14, z0: -12, z1: -4 }, { x0: 14, x1: 46, z0: -12, z1: -4 },
  { x0: -46, x1: -14, z0: 4, z1: 12 }, { x0: 14, x1: 46, z0: 4, z1: 12 }
].map(Object.freeze));
export const YAW_TO_SOUTH = 4.7, YAW_TO_NORTH = 4.15;
export const DOORS = Object.freeze({
  planning: Object.freeze({ x: -22, z: -20 }), engineering: Object.freeze({ x: 0, z: -23 }), research: Object.freeze({ x: 22, z: -20 }),
  design: Object.freeze({ x: -22, z: 20 }), qa: Object.freeze({ x: 0, z: 23 }), operations: Object.freeze({ x: 22, z: 20 })
});

// Department buildings: TownWorld footprint, front and height `h`, plus the facade generator's look. `vh` is the drawn height:
// renderer/facade-gen.mjs paints whole 3-unit floors (+ an optional 1.5 attic), so h is rounded to the nearest 1.5
// (16 -> 16.5, 12.5 -> 12, 14 -> 13.5, 22 -> 22.5). Height is visual only; TownWorld collides in 2D.
export const DEPARTMENTS = Object.freeze([
  { dept: 'planning', title: 'PLANNING', x0: -46, x1: -16, z0: -38, z1: -20, h: 15, vh: 15, front: 'south', family: 'brick', wall: 'brick', awning: 'mustard', entrance: true, seed: 31 },
  { dept: 'engineering', title: 'ENGINEERING', x0: -11, x1: 11, z0: -47, z1: -23, h: 22, vh: 22.5, front: 'south', family: 'glass', wall: 'glass', awning: 'teal', entrance: false, seed: 32 },
  { dept: 'research', title: 'RESEARCH', x0: 16, x1: 46, z0: -38, z1: -20, h: 16, vh: 16.5, front: 'south', family: 'stone', wall: 'sand', awning: 'teal', entrance: true, seed: 33 },
  { dept: 'design', title: 'DESIGN', x0: -46, x1: -16, z0: 20, z1: 38, h: 12, vh: 12, front: 'north', family: 'shopfront', wall: 'rose', awning: 'rust', entrance: true, seed: 34 },
  { dept: 'qa', title: 'QA LAB', x0: -11, x1: 11, z0: 23, z1: 47, h: 14, vh: 13.5, front: 'north', family: 'stone', wall: 'plaster', awning: 'mustard', entrance: false, seed: 35 },
  { dept: 'operations', title: 'OPERATIONS', x0: 16, x1: 46, z0: 20, z1: 38, h: 12.5, vh: 12, front: 'north', family: 'brick', wall: 'rust', awning: 'mustard', entrance: false, seed: 36 }
].map(Object.freeze));

// Surrounding blocks (TownWorld FILLERS, same order). Plain blocks repeat a facade family's floor tile on every side; the three
// kiosks and the Lantern Row end wall get a generated facade on their street face (`face`), drawn at `vh`.
const FILLER_LOOK = { sand: ['stone', 'sand'], plaster: ['brick', 'plaster'], terra: ['brick', 'brick'], cream: ['shopfront', 'ochre'], slate: ['glass', 'steel'] };
export const FILLERS = Object.freeze([
  { x0: -64, x1: -46, z0: -64, z1: -20, h: 19, ramp: 'sand' }, { x0: -64, x1: -46, z0: -20, z1: 20, h: 10, ramp: 'plaster' },
  { x0: -64, x1: -46, z0: 20, z1: 64, h: 17, ramp: 'terra' }, { x0: 46, x1: 64, z0: -64, z1: -20, h: 18, ramp: 'plaster' },
  { x0: 46, x1: 64, z0: -20, z1: 20, h: 10, ramp: 'sand' }, { x0: 46, x1: 64, z0: 20, z1: 64, h: 19, ramp: 'cream' },
  { x0: -46, x1: -16, z0: -64, z1: -38, h: 19, ramp: 'cream' },
  { x0: -16, x1: -11, z0: -64, z1: -44, h: 16, vh: 16.5, ramp: 'terra', face: 'south', sign: null, door: -13.5, wall: 'brick', family: 'brick', awning: 'rust', alleyEnd: true },
  { x0: -11, x1: 16, z0: -64, z1: -47, h: 26, ramp: 'slate' }, { x0: 16, x1: 46, z0: -64, z1: -38, h: 18, ramp: 'sand' },
  { x0: -46, x1: -16, z0: 38, z1: 64, h: 16, ramp: 'plaster' }, { x0: -16, x1: 16, z0: 47, z1: 64, h: 20, ramp: 'sand' },
  { x0: 16, x1: 46, z0: 38, z1: 64, h: 17, ramp: 'cream' },
  { x0: 11, x1: 16, z0: -47, z1: -20, h: 6.5, vh: 6, ramp: 'cream', face: 'south', sign: 'COFFEE', door: 13.5, family: 'shopfront', wall: 'plaster', awning: 'rust' },
  { x0: -16, x1: -11, z0: 20, z1: 47, h: 6, vh: 6, ramp: 'plaster', face: 'north', sign: 'BOOKS', door: -13.5, family: 'shopfront', wall: 'sand', awning: 'teal' },
  { x0: 11, x1: 16, z0: 20, z1: 47, h: 6.5, vh: 6, ramp: 'sand', face: 'north', sign: 'BIKES', door: 13.5, family: 'shopfront', wall: 'olive', awning: 'teal' }
].map((f, i) => Object.freeze(Object.assign({ id: 'filler' + i, family: FILLER_LOOK[f.ramp][0], wall: FILLER_LOOK[f.ramp][1] }, f))));
export const SOLIDS = Object.freeze([...DEPARTMENTS, ...FILLERS]);

// Street furniture and fixtures, in TownWorld's order. `rect` = TownWorld's collider (null = walk-over / overhead decor).
// kind picks the mesh in scene-town.mjs. The 46 collider-carrying entries + 6 buildings + 16 fillers = TownWorld's 68 colliders.
const r = (x0, x1, z0, z1) => Object.freeze({ x0, x1, z0, z1 });
const around = (x, z, h) => r(x - h, x + h, z - h, z + h);
export const FIXTURES = Object.freeze([
  ...[-24.7, -19.3].map((x, i) => ({ id: 'planning-planter' + i, kind: 'door-planter', rect: r(x - 0.4, x + 0.4, -19.9, -19.1), h: 0.6 })),
  { id: 'planning-board', kind: 'board', rect: around(-27.4, -18.7, 0.3) },
  { id: 'eng-step0', kind: 'step', rect: null, box: [-6, 6, 0, 0.22, -21, -20] },
  { id: 'eng-step1', kind: 'step', rect: null, box: [-6, 6, 0, 0.44, -22, -21] },
  { id: 'eng-step2', kind: 'step', rect: null, box: [-6, 6, 0, 0.66, -23, -22] },
  { id: 'eng-planter0', kind: 'bed', rect: r(-11, -6, -23, -20), h: 0.9 },
  { id: 'eng-planter1', kind: 'bed', rect: r(6, 11, -23, -20), h: 0.9 },
  ...[18.6, 20.4, 23.6, 25.4].map((x, i) => ({ id: 'research-column' + i, kind: 'column', rect: r(x - 0.3, x + 0.3, -18.5, -17.9), h: 4.6 })),
  { id: 'research-entablature', kind: 'entablature', rect: null, box: [17.9, 26.1, 4.6, 5.6, -20, -17.7] },
  { id: 'research-board', kind: 'board', rect: around(28.2, -18.7, 0.3) },
  ...[-24.4, -19.6].map((x, i) => ({ id: 'design-planter' + i, kind: 'door-planter', rect: r(x - 0.4, x + 0.4, 19.1, 19.9), h: 0.6 })),
  ...[-3.2, 3.2].map((x, i) => ({ id: 'qa-bollard' + i, kind: 'bollard', rect: r(x - 0.18, x + 0.18, 20.8, 21.16), h: 0.9 })),
  { id: 'qa-canopy', kind: 'canopy', rect: null, box: [-2.4, 2.4, 4.0, 4.2, 21.9, 23] },
  { id: 'ops-canopy', kind: 'canopy', rect: null, box: [20.2, 23.8, 3.45, 3.65, 18.9, 20] },
  { id: 'ops-cabinet', kind: 'cabinet', rect: r(28, 29.2, 19.2, 20), h: 1.5 },
  { id: 'fountain', kind: 'fountain', rect: r(-2.4, 2.4, -2.4, 2.4), h: 0.75 },
  ...[[-10.5, -8.5], [10.5, -8.5], [-10.5, 8.5], [10.5, 8.5]].map(([x, z], i) => ({ id: 'plaza-tree' + i, kind: 'tree-planter', rect: around(x, z, 1.1), h: 0.7 })),
  ...[[-6.5, -8, 1], [6.5, -8, 1], [-6.5, 8, -1], [6.5, 8, -1]].map(([x, z, s], i) => ({ id: 'bench' + i, kind: 'bench', rect: r(x - 1.3, x + 1.3, z - 0.35, z + 0.35), faces: s > 0 ? 'south' : 'north' })),
  ...[[-4.4, -4.4], [4.4, -4.4], [-4.4, 4.4], [4.4, 4.4]].map(([x, z], i) => ({ id: 'plaza-lamp' + i, kind: 'lamp', rect: around(x, z, 0.18), faces: z < 0 ? 'south' : 'north' })),
  ...[-40, -30, 30, 40].flatMap((x, i) => [
    { id: 'street-lamp-n' + i, kind: 'lamp', rect: around(x, -17.9, 0.18), faces: 'south' },
    { id: 'street-lamp-s' + i, kind: 'lamp', rect: around(x, 17.9, 0.18), faces: 'north' }
  ]),
  { id: 'mailbox', kind: 'mailbox', rect: r(12.3, 12.9, -18.9, -18.4), faces: 'south' },
  { id: 'utility0', kind: 'utility', rect: r(-17.6, -16.7, -19.9, -19.3), h: 1.2 },
  ...PARKS.map((p, i) => ({ id: 'park' + i, kind: 'park', rect: p })),
  { id: 'crate0', kind: 'crate', rect: r(-15.8, -15.0, -27.2, -26.4), h: 0.8 },
  { id: 'crate0-top', kind: 'crate', rect: null, box: [-15.75, -15.1, 0.8, 1.45, -27.1, -26.5] },
  { id: 'crate1', kind: 'crate', rect: r(-15.85, -14.95, -26.3, -25.4), h: 0.9 },
  { id: 'utility1', kind: 'utility', rect: r(-11.6, -11.0, -30.5, -29.3), h: 1.3 },
  { id: 'row-bin', kind: 'bin', rect: r(-15.7, -15.0, -36.5, -35.8), faces: 'east' },
  { id: 'row-bridge', kind: 'bridge', rect: null, box: [-16, -11, 6.6, 9.2, -33, -30.6] },
  { id: 'row-sign', kind: 'sign', rect: null, box: [-16.3, -10.7, 5.0, 6.0, -20.4, -20.0], text: 'LANTERN ROW' }
].map(Object.freeze));

// Every TownWorld collider rect, in TownWorld's order (buildings, fillers, then furniture).
export function colliderRects() {
  return [
    ...DEPARTMENTS.map((b) => ({ x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, tag: 'building:' + b.dept })),
    ...FILLERS.map((f) => ({ x0: f.x0, x1: f.x1, z0: f.z0, z1: f.z1, tag: f.sign ? 'kiosk' : 'block' })),
    ...FIXTURES.filter((f) => f.rect).map((f) => Object.assign({ tag: f.kind + ':' + f.id }, f.rect))
  ];
}

// Ground height under the player (TownWorld townHeight: the Engineering steps).
export function townHeight(x, z) {
  if (x >= -6 && x <= 6 && z >= -23 && z < -20) return z < -22 ? 0.66 : z < -21 ? 0.44 : 0.22;
  return 0;
}

const inR = (q, x, z) => x >= q.x0 && x < q.x1 && z >= q.z0 && z < q.z1;
const DOOR_MATS = DEPARTMENTS.filter((b) => b.dept !== 'engineering').map((b) => {
  const d = DOORS[b.dept];
  return b.front === 'south' ? { x0: d.x - 1.3, x1: d.x + 1.3, z0: d.z, z1: d.z + 1.1, wall: b.awning } : { x0: d.x - 1.3, x1: d.x + 1.3, z0: d.z - 1.1, z1: d.z, wall: b.awning };
});
// Ground zones (port of TownWorld groundKind): what the surface at (x, z) is made of.
export function groundKind(x, z) {
  for (const s of SOLIDS) if (inR(s, x, z)) return 'under';
  for (const m of DOOR_MATS) if (inR(m, x, z)) return 'mat';
  if (x >= -5 && x < 5 && ((z >= -17.2 && z < -12.4) || (z >= 12.4 && z < 17.2))) return 'cross';
  if (x >= -11 && x < 11 && z >= 20 && z < 23) return (x >= -2.6 && x < 2.6 && z >= 21.4) ? 'hazard' : 'qacourt';
  if (x >= -11 && x < 11 && z >= -23 && z < -20) return 'court';
  if (inR(LANTERN_ROW, x, z)) return Math.abs(x + 13.5) < 0.35 ? 'gutter' : 'alley';
  if (inR(PLAZA, x, z)) return 'plaza';
  if (x >= -46 && x < 46) {
    if (z >= -20 && z < -17.5) return 'walk';
    if (z >= -17.5 && z < -17.2) return 'curb';
    if (z >= -17.2 && z < -12) return 'road';
    if (z >= 17.5 && z < 20) return 'walk';
    if (z >= 17.2 && z < 17.5) return 'curb';
    if (z >= 12 && z < 17.2) return 'road';
    if (z >= -4 && z < 4) return 'ave';
  }
  for (const p of PARKS) if (inR(p, x, z)) return 'park';
  return 'under';
}
export function doorMatAt(x, z) { return DOOR_MATS.find((m) => inR(m, x, z)) || null; }
