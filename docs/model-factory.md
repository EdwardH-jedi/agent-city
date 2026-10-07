# Model Factory foundation (dry run)

Agent City routes work by **durable role and capability**, never by today's model names. A workflow
asks for a role (`clerk`, `implementer`, `reviewer`, `decision`) and a minimum capability tier
(`fast < standard < senior < principal`, plus the off-scale `specialist`); trusted configuration
decides which worker profile — and so which provider/model — serves it.

```
input (support job | implementation task)
  → Decision Fabric TASK_ROUTE   provider recommendation (advisory)
  → deterministic policy         floors and human-only flags override the provider
  → capability tier              canonical Worker Profile tier, or HUMAN
  → Worker Profile Registry      exact resolution or first eligible enabled profile
  → profile RECOMMENDATION       nothing is launched, queued, assigned or approved
```

**Nothing here grants authority.** Gate 1 / Gate 2, the operator session, CSRF / Origin checks,
challenge and revision binding, idempotent receipts and the transaction-time checks are untouched.
Live execution is still decided only by `live.enabled` in the managed config; worker profiles do not
build an adapter, start a process or call a provider.

## Pieces

| Area | Code | Doc |
| --- | --- | --- |
| Worker profiles (schema) | `packages/schema/src/worker-profiles.ts` | comments; `config/managed.example.yaml` |
| Profile registry + config | `apps/hub/src/managed/worker-profile-registry.ts`, `managed/config.ts` (`worker_profiles`) | — |
| Decision Fabric | `apps/hub/src/decision-fabric/` | [decision-fabric.md](decision-fabric.md) |
| Support Lane | `apps/hub/src/support-jobs/` | [support-lane.md](support-lane.md) |
| Composition (dry run) | `apps/hub/src/model-factory/` | this file |

## Composition (`apps/hub/src/model-factory/`)

- `dryRunSupportRoute(job, scope)` — a QUEUED support job → TASK_ROUTE (its change facts are
  constant and all false: support jobs cannot mutate) → a **read-only clerk**. The job's capability is
  a floor the fabric can raise, never lower.
- `dryRunTaskRoute(change, scope, min_capability?, profile_id?)` — an implementation task with
  trusted change facts → TASK_ROUTE → an **implementer with a worktree**. Policy floors apply:
  auth / authorization / security / DB migration ≥ SENIOR; deploy / credentials / remote delivery →
  a person (no profile lookup); low confidence is raised to SENIOR. The request is read **once**,
  inside a guard: that plain snapshot is what the fabric hashes and the policy enforces, and it is
  returned as `change`. Unreadable or invalid facts, scope, `min_capability` or `profile_id` fail
  closed (`INPUT_INVALID`, no provider call, `change: null`) — never replaced by all-false facts.
- `planSupportLaunches(jobs)` — the support scheduler (concurrency 4, running jobs hold slots,
  cancelled / disabled jobs never start, priority → created_seq → id) × routing × profile
  `max_concurrency`. Jobs without a usable profile are **held** and free their slot; at most 64 jobs
  are routed per plan.

Fail-closed everywhere: an unknown, disabled, unfit or wrong-role profile is reported as such and is
never replaced by another one; there is no fallback model and no "run anyway".

Integration cases A–E are pinned by `model-factory/factory-cases.test.ts`: (A) HANDOFF → FAST → fast
clerk; (B) plain source change → implementer; (C) auth / security task recommended FAST → SENIOR
implementer; (D) reviewer REJECT + READY_FOR_HUMAN → not ready; (E) missing / disabled worker → no
profile, no fallback.

## Approval binding (`policyHash`)

Only **enabled** worker profiles are part of `policyHash` (sorted by `profile_id`). A disabled profile
can never be resolved, so adding or editing one voids no approval; a config without profiles, or with
only disabled ones, hashes exactly as before profiles existed. Enabling, disabling or changing an
enabled profile changes the hash (and so voids approvals bound to the old configuration).

## Not built yet (next deltas)

| Item | Exact next change |
| --- | --- |
| Support persistence / API | **Built** (`apps/hub/src/support-lane-api/`, migration 011; docs/support-lane.md "Persistence and API"): store + create / get / list / cancel routes behind the workspace guard; no route starts a job or a managed run. Next: a read-only executor launch path wired to `transition`. |
| Workspace routing projection | a read-only "routing recommendation" next to a draft (`dryRunTaskRoute` output). Putting a profile into the Gate 1 proposal changes the hashed proposal snapshot, so it needs a new proposal contract version — never a silent change to v1 / v1.2. |
| Jev decision provider | a `DecisionProvider` over an injected transport, disabled by default; the fabric already validates kind, choice set, confidence bounds, input hash, provider id and timeouts and stores no reasoning. |
| Profile-aware adapters | `createAdapters(cfg)` builds the Claude / Codex adapters from `live.*`; the next step is building them from a resolved implementer / reviewer profile (`model` from the profile), still gated by `live.enabled`, with no automatic fallback. OpenAI CLI/API flags and auth are not assumed. |
| Support executor | `runSupportJob` exists with a fake executor; a real executor needs a read-only worker launch path through `managed/proc.ts`. |
