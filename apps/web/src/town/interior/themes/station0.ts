import {
	box,
	type Colors,
	type InteriorTheme,
	METAL,
	slot,
	TEAL,
} from "./types.ts";

const DARK: Colors = {
	top: "#202b32",
	front: "#182128",
	side: "#111920",
	edge: "#0c1219",
};
const SAFETY: Colors = {
	top: "#c6ad59",
	front: "#a28e43",
	side: "#7e703b",
	edge: "#5f5939",
};
const GLASS: Colors = {
	top: "#799d9f",
	front: "#405e67",
	side: "#314b57",
	edge: "#263d48",
};
const furniture = [
	box("track-bed", "track", 0.25, 0.25, 19.5, 1.875, 0.0625, DARK),
	box("rail-north", "rail", 0.25, 0.65, 19.5, 0.125, 0.125, METAL),
	box("rail-south", "rail", 0.25, 1.65, 19.5, 0.125, 0.125, METAL),
	box("tunnel-left", "tunnel", 0.125, 0.125, 2.5, 0.1875, 2.75, DARK),
	box("tunnel-right", "tunnel", 17.375, 0.125, 2.5, 0.1875, 2.75, DARK),
	box("wall-band", "band", 0.125, 0.125, 19.75, 0.125, 0.3125, TEAL, 3.25),
	box("safety-line", "line", 0.25, 2.75, 19.5, 0.1875, 0.0625, SAFETY),
	box("console", "desk", 1.25, 4.5, 3.5, 1.125, 1.125, METAL),
	box("console-chair", "chair", 2.5, 3.6, 0.875, 0.75, 1.25, TEAL),
	box("bench", "bench", 6.5, 5.75, 3.25, 0.75, 0.75, TEAL),
	box("bench-back", "bench", 6.5, 5.25, 3.25, 0.1875, 1.25, TEAL),
	box("pillar", "pillar", 11.25, 4.3, 0.875, 0.875, 3.5, METAL),
	box("pillar-band", "band", 11.1875, 4.2375, 1, 1, 0.25, TEAL, 2.2),
	box("ticket-wall", "partition", 0.75, 6.4, 0.1875, 3.25, 2.5, TEAL),
	box("ticket-back", "partition", 0.75, 6.4, 4.5, 0.1875, 2.5, TEAL),
	box("ticket-counter", "counter", 1, 8.5, 4.25, 1, 1.25, METAL),
	box("ticket-chair", "chair", 2.5, 7.25, 0.875, 0.75, 1.25, TEAL),
	box("cart", "cabinet", 17.25, 7.25, 1.5, 0.875, 1, METAL),
	box("tool-box", "cabinet", 17.5, 7.375, 0.875, 0.5, 0.375, TEAL, 1),
	box("ladder-left", "pole", 13.75, 4.5, 0.125, 0.1875, 2.5, METAL),
	box("ladder-right", "pole", 14.75, 4.5, 0.125, 0.1875, 2.5, METAL),
];
for (let i = 0; i < 12; i++)
	furniture.push(
		box(
			`sleeper-${i}`,
			"sleeper",
			0.75 + i * 1.6,
			0.375,
			0.1875,
			1.625,
			0.0625,
			TEAL,
		),
	);
for (let i = 0; i < 8; i++) {
	const x = 0.5 + i * 2.375;
	furniture.push(
		box(`screen-door-${i}`, "screen_door", x, 2.25, 2.125, 0.1875, 2.25, GLASS),
	);
}
for (let i = 0; i < 6; i++)
	furniture.push(
		box(
			`rung-${i}`,
			"rung",
			13.75,
			4.5,
			1.125,
			0.1875,
			0.125,
			METAL,
			0.25 + i * 0.375,
		),
	);
const gateBars: string[] = [];
for (const [i, x] of [7, 10, 13].entries()) {
	furniture.push(
		box(`gate-${i}-left`, "faregate", x - 0.875, 9, 0.5, 1.5, 1.125, METAL),
		box(`gate-${i}-right`, "faregate", x + 0.375, 9, 0.5, 1.5, 1.125, METAL),
	);
	const id = `gate-bar-${i}`;
	gateBars.push(id);
	furniture.push(
		box(id, "bar", x - 0.375, 9.5, 0.75, 0.125, 0.125, SAFETY, 0.75),
	);
}
// The entrance is a flight of stairs in the concourse, with no transport brand or route map.
for (let i = 0; i < 4; i++)
	furniture.push(
		box(
			`stair-${i}`,
			"step",
			9,
			11 + i * 0.25,
			2,
			0.25,
			0.0625 + (3 - i) * 0.0625,
			METAL,
		),
	);

export const station0: InteriorTheme = {
	id: "station0",
	match: ["station0"],
	entry: "faregate",
	entrance: { x: 10, z: 11.875 },
	gate: { x: 10, z: 9.75 },
	slots: [
		slot(3, 8.25, "sit"),
		slot(3, 4.25, "sit"),
		slot(8, 5.6, "sit"),
		slot(16.25, 7.5),
		slot(13, 4.9),
		slot(18, 4),
	],
	waitSlots: [slot(6, 11), slot(14, 11)],
	statusBoard: { x: 6, y: 2.75, z: 2.5, w: 8, h: 2.25 },
	boardColors: { background: 0x17262c, ink: 0xc9d69b, frame: 0x4b696d },
	entryLamp: [7, 10, 13].map((x) => ({ x: x - 0.625, y: 1.1, z: 10.52 })),
	gateBars,
	clock: { x: 15.25, y: 3, z: 0.25, w: 3.25, h: 1 },
	signs: [{ x: 11.3, y: 2.65, z: 5.2, w: 0.75, h: 0.75, text: "0" }],
	room: {
		id: "station0",
		title: "STATION0",
		floorStyle: "tile",
		width: 20,
		depth: 12,
		exit: { x: 10, z: 12 },
		obstacles: [],
		furniture,
		decorations: [0, 1, 2].map((i) => ({
			...box(`monitor-${i}`, "monitor", 1.5 + i, 5, 0.75, 0.25, 0.625, METAL),
			mount: "surface",
			parent: "console",
		})),
		floorPalette: [
			"#283840",
			"#3d4e55",
			"#54636a",
			"#64777d",
			"#788b8d",
			"#899b9b",
			"#a3b1ac",
		],
		background: {
			wall: {
				palette: [
					"#263c44",
					"#40565e",
					"#586e75",
					"#72878b",
					"#8da1a0",
					"#adbab1",
				],
				wainscot: { height: 0.5, color: TEAL.side },
			},
		},
		doors: [{ frame: { color: METAL.side } }],
	},
};
