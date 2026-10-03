# Workspace M1 contracts — v1 (FROZEN)

Owner: role 01 (contracts). Status: **FROZEN v1 by the lead on 2026-10-02**; §11 records the rulings
(freeze edits made by the lead under a recorded lease). Any change is a lead-approved versioned delta
(affected consumers + migration / compatibility impact) — never a quiet edit. Golden vectors
(`fixtures/vectors.json`) are frozen with v1; their sha256 is recorded in
`docs/workspace-m1/CONTRACT_FREEZE.md`.

Imports: `@agent-city/schema/workspace-m1` (web-safe: zod + pure TS; `index.test.ts` enforces it) and
`@agent-city/schema/workspace-m1/hash` (Bun-only: canonical encoder, sha256, hash builders, challenge
tokens, id minting). Do not redefine these types locally.

| File | Contents |
| --- | --- |
| `ids.ts` | id schemas + meanings |
| `primitives.ts` | Sha, Hash, UtcTs, HashedTs, ScopePath, RepoId, BaseRef, CheckId, text rules |
| `proposal.ts` | contract ids, M1 policy, `criteriaFromText`, WorkspaceDraft / ProposalDraft, ProposalSnapshot, `buildProposalSnapshot`, `managedTaskFieldsFor`, `requestsNonSimulatedMode` |
| `binding.ts` | ExecutionBinding, Run/Result ApprovalBinding |
| `result.ts` | EvidenceStatus, ARTIFACT_POLICY, ReviewRecord, ResultEnvelope, `overallEvidenceStatus`, `resultEligibility` |
| `decision.ts` | operator, scopes, CONFIRMATION_TEXT, challenge DTOs, DecisionRequest / Payload / ReceiptBody / Response, error codes |
| `state.ts` | WorkspaceStage table, ApprovalStatus, InvalidationReason, `engineStageEffect`, `stageAfterSealing`, `deriveWorkspacePhase` |
| `rows.ts` | row DTOs of the 4 tables, client views, non-decision command bodies |
| `ports.ts` | port signatures (types only) |
| `canonical.ts`, `hash.ts` | strict canonical encoding and hash builders (Bun-only entry) |

## 1. Identifiers

| Id | Form | Meaning |
| --- | --- | --- |
| workspace task | `wst-<uuid v4>` | The stable unit of work the operator sees (one repo). Owns the mutable draft and the history. |
| proposal | `wsp-<uuid v4>` | Immutable hashed snapshot = **proposal version N** of one workspace task. `version` ≥ 1, monotonic, UNIQUE(workspace_task_id, version); v≥2 names its predecessor. |
| approval request | `wsa-<uuid v4>` | One gate (`run` = Gate 1, `result` = Gate 2) over one immutable binding. Decided at most once. |
| decision | `wsd-<uuid v4>` | Append-only human decision + durable receipt for one approval request. |
| managed task | `task-<uuid>` (existing) | **One bounded engine execution of exactly one proposal version.** Reserved in state `draft` when Gate 1 opens; queued only by an approved Gate-1 decision. A rerun is a new managed task + new Gate 1. |
| attempt | `run-<uuid>` (existing `managed_runs`) | One attempt of a managed task: `attempt_no` 1 = initial, 2 = the single pre-approved repair. |
| candidate | (no id) | The tuple (run_id, candidate_sha, candidate_tree, manifest_hash). |
| boot | `boot-<uuid v4>` | Hub process generation; minted per start; bound into every session and challenge. |
| idempotency key | `[A-Za-z0-9._-]{8,128}` | Client retry key (create task; decisions). |

So: workspace task (1) → proposal versions (n) → managed tasks / executions (n per version) → attempts
(≤ 2 per execution) → candidate (1 per finished attempt). Existing engine ids use the loose
`^task-[0-9a-f-]{36}$` form of the current routes; new prefixes are strict lowercase uuid v4.

## 2. M1 policy (fixed in the contract)

- `execution_mode` is the literal `simulated` everywhere. `requestsNonSimulatedMode(body)` runs **before**
  strict parsing (but after authentication/Origin/CSRF/scope, §7) → `422 live_disabled`, before any
  preflight. An unauthenticated crafted live request therefore gets `401`, also before any preflight.
- Providers: `provider_profiles` = fixed `fake-implementer` / `fake-reviewer` (provider `fake`, mode
  `simulated`, model `null`). Unknown keys (provider, model, argv, paths, repo, base…) fail strict parse.
- `repair_policy.max_repairs ∈ {0,1}`, default **0**, always explicit on the managed task
  (`repair_limit`). `budgets` = `{max_attempts: 1+max_repairs, max_model_invocations: 2×max_attempts}`
  (what `repair_limit` actually enforces; time/output limits are trusted policy inside `policy_hash`).
- `verification_plan.required_checks` = every `verification[].name` of the repo in trusted config order
  (the engine runs all of them; never a client subset).
- `context_policy` = `{source: "base_snapshot", refs: []}`; `seed_sha` = null. No network/host
  isolation is claimed by these fields.
- Repo allowlist is server-checked (`repo_not_allowed`); the contract only validates the id form.
- Scope: `allowed` = engine `approved_scope`; `protected` must not overlap `allowed` (OQ-4).
- Criteria: `string[]`, one per line. `criteriaFromText` splits only on `\n` (`\r\n` = one break),
  trims, drops blank lines; commas/quotes/unicode stay inside a criterion. 1–20 items, ≤ 500 UTF-16
  units, single-line. Title ≤ 120, objective ≤ 4000 (`\n`/`\t` allowed, `\r\n` normalized).
- Text is redacted when frozen; redaction can lengthen text → bounds re-validated, publish fails
  with issues (never truncated). `managedTaskFieldsFor(snapshot)` gives byte-identical managed-task text
  so `approvalHashFor(task)` and the snapshot describe the same work (tested against `TaskSubmission`).

## 3. Canonical encoding (`canonicalEncode`, hash.ts)

JSON with object keys sorted by **UTF-16 code units**, no whitespace, strings escaped exactly as
`JSON.stringify`, `-0` → `0`. Rejects: undefined, functions, symbols, bigint, NaN/±∞, non-integers and
integers beyond ±(2⁵³−1) (encode decimals as strings), non-plain objects (Date, Map, Set, RegExp,
typed arrays, Buffer, class instances, boxed primitives), symbol keys, accessor / non-enumerable
properties, sparse arrays / arrays with extra properties, cycles, depth > 64, lone surrogates (values
and keys). **No Unicode normalization** (NFC ≠ NFD). For every accepted value the output equals the
hub's lenient `canonicalJson` (tested). Hash = sha256 of the UTF-8 bytes, lowercase hex.

Hashed structures use validate-only schemas (no trim/default/transform); `seal(schema, v)` refuses if
parsing changed anything. JSON columns holding a hashed structure store **the canonical text
verbatim**, so `storedCanonicalMatches(column, hash)` is the integrity check.

Vectors: `fixtures/vectors.json` (7 primitive + 9 contract vectors: input → canonical → sha256),
cross-checked with `shasum -a 256`; `fixtures/sample.ts` rebuilds the contract vectors through the real
builders. Regeneration (only with a lead-approved versioned delta): for each primitive input in
`vectors.json` and each structure of `sampleGraph()` write `{name, input, canonical: canonicalEncode(input),
sha256: sha256Hex(canonical)}`, then `bunx biome check --write` the directory; the test "the sample graph
still produces exactly the frozen contract vectors" is the guard.

## 4. Tables (migration `008_workspace_approvals.sql`, SQL by role 02)

DTOs in `rows.ts` match these columns 1:1 (JSON → parsed objects, INTEGER 0/1 → boolean, timestamps
`…Z`). No `managed_*` table is altered; linkage lives in the new tables.

**`workspace_tasks`** — id PK, contract_version, repo_id, created_by, idempotency_key, request_hash,
draft (JSON), stage CHECK(11 stages), stage_detail, current_proposal_id → managed_proposals,
current_managed_task_id → managed_tasks, accepted_decision_id (no FK; see below), cancel_requested_at,
created_at, updated_at, rev DEFAULT 1. UNIQUE(created_by, idempotency_key). CHECK(stage='accepted') =
(accepted_decision_id IS NOT NULL).

**`managed_proposals`** (immutable) — id PK, workspace_task_id → workspace_tasks, version, predecessor_
proposal_id → managed_proposals, contract_version, snapshot (canonical JSON), proposal_hash UNIQUE,
created_by, created_at. UNIQUE(workspace_task_id, version). Suggest a trigger forbidding UPDATE/DELETE.

**`managed_approval_requests`** — id PK, workspace_task_id, kind CHECK('run','result'), proposal_id,
proposal_hash, managed_task_id → managed_tasks(id), execution_binding (canonical JSON),
execution_binding_hash, run_id → managed_runs(id) NULL, result_envelope (canonical JSON) NULL,
result_envelope_hash NULL, binding (canonical JSON), binding_hash UNIQUE, status CHECK(pending,
approved, accepted, changes_requested, rejected, invalidated), invalidation_reason, invalidation_detail,
created_at, updated_at, closed_at, rev; challenge_status CHECK(none, issued, consumed) DEFAULT 'none',
challenge_hash, challenge_operator_id, challenge_session_generation, challenge_boot_id,
challenge_request_rev, challenge_issued_at, challenge_expires_at.
Indexes: UNIQUE(managed_task_id) WHERE kind='run'; UNIQUE(run_id) WHERE kind='result' (one Gate 2
per attempt, ever); UNIQUE(workspace_task_id, kind) WHERE status='pending'. CHECKs: run ⇒ run_id /
result_envelope / result_envelope_hash all NULL, result ⇒ all set; status='pending' ⇔ closed_at NULL;
status='invalidated' ⇔ invalidation_reason NOT NULL; challenge columns all NULL ⇔ challenge_status='none'.
Challenge columns are never serialized to clients (`ApprovalRequestView`).

**`managed_decisions`** (append-only) — id PK, approval_request_id UNIQUE → requests, workspace_task_id,
kind, action CHECK(approve, accept, request_changes, reject), operator_id, idempotency_key, payload_hash,
binding_hash, request_rev, confirmation_text CHECK(NULL or 'Edward'), reason, boot_id, session_
generation, managed_task_id, result_envelope_hash, decided_at, response_status, response_body (JSON).
UNIQUE(operator_id, idempotency_key). Suggest triggers forbidding UPDATE/DELETE. No auth table:
sessions are in memory; challenges live on request rows.

`workspace_tasks.accepted_decision_id` / `current_proposal_id` create reference cycles with the child
tables; 02 decides FK vs plain column (inserts happen in one transaction either way).

## 5. Hash graph (acyclic; no structure contains its own hash; receipts never hashed into subjects)

```
proposal_hash          = H(ProposalSnapshot)                         contract agentcity.proposal/v1
execution_binding_hash = H({contract, proposal_id, proposal_hash,    agentcity.execution-binding/v1
                            managed_task_id, base_sha, policy_hash})
run binding_hash       = H({contract, kind:'run', approval_request_id, workspace_task_id,
                            proposal_id, proposal_hash, execution_binding_hash})   agentcity.approval/v1
review_hash            = H(ReviewRecord)                             agentcity.review-record/v1
result_envelope_hash   = H(ResultEnvelope{… proposal_hash, execution_binding_hash, run_decision_id,
                            review.review_hash, artifacts+statuses, verification, …})  agentcity.result/v1
result binding_hash    = H({contract, kind:'result', approval_request_id, workspace_task_id,
                            managed_task_id, run_id, result_envelope_hash})  agentcity.approval/v1
payload_hash           = H(DecisionPayload)  (binding_hash inside; challenge + key excluded)  agentcity.decision/v1
challenge_hash         = H(ChallengeBinding{token, request id, kind, binding_hash, request_rev,
                            operator_id, session_generation, boot_id, expires_at})  agentcity.challenge/v1
```

- `ProposalSnapshot` (all hashed): contract, proposal_id, workspace_task_id, version, predecessor_
  proposal_id, repo_id, base_ref, base_sha, seed_sha, title, objective, criteria, scope, execution_mode,
  simulation_scenario, provider_profiles, verification_plan, context_policy, budgets, repair_policy.
  **created_at / created_by are row metadata outside the hash** (they don't change what is
  authorized; proposal_id already makes each snapshot unique).
- `policy_hash` is opaque: the hub's `policyHash(frozenConfig, repo_id)`.
- `ResultEnvelope`: workspace_task_id, proposal_id/hash, execution_binding_hash, run_decision_id
  (Gate-1 decision), managed_task_id, run_id, attempt_no (1|2), max_repairs, base/parent/candidate sha,
  candidate_tree, manifest_hash, execution_mode, policy_hash, required_checks, artifacts (sorted by
  name: name, kind, status, artifact_id, sha256, byte_len, truncated), verification (manifest order;
  **no argv** — host paths, bound via manifest_hash), review {review_id, review_hash, verdict, valid,
  candidate_sha, manifest_hash, findings, blocking_findings}, provenance {implementer, reviewer:
  provider, mode, model_requested, model_resolved}, evidence_status. No `eligible` field.
- `ReviewRecord` excludes `usage` (provider-shaped, may hold floats), `session_ref`, `created_at`;
  the raw review output bytes are bound as the `review_output` artifact.
- Per-item evidence status is **inside** the envelope hash: Gate-2 revalidation re-seals from fresh
  verified reads and compares envelope hashes — one comparison catches byte, row, review or status drift.

## 6. State matrix

Stored `workspace_tasks.stage`, every write CAS on `rev` (bumped on every write). Engine detail
(executing/verifying/reviewing/repairing, quarantine, cancel pending) is **derived** from the managed
task (`EngineView`, `deriveWorkspacePhase`), never copied. Observed telemetry is never read.
Actors: **op** = authenticated operator; **eng** = bridge observing its managed task; **rec** = boot /
restart reconciliation and invalidation sweeps (may also apply any eng row). Table = `WORKSPACE_TRANSITIONS`.

| From → To | Trigger / actor | Precondition | Atomic effects (one transaction) |
| --- | --- | --- | --- |
| draft, changes_requested, execution_ended, cancelled → awaiting_run_approval | publish_proposal / op | stored draft at expected_rev parses as ProposalDraft; repo allowlisted; base resolvable | insert proposal v(N+1) (predecessor = current); reserve managed task `draft` (05 `reserve`); insert run request `pending` (execution + run binding); task.current_proposal_id / current_managed_task_id; rev+1 |
| awaiting_run_approval → awaiting_run_approval | publish_proposal / op | as above | old pending run request → invalidated(proposal_superseded) (challenge dies with it); old reserved task draft→cancelled; then as above |
| draft, execution_ended, cancelled → awaiting_run_approval | request_rerun / op | body.proposal_id = current_proposal_id; no open quarantine | new managed task + new run request for the SAME proposal |
| awaiting_run_approval → queued | gate1_approve / op | §7; request pending, rev & binding match; execution binding recomputes with current policy | decision+receipt; request → approved; managed task draft→queued (05 `enqueueApproved`) |
| awaiting_run_approval → changes_requested / rejected | gate1_request_changes / gate1_reject / op | §7 (reason, challenge) | decision+receipt; request → changes_requested / rejected; reserved task draft→cancelled |
| awaiting_run_approval → draft | run_request_invalidated / rec | policy_hash / repo / base changed | request → invalidated(policy_changed / repo_unavailable); reserved task → cancelled |
| awaiting_run_approval → cancelled | cancel / op | — | request → invalidated(withdrawn); reserved task → cancelled |
| queued → running | engine_started / eng | managed task active | rev+1 |
| queued → cancelled · queued → cancel_requested | cancel / op | managed not leased → cancelled now; leased → requested | store.requestCancel; task.cancel_requested_at |
| queued, running → execution_ended | engine_ended / eng | managed blocked / failed / interrupted | rev+1 (execution over; rerun = new managed task + Gate 1) |
| queued, running → cancelled | engine_cancelled / eng | managed cancelled (e.g. legacy cancel) | rev+1 |
| queued, running → awaiting_acceptance | result_ready / eng | managed human_ready; 06 sealed an **eligible** envelope | insert result request `pending` |
| queued, running → execution_ended | result_unavailable / eng | human_ready but envelope ineligible / unsealable | insert result request already `invalidated(evidence_unavailable)` (OQ-7) |
| running → cancel_requested | cancel / op | — | store.requestCancel (intent only) |
| cancel_requested → cancelled | engine_cancelled / eng | managed `cancelled` (termination confirmed) | rev+1 |
| cancel_requested → cancelled | cancel_won / eng | managed reached human_ready after the intent | result (if sealed) → invalidated(task_cancelled); nothing offered at Gate 2 (OQ-8) |
| cancel_requested → execution_ended | engine_ended / eng | managed failed / blocked first | rev+1 |
| awaiting_acceptance → accepted | gate2_accept / op | §7 + revalidation: re-sealed hash = bound hash, eligible; managed still human_ready, result_run_id = run_id, no cancel, no open quarantine | decision+receipt; request → accepted; task.accepted_decision_id; **engine stays human_ready; nothing merged** |
| awaiting_acceptance → changes_requested / rejected | gate2_request_changes / gate2_reject / op | §7 | decision+receipt; request closed; (changes: operator edits draft → new version → new Gate 1) |
| awaiting_acceptance → execution_ended | result_invalidated / rec | revalidation / sweep found integrity_failed / candidate_mutated | request → invalidated(reason) |

Terminal: **accepted**, **rejected** (no outgoing rows; draft not editable). Draft saves are allowed in
every non-terminal stage and never touch authority. `cancel_requested` is never shown as cancelled
before the engine confirms; interrupted + open quarantine stays `cancel_requested`; interrupted with no
quarantine → bridge re-issues `requestCancel`. `awaiting_run_approval` with the reserved task not in
`draft`/`cancelled` = **violation** (a bypass) → 05 must alarm and fail closed.
Approval requests: only `pending` moves, once; run → approved/changes_requested/rejected/invalidated;
result → accepted/changes_requested/rejected/invalidated. Finals never move; with UNIQUE(run request per
managed task), UNIQUE(result request per run) and UNIQUE(decision per request), a rejected, superseded or
invalidated subject can never regain authority. Restart: new boot_id voids every challenge without a
write; pending requests stay pending (need a new challenge); queued work proceeds under its durable
decision (engine re-checks); human_ready without a result request is sealed by the reconciler.

## 7. Authentication, challenges, decisions

- Principal `{operator_id:'operator:edward', scopes:['workspace:read','workspace:decide'],
  session_generation, boot_id}`; `read` = GETs, `decide` = every mutation. Sessions in memory
  (HttpOnly, SameSite=Strict; details owned by 03). CSRF header `x-agentcity-csrf` (value from
  `SessionView.csrf_token`). Exact Origin on every mutation.
- Confirmation: exactly `Edward` (case-sensitive, **no trimming, no normalization**). approve/accept need
  it (wrong → 422 confirmation_mismatch, nothing consumed) and send `reason: null`;
  request_changes/reject need a non-empty reason ≤ 1000 and `confirmation_text: null` (**null, not
  `""`** — a cleared field must be sent as null). **All four need a challenge** (stale tabs cannot act).
- Challenge: `POST …/challenge {kind, binding_hash, expected_request_rev}` → 32 CSPRNG bytes base64url
  (43 chars), returned once, TTL 300 s. Stored: challenge_hash = H(ChallengeBinding) + fields; issuing
  supersedes the previous one and **bumps the request rev** (repo convention) — the decision sends
  `expected_request_rev = request_rev` from the challenge response. Verification (`challengeValid`)
  recomputes the hash from the presented token + current row/session/boot, constant-time compare,
  status `issued`, now < expires_at. Every failure = **409 challenge_invalid** (never says which).
- Decision body `DecisionRequest {idempotency_key, kind, action, expected_request_rev, binding_hash,
  confirmation_text, reason, challenge}` (strict). Payload = `decisionPayloadFrom(body, request_id)`:
  everything except challenge and key; reason stored = `\r\n`→`\n`, trimmed, redacted (OQ-3).
- **Normative order** (frozen, OQ-1): body limit → session auth → exact Origin → CSRF → scope → JSON +
  live precedence + strict parse → receipt lookup (operator_id, idempotency_key) → found:
  same payload_hash → stored `{receipt, replayed:true}` with the stored status, no effects; different →
  409 idempotency_conflict → not found: confirmation check → (Gate 2: `revalidate` outside any tx) →
  ONE `BEGIN IMMEDIATE`: load request + subject; status pending, stage = DECISION_STAGE[kind], rev and
  binding_hash equal, kind equal (else 409 stale_binding / invalid_state); verify + consume challenge;
  insert decision + receipt; apply effects (§6); bump revs → 201 `{receipt, replayed:false}`.
  A same-key retry after a lost response works even though the challenge is consumed.
- Receipt `DecisionReceiptBody` (stored verbatim in `response_body`, never hashed): decision id, request,
  task, kind, action, operator, decided_at, payload_hash, binding_hash, request {status, rev}, task
  {stage, rev}, effects {managed_task_id, managed_task_state, result_envelope_hash}.

## 8. Evidence status and eligibility

`EvidenceStatus` = verified | truncated | withheld | missing | corrupt | stale | unknown (definitions in
`result.ts`). `ARTIFACT_POLICY`: manifest, diff, review_output → only `verified`; verification_log
(one per manifest check, `verify-N-name.log`) → verified or truncated; optional diagnostics
(implementation_log, review_log, changed_files) → verified / truncated / withheld. An expected required
name absent from the list counts as `missing`. Overall = worst unacceptable (corrupt > stale > missing >
unknown > withheld > truncated) else verified. `resultEligibility(env)` re-derives evidence status and
requires: verified evidence; every required check present once and passed (completed, not timed out,
exit 0); review approve + valid + same candidate & manifest + 0 blocking findings; attempt ≤ 1 +
max_repairs; fake/simulated provenance. Unknown / missing / corrupt / stale never become success.

## 9. Errors (`WORKSPACE_ERROR_STATUS`, body `{error, message, issues?}`)

400 invalid_request · 401 unauthenticated · 403 forbidden_origin, csrf_invalid, forbidden_scope ·
404 not_found · 409 challenge_invalid, stale_binding, invalid_state, idempotency_conflict,
evidence_unavailable, integrity_failed · 413 payload_too_large · 415 unsupported_media_type ·
422 confirmation_mismatch, live_disabled, repo_not_allowed · 503 disabled.
Not claimed: network isolation, OS containment, protection against a privileged attacker controlling
hub memory, DB or artifact storage (outside the local fixture threat model).

## 10. Ports (`ports.ts`, types only)

- 02 `WorkspaceStore` / `WorkspaceTx`: reads, `transaction(fn)` (sync, BEGIN IMMEDIATE; managed-store
  calls by 05 inside join it), CAS `updateTask` / `updateApprovalRequest` (null = CAS miss),
  `insertProposal`, `insertApprovalRequest`, `insertDecision` (throws on unique conflicts), `findReceipt`.
- 03 `VerifiedAuthContext` {principal, origin_verified, csrf_verified} (minted only by auth);
  `ChallengePort.issue(tx, request, auth, now)` / `verifyAndConsume(…) → {ok} | {ok:false, code:'challenge_invalid'}`.
- 04 `DecisionService.issueChallenge(...)`, `decide(...) : Promise<CommandOutcome<DecisionResponse>>`.
- 05 `ExecutionBridge.reserve` (managed `draft`, idempotency_key = approval_request_id, request_hash =
  execution_binding_hash, fields from `managedTaskFieldsFor`), `enqueueApproved` (exactly requestRun's
  writes: state queued, approval_hash = approvalHashFor(task, config), run_requested_at, cancel/lease
  cleared, infra_retries 0, fence_token+1), `releaseReserved`, `requestCancel`, `engineView`,
  `currentPolicyHash`.
- 06 `EvidenceSealer.seal(SealInput) : Promise<SealedResult>` / `revalidate(request)`; `SealedResult`
  = {envelope, envelope_hash, canonical, eligibility, problems}. No DB writes; no I/O inside a tx.

## 11. Rulings (lead, frozen v1)

| # | Ruling |
| --- | --- |
| OQ-1 | **Auth first.** Order: body limit → session auth → exact Origin → CSRF → scope → JSON + live precedence + strict parse → receipt lookup → … (§7 updated). Unauthenticated callers always get 401 and never see schema detail. |
| OQ-2 | Keep `agentcity.review-record/v1` and `agentcity.challenge/v1` as internal hash-domain ids (never on the wire). |
| OQ-3 | Accepted: payload hash over the stored (normalized, trimmed, redacted) reason. |
| OQ-4 | Accepted: protected ∩ allowed is rejected in v1 (the engine enforces only `approved_scope`). |
| OQ-5 | Accepted: criteria are plain `string[]`, one per line; stable criterion ids / criterion→check mapping deferred to v2 (listed as a limitation). |
| OQ-6 | Accepted: save/publish/rerun/cancel are CAS-on-rev (at most once; lost response → re-read); create-task and decisions are key-idempotent. |
| OQ-7 | Accepted: an ineligible sealed result is inserted as `invalidated(evidence_unavailable)` so its statuses stay visible. |
| OQ-8 | Accepted: cancel wins over a result that reached `human_ready` after the cancel intent. Cancel at `awaiting_acceptance` (intent recorded after human_ready) → `409 invalid_state` (no running work; use Reject). |
| OQ-9 | Accepted: `accepted` and `rejected` are terminal for the workspace task (new work = new task); `cancelled`/`execution_ended` allow publish/rerun. UI copy must say the task is closed. |
| OQ-10 | Deferred: post-acceptance integrity is a derived read-model flag later; disclosed as a known limitation in M1. |
| OQ-11 | Accepted: `live_disabled` = 422 on workspace routes (legacy API answers 410 in workspace mode anyway). |
| OQ-12 | One mutation scope `workspace:decide`; tests may configure a second read-only principal (`workspace:read` only). No `workspace:write`. |
| OQ-13 | Accepted: lost-response recovery = resend the byte-identical decision body with the same key (works after challenge consumption). A read of the approval request/task also shows the durable decision. |
| OQ-14 | Accepted: reserved managed task `request_hash = execution_binding_hash`, `idempotency_key = approval_request_id`. |

Extensions accepted: challenge issuance bumps request rev (decision sends the `request_rev` returned with
the challenge); all four actions need a challenge; confirmation exact `Edward` with no trimming/normalization;
per-item evidence status inside the envelope hash; envelope excludes verification argv and review usage;
created_at/created_by outside the proposal hash; publish fails (never truncates) when redaction lengthens
text; strict uuid v4 for `ws*-` ids, loose existing form for engine ids.

## 11a. Delta v1.1 (lead, additive, 2026-10-02)

`api.ts` (`agentcity.workspace-api/v1.1`): the `/api/workspace` route table (`WORKSPACE_ROUTES`) and the
response wrappers `SignInRequest`, `Provenance`, `WorkspaceRepo`, `WorkspaceSnapshot`, `RunSummary`,
`ArtifactListItem`, `WorkspaceTaskDetail`, `ArtifactTextResponse`. Nothing hashed; v1 vectors unchanged.
Consumers: hub routes (lead), web transport (07), QA (08/09). Compatibility: additive only.

## 12. Proposed lead-owned patches (not applied)

1. `packages/schema/src/index.ts`: **no re-export** of workspace-m1 (keep the explicit subpaths; there
   are no runtime name clashes today, but the root barrel would pull workspace types into every
   consumer). Nothing to change.
2. Legacy Run bypass — `apps/hub/src/managed/store.ts requestRun` (or `service.ts runTask` +
   `routes/managed.ts POST /tasks/:id/run`): refuse when the task is workspace-linked, e.g. inside the
   tx: `SELECT 1 FROM managed_approval_requests WHERE managed_task_id = ? LIMIT 1` → return
   `{queued:false}` / 409 `invalid_state`. This also blocks legacy `blocked/interrupted → queued` reruns
   of workspace tasks (rerun = new managed task + Gate 1). Preferred for M1: disable legacy Run entirely.
3. `orchestrator.ts approvalHolds`: for workspace-linked tasks additionally require the run request
   `status = 'approved'`, a decision row with action `approve` for it, and
   `sealExecutionBinding({...stored, policy_hash: policyHash(frozenConfig, repo)}).hash ===
   execution_binding_hash`; else fail `approval_void`.
4. Legacy cancel route may stay (cancel never grants authority); the bridge observes `engine_cancelled`.
5. Public `/ws`: stop broadcasting managed task ids (shared spec); workspace data via authenticated REST.
6. `CLAUDE.md`/`AGENTS.md` conventions (identical): "Workspace stages/approval statuses come only from
   `packages/schema/src/workspace-m1/state.ts`; workspace contracts are `agentcity.{workspace-task,
   proposal, execution-binding, approval, decision, result}/v1` in `packages/schema/src/workspace-m1/`."

## 13. Delta v1.2 — criterion ids and coverage (schema only; CONTRACT_V1_2.md §A)

Additive and versioned (criteria/UI worker, corrective phase). Frozen v1 structures, `fixtures/vectors.json`
and `fixtures/sample.ts` are byte-identical (sha256 `587f0269…6dcbd` / `4a694f90…53c09`, as recorded in
`docs/workspace-m1/CONTRACT_FREEZE.md`). **Not yet wired** into publish / sealing / the decision path: the
hub still produces v1 proposals and v1 envelopes; the lead integrates (list at the end).

| Where | New |
| --- | --- |
| `proposal.ts` (web-safe) | `PROPOSAL_CONTRACT_V1_2`, `RESULT_CONTRACT_V1_2`; `CriterionId` (form only); `DraftCriterionChecks`, `DraftCriterionChecksList`, `draftCriterionChecks`, `redactDraft`; `criterionCoverageProblems` (publish rules); `ProposalCriterion`, `CoveragePlanEntry`, `coveragePlanProblems`, `ProposalSnapshotV1_2`, `AnyProposalSnapshot` (v1 \| v1.2 by `contract`), `ProposalContractVersion`, `isProposalV1_2`, `proposalCriteriaTexts`, `freezeCriterion`, `composeProposalSnapshotV1_2(input, idOf)`; `managedTaskFieldsFor` accepts both |
| `result.ts` (web-safe) | `CheckOutcome`, `CriterionStatus`, `CoverageCheck`, `CriterionCoverage`, `coverageCheckFor`, `criterionStatusOf`, `deriveCriterionCoverage`, `sameCoverage`, `ResultEnvelopeV1_2`, `AnyResultEnvelope`, `isResultV1_2`, `resultEligibilityV1_2(envelope, proposal)`; `IneligibleReason` += `criteria_unmapped`, `coverage_missing`, `coverage_mismatch`, `criterion_unsatisfied`, `criterion_unresolved` |
| `hash.ts` (Bun-only) | `criterionId(text)` = `crit-` + first 16 hex of sha256(UTF-8 text); `criterionIdsMatch`; `buildProposalSnapshotV1_2(input)`; `sealProposal` / `sealResultEnvelope` overloads (v1.2 first, v1 last so `ReturnType<…>` stays the v1 form for existing callers); `sealAnyProposal`, `sealAnyResultEnvelope` for union-typed values. A v1.2 proposal whose ids do not match their texts is refused at sealing. |
| `fixtures/` | `sample-v1.2.ts`, `vectors-v1.2.json` (3 criterion ids + `proposal_snapshot_v1_2`, `criterion_coverage_v1_2`, `result_envelope_v1_2`) |

**Draft.** `criterion_checks?: Array<{criterion, checks}>` keyed by exact criterion text. `.optional()` (absent ≡
`[]`, read through `draftCriterionChecks`), deliberately not `.default([])`: parsing never adds the key, so legacy
drafts, their create `request_hash` and the frozen `sample.ts` typing are unchanged. Save rejects: a duplicate key,
more than 20 entries, more than 10 checks or a repeated check in one entry, a non-`CheckId`, an over-long / control-character key,
unknown entry keys. Save accepts an incomplete mapping (missing / dangling entries, empty checks).
`WorkspaceDraft` stays a plain `ZodObject` (the rules sit on the array schema).

**Publish (fail closed, `criterionCoverageProblems` → `composeProposalSnapshotV1_2`).** Over the stored draft:
each criterion has exactly one entry matched by **exact** text, with ≥ 1 check; no dangling entry; every check ∈ the
trusted `required_checks`; no duplicate criterion text. Then each criterion is frozen with `freezeCriterion`
(trim → redact → trim, the v1 rule), its id is derived from the frozen text, its checks sorted (UTF-16) + de-duplicated,
the plan ordered by criteria, and the snapshot validated: two draft texts that freeze to the same text collide →
`duplicate criterion id` → rejected. Unchanged text keeps its id across versions; edited text gets a new id.

**ProposalSnapshot v1.2.** v1 fields with `criteria: [{id, text}]` and `coverage_plan: [{criterion_id, checks}]`.
Validated (web-safe, `coveragePlanProblems`): ids unique, texts unique, exactly one plan entry per criterion in
criteria order (bijection, no dangling id), checks sorted + unique and ⊆ `verification_plan.required_checks`.
The id ↔ text binding needs sha256 and is enforced by `sealProposal` / `sealAnyProposal` (Bun-only).
`managedTaskFieldsFor(v1.2).acceptance_criteria` = `criteria.map(c => c.text)`, byte-identical to the v1 strings of
the same draft (tested against the frozen v1 vector).

**Coverage derivation (`deriveCriterionCoverage(plan, envelope)`, pure).** Per mapped check, from the manifest
verification results: `passed` ⇔ completed ∧ ¬timed_out ∧ exit 0; `failed` ⇔ completed ∧ exit ≠ 0 (also when
timed out); `incomplete` otherwise — a **null exit code is not "≠ 0"** (→ incomplete) and **several results with the
same name are ambiguous** (→ incomplete, no log identity); `missing` ⇔ no result of that name. Log evidence = the item
`verify-N-<check>.log` with N = 1 + the result's index in `verification` (not its position in `required_checks`),
present with status `verified` or `truncated`; identity (`log_artifact_id`, `log_sha256`) is that item's
`artifact_id` / `sha256`, else both null. (Implemented exactly as written: no extra comparison with the manifest's
`log_sha256` — the sealer already marks a mismatching manifest-referenced item `corrupt`.) Criterion `satisfied` ⇔
every mapped check passed with log evidence; `unsatisfied` ⇔ any mapped check failed (wins over missing/incomplete);
`unresolved` otherwise.

**ResultEnvelope v1.2.** v1 fields + `criterion_coverage` (inside the envelope hash). The schema re-derives every
entry from the envelope's own verification results + artifacts and rejects a mismatch (like `evidence_status`), plus
duplicate criterion ids and checks outside `required_checks`. The binding to the proposal (ids in order, plan) is
checked by `resultEligibilityV1_2`.

**Eligibility (how it was handled).** Hub flows depend on v1 envelopes being eligible (`decisions/test-support.ts`
throws on an ineligible fixture result; `evidence/sealer.ts` `revalidate` requires `eligible`; the bridge opens Gate 2
only for eligible results) and the hub cannot produce v1.2 yet. So `resultEligibility(envelope)` keeps the v1
behaviour **unchanged for v1 envelopes** (its parameter widens to `AnyResultEnvelope`; a v1.2 envelope additionally
needs every criterion `satisfied`). The full v1.2 rule is the separate `resultEligibilityV1_2(envelope, proposal)`:
v1 proposal → `criteria_unmapped` (a new proposal + Gate 1 is required); v1.2 proposal + v1 envelope →
`coverage_missing`; coverage ids ≠ proposal ids (order included), coverage ≠ derivation from the proposal's plan, or
another `proposal_id` → `coverage_mismatch`; any criterion unsatisfied / unresolved → `criterion_unsatisfied` /
`criterion_unresolved`. `proposal` must be the snapshot the envelope's `proposal_hash` names.

**Vectors.** New file `fixtures/vectors-v1.2.json` (the frozen `vectors.json` is not appended to, so its recorded hash
stays true). Built by `sampleGraphV1_2()` from the frozen v1 `sampleDraft()` + a mapping (entries out of order, one
unsorted list) and `required_checks ["unit","lint"]` (the lint log is a truncated capture: still evidence).
Cross-checked with an independent sha256: proposal `9cdc314c…d82b`, coverage `159dbb1d…3116`, envelope
`3360d562…0d5d`. Regeneration (only with a lead-approved delta): for each structure of `sampleGraphV1_2()` write
`{name, input, canonical: canonicalEncode(input), sha256: sha256Hex(canonical)}` plus `criterion_ids`
(`{text, sha256: sha256Hex(text), id: criterionId(text)}`), then `bunx biome check --write`; guard:
`vectors-v1_2.test.ts`.

**Lead integration (not done here; exclusive files of others).**
1. **Blocking with this delta:** `apps/hub/src/workspace-m1/decisions/commands.ts` `storedDraft` spreads `...d`, so
   once `WorkspaceDraft` accepts `criterion_checks` its keys would be stored **unredacted** (before this delta the key
   was rejected as unknown). Patch: `const parsed = WorkspaceDraft.safeParse(redactDraft(d));` (same re-validation,
   never truncates). `redactDraft` redacts title / objective / criteria / every key identically, so keys still match.
2. `rows.ts`: `ManagedProposalRow.contract_version` → `ProposalContractVersion`, `snapshot` → `AnyProposalSnapshot`
   (+ check `contract_version === snapshot.contract`); `result_envelope` → `AnyResultEnvelope`. `ports.ts`:
   `SealInput.proposal` / reserve `proposal` / `SealedResult.envelope` → the unions.
3. Publish: `buildProposalSnapshotV1_2` (contract_version v1.2) instead of `buildProposalSnapshot`; sealer: build
   `ResultEnvelopeV1_2` with `criterion_coverage = deriveCriterionCoverage(proposal.coverage_plan, envelope)` and gate
   on `resultEligibilityV1_2(envelope, proposal)`; a legacy v1 proposal then yields an ineligible result
   (`criteria_unmapped`).
4. UI: a mapping editor (draft form already carries `criterion_checks` through Save unchanged) and coverage display.
