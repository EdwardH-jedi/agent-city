// City only observes Agent Office runs (it is not a second Dispatcher). This scans the code that
// serves and shows runs and fails if anything there could approve, launch or retry a run: no control
// in the run screen, no write route on the read API, no request sent from the web view other than
// GET. Comments are stripped first, so explaining the rule in prose is fine.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const code = (p: string) =>
	readFileSync(join(ROOT, p), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/\s\/\/.*$/gm, "");

const ACTION_WORDS = /approve|launch|retry|retri(?:es|ed)/i;

describe("City cannot act on a run", () => {
	test("the run screen renders text only: no button, form, handler or request", () => {
		const src = code("apps/web/src/Runs.tsx");
		expect(src).not.toMatch(
			/<button|<form|<input|<select|onClick|onSubmit|onChange/,
		);
		expect(src).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket/);
		expect(src).not.toMatch(ACTION_WORDS);
	});

	test("the web view sends only GETs", () => {
		const hub = code("apps/web/src/useHub.ts");
		expect(hub).not.toMatch(/method\s*:/);
		expect(hub).not.toMatch(ACTION_WORDS);
		expect(code("apps/web/src/App.tsx")).not.toMatch(/method\s*:/);
	});

	test("the read API has no write route and no action path", () => {
		const api = code("apps/hub/src/routes/api.ts");
		expect(api).not.toMatch(/\bapi\.(post|put|patch|delete|all)\(/);
		expect(api).not.toMatch(ACTION_WORDS);
	});

	test("the only way in is POST /ingest/runs, and it stores a report", () => {
		const runs = code("apps/hub/src/routes/runs.ts");
		expect(runs).not.toMatch(ACTION_WORDS);
		const routes = runs.match(/\bruns\.(post|put|patch|delete|get|all)\(/g);
		expect(routes).toEqual(["runs.post("]);
	});
});

// ── the main screen: apps/web/src/board/** (and apps/web/src/campus/** once the 3D scene lands) ──────
// Screen code only: *.test.ts files are not scanned (they spell out the codes they test). A directory
// that does not exist yet is skipped.
const SCREEN_DIRS = ["apps/web/src/board", "apps/web/src/campus"];

function screenFiles(dir: string): string[] {
	const abs = join(ROOT, dir);
	if (!existsSync(abs)) return [];
	return readdirSync(abs).flatMap((name) => {
		const rel = join(dir, name);
		if (statSync(join(ROOT, rel)).isDirectory()) return screenFiles(rel);
		return /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) ? [rel] : [];
	});
}
const FILES = SCREEN_DIRS.flatMap(screenFiles);

/**
 * The one place the action words may appear: Office's own state code `PLAN_APPROVED`, which the phrase
 * table must be able to name (it is data Office reports, not something City does). Nothing else is
 * allowed; the test below pins this list so it cannot grow quietly.
 */
const ALLOWED_OFFICE_CODES: Record<string, string[]> = {
	"apps/web/src/board/copy.ts": ["PLAN_APPROVED"],
};

/** `<button>` and `onClick` are for switching screens only. Nothing in the board needs them, so the list is empty. */
const ALLOWED_CONTROLS: Record<string, string[]> = {};

const screenCode = (rel: string) => {
	let src = code(rel);
	for (const lit of ALLOWED_OFFICE_CODES[rel] ?? [])
		src = src.replaceAll(lit, "");
	return src;
};

describe("the main screen cannot act on a run", () => {
	test("the scan finds the board (and survives a missing campus/ directory)", () => {
		expect(FILES.some((f) => f.endsWith("board/Board.tsx"))).toBe(true);
		expect(FILES.some((f) => f.endsWith("board/model.ts"))).toBe(true);
	});

	test("no request is sent from it: no fetch, no method:, no XMLHttpRequest, no socket of its own", () => {
		for (const f of FILES) {
			const src = code(f);
			expect({
				f,
				hit: /fetch\(|XMLHttpRequest|WebSocket|sendBeacon|method\s*:/.exec(
					src,
				)?.[0],
			}).toEqual({ f, hit: undefined });
		}
	});

	test("no approve / launch / retry anywhere in it", () => {
		for (const f of FILES) {
			expect({ f, hit: ACTION_WORDS.exec(screenCode(f))?.[0] }).toEqual({
				f,
				hit: undefined,
			});
		}
	});

	test("the allow-list of Office codes stays exactly one literal in one file", () => {
		expect(ALLOWED_OFFICE_CODES).toEqual({
			"apps/web/src/board/copy.ts": ["PLAN_APPROVED"],
		});
	});

	test("buttons and handlers only where listed (nowhere)", () => {
		const CONTROLS =
			/<button|<form|<input|<select|<textarea|onClick|onSubmit|onChange|onKey\w*|onPointer\w*|onMouse\w*/;
		for (const f of FILES) {
			const allowed = ALLOWED_CONTROLS[f] ?? [];
			const hit = CONTROLS.exec(code(f))?.[0];
			expect({
				f,
				hit: hit && !allowed.includes(hit) ? hit : undefined,
			}).toEqual({ f, hit: undefined });
		}
	});

	test("the 3D scene listens to no input: no pointer, mouse, key, wheel or touch listener", () => {
		const campus = FILES.filter((f) => f.includes("/campus/"));
		expect(campus.some((f) => f.endsWith("campus/engine.ts"))).toBe(true);
		for (const f of campus) {
			const hit =
				/addEventListener\(\s*["'](pointer\w*|mouse\w*|click|dblclick|key\w*|wheel|touch\w*|contextmenu)["']/.exec(
					code(f),
				)?.[0];
			expect({ f, hit }).toEqual({ f, hit: undefined });
		}
	});

	test("the scene is a lazy chunk and imports no hub, store or transport", () => {
		const view = code("apps/web/src/campus/CampusView.tsx");
		expect(view).toMatch(/lazy\(\(\) => import\("\.\/CampusScene\.tsx"\)\)/);
		expect(view).not.toMatch(/from "\.\/(CampusScene|engine|world)\.tsx?"/);
		for (const f of FILES.filter((x) => x.includes("/campus/"))) {
			expect({
				f,
				hub: /useHub|workspace-m1|store\.ts|transport/.exec(code(f))?.[0],
			}).toEqual({
				f,
				hub: undefined,
			});
		}
	});

	test("the data comes through useHub: the board only imports its hooks and pure modules", () => {
		const board = code("apps/web/src/board/Board.tsx");
		expect(board).toMatch(/from "\.\.\/useHub\.ts"/);
		const hub = code("apps/web/src/useHub.ts");
		expect(hub).toMatch(/useRunEvents/);
		// the only fetch in useHub goes through getJson, which sends a plain GET
		expect(hub.match(/fetch\(/g)).toHaveLength(1);
		expect(hub).toMatch(/await fetch\(path\)/);
	});

	test("nothing on screen is smaller than 16px", () => {
		const css = readFileSync(join(ROOT, "apps/web/src/style.css"), "utf8");
		const board = css.slice(css.indexOf("/* ── board"));
		expect(board.length).toBeGreaterThan(100);
		const sizes = [...board.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) =>
			Number(m[1]),
		);
		expect(sizes.length).toBeGreaterThan(5);
		expect(Math.min(...sizes)).toBeGreaterThanOrEqual(16);
		expect(Math.max(...sizes)).toBeGreaterThanOrEqual(44); // the status sentence
	});
});
