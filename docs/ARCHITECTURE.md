# Agent City — architecture decisions

Agreed direction after Phase 0. Each entry is the decision, why, and the phase it applies to.
Phase 0 rules (AGENTS.md hard rules, id scheme, redaction, spool-first hooks) stay in force unless an
entry says otherwise. Hook payload details live in [hook-events.md](./hook-events.md).

Phases: **0** data layer (done) · **1a** monitor reliability · **1b** deploy, result screens,
GitHub issue/PR/CI links · **2** single Runner · **3** external Relay · **4** 3D city.

## 1. Topology

- **Decision:** Collectors (every machine) → hub on `spine`, bound to localhost and published to the
  tailnet with `tailscale serve` → desktop and phone screens. The Runner *pulls* work from the hub.
  The Relay sits outside and can only propose work and read results the hub marked public.
- **Why:** one always-on writer for SQLite; nothing listens on a LAN or public interface; every
  component that can execute or is exposed talks to the hub, never to the DB or to each other.
- **Phase:** hub on spine + tailscale serve in 1b (needs the Host allowlist and auth on `/api` and
  `/ws` first — hard rule 5); Runner in 2; Relay in 3.

## 2. Order of work

- **Decision:** monitor reliability → deploy + result screens + GitHub issue/PR/CI links → single
  Runner (approval, recovery, isolation) → external Relay → 3D.
- **Why:** nothing may act on a signal that is not yet trustworthy, and the Runner must be safe alone
  before anything outside can reach it. 3D is presentation and blocks nothing.
- **Phase:** 1a → 1b → 2 → 3 → 4.

## 3. Run: execution state vs health signals

- **Decision:** a Run has one execution state `{running, finished, failed, cancelled, unknown}` and,
  separately, zero or more health signals in `run_signals`: `waiting`, `stalled`, `failing`, `looping`.
- **Why:** "is the process alive" and "is it getting anywhere" are different questions; one status
  column cannot hold both. `Stop` and `SessionEnd` mean the agent stopped — not that the work passed
  any quality bar.
- **Phase:** 1a (the normalized event `kind` is the input; Run state and signals are the next step).

## 4. Job

- **Decision:** a Job records `goal`, `acceptance`, `base_sha`, `head_sha` and its issue / PR links.
- **Why:** a result can only be judged against a stated goal and an exact commit range.
- **Phase:** 2. The links are read-only references; hard rule 1 (GitHub read-only) is unchanged, and
  any GitHub write by a Runner needs its own decision.

## 5. Approval binding

- **Decision:** an approval is bound to `prompt_hash + input_commit_sha + context_hash +
  policy_version` and re-verified immediately before execution; any mismatch voids it.
- **Why:** approving "this prompt on this commit under this policy" must not authorize something
  that changed afterwards.
- **Phase:** 2.

## 6. Runner recovery

- **Decision:** `stage_attempts`, a lease with heartbeat, and a fencing token per attempt. Cancel is
  `cancel_requested` → termination confirmed → `cancelled`. After a disconnect, an `implement` stage
  is never re-run automatically.
- **Why:** a Runner that lost its lease must not be able to write late; re-running a stage that
  mutates a repo without a human looking is how work gets duplicated or clobbered.
- **Phase:** 2.

## 7. Runner isolation

- **Decision:** Phase 2 minimum = dedicated OS user + dedicated clone (not a worktree of the user's
  checkout) + no credentials (no SSH agent, no credential helper, no `gh` login) + resource limits.
  Network restriction comes late in Phase 2.
- **Why:** the Runner executes model-written commands; it must not reach the user's files, keys or
  GitHub identity even when it misbehaves.
- **Phase:** 2 (network limits: late 2).

## 8. Verdict

- **Decision:** a verdict is `{verdict, audited_sha, findings, checks, blockers}`.
  `ready_to_merge` = required checks pass + `HEAD == audited_sha` + no blockers + PR/CI confirmed.
  Environment errors, quota and expired logins are their own blocker kinds.
- **Why:** an audit is only valid for the commit it read; "the tool could not run" must never be
  recorded as "the code is bad" or "the code is fine".
- **Phase:** 1b (shape, result screen) → 2 (enforced by the Runner).

## 9. Relay

- **Decision:** two separate APIs — propose, and read results allowed to be public. The hub decides
  what is public. The app's confirmation dialog is not a security boundary. A consultation is always
  started by a person.
- **Why:** the Relay is the only internet-facing part, so it holds no authority: it cannot approve,
  execute, or choose what it may read.
- **Phase:** 3.

## 10. `client` district

- **Decision:** monitoring only. No Runner, no Relay, no prompt-derived titles.
- **Why:** client repos carry someone else's confidentiality; nothing derived from their prompts
  leaves the machine and nothing automated acts on them.
- **Phase:** all.

## 11. D1–D11 conclusions

| #   | Topic                     | Conclusion                                                       |
| --- | ------------------------- | ---------------------------------------------------------------- |
| D1  | Where the Runner runs     | `spine` by default                                               |
| D2  | Outside access            | Start with Tailscale Funnel                                      |
| D3  | Relay ↔ data              | The Relay never touches the DB directly — hub API only           |
| D4  | Artifacts                 | Files on disk + rows in the DB                                   |
| D5  | Prompt construction       | Template + free-text slots                                       |
| D6  | Loopback access           | Conditional                                                      |
| D7  | Phone notifications       | PWA Web Push                                                     |
| D8  | Task naming               | Manual task name first; prompt-derived title off by default      |
| D9  | Signal thresholds         | Global thresholds + per-task-type exceptions                     |
| D10 | Moving to L2              | Gated on reliability metrics, not on a date                      |
| D11 | Concurrency               | One Stage at a time + a write lock per repo                      |
