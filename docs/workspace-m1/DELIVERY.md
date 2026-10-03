# Agent City M1 — delivery and independent-review handoff (lead)

Status: **implemented, simulated-only; independent campus review completed, followed by the user's explicit
instruction to finish and push.** The confirmed idle-freshness and partial-initialization cleanup defects have
been repaired. `CAMPUS_REPAIR_2026-10-03.md` is the current repair and verification record; the earlier campus
and corrective batches below are historical evidence. Git delivery is the feature branch
`feat/workspace-approvals-m1`; this instruction does not enable GitHub writes by managed runs or live providers.

Current post-review verification: **1788/0 full tests** (203 adversarial cases included; separate rerun 203/0),
lint/typecheck/secrets/isolated production build pass, demo 8/8, legacy browser 24/24, real-hub browser 108/0 with
2 NOT RUN, fixture 30/0 with 24 delegated, campus 36/0, new production repair regressions 12/0. Both confirmed
P2 defects are repaired; current evidence age and stale warnings advance without poll responses, and failed
scene initialization explicitly releases resources. See `CAMPUS_REPAIR_2026-10-03.md` for provenance and limits.

**Multi-repository milestone (2026-10-03/04, after `eeeef85`).** Two (or more) independently selectable,
persistent simulated fixture repositories, observed-only repositories that can never be assigned work, an
authoritative global execution queue, repository-scoped Headquarters and a deterministic CEO briefing; plus the
stabilization of the CI wrapper exit contract, P-06, R-23/R-24 and three legacy focus defects. The "no second
repository (R-01)" and "no CEO briefing (J-21)" limits below are superseded. Current record:
`MULTIREPO_MILESTONE.md`.

**Hosted CI and stabilization pass (2026-10-03, after the `80a9a17` delivery).** The first hosted run (GitHub
Actions run 37090614170, push of `80a9a17`) passed lint, typecheck, unit 710 + integration 1078 (together the
same 1788 `bun test` cases as above, not additional ones), secret scan, web build and demo, and failed the legacy
browser gate 23/24 on its deep-link focus check. The cause was a product defect in the legacy managed-task view —
a deep-linked task detail that answered before the token check never received keyboard focus — now fixed, with
regression steps (legacy gate 24 → 27 checks). CI now also runs the workspace real-hub, fixture, campus and
production-repair browser suites, each isolated, with an allowlist of synthetic evidence uploaded. The local
counts in the paragraph above are macOS results from before that run; hosted results, exact commits and limits
are in `HOSTED_CI.md`.

## 0. Campus milestone (historical delivery before independent review)

Record: `CAMPUS_MILESTONE.md` (baseline identity, ownership, frozen interface, every QA run and fix);
rulings R-C1…R-C5 in `INTEGRATION.md`; contract text `CONTRACT_V1_2.md` §A/§C; preview: `RUNBOOK.md`.

- **P2 follow-up 1 — obsolete v1 execution grants: resolved server-side.** A Gate-1 request whose proposal is not
  v1.2 cannot be challenged, decided or executed: the attempt gets 409 `stale_binding` with the fixed issue and the
  request is invalidated (`evidence_unavailable`), its reservation released and the task returned to draft; the
  bridge sweep does the same for pending ones nobody touches; `authorize()` denies an approved v1 execution before
  every stage (`approval_void`); queued/active v1 executions get a cancel intent and end only when the engine
  confirms. No migration. The UI shows the server's issue text and a retired Gate-1 document without controls.
- **P2 follow-up 2 — validity freshness: resolved.** Docs no longer promise detection by "the next sweep" or within
  a universal 5 s / 30 s: periodic checks only, ceil(N/20) sweeps plus queue and check time, detail reads await a
  check older than 5 s, snapshot/list reads never check. The UI shows the last check age; a check older than 60 s,
  a connection that is not online, or no hub confirmation for 10 s turns a `valid` reading neutral ("may be out of date") — `data-status` stays the
  hub's value, `data-freshness` is the UI's reading; the server's validity is never rewritten.
- **Business campus:** Three.js 0.186.1 (user-approved), lazy-loaded once, behind the frozen
  `campus/presentation.ts` interface — read-only model from the existing store, three selection intents only.
  CEO visits are keyed by the server's `request_id`, anchored to `created_at`, never replayed on poll/reload, and
  arrival never sends a command; both gates stay in the DOM document with a freshly typed `Edward`. DOM layer
  first (Headquarters button, one-tab-stop document toolbar, building buttons); reduced motion = immediate
  arrival, no ambient motion; no WebGL / init failure / context loss → static DOM layer with the same controls.
- **Final verification (batch 3, isolated runner, final tree):** lint clean (310); typecheck 5/5; full test
  **1786 / 0** (112 files); adversarial **203 / 0**; secrets ok (359); build ok — lazy `CampusScene` chunk 570.12 kB
  (146.62 kB gzip), Vite's >500 kB warning reported, not suppressed; demo 8/8; legacy browser gate 24/24; HUB
  **108 / 0 / 2 NOT RUN** (R-01, J-21); FX 30 / 0 (24 delegated); campus **36 / 0 / 0**. Batches 1–2 found and the
  lead fixed a keyboard regression (31 campus document buttons as tab stops → toolbar) and two stale expectations
  (J-22 label; A-01 press budget 60 → 90 with the count recorded, 62) — `CAMPUS_MILESTONE.md`, `QA_BROWSER.md`.
- **Known limits:** no second repository (R-01; campus multi-repo layout only in unit tests and the fixture preview
  with 8 repos); no CEO briefing (J-21; no CEO model calls by design); the 30 s sweep was not shortened in browser
  QA (sweep batching unit/integration-tested); the "old check" freshness cause is unit-tested, the browser covered
  the stale-connection cause; the engine-first `approval_void` path is unit-tested only; headless Chromium only (no
  Safari/Firefox, no manual MacBook or screen-reader pass); copy collision — "Proposal v1" (revision number) sits
  next to the server's "obsolete v1 proposal" (contract version); the campus "running" count (in-flight phases)
  differs by design from the Repositories card's "active tasks" (not accepted/rejected/cancelled); simulated only,
  `LIVE_INTEGRATION_VERIFIED` false.
- Lead-owned UI items (obsolete-grant copy, freshness display, coverage note, labels) were implemented by Worker A
  under explicit leases and reviewed by the lead; the toolbar fix in Worker B's `CampusView.tsx` and the two
  `hub.suite.ts` expectation changes are lead leases (OWNERSHIP.md).
- **Review brief (campus milestone; independent Codex review).** File map and what to try to break:
  - *Authority preservation* — `apps/web/src/workspace-m1/campus/presentation.ts` (frozen model + three intents),
    `campus/actions.ts`, `campus/intents.ts` (`narrowActions`), `CampusSlot.tsx`; scene/view
    `campus/{CampusView.tsx,CampusScene.tsx,engine.ts,world.ts,visits.ts,choreography.ts,layout.ts,resources.ts}`;
    tests `campus/{authority,visits,layout,resources}.test.ts`. Check that nothing in `campus/**` can reach the store,
    a transport, a challenge or a decision; that arrival/animation/poll/reload never emits; that both gates still
    require a fresh `Edward` in the DOM document (`TaskPanel.tsx`, `HqView.tsx` unchanged in that respect).
  - *Lifecycle (obsolete v1 grants)* — `apps/hub/src/workspace-m1/decisions/decision-service.ts` (fixed issue
    ~L121–145; challenge path ~L374–400; decide paths ~L638, ~L805: invalidate under the write lock before the
    challenge is consumed), `bridge/reconciler.ts` (~L427–514 obsolete reruns; ~L787 pending Gate-1 sweep),
    `bridge/authorize.ts` (~L238 `deny("obsolete")` → `approval_void`), `bridge/bridge.ts`; tests
    `decisions/obsolete-v1-grant.test.ts`, `bridge/obsolete-v1-grant.test.ts`, `bridge/criterion-coverage.test.ts`,
    `decisions/criterion-coverage.test.ts`. Probe: a decision racing the sweep's invalidation; reservation release
    and task → draft in one transaction; a queued v1 execution across a hub restart; the engine-first path.
  - *Freshness* — `labels.ts` (`validityFreshness`, thresholds), `Validity.tsx`, `Evidence.tsx`, web `NOTES.md` §14;
    `CONTRACT_V1_2.md` §C; tests `freshness.test.ts`, `bridge/validity-batch.test.ts`. Check that no doc or label still
    promises a detection deadline and that a stale reading is never green while `data-status` keeps the hub value.
  - *New UI* — `CampusView.tsx` (DOM layer, toolbar roving tabindex, fallbacks), `campus.css`, the `workspace.css`
    campus/chip rules, `ProjectsView.tsx`/`HqView.tsx` mounts; browser `apps/web/e2e/workspace-m1/campus{.suite,-kit}.ts`;
    dev `campus/dev/*`, `dev/preview-hub.ts`. Dependency: `apps/web/package.json`, `bun.lock` (three 0.186.1,
    @types/three 0.186.0 + its six transitive type packages).

## 0b. Corrective v1.2 (previous; still applies)

- Record: `CORRECTIVE_V1_2.md` (starting identity, reproductions, finding-by-finding fixes and tests); contract
  delta: `CONTRACT_V1_2.md`; migrations `009_accepted_evidence_validity.sql` (additive) and
  `010_proposal_contract_v1_2.sql` (rebuilds only `managed_proposals` to widen 008's contract CHECK; 008 never
  edited; legacy rows byte-identical).
- Fixes: (1) final authority evaluated with a clock read inside the decision transaction; (2) durable,
  content-addressed evidence bundle sealed from the exact verified buffers before Gate 2 opens, bound to the
  result request, decision and receipt, and the only source for serving accepted evidence; (3) separate,
  sticky current acceptance validity (valid / invalid / unknown / unverifiable) shown next to the unchanged
  historical decision in task detail, HQ and history; (4) stable criterion ids, proposal-time criterion→check
  mapping, sealed per-criterion coverage, fail-closed publish and acceptance.
- Final identity (2026-10-02T10:41Z): HEAD `f960055448e4f5a0bd93a7b9ca0aeb0d2ef8597d`, staged 0; tracked 23 files
  (+493/−59), `git diff HEAD | shasum -a 256` = `7d5dce7d02ed02c20d38eac497d8426deae39b30f89cc36df9e23eab9b90433e`;
  196 untracked files, manifest `git ls-files --others --exclude-standard | sort | xargs shasum -a 256 | shasum -a 256`
  = `29f989ed962d2650ce8d9c316cc580a24b388aeacfcc46df5d27a9a463fff6e2` (measured before this §0 edit; DELIVERY.md and
  the corrective docs are included, so recompute rather than trust recorded values).
- Fresh results (isolated runner): lint clean (278 files); typecheck 5/5; full `bun --no-env-file test` **1708 pass /
  0 fail** (103 files); adversarial **203/0**; `check:secrets` ok (326); `build:web` ok; `managed:demo` 8/8;
  legacy browser gate 24/24; real-hub browser **108 PASS / 0 FAIL / 2 NOT RUN** (R-01 single repo, J-21 no CEO
  briefing); fixture browser 30/0 (24 delegated to HUB). Browser counts are runner pass *records* (they count
  J-01 checkpoints, R-06 sub-cases, globals and P-12 separately), not assertions and not coverage groups; the
  reviewer's crosswalk explains the earlier 81-group vs 103-record figures, and group counts were not
  recomputed in this pass. The historical ~13 s outcome-recovery latency was not reproduced by the independent
  review and is not treated as a correctness defect.
- Reviewer probe rerun on the final tree: four commit-expiry cases → 409 `challenge_invalid`, 0 decisions; OBS-04
  and J-22 → accepted history kept, original bytes served from the bundle after restart, validity `invalid`
  (`source_evidence_changed`) after the sweep and after restart, receipt digest = validity digest.
- Detection timing (periodic, no filesystem monitoring, **no guaranteed deadline**; CONTRACT_V1_2.md §C): the
  bridge sweep (startup, then every 30 s, one job on the serial reconcile queue) re-checks at most 20 `valid` /
  `unknown` accepted results per run, oldest check first, so N eligible results need about ceil(N/20) sweeps
  (with 21, the most recently checked one waits for the next sweep) plus queue and check time; a task-detail read re-checks — and awaits the check —
  when the last check is older than 5 s; snapshot / list reads never check (stored row + `checked_at`); the UI
  polls every 2 s. A source change between Gate-2 revalidation and commit (OBS-04) or shortly after acceptance is
  reported by the first check that reaches that result; the accepted bytes are the verified originals in the
  bundle either way. Measured times are observations, not bounds.
- Known limits for re-review: a detail read within 5 s of the last check (e.g. right after an OBS-04-style swap)
  shows the stored `valid` until a later check; a list-only viewer has no fixed detection deadline (above).
  Obsolete v1 execution grants are refused server-side (follow-up): a challenge or decision attempt, or the bridge
  sweep, invalidates a pending Gate 1 of a pre-v1.2 proposal (`evidence_unavailable`, "obsolete v1 proposal
  without criterion coverage; publish a new version and request a fresh execution approval"; the attempt gets
  409 `stale_binding` with that text as its issue), releases its reservation and returns the task to draft; an
  approved v1 execution is denied before every stage (`approval_void`) and gets a cancel intent. Challenge
  storage was corrected in RUNBOOK and here: hash/status/binding/expiry in SQLite, raw tokens and sessions ephemeral. This document is the hand-off for the user and for the later **independent Codex review**; the
lead's self-tests and the internal QA roles do not substitute for that review.

## 1. Identity

| Item | Value |
| --- | --- |
| Reported/verified source | `agent-city-v011`, `hardening/managed-v0.1.1`, `f960055448e4f5a0bd93a7b9ca0aeb0d2ef8597d` (clean; untouched — §8) |
| Implementation checkout | `agent-city-m1` (independent `git clone --no-local`, own object store), branch `feat/workspace-approvals-m1`, HEAD = baseline `f960055…`, push URL disabled |
| Change state | everything uncommitted; nothing staged; no commits; no push |
| Diff identity (final) | tracked `git diff HEAD \| shasum -a 256` = `86d185c321bb1c4c6583428f759093793982f3044b2f643d85abcc50e358614f`; untracked manifest `git ls-files --others --exclude-standard \| grep -v '^docs/workspace-m1/DELIVERY.md$' \| sort \| xargs shasum -a 256 \| shasum -a 256` = `ce807a5f45c0ba28f536e127bbde2094be271161ae7627b88c7af287c84ec298` (169 files; this file excluded so it can carry the hashes) |
| Size | 23 tracked files changed (+491/−59); 169 new files + this document (contracts, modules, tests, harness, docs) |

## 2. What was built

A persistent DOM-first repository workspace and Headquarters approval queue on the existing Bun/Hono/
SQLite/React/Zod monorepo, on top of the existing bounded managed engine (no second orchestrator):

draft → immutable hashed proposal version → **Gate 1** (fresh exact `Edward` + server-authenticated
ephemeral operator session, exact Origin, CSRF, single-use boot-bound challenge, durable receipt) queues
exactly one bounded execution (`managed_tasks`) → fake implementation / trusted verification / fake review
(optional single pre-approved in-scope repair) → evidence sealed into a canonical result envelope → **Gate 2**
records a separate human acceptance of that exact envelope; engine `human_ready` is unchanged; nothing is
merged, pushed or deployed. Request changes → new draft → new proposal → new Gate 1. Reject is terminal.

| Area | Location | Owner role |
| --- | --- | --- |
| Contracts v1 (+ additive v1.1 API delta) | `packages/schema/src/workspace-m1/` (`INTERFACE.md`, frozen vectors) | 01 (+ lead deltas) |
| Migration `008_workspace_approvals.sql` (4 tables, no auth table) | `packages/schema/migrations/` (copy of `apps/hub/src/workspace-m1/persistence/`) | 02 / lead registration |
| Persistence store, transactions, managed-task writes | `apps/hub/src/workspace-m1/persistence/` | 02 |
| Operator auth, sessions, Origin/CSRF, challenges | `apps/hub/src/workspace-m1/auth/` | 03 |
| Decisions (both gates), commands, read model, router | `apps/hub/src/workspace-m1/decisions/` | 04 |
| Pipeline bridge (authorize, reconcile, seal → Gate 2, sweeps) | `apps/hub/src/workspace-m1/bridge/` | 05 |
| Evidence: complete-context diff disclosure, sealing, reader | `apps/hub/src/workspace-m1/evidence/` | 06 |
| DOM workspace + HQ (fixture + real transports) | `apps/web/src/workspace-m1/` | 07 |
| Independent adversarial suite | `apps/hub/test/workspace-m1-adversarial/` | 08 |
| Independent browser suite | `apps/web/e2e/workspace-m1/` | 09 |
| Hub composition, legacy closure, engine hooks, harness, docs | `apps/hub/src/workspace-hub.ts`, `index.ts`, `managed/*`, `security.ts`, `routes/ws.ts`, `db.ts`, `apps/web/src/App.tsx`, `vite.config.ts`, `apps/web/e2e/workspace-harness.ts`, `docs/workspace-m1/` | lead |

Ownership map and lease log: `OWNERSHIP.md`. Every lead ruling and integration item with evidence:
`INTEGRATION.md`. Contract freeze record: `CONTRACT_FREEZE.md`.

### Dependency order actually executed

1. Phase 0 (lead): baseline revalidation in isolation, independent clone, dependency copy (user-approved),
   integrity snapshots, ownership map.
2. M1A: 01 contracts ∥ 06 Part A (omitted-hunk disclosure, contract-independent) ∥ 08/09 matrix design →
   lead freeze v1 (14 rulings) + v1.1 API delta.
3. Wave 2: 02 persistence ∥ 03 auth ∥ 06 Part B ∥ 07 fixture UI → 04 decisions (after 02/03 accepted) →
   05 bridge (after 04/06 accepted). Lead integrated each accepted module.
4. M1C: 07 on the real isolated hub (both gates). M1D: 08 and 09 against the integrated code; fixes (F-01
   backend by 04, F-1 frontend by 07, R-F5 lead); both suites re-run on the final code.

### Lead-owned changes to existing files (summary)

- Legacy bypasses closed: `/api/managed/*` → 410 in workspace mode; `service.runTask` refuses workspace-governed
  executions; `OrchestratorDeps.authorize` checked with the approval binding before **every** stage (bridge:
  approved Gate-1 decision, binding recompute, `run_requested_at === decided_at`, current execution, simulated);
  `/ws` publishes no managed ids at all; `/api/workspace` exempt from loopback CORS echo.
- Live forced off in workspace mode (`simulatedOnly`), on top of contract and entry-point rejection.
- Evidence: orchestrator diff step uses complete-context disclosure (withheld → `evidence_invalid` before
  review); atomic, no-follow `writeArtifact`; `gitRunner`; context/evidence limits.
- Repair (L-11 patch from 05): scope-expanding findings or revoked authorization never start a repair.
- `createTask` accepts a pre-minted id; `db.ts` busy_timeout before WAL and version re-check inside an
  immediate transaction.
- Web: `App.tsx` renders the workspace app (with the telemetry grid as read-only "Observed only") under a
  build-time switch; legacy UI otherwise.
- Env: `WORKSPACE_OPERATOR_CREDENTIAL`, `WORKSPACE_ALLOWED_ORIGIN` (blank in `.env.example`, README table);
  CLAUDE.md ≡ AGENTS.md convention line; docs-parity scan treats `*.suite.ts` browser harnesses as test code.

## 3. Migration and restart behaviour

See `RUNBOOK.md` §"Restart and migration behaviour". In short: additive migration 008 (user_version 7 → 8),
no edits to 006/007, append-only proposals/decisions, no cascades from managed rows; sessions and raw
challenge tokens are ephemeral and boot-bound, while challenge hash/status/binding/expiry live in SQLite on the
approval-request row (a restart voids old challenges via the new boot/session, not by deleting rows); receipts survive; restart
never re-runs a launched model stage; an unsealed `human_ready` is sealed once by the startup sweep.

## 4. Isolated run instructions

`RUNBOOK.md` (isolated runner recipe, all commands, the `startWorkspaceEnv` harness, manual exploration rules).

## 5. Measured results (isolated runner; pass / fail / not run)

| Check | Result |
| --- | --- |
| Baseline before M1 (same tree as source) | full suite 566/0; lifecycle 85/0; five-fix regressions C1–C5 pass (`BASELINE.md`) |
| Final `bun run lint` | clean (256 files) |
| Final `bun run typecheck` (5 projects) | exit 0 |
| Final `bun --no-env-file test` (everything incl. the adversarial suite) | **1508 pass / 0 fail**, 88 files |
| Final `check:secrets` | ok (299 files) |
| Final `bun run build:web` | ok |
| Lead integration on a real loopback hub (`workspace-hub.test.ts`) | 6/6 (Gate 1 → engine → seal → Gate 2 accept; bypass row blocked; tamper → 409 + invalidation + non-verified read; 410; live forced off; 503 when unconfigured) |
| 08 adversarial (independent) | run 1: 199/200 (F-01) → run 2 after fix: **203/203 twice** (`QA_ADVERSARIAL.md`) |
| Five reported fixes, independent re-attack (08) | C1–C5 **PASS** (details and controls in `QA_ADVERSARIAL.md`) |
| 09 browser (independent, Chromium 153.0.8010.12 headless shell) | run 1: HUB 80/2/2 (F-1) → run 2 after fix: **HUB 81 pass / 1 fail (J-22 = OQ-10) / 2 not run; FX 25/0** (`QA_BROWSER.md`); lead rerun on the final tree: see `QA_BROWSER.md` |
| 07 real-hub journeys | part 1 14/14, part 2 10/10 (both gates, tamper, repair, cancel, restart, TTL) |
| Hosted CI, `managed:demo`, legacy `test:browser` gate | not run at that time (hosted CI first ran on 2026-10-03: `HOSTED_CI.md`) |

## 6. Threat boundaries (what is and is not claimed)

Claimed for the local fixture threat model: authority comes only from an authenticated operator session +
exact Origin + CSRF + a fresh exact `Edward` + a single-use challenge bound to operator, gate, immutable
subject, request revision, session generation, boot and expiry; decisions are atomic with challenge
consumption and effects (one SQLite transaction) and idempotent by (operator, key) with durable receipts;
Gate 2 binds the exact attempt/candidate/tree/manifest/full review/evidence via a canonical envelope hash
recomputed from fresh verified reads; ordinary file or row tampering is detected; FIFOs/symlinks/special
files are refused with bounded reads; withheld/oversized/unparsable diff context fails closed; crafted live
requests never reach provider lookup/preflight (zero provider calls proven with stubs).

Not claimed: protection against a privileged local attacker controlling hub memory, the SQLite file,
artifact storage permissions or git objects; OS containment (worktrees/process groups are not a sandbox);
remote/production readiness; any live provider behaviour; recognition of every secret encoding.

## 7. Unresolved findings and limitations (none blocking M1 by the lead's rulings)

- (superseded by §0 / corrective v1.2) J-22 / OQ-10 post-acceptance validity and OBS-04 durable evidence are
  fixed: current validity is re-checked (read ≥ 5 s, sweep 30 s, startup) and sticky; accepted bytes are durable
  in the bundle. Remaining: detection is periodic, not instantaneous.
- OBS-02 / pipe EOF ≠ termination: a descendant that escapes into a new process group and closes its pipes is
  not detected (live-only path; live is off in M1).
- OBS-03: public `/ws` accepts any loopback port/absent Origin; acceptable only while it carries observed
  telemetry only (verified: zero managed frames).
- R-Q2: a candidate tampered to a nonexistent commit is classed transient (`evidence_unavailable`, nothing
  accepted) instead of integrity-failed.
- Moved base → `invalidated(repo_unavailable)` with detail (no `base_changed` reason); transient seal failures
  retry on notify/sweep (≤ 3 per execution per process, in-memory counter); bridge alarms in memory only; one
  reconcile queue per process; repair reuses the same worktree (fresh attempt workspaces are a pre-live item).
- R-E2 conservative over-masking of diffs (fixture-sized; precision is follow-up); review output truncated at
  storage is corrupt (fails closed); retained verified bytes are memory-only.
- R-F6 coarse phase label "Failed" for an integrity-invalidated result; R-F2 superseded proposal versions are
  not named "version N" in history. (OQ-5 criterion mapping/coverage: fixed in v1.2.)
- On the real hub a failing check fails the attempt before sealing, so "unsatisfied" coverage is rendered only in
  fixture/unit tests and asserted at sealing in `evidence/coverage.test.ts`.
- No sign-in rate limit (per-run high-entropy credential); duplicate session cookies fail closed (a page on
  another loopback port can block sign-in, never gain a session); no `__Host-` cookie prefix.

## 8. Source preservation and process notes

- `agent-city-v011` and `agent-city` (main checkout) tracked files, refs and the SOL design document are
  byte-identical to the pre-M1 snapshot; the real hub on 4317 was never started; no global agent config was
  touched; no installs (dependency trees copied from v011 with the user's explicit approval, `bun.lock`
  byte-identical); no network, no provider CLIs, no credentials; nothing committed or pushed.
- Two worker runs were interrupted by an API usage limit and resumed with their context; subagent report
  files were refused by the harness, so 08/09 reports are recorded by the lead in `QA_ADVERSARIAL.md` /
  `QA_BROWSER.md`. Lead file leases on worker directories are logged in `OWNERSHIP.md`.

## 9. For the independent Codex review

(Corrective re-review: start from §0, `CORRECTIVE_V1_2.md` and `CONTRACT_V1_2.md`; the original brief follows.)

- Baseline: `f960055448e4f5a0bd93a7b9ca0aeb0d2ef8597d` (`hardening/managed-v0.1.1`). Review the full working
  tree diff of `agent-city-m1` against it (tracked diff + untracked files; identity method in §1).
- Highest-value review targets: `apps/hub/src/workspace-m1/decisions/decision-service.ts` (order, single
  transaction, receipt replay), `auth/` (session, Origin, CSRF, challenge binding), `bridge/authorize.ts` +
  `reconciler.ts` (authorization before every stage, sealing, cancel races), `evidence/` (disclosure, sealing,
  validation/use window), `apps/hub/src/managed/orchestrator.ts` (authorize hook, disclosure step, repair
  patch), `apps/hub/src/index.ts` + `workspace-hub.ts` (composition, legacy closure, live forced off),
  `packages/schema/src/workspace-m1/` (hash graph, canonical encoding, state matrix),
  `apps/web/src/workspace-m1/fetch-transport.ts` + `store.ts` (session generation, stale responses).
- Reproduce: `RUNBOOK.md` commands; adversarial `bun --no-env-file test apps/hub/test/workspace-m1-adversarial`;
  browser `apps/web/e2e/workspace-m1/{hub,fx}.suite.ts`; lead integration `apps/hub/src/workspace-hub.test.ts`.
- Untested behaviour (at that delivery): live providers (by design), hosted CI (since run: `HOSTED_CI.md`), axe-core accessibility scan, manual MacBook checks,
  Chrome-for-Testing full pass, multi-process hub instances, held-pipe quarantine across restart (RESTART-07),
  hub log capture of session values (AUTH-10), post-acceptance integrity (OQ-10).

## 10. SOL acceptance matrix (design §H, M1-01…M1-12) → evidence

**Current labels after corrective v1.2 (lead self-assessment; independent re-review required):**

| ID | Fresh evidence | Label |
| --- | --- | --- |
| M1-01 | commit-time expiry/revocation refused with no effects (`commit-authority.test.ts` 18/18 ×3; reviewer probe 409); ordinary auth/Origin/CSRF/name/replay rows (08 203/0) | PASS |
| M1-02 | exactly-once, replay/conflict, rollback incl. expiry between concurrent commits | PASS |
| M1-03 | separate gates, fresh field, inert Enter, clearing (09 108/0) | PASS |
| M1-04 | invalidation, authorization before every stage | PASS |
| M1-05 | Gate-2 binding + durable bundle; swap after validation leaves the accepted originals durable (bundle) and later reports the source change via validity | PASS (residual: periodic detection, §0) |
| M1-06 | bounded repair; changes/reject need a new proposal | PASS |
| M1-07 | cancel/fencing/restart (simulated scope); OS containment not claimed | PASS (simulated scope) |
| M1-08 | restart preserves proposals, receipts, envelopes **and accepted evidence bytes** (bundle) + validity rows | PASS |
| M1-09 | task/request A→B, late auth, polling | PASS — R-01 (repo A→B) NOT RUN (one repo) |
| M1-10 | crafted live / bypasses: zero provider calls | PASS |
| M1-11 | two viewports, keyboard, reduced motion, non-WebGL (automated) | PASS — axe-core, manual MacBook, Chrome-for-Testing NOT RUN |
| M1-12 | inert text, redaction incl. omitted-hunk and draft mapping keys, secrets | PASS |
| Current acceptance validity (SOL §C/§E) | sticky validity, read/sweep/restart, browser J-22 under the corrected contract | PASS (periodic detection, §0) |
| Criterion identity + coverage (SOL §C) | stable ids, fail-closed publish, sealed coverage, `resultEligibilityV1_2`, browser C-01…C-05 | PASS — hub-path "unsatisfied" rendering only via fixture/unit/sealer tests |

The table below is the original M1 hand-off mapping (kept for history):

| ID | Evidence (independent suites decisive) | Result |
| --- | --- | --- |
| M1-01 submission starts nothing; wrong/missing `Edward`, stale binding, wrong gate, no session, bad Origin/CSRF, challenge replay cannot queue/accept (direct API) | 08 ADV-AUTH/ORIGIN/CSRF/NAME/CHAL; 09 J-01 | PASS |
| M1-02 Gate 1 queues exactly once (double click, duplicate payload, dropped response; no cross-tab challenge reuse) | 08 ADV-IDEM/RACE (20-way race → one linkage); 09 R-13/R-16/R-20 | PASS |
| M1-03 no acceptance after Gate 1 only; fresh empty field; Enter inert; field clears on selection/invalidation/logout/reload/completion | 09 J-01, R/A cases; 08 ADV-ACCEPT | PASS (offline-transition clearing: 07 unit tests only, not separately browser-confirmed) |
| M1-04 proposal/policy/base/context/check changes invalidate Gate 1; queued work launches no later stage under a changed grant | 08 ADV-INVAL; `authorize.test.ts`; bridge sweep tests | PASS |
| M1-05 Gate 2 rejects wrong attempt/candidate/tree/manifest/review/artifact identity, coherent file+row tampering, missing/FIFO/symlink evidence, incomplete checks, stale revisions | 08 ADV-G2/EVID + C5; lead `workspace-hub.test.ts`; 09 J-12/J-13 | PASS — residual few-ms window documented (OBS-04) |
| M1-06 only the pre-approved in-scope repair proceeds; exhaustion/out-of-scope/request-changes need a fresh proposal + Gate 1; reject queues nothing | 08 ADV-REPAIR; 07 part 2; 05 repair tests | PASS |
| M1-07 cancel vs finalization, fencing, old-worker completion, uncertain termination; pending cancel never shows cancelled; no auto relaunch after model intent | 08 ADV-CANCEL/RESTART; 09 J-14/J-15 | PASS — held-pipe quarantine across restart (RESTART-07) NOT RUN |
| M1-08 reload + restart preserve proposals/decisions/results; fixtures/legacy rows never become signed executions; lost outcomes resolved by the stored decision | 09 P-01…P-12; 08 ADV-LEGACY/IDEM | PASS |
| M1-09 stale/slow responses, A→B, poll/reconnect, late auth errors never replace newer state; one cache; no animation dispatches commands | 09 races 27/28 (incl. R-06 after F-1 fix) | PASS — R-01 (repo A→B) NOT RUN: M1 has one repository by design |
| M1-10 crafted live requests, route bypasses and fixture resets make zero real provider calls; provenance labels distinct | 08 ADV-LIVE/LEGACY (stub CLIs, 0 spawns); 09 G-5/provenance | PASS |
| M1-11 browser gates at 1440×900 and 1280×800: no overflow, keyboard completion, reduced motion, non-WebGL, screenshots inspected | 09 A-01…A-16; 07 screenshots | PASS — axe-core scan, Chrome-for-Testing full pass, manual MacBook checks NOT RUN |
| M1-12 inert artifact text; canaries redacted/rejected incl. omitted-hunk context; unavailable evidence blocks acceptance; checks + secret scan pass; no unrelated source/state changes | 08 ADV-REDACT + C3; 09 A-12/S-05; final gate; source-integrity comparison | PASS |

Also: SOL's exit journey set (accept / reject / change / cancel / stale-binding / failure) — covered by 07 parts 1–2
and 09 journeys. Not part of M1 exit: J-21 CEO briefing (optional, not built); J-22 post-acceptance integrity
(OQ-10, deferred — the one browser FAIL, kept for traceability).
