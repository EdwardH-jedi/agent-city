# Corrective record — independent review P2 findings (2026-10-04)

Review: `/private/tmp/agentcity-independent-review-map4qygk/REVIEW.txt` (verdict NO-GO for the read-only
observed-repository campus feature at `b99fe086ea3ba669e5511aca7e29dd137afd0094`: four P2 findings, complete
real-hub browser gate 109 PASS / 1 FAIL on BRW-J-01.C9). Scope of this record: those four findings only. The
observed-repository campus milestone was not started. Simulated only: no live provider, no real repository
execution, no merge / push / deploy. All corrective changes are left **unstaged and uncommitted** for an
independent Codex review of the exact working tree.

> **Status note (2026-10-05).** The "unstaged and uncommitted" wording above describes the 2026-10-04
> implementing session only. Those changes were later committed as `d158571a8103d2bee315399ddea09607ccea1702`
> (`fix(workspace): P2 review corrective F-01..F-04 [checkpoint — pending independent Codex review]`); `d158571`
> is the committed baseline that the fresh independent review of 2026-10-05 examined (verdict NO-GO, observed
> campus CLOSED; findings APP-P2-01, APP-P2-02, RUN-P2-01). That review rated F-01 PARTIALLY_FIXED and F-02,
> F-03, F-04 FIXED_IN_REVIEWED_SCOPE. The repairs of its findings are recorded in
> [`REVIEW_REPAIR_2026-10-05.md`](REVIEW_REPAIR_2026-10-05.md); they, in turn, are unstaged and uncommitted on
> top of `d158571`.

Finding numbering: the task brief numbers the findings 1–4; the review's ids are F-01 (task window), F-02
(freshness), F-04 (committed decision) and F-03 (legacy focus). This record's headings use the review's ids.
Source comments and test / step names use the brief's numbering: `P2 F-01` = task window, `P2 F-02` =
freshness, **`P2 F-03` = committed receipt (review F-04)**, **`P2 F-04` = legacy focus (review F-03)**.

## Starting identity (2026-10-04, before any edit)

| Item | Value |
| --- | --- |
| Checkout / branch | `/Users/edwardhwang/Desktop/github-repo-only/agent-city-m1` · `feat/workspace-approvals-m1` |
| HEAD | `b99fe086ea3ba669e5511aca7e29dd137afd0094` (= reviewed) |
| Ancestry | `eeeef8553fe6e30511abc0710370782cd77f34a7` is an ancestor; 8 commits after it (`c2790e0`, `ab69326`, `5ca8c8b`, `1f42480`, `eeac451`, `47c5cd0`, `bf6786c`, `b99fe08`) |
| Working tree | clean: 0 modified, 0 staged, 0 untracked (non-ignored); 374 tracked files |
| Tracked-file manifest | `git ls-files -z \| xargs -0 shasum -a 256` → list sha256 `1916f7a41c1831cec337d784467d1349f119f1d18f4f7b19edf90471b1b7913c` (kept outside the repo with the `git ls-files -s` mode list) |
| Match with the reviewed candidate | identical (reviewer `preservation.json`: same branch / HEAD / clean status / 374 files) — no overlapping change to explain |
| Design commit `84329c8` | not in this checkout's object database (`git cat-file` → not a valid object); not used, not merged, ancestry not established |

Review evidence read: `REVIEW.txt`, `REPRODUCE.txt`, `findings.json`, `verification.json`, `preservation.json`,
the probe scripts (`probes.ts`, `freshness-probe.ts`, `settlement-probe.ts`, `legacy-focus-probe.ts`,
`ordering-probes.ts`, `signal-probes.ts`) and their JSON outputs. The review directory was not modified.

## Method

1. **Reproduce on the unmodified tree.** The reviewer's probes were copied to a scratch directory outside the
   repository with only their import paths re-pointed at this checkout and their output paths moved (the
   originals overwrite the review's JSON). Each ran through `scripts/ci/isolated.ts` (disposable HOME /
   AGENTCITY_HOME / TMPDIR, no `.env`, provider CLIs hidden, external time limit) on the unmodified tree:
   all four reported `reproduced: true` with the review's values (500 snapshot tasks, A omitted, briefing
   `empty`; B `current` from A's detail time; enabled empty signature input beside "Execution approved"; focus
   on `H2 detail-heading` with the typed text kept).
2. **Failing-before evidence for every new regression.** A pristine copy of `b99fe08` (`git archive`, plus
   copy-on-write clones of the existing `node_modules`; nothing installed, the checkout and its `.git` untouched)
   ran each new regression file through the same runner. One shim, recorded here: the pristine copy of
   `p2-corrective.test.ts` defines `SNAPSHOT_STALE_AFTER_MS = 10_000` locally because the export is new.
3. **Fix, then passing-after on the corrected tree**, then the full gate set on the final tree (below).

## F-01 — a bounded task window manufactured an empty repository briefing

**Cause.** `read-model.ts` selected the globally newest 500 tasks independently of the pending-request list;
`briefing.ts` read "no task of this repository in the slice" as "no tasks"; Headquarters and the repository
building derived a request's repository from the same slice.

**Change (narrow, additive; no route, migration or stored-row change).**
- `packages/schema/src/workspace-m1/api.ts`: `RepoTaskCount {repo_id, tasks}` and `WorkspaceSnapshot.repo_task_counts`
  (one entry per allowlisted repository, complete count). `tasks` documented as a bounded window.
- `apps/hub/src/workspace-m1/persistence/store.ts`: `listTasks(limit, pinned?)` — pinned ids are selected first
  (priority order), then the newest; the result keeps the newest-first order. Unpinned calls are unchanged.
- `apps/hub/src/workspace-m1/decisions/read-model.ts`: the snapshot pins every task named by the emitted
  `pending_requests` (inbox first) and `execution_queue`, and emits `repo_task_counts` from one `GROUP BY` in
  the same synchronous snapshot. Payload stays ≤ 500 tasks; `repo_task_counts` ≤ allowlist size.
- `apps/web/src/workspace-m1/briefing.ts`: `empty` only when the complete count is 0; otherwise the summary
  states "Showing N of M recorded tasks; K … not in this snapshot (…)" (`taskWindowNote`). When some of the
  repository's tasks are not shown AND an inbox / queue entry cannot be matched to a listed task (or a list is
  at its cap), the briefing makes no "nothing waiting" claim, raises `attention`, notes it and offers
  Headquarters. `RepoBriefing.window {shown, recorded, complete}`; `Briefing.tsx` adds
  `data-briefing-complete`. No new `data-briefing-state` value (the frozen set is unchanged).
- `apps/web/src/workspace-m1/ProjectsView.tsx`: the task list says "No tasks yet" only on a complete count of 0;
  otherwise `[data-testid=task-window-note]` states the window.
- `apps/web/src/workspace-m1/labels.ts` (copy), `fixture-world.ts` (the fixture lists every task, so its counts
  are complete).

**Regressions.**
- `apps/hub/src/workspace-m1/decisions/snapshot-window.test.ts` (5): one pending A task then 500 newer B drafts;
  exact boundary (499 → every task, the 500th newer draft drops only the oldest draft); pending work in A and B
  behind 500 newer C drafts with per-repository filtering; an approved queued A execution behind 500 B drafts;
  a genuinely empty repository counted 0. Bounded payload, newest-first order and inbox → task resolution
  asserted. **Before (pristine): 0 / 5** (A absent; inbox unresolvable; queued A absent; no counts). **After: 5 / 5.**
- `briefing.test.ts` F-01 block (7): reviewed case, pinned pending request with hidden history, unattributable
  inbox entry, inbox at its cap, exact boundary (summary unchanged when complete), genuinely empty vs truncated
  repository, counts not reported. **Before: 7 fail / 21 existing pass. After: 28 / 28** (with F-02 block: 34 / 34).
- `p2-real-hub.test.ts` F-01 (real hub over HTTP, production store, rendered Headquarters): A's inbox item carries
  `data-repo-id`=A, the label and the Repository filter name A, never "repository unknown"; A's briefing is
  `attention` with 1 awaiting approval; B states "Showing 499 of 500". **Before: fail** (A absent). **After: pass.**

## F-02 — a fresh A detail made stale B facts read as current

**Cause.** The briefing's freshness used `conn.lastConfirmedAt`, which every successful read stamps — a task
detail read included — so an answered A detail certified B's cached snapshot facts; a failed snapshot read
left no trace.

**Change.**
- `apps/web/src/workspace-m1/store.ts`: `WsState.snapshotSync {confirmedAt, failedAt}` written **only** by
  `loadSnapshot` (success → confirmed now, failure cleared; any non-401 failure, network or HTTP → `failedAt`);
  reset on sign-in and purge. Detail reads and connection liveness never touch it. The Sequencer already drops
  stale snapshot answers, so a late older answer can neither clear a newer failure nor undo a newer success.
- `apps/web/src/workspace-m1/briefing.ts`: `BriefingInput.sync`; freshness = `offline` (connection offline) →
  `stale` (connection stale | latest snapshot read failed | snapshot older than `SNAPSHOT_STALE_AFTER_MS`
  = 10 s, five missed 2 s polls | never confirmed / not supplied) → `current`. "Last confirmed" is always the
  snapshot read's time. The accepted-result validity label inside a non-current briefing is aged with it.
  `Briefing.tsx` passes `state.snapshotSync`. Last-known data stays displayed, labelled.

**Regressions.**
- `p2-corrective.test.ts` F-02 block (7, fixture transport, injected clock, barriers): the reviewed sequence and
  its resolution by a snapshot read; both completion orders (detail-then-failed-snapshot = offline); HTTP-error
  snapshot (connection online, facts stale); repeated failures keep the original time; threshold
  (= 10 000 ms current, +1 ms stale); out-of-order answers both ways; repository switching and sign-out.
- `briefing.test.ts` F-02 block (6): pure freshness rules incl. the boundary and the never-confirmed case.
- `p2-real-hub.test.ts` F-02 (real hub): B cancelled through another client, failed snapshot, +61 s, A detail
  answered → B not current, last confirmed = the boot snapshot's time; a snapshot read → current, B cancelled.
- **Before (pristine):** the reviewed sequence and its variants fail with `freshness "current"`; real hub fails
  `Expected: not "current"`. **After: pass.**

## F-04 — approval success left an enabled confirmation field

**Cause.** `settle()` marked the attempt `committed` and cleared the signature, then awaited detail/snapshot
reads; until they answered, the cached request was `pending`, a committed attempt did not block, and HQ
rendered the enabled, empty signature input under "Execution approved" (BRW-J-01.C9 in the complete gate).

**Change.**
- `apps/web/src/workspace-m1/decision-attempt.ts`: pure `closingReceipt(attempt, request)` — a committed
  attempt's hub receipt closes exactly the request it names (same request id and binding hash, and only until a
  read of that request newer than the receipt's request rev speaks for it). Unknown outcomes have no receipt.
- `apps/web/src/workspace-m1/store.ts`: `committedReceipt(request)` (also requires the attempt's auth
  generation); `gateContext().pending` is false while it holds, so no challenge is requested and `decide()`
  is refused locally. The gate is **not** nulled (that would let `ensureGate` reopen it from the cached request).
- `apps/web/src/workspace-m1/HqView.tsx`: while the cached request is still `pending` but our receipt closes it,
  the document foot shows `[data-testid=decision-receipt]` — "This request is approved · operator · Approve ·
  time (from the hub's decision receipt; the request record is being refreshed). No further decision is
  possible on it." — instead of the controls. The Request chip / Decision history keep showing the last read
  record until the reads land (known result kept distinct from unrefreshed data); nothing about pipeline
  progress is inferred from the receipt.

**Regressions.**
- `p2-corrective.test.ts` F-03 block (6, fixture transport + rendered HQ): Gate 1 and Gate 2 with reads held after
  the commit (no signature input, no grant button, closed statement, `pending=false`; a duplicate activation sends
  no challenge and no second POST; released reads close the request by its own record); subject switching (A's
  receipt never closes B); a late A receipt after selecting B; unknown outcome keeps "Check decision outcome" and
  the identical-bytes retry has one effect; sign-out drops the receipt.
- `p2-real-hub.test.ts` F-03 (real hub, Gate 1 and Gate 2): durable decision with reads held → no signature input,
  one durable decision after a second attempt, zero provider spawns; reads reconcile.
- **Before (pristine):** Gate 1 / Gate 2 fail `signature inputs: expected 0, received 1` (fixture and real hub).
  **After: pass.** Browser: the complete real-hub gate (BRW-J-01.C9 included) — see Verification.

## F-03 — legacy availability recovery stole typing focus

**Cause.** `Tasks.tsx` set the focus intent `always` on every row click and never consumed or invalidated it, so
a selection made during a 503 kept its intent through Retry; the late detail then focused its heading although
the user was typing in the restored form. The existing coverage reloaded the page, which reset the intent.

**Change (`apps/web/src/Tasks.tsx`).** The intent is set only for a genuinely new selection (a re-click shows no
new detail), consumed once the detail it targeted is shown, and invalidated when a 503 replaces the view with
the availability gate. A selection's intent also never takes focus from a text field the user entered after the
selection (`focusOrigin`): a deliberate selection with nobody typing, deep links and creates behave as before.

**Regressions (`apps/web/e2e/browser-gate.ts`, legacy gate; barriers, frame-settled checks, no fixed delay as
a success condition).**
- no reload: select B during a 503 → Retry → type → B's held detail → focus and text stay, later keystrokes land;
- two Retries (the first still 503, the gate never leaves) and a stale earlier answer (A) released first → focus
  stays; a new row selection afterwards still lands on its heading;
- a selected row's held detail never takes focus from a field entered after the click; the same delayed
  selection with nobody typing lands on its heading.
- **Before (pristine): 32 / 35** — exactly the three new checks fail `focus moved to h2[data-testid=detail-heading]`.
  **After: 35 / 35.**

## Decisions a reviewer may ask about

1. **Contract label stays `agentcity.workspace-api/v1.2`.** The `repo_task_counts` field is a required addition
   to the snapshot of the still-unaccepted v1.2 delta (the review that this answers was a NO-GO on it). The label
   is not sent on the wire; hub and web ship together; only `web-safety-build.ts` and docs read it. Recorded in
   INTERFACE.md §11b as a "v1.2 corrective addition".
2. **`p2-real-hub.test.ts` lives in `apps/web/src`** (the web project excludes `*.test.ts` from `tsc`, so the
   test can import the hub's adversarial harness). It starts in-process hubs with fake adapters only and
   asserts `providerSpawns() === 0`; it does not call `assertIsolation()`, so it adds no provider-free-PATH
   precondition to `bun run test:unit` (not separately run on a developer shell here). Every recorded run here
   went through `isolated.ts`.
3. **Known limits of F-01.** With every inbox / queue entry attributable, a briefing whose window omits some of
   the repository's tasks still makes the quiet claim; the omitted history may include blocked / failed /
   invalid-acceptance tasks — the note states their number, not their kind. `campus/presentation.ts` still counts
   a building's `active_tasks` from the window. A pending list beyond 500 requests (pre-existing inbox cap) is
   reported as "could not be matched", not listed.
4. **F-04 transient display.** Between the receipt and the follow-up reads the document shows the receipt's
   closed statement next to the last-read Request chip and history (by design: the receipt is authoritative for
   this request's decision; the rest is labelled as being refreshed).

## Verification on the final tree

Every command ran from the checkout through `scripts/ci/isolated.ts` (fresh `<root>/<label>`; HOME /
AGENTCITY_HOME / TMPDIR disposable; PATH = bun + git + system dirs; `--no-env-file`; cached Playwright Chromium
via `--browsers`), sequentially, nothing else running. Every `run.json`: `interrupted false`,
`leftover_processes_killed false`. Counts are per suite and overlap; they are never added into a unique total.
The source tree did not change after these runs except this document.

| Check (command after `isolated.ts … --`) | Result |
| --- | --- |
| `bun --no-env-file run lint` | exit 0 — 325 files, no fixes |
| `bun --no-env-file run typecheck` (schema, hub, collector, web, web/e2e) | exit 0 |
| `bun --no-env-file test` (full: unit + integration + adversarial) | **1894 pass / 0 fail, 119 files** (250 s). Includes the 35 new tests: hub window 5, briefing F-01 7 + F-02 6, store/HQ 13, real hub 4 |
| `bun --no-env-file scripts/check-secrets.ts` | ok — 377 files (rerun after this document: see the handoff) |
| `bun --no-env-file run build:web` | exit 0 (the existing > 500 kB campus chunk warning, not suppressed) |
| `bun --no-env-file run build:web:workspace-prod <dir>` | exit 0 — 5 files |
| `bun --no-env-file apps/web/src/workspace-m1/dev/web-safety-build.ts` | exit 0 — `ok: true`, 0 problems |
| `bun --no-env-file run managed:demo` | exit 0 — 8 / 8 simulated scenarios as expected |
| **Complete real-hub browser gate** `run test:browser:hub` (no filter, `--timeout 2340`) | **110 PASS / 0 FAIL / 0 NOT RUN / 0 BLOCKED** — `BRW-J-01.C9` PASS (135 ms); exit 0 after 753 s |
| Multi-repository browser gate `run test:browser:multi` | **27 PASS / 0 FAIL / 0 NOT RUN / 0 BLOCKED** (178 s) |
| Legacy browser gate `run test:browser` (incl. the three no-reload P2 F-04 focus checks) | **35 / 35** (64 s) |
| Campus browser gate `run test:browser:campus` | 36 PASS / 0 FAIL / 0 NOT RUN (212 s) |
| Production recovery `run test:browser:recovery <prod dir>` | 12 PASS / 0 FAIL (94 s) |
| Fixture browser gate `run test:browser:fx` | 30 PASS / 0 FAIL / 24 NOT RUN — the 24 are the FX-optional cases the HUB set decides (as at baseline and in the review); not new |

Reviewer probes re-run on the final tree (copies; imports re-pointed, outputs moved; logic unchanged):

| Probe | Final tree |
| --- | --- |
| `probes.ts` (authority + F-01) | 10 / 10 authority checks pass (observed / casing / unknown → 422 no insert; distinct bindings; A challenge on B → 409; 12 duplicate decisions → one effect; one global lease; waiting-B cancel; foreign artifact 404; Gate-2 exact Edward; zero provider spawns); F-01 **reproduced: false** (A in the 500-task snapshot, briefing `attention`, "1 awaiting execution approval.") |
| `freshness-probe.ts` (F-02) | **reproduced: false** — briefing `stale`. The probe calls `repoBriefing` without the new `sync` input, so it reads the fail-closed "last confirmed never"; the supplied-sync path is covered by `p2-real-hub.test.ts` F-02 |
| `settlement-probe.ts` (F-04) | **reproduced: false** — durable `approved`, cached `pending`, `gateContext.pending false`, no signature input rendered |
| `legacy-focus-probe.ts` (F-03) | **reproduced: false** — focus stays on `INPUT new-title`, text kept |
| `ordering-probes.ts` (decision vs invalidation, both gates, both orders) | 4 / 4 |
| `signal-probes.ts` (CI wrapper exit contract) | 4 / 4 |

Historical results (the milestone's 1859 / 110 / 27 / 32 / 36 / 12 / 30, the review's 109 / 1) are records of
earlier trees and are not restated as current. A focused replay was not used for any acceptance claim.

## Observation outside the repair scope (not changed)

`scripts/ci/isolated.ts` does not exit when its command cannot be spawned (ENOENT, e.g. a command word that
contains spaces): it logs the spawn error, announces stopping the process group at its time limit, and keeps
running (100 % CPU) until killed externally; no `run.json` is written. Reproduced with
`--timeout 3 -- "no-such-command --flag"` under an external 8 s alarm (exit 142). Every gate command spawns
normally, so recorded runs are unaffected; a mistyped command in CI would hang until the job's own timeout.
Reported for a separate change.

## NOT RUN / limits

- NOT RUN: real providers / live execution, billing or subscription probes, real repository execution, the
  real hub on 4317, the real database, real `.env` / credentials, hosted CI on this working tree (nothing was
  pushed), real GitHub sync / discovery, Firefox / Safari / WebKit, axe-core, manual MacBook / screen-reader
  checks. Only cached headless Chromium was exercised.
- Simulated only: `live_integration_verified` stays false; nothing here establishes real-provider readiness, OS
  containment, multi-host scheduling or production service readiness.
- The F-01 limits under "Decisions" 3 and the F-04 transient display under "Decisions" 4.
- Not a review: these are the implementer's own results. Independent Codex review of this exact working tree is
  required before the read-only observed-repository campus milestone starts.

## Process and preservation

- One implementer, no delegation (F-02 and F-04 share `store.ts`; one owner). No install, upgrade, global
  configuration change, sibling-checkout change, port-4317 use or provider launch.
- The pristine baseline (`git archive` of `b99fe08` + copy-on-write `node_modules`) and every run root live in
  the session scratch directory, outside the repository. Test-generated `.env` fixtures of the collector tests
  exist only inside those disposable suite roots; they are not part of any evidence list here.
- Stopped processes: one runner process of this task, which never spawned its command (the ENOENT observation
  above), was stopped by its pid (SIGTERM, then SIGKILL). No other process was signalled.
- The final working-tree identity (tracked diff hash, untracked manifest, unchanged-file check) is reported in
  the handoff — this document cannot contain its own hash.

## Reproduction (for the Codex review)

From the checkout, with the isolated runner (zsh does not split a `$W` variable — call it directly):

```sh
R=/tmp/agentcity-p2-review   # any fresh directory outside the repository
bun --no-env-file scripts/ci/isolated.ts --root $R --label unit --timeout 1800 -- bun --no-env-file test
bun --no-env-file scripts/ci/isolated.ts --root $R --label hub --timeout 2340 \
  --browsers ~/Library/Caches/ms-playwright -- bun --no-env-file run test:browser:hub
bun --no-env-file scripts/ci/isolated.ts --root $R --label legacy --timeout 540 \
  --browsers ~/Library/Caches/ms-playwright -- bun --no-env-file run test:browser
# focused regression groups
bun --no-env-file scripts/ci/isolated.ts --root $R --label p2 --timeout 600 -- bun --no-env-file test \
  apps/hub/src/workspace-m1/decisions/snapshot-window.test.ts apps/web/src/workspace-m1/briefing.test.ts \
  apps/web/src/workspace-m1/p2-corrective.test.ts apps/web/src/workspace-m1/p2-real-hub.test.ts
```

The review's own probes reproduce against this checkout once their `./source/` imports point here (output
paths should be moved so the review's JSON is not overwritten).
