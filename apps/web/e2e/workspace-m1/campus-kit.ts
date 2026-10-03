// Worker C (independent QA, campus milestone) — helpers for `campus.suite.ts` only.
// Reuses the role-09 kit (`./kit.ts`) and the lead harness; adds campus DOM probes, a WebGL context
// counter (init script), keyboard focus helpers, and test-only seeding of LEGACY (pre-v1.2) Gate-1
// rows into the disposable hub through the hub's own test helpers (never production code paths).
// Secrets (credentials, cookies, CSRF, challenges) stay in memory: nothing here prints a value.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { SESSION_COOKIE } from "../../../hub/src/workspace-m1/auth/http.ts";
import {
	approveLegacyV1Raw,
	publishLegacyV1,
} from "../../../hub/src/workspace-m1/decisions/test-support.ts";
import type { WorkspaceEnv } from "../workspace-harness.ts";
import { check, until } from "./kit.ts";

/** Headless Chromium with a software WebGL implementation (as the campus dev shots use). */
export const GL_ARGS = [
	"--use-angle=swiftshader",
	"--enable-unsafe-swiftshader",
	"--ignore-gpu-blocklist",
];
export const NOGL_ARGS = [
	"--disable-webgl",
	"--disable-webgl2",
	"--disable-3d-apis",
];

/**
 * Counts every WebGL context the page creates and how many are still live (not lost). The campus
 * probe context (`webglAvailable`) and the renderer's context are both counted; a released context
 * is lost (`loseContext` / `forceContextLoss`).
 */
export const GL_COUNTER_SCRIPT = `(() => {
	const ctxs = [];
	const P = HTMLCanvasElement.prototype;
	const orig = P.getContext;
	P.getContext = function (type, ...rest) {
		const c = orig.call(this, type, ...rest);
		if (c && /webgl/i.test(String(type)) && !ctxs.includes(c)) ctxs.push(c);
		return c;
	};
	globalThis.__cmpGl = () => ({
		total: ctxs.length,
		live: ctxs.filter((c) => !c.isContextLost()).length,
	});
})();`;

export interface CampusProbe {
	present: boolean;
	scene: string | null;
	mode: string | null;
	reduced: string | null;
	visitors: string | null;
	walking: string | null;
	canvases: number;
	glTotal: number;
	glLive: number;
	visits: string[];
	gates: string[];
	buildings: { id: string; integrity: string | null; current: string | null }[];
	note: string | null;
}

/** One read of the campus QA hooks (`.cmp`, `.cmp-gl`, `.cmp-visit`, `.cmp-building`). */
export async function campusProbe(page: Page): Promise<CampusProbe> {
	return (await page.evaluate(() => {
		const root = document.querySelector(".cmp");
		const gl = document.querySelector(".cmp-gl");
		const counter = (
			globalThis as unknown as {
				__cmpGl?: () => { total: number; live: number };
			}
		).__cmpGl?.() ?? { total: -1, live: -1 };
		return {
			present: root !== null,
			scene: root?.getAttribute("data-scene-state") ?? null,
			mode: root?.getAttribute("data-mode") ?? null,
			reduced: root?.getAttribute("data-reduced-motion") ?? null,
			visitors: gl?.getAttribute("data-visitors") ?? null,
			walking: gl?.getAttribute("data-walking") ?? null,
			canvases: document.querySelectorAll("canvas").length,
			glTotal: counter.total,
			glLive: counter.live,
			visits: [...document.querySelectorAll(".cmp-visit")].map(
				(b) => b.getAttribute("data-request-id") ?? "",
			),
			gates: [...document.querySelectorAll(".cmp-visit")].map(
				(b) => b.getAttribute("data-gate") ?? "",
			),
			buildings: [...document.querySelectorAll(".cmp-building")].map((b) => ({
				id: b.getAttribute("data-repo-id") ?? "",
				integrity: b.getAttribute("data-integrity"),
				current: b.getAttribute("aria-current"),
			})),
			note:
				document.querySelector(".cmp-note")?.getAttribute("data-reason") ??
				null,
		};
	})) as CampusProbe;
}

export const visitButton = (page: Page, requestId: string) =>
	page.locator(`.cmp-visit[data-request-id="${requestId}"]`);

export const docFor = (page: Page, requestId: string) =>
	page.locator(
		`section[aria-label="Approval document"][data-request-id="${requestId}"]`,
	);

/** True when the element's centre is not covered by anything else (e.g. the canvas). */
export async function notCovered(page: Page, selector: string) {
	return (await page.evaluate((sel) => {
		const el = document.querySelector(sel);
		if (!el) return false;
		const r = el.getBoundingClientRect();
		const hit = document.elementFromPoint(
			r.left + r.width / 2,
			r.top + r.height / 2,
		);
		return hit !== null && (hit === el || el.contains(hit));
	}, selector)) as boolean;
}

/** Waits until the campus shows the scene in a settled state (live / unavailable / paused). */
export async function sceneSettled(page: Page, ms = 25_000): Promise<string> {
	let s = "";
	await until(
		async () => {
			s = (await campusProbe(page)).scene ?? "";
			return ["live", "unavailable", "paused"].includes(s);
		},
		"campus scene settled",
		ms,
		200,
	);
	return s;
}

// ── keyboard focus (copied from the role-09 HUB suite; that file runs on import) ──

export interface Focused {
	tag: string;
	text: string;
	label: string;
	id: string;
	role: string;
	cls: string;
}

export async function focused(page: Page): Promise<Focused> {
	return (await page.evaluate(() => {
		const el = document.activeElement as HTMLElement | null;
		if (!el) return { tag: "", text: "", label: "", id: "", role: "", cls: "" };
		const lab =
			(el as HTMLInputElement).labels?.[0]?.textContent ??
			el.getAttribute("aria-label") ??
			"";
		return {
			tag: el.tagName.toLowerCase(),
			text: (el.innerText ?? el.textContent ?? "").trim().replace(/\s+/g, " "),
			label: lab.trim(),
			id: el.id,
			role: el.getAttribute("role") ?? "",
			cls: el.className && typeof el.className === "string" ? el.className : "",
		};
	})) as Focused;
}

/** Keyboard only: Tab (Shift+Tab first when `back`) until `match`; then tries the other way. */
export async function tabTo(
	page: Page,
	match: (f: Focused) => boolean,
	what: string,
	max = 120,
	back = false,
): Promise<number> {
	let presses = 0;
	for (const dir of back ? ["Shift+Tab", "Tab"] : ["Tab", "Shift+Tab"]) {
		for (let i = 0; i < max; i++) {
			await page.keyboard.press(dir);
			presses += 1;
			if (match(await focused(page))) return presses;
		}
	}
	throw new Error(`Tab never reached ${what}`);
}

/**
 * The campus document strip is one tab stop (WAI-ARIA toolbar): Tab into it, then Home and
 * ArrowRight until the document named `label` has focus. Keyboard only.
 */
export async function keyToVisit(page: Page, label: string): Promise<number> {
	await tabTo(page, (f) => f.cls.includes("cmp-visit"), "document strip");
	const n = await page.locator(".cmp-visit").count();
	await page.keyboard.press("Home");
	for (let i = 0; i <= n; i++) {
		const f = await focused(page);
		if (f.cls.includes("cmp-visit") && f.label === label) return i;
		await page.keyboard.press("ArrowRight");
	}
	throw new Error(`arrow keys never reached the document "${label}"`);
}

/** Focusable elements inside the document strip (tabIndex ≥ 0, not disabled). */
export async function stripTabStops(page: Page): Promise<number> {
	return (await page.evaluate(
		() =>
			[
				...document.querySelectorAll<HTMLElement>(
					'.cmp [role="toolbar"] button, .cmp [role="toolbar"] a, .cmp [role="toolbar"] [tabindex]',
				),
			].filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled)
				.length,
	)) as number;
}

// ── tampering (files under env.fx only) ─────────────────────────────────────

export function flipByte(path: string, at = 0): void {
	const buf = readFileSync(path);
	const i = Math.min(Math.max(0, at), buf.length - 1);
	buf[i] = (buf[i] ?? 0) ^ 0x01;
	writeFileSync(path, buf);
}

/** A 43-char base64url token (the challenge shape) that no hub ever issued. */
export const bogusToken = () =>
	randomBytes(32).toString("base64url").slice(0, 43);

// ── direct HTTP from the page (same origin, the page's own session) ─────────

export interface PostResult {
	status: number;
	error: string | null;
	issue: string | null;
}

/** POST from inside the page with the session's current CSRF token (never returned). */
export async function pagePost(
	page: Page,
	path: string,
	body: unknown,
	csrfFrom: "session" | "stashed" = "session",
): Promise<PostResult> {
	return (await page.evaluate(
		async ({ path, body, csrfFrom }) => {
			let csrf = "";
			if (csrfFrom === "stashed") {
				csrf =
					(globalThis as unknown as { __cmpOldCsrf?: string }).__cmpOldCsrf ??
					"";
			} else {
				const s = await fetch("/api/workspace/session", {
					credentials: "same-origin",
				});
				const j = (await s.json().catch(() => null)) as {
					csrf_token?: string;
				} | null;
				csrf = j?.csrf_token ?? "";
			}
			const r = await fetch(path, {
				method: "POST",
				credentials: "same-origin",
				headers: {
					"content-type": "application/json",
					"x-agentcity-csrf": csrf,
				},
				body: JSON.stringify(body),
			});
			const j = (await r.json().catch(() => null)) as {
				error?: string;
				issues?: { message?: string }[];
			} | null;
			return {
				status: r.status,
				error: j?.error ?? null,
				issue: j?.issues?.[0]?.message ?? null,
			};
		},
		{ path, body, csrfFrom },
	)) as PostResult;
}

/** Keep the current session's CSRF token in page memory only (for an old-session replay). */
export async function stashCsrf(page: Page): Promise<boolean> {
	return (await page.evaluate(async () => {
		const s = await fetch("/api/workspace/session", {
			credentials: "same-origin",
		});
		const j = (await s.json().catch(() => null)) as {
			csrf_token?: string;
		} | null;
		(globalThis as unknown as { __cmpOldCsrf?: string }).__cmpOldCsrf =
			j?.csrf_token ?? "";
		return typeof j?.csrf_token === "string";
	})) as boolean;
}

export async function dropStash(page: Page): Promise<void> {
	await page.evaluate(() => {
		delete (globalThis as unknown as { __cmpOldCsrf?: string }).__cmpOldCsrf;
	});
}

// ── legacy (pre-v1.2) seeding through the hub's own test helpers ────────────

type Verified = Parameters<typeof approveLegacyV1Raw>[1];

function workspaceOf(env: WorkspaceEnv) {
	const ws = env.hub().workspace;
	check(ws, "the hub is not in workspace mode");
	return ws;
}

/**
 * A VerifiedAuthContext minted by THIS hub's auth instance through its own guard (the pattern of
 * bridge/test-support.ts): a separate in-process Hono app with the same auth installed. The
 * session it creates is signed out by `signOut()`. Returns the cookie/CSRF only for scrubbing.
 */
export async function mintVerified(env: WorkspaceEnv): Promise<{
	v: Verified;
	secrets: string[];
	signOut(): Promise<void>;
}> {
	const ws = workspaceOf(env);
	const api = ws.api;
	const App = api.constructor as new () => typeof api;
	const inner = new App();
	ws.auth.install(inner);
	const box: { v: Verified | null } = { v: null };
	inner.post("/__cmp_probe", (c) => {
		box.v = ws.auth.verified(c);
		return c.json({ ok: true });
	});
	const outer = new App();
	outer.route("/api/workspace", inner);
	const res = await outer.request("/api/workspace/session", {
		method: "POST",
		headers: { origin: env.uiUrl, "content-type": "application/json" },
		body: JSON.stringify({ credential: env.credential }),
	});
	check(res.status === 200, `probe sign-in failed (${res.status})`);
	const cookie =
		new RegExp(`^${SESSION_COOKIE}=([^;]*)`).exec(
			res.headers.get("set-cookie") ?? "",
		)?.[1] ?? "";
	const { csrf_token } = (await res.json()) as { csrf_token: string };
	const headers = {
		cookie: `${SESSION_COOKIE}=${cookie}`,
		origin: env.uiUrl,
		"x-agentcity-csrf": csrf_token,
		"content-type": "application/json",
	};
	const probe = await outer.request("/api/workspace/__cmp_probe", {
		method: "POST",
		headers,
		body: "{}",
	});
	check(probe.status === 200 && box.v !== null, `probe (${probe.status})`);
	return {
		v: box.v,
		secrets: [cookie, csrf_token],
		async signOut() {
			try {
				await outer.request("/api/workspace/session", {
					method: "DELETE",
					headers,
				});
			} catch {
				// already gone
			}
		},
	};
}

/** A LEGACY v1 publish (pending Gate 1) on the running hub's store — test helper, disposable DB. */
export async function seedLegacyPending(env: WorkspaceEnv, taskId: string) {
	const ws = workspaceOf(env);
	return publishLegacyV1(
		{
			store: ws.store,
			config: env.fx.config,
			services: { bridge: ws.bridge.port },
			tick: () => new Date(),
		},
		taskId,
	);
}

/** The pre-policy approval of a legacy Gate 1 (queued exactly as the old decision path did). */
export function approveLegacyBeforePolicy(
	env: WorkspaceEnv,
	v: Verified,
	runRequestId: string,
) {
	const ws = workspaceOf(env);
	return approveLegacyV1Raw(
		{
			store: ws.store,
			auth: ws.auth,
			services: { bridge: ws.bridge.port },
			tick: () => new Date(),
		},
		v,
		runRequestId,
	);
}

// ── layout probes ───────────────────────────────────────────────────────────

export interface OverflowReport {
	pageOverflowX: boolean;
	scrollWidth: number;
	clientWidth: number;
	/** Text elements inside `root` whose content is clipped horizontally or leaves the root. */
	clipped: string[];
}

/** Horizontal overflow of the page and clipped / escaping text inside `rootSel`. */
export async function overflowIn(
	page: Page,
	rootSel: string,
): Promise<OverflowReport> {
	return (await page.evaluate((sel) => {
		const de = document.documentElement;
		const root = document.querySelector(sel) as HTMLElement | null;
		const clipped: string[] = [];
		if (root) {
			const rr = root.getBoundingClientRect();
			for (const el of root.querySelectorAll<HTMLElement>("*")) {
				if (el.closest("canvas, svg, .cmp-scene")) continue;
				const text = (el.textContent ?? "").trim();
				if (!text || el.children.length > 3) continue;
				const cs = getComputedStyle(el);
				if (cs.display === "none" || cs.visibility === "hidden") continue;
				const r = el.getBoundingClientRect();
				if (r.width === 0 || r.height === 0) continue;
				const over = el.scrollWidth > el.clientWidth + 1;
				const clips =
					over &&
					(cs.overflowX === "hidden" || cs.overflowX === "clip") &&
					cs.textOverflow !== "ellipsis";
				const escapes = r.right > rr.right + 1 || r.left < rr.left - 1;
				if (clips || (escapes && cs.position !== "fixed"))
					clipped.push(
						`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0] ?? ""}${clips ? "[clipped]" : "[escapes]"}:${text.slice(0, 40)}`,
					);
			}
		}
		return {
			pageOverflowX: de.scrollWidth > de.clientWidth,
			scrollWidth: de.scrollWidth,
			clientWidth: de.clientWidth,
			clipped: clipped.slice(0, 12),
		};
	}, rootSel)) as OverflowReport;
}

/**
 * How much of each campus document button's TITLE is actually visible (the text cell ellipsizes):
 * visible px of `.cmp-visit-title` inside `.cmp-visit-text` minus the ellipsis, and an estimate
 * in characters (title width / title length).
 */
export async function visitTitleVisibility(
	page: Page,
): Promise<{ id: string; title: string; visibleChars: number }[]> {
	return (await page.evaluate(() =>
		[...document.querySelectorAll(".cmp-visit")].map((b) => {
			const title = b.querySelector(".cmp-visit-title") as HTMLElement | null;
			// the clipping box: the shared text cell when there is one, else the title itself
			const text =
				(b.querySelector(".cmp-visit-text") as HTMLElement | null) ?? title;
			const t = title?.textContent ?? "";
			if (!text || !title || !t)
				return {
					id: b.getAttribute("data-request-id") ?? "",
					title: t,
					visibleChars: 0,
				};
			const clipped = text.scrollWidth > text.clientWidth + 1;
			let visiblePx: number;
			let perChar: number;
			if (text === title) {
				visiblePx = Math.max(0, title.clientWidth - (clipped ? 12 : 0));
				perChar = title.scrollWidth / t.length || 7;
			} else {
				const tr = text.getBoundingClientRect();
				const rr = title.getBoundingClientRect();
				visiblePx = Math.max(
					0,
					Math.min(rr.right, tr.right) - rr.left - (clipped ? 12 : 0),
				);
				perChar = rr.width / t.length || 7;
			}
			return {
				id: b.getAttribute("data-request-id") ?? "",
				title: t,
				visibleChars: Math.min(t.length, Math.floor(visiblePx / perChar)),
			};
		}),
	)) as { id: string; title: string; visibleChars: number }[];
}

/** True when the element's box lies fully inside the viewport. */
export async function inViewport(page: Page, selector: string) {
	return (await page.evaluate((sel) => {
		const el = document.querySelector(sel);
		if (!el) return false;
		const r = el.getBoundingClientRect();
		return (
			r.width > 0 &&
			r.top >= 0 &&
			r.left >= 0 &&
			r.bottom <= window.innerHeight + 0.5 &&
			r.right <= window.innerWidth + 0.5
		);
	}, selector)) as boolean;
}
