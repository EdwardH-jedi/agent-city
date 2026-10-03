# Role 04 — workspace decisions: integration notes

Scope: `apps/hub/src/workspace-m1/decisions/` only. Contracts used unchanged (frozen v1 + v1.1).
Built on the accepted 02 store/managed writes, 03 auth/ChallengePort and 06 sealer/reader. No
lead-owned or other-role file was edited.

## Files

| File | Role |
| --- | --- |
| `decision-service.ts` | `createDecisionService(deps)` — `DecisionService` port: `issueChallenge`, `decide` (both gates). |
| `commands.ts` | `createWorkspaceCommands(deps, reads)` — create task, save draft, publish proposal, rerun, cancel. |
| `read-model.ts` | `createWorkspaceReadModel` — snapshot, task view/detail, artifact read (06 reader). |
| `router.ts` | `createWorkspaceRouter(deps)` (Hono) + `createWorkspaceServices(deps)`. |
| `engine.ts` | `createManagedBridge` — the frozen `ExecutionBridge` port over 02's managed writes (replaceable by 05); `engineViewOf`, `scrubDetail`. |
| `outcome.ts` | fixed-message errors, safe zod issues, `DecisionAbort`, `mapKnownError`. |
| `deps.ts` | `WorkspaceServiceDeps`, test hooks (`beforeTransaction`, `inDecisionTx`). |
| `index.ts` | public barrel (no test helpers). |
| `test-support.ts` | test-only: `makeFixture` env, real auth + fake clock, counting fake adapters, Orchestrator drain, bridge emulation at human_ready (`openGate2`), dumps. |
| `*.test.ts` (6) | gate1, gate2, commands, restart, router (e2e), engine. |

## Commands and results (isolated runner `run.sh`, 2026-10-02)

```
run.sh bun --no-env-file test apps/hub/src/workspace-m1/decisions → 75 pass, 0 fail (7 files)
run.sh bun --no-env-file test apps/hub/src/workspace-m1           → all roles' suites together, 0 fail
run.sh bunx biome check apps/hub/src/workspace-m1/decisions        → 15 files, 0 errors/warnings
run.sh bun run typecheck                                           → all 5 projects pass
run.sh bun --no-env-file scripts/check-secrets.ts                  → ok
```

## Mount (lead, `routes/workspace.ts`)

```ts
import { createWorkspaceRouter } from "../workspace-m1/decisions/index.ts";
const retained = new RetainedEvidenceStore();                       // one per hub process
const sealer = createEvidenceSealer({ db, config: frozenConfig, reads: store, retained, gitFor });
const ws = new Hono();
auth.install(ws);                                                   // FIRST (03)
ws.route("/", createWorkspaceRouter({
  auth,                                                             // verified/principal/challenges
  store,                                                            // createWorkspaceStore(db) — same handle
  config: frozenConfig,                                             // the orchestrator's frozen snapshot
  sealer,
  reader: { db, config: frozenConfig, retained, gitFor },
  bridge,                                                           // 05's ExecutionBridge (default: createManagedBridge)
  clock: authClock,                                                 // SAME clock object as createWorkspaceAuth({clock})
}));                                                                // mount LAST on ws (it ends with a 404 catch-all)
app.route(WORKSPACE_API_BASE, ws);
```

`clock` matters: `issue`/`verifyAndConsume` check session liveness and challenge expiry with the
`now` the service passes; sessions were created with auth's clock. Production: both default to the
system clock (pass nothing, or the same object to both). The router composition is proven by
`router.test.ts` (unauthenticated → 401 on every route incl. HEAD and crafted live bodies).

## Decision transaction invariants (`decide`)

Order (§7/OQ-1, after 03's guard): live precedence → strict `DecisionRequest` → receipt lookup
`(operator_id, idempotency_key)` → found: same `payload_hash` → stored receipt, stored status (201),
`replayed:true`, no effects; different → 409 `idempotency_conflict` (a non-`Edward` confirmation is
necessarily a different payload) → not found: exact `Edward` (422 `confirmation_mismatch`) → cheap
subject pre-check outside any tx → Gate 2: `revalidateForGate2` outside any tx → `BEGIN IMMEDIATE`:

1. re-check the receipt (a concurrent duplicate may have committed) → replay/conflict;
2. re-load request + task + engine; ALL checks return errors **before any write**:
   status (`invalidated` → `stale_binding`, other non-pending → `invalid_state`), kind, stage =
   `DECISION_STAGE[kind]`, task's current pointers name this request's execution/proposal,
   binding_hash, rev (`stale_binding`); Gate 1 approve: reserved task `draft`, not quarantined, repo
   allowlisted, execution binding recomputes under the CURRENT policy (else `stale_binding`); Gate 1
   decline: reserved task `draft|cancelled`; Gate 2: sealed hash = bound hash, engine `human_ready`,
   `result_run_id = run_id`, no cancel intent (engine or workspace), no open quarantine (`invalid_state`);
3. `challenges.verifyAndConsume` — the FIRST write to the request row (r → r+1); failure →
   `challenge_invalid`, nothing written (R-A2);
4. **point of no return — every failure throws** (rollback incl. the consume): receipt precomputed
   (`approval_request.rev = r+2`, `workspace_task.rev = rev+1`) → `insertDecision` (receipt verbatim,
   `request_rev = expected_request_rev`) → close request at r+1 → move stage (+ `accepted_decision_id`
   for accept) → Gate 1 approve: `enqueueApproved(now = decided_at)` (`{queued:false}` throws;
   `run_requested_at === decided_at` asserted) | Gate 1 decline: `releaseReserved` | Gate 2: nothing
   (engine stays `human_ready`, nothing merged) → assert engine state / revs / stage = receipt;
5. 201 `{receipt, replayed:false}`, validated with `DecisionResponse`.

Gate 2 revalidation (R-E5): `timeout | repo_unavailable | candidate_unavailable |
revalidation_unavailable` and hash-equal-but-ineligible → 409 `evidence_unavailable`, **no write**
(challenge stays issued). Any other seal failure or hash mismatch → own small tx: request →
`invalidated(candidate_mutated | integrity_failed)`, task `awaiting_acceptance → execution_ended`
(§6 `result_invalidated`), then 409 `integrity_failed`. This is the only durable effect of a failed
attempt (lead ruling). `issueChallenge`: same pre-checks inside one tx, then 03's `issue` (bumps rev);
`ChallengePortError` → its code. Proven by tests: receipt = durable state; failure injection at 4
points rolls back to a byte-identical dump; 20 concurrent decisions → exactly one decision/linkage.

## Commands

Create: key-idempotent (`findTaskByIdempotencyKey`, re-checked in the tx; same `request_hash` → 200,
else 409). Draft/publish/rerun/cancel: CAS on `expected_rev` (`stale_binding`). Publish resolves the
base with `validateRepo + resolveCommit` BEFORE the tx (repo unknown / no checks / unresolvable →
422 `repo_not_allowed`; incomplete draft → 400 with issues), then 02's write order: proposal
v(N+1) → supersede pending run request (`proposal_superseded`) + `releaseReserved` → `reserve` → run
request → pointers/stage (clears `cancel_requested_at`). Rerun: `RERUNNABLE_STAGES`, `proposal_id =
current`, no open quarantine on the previous execution, no pending request. Cancel: Gate 1 pending →
request `withdrawn` + release → `cancelled`; queued/running → `requestCancel` (queued + unleased →
`cancelled`, else `cancel_requested`; never `cancelled` before the engine confirms); engine already
`human_ready|failed|cancelled` (bridge lag) or stage `awaiting_acceptance` → 409 `invalid_state`
(R-A1); `cancel_requested` + matching rev → 200 current view, no write, no rev bump; stale rev
→ 409 `stale_binding` (lead ruling, tested). Artifact text follows v1.1 exactly (R-E3 dropped).

## What role 05 (bridge) must provide

- An `ExecutionBridge` on the SAME Database handle (or keep `createManagedBridge`). `requestCancel`
  is called INSIDE the cancel transaction (the port has no tx param): it must not call
  `store.transaction()`; managed `requestCancel` nests as a savepoint (fine).
- Orchestrator `authorize(task)`: run request for the task `approved`; its decision `approve` exists;
  `sealExecutionBinding({...binding, policy_hash: policyHash(frozenConfig, repo)}).hash ===
  execution_binding_hash`; **`task.run_requested_at === decision.decided_at`** (any later re-queue by
  another path changes it); workspace task's `current_managed_task_id` = this task.
- Reconciliation per `engineStageEffect`: queued→running, ended → `execution_ended`, cancelled,
  `cancel_won`, `reissue_cancel`, violation alarm (`awaiting_run_approval` with a non-draft
  reservation fails closed — 04 also refuses to approve it).
- At `human_ready` (outside any tx): `sealer.seal(...)` with `run_decision_id` = the Gate-1 decision;
  eligible → result request `pending` + `queued|running → awaiting_acceptance`; ineligible →
  `invalidated(evidence_unavailable)` + `result_unavailable`; SealError → `result_unavailable`.
  `test-support.ts openGate2` is the reference shape (store `insertApprovalRequest` + CAS stage).
- Sweep: a pending run request whose policy/repo/base changed → `invalidated(policy_changed |
  repo_unavailable)` + `releaseReserved` + `awaiting_run_approval → draft`. (04 refuses such an
  approve with 409 `stale_binding` but does not invalidate — that is the reconciler's row in §6.)

## Lead-owned patch proposals (not applied)

1. `routes/workspace.ts` mount as above (`auth.install` first; this router last on `ws`).
2. Contract gap (01, additive): the closed error set has no 5xx code; the router answers unexpected
   failures with the hub's existing `{error:"internal error"}` 500 (no data). Proposal: add
   `internal_error: 500` to `WORKSPACE_ERROR_STATUS`.
3. 06 `revalidateForGate2` labels every `SealError` `integrity_failed`; 04 remaps the transient codes
   (R-E5). Suggest 06 return `evidence_unavailable` for them itself so other callers agree.
4. `ports.ts` `ChallengePort.verifyAndConsume` returns `{ok:true}`; 03 returns `{ok:true, request}`.
   04 re-reads the row in the tx (works with either).

## Contradictions / rulings applied (please confirm)

- Replay status: frozen §7 "stored status" → **201** + `replayed:true`; MATRIX ADV-IDEM-01 says 200.
- Malformed repo ids (`local/fixture/`, `local/./fixture`) fail the frozen `RepoId` schema → 400
  `invalid_request`; MATRIX ADV-INPUT-07 expects 422 for all variants (well-formed unknown → 422).
- MATRIX proposed codes (`challenge_expired`, `challenge_consumed`, `not_pending`, `stale_rev`) → the
  frozen set: `challenge_invalid`, `invalid_state` (closed request; status is checked before the
  challenge), `stale_binding`.
- §6 lists `result_invalidated` with actor `rec`; the lead assigned the Gate-2 integrity invalidation
  to 04 (the store enforces from/to only). Implemented as described above.
- Rev arithmetic: two bumps (03 consume CAS, then the close) — receipt `approval_request.rev =
  expected_request_rev + 2` (02 NOTES rule 5; 02's `decideRun` reference agrees).

## F-01 fix (08 finding, lead ruling)

Create and save store `storedDraft(draft)`: title, objective and every criterion pass the shared
`redact()` BEFORE storage; scope paths and whitespace are kept; the result is re-validated with
`WorkspaceDraft` and an over-length field after redaction → 400 `invalid_request` + issues (never
truncated). The create `request_hash` is computed over the stored (redacted) draft: the same raw body
replays, a different body conflicts, and bodies differing only inside a masked secret are the same
request (as decision reasons, OQ-3). Publish freezes byte-identical text (redact is idempotent ≤
INPUT_MAX; tested against freezing the raw draft). Tests: `draft-redaction.test.ts`; 08's
`ADV-INVAL-10b` passes.

## Error-mapping notes for QA (08)

- `WorkspaceRowError` (a store CHECK/trigger refused a write) maps to 409 `invalid_state` —
  deliberately fail-closed (the transaction rolled back), but in these flows it should never happen:
  treat such a 409 as a defect signal, not as expected behaviour. `WorkspaceIntegrityError` (a stored
  row no longer verifies) → 409 `integrity_failed`; `WorkspaceConflictError` → 409 `stale_binding`.
- Invalid enum values / unknown keys → 400 with safe issue paths and fixed messages (values and
  unknown key names are never echoed; tested).

## Not directly tested here (code paths only)

- ADV-G2-01 (a result request bound to a superseded attempt of a repaired execution): covered by
  the sealer (`run_not_result` → integrity invalidation) and the in-tx `result_run_id !== run_id`
  check (`invalid_state`); no repair-scenario fixture test in this suite → report as not run.
- Multi-handle (multi-process) races: 02's suite; here same-handle `Promise.all`.

## Limitations

- Gate-2 residual window (06 NOTES): between revalidation and the decision tx (ms) the accepted
  hash names the bytes that were read; later file replacement is detected on any later read only.
- `revalidate` runs git + disclosure CPU in the HTTP handler (fixture-sized, R-E4).
- Engine `state_detail` is redacted and host-path-scrubbed heuristically (`scrubDetail`).
- Multi-handle concurrency is 02's evidence; here concurrency is same-handle (`Promise.all`).
