# Multi-repository simulated workspaces and CEO briefings — milestone record (lead)

Scope: at least two independently selectable, persistent simulated repositories; repository-scoped task and
approval navigation; deterministic CEO status briefings from recorded state; regression coverage for the
repository A→B journey (R-01) and the briefing (J-21); a narrow stabilization pass (CI wrapper interruption,
P-06 cancellation window, R-23/R-24 orderings, legacy focus recovery). Simulated only: no live providers, no
personal-repository execution, no model-generated briefings, no meetings, no distributed scheduling.

## Phase 0 — baseline identity (recorded before any edit, 2026-10-03T12:53Z)

| Item | Value |
| --- | --- |
| Checkout | `/Users/edwardhwang/Desktop/github-repo-only/agent-city-m1` |
| Branch | `feat/workspace-approvals-m1` |
| HEAD | `eeeef8553fe6e30511abc0710370782cd77f34a7` |
| GitHub remote ref (`git ls-remote`) | `refs/heads/feat/workspace-approvals-m1` = `eeeef8553fe6e30511abc0710370782cd77f34a7` (no newer commits) |
| `origin` | the local `agent-city` checkout (fetch); push URL `DISABLED-no-push-from-m1` (kept) |
| Working tree | clean: 0 modified, 0 untracked, 0 stashes |
| Last CI on HEAD | run 37101861244 (push of `eeeef85`): success, all jobs |
| Tooling | bun 1.4.2, git 2.53.0, cached Playwright Chromium headless shell; no installs or upgrades |
| Port 4317 | nothing listening; never used by this milestone |
| Independent review in progress | none found (no review record in `docs/`, no review artifacts); the four stabilization concerns are reproduced independently, not assumed |

Untouched throughout: the real database and `data/`, port 4317, sibling checkouts (`agent-city`, `agent-city-v011`),
personal credentials, `~/.claude`, `~/.codex`, shell rc files, `.env`.

## What already supported multiple repositories (read before extending)

- Trusted config: `ManagedConfig.repos` holds 1–20 entries with unique ids; `policyHash(config, repoId)` covers
  only that repository's entry, so one repository's config change never voids another's approval.
- Repository ownership is immutable and server-checked: `workspace_tasks.repo_id` cannot change (migration 008
  trigger); the store refuses a proposal snapshot whose `repo_id` differs from its task's; the sealer, Gate-1
  authorization and the decision service all recompute policy from the task's own repository.
- The artifact route serves an artifact only if it belongs to one of that workspace task's own executions.
- The engine claims one execution globally (`claimNext`: nothing while any task is leased or any quarantine is
  open; resumable active work first, then queued work by `run_requested_at`).
- The snapshot already lists `repos[]` (the allowlist) and every task with its `repo_id`; the UI route is
  `#/projects/<repo>/<task>`; the campus presentation model already places one building per repository.

Missing before this milestone: a second fixture repository in the harness and preview, observed-only
repositories in the workspace, an authoritative cross-repository queue for accurate "waiting" labels, the
briefing, repository labels and filtering in Headquarters, and tests that exercise two repositories.

## Frozen interface (lead, before parallel work)

**API delta v1.2** (`agentcity.workspace-api/v1.2`; additive to the v1.1 route table — no new routes; not the
proposal/result contract v1.2). `packages/schema/src/workspace-m1/api.ts`:

- `WorkspaceTaskListItem` += `engine: EngineView | null` (the same value the task detail carries) and
  `latest_request: RequestSummary | null` (newest approval request, any status: id, kind, status,
  invalidation_reason, created_at, closed_at).
- `WorkspaceSnapshot` += `execution_queue: ExecutionQueue` — `active` (the single engine slot: the leased
  execution, else the active one that resumes first), `queued` (claim order), `claims_paused_by_quarantine`.
  Built from `claimOrder()` in `apps/hub/src/managed/store.ts`, which `claimNext` now also uses, so the queue
  shown is the order the worker claims in.
- `WorkspaceSnapshot` += `observed_repos: ObservedRepo[]` — `{repo_id, source: github | local_checkout |
  telemetry}` from the existing telemetry `repos` table and `sessions.repo_id`, minus the allowlist
  (case-insensitive). Display only: `POST /tasks` still answers 422 `repo_not_allowed` for these ids.

**Test-only plumbing.** `HubOptions.managedHooks` (orchestrator hooks; `main()` never sets it);
`startWorkspaceEnv({ extraRepos, observedRepos, managedHooks })` → `env.repos[]` (primary first,
`local/m1-fixture-<nonce>`; extras `local/m1-<label>-<nonce>`, each its own git repository with a distinct
base commit) and `env.observedRepoIds` (`observed-example/<label>-<nonce>`); `makeFixture({ extraRepos })`.
The preview (`dev/preview-hub.ts`) starts `fixture`, `beta`, `empty` and one observed-only repository.

**Frozen DOM hooks** (UI implements, QA asserts):

| Surface | Hook |
| --- | --- |
| Repository list | `button[data-repo-id][data-repo-kind="allowlisted"\|"observed"]`; observed rows say "Observed only" and offer no Assign work |
| Task panel | `[data-testid="task-repo"]` = the shown task's repository id; `[data-testid="queue-status"]` = queue line of a queued/active execution |
| Briefing | `section[aria-label="CEO briefing"][data-repo-id][data-briefing-state]` (`loading`, `empty`, `idle`, `active`, `attention`, `observed` — an observed-only repository: no work can be assigned or executed) `[data-freshness]` (`current`, `stale`, `offline`); `[data-testid="briefing-summary"]`; items `[data-briefing-item=<kind>][data-task-id]` (+ `[data-request-id]`), each with a control that navigates (no transport call) |
| Headquarters | inbox item `button[data-request-id]` containing `[data-testid="inbox-repo"]` and the gate label; a filter select labelled "Repository"; document `[data-testid="document-repo"]`; button "Open task in Projects" → `#/projects/<repo>/<task>` |

## Ownership (one writer per file; workers never commit or push)

| Role | Files |
| --- | --- |
| Lead | `packages/schema/src/workspace-m1/api.ts`, `apps/hub/src/workspace-m1/decisions/read-model.ts`, `apps/hub/src/managed/store.ts` (`claimOrder`), `apps/hub/src/managed/testkit.ts`, `apps/hub/src/index.ts`, `apps/web/e2e/workspace-harness.ts`, `apps/web/src/workspace-m1/dev/{preview-hub,web-safety-build}.ts`, `.github/workflows/ci.yml`, `package.json`, docs, Git |
| Worker A — stabilization + backend boundaries | `scripts/ci/{isolated,collect-browser-evidence}.ts`, `scripts/ci/ci-tools.test.ts`, `apps/hub/src/managed/orchestrator.ts` (hook point only), `apps/web/e2e/workspace-m1/{hub.suite,kit}.ts`, `apps/web/e2e/browser-gate.ts`, `apps/web/src/Tasks.tsx`, new `apps/hub/src/workspace-m1/decisions/multi-repo.test.ts`; `decisions/{commands,decision-service}.ts` only for a proven gap |
| Worker B — UI | `apps/web/src/workspace-m1/{store,route,labels,ProjectsView,HqView,TaskPanel,WorkspaceApp,parts,fixture-world,fixture-transport}.ts(x)`, `workspace.css`, new `briefing.ts`, `Briefing.tsx`, their unit tests; `campus/*` only if needed (presentation interface unchanged) |
| QA — tests only | new `apps/web/e2e/workspace-m1/multirepo.suite.ts` (+ its own helper file), new `apps/hub/test/workspace-m1-adversarial/multirepo.adv.test.ts`, `apps/hub/test/workspace-m1-adversarial/harness.ts` (multi-repo support; the pre-existing ADV-INPUT dump flake) |

Pre-existing flake found during the freeze (not caused by it): ADV-INPUT-01/-05 compare whole-DB dumps while
the background engine may still be advancing a task queued by an earlier test — baseline `eeeef85` 1 failure in
8 runs of `auth-origin.adv.test.ts` (ADV-INPUT-01), frozen tree 1 in 5 (ADV-INPUT-05). Test robustness item
(QA), not a product defect.

## Phase 1 — stabilization (reproduced on the unchanged code first)

| # | Concern | Reproduction on the unchanged code | Classification | Change |
| --- | --- | --- | --- | --- |
| A | CI wrapper interruption | SIGTERM / SIGINT to `scripts/ci/isolated.ts` after a synthetic child signalled readiness, the child trapping the signal and exiting 0 → wrapper exit **0**, `run.json` `exit 0` with `stopped_by "SIGTERM"` — an interrupted suite reported as a success | **Confirmed CI-tooling defect** | Exit contract: command's code; 124 time limit; 130 / 143 whenever the wrapper was interrupted, whatever the child exits; 128 + `os.constants.signals[sig]` for a signal the wrapper did not send. `run.json` + `child_exit`, `child_signal`, `interrupted`. `--set NAME=VALUE` only for `*_ONLY` case filters. Collector accepts `agentcity-m1-09-multi-*`. `ci-tools.test.ts` 3 → 11 cases. |
| B | P-06 cancellation pending across reload | The case recorded NOT RUN whenever termination was confirmed before the reload finished (hosted run 37099491744) | **Test-coverage improvement** (product ordering held throughout) | Test-only orchestrator hook `before_cancel_confirm`, awaited in `runTask` before `finishCancel` only when a cancel was requested, outside any transaction, after the termination proof is final (the child is already proven gone; the heartbeat keeps the lease). `cancelWins` is not on this path. P-06 holds it, reloads, asserts "requested" (engine `executing`, DB `cancel_requested`), releases, asserts "confirmed" + "cancelled; owned processes confirmed terminated". No NOT-RUN path. |
| C | R-23 / R-24 approval races | Each case accepted whichever ordering the runner produced; R-23 only logged the alert and status text | **Test-coverage improvement** (the UI already shows an explicit outcome: `data-request-status`, "Invalidated: …", "No further decision is possible on it", decision status) | Split into R-23a/b and R-24a/b: (a) poll-before-click — page 1's own poll shows the invalidated / decided request before any click; (b) request-before-update — page-1 reads held so the click reaches the hub first → visible 409 (`stale_binding` / `invalid_state`) before the reads resume. Exactly-one decision/execution DB assertions kept; R-24b asserts two decision POSTs and one decision. |
| D | Legacy `Tasks.tsx` focus recovery | New probes against the unchanged file: 29 / 32 | **Three confirmed product defects** (legacy managed-task view): closing the evidence viewer left focus on `<body>`; a late deep-linked detail pulled focus out of the new-task field while typing; a deep link opened in a tab without a token was lost (a token-less detail request earned a 401 that purged the selection). Coverage only: rapid A→B→A selection, 503 → Retry → available. | Viewer close returns focus to the opener (else the heading); deep-link restores skip focus while the user is in a field (selections made in the view still focus the heading); no detail request before a token exists. Legacy gate 27 → 32 checks. |

## Phase 2 / 3 — what was built

- **Server (lead).** API delta v1.2 (above). `claimOrder()` is the single definition of the engine's claim order;
  `claimNext` and the snapshot queue both use it. `execution_queue.active` is the leased execution, else an
  active one that resumes first — never a merely queued one (defect found by QA in the first version, fixed;
  ADV-MR-12/-16). Observed-only repositories come from existing telemetry rows and stay non-executable.
  No migration; no route; no change to Gate-1 / Gate-2 binding, expiry, redaction, bundles, coverage,
  provenance or legacy-v1 handling.
- **Server boundaries (Worker A, `multi-repo.test.ts`; QA, `multirepo.adv.test.ts`).** No gap found: repository
  ownership, proposal/policy/base binding, cross-task proposal, binding, challenge and artifact substitution,
  observed/unknown repository creation, global serialization, quarantine and per-repository cancellation were
  already enforced server-side; these tests now prove it with two repositories.
- **UI (Worker B).** Repository list with an "Observed only" group; observed and unknown repositories cannot be
  assigned work (store guard, no Assign work); an unknown repository in the URL is cleared with a notice and a
  task always shows under its own repository; `task-repo` + selected-task identity; `queue-status` from the
  global queue ("Queued · position N of M · waiting behind <repo> · <title> (another repository)", quarantine
  pause, unknown position); Headquarters repository labels, "Repository" filter, `document-repo`, "Open task in
  Projects"; equal-rev snapshot merges never regress engine progress. **Confirmed product defect fixed:** the
  compose panel was not keyed, so "Assign work" in a second repository in the same render could carry the first
  repository's unsaved form across.
- **CEO briefing (Worker B).** `briefing.ts` — a pure, deterministic selector over the same snapshot that drives
  the task list and Headquarters (so they cannot disagree) plus the connection state; `Briefing.tsx` — a DOM card
  at the top of the task column: a one-line summary and the next available human action first, details in a
  native disclosure. Sections: Edward's decisions (execution approval / result acceptance — "Result ready (engine
  human_ready) — NOT accepted yet"), stopped / blocked / invalid (integrity-invalid result, current validity
  invalid, quarantine, blocked, interrupted, failed, cancelled), running or queued (incl. waiting behind another
  repository), recently finished (accepted with its recorded time and current validity shown separately;
  rejected), drafts. Every claim is a control that only navigates (task or HQ document); recorded timestamps only
  ("time not recorded" otherwise); freshness current / stale / offline with the last confirmed time. States:
  loading, empty, idle, active, attention, observed. No scores, percentages, model names, costs, recommendations
  or invented work. The CEO appears as a badge on the card; there is no campus briefing animation.
- **Campus (lead).** The building label counted queued work as "running" (QA, minor): now "in progress" (the count
  is queued + running + cancel requested).

## Phase 4 — verification (local macOS, every step through `scripts/ci/isolated.ts`)

Counts are runner pass records (browser) or `bun test` cases; they are never added across suites. "Delegated" =
FX cases the HUB set decides (as at baseline).

| Check | Result (tree) |
| --- | --- |
| `bun run lint` · `bun run typecheck` (5 projects) | clean · exit 0 (final tree) |
| Full `bun --no-env-file test` (incl. adversarial) | **1859 pass / 0 fail**, 116 files (final tree; baseline `eeeef85` had 1788) |
| `check:secrets` · `build:web` · `managed:demo` | ok · ok (the existing > 500 kB campus chunk warning, not suppressed) · exit 0 |
| Legacy browser gate (`browser-gate.ts`) | **32 / 32** (27 earlier checks + 5 focus probes) |
| Real-hub suite (`hub.suite.ts`) | **110 PASS / 0 FAIL / 0 NOT RUN** (R-01 / J-21 moved to MULTI; R-23 / R-24 now a + b; P-06 runs) |
| Fixture suite (`fx.suite.ts`) | 30 PASS / 0 FAIL / 24 delegated (v1 and again on the final UI) |
| Campus suite · production build + repair suite | 36 / 0 / 0 · ok + 12 / 0 |
| **Multi-repository suite (`multirepo.suite.ts`)** | **27 PASS / 0 FAIL / 0 NOT RUN**, twice on the final tree (v1: 26 / 1 — MR-R05, a check-then-click race in the test, fixed below) |
| Backend multi-repo tests | `multi-repo.test.ts` 11 / 0 · `multirepo.adv.test.ts` 16 / 0 (ADV-MR-12/-16 failed until the queue defect was fixed) |
| `ci-tools.test.ts` | 11 / 0 |
| Preview (`dev/preview-hub.ts`) | starts: UI URL, hub URL, three allowlisted fixture repositories, one observed-only repository; clean stop |

Test-only repairs during verification (no product change): MR-R05 clicked "Check decision outcome" after a
count, but when the hub had committed the lost decision the page's next poll legitimately reconciled it and
removed the button first; the click now has a short timeout, a vanished button must really be gone and is
never counted as a use (the lost-before-hub variant still must use it). ADV-INPUT-01/-05 (pre-existing flake)
now take their "before" dump only once the engine and bridge are idle and the dump is stable — the after-dump is
still the full dump. QA measured 12 failures in 20 runs on the frozen tree before that fix versus 1 in 8 at the
baseline; the cause of the rate difference was not isolated (the engine's claim order is verified unchanged by
`multi-repo.test.ts` and ADV-MR-11); 20 / 20 after it.

Screenshots inspected (real hub, 1440×900 and 1280×800; synthetic data): two repositories side by side; queue
status "waiting behind local/m1-fixture-… (another repository)" with the campus reading "1 in progress"; briefings
`active`, `attention` (both repositories), `empty`, `observed`; Headquarters with both repositories' pending
documents and the Repository filter; invalid evidence reading the same in task detail, the HQ document / history
and the briefing; reduced-motion and no-WebGL two-repository workflows. Objective defect found by inspection: the
campus "running" label (fixed). Aesthetic choices for Edward are listed below.

## Not run / limits

- Hosted CI for this milestone: reported in the handoff (a commit cannot contain its own run).
- Simulated only. No real provider, no personal-repository execution, no merge/push/deploy by managed runs;
  `live_integration_verified` stays false. This milestone does **not** establish safe real-provider execution.
- One active managed execution globally (unchanged); no multi-worker scheduling, no cross-repository writes, no
  automatic candidate integration. Queued work in one repository waits behind another repository's run and says so.
- Observed-only repositories come from existing telemetry rows (GitHub sync / local scan / session repo ids);
  the browser suites seed one such row directly, as a GitHub sync would — the ingest/sync paths themselves are
  covered by the existing hub tests, not re-driven here.
- The briefing is a deterministic DOM selector over the snapshot; there is no CEO campus animation (a CSS badge
  only), so "replaying a briefing" and CEO arrival for the briefing are not applicable; CEO document visits are
  unchanged.
- Not run anywhere: axe-core, Safari/Firefox, manual MacBook or physical screen-reader checks.
- Process note: one of Worker B's discarded screenshot attempts let `bunx` fetch `playwright-core` into that
  run's disposable temporary HOME under the session scratchpad (outside the repository; never used by any
  recorded run; the repository's `bun.lock` and `node_modules` are unchanged). The brief said no installs without
  permission; it is reported here rather than hidden.

## Decisions for Edward (aesthetic / product, not defects)

1. Briefing placement: a compact card at the top of the right column (above the task panel), details collapsed by
   default. Above the Tasks card it pushed Assign work below the fold at both viewports.
2. The CEO appears as a badge on the briefing card; no walking/pointing animation was added (would be optional
   later and must never delay access).
3. The campus document strip clips its third document at 1280×800 (it scrolls horizontally inside the card; no
   page overflow).
4. Observed-only repositories are listed under the allowlisted ones with dashed chips and are not campus buildings.

## Five-minute walkthrough (isolated preview; synthetic data)

1. `<isolated runner> bun --no-env-file apps/web/src/workspace-m1/dev/preview-hub.ts` — open the printed UI URL
   and paste the credential from the printed 0600 file.
2. Projects: three allowlisted buildings (`m1-fixture`, `m1-beta`, `m1-empty`) and, under Repositories,
   "Observed only · observed-example/observed-only-…" — select it: no Assign work, briefing "observed".
3. Select `m1-empty`: briefing "empty". Select `m1-fixture` → Assign work → title "A1", one criterion mapped to the
   check → Submit for run approval. Select `m1-beta` → Assign work → "B1" → Submit. Neither starts.
4. Headquarters: two documents, each labelled with its repository; try the Repository filter. Open A1, type
   `Edward`, Approve execution. Open B1 (fresh empty field), type `Edward`, Approve.
5. Back to Projects → `m1-beta` → B1: queue status reads "Queued · … waiting behind local/m1-fixture-… (another
   repository)" while A1 runs (it may already have moved on — the fake run is short).
6. When each reaches "Awaiting result acceptance", open its Result acceptance document from the briefing ("Open
   result acceptance"), check the evidence, type `Edward`, Accept. Each repository's briefing then lists the
   accepted result with its time and current validity.
7. Ctrl-C the preview: everything it created is deleted.

## Independent review brief (Codex) — new trust boundaries and cross-repository races

Review the diff from `eeeef8553fe6e30511abc0710370782cd77f34a7` to the delivered head. Try to break:

- **Queue truthfulness** — `apps/hub/src/managed/store.ts` (`claimOrder`, `claimNext`), `read-model.ts`
  (`executionQueue`): can the snapshot ever show an execution holding the slot that the worker would not claim,
  or omit one it would? Quarantine, resumable-after-restart, two leased rows (should be impossible), legacy rows
  with no workspace linkage.
- **Observed-only isolation** — `read-model.ts` (`observedRepos`), `commands.ts` create path: can any telemetry,
  sync or case variant make a repository assignable or approvable? Can the UI (`store.ts` `repoKind`,
  `startComposing`, `normalizeRepo`) be driven into composing for an observed/unknown id?
- **Cross-repository substitution** — request/challenge/binding/proposal/artifact ids of repository A used in
  repository B's routes (`decision-service.ts`, `commands.ts` rerun, `read-model.ts` artifact); tests:
  `multi-repo.test.ts`, `multirepo.adv.test.ts`.
- **Client races** — `store.ts` (`isOlderItem`, `mergeSnapshot`, `foldTaskIntoSnapshot`, `afterDetail` repository
  correction, keyed compose panel): stale A answers after selecting B; equal task rev with older engine rev;
  rapid A→B→A; create answering after a repository switch.
- **Briefing honesty** — `briefing.ts`: every claim from recorded state with its recorded time; human_ready never
  reads as accepted; invalid validity never upgraded; integrity-invalid only for the integrity reasons; controls
  only navigate (`Briefing.tsx`).
- **Test-only hook** — `orchestrator.ts` `before_cancel_confirm`, `index.ts` `managedHooks`: confirm production
  (`main()`) never installs hooks and the hold cannot record anything or weaken the termination proof.
- **CI wrapper** — `scripts/ci/isolated.ts`: exit contract under SIGINT/SIGTERM/time limit, `--set` allowlist
  (no environment leakage), process-group cleanup.
