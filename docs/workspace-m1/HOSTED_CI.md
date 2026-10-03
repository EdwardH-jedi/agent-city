# Hosted CI record (GitHub Actions)

Workflow `.github/workflows/ci.yml`: `on: push, pull_request`, `permissions: contents: read`, no repository
secrets, GitHub-hosted `ubuntu-latest` (Linux x64), Bun 1.4.2, Playwright `chromium-headless-shell` installed
per job with `--with-deps`. Everything is simulated: fake providers, generated stub executables, disposable
hubs and fixture repositories; `LIVE_INTEGRATION_VERIFIED` stays false.

Local verification of this repository has been on macOS (Apple Silicon) with the cached headless shell. Local
and hosted results are recorded separately and never added together. Browser numbers are **runner pass
records** (one per case/check), not assertion counts. `bun test` numbers are test cases: unit (`packages`,
`apps/web/src`, `scripts`) + integration (`apps/hub`, `apps/collector`) = the full `bun test` set; the 203
independent adversarial cases live under `apps/hub` and are already inside the integration count.

## Run 1 — first hosted run (historical)

- Run <https://github.com/EdwardH-jedi/agent-city/actions/runs/37090614170> (job 111109966767), event `push`,
  branch `feat/workspace-approvals-m1`, commit `80a9a175c87225d29f71aae9f525111be07984ac`,
  2026-10-03 02:40–02:45 UTC. Conclusion: **failure**.
- Before it, no workflow had executed on hosted CI; earlier records that say "hosted CI not run" were accurate
  when written and are kept as history.
- Passed: lint, typecheck, unit 710, integration 1078 (= 1788, the same set as the local full suite), secret
  scan, web build, simulated managed demo, browser-engine install.
- Failed: legacy browser gate **23/24** — `deep links: #tasks/<id> restores the task after refresh; unknown id
  is explained — focus is on null`.
- Not in that workflow at all: the M1 workspace browser suites (real hub, fixture, campus, production repair).

### Cause and repair (stabilization pass)

The failure was a **product defect** in the legacy managed-task view (`apps/web/src/Tasks.tsx`), not a test
that looked too early and not a campus regression (`Tasks.tsx` and `browser-gate.ts` were unchanged since
`f960055`). After a refresh on `#tasks/<id>` the view requests `/config` + `/tasks` (the token check) and the
task detail in parallel. Focus moved to the detail heading in an effect keyed only on the detail's id; when the
detail answered first, that effect ran while the view still showed "checking the token" (no heading mounted)
and never ran again once the heading appeared, so focus stayed on `<body>` (whose `data-testid` is null).

Evidence (local, isolated, same harness and Chromium build): in the natural macOS order the list answered first
in 15/15 reloads and focus was correct; holding the list 800 ms made the detail answer first in 5/5 reloads,
and focus stayed on `<body>` both immediately and one second later in 5/5 — the hosted symptom. Run 1's log
does not show the request order, so the hosted order is inferred from the identical symptom; the other
candidate causes were checked and excluded (focus never moved to any other element, the task heading was not
replaced, and no later navigation or auth event was involved).

Repair: the focus effect is keyed on "the selected task's heading is rendered" (token accepted, hub available,
the detail is the selected task's), so it fires once when the heading appears and never on later refreshes.
The deep-link check now awaits the exact condition — the active element is the `detail-heading` inside that
task's `task-detail` — for at most 3 s, and reports what is focused on failure. New legacy-gate steps (24 → 27
checks): the forced order above (and it asserts that the detail really answered first), poll refreshes of a
running task never take focus from the form while typing, a late answer for an earlier selection never takes
focus from the newer task, and Enter on a row lands focus on that task's heading.

### Local verification of the stabilization pass (macOS arm64, before push — not hosted)

Every command ran through `scripts/ci/isolated.ts` or the equivalent cleared runner (fresh HOME, TMPDIR and
AGENTCITY_HOME; cached headless shell 153.0.8010.12; fake providers; nothing on 4317):

| Check | Result |
| --- | --- |
| lint / typecheck / secret scan / web build | clean (315 files) / 5 projects pass / ok (366 files) / ok |
| full `bun test` | 1794 pass / 0 fail, 113 files (unit 716 = 710 + 6 new CI-tooling tests; integration 1078) |
| adversarial rerun (already inside integration) | 203 / 0 |
| simulated managed demo | 8 / 8 scenarios |
| legacy browser gate | unchanged product + new steps: 26/27 (forced-order step fails as on CI); with the fix: 27/27 in 7 consecutive runs (one under the CI wrapper) |
| focus diagnostic (scratch, not committed) | before the fix: forced order 5/5 focus on `<body>`; after: 20/20 on the heading (15 natural, 5 forced) |
| real-hub suite (`test:browser:hub`) | 108 pass / 0 fail / 2 NOT RUN (R-01, J-21); again 108 / 0 / 2 after the R-23/R-24 repair below |
| fixture suite (`test:browser:fx`) | 30 pass / 0 fail / 24 NOT RUN (delegated to the real-hub suite) |
| campus suite (`test:browser:campus`) | 36 / 0 / 0 |
| production build + repair suite (`test:browser:recovery`) | build ok (5 files; >500 kB chunk warning retained) / 12 pass / 0 fail |
| evidence collector on those runs | 80 screenshots, 4 results files, 6 run records and logs; secret scan: no hits |

Visual check (local screenshots from the campus suite, viewed by the lead): campus overview, selected building,
Headquarters with a pending document, criterion coverage and the invalid-evidence warning at 1440×900, and
selected building, a long Headquarters document and a long task detail at 1280×800 — readable, no horizontal
overflow, decision controls visible, no console errors (the suites' own checks). Subjective items left for
Edward: the campus document strip cuts its last chip at the panel edge (it scrolls); at 1280×800 the campus
caption is truncated with an ellipsis and the selected building's floating label is not in view; the
Headquarters document area above the fixed decision panel is short at 1280×800.

## CI coverage after the stabilization pass

| Job (budget) | Step (suite time limit) | What it covers |
| --- | --- | --- |
| `checks` (25 min) | lint, typecheck, unit, integration, secret scan, web build, managed demo | as in run 1 |
| | legacy browser gate `test:browser` (9 min) | legacy managed-task UI, 27 checks |
| `workspace-hub` (50 min) | `test:browser:hub` → `hub.suite.ts` (39 min) | workspace UI against the isolated **real** hub: journeys, races, persistence, accessibility/layout, security, globals |
| `workspace-campus` (50 min) | `test:browser:fx` → `fx.suite.ts` (11 min) | fixture transport: rendering, local state, layout only — never authority or persistence evidence |
| | `test:browser:campus` → `campus.suite.ts` (19 min) | business campus against the isolated real hub (software WebGL and a no-WebGL browser) |
| | `build:web:workspace-prod` (4 min) | isolated production build of the workspace UI (`configFile:false`, empty envDir) |
| | `test:browser:recovery` → `campus-recovery.suite.ts` (11 min) | production-repair regressions served from that production output, against an isolated real hub |

Isolation: every browser suite runs through `scripts/ci/isolated.ts` (fresh HOME, AGENTCITY_HOME and TMPDIR per
suite; only those, PATH, LANG, TZ and the browser path are passed; own process group; time limit; forwarded
cancellation; leftovers killed). Each suite starts its own hub on a free loopback port (4317 refused), its own
SQLite file and fixture repository. Jobs run on separate runners and share nothing; within
`workspace-campus` the suites run one after another and a failure does not skip the later suites (the job
still fails).

Artifacts: `scripts/ci/collect-browser-evidence.ts` copies only `run.json`, `suite.log`, each suite's
`results.json` and top-level screenshots, scans every copied text file with the shared secret patterns (a hit
is not uploaded and fails the step), and writes the step summary. Never uploaded: HOME, databases, fixture
repositories, browser profiles or storage, traces, HARs, accessibility snapshots, caches. Uploaded with
`if: always()` (failure evidence included), 7-day retention, one artifact per job and attempt. Credentials in
the suites are synthetic per run, never printed, and typed only into password fields.

## Run 2 — first run with the new coverage

- Run <https://github.com/EdwardH-jedi/agent-city/actions/runs/37099491744>, event `push`, commit
  `db00c9365d2852c28ec997fc076b6a4920343d46` (the fix, CI and documentation commits above), 2026-10-03
  05:20–05:43 UTC. Conclusion: **failure** (one real-hub case).
- `checks` (job 111136066513): **success** — lint (315 files), typecheck, unit 716 / 0, integration 1078 / 0,
  secret scan (366 files), web build, demo; legacy browser gate **27/27** on Linux, including the deep-link
  focus check that failed in run 1 and the forced-order step.
- `workspace-campus` (job 111136066507): **success** — fixture 30 pass / 0 fail / 24 delegated; campus 36 / 0 / 0
  (software-WebGL scene initialised on Linux); production build 5 files; production repair 12 / 0.
- `workspace-hub` (job 111136066419): **failure** — 106 pass / **1 fail** / 3 NOT RUN in 1338 s. NOT RUN: R-01
  and J-21 (as everywhere) and **P-06**, which records NOT RUN by design when its timing window closes (here the
  cancellation was already confirmed when the reload finished; ordering still held). Locally P-06 passed.
- The failure, **BRW-R-24** (`click: Timeout 12000ms exceeded`), was a race in the test, not in the product. The
  failure screenshot shows tab 1 already displaying the request as approved with exactly one decision; the
  case had checked that tab 1's Approve was enabled, tab 1's poll then replaced it with the decided note, and
  the click waited 12 s for a button that no longer existed. Locally the click always landed first and the hub
  refused it ("no longer open for a decision"). BRW-R-23 had the same check-then-click race (it passed here
  because Approve was already disabled at the check).
- Repair (test only): R-23 and R-24 still click tab 1's Approve whenever it is clickable; if it disappears
  between the check and the click, the case now verifies that Approve is no longer enabled instead of failing
  on the click, and R-24 additionally asserts the MATRIX outcome — tab 1 shows the request decided or a refusal
  — in both paths, with exactly one decision and one execution as before. Locally both orders pass twice each
  (natural: click refused; forced with tab 1's poll first: decided state shown).
- Artifacts (synthetic, 7 days): legacy gate 11264894861, campus job 11266015271, real-hub job 11266021205; the
  collector's secret scan reported no hits in any job.

The commit that adds this record and the R-23/R-24 repair is verified by the next run; a commit cannot contain
its own CI result, so that run is reported in the delivery handoff.

## Run 4 — multi-repository milestone (`eeac451`)

Run 37131292854 (push of `eeac451bb2ddfa12d20fc97038e0f254a27c5ab4`; run 3 was 37101861244 on `eeeef85`, green,
recorded in the handoff): **failure** — 3 of 4 jobs green.

| Job | Result |
| --- | --- |
| `checks` (111226767116) | success — lint, typecheck, unit 754 + integration 1105 (= the same 1859 `bun test` cases as locally), secret scan (374 files), web build, demo, legacy browser gate **32/32** |
| `workspace-hub` (111226767178) | success — **110 PASS / 0 FAIL / 0 NOT RUN** (P-06 ran; R-01/J-21 now in MULTI) |
| `workspace-campus` (111226767013) | success — FX 30 / 0 / 24 delegated; campus 36 / 0 / 0; production build ok; repair 12 / 0 |
| `workspace-multirepo` (111226767075) | **failure** — MULTI 26 PASS / 1 FAIL (MR-R05) / 0 NOT RUN |

Cause (test, not product — reproduced locally with instrumentation, then fixed): in MR-R05's committed-then-lost
variant the hub commits the decision (~55 ms after the click) and the UI reconciles it from the first detail read
(~110 ms), which closes the request and removes the signature field and Approve. When the predicate's first tick
had already seen "Check decision outcome", it then called `inputValue()` / `isEnabled()` on those now-removed
controls, and Playwright waited for them for the suite's 12 s default timeout each (+ the 2 s click attempt):
a constant ≈ 26.3 s stall, longer than the 20 s budget. Local runs hit it intermittently (from 0 of 14 to 4 of 10 targeted runs per batch). The case now
reads those controls without waiting (a removed field keeps nothing; a removed button is not enabled); budget and
assertions unchanged. The run of the commit with this repair is reported in the delivery handoff.

## Limitations

- Hosted runs are Linux x64; local runs are macOS arm64. Observed durations are observations, not bounds.
- CI generates and uploads screenshots; it does not visually inspect them.
- Timing-window cases record NOT RUN when the window closes on a given runner; that is missing coverage for that
  run, reported in the step summary, not a pass. (P-06 no longer has a timing window: since the multi-repository
  milestone a test-only engine hook holds the cancellation's recording, so it always runs.)
- The isolation wrapper's exit code (130 / 143 = the wrapper itself was interrupted, 124 = time limit) describes
  only its own run; whether GitHub reports a job as cancelled is read from the Actions run status, never inferred
  from that code.
- Not verified by CI (or anywhere): manual MacBook and physical screen-reader checks, axe-core, real providers,
  OS containment, deployment. Multiple repositories (R-01) and the CEO briefing (J-21) are covered since the
  multi-repository milestone by the `workspace-multirepo` job (`multirepo.suite.ts`), which runs them as
  BRW-R-01 / BRW-J-21 in the MULTI set (no longer in the HUB set, so nothing is counted twice).
- `actions/checkout` and `oven-sh/setup-bun` are referenced by major tag, not pinned to a commit.
