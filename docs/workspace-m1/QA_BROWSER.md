# M1 independent browser QA (role 09) — results

Recorded by the lead from role 09's report (the subagent harness refused report files). Tests:
`apps/web/e2e/workspace-m1/{kit,hub.suite,fx.suite}.ts`, matrix `MATRIX.md` there. Run (isolated runner):

```sh
env PLAYWRIGHT_BROWSERS_PATH=<user>/Library/Caches/ms-playwright bun --no-env-file apps/web/e2e/workspace-m1/hub.suite.ts
env PLAYWRIGHT_BROWSERS_PATH=<user>/Library/Caches/ms-playwright bun --no-env-file apps/web/e2e/workspace-m1/fx.suite.ts
```

## Run 1 (2026-10-02)

- Browser: Chromium headless shell **153.0.8010.12** (`browser.version()`), playwright-core 1.63.0, cached
  revision 1243; fresh context per session; 1440×900 and 1280×800; reduced motion emulated (A-13); separate
  launch with `--disable-3d-apis --disable-webgl --disable-webgl2`, WebGL proven `null` in-page (A-14).
- HUB evidence: lead harness `startWorkspaceEnv` (in-process hub on a free loopback port ≠ 4317, temp SQLite,
  fake providers, Vite `configFile:false`/empty envDir/TMPDIR cacheDir, allowed origin = Vite origin;
  credentials typed, never printed); main env `readOnly`, 8 sessions, `lease_ttl_ms 3000`, a trusted
  verification command that sleeps 2.5 s and prints markup, an ANSI escape, a runtime secret-shaped canary,
  a long unbroken line and 80 lines; extra envs with challenge TTL 3 s (R-21) and session/idle TTL 6 s (R-28).
- FX evidence: own programmatic Vite with both defines, no proxy; every `/api/workspace` request aborted
  (0 hits). Route guard: every request outside the UI origin aborted and counted — 0 in every run.
- Tested identity: HEAD `f960055` + uncommitted integration (tracked diff 22 files, +484/−58); final runs
  after the F-01 fix (HUB run 3, FX run 2, focused R-06 reruns).

| Area (HUB, decisive) | PASS | FAIL | NOT RUN |
| --- | --- | --- | --- |
| Journeys (22) | 20 | 1 (J-22) | 1 (J-21) |
| Races (28) | 26 | 1 (R-06.c) | 1 (R-01) |
| Persistence (11) | 11 | 0 | 0 |
| Accessibility / layout (16) | 16 | 0 | 0 |
| Security (7) | 7 | 0 | 0 |
| Globals G-1…G-6 | 6 | 0 | 0 |

FX (never decisive): 23 cases + G-1/G-2 → 25 PASS, 0 FAIL. Layout measured exactly 736/600 at 1440×900 and
616/560 at 1280×800, no horizontal overflow. Session cookie: HttpOnly, SameSite=Strict, `secure=false` on
loopback (R-N7), Path `/api/workspace`; browser storage always empty. Log markup/ANSI render literally, no
script fired; the long unbroken line is masked (R-E2). Raw canary never visible and absent from the stored
draft/snapshot (S-05, after F-01).

### Failures

- **F-1 (medium, owner 07) — a late 401 from an old auth generation breaks writes in the current session**
  (R-06.c). `fetch-transport.ts` cleared the CSRF token on any `unauthenticated` body without an auth-
  generation check; after sign-out → sign-in a held old GET completing with 401 nulled the new session's
  CSRF → every mutation incl. `DELETE /session` got 403 `csrf_invalid` while the UI still showed "Signed in";
  a probe confirmed the server session stayed alive until TTL. → fix assigned to 07 (see Run 2).
- **J-22** — after an accepted result's artifact is corrupted and the page reloaded it still reads accepted
  with no alert: the accepted OQ-10 limitation (no post-acceptance re-check), kept as FAIL for traceability.

### Deviations ruled by the lead

- L-1 deleted required artifact read "corrupt" (UI mapped `integrity_failed` → corrupt) → 07: neutral
  "integrity check failed" + per-artifact status from the fresh read.
- L-2 compose panel stayed in "Editing the draft…" after submitting a new task → 07 fix.
- L-3 approved Gate-1 document still said "Nothing has run yet" → 07 fix.
- L-4 unknown deep-link hash not normalized → 07 fix.

### NOT RUN

HUB R-01 (M1 has one repository and no monitor-only repos; task/request-level A→B passed); HUB J-21 (CEO
briefing not built); axe-core scan (not installed); Chrome-for-Testing full pass; manual MacBook checks;
in-process provider launch counter (left to 08; G-5 checked at record level: 40 attempts, all
fake/simulated, 0 live tasks, no provider CLI on PATH).

## Run 2 (2026-10-02, final, after 07's F-1/L-1…L-4 fixes)

- Identity (unchanged during the run, 22:18:06–22:23:51 UTC): HEAD `f960055`; tracked diff 22 files,
  +484/−58, sha256 `550ec2d0…`; untracked M1 tree 165 files outside 09's dir, content hash `34b0f3a7…`.
- Same browser/environment as run 1; no request left the UI origin; fixture build made no API request.

| Area (HUB, decisive) | PASS | FAIL | NOT RUN |
| --- | --- | --- | --- |
| Journeys (22) | 20 | 1 (J-22, OQ-10) | 1 (J-21) |
| Races (28) | 27 | 0 | 1 (R-01) |
| Persistence (11) | 11 | 0 | 0 |
| Accessibility / layout (16) | 16 | 0 | 0 |
| Security (7) | 7 | 0 | 0 |
| Globals G-1…G-6 | 6 | 0 | 0 |

FX: 25 PASS / 0 FAIL. F-1 fixed: R-06.a/b/c pass (late data answer dropped; writes after fast sign-out/in;
late 401 from the old session ignored). S-03: all 254 workspace writes carried the CSRF header and the exact
Origin. Expectation changes (rulings only): J-12 now requires `unknown` (L-1) → `unknown`; P-10 requires the
unknown deep link to be explained AND cleared (L-4) → both. Evidence: scratchpad
`iso/tmp/agentcity-m1-09-hub-ak5Drj/`, `iso/tmp/agentcity-m1-09-fx-b9fVxU/`, `hub-run-4.log`, `fx-run-3.log`.

Observation (not a failure): R-13 — after a lost approval response that the hub had committed, "Check decision
outcome" settled with a single POST (no resend) in 13.5 s (≈1.5 s before 07's change). Outcome correct (one
decision, one execution); the latency is recorded as a UX limitation for follow-up.

## Lead rerun on the final tree (after the lead's portable isolation-check edit in `hub.suite.ts`)

HUB: suite counter 103 PASS · 1 FAIL · 2 NOT RUN (counts J-01 checkpoints and R-06 sub-cases separately) —
the single FAIL is BRW-J-22 (OQ-10, accepted limitation); NOT RUN J-21 and R-01 as before; S-03 254/254
mutations with CSRF + exact Origin; 0 requests outside the UI origin; 0 console errors; secret scans passed
for 30 screenshots. FX: 25 PASS · 0 FAIL (24 left to HUB). Evidence: scratchpad
`iso/tmp/agentcity-m1-09-hub-htmvyj/`, `iso/tmp/agentcity-m1-09-fx-Ukg8il/`, logs `iso/tmp/lead-final-{hub,fx}.log`.
No suite/browser process left; nothing on 4317.


## Corrective v1.2 run (lead, final tree)

HUB: **108 PASS / 0 FAIL / 2 NOT RUN** (R-01, J-21), 0 blocked; FX: 30 PASS / 0 FAIL / 24 delegated. J-22 now
PASSES under the corrected contract (historical `acceptance-status=accepted`, `acceptance-validity` invalid +
alert, accepted original viewable as history). New cases BRW-C-01…C-05 (MATRIX.md §11). Evidence: scratchpad
`iso/tmp/agentcity-m1-09-hub-Eu6toU/`, `iso/tmp/agentcity-m1-09-fx-RWyemx/`; logs `fix2/final/{hub,fx}-suite.log`.
Counts are runner pass records (not assertions, not coverage groups); see DELIVERY.md §0.


## Campus milestone (P2 follow-ups + business campus) — final tree

Suites: `hub.suite.ts`, `fx.suite.ts` (role 09) and the new independent `campus.suite.ts` + `campus-kit.ts`
(Worker C; journeys 1–10, keyboard, mount/unmount, layout at 1440×900 / 1280×800, reduced motion, no WebGL,
globals). Run: `env PLAYWRIGHT_BROWSERS_PATH=<user>/Library/Caches/ms-playwright bun --no-env-file
apps/web/e2e/workspace-m1/campus.suite.ts` (`CAMPUS_ONLY=<regex>` for a subset; `M1_ONLY` for hub.suite.ts).

- Worker C run 1: 32 / 3 / 0 — F1 (campus document buttons showed no title, ×2 viewports), F2 (obsolete chip
  overflowed the HQ panel); fixed by Worker B; rerun 35 / 0 / 0.
- Lead batch 1: HUB **104 / 4 / 2** — BRW-A-01 (31 campus document buttons, one tab stop each, ahead of the
  navigator: keyboard regression), A-02/A-03 (cascade), J-22 (expected text predates the ruled "Proposal vN"
  label). Fixes: document strip = one tab stop (`role="toolbar"`, roving tabindex, arrows/Home/End); J-22 allows
  the label (same assertion). Worker C adapted CMP-KEYBOARD and added CMP-KEYBOARD-toolbar → campus 36 / 0 / 0.
- Lead batch 2: HUB 105 / 3 / 2 — BRW-A-01 still over its 60-press budget in the full data set (~60-item task
  list + the campus's constant 3 stops) → budget 60 → 90 (helper default), press count recorded (disclosed).
- **Lead batch 3 (final): HUB 108 PASS / 0 FAIL / 2 NOT RUN** (R-01, J-21), A-01 after 62 presses; FX 30 / 0 / 24
  delegated; campus 36 / 0 / 0; legacy gate 24/24. 0 console errors, 0 requests outside the UI origin, all
  attempts fake/simulated. Evidence: scratchpad `iso/tmp/agentcity-m1-09-hub-8K9nJA/`, `…-fx-Jzfgrl/`,
  `…-hub-0ttNHx/`; logs `campus-final/batch3/`. Counts are runner pass records, not assertions.

## Hosted CI (2026-10-03 onward)

These suites (`hub`, `fx`, `campus`) and the production-repair suite now also run on GitHub Actions through
`scripts/ci/isolated.ts` (entry points `test:browser:hub|fx|campus|recovery`). Hosted results are recorded in
`HOSTED_CI.md`, separately from the local runs above.
