// Regression gate for silent hub reads and post-renderer initialization failures.
// Usage: bun --no-env-file apps/web/e2e/workspace-m1/campus-recovery.suite.ts <isolated-production-outDir>
// Production index/assets only; authenticated API uses the existing disposable real-hub harness.
// Fake providers, cached Chromium, free loopback ports; no root env, live provider or real database.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	type Browser,
	type BrowserContext,
	type Route as BrowserRoute,
	chromium,
	type Page,
} from "playwright-core";
import { formatHash } from "../../src/workspace-m1/route.ts";
import { startWorkspaceEnv, type WorkspaceEnv } from "../workspace-harness.ts";
import { campusProbe, GL_ARGS, GL_COUNTER_SCRIPT } from "./campus-kit.ts";
import {
	check,
	grantButton,
	navLink,
	openTask,
	Run,
	scrub,
	sigField,
	signIn,
	submitNew,
	until,
} from "./kit.ts";

const output = process.argv[2] ?? "";
check(
	output && isAbsolute(output) && existsSync(join(output, "index.html")),
	"provide an existing isolated production outDir",
);
const run = new Run("HUB", null);
let env!: WorkspaceEnv;
let browser!: Browser;
const rawConsole: { phase: string; text: string }[] = [];
const expectedConsole = (text: string, phase: string) =>
	text ===
		"Failed to load resource: the server responded with a status of 401 (Unauthorized)" ||
	(phase.startsWith("init-") &&
		text.includes("WebSocket connection") &&
		text.includes("ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS"));

async function context(
	phase: string,
	width = 1280,
	height = 800,
): Promise<BrowserContext> {
	const ctx = await browser.newContext({ viewport: { width, height } });
	ctx.on("page", (page) => {
		page.on("console", (message) => {
			if (message.type() !== "error") return;
			const text = scrub(message.text(), run.secrets);
			rawConsole.push({ phase, text });
			if (!expectedConsole(text, phase)) run.consoleErrors.push(text);
		});
		page.on("pageerror", (error) =>
			run.consoleErrors.push(scrub(error.message, run.secrets)),
		);
	});
	await ctx.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (url.origin !== env.uiUrl) {
			run.blockedOrigins.push(url.origin);
			return route.abort();
		}
		if (url.pathname.startsWith("/api/") || url.pathname === "/healthz")
			return route.continue();
		if (url.pathname === "/favicon.ico")
			return route.fulfill({ status: 204, body: "" });
		const file = url.pathname.startsWith("/assets/")
			? url.pathname.slice(1)
			: "index.html";
		await route.fulfill({
			body: readFileSync(join(output, file)),
			contentType: file.endsWith(".js")
				? "application/javascript"
				: file.endsWith(".css")
					? "text/css"
					: "text/html",
		});
	});
	return ctx;
}

function requestFor(
	taskId: string,
	kind: string,
): { id: string; managed_task_id: string } {
	const row = env.fx.db
		.query(
			"SELECT id, managed_task_id FROM managed_approval_requests WHERE workspace_task_id=? AND kind=?",
		)
		.get(taskId, kind);
	check(row, `missing ${kind} request`);
	return row as { id: string; managed_task_id: string };
}
const decision = (id: string) =>
	JSON.stringify(
		env.fx.db
			.query("SELECT * FROM managed_decisions WHERE approval_request_id=?")
			.get(id),
	);

async function accept(page: Page, width: number) {
	const taskId = await submitNew(page, {
		title: `Recovery regression ${width}`,
		criteria: "Fixture check passes\nChange stays within src/",
	});
	const first = requestFor(taskId, "run");
	check(
		(
			env.fx.db
				.query("SELECT count(*) n FROM managed_runs WHERE task_id=?")
				.get(first.managed_task_id) as { n: number }
		).n === 0,
		"proposal executed",
	);
	await page.locator(`.cmp-visit[data-request-id="${first.id}"]`).click();
	check(
		(await sigField(page, "run").inputValue()) === "",
		"execution signature prefilled",
	);
	await sigField(page, "run").pressSequentially("Edward");
	await until(() => grantButton(page, "run").isEnabled(), "execution enabled");
	await sigField(page, "run").press("Enter");
	check(decision(first.id) === "null", "Enter approved execution");
	await grantButton(page, "run").click();
	await until(
		() =>
			!!env.fx.db
				.query(
					"SELECT id FROM managed_approval_requests WHERE workspace_task_id=? AND kind='result'",
				)
				.get(taskId),
		"result request",
		60_000,
	);
	const result = requestFor(taskId, "result");
	const chip = page.locator(`.cmp-visit[data-request-id="${result.id}"]`);
	await chip.waitFor();
	await chip.click();
	await sigField(page, "result").waitFor();
	check(
		(await sigField(page, "result").inputValue()) === "",
		"acceptance reused signature",
	);
	await sigField(page, "result").pressSequentially("Edward");
	await until(
		() => grantButton(page, "result").isEnabled(),
		"acceptance enabled",
	);
	await sigField(page, "result").press("Enter");
	check(decision(result.id) === "null", "Enter accepted result");
	await grantButton(page, "result").click();
	await until(
		async () =>
			(await page
				.getByTestId("acceptance-status")
				.getAttribute("data-status")) === "accepted",
		"accepted",
	);
	return { taskId, resultId: result.id, receipt: decision(result.id) };
}

async function silent(page: Page, history: boolean, resultId: string) {
	const block = page.getByTestId("acceptance-validity").first();
	await until(
		async () => (await block.getAttribute("data-freshness")) === "fresh",
		"fresh before silence",
	);
	const initialAge = await page
		.getByTestId("validity-freshness")
		.first()
		.innerText();
	const receipt = decision(resultId);
	const held: BrowserRoute[] = [];
	let posts = 0;
	const countPost = (request: { method(): string }) => {
		if (request.method() !== "GET") posts++;
	};
	page.on("request", countPost);
	await page.route("**/api/workspace/**", (route) => {
		if (route.request().method() === "GET") held.push(route);
		else void route.continue();
	});
	try {
		// No navigation/input/read completion while the clock crosses the 10-second threshold and fetch timeout.
		await until(
			async () => (await block.getAttribute("data-freshness")) === "stale",
			"silent connection becomes stale without interaction",
			14_000,
		);
		await page.waitForTimeout(8_000);
		check(
			(await block.getAttribute("data-freshness")) === "stale",
			"silent reading became fresh after fetch timeout",
		);
		check(
			(await block.getAttribute("data-status")) === "valid",
			"presentation changed authoritative status",
		);
		check(
			(await block.getAttribute("class"))?.includes("wsm1-tone-neutral"),
			"stale validity remained green",
		);
		check(
			!(await block.innerText()).includes("Current evidence verified"),
			"unqualified verified during silence",
		);
		check(
			(await block.innerText()).includes(
				"connection to the hub is offline or stale",
			),
			"silent connection not qualified",
		);
		check(
			(await page.getByTestId("validity-freshness").first().innerText()) !==
				initialAge,
			"check age frozen",
		);
		if (history) {
			const line = page.getByTestId("history-acceptance-validity").first();
			check(
				(await line.getAttribute("data-freshness")) === "stale",
				"history freshness frozen",
			);
			check(
				(await line.innerText()).includes("may be out of date"),
				"history unqualified",
			);
		}
		check(
			(
				await page.locator('output[aria-label="Connection"]').innerText()
			).includes("Connection stale"),
			"connection banner remained unqualified online",
		);
		check(posts === 0, "clock emitted a mutation");
		check(decision(resultId) === receipt, "clock changed receipt");
		await run.shot(
			page,
			history ? "recovery-silent-hq-history" : "recovery-silent-task",
		);
		return `${held.length} pending GETs; increasing age, neutral/stale task${history ? " + HQ/history" : ""}; 0 mutations; receipt unchanged`;
	} finally {
		await page.unroute("**/api/workspace/**");
		for (const route of held) await route.abort().catch(() => undefined);
		page.off("request", countPost);
		await until(
			async () => (await block.getAttribute("data-freshness")) === "fresh",
			"reconnect restores fresh",
			20_000,
		);
	}
}

async function freshnessCases() {
	for (const [width, height] of [
		[1440, 900],
		[1280, 800],
	] as const) {
		run.viewport = `${width}x${height}`;
		const ctx = await context("freshness", width, height);
		const page = await ctx.newPage();
		run.current = page;
		try {
			await page.goto(env.uiUrl);
			await signIn(page, env.credential);
			const accepted = await accept(page, width);
			await openTask(page, accepted.taskId);
			await run.case(`REC-F1-task-${width}`, () =>
				silent(page, false, accepted.resultId),
			);
			await page.goto(
				env.uiUrl +
					formatHash({
						view: "hq",
						repoId: null,
						taskId: accepted.taskId,
						requestId: accepted.resultId,
					}),
			);
			await run.case(`REC-F1-hq-history-${width}`, () =>
				silent(page, true, accepted.resultId),
			);
			await run.case(`REC-F1-old-check-${width}`, async () => {
				// A controlled browser-clock advance exercises a >60-second reading with successful hub polls.
				// Server time/validity and receipts remain authoritative; this is not a real 65-second delay.
				await page.evaluate(() => {
					const original = Date.now;
					Date.now = () => original() + 65_000;
					Object.defineProperty(window, "__recoveryNow", {
						value: original,
						configurable: true,
					});
				});
				try {
					await until(
						async () =>
							(await page
								.getByTestId("validity-freshness")
								.first()
								.getAttribute("data-cause")) === "old_check",
						"old check with confirmed connection",
						10_000,
					);
					check(
						(await page
							.getByTestId("acceptance-validity")
							.first()
							.getAttribute("data-status")) === "valid",
						"clock rewrote validity",
					);
					check(
						(await page
							.getByTestId("history-acceptance-validity")
							.first()
							.getAttribute("data-freshness")) === "stale",
						"old history remained green",
					);
					check(
						decision(accepted.resultId) === accepted.receipt,
						"old-check clock rewrote acceptance",
					);
					await run.shot(page, "recovery-old-check-confirmed-connection");
					return "controlled +65-second browser clock; confirmed polls, old_check/stale, original receipt";
				} finally {
					await page.evaluate(() => {
						Date.now = (
							window as unknown as Window & { __recoveryNow: typeof Date.now }
						).__recoveryNow;
					});
				}
			});
		} finally {
			await ctx.close();
		}
	}
}

const LIFE_COUNTER = `(() => {
 const observations = new Map(); const listeners = new Map(); const frames = new Set(); let disconnects = 0; let faults = 0;
 const observe = ResizeObserver.prototype.observe; const disconnect = ResizeObserver.prototype.disconnect;
 ResizeObserver.prototype.observe = function(el,...args) { if(el.classList.contains('cmp-gl')) observations.set(this,el); return observe.call(this,el,...args); };
 ResizeObserver.prototype.disconnect = function() { if(observations.delete(this)) disconnects++; return disconnect.call(this); };
 const add = EventTarget.prototype.addEventListener; const remove = EventTarget.prototype.removeEventListener;
 EventTarget.prototype.addEventListener = function(type,listener,...args) { if((this===document && type==='visibilitychange') || (this instanceof HTMLCanvasElement && this.classList.contains('cmp-canvas'))) { let list=listeners.get(this); if(!list) listeners.set(this,list=[]); list.push({type,listener}); } return add.call(this,type,listener,...args); };
 EventTarget.prototype.removeEventListener = function(type,listener,...args) { const list=listeners.get(this); if(list) {const at=list.findIndex(x=>x.type===type && x.listener===listener); if(at>=0) list.splice(at,1); if(!list.length) listeners.delete(this);} return remove.call(this,type,listener,...args); };
 const request = requestAnimationFrame; const cancel = cancelAnimationFrame;
 window.requestAnimationFrame = (fn) => { let id; id=request(t=>{frames.delete(id);fn(t)}); frames.add(id);return id; };
 window.cancelAnimationFrame = (id) => {frames.delete(id);cancel(id)};
 window.__recoveryFault = () => faults++;
 window.__recoveryLife = () => ({observers:observations.size,listeners:[...listeners.values()].reduce((n,l)=>n+l.length,0),frames:frames.size,disconnects,faults});
})();`;
const FAILURES = {
	observer: `(() => {const original=ResizeObserver.prototype.observe;ResizeObserver.prototype.observe=function(el,...args){if(el.classList.contains('cmp-gl')){ original.call(this,el,...args);window.__recoveryFault();throw Error('injected observer initialization failure');}return original.call(this,el,...args)}})();`,
	update: `(() => {const original=Element.prototype.append;Element.prototype.append=function(...args){if(this.classList.contains('cmp-pins')){window.__recoveryFault();throw Error('injected initial update failure')}return original.apply(this,args)}})();`,
	resize: `(() => {const original=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,'width');Object.defineProperty(HTMLCanvasElement.prototype,'width',{...original,set(value){if(this.classList.contains('cmp-canvas')){window.__recoveryFault();throw Error('injected initial resize failure')}return original.set.call(this,value)}});})();`,
};
interface Life {
	observers: number;
	listeners: number;
	frames: number;
	disconnects: number;
	faults: number;
}
async function initializationCases() {
	run.viewport = "1280x800";
	for (const [phase, inject] of Object.entries(FAILURES)) {
		await run.case(`REC-F2-${phase}`, async () => {
			const ctx = await context(`init-${phase}`);
			await ctx.addInitScript(GL_COUNTER_SCRIPT);
			await ctx.addInitScript(LIFE_COUNTER);
			await ctx.addInitScript(inject);
			const page = await ctx.newPage();
			run.current = page;
			const counts: number[] = [];
			try {
				await page.goto(env.uiUrl);
				await signIn(page, env.credential);
				for (let cycle = 0; cycle < 3; cycle++) {
					if (cycle) await navLink(page, /^Projects$/).click();
					await page
						.locator('.cmp[data-scene-state="unavailable"]')
						.waitFor({ timeout: 30_000 });
					await until(
						async () => (await campusProbe(page)).glLive === 0,
						"failed initializer releases context",
					);
					check(
						await page.locator(".cmp-building").isEnabled(),
						"fallback building unavailable",
					);
					await navLink(page, /^Activity$/).click();
					await until(
						async () => (await campusProbe(page)).glLive === 0,
						"unmount releases failed context",
					);
					const life = await page.evaluate(() =>
						(
							window as unknown as Window & { __recoveryLife(): Life }
						).__recoveryLife(),
					);
					check(life.faults === cycle + 1, "fault boundary was not reached");
					check(
						life.observers === 0 && life.listeners === 0 && life.frames === 0,
						`retained callbacks ${JSON.stringify(life)}`,
					);
					check(
						life.disconnects === cycle + 1,
						"scene observer not disconnected",
					);
					counts.push((await campusProbe(page)).glLive);
				}
				return `3 failed starts, live contexts after unmount ${counts.join("/")}; 0 observers/listeners/frames; DOM fallback usable`;
			} finally {
				await ctx.close();
			}
		});
	}
}

let code = 1;
try {
	env = await startWorkspaceEnv();
	run.secrets.add(env.credential);
	browser = await chromium.launch({ headless: true, args: GL_ARGS });
	await freshnessCases();
	await initializationCases();
	run.record(
		"REC-G-provider",
		(
			env.fx.db
				.query(
					"SELECT count(*) n FROM managed_runs WHERE provider <> 'fake' OR mode <> 'simulated'",
				)
				.get() as { n: number }
		).n === 0
			? "PASS"
			: "FAIL",
		"fake/simulated only",
	);
	run.record(
		"REC-G-origin",
		run.blockedOrigins.length === 0 ? "PASS" : "FAIL",
		`${run.blockedOrigins.length} outside-origin requests`,
	);
	run.record(
		"REC-G-console",
		run.consoleErrors.length === 0 ? "PASS" : "FAIL",
		`${run.consoleErrors.length} unexpected errors; expected 401 and injected-context Activity local-network WS errors retained`,
	);
	code = run.results.some((result) => result.status === "FAIL") ? 1 : 0;
} catch (error) {
	run.record("REC-setup", "FAIL", String((error as Error).message));
} finally {
	await browser?.close();
	await env?.stop();
	const file = run.writeSummary({
		mode: "isolated production + real hub",
		rawConsole,
	});
	console.log(`[RECOVERY] summary ${file}`);
	console.log(
		`[RECOVERY] PASS ${run.results.filter((r) => r.status === "PASS").length} / FAIL ${run.results.filter((r) => r.status === "FAIL").length}`,
	);
}
process.exit(code);
