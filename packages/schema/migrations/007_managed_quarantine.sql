-- 007_managed_quarantine: child processes whose termination could not be confirmed (v0.1.1 P1.1).
-- An open row (released_at IS NULL) blocks: claiming any managed task (single-worker policy),
-- running its task again, and turning a cancel request into `cancelled`. A row is released only on
-- objective evidence — the recorded process and its process group are gone, or they were
-- terminated by Agent City — never by a person dismissing it. Additive only.

CREATE TABLE managed_quarantine (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES managed_tasks(id) ON DELETE CASCADE,
  run_id            TEXT,
  pid               INTEGER NOT NULL,
  started           TEXT,                        -- recorded process start time (pid-reuse guard)
  reason            TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  last_checked_at   TEXT,
  last_check        TEXT,                        -- outcome of the latest inspection
  released_at       TEXT,
  release_evidence  TEXT
);

CREATE INDEX idx_managed_quarantine_open ON managed_quarantine(released_at, task_id);
