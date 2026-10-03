// Worker C (independent QA, campus milestone) — the business-campus presentation on the FINAL
// INTEGRATED tree against the ISOLATED REAL TEST HUB.
//
//   …/iso/run.sh env PLAYWRIGHT_BROWSERS_PATH=/Users/edwardhwang/Library/Caches/ms-playwright \
//     bun --no-env-file apps/web/e2e/workspace-m1/campus.suite.ts        [CAMPUS_ONLY=<regex of ids>]
//
// Isolation (lead harness `../workspace-harness.ts`): the real hub runs in THIS process in workspace
// mode on a free 127.0.0.1 port (never 4317) over a temp SQLite file and a disposable fixture repo,
// simulated only (fake providers), per-run synthetic credentials; Vite with configFile:false, an
// empty envDir and a TMPDIR cacheDir, proxying only to this hub; allowed origin = the Vite origin.
// Chromium = cached Playwright headless shell (software WebGL via SwiftShader for the scene; a second
// browser with WebGL disabled), fresh contexts. Every request outside the UI origin is aborted and
// counted. Tampering touches only files under env.fx. Separate disposable environments: short
// challenge TTL (J6 expiry) and sealed-bundle corruption (J7b). Legacy v1 rows are written into the
// disposable DB only through the hub's own test helpers (`decisions/test-support.ts`).

import { existsSync, readFileSync, renameSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import {
	type Browser,
	type BrowserContext,
	chromium,
	type Page,
} from "playwright-core";
import { OBSOLETE_V1_GRANT_DETAIL } from "../../../hub/src/workspace-m1/decisions/decision-service.ts";
import { startWorkspaceEnv, type WorkspaceEnv } from "../workspace-harness.ts";
import {
	approveLegacyBeforePolicy,
	bogusToken,
	campusProbe,
	docFor,
	dropStash,
	flipByte,
	focused,
	GL_ARGS,
	GL_COUNTER_SCRIPT,
	inViewport,
	keyToVisit,
	mintVerified,
	NOGL_ARGS,
	notCovered,
	overflowIn,
	pagePost,
	sceneSettled,
	seedLegacyPending,
	stashCsrf,
	stripTabStops,
	tabTo,
	visitButton,
	visitTitleVisibility,
} from "./campus-kit.ts";
import {
	attr,
	check,
	composeNew,
	coverageRows,
	dbAll,
	dbOne,
	decisionStatus,
	grantButton,
	navLink,
	newCtx,
	openTask,
	Run,
	region,
	SIG_LABEL,
	sigField,
	signIn,
	sleep,
	stageText,
	submitNew,
	type Traffic,
	taskIdFromUrl,
	textOf,
	typeSignature,
	until,
	waitEngine,
	waitStage,
} from "./kit.ts";

const ONLY = process.env.CAMPUS_ONLY
	? new RegExp(process.env.CAMPUS_ONLY)
	: null;
const run = new Run("HUB", ONLY);

// verification sleeps 2 s so `verifying` is observable at the UI's 2 s poll
const VERIFY = ["/bin/sh", "-c", "sleep 2; exec /bin/sh verify.sh"];
const MIN_WALK_MS = 7_000; // campus/visits.ts
const MAX_WALK_MS = 20_000;

interface Session {
	context: BrowserContext;
	page: Page;
	traffic: Traffic;
	challengePosts: { url: string; at: number }[];
}

let env!: WorkspaceEnv;
let browser!: Browser;
let sceneLive = false;
const sessions: Session[] = [];
const challenges = new Map<
	string,
	{ challenge: string; request_rev: number; binding_hash: string }
>();
const facts: Record<string, string> = {};

// ── sessions ────────────────────────────────────────────────────────────────

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
	o: {
		w?: number;
		h?: number;
		reducedMotion?: "reduce";
		b?: Browser;
		signIn?: boolean;
	} = {},
): Promise<Session> {
	const base = await newCtx(run, o.b ?? browser, env.uiUrl, {
		width: o.w ?? 1440,
		height: o.h ?? 900,
		reducedMotion: o.reducedMotion,
	});
	await base.context.addInitScript(GL_COUNTER_SCRIPT);
	const s: Session = { ...base, challengePosts: [] };
	s.page.on("request", (r) => {
		const u = new URL(r.url());
		if (r.method() === "POST" && /\/challenge$/.test(u.pathname))
			s.challengePosts.push({ url: u.pathname, at: Date.now() });
	});
	s.page.on("response", async (r) => {
		const m = /\/approval-requests\/(wsa-[0-9a-f-]{36})\/challenge$/.exec(
			new URL(r.url()).pathname,
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
			// page closed
		}
	});
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
		// gone
	}
	await s.context.close().catch(() => undefined);
}

// ── read-only DB access (this run's temp SQLite) ────────────────────────────

const db = <T = Record<string, unknown>>(
	sql: string,
	...p: (string | number | null)[]
) => dbAll<T>(env.fx.dbPath, sql, ...p);
const db1 = <T = Record<string, unknown>>(
	sql: string,
	...p: (string | number | null)[]
) => dbOne<T>(env.fx.dbPath, sql, ...p);

interface ReqRow {
	id: string;
	kind: string;
	status: string;
	rev: number;
	binding_hash: string;
	invalidation_reason: string | null;
	invalidation_detail: string | null;
	created_at: string;
	workspace_task_id: string;
	managed_task_id: string;
}
const REQ_COLS =
	"id, kind, status, rev, binding_hash, invalidation_reason, invalidation_detail, created_at, workspace_task_id, managed_task_id";
const reqRow = (id: string) =>
	db1<ReqRow>(
		`SELECT ${REQ_COLS} FROM managed_approval_requests WHERE id = ?`,
		id,
	);
const pendingReq = (taskId: string, kind: "run" | "result") =>
	db1<ReqRow>(
		`SELECT ${REQ_COLS} FROM managed_approval_requests WHERE workspace_task_id = ? AND kind = ? AND status = 'pending' ORDER BY created_at DESC`,
		taskId,
		kind,
	);
async function waitPendingReq(
	taskId: string,
	kind: "run" | "result",
	ms = 20_000,
): Promise<ReqRow> {
	let r: ReqRow | null = null;
	await until(
		() => {
			r = pendingReq(taskId, kind);
			return r !== null;
		},
		`pending ${kind} request of ${taskId.slice(-8)}`,
		ms,
		250,
	);
	return r as unknown as ReqRow;
}
const pendingIds = () =>
	db<{ id: string }>(
		"SELECT id FROM managed_approval_requests WHERE status = 'pending' ORDER BY created_at",
	).map((r) => r.id);
const taskRow = (id: string) =>
	db1<{
		stage: string;
		stage_detail: string | null;
		rev: number;
		current_managed_task_id: string | null;
		accepted_decision_id: string | null;
	}>(
		"SELECT stage, stage_detail, rev, current_managed_task_id, accepted_decision_id FROM workspace_tasks WHERE id = ?",
		id,
	);
const decisionsFor = (requestId: string) =>
	db1<{ n: number }>(
		"SELECT count(*) AS n FROM managed_decisions WHERE approval_request_id = ?",
		requestId,
	)?.n ?? -1;
const decisionRow = (requestId: string) =>
	db1<{ id: string; decided_at: string; response_body: string }>(
		"SELECT id, decided_at, response_body FROM managed_decisions WHERE approval_request_id = ?",
		requestId,
	);
const runsOf = (mt: string) =>
	db<{ id: string; attempt_no: number }>(
		"SELECT id, attempt_no FROM managed_runs WHERE task_id = ? ORDER BY attempt_no",
		mt,
	);
const managedRow = (mt: string) =>
	db1<{
		state: string;
		failure_kind: string | null;
		state_detail: string | null;
		run_requested_at: string | null;
	}>(
		"SELECT state, failure_kind, state_detail, run_requested_at FROM managed_tasks WHERE id = ?",
		mt,
	);
const artifactsOf = (mt: string) =>
	db<{ id: string; kind: string; name: string; rel_path: string }>(
		"SELECT id, kind, name, rel_path FROM managed_artifacts WHERE task_id = ? ORDER BY created_at",
		mt,
	);
const activeEngines = () =>
	db1<{ n: number }>(
		"SELECT count(*) AS n FROM managed_tasks WHERE state IN ('queued','executing','verifying','reviewing','repairing')",
	)?.n ?? -1;

const postsFor = (t: Traffic, requestId: string, since = 0) =>
	t.decisionPosts.filter((p) => p.url.includes(requestId) && p.at >= since);
const challengePostsFor = (s: Session, requestId: string, since = 0) =>
	s.challengePosts.filter((p) => p.url.includes(requestId) && p.at >= since);

// ── campus navigation (DOM layer: buttons that work with or without WebGL) ──

async function ensureCampus(page: Page) {
	if (!(await campusProbe(page)).present) await navLink(page, /^Head/).click();
	await page.locator(".cmp").waitFor();
}

/** Opens an approval document through the campus document button (`.cmp-visit`). */
async function openViaCampus(page: Page, requestId: string, ms = 25_000) {
	await ensureCampus(page);
	const b = visitButton(page, requestId);
	await until(
		async () => (await b.count()) > 0,
		`campus document button ${requestId.slice(-8)}`,
		ms,
	);
	await b.first().click();
	await docFor(page, requestId).waitFor();
	await docEscapes(page, "opened");
}

/** Records approval-document text that is clipped or leaves the panel (checked on every open). */
const docLayout: { checked: number; issues: Set<string> } = {
	checked: 0,
	issues: new Set(),
};
async function docEscapes(page: Page, when: string) {
	await sleep(300);
	const vp = page.viewportSize();
	const o = await overflowIn(page, 'section[aria-label="Approval document"]');
	docLayout.checked += 1;
	const gate =
		(await page
			.locator('section[aria-label="Approval document"]')
			.getAttribute("data-request-status")
			.catch(() => null)) ?? "?";
	for (const c of o.clipped)
		docLayout.issues.add(`${vp?.width}x${vp?.height} ${when} (${gate}): ${c}`);
	if (o.pageOverflowX)
		docLayout.issues.add(`${vp?.width}x${vp?.height} ${when}: page overflow`);
}

async function approveViaCampus(page: Page, taskId: string): Promise<string> {
	const r = await waitPendingReq(taskId, "run");
	await openViaCampus(page, r.id);
	await typeSignature(page, "run");
	await grantButton(page, "run").click();
	await until(
		async () => /Execution approved/.test(await decisionStatus(page)),
		"execution approved",
	);
	return r.id;
}

async function acceptViaCampus(page: Page, taskId: string): Promise<string> {
	const r = await waitPendingReq(taskId, "result", 120_000);
	await openViaCampus(page, r.id);
	await typeSignature(page, "result");
	await grantButton(page, "result").click();
	await until(
		async () =>
			(await attr(page, "acceptance-status", "data-status")) === "accepted",
		"accepted",
	);
	return r.id;
}

async function typeReason(page: Page, text: string) {
	const f = region(page, "Approval document").getByLabel("Decision reason");
	await f.click();
	await f.pressSequentially(text, { delay: 8 });
	await until(
		async () =>
			region(page, "Approval document")
				.getByRole("button", { name: "Reject", exact: true })
				.isEnabled(),
		"decline enabled",
	);
}

async function saveDraft(page: Page, title: string): Promise<string> {
	await composeNew(page, { title });
	await region(page, "Task detail")
		.getByRole("button", { name: "Save draft" })
		.click();
	await until(async () => (await taskIdFromUrl(page)) !== "", "draft saved");
	return taskIdFromUrl(page);
}

const validityOf = (page: Page, scope: string) =>
	region(page, scope).getByTestId("acceptance-validity").first();

async function validityView(page: Page, scope: string) {
	const v = validityOf(page, scope);
	if ((await v.count()) === 0) return null;
	return {
		status: await v.getAttribute("data-status"),
		reason: await v.getAttribute("data-reason"),
		freshness: await v.getAttribute("data-freshness"),
		role: await v.getAttribute("role"),
		cls: (await v.getAttribute("class")) ?? "",
		text: await textOf(v),
		line: await textOf(v.getByTestId("validity-freshness")).catch(() => ""),
		bg: (await v.evaluate(
			(el) => getComputedStyle(el).backgroundColor,
		)) as string,
	};
}

// ── cases ───────────────────────────────────────────────────────────────────

let main!: Session;
const T: Record<string, string> = {}; // task ids by key
const R: Record<string, string> = {}; // request ids by key

async function sceneCase() {
	await run.case("CMP-00-scene", async () => {
		run.current = main.page;
		const page = main.page;
		await page.locator(".cmp").waitFor();
		const st = await sceneSettled(page, 30_000);
		const p = await campusProbe(page);
		const gl = (await page.evaluate(() => {
			const c = document.createElement("canvas");
			return c.getContext("webgl2") !== null;
		})) as boolean;
		sceneLive = st === "live";
		facts.scene = `${st}/${p.mode}`;
		check(
			p.buildings.length === 1 && p.buildings[0]?.id === env.repoId,
			`buildings ${JSON.stringify(p.buildings)}`,
		);
		check(
			(await page
				.getByRole("button", { name: env.repoId, exact: true })
				.count()) === 1,
			"building button not named by repo id",
		);
		check(
			(await page.getByRole("button", { name: "Headquarters" }).count()) === 1,
			"no Headquarters button",
		);
		check(
			st === "live",
			`scene not live (${st}; note ${p.note}; webgl2 in page ${gl})`,
		);
		check(
			p.canvases === 1 && p.glLive === 1,
			`canvases ${p.canvases}, live GL contexts ${p.glLive}`,
		);
		await run.shot(page, "campus-initial");
		return `scene ${st}, mode ${p.mode}, reduced ${p.reduced}; 1 building (${env.repoId}); canvases ${p.canvases}; GL contexts total ${p.glTotal} / live ${p.glLive}`;
	});
}

async function j1() {
	await run.case("CMP-J01", async () => {
		run.current = main.page;
		const page = main.page;
		const title = "C01 Fresh v1.2 proposal";
		const id = await submitNew(page, {
			title,
			criteria: "Build passes, lint passes\nNo change outside src/",
		});
		T.a = id;
		const r = await waitPendingReq(id, "run");
		R.a = r.id;
		const snap = db1<{ snapshot: string; contract_version: string }>(
			"SELECT p.snapshot, p.contract_version FROM managed_proposals p JOIN workspace_tasks t ON t.current_proposal_id = p.id WHERE t.id = ?",
			id,
		);
		check(snap, "no proposal row");
		const s = JSON.parse(snap.snapshot) as {
			contract: string;
			criteria: { id: string; text: string }[];
			coverage_plan: { criterion_id: string; checks: string[] }[];
		};
		check(s.contract === "agentcity.proposal/v1.2", `contract ${s.contract}`);
		check(
			s.criteria.length === 2 &&
				s.criteria.every((c) => /^crit-[0-9a-f]{16}$/.test(c.id)),
			"criterion ids",
		);
		check(
			s.coverage_plan.length === 2 &&
				s.coverage_plan.every(
					(c, i) =>
						c.criterion_id === s.criteria[i]?.id &&
						c.checks.join() === "fixture-check",
				),
			`coverage plan ${JSON.stringify(s.coverage_plan)}`,
		);
		const rows = (await region(page, "Task detail")
			.getByTestId("criteria-plan")
			.first()
			.locator("tr[data-criterion-id]")
			.evaluateAll((trs) =>
				trs.map(
					(t) =>
						`${t.getAttribute("data-criterion-id")}=${t.getAttribute("data-checks")}`,
				),
			)) as string[];
		check(
			rows.length === 2 && rows.every((x) => x.endsWith("=fixture-check")),
			`UI plan ${rows.join(" ")}`,
		);
		// nothing executes before Gate 1
		const mt = taskRow(id)?.current_managed_task_id ?? "";
		await sleep(3000);
		const m = managedRow(mt);
		check(
			m?.state === "draft" && m.run_requested_at === null,
			`engine ${m?.state}/${m?.run_requested_at}`,
		);
		check(runsOf(mt).length === 0, "an attempt exists before Gate 1");
		check(decisionsFor(r.id) === 0, "decided");
		await until(
			async () => (await visitButton(page, r.id).count()) === 1,
			"campus document for the new request",
			6000,
		);
		const gate = await visitButton(page, r.id).getAttribute("data-gate");
		check(gate === "run", `data-gate ${gate}`);
		return `contract v1.2, 2 criterion ids, plan ↔ criteria bijection (UI ${rows.length} rows); engine draft, 0 attempts after 3 s; campus document data-gate=${gate}`;
	});
}

async function j2() {
	await run.case("CMP-J02", async () => {
		run.current = main.page;
		const { page, traffic } = main;
		// (a) campus document button, before the CEO arrives
		const title = "C02 Gate one before arrival";
		const id = await submitNew(page, { title });
		T.b = id;
		const r = await waitPendingReq(id, "run");
		R.b = r.id;
		const born = Date.parse(r.created_at);
		const btn = visitButton(page, r.id);
		await btn.waitFor({ timeout: 6000 });
		const name = await btn.getAttribute("aria-label");
		check(
			name === `Execution approval · ${title}`,
			`document button name "${name}"`,
		);
		const before = await campusProbe(page);
		const free = await notCovered(
			page,
			`.cmp-visit[data-request-id="${r.id}"]`,
		);
		check(free, "the document button is covered (canvas/figure overlays it)");
		const t0 = Date.now();
		const c0 = main.challengePosts.length;
		await btn.click();
		await docFor(page, r.id).waitFor();
		const openedAge = Date.now() - born;
		await sleep(400);
		const after = await campusProbe(page);
		const walkingAtClick = Number(before.walking ?? "NaN");
		const walkingAfter = Number(after.walking ?? "NaN");
		if (sceneLive)
			check(
				walkingAtClick > 0 || walkingAfter > 0,
				`no visitor walking when the document opened (walking ${before.walking}/${after.walking}, age ${openedAge} ms)`,
			);
		else
			check(
				openedAge < MIN_WALK_MS,
				`document opened ${openedAge} ms after creation`,
			);
		await run.shot(page, "hq-pending-document-with-ceo-visit");
		check(
			(await sigField(page, "run").inputValue()) === "",
			"signature prefilled",
		);
		check(
			!(await grantButton(page, "run").isEnabled()),
			"Approve enabled before typing",
		);
		check(
			postsFor(traffic, r.id, t0).length === 0 &&
				main.challengePosts.length === c0,
			"opening the document sent a request",
		);
		await typeSignature(page, "run");
		await grantButton(page, "run").click();
		await until(
			async () => /Execution approved/.test(await decisionStatus(page)),
			"approved",
		);
		await sleep(1200);
		const nPosts = postsFor(traffic, r.id, t0).length;
		check(nPosts === 1, `${nPosts} decision POSTs`);
		check(decisionsFor(r.id) === 1, "decisions ≠ 1");
		facts.j2a = `opened ${openedAge} ms after creation, walking ${before.walking}→${after.walking}, visitors ${after.visitors}`;

		// (b) inbox, before arrival; then let the CEO arrive with the document open
		const title2 = "C02b Inbox before arrival";
		const id2 = await submitNew(page, { title: title2 });
		T.c = id2;
		const r2 = await waitPendingReq(id2, "run");
		R.c = r2.id;
		const born2 = Date.parse(r2.created_at);
		await navLink(page, /^Head/).click();
		const inbox = region(page, "Approval inbox");
		const item = inbox.getByRole("button", {
			name: new RegExp(`^Execution approval · ${title2}`),
		});
		await until(async () => (await item.count()) > 0, "inbox item", 8000);
		const t1 = Date.now();
		const c1 = main.challengePosts.length;
		await item.first().click();
		await docFor(page, r2.id).waitFor();
		const age2 = Date.now() - born2;
		await sleep(400);
		const p2 = await campusProbe(page);
		if (sceneLive)
			check(
				Number(p2.walking ?? "0") > 0,
				`no visitor walking after the inbox open (age ${age2} ms, walking ${p2.walking})`,
			);
		else check(age2 < MIN_WALK_MS, `opened ${age2} ms after creation`);
		const hash = (await page.evaluate(() => location.hash)) as string;
		// arrival is a pose only
		const arriveBy = Date.now() + MAX_WALK_MS + 6000;
		let arrived = false;
		while (Date.now() < arriveBy) {
			const p = await campusProbe(page);
			if (sceneLive ? p.walking === "0" : Date.now() - born2 > MAX_WALK_MS) {
				arrived = true;
				break;
			}
			await sleep(250);
		}
		check(arrived, "the CEO never arrived");
		await sleep(2500); // spans a poll after arrival
		check(postsFor(traffic, r2.id, t1).length === 0, "arrival → decision POST");
		check(
			main.challengePosts.length === c1 &&
				challengePostsFor(main, r2.id, t1).length === 0,
			`arrival → ${main.challengePosts.length - c1} challenge POST(s)`,
		);
		check(reqRow(r2.id)?.status === "pending", "request left pending");
		check(
			((await page.evaluate(() => location.hash)) as string) === hash,
			"arrival changed the route",
		);
		check(
			(await docFor(page, r2.id).count()) === 1,
			"document closed at arrival",
		);
		check(
			(await sigField(page, "run").inputValue()) === "" &&
				!(await grantButton(page, "run").isEnabled()),
			"arrival filled the signature or enabled Approve",
		);
		await typeSignature(page, "run");
		await grantButton(page, "run").click();
		await until(
			async () => /Execution approved/.test(await decisionStatus(page)),
			"approved (b)",
		);
		await sleep(1200);
		check(postsFor(traffic, r2.id, t1).length === 1, "decision POSTs ≠ 1 (b)");
		check(decisionsFor(r2.id) === 1, "decisions ≠ 1 (b)");
		return `(a) campus button: ${facts.j2a}; 1 POST, 1 decision. (b) inbox: opened ${age2} ms after creation (walking ${p2.walking}); CEO arrived with the document open → 0 decision / 0 challenge POSTs, route unchanged, request pending; then 1 POST, 1 decision`;
	});
}

async function j3() {
	await run.case("CMP-J03a", async () => {
		run.current = main.page;
		const page = main.page;
		const title = "C03 Engine progress from the hub";
		const id = await submitNew(page, { title });
		T.e = id;
		const r = await waitPendingReq(id, "run");
		const mt = taskRow(id)?.current_managed_task_id ?? "";
		const dbFirst = new Map<string, number>();
		const dbSeq: string[] = [];
		let polling = true;
		const poller = (async () => {
			while (polling) {
				const m = managedRow(mt);
				if (m && !dbFirst.has(m.state)) {
					dbFirst.set(m.state, Date.now());
					dbSeq.push(m.state);
				}
				await sleep(25);
			}
		})();
		try {
			await openViaCampus(page, r.id);
			await typeSignature(page, "run");
			await grantButton(page, "run").click();
			await until(
				async () => /Execution approved/.test(await decisionStatus(page)),
				"approved",
			);
			await openTask(page, id);
			await page.evaluate((tid) => {
				const w = window as unknown as {
					__cmpRec: { v: string; at: number }[];
				};
				w.__cmpRec = [];
				const rec = () => {
					const p = document.querySelector(
						`section[aria-label="Task detail"][data-task-id="${tid}"]`,
					);
					const e =
						p
							?.querySelector('[data-testid="engine-state"]')
							?.getAttribute("data-state") ?? "-";
					if (w.__cmpRec.at(-1)?.v !== e)
						w.__cmpRec.push({ v: e, at: Date.now() });
				};
				rec();
				new MutationObserver(rec).observe(document.body, {
					subtree: true,
					attributes: true,
					childList: true,
					characterData: true,
				});
			}, id);
			await waitEngine(page, ["human_ready", "failed", "blocked"], 120_000);
			await waitStage(page, "Awaiting acceptance", 30_000);
			await sleep(300);
		} finally {
			polling = false;
			await poller;
		}
		const rec = (await page.evaluate(
			() =>
				(window as unknown as { __cmpRec: { v: string; at: number }[] })
					.__cmpRec,
		)) as { v: string; at: number }[];
		const ui = rec.filter((x) => x.v !== "-");
		const bad: string[] = [];
		const leads: string[] = [];
		for (const x of ui) {
			const d = dbFirst.get(x.v);
			if (d === undefined) bad.push(`${x.v}: shown, never in the DB`);
			else if (x.at < d - 60)
				bad.push(`${x.v}: UI ${d - x.at} ms BEFORE the DB`);
			else leads.push(`${x.v}+${x.at - d}ms`);
		}
		check(bad.length === 0, bad.join("; "));
		check(
			managedRow(mt)?.state === "human_ready",
			`engine ${managedRow(mt)?.state}`,
		);
		return `DB ${dbSeq.join("→")}; UI ${ui.map((x) => x.v).join("→")}; UI lag behind the DB: ${leads.join(", ")}`;
	});

	await run.case("CMP-J03b", async () => {
		run.current = main.page;
		const page = main.page;
		const title = "C03b Hanging implementer";
		const id = await submitNew(page, { title, scenario: "impl_hangs" });
		T.d = id;
		await approveViaCampus(page, id);
		const mt = taskRow(id)?.current_managed_task_id ?? "";
		await openTask(page, id);
		await waitEngine(page, ["executing"], 60_000);
		const st0 = await stageText(page);
		const samples: string[] = [];
		const w0 = (await campusProbe(page)).walking;
		for (let i = 0; i < 9; i++) {
			await sleep(1000);
			const ui = await attr(page, "engine-state", "data-state");
			const st = await stageText(page);
			const dbs = managedRow(mt)?.state;
			samples.push(`${ui}/${dbs}`);
			check(
				ui === "executing" && dbs === "executing" && st === st0,
				`advanced without the hub: UI ${ui}, DB ${dbs}, stage "${st}"`,
			);
		}
		const w1 = (await campusProbe(page)).walking;
		facts.j3b = id;
		return `9 × 1 s while the scene animated (walking ${w0}→${w1}): UI/DB ${[...new Set(samples)].join(",")}; stage "${st0}" unchanged`;
	});

	await run.case("CMP-J05c-cancel", async () => {
		run.current = main.page;
		const page = main.page;
		check(T.d, "J03b task missing");
		const mt = taskRow(T.d)?.current_managed_task_id ?? "";
		await region(page, "Task detail")
			.getByRole("button", { name: "Cancel execution" })
			.click();
		const seen: string[] = [];
		await until(
			async () => {
				const c = await attr(page, "cancellation-status", "data-status");
				const e = await attr(page, "engine-state", "data-state");
				const v = `${c}|${e}`;
				if (seen.at(-1) !== v) seen.push(v);
				return c === "confirmed";
			},
			"cancel confirmed",
			30_000,
			150,
		);
		await waitStage(page, "Cancelled", 20_000);
		check(managedRow(mt)?.state === "cancelled", "engine not cancelled");
		check(taskRow(T.d)?.stage === "cancelled", "DB stage");
		const early = seen.filter(
			(x) =>
				x.startsWith("confirmed|") &&
				["queued", "executing", "verifying", "reviewing"].includes(
					x.split("|")[1] ?? "",
				),
		);
		check(
			early.length === 0,
			`confirmed while engine active: ${early.join(",")}`,
		);
		return `cancellation/engine: ${seen.join(" → ")}; stage Cancelled`;
	});
}

async function j4() {
	await run.case("CMP-J04", async () => {
		run.current = main.page;
		const { page, traffic } = main;
		check(T.e, "J03a task missing");
		const rr = await waitPendingReq(T.e, "result", 60_000);
		R.eResult = rr.id;
		await openViaCampus(page, rr.id);
		const doc = docFor(page, rr.id);
		check((await doc.getAttribute("data-gate")) === "result", "gate");
		check(
			(await sigField(page, "result").inputValue()) === "",
			"Gate-2 signature not fresh (prefilled)",
		);
		check(
			!(await grantButton(page, "result").isEnabled()),
			"Accept enabled before typing",
		);
		const cov = await coverageRows(page, "Approval document");
		check(
			cov.length === 2 &&
				cov.every(
					(c) =>
						c.status === "satisfied" &&
						c.checks.length === 1 &&
						/^fixture-check:passed:/.test(c.checks[0] ?? ""),
				),
			`coverage ${JSON.stringify(cov)}`,
		);
		await region(page, "Approval document")
			.getByTestId("criterion-coverage")
			.first()
			.scrollIntoViewIfNeeded();
		await run.shot(page, "coverage");
		// evidence: open, read, close (focus returns)
		const ev = region(page, "Approval document").getByRole("region", {
			name: "Evidence",
		});
		const first = ev.locator("li button").first();
		const evName = await textOf(first);
		const evId = (await first.getAttribute("id")) ?? "";
		await first.click();
		const dlg = page.getByRole("dialog");
		await dlg.waitFor();
		await until(
			async () => (await dlg.getAttribute("data-state")) !== "loading",
			"viewer loaded",
		);
		const vState = await dlg.getAttribute("data-state");
		check(vState === "ok", `viewer ${vState}`);
		await page.keyboard.press("Escape");
		await dlg.waitFor({ state: "detached" });
		const f = await focused(page);
		check(f.id === evId, `focus after closing the viewer: ${f.tag}#${f.id}`);
		// fresh Edward, accept once
		const t0 = Date.now();
		await typeSignature(page, "result");
		await grantButton(page, "result").click();
		await until(
			async () =>
				(await attr(page, "acceptance-status", "data-status")) === "accepted",
			"accepted",
		);
		await sleep(1200);
		check(postsFor(traffic, rr.id, t0).length === 1, "decision POSTs ≠ 1");
		check(decisionsFor(rr.id) === 1, "decisions ≠ 1");
		check(taskRow(T.e)?.stage === "accepted", "DB stage");
		await until(
			async () =>
				(await validityView(page, "Approval document"))?.status === "valid",
			"HQ validity valid",
			20_000,
		);
		const v = await validityView(page, "Approval document");
		check(v, "no validity block");
		check(
			/^Last check \d+ s ago \(/.test(v.line),
			`freshness line "${v.line}"`,
		);
		check(v.freshness === "fresh", `freshness ${v.freshness}`);
		await until(
			async () => (await visitButton(page, rr.id).count()) === 0,
			"result document leaves the campus",
			6000,
		);
		await openTask(page, T.e);
		await until(
			async () => (await validityView(page, "Task detail"))?.status === "valid",
			"task validity valid",
		);
		const tv = await validityView(page, "Task detail");
		check(tv && /^Last check \d+ s ago/.test(tv.line), "task freshness line");
		return `coverage 2/2 satisfied (fixture-check passed + log); evidence "${evName}" viewer ok, Escape → focus back on #${evId.slice(0, 12)}…; 1 POST, 1 decision; HQ validity valid/${v.freshness} "${v.line}" (${v.cls.includes("tone-ok") ? "green" : "not green"}); task "${tv?.line}"`;
	});
}

async function j5() {
	await run.case("CMP-J05a-request-changes", async () => {
		run.current = main.page;
		const page = main.page;
		check(T.b, "J02 task missing");
		const rr = await waitPendingReq(T.b, "result", 120_000);
		const mt = taskRow(T.b)?.current_managed_task_id ?? "";
		const runs0 = runsOf(mt).length;
		await openViaCampus(page, rr.id);
		await typeReason(page, "Please also cover the empty case.");
		await region(page, "Approval document")
			.getByRole("button", { name: "Request changes", exact: true })
			.click();
		await until(
			async () =>
				(await attr(page, "acceptance-status", "data-status")) ===
				"changes_requested",
			"changes requested",
		);
		await until(
			async () => (await visitButton(page, rr.id).count()) === 0,
			"document leaves the campus",
			6000,
		);
		await sleep(2500);
		check(taskRow(T.b)?.stage === "changes_requested", "DB stage");
		check(runsOf(mt).length === runs0, "a new attempt started");
		check(managedRow(mt)?.state === "human_ready", "engine changed");
		check(decisionsFor(rr.id) === 1, "decisions ≠ 1");
		return `Gate 2 request changes via the campus document: stage changes_requested, engine human_ready, attempts ${runs0} unchanged, 1 decision`;
	});

	await run.case("CMP-J05b-reject", async () => {
		run.current = main.page;
		const page = main.page;
		const id = await submitNew(page, { title: "C05b Reject at Gate one" });
		const r = await waitPendingReq(id, "run");
		const mt = taskRow(id)?.current_managed_task_id ?? "";
		await openViaCampus(page, r.id);
		await typeReason(page, "Not this one.");
		await region(page, "Approval document")
			.getByRole("button", { name: "Reject", exact: true })
			.click();
		await until(
			async () =>
				(await docFor(page, r.id).getAttribute("data-request-status")) ===
				"rejected",
			"request rejected",
		);
		await until(
			async () => (await visitButton(page, r.id).count()) === 0,
			"document leaves the campus",
			6000,
		);
		await sleep(2000);
		check(taskRow(id)?.stage === "rejected", "DB stage");
		check(runsOf(mt).length === 0, "an attempt ran");
		check(managedRow(mt)?.run_requested_at === null, "queued");
		return `Gate 1 reject: request rejected, stage rejected, engine ${managedRow(mt)?.state}, 0 attempts`;
	});

	await run.case("CMP-J05d-lost-response", async () => {
		run.current = main.page;
		const { page, traffic } = main;
		const id = await submitNew(page, { title: "C05d Lost decision answer" });
		T.g = id;
		const r = await waitPendingReq(id, "run");
		const mt = taskRow(id)?.current_managed_task_id ?? "";
		await openViaCampus(page, r.id);
		await typeSignature(page, "run");
		let n = 0;
		await page.route(
			`**/approval-requests/${r.id}/decisions`,
			async (route) => {
				n += 1;
				if (n === 1) {
					await route.fetch().catch(() => null);
					await route.abort("connectionreset").catch(() => undefined);
					return;
				}
				await route.continue().catch(() => undefined);
			},
		);
		const t0 = Date.now();
		await grantButton(page, "run").click();
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
					/Execution approved/.test(st) ||
					(await docFor(page, r.id).getAttribute("data-request-status")) ===
						"approved"
				);
			},
			"approved after the lost answer",
			25_000,
		);
		await page.unrouteAll({ behavior: "ignoreErrors" });
		await sleep(1500);
		const p = postsFor(traffic, r.id, t0);
		check(new Set(p.map((x) => x.body)).size === 1, "POST bodies differ");
		check(decisionsFor(r.id) === 1, `decisions ${decisionsFor(r.id)}`);
		const m = managedRow(mt);
		check(m?.run_requested_at !== null, "not queued");
		const queuedTwice =
			db1<{ n: number }>(
				"SELECT count(*) AS n FROM managed_approval_requests WHERE workspace_task_id = ? AND kind = 'run'",
				id,
			)?.n ?? -1;
		check(queuedTwice === 1, `${queuedTwice} Gate-1 requests`);
		return `unknown shown=${sawUnknown}; "Check decision outcome" clicked=${clicked}; ${p.length} POST(s), identical body; 1 decision; 1 queued execution (engine ${m?.state})`;
	});
}

async function j6Obsolete() {
	await run.case("CMP-J06b-obsolete-pending", async () => {
		run.current = main.page;
		const page = main.page;
		const id = await saveDraft(page, "C06b Obsolete v1 pending");
		const l = await seedLegacyPending(env, id);
		R.legacy = l.runRequestId;
		const prop = db1<{ contract_version: string }>(
			"SELECT contract_version FROM managed_proposals WHERE id = ?",
			l.proposalId,
		);
		check(
			prop?.contract_version === "agentcity.proposal/v1",
			`seeded contract ${prop?.contract_version}`,
		);
		// open through the campus document button if it shows up before the sweep retires it
		let via = "campus";
		try {
			await openViaCampus(page, l.runRequestId, 6000);
		} catch {
			via = "url (retired before the campus listed it)";
			await page.evaluate(
				({ t, q }) => {
					location.hash = `#/hq/${t}/${q}`;
				},
				{ t: id, q: l.runRequestId },
			);
			await docFor(page, l.runRequestId).waitFor();
		}
		const banner = page.getByTestId("obsolete-grant");
		await banner.waitFor();
		const first = await banner.getAttribute("data-status");
		let approveDisabledWhilePending: boolean | null = null;
		if (first === "pending") {
			approveDisabledWhilePending = !(await grantButton(
				page,
				"run",
			).isEnabled());
			check(approveDisabledWhilePending, "Approve enabled on a legacy request");
			// typing asks for a challenge → the hub refuses (409) and retires the request
			const f = sigField(page, "run");
			if (await f.isEnabled()) {
				await f.click();
				await f.pressSequentially("Edward", { delay: 15 });
			}
		}
		await until(
			async () => (await banner.getAttribute("data-status")) === "retired",
			"retired document copy",
			40_000,
		);
		const copy = await textOf(banner);
		await docEscapes(page, "retired obsolete document");
		check(
			/can no longer be approved and nothing was queued/.test(copy),
			`copy "${copy.slice(0, 120)}"`,
		);
		check(
			(await region(page, "Approval document")
				.getByRole("button", { name: "Approve execution" })
				.count()) === 0,
			"a decision control remains",
		);
		const row = reqRow(l.runRequestId);
		check(row, "request row");
		const dec = await pagePost(
			page,
			`/api/workspace/approval-requests/${l.runRequestId}/decisions`,
			{
				idempotency_key: `cmp-obsolete-${Date.now().toString(36)}`,
				kind: "run",
				action: "approve",
				expected_request_rev: row.rev,
				binding_hash: row.binding_hash,
				confirmation_text: "Edward",
				reason: null,
				challenge: bogusToken(),
			},
		);
		check(
			dec.status === 409 &&
				dec.error === "stale_binding" &&
				dec.issue === OBSOLETE_V1_GRANT_DETAIL,
			`direct decision POST → ${dec.status} ${dec.error} "${dec.issue?.slice(0, 60)}"`,
		);
		const ch = await pagePost(
			page,
			`/api/workspace/approval-requests/${l.runRequestId}/challenge`,
			{
				kind: "run",
				binding_hash: row.binding_hash,
				expected_request_rev: row.rev,
			},
		);
		check(
			ch.status === 409 && ch.error === "stale_binding",
			`direct challenge POST → ${ch.status} ${ch.error}`,
		);
		const after = reqRow(l.runRequestId);
		check(
			after?.status === "invalidated" &&
				after.invalidation_reason === "evidence_unavailable" &&
				after.invalidation_detail === OBSOLETE_V1_GRANT_DETAIL,
			`row ${after?.status}/${after?.invalidation_reason}`,
		);
		check(decisionsFor(l.runRequestId) === 0, "a decision exists");
		check(runsOf(l.managedTaskId).length === 0, "an attempt ran");
		check(
			managedRow(l.managedTaskId)?.state === "cancelled",
			`engine ${managedRow(l.managedTaskId)?.state}`,
		);
		check(taskRow(id)?.stage === "draft", `stage ${taskRow(id)?.stage}`);
		check(
			(await visitButton(page, l.runRequestId).count()) === 0,
			"retired document still at Headquarters",
		);
		await run.shot(page, "obsolete-v1-retired");
		return `opened via ${via}; first copy ${first}${approveDisabledWhilePending === null ? "" : ` (Approve disabled ${approveDisabledWhilePending})`}; retired copy shown, no decision control; direct decision POST 409 stale_binding + fixed issue; challenge POST 409; row invalidated/evidence_unavailable; 0 decisions/attempts; engine cancelled; task draft`;
	});

	await run.case("CMP-J06c-obsolete-queued", async () => {
		run.current = main.page;
		const page = main.page;
		const id = await saveDraft(page, "C06c Obsolete v1 queued");
		const l = await seedLegacyPending(env, id);
		const probe = await mintVerified(env);
		for (const s of probe.secrets) run.secrets.add(s);
		try {
			approveLegacyBeforePolicy(env, probe.v, l.runRequestId);
		} finally {
			await probe.signOut();
		}
		let m = managedRow(l.managedTaskId);
		await until(
			() => {
				m = managedRow(l.managedTaskId);
				const t = taskRow(id);
				return (
					(m?.state === "blocked" || m?.state === "cancelled") &&
					(t?.stage === "execution_ended" || t?.stage === "cancelled")
				);
			},
			"obsolete queued grant stopped",
			40_000,
			200,
		);
		await sleep(3000);
		const t = taskRow(id);
		m = managedRow(l.managedTaskId);
		check(runsOf(l.managedTaskId).length === 0, "a stage launched");
		check(
			(t?.stage_detail ?? "").includes(OBSOLETE_V1_GRANT_DETAIL),
			`stage_detail "${t?.stage_detail?.slice(0, 80)}"`,
		);
		if (m?.state === "blocked")
			check(m.failure_kind === "approval_void", `failure ${m.failure_kind}`);
		check(
			db1<{ n: number }>(
				"SELECT count(*) AS n FROM managed_approval_requests WHERE workspace_task_id = ? AND kind = 'result'",
				id,
			)?.n === 0,
			"a result request exists",
		);
		await openTask(page, id);
		const panel = await textOf(region(page, "Task detail"));
		check(
			/Obsolete v1 proposal/i.test(panel),
			"no obsolete guidance in task detail",
		);
		check(
			(await region(page, "Task detail")
				.getByRole("button", { name: "Open result acceptance" })
				.count()) === 0,
			"acceptance offered",
		);
		const st = await stageText(page);
		return `engine ${m?.state}${m?.failure_kind ? `/${m.failure_kind}` : ""}, 0 attempts, task ${t?.stage} with the fixed detail; UI stage "${st}", guidance shown, no acceptance`;
	});
}

async function j7Source() {
	await run.case("CMP-J07a-source-corrupt", async () => {
		run.current = main.page;
		const page = main.page;
		check(T.e && R.eResult, "J04 accepted task missing");
		const before = decisionRow(R.eResult);
		check(before, "no accept decision");
		const mt = taskRow(T.e)?.current_managed_task_id ?? "";
		const diff = artifactsOf(mt).find((a) => a.kind === "diff");
		check(diff, "no diff artifact");
		flipByte(join(env.fx.config.artifacts_root, diff.rel_path));
		await page.reload();
		await page.getByText(/^Signed in as operator:edward/).waitFor();
		await openTask(page, T.e);
		await until(
			async () =>
				(await validityView(page, "Task detail"))?.status === "invalid",
			"task validity invalid",
			30_000,
		);
		const v = await validityView(page, "Task detail");
		check(v, "no validity");
		check(v.reason === "source_evidence_changed", `reason ${v.reason}`);
		check(v.role === "alert", "not an alert");
		check(
			/Accepted on .+, but this result is no longer valid: /.test(v.text),
			`text "${v.text.slice(0, 100)}"`,
		);
		check(!v.cls.includes("tone-ok"), "invalid shown green");
		check(/^Last check \d+ s ago/.test(v.line), `freshness "${v.line}"`);
		check(
			(await attr(page, "acceptance-status", "data-status")) === "accepted",
			"historical acceptance changed",
		);
		const b = page.locator(`.cmp-building[data-repo-id="${env.repoId}"]`);
		await until(
			async () => (await b.getAttribute("data-integrity")) === "invalid",
			"campus integrity warning",
			6000,
		);
		const badge = await textOf(b.locator(".cmp-badge"));
		await validityOf(page, "Task detail").scrollIntoViewIfNeeded();
		await run.shot(page, "invalid-evidence-warning");
		// Headquarters: the document and the history say the same
		await page.evaluate(
			({ t, q }) => {
				location.hash = `#/hq/${t}/${q}`;
			},
			{ t: T.e, q: R.eResult },
		);
		await docFor(page, R.eResult).waitFor();
		await until(
			async () =>
				(await validityView(page, "Approval document"))?.status === "invalid",
			"HQ validity invalid",
		);
		const hv = await validityView(page, "Approval document");
		await docEscapes(page, "accepted-then-invalid document");
		check(hv && /^Last check \d+ s ago/.test(hv.line), "HQ freshness line");
		const hist = region(page, "Decision history").getByTestId(
			"history-acceptance-validity",
		);
		const hs = await hist.first().getAttribute("data-status");
		check(hs === "invalid", `history ${hs}`);
		await run.shot(page, "invalid-evidence-hq-history");
		const after = decisionRow(R.eResult);
		check(
			after?.id === before.id &&
				after.decided_at === before.decided_at &&
				after.response_body === before.response_body,
			"historical decision/receipt changed",
		);
		check(taskRow(T.e)?.stage === "accepted", "stage left accepted");
		return `task: invalid/source_evidence_changed, role=alert, "${v.line}", acceptance-status accepted; campus building data-integrity=invalid ("${badge}"); HQ document invalid "${hv?.line}"; history ${hs}; decision + receipt byte-identical`;
	});
}

async function j9() {
	await run.case("CMP-J09-multi", async () => {
		run.current = main.page;
		const { page, traffic } = main;
		const p1 = await submitNew(page, { title: "C09 Pending one" });
		const p2 = await submitNew(page, { title: "C09 Pending two" });
		const r1 = await waitPendingReq(p1, "run");
		const r2 = await waitPendingReq(p2, "run");
		R.p1 = r1.id;
		T.p1 = p1;
		await navLink(page, /^Head/).click();
		await page.locator(".cmp").waitFor();
		await until(
			async () => (await campusProbe(page)).visits.length >= 3,
			"≥3 documents at Headquarters",
			8000,
		);
		await page.evaluate(() => {
			for (const b of document.querySelectorAll(".cmp-visit"))
				(b as unknown as { __cmpTag: string }).__cmpTag =
					b.getAttribute("data-request-id") ?? "";
		});
		const rows: string[] = [];
		for (let i = 0; i < 5; i++) {
			const dbBefore = pendingIds().sort();
			const p = await campusProbe(page);
			const inbox = (
				await region(page, "Approval inbox")
					.locator("button[data-request-id]")
					.evaluateAll((bs) => bs.map((b) => b.getAttribute("data-request-id")))
			)
				.map(String)
				.sort();
			const dbAfter = pendingIds().sort();
			const dom = [...p.visits].sort();
			check(new Set(dom).size === dom.length, `duplicate visits ${dom.join()}`);
			const eq = (a: string[], b: string[]) => a.join() === b.join();
			check(
				eq(dom, dbBefore) || eq(dom, dbAfter),
				`campus ${dom.length} vs DB ${dbAfter.length} pending`,
			);
			check(eq(inbox, dom), `inbox ${inbox.length} vs campus ${dom.length}`);
			if (sceneLive)
				check(
					p.visitors === String(dom.length),
					`data-visitors ${p.visitors} ≠ ${dom.length}`,
				);
			const kept = (await page.evaluate(() =>
				[...document.querySelectorAll(".cmp-visit")].every((b) => {
					const tag = (b as unknown as { __cmpTag?: string }).__cmpTag;
					return tag === undefined || tag === b.getAttribute("data-request-id");
				}),
			)) as boolean;
			check(kept, "a document button was re-keyed");
			rows.push(`${dom.length}/${p.visitors ?? "-"}`);
			await sleep(2200);
		}
		const persisted = (await page.evaluate(
			() =>
				[...document.querySelectorAll(".cmp-visit")].filter(
					(b) => (b as unknown as { __cmpTag?: string }).__cmpTag !== undefined,
				).length,
		)) as number;
		const allFree: boolean[] = [];
		for (const id of (await campusProbe(page)).visits) {
			await visitButton(page, id).scrollIntoViewIfNeeded();
			allFree.push(
				await notCovered(page, `.cmp-visit[data-request-id="${id}"]`),
			);
		}
		check(allFree.every(Boolean), "a document button is covered");
		// no signature leakage between documents
		await openViaCampus(page, r1.id);
		await typeSignature(page, "run");
		const ch1 = challenges.get(r1.id);
		await visitButton(page, r2.id).click();
		await docFor(page, r2.id).waitFor();
		const f2 = await sigField(page, "run").inputValue();
		const g2 = await grantButton(page, "run").isEnabled();
		check(
			f2 === "" && !g2,
			`document 2 field "${f2 ? "(filled)" : ""}", Approve ${g2}`,
		);
		await visitButton(page, r1.id).click();
		await docFor(page, r1.id).waitFor();
		const back = await sigField(page, "run").inputValue();
		await visitButton(page, r2.id).click();
		await docFor(page, r2.id).waitFor();
		const t0 = Date.now();
		await typeSignature(page, "run");
		await grantButton(page, "run").click();
		await until(
			async () => /Execution approved/.test(await decisionStatus(page)),
			"document 2 approved",
		);
		await sleep(1000);
		const sent = postsFor(traffic, r2.id, t0);
		check(sent.length === 1, `${sent.length} POSTs for document 2`);
		const body = JSON.parse(sent[0]?.body ?? "{}") as {
			binding_hash?: string;
			challenge?: string;
		};
		check(
			body.binding_hash === r2.binding_hash,
			"POST bound to another document",
		);
		check(
			!ch1 || body.challenge !== ch1.challenge,
			"document 1's challenge reused for document 2",
		);
		check(postsFor(traffic, r1.id).length === 0, "document 1 POSTed");
		check(decisionsFor(r1.id) === 0, "document 1 decided");
		check(reqRow(r1.id)?.status === "pending", "document 1 left pending");
		// the Headquarters button opens the selected pending document, else the oldest one
		await sleep(2200);
		const oldest = pendingIds()[0] ?? "";
		const hqBefore = traffic.decisionPosts.length;
		await page.getByRole("button", { name: "Headquarters" }).click();
		await docFor(page, oldest).waitFor();
		check(traffic.decisionPosts.length === hqBefore, "HQ button POSTed");
		await navLink(page, /^Projects$/).click();
		await page.locator(".cmp").waitFor();
		await sleep(600);
		await run.shot(page, "campus-overview-multiple-documents");
		return `5 samples 2.2 s apart (campus/visitors): ${rows.join(", ")} — equal to DB pending + inbox each time, no duplicates, ${persisted} buttons kept their node; all buttons uncovered; doc 1 signed → doc 2 field empty & Approve disabled; back on doc 1 field "${back === "" ? "" : "(kept)"}"; doc 2 approved with its own binding/challenge, doc 1 pending with 0 POSTs; Headquarters button opened the oldest pending document (no POST)`;
	});
}

async function j8() {
	await run.case("CMP-J08a-reload", async () => {
		run.current = main.page;
		const page = main.page;
		await navLink(page, /^Head/).click();
		await page.locator(".cmp").waitFor();
		await sceneSettled(page);
		const a = (await campusProbe(page)).visits.sort();
		await page.reload();
		await page.getByText(/^Signed in as operator:edward/).waitFor();
		await page.locator(".cmp").waitFor();
		const st = await sceneSettled(page);
		let b: string[] = [];
		await until(
			async () => {
				b = (await campusProbe(page)).visits.sort();
				return b.length > 0;
			},
			"visits after reload",
			8000,
		);
		await sleep(600);
		const p = await campusProbe(page);
		const dbIds = pendingIds().sort();
		check(
			b.join() === dbIds.join(),
			`after reload ${b.length} vs DB ${dbIds.length}`,
		);
		const same = a.filter((x) => b.includes(x)).length;
		return `before ${a.length} / after ${b.length} documents (${same} same ids, = DB); scene ${st}; walking right after reload ${p.walking} (visits anchored to created_at, no replay)`;
	});

	await run.case("CMP-J08b-selection-late", async () => {
		run.current = main.page;
		const page = main.page;
		check(T.a && T.e, "tasks missing");
		await openTask(page, T.e);
		let delayed = 0;
		await page.route(`**/api/workspace/tasks/${T.a}`, async (route) => {
			if (route.request().method() !== "GET" || delayed > 0)
				return route.continue();
			delayed += 1;
			const resp = await route.fetch();
			await sleep(2500);
			await route.fulfill({ response: resp }).catch(() => undefined);
		});
		const tasks = region(page, "Tasks");
		await tasks.locator(`[data-task-id="${T.a}"]`).click();
		await sleep(150);
		await tasks.locator(`[data-task-id="${T.e}"]`).click();
		await sleep(3500);
		await page.unrouteAll({ behavior: "ignoreErrors" });
		const shown = await page
			.locator('section[aria-label="Task detail"]')
			.getAttribute("data-task-id");
		const hash = (await page.evaluate(() => location.hash)) as string;
		check(delayed === 1, "the late response was not provoked");
		check(
			shown === T.e,
			`panel shows ${shown?.slice(-8)} (want the second selection)`,
		);
		check(hash.includes(T.e), "route lost the second selection");
		const cur = await page
			.locator(`.cmp-building[data-repo-id="${env.repoId}"]`)
			.getAttribute("aria-current");
		return `A then E (A's detail answered 2.5 s late): panel + route stay on E; building aria-current=${cur}`;
	});

	await run.case("CMP-J08c-stale-snapshot", async () => {
		run.current = main.page;
		const page = main.page;
		const id = await submitNew(page, { title: "C08c Stale snapshot" });
		const r = await waitPendingReq(id, "run");
		await openViaCampus(page, r.id);
		await typeSignature(page, "run");
		let held = false;
		let fetched = false;
		let release: () => void = () => undefined;
		const gate = new Promise<void>((res) => {
			release = res;
		});
		await page.route("**/api/workspace/snapshot**", async (route) => {
			if (held) return route.continue();
			held = true;
			const resp = await route.fetch();
			fetched = true;
			await gate;
			await route.fulfill({ response: resp }).catch(() => undefined);
		});
		await until(
			() => fetched,
			"a snapshot read taken before the decision",
			8000,
		);
		await grantButton(page, "run").click();
		await until(
			async () => /Execution approved/.test(await decisionStatus(page)),
			"approved",
		);
		await until(
			async () => (await visitButton(page, r.id).count()) === 0,
			"visit ended",
			6000,
		);
		await page.evaluate((rid) => {
			const w = window as unknown as { __cmpBack: number; __cmpIv: number };
			w.__cmpBack = 0;
			w.__cmpIv = window.setInterval(() => {
				if (document.querySelector(`.cmp-visit[data-request-id="${rid}"]`))
					w.__cmpBack += 1;
			}, 50);
		}, r.id);
		release();
		await sleep(4500);
		await page.unrouteAll({ behavior: "ignoreErrors" });
		const back = (await page.evaluate(() => {
			const w = window as unknown as { __cmpBack: number; __cmpIv: number };
			clearInterval(w.__cmpIv);
			return w.__cmpBack;
		})) as number;
		check(back === 0, `the decided document reappeared in ${back} samples`);
		check(
			(await docFor(page, r.id).getAttribute("data-request-status")) ===
				"approved",
			"document status regressed",
		);
		return "a snapshot read taken before the decision, delivered after it: the decided document never reappeared (0 of ~90 samples), status stays approved";
	});

	await run.case("CMP-J08d-restart", async () => {
		run.current = main.page;
		const { page, traffic } = main;
		const id = await submitNew(page, {
			title: "C08d Signature across restart",
		});
		const r = await waitPendingReq(id, "run");
		await openViaCampus(page, r.id);
		await typeSignature(page, "run");
		check(await stashCsrf(page), "csrf stash");
		await until(
			() => activeEngines() === 0,
			"engines idle before restart",
			120_000,
			500,
		);
		const before = pendingIds().sort();
		const postsBefore = traffic.decisionPosts.length;
		await env.restartHub();
		await page
			.getByRole("heading", { name: "Operator sign-in" })
			.waitFor({ timeout: 20_000 });
		const notice = (await textOf(page.getByRole("main"))).slice(0, 90);
		check(
			!(await page.content()).includes('value="Edward"'),
			"signature kept after the boot change",
		);
		const old = await pagePost(
			page,
			`/api/workspace/approval-requests/${r.id}/decisions`,
			{
				idempotency_key: `cmp-old-${Date.now().toString(36)}`,
				kind: "run",
				action: "approve",
				expected_request_rev: r.rev,
				binding_hash: r.binding_hash,
				confirmation_text: "Edward",
				reason: null,
				challenge: challenges.get(r.id)?.challenge ?? bogusToken(),
			},
			"stashed",
		);
		await dropStash(page);
		check(old.status === 401, `old-session POST → ${old.status} ${old.error}`);
		check(decisionsFor(r.id) === 0, "decided across the restart");
		await signIn(page, env.credential);
		await captureSessionSecrets(main);
		await navLink(page, /^Head/).click();
		await page.locator(".cmp").waitFor();
		const st = await sceneSettled(page);
		let after: string[] = [];
		await until(
			async () => {
				after = (await campusProbe(page)).visits.sort();
				return after.join() === pendingIds().sort().join();
			},
			"campus = DB pending after restart",
			10_000,
		);
		await openViaCampus(page, r.id);
		check(
			(await sigField(page, "run").inputValue()) === "",
			"signature restored",
		);
		check(
			traffic.decisionPosts.filter((p) => !p.body.includes("cmp-old-"))
				.length === postsBefore,
			"a UI decision POST during the restart",
		);
		return `restart → "${notice}"; old-session decision POST → 401 ${old.error}; 0 decisions; re-signed in: campus ${after.length} documents = DB (before ${before.length}); scene ${st}; field empty`;
	});
}

async function mountCycles() {
	await run.case("CMP-MOUNT", async () => {
		run.current = main.page;
		const page = main.page;
		const errs0 = run.consoleErrors.length;
		const rows: string[] = [];
		const g0 = (await campusProbe(page)).glTotal;
		for (let i = 0; i < 4; i++) {
			for (const [name, re] of [
				["P", /^Projects$/],
				["H", /^Head/],
				["A", /^Activity$/],
			] as const) {
				await navLink(page, re).click();
				if (name === "A") {
					await until(
						async () => {
							const p = await campusProbe(page);
							return !p.present && p.canvases === 0 && p.glLive === 0;
						},
						`cycle ${i} Activity: no campus, canvases or live contexts`,
						5000,
					);
					rows.push("A:0/0");
				} else {
					await page.locator(".cmp").waitFor();
					await sceneSettled(page);
					await until(
						async () => {
							const p = await campusProbe(page);
							return sceneLive
								? p.canvases === 1 && p.glLive === 1
								: p.canvases === 0 && p.glLive === 0;
						},
						`cycle ${i} ${name}: exactly one canvas/context`,
						8000,
					);
					const p = await campusProbe(page);
					rows.push(`${name}:${p.canvases}/${p.glLive}`);
				}
			}
		}
		const g1 = (await campusProbe(page)).glTotal;
		const errs = run.consoleErrors.length - errs0;
		check(errs === 0, `${errs} console error(s) during the cycles`);
		return `4 cycles Projects→HQ→Activity (canvases/live contexts): ${rows.join(" ")}; contexts ever created ${g0}→${g1} (probe + renderer per mount, all released); 0 console errors`;
	});
}

async function keyboardCase() {
	await run.case("CMP-KEYBOARD", async () => {
		const title = "C11 Keyboard both gates";
		const id = await submitNew(main.page, { title });
		const s = await open();
		run.current = s.page;
		const page = s.page;
		const mouse: number[] = [];
		await page.exposeFunction("__cmpMouse", () => mouse.push(Date.now()));
		await page.evaluate(() => {
			document.addEventListener(
				"mousedown",
				() => (window as unknown as { __cmpMouse: () => void }).__cmpMouse(),
				true,
			);
		});
		try {
			await page.evaluate(() => {
				location.hash = "#/projects";
				(document.activeElement as HTMLElement | null)?.blur();
			});
			await page.locator(".cmp").waitFor();
			// select a building
			await tabTo(
				page,
				(f) => f.cls.includes("cmp-building") && f.label === env.repoId,
				"building button",
			);
			await page.keyboard.press("Enter");
			await region(page, "Tasks")
				.getByRole("button", { name: "Assign work" })
				.waitFor();
			const cur = await page
				.locator(`.cmp-building[data-repo-id="${env.repoId}"]`)
				.getAttribute("aria-current");
			check(cur === "true", `building aria-current ${cur}`);
			// open the Gate-1 document
			const r1 = await waitPendingReq(id, "run");
			await until(
				async () => (await visitButton(page, r1.id).count()) === 1,
				"document listed",
				6000,
			);
			// the strip is one tab stop (toolbar): Tab into it, arrow keys to the document
			const arrows1 = await keyToVisit(page, `Execution approval · ${title}`);
			await page.keyboard.press("Enter");
			await docFor(page, r1.id).waitFor();
			const afterOpen = await focused(page);
			await tabTo(page, (f) => f.label === SIG_LABEL.run, "Gate-1 signature");
			await page.keyboard.type("Edward", { delay: 20 });
			await until(
				async () => grantButton(page, "run").isEnabled(),
				"Approve enabled",
			);
			await tabTo(page, (f) => f.text === "Approve execution", "Approve");
			await page.keyboard.press("Enter");
			await until(
				async () => /Execution approved/.test(await decisionStatus(page)),
				"approved by keyboard",
			);
			// Gate 2
			const r2 = await waitPendingReq(id, "result", 120_000);
			await until(
				async () => (await visitButton(page, r2.id).count()) === 1,
				"result document listed",
				8000,
			);
			const arrows2 = await keyToVisit(page, `Result acceptance · ${title}`);
			await page.keyboard.press("Enter");
			await docFor(page, r2.id).waitFor();
			const evBtn = region(page, "Approval document")
				.getByRole("region", { name: "Evidence" })
				.locator("li button")
				.first();
			await evBtn.waitFor();
			const evIds = (await region(page, "Approval document")
				.getByRole("region", { name: "Evidence" })
				.locator("li button")
				.evaluateAll((bs) => bs.map((b) => b.id))) as string[];
			check(evIds.length >= 2, `${evIds.length} evidence buttons`);
			const [ev1 = "", ev2 = ""] = evIds;
			// navigate the evidence list: first item, Tab to the next one, open that one
			await tabTo(page, (f) => f.id === ev1, "first evidence button");
			await page.keyboard.press("Tab");
			const next = await focused(page);
			check(next.id === ev2, `Tab from evidence 1 → ${next.tag}#${next.id}`);
			const evId = ev2;
			const evName = next.text;
			await page.keyboard.press("Enter");
			const dlg = page.getByRole("dialog");
			await dlg.waitFor();
			await until(
				async () => (await dlg.getAttribute("data-state")) !== "loading",
				"viewer",
			);
			const dlgName = await dlg.getAttribute("aria-label");
			check(dlgName === `Evidence: ${evName}`, `dialog "${dlgName}"`);
			const where = async () =>
				(await page.evaluate(() => {
					const a = document.activeElement;
					if (!a || a === document.body) return "body";
					return a.closest("dialog") ? "dialog" : "background";
				})) as string;
			const atOpen = await where();
			const trail: string[] = [];
			for (let i = 0; i < 4; i++) {
				await page.keyboard.press("Tab");
				trail.push(await where());
			}
			check(atOpen === "dialog", `focus at open: ${atOpen}`);
			check(
				!trail.includes("background"),
				`Tab reached the page behind the modal: ${trail.join(",")}`,
			);
			const inDialog = `${atOpen}; Tab ×4 → ${trail.join(",")}`;
			await page.keyboard.press("Escape");
			await dlg.waitFor({ state: "detached" });
			const back = await focused(page);
			check(back.id === evId, `focus after Escape: ${back.tag}#${back.id}`);
			await tabTo(
				page,
				(f) => f.label === SIG_LABEL.result,
				"Gate-2 signature",
			);
			await page.keyboard.type("Edward", { delay: 20 });
			await until(
				async () => grantButton(page, "result").isEnabled(),
				"Accept enabled",
			);
			await tabTo(page, (f) => f.text === "Accept result", "Accept");
			await page.keyboard.press("Enter");
			await until(
				async () =>
					(await attr(page, "acceptance-status", "data-status")) === "accepted",
				"accepted by keyboard",
			);
			check(mouse.length === 0, `${mouse.length} mouse events`);
			check(
				decisionsFor(r1.id) === 1 && decisionsFor(r2.id) === 1,
				"decisions",
			);
			return `building (Enter) → aria-current=true; Gate-1 document via the strip (Tab + Home + ${arrows1} arrow press(es); focus then on ${afterOpen.tag}${afterOpen.id ? `#${afterOpen.id}` : ""}); signed + approved; Gate-2 document via the strip (${arrows2} arrow press(es)); evidence list navigated (Tab 1→2), "${evName}" opened (focus ${inDialog}), Escape → focus back on that evidence button; accepted; 0 mouse events`;
		} finally {
			await close(s);
			run.current = main.page;
		}
	});
}

async function toolbarCase() {
	await run.case("CMP-KEYBOARD-toolbar", async () => {
		// ≥ 3 pending documents (created through the UI by the main session when needed)
		let made = 0;
		while (pendingIds().length < 3) {
			await submitNew(main.page, { title: `C13 Toolbar filler ${++made}` });
		}
		const s = await open();
		run.current = s.page;
		const { page, traffic } = s;
		try {
			await page.evaluate(() => {
				location.hash = "#/hq";
			});
			await page.locator(".cmp").waitFor();
			const ids = async () =>
				(await page
					.locator(".cmp-visit")
					.evaluateAll((bs) =>
						bs.map((b) => b.getAttribute("data-request-id") ?? ""),
					)) as string[];
			let order: string[] = [];
			await until(
				async () => {
					order = await ids();
					return order.join() === pendingIds().join() && order.length >= 3;
				},
				"strip = DB pending (≥3)",
				10_000,
			);
			const n = order.length;
			const stops0 = await stripTabStops(page);
			check(
				stops0 === 1,
				`${stops0} tab stops in the strip with ${n} documents`,
			);
			const role = await page
				.locator(".cmp-visits")
				.getAttribute("role")
				.catch(() => null);
			check(role === "toolbar", `strip role ${role}`);
			await page.evaluate(() =>
				(document.activeElement as HTMLElement | null)?.blur(),
			);
			// Tab from Headquarters lands on exactly one document; the next Tab leaves the strip
			await tabTo(
				page,
				(f) => f.cls.includes("cmp-hq-button") && f.label === "Headquarters",
				"Headquarters button",
			);
			await page.keyboard.press("Tab");
			const inStrip = await focused(page);
			const stopId = (await page.evaluate(
				() => document.activeElement?.getAttribute("data-request-id") ?? "",
			)) as string;
			check(
				inStrip.cls.includes("cmp-visit") && order.includes(stopId),
				`Tab from Headquarters → ${inStrip.tag}.${inStrip.cls}`,
			);
			await page.keyboard.press("Tab");
			const after = await focused(page);
			check(
				!after.cls.includes("cmp-visit"),
				"the second Tab stayed in the strip",
			);
			const afterName = `${after.tag}.${after.cls.split(" ")[0] ?? ""}${after.label ? `[${after.label}]` : ""}`;
			await page.keyboard.press("Shift+Tab");
			const backId = (await page.evaluate(
				() => document.activeElement?.getAttribute("data-request-id") ?? "",
			)) as string;
			check(backId === stopId, "Shift+Tab did not return to the same document");
			// arrows / Home / End across all documents, wrapping at both ends
			const at = async () =>
				(await page.evaluate(
					() => document.activeElement?.getAttribute("data-request-id") ?? "",
				)) as string;
			const press = async (k: string) => {
				await page.keyboard.press(k);
				return at();
			};
			check((await press("Home")) === order[0], "Home ≠ first document");
			const right: string[] = [];
			for (let i = 0; i < n; i++) right.push(await press("ArrowRight"));
			check(
				right.join() === [...order.slice(1), order[0]].join(),
				"ArrowRight did not visit every document in order and wrap to the first",
			);
			check(
				(await press("ArrowLeft")) === order[n - 1],
				"ArrowLeft from the first did not wrap to the last",
			);
			check((await press("Home")) === order[0], "Home");
			check((await press("End")) === order[n - 1], "End ≠ last document");
			check(
				(await press("ArrowDown")) === order[0],
				"ArrowDown from the last did not wrap to the first",
			);
			check(
				(await press("ArrowUp")) === order[n - 1],
				"ArrowUp from the first did not wrap to the last",
			);
			const stopsMid = await stripTabStops(page);
			const rovingOk = (await page.evaluate(
				() => (document.activeElement as HTMLElement | null)?.tabIndex === 0,
			)) as boolean;
			check(
				stopsMid === 1 && rovingOk,
				`after arrows: ${stopsMid} tab stops, focused stop ${rovingOk}`,
			);
			// Enter on a document reached by arrows opens exactly that document, nothing else
			await page.keyboard.press("Home");
			const target = await press("ArrowRight");
			const t0 = Date.now();
			const c0 = s.challengePosts.length;
			await page.keyboard.press("Enter");
			await docFor(page, target).waitFor();
			const opened = await page
				.locator('section[aria-label="Approval document"]')
				.getAttribute("data-request-id");
			const hash = (await page.evaluate(() => location.hash)) as string;
			await sleep(1200);
			check(
				opened === target && hash.endsWith(`/${target}`),
				`opened ${opened}`,
			);
			check(
				traffic.decisionPosts.filter((p) => p.at >= t0).length === 0 &&
					s.challengePosts.length === c0,
				"Enter on a document sent a decision/challenge request",
			);
			check(reqRow(target)?.status === "pending", "document left pending");
			// one tab stop whatever the number of documents: add one more and re-count
			await submitNew(main.page, { title: "C13 Toolbar one more" });
			await until(
				async () => (await ids()).length === n + 1,
				"one more document in the strip",
				10_000,
			);
			const stops1 = await stripTabStops(page);
			check(stops1 === 1, `${stops1} tab stops with ${n + 1} documents`);
			return `${n} documents, role=toolbar, 1 tab stop; Headquarters → Tab → one document → Tab → ${afterName}; Shift+Tab back to it; Home/End, ArrowRight ×${n} (wraps), ArrowLeft/ArrowUp/ArrowDown wrap; Enter on the 2nd document (reached by arrows) opened exactly it, 0 decision / 0 challenge POSTs; still 1 tab stop with ${n + 1} documents`;
		} finally {
			await close(s);
			run.current = main.page;
		}
	});
}

const LONG_TOKEN =
	"src/packages/campus-presentation/really-long-unbroken-identifier";
const LONG_TITLE =
	`C12 ${LONG_TOKEN}-without-spaces and then a normal tail`.slice(0, 120);

async function layoutCases() {
	const crit1 =
		`The ${LONG_TOKEN}/module-${"x".repeat(60)}.ts keeps its public API; ${"every word here makes the criterion long enough to wrap across many lines in the narrow document column ".repeat(3)}`
			.slice(0, 480)
			.trim();
	const longPath =
		`src/${"deeply-nested-directory/".repeat(7)}leaf-file-name.ts`.slice(
			0,
			190,
		);
	let lid = "";
	await run.case("CMP-LAYOUT-setup", async () => {
		run.current = main.page;
		lid = await submitNew(main.page, {
			title: LONG_TITLE,
			criteria: `${crit1}\nShort second criterion`,
			allowed: `.\n${longPath}`,
		});
		T.long = lid;
		return `long title ${LONG_TITLE.length} chars, criterion ${crit1.length} chars, path ${longPath.length} chars`;
	});
	for (const [w, h] of [
		[1440, 900],
		[1280, 800],
	] as const) {
		const vp = `${w}x${h}`;
		let titles: { id: string; title: string; visibleChars: number }[] = [];
		run.viewport = vp;
		await run.case(`CMP-LAYOUT-${vp}`, async () => {
			check(lid, "long task missing");
			const s = await open({ w, h });
			run.current = s.page;
			const page = s.page;
			try {
				await page.locator(".cmp").waitFor();
				await sceneSettled(page);
				const o1 = await overflowIn(page, ".cmp");
				check(
					!o1.pageOverflowX,
					`Projects page overflow ${o1.scrollWidth}>${o1.clientWidth}`,
				);
				await page
					.locator(`.cmp-building[data-repo-id="${env.repoId}"]`)
					.click();
				await region(page, "Tasks")
					.getByRole("button", { name: "Assign work" })
					.waitFor();
				await sleep(800);
				await run.shot(page, "selected-building");
				const r = await waitPendingReq(lid, "run");
				const vb = visitButton(page, r.id);
				await until(
					async () => (await vb.count()) === 1,
					"long document listed",
					6000,
				);
				const name = await vb.getAttribute("aria-label");
				const tip = await vb.getAttribute("title");
				check(
					name === `Execution approval · ${LONG_TITLE}` && tip === name,
					"document button does not carry the full title",
				);
				await vb.scrollIntoViewIfNeeded();
				titles = await visitTitleVisibility(page);
				const ellipsized =
					(titles.find((t) => t.id === r.id)?.visibleChars ?? 0) <
					LONG_TITLE.length;
				await vb.click();
				await docFor(page, r.id).waitFor();
				await sleep(500);
				const sel = 'section[aria-label="Approval document"]';
				const o2 = await overflowIn(page, sel);
				check(
					!o2.pageOverflowX,
					`HQ page overflow ${o2.scrollWidth}>${o2.clientWidth}`,
				);
				check(
					o2.clipped.length === 0,
					`clipped/escaping: ${o2.clipped.join(" | ")}`,
				);
				const head = page.locator(`${sel} h2`);
				const headOk = (await head.evaluate(
					(el) => el.scrollWidth <= el.clientWidth + 1,
				)) as boolean;
				check(headOk, "document heading overflows");
				check(
					(await textOf(head)).includes(LONG_TITLE),
					"heading lacks the full title",
				);
				const ids = (
					(await page
						.locator(`${sel} .wsm1-ids`)
						.evaluateAll((els) =>
							els.map((el) => (el as HTMLElement).innerText),
						)) as string[]
				).join("\n");
				check(ids.includes(r.binding_hash), "binding hash not shown in full");
				const doc = await textOf(region(page, "Approval document"));
				check(doc.includes(longPath), "long allowed path not shown in full");
				check(
					doc.includes(crit1.trim().slice(0, 200)),
					"long criterion not shown",
				);
				const sigVisible = await inViewport(
					page,
					`${sel} .wsm1-signature input`,
				);
				const grantVisible = await inViewport(page, `${sel} .wsm1-primary`);
				const identity = await inViewport(page, `${sel} .wsm1-identity`);
				check(
					sigVisible && grantVisible,
					"signature/Approve not in the viewport",
				);
				check(identity, "task identity not in the viewport");
				const idText = await textOf(page.locator(`${sel} .wsm1-identity`));
				check(
					idText.includes(env.repoId) && /Proposal v1/.test(idText),
					`identity "${idText.slice(0, 80)}"`,
				);
				await run.shot(page, "hq-long-document");
				await openTask(page, lid);
				await sleep(500);
				const o3 = await overflowIn(page, 'section[aria-label="Task detail"]');
				check(!o3.pageOverflowX, "task page overflow");
				check(
					o3.clipped.length === 0,
					`task clipped/escaping: ${o3.clipped.join(" | ")}`,
				);
				await run.shot(page, "task-long-detail");
				return `no page overflow (Projects/HQ/task); document: heading wraps the full title, full binding hash + 190-char path + 480-char criterion shown, nothing clipped; signature/Approve and identity in the viewport; campus button carries the full title in its name/tooltip (visible text ellipsized: ${ellipsized})`;
			} finally {
				await close(s);
				run.current = main.page;
			}
		});
		// readability of the campus document strip (stage mode): how much of each title is visible
		if (run.wants(`CMP-LAYOUT-${vp}-campus-titles`) && titles.length > 0) {
			const hidden = titles.filter((t) => t.visibleChars < 3);
			run.record(
				`CMP-LAYOUT-${vp}-campus-titles`,
				hidden.length === 0 ? "PASS" : "FAIL",
				`${titles.length} document buttons (scene ${facts.scene}); visible title characters: ${titles.map((t) => `${t.visibleChars}/${t.title.length}`).join(", ")} — ${hidden.length} show no readable part of their title (full title only in the tooltip / accessible name)`,
			);
		}
		run.viewport = "1440x900";
	}
}

async function bothGatesViaCampus(s: Session, title: string): Promise<string> {
	const page = s.page;
	const id = await submitNew(page, { title });
	const r1 = await approveViaCampus(page, id);
	const r2 = await acceptViaCampus(page, id);
	check(decisionsFor(r1) === 1 && decisionsFor(r2) === 1, "decisions");
	return id;
}

async function j10(noGl: Browser | null) {
	await run.case("CMP-J10a-reduced-motion", async () => {
		const s = await open({ reducedMotion: "reduce" });
		run.current = s.page;
		run.flags = "reducedMotion=reduce";
		const page = s.page;
		try {
			const rm = (await page.evaluate(
				() => matchMedia("(prefers-reduced-motion: reduce)").matches,
			)) as boolean;
			check(rm, "reduced motion not emulated");
			await navLink(page, /^Head/).click();
			await page.locator(".cmp").waitFor();
			const st = await sceneSettled(page);
			const id = await submitNew(page, { title: "C10a Reduced motion gates" });
			const r = await waitPendingReq(id, "run");
			await navLink(page, /^Head/).click();
			await until(
				async () => (await visitButton(page, r.id).count()) === 1,
				"listed",
				6000,
			);
			await sleep(800);
			const p = await campusProbe(page);
			check(p.reduced === "true", `data-reduced-motion ${p.reduced}`);
			if (st === "live")
				check(
					p.walking === "0" && Number(p.visitors) >= 1,
					`walking ${p.walking} with ${p.visitors} visitors (reduced motion)`,
				);
			const cap = await textOf(page.locator(".cmp-caption"));
			const anims = (await page.evaluate(
				() =>
					document.getAnimations().filter((a) => a.playState === "running")
						.length,
			)) as number;
			await openViaCampus(page, r.id);
			await typeSignature(page, "run");
			await grantButton(page, "run").click();
			await until(
				async () => /Execution approved/.test(await decisionStatus(page)),
				"approved",
			);
			const r2 = await acceptViaCampus(page, id);
			check(decisionsFor(r.id) === 1 && decisionsFor(r2) === 1, "decisions");
			return `scene ${st}; data-reduced-motion=true; walking ${p.walking} with ${p.visitors} visitor(s) (arrived at once); caption "${cap}"; running CSS animations ${anims}; both gates via campus document buttons`;
		} finally {
			run.flags = "";
			await close(s);
			run.current = main.page;
		}
	});

	await run.case("CMP-J10b-no-webgl", async () => {
		check(noGl, "NOT-RUN: WebGL-disabled browser did not launch");
		const s = await open({ b: noGl });
		run.current = s.page;
		run.flags = "webgl=disabled";
		const page = s.page;
		const sceneRequests: string[] = [];
		page.on("request", (r) => {
			if (/CampusScene|engine\.ts|world\.ts|\/three/.test(r.url()))
				sceneRequests.push(new URL(r.url()).pathname);
		});
		try {
			const gl = (await page.evaluate(() => ({
				webgl: document.createElement("canvas").getContext("webgl") === null,
				webgl2: document.createElement("canvas").getContext("webgl2") === null,
				experimental:
					document.createElement("canvas").getContext("experimental-webgl") ===
					null,
			}))) as { webgl: boolean; webgl2: boolean; experimental: boolean };
			check(
				gl.webgl && gl.webgl2 && gl.experimental,
				`WebGL available ${JSON.stringify(gl)}`,
			);
			await page.locator(".cmp").waitFor();
			const st = await sceneSettled(page);
			const p = await campusProbe(page);
			check(
				st === "unavailable" && p.mode === "static" && p.note === "no_webgl",
				`scene ${st}/${p.mode}/${p.note}`,
			);
			check(p.canvases === 0, `${p.canvases} canvases`);
			const id = await bothGatesViaCampus(s, "C10b No WebGL gates");
			await run.shot(page, "no-webgl-accepted");
			check(
				sceneRequests.length === 0,
				`scene code fetched: ${sceneRequests.join(",")}`,
			);
			return `getContext(webgl/webgl2/experimental-webgl) === null in page; campus static/unavailable with the no_webgl note, 0 canvases, scene chunk never fetched; task ${id.slice(-8)} approved + accepted through the campus document buttons`;
		} finally {
			run.flags = "";
			await close(s);
			run.current = main.page;
		}
	});
}

// ── separate disposable environments ────────────────────────────────────────

async function withEnv(
	label: string,
	opts: Parameters<typeof startWorkspaceEnv>[0],
	fn: (s: Session) => Promise<void>,
) {
	const e = await startWorkspaceEnv(opts);
	run.secrets.add(e.credential);
	check(!e.uiUrl.endsWith(":4317") && !e.hubUrl.endsWith(":4317"), "4317");
	const saved = env;
	env = e;
	let s: Session | null = null;
	try {
		s = await open();
		await fn(s);
	} finally {
		if (s) await close(s);
		env = saved;
		await e.stop().catch(() => undefined);
		facts[`${label}Stopped`] = String(!existsSync(e.fx.dir));
	}
}

async function j6Expiry() {
	if (!run.wants("CMP-J06a-expired")) return;
	await withEnv("ttl", { auth: { challenge_ttl_ms: 3000 } }, async (s) => {
		await run.case("CMP-J06a-expired", async () => {
			run.current = s.page;
			const page = s.page;
			const id = await submitNew(page, { title: "C06a Challenge expiry" });
			const r = await waitPendingReq(id, "run");
			await openViaCampus(page, r.id);
			await typeSignature(page, "run");
			const ch = challenges.get(r.id);
			check(ch, "challenge not captured");
			await until(
				async () => (await sigField(page, "run").inputValue()) === "",
				"signature cleared at expiry",
				9000,
			);
			const notice = await textOf(
				region(page, "Approval document").locator(".wsm1-notice"),
			);
			check(/expired/i.test(notice), `notice "${notice}"`);
			check(
				!(await grantButton(page, "run").isEnabled()),
				"Approve enabled after expiry",
			);
			const late = await pagePost(
				page,
				`/api/workspace/approval-requests/${r.id}/decisions`,
				{
					idempotency_key: `cmp-expired-${Date.now().toString(36)}`,
					kind: "run",
					action: "approve",
					expected_request_rev: ch.request_rev,
					binding_hash: ch.binding_hash,
					confirmation_text: "Edward",
					reason: null,
					challenge: ch.challenge,
				},
			);
			check(
				late.status >= 400 && late.status < 500,
				`expired challenge POST → ${late.status}`,
			);
			check(decisionsFor(r.id) === 0, "decided with an expired challenge");
			check(managedRow(r.managed_task_id)?.run_requested_at === null, "queued");
			await typeSignature(page, "run");
			await grantButton(page, "run").click();
			await until(
				async () => /Execution approved/.test(await decisionStatus(page)),
				"approved with a fresh challenge",
			);
			check(decisionsFor(r.id) === 1, "decisions ≠ 1");
			return `TTL 3 s: field cleared, notice "${notice.slice(0, 70)}", Approve disabled; direct POST with the expired challenge → ${late.status} ${late.error}; 0 decisions, not queued; fresh Edward → approved (1 decision)`;
		});
	});
}

async function j7Bundle() {
	if (
		![
			"CMP-J07b-bundle-corrupt",
			"CMP-J07c-stale-never-green",
			"CMP-J07d-unknown-not-green",
		].some((id) => run.wants(id))
	)
		return;
	await withEnv(
		"bundle",
		{ auth: { max_sessions_per_principal: 8 } },
		async (s) => {
			const page = s.page;
			run.current = page;
			const k = await bothGatesViaCampus(s, "C07 Bundle then corrupted");
			const u = await bothGatesViaCampus(s, "C07 Repo unavailable later");
			await run.case("CMP-J07c-stale-never-green", async () => {
				run.current = page;
				await openTask(page, k);
				await until(
					async () => {
						const v = await validityView(page, "Task detail");
						return v?.status === "valid" && v.freshness === "fresh";
					},
					"fresh valid",
					20_000,
				);
				const fresh = await validityView(page, "Task detail");
				check(fresh, "no validity");
				await page.route("**/api/workspace/**", (route) =>
					route.request().method() === "GET" ? route.abort() : route.continue(),
				);
				try {
					await until(
						async () =>
							(await validityView(page, "Task detail"))?.freshness === "stale",
						"stale reading",
						25_000,
						250,
					);
					const st = await validityView(page, "Task detail");
					check(st, "no validity");
					check(st.status === "valid", `hub status rewritten: ${st.status}`);
					check(!st.cls.includes("tone-ok"), "stale valid still green");
					check(
						!/Current evidence verified/.test(st.text),
						"stale reads 'verified'",
					);
					check(/may be out of date/.test(st.line), `line "${st.line}"`);
					check(st.bg !== fresh.bg, "stale background equals the green one");
					const ev = await textOf(page.getByTestId("evidence-status"));
					await validityOf(page, "Task detail").scrollIntoViewIfNeeded();
					await run.shot(page, "stale-validity-not-green", { checks: true });
					facts.stale = `fresh ${fresh.cls.includes("tone-ok") ? "green" : "?"} (${fresh.bg}) → stale neutral (${st.bg}); "${st.line.slice(0, 90)}"; evidence-status "${ev}"`;
				} finally {
					await page.unrouteAll({ behavior: "ignoreErrors" });
				}
				await until(
					async () =>
						(await validityView(page, "Task detail"))?.freshness === "fresh",
					"fresh again after reconnect",
					20_000,
				);
				return `${facts.stale}; fresh again after reconnect`;
			});

			await run.case("CMP-J07b-bundle-corrupt", async () => {
				run.current = page;
				const val = db1<{
					evidence_bundle_digest: string;
					decision_id: string;
				}>(
					"SELECT evidence_bundle_digest, decision_id FROM managed_acceptance_validity WHERE workspace_task_id = ?",
					k,
				);
				check(val, "no validity row");
				const bundle = join(
					env.fx.config.artifacts_root,
					"_sealed",
					`${val.evidence_bundle_digest}.bundle`,
				);
				check(existsSync(bundle), "bundle file not found");
				const rq = db1<{ id: string }>(
					"SELECT id FROM managed_approval_requests WHERE workspace_task_id = ? AND kind = 'result' AND status = 'accepted'",
					k,
				);
				check(rq, "no accepted result request");
				const before = decisionRow(rq.id);
				const size = readFileSync(bundle).length;
				flipByte(bundle, Math.floor(size / 2));
				await page.reload();
				await page.getByText(/^Signed in as operator:edward/).waitFor();
				await openTask(page, k);
				await until(
					async () =>
						(await validityView(page, "Task detail"))?.status === "invalid",
					"invalid after bundle corruption",
					30_000,
				);
				const v = await validityView(page, "Task detail");
				check(v, "no validity");
				check(/^bundle_/.test(v.reason ?? ""), `reason ${v.reason}`);
				check(
					v.role === "alert" && !v.cls.includes("tone-ok"),
					"not a non-green alert",
				);
				check(/^Last check \d+ s ago/.test(v.line), `freshness "${v.line}"`);
				check(
					(await attr(page, "acceptance-status", "data-status")) === "accepted",
					"historical acceptance changed",
				);
				const integ = await page
					.locator(`.cmp-building[data-repo-id="${env.repoId}"]`)
					.getAttribute("data-integrity");
				check(integ === "invalid", `campus integrity ${integ}`);
				const ev = region(page, "Task detail").getByRole("region", {
					name: "Evidence",
				});
				const evBtn = ev.locator("li button").first();
				let viewer = "not opened";
				if ((await evBtn.count()) > 0) {
					await evBtn.click();
					const d = page.getByRole("dialog");
					await d.waitFor();
					await until(
						async () => (await d.getAttribute("data-state")) !== "loading",
						"viewer",
					);
					viewer = `${await d.getAttribute("data-state")}/${await d.getAttribute("data-history")}`;
					await page.keyboard.press("Escape");
					await d.waitFor({ state: "detached" });
				}
				await validityOf(page, "Task detail").scrollIntoViewIfNeeded();
				await run.shot(page, "bundle-corrupt-task");
				await page.evaluate(
					({ t, q }) => {
						location.hash = `#/hq/${t}/${q}`;
					},
					{ t: k, q: rq.id },
				);
				await docFor(page, rq.id).waitFor();
				await until(
					async () =>
						(await validityView(page, "Approval document"))?.status ===
						"invalid",
					"HQ invalid",
				);
				const hs = await region(page, "Decision history")
					.getByTestId("history-acceptance-validity")
					.first()
					.getAttribute("data-status");
				check(hs === "invalid", `history ${hs}`);
				const after = decisionRow(rq.id);
				check(
					after?.id === before?.id &&
						after?.decided_at === before?.decided_at &&
						after?.response_body === before?.response_body,
					"historical decision/receipt changed",
				);
				await run.shot(page, "bundle-corrupt-hq");
				return `invalid/${v.reason}, role=alert, not green, "${v.line}"; acceptance-status accepted; campus integrity=invalid; viewer ${viewer}; HQ document + history invalid; decision/receipt byte-identical`;
			});

			await run.case("CMP-J07d-unknown-not-green", async () => {
				run.current = page;
				const repo = env.fx.repoPath;
				const away = `${repo}.away`;
				let seen: Awaited<ReturnType<typeof validityView>> = null;
				await openTask(page, u);
				renameSync(repo, away);
				try {
					await until(
						async () => {
							seen = await validityView(page, "Task detail");
							return seen !== null && seen.status !== "valid";
						},
						"a reading other than valid while the repository is unavailable",
						30_000,
						300,
					);
				} finally {
					renameSync(away, repo);
				}
				const v = seen as Awaited<ReturnType<typeof validityView>>;
				check(v, "no validity");
				check(!v.cls.includes("tone-ok"), `${v.status} shown green`);
				check(!/Current evidence verified/.test(v.text), "reads verified");
				check(
					v.status === "unknown",
					`repository unavailable → ${v.status}/${v.reason} (contract §C: unknown / verification_unavailable)`,
				);
				await until(
					async () =>
						(await validityView(page, "Task detail"))?.status === "valid",
					"valid again after the repository returns (unknown is not sticky)",
					30_000,
				);
				return `repository moved away → ${v.status}/${v.reason}, not green ("${v.text.slice(0, 70)}"); restored → valid again`;
			});
		},
	);
}

// ── main ────────────────────────────────────────────────────────────────────

async function mainFlow(): Promise<number> {
	const user = userInfo().username;
	check(
		![`/Users/${user}`, `/home/${user}`].includes(
			homedir().replace(/\/+$/, ""),
		),
		"not in the isolated runner (HOME)",
	);
	browser = await chromium.launch({ headless: true, args: GL_ARGS });
	const version = browser.version();
	env = await startWorkspaceEnv({
		auth: { max_sessions_per_principal: 16 },
		fixture: {
			verification: [{ name: "fixture-check", argv: VERIFY, timeout_s: 60 }],
			limits: { lease_ttl_ms: 3000 },
		},
	});
	run.secrets.add(env.credential);
	check(!env.uiUrl.endsWith(":4317") && !env.hubUrl.endsWith(":4317"), "4317");
	console.log(
		`[CAMPUS] chromium ${version}; ui ${env.uiUrl}; hub port ≠ 4317; evidence ${run.outDir}`,
	);
	const t0 = Date.now();
	let noGl: Browser | null = null;
	try {
		main = await open();
		await sceneCase();
		await j1();
		await j2();
		await j3();
		await j4();
		await j5();
		await j7Source();
		await j6Obsolete();
		await j9();
		await mountCycles();
		await j8();
		await keyboardCase();
		await toolbarCase();
		await layoutCases();
		noGl = await chromium
			.launch({ headless: true, args: NOGL_ARGS })
			.catch(() => null);
		await j10(noGl);
		await j6Expiry();
		await j7Bundle();
	} finally {
		for (const s of sessions) await s.context.close().catch(() => undefined);
		await noGl?.close().catch(() => undefined);
	}
	const live =
		db1<{ n: number }>(
			"SELECT count(*) AS n FROM managed_runs WHERE provider <> 'fake' OR mode <> 'simulated'",
		)?.n ?? -1;
	const total =
		db1<{ n: number }>("SELECT count(*) AS n FROM managed_runs")?.n ?? -1;
	run.record(
		"CMP-LAYOUT-documents",
		docLayout.issues.size === 0 ? "PASS" : "FAIL",
		`${docLayout.checked} approval-document views checked for clipped / escaping text; issues: ${[...docLayout.issues].slice(0, 6).join(" | ") || "none"}`,
	);
	run.record(
		"CMP-G-simulated",
		live === 0 ? "PASS" : "FAIL",
		`${total} attempts in the main env, all provider=fake/mode=simulated (${live} other)`,
	);
	run.record(
		"CMP-G-requests",
		run.blockedOrigins.length === 0 ? "PASS" : "FAIL",
		`${run.blockedOrigins.length} request(s) outside the UI origin aborted ${[...new Set(run.blockedOrigins)].join(", ")}`,
	);
	run.record(
		"CMP-G-console",
		run.consoleErrors.length === 0 && run.dialogs.length === 0
			? "PASS"
			: "FAIL",
		`${run.consoleErrors.length} unexpected console error(s): ${run.consoleErrors.slice(0, 4).join(" | ")}; dialogs ${run.dialogs.length}`,
	);
	const file = run.writeSummary({
		browser: `Chromium headless shell ${version}`,
		facts,
		durationS: Math.round((Date.now() - t0) / 1000),
	});
	console.log(`[CAMPUS] facts ${JSON.stringify(facts)}`);
	console.log(`[CAMPUS] summary ${file}`);
	return run.results.some((r) => r.status === "FAIL") ? 1 : 0;
}

let code = 1;
try {
	code = await mainFlow();
} catch (err) {
	run.record("setup", "FAIL", String((err as Error).message ?? err));
	run.writeSummary({ fatal: true });
} finally {
	await browser?.close().catch(() => undefined);
	const dir = env?.fx.dir;
	await env?.stop().catch(() => undefined);
	if (dir) console.log(`[CAMPUS] main env removed: ${!existsSync(dir)}`);
}
const by = (st: string) => run.results.filter((r) => r.status === st).length;
console.log(
	`[CAMPUS] PASS ${by("PASS")} · FAIL ${by("FAIL")} · NOT RUN ${by("NOT RUN")} · evidence ${run.outDir}`,
);
process.exit(code);
