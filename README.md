# Agent City

A local telemetry dashboard for Claude Code and Codex sessions, with read-only
GitHub repository status. Collectors feed redacted events to a Bun/SQLite hub;
a React 2D view shows repositories, live sessions, and the event stream.

**Current status:** the data layer and 2D inspection view are implemented.
Collection covers the machines and supported session events you configure.
Workflow orchestration and the 3D city are future work: this version does not
schedule tasks, launch agents, advance pipeline stages, or approve actions.

The next priority is reliable workflow tracking and explicit control boundaries.
The city visualization comes after that foundation.

[Quick start](#quick-start-cockpit) · [Checks](#development-and-checks) ·
[Environment](#environment) · [Security](#security-model) · [Roadmap](#roadmap)

## Implemented features

- Claude Code hooks and a Codex log tailer, with local spooling during outages
- Shared event schemas, session/agent IDs, redaction, and status transitions
- A Hono hub with SQLite storage, ingest, REST reads, WebSocket updates, and stale-session handling
- Read-only GitHub repository/CI sync, rate-limit handling, ETag caching, and local checkout mapping
- A flat React UI for inspecting repositories, sessions, and events
- Machine roles and SSH-tunnel setup for collectors on separate hosts

## Architecture and repository map

```text
Claude hook / Codex tailer
  → redact → POST /ingest (or local spool while offline)
  → SQLite → /api + /ws → React 2D view
GitHub (read-only) → repository / CI sync → SQLite
```

| Path | Responsibility |
|---|---|
| `apps/collector/` | Claude hook launcher, Codex tailer, config, redaction integration, and spool |
| `apps/hub/` | Hono + `bun:sqlite`, `/healthz`, `/ingest`, `/api/*`, `/ws`, GitHub sync, stale sweep |
| `apps/web/` | Vite + React 2D repository/session/event view |
| `packages/schema/` | Zod types, status machine, IDs, redaction, secret patterns, SQL migrations |
| `config/districts.yaml` | Repository-to-district mapping |
| `scripts/` | Secret scanning, documentation parity, golden-event helpers |

## Machines

| Role      | What it does                                                                |
| --------- | --------------------------------------------------------------------------- |
| `cockpit` | Where I sit. Runs the hub + web view, and a collector for local sessions.   |
| `forge`   | Heavy build/agent box. Runs a collector that ships events to the hub.       |
| `spine`   | Always-on box. Runs a collector (and later can host the hub / GitHub sync). |

Set the role per machine with `AGENTCITY_MACHINE`.

## Quick start (cockpit)

Requires [Bun](https://bun.sh) and Git. For GitHub sync, configure a token with
the read permissions described below, or use an existing `gh` CLI login.

```sh
git clone https://github.com/EdwardH-jedi/agent-city.git
cd agent-city
bun install
cp .env.example .env         # fill in secrets by hand (see Environment)
bun run sync:github          # first GitHub sync → prints a summary
bun run dev                  # hub :4317 + web :5173  (or dev:hub / dev:web separately)
```

Open http://127.0.0.1:5173. Set `INGEST_TOKEN` in `.env` before collecting
events; an unset token disables ingest. Keep the hub on loopback. Read the
[security model](#security-model) before changing its bind address.

### The screens

`/` is the **board**, made for a monitor watched from 1.5–2 m: one status sentence (`전부 정상` ·
`결재 N건` · `멈춤 N건` · `입력 대기 N건` · `Mac 보고 끊김 (N분 전)`), an 8 px frame (red > yellow > none), the left
panel (MAP, **HQ 대기**, 쉬는 중, **자리 비운 사이**), the project village in the middle (the ring town when WebGL
works, the 2D grid otherwise; `?scene=campus` draws the 3D campus instead) and **SESSIONS** on the right: each
project's Claude Code / Codex sessions with a terminal tail of their last commands. `#/detail` (key `D` flips
between the two) is the table view with Needs owner, Runs, Repos, Live sessions and Events.

The board only reads: it draws what the hub reports through `useHub` (GET + `/ws`, plus
`GET /api/runs/:machine/:id/events` for the current runs) and has no button or form. Approving, running or
re-running anything happens in Agent Office on the Mac; `scripts/no-run-actions.test.ts` scans
`apps/web/src/board/**`, `apps/web/src/campus/**` and `apps/web/src/town/**` (including the ported
engine's listeners) for it.

- **Current run.** Of several runs with the same `(project, workflow_id)` only the one with the latest
  `last_progress_at` counts (ties: higher `last_event_sequence`, then higher run id). The others show only
  in `#/detail`.
- **Sound** is synthesised (no audio files) and plays only while the cockpit is `online`, the screen is
  connected to the hub and it is not quiet time. Quiet hours default to 23:00–08:00 local time; change them
  in the page URL: `?quiet=22-7`, `?quiet=off`, `?sound=off`. No environment variable. Browsers refuse
  sound until the page has been interacted with, unless the kiosk browser allows autoplay.
- A run code that is not in the phrase table (`apps/web/src/board/copy.ts`) is shown as
  `확인이 필요합니다` plus the code on its card (`확인 필요` in 자리 비운 사이); the board never guesses what it
  means. `DISPATCH_STOPPED` and `PRESERVED_ON_HOLD` were checked against Agent Office's
  `server/pipeline/lifecycle.mjs` and have sentences.
- **Screen rules (design doc 07 §13, panels per decision D10 / doc 15).** One fact, one place: a 결재 sentence
  only on its HQ 대기 row, the newest report only in the one bubble at the HQ door. The panels are the original
  town's panels (`apps/web/src/style.css`; titles `MAP` `HQ` `PAUSED` `LOG` `SESSIONS` in the town's pixel
  font while the town runs). Text: the status sentence is the one big line (28 px); everything else is the
  panel scale, 10.5–14 px, times `?ui=1.15` or `?ui=1.3` (any other value is 1; for a monitor read from
  further away). Columns (`apps/web/src/board/layout.ts`): the stage picks its integer scale first (384×288 ·
  s under a 56 px top band), then the two panels share the rest, each 240–420 px — 384 / 1152 / 384 at
  1920×1080, 299 / 768 / 299 at 1366×768; the campus and the 2D grid use the same widths.
- **Left panel.** HQ 대기 rows are two lines: project, a short tag (`통합 대기`, `계획 승인`, `입력 대기`, …; Office's
  code stays in `#/detail`) and how long, then the sentence on one dim line; a 2 px yellow (결재 · 입력 대기) or
  red (멈춤) bar. At most 3 rows, then `외 N건`; they are never cut. 쉬는 중 rows have the same shape and no bar.
  자리 비운 사이 is one short dim line per item (`17:03 docs T3 통과`, at most 6, a `어제` divider where the
  date changes). When the column is short, mostly 자리 비운 사이 gives way (it shrinks 100:1 against 쉬는 중;
  each keeps one line), then the map.
- **SESSIONS (right panel).** Projects (결재 · 입력 대기 first, then working, then the most recent; at most 8,
  then `외 N곳`): a project row with its run's state (`리뷰 중`, `통합 대기`, `쉬는 중`) or its branch, and a thin
  phase bar while a run is running. Under it its sessions (`● Claude · opus 5.5  12초`; `입력 대기` / `쉬는 중`
  tags; `+N sub` while subagents run): `active`, `waiting`, and — dim, as `쉬는 중`, with no tail — `idle`
  or `stale` (15 quiet minutes) whose last activity is within 6 hours (no window light, no visit, as
  before); `ended` and older ones are hidden. A `waiting` session whose HQ visit is over (30 min, or
  `?session_wait=`) keeps a dim `입력 대기 · 42분` tag instead of the yellow one; the summary's `대기 N`
  counts only the yellow ones. At most 4 sessions a project and 16 in all, then `외 N`. Under an `active`
  or `waiting` session a monospace tail of its last commands and files (`$ bun test ×3`, `Edit src/a.ts`,
  `→ reviewer: …`, `› 입력 (412자)`, `■ 턴 끝`; at most 6 tails of 3 lines, 2 under 1600 px). A command
  loses its leading `NAME=…` / `export …`, `cd … &&` / `cd …;` and a `( … )` group; an inline script
  (`-c` after a shell or Python, `-e` after bun / node / …) or a heredoc fed to an interpreter shows as
  `$ python3 (스크립트)`, a heredoc fed to another program as the command up to it
  (`$ git commit -m (스크립트)`). The hook keeps only 80 characters of
  a command, so when the prefixes fill them the line is `$ S=…`. The tail is built from the events the
  board already holds (`/api/events?limit=200` + ws `event`; no new request), from `summary` only, redacted
  again, with every absolute path made relative to the session folder or cut to its last parts; the screen
  remembers each session's last 3 lines (64 sessions at most, ended ones dropped) so a busy session no
  longer pushes a quiet one's tail away. Command output and prompt text are not in the hub, so they are
  never shown. The panel never scrolls: tails fold first (old waits, then the oldest `active`), then rows
  (resting first), then projects.
- **The village** stands at most 8 project buildings, by recent activity (a flagged one always stands);
  the rest fold into one `조용함 N곳` sign. A building holds its name and pictures only: lit windows for
  running runs (dark when nothing runs), a big yellow (결재) or red (멈춤) flag. The village dims and every
  figure stops when the cockpit or this screen's hub connection goes quiet.
- **The ring town** (`apps/web/src/town/`, the default middle scene, a lazy chunk with `three`) is the
  owner's Agent Borough ring town (Agent Office Town M3.0–M3.2a): its low-res renderer is copied into
  `apps/web/src/town/engine/` (origin commit, files and every changed line in `engine/PROVENANCE.md`) and
  driven from the same model. A ring boulevard around a plaza with the leaderboard pylon (`AGENT CITY`,
  one row per project with its 진행 and 대기 counts, `ALL` totals, `OFFLINE` and `—` when the Mac stops
  reporting); HQ is one lot, the
  cafe another, the other eight are project buildings, filled clockwise in the grid's order and kept while
  a project stays shown (empty lots are boarded `COMING SOON`). A building's sign is its name on a lit board
  (about 8 characters; signs, pylon rows and the map's 3-letter labels are shortened so no two read alike);
  its door lamp
  is red (멈춤) > yellow (결재 / 입력 대기) > green (running) > off; lit windows = running runs + active
  sessions (at most 4). The kangaroo is the owner (drawn while the cockpit is `online`): it patrols the
  boulevard (about 4 min a lap); when a 결재 lead reaches the HQ door it walks back and the camera holds a
  close shot of the door and the queue for 5 minutes from that arrival, then the patrol resumes while the
  lead keeps standing at the door (a new 결재 arriving brings it back for 5 minutes); leads queue at the
  door in the HQ 대기 row order, reports
  come and go without stopping the patrol, and the one bubble at the HQ door is above the stage. A reload
  never replays a walk. `?time=day|dusk|night` pins the look (otherwise the local hour: day 07–17, dusk
  17–20, night 20–07). The map at the top of the left column shows the lots, their lamps and the kangaroo;
  it gives way to the HQ 대기 rows (after 자리 비운 사이 and 쉬는 중 are down to one line) and hides only below
  64 px.
  Reports stopped: everything stands still; reduced motion: the kangaroo at the HQ and a fixed wide shot of
  the plaza and the pylon. The
  picture is 384×288 at an integer scale (narrowed to keep 2× on a 1366×768 screen). Same fallbacks as the
  campus: no WebGL, a missing chunk or a lost context → the 2D grid.
- **The 3D campus** (`?scene=campus`; `apps/web/src/campus/`, a lazy chunk with `three`) draws the same model: a fixed
  panorama camera (it never moves or follows anything), building names only, the lead walking to the HQ
  for a 결재 (folder = 승인 대기, binder = 멈춤) or a report and walking back when it ends, the owner at the
  HQ desk while the cockpit is `online` (an empty chair otherwise), the one bubble at the HQ door, and
  evening colours (a little darker during the `?quiet=` hours), working buildings lit warm from inside. It
  has no pointer or keyboard input. Without WebGL, if the scene chunk cannot load, or if the GPU context is
  lost, the 2D tile grid is shown instead.
- **60 s rule (decision D3).** A 결재 or 멈춤 counts — HQ visit, knock, border colour, building flag and
  the status sentence — only once the run has stayed in that state (same code) for 60 s, so running goal →
  plan → approve on the Mac does not knock at every step. A state the screen saw change counts from when
  it saw it; one it finds on opening counts from Office's `last_progress_at`. Reports are not held back.
- **When the Mac stops reporting (07 §7, 08 Q4).** From the moment the cockpit stops counting as
  `online`, the whole village stands still: no 결재, 멈춤 or session visit starts, none that was there
  leaves because time passed (a session keeps its visit past its 30 minutes), the border keeps its colour
  and nothing sounds. Reports that still arrive (the exporter runs apart from the heartbeat) are drawn
  only once the Mac is back, and a 60 s count that had not finished starts again from zero then.
- **Paused runs (decision D2).** `paused` (Office's loop ended for the day with tasks left) is not a 결재:
  no visit, no border, no sound, its building dark with the lead inside. It is listed under HQ 대기 as
  `쉬는 중 · 이어서 실행 필요` with `오늘 몫은 끝났습니다. 남은 작업이 있습니다.` The first time the quiet hours end
  after it paused (08:00 by default, the `?quiet=` end hour), the board knocks once — once per
  paused run per day. A morning that passes while the board may not sound (cockpit offline, `?sound=off`)
  or before the page was opened is not made up later.
- **Sessions (decision D4).** Claude Code / Codex sessions from `GET /api/sessions` and ws `session` (no
  new request): a repo with a session active in the last 7 days gets a building (`local/<dir>` too; the
  name tag is the part after the slash; a session outside any checkout raises none). Lit windows =
  running runs + `active` sessions, at most 4. SESSIONS (above) lists them by project. A session `waiting`
  for input for 60 s sends its lead to the HQ:
  `입력을 기다리고 있습니다.`, one knock (no 30-minute reminder), yellow border; visit id `session:<id>`.
  30 min after the wait began the visit ends (no sound, no border afterwards; its `입력 대기` row stays in
  SESSIONS — decision D10 removed the separate `기다리는 세션` list). Change the 30 min in the page URL: `?session_wait=45`; `?session_wait=0` turns
  session visits off. `idle`, `stale` and `ended` sessions light
  nothing and visit nobody; an `active` session silent for 15 min is `stale` by the screen's clock. While
  the cockpit, or the session's own machine, is not reporting, session visits stand still (see below).
  Known limit: the dispatcher's own Claude runs carry the same hook, so a run and its session can both
  light a window in the same building (the cap of 4 holds).
- **`?demo=1`** draws the board from made-up data (`apps/web/src/board/demo.ts`, every name `demo/…`, in
  its own lazy chunk that the live page never loads) so it can be looked at without a running Office. It opens no hub connection, plays no sound and says
  `예시 데이터` in the top band. Without `?demo=1` only hub data is ever shown. `&case=calm` shows a day with
nothing waiting for the owner, `&case=busy` many sessions (the right panel's caps and folds).

### Serving the web UI from the hub

To run with one process (no Vite dev server), build the UI once, then start the hub alone:

```sh
bun --filter '@agent-city/web' build   # → apps/web/dist
bun apps/hub/src/index.ts              # UI + API on http://127.0.0.1:4317
```

The hub serves `apps/web/dist` (override with `AGENTCITY_WEB_DIST`) on its own port, behind the same
`Host`/CORS checks as `/api`. Without a built `index.html` it logs one line and serves the API only,
as before. This does not change the bind address (`127.0.0.1` by default) or any auth.

Limits:

- Source maps (`*.map`, `*.map.*`) are never served, even when the build emits them into dist.
- Hub route prefixes (`/api`, `/ingest`, `/ws`, `/healthz`) never fall back to `index.html`, also
  when disguised (`//api`, `/%2Fhealthz`, `/%2e/api`, `/api%2Fnope`, any case); their misses stay a
  plain 404. Only clients that list `text/html` with q > 0 get the `index.html` fallback.
- The dist dir must be writable only by the owner: the hub trusts its contents, and symlink aliases
  inside dist are followed as long as they resolve inside dist.

Collectors on cockpit:

```sh
bun run collector:hooks      # prints a merged ~/.claude/settings.json + diff — never writes ~/.claude
# review, back up, apply by hand (the command prints these):
#   diff -u ~/.claude/settings.json ~/.agentcity/claude-settings.merged.json
#   cp ~/.claude/settings.json ~/.claude/settings.json.bak.$(date +%s)
#   cp ~/.agentcity/claude-settings.merged.json ~/.claude/settings.json
bun run collector:codex      # resident Codex tailer (keep it running in a terminal)
bun run collector:heartbeat  # resident machine heartbeat, every 30 s (keep it running in a terminal)
```

Hooks load when a Claude Code session starts — open a new session after applying.

## Development and checks

Run from the repository root:

```sh
bun run typecheck
bun run lint
bun test
bun run check:secrets
```

The test suite covers schema/IDs/redaction, collector mapping and spooling,
hub ingestion and ordering, GitHub integration logic, web-state merging, and
documentation parity. These checks do not by themselves prove a live
multi-machine deployment or provider session compatibility. `main` currently
has no GitHub Actions workflow; run the checks locally for the change under review.

**Screen check (`check:board`).** `bun run check:board [ab1|ab2|ab3|all]` drives the board in
headless Chrome through the `agent-browser` CLI and reads numbers off the page: `ab1` (default)
checks the column rule, the panel text scale, scroll, the 자리 비운 사이 rows, HQ rows, the SESSIONS caps
(no absolute path in a tail, no scroll in the right panel), the demo label, console errors and the `D`
detail round trip, at 1920×1080 and 1366×768, live and `?demo=1` (add `?ui=1.3` to the URL to check
the larger text); `ab2`
watches the live board for 90 s and checks that it sends only GETs to loopback and opens one
`/ws`; `ab3` repeats the 1920×1080 cases with WebGL off (the 2D tiles fallback). It is read-only:
loopback only, no browser profile, no AI features. The scripts are in `scripts/board-check/` and
add no dependency. It checks whatever answers on `http://127.0.0.1:4317/`; on the cockpit that is
the tunnel to the hub on spine, so it sees the deployed build, not an unmerged worktree. To check a
change before it ships, run the web dev server on another port (it proxies `/api` and `/ws` to the
hub) and set `AGENTCITY_BOARD_URL` (`http://127.0.0.1:<port>/…` only), e.g.
`AGENTCITY_BOARD_URL='http://127.0.0.1:5181/' bun run check:board` (the town, the default scene; add
`?scene=campus` for the 3D campus). A query in the URL is
kept and the cases add their own (`demo=1`). `ab1` and `ab3` are the checks to run against a dev
server; `ab2` needs a built page (it reads the `/assets/index-*` chunk names, and the dev server's
HMR WebSocket would count as a second socket), so point it at the hub-served build or at `vite preview` (`cd apps/web && bun run build && bunx vite preview --port 5184 --strictPort`; it inherits the dev proxy to the hub and passes). Captures and `result.json` go
to `~/Documents/AgentCityCaptures/ab/` (outside the repo; `AGENTCITY_AB_OUT` may pick another
folder under it). A `FAIL` makes the command exit 1; `KNOWN` marks an accepted limit and does not.
Without `agent-browser` on `PATH` the check is skipped, says so, and exits 0; this repo never
installs it. It cannot judge the physical RX screen or the knock; look at those there.

## Running the tests on Windows

The Claude hook launcher (`apps/collector/bin/claude-hook`) is a POSIX `sh` script, so the
collector tests that drive it, or that need `mkfifo`, cannot run on Windows. They use
`posixOnly` (`test.skipIf(process.platform === "win32")`, in `apps/collector/src/posix-only.ts`)
and show up as **skipped** on Windows, with the reason in a `// POSIX-only:` comment above each.
On macOS / Linux they run as before.

| Test file | Test | Reason | Status |
| --- | --- | --- | --- |
| `apps/collector/src/claude-hook.test.ts` | bin/claude-hook → hub receives a whitelisted event with the bearer token | spawns the `#!/bin/sh` launcher | skipped on Windows |
| `apps/collector/src/claude-hook.test.ts` | hub unreachable → event lands in the spool, exit 0 | spawns the `#!/bin/sh` launcher | skipped on Windows |
| `apps/collector/src/audit.test.ts` | FIFO .git/config, symlinked .git, oversized HEAD → no block, no git info from them | `mkfifo` + unprivileged directory symlink (the oversized-HEAD check is skipped with it) | skipped on Windows |
| `apps/collector/src/audit.test.ts` | launcher kills a stalled hook: fifo-config and 900K command exit 0 under 700ms | `sh` launcher (`sleep` + `kill -9`) and `mkfifo` | skipped on Windows |
| `apps/collector/src/audit.test.ts` | even a synchronously stuck process is killed by the launcher (<700ms) | `sh` launcher + fake `#!/bin/sh` bun made executable by mode bits | skipped on Windows |
| `apps/collector/src/audit.test.ts` | stdin held open + hub hanging: exit 0 under 700ms and the event is spooled | `sh` launcher's SIGKILL deadline | skipped on Windows |
| `apps/collector/src/claude-hook.test.ts` | (file-level `HOOK` / `BIN` paths) | built as `${import.meta.dir}/…`; now `node:path` `join` | fixed (unconfirmed) |
| `apps/collector/src/audit.test.ts` | (file-level `BIN` path) | built as `${import.meta.dir}/…`; now `node:path` `join` | fixed (unconfirmed) |

This list was derived by reading the code on macOS; the Windows run has not been repeated. The
earlier Windows run reported 8 collector failures. The 6 skips above are certain from the code.
The 2 path-separator failures could not be pinned down by reading: the only hard-coded `/` path
builds in the collector tests are the `HOOK` / `BIN` constants (fixed above), and the `gitInfo`
worktree test passes when its path steps are replayed with `path.win32`. Re-run `bun test` on
Windows to confirm.

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
| `OFFICE_PROJECTION_TOKEN`  | hub            | Separate secret for `POST /ingest/runs`, held only by the cockpit. Unset or equal to `INGEST_TOKEN` → disabled (503). |
| `HUB_URL`                  | collector, web | Where collectors POST and the Vite proxy points.                                         |
| `AGENTCITY_WEB_DIST`       | hub            | Built web UI served on the hub port (default `apps/web/dist`; relative = repo root).     |
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
| `AGENTCITY_BOARD_URL`      | `check:board`  | Page the screen check opens (loopback only; default `http://127.0.0.1:4317/`). Process env only. |

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
| `typecheck`                   | `tsc --noEmit` for schema, hub, collector and web.                               |
| `sync:github`                 | One GitHub sync + summary (repos, private/archived/fork, CI, local mapping, rate). |
| `db:reset`                    | Stop the hub first. Moves `DB_PATH` (+ `-wal`/`-shm`) to `<db>.bak.<UTC stamp>` and creates an empty, migrated DB. `--db <path>` overrides. |
| `db:backup`                   | Hub may keep running. Consistent dated copy of `DB_PATH` into `<data dir>/backups/`; `--keep N` prunes. See [Backing up the database](#backing-up-the-database). |
| `districts:draft`             | Writes `config/districts.draft.yaml` (all repos by district; gitignored).        |
| `collector:hooks`             | Print-only merge of the Claude hook into `~/.claude/settings.json`.              |
| `collector:codex`             | Resident Codex log tailer (also drains the spool every 5 s).                     |
| `collector:heartbeat`         | Resident machine heartbeat: one beat every 30 s to `POST /ingest/heartbeat`.     |
| `collector:launchd`           | Print-only: launchd job files for the Mac's resident processes → `~/.agentcity/launchd/`. See [Mac login jobs](#mac-login-jobs-launchd). |
| `check:secrets`               | Scan tracked/untracked files for token patterns. Run before every commit.        |
| `check:board`                 | Screen check of `127.0.0.1:4317` (or `AGENTCITY_BOARD_URL`) through `agent-browser` (skipped without it). See [Development and checks](#development-and-checks). |

**Machine heartbeat.** `collector:heartbeat` (run on each machine with `AGENTCITY_MACHINE` =
`cockpit` / `forge` / `spine`) sends a beat every 30 s; `GET /api/machines` and the *Machines* strip
show each machine's last beat and state. This is a **machine** fact, not whether any AI work
succeeded. Only the hub's receive time counts (the sender's clock is ignored).

| State        | Meaning                                              |
| ------------ | ---------------------------------------------------- |
| `online`     | last beat received less than 90 s ago                |
| `stale`      | 90 s or more, but less than 10 min                   |
| `offline`    | 10 min or more (a closed laptop is normally this)    |
| `unobserved` | nothing ever received (e.g. forge before it is set up) |

`POST /ingest/heartbeat` uses the same `INGEST_TOKEN` bearer as `/ingest` (no token configured → 503,
wrong → 401), takes a strict JSON body of at most 4 KiB (`schema`, `machine_id`, `hostname?`,
`boot_id`, `seq`, `sent_at`, `interval_s`; any other key → 400, a machine other than
cockpit/forge/spine → 400) and answers `{accepted}`. A repeat or out-of-order beat of the same
`boot_id` is ignored (`accepted:false`); a new `boot_id` counts as a restart. Failed sends are
dropped, not queued. The sender needs no new variable (`HUB_URL`, `INGEST_TOKEN`, `AGENTCITY_MACHINE`).

Known limits of the heartbeat (by design, not bugs): the screen re-derives each state with the
*viewer's* clock against the hub's receive time, so a viewer clock off by several minutes shows the
wrong state; only the latest `boot_id` per machine is remembered, so a replayed beat of an older
boot is taken as a restart (a sender needs the ingest token either way); while `/ws` is down the
strip keeps ageing its last snapshot toward `offline` even if the hub still receives beats; after
`db:reset` reload the page, because a fresh `unobserved` row never overwrites a machine already seen.

**Runs (Agent Office → City, read-only).** The cockpit's Agent Office exporter pushes a picture of its
runs to `POST /ingest/runs` every 30 s; the *Runs* and *Needs owner* sections show them, each with
"`<machine>` report · N s ago". City **stores and shows what it was told**; it never approves, launches
or retries anything (there is no such route or control, and a test fails if one appears). Office's
values are kept verbatim; the only thing City adds is the receive time and `snapshot_stale`:

| Shown                   | When (decided by Office unless noted)                                            |
| ----------------------- | -------------------------------------------------------------------------------- |
| `running`               | `RUNNING`, no alert                                                              |
| `no progress suspected` | alert `STALE_OR_IDLE` — an alert, **not** a failure                              |
| `needs reconcile`       | alert `FAILED_PROCESS_RECONCILE` or `MISSION_RECONCILIATION_REQUIRED`            |
| `waiting for owner`     | `READY` with `GOAL_RECORDED` (goal on record, no plan yet), `AWAITING_PLAN_APPROVAL`, `AWAITING_OWNER_INTEGRATION`, `DRAFT_REQUIRES_OWNER_COMMIT` or `PLAN_APPROVED` |
| `paused`                | `READY` with `DISPATCH_STOPPED` — Office's loop stopped **without a failure** and tasks are left. Not in *Needs owner*. The same reason after a failed loop arrives as `HOLD` and stays `hold` |
| `hold` + reason         | `HOLD`                                                                           |
| `passed` / `partial`    | `PASS` / `PARTIAL`                                                               |
| `unverified`            | evidence not verified **and the run reads as `passed` / `partial`** — such a run is never shown as passed. A run still in progress (running, waiting, paused, hold…) keeps its own state — a new run has no signed event yet and is reported unverified for that reason alone. The alert `EVIDENCE_UNVERIFIED` (Office could not read the evidence) still wins for every run |
| `unknown`               | a combination not in this table (never guessed)                                  |
| `snapshot stale` (City) | no report for 90 s (three missed sends) **or** the cockpit machine is `offline`; shown as "last report: running (N min ago)". A finished run stays as reported. |

`POST /ingest/runs` takes `Bearer $OFFICE_PROJECTION_TOKEN` (not the collector `INGEST_TOKEN`: that one
is refused with 401), a strict snake_case JSON body of at most 256 KiB, and only from `machine_id:
"cockpit"` (any other machine → 403). Every string is an allowlisted short code: `status` / `reason` /
`alert` are UPPER_SNAKE, ids and event codes start with a letter or digit and hold no `/`, `\`, space,
`..` or drive letter, `phase` is exactly one of Office's nine pipeline phases (Goal, Plan, Approval,
Implementation, QA, Independent Review, Integration, Cleanup, Report), `project` is a GitHub
`owner/repo` (repo may start with `.` as in `.github`; not `.`/`..`, no `.git` suffix, no second `/`);
anything secret- or opaque-token-shaped (a known token prefix, `Bearer …`, a long random-looking run)
is refused (`project` gets the token-prefix checks only: long ordinary repo names are valid).
So a goal text, a path, a session key or a token has no field and is a 400 (the value is never echoed).
Reports are ordered by `(ledger_revision, last_event_sequence)`; at the same position only a strictly
newer `observed_at` applies (compared exactly: below the millisecond, offsets applied). An older or
equal report — a resend or a replay — is ignored and does not refresh the receive time.

Known limits of the run projection (by design, not bugs):
- Input is snake_case only; a camelCase key is an unknown key (400).
- A value City cannot represent safely (a path, prose, a token-shaped or opaque string) is rejected,
  and so is the whole report, rather than stored truncated or masked.
- `commit_on_remote` (joining a passed run to the GitHub sync) is not implemented.
- A holder of the Office token can assert PASS/evidence_verified; City mirrors the cockpit's report and does not verify signatures.
- Hub clock moving backwards can make elapsed time briefly wrong.
- `phase` is a closed list mirrored from Office: a phase Office adds needs a City release, and until
  then every report carrying it is rejected.
- A two-part name like `ssh/id_rsa` as `project` has a legitimate `owner/repo` shape and cannot be
  told apart from a real repository.

**Ids.** Sessions are `claude:<session_id>` / `codex:<session_id>`; the main agent shares the session
id; a subagent is `<session id>/sub:<tool_use_id>` (one function set in `packages/schema/src/ids.ts`,
used by both collectors and the hub — the hub also upgrades events spooled by an older collector).
A DB created before this namespace holds raw ids; run `bun run db:reset` once (nothing is deleted).
Repo ids are compared case-insensitively (`repoKey`); references stored under another casing are
re-pointed to the GitHub row at ingest and after every sync.

Districts: edit `config/districts.yaml` (`district: [owner/name | name, …]`, case-insensitive; unlisted
→ `uncategorized`). `bun run districts:draft` gives a starting point.

## Backing up the database

```sh
bun run db:backup              # → data/backups/agentcity.db-YYYYMMDD-HHMMSS.db (UTC)
bun run db:backup --keep 14    # same, then delete all but the 14 newest backups of this DB
```

- Safe while the hub runs: the copy is a SQLite `VACUUM INTO` snapshot (committed rows only), not a
  file copy. It is written inside a private `0700` staging dir that the run creates in `backups/`,
  checked (`integrity_check`, same schema version) and only then hard-linked to its final name; an
  existing backup is never overwritten and the staging dir is removed afterwards. Run it before
  every upgrade.
- The source is never opened read/write. If the hub is stopped and the DB's `-shm` is gone, the DB
  and its `-wal` are copied into the staging dir and the snapshot is taken from that copy, so the DB
  and its `-wal` / `-shm` are left byte-for-byte as they were.
- The DB is `--db <path>` | `DB_PATH` | `./data/agentcity.db`; backups go to `backups/` next to it
  (`0700`, files `0600`; an existing `backups/` you own is tightened to `0700`, one owned by another
  user is refused). `--dir <name>` picks another subdirectory of that data dir; a directory (or
  symlink) that resolves outside the data dir is refused. A DB path whose file name has leading or
  trailing whitespace or a control character is refused.
- Backup names keep the full DB file name: `<db file name>-YYYYMMDD-HHMMSS.db`
  (`agentcity.db-20261111-010203.db`, `agentcity.sqlite-…`). Output never prints the raw DB name
  if it looks like a secret (it goes through `redact`).
- `--keep N` (1–365) only counts and deletes regular files named exactly
  `<db file name>-YYYYMMDD-HHMMSS.db` — never a symlink, never the live DB itself, never the file
  just written. Anything else in the folder (notes, other `.db` files, backups of another DB name,
  older `agentcity-YYYYMMDD-HHMMSS.db` names, a leftover `.tmp`) is left alone. A prune failure is
  reported but does not fail the backup.
- **Restore:**
  1. Stop **every** process that opens the DB: the hub **and** `sync:github` or any other tooling
     that reads or writes `DB_PATH`.
  2. Keep the current DB: rename `agentcity.db` and its `-wal` / `-shm` (if present) to
     `agentcity.db.old-<timestamp>`, `agentcity.db-wal.old-<timestamp>`, … — rename, don't delete.
  3. Copy the backup to a staged name in the data dir (e.g. `agentcity.db.restoring`), then rename
     it to `agentcity.db`.
  4. Start the hub and check it (`/healthz`, the UI shows the expected sessions).
- A backup holds the same data as the DB, so protect the data dir like the DB itself. It sits on the
  same disk — not a substitute for off-machine copies.
- Limits: the data dir (and `backups/`) must be writable only by its owner. A local user who can
  replace the backups dir or the staging dir during a run can redirect it; the script does not
  defend against that. Publishing uses a hard link, so `backups/` must be on a filesystem that
  supports hard links (it is inside the data dir, so the same filesystem as the DB).
- Known limits (not bugs): when the hub is stopped and the DB has no `-shm`, the DB and its `-wal`
  are copied one after the other without a lock, so **keep the hub (and `sync:github`) stopped until
  the backup has finished** — a process that starts and checkpoints between the two copies could make
  a committed row missing from the snapshot, and the integrity check cannot see that. Redaction of a
  DB name that is token-shaped is best-effort (a token glued to a letter may print). Inherited
  filesystem ACLs (macOS) are not inspected; only the Unix mode bits are set.

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
   ssh -N -L 4317:127.0.0.1:4317 cockpit     # run on forge/spine; autossh / launchd to keep it up (Mac: see Mac login jobs)
   ```
4. `bun run collector:hooks` **on that machine** (the hook path is absolute and per-checkout), review,
   back up, apply; `bun run collector:codex` if Codex runs there.
5. While the tunnel is down, events land in `~/.agentcity/spool.jsonl` and are sent in order later.

## Mac login jobs (launchd)

The cockpit Mac runs four resident processes: the SSH tunnel to the hub, `collector:heartbeat`,
`collector:codex` and the Agent Office run exporter. `collector:launchd` makes them start at login. It is
**print-only**, like `collector:hooks`: it writes one job file per process into `~/.agentcity/launchd/`
and prints the commands; copying the files into `~/Library/LaunchAgents` and loading them is yours to do.

```sh
# from the main checkout (the checkout path is baked into the files)
bun run collector:launchd -- --tunnel-target <user@host-or-ssh-alias> \
                              --office-dir <Agent Office checkout that has scripts/city-export.mjs> \
                              --office-home <state home that recorded your runs> \
                              --project <worktreeId>=<owner/name>
```

| Flag | Meaning |
| ---- | ------- |
| `--tunnel-target` | SSH target of the hub host. Without it the tunnel job is skipped. Never committed anywhere. |
| `--ports` | Forwarded loopback ports, default `4317,5173` (what the running tunnel forwards). |
| `--office-dir` | Checkout whose `scripts/city-export.mjs` is the exporter. Without it the exporter job is skipped. |
| `--office-home` | The Office state home the exporter reads (`city-export --home`). Without it the exporter reads its own default (`~/.agent-office`), which may not hold your runs, and the generator says so. Absolute path. Needs `--office-dir`. |
| `--project` | `<worktreeId>=<owner/name>`, repeatable, passed to the exporter as `--project` (same shape it accepts). Needs `--office-dir`. |
| `--office-env` | File with `OFFICE_PROJECTION_TOKEN=…`, default `~/.agentcity/office-projection.env`. |
| `--hub` | Hub URL the exporter posts to, default `http://127.0.0.1:4317`. |
| `--out-dir` | Must be inside `~/.agentcity`; `~/Library/LaunchAgents` and `~/.claude` are refused. |

- **No secret is written.** The heartbeat and the tailer read this checkout's own `.env` when they start. The
  exporter job runs `sh -c '. <env file>; exec node scripts/city-export.mjs …'`, so the token is read when the
  job starts; the generator never opens that file. `--office-home` and `--project` are passed to the
  exporter as separate arguments after `--hub`, never spliced into the shell text. The generator warns when
  `<office-dir>/scripts/city-export.mjs` does not exist; the job would then exit and be retried every 10 s.
- **Stop the terminal copies first** (the printed list says which). Two tunnels fight over the port, two Codex
  tailers share one offsets file, two heartbeats flap `boot_id`.
- **The tunnel runs with `BatchMode=yes`**, so it needs a key that works without a prompt. On the cockpit Mac the
  only key is `~/.ssh/id_ed25519` with no passphrase and the GUI session has an `SSH_AUTH_SOCK`, so launchd can use it;
  the first `launchctl bootstrap` is what confirms the host accepts it. `ExitOnForwardFailure=yes` makes a failed
  forward end the job so launchd restarts it.
- **Stopping the tunnel on purpose** (for example to test a disconnect): `launchctl bootout gui/$(id -u)/local.agentcity.tunnel`;
  `launchctl kill` would just be restarted (`KeepAlive`). Start it again with `launchctl bootstrap …`.
- Logs: `~/.agentcity/logs/<job>.log`. Jobs restart at most every 10 s (`ThrottleInterval`).

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
- Back up the DB nightly with `bun run db:backup --keep N` (and copy `data/backups/` off the machine).

## Board kiosk on spine (RX) — scripts only, not applied

The board is meant to stay on the RX 6600 monitor of spine, full-screen, with nobody at the keyboard.
Two PowerShell scripts in `scripts/kiosk/` prepare that; neither has been run on spine yet.

| Script | What it does |
| ------ | ------------ |
| `start-board.ps1` | Waits for `GET http://127.0.0.1:4317/healthz`, then opens Edge (or `-Browser chrome`) in kiosk mode on the hub-served board with `--autoplay-policy=no-user-gesture-required` (so the 결재 knock can play without a click) and its own profile. Loopback URLs only. `-DryRun` prints the command. |
| `install-board.ps1` | **Print-only by default.** Lists what it would set up: a Scheduled Task *AgentCity Board* that runs `start-board.ps1` at the current user's logon (interactive), display-off / sleep / hibernate never on AC (`powercfg`), screen saver off for that user. `-Apply` makes the changes; `-Uninstall -Apply` removes the task. |

```powershell
# on spine, after building the web UI and starting the hub (see "Serving the web UI from the hub")
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\kiosk\start-board.ps1 -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\kiosk\install-board.ps1          # review
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\kiosk\install-board.ps1 -Apply   # owner
```

- **Logon.** The hub and heartbeat tasks run without a logged-on desktop (S4U) and cannot show a
  window, so the board task runs at logon. Without Windows automatic logon the board appears only after
  someone logs in after a reboot. Automatic logon stores a password and is the owner's decision (design
  doc 07 §12.1); the scripts never enable it.
- **Sound.** Whether Edge/Chrome on spine actually plays the knock with the autoplay flag is not yet
  confirmed (doc 07 §5). Quiet hours and muting stay in the URL: `-Url "http://127.0.0.1:4317/?quiet=23-8"`.
- **Burn-in.** The board itself moves its top band by 1–2 px every 3 minutes (a slow loop, never more
  than 2 px from where it started; `apps/web/src/board/burnin.ts`).

## Security model

- GitHub is read-only: REST `GET` only; GraphQL is `query`-only (mutations are rejected before sending).
- Hub on loopback; every request's `Host` must be `127.0.0.1` / `localhost` / `[::1]` / `HUB_HOST`
  (DNS-rebinding guard). `/ws` also rejects foreign `Origin`s; CORS echoes allowlisted origins only.
- `/ingest` needs `Bearer $INGEST_TOKEN` (constant-time compare). `/api` and `/ws` are read-only and
  unauthenticated — fine on loopback, not for a network bind.
- `/ingest/runs` needs a **different** token, `Bearer $OFFICE_PROJECTION_TOKEN`, held only by the
  cockpit, and accepts only `machine_id: "cockpit"`. A forge or spine collector (which has
  `INGEST_TOKEN`) therefore cannot post a forged `passed`. City cannot verify Office's signatures, so
  every run is shown as *reported* with its age.
- `/ingest` takes at most 500 events per request (`MAX_INGEST_BATCH`; more → 413) inside a 5 MiB
  body; collectors send in chunks of exactly that size.
- The "no `/Users/` path" rule covers the run tables only (`runs`, `run_events`; `apps/hub/src/runs.test.ts`).
  Session and event rows keep the working folder and file paths by design (prompt text is never stored,
  secrets are masked). The board never draws a session's folder, branch or model — only its repo name
  (`scripts/no-run-actions.test.ts` checks the board code never reads `.cwd` / `.branch`).
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
| Session repo shows `local/<dir>`          | No github.com repo: `origin` is elsewhere, or there is no `origin` and not exactly one github.com remote. |

## Roadmap

The following work is planned, not implemented by the telemetry layer above.

1. **Workflow foundation:** define work items, pipeline stages, ownership,
   transitions, and completion evidence before adding agent control. Keep
   observation distinct from commands and approvals.
2. **Reliable multi-machine tracking:** collector-reported `repo_paths`, machine
   presence, and service/tunnel lifecycle management. The setup instructions above
   describe how to run collectors; they do not imply every machine is deployed.
3. **Permissioned control:** progress from read-only observation to notifications,
   then explicit per-action approval for local agent actions. GitHub remains
   read-only unless a separate decision changes that scope.
4. **Live city view:** an R3F (React Three Fiber) scene with districts, repository
   buildings, and agents, retaining the 2D view for debugging.
5. **Event delivery:** evaluate GitHub push/workflow webhooks, with polling as the
   fallback. Webhooks would need a public endpoint or relay.

### Known gaps and deferred work

- Codex subagents (`spawn_agent`) are not represented as separate agent rows;
  there is no reliable end signal yet
- Tool events inside a Claude subagent are attributed to the main agent because
  the internal agent ID cannot be matched to the Task call
- A rejected ingest batch is parked as a whole; bisecting it to isolate one bad
  event remains work to do
- Deleted/inaccessible GitHub repos remain with stale `synced_at` values
- CI status uses the latest run on any branch; default-branch-only badges remain
  deferred
- A configurable Host allowlist and auth on `/api` and `/ws` are needed before
  exposing a hub beyond loopback
- Service units for the hub, Codex tailer, and SSH tunnels remain to be added
- Old token-scoped `github_etags` rows are not automatically pruned
- Board width: the stage takes exactly 384 × its scale (1152 px = 60% at 1920; 768 px = 56% at 1366).
- SESSIONS tails are remembered per session on the screen (3 lines, 64 sessions), but only from what the
  200-event window showed while the board was open: after a reload, or a trip to the detail tables and
  back, a quiet session's tail is back only if its events are still in the window. `+N sub` is counted in the window alone; a subagent sent to the
  background is not counted. A command longer than the hook's 80 characters is cut there (`$ S=…`).
- At 1366×768 with a long HQ waiting list, 자리 비운 사이 keeps only its newest line (RX is 1920×1080).
- Board known limits: open P2s from the Codex reviews of `feat/board-sessions` (line numbers as of
  `0855f2b`). Accepted for now; if the kiosk shows a real miss, the dwell logic is to be reworked as
  one function rather than patched piece by piece.
  - P2-1 `sessions.ts:282`: a wait's start is kept only in screen memory, so after a reload a later
    `Notification` becomes the start (a second knock, and the list move at 50 min instead of 30).
  - P2-2 `sound.ts:166`: a visit that starts inside the 5 s settle window gets no knock, then or later.
  - P2-3 `visits.ts:266`: a run seen for the first time is timed from `last_progress_at`, so a
    long-stuck run shows its visit and border at once instead of after 60 s.
  - P2-4 `visits.ts:89`: a model built without the watch cannot restart the 60 s count on return (the
    Board always passes one, so the screen is not affected).
  - P2-5 `sound.ts:147`: the morning knock leaves out the exact boundary (`pausedSeen < due.end`), so a
    run first received at exactly 08:00:00 gets none that morning.
  - #1 `sessions.ts:157`: heartbeats the screen missed (skipped ticks) are taken for an outage and
    restart the count, so a visit that is already due waits up to 120 s more.
  - #2 `sessions.ts:209`: an outage that falls between two skipped ticks resets a count that had
    already finished.
  - #3 `sessions.ts:211`: elapsed time is a wall-clock difference, so a clock set back delays the
    60 s rule.
  - #4 `sessions.ts:259`: without a reload, the 30 min move is counted from the first wait, not from a
    later last activity.
  - #5 `sessions.ts:212`: a visit that was unfinished at the last tick before stale can start while
    stale.
  - #6 `model.ts:270`: while stale, a new run state is applied as it comes, which removes an existing
    결재 visit and border.
  - #7 `visits.ts:330`: report visits do not go through the offline gate, so one can appear or expire
    while stale.
  - #8 `sessions.ts:61`: the 7-day cutoff is applied while offline and can remove a standing session
    visit.
  - #9 `sound.ts:153`: if the screen misses every tick of an outage in a background tab, a morning
    knock that fell due during it sounds as soon as the cockpit returns.
  - #12 `App.tsx:325` (the detail screen, older than this branch): the tooltip of a session row without
    `repo_id` shows its `cwd`.
