// Authority boundary of the campus: the scene can reach only the three intents of the frozen
// interface (select repository, select task, open approval document) — never the store, a
// transport, a gate or any workflow command. Static (imports, member access, export names) and
// behavioural (narrowing, dispatch, pick → intent) checks; no DOM, no WebGL.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCampusActions } from "./actions.ts";
import * as choreography from "./choreography.ts";
import * as engine from "./engine.ts";
import * as intents from "./intents.ts";
import {
	dispatchIntent,
	hqRequest,
	intentForPick,
	narrowActions,
} from "./intents.ts";
import * as layout from "./layout.ts";
import {
	CAMPUS_INTERFACE_VERSION,
	type CampusActions,
	type CampusModel,
} from "./presentation.ts";
import * as resources from "./resources.ts";
import * as visits from "./visits.ts";
import * as world from "./world.ts";

const HERE = import.meta.dir;
const read = (f: string) => readFileSync(join(HERE, f), "utf8");
const code = (f: string) =>
	read(f)
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** Everything that ships in or next to the lazy scene chunk, plus the DOM wrapper. */
const SCENE_FILES = [
	"CampusScene.tsx",
	"CampusView.tsx",
	"engine.ts",
	"world.ts",
	"layout.ts",
	"visits.ts",
	"choreography.ts",
	"resources.ts",
	"palette.ts",
	"intents.ts",
	"environment.ts",
];
const INTENTS = new Set(["selectRepo", "selectTask", "openRequest"]);
const WORKFLOW =
	/approv|accept|decid|decision|queue|advance|cancel|publish|rerun|sign|submit|command|transport|store|fetch|challenge|gate(?!_label)/i;

function importsOf(src: string): { spec: string; typeOnly: boolean }[] {
	const out: { spec: string; typeOnly: boolean }[] = [];
	const re = /import\s+(type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
	for (const m of src.matchAll(re))
		out.push({ spec: m[2] ?? "", typeOnly: Boolean(m[1]) });
	for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g))
		out.push({ spec: m[1] ?? "", typeOnly: false });
	return out;
}

describe("static boundary", () => {
	test("scene files import only three, react, their siblings and presentation TYPES", () => {
		const bad: string[] = [];
		for (const f of SCENE_FILES)
			for (const { spec, typeOnly } of importsOf(code(f))) {
				if (spec === "three" || spec === "react" || spec === "./campus.css")
					continue;
				if (spec === "./presentation.ts") {
					if (!typeOnly) bad.push(`${f}: runtime import of presentation.ts`);
					continue;
				}
				if (/^\.\/[\w-]+\.tsx?$/.test(spec) && spec !== "./actions.ts")
					continue;
				bad.push(`${f}: ${spec}`);
			}
		expect(bad).toEqual([]);
	});

	test("no network, storage, timers-as-commands or global event bus in scene files", () => {
		const hits = SCENE_FILES.filter((f) =>
			/\b(fetch|XMLHttpRequest|WebSocket|EventSource|localStorage|sessionStorage|indexedDB|document\.cookie|postMessage|dispatchEvent|CustomEvent|setInterval)\b/.test(
				code(f),
			),
		);
		expect(hits).toEqual([]);
	});

	test("every `actions.` / `safe.` member used is one of the three intents", () => {
		const used = new Set<string>();
		for (const f of SCENE_FILES)
			for (const m of code(f).matchAll(/\b(?:actions|safe)\.(\w+)/g))
				used.add(m[1] ?? "");
		expect([...used].filter((u) => !INTENTS.has(u))).toEqual([]);
		expect(used.size).toBeGreaterThan(0);
	});

	test("the engine, world, scheduler and plan never see the actions object", () => {
		for (const f of [
			"engine.ts",
			"world.ts",
			"visits.ts",
			"choreography.ts",
			"layout.ts",
		])
			expect(code(f)).not.toMatch(/\bactions\b|CampusActions/);
	});

	test("visit scheduling and poses take no callbacks (arrival can emit nothing)", () => {
		for (const f of ["visits.ts", "choreography.ts"]) {
			const src = code(f);
			expect(src).not.toMatch(/\bon[A-Z]\w*\s*[(:?]/);
			expect(src).not.toMatch(/=>\s*void/);
		}
		for (const fn of [
			visits.reconcileVisits,
			visits.visitProgress,
			choreography.figurePose,
		])
			expect(fn.toString()).not.toMatch(/\bcb\b|callback|emit/);
	});

	test("engine callbacks are scene facts only (pick, context lost/restored, first frame)", () => {
		const src = code("engine.ts");
		const block =
			/export interface EngineCallbacks \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? "";
		const names = [...block.matchAll(/^\s*(\w+)\(/gm)].map((m) => m[1]);
		expect(names).toEqual(["onPick", "onContextLost", "onRestored", "onReady"]);
	});

	test("exported names of the scene modules are on an allowlist and none is a workflow verb", () => {
		const exported: Record<string, string[]> = {
			engine: Object.keys(engine),
			world: Object.keys(world),
			visits: Object.keys(visits),
			choreography: Object.keys(choreography),
			layout: Object.keys(layout),
			intents: Object.keys(intents),
			resources: Object.keys(resources),
		};
		expect(exported).toEqual({
			engine: ["MAX_PIXEL_RATIO", "boundedPixelRatio", "createCampusEngine"],
			world: ["Kit", "buildCampusWorld"],
			visits: [
				"EMPTY_BOOK",
				"MAX_HEAD_START_MS",
				"MAX_WALK_MS",
				"MIN_WALK_MS",
				"WALK_SPEED",
				"anyWalking",
				"reconcileVisits",
				"visitProgress",
				"walkDurationMs",
			],
			choreography: ["figurePose", "sceneKey", "walkMsFor"],
			layout: [
				"DESK_SPOT",
				"FLOOR",
				"HQ_BOX",
				"REPO_BOX",
				"ROW_STEP",
				"campusLayout",
				"ceoRoute",
				"columnsFor",
				"lobbySpot",
				"officeSeat",
				"routeLength",
				"sampleRoute",
				"slotOf",
			],
			intents: [
				"dispatchIntent",
				"hqRequest",
				"intentForPick",
				"narrowActions",
			],
			resources: ["DisposalRegistry"],
		});
		const verbs = Object.values(exported)
			.flat()
			.filter((n) => WORKFLOW.test(n));
		expect(verbs).toEqual([]);
		const scene = read("CampusScene.tsx");
		expect(
			[...scene.matchAll(/^export (?:default )?(\w+)/gm)].map((m) => m[1]),
		).toEqual(["interface", "function"]);
	});
});

// ── behaviour ────────────────────────────────────────────────────────────────

function recorder() {
	const calls: string[] = [];
	const target = {
		selectRepo: (id: string) => calls.push(`selectRepo:${id}`),
		selectTask: (id: string) => calls.push(`selectTask:${id}`),
		openRequest: (id: string) => calls.push(`openRequest:${id}`),
		// authority the campus must never reach, even if a caller passes it along
		approve: () => calls.push("approve"),
		accept: () => calls.push("accept"),
		cancel: () => calls.push("cancel"),
		decide: () => calls.push("decide"),
		store: { navigate: () => calls.push("store.navigate") },
	};
	const touched = new Set<string | symbol>();
	const proxy = new Proxy(target, {
		get(t, k, r) {
			touched.add(k);
			return Reflect.get(t, k, r);
		},
	});
	return { calls, touched, actions: proxy as unknown as CampusActions };
}

const MODEL: CampusModel = {
	version: CAMPUS_INTERFACE_VERSION,
	provenance: null,
	connection: { status: "online", last_confirmed_at: null },
	view: "projects",
	repos: [
		{
			repo_id: "local/alpha",
			label: "alpha",
			selected: false,
			active_tasks: 0,
			pending_requests: 2,
			has_invalid_acceptance: false,
		},
	],
	tasks: [
		{
			task_id: "wst-1",
			repo_id: "local/alpha",
			title: "One",
			phase: "awaiting_run_approval" as CampusModel["tasks"][number]["phase"],
			selected: false,
			accepted: false,
			validity: null,
			execution: null,
			coverage: null,
		},
	],
	pending: [
		{
			request_id: "wsa-old",
			kind: "run",
			gate_label: "Execution approval",
			task_id: "wst-1",
			repo_id: "local/alpha",
			title: "One",
			created_at: "2026-10-03T10:00:00.000Z",
			selected: false,
		},
		{
			request_id: "wsa-new",
			kind: "result",
			gate_label: "Result acceptance",
			task_id: "wst-1",
			repo_id: "local/alpha",
			title: "One",
			created_at: "2026-10-03T10:01:00.000Z",
			selected: false,
		},
	],
	selected: { repo_id: null, task_id: null, request_id: null },
};

describe("behavioural boundary", () => {
	test("narrowActions exposes exactly the three intents, frozen, and forwards only them", () => {
		const r = recorder();
		const safe = narrowActions(r.actions);
		expect(Object.keys(safe).sort()).toEqual([
			"openRequest",
			"selectRepo",
			"selectTask",
		]);
		expect(Object.isFrozen(safe)).toBe(true);
		expect("approve" in safe).toBe(false);
		expect("store" in safe).toBe(false);
		safe.selectRepo("local/alpha");
		safe.selectTask("wst-1");
		safe.openRequest("wsa-old");
		expect(r.calls).toEqual([
			"selectRepo:local/alpha",
			"selectTask:wst-1",
			"openRequest:wsa-old",
		]);
		expect([...r.touched].sort()).toEqual([
			"openRequest",
			"selectRepo",
			"selectTask",
		]);
	});

	test("dispatchIntent calls exactly the matching intent, nothing else", () => {
		for (const intent of [
			{ kind: "selectRepo", id: "local/alpha" },
			{ kind: "selectTask", id: "wst-1" },
			{ kind: "openRequest", id: "wsa-old" },
		] as const) {
			const r = recorder();
			dispatchIntent(intent, narrowActions(r.actions));
			expect(r.calls).toEqual([`${intent.kind}:${intent.id}`]);
		}
	});

	test("a canvas pick becomes select-repository or open-document, or nothing", () => {
		expect(intentForPick({ kind: "repo", id: "local/alpha" }, MODEL)).toEqual({
			kind: "selectRepo",
			id: "local/alpha",
		});
		expect(
			intentForPick({ kind: "repo", id: "local/ghost" }, MODEL),
		).toBeNull();
		// Headquarters opens the oldest pending document (or the one already open)
		expect(intentForPick({ kind: "hq" }, MODEL)).toEqual({
			kind: "openRequest",
			id: "wsa-old",
		});
		const withSel: CampusModel = {
			...MODEL,
			pending: MODEL.pending.map((p) => ({
				...p,
				selected: p.request_id === "wsa-new",
			})),
		};
		expect(hqRequest(withSel)).toBe("wsa-new");
		expect(intentForPick({ kind: "hq" }, { ...MODEL, pending: [] })).toBeNull();
	});

	test("createCampusActions turns intents into selection routes only, ignoring unknown ids", () => {
		const routes: unknown[] = [];
		const a = createCampusActions(
			(r) => routes.push(r),
			() => MODEL,
		);
		expect(Object.keys(a).sort()).toEqual([
			"openRequest",
			"selectRepo",
			"selectTask",
		]);
		a.selectRepo("local/alpha");
		a.selectRepo("local/ghost");
		a.selectTask("wst-1");
		a.selectTask("wst-ghost");
		a.openRequest("wsa-new");
		a.openRequest("wsa-ghost");
		expect(routes).toEqual([
			{
				view: "projects",
				repoId: "local/alpha",
				taskId: null,
				requestId: null,
			},
			{
				view: "projects",
				repoId: "local/alpha",
				taskId: "wst-1",
				requestId: null,
			},
			{ view: "hq", repoId: null, taskId: "wst-1", requestId: "wsa-new" },
		]);
	});

	test("actions.ts imports only types (route, presentation)", () => {
		const specs = importsOf(code("actions.ts"));
		expect(specs).toEqual([
			{ spec: "../route.ts", typeOnly: true },
			{ spec: "./presentation.ts", typeOnly: true },
		]);
	});
});
