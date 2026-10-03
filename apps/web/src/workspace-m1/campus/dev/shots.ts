// Campus screenshots + browser checks (Worker B, dev tool; UI-fixture evidence only).
//
//   …/iso/run.sh env PLAYWRIGHT_BROWSERS_PATH=/Users/edwardhwang/Library/Caches/ms-playwright \
//     bun --no-env-file apps/web/src/workspace-m1/campus/dev/shots.ts
//
// Isolation: the existing programmatic Vite server (../../dev/fixture-server.ts: no config file,
// empty envDir, TMPDIR cache, loopback, port ≠ 4317, no proxy, no hub) with the fixture + UI
// defines; cached headless Chromium; a context route guard that aborts anything not served by this
// Vite origin and every /api request. WebGL runs use SwiftShader; the no-WebGL run uses
// --disable-webgl --disable-3d-apis. GL objects are counted per context by an init script so the
// mount/unmount cycles can show that every context is released.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Browser,
	type BrowserContext,
	chromium,
	type Page,
} from "playwright-core";
import {
	FIXTURE_DEFINE,
	startFixtureServer,
} from "../../dev/fixture-server.ts";

const PAGE = "/src/workspace-m1/campus/dev/preview.html";
const DEFINE = { ...FIXTURE_DEFINE, __AGENTCITY_WORKSPACE_UI__: "true" };
const GL_ARGS = [
	"--use-angle=swiftshader",
	"--enable-unsafe-swiftshader",
	"--ignore-gpu-blocklist",
];
const NOGL_ARGS = ["--disable-webgl", "--disable-3d-apis"];
const SIZES = [
	{ name: "1440x900", width: 1440, height: 900 },
	{ name: "1280x800", width: 1280, height: 800 },
] as const;

const outDir = mkdtempSync(join(tmpdir(), "agentcity-campus-shots-"));
const shots: string[] = [];
const checks: { name: string; ok: boolean; detail: string }[] = [];
const blocked: string[] = [];
const apiCalls: string[] = [];
const consoleErrors: string[] = [];
const requested = { gl: [] as string[], nogl: [] as string[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function check(name: string, fn: () => Promise<string | undefined>) {
	try {
		const detail = (await fn()) ?? "";
		checks.push({ name, ok: true, detail });
	} catch (err) {
		checks.push({
			name,
			ok: false,
			detail: (err as Error).message.split("\n")[0]?.slice(0, 300) ?? "",
		});
	}
}

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(msg);
}

const GL_COUNTERS = `(() => {
	const per = new WeakMap(); const all = [];
	const keyOf = { createBuffer: "buffers", createTexture: "textures", createProgram: "programs",
		createFramebuffer: "framebuffers", createRenderbuffer: "renderbuffers", createVertexArray: "vaos" };
	const del = { deleteBuffer: "buffers", deleteTexture: "textures", deleteProgram: "programs",
		deleteFramebuffer: "framebuffers", deleteRenderbuffer: "renderbuffers", deleteVertexArray: "vaos" };
	const stats = (ctx) => { let s = per.get(ctx); if (!s) { s = { created: {}, deleted: {} }; per.set(ctx, s); all.push({ ctx, s }); } return s; };
	for (const C of [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext]) {
		if (!C) continue;
		const P = C.prototype;
		for (const [fn, k] of Object.entries(keyOf)) { if (!P[fn]) continue; const o = P[fn];
			P[fn] = function (...a) { const r = o.apply(this, a); if (r) { const s = stats(this); s.created[k] = (s.created[k] || 0) + 1; } return r; }; }
		for (const [fn, k] of Object.entries(del)) { if (!P[fn]) continue; const o = P[fn];
			P[fn] = function (x) { if (x) { const s = stats(this); s.deleted[k] = (s.deleted[k] || 0) + 1; } return o.call(this, x); }; }
	}
	const raf = { calls: 0 }; const r0 = globalThis.requestAnimationFrame.bind(globalThis);
	globalThis.requestAnimationFrame = (cb) => { raf.calls += 1; return r0(cb); };
	globalThis.__gl = {
		raf,
		details() {
			return all.map(({ ctx, s }) => ({ lost: ctx.isContextLost(), created: s.created, deleted: s.deleted }));
		},
		summary() {
			const out = { contexts: all.length, live: 0, held: {}, unreleasedOnLoss: {} };
			for (const { ctx, s } of all) {
				const lost = ctx.isContextLost();
				if (!lost) out.live += 1;
				for (const k of Object.keys(s.created)) {
					const left = (s.created[k] || 0) - (s.deleted[k] || 0);
					const bucket = lost ? out.unreleasedOnLoss : out.held;
					bucket[k] = (bucket[k] || 0) + left;
				}
			}
			return out;
		},
	};
})();`;

async function newContext(
	browser: Browser,
	origin: string,
	size: { width: number; height: number },
	opts: { reducedMotion?: "reduce" | "no-preference"; bucket: "gl" | "nogl" },
): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({
		viewport: { width: size.width, height: size.height },
		deviceScaleFactor: 1,
		reducedMotion: opts.reducedMotion ?? "no-preference",
	});
	await context.route("**/*", (route) => {
		const u = new URL(route.request().url());
		if (u.origin !== origin) {
			blocked.push(u.href);
			return route.abort();
		}
		if (u.pathname.startsWith("/api/")) {
			apiCalls.push(u.pathname);
			return route.abort();
		}
		requested[opts.bucket].push(u.pathname);
		return route.continue();
	});
	await context.addInitScript(GL_COUNTERS);
	const page = await context.newPage();
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
	});
	page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
	return { context, page };
}

let loads = 0;
async function open(page: Page, origin: string, query: string) {
	loads += 1;
	const q = query ? `${query}&load=${loads}` : `?load=${loads}`;
	await page.goto(`${origin}${PAGE}${q}#/projects`);
	await page.waitForFunction(
		() =>
			(globalThis as unknown as { __campusPreview?: { ready: boolean } })
				.__campusPreview?.ready === true,
		null,
		{ timeout: 30_000 },
	);
	await page.waitForSelector(".cmp", { timeout: 30_000 });
}

async function waitLive(page: Page) {
	await page.waitForSelector('.cmp[data-scene-state="live"]', {
		timeout: 60_000,
	});
	await sleep(400);
}

async function shot(page: Page, size: string, name: string) {
	const facts = await page.evaluate(() => {
		const de = document.documentElement;
		const cmp = document.querySelector(".cmp");
		return {
			overflowX: de.scrollWidth > de.clientWidth,
			state: cmp?.getAttribute("data-scene-state") ?? null,
			buildings: document.querySelectorAll(".cmp-building").length,
			visits: document.querySelectorAll(".cmp-visit").length,
		};
	});
	const file = join(outDir, `${size}-${name}.png`);
	await page.screenshot({ path: file });
	shots.push(file);
	assert(!facts.overflowX, `${name}: horizontal page overflow`);
	return facts;
}

async function seed(page: Page) {
	await page.evaluate(async () => {
		const c = (globalThis as Record<string, unknown>)
			.__AGENTCITY_WORKSPACE_FIXTURE_CONTROLS__ as {
			seedDemo(): Promise<Record<string, string>>;
		};
		await c.seedDemo();
	});
}

async function glRun(browser: Browser, origin: string) {
	for (const size of SIZES) {
		const { context, page } = await newContext(browser, origin, size, {
			bucket: "gl",
		});
		await check(
			`${size.name}: overview, walking CEO, arrival, selection, HQ`,
			async () => {
				await open(page, origin, "");
				await waitLive(page);
				const webgl2 = await page.evaluate(
					() => document.createElement("canvas").getContext("webgl2") !== null,
				);
				assert(webgl2, "webgl2 unavailable in the GL run");
				const empty = await shot(page, size.name, "01-overview-empty");
				assert(
					empty.state === "live" && empty.buildings === 1,
					`empty: ${JSON.stringify(empty)}`,
				);
				await seed(page);
				await page.waitForSelector(".cmp-visit", { timeout: 10_000 });
				const seenAt = Date.now();
				await sleep(2_600);
				const walking = await shot(page, size.name, "02-ceo-visits-walking");
				assert(walking.visits >= 2, `walking: ${JSON.stringify(walking)}`);
				// the same ids on every 2 s poll: no extra visitors appear while they walk
				const before = await page.evaluate(
					() => document.querySelectorAll(".cmp-visit").length,
				);
				await sleep(4_200);
				const after = await page.evaluate(
					() => document.querySelectorAll(".cmp-visit").length,
				);
				assert(
					before === after,
					`visit list changed on re-poll: ${before} → ${after}`,
				);
				await sleep(Math.max(0, 21_000 - (Date.now() - seenAt)));
				// arrived: render-on-demand → no animation frames while idle
				const raf0 = await page.evaluate(
					() =>
						(globalThis as unknown as { __gl: { raf: { calls: number } } }).__gl
							.raf.calls,
				);
				await sleep(1_500);
				const raf1 = await page.evaluate(
					() =>
						(globalThis as unknown as { __gl: { raf: { calls: number } } }).__gl
							.raf.calls,
				);
				assert(raf1 - raf0 <= 1, `animation frames while idle: ${raf1 - raf0}`);
				await shot(page, size.name, "03-overview-arrived");
				await page.click('.cmp-building[data-repo-id="local/fixture"]');
				await sleep(1_400);
				const sel = await shot(page, size.name, "04-selected-building");
				assert(sel.state === "live", "selected: scene not live");
				const reqId = await page.getAttribute(
					".cmp-visit >> nth=0",
					"data-request-id",
				);
				await page.click(".cmp-visit >> nth=0");
				await sleep(1_400);
				await shot(page, size.name, "05-hq-document-open");
				const intents = await page.evaluate(
					() =>
						(
							globalThis as unknown as {
								__campusPreview: { intents: string[] };
							}
						).__campusPreview.intents,
				);
				assert(
					JSON.stringify(intents) ===
						JSON.stringify([
							"selectRepo(local/fixture)",
							`openRequest(${reqId})`,
						]),
					`intents: ${JSON.stringify(intents)}`,
				);
				const hash = await page.evaluate(() => location.hash);
				assert(hash.startsWith("#/hq/"), `route after openRequest: ${hash}`);
				return `idle rAF Δ=${raf1 - raf0}; intents=${JSON.stringify(intents)}; hash=${hash}`;
			},
		);

		if (size.name === "1440x900") {
			await check("1440x900: hidden tab pauses the walk loop", async () => {
				await open(page, origin, "");
				await waitLive(page);
				await seed(page);
				await page.waitForSelector(".cmp-visit", { timeout: 10_000 });
				await sleep(2_300);
				const n0 = await page.evaluate(
					() =>
						(globalThis as unknown as { __gl: { raf: { calls: number } } }).__gl
							.raf.calls,
				);
				await sleep(500);
				const walkingRate =
					(await page.evaluate(
						() =>
							(globalThis as unknown as { __gl: { raf: { calls: number } } })
								.__gl.raf.calls,
					)) - n0;
				await page.evaluate(() => {
					Object.defineProperty(document, "hidden", {
						configurable: true,
						get: () => true,
					});
					document.dispatchEvent(new Event("visibilitychange"));
				});
				await sleep(150);
				const h0 = await page.evaluate(
					() =>
						(globalThis as unknown as { __gl: { raf: { calls: number } } }).__gl
							.raf.calls,
				);
				await sleep(1_000);
				const hiddenRate =
					(await page.evaluate(
						() =>
							(globalThis as unknown as { __gl: { raf: { calls: number } } })
								.__gl.raf.calls,
					)) - h0;
				await page.evaluate(() => {
					Object.defineProperty(document, "hidden", {
						configurable: true,
						get: () => false,
					});
					document.dispatchEvent(new Event("visibilitychange"));
				});
				await sleep(500);
				const r0 = await page.evaluate(
					() =>
						(globalThis as unknown as { __gl: { raf: { calls: number } } }).__gl
							.raf.calls,
				);
				await sleep(500);
				const resumed =
					(await page.evaluate(
						() =>
							(globalThis as unknown as { __gl: { raf: { calls: number } } })
								.__gl.raf.calls,
					)) - r0;
				assert(walkingRate > 0, "no frames while walking");
				assert(hiddenRate === 0, `frames while hidden: ${hiddenRate}`);
				assert(resumed > 0, "loop did not resume");
				return `frames/0.5s walking=${walkingRate}, hidden(1s)=${hiddenRate}, resumed/0.5s=${resumed}`;
			});

			await check(
				"1440x900: context loss → note + DOM usable; restore → live",
				async () => {
					await open(page, origin, "?seed=1");
					await waitLive(page);
					await page.evaluate(() => {
						const gl = document.querySelector("canvas")?.getContext("webgl2");
						(globalThis as Record<string, unknown>).__lose =
							gl?.getExtension("WEBGL_lose_context");
						(
							globalThis as unknown as { __lose?: { loseContext(): void } }
						).__lose?.loseContext();
					});
					await page.waitForSelector('.cmp[data-scene-state="paused"]', {
						timeout: 10_000,
					});
					const note = (await page.textContent(".cmp-note")) ?? "";
					await shot(page, size.name, "08-context-lost");
					const usable = await page.isEnabled(".cmp-building >> nth=0");
					await page.evaluate(() =>
						(
							globalThis as unknown as { __lose?: { restoreContext(): void } }
						).__lose?.restoreContext(),
					);
					await page.waitForSelector('.cmp[data-scene-state="live"]', {
						timeout: 15_000,
					});
					assert(/graphics context was lost/.test(note), `note: ${note}`);
					assert(usable, "building button not usable while paused");
					return `note="${note.trim()}"`;
				},
			);

			await check(
				"1440x900: visits keyed by request id — polling never multiplies, invalidation ends one",
				async () => {
					await open(page, origin, "?seed=1");
					await waitLive(page);
					const visitors = () => page.getAttribute(".cmp-gl", "data-visitors");
					const v0 = await visitors();
					const samples: (string | null)[] = [];
					for (let i = 0; i < 4; i += 1) {
						await sleep(1_100); // spans two 2 s polls
						samples.push(await visitors());
					}
					const gate1 = await page.evaluate(
						() =>
							(
								globalThis as unknown as {
									__campusPreview: { seeded: Record<string, string> };
								}
							).__campusPreview.seeded.gate1,
					);
					assert(gate1, "seeded gate1 task id missing");
					await page.evaluate((id) => {
						const c = (globalThis as Record<string, unknown>)
							.__AGENTCITY_WORKSPACE_FIXTURE_CONTROLS__ as {
							invalidateRunRequest(taskId: string, reason?: string): boolean;
						};
						c.invalidateRunRequest(id, "policy_changed");
					}, gate1);
					await page.waitForFunction(
						() =>
							document
								.querySelector(".cmp-gl")
								?.getAttribute("data-visitors") === "2",
						null,
						{ timeout: 6_000 },
					);
					const listed = await page.locator(".cmp-visit").count();
					const intents = await page.evaluate(
						() =>
							(
								globalThis as unknown as {
									__campusPreview: { intents: string[] };
								}
							).__campusPreview.intents,
					);
					assert(
						v0 === "3" && samples.every((s) => s === "3"),
						`visitors over polls: ${v0} ${samples.join(",")}`,
					);
					assert(
						listed === 2,
						`documents listed after invalidation: ${listed}`,
					);
					assert(
						intents.length === 0,
						`intents emitted without a click: ${JSON.stringify(intents)}`,
					);
					return `visitors ${v0} → [${samples.join(",")}] → 2 after invalidation; intents emitted: 0`;
				},
			);

			await check(
				"1440x900: mount/unmount ×5 releases every context and GL object",
				async () => {
					await open(page, origin, "?seed=1");
					await waitLive(page);
					const rows: string[] = [];
					for (let i = 0; i < 5; i += 1) {
						await page.evaluate(() =>
							(
								globalThis as unknown as {
									__campusPreview: { setMounted(b: boolean): void };
								}
							).__campusPreview.setMounted(false),
						);
						await sleep(300);
						const s = await page.evaluate(() => ({
							gl: (
								globalThis as unknown as { __gl: { summary(): unknown } }
							).__gl.summary(),
							canvases: document.querySelectorAll("canvas").length,
							pins: document.querySelectorAll(".cmp-pin").length,
						}));
						rows.push(JSON.stringify(s));
						const g = s.gl as { live: number; held: Record<string, number> };
						assert(g.live === 0, `live contexts after unmount: ${g.live}`);
						assert(
							Object.values(g.held).every((v) => v === 0),
							`held objects: ${JSON.stringify(g.held)}`,
						);
						assert(
							s.canvases === 0 && s.pins === 0,
							"DOM leftovers after unmount",
						);
						await page.evaluate(() =>
							(
								globalThis as unknown as {
									__campusPreview: { setMounted(b: boolean): void };
								}
							).__campusPreview.setMounted(true),
						);
						await waitLive(page);
					}
					return rows[rows.length - 1];
				},
			);
		}

		await context.close();

		const reduced = await newContext(browser, origin, size, {
			reducedMotion: "reduce",
			bucket: "gl",
		});
		await check(
			`${size.name}: reduced motion (visitors already seated) + integrity warning`,
			async () => {
				await open(reduced.page, origin, "?seed=1&invalid=1");
				await waitLive(reduced.page);
				const f = await shot(
					reduced.page,
					size.name,
					"06-reduced-motion-integrity",
				);
				const attr = await reduced.page.getAttribute(
					".cmp",
					"data-reduced-motion",
				);
				const badge = await reduced.page.textContent(
					'.cmp-building[data-integrity="invalid"] .cmp-badge',
				);
				const raf0 = await reduced.page.evaluate(
					() =>
						(globalThis as unknown as { __gl: { raf: { calls: number } } }).__gl
							.raf.calls,
				);
				await sleep(1_000);
				const raf1 = await reduced.page.evaluate(
					() =>
						(globalThis as unknown as { __gl: { raf: { calls: number } } }).__gl
							.raf.calls,
				);
				assert(attr === "true", "reduced motion not detected");
				assert(badge?.includes("Integrity warning"), "integrity badge missing");
				assert(raf1 - raf0 <= 1, `frames under reduced motion: ${raf1 - raf0}`);
				return `visits=${f.visits}, rAF Δ(1s)=${raf1 - raf0}`;
			},
		);
		await reduced.context.close();

		if (size.name === "1440x900") {
			const stress = await newContext(browser, origin, size, {
				reducedMotion: "reduce",
				bucket: "gl",
			});
			await check(
				"1440x900: layout stress, 8 buildings (7 placeholder repos in the model)",
				async () => {
					await open(stress.page, origin, "?seed=1&repos=7");
					await waitLive(stress.page);
					const f = await shot(
						stress.page,
						size.name,
						"09-layout-stress-8-repos",
					);
					assert(f.buildings === 8, `buildings: ${f.buildings}`);
					return `buildings=${f.buildings}`;
				},
			);
			await stress.context.close();
		}
	}
}

async function noGlRun(browser: Browser, origin: string) {
	for (const size of SIZES) {
		const { context, page } = await newContext(browser, origin, size, {
			bucket: "nogl",
		});
		await check(
			`${size.name}: WebGL disabled → DOM layer + note, scene chunk never fetched`,
			async () => {
				await open(page, origin, "?seed=1&invalid=1");
				await page.waitForSelector('.cmp[data-scene-state="unavailable"]', {
					timeout: 15_000,
				});
				await page.waitForSelector(".cmp-visit", { timeout: 10_000 });
				const nullCtx = await page.evaluate(
					() =>
						document.createElement("canvas").getContext("webgl2") === null &&
						document.createElement("canvas").getContext("webgl") === null,
				);
				const f = await shot(page, size.name, "07-webgl-disabled-dom-layer");
				const note = (await page.textContent(".cmp-note")) ?? "";
				// a pending-document button still opens the document (selection only)
				await page.click(".cmp-visit >> nth=0");
				await sleep(300);
				const hash = await page.evaluate(() => location.hash);
				assert(nullCtx, "WebGL context was created despite the flags");
				assert(f.state === "unavailable" && f.visits >= 2, JSON.stringify(f));
				assert(/unavailable in this browser/.test(note), `note: ${note}`);
				assert(hash.startsWith("#/hq/"), `openRequest without WebGL: ${hash}`);
				assert(
					(await page.locator("canvas").count()) === 0,
					"canvas present without WebGL",
				);
				return `note="${note.trim()}"; hash=${hash}`;
			},
		);
		await context.close();
	}
}

const { server, origin } = await startFixtureServer({ define: DEFINE });
const gl = await chromium.launch({ headless: true, args: GL_ARGS });
const nogl = await chromium.launch({ headless: true, args: NOGL_ARGS });
try {
	await glRun(gl, origin);
	await noGlRun(nogl, origin);
} finally {
	await gl.close();
	await nogl.close();
	await server.close();
}

const sceneChunk = (paths: string[]) =>
	paths.filter((p) =>
		/CampusScene\.tsx|\/engine\.ts|\/world\.ts|\/deps\/three/.test(p),
	);
await check("lazy chunk: requested with WebGL, never without", async () => {
	const withGl = sceneChunk(requested.gl);
	const without = sceneChunk(requested.nogl);
	assert(withGl.length > 0, "scene modules never requested in the GL run");
	assert(
		without.length === 0,
		`scene modules requested without WebGL: ${without.join(", ")}`,
	);
	return `GL run fetched ${[...new Set(withGl)].join(", ")}`;
});
await check(
	"isolation: no foreign origin, no /api call, no console error",
	async () => {
		assert(blocked.length === 0, `blocked: ${blocked.slice(0, 5).join(", ")}`);
		assert(apiCalls.length === 0, `api: ${apiCalls.slice(0, 5).join(", ")}`);
		assert(
			consoleErrors.length === 0,
			`console: ${consoleErrors.slice(0, 5).join(" | ")}`,
		);
		return undefined;
	},
);

const report = { outDir, shots, checks };
writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
for (const c of checks)
	console.log(
		`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`,
	);
console.log(`\nscreenshots (${shots.length}) in ${outDir}`);
for (const s of shots) console.log(`  ${s}`);
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
