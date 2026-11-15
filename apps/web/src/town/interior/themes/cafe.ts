import {
	box,
	type Colors,
	type InteriorTheme,
	METAL,
	slot,
	TEAL,
	WOOD,
} from "./types.ts";

const CREAM: Colors = {
	top: "#d8c9a8",
	front: "#b4a27d",
	side: "#8a7657",
	edge: "#554735",
};
const BRASS: Colors = {
	top: "#c4aa69",
	front: "#a28a4f",
	side: "#786538",
	edge: "#51442f",
};
const tables = [2.25, 8.25, 14.25];
const furniture = [
	box("counter", "counter", 1, 2.25, 9, 1.5, 1.25, WOOD),
	box("back-cabinet", "cabinet", 1, 0.25, 9, 0.75, 2, TEAL),
	box("cup-shelf", "bookshelf", 15.5, 0.25, 3.5, 0.8, 2.5, WOOD),
	box("door-frame", "frame", 8.75, 10.875, 2.5, 0.1875, 0.1875, WOOD, 2.75),
	box("bell-top", "bell", 9.8, 10.875, 0.375, 0.25, 0.25, BRASS, 2.375),
	box("bell-rim", "bell", 9.6875, 10.8125, 0.625, 0.375, 0.125, BRASS, 2.25),
	{
		...box("plant", "plant_tall", 18, 8.75, 1, 1, 2),
		render: "billboard" as const,
	},
	...tables.flatMap((x, i) => [
		box(`table-${i}`, "coffee_table", x, 6, 3.25, 1.5, 1.1, WOOD),
		box(`chair-${i}-a`, "chair", x + 0.25, 4.9, 0.875, 0.75, 1.25, TEAL),
		box(`chair-${i}-b`, "chair", x + 2, 4.9, 0.875, 0.75, 1.25, TEAL),
	]),
];
export const cafe: InteriorTheme = {
	id: "cafe",
	match: ["no-wukkas-cafe"],
	entry: "door",
	entrance: { x: 10, z: 11 },
	gate: { x: 10, z: 9.7 },
	slots: tables.flatMap((x) => [
		slot(x + 0.7, 5.8, "sit"),
		slot(x + 2.45, 5.8, "sit"),
	]),
	waitSlots: [slot(7, 9.7), slot(13, 9.7)],
	statusBoard: { x: 10.5, y: 2, z: 0.2, w: 8.75, h: 2.25 },
	boardColors: { background: 0x243a32, ink: 0xd6d5b9, frame: 0x796245 },
	entryLamp: [{ x: 10, y: 2.4, z: 11.25 }],
	room: {
		id: "cafe",
		title: "NO WUKKAS",
		width: 20,
		depth: 11,
		floorStyle: "planks",
		exit: { x: 10, z: 11 },
		obstacles: [],
		furniture,
		decorations: [
			{
				...box("espresso", "espresso", 2, 2.5, 2.5, 0.75, 1, METAL),
				mount: "surface",
				parent: "counter",
			},
			{
				...box(
					"grinder",
					"coffee_machine",
					5.25,
					2.5,
					0.875,
					0.75,
					1.25,
					METAL,
				),
				mount: "surface",
				parent: "counter",
			},
			...[0, 1, 2].map((i) => ({
				...box(
					`cup-${i}`,
					"cup",
					7 + i * 0.625,
					2.75,
					0.375,
					0.375,
					0.375,
					CREAM,
				),
				mount: "surface" as const,
				parent: "counter",
			})),
			...tables.map((x, i) => ({
				...box(`laptop-${i}`, "monitor", x + 1, 6.25, 1, 0.25, 0.625, METAL),
				mount: "surface" as const,
				parent: `table-${i}`,
			})),
		],
		floorPalette: [
			"#3d3026",
			"#514035",
			"#685345",
			"#7b6350",
			"#92775d",
			"#a68b6b",
			"#bca17d",
		],
		background: {
			wall: {
				palette: [
					"#514a3c",
					"#6c6453",
					"#867c65",
					"#a3987d",
					"#b9ad8d",
					"#d3c8a9",
				],
				wainscot: { height: 0.75, color: TEAL.side },
			},
		},
		doors: [{ frame: { color: WOOD.side } }],
	},
};
