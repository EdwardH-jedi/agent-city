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
				// 401: token tests · 409: tampered-evidence test · 502: hub-restart window
				/(status of (401|409|502)\b|ERR_CONNECTION_RESET|ERR_FAILED)/.test(
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
			assert(page.url().endsWith("#tasks"), "tab not restored");
			await page.getByRole("button", { name: "Observed sessions" }).click();
			await page.getByRole("heading", { name: /Live sessions/ }).waitFor();
			await page.getByRole("button", { name: "Managed tasks" }).click();
			await page.getByTestId("new-title").waitFor();
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
