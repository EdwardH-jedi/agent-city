# Agent City

A local telemetry dashboard for Claude Code and Codex sessions, with read-only GitHub repository
status — plus, on this branch, an opt-in **managed task pipeline** for one allowed local repository.
Collectors feed redacted events to a Bun/SQLite hub; a React 2D view shows repositories, live
sessions, the event stream, and managed tasks.

**Current status.** The data layer and 2D inspection view are implemented. Collection covers the
machines and supported session events you configure. The managed pipeline (v0.1.1) can create an
isolated worktree, run an implementation, run trusted verification, review the exact candidate and
stop at a result a person inspects — **tested only with deterministic fake adapters and generated
stub executables**. It is off by default; live Claude/Codex execution is disabled and has never been
verified end to end; there is no OS-level sandbox. The 3D city is future work.

Decisions and their order: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Managed runs:
[docs/managed-runs.md](docs/managed-runs.md).

[Quick start](#quick-start-cockpit) · [Checks](#development-and-checks) ·
[Environment](#environment) · [Security](#security-model) · [Roadmap](#roadmap)

## Implemented features

- Claude Code hooks and a Codex log tailer, with local spooling during outages
- Shared event schemas, session/agent IDs, redaction, and status transitions
- A Hono hub with SQLite storage, ingest, REST reads, WebSocket updates, and stale-session handling
- Read-only GitHub repository/CI sync, rate-limit handling, ETag caching, and local checkout mapping
- A flat React UI for inspecting repositories, sessions, and events
- Machine roles and SSH-tunnel setup for collectors on separate hosts
- Managed tasks (opt-in, `MANAGED_CONFIG`): versioned task/run/evidence/review records, approval
  binding, fenced single-worker execution, worktree isolation, candidate-bound evidence, bounded
  repair, quarantine of unresolved child processes, token-protected API and a *Managed tasks* tab

## Architecture and repository map

```text
Claude hook / Codex tailer
  → redact → POST /ingest (or local spool while offline)
  → SQLite → /api + /ws → React 2D view
GitHub (read-only) → repository / CI sync → SQLite
Managed task (explicit Run) → worktree → implement → verify → review → result   [opt-in]
```

| Path | Responsibility |
|---|---|
| `apps/collector/` | Claude hook launcher, Codex tailer, config, redaction integration, and spool |
| `apps/hub/` | Hono + `bun:sqlite`, `/healthz`, `/ingest`, `/api/*`, `/ws`, GitHub sync, stale sweep |
| `apps/hub/src/managed/` | Managed runs: orchestrator, worktrees, evidence, process boundary, CLI adapters |
| `apps/web/` | Vite + React 2D view, *Managed tasks* tab; `e2e/` browser regression gate |
| `packages/schema/` | Zod types, status machines, IDs, redaction, secret patterns, SQL migrations |
| `config/` | `districts.yaml` (repo → district), `managed.example.yaml` |
| `scripts/` | Secret scanning, documentation parity, golden-event helpers |

## Machines

| Role      | What it does                                                                |
| --------- | --------------------------------------------------------------------------- |
| `cockpit` | Where I sit. Runs the hub + web view, and a collector for local sessions.   |
| `forge`   | Heavy build/agent box. Runs a collector that ships events to the hub.       |
| `spine`   | Always-on box. Runs a collector (and later can host the hub / GitHub sync). |

Set the role per machine with `AGENTCITY_MACHINE`.

## Quick start (cockpit)

Requires [Bun](https://bun.sh) and Git. For GitHub sync, configure a token with the read
permissions described below, or use an existing `gh` CLI login.

```sh
git clone https://github.com/EdwardH-jedi/agent-city.git
cd agent-city
bun install
cp .env.example .env         # fill in secrets by hand (see Environment)
bun run sync:github          # first GitHub sync → prints a summary
bun run dev                  # hub :4317 + web :5173  (or dev:hub / dev:web separately)
```

Open http://127.0.0.1:5173. Set `INGEST_TOKEN` in `.env` before collecting events; an unset token
disables ingest. Keep the hub on loopback. Read the [security model](#security-model) before
changing its bind address. Managed tasks stay off until you set `MANAGED_CONFIG` and
`MANAGED_TOKEN` (see [Managed runs](#managed-runs-v011)).

Collectors on cockpit:

```sh
bun run collector:hooks      # prints a merged ~/.claude/settings.json + diff — never writes ~/.claude
# review, back up, apply by hand (the command prints these):
#   diff -u ~/.claude/settings.json ~/.agentcity/claude-settings.merged.json
#   cp ~/.claude/settings.json ~/.claude/settings.json.bak.$(date +%s)
#   cp ~/.agentcity/claude-settings.merged.json ~/.claude/settings.json
bun run collector:codex      # resident Codex tailer (keep it running in a terminal)
```

Hooks load when a Claude Code session starts — open a new session after applying.

## Development and checks

Run from the repository root:

```sh
bun run typecheck
bun run lint
bun test                  # everything; or split: bun run test:unit · bun run test:integration
bun run check:secrets
bun run build:web
bun run managed:demo      # simulated managed-pipeline scenarios, no model
bun run test:browser      # managed-task browser gate (cached Playwright Chromium, disposable hub)
bun run verify            # all of the above in one command
```

The suite covers schema/IDs/redaction, collector mapping and spooling, hub ingestion and ordering,
GitHub integration logic, web-state merging, documentation parity, and the managed pipeline
(lifecycle, recovery, quarantine, evidence integrity, provider protocol handling against
**generated stub executables**). These checks do not prove a live multi-machine deployment, real
provider compatibility, subscription billing, or host isolation. A GitHub Actions definition is in
`.github/workflows/ci.yml`; it has not been run on hosted CI. `test:browser` needs a Playwright Chromium
build: on a machine without one in the Playwright cache, run `bunx playwright-core install
chromium-headless-shell` once (a download) before `bun run verify`.

## Environment

**Tokens go into `.env` by hand.** `.env` is gitignored; never commit it and don't paste tokens into
chats or issues. `.env.example` documents every variable with blank secrets.

| Variable                   | Used by        | Purpose                                                                                  |
| -------------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`             | hub            | **Read-only** PAT. Empty → `gh auth token`. See *GitHub token* below.                    |
| `GITHUB_LOGIN`             | —              | GitHub account (informational).                                                          |
| `GITHUB_SYNC_INTERVAL_MIN` | hub            | Minutes between syncs inside the hub (`0` = only `bun run sync:github`).                 |
| `GITHUB_RATE_MIN`          | hub            | Stop a sync when a rate-limit bucket drops below this (default 200); resumes next cycle. |
| `REPO_ROOTS`               | hub            | Comma-separated dirs scanned (depth ≤ 4) for local checkouts → `repo_paths`, local-only. |
| `HUB_HOST` / `HUB_PORT`    | hub            | Bind address (default `127.0.0.1:4317`). Also the only non-loopback Host accepted.       |
| `HUB_ALLOWED_ORIGINS`      | hub            | Extra exact browser origins for CORS and `/ws`. Loopback origins are always allowed.     |
| `DB_PATH`                  | hub            | SQLite file (default `./data/agentcity.db`, gitignored).                                 |
| `MANAGED_CONFIG`           | hub            | Path to your managed-runs config (YAML). Empty → managed runs off, `/api/managed` → 503. |
| `MANAGED_TOKEN`            | hub, web UI    | Bearer token for `/api/managed` (it can start processes). Empty → 503. Not `INGEST_TOKEN`. |
| `INGEST_TOKEN`             | hub, collector | Shared secret for `POST /ingest`. Unset on the hub → ingest disabled (503).              |
| `HUB_URL`                  | collector, web | Where collectors POST and the Vite proxy points.                                         |
| `AGENTCITY_MACHINE`        | collector, hub | `cockpit` \| `forge` \| `spine`.                                                         |
| `AGENTCITY_HOME`           | collector      | Spool / offsets / debug log dir (default `~/.agentcity`).                                |
| `AGENTCITY_DEBUG`          | collector      | `1` → `~/.agentcity/hook.log` with timings + error messages (never payloads).            |
| `SPOOL_MAX_MB`             | collector      | Cap on `spool.jsonl` + `spool.*.flushing` together (default 20); oldest dropped first.   |
| `SPOOL_MAX_AGE_DAYS`       | collector      | Spooled events older than this are dropped (default 7). Drops show on `/healthz`.        |
| `CODEX_SESSIONS_DIR`       | collector      | Codex log dir (default `~/.codex/sessions`).                                             |
| `CODEX_BACKFILL_HOURS`     | collector      | First-sight window **by file mtime** (default 2; `0` = tail every new file from EOF).    |
| `CODEX_BACKFILL_EVENT_FILTER` | collector   | `1` → during a file's initial backfill (until its first EOF) skip records older than that window. |
| `AGENTCITY_HOOK_KILL_S`    | hook launcher  | Seconds before `bin/claude-hook` SIGKILLs a stuck hook (default `0.6`). Process env only. |
| `AGENTCITY_BUN`            | hook launcher  | Bun binary for the hook (default `command -v bun`, else `~/.bun/bin/bun`). Process env only. |

The collectors read only `HUB_URL`, `INGEST_TOKEN`, `AGENTCITY_*` (except the two launcher
variables), `SPOOL_*` and `CODEX_*` from this checkout's `.env` — never the whole file; process env
wins. Hooks run with `bun --no-env-file`, so the `.env` of whatever project Claude is working in is
never loaded. `AGENTCITY_HOOK_KILL_S` / `AGENTCITY_BUN` are read by the shell launcher before Bun
starts, so only the environment Claude Code runs hooks with applies to them (`.env` is not read).

**Codex backfill (F14).** On first sight of a rollout log, the rule is the file's **mtime**, not the
records' timestamps: a log last modified more than `CODEX_BACKFILL_HOURS` ago contributes only its
session (line 1) and is tailed from EOF; a log modified recently is read from the start — including
records older than the window, e.g. an old session resumed today. Set
`CODEX_BACKFILL_EVENT_FILTER=1` to also skip those old records by their own timestamp during that
**initial backfill only** (the session context is still learned from them). The filter is dropped the
first time the tailer reaches the file's end — that is persisted with the offset — so everything
appended afterwards is always collected, whatever its timestamp.

**GitHub token.** A fine-grained PAT only sees one resource owner: repos from organizations or where
you are a collaborator may require different token coverage. Check the synced repository list
against the repositories you expect. Use the least-privileged credentials that cover your
repositories; an empty `GITHUB_TOKEN` falls back to the current `gh auth token`.
CI badges need *Actions: read* (a 403 shows as `none` and is counted in the sync summary).

## Scripts

| Script                        | What it does                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `dev` / `dev:hub` / `dev:web` | hub + web · hub only (from repo root) · Vite (proxies `/healthz`, `/api`, `/ws`) |
| `test` · `lint` · `format`    | `bun test` · `biome check .` · `biome format --write .`                          |
| `test:unit` · `test:integration` | Fast schema/web/scripts tests · process, API and pipeline tests (hub + collector). Together = `bun test`. |
| `test:lifecycle`              | Managed lifecycle fault tests (quarantine, approval, cancel, evidence, provider bounds) — rerun to hunt flakes. |
| `test:browser`                | Managed-task browser gate: in-process disposable hub, programmatic Vite without the repo `.env`, cached Playwright Chromium. |
| `build:web` · `verify`        | Production web build · every required gate in one command (lint, typecheck, tests, secrets, build, demo, browser). |
| `typecheck`                   | `tsc --noEmit` for schema, hub, collector and web.                               |
| `sync:github`                 | One GitHub sync + summary (repos, private/archived/fork, CI, local mapping, rate). |
| `db:reset`                    | Stop the hub first. Moves `DB_PATH` (+ `-wal`/`-shm`) to `<db>.bak.<UTC stamp>` and creates an empty, migrated DB. `--db <path>` overrides. |
| `districts:draft`             | Writes `config/districts.draft.yaml` (all repos by district; gitignored).        |
| `collector:hooks`             | Print-only merge of the Claude hook into `~/.claude/settings.json`.              |
| `collector:codex`             | Resident Codex log tailer (also drains the spool every 5 s).                     |
| `managed:demo`                | Deterministic managed-pipeline demo on a throwaway fixture repo (simulated, no model). `--init [dir]` creates a fixture + config for the web UI. |
| `managed:preflight`           | Check the configured live providers (executable, version, login) without calling a model. |
| `check:secrets`               | Scan tracked/untracked files for token patterns. Run before every commit.        |

**Ids.** Sessions are `claude:<session_id>` / `codex:<session_id>`; the main agent shares the session
id; a subagent is `<session id>/sub:<tool_use_id>` (one function set in `packages/schema/src/ids.ts`,
used by both collectors and the hub — the hub also upgrades events spooled by an older collector).
A DB created before this namespace holds raw ids; run `bun run db:reset` once (nothing is deleted).
Repo ids are compared case-insensitively (`repoKey`); references stored under another casing are
re-pointed to the GitHub row at ingest and after every sync.

Districts: edit `config/districts.yaml` (`district: [owner/name | name, …]`, case-insensitive; unlisted
→ `uncategorized`). `bun run districts:draft` gives a starting point.

## Collectors on forge / spine

Each machine runs its own collectors from its own checkout of this repo; only the hub is shared.

1. `git clone … && cd agent-city && bun install`
2. `.env` on that machine — only these are needed:
   ```
   AGENTCITY_MACHINE=forge            # or spine
   HUB_URL=http://127.0.0.1:4317      # via the tunnel below
   INGEST_TOKEN=<copy cockpit's value by hand>
   ```
3. The hub binds to cockpit's loopback, so give the machine a path to it. The Phase 0 recommendation is
   an SSH tunnel (keeps the hub off the network; the Host header stays `127.0.0.1`):
   ```sh
   ssh -N -L 4317:127.0.0.1:4317 cockpit     # run on forge/spine; autossh / launchd to keep it up
   ```
4. `bun run collector:hooks` **on that machine** (the hook path is absolute and per-checkout), review,
   back up, apply; `bun run collector:codex` if Codex runs there.
5. While the tunnel is down, events land in `~/.agentcity/spool.jsonl` and are sent in order later.

## Spine as hub host (draft — not deployed)

Goal: an always-on hub + GitHub sync on spine; cockpit only views.

- Run the hub on spine bound to `127.0.0.1` (same security model) under launchd/systemd:
  `bun apps/hub/src/index.ts` with `DB_PATH` on local disk and `GITHUB_SYNC_INTERVAL_MIN=10`.
- Collectors on every machine (cockpit included) reach it through an SSH tunnel to spine, as above.
- cockpit's web: `HUB_URL=http://127.0.0.1:4317` over the tunnel, `bun run dev:web`.
- `REPO_ROOTS` mapping only covers spine's disk; per-machine `repo_paths` need collector-side
  reporting (see Roadmap).
- Before binding to a LAN/Tailscale address instead of a tunnel: add a configurable Host allowlist
  (today only loopback + `HUB_HOST` pass), put TLS in front, and require auth on `/api` and `/ws`.
- Back up `data/agentcity.db` (SQLite `.backup`) nightly.

## Managed runs (v0.1.1)

Besides *observing* sessions, the hub can run one **managed task** at a time for an explicitly
allowed local repository: isolated worktree → implementation → trusted verification → review of the
exact candidate → at most one automatic repair → a result a person can inspect. Observed sessions,
managed runs and simulated runs are three different things and are labelled as such everywhere.

It is off by default (`MANAGED_CONFIG` empty). The default and every test use **simulated** adapters
or generated stub executables; the real Claude / Codex CLI adapters exist, are stub-tested, are gated
by capability and positive subscription-auth checks that block by default, and have **not** been run
live. A child process whose termination cannot be proven is quarantined (no further managed work
until it is proven gone). Worktrees are Git isolation, not an OS sandbox.
Runbook, state machine, security limits and the live-smoke checklist:
[docs/managed-runs.md](docs/managed-runs.md).

```sh
bun run managed:demo            # prints the outcome of 8 simulated scenarios, leaves nothing behind
bun run managed:demo --init     # fixture repo + config under ~/.agentcity/managed-demo for the UI
```

## Security model

- GitHub is read-only: REST `GET` only; GraphQL is `query`-only (mutations are rejected before sending).
- Hub on loopback; every request's `Host` must be `127.0.0.1` / `localhost` / `[::1]` / `HUB_HOST`
  (DNS-rebinding guard). `/ws` also rejects foreign `Origin`s; CORS echoes allowlisted origins only.
- `/ingest` needs `Bearer $INGEST_TOKEN` (constant-time compare). `/api` and `/ws` are read-only and
  unauthenticated — fine on loopback, not for a network bind.
- `/api/managed` (managed tasks) can start processes, so it is **not** covered by "loopback is
  enough": every route needs `Bearer $MANAGED_TOKEN`, mutations need a JSON body and an allowed
  `Origin`, and `/ws` only ever broadcasts a managed task's id. A managed worktree is Git isolation,
  not a sandbox — see [docs/managed-runs.md](docs/managed-runs.md#security-and-host-access).
- `/ingest` takes at most 500 events per request (`MAX_INGEST_BATCH`; more → 413) inside a 5 MiB
  body; collectors send in chunks of exactly that size.
- Collectors redact before spooling/sending: prompt text is never stored (length only); `tool_input`
  is reduced to tool name + file path + first 80 chars of a command, all through `redact()`; every
  string field of an event is sanitized, and the hub re-applies all of it before storing.
- Hooks are designed to avoid blocking sessions: exit 0, no stdout. The event is written to the spool **before** any
  network I/O; the POST gets only the time left (≤ 300 ms, all work inside 450 ms), the hook's own
  timer exits at 500 ms, and the launcher `bin/claude-hook` SIGKILLs it after
  `AGENTCITY_HOOK_KILL_S` (default 0.6 s) even if it is stuck in synchronous work. Hooks are
  installed with `async: true`.
- GitHub ETag cache entries are keyed by `sha256(token)[:12]` + URL, so a token change never reuses
  an answer fetched with another token's access (the token itself is never stored). GraphQL
  `errors[].message` text is redacted and clipped before it reaches an exception or a log line.

**Known limits of redaction** (documented, not fixed — regex redaction can't tell these from normal
text; don't paste secrets into commands in the first place):
- A token used as the bare *username* of a URL (`https://<token>@host/…`) is kept — only
  `user:password@` userinfo is masked.
- Bare base64 of a token is kept (`TOKEN=<base64>` is masked by the key name; the value alone isn't).

## Troubleshooting

| Symptom                                   | Check                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| No Claude events                          | New session after applying hooks? `/hooks` in Claude Code lists them. Set `AGENTCITY_DEBUG=1` → `~/.agentcity/hook.log`. |
| `~/.agentcity/spool*` keeps growing       | Hub down or unreachable (tunnel?), or `INGEST_TOKEN` mismatch → 401. `curl 127.0.0.1:4317/healthz` should show `ingest: enabled`. |
| `spool.rejected.jsonl` has lines          | The hub refused that batch (400). Inspect a line; it is already redacted.                                 |
| No Codex events                           | Is `collector:codex` running? On first sight only logs *modified* within `CODEX_BACKFILL_HOURS` are read from the start (see *Codex backfill*); offsets live in `~/.agentcity/codex-offsets.json` (delete to re-scan). |
| Sessions show raw ids / duplicates after upgrading | The id namespace changed (`claude:` / `codex:` prefixes). Stop the hub, `bun run db:reset`, start it again. |
| Web shows `reconnecting…`                 | Hub not running, or `HUB_URL` in `.env` doesn't match the hub port.                                       |
| `403 forbidden host` / `forbidden origin` | Reaching the hub by a non-loopback name. Use `127.0.0.1`/`localhost`, or set `HUB_HOST` / `HUB_ALLOWED_ORIGINS`. |
| Sync `ABORTED: rate-limit`                | It resumes on the next cycle; lengthen the interval if it repeats.                                        |
| A repo is missing                         | Token scope (see *GitHub token*); compare with `gh repo list`.                                             |
| Session repo shows `local/<dir>`          | The checkout has no github.com `origin`.                                                                   |

## Roadmap

Decisions and their reasons are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Planned, not
implemented unless marked:

1. **Workflow foundation** — work items, stages, ownership, transitions and completion evidence,
   with observation kept distinct from commands and approvals. *Partly implemented on this branch as
   managed runs v0.1.1 (single machine, one task at a time, simulated by default).*
2. **Monitor reliability** — normalized event kinds (hook payloads:
   [docs/hook-events.md](docs/hook-events.md)), run state and health signals (waiting, stalled,
   failing, looping) and notifications.
3. **Reliable multi-machine tracking** — collector-reported `repo_paths`, machine presence, and
   service/tunnel lifecycle management. The setup instructions above describe how to run
   collectors; they do not imply every machine is deployed.
4. **Permissioned control** — from observation to notifications to explicit per-action approval
   for local agent actions; a dedicated OS user + clone for isolation (ARCHITECTURE #7, not done).
   GitHub remains read-only unless a separate decision changes that scope.
5. **External relay** — propose + read-public-results only.
6. **Live city view** — an R3F scene with districts, repository buildings and agents, retaining the
   2D view for debugging.

### Known gaps and deferred work

- Codex subagents (`spawn_agent`) are not represented as separate agent rows; there is no reliable
  end signal yet
- Tool events inside a Claude subagent are attributed to the main agent because the internal agent
  ID cannot be matched to the Task call
- A rejected ingest batch is parked as a whole; bisecting it to isolate one bad event remains to do
- Deleted/inaccessible GitHub repos remain with stale `synced_at` values
- CI status uses the latest run on any branch; default-branch-only badges remain deferred
- A configurable Host allowlist and auth on `/api` and `/ws` are needed before exposing a hub
  beyond loopback
- Service units for the hub, Codex tailer, and SSH tunnels remain to be added
- Old token-scoped `github_etags` rows are not automatically pruned
- Managed runs: live provider integration, subscription-only billing and host isolation are
  unverified; worktrees and artifacts are never cleaned up automatically; a quarantine caused by an
  escaped descendant cannot be released after a hub restart (by design: no evidence) and then blocks
  all managed tasks — an open decision (keep the lockout vs. a documented out-of-band procedure)
