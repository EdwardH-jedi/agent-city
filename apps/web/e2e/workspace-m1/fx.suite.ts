// Role 09 — FX evidence set: the M1 workspace UI on the FIXTURE TRANSPORT (UI fixture, no hub).
//
//   …/iso/run.sh env PLAYWRIGHT_BROWSERS_PATH=/Users/edwardhwang/Library/Caches/ms-playwright \
//     bun --no-env-file apps/web/e2e/workspace-m1/fx.suite.ts
//
// FX proves rendering, local state ownership, layout and accessibility only — never persistence,
// authority, idempotency or server enforcement (MATRIX §6). Vite runs programmatically with
// configFile:false, an empty envDir, a TMPDIR cacheDir, HMR off, NO proxy, serving the root
// index.html with the build-time defines __AGENTCITY_WORKSPACE_UI__ and
// __AGENTCITY_WORKSPACE_FIXTURE__ = "true" (lead ruling R-N1; never a URL parameter). Any
// /api/workspace request is aborted and counted (the fixture must never reach a hub).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { type Browser, chromium, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { freePort } from "../workspace-harness.ts";
import {
	attr,
	bannedWords,
	check,
	composeNew,
	coverageRows,
	criterionGroups,
	decisionStatus,
	dismissAlerts,
	grantButton,
	layout,
	mapCriteria,
	navLink,
	newCtx,
	openRequest,
	openTask,
	planRows,
	Run,
	region,
	sigField,
	sleep,
	stageText,
	submitNew,
	type Traffic,
	taskIdFromUrl,
	textOf,
	typeSignature,
	until,
	waitStage,
} from "./kit.ts";

const ONLY = process.env.M1_ONLY ? new RegExp(process.env.M1_ONLY) : null;
const run = new Run("FX", ONLY);
const WEB_ROOT = resolve(import.meta.dir, "../..");

let browser!: Browser;
let vite = null as ViteDevServer | null;
let origin = "";
const scratch = mkdtempSync(join(tmpdir(), "agentcity-m1-09-fxvite-"));

async function startFx(): Promise<void> {
	const envDir = join(scratch, "empty-env");
	mkdirSync(envDir);
	let port = freePort();
	if (port === 4317) port = freePort();
	check(port !== 4317, "4317");
	vite = await createServer({
		configFile: false,
		root: WEB_ROOT,
		envDir,
		cacheDir: join(scratch, "vite-cache"),
		mode: "development",
		logLevel: "error",
		clearScreen: false,
		plugins: [react()],
		define: {
			__AGENTCITY_WORKSPACE_UI__: "true",
			__AGENTCITY_WORKSPACE_FIXTURE__: "true",
		},
		server: { host: "127.0.0.1", port, strictPort: true, hmr: false },
	});
	await vite.listen();
	origin = `http://127.0.0.1:${port}`;
}

const controls = (page: Page, fn: string, ...args: unknown[]) =>
	page.evaluate(
		async ([f, a]) => {
			const c = (globalThis as Record<string, unknown>)
				.__AGENTCITY_WORKSPACE_FIXTURE_CONTROLS__ as Record<
				string,
				(...x: unknown[]) => unknown
			>;
			return await c[f as string]?.(...(a as unknown[]));
		},
		[fn, args] as const,
	);

interface FxPage {
	page: Page;
	traffic: Traffic;
	close(): Promise<void>;
}

async function fxPage(
	w = 1440,
	h = 900,
	o: { reducedMotion?: "reduce"; b?: Browser } = {},
): Promise<FxPage> {
	const s = await newCtx(run, o.b ?? browser, origin, {
		width: w,
		height: h,
		reducedMotion: o.reducedMotion,
		forbidWorkspaceApi: true,
	});
	await s.page.goto(`${origin}/#/projects`);
	await s.page.getByText(/^Signed in as operator:edward/).waitFor();
	return {
		page: s.page,
		traffic: s.traffic,
		close: () => s.context.close(),
	};
}

async function toResultFx(
	page: Page,
	title: string,
	o: { scenario?: string; repair?: 0 | 1; evidence?: string } = {},
): Promise<string> {
	const id = await submitNew(page, { title, ...o });
	await openRequest(page, "run", title);
	await typeSignature(page, "run");
	await grantButton(page, "run").click();
	await until(
		async () => /Execution approved/.test(await decisionStatus(page)),
		"approved",
	);
	await controls(page, "runToEnd", id, o.evidence ?? "verified");
	await openTask(page, id);
	return id;
}

async function main(): Promise<number> {
	browser = await chromium.launch({ headless: true });
	const version = browser.version();
	await startFx();
	console.log(
		`[FX] chromium ${version}; fixture UI ${origin}; evidence ${run.outDir}`,
	);
	const fx = await fxPage();
	const { page, traffic } = fx;

	await run.case("BRW-J-18", async () => {
		check(
			(await attr(page, "provenance", "data-source")) === "fixture",
			"source",
		);
		check(
			(await textOf(page.getByTestId("provenance"))).includes("UI fixture"),
			"label",
		);
		check(
			(await attr(page, "provenance", "data-mode")) === "simulated",
			"mode",
		);
		return "provenance data-source=fixture, labelled 'UI fixture'";
	});

	let j01 = "";
	await run.case("BRW-J-01", async () => {
		const title = "FX J01 Happy path";
		const crit = [
			"Build passes, lint passes",
			"Docs updated, with one example",
			"No change outside src/, tests/",
		];
		await composeNew(page, { title, criteria: crit.join("\n") });
		await region(page, "Task detail")
			.getByRole("button", { name: "Save draft" })
			.click();
		await until(async () => (await taskIdFromUrl(page)) !== "", "saved");
		j01 = await taskIdFromUrl(page);
		await region(page, "Task detail")
			.getByRole("button", { name: "Submit for run approval" })
			.click();
		await waitStage(page, "Awaiting execution approval");
		await openRequest(page, "run", title);
		const items = await region(page, "Approval document")
			.getByRole("list", { name: "Acceptance criteria" })
			.first()
			.getByRole("listitem")
			.allTextContents();
		check(JSON.stringify(items) === JSON.stringify(crit), "criteria");
		check((await sigField(page, "run").inputValue()) === "", "field not empty");
		await typeSignature(page, "run");
		await sigField(page, "run").press("Enter");
		await sleep(400);
		check(
			(await region(page, "Approval document").getAttribute(
				"data-request-status",
			)) === "pending",
			"Enter decided",
		);
		await grantButton(page, "run").click();
		await until(
			async () => /Execution approved/.test(await decisionStatus(page)),
			"approved",
		);
		await controls(page, "runToEnd", j01, "verified");
		await openTask(page, j01);
		await waitStage(page, "Awaiting acceptance");
		check(
			(await attr(page, "engine-state", "data-state")) === "human_ready",
			"engine",
		);
		check(
			(await attr(page, "acceptance-status", "data-status")) === "pending",
			"acc",
		);
		check(
			(await attr(page, "evidence-status", "data-status")) === "verified",
			"evidence",
		);
		await run.shot(page, "J01-awaiting-acceptance");
		await openRequest(page, "result", title);
		check(
			(await sigField(page, "result").inputValue()) === "",
			"Gate-2 field not empty",
		);
		await typeSignature(page, "result");
		await grantButton(page, "result").click();
		await until(
			async () =>
				(await attr(page, "acceptance-status", "data-status")) === "accepted",
			"accepted",
		);
		check(
			(await attr(page, "engine-state", "data-state")) === "human_ready",
			"engine changed",
		);
		check(!(await bannedWords(page)), "banned word");
		await run.shot(page, "J01-accepted");
		check(traffic.workspaceApiHits === 0, "fixture reached /api/workspace");
		return "fixture journey to accepted; engine stays human_ready; 0 /api/workspace requests";
	});

	await run.case("BRW-J-02", async () => {
		const line300 = `${"alpha, beta; ".repeat(30).slice(0, 299)}z`;
		await composeNew(page, {
			title: "FX J02 Criteria",
			criteria: [
				"a, b and c",
				"  leading spaces",
				"unicode — café, ok",
				"",
				line300,
			].join("\n"),
		});
		await region(page, "Task detail")
			.getByRole("button", { name: "Save draft" })
			.click();
		await until(
			async () =>
				(await region(page, "Task detail")
					.getByRole("list", { name: "Acceptance criteria" })
					.getByRole("listitem")
					.count()) === 4,
			"4 saved",
		);
		const got = await region(page, "Task detail")
			.getByRole("list", { name: "Acceptance criteria" })
			.getByRole("listitem")
			.allTextContents();
		check(
			JSON.stringify(got) ===
				JSON.stringify([
					"a, b and c",
					"leading spaces",
					"unicode — café, ok",
					line300,
				]),
			"criteria",
		);
		return undefined;
	});

	await run.case("BRW-J-04", async () => {
		const t = "FX J04 Request changes";
		const id = await submitNew(page, { title: t });
		await openRequest(page, "run", t);
		const r = region(page, "Approval document").getByLabel("Decision reason");
		await r.click();
		await r.pressSequentially("Narrow it.", { delay: 10 });
		await until(
			async () =>
				region(page, "Approval document")
					.getByRole("button", { name: "Request changes" })
					.isEnabled(),
			"enabled",
		);
		await region(page, "Approval document")
			.getByRole("button", { name: "Request changes" })
			.click();
		await openTask(page, id);
		await waitStage(page, "Changes requested");
		await region(page, "Task detail")
			.getByRole("textbox", { name: "Acceptance criteria" })
			.fill("Narrowed");
		await mapCriteria(page); // v1.2: the edited line is a new criterion (starts unmapped)
		await region(page, "Task detail")
			.getByRole("button", { name: "Submit for run approval" })
			.click();
		await until(
			async () => (await textOf(page.getByTestId("proposal-version"))) === "2",
			"v2",
		);
		return undefined;
	});

	await run.case("BRW-J-05", async () => {
		const t = "FX J05 Reject";
		const id = await submitNew(page, { title: t });
		await openRequest(page, "run", t);
		const r = region(page, "Approval document").getByLabel("Decision reason");
		await r.click();
		await r.pressSequentially("No.", { delay: 10 });
		await until(
			async () =>
				region(page, "Approval document")
					.getByRole("button", { name: "Reject" })
					.isEnabled(),
			"enabled",
		);
		await region(page, "Approval document")
			.getByRole("button", { name: "Reject" })
			.click();
		await openTask(page, id);
		await waitStage(page, "Rejected");
		check(
			(await page.getByTestId("execution-id").count()) === 0,
			"execution id",
		);
		return undefined;
	});

	for (const [id, action] of [
		["BRW-J-06", "Request changes"],
		["BRW-J-07", "Reject"],
	] as const) {
		await run.case(id, async () => {
			const t = `FX ${id} Gate2 ${action}`;
			await toResultFx(page, t);
			await openRequest(page, "result", t);
			const r = region(page, "Approval document").getByLabel("Decision reason");
			await r.click();
			await r.pressSequentially("Because.", { delay: 10 });
			await until(
				async () =>
					region(page, "Approval document")
						.getByRole("button", { name: action, exact: true })
						.isEnabled(),
				"enabled",
			);
			await region(page, "Approval document")
				.getByRole("button", { name: action, exact: true })
				.click();
			const want = action === "Reject" ? "rejected" : "changes_requested";
			await until(
				async () =>
					(await attr(page, "acceptance-status", "data-status")) === want,
				want,
			);
			check(
				(await attr(page, "engine-state", "data-state")) === "human_ready",
				"engine",
			);
			check(!(await bannedWords(page)), "banned word");
			return undefined;
		});
	}

	await run.case("BRW-J-15", async () => {
		const t = "FX J15 Cancel";
		const id = await submitNew(page, { title: t, scenario: "impl_hangs" });
		await openRequest(page, "run", t);
		await typeSignature(page, "run");
		await grantButton(page, "run").click();
		await until(
			async () => /Execution approved/.test(await decisionStatus(page)),
			"approved",
		);
		await controls(page, "advance", id);
		await controls(page, "advance", id);
		await openTask(page, id);
		await region(page, "Task detail")
			.getByRole("button", { name: "Cancel execution" })
			.click();
		await until(
			async () =>
				(await attr(page, "cancellation-status", "data-status")) ===
				"requested",
			"requested",
		);
		check((await stageText(page)) !== "Cancelled", "cancelled before proof");
		await run.shot(page, "J15-requested");
		await controls(page, "confirmCancel", id);
		await until(
			async () =>
				(await attr(page, "cancellation-status", "data-status")) ===
				"confirmed",
			"confirmed",
			8000,
		);
		return "requested rendered with the engine still active; confirmed only after confirmCancel";
	});

	await run.case("BRW-J-12", async () => {
		const t = "FX J12 Missing evidence";
		await toResultFx(page, t, { evidence: "missing" });
		const ev = await attr(page, "evidence-status", "data-status");
		const offered = await region(page, "Task detail")
			.getByRole("button", { name: "Open result acceptance" })
			.count();
		return `fixture evidence=missing → evidence-status=${ev}; result acceptance offered=${offered > 0}`;
	});

	// ── v1.2 criterion ids, mapping and coverage (CONTRACT_V1_2.md §A) ──────────
	await run.case("BRW-C-01", async () => {
		const t = "FX C01 Unmapped";
		await composeNew(page, {
			title: t,
			criteria: "First, with comma\nSecond",
			mapping: [["unit"]],
		});
		const panel = region(page, "Task detail");
		const submit = panel.getByRole("button", {
			name: "Submit for run approval",
		});
		const groups = criterionGroups(page);
		const mapped = await groups.evaluateAll((gs) =>
			gs.map((g) => g.getAttribute("data-mapped")),
		);
		check(
			JSON.stringify(mapped) === '["true","false"]',
			`groups ${JSON.stringify(mapped)}`,
		);
		check(
			await submit.isDisabled(),
			"Submit enabled with criterion 2 unmapped",
		);
		const why = (await panel.locator(".wsm1-why li").allTextContents()).join(
			" | ",
		);
		check(
			why.includes("criterion 2: criterion has no check mapping") &&
				!why.includes("criterion 1:"),
			`reasons ${why}`,
		);
		await run.shot(page, "C01-unmapped-editor");
		await mapCriteria(page, [["unit"], ["lint", "unit"]]);
		check(!(await submit.isDisabled()), "Submit disabled after mapping");
		await submit.click();
		await waitStage(page, "Awaiting execution approval");
		const plan = await planRows(page);
		check(
			plan.length === 2 &&
				plan.every((r) => /^crit-[0-9a-f]{16}$/.test(r.id)) &&
				plan[0]?.checks === "unit" &&
				plan[1]?.checks === "lint unit",
			`plan ${JSON.stringify(plan)}`,
		);
		await openRequest(page, "run", t);
		check(
			JSON.stringify(await planRows(page, "Approval document")) ===
				JSON.stringify(plan),
			"Gate-1 document plan ≠ task plan",
		);
		return `unmapped criterion named, Submit blocked; mapped → Gate 1 plan ${plan.map((p) => p.checks).join(" | ")}`;
	});

	await run.case("BRW-C-02", async () => {
		const t = "FX C02 Coverage";
		await toResultFx(page, t);
		await until(async () => (await coverageRows(page)).length === 2, "rows");
		const rows = await coverageRows(page);
		check(
			rows.every(
				(r) =>
					r.status === "satisfied" &&
					r.checks.every((c) => c.endsWith(":passed:present")),
			),
			`task coverage ${JSON.stringify(rows)}`,
		);
		await region(page, "Task detail")
			.getByTestId("criterion-coverage")
			.first()
			.scrollIntoViewIfNeeded();
		await run.shot(page, "C02-task-coverage");
		await openRequest(page, "result", t);
		check(
			JSON.stringify(await coverageRows(page, "Approval document")) ===
				JSON.stringify(rows),
			"Gate-2 coverage ≠ task coverage",
		);
		await region(page, "Approval document")
			.getByTestId("criterion-coverage")
			.first()
			.scrollIntoViewIfNeeded();
		await run.shot(page, "C02-gate2-coverage");
		return `${rows.length} criteria satisfied with log evidence in the task detail and the Gate-2 document`;
	});

	await run.case("BRW-C-03", async () => {
		// fixture-only evidence: the last check sealed as failed (the real engine never seals it)
		const t = "FX C03 Failing check";
		await toResultFx(page, t, { evidence: "check_failed" });
		await until(async () => (await coverageRows(page)).length === 2, "rows");
		const rows = await coverageRows(page);
		const statuses = rows.map((r) => r.status);
		check(
			JSON.stringify(statuses) === '["unsatisfied","unsatisfied"]',
			`statuses ${JSON.stringify(statuses)}`,
		);
		check(
			rows.every((r) => r.checks.some((c) => c.includes(":failed:"))),
			"failed check not shown per criterion",
		);
		check(
			(await region(page, "Task detail")
				.getByRole("button", { name: "Open result acceptance" })
				.count()) === 0,
			"acceptance offered",
		);
		check(
			(await attr(page, "acceptance-status", "data-status")) === "invalidated",
			"result request not invalidated",
		);
		await region(page, "Task detail")
			.getByTestId("criterion-coverage")
			.first()
			.scrollIntoViewIfNeeded();
		await run.shot(page, "C03-unsatisfied");
		return "failed check → every criterion mapped to it unsatisfied; result invalidated; no acceptance";
	});

	await run.case("BRW-C-04", async () => {
		const t = "FX C04 Revision ids";
		const lines = ["Keeps the flags", "Docs mention it", "No new dependency"];
		const id = await submitNew(page, { title: t, criteria: lines.join("\n") });
		const before = await planRows(page);
		await openRequest(page, "run", t);
		const r = region(page, "Approval document").getByLabel("Decision reason");
		await r.click();
		await r.pressSequentially("Be precise.", { delay: 5 });
		await region(page, "Approval document")
			.getByRole("button", { name: "Request changes" })
			.click();
		await openTask(page, id);
		await waitStage(page, "Changes requested");
		await region(page, "Task detail")
			.getByRole("textbox", { name: "Acceptance criteria" })
			.fill(
				[lines[0], "Docs mention it, with one example", lines[2]].join("\n"),
			);
		await mapCriteria(page);
		await region(page, "Task detail")
			.getByRole("button", { name: "Submit for run approval" })
			.click();
		await until(
			async () => (await textOf(page.getByTestId("proposal-version"))) === "2",
			"v2",
		);
		const after = await planRows(page);
		const a = before.map((x) => x.id);
		const b = after.map((x) => x.id);
		check(
			a[0] === b[0] && a[2] === b[2] && a[1] !== b[1] && b.length === 3,
			`ids ${JSON.stringify(a)} → ${JSON.stringify(b)}`,
		);
		return "only the edited criterion got a new id";
	});

	await run.case("BRW-C-05", async () => {
		await controls(page, "setLegacyContract", true);
		try {
			// today a legacy Gate 1 is refused (hub obsolete-v1 policy, mirrored by the fixture)
			const r = "FX C05 Legacy grant refused";
			await submitNew(page, { title: r });
			await openRequest(page, "run", r);
			const note = region(page, "Approval document").getByTestId(
				"obsolete-grant",
			);
			check(
				(await note.getAttribute("data-status")) === "pending",
				"pending obsolete grant not stated",
			);
			check(
				await grantButton(page, "run").isDisabled(),
				"Approve enabled for an obsolete grant",
			);
			// the first keystroke asks for the approval window → 409 → retired → re-read
			await sigField(page, "run").pressSequentially("E", { delay: 15 });
			await until(
				async () => (await note.getAttribute("data-status")) === "retired",
				"obsolete grant retired",
			);
			check(
				(await grantButton(page, "run").count()) === 0,
				"a decision control remains on the retired grant",
			);
			// a legacy RESULT exists only from pre-policy history
			const t = "FX C05 Legacy proposal";
			const id = await submitNew(page, { title: t });
			await controls(page, "runLegacyBeforePolicy", id, "verified");
			await openTask(page, id);
			const plan = region(page, "Task detail").getByTestId("criteria-plan");
			check(
				(await plan.getAttribute("data-status")) === "legacy",
				"legacy proposal not labelled",
			);
			const cov = region(page, "Task detail").getByTestId("criterion-coverage");
			check(
				(await cov.getAttribute("data-status")) === "legacy" &&
					((await cov.textContent()) ?? "").includes(
						"No criterion coverage — a new proposal and approval are required.",
					),
				"legacy result coverage not stated",
			);
			check(
				(await cov.locator("[data-criterion-id]").count()) === 0,
				"coverage invented for a legacy result",
			);
			check(
				(await region(page, "Task detail")
					.getByRole("button", { name: "Open result acceptance" })
					.count()) === 0,
				"legacy result offered for acceptance",
			);
			await region(page, "Task detail")
				.getByTestId("criterion-coverage")
				.first()
				.scrollIntoViewIfNeeded();
			await run.shot(page, "C05-legacy");
		} finally {
			await controls(page, "setLegacyContract", false);
		}
		return "legacy v1 proposal + result: 'no criterion coverage', nothing invented, not acceptable";
	});

	await run.case("BRW-J-17", async () => {
		const ids = (await controls(page, "seedDemo")) as Record<string, string>;
		const bad: string[] = [];
		for (const [k, id] of Object.entries(ids)) {
			await openTask(page, id);
			const w = await bannedWords(page);
			if (w) bad.push(`${k}:${w}`);
		}
		await navLink(page, /^Head/).click();
		const items = region(page, "Approval inbox").locator(
			"button[data-request-id]",
		);
		for (let i = 0; i < (await items.count()); i++) {
			await items.nth(i).click();
			await region(page, "Approval document").waitFor();
			const w = await bannedWords(page);
			if (w) bad.push(`inbox#${i}:${w}`);
		}
		check(bad.length === 0, bad.join(", "));
		return `${Object.keys(ids).length} seeded states + every inbox document: no merge/push/deploy wording`;
	});

	await run.case("BRW-J-19", async () => {
		await navLink(page, /^Head/).click();
		const n = await region(page, "Approval inbox")
			.locator("button[data-request-id]")
			.count();
		const c = Number(await textOf(page.getByTestId("hq-pending-count")));
		check(n === c, `inbox ${n} vs count ${c}`);
		return `inbox items = pending count = ${n}`;
	});

	await run.case("BRW-R-17", async () => {
		const t = "FX R17 Enter";
		await submitNew(page, { title: t });
		await openRequest(page, "run", t);
		await typeSignature(page, "run");
		for (const k of ["Enter", "Control+Enter", "Meta+Enter", "Shift+Enter"])
			await sigField(page, "run").press(k);
		await sleep(500);
		check(
			(await region(page, "Approval document").getAttribute(
				"data-request-status",
			)) === "pending",
			"decided by a key",
		);
		return undefined;
	});

	await run.case("BRW-R-18", async () => {
		await openRequest(page, "run", "FX R17 Enter");
		const bad: string[] = [];
		for (const v of [
			"edward",
			"EDWARD",
			" Edward",
			"Edward ",
			"Edwards",
			"Edward\t",
		]) {
			await sigField(page, "run").fill(v);
			await sleep(300);
			if (await grantButton(page, "run").isEnabled())
				bad.push(JSON.stringify(v));
		}
		check(bad.length === 0, `enabled for ${bad.join(" ")}`);
		return undefined;
	});

	await run.case("BRW-R-19", async () => {
		const t2 = "FX R19 Other";
		await submitNew(page, { title: t2 });
		await openRequest(page, "run", "FX R17 Enter");
		await typeSignature(page, "run");
		await openRequest(page, "run", t2);
		check(
			(await sigField(page, "run").inputValue()) === "",
			"kept on subject change",
		);
		await openRequest(page, "run", "FX R17 Enter");
		check((await sigField(page, "run").inputValue()) === "", "restored");
		return undefined;
	});

	await run.case("BRW-R-21", async () => {
		// the fixture control expires challenges on the fixture "server"; the UI learns it when it
		// tries to decide (challenge_invalid) — the signature must be cleared and nothing decided
		await openRequest(page, "run", "FX R19 Other");
		await typeSignature(page, "run");
		await controls(page, "expireChallenges");
		await dismissAlerts(page);
		await grantButton(page, "run").click();
		await until(
			async () => (await sigField(page, "run").inputValue()) === "",
			"cleared after the expired challenge was refused",
			5000,
		);
		check(
			(await region(page, "Approval document").getAttribute(
				"data-request-status",
			)) === "pending",
			"decided with an expired challenge",
		);
		check(
			!(await grantButton(page, "run").isEnabled()),
			"enabled after expiry",
		);
		const al = (await page.getByRole("main").getByRole("alert").count())
			? await textOf(page.getByRole("main").getByRole("alert"))
			: "";
		await dismissAlerts(page);
		return `expired challenge refused; field cleared; alert "${al.slice(0, 70)}" (real TTL expiry: HUB R-21)`;
	});

	await run.case("BRW-R-20", async () => {
		await openRequest(page, "run", "FX R19 Other");
		await typeSignature(page, "run");
		await controls(page, "setDecisionFault", "lose_response_after_commit");
		await dismissAlerts(page);
		await grantButton(page, "run").click();
		await sleep(800);
		const st = await decisionStatus(page);
		const field = (await sigField(page, "run").count())
			? await sigField(page, "run").inputValue()
			: "";
		await controls(page, "setDecisionFault", null);
		check(field === "", "signature kept after an unknown outcome");
		return `outcome-unknown fault → status "${st.slice(0, 60)}", field empty`;
	});

	await run.case("BRW-R-22", async () => {
		const t = "FX R22 Success clears";
		await submitNew(page, { title: t });
		await openRequest(page, "run", t);
		await typeSignature(page, "run");
		await grantButton(page, "run").click();
		await until(
			async () => /Execution approved/.test(await decisionStatus(page)),
			"approved",
		);
		check((await sigField(page, "run").count()) === 0, "controls remain");
		await openRequest(page, "run", "FX R17 Enter");
		check((await sigField(page, "run").inputValue()) === "", "next not empty");
		return undefined;
	});

	await run.case("BRW-R-15", async () => {
		const t = "FX R15 Double";
		const id = await submitNew(page, { title: t });
		await openRequest(page, "run", t);
		await typeSignature(page, "run");
		await grantButton(page, "run").dblclick();
		await until(
			async () => /Execution approved/.test(await decisionStatus(page)),
			"approved",
		);
		await openTask(page, id);
		const rec = await region(page, "Task detail")
			.locator("li[data-request-id]")
			.allTextContents();
		check(
			rec.filter((x) => /Approved/.test(x)).length === 1,
			`record ${rec.join(" | ")}`,
		);
		return "one approval recorded after a double click (fixture)";
	});

	await run.case("BRW-A-07", async () => {
		const r = (await page.evaluate(() => ({
			banner: document.querySelectorAll("body header").length,
			nav: document.querySelectorAll('nav[aria-label="Primary"]').length,
			main: document.querySelectorAll("main").length,
			unnamed: (
				Array.from(
					document.querySelectorAll("input, textarea, select"),
				) as HTMLInputElement[]
			).filter(
				(e) =>
					!(e.labels?.[0]?.textContent?.trim() || e.getAttribute("aria-label")),
			).length,
		}))) as { banner: number; nav: number; main: number; unnamed: number };
		check(r.banner === 1 && r.nav === 1 && r.main === 1, JSON.stringify(r));
		check(r.unnamed === 0, `${r.unnamed} unnamed fields`);
		return undefined;
	});

	for (const [w, h] of [
		[1440, 900],
		[1280, 800],
	] as const) {
		const id = w === 1440 ? "BRW-A-09" : "BRW-A-10";
		await run.case(id, async () => {
			const v = await fxPage(w, h);
			run.viewport = `${w}x${h}`;
			const ids = (await controls(v.page, "seedDemo")) as Record<
				string,
				string
			>;
			const out: string[] = [];
			for (const [k, tid] of Object.entries(ids)) {
				await openTask(v.page, tid);
				const l = await layout(v.page);
				if (l.overflowX || !l.footInView)
					out.push(`${k}: overflow=${l.overflowX} foot=${l.footInView}`);
				if (k.includes("long") || k.includes("gate"))
					await run.shot(v.page, `${id}-${k}`);
			}
			await v.close();
			run.viewport = "1440x900";
			check(out.length === 0, out.join("; "));
			return `${Object.keys(ids).length} seeded states: no overflow, footer in view`;
		});
	}

	await run.case("BRW-A-13", async () => {
		const v = await fxPage(1440, 900, { reducedMotion: "reduce" });
		run.flags = "reducedMotion=reduce";
		await controls(v.page, "seedDemo");
		const n = (await v.page.evaluate(
			() => document.getAnimations().length,
		)) as number;
		await v.close();
		run.flags = "";
		check(n === 0, `${n} animations`);
		return "0 animations with reduced motion";
	});

	await run.case("BRW-A-14", async () => {
		const b2 = await chromium.launch({
			headless: true,
			args: ["--disable-3d-apis", "--disable-webgl", "--disable-webgl2"],
		});
		try {
			const v = await fxPage(1440, 900, { b: b2 });
			run.flags = "webgl=disabled";
			const off = (await v.page.evaluate(
				() =>
					document.createElement("canvas").getContext("webgl") === null &&
					document.createElement("canvas").getContext("webgl2") === null,
			)) as boolean;
			check(off, "WebGL available");
			await toResultFx(v.page, "FX A14 No WebGL");
			await waitStage(v.page, "Awaiting acceptance");
			await v.close();
			return "WebGL null proven in-page; fixture journey to awaiting acceptance";
		} finally {
			run.flags = "";
			await b2.close().catch(() => undefined);
		}
	});

	for (const id of [
		"BRW-J-03",
		"BRW-J-08",
		"BRW-J-09",
		"BRW-J-10",
		"BRW-J-11",
		"BRW-J-13",
		"BRW-J-16",
		"BRW-J-20",
		"BRW-J-21",
		"BRW-J-22",
		"BRW-R-05",
		"BRW-R-08",
		"BRW-R-09",
		"BRW-A-01",
		"BRW-A-02",
		"BRW-A-03",
		"BRW-A-04",
		"BRW-A-05",
		"BRW-A-06",
		"BRW-A-08",
		"BRW-A-11",
		"BRW-A-12",
		"BRW-A-15",
		"BRW-A-16",
	])
		run.notRun(
			id,
			"FX optional for this case; HUB set decides (run time kept for HUB-decided cases)",
		);

	check(traffic.workspaceApiHits === 0, "fixture reached the hub API");
	await fx.close();
	run.record(
		"G-1",
		run.blockedOrigins.length === 0 ? "PASS" : "FAIL",
		`${run.blockedOrigins.length} request(s) outside the UI origin; /api/workspace hits ${traffic.workspaceApiHits}`,
	);
	run.record(
		"G-2",
		run.consoleErrors.length === 0 ? "PASS" : "FAIL",
		`${run.consoleErrors.length} console error(s) ${run.consoleErrors.slice(0, 3).join(" | ")}`,
	);
	const file = run.writeSummary({
		browser: `Chromium headless shell ${version}`,
		origin: "http://127.0.0.1:<free port>",
	});
	console.log(`[FX] summary ${file}`);
	return run.results.some((r) => r.status === "FAIL") ? 1 : 0;
}

let code = 1;
try {
	code = await main();
} catch (err) {
	run.record("setup", "FAIL", String((err as Error).message ?? err));
	run.writeSummary({ fatal: true });
} finally {
	await browser?.close().catch(() => undefined);
	await vite?.close().catch(() => undefined);
	rmSync(scratch, { recursive: true, force: true });
}
const by = (st: string) => run.results.filter((r) => r.status === st).length;
console.log(
	`[FX] PASS ${by("PASS")} · FAIL ${by("FAIL")} · NOT RUN ${by("NOT RUN")} · evidence ${run.outDir}`,
);
process.exit(code);
