// Scene camera/look presets (M2.7 §3.2). Pure data. `alley` was the only one built in M2.7; M2.8 builds `plaza` (Phase F,
// the town) and `interior` (Phase G, the Engineering room).
// DEVIATION (docs/M27_RENDERER.md section 10): `alley` is tuned from the M2.7 prompt's pitch 50 / distance 11 / fov 30 to
// pitch 12 / fov 54 / distance 4.5 / tan(fov/2) = 8.83 (M2.8 Phase A; M2.7.1 used pitch 22).
//  - The horizon sits at NDC y = tan(pitch) / tan(fov/2), i.e. (1 - tan(pitch) / tan(fov/2)) / 2 of the frame height from
//    the top. M2.8 asks for 0.22-0.32 in streets. Its own pitch 20-24 with fov 26-30 gives NDC y 1.36-1.93 (horizon above
//    the frame), so the horizon target wins over the pitch: fov 54 is kept and pitch 12 puts the horizon at 0.291.
//    Swept at horizon 0.27 (scripts/cam-sweep.mjs): fov 30 / pitch 7 is telephoto and fogs the street, fov 82 / pitch 22
//    distorts the frame edges; fov 54 is the smallest change from M2.7.1 (status/DECISIONS.md, Phase A).
//  - distance = 4.5 / tan(fov/2) keeps exactly 32 render-target pixels per world unit at the focus plane, i.e. 1 texel
//    (1/16 unit) = 2 pixels, so the player sprite and the ground read as clean 2x pixels where the player stands.
//  - sky / haze are the M2.8 section 4 day palette (#8ec5ff -> #dff1ff); haze is also the fog colour.
export const SCENE_PRESETS = Object.freeze({
  alley: Object.freeze({
    pitchDeg: 12, distance: 4.5 / Math.tan(27 * Math.PI / 180), heightOffset: 2.5, fov: 54,
    sky: 0x8ec5ff, haze: 0xdff1ff, fogNear: 14, fogFar: 40
  }),
  // M2.8 Phase F: the WebGL town. Section 2's plaza pitch 28-32 at fov 26-30 puts the horizon above the frame (as in Phase A),
  // so the section 5 plaza target (horizon 0.18-0.28 of the frame) wins: fov 54 / pitch 15 -> (1 - tan 15 / tan 27) / 2 = 0.237.
  // distance = 9 / tan(fov/2) = 17.66, twice the alley's: 16 render pixels per unit at the focus, i.e. world textures at
  // exactly 1 pixel per texel there, and the player is drawn at 1 pixel per texel too (playerPxPerTexel) so it matches the
  // agents and the facades. Fog only hazes the outer blocks (the department fronts are 35-45 units out); the skyline stands
  // 150 units ahead, past the outermost blocks (z +-64), inside the far plane (200).
  // M2.9 T1 (status/DECISIONS.md, M2.9): the head-on view read as a flat wall with no sky (measured horizon 0.028, bare ground
  // 0.51 of the frame). Three-quarter view instead: yawOffset 20 turns the VIEW 20 degrees past TownWorld's yaw (0 / 180;
  // TownWorld's yaw, input and sprite facings are unchanged), pitch 9 and heightOffset 7 (focus 7 units above the guide, who
  // sits in the lower third). Swept with scripts/town-sweep.mjs: measured horizon 0.208 (north) / 0.233 (south), bare
  // ground 0.350 / 0.294, every street-facing facade shows a side face. Camera horizon (1 - tan 9 / tan 27) / 2 = 0.345:
  // below the measured one because the skyline and roofs stand above the true horizon.
  plaza: Object.freeze({
    pitchDeg: 9, distance: 9 / Math.tan(27 * Math.PI / 180), heightOffset: 7, fov: 54, yawOffset: 20,
    sky: 0x8ec5ff, haze: 0xdff1ff, fogNear: 60, fogFar: 140, far: 200, skylineDepth: 150, playerPxPerTexel: 1
  }),
  // M2.8 Phase G: the WebGL department interior (renderer/scene-interior.mjs). Section 2's interior camera: pitch 55 (kept),
  // fov 18 (near-orthographic). distance = 9 / tan(9 deg) = 56.8 gives 16 render pixels per unit at the focus (1 pixel per
  // texel, the player at playerPxPerTexel 1), so the 21 x 11 room (walls included) fits the 384 x 288 frame. heightOffset 1
  // centres the room on TownWorld's room-fixed focus. No fog indoors (fogNear/fogFar past the far plane). sky/haze are the
  // section 4 day palette and follow ?time= like the street: here they only paint the window. backdrop is the flat indoor
  // background and the letterbox. upright: actors are vertical quads at their feet (see sprites.mjs), not camera-facing.
  interior: Object.freeze({
    pitchDeg: 55, distance: 9 / Math.tan(9 * Math.PI / 180), heightOffset: 1, fov: 18,
    sky: 0x8ec5ff, haze: 0xdff1ff, fogNear: 500, fogFar: 600, far: 120, playerPxPerTexel: 1, backdrop: 0x1c1714, upright: true
  }),
  // M3.0: the ring town (renderer/scene-ring.mjs, orbit camera renderer/orbit-camera.mjs). prompts/M30_RING.md §1.2's camera
  // (fov 54, distance 9 / tan 27 = 16 px per unit at the focus, no yawOffset: the orbit rig turns the view itself) plus the
  // plaza's far plane, fog and skyline depth (with far 80 the ring, 56 x 36 on its centre line with lots out to ~43 units,
  // is clipped). DEVIATION from §1.2's pitch 9 (status/DECISIONS.md #130): measured horizon on the road at pitch 9 is
  // 0.27-0.31 (2 of 10 orbit shots inside §5's 0.18-0.30); pitch 10 puts all ten at 0.22-0.29 and keeps the judder gate.
  ring: Object.freeze({
    pitchDeg: 10, distance: 9 / Math.tan(27 * Math.PI / 180), heightOffset: 7, fov: 54,
    sky: 0x8ec5ff, haze: 0xdff1ff, fogNear: 60, fogFar: 140, far: 200, skylineDepth: 150, playerPxPerTexel: 1
  })
});

// M2.8 Phase D: time-of-day looks for `?time=day|dusk|night` (default day), merged over the scene preset and under the
// overrides. Day keeps the scene's own sky/haze (alley: the section 4 day palette) and changes nothing.
//  - sky / haze: section 4 palettes, zenith -> horizon. Dusk is read purple zenith -> orange horizon (status/DECISIONS.md #34).
//    haze stays the fog colour, so the street fades into the horizon colour at every time.
//  - tint (facades, trim, props, doorway), groundTint (road, curbs, pavements, paver ground), actorTint (player and NPC
//    sprites): material colour multipliers [r, g, b]. Lit window texels, lit lamp heads, the blade sign and the lamp glows
//    are never tinted, so they read as emissive.
//  - lit: per-window probability of being drawn lit (facade-gen hash). 0.37 / 0.55 light 64 / 95 of the alley's 158
//    windows (0.405 / 0.601, section 2 "~40 %" at dusk). glow: lamp glow opacity (0 = no glow sprites, lamp heads unlit).
export const TIMES = Object.freeze(['day', 'dusk', 'night']);
export const TIME_PRESETS = Object.freeze({
  day: Object.freeze({ time: 'day', tint: [1, 1, 1], groundTint: [1, 1, 1], actorTint: [1, 1, 1], lit: 0, glow: 0 }),
  dusk: Object.freeze({
    time: 'dusk', sky: 0x6d3b7a, haze: 0xf4a261,
    tint: [1, 0.8, 0.7], groundTint: [0.85, 0.66, 0.6], actorTint: [1, 0.88, 0.8], lit: 0.37, glow: 0.75
  }),
  night: Object.freeze({
    time: 'night', sky: 0x0d1b3d, haze: 0x243b6b,
    tint: [0.4, 0.44, 0.66], groundTint: [0.3, 0.33, 0.5], actorTint: [0.62, 0.66, 0.84], lit: 0.55, glow: 1
  })
});

// Any value other than dusk / night (missing, misspelt) is day.
export function timeOf(name) { return TIMES.includes(name) ? name : 'day'; }

export function resolvePreset(name, overrides, time) {
  const base = SCENE_PRESETS[name];
  if (!base) throw new Error('unknown scene preset: ' + name);
  return Object.freeze(Object.assign({}, base, TIME_PRESETS[timeOf(time)], overrides || {}));
}
