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
- [ ] Phase 3 — browser gate + Tasks UX fixes
- [ ] Phase 4 — CI workflow (not pushed), split commands, flake loop, docs reconcile
- [ ] Phase 5 — optional

## Temporary resources

- `$TMPDIR/ac011-*` run directories (test logs). Tests create their own mkdtemp fixtures and remove them.

## Next command

`cd ../agent-city-v011 && bun test apps/hub/src/managed` (then Phase 3: browser gate)
