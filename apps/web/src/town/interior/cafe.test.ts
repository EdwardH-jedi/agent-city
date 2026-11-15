import { expect, test } from "bun:test";
import { demoData } from "../../board/demo.ts";
import { toVillageModel } from "../../board/model.ts";
import { toCampusModel } from "../../campus/presentation.ts";
import { createInteriorScene } from "./scene.ts";
import { cafe } from "./themes/cafe.ts";
import { themeFor } from "./themes/index.ts";
import { autoEligible } from "./tour.ts";

test("No Wukkas cafe theme, code-drawn espresso detail, six seats at three tables, real occupant mapping", () => {
	expect(themeFor("no-wukkas-cafe")).toBe(cafe);
	expect(themeFor("NO-WUKKAS-CAFE-work")).toBe(cafe);
	expect(themeFor("no-wukkas-cafeteria")).not.toBe(cafe);
	expect(cafe.slots).toHaveLength(6);
	expect(
		cafe.room.furniture.filter((f) => f.kind === "coffee_table"),
	).toHaveLength(3);
	expect(cafe.room.decorations.find((f) => f.id === "espresso")?.kind).toBe(
		"espresso",
	);
	const now = Date.UTC(2026, 10, 16),
		data = demoData(now, "interior-cafe"),
		model = toVillageModel({ ...data, now, conn: "open" });
	const repo = toCampusModel(model).repos[0];
	if (!repo) throw Error("no cafe");
	expect(autoEligible(repo)).toBe(false);
	const room = createInteriorScene(repo);
	try {
		room.update(
			{ model, sessions: data.sessions, events: data.events, now },
			repo,
			now,
			false,
			{ rtW: 384, rtH: 340 },
		);
		expect(room.theme.id).toBe("cafe");
		expect(room.people).toHaveLength(4);
		expect(room.people.every((p) => p.at.pose === "sit")).toBe(true);
	} finally {
		room.dispose();
	}
	expect(room.registry.size).toBe(0);
	expect(room.registry.errors).toEqual([]);
});
