# Repair record — fresh independent review findings (2026-10-05)

Review: `/private/tmp/agentcity-fresh-review-d2tplqa2/REVIEW.txt` — verdict **NO-GO**, observed campus
**CLOSED**, at the committed baseline `d158571a8103d2bee315399ddea09607ccea1702` (branch
`feat/workspace-approvals-m1`). Scope: its three findings only — APP-P2-01, APP-P2-02, RUN-P2-01. The observed
campus stays `CLOSED_PENDING_REVIEW`; nothing here is an independent review, grants Gate 1 / Gate 2 authority
or changes approval payloads, bindings, challenges, decisions, evidence or execution authority. Simulated only:
no live provider, no real repository execution, no merge / push / deploy. All changes are **unstaged and
uncommitted** on top of `d158571` for an independent review of the exact working tree.

The read contract written before the read changes is [`REPAIR_READ_CONTRACT_2026-10-05.md`](REPAIR_READ_CONTRACT_2026-10-05.md).

## Starting identity

| Item | Value |
| --- | --- |
| HEAD | `d158571a8103d2bee315399ddea09607ccea1702` (= reviewed), 0 staged |
| Working tree at start | 12 status entries of an earlier, interrupted repair attempt overlapping the same findings (tracked diff sha256 `2485a063…`, untracked manifest `c280fac6…`) |
| Decision | the user chose to adopt those changes as the starting point; they were first preserved byte-for-byte outside the checkout (tracked patch, untracked tar + sha256 list, mtimes) |
| Changes made to the adopted state | see each finding; the adopted `packages/schema/migrations/011_workspace_read_pages.sql` and its cursor epoch were dropped (below) |

## RUN-P2-01 — runner launch failure never settled

`scripts/ci/isolated.ts`: `error`, `exit` and `close` settle one terminal result exactly once; a launch error is
final at once (no exit event is awaited). A missing pid means no process group exists: nothing is signalled and
cleanup is reported as `no_process_launched`, never as a confirmed absence. `ESRCH` is the only proof of
absence; `EPERM` and other failures are `unknown` and get a kill attempt. Exit code 127 (ENOENT), 126 (EACCES),
1 (other launch errors); `run.json` is written on every path and records `launch_error`,
`process_group_created`, `cleanup_status` and `cleanup_kill_attempted`. The time limit and SIGINT / SIGTERM
handling for launched commands are unchanged.

Regressions (`scripts/ci/ci-tools.test.ts`, each run under its own outer SIGKILL bound so a hang fails instead of
blocking): ENOENT → 127 + `no_process_launched`; EACCES → 126; a launch failure racing a 1 s time limit → 127,
not 124; bounded success and nonzero exit pass through with `confirmed_absent`. Against the baseline runner the
same four tests fail 0 / 4 (the launch-failure cases hang to the outer bound; the bounded case has no
`run.json`); the baseline ENOENT hang was reproduced under the review's watchdog (alive at 8.07 s, SIGKILLed, no
`run.json`).

## APP-P2-01 — omitted history read as quiet

- Hub: `repo_summaries` in the snapshot — one complete grouped-SQL aggregate per allowlisted repository over
  every stored task (phases, disjoint categories, active tasks, pending requests, stored acceptance-validity
  facts with oldest / latest check). No task rows or artifacts are loaded for it.
  `apps/hub/src/workspace-m1/decisions/collections.ts` (`ATTENTION_SQL` mirrors `repositoryCategory` in
  `packages/schema/src/workspace-m1/summary.ts`: ended executions, accepted results whose stored validity is
  invalid / unknown / missing, open quarantine — unless a decision is pending).
- Hub: `GET /api/workspace/task-history?repo_id&filter=all|attention&limit&cursor` — bounded keyset pages
  (`created_at DESC, id DESC`), scope-bound cursors (400 on mismatch / invalid, 422 for an unallowlisted
  repository), page metadata `total / returned / complete / has_more / next_cursor / as_of`.
- Web: the briefing takes counts from the aggregate; it never says "Nothing is running" or "Assign work" while
  the aggregate shows attention / work outside the window, and its next action opens the repository history
  (`Open repository history`). The Projects view gets a bounded `Repository history` section (All / Needs
  attention, Load more, Retry on error, rows open the existing task detail). Campus `has_invalid_acceptance` and
  active counts come from the aggregate.

## APP-P2-02 — inbox / queue beyond the 500-task window

- Hub: every emitted approval request carries server-derived `repo_id` and `task_title` (display facts read from
  its owning task, never authority). `execution_queue.total_executions` / `queued_complete` disclose the queue's
  completeness; campus / briefing active counts come from `repo_summaries`, so a queued A execution is counted
  even when its task row is outside the window.
- Hub: the snapshot's inbox is the first page of `GET /api/workspace/inbox?repo_id&kind=run|result&limit&cursor`
  with `limit = SNAPSHOT_INBOX_LIMIT` (500); `pending_page` discloses its total and continuation cursor. Pages
  order by `created_at ASC, id ASC`; a request decided between pages leaves the set without a gap or duplicate.
- Web: the Repositories card ("N active tasks · M awaiting Edward") takes the complete summary (its existing
  non-terminal definition: tasks minus accepted / rejected / cancelled) instead of the cut window — found while
  inspecting the browser evidence (A showed "0 active tasks" while the briefing and campus showed its run).
- Web: Headquarters states "Showing N of M pending …"; `Load more` continues the snapshot's page (same cursor,
  same page size) and never loops automatically; the Repository filter lists every allowlisted repository with
  its complete pending count and is a server query; text search is labelled as searching loaded rows only.
  Wording that claimed "every" decision was removed. Selecting a paged request uses the unchanged task detail,
  challenge and decision flow; committed receipts still close both gates.
- Store: per-collection tickets — a late page after a repository / filter / view / auth change is dropped; a
  load-more failure keeps every loaded row; Retry continues the same cursor; merges deduplicate by id and never
  let an older revision replace a newer one; sign-out / sign-in purge both collections. A fresher task read
  (e.g. the re-read after a committed decision) folds into the loaded rows: a history row takes it unless it is
  older; a paged request it proves decided leaves the loaded inbox page (whose total follows). Membership is
  never extended by the client — it stays the server's query. The TopBar pending count is the snapshot's
  `pending_page.total`; when that first page was the whole pending set, a local merge / fold keeps it equal to the
  list, and a truncated page keeps the server's total until the next read.

## Regressions added

| File | What it pins |
| --- | --- |
| `apps/hub/test/workspace-m1-adversarial/review-repair.adv.test.ts` | review reproductions through the real composition: A failed / blocked / accepted-invalid behind 500 newer B tasks; history continuation exactly once; pinned pending A; 499 / 500 / 501 with a held queued A; ownership vs the database; C by filter and by continuation; a decision between pages; Gate-2 under `kind=result`; scope / bounds / invalid cursor / unallowlisted repository. 10 / 0 here, 0 / 10 on pristine `d158571` |
| `apps/web/src/workspace-m1/collections.test.ts` | store paging: late pages, filter supersede, load-more failure + Retry, no regression by older duplicates, sign-out purge, global continuation from the snapshot cursor (including Retry after a failed FIRST continuation), filtered server query, leaving HQ |
| `apps/web/src/workspace-m1/briefing.test.ts` (APP-P2-01 block) | aggregate-driven counts; no quiet / assign-work claim with omitted attention; history next action |
| `scripts/ci/ci-tools.test.ts` | the four RUN-P2-01 cases above |
| `apps/web/e2e/workspace-m1/review-repair.suite.ts` (`bun run test:browser:repair`) | real hub + headless Chromium, 1440×900 and 1280×800: RR-01 omitted invalid history, RR-02 held queued A counted, RR-03 HQ disclosure + Load more to C, RR-04 load-more failure keeps rows + Retry, RR-05 server filter to C → gate → committed receipt closes the controls, RR-06 no horizontal overflow; console / foreign-request gates |

Existing expectations changed, each because it encoded the reviewed defect or a reworded claim: the reviewed
idle case in `briefing.test.ts` now expects attention; two fixtures gained an explicit valid validity record
(a missing record is now unknown → attention); the task-window note no longer says "every"; the HQ repository
option shows its complete pending count (`p2-real-hub.test.ts`). Exact-shape checks that meet the additive API:
ADV-REPAIR-09 lists the two new GET-only read routes (`review-repair.adv.test.ts` asserts they refuse non-GET
methods and write no decision); ADV-MR-01's `execution_queue` gains `total_executions` / `queued_complete`; the
web-safety bundle probe expects 13 routes instead of 11.

The first browser run found a real product defect the units had missed: Retry after a failed FIRST global
continuation did nothing (the store took the cursor as absent once an error state existed). Fixed in
`store.loadInbox`, with a unit regression; the rerun passed 8 / 0. A self-review then found that a request
decided from a continuation or filtered page stayed listed as pending (only the snapshot's own list took the
re-read); fixed by `foldTaskIntoCollections`, with unit regressions and an RR-05 browser check. Final measured
results are in the external handover.

## Decisions and limits

1. **No migration.** The draft `011_workspace_read_pages.sql` and its cursor epoch were removed before any run;
   `PRAGMA user_version` stays 10. Keyset paging over immutable keys needs no epoch / 409 (contract doc).
2. **Query cost (disclosed).** The inbox page uses `idx_approval_status`. The history page and the grouped
   summaries scan `workspace_tasks` (`SCAN t`, temp B-tree for the order / grouping): bounded SQL that returns at
   most `limit + 1` rows / one row per group, but its cost grows with the stored task count. An index on
   `workspace_tasks(repo_id, created_at, id)` would remove the scan; it is left for review because it needs a
   migration. Plans are recorded in the external evidence.
3. **Facts, not revalidation.** Acceptance-validity counts are the stored current-validity facts of periodic
   checks, with oldest / latest check time; nothing re-verifies every artifact at read time.
4. **Pages are current reads.** Membership of a filtered view can change between pages; `total` / `as_of`
   disclose it. The snapshot's `tasks` window stays bounded at 500; no caps were raised.
5. **Older hubs.** A snapshot without `repo_summaries` is judged from the window alone; when that window may be
   incomplete the briefing makes no quiet claim, states that facts may be missing and points to Headquarters
   filtered to the repository instead of reporting zero.

## NOT RUN / limits

Real providers / live execution, real repository execution, the real hub on 4317, the real database, real
`.env` / credentials, hosted CI (nothing pushed), Firefox / Safari / WebKit, axe-core, manual screen-reader
checks. `live_integration_verified` stays false; real provider launches by the test pipeline: 0. These are the
implementer's own results — an independent review of this exact working tree is required before the observed
campus milestone can open. Final gate results and the frozen-tree identity are in the external handover (this
document cannot carry its own hash).

## Reproduction

```sh
R=/tmp/agentcity-repair-review   # any fresh directory outside the repository
bun --no-env-file scripts/ci/isolated.ts --root $R --label repair-units --timeout 600 -- bun --no-env-file test \
  apps/hub/test/workspace-m1-adversarial/review-repair.adv.test.ts apps/web/src/workspace-m1/collections.test.ts \
  apps/web/src/workspace-m1/briefing.test.ts scripts/ci/ci-tools.test.ts
bun --no-env-file scripts/ci/isolated.ts --root $R --label repair-browser --timeout 1150 \
  --browsers ~/Library/Caches/ms-playwright -- bun --no-env-file run test:browser:repair
bun --no-env-file scripts/ci/isolated.ts --root $R --label hub --timeout 2340 \
  --browsers ~/Library/Caches/ms-playwright -- bun --no-env-file run test:browser:hub
```
