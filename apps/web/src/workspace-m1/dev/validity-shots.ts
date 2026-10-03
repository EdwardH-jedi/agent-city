// UI-fixture screenshots of the current acceptance validity (role 07, dev tool; FX evidence only —
// never HUB evidence). Contract delta v1.2 §C: the four states next to the historical acceptance,
// the invalid alert, the accepted original in the viewer labelled as history, and the HQ document +
// decision history.
//
//   …/iso/run.sh env PLAYWRIGHT_BROWSERS_PATH=/Users/edwardhwang/Library/Caches/ms-playwright \
//     bun --no-env-file apps/web/src/workspace-m1/dev/validity-shots.ts
//
// Isolation as screenshots.ts: programmatic Vite (fixture-server.ts), cached headless Chromium,
// fresh context, a route guard that aborts anything outside the Vite origin and every /api call.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { DEV_PAGE, startFixtureServer } from "./fixture-server.ts";

const GLOBAL = "__AGENTCITY_WORKSPACE_FIXTURE_CONTROLS__";
const BANNED =
	/\b(merg(e|ed|es|ing)|push(ed|es|ing)?|deploy(ed|s|ing|ment)?)\b/i;
const outDir = mkdtempSync(join(tmpdir(), "agentcity-m1-validity-shots-"));
const results: { name: string; ok: boolean; detail: string }[] = [];
const shots: string[] = [];
const blocked: string[] = [];
const consoleErrors: string[] = [];

function assert(cond: unknown, message: string): asserts cond {
	if (!cond) throw new Error(message);
}

async function waitFor(fn: () => Promise<boolean>, what: string, ms = 10_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn().catch(() => false)) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`timed out waiting for ${what}`);
}

async function control<T>(page: Page, method: string, ...args: unknown[]) {
	return (await page.evaluate(
		async ([g, m, a]) =>
			// biome-ignore lint/suspicious/noExplicitAny: fixture control global (dev tool)
			await (globalThis as any)[g as string][m as string](...(a as unknown[])),
		[GLOBAL, method, args] as const,
	)) as T;
}

async function shot(page: Page, name: string) {
	const size = `${page.viewportSize()?.width}x${page.viewportSize()?.height}`;
	const c = await page.evaluate(
		([banned]) => ({
			overflowX:
				document.documentElement.scrollWidth >
				document.documentElement.clientWidth,
			banned: new RegExp(banned as string, "i").test(
				(document.querySelector("main") as HTMLElement | null)?.innerText ?? "",
			),
		}),
		[BANNED.source],
	);
	const file = join(outDir, `${size}-${name}.png`);
	await page.screenshot({ path: file });
	shots.push(file);
	assert(!c.overflowX, `${name}: horizontal page overflow`);
	assert(!c.banned, `${name}: merge/push/deploy wording in main`);
}

async function step(name: string, fn: () => Promise<string>) {
	try {
		results.push({ name, ok: true, detail: await fn() });
	} catch (err) {
		results.push({
			name,
			ok: false,
			detail: (err as Error).message.split("\n")[0]?.slice(0, 300) ?? "",
		});
	}
}

const validity = (page: Page) =>
	page
		.getByRole("region", { name: "Task detail", exact: true })
		.getByTestId("acceptance-validity");

async function openAccepted(page: Page, taskId: string) {
	await page.evaluate(
		(h) => {
			location.hash = h;
		},
		`#/projects/${encodeURIComponent("local/fixture")}/${taskId}`,
	);
	await page
		.locator(`section[aria-label="Task detail"][data-task-id="${taskId}"]`)
		.waitFor();
}

const { server, origin } = await startFixtureServer();
const browser = await chromium.launch({
	headless: true,
	args: ["--disable-webgl", "--disable-3d-apis"],
});
try {
	for (const [w, h] of [
		[1440, 900],
		[1280, 800],
	] as const) {
		const context = await browser.newContext({
			viewport: { width: w, height: h },
			reducedMotion: "reduce",
		});
		await context.route("**/*", (route) => {
			const u = new URL(route.request().url());
			if (u.origin !== origin || u.pathname.startsWith("/api/")) {
				blocked.push(u.href);
				return route.abort();
			}
			return route.continue();
		});
		const page = await context.newPage();
		page.on("console", (m) => {
			if (m.type() === "error") consoleErrors.push(m.text());
		});
		await page.goto(origin + DEV_PAGE);
		await page.getByRole("navigation", { name: "Primary" }).waitFor();
		for (const state of [
			"valid",
			"invalid",
			"unknown",
			"unverifiable",
		] as const) {
			await step(`${w}x${h} ${state}`, async () => {
				// a fresh page = a fresh in-memory fixture world (seedDemo seeds once per world)
				await page.goto(origin + DEV_PAGE);
				await page.getByRole("navigation", { name: "Primary" }).waitFor();
				const ids = await control<Record<string, string>>(page, "seedDemo");
				const id = ids.accepted as string;
				if (state === "invalid")
					assert(
						await control<boolean>(page, "corruptEvidence", id, "diff.patch"),
						"corrupt",
					);
				if (state === "unknown" || state === "unverifiable")
					assert(
						await control<boolean>(page, "setAcceptanceValidity", id, state),
						"control refused",
					);
				await openAccepted(page, id);
				await waitFor(
					async () =>
						(await validity(page).getAttribute("data-status")) === state,
					`acceptance-validity=${state}`,
				);
				const acc = await page
					.getByTestId("acceptance-status")
					.getAttribute("data-status");
				assert(acc === "accepted", `acceptance-status=${acc}`);
				const role = await validity(page).getAttribute("role");
				assert(
					(role === "alert") === (state === "invalid"),
					`role=${role} for ${state}`,
				);
				const text = ((await validity(page).textContent()) ?? "").trim();
				await shot(page, `validity-${state}`);
				if (state === "invalid") {
					const ev = page
						.getByRole("region", { name: "Task detail", exact: true })
						.getByRole("region", { name: "Evidence" });
					await ev
						.getByRole("button", { name: "diff.patch", exact: true })
						.click();
					const d = page.getByRole("dialog", { name: "Evidence: diff.patch" });
					await d.waitFor();
					await waitFor(
						async () => (await d.getAttribute("data-state")) === "ok",
						"viewer ok",
					);
					assert(
						(await d.getAttribute("data-history")) === "accepted-original",
						"viewer not labelled as history",
					);
					assert(
						((await d.locator("pre").textContent()) ?? "").length > 0,
						"no original text",
					);
					await shot(page, "validity-invalid-viewer");
					await d.getByRole("button", { name: "Close evidence" }).click();
					const reqId = await page
						.locator('.wsm1-record li:has-text("Result acceptance")')
						.first()
						.getAttribute("data-request-id");
					await page.evaluate((hash) => {
						location.hash = hash;
					}, `#/hq/${id}/${reqId}`);
					const doc = page.getByRole("region", { name: "Approval document" });
					await waitFor(
						async () =>
							(await doc
								.getByTestId("acceptance-validity")
								.getAttribute("data-status")) === "invalid",
						"HQ validity",
					);
					const hist = await page
						.getByTestId("history-acceptance-validity")
						.getAttribute("data-status");
					assert(hist === "invalid", `history ${hist}`);
					await shot(page, "validity-invalid-hq");
				}
				return `${state}: role=${role ?? "none"}; "${text.slice(0, 110)}"`;
			});
		}
		await context.close();
	}
} finally {
	await browser.close();
	await server.close();
}
writeFileSync(
	join(outDir, "summary.json"),
	JSON.stringify({ results, shots, blocked, consoleErrors }, null, 2),
);
for (const r of results)
	console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name} — ${r.detail}`);
console.log(
	`shots: ${shots.length} in ${outDir}; blocked: ${blocked.length}; console errors: ${consoleErrors.length}`,
);
process.exit(results.every((r) => r.ok) && consoleErrors.length === 0 ? 0 : 1);
