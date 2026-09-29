# Agent City — agent instructions

> **CLAUDE.md 와 AGENTS.md 는 같은 내용이다.** 하나를 고치면 반드시 다른 하나도 똑같이 고친다
> (`cp CLAUDE.md AGENTS.md`). Claude Code 는 CLAUDE.md, Codex 는 AGENTS.md 를 읽는다.

## What this is

Bun + TypeScript (strict) monorepo that watches Claude Code / Codex sessions across machines
(cockpit / forge / spine) and renders them as a city: GitHub repos = buildings grouped into districts.

```
apps/hub         Hono HTTP server on bun:sqlite (ingest, read API, ws, GitHub sync)  :4317
apps/collector   per-machine agents: Claude Code hook (bin/claude-hook), Codex log tail, local spool
apps/web         Vite + React 2D view (Phase 0); 3D city is Phase 1
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
   stdout, swallows every error, and is bounded (500 ms hard deadline, 200 ms stdin, 300 ms POST,
   spool on failure). It imports only `@agent-city/schema/core` (zod-free) — keep it that way.
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
bun run format           # biome format --write .
bun run sync:github      # GitHub → repos (+ CI, local checkouts); prints a summary
bun run districts:draft  # config/districts.draft.yaml (gitignored; never overwrites districts.yaml)
bun run collector:hooks  # print-only merge of the Claude hook into ~/.claude/settings.json
bun run collector:codex  # resident Codex log tailer
bun run check:secrets    # scan tracked/untracked files for token patterns
```

## Conventions

- Biome is the only formatter/linter; don't add ESLint/Prettier.
- DB schema changes = new `packages/schema/migrations/NNN_name.sql`; applied version is tracked in
  `PRAGMA user_version` (never edit an applied migration).
- Field names are snake_case and match DB columns 1:1 (zod schemas in `packages/schema/src/types.ts`).
- Timestamps are ISO-8601 UTC strings everywhere (zod + SQLite TEXT); the hub normalizes to `…Z`.
- Repo ids are `owner/name` (GitHub casing; ingest canonicalizes case-insensitively). A checkout
  without a github.com origin is `local/<dir>` — the rule lives in `packages/schema/src/repo-slug.ts`
  and is shared by the hub's local scan and the collectors.
- Session status transitions come only from `packages/schema/src/status.ts`.
