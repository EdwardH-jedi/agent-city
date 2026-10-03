// Role 09 (independent browser QA) — shared kit for the M1 browser suites (FX and HUB).
// Independent of role 07's dev helpers: only the lead harness (`../workspace-harness.ts`) and the
// product under test are used. Secrets (credentials, session cookie, CSRF, challenge tokens, canary
// raw values) are kept in memory only: checks print booleans/counts, never values.
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Browser,
	BrowserContext,
	Locator,
	Page,
	Request,
} from "playwright-core";
import { SCAN_PATTERNS } from "../../../../packages/schema/src/secret-patterns.ts";

export type SetLabel = "FX" | "HUB";
export type Status = "PASS" | "FAIL" | "NOT RUN" | "BLOCKED";

export interface CaseResult {
	id: string;
	set: SetLabel;
	status: Status;
	detail: string;
	ms: number;
	viewport: string;
	flags: string;
	evidence: string[];
}

export const BANNED =
	/\b(merg(e|ed|es|ing)|push(ed|es|ing)?|deploy(ed|s|ing|ment)?)\b/i;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function check(cond: unknown, message: string): asserts cond {
	if (!cond) throw new Error(message);
}

export async function until(
	fn: () => Promise<boolean> | boolean,
	what: string,
	ms = 15_000,
	every = 150,
): Promise<void> {
	const end = Date.now() + ms;
	let last: unknown = null;
	while (Date.now() < end) {
		try {
			if (await fn()) return;
		} catch (err) {
			last = err;
		}
		await sleep(every);
	}
	throw new Error(
		`timed out (${ms} ms) waiting for ${what}${last ? ` — last error: ${String((last as Error).message ?? last).split("\n")[0]}` : ""}`,
	);
}

// ── run bookkeeping ─────────────────────────────────────────────────────────

export class Run {
	readonly results: CaseResult[] = [];
	readonly shots: string[] = [];
	readonly notes: string[] = [];
	readonly blockedOrigins: string[] = [];
	readonly consoleErrors: string[] = [];
	readonly dialogs: string[] = [];
	readonly apiLog = new Map<string, number>();
	readonly secrets = new Set<string>();
	readonly outDir: string;
	viewport = "1440x900";
	flags = "";
	current: Page | null = null;
	private shotNo = 0;

	constructor(
		readonly set: SetLabel,
		readonly only: RegExp | null,
	) {
		this.outDir = mkdtempSync(
			join(tmpdir(), `agentcity-m1-09-${set.toLowerCase()}-`),
		);
	}

	wants(id: string): boolean {
		return this.only === null || this.only.test(id);
	}

	record(
		id: string,
		status: Status,
		detail = "",
		ms = 0,
		evidence: string[] = [],
	) {
		const r: CaseResult = {
			id,
			set: this.set,
			status,
			detail: scrub(detail, this.secrets).slice(0, 600),
			ms,
			viewport: this.viewport,
			flags: this.flags,
			evidence,
		};
		this.results.push(r);
		console.log(
			`[${this.set}] ${status.padEnd(7)} ${id}${r.detail ? ` — ${r.detail}` : ""} (${ms} ms)`,
		);
	}

	notRun(id: string, reason: string) {
		if (this.wants(id)) this.record(id, "NOT RUN", reason);
	}

	/** Run one case; an exception = FAIL (with a failure screenshot). */
	async case(id: string, fn: () => Promise<string | undefined>) {
		if (!this.wants(id)) return;
		const t0 = Date.now();
		const before = this.shots.length;
		try {
			const detail = (await fn()) ?? "";
			this.record(id, "PASS", detail, Date.now() - t0, this.shotsSince(before));
		} catch (err) {
			if (this.current && !this.current.isClosed()) {
				await this.shot(this.current, `FAILED-${id}`, { checks: false }).catch(
					() => undefined,
				);
				// recovery: a modal left open by a failed case must not cascade into the next one
				if (
					(await this.current
						.getByRole("dialog")
						.count()
						.catch(() => 0)) > 0
				)
					await this.current.keyboard.press("Escape").catch(() => undefined);
				await this.current
					.unrouteAll({ behavior: "ignoreErrors" })
					.catch(() => undefined);
			}
			const msg = String((err as Error)?.message ?? err)
				.split("\n")[0]
				?.slice(0, 500);
			if (msg?.startsWith("NOT-RUN:")) {
				this.record(id, "NOT RUN", msg.slice(8).trim(), Date.now() - t0);
				return;
			}
			this.record(
				id,
				"FAIL",
				msg ?? "error",
				Date.now() - t0,
				this.shotsSince(before),
			);
		}
	}

	private shotsSince(n: number): string[] {
		return this.shots.slice(n).map((p) => p.split("/").pop() ?? p);
	}

	/** Screenshot with the pre-screenshot hygiene scan (S-07): secrets/overflow are checked first. */
	async shot(
		page: Page,
		label: string,
		o: { checks?: boolean; fullPage?: boolean } = {},
	): Promise<void> {
		if (o.checks !== false) {
			const leaked = await leakedSecrets(page, this.secrets);
			check(leaked.length === 0, `secret visible before screenshot (${label})`);
		}
		this.shotNo += 1;
		const file = join(
			this.outDir,
			`${this.set}-${this.viewport}-${String(this.shotNo).padStart(2, "0")}-${label.replace(/[^A-Za-z0-9._-]+/g, "_")}.png`,
		);
		await page.screenshot({ path: file, fullPage: o.fullPage ?? false });
		this.shots.push(file);
	}

	writeSummary(extra: Record<string, unknown>): string {
		const file = join(this.outDir, "results.json");
		const summary = {
			set: this.set,
			...extra,
			results: this.results,
			notes: this.notes.map((n) => scrub(n, this.secrets)),
			blockedOrigins: this.blockedOrigins,
			consoleErrors: this.consoleErrors.map((n) => scrub(n, this.secrets)),
			dialogs: this.dialogs,
			api: Object.fromEntries([...this.apiLog.entries()].sort()),
			shots: this.shots.map((p) => p.split("/").pop()),
			outDir: this.outDir,
		};
		writeFileSync(file, JSON.stringify(summary, null, 2));
		return file;
	}
}

/** Remove any known secret value from a string before it is printed or stored. */
export function scrub(s: string, secrets: Set<string>): string {
	let out = s;
	for (const v of secrets)
		if (v.length >= 8) out = out.split(v).join("[SECRET]");
	return out;
}

export const template = (path: string) =>
	path
		.replace(/wst-[0-9a-f-]{36}/g, ":task")
		.replace(/wsa-[0-9a-f-]{36}/g, ":request")
		.replace(/wsd-[0-9a-f-]{36}/g, ":decision")
		.replace(/art-[0-9a-f-]{36}/g, ":artifact")
		.replace(/[0-9a-f-]{36}/g, ":id");

// ── browser context ─────────────────────────────────────────────────────────

export interface CtxOptions {
	width: number;
	height: number;
	reducedMotion?: "reduce" | "no-preference";
	/** FX: abort (and count) any /api/workspace request. */
	forbidWorkspaceApi?: boolean;
}

export interface Traffic {
	decisionPosts: { url: string; body: string; at: number }[];
	mutations: {
		method: string;
		path: string;
		csrf: boolean;
		originExact: boolean;
	}[];
	workspaceApiHits: number;
	wsFrames: string[];
}

export async function newCtx(
	run: Run,
	browser: Browser,
	origin: string,
	o: CtxOptions,
): Promise<{ context: BrowserContext; page: Page; traffic: Traffic }> {
	const context = await browser.newContext({
		viewport: { width: o.width, height: o.height },
		deviceScaleFactor: 1,
		reducedMotion: o.reducedMotion ?? "no-preference",
		serviceWorkers: "block",
		acceptDownloads: false,
	});
	const traffic: Traffic = {
		decisionPosts: [],
		mutations: [],
		workspaceApiHits: 0,
		wsFrames: [],
	};
	// G-1: only this run's UI origin; never :4317, never another host
	await context.route("**/*", (route) => {
		const u = new URL(route.request().url());
		if (u.origin !== origin || u.port === "4317") {
			run.blockedOrigins.push(u.origin);
			return route.abort();
		}
		if (o.forbidWorkspaceApi && u.pathname.startsWith("/api/workspace")) {
			traffic.workspaceApiHits += 1;
			return route.abort();
		}
		return route.continue();
	});
	const page = await context.newPage();
	attachPage(run, page, origin, traffic);
	return { context, page, traffic };
}

export function attachPage(
	run: Run,
	page: Page,
	origin: string,
	traffic: Traffic,
): void {
	page.setDefaultTimeout(12_000);
	page.on("console", (m) => {
		if (m.type() !== "error") return;
		const t = m.text();
		// provoked on purpose by the suite: 401 (wrong credential, restart, revoke), 409/422 (stale or
		// invalid decisions), 500/502/503 (injected faults, restart), aborted requests
		if (
			/Failed to load resource|ERR_CONNECTION|net::ERR_FAILED|ERR_ABORTED|ERR_EMPTY_RESPONSE/.test(
				t,
			)
		)
			return;
		run.consoleErrors.push(t.slice(0, 240));
	});
	page.on("pageerror", (e) =>
		run.consoleErrors.push(`pageerror ${String(e).slice(0, 240)}`),
	);
	page.on("dialog", (d) => {
		run.dialogs.push(`${d.type()}: ${d.message().slice(0, 80)}`);
		void d.dismiss().catch(() => undefined);
	});
	page.on("request", (r: Request) => {
		const u = new URL(r.url());
		if (!u.pathname.startsWith("/api/workspace")) return;
		if (r.method() === "POST" && /\/decisions$/.test(u.pathname))
			traffic.decisionPosts.push({
				url: u.pathname,
				body: r.postData() ?? "",
				at: Date.now(),
			});
		if (r.method() !== "GET") {
			void r
				.allHeaders()
				.then((h) => {
					traffic.mutations.push({
						method: r.method(),
						path: template(u.pathname),
						csrf: typeof h["x-agentcity-csrf"] === "string",
						originExact: h.origin === origin,
					});
				})
				.catch(() => undefined);
		}
	});
	page.on("response", (r) => {
		const u = new URL(r.url());
		if (!u.pathname.startsWith("/api/")) return;
		const k = `${r.request().method()} ${template(u.pathname)} ${r.status()}`;
		run.apiLog.set(k, (run.apiLog.get(k) ?? 0) + 1);
	});
	page.on("websocket", (ws) => {
		ws.on("framereceived", (f) => {
			const p = typeof f.payload === "string" ? f.payload : "";
			traffic.wsFrames.push(p.slice(0, 2000));
		});
	});
	run.current = page;
}

/** Every known secret value that appears in the DOM, URL, or browser storage (values never returned). */
export async function leakedSecrets(
	page: Page,
	secrets: Set<string>,
): Promise<string[]> {
	const list = [...secrets].filter((s) => s.length >= 8);
	const found = (await page.evaluate((vals: string[]) => {
		const html = document.documentElement.outerHTML;
		let store = "";
		try {
			for (let i = 0; i < localStorage.length; i++) {
				const k = localStorage.key(i) ?? "";
				store += `${k}=${localStorage.getItem(k)}\n`;
			}
			for (let i = 0; i < sessionStorage.length; i++) {
				const k = sessionStorage.key(i) ?? "";
				store += `${k}=${sessionStorage.getItem(k)}\n`;
			}
		} catch {
			store += "";
		}
		const where: string[] = [];
		vals.forEach((v, i) => {
			if (html.includes(v)) where.push(`#${i}:dom`);
			if (location.href.includes(v)) where.push(`#${i}:url`);
			if (store.includes(v)) where.push(`#${i}:storage`);
			if (document.cookie.includes(v)) where.push(`#${i}:document.cookie`);
		});
		return where;
	}, list)) as string[];
	return found;
}

/** Visible text matched against the shared secret patterns (names only). */
export async function secretPatternHits(page: Page): Promise<string[]> {
	const text = await page.evaluate(() => document.body.innerText);
	return SCAN_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}

export async function storageDump(
	page: Page,
): Promise<{ local: string[]; session: string[]; idb: string[] }> {
	return (await page.evaluate(async () => {
		const local: string[] = [];
		const session: string[] = [];
		for (let i = 0; i < localStorage.length; i++)
			local.push(localStorage.key(i) ?? "");
		for (let i = 0; i < sessionStorage.length; i++)
			session.push(sessionStorage.key(i) ?? "");
		let idb: string[] = [];
		try {
			const dbs = await indexedDB.databases();
			idb = dbs.map((d) => d.name ?? "");
		} catch {
			idb = ["(unavailable)"];
		}
		return { local, session, idb };
	})) as { local: string[]; session: string[]; idb: string[] };
}

export async function layout(page: Page): Promise<{
	overflowX: boolean;
	footInView: boolean;
	scrollWidth: number;
	clientWidth: number;
	leftW: number;
	panelW: number;
}> {
	return (await page.evaluate(() => {
		const de = document.documentElement;
		const foot = document.querySelector(".wsm1-panel-foot");
		const fr = foot?.getBoundingClientRect();
		const left = document.querySelector(".wsm1-left")?.getBoundingClientRect();
		const panel = document
			.querySelector(".wsm1-panel")
			?.getBoundingClientRect();
		return {
			overflowX: de.scrollWidth > de.clientWidth,
			footInView: fr
				? fr.bottom <= window.innerHeight + 0.5 && fr.top >= 0
				: true,
			scrollWidth: de.scrollWidth,
			clientWidth: de.clientWidth,
			leftW: Math.round(left?.width ?? 0),
			panelW: Math.round(panel?.width ?? 0),
		};
	})) as {
		overflowX: boolean;
		footInView: boolean;
		scrollWidth: number;
		clientWidth: number;
		leftW: number;
		panelW: number;
	};
}

export async function mainText(page: Page): Promise<string> {
	return (await page.evaluate(
		() =>
			(document.querySelector("main") as HTMLElement | null)?.innerText ?? "",
	)) as string;
}

/** J-17 audit over `main` (Activity view excluded by the caller). Returns the offending match. */
export async function bannedWords(page: Page): Promise<string | null> {
	const t = await mainText(page);
	const m = BANNED.exec(t);
	return m ? m[0] : null;
}

// ── UI helpers (role/name first, then the §7 data-testids) ──────────────────

export const region = (page: Page, name: string) =>
	page.getByRole("region", { name, exact: true });

export const navLink = (page: Page, name: RegExp) =>
	page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name });

export const textOf = async (l: Locator): Promise<string> =>
	((await l.first().textContent()) ?? "").trim();

export async function stageText(page: Page): Promise<string> {
	const l = page.getByTestId("current-stage");
	return (await l.count()) ? textOf(l) : "";
}

export async function waitStage(
	page: Page,
	label: string | RegExp,
	ms = 30_000,
): Promise<void> {
	await until(
		async () => {
			const t = await stageText(page);
			return typeof label === "string" ? t === label : label.test(t);
		},
		`stage ${String(label)}`,
		ms,
	);
}

export async function attr(
	page: Page,
	testId: string,
	name: string,
): Promise<string | null> {
	const l = page.getByTestId(testId);
	if ((await l.count()) === 0) return null;
	return l.first().getAttribute(name);
}

/** Dismiss every visible workspace alert (so the next expected alert is a fresh one). */
export async function dismissAlerts(page: Page): Promise<void> {
	for (let i = 0; i < 5; i++) {
		const b = page.getByRole("main").getByRole("button", { name: "Dismiss" });
		if ((await b.count()) === 0) return;
		await b
			.first()
			.click()
			.catch(() => undefined);
		await sleep(100);
	}
}

export async function signIn(page: Page, credential: string): Promise<void> {
	await page.getByRole("heading", { name: "Operator sign-in" }).waitFor();
	await page.getByLabel("Operator credential").fill(credential);
	await page.getByRole("button", { name: "Sign in" }).click();
	await page.getByText(/^Signed in as operator:edward/).waitFor();
}

export async function gotoProjects(page: Page): Promise<void> {
	await navLink(page, /^Projects$/).click();
	await region(page, "Repositories").waitFor();
}

export async function repoButton(
	page: Page,
	repoId?: string,
): Promise<Locator> {
	const r = region(page, "Repositories");
	await r.getByRole("button").first().waitFor();
	return repoId
		? r.getByRole("button", { name: new RegExp(escapeRe(repoId)) })
		: r.getByRole("button").first();
}

export const escapeRe = (s: string) =>
	s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export async function selectRepo(page: Page, repoId?: string): Promise<void> {
	await gotoProjects(page);
	await (await repoButton(page, repoId)).click();
	await region(page, "Tasks")
		.getByRole("button", { name: "Assign work" })
		.waitFor();
}

export interface DraftInput {
	title: string;
	objective?: string;
	criteria?: string;
	scenario?: string;
	repair?: 0 | 1;
	allowed?: string;
	/**
	 * v1.2 criterion → check mapping (CONTRACT_V1_2.md §A), authored through the editor's
	 * checkboxes: "all" (default) = every trusted check for every criterion; "none" = leave every
	 * criterion unmapped; an array = the check names per criterion line (missing/empty = none).
	 */
	mapping?: Mapping;
}

export type Mapping = "all" | "none" | readonly (readonly string[])[];

/** The editor's per-criterion check groups (`Checks for criterion N`). */
export const criterionGroups = (page: Page, scope = "Task detail") =>
	region(page, scope).getByRole("group", {
		name: /^Checks for criterion \d+$/,
	});

/**
 * Author the criterion → check mapping in the open editor by clicking its checkboxes (the real UI;
 * nothing is preselected). Unchecks what the mapping does not name, so the result is exact.
 */
export async function mapCriteria(
	page: Page,
	mapping: Mapping = "all",
	scope = "Task detail",
): Promise<void> {
	if (mapping === "none") return;
	const groups = criterionGroups(page, scope);
	await groups.first().waitFor();
	const n = await groups.count();
	for (let i = 0; i < n; i++) {
		const boxes = groups.nth(i).getByRole("checkbox");
		const m = await boxes.count();
		const want = mapping === "all" ? null : (mapping[i] ?? []);
		for (let k = 0; k < m; k++) {
			const box = boxes.nth(k);
			const name = (
				(await box.evaluate(
					(el) => (el as HTMLInputElement).labels?.[0]?.textContent ?? "",
				)) as string
			).trim();
			if (want === null || want.includes(name)) await box.check();
			else await box.uncheck();
		}
	}
}

export async function fillDraft(page: Page, d: DraftInput): Promise<void> {
	const panel = region(page, "Task detail");
	await panel.getByLabel("Title", { exact: true }).fill(d.title);
	await panel
		.getByLabel("Objective", { exact: true })
		.fill(d.objective ?? `${d.title}: keep the change small.`);
	await panel
		.getByRole("textbox", { name: "Acceptance criteria" })
		.fill(d.criteria ?? "Build passes, lint passes\nNo change outside src/");
	await mapCriteria(page, d.mapping ?? "all");
	if (d.allowed !== undefined)
		await panel.getByLabel("Allowed paths", { exact: true }).fill(d.allowed);
	if (d.scenario && d.scenario !== "approve")
		await panel.getByLabel("Simulation scenario").selectOption(d.scenario);
	if (d.repair === 1)
		await panel.getByRole("radio", { name: "Allow one repair" }).check();
}

export async function composeNew(
	page: Page,
	d: DraftInput,
	repoId?: string,
): Promise<void> {
	await selectRepo(page, repoId);
	await page.getByRole("button", { name: "Assign work" }).click();
	await region(page, "Task detail")
		.getByLabel("Title", { exact: true })
		.waitFor();
	await fillDraft(page, d);
}

/** Rows of the Gate-1 criteria plan (`[data-testid=criteria-plan]`): id + mapped checks. */
export async function planRows(page: Page, scope = "Task detail") {
	return (await region(page, scope)
		.getByTestId("criteria-plan")
		.first()
		.locator("tr[data-criterion-id]")
		.evaluateAll((rows) =>
			rows.map((r) => ({
				id: r.getAttribute("data-criterion-id") ?? "",
				checks: r.getAttribute("data-checks") ?? "",
			})),
		)) as { id: string; checks: string }[];
}

/** Rows of a rendered criterion coverage table: id + status (+ per-check outcome/log). */
export async function coverageRows(page: Page, scope = "Task detail") {
	return (await region(page, scope)
		.getByTestId("criterion-coverage")
		.first()
		.locator("tr[data-criterion-id]")
		.evaluateAll((rows) =>
			rows.map((r) => ({
				id: r.getAttribute("data-criterion-id") ?? "",
				status: r.getAttribute("data-status") ?? "",
				checks: [...r.querySelectorAll("li[data-check]")].map(
					(li) =>
						`${li.getAttribute("data-check")}:${li.getAttribute("data-outcome")}:${li.getAttribute("data-log")}`,
				),
			})),
		)) as { id: string; status: string; checks: string[] }[];
}

export async function taskIdFromUrl(page: Page): Promise<string> {
	return (await page.evaluate(
		() =>
			decodeURIComponent(location.hash)
				.split("/")
				.find((p) => p.startsWith("wst-")) ?? "",
	)) as string;
}

/** Compose + Submit for run approval (new task). Returns the workspace task id. */
export async function submitNew(
	page: Page,
	d: DraftInput,
	repoId?: string,
): Promise<string> {
	await composeNew(page, d, repoId);
	await region(page, "Task detail")
		.getByRole("button", { name: "Submit for run approval" })
		.click();
	await waitStage(page, "Awaiting execution approval", 15_000);
	const id = await taskIdFromUrl(page);
	check(id.startsWith("wst-"), "task id not in the URL after submit");
	return id;
}

export async function openTask(
	page: Page,
	taskId: string,
	repoId?: string,
): Promise<void> {
	await selectRepo(page, repoId);
	await region(page, "Tasks").locator(`[data-task-id="${taskId}"]`).click();
	await page
		.locator(`section[aria-label="Task detail"][data-task-id="${taskId}"]`)
		.waitFor();
}

export const GATE_NAME = {
	run: "Execution approval",
	result: "Result acceptance",
} as const;

export const SIG_LABEL = {
	run: "Type Edward to approve execution",
	result: "Type Edward to accept this result",
} as const;

export const GRANT = {
	run: "Approve execution",
	result: "Accept result",
} as const;

export type Gate = keyof typeof GATE_NAME;

/** Navigate to HQ and open the pending request of `kind` for the task titled `title`. */
export async function openRequest(
	page: Page,
	kind: Gate,
	title: string,
): Promise<string> {
	await navLink(page, /^Head/).click();
	const inbox = region(page, "Approval inbox");
	await inbox.waitFor();
	const name = `${GATE_NAME[kind]} · ${title}`;
	const btn = inbox.getByRole("button", {
		name: new RegExp(`^${escapeRe(name)}`),
	});
	await until(
		async () => (await btn.count()) > 0,
		`inbox item ${name}`,
		20_000,
	);
	await btn.first().click();
	const doc = page.locator(
		`section[aria-label="Approval document"][data-request-id]`,
	);
	await doc.waitFor();
	await until(
		async () =>
			(await doc.getAttribute("data-gate")) ===
			(kind === "run" ? "execution" : "result"),
		"document gate",
	);
	return (await doc.getAttribute("data-request-id")) ?? "";
}

export const sigField = (page: Page, kind: Gate) =>
	region(page, "Approval document").getByLabel(SIG_LABEL[kind], {
		exact: true,
	});

export const grantButton = (page: Page, kind: Gate) =>
	region(page, "Approval document").getByRole("button", {
		name: GRANT[kind],
		exact: true,
	});

/** Type the signature key by key (the first keystroke fetches the challenge) and wait until enabled. */
export async function typeSignature(
	page: Page,
	kind: Gate,
	text = "Edward",
): Promise<void> {
	const f = sigField(page, kind);
	await f.click();
	await f.pressSequentially(text, { delay: 15 });
	if (text === "Edward")
		await until(
			async () => grantButton(page, kind).isEnabled(),
			`${GRANT[kind]} enabled`,
			10_000,
		).catch(async (err) => {
			const why = await grantButton(page, kind)
				.evaluate((el) =>
					(el.getAttribute("aria-describedby") ?? "")
						.split(" ")
						.map((i) => document.getElementById(i)?.textContent ?? "")
						.join(" "),
				)
				.catch(() => "?");
			const val = await f.inputValue().catch(() => "?");
			throw new Error(
				`${(err as Error).message}; field="${val === "Edward" ? "Edward" : `(${val.length} chars)`}"; reasons: ${why.slice(0, 200)}`,
			);
		});
}

export async function decisionStatus(page: Page): Promise<string> {
	const l = region(page, "Approval document").getByRole("status", {
		name: "Decision status",
	});
	return (await l.count()) ? textOf(l) : "";
}

export async function approveRun(page: Page, title: string): Promise<string> {
	const req = await openRequest(page, "run", title);
	await typeSignature(page, "run");
	await grantButton(page, "run").click();
	await until(
		async () => /Execution approved/.test(await decisionStatus(page)),
		"execution approved",
	);
	return req;
}

/** Open the task panel and wait until the engine reaches one of `states` (data-state). */
export async function waitEngine(
	page: Page,
	states: string[],
	ms = 60_000,
): Promise<string> {
	let seen = "";
	await until(
		async () => {
			seen = (await attr(page, "engine-state", "data-state")) ?? "";
			return states.includes(seen);
		},
		`engine ${states.join("|")}`,
		ms,
		250,
	);
	return seen;
}

// ── read-only DB access (the run's temp SQLite only) ────────────────────────

export function dbAll<T = Record<string, unknown>>(
	dbPath: string,
	sql: string,
	...params: (string | number | null)[]
): T[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		db.exec("PRAGMA busy_timeout = 3000");
		return db.query(sql).all(...params) as T[];
	} finally {
		db.close();
	}
}

export function dbOne<T = Record<string, unknown>>(
	dbPath: string,
	sql: string,
	...params: (string | number | null)[]
): T | null {
	return dbAll<T>(dbPath, sql, ...params)[0] ?? null;
}

export const randomAlnum = (n: number) => {
	const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	const bytes = crypto.getRandomValues(new Uint8Array(n));
	return [...bytes].map((b) => abc[b % abc.length]).join("");
};
