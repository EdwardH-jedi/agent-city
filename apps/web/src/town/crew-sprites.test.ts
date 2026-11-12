// The crew's frames (16 A1): keyed by look, never by session id, so the cache stays bounded on a kiosk
// that sees hundreds of sessions a night; tags are the pylon's glyphs on a plate.
import { describe, expect, test } from "bun:test";
import {
	CREW_FRAME_MAX,
	CREW_VARIANTS,
	type CrewSprite,
	createCrewFrames,
	crewLook,
	TAG_H,
	tagCell,
} from "./crew-sprites.ts";
import { CELL_H, CELL_W } from "./engine/sprite-atlas.mjs";
import type { Actor } from "./engine/sprites.mjs";
import { TownArt } from "./engine/town-art.mjs";

const FAMILIES = ["opus", "sonnet", "haiku", "fable", "codex", null] as const;
const FACINGS = ["south", "east", "west", "north"] as const;

describe("crew looks", () => {
	test("the family's style; Fable wears Opus; an unknown Claude model one of the Claude looks; Codex its own", () => {
		expect(crewLook("claude:a", "claude", "opus").style).toBe("Opus");
		expect(crewLook("claude:a", "claude", "fable").style).toBe("Opus");
		expect(crewLook("codex:a", "codex", "codex").style).toBe("Codex");
		for (let i = 0; i < 20; i += 1)
			expect(["Opus", "Sonnet", "Haiku"]).toContain(
				crewLook(`claude:x${i}`, "claude", null).style,
			);
		expect(crewLook("other:a", "other", null).style).toBe("Unknown");
	});

	test("a session keeps its look; variants stay within CREW_VARIANTS", () => {
		expect(crewLook("claude:q", "claude", "opus")).toEqual(
			crewLook("claude:q", "claude", "opus"),
		);
		for (let i = 0; i < 50; i += 1) {
			const v = crewLook(`s${i}`, "claude", "sonnet").variant;
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(CREW_VARIANTS);
		}
	});
});

describe("frame cache", () => {
	test("500 sessions in every pose: the cache stays within CREW_FRAME_MAX", () => {
		const frames = createCrewFrames(TownArt);
		try {
			for (let i = 0; i < 500; i += 1) {
				const fam = FAMILIES[i % FAMILIES.length] ?? null;
				const provider = fam === "codex" ? "codex" : "claude";
				const look = crewLook(`${provider}:s${i}`, provider, fam);
				const facing = FACINGS[i % 4] ?? "south";
				const walk = i % 3 === 0;
				const sprite: CrewSprite = {
					kind: "crew",
					look,
					facing,
					action: walk ? "walk" : "idle",
					phase: walk ? i % 4 : i % 2,
					small: i % 5 === 0,
				};
				frames.frameFor({ id: "crew:0", x: 0, z: 0, key: "", sprite } as Actor);
				frames.frameFor({
					id: "tag:0",
					x: 0,
					z: 0,
					key: "",
					sprite: {
						kind: "tag",
						text: fam ? fam.toUpperCase() : "CLAUDE",
						style: look.style,
					},
				} as Actor);
			}
			expect(frames.size).toBeLessThanOrEqual(CREW_FRAME_MAX);
			expect(frames.size).toBeLessThan(250);
			// a lead's sprite (no kind) is not the crew's
			expect(
				frames.frameFor({
					id: "lead:0",
					x: 0,
					z: 0,
					key: "",
					sprite: { repo_id: "o/a" },
				} as Actor),
			).toBeNull();
		} finally {
			frames.dispose();
			expect(frames.size).toBe(0);
		}
	});

	test("a tag frame stands one cell above the feet", () => {
		const frames = createCrewFrames(TownArt);
		const f = frames.frameFor({
			id: "tag:0",
			x: 0,
			z: 0,
			key: "",
			sprite: { kind: "tag", text: "OPUS", style: "Opus" },
		} as Actor) as { cy: number };
		expect(f.cy).toBe(-1);
		frames.dispose();
	});
});

describe("name tags", () => {
	test("a plate on the cell's bottom rows, glyphs inside it, nothing above", () => {
		const cell = tagCell({ kind: "tag", text: "SONNET", style: "Sonnet" });
		const alpha = (x: number, y: number) => cell[(y * CELL_W + x) * 4 + 3] ?? 0;
		for (let y = 0; y < CELL_H - TAG_H; y += 1)
			for (let x = 0; x < CELL_W; x += 1) expect(alpha(x, y)).toBe(0);
		// the plate is solid across the text and the glyph rows hold two colours (plate and ink)
		const row = CELL_H - TAG_H + 3;
		const colours = new Set<string>();
		for (let x = 0; x < CELL_W; x += 1)
			if (alpha(x, row))
				colours.add(
					cell
						.slice((row * CELL_W + x) * 4, (row * CELL_W + x) * 4 + 3)
						.join(","),
				);
		expect(colours.size).toBeGreaterThanOrEqual(3); // outline, plate, ink
	});
});
