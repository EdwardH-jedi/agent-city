# M1 baseline revalidation (lead)

Taken 2026-10-01T16:15Z (UTC) before any M1 change. Measured in `agent-city-m1` at
`f960055448e4f5a0bd93a7b9ca0aeb0d2ef8597d` (identical tree to the reported source).

## Source preservation

- `agent-city-v011`: HEAD `f960055448e4f5a0bd93a7b9ca0aeb0d2ef8597d`, branch `hardening/managed-v0.1.1`,
  zero porcelain lines. SHA-256 of all 130 tracked files recorded outside the repo for the final
  comparison.
- `agent-city` (main checkout): HEAD `429a08bd14f0c1b77b06be42acdfc3bb0e1b952e`,
  `phase1/event-normalization`; one untracked file (the SOL design document). Tracked-file hashes and
  the design document hash recorded for the final comparison.
- Nothing listened on 127.0.0.1:4317; the real hub was not started.

## Isolated environment

`env -i` with disposable `HOME`, `AGENTCITY_HOME`, `TMPDIR`; `PATH` = scratch dir holding only `bun`
(1.4.2) and `git` (2.53.0) plus `/usr/bin:/bin:/usr/sbin:/sbin`. `claude` (present in the user's
`~/.local/bin`) and `codex` are **not resolvable** in this environment. `--no-env-file`; no `.env`
exists in this checkout.

## Results (pass / fail / not run)

| Check | Result |
| --- | --- |
| `bun run lint` (biome) | pass |
| `bun run typecheck` (5 projects) | pass |
| `bun --no-env-file test` (full) | **566 pass, 0 fail**, 2004 expect() calls, 29 files, 83.9 s |
| Lifecycle set (`hardening`, `recovery`, `provider-hardening`, `corrective`) | **85 pass, 0 fail**, 461 expect() calls |
| `check:secrets` | pass (130 files) |
| `build:web`, `managed:demo`, `test:browser` | not run at baseline |
| Hosted CI | not run |

### Five reported fixes — isolated regression rerun (`corrective.test.ts`)

| Fix | Suite | Result |
| --- | --- | --- |
| C1 preflight child stops every later launch | 8 tests | pass |
| C2 lost/malformed protocol events never permit success | 6 tests | pass |
| C3 diff prefixes vs multiline redaction | 1 + 2 tests | pass |
| C4 FIFO evidence/scratch reads | 4 + 1 tests | pass |
| C5 artifact API bound to reviewed manifest | 3 tests | pass |

These are the existing regressions rerun in isolation. They do not close the known **omitted-hunk
YAML secret gap** (C3 limitation), which M1 must close (role 06), and they are not an independent
adversarial verification (role 08 re-attacks the five fixes against the final diff).
