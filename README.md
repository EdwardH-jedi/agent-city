# Agent City

A live map of my coding agents. Every Claude Code / Codex session on every machine is collected into a
local hub and drawn as a city: GitHub repos are buildings, grouped into districts
(`games`, `school`, `client`, `infra`, `uncategorized`), and active agents walk between them.

## Machines

| Role      | What it does                                                                |
| --------- | --------------------------------------------------------------------------- |
| `cockpit` | Where I sit. Runs the hub + web view, and a collector for local sessions.   |
| `forge`   | Heavy build/agent box. Runs a collector that ships events to the hub.       |
| `spine`   | Always-on box. Runs a collector (and later can host the hub / GitHub sync). |

Set the role per machine with `AGENTCITY_MACHINE`.

## Layout

```
apps/hub          Hono + bun:sqlite — /healthz, /ingest, /api, /ws
apps/collector    Claude Code hook, Codex log tail, local spool
apps/web          Vite + React view
packages/schema   zod types, redaction, SQL migrations
config/           districts.yaml
scripts/          check-secrets.ts
```

## Setup

Requires [Bun](https://bun.sh) (`brew install bun`).

```sh
bun install
cp .env.example .env     # then fill in secrets by hand
bun run dev:hub          # → http://127.0.0.1:4317/healthz
bun run dev:web          # → http://127.0.0.1:5173
```

## Environment

**Tokens go into `.env` by hand.** `.env` is gitignored; never commit it and don't paste tokens into
chats or issues. `.env.example` documents every variable with blank secrets.

| Variable                   | Purpose                                                                   |
| -------------------------- | ------------------------------------------------------------------------- |
| `GITHUB_TOKEN`             | Fine-grained PAT, **read-only**. If empty, `gh auth token` is used.       |
| `GITHUB_LOGIN`             | GitHub account whose repos are synced.                                    |
| `HUB_HOST` / `HUB_PORT`    | Hub bind address (default `127.0.0.1:4317`).                              |
| `HUB_URL`                  | How collectors and the web view reach the hub.                            |
| `INGEST_TOKEN`             | Shared secret between collectors and the hub.                             |
| `DB_PATH`                  | SQLite file (default `./data/agentcity.db`, gitignored).                  |
| `AGENTCITY_MACHINE`        | `cockpit` \| `forge` \| `spine`.                                          |
| `REPO_ROOTS`               | Comma-separated directories scanned for local checkouts.                  |
| `GITHUB_SYNC_INTERVAL_MIN` | Minutes between GitHub syncs.                                             |

## Scripts

`dev`, `dev:hub`, `dev:web`, `test`, `lint`, `format`, `sync:github`, `check:secrets` — see
[CLAUDE.md](./CLAUDE.md) for details and the project rules.

## Roadmap

- **Step 0 — Scaffold** ✅ monorepo, stubs, migrations, `/healthz`.
- **Phase 0 — Data layer**: GitHub sync (read-only) → `repos`, Claude hook + Codex tail → spool →
  `/ingest`, redaction, read API, flat 2D district view.
- **Phase 1 — Multi-machine**: collectors on forge/spine, machine presence, repo path matching.
- **Phase 2 — Live city**: WebSocket updates, agent movement/animation, session timelines.
