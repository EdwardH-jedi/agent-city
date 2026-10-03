# Contract delta v1.2 (lead) — durable accepted evidence, current acceptance validity, criterion coverage

Corrective response to the independent Codex review (findings 1–4). Additive and versioned: frozen v1
structures and `fixtures/vectors.json` stay valid; legacy rows stay readable and are represented honestly.
Migration: `009_accepted_evidence_validity.sql` (never edit 008).

## A. Criterion identity and coverage (finding 4, OQ-5)

**Draft (`WorkspaceDraft`, additive):** optional `criterion_checks: Array<{ criterion: string; checks: string[] }>`
(default `[]`), keyed by the exact criterion text. Stored after the same `redact()` as the criteria (keys
redacted identically). Save may be incomplete; duplicates of a key, bounds and per-entry duplicate checks
are rejected at save.

**Publish (fail closed):** every criterion has exactly one `criterion_checks` entry with ≥ 1 check; no
dangling entry (key not among the criteria); every check ∈ the repo's trusted `required_checks` (config);
no duplicate criterion text. Otherwise 400 `invalid_request` with issues. Coverage is never inferred.

**Criterion id (deterministic, stateless):** `crit-` + first 16 hex chars of sha256(UTF-8 of the stored,
redacted, trimmed criterion text). Unchanged text ⇒ same id across revisions (preservation); edited text ⇒
new id (replacement); identical texts ⇒ duplicate id ⇒ rejected.

**`ProposalSnapshot` v1.2** — `contract: "agentcity.proposal/v1.2"`; identical to v1 except
`criteria: Array<{ id, text }>` (order preserved) and new `coverage_plan: Array<{ criterion_id; checks:
string[] }>` (one entry per criterion, criteria order, checks sorted + unique, ⊆
`verification_plan.required_checks`). Validated: ids unique, plan ↔ criteria bijection, no dangling ids.
Row parser = union v1 | v1.2 by `contract`. New proposals are always v1.2. `managedTaskFieldsFor(v1.2)`
yields `acceptance_criteria = criteria.map(c => c.text)` byte-identically (approval hash unchanged in kind).
Hash = `sealProposal` over the parsed snapshot (mapping + ids are inside the proposal hash). New v1.2
vectors; v1 vectors untouched.

**`ResultEnvelope` v1.2** — `contract: "agentcity.result/v1.2"`; v1 fields plus `criterion_coverage:
Array<{ criterion_id; status: "satisfied"|"unsatisfied"|"unresolved"; checks: Array<{ check; outcome:
"passed"|"failed"|"incomplete"|"missing"; log_artifact_id: string|null; log_sha256: string|null }> }>`
in proposal criteria order, derived by a pure function from the proposal's `coverage_plan`, the manifest
verification results and the envelope artifact items (`verify-N-<check>.log`):
- `passed` ⇔ completed ∧ ¬timed_out ∧ exit 0; `failed` ⇔ completed ∧ exit ≠ 0; `incomplete` otherwise;
  `missing` ⇔ no verification result of that name.
- A check supports its criterion only if `passed` **and** its log item is present with status verified or
  truncated (identity = artifact id + sha256 from the envelope).
- Criterion `satisfied` ⇔ every mapped check passed with log evidence; `unsatisfied` ⇔ any mapped check
  failed; `unresolved` otherwise.
Coverage is inside the envelope hash (no circularity: it refers to proposal ids and artifact identities
that precede the envelope). `resultEligibility` additionally requires: proposal v1.2, coverage present,
coverage criterion ids = proposal criterion ids exactly, every criterion `satisfied`. A legacy v1 proposal
yields an ineligible result (reason `criteria_unmapped`): a new proposal + Gate 1 is required. Its execution
grant is obsolete too (follow-up): a pending v1 Gate 1 is invalidated (`evidence_unavailable`, "obsolete v1
proposal without criterion coverage; publish a new version and request a fresh execution approval") by a
challenge/decision attempt (409 `stale_binding`, no decision) or the bridge sweep, and an approved v1 execution
is denied before every stage.

## B. Durable accepted evidence (finding 1, OBS-04)

**Bundle** `agentcity.evidence-bundle/v1`: one file = header line (canonical JSON `{contract,
result_envelope_hash, managed_task_id, run_id, items: [{name, artifact_id, sha256, byte_len, offset}]}`) +
`\n` + the item bytes concatenated in header order. Items = every envelope artifact with status verified or
truncated — the **exact buffers read during sealing**. Identity: `digest = sha256(whole file)`.

**Location / ownership:** `<artifacts_root>/_sealed/<digest>.bundle` (dir 0700, file 0600), hub-owned,
outside model worktrees. Only the bridge reconciler publishes, at Gate-2 opening, from the sealer's
buffers, **before** the result request row is inserted. Never republished from re-read bytes later.

**Atomic publication:** temp `O_CREAT|O_EXCL|O_NOFOLLOW` in `_sealed`, write, fsync, rename to
`<digest>.bundle`, fsync dir. Existing target ⇒ verify byte-equal (content address) else fail. Publication
failure ⇒ no pending request: transient retry (existing bounded counter), then `invalidated
(evidence_unavailable)` with detail "durable evidence seal failed" — no acceptance is possible.

**Verification (`verifyBundle`)**: same discipline as `readArtifactBytes` (no-follow, non-blocking,
fstat regular file, bounded size and time, single read); sha256(file) = digest; header parses; header
envelope hash = the request's `result_envelope_hash`; items equal the envelope's verified/truncated
artifacts exactly (id, name, sha256, byte_len); every slice hashes to its item sha256. Failure codes:
`bundle_missing | bundle_not_regular | bundle_oversized | bundle_hash_mismatch | bundle_header_invalid |
bundle_binding_mismatch | bundle_unreadable`.

**DB (009):** table `managed_evidence_bundles` (digest PK, result_envelope_hash, managed_task_id, run_id,
rel_path, byte_len, item_count, created_at; append-only). New nullable columns
`managed_approval_requests.evidence_bundle_digest` (set at insert for v1.2 result requests; immutable via a
new trigger) and `managed_decisions.evidence_bundle_digest` (set for Gate-2 accept).

**Gate 2 accept:** outside the transaction: existing fresh re-seal (detects pre-accept tampering) **and**
`verifyBundle` (never republish). Inside the transaction: request digest non-null and equal to the verified
digest; decision row + receipt (`effects.evidence_bundle_digest`, optional/nullable in the receipt schema)
carry the digest; validity row inserted `valid`. Bundle failure ⇒ `409 integrity_failed`, request
invalidated naming the component; request without a digest (legacy) ⇒ `409 evidence_unavailable`, request
invalidated ("legacy result without durable evidence; a new proposal and approval are required").

**Serving:** an artifact that belongs to a result request with a bundle is served **only** from the
verified bundle (status = the envelope item status); a later change to the mutable artifact never
substitutes content. Bundle verification failure ⇒ status corrupt/unknown, `text: null`.

## C. Current acceptance validity (finding 2, J-22/OQ-10)

The historical decision (append-only row + receipt) never changes. Current validity is separate:
table `managed_acceptance_validity` (decision_id PK → managed_decisions, result_request_id UNIQUE,
workspace_task_id, evidence_bundle_digest, status `valid|invalid|unknown|unverifiable`, reason, detail,
checked_at, first_invalid_at, rev). Triggers: no delete; rev +1; `invalid` and `unverifiable` are sticky.
009 backfills one `unverifiable` row (reason `legacy_no_durable_evidence`) per pre-existing accept decision
— no invented proof.

**Policy ("both"):** any of the following makes the current acceptance `invalid` (sticky) **and** raises a
visible alert, while the accepted original bytes stay served from the bundle, labelled as history:
bundle missing/corrupt/binding mismatch; source artifact (mutable store) changed or missing vs the bundle
(`source_evidence_changed` / `source_evidence_missing`); candidate commit missing or its tree ≠ envelope
`candidate_tree` (`candidate_unavailable` / `candidate_mismatch`). Verification that cannot run (repo
unavailable, timeout) ⇒ `unknown` (`verification_unavailable`, not sticky, never shown as verified).
Worktree drift after acceptance is **not** part of the accepted contract (the deliverable is the commit).

**Detection timing (periodic; no filesystem monitoring; no guaranteed deadline):** current validity changes
only when a check runs — nothing watches the files. Triggers:
- *Bridge sweep* — at hub startup, then every 30 s (default interval), run as one job on the bridge's single
  serial reconcile queue, after that sweep's execution reconciles, the pending Gate-1 pass and the legacy
  Gate-2 pass. Each sweep re-checks **at most 20** accepted results whose stored status is `valid` or
  `unknown`, oldest `checked_at` first (sticky `invalid` / `unverifiable` rows are never re-selected; a detail
  read that re-stamps `checked_at` moves a result to the back). With N eligible results a given result is
  reached about once every **ceil(N/20) sweeps** — with 21, the first sweep checks the 20 oldest and the 21st
  waits for the next one — plus the time the queue spends on earlier jobs and on the checks themselves (bundle
  read, each source artifact, candidate commit/tree via git); a sweep that outlasts the interval delays the next.
- *Task-detail read* (`GET /tasks/:id` of an accepted task) — re-checks when the stored check is older than 5 s
  (per hub process at most one check per result per 5 s and one in flight) and the route **awaits** that full
  check, so its response reflects it; within 5 s of the last check it returns the stored row. This is a read
  window, not a detection deadline for results nobody opens.
- *Snapshot / list reads* (`GET /snapshot`, HQ lists) **never** start a check: they show the stored row and its
  `checked_at`.
The workspace UI polls every 2 s, so a recorded change appears on a later poll. A list-only viewer may
therefore learn of a change only after up to roughly ceil(N/20) × 30 s plus queue and check time plus one poll —
not "by the next sweep", and not within any universal 5 s / 30 s bound. Times measured in tests or reviews (e.g. ~0.2 s for a
20-check sweep on the disposable fixture) are observations of one machine and data set, not bounds.
`checked_at` is in the view so a client can show how fresh the current validity is; how it presents a stale
check or a stale connection is UI policy and never rewrites the server's validity.

**Read model / API v1.2 (additive):** `acceptance_validity: { decision_id, status, reason, detail,
checked_at, first_invalid_at, evidence_bundle_digest } | null` on the task view (detail) and on snapshot
list items. Reasons: `bundle_missing, bundle_corrupt, bundle_binding_mismatch, source_evidence_changed,
source_evidence_missing, candidate_unavailable, candidate_mismatch, verification_unavailable,
legacy_no_durable_evidence`.

**UI:** task detail and Headquarters/history show the validity next to the historical acceptance:
valid → "current evidence verified (checked …)"; invalid → `role=alert` "Accepted on …, but this result is
no longer valid: <reason>"; unknown → "verification unavailable"; unverifiable → "legacy acceptance — no
durable evidence". Testid `acceptance-validity` with `data-status`. `acceptance-status` keeps the
historical value (`accepted`). The UI only renders server state (sticky invalid ⇒ polling/reload cannot
restore a verified badge).

**J-22 under this contract:** after corrupting a required source artifact of an accepted result and
reloading: `acceptance-status=accepted` (history), `acceptance-validity[data-status=invalid]`, a visible
alert, and the accepted original still viewable as history from the bundle.

## D. Authority at commit (finding 3) — implemented by the lead

Clock read inside the decision/challenge transaction (after the write lock); that single read drives session
liveness, challenge expiry, `decided_at` and the queue stamp. Successful receipts replay before any commit
check (under current valid authentication). Regressions: `decisions/commit-authority.test.ts`.

## Documentation correction

Challenge hash, status, binding, operator, session generation, boot id, request revision and expiry are
stored in SQLite on the approval-request row; raw challenge tokens and sessions are ephemeral (memory) and
boot-bound. A restart voids old challenges through the new boot/session, not by deleting rows.
