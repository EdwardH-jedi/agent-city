// Scene palette of the campus (presentation only). The prototype's bright day concrete is retuned to
// an evening: dusk sky, darker paving and walls, a low warm sun, lit monitors that read at night.
// Status colours match the board (yellow 결재, red 멈춤). Brass marks the HQ only.
// The 3D canvas is aria-hidden and never the only carrier of a state — the DOM layer has the words.

export const SCENE = {
	sky: "#1f2438",
	paving: "#5a5866",
	asphalt: "#3a3a44",
	concrete: "#6e6a74",
	roof: "#58545f",
	glass: "#6f8fb0",
	metal: "#4a5058",
	oak: "#8a6a4c",
	walnut: "#5c4330",
	planting: "#3f5240",
	brass: "#a8822a",
	attention: "#f5c518",
	danger: "#ff4d4f",
	ready: "#2f9e8f",
	running: "#4a7bd8",
	graphite: "#2c3034",
} as const;

/** Evening light (§13 as given: evening colours, not the bright concrete day of the prototype). */
export const LIGHT = {
	sky: "#8a96c8",
	ground: "#2b2633",
	hemi: 0.42,
	sun: "#ffb47a",
	sunIntensity: 0.62,
	fill: "#7d8cff",
	fillIntensity: 0.16,
} as const;

/** Building accents: marks only (canopy, sign band, edge highlight, DOM swatch) — never text. */
export const ACCENTS = [
	"#3d6fa8",
	"#a7781f",
	"#26827a",
	"#ad5a38",
	"#5f6f8f",
	"#6b7a45",
] as const;

const HEX = /^#([0-9a-f]{6})$/i;

function channels(hex: string): [number, number, number] {
	const m = HEX.exec(hex);
	const v = m?.[1] ? Number.parseInt(m[1], 16) : 0;
	return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Linear mix of two `#rrggbb` colours in display space (as the reference's `mix`). */
export function mixHex(a: string, b: string, t: number): string {
	const k = Math.min(1, Math.max(0, t));
	const ca = channels(a);
	const cb = channels(b);
	const out = ca.map((c, i) => Math.round(c + ((cb[i] ?? 0) - c) * k));
	return `#${out.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
