# Campus post-review repair — 2026-10-03

The independent campus review completed without changing its target. The user's subsequent instruction
"다하고 깃허브에 푸쉬해줘" authorizes completion, commit and push of the reviewed M1 implementation and the
confirmed repairs. Delivery targets `feat/workspace-approvals-m1` on `EdwardH-jedi/agent-city`; no main-branch
update, deployment or live-provider enablement is part of this delivery.

## Source and scope

- Target: `/Users/edwardhwang/Desktop/github-repo-only/agent-city-m1`.
- Starting HEAD: `f960055448e4f5a0bd93a7b9ca0aeb0d2ef8597d`; branch `feat/workspace-approvals-m1`.
- The reviewed tree already contained 25 modified tracked files and 229 untracked M1 files. Its reviewed identity
  and the repair-start snapshot are identical: `466ff9a5f3d7965d8f7b9ca1e3e34e145879d94912f6ca2e3f3e613e9c0c9abf`.
  The snapshot inventories all Git-tracked and nonignored untracked paths with kind, path, file/symlink mode,
  byte count and SHA-256; identity hashes compact sorted-key JSON containing those rows, root, HEAD, branch,
  binary tracked/staged diff hashes and NUL-separated porcelain status hash. Dependencies, ignored runtime
  files and credentials are excluded. `DELIVERY.md` is hashed separately in the same inventory.
- Repair evidence: `/private/tmp/agent-city-campus-repair-j4502wc5`; preceding independent review:
  `/private/tmp/agent-city-campus-review-a6ddkh_x/REVIEW_REPORT.txt`.

## Confirmed defects and repairs

1. **Idle freshness (F1, P2).** A signed-in store now publishes its existing one-second presentation tick even
   with no open gate and no completed reads. Task detail, HQ, history and the connection banner age while polls
   hang. A stale connection makes an otherwise valid reading neutral and qualified; `checked_at`, authoritative
   validity, revisions, decision effects and receipt bindings remain unchanged. `labels.ts` shares the existing
   ten-second connection rule with the banner. Two store regressions cover pending reads and signed-out ticks.
2. **Partial scene initialization (F2, P2).** One disposal registry surrounds the entire initializer, including
   observer setup, first update and first resize. Any failure disposes registered resources before rethrowing;
   observer disconnect is registered before observe, and renderer cleanup removes its canvas and loses the
   context even if renderer disposal throws. Cleanup fences callbacks; the existing DOM fallback remains usable.

The old evidence NOTES detail-read and sweep descriptions now match the public awaited router and the current
contract's absence of a detection deadline. Frozen presentation/contracts, hub authority, migrations and live
flags are unchanged. AGENTS.md and CLAUDE.md retain their reviewed matching contents.

## Production regression evidence

`apps/web/e2e/workspace-m1/campus-recovery.suite.ts` takes an absolute production-output directory as its only
argument and serves that output against a disposable real hub. It does not add environment variables. The first
run's resize injection had an unmatched closing expression in the browser test script; it never reached the
product fault. Its original source, failure log and note are retained. The injection was corrected without
weakening product assertions. The second run passed 12 records / 0 failures.

- At 1440×900 and 1280×800, new v1.2 journeys independently type Edward for both explicit decision buttons;
  Enter causes no decision and publishing a proposal causes no execution.
- Task and HQ/history polls are held for roughly 18–19 real seconds, crossing both the ten-second connection
  threshold and the fifteen-second fetch timeout. Ages advance; stale readings stay neutral; the banner says
  Connection stale; no mutation is emitted; durable acceptance receipts are byte-identical. Reconnect recovers.
- A separate controlled **+65-second browser clock** with successful hub polls exercises `old_check` in task/HQ
  and history. This is not a real 65-second delay or a server-clock alteration; receipts remain unchanged.
- Observer, initial-update and initial-resize faults each execute three startup/unmount cycles. Live contexts
  after unmount are `0/0/0`, with zero tracked observers/listeners/frames and a disconnect per cycle. This proves
  explicit release at those boundaries; it is not a general heap-leak or OS-containment proof.
- Zero actual-provider or outside-origin requests. Unexpected console errors are zero; expected initial 401s
  and Chromium's injected-context Activity WebSocket local-network check errors are retained in raw console data.

Second-run results and six screenshots are under
`/private/tmp/agent-city-campus-repair-j4502wc5/tmp/agentcity-m1-09-hub-LOAqK9/`.
The 1440×900 silent task and 1280×800 silent HQ/history screenshots were visually inspected: neutral current
validity warnings and advancing age are readable beside unchanged historical Accepted status; workflow controls
remain accessible. The compact connection text truncates at 1280 px, while the full warning remains in the panel.

## Final coordinated verification

All twelve final batch commands exited 0 on the final product tree. Logs, timings, commands and summary paths
are recorded in `/private/tmp/agent-city-campus-repair-j4502wc5/final-verification.json`.

| Check | Fresh result |
| --- | --- |
| Biome | 311 files, no fixes |
| Typecheck | 5 projects, pass |
| Full tests | 1788 pass / 0 fail, 112 files, 15619 expect calls |
| Adversarial rerun | 203 pass / 0 fail; these cases are already included in the full count |
| Secret scan | 361 files, pass; repeated immediately before commit |
| Isolated production build | legacy, workspace and fixture modes, pass; >500 kB warning retained |
| Managed demo | 8/8 simulated scenarios |
| Legacy browser | 24/24 |
| Real-hub workspace browser | 108 pass / 0 fail / 2 NOT RUN (R-01, J-21) |
| Fixture browser | 30 pass / 0 fail; 24 cases delegated to the real-hub suite |
| Campus browser | 36 pass / 0 fail |
| Production repair browser | 12 pass / 0 fail |

The final batch ran sequentially in cleared environment, disposable HOME, AGENTCITY_HOME and TMPDIR, cached
Chromium and fake providers. Root .env, real data, personal provider configuration and port 4317 were not used.
The isolated production build used installed Vite with configFile:false, empty envDir, temporary cache/output,
React plugin and explicit legacy/workspace/fixture compile flags; it did not load the normal proxy or root env.
Existing workspace/campus/fixture suites used their documented isolated harness; the repair suite served the
actual emitted production output against its disposable real hub. Console and request checks passed; the repair
suite retains the specifically expected 401/local-network errors rather than claiming raw console silence.

All six second-run production screenshots (task, HQ/history and controlled old check at both viewports) were
visually inspected. Final-batch screenshots and summary files are referenced by `final-verification.json`.
After final documentation, `pre-commit.json` records the full source identity and separate DELIVERY.md hash,
while `repair-scope-verification.json` records the initial repair boundary. Unrelated reviewed source bytes
remain unchanged. No product/test source was changed during the coordinated batch; only result records were
finalized afterward. Final lint, secret scan, diff check and source-integrity comparison precede the commit.

The full staged whitespace check reported only pre-existing historical artifacts: unified-diff context lines
in `bridge/orchestrator-repair.patch` and space-before-tab indentation inside fenced examples in persistence
and web NOTES. Their bytes match the reviewed baseline and are preserved. Strict whitespace checks pass for
all other staged files; the two historical Markdown examples also pass with only space-before-tab disabled
for that command. The raw diagnostics and scoped commands are retained in `staged-whitespace-check.json`.
No product assertion, test outcome or repository/global Git configuration was changed to hide this diagnostic.

Git delivery is a normal push of `feat/workspace-approvals-m1` to the verified
`https://github.com/EdwardH-jedi/agent-city.git` URL. The clone's `DISABLED-no-push-from-m1` origin setting is
preserved; no force push, main update, merge or deployment is requested. Commit/remote identity and process
cleanup are recorded in the external repair evidence after delivery.

## Remaining gates

Simulated integration only; `LIVE_INTEGRATION_VERIFIED` remains false. Hosted CI, actual Claude/Codex providers,
OS containment, remote deployment, physical MacBook/screen-reader checks and multi-hub support are NOT RUN.
The existing HUB exclusions R-01 (second repository absent) and J-21 (no CEO model briefing by design) remain
NOT RUN; mapped simulated-check success is not independent semantic proof. The visual port remains partial
fidelity to the supplied reference, as recorded by the independent review. No art-direction redesign was made.
