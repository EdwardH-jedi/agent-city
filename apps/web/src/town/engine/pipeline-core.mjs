// Low-resolution pipeline constants + pure layout math (M2.7 §3.1, §2.6). No GL, no DOM.
// agent-city: RT_W is a live binding the town may narrow to fit its column (setRenderWidth); RT_H, and with it the
// texel density (pixelWorldSize, worldPerPixel, the skyline texel, the orbit rig's snap steps), never changes.
export let RT_W = 384;
export const RT_W_MAX = 384;
export function setRenderWidth(w) { RT_W = Math.max(1, Math.min(RT_W_MAX, Math.floor(+w) || RT_W_MAX)); return RT_W; }
export const RT_H = 288;
export const MIN_SCALE = 1; // fallback only when the window is smaller than 2x
export const MAX_SCALE = 4; // largest integer that fits, up to 4x (M2.7.1; the prompt's design scales were 2 and 3)

// Integer upscale of the 384x288 target for a window of winW x winH CSS px, centered with integer offsets.
// Scale = largest integer that fits, clamped to [MIN_SCALE, MAX_SCALE]. x/y are bottom-left origin (GL viewport).
// M2.8 Phase H scale picker: maxScale (2 | 3 | 4, from ?scale=) caps the pick; the window still wins if it is smaller.
// Anything else (null, 'auto', 1, 5, NaN) is the automatic pick.
export function chooseIntegerScale(winW, winH, maxScale) {
  const fit = Math.floor(Math.min(winW / RT_W, winH / RT_H));
  const cap = maxScale === 2 || maxScale === 3 || maxScale === 4 ? maxScale : MAX_SCALE;
  const scale = Math.max(MIN_SCALE, Math.min(cap, fit));
  const width = RT_W * scale, height = RT_H * scale;
  return {
    scale, width, height,
    x: Math.max(0, Math.floor((winW - width) / 2)),
    y: Math.max(0, Math.floor((winH - height) / 2)),
    fits: width <= winW && height <= winH
  };
}
