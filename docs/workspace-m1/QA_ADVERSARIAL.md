# M1 independent adversarial QA (role 08) — results

Recorded by the lead from role 08's report (the subagent harness refused report files). Tests live in
`apps/hub/test/workspace-m1-adversarial/` (matrix: `MATRIX.md` there). Rerun:
`bun --no-env-file test apps/hub/test/workspace-m1-adversarial` (isolated runner).

## Run 1 (2026-10-02)

- Tested identity: branch `feat/workspace-approvals-m1`, HEAD `f960055` + uncommitted integration
  (tracked diff 22 files, +484/−58; backend tracked-diff sha256 `1a45f77c…3360`; 103 untracked backend
  files, content sha256 `cf741314…6e84`). No backend file changed between 08's first and last run.
- Result: **200 tests, 199 pass, 1 fail** (1152 expect() calls, 9 files, ~67 s), identical over 3 runs.
  Control (not independent evidence): `corrective.test.ts` 25/0.
- Isolation asserted in every file: `claude`/`codex` unresolvable, no provider keys, every hub on
  127.0.0.1 port 0 (≠ 4317), every hub stopped after its test, no stray processes.

| File | Tests | Result | Hub |
| --- | --- | --- | --- |
| auth-origin | 45 | pass | real `startHub` |
| challenge-idem | 26 | pass | real + fake auth clock + restarts |
| race-inval | 21 | 20 pass / 1 fail | composed (production modules + test seams) |
| gate2-evidence | 29 | pass | composed + git argv logger |
| redaction | 21 | pass | composed |
| live-legacy-ws | 13 | pass | real, live block enabled → stub CLIs |
| repair-cancel-restart | 21 | pass | composed + real |
| fixes | 18 | pass | integrated orchestrator + 08's own stub CLIs |
| hash | 6 | pass | composed |

### Failure

**F-01 (High) — draft text stored and served unredacted (ADV-INVAL-10b).** `POST /tasks` and
`PUT /tasks/:id/draft` stored `workspace_tasks.draft` verbatim; returned by `GET /tasks/:id` and
`GET /snapshot` (incl. the read-only principal). Frozen surfaces (proposal snapshot, managed task,
`managed_proposals`) were correctly redacted. Graded High rather than Critical (same authenticated operator
typed it; nothing reaches a provider/reviewer/public surface). → fix assigned to role 04 (see Run 2).

### Observations (not failures; ruling, design or documented limitation)

- OBS-01 `managed_runs.candidate_sha` tampered to a nonexistent commit → `409 evidence_unavailable`, request
  stays pending (R-E5 transient class); an existing other commit or a tampered manifest hash →
  `integrity_failed` + invalidation. Nothing is accepted either way.
- OBS-02 A descendant that escapes into a new process group and closes its pipes is not detected (pipe EOF ≠
  termination; documented limitation, OOS-03).
- OBS-03 Public `/ws` still accepts any loopback port / absent Origin; carried zero frames and no ids during
  full journeys. Acceptable only while `/ws` stays observed-only.
- OBS-04 A file swapped inside the decision window after revalidation still lets accept succeed; the
  accepted envelope hash names the verified bytes and the swapped bytes are never served (06's documented
  residual window; no post-acceptance re-check, OQ-10).
- OBS-05 After Gate 2 opens, the artifact route serves the retained verified buffer; a later tamper is
  detected only by a fresh read (restart, or invalidation — R-F5). Tampered bytes are never served.
- OBS-06 A BOM-prefixed JSON body is accepted (Fetch strips the BOM); benign.
- OBS-07 The root `bun test` now includes this directory (+~67 s).

### Five reported fixes — independent re-attack (C-labels per R-A4)

| Fix | Result | What was executed |
| --- | --- | --- |
| C1 preflight descendants / `ctx.run` guard [spec 3] | PASS | stderr/stdout-holding descendants at claude `--version`/`--help`/`auth status` and codex `login status`; escape inside implement; adapter ignoring an unresolved child → no later launch, quarantine, never human_ready. Control: same-group descendant killed and run proceeds; closed-fd escape undetected (OBS-02) |
| C2 protocol loss vs capture truncation [spec 4] | PASS | Claude failure record MAX_LINE_BYTES+1, oversized unterminated record after success, scalar/array lines; Codex oversized `turn.failed` then approve + exit 0 → `provider_output_invalid`/no valid review. Controls: exactly MAX_LINE_BYTES and 4000 records over the log cap succeed |
| C3 diff-prefix redaction + omitted-hunk gap [spec 2] | PASS | REDACT-01…12 through the real engine evidence step (header outside hunk, context-only secrets, renames both ways, block scalar variants, anchors, flow mappings, multi-hunk, rename/delete/add/binary/CRLF/no-EOL/latin-1, oversized, unparsable, missing blob, FIFO, `.env`, JSON) across all DB tables, artifact files, reviewer input, routes, logs → no secret line on any surface; withheld → `evidence_invalid` before review. Positive control: baseline `redactDiff` leaks the body lines |
| C4 FIFO / special files [spec 1] | PASS | FIFO/directory as `diff.patch` via Gate 2 and the artifact route (also after restart), FIFO in the worktree, Codex last-message symlink/directory/oversized → refused within 1 s, `/healthz` < 250 ms, `text: null`, never human_ready |
| C5 artifact bytes bound to review/candidate/manifest [spec 5] | PASS | coherent file+row, diff+manifest+`manifest_hash`, changed-files/review-output/review.log rewrites, forged/edited review rows, symlinked file/run dir, truncate/append/oversized, host-path `rel_path`, validation/use swap → 409, no acceptance, forged bytes never served |

C1, C2 and the Codex part of C4 are unreachable through `/api/workspace` (live forced off) and were attacked
on the integrated engine with stub scripts only.

### Rows not run

AUTH-10 (session value never logged — no hub log capture for `startHub` flows); EVID-14 (post-acceptance
alert, deferred by OQ-10); RESTART-07 (held-pipe quarantine across restart); OOS-01/02/04/05/06 (by design);
multi-process races and kill-between-COMMIT-and-response (covered by 02/04 suites, not independently);
`impl_hangs` timeout path; browser-side rows (role 09).

## Fix after run 1

F-01 fixed by role 04 (`apps/hub/src/workspace-m1/decisions/commands.ts` `storedDraft`, regression
`draft-redaction.test.ts`): 08's `race-inval.adv.test.ts -t "INVAL-10b"` → 1 pass; decisions 75/0; all
workspace modules 375/0. Full rerun by 08: see Run 2.

## Run 2 (2026-10-02, after the F-01 fix)

- Identity: HEAD `f960055` + uncommitted integration; tracked diff unchanged (22 files, +484/−58; backend
  tracked-diff sha256 `1a45f77c…3360`); untracked backend files 104, content sha256 `19994e50…5dbb`
  (`git ls-files --others --exclude-standard -- apps/hub/src packages/schema | sort | xargs shasum -a 256 |
  shasum -a 256`); identical before and after both runs.
- Result: **203 pass, 0 fail** on two full runs (1179 expect() calls, 9 files, 67–69 s); biome clean;
  `tsc -p apps/hub` exit 0; check-secrets ok (299 files); no stray processes; nothing on 4317.
- F-01 → PASS. New tests: INVAL-10b (three runtime canaries through create/save/publish; every DB table,
  operator + read-only detail and snapshot, all responses scanned — nothing leaks), INVAL-10c (byte-identical
  replay 200; difference only inside the masked secret replays 200 (OQ-3-style); real text difference 409;
  one task row), INVAL-10d (over-length after redaction → 400, nothing stored / rev unchanged), EVID-19
  (R-F5: retained verified original served while pending, accept → 409 integrity_failed + invalidated,
  then re-verified from disk: `text: null`, never the forged bytes).
- Still NOT RUN: AUTH-10 (log capture), EVID-14 (OQ-10), RESTART-07 (held-pipe quarantine across restart),
  OOS-01/02/04/05/06 (by design); multi-process races / kill-between-commit-and-response, `impl_hangs`
  timeout path (other roles' suites); browser rows (09). N/A by ruling: R-U3, R-U4, R-U5, WS-06.
- Observations unchanged: OBS-02, OBS-03, OBS-04; OBS-01 → R-Q2; OBS-05 refined by R-F5.


## Corrective v1.2 run (lead, final tree)

`bun --no-env-file test apps/hub/test/workspace-m1-adversarial` → **203 pass / 0 fail** (9 files). Changed for the
v1.2 contract (lead, recorded in OWNERSHIP.md): ADV-EVID-14b (original bytes from the durable bundle + validity
`invalid` after a sweep; tampered bytes never served), ADV-EVID-15 (pending result served from its bundle; host
file never served), harness draft builder maps criteria explicitly; ADV-G2-04/05 explicit mapping to their
fixture's `slow-check`. EVID-14 (post-acceptance invalidation/alert), previously NOT RUN under OQ-10, is now
covered by `evidence/validity.test.ts`, `bridge/durable-evidence.test.ts` and browser J-22 (not by a new 08 row).
