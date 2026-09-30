# Managed runs (v0.1) — runbook and handoff

A **managed run** is an explicit, authorized attempt at a bounded task in one allowed local
repository. Agent City owns its input, workspace, provider invocation, evidence and review, and ends
with something a person can inspect. It is single-machine, single-user, single-worker, one task at a
time.

Three things that must not be confused:

| | What it is | Where it lives |
| --- | --- | --- |
| Observed session | A Claude/Codex session a collector saw. Idle/ended says nothing about the work. | `sessions`, `events` (unchanged) |
| Managed run | A task attempt Agent City started and tracked. | `managed_*` tables |
| Simulated run | A managed run with fake adapters. Always labelled simulated. | `execution_mode = simulated` |

## Status — read this first

| Part | Status |
| --- | --- |
| Contracts, migration 006, state machine, fenced store | implemented, tested |
| Worktree lifecycle, candidate checkpoint, evidence manifest | implemented, tested on fixture repos |
| Orchestrator (implement → verify → review → ≤1 repair) | implemented, tested with **fake** adapters |
| Claude CLI implementer | implemented, **stub-tested**; flags checked against `claude --help` 2.1.285; **not live-tested** |
| Codex CLI reviewer | implemented, **stub-tested**; flags taken from the docs only (`codex` is not installed here); **not live-tested** |
| API + web UI | implemented; API tested; UI exercised by hand in a browser with a simulated task |
| Live end-to-end run with real models | **never run**. `LIVE_INTEGRATION_VERIFIED` is `false`. |

Nothing in this document or the code should be read as "the live pipeline works". Only simulated
runs and stub executables have been exercised.

## Try it (simulated, no model)

```sh
bun run managed:demo            # 8 scenarios on a throwaway repo; prints outcomes; leaves nothing
```

With the web UI:

```sh
bun run managed:demo --init     # fixture repo + managed.yaml under ~/.agentcity/managed-demo
# add to .env yourself:
#   MANAGED_CONFIG=~/.agentcity/managed-demo/managed.yaml
#   MANAGED_TOKEN=<openssl rand -hex 32>
bun run dev                     # hub + web
```

Open the web UI → **Managed tasks** → paste the token → fill the form (mode *simulated*, pick a
scenario) → **Create draft** → **Approve & run**. The task list and detail update live and survive a
refresh or a hub restart. The **Observed sessions** tab is the existing telemetry view.

Scenarios: `approve`, `reject_then_approve`, `reject_always`, `malformed_review`, `reviewer_error`,
`review_wrong_candidate`, `reviewer_mutates`, `verification_fails`, `verification_fails_then_fixed`,
`no_changes`, `out_of_scope`, `impl_hangs` (use Cancel).

## Configuration

`MANAGED_CONFIG` names a YAML file you write (template: `config/managed.example.yaml`). It is the
only source of anything that becomes a process: allowed repos, verification argv arrays, provider
executables. Keep it outside the repo. Changing it after a task was approved voids that approval.

Do not list the Agent City checkout you are developing in. Use a disposable or sandbox repository.

## How a task moves

```
draft ──Run──▶ queued ──▶ executing ──▶ verifying ──▶ reviewing ──▶ human_ready
                              ▲             │             │
                              └─ repairing ◀┴─────────────┘   (at most repair_limit times, default 1)
any active state ──▶ failed | blocked | cancelled | interrupted
interrupted / blocked ──Run──▶ queued (a new attempt in a fresh worktree)
```

- **Run** is the approval. It stores a hash of the task content + base commit + policy; the worker
  re-checks it before doing anything (`approval_void` if it no longer matches).
- **executing / repairing**: the implementer works in an owned worktree
  (`<workspace_root>/<task>/<attempt>`, branch `agentcity/<task>/<attempt>`). Everything it leaves is
  checkpointed as one candidate commit. No change → `no_changes`. A path outside `approved_scope` →
  `scope_violation`.
- **verifying**: the repo's trusted commands run in the worktree. Evidence (diff, changed files,
  logs, manifest) is stored and hashed. No commands → `verification_missing` (blocked). A command
  that did not run to completion → `verification_unavailable` (blocked). Non-zero exit → repair, or
  `verification_failed`.
- **reviewing**: the reviewer gets the candidate SHA and the manifest hash. Its verdict counts only
  if it matches the `agentcity.review/v1` schema, names that exact SHA and manifest, says
  `tests_executed: false`, and left the workspace untouched. Anything else → `review_invalid` /
  `candidate_mutated`.
- **human_ready**: verification passed and a valid approval exists for the final candidate. Nothing
  is merged or pushed. The detail view re-checks the workspace on every read and shows *stale* if it
  changed afterwards.
- `blocked` = the tool could not run (auth, quota, missing executable, missing verification).
  `failed` = it ran and did not pass. `interrupted` = the hub stopped mid-stage; needs a person.

A model saying "done" is never the evidence; the candidate commit, the verification exit codes and
the bound review are.

## Recovery and cancellation

- Every worker write carries a fencing token. A worker whose lease was taken over can write nothing.
- The launch intent of an implement/review stage is persisted before the adapter is called. After a
  crash, such an attempt becomes `unknown` and the task `interrupted`. **It is never relaunched
  automatically** — only an explicit Run starts a new attempt (fresh worktree; the old one is kept).
- A crash before any model stage, or during verification, is resumed automatically, at most
  `max_infra_retries` (2) times.
- An orphaned child from a previous hub process is terminated only if its pid still has the recorded
  start time. If termination cannot be confirmed, the task is `interrupted`, not `cancelled`.
- Cancel persists an intent. The task becomes `cancelled` only after the child's process group is
  confirmed gone (SIGTERM → grace → SIGKILL).
- This is at-most-once *acceptance* of a result per attempt, not exactly-once execution: a provider
  process may have done work whose result was never recorded.

## Security and host access

- **A worktree is Git isolation, not a sandbox.** The implementer and the verification commands run
  as your user with your filesystem and network access. The Claude adapter limits built-in tools to
  the configured list (default: no Bash) and uses `acceptEdits` with prompts denied; that is the
  CLI's own permission system, not an OS boundary. `docs/ARCHITECTURE.md` #7 (dedicated OS user +
  dedicated clone) is **not** implemented in v0.1.
- Worktrees are created from your configured repository, so managed branches (`agentcity/...`) appear
  in that repository's refs. Your checkout's files and HEAD are not touched. Worktrees and artifacts
  are preserved; clean them up yourself (`git worktree remove`, `git branch -D`).
- No push, PR, merge, deploy or GitHub write exists anywhere in this code.
- `/api/managed` needs `Bearer $MANAGED_TOKEN` on every route. Mutations need a JSON content type
  and an allowed `Origin`. The token is pasted into the UI and kept in `sessionStorage`. `/ws`
  broadcasts only a task id.
- Child processes get an allowlisted environment (`PATH`, `HOME`, locale, `TMPDIR`…). API keys and
  hub tokens are not inherited, so a CLI cannot silently fall back to metered API billing.
- Artifacts are read by `(task id, artifact id)`; the stored path is canonicalized and must be a
  regular file under `artifacts_root`.
- Stored text: the task's title/objective/criteria (redacted), review findings and summaries
  (redacted), redacted bounded logs and diffs. Not stored: provider transcripts, tool input, model
  reasoning — adapter logs keep event kinds, tool names and the final result text only.
- Known gaps: redaction is pattern-based (see README); a secret the implementer writes into a file
  is in the candidate commit even though the stored diff is redacted; verification commands are
  whatever you configured and run unsandboxed; with a running Claude collector hook, a live managed
  Claude session is also *observed* like any other session.

## Enabling a one-task live smoke (a person does this, deliberately)

Not done as part of this work. When you decide to:

1. Check billing and auth yourself: `claude auth status`, and that Codex is installed and logged in.
   Live runs use your subscription quota. Agent City never passes API keys to the CLIs and never
   uses `--bare`, a fallback model, or a permission bypass.
2. In your managed config (a sandbox repo, not a real project): set `live.enabled: true` and fill
   the `claude` and `codex` blocks with absolute executable paths and models.
3. `bun run managed:preflight` — executable, version and login checks; it calls no model. Fix
   whatever it reports as BLOCKED.
4. Restart the hub, create **one** small task with mode *live*, approve it, and watch it.
5. Compare what happened with the assumptions below. Only after that, and only if it held, set
   `LIVE_INTEGRATION_VERIFIED` to `true` in `packages/schema/src/managed.ts`.

Unverified assumptions a live smoke must check:

- Claude: the `stream-json` field names used (`system/init.session_id|model`,
  `result.subtype|is_error|result|structured_output|usage|modelUsage|total_cost_usd`); that
  `--json-schema` yields `structured_output` with `stream-json`; that `--tools` + `--allowedTools`
  with `acceptEdits` and `--permission-prompts none` is enough to edit files unattended; that
  `--resume <id>` keeps the session id; that `claude auth status --json` makes no model request.
- Codex: every flag (`exec --json --sandbox read-only --cd --output-schema --output-last-message -`,
  `exec resume <id>`), the JSONL event names, `codex login status`, and whether the strict JSON
  Schema is accepted. None of it has been run against a real binary.
- Failure classification (auth / quota / model) is a text heuristic on top of structured categories.

## Verification

```sh
bun test            # includes apps/hub/src/managed/*.test.ts and apps/web/src/managed-view.test.ts
bun run lint
bun run typecheck
bun run check:secrets
(cd apps/web && bunx vite build)
bun run managed:demo
```

Where the required gates are tested:

| Gate | Test |
| --- | --- |
| Happy path, repair loop, repair limit | `managed/orchestrator.test.ts` |
| Failed / missing verification, malformed review never approve | `managed/orchestrator.test.ts` |
| Candidate / workspace mutation invalidates a review | `managed/orchestrator.test.ts`, `managed/adapters.test.ts` |
| Duplicate submissions and claims | `managed/orchestrator.test.ts`, `managed/api.test.ts` |
| Restart, missing acknowledgement, stale worker | `managed/recovery.test.ts` |
| Cancellation + termination of owned child processes | `managed/recovery.test.ts`, `managed/proc.test.ts` |
| Missing executable / auth, timeout, truncated output | `managed/adapters.test.ts`, `managed/proc.test.ts` |
| Rejected repo, path traversal, artifact access | `managed/api.test.ts`, `managed/orchestrator.test.ts` |
| Telemetry / redaction intact | existing suites + `managed/api.test.ts` |
| Zero real model calls by default | `managed/recovery.test.ts` |

## Not in v0.1

3D city, meetings, cross-repo scheduling, distributed workers, task discovery, an API-based planner,
GitHub writes, automatic merge/deploy, OS-level isolation, worktree garbage collection, more than
one active task, reviewer session continuation (implemented in the adapter, unused by the
orchestrator), an automated browser test of the UI.
