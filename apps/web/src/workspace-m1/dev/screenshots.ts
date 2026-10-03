// UI-fixture screenshot + smoke run (role 07, dev tool; FX evidence only — never HUB evidence).
//
//   …/iso/run.sh env PLAYWRIGHT_BROWSERS_PATH=/Users/edwardhwang/Library/Caches/ms-playwright \
//     bun --no-env-file apps/web/src/workspace-m1/dev/screenshots.ts
//
// Isolation: programmatic Vite (fixture-server.ts: no config file, empty envDir, loopback, port ≠
// 4317, no proxy, no hub), cached headless Chromium with a fresh context, WebGL disabled and
// proven null in-page, a context-level route guard that aborts (and records) anything not served
// by this Vite origin and every /api request. Drives J-01 through the real UI (Assign work →
// Save → Submit → HQ → Edward → Approve → engine steps via the fixture control → evidence →
// Accept), then seeded states, at 1440×900 and 1280×800. At every screenshot: no horizontal page
// overflow, the panel action footer inside the viewport, and the copy audit over <main>.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BrowserContext,
	chromium,
	type Locator,
	type Page,
} from "playwright-core";
import { DEV_PAGE, startFixtureServer } from "./fixture-server.ts";

const GLOBAL = "__AGENTCITY_WORKSPACE_FIXTURE_CONTROLS__";
const BANNED =
	/\b(merg(e|ed|es|ing)|push(ed|es|ing)?|deploy(ed|s|ing|ment)?)\b/i;
const outDir = mkdtempSync(join(tmpdir(), "agentcity-m1-fx-shots-"));
mkdirSync(outDir, { recursive: true });

interface Step {
	name: string;
	ok: boolean;
	detail: string;
}
const steps: Step[] = [];
const shots: string[] = [];
const blocked: string[] = [];
const apiCalls: string[] = [];
const consoleErrors: string[] = [];

let currentPage: Page | null = null;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
		steps.push({ name, ok: true, detail: "" });
	} catch (err) {
		if (currentPage) {
			const file = join(outDir, `FAILED-${steps.length}.png`);
			await currentPage.screenshot({ path: file }).catch(() => undefined);
			shots.push(file);
		}
		steps.push({
			name,
			ok: false,
			detail: (err as Error).message.split("\n")[0]?.slice(0, 300) ?? "",
		});
	}
}

function assert(cond: unknown, message: string): asserts cond {
	if (!cond) throw new Error(message);
}

async function waitFor(fn: () => Promise<boolean>, what: string, ms = 8000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn().catch(() => false)) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`timed out waiting for ${what}`);
}

const textOf = async (l: Locator) => (await l.textContent()) ?? "";

async function shot(page: Page, name: string, size: string): Promise<void> {
	const checks = await page.evaluate(
		([banned]) => {
			const de = document.documentElement;
			const main = document.querySelector("main");
			const foot = document.querySelector(".wsm1-panel-foot");
			const fr = foot?.getBoundingClientRect();
			return {
				overflowX: de.scrollWidth > de.clientWidth,
				footInView: fr
					? fr.bottom <= window.innerHeight + 0.5 && fr.top >= 0
					: true,
				banned: new RegExp(banned as string, "i").test(
					(main as HTMLElement | null)?.innerText ?? "",
				),
			};
		},
		[BANNED.source],
	);
	const file = join(outDir, `${size}-${name}.png`);
	await page.screenshot({ path: file });
	shots.push(file);
	assert(!checks.overflowX, `${name}: horizontal page overflow`);
	assert(
		checks.footInView,
		`${name}: panel action footer outside the viewport`,
	);
	assert(!checks.banned, `${name}: merge/push/deploy wording in main`);
}

async function guard(context: BrowserContext, origin: string): Promise<void> {
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
		return route.continue();
	});
}

const region = (page: Page, name: string) => page.getByRole("region", { name });

async function control<T>(
	page: Page,
	method: string,
	...args: unknown[]
): Promise<T> {
	return (await page.evaluate(
		async ([g, m, a]) =>
			// biome-ignore lint/suspicious/noExplicitAny: fixture control global (dev tool)
			await (globalThis as any)[g as string][m as string](...(a as unknown[])),
		[GLOBAL, method, args] as const,
	)) as T;
}

async function openTask(page: Page, title: string) {
	await page
		.getByRole("navigation", { name: "Primary" })
		.getByRole("link", { name: "Projects" })
		.click();
	await region(page, "Repositories")
		.getByRole("button", { name: /local\/fixture/ })
		.click();
	await region(page, "Tasks")
		.getByRole("button", { name: new RegExp(title) })
		.click();
	await waitFor(
		async () =>
			(await textOf(page.locator("#wsm1-panel-title"))).includes(title),
		`task ${title}`,
	);
}

async function journey(page: Page, size: string): Promise<void> {
	await step(`${size}: J-01 draft → save → submit`, async () => {
		await region(page, "Repositories")
			.getByRole("button", { name: /local\/fixture/ })
			.click();
		await page.getByRole("button", { name: "Assign work" }).click();
		await page
			.getByLabel("Title", { exact: true })
			.fill("Add retry to webhook sender");
		await page
			.getByLabel("Objective", { exact: true })
			.fill("Retry failed webhook deliveries with bounded backoff.");
		await page
			.getByRole("textbox", { name: "Acceptance criteria" })
			.fill(
				"Build passes, lint passes\nDocs updated, with one example\nNo change outside src/, tests/",
			);
		assert(
			await page
				.getByRole("radio", { name: "No automatic repair" })
				.isChecked(),
			"repair default",
		);
		await page.getByRole("button", { name: "Save draft" }).click();
		await waitFor(
			async () =>
				(
					await textOf(page.getByRole("status", { name: "Save status" }))
				).includes("Draft saved"),
			"Draft saved",
		);
		const items = page
			.getByRole("list", { name: "Acceptance criteria" })
			.getByRole("listitem");
		await waitFor(async () => (await items.count()) === 3, "3 criteria");
		assert(
			(await items.nth(0).textContent()) === "Build passes, lint passes",
			"criterion 1 verbatim",
		);
		await shot(page, "01-draft-saved", size);
		await page.getByRole("button", { name: "Submit for run approval" }).click();
		await waitFor(
			async () =>
				(await textOf(page.getByTestId("current-stage"))) ===
				"Awaiting execution approval",
			"stage Awaiting execution approval",
		);
		assert(
			(await page.getByTestId("execution-id").count()) === 0,
			"no execution before Gate 1",
		);
		assert(
			(await textOf(page.getByTestId("hq-pending-count"))) === "1",
			"pending count 1",
		);
		await shot(page, "02-submitted", size);
	});

	await step(
		`${size}: J-01 Gate 1 (Enter inert, exact Edward, approve)`,
		async () => {
			await page
				.getByRole("navigation", { name: "Primary" })
				.getByRole("link", { name: "Headquarters" })
				.click();
			await region(page, "Approval inbox")
				.getByRole("button", { name: /Execution approval · Add retry/ })
				.click();
			const doc = region(page, "Approval document");
			await waitFor(
				async () => (await doc.getAttribute("data-gate")) === "execution",
				"gate execution",
			);
			const sig = page.getByLabel("Type Edward to approve execution");
			const approve = page.getByRole("button", { name: "Approve execution" });
			assert((await sig.inputValue()) === "", "signature empty on arrival");
			assert(await approve.isDisabled(), "approve disabled on arrival");
			await shot(page, "03-hq-gate1", size);
			await sig.pressSequentially("edward");
			await new Promise((r) => setTimeout(r, 300));
			assert(await approve.isDisabled(), "lower-case edward does not enable");
			await sig.fill("");
			await sig.pressSequentially("Edward");
			await waitFor(
				async () => !(await approve.isDisabled()),
				"approve enabled",
			);
			await sig.press("Enter");
			await sig.press("Control+Enter");
			await new Promise((r) => setTimeout(r, 400));
			assert(
				(await doc.getAttribute("data-request-status")) === "pending",
				"Enter is inert",
			);
			await shot(page, "04-hq-gate1-signed", size);
			await approve.click();
			await waitFor(
				async () =>
					(
						await textOf(page.getByRole("status", { name: "Decision status" }))
					).includes("Execution approved"),
				"Execution approved",
			);
			await waitFor(
				async () =>
					(await doc.getAttribute("data-request-status")) === "approved",
				"approved",
			);
			const focused = await page.evaluate(
				() => document.activeElement?.id ?? "",
			);
			assert(
				focused === "wsm1-decision-status",
				`focus after decision: ${focused}`,
			);
			assert(
				(await page.locator("li[data-decision-id]").count()) === 1,
				"history entry",
			);
			await shot(page, "05-hq-gate1-approved", size);
		},
	);

	await step(`${size}: J-01 monitor → evidence viewer`, async () => {
		const taskId = await page.evaluate(() => location.hash.split("/")[2] ?? "");
		assert(taskId.startsWith("wst-"), "task id in URL");
		await control(page, "runToEnd", taskId);
		await openTask(page, "Add retry to webhook sender");
		await waitFor(
			async () =>
				(await textOf(page.getByTestId("current-stage"))) ===
				"Awaiting acceptance",
			"Awaiting acceptance",
			6000,
		);
		assert(
			(await page.getByTestId("engine-state").getAttribute("data-state")) ===
				"human_ready",
			"engine human_ready",
		);
		assert(
			(await page
				.getByTestId("acceptance-status")
				.getAttribute("data-status")) === "pending",
			"acceptance pending",
		);
		assert(
			(await page
				.getByTestId("evidence-status")
				.getAttribute("data-status")) === "verified",
			"evidence verified",
		);
		await shot(page, "06-task-awaiting-acceptance", size);
		const opener = region(page, "Evidence").getByRole("button", {
			name: "diff.patch",
		});
		const openerId = await opener.getAttribute("id");
		await opener.click();
		const dialog = page.getByRole("dialog", { name: "Evidence: diff.patch" });
		await waitFor(
			async () => (await dialog.getAttribute("data-state")) === "ok",
			"viewer ok",
		);
		assert(
			(await textOf(dialog.locator("pre"))).includes("diff --git"),
			"diff text",
		);
		await shot(page, "07-evidence-viewer", size);
		await page.keyboard.press("Escape");
		await waitFor(async () => (await dialog.count()) === 0, "viewer closed");
		const back = await page.evaluate(() => document.activeElement?.id ?? "");
		assert(back === openerId, `focus returned to opener (${back})`);
	});

	await step(
		`${size}: J-01 Gate 2 accept (separate, empty field)`,
		async () => {
			await page
				.getByRole("button", { name: "Open result acceptance" })
				.click();
			const doc = region(page, "Approval document");
			await waitFor(
				async () => (await doc.getAttribute("data-gate")) === "result",
				"gate result",
			);
			const sig = page.getByLabel("Type Edward to accept this result");
			assert((await sig.inputValue()) === "", "Gate-2 field empty");
			assert(
				await page.getByRole("button", { name: "Accept result" }).isDisabled(),
				"accept disabled",
			);
			await shot(page, "08-hq-gate2", size);
			await sig.pressSequentially("Edward");
			const accept = page.getByRole("button", { name: "Accept result" });
			await waitFor(async () => !(await accept.isDisabled()), "accept enabled");
			await accept.click();
			await waitFor(
				async () =>
					(await page
						.getByTestId("acceptance-status")
						.getAttribute("data-status")) === "accepted",
				"accepted",
			);
			assert(
				(await page.getByTestId("engine-state").getAttribute("data-state")) ===
					"human_ready",
				"engine unchanged",
			);
			await shot(page, "09-hq-gate2-accepted", size);
		},
	);
}

async function seeded(page: Page, size: string): Promise<void> {
	await step(`${size}: seeded states`, async () => {
		await control(page, "seedDemo");
		await page
			.getByRole("navigation", { name: "Primary" })
			.getByRole("link", { name: "Headquarters" })
			.click();
		await waitFor(
			async () =>
				Number(await textOf(page.getByTestId("hq-pending-count"))) >= 2,
			"seeded pending",
			6000,
		);
		await region(page, "Approval inbox")
			.getByRole("button", { name: /Execution approval · Tighten config/ })
			.click();
		await waitFor(
			async () => (await region(page, "Approval document").count()) === 1,
			"doc",
		);
		await shot(page, "10-hq-inbox-gate1-seeded", size);
		await openTask(page, "Speed up test fixtures");
		await waitFor(
			async () =>
				(await textOf(page.getByTestId("current-stage"))) === "Failed",
			"failed",
		);
		await shot(page, "11-task-failed", size);
		await openTask(page, "Stop the long import job");
		await waitFor(
			async () =>
				(await page
					.getByTestId("cancellation-status")
					.getAttribute("data-status")) === "requested",
			"cancel requested",
		);
		await shot(page, "12-task-cancel-requested", size);
		await openTask(page, "Rename legacy flags");
		await waitFor(
			async () =>
				(await textOf(page.getByTestId("current-stage"))) === "Rejected",
			"rejected",
		);
		await shot(page, "13-task-rejected-closed", size);
		await openTask(page, "Refactor logging setup");
		await shot(page, "14-task-running", size);
		await openTask(page, "UnbrokenIdentifier");
		await shot(page, "15-task-long-content", size);
		await page.getByRole("button", { name: "Open execution approval" }).click();
		await waitFor(
			async () => (await region(page, "Approval document").count()) === 1,
			"long doc",
		);
		await shot(page, "16-hq-long-content", size);
	});
}

const { server, origin } = await startFixtureServer();
const browser = await chromium.launch({
	headless: true,
	args: ["--disable-3d-apis", "--disable-webgl", "--disable-webgl2"],
});
let version = "";
try {
	version = browser.version();
	for (const [w, h] of [
		[1440, 900],
		[1280, 800],
	] as const) {
		const size = `${w}x${h}`;
		const context = await browser.newContext({
			viewport: { width: w, height: h },
			deviceScaleFactor: 1,
			reducedMotion: "reduce",
			serviceWorkers: "block",
			acceptDownloads: false,
		});
		await guard(context, origin);
		const page = await context.newPage();
		currentPage = page;
		page.setDefaultTimeout(8000);
		page.on("console", (m) => {
			if (m.type() === "error") consoleErrors.push(`${size}: ${m.text()}`);
		});
		page.on("pageerror", (e) =>
			consoleErrors.push(`${size}: pageerror ${String(e)}`),
		);
		await step(
			`${size}: fixture page boots with fixture provenance, no WebGL`,
			async () => {
				await page.goto(`${origin}${DEV_PAGE}#/projects`);
				await page
					.locator('[data-testid="provenance"][data-source="fixture"]')
					.waitFor();
				const gl = await page.evaluate(() => {
					const c = document.createElement("canvas");
					return [
						c.getContext("webgl") === null,
						c.getContext("webgl2") === null,
					];
				});
				assert(gl[0] && gl[1], "WebGL is available (should be disabled)");
				const first = await page.evaluate(() => {
					const el = document.querySelector(
						"a, button, input, select, textarea, [tabindex]",
					);
					return el?.textContent ?? "";
				});
				assert(first === "Skip to task panel", `first focusable: ${first}`);
				const anims = await page.evaluate(
					() => document.getAnimations().length,
				);
				assert(anims === 0, `running animations: ${anims}`);
			},
		);
		await journey(page, size);
		await seeded(page, size);
		await context.close();
	}
} finally {
	await browser.close();
	await server.close();
}

const summary = {
	ok:
		steps.every((s) => s.ok) &&
		blocked.length === 0 &&
		apiCalls.length === 0 &&
		consoleErrors.length === 0,
	browser: `chromium headless shell ${version}`,
	origin,
	outDir,
	steps,
	blocked,
	apiCalls,
	consoleErrors,
	shots,
};
writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
