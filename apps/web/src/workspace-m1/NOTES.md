# Workspace M1 web: role 07 notes (fixture transport phase)

This document is the role 07 (frontend) record. The directory `apps/web/src/workspace-m1/` belongs to
07. Every file outside it belongs to the lead, so §6 below gives only proposed patches for those
files. Status: **fixture phase done.** The real isolated test-hub transport is written as a skeleton
(`fetch-transport.ts`) and unit-tested against a fake `fetch`. It has **not** run against a hub,
because no hub was started (that comes after the backend lands).

## 1. Files

| File | Purpose |
| --- | --- |
| `transport.ts` | `WorkspaceTransport`: one method per `WORKSPACE_ROUTES` route (v1.1), typed with the frozen DTOs. `TransportResult` = ok · `http` (a contract error, so the request had no effect) · `network` / `invalid_response` (for a mutation, the outcome is **unknown**). |
| `fetch-transport.ts` | Real-hub skeleton. Uses `credentials: "same-origin"`, `cache: "no-store"` and `redirect: "error"`, plus a 15 s abort. Mutations send the `x-agentcity-csrf` header from `SessionView.csrf_token`, which lives only in a closure and is cleared on sign-out and on any 401. Ids are validated before any URL is built. Every success body is parsed with the route schema. An error body must be a `WorkspaceErrorBody` whose code matches the HTTP status; anything else becomes `invalid_response`. `decide()` sends the given serialized bytes unchanged. |
| `fixture-world.ts` | Deterministic in-memory hub mimic, built on the contract's own pure helpers (`buildProposalSnapshot`, `decisionPayloadFrom`, `stageAfterDecision`, `stageAfterSealing`, `resultEligibility`, `overallEvidenceStatus`). Every stage write goes through `canTransitionWorkspace`, so an illegal move throws. Hashes, shas and tokens are visibly synthetic counters (`ba5e…01`, `c0…1f`), never digests and never FNV. Artifact text is labelled "UI fixture". |
| `fixture-transport.ts` | The `WorkspaceTransport` facade plus `FixtureControls` (§4). Every answer is re-parsed with the contract schema, so a fixture bug shows up as `invalid_response`. |
| `config.ts` | Transport switch: the build-time define `__AGENTCITY_WORKSPACE_FIXTURE__` (R-N1), default hub. The fixture loads through a dynamic import. There is one transport per page and mode (React StrictMode mounts twice). |
| `sequencer.ts` | Request tickets: auth generation + slot (`snapshot`, `detail:<id>`, `artifact`, `challenge`, …). |
| `gate.ts` | Gate state: subject key `(request_id, binding_hash, status)`, never `rev`; exact-signature check; reasons a button is blocked; clearing rules; strict `DecisionRequest` body builder. |
| `decision-attempt.ts` | Attempt lifecycle: in flight, unknown, committed or failed. A retry resends the same key and the byte-identical body. An attempt can be reconciled from a read. |
| `draft-form.ts` | Draft editor model. Criteria go only through `criteriaFromText`; paths are one per line; issues come from `WorkspaceDraft` / `ProposalDraft`. |
| `route.ts` | Selection ↔ hash (`#/projects/<repo>/<wst>`, `#/hq/<wst>/<wsa>`, `#/activity`). Only ids appear, and invalid parts are dropped. |
| `labels.ts` | All visible copy, labels and status derivations (`acceptanceStatus`, `cancellationStatus`, `evidenceStatus`, `engineLabel`, …). |
| `store.ts` | `WorkspaceStore`: the single cache behind the repo list, task panel and HQ (M1-09). It is plain TS and fully unit-tested. |
| `useWorkspace.ts` | `useSyncExternalStore` binding, 2 s polling, 1 s clock (challenge expiry), and URL sync (push on selection, replace on normalization, popstate/hashchange → navigate). |
| `WorkspaceApp.tsx` | Root: shell (banner, nav "Primary", main, skip link), sign-in, alert, Activity, evidence viewer mount. |
| `ProjectsView.tsx`, `TaskPanel.tsx` | DOM campus (one repo = one building), task list, and the task detail: draft editor, proposal, execution, evidence, approval record and actions. |
| `HqView.tsx` | Approval inbox (gate filter and search), approval document with the gate controls, decision history. |
| `Evidence.tsx` | Result summary, evidence list, and the modal evidence viewer (inert `<pre>` text; withheld content shows a placeholder plus reason codes). |
| `parts.tsx` | Context, chips, `Mono`, `KV`, provenance chips, `ProposalView`. |
| `workspace.css` | All styles, scoped under `.wsm1` with its own tokens and `color-scheme: light`. No transitions or animations. |
| `*.test.ts` (10) | Unit tests (§3). |
| `dev/web-safety-entry.ts`, `dev/web-safety-build.ts` | Proves the barrel is web-safe (§2). |
| `dev/app-build.ts` | Production bundle of the whole UI in hub mode (§2). |
| `dev/fixture.html`, `dev/fixture-main.tsx`, `dev/fixture-server.ts` | UI-fixture dev page and a programmatic Vite server. The page mounts `WorkspaceApp` **without** injecting a transport, so the define switch is what selects the fixture. |
| `dev/screenshots.ts` | Headless smoke and screenshots at 1440×900 and 1280×800 (§5). |

## 2. Web-safety proof

The command is `run.sh bun --no-env-file apps/web/src/workspace-m1/dev/web-safety-build.ts`. It runs a programmatic `vite.build` with:

- `configFile: false`
- `envDir` set to an empty temp directory
- `root` set to `apps/web`
- `cacheDir` under TMPDIR
- the probe as the only input, with `preserveEntrySignatures: "strict"`, so `export * from "@agent-city/schema/workspace-m1"` keeps the whole barrel

Output goes under TMPDIR.

**Result: PASS.** One chunk of 266,270 bytes (unminified), 0 warnings, and none of `node:`, `bun:`, `Bun.`, `Buffer`, `require(`, the browser-external stub or a bare import. The contract markers are present. The built bundle was imported and run: `criteriaFromText`, `deriveWorkspacePhase` and the schema parses all returned the expected values.

**Negative control:** an entry that imports `node:crypto` → `ok:false`. It was caught by Vite's "externalized for browser compatibility" warning, by the stub check, and by the probe throwing.

`dev/app-build.ts` builds the whole UI in hub mode (plugin-react, no define, `dev/fixture.html` → `WorkspaceApp`). **Result: PASS.**

| Output | Size |
| --- | --- |
| Entry JS (React, zod, contracts, UI) | 426,880 B |
| Lazily loaded `fixture-transport` chunk | ~31 KB |
| Scoped CSS | 14,440 B |

There are no Node references and no externalization warnings. The fixture markers are absent from the entry chunk.

## 3. Commands and results

All commands ran through the isolated runner.

| Command | Result |
| --- | --- |
| `run.sh bun --no-env-file test apps/web/src/workspace-m1` | **95 pass / 0 fail** (10 files) |
| `run.sh bun --no-env-file test` (whole repo) | **1186 pass / 0 fail** (64 files), including `scripts/docs-parity.test.ts` |
| `run.sh bunx biome check apps/web/src/workspace-m1` and `apps/web` | clean (exit 0) |
| `run.sh bunx tsc --noEmit -p` for each of `packages/schema`, `apps/collector`, `apps/web`, `apps/web/e2e` | exit 0 each |
| `run.sh bun run typecheck` | **exit 1, not from this directory.** It fails in `apps/hub/src/workspace-m1/decisions/test-support.ts:314` (role 04, TS2322), so the `&&` chain stops at `apps/hub`. |
| `run.sh bunx biome check .` | **exit 1, not from this directory.** Findings are only in `apps/hub/src/managed/service.ts` and `apps/hub/src/workspace-m1/decisions/{gate1.test,gate2.test,test-support}.ts`. |
| `run.sh bun --no-env-file scripts/check-secrets.ts` | ok, scanned 254 files (this directory is untracked and was included) |
| `run.sh bun --no-env-file apps/web/src/workspace-m1/dev/web-safety-build.ts` | PASS |
| `run.sh bun --no-env-file apps/web/src/workspace-m1/dev/app-build.ts` | PASS |
| `run.sh env PLAYWRIGHT_BROWSERS_PATH=/Users/edwardhwang/Library/Caches/ms-playwright bun --no-env-file apps/web/src/workspace-m1/dev/screenshots.ts` | PASS (12/12 steps, 0 blocked, 0 `/api`, 0 console errors) |

What the unit tests cover:

- **Stale-response rejection:** task A→B, an older read of the same task, rev-monotonic merge/fold, a late challenge for A never binding to B, a viewer that was closed staying closed, a late diff never replacing the manifest, old auth-generation answers dropped, and a late 401 not signing out a new session.
- **Signature-clearing rules:** clears on subject change, gate change, success, expiry, invalidation, a definitive error, going offline and sign-out. It is kept on same-subject reselect (N-8) and on our own challenge's rev bump (hazard 1).
- **Criteria parsing:** round-trip, including commas, quotes, unicode, a blank line, a 300-char line and `\r`.
- **Decision retry:** the key is reused and the bytes are identical (hazard 2), a new key cannot start while the outcome is unknown, reconciliation works from a read, and double activation sends one POST.
- **Decision bodies (hazard 3):** `confirmation_text` is null, never `""`; `reason` is null for approve/accept.
- **Fixture transport vs contract schemas (22 tests):** every answer is re-parsed. Covers the challenge rev bump, supersede, expiry and no-consume-on-failure; replay versus `idempotency_conflict`; three lost-response faults; `live_disabled`; CAS revs; supersede on republish; terminal reject; Gate-2 request changes needing a new Gate 1; reconciler invalidation; cancel requested → confirmed; cancel at awaiting_acceptance → 409; failure without repair; one pre-approved repair, where Gate 2 binds attempt 2; evidence that is missing, withheld or corrupt; interrupted, then rerun → new Gate 1; session and read-only scope; and `seedDemo`.
- **Transport selection:** the default is hub with no global; fixture mode exposes the global; one world per page.
- **Fetch transport:** credentials, CSRF only on mutations, a 401 forgetting the CSRF, the credential travelling only in the body, byte-identical decisions, error mapping, ids validated before URLs, and 204 sign-out.
- **Boot and sign-in:** 503 `disabled` is reported as such (not offline and not a credential problem).
- **Copy audit:** no merge/push/deploy over every label, every fixture string reachable in the scenario × repair journeys, and the visible TSX text.
- **Static guards:** no `localStorage`, `sessionStorage`, `indexedDB` or `document.cookie`; no env reads; no `/hash` import.

## 4. Component and transport contract

**Mount:** `<WorkspaceApp transport?={WorkspaceTransport} activity?={ReactNode} />`.

- Without `transport`, `config.ts` decides from the define.
- `activity` is the read-only observed view, shown under "Activity" and labelled "Observed only".
- The shell renders the only banner, the only `nav "Primary"` and the only `main`.

**Fixture switch (R-N1):**

- Define `__AGENTCITY_WORKSPACE_FIXTURE__: "true"` (the string `"true"` in Vite's `define`). It is read behind a `typeof` guard; anything else means hub.
- The fixture renders `#provenance[data-source=fixture]`, labelled "UI fixture".
- It is never a URL parameter.

**Fixture controls (FX set only):** the global `__AGENTCITY_WORKSPACE_FIXTURE_CONTROLS__` exists only in a fixture build and is never rendered. Its methods:

| Method | Effect |
| --- | --- |
| `advance(taskId, evidence?)` | One engine step, scenario-driven. |
| `runToEnd(taskId, evidence?)` | Steps until nothing moves. |
| `confirmCancel(taskId)` | Termination proof: `cancel_requested` → `cancelled`. |
| `interrupt(taskId)` | Interrupts the run. |
| `invalidateRunRequest(taskId, "policy_changed"\|"repo_unavailable")` | Invalidates the pending Gate-1 request. |
| `invalidateResult(taskId, "integrity_failed"\|"candidate_mutated")` | Invalidates the pending Gate-2 request. |
| `corruptEvidence(taskId, artifactName)` | The next Accept fails closed with `integrity_failed`. |
| `expireChallenges()` | Expires all open challenges. |
| `revokeSession()` | Ends the session. |
| `setReadOnly(bool)` | Switches to a `workspace:read`-only principal. |
| `rejectNextSignIn()` | The next sign-in fails. |
| `setDecisionFault("network_before_commit"\|"lose_response_after_commit"\|"server_error_after_commit"\|null)` | Injects a lost or unknown decision outcome. |
| `setLatency(ms, route?)` | Delays answers. Routes: `session`, `snapshot`, `task`, `command`, `artifact`, `challenge`, `decision`. |
| `taskIds()` | Lists task ids. |
| `seedDemo()` | Creates draft, Gate 1 pending, Gate 2 pending, running, failed, cancel requested, rejected, accepted and a long-content task through the public routes. |

The `evidence` argument takes `"verified"`, `"truncated_log"`, `"missing"`, `"corrupt"` or `"withheld"`.

The fixture accepts any credential of 16 or more characters, and starts signed in.

**DOM contract (MATRIX §7) as built:**

- **Landmarks, names and test ids:** as specified.
- **`data-*` values:**
  - `data-gate` is `execution`/`result`.
  - `data-request-status` is the frozen `ApprovalStatus`.
  - `#acceptance-status[data-status]` is `none` or the frozen `ApprovalStatus`.
  - `#evidence-status[data-status]` is the frozen `EvidenceStatus` or `pending` (no `unavailable`).
  - `#engine-state[data-state]` is the raw `TaskState`.
  - `#cancellation-status[data-status]` is `requested`/`confirmed`, and is present only after a cancel intent. "Confirmed" requires workspace stage `cancelled`.
- **Execution id:** `#execution-id` appears only once a Gate-1 approval exists. The reserved managed task reads "Reserved, not approved to run".
- **Shared test ids:** `#attempt-id`, `#candidate-sha`, `#engine-state` and `#acceptance-status` also appear in the HQ result document. The two views are never mounted at the same time.
- **Signature field:** `type=text`, `autocomplete=off`, `spellcheck=false`, not inside any `<form>`. Enter is prevented (this covers NumpadEnter and Ctrl/Cmd+Enter).
- **Gate buttons:** all are `type="button"`. Approve/Accept are natively `disabled`, with reasons in `aria-describedby`.
- **Challenge timing:** a challenge is fetched on the first keystroke in the signature or reason field, not on open, so merely viewing never bumps the rev.
- **After a decision click:** focus moves to `output#wsm1-decision-status` ("Decision status").
- **Evidence viewer:** a modal `<dialog>` ("Evidence: <name>") with `data-artifact-id` and `data-state` (`loading`, `ok`, or `error` for missing/corrupt/stale/unknown/load failure). Content sits in `pre tabindex=0`. Escape closes it and focus returns to the opener.
- **Draft controls:** the "Repair policy" radiogroup is a `fieldset role=radiogroup`, defaulting to "No automatic repair". The "Simulation scenario" select appears in simulated mode only (R-N4). Live mode is not offered; the copy states that it is disabled.
- **Saved criteria:** after "Save draft", the saved draft's criteria render as `ol "Acceptance criteria"`.
- **Additional buttons:** "Withdraw request" (cancel while Gate 1 is pending), "Open execution approval", "Open result acceptance", "Close editor" and "Discard draft".
- **Rulings taken:**
  - N-8: reselecting the same subject keeps the signature.
  - N-11: push on selection, replace on normalization.
  - N-12: after request changes, the same task's editor opens with the draft kept. Submitting creates proposal v(N+1) and a new Gate 1.
  - N-13: Save updates the mutable draft. Versions are created only on Submit.

## 5. Screenshots (UI fixture only, never HUB evidence)

**Location:** `/private/tmp/claude-501/-Users-edwardhwang-Desktop-github-repo-only-agent-city/c776e4a4-9f35-42ac-88c3-0ce6997b4382/scratchpad/iso/tmp/agentcity-m1-fx-shots-0bjPHc/`

The directory holds 32 PNGs (`1440x900-*` and `1280x800-*`, files 01–16) plus `summary.json`.

**Setup:**

- Browser: headless shell Chromium 153.0.8010.12, fresh context, `reducedMotion: "reduce"`.
- WebGL disabled by flag; `getContext("webgl"/"webgl2") === null` was asserted in the page.
- A context route guard aborts any request not to the Vite origin and any `/api` request.
- Vite: `configFile: false`, empty `envDir`, TMPDIR `cacheDir`, a loopback port other than 4317, no proxy, HMR off.

**Asserted on every screenshot:**

- no horizontal page overflow
- the panel action footer is inside the viewport
- the J-17 regex over `main` text finds nothing

**Asserted elsewhere in the run:**

- The first focusable element is "Skip to task panel".
- There are 0 running animations.
- J-01 is driven through the real UI: the criteria are kept verbatim (3 `li`); `Edward` in lower case does not enable Approve; Enter and Ctrl+Enter are inert; the decision is approved once; the history entry is added.
- `runToEnd` (control) gives `human_ready`, Awaiting acceptance, acceptance pending and evidence verified.
- The diff viewer opens; Escape returns focus to the opener.
- The Gate-2 field is empty on arrival; Accept → accepted while the engine stays `human_ready`.
- The seeded states were inspected.

I inspected the images myself. The defects found were fixed and the run repeated:

- the list and inbox lagged the panel until the next poll (fresh reads are now folded into the snapshot)
- fixture ids rendered as `00000000`
- the engine label after acceptance was misleading
- the gate rows were cramped
- execution monitoring appeared below the proposal while running

Long content (a 120-char unbroken title, 20 criteria, a 180-char path) wraps with no overflow.

## 6. Lead-owned integration patches (proposed; not applied)

1. **`apps/web/src/App.tsx`.** In workspace mode, render only the workspace: no legacy `<header>`, no tabs, and no token-based `Tasks.tsx` (L3; A-07 needs a single banner, nav and main).
   - Move today's `App` body unchanged into `LegacyApp`.
   - Add an `ObservedView` component. It owns `filter` state and `useHub(filter)` and renders the existing `<div className="grid"><Repos/><Sessions/><Events/></div>` (it may include `ConnBadge`). It renders no `<header>` and no tabs.
   - Then:

   ```tsx
   import { WorkspaceApp } from "./workspace-m1/WorkspaceApp.tsx";
   declare const __AGENTCITY_WORKSPACE_UI__: boolean | undefined;
   const WORKSPACE_UI =
   	typeof __AGENTCITY_WORKSPACE_UI__ !== "undefined" && __AGENTCITY_WORKSPACE_UI__ === true;
   export function App() {
   	return WORKSPACE_UI ? <WorkspaceApp activity={<ObservedView />} /> : <LegacyApp />;
   }
   ```

   App's `#tasks` hash logic never fires for the workspace's `#/…` hashes. Without the switch, `WorkspaceApp` against a hub without workspace config shows "The workspace is not enabled on this hub." (503 `disabled`), with no false offline or credential message.
2. **`apps/web/vite.config.ts`** (only if you take the build-time UI switch). For example: `define: { __AGENTCITY_WORKSPACE_UI__: JSON.stringify(Boolean(env.WORKSPACE_ALLOWED_ORIGIN)) }`. That variable is already in `.env.example` and the README, so docs-parity holds. The fixture switch needs **no** change in `vite.config.ts`: it defaults to hub, and `__AGENTCITY_WORKSPACE_FIXTURE__: "false"` may be added for explicitness. `/api/workspace` is already covered by the existing `/api` proxy. The UI does not use `/ws`; it polls REST every 2 s (consistent with L4).
3. **CSS: no patch.** `workspace.css` is imported by `WorkspaceApp.tsx` and scoped under `.wsm1`; nothing goes into `style.css`.
4. **Role 09 FX harness:** two options.
   - Use `dev/fixture-server.ts` (`startFixtureServer()`), which serves `/src/workspace-m1/dev/fixture.html` with the fixture define.
   - After patch 1, serve the root `index.html` with both defines (`__AGENTCITY_WORKSPACE_UI__: "true"` and `__AGENTCITY_WORKSPACE_FIXTURE__: "true"`).

   In both cases, also set a TMPDIR `cacheDir` so that Vite does not write `apps/web/node_modules/.vite`.
5. **Hub side (L2/L7):** the exact allowed Origin must be the Vite origin (R-N5/N6). Sessions are cookie-based; the UI never sends credentials in a URL and never stores them.

## 7. Fixture-only vs needs the real hub

The fixture **does not prove** (it needs the isolated test hub):

- HttpOnly, SameSite and `Secure` cookies
- CSRF and Origin enforcement (the fixture skips CSRF)
- the boot-generation challenge void
- persistence, reload and restart
- two-tab races and session TTLs
- real challenge TTLs (N-3)
- real credential handling (the fixture accepts any value of 16+ characters)
- the 401/403/503 paths over HTTP
- `page.route` lost-response races (the fixture is in memory)

The fixture **does model:**

- CAS revs
- the challenge rev bump, supersede and expiry, with no consume on failure
- idempotent replay and conflict
- three lost-outcome faults
- invalidation (supersede, policy, integrity)
- cancel requested → confirmed
- Gate-2 integrity fail-closed
- read-only scope
- every scenario × repair outcome

## 8. Open questions and known limitations

- **R-E3 has no wire field.** `ArtifactTextResponse.text` is null unless `verified`/`truncated`, so a partially disclosed **withheld** diff cannot be shown. The UI shows a fixed placeholder plus the reason codes. This needs either a contract delta or a ruling that M1 shows reason codes only.
- **Superseded proposal versions cannot be named.** `WorkspaceTaskView` carries only `current_proposal`, so history entries for a superseded version show "proposal …xxxxxxxx" instead of "version N". Should a `proposals[]` summary be added in a later delta?
- **Cancel at `cancel_requested`.** It is in `CANCELLABLE_STAGES`, but §6 has no row for it. The fixture answers a no-op 200 and the UI hides the button. Please confirm the hub's behaviour.
- **Inbox titles can drift.** Inbox item names use the draft title from the snapshot, while the document uses the proposal title. They differ only if the draft title is edited while a request is pending.
- **Draft saves use the latest polled rev,** not the rev at which the form was loaded. A concurrent edit in another tab could be overwritten by a later save. Single operator, so this is accepted for M1.
- **No criterion-to-check mapping (OQ-5, deferred).** Verification results are shown per check, not per criterion.
- **After a boot with no answer, recovery needs a manual "Sign in";** polling is paused while signed out.
- **Not built:** monitor-only repos (none exist in M1 data, N-16); the CEO briefing (J-21 is conditional); an `axe-core` scan (not installed, N-17).

## 9. Real-hub phase (M1C): Gate 1, monitoring, cancel, restart, read-only

**How it was run.** The command is `run.sh env PLAYWRIGHT_BROWSERS_PATH=/Users/edwardhwang/Library/Caches/ms-playwright bun --no-env-file apps/web/src/workspace-m1/dev/hub-run.ts`. It uses the lead harness `apps/web/e2e/workspace-harness.ts`, loaded by dynamic import so that `apps/web`'s typecheck does not follow Bun-only code. That harness starts the hub in workspace mode in the same process, with a temp SQLite file, fake providers and live execution forced off. Vite runs with `configFile: false`, an empty `envDir`, a TMPDIR `cacheDir` and both defines; the allowed origin is the Vite origin.

**Secret handling.**
- Credentials are typed into the sign-in field and never printed.
- The cookie value, the CSRF value (read in memory from `GET /session`) and both credentials are checked to be absent from the DOM, the URL and browser storage before every screenshot. None of them is ever printed.
- A context route guard aborts anything that is not the UI origin. Nothing was blocked.

**Result: 12/12 steps PASS.** No console errors. Screenshots (18 PNGs + `summary.json`, all labelled `HUB-`) are in `/private/tmp/claude-501/-Users-edwardhwang-Desktop-github-repo-only-agent-city/c776e4a4-9f35-42ac-88c3-0ce6997b4382/scratchpad/iso/tmp/agentcity-m1-hub-shots-OVUN4L/`. Every screenshot is also checked for no horizontal overflow, the action footer inside the viewport, and no merge/push/deploy wording.

| Step | Real-hub evidence |
| --- | --- |
| Sign-in | A wrong credential gets `role=alert` and no data is rendered. With the correct credential the cookie `agentcity_ws_session` is **stored by Chromium over http loopback** (N-7): `httpOnly=true`, `sameSite=Strict`, `secure=false`, `path=/api/workspace`. It is not readable from `document.cookie`, and browser storage is empty. |
| Draft | Create, save, then edit (objective change plus a 4th criterion containing a comma), then `page.reload()`. The four criteria come back verbatim from the server. |
| Submit | Stage reads Awaiting execution approval; the pending count is 1; there is no `#execution-id`; the engine shows the reserved `draft` state. |
| Gate 1, lost request | Enter and Ctrl+Enter send no POST. The first decision POST is aborted before it reaches the hub, giving "Decision outcome unknown" with the signature cleared. "Check decision outcome" resends: **2 POSTs, byte-identical bodies**. The server shows 1 decision and stage `queued`, and the history gains one entry. |
| Monitoring | The engine goes `queued → human_ready` (the fake engine is faster than the poll). `#execution-id` and `#attempt-id[data-attempt-number=1]` appear, the candidate is shown, and 7 real artifacts are listed. The `implementation.log` viewer shows verified text from the hub reader. Escape returns focus to the opener. |
| Gate 1, request changes with the answer lost after commit | `route.fetch()` reaches the hub (which commits), then the answer is aborted. The UI reconciles from the next read to "Changes requested" with **one POST** and no resubmission. The editor reopens; criteria are edited and submitted, giving proposal **v2** and a new Gate 1. |
| Gate 1, reject | Stage Rejected; the task reads as closed; there is no `#execution-id`. |
| Cancel (`impl_hangs`) | `#cancellation-status=requested` appears while the engine is still `executing`. After the engine reports `cancelled` ("owned processes confirmed terminated") it reads **confirmed**. |
| Reload mid-gate | After typing `Edward` and reloading, the field is empty, Approve is disabled and the request is still pending. |
| `restartHub()` | The old cookie gets 401 and the UI purges and shows "Your session ended". After signing in again, the snapshot holds identical task ids, stages and pending requests. Task A is still at engine `human_ready`, the draft and proposal of the reload task are intact, the v2 request is pending, and the decision history is rebuilt. |
| Read-only principal | Data is visible. Assign work, Edit draft, the signature field, Approve and Reject are all disabled, with the reason "This session may read but not decide." |
| 1280×800 | The human_ready task, the HQ Gate-1 document, the cancelled task and the rejected task. No overflow. |

**Requests observed (counted by template; no bodies printed):**
- `POST /session` 200 / 401 (the wrong credential)
- `POST /tasks` 201
- `PUT /tasks/:task/draft` 200
- `POST /tasks/:task/proposals` 201
- `POST /approval-requests/:request/challenge` 201
- `POST /approval-requests/:request/decisions` 201
- `POST /tasks/:task/cancel` 200
- `GET /tasks/:task/artifacts/:artifact` 200
- The only 401s come from session-less boots and the restart.

**Defects found on the real hub and fixed:**
- Engine detail text was shown in red even when nothing had failed. It is now neutral unless the engine is failed, blocked or interrupted, and is prefixed "Engine:".
- While the engine is ahead of the stored stage, the stale stage detail and the "cancellation requested" hint contradicted an engine-confirmed cancel. The stale detail is now hidden, and the Task status line explains the situation.
- `cancellationStatus` now treats the engine's own `cancelled` state, after a cancel intent, as termination proof ("confirmed"). It is still never confirmed from the intent alone, and an execution that failed first never reads as cancelled. Unit-tested.
- New `engineAheadNote`. While the engine is ahead of the stored stage, the UI says so in an info banner and in the "Task status" live region. In particular, at engine `human_ready` with no result request: "Its result is not open for acceptance yet, so no acceptance is possible." No Accept control is rendered. Unit-tested.
- The top bar now says "(read only)" for a `workspace:read`-only session.
- The outcome-unknown notice no longer repeats the status line; it says that "Check decision outcome" resends the same decision.

**Blocked by missing backend behaviour (bridge, role 05).** The workspace stage does not follow the engine yet.
- After a Gate-1 approve, `GET /api/workspace/tasks/:task` → 200 with `task.stage: "queued"`, `phase: "queued"`, `engine.state: "human_ready"` and `engine.result_run_id` set. `approval_requests` holds only the approved run request: no result request, no `awaiting_acceptance`. Gate 2 (accept / request changes / reject on a result, integrity failure on tampered evidence) is therefore **not run**.
- Cancel: `POST /tasks/:task/cancel {expected_rev}` → 200, stage `cancel_requested`. The engine reaches `cancelled`, but the stage stays `cancel_requested`, because the `engine_cancelled` transition is not applied yet. The UI shows "Cancellation confirmed" from the engine together with the reconcile note.
- Not exercised yet: interrupted after restart mid-run, two-tab races, short challenge/session TTLs (R-21/R-28) and the offline transition.

## 10. Real-hub phase, part 2 (bridge wired): Gate 2 and recovery

The scripts are `dev/hub-kit.ts` (shared helpers, extracted from `hub-run.ts`), `dev/hub-run.ts` (part 1, re-run against the bridged hub) and `dev/hub-gate2.ts` (part 2). Part 2 runs with:

- `startWorkspaceEnv({ fixture: { limits: { lease_ttl_ms: 5000 } } })`, so a restart mid-run expires the old lease quickly;
- a second environment with `auth: { challenge_ttl_ms: 2000 }` for the expiry case.

Commands:

```
run.sh env PLAYWRIGHT_BROWSERS_PATH=/Users/edwardhwang/Library/Caches/ms-playwright bun --no-env-file apps/web/src/workspace-m1/dev/hub-run.ts
run.sh env PLAYWRIGHT_BROWSERS_PATH=/Users/edwardhwang/Library/Caches/ms-playwright bun --no-env-file apps/web/src/workspace-m1/dev/hub-gate2.ts
```

**Results:** part 1 is 12/12 PASS and part 2 is 10/10 PASS. Neither run had a console error or a blocked request, and no process was left running. Screenshots, all labelled `HUB-`:

| Run | Directory (under `…/scratchpad/iso/tmp/`) | Contents |
| --- | --- | --- |
| Part 1 | `agentcity-m1-hub-shots-Ue7hST/` | 18 PNGs + `summary.json` |
| Part 2 | `agentcity-m1-hub-shots-kwRElT/` | 19 PNGs + `summary.json` |

**Part 2: what passed**

| Case | Evidence |
| --- | --- |
| Gate 2 accept | The bridge opens the result request; stage reads Awaiting acceptance, the engine is `human_ready`, acceptance is pending and evidence is `verified`. The sealed `diff.patch` opens in the viewer; Escape returns focus. The Gate-2 field is empty on arrival and Accept is disabled. The candidate matches the task panel, attempt 1. Enter is inert. After `Edward` and a click: acceptance `accepted`, the engine still `human_ready`, and the copy says it "does not change any repository". The server shows stage `accepted` with an accepted decision id. |
| Gate 2 request changes | Status reads "Changes requested on the result". The task stage is Changes requested and the engine stays `human_ready`. The editor reopens; submitting gives proposal **v2** and a new Gate 1. |
| Gate 2 reject | "Result rejected"; the task is Rejected and closed; no new run is offered. |
| Tampered evidence | One bit of the sealed `diff.patch` was flipped under `artifacts_root` (the disposable fixture only). Accept → `409`; the alert reads "The result no longer verifies, so it cannot be accepted." and gives the last confirmed state (Failed, task revision 6, read after the failure) and a next action. The request becomes `invalidated(integrity_failed)` and the signature field and Accept disappear. The server shows stage `execution_ended`, nothing accepted. The task panel shows acceptance invalidated, evidence `corrupt`, and every item "Sealed status no longer valid". |
| `verification_fails`, repair 0 | Engine `failed`; stage Failed (`execution_ended`). There is no Gate 2 and no repair attempt; the failing check and the "repair limit 0" detail are shown. |
| `reject_then_approve` + Allow one repair | The Gate-1 document shows "1 pre-approved repair attempt". Attempts `[1, 2]`; the envelope and the Gate-2 document bind **attempt 2**, whose candidate differs from attempt 1's. |
| Cancel (`impl_hangs`) | Requested while executing, then stage **Cancelled**, confirmed, and engine `cancelled`. |
| Restart mid-execution | `impl_hangs` executing → `restartHub()` → sign in again. Engine `interrupted`, stage Interrupted. Attempts stay 1→1 over 5 s (no automatic relaunch), and "Request a new run" (needing a new Gate 1) is offered. |
| Challenge TTL 2 s | Typing `Edward` opens a challenge. At expiry the signature is cleared, the notice "The approval window expired…" appears, Approve is disabled and the request stays pending. Typing again fetches a fresh challenge, which approves. |
| 1280×800 | Accepted task; Gate-2 document for attempt 2; tampered task; interrupted task. |

**Defects found on the real hub and fixed:**

1. After an integrity invalidation the panel still showed the envelope's sealed statuses as current ("Verified"). New `resultRevocation()` in `labels.ts` maps `integrity_failed` → `corrupt` and `candidate_mutated` → `stale` for `#evidence-status`. Per-item chips now read "Sealed status no longer valid", and the result summary carries an "invalidated; kept for history" banner. Unit-tested.
2. The hub's reader (role 06, by design) serves a sealed result's **retained verified buffer with its sealed status** (`verified`) even after the request was invalidated. The viewer now labels that content "Verified when sealed · result invalidated" and adds a history banner, so it never reads as current verification.
3. The decision-failure alert was raised before the re-read, so its "last confirmed state" was the pre-failure state. It is now raised after the re-read.
4. The engine label for `human_ready` now reflects acceptance: invalidated, rejected, changes requested, accepted.
5. A double period in the closed-request footer.

**Observations for the lead (not blocking):**

- **Reader still serves invalidated results.** `GET /tasks/:task/artifacts/:artifact` for a required artifact of a result that is `invalidated(integrity_failed)` answers 200 with `status: "verified"` and text: the retained sealed copy, before any restart. The UI labels it as history. Should the reader return `stale` or `corrupt` (or withhold) once the result request is invalidated? That is for role 06 to decide.
- **Integrity-invalidated results read "Failed".** `deriveWorkspacePhase` (frozen) maps `execution_ended` + engine `human_ready` to phase `failed`. The hub's `stage_detail` ("the result failed revalidation and can no longer be accepted") is shown next to it.
- **Nothing remains blocked.**

## 11. Fixes after independent browser QA (09)

| Finding | Fix | Proof |
| --- | --- | --- |
| **F-1** A late 401 from an old auth generation cleared the new session's CSRF value, so every write (and sign-out) got 403. | `fetch-transport.ts` now binds the CSRF value to a session generation, bumped on sign-in, at the start of sign-out and on a 401 of the current generation. Each call remembers the generation it started in, so a stale 401 or `GET /session` answer never touches the current session. `store.signOut` always clears local state; if `DELETE /session` is not confirmed (a 401 counts as ended) it says so honestly. | 3 transport tests and 2 store tests. Real hub (`hub-run.ts` step "F-1"): hold one `/snapshot` with `page.route` → sign out (DELETE 204) → sign in → fulfil the held request with 401 → still signed in, "Draft saved", second sign-out DELETE 204. |
| **L-1** An `integrity_failed` invalidation read as `corrupt`. | `#evidence-status` now reads `data-status=unknown` with the label "Integrity check failed — evidence changed or missing" (`candidate_mutated` stays `stale`). Each item reads "Sealed status void · open to re-check". The viewer shows the hub's fresh status (R-F5) together with an invalidated-result banner. | Labels test; `hub-gate2.ts` tamper step: neutral reading, and the viewer's fresh read shows "Corrupt", `data-state=error`, no text. |
| **L-2** After a compose-panel Submit, the panel stayed in "Editing the draft…". | When a new proposal is published, the editor closes. | `hub-run.ts`: "Proposal v1" heading shown, no editor note. |
| **L-3** An approved Gate-1 document still said "Nothing has run yet". | The note now depends on the request status (pending / approved / not approved / invalidated). | `hub-run.ts`: after approval, "Approved: exactly one bounded…" and no "Nothing has run yet". |
| **L-4** An unknown deep link was explained but the URL was not normalized. | The store navigates with `routeMode: "replace"` and a `routeNotice` (unknown task, or unknown request of a known task). The hook uses `replaceState`. There is no loop, because the selection is cleared. | 2 store tests; `hub-run.ts`: hash normalized, notice shown, `history.length` unchanged after a poll. |

J-22 (post-acceptance corruption still reads accepted) is left unchanged, as the accepted OQ-10 limitation.

**Final verification:**

| Check | Result |
| --- | --- |
| Unit tests | **110 pass / 0 fail** (11 files) |
| `hub-run.ts` | **14/14** |
| `hub-gate2.ts` | **10/10** |
| Fixture regression | 12/12 |
| `app-build`, `web-safety` | PASS |
| `biome check apps/web` | exit 0 |
| `tsc` web and e2e | exit 0 each |
| `check-secrets` | ok, 299 files |

**Screenshots:**
- Part 1: `…/scratchpad/iso/tmp/agentcity-m1-hub-shots-QDetAY/`
- Part 2: `…/scratchpad/iso/tmp/agentcity-m1-hub-shots-QU2usE/`

No process of mine is left running.

## 12. Corrective phase: current acceptance validity (contract delta v1.2 §C, Fix 3)

Spec: `docs/workspace-m1/CONTRACT_V1_2.md` §C. The historical acceptance never changes (`#acceptance-status`
stays `accepted`); its **current validity** is whatever the hub reports in `acceptance_validity` (task detail and
snapshot list items). The UI never infers validity and never reads "verified" unless the hub says `valid`;
stickiness (`invalid`, `unverifiable`) is the hub's rule.

| Piece | Change |
| --- | --- |
| `Validity.tsx` (new) | `AcceptanceValidityBlock`: `div[data-testid=acceptance-validity][data-status][data-reason]`, directly under the status row of the task detail and of the HQ document of an accepted result; `role=alert` **only** for `invalid` (no Dismiss button — it describes the record). `ValidityHistoryLine`: `[data-testid=history-acceptance-validity][data-status]` on the accept entry of the HQ Decision history (own test id: HQ mounts history and document together). |
| `labels.ts` | `acceptanceValidityDisplay` (wording below), `validityShortLabel`, `VALIDITY_REASON_LABEL` (all 9 reasons), `acceptedResultRequest`, `acceptedHistory`; `evidenceStatus` / `evidenceStatusLabel` read `unknown` + "… sealed statuses kept as history" for an accepted result whose validity is not `valid` (L-1 precedent; `data-status` stays within `EvidenceStatus`). Every new string is in `allStaticCopy` (copy audit). |
| `store.ts` | `newerValidity` — the one merge rule: a validity re-check does not bump the task rev, so the rev merge cannot order it; for the same decision the newer `checked_at` wins (ties → incoming), `undefined` keeps the current value, anything else follows the hub. Used by detail reads, command answers (`detailFromView`), `mergeSnapshot` and `foldTaskIntoSnapshot` (which now carries `acceptance_validity` instead of dropping it). |
| `Evidence.tsx` | Item chips of the accepted result read "Accepted original · <status> when sealed"; `ResultSummary` (HQ) heads "Accepted result" with a history banner; the viewer labels the accepted original from the sealed copy as history (`data-history=accepted-original`, `[data-testid=evidence-history]`, status chip "… · accepted original (history)") whenever the validity is not `valid`. |
| `TaskPanel.tsx`, `HqView.tsx`, `ProjectsView.tsx` | Mount points; task list shows "No longer valid" / "Legacy acceptance" chips. |
| `parts.tsx` | `ProposalView` lists `proposalCriteriaTexts(snapshot)` (works for v1 and v1.2 rows). |
| `draft-form.ts` | `criterion_checks` (v1.2 draft field) is carried through `formFromDraft` → `draftFromForm` unchanged, so Save never strips a stored mapping (no editor yet). |
| `fixture-world.ts`, `fixture-transport.ts` | Validity row per accepted task (`valid` at accept, synthetic bundle digest); every task-detail read re-checks (a corrupted artifact of the accepted run → `invalid(source_evidence_changed)`, sticky; "check cannot run" → `unknown(verification_unavailable)`); snapshots show the stored row. An accepted result's artifacts are served from the "sealed copy" (envelope status, original text) unless the validity reason is `bundle_*` (→ corrupt / unknown, `text: null`). New control `setAcceptanceValidity(taskId, status, reason?)` with the hub's stickiness (refuses after `invalid` / `unverifiable`). Answers still parse with the contract schemas. |
| `validity.test.ts` (new, 21 tests) | Wording and alert rules for the 4 states + "not reported"; only `valid` reads verified; accepted-history evidence labels; fixture four states (incl. sticky, original still served, `bundle_corrupt` discloses nothing); `newerValidity` rules; store: a late older snapshot cannot restore "verified" after a poll said `invalid` (mutation-checked: a naive merge fails it), sticky across polls and a fresh store, `unknown → valid` follows the hub; copy audit. |
| `dev/validity-shots.ts` (new) | Fixture screenshots of the four states, the viewer and HQ at 1440×900 and 1280×800. |

Wording (`acceptanceValidityDisplay`): valid → "Current evidence verified (checked HH:MM:SS UTC)."; invalid →
"Accepted on <decided_at>, but this result is no longer valid: <reason>." + detail / first-invalid / "cannot be
restored" note; unknown → "Verification unavailable: the current evidence could not be checked …"; unverifiable →
"Legacy acceptance — no durable evidence. …"; nothing reported for an accepted result → `data-status=unknown`,
`data-reason=not_reported`, "Verification unavailable: the hub reported no current check …" (not an alert).

**BRW-J-22** (`apps/web/e2e/workspace-m1/hub.suite.ts`, lead lease, that case only) re-expressed per §C: accept (R-15
double click kept) → `acceptance-validity=valid` → flip one byte of the stored `diff.patch` under `env.fx` →
reload → poll (≤ 30 s, no fixed sleep) for `invalid`; then `acceptance-status=accepted`, reason
`source_evidence_changed`, `role=alert` visible with the §C sentence, no "Current evidence verified" text, the
Approval record keeps the accept decision with its timestamp, the decision row / receipt is unchanged, the DB
validity row is `invalid`, no pending result request and no "Open result acceptance", `evidence-status ≠ verified`,
the viewer shows the accepted original (`data-state=ok`, `data-history=accepted-original`, text byte-equal to the
pre-corruption file), the HQ document + Decision history read `invalid`, and a second reload keeps `invalid`.
`kit.ts` unchanged.

**Results (isolated runner):**

| Check | Result |
| --- | --- |
| `bun --no-env-file test apps/web/src/workspace-m1 packages/schema/src/workspace-m1` | 453 pass / 0 fail (23 files) |
| `hub.suite.ts` full run (real isolated hub + the evidence worker's backend, in progress at the time) | **104 PASS / 0 FAIL / 2 NOT RUN** (R-01, J-21 as before) / 0 BLOCKED — was 103/1/2 with J-22 failing |
| `M1_ONLY='^BRW-J-22$' hub.suite.ts` on the final UI code | **BRW-J-22 PASS** (16.1 s); G-4/G-6 then FAIL only because their source cases are filtered out |
| `fx.suite.ts` (final code) | 25 PASS / 0 FAIL / 24 NOT RUN (delegated to HUB) |
| `dev/validity-shots.ts` | 8/8 PASS, 12 screenshots, 0 blocked, 0 console errors |
| `biome check apps/web/src/workspace-m1` · `tsc -p apps/web` · `tsc -p apps/web/e2e` · repo `bun run lint` | clean (lint exit 0, 272 files) |
| `dev/web-safety-build.ts` · `dev/app-build.ts` | PASS (barrel 291,385 B, 0 warnings, no node:/bun:) · PASS (0 warnings) |

Screenshots (UI fixture only): `…/scratchpad/iso/tmp/agentcity-m1-validity-shots-0OeRMv/`; HUB J-22:
`…/scratchpad/iso/tmp/agentcity-m1-09-hub-QQMB9g/` and `…/agentcity-m1-09-hub-5DW9aZ/` (`HUB-1440x900-0{1,2,3}-J22-*.png`);
full HUB run evidence `…/agentcity-m1-09-hub-qVPAsx/`.

Limitations: the hub's list item shows the stored row (a list-only viewer sees an invalidation at the next sweep);
no criterion→check mapping editor or coverage display yet (v1.2 schema exists; not wired into publish/sealing).

## 13. Corrective phase: criterion ids, mapping and coverage in the UI (contract delta v1.2 §A, Fix 4)

The hub now publishes v1.2 proposals only and fails closed without a complete `criterion_checks` mapping; it seals
v1.2 envelopes with `criterion_coverage` and gates on `resultEligibilityV1_2`. The UI authors the mapping, shows
the ids and the plan at Gate 1, and per-criterion coverage at Gate 2 and in the task detail. Nothing is inferred.

| Piece | Change |
| --- | --- |
| `draft-form.ts` | `DraftForm.criterionChecks` = exact criterion text → checks. `toggleCheck` (keeps the repo's check order), `checksFor`, `formCriteria`, `unmappedCriteria`, `mappingForDraft` (criteria order, entries with ≥ 1 check, keys of removed / edited lines pruned; no entry → key omitted so legacy drafts keep their bytes). `publishIssues(form, requiredChecks)` adds the hub's own rules (`criterionCoverageProblems`) as "criterion N: …"; unknown repo checks block. `readableIssuePath` reads server paths (`criteria.1` → "criterion 2"). |
| `TaskPanel.tsx` | `CriterionChecksEditor` under the criteria textarea (compose panel and task editor): `section[data-testid=criterion-mapping][data-unmapped]`, one `fieldset` per line named "Checks for criterion N" (`data-mapped`), one checkbox per trusted check (label = check name), the criterion text as its description, a live "N of M criteria have no check" line. Nothing preselected. Submit stays disabled while any criterion is unmapped (reasons listed next to it). Checks come from the snapshot's `repos[]`. |
| `parts.tsx` | `CriteriaPlan` in `ProposalView` (Gate-1 document, task detail): table "Criterion checks" (`[data-testid=criteria-plan][data-status=mapped]`, rows `[data-criterion-id][data-checks]`); a legacy v1 proposal reads `data-status=legacy` "… No criterion coverage — a new proposal and approval are required." The `Acceptance criteria` list keeps the plain text (existing assertions unchanged). |
| `Coverage.tsx` (new) | `CriterionCoverageView` (Gate-2 document, first block of the result summary) and `TaskCoverage` (task detail, before the evidence list): `[data-testid=criterion-coverage][data-status]` = worst criterion status (never a green count), rows `[data-criterion-id][data-status]` with each mapped check `li[data-check][data-outcome][data-log]` and the log identity (artifact id tail + sha256 prefix, full values in `title`). Legacy v1 result → `data-status=legacy` + the note, no rows. No sealed result → `none` ("No result was sealed for this execution, so no criterion is covered.") or pending. |
| `store.ts` | Server issues rendered verbatim with readable paths; `acceptance_validity` always explicit (`null` when absent) in cached details and snapshot items (the field is now required-nullable); the stale-badge rule (`newerValidity`) unchanged. |
| `fixture-world.ts`, `fixture-transport.ts` | Publishes v1.2 via `composeProposalSnapshotV1_2` (400 `invalid_request` + the same issues as the hub for unmapped / dangling / untrusted / duplicate). Criterion ids are visibly synthetic (`crit-cc…NN`) but text-stable per world (same text → same id, edited → new id), never a digest. Envelopes are v1.2 with `deriveCriterionCoverage`; eligibility = `resultEligibilityV1_2`. New evidence variants `log_missing` (→ unresolved) and `check_failed` (fixture-only: the real engine fails such an attempt before sealing). Control `setLegacyContract(on)` publishes v1 proposals (→ v1 envelope, ineligible `criteria_unmapped`). `seedDemo` maps every criterion except the plain draft. |
| tests | `coverage.test.ts` (new, 15): hub-like 400s (no Gate 1), store renders the issues, ids + plan, one edited criterion → one new id, coverage satisfied / unresolved / unsatisfied, no-result and legacy rendering, static markup of the components. `draft-form.test.ts` (+4), `validity.test.ts` (+1 explicit-null). |

**Expectation changes (contract change, not weakening):** unit-test drafts that are published now carry a
mapping (`fixture-transport.test.ts` `draft()`, `store.test.ts`, `copy.test.ts`, `validity.test.ts`); the happy-path
criteria assertion compares `proposalCriteriaTexts(snapshot)` (same strings) and additionally pins v1.2 + the plan;
"a complete draft has no publish issues" now means title + objective + criteria **+ mapping**.

**Browser suites** (lead lease, whole files): `kit.ts` `fillDraft` authors the mapping through the checkboxes
(`DraftInput.mapping`: `"all"` default | `"none"` | per-line names; `mapCriteria`, `criterionGroups`, `planRows`,
`coverageRows`). Journeys that edit a criterion line now map the new line (`hub.suite` J-04 and J-06 v2,
`fx.suite` J-04). J-01 gains assertions: C3 nothing preselected, Submit disabled with every unmapped criterion
named, enabled after mapping; C5 the 3 unchanged lines keep their checks, the new line starts unmapped, DB mapping keyed
by the exact criteria; C7 the Gate-1 plan rows equal the DB v1.2 snapshot ids + checks. A-05 maps both criteria with
Tab + Space (still zero mouse events). New HUB cases: **BRW-C-01** unmapped criterion: editor blocks Submit; a stale
save (outgoing PUT rewritten without the mapping) reaches the hub → 400 `invalid_request` shown verbatim, 0 requests;
honest resubmit → v1.2 Gate 1. **BRW-C-02** coverage in the task detail = Gate-2 document = DB sealed coverage, ids =
proposal ids. **BRW-C-03** failing check: the engine fails before sealing → no result request, coverage `none`, no
acceptance (a hub that sealed it would have to show `unsatisfied`; asserted if it ever does). **BRW-C-04** one edited
criterion → only its id changes (DB v1 vs v2 + UI plan). New FX cases **BRW-C-01…05** (C-03 = fixture `check_failed`
→ unsatisfied rows + invalidated, C-05 = legacy).

**Results (isolated runner, final code, backend v1.2 integration in place — no hub/schema file changed during the runs):**

| Check | Result |
| --- | --- |
| `bun --no-env-file test apps/web/src/workspace-m1 packages/schema` | 612 pass / 0 fail (30 files; web 151 in 13 files) |
| `hub.suite.ts` full | **108 PASS / 0 FAIL / 2 NOT RUN** (R-01: one allowlisted repo; J-21: no CEO briefing in M1) / 0 BLOCKED; 273 mutations all with CSRF + exact Origin; 0 console errors; 38 screenshots — evidence `…/scratchpad/iso/tmp/agentcity-m1-09-hub-AeuUdK/` |
| `fx.suite.ts` full | 30 PASS / 0 FAIL / 24 NOT RUN (delegated to HUB); 14 screenshots — `…/agentcity-m1-09-fx-YO8Npj/` |
| `web-safety-build` · `app-build` | ok (291,706 B, 0 warnings) · ok (0 warnings) |
| `bun run typecheck` · `bun run lint` · `check-secrets` | exit 0 · exit 0 · ok (326 files) |

Not done here: `MATRIX.md` (outside the lease) does not list the new BRW-C-* ids yet; no mapping editor for
criteria longer than the panel beyond wrapping; the HUB cannot produce an `unsatisfied` criterion (the engine fails a
failing check before sealing), so that rendering is proven in FX (`check_failed`) and unit tests.

## 14. Lead-delegated UI items (Worker A, under lease): obsolete v1 grants, validity freshness, version labels

**Validity freshness (UI policy only).** `labels.ts` `validityFreshness(checked_at, now, conn)`:
`VALIDITY_STALE_AFTER_MS = 60_000` — a last check older than 60 s (two default 30 s sweep intervals; a detail read
re-checks after 5 s, so an open task detail stays well inside it) reads "Last check <age> ago (<time>) — may be out
of date."; `CONNECTION_STALE_AFTER_MS = 10_000` — no confirmed hub read for 10 s (five missed 2 s polls), or the
connection `offline` / `connecting`, makes the reading stale too ("… the connection to the hub is offline or
stale."). Age = this browser's clock − `checked_at`, floored at 0 (a future stamp from clock skew reads as just now).
Rules: the hub's status is never rewritten (`data-status` stays the hub's; `data-freshness=fresh|stale` is added);
a stale `valid` is neutral, never green, and never says "verified" (block, history line, `#evidence-status` →
"Valid at the last check — may be out of date"); `unknown` / `unverifiable` / not reported are never green; an
`invalid` validity keeps its non-dismissable `role=alert` in task detail and the HQ document, and the HQ history
line is a visible warning that is itself the announced alert when the document does not show that acceptance (one
announced alert per view). `[data-testid=validity-freshness]` sits inside `#acceptance-validity`. The threshold is a
presentation choice, not a detection guarantee (CONTRACT_V1_2.md §C).

**Obsolete v1 grants.** The hub's 409 `stale_binding` issue (`issues[0].message`) replaces the generic copy in the
challenge and decision paths (`errorCopyOf`, store copy path); a Gate-1 request invalidated with
`evidence_unavailable` reads "Invalidated: obsolete v1 proposal — publish a new version and request a fresh
execution approval." (`invalidationLabel`, never the evidence wording); after the re-read the gate notice and the
HQ document (`[data-testid=obsolete-grant][data-status=retired]`) say so and no decision control remains; a pending
request bound to a legacy proposal shows `data-status=pending` with Approve disabled; "Request a new run" is hidden
for a legacy proposal. Fixture mirror: challenge / decision on a legacy Gate 1 → 409 + the hub's issue, request
invalidated, reservation cancelled, task → draft; an approved legacy execution is refused before every engine step
(`approval_void`); control `runLegacyBeforePolicy(taskId, evidence?, steps?)` replays pre-policy history.

**Version labels.** `proposalVersionLabel`: "Proposal vN" for the current proposal and its predecessor (the view
carries only the current snapshot), "Earlier proposal …<id>" otherwise — HQ history, Approval record, HQ identity.
**Coverage definition** (`COVERAGE_SATISFIED_NOTE`) under the Gate-1 criterion → check plan. Tests:
`obsolete-grant.test.ts`, `freshness.test.ts`; `coverage.test.ts` legacy case now uses `runLegacyBeforePolicy`.
Outside the lease (proposed to the lead): `Coverage.tsx` inline "satisfied" sentence → `COVERAGE_SATISFIED_NOTE`;
`gate.ts` generic invalidation notice (overridden in the store for obsolete grants); FX `BRW-C-05` (approves a
legacy Gate 1 through the UI, now refused).
