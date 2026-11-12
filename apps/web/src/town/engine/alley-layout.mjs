// Single source of truth for the `alley` scene (M2.7 §3.6): street, building footprints, props, door, spawn.
// The meshes (scene-alley.mjs) AND the collision world (alley-world.mjs) are both built from this data, so
// mesh footprints equal collision rects by construction (and tests assert it against the built meshes).
// Axes: x across the street, z along it. z = 0 is the near (door) end; the far end is at z = -40 (open sky, fog).
// The camera sits on the +z side looking toward -z, so "up" on screen is -z.

export const STREET = Object.freeze({ x0: -3, x1: 3, z0: -40, z1: 0 }); // 6 wide x 40 long
const DEPTH = 8; // building depth away from the street

// h is a multiple of 1.5: whole 3-unit floors, optionally plus a 1.5-unit attic row. `family` picks the facade generator
// (renderer/facade-gen.mjs: brick | stone | glass | shopfront); `wall` is its colour ramp from textures.mjs. `entrance: true`
// adds a 3D stoop + canopy at the door (decor, no collider). `door` = the door's left edge in world units along the facade,
// measured from the viewer's left (west facades: from the near end; east: from the far end, see doorCentreZ below).
// M2.8 Phase B: 9 lots. Details: drainpipe (u of the pipe), fireEscape (decks over u a..a+len), balcony (centre u, floor),
// blade (lit sign standing out into the street: centre u, bottom y, text). Heights stay 6..12 (tests/m27/alley-scene pins
// them; status/DECISIONS.md #18); the lowest lots sit mid-street and at the entrance, the 12-unit ones toward the far end.
export const BUILDINGS = Object.freeze([
  { id: 'w1', side: 'west', z0: -8, z1: 0, h: 9, seed: 11, family: 'shopfront', kind: 'shop', wall: 'rose', awning: 'teal', door: 5.0, entrance: true, sign: 'TOAST' },
  { id: 'w2', side: 'west', z0: -17, z1: -8, h: 12, seed: 12, family: 'brick', kind: 'flats', wall: 'brick', awning: 'rust', door: 2.5, drainpipe: 0.25, fireEscape: { a: 4, len: 3 } },
  { id: 'w3', side: 'west', z0: -23, z1: -17, h: 6, seed: 13, family: 'stone', kind: 'shop', wall: 'sand', awning: 'mustard', door: 2.0, entrance: true },
  { id: 'w4', side: 'west', z0: -31, z1: -23, h: 12, seed: 14, family: 'glass', kind: 'office', wall: 'glass', awning: 'teal', door: 3.0 },
  { id: 'w5', side: 'west', z0: -40, z1: -31, h: 10.5, seed: 15, family: 'brick', kind: 'flats', wall: 'rust', awning: 'mustard', door: 4.0 },
  { id: 'e1', side: 'east', z0: -10, z1: 0, h: 7.5, seed: 21, family: 'stone', kind: 'shop', wall: 'plaster', awning: 'rust', door: 2.0, entrance: true, balcony: { a: 7, floor: 1 } },
  { id: 'e2', side: 'east', z0: -21, z1: -10, h: 10.5, seed: 22, family: 'glass', kind: 'sportsgang', wall: 'steel', awning: 'sport', door: 1.0, sign: 'SPORTSGANG', entrance: true, blade: { a: 10.25, y: 4.25, text: 'SPORTS' } },
  { id: 'e3', side: 'east', z0: -30, z1: -21, h: 9, seed: 23, family: 'shopfront', kind: 'shop', wall: 'ochre', awning: 'mustard', door: 3.0, sign: 'PRINTS', drainpipe: 8.5 },
  { id: 'e4', side: 'east', z0: -40, z1: -30, h: 12, seed: 24, family: 'stone', kind: 'flats', wall: 'slate', awning: 'teal', door: 5.0 }
].map((b) => Object.freeze(Object.assign({}, b, b.side === 'west'
  ? { x0: STREET.x0 - DEPTH, x1: STREET.x0 }
  : { x0: STREET.x1, x1: STREET.x1 + DEPTH }))));

// World z of the centre of a building's door (the door is 2 units wide). u grows to the viewer's right: west facades
// (seen from +x) run from the near end toward -z; east facades (seen from -x) run from -z toward the near end.
export function doorCentreZ(b) { return b.side === 'west' ? b.z1 - (b.door + 1) : b.z0 + b.door + 1; }

// M2.8 Phase C street layer (walk-over surfaces, no colliders). Across the street (x): asphalt road |x| <= ROAD_HALF, a thin
// raised curb box (CURB_W wide, CURB_H high) on each side, then a flat, lighter slab pavement out to the walls (|x| = 3).
// CURB_H is 0.125 = 2 texels, not section 2's 0.15: every face stays 16 texels per unit (status/DECISIONS.md, Phase C).
// The road texture runs past the far end into the fog (ROAD_Z); pavements and curbs stop at the building line (PAVE_Z).
export const ROAD_HALF = 1.5, CURB_W = 0.25, CURB_H = 0.125;
export const ROAD_Z = Object.freeze({ z0: -76, z1: 4 });
export const PAVE_Z = Object.freeze({ z0: -40, z1: 4 });
// Road markings, baked into the road texture: gutter drains every 8 units per side (staggered 4 between sides), one
// manhole, one zebra crossing at the far end. Drains sit in the gutter against the curb: DRAIN_W across, DRAIN_D along.
export const DRAIN_W = 0.375, DRAIN_D = 0.75;
export const DRAINS = Object.freeze([
  ...[-4, -12, -20, -28, -36].map((z) => Object.freeze({ side: 'west', z })),
  ...[-8, -16, -24, -32].map((z) => Object.freeze({ side: 'east', z }))
]);
export const MANHOLE = Object.freeze({ x: 0.625, z: -18.5, d: 0.875 });
export const CROSSWALK = Object.freeze({ z0: -39.5, z1: -37.5 });

// Street furniture, all on the pavements (clear of the curb, the doors and their stoops, and the NPC lanes on the road).
// Footprint [w (x), d (z), h] per kind, multiples of 1/16 so every face is 16 texels per unit. x,z = footprint centre.
// Every prop carries a collider rect equal to its primary mesh's footprint; parts below the 2.5-unit sprite height stay
// inside it (lamp arms and tree canopies overhang above head height). `side` is the pavement; props face the road.
export const PROP_SIZES = Object.freeze({
  bin: [0.75, 0.75, 1], lamp: [0.375, 0.375, 4.25], bench: [0.625, 2, 1.0625], planter: [1, 1.5, 1],
  tree: [0.75, 0.75, 4.375], mailbox: [0.5, 0.5, 1.125], vending: [0.75, 1, 1.875]
});
export const PROPS = Object.freeze([
  ['bin1', 'bin', -2.375, -2.5], ['lamp1', 'lamp', -2, -9], ['planter1', 'planter', -2.375, -13.5],
  ['tree1', 'tree', -2.25, -16.5], ['vending1', 'vending', -2.5, -23], ['bin3', 'bin', -2.375, -29.5],
  ['lamp3', 'lamp', -2, -32], ['tree3', 'tree', -2.25, -34.5],
  ['mailbox1', 'mailbox', 2.5, -3.25], ['tree2', 'tree', 2.25, -4.75], ['bench1', 'bench', 2.375, -11.5],
  ['lamp2', 'lamp', 2, -13.75], ['bin2', 'bin', 2.375, -16], ['tree4', 'tree', 2.25, -24], ['lamp4', 'lamp', 2, -29],
  ['planter2', 'planter', 2.375, -31.75], ['bench2', 'bench', 2.375, -37.5]
].map(([id, kind, x, z]) => {
  const [w, d, h] = PROP_SIZES[kind];
  return Object.freeze({ id, kind, x, z, w, d, h, side: x < 0 ? 'west' : 'east' });
}));

// Spawn (player arrives standing, facing the far end), walk bounds and the exit door back to town.
export const SPAWN = Object.freeze({ x: 0, z: -3, facing: 'north' });
export const WALK = Object.freeze({ x0: -3, x1: 3, z0: -39, z1: 0.6 });
// Walking into the doorway (z past -0.55 within |x| <= 1.3) or E/Enter within 1.8 of it leaves the alley.
export const EXIT_DOOR = Object.freeze({ x: 0, z: 0.3, halfWidth: 1.3, trigger: Object.freeze({ x0: -1.3, x1: 1.3, z0: -0.55, z1: 0.6 }), useRadius: 1.8 });

// Collision rects in TownWorld's {x0,x1,z0,z1,tag} shape.
export function colliderRects() {
  const out = [];
  BUILDINGS.forEach((b) => out.push({ x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, tag: 'building:' + b.id }));
  PROPS.forEach((p) => out.push({ x0: p.x - p.w / 2, x1: p.x + p.w / 2, z0: p.z - p.d / 2, z1: p.z + p.d / 2, tag: 'prop:' + p.id }));
  return out;
}

// Simple patrol walkers (synthetic worker sprites from TownArt). Deterministic: no randomness, no wall clock.
// path = waypoints (x, z); the walker goes back and forth, pausing `pause` seconds at each end ([first, last] or one value
// for both). A one-point path is a stander. Lanes keep clear of the props above.
// The first three are M2.7's road walkers (tests/m27/alley-world pins them). M2.8 Phase E adds five pavement walkers, one
// per free gap between props, so no two lanes share ground: road-side lanes |x| = 2.15 (clear of the curb and of the
// entrance stoops, which reach 0.5 out from the wall) and a wall-side lane |x| = 2.55 that passes behind a lamp base.
// family picks the TownArt style (all six styles appear; the second Sonnet and Haiku get a different skin by id).
export const NPCS = Object.freeze([
  { id: 'alley-npc-1', family: 'Opus', path: [[-1.2, -6], [-1.2, -34]], speed: 1.1, pause: 2.0 },
  { id: 'alley-npc-2', family: 'Sonnet', path: [[1.0, -30], [1.0, -12]], speed: 0.9, pause: 1.5 },
  { id: 'alley-npc-3', family: 'Haiku', path: [[0.2, -24]], speed: 0, pause: 0, facing: 'east' },
  { id: 'alley-npc-4', family: 'Codex', path: [[-2.15, -4.25], [-2.15, -8.2]], speed: 0.85, pause: [1.25, 2.5] },
  { id: 'alley-npc-5', family: 'guide', path: [[2.15, -9.9], [2.15, -5.8]], speed: 0.95, pause: [2.75, 1.5] },
  { id: 'alley-npc-6', family: 'Unknown', path: [[-2.15, -17.5], [-2.15, -21.9]], speed: 0.8, pause: [1.0, 2.0] },
  { id: 'alley-npc-7', family: 'Sonnet', path: [[2.15, -17.0], [2.15, -23.0]], speed: 1.0, pause: [1.75, 3.0] },
  { id: 'alley-npc-8', family: 'Haiku', path: [[2.55, -13.0], [2.55, -15.1]], speed: 0.9, pause: [2.25, 1.25] }
].map(Object.freeze));
