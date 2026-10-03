# M1 lead integration plan (lead-owned)

Lead-owned changes to existing/shared files, derived from reading the baseline. Workers supply the
modules; the lead wires them. Each item lists the existing code it touches.

## L1 Migration registration
Copy the accepted `008_workspace_approvals.sql` from `apps/hub/src/workspace-m1/persistence/` into
`packages/schema/migrations/`. `apps/hub/src/db.ts:migrate()` applies files above `PRAGMA user_version`;
nothing else is registered. Never edit `006`/`007`.

## L2 Workspace API mount
New lead-owned `apps/hub/src/routes/workspace.ts` mounted at `/api/workspace` in `createApp`
(`apps/hub/src/index.ts`), composed from the auth middleware (03), persistence (02), decisions (04),
bridge (05) and evidence (06) modules. Off (503) unless the workspace M1 environment is configured.

## L3 Legacy bypass closure
- `apps/hub/src/routes/managed.ts` `POST /tasks/:id/run` (`runTask` → `requestRun`, Run-as-approval with
  a bearer token) and `POST /tasks`: not reachable when workspace mode is on (legacy managed API answers
  410 for every route in workspace mode).
- Orchestrator: `approvalHolds()` (`apps/hub/src/managed/orchestrator.ts`, rechecked before every stage)
  gains an injected workspace authorization check: a managed task runs only if it is linked to an
  approved, still-valid Gate-1 decision with a matching execution binding. This also stops rows queued
  by any other path (direct DB writes, legacy routes).
- `apps/web/src/App.tsx` stops rendering the token-based `Tasks.tsx` tab in workspace mode.

## L4 Public WebSocket
`startHub` publishes `broadcaster.publish("managed", {task_id})` (`apps/hub/src/index.ts`) on the
unauthenticated `/ws`. Remove it; the workspace UI polls authenticated REST. `BroadcastKind` loses
`managed` once no producer remains.

## L5 Simulated-only enforcement
Contract rejects `live`; the authoritative entry point (proposal publish / execution request) rejects it
again server-side; the orchestrator refuses a live workspace task before preflight. Workspace hub is
started with `live.enabled=false` and fake adapters only. Provider/preflight counters prove zero calls.

## L6 Engine → workspace reconciliation
On managed-task change (orchestrator `onChange`) and on startup, the bridge maps engine state to the
workspace stage; at engine `human_ready` it seals evidence, builds the result envelope and opens the
Gate-2 request. Engine `human_ready` is unchanged and never means accepted.

## L7 Origin, sessions, env
Exact workspace UI origin (incl. port) for mutations; HttpOnly SameSite=Strict session cookie; CSRF.
Every new env var goes into `.env.example` and the README table (enforced by
`scripts/docs-parity.test.ts`).

## L8 Web integration
`apps/web/src/App.tsx` mounts the workspace/HQ view from `apps/web/src/workspace-m1/`; the existing
telemetry view stays read-only and labelled "Observed only".

## Lead rulings (v1)

From 09 (`apps/web/e2e/workspace-m1/MATRIX.md` §10):
- R-N1 Fixture transport: a Vite `define` constant (default `hub`), settable by a programmatic Vite server;
  never a URL parameter; fixture mode renders `data-source=fixture`.
- R-N4 Failure scenarios: `simulation_scenario` is part of the immutable proposal, chosen in the draft
  form (simulated mode only). No seeding back door.
- R-N5/N6 `startHub` takes a workspace option (exact allowed UI origin, bootstrap credential, TTLs, test
  identities); the harness proves run identity through the proxy before mutating.
- R-N7 `Secure` cookie only when the configured workspace origin is `https:`; the plain-http loopback
  harness omits it. Documented as transport-aware, not a weakening: exact Origin + CSRF + HttpOnly +
  SameSite=Strict still apply (note L-09: other loopback ports are same-site, so Origin+CSRF are the
  real cross-port defence).
- R-N3 Challenge and session lifetimes configurable through the hub option, clamped to maxima
  (challenge ≤ 5 min, session ≤ 12 h).
- R-N2 Deterministic "cancel requested, not yet confirmed" window: provided by the bridge/test harness
  (e.g. the existing `impl_hangs` scenario plus a hold hook), not by production code paths.

From 08 (`apps/hub/test/workspace-m1-adversarial/MATRIX.md` §6):
- R-A1 Cancel after engine `human_ready` (awaiting acceptance): `409 invalid_state`; there is no running
  work to cancel. The operator uses Reject. A pending Gate-2 request is unaffected.
- R-A2 A failed decision attempt has **no durable effect** (the transaction rolls back): a mismatched,
  expired or wrong-binding use does not consume the challenge. One outstanding challenge per approval
  request; issuing a new one supersedes the previous (which becomes unusable).
- R-A3 Mutations without an `Origin` header → `403 forbidden_origin`.
- R-A4 Fix labels: C1–C5 (as in `corrective.test.ts`/BASELINE), cross-referenced to the spec's 1–5.
- R-A5 A second, read-only test principal (`workspace:read` only) may be configured through the hub
  option for tests; production config has exactly `operator:edward`.
- R-A6 In workspace mode `/api/managed/*` answers `410` for every route; the engine stays an internal
  boundary. Outside workspace mode the legacy API is unchanged (baseline behaviour).
- R-A7 The omitted-hunk positive control runs against the unchanged baseline `redactDiff` function in
  the same checkout (06 includes it); no separate archive.
- R-A8 Only successful decisions create receipts. Payload equality = the canonical decision payload as
  frozen by 01 (everything except the challenge).
- R-A9 Gate 2 fails closed (`409 integrity_failed`) if the candidate workspace no longer matches the
  candidate commit/tree, or if any required evidence fails verification.
- R-A10 `/api/workspace` GET with a present, non-exact `Origin` → 403; GET without `Origin` is allowed
  with a valid session (browsers omit it on same-origin GET). No credentialed CORS for foreign origins.

Additional lead decisions from the 08 legacy audit (L-xx): repair never follows scope-expanding,
corrupt-evidence, protocol, auth or unknown-authorization findings (L-11); a truncated diff or incomplete
review context makes the result ineligible (L-13); new workflow tables never `ON DELETE CASCADE` from
`managed_tasks` (L-15); `api.test.ts` "/ws announces ids only" is updated by the lead when L4 lands
(L-17); `demo.ts` stays a legacy, non-workspace tool and is documented as such (L-16).

From 06 Part A (`apps/hub/src/workspace-m1/evidence/`, complete-context disclosure):
- R-E1 A truncated or withheld diff blocks: the result is ineligible for acceptance and the reviewer never
  receives withheld content (accepted; consistent with L-13).
- R-E2 Conservative over-masking is accepted for M1 (single disposable fixture repo). Precision per file
  type is follow-up work, listed as a known limitation.
- R-E3 (superseded after 06 Part B) No partial display in M1: the reader follows contract v1.1 — a withheld
  item returns `text: null` with reason codes only. A withheld diff fails the attempt before review
  (`evidence_invalid`); its stored placeholder rendering holds no raw content.
- R-E5 Transient seal failures (`timeout`, `repo_unavailable`, `candidate_unavailable`) at Gate 2 map to
  `409 evidence_unavailable` and do NOT invalidate the pending request; integrity failures do.
- R-E6 Accepted limitations: the worktree check honours `.gitignore` (ignored files are not detected; the
  bound deliverable is the candidate commit/tree); a review output truncated at storage is corrupt (fails
  closed); retained verified bytes are memory-only (lost on restart → re-read and re-verify).
- R-E4 Synchronous CPU cost: default limits kept for M1 (fixture-sized diffs); the call runs in the
  worker's evidence step, not in an HTTP handler.
- Integration (lead, M1B): orchestrator diff evidence step uses `listDiffFiles` → `loadDiffContexts` →
  `decideDiffDisclosure` instead of `redactDiff` alone; `gitRunner` adapter in `git.ts`; context limits in
  config; manifest/envelope disclosure status via the frozen contract.

## Lead integration status

| Item | Status | Evidence |
| --- | --- | --- |
| Schema subpath exports, QA tsconfig includes | done | typecheck exit 0 |
| L4 public `/ws` carries no managed frames/ids | done | `api.test.ts` asserts absence (was: asserted ids) |
| `createTask` accepts a pre-minted `task-<uuid>` (execution binding covers the id) | done | used by 02 |
| `OrchestratorDeps.authorize` checked with the approval binding before every stage (L-04 hook) | done | `authorize.test.ts` 4/0: denied → `approval_void`, zero preflight/implement/review calls |
| Contract delta v1.1 (`api.ts`) | done | 280 pass incl. web-safety import test |
| Evidence integration: orchestrator diff step uses complete-context disclosure (withheld → `evidence_invalid` before review), `gitRunner`, context/evidence limits in config, atomic no-follow `writeArtifact` (L-14) | done | managed + evidence suites 282/0 (incl. corrective C3) |
| L1 migration `008` registered byte-identical; `db.ts` busy_timeout before WAL + version re-read inside an immediate tx | done | full suite after registration: only expected failures, fixed (hub basics → 16 tables/v8; 02 tests rebuilt on a genuine 007 DB, 64/0) |
| L3 legacy `service.runTask` refuses workspace-governed executions (`409 workspace_governed`) | done | |
| `corsGuard` exempts `/api/workspace/*` (auth P2) | done | hub.test 48/0 |
| L7 env `WORKSPACE_OPERATOR_CREDENTIAL`, `WORKSPACE_ALLOWED_ORIGIN` in `.env.example` + README; CLAUDE.md ≡ AGENTS.md workspace convention | done | docs-parity green |
| L8 `App.tsx` renders `WorkspaceApp` (+ read-only `ObservedView`) under `__AGENTCITY_WORKSPACE_UI__`, legacy otherwise; Vite define | done | web tests + parity 128/0; `build:web` ok |
| L2 `/api/workspace` mounted (`workspace-hub.ts`: one DB handle, one simulated-only config, auth.install first, 04 router, 06 sealer/reader with one retained store); L3 legacy `/api/managed` → 410 in workspace mode; L5 live forced off (`simulatedOnly`); env wiring in `index.ts` (credential never logged) | done | `workspace-hub.test.ts` 4/0 on a real loopback server: sign-in → publish (201) → Gate 1 → one execution to human_ready, replay, 410, live forced off, 503 when unconfigured |
| Isolated env harness `apps/web/e2e/workspace-harness.ts` (hub + Vite, free ports, TMPDIR cacheDir, restartHub) | done | smoke: sign-in via proxy 200, identity true, restart → old cookie 401, no repo cache writes |
| L6 bridge (05) wired: `authorize` = `OrchestratorDeps.authorize`, `onChange` → `bridge.notify`, startup + periodic sweep, router uses `bridge.port`; orchestrator L-11 repair patch applied (scope-expanding findings / revoked authorization never repair) | done | `workspace-hub.test.ts` 5/0: Gate 1 → engine → seal → Gate 2 accept (engine stays human_ready, 1 result request) + a row queued outside Gate 1 is blocked `approval_void` with 0 runs; bridge 66/0 with the post-patch repair tests |

### M1B gate (2026-10-02, isolated runner)

`bun run lint` clean (240 files) · `bun run typecheck` exit 0 · `bun --no-env-file test` **1292 pass / 0 fail**
(78 files, 116 s) · `check:secrets` ok (280 files) · source integrity: v011 and main tracked files and the SOL
design byte-identical to the pre-M1 snapshot; nothing on 4317. Not yet run: independent adversarial (08) and
browser (09) suites, Gate 2 in the browser (07).

Accepted limitations recorded at M1B: moved base → `invalidated(repo_unavailable)` with detail (no
`base_changed` delta); transient seal failures retry on notify/sweep (≤ 3 per execution per process, counter
in memory); bridge alarms in memory only (no durable store/UI); one reconcile queue per process; no
post-acceptance integrity re-check (OQ-10); repair reuses the same worktree (fresh attempt workspaces are a
pre-live item, SOL stage 3).

From 03 (`apps/hub/src/workspace-m1/auth/NOTES.md`) — accepted deviations:
- R-U1 GET without `Origin` is also rejected when `Sec-Fetch-Site` is present and not `same-origin`/`none` (stricter than R-A10).
- R-U2 Up to 4 concurrent sessions per principal (multiple tabs; matrix rows assume two). Option stays configurable.
- R-U3 The read-only test principal is `operator:edward` with `["workspace:read"]` only (operator id is frozen); harness `login("operator:viewer")` maps to the read-only credential.
- R-U4 The ephemeral credential is reusable for re-login after logout/expiry/restart (per-run, high entropy).
- R-U5 Whitespace-padded `Origin` values are normalised by HTTP/Fetch; not a bypass.
- R-U6 One challenge error code (`challenge_invalid`), per frozen §7.
- Accepted limitations: no sign-in rate limit (per-run high-entropy credential); duplicate session cookies fail
  closed (a page on another loopback port can block sign-in but never gains a session); no `__Host-` prefix
  (needs `Path=/`); privileged local attacker and remote/production use out of scope.
- Integration (lead): `auth.install(ws)` before any route; `base_path` = mount prefix; `/api/workspace`
  mounted before `/api`; `corsGuard` exempts `/api/workspace/*`; env `WORKSPACE_OPERATOR_CREDENTIAL` +
  `WORKSPACE_ALLOWED_ORIGIN` (blank → disabled) in `.env.example` + README.

From 07 (fixture phase, `apps/web/src/workspace-m1/NOTES.md`):
- R-F1 M1 shows reason codes only for withheld evidence (R-E3 superseded); no `partial_text` delta.
- R-F2 Naming superseded proposal versions ("version N") in history is deferred (limitation; a
  `proposals[]` summary is a future additive delta).
- R-F3 Cancel at `cancel_requested` = idempotent 200, no writes (CAS rev still checked). Sent to 04.
- R-F4 Accepted 07 rulings: N-8 reselecting the same subject keeps the signature; N-11 selection pushes
  history; N-12 request-changes reopens the same task's editor and submit creates a new version; N-13 Save
  updates the draft, only Submit creates a version.
- Integration (lead): App.tsx renders `<WorkspaceApp activity={<ObservedView/>}/>` in workspace mode
  (build-time define `__AGENTCITY_WORKSPACE_UI__`), legacy body otherwise; `Tasks.tsx` never in workspace
  mode; Vite/test harnesses set a TMPDIR `cacheDir` (07 moved one stray `apps/web/node_modules/.vite`
  cache it created to the scratchpad; nothing tracked was touched).

From 07 (M1C on the real hub: part 1 12/12, part 2 10/10):
- R-F5 Once a result request is `invalidated`, the artifact route re-verifies from disk (no retained sealed
  shortcut): a tampered required artifact reads non-verified with `text: null`. Pending/accepted/rejected/
  changes-requested results keep serving their sealed verified bytes as history. Lead fix in 04's
  `read-model.ts` under lease; regression in `workspace-hub.test.ts`.
- R-F6 The frozen `deriveWorkspacePhase` labels an integrity-invalidated result (`execution_ended` + engine
  `human_ready`) as phase "Failed"; the stage detail explains it. Coarse label accepted for M1 (limitation).

From 08 run 1 (`docs/workspace-m1/QA_ADVERSARIAL.md`):
- R-Q1 F-01 fixed by 04: workspace draft title/objective/criteria pass through the shared `redact()` before
  storage on create and save; re-validated, over-length after redaction → 400 (never truncated); create
  `request_hash` over the redacted draft, so two bodies differing only inside a masked secret replay as one
  request (same rule as OQ-3). Publish freezes byte-identical text from the stored draft.
- R-Q2 OBS-01 accepted: a candidate tampered to a nonexistent commit is classed transient (`409
  evidence_unavailable`, request stays pending, nothing accepted); listed as a limitation.


## Corrective v1.2 (after the independent Codex review) — lead rulings

- R-V1 Final authority uses a clock read inside the decision/challenge transaction (Fix 1).
- R-V2 Evidence policy "both": a source artifact change, bundle failure or candidate commit/tree mismatch after
  acceptance makes the current acceptance `invalid` (sticky) and raises an alert; the historical decision and
  the bundle bytes stay (served labelled as history). Worktree drift is outside the accepted contract.
- R-V3 Migration 010 (table rebuild of `managed_proposals` to widen 008's CHECK) approved after review; 008 is
  never edited.
- R-V4 Criterion ids are derived from the stored criterion text (`crit-` + 16 hex of sha256); edits are
  replacements; coverage is never inferred; legacy v1 proposals are readable but never acceptable.
- R-V5 Expectation changes made by the lead for the new contract (none weaken a safety assertion):
  `gate1.test.ts` expiry test drives the authoritative clock; `gate2.test.ts` receipt effects include the bundle
  digest; 08 ADV-EVID-14b/15 expect the original bytes from the bundle (+ validity invalid); 09 J-22 re-expressed
  per CONTRACT_V1_2 §C; test draft builders map each criterion explicitly to `fixture-check`.
- Details and evidence: `CORRECTIVE_V1_2.md`.

## Campus milestone (P2 follow-ups + business-campus port) — lead rulings

- R-C1 Obsolete v1 execution grants are refused server-side: a Gate-1 request whose proposal is not v1.2 is
  invalidated (`evidence_unavailable`, fixed detail) on the first challenge/decision attempt (409 `stale_binding`,
  no decision) or by the bridge sweep; reservation released, task → draft; `authorize()` denies an approved v1
  execution before every stage (`approval_void`); queued/active v1 executions get a cancel intent and end only
  when the engine confirms. No migration (state already expressible).
- R-C2 Validity freshness is UI policy only (`VALIDITY_STALE_AFTER_MS` 60 s, `CONNECTION_STALE_AFTER_MS` 10 s):
  `data-status` stays the hub's value, `data-freshness` is the UI reading; a stale `valid` is never green; docs no
  longer promise a "next sweep" or a universal 5 s / 30 s bound (CONTRACT_V1_2 §C).
- R-C3 The campus is presentation only, behind the frozen `campus/presentation.ts` interface
  (`agentcity.campus-presentation/v1`): read-only `CampusModel` from the existing store state, three
  selection/navigation intents (`selectRepo`, `selectTask`, `openRequest`). CEO visits are keyed by the server's
  stable `request_id` and anchored to `created_at`; arrival/animation never sends a command. Both gates stay in
  the DOM document with a freshly typed `Edward`.
- R-C4 Mount: `CampusSlot.tsx` above the unchanged Projects navigator (Repositories kept for the existing browser
  contract) and above the HQ Inbox. The Headquarters button opens the selected or oldest pending document
  (selection only). Three.js 0.186.1 (user-approved) is lazy-loaded once; the >500 kB chunk warning is reported,
  not suppressed. No WebGL / context loss / init failure → static DOM layer with the same buttons.
- R-C5 QA findings F1 (campus document buttons showed no title) and F2 (obsolete chip overflow) are product
  defects, fixed by Worker B; campus counts say "running" (in-flight execution phases), distinct from the
  Repositories card's "active tasks" (every task not accepted, rejected or cancelled). Worker C's one helper adaptation to the new markup kept
  its threshold.
- Record: `CAMPUS_MILESTONE.md`.
