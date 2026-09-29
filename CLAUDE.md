# Agent City — agent instructions

> **CLAUDE.md 와 AGENTS.md 는 같은 내용이다.** 하나를 고치면 반드시 다른 하나도 똑같이 고친다
> (`cp CLAUDE.md AGENTS.md`). Claude Code 는 CLAUDE.md, Codex 는 AGENTS.md 를 읽는다.

## What this is

Bun + TypeScript (strict) monorepo that watches Claude Code / Codex sessions across machines
(cockpit / forge / spine) and renders them as a city: GitHub repos = buildings grouped into districts.

```
apps/hub         Hono HTTP server on bun:sqlite (ingest, read API, ws)      :4317
apps/collector   per-machine agents: Claude Code hook, Codex log tail, local spool
apps/web         Vite + React view
packages/schema  zod types, redaction, SQL migrations (shared by all apps)
config/          districts.yaml (repo → district)
scripts/         repo tooling (check-secrets)
```

## Hard rules

1. **GitHub is read-only.** Only GET requests. Never create/modify/delete anything on GitHub
   (repos, issues, PRs, labels, webhooks…). No `gh` subcommands that write.
2. **Never modify global agent config directly** (`~/.claude`, `~/.codex`, shell rc files).
   If hooks need installing, print the snippet for the user to apply.
3. **Secrets never get logged.** Not tokens, not hook payloads unredacted, not `.env` contents.
   Everything a collector captures goes through `redact`/`redactObject` before spool/send/log.
   `.env` is never committed and never created by an agent — only `.env.example` with blank secrets.
4. **Hooks must never block.** `apps/collector/src/claude-hook.ts` always exits 0, never writes to
   stdout, swallows every error, and does no slow work inline (spool first, flush best-effort).
5. Hub binds to `127.0.0.1` by default. Ingest requires `INGEST_TOKEN`.
6. Run `bun run check:secrets` before every commit.

## Commands

```sh
bun install
bun run dev            # hub + web
bun run dev:hub        # hub only (runs from repo root so .env / DB_PATH resolve here)
bun run dev:web        # web only (Vite, proxies /healthz and /api to HUB_URL)
bun run test           # bun test
bun run lint           # biome check .
bun run format         # biome format --write .
bun run sync:github    # GitHub → repos table (stub in Step 0)
bun run check:secrets  # scan tracked/untracked files for token patterns
```

## Conventions

- Biome is the only formatter/linter; don't add ESLint/Prettier.
- DB schema changes = new `packages/schema/migrations/NNN_name.sql`; applied version is tracked in
  `PRAGMA user_version` (never edit an applied migration).
- Timestamps are ISO-8601 UTC strings everywhere (zod + SQLite TEXT).
