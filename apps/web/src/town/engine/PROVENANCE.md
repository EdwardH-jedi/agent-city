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

## Re-check against the original

```sh
O=~/Developer/rea-lab/agent-office-town-m27; E=apps/web/src/town/engine
for f in $E/*.mjs; do n=$(basename $f); case $n in town-roo-art-m2.mjs) s=$O/app/town-roo-art-m2.js;; town-art.mjs) s=$O/app/town-art.js;; *) s=$O/renderer/$n;; esac
  diff <(sed "s#'../vendor/three.module.js'#'three'#" $s) $f >/dev/null || echo "differs: $n"; done
```

`town-roo-art-m2.mjs`, `town-art.mjs` (item 2) and, since S2, `facade-gen.mjs`, `alley-meshes.mjs`, `scene-ring.mjs`
(item 4) should print.
