// Scene palette of the business campus (presentation only). Values follow the approved handover
// design tokens (`--scene-*`, the status colours and the building accents of build/tokens.css):
// neutral concrete, glass, graphite, subtle wood, muted planting, brass for Headquarters only.
// The 3D canvas is aria-hidden and never the only carrier of a state — the DOM layer has the words.

export const SCENE = {
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
