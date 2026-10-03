# Role 05 — pipeline bridge: integration notes

Scope: `apps/hub/src/workspace-m1/bridge/` only. Frozen contracts v1 (+ v1.1) used unchanged. Built
on the accepted 02 store / managed writes, 04 `createManagedBridge` (reused for reserve / enqueue /
release — not re-implemented), 06 sealer. No lead-owned or other-role file was edited.

## Files

| File | Role |
| --- | --- |
| `authorize.ts` | `evaluateAuthorization(reads, config, task, {policy})` (pure, read-only) + `createAuthorizer` → `OrchestratorDeps.authorize`. |
| `reconciler.ts` | `createReconciler`: serialized job queue (`notify`, `sweep`, `idle`, `stop`), engine → stage mapping, sealing at human_ready → Gate 2, pending-Gate-1 policy / repo / base sweep, violation alarms; `defaultCheckBase`. |
| `bridge.ts` | `createWorkspaceBridge(deps)` → `{ port, authorize, notify, sweep, start, stop, idle, alarms, flagged }`. |
| `index.ts` | Public barrel (no test helpers). |
| `orchestrator-repair.patch` | Proposed lead-owned L-11 patch for `apps/hub/src/managed/orchestrator.ts` (unified diff, `patch -p1`). |
| `test-support.ts` | Test-only: env (fixture + 03 auth + 02 store + 06 sealer + 04 services wired to THIS port), Orchestrator wired like the hub, counted adapters, scripted reviewer, R-N2 seam, flows. |
| `*.test.ts` (8) | authorize, reconcile, cancel, repair, repair-patch, restart, live, sweep. |

## Status update (after lead review)

The lead applied `orchestrator-repair.patch`; `repair-patch.test.ts` was flipped (the "[current engine]"
tests deleted, `.failing` dropped). Now: `run.sh bun --no-env-file test apps/hub/src/workspace-m1/bridge`
→ **66 pass / 0 fail**; `run.sh bun --no-env-file test apps/hub` → **688 pass / 0 fail**. Lead rulings:
no `base_changed` delta in M1 (repo_unavailable + detail accepted, limitation); no
`before_cancel_confirm` hook unless 09 needs it. The sections below describe the pre-patch run.

## Commands and results (isolated runner `run.sh`, 2026-10-02)

```
run.sh bun --no-env-file test apps/hub/src/workspace-m1/bridge            → 69 pass, 0 fail (8 files, ~10 s)
run.sh bun --no-env-file test apps/hub/src/workspace-m1 apps/hub/src/managed → 563 pass, 0 fail (38 files)
run.sh bun --no-env-file test apps/hub                                     → 691 pass, 0 fail (45 files)
run.sh bunx biome check apps/hub/src/workspace-m1/bridge                   → 13 files, 0 errors / 0 warnings
run.sh bun run typecheck                                                   → all 5 projects pass
run.sh bun --no-env-file scripts/check-secrets.ts                          → ok (278 files)
```

The 69 include the three `test.failing` post-patch tests of `repair-patch.test.ts`, which bun counts
as passes BECAUSE they fail against today's engine (they document the L-11 gap).

Patch verification (scratch copy of the checkout, node_modules symlinked, `orchestrator-repair.patch`
applied, the three `repair-patch.test.ts` post-patch tests un-`.failing`ed and the "[current engine]"
ones removed): `bun test apps/hub` → **688 pass / 0 fail**; `biome check` of the patched
orchestrator clean; `tsc -p apps/hub` clean.

## API and exact wiring (lead: `apps/hub/src/index.ts` / `routes/workspace.ts`)

```ts
import { createWorkspaceBridge } from "../workspace-m1/bridge/index.ts";

const frozenConfig = /* ONE frozen config value for orchestrator, bridge, 04 and 06 (live forced off) */;
const store = createWorkspaceStore(db);                                   // same handle everywhere
const retained = new RetainedEvidenceStore();
const sealer = createEvidenceSealer({ db, config: frozenConfig, reads: store, retained, gitFor });
let worker: Worker | null = null;
const bridge = createWorkspaceBridge({
  db, store, config: frozenConfig, sealer,
  onQueued: () => worker?.poke(),           // deferred by the bridge (never inside 04's tx)
  // alarm: (a) => …                        // default: one redacted console.error line per condition
});
const orchestrator = new Orchestrator({
  db, config: frozenConfig, adapters: createAdapters(frozenConfig),
  authorize: bridge.authorize,              // every stage, before any preflight
  onChange: bridge.notify,                  // returns immediately, never throws (no /ws broadcast: L4)
});
worker = startWorker(orchestrator);
bridge.start({ intervalMs: 30_000 });       // startup sweep now + periodic (timer unref'd)
ws.route("/", createWorkspaceRouter({ auth, store, config: frozenConfig, sealer, reader,
                                      bridge: bridge.port, clock }));
// shutdown: await bridge.stop(); await worker.stop();
```

**Mandatory** (not optional): `bridge: bridge.port` — 04's services default to `createManagedBridge`,
which never notifies the reconciler (only the periodic sweep would catch up); and `authorize:
bridge.authorize` — `OrchestratorDeps.authorize` is optional in the engine, and without it every
managed row runs on the content hash alone (L3 off). Transient seal retries are driven by
notify/sweep only (the engine never re-notifies a terminal human_ready): latency = `intervalMs`.

- `authorize(task) → string | null` — synchronous, plain reads, never `store.transaction()` (tested
  by patching `db.transaction`). Denies unless ALL hold: `execution_mode === "simulated"` (row and
  proposal); a `run` request names this managed task and is `approved`; exactly one decision for it,
  `run`/`approve`, same managed task, workspace task and `binding_hash`; `task.run_requested_at ===
  decision.decided_at` (any re-queue by another path changes it); the workspace task's
  `current_managed_task_id` is this task and its stage ∈ {queued, running, cancel_requested}; the
  proposal is the task's current version with the request's hash; `idempotency_key = request.id`,
  `request_hash = execution_binding_hash` (OQ-14); managed content canonical-equal to
  `managedTaskFieldsFor(snapshot)`; stored execution + run bindings recompute; repo allowlisted; the
  execution binding recomputes under `policyHash(frozenConfig, repo)`; not flagged by the
  reconciler. Every non-workspace row is denied. Fixed reasons (enum values only); a thrown read
  (02 `WorkspaceIntegrityError`) is a denial.
- `notify(id)` — enqueue + `queueMicrotask` drain: nothing runs on the caller's stack, so calls from
  inside 04's decision / cancel transaction or orchestrator callbacks are safe (tested). One job at a
  time; each job evaluates inside ONE `store.transaction` (consistent snapshot, no false violation
  from a commit between two reads). `WorkspaceTxError` → retried after 25 ms; other errors → alarm.
- `sweep()` — queues every workspace execution in {awaiting_run_approval, queued, running,
  cancel_requested}, every managed task doing work (superseded / ungoverned detection), then the
  pending-Gate-1 policy job; resolves when drained. `{tasks, invalidated}`.
- `port` — `ExecutionBridge`: 04's `createManagedBridge` + deferred `notify` after `enqueueApproved`
  (queued) and `requestCancel`, and deferred `onQueued`.

## Mapping (INTERFACE §6 engine / rec rows, `engineStageEffect`)

| Workspace | Engine | Bridge effect |
| --- | --- | --- |
| queued | executing / verifying / reviewing / repairing | → running (`engine_started`) |
| queued, running | blocked / failed / interrupted | → execution_ended (`engine_ended`, detail names state + failure_kind) |
| queued, running | cancelled | → cancelled (`engine_cancelled`) |
| queued, running | human_ready | seal OUTSIDE any tx (06, `run_decision_id` = Gate-1 decision) → commit tx re-checks: same current execution, engine still human_ready with the sealed `result_run_id`, no result request for the run, structural authorization → eligible: result request `pending` (envelope stored = sealer canonical, hash-checked by 02) + `awaiting_acceptance`; ineligible: request `invalidated(evidence_unavailable)` + `execution_ended` (OQ-7); permanent SealError: no request (no envelope) + `execution_ended` |
| cancel_requested | cancelled | → cancelled |
| cancel_requested | human_ready | → cancelled (`cancel_won`); if the race happened during a seal, the sealed result is recorded `invalidated(task_cancelled)` (OQ-8) |
| cancel_requested | failed / blocked | → execution_ended |
| cancel_requested | interrupted + open quarantine | stays (never cancelled without proof) |
| cancel_requested | interrupted, no quarantine | `requestCancel` re-issued → cancelled |
| awaiting_run_approval | not draft / cancelled | **violation**: alarm + flag + `requestCancel` of the reservation (queued-unleased / blocked → cancelled), so 04's withdraw / supersede keep working (`releaseReserved` accepts cancelled) |
| queued / running / cancel_requested | structural authorization fails | **violation**: alarm + flag (authorize denies) → the engine's `approval_void` → `execution_ended`; at human_ready → `execution_ended` without offering anything |
| (not current) | queued / active | alarm (`violation` superseded, or `ungoverned_execution`) + flag |
| awaiting_acceptance, accepted, … | — | nothing (engine stays human_ready; nothing merged) |

Pending Gate-1 sweep (§6 `run_request_invalidated`): repo not allowlisted → `repo_unavailable`;
`policyHash` ≠ binding → `policy_changed`; base (async git outside tx): base_sha unresolvable →
`repo_unavailable`; trusted base ref now ≠ base_sha → `repo_unavailable` (detail "base branch moved");
git error of unknown kind → no write. Then one tx: request still pending, task stage
`awaiting_run_approval` with this reservation, reservation draft/cancelled → request invalidated,
`releaseReserved`, task → draft.

## Guarantees and evidence

- Run linkage proposal → Gate-1 receipt → managed task → attempt → candidate → envelope (reconcile).
- Fake success / failures (verification_fails, reviewer_error, no_changes, malformed_review) →
  truthful `execution_ended`, no Gate 2; ineligible → OQ-7; unsealable transient vs permanent.
- Gate 2 opened exactly once (5 notifies + 2 concurrent sweeps + later sweeps → 1 request, dump
  unchanged); accept keeps engine human_ready, zero adapter calls, no new runs.
- Repair: default 0; limit 1 repairs once and Gate 2 binds attempt 2 (new candidate, new manifest,
  attempt-2 review, `parent_sha` = attempt-1 candidate); reject_always → `repair_limit_exhausted`
  after exactly one repair; forbidden classes (out_of_scope, reviewer_error, malformed_review,
  review_wrong_candidate, reviewer_mutates, evidence tampered before review, authorization revoked)
  → one attempt, no repair.
- Cancel before (withdraw; queued-unleased), during (R-N2 window, cancel-vs-finalize), after (409,
  R-A1); quarantine keeps `cancel_requested`; re-issue path.
- Fences: a worker whose lease was seized cannot finalize (no human_ready, fence unchanged, no
  Gate 2); late seal commit after a cancel intent → cancel_won; late notify for a superseded
  execution → no write.
- Restart: crash after launch intent → interrupted, child killed by the new process, stale worker
  writes nothing, never re-run, decision byte-identical; crash while queued → runs exactly once under
  the durable decision; unsealed human_ready → sealed once by the restart sweep, second restart no-op.
  Process death before dispatch / before response delivery: 02 (`crash-child`, lost response) and 04
  (`restart.test.ts`) suites.
- Zero provider calls (live block ENABLED against stub `claude`/`codex`): legacy live Run, DB-seeded
  queued live row with a valid `approval_hash`, approved execution flipped to live in the DB,
  workspace-governed legacy Run (409), client-supplied live mode / provider / model / argv fields →
  zero preflight / implement / review calls, zero live adapter lookups, empty stub call logs.

## R-N2 seam (test-only, no production path)

The engine notices `cancel_requested_at` only in its heartbeat (`runTask` beat). An orchestrator
built with `heartbeatMs: HOLD_HEARTBEAT_MS` (1e9 ms; stay < 2^31−1 or setInterval fires every 1 ms)
running `impl_hangs` holds "cancel requested, not yet confirmed" indefinitely: the workspace shows
`cancel_requested`, the child is alive; `orchestrator.shutdown()` releases it (the loop's cancel
check precedes the abort check → `finishCancel` → `cancelled`). `hooks.at("before_finalize")` gives
the cancel-vs-finalize window. Gating `ProcessOps.terminateGroup` is NOT stable (runProcess's settle
timer quarantines after ~2.3 s on the fixture). For 09's harness: construct the cancel-scenario
orchestrator with the held heartbeat (no renewal: nothing else contends in an isolated hub).

## Orchestrator repair patch (lead-owned, L-11) — `orchestrator-repair.patch`

Audit of the current engine (line numbers of the current file):
- Repair is decided in two places: `verify()` ~1085 (failing completed checks; verification
  findings have `file: null`) and `review()` ~1392 (reviewer reject with actionable findings).
- Already non-repairing (fail before any repair decision): protocol / provider / auth failures
  (`!res.ok`, preflight), malformed or wrong-candidate review (`review_invalid`), candidate mutation,
  scope violation of the candidate (`implement()` `outOfScope`), withheld / truncated diff
  (`evidence_invalid` in verify), stored evidence mismatch before review (`verifyRunEvidence`),
  incomplete verification, quarantine / unconfirmed termination, approval void at stage start.
- **Gap 1**: `review()` repairs on ANY actionable finding — a finding naming a path outside the
  approved scope (or an absolute / `..` path) starts a repair (scope expansion; ADV-REPAIR-07).
- **Gap 2**: authorization is checked at stage start only; a revocation during the stage still
  opens a repair attempt row (denied later in `implement()` before launch).
- Re-verification / re-review bind the new candidate (no change needed): `startRepair` sets
  `parent_sha: run.candidate_sha` (~1135) on a NEW run; evidence is filtered by `run.id` (~1173);
  the verdict must name `audited_sha === candidate` and the manifest (~1256); human_ready sets
  `result_run_id: run.id` (~1370); the sealer accepts attempt ≤ 1 + max_repairs only.

Patch (exact text in the file; 4 hunks): module helper `findingsOutsideScope(findings, scope)`
(unsafe paths → "[unsafe path]", rest via `outOfScope`); methods `approvalRefusal(t)` (approvalHolds
without failing) and `repairRefusal(t, findings)` (fresh row: approval / authorize → `approval_void`
"not authorized to repair: …"; out-of-scope finding → `scope_violation` "a finding needs changes
outside the approved scope (…); no repair was started — …"); both `startRepair` call sites become
`if (this.repairsLeft(t)) { const refused = this.repairRefusal(t, …); if (refused) return
this.fail(t, claim, run.id, refused.kind, refused.detail, store|record); return this.startRepair(…); }`.
After applying: in `repair-patch.test.ts` delete the three "[current engine]" tests and drop the
three `.failing` markers (a `.failing` test that passes is reported as a failure).

## Unmet guarantees / limitations (disclosed)

- **Base moved** has no exact `InvalidationReason`; mapped to `repo_unavailable` with a detail.
  Contract delta suggestion (01, additive): `base_changed`.
- **Transient seal failures** (`timeout`, `repo_unavailable`, `candidate_unavailable`,
  `revalidation_unavailable`, non-SealError): no write + alarm, retried on the next notify / sweep,
  at most 3 per execution per process (in-memory counter, resets on restart); then `execution_ended`
  without a result request. While retrying the stage stays queued/running (derived phase
  "finalizing").
- Violations at queued/running are alarmed and denied, but the stage only moves when the engine
  reports (`approval_void`); with the worker stopped the task stays queued (flagged). Flags are
  in-memory; the restart sweep re-derives them (authorize itself derives everything from rows).
- Alarms are in memory (`bridge.alarms()`, bounded 200) + the sink; no durable alarm store (M1 has
  exactly four new tables) and no UI surface yet (lead decision; e.g. an authenticated read route).
- One reconcile queue per process; multiple hub processes stay safe through CAS + UNIQUE (result
  request per run) but would duplicate work. M1 runs one hub.
- No post-acceptance integrity re-check (OQ-10, deferred).
- `bridge.start()` after `stop()` does nothing (one-shot lifecycle).

## Lead-owned patch proposals (not applied)

1. `orchestrator-repair.patch` (above).
2. Hub wiring as in "API and exact wiring" (L2 / L6); `onChange` = `bridge.notify` only (L4).
3. Optional test hook for 09's harness: `OrchestratorHooks.at` union + `"before_cancel_confirm"`
   awaited in `runTask` right before `this.finishCancel(t, claim)` — an alternative to the held
   heartbeat that keeps lease renewal running (test-only, never set in production).
4. Contract (01, additive): `InvalidationReason.base_changed`.

## v1.2 corrective (durable accepted evidence + current acceptance validity)

Spec: `docs/workspace-m1/CONTRACT_V1_2.md` §B/§C (details of the bundle/validity modules: `../evidence/NOTES.md`).

- **Gate-2 opening** (`sealAndCommit`): an ELIGIBLE sealed result is offered only after `publishSealedEvidence` (the sealer's own buffers → `<artifacts_root>/_sealed/<digest>.bundle`) succeeded, outside any tx. `commitSeal` then inserts the bundle row and the pending request carrying `evidence_bundle_digest` in ONE transaction (FK + 009 trigger: the bundle must seal this envelope of this attempt). Ineligible / cancel_won results: no bundle (nothing is offerable). A crash between publication and commit leaves an orphan content-addressed file; the restart sweep re-seals (same buffers ⇒ same digest ⇒ byte-equal target accepted) and commits.
- **Publication failure**: counted on the existing per-execution transient counter (`maxTransientSealFailures`, default 3; alarm `seal_failed` "durable evidence seal failed (<code>, attempt n of 3)"; retried by notify/sweep); at the bound the result is recorded `invalidated(evidence_unavailable)` with `invalidation_detail = "durable evidence seal failed"`, stage → `execution_ended`. Nothing is ever acceptable without durable evidence. A transient cause (e.g. `_sealed` unwritable) that clears before the bound → offered normally.
- **Legacy pending Gate 2** (no digest; pre-009): every sweep invalidates it — `evidence_unavailable`, detail "legacy result without durable evidence; a new proposal and approval are required", `awaiting_acceptance → execution_ended` (`result_invalidated`, reconciler).
- **Accepted-result revalidation**: part of `sweep()` (startup + every `intervalMs`, default 30 s via `start()`): up to `maxAcceptedChecksPerSweep` (default 20) validity rows with status `valid|unknown`, oldest `checked_at` first; `checkAcceptance` (bundle, source artifacts vs bundle, candidate commit/tree) → `recordAcceptanceVerdict`. New `invalid` → alarm `acceptance_invalid` (fixed text + reason). Sticky rows are never selected. Check/record errors → alarm `acceptance_check_error`, retried next sweep. The three sweep parts (Gate-1 policy, legacy, accepted) are isolated: one failing never skips the others.
- `SweepReport` gains `legacy_invalidated`, `accepted_checked`, `accepted_invalid`. `WorkspaceBridgeDeps` gains optional `gitFor`, `maxAcceptedChecksPerSweep`; `BridgeHooks.publishFaults` (test-only).
- Tests: `durable-evidence.test.ts` (8): bundle exists before the request row and commits with it; injected publication failure → 3 bounded attempts → invalidated "durable evidence seal failed", nothing acceptable; unwritable `_sealed` recovers on the next sweep; legacy pending → invalidated; clean control stays `valid` (checked_at advances), source tamper → `invalid` sticky + alarm, restore doesn't help, restart keeps it, original served from the bundle; ≤ N per sweep oldest first; `git replace` → `candidate_mismatch`; unrunnable git → `unknown` then `valid`.
- Supersedes "No post-acceptance integrity re-check (OQ-10, deferred)" above.

Lead-owned proposal (optional): `workspace-hub.ts` — pass the shared `gitFor` into `createWorkspaceBridge({ …, gitFor })` (today the bridge defaults to `defaultGitFor(config)`, which is the same runner).

## v1.2 Fix 4 — criterion coverage

Gate 2 opens only if the sealer's `resultEligibilityV1_2(envelope, proposal)` holds (fail closed). The result of a legacy v1 proposal (approved before v1.2) is recorded `invalidated(evidence_unavailable)` with `LEGACY_PROPOSAL_DETAIL` (no bundle, stage `execution_ended`, stage detail names `criteria_unmapped`). `test-support.ts`: `draft()` maps every criterion to `fixture-check` explicitly (`withCoverage`, unless the caller passes `criterion_checks`). Tests `criterion-coverage.test.ts` (2): clean v1.2 run opens Gate 2 with satisfied coverage; legacy v1 → invalidated with the explicit detail. Follow-up (obsolete v1 grants): the policy sweep invalidates a pending Gate 1 of a non-v1.2 proposal first (`evidence_unavailable`, `OBSOLETE_V1_GRANT_DETAIL`, stage detail `OBSOLETE_V1_GRANT_STAGE_DETAIL`, reservation released, task → draft — the same rows as the decision path); `authorize` denies an approved v1 execution with class `obsolete` under `policy: true` (orchestrator: `approval_void` before every stage), and the reconciler's structural pass (`policy: false`) records its cancel intent (queued/active, no violation alarm); a v1 execution already at human_ready is sealed as above. Tests `obsolete-v1-grant.test.ts` (8), `validity-batch.test.ts` (1: 22 accepted, batch 20 — the 21st by a detail read, the 22nd by the next sweep).
