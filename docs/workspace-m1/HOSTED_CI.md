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
| real-hub suite (`test:browser:hub`) | 108 pass / 0 fail / 2 NOT RUN (R-01, J-21) |
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

## Limitations

- Hosted runs are Linux x64; local runs are macOS arm64. Observed durations are observations, not bounds.
- CI generates and uploads screenshots; it does not visually inspect them.
- Not verified by CI (or anywhere in M1): CEO briefing (J-21, not built), multiple repositories (R-01, one
  repository by design), manual MacBook and physical screen-reader checks, axe-core, real providers, OS
  containment, deployment.
- `actions/checkout` and `oven-sh/setup-bun` are referenced by major tag, not pinned to a commit.
