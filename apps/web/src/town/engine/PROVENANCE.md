# engine/ — provenance

The ring town's renderer, ported from the owner's Agent Office Town (Agent Borough, M3.0–M3.2a).

| | |
|---|---|
| Original repo | `~/Developer/rea-lab/agent-office-town-m27` (read-only; never edited) |
| Commit | `a4f842d` (M3.2a Phase 4, 2026-10-27), working tree clean |
| three | npm `three` 0.186.1 (the original's `vendor/three.module.js` is the same version) |
| Ported in | stage S1 of `~/Developer/AgentCity/12_TOWN_SCREEN.md` |

Everything here is copied **verbatim** except the lines listed below. Lint and format are switched off
for this folder only (`biome.json` override); TypeScript sees it only through the hand-written `*.d.mts`
files (no `allowJs`).

## Files

From `renderer/` (the transitive import closure of `scene-ring`, `leaderboard`, `orbit-camera`,
`minimap`, `sprites`, `sprite-atlas`, `presets`, `pipeline-core`, `camera-rig`, `skyline`, `ring-layout`,
`textures`, `facade-gen`; recomputed from the import statements at `a4f842d`):

`alley-layout.mjs` `alley-meshes.mjs` `camera-rig.mjs` `facade-gen.mjs` `ground.mjs` `leaderboard.mjs`
`minimap.mjs` `orbit-camera.mjs` `pipeline-core.mjs` `presets.mjs` `ring-layout.mjs` `scene-alley.mjs`
`scene-ring.mjs` `scene-town.mjs` `skyline.mjs` `sprite-atlas.mjs` `sprites.mjs` `street-gen.mjs`
`textures.mjs` `town-layout.mjs` (20 files)

From `app/` (classic scripts, renamed `.js` → `.mjs` because they are now ES modules):

- `town-roo-art-m2.js` → `town-roo-art-m2.mjs` (the kangaroo; used from S1)
- `town-art.js` → `town-art.mjs` (people; ported now for the leads in S2/S3, not imported in S1)

From `tests/m27/` → `tests/` (run by `bun test` through Bun's `node:test` support, unchanged runner):

`ring-layout.test.mjs` `orbit-camera.test.mjs` `leaderboard.test.mjs` `facade-gen.test.mjs`
`minimap.test.mjs`, plus a new data file `tests/borough-snapshot.mjs` (below).

`minimap.mjs` is ported for S2/S4 and is not imported by S1's TypeScript (its DOM section has listeners;
the screen does not mount it). `scripts/no-run-actions.test.ts` scans every `engine/*.mjs` for input listeners,
controls, requests and action words; the only allowed hits are pinned to `minimapSection` in `minimap.mjs`, and no
screen code may import that export.

Not ported: `pipeline.mjs` (pulls the alley and interior scenes; replaced by `../pipeline.ts` +
`../world.ts`, its ring branch), `ring-world.mjs` and `town-walkers.mjs` (keyboard sim via
TownRooControlsM2, six decorative townsfolk, the `d` key; replaced by `../patrol.ts`), `scene-switch.mjs`,
`entry.mjs`, `live-bridge.mjs`, `panels.mjs`, `sessions.mjs`, `lobby-layout.mjs`, `scene-interior.mjs`,
`alley-world.mjs`, `app/main.js`, `town-world.js`, `town-ui.js`, `town-interiors.js`,
`town-roo-controls-m2.js`, `town-pixel-m2.js`, the vendor copy of three.

## Changed lines

1. `three` import — the only change in the 20 renderer files, one line each in `alley-meshes.mjs`,
   `camera-rig.mjs`, `leaderboard.mjs`, `orbit-camera.mjs`, `scene-alley.mjs`, `scene-ring.mjs`,
   `scene-town.mjs`, `skyline.mjs`, `sprite-atlas.mjs`, `sprites.mjs`:
   `from '../vendor/three.module.js'` → `from 'three'` (one copy of three in the app).
2. `town-roo-art-m2.mjs`, `town-art.mjs` — module wrap without globals (3 lines each):
   - added before `(function (root) {`: `const __root = {};`
   - last line `})(typeof window !== 'undefined' ? window : globalThis);` → `})(__root);`
   - added after it: `export const TownRooArtM2 = __root.TownRooArtM2;` / `export const TownArt = __root.TownArt;`

   The IIFE body is untouched. `root.__TOWN_ROO_DEV__` is read from the local object (never set, so the
   self-test hook stays off); the `typeof module !== 'undefined'` CommonJS branch is dead in the browser.
3. Tests (`tests/*.test.mjs`): import paths `../../renderer/X.mjs` → `../X.mjs` and
   `../../vendor/three.module.js` → `three` in all five. Plus:
   - `leaderboard.test.mjs`: `loadLanes()` (loads the classic app scripts in a vm) is replaced by
     `tests/borough-snapshot.mjs` — the two snapshots `main.js` `L.initialSnapshot(buildFixture('borough'),
     true / false)` returns, dumped once from the original at `a4f842d` and reduced to the fields
     `boardViewFromSnapshot` reads (`id`, `department`, `status`, `freshness`, `counts`,
     `transportAvailable`). A two-line shim keeps every call site as written:
     `const L = { initialSnapshot: (fx, transport) => (transport ? BOROUGH_ONLINE : BOROUGH_OFFLINE) }`,
     `const borough = () => null`. The `live-bridge.mjs` import is removed.
     - dropped: the scripted-timeline loop at the end of *counts match the borough fixture snapshot*
       (needs `main.js` `L.stepFixture` / `L.countsOf`); the rest of that case runs.
     - dropped case: *live view: exact project bindings only, …* (needs `live-bridge.mjs`).
   - `minimap.test.mjs`: dropped case *minimapView on the real debug state: …* (needs
     `tests/lib/ring-harness.mjs`: `scene-switch`, `ring-world` and the classic app scripts).

   Cases: ring-layout 8/8, orbit-camera 12/12, leaderboard 8/9, facade-gen 5/5, minimap 5/6.

4. **S2 (real-data mapping, doc 12 §4)** — every changed line carries an `agent-city:` comment:
   - `facade-gen.mjs` (3 lines): `context()` reads `o.litFirst` (a count); `windowState` and `glassRow` light a
     window / pane when `ctx.windows.total < ctx.litFirst` (the first windows painted: the first floor above the
     ground floor, left to right) or by the original hash. Without `litFirst` nothing changes.
   - `alley-meshes.mjs` `buildFacadeBuilding` (+5 lines, 2 replaced): `b.lit` (per-building lit share, default the
     preset's `look.lit`) and `b.litFirst`; the facade is painted through a local `paintLit(n)` (same steps as
     before: reference unlit image, lit image, `tintImage` so lit panes stay untinted), and
     `mesh.userData.setLitWindows(n)` repaints the same facade texture in place (no rebuild). The end bands never
     get `litFirst` (they tile).
   - `scene-ring.mjs`:
     - `SIGN_GLYPHS` gains V Y J Z, 0–9 and `-` (the leaderboard's EXTRA_GLYPHS patterns), so a project name of
       A–Z 0–9 `-` draws on the lit sign board.
     - `LAMP_COLORS.stopped` = `[0xff, 0x4d, 0x4f]` (the board's `--b-red`).
     - `lampState`: `if (row.lamp) return LAMP_COLORS[row.lamp] ? row.lamp : 'off'` after the offline / no-row
       checks — an explicit lamp state wins (the city's priority stopped > waiting > working differs from the
       pylon's counters).
     - `makeRingGround(seed, lots)`, `buildRingMeshes` (`opts.lots || LOTS`), `buildRingScene` (passes
       `opts.lots` to both): an optional LOTS override with the same ids and positions; the lot loop also passes
       `lit: L.lit, litFirst: L.litWindows` to the facade.
     - Not overridden: `ring-layout.mjs` PROPS (door benches / bins are placed at load from the original LOTS'
       `boarded` flags, so filled lot-9 / lot-10 have none and empty department slots keep theirs), the hedges
       and colliders (positions only).
   - `minimap.d.mts` declares only the pure model / drawing functions (`ringModel`, `fitTransform`, `drawBase`,
     `guideTriangle`); `minimapSection` stays undeclared and unimported (guard in scripts/no-run-actions.test.ts).

5. **S3 (choreography)** — `sprites.mjs` `createActorLayer`, 2 places, marked `agent-city:`:
   - `lockedScale` may be a number 0..1: the sprite's scale mixes the locked pixel size (1) with the world size
     (0), so the kangaroo changes size continuously while the camera blends between following it and the HQ shot
     (`true` / falsy behave as before).
   - An actor no longer listed in `sync()` is removed from the scene and its material and atlas-texture clone
     are disposed (the original hid it and kept it for reuse). On an always-on board actors come and go with
     every visit; hiding would grow GPU resources without bound. Shared shadow geometry / material untouched.

6. **S4 (stage size, doc 12 §12)** — `pipeline-core.mjs`: `export const RT_W = 384` → `export let RT_W = 384` plus
   `RT_W_MAX = 384` and `setRenderWidth(w)` (clamped 1..384). Every engine use of RT_W (camera aspect at creation,
   sprites' pixel snapping, chooseIntegerScale) reads the live binding. RT_H stays a constant 288, so the texel
   density (pixelWorldSize, worldPerPixel, the skyline texel, the orbit rig's snap steps) is the original's.
   `../pipeline.ts` `fitStage` picks the width: the full 384 at the largest integer scale that fits; only when
   that is 1× does it narrow (floor(column / 2), ≥ 320) to reach 2× (a 1366×768 board: 373×288 at 2×). It
   updates the target and the live camera's aspect, and hands 384 back on dispose and on a failed start.
   Letterbox (not engine): outside the integer-scaled picture the canvas is cleared to the board's page colour
   #0f0c0b, not the preset's sky as pipeline.mjs did — the original's picture sat inside a dark stage.

7. **R1 (owner review: readable signs and pylon)** — marked `agent-city:`:
   - `scene-ring.mjs` `buildRingMeshes`: `L.signLit` forces the lit sign board even for a name facade-gen could
     paint; `L.signScale` (default 2) sets the board's glyph scale, the board growing with it (width
     `ceil((tw + 6s) / 8) / 2`, height `s / 2` units — at 2 exactly the original 1-unit board). Project lots use
     3× lit boards: the original 2× glyphs (0.625 units high) minify into noise on the 384 × 288 target beyond
     ~35 units, i.e. every sign across the plaza. The glyphs themselves were correct (checked texel by texel).
   - `leaderboard.mjs` `planFace`: a counter (`working` / `waiting` / `idle`, `unknown`) or the age whose row
     value is `undefined` is not drawn. The city's rows carry only 진행 and 대기, so the faces no longer show
     made-up `00` / `?00` / `—` columns. Rows that carry every field (the original's) draw as before.

## Re-implemented in TypeScript (outside engine/)

- `../pipeline.ts` — `createPipelineTargets` (without the door-fade quad), the ring branch of
  `createTownRenderer` (`ColorManagement.enabled = false`, now saved and restored on dispose because it is
  global on the shared three module; `LinearSRGBColorSpace`; pixel ratio 1; integer blit letterboxed in
  `preset.backdrop ?? preset.sky`), `resize`, `setBoard`, `render`, `dispose`. No `debug()`,
  `groundFraction()`, `sampleTarget()`, `setFade()` or runtime agent frames (`agentFrame`).
- `../world.ts` — the ring branch's GL-free part: `buildRingScene(preset, seed 1, horizonNdcY(preset),
  { pylon: createLeaderboard })`, `createOrbitRig(preset, ring-layout)`, `buildSpriteAtlas({ rooArt,
  npcs: [] })`, `createActorLayer(...)`, and render()'s actor staging (the guide drawn at the snapped
  focus).
- `../patrol.ts` — `worldToView` and `facingFrom` (from `ring-world.mjs`), `frameIndexFor`,
  `WALK_STRIDE` 1.6 and `IDLE_PERIOD` 2.4 (from `app/town-roo-controls-m2.js`), the actor key format
  `roo|<screen facing>|<action>|<frame>`.
- `../stage.ts` — `scene-switch.mjs` `renderRing`'s frame order: `rig.setYaw(rig.yawFor(p))`,
  `rig.update(dt, x, z)`, facing from `rig.yawDeg`, `setActors`, `render`.

- `../choreo.ts` + `../lead-sprites.ts` (S3, doc 12 §5) — no engine edit. The leads are TownArt people drawn
  through `createActorLayer`'s runtime-frame path (`frameFor`, as pipeline.mjs's `agentFrame`), one 32 × 40
  texture per (look, facing, action, phase), made on demand and disposed with the world; the walk phase
  every 0.45 units walked and the idle blink are ring-world.mjs's townsfolk rules. TownArt has no
  walking-while-carrying pose, so a 결재 lead's folder / binder is a coded 5 × 7 pixel block painted into its
  frame. Declarations added: `doorOf` (ring-layout), `yawOfDir` (orbit-camera), `phaseStartFrames` /
  `recolorRGBA` (sprite-atlas), `getAnimation` (town-art), `Actor.sprite` (sprites), `turnBetween`
  (orbit-camera).
  Time rule: a lead's head start is wall clock − `created_at` (clamped to 60 s, campus/visits.ts), so a reload
  lands it where it was; its walk then runs on the scene clock (wall minus still stretches), so reports
  stopping freeze it and it resumes from the same spot. The kangaroo is a state machine stepped on the scene
  clock (patrol → to-hq → at-hq → back → patrol, each from where it is); its patrol phase is scene time plus a
  shift set when it rejoins the line, so after a reload it starts on the plain scene-time patrol (or at the HQ
  if a 결재 lead arrived there less than five minutes ago).
- R1 (owner review): the kangaroo stays at the HQ for `HQ_HOLD_MS` (5 min) after a 결재 lead's real arrival
  (wall-clock age beyond the clamped head start, `lateMsOf`), or after a 보고 lead turned into a 결재 in place
  (`signedAtOf`), then patrols again while the lead keeps standing at the door. The 결재 HQ shot is a close
  one (`HQ_SHOT`: door, queue, kangaroo); reduced motion keeps the old wide `PLAZA_SHOT` with the pylon. The
  first in the queue stands 1.2 off the facade, so the camera-facing sprite does not lean back into it.

## Re-check against the original

```sh
O=~/Developer/rea-lab/agent-office-town-m27; E=apps/web/src/town/engine
for f in $E/*.mjs; do n=$(basename $f); case $n in town-roo-art-m2.mjs) s=$O/app/town-roo-art-m2.js;; town-art.mjs) s=$O/app/town-art.js;; *) s=$O/renderer/$n;; esac
  diff <(sed "s#'../vendor/three.module.js'#'three'#" $s) $f >/dev/null || echo "differs: $n"; done
```

`town-roo-art-m2.mjs`, `town-art.mjs` (item 2), `facade-gen.mjs`, `alley-meshes.mjs`, `scene-ring.mjs` (items 4, 7),
`sprites.mjs` (item 5), `pipeline-core.mjs` (item 6) and `leaderboard.mjs` (item 7) should print — eight files.
