-- 006_managed_runs: managed tasks (explicit, authorized task attempts) — separate from the observed
-- `sessions` telemetry. Additive only. States/kinds are validated in packages/schema/src/managed.ts
-- and managed-status.ts; JSON columns hold validated, redacted values.
--
-- Fencing: every write by a worker is `... WHERE id = ? AND fence_token = ?`. A worker that lost its
-- lease (the token moved on) cannot write late.

CREATE TABLE managed_tasks (
  id                   TEXT PRIMARY KEY,
  contract_version     TEXT NOT NULL,
  idempotency_key      TEXT NOT NULL UNIQUE,
  request_hash         TEXT NOT NULL,             -- sha256 of the canonical submission
  repo_id              TEXT NOT NULL,             -- key of an allowed repo in the managed config
  title                TEXT NOT NULL,
  objective            TEXT NOT NULL,             -- user-authored, redacted
  acceptance_criteria  TEXT NOT NULL,             -- JSON string[]
  approved_scope       TEXT NOT NULL,             -- JSON string[] (relative path prefixes)
  execution_mode       TEXT NOT NULL CHECK (execution_mode IN ('simulated', 'live')),
  simulation_scenario  TEXT,
  repair_limit         INTEGER NOT NULL CHECK (repair_limit BETWEEN 0 AND 3),
  base_ref             TEXT NOT NULL,
  base_sha             TEXT NOT NULL,
  state                TEXT NOT NULL CHECK (state IN (
                         'draft', 'queued', 'executing', 'verifying', 'reviewing', 'repairing',
                         'human_ready', 'failed', 'blocked', 'cancelled', 'interrupted')),
  failure_kind         TEXT,
  state_detail         TEXT,
  approval_hash        TEXT,
  run_requested_at     TEXT,
  cancel_requested_at  TEXT,
  lease_owner          TEXT,
  lease_until          TEXT,
  fence_token          INTEGER NOT NULL DEFAULT 0,
  infra_retries        INTEGER NOT NULL DEFAULT 0,
  current_run_id       TEXT,
  result_run_id        TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  rev                  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE managed_runs (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES managed_tasks(id) ON DELETE CASCADE,
  attempt_no       INTEGER NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('initial', 'repair', 'rerun')),
  parent_run_id    TEXT,
  state            TEXT NOT NULL CHECK (state IN ('running', 'finished', 'failed', 'cancelled', 'unknown')),
  phase            TEXT NOT NULL CHECK (phase IN ('implement', 'verify', 'review', 'done')),
  outcome          TEXT CHECK (outcome IN ('approved', 'rejected')),
  repair_input     TEXT,                          -- JSON Finding[] this repair was asked to fix
  workspace_path   TEXT,
  branch           TEXT,
  base_sha         TEXT NOT NULL,
  parent_sha       TEXT,                          -- commit the attempt started from
  candidate_sha    TEXT,
  manifest_hash    TEXT,
  provider         TEXT NOT NULL,
  mode             TEXT NOT NULL CHECK (mode IN ('simulated', 'live')),
  model_requested  TEXT,
  model_resolved   TEXT,                          -- NULL = unknown (never guessed)
  session_ref      TEXT,
  usage            TEXT,                          -- JSON as reported by the provider, or NULL
  proc_phase       TEXT,                          -- launch intent, written BEFORE a child is spawned
  proc_started_at  TEXT,
  child_pid        INTEGER,
  child_started    TEXT,                          -- process start time, guards against pid reuse
  failure_kind     TEXT,
  failure_detail   TEXT,
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  UNIQUE (task_id, attempt_no)
);

CREATE TABLE managed_artifacts (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES managed_tasks(id) ON DELETE CASCADE,
  run_id         TEXT NOT NULL REFERENCES managed_runs(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  name           TEXT NOT NULL,
  rel_path       TEXT NOT NULL,                   -- relative to the artifacts root
  sha256         TEXT NOT NULL,
  byte_len       INTEGER NOT NULL,
  truncated      INTEGER NOT NULL DEFAULT 0,
  candidate_sha  TEXT,
  meta           TEXT NOT NULL DEFAULT '{}',      -- JSON (verification: argv, exit_code, completed…)
  created_at     TEXT NOT NULL,
  UNIQUE (run_id, name)
);

CREATE TABLE managed_reviews (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT NOT NULL REFERENCES managed_tasks(id) ON DELETE CASCADE,
  run_id              TEXT NOT NULL REFERENCES managed_runs(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL,
  mode                TEXT NOT NULL CHECK (mode IN ('simulated', 'live')),
  model_requested     TEXT,
  model_resolved      TEXT,
  session_ref         TEXT,
  candidate_sha       TEXT NOT NULL,              -- what Agent City asked the reviewer to audit
  manifest_hash       TEXT NOT NULL,
  verdict             TEXT CHECK (verdict IN ('approve', 'reject')),
  valid               INTEGER NOT NULL,           -- 1 only if schema + candidate binding held
  invalidated_reason  TEXT,
  findings            TEXT NOT NULL DEFAULT '[]', -- JSON Finding[]
  summary             TEXT,
  usage               TEXT,
  created_at          TEXT NOT NULL
);

CREATE INDEX idx_managed_tasks_state   ON managed_tasks(state, created_at);
CREATE INDEX idx_managed_runs_task     ON managed_runs(task_id, attempt_no);
CREATE INDEX idx_managed_artifacts_run ON managed_artifacts(run_id);
CREATE INDEX idx_managed_reviews_run   ON managed_reviews(run_id);
