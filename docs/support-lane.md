# Support Lane (read-only core)

A lightweight lane for high-volume, read-only work — repo status, handoffs, log triage, evidence
summaries, review → TODOs, PR draft text, context packages — that fast models (Haiku-class,
lightweight OpenAI, local models) can take on later **without** entering the managed
implementation → verification → Codex review → Gate 2 pipeline.

Code: `apps/hub/src/support-jobs/`. This is the pure core only: **no model call, no DB, no HTTP
route, no UI, no Git mutation.** Wiring a real executor, persistence and an API are later steps.

## Contract

| Module | What it owns |
| --- | --- |
| `vocabulary.ts` | Capability (`FAST` / `STANDARD`) and `profile_id` shape — the single swap point for the canonical Worker Profile types |
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
