# Managed runs v0.1.1 — verification log

All runs use disposable state: temporary `HOME` / `AGENTCITY_HOME`, mkdtemp fixture repos,
in-memory or temp SQLite, port 0 / dedicated loopback ports. Never the real `.env`, DB or :4317 hub.

## Phase 0 baseline (base `923854d`, my run)

| Command | Result | Duration |
| --- | --- | --- |
| `HOME=<tmp> AGENTCITY_HOME=<tmp> bun test` | PASS 461 / 0 fail | 37 s |
| `bun run lint` | PASS | <1 s |
| `bun run typecheck` | PASS | ~5 s |
| `bun run check:secrets` | PASS | <1 s |
| `(cd apps/web && bunx vite build)` | PASS | <1 s |
| `bun run managed:demo` | PASS (8/8 scenarios as expected) | ~3 s |

Pre-existing failures: none.

## Phase 1 (after fixes)

| Command | Result | Duration |
| --- | --- | --- |
| `bun test apps/hub/src/managed/hardening.test.ts` ×3 | PASS 20/20 each run | ~4 s each |
| `HOME=<tmp> AGENTCITY_HOME=<tmp> bun test` | PASS 481 / 0 fail | 41 s |
| `bun run lint` / `typecheck` / `check:secrets` / `managed:demo` | PASS | — |

Red first: the file failed to load against `923854d` (quarantine / hooks / evidence APIs absent); after
the first implementation pass the P1.2 review-resume case still failed (`human_ready` with changed
`limits`) — the approval hash did not cover limits; fixed in `config.ts policyHash`.

## Phase 2 (after fixes)

| Command | Result | Duration |
| --- | --- | --- |
| `bun test apps/hub/src/managed/provider-hardening.test.ts` ×2 | PASS 24/24 each run | ~10 s |
| `HOME=<tmp> AGENTCITY_HOME=<tmp> bun test` | PASS 505 / 0 fail | 60 s |
| `bun run lint` / `typecheck` / `check:secrets` | PASS (after removing literal key markers from a test) | — |

Behaviour intentionally changed (tests updated with the reason in the test name): a Claude success
without a valid implementation contract is now `provider_output_invalid` (was: fabricated
`completed`); the Codex review call is no longer the first `codex exec` call (capability check runs
first); the scratch schema/last-message files no longer exist after a review.

## Phase 3

| Command | Result | Duration |
| --- | --- | --- |
| `env HOME=<tmp> PLAYWRIGHT_BROWSERS_PATH=<existing cache> bun run test:browser` ×3 | PASS 20/20 each | ~24 s |
| `HOME=<tmp> AGENTCITY_HOME=<tmp> bun test` | PASS 508 / 0 fail | ~60 s |
| `bun run lint` / `typecheck` (incl. `apps/web/e2e`) / `check:secrets` / web build | PASS | — |

The gate's first runs found two real defects besides the brief's list: a `#tasks` hash change in a
loaded page did not switch tabs (fixed: `hashchange` listener), and the console check initially
counted provoked 401/409/502 network logs (now an explicit allowlist of exactly those statuses).
Screenshots (synthetic data) are written to a fresh `agentcity-browser-evidence-*` temp directory
printed at the end of each run; they are not committed.

## Requirement → regression test → fix

Tests: `H` = `apps/hub/src/managed/hardening.test.ts`, `P` = `provider-hardening.test.ts`,
`B` = `apps/web/e2e/browser-gate.ts`. Lines are at the commit that introduced the fix.

| ID | Requirement | Regression test(s) | Fix (source) | Result |
| --- | --- | --- | --- | --- |
| P1.1 | Unresolved child → persistent quarantine; Cancel/Run/claim blocked; restart; inspection failure; identity mismatch | H "P1.1 …" (9 cases) | `proc.ts:197 resolveRecorded`, `store.ts:332` claim guard, `store.ts:623/671` open/release, `orchestrator.ts:223 resolveQuarantines`, migration `007` | PASS |
| P1.2 | Approval revalidated before resumed stages; immutable config snapshot | H "P1.2 …" (4) | `orchestrator.ts:598 approvalHolds` (start/implement/verify/review), `orchestrator.ts:165` frozen snapshot, `config.ts:167` limits + roots in `policyHash` | PASS |
| P1.3 | Cancel vs completion linearized; fence change during final await | H "P1.3 …" (3) | `orchestrator.ts:573 cancelWins` inside the final transaction | PASS |
| P1.4 | Review/artifact use one verified read of exact bytes; manifest links; 409 on tamper; workspace vs evidence integrity | H "P1.4 …" (4), B "tampered evidence …" | `evidence.ts:222 readArtifactBytes`, `evidence.ts:334 verifyRunEvidence`, `service.ts:325` 409 mapping, `evidence_integrity` in task detail | PASS |
| P2.5 | Capability policy + positive subscription auth, approval-bound; docs corrected | P "P2.5 …" (6), adapters tests | `claude.ts:54` required controls + isolation flags, `claude.ts:212 readClaudeAuth`, `codex.ts:143 readCodexAuth`, `cli.ts:106 checkCapabilities`, config `allowed_auth_methods` / `auth_status_pattern` | PASS (stub-only) |
| P2.6 | Multiline redaction through real artifact paths; no raw scratch | P "P2.6 …" (5) | `evidence.ts:99 redactLog` (stateful), codex scratch `finally` cleanup, `orchestrator.ts:454 cleanupScratch` | PASS |
| P2.7 | Independent termination bound; escaped descendant; kill failure; bounded lines/history/files | P "P2.7 …" (6), proc tests | `proc.ts` settle/pipe timers (`PIPE_CLOSE_GRACE_MS` at `proc.ts:274`), pipe-EOF evidence for `[pipe]` quarantines, `cli.ts:36 BoundedLog`, `cli.ts:71 readFileBounded` | PASS |
| P2.8 | Invalid implementation contracts never start downstream stages | P "P2.8 …" (7) | `claude.ts:383` `provider_output_invalid` instead of fabricated `completed` | PASS |
| P3 | Re-click, A→B race, stale snapshot, auth purge, late 401, uncertain create, viewer races, comma criteria, reload/nav, success/failure/cancel/restart, labels, observed view | B (20 checks) | `Tasks.tsx:156 purge`/auth epoch, `Tasks.tsx:250 select`, `Tasks.tsx:510` uncertain-create flow, `Tasks.tsx:724` viewer seq, `managed-view.ts:113 splitLines`, `App.tsx:60` hashchange | PASS |

## Phase 4

| Command | Result | Duration |
| --- | --- | --- |
| `bun run test:lifecycle` ×5 (temp HOME) | PASS 60/60 each run | ~29 s each |
| `bun run test:unit` + `bun run test:integration` | 164 + 344 = 508 = `bun test` | 0.04 s + 60 s |
| `.github/workflows/ci.yml` | written; **NOT RUN** on hosted CI (not pushed) | — |
| `bunx playwright-core install --help` | confirms `--with-deps` and `chromium-headless-shell` used by the workflow | — |

## Phase 5 (optional) — accepted items

| Item | Regression test | Fix | Result |
| --- | --- | --- | --- |
| A Observed-sessions races | `apps/web/src/merge.test.ts` "late responses cannot roll the observed view back" (4) + browser check "late answer for an old repo filter" | `merge.ts` `mergeEventSnapshot` (current filter at apply time), `mergeDistricts`/`upsertRepo` (per-repo version), frame shape checks; `useHub.ts` latest-request-wins; `App.tsx` repo filter keeps seen ids (found by the browser check) | PASS |
| B Collector spool fallback | `apps/collector/src/spool-fallback.test.ts` (7; 6 red before the fix) | `spool.ts` `deliver`: a refusal is never `sent`; parked durably → `rejected`, not parkable → `failed` (tailer offsets do not advance); `flush`: a reject file that cannot be written keeps the chunk queued | PASS |
| D State-machine table | `apps/hub/src/managed/state-machine.test.ts` (17): crash at 5 stage boundaries (no model stage relaunched), policy change at each resumable boundary (`approval_void`, nothing else runs), 6 invalid evidence rows, binding change during review, concurrent duplicate submissions / repeated Run | `orchestrator.ts` review: read the run after the boundary; re-check candidate + manifest binding inside the final transaction (the "manifest_hash changed" row ended `human_ready` before this fix) | PASS |
| E Read-only diagnostics | `managed-view.test.ts` "read-only diagnostics" (4) + browser failure-path assertion | `managed-view.ts diagnose` (stage, reason, last committed state, workspace/evidence integrity, next safe action — never an override), `Tasks.tsx` Diagnostics panel | PASS |
| C Task navigation | browser checks "deep links …", "keyboard: Enter …", "offline …" (24 checks total) | `Tasks.tsx`: `#tasks/<id>` deep link restored on refresh and kept current (no history spam), unknown id explained + link reset, focus moves to the opened detail, rows keyboard-selectable, explicit loading / offline (keeps last state) / not-found states; `App.tsx` tab follows `#tasks…` | PASS |
| (found) `ps lstart` locale/TZ | `proc.test.ts` "TZ / locale … do not change the recorded start time" | `proc.ts` `PS_ENV` (`LC_ALL=C TZ=UTC`) for every start-time read | PASS |

## Final verification (HEAD `6996fde`, disposable HOME / AGENTCITY_HOME)

| Command | Result | Duration |
| --- | --- | --- |
| `bun run verify` (lint → typecheck incl. e2e → `bun test` → check:secrets → build:web → managed:demo → test:browser) | PASS | 85 s |
| … `bun test` | 541 pass / 0 fail, 28 files | 58 s |
| … `managed:demo` | 8/8 scenarios as expected | — |
| … `test:browser` | 24/24 checks | ~25 s |
| `bun run test:lifecycle` ×3 (after the ×5 earlier) | 60/60 each | ~29 s each |
| hosted CI (`.github/workflows/ci.yml`) | NOT RUN (never pushed) | — |
| live provider preflight / model call | NOT RUN (forbidden in this task) | — |

Leftover processes after the run: none. Temporary files left on purpose: `agentcity-browser-evidence-*`
screenshot directories (synthetic data) and `ac011-*` log directories under `$TMPDIR`.

## Corrective patch (C1–C5)

An independent review of `923854d..e9c810a` reported five defects that the green runs above did not
catch. Each was reproduced red against the starting implementation (tests in
`apps/hub/src/managed/corrective.test.ts`, run with `env -i` + disposable HOME / AGENTCITY_HOME /
TMPDIR; stubs only, no real provider binary, login or model), fixed, and committed separately.

| ID | Defect | Red before the fix (observed) | Fix | Regression | Result |
| --- | --- | --- | --- | --- | --- |
| C1 | `--version` / `--help` / auth check exits 0 while an escaped descendant holds its pipes: quarantine opens, but preflight passes and the prompt launches | claude: 4 calls (rest of preflight + `-p` prompt) instead of 1/2/3; codex: 4 (incl. `exec --json`); a result-ignoring adapter could still launch; `checkExecutable` ok on exit 0 + unresolved | `cli.ts settled`/`cleanExit` (exit 0 never outweighs an unresolved child) for version/help/auth; `orchestrator.ts launchRefusal` at the common `ctx.run` boundary (unconfirmed child, open quarantine, lost claim → `refusedRun`); stop after preflight when a child is unconfirmed | C1, 8 cases: both providers × 3 checks, Run refused 409 + later ticks launch nothing, boundary test, unit | PASS — `807e46a` |
| C2 | oversized `turn.failed` dropped, then approval + exit 0 accepted; Claude success accepted after an oversized / unparseable record | all 5 cases ended `human_ready` | `cli.ts protocolLoss`: in JSONL mode a dropped (line bound) or non-JSON stdout line fails the stage closed (`provider_output_invalid`); blank lines, unknown event types, stderr and capture truncation stay permitted | C2, 6 cases incl. a control (unknown events, stderr, 4 KiB capture cap over 1.2 MB valid output → still `human_ready`) | PASS — `1a4cd28` |
| C3 | diff prefixes (`+`/`-`/` `) hide YAML secret blocks and `\`-continued tokens from redaction | on real fixture commits, leaked on all three surfaces (stored `diff.patch`, reviewer stdin, artifact API): old/new/added YAML block bodies, both continuation fragments, the added split token | `evidence.ts redactDiff`: per file, old (context + removed) and new (context + added) versions analysed without prefixes, mapped back line by line; divergent context lines masked whole; `redactLog` unchanged | C3, 3 cases: end to end over three surfaces; real `git diff` incl. a deleted file; divergent context | PASS — `c3323d5` |
| C4 | a FIFO in place of an artifact / the last-message file blocks `open()` and freezes the hub | isolated probes hit the external 5 s / 45 s deadlines; hub child process answered no request within 3 s | `SAFE_READ_FLAGS` = `O_RDONLY\|O_NOFOLLOW\|O_NONBLOCK`, fstat-on-descriptor regular-file check, descriptor always closed; `readFileBounded` reports `rejected` (symlink / FIFO / non-regular), Codex refuses such a file instead of falling back to the streamed message | C4, 5 cases: reader probes + whole pipeline + hub in child processes with an external SIGKILL deadline (409, `/healthz` and the task view keep answering); symlink/missing/regular control | PASS — `004775b` |
| C5 | diff bytes replaced + row hash/length updated coherently → artifact API 200 although the manifest binds the review to the original | both tamper cases → HTTP 200 | `evidence.ts checkRunEvidence` (non-throwing, verified buffers by id); `service.ts readTaskArtifact`: for a run with a manifest, the run's evidence must verify as a unit and every review of the run must name the run's candidate + manifest; the verified buffer is served | C5, 3 cases: file+row → 409; file+manifest+run hash → 409 via the review binding; untampered control → 200 | PASS — `ed72ca6` |

Earlier claims this corrects: P1.1 ("Cancel/Run/claim blocked") did not cover further launches inside
the same claim after a preflight check; P1.4 ("409 on tamper") covered bytes that differ from their
row, not a file replaced together with its row; P2.6 (multiline redaction) covered logs, not the
prefixed lines of a stored diff; P2.7 ("bounded … files") did not cover a FIFO in place of a file.
C5 is local tampering (write access to the artifacts directory and the hub DB), not a remote or
unauthenticated path. The C4 regression for the Codex FIFO case first asserted state `blocked`; the
schema maps `provider_output_invalid` to `failed` (`outcomeStateFor`) — the expectation was
corrected, the assertions on failure kind and on zero valid reviews were not changed.

### Verification after the patch (code `ed72ca6`, `env -i`, disposable HOME / AGENTCITY_HOME / TMPDIR)

| Command | Result | Duration |
| --- | --- | --- |
| `bun run verify` (lint → typecheck incl. e2e → `bun test` → check:secrets → build:web → managed:demo → test:browser) | PASS (exit 0) | 120 s |
| … `bun test` | 566 pass / 0 fail, 29 files (541 + 25 corrective) | 91 s |
| … `managed:demo` | 8/8 scenarios as expected | — |
| … `test:browser` | 24/24 checks | — |
| `bun run test:lifecycle` ×5 (now incl. `corrective.test.ts`) | 85/85 each run, 5/5 runs | 56 s each |
| hosted CI (`.github/workflows/ci.yml`) | NOT RUN (never pushed) | — |
| live provider preflight / model call | NOT RUN (not authorized) | — |

Leftover processes after the runs: none. The red C4 runs were killed at their external deadline, so
their disposable fixture directories may remain under that run's TMPDIR (outside the repository).
Still true and unchanged: worktrees are Git isolation, not a sandbox; everything above ran against
local stub executables; live provider behaviour is unverified (`LIVE_INTEGRATION_VERIFIED = false`).
