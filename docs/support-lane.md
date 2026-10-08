# Support Lane (read-only core)

A lightweight lane for high-volume, read-only work — repo status, handoffs, log triage, evidence
summaries, review → TODOs, PR draft text, context packages — that fast models (Haiku-class,
lightweight OpenAI, local models) can take on later **without** entering the managed
implementation → verification → Codex review → Gate 2 pipeline.

Code: `apps/hub/src/support-jobs/` is the pure core: **no model call, no DB, no HTTP route, no UI, no
Git mutation** (its isolation test enforces it). Persistence and the read-only API live beside it in
`apps/hub/src/support-lane-api/` (see "Persistence and API"); a real executor is a later step.

## Contract

| Module | What it owns |
| --- | --- |
| `vocabulary.ts` | Capability = canonical `WorkerCapabilityTier` narrowed to `fast` / `standard`; `profile_id` = canonical `WorkerProfileId` (both from `@agent-city/schema`) |
| `job.ts` | `SupportJob` / `SupportJobRequest` (zod `strictObject`, every string/array bounded), typed input refs, `createSupportJob` |
| `state.ts` | State machine and lifecycle helpers (start, cancel intent, complete, fail, assign profile) |
| `artifact.ts` | Strict per-kind artifact bodies and `validateExecutorOutput` |
| `executor.ts` | `SupportExecutor` interface and `runSupportJob` |
| `scheduler.ts` | Pure `selectSupportJobs` |
| `fake-executor.ts` | Deterministic executor for tests |

A job carries no authority: no shell command, argv, writable path, push / merge / deploy, or
credential field exists, and unknown keys are rejected. Inputs are typed references
(`{kind: "commit" | "run" | "artifact" | "review" | "log" | "session", id}`) with bounded ids that
cannot be paths. The capability is abstract; `profile_id` stays null until a future router assigns
one (`assignSupportProfile`, QUEUED only).

Public boundaries never throw on hostile input: `createSupportJob`, `parseSupportJob`, every state
transition and `runSupportJob` parse through `parseGuarded` (`guards.ts`), so a throwing getter or
Proxy trap becomes a classified result (`(root):unreadable`, `null`, `invalid_job`, `invariant`) and the
parsed job is a plain copy read once. An executor rejection whose `name` / `message` cannot be read
still settles FAILED / `EXECUTOR_ERROR` with the fixed detail `executor error not readable`;
cancellation still takes precedence and no artifact is kept.

## States

```
QUEUED  → RUNNING | CANCELLED
RUNNING → COMPLETED | FAILED | CANCELLED
COMPLETED, FAILED, CANCELLED: terminal (a retry is a new job)
```

Upper-case on purpose — no value is shared with the managed task states, and the transition
function rejects anything outside its own enum (`unknown_state`). Cancelling a QUEUED job cancels
it at once; cancelling a RUNNING job sets `cancel_requested`, and the job settles CANCELLED with its
output discarded.

## Executor output

`runSupportJob` hands the executor a deep-frozen copy of the job's read-only fields and validates
whatever comes back. The result is either an informational artifact (job COMPLETED, `result`
metadata set) or a FAILED job with a classification:

| Class | Cause |
| --- | --- |
| `FORBIDDEN_AUTHORITY` | any action / command / approval / state / publication / credential key, at any depth |
| `INVALID_OUTPUT` | not a strict body, too large / deep, unreadable (throwing getter / proxy) |
| `KIND_MISMATCH` | valid body of a different kind |
| `OUTPUT_SECRET` | artifact text matches a secret pattern (`secret-patterns.ts`) |
| `EXECUTOR_ERROR` | the executor threw (detail redacted and clipped) |

There are no callbacks or events: the only effect of a run is the returned data.

## Scheduler

Pure and synchronous — no timers, no I/O, no polling loop; the caller starts the returned jobs.

- Eligible: `QUEUED`, not `disabled`, no `cancel_requested`.
- Capacity: `concurrency` (default **4**, int 1..16). Every RUNNING job takes a slot, including
  cancel-requested ones. Launch ≤ min(free slots, hard cap 16).
- Order: **priority desc → created_seq asc → id asc** (UTF-16 code units). This is a total order
  (duplicate ids throw), so any permutation of the same input gives the same result.
- Optional `max_per_repo` (int 1..16): caps RUNNING + launched jobs per repo (case-insensitive
  `repoKey`); the skipped slot goes to the next eligible job.
- Input is never mutated; snapshots over 10 000 jobs throw.

## Persistence and API

`apps/hub/src/support-lane-api/` — still no executor, no model call, no Git, no managed task, no proposal and no
Gate authority.

- **Migration 011** (`packages/schema/migrations/011_support_jobs.sql`, hub-level; the workspace helper stays at
  version 10): one `support_jobs` row per job, columns mirroring `SupportJob` plus `created_by`,
  `idempotency_key`, `request_hash`, `updated_at`, `rev`. Triggers: a new row is QUEUED at rev 1; rows are never
  deleted; a terminal job never changes; every update bumps `rev` by exactly 1; request columns are immutable;
  status moves only along the state machine; a profile is set once, while QUEUED; cancellation is never withdrawn.
- **Store** (`store.ts`): `create` (one immediate transaction: identity `sj-<uuid>`, `created_seq` = max + 1,
  idempotent per `(created_by, idempotency_key)` over a canonical hash of the request — replay or
  `idempotency_conflict`), `get`, `list` (newest first, keyset on `created_seq`, filters repository / status,
  ≤ 100 per page), `cancel` and `transition` (one state-machine step under a `rev` compare-and-swap). Every row read
  is re-validated with `parseSupportJob`; a row that does not validate is an integrity error, never a job. The flag
  columns (`disabled`, `cancel_requested`) decode only from 0 / 1 (`decodeStoredFlag`) — any other stored value is
  an integrity error, so damage can neither serve a job nor let a transition settle it. The lookup columns are held
  to their column contract (SQLite `length()` semantics — a value holding a NUL is never well-formed), and the stored `request_hash` must equal the hash of the request the row decodes to — a
  malformed hash or a request column that drifted from it is an integrity error on every path, including an
  idempotent replay (which decodes the prior row before comparing).
  `transition` (start / complete / fail / profile) is store-level only — no route exposes it.
- **Repository scope**: every route uses the CURRENT managed allowlist (a boot-time config snapshot), not the one a
  job was created under. Outside it: create and a repo-filtered list → 422 `repo_not_allowed`; `GET` / cancel of a
  job → 404 like an unknown id (checked before the `rev` compare); the unfiltered list leaves the job out. Rows are
  never deleted — allowing the repository again shows them again (read-only).
- **Routes** (`router.ts`), inside `/api/workspace` after the workspace guard (session; GET needs
  `workspace:read`; every other method the exact Origin, CSRF and `workspace:decide`), before the workspace
  router; every response is schema-validated and `no-store`:

  | Route | Answer |
  | --- | --- |
  | `GET /support-jobs?repo_id&status&limit&cursor` | `SupportJobPage` (`total`, `has_more`, `next_cursor` bound to its scope — any other scope → 400) |
  | `GET /support-jobs/:id` | `SupportJobView` (`job`, `rev`, `updated_at`) or 404 |
  | `POST /support-jobs {idempotency_key, job}` | 201 created / 200 replay / 409 `idempotency_conflict`; 422 `repo_not_allowed` outside the managed allowlist |
  | `POST /support-jobs/:id/cancel {expected_rev}` | cancellation intent; 409 `stale_binding` / `invalid_state` |
