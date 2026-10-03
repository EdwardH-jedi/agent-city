// QA (multi-repository milestone) — MULTI evidence set: two allowlisted fixture repositories, an empty
// allowlisted repository and an observed-only repository in ONE isolated real-hub environment, driven
// through the workspace UI. Also the home of BRW-R-01 (repository A→B) and BRW-J-21 (CEO briefing),
// which moved here from hub.suite.ts (they are counted only here).
//
//   bun scripts/ci/isolated.ts --root <dir> --label <unique> --timeout <s> \
//     --browsers <playwright browsers dir> [--set M1_ONLY=<regex of record ids>] \
//     -- bun --no-env-file apps/web/e2e/workspace-m1/multirepo.suite.ts
//
// Isolation = hub.suite.ts: the lead harness runs the real hub in THIS process (workspace mode, free
// 127.0.0.1 port, never 4317) over a temp SQLite file and disposable fixture repositories, simulated only
// (fake providers), with per-run synthetic credentials; Vite runs with configFile:false and an empty envDir,
// proxying only to this hub; every browser request outside the UI origin is aborted and counted. Tampering
// touches only files under env.fx. A test-only engine hook (`managedHooks`, EngineGate) holds a claimed
// execution before review so cross-repository serialization is observed deterministically, never timed.
// Contract: the FROZEN interface + FROZEN DOM hooks in docs/workspace-m1/MULTIREPO_MILESTONE.md.

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
	campusProbe,
	GL_ARGS,
	GL_COUNTER_SCRIPT,
	NOGL_ARGS,
} from "./campus-kit.ts";
import {
	attr,
	check,
	type DraftInput,
	dbAll,
	dbOne,
	decisionStatus,
	fillDraft,
	type Gate,
	grantButton,
	navLink,
	newCtx,
	openRequest,
	Run,
	region,
	SIG_LABEL,
	sigField,
	signIn,
	sleep,
	type Traffic,
	taskIdFromUrl,
	textOf,
	typeSignature,
	until,
	waitEngine,
	waitStage,
} from "./kit.ts";
import {
	briefing,
	briefingInfo,
	documentRepo,
	EngineGate,
	expandBriefing,
	flipByte,
	focusInfo,
	gitHasCommit,
	gotoProjects,
	hashOf,
	inboxButton,
	inboxItems,
	LeaseSampler,
	listedTasks,
	MULTI_SET,
	MutationLog,
	mainButtons,
	pageOverflowX,
	pickRepo,
	queueStatus,
	recordDecisionStatus,
	repoLabelIssues,
	repoRow,
	repoRows,
	runningAnimations,
	runningAnimationsIn,
	statusTrail,
	tabUntil,
	taskRepo,
	waitBriefing,
} from "./multirepo-kit.ts";

// the only environment read of this suite (docs-parity: *.suite.ts are exempt; the kit takes parameters)
const ONLY = process.env.M1_ONLY ? new RegExp(process.env.M1_ONLY) : null;
const run = new Run(MULTI_SET, ONLY);
const gate = new EngineGate();

interface Session {
	context: BrowserContext;
	page: Page;
	traffic: Traffic;
	muts: MutationLog;
}

let env!: WorkspaceEnv;
let browser!: Browser;
let noGl: Browser | null = null;
const sessions: Session[] = [];
const challenges = new Map<string, string>(); // request id → challenge (kept in memory, never printed)

/** Repository ids: A = primary fixture, B = beta, E = empty (allowlisted), O = observed-only. */
let A = "";
let B = "";
let E = "";
let O = "";

/** Task ids / titles of the main scenario (filled as records pass). */
const T: Record<string, string> = {};
const EXEC_RE =
	/^(Approve execution|Accept result|Cancel execution|Request a new run|Submit for run approval)$/;

// ── sessions ────────────────────────────────────────────────────────────────

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
	const muts = new MutationLog();
	muts.attach(base.page);
	base.page.on("response", async (r) => {
		const m = /\/approval-requests\/(wsa-[0-9a-f-]{36})\/challenge$/.exec(
			new URL(r.url()).pathname,
		);
		if (!m || r.status() !== 201) return;
		try {
			const j = (await r.json()) as { challenge: string };
			run.secrets.add(j.challenge);
			challenges.set(m[1] ?? "", j.challenge);
		} catch {
			// page closed
		}
	});
	await base.page.goto(`${env.uiUrl}/#/projects`);
	const s: Session = { ...base, muts };
	if (o.signIn !== false) await signInSession(s);
	sessions.push(s);
	return s;
}

async function signInSession(s: Session): Promise<void> {
	await signIn(s.page, env.credential);
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

let mainSession: Session | null = null;

async function close(s: Session): Promise<void> {
	if (run.current === s.page && mainSession) run.current = mainSession.page;
	try {
		const out = s.page.getByRole("button", { name: "Sign out" });
		if ((await out.count()) > 0) await out.click();
		await sleep(150);
	} catch {
		// gone
	}
	await s.context.close().catch(() => undefined);
}

// ── read-only DB ────────────────────────────────────────────────────────────

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
	invalidation_reason: string | null;
	managed_task_id: string;
	binding_hash: string;
	result_envelope: string | null;
}
const reqsOf = (taskId: string) =>
	db<ReqRow>(
		"SELECT id, kind, status, invalidation_reason, managed_task_id, binding_hash, result_envelope FROM managed_approval_requests WHERE workspace_task_id = ? ORDER BY created_at, rowid",
		taskId,
	);
const lastReq = (taskId: string, kind: "run" | "result") =>
	reqsOf(taskId)
		.filter((r) => r.kind === kind)
		.at(-1) ?? null;
const taskRow = (id: string) =>
	db1<{
		repo_id: string;
		stage: string;
		current_managed_task_id: string | null;
		accepted_decision_id: string | null;
	}>(
		"SELECT repo_id, stage, current_managed_task_id, accepted_decision_id FROM workspace_tasks WHERE id = ?",
		id,
	);
const managed = (id: string) =>
	db1<{
		repo_id: string;
		state: string;
		lease_owner: string | null;
		run_requested_at: string | null;
		fence_token: number;
	}>(
		"SELECT repo_id, state, lease_owner, run_requested_at, fence_token FROM managed_tasks WHERE id = ?",
		id,
	);
const runsOf = (mt: string) =>
	db<{ id: string; candidate_sha: string | null; attempt_no: number }>(
		"SELECT id, candidate_sha, attempt_no FROM managed_runs WHERE task_id = ? ORDER BY attempt_no",
		mt,
	);
const decisionsFor = (requestId: string) =>
	db1<{ n: number }>(
		"SELECT count(*) AS n FROM managed_decisions WHERE approval_request_id = ?",
		requestId,
	)?.n ?? -1;
const artifactsOf = (mt: string) =>
	db<{ id: string; name: string; rel_path: string; run_id: string }>(
		"SELECT id, name, rel_path, run_id FROM managed_artifacts WHERE task_id = ? ORDER BY created_at",
		mt,
	);
const leasedNow = () =>
	db1<{ n: number }>(
		"SELECT count(*) AS n FROM managed_tasks WHERE lease_owner IS NOT NULL",
	)?.n ?? -1;
const mtOf = (taskId: string) => taskRow(taskId)?.current_managed_task_id ?? "";

/** Every listed task of the current Tasks region belongs to `repoId` (DB truth). */
function tasksOutside(ids: string[], repoId: string): string[] {
	return ids.filter((id) => taskRow(id)?.repo_id !== repoId);
}

// ── UI flows (frozen hooks first, role-09 contract second) ──────────────────

async function composeIn(page: Page, repoId: string, d: DraftInput) {
	await pickRepo(page, repoId);
	await region(page, "Tasks")
		.getByRole("button", { name: "Assign work" })
		.click();
	await region(page, "Task detail")
		.getByLabel("Title", { exact: true })
		.waitFor();
	await fillDraft(page, d);
}

async function saveIn(
	page: Page,
	repoId: string,
	d: DraftInput,
): Promise<string> {
	const before = await taskIdFromUrl(page);
	await composeIn(page, repoId, d);
	await region(page, "Task detail")
		.getByRole("button", { name: "Save draft" })
		.click();
	let id = "";
	await until(async () => {
		id = await taskIdFromUrl(page);
		return id.startsWith("wst-") && id !== before;
	}, `saved task id for ${d.title}`);
	return id;
}

async function submitIn(
	page: Page,
	repoId: string,
	d: DraftInput,
): Promise<string> {
	await composeIn(page, repoId, d);
	await region(page, "Task detail")
		.getByRole("button", { name: "Submit for run approval" })
		.click();
	await waitStage(page, "Awaiting execution approval", 15_000);
	const id = await taskIdFromUrl(page);
	check(id.startsWith("wst-"), "task id not in the URL after submit");
	check(taskRow(id)?.repo_id === repoId, `task ${id} not in ${repoId}`);
	return id;
}

async function openTaskIn(page: Page, repoId: string, taskId: string) {
	await pickRepo(page, repoId);
	await region(page, "Tasks").locator(`[data-task-id="${taskId}"]`).click();
	await page
		.locator(`section[aria-label="Task detail"][data-task-id="${taskId}"]`)
		.waitFor();
}

/** HQ → request → assert an EMPTY field on arrival → type Edward → grant. Returns the request id. */
async function grantIn(page: Page, kind: Gate, title: string): Promise<string> {
	const req = await openRequest(page, kind, title);
	const arrived = await sigField(page, kind).inputValue();
	check(arrived === "", `${SIG_LABEL[kind]} not empty on arrival`);
	await typeSignature(page, kind);
	await grantButton(page, kind).click();
	if (kind === "run")
		await until(
			async () => /Execution approved/.test(await decisionStatus(page)),
			`execution approved (${title})`,
		);
	else
		await until(
			() =>
				(db1<{ n: number }>(
					"SELECT count(*) AS n FROM managed_decisions WHERE approval_request_id = ? AND action = 'accept'",
					req,
				)?.n ?? 0) === 1,
			`result accepted (${title})`,
			20_000,
		);
	return req;
}

async function toHumanReady(page: Page, repoId: string, taskId: string) {
	await openTaskIn(page, repoId, taskId);
	await waitEngine(page, ["human_ready", "failed", "blocked"], 90_000);
	await waitStage(page, "Awaiting acceptance", 30_000);
}

const passed = (id: string) =>
	run.results.find((r) => r.id === id)?.status === "PASS";
function need(...ids: string[]) {
	const missing = ids.filter((id) => !passed(id));
	if (missing.length)
		throw new Error(
			`NOT-RUN: prerequisite ${missing.join(", ")} did not pass in this run`,
		);
}

/** Abort-free delay of matching requests (the response arrives late, unchanged). */
/** Requests actually held by `delayed` (a race case must prove its delay was exercised). */
const delayHits = { n: 0, detail: 0 };
const delayed = (ms: number, times = 1, detail = false) => {
	let left = times;
	return async (route: Route) => {
		if (left > 0) {
			left -= 1;
			delayHits.n += 1;
			if (detail) delayHits.detail += 1;
			await sleep(ms);
		}
		await route.continue().catch(() => undefined);
	};
};

// ── main scenario (records MR-01 … MR-09) ───────────────────────────────────

async function scenario(main: Session): Promise<void> {
	const { page, traffic } = main;
	const titleA = "MR A first task";
	const titleB = "MR B first task";

	await run.case("MR-01", async () => {
		const rows = await repoRows(page);
		const kinds = Object.fromEntries(rows.map((r) => [r.id, r.kind]));
		check(
			kinds[A] === "allowlisted" &&
				kinds[B] === "allowlisted" &&
				kinds[E] === "allowlisted" &&
				kinds[O] === "observed",
			`repository rows/kinds ${JSON.stringify(kinds)}`,
		);
		const ta = await saveIn(page, A, { title: titleA });
		const tb = await saveIn(page, B, { title: titleB });
		T.a = ta;
		T.b = tb;
		check(taskRow(ta)?.repo_id === A, "A's task not in A");
		check(taskRow(tb)?.repo_id === B, "B's task not in B");
		// isolated lists
		await pickRepo(page, A);
		const listA = await listedTasks(page);
		await pickRepo(page, B);
		const listB = await listedTasks(page);
		check(
			listA.includes(ta) && !listA.includes(tb),
			`A's list ${listA.join(",")}`,
		);
		check(
			listB.includes(tb) && !listB.includes(ta),
			`B's list ${listB.join(",")}`,
		);
		check(tasksOutside(listA, A).length === 0, "A's list has foreign tasks");
		check(tasksOutside(listB, B).length === 0, "B's list has foreign tasks");
		// isolated details + drafts (task-repo hook + the draft's own title)
		await openTaskIn(page, A, ta);
		const repoShownA = await taskRepo(page);
		const draftA = await region(page, "Task detail")
			.getByLabel("Title", { exact: true })
			.inputValue()
			.catch(() => "");
		// an unsaved edit in A never shows up in B
		await region(page, "Task detail")
			.getByLabel("Title", { exact: true })
			.fill(`${titleA} (unsaved edit)`)
			.catch(() => undefined);
		await openTaskIn(page, B, tb);
		const repoShownB = await taskRepo(page);
		const draftB = await region(page, "Task detail")
			.getByLabel("Title", { exact: true })
			.inputValue()
			.catch(() => "");
		check(repoShownA === A, `task-repo for A's task = "${repoShownA}"`);
		check(repoShownB === B, `task-repo for B's task = "${repoShownB}"`);
		check(draftA === titleA, `A's draft title "${draftA}"`);
		check(draftB === titleB, `B's draft title "${draftB}" (A's edit leaked?)`);
		// histories: no request / decision of the other repository's task
		const histB = await page
			.locator('section[aria-label="Task detail"] li[data-request-id]')
			.count();
		check(histB === 0, `B's draft shows ${histB} approval record entr(y/ies)`);
		await gotoProjects(page);
		await sleep(600);
		await run.shot(page, "two-repos-side-by-side", { fullPage: true });
		return `A ${ta.slice(-8)} / B ${tb.slice(-8)}: each list holds only its own task; task-repo ${A} / ${B}; drafts isolated (unsaved A edit not in B); rows ${rows.length} (kinds ok)`;
	});

	await run.case("MR-02", async () => {
		need("MR-01");
		// submit both stored drafts (Edit/Submit from each task panel)
		for (const [repo, id, title] of [
			[A, T.a ?? "", titleA],
			[B, T.b ?? "", titleB],
		] as const) {
			await openTaskIn(page, repo, id);
			const panel = region(page, "Task detail");
			const edit = panel.getByRole("button", { name: "Edit draft" });
			if ((await edit.count()) > 0) await edit.click();
			// MR-01 left an unsaved edit in A's form: submit exactly the intended title
			await panel.getByLabel("Title", { exact: true }).fill(title);
			await panel
				.getByRole("button", { name: "Submit for run approval" })
				.click();
			await waitStage(page, "Awaiting execution approval", 15_000);
			check(
				(await textOf(page.getByTestId("proposal-version"))) === "1",
				`${repo}: proposal version ≠ 1`,
			);
			// the task's approval record lists only its own requests
			const own = new Set(reqsOf(id).map((r) => r.id));
			const listed = (await page
				.locator('section[aria-label="Task detail"] li[data-request-id]')
				.evaluateAll((els) =>
					els.map((e) => e.getAttribute("data-request-id") ?? ""),
				)) as string[];
			check(
				listed.every((r) => own.has(r)),
				`${repo}: approval record lists another task's request`,
			);
		}
		await sleep(2500); // ≥ 1 UI poll and ≈ 50 worker polls: nothing may start on its own
		const out: string[] = [];
		for (const id of [T.a ?? "", T.b ?? ""]) {
			const mt = mtOf(id);
			const m = managed(mt);
			check(m, `no reserved managed task for ${id}`);
			check(
				m.state === "draft" &&
					m.lease_owner === null &&
					m.run_requested_at === null,
				`${id}: engine ${m.state}, lease ${m.lease_owner !== null}, run requested ${m.run_requested_at !== null}`,
			);
			check(runsOf(mt).length === 0, `${id}: an attempt exists before Gate 1`);
			check(
				lastReq(id, "run")?.status === "pending",
				`${id}: Gate 1 not pending`,
			);
			out.push(`${taskRow(id)?.repo_id}: draft/no lease/0 runs`);
		}
		const q = (await page.evaluate(async () => {
			const r = await fetch("/api/workspace/snapshot", {
				credentials: "same-origin",
			});
			return ((await r.json()) as { execution_queue?: unknown })
				.execution_queue;
		})) as { active: unknown; queued: unknown[] } | undefined;
		check(
			q && q.active === null && q.queued.length === 0,
			`execution_queue ${JSON.stringify(q)}`,
		);
		return `${out.join("; ")}; snapshot execution_queue empty`;
	});

	const sampler = new LeaseSampler(env.fx.dbPath);
	await run.case("MR-03", async () => {
		need("MR-02");
		sampler.start();
		gate.arm("before_review");
		const t0 = Date.now();
		const req = await grantIn(page, "run", titleA);
		const post = traffic.decisionPosts.filter(
			(p) => p.url.includes(req) && p.at >= t0,
		);
		check(post.length === 1, `${post.length} decision POSTs for A`);
		const body = JSON.parse(post[0]?.body ?? "{}") as {
			binding_hash?: string;
			confirmation_text?: string;
		};
		const row = lastReq(T.a ?? "", "run");
		check(body.binding_hash === row?.binding_hash, "POST bound elsewhere");
		check(decisionsFor(req) === 1, "decisions ≠ 1");
		const mt = mtOf(T.a ?? "");
		await until(
			() => gate.holding("before_review", mt),
			"A's execution claimed",
			30_000,
		);
		const m = managed(mt);
		check(m?.lease_owner !== null && m?.repo_id === A, "A not leased in A");
		T.aReq = req;
		return `field empty on arrival; 1 POST bound to A's request; 1 decision; A claimed (leased, held before review by the test hook)`;
	});

	await run.case("MR-04", async () => {
		need("MR-03");
		const req = await grantIn(page, "run", titleB);
		T.bReq = req;
		const chA = challenges.get(T.aReq ?? "");
		const chB = challenges.get(req);
		check(chA && chB && chA !== chB, "B reused A's challenge");
		const mtA = mtOf(T.a ?? "");
		const mtB = mtOf(T.b ?? "");
		await sleep(1500); // the worker polls ~30× meanwhile: B must not be claimed
		const mb = managed(mtB);
		check(
			mb?.state === "queued" && mb.lease_owner === null,
			`B ${mb?.state}/${mb?.lease_owner !== null ? "leased" : "free"}`,
		);
		check(leasedNow() === 1, `${leasedNow()} leased`);
		await openTaskIn(page, B, T.b ?? "");
		let qs = "";
		await until(
			async () => {
				qs = await queueStatus(page);
				return qs !== "";
			},
			"B's queue-status",
			8000,
		);
		const aShort = A.split("/").pop() ?? A;
		check(
			/wait/i.test(qs) && (qs.includes(A) || qs.includes(aShort)),
			`B's queue-status "${qs}" does not say it waits behind ${A}`,
		);
		await run.shot(page, "queue-status-waiting-behind-other-repo");
		await openTaskIn(page, A, T.a ?? "");
		const qa = await queueStatus(page);
		const brA = await waitBriefing(page, A, ["active"]);
		await run.shot(page, "briefing-active");
		const snap = (await page.evaluate(async () => {
			const r = await fetch("/api/workspace/snapshot", {
				credentials: "same-origin",
			});
			return ((await r.json()) as { execution_queue?: unknown })
				.execution_queue;
		})) as {
			active: { managed_task_id: string } | null;
			queued: { managed_task_id: string }[];
		};
		check(snap.active?.managed_task_id === mtA, "snapshot active ≠ A");
		check(
			snap.queued.map((q) => q.managed_task_id).includes(mtB),
			"snapshot queue lacks B",
		);
		return `B queue-status "${qs}"; A queue-status "${qa}"; briefing(A)=${brA.state}; DB leased=1, B queued & unclaimed; snapshot active=A, queued∋B; challenges distinct`;
	});

	await run.case("MR-05", async () => {
		need("MR-04");
		gate.releaseAll();
		const out: string[] = [];
		const shas: Record<string, string> = {};
		for (const [repo, id] of [
			[A, T.a ?? ""],
			[B, T.b ?? ""],
		] as const) {
			await toHumanReady(page, repo, id);
			const mt = mtOf(id);
			const runs = runsOf(mt);
			check(runs.length === 1, `${repo}: ${runs.length} attempts`);
			const shownExec = await textOf(page.getByTestId("execution-id"));
			const shownCand = await textOf(page.getByTestId("candidate-sha"));
			const cand = runs[0]?.candidate_sha ?? "";
			check(shownExec.includes(mt), `${repo}: execution-id "${shownExec}"`);
			check(shownCand === cand, `${repo}: candidate shown ≠ DB`);
			check(
				(await taskRepo(page)) === repo,
				`${repo}: task-repo "${await taskRepo(page)}"`,
			);
			const fx = env.repos.find((r) => r.id === repo);
			const other = env.repos.find((r) => r.id === (repo === A ? B : A));
			check(fx && other, "fixture repos");
			check(
				gitHasCommit(env.fx.config.git_executable, fx.path, cand) &&
					!gitHasCommit(env.fx.config.git_executable, other.path, cand),
				`${repo}: candidate commit not exclusively in its own repository`,
			);
			// every evidence item listed for this task is one of ITS artifacts and opens verified
			const arts = artifactsOf(mt);
			const ev = region(page, "Task detail").getByRole("region", {
				name: "Evidence",
			});
			for (const a of arts.slice(0, 3)) {
				await ev.getByRole("button", { name: a.name, exact: true }).click();
				const d = page.getByRole("dialog", { name: `Evidence: ${a.name}` });
				await d.waitFor();
				await until(
					async () => (await d.getAttribute("data-state")) !== "loading",
					`viewer ${a.name}`,
				);
				check(
					(await d.getAttribute("data-artifact-id")) === a.id,
					`${repo}: viewer shows another artifact`,
				);
				check(
					(await d.getAttribute("data-state")) === "ok",
					`${repo}: ${a.name} not ok`,
				);
				await d.getByRole("button", { name: "Close evidence" }).click();
			}
			const env1 = JSON.parse(
				lastReq(id, "result")?.result_envelope ?? "{}",
			) as {
				workspace_task_id?: string;
				base_sha?: string;
			};
			check(env1.workspace_task_id === id, `${repo}: envelope task`);
			check(env1.base_sha === fx.baseSha, `${repo}: envelope base`);
			shas[repo] = cand;
			out.push(
				`${repo.split("/").pop()}: 1 attempt, candidate ${cand.slice(0, 8)} only in its repo, ${arts.length} artifacts (first 3 opened ok)`,
			);
		}
		check(shas[A] !== shas[B], "same candidate in both repositories");
		await sampler.stop();
		check(
			sampler.max <= 1,
			`${sampler.max} executions leased at once (${sampler.samples} samples)`,
		);
		return `${out.join("; ")}; lease samples ${sampler.samples}, max leased ${sampler.max}`;
	});

	await sampler.stop(); // also when MR-03/04/05 failed (idempotent)

	await run.case("MR-06", async () => {
		need("MR-05");
		const t0 = Date.now();
		const ra = await grantIn(page, "result", titleA);
		const rb = await grantIn(page, "result", titleB);
		const chA = challenges.get(ra);
		const chB = challenges.get(rb);
		check(chA && chB && chA !== chB, "Gate-2 challenges not distinct");
		const pa = traffic.decisionPosts.filter(
			(p) => p.url.includes(ra) && p.at >= t0,
		);
		const pb = traffic.decisionPosts.filter(
			(p) => p.url.includes(rb) && p.at >= t0,
		);
		check(
			pa.length === 1 && pb.length === 1,
			`POSTs ${pa.length}/${pb.length}`,
		);
		check(decisionsFor(ra) === 1 && decisionsFor(rb) === 1, "decisions");
		check(
			taskRow(T.a ?? "")?.stage === "accepted" &&
				taskRow(T.b ?? "")?.stage === "accepted",
			"stages",
		);
		await openTaskIn(page, A, T.a ?? "");
		const accA = await attr(page, "acceptance-status", "data-status");
		await openTaskIn(page, B, T.b ?? "");
		const accB = await attr(page, "acceptance-status", "data-status");
		check(accA === "accepted" && accB === "accepted", `UI ${accA}/${accB}`);
		return "two separate Gate-2 documents, each field empty on arrival and signed with its own challenge; 1 POST + 1 accept decision each";
	});

	await run.case("MR-07", async () => {
		need("MR-01");
		const tA = "MR HQ pending A";
		const tB = "MR HQ pending B";
		const ia = await submitIn(page, A, { title: tA });
		const ib = await submitIn(page, B, { title: tB });
		T.hqA = ia;
		T.hqB = ib;
		await navLink(page, /^Head/).click();
		await region(page, "Approval inbox").waitFor();
		await until(
			async () => (await inboxItems(page)).length >= 2,
			"two pending documents",
		);
		const items = await inboxItems(page);
		const ra = lastReq(ia, "run")?.id ?? "";
		const rb = lastReq(ib, "run")?.id ?? "";
		const byId = new Map(items.map((i) => [i.requestId, i]));
		check(
			byId.get(ra)?.repo.includes(A),
			`inbox-repo for A "${byId.get(ra)?.repo}"`,
		);
		check(
			byId.get(rb)?.repo.includes(B),
			`inbox-repo for B "${byId.get(rb)?.repo}"`,
		);
		await run.shot(page, "hq-two-repos-pending");
		const filter = page.getByRole("combobox", {
			name: "Repository",
			exact: true,
		});
		check((await filter.count()) === 1, "no select labelled Repository");
		const pick = async (repo: string) => {
			const opts = (await filter.locator("option").evaluateAll((os) =>
				os.map((o) => ({
					v: (o as HTMLOptionElement).value,
					t: (o.textContent ?? "").trim(),
				})),
			)) as { v: string; t: string }[];
			const o = opts.find((x) => x.v === repo || x.t.includes(repo));
			check(
				o,
				`no filter option for ${repo}: ${opts.map((x) => x.t).join(" | ")}`,
			);
			await filter.selectOption(o.v);
			await sleep(300);
			return inboxItems(page);
		};
		const onlyB = await pick(B);
		check(
			onlyB.length > 0 && onlyB.every((i) => i.repo.includes(B)),
			`filter B shows ${onlyB.map((i) => i.repo).join(",")}`,
		);
		check(!onlyB.some((i) => i.requestId === ra), "filter B shows A's request");
		const onlyA = await pick(A);
		check(
			onlyA.length > 0 && onlyA.every((i) => i.repo.includes(A)),
			`filter A shows ${onlyA.map((i) => i.repo).join(",")}`,
		);
		// back to everything (first option is expected to be "all")
		const first =
			(await filter.locator("option").first().getAttribute("value")) ?? "";
		await filter.selectOption(first);
		await sleep(300);
		const all = await inboxItems(page);
		check(all.length >= 2, `all-repositories shows ${all.length}`);
		// the document names its repository and opens its task in Projects
		await page
			.locator(
				`section[aria-label="Approval inbox"] button[data-request-id="${rb}"]`,
			)
			.click();
		await page
			.locator(
				`section[aria-label="Approval document"][data-request-id="${rb}"]`,
			)
			.waitFor();
		const dr = await documentRepo(page);
		check(dr.includes(B), `document-repo "${dr}"`);
		const doc = region(page, "Approval document");
		await doc
			.getByRole("link", { name: "Open task in Projects" })
			.or(doc.getByRole("button", { name: "Open task in Projects" }))
			.first()
			.click();
		await page
			.locator(`section[aria-label="Task detail"][data-task-id="${ib}"]`)
			.waitFor();
		const h = await hashOf(page);
		check(
			h === `#/projects/${B}/${ib}`,
			`hash after "Open task in Projects": ${h}`,
		);
		check(
			(await taskRepo(page)) === B,
			"task-repo after Open task in Projects",
		);
		check(
			(await repoRow(page, B).getAttribute("aria-current")) === "true",
			"B not selected after Open task in Projects",
		);
		return `inbox-repo labels per item; filter A→${onlyA.length}, B→${onlyB.length}, all→${all.length}; document-repo ${B}; Open task in Projects → ${h}`;
	});

	await run.case("MR-08", async () => {
		need("MR-07");
		const out: string[] = [];
		for (const [repo, label, states] of [
			[A, "A", ["attention"]],
			[B, "B", ["attention"]],
			[E, "empty", ["empty"]],
			[O, "observed", ["observed"]],
		] as const) {
			await pickRepo(page, repo);
			const b = await waitBriefing(page, repo, [...states]);
			check(b.present === 1, `${b.present} briefings shown for ${label}`);
			const foreign = b.items.filter(
				(i) => i.taskId && taskRow(i.taskId)?.repo_id !== repo,
			);
			check(
				foreign.length === 0,
				`${label}: briefing items of other repositories ${foreign.map((f) => f.taskId).join(",")}`,
			);
			if (repo === A || repo === B)
				check(
					b.items.some((i) => i.taskId === (repo === A ? T.hqA : T.hqB)),
					`${label}: the pending document is not in the briefing`,
				);
			if (repo === E || repo === O)
				check(b.items.length === 0, `${label}: ${b.items.length} items`);
			check(b.summary.length > 0, `${label}: empty briefing-summary`);
			check(
				b.freshness === "current",
				`${label}: data-freshness=${b.freshness}`,
			);
			await run.shot(page, `briefing-${label}-${b.state}`);
			out.push(`${label}=${b.state}(${b.items.length} items)`);
		}
		// every claim of A's briefing (details on demand + any summary-level link) navigates to its
		// task / request, without a mutation
		await pickRepo(page, A);
		await waitBriefing(page, A);
		const opened = await expandBriefing(page);
		const b = await briefingInfo(page);
		check(b.items.length > 0, "A's briefing lists no item");
		const t0 = Date.now();
		for (let i = 0; i < b.items.length; i++) {
			await pickRepo(page, A);
			await waitBriefing(page, A);
			await expandBriefing(page);
			const item = (await briefingInfo(page)).items[i];
			check(item, `item ${i} vanished`);
			check(item.controls > 0, `item ${item.kind} has no navigating control`);
			// by the item's frozen identity, not its index (a poll may re-render / reorder the items)
			await expandBriefing(page);
			await briefing(page)
				.locator(
					`[data-briefing-item="${item.kind}"][data-task-id="${item.taskId}"]`,
				)
				.locator("button, a[href]")
				.first()
				.click();
			await until(
				async () =>
					(await page
						.locator(
							`section[aria-label="Task detail"][data-task-id="${item.taskId}"]`,
						)
						.count()) > 0 ||
					(item.requestId !== null &&
						(await page
							.locator(
								`section[aria-label="Approval document"][data-request-id="${item.requestId}"]`,
							)
							.count()) > 0),
				`briefing item ${item.kind} → its task/request`,
				8000,
			);
		}
		// summary-level controls outside the items (e.g. "Next: …") navigate too
		await pickRepo(page, A);
		await waitBriefing(page, A);
		const controls = briefing(page).locator("button, a[href]");
		const topIdx = (await controls.evaluateAll((els) =>
			els
				.map((e, i) => (e.closest("[data-briefing-item]") ? -1 : i))
				.filter((i) => i >= 0),
		)) as number[];
		const nTop = topIdx.length;
		for (const i of topIdx) {
			await pickRepo(page, A);
			await waitBriefing(page, A);
			const h0 = await hashOf(page);
			await controls.nth(i).click({ timeout: 4000 });
			await until(
				async () => (await hashOf(page)) !== h0,
				`summary control ${i} navigates`,
				5000,
			);
		}
		const m = main.muts.since(t0);
		check(m.length === 0, `briefing navigation sent ${m.length} mutation(s)`);
		return `${out.join(", ")}; details ${opened ? "opened on demand" : "already open"}; ${b.items.length} A items + ${nTop} summary control(s) each navigated (0 mutations)`;
	});

	await run.case("MR-09", async () => {
		need("MR-06");
		const capture = async () => {
			const per: Record<string, unknown> = {};
			for (const repo of [A, B]) {
				await pickRepo(page, repo);
				const ids = (await listedTasks(page)).sort();
				const record: Record<string, string[]> = {};
				for (const id of ids.filter((x) => x === T.a || x === T.b)) {
					await openTaskIn(page, repo, id);
					record[id] = await page
						.locator('section[aria-label="Task detail"] li[data-request-id]')
						.evaluateAll((els) =>
							els.map(
								(e) =>
									`${e.getAttribute("data-request-id")}=${(
										(e as HTMLElement).innerText ?? ""
									)
										.replace(/\s+/g, " ")
										.replace(/\d+ s ago|checked [^)]*\)/g, "")
										.trim()}`,
							),
						);
					check(
						(await taskRepo(page)) === repo,
						`task-repo of ${id} ≠ ${repo}`,
					);
				}
				per[repo] = { ids, record };
			}
			const hq: Record<string, string[]> = {};
			for (const id of [T.a ?? "", T.b ?? ""]) {
				const req = lastReq(id, "result")?.id ?? "";
				await page.goto(`${env.uiUrl}/#/hq/${id}/${req}`);
				await page
					.locator(
						`section[aria-label="Approval document"][data-request-id="${req}"]`,
					)
					.waitFor();
				hq[id] = (
					await region(page, "Decision history")
						.locator("[data-decision-id]")
						.evaluateAll((els) =>
							els.map((e) => e.getAttribute("data-decision-id") ?? ""),
						)
				).sort();
			}
			return { per, hq };
		};
		const before = await capture();
		gate.releaseAll();
		await env.restartHub();
		await page.reload();
		await signInSession(main);
		const after = await capture();
		check(
			JSON.stringify(after.per) === JSON.stringify(before.per),
			"per-repository lists / histories changed across the restart",
		);
		check(
			JSON.stringify(after.hq) === JSON.stringify(before.hq),
			"HQ history changed across the restart",
		);
		const decA = before.hq[T.a ?? ""] ?? [];
		const decB = before.hq[T.b ?? ""] ?? [];
		check(
			decA.length === 2 && decB.length === 2,
			`HQ histories hold ${decA.length} (A) / ${decB.length} (B) decisions, want 2 each`,
		);
		check(
			decA.every((d) => !decB.includes(d)),
			"A and B share a decision in their histories",
		);
		for (const repo of [A, B]) {
			await pickRepo(page, repo);
			await waitBriefing(page, repo);
		}
		return `per-repository task lists, per-task approval records and HQ decision histories (A ${decA.length}, B ${decB.length}, disjoint) identical before and after env.restartHub() + sign-in; briefings back for both`;
	});
}

// ── races and adversarial cases ─────────────────────────────────────────────

async function races(main: Session): Promise<void> {
	const { page } = main;

	await run.case("BRW-R-01", async () => {
		need("MR-01");
		// MATRIX: delay A's response by 1.2 s, click A then B — B is the observed-only repository
		await navLink(page, /^Head/).click();
		delayHits.n = 0;
		delayHits.detail = 0;
		await page.route(`**/api/workspace/tasks/${T.a}`, delayed(1200, 1, true));
		await page.route("**/api/workspace/snapshot", delayed(1200));
		await gotoProjects(page);
		await repoRow(page, A).click();
		await region(page, "Tasks")
			.locator(`[data-task-id="${T.a}"]`)
			.click({ timeout: 3000 })
			.catch(() => undefined); // A's detail request starts (delayed)
		await repoRow(page, O).click();
		const flashes: string[] = [];
		const end = Date.now() + 2600;
		while (Date.now() < end) {
			const st = (await page.evaluate(
				(a) => ({
					aDetail:
						document.querySelector(
							`section[aria-label="Task detail"][data-task-id="${a}"]`,
						) !== null,
					current:
						document
							.querySelector(
								'section[aria-label="Repositories"] button[aria-current="true"]',
							)
							?.getAttribute("data-repo-id") ?? "",
				}),
				T.a ?? "",
			)) as { aDetail: boolean; current: string };
			if (st.aDetail || st.current !== O)
				flashes.push(`${st.current}${st.aDetail ? "+A-detail" : ""}`);
			await sleep(100);
		}
		await page.unrouteAll({ behavior: "ignoreErrors" });
		const held = delayHits.n;
		check(
			delayHits.detail >= 1,
			"the delayed task-detail request was never sent (race not exercised)",
		);
		check(
			held >= 1,
			"the delayed response was never requested (race not exercised)",
		);
		check(
			(await repoRow(page, O).getAttribute("aria-current")) === "true",
			"observed row lost the selection",
		);
		check(
			(await repoRow(page, O).getAttribute("data-repo-kind")) === "observed",
			"B row not observed",
		);
		check(
			(await page.getByRole("main").getByText("Observed only").count()) > 0,
			'"Observed only" not shown',
		);
		const assign = await mainButtons(page, /^Assign work$/);
		check(
			assign.length === 0,
			"Assign work offered for the observed repository",
		);
		const b = await briefingInfo(page);
		check(
			b.repo === O && b.state === "observed",
			`briefing ${b.repo}/${b.state}`,
		);
		// every 100 ms sample after the click: O selected and A's detail absent
		check(
			flashes.length === 0,
			`A's late answer replaced B: ${[...new Set(flashes)].join(" ; ")}`,
		);
		check((await hashOf(page)).includes(O), `hash ${await hashOf(page)}`);
		await run.shot(page, "R01-observed-stays");
		return `${held} delayed response(s) (A's task detail + snapshot, 1.2 s); observed row stayed aria-current with no A detail for 2.6 s (0 off-samples); "Observed only", no Assign work, briefing observed`;
	});

	await run.case("MR-R02", async () => {
		need("MR-01");
		delayHits.n = 0;
		delayHits.detail = 0;
		await page.route(`**/api/workspace/tasks/${T.a}`, delayed(1500, 1, true));
		await pickRepo(page, A);
		// A's detail request starts (delayed 1.5 s); B is chosen before it answers
		await region(page, "Tasks").locator(`[data-task-id="${T.a}"]`).click();
		await pickRepo(page, B, { nav: false });
		await region(page, "Tasks").locator(`[data-task-id="${T.b}"]`).click();
		await page
			.locator(`section[aria-label="Task detail"][data-task-id="${T.b}"]`)
			.waitFor();
		const seen: string[] = [];
		const end = Date.now() + 2400;
		while (Date.now() < end) {
			const shown =
				(await page
					.locator('section[aria-label="Task detail"]')
					.getAttribute("data-task-id")
					.catch(() => "")) ?? "";
			seen.push(`${shown}@${await taskRepo(page)}`);
			await sleep(100);
		}
		await page.unrouteAll({ behavior: "ignoreErrors" });
		const held = delayHits.n;
		check(
			delayHits.detail >= 1,
			"the delayed task-detail request was never sent (race not exercised)",
		);
		check(
			held >= 1,
			"the delayed response was never requested (race not exercised)",
		);
		const wrong = seen.filter((x) => x !== `${T.b}@${B}`);
		check(
			wrong.length === 0,
			`stale A answer shown: ${[...new Set(wrong)].join(",")}`,
		);
		check(
			(await repoRow(page, B).getAttribute("aria-current")) === "true",
			"B not selected",
		);
		check(
			tasksOutside(await listedTasks(page), B).length === 0,
			"foreign tasks listed under B",
		);
		return `${held} delayed response(s) (A's detail, 1.5 s); B's task (${B}) stayed for ${seen.length} samples`;
	});

	await run.case("MR-R03", async () => {
		need("MR-01");
		delayHits.n = 0;
		delayHits.detail = 0;
		await page.route(`**/api/workspace/tasks/${T.b}`, delayed(1500, 1, true));
		await page.route("**/api/workspace/snapshot", delayed(1500));
		await openTaskIn(page, A, T.a ?? "");
		await pickRepo(page, B, { nav: false });
		await region(page, "Tasks")
			.locator(`[data-task-id="${T.b}"]`)
			.click({ timeout: 3000 })
			.catch(() => undefined);
		await pickRepo(page, A, { nav: false });
		await region(page, "Tasks").locator(`[data-task-id="${T.a}"]`).click();
		await page
			.locator(`section[aria-label="Task detail"][data-task-id="${T.a}"]`)
			.waitFor();
		const flashes: string[] = [];
		const end = Date.now() + 2600;
		while (Date.now() < end) {
			const cur = await page
				.locator('section[aria-label="Task detail"]')
				.getAttribute("data-task-id")
				.catch(() => null);
			if (cur && cur !== T.a) flashes.push(cur);
			await sleep(100);
		}
		await page.unrouteAll({ behavior: "ignoreErrors" });
		const held = delayHits.n;
		check(
			delayHits.detail >= 1,
			"the delayed task-detail request was never sent (race not exercised)",
		);
		check(
			held >= 1,
			"the delayed response was never requested (race not exercised)",
		);
		check(
			flashes.length === 0,
			`B flashed in: ${[...new Set(flashes)].join(",")}`,
		);
		check((await taskRepo(page)) === A, "task-repo ≠ A");
		check(
			(await repoRow(page, A).getAttribute("aria-current")) === "true",
			"A not selected",
		);
		const listed = await listedTasks(page);
		check(tasksOutside(listed, A).length === 0, "foreign tasks listed under A");
		const b = await briefingInfo(page);
		check(b.repo === A, `briefing for ${b.repo}`);
		return `A→B→A with ${held} delayed response(s) (B's detail + snapshot): final task ${T.a?.slice(-8)} (task-repo A), list ${listed.length} A-only, briefing A; no flash`;
	});

	await run.case("MR-R04", async () => {
		// (a) same repository: a new version while Edward is typed on v1
		const t1 = "MR R04 A versioned";
		const id1 = await submitIn(page, A, { title: t1 });
		const old = await openRequest(page, "run", t1);
		await typeSignature(page, "run");
		const p2 = await main.context.newPage();
		await p2.goto(`${env.uiUrl}/#/projects`);
		await openTaskIn(p2, A, id1);
		await region(p2, "Task detail")
			.getByRole("button", { name: "Edit draft" })
			.click();
		await region(p2, "Task detail")
			.getByLabel("Objective", { exact: true })
			.fill("Changed while the signature was being entered.");
		await region(p2, "Task detail")
			.getByRole("button", { name: "Submit for run approval" })
			.click();
		await until(
			async () => (await textOf(p2.getByTestId("proposal-version"))) === "2",
			"v2 published",
		);
		await p2.close();
		const t0 = Date.now();
		if (
			await grantButton(page, "run")
				.isEnabled()
				.catch(() => false)
		)
			await grantButton(page, "run")
				.click()
				.catch(() => undefined);
		await until(
			async () =>
				(await page
					.locator(
						`section[aria-label="Approval document"][data-request-id="${old}"]`,
					)
					.getAttribute("data-request-status")
					.catch(() => null)) === "invalidated" ||
				(await page.getByRole("main").getByRole("alert").count()) > 0,
			"v1 invalidated / refused in the UI",
			10_000,
		);
		const r1 = reqsOf(id1).find((r) => r.id === old);
		check(r1?.status === "invalidated", `v1 request ${r1?.status}`);
		check(decisionsFor(old) === 0, "v1 decided");
		const m1 = managed(r1?.managed_task_id ?? "");
		check(
			m1?.state !== "queued" && runsOf(r1?.managed_task_id ?? "").length === 0,
			"v1 queued/ran",
		);
		const f = await sigField(page, "run")
			.inputValue()
			.catch(() => "");
		check(f === "", "signature kept after the context change");
		void t0;
		// (b) other repository: B changes while Edward is typed on A's request → A unaffected
		const ta = "MR R04 A steady";
		const tb = "MR R04 B changes";
		const ia = await submitIn(page, A, { title: ta });
		const ib = await submitIn(page, B, { title: tb });
		const ra = await openRequest(page, "run", ta);
		await typeSignature(page, "run");
		const bindingA = lastReq(ia, "run")?.binding_hash;
		const p3 = await main.context.newPage();
		await p3.goto(`${env.uiUrl}/#/projects`);
		await openTaskIn(p3, B, ib);
		await region(p3, "Task detail")
			.getByRole("button", { name: "Edit draft" })
			.click();
		await region(p3, "Task detail")
			.getByLabel("Objective", { exact: true })
			.fill("B changed while A was being signed.");
		await region(p3, "Task detail")
			.getByRole("button", { name: "Submit for run approval" })
			.click();
		await until(
			async () => (await textOf(p3.getByTestId("proposal-version"))) === "2",
			"B v2 published",
		);
		await p3.close();
		await sleep(2500); // at least one poll on page 1
		const kept = (await sigField(page, "run").inputValue()) === "Edward";
		if (!kept) await typeSignature(page, "run");
		const t1b = Date.now();
		await grantButton(page, "run").click();
		await until(
			async () => /Execution approved/.test(await decisionStatus(page)),
			"A approved after B's change",
		);
		const post = main.traffic.decisionPosts.filter(
			(p) => p.url.includes(ra) && p.at >= t1b,
		);
		check(post.length === 1, `${post.length} POSTs`);
		check(
			(JSON.parse(post[0]?.body ?? "{}") as { binding_hash?: string })
				.binding_hash === bindingA,
			"A's binding changed",
		);
		check(decisionsFor(ra) === 1, "A decisions ≠ 1");
		const rbs = reqsOf(ib).filter((r) => r.kind === "run");
		check(
			rbs.length === 2 &&
				rbs[0]?.status === "invalidated" &&
				rbs[1]?.status === "pending",
			`B requests ${rbs.map((r) => r.status).join(",")}`,
		);
		T.r04a = ia;
		return `(a) v1 invalidated, refused in UI, 0 decisions, nothing queued, field emptied; (b) B v2 while A signed: A approved once with its unchanged binding (field ${kept ? "kept" : "re-typed"} across the unrelated change), B v1 invalidated / v2 pending`;
	});

	await run.case("MR-R05", async () => {
		// (a) the hub commits, the response is lost on the way back; (b) the request never reaches the
		// hub. Either way: no new key, byte-identical resends only, exactly one decision / execution.
		const out: string[] = [];
		for (const [variant, title] of [
			["committed-then-lost", "MR R05a B response lost"],
			["lost-before-hub", "MR R05b B request lost"],
		] as const) {
			const id = await submitIn(page, B, { title });
			const req = await openRequest(page, "run", title);
			await typeSignature(page, "run");
			await recordDecisionStatus(page);
			let n = 0;
			await page.route(
				`**/approval-requests/${req}/decisions`,
				async (route) => {
					n += 1;
					if (n === 1) {
						if (variant === "committed-then-lost")
							await route.fetch().catch(() => null);
						await route.abort("connectionreset").catch(() => undefined);
						return;
					}
					await route.continue().catch(() => undefined);
				},
			);
			const t0 = Date.now();
			await grantButton(page, "run").click();
			let attempted = false;
			let clicked = false;
			let fieldWhileUnknown = "";
			let grantWhileUnknown = false;
			await until(
				async () => {
					const st = await decisionStatus(page);
					const chk = region(page, "Approval document").getByRole("button", {
						name: "Check decision outcome",
					});
					if (!attempted && (await chk.count()) > 0) {
						attempted = true;
						// Read the gate controls WITHOUT waiting: the first detail read may reconcile the committed
						// decision right now, closing the request and removing the signature field and Approve
						// (a removed field keeps nothing; a removed button is not enabled). Waiting on them
						// used to stall this predicate for two default timeouts (12 s each).
						const sig = sigField(page, "run");
						fieldWhileUnknown =
							(await sig.count()) > 0
								? await sig.inputValue({ timeout: 500 }).catch(() => "")
								: "";
						const grant = grantButton(page, "run");
						grantWhileUnknown =
							(await grant.count()) > 0
								? await grant.isEnabled({ timeout: 500 }).catch(() => false)
								: false;
						// committed-then-lost: the page's next poll may reconcile the committed decision and
						// remove the button between the count and the click — a legitimate path (the status
						// and DB checks below decide). A vanished button is never counted as a use, and it
						// must really be gone, not merely unclickable.
						clicked = await chk.click({ timeout: 2_000 }).then(
							() => true,
							() => false,
						);
						if (!clicked)
							check(
								(await chk.count()) === 0,
								`${variant}: "Check decision outcome" still offered but could not be clicked`,
							);
					}
					return /Execution approved/.test(st);
				},
				`${variant}: reconciled approved`,
				20_000,
			);
			await page.unrouteAll({ behavior: "ignoreErrors" });
			await sleep(800);
			const trail = await statusTrail(page);
			const sawUnknown = trail.some((x) => /Decision outcome unknown/.test(x));
			const p = main.traffic.decisionPosts.filter(
				(x) => x.url.includes(req) && x.at >= t0,
			);
			check(
				new Set(p.map((x) => x.body)).size === 1,
				`${variant}: ${new Set(p.map((x) => x.body)).size} different bodies`,
			);
			check(decisionsFor(req) === 1, `${variant}: decisions ≠ 1`);
			check(
				reqsOf(id).filter((r) => r.kind === "run" && r.status === "approved")
					.length === 1,
				`${variant}: executions ≠ 1`,
			);
			check(
				fieldWhileUnknown === "",
				`${variant}: signature kept while unknown`,
			);
			check(!grantWhileUnknown, `${variant}: Approve enabled while unknown`);
			if (variant === "lost-before-hub")
				check(
					sawUnknown && clicked,
					`lost-before-hub: "Decision outcome unknown" shown ${sawUnknown}, Check decision outcome used ${clicked}`,
				);
			out.push(
				`${variant}: unknown shown ${sawUnknown}, Check used ${clicked}, ${p.length} POST(s) byte-identical, 1 decision`,
			);
			T[`r05-${variant}`] = id;
		}
		await toHumanReady(page, B, T["r05-lost-before-hub"] ?? "");
		return out.join("; ");
	});

	await run.case("MR-R06", async () => {
		gate.arm("before_review");
		const ta = "MR R06 A holds the engine";
		const tb = "MR R06 B waits then cancels";
		const ia = await submitIn(page, A, { title: ta });
		await grantIn(page, "run", ta);
		const mtA = mtOf(ia);
		await until(() => gate.holding("before_review", mtA), "A held", 30_000);
		const ib = await submitIn(page, B, { title: tb });
		await grantIn(page, "run", tb);
		const mtB = mtOf(ib);
		await openTaskIn(page, B, ib);
		const qs = await queueStatus(page);
		const aBefore = managed(mtA);
		await region(page, "Task detail")
			.getByRole("button", { name: "Cancel execution" })
			.click();
		await waitStage(page, "Cancelled", 20_000);
		check(
			managed(mtB)?.state === "cancelled",
			`B engine ${managed(mtB)?.state}`,
		);
		check(runsOf(mtB).length === 0, "B ran");
		check(
			JSON.stringify(managed(mtA)) === JSON.stringify(aBefore),
			"A's engine row changed by B's cancel",
		);
		check(gate.holding("before_review", mtA), "A lost the engine slot");
		await openTaskIn(page, A, ia);
		// A's panel shows the engine state the hub records for A (it holds the slot) — within 3 polls
		const dbA = managed(mtA)?.state ?? "";
		const seenA: string[] = [];
		let ea = "";
		await until(
			async () => {
				ea = (await attr(page, "engine-state", "data-state")) ?? "";
				if (seenA.at(-1) !== ea) seenA.push(ea);
				return ea === dbA;
			},
			"A's engine-state",
			6500,
			200,
		).catch(() => {
			throw new Error(
				`A's task panel engine-state ${seenA.join("→")} while the hub records ${dbA} (A holds the engine slot)`,
			);
		});
		gate.releaseAll();
		await toHumanReady(page, A, ia);
		check(runsOf(mtB).length === 0, "B ran after A finished");
		T.r06a = ia;
		T.r06aTitle = ta;
		return `B queue-status before cancel "${qs}"; B cancelled (0 attempts); A's engine row unchanged, its panel showing ${seenA.join("→")} (hub: ${dbA}); A finished to Gate 2 afterwards`;
	});

	await run.case("MR-R07", async () => {
		need("MR-R06", "MR-06");
		const id = T.r06a ?? "";
		await grantIn(page, "result", T.r06aTitle ?? "");
		const decision = db1<{ id: string }>(
			"SELECT id FROM managed_decisions WHERE workspace_task_id = ? AND action = 'accept'",
			id,
		);
		check(decision, "no accept decision");
		const mt = mtOf(id);
		const diff = artifactsOf(mt).find((a) => a.name === "diff.patch");
		check(diff, "no diff artifact");
		flipByte(join(env.fx.config.artifacts_root, diff.rel_path));
		await page.reload();
		await openTaskIn(page, A, id);
		await until(
			async () =>
				(await attr(page, "acceptance-validity", "data-status")) === "invalid",
			"task detail: acceptance-validity invalid",
			30_000,
		);
		await run.shot(page, "invalid-evidence-task-detail");
		// HQ: the accepted result's document and its task's decision history read as no longer valid
		const resultReq = lastReq(id, "result")?.id ?? "";
		await page.goto(`${env.uiUrl}/#/hq/${id}/${resultReq}`);
		await page
			.locator(
				`section[aria-label="Approval document"][data-request-id="${resultReq}"]`,
			)
			.waitFor();
		const histItem = region(page, "Decision history").locator(
			`[data-decision-id="${decision.id}"]`,
		);
		await histItem.waitFor({ timeout: 8000 });
		const docText = await textOf(region(page, "Approval document"));
		check(
			/no longer valid/i.test(docText),
			"HQ document does not say the acceptance is no longer valid",
		);
		const hqText = await textOf(histItem);
		check(
			/no longer valid|invalid/i.test(hqText),
			`HQ history: "${hqText.slice(0, 120)}"`,
		);
		await run.shot(page, "invalid-evidence-hq");
		// briefing of A: attention, with an item for this task naming the invalid acceptance
		await pickRepo(page, A);
		await waitBriefing(page, A, ["attention"], 15_000);
		await expandBriefing(page);
		const b = await briefingInfo(page);
		const item = b.items.find((i) => i.taskId === id);
		check(
			item,
			`briefing has no item for the invalid task (${b.items.map((i) => i.kind).join(",")})`,
		);
		check(
			/no longer valid|invalid/i.test(item.text),
			`briefing item "${item.text.slice(0, 120)}"`,
		);
		await briefing(page)
			.locator(`[data-briefing-item][data-task-id="${id}"]`)
			.scrollIntoViewIfNeeded()
			.catch(() => undefined);
		await run.shot(page, "invalid-evidence-briefing");
		// B's accepted result stays valid everywhere
		await openTaskIn(page, B, T.b ?? "");
		const vb = await attr(page, "acceptance-validity", "data-status");
		check(vb === "valid", `B validity ${vb}`);
		await waitBriefing(page, B);
		await expandBriefing(page);
		const bb = await briefingInfo(page);
		check(
			!bb.items.some(
				(i) => i.taskId === T.b && /invalid|no longer valid/i.test(i.text),
			),
			"B's briefing shows A's invalid evidence",
		);
		return `A: detail invalid, HQ history "${hqText.slice(0, 60)}", briefing ${b.state} item ${item.kind}; B: validity ${vb}, no invalid item`;
	});

	await run.case("MR-E01", async () => {
		await pickRepo(page, E);
		const b = await waitBriefing(page, E, ["empty"]);
		const listed = await listedTasks(page);
		const exec = await mainButtons(page, EXEC_RE);
		check(
			listed.length === 0,
			`${listed.length} tasks listed under the empty repository`,
		);
		check(exec.length === 0, `execution controls: ${exec.join(", ")}`);
		check(
			(await page.getByTestId("queue-status").count()) === 0,
			"queue-status shown",
		);
		const n = db1<{ n: number }>(
			"SELECT (SELECT count(*) FROM workspace_tasks WHERE repo_id = ?) + (SELECT count(*) FROM managed_tasks WHERE repo_id = ?) AS n",
			E,
			E,
		)?.n;
		check(n === 0, `${n} rows for the empty repository`);
		return `briefing ${b.state} ("${b.summary.slice(0, 60)}"), 0 tasks, no execution controls, 0 DB rows`;
	});

	await run.case("MR-E02", async () => {
		await pickRepo(page, O);
		const b = await waitBriefing(page, O, ["observed"]);
		check(
			(await mainButtons(page, /^Assign work$/)).length === 0,
			"Assign work offered",
		);
		check(
			(await mainButtons(page, EXEC_RE)).length === 0,
			"execution control offered",
		);
		check(
			(await page.getByRole("main").getByText("Observed only").count()) > 0,
			'"Observed only" missing',
		);
		const out: string[] = [`select: briefing ${b.state}`];
		for (const hash of [
			`#/projects/${encodeURIComponent(O)}`,
			`#/projects/${encodeURIComponent(O)}/${T.a}`,
		]) {
			await page.goto(`${env.uiUrl}/${hash}`);
			await page.getByText(/^Signed in as operator:edward/).waitFor();
			await sleep(1200);
			const oSelected =
				(await repoRow(page, O).getAttribute("aria-current")) === "true";
			const aDetail =
				(await page
					.locator(`section[aria-label="Task detail"][data-task-id="${T.a}"]`)
					.count()) > 0;
			const where = hash
				.replace(encodeURIComponent(O), "<O>")
				.replace(T.a ?? "", "<A-task>");
			check(
				!(oSelected && aDetail),
				`${where}: A's task rendered under the observed repository`,
			);
			if (oSelected) {
				// the observed repository is what is shown: nothing executable at all
				const exec = await mainButtons(
					page,
					/^(Assign work|Approve execution|Accept result|Cancel execution|Request a new run|Submit for run approval|Save draft)$/,
				);
				check(exec.length === 0, `${where}: offers ${exec.join(", ")}`);
				const bo = await briefingInfo(page);
				check(
					bo.repo === O && bo.state === "observed",
					`${where}: briefing ${bo.repo}/${bo.state}`,
				);
				out.push(`${where}: observed, nothing executable`);
			} else {
				// the UI resolved the task to the repository that owns it (never to the observed one)
				const shown = await taskRepo(page);
				const sel = (await repoRows(page)).find((r) => r.current === "true");
				check(
					aDetail && shown === A && sel?.id === A,
					`${where}: neither the observed view nor A's own task (task-repo "${shown}", selected ${sel?.id})`,
				);
				out.push(
					`${where}: resolved to the owning repository A (hash ${await hashOf(page)})`,
				);
			}
		}
		const n = db1<{ n: number }>(
			"SELECT (SELECT count(*) FROM workspace_tasks WHERE repo_id = ?) + (SELECT count(*) FROM managed_tasks WHERE repo_id = ?) AS n",
			O,
			O,
		)?.n;
		check(n === 0, `${n} rows for the observed repository`);
		await gotoProjects(page);
		return `${out.join("; ")}; 0 DB rows`;
	});
}

// ── BRW-J-21 CEO briefing ───────────────────────────────────────────────────

async function briefingJourney(): Promise<void> {
	await run.case("BRW-J-21", async () => {
		need("MR-07");
		const s = await open();
		const { page } = s;
		const t0 = Date.now();
		/** Every visible control of the briefing is actionable within 1 s (visible, stable, enabled). */
		const allActionable = async (p: Page): Promise<number> => {
			const ctl = briefing(p).locator("button, a[href], summary");
			const n = await ctl.count();
			let visible = 0;
			for (let i = 0; i < n; i++) {
				const c = ctl.nth(i);
				if (!(await c.isVisible())) continue;
				visible += 1;
				await c.click({ timeout: 1000, trial: true });
			}
			return visible;
		};
		/** Follow claim i (details opened on demand) and prove it lands on its own task / request. */
		const follow = async (p: Page, i: number): Promise<string> => {
			await pickRepo(p, A);
			await waitBriefing(p, A);
			await expandBriefing(p);
			const it = (await briefingInfo(p)).items[i];
			check(it, `claim ${i} vanished`);
			check(
				taskRow(it.taskId)?.repo_id === A,
				`claim ${i} names a task of another repository`,
			);
			// Target the claim by its frozen identity, not its index: a poll may legitimately re-render
			// or reorder the claims between the read above and this click (other repositories' work keeps
			// moving). Immediacy is asserted by allActionable (≤ 1 s per control); this click only proves
			// where the claim leads, so it uses the normal action timeout. On failure, record this page
			// (the harness's failure screenshot shows the suite's main page, not this one).
			const claim = briefing(p)
				.locator(
					`[data-briefing-item="${it.kind}"][data-task-id="${it.taskId}"]`,
				)
				.locator("button, a[href]")
				.first();
			await expandBriefing(p);
			await claim.click().catch(async (err: Error) => {
				const now = await briefingInfo(p).catch(() => null);
				const open = await briefing(p)
					.locator("details[open]")
					.count()
					.catch(() => -1);
				await run
					.shot(p, `FAILED-J21-claim-${i}`, { checks: false })
					.catch(() => undefined);
				throw new Error(
					`${err.message.split("\n")[0]}; claim ${it.kind}/${it.taskId.slice(-8)}; briefing present=${now?.present} repo=${now?.repo} state=${now?.state} items=${now?.items.length} details-open=${open}`,
				);
			});
			await until(
				async () =>
					(await p
						.locator(
							`section[aria-label="Task detail"][data-task-id="${it.taskId}"]`,
						)
						.count()) > 0 ||
					(it.requestId !== null &&
						(await p
							.locator(
								`section[aria-label="Approval document"][data-request-id="${it.requestId}"]`,
							)
							.count()) > 0),
				`claim ${it.kind} → ${it.taskId}`,
				5000,
			);
			return it.kind;
		};
		try {
			// usable immediately: from the click to an actionable briefing, no animation to wait for
			await gotoProjects(page);
			const c0 = Date.now();
			await repoRow(page, A).click();
			await waitBriefing(page, A, undefined, 3000);
			const nVisible = await allActionable(page);
			const ready = Date.now() - c0;
			check(nVisible > 0, "the briefing shows no control at all");
			const animNow = await runningAnimationsIn(
				page,
				'section[aria-label="CEO briefing"]',
			);
			// opening the details on demand, then every claim navigates to its own task / request
			const opened = await expandBriefing(page);
			const b = await briefingInfo(page);
			check(b.items.length > 0, "A's briefing has no claim to follow");
			const visited: string[] = [];
			for (let i = 0; i < b.items.length; i++)
				visited.push(await follow(page, i));
			// keyboard only: Tab into the briefing, open the details, Tab to a claim, Enter
			await pickRepo(page, A);
			await waitBriefing(page, A);
			await repoRow(page, A).focus();
			let presses = await tabUntil(
				page,
				(f) =>
					f.inBriefing &&
					(f.tag === "summary" || (f.inItem && f.tag === "button")),
				"the briefing (details or a claim)",
			);
			if ((await focusInfo(page)).tag === "summary") {
				if ((await briefing(page).locator("details[open]").count()) === 0) {
					await page.keyboard.press("Enter");
					await until(
						async () =>
							(await briefing(page).locator("details[open]").count()) > 0,
						"details opened by keyboard",
						3000,
					);
				}
				presses += await tabUntil(
					page,
					(f) => f.inItem && (f.tag === "button" || f.tag === "a"),
					"a briefing claim",
				);
			}
			const fi = await focusInfo(page);
			const before = await hashOf(page);
			await page.keyboard.press("Enter");
			await until(
				async () => (await hashOf(page)) !== before,
				`Enter on "${fi.name.slice(0, 40)}" navigates`,
				3000,
			);
			// dismissing: close the details again (and any replay / dismiss control, if offered)
			await pickRepo(page, A);
			await waitBriefing(page, A);
			await expandBriefing(page);
			const openSummary = briefing(page).locator("details[open] > summary");
			const closedAgain = (await openSummary.count()) > 0;
			if (closedAgain) await openSummary.first().click();
			const extra: string[] = [];
			for (const re of [/replay/i, /dismiss|skip|hide/i]) {
				const btn = briefing(page).getByRole("button", { name: re }).first();
				if ((await btn.count()) > 0) {
					await btn.click();
					extra.push(String(re));
					await sleep(300);
				}
			}
			const muts = s.muts.since(t0);
			check(
				muts.length === 0,
				`briefing interactions sent ${muts.length} mutation(s): ${muts.map((m) => `${m.method} ${m.path}`).join(",")}`,
			);
			// reduced motion: the same access, nothing animating in the briefing
			const r = await open({ reducedMotion: "reduce" });
			try {
				const rm = (await r.page.evaluate(
					() => matchMedia("(prefers-reduced-motion: reduce)").matches,
				)) as boolean;
				check(rm, "reduced motion not emulated");
				await gotoProjects(r.page);
				const c1 = Date.now();
				await repoRow(r.page, A).click();
				await waitBriefing(r.page, A, undefined, 3000);
				const visR = await allActionable(r.page);
				const readyR = Date.now() - c1;
				const anim = await runningAnimationsIn(
					r.page,
					'section[aria-label="CEO briefing"]',
				);
				check(
					anim === 0,
					`${anim} running animation(s) in the briefing under reduced motion`,
				);
				await expandBriefing(r.page);
				const rb = await briefingInfo(r.page);
				check(
					rb.items.length === b.items.length,
					`reduced-motion items ${rb.items.length} ≠ ${b.items.length}`,
				);
				await run.shot(r.page, "J21-reduced-motion");
				await follow(r.page, 0);
				const rm2 = r.muts.since(c1);
				check(
					rm2.length === 0,
					`reduced-motion briefing sent ${rm2.length} mutation(s)`,
				);
				return `actionable ${ready} ms after the click (${nVisible} visible controls trial-clicked ≤ 1 s each; ${animNow} running animations in it); details ${opened ? "opened on demand" : "already open"}; ${visited.length} claims each navigated (${visited.join(",")}); keyboard: ${presses} Tab(s) + Enter on "${fi.name.slice(0, 30)}" navigated; details closed again ${closedAgain}; extra controls ${extra.join(",") || "none"}; reduced motion: actionable ${readyR} ms (${visR} controls), 0 animations, claim followed; 0 mutations (GETs ${s.muts.getsSince(t0)})`;
			} finally {
				await close(r);
			}
		} finally {
			await close(s);
		}
	});
}

// ── layout + keyboard at two viewports ──────────────────────────────────────

async function keyboardGate(
	page: Page,
	kind: Gate,
	title: string,
): Promise<void> {
	await navLink(page, /^Head/).click();
	await region(page, "Approval inbox").waitFor();
	await until(
		async () => (await inboxButton(page, kind, title).count()) > 0,
		`inbox ${title}`,
		20_000,
	);
	await inboxButton(page, kind, title).first().focus();
	await page.keyboard.press("Enter");
	await page
		.locator('section[aria-label="Approval document"][data-request-id]')
		.waitFor();
	await tabUntil(
		page,
		(f) => f.tag === "input" && f.label === SIG_LABEL[kind],
		`the ${kind} signature field`,
	);
	await page.keyboard.type("Edward", { delay: 20 });
	await until(
		async () => grantButton(page, kind).isEnabled(),
		"grant enabled",
		10_000,
	);
	await tabUntil(
		page,
		(f) =>
			f.tag === "button" &&
			f.name === (kind === "run" ? "Approve execution" : "Accept result"),
		"the grant button",
	);
	await page.keyboard.press("Enter");
}

async function layoutCases(): Promise<void> {
	for (const [w, h] of [
		[1440, 900],
		[1280, 800],
	] as const) {
		const id = `MR-L-${w}`;
		await run.case(id, async () => {
			const s = await open({ w, h });
			run.viewport = `${w}x${h}`;
			const { page } = s;
			try {
				await gotoProjects(page);
				const labels = await repoLabelIssues(page);
				check(
					labels.rows === 4,
					`${labels.rows} repository rows inspected (want 4)`,
				);
				check(
					labels.issues.length === 0,
					`repository labels: ${labels.issues.join(" | ")}`,
				);
				// a long title in B: selected-task identity readable, no page overflow
				const long =
					`MR L${w} ${"Long repository-scoped title ".repeat(4)}`.slice(0, 120);
				const lt = await saveIn(page, B, { title: long });
				const repoShown = await taskRepo(page);
				const repoBox = await page
					.getByTestId("task-repo")
					.first()
					.boundingBox();
				check(repoShown === B, `task-repo "${repoShown}"`);
				check(
					repoBox !== null &&
						repoBox.x >= 0 &&
						repoBox.x + repoBox.width <= w + 0.5,
					"task-repo outside the viewport",
				);
				const ovP = await pageOverflowX(page);
				await navLink(page, /^Head/).click();
				await sleep(400);
				const ovH = await pageOverflowX(page);
				check(
					ovP === 0 && ovH === 0,
					`horizontal overflow Projects ${ovP}px / HQ ${ovH}px`,
				);
				// keyboard: select repository B, then reach the briefing
				await gotoProjects(page);
				await repoRow(page, A).click();
				await repoRow(page, A).focus();
				await tabUntil(page, (f) => f.repoId === B, `repository row ${B}`);
				await page.keyboard.press("Enter");
				await until(
					async () =>
						(await repoRow(page, B).getAttribute("aria-current")) === "true",
					"B selected by keyboard",
					5000,
				);
				await waitBriefing(page, B);
				await tabUntil(page, (f) => f.inBriefing, "the briefing");
				// both gates by keyboard on a fresh task in A
				const title = `MR L${w} keyboard gates`;
				const tid = await submitIn(page, A, { title });
				await keyboardGate(page, "run", title);
				await until(
					async () => /Execution approved/.test(await decisionStatus(page)),
					"approved by keyboard",
				);
				await toHumanReady(page, A, tid);
				await keyboardGate(page, "result", title);
				await until(
					() => taskRow(tid)?.stage === "accepted",
					"accepted by keyboard",
					20_000,
				);
				await run.shot(page, `layout-${w}`);
				void lt;
				return `labels readable (${labels.rows} rows); long title task-repo ${B} in view; overflow 0/0; keyboard: repo B selected, briefing reached, Gate 1 + Gate 2 signed and granted`;
			} finally {
				run.viewport = "1440x900";
				await close(s);
			}
		});
	}
}

// ── reduced motion, no WebGL, scene resources ───────────────────────────────

/** The primary two-repository workflow: submit in A and B, approve both, accept both. */
async function twoRepoWorkflow(s: Session, tag: string): Promise<string> {
	const { page } = s;
	const ta = `${tag} A`;
	const tb = `${tag} B`;
	const ia = await submitIn(page, A, { title: ta });
	const ib = await submitIn(page, B, { title: tb });
	await waitBriefing(page, B);
	await grantIn(page, "run", ta);
	await grantIn(page, "run", tb);
	await toHumanReady(page, A, ia);
	check((await taskRepo(page)) === A, "task-repo A");
	await toHumanReady(page, B, ib);
	check((await taskRepo(page)) === B, "task-repo B");
	await grantIn(page, "result", ta);
	await grantIn(page, "result", tb);
	check(
		taskRow(ia)?.stage === "accepted" && taskRow(ib)?.stage === "accepted",
		"not both accepted",
	);
	return `${ia.slice(-6)}@A and ${ib.slice(-6)}@B accepted`;
}

async function motionWebglLeak(main: Session): Promise<void> {
	await run.case("MR-A-reduced-motion", async () => {
		const s = await open({ reducedMotion: "reduce" });
		run.flags = "reducedMotion=reduce";
		try {
			const rm = (await s.page.evaluate(
				() => matchMedia("(prefers-reduced-motion: reduce)").matches,
			)) as boolean;
			check(rm, "reduced motion not emulated");
			const r = await twoRepoWorkflow(s, "MR RM");
			const anim = await runningAnimations(s.page);
			check(anim === 0, `${anim} running animations at the end`);
			await run.shot(s.page, "reduced-motion-two-repos");
			return `${r}; 0 running animations`;
		} finally {
			run.flags = "";
			await close(s);
		}
	});

	await run.case("MR-A-no-webgl", async () => {
		check(noGl, "NOT-RUN: the WebGL-disabled browser did not launch");
		const s = await open({ b: noGl });
		run.flags = "webgl=disabled";
		try {
			const gl = (await s.page.evaluate(() => ({
				webgl: document.createElement("canvas").getContext("webgl") === null,
				webgl2: document.createElement("canvas").getContext("webgl2") === null,
			}))) as { webgl: boolean; webgl2: boolean };
			check(gl.webgl && gl.webgl2, `WebGL available ${JSON.stringify(gl)}`);
			const r = await twoRepoWorkflow(s, "MR NoGL");
			const p = await campusProbe(s.page);
			check(p.canvases === 0, `${p.canvases} canvases without WebGL`);
			await run.shot(s.page, "no-webgl-two-repos");
			return `getContext(webgl/webgl2) null in page; ${r}; campus ${p.scene ?? "-"}/${p.mode ?? "-"} with 0 canvases`;
		} finally {
			run.flags = "";
			await close(s);
		}
	});

	await run.case("MR-A-scene-leak", async () => {
		const page = main.page;
		run.current = page;
		await gotoProjects(page);
		await sleep(800);
		const g0 = (await campusProbe(page)).glTotal;
		const errs0 = run.consoleErrors.length;
		const rows: string[] = [];
		let worst = { canvases: 0, live: 0 };
		for (let i = 0; i < 4; i++) {
			for (const repo of [A, B, E, O]) {
				await pickRepo(page, repo, { nav: false });
				await sleep(250);
				const p = await campusProbe(page);
				worst = {
					canvases: Math.max(worst.canvases, p.canvases),
					live: Math.max(worst.live, p.glLive),
				};
			}
			await navLink(page, /^Head/).click();
			await sleep(250);
			await gotoProjects(page);
			await sleep(400);
			const p = await campusProbe(page);
			rows.push(`${p.canvases}/${p.glLive}`);
		}
		const g1 = (await campusProbe(page)).glTotal;
		check(
			worst.canvases <= 1 && worst.live <= 1,
			`peak canvases ${worst.canvases}, live GL contexts ${worst.live}`,
		);
		const errs = run.consoleErrors.length - errs0;
		check(errs === 0, `${errs} console error(s) during the cycles`);
		return `4 cycles × 4 repositories + Projects↔HQ: peak canvases ${worst.canvases}, live contexts ${worst.live}; per cycle ${rows.join(" ")}; contexts ever created ${g0}→${g1}`;
	});
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
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
		extraRepos: ["beta", "empty"],
		observedRepos: ["observed-only"],
		managedHooks: gate,
		auth: { max_sessions_per_principal: 16 },
	});
	run.secrets.add(env.credential);
	check(!env.uiUrl.endsWith(":4317") && !env.hubUrl.endsWith(":4317"), "4317");
	check(
		env.repos.length === 3 && env.observedRepoIds.length === 1,
		"environment shape",
	);
	A = env.repos[0]?.id ?? "";
	B = env.repos[1]?.id ?? "";
	E = env.repos[2]?.id ?? "";
	O = env.observedRepoIds[0] ?? "";
	console.log(
		`[MULTI] chromium ${version}; ui ${env.uiUrl}; hub port ≠ 4317; repos A/B/E + 1 observed; evidence ${run.outDir}`,
	);
	const t0 = Date.now();
	try {
		const main = await open();
		mainSession = main;
		await scenario(main);
		await races(main);
		await briefingJourney();
		await layoutCases();
		noGl = await chromium
			.launch({ headless: true, args: NOGL_ARGS })
			.catch(() => null);
		await motionWebglLeak(main);
	} finally {
		gate.releaseAll();
		for (const s of sessions) await s.context.close().catch(() => undefined);
		await noGl?.close().catch(() => undefined);
	}

	const live =
		db1<{ n: number }>(
			"SELECT count(*) AS n FROM managed_runs WHERE provider <> 'fake' OR mode <> 'simulated'",
		)?.n ?? -1;
	const total =
		db1<{ n: number }>("SELECT count(*) AS n FROM managed_runs")?.n ?? -1;
	const foreign = db1<{ n: number }>(
		"SELECT count(*) AS n FROM workspace_tasks WHERE repo_id NOT IN (?, ?, ?)",
		A,
		B,
		E,
	)?.n;
	run.record(
		"MR-G-simulated",
		live === 0 && foreign === 0 ? "PASS" : "FAIL",
		`${total} attempts, all provider=fake/mode=simulated (${live} other); workspace tasks outside the allowlist: ${foreign}`,
	);
	run.record(
		"MR-G-requests",
		run.blockedOrigins.length === 0 ? "PASS" : "FAIL",
		`${run.blockedOrigins.length} request(s) outside the UI origin aborted ${[...new Set(run.blockedOrigins)].join(", ")}`,
	);
	run.record(
		"MR-G-console",
		run.consoleErrors.length === 0 && run.dialogs.length === 0
			? "PASS"
			: "FAIL",
		`${run.consoleErrors.length} unexpected console error(s): ${run.consoleErrors.slice(0, 4).join(" | ")}; dialogs ${run.dialogs.length}`,
	);
	const file = run.writeSummary({
		browser: `Chromium headless shell ${version}`,
		playwright: "playwright-core 1.63.0",
		uiOrigin: "http://127.0.0.1:<free port>",
		durationS: Math.round((Date.now() - t0) / 1000),
	});
	console.log(`[MULTI] summary ${file}`);
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
	`[MULTI] PASS ${by("PASS")} · FAIL ${by("FAIL")} · NOT RUN ${by("NOT RUN")} · BLOCKED ${by("BLOCKED")} · evidence ${run.outDir}`,
);
process.exit(code);
