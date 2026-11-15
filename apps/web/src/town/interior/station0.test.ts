import { expect, test } from "bun:test";
import { Color } from "three";
import { demoData } from "../../board/demo.ts";
import { toVillageModel } from "../../board/model.ts";
import { clockText } from "../../board/today.ts";
import { toCampusModel } from "../../campus/presentation.ts";
import { LAMP_COLORS } from "../engine/scene-ring.mjs";
import { lampOf } from "../lots.ts";
import { ritualAt } from "./ritual.ts";
import { createInteriorScene } from "./scene.ts";
import { themeFor } from "./themes/index.ts";
import { station0 } from "./themes/station0.ts";

const now = Date.UTC(2026, 10, 16, 3, 24);
test("Station0 exact and worktree prefix select the station; similar unrelated names do not", () => {
	expect(themeFor("Station0")).toBe(station0);
	expect(themeFor("station0-fix")).toBe(station0);
	expect(themeFor("station01")).not.toBe(station0);
	expect(station0.slots).toHaveLength(6);
	expect(station0.waitSlots).toHaveLength(2);
});
test("faregate timestamp: stairs, card stop, lamp, bar, walk through, settled", () => {
	const target = station0.slots[0];
	if (!target) throw Error("no slot");
	const at = (ms: number) =>
		ritualAt(station0, target, new Date(now).toISOString(), now + ms, false);
	expect(at(0)).toMatchObject(station0.entrance);
	expect(at(1200)).toMatchObject({
		...station0.gate,
		walking: false,
		light: true,
		open: false,
	});
	expect(at(1600)).toMatchObject({
		...station0.gate,
		walking: false,
		light: true,
		open: true,
	});
	expect(at(2200)).toMatchObject({ walking: true, light: false, open: true });
	expect(at(2800)).toMatchObject({ walking: true, light: false, open: false });
	expect(at(4000)).toMatchObject({
		...target,
		walking: false,
		light: false,
		open: false,
	});
	expect(at(10000)).toEqual(at(4000));
});
test("the actual scene uses the ring's four lamp colors, local clock and only a timestamped middle gate", () => {
	const d = demoData(now, "interior-entry");
	const model = toVillageModel({ ...d, now, conn: "open" });
	const repo = toCampusModel(model).repos[0];
	if (!repo) throw Error("no repo");
	const room = createInteriorScene(repo);
	const source = { model, sessions: d.sessions, events: d.events, now };
	try {
		for (const current of [
			repo,
			{ ...repo, active_tasks: 0 },
			{ ...repo, pending_requests: 1 },
			{ ...repo, has_stopped: true },
		]) {
			room.update(source, current, now + 5000, false, { rtW: 384, rtH: 340 });
			const kind = lampOf(current),
				c = kind === "off" ? ([39, 49, 54] as const) : LAMP_COLORS[kind];
			expect(room.lampMat.color).toEqual(
				new Color(c[0] / 255, c[1] / 255, c[2] / 255),
			);
		}
		expect(room.clockText).toBe(clockText(now + 5000));
		room.update(source, repo, now + 1600, false, { rtW: 384, rtH: 340 });
		expect(room.scene.getObjectByName("gate-bar-1")?.scale.x).toBe(0.12);
		expect(room.scene.getObjectByName("gate-bar-0")?.scale.x).toBe(1);
		room.update(source, repo, now + 1600, true, { rtW: 384, rtH: 340 });
		expect(room.scene.getObjectByName("gate-bar-1")?.scale.x).toBe(1);
	} finally {
		room.dispose();
	}
});
