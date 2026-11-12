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
		// the detail screen (16 A3): its controls only filter what is shown; it sends nothing
		const detail = code("apps/web/src/Detail.tsx");
		expect(detail).not.toMatch(/method\s*:/);
		expect(detail).not.toMatch(
			/fetch\(|XMLHttpRequest|WebSocket|<form|onSubmit/,
		);
		expect(detail).not.toMatch(ACTION_WORDS);
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

// ── the main screen: apps/web/src/board/**, the 3D campus apps/web/src/campus/** and the ring town ───
// apps/web/src/town/** (the default scene). Screen code only: *.test.ts files are not scanned (they spell
// out the codes they test), nor is the ported engine's .mjs (TypeScript only). A directory that does not
// exist yet is skipped.
const SCREEN_DIRS = [
	"apps/web/src/board",
	"apps/web/src/campus",
	"apps/web/src/town",
];

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

	test("the 3D scene and the town listen to no input: no pointer, mouse, key, wheel or touch listener", () => {
		const scenes = FILES.filter(
			(f) => f.includes("/campus/") || f.includes("/town/"),
		);
		expect(scenes.some((f) => f.endsWith("campus/engine.ts"))).toBe(true);
		expect(scenes.some((f) => f.endsWith("town/stage.ts"))).toBe(true);
		for (const f of scenes) {
			const hit =
				/addEventListener\(\s*["'](pointer\w*|mouse\w*|click|dblclick|key\w*|wheel|touch\w*|contextmenu)["']/.exec(
					code(f),
				)?.[0];
			expect({ f, hit }).toEqual({ f, hit: undefined });
		}
	});

	test("the scenes are lazy chunks and import no hub, store or transport", () => {
		const view = code("apps/web/src/campus/CampusView.tsx");
		expect(view).toMatch(
			/lazy\([\s\S]*?import\("\.\/CampusScene\.tsx"\)\.catch\(/,
		);
		expect(view).not.toMatch(/from "\.\/(CampusScene|engine|world)\.tsx?"/);
		const town = code("apps/web/src/town/TownView.tsx");
		expect(town).toMatch(
			/lazy\([\s\S]*?import\("\.\/TownScene\.tsx"\)\.catch\(/,
		);
		expect(town).not.toMatch(
			/from "\.\/(TownScene|TownMinimap|stage|pipeline|world|patrol|lots|live)\.tsx?"|from "\.\/engine\/|from "three"/,
		);
		// the board reaches the town only through TownView and the tiny URL module
		expect(
			code("apps/web/src/board/Board.tsx").match(/from "\.\.\/town\/[^"]+"/g),
		).toEqual(['from "../town/params.ts"', 'from "../town/TownView.tsx"']);
		expect(code("apps/web/src/town/params.ts")).not.toMatch(/\bimport\b/);
		for (const f of FILES.filter(
			(x) => x.includes("/campus/") || x.includes("/town/"),
		)) {
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

	test("sessions (decision D4) come from useHub too; only session-panel.ts reads a session's folder or branch (D5, D10)", () => {
		expect(FILES.some((f) => f.endsWith("board/sessions.ts"))).toBe(true);
		const sessions = code("apps/web/src/board/sessions.ts");
		expect(sessions).not.toMatch(/useHub|fetch\(|WebSocket/);
		expect(code("apps/web/src/board/Board.tsx")).toMatch(/hub\.sessions/);
		// decision D10 (15 §3): one pure module reads them — the folder only to make tail paths relative
		// (never drawn), the branch as a project's tag; no component reads either
		const READS = new Set(["apps/web/src/board/session-panel.ts"]);
		expect(code("apps/web/src/board/session-panel.ts")).toMatch(/\.cwd\b/);
		for (const f of FILES.filter((x) => !READS.has(x))) {
			expect({ f, hit: /\.(cwd|branch)\b/.exec(code(f))?.[0] }).toEqual({
				f,
				hit: undefined,
			});
		}
	});

	test("nothing on screen is smaller than 10.5px; the status sentence is the one big line (28px)", () => {
		const css = readFileSync(join(ROOT, "apps/web/src/style.css"), "utf8");
		const board = css.slice(css.indexOf("/* ── board"));
		expect(board.length).toBeGreaterThan(100);
		const sizes = [
			...board.matchAll(/font-size:\s*(?:calc\()?([\d.]+)px/g),
		].map((m) => Number(m[1]));
		expect(sizes.length).toBeGreaterThan(5);
		expect(Math.min(...sizes)).toBeGreaterThanOrEqual(10.5);
		expect(Math.max(...sizes)).toBe(28); // the status sentence
	});

	test("decision D10 (15 §1): panel text 10.5–14px × --ui, the sentence 28px unscaled, two weights", () => {
		const css = readFileSync(join(ROOT, "apps/web/src/style.css"), "utf8");
		const board = css.slice(css.indexOf("/* ── board"));
		const decls = [...board.matchAll(/font-size:\s*([^;]+);/g)].map((m) =>
			(m[1] as string).trim(),
		);
		const fixed = decls.filter((d) => !d.startsWith("calc("));
		expect(fixed).toEqual(["28px"]);
		for (const d of decls.filter((x) => x.startsWith("calc("))) {
			const m = /^calc\(([\d.]+)px \* var\(--ui\)\)$/.exec(d);
			const px = m ? Number(m[1]) : Number.NaN;
			expect({ d, ok: px >= 10.5 && px <= 14 }).toEqual({ d, ok: true });
		}
		const weights = new Set(
			[...board.matchAll(/font-weight:\s*(\w+)/g)].map((m) => m[1]),
		);
		expect([...weights].sort()).toEqual(["400", "700"]);
	});
});

// ── the town's ported engine: apps/web/src/town/engine/*.mjs ─────────────────────────────────────
// Copied verbatim from the original game (engine/PROVENANCE.md), so it is plain JavaScript and the
// TypeScript scan above does not see it. Scanned here for the same things: input listeners and
// controls, requests, action words. The original's minimap DOM section (`minimapSection`: hover,
// click, Escape and a Focus button that steers the original's guide) is the one known exception; it is
// pinned below and no screen code may import it.
const ENGINE_DIR = "apps/web/src/town/engine";
const ENGINE_FILES = readdirSync(join(ROOT, ENGINE_DIR))
	.filter((n) => n.endsWith(".mjs"))
	.map((n) => `${ENGINE_DIR}/${n}`);
const ENGINE_HIT =
	/addEventListener\(|\.on(?:click|dblclick|key\w*|pointer\w*|mouse\w*|wheel|touch\w*|input|change|submit|contextmenu)\s*=|["'`](?:pointer\w*|mouse\w*|click|dblclick|key(?:down|up|press)|wheel|touch\w*|contextmenu|button|input|select|form|textarea)["'`]|<(?:button|form|input|select|textarea)\b|fetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|method\s*:/g;

/** File → every distinct ENGINE_HIT it may contain. Pinned by the test below so it cannot grow quietly. */
const ALLOWED_ENGINE_HITS: Record<string, string[]> = {
	"apps/web/src/town/engine/minimap.mjs": [
		"'button'",
		"'click'",
		"'keydown'",
		"'pointer'", // canvas.style.cursor on hover
		"'pointerleave'",
		"'pointermove'",
		"addEventListener(",
	],
};

describe("the town engine cannot act either", () => {
	test("the scan finds the engine", () => {
		expect(ENGINE_FILES.length).toBeGreaterThanOrEqual(20);
		expect(ENGINE_FILES).toContain(`${ENGINE_DIR}/scene-ring.mjs`);
		expect(ENGINE_FILES).toContain(`${ENGINE_DIR}/minimap.mjs`);
	});

	test("no listener, control or request outside the pinned list", () => {
		for (const f of ENGINE_FILES) {
			const hits = [
				...new Set([...code(f).matchAll(ENGINE_HIT)].map((m) => m[0])),
			].sort();
			expect({ f, hits }).toEqual({ f, hits: ALLOWED_ENGINE_HITS[f] ?? [] });
		}
	});

	test("no approve / launch / retry in the engine code", () => {
		for (const f of ENGINE_FILES)
			expect({ f, hit: ACTION_WORDS.exec(code(f))?.[0] }).toEqual({
				f,
				hit: undefined,
			});
	});

	test("the allow-list stays exactly the minimap's DOM section", () => {
		expect(Object.keys(ALLOWED_ENGINE_HITS)).toEqual([
			"apps/web/src/town/engine/minimap.mjs",
		]);
		expect(ALLOWED_ENGINE_HITS["apps/web/src/town/engine/minimap.mjs"]).toEqual(
			[
				"'button'",
				"'click'",
				"'keydown'",
				"'pointer'", // canvas.style.cursor on hover
				"'pointerleave'",
				"'pointermove'",
				"addEventListener(",
			],
		);
		// every hit in minimap.mjs lives inside minimapSection
		const src = code("apps/web/src/town/engine/minimap.mjs");
		const at = src.indexOf("export const minimapSection");
		expect(at).toBeGreaterThan(0);
		expect([...src.slice(0, at).matchAll(ENGINE_HIT)]).toEqual([]);
	});

	test("no screen code imports the minimap's DOM section", () => {
		const town = FILES.filter((f) => f.includes("/town/"));
		expect(town.length).toBeGreaterThan(0);
		for (const f of FILES) {
			const src = code(f);
			expect({ f, hit: /minimapSection/.exec(src)?.[0] }).toEqual({
				f,
				hit: undefined,
			});
			// no namespace / default import of minimap.mjs either (it would carry the section along)
			expect({
				f,
				hit: /import\s+(?:\*\s+as\s+\w+|\w+)\s+from\s+["'][^"']*minimap\.mjs["']/.exec(
					src,
				)?.[0],
			}).toEqual({ f, hit: undefined });
		}
		// and the declarations give TypeScript no way to name it
		const decl = join(ROOT, ENGINE_DIR, "minimap.d.mts");
		if (existsSync(decl))
			expect(readFileSync(decl, "utf8")).not.toMatch(/minimapSection/);
	});
});
