# Managed runs v0.1.1 — checkpoint

Resume from this file + `git log` / `git diff`, never from memory.

## Refs

- Worktree `../agent-city-v011` (sibling of the main checkout), branch `hardening/managed-v0.1.1`.
- Base: `923854d` (`feat/managed-runs-v0.1`, = origin). `origin/main` = `e33f2ac` (README-only change,
  not merged; reconciled by hand in Phase 4).
- Untouched: main checkout (`429a08b`, its running hub on :4317), `agent-city-night`, `agent-city-v01`.

## Phase status

- [x] Phase 0 — baseline (see verification file), browser tooling found (cached Playwright browsers,
  system Chrome; needs project-local `playwright-core`)
- [x] Phase 1 — P1.1 quarantine · P1.2 approval revalidation · P1.3 cancel/finalize · P1.4 exact bytes
  (tests: `apps/hub/src/managed/hardening.test.ts`, 20 cases; found + fixed along the way: `limits`
  and output roots were not in the approval hash; absolute artifact `rel_path` misclassified)
- [x] Phase 2 — P2.5 capability/auth · P2.6 multiline redaction + scratch · P2.7 bounds · P2.8 contracts
  (tests: `apps/hub/src/managed/provider-hardening.test.ts`, 24 cases; finding while testing: an
  escaped descendant holding the pipes is only provable gone by pipe EOF in the same process —
  after a restart that quarantine stays open by design)
- [x] Phase 3 — browser gate (`bun run test:browser`, `apps/web/e2e/browser-gate.ts`, 20 checks) +
  Tasks UX fixes (auth epoch, guarded selection/detail, purge, uncertain create, viewer seq,
  line-split criteria, hash navigation). Dependency: `playwright-core` 1.63.0 (dev, pinned); uses the
  cached Chromium 1243 build, no download.
- [x] Phase 4 — CI workflow (written, not run, not pushed), `test:unit`/`test:integration`/
  `test:lifecycle`/`build:web`/`verify`, flake loop (lifecycle ×5 green), requirement→test map,
  README reconciled by hand with main's `e33f2ac` wording (main NOT merged), runbook + agent rules
- [~] Phase 5 — optional: A (observed-sessions races) ✔, B (collector spool fallback) ✔, D (state-machine table) ✔, E (read-only diagnostics) ✔, C (task navigation) ✔; extra
  finding fixed: `ps lstart` compared under fixed locale/TZ. All optional items done.

## State at stop

- HEAD `6996fde` + a docs commit; all mandatory phases and optional A–E done; `bun run verify` green.
- Not done / blocked: hosted CI run (not pushed), any live provider check (forbidden here), OS-level
  isolation (out of scope).

## Temporary resources

- `$TMPDIR/ac011-*` run directories (test logs) and `$TMPDIR/agentcity-browser-evidence-*` (gate
  screenshots, synthetic). Tests create their own mkdtemp fixtures and remove them. Safe to delete.

## Next command

`cd ../agent-city-v011 && bun run verify` — then an independent review of `923854d..HEAD`
