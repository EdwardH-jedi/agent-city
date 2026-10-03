# Corrective record — independent Codex review findings (lead)

Review: `/private/tmp/agent-city-m1-review-jkmfy1nt/REVIEW_REPORT.txt` (verdict: not ready; three P1, one
P2, one documentation inconsistency). Contract delta for the fixes: `CONTRACT_V1_2.md`.

## Starting identity (2026-10-02T08:33:54Z, before any corrective edit)

| Item | Value |
| --- | --- |
| Branch / HEAD | `feat/workspace-approvals-m1` / `f960055448e4f5a0bd93a7b9ca0aeb0d2ef8597d`; staged 0 |
| Tracked diff | 23 files, +491/−59; `git diff HEAD \| shasum -a 256` = `86d185c321bb1c4c6583428f759093793982f3044b2f643d85abcc50e358614f` |
| Untracked | 170 files incl. DELIVERY.md; manifest (all) `cd35347c15ade0fcf8f24bec24e79d8dfb024a56ed78b5d062c004a137738ded`; manifest excl. DELIVERY.md `ce807a5f45c0ba28f536e127bbde2094be271161ae7627b88c7af287c84ec298` |
| DELIVERY.md | sha256 `401852a821f5b7d16edf33f714558d3e624a63b7c4f5e3e1d4c5800a81b4faf3` |
| Comparison with the reviewed state | identical (reviewer: tracked `86d185c3…`, DELIVERY `401852a8…`, 23 modified + 170 untracked) — no intervening changes, no overlap conflict |

Copies of the starting tracked diff and untracked manifest are kept outside the repo (lead scratchpad
`fix2/start-tracked.diff`, `fix2/start-untracked.sha256`).

## Reproduction against the starting code

The reviewer's probe (`independent-probes.ts`, output path changed only) was rerun unchanged against the
starting tree with the isolated runner:

| Probe | Starting code |
| --- | --- |
| commit-expired-challenge-run | 201, managed task queued, 1 decision |
| commit-expired-session-run | 201, queued, 1 decision |
| commit-expired-challenge-result | 201, accepted, 1 decision |
| commit-expired-session-result | 201, accepted, 1 decision |
| OBS-04 (swap after Gate-2 validation, before commit) | 201; after restart: accepted / envelope verified / artifact corrupt, text null, no stage detail |
| J-22 (mutation after acceptance) | 201; after restart: accepted / verified / artifact corrupt, no warning |

Finding 4 (criteria without ids/coverage) is a static contract gap (`criteria: string[]`, plan = check list).

## Fix 1 — authorization expiry at commit (lead) — DONE

Change: `decisions/decision-service.ts` reads the authoritative clock (`deps.clock`, the same clock as the
auth instance; default system clock) **inside** the `store.transaction` callback — which runs only after
BEGIN IMMEDIATE holds the write lock — and uses that single value for `verifyAndConsume` (session liveness +
revocation via the live session map, challenge expiry), `decided_at` and the Gate-1 queue stamp; challenge
issuance reads it inside its transaction too. The request-entry time passed by the router is no longer used
for authority. `createWorkspaceServices` now threads `clock` (`decisions/router.ts`, `deps.ts`); the two
service-level test helpers pass the auth clock. Receipt replay is unchanged (checked before any commit
check, under the request's valid authentication).

Tests: `decisions/commit-authority.test.ts` — 18 cases (both gates × challenge expiry, session expiry,
session revocation, in-window delay stamped with the commit-time clock, concurrent submission with expiry
between commits, rollback after consumption + in-window retry, rollback + expired retry, replay after the
challenge was consumed and expired, HTTP replay needs current authentication). Model: the
`beforeTransaction` barrier is the last point before the transaction callback (bun:sqlite blocks the thread
while waiting for the lock, so no in-process test can move a clock during the wait itself). Result: 18/18,
three consecutive runs. One existing test (`gate1.test.ts` expiry) passed a request-start Date as the
authority — it now advances the authoritative clock (same assertions).

Integrated reproduction after the fix (same reviewer probe): all four commit-expired cases → **409
`challenge_invalid`, 0 decisions, stage unchanged** (`awaiting_run_approval` / `awaiting_acceptance`).

## Fix 2 — durable accepted evidence (evidence worker) — DONE

Migration `009_accepted_evidence_validity.sql` (additive; 008 untouched — a test builds a genuine 008 DB and
re-checks its rows and triggers after 009): append-only `managed_evidence_bundles`; nullable
`evidence_bundle_digest` (FK) on `managed_approval_requests` (result requests only, must seal the same
envelope/attempt, immutable even while pending) and on `managed_decisions` (Gate-2 accept only, must equal
its request's digest); `managed_acceptance_validity` (below). New code: `evidence/bundle.ts`, sealer returns
its exact verified buffers (a structural copy of the result carries none, so nothing re-read can be bundled),
bridge publishes before the request row exists (bundle row + request in one transaction), decision service
verifies the bundle outside the transaction and binds the digest inside it, reader serves bundled results
only from the verified bundle (invalidated requests keep the R-F5 fresh-read path).

Guarantees and limits: `CONTRACT_V1_2.md` §B. File `<artifacts_root>/_sealed/<digest>.bundle` (0700 dir,
0600 file); exclusive no-follow temp → fsync → rename → dir fsync; existing target must be byte-equal;
`verifyBundle` no-follow/non-blocking/regular-file/bounded/sha256(file)=digest/canonical header/items equal
the envelope's verified+truncated items with every slice hashed. Publication failure: existing bounded retry
(3), then `invalidated(evidence_unavailable)` "durable evidence seal failed". Transient read errors (EMFILE,
ENFILE, EIO, EINTR, EAGAIN, deadline) → 409 `evidence_unavailable` / `unknown`, no write. Not claimed:
protection against a privileged attacker who rewrites the artifacts root and the SQLite file consistently.

Tests: `evidence/bundle.test.ts` (10), `bridge/durable-evidence.test.ts` (8), `persistence/evidence-validity.test.ts`
(6), `decisions/durable-acceptance.test.ts` (11) — replacement after validation before commit, restart, cache
eviction, partial write, publication failure, missing bundle, hash mismatch, symlink/FIFO substitution,
coherent file + row tampering, failed durable seal → no acceptance, no recapture.

## Fix 3 — current acceptance validity (evidence worker backend, UI worker display) — DONE

`managed_acceptance_validity` (CHECKs mirror the zod row; inserts only `valid`/`unverifiable`; `invalid` and
`unverifiable` sticky; rev +1; never deleted; backfill one `unverifiable`/`legacy_no_durable_evidence` row per
pre-existing accept). `evidence/validity.ts`: bundle → each source artifact (row + file) vs the bundle →
candidate commit/tree; first `invalid` wins; cannot run → `unknown`. Triggers: bridge sweep at startup and
every 30 s (≤ 20, oldest first; a new `invalid` raises an alarm); task-detail read re-checks when the last
check is older than 5 s and (lead patch) the detail route awaits the full check; snapshot shows the stored row.
UI: `acceptance-validity` next to the historical `acceptance-status=accepted` in task detail, HQ document and
history (`role=alert` for invalid, no dismiss); accepted original viewable as history from the bundle.

Residual windows: a detail read within 5 s of the last check returns the stored result; list-only viewers
wait until a sweep batch (at most 20, oldest check first; about ceil(N/20) sweeps for N eligible results) reaches
the result — no fixed deadline (see "Known limits"); descriptor exhaustion while reading a source file records `source_evidence_changed`
(sticky, conservative).

Lead integration patches: `gate2.test.ts` receipt effects include the digest; 08 ADV-EVID-14b/15 re-expressed
for the v1.2 contract (original from the bundle, validity invalid; tampered/host bytes still never served);
router passes the auth clock to the read model and the detail route awaits the full check. After the patches:
`bun --no-env-file test apps/hub` **957 pass / 0 fail**, typecheck clean.

Reviewer probe after Fixes 1–3 (unchanged copy): OBS-04 and J-22 → 201, after restart `accepted` history,
one accept decision, artifact `verified` with the original bytes (`text_is_null: false`, from the bundle);
the extended copy shows validity `invalid`/`source_evidence_changed` after the sweep and after restart (first
read within the 5 s window was `valid`), receipt digest = validity digest. Commit-expiry cases: 409, 0 decisions.
Browser J-22 under the corrected contract: PASS (full HUB run 104/0/2 at that point).

## Fix 4 — criterion identity and coverage

Schema (UI worker): v1.2 proposal/envelope, criterion ids, coverage derivation, `resultEligibilityV1_2`, new
vectors in `fixtures/vectors-v1.2.json` (v1 vectors and `sample.ts` byte-identical), INTERFACE.md §13. The
draft mapping keys are redacted exactly like the criteria before storage (lead patch: `storedDraft` →
`redactDraft`).

Backend integration (evidence worker): publish is v1.2-only and fails closed (400 + issues) on a criterion
without mapping, a mapping key naming no criterion, an untrusted check, a criterion mapped to no check, or
duplicate criterion text/ids; rerunning a legacy v1 proposal → 400 ("publish a new version"). The stored
proposal is canonical v1.2 and the managed task's criterion text is byte-identical. Store reads refuse a
v1.2 proposal whose ids don't match their texts (even when rewritten consistently with its hash); the v1.2
envelope schema re-derives coverage, so forged coverage never parses. Sealer: v1.2 proposal → v1.2 envelope
with derived coverage; eligibility everywhere = `resultEligibilityV1_2` (bridge Gate-2 opening; decision
service recomputes it on the stored envelope + proposal before the re-seal). Legacy v1 proposal → result
`invalidated(evidence_unavailable)` "…a new proposal and approval are required", no bundle, never accepted.
Test helpers map each criterion explicitly to `fixture-check` (never inferred).

**Migration 010** (`010_proposal_contract_v1_2.sql`, lead-approved): 008's `managed_proposals.contract_version
CHECK (= v1)` makes a v1.2 snapshot unstorable and SQLite cannot alter a CHECK in place; 008 is never edited,
so 010 rebuilds that one table inside the migration transaction (deferred FKs, rows copied verbatim, same
columns/keys/FKs, CHECK widened to v1 | v1.2 plus `json_extract(snapshot,'$.contract') = contract_version`,
the three 008 triggers re-created verbatim, no RENAME). Lead review: identical to 008's definition except the
widened/added CHECKs. Test (`persistence/proposal-v1_2.test.ts`) on a genuine 009 DB with legacy rows:
proposal/request/decision rows byte-identical, `foreign_key_check` empty, trigger SQL identical, immutability
enforced, mislabelled/unknown contract rejected. Schema version 10.

Tests: `decisions/criterion-coverage.test.ts` (12), `evidence/coverage.test.ts` (4),
`bridge/criterion-coverage.test.ts` (2), `persistence/proposal-v1_2.test.ts` (2) + schema v1.2 tests (78).
After the backend phase: `bun --no-env-file test apps/hub` 978/0; `packages/schema` + `apps/web/src` 639/0;
typecheck clean. `acceptance_validity` is required-nullable in the views.

UI + browser (UI worker): per-criterion "Checks for criterion N" groups (trusted checks from the snapshot,
nothing preselected, keyed by exact line text, edited lines start unmapped, dangling keys pruned on save);
Submit stays disabled while any criterion is unmapped and names them; server issues shown verbatim. Gate-1
document/proposal view: "Criterion checks" table with stable ids. `Coverage.tsx`: per-criterion status,
check outcomes and log evidence identity at Gate 2 and in task detail; overall = worst criterion status
(never a green count); legacy results read "no criterion coverage — a new proposal and approval are
required". Browser regressions BRW-C-01…C-05 (MATRIX.md §11). Disclosed test-design limits: on the real hub
a failing check fails the attempt before sealing, so BRW-C-03 exercises the "no sealed result → no
acceptance" path; unsatisfied rendering is proven by the fixture suite and unit tests, and failed→unsatisfied
at sealing by `evidence/coverage.test.ts` (manifest rewritten). BRW-C-01's "server 400 shown" uses a stale-
client fault (outgoing draft rewritten to drop the mapping) because the real UI cannot submit unmapped; the
400/issues come from the real hub. UI worker's final runs (no hub/schema file changed during them): web +
schema unit 612/0; `hub.suite.ts` 108 PASS / 0 FAIL / 2 NOT RUN (R-01, J-21); `fx.suite.ts` 30/0/24
delegated; typecheck, lint, secrets, web-safety and app builds clean.


## Final verification (lead, isolated runner, final tree)

| Check | Result |
| --- | --- |
| `bun run lint` | clean (278 files) |
| `bun run typecheck` | 5/5 projects |
| `bun --no-env-file test` (all) | **1708 pass / 0 fail** (103 files) |
| adversarial suite | 203 / 0 |
| `check:secrets` | ok (326 files) |
| `bun run build:web` | ok |
| `managed:demo` | 8/8 scenarios as expected |
| legacy browser gate (`browser-gate.ts`) | 24/24 |
| real-hub browser (`hub.suite.ts`) | 108 PASS / 0 FAIL / 2 NOT RUN (R-01, J-21) |
| fixture browser (`fx.suite.ts`) | 30 PASS / 0 FAIL / 24 delegated |
| reviewer probe (unchanged copy) | commit-expiry ×4 → 409, 0 decisions; OBS-04/J-22 → accepted history, original bytes from the bundle after restart |
| extended validity probe | OBS-04/J-22 validity `invalid` / `source_evidence_changed` after sweep and after restart; receipt digest = validity digest |
| source preservation | v011 and main checkout tracked files + SOL design byte-identical to the pre-M1 snapshot; nothing on 4317; no stray processes |

Not run: hosted CI, live providers, axe-core, manual MacBook/screen-reader checks, Chrome-for-Testing full pass,
two hubs on one DB (out of scope).

## Final identity (2026-10-02T10:41:40Z, before the final documentation edits)

Branch `feat/workspace-approvals-m1`, HEAD `f960055448e4f5a0bd93a7b9ca0aeb0d2ef8597d`, staged 0. Tracked: 23 files
(+493/−59), `git diff HEAD | shasum -a 256` = `7d5dce7d02ed02c20d38eac497d8426deae39b30f89cc36df9e23eab9b90433e` (the
only tracked file changed by this pass: `apps/hub/src/hub.test.ts`). Untracked: 196 files (26 new, ~70 modified
existing M1 files), manifest = `29f989ed962d2650ce8d9c316cc580a24b388aeacfcc46df5d27a9a463fff6e2`. The docs edited
after this measurement (DELIVERY, CORRECTIVE, RUNBOOK, INTEGRATION, QA_*) change the untracked manifest:
recompute with the commands in DELIVERY.md §1/§0.

## Re-review brief (for the independent Codex re-review)

Baseline `f960055…`; reviewed state = tracked `86d185c3…` + untracked manifest `cd35347c…`. Verify each finding
in integrated flows, not only unit tests: (1) `decisions/decision-service.ts` `authoritativeNow()` inside the
transaction; `commit-authority.test.ts`; (2) `evidence/bundle.ts`, sealer buffers, `bridge/reconciler.ts`
publication before the request row, Gate-2 `verifyBundle` + digest binding, reader serving only from the bundle,
migration 009 triggers; (3) `evidence/validity.ts`, sweep/read triggers, sticky triggers, read model + UI
(`Validity.tsx`), browser J-22; (4) `proposal.ts`/`result.ts`/`hash.ts` v1.2, `commands.ts` publish, sealer
coverage, `resultEligibilityV1_2`, migration 010, UI authoring/coverage, browser C-01…C-05. Known limits to
challenge: periodic (not instantaneous) validity detection with a 5 s read window; hub-path "unsatisfied"
rendering not reachable on the real engine; BRW-C-01's server-400 path uses a stale-client fault; transient
descriptor exhaustion while reading a source file records `source_evidence_changed` (conservative, sticky);
no protection against a privileged attacker rewriting artifacts and SQLite consistently. Reviewer scripts used:
`/private/tmp/agent-city-m1-review-jkmfy1nt/independent-probes.ts` (output path changed only).

## Known limits carried into re-review (updated by the follow-up pass)

- OBS-04 timing (not changed): in the reviewer's barrier swap (source artifact replaced after Gate-2
  revalidation, before the commit) acceptance succeeds and the **first detail read within 5 s shows `valid`**;
  the change is reported as `invalid`/`source_evidence_changed` by the first check that reaches the result: a
  detail read once the last check is older than 5 s (the route awaits it) or a sweep (startup or periodic)
  whose batch includes it. Sweeps take at most 20 `valid|unknown` results each, oldest check first, so with N eligible
  results one sweep is not enough when N > 20 (about ceil(N/20) sweeps; the reviewer's 21st result needed the
  second sweep), plus serial-queue and check time; snapshot / list reads never check. There is no fixed 5 s /
  30 s detection bound, and measured times are observations, not bounds (CONTRACT_V1_2.md §C). The accepted
  bytes are the verified originals in the bundle regardless. Regression: `bridge/validity-batch.test.ts`.
- Legacy (pre-v1.2) execution grants — resolved in the follow-up pass: approving an old pending v1 Gate 1 used
  to queue a simulated run whose result could never be accepted. Now a challenge or decision attempt (after
  receipt replay, before the challenge is consumed) or the bridge sweep (startup + periodic) invalidates the
  pending request (`evidence_unavailable`, detail "obsolete v1 proposal without criterion coverage; publish a
  new version and request a fresh execution approval"), releases its reservation and returns the task to
  draft; the attempt gets 409 `stale_binding` with that detail as its one issue — no decision, receipt,
  challenge or queue effect. An already approved v1 execution is denied by `authorize` before every stage
  (`approval_void`) and the reconciler records its cancel intent (shown `cancelled` only once the engine
  confirms termination). Historical proposals, decisions, receipts and validity rows are unchanged; a stored
  receipt still replays. Tests: `decisions/obsolete-v1-grant.test.ts`, `bridge/obsolete-v1-grant.test.ts`.
