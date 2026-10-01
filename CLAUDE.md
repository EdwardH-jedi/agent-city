# Agent City — agent instructions

> **CLAUDE.md 와 AGENTS.md 는 같은 내용이다.** 하나를 고치면 반드시 다른 하나도 똑같이 고친다
> (`cp CLAUDE.md AGENTS.md`). Claude Code 는 CLAUDE.md, Codex 는 AGENTS.md 를 읽는다.

## What this is

Bun + TypeScript (strict) monorepo that watches Claude Code / Codex sessions across machines
(cockpit / forge / spine) and renders them as a city: GitHub repos = buildings grouped into districts.

```
apps/hub         Hono HTTP server on bun:sqlite (ingest, read API, ws, GitHub sync)  :4317
                 + managed runs (src/managed: orchestrator, worktrees, evidence, CLI adapters)
apps/collector   per-machine agents: Claude Code hook (bin/claude-hook), Codex log tail, local spool
apps/web         Vite + React 2D view (Phase 0); 3D city comes last (docs/ARCHITECTURE.md)
packages/schema  zod types, status machine, redaction + secret patterns, SQL migrations (shared)
config/          districts.yaml (repo → district), managed.example.yaml (managed-run config template)
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
   spool/send/log; prompt text is never stored (length only) — this holds for everything a
   collector *observes*. The one narrow exception: a **managed task's** title, objective and
   acceptance criteria are typed by the user into Agent City to be executed, so they are stored
   (after `redact()`); transcripts, tool input and model reasoning of managed runs are still not
   stored — only event kinds, tool names and the final result text. Secret patterns live in one place:
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
7. **Managed runs never widen what Agent City may do** (`apps/hub/src/managed`, docs/managed-runs.md):
   - no push, PR, merge, deploy or any GitHub write; git is local only.
   - the only things that become a process are in the trusted `MANAGED_CONFIG` file (argv arrays,
     absolute executables, allowlisted repos). Never build a command from a task, a repo file, a
     review finding or model output, and never go through a shell.
   - every child goes through `managed/proc.ts` (`runProcess`): own process group, allowlisted env
     (no tokens / API keys), bounded time and output, termination confirmed. No provider flag that
     bypasses permissions (`--dangerously-skip-permissions`, `bypassPermissions`), no `--bare`, no
     fallback model, no "most recent session".
   - `/api/managed` needs `MANAGED_TOKEN` on every route; loopback is not authentication.
   - live execution stays off unless `live.enabled: true` in the config. Tests, `bun run dev` and
     the demo must make zero real model calls — use the stub executables in `managed/testkit.ts`.
   - a model stage is never re-launched automatically after a crash; a verdict counts only for the
     exact candidate SHA + evidence manifest it names; simulated results are labelled simulated.
   - (v0.1.1) a child whose termination is not proven goes to `managed_quarantine`; it blocks all
     claims, Run and Cancel→cancelled until objective evidence (never a dismiss button / manual ack);
     never signal a pid whose start time differs from the recorded one.
   - (v0.1.1) the approval binding is re-checked before EVERY stage, resumed ones included, against
     the orchestrator's frozen config snapshot; everything that changes what a run may do or
     produce belongs in `policyHash`.
   - (v0.1.1) evidence is used and shown only after one verified read of the full stored bytes
     (`readArtifactBytes` / `verifyRunEvidence`); never check one read and use another.
   - (v0.1.1) provider CLIs run only with their isolation controls (`--safe-mode --restricted
     --strict-mcp-config --disable-slash-commands`; Codex `--ignore-user-config --ignore-rules`),
     each confirmed in the installed `--help`, and only after a positive subscription-auth check
     (`allowed_auth_methods` / `auth_status_pattern`, empty = blocked). Env filtering alone is not
     a billing guarantee.
   - tests and the browser gate use disposable state only (temp HOME/DB/fixtures, port 0); the
     browser gate never loads `apps/web/vite.config.ts` or the repo `.env`.

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
bun run collector:hooks  # print-only merge of the Claude hook into ~/.claude/settings.json
bun run collector:codex  # resident Codex log tailer
bun run managed:demo     # simulated managed-pipeline demo on a throwaway fixture repo (no model)
bun run managed:preflight # check configured live providers without calling a model
bun run test:browser     # managed-task browser gate (disposable hub, cached Playwright Chromium)
bun run verify           # every required gate in one command
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
- Session / agent ids come only from `packages/schema/src/ids.ts` (final scheme): a raw id is used
  verbatim only if it matches `[A-Za-z0-9._-]{1,128}` and holds no secret, else it becomes
  `redacted-<hash>`; session = `<provider>:<raw part>`, main agent = session id, subagent =
  `<session_id>/sub:<raw part of tool_use_id>`; an agent id naming another session falls to the main
  agent. Event ids keep the 1f4f025 recipe (`cc:<raw>:<hook>:<tool_use_id>`, `codex:<raw>:<offset>`,
  golden test). Changing any of this needs `bun run db:reset` (no migration rewrites ids).
- Repo ids: `.git` is stripped only while parsing a remote URL; `local/<dir>` keeps the folder name
  verbatim. Collector, sync and hub all use `packages/schema/src/repo-slug.ts`.
- `sessions.rev` is bumped on every write to a session row; clients merge by rev (higher wins,
  equal keeps). Bulk rewrites (repo remap) publish `{kind:"invalidate", scope:[…]}` on `/ws`.
- Every env var the code reads is in both `.env.example` and the README table (a test enforces it).
- Managed task states come only from `packages/schema/src/managed-status.ts` (separate from the
  session status machine: an idle/ended session is not a finished task). Contracts are versioned in
  `packages/schema/src/managed.ts` (`agentcity.managed/v1`, `.review/v1`, `.evidence/v1`).
- Every managed worker write is fenced (`store.withFence`, `fence_token`); a lease that expired is
  reconciled by fencing first, then stopping leftovers. Never write a managed row around the fence.
- `LIVE_INTEGRATION_VERIFIED` (schema) stays `false` until a person has run and checked a live
  smoke; do not describe the live path as verified while it is false.
