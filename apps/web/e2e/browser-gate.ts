// `bun run test:browser` — the managed-task browser regression gate (v0.1.1 P3).
//
// Launch contract (isolation):
//   - the hub runs IN THIS PROCESS on a disposable fixture (mkdtemp repo, temp SQLite file,
//     synthetic tokens) on a free 127.0.0.1 port — never :4317, never the real DB or .env;
//   - Vite is started programmatically with `configFile: false` and `envDir` pointing at an empty
//     temp directory, so apps/web/vite.config.ts (which loads the repo-root .env and defaults its
//     proxy to :4317) is NOT used; the proxy targets only this run's hub;
//   - before any mutation the gate proves it talks to its own hub (this run's token is accepted and
//     the config names this run's unique repo id);
//   - live mode is enabled only against generated stub executables inside the fixture directory
//     (checked below); no real provider CLI can be reached (no PATH lookup);
//   - Chromium is the cached Playwright build with a fresh temporary profile (no personal profile);
//   - everything created here is removed at the end except the screenshot directory (printed).
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { type Browser, chromium, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { openDb } from "../../hub/src/db.ts";
import { startHub } from "../../hub/src/index.ts";
import { getTask, listArtifacts } from "../../hub/src/managed/store.ts";
import {
	type Fixture,
	makeFixture,
	stubDir,
} from "../../hub/src/managed/testkit.ts";

const WEB_ROOT = resolve(import.meta.dir, "..");
const NONCE = randomBytes(4).toString("hex");
const TOKEN = `gate-${randomBytes(16).toString("hex")}`; // synthetic, this run only
const INGEST = `gate-ingest-${randomBytes(12).toString("hex")}`;
const REPO_ID = `local/gate-${NONCE}`;

interface Result {
	name: string;
	ok: boolean;
	detail: string;
	ms: number;
}
const results: Result[] = [];
const shots: string[] = [];

async function step(name: string, fn: () => Promise<void>): Promise<void> {
	const t0 = Date.now();
	try {
		await fn();
		results.push({ name, ok: true, detail: "", ms: Date.now() - t0 });
	} catch (err) {
		results.push({
			name,
			ok: false,
			detail: (err as Error).message.split("\n")[0]?.slice(0, 300) ?? "",
			ms: Date.now() - t0,
		});
	}
}

function assert(cond: unknown, message: string): asserts cond {
	if (!cond) throw new Error(message);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): number {
	const s = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response(),
	});
	const port = s.port as number;
	s.stop(true);
	return port;
}

// ── environment ──────────────────────────────────────────────────────────────

let fx!: Fixture;
const handles: {
	hub: ReturnType<typeof startHub> | null;
	vite: ViteDevServer | null;
	browser: Browser | null;
} = { hub: null, vite: null, browser: null };
let hubPort = 0;
let base = "";
const evidenceDir = realpathSync(
	mkdtempSync(join(tmpdir(), "agentcity-browser-evidence-")),
);

function startTestHub(db = fx.db) {
	handles.hub = startHub({
		db,
		ingestToken: INGEST,
		hostname: "127.0.0.1",
		port: hubPort,
		managed: { config: fx.config, token: TOKEN },
		managedIdleMs: 100,
	});
}

async function api<T>(path: string, json?: unknown): Promise<T> {
	const res = await fetch(`${base}/api/managed${path}`, {
		method: json === undefined ? "GET" : "POST",
		headers: {
			authorization: `Bearer ${TOKEN}`,
			...(json === undefined ? {} : { "content-type": "application/json" }),
		},
		body: json === undefined ? undefined : JSON.stringify(json),
	});
	if (!res.ok) throw new Error(`${path} → ${res.status}`);
	return (await res.json()) as T;
}

let keys = 0;
async function createTask(over: Record<string, unknown>): Promise<string> {
	const { task } = await api<{ task: { id: string } }>("/tasks", {
		idempotency_key: `gate-${NONCE}-${++keys}`,
		repo_id: REPO_ID,
		title: `Gate task ${keys}`,
		objective: "Browser gate fixture task.",
		acceptance_criteria: ["The fixture check passes"],
		approved_scope: ["."],
		execution_mode: "simulated",
		simulation_scenario: "approve",
		...over,
	});
	return task.id;
}

const taskCount = async () =>
	(await api<{ tasks: unknown[] }>("/tasks")).tasks.length;

// ── page helpers ─────────────────────────────────────────────────────────────

async function shot(page: Page, name: string) {
	const path = join(
		evidenceDir,
		`${String(shots.length + 1).padStart(2, "0")}-${name}.png`,
	);
	await page.screenshot({ path, fullPage: true });
	shots.push(path);
}

async function select(page: Page, id: string) {
	await page.locator(`[data-testid=task-row][data-task-id="${id}"]`).click();
	await page
		.locator(`[data-testid=task-detail][data-task-id="${id}"]`)
		.waitFor();
}

async function waitState(
	page: Page,
	id: string,
	text: string,
	timeout = 20_000,
) {
	await page
		.locator(
			`[data-testid=task-detail][data-task-id="${id}"] [data-testid=detail-state]`,
		)
		.filter({ hasText: text })
		.waitFor({ timeout });
}

/**
 * Keyboard focus is on THIS task's detail heading. The view moves focus in an effect after the
 * detail renders, so the exact condition is awaited — bounded, and no other element counts.
 */
async function focusedDetail(page: Page, id: string, timeout = 3_000) {
	try {
		await page.waitForFunction(
			(want) => {
				const el = document.activeElement;
				return (
					el?.getAttribute("data-testid") === "detail-heading" &&
					el
						.closest("[data-testid=task-detail]")
						?.getAttribute("data-task-id") === want
				);
			},
			id,
			{ timeout, polling: 50 },
		);
	} catch {
		const where = await page.evaluate(() => {
			const el = document.activeElement;
			const owner = el
				?.closest("[data-testid=task-detail]")
				?.getAttribute("data-task-id");
			return `${el?.tagName.toLowerCase()}[data-testid=${el?.getAttribute("data-testid")}] in ${owner ?? "no task detail"}`;
		});
		throw new Error(`focus is on ${where}, not on the heading of ${id}`);
	}
}

async function fillForm(
	page: Page,
	o: {
		title: string;
		objective?: string;
		criteria?: string;
		scenario?: string;
	},
) {
	await page.getByTestId("new-title").fill(o.title);
	await page
		.getByTestId("new-objective")
		.fill(o.objective ?? "Created by the browser gate.");
	await page
		.getByTestId("new-criteria")
		.fill(o.criteria ?? "The fixture check passes");
	if (o.scenario)
		await page.getByTestId("new-scenario").selectOption(o.scenario);
}

// ── run ──────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
	fx = makeFixture({ liveStubs: {}, dbFile: true, repoId: REPO_ID });
	// stub-only exception: both provider executables must be the generated stubs in the fixture
	const stubs = stubDir(fx);
	for (const exe of [
		fx.config.live.claude?.executable,
		fx.config.live.codex?.executable,
	]) {
		assert(exe?.startsWith(stubs), "live provider is not a fixture stub");
		assert(
			readFileSync(`${exe}.ts`, "utf8").includes("const NAME ="),
			"not a generated stub",
		);
	}
	hubPort = freePort();
	assert(hubPort !== 4317, "refusing the default hub port");
	startTestHub();
	const hubUrl = `http://127.0.0.1:${hubPort}`;

	const envDir = join(fx.dir, "empty-env");
	mkdirSync(envDir);
	const vitePort = freePort();
	handles.vite = await createServer({
		configFile: false,
		root: WEB_ROOT,
		envDir,
		mode: "development",
		logLevel: "error",
		clearScreen: false,
		plugins: [react()],
		server: {
			host: "127.0.0.1",
			port: vitePort,
			strictPort: true,
			proxy: {
				"/healthz": hubUrl,
				"/api": hubUrl,
				"/ws": { target: hubUrl, ws: true },
			},
		},
	});
	await handles.vite.listen();
	base = `http://127.0.0.1:${vitePort}`;

	// identity: this run's token is accepted and names this run's repo — through the proxy
	const cfg = await api<{ repos: { id: string }[] }>("/config");
	assert(
		cfg.repos.map((r) => r.id).join() === REPO_ID,
		"proxy does not reach this run's hub",
	);

	// observed-session fixture (telemetry), via this run's ingest token
	await fetch(`${hubUrl}/ingest`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${INGEST}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			id: `gate-event-${NONCE}`,
			ts: new Date().toISOString(),
			machine_id: "cockpit",
			session_id: `gate-session-${NONCE}`,
			provider: "claude",
			type: "PreToolUse",
			summary: "fixture event",
		}),
	});

	handles.browser = await chromium.launch({ headless: true });
	const context = await handles.browser.newContext({
		viewport: { width: 1440, height: 1000 },
	});
	const page = await context.newPage();
	page.setDefaultTimeout(15_000);
	const consoleErrors: string[] = [];
	page.on("console", (m) => {
		const text = m.text();
		// expected: the gate provokes 401s and dropped connections on purpose
		const provoked =
			/WebSocket/.test(text) ||
			(/Failed to load resource/.test(text) &&
				// 401: token tests · 404: unknown deep link · 409: tampered evidence · 502: hub restart ·
				// 503: the "managed runs unavailable" focus probe
				/(status of (401|404|409|502|503)\b|ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED|ERR_FAILED)/.test(
					text,
				));
		if (m.type() === "error" && !provoked) consoleErrors.push(text);
	});

	await step("observed sessions tab renders fixture telemetry", async () => {
		await page.goto(`${base}/`);
		await page.getByRole("heading", { name: /Live sessions/ }).waitFor();
		await page.locator("tr.st-active").first().waitFor();
		await shot(page, "observed-sessions");
	});

	await step(
		"observed events: a late answer for an old repo filter cannot inject its rows",
		async () => {
			for (const repo of ["local/gate-x", "local/gate-y"])
				await fetch(`${hubUrl}/ingest`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${INGEST}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						id: `gate-${repo.slice(-1)}-${NONCE}`,
						ts: new Date().toISOString(),
						machine_id: "cockpit",
						session_id: `gate-session-${repo.slice(-1)}-${NONCE}`,
						provider: "claude",
						type: "PostToolUse",
						summary: `event of ${repo}`,
						repo_id: repo,
					}),
				});
			await page.reload();
			const select = page.getByLabel("repo filter");
			await select
				.locator('option[value="local/gate-x"]')
				.waitFor({ state: "attached" });
			await page.route("**/api/events?**", async (route) => {
				if (route.request().url().includes("gate-x")) await sleep(1_200);
				await route.continue();
			});
			await select.selectOption("local/gate-x");
			await select.selectOption("local/gate-y");
			await page
				.locator("ol.events li")
				.filter({ hasText: "event of local/gate-y" })
				.waitFor();
			await sleep(1_600); // the late gate-x answer lands now
			const rows = await page.locator("ol.events li").allTextContents();
			assert(
				rows.length > 0 && rows.every((r) => r.includes("gate-y")),
				`rows: ${rows.join(" | ")}`,
			);
			await page.unrouteAll();
			await select.selectOption("");
		},
	);

	await step("wrong token → rejected, gate shown again", async () => {
		await page.goto(`${base}/#tasks`);
		await shot(page, "token-gate");
		await page.getByTestId("token-input").fill("wrong-token-for-the-gate");
		await page.getByTestId("token-submit").click();
		await page
			.getByTestId("auth-error")
			.filter({ hasText: "rejected" })
			.waitFor();
		assert(await page.getByTestId("token-input").isVisible(), "gate not shown");
	});

	await step(
		"an old token's late 401 cannot clear a newer valid token",
		async () => {
			await page.route("**/api/managed/**", async (route) => {
				if (
					route.request().headers().authorization ===
					"Bearer old-token-late-401"
				) {
					await sleep(1_500);
				}
				await route.continue();
			});
			await page.getByTestId("token-input").fill("old-token-late-401");
			await page.getByTestId("token-submit").click();
			await page.getByTestId("authenticating").waitFor();
			await page.getByTestId("forget-token").click();
			await page.getByTestId("token-input").fill(TOKEN);
			await page.getByTestId("token-submit").click();
			await page.getByTestId("new-title").waitFor();
			await sleep(2_000); // the old 401 arrives now
			assert(
				await page.getByTestId("new-title").isVisible(),
				"new token was cleared",
			);
			assert(
				!(await page.getByTestId("auth-error").isVisible()),
				"late 401 purged",
			);
			await page.unrouteAll();
		},
	);

	await step("criteria keep commas; one line = one criterion", async () => {
		await fillForm(page, {
			title: "Comma criteria",
			criteria: "one, two and three\nsecond line, also",
		});
		await page.getByTestId("create-button").click();
		const detail = page.locator("[data-testid=task-detail]");
		await detail.waitFor();
		const items = await page
			.getByTestId("criteria")
			.locator("li")
			.allTextContents();
		assert(
			items.join("|") === "one, two and three|second line, also",
			`criteria were ${JSON.stringify(items)}`,
		);
	});

	await step(
		"lost create response: unchanged retry recovers exactly one task",
		async () => {
			const before = await taskCount();
			let aborted = false;
			await page.route("**/api/managed/tasks", async (route) => {
				if (route.request().method() === "POST" && !aborted) {
					aborted = true;
					await route.fetch(); // the hub creates the task …
					await route.abort("connectionreset"); // … but the answer is lost
					return;
				}
				await route.continue();
			});
			await fillForm(page, {
				title: "Lost response",
				criteria: "recovered once",
			});
			await page.getByTestId("create-button").click();
			await page.getByTestId("uncertain-create").waitFor();
			await shot(page, "uncertain-create");
			assert(
				(await taskCount()) === before + 1,
				"server did not create the task",
			);
			await page.getByTestId("create-button").click(); // same inputs
			await page.getByTestId("uncertain-create").waitFor({ state: "detached" });
			assert((await taskCount()) === before + 1, "retry created a duplicate");
			await page.unrouteAll();
		},
	);

	await step(
		"lost create + edited form → explicit recover-original keeps the later edit",
		async () => {
			const before = await taskCount();
			let aborted = false;
			await page.route("**/api/managed/tasks", async (route) => {
				if (route.request().method() === "POST" && !aborted) {
					aborted = true;
					await route.fetch();
					await route.abort("connectionreset");
					return;
				}
				await route.continue();
			});
			await fillForm(page, { title: "Diverge original" });
			await page.getByTestId("create-button").click();
			await page.getByTestId("uncertain-create").waitFor();
			await page.getByTestId("new-title").fill("Diverge edited");
			await page.getByTestId("create-button").click();
			await page.getByTestId("recover-original").click();
			await page.getByTestId("uncertain-create").waitFor({ state: "detached" });
			const titles = (
				await api<{ tasks: { title: string }[] }>("/tasks")
			).tasks.map((t) => t.title);
			assert(
				(await taskCount()) === before + 1,
				"recover created a second task",
			);
			assert(
				titles.includes("Diverge original") &&
					!titles.includes("Diverge edited"),
				"wrong task",
			);
			assert(
				(await page.getByTestId("new-title").inputValue()) === "Diverge edited",
				"the later edit was wiped",
			);
			await page.unrouteAll();
		},
	);

	await step(
		"a delayed create success does not wipe edits made meanwhile",
		async () => {
			await page.route("**/api/managed/tasks", async (route) => {
				if (route.request().method() === "POST") await sleep(1_000);
				await route.continue();
			});
			await fillForm(page, { title: "Slow create" });
			await page.getByTestId("create-button").click();
			await page.getByTestId("new-title").fill("Typed while waiting");
			await page
				.getByTestId("uncertain-create")
				.waitFor({ state: "detached" })
				.catch(() => {});
			await page
				.locator("[data-testid=task-detail]")
				.filter({ hasText: "Slow create" })
				.waitFor();
			assert(
				(await page.getByTestId("new-title").inputValue()) ===
					"Typed while waiting",
				"edit wiped by the delayed success",
			);
			await page.unrouteAll();
			await page.getByTestId("new-title").fill("");
		},
	);

	const a = await createTask({ title: "Race A" });
	const b = await createTask({ title: "Race B" });
	await page.reload();
	await page.getByTestId("new-title").waitFor();

	await step(
		"A→B selection: B's answer first, A's late answer cannot replace B",
		async () => {
			await page.route(`**/api/managed/tasks/${a}`, async (route) => {
				await sleep(1_200);
				await route.continue();
			});
			await page.locator(`[data-testid=task-row][data-task-id="${a}"]`).click();
			await page.locator(`[data-testid=task-row][data-task-id="${b}"]`).click();
			await page
				.locator(`[data-testid=task-detail][data-task-id="${b}"]`)
				.waitFor();
			await sleep(1_600);
			assert(
				await page
					.locator(`[data-testid=task-detail][data-task-id="${b}"]`)
					.isVisible(),
				"late A replaced B",
			);
			await page.unrouteAll();
		},
	);

	await step(
		"re-clicking the selected idle draft keeps its detail",
		async () => {
			await page.locator(`[data-testid=task-row][data-task-id="${b}"]`).click();
			await sleep(500);
			assert(
				await page
					.locator(`[data-testid=task-detail][data-task-id="${b}"]`)
					.isVisible(),
				"detail cleared",
			);
			assert(
				!(await page.getByTestId("detail-placeholder").isVisible()),
				"stuck on loading",
			);
		},
	);

	const ok = await createTask({
		title: "Gate success",
		simulation_scenario: "reject_then_approve",
	});
	await step(
		"simulated task: approve → run → evidence → simulated human-ready; stale snapshot cannot regress",
		async () => {
			await page.reload();
			await page.getByTestId("new-title").waitFor();
			await select(page, ok);
			// hold an OLD snapshot of this task and deliver it after newer ones
			let held = false;
			await page.route(`**/api/managed/tasks/${ok}`, async (route) => {
				if (!held) {
					held = true;
					const response = await route.fetch();
					await sleep(2_500);
					await route.fulfill({ response });
					return;
				}
				await route.continue();
			});
			await page
				.locator(`[data-testid=task-row][data-task-id="${ok}"]`)
				.click(); // the held request
			await page.getByTestId("run-button").dblclick();
			await waitState(page, ok, "simulated human-ready");
			await sleep(2_800); // the old snapshot lands now
			const detail = page.locator(
				`[data-testid=task-detail][data-task-id="${ok}"]`,
			);
			assert(
				(await detail.getByTestId("detail-state").textContent())?.includes(
					"simulated human-ready",
				),
				"regressed",
			);
			const rev = Number(await detail.getAttribute("data-rev"));
			assert(
				rev === getTask(fx.db, ok)?.rev,
				`shown rev ${rev} is not the latest`,
			);
			assert(
				(await detail.textContent())?.includes("SIMULATED — no model"),
				"mode label missing",
			);
			assert(
				(await detail.textContent())?.includes("Simulated result"),
				"simulated note missing",
			);
			await page.unrouteAll();
			await shot(page, "simulated-human-ready");
		},
	);

	await step(
		"artifact viewer: a late answer cannot reopen a closed viewer or replace a newer one",
		async () => {
			const diff = page
				.locator('[data-testid=artifact-link][data-name="diff.patch"]')
				.last();
			const manifest = page
				.locator('[data-testid=artifact-link][data-name="manifest.json"]')
				.last();
			const arts = listArtifacts(fx.db, ok);
			const diffId =
				arts.filter((x) => x.name === "diff.patch").at(-1)?.id ?? "-";
			await page.route(`**/artifacts/${diffId}`, async (route) => {
				await sleep(1_200);
				await route.continue();
			});
			await diff.click();
			await page.getByTestId("viewer-close").click();
			await sleep(1_600);
			assert(
				!(await page.getByTestId("viewer").isVisible()),
				"closed viewer reopened",
			);
			await diff.click();
			await manifest.click();
			await page
				.locator(
					'[data-testid=viewer][data-name="manifest.json"][data-state=ok]',
				)
				.waitFor();
			await sleep(1_600);
			assert(
				(await page.getByTestId("viewer").getAttribute("data-name")) ===
					"manifest.json",
				"late diff replaced the newer viewer",
			);
			const ident = (await page.getByTestId("viewer").textContent()) ?? "";
			assert(
				/attempt \d+/.test(ident) && /candidate [0-9a-f]{10}/.test(ident),
				"identity missing",
			);
			await page.unrouteAll();
		},
	);

	await step(
		"tampered evidence → integrity error in the viewer and the detail",
		async () => {
			const log = listArtifacts(fx.db, ok)
				.filter((x) => x.kind === "verification_log")
				.at(-1);
			assert(log, "no verification log");
			const path = join(fx.config.artifacts_root, log.rel_path);
			const buf = readFileSync(path);
			buf[0] = (buf[0] ?? 0) ^ 0x01;
			writeFileSync(path, buf);
			await page
				.locator(`[data-testid=artifact-link][data-name="${log.name}"]`)
				.last()
				.click();
			await page
				.getByTestId("viewer-error")
				.filter({ hasText: "integrity" })
				.waitFor();
			await page
				.locator(`[data-testid=task-row][data-task-id="${ok}"]`)
				.click();
			await page.getByTestId("evidence-integrity").waitFor();
			await shot(page, "evidence-integrity");
		},
	);

	await step(
		"failure path: failing verification ends failed, not human-ready",
		async () => {
			const id = await createTask({
				title: "Gate failure",
				simulation_scenario: "verification_fails",
			});
			await page.reload();
			await page.getByTestId("new-title").waitFor();
			await select(page, id);
			await page.getByTestId("run-button").click();
			await waitState(page, id, "failed");
			const diag = page.getByTestId("diagnostics");
			await diag.locator("summary").click();
			const text = (await diag.textContent()) ?? "";
			assert(
				text.includes("verification log") && text.includes("verify (failed)"),
				`diagnostics: ${text}`,
			);
			assert(
				!/force|dismiss|unlock/i.test(text),
				"diagnostics suggest an override",
			);
		},
	);

	await step("cancel path: running child cancelled from the UI", async () => {
		const id = await createTask({
			title: "Gate cancel",
			simulation_scenario: "impl_hangs",
		});
		await page.reload();
		await page.getByTestId("new-title").waitFor();
		await select(page, id);
		await page.getByTestId("run-button").click();
		await page
			.locator(`[data-testid=task-detail][data-task-id="${id}"]`)
			.filter({ hasText: "executing" })
			.waitFor();
		await sleep(300);
		await page.getByTestId("cancel-button").click();
		await waitState(page, id, "cancelled");
	});

	await step(
		"live mode (generated stubs only): labelled live — integration not live-verified",
		async () => {
			await page.getByTestId("new-title").fill("Gate live stub");
			await page
				.getByTestId("new-objective")
				.fill("Run against generated stubs.");
			await page.getByTestId("new-criteria").fill("The fixture check passes");
			await page.locator("select").nth(1).selectOption("live");
			await page.getByTestId("create-button").click();
			const detail = page
				.locator("[data-testid=task-detail]")
				.filter({ hasText: "Gate live stub" });
			await detail.waitFor();
			assert(
				(await detail.textContent())?.includes(
					"LIVE — integration not live-verified",
				),
				"live label",
			);
			await detail.getByTestId("run-button").click();
			await detail
				.getByTestId("detail-state")
				.filter({ hasText: "human-ready" })
				.waitFor({ timeout: 30_000 });
			assert(
				!(await detail.getByTestId("detail-state").textContent())?.includes(
					"simulated",
				),
				"live shown as simulated",
			);
			await shot(page, "live-stub-unverified");
		},
	);

	await step(
		"restart: a hub restart mid-run leaves the task interrupted, visible after reload",
		async () => {
			const id = await createTask({
				title: "Gate restart",
				simulation_scenario: "impl_hangs",
			});
			await page.reload();
			await page.getByTestId("new-title").waitFor();
			await select(page, id);
			await page.getByTestId("run-button").click();
			await page
				.locator(`[data-testid=task-detail][data-task-id="${id}"]`)
				.filter({ hasText: "executing" })
				.waitFor();
			await sleep(300);
			await handles.hub?.stop(); // stops the worker's child; the lease is left to expire
			fx.db.close();
			const db = openDb(fx.dbPath);
			fx = { ...fx, db };
			await sleep(fx.config.limits.lease_ttl_ms + 200);
			startTestHub(db);
			await page.reload();
			await page.getByTestId("new-title").waitFor();
			await select(page, id);
			await waitState(page, id, "interrupted", 15_000);
		},
	);

	await step(
		"reload keeps the tab and token; Observed sessions still works",
		async () => {
			await page.reload();
			await page.getByTestId("new-title").waitFor();
			assert(page.url().includes("#tasks"), "tab not restored");
			await page.getByRole("button", { name: "Observed sessions" }).click();
			await page.getByRole("heading", { name: /Live sessions/ }).waitFor();
			await page.getByRole("button", { name: "Managed tasks" }).click();
			await page.getByTestId("new-title").waitFor();
		},
	);

	await step(
		"deep links: #tasks/<id> restores the task after refresh; unknown id is explained",
		async () => {
			await page.goto(`${base}/#tasks/${ok}`);
			await page.reload();
			await page
				.locator(`[data-testid=task-detail][data-task-id="${ok}"]`)
				.waitFor();
			await focusedDetail(page, ok);
			await page.goto(
				`${base}/#tasks/task-00000000-0000-0000-0000-000000000000`,
			);
			await page.reload();
			await page.getByText("that task does not exist on this hub").waitFor();
			assert(page.url().endsWith("#tasks"), "the bad deep link was kept");
			await page.getByTestId("detail-placeholder").waitFor();
		},
	);

	await step("keyboard: Enter on a focused task row opens it", async () => {
		const row = page.locator(`[data-testid=task-row][data-task-id="${b}"]`);
		await row.focus();
		await page.keyboard.press("Enter");
		await page
			.locator(`[data-testid=task-detail][data-task-id="${b}"]`)
			.waitFor();
		assert(page.url().endsWith(`#tasks/${b}`), "deep link not updated");
		await focusedDetail(page, b);
	});

	await step(
		"deep links: a detail that answers before the token check still receives focus",
		async () => {
			// the hosted-CI order: the task's detail answers before /config + /tasks confirm the token
			// (the view still shows "checking the token"); holding the list forces that order here
			const order: string[] = [];
			const seen = (r: { url(): string }) => {
				const path = new URL(r.url()).pathname;
				if (path === "/api/managed/tasks") order.push("list");
				else if (path === `/api/managed/tasks/${ok}`) order.push("detail");
			};
			await page.route("**/api/managed/tasks", async (route) => {
				await sleep(800);
				await route.continue();
			});
			await page.goto(`${base}/#tasks/${ok}`);
			page.on("response", seen);
			await page.reload();
			await page
				.locator(`[data-testid=task-detail][data-task-id="${ok}"]`)
				.waitFor();
			page.off("response", seen);
			await page.unrouteAll();
			assert(
				order[0] === "detail",
				`the race was not reproduced (answers: ${order.join(" > ")})`,
			);
			await focusedDetail(page, ok);
		},
	);

	await step(
		"focus: background refreshes of the open task never take focus from the form",
		async () => {
			const id = await createTask({
				title: "Gate background refresh",
				simulation_scenario: "impl_hangs",
			});
			await page.reload();
			await page.getByTestId("new-title").waitFor();
			await select(page, id);
			await focusedDetail(page, id);
			await page.getByTestId("run-button").click();
			await page
				.locator(`[data-testid=task-detail][data-task-id="${id}"]`)
				.filter({ hasText: "executing" })
				.waitFor();
			// while it runs, the view re-fetches the list and this detail every 3 s (fallback poll)
			const title = page.getByTestId("new-title");
			await title.focus();
			await page.keyboard.type("typed during a refresh");
			for (let i = 0; i < 2; i++)
				await page.waitForResponse(
					(r) => r.url().endsWith(`/api/managed/tasks/${id}`),
					{ timeout: 10_000 },
				);
			await sleep(300); // the last re-fetched detail has rendered
			const active = await page.evaluate(() =>
				document.activeElement?.getAttribute("data-testid"),
			);
			assert(active === "new-title", `focus moved to ${active}`);
			assert(
				(await title.inputValue()) === "typed during a refresh",
				"typed text lost",
			);
			await title.fill("");
			await page.getByTestId("cancel-button").click();
			await waitState(page, id, "cancelled");
		},
	);

	await step(
		"focus: a late answer for an earlier selection never takes focus from the newer task",
		async () => {
			await page.route(`**/api/managed/tasks/${a}`, async (route) => {
				await sleep(1_200);
				await route.continue();
			});
			const late = page.waitForResponse((r) =>
				r.url().endsWith(`/api/managed/tasks/${a}`),
			);
			await page.locator(`[data-testid=task-row][data-task-id="${a}"]`).click();
			await page.locator(`[data-testid=task-row][data-task-id="${b}"]`).click();
			await page
				.locator(`[data-testid=task-detail][data-task-id="${b}"]`)
				.waitFor();
			await focusedDetail(page, b);
			await late; // A's answer has reached the page
			await sleep(300); // …and had a render to (wrongly) act on
			await focusedDetail(page, b, 500);
			assert(
				(await page
					.locator("[data-testid=task-detail]")
					.getAttribute("data-task-id")) === b,
				"the late answer replaced the newer task",
			);
			await page.unrouteAll();
		},
	);

	await step(
		"offline: a lost detail request shows an offline notice that clears on recovery",
		async () => {
			await page.route(`**/api/managed/tasks/${b}`, (route) =>
				route.abort("connectionrefused"),
			);
			await page.locator(`[data-testid=task-row][data-task-id="${b}"]`).click();
			await page.getByTestId("offline").waitFor();
			assert(
				await page
					.locator(`[data-testid=task-detail][data-task-id="${b}"]`)
					.isVisible(),
				"last loaded detail was dropped",
			);
			await page.unrouteAll();
			await page.locator(`[data-testid=task-row][data-task-id="${b}"]`).click();
			await page.getByTestId("offline").waitFor({ state: "detached" });
		},
	);

	// ── focus recovery probes (multi-repository milestone, concern D) ─────────────────────────
	const activeDesc = (p: Page) =>
		p.evaluate(() => {
			const el = document.activeElement;
			if (!el || el === document.body) return "body";
			const owner = el
				.closest("[data-testid=task-detail]")
				?.getAttribute("data-task-id");
			return `${el.tagName.toLowerCase()}[data-testid=${el.getAttribute("data-testid")}]${owner ? ` in ${owner}` : ""}`;
		});

	await step(
		"focus: closing the evidence viewer returns focus to the link that opened it",
		async () => {
			await select(page, ok);
			const link = page
				.locator(
					`[data-testid=task-detail][data-task-id="${ok}"] [data-testid=artifact-link][data-name="manifest.json"]`,
				)
				.last();
			await link.focus();
			await page.keyboard.press("Enter");
			await page.getByTestId("viewer").waitFor();
			await page.getByTestId("viewer-close").focus();
			await page.keyboard.press("Enter");
			await page.getByTestId("viewer").waitFor({ state: "detached" });
			await sleep(150);
			const back = await link.evaluate((el) => el === document.activeElement);
			assert(
				back,
				`focus after closing the viewer is on ${await activeDesc(page)}`,
			);
		},
	);

	await step(
		"focus: rapid selection A→B→A lands on A's heading; late answers never move it",
		async () => {
			await page.route(`**/api/managed/tasks/${a}`, async (route) => {
				await sleep(800);
				await route.continue();
			});
			try {
				const rowA = page.locator(
					`[data-testid=task-row][data-task-id="${a}"]`,
				);
				const rowB = page.locator(
					`[data-testid=task-row][data-task-id="${b}"]`,
				);
				await rowA.click();
				await rowB.click();
				await rowA.click();
				await page
					.locator(`[data-testid=task-detail][data-task-id="${a}"]`)
					.waitFor();
				await focusedDetail(page, a);
				await sleep(1_400); // every delayed answer has landed and rendered
				await focusedDetail(page, a, 500);
				assert(
					(await page
						.locator("[data-testid=task-detail]")
						.getAttribute("data-task-id")) === a,
					"a late answer replaced the selected task",
				);
			} finally {
				await page.unrouteAll();
			}
		},
	);

	await step(
		"focus: a deep-linked detail never takes focus from a field the user is already typing in",
		async () => {
			await page.route(`**/api/managed/tasks/${b}`, async (route) => {
				await sleep(1_500);
				await route.continue();
			});
			try {
				await page.goto(`${base}/#tasks/${b}`);
				await page.reload();
				const title = page.getByTestId("new-title");
				await title.waitFor();
				assert(
					(await page
						.locator(`[data-testid=task-detail][data-task-id="${b}"]`)
						.count()) === 0,
					"the detail answered before typing started (race not reproduced)",
				);
				await title.focus();
				await page.keyboard.type("typing before the detail");
				await page
					.locator(`[data-testid=task-detail][data-task-id="${b}"]`)
					.waitFor({ timeout: 10_000 });
				await sleep(300);
				const where = await activeDesc(page);
				const value = await title.inputValue();
				await title.fill("");
				assert(
					where === "input[data-testid=new-title]",
					`focus moved to ${where}`,
				);
				assert(value === "typing before the detail", "typed text lost");
			} finally {
				await page.unrouteAll();
			}
		},
	);

	await step(
		"focus: managed runs unavailable (503) → Retry → available lands on the open task's heading",
		async () => {
			await select(page, ok);
			await focusedDetail(page, ok);
			let unavailable = true;
			await page.route("**/api/managed/**", async (route) => {
				if (unavailable)
					return route.fulfill({
						status: 503,
						contentType: "application/json",
						body: JSON.stringify({
							error: "managed runs are not configured on this hub",
						}),
					});
				await route.continue();
			});
			try {
				// reload on #tasks/<id>: the token check meets the 503 (a tab switch would drop the id)
				await page.reload();
				const retry = page.getByRole("button", { name: "Retry" });
				try {
					await retry.waitFor({ timeout: 8_000 });
				} catch {
					throw new Error(
						`no "Retry" gate after the 503 (page shows: ${((await page.locator("main, body").first().textContent()) ?? "").replace(/\s+/g, " ").slice(0, 160)})`,
					);
				}
				unavailable = false;
				await retry.focus();
				await page.keyboard.press("Enter");
				try {
					await page
						.locator(`[data-testid=task-detail][data-task-id="${ok}"]`)
						.waitFor({ timeout: 8_000 });
				} catch {
					throw new Error(
						`the open task did not come back after Retry (url ${page.url().replace(base, "")}; focus ${await activeDesc(page)})`,
					);
				}
				await focusedDetail(page, ok);
			} finally {
				await page.unrouteAll();
			}
		},
	);

	await step(
		"focus: auth recovery — a deep link opened without a token lands on its heading once a token is accepted",
		async () => {
			// a new tab has no token (sessionStorage is per tab)
			const p2 = await context.newPage();
			p2.setDefaultTimeout(15_000);
			try {
				await p2.goto(`${base}/#tasks/${ok}`);
				await p2.getByTestId("token-input").waitFor();
				await p2.getByTestId("token-input").fill(TOKEN);
				await p2.getByTestId("token-input").press("Enter");
				await p2.getByTestId("new-title").waitFor();
				let detail = false;
				try {
					await p2
						.locator(`[data-testid=task-detail][data-task-id="${ok}"]`)
						.waitFor({ timeout: 5_000 });
					detail = true;
				} catch {
					// reported below
				}
				const where = await activeDesc(p2);
				const errorText = (await p2.getByTestId("auth-error").count())
					? await p2.getByTestId("auth-error").textContent()
					: "";
				assert(
					detail,
					`the deep-linked task was not restored after the token was accepted (url ${p2.url().replace(base, "")}; focus ${where}; gate error "${errorText ?? ""}")`,
				);
				await focusedDetail(p2, ok);
			} finally {
				await p2.close();
			}
		},
	);

	await step(
		"a 401 purges managed data, selection, form and viewer",
		async () => {
			await select(page, ok);
			await page
				.locator('[data-testid=artifact-link][data-name="manifest.json"]')
				.last()
				.click();
			await page.getByTestId("viewer").waitFor();
			await page.getByTestId("new-title").fill("unsent draft");
			await page.route("**/api/managed/tasks", (route) =>
				route.fulfill({
					status: 401,
					contentType: "application/json",
					body: '{"error":"unauthorized"}',
				}),
			);
			// trigger a list refresh (the tab remounts and re-checks the token)
			await page.getByRole("button", { name: "Observed sessions" }).click();
			await page.getByRole("button", { name: "Managed tasks" }).click();
			await page
				.getByTestId("auth-error")
				.filter({ hasText: "rejected" })
				.waitFor();
			assert(
				(await page.locator("[data-testid=task-row]").count()) === 0,
				"rows survived",
			);
			assert(
				!(await page.getByTestId("viewer").isVisible()),
				"viewer survived",
			);
			const stored = await page.evaluate(() =>
				sessionStorage.getItem("agentcity.managedToken"),
			);
			assert(stored === null, "token kept in sessionStorage");
			await page.unrouteAll();
		},
	);

	await step(
		"Forget purges everything, and in-flight answers stay dropped",
		async () => {
			await page.getByTestId("token-input").fill(TOKEN);
			await page.getByTestId("token-submit").click();
			await page.getByTestId("new-title").waitFor();
			assert(
				(await page.getByTestId("new-title").inputValue()) === "",
				"form survived the purge",
			);
			await select(page, ok);
			await page.route(`**/api/managed/tasks/${ok}`, async (route) => {
				await sleep(1_200);
				await route.continue();
			});
			await page
				.locator(`[data-testid=task-row][data-task-id="${ok}"]`)
				.click(); // in flight
			await page.getByTestId("forget-token").click();
			await sleep(1_600);
			assert(await page.getByTestId("token-input").isVisible(), "not purged");
			assert(
				(await page.locator("[data-testid=task-detail]").count()) === 0,
				"late detail shown",
			);
			await page.unrouteAll();
			const html = await page.content();
			assert(!html.includes(TOKEN), "token in the DOM");
			assert(!page.url().includes(TOKEN), "token in the URL");
		},
	);

	await step("no unexpected console errors", async () => {
		assert(
			consoleErrors.length === 0,
			`console errors: ${consoleErrors.slice(0, 3).join(" | ")}`,
		);
	});

	await context.close();
	return results.some((r) => !r.ok) ? 1 : 0;
}

let code = 1;
try {
	code = await main();
} catch (err) {
	results.push({
		name: "gate setup",
		ok: false,
		detail: (err as Error).message,
		ms: 0,
	});
} finally {
	await handles.browser?.close().catch(() => {});
	await handles.vite?.close().catch(() => {});
	await handles.hub?.stop().catch(() => {});
	if (fx) fx.cleanup();
}
for (const r of results)
	console.log(
		`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  — ${r.detail}`}  (${r.ms} ms)`,
	);
const failed = results.filter((r) => !r.ok).length;
console.log(
	`\n${results.length - failed}/${results.length} browser checks passed`,
);
console.log(`screenshots (synthetic data only): ${evidenceDir}`);
for (const s of shots) console.log(`  ${s}`);
if (!existsSync(evidenceDir)) console.log("(evidence directory missing)");
process.exit(failed > 0 ? 1 : code);
