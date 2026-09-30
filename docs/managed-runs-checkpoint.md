# Managed runs v0.1 — checkpoint

Single progress file for the v0.1 managed implementation/review pipeline. Resume from here plus the
actual Git state (`git log`, `git status`), never from memory.

## Baseline

- Worktree `../agent-city-v01`, branch `feat/managed-runs-v0.1`, branched from `429a08b`
  (`phase1/event-normalization`: the referenced `da12be6` + one docs commit adding
  `docs/ARCHITECTURE.md` and `docs/hook-events.md` — compatible, docs only).
- Why a separate worktree: a `bun --watch` hub was running from the main checkout against the
  user's real DB; a new migration there would have been applied to it mid-development.
- Baseline checks at `429a08b`: `bun test` 345 pass / 0 fail, `bun run lint` ok,
  `bun run typecheck` ok, `bun run check:secrets` ok, `vite build` ok. **No pre-existing failures.**
- No existing script invokes a model. `codex` is **not installed** on this machine; `claude` is
  2.1.285.

## Design decisions

1. Observed sessions (telemetry tables) are untouched. Managed runs live in new `managed_*` tables
   (migration 006) with their own state machine (`packages/schema/src/managed-status.ts`).
2. Vocabulary follows `docs/ARCHITECTURE.md`: run state `{running, finished, failed, cancelled,
   unknown}` (#3), lease + heartbeat + fencing token, `cancel_requested → terminated → cancelled`,
   never re-run an implement stage automatically (#6), verdict carries `audited_sha` (#8),
   environment/quota/auth problems are blockers, not failures (#8).
3. **Divergence from ARCHITECTURE #7** (dedicated OS user + dedicated clone): v0.1 uses a Git
   worktree of the configured repo, as the assignment asks. It is Git isolation, not a sandbox.
4. Task lifecycle: `draft → queued` needs an explicit Run action that stores an approval hash
   (task content + base sha + policy hash, ARCHITECTURE #5); it is re-verified at claim time.
5. Config is a trusted local YAML file (`MANAGED_CONFIG`): allowed repos, verification argv arrays,
   executables. Nothing from a task, repo file or review finding becomes a command.
6. All `/api/managed` routes need `MANAGED_TOKEN` (bearer). Mutations also need
   `content-type: application/json` and an allowed `Origin` when one is sent.
7. Live adapters (Claude implement, Codex review) exist but are off unless `live.enabled: true` in
   the config **and** a provider block is configured. Tests use stub executables only.
8. Crash recovery: an expired lease is reconciled (fence first, then stop leftovers). If a model process had been launched
   (`proc_phase` implement/review) the attempt becomes `unknown` and the task `interrupted`; only a
   person can re-run it. Pre-launch and verification phases are retried at most 2 times.
9. User-authored task text (title, objective, acceptance criteria) is stored after `redact()`.
   This is a narrow exception to "prompt text is never stored", which still holds for passive
   collection (AGENTS.md rule 3).

## Checkpoints

- [x] A. Baseline, checkpoint file
- [x] B. Contracts + migration 006 + store
- [x] C. Process boundary, worktree + evidence
- [x] D. Orchestrator + fake adapters + deterministic loop
- [x] E. Claude / Codex CLI adapters + stub-executable tests
- [x] F. API + UI
- [x] G. Fault-injection gates, docs, handoff (runbook: docs/managed-runs.md)

## Verification commands

```sh
bun test && bun run lint && bun run typecheck && bun run check:secrets
(cd apps/web && bunx vite build)
```

## Remaining / next

- Live smoke (one task, by a person) — see docs/managed-runs.md "Enabling a one-task live smoke".
  Until then `LIVE_INTEGRATION_VERIFIED` stays false.
- Not done: OS-level isolation (ARCHITECTURE #7), worktree cleanup, automated browser test of the UI.

## Blockers

- Live model runs: not attempted (out of scope for this assignment; Codex CLI not installed).
