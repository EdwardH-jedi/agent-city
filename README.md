# Agent City

A live map of my coding agents. Every Claude Code / Codex session on every machine is collected into a
local hub and drawn as a city: GitHub repos are buildings, grouped into districts
(`games`, `school`, `client`, `infra`, `uncategorized`), and active agents walk between them.

Phase 0 (this repo today) is the data layer plus a flat 2D view to verify it; the 3D city is Phase 1.

## Machines

| Role      | What it does                                                                |
| --------- | --------------------------------------------------------------------------- |
| `cockpit` | Where I sit. Runs the hub + web view, and a collector for local sessions.   |
| `forge`   | Heavy build/agent box. Runs a collector that ships events to the hub.       |
| `spine`   | Always-on box. Runs a collector (and later can host the hub / GitHub sync). |

Set the role per machine with `AGENTCITY_MACHINE`.

## Layout

```
apps/hub          Hono + bun:sqlite — /healthz, /ingest, /api/*, /ws, GitHub sync, stale sweep
apps/collector    Claude Code hook (bin/claude-hook), Codex log tailer, local spool
apps/web          Vite + React 2D view (repos · live sessions · event stream)
packages/schema   zod types, status machine, redaction, secret patterns, SQL migrations
config/           districts.yaml (repo → district)
scripts/          check-secrets.ts
```

Data flow: `hook / codex tail → redact → POST /ingest (or ~/.agentcity/spool.jsonl) → SQLite → /api + /ws → web`.

## Setup (cockpit)

Requires [Bun](https://bun.sh) (`brew install bun`) and git.

```sh
bun install
cp .env.example .env         # fill in secrets by hand (see Environment)
bun run sync:github          # first GitHub sync → prints a summary
bun run dev                  # hub :4317 + web :5173  (or dev:hub / dev:web separately)
```

Open http://127.0.0.1:5173.

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
| `INGEST_TOKEN`             | hub, collector | Shared secret for `POST /ingest`. Unset on the hub → ingest disabled (503).              |
| `HUB_URL`                  | collector, web | Where collectors POST and the Vite proxy points.                                         |
| `AGENTCITY_MACHINE`        | collector, hub | `cockpit` \| `forge` \| `spine`.                                                         |
| `AGENTCITY_HOME`           | collector      | Spool / offsets / debug log dir (default `~/.agentcity`).                                |
| `AGENTCITY_DEBUG`          | collector      | `1` → `~/.agentcity/hook.log` with timings + error messages (never payloads).            |
| `CODEX_BACKFILL_HOURS`     | collector      | On first sight, Codex logs older than this are skipped (default 2).                      |
| `CODEX_SESSIONS_DIR`       | collector      | Codex log dir (default `~/.codex/sessions`).                                             |

The collector reads only `HUB_URL`, `INGEST_TOKEN` and `AGENTCITY_*` from this checkout's `.env`
(process env wins). Hooks run with `bun --no-env-file`, so the `.env` of whatever project Claude is
working in is never loaded.

**GitHub token.** A fine-grained PAT only sees one resource owner: repos from organizations or where
you are a collaborator won't sync. Today every repo is owned by the account, so nothing is missing; if
that changes, use a classic read-only PAT or empty `GITHUB_TOKEN` to fall back to `gh auth token`.
CI badges need *Actions: read* (a 403 shows as `none` and is counted in the sync summary).

## Scripts

| Script                        | What it does                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `dev` / `dev:hub` / `dev:web` | hub + web · hub only (from repo root) · Vite (proxies `/healthz`, `/api`, `/ws`) |
| `test` · `lint` · `format`    | `bun test` · `biome check .` · `biome format --write .`                          |
| `sync:github`                 | One GitHub sync + summary (repos, private/archived/fork, CI, local mapping, rate). |
| `districts:draft`             | Writes `config/districts.draft.yaml` (all repos by district; gitignored).        |
| `collector:hooks`             | Print-only merge of the Claude hook into `~/.claude/settings.json`.              |
| `collector:codex`             | Resident Codex log tailer (also drains the spool every 5 s).                     |
| `check:secrets`               | Scan tracked/untracked files for token patterns. Run before every commit.        |

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
  reporting (see Next).
- Before binding to a LAN/Tailscale address instead of a tunnel: add a configurable Host allowlist
  (today only loopback + `HUB_HOST` pass), put TLS in front, and require auth on `/api` and `/ws`.
- Back up `data/agentcity.db` (SQLite `.backup`) nightly.

## Security model

- GitHub is read-only: REST `GET` only; GraphQL is `query`-only (mutations are rejected before sending).
- Hub on loopback; every request's `Host` must be `127.0.0.1` / `localhost` / `[::1]` / `HUB_HOST`
  (DNS-rebinding guard). `/ws` also rejects foreign `Origin`s; CORS echoes allowlisted origins only.
- `/ingest` needs `Bearer $INGEST_TOKEN` (constant-time compare). `/api` and `/ws` are read-only and
  unauthenticated — fine on loopback, not for a network bind.
- Collectors redact before spooling/sending: prompt text is never stored (length only); `tool_input`
  is reduced to tool name + file path + first 80 chars of a command, all through `redact()`; the hub
  re-applies redaction before storing.
- Hooks never block: always exit 0, no stdout, 500 ms hard deadline, 300 ms POST, spool on failure.

## Troubleshooting

| Symptom                                   | Check                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| No Claude events                          | New session after applying hooks? `/hooks` in Claude Code lists them. Set `AGENTCITY_DEBUG=1` → `~/.agentcity/hook.log`. |
| `~/.agentcity/spool*` keeps growing       | Hub down or unreachable (tunnel?), or `INGEST_TOKEN` mismatch → 401. `curl 127.0.0.1:4317/healthz` should show `ingest: enabled`. |
| `spool.rejected.jsonl` has lines          | The hub refused that batch (400). Inspect a line; it is already redacted.                                 |
| No Codex events                           | Is `collector:codex` running? On first run only logs newer than `CODEX_BACKFILL_HOURS` are read; offsets live in `~/.agentcity/codex-offsets.json` (delete to re-scan). |
| Web shows `reconnecting…`                 | Hub not running, or `HUB_URL` in `.env` doesn't match the hub port.                                       |
| `403 forbidden host` / `forbidden origin` | Reaching the hub by a non-loopback name. Use `127.0.0.1`/`localhost`, or set `HUB_HOST` / `HUB_ALLOWED_ORIGINS`. |
| Sync `ABORTED: rate-limit`                | It resumes on the next cycle; lengthen the interval if it repeats.                                        |
| A repo is missing                         | Token scope (see *GitHub token*); compare with `gh repo list`.                                             |
| Session repo shows `local/<dir>`          | The checkout has no github.com `origin`.                                                                   |

## Roadmap

- **Step 0 — Scaffold** ✅
- **Phase 0 — Data layer** ✅ schema + status machine + redaction; hub (ingest / API / ws / stale
  sweep, Host/Origin guard); GitHub sync (GraphQL + CI ETag + local mapping); Claude hook + spool;
  Codex tailer; 2D view.
- **Phase 1 — Live city**: see Next.

## Next

**Phase 1**
- R3F (react-three-fiber) city: districts as blocks, repos as buildings (height = commits_30d, CI
  colour), agents as walkers; the 2D view stays as a debug panel.
- Multi-machine for real: collectors on forge/spine through tunnels; collector-reported `repo_paths`
  per machine; machine presence.
- Evaluate GitHub webhooks (push / workflow_run) instead of polling — needs a public endpoint or a
  relay; keep polling as the fallback.
- Control plane in permission stages: read-only (today) → notify (e.g. waiting > N min) → act on local
  agents with explicit per-action approval. No GitHub writes at any stage without a new decision.

**Deferred from Phase 0**
- Codex subagents (`spawn_agent`) as agent rows (no reliable end signal yet).
- Tool events fired inside a Claude subagent are attributed to the main agent (Claude's internal agent
  id can't be matched to the Task call).
- Bisect a rejected ingest batch so one bad event doesn't park the whole batch.
- Repos deleted on GitHub / access lost stay with a stale `synced_at` — mark or prune.
- CI badge from the default branch only (`actions/runs?branch=<default>`) instead of the latest run
  on any branch.
- Configurable Host allowlist + auth on `/api` and `/ws` before any non-loopback bind.
- launchd units for the hub, `collector:codex` and SSH tunnels.
- Web: unit tests for the merge logic in `useHub.ts`.
