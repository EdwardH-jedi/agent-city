// Real isolated test-hub run of the workspace UI (role 07, M1C part 1; HUB evidence, dev tool):
// sign-in, drafts, Gate 1 (lost responses), monitoring, cancel, reload, restart, read-only.
//
//   …/iso/run.sh env PLAYWRIGHT_BROWSERS_PATH=/Users/edwardhwang/Library/Caches/ms-playwright \
//     bun --no-env-file apps/web/src/workspace-m1/dev/hub-run.ts
//
// See hub-kit.ts for the isolation and secret rules.
import { chromium, type Route } from "playwright-core";
import {
	apiGet,
	assert,
	compose,
	decisionBodies,
	finish,
	newPage,
	notes,
	openRepo,
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
	waitFor,
} from "./hub-kit.ts";

async function main() {
	const env = await startWorkspaceEnv({ readOnly: true });
	state.secrets = [env.credential, env.readOnlyCredential ?? ""];
	const browser = await chromium.launch({ headless: true });
	const version = browser.version();
	const ids: Record<string, string> = {};
	try {
		const { context, page } = await newPage(browser, env, 1440, 900);
		const S = "1440x900";

		await step(
			"sign-in: wrong credential refused, correct one signs in; cookie attributes",
			async () => {
				await page.goto(`${env.uiUrl}/#/projects`);
				await page.getByRole("heading", { name: "Operator sign-in" }).waitFor();
				assert(
					(await page.getByTestId("provenance").getAttribute("data-source")) ===
						"hub",
					"provenance hub",
				);
				await page
					.getByLabel("Operator credential")
					.fill(`wrong-${"x".repeat(26)}`);
				await page.getByRole("button", { name: "Sign in" }).click();
				await waitFor(
					async () =>
						(await textOf(page.getByRole("alert"))).includes("Sign-in failed"),
					"refusal",
				);
				assert(
					(await page.getByText("Signed in as").count()) === 0,
					"no data after a wrong credential",
				);
				await signIn(page, env.credential, env);
				const cookies = await context.cookies(
					`${env.uiUrl}/api/workspace/session`,
				);
				const c = cookies.find((x) => x.name === "agentcity_ws_session");
				assert(
					c,
					"session cookie stored by the browser over http loopback (N-7)",
				);
				state.secrets.push(c.value);
				notes.push(
					`cookie ${c.name}: httpOnly=${c.httpOnly} sameSite=${c.sameSite} secure=${c.secure} path=${c.path}`,
				);
				assert(
					c.httpOnly && c.sameSite === "Strict" && !c.secure,
					"HttpOnly, SameSite=Strict, no Secure on http",
				);
				const sess = await apiGet<{ csrf_token: string }>(page, "/session");
				state.secrets.push(sess.body.csrf_token); // checked absent from DOM / URL / storage, never printed
				const docCookie = await page.evaluate(() => document.cookie);
				assert(
					!docCookie.includes("agentcity_ws_session"),
					"cookie not readable from JS",
				);
				await shot(page, "01-signed-in", S);
			},
		);

		await step(
			"draft: create, save, edit with commas, reload from the server",
			async () => {
				await compose(
					page,
					env,
					"Add retry to webhook sender",
					"Build passes, lint passes\nDocs updated, with one example\nNo change outside src/, tests/",
				);
				await page.getByRole("button", { name: "Save draft" }).click();
				await waitFor(
					async () =>
						(
							await textOf(page.getByRole("status", { name: "Save status" }))
						).includes("Draft saved"),
					"Draft saved",
				);
				const li = page
					.getByRole("list", { name: "Acceptance criteria" })
					.getByRole("listitem");
				await waitFor(async () => (await li.count()) === 3, "3 criteria");
				ids.A = await taskIdFromUrl(page);
				assert(ids.A.startsWith("wst-"), "task id in URL");
				const crit = page.getByRole("textbox", { name: "Acceptance criteria" });
				await crit.fill(`${await crit.inputValue()}\nChangelog entry, short`);
				await page
					.getByLabel("Objective", { exact: true })
					.fill("Retry failed webhook deliveries with bounded backoff, twice.");
				await page.getByRole("button", { name: "Save draft" }).click();
				await waitFor(
					async () => (await li.count()) === 4,
					"4 criteria after edit",
				);
				await page.reload();
				await waitFor(
					async () =>
						(await textOf(page.locator("#wsm1-panel-title"))).includes(
							"Add retry",
						),
					"task restored after reload",
				);
				const after = page
					.getByRole("list", { name: "Acceptance criteria" })
					.getByRole("listitem");
				await waitFor(
					async () => (await after.count()) === 4,
					"4 criteria after reload",
				);
				const texts = await after.allTextContents();
				assert(
					JSON.stringify(texts) ===
						JSON.stringify([
							"Build passes, lint passes",
							"Docs updated, with one example",
							"No change outside src/, tests/",
							"Changelog entry, short",
						]),
					`criteria verbatim after reload: ${JSON.stringify(texts)}`,
				);
				await shot(page, "02-draft-reloaded", S);
			},
		);

		await step("submit → Gate 1 pending; nothing executes", async () => {
			await page
				.getByRole("button", { name: "Submit for run approval" })
				.click();
			await waitFor(
				async () =>
					(await textOf(page.getByTestId("current-stage"))) ===
					"Awaiting execution approval",
				"awaiting approval",
			);
			await waitFor(
				async () =>
					(await textOf(page.getByTestId("hq-pending-count"))) === "1",
				"pending count 1",
			);
			assert(
				(await page.getByTestId("execution-id").count()) === 0,
				"no execution before Gate 1",
			);
			assert(
				(await page.getByTestId("engine-state").getAttribute("data-state")) ===
					"draft",
				"engine reserved draft",
			);
			await shot(page, "03-submitted", S);
		});

		await step(
			"Gate 1: Enter inert; lost request → 'outcome unknown' → same bytes retried → approved once",
			async () => {
				await openRequest(page, /Execution approval · Add retry/);
				const doc = region(page, "Approval document");
				assert(
					(await doc.getAttribute("data-gate")) === "execution",
					"gate execution",
				);
				const sig = page.getByLabel("Type Edward to approve execution");
				const approve = page.getByRole("button", { name: "Approve execution" });
				assert(
					(await sig.inputValue()) === "" && (await approve.isDisabled()),
					"empty + disabled on arrival",
				);
				await sig.pressSequentially("Edward");
				await waitFor(
					async () => !(await approve.isDisabled()),
					"approve enabled (challenge ready)",
				);
				const before = decisionBodies.length;
				await sig.press("Enter");
				await sig.press("Control+Enter");
				await sleep(500);
				assert(decisionBodies.length === before, "Enter sent no decision");
				let armed = true;
				await page.route(
					"**/api/workspace/approval-requests/*/decisions",
					async (route) => {
						if (armed) {
							armed = false;
							await route.abort("connectionreset"); // never reaches the hub
						} else await route.continue();
					},
				);
				await approve.click();
				const status = page.getByRole("status", { name: "Decision status" });
				await waitFor(
					async () =>
						(await textOf(status)).includes("Decision outcome unknown"),
					"outcome unknown",
				);
				assert(
					(await sig.inputValue()) === "",
					"signature cleared on unknown outcome",
				);
				await shot(page, "04-gate1-outcome-unknown", S);
				await page
					.getByRole("button", { name: "Check decision outcome" })
					.click();
				await waitFor(
					async () => (await textOf(status)).includes("Execution approved"),
					"approved after retry",
				);
				await page.unroute("**/api/workspace/approval-requests/*/decisions");
				await waitFor(
					async () =>
						(await textOf(region(page, "Approval document"))).includes(
							"Approved: exactly one bounded",
						),
					"approved Gate-1 note (L-3)",
				);
				assert(
					!(await textOf(region(page, "Approval document"))).includes(
						"Nothing has run yet",
					),
					"no 'Nothing has run yet' after approval (L-3)",
				);
				const sent = decisionBodies.slice(before);
				assert(sent.length === 2, `two sends (got ${sent.length})`);
				assert(
					sent[0] === sent[1],
					"the retry resent byte-identical body (same key, rev, challenge)",
				);
				notes.push("Gate-1 retry: 2 POSTs, bodies byte-identical: true");
				const d = await apiGet<{
					decisions: unknown[];
					task: { stage: string };
				}>(page, `/tasks/${ids.A}`);
				assert(
					d.body.decisions.length === 1 &&
						["queued", "running", "awaiting_acceptance"].includes(
							d.body.task.stage,
						),
					`server: 1 decision, execution queued or later (${d.body.task.stage})`,
				);
				await waitFor(
					async () =>
						(await page.locator("li[data-decision-id]").count()) === 1,
					"history entry",
				);
				await shot(page, "05-gate1-approved", S);
			},
		);

		await step(
			"monitoring until engine human_ready; no acceptance before a result request",
			async () => {
				await openTask(page, env, "Add retry to webhook sender");
				const seen: string[] = [];
				await waitFor(
					async () => {
						const s =
							(await page
								.getByTestId("engine-state")
								.getAttribute("data-state")) ?? "";
						if (seen.at(-1) !== s) seen.push(s);
						return s === "human_ready" || s === "failed" || s === "blocked";
					},
					"engine end state",
					120_000,
				);
				notes.push(`engine states observed (task A): ${seen.join(" → ")}`);
				assert(seen.at(-1) === "human_ready", `engine ended ${seen.at(-1)}`);
				assert(
					(await page.getByTestId("execution-id").count()) === 1,
					"execution id shown",
				);
				assert(
					(await page
						.getByTestId("attempt-id")
						.getAttribute("data-attempt-number")) === "1",
					"attempt 1",
				);
				const acc = await page
					.getByTestId("acceptance-status")
					.getAttribute("data-status");
				const pendingResult = await page
					.getByRole("button", { name: "Open result acceptance" })
					.count();
				const stage = await textOf(page.getByTestId("current-stage"));
				notes.push(
					`at human_ready: stage="${stage}", acceptance=${acc}, result button=${pendingResult}`,
				);
				if (pendingResult === 0) {
					assert(acc === "none", "acceptance none without a result request");
					assert(
						(await page.getByText(/not open for acceptance/).count()) >= 1,
						"truthful note shown",
					);
				}
				assert(
					(await page
						.getByRole("button", { name: "Accept result" })
						.count()) === 0,
					"no Accept control in the task panel",
				);
				await shot(page, "06-engine-human-ready", S);
				const ev = region(page, "Evidence");
				const buttons = ev.getByRole("button");
				const n = await buttons.count();
				notes.push(`evidence items listed: ${n}`);
				if (n > 0) {
					const first = buttons.first();
					const name = await textOf(first);
					const openerId = await first.getAttribute("id");
					await first.click();
					const dialog = page.getByRole("dialog", {
						name: `Evidence: ${name}`,
					});
					await waitFor(
						async () =>
							["ok", "error"].includes(
								(await dialog.getAttribute("data-state")) ?? "",
							),
						"viewer settled",
					);
					notes.push(
						`viewer ${name}: data-state=${await dialog.getAttribute("data-state")}`,
					);
					await shot(page, "07-evidence-viewer", S);
					await page.keyboard.press("Escape");
					await waitFor(
						async () => (await dialog.count()) === 0,
						"viewer closed",
					);
					assert(
						(await page.evaluate(() => document.activeElement?.id)) ===
							openerId,
						"focus back to opener",
					);
				}
			},
		);

		await step(
			"Gate 1 request changes with the answer lost after commit → reconciled, one POST; v2 resubmitted",
			async () => {
				await submitNew(page, env, "Tighten config validation");
				ids.B = await taskIdFromUrl(page);
				await openRequest(page, /Execution approval · Tighten config/);
				await page
					.getByLabel("Decision reason")
					.fill("Name the rejected key in the error, please.");
				const rc = page.getByRole("button", { name: "Request changes" });
				await waitFor(
					async () => !(await rc.isDisabled()),
					"request changes enabled",
				);
				const before = decisionBodies.length;
				let armed = true;
				await page.route(
					"**/api/workspace/approval-requests/*/decisions",
					async (route) => {
						if (armed) {
							armed = false;
							await route.fetch(); // the hub commits
							await route.abort("connectionreset"); // the answer is lost
						} else await route.continue();
					},
				);
				await rc.click();
				const status = page.getByRole("status", { name: "Decision status" });
				await waitFor(
					async () => (await textOf(status)).includes("Changes requested"),
					"reconciled from the read",
				);
				await page.unroute("**/api/workspace/approval-requests/*/decisions");
				assert(
					decisionBodies.length - before === 1,
					`one POST (got ${decisionBodies.length - before})`,
				);
				await shot(page, "08-gate1-changes-requested", S);
				await openTask(page, env, "Tighten config validation");
				await waitFor(
					async () =>
						(await textOf(page.getByTestId("current-stage"))) ===
						"Changes requested",
					"stage changes requested",
				);
				const crit = page.getByRole("textbox", { name: "Acceptance criteria" });
				await crit.fill(
					`${await crit.inputValue()}\nThe rejected key is named, with its path`,
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
					async () =>
						(await textOf(page.getByTestId("current-stage"))) ===
						"Awaiting execution approval",
					"new Gate 1",
				);
			},
		);

		await step("Gate 1 reject → closed; nothing queued", async () => {
			await submitNew(page, env, "Rename legacy flags");
			assert(
				(await page.getByText(/Editing the draft/).count()) === 0,
				"compose → submit shows the proposal, not the editor (L-2)",
			);
			assert(
				(await page.getByRole("heading", { name: "Proposal v1" }).count()) ===
					1,
				"Proposal v1 shown (L-2)",
			);
			ids.C = await taskIdFromUrl(page);
			await openRequest(page, /Execution approval · Rename legacy/);
			await page
				.getByLabel("Decision reason")
				.fill("Out of scope for this quarter.");
			const rj = page.getByRole("button", { name: "Reject" });
			await waitFor(async () => !(await rj.isDisabled()), "reject enabled");
			await rj.click();
			await waitFor(
				async () =>
					(
						await textOf(page.getByRole("status", { name: "Decision status" }))
					).includes("Execution rejected"),
				"rejected",
			);
			await openTask(page, env, "Rename legacy flags");
			await waitFor(
				async () =>
					(await textOf(page.getByTestId("current-stage"))) === "Rejected",
				"stage rejected",
			);
			assert(
				(await page.getByTestId("execution-id").count()) === 0,
				"no execution after reject",
			);
			assert(
				(await page.getByText(/This task is closed/).count()) >= 1,
				"reads as closed",
			);
			await shot(page, "09-gate1-rejected", S);
		});

		await step(
			"cancel (impl_hangs): requested while executing, confirmed after termination",
			async () => {
				await submitNew(page, env, "Stop the long import job", "impl_hangs");
				ids.D = await taskIdFromUrl(page);
				await openRequest(page, /Execution approval · Stop the long/);
				const sig = page.getByLabel("Type Edward to approve execution");
				await sig.pressSequentially("Edward");
				const approve = page.getByRole("button", { name: "Approve execution" });
				await waitFor(
					async () => !(await approve.isDisabled()),
					"approve enabled",
				);
				await approve.click();
				await waitFor(
					async () =>
						(
							await textOf(
								page.getByRole("status", { name: "Decision status" }),
							)
						).includes("Execution approved"),
					"approved",
				);
				await openTask(page, env, "Stop the long import job");
				await waitFor(
					async () =>
						(await page
							.getByTestId("engine-state")
							.getAttribute("data-state")) === "executing",
					"engine executing",
					60_000,
				);
				await page.getByRole("button", { name: "Cancel execution" }).click();
				await waitFor(
					async () =>
						(await page.getByTestId("cancellation-status").count()) === 1,
					"cancellation status shown",
				);
				const first = await page
					.getByTestId("cancellation-status")
					.getAttribute("data-status");
				const engineThen = await page
					.getByTestId("engine-state")
					.getAttribute("data-state");
				notes.push(`cancel: first status=${first} with engine=${engineThen}`);
				if (first === "requested") await shot(page, "10-cancel-requested", S);
				await waitFor(
					async () =>
						(await page
							.getByTestId("cancellation-status")
							.getAttribute("data-status")) === "confirmed",
					"cancellation confirmed",
					60_000,
				);
				assert(
					(await page
						.getByTestId("engine-state")
						.getAttribute("data-state")) === "cancelled",
					"engine cancelled",
				);
				notes.push(
					`cancel: confirmed; stage="${await textOf(page.getByTestId("current-stage"))}"`,
				);
				await shot(page, "11-cancel-confirmed", S);
			},
		);

		await step(
			"reload mid-flow: typed signature is not restored; request stays pending",
			async () => {
				await submitNew(page, env, "Document local setup");
				ids.E = await taskIdFromUrl(page);
				await openRequest(page, /Execution approval · Document local/);
				await page
					.getByLabel("Type Edward to approve execution")
					.pressSequentially("Edward");
				await sleep(400);
				await page.reload();
				await waitFor(
					async () =>
						(await region(page, "Approval document").getAttribute(
							"data-request-status",
						)) === "pending",
					"still pending after reload",
				);
				assert(
					(await page
						.getByLabel("Type Edward to approve execution")
						.inputValue()) === "",
					"signature empty after reload",
				);
				assert(
					await page
						.getByRole("button", { name: "Approve execution" })
						.isDisabled(),
					"approve disabled after reload",
				);
				await shot(page, "12-reload-mid-gate", S);
			},
		);

		await step(
			"restartHub → session ends → re-sign-in → state rebuilt from the server",
			async () => {
				// the bridge reconciles asynchronously: let A's Gate-2 request settle first
				await waitFor(
					async () => {
						const snap = await apiGet<{
							pending_requests: { kind: string; workspace_task_id: string }[];
						}>(page, "/snapshot");
						return snap.body.pending_requests.some(
							(r) => r.kind === "result" && r.workspace_task_id === ids.A,
						);
					},
					"A's result request before the restart",
					45_000,
				);
				const before = await apiGet<{
					tasks: { task: { id: string; stage: string; rev: number } }[];
					pending_requests: { id: string }[];
				}>(page, "/snapshot");
				await env.restartHub();
				await page
					.getByRole("heading", { name: "Operator sign-in" })
					.waitFor({ timeout: 15_000 });
				assert(
					(await page.getByText(/session ended/i).count()) >= 1,
					"says the session ended",
				);
				await shot(page, "13-after-restart-signin", S);
				await signIn(page, env.credential, env);
				const after = await apiGet<typeof before.body>(page, "/snapshot");
				const sig = (s: typeof before.body) =>
					JSON.stringify({
						tasks: s.tasks.map((t) => [t.task.id, t.task.stage]).sort(),
						pending: s.pending_requests.map((r) => r.id).sort(),
					});
				assert(
					sig(before.body) === sig(after.body),
					"same tasks, stages and pending requests after restart",
				);
				await waitFor(
					async () =>
						(await textOf(page.getByTestId("hq-pending-count"))) ===
						String(after.body.pending_requests.length),
					"pending count rebuilt",
				);
				await openTask(page, env, "Add retry to webhook sender");
				await waitFor(
					async () =>
						(await page
							.getByTestId("engine-state")
							.getAttribute("data-state")) === "human_ready",
					"run state rebuilt (human_ready)",
				);
				await openTask(page, env, "Document local setup");
				const li = page
					.getByRole("list", { name: "Acceptance criteria" })
					.getByRole("listitem");
				await waitFor(
					async () => (await li.count()) === 2,
					"draft/proposal rebuilt",
				);
				await openRequest(page, /Execution approval · Tighten config/);
				await waitFor(
					async () =>
						(await textOf(page.getByTestId("proposal-version"))) === "2",
					"v2 request rebuilt",
				);
				await waitFor(
					async () =>
						(await page.locator("li[data-decision-id]").count()) === 1,
					"decision history rebuilt",
				);
				await shot(page, "14-after-restart-rebuilt", S);
			},
		);
		await context.close();

		const f1 = await newPage(browser, env, 1440, 900);
		await step(
			"F-1: a late 401 of the old session never breaks writes in the new one",
			async () => {
				const p = f1.page;
				await p.goto(`${env.uiUrl}/#/projects`);
				await signIn(p, env.credential, env);
				const holder: { route: Route | null } = { route: null };
				await p.route("**/api/workspace/snapshot", async (route) => {
					if (holder.route === null)
						holder.route = route; // hold one poll of the old session
					else await route.continue();
				});
				await waitFor(
					async () => holder.route !== null,
					"a snapshot request held",
					10_000,
				);
				const del = p.waitForResponse(
					(r) =>
						r.request().method() === "DELETE" &&
						r.url().includes("/api/workspace/session"),
				);
				await p.getByRole("button", { name: "Sign out" }).click();
				notes.push(`F-1: first DELETE /session → ${(await del).status()}`);
				await signIn(p, env.credential, env);
				await holder.route?.fulfill({
					status: 401,
					contentType: "application/json",
					body: JSON.stringify({
						error: "unauthenticated",
						message: "held from the old session",
					}),
				});
				await sleep(500);
				assert(
					await p.getByText("Signed in as operator:edward").isVisible(),
					"still signed in after the late 401",
				);
				await compose(
					p,
					env,
					"Late 401 does not break writes",
					"Saving works, after a late 401",
				);
				await p.getByRole("button", { name: "Save draft" }).click();
				await waitFor(
					async () =>
						(
							await textOf(p.getByRole("status", { name: "Save status" }))
						).includes("Draft saved"),
					"Draft saved in the new session",
				);
				const del2 = p.waitForResponse(
					(r) =>
						r.request().method() === "DELETE" &&
						r.url().includes("/api/workspace/session"),
				);
				await p.getByRole("button", { name: "Sign out" }).click();
				const del2Status = (await del2).status();
				notes.push(`F-1: second DELETE /session → ${del2Status}`);
				assert(
					del2Status === 204,
					`sign-out confirmed by the hub (${del2Status})`,
				);
				await p.getByText("Signed out.").waitFor();
				await p.unroute("**/api/workspace/snapshot");
			},
		);
		await step(
			"L-4: an unknown task deep link is explained and the URL normalized in place",
			async () => {
				const p = f1.page;
				await signIn(p, env.credential, env);
				const ghost = "wst-00000000-0000-4000-8000-0000000fffff";
				const repo = encodeURIComponent(env.repoId);
				await p.evaluate((h) => {
					location.hash = h;
				}, `#/projects/${repo}/${ghost}`);
				await waitFor(
					async () =>
						(await p.evaluate(() => location.hash)) === `#/projects/${repo}`,
					"hash normalized",
				);
				await p.getByText(/That task does not exist/).waitFor();
				const before = await p.evaluate(() => history.length);
				await sleep(2_500); // a poll later: no loop, no extra history entries
				assert(
					(await p.evaluate(() => history.length)) === before,
					"no history loop",
				);
				assert(
					(await p.evaluate(() => location.hash)) === `#/projects/${repo}`,
					"hash stays normalized",
				);
				await shot(p, "15b-unknown-deep-link", "1440x900");
			},
		);
		await f1.context.close();

		const ro = await newPage(browser, env, 1440, 900);
		await step(
			"read-only principal sees data but no enabled mutation",
			async () => {
				assert(env.readOnlyCredential, "read-only principal configured");
				await ro.page.goto(`${env.uiUrl}/#/projects`);
				await signIn(ro.page, env.readOnlyCredential, env);
				await openRepo(ro.page, env);
				assert(
					await ro.page
						.getByRole("button", { name: "Assign work" })
						.isDisabled(),
					"Assign work disabled",
				);
				await openTask(ro.page, env, "Document local setup");
				assert(
					await ro.page
						.getByRole("button", { name: "Edit draft" })
						.isDisabled(),
					"Edit draft disabled",
				);
				await openRequest(ro.page, /Execution approval · Document local/);
				const sig = ro.page.getByLabel("Type Edward to approve execution");
				assert(await sig.isDisabled(), "signature disabled");
				assert(
					await ro.page
						.getByRole("button", { name: "Approve execution" })
						.isDisabled(),
					"approve disabled",
				);
				assert(
					await ro.page.getByRole("button", { name: "Reject" }).isDisabled(),
					"reject disabled",
				);
				assert(
					(await ro.page
						.getByText("This session may read but not decide.")
						.count()) >= 1,
					"reason shown",
				);
				await shot(ro.page, "15-read-only", "1440x900");
			},
		);
		await ro.context.close();

		const small = await newPage(browser, env, 1280, 800);
		await step(
			"1280×800: projects, HQ document, cancelled and rejected tasks",
			async () => {
				const S2 = "1280x800";
				await small.page.goto(`${env.uiUrl}/#/projects`);
				await signIn(small.page, env.credential, env);
				await openTask(small.page, env, "Add retry to webhook sender");
				await shot(small.page, "16-engine-human-ready", S2);
				await openRequest(small.page, /Execution approval · Document local/);
				await shot(small.page, "17-hq-gate1", S2);
				await openTask(small.page, env, "Stop the long import job");
				await shot(small.page, "18-cancel-confirmed", S2);
				await openTask(small.page, env, "Rename legacy flags");
				await shot(small.page, "19-rejected", S2);
			},
		);
		await small.context.close();
	} finally {
		await browser.close();
		await env.stop();
	}
	finish(
		"HUB (isolated real test hub, simulated, fake providers): part 1",
		version,
	);
}

await main();
