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
