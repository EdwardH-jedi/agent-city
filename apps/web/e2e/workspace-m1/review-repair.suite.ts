// biome-ignore-all lint/suspicious/noExplicitAny: raw, untyped HTTP bodies read inside the page through the hub API
// Review repair browser evidence (APP-P2-01 / APP-P2-02, review of d158571, 2026-10-05) against the isolated
// real hub (same harness and isolation as hub.suite.ts / multirepo.suite.ts: free loopback ports, temp SQLite,
// disposable fixture repositories, fake providers only, synthetic credentials).
//
//   bun --no-env-file apps/web/e2e/workspace-m1/review-repair.suite.ts        [M1_ONLY=<regex of case ids>]
//
// Setup goes through the real authenticated API from inside the page (session cookie, exact Origin, CSRF): in
// repository A one failed task, one accepted task made invalid (its sealed bundle removed), and one execution
// held active by a test-only engine barrier; then 500 pending requests in B and 1 in C, so the inbox pins fill
// the 500-task window and C's request is beyond the inbox's first page. Synthetic "Edward" confirmations are
// typed only in this disposable fixture. RR-07 / RR-08 (final T0 repair, T0-RR-P2-02): after the global inbox
// reached its end, new C requests stay reachable through Load more, and one decided through the API (another
// client) leaves the pending display. RR-09 (T0-FINAL-P2-01): at the end, a tail request rejected elsewhere and
// a new one in the same repository and gate (equal total, first page, cursor and counts) — the closed one
// leaves and one Load more reaches the new one, with no automatic inbox read.
import { rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import type { OrchestratorHooks } from "../../../hub/src/managed/orchestrator.ts";
import { startWorkspaceEnv, type WorkspaceEnv } from "../workspace-harness.ts";
import {
	check,
	decisionStatus,
	grantButton,
	newCtx,
	Run,
	region,
	sigField,
	signIn,
	sleep,
	typeSignature,
	until,
} from "./kit.ts";

const ONLY = process.env.M1_ONLY ? new RegExp(process.env.M1_ONLY) : null;
const run = new Run("REPAIR", ONLY);
let env!: WorkspaceEnv;
let browser!: Browser;
let A = "";
let B = "";
let C = "";

// test-only engine barrier: hold one execution before its review stage (so it stays active, leased)
const held = new Map<string, () => void>();
let armed: string | null = null;
const gate: OrchestratorHooks & { releaseAll(): void } = {
	at(point, taskId) {
		if (point === "before_review" && taskId === armed)
			return new Promise<void>((r) => held.set(taskId, r));
	},
	releaseAll() {
		for (const r of held.values()) r();
		held.clear();
	},
};

/** One authenticated API call from inside the page (same-origin cookie + CSRF header). */
async function api(
	page: Page,
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; body: any }> {
	return page.evaluate(
		async ([m, p, b]) => {
			const w = window as unknown as { __csrf?: string };
			if (!w.__csrf) {
				const s = await fetch("/api/workspace/session", {
					credentials: "same-origin",
				});
				w.__csrf = (await s.json()).csrf_token;
			}
			const r = await fetch(`/api/workspace${p}`, {
				method: m as string,
				credentials: "same-origin",
				headers: {
					"content-type": "application/json",
					"x-agentcity-csrf": w.__csrf ?? "",
				},
				body: b === undefined ? undefined : JSON.stringify(b),
			});
			return { status: r.status, body: await r.json().catch(() => null) };
		},
		[method, path, body] as const,
	);
}

const draft = (title: string, scenario = "approve") => ({
	title,
	objective: `Synthetic review-repair task ${title}.`,
	criteria: ["The fixture check passes"],
	scope: { allowed: ["."], protected: [] },
	execution_mode: "simulated",
	simulation_scenario: scenario,
	repair_policy: { max_repairs: 0 },
	criterion_checks: [
		{ criterion: "The fixture check passes", checks: ["fixture-check"] },
	],
});

let seq = 0;
async function publish(
	page: Page,
	repo: string,
	title: string,
	scenario?: string,
) {
	const t = await api(page, "POST", "/tasks", {
		idempotency_key: `rr-${Date.now()}-${++seq}`,
		repo_id: repo,
		draft: draft(title, scenario),
	});
	check(t.status === 201, `create ${t.status}`);
	const p = await api(page, "POST", `/tasks/${t.body.task.id}/proposals`, {
		expected_rev: t.body.task.rev,
	});
	check(p.status === 201, `publish ${p.status}`);
	const req = p.body.approval_requests.find(
		(r: any) => r.kind === "run" && r.status === "pending",
	);
	return { taskId: t.body.task.id as string, req };
}

async function decide(
	page: Page,
	req: any,
	action: "approve" | "accept" | "reject",
) {
	const ch = await api(page, "POST", `/approval-requests/${req.id}/challenge`, {
		kind: req.kind,
		binding_hash: req.binding_hash,
		expected_request_rev: req.rev,
	});
	check(ch.status === 201 || ch.status === 200, `challenge ${ch.status}`);
	const d = await api(page, "POST", `/approval-requests/${req.id}/decisions`, {
		idempotency_key: `rr-dec-${Date.now()}-${++seq}`,
		kind: req.kind,
		action,
		expected_request_rev: ch.body.request_rev,
		binding_hash: req.binding_hash,
		confirmation_text: action === "reject" ? null : "Edward",
		reason: action === "reject" ? "Synthetic review-repair rejection" : null,
		challenge: ch.body.challenge,
	});
	check(d.status === 201, `decision ${d.status}`);
	return d.body;
}

async function waitTask(
	page: Page,
	id: string,
	ok: (v: any) => boolean,
	what: string,
) {
	let last: any = null;
	await until(
		async () => {
			last = (await api(page, "GET", `/tasks/${id}`)).body;
			return ok(last);
		},
		what,
		60_000,
		250,
	);
	return last;
}

const noOverflow = (page: Page) =>
	page.evaluate(
		() => document.documentElement.scrollWidth <= window.innerWidth + 1,
	);

const nav = (page: Page, name: RegExp) =>
	page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name });

async function pickRepo(page: Page, repo: string) {
	await nav(page, /^Projects$/).click();
	await region(page, "Repositories")
		.locator(`button[data-repo-kind][data-repo-id="${repo}"]`)
		.click();
	await page
		.locator(`section[aria-label="CEO briefing"][data-repo-id="${repo}"]`)
		.waitFor();
}

async function main(): Promise<number> {
	const t0 = Date.now();
	const user = userInfo().username;
	check(
		![`/Users/${user}`, `/home/${user}`].includes(
			homedir().replace(/\/+$/, ""),
		),
		"not in the isolated runner (HOME)",
	);
	browser = await chromium.launch({ headless: true });
	env = await startWorkspaceEnv({
		extraRepos: ["beta", "gamma"],
		managedHooks: gate,
		auth: { max_sessions_per_principal: 16 },
	});
	run.secrets.add(env.credential);
	check(!env.uiUrl.endsWith(":4317") && !env.hubUrl.endsWith(":4317"), "4317");
	[A, B, C] = env.repos.map((r) => r.id) as [string, string, string];
	const main = await newCtx(run, browser, env.uiUrl, {
		width: 1440,
		height: 900,
	});
	const page = main.page;
	run.current = page;
	await page.goto(`${env.uiUrl}/#/projects`);
	await signIn(page, env.credential);
	for (const c of await main.context.cookies()) run.secrets.add(c.value);

	// ── setup through the real API ─────────────────────────────────────────────
	const failed = await publish(page, A, "RR A failed", "verification_fails");
	await decide(page, failed.req, "approve");
	await waitTask(page, failed.taskId, (v) => v.phase === "failed", "A failed");
	const acc = await publish(page, A, "RR A accepted then invalid");
	await decide(page, acc.req, "approve");
	const v2 = await waitTask(
		page,
		acc.taskId,
		(v) =>
			v.approval_requests.some(
				(r: any) => r.kind === "result" && r.status === "pending",
			),
		"A result pending",
	);
	const g2 = v2.approval_requests.find(
		(r: any) => r.kind === "result" && r.status === "pending",
	);
	const receipt = await decide(page, g2, "accept");
	const digest = receipt.receipt.effects.evidence_bundle_digest as string;
	rmSync(join(env.fx.config.artifacts_root, "_sealed", `${digest}.bundle`));
	await sleep(6100);
	await waitTask(
		page,
		acc.taskId,
		(v) => v.acceptance_validity?.status === "invalid",
		"A invalid",
	);
	const act = await publish(page, A, "RR A held running");
	armed = act.req.managed_task_id;
	await decide(page, act.req, "approve");
	await until(
		async () => held.has(armed ?? ""),
		"A held before review",
		60_000,
		100,
	);
	for (let i = 1; i <= 500; i++) await publish(page, B, `RR B pending ${i}`);
	const cReq = await publish(page, C, "RR C beyond the first page");
	await page.reload();
	await page.getByText(/^Signed in as operator:edward/).waitFor();

	await run.case("RR-01", async () => {
		// APP-P2-01: A's history is cut from the window; the briefing is not quiet and opens the history read
		await pickRepo(page, A);
		const b = page.locator('section[aria-label="CEO briefing"]');
		await until(
			async () => (await b.getAttribute("data-briefing-state")) === "attention",
			"A attention",
			15_000,
		);
		const summary =
			(await b.getByTestId("briefing-summary").textContent()) ?? "";
		check(
			summary.includes("2 stopped, blocked or invalid"),
			`summary "${summary}"`,
		);
		check(!summary.includes("Nothing is running"), "quiet claim");
		check(
			(await region(page, "Tasks").locator("[data-task-id]").count()) === 0,
			"A rows unexpectedly in the window",
		);
		await b.getByRole("button", { name: /Open repository history/ }).click();
		const h = page.locator('section[aria-label="Repository history"]');
		await until(
			async () => (await h.getAttribute("data-history-status")) === "ready",
			"history ready",
			15_000,
		);
		check(
			(await h
				.locator('[data-history-task-id][data-phase="failed"]')
				.count()) === 1,
			"failed row",
		);
		check(
			(await h
				.locator('[data-history-task-id] [data-validity="invalid"]')
				.count()) === 1,
			"invalid row",
		);
		await run.shot(page, "RR01-omitted-invalid-history-1440");
		check(await noOverflow(page), "horizontal overflow");
		return `briefing attention; "${summary.slice(0, 90)}"; history shows the failed and the invalid acceptance`;
	});

	await run.case("RR-02", async () => {
		// APP-P2-02: A's held execution is counted although its task row is cut by the inbox pins
		const b = page.locator('section[aria-label="CEO briefing"]');
		const summary =
			(await b.getByTestId("briefing-summary").textContent()) ?? "";
		check(/1 (running|queued)/.test(summary), `summary "${summary}"`);
		const campusText =
			(await page.locator(".wsm1-campus-slot").textContent()) ?? "";
		check(campusText.includes("1 in progress"), "campus count for A");
		// the Repositories card counts A from the complete summary, not the cut window (failed + held run)
		const card =
			(await page
				.locator(
					`button.wsm1-building[data-repo-id="${A}"] .wsm1-building-stats`,
				)
				.textContent()) ?? "";
		check(
			card.replace(/\s+/g, " ").trim() === "2 active tasks · 0 awaiting Edward",
			`Repositories card for A "${card}"`,
		);
		await run.shot(page, "RR02-held-A-counted-1440");
		return `briefing "${summary.slice(0, 60)}"; campus "1 in progress"; Repositories card "2 active tasks · 0 awaiting Edward"`;
	});

	await run.case("RR-03", async () => {
		// the global inbox discloses truncation; Load more reaches C's request
		await nav(page, /^Head/).click();
		const inbox = region(page, "Approval inbox");
		const disc = inbox.getByTestId("inbox-disclosure");
		await until(
			async () => /of 501 pending/.test((await disc.textContent()) ?? ""),
			"disclosure 501",
			15_000,
		);
		check(
			(await inbox
				.locator(`button[data-request-id][data-repo-id="${C}"]`)
				.count()) === 0,
			"C on first page",
		);
		await inbox.getByTestId("inbox-load-more").click();
		await inbox
			.locator(`button[data-request-id="${cReq.req.id}"]`)
			.waitFor({ timeout: 15_000 });
		await run.shot(page, "RR03-hq-load-more-1440");
		return `"${(await disc.textContent())?.slice(0, 80)}"`;
	});

	await run.case("RR-04", async () => {
		// a load-more failure keeps the loaded rows and offers Retry
		await page.reload();
		await page.getByText(/^Signed in as operator:edward/).waitFor();
		const inbox = region(page, "Approval inbox");
		await inbox.getByTestId("inbox-load-more").waitFor();
		let failedOnce = false;
		await page.route("**/api/workspace/inbox?**", async (route) => {
			if (!failedOnce) {
				failedOnce = true;
				return route.abort("connectionreset");
			}
			return route.continue();
		});
		await inbox.getByTestId("inbox-load-more").click();
		await inbox.getByTestId("inbox-error").waitFor({ timeout: 10_000 });
		const rows = await inbox.locator("button[data-request-id]").count();
		check(rows === 500, `rows after failure ${rows}`);
		await run.shot(page, "RR04-load-more-failed-1440");
		await inbox
			.getByTestId("inbox-error")
			.getByRole("button", { name: "Retry" })
			.click();
		await inbox
			.locator(`button[data-request-id="${cReq.req.id}"]`)
			.waitFor({ timeout: 15_000 });
		await page.unrouteAll({ behavior: "ignoreErrors" });
		return `failure kept ${rows} rows; Retry loaded C`;
	});

	await run.case("RR-05", async () => {
		// server-side repository filter: C's request; opening it keeps the exact gate path and closes on receipt
		const inbox = region(page, "Approval inbox");
		await inbox.getByLabel("Repository").selectOption(C);
		await until(
			async () =>
				/of 1 pending in/.test(
					(await inbox.getByTestId("inbox-disclosure").textContent()) ?? "",
				),
			"C filter",
			15_000,
		);
		await run.shot(page, "RR05-hq-filter-C-1440");
		await inbox.locator(`button[data-request-id="${cReq.req.id}"]`).click();
		await typeSignature(page, "run");
		await grantButton(page, "run").click();
		await until(
			async () => /Execution approved/.test(await decisionStatus(page)),
			"approved",
			15_000,
		);
		check(
			(await sigField(page, "run").count()) === 0,
			"signature input still offered after the receipt",
		);
		// the decided request leaves the loaded filtered page (the fresher task read proves it)
		await until(
			async () =>
				(await inbox
					.locator(`button[data-request-id="${cReq.req.id}"]`)
					.count()) === 0 &&
				/of 0 pending in/.test(
					(await inbox.getByTestId("inbox-disclosure").textContent()) ?? "",
				),
			"decided C leaves the filtered list",
			15_000,
		);
		await run.shot(page, "RR05-committed-receipt-1440");
		return "C reached by the server filter; approved once; controls closed by the receipt; C left the filtered list";
	});

	await run.case("RR-06", async () => {
		// 1280×800: the same states fit without horizontal overflow
		const small = await newCtx(run, browser as Browser, env.uiUrl, {
			width: 1280,
			height: 800,
		});
		run.current = small.page;
		await small.page.goto(`${env.uiUrl}/#/projects`);
		await signIn(small.page, env.credential);
		await pickRepo(small.page, A);
		await small.page
			.locator('section[aria-label="CEO briefing"]')
			.getByRole("button", { name: /Open repository history/ })
			.click();
		await small.page
			.locator(
				'section[aria-label="Repository history"][data-history-status="ready"]',
			)
			.waitFor({ timeout: 15_000 });
		check(await noOverflow(small.page), "overflow (projects)");
		await run.shot(small.page, "RR06-omitted-invalid-history-1280");
		await nav(small.page, /^Head/).click();
		await region(small.page, "Approval inbox")
			.getByTestId("inbox-disclosure")
			.waitFor();
		check(await noOverflow(small.page), "overflow (hq)");
		await run.shot(small.page, "RR06-hq-1280");
		await small.context.close();
		run.current = page;
		return "1280×800: history and inbox render without horizontal overflow";
	});

	// T0-RR-P2-02 (final T0 repair): the unfiltered continuation follows the snapshot's pending membership
	const fresh: { taskId: string; req: any }[] = [];
	await run.case("RR-07", async () => {
		// global inbox at its end, then new requests arrive: Load more reaches each one (no reload, no filter)
		const inbox = region(page, "Approval inbox");
		const disc = inbox.getByTestId("inbox-disclosure");
		await inbox.getByLabel("Repository").selectOption("all");
		await until(
			async () => /of 500 pending/.test((await disc.textContent()) ?? ""),
			"500 pending after RR-05",
			20_000,
		);
		check(
			(await inbox.getByTestId("inbox-load-more").count()) === 0,
			"Load more at the end",
		);
		for (const n of [501, 502]) {
			fresh.push(await publish(page, C, `RR C arrival ${n}`));
			await until(
				async () =>
					new RegExp(`of ${n} pending`).test((await disc.textContent()) ?? ""),
				`fresh total ${n}`,
				20_000,
			);
			await inbox.getByTestId("inbox-load-more").click();
			for (const f of fresh)
				await inbox
					.locator(`button[data-request-id="${f.req.id}"]`)
					.waitFor({ timeout: 15_000 });
			check(
				new RegExp(`Showing ${n} of ${n} pending`).test(
					(await disc.textContent()) ?? "",
				),
				`disclosure at ${n}: "${await disc.textContent()}"`,
			);
		}
		await run.shot(page, "RR07-arrivals-after-end-1440");
		return `after the end, ${fresh.length} arrivals each reached by Load more; "${await disc.textContent()}"`;
	});

	await run.case("RR-08", async () => {
		// a loaded tail request decided through another client leaves the pending display; the rest stays reachable
		const inbox = region(page, "Approval inbox");
		const disc = inbox.getByTestId("inbox-disclosure");
		const [gone, kept] = fresh as [
			{ taskId: string; req: any },
			{ taskId: string; req: any },
		];
		await decide(page, gone.req, "approve");
		await until(
			async () =>
				/of 501 pending/.test((await disc.textContent()) ?? "") &&
				(await inbox
					.locator(`button[data-request-id="${gone.req.id}"]`)
					.count()) === 0,
			"decided tail request left the pending display",
			20_000,
		);
		if (
			(await inbox
				.locator(`button[data-request-id="${kept.req.id}"]`)
				.count()) === 0
		)
			await inbox.getByTestId("inbox-load-more").click();
		await inbox
			.locator(`button[data-request-id="${kept.req.id}"]`)
			.waitFor({ timeout: 15_000 });
		check(
			(await inbox
				.locator(`button[data-request-id="${gone.req.id}"]`)
				.count()) === 0,
			"decided request listed again",
		);
		await run.shot(page, "RR08-decided-elsewhere-left-1440");
		return `decided request gone; remaining arrival reachable; "${await disc.textContent()}"`;
	});

	await run.case("RR-09", async () => {
		// T0-FINAL-P2-01: at the end of the global inbox, tail request X is rejected through another client and Y
		// opens in the same repository and gate. Total, first page, cursor and per-repository counts stay equal;
		// only the hub's membership generation moves. Snapshot answers are held only during the two writes, so
		// no intermediate total can mask the replacement.
		const inbox = region(page, "Approval inbox");
		const disc = inbox.getByTestId("inbox-disclosure");
		// X: the arrival RR-08 kept (RR-08's approved one stays queued behind the held A execution)
		const x = fresh[1] as { taskId: string; req: any };
		const loadMore = inbox.getByTestId("inbox-load-more");
		const shown = (id: string) =>
			inbox.locator(`button[data-request-id="${id}"]`).count();
		let total = 0;
		await until(
			async () => {
				if ((await loadMore.count()) > 0 && (await loadMore.isEnabled()))
					await loadMore.click();
				const m = /Showing (\d+) of (\d+) pending/.exec(
					(await disc.textContent()) ?? "",
				);
				total = Number(m?.[2] ?? 0);
				return (
					!!m &&
					m[1] === m[2] &&
					(await loadMore.count()) === 0 &&
					(await shown(x.req.id)) === 1
				);
			},
			"global inbox loaded to its end with X",
			30_000,
			500,
		);
		const before = (await api(page, "GET", "/snapshot")).body;
		check(before.pending_page.total === total, "snapshot total = displayed");
		let inboxReads = 0;
		const reads = () => inboxReads; // read through a call: `check` narrows a plain variable
		const countInbox = (r: { url(): string }) => {
			if (r.url().includes("/api/workspace/inbox")) inboxReads++;
		};
		page.on("request", countInbox);
		let release!: () => void;
		const barrier = new Promise<void>((r) => {
			release = r;
		});
		const hold = async (route: { continue(): Promise<void> }) => {
			await barrier;
			await route.continue();
		};
		await page.route("**/api/workspace/snapshot", hold);
		await decide(page, x.req, "reject");
		const y = await publish(page, C, "RR C same-total replacement");
		await page.unroute("**/api/workspace/snapshot", hold);
		release();
		const after = (await api(page, "GET", "/snapshot")).body;
		const counts = (s: any) =>
			JSON.stringify(
				s.repo_summaries.map((r: any) => [
					r.repo_id,
					r.pending_requests,
					r.categories.needsApproval,
					r.categories.needsAcceptance,
				]),
			);
		check(after.pending_page.total === total, "same total");
		check(
			after.pending_page.next_cursor === before.pending_page.next_cursor &&
				JSON.stringify(after.pending_requests.map((r: any) => r.id)) ===
					JSON.stringify(before.pending_requests.map((r: any) => r.id)),
			"same first page and cursor",
		);
		check(counts(after) === counts(before), "same per-repository counts");
		await until(
			async () =>
				(await shown(x.req.id)) === 0 &&
				(await loadMore.count()) === 1 &&
				new RegExp(`Showing 500 of ${total} pending`).test(
					(await disc.textContent()) ?? "",
				),
			"X left; Load more offered again",
			20_000,
		);
		check(reads() === 0, `automatic inbox reads: ${reads()}`);
		await loadMore.click();
		await inbox
			.locator(`button[data-request-id="${y.req.id}"]`)
			.waitFor({ timeout: 15_000 });
		check((await shown(x.req.id)) === 0, "X listed again");
		check(
			new RegExp(`Showing ${total} of ${total} pending`).test(
				(await disc.textContent()) ?? "",
			),
			`disclosure "${await disc.textContent()}"`,
		);
		check(reads() === 1, `inbox reads for one Load more: ${reads()}`);
		// what moved: only the hub's membership generation of the global scope
		check(
			after.pending_page.membership_generation !==
				before.pending_page.membership_generation,
			"the membership generation moved",
		);
		page.off("request", countInbox);
		await run.shot(page, "RR09-same-total-replacement-1440");
		return `X rejected elsewhere, Y opened (same repository and gate, total ${total}): X left, Y reached by one Load more`;
	});

	gate.releaseAll();
	run.record(
		"RR-G-console",
		run.consoleErrors.length === 0 && run.dialogs.length === 0
			? "PASS"
			: "FAIL",
		`${run.consoleErrors.length} unexpected console error(s): ${run.consoleErrors.slice(0, 4).join(" | ")}`,
	);
	run.record(
		"RR-G-requests",
		run.blockedOrigins.length === 0 ? "PASS" : "FAIL",
		`${run.blockedOrigins.length} request(s) outside the UI origin`,
	);
	const file = run.writeSummary({
		browser: `Chromium headless shell ${browser.version()}`,
		durationS: Math.round((Date.now() - t0) / 1000),
	});
	console.log(`[REPAIR] summary ${file}`);
	return run.results.some((r) => r.status === "FAIL") ? 1 : 0;
}

let code = 1;
try {
	code = await main();
} catch (err) {
	run.record("setup", "FAIL", String((err as Error).message ?? err));
	run.writeSummary({ fatal: true });
} finally {
	gate.releaseAll();
	await browser?.close().catch(() => undefined);
	await env?.stop().catch(() => undefined);
}
const by = (st: string) => run.results.filter((r) => r.status === st).length;
console.log(
	`[REPAIR] PASS ${by("PASS")} · FAIL ${by("FAIL")} · NOT RUN ${by("NOT RUN")} · evidence ${run.outDir}`,
);
process.exit(code);
