// Role 09 — HUB evidence set: the M1 workspace UI against the ISOLATED REAL TEST HUB.
//
//   …/iso/run.sh env PLAYWRIGHT_BROWSERS_PATH=/Users/edwardhwang/Library/Caches/ms-playwright \
//     bun --no-env-file apps/web/e2e/workspace-m1/hub.suite.ts        [M1_ONLY=<regex of case ids>]
//
// Isolation: the lead harness (`../workspace-harness.ts`) runs the real hub in THIS process in
// workspace mode on a free 127.0.0.1 port (never 4317) over a temp SQLite file and a disposable
// fixture repo, simulated only (fake providers), with per-run synthetic credentials; Vite runs with
// configFile:false, an empty envDir and a TMPDIR cacheDir, proxying only to this hub; the hub's
// allowed origin is exactly the Vite origin. Chromium = cached Playwright headless shell, fresh
// contexts. Tamper/fault setup touches only files under env.fx (the fixture directory). Every
// browser request outside the UI origin is aborted and counted (G-1).

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import {
	type Browser,
	type BrowserContext,
	chromium,
	type Page,
	type Route,
} from "playwright-core";
import { startWorkspaceEnv, type WorkspaceEnv } from "../workspace-harness.ts";
import {
	approveRun,
	attachPage,
	attr,
	bannedWords,
	check,
	composeNew,
	coverageRows,
	criterionGroups,
	dbAll,
	dbOne,
	decisionStatus,
	dismissAlerts,
	escapeRe,
	GATE_NAME,
	type Gate,
	grantButton,
	layout,
	leakedSecrets,
	mapCriteria,
	navLink,
	newCtx,
	openRequest,
	openTask,
	planRows,
	Run,
	randomAlnum,
	region,
	secretPatternHits,
	selectRepo,
	sigField,
	signIn,
	sleep,
	stageText,
	storageDump,
	submitNew,
	type Traffic,
	taskIdFromUrl,
	textOf,
	typeSignature,
	until,
	waitEngine,
	waitStage,
} from "./kit.ts";

const ONLY = process.env.M1_ONLY ? new RegExp(process.env.M1_ONLY) : null;
const run = new Run("HUB", ONLY);

// Canary (S-05): a secret-shaped value built at runtime, printed by the fixture's trusted
// verification command (the command text holds it split, so the argv itself does not match).
const CANARY_SUFFIX = randomAlnum(36);
const CANARY = ["gh", "p_", CANARY_SUFFIX].join("");
run.secrets.add(CANARY);
const PROPOSAL_CANARY = ["gh", "p_", randomAlnum(36)].join("");
run.secrets.add(PROPOSAL_CANARY);

// slow, content-rich verification: makes "Verifying" observable at the UI's 2 s poll, and puts
// inert-rendering canaries (HTML, ANSI, a 5,000-char line, a secret-shaped value) into the log
const VERIFY_SCRIPT = [
	"sleep 2.5",
	"printf '%s\\n' '<img src=x onerror=alert(1)>' '<script>alert(2)</script>'",
	"printf '\\033[31mansi-red\\033[0m\\n'",
	`printf 'gh''p_%s\\n' '${CANARY_SUFFIX}'`,
	// shell builtins only (the verification child's PATH is minimal): 2^12 = 4096 x's
	's=x; i=0; while [ $i -lt 12 ]; do s="$s$s"; i=$((i+1)); done; printf \'%s\\n\' "$s"',
	'i=0; while [ $i -lt 80 ]; do echo "log line $i"; i=$((i+1)); done',
	"exec /bin/sh verify.sh",
].join("\n");

interface Session {
	context: BrowserContext;
	page: Page;
	traffic: Traffic;
}

let env!: WorkspaceEnv;
/** Traffic of the R-06 session, which deliberately provokes the auth-generation race. */
const r06Traffic = new Set<Traffic>();
let browser!: Browser;
const sessions: Session[] = [];
const challenges = new Map<
	string,
	{ challenge: string; request_rev: number; binding_hash: string }
>();
const observed = {
	taskStatusTexts: new Set<string>(),
	decisionStatusTexts: new Set<string>(),
	alertNext: false,
	offlineShown: false,
};

function trackChallenges(page: Page) {
	page.on("response", async (r) => {
		const u = new URL(r.url());
		const m = /\/approval-requests\/(wsa-[0-9a-f-]{36})\/challenge$/.exec(
			u.pathname,
		);
		if (!m || r.status() !== 201) return;
		try {
			const j = (await r.json()) as {
				challenge: string;
				request_rev: number;
				binding_hash: string;
			};
			run.secrets.add(j.challenge);
			challenges.set(m[1] ?? "", j);
		} catch {
			// body unavailable (page closed) — ignore
		}
	});
}

async function captureSessionSecrets(s: Session) {
	for (const c of await s.context.cookies()) run.secrets.add(c.value);
	const csrf = (await s.page.evaluate(async () => {
		const r = await fetch("/api/workspace/session", {
			credentials: "same-origin",
		});
		const j = (await r.json().catch(() => null)) as {
			csrf_token?: string;
		} | null;
		return j?.csrf_token ?? null;
	})) as string | null;
	if (csrf) run.secrets.add(csrf);
}

async function open(
	w = 1440,
	h = 900,
	o: { reducedMotion?: "reduce"; signIn?: boolean; b?: Browser } = {},
): Promise<Session> {
	const s = await newCtx(run, o.b ?? browser, env.uiUrl, {
		width: w,
		height: h,
		reducedMotion: o.reducedMotion,
	});
	trackChallenges(s.page);
	await s.page.goto(`${env.uiUrl}/#/projects`);
	if (o.signIn !== false) {
		await signIn(s.page, env.credential);
		await captureSessionSecrets(s);
	}
	sessions.push(s);
	return s;
}

async function close(s: Session) {
	try {
		const out = s.page.getByRole("button", { name: "Sign out" });
		if ((await out.count()) > 0) await out.click();
		await sleep(150);
	} catch {
		// already gone
	}
	await s.context.close().catch(() => undefined);
}

const db = (sql: string, ...p: (string | number | null)[]) =>
	dbAll(env.fx.dbPath, sql, ...p);
const db1 = <T = Record<string, unknown>>(
	sql: string,
	...p: (string | number | null)[]
) => dbOne<T>(env.fx.dbPath, sql, ...p);

function taskRow(id: string) {
	return db1<{
		stage: string;
		rev: number;
		current_managed_task_id: string | null;
		accepted_decision_id: string | null;
		draft: string;
	}>(
		"SELECT stage, rev, current_managed_task_id, accepted_decision_id, draft FROM workspace_tasks WHERE id = ?",
		id,
	);
}
const reqs = (taskId: string) =>
	db(
		"SELECT id, kind, status, invalidation_reason, managed_task_id, run_id, rev, binding_hash FROM managed_approval_requests WHERE workspace_task_id = ? ORDER BY created_at",
		taskId,
	) as {
		id: string;
		kind: string;
		status: string;
		invalidation_reason: string | null;
		managed_task_id: string;
		run_id: string | null;
		rev: number;
		binding_hash: string;
	}[];
const decisionsFor = (requestId: string) =>
	(
		db1<{ n: number }>(
			"SELECT count(*) AS n FROM managed_decisions WHERE approval_request_id = ?",
			requestId,
		) ?? { n: -1 }
	).n;
const approvedRuns = (taskId: string) =>
	reqs(taskId).filter((r) => r.kind === "run" && r.status === "approved")
		.length;
const runsOf = (managedTaskId: string) =>
	db(
		"SELECT id, attempt_no, kind, candidate_sha, provider, mode FROM managed_runs WHERE task_id = ? ORDER BY attempt_no",
		managedTaskId,
	) as {
		id: string;
		attempt_no: number;
		kind: string;
		candidate_sha: string | null;
		provider: string;
		mode: string;
	}[];
const managedState = (id: string) =>
	db1<{ state: string }>("SELECT state FROM managed_tasks WHERE id = ?", id)
		?.state ?? null;
const artifactsOf = (managedTaskId: string) =>
	db(
		"SELECT id, kind, name, rel_path, sha256, byte_len, truncated, run_id FROM managed_artifacts WHERE task_id = ? ORDER BY created_at",
		managedTaskId,
	) as {
		id: string;
		kind: string;
		name: string;
		rel_path: string;
		sha256: string;
		byte_len: number;
		truncated: number;
		run_id: string;
	}[];

async function posts(t: Traffic, requestId: string, since = 0) {
	return t.decisionPosts.filter(
		(p) => p.url.includes(requestId) && p.at >= since,
	);
}

async function noMorePosts(t: Traffic, requestId: string, since: number) {
	await sleep(900);
	return (await posts(t, requestId, since)).length;
}

/** Submit, approve, follow the engine, wait for the Gate-2 request. Returns the task id. */
async function toResult(
	s: Session,
	title: string,
	o: { scenario?: string; repair?: 0 | 1 } = {},
): Promise<string> {
	const id = await submitNew(s.page, { title, ...o });
	await approveRun(s.page, title);
	await openTask(s.page, id);
	await waitEngine(s.page, ["human_ready", "failed", "blocked"], 90_000);
	await waitStage(s.page, "Awaiting acceptance", 30_000);
	return id;
}

async function toEngineEnd(
	s: Session,
	title: string,
	o: { scenario?: string; repair?: 0 | 1; allowed?: string },
): Promise<{ id: string; state: string; seen: string[] }> {
	const id = await submitNew(s.page, { title, ...o });
	await approveRun(s.page, title);
	await openTask(s.page, id);
	const seen: string[] = [];
	let state = "";
	await until(
		async () => {
			const st = await stageText(s.page);
			if (st && seen.at(-1) !== st) seen.push(st);
			state = (await attr(s.page, "engine-state", "data-state")) ?? "";
			return [
				"human_ready",
				"failed",
				"blocked",
				"cancelled",
				"interrupted",
			].includes(state);
		},
		`${title} engine end`,
		90_000,
		250,
	);
	await sleep(2500); // let the workspace stage reconcile
	const st = await stageText(s.page);
	if (st && seen.at(-1) !== st) seen.push(st);
	return { id, state, seen };
}

async function typeReason(page: Page, text: string) {
	const f = region(page, "Approval document").getByLabel("Decision reason");
	await f.click();
	await f.pressSequentially(text, { delay: 10 });
	await until(
		async () =>
			region(page, "Approval document")
				.getByRole("button", { name: "Reject", exact: true })
				.isEnabled(),
		"decline enabled",
	);
}

async function decline(page: Page, action: "Request changes" | "Reject") {
	await region(page, "Approval document")
		.getByRole("button", { name: action, exact: true })
		.click();
}

async function inboxNames(page: Page): Promise<string[]> {
	await navLink(page, /^Head/).click();
	const inbox = region(page, "Approval inbox");
	await inbox.waitFor();
	return (await inbox.locator("button[data-request-id]").allTextContents()).map(
		(t) => t.trim(),
	);
}

async function pendingCount(page: Page): Promise<number> {
	return Number(await textOf(page.getByTestId("hq-pending-count")));
}

const pendingInDb = () =>
	(
		db1<{ n: number }>(
			"SELECT count(*) AS n FROM managed_approval_requests WHERE status = 'pending'",
		) ?? { n: -1 }
	).n;

async function criteriaItems(page: Page, scope = "Task detail") {
	return (
		await region(page, scope)
			.getByRole("list", { name: "Acceptance criteria" })
			.first()
			.getByRole("listitem")
			.allTextContents()
	).map((t) => t);
}

/** The task's current proposal snapshot from the DB (canonical JSON column). */
function proposalSnapshotOf(taskId: string) {
	const row = db1<{ snapshot: string }>(
		"SELECT p.snapshot FROM managed_proposals p JOIN workspace_tasks t ON t.current_proposal_id = p.id WHERE t.id = ?",
		taskId,
	);
	return row
		? (JSON.parse(row.snapshot) as {
				contract: string;
				version: number;
				criteria: { id: string; text: string }[];
				coverage_plan?: { criterion_id: string; checks: string[] }[];
			})
		: null;
}

async function evidenceViewerOpen(page: Page, name: string) {
	const d = page.getByRole("dialog", { name: `Evidence: ${name}` });
	await d.waitFor();
	await until(
		async () => (await d.getAttribute("data-state")) !== "loading",
		`viewer ${name} loaded`,
	);
	return d;
}

function flipByte(path: string) {
	const buf = readFileSync(path);
	buf[0] = (buf[0] ?? 0) ^ 0x01;
	writeFileSync(path, buf);
}

// ── sections ────────────────────────────────────────────────────────────────

async function sessionCases(): Promise<void> {
	await run.case("BRW-J-20", async () => {
		const s = await open(1440, 900, { signIn: false });
		const page = s.page;
		await page.getByRole("heading", { name: "Operator sign-in" }).waitFor();
		await page
			.getByLabel("Operator credential")
			.fill(`wrong-credential-${randomAlnum(16)}`);
		await page.getByRole("button", { name: "Sign in" }).click();
		const alert = page.getByRole("main").getByRole("alert");
		await alert.waitFor();
		check(
			(await region(page, "Repositories").count()) === 0,
			"data rendered after a wrong credential",
		);
		check(
			(await page.getByTestId("hq-pending-count").count()) === 0,
			"pending count rendered after a wrong credential",
		);
		await signIn(page, env.credential);
		await captureSessionSecrets(s);
		const cookies = await s.context.cookies();
		const sc = cookies.find((c) => c.name === "agentcity_ws_session");
		check(sc, "no session cookie stored");
		check(sc.httpOnly, "cookie not HttpOnly");
		check(sc.sameSite === "Strict", `sameSite=${sc.sameSite}`);
		run.notes.push(
			`J-20/S-01 cookie: name=agentcity_ws_session httpOnly=${sc.httpOnly} sameSite=${sc.sameSite} secure=${sc.secure} path=${sc.path} (value never printed)`,
		);
		const leaked = await leakedSecrets(page, run.secrets);
		check(leaked.length === 0, `secret visible: ${leaked.join(",")}`);
		const st = await storageDump(page);
		check(
			st.local.length + st.session.length === 0,
			`browser storage not empty: ${JSON.stringify(st)}`,
		);
		// unsaved work + sign out → purge
		await composeNew(page, { title: "J20 unsent draft" });
		await page.getByRole("button", { name: "Sign out" }).click();
		await page.getByRole("heading", { name: "Operator sign-in" }).waitFor();
		check(
			(await region(page, "Task detail").count()) === 0,
			"task panel survived sign-out",
		);
		check(
			!(await page.content()).includes("J20 unsent draft"),
			"unsent draft survived sign-out",
		);
		await signIn(page, env.credential);
		await captureSessionSecrets(s);
		check(
			!(await page.content()).includes("J20 unsent draft"),
			"unsent draft restored after sign-in",
		);
		await run.shot(page, "J20-signed-in");
		await close(s);
		return `cookie httpOnly=${sc.httpOnly} sameSite=${sc.sameSite} secure=${sc.secure} path=${sc.path}; storage keys ${st.local.length + st.session.length}; IndexedDB ${st.idb.length}`;
	});
}

let J01: { id: string; title: string; managed: string } | null = null;

async function happyPath(): Promise<void> {
	if (!run.wants("BRW-J-01") && !run.wants("BRW-J-16")) return;
	const s = await open();
	const { page, traffic } = s;
	const title = "J01 Happy path";
	const crit3 = [
		"Build passes, lint passes",
		"Docs updated, with one example",
		"No change outside src/, tests/",
	];
	let id = "";
	let pendingBefore = 0;
	let reqRun = "";
	const sub = (c: string, fn: () => Promise<string | undefined>) =>
		run.case(`BRW-J-01.${c}`, fn);

	await sub("C1", async () => {
		await until(
			async () => (await attr(page, "provenance", "data-source")) === "hub",
			"provenance hub",
		);
		check(
			(await attr(page, "provenance", "data-mode")) === "simulated",
			"mode not simulated",
		);
		check(
			(await attr(page, "provenance", "data-integration")) === "unverified",
			"integration not unverified",
		);
		const conn = await textOf(page.getByRole("status", { name: "Connection" }));
		check(/^Online · last confirmed/.test(conn), `connection: ${conn}`);
		return conn.replace(/\d\d:\d\d:\d\d/, "hh:mm:ss");
	});
	await sub("C2", async () => {
		const t0 = Date.now();
		await selectRepo(page, env.repoId);
		const b = region(page, "Repositories").getByRole("button", {
			name: new RegExp(escapeRe(env.repoId)),
		});
		check(
			(await b.getAttribute("aria-current")) === "true",
			"repo not aria-current",
		);
		return `workspace opened in ${Date.now() - t0} ms`;
	});
	await sub("C3", async () => {
		pendingBefore = await pendingCount(page);
		await page.getByRole("button", { name: "Assign work" }).click();
		const panel = region(page, "Task detail");
		await panel.getByLabel("Title", { exact: true }).fill(title);
		await panel
			.getByLabel("Objective", { exact: true })
			.fill("Add one small fixture change.");
		const ta = panel.getByRole("textbox", { name: "Acceptance criteria" });
		await ta.fill(crit3.join("\n"));
		check(
			(await ta.inputValue()) === crit3.join("\n"),
			"criteria textarea lost newlines",
		);
		// v1.2: one check group per criterion line, nothing preselected, Submit blocked until mapped
		const groups = criterionGroups(page);
		await until(async () => (await groups.count()) === 3, "3 check groups");
		for (let i = 0; i < 3; i++)
			check(
				(await groups.nth(i).getAttribute("data-mapped")) === "false",
				`criterion ${i + 1} preselected`,
			);
		check(
			await panel
				.getByRole("button", { name: "Submit for run approval" })
				.isDisabled(),
			"Submit enabled with unmapped criteria",
		);
		const why = (await panel.locator(".wsm1-why li").allTextContents()).join(
			" | ",
		);
		for (const n of [1, 2, 3])
			check(
				why.includes(`criterion ${n}: criterion has no check mapping`),
				`unmapped criterion ${n} not named: ${why.slice(0, 200)}`,
			);
		await mapCriteria(page);
		check(
			!(await panel
				.getByRole("button", { name: "Submit for run approval" })
				.isDisabled()),
			"Submit still disabled after mapping",
		);
		check(
			await panel
				.getByRole("radio", { name: "No automatic repair" })
				.isChecked(),
			"repair default is not 'No automatic repair'",
		);
		await run.shot(page, "J01-C3-draft");
		return undefined;
	});
	await sub("C4", async () => {
		await region(page, "Task detail")
			.getByRole("button", { name: "Save draft" })
			.click();
		await until(
			async () =>
				(await textOf(page.getByRole("status", { name: "Save status" }))) ===
				"Draft saved",
			"Draft saved",
		);
		await until(async () => (await taskIdFromUrl(page)) !== "", "task id");
		id = await taskIdFromUrl(page);
		await until(
			async () => (await criteriaItems(page)).length === 3,
			"3 saved criteria",
		);
		const items = await criteriaItems(page);
		check(
			JSON.stringify(items) === JSON.stringify(crit3),
			`criteria ${JSON.stringify(items)}`,
		);
		return undefined;
	});
	const crit4 = [...crit3, "Changelog entry added, dated"];
	await sub("C5", async () => {
		const panel = region(page, "Task detail");
		await panel
			.getByLabel("Objective", { exact: true })
			.fill("Add one small fixture change, then document it.");
		await panel
			.getByRole("textbox", { name: "Acceptance criteria" })
			.fill(crit4.join("\n"));
		// keyed by exact text: the 3 unchanged lines keep their checks, the new line starts unmapped
		const groups = criterionGroups(page);
		await until(async () => (await groups.count()) === 4, "4 check groups");
		const mappedNow = await Promise.all(
			[0, 1, 2, 3].map((i) => groups.nth(i).getAttribute("data-mapped")),
		);
		check(
			JSON.stringify(mappedNow) === '["true","true","true","false"]',
			`mapping after adding a line: ${JSON.stringify(mappedNow)}`,
		);
		await mapCriteria(page);
		await panel.getByRole("button", { name: "Save draft" }).click();
		await until(
			async () =>
				(await textOf(page.getByRole("status", { name: "Save status" }))) ===
				"Draft saved",
			"Draft saved (edit)",
		);
		await page.reload();
		await page
			.locator(`section[aria-label="Task detail"][data-task-id="${id}"]`)
			.waitFor();
		await until(
			async () => (await criteriaItems(page)).length === 4,
			"4 criteria after reload",
		);
		const items = await criteriaItems(page);
		check(
			JSON.stringify(items) === JSON.stringify(crit4),
			`after reload ${JSON.stringify(items)}`,
		);
		const draft = JSON.parse(taskRow(id)?.draft ?? "{}") as {
			criteria?: string[];
			objective?: string;
			criterion_checks?: { criterion: string; checks: string[] }[];
		};
		check(
			JSON.stringify(draft.criteria) === JSON.stringify(crit4),
			"DB draft criteria differ",
		);
		check(
			JSON.stringify(draft.criterion_checks?.map((x) => x.criterion)) ===
				JSON.stringify(crit4) &&
				(draft.criterion_checks ?? []).every((x) => x.checks.length > 0),
			`DB mapping not keyed by the exact criteria: ${JSON.stringify(draft.criterion_checks)}`,
		);
		check(
			(await criterionGroups(page).count()) === 0 ||
				(await criterionGroups(page).nth(3).getAttribute("data-mapped")) ===
					"true",
			"mapping lost after reload",
		);
		return undefined;
	});
	await sub("C6", async () => {
		await region(page, "Task detail")
			.getByRole("button", { name: "Submit for run approval" })
			.click();
		await waitStage(page, "Awaiting execution approval");
		await until(
			async () => (await pendingCount(page)) === pendingBefore + 1,
			"pending +1",
		);
		check(
			(await page.getByTestId("execution-id").count()) === 0,
			"#execution-id present before approval",
		);
		const eng = await attr(page, "engine-state", "data-state");
		await sleep(4500);
		check(
			(await stageText(page)) === "Awaiting execution approval",
			"stage moved without approval",
		);
		const row = taskRow(id);
		const mt = row?.current_managed_task_id ?? "";
		check(managedState(mt) === "draft", `managed task ${managedState(mt)}`);
		check(runsOf(mt).length === 0, "an attempt exists before approval");
		return `engine-state=${eng} (reserved); 0 attempts after 4.5 s`;
	});
	await sub("C7", async () => {
		reqRun = await openRequest(page, "run", title);
		const doc = region(page, "Approval document");
		const items = await criteriaItems(page, "Approval document");
		check(
			JSON.stringify(items) === JSON.stringify(crit4),
			`HQ criteria ${JSON.stringify(items)}`,
		);
		// v1.2: the Gate-1 document shows each criterion's stable id and mapped checks
		const plan = await planRows(page, "Approval document");
		const snap = proposalSnapshotOf(id);
		check(
			snap?.contract === "agentcity.proposal/v1.2",
			`proposal contract ${snap?.contract}`,
		);
		check(
			JSON.stringify(plan) ===
				JSON.stringify(
					(snap?.criteria ?? []).map((c, i) => ({
						id: c.id,
						checks: (snap?.coverage_plan?.[i]?.checks ?? []).join(" "),
					})),
				) && plan.every((r) => /^crit-[0-9a-f]{16}$/.test(r.id) && r.checks),
			`criteria plan ${JSON.stringify(plan)}`,
		);
		const t = (await doc.textContent()) ?? "";
		for (const k of [
			"Allowed paths",
			"Base",
			"Checks",
			"Providers",
			"Repair allowance",
			"0 (no automatic repair)",
			"Limits",
		])
			check(t.includes(k), `HQ document lacks "${k}"`);
		check(
			(await textOf(doc.getByTestId("proposal-version"))) === "1",
			"proposal version",
		);
		await run.shot(page, "J01-C7-gate1-document");
		return undefined;
	});
	await sub("C8", async () => {
		const f = sigField(page, "run");
		check((await f.inputValue()) === "", "signature not empty on arrival");
		check(
			!(await grantButton(page, "run").isEnabled()),
			"Approve enabled before typing",
		);
		await typeSignature(page, "run");
		const t0 = Date.now();
		await f.press("Enter");
		check(
			(await noMorePosts(traffic, reqRun, t0)) === 0,
			"Enter sent a decision",
		);
		return undefined;
	});
	await sub("C9", async () => {
		const t0 = Date.now();
		await grantButton(page, "run").click();
		await until(
			async () => /Execution approved/.test(await decisionStatus(page)),
			"approved status",
		);
		observed.decisionStatusTexts.add(await decisionStatus(page));
		check(
			(await sigField(page, "run").count()) === 0,
			"signature field still rendered after success",
		);
		await until(
			async () => (await pendingCount(page)) === pendingBefore,
			"pending -1",
		);
		const hist = region(page, "Decision history");
		await until(
			async () =>
				((await hist.textContent()) ?? "").includes(
					"operator:edward · execution · approve",
				),
			"history entry",
		);
		check(
			(await posts(traffic, reqRun, t0)).length === 1,
			"more than one decision POST",
		);
		check(decisionsFor(reqRun) === 1, "DB decisions ≠ 1");
		return undefined;
	});
	await sub("C10", async () => {
		await openTask(page, id);
		const seen: string[] = [];
		await until(
			async () => {
				const st = await stageText(page);
				if (st && seen.at(-1) !== st) seen.push(st);
				const ts = await textOf(
					page.getByRole("status", { name: "Task status" }),
				);
				if (ts) observed.taskStatusTexts.add(ts.split(".")[0] ?? ts);
				return st === "Awaiting acceptance";
			},
			"awaiting acceptance",
			90_000,
			200,
		);
		check(
			(await page.getByTestId("execution-id").count()) === 1,
			"#execution-id missing",
		);
		check(
			(await attr(page, "attempt-id", "data-attempt-number")) === "1",
			"attempt 1 missing",
		);
		const active = seen.filter((x) =>
			[
				"Queued",
				"Implementing",
				"Verifying",
				"Reviewing",
				"Finalizing",
			].includes(x),
		);
		check(active.length > 0, `no active stage observed: ${seen.join(" → ")}`);
		return `stages observed: ${seen.join(" → ")}`;
	});
	await sub("C11", async () => {
		check(
			(await attr(page, "engine-state", "data-state")) === "human_ready",
			"engine not human_ready",
		);
		check(
			(await attr(page, "acceptance-status", "data-status")) === "pending",
			"acceptance not pending",
		);
		await until(
			async () => (await pendingCount(page)) === pendingBefore + 1,
			"result request counted",
		);
		await run.shot(page, "J01-C11-awaiting-acceptance");
		return undefined;
	});
	await sub("C12", async () => {
		const ev = region(page, "Task detail").getByRole("region", {
			name: "Evidence",
		});
		check(
			(await attr(page, "evidence-status", "data-status")) === "verified",
			`evidence ${await attr(page, "evidence-status", "data-status")}`,
		);
		const cand = await textOf(page.getByTestId("candidate-sha"));
		check(/^[0-9a-f]{40}$/.test(cand), `candidate ${cand}`);
		const names = (await ev.locator("li button").allTextContents()).map((n) =>
			n.trim(),
		);
		check(names.length >= 4, `only ${names.length} artifacts`);
		const states: string[] = [];
		for (const n of names) {
			await ev.getByRole("button", { name: n, exact: true }).click();
			const d = await evidenceViewerOpen(page, n);
			states.push(`${n}:${await d.getAttribute("data-state")}`);
			const dt = (await d.textContent()) ?? "";
			check(dt.includes(cand), `viewer ${n} lacks the candidate`);
			await d.getByRole("button", { name: "Close evidence" }).click();
			await d.waitFor({ state: "detached" });
		}
		check(
			states.every((x) => x.endsWith(":ok")),
			`viewer states ${states.join(", ")}`,
		);
		return `${names.length} artifacts: ${states.join(", ")}`;
	});
	let candidate = "";
	await sub("C13", async () => {
		candidate = await textOf(page.getByTestId("candidate-sha"));
		await openRequest(page, "result", title);
		const doc = region(page, "Approval document");
		check(
			(await textOf(doc.getByTestId("candidate-sha"))) === candidate,
			"HQ candidate ≠ task panel candidate",
		);
		check(
			(await doc
				.getByTestId("attempt-id")
				.getAttribute("data-attempt-number")) === "1",
			"HQ attempt ≠ 1",
		);
		const rr = reqs(id).find((r) => r.kind === "result");
		check(rr, "no result request in DB");
		const env1 = db1<{ result_envelope: string }>(
			"SELECT result_envelope FROM managed_approval_requests WHERE id = ?",
			rr.id,
		);
		check(
			(JSON.parse(env1?.result_envelope ?? "{}") as { candidate_sha?: string })
				.candidate_sha === candidate,
			"DB envelope candidate differs",
		);
		check(
			(await sigField(page, "result").inputValue()) === "",
			"Gate-2 field not empty",
		);
		check(
			!(await grantButton(page, "result").isEnabled()),
			"Accept enabled before typing",
		);
		await run.shot(page, "J01-C13-gate2-document");
		return undefined;
	});
	await sub("C14", async () => {
		const reqRes =
			reqs(id).find((r) => r.kind === "result")?.id ?? "missing-request";
		await typeSignature(page, "result");
		const t0 = Date.now();
		await sigField(page, "result").press("Enter");
		check(
			(await noMorePosts(traffic, reqRes, t0)) === 0,
			"Enter in the Gate-2 field sent a decision",
		);
		await grantButton(page, "result").click();
		await until(
			async () =>
				(await attr(page, "acceptance-status", "data-status")) === "accepted",
			"accepted",
		);
		check(
			(await attr(page, "engine-state", "data-state")) === "human_ready",
			"engine state changed by acceptance",
		);
		const hist = region(page, "Decision history");
		await until(
			async () =>
				((await hist.textContent()) ?? "").includes(
					"operator:edward · result · accept",
				),
			"accept history entry",
		);
		check(
			(await sigField(page, "result").count()) === 0,
			"signature field still rendered",
		);
		check(
			(await pendingCount(page)) === pendingBefore,
			"pending count not restored",
		);
		observed.decisionStatusTexts.add(await decisionStatus(page));
		await run.shot(page, "J01-C14-accepted");
		return undefined;
	});
	await sub("C15", async () => {
		const hq = await bannedWords(page);
		await openTask(page, id);
		const tp = await bannedWords(page);
		check(!hq && !tp, `banned word: ${hq ?? tp}`);
		return undefined;
	});
	await sub("C16", async () => {
		const row = taskRow(id);
		check(row?.stage === "accepted", `stage ${row?.stage}`);
		check(row?.accepted_decision_id, "no accepted decision id");
		const rs = reqs(id);
		check(
			rs.filter((r) => r.kind === "run").length === 1,
			"more than one run request",
		);
		check(approvedRuns(id) === 1, "approved runs ≠ 1");
		const decs = db1<{ n: number }>(
			"SELECT count(*) AS n FROM managed_decisions WHERE workspace_task_id = ?",
			id,
		);
		check(decs?.n === 2, `decisions ${decs?.n}`);
		const mt = row.current_managed_task_id ?? "";
		check(managedState(mt) === "human_ready", `engine ${managedState(mt)}`);
		J01 = { id, title, managed: mt };
		return `decisions=2, run requests=1, engine=${managedState(mt)}`;
	});

	await run.case("BRW-J-16", async () => {
		check(J01, "J-01 did not complete");
		await openTask(page, J01.id);
		const arts = artifactsOf(J01.managed);
		const ev = region(page, "Task detail").getByRole("region", {
			name: "Evidence",
		});
		const names = (await ev.locator("li button").allTextContents()).map((n) =>
			n.trim(),
		);
		const dbNames = arts.map((a) => a.name);
		check(
			JSON.stringify([...names].sort()) === JSON.stringify([...dbNames].sort()),
			`UI ${names.join(",")} vs DB ${dbNames.join(",")}`,
		);
		const resEnv = JSON.parse(
			db1<{ result_envelope: string }>(
				"SELECT result_envelope FROM managed_approval_requests WHERE workspace_task_id = ? AND kind = 'result'",
				J01.id,
			)?.result_envelope ?? "{}",
		) as { artifacts?: { name: string; sha256: string }[] };
		const problems: string[] = [];
		for (const a of arts) {
			await ev.getByRole("button", { name: a.name, exact: true }).click();
			const d = await evidenceViewerOpen(page, a.name);
			const t = (await d.textContent()) ?? "";
			if (!t.includes(`${a.byte_len} bytes`)) problems.push(`${a.name}:size`);
			if (!t.includes(a.kind.replaceAll("_", " ")))
				problems.push(`${a.name}:kind`);
			if (!t.includes(a.run_id)) problems.push(`${a.name}:attempt`);
			const sealed = resEnv.artifacts?.find((x) => x.name === a.name);
			if (sealed && !t.includes(sealed.sha256)) problems.push(`${a.name}:sha`);
			if (a.truncated && !t.toLowerCase().includes("truncated"))
				problems.push(`${a.name}:truncated-label`);
			if ((await d.locator("pre").count()) === 0)
				problems.push(`${a.name}:no-text`);
			await d.getByRole("button", { name: "Close evidence" }).click();
			await d.waitFor({ state: "detached" });
		}
		check(problems.length === 0, `problems: ${problems.join(", ")}`);
		return `${arts.length} artifacts match DB (name/kind/size/attempt/sealed sha)`;
	});
	await close(s);
}

async function draftCases(): Promise<void> {
	const s = await open();
	const { page } = s;
	await run.case("BRW-J-02", async () => {
		const line300 = `${"alpha, beta; ".repeat(30).slice(0, 299)}z`;
		const input = [
			"a, b and c",
			"  leading spaces",
			"unicode — café, ok",
			"",
			line300,
		].join("\n");
		const want = [
			"a, b and c",
			"leading spaces",
			"unicode — café, ok",
			line300,
		];
		await composeNew(page, { title: "J02 Criteria fidelity", criteria: input });
		await region(page, "Task detail")
			.getByRole("button", { name: "Save draft" })
			.click();
		await until(async () => (await criteriaItems(page)).length === 4, "saved");
		const saved = await criteriaItems(page);
		check(
			JSON.stringify(saved) === JSON.stringify(want),
			`saved ${saved.length}`,
		);
		const id = await taskIdFromUrl(page);
		await region(page, "Task detail")
			.getByRole("button", { name: "Submit for run approval" })
			.click();
		await waitStage(page, "Awaiting execution approval");
		const prop = await criteriaItems(page);
		check(JSON.stringify(prop) === JSON.stringify(want), "proposal criteria");
		await openRequest(page, "run", "J02 Criteria fidelity");
		const hq = await criteriaItems(page, "Approval document");
		check(JSON.stringify(hq) === JSON.stringify(want), "HQ criteria");
		await page.reload();
		await region(page, "Approval document").waitFor();
		await until(
			async () => (await criteriaItems(page, "Approval document")).length === 4,
			"HQ after reload",
		);
		const again = await criteriaItems(page, "Approval document");
		check(JSON.stringify(again) === JSON.stringify(want), "after reload");
		void id;
		return "blank line dropped, leading spaces trimmed, commas/unicode kept, 300-char line intact";
	});

	await run.case("BRW-J-03", async () => {
		const title = "J03 Edit after submit";
		const id = await submitNew(page, { title });
		const oldReq = await openRequest(page, "run", title);
		await typeSignature(page, "run");
		await openTask(page, id);
		await region(page, "Task detail")
			.getByRole("button", { name: "Edit draft" })
			.click();
		await region(page, "Task detail")
			.getByLabel("Objective", { exact: true })
			.fill("Edited after submission.");
		await region(page, "Task detail")
			.getByRole("button", { name: "Submit for run approval" })
			.click();
		await until(
			async () =>
				(await textOf(page.getByTestId("proposal-version"))) === "2" &&
				(await stageText(page)) === "Awaiting execution approval",
			"v2 awaiting approval",
		);
		const rs = reqs(id);
		const old = rs.find((r) => r.id === oldReq);
		check(
			old?.status === "invalidated" &&
				old.invalidation_reason === "proposal_superseded",
			`old request ${old?.status}/${old?.invalidation_reason}`,
		);
		check(
			rs.filter((r) => r.status === "pending").length === 1,
			"pending ≠ 1 for the task",
		);
		check(approvedRuns(id) === 0, "something approved");
		const names = await inboxNames(page);
		check(
			names.filter((n) => n.includes(title)).length === 1,
			`inbox items for task: ${names.filter((n) => n.includes(title)).length}`,
		);
		await page.goto(`${env.uiUrl}/#/hq/${id}/${oldReq}`);
		const doc = page.locator(
			`section[aria-label="Approval document"][data-request-id="${oldReq}"]`,
		);
		await doc.waitFor();
		check(
			(await doc.getAttribute("data-request-status")) === "invalidated",
			"old document not invalidated",
		);
		check(
			(await sigField(page, "run").count()) === 0,
			"signature field on an invalidated request",
		);
		const hist = (await region(page, "Decision history").textContent()) ?? "";
		check(/Invalidated|invalidated/.test(hist), "history lacks invalidation");
		await run.shot(page, "J03-old-request-invalidated");
		return "v1 request invalidated(proposal_superseded); one pending v2 request; no controls on v1";
	});

	await run.case("BRW-P-01", async () => {
		const title = "P01 Saved draft";
		const crit = ["First, with comma", "Second line"];
		await composeNew(page, { title, criteria: crit.join("\n") });
		await region(page, "Task detail")
			.getByRole("button", { name: "Save draft" })
			.click();
		await until(async () => (await criteriaItems(page)).length === 2, "saved");
		const id = await taskIdFromUrl(page);
		await page.reload();
		await page
			.locator(`section[aria-label="Task detail"][data-task-id="${id}"]`)
			.waitFor();
		check(
			JSON.stringify(await criteriaItems(page)) === JSON.stringify(crit),
			"same-context reload",
		);
		const f = await open();
		await f.page.goto(`${env.uiUrl}/#/projects`);
		await openTask(f.page, id);
		check(
			JSON.stringify(await criteriaItems(f.page)) === JSON.stringify(crit),
			"fresh-context reload",
		);
		check(
			(await region(f.page, "Task detail")
				.getByLabel("Title", { exact: true })
				.inputValue()) === title,
			"title differs in fresh context",
		);
		const st = await storageDump(f.page);
		check(st.local.length + st.session.length === 0, "storage used");
		await close(f);
		return "identical in same context and in a fresh context with empty storage";
	});
	await close(s);
}

async function gate1Cases(): Promise<void> {
	const s = await open();
	const { page, traffic } = s;

	await run.case("BRW-J-04", async () => {
		const title = "J04 Gate1 request changes";
		const id = await submitNew(page, { title });
		const req = await openRequest(page, "run", title);
		check(
			(await sigField(page, "run").inputValue()) === "",
			"signature not empty",
		);
		await typeReason(page, "Please narrow the scope, then resubmit.");
		await decline(page, "Request changes");
		await until(
			async () => /Changes requested/.test(await decisionStatus(page)),
			"changes requested status",
		);
		await openTask(page, id);
		await waitStage(page, "Changes requested");
		check(
			(await region(page, "Task detail")
				.getByLabel("Title", { exact: true })
				.count()) === 1,
			"editor did not reopen",
		);
		check(
			(await page.getByTestId("execution-id").count()) === 0,
			"#execution-id after request changes",
		);
		const r1 = reqs(id).find((r) => r.id === req);
		check(r1?.status === "changes_requested", `request ${r1?.status}`);
		check(
			managedState(r1.managed_task_id) === "cancelled",
			"reserved task not cancelled",
		);
		await region(page, "Task detail")
			.getByRole("textbox", { name: "Acceptance criteria" })
			.fill("Narrowed criterion, one only");
		await mapCriteria(page); // v1.2: the edited line is a new criterion (starts unmapped)
		await region(page, "Task detail")
			.getByRole("button", { name: "Submit for run approval" })
			.click();
		await until(
			async () => (await textOf(page.getByTestId("proposal-version"))) === "2",
			"v2",
		);
		await waitStage(page, "Awaiting execution approval");
		const rs = reqs(id);
		check(rs.length === 2, `requests ${rs.length}`);
		check(rs[1]?.status === "pending", "new request not pending");
		check(approvedRuns(id) === 0, "approved runs");
		const rec = (await region(page, "Task detail").textContent()) ?? "";
		check(rec.includes("Changes requested"), "old request not in the record");
		return "changes_requested → editor → v2 → new pending Gate 1; reserved task cancelled; 0 executions";
	});

	await run.case("BRW-J-05", async () => {
		const title = "J05 Gate1 reject";
		const id = await submitNew(page, { title });
		const req = await openRequest(page, "run", title);
		await typeReason(page, "Not needed.");
		await decline(page, "Reject");
		await until(
			async () => /Execution rejected/.test(await decisionStatus(page)),
			"rejected status",
		);
		await openTask(page, id);
		await waitStage(page, "Rejected");
		check(
			((await region(page, "Task detail").textContent()) ?? "").includes(
				"This task is closed",
			),
			"closed banner missing",
		);
		check(
			(await page.getByTestId("execution-id").count()) === 0,
			"#execution-id",
		);
		await page.goto(`${env.uiUrl}/#/hq/${id}/${req}`);
		await page
			.locator(
				`section[aria-label="Approval document"][data-request-id="${req}"]`,
			)
			.waitFor();
		check(
			(await sigField(page, "run").count()) === 0,
			"controls on a rejected request",
		);
		check(approvedRuns(id) === 0, "approved");
		check(taskRow(id)?.stage === "rejected", "DB stage");
		return undefined;
	});

	// pending requests used by the race cases
	await run.case("BRW-R-17", async () => {
		const title = "R17 Enter inert";
		await submitNew(page, { title });
		const req = await openRequest(page, "run", title);
		await typeSignature(page, "run");
		const f = sigField(page, "run");
		const t0 = Date.now();
		const keys = ["Enter", "Control+Enter", "Meta+Enter", "Shift+Enter"];
		for (const k of keys) await f.press(k);
		let numpad = "sent";
		try {
			await f.press("NumpadEnter");
		} catch {
			numpad = "key not supported by Playwright";
		}
		check((await noMorePosts(traffic, req, t0)) === 0, "a key sent a decision");
		check(
			reqs(await taskIdFromUrl(page)).length >= 0 && decisionsFor(req) === 0,
			"DB decision exists",
		);
		check(
			(await region(page, "Approval document").getAttribute(
				"data-request-status",
			)) === "pending",
			"not pending",
		);
		return `Gate 1: ${keys.join(", ")}, NumpadEnter (${numpad}) → 0 POSTs (Gate 2 in J-06)`;
	});

	await run.case("BRW-R-18", async () => {
		await openRequest(page, "run", "R17 Enter inert");
		const req =
			(await region(page, "Approval document").getAttribute(
				"data-request-id",
			)) ?? "";
		const f = sigField(page, "run");
		const t0 = Date.now();
		const bad = [
			"edward",
			"EDWARD",
			" Edward",
			"Edward ",
			"Edwards",
			"Edward\t",
		];
		const enabledFor: string[] = [];
		for (const v of bad) {
			await f.fill(v);
			await sleep(500);
			if (await grantButton(page, "run").isEnabled())
				enabledFor.push(JSON.stringify(v));
		}
		await f.fill("Edwardx");
		await f.press("End");
		await f.press("Backspace");
		await until(
			async () => grantButton(page, "run").isEnabled(),
			"exact after delete",
		);
		check(enabledFor.length === 0, `enabled for ${enabledFor.join(" ")}`);
		check(
			(await noMorePosts(traffic, req, t0)) === 0,
			"POST sent for a variant",
		);
		await f.fill("");
		return "6 non-exact variants keep Approve disabled; exact value (after deleting a typo) enables it";
	});

	await run.case("BRW-R-19", async () => {
		const t2 = "R19 Second request";
		await submitNew(page, { title: t2 });
		await openRequest(page, "run", "R17 Enter inert");
		await typeSignature(page, "run");
		await openRequest(page, "run", t2);
		check(
			(await sigField(page, "run").inputValue()) === "",
			"field not empty on the other subject",
		);
		await openRequest(page, "run", "R17 Enter inert");
		check(
			(await sigField(page, "run").inputValue()) === "",
			"field restored on return",
		);
		return "empty on subject change and on return; gate change covered by J-01 C13 (Gate-2 field empty after Gate 1)";
	});

	await run.case("BRW-R-15", async () => {
		const out: string[] = [];
		for (const mode of ["dblclick", "two-clicks", "space-twice"] as const) {
			const title = `R15 ${mode}`;
			const id = await submitNew(page, { title });
			const req = await openRequest(page, "run", title);
			await typeSignature(page, "run");
			const t0 = Date.now();
			const b = grantButton(page, "run");
			if (mode === "dblclick") await b.dblclick();
			else if (mode === "two-clicks")
				await Promise.all([
					b.click().catch(() => undefined),
					b.click().catch(() => undefined),
				]);
			else {
				await b.focus();
				await page.keyboard.press("Space");
				await page.keyboard.press("Space");
			}
			await until(
				async () => /Execution approved/.test(await decisionStatus(page)),
				`${mode} approved`,
			);
			await sleep(800);
			const p = await posts(traffic, req, t0);
			const keys = new Set(
				p.map(
					(x) =>
						(JSON.parse(x.body) as { idempotency_key: string }).idempotency_key,
				),
			);
			check(keys.size === 1, `${mode}: ${keys.size} keys`);
			check(
				decisionsFor(req) === 1,
				`${mode}: DB decisions ${decisionsFor(req)}`,
			);
			check(approvedRuns(id) === 1, `${mode}: approved runs`);
			out.push(`${mode}: ${p.length} POST(s), 1 key, 1 decision`);
		}
		return out.join("; ");
	});

	await run.case("BRW-R-22", async () => {
		// after the last success (R15 space-twice) the decided request shows no controls
		check(
			(await sigField(page, "run").count()) === 0,
			"controls on a decided request",
		);
		await openRequest(page, "run", "R19 Second request");
		check(
			(await sigField(page, "run").inputValue()) === "",
			"next request field not empty",
		);
		return undefined;
	});
	await close(s);
}

async function gate2Cases(): Promise<void> {
	const s = await open();
	const { page, traffic } = s;
	await run.case("BRW-J-06", async () => {
		const title = "J06 Gate2 request changes";
		const id = await toResult(s, title);
		const managedBefore = taskRow(id)?.current_managed_task_id ?? "";
		const req = await openRequest(page, "result", title);
		// R-17 Gate-2 variant
		await typeSignature(page, "result");
		const f = sigField(page, "result");
		const t0 = Date.now();
		for (const k of ["Enter", "Control+Enter", "Meta+Enter", "Shift+Enter"])
			await f.press(k);
		check((await noMorePosts(traffic, req, t0)) === 0, "Gate-2 Enter POST");
		run.notes.push("R-17 Gate 2: Enter/Ctrl/Meta/Shift+Enter → 0 POSTs (J-06)");
		await f.fill("");
		await typeReason(page, "Please also cover the empty case.");
		await decline(page, "Request changes");
		await until(
			async () =>
				(await attr(page, "acceptance-status", "data-status")) ===
				"changes_requested",
			"acceptance changes_requested",
		);
		check(
			(await attr(page, "engine-state", "data-state")) === "human_ready",
			"engine changed",
		);
		const bw = await bannedWords(page);
		check(!bw, `banned word ${bw}`);
		await openTask(page, id);
		await waitStage(page, "Changes requested");
		check(
			(await region(page, "Task detail")
				.getByLabel("Title", { exact: true })
				.count()) === 1,
			"editor did not reopen",
		);
		// old evidence still readable
		const ev = region(page, "Task detail").getByRole("region", {
			name: "Evidence",
		});
		await ev.locator("li button").first().click();
		const d = page.getByRole("dialog");
		await d.waitFor();
		await until(
			async () => (await d.getAttribute("data-state")) !== "loading",
			"viewer",
		);
		const ok = await d.getAttribute("data-state");
		await d.getByRole("button", { name: "Close evidence" }).click();
		await region(page, "Task detail")
			.getByRole("textbox", { name: "Acceptance criteria" })
			.fill("Cover the empty case, too");
		await mapCriteria(page); // v1.2: the edited line is a new criterion (starts unmapped)
		await region(page, "Task detail")
			.getByRole("button", { name: "Submit for run approval" })
			.click();
		await waitStage(page, "Awaiting execution approval");
		check(
			(await textOf(page.getByTestId("proposal-version"))) === "2",
			"not v2",
		);
		check(approvedRuns(id) === 1, "a new execution was approved implicitly");
		const rs = reqs(id);
		check(
			rs.filter((r) => r.kind === "run" && r.status === "pending").length === 1,
			"no new pending Gate 1",
		);
		check(
			managedState(managedBefore) === "human_ready",
			"old engine state changed",
		);
		check((await bannedWords(page)) === null, "banned word in the task panel");
		return `old evidence viewer state=${ok}; v2 needs a new Gate 1`;
	});

	await run.case("BRW-J-07", async () => {
		const title = "J07 Gate2 reject";
		const id = await toResult(s, title);
		const mt = taskRow(id)?.current_managed_task_id ?? "";
		const runsBefore = runsOf(mt).length;
		await openRequest(page, "result", title);
		await typeReason(page, "The result is not what we need.");
		await decline(page, "Reject");
		await until(
			async () =>
				(await attr(page, "acceptance-status", "data-status")) === "rejected",
			"rejected",
		);
		check(
			(await attr(page, "engine-state", "data-state")) === "human_ready",
			"engine changed",
		);
		check(!(await bannedWords(page)), "banned word");
		await sleep(2500);
		check(runsOf(mt).length === runsBefore, "a repair/new attempt started");
		check(
			reqs(id).filter((r) => r.status === "pending").length === 0,
			"a new request appeared",
		);
		check(taskRow(id)?.stage === "rejected", "DB stage");
		return undefined;
	});
	await close(s);
}

// ── v1.2 criterion ids, check mapping and coverage (CONTRACT_V1_2.md §A) ────────

/** The task's result request envelope from the DB (canonical JSON column), newest first. */
function resultEnvelopeOf(taskId: string) {
	const row = db1<{ result_envelope: string; status: string }>(
		"SELECT result_envelope, status FROM managed_approval_requests WHERE workspace_task_id = ? AND kind = 'result' ORDER BY created_at DESC LIMIT 1",
		taskId,
	);
	if (!row) return null;
	return {
		status: row.status,
		envelope: JSON.parse(row.result_envelope) as {
			contract: string;
			criterion_coverage?: {
				criterion_id: string;
				status: string;
				checks: {
					check: string;
					outcome: string;
					log_artifact_id: string | null;
				}[];
			}[];
		},
	};
}

async function coverageCases(): Promise<void> {
	const s = await open();
	const { page } = s;

	await run.case("BRW-C-01", async () => {
		// An unmapped criterion is never approved. (1) The editor blocks Submit and names every
		// unmapped criterion. (2) If an unmapped draft reaches the hub anyway — a stale client whose
		// saves lose the mapping, simulated by rewriting the outgoing PUT — the hub answers 400 and
		// the UI shows the hub's issues verbatim; no Gate 1 opens. (3) A correct save then submits.
		const title = "C01 Unmapped criterion";
		await composeNew(page, {
			title,
			criteria: "First, with comma\nSecond line",
			mapping: "none",
		});
		const panel = region(page, "Task detail");
		const submit = panel.getByRole("button", {
			name: "Submit for run approval",
		});
		check(await submit.isDisabled(), "Submit enabled while unmapped");
		const why = (await panel.locator(".wsm1-why li").allTextContents()).join(
			" | ",
		);
		check(
			why.includes("criterion 1: criterion has no check mapping") &&
				why.includes("criterion 2: criterion has no check mapping"),
			`reasons: ${why.slice(0, 200)}`,
		);
		await panel.getByRole("button", { name: "Save draft" }).click();
		await until(async () => (await taskIdFromUrl(page)) !== "", "task id");
		const id = await taskIdFromUrl(page);
		await page
			.locator(`section[aria-label="Task detail"][data-task-id="${id}"]`)
			.waitFor();
		await mapCriteria(page);
		check(!(await submit.isDisabled()), "Submit disabled after mapping");
		let stripped = 0;
		const pattern = `**/api/workspace/tasks/${id}/draft`;
		await page.route(pattern, async (route) => {
			const req = route.request();
			if (req.method() !== "PUT") return route.continue();
			const body = JSON.parse(req.postData() ?? "{}") as {
				draft?: Record<string, unknown>;
			};
			if (body.draft && "criterion_checks" in body.draft) {
				delete body.draft.criterion_checks;
				stripped += 1;
			}
			await route.continue({ postData: JSON.stringify(body) });
		});
		await dismissAlerts(page);
		const answer = page.waitForResponse(
			(r) =>
				r.url().endsWith(`/api/workspace/tasks/${id}/proposals`) &&
				r.request().method() === "POST",
		);
		await submit.click();
		const res = await answer;
		const status = res.status();
		const body = (await res.json()) as {
			error?: string;
			issues?: { path: string; message: string }[];
		};
		const alert = page.getByRole("main").getByRole("alert");
		await alert.first().waitFor({ timeout: 15_000 });
		const msg = await textOf(alert);
		await page.unroute(pattern);
		check(stripped >= 1, "no save was rewritten");
		check(
			status === 400 && body.error === "invalid_request",
			`hub answered ${status} ${body.error}`,
		);
		check(
			(body.issues ?? []).some(
				(i) => i.message === "criterion has no check mapping",
			),
			`hub issues ${JSON.stringify(body.issues).slice(0, 200)}`,
		);
		check(
			msg.includes("criterion 1: criterion has no check mapping") &&
				msg.includes("criterion 2: criterion has no check mapping"),
			`alert "${msg.slice(0, 200)}"`,
		);
		check(reqs(id).length === 0, `${reqs(id).length} approval request(s)`);
		check(taskRow(id)?.stage === "draft", `stage ${taskRow(id)?.stage}`);
		await run.shot(page, "C01-unmapped-hub-400");
		await dismissAlerts(page);
		// the honest client: Save keeps the mapping, Submit opens Gate 1 for a v1.2 proposal
		await submit.click();
		await waitStage(page, "Awaiting execution approval", 15_000);
		check(
			proposalSnapshotOf(id)?.contract === "agentcity.proposal/v1.2",
			"proposal is not v1.2",
		);
		return `editor blocked Submit (2 unmapped named); stale save → hub ${status} ${body.error} (${(body.issues ?? []).length} issue(s)) shown verbatim; 0 requests; mapped resubmit → Gate 1 (v1.2)`;
	});

	await run.case("BRW-C-02", async () => {
		// per-criterion coverage of the sealed result, in the task detail and the Gate-2 document,
		// equal to the hub's sealed `criterion_coverage` — never a count of green checks
		const title = "C02 Coverage at Gate 2";
		const id = await toResult(s, title);
		const snap = proposalSnapshotOf(id);
		const sealed = resultEnvelopeOf(id);
		check(
			sealed?.envelope.contract === "agentcity.result/v1.2",
			`envelope contract ${sealed?.envelope.contract}`,
		);
		const want = (sealed?.envelope.criterion_coverage ?? []).map((c) => ({
			id: c.criterion_id,
			status: c.status,
			checks: c.checks.map(
				(x) =>
					`${x.check}:${x.outcome}:${x.log_artifact_id ? "present" : "absent"}`,
			),
		}));
		check(
			JSON.stringify(want.map((w) => w.id)) ===
				JSON.stringify((snap?.criteria ?? []).map((c) => c.id)),
			"coverage ids ≠ proposal criterion ids",
		);
		check(
			want.length > 0 &&
				want.every(
					(w) =>
						w.status === "satisfied" &&
						w.checks.every((c) => c.endsWith(":passed:present")),
				),
			`sealed coverage ${JSON.stringify(want)}`,
		);
		await until(
			async () => (await coverageRows(page)).length === want.length,
			"task-detail coverage rows",
		);
		const panelRows = await coverageRows(page);
		check(
			JSON.stringify(panelRows) === JSON.stringify(want),
			`task detail ${JSON.stringify(panelRows)}`,
		);
		check(
			(await region(page, "Task detail")
				.getByTestId("criterion-coverage")
				.getAttribute("data-status")) === "satisfied",
			"task-detail coverage status",
		);
		await region(page, "Task detail")
			.getByTestId("criterion-coverage")
			.first()
			.scrollIntoViewIfNeeded();
		await run.shot(page, "C02-task-coverage");
		await openRequest(page, "result", title);
		const docRows = await coverageRows(page, "Approval document");
		check(
			JSON.stringify(docRows) === JSON.stringify(want),
			`Gate-2 document ${JSON.stringify(docRows)}`,
		);
		await region(page, "Approval document")
			.getByTestId("criterion-coverage")
			.first()
			.scrollIntoViewIfNeeded();
		await run.shot(page, "C02-gate2-coverage");
		return `${want.length} criteria, all satisfied with log evidence; task detail = Gate-2 document = sealed coverage`;
	});

	await run.case("BRW-C-03", async () => {
		// a failing check never yields a satisfied criterion or an acceptance
		const title = "C03 Failing check";
		const id = await submitNew(page, { title, scenario: "verification_fails" });
		await approveRun(page, title);
		await openTask(page, id);
		await waitEngine(page, ["failed", "blocked", "human_ready"], 90_000);
		await until(
			async () =>
				(await region(page, "Task detail")
					.getByTestId("criterion-coverage")
					.count()) > 0 &&
				["Failed", "Blocked"].includes(await stageText(page)),
			"execution ended",
			30_000,
		);
		const sealed = resultEnvelopeOf(id);
		const cov = region(page, "Task detail").getByTestId("criterion-coverage");
		const covStatus = await cov.getAttribute("data-status");
		const rows = await coverageRows(page);
		check(
			reqs(id).every((r) => r.status !== "pending" && r.status !== "accepted"),
			"a result request is open or accepted",
		);
		check(taskRow(id)?.stage !== "accepted", "accepted");
		check(
			(await region(page, "Task detail")
				.getByRole("button", { name: "Open result acceptance" })
				.count()) === 0,
			"acceptance offered",
		);
		check(
			!rows.some(
				(r) =>
					r.status === "satisfied" &&
					r.checks.some((c) => c.includes(":failed:")),
			),
			"a criterion with a failed check reads satisfied",
		);
		let branch: string;
		if (sealed) {
			// a hub that seals failing results must show the failed check's criteria as unsatisfied
			check(
				rows.some((r) => r.status === "unsatisfied"),
				`sealed failing result without an unsatisfied criterion: ${JSON.stringify(rows)}`,
			);
			branch = `sealed (${sealed.status}): ${rows.map((r) => r.status).join(", ")}`;
		} else {
			// the engine fails the attempt before sealing: nothing is covered, and the UI says so
			check(covStatus === "none", `coverage status ${covStatus}`);
			check(rows.length === 0, "coverage rows without a sealed result");
			check(
				((await cov.textContent()) ?? "").includes(
					"No result was sealed for this execution, so no criterion is covered.",
				),
				"no-result coverage note missing",
			);
			branch = "engine failed before sealing; no result request; coverage=none";
		}
		await region(page, "Task detail")
			.getByTestId("criterion-coverage")
			.first()
			.scrollIntoViewIfNeeded();
		await run.shot(page, "C03-failing-check");
		return branch;
	});

	await run.case("BRW-C-04", async () => {
		// editing one criterion in a revision changes only that criterion's id
		const title = "C04 One criterion edited";
		const lines = [
			"Keeps the CLI flags",
			"Docs mention the flag",
			"No new dependency",
		];
		const id = await submitNew(page, { title, criteria: lines.join("\n") });
		const v1 = proposalSnapshotOf(id);
		const v1Plan = await planRows(page);
		check(
			JSON.stringify(v1Plan.map((r) => r.id)) ===
				JSON.stringify((v1?.criteria ?? []).map((c) => c.id)),
			"task-detail plan ≠ v1 ids",
		);
		await openRequest(page, "run", title);
		await typeReason(page, "Make the docs criterion precise.");
		await decline(page, "Request changes");
		await until(
			async () => /Changes requested/.test(await decisionStatus(page)),
			"changes requested",
		);
		await openTask(page, id);
		await waitStage(page, "Changes requested");
		const edited = [
			lines[0],
			"Docs mention the flag, with one example",
			lines[2],
		];
		await region(page, "Task detail")
			.getByRole("textbox", { name: "Acceptance criteria" })
			.fill(edited.join("\n"));
		const groups = criterionGroups(page);
		await until(async () => (await groups.count()) === 3, "3 groups");
		const mapped = await groups.evaluateAll((gs) =>
			gs.map((g) => g.getAttribute("data-mapped")),
		);
		check(
			JSON.stringify(mapped) === '["true","false","true"]',
			`after editing line 2: ${JSON.stringify(mapped)}`,
		);
		await mapCriteria(page);
		await region(page, "Task detail")
			.getByRole("button", { name: "Submit for run approval" })
			.click();
		await until(
			async () => (await textOf(page.getByTestId("proposal-version"))) === "2",
			"v2",
		);
		const v2 = proposalSnapshotOf(id);
		const a = (v1?.criteria ?? []).map((c) => c.id);
		const b = (v2?.criteria ?? []).map((c) => c.id);
		check(v2?.version === 2, `version ${v2?.version}`);
		check(
			a.length === 3 &&
				b.length === 3 &&
				a[0] === b[0] &&
				a[2] === b[2] &&
				a[1] !== b[1],
			`ids v1 ${JSON.stringify(a)} v2 ${JSON.stringify(b)}`,
		);
		await until(
			async () =>
				JSON.stringify((await planRows(page)).map((r) => r.id)) ===
				JSON.stringify(b),
			"task-detail plan shows v2 ids",
		);
		await run.shot(page, "C04-revision-ids");
		return `v1→v2: ids 1 and 3 kept, id 2 replaced (${a[1]?.slice(0, 13)}… → ${b[1]?.slice(0, 13)}…)`;
	});
	await close(s);
}

async function scenarioCases(): Promise<void> {
	const s = await open();
	const { page } = s;
	await run.case("BRW-J-08", async () => {
		const r = await toEngineEnd(s, "J08 Verification fails", {
			scenario: "verification_fails",
		});
		check(r.state === "failed", `engine ${r.state}`);
		await waitStage(page, "Failed");
		const panel = region(page, "Task detail");
		check(
			(await panel
				.getByRole("button", { name: "Open result acceptance" })
				.count()) === 0,
			"result acceptance offered",
		);
		check(
			(await panel
				.getByRole("button", { name: /force|override|dismiss|unlock/i })
				.count()) === 0,
			"override control",
		);
		check(
			reqs(r.id).every((x) => x.kind === "run"),
			"a result request exists",
		);
		const mt = taskRow(r.id)?.current_managed_task_id ?? "";
		check(runsOf(mt).length === 1, "repair attempt with repair 0");
		const txt = (await panel.textContent()) ?? "";
		return `stages ${r.seen.join(" → ")}; failure text shown: ${/verification check failed/i.test(txt)}`;
	});
	await run.case("BRW-J-09", async () => {
		const title = "J09 One preapproved repair";
		const id = await submitNew(page, {
			title,
			scenario: "verification_fails_then_fixed",
			repair: 1,
		});
		await openRequest(page, "run", title);
		check(
			((await region(page, "Approval document").textContent()) ?? "").includes(
				"1 pre-approved repair attempt",
			),
			"repair allowance not in the Gate-1 document",
		);
		await typeSignature(page, "run");
		await grantButton(page, "run").click();
		await until(
			async () => /Execution approved/.test(await decisionStatus(page)),
			"approved",
		);
		await openTask(page, id);
		const seen: string[] = [];
		await until(
			async () => {
				const st = await stageText(page);
				if (st && seen.at(-1) !== st) seen.push(st);
				return st === "Awaiting acceptance";
			},
			"awaiting acceptance",
			120_000,
			200,
		);
		check(
			(await attr(page, "attempt-id", "data-attempt-number")) === "2",
			"current attempt not 2",
		);
		const mt = taskRow(id)?.current_managed_task_id ?? "";
		const rr = runsOf(mt);
		check(rr.length === 2, `attempts ${rr.length}`);
		const att = (await region(page, "Task detail")
			.getByRole("list", { name: "Attempts" })
			.getByRole("listitem")
			.count()) as number;
		check(att === 2, `attempt list ${att}`);
		check(
			((await region(page, "Task detail").textContent()) ?? "").includes(
				"0 of 1 remaining",
			),
			"remaining allowance not 0 of 1",
		);
		await openRequest(page, "result", title);
		const cand = await textOf(
			region(page, "Approval document").getByTestId("candidate-sha"),
		);
		check(cand === rr[1]?.candidate_sha, "Gate 2 not bound to attempt 2");
		check(cand !== rr[0]?.candidate_sha, "attempt 2 candidate = attempt 1");
		check(approvedRuns(id) === 1, "new Gate 1");
		return `stages ${seen.join(" → ")}; Gate 2 binds attempt 2 (${cand.slice(0, 10)})`;
	});
	await run.case("BRW-J-10", async () => {
		const a = await toEngineEnd(s, "J10a Fails then fixed, repair 0", {
			scenario: "verification_fails_then_fixed",
		});
		const mtA = taskRow(a.id)?.current_managed_task_id ?? "";
		check(a.state === "failed", `(a) engine ${a.state}`);
		check(runsOf(mtA).length === 1, "(a) attempt 2 with repair 0");
		const b = await toEngineEnd(s, "J10b Out of scope, repair 1", {
			scenario: "out_of_scope",
			repair: 1,
			allowed: "src",
		});
		const mtB = taskRow(b.id)?.current_managed_task_id ?? "";
		check(["failed", "blocked"].includes(b.state), `(b) engine ${b.state}`);
		check(runsOf(mtB).length === 1, "(b) repaired an out-of-scope change");
		const txt = (await region(page, "Task detail").textContent()) ?? "";
		check(/scope/i.test(txt), "(b) no scope message");
		check(
			reqs(b.id).every((r) => r.kind === "run"),
			"(b) result request",
		);
		return `(a) ${a.state}, 1 attempt; (b) ${b.state}, 1 attempt, scope message shown`;
	});
	await run.case("BRW-J-11", async () => {
		const out: string[] = [];
		const bad: string[] = [];
		for (const sc of [
			"reject_always",
			"malformed_review",
			"reviewer_error",
			"review_wrong_candidate",
			"reviewer_mutates",
		]) {
			const repair = sc === "reject_always" ? 0 : 1;
			const r = await toEngineEnd(s, `J11 ${sc}`, { scenario: sc, repair });
			const mt = taskRow(r.id)?.current_managed_task_id ?? "";
			const n = runsOf(mt).length;
			const stage = await stageText(page);
			const resultReqs = reqs(r.id).filter((x) => x.kind === "result");
			const acceptBtn = await region(page, "Task detail")
				.getByRole("button", { name: "Open result acceptance" })
				.count();
			const label =
				r.state === "failed"
					? "Failed"
					: r.state === "blocked"
						? "Blocked"
						: "?";
			if (!["failed", "blocked"].includes(r.state))
				bad.push(`${sc}: engine ${r.state}`);
			if (repair === 1 && n !== 1) bad.push(`${sc}: ${n} attempts (repaired)`);
			if (resultReqs.some((x) => x.status === "pending"))
				bad.push(`${sc}: pending result request`);
			if (acceptBtn) bad.push(`${sc}: acceptance offered`);
			if (stage !== label)
				bad.push(`${sc}: stage "${stage}" vs engine ${r.state}`);
			out.push(
				`${sc}(repair ${repair}): engine ${r.state}, stage ${stage}, attempts ${n}`,
			);
		}
		check(bad.length === 0, bad.join("; "));
		return out.join("; ");
	});
	await close(s);
}

async function evidenceCases(): Promise<void> {
	const s = await open();
	const { page, traffic } = s;
	const root = env.fx.config.artifacts_root;

	await run.case("BRW-J-12", async () => {
		const title = "J12 Missing evidence";
		const id = await toResult(s, title);
		const mt = taskRow(id)?.current_managed_task_id ?? "";
		const diff = artifactsOf(mt).find((a) => a.kind === "diff");
		check(diff, "no diff artifact");
		unlinkSync(join(root, diff.rel_path));
		await openRequest(page, "result", title);
		await typeSignature(page, "result");
		await dismissAlerts(page);
		await grantButton(page, "result").click();
		const alert = page.getByRole("main").getByRole("alert");
		await alert.waitFor({ timeout: 15_000 });
		const msg = await textOf(alert);
		await sleep(2500);
		check(
			(await sigField(page, "result").count()) === 0 ||
				(await sigField(page, "result").inputValue()) === "",
			"signature kept after the error",
		);
		const accDecisions = db1<{ n: number }>(
			"SELECT count(*) AS n FROM managed_decisions WHERE workspace_task_id = ? AND action = 'accept'",
			id,
		);
		check(accDecisions?.n === 0, "accepted despite missing evidence");
		check(taskRow(id)?.stage !== "accepted", "stage accepted");
		await openTask(page, id);
		const evs = await attr(page, "evidence-status", "data-status");
		// lead ruling L-1 (rerun 4): integrity_failed → data-status "unknown" (was "corrupt")
		check(
			evs === "unknown",
			`evidence-status ${evs} (ruling L-1 expects unknown)`,
		);
		await run.shot(page, "J12-missing-evidence");
		return `alert: "${msg.slice(0, 90)}"; evidence-status=${evs}; stage=${taskRow(id)?.stage}; request=${reqs(id).find((r) => r.kind === "result")?.status}/${reqs(id).find((r) => r.kind === "result")?.invalidation_reason}`;
	});

	await run.case("BRW-J-13", async () => {
		const out: string[] = [];
		// (a) one flipped byte in the manifest
		const ta = "J13a Flipped byte";
		const ida = await toResult(s, ta);
		const mta = taskRow(ida)?.current_managed_task_id ?? "";
		const man = artifactsOf(mta).find((a) => a.kind === "manifest");
		check(man, "no manifest");
		flipByte(join(root, man.rel_path));
		await openRequest(page, "result", ta);
		await typeSignature(page, "result");
		await dismissAlerts(page);
		await grantButton(page, "result").click();
		const alertA = page.getByRole("main").getByRole("alert");
		await alertA.waitFor({ timeout: 15_000 });
		const msgA = await textOf(alertA);
		await sleep(2500);
		const rA = reqs(ida).find((r) => r.kind === "result");
		check(taskRow(ida)?.stage !== "accepted", "(a) accepted");
		check(
			(await sigField(page, "result").count()) === 0,
			"(a) signature field still offered",
		);
		out.push(
			`(a) "${msgA.slice(0, 70)}" request=${rA?.status}/${rA?.invalidation_reason}`,
		);
		await dismissAlerts(page);
		// (b) coherent tamper: file + DB row hash/length rewritten together
		const tb = "J13b Coherent tamper";
		const idb = await toResult(s, tb);
		const mtb = taskRow(idb)?.current_managed_task_id ?? "";
		const d = artifactsOf(mtb).find((a) => a.kind === "diff");
		check(d, "no diff");
		const p = join(root, d.rel_path);
		const next = Buffer.concat([
			readFileSync(p),
			Buffer.from("+tampered line\n"),
		]);
		writeFileSync(p, next);
		const w = new Database(env.fx.dbPath);
		try {
			w.exec("PRAGMA busy_timeout = 5000");
			w.query(
				"UPDATE managed_artifacts SET sha256 = ?, byte_len = ? WHERE id = ?",
			).run(createHash("sha256").update(next).digest("hex"), next.length, d.id);
		} finally {
			w.close();
		}
		await openRequest(page, "result", tb);
		await typeSignature(page, "result");
		await dismissAlerts(page);
		await grantButton(page, "result").click();
		const alertB = page.getByRole("main").getByRole("alert");
		await alertB.waitFor({ timeout: 15_000 });
		const msgB = await textOf(alertB);
		await sleep(2500);
		const rB = reqs(idb).find((r) => r.kind === "result");
		check(
			taskRow(idb)?.stage !== "accepted",
			"(b) accepted after coherent tamper",
		);
		out.push(
			`(b) "${msgB.slice(0, 70)}" request=${rB?.status}/${rB?.invalidation_reason}`,
		);
		await openTask(page, idb);
		out.push(
			`(b) evidence-status=${await attr(page, "evidence-status", "data-status")}`,
		);
		await run.shot(page, "J13b-coherent-tamper");
		void traffic;
		return out.join("; ");
	});

	await run.case("BRW-J-22", async () => {
		// Contract v1.2 §C (docs/workspace-m1/CONTRACT_V1_2.md, "J-22 under this contract"): after a
		// required SOURCE artifact of an accepted result is corrupted and the page reloads, the
		// historical acceptance stays `accepted`, the CURRENT validity reads `invalid` with a visible
		// alert, and the accepted original is still viewable — as history — from the sealed bundle.
		const title = "J22 Accepted then corrupted";
		const id = await toResult(s, title);
		const req = await openRequest(page, "result", title);
		await typeSignature(page, "result");
		// R-15 Gate-2 variant: double click on Accept
		const t0 = Date.now();
		await grantButton(page, "result").dblclick();
		await until(
			async () =>
				(await attr(page, "acceptance-status", "data-status")) === "accepted",
			"accepted",
		);
		await sleep(800);
		const keys = new Set(
			(await posts(traffic, req, t0)).map(
				(x) =>
					(JSON.parse(x.body) as { idempotency_key: string }).idempotency_key,
			),
		);
		run.notes.push(
			`R-15 Gate 2 (J-22 dblclick on Accept): ${(await posts(traffic, req, t0)).length} POST(s), ${keys.size} key, DB decisions ${decisionsFor(req)}`,
		);
		check(decisionsFor(req) === 1, "Gate-2 double click → 2 decisions");
		const decision = db1<{
			id: string;
			decided_at: string;
			response_body: string;
		}>(
			"SELECT id, decided_at, response_body FROM managed_decisions WHERE approval_request_id = ?",
			req,
		);
		check(decision, "no accept decision row");
		// right after acceptance the hub reports the acceptance as currently valid
		await openTask(page, id);
		await until(
			async () =>
				(await attr(page, "acceptance-validity", "data-status")) === "valid",
			`acceptance-validity=valid after accept (got ${await attr(page, "acceptance-validity", "data-status")}/${await attr(page, "acceptance-validity", "data-reason")})`,
			20_000,
		);
		// corrupt a required source artifact (mutable artifact store, under env.fx only)
		const mt = taskRow(id)?.current_managed_task_id ?? "";
		const d = artifactsOf(mt).find((a) => a.kind === "diff");
		check(d, "no diff");
		const diffPath = join(root, d.rel_path);
		const original = readFileSync(diffPath).toString("utf8");
		flipByte(diffPath);
		await page.reload();
		await openTask(page, id);
		// detection = the task-detail read re-check (last check older than 5 s) — poll, never a fixed sleep
		await until(
			async () =>
				(await attr(page, "acceptance-validity", "data-status")) === "invalid",
			"acceptance-validity=invalid after the corruption + reload",
			30_000,
		);
		const panel = region(page, "Task detail");
		const acc = await attr(page, "acceptance-status", "data-status");
		check(
			acc === "accepted",
			`historical acceptance-status=${acc} (want accepted)`,
		);
		const validity = panel.getByTestId("acceptance-validity");
		const reason = await validity.getAttribute("data-reason");
		check(
			reason === "source_evidence_changed",
			`validity reason ${reason} (want source_evidence_changed)`,
		);
		check(
			(await validity.getAttribute("role")) === "alert" &&
				(await validity.isVisible()),
			"the invalid validity is not a visible alert",
		);
		const alertText = await textOf(validity);
		check(
			/Accepted on .+, but this result is no longer valid: /.test(alertText),
			`alert text "${alertText.slice(0, 120)}"`,
		);
		const alerts = await page.getByRole("alert").count();
		check(alerts >= 1, "no role=alert on the page");
		check(
			(await page.getByText(/^Current evidence verified/).count()) === 0,
			"a verified badge is still shown",
		);
		// history: the original decision stays, with its timestamp; the receipt is unchanged
		const record = await textOf(
			panel.getByRole("heading", { name: "Approval record" }).locator(".."),
		);
		const stamp = `${decision.decided_at.slice(0, 16).replace("T", " ")} UTC`;
		check(
			/Result acceptance · (Proposal v\d+ · )?Accepted/.test(record) &&
				record.includes(stamp),
			`approval record lacks the accepted decision at ${stamp}: "${record.slice(0, 160)}"`,
		);
		const after = db1<{
			id: string;
			decided_at: string;
			response_body: string;
		}>(
			"SELECT id, decided_at, response_body FROM managed_decisions WHERE approval_request_id = ?",
			req,
		);
		check(
			after?.id === decision.id &&
				after.decided_at === decision.decided_at &&
				after.response_body === decision.response_body,
			"the historical decision / receipt changed",
		);
		check(taskRow(id)?.stage === "accepted", "task stage left accepted");
		const row = db1<{ status: string; reason: string | null }>(
			"SELECT status, reason FROM managed_acceptance_validity WHERE decision_id = ?",
			decision.id,
		);
		check(
			row?.status === "invalid",
			`validity row ${row?.status}/${row?.reason}`,
		);
		// re-accepting is impossible without a new valid result request
		check(
			reqs(id).filter((r) => r.kind === "result" && r.status === "pending")
				.length === 0,
			"a result request is pending again",
		);
		check(
			(await panel
				.getByRole("button", { name: "Open result acceptance" })
				.count()) === 0,
			"acceptance offered again",
		);
		// evidence: sealed statuses read as history; the accepted original is still viewable
		const evStatus = await attr(page, "evidence-status", "data-status");
		check(
			evStatus !== "verified",
			`evidence-status=${evStatus} after invalidation`,
		);
		await panel
			.getByRole("region", { name: "Evidence" })
			.getByRole("button", { name: d.name, exact: true })
			.click();
		const viewer = await evidenceViewerOpen(page, d.name);
		const vState = await viewer.getAttribute("data-state");
		const vHistory = await viewer.getAttribute("data-history");
		const shown = (await viewer.locator("pre").textContent()) ?? "";
		check(
			vState === "ok",
			`viewer data-state=${vState} (accepted original not served)`,
		);
		check(vHistory === "accepted-original", `viewer data-history=${vHistory}`);
		check(
			await viewer.getByTestId("evidence-history").isVisible(),
			"no 'accepted original, kept as history' label",
		);
		check(
			shown === original,
			`viewer text is not the accepted original (${shown.length} vs ${original.length} chars)`,
		);
		await run.shot(page, "J22-accepted-then-invalid-viewer");
		await viewer.getByRole("button", { name: "Close evidence" }).click();
		await viewer.waitFor({ state: "detached" });
		await run.shot(page, "J22-accepted-then-invalid");
		// Headquarters: the accepted result document and the decision history say the same
		await page.evaluate((h) => {
			location.hash = h;
		}, `#/hq/${id}/${req}`);
		const doc = region(page, "Approval document");
		await doc.waitFor();
		await until(
			async () =>
				(await doc
					.getByTestId("acceptance-validity")
					.getAttribute("data-status")) === "invalid",
			"HQ acceptance-validity=invalid",
		);
		check(
			(await doc
				.getByTestId("acceptance-status")
				.getAttribute("data-status")) === "accepted",
			"HQ acceptance-status not accepted",
		);
		const hist = await region(page, "Decision history")
			.getByTestId("history-acceptance-validity")
			.getAttribute("data-status");
		check(hist === "invalid", `HQ history validity ${hist}`);
		await run.shot(page, "J22-hq-history");
		// sticky: another reload never restores a verified reading
		await page.reload();
		await openTask(page, id);
		await sleep(6000);
		const again = await attr(page, "acceptance-validity", "data-status");
		check(again === "invalid", `after a second reload: ${again}`);
		return `acceptance-status=${acc}; acceptance-validity=invalid/${reason} (role=alert, ${alerts} alert(s)); decision ${decision.id} unchanged at ${stamp}; evidence-status=${evStatus}; viewer ${vState}/${vHistory}, original ${original.length} chars; HQ document invalid, history ${hist}; sticky after reload`;
	});

	await run.case("BRW-A-12", async () => {
		check(J01, "J-01 missing");
		await openTask(page, J01.id);
		const ev = region(page, "Task detail").getByRole("region", {
			name: "Evidence",
		});
		const logName = (await ev.locator("li button").allTextContents())
			.map((t) => t.trim())
			.find((n) => /^verify-.*\.log$/.test(n));
		check(logName, "no verification log artifact");
		const dialogsBefore = run.dialogs.length;
		await ev.getByRole("button", { name: logName, exact: true }).click();
		const d = await evidenceViewerOpen(page, logName);
		const pre = d.locator("pre");
		const txt = (await pre.textContent()) ?? "";
		check(
			txt.includes("<img src=x onerror=alert(1)>"),
			"HTML canary not literal",
		);
		check(
			txt.includes("<script>alert(2)</script>"),
			"script canary not literal",
		);
		check((await d.locator("img, script").count()) === 0, "markup rendered");
		const longKept = txt.includes("x".repeat(4000));
		const longMasked = txt.includes("[REDACTED](long unbroken text)");
		check(longKept || longMasked, "long line neither shown nor masked");
		await sleep(500);
		check(run.dialogs.length === dialogsBefore, "a JS dialog fired");
		const lay = await layout(page);
		check(!lay.overflowX, "page overflow with the long line");
		const preBox = (await pre.evaluate((el) => ({
			sw: el.scrollWidth,
			cw: el.clientWidth,
			ox: getComputedStyle(el).overflowX,
			ws: getComputedStyle(el).whiteSpace,
			font: getComputedStyle(el).fontFamily,
		}))) as { sw: number; cw: number; ox: string; ws: string; font: string };
		await run.shot(page, "A12-inert-log");
		await d.getByRole("button", { name: "Close evidence" }).click();
		// proposal text: markup typed by the operator is shown literally
		const t = "A12 <b>bold</b> & <i>tags</i>";
		await submitNew(page, {
			title: t,
			objective: "<img src=x onerror=alert(3)> objective",
		});
		const h2 = page.locator("#wsm1-panel-title");
		check(
			(await h2.textContent())?.includes("<b>bold</b>"),
			"title not literal",
		);
		check((await h2.locator("b").count()) === 0, "title markup rendered");
		check(
			(await region(page, "Task detail").locator("img").count()) === 0,
			"objective markup rendered",
		);
		return `long unbroken line ${longKept ? "shown" : "masked by log redaction as [REDACTED](long unbroken text)"}; log pre: white-space=${preBox.ws}, overflow-x=${preBox.ox}, font=${preBox.font.split(",")[0]}; ANSI shown as text: ${txt.includes("ansi-red")}`;
	});

	await run.case("BRW-S-05", async () => {
		check(J01, "J-01 missing");
		await openTask(page, J01.id);
		const ev = region(page, "Task detail").getByRole("region", {
			name: "Evidence",
		});
		const logName = (await ev.locator("li button").allTextContents())
			.map((x) => x.trim())
			.find((n) => /^verify-.*\.log$/.test(n));
		check(logName, "no log");
		await ev.getByRole("button", { name: logName, exact: true }).click();
		const d = await evidenceViewerOpen(page, logName);
		const txt = (await d.locator("pre").textContent()) ?? "";
		const rawInLog = txt.includes(CANARY);
		const marker = /\[REDACTED\]/.test(txt);
		await d.getByRole("button", { name: "Close evidence" }).click();
		// proposal text canary
		const title = "S05 Canary in objective";
		const id = await submitNew(page, {
			title,
			objective: `Use token ${PROPOSAL_CANARY} for nothing.`,
		});
		const panelText = (await region(page, "Task detail").textContent()) ?? "";
		const rawInProposal = panelText.includes(PROPOSAL_CANARY);
		const row = taskRow(id);
		const prop = db1<{ snapshot: string }>(
			"SELECT snapshot FROM managed_proposals WHERE workspace_task_id = ?",
			id,
		);
		const rawInDraftDb = (row?.draft ?? "").includes(PROPOSAL_CANARY);
		const rawInSnapshotDb = (prop?.snapshot ?? "").includes(PROPOSAL_CANARY);
		run.notes.push(
			`S-05: raw canary in verification log viewer=${rawInLog} (redaction marker ${marker}); in proposal view=${rawInProposal}; in DB draft=${rawInDraftDb}; in DB proposal snapshot=${rawInSnapshotDb}`,
		);
		check(!rawInLog, "raw secret-shaped value shown in the verification log");
		check(!rawInProposal, "raw secret-shaped value shown in the proposal");
		check(!rawInSnapshotDb, "raw value stored in the proposal snapshot");
		return `log redacted (marker ${marker}); proposal redacted; DB draft raw=${rawInDraftDb}`;
	});
	await close(s);
}

async function raceCases(): Promise<void> {
	const s = await open();
	const { page, traffic } = s;
	// two drafts for selection races
	await composeNew(page, { title: "R02 Task A" });
	await region(page, "Task detail")
		.getByRole("button", { name: "Save draft" })
		.click();
	await until(async () => (await taskIdFromUrl(page)) !== "", "A");
	const A = await taskIdFromUrl(page);
	await composeNew(page, { title: "R02 Task B" });
	await region(page, "Task detail")
		.getByRole("button", { name: "Save draft" })
		.click();
	await until(
		async () =>
			(await taskIdFromUrl(page)) !== "" && (await taskIdFromUrl(page)) !== A,
		"B",
	);
	const B = await taskIdFromUrl(page);
	const delay = (id: string, ms: number) => async (route: Route) => {
		if (
			new URL(route.request().url()).pathname === `/api/workspace/tasks/${id}`
		)
			await sleep(ms);
		await route.continue().catch(() => undefined);
	};

	run.notRun(
		"BRW-R-01",
		"M1 data has one allowlisted repository and no monitor-only repositories (N-16, 07 NOTES §8); no repo-level A→B possible",
	);

	await run.case("BRW-R-02", async () => {
		await selectRepo(page, env.repoId);
		await page.route(`**/api/workspace/tasks/${A}`, delay(A, 1500));
		const tasks = region(page, "Tasks");
		await tasks.locator(`[data-task-id="${A}"]`).click();
		await tasks.locator(`[data-task-id="${B}"]`).click();
		await page
			.locator(`section[aria-label="Task detail"][data-task-id="${B}"]`)
			.waitFor();
		await sleep(2200);
		check(
			(await page
				.locator(`section[aria-label="Task detail"][data-task-id="${B}"]`)
				.count()) === 1,
			"late A replaced B",
		);
		check(
			(await tasks
				.locator(`[data-task-id="${B}"]`)
				.getAttribute("aria-current")) === "true",
			"B not aria-current",
		);
		await page.unrouteAll({ behavior: "ignoreErrors" });
		return undefined;
	});

	await run.case("BRW-R-04", async () => {
		await selectRepo(page, env.repoId);
		await page.route(`**/api/workspace/tasks/${B}`, delay(B, 1500));
		const tasks = region(page, "Tasks");
		await tasks.locator(`[data-task-id="${A}"]`).click();
		await tasks.locator(`[data-task-id="${B}"]`).click();
		await tasks.locator(`[data-task-id="${A}"]`).click();
		await page
			.locator(`section[aria-label="Task detail"][data-task-id="${A}"]`)
			.waitFor();
		const flashes: string[] = [];
		const end = Date.now() + 2200;
		while (Date.now() < end) {
			const cur = await page
				.locator('section[aria-label="Task detail"]')
				.getAttribute("data-task-id")
				.catch(() => null);
			if (cur && cur !== A) flashes.push(cur);
			await sleep(100);
		}
		check(flashes.length === 0, "B flashed in");
		await page.unrouteAll({ behavior: "ignoreErrors" });
		return undefined;
	});

	await run.case("BRW-R-05", async () => {
		await selectRepo(page, env.repoId);
		const tasks = region(page, "Tasks");
		await tasks.locator(`[data-task-id="${A}"]`).click();
		await page
			.locator(`section[aria-label="Task detail"][data-task-id="${A}"]`)
			.waitFor();
		await tasks.locator(`[data-task-id="${A}"]`).click();
		await tasks.locator(`[data-task-id="${A}"]`).click();
		await sleep(700);
		check(
			(await page
				.locator(`section[aria-label="Task detail"][data-task-id="${A}"]`)
				.count()) === 1,
			"task detail lost",
		);
		check(
			(await page.getByRole("heading", { name: "Loading task…" }).count()) ===
				0,
			"stuck loading",
		);
		// HQ: same request reselected keeps the signature (ruling N-8)
		await openRequest(page, "run", "R19 Second request");
		const req =
			(await region(page, "Approval document").getAttribute(
				"data-request-id",
			)) ?? "";
		await typeSignature(page, "run");
		const t0 = Date.now();
		const item = region(page, "Approval inbox").locator(
			`[data-request-id="${req}"]`,
		);
		await item.click();
		await item.click();
		await sleep(600);
		const kept = await sigField(page, "run").inputValue();
		check(kept === "Edward", `signature after reselect: "${kept}"`);
		check((await noMorePosts(traffic, req, t0)) === 0, "a decision was sent");
		await sigField(page, "run").fill("");
		return "task detail kept; same-request reselect keeps the signature (N-8); no decision";
	});

	await run.case("BRW-R-03", async () => {
		const ta = "R03 Request A";
		const tb = "R03 Request B";
		const ida = await submitNew(page, { title: ta });
		const idb = await submitNew(page, { title: tb });
		const reqA = await openRequest(page, "run", ta);
		let released = false;
		await page.route(
			`**/approval-requests/${reqA}/challenge`,
			async (route) => {
				await sleep(1800);
				released = true;
				await route.continue().catch(() => undefined);
			},
		);
		const fA = sigField(page, "run");
		await fA.click();
		await fA.pressSequentially("Edward", { delay: 10 });
		await region(page, "Approval inbox")
			.getByRole("button", {
				name: new RegExp(`^${escapeRe(`${GATE_NAME.run} · ${tb}`)}`),
			})
			.click();
		const docB = page.locator(
			`section[aria-label="Approval document"][data-gate="execution"]`,
		);
		await until(
			async () => (await docB.getAttribute("data-request-id")) !== reqA,
			"B open",
		);
		const reqB = (await docB.getAttribute("data-request-id")) ?? "";
		check(
			(await sigField(page, "run").inputValue()) === "",
			"field not empty on B",
		);
		await until(() => released, "A challenge released", 5000);
		await sleep(700);
		check(
			(await sigField(page, "run").inputValue()) === "",
			"A's late challenge restored text on B",
		);
		check(
			!(await grantButton(page, "run").isEnabled()),
			"B enabled without typing",
		);
		await page.unrouteAll({ behavior: "ignoreErrors" });
		const t0 = Date.now();
		await typeSignature(page, "run");
		await grantButton(page, "run").click();
		await until(
			async () => /Execution approved/.test(await decisionStatus(page)),
			"B approved",
		);
		const p = await posts(traffic, reqB, t0);
		const bindB = reqs(idb).find((r) => r.id === reqB)?.binding_hash;
		check(p.length === 1, `${p.length} POSTs for B`);
		check(
			(JSON.parse(p[0]?.body ?? "{}") as { binding_hash?: string })
				.binding_hash === bindB,
			"POST binding ≠ B",
		);
		check((await posts(traffic, reqA, t0)).length === 0, "a POST went to A");
		check(decisionsFor(reqA) === 0, "A decided");
		check(
			reqs(ida).find((r) => r.id === reqA)?.status === "pending",
			"A not pending",
		);
		check(decisionsFor(reqB) === 1, "B decisions ≠ 1");
		return undefined;
	});

	await run.case("BRW-R-08", async () => {
		check(J01, "J-01 missing");
		await openTask(page, J01.id);
		const arts = artifactsOf(J01.managed);
		const diff = arts.find((a) => a.kind === "diff");
		const man = arts.find((a) => a.kind === "manifest");
		check(diff && man, "artifacts missing");
		const ev = region(page, "Task detail").getByRole("region", {
			name: "Evidence",
		});
		await page.route(`**/artifacts/${diff.id}`, async (route) => {
			await sleep(1500);
			await route.continue().catch(() => undefined);
		});
		// (a) close before the late answer
		await ev.getByRole("button", { name: diff.name, exact: true }).click();
		const d1 = page.getByRole("dialog", { name: `Evidence: ${diff.name}` });
		await d1.waitFor();
		await d1.getByRole("button", { name: "Close evidence" }).click();
		await sleep(2000);
		check(
			(await page.getByRole("dialog").count()) === 0,
			"closed viewer reopened",
		);
		// (b) late diff vs newer manifest
		await ev.getByRole("button", { name: diff.name, exact: true }).click();
		await page
			.getByRole("dialog", { name: `Evidence: ${diff.name}` })
			.getByRole("button", { name: "Close evidence" })
			.click();
		await ev.getByRole("button", { name: man.name, exact: true }).click();
		const d2 = await evidenceViewerOpen(page, man.name);
		await sleep(2000);
		check(
			(await page.getByRole("dialog").getAttribute("aria-label")) ===
				`Evidence: ${man.name}`,
			"late diff replaced the manifest",
		);
		// (c) Escape closes; focus returns to the opener
		await page.keyboard.press("Escape");
		await d2.waitFor({ state: "detached" });
		const focused = (await page.evaluate(
			() => document.activeElement?.textContent ?? "",
		)) as string;
		check(focused.trim() === man.name, `focus on "${focused.trim()}"`);
		await page.unrouteAll({ behavior: "ignoreErrors" });
		return undefined;
	});

	await run.case("BRW-R-09", async () => {
		const reqT = "R19 Second request";
		/** The subject on screen must be the one the URL names (or none). */
		const consistent = async (): Promise<string> => {
			const h = decodeURIComponent(
				(await page.evaluate(() => location.hash)) as string,
			);
			const wsa = /wsa-[0-9a-f-]{36}/.exec(h)?.[0];
			const wst = /wst-[0-9a-f-]{36}/.exec(h)?.[0];
			if (wsa) {
				await page
					.locator(
						`section[aria-label="Approval document"][data-request-id="${wsa}"]`,
					)
					.waitFor({ timeout: 6000 });
				return `hq:${wsa === r1 ? "R1" : "other"}`;
			}
			if (wst && h.startsWith("#/projects")) {
				await page
					.locator(`section[aria-label="Task detail"][data-task-id="${wst}"]`)
					.waitFor({ timeout: 6000 });
				return `task:${wst === A ? "A" : wst === B ? "B" : "other"}`;
			}
			check(
				(await page
					.locator("section[aria-label='Task detail'][data-task-id]")
					.count()) === 0,
				`URL ${h} names no task but a task detail is shown`,
			);
			return h.startsWith("#/hq") ? "hq:none" : "projects:none";
		};
		await openTask(page, A);
		const r1 = await openRequest(page, "run", reqT);
		await typeSignature(page, "run");
		await openTask(page, B);
		const back: string[] = [];
		let reachedR1 = false;
		for (let i = 0; i < 8 && !reachedR1; i++) {
			await page.goBack();
			await sleep(300);
			const st = await consistent();
			back.push(st);
			if (st === "hq:R1") {
				reachedR1 = true;
				check(
					(await sigField(page, "run").inputValue()) === "",
					"signature restored on Back",
				);
			}
		}
		check(reachedR1, `Back never reached R1: ${back.join(" ← ")}`);
		const fwd: string[] = [];
		for (let i = 0; i < 8; i++) {
			await page.goForward();
			await sleep(300);
			const st = await consistent();
			fwd.push(st);
			if (st === "hq:R1")
				check(
					(await sigField(page, "run").inputValue()) === "",
					"signature restored on Forward",
				);
			if (st === "task:B") break;
		}
		check(
			fwd.at(-1) === "task:B",
			`Forward did not return to B: ${fwd.join(" → ")}`,
		);
		return `Back: ${back.join(" ← ")}; Forward: ${fwd.join(" → ")}; URL ↔ subject consistent; no signature restored`;
	});

	await run.case("BRW-R-10", async () => {
		const t = "R10 Back during decision";
		const id = await submitNew(page, { title: t });
		const req = await openRequest(page, "run", t);
		await typeSignature(page, "run");
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		await page.route(`**/approval-requests/${req}/decisions`, async (route) => {
			await gate;
			await route.continue().catch(() => undefined);
		});
		const t0 = Date.now();
		await grantButton(page, "run").click();
		await page.goBack();
		await sleep(400);
		const hBack = (await page.evaluate(() => location.hash)) as string;
		release();
		await sleep(2500);
		const shownElsewhere = await page
			.getByText("Execution approved. The execution is queued.")
			.count();
		await page.unrouteAll({ behavior: "ignoreErrors" });
		check(decisionsFor(req) === 1, `DB decisions ${decisionsFor(req)}`);
		check((await posts(traffic, req, t0)).length === 1, "second POST");
		check(approvedRuns(id) === 1, "approved runs");
		check(
			hBack.includes(req) ? true : shownElsewhere === 0,
			"outcome shown on another subject",
		);
		return `after Back at ${hBack.replace(/wst-[0-9a-f-]+|wsa-[0-9a-f-]+/g, "<id>")}; 1 decision`;
	});

	await run.case("BRW-R-11", async () => {
		// (a) committed, then reload before the answer
		const ta = "R11a Reload after commit";
		const ida = await submitNew(page, { title: ta });
		const reqA = await openRequest(page, "run", ta);
		await typeSignature(page, "run");
		let fetched = false;
		await page.route(
			`**/approval-requests/${reqA}/decisions`,
			async (route) => {
				await route.fetch().catch(() => null);
				fetched = true;
				await sleep(60_000).catch(() => undefined);
			},
		);
		await grantButton(page, "run").click();
		await until(() => fetched, "server reached");
		await page.unrouteAll({ behavior: "ignoreErrors" });
		const t1 = Date.now();
		await page.reload();
		await page.getByText(/^Signed in as operator:edward/).waitFor();
		await openTask(page, ida);
		await until(
			async () => (await stageText(page)) !== "Awaiting execution approval",
			"approved state after reload",
		);
		await sleep(1500);
		check(decisionsFor(reqA) === 1, "(a) decisions ≠ 1");
		check(approvedRuns(ida) === 1, "(a) approved runs ≠ 1");
		check(
			(await posts(traffic, reqA, t1)).length === 0,
			"(a) POST after reload",
		);
		// (b) aborted before the hub, then reload
		const tb = "R11b Reload after abort";
		const idb = await submitNew(page, { title: tb });
		const reqB = await openRequest(page, "run", tb);
		await typeSignature(page, "run");
		await page.route(`**/approval-requests/${reqB}/decisions`, (route) =>
			route.abort("connectionreset"),
		);
		await grantButton(page, "run").click();
		await sleep(600);
		await page.unrouteAll({ behavior: "ignoreErrors" });
		const t2 = Date.now();
		await page.reload();
		await page.getByText(/^Signed in as operator:edward/).waitFor();
		await openTask(page, idb);
		await sleep(2500);
		check(
			(await stageText(page)) === "Awaiting execution approval",
			"(b) not pending",
		);
		check(decisionsFor(reqB) === 0, "(b) decided");
		check((await posts(traffic, reqB, t2)).length === 0, "(b) auto resubmit");
		return `(a) approved once, 0 POSTs after reload; (b) still pending, 0 POSTs after reload (stage ${await stageText(page)})`;
	});

	await run.case("BRW-R-13", async () => {
		const t = "R13 Lost Gate1 response";
		const id = await submitNew(page, { title: t });
		const req = await openRequest(page, "run", t);
		await typeSignature(page, "run");
		let n = 0;
		await page.route(`**/approval-requests/${req}/decisions`, async (route) => {
			n += 1;
			if (n === 1) {
				await route.fetch().catch(() => null);
				await route.abort("connectionreset").catch(() => undefined);
				return;
			}
			await route.continue().catch(() => undefined);
		});
		const t0 = Date.now();
		await grantButton(page, "run").click();
		let sawUnknown = false;
		let clickedCheck = false;
		await until(
			async () => {
				const st = await decisionStatus(page);
				if (/Decision outcome unknown/.test(st)) sawUnknown = true;
				const chk = region(page, "Approval document").getByRole("button", {
					name: "Check decision outcome",
				});
				if (!clickedCheck && (await chk.count()) > 0) {
					clickedCheck = true;
					await chk.click();
				}
				return /Execution approved/.test(st);
			},
			"reconciled approved",
			20_000,
		);
		await page.unrouteAll({ behavior: "ignoreErrors" });
		await sleep(800);
		const p = await posts(traffic, req, t0);
		const bodies = new Set(p.map((x) => x.body));
		check(bodies.size === 1, `${bodies.size} distinct bodies`);
		check(decisionsFor(req) === 1, "decisions ≠ 1");
		check(approvedRuns(id) === 1, "executions ≠ 1");
		return `"Decision outcome unknown" shown=${sawUnknown}; Check clicked=${clickedCheck}; ${p.length} POST(s), byte-identical; 1 decision, 1 execution`;
	});

	await run.case("BRW-R-16", async () => {
		const t = "R16 Abort before hub then check";
		const id = await submitNew(page, { title: t });
		const req = await openRequest(page, "run", t);
		await typeSignature(page, "run");
		let n = 0;
		await page.route(`**/approval-requests/${req}/decisions`, async (route) => {
			n += 1;
			if (n === 1) return route.abort("connectionreset").catch(() => undefined);
			await route.continue().catch(() => undefined);
		});
		const t0 = Date.now();
		await grantButton(page, "run").click();
		const chk = region(page, "Approval document").getByRole("button", {
			name: "Check decision outcome",
		});
		await chk.waitFor({ timeout: 10_000 });
		check(
			/Decision outcome unknown/.test(await decisionStatus(page)),
			"unknown not shown",
		);
		check(
			(await sigField(page, "run").inputValue()) === "",
			"signature kept while unknown",
		);
		check(
			!(await grantButton(page, "run").isEnabled()),
			"Approve enabled while unknown",
		);
		await chk.click();
		await until(
			async () => /Execution approved/.test(await decisionStatus(page)),
			"approved after check",
		);
		await page.unrouteAll({ behavior: "ignoreErrors" });
		const p = await posts(traffic, req, t0);
		check(new Set(p.map((x) => x.body)).size === 1, "bodies differ");
		check(decisionsFor(req) === 1, "decisions ≠ 1");
		check(approvedRuns(id) === 1, "executions ≠ 1");
		return `${p.length} POSTs, byte-identical; field cleared and Approve disabled while unknown`;
	});

	await run.case("BRW-R-20", async () => {
		const t = "R20 Error clears signature";
		const id = await submitNew(page, { title: t });
		const req = await openRequest(page, "run", t);
		await typeSignature(page, "run");
		let mode: "409" | "500" = "409";
		await page.route(`**/approval-requests/${req}/decisions`, (route) =>
			mode === "409"
				? route.fulfill({
						status: 409,
						contentType: "application/json",
						body: JSON.stringify({
							error: "stale_binding",
							message: "The binding changed.",
						}),
					})
				: route.fulfill({
						status: 500,
						contentType: "application/json",
						body: JSON.stringify({ error: "internal", message: "boom" }),
					}),
		);
		await dismissAlerts(page);
		await grantButton(page, "run").click();
		const alert = page.getByRole("main").getByRole("alert");
		await alert.waitFor();
		const a409 = await textOf(alert);
		observed.alertNext = observed.alertNext || /Next:/.test(a409);
		check(
			(await sigField(page, "run").inputValue()) === "",
			"field kept after 409",
		);
		check(decisionsFor(req) === 0, "decided");
		await dismissAlerts(page);
		mode = "500";
		await typeSignature(page, "run");
		await grantButton(page, "run").click();
		await sleep(1500);
		const st500 = await decisionStatus(page);
		const alerts500 = await page.getByRole("main").getByRole("alert").count();
		check(
			(await sigField(page, "run").inputValue()) === "",
			"field kept after 500",
		);
		check(decisionsFor(req) === 0, "decided after 500");
		check((await stageText(page).catch(() => "")) !== "Queued", "queued");
		await page.unrouteAll({ behavior: "ignoreErrors" });
		void id;
		return `409 alert: "${a409.slice(0, 80)}"; 500 → status "${st500.slice(0, 60)}", alerts ${alerts500}`;
	});

	await run.case("BRW-R-23", async () => {
		const t = "R23 Invalidated by another tab";
		const id = await submitNew(page, { title: t });
		const oldReq = await openRequest(page, "run", t);
		await typeSignature(page, "run");
		const p2 = await s.context.newPage();
		const tr2: Traffic = {
			decisionPosts: [],
			mutations: [],
			workspaceApiHits: 0,
			wsFrames: [],
		};
		attachPage(run, p2, env.uiUrl, tr2);
		await p2.goto(`${env.uiUrl}/#/projects`);
		await p2.getByText(/^Signed in as operator:edward/).waitFor();
		await openTask(p2, id);
		await region(p2, "Task detail")
			.getByRole("button", { name: "Edit draft" })
			.click();
		await region(p2, "Task detail")
			.getByLabel("Objective", { exact: true })
			.fill("Changed in another tab.");
		await region(p2, "Task detail")
			.getByRole("button", { name: "Submit for run approval" })
			.click();
		await until(
			async () => (await textOf(p2.getByTestId("proposal-version"))) === "2",
			"v2 in tab 2",
		);
		run.current = page;
		// page 1's poll can disable Approve between this check and the click; then the click has
		// nothing to act on, which must be because Approve is now disabled (checked, not ignored)
		const enabled = await grantButton(page, "run")
			.isEnabled()
			.catch(() => false);
		const clicked = enabled
			? await grantButton(page, "run")
					.click({ timeout: 3_000 })
					.then(
						() => true,
						() => false,
					)
			: false;
		if (enabled && !clicked)
			check(
				!(await grantButton(page, "run")
					.isEnabled({ timeout: 1_000 })
					.catch(() => false)),
				"page 1 Approve is still enabled but could not be clicked",
			);
		await sleep(2500);
		const alertTxt = (await page.getByRole("main").getByRole("alert").count())
			? await textOf(page.getByRole("main").getByRole("alert"))
			: "";
		const docStatus = await page
			.locator(
				`section[aria-label="Approval document"][data-request-id="${oldReq}"]`,
			)
			.getAttribute("data-request-status")
			.catch(() => null);
		check(decisionsFor(oldReq) === 0, "old request decided");
		check(approvedRuns(id) === 0, "something queued");
		check(
			(await sigField(page, "run").count()) === 0 ||
				(await sigField(page, "run").inputValue()) === "",
			"signature kept on the invalidated request",
		);
		await p2.close();
		return `clicked before poll=${clicked} (enabled at check=${enabled}); alert "${alertTxt.slice(0, 70)}"; old document status=${docStatus}`;
	});

	await run.case("BRW-R-24", async () => {
		const t = "R24 Same request two tabs";
		const id = await submitNew(page, { title: t });
		const req = await openRequest(page, "run", t);
		await typeSignature(page, "run");
		const p2 = await s.context.newPage();
		const tr2: Traffic = {
			decisionPosts: [],
			mutations: [],
			workspaceApiHits: 0,
			wsFrames: [],
		};
		attachPage(run, p2, env.uiUrl, tr2);
		await p2.goto(`${env.uiUrl}/#/hq/${id}/${req}`);
		await p2.getByText(/^Signed in as operator:edward/).waitFor();
		await sigField(p2, "run").waitFor();
		await typeSignature(p2, "run");
		await grantButton(p2, "run").click();
		await until(
			async () => /Execution approved/.test(await decisionStatus(p2)),
			"tab 2 approved",
		);
		run.current = page;
		// Tab 1 may learn of tab 2's decision between this check and the click (its poll replaces
		// Approve with the decided note): then nothing is left to click, which is verified below
		// rather than ignored. Either way tab 1 must end up showing the request decided or refused.
		const enabled = await grantButton(page, "run")
			.isEnabled()
			.catch(() => false);
		const clicked = enabled
			? await grantButton(page, "run")
					.click({ timeout: 3_000 })
					.then(
						() => true,
						() => false,
					)
			: false;
		if (enabled && !clicked)
			check(
				!(await grantButton(page, "run")
					.isEnabled({ timeout: 1_000 })
					.catch(() => false)),
				"tab 1 Approve is still enabled but could not be clicked",
			);
		await sleep(2500);
		check(decisionsFor(req) === 1, `decisions ${decisionsFor(req)}`);
		check(approvedRuns(id) === 1, "executions ≠ 1");
		const st = await decisionStatus(page).catch(() => "");
		const docStatus = await page
			.locator(
				`section[aria-label="Approval document"][data-request-id="${req}"]`,
			)
			.getAttribute("data-request-status", { timeout: 1_000 })
			.catch(() => null);
		check(
			docStatus === "approved" || /no longer open/i.test(st),
			`tab 1 shows neither the decided request nor a refusal (status=${docStatus}; "${st.slice(0, 70)}")`,
		);
		await p2.close();
		return `tab 1 Approve enabled at check=${enabled}, clicked=${clicked}; tab 1 request status=${docStatus}; decision status "${st.slice(0, 70)}"; 1 decision`;
	});

	await run.case("BRW-R-25", async () => {
		const t = "R25 Offline";
		await submitNew(page, { title: t });
		const req = await openRequest(page, "run", t);
		await typeSignature(page, "run");
		let offline = true;
		const before = traffic.mutations.length;
		await page.route("**/api/workspace/**", (route) =>
			offline ? route.abort("connectionrefused") : route.continue(),
		);
		await until(
			async () =>
				/Offline/.test(
					await textOf(page.getByRole("status", { name: "Connection" })),
				),
			"offline shown",
			10_000,
		);
		observed.offlineShown = true;
		const f = sigField(page, "run");
		const val = await f.inputValue();
		const dis = !(await f.isEnabled());
		const grantDis = !(await grantButton(page, "run").isEnabled());
		await run.shot(page, "R25-offline");
		await sleep(3000);
		const writes = traffic.mutations.length - before;
		offline = false;
		await page.unrouteAll({ behavior: "ignoreErrors" });
		await until(
			async () =>
				/^Online/.test(
					await textOf(page.getByRole("status", { name: "Connection" })),
				),
			"online again",
			10_000,
		);
		check(val === "", "signature kept offline");
		check(dis, "signature field enabled offline");
		check(grantDis, "Approve enabled offline");
		check(writes === 0, `${writes} write(s) while offline`);
		check((await f.inputValue()) === "", "signature restored after reconnect");
		check(decisionsFor(req) === 0, "decided");
		return "offline: stale label, field cleared+disabled, Approve disabled, 0 writes; online: field empty";
	});

	await run.case("BRW-R-26", async () => {
		const t = "R26 Stale snapshot";
		const id = await submitNew(page, { title: t });
		await approveRun(page, t);
		let held = false;
		await page.route(`**/api/workspace/tasks/${id}`, async (route) => {
			if (!held) {
				held = true;
				const resp = await route.fetch().catch(() => null);
				await sleep(5000);
				if (resp)
					await route.fulfill({ response: resp }).catch(() => undefined);
				return;
			}
			await route.continue().catch(() => undefined);
		});
		await openTask(page, id).catch(() => undefined);
		await page
			.locator(`section[aria-label="Task detail"][data-task-id="${id}"]`)
			.waitFor({ timeout: 20_000 });
		await page.evaluate(() => {
			const w = window as unknown as { __revs: number[] };
			w.__revs = [];
			const rec = () => {
				const el = document.querySelector('section[aria-label="Task detail"]');
				const r = Number(el?.getAttribute("data-rev") ?? "NaN");
				if (Number.isFinite(r)) w.__revs.push(r);
			};
			rec();
			new MutationObserver(rec).observe(document.body, {
				subtree: true,
				attributes: true,
				attributeFilter: ["data-rev"],
				childList: true,
			});
		});
		await waitStage(page, "Awaiting acceptance", 60_000);
		await sleep(6000);
		const revs = (await page.evaluate(
			() => (window as unknown as { __revs: number[] }).__revs,
		)) as number[];
		await page.unrouteAll({ behavior: "ignoreErrors" });
		const dec = revs.some((r, i) => i > 0 && r < (revs[i - 1] ?? 0));
		check(!dec, `rev decreased: ${revs.join(",")}`);
		check((await stageText(page)) === "Awaiting acceptance", "stage regressed");
		return `revs observed ${[...new Set(revs)].join("→")}`;
	});

	await run.case("BRW-R-27", async () => {
		await openTask(page, A);
		let n = 0;
		await page.route("**/api/workspace/snapshot", async (route) => {
			n += 1;
			if (n === 1) {
				await sleep(4500);
				await route
					.fulfill({
						status: 503,
						contentType: "application/json",
						body: JSON.stringify({ error: "disabled", message: "x" }),
					})
					.catch(() => undefined);
				return;
			}
			await route.continue().catch(() => undefined);
		});
		await sleep(9000);
		const conn = await textOf(page.getByRole("status", { name: "Connection" }));
		const detail = await page
			.locator(`section[aria-label="Task detail"][data-task-id="${A}"]`)
			.count();
		await page.unrouteAll({ behavior: "ignoreErrors" });
		check(detail === 1, "detail lost after the late error");
		check(
			(await page.getByText(/^Signed in as operator:edward/).count()) === 1,
			"signed out by a late error",
		);
		return `connection after late 503: "${conn.replace(/\d\d:\d\d:\d\d/, "hh:mm:ss")}"; detail kept`;
	});
	await close(s);
}

/** R-06 in its own session: a broken session must not cascade into other race cases. */
async function authGenerationCases(): Promise<void> {
	const s = await open();
	const { page } = s;
	r06Traffic.add(s.traffic);
	let n = 0;
	/** A write must still work in the current session (Save draft of a new task). */
	const writeWorks = async (): Promise<string> => {
		n += 1;
		await composeNew(page, { title: `R06 write check ${n}` });
		await region(page, "Task detail")
			.getByRole("button", { name: "Save draft" })
			.click();
		try {
			await until(
				async () =>
					(await textOf(page.getByRole("status", { name: "Save status" }))) ===
					"Draft saved",
				"Draft saved",
				6000,
			);
			return "ok";
		} catch {
			await run.shot(page, `R06-write-failed-${n}`).catch(() => undefined);
			const st = await textOf(
				page.getByRole("status", { name: "Save status" }),
			);
			const al = (await page.getByRole("main").getByRole("alert").count())
				? await textOf(page.getByRole("main").getByRole("alert"))
				: "";
			const writes = [...run.apiLog.entries()]
				.filter(([k]) => /^POST \/api\/workspace\/tasks 403/.test(k))
				.map(([k, v]) => `${k}×${v}`)
				.join(",");
			return `FAILED (save status "${st.slice(0, 60)}", alert "${al.slice(0, 80)}", ${writes})`;
		}
	};
	/** Sign out, wait for DELETE /session to finish, sign in again (clean recovery). */
	const cleanResignIn = async () => {
		const del = page.waitForResponse(
			(r) =>
				r.url().endsWith("/api/workspace/session") &&
				r.request().method() === "DELETE",
		);
		await page.getByRole("button", { name: "Sign out" }).click();
		await del.catch(() => undefined);
		await signIn(page, env.credential);
		await captureSessionSecrets(s);
	};
	const A = await (async () => {
		await composeNew(page, { title: "R06 Task X" });
		await region(page, "Task detail")
			.getByRole("button", { name: "Save draft" })
			.click();
		await until(async () => (await taskIdFromUrl(page)) !== "", "X");
		return taskIdFromUrl(page);
	})();

	await run.case("BRW-R-06.a", async () => {
		// late answer of the old generation; DELETE /session completes before the new sign-in
		await selectRepo(page, env.repoId);
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let held = 0;
		await page.route(`**/api/workspace/tasks/${A}`, async (route) => {
			held += 1;
			const resp = await route.fetch().catch(() => null);
			await gate;
			if (resp) await route.fulfill({ response: resp }).catch(() => undefined);
			else await route.abort().catch(() => undefined);
		});
		await region(page, "Tasks").locator(`[data-task-id="${A}"]`).click();
		await until(() => held > 0, "held request");
		await cleanResignIn();
		release();
		await sleep(1800);
		const shown = await page
			.locator(`section[aria-label="Task detail"][data-task-id="${A}"]`)
			.count();
		await page.unrouteAll({ behavior: "ignoreErrors" });
		check(shown === 0, "session-1 answer rendered under session 2");
		const w = await writeWorks();
		check(w === "ok", `write after re-sign-in: ${w}`);
		return "late session-1 answer dropped; writes work in session 2";
	});

	await run.case("BRW-R-06.b", async () => {
		// operator-speed Sign out → Sign in (no wait for DELETE /session to answer)
		await page.getByRole("button", { name: "Sign out" }).click();
		await signIn(page, env.credential);
		await captureSessionSecrets(s);
		await sleep(1500);
		const w = await writeWorks();
		if (w !== "ok") await cleanResignIn();
		check(w === "ok", `write after a fast sign-out/sign-in: ${w}`);
		return "writes work after a fast sign-out/sign-in";
	});

	await run.case("BRW-R-06.c", async () => {
		// a delayed 401 that belongs to the old generation arrives after the new sign-in
		let release2!: () => void;
		const gate2 = new Promise<void>((r) => {
			release2 = r;
		});
		let held2 = 0;
		await page.route("**/api/workspace/snapshot", async (route) => {
			if (held2 > 0) return route.continue().catch(() => undefined);
			held2 += 1;
			await gate2;
			await route
				.fulfill({
					status: 401,
					contentType: "application/json",
					body: JSON.stringify({
						error: "unauthenticated",
						message: "Authentication required.",
					}),
				})
				.catch(() => undefined);
		});
		await until(() => held2 > 0, "held snapshot", 6000);
		await cleanResignIn();
		release2();
		await sleep(2500);
		await page.unrouteAll({ behavior: "ignoreErrors" });
		const still =
			(await page.getByText(/^Signed in as operator:edward/).count()) === 1;
		const w = await writeWorks();
		if (w !== "ok") {
			// does Sign out in this state end the server session? Probe the old cookie directly
			// (value kept in memory only, never printed).
			const old = (await s.context.cookies()).find(
				(c) => c.name === "agentcity_ws_session",
			);
			const del = page.waitForResponse(
				(r) =>
					r.url().endsWith("/api/workspace/session") &&
					r.request().method() === "DELETE",
			);
			await page.getByRole("button", { name: "Sign out" }).click();
			const delStatus = (await del.catch(() => null))?.status() ?? -1;
			const probe = old
				? (
						await fetch(`${env.uiUrl}/api/workspace/session`, {
							headers: { cookie: `${old.name}=${old.value}` },
						})
					).status
				: -1;
			run.notes.push(
				`F-1 follow-up: Sign out in the broken state → DELETE /session ${delStatus}; GET /session with the pre-sign-out cookie afterwards → ${probe} (200 = server session still alive)`,
			);
			await signIn(page, env.credential);
			await captureSessionSecrets(s);
		}
		check(still, "late 401 signed the new session out");
		check(w === "ok", `UI still signed in, but write after the late 401: ${w}`);
		return "late 401 ignored; writes still work";
	});
	await close(s);
}

async function cancelCases(): Promise<void> {
	const s = await open();
	const { page } = s;
	await run.case("BRW-J-15", async () => {
		const t = "J15 Cancel requested vs confirmed";
		const id = await submitNew(page, { title: t, scenario: "impl_hangs" });
		await approveRun(page, t);
		await openTask(page, id);
		await waitEngine(page, ["executing"], 60_000);
		await page.evaluate(() => {
			const w = window as unknown as { __seq: string[] };
			w.__seq = [];
			const rec = () => {
				const c =
					document
						.querySelector('[data-testid="cancellation-status"]')
						?.getAttribute("data-status") ?? "-";
				const e =
					document
						.querySelector('[data-testid="engine-state"]')
						?.getAttribute("data-state") ?? "-";
				const st =
					document.querySelector('[data-testid="current-stage"]')
						?.textContent ?? "-";
				const v = `${c}|${e}|${st}`;
				if (w.__seq.at(-1) !== v) w.__seq.push(v);
			};
			rec();
			new MutationObserver(rec).observe(document.body, {
				subtree: true,
				attributes: true,
				childList: true,
				characterData: true,
			});
		});
		await region(page, "Task detail")
			.getByRole("button", { name: "Cancel execution" })
			.click();
		await until(
			async () =>
				(await attr(page, "cancellation-status", "data-status")) ===
				"confirmed",
			"confirmed",
			30_000,
		);
		await waitStage(page, "Cancelled", 20_000);
		const seq = (await page.evaluate(
			() => (window as unknown as { __seq: string[] }).__seq,
		)) as string[];
		const active = [
			"queued",
			"executing",
			"verifying",
			"reviewing",
			"repairing",
		];
		const early = seq.filter((x) => {
			const [c, e, st] = x.split("|");
			return (
				(c === "confirmed" || st === "Cancelled") &&
				active.includes(e ?? "") === true
			);
		});
		const requestedSeen = seq.some((x) => x.startsWith("requested|"));
		check(
			early.length === 0,
			`cancelled/confirmed while engine active: ${early.join(" ; ")}`,
		);
		check(
			(await attr(page, "engine-state", "data-state")) === "cancelled",
			"engine not cancelled",
		);
		check(
			(await region(page, "Task detail")
				.getByRole("button", { name: "Open result acceptance" })
				.count()) === 0,
			"acceptance offered",
		);
		check(taskRow(id)?.stage === "cancelled", "DB stage");
		await run.shot(page, "J15-cancelled");
		return `"requested" observed=${requestedSeen}; sequence: ${seq.join(" → ")}`;
	});

	await run.case("BRW-P-06", async () => {
		const t = "P06 Cancel then reload";
		const id = await submitNew(page, { title: t, scenario: "impl_hangs" });
		await approveRun(page, t);
		await openTask(page, id);
		await waitEngine(page, ["executing"], 60_000);
		await region(page, "Task detail")
			.getByRole("button", { name: "Cancel execution" })
			.click();
		await page.reload();
		await page
			.locator(`section[aria-label="Task detail"][data-task-id="${id}"]`)
			.waitFor();
		const c = await attr(page, "cancellation-status", "data-status");
		const e = await attr(page, "engine-state", "data-state");
		const st = await stageText(page);
		check(
			!(st === "Cancelled" && e !== "cancelled"),
			"Cancelled shown while the engine is not cancelled",
		);
		await until(
			async () =>
				(await attr(page, "cancellation-status", "data-status")) ===
				"confirmed",
			"confirmed",
			30_000,
		);
		if (c !== "requested")
			throw new Error(
				`NOT-RUN: requested window closed before the reload finished (first read after reload: cancellation=${c}, engine=${e}, stage=${st}); ordering held`,
			);
		return `after reload: cancellation=${c}, engine=${e}, stage=${st}; later confirmed`;
	});
	await close(s);
}

async function inboxCases(): Promise<void> {
	const s = await open();
	const { page, traffic } = s;
	await run.case("BRW-J-19", async () => {
		// make sure at least one result request is pending
		await toResult(s, "J19 Result pending");
		const total = await pendingCount(page);
		const dbPending = pendingInDb();
		check(total === dbPending, `count ${total} vs DB ${dbPending}`);
		const names = await inboxNames(page);
		check(
			names.length === total,
			`inbox items ${names.length} vs count ${total}`,
		);
		check(total >= 3, `only ${total} pending`);
		const inbox = region(page, "Approval inbox");
		await inbox.getByLabel("Gate").selectOption("result");
		const nRes = await inbox.locator("button[data-request-id]").count();
		const dbRes =
			db1<{ n: number }>(
				"SELECT count(*) AS n FROM managed_approval_requests WHERE status='pending' AND kind='result'",
			)?.n ?? -1;
		check(nRes === dbRes, `result filter ${nRes} vs ${dbRes}`);
		await inbox.getByLabel("Gate").selectOption("run");
		const nRun = await inbox.locator("button[data-request-id]").count();
		check(nRun === total - dbRes, `run filter ${nRun}`);
		await inbox.getByLabel("Gate").selectOption("all");
		await inbox.getByRole("searchbox", { name: "Search" }).fill("J19 Result");
		check(
			(await inbox.locator("button[data-request-id]").count()) === 1,
			"search ≠ 1",
		);
		await inbox.locator("button[data-request-id]").first().click();
		await region(page, "Approval document").waitFor();
		check(
			(await inbox.locator('button[aria-current="true"]').count()) === 1,
			"more than one current",
		);
		await inbox.getByRole("searchbox", { name: "Search" }).fill("");
		// history fields on a task with a request-changes decision (J-04)
		await page.goto(`${env.uiUrl}/#/projects`);
		const j04 = db1<{ id: string }>(
			"SELECT id FROM workspace_tasks WHERE json_extract(draft,'$.title') = 'J04 Gate1 request changes'",
		);
		check(j04, "J-04 task missing");
		const req2 = reqs(j04.id).find((r) => r.status === "pending");
		check(req2, "J-04 v2 request missing");
		await page.goto(`${env.uiUrl}/#/hq/${j04.id}/${req2.id}`);
		const hist = region(page, "Decision history");
		await hist.locator("li").first().waitFor();
		const ht = (await hist.textContent()) ?? "";
		for (const k of [
			"operator:edward",
			"execution",
			"request changes",
			"Reason: Please narrow the scope",
			"UTC",
		])
			check(ht.includes(k), `history lacks "${k}"`);
		await run.shot(page, "J19-hq-history");
		void traffic;
		return `pending ${total} = DB; result filter ${nRes}; run filter ${nRun}; search 1; history has actor/gate/action/reason/time`;
	});

	await run.case("BRW-J-18", async () => {
		check(
			(await attr(page, "provenance", "data-source")) === "hub" &&
				(await attr(page, "provenance", "data-mode")) === "simulated" &&
				(await attr(page, "provenance", "data-integration")) === "unverified",
			"provenance",
		);
		await composeNew(page, { title: "J18 Provenance check" });
		const opts = (await region(page, "Task detail")
			.getByLabel("Simulation scenario")
			.locator("option")
			.allTextContents()) as string[];
		check(!opts.some((o) => /live/i.test(o)), "a Live option exists");
		const panelTxt = (await region(page, "Task detail").textContent()) ?? "";
		check(
			panelTxt.includes("Live execution is disabled in this milestone."),
			"live-disabled copy missing",
		);
		await region(page, "Task detail")
			.getByRole("button", { name: "Discard draft" })
			.click();
		await navLink(page, /^Activity$/).click();
		const act = region(page, "Activity");
		await act.waitFor();
		check(((await act.textContent()) ?? "").includes("Observed only"), "label");
		const bad = await act
			.getByRole("button", {
				name: /approve|accept|cancel execution|assign work|request changes|reject|queue/i,
			})
			.count();
		check(bad === 0, `${bad} control(s) in Activity`);
		return `scenario options: ${opts.length}, none live; Activity "Observed only" with 0 workflow controls`;
	});

	await run.case("BRW-S-04", async () => {
		// stay on Activity (opens /ws) while another session runs a pipeline
		const before = traffic.wsFrames.length;
		const other = await open();
		await toResult(other, "S04 Pipeline while observing");
		await close(other);
		run.current = page;
		await sleep(1500);
		const frames = traffic.wsFrames.slice(before);
		const ids = [
			...db("SELECT id FROM workspace_tasks").map((r) => String(r.id)),
			...db("SELECT id FROM managed_tasks").map((r) => String(r.id)),
			...db("SELECT id FROM managed_approval_requests").map((r) =>
				String(r.id),
			),
			...db("SELECT id FROM managed_runs").map((r) => String(r.id)),
		];
		const hits = frames.filter((f) => ids.some((i) => f.includes(i)));
		const managedKind = frames.filter((f) => /"managed"/.test(f));
		check(hits.length === 0, `${hits.length} /ws frame(s) carry workflow ids`);
		check(managedKind.length === 0, "managed frames on /ws");
		return `${frames.length} /ws frame(s) during a pipeline; 0 carry workflow ids or managed kinds`;
	});
	await close(s);
}

// ── accessibility / layout ──────────────────────────────────────────────────

interface Focused {
	tag: string;
	text: string;
	label: string;
	id: string;
	role: string;
}

async function focused(page: Page): Promise<Focused> {
	return (await page.evaluate(() => {
		const el = document.activeElement as HTMLElement | null;
		if (!el) return { tag: "", text: "", label: "", id: "", role: "" };
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
		};
	})) as Focused;
}

/** Keyboard only: Tab (or Shift+Tab first when `back`) until `match`; then tries the other way. */
async function tabTo(
	page: Page,
	match: (f: Focused) => boolean,
	what: string,
	max = 90,
	back = false,
): Promise<number> {
	let presses = 0;
	for (const dir of back ? ["Shift+Tab", "Tab"] : ["Tab", "Shift+Tab"]) {
		for (let i = 0; i < max; i++) {
			await page.keyboard.press(dir);
			presses += 1;
			const f = await focused(page);
			if (match(f)) return presses;
		}
	}
	throw new Error(`Tab never reached ${what}`);
}

async function a11yCases(): Promise<void> {
	const s = await open();
	const { page } = s;
	const mouseClicks: number[] = [];
	await page.exposeFunction("__09click", () => mouseClicks.push(Date.now()));
	await page.evaluate(() => {
		document.addEventListener(
			"mousedown",
			() => (window as unknown as { __09click: () => void }).__09click(),
			true,
		);
	});

	let kbTask = "";
	const kbTitle = "A05 Keyboard draft";
	await run.case("BRW-A-05", async () => {
		await page.goto(`${env.uiUrl}/#/projects`);
		await page.reload();
		await page.getByText(/^Signed in as operator:edward/).waitFor();
		await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
		await page.keyboard.press("Tab");
		const first = await focused(page);
		check(
			first.text === "Skip to task panel",
			`first focusable: "${first.text}"`,
		);
		await page.keyboard.press("Enter");
		const afterSkip = await focused(page);
		check(afterSkip.id === "wsm1-panel-title", `skip → ${afterSkip.id}`);
		await tabTo(
			page,
			(f) => f.text.includes(env.repoId),
			"repo button",
			40,
			true,
		);
		await page.keyboard.press("Enter");
		await tabTo(page, (f) => f.text === "Assign work", "Assign work");
		await page.keyboard.press("Enter");
		await tabTo(page, (f) => f.label === "Title", "Title");
		await page.keyboard.type(kbTitle);
		await tabTo(page, (f) => f.label === "Objective", "Objective");
		await page.keyboard.type("Typed with the keyboard only.");
		await tabTo(page, (f) => f.label === "Acceptance criteria", "criteria");
		await page.keyboard.type("Keyboard first, comma kept");
		await page.keyboard.press("Enter");
		await page.keyboard.type("Second criterion");
		const v = await region(page, "Task detail")
			.getByRole("textbox", { name: "Acceptance criteria" })
			.inputValue();
		check(
			v === "Keyboard first, comma kept\nSecond criterion",
			"Enter did not add a newline",
		);
		// v1.2: map each criterion with the keyboard (Tab to its check box, Space)
		const checkName = (
			(await criterionGroups(page)
				.first()
				.getByRole("checkbox")
				.first()
				.evaluate(
					(el) => (el as HTMLInputElement).labels?.[0]?.textContent ?? "",
				)) as string
		).trim();
		for (const n of [1, 2]) {
			await tabTo(
				page,
				(f) => f.tag === "input" && f.label === checkName,
				`criterion ${n} check box`,
			);
			await page.keyboard.press("Space");
		}
		const kbMapped = await criterionGroups(page).evaluateAll((gs) =>
			gs.map((g) => g.getAttribute("data-mapped")),
		);
		check(
			JSON.stringify(kbMapped) === '["true","true"]',
			`keyboard mapping ${JSON.stringify(kbMapped)}`,
		);
		await tabTo(page, (f) => f.text === "Save draft", "Save draft");
		await page.keyboard.press("Enter");
		await until(
			async () =>
				(await textOf(page.getByRole("status", { name: "Save status" }))) ===
				"Draft saved",
			"saved",
		);
		await tabTo(page, (f) => f.text === "Submit for run approval", "Submit");
		await page.keyboard.press("Enter");
		await waitStage(page, "Awaiting execution approval");
		kbTask = await taskIdFromUrl(page);
		check(mouseClicks.length === 0, `${mouseClicks.length} mouse events`);
		return "skip link first; draft created/saved/submitted with keys only; Enter in criteria = newline";
	});

	await run.case("BRW-A-01", async () => {
		check(kbTask, "A-05 task missing");
		// budget 90 (the helper's default; was 60): the Projects pane now also holds the campus, which
		// costs exactly 3 stops (Headquarters button, document toolbar, building) ahead of the task list
		const hqPresses = await tabTo(
			page,
			(f) => f.text === "Headquarters",
			"Headquarters link",
			90,
			true,
		);
		await page.keyboard.press("Enter");
		await region(page, "Approval inbox").waitFor();
		await tabTo(
			page,
			(f) => f.text.startsWith(`Execution approval · ${kbTitle}`),
			"inbox item",
		);
		await page.keyboard.press("Enter");
		await region(page, "Approval document").waitFor();
		const afterOpen = await focused(page);
		await tabTo(
			page,
			(f) => f.label === "Type Edward to approve execution",
			"signature",
		);
		await page.keyboard.type("Edward", { delay: 15 });
		await page.keyboard.press("Enter"); // inert
		await until(
			async () => grantButton(page, "run").isEnabled(),
			"Approve enabled",
		);
		await page.keyboard.press("Tab");
		const f = await focused(page);
		check(f.text === "Approve execution", `Tab after field → "${f.text}"`);
		await page.keyboard.press("Space");
		await until(
			async () => /Execution approved/.test(await decisionStatus(page)),
			"approved",
		);
		const after = await focused(page);
		check(
			after.id === "wsm1-decision-status",
			`focus after decision: ${after.tag}#${after.id}`,
		);
		check(mouseClicks.length === 0, "mouse used");
		return `Headquarters link after ${hqPresses} key presses; focus after opening request: ${afterOpen.id || afterOpen.tag}; after decision: #${after.id}`;
	});

	await run.case("BRW-A-02", async () => {
		check(kbTask, "task missing");
		// wait for the result request (no mouse: poll the DB)
		await until(
			() =>
				reqs(kbTask).some((r) => r.kind === "result" && r.status === "pending"),
			"result request",
			90_000,
			400,
		);
		await sleep(2500);
		await tabTo(
			page,
			(f) => f.text === "Headquarters",
			"Headquarters link",
			80,
			true,
		);
		await page.keyboard.press("Enter");
		await tabTo(
			page,
			(f) => f.text.startsWith(`Result acceptance · ${kbTitle}`),
			"result inbox item",
		);
		await page.keyboard.press("Enter");
		await region(page, "Approval document").waitFor();
		await tabTo(
			page,
			(f) => f.tag === "button" && /\.(patch|json|log|txt)$/.test(f.text),
			"evidence item",
		);
		const opener = await focused(page);
		await page.keyboard.press("Enter");
		const d = page.getByRole("dialog");
		await d.waitFor();
		await page.keyboard.press("Escape");
		await d.waitFor({ state: "detached" });
		const back = await focused(page);
		check(back.id === opener.id, "focus did not return to the opener");
		await tabTo(
			page,
			(f) => f.label === "Type Edward to accept this result",
			"Gate-2 field",
		);
		await page.keyboard.type("Edward", { delay: 15 });
		await until(
			async () => grantButton(page, "result").isEnabled(),
			"Accept enabled",
		);
		await page.keyboard.press("Tab");
		check(
			(await focused(page)).text === "Accept result",
			"Tab → Accept result",
		);
		await page.keyboard.press("Enter");
		await until(
			async () =>
				(await attr(page, "acceptance-status", "data-status")) === "accepted",
			"accepted",
		);
		check(mouseClicks.length === 0, "mouse used");
		return "evidence opened/closed and result accepted with keys only (Enter on the button)";
	});

	await run.case("BRW-A-03", async () => {
		const inbox = region(page, "Approval inbox");
		await tabTo(page, (f) => f.label === "Gate", "Gate filter", 40, true);
		await page.keyboard.type("Res");
		await sleep(200);
		const gateVal = await inbox.getByLabel("Gate").inputValue();
		await tabTo(page, (f) => f.label === "Search", "Search");
		await page.keyboard.type("R03");
		const n = await inbox.locator("button[data-request-id]").count();
		await page.keyboard.press("Control+A");
		await page.keyboard.press("Backspace");
		await tabTo(page, (f) => f.text === "Projects", "Projects link", 60, true);
		await page.keyboard.press("Enter");
		await tabTo(page, (f) => f.text.includes(env.repoId), "repo", 30);
		await page.keyboard.press("Enter");
		await tabTo(page, (f) => f.text.startsWith(kbTitle), "task item", 80);
		await page.keyboard.press("Enter");
		await page
			.locator(`section[aria-label="Task detail"][data-task-id="${kbTask}"]`)
			.waitFor();
		const f = await focused(page);
		check(f.id === "wsm1-panel-title", `focus after selection: ${f.id}`);
		const cur = await region(page, "Tasks")
			.locator(`[data-task-id="${kbTask}"]`)
			.getAttribute("aria-current");
		check(cur === "true", "aria-current not set");
		check(mouseClicks.length === 0, "mouse used");
		return `gate filter by keys → "${gateVal}"; search "R03" → ${n} item(s); task selected by keys, focus on panel heading`;
	});

	await run.case("BRW-A-04", async () => {
		check(J01, "J-01 missing");
		await page.goto(`${env.uiUrl}/#/projects`);
		await openTask(page, J01.id);
		mouseClicks.length = 0;
		await page.locator("#wsm1-panel-title").focus();
		await tabTo(
			page,
			(f) => /^verify-.*\.log$/.test(f.text),
			"log artifact",
			120,
		);
		const opener = await focused(page);
		await page.keyboard.press("Enter");
		const d = page.getByRole("dialog");
		await d.waitFor();
		await until(
			async () => (await d.getAttribute("data-state")) === "ok",
			"loaded",
		);
		await tabTo(page, (f) => f.tag === "pre", "pre", 20);
		const pre = d.locator("pre");
		const before = (await pre.evaluate((e) => e.scrollTop)) as number;
		const scrollable = (await pre.evaluate(
			(e) => e.scrollHeight > e.clientHeight,
		)) as boolean;
		const body = d.locator(".wsm1-viewer-body");
		const bodyBefore = (await body.evaluate((e) => e.scrollTop)) as number;
		await page.keyboard.press("PageDown");
		await page.keyboard.press("ArrowDown");
		await sleep(300);
		const after = (await pre.evaluate((e) => e.scrollTop)) as number;
		const bodyAfter = (await body.evaluate((e) => e.scrollTop)) as number;
		await page.keyboard.press("Escape");
		await d.waitFor({ state: "detached" });
		const back = await focused(page);
		check(back.id === opener.id, "focus not returned");
		check(
			after > before || bodyAfter > bodyBefore || !scrollable,
			`keyboard did not scroll (pre ${before}→${after}, body ${bodyBefore}→${bodyAfter})`,
		);
		check(mouseClicks.length === 0, "mouse used");
		return `pre scrollable=${scrollable}; scrollTop pre ${before}→${after}, body ${bodyBefore}→${bodyAfter}; Escape returned focus`;
	});

	await run.case("BRW-A-06", async () => {
		await page.goto(`${env.uiUrl}/#/projects`);
		await openTask(page, kbTask);
		await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
		const misses: string[] = [];
		let stops = 0;
		for (let i = 0; i < 45; i++) {
			await page.keyboard.press("Tab");
			const r = (await page.evaluate(() => {
				const el = document.activeElement as HTMLElement | null;
				if (!el || el === document.body) return null;
				const cs = getComputedStyle(el);
				const outline =
					cs.outlineStyle !== "none" && Number.parseFloat(cs.outlineWidth) > 0;
				const shadow = cs.boxShadow !== "none";
				return {
					ok: outline || shadow,
					name: `${el.tagName.toLowerCase()}:${(el.textContent ?? "").trim().slice(0, 24)}`,
				};
			})) as { ok: boolean; name: string } | null;
			if (!r) continue;
			stops += 1;
			if (!r.ok) misses.push(r.name);
		}
		await run.shot(page, "A06-focus-sample");
		check(
			misses.length === 0,
			`no visible focus on: ${misses.slice(0, 6).join(" | ")}`,
		);
		return `${stops} tab stops checked, all with a visible outline/box-shadow`;
	});

	await run.case("BRW-A-07", async () => {
		const r = (await page.evaluate(() => {
			const unnamed: string[] = [];
			for (const el of Array.from(
				document.querySelectorAll("input, textarea, select"),
			) as HTMLInputElement[]) {
				const name =
					el.labels?.[0]?.textContent?.trim() ||
					el.getAttribute("aria-label") ||
					(el.getAttribute("aria-labelledby")
						? document.getElementById(el.getAttribute("aria-labelledby") ?? "")
								?.textContent
						: "");
				if (!name && el.type !== "hidden")
					unnamed.push(el.outerHTML.slice(0, 60));
			}
			const nonButtonType = (
				Array.from(
					document.querySelectorAll("main button"),
				) as HTMLButtonElement[]
			)
				.filter((b) => b.getAttribute("type") !== "button")
				.map((b) => b.textContent?.trim() ?? "");
			return {
				unnamed,
				nonButtonType,
				banner: document.querySelectorAll("body header").length,
				nav: document.querySelectorAll('nav[aria-label="Primary"]').length,
				main: document.querySelectorAll("main").length,
				h1: document.querySelectorAll("h1").length,
				h2: document.querySelectorAll("h2").length,
			};
		})) as {
			unnamed: string[];
			nonButtonType: string[];
			banner: number;
			nav: number;
			main: number;
			h1: number;
			h2: number;
		};
		// gate controls on a pending request
		const t = "A07 Gate controls";
		await submitNew(page, { title: t });
		await openRequest(page, "run", t);
		const g = (await page.evaluate(() => {
			const doc = document.querySelector(
				'section[aria-label="Approval document"]',
			);
			const sig = doc?.querySelector("input[type=text]");
			return {
				inForm: Boolean(sig?.closest("form")),
				types: Array.from(doc?.querySelectorAll("button") ?? []).map(
					(b) => `${b.textContent?.trim()}=${b.getAttribute("type")}`,
				),
			};
		})) as { inForm: boolean; types: string[] };
		const snap = await page.locator("body").ariaSnapshot();
		const file = join(run.outDir, "HUB-A07-aria-snapshot.yml");
		writeFileSync(file, snap);
		check(r.unnamed.length === 0, `unnamed fields: ${r.unnamed.join(" | ")}`);
		check(
			r.nonButtonType.length === 0,
			`buttons without type=button: ${r.nonButtonType.join(", ")}`,
		);
		check(
			r.banner === 1 && r.nav === 1 && r.main === 1,
			`landmarks banner ${r.banner} nav ${r.nav} main ${r.main}`,
		);
		check(!g.inForm, "signature inside a form");
		check(
			g.types.every((x) => x.endsWith("=button")),
			`gate buttons ${g.types.join(", ")}`,
		);
		return `landmarks 1/1/1; h1=${r.h1}, h2=${r.h2}; gate buttons all type=button; aria snapshot saved (${file.split("/").pop()})`;
	});

	await run.case("BRW-A-08", async () => {
		const outs = (await page.evaluate(() =>
			Array.from(document.querySelectorAll("output")).map(
				(o) => o.getAttribute("aria-label") ?? "",
			),
		)) as string[];
		check(outs.includes("Connection"), "no Connection status");
		check(outs.includes("Decision status"), "no Decision status");
		check(
			observed.taskStatusTexts.size >= 2,
			`Task status texts: ${[...observed.taskStatusTexts].join(" | ")}`,
		);
		check(
			observed.decisionStatusTexts.size >= 1,
			"no decision status text observed",
		);
		check(observed.offlineShown, "offline status not observed (R-25)");
		check(observed.alertNext, "error alert without a next action (R-20)");
		return `output[role=status] regions: ${[...new Set(outs)].join(", ")}; Task status changed through: ${[...observed.taskStatusTexts].join(" → ")}`;
	});

	// long content task (A-11) used by A-09/A-10/A-16
	let longTask = "";
	const longTitle = `A11${"X".repeat(117)}`;
	await run.case("BRW-A-11", async () => {
		const crit = Array.from({ length: 20 }, (_, i) =>
			i === 0 ? `C${"y".repeat(480)}` : `Criterion ${i + 1}, with a comma`,
		).join("\n");
		const path = `src/${"deep-segment-name/".repeat(9)}end`;
		await composeNew(page, {
			title: longTitle,
			criteria: crit,
			allowed: path,
		});
		const issues = await region(page, "Task detail")
			.locator(".wsm1-why li")
			.allTextContents();
		await region(page, "Task detail")
			.getByRole("button", { name: "Submit for run approval" })
			.click();
		await waitStage(page, "Awaiting execution approval");
		longTask = await taskIdFromUrl(page);
		const lay = await layout(page);
		const h2 = await textOf(page.locator("#wsm1-panel-title"));
		await run.shot(page, "A11-long-content-task");
		await openRequest(page, "run", longTitle);
		const lay2 = await layout(page);
		const hashes = (await region(page, "Approval document")
			.locator("code.wsm1-mono")
			.allTextContents()) as string[];
		const full64 = hashes.some((h) => /^[0-9a-f]{64}$/.test(h.trim()));
		const pathShown = (
			(await region(page, "Approval document").textContent()) ?? ""
		).includes(path);
		await run.shot(page, "A11-long-content-hq");
		check(
			!lay.overflowX && !lay2.overflowX,
			`overflow ${lay.scrollWidth}/${lay2.scrollWidth}`,
		);
		check(h2 === longTitle, "title truncated in the DOM");
		check(full64, "no full 64-hex hash in the HQ document");
		check(pathShown, "long path not shown in full");
		return `title 120 chars, 20 criteria (one 481 chars), path ${path.length} chars; issues: ${issues.length ? issues.join("; ") : "none"}`;
	});

	for (const [w, h] of [
		[1440, 900],
		[1280, 800],
	] as const) {
		const id = w === 1440 ? "BRW-A-09" : "BRW-A-10";
		await run.case(id, async () => {
			const v = await open(w, h);
			run.viewport = `${w}x${h}`;
			const p = v.page;
			const out: string[] = [];
			const checkState = async (label: string, grant?: Gate) => {
				const l = await layout(p);
				check(
					!l.overflowX,
					`${label}: overflow ${l.scrollWidth}>${l.clientWidth}`,
				);
				check(l.footInView, `${label}: action footer outside viewport`);
				if (grant) {
					const box = await grantButton(p, grant).boundingBox();
					check(
						box && box.y + box.height <= h && box.y >= 0,
						`${label}: ${grant} button not visible`,
					);
				}
				out.push(`${label} ${l.leftW}/${l.panelW}`);
				await run.shot(p, `${id}-${label}`);
			};
			check(J01, "J-01 missing");
			await openTask(p, J01.id);
			await checkState("task-accepted");
			await openRequest(p, "run", "R19 Second request");
			await checkState("hq-gate1", "run");
			await openTask(p, J01.id);
			await region(p, "Task detail")
				.getByRole("region", { name: "Evidence" })
				.locator("li button")
				.first()
				.click();
			await p.getByRole("dialog").waitFor();
			const l3 = await layout(p);
			check(!l3.overflowX, "evidence open: overflow");
			await run.shot(p, `${id}-evidence-open`);
			await p.keyboard.press("Escape");
			if (longTask) {
				await openTask(p, longTask);
				await checkState("long-content");
				await openRequest(p, "run", longTitle);
				await checkState("long-content-hq", "run");
			}
			await close(v);
			run.viewport = "1440x900";
			run.current = page;
			return `no overflow; footer and grant button in view; left/panel px: ${out.join(", ")}`;
		});
	}

	await run.case("BRW-A-16", async () => {
		check(longTask, "long task missing");
		await openRequest(page, "run", longTitle);
		const m = (await page.evaluate(() => {
			const body = document.querySelector(".wsm1-panel-body") as HTMLElement;
			const head = document
				.querySelector(".wsm1-panel-head")
				?.getBoundingClientRect();
			const foot = document
				.querySelector(".wsm1-panel-foot")
				?.getBoundingClientRect();
			return {
				scrolls: body.scrollHeight > body.clientHeight,
				headIn: head ? head.top >= 0 && head.bottom <= innerHeight : false,
				footIn: foot ? foot.bottom <= innerHeight + 0.5 : false,
				footTop: foot?.top ?? 0,
			};
		})) as {
			scrolls: boolean;
			headIn: boolean;
			footIn: boolean;
			footTop: number;
		};
		await page.locator(".wsm1-panel-body").evaluate((e) => {
			e.scrollTop = e.scrollHeight;
		});
		await sleep(200);
		const m2 = (await page.evaluate(() => ({
			headIn:
				(document.querySelector(".wsm1-panel-head")?.getBoundingClientRect()
					.top ?? -1) >= 0,
			footIn:
				(document.querySelector(".wsm1-panel-foot")?.getBoundingClientRect()
					.bottom ?? 1e9) <=
				innerHeight + 0.5,
		}))) as { headIn: boolean; footIn: boolean };
		// a focusable element at the end of the body must not hide under the footer
		await page.locator("#wsm1-panel-title").focus();
		await tabTo(
			page,
			(f) => f.label === "Type Edward to approve execution",
			"signature",
			120,
		);
		const sigBox = await sigField(page, "run").boundingBox();
		check(m.scrolls, "panel body does not scroll with long content");
		check(
			m.headIn && m.footIn && m2.headIn && m2.footIn,
			"header/footer not sticky",
		);
		const vp = page.viewportSize();
		check(
			sigBox && vp && sigBox.y >= 0 && sigBox.y + sigBox.height <= vp.height,
			"focused field off-screen",
		);
		return "panel body scrolls; header/footer stay in view; focused field visible";
	});

	await run.case("BRW-A-15", async () => {
		const t = "A15 Disabled reasons";
		await submitNew(page, { title: t });
		await openRequest(page, "run", t);
		const b = grantButton(page, "run");
		const why = (await b.evaluate((el) => {
			const ids = (el.getAttribute("aria-describedby") ?? "").split(" ");
			return ids
				.map((i) => document.getElementById(i)?.textContent ?? "")
				.join(" ");
		})) as string;
		check(why.trim().length > 0, "disabled Approve has no described reason");
		const chips = (await page.evaluate(() =>
			Array.from(document.querySelectorAll(".wsm1-chip")).map(
				(c) => (c.textContent ?? "").trim().length > 0,
			),
		)) as boolean[];
		check(chips.every(Boolean), "a status chip has no text");
		check(observed.alertNext, "error alert lacks a next action");
		return `disabled reason: "${why.trim().slice(0, 80)}"; ${chips.length} status chips all have text`;
	});
	await close(s);
}

async function coreJourney(
	s: Session,
	title: string,
	checkAnim: boolean,
): Promise<string> {
	const anims: number[] = [];
	const count = async () =>
		(await s.page.evaluate(
			() =>
				document.getAnimations().filter((a) => a.playState === "running")
					.length,
		)) as number;
	const id = await submitNew(s.page, { title });
	if (checkAnim) anims.push(await count());
	await approveRun(s.page, title);
	if (checkAnim) anims.push(await count());
	await openTask(s.page, id);
	await waitEngine(s.page, ["human_ready"], 90_000);
	await waitStage(s.page, "Awaiting acceptance");
	if (checkAnim) anims.push(await count());
	await openRequest(s.page, "result", title);
	await typeSignature(s.page, "result");
	await grantButton(s.page, "result").click();
	await until(
		async () =>
			(await attr(s.page, "acceptance-status", "data-status")) === "accepted",
		"accepted",
	);
	if (checkAnim) anims.push(await count());
	return anims.join(",");
}

async function motionWebglCases(): Promise<void> {
	await run.case("BRW-A-13", async () => {
		const s = await open(1440, 900, { reducedMotion: "reduce" });
		run.flags = "reducedMotion=reduce";
		const rm = (await s.page.evaluate(
			() => matchMedia("(prefers-reduced-motion: reduce)").matches,
		)) as boolean;
		check(rm, "reduced motion not emulated");
		const a = await coreJourney(s, "A13 Reduced motion", true);
		await run.shot(s.page, "A13-reduced-motion-accepted");
		check(
			a.split(",").every((x) => x === "0"),
			`running animations ${a}`,
		);
		await close(s);
		run.flags = "";
		return `prefers-reduced-motion matched; running animations at 4 points: ${a}; journey accepted`;
	});
	await run.case("BRW-A-14", async () => {
		const b2 = await chromium.launch({
			headless: true,
			args: ["--disable-3d-apis", "--disable-webgl", "--disable-webgl2"],
		});
		try {
			const s = await open(1440, 900, { b: b2 });
			run.flags = "webgl=disabled";
			const gl = (await s.page.evaluate(() => {
				const c = document.createElement("canvas");
				return {
					webgl: c.getContext("webgl") === null,
					webgl2:
						document.createElement("canvas").getContext("webgl2") === null,
				};
			})) as { webgl: boolean; webgl2: boolean };
			check(
				gl.webgl && gl.webgl2,
				`WebGL still available ${JSON.stringify(gl)}`,
			);
			await coreJourney(s, "A14 No WebGL", false);
			await run.shot(s.page, "A14-no-webgl-accepted");
			await close(s);
			return "getContext('webgl'/'webgl2') === null proven in-page; full journey to accepted completed";
		} finally {
			run.flags = "";
			await b2.close().catch(() => undefined);
		}
	});
}

// ── persistence + restart ───────────────────────────────────────────────────

async function persistenceCases(): Promise<void> {
	const s = await open();
	const { page, traffic } = s;

	await run.case("BRW-P-09", async () => {
		const st = await storageDump(page);
		check(
			st.local.length + st.session.length === 0,
			`storage keys ${JSON.stringify(st)}`,
		);
		check(J01, "J-01 missing");
		await openTask(page, J01.id);
		const before = await attr(page, "acceptance-status", "data-status");
		// forged "authority" in browser storage must be ignored
		const pending = db1<{ id: string; wt: string }>(
			"SELECT id, workspace_task_id AS wt FROM managed_approval_requests WHERE status='pending' AND kind='run' LIMIT 1",
		);
		check(pending, "no pending request");
		await page.evaluate(
			(ids: string[]) => {
				localStorage.setItem("agentcity.accepted", "true");
				localStorage.setItem(`approved:${ids[0]}`, "true");
				sessionStorage.setItem("agentcity.decision", "approved");
			},
			[pending.id],
		);
		await page.goto(`${env.uiUrl}/#/hq/${pending.wt}/${pending.id}`);
		await page.reload();
		await region(page, "Approval document").waitFor();
		const docStatus = await region(page, "Approval document").getAttribute(
			"data-request-status",
		);
		check(
			docStatus === "pending",
			`forged storage changed status → ${docStatus}`,
		);
		await page.evaluate(() => {
			localStorage.clear();
			sessionStorage.clear();
		});
		await page.reload();
		await openTask(page, J01.id);
		check(
			(await attr(page, "acceptance-status", "data-status")) === before,
			"state changed after clearing storage",
		);
		// offline + reload → no fabricated success
		await page.route("**/api/workspace/**", (r) =>
			r.abort("connectionrefused"),
		);
		await page.reload().catch(() => undefined);
		await sleep(2500);
		const fabricated = await page.getByText(/accepted|approved/i).count();
		const signIn = await page
			.getByRole("heading", { name: /sign-in|Checking session/ })
			.count();
		await page.unrouteAll({ behavior: "ignoreErrors" });
		await page.reload();
		await page.getByText(/^Signed in as operator:edward/).waitFor();
		check(
			fabricated === 0,
			`fabricated success while offline (sign-in heading ${signIn})`,
		);
		return `storage empty (IndexedDB dbs: ${st.idb.length}); forged keys ignored; clear-storage reload identical; offline reload shows ${fabricated} success text(s)`;
	});

	await run.case("BRW-P-10", async () => {
		check(J01, "J-01 missing");
		const p2 = await s.context.newPage();
		const tr2: Traffic = {
			decisionPosts: [],
			mutations: [],
			workspaceApiHits: 0,
			wsFrames: [],
		};
		attachPage(run, p2, env.uiUrl, tr2);
		await p2.goto(
			`${env.uiUrl}/#/projects/${encodeURIComponent(env.repoId)}/${J01.id}`,
		);
		await p2
			.locator(`section[aria-label="Task detail"][data-task-id="${J01.id}"]`)
			.waitFor();
		const pend = db1<{ id: string; wt: string }>(
			"SELECT id, workspace_task_id AS wt FROM managed_approval_requests WHERE status='pending' LIMIT 1",
		);
		check(pend, "no pending");
		await p2.goto(`${env.uiUrl}/#/hq/${pend.wt}/${pend.id}`);
		await p2.reload();
		await p2
			.locator(
				`section[aria-label="Approval document"][data-request-id="${pend.id}"]`,
			)
			.waitFor();
		const bogus = "wst-00000000-0000-4000-8000-000000000000";
		await p2.goto(
			`${env.uiUrl}/#/projects/${encodeURIComponent(env.repoId)}/${bogus}`,
		);
		await p2.reload();
		await sleep(2500);
		const panel = await textOf(p2.getByRole("main"));
		const h = (await p2.evaluate(() => location.hash)) as string;
		await p2.close();
		run.current = page;
		check(
			// lead ruling L-4 (rerun 4): explained AND the URL replaced in place
			/unavailable|not exist|no longer|not found/i.test(panel) &&
				!h.includes(bogus),
			`unknown id: panel "${panel.slice(0, 80)}", hash ${h.includes(bogus) ? "kept" : "normalized"}`,
		);
		return `task and HQ deep links restored after reload; unknown id → "${panel.slice(0, 60)}", hash ${h.includes(bogus) ? "kept" : "normalized"}`;
	});

	await run.case("BRW-P-11", async () => {
		check((await attr(page, "provenance", "data-source")) === "hub", "source");
		const t = await page.evaluate(() => document.body.innerText);
		check(!/UI fixture/.test(t as string), "UI fixture text in HUB mode");
		return undefined;
	});

	// ── prepare states, then ONE restart ──
	const prep: Record<string, string> = {};
	let p02Crit: string[] = [];
	let historyBefore = "";
	let inboxBefore: string[] = [];
	let countBefore = -1;
	let r07Req = "";
	let p07Req = "";
	let j14 = "";
	const p05: Record<
		string,
		{ stage: string; engine: string | null; acc: string | null }
	> = {};
	const prepared = await (async () => {
		try {
			// P-02 draft
			p02Crit = ["Persist me, with a comma", "And a second line"];
			await composeNew(page, {
				title: "P02 Draft across restart",
				criteria: p02Crit.join("\n"),
			});
			await region(page, "Task detail")
				.getByRole("button", { name: "Save draft" })
				.click();
			await until(
				async () => (await criteriaItems(page)).length === 2,
				"P02 saved",
			);
			prep.p02 = await taskIdFromUrl(page);
			// P-05a awaiting acceptance
			prep.p05a = await toResult(s, "P05a Awaiting acceptance across restart");
			// P-07: committed but unseen
			const t7 = "P07 Lost then restart";
			prep.p07 = await submitNew(page, { title: t7 });
			p07Req = await openRequest(page, "run", t7);
			await typeSignature(page, "run");
			await page.route(
				`**/approval-requests/${p07Req}/decisions`,
				async (route) => {
					await route.fetch().catch(() => null);
					await route.abort("connectionreset").catch(() => undefined);
				},
			);
			await grantButton(page, "run").click();
			await until(() => decisionsFor(p07Req) === 1, "P07 committed");
			await page.unrouteAll({ behavior: "ignoreErrors" });
			// J-14: running impl_hangs
			const t14 = "J14 Interrupted by restart";
			j14 = await submitNew(page, { title: t14, scenario: "impl_hangs" });
			await approveRun(page, t14);
			await openTask(page, j14);
			await waitEngine(page, ["executing"], 60_000);
			// R-07 / P-08: a typed signature with a live challenge
			const t7b = "R07 Signature across restart";
			prep.r07 = await submitNew(page, { title: t7b });
			r07Req = await openRequest(page, "run", t7b);
			await typeSignature(page, "run");
			check(challenges.has(r07Req), "challenge not captured");
			// snapshots
			inboxBefore = (
				await region(page, "Approval inbox")
					.locator("button[data-request-id]")
					.allTextContents()
			)
				.map((x) => x.trim())
				.sort();
			countBefore = await pendingCount(page);
			check(J01, "J-01 missing");
			const p2 = await s.context.newPage();
			const tr2: Traffic = {
				decisionPosts: [],
				mutations: [],
				workspaceApiHits: 0,
				wsFrames: [],
			};
			attachPage(run, p2, env.uiUrl, tr2);
			await p2.goto(`${env.uiUrl}/#/projects`);
			await p2.getByText(/^Signed in as operator:edward/).waitFor();
			const j04 = db1<{ id: string }>(
				"SELECT id FROM workspace_tasks WHERE json_extract(draft,'$.title') = 'J04 Gate1 request changes'",
			);
			const j04req = j04
				? reqs(j04.id).find((r) => r.status === "pending")
				: null;
			if (j04 && j04req) {
				await p2.goto(`${env.uiUrl}/#/hq/${j04.id}/${j04req.id}`);
				await region(p2, "Decision history").locator("li").first().waitFor();
				historyBefore = (
					await region(p2, "Decision history").locator("li").allTextContents()
				).join("\n");
				prep.j04 = j04.id;
				prep.j04req = j04req.id;
			}
			const j08 = db1<{ id: string }>(
				"SELECT id FROM workspace_tasks WHERE json_extract(draft,'$.title') = 'J08 Verification fails'",
			);
			for (const [k, id] of [
				["a", prep.p05a ?? ""],
				["b", J01.id],
				["d", j08?.id ?? ""],
			] as const) {
				if (!id) continue;
				await openTask(p2, id);
				await sleep(300);
				p05[k] = {
					stage: await stageText(p2),
					engine: await attr(p2, "engine-state", "data-state"),
					acc: await attr(p2, "acceptance-status", "data-status"),
				};
				prep[`p05${k}`] = id;
			}
			await p2.close();
			run.current = page;
			return true;
		} catch (err) {
			run.notes.push(
				`restart preparation failed: ${(err as Error).message.slice(0, 200)}`,
			);
			return false;
		}
	})();

	const postsBeforeRestart = traffic.decisionPosts.length;
	if (prepared) await env.restartHub();
	const restartedAt = Date.now();

	await run.case("BRW-R-07", async () => {
		check(prepared, "preparation failed");
		await page
			.getByRole("heading", { name: "Operator sign-in" })
			.waitFor({ timeout: 15_000 });
		const notice = await textOf(page.getByRole("main"));
		check(
			(await region(page, "Approval document").count()) === 0,
			"document still shown after the boot change",
		);
		check(
			!(await page.content()).includes('value="Edward"'),
			"signature value kept",
		);
		await signIn(page, env.credential);
		await captureSessionSecrets(s);
		await page.goto(`${env.uiUrl}/#/hq/${prep.r07}/${r07Req}`);
		await page
			.locator(
				`section[aria-label="Approval document"][data-request-id="${r07Req}"]`,
			)
			.waitFor();
		check(
			(await region(page, "Approval document").getAttribute(
				"data-request-status",
			)) === "pending",
			"request not pending after restart",
		);
		check(
			(await sigField(page, "run").inputValue()) === "",
			"signature restored",
		);
		check(decisionsFor(r07Req) === 0, "decided by the restart");
		check(
			traffic.decisionPosts.length === postsBeforeRestart,
			"a decision POST happened during the restart",
		);
		return `after restart: "${notice.slice(0, 60)}"; signed in again; request pending, field empty`;
	});

	await run.case("BRW-P-08", async () => {
		check(prepared, "preparation failed");
		const old = challenges.get(r07Req);
		check(old, "no old challenge");
		const res = (await page.evaluate(
			async (a: {
				req: string;
				ch: string;
				rev: number;
				bh: string;
				key: string;
			}) => {
				const sr = await fetch("/api/workspace/session", {
					credentials: "same-origin",
				});
				const csrf = ((await sr.json()) as { csrf_token: string }).csrf_token;
				const r = await fetch(
					`/api/workspace/approval-requests/${a.req}/decisions`,
					{
						method: "POST",
						credentials: "same-origin",
						headers: {
							"content-type": "application/json",
							"x-agentcity-csrf": csrf,
						},
						body: JSON.stringify({
							idempotency_key: a.key,
							kind: "run",
							action: "approve",
							expected_request_rev: a.rev,
							binding_hash: a.bh,
							confirmation_text: "Edward",
							reason: null,
							challenge: a.ch,
						}),
					},
				);
				const j = (await r.json().catch(() => ({}))) as { error?: string };
				return { status: r.status, error: j.error ?? "" };
			},
			{
				req: r07Req,
				ch: old.challenge,
				rev: old.request_rev,
				bh: old.binding_hash,
				key: `replay-09-${randomAlnum(12)}`,
			},
		)) as { status: number; error: string };
		check(
			res.status === 409,
			`old challenge replay → ${res.status} ${res.error}`,
		);
		check(decisionsFor(r07Req) === 0, "replay decided");
		// fresh signature + challenge after the restart works
		await page.goto(`${env.uiUrl}/#/hq/${prep.r07}/${r07Req}`);
		await typeSignature(page, "run");
		await grantButton(page, "run").click();
		await until(
			async () => /Execution approved/.test(await decisionStatus(page)),
			"approved",
		);
		check(decisionsFor(r07Req) === 1, "fresh approval missing");
		return `replayed pre-restart challenge → ${res.status} ${res.error}; fresh challenge after restart approves`;
	});

	await run.case("BRW-J-14", async () => {
		check(prepared && j14, "preparation failed");
		await openTask(page, j14);
		await waitEngine(page, ["interrupted"], 40_000);
		await waitStage(page, "Interrupted", 20_000);
		const mt = taskRow(j14)?.current_managed_task_id ?? "";
		const n1 = runsOf(mt).length;
		await sleep(5000);
		const n2 = runsOf(mt).length;
		check(n1 === n2, `attempts ${n1}→${n2} (auto relaunch)`);
		check(
			(await region(page, "Task detail")
				.getByRole("button", { name: "Request a new run" })
				.count()) === 1,
			"no 'Request a new run'",
		);
		check(
			reqs(j14).filter((r) => r.kind === "run" && r.status === "pending")
				.length === 0,
			"a new Gate 1 opened by itself",
		);
		await run.shot(page, "J14-interrupted");
		return `engine interrupted ${Math.round((Date.now() - restartedAt) / 1000)} s after restart; attempts ${n1}→${n2}; rerun offered (needs a new Gate 1)`;
	});

	await run.case("BRW-P-02", async () => {
		check(prepared && prep.p02, "preparation failed");
		await openTask(page, prep.p02);
		check(
			JSON.stringify(await criteriaItems(page)) === JSON.stringify(p02Crit),
			"draft differs after restart",
		);
		return undefined;
	});

	await run.case("BRW-P-03", async () => {
		check(prepared, "preparation failed");
		// R-07 was approved after the restart (one fewer pending)
		const names = (await inboxNames(page)).sort();
		const expected = inboxBefore.filter(
			(n) => !n.includes("R07 Signature across restart"),
		);
		const missing = expected.filter((n) => !names.includes(n));
		const count = await pendingCount(page);
		check(
			missing.length === 0,
			`missing after restart: ${missing.join(" | ")}`,
		);
		check(count === pendingInDb(), `count ${count} vs DB ${pendingInDb()}`);
		const added = names.filter((n) => !inboxBefore.includes(n));
		check(
			added.every((n) => n.startsWith("Result acceptance")),
			`unexpected new items: ${added.join(" | ")}`,
		);
		return `${countBefore} pending before restart → ${count} after (R-07 approved since; new result requests opened by executions approved before the restart: ${added.length}); every earlier item present; count = DB`;
	});

	await run.case("BRW-P-04", async () => {
		check(prepared && prep.j04 && prep.j04req, "preparation failed");
		await page.goto(`${env.uiUrl}/#/hq/${prep.j04}/${prep.j04req}`);
		await region(page, "Decision history").locator("li").first().waitFor();
		const after = (
			await region(page, "Decision history").locator("li").allTextContents()
		).join("\n");
		check(after === historyBefore, "history differs after restart");
		return "J-04 decision history identical after restart";
	});

	await run.case("BRW-P-05", async () => {
		check(prepared, "preparation failed");
		const out: string[] = [];
		for (const k of ["a", "b", "d"]) {
			const id = prep[`p05${k}`];
			const was = p05[k];
			if (!id || !was) continue;
			await openTask(page, id);
			await sleep(400);
			const now = {
				stage: await stageText(page),
				engine: await attr(page, "engine-state", "data-state"),
				acc: await attr(page, "acceptance-status", "data-status"),
			};
			check(
				JSON.stringify(now) === JSON.stringify(was),
				`(${k}) ${JSON.stringify(was)} → ${JSON.stringify(now)}`,
			);
			out.push(`(${k}) ${now.stage}/${now.engine}/${now.acc}`);
		}
		out.push("(c) see J-14");
		return out.join("; ");
	});

	await run.case("BRW-P-07", async () => {
		check(prepared && prep.p07, "preparation failed");
		await page.goto(`${env.uiUrl}/#/hq/${prep.p07}/${p07Req}`);
		await page
			.locator(
				`section[aria-label="Approval document"][data-request-id="${p07Req}"]`,
			)
			.waitFor();
		check(
			(await region(page, "Approval document").getAttribute(
				"data-request-status",
			)) === "approved",
			"not shown as approved",
		);
		check((await sigField(page, "run").count()) === 0, "re-approval offered");
		check(decisionsFor(p07Req) === 1, "decisions ≠ 1");
		check(approvedRuns(prep.p07) === 1, "executions ≠ 1");
		return undefined;
	});

	await run.case("BRW-P-12-fresh-context", async () => {
		const f = await open();
		check(J01, "J-01 missing");
		await openTask(f.page, J01.id);
		const acc = await attr(f.page, "acceptance-status", "data-status");
		await close(f);
		check(acc === "accepted", `fresh context after restart: ${acc}`);
		return "a fresh context (empty storage) after the restart reconstructs the accepted task";
	});
	await close(s);
}

// ── short-TTL environments ──────────────────────────────────────────────────

async function ttlCases(): Promise<void> {
	if (run.wants("BRW-R-21")) {
		const envB = await startWorkspaceEnv({
			auth: { challenge_ttl_ms: 3000 },
		});
		run.secrets.add(envB.credential);
		const saved = env;
		env = envB;
		try {
			await run.case("BRW-R-21", async () => {
				const s = await open();
				const t = "R21 Challenge expiry";
				const id = await submitNew(s.page, { title: t });
				const req = await openRequest(s.page, "run", t);
				await typeSignature(s.page, "run");
				await until(
					async () => (await sigField(s.page, "run").inputValue()) === "",
					"cleared at expiry",
					8000,
				);
				const notice = await textOf(
					region(s.page, "Approval document").locator(".wsm1-notice"),
				);
				check(/expired/i.test(notice), `notice "${notice}"`);
				check(
					!(await grantButton(s.page, "run").isEnabled()),
					"Approve enabled after expiry",
				);
				check(decisionsFor(req) === 0, "decided");
				await typeSignature(s.page, "run");
				await grantButton(s.page, "run").click();
				await until(
					async () => /Execution approved/.test(await decisionStatus(s.page)),
					"approved",
				);
				check(approvedRuns(id) === 1, "not approved after a fresh challenge");
				await close(s);
				return `notice "${notice.slice(0, 80)}"; fresh challenge approves`;
			});
		} finally {
			env = saved;
			await envB.stop().catch(() => undefined);
		}
	}
	if (run.wants("BRW-R-28")) {
		const envC = await startWorkspaceEnv({
			auth: { session_ttl_ms: 6000, idle_timeout_ms: 6000 },
		});
		run.secrets.add(envC.credential);
		const saved = env;
		env = envC;
		try {
			await run.case("BRW-R-28", async () => {
				const s = await open();
				await composeNew(s.page, { title: "R28 Before expiry" });
				await region(s.page, "Task detail")
					.getByRole("button", { name: "Save draft" })
					.click();
				await until(async () => (await taskIdFromUrl(s.page)) !== "", "saved");
				const id = await taskIdFromUrl(s.page);
				await s.page
					.getByRole("heading", { name: "Operator sign-in" })
					.waitFor({ timeout: 15_000 });
				const notice = await textOf(s.page.getByRole("main"));
				check(
					(await region(s.page, "Task detail").count()) === 0,
					"data kept after expiry",
				);
				check(
					!(await s.page.content()).includes("R28 Before expiry"),
					"task text kept after expiry",
				);
				await signIn(s.page, env.credential);
				await openTask(s.page, id);
				await close(s);
				return `expiry → "${notice.slice(0, 60)}"; purged; sign-in restores the task from the hub`;
			});
		} finally {
			env = saved;
			await envC.stop().catch(() => undefined);
		}
	}
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
	// isolated runner: HOME must be a disposable directory, never the account's conventional home
	// (Bun's userInfo().homedir follows $HOME, so compare with /Users/<user> and /home/<user>)
	const user = userInfo().username;
	check(
		![`/Users/${user}`, `/home/${user}`].includes(
			homedir().replace(/\/+$/, ""),
		),
		"not in the isolated runner (HOME)",
	);
	browser = await chromium.launch({ headless: true });
	const version = browser.version();
	env = await startWorkspaceEnv({
		readOnly: true,
		auth: { max_sessions_per_principal: 8 },
		fixture: {
			verification: [
				{
					name: "fixture-check",
					argv: ["/bin/sh", "-c", VERIFY_SCRIPT],
					timeout_s: 60,
				},
			],
			limits: { lease_ttl_ms: 3000 },
		},
	});
	run.secrets.add(env.credential);
	if (env.readOnlyCredential) run.secrets.add(env.readOnlyCredential);
	check(!env.uiUrl.endsWith(":4317") && !env.hubUrl.endsWith(":4317"), "4317");
	console.log(
		`[HUB] chromium ${version}; ui ${env.uiUrl}; hub port ≠ 4317; evidence ${run.outDir}`,
	);
	const t0 = Date.now();
	try {
		await sessionCases();
		await happyPath();
		await draftCases();
		await coverageCases();
		await gate1Cases();
		await gate2Cases();
		await scenarioCases();
		await evidenceCases();
		await raceCases();
		await authGenerationCases();
		await cancelCases();
		await inboxCases();
		await a11yCases();
		await motionWebglCases();
		await persistenceCases();
		run.notRun(
			"BRW-J-21",
			"no CEO briefing is built in M1 (conditional case; 07 NOTES §8)",
		);
		await raceGate2Lost();
		await ttlCases();
	} finally {
		for (const s of sessions) await s.context.close().catch(() => undefined);
	}

	// globals
	const allMut = sessions
		.filter((s) => !r06Traffic.has(s.traffic))
		.flatMap((s) => s.traffic.mutations);
	const mut = allMut.filter((m) => !m.path.endsWith("/session"));
	const r06Mut = sessions
		.filter((s) => r06Traffic.has(s.traffic))
		.flatMap((s) => s.traffic.mutations)
		.filter((m) => !m.path.endsWith("/session"));
	run.notes.push(
		`S-03 (R-06 session, excluded above): ${r06Mut.length} mutations, ${r06Mut.filter((m) => !m.csrf).length} sent WITHOUT the CSRF header`,
	);
	run.record(
		"BRW-S-03",
		mut.length > 0 && mut.every((m) => m.csrf && m.originExact)
			? "PASS"
			: "FAIL",
		`${mut.length} workspace mutations (sign-in/out excluded): CSRF header on ${mut.filter((m) => m.csrf).length}, exact Origin on ${mut.filter((m) => m.originExact).length}`,
	);
	run.record(
		"BRW-S-02",
		run.blockedOrigins.length === 0 ? "PASS" : "FAIL",
		`${run.blockedOrigins.length} request(s) outside the UI origin aborted ${[...new Set(run.blockedOrigins)].join(", ")}`,
	);
	run.record(
		"G-1",
		run.blockedOrigins.length === 0 ? "PASS" : "FAIL",
		`blocked ${run.blockedOrigins.length}`,
	);
	run.record(
		"BRW-S-06",
		run.consoleErrors.length === 0 && run.dialogs.length === 0
			? "PASS"
			: "FAIL",
		`${run.consoleErrors.length} unexpected console error(s): ${run.consoleErrors.slice(0, 3).join(" | ")}; dialogs ${run.dialogs.length}`,
	);
	run.record(
		"G-2",
		run.consoleErrors.length === 0 ? "PASS" : "FAIL",
		`${run.consoleErrors.length}`,
	);
	const live = db(
		"SELECT count(*) AS n FROM managed_runs WHERE provider <> 'fake' OR mode <> 'simulated'",
	)[0] as { n: number } | undefined;
	const liveTasks = db(
		"SELECT count(*) AS n FROM managed_tasks WHERE execution_mode <> 'simulated'",
	)[0] as { n: number } | undefined;
	const totalRuns = (
		db("SELECT count(*) AS n FROM managed_runs")[0] as { n: number }
	).n;
	run.record(
		"G-5",
		live?.n === 0 && liveTasks?.n === 0 ? "PASS" : "FAIL",
		`record-level: ${totalRuns} attempts all provider=fake/mode=simulated; 0 live tasks; no provider CLI on the isolated PATH. In-process launch counter not exposed — deferred to 08`,
	);
	const pat = await (async () => {
		try {
			const s = await open();
			const hits = await secretPatternHits(s.page);
			await close(s);
			return hits;
		} catch {
			return ["(check failed)"];
		}
	})();
	run.record(
		"BRW-S-07",
		pat.length === 0 ? "PASS" : "FAIL",
		`pre-screenshot secret scans passed for ${run.shots.length} screenshots; final page text pattern hits: ${pat.join(",") || "none"}`,
	);
	const g3fail = run.results.some(
		(r) => r.status === "FAIL" && /secret visible/.test(r.detail),
	);
	run.record(
		"G-3",
		g3fail ? "FAIL" : "PASS",
		"no secret value found in DOM/URL/storage/document.cookie at any screenshot or check",
	);
	run.record(
		"G-4",
		["BRW-R-19", "BRW-R-20", "BRW-R-22"].every(
			(id) => run.results.find((r) => r.id === id)?.status === "PASS",
		)
			? "PASS"
			: "FAIL",
		"derived from R-19/R-20/R-22",
	);
	run.record(
		"G-6",
		["BRW-J-01.C15", "BRW-J-06", "BRW-J-07"].every(
			(id) => run.results.find((r) => r.id === id)?.status === "PASS",
		)
			? "PASS"
			: "FAIL",
		"language audit after accepted / changes requested / rejected",
	);
	const file = run.writeSummary({
		browser: `Chromium headless shell ${version}`,
		playwright: "playwright-core 1.63.0",
		uiOrigin: "http://127.0.0.1:<free port>",
		durationS: Math.round((Date.now() - t0) / 1000),
	});
	console.log(`[HUB] summary ${file}`);
	return run.results.some((r) => r.status === "FAIL") ? 1 : 0;
}

async function raceGate2Lost(): Promise<void> {
	const s = await open();
	const { page, traffic } = s;
	await run.case("BRW-R-14", async () => {
		const t = "R14 Lost Gate2 response";
		const id = await toResult(s, t);
		const req = await openRequest(page, "result", t);
		await typeSignature(page, "result");
		let n = 0;
		await page.route(`**/approval-requests/${req}/decisions`, async (route) => {
			n += 1;
			if (n === 1) {
				await route.fetch().catch(() => null);
				await route.abort("connectionreset").catch(() => undefined);
				return;
			}
			await route.continue().catch(() => undefined);
		});
		const t0 = Date.now();
		await grantButton(page, "result").click();
		let sawUnknown = false;
		let clicked = false;
		await until(
			async () => {
				const st = await decisionStatus(page);
				if (/Decision outcome unknown/.test(st)) sawUnknown = true;
				const chk = region(page, "Approval document").getByRole("button", {
					name: "Check decision outcome",
				});
				if (!clicked && (await chk.count()) > 0) {
					clicked = true;
					await chk.click();
				}
				return (
					(await attr(page, "acceptance-status", "data-status")) === "accepted"
				);
			},
			"accepted after the lost answer",
			20_000,
		);
		await page.unrouteAll({ behavior: "ignoreErrors" });
		await sleep(800);
		const p = await posts(traffic, req, t0);
		check(new Set(p.map((x) => x.body)).size === 1, "bodies differ");
		check(decisionsFor(req) === 1, "decisions ≠ 1");
		check(taskRow(id)?.stage === "accepted", "stage");
		return `unknown shown=${sawUnknown}; Check clicked=${clicked}; ${p.length} POST(s), identical; 1 acceptance`;
	});
	await run.case("BRW-R-12", async () => {
		const t = "R12 Reload during Gate2";
		const id = await toResult(s, t);
		const req = await openRequest(page, "result", t);
		await typeSignature(page, "result");
		let fetched = false;
		await page.route(`**/approval-requests/${req}/decisions`, async (route) => {
			await route.fetch().catch(() => null);
			fetched = true;
			await sleep(60_000).catch(() => undefined);
		});
		await grantButton(page, "result").click();
		await until(() => fetched, "server reached");
		await page.unrouteAll({ behavior: "ignoreErrors" });
		const t1 = Date.now();
		await page.reload();
		await page.getByText(/^Signed in as operator:edward/).waitFor();
		await openTask(page, id);
		await until(
			async () =>
				(await attr(page, "acceptance-status", "data-status")) === "accepted",
			"accepted after reload",
		);
		await sleep(1500);
		check(decisionsFor(req) === 1, "decisions ≠ 1");
		check((await posts(traffic, req, t1)).length === 0, "POST after reload");
		return "accepted once; 0 POSTs after reload";
	});
	await close(s);
}

let code = 1;
try {
	code = await main();
} catch (err) {
	run.record("setup", "FAIL", String((err as Error).message ?? err));
	run.writeSummary({ fatal: true });
} finally {
	await browser?.close().catch(() => undefined);
	await env?.stop().catch(() => undefined);
}
const by = (st: string) => run.results.filter((r) => r.status === st).length;
console.log(
	`[HUB] PASS ${by("PASS")} · FAIL ${by("FAIL")} · NOT RUN ${by("NOT RUN")} · BLOCKED ${by("BLOCKED")} · evidence ${run.outDir}`,
);
process.exit(code);
