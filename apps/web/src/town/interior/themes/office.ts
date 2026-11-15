import { box, type InteriorTheme, METAL, slot, TEAL, WOOD } from "./types.ts";

const desks = [
	[2.5, 4.2],
	[7.5, 4.2],
	[2.5, 7.7],
	[7.5, 7.7],
] as const;
const furniture = desks.flatMap(([x, z], i) => [
	box(`desk-${i}`, "desk", x, z, 3.2, 1.25, 1.1),
	box(`chair-${i}`, "chair", x + 1, z - 0.85, 0.85, 0.75, 1.25, TEAL),
]);
furniture.push(
	box("shelf", "bookshelf", 0.5, 0.25, 3.5, 0.8, 2.75),
	box("files", "cabinet", 16, 0.25, 3.25, 0.8, 2.25, METAL),
	{ ...box("plant", "plant_tall", 18, 8.5, 1, 1, 2), render: "billboard" },
);

export const office: InteriorTheme = {
	id: "office",
	match: [],
	entry: "door",
	entrance: { x: 10, z: 11 },
	gate: { x: 10, z: 9.7 },
	slots: [
		slot(4, 4, "sit"),
		slot(9, 4, "sit"),
		slot(4, 7.5, "sit"),
		slot(9, 7.5, "sit"),
		slot(14.5, 4),
		slot(15.5, 7.5),
	],
	waitSlots: [slot(8, 9.75), slot(12, 9.75)],
	statusBoard: { x: 6, y: 2, z: 0.2, w: 8, h: 2.25 },
	entryLamp: [{ x: 10, y: 2.75, z: 11 }],
	room: {
		id: "engineering",
		title: "OFFICE",
		width: 20,
		depth: 11,
		exit: { x: 10, z: 11 },
		obstacles: [],
		furniture,
		decorations: desks.map(([x, z], i) => ({
			...box(`monitor-${i}`, "monitor", x + 1, z + 0.5, 1, 0.3, 0.75, METAL),
			mount: "surface",
			parent: `desk-${i}`,
		})),
		floorPalette: [
			"#3d3830",
			"#50483b",
			"#635b4b",
			"#776f5d",
			"#8b826e",
			"#a19780",
			"#b4aa91",
		],
		background: {
			wall: {
				palette: [
					"#514b42",
					"#6c6559",
					"#867d6c",
					"#a49a85",
					"#bcb29b",
					"#d2c8ae",
				],
				wainscot: { height: 0.75, color: WOOD.front },
			},
		},
		doors: [{ frame: { color: TEAL.side } }],
	},
};
