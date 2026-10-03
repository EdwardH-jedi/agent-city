// QA (multi-repository milestone) — helpers for `multirepo.suite.ts` only. Built on the role-09 kit
// (`./kit.ts`, owned by Worker A — not edited here) and the lead harness. Locators use the FROZEN DOM
// hooks of docs/workspace-m1/MULTIREPO_MILESTONE.md ("Frozen DOM hooks") plus the role-09 DOM contract
// (region names, gate labels). Nothing here reads an environment variable (the suite passes values in)
// and nothing prints a secret value: helpers return booleans, counts, ids and visible copy only.
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import type { Locator, Page, Request } from "playwright-core";
import type { OrchestratorHooks } from "../../../hub/src/managed/orchestrator.ts";
import {
	check,
	escapeRe,
	GATE_NAME,
	type Gate,
	navLink,
	region,
	type SetLabel,
	sleep,
	textOf,
	until,
} from "./kit.ts";

/**
 * Evidence set label: `new Run(MULTI_SET, …)` writes to `agentcity-m1-09-multi-*` (what
 * scripts/ci/collect-browser-evidence.ts collects).
 */
export const MULTI_SET: SetLabel = "MULTI";

// ── engine boundary (test-only orchestrator hook, via startWorkspaceEnv({ managedHooks })) ──────────

type HookPoint = Parameters<NonNullable<OrchestratorHooks["at"]>>[0];

/**
 * Holds managed tasks at an orchestrator hook point while armed (the claim's heartbeat keeps the lease),
 * records arrival order, and is released before any hub stop / restart (a held claim blocks the stop).
 */
export class EngineGate implements OrchestratorHooks {
	readonly arrivals: { point: HookPoint; taskId: string }[] = [];
	private readonly armed = new Set<HookPoint>();
	private readonly waiting = new Map<string, () => void>();
	arm(point: HookPoint): void {
		this.armed.add(point);
	}
	at(point: HookPoint, taskId: string): Promise<void> | void {
		this.arrivals.push({ point, taskId });
		if (!this.armed.has(point)) return;
		return new Promise<void>((resolve) => {
			this.waiting.set(`${point}:${taskId}`, resolve);
		});
	}
	holding(point: HookPoint, taskId: string): boolean {
		return this.waiting.has(`${point}:${taskId}`);
	}
	releaseAll(): void {
		this.armed.clear();
		for (const r of this.waiting.values()) r();
		this.waiting.clear();
	}
}

// ── read-only DB sampling (the run's temp SQLite only) ─────────────────────────────────────────────

/** Samples the number of leased managed tasks every `everyMs` on one read-only connection. */
export class LeaseSampler {
	max = 0;
	samples = 0;
	private on = false;
	private loop: Promise<void> | null = null;
	constructor(
		private readonly dbPath: string,
		private readonly everyMs = 20,
	) {}
	start(): void {
		if (this.on) return;
		this.on = true;
		const db = new Database(this.dbPath, { readonly: true });
		db.exec("PRAGMA busy_timeout = 2000");
		const q = db.query(
			"SELECT count(*) AS n FROM managed_tasks WHERE lease_owner IS NOT NULL",
		);
		this.loop = (async () => {
			try {
				while (this.on) {
					try {
						const n = (q.get() as { n: number } | null)?.n ?? 0;
						this.max = Math.max(this.max, n);
						this.samples += 1;
					} catch {
						// busy: skip this sample
					}
					await sleep(this.everyMs);
				}
			} finally {
				db.close();
			}
		})();
	}
	async stop(): Promise<void> {
		this.on = false;
		await this.loop;
	}
}

/** True when `sha` is a commit in the git repository at `repoPath` (read-only `cat-file -e`). */
export function gitHasCommit(
	gitExe: string,
	repoPath: string,
	sha: string,
): boolean {
	const r = Bun.spawnSync(
		[gitExe, "-C", repoPath, "cat-file", "-e", `${sha}^{commit}`],
		{ stdout: "ignore", stderr: "ignore", env: { PATH: "/usr/bin:/bin" } },
	);
	return r.exitCode === 0;
}

/** Flip one bit of the first byte (fixture artifact files only). */
export function flipByte(path: string): void {
	const buf = readFileSync(path);
	buf[0] = (buf[0] ?? 0) ^ 0x01;
	writeFileSync(path, buf);
}

// ── transport observation ──────────────────────────────────────────────────────────────────────────

export interface Mutation {
	method: string;
	path: string;
	at: number;
}

/** Every POST / PUT / PATCH / DELETE the page sends to /api/workspace (synchronous, at request time). */
export class MutationLog {
	readonly all: Mutation[] = [];
	readonly gets: { path: string; at: number }[] = [];
	attach(page: Page): void {
		page.on("request", (r: Request) => {
			const u = new URL(r.url());
			if (!u.pathname.startsWith("/api/workspace")) return;
			const m = r.method();
			if (m === "GET" || m === "HEAD") {
				this.gets.push({ path: u.pathname, at: Date.now() });
				return;
			}
			this.all.push({ method: m, path: u.pathname, at: Date.now() });
		});
	}
	since(t: number): Mutation[] {
		return this.all.filter((m) => m.at >= t);
	}
	getsSince(t: number): number {
		return this.gets.filter((g) => g.at >= t).length;
	}
}

// ── frozen DOM hooks ───────────────────────────────────────────────────────────────────────────────

/** A repository-list row (the frozen hook carries data-repo-kind; campus buttons carry data-repo-id only). */
export const repoRow = (page: Page, repoId: string): Locator =>
	region(page, "Repositories").locator(
		`button[data-repo-kind][data-repo-id="${repoId}"]`,
	);

export const briefing = (page: Page): Locator =>
	page.locator('section[aria-label="CEO briefing"]');

export async function gotoProjects(page: Page): Promise<void> {
	await navLink(page, /^Projects$/).click();
	await region(page, "Repositories").waitFor({ timeout: 8000 });
}

/** Select a repository by its frozen row hook and wait for `aria-current="true"` on it. */
export async function pickRepo(
	page: Page,
	repoId: string,
	o: { nav?: boolean } = {},
): Promise<void> {
	if (o.nav !== false) await gotoProjects(page);
	const row = repoRow(page, repoId);
	await row.waitFor({ timeout: 8000 });
	await row.click();
	await until(
		async () => (await row.getAttribute("aria-current")) === "true",
		`repository row ${repoId} aria-current`,
		8000,
		100,
	);
}

export interface RepoRowInfo {
	id: string;
	kind: string | null;
	current: string | null;
	text: string;
}

export async function repoRows(page: Page): Promise<RepoRowInfo[]> {
	return (await region(page, "Repositories")
		.locator("button[data-repo-kind][data-repo-id]")
		.evaluateAll((bs) =>
			bs.map((b) => ({
				id: b.getAttribute("data-repo-id") ?? "",
				kind: b.getAttribute("data-repo-kind"),
				current: b.getAttribute("aria-current"),
				text: ((b as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim(),
			})),
		)) as RepoRowInfo[];
}

export interface BriefingItem {
	kind: string;
	taskId: string;
	requestId: string | null;
	text: string;
	controls: number;
}

export interface BriefingInfo {
	present: number;
	repo: string | null;
	state: string | null;
	freshness: string | null;
	summary: string;
	items: BriefingItem[];
}

export async function briefingInfo(page: Page): Promise<BriefingInfo> {
	return (await page.evaluate(() => {
		const all = document.querySelectorAll('section[aria-label="CEO briefing"]');
		const s = all[0] ?? null;
		const items = s
			? [...s.querySelectorAll("[data-briefing-item]")].map((el) => ({
					kind: el.getAttribute("data-briefing-item") ?? "",
					taskId: el.getAttribute("data-task-id") ?? "",
					requestId: el.getAttribute("data-request-id"),
					text: ((el as HTMLElement).innerText ?? "")
						.replace(/\s+/g, " ")
						.trim(),
					controls: el.querySelectorAll("button, a[href]").length,
				}))
			: [];
		return {
			present: all.length,
			repo: s?.getAttribute("data-repo-id") ?? null,
			state: s?.getAttribute("data-briefing-state") ?? null,
			freshness: s?.getAttribute("data-freshness") ?? null,
			summary: (
				(
					s?.querySelector(
						'[data-testid="briefing-summary"]',
					) as HTMLElement | null
				)?.innerText ?? ""
			)
				.replace(/\s+/g, " ")
				.trim(),
			items,
		};
	})) as BriefingInfo;
}

/** Wait until the briefing names `repoId` and (optionally) shows one of `states`. */
export async function waitBriefing(
	page: Page,
	repoId: string,
	states?: string[],
	ms = 8000,
): Promise<BriefingInfo> {
	let b: BriefingInfo | null = null;
	await until(
		async () => {
			b = await briefingInfo(page);
			return (
				b.repo === repoId &&
				b.state !== "loading" &&
				(!states || states.includes(b.state ?? ""))
			);
		},
		`CEO briefing for ${repoId}${states ? ` in ${states.join("|")}` : ""}`,
		ms,
		100,
	).catch((err) => {
		const last = b as BriefingInfo | null;
		throw new Error(
			`${(err as Error).message}; last: present=${last?.present} repo=${last?.repo} state=${last?.state}`,
		);
	});
	return b as unknown as BriefingInfo;
}

/**
 * Open the briefing's collapsed details, if any (summary first, details on demand: the item controls live
 * in a native <details> disclosure). Generic HTML only — no implementation class or test id is assumed.
 * Returns true when something had to be opened.
 */
export async function expandBriefing(page: Page): Promise<boolean> {
	const closed = briefing(page).locator("details:not([open]) > summary");
	const n = await closed.count();
	for (let i = 0; i < n; i++) await closed.first().click();
	return n > 0;
}

/** The navigating control inside one briefing item (the first button or link). */
export const briefingControl = (page: Page, i: number): Locator =>
	briefing(page)
		.locator("[data-briefing-item]")
		.nth(i)
		.locator("button, a[href]")
		.first();

export async function taskRepo(page: Page): Promise<string> {
	const l = page.getByTestId("task-repo");
	return (await l.count()) ? textOf(l) : "";
}

export async function queueStatus(page: Page): Promise<string> {
	const l = page.getByTestId("queue-status");
	return (await l.count()) ? textOf(l) : "";
}

export interface InboxItem {
	requestId: string;
	repo: string;
	text: string;
}

export async function inboxItems(page: Page): Promise<InboxItem[]> {
	return (await region(page, "Approval inbox")
		.locator("button[data-request-id]")
		.evaluateAll((bs) =>
			bs.map((b) => ({
				requestId: b.getAttribute("data-request-id") ?? "",
				repo: (
					b.querySelector('[data-testid="inbox-repo"]')?.textContent ?? ""
				).trim(),
				text: ((b as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim(),
			})),
		)) as InboxItem[];
}

export async function documentRepo(page: Page): Promise<string> {
	const l = region(page, "Approval document").getByTestId("document-repo");
	return (await l.count()) ? textOf(l) : "";
}

/** Task ids listed in the Tasks region. */
export async function listedTasks(page: Page): Promise<string[]> {
	return (await region(page, "Tasks")
		.locator("[data-task-id]")
		.evaluateAll((els) =>
			els.map((e) => e.getAttribute("data-task-id") ?? ""),
		)) as string[];
}

export async function hashOf(page: Page): Promise<string> {
	return (await page.evaluate(() =>
		decodeURIComponent(location.hash),
	)) as string;
}

/** Visible buttons in `main` whose accessible name matches `re` (execution capability probe). */
export async function mainButtons(page: Page, re: RegExp): Promise<string[]> {
	const names = (await page
		.getByRole("main")
		.getByRole("button")
		.evaluateAll((bs) =>
			bs
				.filter((b) => (b as HTMLElement).offsetParent !== null)
				.map((b) =>
					(
						b.getAttribute("aria-label") ??
						(b as HTMLElement).innerText ??
						""
					).trim(),
				),
		)) as string[];
	return names.filter((n) => re.test(n));
}

/** Running animations whose target is inside `selector` (CSS / WAAPI). */
export async function runningAnimationsIn(
	page: Page,
	selector: string,
): Promise<number> {
	return (await page.evaluate((sel) => {
		const root = document.querySelector(sel);
		if (!root) return 0;
		return document.getAnimations().filter((a) => {
			const t = (a.effect as KeyframeEffect | null)?.target as Element | null;
			return a.playState === "running" && t !== null && root.contains(t);
		}).length;
	}, selector)) as number;
}

/** Whole-document running animations. */
export async function runningAnimations(page: Page): Promise<number> {
	return (await page.evaluate(
		() =>
			document.getAnimations().filter((a) => a.playState === "running").length,
	)) as number;
}

/** Repository rows are readable: full id rendered, not clipped, inside the viewport, ≥ 12 px. */
export async function repoLabelIssues(
	page: Page,
): Promise<{ rows: number; issues: string[] }> {
	return (await page.evaluate(() => {
		const out: string[] = [];
		let rows = 0;
		const vw = document.documentElement.clientWidth;
		for (const b of document.querySelectorAll<HTMLElement>(
			'section[aria-label="Repositories"] button[data-repo-kind][data-repo-id]',
		)) {
			rows += 1;
			const id = b.getAttribute("data-repo-id") ?? "";
			const r = b.getBoundingClientRect();
			const fs = Number.parseFloat(getComputedStyle(b).fontSize);
			if (
				!(b.innerText ?? "")
					.replace(/\s+/g, "")
					.includes(id.replace(/\s+/g, ""))
			)
				out.push(`${id}: id not rendered in full`);
			if (b.scrollWidth > b.clientWidth + 1)
				out.push(`${id}: clipped (${b.scrollWidth} > ${b.clientWidth})`);
			if (r.left < -0.5 || r.right > vw + 0.5)
				out.push(`${id}: outside the viewport`);
			if (fs < 12) out.push(`${id}: font ${fs}px`);
			for (const el of b.querySelectorAll<HTMLElement>("*")) {
				const cs = getComputedStyle(el);
				if (
					(cs.overflowX === "hidden" || cs.overflowX === "clip") &&
					el.scrollWidth > el.clientWidth + 1 &&
					(el.innerText ?? "").includes(id)
				)
					out.push(`${id}: clipped inside ${el.tagName.toLowerCase()}`);
			}
		}
		return { rows, issues: out };
	})) as { rows: number; issues: string[] };
}

/** Document-level horizontal overflow (page scroll). */
export async function pageOverflowX(page: Page): Promise<number> {
	return (await page.evaluate(() => {
		const de = document.documentElement;
		return Math.max(0, de.scrollWidth - de.clientWidth);
	})) as number;
}

/** Element under keyboard focus: tag, accessible label, and selected data attributes. */
export async function focusInfo(page: Page): Promise<{
	tag: string;
	name: string;
	repoId: string | null;
	inBriefing: boolean;
	inItem: boolean;
	label: string;
}> {
	return (await page.evaluate(() => {
		const el = document.activeElement as HTMLElement | null;
		const lab =
			(el as HTMLInputElement | null)?.labels?.[0]?.textContent ??
			el?.getAttribute("aria-label") ??
			"";
		return {
			tag: el?.tagName.toLowerCase() ?? "",
			name: (el?.innerText ?? el?.textContent ?? "")
				.replace(/\s+/g, " ")
				.trim(),
			repoId: el?.getAttribute("data-repo-id") ?? null,
			inBriefing: Boolean(el?.closest('section[aria-label="CEO briefing"]')),
			inItem: Boolean(el?.closest("[data-briefing-item]")),
			label: lab.trim(),
		};
	})) as {
		tag: string;
		name: string;
		repoId: string | null;
		inBriefing: boolean;
		inItem: boolean;
		label: string;
	};
}

/** Keyboard only: Tab (then Shift+Tab) until `match` holds for the focused element. */
export async function tabUntil(
	page: Page,
	match: (f: Awaited<ReturnType<typeof focusInfo>>) => boolean,
	what: string,
	max = 150,
): Promise<number> {
	let n = 0;
	for (const key of ["Tab", "Shift+Tab"]) {
		for (let i = 0; i < max; i++) {
			await page.keyboard.press(key);
			n += 1;
			if (match(await focusInfo(page))) return n;
		}
	}
	throw new Error(`keyboard focus never reached ${what}`);
}

/** HQ inbox button for `kind` + `title` (role-09 naming: "<gate> · <title>"). */
export const inboxButton = (page: Page, kind: Gate, title: string): Locator =>
	region(page, "Approval inbox").getByRole("button", {
		name: new RegExp(`^${escapeRe(`${GATE_NAME[kind]} · ${title}`)}`),
	});

/**
 * Record every text the approval document's "Decision status" shows (in-page MutationObserver, so a
 * state shown for a few milliseconds is not missed by polling). Read back with `statusTrail`.
 */
export async function recordDecisionStatus(page: Page): Promise<void> {
	await page.evaluate(() => {
		const w = window as unknown as { __mrStatus?: string[] };
		w.__mrStatus = [];
		const read = () => {
			const t = (
				document.querySelector('[aria-label="Decision status"]')?.textContent ??
				""
			).trim();
			const trail = w.__mrStatus ?? [];
			if (t && trail.at(-1) !== t) trail.push(t);
		};
		read();
		new MutationObserver(read).observe(document.body, {
			subtree: true,
			childList: true,
			characterData: true,
			attributes: true,
		});
	});
}

export async function statusTrail(page: Page): Promise<string[]> {
	return (await page.evaluate(
		() => (window as unknown as { __mrStatus?: string[] }).__mrStatus ?? [],
	)) as string[];
}

export { check };
