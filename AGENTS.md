# Agent City — agent instructions

> **CLAUDE.md 와 AGENTS.md 는 같은 내용이다.** 하나를 고치면 반드시 다른 하나도 똑같이 고친다
> (`cp CLAUDE.md AGENTS.md`). Claude Code 는 CLAUDE.md, Codex 는 AGENTS.md 를 읽는다.

## What this is

Bun + TypeScript (strict) monorepo that watches Claude Code / Codex sessions across machines
(cockpit / forge / spine) and renders them as a city: GitHub repos = buildings grouped into districts.

```
apps/hub         Hono HTTP server on bun:sqlite (ingest, read API, ws, GitHub sync)  :4317
apps/collector   per-machine agents: Claude Code hook (bin/claude-hook), Codex log tail, local spool
apps/web         Vite + React board; middle scene = ring town (src/town; engine/ copied from the original
                 game, see engine/PROVENANCE.md; the only biome override), ?scene=campus = 3D campus
packages/schema  zod types, status machine, redaction + secret patterns, SQL migrations (shared)
config/          districts.yaml (repo → district)
scripts/         repo tooling (check-secrets)
```

## Hard rules

1. **GitHub is read-only.** REST: `GET` only. GraphQL: `query` operations only — the client rejects
   anything else before sending (the endpoint is POST by protocol; that is the only non-GET request).
   Never create/modify/delete anything on GitHub (repos, issues, PRs, labels, webhooks…). No `gh`
   subcommands that write.
2. **Never modify global agent config directly** (`~/.claude`, `~/.codex`, shell rc files).
   If hooks need installing, print the snippet / merged file for the user to apply
   (`bun run collector:hooks` writes only to `~/.agentcity/`).
3. **Secrets never get logged.** Not tokens, not hook payloads unredacted, not `.env` contents.
   Everything a collector captures goes through `redact`/`redactObject`/`summarizeToolInput` before
   spool/send/log; prompt text is never stored (length only). Secret patterns live in one place:
   `packages/schema/src/secret-patterns.ts` (shared by redaction and `check:secrets`).
   `.env` is never committed and never created by an agent — only `.env.example` with blank secrets.
   Test fixtures build fake tokens at runtime and never contain real (private) repo names.
4. **Hooks must never block.** `apps/collector/src/claude-hook.ts` always exits 0, never writes to
   stdout, swallows every error, and is bounded: 200 ms stdin, event spooled **before** any network
   I/O, POST only in the time left (≤ 300 ms, all work inside 450 ms), 500 ms self-exit timer — and
   the launcher `apps/collector/bin/claude-hook` SIGKILLs it after `AGENTCITY_HOOK_KILL_S` (default
   0.6 s) even when it is stuck in synchronous work. Hooks are installed `async: true`, `timeout: 2`.
   It imports only `@agent-city/schema/core` (zod-free) — keep it that way.
5. Hub binds to `127.0.0.1` by default and rejects foreign `Host` headers; `/ws` rejects foreign
   `Origin`s. Ingest requires `INGEST_TOKEN`. Don't widen the bind without auth on `/api` and `/ws`.
6. Run `bun run check:secrets` before every commit.

## Commands

```sh
bun install
bun run dev              # hub + web
bun run dev:hub          # hub only (runs from repo root so .env / DB_PATH resolve here)
bun run dev:web          # web only (Vite, proxies /healthz, /api, /ws to HUB_URL)
bun run test             # bun test
bun run lint             # biome check .
bun run typecheck        # tsc --noEmit for schema, hub, collector, web
bun run format           # biome format --write .
bun run sync:github      # GitHub → repos (+ CI, local checkouts); prints a summary
bun run districts:draft  # config/districts.draft.yaml (gitignored; never overwrites districts.yaml)
bun run db:reset         # hub stopped: DB (+ -wal/-shm) → <db>.bak.<UTC stamp>, fresh migrated DB
bun run db:backup        # hub may run: consistent copy → <data dir>/backups/<db file name>-YYYYMMDD-HHMMSS.db; --keep N prunes
bun run collector:hooks  # print-only merge of the Claude hook into ~/.claude/settings.json
bun run collector:codex  # resident Codex log tailer
bun run collector:heartbeat # resident machine heartbeat → hub (cockpit / forge / spine online · stale · offline)
bun run collector:launchd # print-only: launchd job files (tunnel, heartbeat, codex, run exporter) → ~/.agentcity/launchd/; the owner loads them
bun run check:secrets    # scan tracked/untracked files for token patterns
```

## Conventions

- Biome is the only formatter/linter; don't add ESLint/Prettier.
- DB schema changes = new `packages/schema/migrations/NNN_name.sql`; applied version is tracked in
  `PRAGMA user_version` (never edit an applied migration).
- Field names are snake_case and match DB columns 1:1 (zod schemas in `packages/schema/src/types.ts`).
- Timestamps are ISO-8601 UTC strings everywhere (zod + SQLite TEXT); the hub normalizes to `…Z`.
- Repo ids are `owner/name` (GitHub casing; ingest canonicalizes case-insensitively): `origin`'s
  github.com repo, or — with no `origin` — the one github.com repo among the remotes (two different
  ones: no guess). Otherwise `local/<dir>`. The rule lives in `packages/schema/src/repo-slug.ts`
  (`githubRepoFromRemotes`, `localRepoId`) and is shared by the hub's local scan and the collectors.
  Input limits keep its work constant: over `GIT_REMOTES_MAX` (32) remotes, `GIT_INSTEADOF_MAX` (32)
  insteadOf rules, `GIT_URL_MAX` (2048) chars in a url / base / prefix, or `GIT_PATH_MAX` (4096) in a
  gitdir / commondir path, the checkout is `local/<dir>` (no throw; the event is still spooled). Code
  that reads .git files in the hook stays linear and inside these limits — no new unbounded loops.
- Session status transitions come only from `packages/schema/src/status.ts`.
- Session / agent ids come only from `packages/schema/src/ids.ts` (final scheme): a raw id is used
  verbatim only if it matches `[A-Za-z0-9._-]{1,128}` and holds no secret, else it becomes
  `redacted-<hash>`; session = `<provider>:<raw part>`, main agent = session id, subagent =
  `<session_id>/sub:<raw part of tool_use_id>`; an agent id naming another session falls to the main
  agent. Event ids keep the 1f4f025 recipe (`cc:<raw>:<hook>:<tool_use_id>`, `codex:<raw>:<offset>`,
  golden test). Changing any of this needs `bun run db:reset` (no migration rewrites ids).
- Repo ids: `.git` is stripped only while parsing a remote URL; `local/<dir>` keeps the folder name
  verbatim. Collector, sync and hub all use `packages/schema/src/repo-slug.ts`. A linked worktree
  without a github repo takes the main checkout's folder (`localRepoId(toplevel, commonDir)`), in the
  collector (`apps/collector/src/git-info.ts`, reads files only) and the hub's local scan alike.
- `sessions.rev` is bumped on every write to a session row; clients merge by rev (higher wins,
  equal keeps). Bulk rewrites (repo remap) publish `{kind:"invalidate", scope:[…]}` on `/ws`.
- Every env var the code reads is in both `.env.example` and the README table (a test enforces it).
- When you change a screen, run `bun run check:board` (`AGENTCITY_BOARD_URL=http://127.0.0.1:<port>/`
  points it at a dev server).
