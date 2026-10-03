// Real isolated test-hub run, part 2 (role 07, M1C; HUB evidence, dev tool): Gate 2 accept /
// request changes / reject, the sealed result's evidence, tampered evidence before accept,
// verification failure without repair, one pre-approved repair (Gate 2 binds attempt 2), an
// interrupted run after a hub restart, cancel → cancelled, and challenge expiry with a short TTL.
//
//   …/iso/run.sh env PLAYWRIGHT_BROWSERS_PATH=/Users/edwardhwang/Library/Caches/ms-playwright \
//     bun --no-env-file apps/web/src/workspace-m1/dev/hub-gate2.ts
//
// See hub-kit.ts for the isolation and secret rules. The only file this script changes outside
// the browser is one artifact byte inside the run's disposable fixture directory (tamper case).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import {
	apiGet,
	assert,
	compose,
	finish,
	newPage,
	notes,
	openRequest,
	openTask,
	region,
	shot,
	signIn,
	sleep,
	startWorkspaceEnv,
	state,
	step,
	submitNew,
	taskIdFromUrl,
	textOf,
	type WorkspaceEnv,
	waitFor,
} from "./hub-kit.ts";

interface Detail {
	task: { stage: string; accepted_decision_id: string | null };
	engine: {
		managed_task_id: string;
		state: string;
		result_run_id: string | null;
	} | null;
	runs: { run_id: string; attempt_no: number; candidate_sha: string | null }[];
	approval_requests: {
		id: string;
		kind: string;
		status: string;
		invalidation_reason: string | null;
		run_id: string | null;
		result_envelope: { attempt_no: number; candidate_sha: string } | null;
	}[];
}

const decisionStatus = (page: Page) =>
	page.getByRole("status", { name: "Decision status" });
const stageText = (page: Page) => textOf(page.getByTestId("current-stage"));

async function approveGate1(page: Page, label: RegExp) {
	await openRequest(page, label);
	await page
		.getByLabel("Type Edward to approve execution")
		.pressSequentially("Edward");
	const approve = page.getByRole("button", { name: "Approve execution" });
	await waitFor(async () => !(await approve.isDisabled()), "approve enabled");
	await approve.click();
	await waitFor(
		async () =>
			(await textOf(decisionStatus(page))).includes("Execution approved"),
		"approved",
	);
}

async function waitForResult(page: Page, env: WorkspaceEnv, title: string) {
	await openTask(page, env, title);
	await waitFor(
		async () =>
			(await page
				.getByRole("button", { name: "Open result acceptance" })
				.count()) === 1,
		`${title}: Gate-2 request opened by the bridge`,
		90_000,
	);
}

async function openGate2(page: Page) {
	await page.getByRole("button", { name: "Open result acceptance" }).click();
	const doc = region(page, "Approval document");
	await waitFor(
		async () => (await doc.getAttribute("data-gate")) === "result",
		"result document",
	);
	return doc;
}

async function main() {
	const env = await startWorkspaceEnv({
		fixture: { limits: { lease_ttl_ms: 5_000 } },
	});
	state.secrets = [env.credential];
	const browser = await chromium.launch({ headless: true });
	const version = browser.version();
	const ids: Record<string, string> = {};
	try {
		const { page } = await newPage(browser, env, 1440, 900);
		const S = "1440x900";
		await page.goto(`${env.uiUrl}/#/projects`);
		await signIn(page, env.credential, env);

		await step(
			"Gate 2 accept: sealed evidence, fresh empty field, Edward + click, engine stays human_ready",
			async () => {
				await submitNew(page, env, "Add retry to webhook sender");
				ids.A = await taskIdFromUrl(page);
				await approveGate1(page, /Execution approval · Add retry/);
				await waitForResult(page, env, "Add retry to webhook sender");
				await waitFor(
					async () => (await stageText(page)) === "Awaiting acceptance",
					"stage awaiting acceptance",
				);
				assert(
					(await page
						.getByTestId("engine-state")
						.getAttribute("data-state")) === "human_ready",
					"engine human_ready",
				);
				assert(
					(await page
						.getByTestId("acceptance-status")
						.getAttribute("data-status")) === "pending",
					"acceptance pending",
				);
				const ev = await page
					.getByTestId("evidence-status")
					.getAttribute("data-status");
				notes.push(`A evidence status: ${ev}`);
				assert(ev === "verified", `evidence verified (got ${ev})`);
				const panelCandidate = await textOf(page.getByTestId("candidate-sha"));
				const opener = region(page, "Evidence").getByRole("button", {
					name: "diff.patch",
				});
				const openerId = await opener.getAttribute("id");
				await opener.click();
				const dialog = page.getByRole("dialog", {
					name: "Evidence: diff.patch",
				});
				await waitFor(
					async () =>
						["ok", "error"].includes(
							(await dialog.getAttribute("data-state")) ?? "",
						),
					"viewer settled",
				);
				notes.push(
					`A diff viewer: data-state=${await dialog.getAttribute("data-state")}`,
				);
				assert(
					(await dialog.getAttribute("data-state")) === "ok",
					"sealed diff shown",
				);
				assert(
					(await textOf(dialog.locator("pre"))).length > 0,
					"diff text present",
				);
				await shot(page, "20-sealed-evidence-viewer", S);
				await page.keyboard.press("Escape");
				await waitFor(
					async () => (await dialog.count()) === 0,
					"viewer closed",
				);
				assert(
					(await page.evaluate(() => document.activeElement?.id)) === openerId,
					"focus back to opener",
				);
				await shot(page, "21-task-awaiting-acceptance", S);
				await openGate2(page);
				const sig = page.getByLabel("Type Edward to accept this result");
				const accept = page.getByRole("button", { name: "Accept result" });
				assert(
					(await sig.inputValue()) === "" && (await accept.isDisabled()),
					"Gate-2 field empty, Accept disabled on arrival",
				);
				assert(
					(await textOf(page.getByTestId("candidate-sha"))) === panelCandidate,
					"same candidate as the task panel",
				);
				assert(
					(await page
						.getByTestId("attempt-id")
						.getAttribute("data-attempt-number")) === "1",
					"attempt 1",
				);
				await shot(page, "22-hq-gate2", S);
				await sig.pressSequentially("Edward");
				await waitFor(
					async () => !(await accept.isDisabled()),
					"accept enabled",
				);
				await sig.press("Enter");
				await sleep(400);
				assert(
					(await region(page, "Approval document").getAttribute(
						"data-request-status",
					)) === "pending",
					"Enter inert on Gate 2",
				);
				await accept.click();
				await waitFor(
					async () =>
						(await page
							.getByTestId("acceptance-status")
							.getAttribute("data-status")) === "accepted",
					"accepted",
				);
				assert(
					(await page
						.getByTestId("engine-state")
						.getAttribute("data-state")) === "human_ready",
					"engine unchanged by acceptance",
				);
				assert(
					(await textOf(decisionStatus(page))).includes(
						"does not change any repository",
					),
					"acceptance scope copy",
				);
				const d = await apiGet<Detail>(page, `/tasks/${ids.A}`);
				assert(
					d.body.task.stage === "accepted" && d.body.task.accepted_decision_id,
					"server: accepted",
				);
				assert(
					d.body.engine?.state === "human_ready",
					"server: engine human_ready",
				);
				await shot(page, "23-hq-gate2-accepted", S);
			},
		);

		await step(
			"Gate 2 request changes → editor → v2 → new Gate 1",
			async () => {
				await submitNew(page, env, "Tighten config validation");
				await approveGate1(page, /Execution approval · Tighten config/);
				await waitForResult(page, env, "Tighten config validation");
				await openGate2(page);
				await page
					.getByLabel("Decision reason")
					.fill("Also name the rejected key in the log.");
				const rc = page.getByRole("button", { name: "Request changes" });
				await waitFor(
					async () => !(await rc.isDisabled()),
					"request changes enabled",
				);
				await rc.click();
				await waitFor(
					async () =>
						(await textOf(decisionStatus(page))).includes(
							"Changes requested on the result",
						),
					"changes requested",
				);
				await openTask(page, env, "Tighten config validation");
				await waitFor(
					async () => (await stageText(page)) === "Changes requested",
					"stage changes requested",
				);
				assert(
					(await page
						.getByTestId("engine-state")
						.getAttribute("data-state")) === "human_ready",
					"engine human_ready kept",
				);
				const crit = page.getByRole("textbox", { name: "Acceptance criteria" });
				await crit.fill(
					`${await crit.inputValue()}\nThe rejected key is logged, with its path`,
				);
				await page
					.getByRole("button", { name: "Submit for run approval" })
					.click();
				await waitFor(
					async () =>
						(await textOf(page.getByTestId("proposal-version"))) === "2",
					"proposal v2",
				);
				await waitFor(
					async () => (await stageText(page)) === "Awaiting execution approval",
					"new Gate 1",
				);
				await shot(page, "24-gate2-changes-then-v2", S);
			},
		);

		await step(
			"Gate 2 reject → closed, no repair or new execution",
			async () => {
				await submitNew(page, env, "Rename legacy flags");
				await approveGate1(page, /Execution approval · Rename legacy/);
				await waitForResult(page, env, "Rename legacy flags");
				await openGate2(page);
				await page
					.getByLabel("Decision reason")
					.fill("Not worth the churn this quarter.");
				const rj = page.getByRole("button", { name: "Reject" });
				await waitFor(async () => !(await rj.isDisabled()), "reject enabled");
				await rj.click();
				await waitFor(
					async () =>
						(await textOf(decisionStatus(page))).includes("Result rejected"),
					"result rejected",
				);
				await openTask(page, env, "Rename legacy flags");
				await waitFor(
					async () => (await stageText(page)) === "Rejected",
					"stage rejected",
				);
				assert(
					(await page.getByText(/This task is closed/).count()) >= 1,
					"reads as closed",
				);
				assert(
					(await page
						.getByRole("button", { name: "Request a new run" })
						.count()) === 0,
					"no new run offered",
				);
				await shot(page, "25-gate2-rejected", S);
			},
		);

		await step(
			"tampered evidence before accept → integrity error, request invalidated, field emptied",
			async () => {
				await submitNew(page, env, "Speed up the import step");
				ids.D = await taskIdFromUrl(page);
				await approveGate1(page, /Execution approval · Speed up the import/);
				await waitForResult(page, env, "Speed up the import step");
				const d = await apiGet<Detail>(page, `/tasks/${ids.D}`);
				const e = d.body.engine;
				assert(e?.result_run_id, "result run known");
				const file = join(
					env.fx.config.artifacts_root,
					e.managed_task_id,
					e.result_run_id,
					"diff.patch",
				);
				const bytes = readFileSync(file);
				const at = Math.floor(bytes.length / 2);
				bytes[at] = (bytes[at] ?? 0) ^ 0x01; // one flipped bit in a required artifact
				writeFileSync(file, bytes);
				notes.push(
					"tamper: one byte of the sealed diff.patch flipped in the disposable fixture",
				);
				await openGate2(page);
				const sig = page.getByLabel("Type Edward to accept this result");
				await sig.pressSequentially("Edward");
				const accept = page.getByRole("button", { name: "Accept result" });
				await waitFor(
					async () => !(await accept.isDisabled()),
					"accept enabled",
				);
				await accept.click();
				await waitFor(
					async () => (await page.getByRole("alert").count()) >= 1,
					"alert shown",
				);
				const alert = await textOf(page.getByRole("alert").first());
				notes.push(`tamper alert: ${alert.slice(0, 160)}`);
				await waitFor(
					async () =>
						(await region(page, "Approval document").getAttribute(
							"data-request-status",
						)) === "invalidated",
					"request invalidated",
					15_000,
				);
				assert(
					(await page
						.getByLabel("Type Edward to accept this result")
						.count()) === 0,
					"no signature field on an invalidated request",
				);
				assert(
					(await page
						.getByRole("button", { name: "Accept result" })
						.count()) === 0,
					"Accept gone",
				);
				const after = await apiGet<Detail>(page, `/tasks/${ids.D}`);
				const req = after.body.approval_requests.find(
					(r) => r.kind === "result",
				);
				notes.push(
					`tamper server: request=${req?.status}/${req?.invalidation_reason} stage=${after.body.task.stage} accepted=${after.body.task.accepted_decision_id !== null}`,
				);
				assert(
					after.body.task.accepted_decision_id === null,
					"nothing accepted",
				);
				await shot(page, "26-tamper-integrity-error", S);
				await openTask(page, env, "Speed up the import step");
				assert(
					(await page
						.getByTestId("acceptance-status")
						.getAttribute("data-status")) === "invalidated",
					"acceptance invalidated",
				);
				const evNow = await page
					.getByTestId("evidence-status")
					.getAttribute("data-status");
				const evLabel = await textOf(page.getByTestId("evidence-status"));
				assert(
					evNow === "unknown" && evLabel.includes("Integrity check failed"),
					`neutral integrity reading (got ${evNow} "${evLabel}")`,
				);
				assert(
					(await page.getByText(/Sealed status void/).count()) >= 1,
					"per-item sealed status void (fresh read on open)",
				);
				const alertNow = await textOf(page.getByRole("alert").first());
				assert(
					!alertNow.includes("Awaiting acceptance"),
					"alert names the state after the failure",
				);
				const tampered = region(page, "Evidence").getByRole("button", {
					name: "diff.patch",
				});
				await tampered.click();
				const dlg = page.getByRole("dialog", { name: "Evidence: diff.patch" });
				try {
					await waitFor(
						async () =>
							["ok", "error"].includes(
								(await dlg.getAttribute("data-state")) ?? "",
							),
						"tampered viewer settled",
					);
					const hasText = (await dlg.locator("pre").count()) > 0;
					const fresh = await textOf(
						dlg.locator(".wsm1-kvs .wsm1-chip").first(),
					);
					notes.push(
						`tampered diff viewer (fresh read, R-F5): data-state=${await dlg.getAttribute("data-state")} status="${fresh}" text=${hasText}`,
					);
					assert(!hasText, "no content for the tampered artifact (R-F5)");
					assert(
						!/^Verified$/.test(fresh.trim()),
						"tampered artifact not verified",
					);
					assert(
						(await dlg
							.getByText(/hub's fresh check of the stored file/)
							.count()) === 1,
						"invalidated-result banner",
					);
					await shot(page, "27b-tamper-fresh-read-viewer", S);
				} finally {
					await page.keyboard.press("Escape");
					await waitFor(async () => (await dlg.count()) === 0, "viewer closed");
				}
				await shot(page, "27-tamper-task-panel", S);
			},
		);

		await step(
			"verification_fails with repair 0 → execution ended (failed), no Gate 2",
			async () => {
				await submitNew(
					page,
					env,
					"Speed up test fixtures",
					"verification_fails",
				);
				await approveGate1(page, /Execution approval · Speed up test fixtures/);
				await openTask(page, env, "Speed up test fixtures");
				await waitFor(
					async () =>
						(await page
							.getByTestId("engine-state")
							.getAttribute("data-state")) === "failed",
					"engine failed",
					90_000,
				);
				await waitFor(
					async () => (await stageText(page)) === "Failed",
					"stage failed (execution ended)",
					45_000,
				);
				assert(
					(await page
						.getByRole("button", { name: "Open result acceptance" })
						.count()) === 0,
					"no Gate 2",
				);
				assert(
					(await page
						.getByTestId("acceptance-status")
						.getAttribute("data-status")) === "none",
					"no result request",
				);
				assert(
					(await page
						.getByTestId("attempt-id")
						.getAttribute("data-attempt-number")) === "1",
					"no repair attempt",
				);
				notes.push(
					`verification_fails detail: ${(await textOf(page.locator(".wsm1-banner").first())).slice(0, 160)}`,
				);
				await shot(page, "28-verification-failed", S);
			},
		);

		await step(
			"reject_then_approve + Allow one repair → Gate 2 binds attempt 2",
			async () => {
				await compose(
					page,
					env,
					"Harden webhook signature check",
					"Signatures are verified, with a clear error",
					"reject_then_approve",
				);
				await page.getByRole("radio", { name: "Allow one repair" }).check();
				await page
					.getByRole("button", { name: "Submit for run approval" })
					.click();
				await waitFor(
					async () => (await stageText(page)) === "Awaiting execution approval",
					"submitted",
				);
				ids.F = await taskIdFromUrl(page);
				await openRequest(page, /Execution approval · Harden webhook/);
				assert(
					(await page.getByText("1 pre-approved repair attempt").count()) >= 1,
					"repair allowance shown in the Gate-1 document",
				);
				await page
					.getByLabel("Type Edward to approve execution")
					.pressSequentially("Edward");
				const approve = page.getByRole("button", { name: "Approve execution" });
				await waitFor(
					async () => !(await approve.isDisabled()),
					"approve enabled",
				);
				await approve.click();
				await waitFor(
					async () =>
						(await textOf(decisionStatus(page))).includes("Execution approved"),
					"approved",
				);
				await waitForResult(page, env, "Harden webhook signature check");
				const d = await apiGet<Detail>(page, `/tasks/${ids.F}`);
				const env2 = d.body.approval_requests.find(
					(r) => r.kind === "result",
				)?.result_envelope;
				const attempts = d.body.runs.map((r) => r.attempt_no);
				notes.push(
					`repair: attempts=${JSON.stringify(attempts)} envelope attempt=${env2?.attempt_no}`,
				);
				assert(env2?.attempt_no === 2, "envelope binds attempt 2");
				const r1 = d.body.runs.find((r) => r.attempt_no === 1);
				assert(
					env2.candidate_sha !== r1?.candidate_sha,
					"attempt-2 candidate differs from attempt 1",
				);
				await shot(page, "29-repair-task-attempts", S);
				await openGate2(page);
				assert(
					(await page
						.getByTestId("attempt-id")
						.getAttribute("data-attempt-number")) === "2",
					"Gate 2 shows attempt 2",
				);
				await shot(page, "30-repair-hq-gate2-attempt2", S);
			},
		);

		await step(
			"cancel (impl_hangs) → requested → stage cancelled after confirmation",
			async () => {
				await submitNew(page, env, "Stop the long import job", "impl_hangs");
				await approveGate1(page, /Execution approval · Stop the long/);
				await openTask(page, env, "Stop the long import job");
				await waitFor(
					async () =>
						(await page
							.getByTestId("engine-state")
							.getAttribute("data-state")) === "executing",
					"executing",
					60_000,
				);
				await page.getByRole("button", { name: "Cancel execution" }).click();
				await waitFor(
					async () =>
						(await page.getByTestId("cancellation-status").count()) === 1,
					"cancellation shown",
				);
				notes.push(
					`cancel first status: ${await page.getByTestId("cancellation-status").getAttribute("data-status")}`,
				);
				await waitFor(
					async () => (await stageText(page)) === "Cancelled",
					"stage cancelled",
					60_000,
				);
				assert(
					(await page
						.getByTestId("cancellation-status")
						.getAttribute("data-status")) === "confirmed",
					"confirmed",
				);
				assert(
					(await page
						.getByTestId("engine-state")
						.getAttribute("data-state")) === "cancelled",
					"engine cancelled",
				);
				await shot(page, "31-cancelled", S);
			},
		);

		await step(
			"hub restart mid-execution → interrupted, never re-run automatically",
			async () => {
				await submitNew(page, env, "Rebuild the search index", "impl_hangs");
				ids.G = await taskIdFromUrl(page);
				await approveGate1(page, /Execution approval · Rebuild the search/);
				await openTask(page, env, "Rebuild the search index");
				await waitFor(
					async () =>
						(await page
							.getByTestId("engine-state")
							.getAttribute("data-state")) === "executing",
					"executing",
					60_000,
				);
				await env.restartHub();
				await page
					.getByRole("heading", { name: "Operator sign-in" })
					.waitFor({ timeout: 15_000 });
				await signIn(page, env.credential, env);
				await openTask(page, env, "Rebuild the search index");
				await waitFor(
					async () =>
						["interrupted", "cancelled", "blocked", "failed"].includes(
							(await page
								.getByTestId("engine-state")
								.getAttribute("data-state")) ?? "",
						),
					"engine settled after restart",
					60_000,
				);
				const engineState = await page
					.getByTestId("engine-state")
					.getAttribute("data-state");
				await waitFor(
					async () =>
						(await stageText(page)) !== "Queued" &&
						(await stageText(page)) !== "Implementing",
					"stage settled",
					45_000,
				);
				const stage = await stageText(page);
				const runsBefore = (await apiGet<Detail>(page, `/tasks/${ids.G}`)).body
					.runs.length;
				await sleep(5_000);
				const runsAfter = (await apiGet<Detail>(page, `/tasks/${ids.G}`)).body
					.runs.length;
				notes.push(
					`restart mid-run: engine=${engineState} stage="${stage}" attempts ${runsBefore}→${runsAfter}`,
				);
				assert(
					engineState === "interrupted",
					`engine interrupted (got ${engineState})`,
				);
				assert(
					stage === "Interrupted",
					`stage reads Interrupted (got ${stage})`,
				);
				assert(runsAfter === runsBefore, "no automatic relaunch");
				assert(
					(await page
						.getByRole("button", { name: "Request a new run" })
						.count()) === 1,
					"a new run needs a new Gate 1",
				);
				await shot(page, "32-interrupted-after-restart", S);
			},
		);
		await page.context().close();

		const small = await newPage(browser, env, 1280, 800);
		await step(
			"1280×800: accepted, Gate-2 attempt-2 document, tamper, interrupted",
			async () => {
				const S2 = "1280x800";
				await small.page.goto(`${env.uiUrl}/#/projects`);
				await signIn(small.page, env.credential, env);
				await openTask(small.page, env, "Add retry to webhook sender");
				await shot(small.page, "33-accepted", S2);
				await openTask(small.page, env, "Harden webhook signature check");
				await openGate2(small.page);
				await shot(small.page, "34-hq-gate2-attempt2", S2);
				await openTask(small.page, env, "Speed up the import step");
				await shot(small.page, "35-tamper-task-panel", S2);
				await openTask(small.page, env, "Rebuild the search index");
				await shot(small.page, "36-interrupted", S2);
			},
		);
		await small.context.close();
	} finally {
		await env.stop();
	}

	// short challenge TTL: expiry clears the signature; a fresh challenge then works
	const ttlEnv = await startWorkspaceEnv({ auth: { challenge_ttl_ms: 2_000 } });
	state.secrets = [ttlEnv.credential];
	try {
		const { page } = await newPage(browser, ttlEnv, 1440, 900);
		await step(
			"challenge TTL 2 s: expiry clears the signature; a fresh one approves",
			async () => {
				await page.goto(`${ttlEnv.uiUrl}/#/projects`);
				await signIn(page, ttlEnv.credential, ttlEnv);
				await submitNew(page, ttlEnv, "Expire the approval window");
				await openRequest(page, /Execution approval · Expire the approval/);
				const sig = page.getByLabel("Type Edward to approve execution");
				const approve = page.getByRole("button", { name: "Approve execution" });
				await sig.pressSequentially("Edward");
				await waitFor(
					async () => !(await approve.isDisabled()),
					"challenge ready",
				);
				await waitFor(
					async () => (await sig.inputValue()) === "",
					"signature cleared at expiry",
					15_000,
				);
				assert(await approve.isDisabled(), "approve disabled after expiry");
				assert(
					(await page.getByText(/approval window expired/).count()) >= 1,
					"expiry notice",
				);
				assert(
					(await region(page, "Approval document").getAttribute(
						"data-request-status",
					)) === "pending",
					"still pending",
				);
				await shot(page, "37-challenge-expired", "1440x900");
				await sig.pressSequentially("Edward");
				await waitFor(
					async () => !(await approve.isDisabled()),
					"fresh challenge ready",
				);
				await approve.click();
				await waitFor(
					async () =>
						(await textOf(decisionStatus(page))).includes("Execution approved"),
					"approved with a fresh challenge",
				);
			},
		);
		await page.context().close();
	} finally {
		await browser.close();
		await ttlEnv.stop();
	}
	finish(
		"HUB (isolated real test hub, simulated, fake providers): part 2 (Gate 2 and recovery)",
		version,
	);
}

await main();
