# Role 02 — workspace persistence: integration notes

Scope: `apps/hub/src/workspace-m1/persistence/` only. Contracts: frozen v1 (+ v1.1) in
`packages/schema/src/workspace-m1/` (INTERFACE.md §4, §6, §7, §10, §11). No contract edited.

## Files

| File | Role |
| --- | --- |
| `008_workspace_approvals.sql` | Proposed migration (not registered). 4 tables, 8 indexes, 12 triggers. |
| `migration.ts` | `ensureWorkspaceSchema(db)`: applies 008 + `PRAGMA user_version = 8` in ONE immediate transaction, only if `user_version < 8` (re-read inside the transaction); refuses if the DB is not at 007. No-op once the lead registers the file. |
| `store.ts` | `createWorkspaceStore(db)` → `PersistentWorkspaceStore` (implements `WorkspaceStore`/`WorkspaceTx` of `ports.ts` + additive reads). `openTxOn(tx, db)`. |
| `managed-writes.ts` | `reserveManagedTask`, `enqueueApprovedTask`, `releaseReservedTask`, `currentPolicyHash` — the managed writes 05 wraps behind `ExecutionBridge`. |
| `errors.ts` | `WorkspaceConflictError{table, constraint}`, `WorkspaceRowError`, `WorkspaceIntegrityError`, `WorkspaceTxError`. |
| `index.ts` | Public barrel (no test helpers). |
| `testkit.ts`, `concurrency-worker.ts`, `crash-child.ts` | Test-only support (synthetic data, no git, no network). |
| `*.test.ts` (6) | migration (incl. registered-copy byte-equality guard), store, managed-writes, transaction (nesting + failure injection), concurrency, restart. |

## Commands and results (isolated runner, 2026-10-02)

```
run.sh bun --no-env-file test apps/hub/src/workspace-m1/persistence   → 64 pass, 0 fail (6 files); 5 earlier repeats green
run.sh bunx biome check apps/hub/src/workspace-m1/persistence          → Checked 14 files, no fixes, 0 errors/warnings
run.sh bun run typecheck                                               → all 5 projects pass
run.sh bun --no-env-file scripts/check-secrets.ts                      → [check:secrets] ok — scanned 223 files
run.sh bun --no-env-file test apps/hub (combined, incl. other roles)   → 547 pass, 0 fail, 30 files, no unhandled errors
```
(`run.sh` = `/private/tmp/claude-501/…/scratchpad/iso/run.sh`.) Concurrency file alone: 10/10 repeats green.

## Schema inventory (008)

Exactly four new tables — **no auth/session/challenge table** (sessions in memory; challenge
fields on `managed_approval_requests`, per §4/§7). A test asserts the added-table set.

| Table | Key constraints |
| --- | --- |
| `workspace_tasks` | PK id; UNIQUE(created_by, idempotency_key); UNIQUE(current_managed_task_id); CHECK stage ∈ 11; CHECK (stage='accepted') = (accepted_decision_id NOT NULL); CHECK execution stages ⇒ both current pointers set; CHECK cancel_requested ⇒ cancel_requested_at; json_valid(draft) |
| `managed_proposals` | PK id; UNIQUE(workspace_task_id, version); UNIQUE(proposal_hash); CHECK (version=1) = (predecessor NULL); snapshot = canonical text verbatim |
| `managed_approval_requests` | PK id; UNIQUE(binding_hash); partial UNIQUE(managed_task_id) WHERE kind='run'; partial UNIQUE(run_id) WHERE kind='result'; partial UNIQUE(workspace_task_id, kind) WHERE status='pending'; CHECKs: run ⇒ run_id/envelope/envelope_hash NULL, result ⇒ all set; pending ⇔ closed_at NULL; invalidated ⇔ reason NOT NULL; run never `accepted`, result never `approved`; challenge columns all NULL ⇔ challenge_status='none' |
| `managed_decisions` | PK id; UNIQUE(approval_request_id); UNIQUE(operator_id, idempotency_key); CHECK kind/action pairs; approve/accept ⇔ confirmation_text='Edward' ⇔ reason NULL; result ⇔ result_envelope_hash NOT NULL; response_status 200–299 |

Non-unique indexes: `idx_workspace_tasks_updated`, `idx_approval_task`, `idx_approval_status`
(HQ inbox), `idx_decisions_task`.

Triggers (all `RAISE(ABORT)`, enforced for every writer, not just this store):

- `managed_proposals_no_update`, `managed_proposals_no_delete` (immutable); `managed_proposals_lineage` (v N>1 names v N-1 of the same task → versions contiguous).
- `managed_decisions_no_update`, `managed_decisions_no_delete` (append-only); `managed_decisions_match_request` (task, kind, binding_hash, managed_task_id, result_envelope_hash equal the request's; request is `pending` or already closed by THIS action).
- `managed_approval_requests_links` (proposal belongs to the task with that hash; run_id is an attempt of managed_task_id; a result request needs the APPROVED run request of the same execution; new rows rev 1, no challenge), `_update_rules` (closed request never changes; rev +1 exactly; subject/binding columns immutable), `_no_delete`.
- `workspace_tasks_insert_shape` (new task: draft, rev 1, no pointers), `_update_rules` (terminal accepted/rejected frozen; rev +1 exactly; identity columns immutable; pointers never cleared; pointer validation below), `_no_delete`.

Additive to §4 (mirror rows.ts/state.ts): the rev/immutability/terminal/no-delete triggers and the
extra stage CHECKs. Retention: workspace tasks, proposals, requests and decisions are never deleted;
invalidated/superseded requests and old proposal versions stay as history (tested across restart).

## Foreign-key decision (L-15 respected)

- All FKs are default NO ACTION; **no `ON DELETE CASCADE`** anywhere (test parses `PRAGMA foreign_key_list` and the SQL text).
- FK graph is acyclic: every FK points down the ownership tree (decision → request → proposal → task) or out to `managed_tasks` / `managed_runs`.
- The two up-pointers `workspace_tasks.current_proposal_id` and `accepted_decision_id` are **plain columns validated by triggers** (exists, same task; accepted = a `result`/`accept` decision of this task for the current managed task). Equally enforceable because the targets can never disappear (proposals/decisions refuse DELETE).
- `current_managed_task_id` has an FK to `managed_tasks` **and** a trigger: there must be a `run` request of this task for that managed task AND for `current_proposal_id`.
- Consequence: a managed task/run referenced by a workspace row can no longer be deleted (`managed_runs` cascades from `managed_tasks`, then our NO ACTION FKs fail the whole delete). Intended (history).

**Hard write-order rules for 04/05** (immediate checks; violations raise a `WorkspaceRowError` naming the trigger):
1. Publish: `insertProposal` → `reserveManagedTask` → `insertApprovalRequest` → `updateTask(pointers, stage)`.
2. Decision: `insertDecision` must run while the request is still `pending` or after it was closed by the same action; `enqueueApprovedTask` must run **after** `insertDecision` (it verifies the approve decision exists in the transaction).
3. Gate-2 accept: insert the `accept` decision before setting `accepted_decision_id`.
4. Every stage change must exist in `WORKSPACE_TRANSITIONS` (any trigger/actor) — the store refuses e.g. `draft → queued`. Actor/trigger checks stay with 04/05.
5. **Every `updateApprovalRequest` bumps `rev` by 1.** A separate `verifyAndConsume` CAS followed by the status-closing update = two bumps (the `testkit.ts decideRun` reference does this; receipt `approval_request.rev = expected_request_rev + 2`). Alternative: fold `challenge_status: "consumed"` into the closing patch (one bump). 03 and 04 must agree on one, or the precomputed receipt rev is off by one.
6. **Never call `store.transaction()` while a transaction is open** — it throws (`WorkspaceTxError`). In particular 05 must not call it from inside `withFence`, `setTaskState`, `claimNext` or an orchestrator callback such as `authorize` (which can run inside a managed transaction). Plain reads (`store.getTask`, …) are fine anywhere.

## Store semantics

- `transaction(fn)`: `db.transaction(fn).immediate()` = one `BEGIN IMMEDIATE`. Refuses when `db.inTransaction` (would silently become a SAVEPOINT), refuses thenable results (async callbacks; rolled back), and the tx object is dead after the callback (`WorkspaceTxError`).
- Writes: rows validated with the rows.ts schemas; `insertTask` also requires `request_hash = createTaskRequestHash({repo_id, draft})`; hashed structures are re-sealed (`seal`) and must equal their hash column; cross-checks (binding ↔ row, envelope ↔ row, execution binding base_sha ↔ proposal, snapshot repo ↔ task, receipt ↔ decision row).
- CAS: `updateTask`/`updateApprovalRequest` → `null` on rev miss or unknown id; patch keys whitelisted; merged row re-validated; rev +1 and `updated_at = now` on every write. A closed request / terminal task throws instead of updating. Status moves must satisfy `canTransitionApproval`.
- Unique conflicts → `WorkspaceConflictError.constraint` ∈ `primary_key | workspace_task_idempotency | workspace_task_managed_task | proposal_version | proposal_hash | binding_hash | run_request_per_managed_task | result_request_per_run | one_pending_request | decision_idempotency | decision_per_request`. An exact duplicate row hits several rules; SQLite names the first index it checks. Call `findReceipt` BEFORE `insertDecision`.
- Reads: every hashed column re-checked with `storedCanonicalMatches`; any mismatch / DTO failure → `WorkspaceIntegrityError` (fail closed; 04 should answer `integrity_failed`). Tampering below the triggers (trigger dropped + column edited) is detected (tested).
- Restart: opening/migrating/creating the store writes nothing (byte-identical dumps before close / after reopen, tested twice). Nothing is resumed by this module. Note for 05/lead: the orchestrator's existing `reconcile()` may resume a non-model step (bounded by `infra_retries`, approval + `authorize` rechecked) — that is engine policy, not persistence.

## Managed writes (for 05)

All three take `(deps: {db, config, hooks?}, tx: WorkspaceTx, input)` and call `openTxOn(tx, db)`
first: they throw unless `tx` is an OPEN transaction of this store on the same handle. They only call
existing functions (`createTask`, `requestRun`, `requestCancel`, `getTask`, `openQuarantineFor`); no
direct SQL on `managed_*`; no managed file edited.

- `reserveManagedTask(deps, tx, {proposal, proposal_hash, approval_request_id, now, managed_task_id?})` → `ReservedExecution & {execution_binding_canonical}`. Checks: snapshot hashes to `proposal_hash`; proposal row already stored; repo allowlisted; `TaskSubmission.parse` is the identity on the snapshot fields (else `submission_altered`); `createTask` with pre-minted id, `idempotency_key = approval_request_id`, `request_hash = execution_binding_hash` (policy = current `policyHash`); result is `draft` with content byte-equal to `managedTaskFieldsFor`.
- `enqueueApprovedTask(deps, tx, {managed_task_id, decision_id, execution_binding_hash, now})` → `EnqueueResult`. Only from `draft` (requestRun alone would also re-queue blocked/interrupted — tested closed); repo allowlisted; run request pending/approved; decision = that request's `approve` (else throws `decision_mismatch`); `task.idempotency_key = request.id`; `task.request_hash = request.execution_binding_hash = input = recomputed sealExecutionBinding(…, policyHash(config, repo))`; task content = `managedTaskFieldsFor(proposal)`; no open quarantine; then `requestRun(db, id, approvalHashFor(task, config), now)`. A `{queued:false}` result must make the caller throw (roll back the decision).
- `releaseReservedTask(deps, tx, {managed_task_id, reason, now})`: must be a workspace reservation; `cancelled` → no-op; `draft` → `requestCancel` → must be `cancelled`; anything else throws `not_draft` (violation). The reason lives on the request/decision.
- `hooks.enqueue(point)` is a test-only failure-injection point (`before_request_run` / `after_request_run`).

## Transaction / nesting evidence (transaction.test.ts)

- Inside `store.transaction`, a raw `BEGIN IMMEDIATE` throws "cannot start a transaction within a transaction", yet the managed `createTask` (its own `db.transaction(fn).immediate()`) succeeds and is visible → it ran as a SAVEPOINT; the outer throw removes it.
- Inner failure (TEMP trigger aborting requestRun's UPDATE) rolls back only to the savepoint; the outer transaction continues and commits.
- Failure injection, 8 points, each asserting: byte-identical dump of all workflow + engine tables, 0 decisions, no receipt, managed task `draft` with unchanged `fence_token`/`rev`/`approval_hash`, request `pending` with unchanged rev and challenge columns (`issued`, same hash), task stage/rev unchanged; then the same decision succeeds exactly once and a duplicate replays: after challenge consumption; after `insertDecision`; inside enqueue before requestRun; **inside enqueue after requestRun returned** (state `queued` observed inside the tx first); inside requestRun's own savepoint; after all effects; **at COMMIT** (deferred FK violation); request_changes after `releaseReserved` (`cancelled` observed first).

## Concurrency / restart evidence

- Workers (own `Database` handle each, busy_timeout 5 s) released together by a SharedArrayBuffer gate: different keys on one Gate 1 → `["decided","stale"]` ×4 rounds, 1 decision, `fence_token` +1 once; same key (duplicate delivery) → `["decided","replayed"]`; 4 handles racing `ensureWorkspaceSchema` → one `applied`.
- Same-thread: stale read on a second handle is refused by CAS; `BEGIN IMMEDIATE` blocks a second handle up front (`database is locked` after its busy timeout).
- Subprocess crash (`process.exit` in the hook after requestRun, exit 17) → nothing persisted; crash right after COMMIT (exit 18) → exactly one effect, retry replays the stored receipt. Lost response after reopen → byte-identical receipt; different payload with the same key → conflict, nothing overwritten.

## Lead-owned patch proposals (not applied)

1. **Migration registration (L1):** copy byte-identical
   `apps/hub/src/workspace-m1/persistence/008_workspace_approvals.sql` → `packages/schema/migrations/008_workspace_approvals.sql`. `ensureWorkspaceSchema` then becomes a no-op (tested: db.ts `migrate()` semantics produce the identical schema). Never edit after registration.
2. **`apps/hub/src/db.ts` pragma order:** concurrent opens of one file fail instantly with "database is locked" because `busy_timeout` is applied after `journal_mode = WAL`. Proposed:
   ```diff
   	const db = new Database(path, { create: true, strict: true });
   +	db.run("PRAGMA busy_timeout = 5000");
   	db.run("PRAGMA journal_mode = WAL");
   	db.run("PRAGMA foreign_keys = ON");
   -	db.run("PRAGMA busy_timeout = 5000");
   ```
   (The hub uses one handle, so production is unaffected; tests open worker handles sequentially.)
   Same caveat: `migrate()` reads `user_version` outside its (deferred) transaction, so two handles
   opening a FRESH file race on 001 ("table … already exists"); reading it inside an immediate
   transaction — as `ensureWorkspaceSchema` does — would close that.
3. **Port delta v1.2 (additive, `ports.ts`):** `WorkspaceReads` gains `findTaskByIdempotencyKey(created_by, key)` (create-task cannot be key-idempotent without it — OQ-6), plus `listTasks`, `listProposals`, `listDecisions`, `findRunRequestForManagedTask`, `findResultRequestForRun`, `findTaskByManagedTask` (needed for `WorkspaceTaskView`/snapshot and engine→workspace reconciliation). Implemented here as `WorkspaceReadsExt`; consumers: lead routes, 04, 05.
4. **`ExecutionBridge.enqueueApproved`:** document the precondition "the Gate-1 approve decision is inserted in this transaction"; a missing decision is thrown (not an `EnqueueResult` reason).
5. **Legacy bypass (INTERFACE §12.2):** still needed in `managed/store.ts requestRun` / routes — `enqueueApprovedTask` refuses non-draft itself, but the legacy `requestRun` would re-queue a workspace task's `blocked`/`interrupted` managed task. Suggested guard inside its tx: `SELECT 1 FROM managed_approval_requests WHERE managed_task_id = ? LIMIT 1` → `{queued:false}`.
6. Informational: managed `update()` stamps `updated_at` with `new Date()` instead of the caller's `now` (tests compare `rev`, not `updated_at`).

## Readiness for role 04 (decisions)

Ready. The accepted port surface (`WorkspaceStore`/`WorkspaceTx`, CAS updates, typed unique
conflicts, `findReceipt`) and the transaction tests (rollback, nesting, failure injection at 8
points incl. COMMIT, concurrency, lost response, restart) pass. 04 should follow the write-order rules
above; the reference sequence is `testkit.ts decideRun` (receipt lookup → `BEGIN IMMEDIATE` →
re-check receipt → compare request/task → consume challenge → insert decision with precomputed
receipt → close request → move stage → enqueue/release → assert effects = receipt). 03 implements
`ChallengePort` on top of `updateApprovalRequest` (challenge hashing is not implemented here).

## 009_accepted_evidence_validity (v1.2 corrective)

Registered at `packages/schema/migrations/009_accepted_evidence_validity.sql` (no copy here); 008 untouched.

- `managed_evidence_bundles` (digest PK hex-64, result_envelope_hash, managed_task_id → managed_tasks, run_id → managed_runs, rel_path = `_sealed/<digest>.bundle`, byte_len > 0, item_count 0–64, created_at): append-only (no update / delete triggers); insert trigger: run is an attempt of the managed task.
- `ALTER TABLE … ADD COLUMN evidence_bundle_digest TEXT REFERENCES managed_evidence_bundles(digest)` on `managed_approval_requests` and `managed_decisions` (appended last; ADD COLUMN rewrites no row and fires no 008 trigger; 008's closed-request / append-only / terminal-task triggers are verified intact on a genuine 008 database). Triggers: a request digest only on a result request whose bundle seals the same envelope + attempt (insert); immutable even while pending (update); a decision digest only on a Gate-2 accept and then exactly its request's (`IS`, so legacy accepts stay NULL = NULL).
- `managed_acceptance_validity` (decision_id PK → decisions, result_request_id UNIQUE → requests, workspace_task_id → tasks, evidence_bundle_digest → bundles NULL only for `unverifiable`, status/reason/detail/checked_at/first_invalid_at/rev with CHECKs mirroring `AcceptanceValidityRow`): insert only `valid` (accept with the decision's digest) or `unverifiable`, rev 1; update: `invalid`/`unverifiable` sticky, rev +1, identity immutable; never deleted.
- Backfill: one `unverifiable` / `legacy_no_durable_evidence` row per pre-existing Gate-2 accept (checked_at = migration time), nothing invented.
- Store: column maps + `BUNDLE_COLUMNS`/`VALIDITY_COLUMNS` (pinned to `PRAGMA table_info`); a NULL digest is read as an ABSENT key (pre-009 row shape preserved, so legacy rows deep-equal their pre-009 reads); `insertDecision` cross-checks `effects.evidence_bundle_digest` = row digest; new `getEvidenceBundle`, `getAcceptanceValidity`, `listAcceptanceValidity({statuses, limit})` (oldest check first), tx `insertEvidenceBundle` (identical row = no-op, else `primary_key` conflict), `insertAcceptanceValidity`, `updateAcceptanceValidity` (CAS; sticky → `WorkspaceRowError`). New conflict constraint `acceptance_validity_per_request`.
- `ensureWorkspaceSchema` (test helper) now brings a 007 DB to 9 and applies all pending steps in ONE immediate transaction (db.ts applies one transaction per file; one transaction keeps the 4-handle race test's exactly-once outcome and rolls back atomically). `WORKSPACE_SCHEMA_VERSION = 9`; `EVIDENCE_VALIDITY_MIGRATION_FILE` exported.
- Tests: `migration.test.ts` / `concurrency.test.ts` updated to version 9 + the 009 inventory (tables, columns, triggers, FK edges, no CASCADE in either file); new `evidence-validity.test.ts` (6): genuine-008 → 009 (legacy rows unchanged, 008 triggers intact, backfill, read model shows `unverifiable`), bundle/request/decision/validity triggers, store API. `testkit.ts` gains `gate2Accept`.

## 010_proposal_contract_v1_2 (Fix 4) — required to store v1.2 proposals

008 declares `managed_proposals.contract_version CHECK (= 'agentcity.proposal/v1')`, so a v1.2 snapshot cannot be stored. SQLite cannot alter a CHECK and 008 is never edited, so `packages/schema/migrations/010_proposal_contract_v1_2.sql` rebuilds the table inside the migration transaction: `PRAGMA defer_foreign_keys = ON` → rows to a TEMP copy → `DROP TABLE` (implicit delete fires no trigger; references only increment the deferred FK counter) → `CREATE TABLE managed_proposals` (same columns/order/keys/FKs; CHECK `IN (v1, v1.2)` + new `CHECK (json_extract(snapshot,'$.contract') = contract_version)`) → re-insert (each parent row decrements the counter, COMMIT checks every reference) → the three 008 triggers re-created verbatim. No RENAME, so other tables' FK/trigger references keep resolving by name. Proven on a genuine 009 DB with legacy rows (`proposal-v1_2.test.ts`, 2): rows/requests/decisions byte-identical, `foreign_key_check` empty, trigger SQL identical, schema = a fresh DB's, immutability still enforced, v1.2 rows fit next to v1 rows, mislabelled / unknown contracts rejected by CHECK.

Store: `insertProposal` seals with `sealAnyProposal` (v1.2 id ↔ text binding refused → `WorkspaceRowError`); `decodeProposal` re-checks `criterionIdsMatch` for v1.2 (→ `WorkspaceIntegrityError`: a coherent rewrite with a forged id is refused on read); `insertApprovalRequest` seals the envelope as `AnyResultEnvelope` (the v1.2 schema re-derives coverage, so a forged coverage never parses). `managed-writes.ts` reserve accepts `AnyProposalSnapshot`. `testkit.ts`: `draftFixture` maps both criteria to `unit`; `publishProposal`/`approvedExecution`/`gate2Accept` publish v1.2 unless `{ legacy: true }`. `WORKSPACE_SCHEMA_VERSION = 10`.
