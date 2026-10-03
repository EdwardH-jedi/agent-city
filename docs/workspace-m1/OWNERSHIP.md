# Agent City M1 — ownership, gates and isolation (lead-owned)

Status: **frozen v1 ownership map** (lead). Changes only by the lead, recorded at the bottom.

## Baseline

| Item | Value |
| --- | --- |
| Source (read-only, never modified) | `/Users/edwardhwang/Desktop/github-repo-only/agent-city-v011`, `hardening/managed-v0.1.1` |
| Baseline commit | `f960055448e4f5a0bd93a7b9ca0aeb0d2ef8597d` (revalidated clean before cloning) |
| Implementation checkout | `/Users/edwardhwang/Desktop/github-repo-only/agent-city-m1` — independent `git clone --no-local` (own object store, not a worktree) |
| Branch | `feat/workspace-approvals-m1` (push URL disabled) |
| Dependencies | `node_modules` trees copied from v011 with the user's explicit approval; `bun.lock` byte-identical; no install, no network |
| Design source | SOL design: `/Users/edwardhwang/Desktop/github-repo-only/agent-city/docs/AGENT_CITY_WORKSPACE_DESIGN_2026-10-02.md` (read-only, not copied into this repo) |
| Specification | `SHARED_M1_SPEC.md` + role prompts (prompt pack, outside the repo) |

## Exclusive directory ownership

Each role writes **only** inside its directory (module-local unit tests included). Nobody edits another
role's directory or tests.

| Role | Exclusive directory |
| --- | --- |
| 01 contracts | `packages/schema/src/workspace-m1/` |
| 02 persistence | `apps/hub/src/workspace-m1/persistence/` (incl. proposed `008_*.sql` text, not registered) |
| 03 auth | `apps/hub/src/workspace-m1/auth/` |
| 04 decisions | `apps/hub/src/workspace-m1/decisions/` |
| 05 pipeline bridge | `apps/hub/src/workspace-m1/bridge/` |
| 06 evidence | `apps/hub/src/workspace-m1/evidence/` |
| 07 frontend | `apps/web/src/workspace-m1/` |
| 08 adversarial QA | `apps/hub/test/workspace-m1-adversarial/` (new tests + reports only) |
| 09 browser QA | `apps/web/e2e/workspace-m1/` (new tests + reports only) |

**Lead-owned (everything else)**, in particular: every pre-existing file; `packages/schema/src/index.ts`,
`packages/schema/package.json` (exports), `packages/schema/migrations/` (registration = adding the file);
`apps/hub/src/index.ts`, `apps/hub/src/routes/**`, `apps/hub/src/security.ts`, `apps/hub/src/db.ts`;
`apps/hub/src/managed/**` (service, orchestrator, store, evidence, adapters, worker, testkit);
`apps/web/src/App.tsx`, `useHub.ts`, `Tasks.tsx`, `style.css`, `main.tsx`; all `tsconfig*.json`,
`biome.json`, `package.json`, `bun.lock`, `.env.example`, `README.md`, `CLAUDE.md`/`AGENTS.md`, `docs/**`
outside a role directory; and the git index. Workers send **patch proposals** (unified diff or exact
before/after text in their report) for lead-owned files; the lead reviews and applies them.

A temporary single-writer **file lease** may be granted by the lead in writing (file, holder, expiry).

## Rules for every worker

- Work only under `/Users/edwardhwang/Desktop/github-repo-only/agent-city-m1`. Never write to
  `agent-city`, `agent-city-v011`, `agent-city-v01`, `agent-city-night` or any other directory
  except temporary test directories under `TMPDIR`.
- No git commands that write (`add`, `commit`, `stash`, `checkout`, `reset`, `restore`, …). Read-only
  `git diff`/`git status` is fine. Only the lead touches the index. No commits.
- No installs, no new dependencies, no network, no credentials, no provider CLIs (`claude`, `codex`),
  no live mode. Fake providers and disposable fixtures only.
- Never start the real hub, never use port 4317, never open `data/` or any real database, never load
  `.env` (none exists in this checkout; do not create one).
- Run commands through the isolated runner (cleared env, disposable HOME/AGENTCITY_HOME/TMPDIR, PATH
  with only `bun` and `git`):
  `/private/tmp/claude-501/-Users-edwardhwang-Desktop-github-repo-only-agent-city/c776e4a4-9f35-42ac-88c3-0ce6997b4382/scratchpad/iso/run.sh bun --no-env-file test <your-dir>`
  (also `… run.sh bunx biome check <your-dir>` and `… run.sh bun run typecheck`).
- Secrets: synthetic values assembled at runtime only (see existing tests); never real repo names,
  never real tokens; nothing secret in logs, fixtures, URLs or browser storage.
- Contracts: import M1 contracts from `@agent-city/schema/workspace-m1` (web-safe, zod only) and hashing
  from `@agent-city/schema/workspace-m1/hash` (Bun-only). Do not redefine contract types locally. A
  needed contract change goes to the lead as a versioned delta request; frozen v1 is not edited quietly.
- A Bash pre-tool hook (GateGuard) may require you to state (1) the current request in one sentence and
  (2) what the command verifies, before your first Bash command. State them and retry.

## Gates

| Gate | Exit evidence |
| --- | --- |
| M1A | Contracts v1 frozen (`packages/schema/src/workspace-m1/INTERFACE.md`); contract unit tests; migration `008` applied on a disposable DB with re-entry/reopen tests |
| M1B | Auth + atomic decisions + bridge into the existing bounded engine; legacy direct-run and public-WS managed-id bypasses closed; crafted live requests rejected before preflight with zero provider calls |
| M1C | Persistent DOM workspace + HQ queue on the real isolated test hub; both gates; reload/restart reconstruction |
| M1D | Independent adversarial (08) and browser (09) suites against the final integrated diff; aggregate checks; source-integrity comparison; secret scan |

## Change log

- v1 (2026-10-02): initial map.
- 2026-10-02: lead lease on `packages/schema/src/workspace-m1/INTERFACE.md` (role 01 parked) to apply the
  v1 freeze rulings (status, §2/§7 order, §11). Lease ended after the edit.
- 2026-10-02: lead lease on `packages/schema/src/workspace-m1/{api.ts,index.ts,INTERFACE.md}` for contract delta v1.1 (additive route table + response wrappers). Lease ended after the edit.
- 2026-10-02: lead lease on `apps/hub/src/workspace-m1/decisions/read-model.ts` (role 04 parked): artifact route does not use the sealed/retained shortcut for an `invalidated` result request (07 finding). Regression in `apps/hub/src/workspace-hub.test.ts`. Lease ended after the edit.
- 2026-10-02: lead lease on `apps/web/e2e/workspace-m1/hub.suite.ts` (role 09 parked): the isolation check compares `homedir()` with `userInfo().homedir` instead of a hard-coded user path. Lease ended after the edit. `scripts/docs-parity.test.ts` (lead) now also skips `*.suite.ts` test harnesses.
- 2026-10-02 (corrective, review findings): lead leases on `apps/hub/src/workspace-m1/decisions/{decision-service.ts,deps.ts,router.ts,test-support.ts}` and `apps/hub/src/workspace-m1/bridge/test-support.ts` for Fix 1 (fresh authoritative clock inside the decision/challenge transaction; test helpers pass the auth clock into the services).
  (+ `decisions/gate1.test.ts` expiry test now advances the authoritative clock instead of passing a request-start Date)
  - commands.ts storedDraft → redactDraft (criterion_checks keys redacted; lead, 2026-10-02 corrective)
  - corrective (lead): `decisions/gate2.test.ts` (receipt effects carry evidence_bundle_digest), `decisions/router.ts` (read model gets the auth clock; detail route awaits the full validity check), 08 `gate2-evidence.adv.test.ts` EVID-14b/EVID-15 re-expressed for the v1.2 durable-bundle contract (original bytes from the bundle; validity invalid; host/tampered bytes still never served).
- 2026-10-02 corrective: migration `010_proposal_contract_v1_2.sql` written by the evidence worker outside its lease (blocking: 008's CHECK forbids v1.2 snapshots); reviewed and approved by the lead.
- 2026-10-02 corrective: lead appended §11 (v1.2 case ids) to `apps/web/e2e/workspace-m1/MATRIX.md`.
- 2026-10-02 corrective: the evidence worker also changed one line of `packages/schema/src/workspace-m1/rows.test.ts` (outside its lease) so the required-nullable `acceptance_validity` view test sets the field; reviewed and accepted by the lead.
- 2026-10-03 campus milestone: lead applied Worker A's patches to `bridge/criterion-coverage.test.ts`, `decisions/criterion-coverage.test.ts` (legacy v1 Gate 1 is now refused) and doc/comment corrections (read-model comment, bridge NOTES, RUNBOOK, CONTRACT §A, CORRECTIVE residual windows).
- 2026-10-03 campus: lead applied Worker A's `ui-lead-proposals.patch` (Coverage.tsx shared satisfied note, gate.ts invalidation label, fx.suite.ts BRW-C-05 re-expressed: legacy Gate 1 refused, legacy result built via the fixture's pre-policy control).
- 2026-10-03 campus: lead mounted `<Campus/>` (CampusView + toCampusModel + createCampusActions) at the top of the Projects left pane above the unchanged Repositories/Tasks navigator; `.wsm1-campus-slot` rules appended to workspace.css.
  (campus mount moved to lead-owned `apps/web/src/workspace-m1/CampusSlot.tsx`; also mounted above the HQ Inbox in `HqView.tsx`)
- 2026-10-03 campus: Worker B (lead lease) appended one HQ obsolete-chip wrap rule to `workspace.css` (QA F2) and changed `campus/**` for QA F1 (two-line document buttons) and the "running" wording; Worker C adapted `campus-kit.ts` `visitTitleVisibility` to the new markup (threshold unchanged). Leases ended.
- 2026-10-03 campus: lead added `apps/web/src/workspace-m1/dev/preview-hub.ts` (dev tool: local preview on the browser suites' isolated harness; credential written to a 0600 temp file, never printed) and the RUNBOOK "Local preview" section.
- 2026-10-03 campus (final batch 1: HUB 104/4/2): lead lease on `campus/CampusView.tsx` (Worker B's) — the document strip is one tab stop (`role="toolbar"`, roving tabindex, arrows/Home/End), fixing BRW-A-01 (31 campus buttons ahead of the navigator); lead lease on `apps/web/e2e/workspace-m1/hub.suite.ts` (09's) — BRW-J-22 accepts the ruled "Proposal vN" label between gate and status (same assertion). Worker C adapts its own CMP-KEYBOARD. Leases ended after the edits.
- 2026-10-03 campus (final batch 2: HUB 105/3/2): lead lease on `hub.suite.ts` again — BRW-A-01's Shift+Tab budget 60 → 90 (the helper's default) and the press count added to its detail; the campus costs exactly 3 stops after the toolbar fix (Worker C's CMP-KEYBOARD-toolbar), the remaining distance is the ~60-item task list the case already traversed. Lease ended after the edit.

- 2026-10-03 post-review repair: the human user's explicit "다하고 깃허브에 푸쉬해줘" authorizes the lead to
  repair the two confirmed P2 defects, commit the reviewed M1 delivery plus repairs, and push its feature branch.
  Lead repair ownership: web `store.ts`, `store.test.ts`, `labels.ts`, `WorkspaceApp.tsx`, `campus/engine.ts`,
  `e2e/workspace-m1/campus-recovery.suite.ts`, delivery/campus/ownership records and evidence NOTES. No concurrent
  worker lease is active. No changes to frozen contracts, hub authority, migrations, provider policy or global
  configuration; managed-run GitHub operations remain read-only. The disabled origin push URL is preserved;
  manual delivery uses the verified GitHub URL directly, without force or a main-branch update.
