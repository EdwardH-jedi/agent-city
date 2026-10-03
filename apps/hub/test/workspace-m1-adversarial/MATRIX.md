# M1 independent adversarial QA — attack matrix (role 08, design phase)

Status: **DESIGN ONLY — no test code, nothing executed.** Interfaces are not frozen; every row is
written against durable-state invariants so it survives route/shape changes. Route names follow SOL
design §C ("API command contracts"); status codes named in the design (`409 stale_binding`,
`409 artifact_integrity`, `409 live_disabled`) are used as-is, every other code is
**proposed — freeze with 01/03/04** (see §6).

Sources: `SHARED_M1_SPEC.md`, `08_ADVERSARIAL_QA.md`, `docs/workspace-m1/OWNERSHIP.md`,
`docs/workspace-m1/BASELINE.md`, SOL design (§C, §E, §H M1-01…M1-12). Legacy audit read against
`f960055` plus the lead's uncommitted `tsconfig`/`package.json` export edits (2026-10-02).

## 0. Conventions

### Severity rubric (severity *if the expected result fails*)

| Sev | Meaning |
| --- | --- |
| **Critical** | Unauthorized queue / accept / execution; a second execution from one decision; any provider or preflight spawn on a forbidden path; a canary disclosed on any surface |
| **High** | Integrity bypass (tampered evidence served or accepted); managed/workspace data on a public surface; auth / Origin / CSRF / scope bypass that does not by itself queue |
| **Medium** | Hang / DoS of the hub; wrong or ambiguous durable state (e.g. `cancelled` without proof, lost receipt, missing invalidation without execution) |
| **Low** | Hygiene: headers, error-code drift, timing side channels, non-atomic writes that still fail closed |

### Common preconditions (P0) — every row unless stated

Isolated in-process hub from the lead's harness (§4) on a temp file-backed SQLite DB, disposable
fixture repo `local/fixture` (the only allowlisted repo), fake adapters, a fake clock, and a
config whose `live` block **is enabled against stub executables** (so "hard-off" is proven against
a config that would otherwise allow live). Counters zeroed. Two identities: `operator:edward`
(full scope) and `operator:viewer` (read-only scope). `valid(gate)` builds a fully valid decision
request (session cookie, CSRF header, exact Origin, fresh challenge, `"Edward"`, current
`binding_hash`, current `expected_request_rev`, fresh `idempotency_key`); each row mutates exactly
**one** element of it unless it says otherwise. Synthetic secrets/canaries are assembled at
runtime only (e.g. `gh` + `p_` + 36 random chars; a YAML `password: |` block whose body is a
non-token-shaped random string). No literal canary is ever written to a file in this directory.

### Assertion bundles

- **NE (no effect)**: `managed_decisions` count unchanged; `managed_approval_requests.status` and
  `.rev` unchanged; challenge status unchanged (unless the row says "consumed"); the reserved
  `managed_tasks` row: `state`, `run_requested_at` (NULL), `approval_hash` (NULL), `fence_token`
  unchanged; `managed_runs` count unchanged; `workspace_tasks.rev` unchanged; fake
  implementer/reviewer/preflight call counts unchanged; stub provider call logs absent;
  `processSpawns` delta 0; response body echoes no request body / secret.
- **OL (one linkage)**: exactly one approve `managed_decisions` row for the request; request status
  `approved`; exactly one `managed_tasks` row linked to that decision with `run_requested_at` set
  once and `fence_token` advanced once by queueing; after `runUntilIdle()`: one `initial` run (+ at
  most the preapproved repair), fake implementer invoked once (+ repair), zero provider stub calls.
- **SAFE-FAIL**: failure metadata (HTTP body, `state_detail`, `failure_detail`, logs) names a reason
  class only — no raw file content, no canary, no absolute host path.

Coverage tags: `M1-xx` = SOL §H; `SPEC:<topic>` = SHARED_M1_SPEC section; `Cn` = five-fix label (§2).

### Acceptance coverage index (this suite vs role 09)

| SOL §H | Covered here (backend, direct API) | Owned by role 09 (browser) |
| --- | --- | --- |
| M1-01 | AUTH, ORIGIN, CSRF, NAME, CHAL, LEGACY, INPUT | disabled-button UI checks |
| M1-02 | CHAL-02/08/09, IDEM, RACE-01…04 | double-click in the real UI |
| M1-03 | NAME (server-side exactness), G2-06/07, ACCEPT-04, IDEM-10 | new empty field, **inert Enter**, field clearing on selection/invalidation/logout/reload/offline |
| M1-04 | INVAL, CHAL-04, RACE-04 | — |
| M1-05 | G2, EVID, HASH-06 | evidence viewer rendering |
| M1-06 | REPAIR, INVAL-06…08 | — |
| M1-07 | CANCEL, RESTART-01/06, G2-11 | "cancellation pending" display |
| M1-08 | IDEM-01/02/08, RESTART, LEGACY-07/08, ACCEPT-05 | reload reconstruction in the UI |
| M1-09 | backend half only: CHAL-02/04/07 (an old confirmation/challenge can never apply to a newer binding), IDEM (lost responses) | **A→B stale responses, poll/reconnect, late auth errors, one cache for panel + campus** |
| M1-10 | LIVE, LEGACY, WS | provenance labels as rendered |
| M1-11 | — (not in scope here) | **1440×900, 1280×800, keyboard, reduced motion, no-WebGL, screenshots** |
| M1-12 | REDACT, NAME-08, INVAL-10, EVID-17 | inert rendering in the DOM |

Items marked for role 09 are **not covered by this suite by design**, not forgotten; the M1D
aggregate must show them as 09's pass/fail/not run.

## 1. Attack matrix

### ADV-AUTH — authentication and scope (surface: every `/api/workspace/*` route)

| ID | Attack (direct API) | Expected | Covers | Sev |
| --- | --- | --- | --- | --- |
| ADV-AUTH-01 | Each mutation route (tasks, proposals, execution-requests, challenge, decisions, cancel) with no session cookie | 401; NE | M1-01, SPEC:decisions | Critical |
| ADV-AUTH-02 | Each read route (snapshot, task, decision lookup, artifact) with no cookie | 401; body holds no task/proposal/decision data | SPEC:attack "authorize all workspace routes" | High |
| ADV-AUTH-03 | Forged cookie (well-formed random opaque value) | 401; NE | M1-01 | Critical |
| ADV-AUTH-04 | Valid session cookie from before a hub restart (new boot generation) | 401 (sessions are ephemeral) | SPEC:decisions, M1-08 | High |
| ADV-AUTH-05 | Session past TTL (fake clock) / after logout | 401; NE | M1-01, M1-03 | High |
| ADV-AUTH-06 | Legacy `Authorization: Bearer <MANAGED_TOKEN>` (and the ingest token) on `/api/workspace/*` | 401 — a bearer token is not operator authentication | SPEC:attack legacy | Critical |
| ADV-AUTH-07 | `operator:viewer` requests a challenge / posts a decision / posts cancel | 403; NE (reads allowed per frozen scope table) | SPEC:decisions "scoped" | Critical |
| ADV-AUTH-08 | Challenge minted for edward's session, decision sent with viewer's session | 403; challenge not consumed; NE | M1-01 | Critical |
| ADV-AUTH-09 | Bootstrap exchange with wrong credential; replay of a used single-use bootstrap credential | 401; no `Set-Cookie`; credential never echoed or logged | SPEC:decisions | High |
| ADV-AUTH-10 | Inspect `Set-Cookie` after login | `HttpOnly`, `SameSite=Strict`, no `Domain`, scoped `Path`, `Secure` iff TLS; session value never in any JSON body or log | SPEC:decisions | High |
| ADV-AUTH-11 | Session fixation: send a chosen cookie value, then log in | Post-login cookie value differs; chosen value stays 401 | SPEC:decisions | Medium |
| ADV-AUTH-12 | Unauthenticated request for a nonexistent id vs an existing id | Both 401 (no existence oracle before auth) | SPEC:attack | Low |
| ADV-AUTH-13 | Credential/session in query string (`?session=`, `?token=`) | Ignored → 401 | SPEC:decisions | Medium |

### ADV-ORIGIN — exact Origin, CORS, Host (surface: mutations, reads, CORS preflight)

Note: `SameSite=Strict` does **not** isolate loopback ports — a page on `http://127.0.0.1:<Q>` is
same-site with the hub, so the browser **does** attach the cookie. Exact Origin (scheme + host +
port) plus CSRF are the only cross-port defenses. Configured app origin below = `O` =
`http://127.0.0.1:<P>`.

| ID | Attack | Expected | Covers | Sev |
| --- | --- | --- | --- | --- |
| ADV-ORIGIN-01 | Mutation with **absent** Origin (otherwise valid) | 403 (proposed; ambiguity A3); NE | M1-01 | High |
| ADV-ORIGIN-02 | `Origin: null` | 403; NE | M1-01 | High |
| ADV-ORIGIN-03 | Alias `http://localhost:<P>` (and `http://[::1]:<P>`) | 403; NE | M1-01 | High |
| ADV-ORIGIN-04 | Wrong port `http://127.0.0.1:<P+1>` with a valid cookie + CSRF (cross-port page) | 403; NE (legacy `isAllowedOrigin` accepts any port) | M1-01 | Critical |
| ADV-ORIGIN-05 | Scheme `https://127.0.0.1:<P>` | 403 | M1-01 | High |
| ADV-ORIGIN-06 | Trailing slash `O/`; path `O/x`; userinfo `http://u@127.0.0.1:<P>`; padded `" O"` | 403 each | M1-01 | High |
| ADV-ORIGIN-07 | Case `HTTP://127.0.0.1:<P>`, `http://LOCALHOST:<P>` | 403 each | M1-01 | High |
| ADV-ORIGIN-08 | Two `Origin` headers / comma list `O, http://evil.test` | 403 | M1-01 | Medium |
| ADV-ORIGIN-09 | Configured extra origin `X`: send `X/` and `X` with different case | Only exact `X` accepted | M1-01 | Medium |
| ADV-ORIGIN-10 | Credentialed GET of snapshot with foreign-port Origin | 403 (proposed) **or** response lacks `Access-Control-Allow-Credentials: true` + echoed ACAO; never `*` | SPEC:attack | High |
| ADV-ORIGIN-11 | `OPTIONS` preflight from foreign-port origin requesting the CSRF header | No allow for that origin; CSRF header never listed for non-exact origins | M1-01 | High |
| ADV-ORIGIN-12 | Foreign `Host` (rebinding name) on workspace routes; valid Host + foreign Origin | 403 both | CLAUDE.md rule 5 | High |
| ADV-ORIGIN-13 | Origin checks re-run on the lost-response retry path (see ADV-IDEM-05) | 403 even when a receipt exists | SPEC:decisions | High |

### ADV-CSRF — request forgery (surface: every mutation incl. challenge issuance and cancel)

| ID | Attack | Expected | Covers | Sev |
| --- | --- | --- | --- | --- |
| ADV-CSRF-01 | Missing CSRF header | 403; NE | M1-01 | Critical |
| ADV-CSRF-02 | Random CSRF value | 403; NE | M1-01 | Critical |
| ADV-CSRF-03 | Session B's CSRF with session A's cookie | 403; NE | M1-01 | Critical |
| ADV-CSRF-04 | CSRF from before logout / before restart | 403 | M1-01, M1-08 | High |
| ADV-CSRF-05 | CSRF moved to body or query instead of the frozen header | 403 | M1-01 | Medium |
| ADV-CSRF-06 | "Simple request" bypass: `text/plain`, form-urlencoded, multipart carrying JSON | 415; NE | M1-01 | High |
| ADV-CSRF-07 | Challenge issuance via GET (image-tag style) | 404/405; no challenge row/hash written | M1-01 | High |

### ADV-NAME — typed `Edward` (surface: Gate-1 approve, Gate-2 accept; parametrized over both)

| ID | Attack | Expected | Covers | Sev |
| --- | --- | --- | --- | --- |
| ADV-NAME-01 | `confirmation_text` missing / `""` | 4xx `confirmation_invalid` (proposed); NE | M1-01, M1-03 | Critical |
| ADV-NAME-02 | `edward`, `EDWARD`, `eDward`, `Edward Hwang`, `Edward.`, `operator:edward` | 4xx; NE | M1-01 | Critical |
| ADV-NAME-03 | Whitespace: leading/trailing space, tab, `\n`, `\r\n` | 4xx; NE (no trimming) | M1-01 | Critical |
| ADV-NAME-04 | Look-alikes: Cyrillic `а`, fullwidth, zero-width joiner/space, RTL override, embedded NUL | 4xx; NE | M1-01 | Critical |
| ADV-NAME-05 | Type confusion: `null`, number, `true`, `["Edward"]`, `{"v":"Edward"}` | 400; NE | M1-01 | Critical |
| ADV-NAME-06 | Exact `Edward` with an invalid/absent challenge | Rejected — typed name never authenticates; NE | SPEC:decisions | Critical |
| ADV-NAME-07 | Reject / request-changes without a name but with reason; without reason | With reason: accepted, queues nothing; without: 4xx | SOL §C Gate 1 | Medium |
| ADV-NAME-08 | Reason containing a runtime canary | Stored redacted; never echoed raw | M1-12 | Critical |
| ADV-NAME-09 | Stored decision row | `confirmation_text` = `Edward` exactly; actor = authenticated operator id, never the typed text | SPEC:decisions | Medium |

### ADV-CHAL — single-use challenge binding (surface: challenge + decision routes, approval-request row)

Challenge `C` minted for (session S, operator, request R1, gate 1, binding B1, rev r1, expiry T, boot g1).

| ID | Attack | Expected | Covers | Sev |
| --- | --- | --- | --- | --- |
| ADV-CHAL-01 | Decision with no challenge / forged challenge | 4xx `challenge_invalid` (proposed); NE | M1-01 | Critical |
| ADV-CHAL-02 | `C` used on R2 (same gate, other task) | 4xx; R2 NE; R1 unchanged | M1-02 | Critical |
| ADV-CHAL-03 | `C` (gate 1) used on the same task's Gate-2 request | 4xx; NE | M1-01 | Critical |
| ADV-CHAL-04 | Proposal v2 published after `C` minted; decision with `C` + B1 | `409 stale_binding`; R1 invalidated; NE for queue | M1-04 | Critical |
| ADV-CHAL-05 | Body `binding_hash` ≠ request binding; stale `expected_request_rev` | 409 (`stale_binding` / proposed `stale_rev`); NE | M1-01 | Critical |
| ADV-CHAL-06 | Clock advanced to `T+1 ms`; control at `T−1 ms` | Expired → 4xx `challenge_expired` (proposed), NE; control succeeds (OL) | M1-01 | Critical |
| ADV-CHAL-07 | Restart (boot g2), re-login, use `C` | 4xx; NE | SPEC:decisions "boot generation" | Critical |
| ADV-CHAL-08 | Second login of the same operator (session S2) uses `C` | 4xx (bound to session); NE | M1-02 | High |
| ADV-CHAL-09 | Replay `C` after a successful decision with a **new** idempotency key | 409 `challenge_consumed` (proposed); still exactly OL | M1-02 | Critical |
| ADV-CHAL-10 | Mint `C1`, then `C2` for R1; use `C1` | Rejected if single-outstanding is frozen (ambiguity A2); never two decisions | M1-02 | High |
| ADV-CHAL-11 | Mint a challenge for a non-pending request (approved/rejected/invalidated) | 409 at issuance | M1-01 | Medium |
| ADV-CHAL-12 | Inspect `managed_approval_requests` + logs after minting | Only a challenge **hash**/status/expiry/boot stored; raw challenge never logged | SPEC:decisions | High |
| ADV-CHAL-13 | Mismatched use (02/03/05) followed by the correct use of `C` | Behavior matches frozen policy (consume-on-mismatch or not, A2); never a queue from the mismatched call | M1-02 | Medium |

### ADV-IDEM — receipts, lost responses, conflicting payloads (surface: decision route + `GET /decisions/:id`)

| ID | Attack | Expected | Covers | Sev |
| --- | --- | --- | --- | --- |
| ADV-IDEM-01 | Valid approve; hook `afterDecisionCommitBeforeResponse` drops the response; retry same key + same payload + (now consumed) challenge | 200 with the **original** receipt (same decision id/timestamps); OL still exactly one | M1-02, M1-08 | Critical |
| ADV-IDEM-02 | `GET /decisions/:decision_id` after a lost response; same as viewer / unauthenticated | Owner: original outcome; unauth 401; scope per frozen table | M1-08 | High |
| ADV-IDEM-03 | Same key, changed payload (reason / action / binding / rev / confirmation) | 409 `idempotency_conflict`; NE | SPEC:decisions | Critical |
| ADV-IDEM-04 | Same key + payload, **no cookie** | 401 — auth precedes receipt lookup; receipt not leaked | SPEC:decisions | High |
| ADV-IDEM-05 | Same key + payload, missing CSRF / bad Origin | 403; receipt not returned | SPEC:decisions | High |
| ADV-IDEM-06 | Edward's key reused by `operator:viewer` (or a second test operator) | Treated as unused for that operator → needs its own valid challenge → 4xx; edward's receipt never returned | SPEC:decisions "by operator and idempotency key" | High |
| ADV-IDEM-07 | Unused key, no/invalid challenge | 4xx; NE (an unused key never bypasses) | SPEC:decisions | Critical |
| ADV-IDEM-08 | Restart, re-login, retry same key + payload | Original receipt (receipts durable across boots) | SPEC:decisions, M1-08 | High |
| ADV-IDEM-09 | Same payload with permuted key order / whitespace | Same canonical payload → original receipt; an extra unknown field → 400 (strict), not 409 | SPEC:decisions | Medium |
| ADV-IDEM-10 | Gate-1 key reused for the Gate-2 decision | 409 conflict (different payload); never returns the Gate-1 receipt as an acceptance | M1-03 | High |
| ADV-IDEM-11 | Failed attempt with key K (wrong name), then fully valid attempt with K | Behavior per frozen policy (failures do not create receipts — expected success); never a phantom receipt | SPEC:decisions | Medium |

### ADV-RACE — concurrency (surface: SQLite transaction, decision/accept routes)

| ID | Attack | Expected | Covers | Sev |
| --- | --- | --- | --- | --- |
| ADV-RACE-01 | 20 concurrent identical approves (same key, same challenge) | Exactly OL; responses 200 (same receipt) or proposed 409 `in_progress`; zero 5xx | M1-02 | Critical |
| ADV-RACE-02 | 20 concurrent approves, distinct keys, same challenge | 1 success, 19 × 409; OL | M1-02 | Critical |
| ADV-RACE-03 | Approve vs reject concurrently (separate challenges) | Exactly one decision; loser 409 `not_pending`; reject winner → zero linkage | M1-02, M1-06 | Critical |
| ADV-RACE-04 | Hook `beforeDecisionCommit` widens the window; publish proposal v2 inside it | Either approve → `409 stale_binding`, or approve commits and v2 invalidates the grant before claim (0 implementer calls); never a launch under v1 after v2 is current | M1-04 | Critical |
| ADV-RACE-05 | Concurrent duplicate Gate-2 accepts | Exactly one acceptance row; others 409 / same receipt | M1-03 | Critical |
| ADV-RACE-06 | Approve vs cancel of the reserved execution | Consistent end state: cancelled with no queue, or queued-then-cancelled with 0 launches | M1-07 | High |
| ADV-RACE-07 | `insideDecisionTx` throws at `after_challenge_consume`, `after_receipt`, `after_transition` | Full rollback each time: challenge unconsumed, no decision/receipt, request pending, no queue; a later valid attempt → exactly OL overall; `PRAGMA integrity_check` ok | SPEC:decisions "one SQLite transaction" | Critical |

### ADV-INVAL — edits, stale approvals, request changes (surface: proposals, approval requests, orchestrator claim/launch)

| ID | Attack | Expected | Covers | Sev |
| --- | --- | --- | --- | --- |
| ADV-INVAL-01 | Publish v2 while Gate-1 pending; approve the v1 request | v1 request `invalidated` with reason; `409 stale_binding`; NE | M1-04 | Critical |
| ADV-INVAL-02 | Publish v2 after Gate-1 approve, before claim | Grant invalidated; claim refuses before preflight; 0 preflight/implementer calls; history retained | M1-04 | Critical |
| ADV-INVAL-03 | Publish v2 during execution (hook `beforeStage(verify)`) | No later stage launches (reviewer 0 calls); fenced/stopped; evidence retained | M1-04 | Critical |
| ADV-INVAL-04 | Change policy (verification argv, limits, repair allowance) or context between approve and claim | Policy/context hash mismatch → no launch | M1-04 | Critical |
| ADV-INVAL-05 | Fixture `main` advances after approval | Pinned execution uses the approved `base_sha`; not silently rebased; a newer base requires a new version + Gate 1 | SOL §C proposal | High |
| ADV-INVAL-06 | Gate-1 request changes → edit → submit | Old request `changes_requested`; new version needs a new request + challenge; old challenge/decision cannot approve it | M1-06 | Critical |
| ADV-INVAL-07 | Gate-2 request changes | Linked draft; nothing queued; new Gate 1 required; old Gate-1 decision not reusable; old candidate still readable | M1-06 | Critical |
| ADV-INVAL-08 | Reject at Gate 1; reject at Gate 2 | Nothing queued; no repair; no new execution | M1-06 | Critical |
| ADV-INVAL-09 | PUT/PATCH/DELETE on a proposal | 404/405; stored canonical snapshot + hash unchanged | SPEC:decisions "immutable" | High |
| ADV-INVAL-10 | Proposal text with runtime canaries | Stored/displayed sanitized; `proposal_hash` covers the sanitized snapshot shown to Edward | M1-12 | Critical |

### ADV-G2 — Gate 2 exact result binding (surface: result envelope, accept decision)

Setup: execution reaches `human_ready`; pending Gate-2 request bound to envelope `E`.

| ID | Attack | Expected | Covers | Sev |
| --- | --- | --- | --- | --- |
| ADV-G2-01 | Accept naming attempt 1 (rejected) of a repaired execution | `409 stale_binding`; no acceptance | M1-05 | Critical |
| ADV-G2-02 | Wrong candidate SHA / tree / manifest hash / review id / artifact list | 409; no acceptance | M1-05 | Critical |
| ADV-G2-03 | Delete one required artifact row (e.g. a verification log) before accept | 409; request invalidated | M1-05 | Critical |
| ADV-G2-04 | Review invalid / reject / blocker finding / bound to another manifest | No Gate-2 request created; forced accept → 409 | M1-05 | Critical |
| ADV-G2-05 | A required check did not complete | No Gate-2 request; forced → 409 | M1-05 | Critical |
| ADV-G2-06 | Forged `human_ready` managed task with no Gate-1 decision | No Gate-2 request; accept → 409 | M1-03, M1-08 | Critical |
| ADV-G2-07 | Accept after Gate 1 only (execution not `human_ready`) | 409 / 404 | M1-03 | Critical |
| ADV-G2-08 | Stale request revision | 409 | M1-05 | High |
| ADV-G2-09 | Diff larger than the reviewer prompt cap (`REVIEW_DIFF_MAX_CHARS`) | Envelope records incomplete reviewer context and Gate 2 is blocked; never silently accepted | SOL §E evidence | High |
| ADV-G2-10 | Tamper `managed_runs.candidate_sha`; separately dirty the worktree after candidate commit | Row tamper → 409; worktree dirt cannot change the accepted commit/tree identity (contract decides block vs ignore; never accept a different tree) | M1-05 | Critical |
| ADV-G2-11 | Open quarantine or pending cancellation at accept time | 409 | M1-07 | Critical |
| ADV-G2-12 | Execution X's Gate-2 request with execution Y's envelope binding (same task) | 409 | M1-05 | Critical |

### ADV-EVID — artifact/file/row tampering, special files, bounded reads (surface: artifact route, Gate-2 validation, envelope builder)

| ID | Attack | Expected | Covers | Sev |
| --- | --- | --- | --- | --- |
| ADV-EVID-01 | Coherent `diff.patch` file + row sha/len rewrite, manifest unchanged | Artifact route `409 artifact_integrity`; accept 409; request invalidated | M1-05, C5 | Critical |
| ADV-EVID-02 | Diff + manifest + `managed_runs.manifest_hash` rewritten coherently | 409 (review/envelope name the original manifest) | M1-05, C5 | Critical |
| ADV-EVID-03 | Coherent file + row rewrite of `changed-files.json`, `review-output.json`, `review.log` (outside the manifest) | M1: 409 via envelope artifact list (legacy only row-binds these — audit L-06) | M1-05, C5 | High |
| ADV-EVID-04 | Insert a forged approving `managed_reviews` row for the run | Envelope pins review id + canonical hash → no effect on outcome or 409 | M1-05 | Critical |
| ADV-EVID-05 | Edit review row in place (verdict, `valid`, findings) | Canonical review hash mismatch → 409 | M1-05 | Critical |
| ADV-EVID-06 | Repoint `managed_tasks.result_run_id` to another run | 409 | M1-05 | Critical |
| ADV-EVID-07 | Artifact replaced by symlink (same-content file outside root; and a host file) | 409/404; no host-file bytes ever served | M1-05 | High |
| ADV-EVID-08 | Run directory replaced by a symlink to outside the root | 404/409; never served | M1-05 | High |
| ADV-EVID-09 | FIFO in place of an artifact (no writer), via artifact route, Gate-2 validation and envelope build | 409 within ≤1 s; concurrent `/healthz` answered <250 ms throughout | M1-05, C4 | Medium |
| ADV-EVID-10 | Directory / unix socket in place of an artifact; FIFO with a slow writer | 409; no hang | C4 | Medium |
| ADV-EVID-11 | Artifact larger than the read cap with a matching row length | 409 (bounded); no unbounded allocation | SPEC:evidence "bound reads" | Medium |
| ADV-EVID-12 | File truncated after its row; file appended after registration | 409 (length/hash) | M1-05 | High |
| ADV-EVID-13 | Hook `afterArtifactVerifyBeforeServe` swaps the file bytes | Served bytes hash to the verified original (or 409); swapped content never served | SPEC:evidence "validation/use race", C5 | Critical |
| ADV-EVID-14 | Tamper evidence **after** acceptance | Current acceptance flagged invalid + visible alert; original decision row preserved, not edited | SOL §C Gate 2 | High |
| ADV-EVID-15 | Row `rel_path` = `../../x` or absolute | 404; not a host-file reader | M1-05 | High |
| ADV-EVID-16 | Artifact id of another task / of a non-relevant execution | 404 | SPEC:attack "artifact authorization" | High |
| ADV-EVID-17 | Response headers/body for an artifact containing `<script>` | `application/json`, `nosniff`, `no-store`; payload is an inert string | M1-12 | Medium |
| ADV-EVID-18 | Crash after artifact file write, before row; orphan file in the run dir | Orphan never appears in listing/envelope; required evidence missing → acceptance blocked | SOL §E recovery | Medium |

### ADV-REDACT — omitted-hunk YAML gap and sanitized failure paths

Surfaces checked for each canary (`S`): stored `diff.patch` bytes; manifest-referenced diff; the
diff the instrumented fake reviewer received (`ReviewInput.diff`); artifact route JSON; workspace
task/result JSON; result envelope; approval-request snapshot; `managed_tasks.state_detail`;
`managed_runs.failure_detail`; all HTTP error bodies; captured hub stdout/stderr; `/ws` frames.

| ID | Attack (fixture content committed in the disposable repo) | Expected | Covers | Sev |
| --- | --- | --- | --- | --- |
| ADV-REDACT-01 | YAML `password: \|` header >3 lines above a changed body line (header outside the hunk); body is a non-token random string | Canary absent from all `S` **or** diff evidence marked unavailable, Gate 2 blocked, SAFE-FAIL | SPEC:evidence omitted-hunk, M1-12 | Critical |
| ADV-REDACT-02 | Unchanged secret block body appears only as hunk context beside a changed non-secret line | Canary absent from `S` | SPEC:evidence "unchanged secret fields" | Critical |
| ADV-REDACT-03 | Secret header only in the old version (key renamed/removed far above); only in the new version | Absent from `S` | SPEC:evidence | Critical |
| ADV-REDACT-04 | Block variants `\|-`, `\|+`, `>`, `>-`, `\|2`; nested maps/lists; anchors/aliases; flow-style and quoted multi-line strings | Absent from `S` or fail closed | SPEC:evidence | Critical |
| ADV-REDACT-05 | Token split by `\` continuation and across `-`/`+` lines, inside omitted context | Absent from `S` | C3, SPEC:evidence | Critical |
| ADV-REDACT-06 | Header in hunk 1, body in hunk 2 of the same file | Absent from `S` | SPEC:evidence | Critical |
| ADV-REDACT-07 | Renamed file, deleted file, added file, binary file, CRLF, no trailing newline, non-UTF-8 bytes | Absent from `S`; binary never disclosed as text | SPEC:evidence | Critical |
| ADV-REDACT-08 | Required context file larger than the bound | Fail closed: evidence unavailable, Gate 2 blocked, SAFE-FAIL | SPEC:evidence "oversized" | Critical |
| ADV-REDACT-09 | Required context is unparsable YAML | Fail closed, SAFE-FAIL | SPEC:evidence "unparsable" | Critical |
| ADV-REDACT-10 | Required context missing/unreadable (old blob unavailable; symlink/submodule entry in tree) | Fail closed, SAFE-FAIL | SPEC:evidence "missing/unreadable" | Critical |
| ADV-REDACT-11 | Context path is a FIFO or symlink in the worktree (if the reader touches the worktree) | No hang (<1 s); fail closed | C4, SPEC:evidence | Medium |
| ADV-REDACT-12 | Secret-named keys in `.env`-style and JSON files inside omitted context | Masked or fail closed | M1-12 | High |
| ADV-REDACT-13 | Force every failure path (oversized, unparsable, integrity, git error) and grep all bodies/logs/state for canary and raw context lines | Zero hits | SPEC:evidence "sanitized failure", rule 3 | Critical |
| ADV-REDACT-14 | `check:secrets` over the final tree and this directory | Pass (canaries runtime-only) | M1-12 | High |

### ADV-LIVE — crafted live mode, zero providers (config: live **enabled** against stubs)

| ID | Attack | Expected | Covers | Sev |
| --- | --- | --- | --- | --- |
| ADV-LIVE-01 | Proposal with `execution_mode: "live"` | `409 live_disabled` (or 400/422) at creation; stub call logs absent; preflight count 0; `processSpawns` 0 | M1-10, SPEC:outcome | Critical |
| ADV-LIVE-02 | `"Live"`, `"LIVE"`, `" live"`, `["live"]`, `null`, `1` | 400; 0 calls | M1-10 | Critical |
| ADV-LIVE-03 | Simulated mode plus live provider profile ids / model override / executable / argv / shell fields | 400 strict or 422; 0 calls | SOL §C "approval bodies" | Critical |
| ADV-LIVE-04 | Mode override field on execution-request creation or in a decision body | 400; 0 calls | M1-10 | Critical |
| ADV-LIVE-05 | After Gate-1 approve of a simulated proposal, DB-set `execution_mode='live'` on the managed task / proposal | Claim refuses before preflight (binding mismatch) **and** no live adapter is constructed in M1 (defense in depth); 0 calls | M1-10 | Critical |
| ADV-LIVE-06 | Legacy `POST /api/managed/tasks` with live + `/run` (live-enabled config) | Route gone (404/405) or `409 live_disabled`; 0 calls (legacy currently launches preflight — audit L-03) | M1-10, SPEC:attack legacy | Critical |
| ADV-LIVE-07 | Unknown / crafted `simulation_scenario`, fixture-reset style requests | 400 or bounded simulated path; 0 provider calls | M1-10 | High |
| ADV-LIVE-08 | Suite-wide postcondition after every file | Stub call logs absent; `Bun.which("claude")`/`("codex")` null; `LIVE_INTEGRATION_VERIFIED === false` | M1-10 | Critical |
| ADV-LIVE-09 | Snapshot/task labels | Mode `Simulated`, source `Hub record`; simulated hashes/checks never labelled live proof | M1-10 | Medium |

### ADV-LEGACY — direct-run bypasses (written to pass whether the lead removes or keeps `/api/managed`)

| ID | Attack | Expected | Covers | Sev |
| --- | --- | --- | --- | --- |
| ADV-LEGACY-01 | `POST /api/managed/tasks/:id/run` with a valid bearer on a legacy-created draft | Route gone (404/405/410) or 403/409; NE; 0 implementer calls | M1-01, SPEC:attack | Critical |
| ADV-LEGACY-02 | `/run` on the managed task id of a workspace-reserved execution (id read from DB) | No queue without the exact recorded decision; with it, still exactly OL | M1-01, M1-02 | Critical |
| ADV-LEGACY-03 | `/run` on an `interrupted` / `blocked` execution | Never re-queues the same row; rerun = new execution request + fresh Gate 1 | SOL §C repair table | Critical |
| ADV-LEGACY-04 | Legacy `POST /tasks` then any path to execution | No legacy-created draft can become executable | M1-01 | Critical |
| ADV-LEGACY-05 | Legacy GET list/detail/config/artifacts with bearer only | Removed, or operator session + workspace authorization required | SPEC:attack "authorize all routes" | High |
| ADV-LEGACY-06 | Legacy cancel with bearer only | Removed or operator-authenticated | SPEC:attack | Medium |
| ADV-LEGACY-07 | DB insert of a `queued` managed task with `approval_hash = approvalHashFor(task)` and no decision | Worker refuses before preflight; 0 calls | M1-08 | Critical |
| ADV-LEGACY-08 | Seed v011-style rows (draft, `human_ready`, failed) | Shown as history; cannot be run/accepted; no invented actor/decision | M1-08 | High |
| ADV-LEGACY-09 | Static: no hub route reaches `runTask`/`requestRun` or the demo/preflight CLIs | Confirmed by grep of the final diff + route enumeration | SPEC:attack | High |

### ADV-WS — public socket and public read API leakage

| ID | Attack | Expected | Covers | Sev |
| --- | --- | --- | --- | --- |
| ADV-WS-01 | Unauthenticated `/ws` tap (allowed Origin and absent Origin) through a full journey (propose → Gate 1 → repair → Gate 2 → accept, plus a cancel journey) | No `managed`/workspace frame kinds; no frame contains any id collected from the DB (task/run/art/proposal/request/decision ids, candidate SHA, artifact names, fixture path) | SPEC:attack WS, SOL §E | High |
| ADV-WS-02 | `/ws` from a foreign loopback port | 403, or observed-only frames; no managed data either way | SPEC:attack WS | High |
| ADV-WS-03 | `/api/repos`, `/api/sessions`, `/api/events`, `/api/sessions/:id/agents`, `/healthz` after the journey | No managed/workspace identifiers | SPEC:attack | High |
| ADV-WS-04 | Frame count on `/ws` during a journey with zero telemetry activity | 0 (no timing side channel of managed transitions) | SOL §E | Low |
| ADV-WS-05 | Client sends command-shaped JSON over `/ws` | Ignored; NE | SPEC:attack | Medium |
| ADV-WS-06 | Any authenticated private channel (if added) | Cookie + exact Origin + CSRF-equivalent; no cross-session data | SPEC:attack | High |

### ADV-REPAIR — 0/1 boundary and forbidden classes

| ID | Attack | Expected | Covers | Sev |
| --- | --- | --- | --- | --- |
| ADV-REPAIR-01 | No repair policy + `verification_fails` | `failed`/`verification_failed`; 1 run; implementer ×1 | M1-06, SPEC:repair | High |
| ADV-REPAIR-02 | No repair policy + `reject_then_approve` | `failed`/`review_rejected`; 1 run | M1-06 | High |
| ADV-REPAIR-03 | Preapproved 1 + `verification_fails_then_fixed` / `reject_then_approve` | 2 runs; `human_ready`; envelope binds attempt 2; attempt 1 retained | M1-06 | High |
| ADV-REPAIR-04 | Preapproved 1 + `reject_always` | 2 runs; `repair_limit_exhausted`; no third attempt; no auto proposal | M1-06 | Critical |
| ADV-REPAIR-05 | Repair allowance 2, 3 (legacy max), −1, 1.5, `"1"` | 400 at proposal (needs contract delta — audit L-12) | SPEC:repair | Critical |
| ADV-REPAIR-06 | Preapproved 1 + forbidden classes: `out_of_scope`, `malformed_review`, `review_wrong_candidate`, `reviewer_mutates`, `reviewer_error`, evidence corrupted between verify and review, approval void, `impl_hangs`, quarantine | 1 run each; no repair attempt | SPEC:repair "never trigger repair" | Critical |
| ADV-REPAIR-07 | Scripted reviewer rejects with an actionable finding on a file outside the approved scope | No automatic repair; scope-expansion stop requiring a new proposal (legacy repairs any actionable finding — L-11) | SPEC:repair "scope expansion" | Critical |
| ADV-REPAIR-08 | Crash during the repair attempt | Interrupted; not re-run; repair count persists | M1-07 | Critical |
| ADV-REPAIR-09 | Route enumeration for any way to create a repair or raise the allowance | None exists | SPEC:repair | High |

### ADV-CANCEL — cancellation vs completion and late callbacks

| ID | Attack | Expected | Covers | Sev |
| --- | --- | --- | --- | --- |
| ADV-CANCEL-01 | Cancel a queued, unclaimed execution | `cancelled`; never claimed; 0 implementer calls | M1-07 | High |
| ADV-CANCEL-02 | Cancel during `impl_hangs` | `cancel_requested_at` set; API shows pending (not `cancelled`) until termination confirmed; no Gate-2 request | M1-07, SPEC:repair | High |
| ADV-CANCEL-03 | Hook `beforeFinalizeHumanReady`; cancel inside the window | Cancel wins: `cancelled`, no `human_ready`, no Gate-2 request | M1-07 | Critical |
| ADV-CANCEL-04 | Cancel after `human_ready` committed | Engine state unchanged; Gate-2 behavior per frozen rule (ambiguity A1) | M1-07 | Medium |
| ADV-CANCEL-05 | Worker A held at `beforeStage`; lease expires (fake clock); worker B reconciles; release A | A writes nothing (stale fence); revs unchanged; no duplicate run; no Gate-2 from A | M1-07, SPEC:repair "fence late callbacks" | Critical |
| ADV-CANCEL-06 | Fake process ops report unconfirmed termination | Quarantine row; cancel pending; accept 409; claims blocked; no dismiss route | M1-07 | Critical |
| ADV-CANCEL-07 | Cancel during pending Gate 1, then approve with a valid challenge | Request closed; approve 409; NE | M1-07 | Critical |
| ADV-CANCEL-08 | Cancel unauthenticated / foreign Origin / no CSRF / viewer | 401 / 403; NE; operator needs no `Edward` | SOL §C cancel | High |
| ADV-CANCEL-09 | Recorded pid start time differs | No signal to that pid (process-ops spy) | CLAUDE.md rule 7 | High |
| ADV-CANCEL-10 | Repeated cancel | Single `cancel_requested_at`; idempotent | M1-07 | Low |

### ADV-RESTART — reconciliation (file-backed DB, same artifacts root)

| ID | Attack | Expected | Covers | Sev |
| --- | --- | --- | --- | --- |
| ADV-RESTART-01 | `crash()` after implement launch intent; restart | `interrupted`; runs and implementer calls unchanged; decisions intact | M1-07, M1-08 | Critical |
| ADV-RESTART-02 | Crash after Gate-1 commit, before response; restart | Decision lookup resolves; same key retry → original receipt; OL | M1-08 | Critical |
| ADV-RESTART-03 | Crash while queued (no launch intent); restart | Runs exactly once under the still-valid decision | SOL §E recovery | High |
| ADV-RESTART-04 | Restart | Receipts survive; old challenges and sessions do not | SPEC:decisions | High |
| ADV-RESTART-05 | Gate-2 pending across restart; accept | Fresh challenge required; acceptance survives a later restart | M1-08 | High |
| ADV-RESTART-06 | Pending cancel across restart | Resolved by reconciliation; never `cancelled` without proof | M1-07 | High |
| ADV-RESTART-07 | Held-pipe quarantine across restart | Stays blocking (documented limitation; no auto-release) | SOL §A limitations | Medium |
| ADV-RESTART-08 | Double restart | Reconciliation idempotent; no duplicate rows | M1-08 | Medium |

### ADV-ACCEPT — human acceptance separate from engine `human_ready`

| ID | Attack | Expected | Covers | Sev |
| --- | --- | --- | --- | --- |
| ADV-ACCEPT-01 | Accept a valid result | `managed_tasks.state` stays `human_ready`; acceptance stored only as decision + workspace pointer; request `accepted` | SPEC:outcome, M1-03 | High |
| ADV-ACCEPT-02 | Spawn/adapter counters across accept | `processSpawns` delta 0; adapter calls delta 0; no new `managed_runs` | SPEC:decisions "never executes" | Critical |
| ADV-ACCEPT-03 | Git argv log + fixture refs across accept | No `push`/`merge`/`fetch`/`remote`/`update-ref`/`checkout` on the fixture source; `main`, HEAD and source tree hash unchanged; no network | SPEC:outcome | Critical |
| ADV-ACCEPT-04 | Second accept with a fresh challenge | 409; one acceptance | M1-03 | Critical |
| ADV-ACCEPT-05 | Client-supplied `accepted: true`, synthetic hashes, prototype-store payloads | 400; UI fixtures never become authority | M1-08 | High |
| ADV-ACCEPT-06 | Acceptance used to authorize another execution or repo | Rejected by binding | SOL §C Gate 2 | High |

### ADV-HASH — canonical hashing and the acyclic hash graph

| ID | Attack | Expected | Covers | Sev |
| --- | --- | --- | --- | --- |
| ADV-HASH-01 | Recompute `proposal_hash` from the stored canonical snapshot independently | Equal | SPEC:decisions | High |
| ADV-HASH-02 | Permute key order; change each bound field (repo, base, objective, each criterion, scope, mode, provider profiles, verification plan, context policy, budgets, repair policy) | Order → same hash; every field change → new hash + new version (parametrized) | SPEC:decisions | Critical |
| ADV-HASH-03 | `undefined` vs missing vs `null`; `-0`/`0`; `1`/`1.0`; NaN/Infinity; >2^53 ints; NFC vs NFD; duplicate JSON keys | Deterministic, documented; non-finite and unsafe ints rejected | SPEC:decisions | Medium |
| ADV-HASH-04 | Inspect every stored hashed structure | None contains its own final hash; manifest excludes review; envelope excludes itself | SPEC:decisions "acyclic" | High |
| ADV-HASH-05 | Recompute `execution_binding`; vary seed SHA / context hash / policy hash | Changes binding | SOL §C | High |
| ADV-HASH-06 | Recompute the result envelope; drop any artifact / review hash / verification result / decision id | Mismatch → 409 | SPEC:decisions | Critical |
| ADV-HASH-07 | Two specs whose naive field concatenations collide | Different hashes (structured encoding) | SPEC:decisions | Medium |

### ADV-INPUT — body, method and path confusion

| ID | Attack | Expected | Covers | Sev |
| --- | --- | --- | --- | --- |
| ADV-INPUT-01 | Unknown fields on every mutation | 400 strict; body not echoed | SOL §C | High |
| ADV-INPUT-02 | Body over the limit; malformed JSON; BOM; 10k-deep nesting | 413 / 400; no crash; NE | SOL §C | Medium |
| ADV-INPUT-03 | `__proto__` / `constructor` keys | 400; no prototype pollution | SOL §C | High |
| ADV-INPUT-04 | Id params: traversal, `%2F`, `%2e%2e`, overlong, wrong prefix | 404 | M1-01 | Medium |
| ADV-INPUT-05 | HEAD (Hono maps to GET), OPTIONS, PUT, PATCH, DELETE, `X-HTTP-Method-Override` on every route | Unauth HEAD → 401; others 404/405; never a handler effect | M1-01 | High |
| ADV-INPUT-06 | Trailing slash, `//api/workspace`, `/api/Workspace`, `/api/workspace/../managed/...` | 401/404; never an unauthenticated handler | M1-01 | High |
| ADV-INPUT-07 | Repo id variants (`LOCAL/fixture`, `local/fixture/`, `local/./fixture`, unknown) | 422 `repo_not_allowed` | SPEC:outcome "exactly one repo" | High |
| ADV-INPUT-08 | Scope paths with `..`, absolute, `a//b`; a fixture symlink pointing outside | Rejected at proposal or scope violation at execution | SOL §E isolation | High |

### ADV-OOS — out of the threat model / known limitations (kept visible, never reported as pass)

| ID | Item | Treatment |
| --- | --- | --- |
| ADV-OOS-01 | Privileged attacker rewriting the whole graph coherently (DB + artifact store + decisions) | Not tested as pass; documented per SPEC:evidence |
| ADV-OOS-02 | Attacker controlling hub process memory or storage permissions | Out of scope; documented |
| ADV-OOS-03 | Pipe EOF ≠ termination of an escaped process (C1 limitation) | Observed behavior recorded, labelled limitation |
| ADV-OOS-04 | A credentialed client can forge the typed-name field | Inherent; boundary is the operator credential (SOL §E) |
| ADV-OOS-05 | No OS containment for fixture execution; worktrees are not containment | Not claimed |
| ADV-OOS-06 | Two hub processes on one DB | Unsupported; not tested |

**Row counts:** AUTH 13, ORIGIN 13, CSRF 7, NAME 9, CHAL 13, IDEM 11, RACE 7, INVAL 10, G2 12,
EVID 18, REDACT 14, LIVE 9, LEGACY 9, WS 6, REPAIR 9, CANCEL 10, RESTART 8, ACCEPT 6, HASH 7,
INPUT 8 = **199 attack rows** (many parametrized), plus 6 OOS rows.

## 2. Five-fix reverification plan (against the final integrated diff)

Labels follow `corrective.test.ts` / BASELINE.md; the shared spec numbers the same fixes 1–5 in a
different order (cross-reference column). The existing corrective suite is rerun unchanged as a
**control only** and is never counted as independent evidence. Every attack below uses my own
stub scripts (written via the testkit's `writeStub`-style mechanism into a temp dir), never the
real CLIs; preconditions assert `Bun.which("claude") === null`, `Bun.which("codex") === null` and
no `*_API_KEY`/`*_TOKEN` provider variables in `process.env`.

C1 and C2 are live-adapter behaviors. M1's server-side live hard-off makes them unreachable over
HTTP, so they are exercised at the orchestrator/adapter layer. **Requirement:** the live adapter
constructors and an orchestrator accepting an injected `AdapterSet` remain callable in the final
diff (harness H-9).

| Label | Spec # | Independent execution | Pass | Fail |
| --- | --- | --- | --- | --- |
| **C1** preflight descendant → common `ctx.run` launch guard + settled clean exit | 3 | Own stubs whose `--version`, `--help` and auth-status checks each (a) fork a grandchild inheriting stdout then exit 0, (b) fork via a new session/process group (escapes group kill), (c) close stdout but keep running. Plus an injected adapter that ignores a failed preflight and calls `ctx.run` for implement, and verification commands attempted after the unresolved child. Observe stub call logs, `processSpawns`, quarantine rows, task state; bound each case by a wall-clock limit. | Zero implement/review/verification launches after any unsettled check; quarantine row opened; never `human_ready`; later claims blocked; (c) recorded as limitation ADV-OOS-03 | Any later launch in call logs/spawns; `human_ready`; hub hang beyond bound |
| **C2** protocol loss fails closed; capture truncation distinguished | 4 | Own stubs emitting: failure record of exactly `MAX_LINE_BYTES+1` bytes then success + exit 0; same as an unterminated trailing line at EOF; a record at exactly `MAX_LINE_BYTES` (boundary control); non-JSON line, JSON array line, JSON scalar line, BOM, NUL, CRLF before success; Codex oversized `turn.failed` then approving review + exit 0. Controls: stdout/stderr capture cap exceeded with all records intact must still succeed. | All loss variants → `provider_output_invalid` / no valid review / never `human_ready`; boundary-at-limit and capture-cap controls succeed | Any loss variant reaching review or `human_ready`; a control failing (over-blocking, report as Medium) |
| **C3** diff-prefix multiline redaction (+ omitted-hunk closure) | 2 (+ evidence ¶) | Real `git diff` of fixture commits with new canary shapes (ADV-REDACT-01…13), checked on every surface `S`, including the diff the instrumented fake reviewer received and the envelope. **Positive control:** run ADV-REDACT-01 against the pre-fix `redactDiff` (options in A7, lead approval needed) — it must FAIL there, proving the test detects the gap. | Zero canary hits on all surfaces, or fail closed with SAFE-FAIL; positive control fails on baseline | Any canary fragment on any surface; raw context in failure metadata |
| **C4** FIFO / special files: nonblocking no-follow open + descriptor checks | 1 | `mkfifo` (via `/usr/bin/mkfifo` child) in place of: an artifact (artifact route, Gate-2 validation, envelope build), the omitted-hunk context reader's input if it touches the worktree, and (orchestrator layer, own Codex stub) the last-message scratch file. Concurrent `/healthz` latency probes on a real loopback listener (port 0). Variants: no writer, slow writer, directory, unix socket, symlink. | Each read refused <1 s; `/healthz` p100 <250 ms during attempts; correct 409 / `provider_output_invalid` | Any hang, timeout of the probe, or content read through the special file |
| **C5** artifact bytes bound to full review/candidate/manifest; verified buffer consumed | 5 | Through the **new** workspace artifact route and Gate-2 accept (not only the legacy route): ADV-EVID-01…06, 13, 14, including non-manifest artifacts (`changed-files.json`, `review.log`, `review-output.json`) and post-check replacement via `afterArtifactVerifyBeforeServe` / `beforeAcceptanceCommit`. | 409 + request invalidated + no acceptance for every tamper; served bytes always hash to the verified buffer | Any tampered byte served or accepted; acceptance despite tamper |

Recorded per run: final diff identity (`git rev-parse HEAD`, sha256 of `git diff HEAD` and of the
sorted untracked-file list, at start and end — must be equal), exact commands, pass/fail/not-run
counts per row ID, and environment assertions.

## 3. Legacy-surface audit (current code, read-only)

All entries: **static read** of `agent-city-m1` at `f960055` (+ lead's uncommitted export edits),
2026-10-02. None probed yet; each maps to ADV rows that will probe it.

| # | Location | Bypass / leakage | Lead must (M1B) | Probe |
| --- | --- | --- | --- | --- |
| L-01 | `apps/hub/src/routes/managed.ts:129-139` → `managed/service.ts:182-209` → `managed/store.ts:235-265` | **Run-as-approval**: a bearer token alone queues a task and mints `approval_hash`; no `Edward`, challenge, CSRF, operator identity or decision row | Remove public queueing or require the exact recorded decision | ADV-LEGACY-01/02 |
| L-02 | `packages/schema/src/managed-status.ts:42-44,61-65` (`RUNNABLE_TASK_STATES` includes `interrupted`, `blocked`) | Run re-queues the **same** execution row after interruption (`rerun` attempt) without fresh Gate 1 | Rerun = new execution request + new Gate 1 | ADV-LEGACY-03 |
| L-03 | `routes/managed.ts:104-117`; `service.ts:132-137,188-193`; `managed/worker.ts:13-25`; `orchestrator.ts:680-688` | Legacy draft creation outside immutable proposals; `live` admitted whenever config `liveConfigured`; live CLI adapters built from config | Hard-off live server-side regardless of config; no legacy draft path to execution | ADV-LIVE-05/06, ADV-LEGACY-04 |
| L-04 | `apps/hub/src/managed/orchestrator.ts:621-635` (`approvalHolds`) | Authorization = `approval_hash === approvalHashFor(task)` — any writer that computes the content hash (legacy Run, DB insert) authorizes execution; no decision reference | Claim and every stage launch recheck the decision row (exists, not invalidated, binds proposal/execution hashes) | ADV-LEGACY-07, ADV-INVAL-02 |
| L-05 | `routes/managed.ts:56-75` | Single shared bearer (no identity/scope); Origin checked only if present (`:66-68`) and via any-port `isAllowedOrigin`; GETs unchecked; no CSRF | Operator session + exact Origin + CSRF on all workspace/managed data routes | ADV-AUTH-06, ADV-ORIGIN-01/04 |
| L-06 | `routes/managed.ts:155-169` → `service.ts:321-375`; `managed/evidence.ts:508-560` | Artifacts bearer-only; zero reviews pass vacuously (`service.ts:340-348`); no-manifest runs row-bound only (`:360-374`); `changed-files.json`, `review.log`, `review-output.json` are row-bound only (manifest cross-check covers manifest/diff/verify logs) | Envelope lists every required artifact id/hash/len + canonical review hash; workspace relevance check | ADV-EVID-03/04, ADV-G2-04 |
| L-07 | `routes/managed.ts:91-102,141-151` | Config, task list/detail and cancel are bearer-only | Operator auth + Origin + CSRF (cancel) | ADV-LEGACY-05/06 |
| L-08 | `apps/hub/src/index.ts:94-101`; `routes/ws.ts:4-5,9-14,47-50`; `orchestrator.ts:186-192` (`changed()`, 10 call sites); `service.ts:172,207,215` | `publish("managed", {task_id})` on the single public topic `city`; every managed transition is broadcast (id + timing) to any `/ws` client | Remove managed frames from public `/ws`; authenticated polling (or private channel) | ADV-WS-01/04 |
| L-09 | `apps/hub/src/security.ts:18-19,45-58` (`isAllowedOrigin`), used by `checkWsRequest` `:94-106`, `corsGuard` `:73-91`, managed mutations | Accepts any port on `127.0.0.1`/`localhost`, http **and** https; absent Origin accepted for `/ws` (`:101-103`); CORS echoes any loopback-port origin and allows `authorization, content-type` (`:79-85`). With cookies, other ports are same-site | Exact configured origin for privileged routes; no credentialed CORS for other ports | ADV-ORIGIN-04/10/11, ADV-WS-02 |
| L-10 | `index.ts:57-64` (mount order: `/api/managed` before public `/api`); `routes/api.ts:14-63` | Public unauthenticated `/api` router; a new `/api/workspace` must carry its own auth middleware independent of mount order (HEAD auto-mapped) | Mount authenticated router; never add workspace data to public `/api` | ADV-INPUT-05/06, ADV-WS-03 |
| L-11 | `orchestrator.ts:1000-1012`, `:1311-1319` (repair triggers), `:1036-1071` (`startRepair`) | Repair opens on any actionable finding with no scope classification; repair reuses the same workspace | Classify forbidden repair classes (scope expansion) before repair | ADV-REPAIR-06/07 |
| L-12 | `packages/schema/src/managed.ts:22-23,141-146` | `DEFAULT_REPAIR_LIMIT = 1`, `MAX_REPAIR_LIMIT = 3` vs M1 default 0 / max 1 | Versioned contract delta (role 01) for M1 proposals | ADV-REPAIR-05 |
| L-13 | `apps/hub/src/managed/adapters/cli.ts:383,393-394` | Reviewer diff capped at `REVIEW_DIFF_MAX_CHARS`; incomplete reviewer context not recorded as blocking | Envelope records completeness; Gate 2 blocks incomplete context | ADV-G2-09 |
| L-14 | `apps/hub/src/managed/evidence.ts:321-355` (`writeArtifact`) | Non-atomic file write (no temp + fsync + rename) before the row (fails closed later) | Atomic write per SOL §E | ADV-EVID-18 |
| L-15 | `packages/schema/migrations/006_managed_runs.sql:44,77-78,93-94` | `ON DELETE CASCADE` from `managed_tasks` to runs/artifacts/reviews | New decision/approval rows must not cascade-delete; retention rule | ADV-ACCEPT-01 (row survival) |
| L-16 | `apps/hub/src/managed/demo.ts:46-56` | Non-HTTP Run-as-approval (`submitTask` + `runTask`) in `managed:demo` (part of `bun run verify`) | Keep off the hub; disposable fixture only, or route through M1 decisions | ADV-LEGACY-09 |
| L-17 | `apps/hub/src/managed/api.test.ts:342` | Existing test **asserts** `/ws announces ids only` — it tests for the leak M1 removes | Lead updates this lead-owned test, or the suites contradict | ADV-WS-01 |
| L-18 | `apps/web/src/Tasks.tsx:142,313`; `apps/web/src/useHub.ts:118` | Bearer token in `sessionStorage`; client consumes `managed` frames (cross-reference for 07/09) | HttpOnly session; drop `managed` frame handling | 09 browser suite |

## 4. Harness requirements (lead-owned files; shapes proposed for freeze)

H-1 `createIsolatedHub(opts?: IsolatedHubOptions): Promise<IsolatedHub>`

```ts
interface IsolatedHubOptions {
  dbPath?: string;               // reuse for restart; default temp file in TMPDIR
  clock?: FakeClock;             // drives sessions, challenges, leases, timestamps
  serve?: boolean;               // true → Bun.serve on 127.0.0.1:0 (real HTTP + /ws); false → app.request
  appOrigin?: string;            // exact allowed origin; default http://127.0.0.1:<bound port>
  extraOrigins?: string[];
  liveStubs?: boolean;           // live block enabled against stub executables (prove hard-off)
  operators?: { id: string; scopes: ("read"|"propose"|"approve"|"accept"|"cancel")[] }[];
  adapters?: AdapterSet;         // injected fake/instrumented adapters
  processOps?: ProcessOps;       // fake termination outcomes
  hooks?: Partial<FaultHooks>;
  worker?: "manual" | "auto";    // manual → test drives tick()
  repoFixture?: (repoPath: string) => void; // commit extra fixture files (YAML canaries) before start
}
interface IsolatedHub {
  origin: string; baseUrl: string | null; port: number | null; // port asserted !== 4317
  request(path: string, init?: RequestInit): Promise<Response>;
  login(operatorId?: string): Promise<{ cookie: string; csrf: string; operatorId: string }>;
  db: Database; fixture: { dir: string; repoPath: string; repoId: string; baseSha: string;
    artifactsRoot: string; workspaceRoot: string };
  counters: Counters; bootGeneration(): string;
  tick(): Promise<boolean>; runUntilIdle(maxTicks?: number): Promise<void>;
  restart(): Promise<IsolatedHub>; // graceful: worker stopped, same DB/artifacts/fixture, new boot generation
  crash(): Promise<IsolatedHub>;   // abandon lease + in-memory state without graceful shutdown, then reopen
  wsConnect(o?: { origin?: string | null }): Promise<{ frames: string[]; close(): void }>;
  logs(): string[];                // captured hub stdout/stderr lines
  artifactPath(artifactId: string): string;
  seedLegacyTask(row: Partial<ManagedTaskRow>): string; // v011-style rows, no decisions
  stop(): Promise<void>; cleanup(): void;
}
```

H-2 `Counters`: `providerCalls(): { claude: number; codex: number }` (stub call logs),
`preflightCalls()`, `implementCalls()`, `reviewCalls()` (fake + live adapters),
`processSpawns(): { exe: string; phase: string }[]` (argv[0] basename only, no env values),
`gitInvocations(): string[][]` (via a logging git wrapper configured as `git_executable`).

H-3 `FaultHooks` (all optional, async-capable, no-ops in production builds):
`beforeDecisionCommit({requestId, idempotencyKey})`,
`insideDecisionTx(stage: "after_challenge_consume" | "after_receipt" | "after_transition")` (throw = crash),
`afterDecisionCommitBeforeResponse()` (throw/abort = lost response),
`beforeAcceptanceCommit()`, `afterArtifactVerifyBeforeServe(artifactId)`,
`beforeFinalizeHumanReady(taskId)`, `beforeStage(stage, taskId)`.

H-4 `FakeClock { now(): Date; advance(ms: number): void; set(iso: string): void }` used by the hub,
auth/challenge TTLs, orchestrator leases and heartbeats.

H-5 Two operator identities (full `operator:edward`, read-only `operator:viewer`) with ephemeral
bootstrap credentials generated per test. The spec defines only one operator; "wrong scope"
(ADV-AUTH-07/08, ADV-IDEM-06) is untestable without the second (ambiguity A5).

H-6 Instrumented fake adapters: per-call counters; capture of `ReviewInput.diff` and prompt inputs;
a scripted reviewer (reject with an out-of-scope actionable finding; approve with a chosen
review payload); existing `SimulationScenario` values preserved.

H-7 Frozen error-code enum + status table exported from contracts (e.g. `unauthorized`,
`forbidden_origin`, `csrf_invalid`, `scope_forbidden`, `confirmation_invalid`,
`challenge_invalid`, `challenge_expired`, `challenge_consumed`, `stale_binding`,
`idempotency_conflict`, `not_pending`, `live_disabled`, `artifact_integrity`, `repo_not_allowed`).

H-8 Route manifest: an exported list of every `/api/workspace` (and any surviving `/api/managed`)
method+path, so ADV-AUTH-01/02 and ADV-INPUT-05/06 enumerate them mechanically.

H-9 Orchestrator constructible with an injected `AdapterSet` + `ProcessOps` on the same DB, and
the live adapter constructors (`createClaudeImplementer`, `createCodexReviewer`) still importable,
for C1/C2/C4 at the adapter layer with stub executables.

H-10 Pure helpers to recompute `proposal_hash`, `execution_binding`, result-envelope hash from
stored rows (from `@agent-city/schema/workspace-m1/hash`) for ADV-HASH.

## 5. Environment rules for later execution

- Run only through the isolated runner:
  `/private/tmp/claude-501/-Users-edwardhwang-Desktop-github-repo-only-agent-city/c776e4a4-9f35-42ac-88c3-0ce6997b4382/scratchpad/iso/run.sh bun --no-env-file test apps/hub/test/workspace-m1-adversarial`
  (plus `… run.sh bunx biome check apps/hub/test/workspace-m1-adversarial` and `… run.sh bun run typecheck`).
  Inspect the runner script and each command before running it.
- Disposable `HOME`, `AGENTCITY_HOME`, `TMPDIR` from the runner; temp SQLite files and fixture repos
  under `TMPDIR` only; never `data/`, never a real DB, never `.env` (none is created).
- Loopback only, `127.0.0.1` port 0; every test asserts the bound port ≠ 4317; nothing listens or
  connects to 4317.
- No provider CLIs, network, installs, credentials, or git writes in any checkout; fixture git
  operations happen only inside temp fixture repos. Positive-control baseline export (A7) only with
  lead approval and only into `TMPDIR`.
- Preconditions per file: `Bun.which("claude")` and `Bun.which("codex")` are null; no provider
  API-key variables in env; `LIVE_INTEGRATION_VERIFIED === false`.
- Synthetic secrets built at runtime; failure output redacted; `check:secrets` on the final tree.
- Test files will be `*.adv.test.ts` in this directory (picked up by `bun test`, so also by the root
  suite) and a `REPORT.md` listing pass / fail / not run per row ID with the diff identity.

## 6. Ambiguities to freeze (contracts 01/03/04 + lead)

- **A1** Cancel posted after `human_ready` while a Gate-2 request is pending: no-op, or does it
  invalidate/block the pending request?
- **A2** Does a mismatched challenge use (wrong request/gate/binding/session) consume the challenge?
  Is only one outstanding challenge per request allowed (new mint invalidates old)?
- **A3** Absent `Origin` on mutations (and reads): 403 is assumed; non-browser test clients then
  must send `Origin`.
- **A4** Five-fix labels: spec numbers FIFO=1, diff=2, preflight=3, protocol=4, artifact=5;
  BASELINE/`corrective.test.ts` use C1 preflight, C2 protocol, C3 diff, C4 FIFO, C5 artifact. This
  matrix uses the C-labels.
- **A5** Second (scoped) test-operator identity is required for "wrong scope" tests; the spec
  defines only `operator:edward`.
- **A6** Fate of `/api/managed`: removed vs internal compatibility boundary (SOL §C). ADV-LEGACY rows
  pass under either, but the lead must say which, and what auth any survivor uses.
- **A7** Positive control proving the omitted-hunk test detects the gap. A bare `git archive
  f960055` export cannot resolve `@agent-city/schema` without `node_modules` (no installs allowed).
  Practical options, lead's call: (a) run ADV-REDACT-01 against the unmodified `redactDiff` in this
  tree **before** role 06's change is integrated (the lead controls timing), or (b) export into
  TMPDIR and symlink the checkout's existing `node_modules`.
- **A8** Whether failed decision attempts create receipts (ADV-IDEM-11), and the exact "same
  canonical payload" field set.
- **A9** Gate 2 vs worktree dirtiness after the candidate commit (ADV-G2-10): block or ignore,
  given the envelope binds immutable commit/tree ids.
- **A10** Whether foreign-Origin GETs are rejected (403) or merely denied credentialed CORS.
