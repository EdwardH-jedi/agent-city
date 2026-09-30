# Claude Code hook events → normalized kinds

**Status: draft.** Claude Code 2.1.285. "measured" = seen in a real hook payload; "docs" = taken from
the official hooks reference only, not yet confirmed. This file records field **names and types
only** — never a value from a real payload.

Common fields on every event (measured): `session_id` string, `transcript_path` string, `cwd`
string, `hook_event_name` string. Often present: `permission_mode` string, `prompt_id` string
(measured; absent before the first prompt). Inside a subagent (docs): `agent_id` string,
`agent_type` string.

## Events we map

| Event                | Source   | Fields we use                                                              | kind / ok                       | When the field or event is missing                                                        |
| -------------------- | -------- | -------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `SessionStart`       | measured | `source`; `model` (docs: optional — absent in the measured run)            | `session.start`                 | No `model` → taken from a later event. No event → session is created by its first event.  |
| `UserPromptSubmit`   | measured | `prompt` → **length only**                                                 | `turn.start`                    | No `prompt` → length 0.                                                                   |
| `PreToolUse`         | docs     | `tool_name`, `tool_use_id`, `tool_input` (summary only), `agent_id`, `agent_type` | `tool.start`             | No `tool_use_id` → random event id (no dedupe across retries).                            |
| `PostToolUse`        | docs     | `tool_name`, `tool_use_id`, `duration_ms`; `tool_response` is **never stored** | `tool.ok`, ok = 1           | —                                                                                         |
| `PostToolUseFailure` | docs     | `tool_name`, `tool_use_id`, `is_interrupt` bool, `duration_ms`; `error` string → **not stored** (length only) | `tool.fail`, ok = 0 | Event never fires → fallback: a `PostToolUse` whose response carries a failure flag (flag only, to be confirmed by capture). |
| `SubagentStart`      | docs     | `agent_id`, `agent_type`                                                   | `subagent.start`                | Event never fires → fallback: `PreToolUse` of `Task` / `Agent` (today's behaviour).       |
| `SubagentStop`       | docs     | `agent_id`, `agent_type`; `last_assistant_message` and `agent_transcript_path` not stored | `subagent.end`   | Fallback: `PostToolUse` of `Task` / `Agent`. Empty `agent_type` = internal agent → event kept, no agent row. |
| `Notification`       | docs     | `notification_type`, `message` (redacted, clipped)                         | see table below                 | No `notification_type` → `unknown` (the message text is never parsed to guess).           |
| `Stop`               | docs     | —                                                                          | `turn.end`, ok = 1              | —                                                                                         |
| `StopFailure`        | measured | `error` string (an enum-like code, e.g. rate limit / auth); `last_assistant_message` not stored | `turn.end`, ok = 0 | Event never fires → the turn simply has no `turn.end`; a later health signal covers it. |
| `SessionEnd`         | measured | `reason`                                                                   | `session.end`                   | Never fires (crash, kill) → session goes `stale` after 15 min, as today.                  |
| anything else        | —        | `hook_event_name` kept as `raw_type`                                       | `unknown`                       | —                                                                                         |

`ok` says only "this tool call / turn ended without an error". It is not a quality judgement:
`Stop` and `SessionEnd` do not mean the work passed anything.

### Notification types (docs)

| `notification_type`                                                     | kind              |
| ----------------------------------------------------------------------- | ----------------- |
| `permission_prompt`                                                     | `wait.permission` |
| `idle_prompt`, `agent_needs_input`, `elicitation_dialog`, `elicitation_url_dialog` | `wait.input` |
| `auth_success`, `elicitation_complete`, `elicitation_response`, `agent_completed`, `quota_auto_resume_*` | `unknown` |

`permission_prompt` fires only after the prompt has waited about 6 s; `idle_prompt` about 60 s after
Claude finished. Both are therefore late by design.

## Normalized kinds

`session.start`, `session.end`, `turn.start`, `turn.end`, `tool.start`, `tool.ok`, `tool.fail`,
`subagent.start`, `subagent.end`, `wait.permission`, `wait.input`, `unknown`.

The provider's own name is kept next to it: for Claude the existing `type` column already holds the
hook name (`PreToolUse`, …) and stays unchanged for the 2D view; `raw_type` preserves the original
where the collector rewrites it (Codex records mapped onto Claude names).

## Hook configuration facts

- `timeout` is **not enforced** on `async: true` hooks (docs). Our installed `timeout: 2` is
  therefore inert; the real bound is the launcher's SIGKILL at `AGENTCITY_HOOK_KILL_S` (0.6 s).
- In `claude -p`, an async hook still running at teardown is killed. Spool-first keeps the event.
- `SubagentStop` also fires for Claude Code's internal agents, with an empty `agent_type`.
- A `WorktreeCreate` hook **replaces** `git worktree` creation and must print a path. Never install
  an observation hook on it.

## Events we do not install

`PermissionRequest` (no `tool_use_id`; `Notification` already covers the wait), `PostToolBatch`,
`PermissionDenied`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`, `PreCompact`, `PostCompact`,
`PreModelSwitch`, `PostModelSwitch`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `ConfigChange`,
`InstructionsLoaded`, `UserPromptExpansion`, `Setup`, `Elicitation`, `ElicitationResult`,
`WorktreeCreate`, `WorktreeRemove`, `MessageDisplay`. Revisit after the capture.

## To confirm by capture

1. `Notification`: which field separates permission wait from input wait, and its type.
2. `PostToolUseFailure`: the error field name and type; whether `is_interrupt` is present.
3. `SubagentStart` / `SubagentStop`: the agent identity fields, and whether a `Task` / `Agent`
   `PostToolUse` carries anything that links its `tool_use_id` to that `agent_id`.
4. Whether tool events fired inside a subagent carry `agent_id` / `agent_type`.
