# Workspace M1 — isolated run instructions

M1 is a **simulated** workspace: one disposable allowlisted fixture repository, fake providers, no live
calls, no merge/push/deploy. Never point any of this at the real hub on 4317, the real database or `.env`.

## What workspace mode is

The hub runs in workspace mode when `MANAGED_CONFIG` is set **and** both `WORKSPACE_OPERATOR_CREDENTIAL`
and `WORKSPACE_ALLOWED_ORIGIN` are set. Then:

- `/api/workspace/*` (contract `agentcity.workspace-api/v1.1`) is served behind the operator session guard
  (HttpOnly SameSite=Strict cookie, exact Origin, CSRF header, scopes).
- `/api/managed/*` answers **410** — the engine is reachable only through Gate 1.
- Live execution is **forced off** regardless of the trusted config; every engine stage additionally
  requires an approved, still-valid Gate-1 decision (`OrchestratorDeps.authorize`).
- `/ws` carries observed telemetry only (no managed/workspace ids).

Otherwise `/api/workspace` answers 503 `disabled` and the legacy managed API behaves as at the baseline.

## Isolated checks (no `.env`, no real HOME, no provider CLIs on PATH)

Create a runner that clears the environment (example used during M1):

```sh
env -i HOME="$TMP/home" AGENTCITY_HOME="$TMP/agentcity" TMPDIR="$TMP/tmp/" \
  PATH="$TMP/bin:/usr/bin:/bin:/usr/sbin:/sbin" LANG=en_US.UTF-8 TZ=UTC <command>
```

where `$TMP/bin` holds only symlinks to `bun`, `bunx` and `git`. Then, from the repo root:

```sh
bun run lint
bun run typecheck
bun --no-env-file test                      # everything (incl. workspace-m1 module + lead integration tests)
bun --no-env-file test apps/hub/test/workspace-m1-adversarial   # independent adversarial suite (role 08)
bun --no-env-file scripts/check-secrets.ts
bun run build:web
```

Browser suites need the cached Playwright Chromium and, because the runner clears HOME, an explicit path:

```sh
env PLAYWRIGHT_BROWSERS_PATH=$HOME_OF_USER/Library/Caches/ms-playwright \
  bun --no-env-file apps/web/e2e/workspace-m1/<suite>.ts      # independent browser suite (role 09)
```

## The isolated environment harness

`apps/web/e2e/workspace-harness.ts` → `startWorkspaceEnv(options)` starts, in one process:

- a disposable fixture repo with a unique id (`local/m1-fixture-<nonce>`) and a temp SQLite **file**;
- the real hub in workspace mode on a free 127.0.0.1 port (refuses 4317), simulated only;
- a programmatic Vite server (`configFile: false`, empty `envDir`, `cacheDir` under TMPDIR, both
  `__AGENTCITY_WORKSPACE_UI__`/`__AGENTCITY_WORKSPACE_FIXTURE__` defines) whose proxy targets only this hub;
  the hub's exact allowed origin is this Vite origin;
- per-run synthetic credentials returned to the caller (type them into the sign-in field; never print).

`restartHub()` stops the hub, reopens the same DB file and starts a new hub (new boot: sessions and
challenges die, durable state and receipts survive). `stop()` removes everything it created.

## Manual exploration (optional, still isolated)

Only with a disposable managed config pointing at a throwaway fixture repository (see
`apps/hub/src/managed/testkit.ts` for how fixtures are built) and a disposable `DB_PATH`, on a port other
than 4317, with a freshly generated credential exported only in that shell. Do not reuse a real password
and do not put the credential in `.env`. The UI is served by Vite with `WORKSPACE_ALLOWED_ORIGIN` equal to
the Vite origin (the Vite config turns the workspace UI on when that variable is set).

## Restart and migration behaviour

- Migration `008_workspace_approvals.sql` adds exactly four tables (`workspace_tasks`,
  `managed_proposals`, `managed_approval_requests`, `managed_decisions`); no auth table. It is applied by
  `openDb()` like every migration (`PRAGMA user_version` 7 → 8) and never edits 006/007. Workflow rows never
  cascade-delete from managed rows; proposals and decisions are append-only (triggers).
- Sessions and raw challenge tokens are ephemeral (process memory only) and bound to a per-process boot id.
  The challenge's **hash, status, binding, operator, session generation, boot id, request revision and
  expiry are stored in SQLite** on the approval-request row; challenge consumption happens in the same
  transaction as the decision, its receipt and its effects. A restart signs everyone out (new boot,
  sessions gone) and old challenges stop verifying because their boot/session no longer exist — the rows
  are not deleted. Final authority (session liveness, challenge expiry) is evaluated with a clock read
  inside the decision transaction (review finding 3 fix).
- Restart reconciliation (bridge sweep + engine reconcile): queued work proceeds under its durable Gate-1
  decision; an attempt whose model stage was launched becomes interrupted and is never re-run; an unsealed
  engine `human_ready` is sealed once; pending requests stay pending (a new challenge is needed); decision
  receipts survive, so a lost response is recovered by resending the identical decision body.

## Corrective v1.2 additions

- Migrations: `009_accepted_evidence_validity.sql` (bundles table, `evidence_bundle_digest` columns, current
  acceptance validity table with sticky triggers, honest `unverifiable` backfill for earlier acceptances) and
  `010_proposal_contract_v1_2.sql` (rebuilds `managed_proposals` only, widening the contract CHECK to v1 | v1.2;
  rows copied verbatim, triggers re-created verbatim). `PRAGMA user_version` 8 → 10.
- Durable evidence: `<artifacts_root>/_sealed/<digest>.bundle` (dir 0700, files 0600), written only by the hub's
  bridge at Gate-2 opening; never edit or delete these files — accepted results are served from them, and a
  missing/corrupt bundle makes the current acceptance `invalid`.
- Current validity re-checks (periodic, no filesystem monitoring, no guaranteed detection deadline): bridge
  sweep at startup and every 30 s, at most 20 accepted results per sweep, oldest check first — N eligible
  results take about ceil(N/20) sweeps plus queue and check time; task-detail read when the last check is older
  than 5 s (the route awaits the check); snapshot / list reads never check and show the stored row with its
  `checked_at`. For a fresh verdict on one result, open its task detail.
- Publishing a proposal requires every acceptance criterion to be mapped to at least one trusted verification
  check (`criterion_checks` in the draft); legacy v1 proposals cannot be approved, rerun or accepted (a pending v1 Gate 1 is invalidated by the first challenge/decision attempt or the next bridge sweep; an approved v1 execution is stopped before its next stage) — publish a new version.

## Local preview of the integrated UI (campus milestone)

One command starts a real, isolated hub plus the workspace UI for a person to click through (same harness and
isolation as the browser suites; nothing touches 4317, `data/`, `.env`, `apps/web/vite.config.ts` or a real HOME):

```sh
<isolated runner> bun --no-env-file apps/web/src/workspace-m1/dev/preview-hub.ts
```

It prints the UI URL (`http://127.0.0.1:<free port>`), the hub URL (another free loopback port, never 4317), the
disposable repository id (`local/m1-fixture-<nonce>`), the temp SQLite path and the path of a 0600 file holding
this run's synthetic operator credential (never printed; paste it into the sign-in field). Fake providers only,
live execution forced off, results labelled simulated. Assign work on the repository, publish, then open the
document from the campus strip, the Headquarters button or the inbox and sign each gate by typing `Edward`.
Ctrl-C stops Vite and the hub and deletes the fixture repository, database, Vite cache and credential file.
The campus alone against a UI fixture (no hub) is `campus/dev/preview.html`, which `campus/dev/shots.ts` renders for
screenshots only.
