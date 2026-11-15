# Interior provenance

`room-art.mjs` is adapted from read-only `/Users/edwardhwang/Developer/rea-lab/agent-office-town-m27/renderer/scene-interior.mjs` (435 source lines, SHA-256 `b0ec6e576b2e3a0a85509145f3a097439fe48512f38e73b04a387f0d950866e2`).

The original renderer builds independently from room data. Its 16-texel grid, floor/wall/furniture painters and cutaway near wall are retained. Imports use this repository's three and existing engine helpers. Unused imports were removed; resource release is idempotent and runs if construction fails; Biome formatting is applied. No TownWorld, collision, input, transport or game state is copied.

Themes supply new room data and the board supplies actual occupants. Actors use the existing TownArt crew frames and TownRooArtM2; no images, audio or new animation frames are added. The original interior preset supplies the camera (55° pitch, 18° base FOV, 16 pixels/unit at focus); height expansion follows the existing town fovFor rule.

Engine modifications: none. The original town folder is unchanged.

I2 adds an optional floorStyle override and code-drawn screen-door/faregate face details to the copied painter. All other engine modules remain imported without edits. Station0 uses no train, logo, route colours/map or transit-card brand.
