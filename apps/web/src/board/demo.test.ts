import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO_LABEL, demoData, isDemo } from "./demo.ts";
import { toVillageModel } from "./model.ts";

describe("예시 데이터 (?demo=1 only)", () => {
	test("only ?demo=1 turns it on", () => {
		expect(isDemo("?demo=1")).toBe(true);
		expect(isDemo("?demo=1&sound=off")).toBe(true);
		for (const s of ["", "?demo=0", "?demo", "?demo=true", "?x=demo=1"])
			expect(isDemo(s)).toBe(false);
	});

	test("every name is made up (demo/…), and the screen labels it 예시 데이터", () => {
		const d = demoData(Date.UTC(2026, 10, 11, 5));
		for (const r of d.runs) expect(r.project?.startsWith("demo/")).toBe(true);
		for (const r of Object.values(d.districts).flat())
			expect(r.id.startsWith("demo/")).toBe(true);
		expect(DEMO_LABEL).toBe("예시 데이터");
		const board = readFileSync(join(import.meta.dir, "Board.tsx"), "utf8");
		expect(board).toMatch(/demo \?/);
		expect(board).toMatch(/\{DEMO_LABEL\}/);
	});

	test("it exercises the screen: a 결재, a 멈춤, running work, a report at the door, more than 8 buildings", () => {
		const t0 = Date.UTC(2026, 10, 11, 5);
		const m = toVillageModel({
			...demoData(t0),
			now: t0 + 1_000,
			conn: "open",
		});
		expect(m.status.border).toBe("red");
		expect(m.visits.filter((v) => v.kind === "sign")).toHaveLength(2);
		expect(m.now.length).toBeGreaterThan(2);
		expect(m.door?.kind).toBe("report");
		expect(m.village.shown).toHaveLength(8);
		expect(m.village.folded).toBeGreaterThan(0);
	});

	test("§13.9: the fixture is a lazy chunk the live path never imports", () => {
		const { readdirSync } = require("node:fs") as typeof import("node:fs");
		const src = join(import.meta.dir, "..");
		const app = readFileSync(join(src, "App.tsx"), "utf8");
		expect(app).toMatch(
			/lazy\(\(\) => import\("\.\/board\/DemoBoard\.tsx"\)\)/,
		);
		expect(app).toMatch(/isDemo\(window\.location\.search\) \?/);
		// only DemoBoard.tsx imports demo.ts (and nothing statically imports DemoBoard.tsx)
		const importers: string[] = [];
		const walk = (dir: string) => {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				const f = join(dir, e.name);
				if (e.isDirectory()) walk(f);
				else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".test.ts")) {
					const code = readFileSync(f, "utf8");
					if (/from "\.\/demo\.ts"|from "\.\/board\/demo\.ts"/.test(code))
						importers.push(e.name);
					if (/from "[^"]*DemoBoard\.tsx"/.test(code))
						importers.push(`static:${e.name}`);
				}
			}
		};
		walk(src);
		expect(importers).toEqual(["DemoBoard.tsx"]);
		const demoBoard = readFileSync(
			join(import.meta.dir, "DemoBoard.tsx"),
			"utf8",
		);
		expect(demoBoard).not.toMatch(/useHub|useRunEvents|play\(/);
	});
});
