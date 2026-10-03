// Shared helpers of the real isolated test-hub runs (role 07, dev tool): environment start via the
// lead harness (dynamic import keeps the Bun-only harness out of apps/web's typecheck), steps,
// screenshots with secret / overflow / copy checks, request logging, and UI navigation helpers.
// Secrets (credentials, cookie, CSRF, challenge) are never printed: only attributes, counts and
// equality booleans leave the process.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, chromium, Locator, Page } from "playwright-core";

export interface WorkspaceEnv {
	fx: { config: { artifacts_root: string } };
	repoId: string;
	uiUrl: string;
	hubUrl: string;
	credential: string;
	readOnlyCredential: string | null;
	restartHub(): Promise<void>;
	stop(): Promise<void>;
}
// dynamic import: keeps the Bun-only harness out of apps/web's typecheck
const harnessUrl = new URL("../../../e2e/workspace-harness.ts", import.meta.url)
	.href;
export interface EnvOptions {
	readOnly?: boolean;
	auth?: { challenge_ttl_ms?: number; session_ttl_ms?: number };
	fixture?: { limits?: Record<string, unknown> };
}
export const { startWorkspaceEnv } = (await import(harnessUrl)) as {
	startWorkspaceEnv(o?: EnvOptions): Promise<WorkspaceEnv>;
};

export const BANNED =
	/\b(merg(e|ed|es|ing)|push(ed|es|ing)?|deploy(ed|s|ing|ment)?)\b/i;
export const outDir = mkdtempSync(join(tmpdir(), "agentcity-m1-hub-shots-"));
export interface Step {
	name: string;
	ok: boolean;
	detail: string;
}
export const steps: Step[] = [];
export const shots: string[] = [];
export const notes: string[] = [];
export const blocked: string[] = [];
export const consoleErrors: string[] = [];
export const apiLog = new Map<string, number>();
export const decisionBodies: string[] = [];
export const state: { currentPage: Page | null; secrets: string[] } = {
	currentPage: null,
	secrets: [],
};

export const template = (path: string) =>
	path
		.replace(/wst-[0-9a-f-]{36}/g, ":task")
		.replace(/wsa-[0-9a-f-]{36}/g, ":request")
		.replace(/art-[0-9a-f-]{36}/g, ":artifact");

export async function step(
	name: string,
	fn: () => Promise<void>,
): Promise<void> {
	try {
		await fn();
		steps.push({ name, ok: true, detail: "" });
	} catch (err) {
		if (state.currentPage) {
			const file = join(outDir, `HUB-FAILED-${steps.length}.png`);
			await state.currentPage.screenshot({ path: file }).catch(() => undefined);
			shots.push(file);
		}
		steps.push({
			name,
			ok: false,
			detail: (err as Error).message.split("\n")[0]?.slice(0, 300) ?? "",
		});
	}
}
export function assert(cond: unknown, message: string): asserts cond {
	if (!cond) throw new Error(message);
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(
	fn: () => Promise<boolean>,
	what: string,
	ms = 10_000,
) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn().catch(() => false)) return;
		await sleep(150);
	}
	throw new Error(`timed out waiting for ${what}`);
}
export const textOf = async (l: Locator) => (await l.textContent()) ?? "";
export const region = (page: Page, name: string) =>
	page.getByRole("region", { name });
export const nav = (page: Page, name: string) =>
	page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name });

export async function shot(
	page: Page,
	name: string,
	size: string,
): Promise<void> {
	const checks = await page.evaluate(
		([banned, secretList]) => {
			const de = document.documentElement;
			const main = document.querySelector("main");
			const foot = document.querySelector(".wsm1-panel-foot");
			const fr = foot?.getBoundingClientRect();
			const html = de.outerHTML;
			let storage = 0;
			try {
				storage = localStorage.length + sessionStorage.length;
			} catch {
				storage = -1;
			}
			return {
				overflowX: de.scrollWidth > de.clientWidth,
				footInView: fr
					? fr.bottom <= window.innerHeight + 0.5 && fr.top >= 0
					: true,
				banned: new RegExp(banned as string, "i").test(
					(main as HTMLElement | null)?.innerText ?? "",
				),
				leaked: (secretList as string[]).some(
					(s) =>
						s.length > 0 && (html.includes(s) || location.href.includes(s)),
				),
				storage,
			};
		},
		[BANNED.source, state.secrets] as const,
	);
	const file = join(outDir, `HUB-${size}-${name}.png`);
	await page.screenshot({ path: file });
	shots.push(file);
	assert(!checks.overflowX, `${name}: horizontal page overflow`);
	assert(checks.footInView, `${name}: action footer outside the viewport`);
	assert(!checks.banned, `${name}: merge/push/deploy wording`);
	assert(!checks.leaked, `${name}: a secret value is in the DOM or URL`);
	assert(checks.storage === 0, `${name}: browser storage is not empty`);
}

export async function newPage(
	browser: Awaited<ReturnType<typeof chromium.launch>>,
	env: WorkspaceEnv,
	w: number,
	h: number,
): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({
		viewport: { width: w, height: h },
		deviceScaleFactor: 1,
		reducedMotion: "reduce",
		serviceWorkers: "block",
		acceptDownloads: false,
	});
	const origin = new URL(env.uiUrl).origin;
	await context.route("**/*", (route) => {
		const u = new URL(route.request().url());
		if (u.origin !== origin) {
			blocked.push(u.origin);
			return route.abort();
		}
		return route.continue();
	});
	const page = await context.newPage();
	page.setDefaultTimeout(10_000);
	page.on("console", (m) => {
		if (m.type() !== "error") return;
		const t = m.text();
		// provoked on purpose: wrong credential (401), lost responses, restart (401/502)
		if (/Failed to load resource|ERR_CONNECTION|net::ERR_FAILED/.test(t))
			return;
		consoleErrors.push(t.slice(0, 200));
	});
	page.on("pageerror", (e) =>
		consoleErrors.push(`pageerror ${String(e).slice(0, 200)}`),
	);
	page.on("request", (r) => {
		const u = new URL(r.url());
		if (!u.pathname.startsWith("/api/")) return;
		if (r.method() === "POST" && /\/decisions$/.test(u.pathname))
			decisionBodies.push(r.postData() ?? "");
	});
	page.on("response", (r) => {
		const u = new URL(r.url());
		if (!u.pathname.startsWith("/api/")) return;
		const k = `${r.request().method()} ${template(u.pathname)} ${r.status()}`;
		apiLog.set(k, (apiLog.get(k) ?? 0) + 1);
	});
	state.currentPage = page;
	return { context, page };
}

export async function signIn(
	page: Page,
	credential: string,
	env: WorkspaceEnv,
) {
	await page.getByRole("heading", { name: "Operator sign-in" }).waitFor();
	await page.getByLabel("Operator credential").fill(credential);
	await page.getByRole("button", { name: "Sign in" }).click();
	await page.getByText("Signed in as operator:edward").waitFor();
	await waitFor(
		async () =>
			(await page.getByTestId("provenance").getAttribute("data-source")) ===
			"hub",
		"hub provenance",
	);
	void env;
}

export async function openRepo(page: Page, env: WorkspaceEnv) {
	await nav(page, "Projects").click();
	await region(page, "Repositories")
		.getByRole("button", { name: new RegExp(env.repoId.replace("/", "\\/")) })
		.click();
}

export async function openTask(page: Page, env: WorkspaceEnv, title: string) {
	await openRepo(page, env);
	await region(page, "Tasks")
		.getByRole("button", { name: new RegExp(title) })
		.first()
		.click();
	await waitFor(
		async () =>
			(await textOf(page.locator("#wsm1-panel-title"))).includes(title),
		`task ${title}`,
	);
}

export async function compose(
	page: Page,
	env: WorkspaceEnv,
	title: string,
	criteria: string,
	scenario = "approve",
) {
	await openRepo(page, env);
	await page.getByRole("button", { name: "Assign work" }).click();
	await page.getByLabel("Title", { exact: true }).fill(title);
	await page
		.getByLabel("Objective", { exact: true })
		.fill(`${title}: keep the change small.`);
	await page
		.getByRole("textbox", { name: "Acceptance criteria" })
		.fill(criteria);
	if (scenario !== "approve")
		await page.getByLabel("Simulation scenario").selectOption(scenario);
}

export async function submitNew(
	page: Page,
	env: WorkspaceEnv,
	title: string,
	scenario = "approve",
) {
	await compose(
		page,
		env,
		title,
		"Build passes, lint passes\nNo change outside src/",
		scenario,
	);
	await page.getByRole("button", { name: "Submit for run approval" }).click();
	await waitFor(
		async () =>
			(await textOf(page.getByTestId("current-stage"))) ===
			"Awaiting execution approval",
		`${title} awaiting approval`,
	);
}

export async function openRequest(page: Page, label: RegExp) {
	await nav(page, "Headquarters").click();
	await region(page, "Approval inbox")
		.getByRole("button", { name: label })
		.click();
	await waitFor(
		async () => (await region(page, "Approval document").count()) === 1,
		"document",
	);
}

export async function apiGet<T>(
	page: Page,
	path: string,
): Promise<{ status: number; body: T }> {
	return (await page.evaluate(async (p) => {
		const r = await fetch(`/api/workspace${p}`, { credentials: "same-origin" });
		return { status: r.status, body: await r.json().catch(() => null) };
	}, path)) as { status: number; body: T };
}

export const taskIdFromUrl = (page: Page) =>
	page.evaluate(
		() => location.hash.split("/").find((p) => p.startsWith("wst-")) ?? "",
	);

/** Write summary.json next to the screenshots, print it (no secrets) and exit. */
export function finish(label: string, version: string): never {
	const summary = {
		ok:
			steps.every((s) => s.ok) &&
			blocked.length === 0 &&
			consoleErrors.length === 0,
		label,
		browser: `chromium headless shell ${version}`,
		outDir,
		steps,
		notes,
		blocked,
		consoleErrors,
		api: Object.fromEntries([...apiLog.entries()].sort()),
		shots,
	};
	writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
	console.log(JSON.stringify(summary, null, 2));
	process.exit(summary.ok ? 0 : 1);
}
