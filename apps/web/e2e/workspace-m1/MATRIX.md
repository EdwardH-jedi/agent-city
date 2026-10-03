# Agent City M1 — independent browser QA matrix (role 09)

| Item | Value |
| --- | --- |
| Status | Designed 2026-10-02, then **executed** on the integrated M1 diff the same day by `hub.suite.ts` (HUB set) and `fx.suite.ts` (FX set) in this directory. Each suite writes its per-case results to `results.json` in its TMPDIR evidence directory. The results summary was delivered to the lead in role 09's handback. |
| Owner | Role 09 (independent browser QA). Writes only under `apps/web/e2e/workspace-m1/`. |
| Inputs | `SHARED_M1_SPEC.md`, `09_BROWSER_QA.md`, `07_FRONTEND.md`, `docs/workspace-m1/OWNERSHIP.md`, SOL design §C, §D, §E, §H (read-only), `apps/web/e2e/browser-gate.ts` (isolation pattern). |
| Frozen contracts | Not available yet (`packages/schema/src/workspace-m1/` is absent). DTO field names used here (`idempotency_key`, `decision_id`, `binding_hash`, `challenge`, request/acceptance status values) are SOL §C placeholders. The final names come from the frozen `INTERFACE.md`. |
| Date | 2026-10-02 |

## 0. How to read this matrix

- **IDs are stable** and never renumbered. A dropped case is marked *retired*. Prefixes: `BRW-J` journeys,
  `BRW-R` race/uncertainty, `BRW-P` persistence, `BRW-A` accessibility/layout, `BRW-S` browser-visible
  security hygiene. Checkpoints inside a case are `C1…Cn`.
- **Set** column: `FX` = fixture transport (UI fixture, no backend), `HUB` = isolated real test hub,
  `FX+HUB` = run in both, and the HUB run decides. See §6.
- **Trace** column: `M1-xx` = SOL §H acceptance row, `Dn` = SOL §D daily journey n, `SPEC` = shared spec.
- **Result vocabulary** (for the later `RESULTS.md`): `PASS`, `FAIL`, `NOT RUN` (with reason), `BLOCKED`
  (a needed seam or ruling from §9 is missing). Passes are never inferred or carried over from another set.
- Locator notation refers to the DOM contract in §7: `button "Approve execution"` = role + exact
  accessible name; `region "Task detail"` = `section[aria-label]`; `#engine-state` = `data-testid`.
- **DB cross-checks** read the in-process test hub's temp SQLite read-only (same process, as the existing
  gate does with `getTask`/`listArtifacts`). They never touch a real database.

### Global assertions (G) — checked during every HUB case

| ID | Assertion |
| --- | --- |
| G-1 | The browser makes no request to `:4317` and none to any host other than this run's Vite origin. The context-level route guard aborts the request and fails the case. |
| G-2 | No unexpected `console.error` / `pageerror`. Only provoked statuses (401/409/aborts the case itself causes) are allowlisted, as in `browser-gate.ts`. |
| G-3 | The operator credential, session cookie value, CSRF value and challenge value never appear in DOM text or attributes, the URL, `localStorage`/`sessionStorage`/IndexedDB, console output or screenshots. |
| G-4 | No signature text survives a subject, gate or session change (see R-19…R-22). |
| G-5 | Zero live provider launches, read from whatever in-process counter the bridge exposes (§9 N-14). If no counter is exposed this assertion is NOT RUN and deferred to role 08. |
| G-6 | After every Gate-2 transition, the language audit from J-17 passes. |

## 1. Journey matrix (BRW-J)

### BRW-J-01 — full happy path (FX+HUB · M1-01, M1-02, M1-03, D1, D2, SPEC)

Setup: the one allowlisted fixture repo with scenario `approve` and repair policy *No automatic repair*.
Screenshots are taken at C3, C7, C11, C13 and C14, at 1440×900 here and at 1280×800 in A-10.

| # | Step | Decisive expected result |
| --- | --- | --- |
| C1 | HUB: sign in with the runtime-generated test operator credential. | Text "Signed in as operator:edward". `#provenance[data-source=hub][data-mode=simulated]`. Connection status shows a fresh time. |
| C2 | Activate the fixture repo button in region "Repositories". | The workspace opens synchronously: the repo button has `aria-current="true"`, and region "Tasks" and `button "Assign work"` are visible with no wait for any scene. |
| C3 | `Assign work` → fill Title, Objective and Acceptance criteria with 3 lines that contain commas (`Build passes, lint passes` / `Docs updated, with one example` / `No change outside src/, tests/`). | The fields keep their text and the criteria textarea keeps the newlines. Repair policy defaults to "No automatic repair". |
| C4 | `Save draft`. | Status "Save status" shows "Draft saved". The criteria list renders exactly 3 `li` items, verbatim and in order. |
| C5 | Edit the draft (change the objective and add a 4th criterion with a comma) → `Save draft` → **reload**. | After the reload the edited content comes back from the backend, with 4 criteria verbatim (see P-01 for proof in a fresh context). |
| C6 | `Submit for run approval`. | `#current-stage` = "Awaiting execution approval". No execution exists yet (`#execution-id` absent, or no engine state past `draft`). `#hq-pending-count` goes up by 1. After ≥ 2 poll intervals, still no queued/executing stage. DB: 0 executions queued and 0 attempts. |
| C7 | Navigate to `Headquarters` → activate the inbox item "Execution approval · <title>". | `region "Approval document"[data-gate=execution]`. It shows the objective, the 4 criteria verbatim, scope/base, check plan, providers, repair allowance 0, limits and risks. `#proposal-version` equals the task's. |
| C8 | Check the signature field `"Type Edward to approve execution"`. Type `Edward` key by key, then press Enter. | The field is empty on arrival and `Approve execution` is disabled. After typing, the button is enabled. Enter sends **zero** decision POSTs (network log). |
| C9 | Click `Approve execution` once. | "Decision status" shows that execution is approved. The field is emptied, and the controls on this request are disabled or removed. The inbox item leaves the pending list and the count goes down by 1. "Decision history" gains an item: operator:edward · execution · approve · version N. DB: 1 decision, 1 queued execution. |
| C10 | Go back to the task. | Stage text moves forward (at least one active stage, then the final one). `#execution-id` and `#attempt-id[data-attempt-number=1]` are present, and "Task status" announces the changes. |
| C11 | Wait for engine completion. | `#engine-state[data-state=human_ready]`, `#current-stage` = "Awaiting acceptance", and `#acceptance-status[data-status=pending]` (**not** accepted). A new inbox item "Result acceptance · <title>" appears and the count goes up by 1. |
| C12 | Inspect the evidence: open every item in region "Evidence" (diff, verification log(s), review, manifest). | Each viewer shows inert text with its attempt and candidate. The candidate equals `#candidate-sha`, `#evidence-status[data-status=verified]`, verification results are shown per criterion, and the review verdict is approve with no blocker. |
| C13 | Open the result request in HQ. | `[data-gate=result]`. The candidate SHA, attempt and manifest/envelope identity equal the task panel and the DB. The field `"Type Edward to accept this result"` is **empty** (nothing carried over from Gate 1), and `Accept result` is disabled. |
| C14 | Type `Edward` → click `Accept result`. | `#acceptance-status[data-status=accepted]`. `#engine-state[data-state=human_ready]` is **unchanged** (the engine meaning is preserved). History gains: operator:edward · result · accept. The field is emptied and the count is back to 0. |
| C15 | Language audit (J-17). | Passes. |
| C16 | DB cross-check. | Exactly 1 execution for the proposal, 1 Gate-1 decision and 1 Gate-2 decision. The accepted candidate equals the displayed candidate. Nothing records a merge, push or deploy. |

### BRW-J-02 … J-22

| ID | Journey and steps | Decisive expected result | Set | Trace |
| --- | --- | --- | --- | --- |
| BRW-J-02 | Criteria fidelity. Enter the lines `a, b and c` / `  leading spaces` / `unicode — café, ok` / *(blank line)* / a 300-character line with commas. Save, submit, view in HQ, reload. | One criterion per non-blank line. Commas never split a criterion. Order is preserved. The rendering is identical in the task panel, the HQ document and after reload. Blank-line and trim behaviour matches the frozen contract (N-9). | FX+HUB | D1, SPEC |
| BRW-J-03 | Edit after submission. Submit v1 → Gate-1 request pending → in HQ type `Edward` without clicking → in the workspace, edit the draft and resubmit (v2). | The v1 request shows Invalidated (reason: proposal changed), its controls are disabled and its field is emptied. Only v2 has a pending request (net count still 1). A stale Approve click, if still rendered, shows an error. DB: nothing queued for v1. | HUB (FX render) | M1-03, M1-04 |
| BRW-J-04 | Gate-1 Request changes: fill "Decision reason" → `Request changes` (no signature needed). | The request goes to changes-requested and no execution or attempt is created. The task returns to an editable draft linked to its predecessor. Resubmitting creates a **new** Gate-1 request on a new proposal version. The old request stays in history. | FX+HUB | M1-06, D3 |
| BRW-J-05 | Gate-1 Reject with a reason. | The request is rejected. Nothing is queued (no `#execution-id` ever appears) and the phase reads Rejected. That request offers no Approve any more. History gains an entry. DB: 0 executions. | FX+HUB | M1-06 |
| BRW-J-06 | Gate-2 Request changes (from J-01 C13) with a reason. | `#acceptance-status[data-status=changes_requested]` while `#engine-state` stays `human_ready`, never accepted. A linked new draft appears (predecessor link, optional seed candidate shown). No new execution exists until that draft is submitted **and** a new Gate-1 approval is given with a fresh `Edward`. The old result evidence stays readable. | FX+HUB | M1-06, D2, SPEC |
| BRW-J-07 | Gate-2 Reject with a reason. | `acceptance-status` = rejected. No repair attempt, no new execution and no new HQ request. Engine state is unchanged. History gains an entry. | FX+HUB | M1-06 |
| BRW-J-08 | Failure: scenario `verification_fails`, repair 0 → approve. | The phase reads Failed and `#engine-state[data-state=failed]`. The failing check is visible. There is no result request and no `Accept result` anywhere for this task, and no force/override/dismiss control. Any rerun path goes through a new run request and Gate 1. | HUB (FX render) | M1-06, M1-07 |
| BRW-J-09 | One pre-approved repair: scenario `verification_fails_then_fixed`, with "Allow one repair" chosen in the draft and shown in the Gate-1 document. | Repairing is shown with its reason. `#attempt-id` changes to attempt 2 while attempt 1 stays readable. Remaining allowance is 0. Gate 2 binds **attempt 2's** candidate (≠ attempt 1). No new Gate-1 request is made. | HUB | M1-06, D3 |
| BRW-J-10 | Repair not allowed or out of scope: (a) `verification_fails_then_fixed` with repair 0; (b) `out_of_scope` with repair 1. | (a) Failed, and attempt 2 never appears. (b) Stops (blocked/failed) with a scope message and no repair. In both cases further work needs a new proposal and Gate 1. | HUB | M1-06 |
| BRW-J-11 | Review outcomes that are not eligible: `reject_always` (repair 0), `malformed_review`, `reviewer_error`, `review_wrong_candidate`, `reviewer_mutates`, each with repair 1 where it applies. | No result request and no acceptance control. Malformed/error/protocol cases show as blocked, not repairing. Wrong-candidate and mutation cases show as integrity problems. Labels match the engine's terminal state. | HUB | M1-05, M1-06, SPEC |
| BRW-J-12 | Missing evidence: after `human_ready` and before accepting, delete one required artifact file (fixture directory only), then reopen the task and the HQ item. | `#evidence-status[data-status=missing\|unavailable]` and a viewer error for that artifact. `Accept result` is disabled or the server's rejection is shown. Typing `Edward` cannot override it. The field is emptied on error. `acceptance-status` ≠ accepted. DB: no acceptance. | HUB | M1-05, M1-12 |
| BRW-J-13 | Corrupt evidence: (a) flip one byte in a required artifact; (b) coherent tampering: rewrite the file and the matching DB hash/length row together. | In both cases there is an integrity error in the viewer and in the detail. `Accept result` → rejection (`stale_binding`/integrity), shown together with the last confirmed state. The request is invalidated, the field emptied, and no acceptance row is written. | HUB | M1-05, SPEC fix 5 |
| BRW-J-14 | Interrupted: scenario `impl_hangs` → approve → executing → stop the hub, close and reopen the same DB after the lease TTL, start the hub → reload → **sign in again** (expected, because sessions are bound to a boot). | Interrupted, with the last confirmed stage. No automatic relaunch: the attempt count is unchanged after ≥ 2 poll intervals. The wording about termination proof is honest. A rerun requires a new run request and a fresh Gate 1. | HUB | M1-07, M1-08, D4 |
| BRW-J-15 | Cancellation requested vs confirmed: `impl_hangs` → executing → `Cancel execution`. | `#cancellation-status[data-status=requested]` ("Cancellation requested") appears while the engine state is still active. **Cancelled is never shown before proof**, and `Accept result` is unavailable. After termination is confirmed: `data-status=confirmed` and `#engine-state[data-state=cancelled]`. A deterministic "requested" window needs seam N-2. Without it, HUB asserts only the ordering and FX covers both renders. | FX+HUB (N-2) | M1-07, SPEC |
| BRW-J-16 | Evidence completeness for the J-01 result. | Every manifest entry has a list item. Each item opens with name, kind, byte length, SHA-256, attempt and candidate. Diff/log/review/manifest render as plain text. Truncated artifacts are labelled truncated. Findings are readable. | HUB (FX render) | D2, M1-12 |
| BRW-J-17 | Acceptance language audit, run after accepted, changes-requested, rejected and invalidated transitions and on the HQ history. Scope: `main` excluding the Activity (observed) view. | Visible text never matches `/\b(merg(e\|ed\|es\|ing)\|push(ed\|es\|ing)?\|deploy(ed\|s\|ing\|ment)?)\b/i`. The acceptance copy describes its scope without those words (e.g. "does not change any repository"). | FX+HUB | SPEC |
| BRW-J-18 | Provenance and simulation only. | `#provenance` shows data source, mode and integration evidence ("Simulated", integration "unverified"). No control offers Live mode, or any Live option is disabled with a reason. The Activity view shows telemetry marked "Observed only" with no queue/approve/accept/cancel controls. | FX+HUB | M1-10, SPEC |
| BRW-J-19 | HQ inbox and history: two pending Gate-1 requests on different tasks plus one result request. | `#hq-pending-count` = 3 = DB. Filters (repo/gate/search), if built, narrow correctly. Opening one request shows only that request. History shows actor, gate, action, bound proposal version or result-envelope identity, reason and timestamp, and a later invalidation label without hiding the original decision. | FX+HUB | D5 |
| BRW-J-20 | Operator session. Sign in with a wrong credential → sign in with the correct runtime credential → `Sign out`. | Wrong: `role=alert` rejection and no data rendered. Correct: signed in. Sign out purges workspace data, selection, unsaved form, viewer and signature. Cookie attributes are HttpOnly and SameSite=Strict, checked as attributes only. The credential never appears in DOM, URL or storage. | HUB | SPEC, SOL §E |
| BRW-J-21 | CEO briefing (only if built). | Skippable immediately. The decision document and controls are usable without waiting, and reduced motion skips the animation. | FX+HUB (conditional) | SPEC |
| BRW-J-22 | Acceptance later invalidated: after J-01 C14, corrupt a required artifact → reload. | A visible alert says the acceptance is no longer valid and `acceptance-status` = invalidated or equivalent. The original decision stays in history with its timestamp. Re-accepting is impossible without a new valid result request. | HUB | SOL §C Gate 2 |

## 2. Race / uncertainty matrix (BRW-R)

Techniques (HUB): `page.route` to delay, hold or abort; `route.fetch()` followed by
`route.abort("connectionreset")` for a lost response after a server-side commit, which is the existing
gate pattern; a network log of decision POST bodies (comparing idempotency key and decision id for
equality, never logging challenge or CSRF values); and in-process DB counts. The fixture transport is
in memory and cannot be intercepted by `page.route`, so races are **HUB-primary** (§6).

| ID | Case and steps | Decisive expected result | Set | Trace |
| --- | --- | --- | --- | --- |
| BRW-R-01 | Repo A→B: B is a second, monitor-only repo seeded through ingest (existing gate pattern, N-16). Delay A's response by 1.2 s, then click A then B. | B's view stays (label "Monitor only", no `Assign work`). A's late response never replaces it. | HUB | M1-09 |
| BRW-R-02 | Task A→B: delay `GET` for task A, click A then B. | `region "Task detail"[data-task-id=B]` survives A's late answer, and no loading placeholder gets stuck. | HUB | M1-09 |
| BRW-R-03 | HQ request A→B with a challenge in flight: open A, type `Edward`, hold A's challenge response, open B. | B's field is empty. A's late challenge never binds to B. After typing `Edward` on B and clicking Approve, the POST targets B's request id and binding. DB: A still pending, B approved. | HUB | M1-02, M1-09 |
| BRW-R-04 | Oscillate A→B→A with B delayed. | A ends up displayed and B never flashes in. | HUB | M1-09 |
| BRW-R-05 | Re-select the subject already selected (task, then HQ request), twice quickly. | The detail is kept, nothing gets stuck loading and no duplicate decision is made. Signature handling follows ruling N-8, but the text is never applied to a different subject. | FX+HUB | M1-09 |
| BRW-R-06 | Auth-generation switch: hold task X's `GET` under session 1 → `Sign out` → `Sign in` (session 2) → release. Also deliver a delayed 401 from session 1 after session 2 is active. | The session-1 answer is dropped and never rendered under session 2. The late 401 does not sign session 2 out. The signature is emptied at sign-out. | HUB | M1-09 |
| BRW-R-07 | Boot-generation switch: `Edward` typed on Gate 1 → restart the hub (same DB). | The UI notices the invalidated session/challenge and asks for sign-in again. The field is emptied. The old challenge is never accepted (DB unchanged). After signing in again, the request is still pending and can be approved only with a fresh `Edward` and a new challenge. | HUB | M1-03, SPEC |
| BRW-R-08 | Artifact viewer: (a) open the diff (delayed) and close before it arrives; (b) open the diff (delayed), then the manifest; (c) press Escape. | (a) It stays closed. (b) The manifest stays and the late diff does not replace it. (c) The viewer closes and focus returns to the opener. | HUB (c: FX+HUB) | M1-09 |
| BRW-R-09 | Back/Forward across subjects: task A → HQ request R1 (type `Edward`) → task B → Back → Back → Forward → Forward. | URL and selection stay consistent at every step. The R1 field is empty on return. No stale detail appears and no signature is restored. | FX+HUB | M1-03, M1-09 |
| BRW-R-10 | Back during an in-flight decision: hold the Approve POST, press Back, then release it. | The outcome is attributed only to R1 (approved once) and is never shown on the subject now on screen. No second POST. DB: 1 decision. | HUB | M1-02, M1-09 |
| BRW-R-11 | Reload during an in-flight Gate-1 decision: (a) the server commits (`route.fetch`) and the browser reloads before the response; (b) the request is aborted before reaching the hub, then reload. | (a) After the reload the backend's truth is shown: approved, and queued exactly once. The field is empty and **zero** decision POSTs follow the reload. (b) Still pending and nothing queued. | HUB | M1-08 |
| BRW-R-12 | Same as R-11 for Gate 2 (`Accept result`). | (a) Accepted once. (b) Still pending. No automatic resubmission. | HUB | M1-08 |
| BRW-R-13 | Lost Gate-1 response: the server commits, then the connection resets. | "Decision status" shows "Decision outcome unknown". Approve is not offered with a new key. Reconciliation (check by decision id, or retry) reuses the **same** `idempotency_key`/`decision_id`. The final UI shows approved. DB: 1 decision, 1 execution, 1 attempt. | HUB | M1-02, M1-08 |
| BRW-R-14 | Lost Gate-2 response: same as R-13. | Same key reused. DB: 1 acceptance. | HUB | M1-08 |
| BRW-R-15 | Double activation of `Approve execution` and of `Accept result`: `dblclick`, two rapid clicks, and Space pressed twice. | At most one decision POST, or every POST carries one key. The button is disabled after the first activation. DB: exactly one decision (and one execution). | HUB (FX: single dispatch) | M1-02 |
| BRW-R-16 | Lost response, then the user activates `Check decision outcome` / retry. | The same key is used. If the outcome resolves to committed, no new signature is requested. If the server never received it, the retry follows the contract (same key, valid or fresh challenge) but never produces a second execution. | HUB | M1-02, SOL §C |
| BRW-R-17 | Enter is inert: on both gates with the exact `Edward` typed, press Enter, NumpadEnter, Ctrl/Cmd+Enter and Shift+Enter in the signature field. | **Zero** decision POSTs, no navigation, no form submit. The request stays pending. | FX+HUB | M1-03, SPEC |
| BRW-R-18 | Signature exactness: `edward`, `EDWARD`, ` Edward`, `Edward `, `Edwards`, `Edward` + Tab character, `Edwardx` followed by deleting the x. | Approve/Accept are enabled only for the exact value (trim rule N-10). No POST for any non-exact variant. | FX+HUB | M1-01 (UI side) |
| BRW-R-19 | Clearing on subject and gate change: type in R1 → open R2 → back to R1. Gate change: the same task goes from Gate 1 (approved) to Gate 2. | Every arrival shows an empty field. The Gate-2 field starts empty even if the DOM node is reused. | FX+HUB | M1-03 |
| BRW-R-20 | Clearing on error: the decision POST is fulfilled with 409 `stale_binding`, then with 500. | `role=alert` names the last confirmed state and a safe next action. The field is empty. DB: the request is still pending with no decision row. | FX+HUB | M1-03 |
| BRW-R-21 | Clearing on expiry: short challenge TTL (N-3) → wait past expiry. | An expiry notice appears and the field is emptied. An Approve attempt fails and a new challenge is required. Nothing queued. | HUB (N-3), FX render | M1-03, SPEC |
| BRW-R-22 | Clearing on success: approve → open the next pending request. | Both fields are empty and the decided request's buttons are disabled. | FX+HUB | M1-03 |
| BRW-R-23 | Invalidation from another tab: page 2 (same context) edits and resubmits while page 1 has `Edward` typed on the old request. | On its next poll, page 1 shows invalidated, empties the field and disables Approve. A click before that poll shows a 409. DB: nothing queued for the old version. | HUB | M1-02, M1-04 |
| BRW-R-24 | Two tabs, same request: tab B approves, then tab A (with `Edward` typed) clicks Approve. | Tab A shows already-decided or invalid. Exactly one decision. Tab A's challenge cannot be used for any other request. | HUB | M1-02 |
| BRW-R-25 | Offline: abort every `/api` request for 5 s, then restore. | "Connection" shows "Offline" with the last confirmed time and the snapshot is marked stale. All write controls are disabled, the field is emptied and no writes are sent. On recovery, bindings are revalidated and a new challenge is fetched before Approve is enabled again. | HUB | M1-03, SOL §D |
| BRW-R-26 | Stale poll snapshot: hold an older task snapshot and deliver it after newer ones (existing gate pattern). | The displayed `data-rev` never decreases and the stage never regresses. | HUB | M1-09 |
| BRW-R-27 | Late error after success: delay a failing (5xx) poll until a newer successful response has rendered. | Newer state is not discarded, and any error is shown without regressing data. | HUB | M1-09 |
| BRW-R-28 | Session expiry or revocation: short session TTL (N-3), or revoke server-side → the next request returns 401. | Data, signature and viewer are purged and in-flight answers are dropped. Signing in again restores state from the backend. | HUB (N-3) | M1-03, M1-09 |

## 3. Persistence matrix (BRW-P) — HUB only

- **Reload** means `page.reload()` in the same context **and** a new `BrowserContext` with empty storage.
  The fresh context is the decisive one, because it proves the state did not come from browser storage.
- **Restart** means: stop the in-process hub, close the DB, reopen the same temp SQLite file and start a new
  hub on the same ports (new boot generation). **Signing in again after a restart is expected**, because
  sessions and challenges are bound to the boot. It is not a defect.
- The UI fixture, `localStorage`, `sessionStorage` and IndexedDB are never accepted as persistence proof.

| ID | Case | Decisive expected result | Trace |
| --- | --- | --- | --- |
| BRW-P-01 | Save a draft → reload (same context and fresh context). | Title, objective and criteria are identical (verbatim, commas, order). | M1-08 |
| BRW-P-02 | Save a draft → restart → sign in again. | Identical. | M1-08 |
| BRW-P-03 | Mixed pending Gate-1 and Gate-2 requests → reload, then restart. | Same items, and `#hq-pending-count` = DB count. | M1-08, D5 |
| BRW-P-04 | Approve, request changes, reject and accept across tasks → restart. | History is identical: actor, gate, action, bound version or envelope, reason, timestamps and invalidation flags. | M1-08 |
| BRW-P-05 | Truthful run state across restart: (a) `human_ready` not accepted; (b) accepted; (c) mid-run; (d) failed. | (a) Still "Awaiting acceptance" with acceptance pending. (b) Accepted, with the engine still `human_ready`. (c) Interrupted as in J-14, never executing or `human_ready`. (d) Still failed. | M1-07, M1-08 |
| BRW-P-06 | Cancellation requested → reload (and restart where engine semantics define it). | Still "requested" until confirmed, and never "cancelled" without proof. | M1-07 |
| BRW-P-07 | Decision committed but unseen (R-13 lost response) → restart before reconciling → reload. | The decision shows as committed. No re-approval is offered. Exactly 1 execution. | M1-08 |
| BRW-P-08 | Restart invalidates sessions and challenges. | The old cookie is rejected and the sign-in form shows. Fields are empty. A challenge captured earlier and replayed through the page's own `fetch` is rejected (its value is never logged). | SPEC |
| BRW-P-09 | Browser storage is not authority: (a) list the storage keys; (b) clear storage (keep cookies) and reload; (c) inject forged `accepted`/`approved` keys and values into `localStorage`; (d) go offline and reload. | (a) No credential, session, CSRF or challenge value and no success flag. (b) Identical state. (c) The UI is unchanged. (d) No fabricated success. | M1-08, SPEC |
| BRW-P-10 | Deep links: copy the task/HQ-request URL → reload or open in a new tab → after auth. | The same subject is restored. An unknown id is explained and the URL is normalised. | D5 |
| BRW-P-11 | No fixture data in HUB mode. | `#provenance[data-source=hub]` and no fixture ids or hashes rendered. | M1-10 |

## 4. Accessibility / layout matrix (BRW-A)

Method: keyboard cases A-01…A-05 use `page.keyboard` only, with **no** `click()`, and record the focus
path. Role/name trees are saved with `locator.ariaSnapshot()` (built into playwright-core). `axe-core` is
**not installed** in this checkout, so an automated WCAG rule scan is NOT RUN unless the lead approves
adding it (no installs). Layout is measured from DOM geometry and checked by inspecting the saved
screenshots.

| ID | Case | Decisive expected result | Set | Trace |
| --- | --- | --- | --- | --- |
| BRW-A-01 | Keyboard-only Gate 1: skip link / Tab → `Headquarters` → inbox item → signature → type → Tab → `Approve execution` → Space (and separately Enter on the button). | Completes with zero mouse events. Enter *in the field* stays inert. Afterwards focus lands on the decision status or a heading, not on `body`. | FX+HUB | M1-11 |
| BRW-A-02 | Keyboard-only Gate 2, including opening evidence before accepting. | Same as A-01, with `Accept result`. | FX+HUB | M1-11 |
| BRW-A-03 | Keyboard through the repo, task and inbox lists and the filters. | Every item can be reached and activated. `aria-current` follows the selection. Focus moves to the detail `h2` on selection. | FX+HUB | M1-11, D5 |
| BRW-A-04 | Keyboard evidence: Enter on an artifact → arrow keys / PageDown inside `pre` → Escape. | The content scrolls by keyboard. Escape closes the viewer and focus returns to the opener. | FX+HUB | M1-11, SOL §D |
| BRW-A-05 | Keyboard draft: skip link → `Assign work` → fields (Enter inside the criteria textarea adds a newline) → `Save draft` → `Submit for run approval`. | Completes. "Skip to task panel" is the first focusable element and moves focus. | FX+HUB | M1-11 |
| BRW-A-06 | Visible focus on every element in the Tab cycle. | The focused computed outline or box-shadow is not none and differs from the unfocused state. Screenshots of the focused signature field and gate buttons are saved. | FX+HUB | M1-11 |
| BRW-A-07 | Labels and roles. | Every input, textarea and select has an accessible name. Gate buttons are `<button type="button">` with the exact names. Signature inputs are not inside a submitting form. There is exactly one banner, one primary nav and one main. Heading levels are logical. The ariaSnapshot is saved. | FX+HUB | M1-11, SOL §D |
| BRW-A-08 | Live regions. | `status "Task status"`, `"Decision status"` and `"Connection"` update on stage change, decision outcome and going offline. Errors appear in `role=alert`. | FX+HUB | M1-11 |
| BRW-A-09 | 1440×900: workspace, HQ, evidence open, long-content state. | `scrollWidth ≤ clientWidth` (no horizontal page overflow). The sticky identity header and action footer stay in the viewport. Approve/Accept are visible without page scroll because the body scrolls internally. The split is about 736/600 px (recorded for information, not pass/fail). | FX+HUB | M1-11 |
| BRW-A-10 | 1280×800, same states. | Same; split about 616/560 px. | FX+HUB | M1-11 |
| BRW-A-11 | Long content: a 200-character title with no spaces, a 180-character path, a 64-hex hash, a 40-hex SHA and 50 criteria. | Everything wraps with no overflow, and full values stay available (text content, accessible name or copy button). | FX+HUB | M1-11, SOL §D |
| BRW-A-12 | Readable, inert evidence: an artifact containing `<img src=x onerror=…>`, `<script>`, ANSI escapes and a 5,000-character line. | Rendered literally as monospace text. No dialog, no console error and no request is triggered. It scrolls inside the viewer only, with no page overflow. | HUB (FX render) | M1-12 |
| BRW-A-13 | Reduced motion: context `reducedMotion: "reduce"`. | After interactions, `document.getAnimations()` holds no non-essential running animation longer than about 0.01 s. J-01 C2–C14 pass. Screenshots are saved. | FX+HUB | M1-11 |
| BRW-A-14 | WebGL unavailable: separate launch with `--disable-3d-apis --disable-webgl --disable-webgl2`. Before any assertion counts, prove in-page that `getContext("webgl")` and `getContext("webgl2")` both return `null`. | The DOM campus/repo list is usable and J-01 C2–C14 pass with no uncaught errors. This still runs if M1 ships no 3D, because it proves there is no hidden WebGL dependency. | FX+HUB | M1-11 |
| BRW-A-15 | Status is not shown by colour alone, and errors are actionable. | Every status has text. Errors name the last confirmed state and a safe next action. A disabled Approve/Accept explains why via `aria-describedby`. | FX+HUB | M1-11, SOL §D |
| BRW-A-16 | Scrolling: long criteria, findings and diff. | They scroll inside the right-panel body while the header and footer stay sticky. A focused element is scrolled into view and is not hidden under the sticky footer. | FX+HUB | M1-11 |

## 5. Browser-visible security hygiene (BRW-S) — HUB

| ID | Case | Decisive expected result | Trace |
| --- | --- | --- | --- |
| BRW-S-01 | Secret placement. | G-3 holds. Cookie attributes from `context.cookies()` are HttpOnly, SameSite=Strict, and Path, plus Secure as ruled in N-7; values are never printed. `document.cookie` does not contain the session cookie. | SPEC |
| BRW-S-02 | Network boundary. | G-1 holds for the whole run: no `:4317`, no external host and no CDN/font fetch. | SPEC |
| BRW-S-03 | Mutation request headers. | Every workspace mutation carries the CSRF header, and its `Origin` equals the Vite origin exactly. Presence and equality are checked in-test; values are not logged. | SPEC |
| BRW-S-04 | Public `/ws`. | `page.on("websocket")` frames contain none of the task, proposal, request, execution or attempt ids known from the DB. | SPEC |
| BRW-S-05 | Canary redaction: synthetic canaries built at runtime in secret-pattern shapes are placed in the proposal text and the fixture diff (including role 06's omitted-hunk context fixture, if provided). | The UI shows a redaction marker and never the raw value. | M1-12 |
| BRW-S-06 | Console and page errors. | G-2 holds. | — |
| BRW-S-07 | Evidence hygiene. | Before each screenshot, the page text is scanned with the shared `secret-patterns.ts` and the run's synthetic values. The request log drops Cookie, Set-Cookie, Authorization and CSRF headers and challenge bodies. | SPEC |

## 6. Evidence labelling (FX vs HUB)

| Label | Meaning | What it can prove | What it can never prove |
| --- | --- | --- | --- |
| **[FX] fixture transport** | Vite build with the frontend's fixture transport (switch N-1), no hub, no proxy. A route guard fails the case on any `/api` request. Provenance must read "UI fixture". | That every state renders; local state ownership (signature clearing, Enter inertness, subject binding); layout; accessibility. | Persistence, authority, idempotency, server enforcement, or M1C/M1D exit. |
| **[HUB] isolated real test hub** | In-process hub on a free loopback port ≠ 4317, temp SQLite, fake providers, Vite `configFile:false` with an empty `envDir`, fresh browser profile. | Everything in this matrix. **Decisive** for M1C and M1D. | Live readiness (simulated only, M1-10). |

| Area | FX runs | HUB runs |
| --- | --- | --- |
| Journeys (22) | J-01…07, J-15 (render), J-17…19, J-21; state renders for J-03, J-08, J-12, J-13, J-16 | All 22 |
| Races (28) | R-05, R-08c, R-09, R-15 (single dispatch), R-17…20, R-21 (render), R-22 | All 28 (R-21 and R-28 need N-3) |
| Persistence (11) | none, by definition | All 11 |
| Accessibility/layout (16) | All 16 (early feedback) | All 16 (decisive) |
| Security (7) | none | All 7 |

Every `RESULTS.md` row will carry: ID, set label, exact browser and version (`browser.version()`),
playwright-core version, viewport, reduced-motion/WebGL flags, tested `HEAD` plus a hash of
`git diff` (read-only git), result (PASS/FAIL/NOT RUN/BLOCKED), and evidence file names.

**Case counts:** journeys 22 (J-01 has 16 checkpoints) · races 28 · persistence 11 · accessibility/layout 16 · security 7 → **84 cases**, plus global assertions G-1…G-6.

## 7. DOM contract request (09 → 07, via the lead)

Rules: use native elements. Tests query by role plus **exact** accessible name ("≈" means substring).
Raw ids and enums go in `data-*` attributes, so visible copy can change freely. Every workspace/HQ button
is `<button type="button">`; the only exception is the sign-in submit.

**Landmarks and navigation**
- `header` (banner): `#provenance`, `status "Connection"`, `#hq-pending-count`, the text "Signed in as operator:edward" and `button "Sign out"`.
- `nav` with label "Primary": items "Projects", "Headquarters", "Activity". The active one has `aria-current="page"`.
- The first focusable element is the link "Skip to task panel".
- `section[aria-label]` regions: "Repositories", "Tasks", "Task detail", "Approval inbox", "Approval document", "Decision history", "Evidence", "Proposal".
- Repo item: a button whose name ≈ the repo id, with `aria-current="true"` when selected. Monitor-only repos show "Monitor only" and have no "Assign work".
- Task item: a button whose name ≈ the title, with `data-task-id` and `aria-current`.
- Inbox item: a button whose name ≈ "Execution approval · <title>" or "Result acceptance · <title>", with `data-request-id` and `aria-current`.
- Selecting any subject focuses the right panel's `h2` (`tabindex=-1`) and is reflected in the URL (push or replace per N-11). Back/Forward restores the selection. The URL never contains a secret or a challenge.

**Containers**
- Region "Task detail": `data-task-id`, `data-rev`.
- Region "Approval document": `data-request-id`, `data-gate` = `execution|result`, `data-request-status` (frozen enum), `data-rev`.
- History entries: `li[data-decision-id]`.
- Evidence viewer: `role="dialog"` whose name ≈ "Evidence: <artifact name>", with `data-artifact-id`, `data-state` = `loading|ok|error`, `button "Close evidence"`, and its content in a `pre tabindex=0`. Escape closes it and focus returns to the opener.

**Authentication:** input labelled "Operator credential" (`type=password`, `autocomplete=off`) and `button "Sign in"` (Enter allowed here). Errors go in `role=alert`.

**Draft:** `button "Assign work"`. Fields labelled "Title", "Objective" and "Acceptance criteria" (textarea described by "One criterion per line"), plus "Allowed paths" if it is editable. Radiogroup "Repair policy" with "No automatic repair" (default) and "Allow one repair". Buttons "Save draft", "Submit for run approval" and "Edit draft". Proposal view: `ol` labelled "Acceptance criteria" with one `li` per criterion, verbatim. Optional, pending ruling N-4: a select labelled "Simulation scenario", in simulated mode only.

**Gates** (inside "Approval document")
- The signature input is `type=text`, `autocomplete=off`, `spellcheck=false`, labelled **"Type Edward to approve execution"** (Gate 1) or **"Type Edward to accept this result"** (Gate 2). It is not inside a submitting `<form>`. It is empty on every new subject or gate. Enter, NumpadEnter and Ctrl/Cmd+Enter do nothing.
- Buttons: **"Approve execution"** (Gate 1) or **"Accept result"** (Gate 2), plus **"Request changes"** and **"Reject"** on both gates. Approve/Accept are natively `disabled` until the field is exactly `Edward` and a challenge is ready, with `aria-describedby` explaining why.
- A textarea labelled "Decision reason" is required for Request changes and Reject.
- While a decision is in flight the buttons are disabled. If the outcome is unknown, "Decision status" contains "Decision outcome unknown" and `button "Check decision outcome"` reuses the same idempotency key.

**Status regions** (`role="status"` with a fixed `aria-label`)
- "Connection": contains "Offline" plus the last confirmed time when offline.
- "Task status".
- "Decision status".
- "Save status": shows "Draft saved".

Errors use `role=alert` in their own section and name the last confirmed state and a safe next action.

**Execution:** `button "Cancel execution"`. Optional: `button "Request a new run"` for interrupted or blocked tasks.

**`data-testid`s (11)**

| testid | Content |
| --- | --- |
| `hq-pending-count` | Integer text. |
| `current-stage` | Visible derived phase, e.g. "Awaiting acceptance". |
| `engine-state` | `data-state` = raw engine `TaskState` (`draft`, `queued`, `executing`, `verifying`, `reviewing`, `repairing`, `human_ready`, `failed`, `blocked`, `interrupted`, `cancelled`), shown as text. |
| `acceptance-status` | `data-status` = `none`, `pending`, `accepted`, `changes_requested`, `rejected` or `invalidated` (or the frozen enum). |
| `cancellation-status` | Present only once cancellation has been requested. `data-status` = `requested` or `confirmed`. |
| `proposal-version` | Integer, in the task panel and the approval document. |
| `execution-id` | Execution id. |
| `attempt-id` | Attempt id, with `data-attempt-number`. |
| `candidate-sha` | The full 40-hex value as text content, wrapping. |
| `evidence-status` | `data-status` = `verified`, `pending`, `missing`, `corrupt` or `unavailable`. |
| `provenance` | `data-source` = `fixture` or `hub`, `data-mode` = `simulated` or `live`, `data-integration` = `unverified` or `verified`, with visible labels ("UI fixture" or "Hub record", "Simulated", …). |

**Copy and transport constraints**
- No merge/push/deploy vocabulary anywhere in the workspace or HQ. Describe scope as, for example, "Acceptance records your decision on this exact result; it does not change any repository."
- No session secret in JS-readable storage, the DOM or the URL.
- The fixture transport is enabled by a build-time switch that a programmatic Vite server can set (a `define` constant or `import.meta.env.VITE_*` set in the config; `envDir` is empty). It must not be a URL parameter, and fixture mode renders `data-source=fixture`.

## 8. Browser identification plan (read-only findings; nothing launched)

| Fact | Finding |
| --- | --- |
| playwright-core | `1.63.0` (`agent-city-m1/node_modules/playwright-core/package.json`) |
| `browsers.json` pins | `chromium` rev **1243** = Chrome for Testing **153.0.8010.12**; `chromium-headless-shell` rev **1243** = **153.0.8010.12**; firefox 1543; webkit 2359; ffmpeg 1011 |
| Cache `/Users/edwardhwang/Library/Caches/ms-playwright` | `chromium-1243` (`chrome-mac-arm64/Google Chrome for Testing.app`, Info.plist `CFBundleShortVersionString` = 153.0.8010.12) and `chromium_headless_shell-1243` (`chrome-headless-shell-mac-arm64/chrome-headless-shell`); both have `INSTALLATION_COMPLETE` and `DEPENDENCIES_VALIDATED`. Unused leftovers: `chromium-1234` / `chromium_headless_shell-1234` (151.0.7922.34), `webkit-2336`, `webkit-2359`, `ffmpeg-1011`. **No Firefox is cached.** Host is arm64. |
| What launch will use | `chromium.launch({ headless: true })`, as in `browser-gate.ts`, resolves to **`chromium_headless_shell-1243`** (Chrome Headless Shell 153.0.8010.12). `headless: false` or `channel: "chromium"` would use the full `chromium-1243` Chrome for Testing 153.0.8010.12, which is also cached (no download). Suggested: the main suite on the headless shell, plus one J-01 and A-09/A-10 screenshot pass on `channel: "chromium"` for rendering fidelity, if the lead agrees. The authoritative value is `browser.version()`, recorded in every result row. |
| WebGL | The headless shell ships `libvk_swiftshader`, so **WebGL is normally available**. A-14 must disable it explicitly **and** prove that in the page. |
| Isolated runner | `run.sh` runs `env -i HOME=<scratch>/iso/home …`, so Playwright's default lookup (`$HOME/Library/Caches/ms-playwright`) would point into the scratch HOME and the launch would fail. Execution must set the path explicitly: `…/scratchpad/iso/run.sh env PLAYWRIGHT_BROWSERS_PATH=/Users/edwardhwang/Library/Caches/ms-playwright bun --no-env-file apps/web/e2e/workspace-m1/<suite>.ts` (`/usr/bin/env` is on the isolated PATH). The cache is only read; no install or download path is exercised. |
| Alternatives | The in-app Claude Browser pane, Claude-in-Chrome (the user's personal Chrome profile) and Chrome DevTools MCP are **not** fresh isolated profiles and cannot emulate reduced motion or disable WebGL reproducibly. They are for manual visual spot checks only, and only if the lead approves. |

## 9. Isolation plan (reuses the `browser-gate.ts` pattern)

1. **Preflight, fail closed before anything starts:** cwd is `agent-city-m1`. `.env` is absent. `HOME`/`TMPDIR` are the isolated scratch directories. `claude`/`codex` cannot be resolved on PATH. The only extra variable is `PLAYWRIGHT_BROWSERS_PATH`.
2. **Fixture:** testkit `makeFixture({ dbFile: true, repoId })` in `mkdtemp` provides a temp SQLite file and a disposable git repo. No live stubs are enabled; crafted-live attacks belong to role 08. The repo id is the allowlisted fixture id, with a per-run nonce if the allowlist allows it (N-5).
3. **Ports (ordering change from the existing gate):** pick `hubPort` **and** `vitePort` with `freePort()` before `startHub`, and assert both are distinct and ≠ 4317. The hub's exact allowed Origin is `http://127.0.0.1:<vitePort>` (N-6), because the Vite proxy passes the browser's `Origin` through.
4. **Hub** runs in-process via `startHub({ db, hostname: "127.0.0.1", port: hubPort, … })` with the lead's M1 wiring: a synthetic ingest token, a test operator credential generated at runtime with `randomBytes` (never printed and never written to disk), and short TTLs if N-3 exists.
5. **Vite** runs programmatically: `createServer({ configFile: false, root: apps/web, envDir: <empty temp dir>, mode: "development", plugins: [react()], server: { host: "127.0.0.1", port: vitePort, strictPort: true, proxy: { "/healthz", "/api", "/ws" → this hub only } } })`. `apps/web/vite.config.ts` and the repo `.env` are never loaded. For the FX set: no proxy, the fixture switch set via `define` (N-1), and a route guard that fails the case on any `/api` request.
6. **Identity proof before any mutation:** confirm through the proxy that the per-run identity matches (N-5), as the existing gate does with the repo id.
7. **Browser:** cached headless shell (§8). Each evidence set, and each fresh-context persistence check, gets a new `BrowserContext` with: viewport 1440×900 or 1280×800, `deviceScaleFactor: 1`, `reducedMotion` per case, `serviceWorkers: "block"`, `acceptDownloads: false` and no `storageState`. A-14 uses a separate launch with the WebGL-off flags.
8. **Route guard at context level:** any request whose host is not `127.0.0.1:<vitePort>` is aborted and the case fails (this covers `:4317` and external hosts).
9. **Restart:** `hub.stop()` → `db.close()` → `openDb(samePath)` → wait for the lease TTL if the case needs it → `startHub` on the same port. Signing in again is expected.
10. **Signing in** types the runtime test credential into the app's own sign-in field on `127.0.0.1` only.
11. **Evidence:** `mkdtemp` `agentcity-m1-browser-evidence-*` under the isolated TMPDIR, kept and printed at the end. It holds numbered screenshots (viewport and full page), ariaSnapshot text, a request log (method, path, status, key-equality markers; no secret headers or bodies), the console log, and a pre-screenshot secret scan (S-07). A secret-free `RESULTS.md` summary is written later in this directory.
12. **Cleanup** in `finally`: browser → Vite → hub → `fixture.cleanup()`. Unrelated processes are never terminated.
13. **Planned files (not written yet):** `harness.ts`, `fx.suite.ts`, `hub.suite.ts`, `RESULTS.md`. `apps/web/e2e/tsconfig.json` already includes `./workspace-m1/**/*.ts`, so typecheck needs no lead patch. A root `"test:browser:m1"` script would be a lead patch proposal.

## 10. Open questions / seams needed (otherwise the affected case is BLOCKED or NOT RUN — never improvised)

| # | Owner | Question / seam | Affected |
| --- | --- | --- | --- |
| N-1 | 07 | How a programmatic Vite server enables the fixture transport (build-time switch, not a URL parameter). | The whole FX set |
| N-2 | 05 / lead | A deterministic "cancellation requested, not yet confirmed" window in the test hub (e.g. a fake stage that delays termination proof for a bounded time). | J-15 (HUB), P-06 |
| N-3 | 03 | Configurable challenge TTL and session TTL for the in-process hub. | R-21, R-28 |
| N-4 | lead | How the fake scenario is chosen: a UI select "Simulation scenario" (simulated mode only), or seeding drafts through the hub API/service with the test session. The "no prototype simulation controls" rule appears aimed at demo Advance/Confirm buttons. J-01 is fully UI-driven either way. | J-08…J-11, J-14, J-15 |
| N-5 | lead / 03 | Per-run identity proof through the proxy (a nonce repo id or boot generation visible in the snapshot). | Every HUB case (preflight) |
| N-6 | 03 / lead | The `startHub` parameter for the exact allowed Origin, and confirmation that a proxy-forwarded Origin is accepted. | Every HUB case |
| N-7 | 03 | Whether the session cookie carries `Secure` over `http://127.0.0.1`. Chrome's handling has to be verified at execution time; if the cookie is not stored, the HUB set is BLOCKED. | Every HUB case, S-01 |
| N-8 | 07 | When the user re-selects the subject that is already selected, is the signature kept or cleared? (Default expectation: kept, never applied elsewhere.) | R-05 |
| N-9 | 01 / 07 | Criteria parsing: are blank lines dropped, is whitespace trimmed, what are the maximum count and length? | J-02 |
| N-10 | 03 / 07 | Signature exactness: expected strict, no trimming (the spec says "exact"). | R-18 |
| N-11 | 07 | History: push or replace on selection; Back/Forward semantics. | R-09, R-10, P-10 |
| N-12 | 04 / 07 | After Gate-1 Request changes: is a linked draft created automatically (prefilled), or is an explicit "Edit draft" needed? | J-04, J-06 |
| N-13 | 01 / 02 | Does "Save draft" create an immutable proposal version or update a mutable draft? This decides the version assertions. | J-01 C4–C6, J-03 |
| N-14 | 05 / lead | An in-process counter of live provider launches (for G-5). | G-5 |
| N-15 | 04 / 06 | When an acceptance invalidated by later evidence corruption is detected: on read or by a background check. | J-22 |
| N-16 | lead | Can a second, monitor-only repo appear in the workspace repo list in M1? | R-01 |
| N-17 | lead | `axe-core` is absent. Approve adding it, or keep the WCAG rule scan NOT RUN. | A-07 |

## 11. Corrective v1.2 cases (added by the lead from the corrective UI worker's report; CONTRACT_V1_2.md)

| ID | Case | Set |
| --- | --- | --- |
| BRW-J-22 (re-expressed) | Accepted result → corrupt a required source artifact → reload: `acceptance-status=accepted` (history), `acceptance-validity[data-status=invalid]` + alert, decision/receipt unchanged, accepted original viewable as history (byte-equal), still invalid after a second reload | HUB |
| BRW-C-01 | Unmapped criterion cannot be approved: the UI blocks Submit; a stale client (outgoing draft rewritten to drop the mapping) gets the hub's 400 issues shown verbatim; no approval request; a normal resubmit opens a v1.2 Gate 1 | HUB/FX |
| BRW-C-02 | Criterion coverage shown in task detail and the Gate-2 document, equal to the sealed coverage | HUB/FX |
| BRW-C-03 | A failing check yields no satisfied criterion and no acceptance (HUB: the engine fails the attempt before sealing → no result request; unsatisfied rendering is proven in FX/unit tests only) | HUB/FX |
| BRW-C-04 | Editing one criterion in a revision changes only that criterion's id | HUB/FX |
| BRW-C-05 | A legacy v1 proposal reads "no criterion coverage — a new proposal and approval are required" | FX |
