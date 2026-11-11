// Scene palette of the campus (presentation only). The prototype's bright day concrete is retuned to
// an evening: dusk sky, darker paving and walls, a low warm sun, lit monitors that read at night.
// Status colours match the board (yellow 결재, red 멈춤). Brass marks the HQ only.
// The 3D canvas is aria-hidden and never the only carrier of a state — the DOM layer has the words.

/** The evening palette — the default (§13): dark sky and ground, so lit windows read from afar. */
export const SCENE_EVENING = {
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

/** The prototype's day palette (bright concrete), kept as it was (§13: the evening one is added). */
export const SCENE_DAY = {
	sky: "#e6e9e4",
	paving: "#e2ded5",
	asphalt: "#b6b7b1",
	concrete: "#cdc8be",
	roof: "#e4e1da",
	glass: "#a6c3cb",
	metal: "#5d686d",
	oak: "#c19a6b",
	walnut: "#7d5c40",
	planting: "#7e9270",
	brass: "#85661a",
	attention: "#8a5000",
	danger: "#b3261e",
	ready: "#0a6b60",
	running: "#2650bd",
	graphite: "#343a3e",
} as const;

/** What the scene draws with. */
export const SCENE: Record<keyof typeof SCENE_DAY, string> = SCENE_EVENING;

/** Inside a building with a running run: warm light on the floor and in the glass. */
export const GLOW = {
	on: "#ffb45c",
	onIntensity: 1.5,
	glassOn: "#ffd9a0",
	glassOff: "#1c2030",
} as const;

/** Evening light (§13 as given: evening colours, not the bright concrete day of the prototype). */
export const LIGHT = {
	sky: "#8a96c8",
	ground: "#2b2633",
	hemi: 0.22,
	sun: "#ffb47a",
	sunIntensity: 0.38,
	fill: "#7d8cff",
	fillIntensity: 0.08,
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
